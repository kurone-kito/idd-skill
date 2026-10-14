#!/usr/bin/env node
// idd-generated-from: src/scripts/user-global-paths.mts
//
// The scripts/user-global-paths.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// Containment primitives for user-global installer writes (#4242). Every
// later write and removal in the installer goes through these exports.
//
// Open risks, accepted for the operator:
// - a symbolic link above the data root is not inspected;
// - a window remains between a containment check and the act that follows it.
//
// The module resolves no root itself: the caller passes the data root and
// refuses when no root resolves. Each export takes an optional `fs` object
// that only tests use.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

/** Platform constants the no-follow and nonblocking opens depend on. */
export interface PlatformConstants {
  O_NOFOLLOW?: number;
  O_NONBLOCK?: number;
}

/** The subset of `node:fs` this module uses; tests inject replacements. */
export type FsOps = Omit<typeof nodeFs, 'constants'> & {
  constants: PlatformConstants;
};

const DEFAULT_FS: FsOps = nodeFs;

/** The kind of the final path component, as the containment walk saw it. */
export type FinalKind = 'absent' | 'file' | 'directory' | 'symlink';

/** The result of a containment walk, with nothing created. */
export interface ContainmentResult {
  finalKind: FinalKind;
  missingDirs: string[];
}

/** The expected state of the single entry that removal may delete. */
export type ExpectedEntry =
  | { kind: 'file'; sha256: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' };

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL } = nodeFs.constants;

/** The version pattern from issue #4242, verbatim. */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

/** The name of the installed-version link inside the data root. */
const CURRENT = 'current';

/** A containment walk plus the stat of the final component, when it exists. */
interface Walk extends ContainmentResult {
  finalStat: nodeFs.Stats | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
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
function requirePlatformFlags(fs: FsOps): {
  noFollow: number;
  nonBlock: number;
} {
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
function assertSafePaths(root: string, target: string): void {
  if (!isAbsolute(root) || !isAbsolute(target)) {
    throw new Error(`paths must be absolute: ${root}, ${target}`);
  }
  assertNormalized(root);
  assertNormalized(target);
}

function assertNormalized(path: string): void {
  if (normalize(path) !== path) {
    throw new Error(
      `${path} is not in normalized form (it has '.', '..', or a repeated separator); refusing it`,
    );
  }
}

/** The components of `target` below `root`, each a single name. */
function segmentsBelow(root: string, target: string): string[] {
  const parts = relative(root, target).split(sep);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`${target} is not below ${root}`);
  }
  return parts;
}

/** `lstat` that reports only a missing entry as null; other errors refuse. */
function lstatOrNull(path: string, fs: FsOps): nodeFs.Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`cannot inspect ${path}: ${describe(error)}`);
  }
}

function classifyFinal(stat: nodeFs.Stats, path: string): FinalKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  throw new Error(
    `${path} is a special file (FIFO, socket, or device); refusing`,
  );
}

/**
 * Walk from `root` down to `target` with no-follow stats. Nothing is created.
 * The root must be a real directory when it exists. Each intermediate
 * component must be a real directory when it exists. Once a component is
 * absent, everything below it is absent. A missing root and missing
 * intermediates are listed in `missingDirs`, root first.
 */
function walkTo(root: string, target: string, fs: FsOps): Walk {
  assertSafePaths(root, target);
  const parts = segmentsBelow(root, target);
  const last = parts.length - 1;
  const missingDirs: string[] = [];
  let finalKind: FinalKind = 'absent';
  let finalStat: nodeFs.Stats | null = null;

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
function createDirs(dirs: string[], fs: FsOps): void {
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
function sha256Of(
  path: string,
  fs: FsOps,
  flags: { noFollow: number; nonBlock: number },
): string {
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

function writeAll(fd: number, content: string, fs: FsOps): void {
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
function discardOwnFile(
  path: string,
  cause: unknown,
  fs: FsOps,
  action: string,
): never {
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
function staleTemps(dir: string, base: string, fs: FsOps): string[] {
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}\\.tmp-[0-9]+$`);
  return fs
    .readdirSync(dir)
    .filter((name) => pattern.test(name))
    .map((name) => join(dir, name));
}

/** Whether `target` is still the entry `expected` describes. */
function assertMatchesExpected(
  target: string,
  walk: Walk,
  expected: ExpectedEntry,
  flags: { noFollow: number; nonBlock: number },
  fs: FsOps,
): void {
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
function assertRepointable(
  current: string,
  root: string,
  stat: nodeFs.Stats,
  fs: FsOps,
): void {
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
 * Walk from `root` down to `target` without following links and report the
 * final component's kind and the directories a write would create. Creates
 * nothing and refuses a symbolic link on any component above the final one.
 */
// audit:ignore-dead-export: consumed by issue #4243
export function checkContainment(
  root: string,
  target: string,
  fs: FsOps = DEFAULT_FS,
): ContainmentResult {
  requirePlatformFlags(fs);
  const walk = walkTo(root, target, fs);
  return { finalKind: walk.finalKind, missingDirs: walk.missingDirs };
}

/**
 * Create `target` exclusively with `content`, creating missing directories
 * first. Refuses any existing final component, a link included. If the
 * content write fails after the create, the created file is removed.
 */
// audit:ignore-dead-export: consumed by issue #4243
export function writeNewFile(
  root: string,
  target: string,
  content: string,
  fs: FsOps = DEFAULT_FS,
): void {
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
// audit:ignore-dead-export: consumed by issue #4243
export function replaceFileByRename(
  root: string,
  target: string,
  expectedSha256: string,
  content: string,
  fs: FsOps = DEFAULT_FS,
): void {
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
// audit:ignore-dead-export: consumed by issue #4243
export function removeSingleEntry(
  root: string,
  target: string,
  expected: ExpectedEntry,
  fs: FsOps = DEFAULT_FS,
): void {
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
// audit:ignore-dead-export: consumed by issue #4243
export function repointCurrent(
  dataRoot: string,
  version: string,
  fs: FsOps = DEFAULT_FS,
): void {
  requirePlatformFlags(fs);
  if (!isAbsolute(dataRoot)) {
    throw new Error(`data root must be absolute: ${dataRoot}`);
  }
  assertNormalized(dataRoot);
  const root = dataRoot;
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
