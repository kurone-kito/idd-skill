'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const moduleApi = require('node:module');
const path = require('node:path');
const { promisify } = require('node:util');
const { threadId } = require('node:worker_threads');

function isGh(value) {
  return (
    path
      .basename(String(value).replace(/^['"]|['"]$/gu, ''))
      .replace(/\.exe$/iu, '')
      .toLowerCase() === 'gh'
  );
}

function isEnv(value) {
  return (
    path
      .basename(String(value).replace(/^['"]|['"]$/gu, ''))
      .replace(/\.exe$/iu, '')
      .toLowerCase() === 'env'
  );
}

function defaultExecutableSearchPath() {
  if (process.platform !== 'win32') return '/bin:/usr/bin';
  const windowsRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return [path.join(windowsRoot, 'System32'), windowsRoot].join(path.delimiter);
}

function resolvedGh(value, env) {
  const command = String(value).replace(/^['"]|['"]$/gu, '');
  if (command.includes('/') || command.includes('\\')) {
    return path.resolve(command);
  }
  const pathValue =
    env === undefined
      ? (process.env.PATH ?? process.env.Path ?? '')
      : (env.PATH ?? env.Path ?? defaultExecutableSearchPath());
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of process.platform === 'win32'
      ? ['', '.exe']
      : ['']) {
      const candidate = path.resolve(
        directory || '.',
        `${command}${extension}`,
      );
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Continue searching the inherited PATH.
      }
    }
  }
  return null;
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
  const resolved = resolvedGh(value, env);
  return resolved !== null && fixturePaths().has(normalizedPath(resolved));
}

function shellPayload(command, args, options) {
  const base = path
    .basename(String(command))
    .replace(/\.exe$/iu, '')
    .toLowerCase();
  if (
    ['sh', 'bash', 'dash', 'zsh', 'ksh', 'cmd', 'powershell', 'pwsh'].includes(
      base,
    )
  ) {
    const isPosixShell = ['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(base);
    for (let index = 0; index < args.length; index += 1) {
      const argument = String(args[index]).toLowerCase();
      if (
        ['-c', '/c', '-command'].includes(argument) ||
        (isPosixShell && /^-[a-z]*c$/u.test(argument))
      ) {
        return args
          .slice(index + 1)
          .map(String)
          .join(' ');
      }
      if (argument.startsWith('-command:')) {
        return argument.slice(argument.indexOf(':') + 1);
      }
    }
  }
  return options?.shell ? [command, ...args].map(String).join(' ') : null;
}

function readBacktickSubstitution(source, start) {
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

function readCommandSubstitution(source, start) {
  let depth = 1;
  let quote = null;
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

function shellSubstitutions(source) {
  const substitutions = [];
  let quote = null;
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

function hereDocumentSubstitutions(source) {
  const substitutions = [];
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

function splitEnvString(source) {
  const words = [];
  let word = '';
  let quote = null;
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

function unwrapEnvCommand(command, args, baseEnv) {
  if (
    path
      .basename(String(command).replace(/^['"]|['"]$/gu, ''))
      .replace(/\.exe$/iu, '')
      .toLowerCase() !== 'env'
  ) {
    return null;
  }
  const valueOptions = new Set(['-C', '--chdir', '--argv0']);
  const effectiveEnv = { ...baseEnv };
  const splitArguments = [...args];
  let index = 0;
  let optionsTerminated = false;
  const setValue = (name, value) => {
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
      setValue(assignment[1], assignment[2] ?? '');
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
      setValue(String(splitArguments[index + 1] ?? ''), undefined);
      index += 2;
      resetPathIfMissing();
      continue;
    }
    if (argument.startsWith('--unset=')) {
      setValue(argument.slice('--unset='.length), undefined);
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
      splitArguments.splice(
        index,
        2,
        ...splitEnvString(String(splitArguments[index + 1] ?? '')),
      );
      continue;
    }
    if (argument.startsWith('--split-string=')) {
      splitArguments.splice(index, 1, ...splitEnvString(argument.slice(15)));
      continue;
    }
    if (argument.startsWith('-')) {
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

function unwrapEnvChain(command, args, baseEnv) {
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
    isEnv(currentCommand) &&
    unwrapEnvCommand(currentCommand, currentArgs, currentEnv) !== null;
  return {
    command: currentCommand,
    args: currentArgs,
    env: currentEnv,
    wrapped,
    exhausted,
  };
}

function shellFlavor(command) {
  const base = path
    .basename(String(command).replace(/^['"]|['"]$/gu, ''))
    .replace(/\.exe$/iu, '')
    .toLowerCase();
  if (['sh', 'bash', 'dash', 'zsh', 'ksh'].includes(base)) return 'posix';
  if (['powershell', 'pwsh'].includes(base)) return 'powershell';
  return 'other';
}

function shellFlavorForLaunch(command, options) {
  if (options?.shell) {
    return typeof options.shell === 'string'
      ? shellFlavor(options.shell)
      : process.platform === 'win32'
        ? 'other'
        : 'posix';
  }
  return shellFlavor(command);
}

function stripShellLineContinuations(source) {
  let result = '';
  let quote = null;
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

function readHereDocument(source, start) {
  if (!source.startsWith('<<', start) || source[start + 2] === '<') {
    return null;
  }
  let index = start + 2;
  const stripTabs = source[index] === '-';
  if (stripTabs) index += 1;
  while (source[index] === ' ' || source[index] === '\t') index += 1;
  let delimiter = '';
  let quote = null;
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

function blankLine(source) {
  return source.replace(/[^\r\n]/gu, ' ');
}

function stripShellCommentsAndQuotedHereDocuments(source) {
  const output = [];
  const unquotedHereDocuments = [];
  let pending = [];
  let unquotedDocumentLines = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/\r?\n$/u, '');
    const ending = lineWithEnding.slice(line.length);
    if (pending.length > 0) {
      const document = pending[0];
      const comparable = document.stripTabs ? line.replace(/^\t+/u, '') : line;
      const isDelimiter = comparable === document.delimiter;
      if (!isDelimiter && !document.quoted) unquotedDocumentLines.push(line);
      output.push(blankLine(line), ending);
      if (isDelimiter) {
        if (!document.quoted) {
          unquotedHereDocuments.push(unquotedDocumentLines.join('\n'));
        }
        unquotedDocumentLines = [];
        pending = pending.slice(1);
      }
      continue;
    }

    const characters = [...line];
    let quote = null;
    const found = [];
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
      if (
        character === '#' &&
        (index === 0 || /[\s;&|(){}]/u.test(characters[index - 1] ?? ''))
      ) {
        for (let rest = index; rest < characters.length; rest += 1) {
          characters[rest] = ' ';
        }
        break;
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

function stripPowerShellComments(source) {
  const characters = [...source];
  let quote = null;
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

function readPowerShellSubexpression(source, start) {
  let depth = 1;
  let quote = null;
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

function powerShellSubstitutions(source) {
  const substitutions = [];
  let quote = null;
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

function shellGhCommand(command, env, flavor = 'posix') {
  const posixSource =
    flavor === 'posix'
      ? stripShellCommentsAndQuotedHereDocuments(
          stripShellLineContinuations(String(command)),
        )
      : null;
  const parsedSource =
    posixSource?.source ??
    (flavor === 'powershell'
      ? stripPowerShellComments(String(command))
      : String(command).replace(/\$\([^)]*\)/gu, ' __literal_substitution__ '));
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
  for (const substitution of substitutions) {
    const nested = shellGhCommand(substitution, env, flavor);
    if (nested) return nested;
  }
  const tokens =
    parsedSource.match(
      /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||(?:[0-9]+)?(?:<<<|<<-|>>|<<|<>|>&|<&|[<>])|[;&|(){}\n]|[^\s;&|(){}<>\n]+/gu,
    ) ?? [];
  let commandPosition = true;
  let wrapper = null;
  let skipWrapperArgument = false;
  let skipRedirectionTarget = false;
  let envOption = null;
  let effectiveEnv = { ...(env ?? process.env) };
  for (const token of tokens) {
    if (/^[;&|(){}\n]$/u.test(token) || token === '&&' || token === '||') {
      commandPosition = true;
      wrapper = null;
      skipWrapperArgument = false;
      skipRedirectionTarget = false;
      envOption = null;
      effectiveEnv = { ...(env ?? process.env) };
      continue;
    }
    if (!commandPosition) continue;
    const word = token.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
    if (skipRedirectionTarget) {
      skipRedirectionTarget = false;
      continue;
    }
    if (/^(?:[0-9]+)?(?:<<<|<<-|>>|<<|<>|>&|<&|[<>])$/u.test(token)) {
      skipRedirectionTarget = true;
      continue;
    }
    if (wrapper === 'env' && envOption === 'unset') {
      delete effectiveEnv[word];
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
      if (split[0]) {
        const nested = argvGhCommand(split[0], split.slice(1), effectiveEnv);
        if (nested) return nested;
      }
      envOption = null;
      commandPosition = false;
      wrapper = null;
      continue;
    }
    if (skipWrapperArgument) {
      skipWrapperArgument = false;
      continue;
    }
    if (wrapper === 'command-lookup') {
      commandPosition = false;
      wrapper = null;
      continue;
    }
    if (word === '!') continue;
    if (wrapper === 'command' && (word === '-v' || word === '-V')) {
      wrapper = 'command-lookup';
      continue;
    }
    if (wrapper === 'command' || wrapper === 'exec') {
      if (word === '--') continue;
      if (word.startsWith('-')) {
        skipWrapperArgument = wrapper === 'exec' && word === '-a';
        continue;
      }
    }
    if (wrapper === 'sudo') {
      if (word === '--') continue;
      if (word.startsWith('--') && word.includes('=')) continue;
      if (word.startsWith('-')) {
        skipWrapperArgument = [
          '-C',
          '-D',
          '-g',
          '-h',
          '-p',
          '-R',
          '-r',
          '-t',
          '-T',
          '-U',
          '-u',
          '--chdir',
          '--close-from',
          '--command-timeout',
          '--group',
          '--host',
          '--other-user',
          '--prompt',
          '--role',
          '--type',
          '--user',
        ].includes(word);
        continue;
      }
    }
    if (wrapper === 'time') {
      if (word === '--') continue;
      if (
        word === '-f' ||
        word === '-o' ||
        word === '--format' ||
        word === '--output'
      ) {
        skipWrapperArgument = true;
        continue;
      }
      if (word.startsWith('--format=') || word.startsWith('--output=')) {
        continue;
      }
      if (word.startsWith('-')) continue;
    }
    if (wrapper === 'nohup' && (word === '--' || word.startsWith('-'))) {
      continue;
    }
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(word);
    if (assignment) {
      const key =
        process.platform === 'win32'
          ? (Object.keys(effectiveEnv).find(
              (entry) => entry.toLowerCase() === assignment[1].toLowerCase(),
            ) ?? assignment[1])
          : assignment[1];
      effectiveEnv[key] = assignment[2] ?? '';
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
      delete effectiveEnv[word.slice('--unset='.length)];
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
      if (split[0]) {
        const nested = argvGhCommand(split[0], split.slice(1), effectiveEnv);
        if (nested) return nested;
      }
      commandPosition = false;
      wrapper = null;
      continue;
    }
    if (wrapper === 'env' && word.startsWith('-')) {
      skipWrapperArgument = ['-C', '--chdir', '--argv0'].includes(word);
      continue;
    }
    const base = path
      .basename(word.replace(/^['"]|['"]$/gu, ''))
      .replace(/\.exe$/iu, '')
      .toLowerCase();
    if (['command', 'exec', 'env', 'nohup', 'sudo', 'time'].includes(base)) {
      wrapper = base;
      continue;
    }
    if (['if', 'then', 'else', 'elif', 'while', 'until', 'do'].includes(word)) {
      continue;
    }
    commandPosition = false;
    wrapper = null;
    if (isGh(word) && !isRegisteredFixture(word, effectiveEnv)) return word;
  }
  return null;
}

function argvGhCommand(command, args, env) {
  const unwrapped = unwrapEnvChain(command, args, env);
  if (isGh(unwrapped.command)) {
    return isRegisteredFixture(unwrapped.command, unwrapped.env)
      ? null
      : unwrapped.command;
  }
  const shell = shellPayload(unwrapped.command, unwrapped.args);
  return shell === null
    ? null
    : shellGhCommand(shell, unwrapped.env, shellFlavor(unwrapped.command));
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
    const environmentAssignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(
      argument,
    );
    if (environmentAssignment) {
      values.push(`${environmentAssignment[1]}=[redacted]`);
      continue;
    }
    const optionAndValue = /^(--?[A-Za-z0-9-]+)=(.*)$/u.exec(argument);
    if (optionAndValue) {
      const [, option, optionValue] = optionAndValue;
      const sensitiveOption =
        /^--?(?:token|password|secret|authorization|auth-token|access-token|client-secret)$/iu.test(
          option ?? '',
        );
      values.push(
        `${option}=${sensitiveOption || /(?:gh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+|\b[A-Za-z_][A-Za-z0-9_]*(?:token|password|secret|authorization|key)=\S+)/iu.test(optionValue ?? '') ? '[redacted]' : '[value]'}`,
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
      /(?:gh(?:p|o|u|s|r)_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|Bearer\s+\S+|\b[A-Za-z_][A-Za-z0-9_]*(?:token|password|secret|authorization|key)=\S+)/iu.test(
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

function safeInvocationArgs(command, args) {
  if (!isEnv(command)) return safeArgs(args);
  const sanitized = [];
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
  return safeArgs(sanitized);
}

function blockIfGh(api, command, args, options) {
  let ghCommand = null;
  let direct = false;
  let wrappedExecutable = null;
  let shellInvocation = false;
  let unresolvedEnvChain = false;
  if (isGh(command)) {
    if (isRegisteredFixture(command, options?.env)) {
      const shell = shellPayload(command, args, options);
      if (shell === null) return;
      shellInvocation = true;
      ghCommand = shellGhCommand(
        shell,
        options?.env,
        shellFlavorForLaunch(command, options),
      );
    } else {
      ghCommand = String(command);
      direct = true;
    }
  } else {
    const unwrapped = unwrapEnvChain(command, args, options?.env);
    if (unwrapped.exhausted) {
      unresolvedEnvChain = true;
      shellInvocation = true;
      ghCommand = 'gh in unresolved env wrapper';
    } else if (unwrapped.wrapped && isGh(unwrapped.command)) {
      if (isRegisteredFixture(unwrapped.command, unwrapped.env)) return;
      ghCommand = unwrapped.command;
      wrappedExecutable = unwrapped.command;
    } else if (unwrapped.wrapped) {
      const wrappedShell = shellPayload(unwrapped.command, unwrapped.args);
      if (wrappedShell !== null) {
        shellInvocation = true;
        ghCommand = shellGhCommand(
          wrappedShell,
          unwrapped.env,
          shellFlavor(unwrapped.command),
        );
      }
    }
    if (!ghCommand && !wrappedExecutable) {
      const shell = shellPayload(command, args, options);
      if (shell !== null) {
        shellInvocation = true;
        ghCommand = shellGhCommand(
          shell,
          options?.env,
          shellFlavorForLaunch(command, options),
        );
      }
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
  const resolved =
    unresolvedEnvChain || shellInvocation
      ? null
      : direct
        ? resolvedGh(command, env)
        : resolvedGh(
            wrappedExecutable ?? ghCommand,
            unwrapEnvChain(command, args, env).env,
          );
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
    executable: direct
      ? String(command)
      : unresolvedEnvChain
        ? 'env wrapper with unresolved command'
        : wrappedExecutable
          ? 'env wrapper for gh'
          : 'gh in shell command',
    resolvedExecutable: resolved,
    args:
      !direct &&
      (shellInvocation ||
        (wrappedExecutable === null &&
          shellPayload(command, args, options) !== null))
        ? ['[shell command omitted]']
        : safeInvocationArgs(command, args),
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
  if (!hasOptions) options = {};
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
    const normalizedFilename = __filename.replaceAll('\\', '/');
    const requireFlag = `--require "${normalizedFilename}"`;
    env.NODE_OPTIONS =
      current.includes(normalizedFilename) || current.includes(__filename)
        ? current
        : current
          ? `${current} ${requireFlag}`
          : requireFlag;
  }
  return { ...record, env };
}

function wrap(method, optionsIndex, inspect) {
  const original = childProcess[method];
  const wrapped = function (...args) {
    inspect(...args);
    const index = optionsIndex(args);
    if (index >= 0) {
      const hasCallback =
        ['exec', 'execFile'].includes(method) &&
        typeof args[index] === 'function';
      const launchOptions = hasCallback ? undefined : args[index];
      const directGhFixture =
        ['spawn', 'spawnSync', 'execFile', 'execFileSync'].includes(method) &&
        isGh(args[0]) &&
        isRegisteredFixture(args[0], launchOptions?.env);
      const guardedOptions = addGuardToOptions(
        hasCallback ? undefined : args[index],
        !directGhFixture,
      );
      if (hasCallback) args.splice(index, 0, guardedOptions);
      else args[index] = guardedOptions;
    }
    return Reflect.apply(original, this, args);
  };
  Object.setPrototypeOf(wrapped, original);
  if (['exec', 'execFile'].includes(method)) {
    Object.defineProperty(wrapped, promisify.custom, {
      configurable: true,
      value: function (...args) {
        let child;
        const result = new Promise((resolve, reject) => {
          const callback = (error, stdout, stderr) => {
            if (error) {
              Object.assign(error, { stdout, stderr });
              reject(error);
            } else {
              resolve({ stdout, stderr });
            }
          };
          child = wrapped.apply(this, [...args, callback]);
        });
        result.child = child;
        return result;
      },
    });
  }
  childProcess[method] = wrapped;
}

const optionsFromArgs = (argsOrOptions, options) =>
  Array.isArray(argsOrOptions) ||
  argsOrOptions === null ||
  argsOrOptions === undefined
    ? options
    : argsOrOptions;
const optionsAfterArgs = (args) =>
  Array.isArray(args[1]) ||
  ((args[1] === null || args[1] === undefined) && args.length > 2)
    ? 2
    : 1;
wrap('spawn', optionsAfterArgs, (command, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh('spawn', command, args, optionsFromArgs(argsOrOptions, options));
});
wrap('spawnSync', optionsAfterArgs, (command, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'spawnSync',
    command,
    args,
    optionsFromArgs(argsOrOptions, options),
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
  blockIfGh('execFile', file, args, optionsFromArgs(argsOrOptions, options));
});
wrap('execFileSync', optionsAfterArgs, (file, argsOrOptions, options) => {
  const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
  blockIfGh(
    'execFileSync',
    file,
    args,
    optionsFromArgs(argsOrOptions, options),
  );
});
wrap('fork', optionsAfterArgs, (modulePath, argsOrOptions, options) => {
  const forkOptions = optionsFromArgs(argsOrOptions, options);
  blockIfGh(
    'fork',
    forkOptions?.execPath ?? process.execPath,
    [modulePath],
    forkOptions,
  );
});
moduleApi.syncBuiltinESMExports();
