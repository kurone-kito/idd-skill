#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-push-trial-budget.mts
//
// The scripts/pre-push-trial-budget.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Pre-push budget check on a trial merge (#4010). A branch can pass the budget
// audit on its own and still breach it once it merges the current base, because
// the base may have moved the same measured bytes. When the branch is behind
// origin/main, this check merges origin/main into a throwaway detached worktree
// of HEAD and runs the base tip's audit-docs script there, so a breach that only
// appears after the merge fails the push. The base tip's script is used so the
// branch cannot relax its own budget. The check never pushes and never moves a
// branch or a remote ref.
//
// A branch that is not behind is measured too (#4128): every bundleBudgets
// entry and instruction file the branch touches is checked against the same
// rules audit-docs applies, read from the HEAD commit. HEAD's own manifest is
// used there, unlike the base pin above, so a limit raise the remedy order
// allows can pass. The near-ceiling ratchet in audit-docs, which runs earlier
// in the same pre-push chain, still refuses a raise at a base at or above 95%.
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';
import { acquireCloneLock, releaseCloneLock } from './clone-lock.mjs';
import {
  collectContextCeilingViolations,
  collectInstructionSizeBudgetViolations,
  globFiles,
  normalizeNonNegativeNumber,
  resolveInstructionSizeBudgetConfig,
  stripGeneratedFromBanner,
} from './consistency-helpers.mjs';
import {
  addScratchWorktree,
  DEFAULT_KEEP_LIST,
  scrubbedGitEnv,
} from './trial-scratch.mjs';
/** Flag spec for `parseCliArgs`. */
export const PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--base': { type: 'string' },
  '--help': { type: 'boolean' },
};
const UNKNOWN_EXEMPT_PATTERN =
  /: exemptBundles names unknown bundle id "(.*)"$/;
function measuredBytes(text) {
  return Buffer.byteLength(
    stripGeneratedFromBanner(text.replace(/\r\n?/g, '\n')),
    'utf8',
  );
}
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Measure the `bundleBudgets` entries and instruction files that `changedFiles`
 * touches. A bundle is touched when one of its member files changed. Pass or
 * fail comes from the rules audit-docs applies: a bundle above `limitBytes`,
 * the `contextCeiling` checks, and the `instructionSizeBudgets` per-file caps.
 * `readFile` returns null for a file that does not exist: a missing bundle
 * member fails, as audit-docs fails to read it, and a missing instruction file
 * is not governed. `base`, when given, adds each bundle's base-ref total and
 * utilization to its row; it never adds a failure. Pure: the caller supplies
 * the parsed manifests and the readers.
 */
export function measureTouchedBudgets(options) {
  const result = { bundles: [], files: [], failures: [] };
  if (!isPlainObject(options.manifest)) {
    result.failures.push('audit/sync-manifest.json: must be a JSON object');
    return result;
  }
  const manifest = options.manifest;
  const changed = new Set(options.changedFiles);
  const texts = new Map();
  const read = (path) => {
    if (!texts.has(path)) texts.set(path, options.readFile(path));
    return texts.get(path) ?? null;
  };
  const rawBundles = manifest.bundleBudgets;
  if (rawBundles != null && !Array.isArray(rawBundles)) {
    result.failures.push('bundleBudgets: must be an array');
  }
  // audit-docs passes any present value to the shared ceiling check, so a
  // malformed one (an array, a string) fails there and must fail here too.
  const rawCeiling = manifest.contextCeiling ?? null;
  const ceiling = isPlainObject(rawCeiling) ? rawCeiling : null;
  const maxPct = normalizeNonNegativeNumber(ceiling?.maxUtilizationPct);
  const exempt = new Set(
    Array.isArray(ceiling?.exemptBundles) ? ceiling.exemptBundles : [],
  );
  // The ids audit-docs knows: those of entries with a valid limit, the only
  // ones its measurement keeps.
  const allBundleIds = new Set(
    (Array.isArray(rawBundles) ? rawBundles : []).flatMap((entry) => {
      if (!isPlainObject(entry)) return [];
      const limit = Number(entry.limitBytes);
      if (!Number.isFinite(limit) || limit < 0) return [];
      return [typeof entry.id === 'string' ? entry.id : 'bundle-budget'];
    }),
  );
  const stats = [];
  for (const entry of Array.isArray(rawBundles) ? rawBundles : []) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : 'bundle-budget';
    const files = Array.isArray(entry.files)
      ? entry.files.filter((file) => typeof file === 'string')
      : [];
    if (!files.some((file) => changed.has(file))) continue;
    const limitBytes = Number(entry.limitBytes);
    if (!Number.isFinite(limitBytes) || limitBytes < 0) {
      result.failures.push(`${id}: limitBytes must be a non-negative number`);
      continue;
    }
    let bytes = 0;
    for (const file of files) {
      const text = read(file);
      // A missing member fails, as audit-docs fails to read it.
      if (text === null) {
        result.failures.push(`${file}: could not read file (ENOENT)`);
      }
      bytes += measuredBytes(text ?? '');
    }
    if (bytes > limitBytes) {
      result.failures.push(
        `${id}: bundle total is ${bytes} bytes (limit ${limitBytes}); files: ${files.join(', ')}`,
      );
    }
    const lineBytes =
      maxPct !== null && !exempt.has(id)
        ? Math.min(limitBytes, Math.floor((limitBytes * maxPct) / 100))
        : limitBytes;
    stats.push({ id, limitBytes, totalBytes: bytes, files });
    const base = baseBundleTotal(options.base, id);
    result.bundles.push({
      id,
      bytes,
      limitBytes,
      lineBytes,
      headroom: lineBytes - bytes,
      baseBytes: base?.bytes ?? null,
      baseLimitBytes: base?.limitBytes ?? null,
      // Floored, so a base just under 95% never reads as 95.
      baseUtilizationPct:
        base !== null && base.limitBytes > 0
          ? Math.floor((base.bytes * 10000) / base.limitBytes) / 100
          : null,
    });
  }
  if (rawCeiling !== null) {
    // Only touched bundles are passed, so an exemption for an untouched bundle
    // reads as unknown here. Such an error is dropped only when the id names
    // a bundle elsewhere in the manifest; a genuinely unknown id still fails,
    // as it does in audit-docs.
    const ceilingResult = collectContextCeilingViolations(rawCeiling, stats);
    result.failures.push(
      ...ceilingResult.errors.filter((line) => {
        const unknown = UNKNOWN_EXEMPT_PATTERN.exec(line);
        return unknown === null || !allBundleIds.has(unknown[1] ?? '');
      }),
    );
  }
  const rawSizeBudgets = manifest.instructionSizeBudgets;
  if (rawSizeBudgets != null && !Array.isArray(rawSizeBudgets)) {
    result.failures.push('instructionSizeBudgets: must be an array');
  }
  const changedList = [...changed];
  // One row per path: when several entries govern a file, the row with the
  // least headroom is kept, as that is the cap that fails first.
  const fileRows = new Map();
  for (const entry of Array.isArray(rawSizeBudgets) ? rawSizeBudgets : []) {
    if (!isPlainObject(entry)) {
      result.failures.push(
        `instructionSizeBudgets: each entry must be an object, got ${JSON.stringify(entry)}`,
      );
      continue;
    }
    const config = entry;
    const resolved = resolveInstructionSizeBudgetConfig(config);
    if ('error' in resolved) {
      result.failures.push(resolved.error);
      continue;
    }
    const governed = globFiles(resolved.glob, changedList).filter(
      (path) => read(path) !== null,
    );
    const sizeResult = collectInstructionSizeBudgetViolations(
      config,
      changed,
      () => governed,
      (path) => (read(path) ?? '').replace(/\r\n?/g, '\n'),
    );
    result.failures.push(...sizeResult.errors);
    for (const path of governed) {
      const text = (read(path) ?? '').replace(/\r\n?/g, '\n');
      const alwaysLoaded = resolved.alwaysLoadedRegex.test(text);
      const limitBytes = alwaysLoaded
        ? resolved.alwaysLoadedLimitBytes
        : resolved.phaseLimitBytes;
      const bytes = measuredBytes(text);
      const row = {
        path,
        bytes,
        limitBytes,
        limitField: alwaysLoaded ? 'alwaysLoadedLimitBytes' : 'phaseLimitBytes',
        headroom: limitBytes - bytes,
      };
      const prior = fileRows.get(path);
      if (prior === undefined || row.headroom < prior.headroom) {
        fileRows.set(path, row);
      }
    }
  }
  result.files.push(...fileRows.values());
  return result;
}
/** The base-ref total and limit of the bundle `id`, or null when the base has
 * no valid entry for it. Report only: it never adds a failure, so a missing
 * base member counts as 0 bytes and a read error gives null. */
function baseBundleTotal(base, id) {
  if (base === undefined || !isPlainObject(base.manifest)) return null;
  const entries = base.manifest.bundleBudgets;
  const entry = (Array.isArray(entries) ? entries : []).find(
    (candidate) => isPlainObject(candidate) && candidate.id === id,
  );
  if (!isPlainObject(entry)) return null;
  const limitBytes = Number(entry.limitBytes);
  if (!Number.isFinite(limitBytes) || limitBytes < 0) return null;
  let bytes = 0;
  try {
    for (const file of Array.isArray(entry.files) ? entry.files : []) {
      if (typeof file === 'string') {
        bytes += measuredBytes(base.readFile(file) ?? '');
      }
    }
  } catch {
    return null;
  }
  return { bytes, limitBytes };
}
/**
 * The stderr summary: the touched entry with the least headroom (ties broken
 * by name), or why there is none. `hint` is appended when given.
 */
export function formatLeastHeadroomLine(budgets, hint) {
  const prefix = 'pre-push-trial-budget:';
  let line;
  if (budgets === null) {
    line = `${prefix} no budget was measured`;
  } else {
    const rows = [
      ...budgets.bundles.map((row) => ({
        name: row.id,
        headroom: row.headroom,
        detail: `${row.bytes}/${row.lineBytes} bytes, limitBytes ${row.limitBytes}`,
      })),
      ...budgets.files.map((row) => ({
        name: row.path,
        headroom: row.headroom,
        detail: `${row.bytes}/${row.limitBytes} bytes, ${row.limitField}`,
      })),
    ].sort(
      (a, b) =>
        a.headroom - b.headroom ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    const [least] = rows;
    line =
      least === undefined
        ? `${prefix} no budget entry was touched`
        : `${prefix} least headroom is ${least.name}: ${least.headroom} bytes (${least.detail})`;
  }
  return hint === undefined ? line : `${line}; ${hint}`;
}
const MANIFEST_PATH = 'audit/sync-manifest.json';
const RAISE_HINT =
  'HEAD raises a bundle limit that the base pin hides; take in the base first (rebase before publication, or merge it into a pushed branch), then this check measures the raise';
/** `missing` means the commit or tree has no manifest file, as distinct from
 * a file whose JSON is `null`. */
function parseManifest(text) {
  if (text === null) return { ok: true, missing: true, manifest: null };
  try {
    return { ok: true, missing: false, manifest: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function bundleLimits(manifest) {
  const limits = new Map();
  if (!isPlainObject(manifest) || !Array.isArray(manifest.bundleBudgets)) {
    return limits;
  }
  for (const entry of manifest.bundleBudgets) {
    if (isPlainObject(entry) && typeof entry.id === 'string') {
      limits.set(entry.id, Number(entry.limitBytes));
    }
  }
  return limits;
}
/** The bundle ids whose limit HEAD's manifest raises above the base's. */
function raisedBundleIds(headManifest, baseManifest) {
  const base = bundleLimits(baseManifest);
  const raised = [];
  for (const [id, limit] of bundleLimits(headManifest)) {
    const prior = base.get(id);
    if (prior !== undefined && limit > prior) raised.push(id);
  }
  return raised;
}
/** True when an audit-docs failure line names the bundle `id`, in the
 * `<id>: bundle total is` or `<ceiling>: <id> utilization` shape. */
function failureNamesBundle(line, id) {
  return line.startsWith(`${id}: `) || line.includes(`: ${id} utilization `);
}
function changedFilesBetween(runGit, cwd, from, to) {
  // A moved file lists its old path too (--no-renames), so a moved bundle
  // member is touched and reported as missing, as a deleted one is.
  const result = runGit(cwd, [
    'diff',
    '-z',
    '--name-only',
    '--no-renames',
    from,
    to,
  ]);
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter((path) => path.length > 0);
}
const DEFAULT_BASE = 'origin/main';
const LEDGER_RULE_PREFIX = 'repository-inventory-audit';
const GIT_IDENTITY = [
  '-c',
  'user.name=idd-trial-budget',
  '-c',
  'user.email=idd-trial-budget@invalid',
];
/**
 * The inherited environment without `GIT_*` variables. A pre-push hook sets
 * `GIT_DIR` and related variables, and they would redirect every scratch
 * command to the host's repository or index.
 */
export function sanitizedEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIT_')),
  );
}
/**
 * The default runner, a plain `git -C <cwd>` spawn. It uses the environment
 * the caller passes, or the scrubbed environment of trial-scratch.mts.
 */
export const defaultGitRunner = (cwd, args, env) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: env ?? scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};
function resolveCommit(runGit, cwd, ref) {
  const result = runGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}
/**
 * The failure lines of an audit-docs run. Its errors are printed as `- <rule>:
 * <message>` lines after `documentation audit failed:`.
 */
export function auditFailureLines(output) {
  return output
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}
// Only the slash-delimited rule IDs of the tooling ledger are ignored. A prefix
// match would also hide `repository-inventory-audit-required-file`, which means
// a required audit input is missing, so it counts.
function isLedgerFailure(line) {
  return line.startsWith(`${LEDGER_RULE_PREFIX}/`);
}
/**
 * Run the trial-merge budget check for the repository at `cwd`. `base` names
 * the base tip the branch is compared with (default `origin/main`).
 */
export function runPrePushTrialBudget(options) {
  const repo = options.cwd;
  const base = options.base ?? DEFAULT_BASE;
  const runGit = options.runGit ?? defaultGitRunner;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const agentId = `pre-push-trial-budget-${process.pid}`;
  const headSha = resolveCommit(runGit, repo, 'HEAD');
  const baseSha = resolveCommit(runGit, repo, base);
  const finish = (outcome, behind, extra = {}, cleanupFailed = false) => {
    const passed = outcome === 'not-behind' || outcome === 'pass';
    const budgets = extra.budgets ?? null;
    return {
      outcome,
      behind,
      headSha,
      baseSha,
      auditFailures: extra.auditFailures ?? [],
      ignoredTooling: extra.ignoredTooling ?? [],
      cleanupFailed,
      budgets,
      summary: formatLeastHeadroomLine(
        budgets,
        extra.hint ??
          (outcome === 'budget-fail' && extra.auditFailures?.[0] !== undefined
            ? `first failure: ${extra.auditFailures[0]}`
            : undefined),
      ),
      exitCode: passed && !cleanupFailed ? 0 : 1,
    };
  };
  if (headSha === null || baseSha === null) {
    return finish('unresolved-ref', false);
  }
  // Reads one file from a commit: null when the commit has no such file, and
  // an error when a listed file cannot be read, so a read failure is never
  // mistaken for a missing file.
  const trees = new Map();
  const showAt = (commit, path) => {
    let tree = trees.get(commit);
    if (tree === undefined) {
      const listed = runGit(repo, [
        'ls-tree',
        '-r',
        '-z',
        '--name-only',
        commit,
      ]);
      if (listed.status !== 0) {
        throw new Error(`could not list the files of ${commit}`);
      }
      tree = new Set(listed.stdout.split('\0').filter((name) => name !== ''));
      trees.set(commit, tree);
    }
    if (!tree.has(path)) return null;
    const shown = runGit(repo, ['show', `${commit}:${path}`]);
    if (shown.status !== 0) {
      throw new Error(`could not read ${path} at ${commit}`);
    }
    return shown.stdout;
  };
  if (
    runGit(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0
  ) {
    // Not behind: measure the touched budgets on the HEAD commit, with HEAD's
    // own manifest, so a raise this branch commits is what is measured.
    const changedFiles = changedFilesBetween(runGit, repo, baseSha, headSha);
    let parsed;
    let measured = null;
    try {
      parsed = parseManifest(showAt(headSha, MANIFEST_PATH));
      if (changedFiles !== null && parsed.ok && !parsed.missing) {
        const manifest = parsed.manifest;
        // The base is read for the report only, so a read error leaves the
        // base fields empty rather than failing the check.
        let baseParsed;
        try {
          baseParsed = parseManifest(showAt(baseSha, MANIFEST_PATH));
        } catch {
          baseParsed = { ok: false };
        }
        measured = measureTouchedBudgets({
          manifest,
          changedFiles,
          readFile: (path) => showAt(headSha, path),
          base: baseParsed.ok
            ? {
                manifest: baseParsed.manifest,
                readFile: (path) => showAt(baseSha, path),
              }
            : undefined,
        });
      }
    } catch (error) {
      return finish('budget-fail', false, {
        auditFailures: [error.message],
      });
    }
    if (changedFiles === null || !parsed.ok) {
      return finish('budget-fail', false, {
        auditFailures: [
          changedFiles === null
            ? `could not list the files changed between ${baseSha} and HEAD`
            : `${MANIFEST_PATH}: not valid JSON at HEAD`,
        ],
      });
    }
    if (measured === null) {
      // The audit cannot run without its manifest, so neither can this check.
      return finish('budget-fail', false, {
        auditFailures: [`${MANIFEST_PATH}: could not read file (ENOENT)`],
      });
    }
    const budgets = { bundles: measured.bundles, files: measured.files };
    return measured.failures.length > 0
      ? finish('budget-fail', false, {
          auditFailures: measured.failures,
          budgets,
        })
      : finish('not-behind', false, { budgets });
  }
  const scratch = mkdtempSync(join(tmpdir(), 'idd-pre-push-trial-'));
  const trialTree = join(scratch, 'trial');
  const baseTooling = join(scratch, 'base');
  // An empty hooks directory, so no host hook runs during the scratch work (as
  // the trial-merge helper does), and signing is off for the throwaway merge.
  const hooksOff = join(scratch, 'hooks');
  mkdirSync(hooksOff);
  const scratchConfig = [
    '-c',
    `core.hooksPath=${hooksOff}`,
    '-c',
    'commit.gpgSign=false',
  ];
  const gitScratch = (cwd, args) => runGit(cwd, [...scratchConfig, ...args]);
  const created = [];
  const cleanupFailures = [];
  // Paths whose failed add left a registration that the shared step could not
  // confirm removed. A retry that also fails is a cleanup failure even when the
  // path is already gone, so the scratch directory is kept for the operator.
  const retained = new Set();
  // The worktree add runs through the shared steps. The commit.gpgSign setting
  // is pre-push's own, so it is added here, not in the shared module.
  const runScratchGit = (args, cwd, env) =>
    runGit(cwd, ['-c', 'commit.gpgSign=false', ...args], env);
  const addWorktree = (path, commit) => {
    const result = addScratchWorktree(runScratchGit, {
      cwd: repo,
      hooksDir: hooksOff,
      path,
      commit,
    });
    if (!result.ok && !result.registrationRemoved) retained.add(path);
    return result;
  };
  // The trial: resolves to an outcome and the audit lines, and never cleans up.
  const trial = () => {
    // The shared worktree records are changed only under the clone lock, as
    // the trial-merge helper does, so concurrent pre-push checks do not race.
    let lock;
    try {
      lock = acquireCloneLock(repo, agentId, lockTimeoutMs);
    } catch {
      return { outcome: 'clone-lock-unavailable' };
    }
    try {
      // Each worktree is recorded before its status is checked, so a worktree
      // a failed add still created is removed by the cleanup below.
      created.push(trialTree);
      if (!addWorktree(trialTree, headSha).ok) {
        return { outcome: 'worktree-failed' };
      }
      created.push(baseTooling);
      if (!addWorktree(baseTooling, baseSha).ok) {
        return { outcome: 'worktree-failed' };
      }
    } finally {
      releaseCloneLock(lock);
    }
    const merged = gitScratch(trialTree, [
      ...GIT_IDENTITY,
      'merge',
      '--no-edit',
      '--no-ff',
      '--no-gpg-sign',
      baseSha,
    ]);
    if (merged.status !== 0) {
      gitScratch(trialTree, ['merge', '--abort']);
      return { outcome: 'merge-conflict' };
    }
    // The audit reads its policy (budgets and rule lists) from audit/ under the
    // working directory. Pin that directory to the base tip, so a branch cannot
    // relax a budget by editing its own manifest. The measured files stay merged.
    if (
      gitScratch(trialTree, ['checkout', baseSha, '--', 'audit']).status !== 0
    ) {
      return { outcome: 'policy-pin-failed' };
    }
    const budgets = measureTrialTree();
    const audit = spawnSync(
      'node',
      [join(baseTooling, 'scripts', 'audit-docs.mjs'), '--check'],
      { cwd: trialTree, encoding: 'utf8', env: sanitizedEnv() },
    );
    if (audit.status === 0) {
      return { outcome: 'pass', budgets };
    }
    const lines = auditFailureLines(
      `${audit.stdout ?? ''}${audit.stderr ?? ''}`,
    );
    const ignoredTooling = lines.filter(isLedgerFailure);
    const auditFailures = lines.filter((line) => !isLedgerFailure(line));
    // A non-zero exit with no parsable failure line is unknown, so it fails
    // closed with a reason rather than passing.
    if (lines.length === 0) {
      return {
        outcome: 'fail',
        auditFailures: ['audit-docs exited non-zero with no parsable failure'],
        budgets,
      };
    }
    if (auditFailures.length > 0) {
      return { outcome: 'fail', auditFailures, ignoredTooling, budgets };
    }
    return { outcome: 'pass', ignoredTooling, budgets };
  };
  // The report for a behind branch: the files the branch itself changed,
  // measured on the merged trial tree under the pinned base policy. It never
  // adds a failure, because audit-docs already measured the same tree.
  function measureTrialTree() {
    const readTrial = (path) => {
      try {
        return readFileSync(join(trialTree, path), 'utf8');
      } catch {
        return null;
      }
    };
    const mergeBase = runGit(repo, [
      'merge-base',
      baseSha ?? '',
      headSha ?? '',
    ]);
    const changedFiles =
      mergeBase.status === 0 && headSha !== null
        ? changedFilesBetween(runGit, repo, mergeBase.stdout.trim(), headSha)
        : null;
    const parsed = parseManifest(readTrial(MANIFEST_PATH));
    if (changedFiles === null || !parsed.ok) return null;
    if (parsed.missing) return { bundles: [], files: [] };
    const measured = measureTouchedBudgets({
      manifest: parsed.manifest,
      changedFiles,
      readFile: readTrial,
    });
    return { bundles: measured.bundles, files: measured.files };
  }
  let verdict = { outcome: 'worktree-failed' };
  try {
    verdict = trial();
  } finally {
    // Unregistering a worktree also changes shared records, so it is done under
    // the clone lock again. A lock that cannot be taken counts as a cleanup
    // failure for each created path that is still present or whose registration
    // was retained. The scratch directory is kept only when one of those paths
    // is left.
    let cleanupLock = null;
    if (created.length > 0) {
      try {
        cleanupLock = acquireCloneLock(repo, agentId, lockTimeoutMs);
      } catch {
        cleanupLock = null;
      }
    }
    if (created.length > 0 && cleanupLock === null) {
      cleanupFailures.push(
        ...created.filter((path) => existsSync(path) || retained.has(path)),
      );
    }
    try {
      for (const path of created.reverse()) {
        if (cleanupLock === null) break;
        // Only the worktree this check created is unregistered. No branch or
        // ref is touched, and `prune` is not run because it is repository-wide.
        const removed = gitScratch(repo, [
          'worktree',
          'remove',
          '--force',
          path,
        ]);
        // A path that a failed add never created is not a cleanup failure, but
        // a path whose registration the add could not remove is one.
        if (removed.status !== 0 && (existsSync(path) || retained.has(path))) {
          cleanupFailures.push(path);
        }
      }
    } finally {
      if (cleanupLock !== null) releaseCloneLock(cleanupLock);
    }
    // The scratch directory is kept when a worktree stayed registered, so the
    // operator can recover it.
    if (cleanupFailures.length === 0) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // A raise this branch commits is hidden by the base pin, so a failing trial
  // says how to get the raise measured.
  let hint;
  if (verdict.outcome === 'fail') {
    try {
      const head = parseManifest(showAt(headSha, MANIFEST_PATH));
      const baseManifest = parseManifest(showAt(baseSha, MANIFEST_PATH));
      const raised =
        head.ok && baseManifest.ok
          ? raisedBundleIds(head.manifest, baseManifest.manifest)
          : [];
      const failures = verdict.auditFailures ?? [];
      if (
        raised.some((id) =>
          failures.some((line) => failureNamesBundle(line, id)),
        )
      ) {
        hint = RAISE_HINT;
      }
    } catch {
      // The hint is advice only; a read failure leaves it out.
    }
  }
  // Reaching the trial means HEAD is behind the base.
  return finish(
    verdict.outcome,
    true,
    { ...verdict, hint },
    cleanupFailures.length > 0,
  );
}
const USAGE = `usage: node scripts/pre-push-trial-budget.mjs [--cwd <repo>] [--base <ref>] [--help]

Pre-push budget check. When the branch is behind the base, it runs the base
tip's audit-docs on a trial merge of the base tip into HEAD. When it is not
behind, it measures every bundleBudgets entry and instruction file the branch
touches at HEAD, with the same failure rules as audit-docs. Prints one JSON
result (with each touched entry's bytes, limit and headroom), prints one stderr
line naming the entry with the least headroom, and exits 0 for not-behind or
pass, 1 otherwise. It never pushes and never moves a branch or remote ref.
Tooling-ledger failures (repository-inventory-audit) are listed as
ignoredTooling and are not counted.

  --cwd <repo>   repository to check (default: the current directory)
  --base <ref>   base tip the branch is compared with (default: origin/main)
  --help         print this usage and exit 0
`;
function run(argv) {
  const { values } = parseCliArgs(argv, PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC);
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const result = runPrePushTrialBudget({
    cwd: typeof values.cwd === 'string' ? values.cwd : process.cwd(),
    base: typeof values.base === 'string' ? values.base : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`${result.summary}\n`);
  return result.exitCode;
}
function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    console.error(`pre-push-trial-budget: ${error.message}`);
    return 1;
  }
}
if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
