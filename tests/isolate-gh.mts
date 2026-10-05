import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
const normalizedWorkerBridgePath = workerBridgePath.replaceAll('\\', '/');
const workerBridgeUrl = pathToFileURL(workerBridgePath).href;
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

function defaultExecutableSearchPath(): string {
  if (process.platform !== 'win32') return '/bin:/usr/bin';
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return [path.join(windowsRoot, 'System32'), windowsRoot].join(path.delimiter);
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

function resolveGhPath(
  command: string,
  env?: NodeJS.ProcessEnv,
): string | null {
  const unquoted = command.replace(/^['"]|['"]$/gu, '');
  if (unquoted.includes('/') || unquoted.includes('\\')) {
    return path.resolve(unquoted);
  }
  const pathValue =
    env === undefined
      ? (process.env.PATH ?? process.env.Path ?? '')
      : (env.PATH ?? env.Path ?? defaultExecutableSearchPath());
  const extensions =
    process.platform === 'win32' ? ['', '.exe', '.com', '.cmd', '.bat'] : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.resolve(
        directory || '.',
        `${unquoted}${extension}`,
      );
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue through PATH and the platform's executable suffixes.
      }
    }
  }
  return null;
}

function isRegisteredFixture(
  command: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  const resolved = resolveGhPath(command, env);
  return resolved !== null && allowedStubPaths().has(normalizePath(resolved));
}

function containsCredential(value: string): boolean {
  return /(?:gh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|github_pat|\bBearer\s+\S+|\b[A-Za-z_][A-Za-z0-9_]*(?:token|password|secret|authorization|key)=\S+)/iu.test(
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
    const environmentAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(
      argument,
    );
    if (environmentAssignment) {
      safe.push(`${environmentAssignment[1]}=[redacted]`);
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

function safeInvocationArguments(
  command: string,
  args: readonly unknown[],
): string[] {
  if (executableBase(command) !== 'env') return safeArguments(args);
  const sanitized: unknown[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (argument === '-S' || argument === '--split-string') {
      sanitized.push(argument, '[split string omitted]');
      index += 1;
      continue;
    }
    if (argument.startsWith('--split-string=')) {
      sanitized.push('--split-string=[split string omitted]');
      continue;
    }
    sanitized.push(argument);
  }
  return safeArguments(sanitized);
}

function shellPayload(
  command: string,
  args: readonly unknown[],
  options?: LaunchOptions,
): string | null {
  const base = executableBase(command);
  if (
    ['sh', 'bash', 'dash', 'zsh', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(
      base,
    )
  ) {
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
  }
  return options?.shell ? [command, ...args].map(String).join(' ') : null;
}

function readCommandSubstitution(
  source: string,
  start: number,
): { body: string; end: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = null;
        continue;
      }
      if (source.startsWith('$(', index)) {
        depth += 1;
        index += 1;
        continue;
      }
      if (character === '`') {
        const nested = readBacktickSubstitution(source, index);
        if (nested) index = nested.end;
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === '`') {
      const nested = readBacktickSubstitution(source, index);
      if (nested) index = nested.end;
      continue;
    }
    if (source.startsWith('$(', index)) {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
      continue;
    }
    if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(start + 2, index), end: index };
      }
    }
  }
  return null;
}

function readBacktickSubstitution(
  source: string,
  start: number,
): { body: string; end: number } | null {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '`') {
      return { body: source.slice(start + 1, index), end: index };
    }
  }
  return null;
}

type ShellFlavor = 'posix' | 'powershell' | 'other';

function shellFlavor(command: string): ShellFlavor {
  const base = executableBase(command);
  if (['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(base)) return 'posix';
  if (['powershell', 'pwsh'].includes(base)) return 'powershell';
  return 'other';
}

function shellFlavorForLaunch(
  command: string,
  options?: LaunchOptions,
): ShellFlavor {
  if (options?.shell) {
    return typeof options.shell === 'string'
      ? shellFlavor(options.shell)
      : process.platform === 'win32'
        ? 'other'
        : 'posix';
  }
  return shellFlavor(command);
}

function stripShellLineContinuations(source: string): string {
  let result = '';
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\' && quote !== "'") {
      const next = source[index + 1];
      if (next === '\n') {
        index += 1;
        continue;
      }
      if (next === '\r' && source[index + 2] === '\n') {
        index += 2;
        continue;
      }
      result += character;
      if (next !== undefined) {
        result += next;
        index += 1;
      }
      continue;
    }
    result += character;
    if (quote === "'") {
      if (character === "'") quote = null;
    } else if (quote === '"') {
      if (character === '"') quote = null;
    } else if (character === "'") {
      quote = "'";
    } else if (character === '"') {
      quote = '"';
    }
  }
  return result;
}

function stripShellComments(source: string): string {
  const characters = [...source];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') quote = null;
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    const previous = characters[index - 1];
    if (
      character === '#' &&
      (previous === undefined || /[\s;&|(){}]/u.test(previous))
    ) {
      while (index < characters.length && characters[index] !== '\n') {
        characters[index] = ' ';
        index += 1;
      }
    }
  }
  return characters.join('');
}

interface HereDocument {
  readonly delimiter: string;
  readonly stripTabs: boolean;
  readonly quoted: boolean;
}

function readHereDocument(
  source: string,
  start: number,
): { document: HereDocument; end: number } | null {
  if (!source.startsWith('<<', start) || source[start + 2] === '<') {
    return null;
  }
  let index = start + 2;
  const stripTabs = source[index] === '-';
  if (stripTabs) index += 1;
  while (source[index] === ' ' || source[index] === '\t') index += 1;
  let delimiter = '';
  let quote: "'" | '"' | null = null;
  let quoted = false;
  for (; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      else delimiter += character;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === '\\' && source[index + 1] !== undefined) {
        delimiter += source[index + 1];
        index += 1;
      } else delimiter += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      quoted = true;
      continue;
    }
    if (character === '\\' && source[index + 1] !== undefined) {
      quoted = true;
      delimiter += source[index + 1];
      index += 1;
      continue;
    }
    if (/[\s;|&()<>]/u.test(character ?? '')) break;
    delimiter += character;
  }
  if (delimiter.length === 0 || quote !== null) return null;
  return { document: { delimiter, stripTabs, quoted }, end: index };
}

function blankLine(source: string): string {
  return source.replace(/[^\r\n]/gu, ' ');
}

function stripShellCommentsAndQuotedHereDocuments(source: string): {
  source: string;
  unquotedHereDocuments: string[];
} {
  const output: string[] = [];
  const unquotedHereDocuments: string[] = [];
  let pending: HereDocument[] = [];
  let unquotedDocumentLines: string[] = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\r?\n$/u, '');
    const ending = lineWithEnding.slice(line.length);
    if (pending.length > 0) {
      const document = pending[0];
      const comparable = document?.stripTabs ? line.replace(/^\t+/u, '') : line;
      const isDelimiter = comparable === document?.delimiter;
      if (!isDelimiter && document && !document.quoted) {
        unquotedDocumentLines.push(line);
      }
      output.push(blankLine(line), ending);
      if (isDelimiter) {
        if (document && !document.quoted) {
          unquotedHereDocuments.push(unquotedDocumentLines.join('\n'));
        }
        unquotedDocumentLines = [];
        pending = pending.slice(1);
      }
      continue;
    }

    const characters = [...stripShellComments(line)];
    let quote: "'" | '"' | null = null;
    const found: HereDocument[] = [];
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index];
      if (quote === "'") {
        if (character === "'") quote = null;
        continue;
      }
      if (quote === '"') {
        if (character === '\\') index += 1;
        else if (character === '"') quote = null;
        continue;
      }
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === "'") {
        quote = "'";
        continue;
      }
      if (character === '"') {
        quote = '"';
        continue;
      }
      if (character === '<' && characters[index + 1] === '<') {
        const parsed = readHereDocument(line, index);
        if (parsed) {
          found.push(parsed.document);
          index = parsed.end - 1;
        }
      }
    }
    output.push(characters.join(''), ending);
    if (ending.length > 0) pending = found;
  }
  const unterminatedDocument = pending[0];
  if (unterminatedDocument && !unterminatedDocument.quoted) {
    unquotedHereDocuments.push(unquotedDocumentLines.join('\n'));
  }
  return { source: output.join(''), unquotedHereDocuments };
}

function stripPowerShellComments(source: string): string {
  const characters = [...source];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (quote === "'") {
      if (character === "'" && characters[index + 1] === "'") index += 1;
      else if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '`') index += 1;
      else if (character === '"') quote = null;
      continue;
    }
    if (character === '`') {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === '<' && characters[index + 1] === '#') {
      let depth = 1;
      characters[index] = ' ';
      characters[index + 1] = ' ';
      index += 2;
      while (index < characters.length && depth > 0) {
        if (characters[index] === '<' && characters[index + 1] === '#') {
          depth += 1;
          characters[index] = ' ';
          characters[index + 1] = ' ';
          index += 2;
        } else if (characters[index] === '#' && characters[index + 1] === '>') {
          depth -= 1;
          characters[index] = ' ';
          characters[index + 1] = ' ';
          index += 2;
        } else {
          if (characters[index] !== '\n' && characters[index] !== '\r') {
            characters[index] = ' ';
          }
          index += 1;
        }
      }
      index -= 1;
      continue;
    }
    if (character === '#') {
      while (index < characters.length && characters[index] !== '\n') {
        characters[index] = ' ';
        index += 1;
      }
    }
  }
  return characters.join('');
}

function readPowerShellSubexpression(
  source: string,
  start: number,
): { body: string; end: number } | null {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let index = start + 2; index < source.length; index += 1) {
    const character = source[index];
    if (character === '`') {
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && source[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(start + 2, index), end: index };
      }
    }
  }
  return null;
}

function powerShellSubstitutions(source: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '`') {
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === "'" && source[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
        continue;
      }
    } else if (character === "'") {
      quote = "'";
      continue;
    } else if (character === '"') {
      quote = '"';
      continue;
    }
    if (source.startsWith('$(', index)) {
      const nested = readPowerShellSubexpression(source, index);
      if (nested) {
        substitutions.push(nested.body);
        index = nested.end;
      }
    }
  }
  return substitutions;
}

function shellSubstitutions(source: string): string[] {
  const substitutions: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = null;
        continue;
      }
      if (source.startsWith('$((', index)) {
        index += 1;
        continue;
      }
      if (source.startsWith('$(', index)) {
        const nested = readCommandSubstitution(source, index);
        if (nested) {
          substitutions.push(nested.body);
          index = nested.end;
        }
        continue;
      }
      if (character === '`') {
        const nested = readBacktickSubstitution(source, index);
        if (nested) {
          substitutions.push(nested.body);
          index = nested.end;
        }
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (source.startsWith('$((', index)) {
      index += 1;
      continue;
    }
    if (source.startsWith('$(', index)) {
      const nested = readCommandSubstitution(source, index);
      if (nested) {
        substitutions.push(nested.body);
        index = nested.end;
      }
      continue;
    }
    if (character === '`') {
      const nested = readBacktickSubstitution(source, index);
      if (nested) {
        substitutions.push(nested.body);
        index = nested.end;
      }
    }
  }
  return substitutions;
}

function hereDocumentSubstitutions(source: string): string[] {
  const substitutions: string[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (source.startsWith('$((', index)) {
      index += 2;
      continue;
    }
    if (source.startsWith('$(', index)) {
      const nested = readCommandSubstitution(source, index);
      if (nested) {
        substitutions.push(nested.body);
        index = nested.end;
      }
      continue;
    }
    if (character === '`') {
      const nested = readBacktickSubstitution(source, index);
      if (nested) {
        substitutions.push(nested.body);
        index = nested.end;
      }
    }
  }
  return substitutions;
}

function unwrapEnvCommand(
  command: string,
  args: readonly unknown[],
  baseEnv: NodeJS.ProcessEnv,
): {
  command: string;
  args: readonly unknown[];
  env: NodeJS.ProcessEnv;
} | null {
  if (executableBase(command) !== 'env') return null;
  const valueOptions = new Set(['-C', '--chdir', '--argv0']);
  const effectiveEnv = { ...baseEnv };
  const splitArguments = [...args];
  let index = 0;
  let optionsTerminated = false;
  const setValue = (name: string, value: string | undefined) => {
    const key =
      process.platform === 'win32'
        ? (Object.keys(effectiveEnv).find(
            (entry) => entry.toLowerCase() === name.toLowerCase(),
          ) ?? name)
        : name;
    if (value === undefined) delete effectiveEnv[key];
    else effectiveEnv[key] = value;
  };
  const resetPathIfMissing = () => {
    if (effectiveEnv.PATH === undefined && effectiveEnv.Path === undefined) {
      setValue('PATH', defaultExecutableSearchPath());
    }
  };
  while (index < splitArguments.length) {
    const argument = String(splitArguments[index]);
    if (argument === '--') {
      index += 1;
      optionsTerminated = true;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(argument);
    if (assignment) {
      setValue(assignment[1] ?? '', assignment[2] ?? '');
      index += 1;
      continue;
    }
    if (optionsTerminated) {
      return {
        command: argument,
        args: splitArguments.slice(index + 1),
        env: effectiveEnv,
      };
    }
    if (argument === '-i' || argument === '--ignore-environment') {
      for (const name of Object.keys(effectiveEnv)) delete effectiveEnv[name];
      setValue('PATH', defaultExecutableSearchPath());
      index += 1;
      continue;
    }
    if (argument === '-u' || argument === '--unset') {
      const name = String(splitArguments[index + 1] ?? '');
      setValue(name, undefined);
      index += 2;
      resetPathIfMissing();
      continue;
    }
    if (argument.startsWith('--unset=')) {
      const name = argument.slice('--unset='.length);
      setValue(name, undefined);
      index += 1;
      resetPathIfMissing();
      continue;
    }
    if (argument.startsWith('-u') && argument.length > 2) {
      setValue(argument.slice(2), undefined);
      index += 1;
      resetPathIfMissing();
      continue;
    }
    if (valueOptions.has(argument)) {
      index += 2;
      continue;
    }
    if (argument === '-S' || argument === '--split-string') {
      const split = splitEnvString(String(splitArguments[index + 1] ?? ''));
      splitArguments.splice(index, 2, ...split);
      continue;
    }
    if (argument.startsWith('--split-string=')) {
      splitArguments.splice(index, 1, ...splitEnvString(argument.slice(15)));
      continue;
    }
    if (argument.startsWith('-')) {
      if (
        [...valueOptions].some(
          (option) =>
            option.startsWith('--') && argument.startsWith(`${option}=`),
        ) ||
        [...valueOptions].some(
          (option) =>
            option.startsWith('-') &&
            !option.startsWith('--') &&
            argument.startsWith(option) &&
            argument.length > option.length,
        )
      ) {
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }
    return {
      command: argument,
      args: splitArguments.slice(index + 1),
      env: effectiveEnv,
    };
  }
  const target = splitArguments[index];
  return target === undefined
    ? null
    : {
        command: String(target),
        args: splitArguments.slice(index + 1),
        env: effectiveEnv,
      };
}

function splitEnvString(source: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  for (const character of source) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += character;
    started = true;
  }
  if (escaped) word += '\\';
  if (started) words.push(word);
  return words;
}

function unwrapEnvChain(
  command: string,
  args: readonly unknown[],
  baseEnv?: NodeJS.ProcessEnv,
): {
  command: string;
  args: readonly unknown[];
  env: NodeJS.ProcessEnv;
  wrapped: boolean;
  exhausted: boolean;
} {
  let currentCommand = command;
  let currentArgs = args;
  let currentEnv = { ...(baseEnv ?? process.env) };
  let wrapped = false;
  for (let depth = 0; depth < 8; depth += 1) {
    const unwrapped = unwrapEnvCommand(currentCommand, currentArgs, currentEnv);
    if (!unwrapped) break;
    currentCommand = unwrapped.command;
    currentArgs = unwrapped.args;
    currentEnv = unwrapped.env;
    wrapped = true;
  }
  const exhausted =
    wrapped &&
    executableBase(currentCommand) === 'env' &&
    unwrapEnvCommand(currentCommand, currentArgs, currentEnv) !== null;
  return {
    command: currentCommand,
    args: currentArgs,
    env: currentEnv,
    wrapped,
    exhausted,
  };
}

/** Find gh only where a shell parser would treat a token as a command. */
function shellContainsUnexpectedGh(
  source: string,
  env?: NodeJS.ProcessEnv,
  flavor: ShellFlavor = 'posix',
): boolean {
  const posixSource =
    flavor === 'posix'
      ? stripShellCommentsAndQuotedHereDocuments(
          stripShellLineContinuations(source),
        )
      : null;
  const parsedSource =
    posixSource?.source ??
    (flavor === 'powershell'
      ? stripPowerShellComments(source)
      : source.replace(/\$\([^)]*\)/gu, ' __literal_substitution__ '));
  const substitutions =
    flavor === 'posix'
      ? [
          ...shellSubstitutions(parsedSource),
          ...(posixSource?.unquotedHereDocuments.flatMap(
            hereDocumentSubstitutions,
          ) ?? []),
        ]
      : flavor === 'powershell'
        ? powerShellSubstitutions(parsedSource)
        : [];
  if (
    substitutions.some((substitution) =>
      shellContainsUnexpectedGh(substitution, env, flavor),
    )
  ) {
    return true;
  }
  const tokens =
    parsedSource.match(
      /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;&|(){}\n]|[^\s;&|(){}\n]+/gu,
    ) ?? [];
  let commandPosition = true;
  let wrapper: string | null = null;
  let skipWrapperArgument = false;
  let envOption: 'unset' | 'split' | null = null;
  let effectiveEnv = { ...(env ?? process.env) };
  for (const token of tokens) {
    if (/^[;&|(){}\n]$/u.test(token) || token === '&&' || token === '||') {
      commandPosition = true;
      wrapper = null;
      skipWrapperArgument = false;
      envOption = null;
      effectiveEnv = { ...(env ?? process.env) };
      continue;
    }
    if (!commandPosition) continue;
    const word = token.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
    if (wrapper === 'env' && envOption === 'unset') {
      const key =
        process.platform === 'win32'
          ? (Object.keys(effectiveEnv).find(
              (entry) => entry.toLowerCase() === word.toLowerCase(),
            ) ?? word)
          : word;
      delete effectiveEnv[key];
      if (
        word.toLowerCase() === 'path' &&
        effectiveEnv.PATH === undefined &&
        effectiveEnv.Path === undefined
      ) {
        effectiveEnv.PATH = defaultExecutableSearchPath();
      }
      envOption = null;
      continue;
    }
    if (wrapper === 'env' && envOption === 'split') {
      const split = splitEnvString(word);
      if (
        split[0] &&
        argvContainsUnexpectedGh(split[0], split.slice(1), effectiveEnv)
      ) {
        return true;
      }
      envOption = null;
      commandPosition = false;
      wrapper = null;
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word);
    if (assignment) {
      if (wrapper === 'env') {
        const key =
          process.platform === 'win32'
            ? (Object.keys(effectiveEnv).find(
                (entry) => entry.toLowerCase() === assignment[1]?.toLowerCase(),
              ) ?? assignment[1])
            : assignment[1];
        if (key) effectiveEnv[key] = assignment[2] ?? '';
      }
      continue;
    }
    if (wrapper === 'env' && skipWrapperArgument) {
      skipWrapperArgument = false;
      continue;
    }
    if (
      wrapper === 'env' &&
      (word === '-i' || word === '--ignore-environment')
    ) {
      for (const key of Object.keys(effectiveEnv)) delete effectiveEnv[key];
      effectiveEnv.PATH = defaultExecutableSearchPath();
      continue;
    }
    if (wrapper === 'env' && (word === '-u' || word === '--unset')) {
      envOption = 'unset';
      continue;
    }
    if (wrapper === 'env' && word.startsWith('--unset=')) {
      const key = word.slice('--unset='.length);
      delete effectiveEnv[key];
      continue;
    }
    if (wrapper === 'env' && word.startsWith('-u') && word.length > 2) {
      delete effectiveEnv[word.slice(2)];
      continue;
    }
    if (wrapper === 'env' && (word === '-S' || word === '--split-string')) {
      envOption = 'split';
      continue;
    }
    if (wrapper === 'env' && word.startsWith('--split-string=')) {
      const split = splitEnvString(word.slice('--split-string='.length));
      if (
        split[0] &&
        argvContainsUnexpectedGh(split[0], split.slice(1), effectiveEnv)
      ) {
        return true;
      }
      commandPosition = false;
      wrapper = null;
      continue;
    }
    if (wrapper === 'env' && word.startsWith('-')) {
      skipWrapperArgument = ['-C', '--chdir', '--argv0'].includes(word);
      continue;
    }
    const base = executableBase(word);
    if (['command', 'exec', 'env', 'nohup', 'sudo', 'time'].includes(base)) {
      wrapper = base;
      continue;
    }
    if (['if', 'then', 'else', 'elif', 'while', 'until', 'do'].includes(word)) {
      continue;
    }
    commandPosition = false;
    wrapper = null;
    if (isGhExecutable(word) && !isRegisteredFixture(word, effectiveEnv)) {
      return true;
    }
  }
  return false;
}

function argvContainsUnexpectedGh(
  command: string,
  args: readonly unknown[],
  env?: NodeJS.ProcessEnv,
): boolean {
  const unwrapped = unwrapEnvChain(command, args, env);
  if (isGhExecutable(unwrapped.command)) {
    return !isRegisteredFixture(unwrapped.command, unwrapped.env);
  }
  const shell = shellPayload(unwrapped.command, unwrapped.args);
  return (
    shell !== null &&
    shellContainsUnexpectedGh(
      shell,
      unwrapped.env,
      shellFlavor(unwrapped.command),
    )
  );
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
  let attemptedGhExecutable: string | null = null;
  if (isGhExecutable(command)) {
    attemptedGhExecutable = command;
    const registeredFixture = isRegisteredFixture(command, env);
    if (registeredFixture && options?.shell) {
      const shellCommand = shellPayload(command, args, options);
      unexpected =
        shellCommand !== null &&
        shellContainsUnexpectedGh(
          shellCommand,
          env,
          shellFlavorForLaunch(command, options),
        );
      if (unexpected) executable = 'gh in shell command';
    } else {
      unexpected = !registeredFixture;
    }
  } else {
    const unwrapped = unwrapEnvChain(command, args, env);
    if (unwrapped.exhausted) {
      unexpected = true;
      executable = 'env wrapper with unresolved command';
    } else if (unwrapped.wrapped && isGhExecutable(unwrapped.command)) {
      attemptedGhExecutable = unwrapped.command;
      unexpected = !isRegisteredFixture(unwrapped.command, unwrapped.env);
      if (unexpected) executable = `${executableBase(command)} wrapper for gh`;
    } else if (unwrapped.wrapped) {
      const wrappedShell = shellPayload(unwrapped.command, unwrapped.args);
      if (wrappedShell !== null) {
        unexpected = shellContainsUnexpectedGh(
          wrappedShell,
          unwrapped.env,
          shellFlavor(unwrapped.command),
        );
        if (unexpected) executable = 'gh in shell command';
      }
    }
    if (!unexpected && !attemptedGhExecutable) {
      const shellCommand = shellPayload(command, args, options);
      if (shellCommand !== null) {
        unexpected = shellContainsUnexpectedGh(
          shellCommand,
          env,
          shellFlavorForLaunch(command, options),
        );
        if (unexpected) executable = 'gh in shell command';
      }
    }
  }
  if (!unexpected) return;

  const { ledger } = ensureLedger();
  const resolvedExecutable =
    executable !== 'gh in shell command' && attemptedGhExecutable !== null
      ? resolveGhPath(
          attemptedGhExecutable,
          unwrapEnvChain(command, args, env).env,
        )
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
        : safeInvocationArguments(command, args),
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
    const requireFlag = `--require "${normalizedWorkerBridgePath}"`;
    env.NODE_OPTIONS =
      current.includes(normalizedWorkerBridgePath) ||
      current.includes(workerBridgePath)
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
      const hasCallback =
        ['exec', 'execFile'].includes(method) &&
        typeof args[index] === 'function';
      const options = hasCallback
        ? undefined
        : (args[index] as LaunchOptions | undefined);
      const directGhFixture =
        ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method) &&
        isGhExecutable(String(args[0])) &&
        isRegisteredFixture(String(args[0]), options?.env);
      const guardedOptions = optionsWithGuard(
        hasCallback ? undefined : args[index],
        directGhFixture,
      );
      if (hasCallback) args.splice(index, 0, guardedOptions);
      else args[index] = guardedOptions;
    }
    return Reflect.apply(
      original as (...args: unknown[]) => unknown,
      this,
      args,
    );
  };
  Object.setPrototypeOf(wrapped, original);
  if (['exec', 'execFile'].includes(method)) {
    Object.defineProperty(wrapped, promisify.custom, {
      configurable: true,
      value: function (this: unknown, ...args: unknown[]) {
        let child: unknown;
        const result = new Promise<{ stdout: unknown; stderr: unknown }>(
          (resolve, reject) => {
            const callback = (
              error: NodeJS.ErrnoException | null,
              stdout: unknown,
              stderr: unknown,
            ) => {
              if (error) {
                Object.assign(error, { stdout, stderr });
                reject(error);
              } else {
                resolve({ stdout, stderr });
              }
            };
            child = Reflect.apply(wrapped, this, [...args, callback]);
          },
        ) as Promise<{ stdout: unknown; stderr: unknown }> & {
          child?: unknown;
        };
        result.child = child;
        return result;
      },
    });
  }
  childProcessApi[method] = wrapped;
}

const optionsFromArgs = (argsOrOptions: unknown, options: unknown): unknown =>
  Array.isArray(argsOrOptions) ||
  argsOrOptions === null ||
  argsOrOptions === undefined
    ? options
    : argsOrOptions;
const optionsAfterArgs = (args: unknown[]): number =>
  Array.isArray(args[1]) ||
  ((args[1] === null || args[1] === undefined) && args.length > 2)
    ? 2
    : 1;
wrap(
  'spawn',
  (command, argsOrOptions, options) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    inspectInvocation(
      'spawn',
      command,
      args,
      optionsFromArgs(argsOrOptions, options),
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
      optionsFromArgs(argsOrOptions, options),
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
      optionsFromArgs(argsOrOptions, options),
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
      optionsFromArgs(argsOrOptions, options),
    );
  },
  optionsAfterArgs,
);
wrap(
  'fork',
  (modulePath, argsOrOptions, options) => {
    const forkOptions = optionsFromArgs(argsOrOptions, options);
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
    const env =
      options.env === workerThreads.SHARE_ENV
        ? workerThreads.SHARE_ENV
        : ({ ...(options.env ?? process.env) } as NodeJS.ProcessEnv);
    if (env !== workerThreads.SHARE_ENV) {
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
    }
    const execArgv = [...(options.execArgv ?? process.execArgv)];
    const hasBridgePreload = execArgv.some(
      (argument, index) =>
        argument === `--import=${workerBridgeUrl}` ||
        (argument === '--import' && execArgv[index + 1] === workerBridgeUrl) ||
        argument === `--require=${workerBridgePath}` ||
        (argument === '--require' && execArgv[index + 1] === workerBridgePath),
    );
    if (options.eval !== true && !hasBridgePreload) {
      execArgv.push(`--import=${workerBridgeUrl}`);
    }
    const source =
      options.eval === true
        ? `;(() => {\n  const Module = require('node:module');\n  Module._load(${JSON.stringify(workerBridgePath)}, null, false);\n})();\n${String(filename)}`
        : filename;
    super(source, {
      ...options,
      eval: options.eval === true,
      execArgv,
      env,
    });
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
