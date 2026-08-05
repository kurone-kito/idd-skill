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
// Kept deliberately small (only depends on `gh-exec.mts`'s shared
// `ghGraphql` and `protocol-helpers.mts`'s shared `isCopilotReviewerLogin`)
// so a read-only, low-dependency caller like `rerun-advisory-convergence.mts`
// can import it without also pulling in `advisory-convergence.mts`'s full
// claim/waiver/disposition machinery -- see that file's own module-header
// "Reuse map" comment. Both dependencies are already reused directly by
// `rerun-advisory-convergence.mts` itself today, so this adds no new
// dependency surface to that caller.

import { ghGraphql } from './gh-exec.mts';
import { isCopilotReviewerLogin } from './protocol-helpers.mts';

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
  author?: GhAuthorPayload | null;
  submittedAt?: string | null;
  commitId?: string | null;
  itemCount?: number | null;
}

/** Latest-review clause evidence (Clause 1 of `advisory-convergence.mts`'s
 * `converged` definition). */
export interface AdvisoryConvergenceReviewClause {
  found: boolean;
  commitId: string;
  matchesHead: boolean;
  itemCount: number | null;
  submittedAt: string;
  satisfied: boolean;
}

/** GraphQL pagination cursor block, local to this file's own `reviews`
 * pagination -- a separate, unexported copy of the same tiny shape other
 * `advisory-convergence.mts` pagination loops (that stayed in that file)
 * also use, rather than a cross-module import for a 2-field type. */
interface PageInfoPayload {
  hasNextPage?: boolean | null;
  endCursor?: string | null;
}

/** Raw GraphQL `reviews` connection node, before normalization into
 * {@link ReviewPayload}. */
interface RawReviewNode {
  commit?: { oid?: string | null } | null;
  submittedAt?: string | null;
  author?: GhAuthorPayload | null;
  comments?: { totalCount?: number | null } | null;
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
      commitId: '',
      matchesHead: false,
      itemCount: null,
      submittedAt: '',
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
  return {
    found: true,
    commitId,
    matchesHead,
    itemCount,
    submittedAt: String(latest.submittedAt ?? ''),
    satisfied: matchesHead && itemCount === 0,
  };
}

/**
 * Fetch every PR review (paginated) plus the current HEAD commit's
 * `committedDate`, via the same GraphQL query `advisory-convergence.mts`'s
 * own Clause 1 evidence collection has always used.
 */
export function fetchReviewsAndHeadCommit(
  owner: string,
  repo: string,
  prNumber: number,
): { reviews: ReviewPayload[]; headCommittedAt: string } {
  const nodes: RawReviewNode[] = [];
  let headCommittedAt = '';
  let cursor: string | null | undefined = null;

  // Paginate `reviews`: a PR with more than one page of reviews would
  // otherwise silently evaluate Clause 1 against only the first 100,
  // potentially missing a later, dirty, current-HEAD review (see PR #1343
  // review). `commits(last: 1)` is fetched once, on the first page, since
  // it never changes across pages.
  while (true) {
    const payload = ghGraphql(
      `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  commit { oid }
                  submittedAt
                  author { login __typename }
                  comments { totalCount }
                }
              }
              commits(last: 1) {
                nodes { commit { committedDate } }
              }
            }
          }
        }`,
      { owner, repo, number: prNumber, cursor },
    ) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviews?: {
              pageInfo?: PageInfoPayload | null;
              nodes?: RawReviewNode[] | null;
            } | null;
            commits?: {
              nodes?: { commit?: { committedDate?: string | null } | null }[];
            } | null;
          } | null;
        } | null;
      } | null;
    };

    const pullRequest = payload?.data?.repository?.pullRequest;
    nodes.push(...(pullRequest?.reviews?.nodes ?? []));
    if (!headCommittedAt) {
      headCommittedAt = String(
        pullRequest?.commits?.nodes?.[0]?.commit?.committedDate ?? '',
      );
    }

    if (!pullRequest?.reviews?.pageInfo?.hasNextPage) break;
    if (!pullRequest.reviews.pageInfo.endCursor) {
      throw new Error('review pagination payload is missing endCursor');
    }
    cursor = pullRequest.reviews.pageInfo.endCursor;
  }

  const reviews = nodes.map((node) => ({
    author: node.author ?? null,
    submittedAt: node.submittedAt ?? null,
    commitId: node.commit?.oid ?? null,
    itemCount: node.comments?.totalCount ?? null,
  }));
  return { reviews, headCommittedAt };
}
