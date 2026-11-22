// idd-generated-from: src/scripts/windows-nofollow.mts
//
// The scripts/windows-nofollow.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Cross-platform no-follow open primitive (issue #5287 / roadmap #5285).
// POSIX opens every directory component with O_DIRECTORY|O_NOFOLLOW, keeps
// those descriptors, and opens the final name relative to the parent fd via
// /proc/self/fd (Linux) or /dev/fd when available so a swapped intermediate
// symlink cannot redirect the final open. Windows, where those constants are
// undefined, calls the sibling System32 PowerShell script with the script
// path and the target path as process arguments
// (decision-windows-nofollow-binding). That script opens deeper names with
// NtCreateFile relative to the held parent and OBJ_DONT_REPARSE so an
// absolute-path reparse walk cannot redirect the final open (#5292). Missing
// flags are never replaced with zero. Large Windows reads return bytes
// through a caller-provided temp file so the JSON stdout stays inside the
// process maxBuffer.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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
// A copy streams the whole source, so its deadline grows with the size. The
// rate is the slowest throughput the deadline allows for before it is killed.
const COPY_BYTES_PER_SECOND_FLOOR = 4 * 1024 * 1024;
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
  const { root } = pathParse(path);
  if (path.length > root.length && (path.endsWith(sep) || path.endsWith('/'))) {
    throw new Error(
      `${path} has a trailing separator; refusing a directory-form file target`,
    );
  }
}
function splitPosixPath(path) {
  const { root } = pathParse(path);
  const names = path
    .slice(root.length)
    .split(sep)
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error(`refusing the filesystem root as a file target: ${path}`);
  }
  for (const name of names) {
    if (name === '.' || name === '..') {
      throw new Error(`path is not normalized: ${path}`);
    }
  }
  return { root: root === '' ? '/' : root, names };
}
function joinPosix(root, names, count) {
  let current = root.endsWith(sep) || root === '/' ? root : `${root}${sep}`;
  if (root === '/') current = '/';
  for (let index = 0; index < count; index++) {
    const name = names[index];
    if (name === undefined) {
      throw new Error('path component list ended early');
    }
    current = current === '/' ? `/${name}` : join(current, name);
  }
  return current;
}
/**
 * Prefer a descriptor-relative path so the final open cannot be redirected
 * by renaming an intermediate component to a symlink after the walk.
 */
function fdRelativeChild(dirFd, name, platform) {
  if (name.includes('/') || name.includes('\0')) {
    throw new Error(
      `refusing a path component that is not a single name: ${name}`,
    );
  }
  // Linux /proc/self/fd/<fd>/<name> is an openat substitute. Darwin's
  // /dev/fd/<fd>/<name> is not a reliable equivalent, so non-Linux hosts
  // return null and use absolute opens with held-inode revalidation.
  if (platform === 'linux' || existsSync('/proc/self/fd')) {
    return `/proc/self/fd/${dirFd}/${name}`;
  }
  return null;
}
function closeHeldDirs(held, close) {
  for (let index = held.length - 1; index >= 0; index--) {
    const dir = held[index];
    if (dir === undefined) continue;
    try {
      close(dir.fd);
    } catch {
      // Best-effort; the caller's error is the one to report.
    }
  }
}
/**
 * Open every intermediate directory with O_DIRECTORY|O_NOFOLLOW and keep the
 * descriptors. The final open uses a descriptor-relative path via
 * /proc/self/fd. Hosts without that mechanism are refused rather than using a
 * racy absolute-path fallback.
 */
function openPosixFinal(path, deps, finalFlags, finalMode, finalMustBeAbsent) {
  const parts = splitPosixPath(path);
  const constants = deps.constants ?? fsConstants;
  const flags = requirePosixFlags(constants);
  const open = deps.openSync ?? openSync;
  const close = deps.closeSync ?? closeSync;
  const fstat = deps.fstatSync ?? fstatSync;
  const lstat = deps.lstatSync ?? lstatSync;
  const platform = deps.platform ?? process.platform;
  const held = [];
  try {
    const rootFd = open(
      parts.root,
      flags.oRdonly | flags.oDirectory | flags.nonBlock,
    );
    // Own the descriptor before fstat so a throw still closes it.
    held.push({
      fd: rootFd,
      absPath: parts.root,
      dev: 0,
      ino: 0,
    });
    const rootStat = fstat(rootFd);
    if (!rootStat.isDirectory()) {
      throw new Error(`path root is not a plain directory: ${parts.root}`);
    }
    held[held.length - 1] = {
      fd: rootFd,
      absPath: parts.root,
      dev: rootStat.dev,
      ino: rootStat.ino,
    };
    for (let index = 0; index < parts.names.length - 1; index++) {
      const name = parts.names[index];
      if (name === undefined) {
        throw new Error('path component list ended early');
      }
      const abs = joinPosix(parts.root, parts.names, index + 1);
      const parent = held[held.length - 1];
      if (parent === undefined) {
        throw new Error(`missing parent directory handle above ${abs}`);
      }
      const relative = fdRelativeChild(parent.fd, name, platform);
      if (relative === null) {
        throw new Error(
          `this host cannot open ${abs} relative to a held directory descriptor; refusing rather than using a racy absolute-path fallback`,
        );
      }
      let childFd;
      try {
        // Never retry an absolute pathname after a descriptor-relative open:
        // held directory fds do not stop rename/replace of those names.
        childFd = open(
          relative,
          flags.oRdonly | flags.oDirectory | flags.noFollow | flags.nonBlock,
        );
      } catch (error) {
        if (errorCode(error) === 'ELOOP' || errorCode(error) === 'ENOTDIR') {
          throw new Error(
            `intermediate component is a symlink or not a plain directory: ${abs}`,
          );
        }
        throw new Error(
          `cannot open intermediate directory ${abs}: ${describe(error)}`,
        );
      }
      held.push({
        fd: childFd,
        absPath: abs,
        dev: 0,
        ino: 0,
      });
      const childStat = fstat(childFd);
      if (!childStat.isDirectory()) {
        throw new Error(
          `intermediate component is not a plain directory: ${abs}`,
        );
      }
      held[held.length - 1] = {
        fd: childFd,
        absPath: abs,
        dev: childStat.dev,
        ino: childStat.ino,
      };
    }
    const finalName = parts.names[parts.names.length - 1];
    if (finalName === undefined) {
      throw new Error(`refusing the filesystem root as a file target: ${path}`);
    }
    const finalAbs = joinPosix(parts.root, parts.names, parts.names.length);
    if (finalMustBeAbsent) {
      try {
        lstat(finalAbs);
        throw new Error(
          `exclusive create refuses an existing final component: ${finalAbs}`,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('exclusive create refuses')
        ) {
          throw error;
        }
        if (errorCode(error) !== 'ENOENT') {
          throw new Error(`cannot inspect ${finalAbs}: ${describe(error)}`);
        }
      }
    }
    const parent = held[held.length - 1];
    if (parent === undefined) {
      throw new Error(`missing parent directory handle above ${finalAbs}`);
    }
    const relative = fdRelativeChild(parent.fd, finalName, platform);
    if (relative === null) {
      throw new Error(
        `this host cannot open ${finalAbs} relative to a held directory descriptor; refusing rather than using a racy absolute-path fallback`,
      );
    }
    let finalFd;
    try {
      finalFd = open(relative, finalFlags, finalMode);
    } catch (error) {
      throw new Error(`cannot open ${finalAbs}: ${describe(error)}`);
    }
    // Parent descriptors stay open only until the final open returns; the
    // fd-relative open already bound the name lookup to those inodes.
    closeHeldDirs(held, close);
    held.length = 0;
    return finalFd;
  } catch (error) {
    closeHeldDirs(held, close);
    throw error;
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
  const oDirectory = constants.O_DIRECTORY;
  // Never coerce a missing flag with `|| 0` / `?? 0` (issue #3891 / #3934).
  if (
    noFollow === undefined ||
    nonBlock === undefined ||
    oRdonly === undefined ||
    oWriteOnly === undefined ||
    oCreat === undefined ||
    oExcl === undefined ||
    oDirectory === undefined
  ) {
    throw new Error(
      'this platform does not support the no-follow and nonblocking opens required for this helper; refusing before any mutation',
    );
  }
  return {
    noFollow,
    nonBlock,
    oRdonly,
    oWriteOnly,
    oCreat,
    oExcl,
    oDirectory,
  };
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
function runWindowsHelper(
  mode,
  paths,
  deps,
  input,
  timeoutMs = PROCESS_TIMEOUT_MS,
) {
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
      timeout: timeoutMs,
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
  const close = deps.closeSync ?? closeSync;
  const fstat = deps.fstatSync ?? fstatSync;
  const readFile = deps.readFileSync ?? readFileSync;
  const fd = openPosixFinal(
    path,
    deps,
    flags.oRdonly | flags.noFollow | flags.nonBlock,
    undefined,
    false,
  );
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
  const close = deps.closeSync ?? closeSync;
  const fstat = deps.fstatSync ?? fstatSync;
  const write = deps.writeSync ?? writeSync;
  const buffer =
    typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : Buffer.from(content);
  const fd = openPosixFinal(
    path,
    deps,
    flags.oWriteOnly | flags.oCreat | flags.oExcl | flags.noFollow,
    0o644,
    true,
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
    let stagingOwned = false;
    try {
      const result = runWindowsHelper('read', [path, bytesPath], deps);
      refuseUnlessOk(result);
      // The helper created this path with CREATE_NEW; only then may we unlink.
      stagingOwned = true;
      if (typeof result.bytes === 'string') {
        return Buffer.from(result.bytes, 'base64');
      }
      // Always read the Node-chosen staging path (not a possibly re-encoded
      // echo from PowerShell stdout). Verify the helper's content hash so a
      // post-exit symlink replace cannot return other bytes.
      const buffer = Buffer.from(readFile(bytesPath));
      if (typeof result.sha256 === 'string' && result.sha256.length > 0) {
        const digest = createHash('sha256').update(buffer).digest('hex');
        if (digest !== result.sha256.toLowerCase()) {
          throw new Error(
            'windows no-follow staging file hash mismatch; refusing possibly replaced bytes',
          );
        }
      } else {
        throw new Error(
          'windows no-follow helper omitted staging sha256; refusing unverifiable bytes',
        );
      }
      return buffer;
    } finally {
      if (stagingOwned) {
        try {
          unlink(bytesPath);
        } catch {
          // Best-effort cleanup of the staging file we know the helper created.
        }
      }
    }
  }
  return readPosix(path, deps);
}
/**
 * Create `path` exclusively and write `content` without following links.
 * On Windows the PowerShell helper marks a failed CREATE_NEW handle for
 * delete before close, so cleanup cannot race a path recreate by another
 * writer. A refused create never invites the caller to unlink. On POSIX,
 * a failed write after `O_EXCL` leaves the new path for the caller to
 * discard.
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
 * The helper deadline for a copy of `sourceBytes`: the base deadline plus the
 * time the rate floor allows for those bytes. Without a size, the base applies.
 */
function copyTimeoutMs(sourceBytes) {
  if (
    sourceBytes === undefined ||
    !Number.isSafeInteger(sourceBytes) ||
    sourceBytes < 0
  ) {
    return PROCESS_TIMEOUT_MS;
  }
  return (
    PROCESS_TIMEOUT_MS +
    Math.ceil((sourceBytes * 1000) / COPY_BYTES_PER_SECOND_FLOOR)
  );
}
/**
 * Copy a regular file to a new exclusive destination without following links
 * on either path. Refuses when the destination would escape its verified
 * parent through a directory link.
 */
// audit:ignore-dead-export: callers land in later Windows roadmap children (#5290); this child only adds the primitive
export function copyNoFollow(source, destination, deps = {}, sourceBytes) {
  assertAbsoluteNormalized(source);
  assertAbsoluteNormalized(destination);
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const result = runWindowsHelper(
      'copy',
      [source, destination],
      deps,
      undefined,
      copyTimeoutMs(sourceBytes),
    );
    refuseUnlessOk(result);
    return copyIdentityFrom(result);
  }
  copyPosix(source, destination, deps);
  return null;
}
function copyIdentityFrom(result) {
  if (
    typeof result.sourceVolume !== 'number' ||
    !Number.isSafeInteger(result.sourceVolume) ||
    typeof result.sourceIndex !== 'string' ||
    !/^[0-9]+$/u.test(result.sourceIndex)
  ) {
    throw new Error(
      'windows no-follow copy did not report the source identity; refusing an unverifiable copy',
    );
  }
  return {
    volume: BigInt(result.sourceVolume),
    index: BigInt(result.sourceIndex),
  };
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
    constants?.O_EXCL !== undefined &&
    constants?.O_DIRECTORY !== undefined
  );
}
