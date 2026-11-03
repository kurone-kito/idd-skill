// idd-generated-from: src/scripts/preserve-destination.mts
//
// The scripts/preserve-destination.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

/**
 * Guards for per-user state directories that hold preserved data
 * (kurone-kito/idd-skill#4957). F4 preserves a lone node_modules/ under
 * f4-preserved. The local-worktree-recovery and claim-issue B1 modes use their
 * own directory names with the same guards. Preserved data is never deleted or
 * expired here.
 */
import { chmodSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { LocalWorktreeRecord } from './local-worktree-occupancy.mts';
import { evaluateWindowsAcl, type WindowsAclReader } from './windows-acl.mts';

/** What the filesystem reports for one path, read without following links. */
export type LstatKind = 'absent' | 'symlink' | 'directory' | 'file' | 'other';

/** Read-only privacy assessment for an existing state directory. */
export type DirectoryPrivacy = 'private' | 'tightenable' | 'unsafe';

/** The preserved-data directories that share these guards. */
export type PreserveDirectoryName =
  | 'f4-preserved'
  | 'lwr-preserved'
  | 'b1-preserved';

export interface PreserveGitResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The filesystem, Git, and clock inputs the guards read. The F4 dependency
 * object satisfies this shape, so F4 passes its own deps unchanged.
 */
export interface PreserveGuardDeps {
  readonly lstat: (path: string) => LstatKind;
  /** Stable identity of a real directory, read with no-follow semantics. */
  readonly directoryIdentity: (path: string) => string | null;
  readonly realpath: (path: string) => string | null;
  readonly stateRoot: string;
  readonly now: () => Date;
  readonly inspectDirectoryPrivacy: (path: string) => DirectoryPrivacy;
  /** Restrict an owned POSIX directory or verify its platform ACL. */
  readonly ensurePrivateDirectory: (path: string) => void;
  readonly mkdir: (path: string, mode: number) => void;
  readonly git: (args: readonly string[], cwd: string) => PreserveGitResult;
}

/** True when `target` is `root` or lies inside it, with no `..` escape. */
export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

export interface PreservationParent {
  readonly path: string;
  readonly identity: string | null;
}

export interface PreserveDestinationResult {
  readonly destination: string;
  readonly parents: readonly PreservationParent[];
  readonly hold: string | null;
}

export function inspectDirectoryPrivacy(
  path: string,
  platform: NodeJS.Platform,
  windowsAclReader: WindowsAclReader,
): DirectoryPrivacy {
  try {
    const lexical = lstatSync(path);
    const target = statSync(path);
    if (!target.isDirectory()) return 'unsafe';
    if (platform === 'win32') {
      return evaluateWindowsAcl(windowsAclReader(realpathSync.native(path))) ===
        'private'
        ? 'private'
        : 'unsafe';
    }
    const uid = process.getuid?.();
    if (uid !== undefined && target.uid !== uid) return 'unsafe';
    if ((target.mode & 0o077) === 0 && (target.mode & 0o700) === 0o700) {
      return 'private';
    }
    return lexical.isSymbolicLink() ? 'unsafe' : 'tightenable';
  } catch {
    return 'unsafe';
  }
}

export function ensurePrivateStateDirectory(
  path: string,
  platform: NodeJS.Platform,
  windowsAclReader: WindowsAclReader,
): void {
  const privacy = inspectDirectoryPrivacy(path, platform, windowsAclReader);
  if (privacy === 'private') return;
  if (privacy !== 'tightenable') {
    throw new Error('directory ownership or privacy could not be verified');
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error('a state-root symlink target is not private');
  }
  const uid = process.getuid?.();
  const target = statSync(path);
  if (uid !== undefined && target.uid !== uid) {
    throw new Error('directory belongs to another user');
  }
  chmodSync(path, 0o700);
  if (inspectDirectoryPrivacy(path, platform, windowsAclReader) !== 'private') {
    throw new Error('directory could not be restricted to its owner');
  }
}

export function inspectPreserveDestination(
  deps: PreserveGuardDeps,
  directoryName: PreserveDirectoryName,
  issueNumber: number,
  primary: string,
  records: readonly LocalWorktreeRecord[],
): PreserveDestinationResult {
  const refuse = (detail: string): PreserveDestinationResult => ({
    destination: '',
    parents: [],
    hold: detail,
  });
  if (!isAbsolute(deps.stateRoot)) {
    return refuse('the state root is not absolute');
  }
  const stateKind = deps.lstat(deps.stateRoot);
  if (stateKind === 'absent') {
    return refuse('the state root does not exist');
  }
  if (stateKind !== 'directory' && stateKind !== 'symlink') {
    return refuse('the state root is not a directory');
  }
  const stateRootReal = deps.realpath(deps.stateRoot);
  if (stateRootReal === null) {
    return refuse('the state root cannot be resolved');
  }
  const resolvedStateRoot = resolve(stateRootReal);
  if (parse(resolvedStateRoot).root === resolvedStateRoot) {
    return refuse('the state root resolves to a filesystem root');
  }
  if (deps.inspectDirectoryPrivacy(deps.stateRoot) === 'unsafe') {
    return refuse('the state root is not owned and private');
  }

  const iddDirectory = join(resolvedStateRoot, 'idd-skill');
  const preserveDirectory = join(iddDirectory, directoryName);
  for (const [path, kind] of [
    [iddDirectory, deps.lstat(iddDirectory)],
    [preserveDirectory, deps.lstat(preserveDirectory)],
  ] as const) {
    if (kind === 'symlink') {
      return refuse(`destination component ${path} is a symlink`);
    }
    if (kind !== 'absent' && kind !== 'directory') {
      return refuse(`destination component ${path} is not a directory`);
    }
    if (
      kind === 'directory' &&
      deps.inspectDirectoryPrivacy(path) === 'unsafe'
    ) {
      return refuse(`destination component ${path} is not owned and private`);
    }
  }

  let timestamp: string;
  try {
    timestamp = deps
      .now()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return refuse('the UTC destination timestamp is invalid');
  }
  const destination = join(preserveDirectory, `${issueNumber}-${timestamp}`);
  if (deps.lstat(destination) !== 'absent') {
    return refuse(`destination already exists at ${destination}`);
  }

  const deepestExisting = [
    preserveDirectory,
    iddDirectory,
    resolvedStateRoot,
  ].find((path) => deps.lstat(path) !== 'absent');
  if (deepestExisting === undefined) {
    return refuse('no existing destination parent was found');
  }
  const destinationBase = deps.realpath(deepestExisting);
  if (destinationBase === null) {
    return refuse(`destination parent ${deepestExisting} cannot be resolved`);
  }

  const commonDirectoryResult = deps.git(
    ['rev-parse', '--git-common-dir'],
    primary,
  );
  const commonDirectoryOutput = commonDirectoryResult.stdout.trim();
  if (
    commonDirectoryResult.status !== 0 ||
    commonDirectoryOutput.length === 0
  ) {
    return refuse('Git common directory cannot be resolved');
  }
  const commonDirectoryPath = isAbsolute(commonDirectoryOutput)
    ? commonDirectoryOutput
    : resolve(primary, commonDirectoryOutput);
  const commonDirectory = deps.realpath(commonDirectoryPath);
  if (commonDirectory === null) {
    return refuse('Git common directory cannot be resolved');
  }

  const protectedRoots = [
    { path: primary, label: 'worktree' },
    { path: commonDirectory, label: 'Git common directory' },
    ...records.map((record) => ({ path: record.path, label: 'worktree' })),
  ];
  for (const protectedRoot of protectedRoots) {
    const protectedReal =
      deps.realpath(protectedRoot.path) ?? resolve(protectedRoot.path);
    if (isWithinRoot(protectedReal, destinationBase)) {
      return refuse(
        `destination ${destination} is inside protected ${protectedRoot.label} ${protectedRoot.path}`,
      );
    }
  }

  const parents: PreservationParent[] = [];
  for (const path of [resolvedStateRoot, iddDirectory, preserveDirectory]) {
    const kind = deps.lstat(path);
    const identity = kind === 'directory' ? deps.directoryIdentity(path) : null;
    if (kind !== 'absent' && (kind !== 'directory' || identity === null)) {
      return refuse(
        `destination parent ${path} has no verified directory identity`,
      );
    }
    parents.push({ path, identity });
  }
  return { destination, parents, hold: null };
}

/** Detect changed parents without following a replacement directory link. */
export function checkPreservationParents(
  deps: PreserveGuardDeps,
  parents: ReadonlyMap<string, string | null>,
): string | null {
  try {
    for (const [path, identity] of parents) {
      const kind = deps.lstat(path);
      if (identity === null && kind === 'absent') continue;
      if (
        identity === null ||
        kind !== 'directory' ||
        deps.directoryIdentity(path) !== identity ||
        deps.realpath(path) !== resolve(path) ||
        deps.inspectDirectoryPrivacy(path) === 'unsafe'
      ) {
        return `destination parent ${path} changed after inspection`;
      }
    }
    return null;
  } catch (error) {
    return `destination parent verification failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Create the destination directory for a consumer that writes into it, after
 * every guard has passed. It refuses when the path already exists and when the
 * created directory is not a directory or is not owned and private. A refused
 * directory stays in place, and its path is reported; nothing is written into
 * it. On success the new directory's identity joins the recorded parents, so
 * the consumer's recheck covers it before each write.
 */
// audit:ignore-dead-export: the worktree-remnant and B1-leftover modes of #4957's children call this; F4 renames a staged node_modules/ and does not create a destination
export function createPreserveDestination(
  deps: PreserveGuardDeps,
  destination: string,
  parents: readonly PreservationParent[],
): {
  readonly parents: readonly PreservationParent[];
  readonly hold: string | null;
} {
  const refuse = (detail: string) => ({ parents, hold: detail });
  const changed = checkPreservationParents(
    deps,
    new Map(parents.map(({ path, identity }) => [path, identity])),
  );
  if (changed !== null) return refuse(changed);
  if (deps.lstat(destination) !== 'absent') {
    return refuse(`destination already exists at ${destination}`);
  }

  // Create the absent parents in order, and restrict every parent to its
  // owner. A parent that was absent at inspection is created with a
  // non-recursive mkdir, which fails when something created it since. A parent
  // that existed must still have the identity recorded at inspection. Each
  // identity recorded here is one this run verified, and all of them are
  // rechecked just before the destination is created.
  const recorded: PreservationParent[] = [];
  for (const parent of parents) {
    try {
      if (parent.identity === null) {
        deps.mkdir(parent.path, 0o700);
      }
      deps.ensurePrivateDirectory(parent.path);
    } catch (error) {
      return refuse(
        `could not prepare ${parent.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const identity =
      deps.lstat(parent.path) === 'directory'
        ? deps.directoryIdentity(parent.path)
        : null;
    if (identity === null) {
      return refuse(`${parent.path} has no verified directory identity`);
    }
    if (parent.identity !== null && identity !== parent.identity) {
      return refuse(
        `destination parent ${parent.path} changed after inspection`,
      );
    }
    recorded.push({ path: parent.path, identity });
  }
  const finalChange = checkPreservationParents(
    deps,
    new Map(recorded.map(({ path, identity }) => [path, identity])),
  );
  if (finalChange !== null) return refuse(finalChange);

  try {
    deps.mkdir(destination, 0o700);
  } catch (error) {
    return refuse(
      `could not create ${destination}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (deps.lstat(destination) !== 'directory') {
    return refuse(`${destination} is not a directory after creation`);
  }
  if (deps.inspectDirectoryPrivacy(destination) !== 'private') {
    return refuse(
      `${destination} was created but is not owned and private; it stays in place and nothing is written into it`,
    );
  }
  const identity = deps.directoryIdentity(destination);
  if (identity === null) {
    return refuse(`${destination} has no verified directory identity`);
  }
  return {
    parents: [...recorded, { path: destination, identity }],
    hold: null,
  };
}
