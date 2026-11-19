// idd-generated-from: src/scripts/windows-nofollow.mts
//
// The scripts/windows-nofollow.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Cross-platform no-follow open primitive (issue #5287 / roadmap #5285).
// POSIX uses O_RDONLY|O_NOFOLLOW|O_NONBLOCK (and O_CREAT|O_EXCL|O_NOFOLLOW for
// exclusive create). Windows, where those constants are undefined, calls the
// sibling System32 PowerShell script with the script path and target path as
// process arguments (decision-windows-nofollow-binding). Missing flags are
// never replaced with zero.
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { isAbsolute, join, normalize, dirname as pathDirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = pathDirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = 'windows-nofollow.ps1';
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function assertAbsoluteNormalized(path) {
  if (!isAbsolute(path)) {
    throw new Error(`path must be absolute: ${path}`);
  }
  if (normalize(path) !== path) {
    throw new Error(
      `${path} is not in normalized form (it has '.', '..', or a repeated separator); refusing it`,
    );
  }
}
function resolveScriptPath(deps) {
  if (deps.scriptPath !== undefined) return deps.scriptPath;
  const candidates = [
    join(HERE, SCRIPT_NAME),
    join(HERE, '..', 'src', 'scripts', SCRIPT_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall through to the first candidate so the Windows helper surfaces a
  // clear "cannot find script" refusal rather than a generic open error.
  return candidates[0] ?? join(HERE, SCRIPT_NAME);
}
function system32(env) {
  const root = [env.SystemRoot, env.windir].find(
    (candidate) => candidate !== undefined && isAbsolute(candidate),
  );
  return join(root ?? 'C:\\Windows', 'System32');
}
function requirePosixFlags(constants) {
  const noFollow = constants.O_NOFOLLOW;
  const nonBlock = constants.O_NONBLOCK;
  const oRdonly = constants.O_RDONLY;
  const oWronly = constants.O_WRONLY;
  const oCreat = constants.O_CREAT;
  const oExcl = constants.O_EXCL;
  // Never coerce a missing flag with `|| 0` / `?? 0` (issue #3891 / #3934).
  if (
    noFollow === undefined ||
    nonBlock === undefined ||
    oRdonly === undefined ||
    oWronly === undefined ||
    oCreat === undefined ||
    oExcl === undefined
  ) {
    throw new Error(
      'this platform does not support the no-follow and nonblocking opens required for this helper; refusing before any mutation',
    );
  }
  return { noFollow, nonBlock, oRdonly, oWronly, oCreat, oExcl };
}
function parseHelperOutput(stdout) {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new Error('windows no-follow helper returned empty output');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `windows no-follow helper returned non-JSON output: ${describe(error)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ok' in parsed) ||
    typeof parsed.ok !== 'boolean'
  ) {
    throw new Error('windows no-follow helper returned a malformed result');
  }
  return parsed;
}
function runWindowsHelper(mode, paths, deps, input) {
  const env = deps.env ?? process.env;
  const exec = deps.execFile ?? execFileSync;
  const scriptPath = resolveScriptPath(deps);
  const powershell = join(
    system32(env),
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    mode,
    ...paths,
  ];
  let stdout;
  try {
    stdout = exec(powershell, args, {
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: PROCESS_MAX_BUFFER,
      stdio:
        input === undefined
          ? ['ignore', 'pipe', 'pipe']
          : ['pipe', 'pipe', 'pipe'],
      input,
      env,
    });
  } catch (error) {
    const withStdout = error;
    if (
      typeof withStdout.stdout === 'string' &&
      withStdout.stdout.trim() !== ''
    ) {
      return parseHelperOutput(withStdout.stdout);
    }
    throw new Error(
      `windows no-follow helper failed: ${withStdout.message ?? describe(error)}`,
    );
  }
  return parseHelperOutput(stdout);
}
function refuseUnlessOk(result) {
  if (!result.ok) {
    throw new Error(result.reason);
  }
}
function readPosix(path, deps) {
  const constants = deps.constants ?? fsConstants;
  const flags = requirePosixFlags(constants);
  const open = deps.openSync ?? openSync;
  const close = deps.closeSync ?? closeSync;
  const fstat = deps.fstatSync ?? fstatSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const fd = open(path, flags.oRdonly | flags.noFollow | flags.nonBlock);
  try {
    const stat = fstat(fd);
    if (!stat.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    if (stat.nlink > 1) {
      throw new Error(
        `${path} has more than one hard link; refusing to read it`,
      );
    }
    return Buffer.from(readFile(fd));
  } finally {
    close(fd);
  }
}
function writePosix(path, content, deps) {
  const constants = deps.constants ?? fsConstants;
  const flags = requirePosixFlags(constants);
  const open = deps.openSync ?? openSync;
  const close = deps.closeSync ?? closeSync;
  const fstat = deps.fstatSync ?? fstatSync;
  const write = deps.writeSync ?? writeSync;
  const buffer =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content);
  const fd = open(
    path,
    flags.oWronly | flags.oCreat | flags.oExcl | flags.noFollow,
    0o644,
  );
  let closed = false;
  try {
    const stat = fstat(fd);
    if (!stat.isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    let offset = 0;
    while (offset < buffer.length) {
      offset += write(fd, buffer, offset, buffer.length - offset);
    }
    close(fd);
    closed = true;
  } catch (error) {
    if (!closed) {
      try {
        close(fd);
      } catch {
        // The write/create error below is the failure to report. The new file
        // remains at the caller-chosen path (issue #5287).
      }
    }
    throw new Error(`${describe(error)}; leftover path: ${path}`);
  }
}
function copyPosix(source, destination, deps) {
  const bytes = readPosix(source, deps);
  writePosix(destination, bytes, deps);
}
/**
 * Read a regular file without following a symbolic link, junction, or other
 * reparse point on any component. Refuses a multi-hard-link file.
 */
export function readNoFollowFile(path, deps = {}) {
  assertAbsoluteNormalized(path);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const result = runWindowsHelper('read', [path], deps);
    refuseUnlessOk(result);
    if (typeof result.bytes !== 'string') {
      throw new Error('windows no-follow helper omitted file bytes');
    }
    return Buffer.from(result.bytes, 'base64');
  }
  return readPosix(path, deps);
}
/**
 * Create `path` exclusively and write `content` without following links.
 * If the exclusive create succeeds and a later write fails, the new file
 * remains only at the caller-chosen path; this helper does not delete it.
 */
export function writeExclusiveNoFollow(path, content, deps = {}) {
  assertAbsoluteNormalized(path);
  const platform = deps.platform ?? process.platform;
  const buffer =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content);
  if (platform === 'win32') {
    // Prefer a base64 process argument for typical sizes; fall back to stdin
    // for large payloads so the command line stays bounded.
    const b64 = buffer.toString('base64');
    const useArg = Buffer.byteLength(b64, 'utf8') <= 24 * 1024;
    const result = useArg
      ? runWindowsHelper('create', [path, b64], deps)
      : runWindowsHelper('create', [path], deps, buffer);
    refuseUnlessOk(result);
    return;
  }
  writePosix(path, buffer, deps);
}
/**
 * Copy a regular file to a new exclusive destination without following links
 * on either path. Refuses when the destination would escape its verified
 * parent through a directory link.
 */
export function copyNoFollow(source, destination, deps = {}) {
  assertAbsoluteNormalized(source);
  assertAbsoluteNormalized(destination);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const result = runWindowsHelper('copy', [source, destination], deps);
    refuseUnlessOk(result);
    return;
  }
  copyPosix(source, destination, deps);
}
/**
 * True when this process can use the POSIX no-follow open flags without
 * substituting zero for a missing constant.
 */
export function hasPosixNoFollowFlags(constants = fsConstants) {
  return (
    constants?.O_NOFOLLOW !== undefined &&
    constants?.O_NONBLOCK !== undefined &&
    constants?.O_RDONLY !== undefined &&
    constants?.O_WRONLY !== undefined &&
    constants?.O_CREAT !== undefined &&
    constants?.O_EXCL !== undefined
  );
}
