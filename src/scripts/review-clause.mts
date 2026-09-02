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
// `isCopilotReviewerLogin`, and -- as of #1880 -- `markdown-code.mts`'s
// shared `stripMarkdownCodeRegions`) so a read-only, low-dependency caller
// like `rerun-advisory-convergence.mts` can import it without also pulling
// in `advisory-convergence.mts`'s full claim/waiver/disposition machinery
// -- see that file's own module-header "Reuse map" comment. `markdown-
// code.mts` has no imports of its own, so this adds no heavy dependency
// surface to that caller either.

import { stripMarkdownCodeRegions } from './markdown-code.mts';
import { isCopilotReviewerLogin } from './protocol-helpers.mts';
import { createGithubProviderAdapter } from './provider-adapter-github.mts';
import type { ProviderPort } from './provider-port.mts';

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
   * though a real finding exists -- see {@link parseSuppressedCommentCount}. */
  body?: string | null;
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
  /** #1880: count parsed from a `Suppressed comments (N)` heading in the
   * review body, `0` when no such section is present (or the review is
   * off-HEAD). See {@link parseSuppressedCommentCount}. */
  suppressedCount: number;
  satisfied: boolean;
}

/** Matches GitHub Copilot's `<summary>Suppressed comments (N)</summary>`
 * heading, case-insensitively -- the only structured signal a suppressed
 * finding leaves in the review body (#1880). Anchored to the surrounding
 * `<summary>`/`</summary>` tags, not a bare `Suppressed comments (N)`
 * substring search: this file's own diff (this pattern, its doc comments,
 * and the regression test fixture) now contains that literal phrase, and
 * an advisory bot reviewing THIS pull request could quote it back in
 * ordinary prose (e.g. discussing the test fixture) without wrapping it in
 * the real HTML tags -- the same prose-quoted-example false-positive class
 * a marker parser elsewhere in this codebase already hit once
 * (kurone-kito/idd-skill#1614). Requiring the literal tag pair keeps a
 * plain-text mention from matching -- but is not sufficient alone: see
 * {@link parseSuppressedCommentCount}'s own code-region stripping for the
 * remaining case (the literal tags quoted INSIDE a code span/fence). */
const SUPPRESSED_COMMENTS_HEADING_PATTERN =
  /<summary>\s*suppressed comments \((\d+)\)\s*<\/summary>/i;

/**
 * Parse the `Suppressed comments (N)` count GitHub Copilot embeds in a
 * review's top-level body when it folds a low-confidence finding into a
 * collapsed `<details>` block instead of posting it as a separate review
 * comment (kurone-kito/idd-skill#1880). Returns `0` when the body carries
 * no such section, including an absent/empty/unparseable body -- unlike
 * `itemCount`, there is no distinct "unknown" state to preserve here: a
 * missing section unambiguously means zero suppressed comments.
 *
 * Strips fenced/inline Markdown code regions (`stripMarkdownCodeRegions`,
 * markdown-code.mts) before matching, so a review body that quotes the
 * literal `<summary>Suppressed comments (N)</summary>` tag pair inside
 * backticks or a fenced code block (e.g. an advisory bot discussing this
 * exact detection logic, as happened on this PR's own #1884 Copilot
 * review) is not mistaken for a real suppressed-comments section -- the
 * `<summary>`/`</summary>` anchoring above narrows the prose-quoting risk
 * but does not by itself exclude a code-quoted example; stripping the code
 * regions first closes that gap the same way #1614's marker-parser fix did.
 * Real GitHub-rendered `<details>`/`<summary>` markup is raw HTML, never
 * inside a code span/fence, so this never blanks the genuine heading.
 */
export function parseSuppressedCommentCount(
  body: string | null | undefined,
): number {
  if (typeof body !== 'string' || body.length === 0) return 0;
  const match = stripMarkdownCodeRegions(body).match(
    SUPPRESSED_COMMENTS_HEADING_PATTERN,
  );
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isFinite(count) ? count : 0;
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
  if (!isCopilotReviewerLogin(author?.login ?? '', primaryBotLogin)) {
    return false;
  }
  const typename = author?.__typename;
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
 * ordered review win by comparator accident. */
export function resolveLatestCopilotReviewClause(
  reviews: ReviewPayload[],
  prHeadSha: string,
  primaryBotLogin: string,
): AdvisoryConvergenceReviewClause {
  const latest = reviews
    .filter((review) => isVerifiedCopilotAuthor(review.author, primaryBotLogin))
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
  // #1880: gated by `matchesHead`, mirroring `itemCount` above -- moot for
  // `satisfied` itself (already gated by `matchesHead &&`), but keeps an
  // off-HEAD review's report fields consistent with each other rather than
  // parsing a body this clause is about to ignore anyway.
  const suppressedCount = matchesHead
    ? parseSuppressedCommentCount(latest.body)
    : 0;
  return {
    found: true,
    // #2050: also gated by `matchesHead` -- an off-HEAD review's own id is
    // never meaningful evidence for the caller's thread-scoping, mirroring
    // `itemCount`/`suppressedCount` above.
    reviewId: matchesHead ? String(latest.id ?? '') : '',
    commitId,
    matchesHead,
    itemCount,
    submittedAt: String(latest.submittedAt ?? ''),
    suppressedCount,
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
  }));
  return { reviews, headCommittedAt };
}
