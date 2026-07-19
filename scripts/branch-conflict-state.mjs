#!/usr/bin/env node
// idd-generated-from: src/scripts/branch-conflict-state.mts
//
// The scripts/branch-conflict-state.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { parseCliArgs } from './cli-args.mjs';
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
// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant.
const BRANCH_CONFLICT_STATE_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
/**
 * Bounded fetch-depth escalation steps tried by {@link computeMergeBase}'s
 * retry loop, in order. The first step (`--depth=1`) matches the
 * pre-existing single-shallow-fetch behavior byte-for-byte, so a checkout
 * that already resolves after one shallow fetch performs exactly the same
 * single extra fetch call as before this retry loop existed (#1519's "no
 * regression for the common case" requirement). Each later step widens
 * local history via `git fetch --deepen=<n>` -- relative to the current
 * shallow boundary, so repeated calls compose instead of re-fetching the
 * same fixed `--depth=N` -- instead of retrying forever. Three total
 * attempts mirrors the bounded-retry shape F1's `computing` re-poll budget
 * already uses elsewhere in this codebase (`idd-pre-merge.instructions.md`).
 *
 * Exported so tests can fetch with these exact args against a hermetic
 * local fixture remote (see `tests/branch-conflict-state.test.mts`'s
 * shallow-checkout fixture) instead of a hand-copied duplicate that could
 * silently drift from what `tryFetchBase` actually runs in production.
 *
 * Declared here, above the CLI entry block below, rather than next to
 * {@link computeMergeBase} that actually uses it: the entry block's
 * top-level `await` parks module evaluation there on the CLI path, so a
 * module-level `const` declared textually after it would still be in its
 * temporal dead zone the first time a helper reads it (see
 * `tests/cli-entry-smoke.test.mts`'s module-eval-order guard, #1447).
 */
export const MERGE_BASE_FETCH_STEPS = [
  ['--depth=1'],
  ['--deepen=20'],
  ['--deepen=200'],
];
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
 * Bounded merge-base resolution retry used by {@link computeMergeBase}: call
 * `lookupMergeBase()`, and on an empty result, call `widenHistory(stepIndex)`
 * before each subsequent lookup -- stopping as soon as a merge-base
 * resolves, `widenHistory` reports it could not widen history (e.g. no
 * fetchable base ref, or the fetch itself failed, so a deeper attempt would
 * not plausibly help either), or `stepCount` attempts are exhausted.
 *
 * Exported so the retry-loop and attempt-cap shape itself stays directly
 * unit-testable (both the deepened-success and still-undetermined paths)
 * independent of `tryFetchBase`'s own remote-URL assembly and real `git
 * fetch` call, which stay deliberately untested at their call site (see
 * `tryFetchBase`'s doc comment) -- matching this file's existing
 * hermetic-test convention of never letting a test reach a live network
 * fetch.
 */
export function resolveMergeBaseWithRetry(
  lookupMergeBase,
  widenHistory,
  stepCount,
) {
  let mergeBase = lookupMergeBase();
  for (let step = 0; !mergeBase && step < stepCount; step += 1) {
    if (!widenHistory(step)) break;
    mergeBase = lookupMergeBase();
  }
  return mergeBase || null;
}
/**
 * Read-only local `git merge-base` lookup, falling back to a bounded,
 * progressively deeper fetch of the base ref when the base commit is not
 * yet present locally (e.g. a shallow CI checkout that only has the PR
 * head, or an agent worktree that has not fetched recent base history).
 * Returns `null` when the merge-base still cannot be resolved after
 * exhausting {@link MERGE_BASE_FETCH_STEPS}; callers decide how to report
 * that indeterminate outcome, since "conflict probe" and "base-advancement"
 * callers need different diagnostics wording for the same underlying null.
 */
function computeMergeBase(prHeadSha, prBaseSha, prBaseRef, owner, repo, notes) {
  return resolveMergeBaseWithRetry(
    () => gitText(['merge-base', prHeadSha, prBaseSha]),
    (step) =>
      tryFetchBase(prBaseRef, owner, repo, notes, MERGE_BASE_FETCH_STEPS[step]),
    MERGE_BASE_FETCH_STEPS.length,
  );
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
 * Parse the scheme and host (hostname, plus `:port` when meaningful) from
 * a git remote URL. Supports the `http://` / `https://` URL-scheme forms
 * (parseable by the WHATWG URL parser) and the scp-like SSH shorthand
 * (`[user@]host:path`, which has no `://` scheme and is not
 * `URL`-parseable; per git's own URL syntax the `user@` prefix is
 * optional, e.g. a bare `ghes.example.com:owner/repo.git` is valid).
 *
 * The returned `scheme` always matches an `http://` or `https://` origin's
 * own scheme — an `http://`-only GHES instance (no TLS, e.g. behind a
 * private network boundary) must stay `http`, since silently upgrading to
 * `https` on the same port would target a port that is not serving TLS
 * and the fetch would fail; that origin's port is preserved too, since it
 * is directly reusable here.
 *
 * An `ssh://` URL-scheme origin (or any other non-`http(s)` scheme)
 * deliberately returns `null` rather than reusing its hostname: an SSH
 * hostname is sometimes an alias with no HTTPS service of its own —
 * GitHub's own documented `ssh.github.com` (used for SSH-over-443
 * firewall traversal) accepts SSH, not HTTPS, on that hostname, and a
 * local `~/.ssh/config` `Host` alias may not resolve via DNS at all.
 * Guessing wrong here would regress a previously-working `github.com`
 * fallback into a broken fetch, so this signal is treated as unusable
 * rather than guessed at. The scp-like shorthand keeps reusing its host,
 * since that syntax has no port field of its own and is therefore not
 * used for GitHub's SSH-over-443 workaround in practice — the same
 * hostname is the overwhelmingly common real-world case for a GHES
 * remote's SSH and HTTPS endpoints.
 *
 * Returns `null` for empty, unparseable, or host-less input (e.g. a
 * `file://` URL, whose `hostname` is `''`) so callers fall back to
 * another signal. The host is lowercased for consistent comparison —
 * DNS/HTTP hosts are case-insensitive.
 */
export function parseGitFetchOrigin(url) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.includes('://')) {
    try {
      const parsed = new URL(trimmed);
      if (!parsed.hostname) return null;
      if (parsed.protocol === 'http:') {
        return { scheme: 'http', host: parsed.host.toLowerCase() };
      }
      if (parsed.protocol === 'https:') {
        return { scheme: 'https', host: parsed.host.toLowerCase() };
      }
      // ssh:// (or any other scheme): no reusable host -- see the doc
      // comment above.
      return null;
    } catch {
      return null;
    }
  }
  // scp-like shorthand: [user@]host:path (no scheme, so URL() can't parse
  // it). A single-character "host" is excluded rather than requiring
  // `user@`: git's own scp-like syntax makes the username optional (a
  // real GHES remote can validly omit it), but no real git host is a
  // single letter, so this is almost always a Windows drive-letter path
  // (`C:\Users\...`, `C:repo.git`) rather than a real host.
  //
  // A bracketed IPv6 literal host (`[2001:db8::1]`) is matched before the
  // generic host pattern: IPv6 literals contain colons of their own, so
  // the generic `[^:/\s]+` alternative would otherwise stop at the first
  // one and capture only a truncated fragment (e.g. `[2001`).
  const scpMatch = trimmed.match(/^(?:[^@\s]+@)?(\[[^\]\s]+\]|[^:/\s]+):/);
  const host = scpMatch?.[1];
  return host && host.length > 1
    ? { scheme: 'https', host: host.toLowerCase() }
    : null;
}
/**
 * Resolve the scheme + host to use for the read-only base-ref fetch
 * fallback in {@link tryFetchBase}, instead of hardcoding
 * `https://github.com` (#1454) — a GitHub Enterprise Server (GHES)
 * checkout must fetch from its own host, or the fallback silently targets
 * an unrelated github.com repo of the same owner/repo name (or just
 * fails outright). Preference order:
 *
 * 1. The `GH_HOST` environment variable — the same override `gh` itself
 *    honors — when set and non-blank. `GH_HOST` never carries a scheme,
 *    so this always resolves to `https` (the same assumption `gh` itself
 *    makes for its own HTTPS operations).
 * 2. The scheme and host parsed from the local checkout's `origin`
 *    remote URL. This assumes the fetch-worthy remote is named `origin`,
 *    the conventional default for a single-remote checkout; an unusual
 *    multi-remote checkout that names its GHES remote something else
 *    falls through to (3).
 * 3. `https://github.com`, the pre-existing default, when neither signal
 *    resolves.
 */
export function resolveFetchOrigin(env = process.env, readers = {}) {
  const ghHost = env.GH_HOST?.trim();
  // Lowercased for consistency with the origin-derived path below (DNS/HTTP
  // hosts are case-insensitive either way, so this does not change fetch
  // behavior -- only comparison/display consistency).
  if (ghHost) return { scheme: 'https', host: ghHost.toLowerCase() };
  const readOriginUrl = readers.readOriginUrl ?? readOriginRemoteUrl;
  return (
    parseGitFetchOrigin(readOriginUrl()) ?? {
      scheme: 'https',
      host: 'github.com',
    }
  );
}
/**
 * Attempt one fetch of the base ref at the given depth/deepen args, for
 * {@link computeMergeBase}'s bounded retry loop (via {@link
 * resolveMergeBaseWithRetry}). Returns `true` when the `git fetch` call
 * itself succeeded, so the caller's retry loop knows a deeper next step
 * could plausibly still help; returns `false` when preconditions
 * (`prBaseRef`, `owner`, `repo`) are missing, or when the fetch itself
 * failed (network, auth, unknown ref, etc.) -- in either case a further
 * attempt against the same unreachable/absent target would not change the
 * outcome, so the caller should stop immediately rather than repeat the
 * same failure (and its `notes` entry) across every remaining step.
 */
function tryFetchBase(prBaseRef, owner, repo, notes, fetchArgs) {
  if (!prBaseRef) return false;
  if (!owner || !repo) {
    notes.push(
      'Skipped base-ref fetch fallback: owner/repo not provided; merge-base probe may be incomplete.',
    );
    return false;
  }
  try {
    // resolveFetchOrigin()'s own branching (GH_HOST / origin-remote /
    // default) is unit-tested directly; this URL-assembly line and the
    // real `git fetch` below stay deliberately untested at this call
    // site, matching this file's existing test-suite convention of never
    // letting a test reach a live network fetch (see the "unresolvable
    // merge-base" test's `baseRefName: ''` short-circuit).
    const { scheme, host } = resolveFetchOrigin();
    const remote = `${scheme}://${host}/${owner}/${repo}.git`;
    execFileSync(
      'git',
      ['fetch', '--no-tags', ...fetchArgs, remote, prBaseRef],
      {
        stdio: 'ignore',
        encoding: 'utf8',
      },
    );
    return true;
  } catch {
    notes.push(
      `Could not fetch base ref ${prBaseRef} (git fetch ${fetchArgs.join(' ')}); merge-base probe may be incomplete.`,
    );
    return false;
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
  const { values, help } = parseCliArgs(argv, BRANCH_CONFLICT_STATE_FLAG_SPEC);
  // --pr stays a canonical-positive-integer STRING (not a parsed number):
  // the caller passes it straight through to classifyBranchConflictState /
  // gh invocations as text, and tests/branch-conflict-state.test.mts
  // asserts this exact string-typed contract. Kept as a manual regex check
  // (not the canonical-integer helper) so the return type stays a string.
  const rawPr = values.pr;
  let prNumber = null;
  if (rawPr !== undefined) {
    if (!/^[1-9]\d*$/.test(rawPr)) {
      throw new Error(`invalid --pr value: ${rawPr}`);
    }
    prNumber = rawPr;
  }
  return {
    help,
    prNumber,
    owner: values.owner ?? null,
    repo: values.repo ?? null,
  };
}
function printUsage() {
  process.stdout.write(
    `Usage:\n  node scripts/branch-conflict-state.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n`,
  );
}
