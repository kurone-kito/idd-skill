// idd-generated-from: src/scripts/supersession-detection.mts
//
// The scripts/supersession-detection.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// The #1484 high-confidence supersession-detection kernel (#1499): a
// mechanical "is this issue already superseded by a merged PR" evaluator,
// plus its read-only `gh` argv-builders, extracted out of
// `suitability-triage.mts` so a future B2.0 mechanization
// (`idd-work.instructions.md`'s post-claim supersession re-check, currently
// prose-only) can reuse this kernel directly instead of duplicating it in a
// second file. `suitability-triage.mts` is Check 4's only current consumer;
// nothing here depends on it, so this module carries no import back to it
// (a future consumer never needs to pull in suitability-triage.mts's whole
// 7-check CLI just to reuse the kernel).
//
// Pure and I/O-free: `evaluateHighConfidenceDuplicate` only evaluates
// already-collected evidence, and the argv-builders only build `gh` command
// arrays -- neither executes anything. The actual `gh` fetch/orchestration
// (`fetchClosedByMergedPrNumbers`, `fetchMergedPrFileOverlapEvidence`, the
// `MERGED_PR_SCAN_DEADLINE_MS` wall-clock budget) stays in
// `suitability-triage.mts`'s own CLI glue, which the issue does not name as
// part of the extraction.

import { normalizeContentionPath } from './discover-shared-file-overlap.mts';

/** Upper bound on the #1484 bounded merged-PR scan (mirrors B2.0's own
 * documented `gh pr list --limit 50`). */
const MERGED_PR_SCAN_LIMIT = 50;

/**
 * GraphQL query for the closed-by-merged-PR read (#1484), bounded to the
 * first 50 closing-PR references. A later page could theoretically hold an
 * additional MERGED reference this misses, but that only makes the tier
 * under-detect (fall back to the weak heuristic) rather than over-detect --
 * the safe fail direction for a check that must never fail TOWARD a false
 * positive, so a full pagination loop (as `idd-roadmap-audit-execute.mts`'s
 * `hasOpenClosingPr` implements for its own different, block-a-close use
 * case) is not required here.
 */
const CLOSED_BY_MERGED_PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      state
      closedByPullRequestsReferences(first:50){
        nodes { number state }
      }
    }
  }
}`;

/**
 * One merged PR's changed-file evidence for the high-confidence tier
 * (#1484), plus the same-issue-reference evidence #1878 adds:
 * `closingIssuesReferences`/`title`/`body` let
 * {@link evaluateHighConfidenceDuplicate} confirm the PR references the
 * candidate issue itself, not merely a file it happens to share. All three
 * are required (not optional) so a caller that starts populating
 * `mergedPrs` must supply them -- an omitted field defaults to "no
 * reference", the fail-safe direction, but `tsc` still forces every
 * construction site to make that a deliberate choice instead of a silent
 * `undefined`.
 */
export interface HighConfidenceMergedPr {
  number: number;
  mergedAt: string;
  files: string[];
  /** Issue numbers this merged PR's `closingIssuesReferences` connection
   * includes (#1878). Distinct from Signal 1's own
   * `closedByMergedPrNumbers` (below): that signal is gated on the
   * candidate issue's own `state` being `CLOSED` (see
   * `fetchClosedByMergedPrNumbers` in `suitability-triage.mts`), so a
   * reopened candidate whose sibling PR merged with `Closes #candidate`
   * is caught here, in Signal 2, and not by Signal 1. */
  closingIssuesReferences: number[];
  /** PR title (#1878): scanned for a `#<candidate-number>` cross-reference
   * when `closingIssuesReferences` doesn't already include the candidate. */
  title: string;
  /** PR body (#1878): scanned for a `#<candidate-number>` cross-reference
   * when `closingIssuesReferences` doesn't already include the candidate. */
  body: string;
}

/**
 * Mechanical B2.0-style evidence for the Check 4 high-confidence tier
 * (#1484): a candidate issue's own `closedByPullRequestsReferences`, plus a
 * bounded merged-PR-vs-`## Candidate files` overlap scan. Reuses
 * `discover-shared-file-overlap.mts`'s path normalization and high-contention
 * set instead of re-implementing either. Every field is defensively
 * re-validated by `evaluateHighConfidenceDuplicate` itself (not just at the
 * caller's own options boundary), so a caller that hand-builds this shape
 * directly can never crash it or manufacture a false hit from a malformed
 * shape; a missing or malformed field just falls through to the caller's own
 * weak heuristic unchanged.
 */
export interface HighConfidenceDuplicateInput {
  closedByMergedPrNumbers: number[];
  candidateFiles: string[];
  /** High-contention files (bundle + manifest) excluded from the overlap
   * check -- a coincidental hit on a broadly-shared file is not on its own
   * high-confidence evidence that THIS issue was superseded. */
  highContentionFiles: string[];
  mergedPrs: HighConfidenceMergedPr[];
}

/**
 * The result of evaluating one suitability check: whether it passed, the
 * human-readable evidence, and -- for a fail -- an optional `tier`
 * distinguishing a high-confidence mechanical hit (this kernel) from a weak
 * heuristic hit (title/declaration matching). `tier` is only ever set on a
 * fail; a pass has nothing to classify. Declared here rather than in
 * `suitability-triage.mts` so this kernel's own return type and the caller's
 * other six (non-Check-4) checks share one type instead of two
 * structurally-identical ones, without `suitability-triage.mts` importing
 * anything back into this module (which would create the exact circular
 * import #1499 asks this extraction to avoid).
 */
export interface CheckOutcome {
  pass: boolean;
  evidence: string;
  tier?: 'high-confidence' | 'weak';
}

/**
 * Resolve the exclusion-adjusted candidate-file set: `candidateFiles`
 * normalized via `normalizeContentionPath`, with `highContentionFiles`
 * (bundle + manifest files many unrelated issues touch) removed. This is
 * the same filter chain `evaluateHighConfidenceDuplicate` applies before its
 * own merged-PR loop, extracted (#1815) so
 * `suitability-triage.mts`'s `fetchMergedPrFileOverlapEvidence` scan can
 * reuse the identical resolution to detect a qualifying overlap PR-by-PR --
 * and stop fetching further PRs' file lists once one is found -- instead of
 * duplicating this normalize-then-exclude logic in a second copy that could
 * silently drift from this one.
 */
export function resolveCandidateFileSet(
  candidateFiles: string[],
  highContentionFiles: string[],
): Set<string> {
  const highContention = new Set(
    highContentionFiles.map((file) => normalizeContentionPath(file)),
  );
  return new Set(
    candidateFiles
      .map((file) => normalizeContentionPath(file))
      .filter((file) => file.length > 0 && !highContention.has(file)),
  );
}

/**
 * Return the subset of `files` present in `candidateSet`, normalized via
 * `normalizeContentionPath` (the same normalization `resolveCandidateFileSet`
 * builds the set with). Always empty when `candidateSet` is empty, mirroring
 * `evaluateHighConfidenceDuplicate`'s own "no exclusion-adjusted candidate
 * files at all" early return -- a caller never needs to special-case an
 * empty set itself.
 */
export function findCandidateFileOverlap(
  files: string[],
  candidateSet: Set<string>,
): string[] {
  if (candidateSet.size === 0) {
    return [];
  }
  return [
    ...new Set(files.map((file) => normalizeContentionPath(file))),
  ].filter((file) => candidateSet.has(file));
}

/**
 * Word-bounded `#<issueNumber>` cross-reference test (#1878), matched
 * against a merged PR's `closingIssuesReferences` connection first, falling
 * back to a plain regex scan of `title`/`body`. `\b` after the digits
 * rejects a longer number sharing the same prefix (`#18620` does not match
 * `issueNumber: 1862`, since two digits share no word boundary), while still
 * matching every form the issue names: `#1862`, `Refs #1862`,
 * `Closes #1862`. Deliberately does not mask markdown code regions first
 * (unlike `checkDuplicateOrSuperseded`'s own free-text declaration scan) --
 * the issue pins a plain substring/regex check with no masking step, and a
 * `#<number>` cross-reference inside a code span or fence is not a realistic
 * false-positive vector for this specific pattern.
 *
 * Defensive against a malformed `pr` shape the same way the rest of this
 * kernel is: a non-array `closingIssuesReferences` or non-string
 * `title`/`body` degrades to "no reference" rather than throwing, and an
 * invalid `issueNumber` (non-positive-integer) always returns `false`.
 */
export function prReferencesIssue(
  pr: {
    closingIssuesReferences?: unknown;
    title?: unknown;
    body?: unknown;
  },
  issueNumber: number,
): boolean {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  const closing = Array.isArray(pr.closingIssuesReferences)
    ? pr.closingIssuesReferences
    : [];
  if (closing.some((entry) => Number(entry) === issueNumber)) {
    return true;
  }
  const pattern = new RegExp(`#${issueNumber}\\b`);
  const title = typeof pr.title === 'string' ? pr.title : '';
  const body = typeof pr.body === 'string' ? pr.body : '';
  return pattern.test(title) || pattern.test(body);
}

/**
 * High-confidence Check 4 tier (#1484): evaluate the mechanical B2.0-style
 * signals -- a merged closing-PR reference on the candidate issue itself, or
 * a merged PR that already changed one of the issue's own declared
 * `## Candidate files` **and** references the candidate issue itself
 * (#1878; see `prReferencesIssue` above) -- excluding high-contention/shared
 * files, which many unrelated issues touch and so are not on their own
 * high-confidence evidence that THIS issue was superseded. Returns `null`
 * -- never a synthesized verdict of its own -- whenever no strong signal
 * fires, so the caller falls through to its own existing weak
 * title/declaration heuristic unchanged. This is the fail-safe contract the
 * issue requires: never fail TOWARD a false high-confidence flag. `input`
 * may be `undefined` (evidence not collected by the caller) or a partially
 * malformed shape; both degrade to "no verdict" rather than a crash or a
 * false hit.
 *
 * `candidateIssueNumber` is required (#1878, not optional/defaulted):
 * Signal 2 below cannot decide "references the candidate" without knowing
 * which issue is the candidate, and a silently-defaulted value (e.g. `0` or
 * `NaN`) would either always or never match depending on the default
 * chosen -- neither is a safe implicit behavior for a check whose whole
 * contract is "never fail toward a false positive". A missing caller-side
 * argument is a compile-time error instead.
 */
export function evaluateHighConfidenceDuplicate(
  input: HighConfidenceDuplicateInput | undefined,
  candidateIssueNumber: number,
): CheckOutcome | null {
  if (!input) {
    return null;
  }

  const closedByMergedPrNumbers = (
    Array.isArray(input.closedByMergedPrNumbers)
      ? input.closedByMergedPrNumbers
      : []
  ).filter((n) => Number.isInteger(n) && n > 0);
  if (closedByMergedPrNumbers.length > 0) {
    // #1878: already an inherent same-issue reference -- this signal comes
    // from the CANDIDATE issue's own `closedByPullRequestsReferences`
    // connection (`fetchClosedByMergedPrNumbers` in `suitability-triage.mts`),
    // so a hit here already means a merged PR closes THIS issue. No
    // additional `prReferencesIssue` check applies to this signal.
    return {
      pass: false,
      evidence: `High-confidence duplicate: issue is already referenced by merged closing PR(s) #${closedByMergedPrNumbers.join(', #')} (closedByPullRequestsReferences).`,
      tier: 'high-confidence',
    };
  }

  const candidateSet = resolveCandidateFileSet(
    Array.isArray(input.candidateFiles) ? input.candidateFiles : [],
    Array.isArray(input.highContentionFiles) ? input.highContentionFiles : [],
  );
  if (candidateSet.size === 0) {
    return null;
  }

  const mergedPrs: unknown[] = Array.isArray(input.mergedPrs)
    ? input.mergedPrs
    : [];
  for (const raw of mergedPrs) {
    const pr = (raw ?? {}) as {
      number?: unknown;
      mergedAt?: unknown;
      files?: unknown;
      closingIssuesReferences?: unknown;
      title?: unknown;
      body?: unknown;
    };
    const number = Number(pr.number);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const files = Array.isArray(pr.files) ? pr.files : [];
    const overlap = findCandidateFileOverlap(files, candidateSet);
    if (overlap.length === 0) {
      continue;
    }
    if (!prReferencesIssue(pr, candidateIssueNumber)) {
      // #1878: file overlap alone is no longer sufficient -- a merged
      // sibling-roadmap PR can legitimately touch the same shared file
      // without ever mentioning THIS candidate issue (the #1862-vs-#1863/
      // PR#1864 false positive this issue fixes). Fall through to the
      // NEXT merged PR in scan order instead of returning here, so a
      // later PR in the same window that both overlaps and references the
      // candidate is still detected.
      continue;
    }
    const mergedAt = String(pr.mergedAt ?? '');
    return {
      pass: false,
      evidence: `High-confidence duplicate: merged PR #${number}${mergedAt ? ` (merged ${mergedAt})` : ''} already changed candidate file(s): ${overlap.sort().join(', ')} and references issue #${candidateIssueNumber}.`,
      tier: 'high-confidence',
    };
  }

  return null;
}

// --- #1484: high-confidence Check 4 tier CLI glue ---------------------------
// Read-only: every function below only ever builds argv for `gh api graphql`
// (with a `query` operation, never `mutation`), `gh pr list`, or `gh pr view`
// (no -X/--method, no issue/PR mutation subcommand) -- none of them execute
// anything themselves. #1484 is detect-only by design; do not add a mutating
// argv-builder here -- a later gated-close follow-up (#1485) is a separate,
// human-gated change. The argv-builders are exported so tests can assert the
// exact read-only verb without shelling out (a compiled-text grep for
// mutating verb literals would miss a `gh api ... -X POST`-shaped mutation,
// since none of these builders produce one).

/**
 * Argv for the closed-by-merged-PR read. Uses `gh api graphql` rather than
 * `gh issue view --json closedByPullRequestsReferences`: the latter's
 * REST-shimmed shape carries no per-PR `state`, and the connection includes
 * OPEN (not yet merged) PRs, not only merged ones -- confirmed empirically
 * against this repo's own issue #1489 (OPEN) / PR #1497 (OPEN), and matches
 * `idd-roadmap-audit-execute.mts`'s documented note that the field "returns
 * merged PRs even with `includeClosedPrs:false`" (i.e. state alone
 * determines relevance, not that flag). Filtering to `state === 'MERGED'`
 * happens in the caller, after this fetch -- without it, an issue with only
 * an in-progress unmerged closing PR would wrongly read as "already
 * referenced by a merged closing PR".
 */
export function buildClosedByMergedPrArgs(
  owner: string,
  repo: string,
  issueNumber: number,
): string[] {
  return [
    'api',
    'graphql',
    '-f',
    `query=${CLOSED_BY_MERGED_PR_QUERY}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `repo=${repo}`,
    '-F',
    `number=${issueNumber}`,
  ];
}

/** Argv for the bounded merged-PR list scan (mirrors B2.0's own documented
 * `gh pr list --search "merged:>=<since>"` shape). */
export function buildMergedPrListArgs(
  repoRef: string,
  sinceIso: string,
): string[] {
  return [
    'pr',
    'list',
    '--repo',
    repoRef,
    '--state',
    'merged',
    '--search',
    `merged:>=${sinceIso}`,
    '--json',
    'number,mergedAt',
    '--limit',
    String(MERGED_PR_SCAN_LIMIT),
  ];
}

/**
 * Argv for one merged PR's changed-file list plus the same-issue-reference
 * evidence #1878 adds (`title`, `body`, `closingIssuesReferences`) --
 * requested on this single existing `gh pr view` call rather than a second
 * one, matching the issue's own "no new API calls needed" framing. Returns
 * the full JSON object (no `--jq` projection) since the caller now needs
 * more than one field; `.files[].path` extraction moves to the caller.
 */
export function buildPrDetailArgs(repoRef: string, prNumber: number): string[] {
  return [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repoRef,
    '--json',
    'files,title,body,closingIssuesReferences',
  ];
}
