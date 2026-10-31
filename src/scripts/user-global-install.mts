// idd-generated-from: src/scripts/user-global-install.mts
//
// The scripts/user-global-install.mjs copy is generated from this file by
// `pnpm run build`. Edit this source, never the generated copy.

// User-global install and uninstall (#4243). Install copies the instruction
// payload and the two skill trees into the user's roots, and records each
// path it creates in a receipt. Uninstall removes only what the receipt lists
// and what still matches it. Every write and removal goes through the
// containment primitives in `user-global-paths.mts` (#4242).
//
// Ceilings (#4303). `resolveContext` declares the roots the operator named
// (HOME first, then XDG_DATA_HOME, the parent of CODEX_HOME and
// XDG_CONFIG_HOME when those are set) on the `fs` handle every primitive
// receives, so each walk first reads the chain from the first declared root
// that covers its root down to its own root and refuses a symbolic link on it.
// A skill root, which sits under HOME, is therefore refused when HOME, or a
// directory between HOME and the root, is a link. So is the data root, unless
// XDG_DATA_HOME names it outside HOME. The refusal says to move the real
// directory into the link's place. For a new install the operator can instead
// name the real path with HOME (it moves the skill roots) or XDG_DATA_HOME (it
// moves only the data root); an existing install's receipt records the path it
// was made under, so there the link has to go. A platform without the
// no-follow opens refuses uninstall too, even when nothing is installed.
//
// Above the first declared root that covers a path the walk also reads every
// component, and refuses a symbolic link there unless root owns it, so a link
// a user made (/data/me -> /mnt/disk/me) is refused while the system links
// /var -> /private/var (macOS) and /home -> /var/home (Fedora Atomic) cannot
// make an ordinary install fail.
//
// An upgrade also prunes (#4302): a listed skill file that the new package no
// longer ships is removed when it still matches the receipt, and refused
// before any write when it does not. The prune runs after the new payload is
// installed and listed, one file at a time, and is never part of a rollback.
//
// Open risks, accepted for the operator (see #4242 and #4303):
// - a symbolic link above a declared root that root owns is trusted;
// - a window remains between a containment check and the act that follows it.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as nodeFs from 'node:fs';
import { hostname, tmpdir } from 'node:os';
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
import { fileURLToPath } from 'node:url';
import { resolveBundleRoot } from './bundle-root.mts';
import {
  assertHelperEntryClosureResolvable,
  readHelperExtraRuntimeFiles,
  resolveHelperEntryClosure,
} from './helper-runtime-manifest.mts';
import { resolveInstalledPayloadRoot } from './idd-activation.mts';
import { isQualifiedConfigRoot } from './idd-config.mts';
import {
  ENTRY_FILE_NAME,
  ENTRY_HARNESSES,
  type EntryHarness,
  type EntryStep,
  type EntryTarget,
  isInstallerWholeFile,
  planEntryFiles,
  planEntryRemoval,
} from './user-global-entry-files.mts';
import {
  assertRealChain,
  type ContainmentResult,
  checkContainment,
  createDirectory,
  type FsOps,
  removeSingleEntry,
  replaceFileByRename,
  repointCurrent,
  withCeilings,
  writeNewFile,
  writeNewFileAtomically,
} from './user-global-paths.mts';
import {
  findStaleReceiptTemps,
  type ReceiptEntry,
  readReceipt,
  writeReceipt,
} from './user-global-receipt.mts';
import {
  checkSchemaKeywords,
  validate as validateSchema,
} from './validate-schemas.mts';

/** Options shared by every entry point. Tests inject the fields they need. */
export interface UserGlobalOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  sourceRoot?: string;
  version?: string;
  fs?: FsOps;
  /** The harnesses whose entry file install edits. Empty edits none. */
  harnesses?: readonly EntryHarness[];
}

/** The lines an entry point reports, one per path. */
export interface UserGlobalResult {
  lines: string[];
  priorCurrentTarget: string | null;
}

/**
 * What a plan or an install reports. `version` is the package.json version
 * the payload was (or would be) installed under, so a caller can name that
 * exact version without reading package.json a second time (#4245).
 */
export interface UserGlobalInstallResult extends UserGlobalResult {
  version: string;
}

/** Provenance attached to one immutable source tree. */
export interface DistributionProvenance {
  kind: 'checkout' | 'archive';
  commit: string;
}

/** The command used to identify the helper component in a prepared set. */
export interface DistributionInvocation {
  command: string;
  argv: string[];
}

/** Inputs to the explicit user-global distribution preparation operation. */
export interface PrepareDistributionOptions extends UserGlobalOptions {
  sourceRoot: string;
  sourceCommit: string;
  provenance: DistributionProvenance;
  invocation: DistributionInvocation;
}

/** The verified immutable set that was created or safely reused. */
export interface PreparedDistributionResult {
  sourceCommit: string;
  preparedPath: string;
  fileCount: number;
  reused: boolean;
}

interface Root {
  name: string;
  path: string;
}

interface Context {
  fs: FsOps;
  dataRoot: string;
  preparedRoot: string;
  currentPath: string;
  roots: Root[];
  /** The containment base each harness directory is walked from. */
  entryBases: Record<EntryHarness, string>;
}

interface Target {
  dest: string;
  text: string;
  sha256: string;
}

/**
 * The version pattern from issue #4242, duplicated here because #4242 keeps
 * it private. Keep it in step with `user-global-paths.mts`.
 */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PREPARED_MANIFEST_NAME = 'manifest.json';
const CHECKOUT_GIT_MAX_BUFFER_BYTES = 1024 * 1024 * 1024;

const CURRENT = 'current';
const PAYLOAD_BLOCK_ID = 'idd-template-core-files';
const PAYLOAD_EXTRA_FILES = ['idd-template/user-global/entry.md'];
const SKILL_NAMES = ['issue-authoring', 'idd-spec-audit'];
const SKILL_ROOT_NAMES = ['claude-skills', 'agents-skills'];
const HARNESS_ROOT_NAMES = ['claude', 'codex', 'opencode'];
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FS: FsOps = nodeFs;

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

function lstatOrNull(path: string, fs: FsOps): Stats | null {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Refuse when a crashed run left `<path>.tmp-<digits>` beside `path`. The
 * replacement and repoint primitives refuse that case too, and checking it
 * here keeps the refusal before any write rather than in the middle of a run.
 * A removal creates no temporary file, but the leftover still marks a crashed
 * run on that path, so a prune refuses it too (#4302).
 */
function refuseStaleTemp(
  path: string,
  fs: FsOps,
  action: 'replace' | 'remove' | 'drop the receipt entry for' = 'replace',
): void {
  let names: string[];
  try {
    names = fs.readdirSync(dirname(path));
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  const base = basename(path).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${base}\\.tmp-[0-9]+$`);
  const stale = names.find((name) => pattern.test(name));
  if (stale !== undefined) {
    throw new Error(
      `${join(dirname(path), stale)} exists, so a crashed run left it behind; refusing to ${action} ${path}; remove it by hand before installing`,
    );
  }
}

function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The bytes of a regular file, opened without following a link. */
function readNoFollowBytes(path: string, fs: FsOps): Buffer {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (noFollow === undefined || nonBlock === undefined) {
    throw new Error(
      'this platform does not support the no-follow opens the installer needs; refusing',
    );
  }
  const fd = fs.openSync(path, nodeFs.constants.O_RDONLY | noFollow | nonBlock);
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Refuse when the parent of a path that must be created is absent or is not
 * a real directory. `#4242` creates only the root, with one non-recursive
 * mkdir, and never anything above it.
 */
function assertRealParent(root: string, fs: FsOps): void {
  const parent = dirname(root);
  let stat: Stats | null;
  try {
    stat = lstatOrNull(parent, fs);
  } catch (error) {
    throw new Error(
      `cannot inspect the parent ${parent} of ${root} (${describe(error)}); nothing was written`,
    );
  }
  if (stat === null) {
    throw new Error(
      `the parent ${parent} of ${root} does not exist, and the installer does not create it; nothing was written`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `the parent ${parent} of ${root} is not a real directory; nothing was written`,
    );
  }
}

/**
 * An environment-derived root, normalized. The containment walk requires a
 * normalized path, and `isQualifiedConfigRoot` accepts a `..` segment.
 */
function qualifiedValue(value: string | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && isQualifiedConfigRoot(trimmed)
    ? normalize(trimmed)
    : undefined;
}

function resolveContext(options: UserGlobalOptions): Context {
  const env = options.env ?? process.env;
  const fs = options.fs ?? DEFAULT_FS;
  const payloadRoot = resolveInstalledPayloadRoot({
    env,
    homedir: options.homedir,
  });
  if (payloadRoot === undefined) {
    throw new Error(
      'the payload root does not resolve: neither XDG_DATA_HOME nor HOME is a qualified root; nothing was written',
    );
  }
  const dataRoot = dirname(payloadRoot);
  const homeCandidate =
    typeof options.homedir === 'string' && options.homedir.length > 0
      ? options.homedir
      : (env.HOME ?? '');
  // Qualified before it is normalized. normalize() folds a leading "//" to "/",
  // which would let an unqualified HOME through.
  const trimmedHome = homeCandidate.trim();
  if (!isQualifiedConfigRoot(trimmedHome)) {
    throw new Error(
      'HOME is not a qualified root, so the skill roots do not resolve; nothing was written',
    );
  }
  // Normalized, as the environment roots are, so the containment walk and the
  // harness paths spell the base the same way.
  const home = normalize(trimmedHome);
  const codexHome = qualifiedValue(env.CODEX_HOME) ?? join(home, '.codex');
  const configHome =
    qualifiedValue(env.XDG_CONFIG_HOME) ?? join(home, '.config');
  const codexFromEnv = qualifiedValue(env.CODEX_HOME) !== undefined;
  const configFromEnv = qualifiedValue(env.XDG_CONFIG_HOME) !== undefined;
  // The roots the operator named, HOME first: the first one that covers a path
  // is where the strict chain starts, and a link above it is tolerated only
  // when root owns it. A CODEX_HOME declares its parent, which is the base the
  // entry-file walk starts from.
  const dataHome = qualifiedValue(env.XDG_DATA_HOME);
  const ceilings = [home];
  if (dataHome !== undefined) ceilings.push(dataHome);
  if (codexFromEnv) ceilings.push(dirname(codexHome));
  if (configFromEnv) ceilings.push(configHome);
  return {
    fs: withCeilings(fs, ceilings),
    dataRoot,
    preparedRoot: join(dataRoot, 'prepared'),
    currentPath: join(dataRoot, CURRENT),
    entryBases: {
      claude: home,
      // A CODEX_HOME names the harness directory itself, so it is walked from
      // its parent; the default is walked from the home directory.
      codex: codexFromEnv ? dirname(codexHome) : home,
      opencode: configFromEnv ? configHome : home,
    },
    roots: [
      { name: 'data', path: dataRoot },
      { name: 'prepared', path: join(dataRoot, 'prepared') },
      { name: 'claude', path: join(home, '.claude') },
      { name: 'claude-skills', path: join(home, '.claude', 'skills') },
      { name: 'agents-skills', path: join(home, '.agents', 'skills') },
      { name: 'codex', path: codexHome },
      { name: 'opencode', path: join(configHome, 'opencode') },
    ],
  };
}

function rootNamed(ctx: Context, name: string): Root {
  const root = ctx.roots.find((candidate) => candidate.name === name);
  if (root === undefined) throw new Error(`no ${name} root resolved`);
  return root;
}

/** The path below `base` as segments, or null when it is not below `base`. */
function segmentsUnder(base: string, path: string): string[] | null {
  const rel = relative(base, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep);
}

/**
 * Whether a listed path has a shape the installer creates: the data root, a
 * version directory and what is under it, a skill directory and its files, or
 * the skill roots themselves. A receipt can be hand-edited, so an entry at any
 * other path is refused rather than trusted as the installer's.
 */
function ownedShape(ctx: Context, entry: ReceiptEntry): boolean {
  const data = segmentsUnder(ctx.dataRoot, entry.path);
  if (data !== null && data[0] === 'prepared') {
    if (entry.kind !== 'directory' && entry.kind !== 'file') return false;
    if (data.length === 1) return entry.kind === 'directory';
    if (!SOURCE_COMMIT_PATTERN.test(data[1])) return false;
    if (data.length === 2) return entry.kind === 'directory';
    return true;
  }
  if (entry.kind === 'link') return true;
  if (entry.kind === 'managed-block' || entry.kind === 'json-instruction') {
    return entryFileOwned(ctx, entry);
  }
  if (entryFileOwned(ctx, entry)) return true;
  const isDir = entry.kind === 'directory';
  if (isDir && entry.path === ctx.dataRoot) return true;
  if (
    data !== null &&
    VERSION_PATTERN.test(data[0]) &&
    (isDir || data.length >= 2)
  ) {
    return true;
  }
  for (const name of SKILL_ROOT_NAMES) {
    const skill = segmentsUnder(rootNamed(ctx, name).path, entry.path);
    if (skill === null) continue;
    if (SKILL_NAMES.includes(skill[0]) && (isDir || skill.length >= 2)) {
      return true;
    }
  }
  if (
    isDir &&
    [...SKILL_ROOT_NAMES, ...HARNESS_ROOT_NAMES].some(
      (name) => rootNamed(ctx, name).path === entry.path,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Refuse when the chain from the harness's walk base down to its directory is
 * not all real directories. A rewrite through a link above the directory
 * would otherwise land outside the harness, so uninstall checks the chain too.
 */
function assertHarnessChain(
  ctx: Context,
  path: string,
  present: boolean,
): void {
  const harness = ENTRY_HARNESSES.find(
    (name) => join(harnessDirOf(ctx, name), ENTRY_FILE_NAME[name]) === path,
  );
  if (harness === undefined) return;
  const dir = harnessDirOf(ctx, harness);
  // checkContainment throws on a link above the directory, so an absent entry
  // is checked too. A genuinely removed directory still reads as absent.
  const walk = checkContainment(ctx.entryBases[harness], dir, ctx.fs);
  if (
    walk.finalKind === 'symlink' ||
    walk.finalKind === 'file' ||
    (present && walk.finalKind !== 'directory')
  ) {
    throw new Error(
      `${dir} is ${walk.finalKind === 'symlink' ? 'a symbolic link' : `not a directory (${walk.finalKind})`} on the path to ${path}; refusing`,
    );
  }
}

/** The harness whose entry file sits at `path`, or undefined. */
function entryHarnessAt(ctx: Context, path: string): EntryHarness | undefined {
  return ENTRY_HARNESSES.find(
    (name) => join(harnessDirOf(ctx, name), ENTRY_FILE_NAME[name]) === path,
  );
}

/**
 * The entry text of every version directory the receipt lists, for the Codex
 * whole-file check on both install (before a rewrite) and uninstall (before a
 * removal). Install renders the text between the markers from one of these,
 * and `AGENTS.md` can hold an older version's text after a later install that
 * selected no harness. A text counts only when its bytes hash to that record.
 * A file that is gone or changed is skipped here, so a block that only that
 * text could vouch for fails the check and the run refuses.
 */
function recordedEntryTexts(
  ctx: Context,
  entries: ReadonlyMap<string, ReceiptEntry>,
): string[] {
  const texts: string[] = [];
  for (const entry of entries.values()) {
    if (entry.kind !== 'file') continue;
    const data = segmentsUnder(ctx.dataRoot, entry.path);
    if (
      data === null ||
      data.length !== 3 ||
      !VERSION_PATTERN.test(data[0]) ||
      data[1] !== 'user-global' ||
      data[2] !== 'entry.md'
    ) {
      continue;
    }
    try {
      const bytes = readNoFollowBytes(entry.path, ctx.fs);
      if (sha256Hex(bytes) === entry.sha256) texts.push(bytes.toString('utf8'));
    } catch {
      // Skipped; see above.
    }
  }
  return texts;
}

/** The harness directory a harness's entry file lives in. */
function harnessDirOf(ctx: Context, harness: EntryHarness): string {
  return rootNamed(ctx, harness).path;
}

/** The entry-file targets for the selected harnesses, in install order. */
function entryTargetsOf(
  ctx: Context,
  harnesses: readonly EntryHarness[],
): EntryTarget[] {
  return ENTRY_HARNESSES.filter((harness) => harnesses.includes(harness)).map(
    (harness) => ({
      harness,
      dir: harnessDirOf(ctx, harness),
      walkBase: ctx.entryBases[harness],
    }),
  );
}

/**
 * Whether a listed entry file sits at the one path its harness reads. The
 * kinds it may hold are fixed too: a managed block only in a Markdown file, a
 * JSON instruction only in opencode.json, and a whole file in any of the three.
 */
function entryFileOwned(ctx: Context, entry: ReceiptEntry): boolean {
  const claude = join(harnessDirOf(ctx, 'claude'), ENTRY_FILE_NAME.claude);
  const codex = join(harnessDirOf(ctx, 'codex'), ENTRY_FILE_NAME.codex);
  const opencode = join(
    harnessDirOf(ctx, 'opencode'),
    ENTRY_FILE_NAME.opencode,
  );
  if (entry.kind === 'managed-block') {
    return entry.path === claude || entry.path === codex;
  }
  if (entry.kind === 'json-instruction') return entry.path === opencode;
  if (entry.kind === 'file') {
    return (
      entry.path === claude || entry.path === codex || entry.path === opencode
    );
  }
  return false;
}

function assertOwnedShape(ctx: Context, entry: ReceiptEntry): void {
  if (!ownedShape(ctx, entry)) {
    throw new Error(
      `${entry.path} is not a path the installer creates; the receipt does not own it, so refusing`,
    );
  }
}

function isWithin(root: string, path: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}

/**
 * The deepest root that contains `path`. A path under no root is refused,
 * and so is a path under two roots that neither contains the other. Nested
 * roots therefore resolve to the deeper one.
 */
function rootFor(ctx: Context, path: string): Root {
  const containing = ctx.roots.filter((root) => isWithin(root.path, path));
  if (containing.length === 0) {
    throw new Error(`${path} is under no root; refusing it`);
  }
  const deepest = containing.reduce((best, root) =>
    root.path.length > best.path.length ? root : best,
  );
  const other = containing.find((root) => !isWithin(root.path, deepest.path));
  if (other !== undefined) {
    throw new Error(
      `${path} is under two roots (${other.path} and ${deepest.path}) that neither contains the other; refusing it`,
    );
  }
  return deepest;
}

interface Inspected {
  root: Root;
  base: string;
  walk: ContainmentResult;
}

/**
 * The containment base for a path under `root`. A path that equals its root
 * is walked from its parent, since a root is never a containment base for
 * itself.
 */
function baseOf(root: Root, path: string): string {
  return path === root.path ? dirname(path) : root.path;
}

/** Walk one path with no-follow stats. */
function inspect(ctx: Context, path: string): Inspected {
  const root = rootFor(ctx, path);
  const base = baseOf(root, path);
  const walk = checkContainment(base, path, ctx.fs);
  return { root, base, walk };
}

function assertCurrentTarget(
  ctx: Context,
  priorTarget: string,
  fs: FsOps,
): void {
  const resolved = resolve(ctx.dataRoot, priorTarget);
  if (
    normalize(priorTarget) !== priorTarget ||
    dirname(resolved) !== ctx.dataRoot ||
    !VERSION_PATTERN.test(basename(resolved))
  ) {
    throw new Error(
      `${ctx.currentPath} targets ${priorTarget}, which is not a version directory directly under the data root; refusing to replace it`,
    );
  }
  const stat = lstatOrNull(resolved, fs);
  if (stat === null) {
    throw new Error(
      `${ctx.currentPath} is a dangling link to ${resolved}; refusing to replace it`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `${ctx.currentPath} targets ${resolved}, which is not a real directory; refusing to replace it`,
    );
  }
}

/** Every regular file under `dir`, relative to it, sorted. Links refuse. */
function listSourceFiles(dir: string, fs: FsOps, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `${join(dir, rel)} is a symbolic link in the source tree; refusing`,
      );
    }
    if (entry.isDirectory()) {
      found.push(...listSourceFiles(dir, fs, rel));
    } else if (entry.isFile()) {
      found.push(rel);
    } else {
      throw new Error(`${join(dir, rel)} is not a regular file; refusing`);
    }
  }
  return found.sort();
}

function readSource(path: string, fs: FsOps): { text: string; sha256: string } {
  const stat = fs.lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(
      `${path} is not a regular file in the source tree; refusing`,
    );
  }
  const bytes = fs.readFileSync(path);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(
      `${path} is not UTF-8 text; the installer copies text only`,
    );
  }
  return { text, sha256: sha256Hex(bytes) };
}

interface PreparedSourceFile {
  sourcePath: string;
  storedPath: string;
  componentPath: string;
  bytes: Buffer;
  sha256: string;
  executable: boolean;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function isSafeRelativeFilePath(path: string): boolean {
  return (
    path.length > 0 &&
    !isAbsolute(path) &&
    !path.includes('\\') &&
    !/[\r\n\u2028\u2029]/.test(path) &&
    path
      .split('/')
      .every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

/** Verify a supplied source path is a chain of real directories and a file. */
function assertSourceFilePath(
  sourceRoot: string,
  path: string,
  fs: FsOps,
): string {
  if (!isSafeRelativeFilePath(path)) {
    throw new Error(`source path ${path} is not a safe relative file path`);
  }
  const rootStat = fs.lstatSync(sourceRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`${sourceRoot} is not a real source directory`);
  }
  const parts = path.split('/');
  let current = sourceRoot;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`${current} is a symbolic link in the source tree`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`${current} is not a directory in the source tree`);
    }
    if (index === parts.length - 1 && !stat.isFile()) {
      throw new Error(`${current} is not a regular file in the source tree`);
    }
  }
  return current;
}

function readSourceBytes(sourceRoot: string, path: string, fs: FsOps): Buffer {
  return readNoFollowBytes(assertSourceFilePath(sourceRoot, path, fs), fs);
}

function parseJsonBytes(bytes: Buffer, label: string): unknown {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not UTF-8 JSON`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON (${describe(error)})`);
  }
}

function repositoryWebUrl(packageJson: unknown): string {
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    !('repository' in packageJson)
  ) {
    throw new Error('package.json has no repository URL');
  }
  const repository = packageJson.repository;
  const value =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' &&
          repository !== null &&
          'url' in repository &&
          typeof repository.url === 'string'
        ? repository.url
        : '';
  let url: URL;
  if (value.startsWith('github:')) {
    url = new URL(`https://github.com/${value.slice('github:'.length)}`);
  } else {
    const normalized = value.startsWith('git+') ? value.slice(4) : value;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(
        `package.json repository ${value} is not an HTTPS forge URL`,
      );
    }
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.length !== 2
  ) {
    throw new Error(
      `package.json repository ${value} is not an HTTPS forge URL`,
    );
  }
  const repo = segments[1].replace(/\.git$/, '');
  if (
    !/^[A-Za-z0-9_.-]+$/.test(segments[0]) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    throw new Error(
      `package.json repository ${value} has invalid owner/repository segments`,
    );
  }
  return `${url.origin}/${segments[0]}/${repo}`;
}

function componentListing(files: PreparedSourceFile[]): {
  files: { path: string; sha256: string }[];
  digest: string;
} {
  const sorted = [...files].sort((left, right) =>
    compareUtf8(left.componentPath, right.componentPath),
  );
  const seen = new Set<string>();
  for (const file of sorted) {
    if (seen.has(file.componentPath)) {
      throw new Error(`component path ${file.componentPath} is duplicated`);
    }
    seen.add(file.componentPath);
  }
  const listing = sorted
    .map((file) => `${file.sha256} ${file.componentPath}\n`)
    .join('');
  return {
    files: sorted.map(({ componentPath, sha256 }) => ({
      path: componentPath,
      sha256,
    })),
    digest: `sha256:${sha256Hex(listing)}`,
  };
}

function readHelperExtraRuntimeFilesFromBytes(
  sourceRoot: string,
  sourceBytes: Buffer,
): Map<string, string[]> {
  if (!Buffer.from(sourceBytes.toString('utf8'), 'utf8').equals(sourceBytes)) {
    throw new Error('helper runtime manifest is not UTF-8 text');
  }
  const availablePaths = readHelperExtraRuntimeFiles(sourceRoot);
  const root = nodeFs.mkdtempSync(join(tmpdir(), 'idd-helper-runtime-'));
  const path = join(root, 'src/scripts/helper-runtime-manifest.mts');
  try {
    nodeFs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    nodeFs.writeFileSync(path, sourceBytes, { flag: 'wx', mode: 0o600 });
    const referencedPaths = new Set([
      ...availablePaths.keys(),
      ...[...availablePaths.values()].flat(),
    ]);
    for (const referencedPath of referencedPaths) {
      if (referencedPath === 'src/scripts/helper-runtime-manifest.mts') {
        continue;
      }
      if (!isSafeRelativeFilePath(referencedPath)) {
        throw new Error(
          `helper runtime manifest contains an unsafe path ${referencedPath}`,
        );
      }
      const placeholder = join(root, referencedPath);
      nodeFs.mkdirSync(dirname(placeholder), { recursive: true, mode: 0o700 });
      nodeFs.writeFileSync(placeholder, Buffer.alloc(0), {
        flag: 'wx',
        mode: 0o600,
      });
    }
    return readHelperExtraRuntimeFiles(root);
  } finally {
    nodeFs.rmSync(root, { recursive: true, force: true });
  }
}

interface CheckoutTreeEntry {
  mode: string;
  type: string;
  oid: string;
}

function verifyCheckoutFiles(
  sourceRoot: string,
  sourceCommit: string,
  files: ReadonlyMap<string, Buffer>,
  skillComponents: ReadonlyMap<string, PreparedSourceFile[]>,
): Map<string, CheckoutTreeEntry> {
  try {
    execFileSync(
      'git',
      ['-C', sourceRoot, 'cat-file', '-e', `${sourceCommit}^{commit}`],
      {
        stdio: 'ignore',
      },
    );
  } catch (error) {
    throw new Error(
      `checkout source commit ${sourceCommit} is unavailable (${describe(error)})`,
    );
  }
  const treeBytes = execFileSync(
    'git',
    ['-C', sourceRoot, 'ls-tree', '-r', '-z', '--full-tree', sourceCommit],
    {
      encoding: 'buffer',
      maxBuffer: CHECKOUT_GIT_MAX_BUFFER_BYTES,
    },
  ) as Buffer;
  const tree = new Map<string, CheckoutTreeEntry>();
  for (const record of treeBytes.toString('utf8').split('\0')) {
    if (record.length === 0) continue;
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('git ls-tree returned a malformed entry');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (mode === undefined || type === undefined || oid === undefined) {
      throw new Error('git ls-tree returned a malformed entry');
    }
    tree.set(path, { mode, type, oid });
  }

  for (const [skill, componentFiles] of skillComponents) {
    const root = `skills/${skill}/`;
    const committedPaths = [...tree.entries()]
      .filter(([path]) => path.startsWith(root))
      .map(([path, entry]) => {
        if (
          entry.type !== 'blob' ||
          !['100644', '100755'].includes(entry.mode)
        ) {
          throw new Error(`${path} is not a regular committed skill file`);
        }
        return path;
      })
      .sort(compareUtf8);
    const checkoutPaths = componentFiles
      .map((file) => file.sourcePath)
      .sort(compareUtf8);
    if (
      committedPaths.length !== checkoutPaths.length ||
      committedPaths.some((path, index) => path !== checkoutPaths[index])
    ) {
      throw new Error(
        `${root.slice(0, -1)} file inventory differs from source commit ${sourceCommit}`,
      );
    }
  }

  for (const [path, workingBytes] of files) {
    const entry = tree.get(path);
    if (entry === undefined || entry.type !== 'blob') {
      throw new Error(
        `${path} is not present as a file in source commit ${sourceCommit}`,
      );
    }
    let committedBytes: Buffer;
    try {
      committedBytes = execFileSync(
        'git',
        ['-C', sourceRoot, 'cat-file', 'blob', entry.oid],
        {
          encoding: 'buffer',
          maxBuffer: CHECKOUT_GIT_MAX_BUFFER_BYTES,
        },
      ) as Buffer;
    } catch (error) {
      throw new Error(
        `${path} could not be read from source commit ${sourceCommit} (${describe(error)})`,
      );
    }
    if (!workingBytes.equals(committedBytes)) {
      throw new Error(`${path} differs from source commit ${sourceCommit}`);
    }
    if (!['100644', '100755'].includes(entry.mode)) {
      throw new Error(
        `${path} is not a regular file in source commit ${sourceCommit}`,
      );
    }
  }
  return tree;
}

interface PreparedSetBuild {
  sourceCommit: string;
  setRoot: string;
  files: PreparedSourceFile[];
  manifestBytes: Buffer;
  manifestSha256: string;
}

function assertSourceDirectoryPath(
  sourceRoot: string,
  path: string,
  fs: FsOps,
): string {
  if (!isSafeRelativeFilePath(path)) {
    throw new Error(
      `source path ${path} is not a safe relative directory path`,
    );
  }
  const rootStat = fs.lstatSync(sourceRoot);
  if (!rootStat.isDirectory()) {
    throw new Error(`${sourceRoot} is not a real source directory`);
  }
  let current = sourceRoot;
  for (const part of path.split('/')) {
    current = join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${current} is not a real source directory`);
    }
  }
  return current;
}

function buildPreparedSet(
  ctx: Context,
  options: PrepareDistributionOptions,
): PreparedSetBuild {
  const sourceCommit = options.sourceCommit;
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw new Error(
      'sourceCommit must be a full lowercase 40-character commit ID',
    );
  }
  if (
    !['checkout', 'archive'].includes(options.provenance.kind) ||
    options.provenance.commit !== sourceCommit
  ) {
    throw new Error(
      'provenance must name the same sourceCommit and use checkout or archive',
    );
  }
  if (
    !isSafeRelativeFilePath(options.invocation.command) ||
    !Array.isArray(options.invocation.argv) ||
    !options.invocation.argv.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      'invocation must name a safe relative helper path and string arguments',
    );
  }

  const sourceRoot = resolve(options.sourceRoot);
  const fs = ctx.fs;
  const packageBytes = readSourceBytes(sourceRoot, 'package.json', fs);
  const packageJson = parseJsonBytes(packageBytes, 'package.json');
  const repositoryUrl = repositoryWebUrl(packageJson);
  const syncBytes = readSourceBytes(sourceRoot, 'audit/sync-manifest.json', fs);
  const syncManifest = parseJsonBytes(syncBytes, 'audit/sync-manifest.json');
  if (
    typeof syncManifest !== 'object' ||
    syncManifest === null ||
    !('generatedBlocks' in syncManifest)
  ) {
    throw new Error('the sync manifest has no generatedBlocks list');
  }
  const blocks = syncManifest.generatedBlocks;
  if (!Array.isArray(blocks))
    throw new Error('the sync manifest generatedBlocks is not an array');
  const block = blocks.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === PAYLOAD_BLOCK_ID,
  );
  if (
    typeof block !== 'object' ||
    block === null ||
    !('stripPrefix' in block) ||
    block.stripPrefix !== 'idd-template/' ||
    !('paths' in block) ||
    !Array.isArray(block.paths) ||
    !block.paths.every((path: unknown) => typeof path === 'string')
  ) {
    throw new Error(`the sync manifest has no valid ${PAYLOAD_BLOCK_ID} block`);
  }

  const makeFile = (
    sourcePath: string,
    storedPath: string,
    componentPath: string,
  ): PreparedSourceFile => {
    if (
      !isSafeRelativeFilePath(sourcePath) ||
      !isSafeRelativeFilePath(storedPath) ||
      !isSafeRelativeFilePath(componentPath)
    ) {
      throw new Error(
        `distribution path ${sourcePath} is not a safe relative path`,
      );
    }
    const sourcePathOnDisk = assertSourceFilePath(sourceRoot, sourcePath, fs);
    const sourceStat = fs.lstatSync(sourcePathOnDisk);
    const bytes = readNoFollowBytes(sourcePathOnDisk, fs);
    return {
      sourcePath,
      storedPath,
      componentPath,
      bytes,
      sha256: sha256Hex(bytes),
      executable: (sourceStat.mode & 0o111) !== 0,
    };
  };

  const instructions = [...block.paths, ...PAYLOAD_EXTRA_FILES].map((path) => {
    if (!path.startsWith('idd-template/')) {
      throw new Error(`payload path ${path} lacks the idd-template/ prefix`);
    }
    const componentPath = path.slice('idd-template/'.length);
    return makeFile(path, `idd-template/${componentPath}`, componentPath);
  });
  const skillComponents = new Map<string, PreparedSourceFile[]>();
  for (const skill of SKILL_NAMES) {
    const skillRoot = `skills/${skill}`;
    const skillDir = assertSourceDirectoryPath(sourceRoot, skillRoot, fs);
    const paths = listSourceFiles(skillDir, fs).sort(compareUtf8);
    if (!paths.includes('SKILL.md')) {
      throw new Error(`${skillRoot} has no SKILL.md`);
    }
    skillComponents.set(
      skill,
      paths.map((path) =>
        makeFile(`${skillRoot}/${path}`, `${skillRoot}/${path}`, path),
      ),
    );
  }
  const helperRuntimeManifestBytes = readSourceBytes(
    sourceRoot,
    'src/scripts/helper-runtime-manifest.mts',
    fs,
  );
  assertSourceFilePath(sourceRoot, options.invocation.command, fs);
  const extraRuntimeFiles = readHelperExtraRuntimeFilesFromBytes(
    sourceRoot,
    helperRuntimeManifestBytes,
  );
  assertHelperEntryClosureResolvable(options.invocation.command, {
    packageRoot: sourceRoot,
    extraRuntimeFiles,
  });
  const helperPaths = [
    ...new Set(
      resolveHelperEntryClosure(options.invocation.command, {
        packageRoot: sourceRoot,
        extraRuntimeFiles,
      }),
    ),
  ].sort(compareUtf8);
  const helper = helperPaths.map((path) => makeFile(path, path, path));
  if (!helperPaths.includes(options.invocation.command)) {
    throw new Error('invocation.command is not in the helper entry closure');
  }

  const allFiles = [
    ...instructions,
    ...skillComponents.values(),
    ...helper,
  ].flat();
  const byStoredPath = new Set<string>();
  for (const file of allFiles) {
    if (
      file.storedPath === PREPARED_MANIFEST_NAME ||
      byStoredPath.has(file.storedPath)
    ) {
      throw new Error(
        `distribution path ${file.storedPath} is duplicated or reserved`,
      );
    }
    byStoredPath.add(file.storedPath);
  }

  const provenance = {
    kind: options.provenance.kind,
    commit: sourceCommit,
  };
  const location = (path: string): string =>
    `${repositoryUrl}/tree/${sourceCommit}${path ? `/${path}` : ''}`;
  const component = (path: string, files: PreparedSourceFile[]) => ({
    location: location(path),
    provenance,
    ...componentListing(files),
  });
  const manifest = {
    schemaVersion: 1,
    sourceCommit,
    components: {
      instructions: component('idd-template', instructions),
      skillBundles: {
        'issue-authoring': component(
          'skills/issue-authoring',
          skillComponents.get('issue-authoring') ?? [],
        ),
        'idd-spec-audit': component(
          'skills/idd-spec-audit',
          skillComponents.get('idd-spec-audit') ?? [],
        ),
      },
      helper: {
        ...component('', helper),
        invocation: {
          command: options.invocation.command,
          argv: [...options.invocation.argv],
        },
      },
    },
  };
  const schemaBytes = readSourceBytes(
    sourceRoot,
    'schemas/distribution-manifest.schema.json',
    fs,
  );
  const schema = parseJsonBytes(
    schemaBytes,
    'schemas/distribution-manifest.schema.json',
  );
  const schemaErrors = checkSchemaKeywords(schema);
  if (schemaErrors.length > 0) {
    throw new Error(
      `distribution manifest schema has unsupported keywords: ${schemaErrors.join('; ')}`,
    );
  }
  const manifestErrors = validateSchema(manifest, schema);
  if (manifestErrors.length > 0) {
    throw new Error(
      `generated distribution manifest is invalid: ${manifestErrors.join('; ')}`,
    );
  }

  if (options.provenance.kind === 'checkout') {
    const checkoutFiles = new Map<string, Buffer>([
      ['package.json', packageBytes],
      ['audit/sync-manifest.json', syncBytes],
      ['schemas/distribution-manifest.schema.json', schemaBytes],
      ['src/scripts/helper-runtime-manifest.mts', helperRuntimeManifestBytes],
      ...allFiles.map((file) => [file.sourcePath, file.bytes] as const),
    ]);
    const tree = verifyCheckoutFiles(
      sourceRoot,
      sourceCommit,
      checkoutFiles,
      skillComponents,
    );
    for (const file of allFiles) {
      const entry = tree.get(file.sourcePath);
      if (entry === undefined) {
        throw new Error(
          `${file.sourcePath} is absent from source commit ${sourceCommit}`,
        );
      }
      file.executable = entry.mode === '100755';
    }
  }

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  return {
    sourceCommit,
    setRoot: join(ctx.preparedRoot, sourceCommit),
    files: allFiles,
    manifestBytes,
    manifestSha256: sha256Hex(manifestBytes),
  };
}

interface PreparedTreeSnapshot {
  directories: Set<string>;
  files: Set<string>;
  temporaryFiles: Set<string>;
}

function scanPreparedTree(
  root: string,
  fs: FsOps,
  expectedFiles: ReadonlyMap<string, Buffer>,
): PreparedTreeSnapshot {
  const directories = new Set<string>();
  const files = new Set<string>();
  const temporaryFiles = new Set<string>();
  const stats = new Map<string, Stats>();
  const visit = (directory: string): void => {
    directories.add(directory);
    for (const name of fs.readdirSync(directory)) {
      const path = join(directory, name);
      const stat = fs.lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`${path} is a symbolic link in the prepared set`);
      }
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        stats.set(path, stat);
        if (/\.idd-prepared-tmp-[0-9]+$/u.test(name)) {
          temporaryFiles.add(path);
        } else {
          files.add(path);
        }
      } else {
        throw new Error(`${path} is not a regular file or directory; refusing`);
      }
    }
  };
  visit(root);

  for (const path of temporaryFiles) {
    const suffix = basename(path).match(/^(.*)\.idd-prepared-tmp-[0-9]+$/u);
    if (suffix === null)
      throw new Error(`${path} has an invalid temporary name`);
    const target = join(dirname(path), suffix[1] ?? '');
    const expected = expectedFiles.get(target);
    const stat = stats.get(path);
    if (expected === undefined || stat === undefined) {
      throw new Error(
        `${path} is an unrecognized temporary file in the prepared set`,
      );
    }
    const bytes = readNoFollowBytes(path, fs);
    if (
      bytes.length > expected.length ||
      !expected.subarray(0, bytes.length).equals(bytes)
    ) {
      throw new Error(`${path} is not a prefix of its expected prepared file`);
    }
    if (stat.nlink > 1) {
      const finalStat = stats.get(target);
      if (
        !bytes.equals(expected) ||
        stat.nlink !== 2 ||
        finalStat === undefined ||
        finalStat.dev !== stat.dev ||
        finalStat.ino !== stat.ino ||
        finalStat.nlink !== 2
      ) {
        throw new Error(`${path} has more than one hard link; refusing`);
      }
    }
  }
  for (const path of files) {
    const stat = stats.get(path);
    if (stat === undefined) throw new Error(`${path} could not be inspected`);
    if (stat.nlink > 1) {
      const pairedTemp = [...temporaryFiles].some((tempPath) => {
        const suffix = basename(tempPath).match(
          /^(.*)\.idd-prepared-tmp-[0-9]+$/u,
        );
        const tempStat = stats.get(tempPath);
        return (
          suffix !== null &&
          join(dirname(tempPath), suffix[1] ?? '') === path &&
          tempStat !== undefined &&
          tempStat.dev === stat.dev &&
          tempStat.ino === stat.ino &&
          tempStat.nlink === 2 &&
          stat.nlink === 2
        );
      });
      if (!pairedTemp)
        throw new Error(`${path} has more than one hard link; refusing`);
    }
  }
  return { directories, files, temporaryFiles };
}

function sameReceiptEntry(
  actual: ReceiptEntry | undefined,
  expected: ReceiptEntry,
): boolean {
  if (actual === undefined || actual.kind !== expected.kind) return false;
  if (actual.kind === 'file' && expected.kind === 'file') {
    return actual.sha256 === expected.sha256;
  }
  return actual.kind === 'directory' && expected.kind === 'directory';
}

function preparedExpectedEntries(build: PreparedSetBuild): {
  directories: string[];
  files: Map<string, Buffer>;
  fileEntries: Map<string, ReceiptEntry>;
  fileModes: Map<string, number>;
  directoryEntries: Map<string, ReceiptEntry>;
} {
  const manifestPath = join(build.setRoot, PREPARED_MANIFEST_NAME);
  const files = new Map<string, Buffer>();
  const fileEntries = new Map<string, ReceiptEntry>();
  const fileModes = new Map<string, number>();
  const directorySet = new Set<string>([build.setRoot]);
  for (const file of build.files) {
    const destination = join(build.setRoot, file.storedPath);
    files.set(destination, file.bytes);
    fileEntries.set(destination, {
      kind: 'file',
      path: destination,
      sha256: file.sha256,
    });
    fileModes.set(destination, file.executable ? 0o755 : 0o644);
    let directory = dirname(destination);
    while (
      directory !== build.setRoot &&
      directory.startsWith(`${build.setRoot}${sep}`)
    ) {
      directorySet.add(directory);
      directory = dirname(directory);
    }
  }
  files.set(manifestPath, build.manifestBytes);
  fileEntries.set(manifestPath, {
    kind: 'file',
    path: manifestPath,
    sha256: build.manifestSha256,
  });
  fileModes.set(manifestPath, 0o644);
  const directories = [...directorySet].sort((left, right) => {
    const depth = left.split(sep).length - right.split(sep).length;
    return depth === 0 ? compareUtf8(left, right) : depth;
  });
  const directoryEntries = new Map<string, ReceiptEntry>([
    [
      dirname(build.setRoot),
      { kind: 'directory', path: dirname(build.setRoot) },
    ],
    ...directories.map(
      (path) => [path, { kind: 'directory', path } as ReceiptEntry] as const,
    ),
  ]);
  for (const filePath of files.keys()) {
    if (directorySet.has(filePath)) {
      throw new Error(
        `${filePath} is both a file and a directory in the prepared layout`,
      );
    }
    let parent = dirname(filePath);
    while (parent.startsWith(`${build.setRoot}${sep}`)) {
      if (files.has(parent)) {
        throw new Error(
          `${parent} is both a file and a parent directory in the prepared layout`,
        );
      }
      parent = dirname(parent);
    }
  }
  return { directories, files, fileEntries, fileModes, directoryEntries };
}

function verifyPreparedTree(
  ctx: Context,
  build: PreparedSetBuild,
  expected: ReturnType<typeof preparedExpectedEntries>,
  receiptEntries: ReadonlyMap<string, ReceiptEntry>,
  options: { requireRecordedExpected: boolean; manifestMustExist: boolean },
): boolean {
  const rootWalk = checkContainment(ctx.preparedRoot, build.setRoot, ctx.fs);
  if (rootWalk.finalKind === 'absent') {
    if (options.manifestMustExist) {
      throw new Error(`${build.setRoot} is missing its published prepared set`);
    }
    return false;
  }
  if (rootWalk.finalKind !== 'directory') {
    throw new Error(
      `${build.setRoot} is ${rootWalk.finalKind}, not a real directory`,
    );
  }
  const snapshot = scanPreparedTree(build.setRoot, ctx.fs, expected.files);
  const expectedDirectories = new Set(expected.directories);
  for (const path of snapshot.directories) {
    if (!expectedDirectories.has(path)) {
      throw new Error(`${path} is an unlisted directory in the prepared set`);
    }
    const expectedEntry = expected.directoryEntries.get(path);
    if (
      expectedEntry === undefined ||
      !sameReceiptEntry(receiptEntries.get(path), expectedEntry)
    ) {
      throw new Error(
        `${path} is not recorded as an owned directory in the receipt`,
      );
    }
  }
  for (const path of snapshot.files) {
    const expectedEntry = expected.fileEntries.get(path);
    if (expectedEntry === undefined || expectedEntry.kind !== 'file') {
      throw new Error(`${path} is an unlisted file in the prepared set`);
    }
    if (!sameReceiptEntry(receiptEntries.get(path), expectedEntry)) {
      throw new Error(
        `${path} is not recorded with its expected hash in the receipt`,
      );
    }
    const expectedMode = expected.fileModes.get(path);
    if (
      expectedMode === undefined ||
      (ctx.fs.lstatSync(path).mode & 0o777) !== expectedMode
    ) {
      throw new Error(
        `${path} has a mode that differs from the prepared source`,
      );
    }
    if (sha256Hex(readNoFollowBytes(path, ctx.fs)) !== expectedEntry.sha256) {
      throw new Error(
        `${path} differs from the source bytes; refusing to reuse or overwrite it`,
      );
    }
  }
  const manifestPath = join(build.setRoot, PREPARED_MANIFEST_NAME);
  const manifestPresent = snapshot.files.has(manifestPath);
  if (options.manifestMustExist && !manifestPresent) {
    throw new Error(
      `${manifestPath} is absent; the prepared identity is not published`,
    );
  }
  if (manifestPresent) {
    const complete =
      expected.directories.every((path) => snapshot.directories.has(path)) &&
      [...expected.files.keys()].every((path) => snapshot.files.has(path));
    if (!complete) {
      throw new Error(
        `${manifestPath} exists but the prepared set is incomplete; refusing`,
      );
    }
  }
  if (options.requireRecordedExpected) {
    for (const entry of expected.directoryEntries.values()) {
      if (!sameReceiptEntry(receiptEntries.get(entry.path), entry)) {
        throw new Error(
          `${entry.path} is not recorded as an owned directory in the receipt`,
        );
      }
    }
    for (const entry of expected.fileEntries.values()) {
      if (!sameReceiptEntry(receiptEntries.get(entry.path), entry)) {
        throw new Error(
          `${entry.path} is not recorded with its expected hash in the receipt`,
        );
      }
    }
  }
  return manifestPresent;
}

function prepareFailureMessage(
  ctx: Context,
  build: PreparedSetBuild,
  expected: ReturnType<typeof preparedExpectedEntries>,
  error: unknown,
): string {
  const marker = join(build.setRoot, PREPARED_MANIFEST_NAME);
  let markerState = 'could not be inspected';
  try {
    const walk = checkContainment(ctx.preparedRoot, marker, ctx.fs);
    markerState = walk.finalKind;
  } catch (inspectError) {
    markerState = `could not be inspected (${describe(inspectError)})`;
  }
  let stagedState = 'none';
  let missingState = 'unavailable';
  try {
    const walk = checkContainment(ctx.preparedRoot, build.setRoot, ctx.fs);
    if (walk.finalKind === 'directory') {
      const snapshot = scanPreparedTree(build.setRoot, ctx.fs, expected.files);
      const present = [
        ...snapshot.directories,
        ...snapshot.files,
        ...snapshot.temporaryFiles,
      ]
        .map((path) => relative(build.setRoot, path).replaceAll(sep, '/'))
        .sort(compareUtf8);
      stagedState =
        present.length > 0 ? present.join(', ') : 'empty candidate directory';
      const expectedPaths = [...expected.directories, ...expected.files.keys()];
      const presentPaths = new Set([
        ...snapshot.directories,
        ...snapshot.files,
      ]);
      const missing = expectedPaths
        .filter((path) => !presentPaths.has(path))
        .map((path) => relative(build.setRoot, path).replaceAll(sep, '/'))
        .sort(compareUtf8);
      missingState = missing.length > 0 ? missing.join(', ') : 'none';
    }
  } catch (stateError) {
    stagedState = `could not be safely enumerated (${describe(stateError)})`;
  }
  let receiptState = 'could not be read';
  try {
    const receipt = readReceipt(ctx.dataRoot, ctx.fs);
    receiptState = receipt.state === 'valid' ? 'valid' : 'missing';
  } catch (receiptError) {
    receiptState = `invalid (${describe(receiptError)})`;
  }
  return `preparing ${build.sourceCommit} failed (${describe(error)}); the completion manifest ${marker} is ${markerState}; staged paths under the candidate are ${stagedState}; expected paths still missing are ${missingState}; receipt state is ${receiptState}; one safe retry is to call prepareDistributionSet again with the identical sourceCommit, provenance and source bytes; if the source is unavailable, remove only candidate paths whose receipt hashes still match`;
}

function withReceiptMutationLock<T>(ctx: Context, operation: () => T): T {
  const fs = ctx.fs;
  const parent = dirname(ctx.dataRoot);
  try {
    assertRealChain(parent, fs);
  } catch (error) {
    throw new Error(`nothing was written or removed; ${describe(error)}`);
  }
  assertRealParent(ctx.dataRoot, fs);
  const lockPath = join(
    parent,
    `.idd-user-global-${sha256Hex(ctx.dataRoot)}.lock`,
  );
  const lockWalk = checkContainment(parent, lockPath, fs);
  if (lockWalk.finalKind !== 'absent') {
    let owner = 'owner record unavailable';
    if (lockWalk.finalKind === 'directory') {
      try {
        const ownerPath = join(lockPath, 'owner.json');
        const ownerWalk = checkContainment(lockPath, ownerPath, fs);
        if (ownerWalk.finalKind === 'file') {
          owner = readNoFollowBytes(ownerPath, fs).toString('utf8').trim();
        }
      } catch (error) {
        owner = `owner record could not be read (${describe(error)})`;
      }
    }
    throw new Error(
      `the prepared receipt lock ${lockPath} exists (${owner}); another preparation may be active, or another receipt mutation may be active, so refusing before receipt reads or writes; retry after it finishes, or inspect the owner and remove this exact lock directory only after confirming its process is gone`,
    );
  }
  createDirectory(parent, lockPath, fs);
  const ownerPath = join(lockPath, 'owner.json');
  const ownerBytes = Buffer.from(
    `${JSON.stringify({
      pid: process.pid,
      host: hostname(),
      startedAt: new Date().toISOString(),
    })}\n`,
  );
  let ownerWritten = false;
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    writeNewFile(lockPath, ownerPath, ownerBytes, fs, 0o600);
    ownerWritten = true;
    result = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let cleanupError: unknown;
  try {
    const ownerState = checkContainment(lockPath, ownerPath, fs);
    if (ownerState.finalKind === 'file') {
      if (
        !ownerWritten ||
        !readNoFollowBytes(ownerPath, fs).equals(ownerBytes)
      ) {
        throw new Error(`${ownerPath} changed; refusing to release the lock`);
      }
      removeSingleEntry(
        lockPath,
        ownerPath,
        {
          kind: 'file',
          sha256: sha256Hex(ownerBytes),
        },
        fs,
      );
    } else if (ownerState.finalKind !== 'absent') {
      throw new Error(
        `${ownerPath} is ${ownerState.finalKind}; refusing to release the lock`,
      );
    }
    removeSingleEntry(parent, lockPath, { kind: 'directory' }, fs);
  } catch (error) {
    cleanupError = error;
  }
  if (operationFailed && cleanupError !== undefined) {
    throw new Error(
      `${describe(operationError)}; receipt mutation lock cleanup also failed (${describe(cleanupError)})`,
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) {
    throw new Error(
      `receipt mutation completed but lock cleanup failed (${describe(cleanupError)})`,
    );
  }
  return result as T;
}

/** Explicitly stage and verify one immutable user-global distribution set. */
export function prepareDistributionSet(
  options: PrepareDistributionOptions,
): PreparedDistributionResult {
  const ctx = resolveContext(options);
  return withReceiptMutationLock(ctx, () =>
    prepareDistributionSetWithContext(ctx, options),
  );
}

function prepareDistributionSetWithContext(
  ctx: Context,
  options: PrepareDistributionOptions,
): PreparedDistributionResult {
  const build = buildPreparedSet(ctx, options);
  const expected = preparedExpectedEntries(build);
  const fs = ctx.fs;
  assertRealChain(ctx.dataRoot, fs);
  assertRealParent(ctx.dataRoot, fs);

  const dataRootStat = lstatOrNull(ctx.dataRoot, fs);
  if (dataRootStat !== null && !dataRootStat.isDirectory()) {
    throw new Error(`${ctx.dataRoot} is not a real data directory`);
  }
  const staleReceiptTemps = findStaleReceiptTemps(ctx.dataRoot, fs);
  if (staleReceiptTemps.length > 0) {
    throw new Error(
      `${staleReceiptTemps[0]} is a stale receipt temporary from an interrupted write; remove that exact temporary file after confirming no receipt write is active, then retry preparation`,
    );
  }
  const prior = readReceipt(ctx.dataRoot, fs);
  if (dataRootStat !== null && prior.state === 'missing') {
    throw new Error(
      `${ctx.dataRoot} already exists without an installer receipt; refusing to adopt unowned data`,
    );
  }

  const entries = new Map<string, ReceiptEntry>();
  if (prior.state === 'valid') {
    for (const entry of prior.receipt.entries) entries.set(entry.path, entry);
  }
  const preparedRootStat = lstatOrNull(ctx.preparedRoot, fs);
  if (
    preparedRootStat !== null &&
    !sameReceiptEntry(entries.get(ctx.preparedRoot), {
      kind: 'directory',
      path: ctx.preparedRoot,
    })
  ) {
    throw new Error(
      `${ctx.preparedRoot} exists without a matching directory entry in the receipt; refusing to adopt it`,
    );
  }

  for (const entry of entries.values()) assertOwnedShape(ctx, entry);
  const allowedTargetPaths = new Set([
    ...expected.directoryEntries.keys(),
    ...expected.fileEntries.keys(),
  ]);
  for (const entry of entries.values()) {
    if (
      entry.path === build.setRoot ||
      entry.path.startsWith(`${build.setRoot}${sep}`)
    ) {
      if (!allowedTargetPaths.has(entry.path)) {
        throw new Error(
          `${entry.path} is an unexpected receipt entry in the prepared candidate`,
        );
      }
    }
  }
  for (const [path, expectedEntry] of [
    ...expected.directoryEntries,
    ...expected.fileEntries,
  ]) {
    const current = entries.get(path);
    if (current !== undefined && !sameReceiptEntry(current, expectedEntry)) {
      throw new Error(
        `${path} conflicts with a different existing receipt entry`,
      );
    }
  }
  const existingManifest = verifyPreparedTree(ctx, build, expected, entries, {
    requireRecordedExpected: false,
    manifestMustExist: false,
  });
  if (existingManifest) {
    for (const [path, bytes] of expected.files) {
      writeNewFileAtomically(
        ctx.preparedRoot,
        path,
        bytes,
        fs,
        expected.fileModes.get(path),
      );
    }
    verifyPreparedTree(ctx, build, expected, entries, {
      requireRecordedExpected: true,
      manifestMustExist: true,
    });
    return {
      sourceCommit: build.sourceCommit,
      preparedPath: build.setRoot,
      fileCount: build.files.length,
      reused: true,
    };
  }

  const rootWasCreated = dataRootStat === null;
  if (rootWasCreated) {
    createDirectory(dirname(ctx.dataRoot), ctx.dataRoot, fs);
    entries.set(ctx.dataRoot, { kind: 'directory', path: ctx.dataRoot });
  }
  for (const entry of expected.directoryEntries.values()) {
    const current = entries.get(entry.path);
    if (current === undefined) entries.set(entry.path, entry);
  }
  for (const entry of expected.fileEntries.values()) {
    const current = entries.get(entry.path);
    if (current === undefined) entries.set(entry.path, entry);
  }

  try {
    writeReceipt(ctx.dataRoot, [...entries.values()], fs);
    verifyPreparedTree(ctx, build, expected, entries, {
      requireRecordedExpected: true,
      manifestMustExist: false,
    });
    for (const directory of expected.directories) {
      const walk = checkContainment(ctx.preparedRoot, directory, fs);
      if (walk.finalKind === 'directory') continue;
      if (walk.finalKind !== 'absent') {
        throw new Error(`${directory} appeared as ${walk.finalKind}; refusing`);
      }
      createDirectory(ctx.preparedRoot, directory, fs);
    }
    const manifestPath = join(build.setRoot, PREPARED_MANIFEST_NAME);
    for (const [path, bytes] of expected.files) {
      if (path === manifestPath) continue;
      writeNewFileAtomically(
        ctx.preparedRoot,
        path,
        bytes,
        fs,
        expected.fileModes.get(path),
      );
    }
    verifyPreparedTree(ctx, build, expected, entries, {
      requireRecordedExpected: true,
      manifestMustExist: false,
    });
    writeNewFileAtomically(
      ctx.preparedRoot,
      manifestPath,
      build.manifestBytes,
      fs,
      expected.fileModes.get(manifestPath),
    );
  } catch (error) {
    let rootNote = '';
    if (rootWasCreated) {
      try {
        const receipt = readReceipt(ctx.dataRoot, fs);
        if (receipt.state === 'missing') {
          const remaining = fs.readdirSync(ctx.dataRoot);
          if (remaining.length === 0) {
            removeSingleEntry(
              dirname(ctx.dataRoot),
              ctx.dataRoot,
              {
                kind: 'directory',
              },
              fs,
            );
            rootNote = `; the newly created empty data root ${ctx.dataRoot} was removed`;
          } else {
            rootNote = `; the newly created data root ${ctx.dataRoot} remains with ${remaining.join(', ')} and no receipt`;
          }
        }
      } catch (cleanupError) {
        rootNote = `; cleanup of the newly created data root ${ctx.dataRoot} could not complete (${describe(cleanupError)})`;
      }
    }
    throw new Error(
      `${prepareFailureMessage(ctx, build, expected, error)}${rootNote}`,
    );
  }
  return {
    sourceCommit: build.sourceCommit,
    preparedPath: build.setRoot,
    fileCount: build.files.length,
    reused: false,
  };
}

function readPackageVersion(sourceRoot: string, fs: FsOps): string {
  const parsed: unknown = JSON.parse(
    fs.readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
  );
  const version =
    typeof parsed === 'object' && parsed !== null && 'version' in parsed
      ? parsed.version
      : undefined;
  if (typeof version !== 'string') {
    throw new Error(
      `${join(sourceRoot, 'package.json')} has no version string`,
    );
  }
  return version;
}

/** Every payload and skill file, with its destination under the roots. */
function buildTargets(
  ctx: Context,
  sourceRoot: string,
  version: string,
): Target[] {
  const fs = ctx.fs;
  const manifest = JSON.parse(
    fs.readFileSync(join(sourceRoot, 'audit', 'sync-manifest.json'), 'utf8'),
  ) as {
    generatedBlocks?: { id: string; stripPrefix: string; paths: string[] }[];
  };
  const block = (manifest.generatedBlocks ?? []).find(
    (candidate) => candidate.id === PAYLOAD_BLOCK_ID,
  );
  if (block === undefined || !Array.isArray(block.paths)) {
    throw new Error(`the sync manifest has no ${PAYLOAD_BLOCK_ID} block`);
  }
  const targets: Target[] = [];
  for (const path of [...block.paths, ...PAYLOAD_EXTRA_FILES]) {
    if (!path.startsWith(block.stripPrefix)) {
      throw new Error(
        `payload path ${path} lacks the ${block.stripPrefix} prefix`,
      );
    }
    // A manifest path must stay under the version directory once joined, so a
    // `..` or absolute segment in it refuses before any source is read.
    // The full manifest path is checked too, because the source is read
    // from `join(sourceRoot, path)`, so a `..` in the prefix would escape.
    const rel = path.slice(block.stripPrefix.length);
    const segments = (value: string): string[] => value.split(/[\\/]/);
    if (
      rel === '' ||
      isAbsolute(path) ||
      isAbsolute(rel) ||
      segments(path).some((part) => part === '..') ||
      segments(rel).some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw new Error(
        `payload path ${path} escapes the payload directory; refusing; nothing was written`,
      );
    }
    const source = readSource(join(sourceRoot, path), fs);
    targets.push({
      dest: join(ctx.dataRoot, version, path.slice(block.stripPrefix.length)),
      ...source,
    });
  }
  for (const rootName of SKILL_ROOT_NAMES) {
    const root = rootNamed(ctx, rootName);
    for (const skill of SKILL_NAMES) {
      const skillDir = join(sourceRoot, 'skills', skill);
      const files = listSourceFiles(skillDir, fs);
      // A source skill with no SKILL.md is broken. Left alone it would also make
      // every installed file of that skill look dropped, and the prune would
      // remove them (#4302).
      if (!files.includes('SKILL.md')) {
        throw new Error(
          `the source skill ${skillDir} has no SKILL.md; refusing; nothing was written`,
        );
      }
      for (const rel of files) {
        const source = readSource(join(skillDir, rel), fs);
        targets.push({ dest: join(root.path, skill, rel), ...source });
      }
    }
  }
  return targets;
}

interface Mkdir {
  path: string;
  root: Root;
}

interface Write {
  dest: string;
  root: Root;
  text: string;
  sha256: string;
  priorSha256: string | null;
}

/**
 * A listed skill file that the new package no longer ships (#4302). `present`
 * is false when the plan found the file, or an ancestor of it, already gone:
 * the prune then only drops its receipt entry.
 */
interface Prune {
  path: string;
  root: Root;
  sha256: string;
  present: boolean;
}

interface InstallPlan {
  entries: Map<string, ReceiptEntry>;
  mkdirs: Mkdir[];
  writes: Write[];
  prunes: Prune[];
  current:
    | { action: 'create'; versionDir: string }
    | {
        action: 'repoint';
        versionDir: string;
        priorTarget: string;
        listed: boolean;
      }
    | { action: 'keep'; versionDir: string };
  lines: string[];
  entrySteps: EntryStep[];
}

/** A listed entry that passed the ownership and containment checks. */
interface CheckedEntry {
  entry: ReceiptEntry;
  root: Root;
  walk: ContainmentResult;
}

/**
 * Whether a listed entry is a file install copied into a skill tree, which is
 * the only kind an upgrade may prune (#4302). Skill files stay discoverable by
 * the harness until they are removed; a file under an older version directory
 * does not, so it stays listed. The test goes by the root that `rootFor`
 * resolved, not by a path prefix: it returns the deepest root, so a data root
 * or a Codex home placed inside a skill directory is not taken for a skill
 * tree.
 */
function isSkillFileEntry(
  ctx: Context,
  entry: ReceiptEntry,
  root: Root,
): boolean {
  if (entry.kind !== 'file' || !SKILL_ROOT_NAMES.includes(root.name)) {
    return false;
  }
  // Belt and braces: the root test above already excludes the harness roots, so
  // an entry-file path should not reach this line.
  if (entryFileOwned(ctx, entry)) return false;
  const below = segmentsUnder(root.path, entry.path);
  return below !== null && SKILL_NAMES.includes(below[0]) && below.length >= 2;
}

/**
 * The device and inode of a file, or null when the filesystem reports no inode
 * number (0) and so gives nothing to compare. Two spellings of one file share
 * it, which a case-insensitive or normalization-insensitive filesystem allows,
 * and which `nlink` does not show.
 */
function identityOf(stat: { dev: bigint; ino: bigint }): string | null {
  return stat.ino === 0n ? null : `${stat.dev}:${stat.ino}`;
}

/**
 * Give each dropped skill file its verdict. Reads only. A refusal is added to
 * `refusals`, so it stops the install before the first write. `targetFiles`
 * maps the identity of each existing destination this run ships to its path.
 * A dropped entry that is the same file as one of them is kept as it was:
 * removing it under the old spelling would remove the file the new spelling
 * ships.
 *
 * "Dropped" means a skill file that is not a destination of this run. That is
 * the whole payload today. An install that ships only part of it, for example
 * one selected skill, must scope this set to what it ships, or it would drop
 * every other skill file.
 */
function planPrunes(
  ctx: Context,
  checked: readonly CheckedEntry[],
  targetFiles: ReadonlyMap<string, string>,
  targetDests: ReadonlySet<string>,
  refusals: string[],
): { prunes: Prune[]; lines: string[] } {
  const fs = ctx.fs;
  const prunes: Prune[] = [];
  const lines: string[] = [];
  for (const { entry, root, walk } of checked) {
    if (
      entry.kind !== 'file' ||
      targetDests.has(entry.path) ||
      !isSkillFileEntry(ctx, entry, root)
    ) {
      continue;
    }
    try {
      // First, for every verdict below: a leftover temporary file beside the
      // path marks a crashed run there, whether or not the file is still present.
      // An absent parent has nothing to list, so it passes.
      const gone = walk.missingDirs.length > 0 || walk.finalKind === 'absent';
      refuseStaleTemp(
        entry.path,
        fs,
        gone ? 'drop the receipt entry for' : 'remove',
      );
      if (gone) {
        prunes.push({
          path: entry.path,
          root,
          sha256: entry.sha256,
          present: false,
        });
        // The same word uninstall uses for a listed path that is already gone.
        lines.push(`absent ${entry.path}`);
        continue;
      }
      // checkContainment throws only for a link above the final component, so
      // the final component is checked here.
      if (walk.finalKind !== 'file') {
        throw new Error(
          `${entry.path} is now a ${walk.finalKind}, not a file, and the new version no longer ships it; refusing; leaving it in place; move or delete it, then install again`,
        );
      }
      const stat = fs.lstatSync(entry.path, { bigint: true });
      if (stat.nlink > 1n) {
        throw new Error(
          `${entry.path} has more than one hard link, and the new version no longer ships it; refusing to remove it; leaving it in place; move or delete it, then install again`,
        );
      }
      const identity = identityOf(stat);
      const same = identity === null ? undefined : targetFiles.get(identity);
      if (same !== undefined) {
        lines.push(`keep ${entry.path} (the same file as ${same})`);
        continue;
      }
      if (sha256Hex(readNoFollowBytes(entry.path, fs)) !== entry.sha256) {
        throw new Error(
          `${entry.path} was edited after install (its SHA-256 differs from the receipt), and the new version no longer ships it; refusing; leaving it in place; move or delete it, then install again`,
        );
      }
      prunes.push({
        path: entry.path,
        root,
        sha256: entry.sha256,
        present: true,
      });
      lines.push(`remove ${entry.path}`);
    } catch (error) {
      refusals.push(describe(error));
    }
  }
  return { prunes, lines };
}

/**
 * Check every condition the issue's pre-validation names and collect the
 * writes. Reads only. Refusals are gathered and thrown together, so each
 * refused path is named and nothing is written.
 */
function buildInstallPlan(
  ctx: Context,
  sourceRoot: string,
  version: string,
  harnesses: readonly EntryHarness[],
): InstallPlan {
  const fs = ctx.fs;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `version ${version} does not match the required pattern; nothing was written`,
    );
  }
  // Read the chain above each install root before any other plan work. The
  // first refusal stops the plan, so a link above several roots is one message.
  for (const name of ['data', ...SKILL_ROOT_NAMES]) {
    try {
      assertRealChain(rootNamed(ctx, name).path, fs);
    } catch (error) {
      throw new Error(
        `install refused before any write; nothing was written: ${describe(error)}`,
      );
    }
  }
  // The receipt read refuses a symbolic-link data root first. The stale-temp
  // scan lists the data root, which would otherwise follow that link.
  const existing = readReceipt(ctx.dataRoot, fs);
  const stale = findStaleReceiptTemps(ctx.dataRoot, fs);
  if (stale.length > 0) {
    throw new Error(
      `${stale[0]} exists, so a crashed run left it behind; remove it by hand before installing; nothing was written`,
    );
  }
  const entries = new Map<string, ReceiptEntry>();
  if (existing.state === 'valid') {
    for (const entry of existing.receipt.entries) {
      entries.set(entry.path, entry);
    }
  }
  const versionDir = join(ctx.dataRoot, version);
  const mkdirs: Mkdir[] = [];
  const seen = new Set<string>();
  const writes: Write[] = [];
  const lines: string[] = [];
  const refusals: string[] = [];

  // A listed path must sit under exactly one root with no link above it,
  // even when this run writes nothing there.
  const checked: CheckedEntry[] = [];
  for (const entry of entries.values()) {
    try {
      assertOwnedShape(ctx, entry);
      const { root, walk } = inspect(ctx, entry.path);
      checked.push({ entry, root, walk });
    } catch (error) {
      refusals.push(describe(error));
    }
  }

  const targets = buildTargets(ctx, sourceRoot, version);
  // The identity of each existing destination, so a dropped file that is the
  // same file under another spelling is kept rather than removed (#4302).
  const targetFiles = new Map<string, string>();
  for (const target of targets) {
    try {
      const root = rootFor(ctx, target.dest);
      const walk = checkContainment(root.path, target.dest, fs);
      if (walk.missingDirs.length > 0) {
        if (walk.missingDirs[0] === root.path) assertRealParent(root.path, fs);
        for (const dir of walk.missingDirs) {
          if (!seen.has(dir)) {
            seen.add(dir);
            mkdirs.push({ path: dir, root });
          }
        }
      }
      const listed = entries.get(target.dest);
      if (listed !== undefined && listed.kind !== 'file') {
        throw new Error(
          `${target.dest} is listed as a ${listed.kind}, not a file; refusing to write it`,
        );
      }
      if (walk.finalKind === 'absent') {
        writes.push({ ...target, root, priorSha256: null });
        lines.push(`create ${target.dest}`);
      } else if (walk.finalKind === 'file') {
        const identity = identityOf(
          fs.lstatSync(target.dest, { bigint: true }),
        );
        if (identity !== null) targetFiles.set(identity, target.dest);
        const current = sha256Hex(readNoFollowBytes(target.dest, fs));
        // The verdict table refuses a listed file whose hash differs from the
        // receipt, even when its bytes equal the new source: those bytes could
        // be a user edit, and uninstall would then remove the user's file.
        if (listed !== undefined && current !== listed.sha256) {
          throw new Error(
            `${target.dest} was edited after install (its SHA-256 differs from the receipt); refusing, and it is user-edited`,
          );
        }
        if (current === target.sha256) {
          lines.push(`keep ${target.dest}`);
        } else if (listed !== undefined) {
          // Refused here, before any write: replaceFileByRename would refuse a
          // second hard link only at apply time, after earlier writes.
          if (fs.lstatSync(target.dest).nlink > 1) {
            throw new Error(
              `${target.dest} has more than one hard link; refusing to replace it`,
            );
          }
          refuseStaleTemp(target.dest, fs);
          writes.push({ ...target, root, priorSha256: current });
          lines.push(`replace ${target.dest}`);
        } else {
          throw new Error(
            `${target.dest} exists with different bytes and is not listed by the receipt; refusing to overwrite it`,
          );
        }
      } else {
        throw new Error(
          `${target.dest} is a ${walk.finalKind}; refusing to write through it`,
        );
      }
    } catch (error) {
      refusals.push(describe(error));
    }
  }

  // A listed skill file this version no longer ships. It is judged here, before
  // any write, and removed only after the new payload is installed and listed.
  const pruned = planPrunes(
    ctx,
    checked,
    targetFiles,
    new Set(targets.map((target) => target.dest)),
    refusals,
  );

  let current: InstallPlan['current'];
  try {
    refuseStaleTemp(ctx.currentPath, fs);
    const walk = checkContainment(ctx.dataRoot, ctx.currentPath, fs);
    const listedCurrent = entries.get(ctx.currentPath);
    if (listedCurrent !== undefined && listedCurrent.kind !== 'link') {
      throw new Error(
        `${ctx.currentPath} is listed as a ${listedCurrent.kind}, not a link`,
      );
    }
    if (walk.finalKind === 'absent') {
      current = { action: 'create', versionDir };
    } else if (walk.finalKind === 'symlink') {
      const priorTarget = fs.readlinkSync(ctx.currentPath);
      assertCurrentTarget(ctx, priorTarget, fs);
      const resolved = resolve(ctx.dataRoot, priorTarget);
      const recorded =
        listedCurrent !== undefined && listedCurrent.kind === 'link'
          ? listedCurrent.target
          : undefined;
      // A listed link whose resolved target is not the recorded one was
      // retargeted, or its receipt write lagged a repoint. Neither is proven
      // from the link alone, so refuse and name it; the operator reconciles
      // the receipt by hand.
      if (recorded !== undefined && recorded !== resolved) {
        throw new Error(
          `${ctx.currentPath} points at ${resolved}, but the receipt records ${recorded}; it was retargeted or its receipt write lagged, so refusing to replace it`,
        );
      }
      if (priorTarget === versionDir) {
        current = { action: 'keep', versionDir };
      } else {
        // An unlisted link, or a listed link at its recorded target written
        // with a relative spelling, is repointed to the absolute path.
        current = {
          action: 'repoint',
          versionDir,
          priorTarget,
          listed: listedCurrent !== undefined,
        };
      }
    } else {
      throw new Error(
        `${ctx.currentPath} is a ${walk.finalKind}, not a link; refusing to replace it`,
      );
    }
  } catch (error) {
    refusals.push(describe(error));
    current = { action: 'keep', versionDir };
  }
  // The entry files are planned after the payload targets. Their harness
  // directories join the same mkdir list, and their refusals join this list.
  let entrySteps: EntryStep[] = [];
  let entryLines: string[] = [];
  if (harnesses.length > 0) {
    const entryText = targets.find(
      (target) => target.dest === join(versionDir, 'user-global', 'entry.md'),
    );
    if (entryText === undefined) {
      throw new Error(
        'the payload has no user-global entry text; nothing was written',
      );
    }
    const entryPlan = planEntryFiles({
      fs,
      targets: entryTargetsOf(ctx, harnesses),
      entryPath: join(ctx.currentPath, 'user-global', 'entry.md'),
      entryText: entryText.text,
      recordedEntryTexts: harnesses.includes('codex')
        ? recordedEntryTexts(ctx, entries)
        : [],
      listed: entries,
    });
    refusals.push(...entryPlan.refusals);
    for (const dir of entryPlan.dirs) {
      mkdirs.push({
        path: dir.path,
        root: { name: 'harness-base', path: dir.base },
      });
    }
    entrySteps = entryPlan.steps;
    entryLines = entryPlan.lines;
  }
  if (refusals.length > 0) {
    throw new Error(
      `install refused before any write; nothing was written: ${[...new Set(refusals)].join('; ')}`,
    );
  }

  for (const dir of mkdirs) lines.push(`create ${dir.path}`);
  if (current.action === 'create') {
    lines.push(`create link ${ctx.currentPath} -> ${versionDir}`);
  } else if (current.action === 'repoint') {
    lines.push(
      `repoint ${ctx.currentPath} -> ${versionDir} (prior target ${current.priorTarget})`,
    );
  } else {
    lines.push(`keep ${ctx.currentPath} (already points at ${versionDir})`);
  }
  lines.push(...entryLines, ...pruned.lines);
  return {
    entries,
    mkdirs,
    writes,
    prunes: pruned.prunes,
    current,
    lines,
    entrySteps,
  };
}

/**
 * One step this run applied. `prior` is the receipt entry the path held
 * before the step, or null. Rollback restores it, so a path that was listed
 * but absent at planning time stays listed after a rollback.
 */
type Applied =
  | { op: 'dir'; path: string; root: Root; prior: ReceiptEntry | null }
  | {
      op: 'file';
      path: string;
      root: Root;
      sha256: string;
      prior: ReceiptEntry | null;
    }
  | {
      op: 'replace';
      path: string;
      root: Root;
      priorBytes: Buffer;
      priorSha256: string;
      sha256: string;
    }
  | {
      op: 'link';
      path: string;
      target: string;
      prior: ReceiptEntry | null;
    }
  | {
      op: 'bytes';
      path: string;
      root: Root;
      priorBytes: Buffer;
      sha256: string;
      prior: ReceiptEntry | null;
    }
  | { op: 'repoint'; priorTarget: string; listed: boolean };

/**
 * Write the receipt for `entries`. An empty set removes the receipt instead,
 * so the file never lists an entry that is already gone.
 */
function persistEntries(
  ctx: Context,
  entries: Map<string, ReceiptEntry>,
  fs: FsOps,
): void {
  if (entries.size > 0) {
    writeReceipt(ctx.dataRoot, [...entries.values()], fs);
    return;
  }
  removeReceiptIfPresent(ctx, fs);
}

/** Remove the receipt through the no-follow containment walk, if present. */
function removeReceiptIfPresent(ctx: Context, fs: FsOps): void {
  const path = join(ctx.dataRoot, 'receipt.json');
  const walk = checkContainment(ctx.dataRoot, path, fs);
  if (walk.finalKind === 'absent') return;
  if (walk.finalKind !== 'file') {
    throw new Error(
      `${path} is a ${walk.finalKind}, not a file; refusing to remove it`,
    );
  }
  fs.unlinkSync(path);
}

/**
 * Remove the data root once only the receipt is left. The receipt goes first,
 * because the root must be empty. If the root's removal fails, the receipt is
 * rewritten to list the root, so the operator can resume from a valid state.
 */
function removeDataRoot(ctx: Context, fs: FsOps): void {
  removeReceiptIfPresent(ctx, fs);
  try {
    removeSingleEntry(
      dirname(ctx.dataRoot),
      ctx.dataRoot,
      { kind: 'directory' },
      fs,
    );
  } catch (error) {
    try {
      writeReceipt(
        ctx.dataRoot,
        [{ kind: 'directory', path: ctx.dataRoot }],
        fs,
      );
    } catch (restoreError) {
      throw new Error(
        `${describe(error)}; the receipt could not be restored (${describe(restoreError)}), so ${ctx.dataRoot} no longer has one`,
      );
    }
    throw error;
  }
}

/** Remove a directory this run created, or the whole data root when only the receipt is left. */
function removeCreatedDirectory(
  ctx: Context,
  path: string,
  root: Root,
  fs: FsOps,
): void {
  if (path === ctx.dataRoot) {
    const names = fs.readdirSync(path);
    if (names.length !== 1 || names[0] !== 'receipt.json') {
      throw new Error(
        `${path} holds more than the receipt; leaving it in place`,
      );
    }
    removeDataRoot(ctx, fs);
    return;
  }
  removeSingleEntry(baseOf(root, path), path, { kind: 'directory' }, fs);
}

/**
 * Put back the entry a path held before this run touched it. A path that was
 * not listed before the run is removed from the receipt.
 */
function restoreEntry(
  entries: Map<string, ReceiptEntry>,
  path: string,
  prior: ReceiptEntry | null,
): void {
  if (prior === null) {
    entries.delete(path);
  } else {
    entries.set(path, prior);
  }
}

/** Undo one step of this run and update the in-memory receipt. */
function undoStep(
  ctx: Context,
  step: Applied,
  entries: Map<string, ReceiptEntry>,
  fs: FsOps,
): void {
  switch (step.op) {
    case 'file':
      removeSingleEntry(
        step.root.path,
        step.path,
        { kind: 'file', sha256: step.sha256 },
        fs,
      );
      restoreEntry(entries, step.path, step.prior);
      return;
    case 'dir':
      removeCreatedDirectory(ctx, step.path, step.root, fs);
      restoreEntry(entries, step.path, step.prior);
      return;
    case 'replace':
      replaceFileByRename(
        step.root.path,
        step.path,
        step.sha256,
        step.priorBytes.toString('utf8'),
        fs,
      );
      entries.set(step.path, {
        kind: 'file',
        path: step.path,
        sha256: step.priorSha256,
      });
      return;
    case 'bytes':
      replaceFileByRename(
        step.root.path,
        step.path,
        step.sha256,
        step.priorBytes.toString('utf8'),
        fs,
      );
      if (
        sha256Hex(readNoFollowBytes(step.path, fs)) !==
        sha256Hex(step.priorBytes)
      ) {
        throw new Error(
          `${step.path} was restored, but its SHA-256 does not match the bytes from before the run; it is not verified`,
        );
      }
      restoreEntry(entries, step.path, step.prior);
      return;
    case 'link':
      removeSingleEntry(
        ctx.dataRoot,
        ctx.currentPath,
        { kind: 'symlink', target: step.target },
        fs,
      );
      restoreEntry(entries, ctx.currentPath, step.prior);
      return;
    case 'repoint':
      repointCurrent(ctx.dataRoot, basename(step.priorTarget), fs);
      if (step.listed) {
        entries.set(ctx.currentPath, {
          kind: 'link',
          path: ctx.currentPath,
          target: step.priorTarget,
        });
      }
      return;
  }
}

/**
 * Apply the plan. Each created path is recorded and the receipt is rewritten
 * before the next step. A failure before the receipt rewrite rolls back only
 * this run's steps, in reverse order. A failed receipt rewrite does not roll
 * back, because that step is the one that failed; it names the unlisted paths.
 * Last, the skill files the new version no longer ships are pruned (#4302);
 * that pass is outside the rollback.
 */
function applyInstall(
  ctx: Context,
  plan: InstallPlan,
  version: string,
): UserGlobalResult {
  const fs = ctx.fs;
  const entries = plan.entries;
  const applied: Applied[] = [];
  const pending: string[] = [];
  let receiptFailed = false;

  const persist = (): void => {
    try {
      writeReceipt(ctx.dataRoot, [...entries.values()], fs);
      pending.length = 0;
    } catch (error) {
      receiptFailed = true;
      throw new Error(
        `the receipt rewrite failed (${describe(error)}); these paths are created but not listed in the receipt: ${pending.join(', ')}`,
      );
    }
  };

  try {
    for (const dir of plan.mkdirs) {
      // Re-walk the path with no-follow stats right before the mkdir, so a
      // link that appeared since planning refuses rather than being followed.
      const recheck = checkContainment(
        baseOf(dir.root, dir.path),
        dir.path,
        fs,
      );
      if (recheck.finalKind === 'directory') continue;
      if (recheck.finalKind !== 'absent') {
        throw new Error(
          `${dir.path} appeared during the run as a ${recheck.finalKind}; refusing`,
        );
      }
      fs.mkdirSync(dir.path);
      const priorDir = entries.get(dir.path) ?? null;
      entries.set(dir.path, { kind: 'directory', path: dir.path });
      applied.push({
        op: 'dir',
        path: dir.path,
        root: dir.root,
        prior: priorDir,
      });
      pending.push(dir.path);
      persist();
    }
    for (const write of plan.writes) {
      if (write.priorSha256 !== null) {
        const priorBytes = readNoFollowBytes(write.dest, fs);
        if (sha256Hex(priorBytes) !== write.priorSha256) {
          throw new Error(
            `${write.dest} changed during the run; refusing to replace it`,
          );
        }
        if (
          !Buffer.from(priorBytes.toString('utf8'), 'utf8').equals(priorBytes)
        ) {
          throw new Error(
            `${write.dest} is not UTF-8 text; refusing to replace it`,
          );
        }
        replaceFileByRename(
          write.root.path,
          write.dest,
          write.priorSha256,
          write.text,
          fs,
        );
        entries.set(write.dest, {
          kind: 'file',
          path: write.dest,
          sha256: write.sha256,
        });
        applied.push({
          op: 'replace',
          path: write.dest,
          root: write.root,
          priorBytes,
          priorSha256: write.priorSha256,
          sha256: write.sha256,
        });
      } else {
        writeNewFile(write.root.path, write.dest, write.text, fs);
        const priorFile = entries.get(write.dest) ?? null;
        entries.set(write.dest, {
          kind: 'file',
          path: write.dest,
          sha256: write.sha256,
        });
        applied.push({
          op: 'file',
          path: write.dest,
          root: write.root,
          sha256: write.sha256,
          prior: priorFile,
        });
      }
      pending.push(write.dest);
      persist();
    }
    const { current } = plan;
    if (current.action === 'create') {
      repointCurrent(ctx.dataRoot, version, fs);
      const priorLink = entries.get(ctx.currentPath) ?? null;
      entries.set(ctx.currentPath, {
        kind: 'link',
        path: ctx.currentPath,
        target: current.versionDir,
      });
      applied.push({
        op: 'link',
        path: ctx.currentPath,
        target: current.versionDir,
        prior: priorLink,
      });
      pending.push(ctx.currentPath);
      persist();
    } else if (current.action === 'repoint') {
      repointCurrent(ctx.dataRoot, version, fs);
      if (current.listed) {
        entries.set(ctx.currentPath, {
          kind: 'link',
          path: ctx.currentPath,
          target: current.versionDir,
        });
        // The link has already moved, so a failed receipt write must name it.
        pending.push(ctx.currentPath);
        persist();
      }
      applied.push({
        op: 'repoint',
        priorTarget: current.priorTarget,
        listed: current.listed,
      });
    }
    for (const step of plan.entrySteps) {
      const root: Root = { name: 'harness', path: step.dir };
      if (step.kind === 'create') {
        writeNewFile(step.dir, step.path, step.text, fs);
        entries.set(step.path, step.entry);
        applied.push({
          op: 'file',
          path: step.path,
          root,
          sha256: sha256Hex(step.text),
          prior: null,
        });
      } else {
        // The snapshot is the bytes this run replaces. The rename refuses
        // unless the file still has the hash the plan read.
        const priorBytes = readNoFollowBytes(step.path, fs);
        if (sha256Hex(priorBytes) !== step.priorSha256) {
          throw new Error(
            `${step.path} changed during the run; refusing to replace it`,
          );
        }
        const prior = entries.get(step.path) ?? null;
        replaceFileByRename(
          step.dir,
          step.path,
          step.priorSha256,
          step.text,
          fs,
        );
        entries.set(step.path, step.entry);
        applied.push({
          op: 'bytes',
          path: step.path,
          root,
          priorBytes,
          sha256: sha256Hex(step.text),
          prior,
        });
      }
      pending.push(step.path);
      persist();
    }
  } catch (error) {
    if (receiptFailed) throw error;
    const leftovers: string[] = [];
    for (const step of [...applied].reverse()) {
      const stepPath = step.op === 'repoint' ? ctx.currentPath : step.path;
      try {
        undoStep(ctx, step, entries, fs);
        // The data root's own step already removed the receipt it holds.
        if (!(step.op === 'dir' && step.path === ctx.dataRoot)) {
          persistEntries(ctx, entries, fs);
        }
      } catch {
        leftovers.push(stepPath);
      }
    }
    if (leftovers.length === 0) {
      throw new Error(`install failed and was rolled back: ${describe(error)}`);
    }
    throw new Error(
      `install failed: ${describe(error)}; the rollback left these paths in place and still listed: ${leftovers.join(', ')}`,
    );
  }
  pruneDropped(ctx, plan.prunes, entries, version, priorTargetOf(plan), fs);
  return { lines: plan.lines, priorCurrentTarget: priorTargetOf(plan) };
}

/**
 * Remove the skill files the new version no longer ships (#4302), one at a
 * time, rewriting the receipt after each. This runs after every write has
 * succeeded and the receipt lists it, and a failure here never rolls anything
 * back: the new payload is complete, and each file is removed and unlisted,
 * still present and listed, or (after a crash or a failed rewrite) gone but
 * still listed. A plain retry finishes every one of those states, except that
 * a receipt temporary file a failed rewrite could not remove must be deleted
 * by hand first (the error names it).
 * Rolling a removal back would need a lossy recreate (mode and time are not
 * kept) and would undo a finished upgrade over an obsolete file.
 *
 * The unlink comes before the receipt rewrite. A crash or a failed rewrite
 * between them leaves a listed path that is absent, which uninstall reports as
 * absent and the next install drops it. The other order could leave a file that
 * nothing lists and nothing cleans up.
 *
 * A failure here throws, so the caller never sees the install result. The
 * messages therefore carry the prior `current` target that a result would have
 * reported.
 */
function pruneDropped(
  ctx: Context,
  prunes: readonly Prune[],
  entries: Map<string, ReceiptEntry>,
  version: string,
  priorTarget: string | null,
  fs: FsOps,
): void {
  const installed = `the ${version} payload is installed${
    priorTarget === null ? '' : ` (current used to point at ${priorTarget})`
  }`;
  const remaining = (from: number): string =>
    prunes
      .slice(from)
      .map((prune) => prune.path)
      .join(', ');
  for (const [index, prune] of prunes.entries()) {
    try {
      if (prune.present) {
        // The plan found the file, but it may be gone since. A path that is
        // absent now is only unlisted; anything else goes through the removal
        // primitive, which re-walks it and re-checks kind, links, and hash
        // immediately before the unlink.
        const walk = checkContainment(prune.root.path, prune.path, fs);
        if (walk.missingDirs.length === 0 && walk.finalKind !== 'absent') {
          removeSingleEntry(
            prune.root.path,
            prune.path,
            { kind: 'file', sha256: prune.sha256 },
            fs,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `${installed}, but removing the files it no longer ships stopped at ${prune.path}: ${describe(error)}; these files were not handled and stay listed: ${remaining(index)}; fix the cause named above (for a file you edited, move or delete it), then install again`,
      );
    }
    // An absent dropped file can be a name this version uses for a directory,
    // and the mkdir step then listed that directory under the same path. Only a
    // file entry is this prune's to drop.
    if (entries.get(prune.path)?.kind !== 'file') continue;
    entries.delete(prune.path);
    try {
      persistEntries(ctx, entries, fs);
    } catch (error) {
      throw new Error(
        `${installed}, but the receipt rewrite failed (${describe(error)}); ${prune.path} is gone from disk but still listed in the receipt, and a later install or uninstall reports it as absent; these files were not yet handled: ${remaining(index + 1) || 'none'}`,
      );
    }
  }
}

function priorTargetOf(plan: InstallPlan): string | null {
  return plan.current.action === 'repoint' ? plan.current.priorTarget : null;
}

function contextAndPlan(
  ctx: Context,
  options: UserGlobalOptions,
): {
  plan: InstallPlan;
  version: string;
} {
  const fs = ctx.fs;
  const sourceRoot = options.sourceRoot ?? resolveBundleRoot(HERE);
  const version = options.version ?? readPackageVersion(sourceRoot, fs);
  const plan = buildInstallPlan(
    ctx,
    sourceRoot,
    version,
    options.harnesses ?? [],
  );
  return { plan, version };
}

/**
 * Plan an install without writing anything. Runs the same checks and returns
 * one line per path. Creates no directory.
 */
export function planInstall(
  options: UserGlobalOptions = {},
): UserGlobalInstallResult {
  const ctx = resolveContext(options);
  const { plan, version } = contextAndPlan(ctx, options);
  return {
    lines: plan.lines,
    priorCurrentTarget: priorTargetOf(plan),
    version,
  };
}

/** Install the payload and skills, recording each created path. */
export function installPayload(
  options: UserGlobalOptions = {},
): UserGlobalInstallResult {
  const ctx = resolveContext(options);
  return withReceiptMutationLock(ctx, () => {
    const { plan, version } = contextAndPlan(ctx, options);
    return { ...applyInstall(ctx, plan, version), version };
  });
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

type Action = 'remove' | 'absent' | 'dir' | 'rewrite';

interface Decision {
  path: string;
  entry: ReceiptEntry;
  root: Root;
  base: string;
  action: Action;
  /** The edited file's new bytes, for an action that rewrites it in place. */
  rewrite?: { text: string; priorSha256: string; priorText: string };
}

interface UninstallPlan {
  reason: string | null;
  entries: Map<string, ReceiptEntry>;
  decisions: Decision[];
}

function expectedOf(
  entry: ReceiptEntry,
):
  | { kind: 'file'; sha256: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' } {
  if (entry.kind === 'file') return { kind: 'file', sha256: entry.sha256 };
  if (entry.kind === 'link') return { kind: 'symlink', target: entry.target };
  return { kind: 'directory' };
}

/**
 * Give each listed entry its verdict. Nothing is removed here. A refusal is
 * collected, and any refusal stops the run before the first removal.
 */
function buildUninstallPlan(ctx: Context): UninstallPlan {
  const fs = ctx.fs;
  // Read the declared chain before the first raw lstat of the data root, which
  // would otherwise follow a link above it.
  try {
    assertRealChain(ctx.dataRoot, fs);
  } catch (error) {
    throw new Error(
      `uninstall refused before any removal; nothing was removed: ${describe(error)}`,
    );
  }
  const rootStat = lstatOrNull(ctx.dataRoot, fs);
  if (rootStat === null) {
    return {
      reason: 'no data root; nothing to remove',
      entries: new Map(),
      decisions: [],
    };
  }
  if (rootStat.isSymbolicLink()) {
    throw new Error(
      `${ctx.dataRoot} is a symbolic link; refusing; nothing was removed`,
    );
  }
  if (!rootStat.isDirectory()) {
    throw new Error(
      `${ctx.dataRoot} is not a directory; refusing; nothing was removed`,
    );
  }
  assertRealParent(ctx.dataRoot, fs);
  const stale = findStaleReceiptTemps(ctx.dataRoot, fs);
  if (stale.length > 0) {
    throw new Error(
      `${stale[0]} exists, so a crashed run left it behind; remove it by hand before uninstalling; nothing was removed`,
    );
  }
  const read = readReceipt(ctx.dataRoot, fs);
  if (read.state === 'missing') {
    return {
      reason: 'no receipt; nothing to remove',
      entries: new Map(),
      decisions: [],
    };
  }
  const entries = new Map<string, ReceiptEntry>();
  for (const entry of read.receipt.entries) entries.set(entry.path, entry);

  const decisions: Decision[] = [];
  const refusals: string[] = [];
  for (const entry of read.receipt.entries) {
    try {
      assertOwnedShape(ctx, entry);
      const { root, base, walk } = inspect(ctx, entry.path);
      const decide = (
        action: Action,
        rewrite?: { text: string; priorSha256: string; priorText: string },
      ): void => {
        decisions.push({
          path: entry.path,
          entry,
          root,
          base,
          action,
          rewrite,
        });
      };
      if (entryFileOwned(ctx, entry)) {
        assertHarnessChain(
          ctx,
          entry.path,
          walk.missingDirs.length === 0 && walk.finalKind !== 'absent',
        );
      }
      if (walk.missingDirs.length > 0 || walk.finalKind === 'absent') {
        decide('absent');
      } else if (entry.kind === 'file') {
        if (walk.finalKind !== 'file') {
          throw new Error(
            `${entry.path} is now a ${walk.finalKind}, not a file; refusing`,
          );
        }
        const stat = fs.lstatSync(entry.path);
        if (stat.nlink > 1) {
          throw new Error(
            `${entry.path} has more than one hard link; refusing`,
          );
        }
        const bytes = readNoFollowBytes(entry.path, fs);
        if (sha256Hex(bytes) !== entry.sha256) {
          throw new Error(
            `${entry.path} was edited after install (its SHA-256 differs); refusing, and it is user-edited`,
          );
        }
        const harness = entryHarnessAt(ctx, entry.path);
        if (
          harness !== undefined &&
          !isInstallerWholeFile(
            harness,
            join(ctx.currentPath, 'user-global', 'entry.md'),
            bytes,
            harness === 'codex' ? recordedEntryTexts(ctx, entries) : [],
          )
        ) {
          throw new Error(
            `${entry.path} holds content install does not write, although the receipt lists it as one install created; refusing, and it is user-edited`,
          );
        }
        decide('remove');
      } else if (entry.kind === 'link') {
        if (walk.finalKind !== 'symlink') {
          throw new Error(
            `${entry.path} is now a ${walk.finalKind}, not a link; refusing`,
          );
        }
        if (fs.readlinkSync(entry.path) !== entry.target) {
          throw new Error(`${entry.path} points somewhere else now; refusing`);
        }
        decide('remove');
      } else if (
        entry.kind === 'managed-block' ||
        entry.kind === 'json-instruction'
      ) {
        if (walk.finalKind !== 'file') {
          throw new Error(
            `${entry.path} is now a ${walk.finalKind}, not a file; refusing`,
          );
        }
        const removal = planEntryRemoval(fs, entry);
        if (removal.kind === 'absent') decide('absent');
        else decide('rewrite', removal);
      } else {
        if (walk.finalKind !== 'directory') {
          throw new Error(
            `${entry.path} is now a ${walk.finalKind}, not a directory; refusing`,
          );
        }
        decide('dir');
      }
    } catch (error) {
      refusals.push(describe(error));
    }
  }
  if (refusals.length > 0) {
    throw new Error(
      `uninstall refused before any removal; nothing was removed: ${[...new Set(refusals)].join('; ')}`,
    );
  }
  return { reason: null, entries, decisions };
}

function uninstallLines(plan: UninstallPlan): string[] {
  if (plan.reason !== null) return [plan.reason];
  return plan.decisions.map((decision) => {
    if (decision.action === 'absent') return `absent ${decision.path}`;
    if (decision.action === 'rewrite') return `edit ${decision.path}`;
    if (decision.action === 'dir')
      return `dir ${decision.path} (removed only when empty)`;
    return `remove ${decision.path}`;
  });
}

/** Plan an uninstall without removing anything. */
export function planUninstall(
  options: UserGlobalOptions = {},
): UserGlobalResult {
  const ctx = resolveContext(options);
  const plan = buildUninstallPlan(ctx);
  return { lines: uninstallLines(plan), priorCurrentTarget: null };
}

/**
 * Remove what the receipt lists and what still matches it. Each removal is
 * re-checked, and the receipt is rewritten after each one, so an interrupted
 * run leaves exactly the entries that remain. A file or link that changed at
 * its turn stops the run. A directory that is not empty at its turn is kept
 * and named, and the run exits 0.
 */
export function uninstallPayload(
  options: UserGlobalOptions = {},
): UserGlobalResult {
  const ctx = resolveContext(options);
  if (!uninstallDataRootExists(ctx)) {
    const plan = buildUninstallPlan(ctx);
    return { lines: uninstallLines(plan), priorCurrentTarget: null };
  }
  return withReceiptMutationLock(ctx, () => uninstallPayloadWithContext(ctx));
}

function uninstallDataRootExists(ctx: Context): boolean {
  try {
    assertRealChain(ctx.dataRoot, ctx.fs);
  } catch (error) {
    throw new Error(
      `uninstall refused before any removal; nothing was removed: ${describe(error)}`,
    );
  }
  return lstatOrNull(ctx.dataRoot, ctx.fs) !== null;
}

function uninstallPayloadWithContext(ctx: Context): UserGlobalResult {
  const fs = ctx.fs;
  const plan = buildUninstallPlan(ctx);
  if (plan.reason !== null)
    return { lines: [plan.reason], priorCurrentTarget: null };
  const { entries, decisions } = plan;
  const lines: string[] = [];
  const persist = (): void => persistEntries(ctx, entries, fs);
  const stopAt = (path: string, error: unknown): never => {
    throw new Error(
      `uninstall stopped at ${path}: ${describe(error)}; the entries not yet removed stay listed`,
    );
  };

  for (const decision of [...decisions].reverse()) {
    if (decision.entry.kind === 'directory') continue;
    if (decision.action === 'absent') {
      entries.delete(decision.path);
      persist();
      lines.push(`absent ${decision.path}`);
      continue;
    }
    if (decision.action === 'rewrite' && decision.rewrite !== undefined) {
      try {
        replaceFileByRename(
          decision.base,
          decision.path,
          decision.rewrite.priorSha256,
          decision.rewrite.text,
          fs,
        );
      } catch (error) {
        stopAt(decision.path, error);
      }
      const { text, priorText } = decision.rewrite;
      entries.delete(decision.path);
      try {
        persist();
      } catch (error) {
        // The receipt still lists the entry, so the file goes back to the bytes
        // the receipt describes. Otherwise a retry would refuse the edited file.
        entries.set(decision.path, decision.entry);
        try {
          replaceFileByRename(
            decision.base,
            decision.path,
            sha256Hex(text),
            priorText,
            fs,
          );
        } catch (restoreError) {
          throw new Error(
            `${describe(error)}; restoring ${decision.path} also failed (${describe(restoreError)}), so the file keeps its edit while the receipt still lists it`,
          );
        }
        throw error;
      }
      lines.push(`edited ${decision.path}`);
      continue;
    }
    try {
      removeSingleEntry(
        decision.base,
        decision.path,
        expectedOf(decision.entry),
        fs,
      );
    } catch (error) {
      stopAt(decision.path, error);
    }
    entries.delete(decision.path);
    persist();
    lines.push(`removed ${decision.path}`);
  }

  for (const decision of [...decisions].reverse()) {
    if (decision.entry.kind !== 'directory' || decision.path === ctx.dataRoot) {
      continue;
    }
    if (decision.action === 'absent') {
      entries.delete(decision.path);
      persist();
      lines.push(`absent ${decision.path}`);
      continue;
    }
    const stat = lstatOrNull(decision.path, fs);
    if (stat === null) {
      entries.delete(decision.path);
      persist();
      lines.push(`absent ${decision.path}`);
      continue;
    }
    if (!stat.isDirectory()) {
      stopAt(decision.path, new Error(`it is no longer a real directory`));
    }
    if (fs.readdirSync(decision.path).length > 0) {
      lines.push(`kept ${decision.path} (not empty)`);
      continue;
    }
    try {
      removeSingleEntry(
        decision.base,
        decision.path,
        { kind: 'directory' },
        fs,
      );
    } catch (error) {
      stopAt(decision.path, error);
    }
    entries.delete(decision.path);
    persist();
    lines.push(`removed ${decision.path}`);
  }

  const others = [...entries.keys()].filter((path) => path !== ctx.dataRoot);
  const dataRootListed = entries.has(ctx.dataRoot);
  const extraFiles = fs
    .readdirSync(ctx.dataRoot)
    .filter((name) => name !== 'receipt.json');
  if (others.length > 0 || (dataRootListed && extraFiles.length > 0)) {
    lines.push(
      `kept receipt (${others.length + (dataRootListed ? 1 : 0)} entries remain)`,
    );
  } else if (dataRootListed) {
    try {
      removeDataRoot(ctx, fs);
    } catch (error) {
      stopAt(ctx.dataRoot, error);
    }
    entries.delete(ctx.dataRoot);
    lines.push('removed receipt', `removed ${ctx.dataRoot}`);
  } else {
    removeReceiptIfPresent(ctx, fs);
    lines.push('removed receipt');
  }

  const currentStat = lstatOrNull(ctx.currentPath, fs);
  if (currentStat?.isSymbolicLink()) {
    let dangles = false;
    try {
      fs.statSync(ctx.currentPath);
    } catch {
      dangles = true;
    }
    if (dangles) {
      lines.push(
        `left ${ctx.currentPath} (an unlisted link that now dangles; uninstall does not remove it)`,
      );
    }
  }
  return { lines, priorCurrentTarget: null };
}
