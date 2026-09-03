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
import { stripMarkdownCodeRegions } from './markdown-code.mjs';
import { escapeRegex } from './marker-regex.mjs';

/** Default `{prefix}` for every marker this module parses, matching
 * `autopilot-suitability.mts`'s own default. */
const DEFAULT_MARKER_PREFIX = 'idd-skill';
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
 * Closing-keyword-adjacent `#<issueNumber>` cross-reference test (#1878;
 * narrowed by #1888), matched against a merged PR's
 * `closingIssuesReferences` connection first, falling back to a regex scan
 * of `title`/`body`. That regex scan **requires** a recognized GitHub
 * closing keyword (`close(s|d)?`, `fix(es|ed)?`, `resolve(s|d)?`,
 * case-insensitive) immediately before the reference, separated only by
 * whitespace -- the same grammar `idd-pr-submit.instructions.md`'s D3.5
 * step already documents for closing-keyword detection
 * (`\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+#<N>\b`). A bare `#<n>`
 * mention with no adjacent closing keyword no longer counts as a reference:
 * PR #1886 (closes only #1878) bare-mentioned "#1862" once as a narrative
 * reproduction-example citation ("observed live: issue #1862 vs. merged PR
 * #1864...") rather than declaring it implements #1862, which the prior
 * unconditional bare-mention fallback (#1878) wrongly treated as evidence
 * PR #1886 itself superseded #1862. `\b` after the digits still rejects a
 * longer number sharing the same prefix (`Closes #18620` does not match
 * `issueNumber: 1862`), and the mandatory `\s+` between keyword and `#`
 * means a keyword glued directly to the reference (`closes#1862`, no
 * whitespace) does not match either. Deliberately does not mask markdown
 * code regions first (unlike `checkDuplicateOrSuperseded`'s own free-text
 * declaration scan) -- the issue pins a plain substring/regex check with no
 * masking step, and a closing-keyword-adjacent cross-reference inside a
 * code span or fence is not a realistic false-positive vector for this
 * specific pattern.
 *
 * Defensive against a malformed `pr` shape the same way the rest of this
 * kernel is: a non-array `closingIssuesReferences` or non-string
 * `title`/`body` degrades to "no reference" rather than throwing, and an
 * invalid `issueNumber` (non-positive-integer) always returns `false`.
 */
export function prReferencesIssue(pr, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    return false;
  }
  const closing = Array.isArray(pr.closingIssuesReferences)
    ? pr.closingIssuesReferences
    : [];
  // Copilot review finding on PR #1886: accept both a raw number entry
  // (the shape suitability-triage.mts's own caller already normalizes to
  // before calling this function) and a raw `{ number }` object entry (the
  // shape `gh pr view --json closingIssuesReferences` itself actually
  // returns, confirmed empirically) -- `Number({ number: 1862 })` alone
  // evaluates to `NaN` and would silently degrade a true match to "no
  // reference" if a future caller ever passed the unnormalized `gh`
  // payload straight through.
  if (
    closing.some((entry) => {
      if (entry !== null && typeof entry === 'object') {
        return Number(entry.number) === issueNumber;
      }
      return Number(entry) === issueNumber;
    })
  ) {
    return true;
  }
  // #1888: narrowed from a bare `#<n>` scan (#1878) to require a
  // recognized GitHub closing keyword immediately before the reference --
  // "this PR references that issue as background/example context" is no
  // longer treated the same as "this PR implements that issue's own
  // deliverable". `\b` before the keyword group rejects a keyword glued to
  // a longer word (`Autoclose` does not match `close`), the mandatory
  // `\s+` requires at least one whitespace character between the keyword
  // and `#` (rejecting both a keyword glued directly to the reference,
  // e.g. `closes#1862`, and the #1878 `foo#1862` word-glued-`#` case --
  // whitespace is never a word character, so nothing word-glued can
  // precede `#` here), and the trailing `\b` still rejects a longer number
  // sharing the same digit prefix (`Closes #18620` does not match
  // `issueNumber: 1862`). Case-insensitive so `Closes`, `closes`, `CLOSES`,
  // etc. all match.
  const pattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`,
    'i',
  );
  const title = typeof pr.title === 'string' ? pr.title : '';
  const body = typeof pr.body === 'string' ? pr.body : '';
  return pattern.test(title) || pattern.test(body);
}
/** Literal prefix a trusted-actor "A4.5 suitability gate rejection" comment
 * must start with (after trimming leading whitespace) to be recognized as
 * an authoritative prior verdict by {@link findTrustedSuitabilityRejection}
 * (#1887). Exported so `suitability-triage.mts` and its tests reference the
 * exact same literal the A4.5 posting convention itself uses
 * (`idd-suitability.instructions.md`'s Mutation Policy section) instead of
 * risking two copies drifting apart. */
export const SUITABILITY_REJECTION_PREFIX = 'A4.5 suitability gate rejection';
// Not anchored to line start/end: real rejection comments interleave the
// `outcome: <token>` declaration with trailing prose on the same line (e.g.
// "outcome: duplicate (mechanical, narrow false positive -- see above)"),
// so a `^...$` anchor would silently miss it. The trailing `\b` still
// prevents a longer word sharing the same prefix (e.g. "duplicated") from
// matching. Restricted to the six canonical A4.5 outcome values
// (`idd-suitability.instructions.md`'s Failure Outcomes table) so this
// never invents a token the protocol doesn't recognize.
const SUITABILITY_REJECTION_OUTCOME_PATTERN =
  /outcome:\s*(unclear|needs-decision|blocked-by-human|duplicate|out-of-scope|invalid)\b/i;
const SUITABILITY_REJECTION_CHECK_PATTERN = /Check\s+\d+\s*\([^)]+\)/i;
/** The four A4.5 outcomes with no dedicated label (#2243): the only values
 * `<!-- {prefix}-triage-verdict: <outcome> -->` may declare.
 * `needs-decision`/`blocked-by-human` are deliberately excluded -- those
 * two already carry a stable label and never emit this marker. */
export const SUITABILITY_TRIAGE_VERDICT_OUTCOMES = [
  'unclear',
  'duplicate',
  'out-of-scope',
  'invalid',
];
function isSuitabilityTriageVerdictOutcome(value) {
  return SUITABILITY_TRIAGE_VERDICT_OUTCOMES.includes(value);
}
/**
 * Canonical parser for the authored `<!-- {prefix}-triage-verdict:
 * <outcome> -->` marker (#2243), mirroring
 * `autopilot-suitability.mts`'s `parseAutopilotSuitabilityMarker` shape and
 * fail-safe rules: `present` is false only when no marker appears at all;
 * `outcome` is the single coherent token when it is one of
 * {@link SUITABILITY_TRIAGE_VERDICT_OUTCOMES}, or `null` (fail-safe = "no
 * marker") when the marker is absent, carries an unrecognized token, or
 * repeats with disagreeing values; `malformed` is true only when a marker
 * is present but does not resolve to a coherent outcome.
 *
 * `body` is masked with {@link stripMarkdownCodeRegions} first so a marker
 * merely *quoted* in prose (for example, an issue or comment explaining
 * this marker's own syntax in a code span, as #2243's own body does)
 * cannot be mistaken for a live one (#1614, #1121 precedent).
 */
export function parseSuitabilityTriageVerdictMarker(
  body,
  markerPrefix = DEFAULT_MARKER_PREFIX,
) {
  const prefix =
    typeof markerPrefix === 'string' && markerPrefix.length > 0
      ? markerPrefix
      : DEFAULT_MARKER_PREFIX;
  const regex = new RegExp(
    `<!--\\s*${escapeRegex(prefix)}-triage-verdict:\\s*([^\\s>]+)\\s*-->`,
    'gi',
  );
  const text = stripMarkdownCodeRegions(String(body ?? ''));
  let present = false;
  let outcome = null;
  let match = regex.exec(text);
  while (match) {
    present = true;
    const raw = (match[1] ?? '').toLowerCase();
    if (
      !isSuitabilityTriageVerdictOutcome(raw) ||
      (outcome !== null && raw !== outcome)
    ) {
      return { present: true, outcome: null, malformed: true };
    }
    outcome = raw;
    match = regex.exec(text);
  }
  return { present, outcome, malformed: false };
}
/**
 * Staleness anchor for a suitability-rejection marker (#2243): the latest
 * GitHub `created_at` among the issue's own creation and every timeline
 * `edited` event that changed the title or body. Mirrors
 * `claim-approval-gate.mts`'s private `resolveLatestSubstantiveEditAt` --
 * duplicated rather than imported to keep this module's dependency-light,
 * I/O-free kernel contract intact (see the file header). Returns `null`
 * only when neither `issueCreatedAt` nor any qualifying event yields a
 * parseable timestamp -- callers must treat that as "unknown", never as
 * "always stale" or "never stale".
 */
export function resolveLatestSubstantiveIssueEditAt(
  issueCreatedAt,
  timelineEvents,
) {
  const candidates = [];
  if (typeof issueCreatedAt === 'string' && issueCreatedAt) {
    candidates.push(issueCreatedAt);
  }
  if (Array.isArray(timelineEvents)) {
    for (const raw of timelineEvents) {
      const event = raw ?? {};
      if (String(event.event ?? '') !== 'edited') {
        continue;
      }
      if (!event.changes?.title && !event.changes?.body) {
        continue;
      }
      if (typeof event.created_at === 'string' && event.created_at) {
        candidates.push(event.created_at);
      }
    }
  }
  let latest = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const timestamp = Date.parse(candidate);
    if (!Number.isFinite(timestamp) || timestamp < latestTimestamp) {
      continue;
    }
    latestTimestamp = timestamp;
    latest = candidate;
  }
  return latest;
}
/**
 * Whether a trusted rejection record's marker outcome (#2243) is still
 * current enough to exclude a candidate from Discover's selection pass:
 * `true` only when the marker resolved to one of
 * {@link SUITABILITY_TRIAGE_VERDICT_OUTCOMES} AND the rejection comment's
 * own `createdAt` is at or after `latestSubstantiveEditAt` -- an issue
 * legitimately improved after being rejected must not stay excluded by a
 * now-stale marker. `latestSubstantiveEditAt: null` (unknown anchor) fails
 * closed toward NOT excluding the candidate, matching this module's
 * existing fail-safe direction: a wrongly-kept candidate still reaches
 * A4.5, which re-derives its own verdict; a wrongly-skipped one is
 * silently lost.
 */
export function isSuitabilityTriageVerdictCurrent(
  record,
  latestSubstantiveEditAt,
) {
  if (!record.markerOutcome || !latestSubstantiveEditAt) {
    return false;
  }
  const rejectionTimestamp = Date.parse(record.createdAt);
  const editTimestamp = Date.parse(latestSubstantiveEditAt);
  if (!Number.isFinite(rejectionTimestamp) || !Number.isFinite(editTimestamp)) {
    return false;
  }
  return rejectionTimestamp >= editTimestamp;
}
/**
 * Scan `comments` for the most recent trusted-actor `A4.5 suitability gate
 * rejection` comment (#1887): the acceptance-criteria-required detect-only
 * evidence that a prior trusted run already recorded a specific outcome for
 * this exact issue. A comment only qualifies when BOTH hold: its body,
 * after trimming leading whitespace, starts with the literal
 * {@link SUITABILITY_REJECTION_PREFIX} (the same "literal first bytes, not
 * merely quoted or embedded mid-prose" anti-spoofing boundary
 * `idd-claim.instructions.md` already applies to claim markers -- an
 * untrusted actor pasting the phrase mid-sentence never qualifies either
 * way, but this keeps the boundary consistent with the rest of the
 * protocol); AND its author (case-insensitively) is one of
 * `trustedMarkerLogins`. `trustedMarkerLogins` is expected pre-normalized
 * (lowercased) by the caller via `resolveTrustedMarkerActors` in
 * `protocol-helpers.mts` -- this function still lowercases defensively but
 * does not import that module itself, keeping this file's own
 * dependency-light, I/O-free kernel contract intact for a future
 * non-suitability-triage consumer.
 *
 * Returns `null` -- never a synthesized verdict -- when no trusted match
 * exists, whether because there is no such comment at all or because every
 * rejection-shaped comment found was posted by an untrusted actor: both
 * degrade to "nothing on record" the same way, matching this issue's
 * fail-safe contract (an untrusted rejection-shaped comment is never
 * treated as authoritative).
 */
export function findTrustedSuitabilityRejection(
  comments,
  trustedMarkerLogins,
  markerPrefix = DEFAULT_MARKER_PREFIX,
) {
  const trusted = new Set(
    (trustedMarkerLogins ?? [])
      .map((login) =>
        String(login ?? '')
          .trim()
          .toLowerCase(),
      )
      .filter(Boolean),
  );
  if (trusted.size === 0 || !Array.isArray(comments)) {
    return null;
  }
  let latest = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const raw of comments) {
    const comment = raw ?? {};
    const body = typeof comment.body === 'string' ? comment.body : '';
    if (!body.trimStart().startsWith(SUITABILITY_REJECTION_PREFIX)) {
      continue;
    }
    const author = String(comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!author || !trusted.has(author)) {
      continue;
    }
    const createdAt =
      typeof comment.created_at === 'string' ? comment.created_at : '';
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp) || timestamp <= latestTimestamp) {
      continue;
    }
    latestTimestamp = timestamp;
    const outcomeMatch = SUITABILITY_REJECTION_OUTCOME_PATTERN.exec(body);
    const checkMatch = SUITABILITY_REJECTION_CHECK_PATTERN.exec(body);
    const markerDetection = parseSuitabilityTriageVerdictMarker(
      body,
      markerPrefix,
    );
    latest = {
      author,
      createdAt,
      url: typeof comment.html_url === 'string' ? comment.html_url : '',
      // Copilot review finding on PR #1890 (suppressed comment): the
      // pattern above is case-insensitive (`/i`), but a captured group
      // returns the verbatim matched text -- an actor writing e.g.
      // "outcome: DUPLICATE" would otherwise surface a non-canonical
      // "DUPLICATE" instead of the documented lowercase token, making a
      // downstream string comparison brittle. Normalize before returning.
      outcome: outcomeMatch ? (outcomeMatch[1]?.toLowerCase() ?? null) : null,
      check: checkMatch ? checkMatch[0] : null,
      markerOutcome: markerDetection.malformed ? null : markerDetection.outcome,
    };
  }
  return latest;
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
export function evaluateHighConfidenceDuplicate(input, candidateIssueNumber) {
  if (!input) {
    return null;
  }
  // #2313, Signal 3: an exact-match branch-name lookup, checked first since
  // it needs no candidate-file set and is unconditionally sufficient on its
  // own -- a merged PR on this issue's own convention-computed branch name
  // can only exist because it shipped this issue's work, closing keyword or
  // Candidate-files overlap notwithstanding.
  const branchNameMergedPr = input.branchNameMergedPr;
  if (
    branchNameMergedPr &&
    typeof branchNameMergedPr === 'object' &&
    Number.isInteger(branchNameMergedPr.number) &&
    branchNameMergedPr.number > 0 &&
    // CodeRabbit review finding on this PR: an empty `mergedAt` must not
    // produce Signal 3 evidence -- every other merged-PR evidence shape in
    // this module requires a merge timestamp (see `HighConfidenceMergedPr`
    // above), and citing a merge with no date is a malformed/incomplete
    // input, not a genuine hit. Falls through to the other signals instead
    // of crashing or manufacturing a false positive.
    typeof branchNameMergedPr.mergedAt === 'string' &&
    branchNameMergedPr.mergedAt.length > 0
  ) {
    return {
      pass: false,
      evidence: `High-confidence duplicate: merged PR #${branchNameMergedPr.number} (merged ${branchNameMergedPr.mergedAt}) already shipped this issue's own IDD-naming-convention-computed branch, independent of closing-keyword presence or Candidate-files overlap.`,
      tier: 'high-confidence',
    };
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
  const mergedPrs = Array.isArray(input.mergedPrs) ? input.mergedPrs : [];
  for (const raw of mergedPrs) {
    const pr = raw ?? {};
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
/**
 * Argv for the exact-match merged-PR-by-branch-name lookup (#2313): finds
 * any merged PR whose `headRefName` equals this issue's own
 * IDD-naming-convention-computed branch name (`computeBranchName` in
 * `branch-name.mts`). `--head` filters server-side to PRs with that exact
 * head branch, so this is a single targeted lookup -- unlike
 * {@link buildMergedPrListArgs}'s bounded recent-window scan above, no
 * client-side iteration over unrelated merged PRs is needed.
 *
 * Requests `headRepositoryOwner` alongside the other fields (Copilot review
 * finding on this PR) and raises `--limit` above 1: `gh pr list --head
 * <branch>` (per `gh pr list --help`, the `"<owner>:<branch>" syntax` is
 * "not supported") matches on head branch NAME alone, which can also return
 * a merged PR from a FORK that happens to use the same branch name -- a
 * `headRepositoryOwner` mismatch would otherwise misclassify an issue as a
 * high-confidence duplicate even though the in-repo convention branch was
 * never actually merged. The caller filters to entries whose
 * `headRepositoryOwner.login` matches the repository owner before treating
 * any result as a hit.
 */
export function buildMergedPrByBranchArgs(repoRef, branchName) {
  return [
    'pr',
    'list',
    '--repo',
    repoRef,
    '--head',
    branchName,
    '--state',
    'merged',
    '--json',
    'number,headRefName,mergedAt,headRepositoryOwner',
    '--limit',
    '10',
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
export function buildPrDetailArgs(repoRef, prNumber) {
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
