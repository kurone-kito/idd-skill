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

import {
  type CopilotReviewBodyShape,
  classifyCopilotReviewBody,
} from './copilot-review-body.mts';
import {
  isCopilotErrorReviewBody,
  isCopilotReviewerLogin,
} from './protocol-helpers.mts';
import { createGithubProviderAdapter } from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';

// Re-exported (#3258) so an existing importer of the review-body shape
// classifier from THIS file (its original documented home per the issue's
// Proposed change) gets the same symbols `copilot-review-body.mts` exports
// directly.
export {
  type CopilotReviewBodyClassification,
  type CopilotReviewBodyShape,
  classifyCopilotReviewBody,
} from './copilot-review-body.mts';

/** Minimal GitHub GraphQL author payload shape consumed here. `__typename`
 * distinguishes a genuine `Bot` account from a same-named `User` masquerade
 * when the caller has that discriminator available; a payload that omits
 * it is treated as "unknown", never as a rejection. */
export interface GhAuthorPayload {
  login?: string | null;
  __typename?: string | null;
}

/** PR review payload, normalized from the GraphQL `reviews` connection. */
export interface ReviewPayload {
  /** #2050 / #2056: the review's own GraphQL node id -- lets a caller bind
   * evidence (e.g. a review thread's `pullRequestReview.id`) to THIS
   * specific review, as opposed to any Copilot-authored thread anywhere
   * in the PR's history. Optional at this type's boundary (`''`/absent
   * for a fixture that omits it is not itself a rejection here), but
   * `classifyThreadIdsForReview` returns an empty set when the id is
   * empty, so a positive-`itemCount` review with an omitted id can never
   * satisfy Clause 1 via thread-disposition evidence. */
  id?: string | null;
  author?: GhAuthorPayload | null;
  submittedAt?: string | null;
  commitId?: string | null;
  itemCount?: number | null;
  /** #1880: the review's top-level body text. GitHub Copilot can fold a
   * finding into a `<details><summary>Suppressed comments (N)</summary>`
   * block here instead of posting it as a separate review comment, in
   * which case `itemCount` (from `comments.totalCount`) stays `0` even
   * though a real finding exists -- see {@link parseSuppressedCommentCount}.
   * Also consumed (#3015) to detect Copilot's "encountered an error"
   * review, the sibling `itemCount === 0` false-empty shape where Copilot
   * never reviewed the diff at all -- see
   * `isCopilotErrorReviewBody` (copilot-review-body.mts, re-exported from
   * protocol-helpers.mts, #3258). */
  body?: string | null;
  /** #3262: `true` when every one of this review's comments is a reply to
   * an existing thread (a bot replying inside a thread instead of posting
   * a fresh review), as derived by the GitHub adapter from the GraphQL
   * `comments { nodes { replyTo { id } } }` selection. A review with no
   * comments, or with a truncated comments connection, is never
   * reply-only. Absent/`null`/`undefined` means "not reply-only" (a fake
   * or older fixture that doesn't set this field behaves as before). */
  replyOnly?: boolean | null;
}

/** Latest-review clause evidence (Clause 1 of `advisory-convergence.mts`'s
 * `converged` definition). */
export interface AdvisoryConvergenceReviewClause {
  found: boolean;
  /** #2050: the matched review's own GraphQL node id (`''` when `!found` or
   * off-HEAD) -- lets `advisory-convergence.mts` scope thread evidence to
   * THIS specific review via each thread's originating comment's
   * `pullRequestReview.id`, rather than any Copilot-authored thread
   * anywhere in the PR's history (`classifyCopilotAuthoredThreadIds`'s
   * broader, review-agnostic Clause 2 set). */
  reviewId: string;
  commitId: string;
  matchesHead: boolean;
  itemCount: number | null;
  submittedAt: string;
  /** #1880: count of thread-less findings parsed from the latest review
   * body, `0` when no recognized section is present (or the review is
   * off-HEAD). The three recognized sources are the current
   * `ccr-overview-v2` shape's `Previously missed (N)` section, the legacy
   * overview's `### Suppressed comments (N)` heading, and the original
   * August `<summary>Suppressed comments (N)</summary>` form. See
   * {@link parseSuppressedCommentCount}. */
  suppressedCount: number;
  /** kurone-kito/idd-skill#3258: the recognized review-body shape
   * {@link parseSuppressedCommentCount} used to compute `suppressedCount`
   * above, read only when `matchesHead` is true; `null` when `!found` or
   * off-HEAD (mirrors `itemCount`'s own "only meaningful on-HEAD" gating
   * convention). `'error'` never appears here -- an error-bodied review is
   * already excluded before "latest" selection, see
   * {@link resolveLatestCopilotReviewClause}'s own doc comment. */
  bodyShape: CopilotReviewBodyShape | null;
  satisfied: boolean;
}

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
export function parseSuppressedCommentCount(
  body: string | null | undefined,
): number {
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
export function isVerifiedCopilotAuthor(
  author: GhAuthorPayload | null | undefined,
  primaryBotLogin: string,
): boolean {
  const typename = author?.__typename;
  if (!isCopilotReviewerLogin(author?.login ?? '', primaryBotLogin, typename)) {
    return false;
  }
  return typename === undefined || typename === null || typename === 'Bot';
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
  reviews: ReviewPayload[],
  prHeadSha: string,
  primaryBotLogin: string,
): AdvisoryConvergenceReviewClause {
  const latest = reviews
    .filter(
      (review) =>
        isVerifiedCopilotAuthor(review.author, primaryBotLogin) &&
        !isCopilotErrorReviewBody(review.body) &&
        review.replyOnly !== true,
    )
    .at(-1);
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
  owner: string,
  repo: string,
  prNumber: number,
  port: ProviderPort = createGithubProviderAdapter(owner, repo),
): { reviews: ReviewPayload[]; headCommittedAt: string } {
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
  owner: string,
  repo: string,
  prNumber: number,
  port: ProviderPort = createGithubProviderAdapter(owner, repo),
): string {
  return port.getChangeRequestHeadObservedAt(prNumber);
}
