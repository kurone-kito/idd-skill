#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-conflict-state.mts
//
// The scripts/branch-conflict-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { execFileSync, spawnSync } from 'node:child_process';

import { ghText } from './gh-exec.mts';

interface PrData {
  headRefOid?: unknown;
  baseRefOid?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
}

interface BranchStateDerivation {
  branchState: string;
  syncRecommendation: string;
  conflictFiles: string[];
  mergeableSource: string;
  baseAdvancedSinceMergeBase: boolean;
}

/**
 * JSON state document printed by this CLI: the branch conflict and
 * synchronization classification for one PR head
 * (schemas/branch-conflict-state.schema.json).
 */
export interface BranchConflictResult {
  protocolVersion: string;
  prNumber: number;
  prHeadSha: string;
  prBaseSha: string;
  published: boolean;
  mergeable: string | null;
  mergeStateStatus: string | null;
  branchState: string;
  syncRecommendation: string;
  baseAdvancedSinceMergeBase: boolean;
  readOnly: boolean;
  worktreeUnchanged: boolean;
  diagnostics: {
    mergeableSource: string;
    conflictFiles: string[];
    notes: string[];
  };
}

interface ClassifyOptions {
  owner?: string;
  repo?: string;
  _testPrData?: PrData;
  _skipGitProbe?: boolean;
}

/** One-line advisory attached to `notes` alongside a `true` result. */
const BASE_ADVANCED_BLIND_SPOT_NOTE =
  'Base has advanced since the merge-base for this branch ' +
  '(baseAdvancedSinceMergeBase); a textually clean/mergeable verdict is ' +
  'conflict-freeness only, not whole-tree CI-invariant freedom (e.g. ' +
  'line-count budgets, generated-file drift, lockfile consistency) against ' +
  'the current base tip, and a pull_request-triggered CI result may be ' +
  'pinned to a merge-ref computed at an earlier trigger time. Consider ' +
  're-validating against current base before relying on a pre-existing ' +
  'green check.';

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  const result = await classifyBranchConflictState(args.prNumber, {
    owner,
    repo,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

export async function classifyBranchConflictState(
  prNumber: unknown,
  options: ClassifyOptions = {},
): Promise<BranchConflictResult> {
  const { owner, repo, _testPrData, _skipGitProbe } = options;
  const notes: string[] = [];

  const prData: PrData = _testPrData ?? fetchPrData(owner, repo, prNumber);
  const prHeadSha = String(prData.headRefOid ?? '');
  const prBaseSha = String(prData.baseRefOid ?? '');
  const prHeadRef = String(prData.headRefName ?? '');
  const prBaseRef = String(prData.baseRefName ?? '');
  const mergeable = prData.mergeable ?? null;
  const mergeStateStatus = prData.mergeStateStatus ?? null;
  const published = Boolean(prHeadSha);

  if (!prHeadSha || !prBaseSha) {
    return {
      protocolVersion: '1',
      prNumber: Number(prNumber),
      prHeadSha: prHeadSha || '',
      prBaseSha: prBaseSha || '',
      published,
      mergeable: null,
      mergeStateStatus: null,
      branchState: 'unknown',
      syncRecommendation: 'hold-unknown',
      baseAdvancedSinceMergeBase: false,
      readOnly: true,
      worktreeUnchanged: true,
      diagnostics: {
        mergeableSource: 'none',
        conflictFiles: [],
        notes: [
          'PR head or base SHA unavailable; cannot classify branch state.',
        ],
      },
    };
  }

  const {
    branchState,
    syncRecommendation,
    conflictFiles,
    mergeableSource,
    baseAdvancedSinceMergeBase,
  } = deriveBranchState({
    prHeadSha,
    prBaseSha,
    prHeadRef,
    prBaseRef,
    mergeable,
    mergeStateStatus,
    notes,
    owner,
    repo,
    skipGitProbe: Boolean(_skipGitProbe),
  });

  return {
    protocolVersion: '1',
    prNumber: Number(prNumber),
    prHeadSha,
    prBaseSha,
    published,
    mergeable: normalizeNullable(mergeable),
    mergeStateStatus: normalizeNullable(mergeStateStatus),
    branchState,
    syncRecommendation,
    baseAdvancedSinceMergeBase,
    readOnly: true,
    worktreeUnchanged: true,
    diagnostics: {
      mergeableSource,
      conflictFiles,
      notes,
    },
  };
}

function deriveBranchState({
  prHeadSha,
  prBaseSha,
  prBaseRef,
  mergeable,
  mergeStateStatus,
  notes,
  owner,
  repo,
  skipGitProbe,
}: {
  prHeadSha: string;
  prBaseSha: string;
  prHeadRef?: string;
  prBaseRef: string;
  mergeable: unknown;
  mergeStateStatus: unknown;
  notes: string[];
  owner: string | undefined;
  repo: string | undefined;
  skipGitProbe: boolean;
}): BranchStateDerivation {
  const mergeableNorm = String(mergeable ?? '').toUpperCase();
  const mergeStateNorm = String(mergeStateStatus ?? '').toUpperCase();

  if (mergeableNorm === 'CONFLICTING') {
    const probeResult = skipGitProbe
      ? []
      : probeConflictFilesReadOnly(
          prHeadSha,
          prBaseSha,
          prBaseRef,
          owner,
          repo,
          notes,
        );
    return {
      branchState: 'content-conflict',
      syncRecommendation: 'hold-unknown',
      conflictFiles: probeResult ?? [],
      mergeableSource: 'github-mergeable',
      // A real textual conflict already forces a hold; whether base also
      // advanced past the merge-base is not an independently useful signal
      // here, so this is not computed for this branch.
      baseAdvancedSinceMergeBase: false,
    };
  }

  if (mergeStateNorm === 'DIRTY') {
    return {
      branchState: 'dirty',
      syncRecommendation: 'hold-unknown',
      conflictFiles: [],
      mergeableSource: 'github-merge-state',
      baseAdvancedSinceMergeBase: false,
    };
  }

  if (mergeableNorm === 'MERGEABLE' && mergeStateNorm === 'CLEAN') {
    const baseAdvancedSinceMergeBase = computeBaseAdvanced(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
      skipGitProbe,
    );
    if (baseAdvancedSinceMergeBase) {
      notes.push(BASE_ADVANCED_BLIND_SPOT_NOTE);
    }
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeStateNorm === 'BEHIND') {
    // GitHub's BEHIND state is definitional: the base has already advanced
    // past this branch's merge-base (that is what "behind" means), so this
    // is known for free without an extra git probe, for every return below.
    const baseAdvancedSinceMergeBase = true;
    if (skipGitProbe) {
      return {
        branchState: 'behind-no-conflict',
        syncRecommendation: 'merge-main',
        conflictFiles: [],
        mergeableSource: 'github-merge-state',
        baseAdvancedSinceMergeBase,
      };
    }
    const probeResult = probeConflictFilesReadOnly(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
    );
    if (probeResult === null) {
      return {
        branchState: 'unknown',
        syncRecommendation: 'hold-unknown',
        conflictFiles: [],
        mergeableSource: 'git-merge-tree',
        baseAdvancedSinceMergeBase,
      };
    }
    if (probeResult.length > 0) {
      return {
        branchState: 'content-conflict',
        syncRecommendation: 'hold-unknown',
        conflictFiles: probeResult,
        mergeableSource: 'git-merge-tree',
        baseAdvancedSinceMergeBase,
      };
    }
    return {
      branchState: 'behind-no-conflict',
      syncRecommendation: 'merge-main',
      conflictFiles: [],
      mergeableSource: 'git-merge-tree',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeableNorm === 'MERGEABLE') {
    const baseAdvancedSinceMergeBase = computeBaseAdvanced(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
      skipGitProbe,
    );
    if (baseAdvancedSinceMergeBase) {
      notes.push(BASE_ADVANCED_BLIND_SPOT_NOTE);
    }
    return {
      branchState: 'clean',
      syncRecommendation: 'none',
      conflictFiles: [],
      mergeableSource: 'github-mergeable',
      baseAdvancedSinceMergeBase,
    };
  }

  if (mergeableNorm === 'UNKNOWN' || !mergeableNorm) {
    notes.push(
      `Mergeable status is ${mergeable ?? 'null'}; GitHub computes mergeability asynchronously, so this is most likely still computing. Re-poll before treating it as terminal.`,
    );
    return {
      branchState: 'computing',
      syncRecommendation: 'recheck',
      conflictFiles: [],
      mergeableSource: 'none',
      baseAdvancedSinceMergeBase: false,
    };
  }

  notes.push(
    `Unrecognized mergeable=${mergeable} / mergeStateStatus=${mergeStateStatus}.`,
  );
  return {
    branchState: 'unknown',
    syncRecommendation: 'hold-unknown',
    conflictFiles: [],
    mergeableSource: 'none',
    baseAdvancedSinceMergeBase: false,
  };
}

/**
 * Read-only local `git merge-base` lookup, falling back to a shallow fetch
 * of the base ref when the base commit is not yet present locally (e.g. a
 * shallow CI checkout that only has the PR head). Returns `null` when the
 * merge-base still cannot be resolved after the fallback fetch; callers
 * decide how to report that indeterminate outcome, since "conflict probe"
 * and "base-advancement" callers need different diagnostics wording for the
 * same underlying null.
 */
function computeMergeBase(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): string | null {
  let mergeBase = gitText(['merge-base', prHeadSha, prBaseSha]);
  if (!mergeBase) {
    tryFetchBase(prBaseRef, owner, repo, notes);
    mergeBase = gitText(['merge-base', prHeadSha, prBaseSha]);
  }
  return mergeBase || null;
}

/**
 * True when the base ref has moved past this PR's merge-base, independent of
 * `syncRecommendation` -- the blind spot this field exists to close. Returns
 * `false` both when base genuinely has not advanced and when the merge-base
 * could not be resolved at all; the latter, indeterminate case is
 * distinguished only via a `notes` entry, never silently reported as a
 * confirmed "no" (see the `computeMergeBase` doc comment above).
 */
function computeBaseAdvanced(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
  skipGitProbe: boolean,
): boolean {
  if (skipGitProbe) return false;
  try {
    const mergeBase = computeMergeBase(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
    );
    if (!mergeBase) {
      notes.push(
        'merge-base not found; base-advancement since merge-base is undetermined (reported as false).',
      );
      return false;
    }
    return mergeBase !== prBaseSha;
  } catch {
    notes.push(
      'git merge-base unavailable; base-advancement since merge-base is undetermined (reported as false).',
    );
    return false;
  }
}

function probeConflictFilesReadOnly(
  prHeadSha: string,
  prBaseSha: string,
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): string[] | null {
  try {
    const mergeBase = computeMergeBase(
      prHeadSha,
      prBaseSha,
      prBaseRef,
      owner,
      repo,
      notes,
    );
    if (!mergeBase) {
      notes.push(
        'merge-base not found; cannot prove conflict-free; holding unknown.',
      );
      return null;
    }
    const result = spawnSync(
      'git',
      ['merge-tree', `--merge-base=${mergeBase}`, prHeadSha, prBaseSha],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    if (result.status !== 0 && result.status !== 1) {
      notes.push(
        `git merge-tree exited with status ${result.status}; cannot probe conflicts.`,
      );
      return null;
    }
    const conflictFiles = parseConflictFiles(result.stdout ?? '');
    if (result.status === 1 && conflictFiles.length === 0) {
      notes.push(
        'git merge-tree exited 1 but no conflict files were parsed; treating as unknown.',
      );
      return null;
    }
    return conflictFiles;
  } catch {
    notes.push(
      'git merge-tree unavailable; falling back to GitHub mergeability signal only.',
    );
    return null;
  }
}

function tryFetchBase(
  prBaseRef: string,
  owner: string | undefined,
  repo: string | undefined,
  notes: string[],
): void {
  if (!prBaseRef) return;
  if (!owner || !repo) {
    notes.push(
      'Skipped base-ref fetch fallback: owner/repo not provided; merge-base probe may be incomplete.',
    );
    return;
  }
  try {
    const remote = `https://github.com/${owner}/${repo}.git`;
    execFileSync(
      'git',
      ['fetch', '--no-tags', '--depth=1', remote, prBaseRef],
      {
        stdio: 'ignore',
        encoding: 'utf8',
      },
    );
  } catch {
    notes.push(
      `Could not fetch base ref ${prBaseRef}; merge-base probe may be incomplete.`,
    );
  }
}

export function parseConflictFiles(mergeTreeOutput: string): string[] {
  const files = new Set<string>();
  for (const line of mergeTreeOutput.split('\n')) {
    // "CONFLICT (content): Merge conflict in path/to/file"
    // "CONFLICT (add/add): Merge conflict in path/to/file"
    // Any conflict type whose message ends with "Merge conflict in <path>"
    const mergeConflictMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+Merge conflict in\s+(.+?)\s*$/i,
    );
    if (mergeConflictMatch) {
      files.add(mergeConflictMatch[1].trim());
      continue;
    }
    // "CONFLICT (modify/delete): <path> deleted in ... and modified in ..."
    // "CONFLICT (rename/delete): <old> renamed to <new> in ..."
    // "CONFLICT (rename/rename): <path> renamed to <a> in X and to <b> in Y"
    // First token after "TYPE): " is the conflicted original path
    const firstTokenMatch = line.match(
      /^CONFLICT\s+\([^)]+\):\s+(.+?)\s+(?:deleted|renamed|added|modified)\s+/i,
    );
    if (firstTokenMatch) {
      files.add(firstTokenMatch[1].trim());
    }
  }
  return [...files];
}

function fetchPrData(
  owner: string | undefined,
  repo: string | undefined,
  prNumber: unknown,
): PrData {
  const raw = ghText([
    'pr',
    'view',
    String(prNumber),
    '-R',
    `${owner}/${repo}`,
    '--json',
    'number,headRefOid,baseRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,headRepository',
    '--jq',
    '.',
  ]);
  try {
    return JSON.parse(raw) as PrData;
  } catch {
    throw new Error(`Failed to parse PR data for PR #${prNumber}`);
  }
}

function normalizeNullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}

function gitText(args: string[]): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

function isMainModule(metaUrl: string): boolean {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return metaUrl === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

export function parseArgs(argv: string[]): {
  help: boolean;
  prNumber: string | null;
  owner: string | null;
  repo: string | null;
} {
  const args: {
    help: boolean;
    prNumber: string | null;
    owner: string | null;
    repo: string | null;
  } = { help: false, prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = argv[i + 1];
    // Reject a missing value (undefined) or a flag-shaped value so that
    // `--pr --json` fails fast instead of consuming `--json` as the value.
    const requireValue = (): string => {
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--pr') {
      const raw = requireValue();
      if (!/^[1-9]\d*$/.test(raw)) {
        throw new Error(`invalid --pr value: ${raw}`);
      }
      args.prNumber = raw;
      i++;
      continue;
    }
    if (token === '--owner') {
      args.owner = requireValue();
      i++;
      continue;
    }
    if (token === '--repo') {
      args.repo = requireValue();
      i++;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
