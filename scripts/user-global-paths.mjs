#!/usr/bin/env node
// idd-generated-from: src/scripts/user-global-paths.mts
//
// The scripts/user-global-paths.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.
// Containment primitives for user-global installer writes (#4242). Every
// later write and removal in the installer goes through these exports.
//
// Open risks, accepted for the operator:
// - a symbolic link above a declared ceiling is trusted when root owns it (see
//   below);
// - a window remains between a containment check and the act that follows it.
//
// The module resolves no root itself: the caller passes the data root and
// refuses when no root resolves. Each walk export takes an optional `fs`
// object. Tests inject replacements; the installer also passes
// `withCeilings(fs, ...)` to declare where the strict part of the links check
// begins (#4303).
//
// Ceilings. A ceiling is a qualified root the operator named, such as HOME,
// XDG_DATA_HOME, or XDG_CONFIG_HOME, or the parent of one it named. When the
// `fs` handle declares ceilings, every walk first reads the chain from the
// first declared ceiling that covers its root down to the root, both ends
// included, with one no-follow `lstat` per component and in that order,
// top-down. Each existing component must be a real directory. The chain ends
// at the first absent component, because nothing below an absent one exists,
// and a dangling link is a link, not an absent component. If ceilings are
// declared and none covers the root, the walk refuses. Without declared
// ceilings the walk behaves as before, so only the root and what is below it
// are inspected.
//
// Order matters: declare the primary root (HOME) first. A later ceiling is
// consulted only for a root the earlier ones do not cover, so a ceiling nested
// inside the primary root cannot hide a link between the two (exporting
// XDG_DATA_HOME=$HOME/.local/share changes nothing: a link at ~/.local is
// refused with or without the variable), and a ceiling above it cannot widen
// what is inspected for the primary root's own paths. Among the later
// ceilings the first covering one also wins, so an unrelated ceiling declared
// earlier can start a chain higher than a nested one would; that refuses more
// and never less.
//
// Above a ceiling the walk is more lenient, not blind. It reads those
// components too, top-down from the filesystem root, and tolerates a symbolic
// link there only when root owns it. System links such as `/var -> /private/var`
// (macOS) or `/home -> /var/home` (Fedora Atomic) are root-owned, so an
// ordinary install does not fail on them. A link a user owns, such as
// `/data/me -> /mnt/disk/me` made with `ln -s`, is refused, and the operator
// names the real path instead. At and below the ceiling a link is refused
// whoever owns it. A root-owned link is trusted, which stays an open risk: a
// link planted by root is outside what this check can tell from a system's,
// and the trust covers everything that link resolves through, because `lstat`
// follows links in the components it passes. The owner is the one the
// filesystem reports: a mount that reports every file as root's, or a user
// namespace that maps a user's files to root, makes a user's link look like
// the system's and the check then degrades to the old behavior, while a
// system link reported as an unmapped owner is refused, with its uid named. A
// stat with no numeric owner counts as not root-owned, so the check fails
// closed.
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

const DEFAULT_FS = nodeFs;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = nodeFs.constants;
/** The version pattern from issue #4242, verbatim. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
/** The name of the installed-version link inside the data root. */
const CURRENT = 'current';
function describe(error) {
  return error instanceof Error ? error.message : String(error);
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
/**
 * The no-follow and nonblocking open flags. Every export calls this before
 * any mutation, so a platform without them (notably Windows) refuses first.
 */
function requirePlatformFlags(fs) {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (noFollow === undefined || nonBlock === undefined) {
    throw new Error(
      'this platform does not support the no-follow and nonblocking opens required for user-global writes; refusing before any mutation',
    );
  }
  return { noFollow, nonBlock };
}
/**
 * Paths must be absolute and already normalized. The kernel resolves a `..`
 * after any symbolic link before it, so a normalized copy of a path can name
 * a different file than the string the caller passed.
 */
function assertSafePaths(root, target) {
  if (!isAbsolute(root) || !isAbsolute(target)) {
    throw new Error(`paths must be absolute: ${root}, ${target}`);
  }
  assertNormalized(root);
  assertNormalized(target);
}
function assertNormalized(path) {
  if (normalize(path) !== path) {
    throw new Error(
      `${path} is not in normalized form (it has '.', '..', or a repeated separator); refusing it`,
    );
  }
}
/** The components of `target` below `root`, each a single name. */
function segmentsBelow(root, target) {
  const parts = relative(root, target).split(sep);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${target} is not below ${root}`);
  }
  return parts;
}
/** `path` without a trailing separator, keeping the filesystem root whole. */
function stripTrailingSeparator(path) {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}
/** Whether `path` is `ancestor` or below it, compared by whole components. */
function isAtOrBelow(ancestor, path) {
  const rel = relative(ancestor, path);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}
/** `lstat` that reports only a missing entry as null; other errors refuse. */
function lstatOrNull(path, fs) {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`cannot inspect ${path}: ${describe(error)}`);
  }
}
function classifyFinal(stat, path) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  throw new Error(
    `${path} is a special file (FIFO, socket, or device); refusing`,
  );
}
/** A ceiling must be absolute and normalized, however it was declared. */
function assertCeiling(ceiling) {
  if (!isAbsolute(ceiling)) {
    throw new Error(`a ceiling must be absolute: ${ceiling}`);
  }
  assertNormalized(ceiling);
}
/**
 * The first declared ceiling that covers `base`, or undefined when `fs`
 * declares none. Every declared ceiling is validated first. When none covers
 * `base` the walk refuses, so a caller that declares ceilings cannot walk a
 * root nobody vouched for. The first one wins so that the primary root's own
 * paths are read from it, whatever else was declared.
 */
function ceilingFor(base, fs) {
  const declared = fs.ceilings;
  if (declared === undefined) return undefined;
  for (const ceiling of declared) assertCeiling(ceiling);
  const covering = declared.find((ceiling) => isAtOrBelow(ceiling, base));
  if (covering === undefined) {
    throw new Error(
      `${base} is not at or below any declared ceiling (${declared.join(', ')}); refusing`,
    );
  }
  return covering;
}
/**
 * Read the components above `start`, top-down from the filesystem root. A
 * symbolic link there is tolerated only when root owns it, since system links
 * such as `/var -> /private/var` are root-owned; any other link, and any
 * non-directory, refuses. Returns false when a component is absent, because
 * nothing below an absent one exists.
 */
function assertAboveCeiling(start, fs) {
  const { root } = parse(start);
  const names = relative(root, start).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < names.length - 1; index++) {
    current = join(current, names[index]);
    const stat = lstatOrNull(current, fs);
    if (stat === null) return false;
    if (stat.isSymbolicLink()) {
      if (stat.uid === 0) continue;
      const owner =
        typeof stat.uid === 'number' ? `uid ${stat.uid}` : 'unknown';
      throw new Error(
        `${current} is a symbolic link above ${start} that the system does not own (owner ${owner}); refusing to write through it; to continue, name the root by its real path instead of one through the link (an existing install made through the link needs the link replaced by the real directory instead)`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(`${current} is not a directory above ${start}; refusing`);
    }
  }
  return true;
}
/**
 * Read the chain from `ceiling` down to `base`, both ends included, top-down,
 * after the components above `ceiling`. Each existing component of the chain
 * must be a real directory. The walk ends at the first absent component. A
 * trailing separator is stripped first, because `lstat("x/link/")` follows
 * the link and would hide it.
 */
function assertChainFrom(ceiling, base, fs) {
  const start = stripTrailingSeparator(ceiling);
  if (!assertAboveCeiling(start, fs)) return;
  const rel = relative(start, stripTrailingSeparator(base));
  const parts = rel === '' ? [] : rel.split(sep);
  let current = start;
  for (let index = -1; index < parts.length; index++) {
    if (index >= 0) current = join(current, parts[index]);
    const stat = lstatOrNull(current, fs);
    if (stat === null) return;
    const where =
      current === stripTrailingSeparator(base) ? '' : ` on the path to ${base}`;
    if (stat.isSymbolicLink()) {
      const remedy =
        current === start
          ? "name the real path instead of the link, or move the real directory into the link's place"
          : "move the real directory into the link's place";
      throw new Error(
        `${current} is a symbolic link${where} (the chain from ${start} down must be real directories); refusing to write through it; to continue, ${remedy}`,
      );
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `${current} is not a directory${where} (the chain from ${start} down must be real directories); refusing`,
      );
    }
  }
}
/** Check the declared chain above `base`; a no-op when `fs` declares none. */
function assertDeclaredChain(base, fs) {
  const ceiling = ceilingFor(base, fs);
  if (ceiling !== undefined) assertChainFrom(ceiling, base, fs);
}
/**
 * Walk from `root` down to `target` with no-follow stats. Nothing is created.
 * The root must be a real directory when it exists. Each intermediate
 * component must be a real directory when it exists. Once a component is
 * absent, everything below it is absent. A missing root and missing
 * intermediates are listed in `missingDirs`, root first. When `fs` declares
 * ceilings, the components above the covering ceiling and then the chain from
 * that ceiling down to `root` are read first.
 */
function walkTo(root, target, fs) {
  assertSafePaths(root, target);
  assertDeclaredChain(root, fs);
  const parts = segmentsBelow(root, target);
  const last = parts.length - 1;
  const missingDirs = [];
  let finalKind = 'absent';
  let finalStat = null;
  const rootStat = lstatOrNull(root, fs);
  if (rootStat === null) {
    missingDirs.push(root);
  } else if (rootStat.isSymbolicLink()) {
    throw new Error(
      `${root} is a symbolic link; the data root must be a real directory`,
    );
  } else if (!rootStat.isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }
  let current = root;
  let belowAbsent = rootStat === null;
  for (let index = 0; index <= last; index++) {
    current = join(current, parts[index]);
    const isFinal = index === last;
    const stat = belowAbsent ? null : lstatOrNull(current, fs);
    if (stat === null) {
      belowAbsent = true;
      if (!isFinal) missingDirs.push(current);
      continue;
    }
    if (isFinal) {
      finalKind = classifyFinal(stat, current);
      finalStat = stat;
    } else if (stat.isSymbolicLink()) {
      throw new Error(
        `${current} is a symbolic link on the path to ${target}; refusing to write through it`,
      );
    } else if (!stat.isDirectory()) {
      throw new Error(`${current} is not a directory on the path to ${target}`);
    }
  }
  return { finalKind, finalStat, missingDirs };
}
/** Create each directory with one non-recursive mkdir, parents first. */
function createDirs(dirs, fs) {
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir);
    } catch (error) {
      throw new Error(
        `could not create ${dir}: ${describe(error)}; directories created before it remain in place`,
      );
    }
  }
}
/** The SHA-256 of a regular file, opened without following a link. */
function sha256Of(path, fs, flags) {
  const fd = fs.openSync(path, O_RDONLY | flags.noFollow | flags.nonBlock);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function writeAll(fd, content, fs) {
  const buffer = Buffer.from(content, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}
/**
 * Remove a file this call created, then throw the cause. When the removal
 * fails, the error names the leftover path.
 */
function discardOwnFile(path, cause, fs, action) {
  try {
    fs.unlinkSync(path);
  } catch (unlinkError) {
    throw new Error(
      `${action}: ${describe(cause)}; could not remove ${path} (${describe(unlinkError)}); leftover path: ${path}`,
    );
  }
  throw new Error(`${action}: ${describe(cause)}`);
}
/** Names in `dir` that are `<base>.tmp-<digits>`. */
function staleTemps(dir, base, fs) {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.tmp-[0-9]+$`);
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name));
}
/** Whether `target` is still the entry `expected` describes. */
function assertMatchesExpected(target, walk, expected, flags, fs) {
  if (walk.finalKind !== expected.kind) {
    throw new Error(
      `${target} is ${walk.finalKind}, not the expected ${expected.kind}; refusing to remove it`,
    );
  }
  if (expected.kind === 'file') {
    if (walk.finalStat === null || walk.finalStat.nlink > 1) {
      throw new Error(
        `${target} has more than one hard link; refusing to remove it`,
      );
    }
    if (sha256Of(target, fs, flags) !== expected.sha256.toLowerCase()) {
      throw new Error(
        `${target} changed: its SHA-256 does not match; refusing to remove it`,
      );
    }
  } else if (expected.kind === 'symlink') {
    if (fs.readlinkSync(target) !== expected.target) {
      throw new Error(
        `${target} points somewhere else now; refusing to remove it`,
      );
    }
  } else if (fs.readdirSync(target).length > 0) {
    throw new Error(`${target} is no longer empty; refusing to remove it`);
  }
}
/** Refuse a `current` that is not a symlink to a real version directory. */
function assertRepointable(current, root, stat, fs) {
  if (!stat.isSymbolicLink()) {
    throw new Error(
      `${current} is not a symbolic link; refusing to replace it`,
    );
  }
  const linkTarget = fs.readlinkSync(current);
  assertNormalized(linkTarget);
  const resolved = resolve(root, linkTarget);
  if (dirname(resolved) !== root) {
    throw new Error(
      `${current} targets ${resolved}, which is not directly under the data root`,
    );
  }
  if (!VERSION_PATTERN.test(basename(resolved))) {
    throw new Error(
      `${current} targets ${resolved}, which is not a version directory name`,
    );
  }
  const targetStat = lstatOrNull(resolved, fs);
  if (targetStat === null) {
    throw new Error(`${current} is a dangling link to ${resolved}`);
  }
  if (targetStat.isSymbolicLink()) {
    throw new Error(`${current} targets ${resolved}, which is a symbolic link`);
  }
  if (!targetStat.isDirectory()) {
    throw new Error(`${current} targets ${resolved}, which is not a directory`);
  }
}
/**
 * Return a copy of `fs` that declares `ceilings`: the qualified roots the
 * caller resolved from the environment (see the module header), primary root
 * first. Every walk the returned handle makes first reads the components above
 * the first declared ceiling that covers its root (a link there is tolerated
 * only when root owns it), then the chain from that ceiling down to the root
 * (any link refuses). Each ceiling must be absolute and normalized, and at
 * least one must be given.
 */
export function withCeilings(fs, ceilings) {
  if (ceilings.length === 0) {
    throw new Error('at least one ceiling must be declared');
  }
  for (const ceiling of ceilings) assertCeiling(ceiling);
  return { ...fs, ceilings: [...ceilings] };
}
/**
 * Read everything above and including `base` that a walk of `base` would read
 * first, without walking anything below it, for a caller that must look at
 * `base` itself before its first walk: the components above the covering
 * ceiling, then the chain from the ceiling down to `base`. Refuses a relative
 * or non-normalized `base`, a symbolic link or a non-directory on the chain, a
 * symbolic link above the ceiling that root does not own, and a `base` that no
 * declared ceiling covers. It also refuses when `fs` declares no ceilings,
 * because this check has no other purpose.
 */
export function assertRealChain(base, fs = DEFAULT_FS) {
  requirePlatformFlags(fs);
  if (fs.ceilings === undefined) {
    throw new Error(
      'no ceilings are declared on this fs handle; build it with withCeilings',
    );
  }
  if (!isAbsolute(base)) {
    throw new Error(`path must be absolute: ${base}`);
  }
  assertNormalized(base);
  assertDeclaredChain(base, fs);
}
/**
 * Walk from `root` down to `target` without following links and report the
 * final component's kind and the directories a write would create. Creates
 * nothing and refuses a symbolic link on any component above the final one.
 */
export function checkContainment(root, target, fs = DEFAULT_FS) {
  requirePlatformFlags(fs);
  const walk = walkTo(root, target, fs);
  return { finalKind: walk.finalKind, missingDirs: walk.missingDirs };
}
/**
 * Create `target` exclusively with `content`, creating missing directories
 * first. Refuses any existing final component, a link included. If the
 * content write fails after the create, the created file is removed.
 */
export function writeNewFile(root, target, content, fs = DEFAULT_FS) {
  const flags = requirePlatformFlags(fs);
  const walk = walkTo(root, target, fs);
  if (walk.finalKind !== 'absent') {
    throw new Error(
      `${target} already exists as ${walk.finalKind}; the create-only write refuses it`,
    );
  }
  createDirs(walk.missingDirs, fs);
  const fd = fs.openSync(
    target,
    O_WRONLY | O_CREAT | O_EXCL | flags.noFollow,
    0o644,
  );
  let closed = false;
  try {
    writeAll(fd, content, fs);
    fs.closeSync(fd);
    closed = true;
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {
        // The write error below is the failure to report.
      }
    }
    discardOwnFile(target, error, fs, `write to ${target} failed`);
  }
}
/**
 * Replace an existing regular file by renaming a temporary file over it. The
 * file must have one hard link and the SHA-256 the caller expects. The
 * temporary file is `<target>.tmp-<pid>`, created exclusively, and any
 * existing `<target>.tmp-<digits>` refuses the replacement.
 */
export function replaceFileByRename(
  root,
  target,
  expectedSha256,
  content,
  fs = DEFAULT_FS,
) {
  const flags = requirePlatformFlags(fs);
  const walk = walkTo(root, target, fs);
  if (walk.finalKind !== 'file' || walk.finalStat === null) {
    throw new Error(
      `${target} must be an existing regular file to replace; found ${walk.finalKind}`,
    );
  }
  if (walk.finalStat.nlink > 1) {
    throw new Error(
      `${target} has more than one hard link; refusing to replace it`,
    );
  }
  if (sha256Of(target, fs, flags) !== expectedSha256.toLowerCase()) {
    throw new Error(
      `${target} changed: its SHA-256 does not match; refusing to replace it`,
    );
  }
  const stale = staleTemps(dirname(target), basename(target), fs);
  if (stale.length > 0) {
    throw new Error(
      `${stale[0]} exists; refusing to replace ${target} (remove the stale temporary file by hand)`,
    );
  }
  const temp = `${target}.tmp-${process.pid}`;
  const mode = walk.finalStat.mode & 0o777;
  const fd = fs.openSync(
    temp,
    O_WRONLY | O_CREAT | O_EXCL | flags.noFollow,
    mode,
  );
  let closed = false;
  try {
    writeAll(fd, content, fs);
    // openSync applies the process umask to `mode`, which can drop bits the
    // original file had, so set them explicitly on the open descriptor.
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    closed = true;
    fs.renameSync(temp, target);
  } catch (error) {
    if (!closed) {
      try {
        fs.closeSync(fd);
      } catch {
        // The write error below is the failure to report.
      }
    }
    discardOwnFile(temp, error, fs, `replacement of ${target} failed`);
  }
}
/**
 * Remove exactly one final component after re-checking it against `expected`
 * immediately before the unlink (or rmdir, for an empty directory). Never
 * recursive; a non-empty directory and a file with a second hard link are
 * refused.
 */
export function removeSingleEntry(root, target, expected, fs = DEFAULT_FS) {
  const flags = requirePlatformFlags(fs);
  const walk = walkTo(root, target, fs);
  if (walk.finalKind === 'absent') {
    throw new Error(`${target} does not exist; nothing to remove`);
  }
  assertMatchesExpected(target, walk, expected, flags, fs);
  try {
    if (expected.kind === 'directory') {
      fs.rmdirSync(target);
    } else {
      fs.unlinkSync(target);
    }
  } catch (error) {
    throw new Error(`could not remove ${target}: ${describe(error)}`);
  }
}
/**
 * Point `current` at `<dataRoot>/<version>` through a temporary symbolic link
 * renamed over it. `current` may be absent or a symbolic link to a real
 * version directory directly under the data root. Any existing
 * `current.tmp-<digits>` refuses the repoint.
 */
export function repointCurrent(dataRoot, version, fs = DEFAULT_FS) {
  requirePlatformFlags(fs);
  if (!isAbsolute(dataRoot)) {
    throw new Error(`data root must be absolute: ${dataRoot}`);
  }
  assertNormalized(dataRoot);
  const root = dataRoot;
  assertDeclaredChain(root, fs);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`version ${version} does not match the required pattern`);
  }
  const rootStat = lstatOrNull(root, fs);
  if (rootStat === null) {
    throw new Error(`data root ${root} does not exist`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(
      `${root} is a symbolic link; the data root must be a real directory`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`${root} is not a directory`);
  }
  const versionDir = join(root, version);
  const versionStat = lstatOrNull(versionDir, fs);
  if (versionStat === null || !versionStat.isDirectory()) {
    throw new Error(
      `${versionDir} is not a real version directory under the data root`,
    );
  }
  const current = join(root, CURRENT);
  const stale = staleTemps(root, CURRENT, fs);
  if (stale.length > 0) {
    throw new Error(
      `${stale[0]} exists; remove it by hand before repointing ${current}`,
    );
  }
  const currentStat = lstatOrNull(current, fs);
  if (currentStat !== null) {
    assertRepointable(current, root, currentStat, fs);
  }
  const temp = join(root, `${CURRENT}.tmp-${process.pid}`);
  fs.symlinkSync(versionDir, temp);
  try {
    fs.renameSync(temp, current);
  } catch (error) {
    discardOwnFile(temp, error, fs, `repoint of ${current} failed`);
  }
}
