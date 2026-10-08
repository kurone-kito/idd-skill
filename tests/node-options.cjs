'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');

function tokenizeNodeOptions(source) {
  const tokens = [];
  let token = '';
  let quoted = false;
  let active = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted && character === '\\' && index + 1 < source.length) {
      const next = source[index + 1];
      if (next === '"' || next === '\\') {
        token += next;
        index += 1;
        active = true;
        continue;
      }
    }
    if (character === '"') {
      quoted = !quoted;
      active = true;
      continue;
    }
    if (!quoted && /\s/u.test(character)) {
      if (active) tokens.push(token);
      token = '';
      active = false;
      continue;
    }
    token += character;
    active = true;
  }
  if (active) tokens.push(token);
  return tokens;
}

function quoteNodeOption(token) {
  return /[\s"]/u.test(token)
    ? `"${token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : token;
}

function serializeNodeOptions(tokens) {
  return tokens.map(quoteNodeOption).join(' ');
}

function isRelativePath(value) {
  return /^\.{1,2}(?:[\\/]|$)/u.test(value);
}

function normalizeImportSpecifier(value, cwd) {
  if (!isRelativePath(value)) return value;
  return pathToFileURL(path.resolve(cwd, value)).href;
}

function normalizeNodeOptionsImports(source, cwd) {
  const tokens = tokenizeNodeOptions(source);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--import') {
      const value = tokens[index + 1];
      if (value !== undefined) {
        tokens[index + 1] = normalizeImportSpecifier(value, cwd);
      }
      index += 1;
    } else if (token.startsWith('--import=')) {
      tokens[index] = `--import=${normalizeImportSpecifier(
        token.slice('--import='.length),
        cwd,
      )}`;
    }
  }
  return serializeNodeOptions(tokens);
}

function optionValue(tokens, index, flag) {
  const token = tokens[index];
  if (token === flag) {
    return tokens[index + 1] === undefined
      ? null
      : { value: tokens[index + 1], end: index + 1, start: index };
  }
  if (typeof token === 'string' && token.startsWith(`${flag}=`)) {
    return {
      value: token.slice(flag.length + 1),
      end: index,
      start: index,
    };
  }
  return null;
}

function resolvedPreload(value, cwd) {
  try {
    if (value.startsWith('file:')) return path.resolve(fileURLToPath(value));
    if (path.isAbsolute(value)) return path.resolve(value);
    if (isRelativePath(value)) return path.resolve(cwd, value);
  } catch {
    return null;
  }
  return null;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function hasNodeOptionsPreload(source, expected, cwd, flags) {
  const tokens = Array.isArray(source) ? source : tokenizeNodeOptions(source);
  const expectedPath = resolvedPreload(expected, cwd);
  if (expectedPath === null) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    for (const flag of flags) {
      const entry = optionValue(tokens, index, flag);
      if (entry === null) continue;
      const candidate = resolvedPreload(entry.value, cwd);
      if (
        candidate !== null &&
        normalizedPath(candidate) === normalizedPath(expectedPath)
      ) {
        return true;
      }
      if (entry.end > index) index = entry.end;
      break;
    }
  }
  return false;
}

function removeNodeOptionsPreload(source, expected, cwd, flags) {
  const tokens = tokenizeNodeOptions(source);
  const expectedPath = resolvedPreload(expected, cwd);
  if (expectedPath === null) return serializeNodeOptions(tokens);
  for (let index = 0; index < tokens.length; ) {
    let removed = false;
    for (const flag of flags) {
      const entry = optionValue(tokens, index, flag);
      if (entry === null) continue;
      const candidate = resolvedPreload(entry.value, cwd);
      if (
        candidate !== null &&
        normalizedPath(candidate) === normalizedPath(expectedPath)
      ) {
        tokens.splice(entry.start, entry.end - entry.start + 1);
        removed = true;
      }
      break;
    }
    if (!removed) index += 1;
  }
  return serializeNodeOptions(tokens);
}

function appendNodeOptionsPreload(
  source,
  flag,
  value,
  cwd,
  knownFlags = [flag],
) {
  const normalized = normalizeNodeOptionsImports(source, cwd);
  if (hasNodeOptionsPreload(normalized, value, cwd, knownFlags)) {
    return normalized;
  }
  return serializeNodeOptions([
    ...tokenizeNodeOptions(normalized),
    flag,
    value,
  ]);
}

module.exports = {
  appendNodeOptionsPreload,
  hasNodeOptionsPreload,
  normalizeNodeOptionsImports,
  removeNodeOptionsPreload,
  serializeNodeOptions,
  tokenizeNodeOptions,
};
