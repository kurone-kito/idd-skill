// idd-generated-from: src/scripts/review-clause.mts
//
// The scripts/review-clause.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared "does the latest trusted primary-bot review cover the PR's
// current HEAD" evidence (Clause 1 of `advisory-convergence.mts`'s
// `converged` definition), extracted (#1806) so a second, independent
// caller (`rerun-advisory-convergence.mts`) can reuse the SAME review
// fetch and matching logic the real `idd-advisory-convergence` gate
// already uses, instead of a second ad-hoc GraphQL path that could drift
// out of sync with it. `advisory-convergence.mts` itself now imports these
// from here too -- this file has no behavior of its own beyond what both
// callers already relied on before the extraction.
//
// Kept deliberately small (only depends on `provider-adapter-github.mts`'s
// shared GitHub port adapter -- #2267, replacing the direct `ghGraphql`
// call this file used before -- `protocol-helpers.mts`'s shared
// `isCopilotReviewerLogin` (and, as of #3015, its sibling
// `isCopilotErrorReviewBody`, now re-exported there from
// `copilot-review-body.mts`), and -- as of #1880, now via
// `copilot-review-body.mts`'s shared classifier (#3258) -- Markdown
// code-region stripping) so a read-only, low-dependency caller like
// `rerun-advisory-convergence.mts` can import it without also pulling in
// `advisory-convergence.mts`'s full claim/waiver/disposition machinery --
// see that file's own module-header "Reuse map" comment.
// `copilot-review-body.mts` itself only imports `markdown-code.mts` (which
// has no imports of its own), so this adds no heavy dependency surface to
// that caller either.
import { DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN } from './advisory-wait-policy.mjs';
import {
  citationBreakdown,
  classifyCopilotReviewBody,
} from './copilot-review-body.mjs';
import { isValidIsoTimestamp } from './marker-helpers.mjs';
import {
  classifyCommentEditState,
  compareIsoTimestamps,
  hasTrustedReviewAckAfter,
  isCopilotErrorReviewBody,
  isCopilotReviewerLogin,
  normalizeTrustedMarkerLogins,
} from './protocol-helpers.mjs';
import { createGithubProviderAdapter } from './provider-adapter-github.mjs';

// Re-exported (#3258) so an existing importer of the review-body shape
// classifier from THIS file (its original documented home per the issue's
// Proposed change) gets the same symbols `copilot-review-body.mts` exports
// directly.
export { classifyCopilotReviewBody } from './copilot-review-body.mjs';
/**
 * Parse the thread-less ("suppressed") finding count GitHub Copilot embeds
 * in a review's top-level body instead of posting it as a separate review
 * comment (kurone-kito/idd-skill#1880). Returns `0` when the body carries
 * no recognized such section, including an absent/empty/unparseable body,
 * or a recognized-but-unrelated body shape -- unlike `itemCount`, there is
 * no distinct "unknown" state to preserve here: no recognized section
 * unambiguously means zero (thread-less) suppressed comments this function
 * can attribute to a specific count.
 *
 * Delegates to {@link classifyCopilotReviewBody} (copilot-review-body.mts,
 * #3258), which recognizes both the current `ccr-overview-v2` shape's
 * `Previously missed (N)` section and the legacy overview's `Suppressed
 * comments (N)` heading (plus the original, even-older bare August
 * `<summary>Suppressed comments (N)</summary>` form the original #1880 fix
 * matched) -- see that module for the full shape-detection rationale,
 * including the code-region-stripping step that keeps a review body
 * merely QUOTING one of these patterns (e.g. an advisory bot discussing
 * this exact detection logic, as happened on this PR's own #1884 Copilot
 * review) from being mistaken for a real section.
 */
// audit:ignore-dead-export: no caller found anywhere by #3478's first repo-wide run, not even a test; left for follow-up triage rather than an unreviewed removal in this PR
export function parseSuppressedCommentCount(body) {
  return classifyCopilotReviewBody(body).suppressedCount;
}
/**
 * `true` when `author` is a verified Copilot (or the configured primary
 * bot login)-authored review/comment -- reuses `isCopilotReviewerLogin`
 * (protocol-helpers.mts) for the login match itself (the exact,
 * lookalike-resistant comparison #1686 hardened), plus (when the payload
 * carries it) a `__typename === 'Bot'` check so a same-named `User`
 * account cannot masquerade as the trusted bot even if it somehow matched
 * the login. A payload that omits `__typename` is treated as "unknown",
 * never as a rejection, since not every GraphQL query in this codebase
 * selects that field.
 */
export function isVerifiedCopilotAuthor(author, primaryBotLogin) {
  const typename = author?.__typename;
  if (!isCopilotReviewerLogin(author?.login ?? '', primaryBotLogin, typename)) {
    return false;
  }
  return typename === undefined || typename === null || typename === 'Bot';
}
/** Return the absolute-latest eligible primary review's provider-order index.
 * Keep this selector shared with {@link resolveLatestCopilotReviewClause} so
 * callers that need to compare an older finding against the selected review
 * cannot accidentally choose the latest on-head review instead. */
export function findLatestCopilotReviewIndex(reviews, primaryBotLogin) {
  let latestIndex = -1;
  for (let index = 0; index < reviews.length; index += 1) {
    const review = reviews[index];
    if (
      isVerifiedCopilotAuthor(review.author, primaryBotLogin) &&
      !isCopilotErrorReviewBody(review.body) &&
      review.replyOnly !== true
    ) {
      latestIndex = index;
    }
  }
  return latestIndex;
}
/** Evaluate Clause 1 against the single, absolute-latest Copilot review --
 * per the issue's literal wording ("the latest Copilot review's commit_id
 * equals current HEAD"), not "the latest review among those that happen to
 * target current HEAD". Those two differ when Copilot's most recent
 * activity targets a commit other than the current HEAD (e.g. an unusual
 * force-push/revert ordering, see PR #1343 review): only looking within
 * on-HEAD reviews could report `matchesHead: true` off a stale earlier
 * review while ignoring what Copilot's true latest signal actually says.
 * This simpler form still correctly handles a legitimate re-request
 * without a new push (this repo's own AW3 `REQUEST_NEEDED` flow, where a
 * later review supersedes an earlier dirty one on the *same* commit): the
 * absolute latest naturally IS that later, superseding review when both
 * target the current HEAD. "Latest" is fetch order, not `submittedAt`:
 * GitHub's GraphQL `reviews` connection returns reviews in submission
 * order -- this deliberately does NOT sort by `submittedAt`, since that
 * field is nullable and could otherwise let an earlier, differently-
 * ordered review win by comparator accident.
 *
 * #3015: a review whose body is Copilot's exact "encountered an error"
 * template (`isCopilotErrorReviewBody`, copilot-review-body.mts,
 * re-exported from protocol-helpers.mts, #3258) is excluded
 * entirely before taking the absolute-latest -- treated as if it did not
 * exist, not merely as an off-HEAD review -- so it can neither win this
 * "latest" selection itself nor mask an earlier genuine review of the same
 * HEAD underneath it. See that function's doc comment for the observed
 * incident and matching rationale.
 *
 * #3262: a reply-only review (every comment a reply to an existing
 * thread, {@link ReviewPayload.replyOnly}) is excluded the same way --
 * it originates no thread of its own, so it can never satisfy the
 * item-count/thread-count parity `advisory-convergence.mts` checks, and
 * would otherwise mask an earlier genuine full review of the same HEAD. */
export function resolveLatestCopilotReviewClause(
  reviews,
  prHeadSha,
  primaryBotLogin,
) {
  const latestIndex = findLatestCopilotReviewIndex(reviews, primaryBotLogin);
  const latest = latestIndex < 0 ? undefined : reviews[latestIndex];
  if (!latest) {
    return {
      found: false,
      reviewId: '',
      commitId: '',
      matchesHead: false,
      itemCount: null,
      submittedAt: '',
      suppressedCount: 0,
      bodyShape: null,
      satisfied: false,
    };
  }
  const commitId = String(latest.commitId ?? '').toLowerCase();
  const matchesHead = commitId === prHeadSha;
  const itemCount = matchesHead
    ? Number.isFinite(latest.itemCount)
      ? Number(latest.itemCount)
      : null
    : null;
  // #1880 / #3258: gated by `matchesHead`, mirroring `itemCount` above --
  // moot for `satisfied` itself (already gated by `matchesHead &&`), but
  // keeps an off-HEAD review's report fields consistent with each other
  // rather than classifying a body this clause is about to ignore anyway.
  // Classified once so `suppressedCount` and `bodyShape` cannot disagree.
  const bodyClassification = matchesHead
    ? classifyCopilotReviewBody(latest.body)
    : null;
  const suppressedCount = bodyClassification?.suppressedCount ?? 0;
  return {
    found: true,
    // #2050: also gated by `matchesHead` -- an off-HEAD review's own id is
    // never meaningful evidence for the caller's thread-scoping, mirroring
    // `itemCount`/`suppressedCount`/`bodyShape` above.
    reviewId: matchesHead ? String(latest.id ?? '') : '',
    commitId,
    matchesHead,
    itemCount,
    submittedAt: String(latest.submittedAt ?? ''),
    suppressedCount,
    bodyShape: bodyClassification?.shape ?? null,
    satisfied: matchesHead && itemCount === 0 && suppressedCount === 0,
  };
}
/**
 * Fetch every PR review (paginated) plus the current HEAD commit's
 * `committedDate`, via {@link ProviderPort.getChangeRequestReviewsWithHeadCommitDate}
 * (#2267) -- the same GraphQL query `advisory-convergence.mts`'s own
 * Clause 1 evidence collection has always used, now routed through the
 * GitHub provider adapter instead of a direct `ghGraphql` call. Extended
 * additively with an optional trailing `port` (defaults to
 * `createGithubProviderAdapter(owner, repo)`): every existing caller
 * (this file's own out-of-scope `rerun-advisory-convergence.mts`,
 * `pre-merge-readiness.mts`, `advisory-convergence.mts`) still calls this
 * with the unchanged 3-arg `(owner, repo, prNumber)` shape, so the
 * injection is invisible to them -- it exists so a caller that already
 * holds its own fake-backed `ProviderPort` (e.g. a test driving
 * `pre-merge-readiness.mts`'s `collectPreMergeReadiness` end to end) can
 * pass it through instead of this function constructing its own live
 * adapter.
 */
export function fetchReviewsAndHeadCommit(
  owner,
  repo,
  prNumber,
  port = createGithubProviderAdapter(owner, repo),
) {
  const { reviews: nodes, headCommittedAt } =
    port.getChangeRequestReviewsWithHeadCommitDate(prNumber);
  const reviews = nodes.map((node) => ({
    id: node.id || null,
    author: { login: node.authorLogin, __typename: node.authorTypename },
    submittedAt: node.submittedAt,
    commitId: node.commitId,
    itemCount: node.commentCount,
    body: node.body,
    replyOnly: node.replyOnly,
  }));
  return { reviews, headCommittedAt };
}
/**
 * Fetch `headObservedAt` -- the earliest GitHub-recorded check-suite
 * `createdAt` for the PR's current HEAD commit -- via
 * {@link ProviderPort.getChangeRequestHeadObservedAt} (kurone-kito/idd-skill#3253).
 * A sibling of {@link fetchReviewsAndHeadCommit}, not an extension of it:
 * the two are independent GraphQL reads, fetched and consumed separately by
 * every caller. Same injectable-port shape as its sibling, so a caller
 * already holding its own fake-backed `ProviderPort` can pass it through
 * instead of this function constructing its own live adapter.
 */
export function fetchHeadObservedAt(
  owner,
  repo,
  prNumber,
  port = createGithubProviderAdapter(owner, repo),
) {
  return port.getChangeRequestHeadObservedAt(prNumber);
}
/**
 * Clause 1's ack rule for the review that matches HEAD (kurone-kito/idd-skill#3907):
 * `suppressedCount > 0`, or an `unrecognized` body with the default Copilot
 * bot. It mirrors `advisory-convergence.mts`'s Clause 1 ack term and covers
 * that rule only; it does not say whether Clause 1 applies at all
 * (`reviewPolicy`, `convergenceScope`, waivers). The same rule still lives in
 * `advisory-convergence.mts` (two sites) and `merged-pr-feedback-sweep.mts`;
 * moving those onto this function is a follow-up. A pin test keeps the Clause 1
 * copy from drifting in the meantime.
 */
export function copilotReviewAckNeeded(input) {
  return (
    input.suppressedCount > 0 ||
    (input.bodyShape === 'unrecognized' &&
      input.primaryBotLogin.trim().toLowerCase() ===
        DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN)
  );
}
/**
 * Select the primary bot's review with the gate's own selector
 * ({@link resolveLatestCopilotReviewClause}) and report its ack state
 * (kurone-kito/idd-skill#3907). Returns `null` when there is no counted review
 * or the HEAD is not 40 hexadecimal characters after lowercasing.
 * `comments` must be normalized (`author.login`, `lastEditedAt`), and `trustedMarkerLogins` the
 * resolved set, not a viewer-augmented one.
 */
/** #3942: the recorded-deferral reply, `**Rejected** — deferred to follow-up
 * issue #<n> ({clause}): {reason}`, as the triage E6 text defines it. */
const RECORDED_DEFERRAL_REPLY_PATTERN =
  /^\*\*Rejected\*\* — deferred to follow-up issue #\d+ \([^()]*\): \S/u;
/** #3942: the review-reply identity stamp, `<!-- {prefix}-review-reply -->`. */
const REVIEW_REPLY_STAMP_PATTERN = /<!--\s*[\w-]+-review-reply\s*-->/iu;
/**
 * #3942: counts the trusted, unedited disposition replies that settle a
 * Previously missed item naming a file or line. A reply counts when it opens
 * with `**Accepted**` or the recorded-deferral form, carries the review-reply
 * stamp, and was posted strictly after the latest primary-bot review was
 * submitted. A bare `review-ack` never counts for these items.
 */
export function countCitedItemDispositions(
  comments,
  trustedMarkerLogins,
  reviewSubmittedAt,
) {
  if (!isValidIsoTimestamp(reviewSubmittedAt)) {
    return 0;
  }
  const trusted = new Set(
    trustedMarkerLogins.map((login) => login.trim().toLowerCase()),
  );
  return comments.filter((comment) => {
    const body = String(comment.body ?? '').trimEnd();
    const login = String(comment.author?.login ?? comment.user?.login ?? '')
      .trim()
      .toLowerCase();
    const createdAt = String(comment.createdAt ?? comment.created_at ?? '');
    // Strictly after the review, the same ordering hasTrustedReviewAckAfter uses:
    // a reply in the review's own second is not provably later.
    if (
      !trusted.has(login) ||
      !isValidIsoTimestamp(createdAt) ||
      compareIsoTimestamps(createdAt, reviewSubmittedAt) <= 0
    ) {
      return false;
    }
    if (classifyCommentEditState(comment) !== 'unedited') {
      return false;
    }
    return (
      (/^\*\*Accepted\*\*/u.test(body) ||
        RECORDED_DEFERRAL_REPLY_PATTERN.test(body)) &&
      REVIEW_REPLY_STAMP_PATTERN.test(body)
    );
  }).length;
}
export function resolveLatestPrimaryBotReviewEvidence(input) {
  const headSha = input.prHeadSha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    return null;
  }
  // Normalize the login as the gate does (advisory-convergence.mts), so the
  // selector and the reported login agree with the gate's view.
  const primaryBotLogin =
    input.primaryBotLogin.trim().toLowerCase() ||
    DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const clause = resolveLatestCopilotReviewClause(
    input.reviews,
    headSha,
    primaryBotLogin,
  );
  if (!clause.found) {
    return null;
  }
  const reviewAckNeeded =
    clause.matchesHead &&
    copilotReviewAckNeeded({
      suppressedCount: clause.suppressedCount,
      bodyShape: clause.bodyShape,
      primaryBotLogin,
    });
  // #3942: a citation-free suppressed item is covered by a trusted review-ack,
  // and each cited one needs its own disposition. The gate applies the same
  // rule, so a cited-only review converges on dispositions alone.
  const latestIndex = findLatestCopilotReviewIndex(
    input.reviews,
    primaryBotLogin,
  );
  const citation = citationBreakdown(
    latestIndex < 0 ? null : input.reviews[latestIndex]?.body,
    clause.suppressedCount,
  );
  const ackCovers = hasTrustedReviewAckAfter(
    input.comments,
    normalizeTrustedMarkerLogins([...input.trustedMarkerLogins]),
    clause.submittedAt,
    headSha,
  );
  const citedDispositionsCover =
    citation.citedCount === 0 ||
    countCitedItemDispositions(
      input.comments,
      [...input.trustedMarkerLogins],
      clause.submittedAt,
    ) >= citation.citedCount;
  const reviewAckCovers = clause.matchesHead
    ? clause.suppressedCount === 0
      ? ackCovers
      : (citation.citationFreeCount === 0 || ackCovers) &&
        citedDispositionsCover
    : null;
  return {
    primaryBotLogin,
    reviewId: clause.reviewId,
    commitId: clause.commitId,
    matchesHead: clause.matchesHead,
    bodyShape: clause.bodyShape,
    suppressedCount: clause.suppressedCount,
    reviewAckNeeded,
    reviewAckCovers,
  };
}
