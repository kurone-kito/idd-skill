#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-local-admission.mts
//
// The scripts/idd-local-admission.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// Host-local admission for one validation command per OS user (#4428, under
// roadmap #4426). The command after `--` is the child argv: this helper never
// parses a shell string. Policy comes from `localExec.admission`, read through
// the repository-policy normalizer.

import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  statSync,
} from 'node:fs';
import { constants as osConstants, homedir as userHomedir } from 'node:os';
import { delimiter, dirname, join, posix, resolve, win32 } from 'node:path';
import type { Readable } from 'node:stream';
import { parseCliArgs } from './cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  DEFAULT_POLICY_CONFIG_PATH,
  readRepositoryPolicyFile,
} from './idd-config.mts';
import {
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
} from './policy-helpers.mts';

/** Set in the environment of an admitted command; a nested call then skips the lock. */
export const LOCAL_ADMISSION_ENV_VAR = 'IDD_LOCAL_ADMISSION';

/** Exit status when the wait reaches `maxWait` and the command never started. */
const EXPIRED_EXIT_CODE = 75;
/** Refusal before the command starts: policy, cap, symlink, open, or flock failure. */
const REFUSED_EXIT_CODE = 2;
/** A command that could not be started: 127 when not found, else 126 (the shell convention). */
const SPAWN_FAILURE_NOT_FOUND_EXIT_CODE = 127;
const SPAWN_FAILURE_OTHER_EXIT_CODE = 126;
const DEFAULT_WAIT_NOTICE_INTERVAL_MS = 60_000;
const GROUP_POLL_INTERVAL_MS = 1000;
const PROCESS_STATE_PROBE_TIMEOUT_MS = 1000;
const PROCESS_STATE_PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const FALLBACK_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const LOCK_PARENT_DIRECTORY = 'idd-skill';
const LOCK_DIRECTORY = 'local-admission';
const LOCK_FILE_NAME = 'validate.lock';
/** Descriptor the flock child reads the lock through, as `/dev/fd/3`. */
const LOCK_FD = 3;
/** Descriptor the wrapper reports `acquired` on, through a dedicated pipe. */
const ACQUIRED_FD = 4;
const ACQUIRED_LINE = 'acquired\n';
/** Runs before the child: report the lock, close the pipe, then exec the argv. */
const ACQUIRED_WRAPPER = 'printf "acquired\\n" >&4; exec 4>&-; exec "$@"';

/**
 * Flags for the lock descriptor: read-only, so the helper never writes or
 * truncates the file; `O_CREAT` only when absent; `O_NOFOLLOW` refuses a
 * symlink at the final component. `flock(1)` locks through a read-only
 * descriptor, so the lock needs no write access.
 */
export const LOCK_OPEN_FLAGS =
  fsConstants.O_RDONLY |
  fsConstants.O_CREAT |
  fsConstants.O_NONBLOCK |
  (fsConstants.O_NOFOLLOW || 0);

const LOCAL_ADMISSION_FLAG_SPEC = {
  '--help': { type: 'boolean', short: 'h' },
} as const;

const HELP_TEXT = `Usage:
  node scripts/idd-local-admission.mjs [--help] -- <command> [args...]

Run the command after \`--\` in the caller's working directory, under the
host-local validation slot (#4428). Policy: \`localExec.admission\` in the
repository's .github/idd/config.json.

Exit status: the command's own status; 2 when the command was refused before
it started (policy, cap, symlink, or lock failure); 75 with
\`local-admission: expired\` when the wait reached maxWait.
`;

/** Injection points for the flow. Production wiring is {@link defaultDependencies}. */
export interface LocalAdmissionDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  homedir: string;
  stderr: (text: string) => void;
  /** Reads a repository policy file by absolute path; throws when it is malformed. */
  readPolicy: (policyPath: string) => unknown;
  /** Absolute path of `flock` on this host, or null when it is not installed. */
  findFlock: (env: NodeJS.ProcessEnv) => string | null;
  /** Absolute path of the ps utility, or null when it is not installed. */
  findPs: (env: NodeJS.ProcessEnv) => string | null;
  spawn: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  /** Interval of the `local-admission: waiting` notice (issue #4428: default 60000). */
  waitNoticeIntervalMs: number;
}

function defaultDependencies(): LocalAdmissionDeps {
  return {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    homedir: userHomedir(),
    stderr: (text) => {
      process.stderr.write(text);
    },
    readPolicy: (policyPath) => readRepositoryPolicyFile(policyPath).config,
    findFlock: (env) => findExecutableOnPath('flock', env),
    findPs: (env) => findExecutableOnPath('ps', env),
    spawn: (command, args, options) => spawn(command, args, options),
    waitNoticeIntervalMs: DEFAULT_WAIT_NOTICE_INTERVAL_MS,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Exit status for a child that ended by signal: 128 plus the signal number. */
function signalStatus(signal: NodeJS.Signals | null): number {
  if (signal === null) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}

function describeExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  return signal === null ? `exit ${code}` : `signal ${signal}`;
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed: the child keeps its own copy of the descriptor.
  }
}

/**
 * Per-user state base, resolved like `defaultLoadControlDirectory`: an
 * absolute `XDG_STATE_HOME` (else `~/.local/state`), or on Windows an absolute
 * `LOCALAPPDATA` (else `~/AppData/Local`). A relative value is ignored. The
 * lock lives beside `github-api-load-control`, not inside it.
 */
export function resolveStateBase(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string,
): string {
  const pathModule = platform === 'win32' ? win32 : posix;
  const absolute = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return pathModule.isAbsolute(trimmed) ? trimmed : undefined;
  };
  if (platform === 'win32') {
    return (
      absolute(env.LOCALAPPDATA) ?? pathModule.join(home, 'AppData', 'Local')
    );
  }
  return (
    absolute(env.XDG_STATE_HOME) ?? pathModule.join(home, '.local', 'state')
  );
}

/** Nearest ancestor of `startDir` holding a `.git` entry (a file or a directory). */
export function findRepositoryRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The raw `localExec.admission.maxConcurrent`, or undefined when absent. */
function storedMaxConcurrent(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.localExec)) return undefined;
  const admission = raw.localExec.admission;
  return isRecord(admission) ? admission.maxConcurrent : undefined;
}

/**
 * D1 (issue #4428, decision A): the raw stored cap decides the exit-2 rule.
 * A number above 1, or a non-blank string that `Number()` reads above 1,
 * counts. The normalizer would silently clamp 9 to 1, so it is not used here.
 */
export function storedCapAboveOne(raw: unknown): boolean {
  if (typeof raw === 'number') return raw > 1;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw) > 1;
  return false;
}

/**
 * The repository's policy object, or null for the defaults. Only the file at
 * the repository root is read, never the layered config, and the loader is
 * not called when the file is absent or there is no `.git` ancestor.
 */
function loadRawPolicy(deps: LocalAdmissionDeps): unknown {
  const root = findRepositoryRoot(deps.cwd);
  if (root === null) return null;
  const policyPath = join(root, DEFAULT_POLICY_CONFIG_PATH);
  if (!existsSync(policyPath)) return null;
  return deps.readPolicy(policyPath);
}

/**
 * Arguments for the `flock` spawn. The lock is `/dev/fd/3`, not a path, and no
 * `--` precedes it: `flock` stops option parsing at the first non-option.
 */
export function buildFlockArguments(
  command: readonly string[],
  maxWaitMs: number,
): string[] {
  const timeoutSeconds = Math.max(1, Math.ceil(maxWaitMs / 1000));
  return [
    '--timeout',
    String(timeoutSeconds),
    '--conflict-exit-code',
    String(EXPIRED_EXIT_CODE),
    `/dev/fd/${LOCK_FD}`,
    'sh',
    '-c',
    ACQUIRED_WRAPPER,
    'sh',
    ...command,
  ];
}

function makeDirectoryIfAbsent(dir: string): void {
  try {
    mkdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Create and open the lock. Both directories are `lstat`ed before any
 * creation and again after it, so a symlink in `idd-skill` or
 * `local-admission` refuses without creating anything. The lock path is
 * opened with `O_NOFOLLOW`, and a non-regular file is refused. The helper
 * never writes, truncates, or removes it.
 */
function openLockFile(
  deps: LocalAdmissionDeps,
): { fd: number } | { refusal: string } {
  const base = resolveStateBase(deps.env, deps.platform, deps.homedir);
  const parentDir = join(base, LOCK_PARENT_DIRECTORY);
  const lockDir = join(parentDir, LOCK_DIRECTORY);
  const lockPath = join(lockDir, LOCK_FILE_NAME);
  const directories = [parentDir, lockDir];
  try {
    for (const dir of directories) {
      const info = lstatSync(dir, { throwIfNoEntry: false });
      if (info !== undefined && !info.isDirectory()) {
        return {
          refusal: `${dir} is a symbolic link or not a directory`,
        };
      }
    }
    mkdirSync(base, { recursive: true });
    for (const dir of directories) makeDirectoryIfAbsent(dir);
    for (const dir of directories) {
      if (!lstatSync(dir).isDirectory()) {
        return {
          refusal: `${dir} is a symbolic link or not a directory`,
        };
      }
    }
  } catch (error) {
    return { refusal: `cannot create ${lockDir}: ${errorMessage(error)}` };
  }
  try {
    const fd = openSync(lockPath, LOCK_OPEN_FLAGS, 0o666);
    if (!fstatSync(fd).isFile()) {
      closeQuietly(fd);
      return { refusal: `${lockPath} is not a regular file` };
    }
    return { fd };
  } catch (error) {
    return { refusal: `cannot open ${lockPath}: ${errorMessage(error)}` };
  }
}

/** Resolves when the group is absent or contains only zombie/dead members. */
function waitForGroupToEnd(
  pgid: number,
  processStateTool: string | null,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolveWait) => {
    const poll = (): void => {
      if (!processGroupHasLiveMember(pgid, processStateTool, env)) {
        resolveWait();
        return;
      }
      setTimeout(poll, GROUP_POLL_INTERVAL_MS);
    };
    poll();
  });
}

/**
 * Returns true for a live member, false for an absent or Z/X-only group,
 * and null when output is malformed or empty.
 */
export function parseProcessGroupStateOutput(
  output: string,
  pgid: number,
): boolean | null {
  const rows = output.split(/\r?\n/);
  if (rows.at(-1) === '') rows.pop();
  if (rows.length === 0) return null;
  for (const row of rows) {
    if (row.trim().length === 0) return null;
    const fields = row.trim().split(/\s+/);
    const processGroup = fields[0];
    const state = fields[1];
    if (
      fields.length !== 2 ||
      processGroup === undefined ||
      !/^\d+$/.test(processGroup) ||
      state === undefined ||
      !/^[A-Za-z?]/.test(state)
    ) {
      return null;
    }
    if (processGroup === String(pgid) && !/^[ZzXx]/.test(state)) {
      return true;
    }
  }
  return false;
}

function processGroupHasLiveMember(
  pgid: number,
  processStateTool: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const output = readProcessStateOutput(processStateTool, env);
  return (
    output === null || parseProcessGroupStateOutput(output, pgid) !== false
  );
}

function readProcessStateOutput(
  processStateTool: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (processStateTool === null) return null;
  try {
    const result = spawnSync(processStateTool, ['-A', '-o', 'pgid=,stat='], {
      encoding: 'utf8',
      env,
      maxBuffer: PROCESS_STATE_PROBE_MAX_BUFFER_BYTES,
      timeout: PROCESS_STATE_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (
      result.error !== undefined ||
      result.status !== 0 ||
      typeof result.stdout !== 'string'
    ) {
      return null;
    }
    return result.stdout;
  } catch {
    return null;
  }
}

function processStateToolIsUsable(
  processStateTool: string | null,
  env: NodeJS.ProcessEnv,
): boolean {
  const output = readProcessStateOutput(processStateTool, env);
  return output !== null && parseProcessGroupStateOutput(output, -1) !== null;
}

interface SuperviseOptions {
  /** Signal the whole process group (the locked path) instead of the child only. */
  group: boolean;
  processStateTool?: string | null;
  onBeforeSettle?: () => void;
  /** The child's own outcome, used when no signal was forwarded. */
  onClose: (code: number | null, signal: NodeJS.Signals | null) => number;
  onSpawnError: (error: NodeJS.ErrnoException) => number;
}

/**
 * Forward SIGINT and SIGTERM to the child, and settle one promise with the
 * exit status. A forwarded signal ends with 128 plus its number, after the
 * group is gone. A failed group signal settles 2 at once, without waiting.
 */
function superviseChild(
  child: ChildProcess,
  deps: LocalAdmissionDeps,
  options: SuperviseOptions,
): Promise<number> {
  return new Promise<number>((resolveOutcome) => {
    let forwarded: NodeJS.Signals | null = null;
    let closed = false;
    let settled = false;
    const handlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [];
    const settle = (status: number): void => {
      if (settled) return;
      settled = true;
      for (const { signal, handler } of handlers) process.off(signal, handler);
      options.onBeforeSettle?.();
      resolveOutcome(status);
    };
    const forward = (signal: NodeJS.Signals): void => {
      if (settled || closed) return;
      forwarded ??= signal;
      if (!options.group) {
        child.kill(signal);
        return;
      }
      const pgid = child.pid;
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, signal);
      } catch (error) {
        deps.stderr(
          `local-admission: could not signal the admitted command (process group ${pgid}): ${errorMessage(error)}; the lock stays held until the command exits\n`,
        );
        settle(REFUSED_EXIT_CODE);
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler = (): void => forward(signal);
      handlers.push({ signal, handler });
      process.on(signal, handler);
    }
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled || closed) return;
      settle(options.onSpawnError(error));
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      closed = true;
      if (forwarded !== null) {
        const status = signalStatus(forwarded);
        const pgid = child.pid;
        if (options.group && pgid !== undefined) {
          void waitForGroupToEnd(
            pgid,
            options.processStateTool ?? null,
            deps.env,
          ).then(() => settle(status));
        } else {
          settle(status);
        }
        return;
      }
      settle(options.onClose(code, signal));
    });
  });
}

/** Run the command with no admission: the child inherits stdio and gets the signals. */
function runDirect(
  command: readonly string[],
  deps: LocalAdmissionDeps,
): Promise<number> {
  const [program, ...args] = command;
  let child: ChildProcess;
  try {
    child = deps.spawn(program, args, {
      stdio: 'inherit',
      env: deps.env,
      cwd: deps.cwd,
    });
  } catch (error) {
    deps.stderr(
      `local-admission: cannot start ${program}: ${errorMessage(error)}\n`,
    );
    return Promise.resolve(SPAWN_FAILURE_OTHER_EXIT_CODE);
  }
  return superviseChild(child, deps, {
    group: false,
    onClose: (code, signal) => code ?? signalStatus(signal),
    onSpawnError: (error) => {
      deps.stderr(
        `local-admission: cannot start ${program}: ${error.message}\n`,
      );
      return error.code === 'ENOENT'
        ? SPAWN_FAILURE_NOT_FOUND_EXIT_CODE
        : SPAWN_FAILURE_OTHER_EXIT_CODE;
    },
  });
}

/**
 * Run the command under `flock(1)`. The `acquired` line on the dedicated pipe
 * tells a lock expiry (exit 75 without it) from the command's own status
 * (including 75 after it). The notice repeats until the lock is acquired.
 */
function runLocked(
  command: readonly string[],
  flockPath: string,
  processStateTool: string,
  lockFd: number,
  maxWaitMs: number,
  deps: LocalAdmissionDeps,
): Promise<number> {
  let child: ChildProcess;
  try {
    child = deps.spawn(flockPath, buildFlockArguments(command, maxWaitMs), {
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit', lockFd, 'pipe'],
      env: { ...deps.env, [LOCAL_ADMISSION_ENV_VAR]: '1' },
      cwd: deps.cwd,
    });
  } catch (error) {
    closeQuietly(lockFd);
    deps.stderr(
      `local-admission: cannot start flock: ${errorMessage(error)}; command not started\n`,
    );
    return Promise.resolve(REFUSED_EXIT_CODE);
  }
  closeQuietly(lockFd);
  let acquired = false;
  let ackText = '';
  const notice = setInterval(() => {
    if (!acquired) {
      deps.stderr('local-admission: waiting for the validation slot\n');
    }
  }, deps.waitNoticeIntervalMs);
  const ack = child.stdio[ACQUIRED_FD] as Readable | null | undefined;
  ack?.setEncoding('utf8');
  ack?.on('data', (chunk: string) => {
    ackText += chunk;
    if (!acquired && ackText.includes(ACQUIRED_LINE)) {
      acquired = true;
      clearInterval(notice);
    }
  });
  ack?.on('error', () => {
    // The pipe only carries the acknowledgement; its errors do not change the outcome.
  });
  return superviseChild(child, deps, {
    group: true,
    processStateTool,
    onBeforeSettle: () => clearInterval(notice),
    onClose: (code, signal) => {
      if (acquired) return code ?? signalStatus(signal);
      if (code === EXPIRED_EXIT_CODE) {
        deps.stderr(
          `local-admission: expired (waited ${maxWaitMs} ms); command not started\n`,
        );
        return EXPIRED_EXIT_CODE;
      }
      deps.stderr(
        `local-admission: flock stopped (${describeExit(code, signal)}) before acquiring the lock; command not started\n`,
      );
      return REFUSED_EXIT_CODE;
    },
    onSpawnError: (error) => {
      deps.stderr(
        `local-admission: cannot start flock: ${error.message}; command not started\n`,
      );
      return REFUSED_EXIT_CODE;
    },
  });
}

/** `PATH` lookup for an executable file named `name`. */
export function findExecutableOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      }
    } catch {
      // Not in this directory; keep searching PATH.
    }
  }
  return null;
}

function parseLocalAdmissionArgs(argv: readonly string[]): {
  help: boolean;
  command: string[];
} {
  const index = argv.indexOf('--');
  const flags = index === -1 ? [...argv] : argv.slice(0, index);
  const command = index === -1 ? [] : argv.slice(index + 1);
  const { help } = parseCliArgs(flags, LOCAL_ADMISSION_FLAG_SPEC);
  return { help, command };
}

/**
 * The admission flow. Usage errors throw; every refusal prints one line and
 * returns 2 without starting the command. Injected dependencies are optional.
 */
export async function runLocalAdmission(
  argv: readonly string[],
  overrides: Partial<LocalAdmissionDeps> = {},
): Promise<number> {
  const deps: LocalAdmissionDeps = { ...defaultDependencies(), ...overrides };
  const { help, command } = parseLocalAdmissionArgs(argv);
  if (help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }
  if (command.length === 0) {
    throw markCliUsageError(new Error('a command is required after `--`'));
  }
  if (deps.env[LOCAL_ADMISSION_ENV_VAR] !== undefined) {
    return runDirect(command, deps);
  }
  let raw: unknown;
  try {
    raw = loadRawPolicy(deps);
  } catch (error) {
    deps.stderr(
      `local-admission: ${errorMessage(error)}; command not started\n`,
    );
    return REFUSED_EXIT_CODE;
  }
  const admission = normalizePolicyConfig(raw).localExec.admission;
  if (!admission.enabled) {
    return runDirect(command, deps);
  }
  if (admission.backend === 'pueue') {
    deps.stderr(
      'local-admission: backend "pueue" is not implemented yet; this run takes the flock path with one slot\n',
    );
  }
  const flockPath = deps.platform === 'win32' ? null : deps.findFlock(deps.env);
  if (flockPath === null) {
    deps.stderr(
      'local-admission: flock is not available on this host; running the command without admission\n',
    );
    return runDirect(command, deps);
  }
  if (
    admission.backend === 'flock' &&
    storedCapAboveOne(storedMaxConcurrent(raw))
  ) {
    deps.stderr(
      `local-admission: the flock backend admits one command at a time, but localExec.admission.maxConcurrent is ${String(storedMaxConcurrent(raw))}; command not started\n`,
    );
    return REFUSED_EXIT_CODE;
  }
  const processStateTool = deps.findPs(deps.env);
  if (
    processStateTool === null ||
    !processStateToolIsUsable(processStateTool, deps.env)
  ) {
    deps.stderr(
      'local-admission: ps is not available or returned unusable process-state output; command not started\n',
    );
    return REFUSED_EXIT_CODE;
  }
  const maxWaitMs =
    parseIsoDurationToMs(admission.maxWait) ??
    parseIsoDurationToMs(POLICY_DEFAULTS.localExec.admission.maxWait) ??
    FALLBACK_MAX_WAIT_MS;
  const opened = openLockFile(deps);
  if ('refusal' in opened) {
    deps.stderr(`local-admission: ${opened.refusal}; command not started\n`);
    return REFUSED_EXIT_CODE;
  }
  return runLocked(
    command,
    flockPath,
    processStateTool,
    opened.fd,
    maxWaitMs,
    deps,
  );
}

/** The CLI body: reads the process arguments and returns the exit status. */
export function runLocalAdmissionCli(): Promise<HelperCliResult> {
  return runLocalAdmission(process.argv.slice(2));
}

/**
 * Shared entry point: the `import.meta.main` guard below and the
 * `src/bin/idd-local-admission.mts` wrapper both call this, so the bin runs
 * the module in this process and a signal reaches the admitted child.
 */
export function runLocalAdmissionEntry(): void {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-local-admission', runLocalAdmissionCli);
  } else {
    runLocalAdmissionCli().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}

if (import.meta.main) {
  runLocalAdmissionEntry();
}
