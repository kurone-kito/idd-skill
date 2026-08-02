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
import { normalizeContentionPath } from './discover-shared-file-overlap.mjs';

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
export function resolveCandidateFileSet(candidateFiles, highContentionFiles) {
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
export function findCandidateFileOverlap(files, candidateSet) {
  if (candidateSet.size === 0) {
    return [];
  }
  return [
    ...new Set(files.map((file) => normalizeContentionPath(file))),
  ].filter((file) => candidateSet.has(file));
}
/**
 * High-confidence Check 4 tier (#1484): evaluate the mechanical B2.0-style
 * signals -- a merged closing-PR reference on the candidate issue itself, or
 * a merged PR that already changed one of the issue's own declared
 * `## Candidate files` (excluding high-contention/shared files, which many
 * unrelated issues touch and so are not on their own high-confidence
 * evidence that THIS issue was superseded). Returns `null` -- never a
 * synthesized verdict of its own -- whenever no strong signal fires, so the
 * caller falls through to its own existing weak title/declaration heuristic
 * unchanged. This is the fail-safe contract the issue requires: never fail
 * TOWARD a false high-confidence flag. `input` may be `undefined` (evidence
 * not collected by the caller) or a partially malformed shape; both degrade
 * to "no verdict" rather than a crash or a false hit.
 */
export function evaluateHighConfidenceDuplicate(input) {
  if (!input) {
    return null;
  }
  const closedByMergedPrNumbers = (
    Array.isArray(input.closedByMergedPrNumbers)
      ? input.closedByMergedPrNumbers
      : []
  ).filter((n) => Number.isInteger(n) && n > 0);
  if (closedByMergedPrNumbers.length > 0) {
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
  const mergedPrs = Array.isArray(input.mergedPrs) ? input.mergedPrs : [];
  for (const raw of mergedPrs) {
    const pr = raw ?? {};
    const number = Number(pr.number);
    if (!Number.isInteger(number) || number <= 0) {
      continue;
    }
    const files = Array.isArray(pr.files) ? pr.files : [];
    const overlap = findCandidateFileOverlap(files, candidateSet);
    if (overlap.length > 0) {
      const mergedAt = String(pr.mergedAt ?? '');
      return {
        pass: false,
        evidence: `High-confidence duplicate: merged PR #${number}${mergedAt ? ` (merged ${mergedAt})` : ''} already changed candidate file(s): ${overlap.sort().join(', ')}.`,
        tier: 'high-confidence',
      };
    }
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
export function buildClosedByMergedPrArgs(owner, repo, issueNumber) {
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
export function buildMergedPrListArgs(repoRef, sinceIso) {
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
/** Argv for one merged PR's changed-file list. */
export function buildPrFilesArgs(repoRef, prNumber) {
  return [
    'pr',
    'view',
    String(prNumber),
    '--repo',
    repoRef,
    '--json',
    'files',
    '--jq',
    '.files[].path',
  ];
}
