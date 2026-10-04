'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const moduleApi = require('node:module');
const path = require('node:path');
const { threadId } = require('node:worker_threads');

function isGh(value) {
  return (
    path
      .basename(String(value).replace(/^['"]|['"]$/gu, ''))
      .replace(/\.exe$/iu, '')
      .toLowerCase() === 'gh'
  );
}

function resolvedGh(value, env) {
  const command = String(value).replace(/^['"]|['"]$/gu, '');
  if (command.includes('/') || command.includes('\\')) {
    return path.resolve(command);
  }
  const pathValue = env?.PATH ?? env?.Path ?? process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of process.platform === 'win32'
      ? ['', '.exe']
      : ['']) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching the inherited PATH.
      }
    }
  }
  return path.resolve(command);
}

function fixturePaths() {
  try {
    const parsed = JSON.parse(
      process.env.IDD_TEST_GH_GUARD_ALLOWED_STUBS ?? '[]',
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed
            .filter((entry) => typeof entry === 'string')
            .map((entry) =>
              process.platform === 'win32'
                ? path.resolve(entry).toLowerCase()
                : path.resolve(entry),
            )
        : [],
    );
  } catch {
    return new Set();
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isRegisteredFixture(value, env) {
  return fixturePaths().has(normalizedPath(resolvedGh(value, env)));
}

function shellPayload(command, args, options) {
  const base = path
    .basename(String(command))
    .replace(/\.exe$/iu, '')
    .toLowerCase();
  if (options?.shell) return String(command);
  if (
    !['sh', 'bash', 'dash', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(base)
  ) {
    return null;
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]).toLowerCase();
    if (['-c', '/c', '-command'].includes(argument)) {
      return args
        .slice(index + 1)
        .map(String)
        .join(' ');
    }
  }
  return null;
}

function shellGhCommand(command) {
  const tokens =
    String(command).match(
      /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;&|(){}\n]|[^\s;&|(){}\n]+/gu,
    ) ?? [];
  let commandPosition = true;
  for (const token of tokens) {
    if (/^[;&|(){}\n]$/u.test(token) || token === '&&' || token === '||') {
      commandPosition = true;
      continue;
    }
    if (!commandPosition) continue;
    const word = token.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) continue;
    commandPosition = false;
    if (isGh(word)) return word;
  }
  return null;
}

function safeArgs(args) {
  const values = [];
  let redactNext = false;
  for (const value of args) {
    const argument = String(value);
    if (redactNext) {
      values.push('[redacted]');
      redactNext = false;
      continue;
    }
    const optionAndValue = /^(--?[A-Za-z0-9-]+)=(.*)$/u.exec(argument);
    if (optionAndValue) {
      const [, option, optionValue] = optionAndValue;
      values.push(
        `${option}=${/(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+|\b(?:token|password|secret|authorization)=\S+)/iu.test(optionValue ?? '') ? '[redacted]' : '[value]'}`,
      );
      continue;
    }
    if (
      /^--?(?:body|body-file|field|raw-field|header|input|json|title|token|password|secret|authorization|config|hostname)$/iu.test(
        argument,
      ) ||
      /^-[fFH]$/u.test(argument)
    ) {
      values.push(argument);
      redactNext = true;
    } else if (
      /(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+|\b(?:token|password|secret|authorization)=\S+)/iu.test(
        argument,
      )
    ) {
      values.push('[redacted]');
    } else {
      values.push(argument);
    }
  }
  return values;
}

function blockIfGh(api, command, args, options) {
  let ghCommand = null;
  let direct = false;
  if (isGh(command)) {
    ghCommand = String(command);
    direct = true;
    if (isRegisteredFixture(command, options?.env)) return;
  } else {
    const shell = shellPayload(command, args, options);
    if (shell !== null) {
      ghCommand = shellGhCommand(shell);
      if (ghCommand && isRegisteredFixture(ghCommand, options?.env)) return;
    }
  }
  if (!ghCommand) return;

  const env = options?.env;
  const ledger =
    env?.IDD_TEST_GH_GUARD_LEDGER ?? process.env.IDD_TEST_GH_GUARD_LEDGER;
  if (!ledger) {
    process.exitCode = 1;
    throw Object.assign(
      new Error('isolate-gh: blocked a worker gh call without an owner ledger'),
      {
        code: 'IDD_GH_GUARD_LEDGER_MISSING',
      },
    );
  }
  const resolved = direct
    ? resolvedGh(command, env)
    : resolvedGh(ghCommand, env);
  const expected =
    resolved === null
      ? null
      : process.platform === 'win32'
        ? resolved.toLowerCase()
        : resolved;
  if (expected !== null && fixturePaths().has(expected)) return;
  const record = {
    id: `gh-${process.pid}-${threadId}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    api,
    executable: direct ? String(command) : 'gh in shell command',
    resolvedExecutable: resolved,
    args:
      !direct && shellPayload(command, args, options) !== null
        ? ['[shell command omitted]']
        : safeArgs(args),
    pid: process.pid,
    threadId,
  };
  try {
    fs.appendFileSync(ledger, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (error) {
    process.exitCode = 1;
    throw Object.assign(
      new Error(
        'isolate-gh: blocked a worker gh call because the attempt ledger could not be written',
        { cause: error },
      ),
      {
        code: 'IDD_GH_GUARD_LEDGER_FAILURE',
      },
    );
  }
  throw Object.assign(
    new Error(`isolate-gh: blocked unexpected worker gh invocation via ${api}`),
    { code: 'IDD_UNEXPECTED_REAL_GH', iddGhGuardAttemptId: record.id },
  );
}

function addGuardToOptions(options, addImport) {
  const hasOptions =
    options !== null && typeof options === 'object' && !Array.isArray(options);
  if (!addImport && !hasOptions) options = {};
  if (addImport && !hasOptions) return options;
  const record = hasOptions ? options : {};
  const env = { ...(record.env ?? process.env) };
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
  if (addImport) {
    const guardImport = env.IDD_TEST_GH_GUARD_IMPORT;
    if (guardImport && !(env.NODE_OPTIONS ?? '').includes(guardImport)) {
      env.NODE_OPTIONS = env.NODE_OPTIONS
        ? `${env.NODE_OPTIONS} --import=${guardImport}`
        : `--import=${guardImport}`;
    }
  } else {
    const guardImport = env.IDD_TEST_GH_GUARD_IMPORT;
    const current = guardImport
      ? (env.NODE_OPTIONS ?? '')
          .replaceAll(`--import=${guardImport}`, '')
          .replaceAll(`--import="${guardImport}"`, '')
          .trim()
      : (env.NODE_OPTIONS ?? '');
    const requireFlag = `--require "${__filename.replaceAll('\\', '/')}"`;
    env.NODE_OPTIONS = current.includes(__filename)
      ? current
      : current
        ? `${current} ${requireFlag}`
        : requireFlag;
  }
  return { ...record, env };
}

function wrap(method, optionsIndex, inspect) {
  const original = childProcess[method];
  childProcess[method] = function (...args) {
    inspect(...args);
    const index = optionsIndex(args);
    if (index >= 0) {
      const launchOptions = args[index];
      const directGhFixture =
        ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method) &&
        isGh(args[0]) &&
        isRegisteredFixture(args[0], launchOptions?.env);
      args[index] = addGuardToOptions(args[index], !directGhFixture);
    }
    return Reflect.apply(original, this, args);
  };
}

const optionsAfterArgs = (args) => (Array.isArray(args[1]) ? 2 : 1);
wrap('spawn', optionsAfterArgs, (command, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'spawn',
    command,
    args,
    Array.isArray(argsOrOptions) ? options : argsOrOptions,
  );
});
wrap('spawnSync', optionsAfterArgs, (command, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'spawnSync',
    command,
    args,
    Array.isArray(argsOrOptions) ? options : argsOrOptions,
  );
});
wrap(
  'exec',
  () => 1,
  (command, options) =>
    blockIfGh('exec', 'sh', ['-c', String(command)], options),
);
wrap(
  'execSync',
  () => 1,
  (command, options) =>
    blockIfGh('execSync', 'sh', ['-c', String(command)], options),
);
wrap('execFile', optionsAfterArgs, (file, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'execFile',
    file,
    args,
    Array.isArray(argsOrOptions) ? options : argsOrOptions,
  );
});
wrap('execFileSync', optionsAfterArgs, (file, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'execFileSync',
    file,
    args,
    Array.isArray(argsOrOptions) ? options : argsOrOptions,
  );
});
wrap('fork', optionsAfterArgs, (modulePath, argsOrOptions, options) => {
  const forkOptions = Array.isArray(argsOrOptions) ? options : argsOrOptions;
  blockIfGh(
    'fork',
    forkOptions?.execPath ?? process.execPath,
    [modulePath],
    forkOptions,
  );
});
moduleApi.syncBuiltinESMExports();
