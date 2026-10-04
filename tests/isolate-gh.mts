import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import workerThreads, { type WorkerOptions } from 'node:worker_threads';

interface GhAttempt {
  readonly id: string;
  readonly at: string;
  readonly api: string;
  readonly executable: string;
  readonly resolvedExecutable: string | null;
  readonly args: string[];
  readonly pid: number;
  readonly threadId: number;
}

interface LaunchOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly shell?: boolean | string;
  readonly execPath?: string;
}

type LaunchMethod = (...args: unknown[]) => unknown;

const guardImport = new URL('./isolate-gh.mts', import.meta.url).href;
const workerBridgePath = fileURLToPath(
  new URL('./isolate-gh-worker.cjs', import.meta.url),
);
const state = { acknowledged: new Set<string>(), root: null as string | null };

function ensureLedger(): { ledger: string; ownerPid: number } {
  let root = process.env.IDD_TEST_GH_GUARD_ROOT;
  let ledger = process.env.IDD_TEST_GH_GUARD_LEDGER;
  let ownerPid = Number(process.env.IDD_TEST_GH_GUARD_OWNER_PID);
  if (!ledger) {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'idd-test-gh-guard-'));
    ledger = path.join(root, 'attempts.jsonl');
    ownerPid = process.pid;
    process.env.IDD_TEST_GH_GUARD_ROOT = root;
    process.env.IDD_TEST_GH_GUARD_LEDGER = ledger;
    process.env.IDD_TEST_GH_GUARD_OWNER_PID = String(ownerPid);
    process.env.IDD_TEST_GH_GUARD_ROOT_OWNER_PID = String(ownerPid);
  }
  state.root = root ?? null;
  return { ledger, ownerPid };
}

function parseLedger(ledger: string): GhAttempt[] {
  let source: string;
  try {
    source = fs.readFileSync(ledger, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return source
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GhAttempt);
}

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function executableBase(value: string): string {
  return path
    .basename(value.replace(/^['"]|['"]$/gu, ''))
    .replace(/\.exe$/iu, '')
    .toLowerCase();
}

function isGhExecutable(value: string): boolean {
  return executableBase(value) === 'gh';
}

function allowedStubPaths(): Set<string> {
  try {
    const parsed = JSON.parse(
      process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS ?? '[]',
    ) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map(normalizePath),
    );
  } catch {
    return new Set();
  }
}

function resolveGhPath(command: string, env?: NodeJS.ProcessEnv): string {
  const unquoted = command.replace(/^['"]|['"]$/gu, '');
  if (unquoted.includes('/') || unquoted.includes('\\')) {
    return path.resolve(unquoted);
  }
  const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? '';
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${unquoted}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through PATH and the platform's executable suffixes.
      }
    }
  }
  return path.resolve(unquoted);
}

function isRegisteredFixture(
  command: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  return allowedStubPaths().has(normalizePath(resolveGhPath(command, env)));
}

function containsCredential(value: string): boolean {
  return /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|github_pat|\bBearer\s+\S+|\b(?:token|password|secret|authorization)=\S+)/iu.test(
    value,
  );
}

function safeArguments(args: readonly unknown[]): string[] {
  const safe: string[] = [];
  let redactNext = false;
  for (const value of args) {
    const argument = String(value);
    if (redactNext) {
      safe.push('[redacted]');
      redactNext = false;
      continue;
    }
    const optionAndValue = /^(--?[A-Za-z0-9-]+)=(.*)$/u.exec(argument);
    if (optionAndValue) {
      const [, option, optionValue] = optionAndValue;
      safe.push(
        `${option}=${containsCredential(optionValue ?? '') ? '[redacted]' : '[value]'}`,
      );
      continue;
    }
    if (
      /^--?(?:body|body-file|field|raw-field|header|input|json|title|token|password|secret|authorization|config|hostname)$/iu.test(
        argument,
      ) ||
      /^-[fFH]$/u.test(argument)
    ) {
      safe.push(argument);
      redactNext = true;
      continue;
    }
    safe.push(containsCredential(argument) ? '[redacted]' : argument);
  }
  return safe;
}

function shellPayload(
  command: string,
  args: readonly unknown[],
): string | null {
  const base = executableBase(command);
  if (
    !['sh', 'bash', 'dash', 'zsh', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(
      base,
    )
  ) {
    return null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (['-c', '/c', '-command'].includes(argument.toLowerCase())) {
      return args
        .slice(index + 1)
        .map(String)
        .join(' ');
    }
    if (argument.toLowerCase().startsWith('-command:')) {
      return argument.slice(argument.indexOf(':') + 1);
    }
  }
  return null;
}

/** Find gh only where a shell parser would treat a token as a command. */
function shellContainsUnexpectedGh(
  source: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  const tokens =
    source.match(
      /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;&|(){}\n]|[^\s;&|(){}\n]+/gu,
    ) ?? [];
  let commandPosition = true;
  let wrapper: string | null = null;
  let skipWrapperArgument = false;
  for (const token of tokens) {
    if (/^[;&|(){}\n]$/u.test(token) || token === '&&' || token === '||') {
      commandPosition = true;
      wrapper = null;
      skipWrapperArgument = false;
      continue;
    }
    if (!commandPosition) continue;
    const word = token.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue;
    if (wrapper === 'env' && skipWrapperArgument) {
      skipWrapperArgument = false;
      continue;
    }
    if (wrapper === 'env' && word.startsWith('-')) {
      skipWrapperArgument = ['-u', '--unset', '-C', '--chdir', '-S'].includes(
        word,
      );
      continue;
    }
    if (['command', 'exec', 'env', 'nohup', 'sudo', 'time'].includes(word)) {
      wrapper = word;
      continue;
    }
    if (['if', 'then', 'else', 'elif', 'while', 'until', 'do'].includes(word)) {
      continue;
    }
    commandPosition = false;
    wrapper = null;
    if (isGhExecutable(word) && !isRegisteredFixture(word, env)) return true;
  }
  return false;
}

function inspectInvocation(
  api: string,
  commandValue: unknown,
  args: readonly unknown[],
  optionsValue: unknown,
): void {
  const command = String(commandValue);
  const options =
    optionsValue !== null && typeof optionsValue === 'object'
      ? (optionsValue as LaunchOptions)
      : undefined;
  const env = options?.env;
  let unexpected = false;
  let executable = command;
  if (isGhExecutable(command)) {
    unexpected = !isRegisteredFixture(command, env);
  } else {
    const shellCommand = shellPayload(command, args);
    if (shellCommand !== null) {
      unexpected = shellContainsUnexpectedGh(shellCommand, env);
      if (unexpected) executable = 'gh in shell command';
    } else if (options?.shell) {
      unexpected = shellContainsUnexpectedGh(command, env);
      if (unexpected) executable = 'gh in shell command';
    }
  }
  if (!unexpected) return;

  const { ledger } = ensureLedger();
  const resolvedExecutable = isGhExecutable(command)
    ? resolveGhPath(command, env)
    : null;
  const record: GhAttempt = {
    id: `gh-${process.pid}-${workerThreads.threadId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    api,
    executable,
    resolvedExecutable,
    args:
      executable === 'gh in shell command'
        ? ['[shell command omitted]']
        : safeArguments(args),
    pid: process.pid,
    threadId: workerThreads.threadId,
  };
  try {
    fs.appendFileSync(ledger, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    process.exitCode = 1;
    throw Object.assign(
      new Error(
        `isolate-gh: blocked ${api} because it could not record the attempted real gh invocation`,
        { cause: error },
      ),
      { code: 'IDD_GH_GUARD_LEDGER_FAILURE' },
    );
  }
  throw Object.assign(
    new Error(`isolate-gh: blocked unexpected real gh invocation via ${api}`),
    { code: 'IDD_UNEXPECTED_REAL_GH', iddGhGuardAttemptId: record.id },
  );
}

const { ledger, ownerPid } = ensureLedger();
const shouldCheckExit =
  workerThreads.threadId === 0 &&
  (process.env.IDD_TEST_GH_GUARD_SELF_CHECK === '1' ||
    ownerPid === process.pid);

function appendGuardImport(env: NodeJS.ProcessEnv): void {
  env.IDD_TEST_GH_GUARD_IMPORT = guardImport;
  const current = env.NODE_OPTIONS ?? '';
  if (!current.includes(guardImport)) {
    env.NODE_OPTIONS = current
      ? `${current} --import=${guardImport}`
      : `--import=${guardImport}`;
  }
}

function optionsWithGuard(options: unknown, directGhFixture: boolean): unknown {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options)
  ) {
    if (!directGhFixture) return options;
  }
  const record =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? (options as LaunchOptions)
      : {};
  const env = { ...(record.env ?? process.env) } as NodeJS.ProcessEnv;
  for (const name of [
    'IDD_TEST_GH_GUARD_ROOT',
    'IDD_TEST_GH_GUARD_LEDGER',
    'IDD_TEST_GH_GUARD_OWNER_PID',
    'IDD_TEST_GH_GUARD_ROOT_OWNER_PID',
    'IDD_TEST_GH_GUARD_IMPORT',
    'IDD_TEST_GH_GUARD_ALLOWED_STUBS',
  ]) {
    if (env[name] === undefined && process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }
  if (directGhFixture) {
    const importFlag = `--import=${guardImport}`;
    const current = (env.NODE_OPTIONS ?? '')
      .replaceAll(importFlag, '')
      .replaceAll(`--import="${guardImport}"`, '')
      .trim();
    const requireFlag = `--require "${workerBridgePath.replaceAll('\\', '/')}"`;
    env.NODE_OPTIONS = current.includes(workerBridgePath)
      ? current
      : current
        ? `${current} ${requireFlag}`
        : requireFlag;
  } else {
    appendGuardImport(env);
  }
  return { ...record, env };
}

const childProcessApi = childProcess as unknown as Record<string, LaunchMethod>;

function wrap(
  method: string,
  inspect: (...args: unknown[]) => void,
  optionsIndex: (args: unknown[]) => number,
): void {
  const original = childProcessApi[method];
  const wrapped = function (this: unknown, ...args: unknown[]) {
    inspect(...args);
    const index = optionsIndex(args);
    if (index >= 0) {
      const options = args[index] as LaunchOptions | undefined;
      const directGhFixture =
        ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method) &&
        isGhExecutable(String(args[0])) &&
        isRegisteredFixture(String(args[0]), options?.env);
      args[index] = optionsWithGuard(args[index], directGhFixture);
    }
    return Reflect.apply(
      original as (...args: unknown[]) => unknown,
      this,
      args,
    );
  };
  Object.setPrototypeOf(wrapped, original);
  childProcessApi[method] = wrapped;
}

const optionsAfterArgs = (args: unknown[]): number =>
  Array.isArray(args[1]) ? 2 : 1;
wrap(
  'spawn',
  (command, argsOrOptions, options) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    inspectInvocation(
      'spawn',
      command,
      args,
      Array.isArray(argsOrOptions) ? options : argsOrOptions,
    );
  },
  optionsAfterArgs,
);
wrap(
  'spawnSync',
  (command, argsOrOptions, options) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    inspectInvocation(
      'spawnSync',
      command,
      args,
      Array.isArray(argsOrOptions) ? options : argsOrOptions,
    );
  },
  optionsAfterArgs,
);
wrap(
  'exec',
  (command, options) =>
    inspectInvocation('exec', 'sh', ['-c', String(command)], options),
  () => 1,
);
wrap(
  'execSync',
  (command, options) =>
    inspectInvocation('execSync', 'sh', ['-c', String(command)], options),
  () => 1,
);
wrap(
  'execFile',
  (file, argsOrOptions, options) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    inspectInvocation(
      'execFile',
      file,
      args,
      Array.isArray(argsOrOptions) ? options : argsOrOptions,
    );
  },
  optionsAfterArgs,
);
wrap(
  'execFileSync',
  (file, argsOrOptions, options) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    inspectInvocation(
      'execFileSync',
      file,
      args,
      Array.isArray(argsOrOptions) ? options : argsOrOptions,
    );
  },
  optionsAfterArgs,
);
wrap(
  'fork',
  (modulePath, argsOrOptions, options) => {
    const forkOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions;
    inspectInvocation(
      'fork',
      (forkOptions as LaunchOptions | undefined)?.execPath ?? process.execPath,
      [modulePath],
      forkOptions,
    );
  },
  optionsAfterArgs,
);

const OriginalWorker = workerThreads.Worker;
class GuardedWorker extends OriginalWorker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    if (options.env === workerThreads.SHARE_ENV) {
      super(filename, options);
      return;
    }
    const env = { ...(options.env ?? process.env) } as NodeJS.ProcessEnv;
    for (const name of [
      'IDD_TEST_GH_GUARD_ROOT',
      'IDD_TEST_GH_GUARD_LEDGER',
      'IDD_TEST_GH_GUARD_OWNER_PID',
      'IDD_TEST_GH_GUARD_ROOT_OWNER_PID',
      'IDD_TEST_GH_GUARD_IMPORT',
      'IDD_TEST_GH_GUARD_ALLOWED_STUBS',
    ]) {
      if (env[name] === undefined && process.env[name] !== undefined) {
        env[name] = process.env[name];
      }
    }
    const normalizedBridgePath = workerBridgePath.replaceAll('\\', '/');
    const current = env.NODE_OPTIONS ?? '';
    if (!current.replaceAll('\\', '/').includes(normalizedBridgePath)) {
      const requireFlag = `--require "${normalizedBridgePath}"`;
      env.NODE_OPTIONS = current ? `${current} ${requireFlag}` : requireFlag;
    }
    super(filename, { ...options, env });
  }
}
Object.setPrototypeOf(GuardedWorker, OriginalWorker);
Object.defineProperty(GuardedWorker, 'name', { value: OriginalWorker.name });
(workerThreads as unknown as { Worker: typeof OriginalWorker }).Worker =
  GuardedWorker;
syncBuiltinESMExports();

if (shouldCheckExit) {
  process.on('exit', () => {
    let attempts: GhAttempt[] = [];
    let malformed = false;
    try {
      attempts = parseLedger(ledger);
    } catch {
      malformed = true;
    }
    const unexpected = attempts.filter(
      (attempt) => !state.acknowledged.has(attempt.id),
    );
    if (malformed || unexpected.length > 0) {
      process.exitCode = 1;
      try {
        const detail = unexpected
          .map(
            (attempt) =>
              `  ${attempt.id}: ${attempt.api} attempted ${attempt.executable} ${JSON.stringify(attempt.args)} resolved to ${attempt.resolvedExecutable ?? 'unknown'} (pid ${attempt.pid}, thread ${attempt.threadId})`,
          )
          .join('\n');
        fs.writeSync(
          2,
          malformed
            ? 'isolate-gh: LEAK: the real-gh attempt ledger was malformed; the test process is failing closed\n'
            : `isolate-gh: LEAK: ${unexpected.length} unexpected real gh invocation(s) were blocked; the owning test process must fail:\n${detail}\n`,
        );
      } catch {
        // The exit code already carries the failure.
      }
    }
    if (
      process.env.IDD_TEST_GH_GUARD_ROOT_OWNER_PID === String(process.pid) &&
      state.root
    ) {
      try {
        fs.rmSync(state.root, { recursive: true, force: true });
      } catch {
        // The temporary ledger root is best-effort cleanup.
      }
    }
  });
}
