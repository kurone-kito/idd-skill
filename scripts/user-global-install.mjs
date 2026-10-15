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
// An upgrade also prunes (#4302): a listed skill file that the new package no
// longer ships is removed when it still matches the receipt, and refused
// before any write when it does not. The prune runs after the new payload is
// installed and listed, one file at a time, and is never part of a rollback.
//
// Open risks, accepted for the operator (see #4242):
// - a symbolic link above a root is not inspected;
// - a window remains between a containment check and the act that follows it.
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
import { fileURLToPath } from 'node:url';
import { resolveBundleRoot } from './bundle-root.mjs';
import { resolveInstalledPayloadRoot } from './idd-activation.mjs';
import { isQualifiedConfigRoot } from './idd-config.mjs';
import {
  ENTRY_FILE_NAME,
  ENTRY_HARNESSES,
  isInstallerWholeFile,
  planEntryFiles,
  planEntryRemoval,
} from './user-global-entry-files.mjs';
import {
  checkContainment,
  removeSingleEntry,
  replaceFileByRename,
  repointCurrent,
  writeNewFile,
} from './user-global-paths.mjs';
import {
  findStaleReceiptTemps,
  readReceipt,
  writeReceipt,
} from './user-global-receipt.mjs';

/**
 * The version pattern from issue #4242, duplicated here because #4242 keeps
 * it private. Keep it in step with `user-global-paths.mts`.
 */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
const CURRENT = 'current';
const PAYLOAD_BLOCK_ID = 'idd-template-core-files';
const PAYLOAD_EXTRA_FILES = ['idd-template/user-global/entry.md'];
const SKILL_NAMES = ['issue-authoring', 'idd-spec-audit'];
const SKILL_ROOT_NAMES = ['claude-skills', 'agents-skills'];
const HARNESS_ROOT_NAMES = ['claude', 'codex', 'opencode'];
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_FS = nodeFs;
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
function lstatOrNull(path, fs) {
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
function refuseStaleTemp(path, fs, action = 'replace') {
  let names;
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
function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** The bytes of a regular file, opened without following a link. */
function readNoFollowBytes(path, fs) {
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
function assertRealParent(root, fs) {
  const parent = dirname(root);
  let stat;
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
function qualifiedValue(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 && isQualifiedConfigRoot(trimmed)
    ? normalize(trimmed)
    : undefined;
}
function resolveContext(options) {
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
  return {
    fs,
    dataRoot,
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
      { name: 'claude', path: join(home, '.claude') },
      { name: 'claude-skills', path: join(home, '.claude', 'skills') },
      { name: 'agents-skills', path: join(home, '.agents', 'skills') },
      { name: 'codex', path: codexHome },
      { name: 'opencode', path: join(configHome, 'opencode') },
    ],
  };
}
function rootNamed(ctx, name) {
  const root = ctx.roots.find((candidate) => candidate.name === name);
  if (root === undefined) throw new Error(`no ${name} root resolved`);
  return root;
}
/** The path below `base` as segments, or null when it is not below `base`. */
function segmentsUnder(base, path) {
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
function ownedShape(ctx, entry) {
  if (entry.kind === 'link') return true;
  if (entry.kind === 'managed-block' || entry.kind === 'json-instruction') {
    return entryFileOwned(ctx, entry);
  }
  if (entryFileOwned(ctx, entry)) return true;
  const isDir = entry.kind === 'directory';
  if (isDir && entry.path === ctx.dataRoot) return true;
  const data = segmentsUnder(ctx.dataRoot, entry.path);
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
function assertHarnessChain(ctx, path, present) {
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
function entryHarnessAt(ctx, path) {
  return ENTRY_HARNESSES.find(
    (name) => join(harnessDirOf(ctx, name), ENTRY_FILE_NAME[name]) === path,
  );
}
/** The harness directory a harness's entry file lives in. */
function harnessDirOf(ctx, harness) {
  return rootNamed(ctx, harness).path;
}
/** The entry-file targets for the selected harnesses, in install order. */
function entryTargetsOf(ctx, harnesses) {
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
function entryFileOwned(ctx, entry) {
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
function assertOwnedShape(ctx, entry) {
  if (!ownedShape(ctx, entry)) {
    throw new Error(
      `${entry.path} is not a path the installer creates; the receipt does not own it, so refusing`,
    );
  }
}
function isWithin(root, path) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path === root || path.startsWith(prefix);
}
/**
 * The deepest root that contains `path`. A path under no root is refused,
 * and so is a path under two roots that neither contains the other. Nested
 * roots therefore resolve to the deeper one.
 */
function rootFor(ctx, path) {
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
/**
 * The containment base for a path under `root`. A path that equals its root
 * is walked from its parent, since a root is never a containment base for
 * itself.
 */
function baseOf(root, path) {
  return path === root.path ? dirname(path) : root.path;
}
/** Walk one path with no-follow stats. */
function inspect(ctx, path) {
  const root = rootFor(ctx, path);
  const base = baseOf(root, path);
  const walk = checkContainment(base, path, ctx.fs);
  return { root, base, walk };
}
function assertCurrentTarget(ctx, priorTarget, fs) {
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
function listSourceFiles(dir, fs, prefix = '') {
  const found = [];
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
function readSource(path, fs) {
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
function readPackageVersion(sourceRoot, fs) {
  const parsed = JSON.parse(
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
function buildTargets(ctx, sourceRoot, version) {
  const fs = ctx.fs;
  const manifest = JSON.parse(
    fs.readFileSync(join(sourceRoot, 'audit', 'sync-manifest.json'), 'utf8'),
  );
  const block = (manifest.generatedBlocks ?? []).find(
    (candidate) => candidate.id === PAYLOAD_BLOCK_ID,
  );
  if (block === undefined || !Array.isArray(block.paths)) {
    throw new Error(`the sync manifest has no ${PAYLOAD_BLOCK_ID} block`);
  }
  const targets = [];
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
    const segments = (value) => value.split(/[\\/]/);
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
/**
 * Whether a listed entry is a file install copied into a skill tree, which is
 * the only kind an upgrade may prune (#4302). Skill files stay discoverable by
 * the harness until they are removed; a file under an older version directory
 * does not, so it stays listed. The test goes by the root that `rootFor`
 * resolved, not by a path prefix: it returns the deepest root, so a data root
 * or a Codex home placed inside a skill directory is not taken for a skill
 * tree.
 */
function isSkillFileEntry(ctx, entry, root) {
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
function identityOf(stat) {
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
function planPrunes(ctx, checked, targetFiles, targetDests, refusals) {
  const fs = ctx.fs;
  const prunes = [];
  const lines = [];
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
function buildInstallPlan(ctx, sourceRoot, version, harnesses) {
  const fs = ctx.fs;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `version ${version} does not match the required pattern; nothing was written`,
    );
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
  const entries = new Map();
  if (existing.state === 'valid') {
    for (const entry of existing.receipt.entries) {
      entries.set(entry.path, entry);
    }
  }
  const versionDir = join(ctx.dataRoot, version);
  const mkdirs = [];
  const seen = new Set();
  const writes = [];
  const lines = [];
  const refusals = [];
  // A listed path must sit under exactly one root with no link above it,
  // even when this run writes nothing there.
  const checked = [];
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
  const targetFiles = new Map();
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
  let current;
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
  let entrySteps = [];
  let entryLines = [];
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
      `install refused before any write; nothing was written: ${refusals.join('; ')}`,
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
 * Write the receipt for `entries`. An empty set removes the receipt instead,
 * so the file never lists an entry that is already gone.
 */
function persistEntries(ctx, entries, fs) {
  if (entries.size > 0) {
    writeReceipt(ctx.dataRoot, [...entries.values()], fs);
    return;
  }
  removeReceiptIfPresent(ctx, fs);
}
/** Remove the receipt through the no-follow containment walk, if present. */
function removeReceiptIfPresent(ctx, fs) {
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
function removeDataRoot(ctx, fs) {
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
function removeCreatedDirectory(ctx, path, root, fs) {
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
function restoreEntry(entries, path, prior) {
  if (prior === null) {
    entries.delete(path);
  } else {
    entries.set(path, prior);
  }
}
/** Undo one step of this run and update the in-memory receipt. */
function undoStep(ctx, step, entries, fs) {
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
function applyInstall(ctx, plan, version) {
  const fs = ctx.fs;
  const entries = plan.entries;
  const applied = [];
  const pending = [];
  let receiptFailed = false;
  const persist = () => {
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
      const root = { name: 'harness', path: step.dir };
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
    const leftovers = [];
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
function pruneDropped(ctx, prunes, entries, version, priorTarget, fs) {
  const installed = `the ${version} payload is installed${priorTarget === null ? '' : ` (current used to point at ${priorTarget})`}`;
  const remaining = (from) =>
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
function priorTargetOf(plan) {
  return plan.current.action === 'repoint' ? plan.current.priorTarget : null;
}
function contextAndPlan(options) {
  const ctx = resolveContext(options);
  const fs = ctx.fs;
  const sourceRoot = options.sourceRoot ?? resolveBundleRoot(HERE);
  const version = options.version ?? readPackageVersion(sourceRoot, fs);
  const plan = buildInstallPlan(
    ctx,
    sourceRoot,
    version,
    options.harnesses ?? [],
  );
  return { ctx, plan, version };
}
/**
 * Plan an install without writing anything. Runs the same checks and returns
 * one line per path. Creates no directory.
 */
export function planInstall(options = {}) {
  const { plan, version } = contextAndPlan(options);
  return {
    lines: plan.lines,
    priorCurrentTarget: priorTargetOf(plan),
    version,
  };
}
/** Install the payload and skills, recording each created path. */
export function installPayload(options = {}) {
  const { ctx, plan, version } = contextAndPlan(options);
  return { ...applyInstall(ctx, plan, version), version };
}
function expectedOf(entry) {
  if (entry.kind === 'file') return { kind: 'file', sha256: entry.sha256 };
  if (entry.kind === 'link') return { kind: 'symlink', target: entry.target };
  return { kind: 'directory' };
}
/**
 * Give each listed entry its verdict. Nothing is removed here. A refusal is
 * collected, and any refusal stops the run before the first removal.
 */
function buildUninstallPlan(ctx) {
  const fs = ctx.fs;
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
  const entries = new Map();
  for (const entry of read.receipt.entries) entries.set(entry.path, entry);
  const decisions = [];
  const refusals = [];
  for (const entry of read.receipt.entries) {
    try {
      assertOwnedShape(ctx, entry);
      const { root, base, walk } = inspect(ctx, entry.path);
      const decide = (action, rewrite) => {
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
            entry.path,
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
      `uninstall refused before any removal; nothing was removed: ${refusals.join('; ')}`,
    );
  }
  return { reason: null, entries, decisions };
}
function uninstallLines(plan) {
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
export function planUninstall(options = {}) {
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
export function uninstallPayload(options = {}) {
  const ctx = resolveContext(options);
  const fs = ctx.fs;
  const plan = buildUninstallPlan(ctx);
  if (plan.reason !== null)
    return { lines: [plan.reason], priorCurrentTarget: null };
  const { entries, decisions } = plan;
  const lines = [];
  const persist = () => persistEntries(ctx, entries, fs);
  const stopAt = (path, error) => {
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
