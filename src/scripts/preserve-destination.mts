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
import {
  chmodSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { LocalWorktreeRecord } from './local-worktree-occupancy.mts';
import {
  defaultWindowsDirectoryTools,
  evaluateWindowsAcl,
  type WindowsAclReader,
  type WindowsAclResult,
  type WindowsDirectoryTools,
} from './windows-acl.mts';

/** What the filesystem reports for one path, read without following links. */
export type LstatKind = 'absent' | 'symlink' | 'directory' | 'file' | 'other';

/** Read-only privacy assessment for an existing state directory. */
export type DirectoryPrivacy = 'private' | 'tightenable' | 'unsafe';

/** The preserved-data directories that share these guards. */
export type PreserveDirectoryName =
  | 'f4-preserved'
  | 'lwr-preserved'
  | 'b1-preserved';

/**
 * The same names at run time. A TypeScript type is erased, so a cast or a
 * JavaScript caller can pass any string, and the path must not escape the
 * state root.
 */
const PRESERVE_DIRECTORY_NAMES: readonly string[] = [
  'f4-preserved',
  'lwr-preserved',
  'b1-preserved',
];

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

/**
 * Windows has no mode bits to tighten, so a permissive directory is handled by
 * rewriting its DACL (kurone-kito/idd-skill#5318): a real directory the
 * current user owns ends with an ACL limited to the current user, SYSTEM, and
 * the built-in Administrators, and the ACL is read again. Every refusal comes
 * before any write: a symlink (its target is never changed), a non-directory,
 * a directory with any entry, an ACL that does not read as permissive, no
 * current-user SID, or another owner. The entry check is what keeps this away
 * from a shared or populated directory. Cutting inheritance changes every
 * descendant, and the Windows state root is `%LOCALAPPDATA%`, so only an empty
 * directory, which is what a directory this run just created is, is rewritten.
 * An existing permissive directory is refused earlier, at inspection. The
 * identity read by one no-follow lstat of the original path is compared, at
 * both that path and its resolved name, just before the first write, before
 * every step the writer takes (together with the emptiness check), and after
 * the re-read, so a path swapped for a link or another directory in between
 * is reported. `icacls` still resolves
 * the path itself, so a window of one call remains; handle-based writes are not
 * used here. The tools default to the real System32 ones; the four-argument
 * call is for tests and keeps the existing callers unchanged.
 */
function restrictWindowsStateDirectory(
  path: string,
  windowsAclReader: WindowsAclReader,
  tools: WindowsDirectoryTools,
): void {
  const unverified = (): Error =>
    new Error('directory ownership or privacy could not be verified');
  // The identity of a real directory read without following links, or null.
  const identityOf = (target: string): string | null => {
    try {
      const stat = lstatSync(target, { bigint: true });
      return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
    } catch {
      return null;
    }
  };
  const isEmpty = (target: string): boolean => {
    try {
      return readdirSync(target).length === 0;
    } catch {
      return false;
    }
  };
  // One lstat names the object the path points at without following a link. A
  // symlink or junction is refused here, and every later check compares against
  // this identity at the original path as well as at the resolved one, so a
  // path swapped for a link after this point is reported, not followed.
  let linked = false;
  let identity: string;
  try {
    const stat = lstatSync(path, { bigint: true });
    linked = stat.isSymbolicLink();
    if (linked || !stat.isDirectory()) throw unverified();
    identity = `${stat.dev}:${stat.ino}`;
  } catch {
    if (linked) throw new Error('a state-root symlink target is not private');
    throw unverified();
  }
  let real: string;
  try {
    real = realpathSync.native(path);
    // The resolved directory must be the object the path named.
    if (identityOf(real) !== identity || !isEmpty(real)) throw unverified();
  } catch {
    throw unverified();
  }
  const unchanged = (): boolean =>
    identityOf(path) === identity && identityOf(real) === identity;
  let before: WindowsAclResult;
  try {
    before = windowsAclReader(real);
  } catch {
    throw unverified();
  }
  // An unreadable ACL, or one with no allow entry, says nothing about what to
  // remove, so it is refused as it was before this rewrite existed.
  if (
    before.kind !== 'entries' ||
    evaluateWindowsAcl(before) !== 'permissive'
  ) {
    throw unverified();
  }
  const currentSid = before.currentSid?.trim().toUpperCase();
  if (currentSid === undefined) throw unverified();
  let owner: string | null;
  try {
    owner = tools.readOwner(real);
  } catch {
    owner = null;
  }
  if (owner === null || owner.trim().toUpperCase() !== currentSid) {
    throw new Error('directory belongs to another user');
  }
  // The last read before the first write. The writer repeats the identity
  // check before each of its steps through the callback below.
  if (!unchanged() || !isEmpty(real)) {
    throw new Error('directory changed after inspection');
  }
  try {
    // Before each step the directory must still be the verified one and still
    // empty, so an entry added in between stops the next step.
    tools.restrict(real, currentSid, windowsAclReader, () => {
      if (!unchanged() || !isEmpty(real)) {
        throw new Error('directory changed while it was being restricted');
      }
    });
  } catch (error) {
    throw new Error(
      `directory could not be restricted to its owner: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let after: WindowsAclResult;
  try {
    after = windowsAclReader(real);
  } catch {
    throw unverified();
  }
  // A swap is reported before the ACL verdict, which may belong to another
  // directory.
  if (!unchanged()) {
    throw new Error('directory changed while it was being restricted');
  }
  if (evaluateWindowsAcl(after) !== 'private') {
    throw new Error('directory could not be restricted to its owner');
  }
}

export function ensurePrivateStateDirectory(
  path: string,
  platform: NodeJS.Platform,
  windowsAclReader: WindowsAclReader,
  windowsTools: WindowsDirectoryTools = defaultWindowsDirectoryTools,
): void {
  const privacy = inspectDirectoryPrivacy(path, platform, windowsAclReader);
  if (privacy === 'private') return;
  if (platform === 'win32') {
    restrictWindowsStateDirectory(path, windowsAclReader, windowsTools);
    return;
  }
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
  // The issue number becomes a path component, so a value that is not a
  // positive integer at run time must not reach the path.
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    return refuse(
      `issue number ${JSON.stringify(issueNumber)} is not a positive integer`,
    );
  }
  if (!PRESERVE_DIRECTORY_NAMES.includes(directoryName)) {
    return refuse(
      `unknown preserved-data directory ${JSON.stringify(directoryName)}`,
    );
  }
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
  // The destination must be a direct child of the preserve directory that was
  // inspected, which is the last parent in the list.
  const preserveDirectory = parents[parents.length - 1]?.path;
  if (
    preserveDirectory === undefined ||
    dirname(destination) !== preserveDirectory
  ) {
    return refuse(
      `${destination} is not a direct child of the inspected preserve directory`,
    );
  }
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
    // The identity of a parent this run makes, read right after its mkdir and
    // before it is restricted, so a directory swapped in afterwards is reported.
    let made: string | null = null;
    try {
      if (parent.identity === null) {
        deps.mkdir(parent.path, 0o700);
        made =
          deps.lstat(parent.path) === 'directory'
            ? deps.directoryIdentity(parent.path)
            : null;
        if (made === null) {
          throw new Error('the created directory has no verified identity');
        }
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
    if (made !== null && identity !== made) {
      return refuse(`destination parent ${parent.path} changed after creation`);
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
  // Read the identity straight after creation, before the other checks, so
  // the window in which another process can replace the directory is as short
  // as possible. A second read after the privacy check must match it.
  const identity = deps.directoryIdentity(destination);
  if (identity === null) {
    return refuse(`${destination} has no verified directory identity`);
  }
  if (deps.lstat(destination) !== 'directory') {
    return refuse(`${destination} is not a directory after creation`);
  }
  let privacy = deps.inspectDirectoryPrivacy(destination);
  let restrictFailure = '';
  if (privacy === 'unsafe') {
    // A new Windows directory can carry a permissive inherited ACL. Restrict
    // the directory this run just created once, as its parents were, and judge
    // the result below. On POSIX an unsafe leaf fails this too, as before.
    // The captured identity is checked first, so a leaf replaced since it was
    // created is refused before anything is written to it.
    try {
      if (deps.directoryIdentity(destination) !== identity) {
        return refuse(`${destination} changed after creation`);
      }
      deps.ensurePrivateDirectory(destination);
      privacy = deps.inspectDirectoryPrivacy(destination);
    } catch (error) {
      restrictFailure = ` (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  if (privacy !== 'private') {
    return refuse(
      `${destination} was created but is not owned and private${restrictFailure}; it stays in place and nothing is written into it`,
    );
  }
  if (deps.directoryIdentity(destination) !== identity) {
    return refuse(`${destination} changed after creation`);
  }
  return {
    parents: [...recorded, { path: destination, identity }],
    hold: null,
  };
}
