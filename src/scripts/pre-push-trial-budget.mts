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

import { parseCliArgs } from './cli-args.mts';
import {
  acquireCloneLock,
  type CloneLockHandle,
  releaseCloneLock,
} from './clone-lock.mts';
import {
  type ContextCeilingBundleStat,
  type ContextCeilingConfig,
  collectContextCeilingViolations,
  collectInstructionSizeBudgetViolations,
  globFiles,
  type InstructionSizeBudgetConfig,
  normalizeNonNegativeNumber,
  resolveInstructionSizeBudgetConfig,
  stripGeneratedFromBanner,
} from './consistency-helpers.mts';
import {
  addScratchWorktree,
  DEFAULT_KEEP_LIST,
  scrubbedGitEnv,
  type TrialGitRunner,
} from './trial-scratch.mts';

/** Flag spec for `parseCliArgs`. */
export const PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--base': { type: 'string' },
  '--help': { type: 'boolean' },
} as const;

/**
 * `not-behind`: HEAD already contains the base tip, so nothing is merged, and
 * no touched budget is breached at HEAD. `budget-fail`: HEAD contains the base
 * tip, but a touched budget is breached at HEAD (or could not be measured).
 * `pass` / `fail`: the base tip's audit-docs passed or failed on the trial
 * merge of a branch that is behind. `merge-conflict`: the merge itself failed,
 * so no audit ran.
 * `unresolved-ref`: HEAD or the base cannot be resolved, so the check fails
 * closed. `worktree-failed`: a scratch worktree could not be created.
 * `clone-lock-unavailable`: the repository clone lock was not taken in time, so
 * no shared worktree record was changed. `policy-pin-failed`: the base tip's
 * audit policy could not be pinned onto the trial tree, so the audit did not run.
 */
export type PrePushTrialBudgetOutcome =
  | 'not-behind'
  | 'budget-fail'
  | 'pass'
  | 'fail'
  | 'merge-conflict'
  | 'unresolved-ref'
  | 'worktree-failed'
  | 'clone-lock-unavailable'
  | 'policy-pin-failed';

export interface PrePushTrialBudgetResult {
  outcome: PrePushTrialBudgetOutcome;
  behind: boolean;
  headSha: string | null;
  baseSha: string | null;
  /** Audit failures that are budget or documentation failures, so they count. */
  auditFailures: string[];
  /**
   * Audit failures from the tooling ledger (`repository-inventory-audit`). They
   * are reported but not counted: the base tip's ledger cannot list a helper
   * that the branch adds, and the branch's own CI audits the merged tree.
   */
  ignoredTooling: string[];
  /** True when a scratch worktree could not be unregistered. Fails closed. */
  cleanupFailed: boolean;
  /**
   * The touched budget entries and their headroom, or null when nothing was
   * measured (an unresolved ref, a merge conflict, or a failed policy pin). On
   * a behind branch it is measured on the trial tree and is a report only:
   * audit-docs stays the only source of failures there.
   */
  budgets: { bundles: TouchedBundleRow[]; files: TouchedFileRow[] } | null;
  /** The one-line summary printed to stderr. */
  summary: string;
  exitCode: 0 | 1;
}

/** One touched `bundleBudgets` entry. `lineBytes` is the largest total that
 * passes: `floor(limitBytes * maxUtilizationPct / 100)`, or `limitBytes` when
 * there is no `contextCeiling` or the bundle is exempt. */
export interface TouchedBundleRow {
  id: string;
  bytes: number;
  limitBytes: number;
  lineBytes: number;
  headroom: number;
}

/** One touched instruction file governed by an `instructionSizeBudgets`
 * entry, with the limit that applies to it and that limit's field name. */
export interface TouchedFileRow {
  path: string;
  bytes: number;
  limitBytes: number;
  limitField: 'phaseLimitBytes' | 'alwaysLoadedLimitBytes';
  headroom: number;
}

export interface TouchedBudgets {
  bundles: TouchedBundleRow[];
  files: TouchedFileRow[];
  /** Breaches, in the audit-docs message shapes. Empty means pass. */
  failures: string[];
}

const UNKNOWN_EXEMPT_PATTERN = /: exemptBundles names unknown bundle id "/;

function measuredBytes(text: string): number {
  return Buffer.byteLength(
    stripGeneratedFromBanner(text.replace(/\r\n?/g, '\n')),
    'utf8',
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Measure the `bundleBudgets` entries and instruction files that `changedFiles`
 * touches. A bundle is touched when one of its member files changed. Pass or
 * fail comes from the rules audit-docs applies: a bundle above `limitBytes`,
 * the `contextCeiling` checks, and the `instructionSizeBudgets` per-file caps.
 * `readFile` returns null for a file that does not exist: a missing bundle
 * member fails, as audit-docs fails to read it, and a missing instruction file
 * is not governed. Pure: the caller supplies the parsed manifest and the
 * reader.
 */
export function measureTouchedBudgets(options: {
  manifest: unknown;
  changedFiles: readonly string[];
  readFile: (path: string) => string | null;
}): TouchedBudgets {
  const result: TouchedBudgets = { bundles: [], files: [], failures: [] };
  if (!isPlainObject(options.manifest)) {
    result.failures.push('audit/sync-manifest.json: must be a JSON object');
    return result;
  }
  const manifest = options.manifest;
  const changed = new Set(options.changedFiles);
  const texts = new Map<string, string | null>();
  const read = (path: string): string | null => {
    if (!texts.has(path)) texts.set(path, options.readFile(path));
    return texts.get(path) ?? null;
  };

  const rawBundles = manifest.bundleBudgets;
  if (rawBundles != null && !Array.isArray(rawBundles)) {
    result.failures.push('bundleBudgets: must be an array');
  }
  const ceiling = isPlainObject(manifest.contextCeiling)
    ? (manifest.contextCeiling as ContextCeilingConfig)
    : null;
  const maxPct = normalizeNonNegativeNumber(ceiling?.maxUtilizationPct);
  const exempt = new Set(
    Array.isArray(ceiling?.exemptBundles) ? ceiling.exemptBundles : [],
  );
  const stats: ContextCeilingBundleStat[] = [];
  for (const entry of Array.isArray(rawBundles) ? rawBundles : []) {
    if (!isPlainObject(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : 'bundle-budget';
    const files = Array.isArray(entry.files)
      ? entry.files.filter((file): file is string => typeof file === 'string')
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
    result.bundles.push({
      id,
      bytes,
      limitBytes,
      lineBytes,
      headroom: lineBytes - bytes,
    });
  }
  if (ceiling !== null && stats.length > 0) {
    // Only touched bundles are passed, so an exemption for an untouched bundle
    // reads as unknown here. audit-docs checks those ids against every bundle.
    const ceilingResult = collectContextCeilingViolations(ceiling, stats);
    result.failures.push(
      ...ceilingResult.errors.filter(
        (line) => !UNKNOWN_EXEMPT_PATTERN.test(line),
      ),
    );
  }

  const rawSizeBudgets = manifest.instructionSizeBudgets;
  if (rawSizeBudgets != null && !Array.isArray(rawSizeBudgets)) {
    result.failures.push('instructionSizeBudgets: must be an array');
  }
  const changedList = [...changed];
  const seenFiles = new Set<string>();
  for (const entry of Array.isArray(rawSizeBudgets) ? rawSizeBudgets : []) {
    if (!isPlainObject(entry)) {
      result.failures.push(
        `instructionSizeBudgets: each entry must be an object, got ${JSON.stringify(entry)}`,
      );
      continue;
    }
    const config = entry as InstructionSizeBudgetConfig;
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
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      const text = (read(path) ?? '').replace(/\r\n?/g, '\n');
      const alwaysLoaded = resolved.alwaysLoadedRegex.test(text);
      const limitBytes = alwaysLoaded
        ? resolved.alwaysLoadedLimitBytes
        : resolved.phaseLimitBytes;
      const bytes = measuredBytes(text);
      result.files.push({
        path,
        bytes,
        limitBytes,
        limitField: alwaysLoaded ? 'alwaysLoadedLimitBytes' : 'phaseLimitBytes',
        headroom: limitBytes - bytes,
      });
    }
  }
  return result;
}

/**
 * The stderr summary: the touched entry with the least headroom (ties broken
 * by name), or why there is none. `hint` is appended when given.
 */
export function formatLeastHeadroomLine(
  budgets: { bundles: TouchedBundleRow[]; files: TouchedFileRow[] } | null,
  hint?: string,
): string {
  const prefix = 'pre-push-trial-budget:';
  let line: string;
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

function parseManifest(
  text: string | null,
): { ok: true; manifest: unknown } | { ok: false } {
  if (text === null) return { ok: true, manifest: null };
  try {
    return { ok: true, manifest: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function bundleLimits(manifest: unknown): Map<string, number> {
  const limits = new Map<string, number>();
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
function raisedBundleIds(headManifest: unknown, baseManifest: unknown) {
  const base = bundleLimits(baseManifest);
  const raised: string[] = [];
  for (const [id, limit] of bundleLimits(headManifest)) {
    const prior = base.get(id);
    if (prior !== undefined && limit > prior) raised.push(id);
  }
  return raised;
}

/** True when an audit-docs failure line names the bundle `id`, in the
 * `<id>: bundle total is` or `<ceiling>: <id> utilization` shape. */
function failureNamesBundle(line: string, id: string): boolean {
  return line.startsWith(`${id}: `) || line.includes(`: ${id} utilization `);
}

function changedFilesBetween(
  runGit: GitRunner,
  cwd: string,
  from: string,
  to: string,
): string[] | null {
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
 * One git invocation in a working directory: the status and stdout. The
 * optional environment is the one git runs with; when it is omitted, the
 * default runner uses the scrubbed environment.
 */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => { status: number; stdout: string };

/**
 * The inherited environment without `GIT_*` variables. A pre-push hook sets
 * `GIT_DIR` and related variables, and they would redirect every scratch
 * command to the host's repository or index.
 */
export function sanitizedEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/**
 * The default runner, a plain `git -C <cwd>` spawn. It uses the environment
 * the caller passes, or the scrubbed environment of trial-scratch.mts.
 */
export const defaultGitRunner: GitRunner = (cwd, args, env) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: env ?? scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

function resolveCommit(
  runGit: GitRunner,
  cwd: string,
  ref: string,
): string | null {
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
export function auditFailureLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

// Only the slash-delimited rule IDs of the tooling ledger are ignored. A prefix
// match would also hide `repository-inventory-audit-required-file`, which means
// a required audit input is missing, so it counts.
function isLedgerFailure(line: string): boolean {
  return line.startsWith(`${LEDGER_RULE_PREFIX}/`);
}

/**
 * Run the trial-merge budget check for the repository at `cwd`. `base` names
 * the base tip the branch is compared with (default `origin/main`).
 */
export function runPrePushTrialBudget(options: {
  cwd: string;
  base?: string;
  runGit?: GitRunner;
  /** How long to wait for the clone lock before failing closed. */
  lockTimeoutMs?: number;
}): PrePushTrialBudgetResult {
  const repo = options.cwd;
  const base = options.base ?? DEFAULT_BASE;
  const runGit = options.runGit ?? defaultGitRunner;
  const lockTimeoutMs = options.lockTimeoutMs ?? 60_000;
  const agentId = `pre-push-trial-budget-${process.pid}`;
  const headSha = resolveCommit(runGit, repo, 'HEAD');
  const baseSha = resolveCommit(runGit, repo, base);
  const finish = (
    outcome: PrePushTrialBudgetOutcome,
    behind: boolean,
    extra: {
      auditFailures?: string[];
      ignoredTooling?: string[];
      budgets?: PrePushTrialBudgetResult['budgets'];
      hint?: string;
    } = {},
    cleanupFailed = false,
  ): PrePushTrialBudgetResult => {
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
      summary: formatLeastHeadroomLine(budgets, extra.hint),
      exitCode: passed && !cleanupFailed ? 0 : 1,
    };
  };
  if (headSha === null || baseSha === null) {
    return finish('unresolved-ref', false);
  }
  // Reads one file from a commit: null when the commit has no such file, and
  // an error when a listed file cannot be read, so a read failure is never
  // mistaken for a missing file.
  const trees = new Map<string, Set<string>>();
  const showAt = (commit: string, path: string): string | null => {
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
    let parsed: ReturnType<typeof parseManifest>;
    let measured: TouchedBudgets | null = null;
    try {
      parsed = parseManifest(showAt(headSha, MANIFEST_PATH));
      if (changedFiles !== null && parsed.ok && parsed.manifest !== null) {
        const manifest = parsed.manifest;
        measured = measureTouchedBudgets({
          manifest,
          changedFiles,
          readFile: (path) => showAt(headSha, path),
        });
      }
    } catch (error) {
      return finish('budget-fail', false, {
        auditFailures: [(error as Error).message],
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
      return finish('not-behind', false, {
        budgets: { bundles: [], files: [] },
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
  const gitScratch = (cwd: string, args: readonly string[]) =>
    runGit(cwd, [...scratchConfig, ...args]);
  const created: string[] = [];
  const cleanupFailures: string[] = [];
  // Paths whose failed add left a registration that the shared step could not
  // confirm removed. A retry that also fails is a cleanup failure even when the
  // path is already gone, so the scratch directory is kept for the operator.
  const retained = new Set<string>();
  // The worktree add runs through the shared steps. The commit.gpgSign setting
  // is pre-push's own, so it is added here, not in the shared module.
  const runScratchGit: TrialGitRunner = (args, cwd, env) =>
    runGit(cwd, ['-c', 'commit.gpgSign=false', ...args], env);
  const addWorktree = (path: string, commit: string) => {
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
  const trial = (): {
    outcome: PrePushTrialBudgetOutcome;
    auditFailures?: string[];
    ignoredTooling?: string[];
    budgets?: PrePushTrialBudgetResult['budgets'];
  } => {
    // The shared worktree records are changed only under the clone lock, as
    // the trial-merge helper does, so concurrent pre-push checks do not race.
    let lock: CloneLockHandle;
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
  function measureTrialTree(): PrePushTrialBudgetResult['budgets'] {
    const readTrial = (path: string): string | null => {
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
    if (parsed.manifest === null) return { bundles: [], files: [] };
    const measured = measureTouchedBudgets({
      manifest: parsed.manifest,
      changedFiles,
      readFile: readTrial,
    });
    return { bundles: measured.bundles, files: measured.files };
  }

  let verdict: ReturnType<typeof trial> = { outcome: 'worktree-failed' };
  try {
    verdict = trial();
  } finally {
    // Unregistering a worktree also changes shared records, so it is done under
    // the clone lock again. A lock that cannot be taken counts as a cleanup
    // failure for each created path that is still present or whose registration
    // was retained. The scratch directory is kept only when one of those paths
    // is left.
    let cleanupLock: CloneLockHandle | null = null;
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
  let hint: string | undefined;
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

function run(argv: readonly string[]): number {
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

function main(argv: readonly string[]): number {
  try {
    return run(argv);
  } catch (error) {
    console.error(`pre-push-trial-budget: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
