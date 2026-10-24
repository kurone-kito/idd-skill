#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-local-admission.mts
//
// The scripts/idd-local-admission.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
// Host-local admission for one validation command per OS user (#4428, under
// roadmap #4426). The command after `--` is the child argv: this helper never
// parses a shell string. Policy comes from `localExec.admission`, read through
// the repository-policy normalizer.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import {
  DEFAULT_POLICY_CONFIG_PATH,
  readRepositoryPolicyFile,
} from './idd-config.mjs';
import {
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
/** Set in the environment of an admitted command; a nested call then skips the lock. */
export const LOCAL_ADMISSION_ENV_VAR = 'IDD_LOCAL_ADMISSION';
/** Exit status when the wait reaches `maxWait` and the command never started. */
const EXPIRED_EXIT_CODE = 75;
/** Refusal before the command starts: policy, cap, symlink, open, or flock failure. */
const REFUSED_EXIT_CODE = 2;
/** The submitted pueue task may have run, but its final outcome is unknown. */
const PUEUE_OUTCOME_UNKNOWN_EXIT_CODE = 3;
/** A command that could not be started: 127 when not found, else 126 (the shell convention). */
const SPAWN_FAILURE_NOT_FOUND_EXIT_CODE = 127;
const SPAWN_FAILURE_OTHER_EXIT_CODE = 126;
const DEFAULT_WAIT_NOTICE_INTERVAL_MS = 60_000;
const GROUP_POLL_INTERVAL_MS = 1000;
const DEFAULT_PUEUE_CLIENT_TIMEOUT_MS = 10_000;
const PUEUE_POLL_INTERVAL_MS = 1000;
const PUEUE_LOCAL_FOLLOW_INCOMPLETE_OUTPUT =
  /(?:Failed to get log file handles:|Pueue: Log file has gone away\.|Pueue: Error while reading file:|Pueue: Error while flushing stdout:)/;
const PUEUE_LOG_ERROR_PREFIXES = [
  '(Pueue error) Failed to get log file handle:',
  '(Pueue error) Failed to read local log output file:',
  '(Pueue error) Failed to decompress remote log output:',
];
const PROCESS_STATE_PROBE_TIMEOUT_MS = 1000;
const PROCESS_STATE_PROBE_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const FALLBACK_MAX_WAIT_MS = 2 * 60 * 60 * 1000;
const LOCK_PARENT_DIRECTORY = 'idd-skill';
const LOCK_DIRECTORY = 'local-admission';
const LOCK_FILE_NAME = 'validate.lock';
/** Inherited descriptor that the wrapper and helper keep locked. */
const LOCK_FD = 3;
/** Descriptor the wrapper reports `acquired` on, through a dedicated pipe. */
const ACQUIRED_FD = 4;
const ACQUIRED_LINE = 'acquired\n';
/**
 * Acquire the inherited FD in descriptor mode, report it, then run argv with
 * the lock FD closed only in the command process. The wrapper keeps the lock
 * alive if the helper itself exits before its command.
 */
const ACQUIRED_WRAPPER =
  '"$1" "$2" "$3" "$4" "$5" "$6"; flock_status=$?; if [ "$flock_status" -ne 0 ]; then exit "$flock_status"; fi; printf "acquired\\n" >&4; exec 4>&-; shift 6; "$@" 3>&-; command_status=$?; exit "$command_status"';
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
};
const HELP_TEXT = `Usage:
  node scripts/idd-local-admission.mjs [--help] -- <command> [args...]

Run the command after \`--\` in the caller's working directory, under the
host-local validation slot (#4428). Policy: \`localExec.admission\` in the
repository's .github/idd/config.json. The flock backend admits one command;
the pueue backend uses the configured shared group on non-Windows hosts.

Exit status: the command's own status; 2 when the command was refused before
it started (policy, cap, symlink, or lock failure); 75 with
\`local-admission: expired\` when the wait reached maxWait; 3 when a pueue
task may have started but its outcome is unknown.
`;
function defaultDependencies() {
  return {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    homedir: userHomedir(),
    stderr: (text) => {
      process.stderr.write(text);
    },
    stdout: process.stdout,
    stderrOutput: process.stderr,
    readPolicy: (policyPath) => readRepositoryPolicyFile(policyPath).config,
    findFlock: (env) => findExecutableOnPath('flock', env),
    findPueue: (env) => findExecutableOnPath('pueue', env),
    findPs: (env) => findExecutableOnPath('ps', env),
    spawn: (command, args, options) => spawn(command, args, options),
    waitNoticeIntervalMs: DEFAULT_WAIT_NOTICE_INTERVAL_MS,
    pueueClientTimeoutMs: DEFAULT_PUEUE_CLIENT_TIMEOUT_MS,
    pueuePollIntervalMs: PUEUE_POLL_INTERVAL_MS,
  };
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Exit status for a child that ended by signal: 128 plus the signal number. */
function signalStatus(signal) {
  if (signal === null) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}
function describeExit(code, signal) {
  return signal === null ? `exit ${code}` : `signal ${signal}`;
}
function closeQuietly(fd) {
  try {
    closeSync(fd);
  } catch {
    // It may already be closed after a failed spawn or cleanup.
  }
}
/**
 * Per-user state base, resolved like `defaultLoadControlDirectory`: an
 * absolute `XDG_STATE_HOME` (else `~/.local/state`), or on Windows an absolute
 * `LOCALAPPDATA` (else `~/AppData/Local`). A relative value is ignored. The
 * lock lives beside `github-api-load-control`, not inside it.
 */
export function resolveStateBase(env, platform, home) {
  const pathModule = platform === 'win32' ? win32 : posix;
  const absolute = (value) => {
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
export function findRepositoryRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
/** The raw `localExec.admission.maxConcurrent`, or undefined when absent. */
function storedMaxConcurrent(raw) {
  if (!isRecord(raw) || !isRecord(raw.localExec)) return undefined;
  const admission = raw.localExec.admission;
  return isRecord(admission) ? admission.maxConcurrent : undefined;
}
/**
 * D1 (issue #4428, decision A): the raw stored cap decides the exit-2 rule.
 * A number above 1, or a non-blank string that `Number()` reads above 1,
 * counts. The normalizer would silently clamp 9 to 1, so it is not used here.
 */
export function storedCapAboveOne(raw) {
  if (typeof raw === 'number') return raw > 1;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw) > 1;
  return false;
}
/**
 * The repository's policy object, or null for the defaults. Only the file at
 * the repository root is read, never the layered config, and the loader is
 * not called when the file is absent or there is no `.git` ancestor.
 */
function loadRawPolicy(deps) {
  const root = findRepositoryRoot(deps.cwd);
  if (root === null) return null;
  const policyPath = join(root, DEFAULT_POLICY_CONFIG_PATH);
  if (!existsSync(policyPath)) return null;
  return deps.readPolicy(policyPath);
}
/**
 * Arguments for `flock`'s inherited-descriptor form. The descriptor number
 * follows the options; `flock` exits after acquiring it, and the wrapper and
 * helper keep the shared open-file description alive through supervision.
 */
export function buildFlockArguments(maxWaitMs) {
  const timeoutSeconds = Math.max(1, Math.ceil(maxWaitMs / 1000));
  return [
    '--timeout',
    String(timeoutSeconds),
    '--conflict-exit-code',
    String(EXPIRED_EXIT_CODE),
    String(LOCK_FD),
  ];
}
function makeDirectoryIfAbsent(dir) {
  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
/**
 * Create and open the lock. Both directories are `lstat`ed before any
 * creation and again after it, so a symlink in `idd-skill` or
 * `local-admission` refuses without creating anything. The lock path is
 * opened with `O_NOFOLLOW`, and a non-regular file is refused. The helper
 * never writes, truncates, or removes it.
 */
function openLockFile(deps) {
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
function waitForGroupToEnd(pgid, processStateTool, env) {
  return new Promise((resolveWait) => {
    const poll = () => {
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
export function parseProcessGroupStateOutput(output, pgid) {
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
function processGroupHasLiveMember(pgid, processStateTool, env) {
  const output = readProcessStateOutput(processStateTool, env);
  return (
    output === null || parseProcessGroupStateOutput(output, pgid) !== false
  );
}
function readProcessStateOutput(processStateTool, env) {
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
function processStateToolIsUsable(processStateTool, env) {
  const output = readProcessStateOutput(processStateTool, env);
  return output !== null && parseProcessGroupStateOutput(output, -1) !== null;
}
/**
 * Forward SIGINT and SIGTERM to the child, and settle one promise with the
 * exit status. A forwarded signal ends with 128 plus its number, after the
 * group is gone. A failed group signal settles 2 at once, without waiting.
 */
function superviseChild(child, deps, options) {
  return new Promise((resolveOutcome) => {
    let forwarded = null;
    let signalForwardFailed = false;
    let closed = false;
    let settled = false;
    const handlers = [];
    const settle = (status) => {
      if (settled) return;
      settled = true;
      for (const { signal, handler } of handlers) process.off(signal, handler);
      options.onBeforeSettle?.();
      resolveOutcome(status);
    };
    const forward = (signal) => {
      if (settled || (closed && !options.group)) return;
      forwarded ??= signal;
      if (!options.group) {
        child.kill(signal);
        return;
      }
      const pgid = child.pid;
      if (pgid === undefined) return;
      try {
        process.kill(-pgid, signal);
        signalForwardFailed = false;
      } catch (error) {
        if (closed && error.code === 'ESRCH') {
          return;
        }
        signalForwardFailed = true;
        deps.stderr(
          `local-admission: could not signal the admitted command (process group ${pgid}): ${errorMessage(error)}; the lock stays held until the command exits\n`,
        );
      }
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => forward(signal);
      handlers.push({ signal, handler });
      process.on(signal, handler);
    }
    child.on('error', (error) => {
      if (settled || closed) return;
      settle(options.onSpawnError(error));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      closed = true;
      const finish = () => {
        settle(
          signalForwardFailed
            ? REFUSED_EXIT_CODE
            : forwarded === null
              ? options.onClose(code, signal)
              : signalStatus(forwarded),
        );
      };
      const pgid = child.pid;
      if (options.group && pgid !== undefined) {
        void waitForGroupToEnd(
          pgid,
          options.processStateTool ?? null,
          deps.env,
        ).then(finish);
      } else {
        finish();
      }
    });
  });
}
/** Run the command with no admission: the child inherits stdio and gets the signals. */
function runDirect(command, deps) {
  const [program, ...args] = command;
  let child;
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
  command,
  flockPath,
  processStateTool,
  lockFd,
  maxWaitMs,
  deps,
) {
  let child;
  try {
    child = deps.spawn(
      'sh',
      [
        '-c',
        ACQUIRED_WRAPPER,
        'sh',
        flockPath,
        ...buildFlockArguments(maxWaitMs),
        ...command,
      ],
      {
        detached: true,
        stdio: ['inherit', 'inherit', 'inherit', lockFd, 'pipe'],
        env: { ...deps.env, [LOCAL_ADMISSION_ENV_VAR]: '1' },
        cwd: deps.cwd,
      },
    );
  } catch (error) {
    closeQuietly(lockFd);
    deps.stderr(
      `local-admission: cannot start flock: ${errorMessage(error)}; command not started\n`,
    );
    return Promise.resolve(REFUSED_EXIT_CODE);
  }
  let acquired = false;
  let ackText = '';
  const notice = setInterval(() => {
    if (!acquired) {
      deps.stderr('local-admission: waiting for the validation slot\n');
    }
  }, deps.waitNoticeIntervalMs);
  const ack = child.stdio[ACQUIRED_FD];
  ack?.setEncoding('utf8');
  ack?.on('data', (chunk) => {
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
  }).finally(() => closeQuietly(lockFd));
}
function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
/** Run one client command in its own group so a helper signal cannot leak to it. */
function runPueueClient(
  pueuePath,
  args,
  deps,
  timeoutMs,
  streamOutput = false,
  onChild,
) {
  return new Promise((resolveCall) => {
    let child;
    try {
      child = deps.spawn(pueuePath, args, {
        cwd: deps.cwd,
        env: deps.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolveCall({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        outputIncomplete: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    onChild?.(child);
    let stdout = '';
    let stderr = '';
    let streamStderrTail = '';
    let outputIncomplete = false;
    let timedOut = false;
    let settled = false;
    let killTimer;
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            signalProcessGroup(child, 'SIGTERM');
            killTimer = setTimeout(
              () => signalProcessGroup(child, 'SIGKILL'),
              300,
            );
            killTimer.unref();
          }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    if (streamOutput) {
      child.stdout?.pipe(deps.stdout, { end: false });
      child.stderr?.on('data', (chunk) => {
        const recent = streamStderrTail + chunk;
        if (PUEUE_LOCAL_FOLLOW_INCOMPLETE_OUTPUT.test(recent))
          outputIncomplete = true;
        streamStderrTail = recent.slice(-256);
      });
      child.stderr?.pipe(deps.stderrOutput, { end: false });
    } else {
      child.stdout?.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk;
      });
    }
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      onChild?.(null);
      resolveCall({
        code: null,
        signal: null,
        stdout,
        stderr,
        timedOut,
        outputIncomplete,
        error,
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      onChild?.(null);
      resolveCall({ code, signal, stdout, stderr, timedOut, outputIncomplete });
    });
  });
}
function enumName(value) {
  if (typeof value === 'string') return value.toLowerCase();
  if (isRecord(value)) {
    const key = Object.keys(value)[0];
    return key?.toLowerCase() ?? null;
  }
  return null;
}
function parsePueueTask(output, expectedTaskId) {
  try {
    const root = JSON.parse(output);
    if (!isRecord(root)) return null;
    const entry = isRecord(root[expectedTaskId]) ? root[expectedTaskId] : root;
    if (!isRecord(entry.task)) return null;
    const task = entry.task;
    if (String(task.id) !== expectedTaskId) return null;
    const label = typeof task.label === 'string' ? task.label : '';
    const statusValue = task.status;
    const statusName = enumName(statusValue);
    if (statusName === null) return null;
    const stateMap = {
      queued: 'queued',
      running: 'running',
      paused: 'paused',
      stashed: 'stashed',
      locked: 'locked',
      done: 'done',
    };
    const state = stateMap[statusName];
    if (state === undefined) return null;
    const doneValue = isRecord(statusValue) ? statusValue.Done : undefined;
    const resultValue =
      isRecord(doneValue) && Object.hasOwn(doneValue, 'result')
        ? doneValue.result
        : doneValue;
    const resultName = enumName(resultValue);
    let exitCode;
    const failedValue = isRecord(resultValue) ? resultValue.Failed : undefined;
    if (typeof failedValue === 'number') {
      exitCode = failedValue;
    } else if (isRecord(failedValue)) {
      const maybeCode = failedValue.exit_code ?? failedValue.code;
      if (typeof maybeCode === 'number') exitCode = maybeCode;
    }
    if (resultName === 'success') exitCode = 0;
    const outputText =
      typeof entry.output === 'string' ? entry.output : undefined;
    return {
      label,
      state,
      ...(resultName === null ? {} : { result: resultName }),
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(outputText === undefined ? {} : { output: outputText }),
    };
  } catch {
    return null;
  }
}
function isPueueLogErrorOutput(output) {
  return PUEUE_LOG_ERROR_PREFIXES.some((prefix) => output.startsWith(prefix));
}
function parsePueueGroups(output) {
  try {
    const parsed = JSON.parse(output);
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function isPueueClientSuccess(result) {
  return result.code === 0 && !result.timedOut && result.error === undefined;
}
function pueueOutcomeUnknown(deps, identity) {
  deps.stderr(
    `local-admission: pueue task outcome unknown (${identity}); command may have started\n`,
  );
  return PUEUE_OUTCOME_UNKNOWN_EXIT_CODE;
}
function effectivePueueCap(admission) {
  return Number.isInteger(admission.maxConcurrent) &&
    admission.maxConcurrent >= 1 &&
    admission.maxConcurrent <= 8
    ? admission.maxConcurrent
    : 1;
}
function resultForFinishedTask(task, deps, taskId) {
  if (task.exitCode !== undefined) return task.exitCode;
  const result = task.result ?? 'unknown';
  deps.stderr(
    `local-admission: pueue task ${taskId} finished with ${result}\n`,
  );
  return result === 'failedtospawn' ? SPAWN_FAILURE_OTHER_EXIT_CODE : 1;
}
/** Run backend pueue; before `add` failures can safely use flock, after it they cannot. */
function runPueueAdmission(command, admission, raw, deps) {
  const pueuePath = deps.findPueue(deps.env);
  const maxWaitMs =
    parseIsoDurationToMs(admission.maxWait) ??
    parseIsoDurationToMs(POLICY_DEFAULTS.localExec.admission.maxWait) ??
    FALLBACK_MAX_WAIT_MS;
  const cap = effectivePueueCap(admission);
  const groupName = admission.pueueGroup || 'idd-validate';
  let pendingSignal = null;
  let phase = 'pre-add';
  let activeClient = null;
  let activeFollow = null;
  let activeFollowPromise = null;
  let wakeSignal = null;
  const signalPromise = new Promise((resolveSignal) => {
    wakeSignal = resolveSignal;
  });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      pendingSignal ??= signal;
      wakeSignal?.(pendingSignal);
      if (phase === 'pre-add' && activeClient !== null) {
        signalProcessGroup(activeClient, signal);
      }
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  const cleanupHandlers = () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    phase = 'settled';
  };
  const statusForSignal = () => signalStatus(pendingSignal);
  const stopFollow = async (followPromise) => {
    const child = activeFollow;
    if (child === null) return;
    signalProcessGroup(child, 'SIGTERM');
    let killTimer;
    const ended = await Promise.race([
      followPromise.then(() => true),
      new Promise((resolveWait) => {
        killTimer = setTimeout(() => resolveWait(false), 300);
        killTimer.unref();
      }),
    ]);
    if (killTimer !== undefined) clearTimeout(killTimer);
    if (!ended && activeFollow !== null) {
      signalProcessGroup(activeFollow, 'SIGKILL');
    }
    await followPromise;
  };
  const call = (args, options = {}) => {
    if (pueuePath === null) {
      throw new Error('pueue client path was not checked before use');
    }
    return runPueueClient(
      pueuePath,
      args,
      deps,
      options.timeout === undefined
        ? deps.pueueClientTimeoutMs
        : options.timeout,
      options.stream ?? false,
      (child) => {
        if (options.stream) activeFollow = child;
        else activeClient = child;
      },
    );
  };
  const fallback = async (reason) => {
    deps.stderr(`local-admission: pueue ${reason}; using the flock path\n`);
    return runFlockAdmission(command, raw, deps, false);
  };
  const readTask = async (taskId, expectedLabel, includeOutput = false) => {
    const result = await call([
      'log',
      taskId,
      '--json',
      ...(includeOutput ? ['--full'] : []),
    ]);
    if (!isPueueClientSuccess(result)) return null;
    const task = parsePueueTask(result.stdout, taskId);
    if (task === null || task.label !== expectedLabel) return null;
    return task;
  };
  const removeTask = async (taskId) => {
    const removed = await call(['remove', taskId]);
    if (!isPueueClientSuccess(removed)) {
      deps.stderr(`local-admission: could not remove pueue task ${taskId}\n`);
    }
  };
  const finishTask = async (taskId, task, printOutput) => {
    phase = 'settled';
    if (printOutput && task.output) deps.stdout.write(task.output);
    const status = resultForFinishedTask(task, deps, taskId);
    await removeTask(taskId);
    return status;
  };
  const readCheckedTask = async (taskId, label, includeOutput = false) =>
    readTask(taskId, label, includeOutput);
  const handleRunningSignal = async (
    taskId,
    taskLabel,
    followPromise,
    signalled,
  ) => {
    phase = 'queued';
    const beforeKill = await readCheckedTask(taskId, taskLabel);
    if (beforeKill?.state === 'done') {
      // The task already completed; let pueue finish streaming its output.
      const completedFollow = await followPromise;
      if (
        !isPueueClientSuccess(completedFollow) ||
        completedFollow.outputIncomplete
      )
        return pueueOutcomeUnknown(deps, `task ${taskId}`);
      return finishTask(taskId, beforeKill, false);
    }
    if (
      beforeKill === null ||
      (beforeKill.state !== 'running' && beforeKill.state !== 'paused')
    ) {
      await stopFollow(followPromise);
      return pueueOutcomeUnknown(deps, `task ${taskId}`);
    }
    const killed = await call(['kill', taskId]);
    if (isPueueClientSuccess(killed)) {
      if (activeClient !== null) activeClient = null;
      await stopFollow(followPromise);
      await removeTask(taskId);
      return signalStatus(signalled);
    }
    const afterKill = await readCheckedTask(taskId, taskLabel);
    if (afterKill?.state === 'done') {
      // The task completed before the kill landed; let pueue finish streaming its output.
      const completedFollow = await followPromise;
      if (
        !isPueueClientSuccess(completedFollow) ||
        completedFollow.outputIncomplete
      )
        return pueueOutcomeUnknown(deps, `task ${taskId}`);
      return finishTask(taskId, afterKill, false);
    }
    await stopFollow(followPromise);
    return pueueOutcomeUnknown(deps, `task ${taskId}`);
  };
  const readFinishedTask = async (taskId, label) => {
    const task = await readCheckedTask(taskId, label, true);
    if (task?.state !== 'done') return null;
    if (task.output !== undefined && isPueueLogErrorOutput(task.output))
      return null;
    return task;
  };
  const work = async () => {
    if (deps.platform === 'win32') {
      deps.stderr(
        'local-admission: pueue backend is unavailable on win32; running the command without admission\n',
      );
      return runDirect(command, deps);
    }
    if (pueuePath === null)
      return fallback('client is not available on this host');
    const daemon = await call([
      'status',
      '--json',
      `label=idd-local-admission-health-${randomUUID()}`,
      'first',
      '1',
    ]);
    if (pendingSignal !== null) return statusForSignal();
    if (!isPueueClientSuccess(daemon)) {
      return fallback('daemon is not accepting commands');
    }
    let groupsResult = await call(['group', '--json']);
    if (pendingSignal !== null) return statusForSignal();
    let groups = isPueueClientSuccess(groupsResult)
      ? parsePueueGroups(groupsResult.stdout)
      : null;
    if (groups === null) return fallback('could not read the group list');
    let group = Object.hasOwn(groups, groupName)
      ? groups[groupName]
      : undefined;
    if (group === undefined) {
      const created = await call([
        'group',
        'add',
        '--parallel',
        String(cap),
        '--',
        groupName,
      ]);
      if (pendingSignal !== null) return statusForSignal();
      if (!isPueueClientSuccess(created)) {
        groupsResult = await call(['group', '--json']);
        if (pendingSignal !== null) return statusForSignal();
        groups = isPueueClientSuccess(groupsResult)
          ? parsePueueGroups(groupsResult.stdout)
          : null;
        if (groups === null || !Object.hasOwn(groups, groupName)) {
          return fallback('could not create the configured group');
        }
        group = groups[groupName];
      } else {
        group = { parallel_tasks: cap, status: 'Running' };
      }
    }
    if (!isRecord(group)) return fallback('group details are malformed');
    const parallel = group.parallel_tasks;
    if (typeof parallel === 'number' && parallel !== cap) {
      deps.stderr(
        `local-admission: pueue group ${groupName} has parallel_tasks=${parallel}, expected ${cap}; submitting anyway\n`,
      );
    }
    const groupStatus = enumName(group.status);
    if (groupStatus === 'paused') {
      deps.stderr(
        `local-admission: pueue group ${groupName} is paused; the task may wait until maxWait\n`,
      );
    }
    if (pendingSignal !== null) return statusForSignal();
    const taskLabel = `idd-local-admission-${randomUUID()}`;
    const taskCommand = `IDD_LOCAL_ADMISSION=1 ${command.map(shellQuote).join(' ')}`;
    phase = 'add';
    const added = await call([
      'add',
      `--group=${groupName}`,
      '-w',
      deps.cwd,
      '-l',
      taskLabel,
      '-p',
      taskCommand,
    ]);
    const idLine = added.stdout.trim().split(/\r?\n/).at(-1) ?? '';
    if (!isPueueClientSuccess(added) || !/^\d+$/.test(idLine)) {
      cleanupHandlers();
      return pueueOutcomeUnknown(deps, `label ${taskLabel}`);
    }
    const taskId = idLine;
    phase = 'queued';
    deps.stderr(
      `local-admission: pueue task ${taskId} queued (${taskLabel})\n`,
    );
    const startedAt = Date.now();
    let lastNoticeAt = startedAt;
    const stopQueuedTask = async (signal) => {
      const beforeStash = await readCheckedTask(taskId, taskLabel);
      if (beforeStash === null) {
        return pueueOutcomeUnknown(deps, `task ${taskId}`);
      }
      if (beforeStash.state === 'done') {
        const finished = await readFinishedTask(taskId, taskLabel);
        return finished === null
          ? pueueOutcomeUnknown(deps, `task ${taskId}`)
          : finishTask(taskId, finished, true);
      }
      if (beforeStash.state === 'running' || beforeStash.state === 'paused') {
        return null;
      }
      if (
        beforeStash.state !== 'queued' &&
        beforeStash.state !== 'stashed' &&
        beforeStash.state !== 'locked'
      ) {
        return pueueOutcomeUnknown(deps, `task ${taskId}`);
      }
      const stashed = await call(['stash', taskId]);
      if (isPueueClientSuccess(stashed)) {
        await removeTask(taskId);
        if (signal !== null) return signalStatus(signal);
        deps.stderr(
          `local-admission: expired (waited ${maxWaitMs} ms); command not started\n`,
        );
        return EXPIRED_EXIT_CODE;
      }
      const afterStash = await readCheckedTask(taskId, taskLabel);
      if (afterStash === null)
        return pueueOutcomeUnknown(deps, `task ${taskId}`);
      if (afterStash.state === 'done') {
        const finished = await readFinishedTask(taskId, taskLabel);
        return finished === null
          ? pueueOutcomeUnknown(deps, `task ${taskId}`)
          : finishTask(taskId, finished, true);
      }
      if (afterStash.state === 'running' || afterStash.state === 'paused') {
        return null;
      }
      return pueueOutcomeUnknown(deps, `task ${taskId}`);
    };
    while (true) {
      if (pendingSignal !== null) {
        const stopped = await stopQueuedTask(pendingSignal);
        if (stopped !== null) return stopped;
        break;
      }
      const task = await readCheckedTask(taskId, taskLabel);
      if (task === null) return pueueOutcomeUnknown(deps, `task ${taskId}`);
      if (task.state === 'done') {
        const finished = await readFinishedTask(taskId, taskLabel);
        return finished === null
          ? pueueOutcomeUnknown(deps, `task ${taskId}`)
          : finishTask(taskId, finished, true);
      }
      if (task.state === 'running' || task.state === 'paused') break;
      const elapsed = Date.now() - startedAt;
      if (elapsed >= maxWaitMs) {
        const stopped = await stopQueuedTask(null);
        if (stopped !== null) return stopped;
        break;
      }
      if (Date.now() - lastNoticeAt >= deps.waitNoticeIntervalMs) {
        deps.stderr('local-admission: waiting for the pueue validation slot\n');
        lastNoticeAt = Date.now();
      }
      await new Promise((resolveWait) =>
        setTimeout(
          resolveWait,
          Math.min(deps.pueuePollIntervalMs, Math.max(1, maxWaitMs - elapsed)),
        ),
      );
    }
    if (pendingSignal !== null) {
      // A failed stash raced with task start; the running signal path below owns it.
    }
    phase = 'running';
    const followPromise = call(['follow', taskId], {
      timeout: null,
      stream: true,
    });
    activeFollowPromise = followPromise;
    const followSignal = await Promise.race([
      followPromise.then((value) => ({ kind: 'follow', value })),
      signalPromise.then((value) => ({ kind: 'signal', value })),
    ]);
    if (followSignal.kind === 'signal') {
      const signalled = pendingSignal ?? followSignal.value;
      return handleRunningSignal(taskId, taskLabel, followPromise, signalled);
    }
    const follow = followSignal.value;
    if (follow.outputIncomplete) {
      if (pendingSignal !== null)
        return handleRunningSignal(
          taskId,
          taskLabel,
          followPromise,
          pendingSignal,
        );
      return pueueOutcomeUnknown(deps, `task ${taskId}`);
    }
    if (!isPueueClientSuccess(follow)) {
      if (pendingSignal !== null)
        return handleRunningSignal(
          taskId,
          taskLabel,
          followPromise,
          pendingSignal,
        );
      return pueueOutcomeUnknown(deps, `task ${taskId}`);
    }
    const afterFollow = await readCheckedTask(taskId, taskLabel);
    if (afterFollow === null) {
      if (pendingSignal !== null)
        return handleRunningSignal(
          taskId,
          taskLabel,
          followPromise,
          pendingSignal,
        );
      return pueueOutcomeUnknown(deps, `task ${taskId}`);
    }
    if (afterFollow.state === 'done')
      return finishTask(taskId, afterFollow, false);
    if (pendingSignal !== null)
      return handleRunningSignal(
        taskId,
        taskLabel,
        followPromise,
        pendingSignal,
      );
    return pueueOutcomeUnknown(deps, `task ${taskId}`);
  };
  return work().then(
    (status) => {
      cleanupHandlers();
      return status;
    },
    async (error) => {
      if (activeFollow !== null && activeFollowPromise !== null) {
        await stopFollow(activeFollowPromise);
      }
      if (activeClient !== null) {
        signalProcessGroup(activeClient, 'SIGTERM');
      }
      cleanupHandlers();
      deps.stderr(`local-admission: pueue error: ${errorMessage(error)}\n`);
      return PUEUE_OUTCOME_UNKNOWN_EXIT_CODE;
    },
  );
}
function runFlockAdmission(command, raw, deps, enforceStoredCap) {
  const flockPath = deps.platform === 'win32' ? null : deps.findFlock(deps.env);
  if (flockPath === null) {
    deps.stderr(
      'local-admission: flock is not available on this host; running the command without admission\n',
    );
    return runDirect(command, deps);
  }
  if (enforceStoredCap && storedCapAboveOne(storedMaxConcurrent(raw))) {
    deps.stderr(
      `local-admission: the flock backend admits one command at a time, but localExec.admission.maxConcurrent is ${String(storedMaxConcurrent(raw))}; command not started\n`,
    );
    return Promise.resolve(REFUSED_EXIT_CODE);
  }
  const processStateTool = deps.findPs(deps.env);
  if (
    processStateTool === null ||
    !processStateToolIsUsable(processStateTool, deps.env)
  ) {
    deps.stderr(
      'local-admission: ps is not available or returned unusable process-state output; command not started\n',
    );
    return Promise.resolve(REFUSED_EXIT_CODE);
  }
  const admission = normalizePolicyConfig(raw).localExec.admission;
  const maxWaitMs =
    parseIsoDurationToMs(admission.maxWait) ??
    parseIsoDurationToMs(POLICY_DEFAULTS.localExec.admission.maxWait) ??
    FALLBACK_MAX_WAIT_MS;
  const opened = openLockFile(deps);
  if ('refusal' in opened) {
    deps.stderr(`local-admission: ${opened.refusal}; command not started\n`);
    return Promise.resolve(REFUSED_EXIT_CODE);
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
/** `PATH` lookup for an executable file named `name`. */
export function findExecutableOnPath(name, env) {
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
function parseLocalAdmissionArgs(argv) {
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
export async function runLocalAdmission(argv, overrides = {}) {
  const deps = { ...defaultDependencies(), ...overrides };
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
  let raw;
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
    return runPueueAdmission(command, admission, raw, deps);
  }
  return runFlockAdmission(command, raw, deps, true);
}
/** The CLI body: reads the process arguments and returns the exit status. */
export function runLocalAdmissionCli() {
  return runLocalAdmission(process.argv.slice(2));
}
/**
 * Shared entry point: the `import.meta.main` guard below and the
 * `src/bin/idd-local-admission.mts` wrapper both call this, so the bin runs
 * the module in this process and a signal reaches the admitted child.
 */
export function runLocalAdmissionEntry() {
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
