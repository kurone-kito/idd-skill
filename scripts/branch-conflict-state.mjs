#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-conflict-state.mts
//
// The scripts/branch-conflict-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { ghText } from './gh-exec.mjs';

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
if (import.meta.main) {
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
export async function classifyBranchConflictState(prNumber, options = {}) {
  const { owner, repo, _testPrData, _skipGitProbe } = options;
  const notes = [];
  const prData = _testPrData ?? fetchPrData(owner, repo, prNumber);
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
}) {
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
function computeMergeBase(prHeadSha, prBaseSha, prBaseRef, owner, repo, notes) {
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
  prHeadSha,
  prBaseSha,
  prBaseRef,
  owner,
  repo,
  notes,
  skipGitProbe,
) {
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
  prHeadSha,
  prBaseSha,
  prBaseRef,
  owner,
  repo,
  notes,
) {
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
/** Default `origin` URL reader: `git remote get-url origin` in the current
 * working directory (this file's other git probes are likewise un-scoped
 * to a `-C <dir>`, since they always run from inside the target checkout).
 * `gitText` already swallows any git failure and returns `''`. */
function readOriginRemoteUrl() {
  return gitText(['remote', 'get-url', 'origin']);
}
/**
 * Parse the host (hostname, plus `:port` when meaningful) from a git
 * remote URL. Supports both URL-scheme forms parseable by the WHATWG URL
 * parser (`https://host[:port]/owner/repo.git`,
 * `ssh://git@host[:port]/owner/repo.git`) and the scp-like SSH shorthand
 * (`git@host:owner/repo.git`, which has no `://` scheme and is not
 * `URL`-parseable).
 *
 * Port handling is scheme-aware: an `http(s)://` origin's port is
 * preserved, since it is directly reusable for the `https://` fetch URL
 * this resolves for; an `ssh://` origin's port is dropped, since an SSH
 * port is frequently unrelated to a GHES instance's HTTPS port behind a
 * reverse proxy, and carrying it over would silently build a wrong URL.
 * The scp-like shorthand has no port syntax of its own.
 *
 * Returns `null` for empty, unparseable, or host-less input (e.g. a
 * `file://` URL, whose `hostname` is `''`) so callers fall back to
 * another signal. The host is lowercased for consistent comparison —
 * DNS/HTTP hosts are case-insensitive.
 */
export function parseGitHostFromUrl(url) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname) return null;
      const isHttp =
        parsed.protocol === 'http:' || parsed.protocol === 'https:';
      return (isHttp ? parsed.host : parsed.hostname).toLowerCase();
    } catch {
      return null;
    }
  }
  // scp-like shorthand: [user@]host:path (no scheme, so URL() can't parse it).
  const scpMatch = trimmed.match(/^(?:[^@\s]+@)?([^:/\s]+):/);
  return scpMatch ? scpMatch[1].toLowerCase() : null;
}
/**
 * Resolve the git host to use for the read-only base-ref fetch fallback in
 * {@link tryFetchBase}, instead of hardcoding `github.com` (#1454) — a
 * GitHub Enterprise Server (GHES) checkout must fetch from its own host,
 * or the fallback silently targets an unrelated github.com repo of the
 * same owner/repo name (or just fails outright). Preference order:
 *
 * 1. The `GH_HOST` environment variable — the same override `gh` itself
 *    honors — when set and non-blank.
 * 2. The host parsed from the local checkout's `origin` remote URL. This
 *    assumes the fetch-worthy remote is named `origin`, matching every
 *    other git probe in this file; an unusual multi-remote checkout that
 *    names its GHES remote something else falls through to (3).
 * 3. `github.com`, the pre-existing default, when neither signal
 *    resolves.
 */
export function resolveFetchHost(env = process.env, readers = {}) {
  const ghHost = env.GH_HOST?.trim();
  if (ghHost) return ghHost;
  const readOriginUrl = readers.readOriginUrl ?? readOriginRemoteUrl;
  const originHost = parseGitHostFromUrl(readOriginUrl());
  return originHost || 'github.com';
}
function tryFetchBase(prBaseRef, owner, repo, notes) {
  if (!prBaseRef) return;
  if (!owner || !repo) {
    notes.push(
      'Skipped base-ref fetch fallback: owner/repo not provided; merge-base probe may be incomplete.',
    );
    return;
  }
  try {
    const remote = `https://${resolveFetchHost()}/${owner}/${repo}.git`;
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
export function parseConflictFiles(mergeTreeOutput) {
  const files = new Set();
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
function fetchPrData(owner, repo, prNumber) {
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
    return JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse PR data for PR #${prNumber}`);
  }
}
function normalizeNullable(value) {
  if (value === null || value === undefined) return null;
  const s = String(value);
  return s === '' || s === 'null' || s === 'undefined' ? null : s;
}
function gitText(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}
export function parseArgs(argv) {
  const args = { help: false, prNumber: null, owner: null, repo: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const value = argv[i + 1];
    // Reject a missing value (undefined) or a flag-shaped value so that
    // `--pr --json` fails fast instead of consuming `--json` as the value.
    const requireValue = () => {
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
function printUsage() {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
