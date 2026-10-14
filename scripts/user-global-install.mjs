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
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBundleRoot } from './bundle-root.mjs';
import { resolveInstalledPayloadRoot } from './idd-activation.mjs';
import { isQualifiedConfigRoot } from './idd-config.mjs';
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
  const home = homeCandidate.trim();
  if (!isQualifiedConfigRoot(home)) {
    throw new Error(
      'HOME is not a qualified root, so the skill roots do not resolve; nothing was written',
    );
  }
  const codexHome = qualifiedValue(env.CODEX_HOME) ?? join(home, '.codex');
  const configHome =
    qualifiedValue(env.XDG_CONFIG_HOME) ?? join(home, '.config');
  return {
    fs,
    dataRoot,
    currentPath: join(dataRoot, CURRENT),
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
      for (const rel of listSourceFiles(skillDir, fs)) {
        const source = readSource(join(skillDir, rel), fs);
        targets.push({ dest: join(root.path, skill, rel), ...source });
      }
    }
  }
  return targets;
}
/**
 * Check every condition the issue's pre-validation names and collect the
 * writes. Reads only. Refusals are gathered and thrown together, so each
 * refused path is named and nothing is written.
 */
function buildInstallPlan(ctx, sourceRoot, version) {
  const fs = ctx.fs;
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `version ${version} does not match the required pattern; nothing was written`,
    );
  }
  const stale = findStaleReceiptTemps(ctx.dataRoot, fs);
  if (stale.length > 0) {
    throw new Error(
      `${stale[0]} exists, so a crashed run left it behind; remove it by hand before installing; nothing was written`,
    );
  }
  const existing = readReceipt(ctx.dataRoot, fs);
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
  for (const entry of entries.values()) {
    try {
      inspect(ctx, entry.path);
    } catch (error) {
      refusals.push(describe(error));
    }
  }
  for (const target of buildTargets(ctx, sourceRoot, version)) {
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
  let current;
  try {
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
      if (priorTarget === versionDir) {
        // A repoint whose receipt rewrite failed leaves the link here but
        // the receipt on the old target. Record it rather than keep it.
        current =
          recorded !== undefined && recorded !== versionDir
            ? { action: 'record', versionDir }
            : { action: 'keep', versionDir };
      } else if (
        recorded !== undefined &&
        recorded !== resolved &&
        resolved !== versionDir
      ) {
        throw new Error(
          `${ctx.currentPath} points at ${resolved}, but the receipt records ${recorded}; it was retargeted after install, so refusing to replace it`,
        );
      } else {
        // A relative spelling of the same target is repointed to the
        // absolute path the receipt records, so uninstall's raw compare holds.
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
  } else if (current.action === 'record') {
    lines.push(
      `record ${ctx.currentPath} -> ${versionDir} (the receipt lagged the link)`,
    );
  } else {
    lines.push(`keep ${ctx.currentPath} (already points at ${versionDir})`);
  }
  return { entries, mkdirs, writes, current, lines };
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
      entries.delete(step.path);
      return;
    case 'dir':
      removeCreatedDirectory(ctx, step.path, step.root, fs);
      entries.delete(step.path);
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
    case 'link':
      removeSingleEntry(
        ctx.dataRoot,
        ctx.currentPath,
        { kind: 'symlink', target: step.target },
        fs,
      );
      entries.delete(ctx.currentPath);
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
      entries.set(dir.path, { kind: 'directory', path: dir.path });
      applied.push({ op: 'dir', path: dir.path, root: dir.root });
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
        });
      }
      pending.push(write.dest);
      persist();
    }
    const { current } = plan;
    if (current.action === 'create') {
      repointCurrent(ctx.dataRoot, version, fs);
      entries.set(ctx.currentPath, {
        kind: 'link',
        path: ctx.currentPath,
        target: current.versionDir,
      });
      applied.push({
        op: 'link',
        path: ctx.currentPath,
        target: current.versionDir,
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
        persist();
      }
      applied.push({
        op: 'repoint',
        priorTarget: current.priorTarget,
        listed: current.listed,
      });
    } else if (current.action === 'record') {
      entries.set(ctx.currentPath, {
        kind: 'link',
        path: ctx.currentPath,
        target: current.versionDir,
      });
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
  return { lines: plan.lines, priorCurrentTarget: priorTargetOf(plan) };
}
function priorTargetOf(plan) {
  return plan.current.action === 'repoint' ? plan.current.priorTarget : null;
}
function contextAndPlan(options) {
  const ctx = resolveContext(options);
  const fs = ctx.fs;
  const sourceRoot = options.sourceRoot ?? resolveBundleRoot(HERE);
  const version = options.version ?? readPackageVersion(sourceRoot, fs);
  const plan = buildInstallPlan(ctx, sourceRoot, version);
  return { ctx, plan, version };
}
/**
 * Plan an install without writing anything. Runs the same checks and returns
 * one line per path. Creates no directory.
 */
// audit:ignore-dead-export: consumed by issue #4245
export function planInstall(options = {}) {
  const { plan } = contextAndPlan(options);
  return { lines: plan.lines, priorCurrentTarget: priorTargetOf(plan) };
}
/** Install the payload and skills, recording each created path. */
// audit:ignore-dead-export: consumed by issue #4245
export function installPayload(options = {}) {
  const { ctx, plan, version } = contextAndPlan(options);
  return applyInstall(ctx, plan, version);
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
      const { root, base, walk } = inspect(ctx, entry.path);
      const decide = (action) => {
        decisions.push({ path: entry.path, entry, root, base, action });
      };
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
        if (sha256Hex(readNoFollowBytes(entry.path, fs)) !== entry.sha256) {
          throw new Error(
            `${entry.path} was edited after install (its SHA-256 differs); refusing, and it is user-edited`,
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
    if (decision.action === 'dir')
      return `dir ${decision.path} (removed only when empty)`;
    return `remove ${decision.path}`;
  });
}
/** Plan an uninstall without removing anything. */
// audit:ignore-dead-export: consumed by issue #4245
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
// audit:ignore-dead-export: consumed by issue #4245
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
