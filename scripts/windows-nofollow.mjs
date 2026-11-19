// idd-generated-from: src/scripts/windows-nofollow.mts
//
// The scripts/windows-nofollow.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Cross-platform no-follow open primitive (issue #5287 / roadmap #5285).
// POSIX walks every intermediate component with lstat (refuse a symlink or
// non-directory) then opens the final name with O_RDONLY|O_NOFOLLOW|O_NONBLOCK
// (and O_CREAT|O_EXCL|O_NOFOLLOW for exclusive create). Windows, where those
// constants are undefined, calls the sibling System32 PowerShell script with
// the script path and the target path as process arguments
// (decision-windows-nofollow-binding). Missing flags are never replaced with
// zero. Large Windows reads return bytes through a caller-provided temp file
// so the JSON stdout stays inside the process maxBuffer.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  isAbsolute,
  join,
  normalize,
  dirname as pathDirname,
  parse as pathParse,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = pathDirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = 'windows-nofollow.ps1';
const PROCESS_TIMEOUT_MS = 30_000;
const PROCESS_MAX_BUFFER = 16 * 1024 * 1024;
function describe(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
function errorCode(error) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  return undefined;
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
/**
 * Refuse a symbolic link (or non-directory) on any intermediate component.
 * `O_NOFOLLOW` alone only protects the final name, so this walk is required
 * for the intermediate-component acceptance criterion.
 */
function assertPosixIntermediateChain(path, deps, finalMustBeAbsent) {
  const { root } = pathParse(path);
  const remainder = path.slice(root.length);
  const names = remainder.split(sep).filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(`refusing the filesystem root as a file target: ${path}`);
  }
  const lstat = deps.lstatSync ?? lstatSync;
  let current = root.endsWith(sep) ? root : `${root}${sep}`;
  // pathParse root on POSIX is usually '/', already with the separator.
  if (root === '/') current = '/';
  for (let index = 0; index < names.length; index++) {
    const name = names[index];
    if (name === '.' || name === '..') {
      throw new Error(`path is not normalized: ${path}`);
    }
    current = current === '/' ? `/${name}` : join(current, name);
    const isFinal = index === names.length - 1;
    let stat;
    try {
      stat = lstat(current);
    } catch (error) {
      if (isFinal && finalMustBeAbsent && errorCode(error) === 'ENOENT') {
        return;
      }
      throw new Error(`cannot inspect ${current}: ${describe(error)}`);
    }
    if (!isFinal) {
      if (stat.isSymbolicLink()) {
        throw new Error(
          `intermediate component is a symlink; refusing: ${current}`,
        );
      }
      if (!stat.isDirectory()) {
        throw new Error(
          `intermediate component is not a plain directory: ${current}`,
        );
      }
      continue;
    }
    if (finalMustBeAbsent) {
      throw new Error(
        `exclusive create refuses an existing final component: ${current}`,
      );
    }
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
  const oWriteOnly = constants.O_WRONLY;
  const oCreat = constants.O_CREAT;
  const oExcl = constants.O_EXCL;
  // Never coerce a missing flag with `|| 0` / `?? 0` (issue #3891 / #3934).
  if (
    noFollow === undefined ||
    nonBlock === undefined ||
    oRdonly === undefined ||
    oWriteOnly === undefined ||
    oCreat === undefined ||
    oExcl === undefined
  ) {
    throw new Error(
      'this platform does not support the no-follow and nonblocking opens required for this helper; refusing before any mutation',
    );
  }
  return { noFollow, nonBlock, oRdonly, oWriteOnly, oCreat, oExcl };
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
  assertPosixIntermediateChain(path, deps, false);
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
  assertPosixIntermediateChain(path, deps, true);
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
    flags.oWriteOnly | flags.oCreat | flags.oExcl | flags.noFollow,
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
function freshBytesPath(deps) {
  const dir = (deps.tmpdir ?? tmpdir)();
  return join(dir, `idd-nofollow-${randomBytes(16).toString('hex')}.bin`);
}
/**
 * Read a regular file without following a symbolic link, junction, or other
 * reparse point on any component. Refuses a multi-hard-link file.
 */
// audit:ignore-dead-export: callers land in later Windows roadmap children (#5290); this child only adds the primitive
export function readNoFollowFile(path, deps = {}) {
  assertAbsoluteNormalized(path);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const bytesPath = freshBytesPath(deps);
    const unlink = deps.unlinkSync ?? unlinkSync;
    const readFile = deps.readFileSync ?? readFileSync;
    try {
      const result = runWindowsHelper('read', [path, bytesPath], deps);
      refuseUnlessOk(result);
      const delivered =
        typeof result.bytesPath === 'string' ? result.bytesPath : bytesPath;
      if (typeof result.bytes === 'string') {
        return Buffer.from(result.bytes, 'base64');
      }
      return Buffer.from(readFile(delivered));
    } finally {
      try {
        unlink(bytesPath);
      } catch {
        // Best-effort cleanup of the staging file; the read result or refusal
        // is what the caller must see.
      }
    }
  }
  return readPosix(path, deps);
}
/**
 * Create `path` exclusively and write `content` without following links.
 * If the exclusive create succeeds and a later write fails, the new file
 * remains only at the caller-chosen path; this helper does not delete it.
 */
// audit:ignore-dead-export: callers land in later Windows roadmap children (#5290); this child only adds the primitive
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
// audit:ignore-dead-export: callers land in later Windows roadmap children (#5290); this child only adds the primitive
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
// audit:ignore-dead-export: capability probe for tests and later adopters; no production caller in this child
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
