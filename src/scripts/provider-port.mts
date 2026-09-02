// idd-generated-from: src/scripts/provider-port.mts
//
// The scripts/provider-port.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Provider port (#2266): the actual operation surface a domain helper
// (discovery, claim, resume, roadmap-audit, permission flows) calls instead
// of invoking `gh` or a GitHub endpoint directly. Builds on the vocabulary
// `provider-contract.mts` (#2265) already names (capability groups, error
// categories) without changing that module. This file is pure types --
// the `ProviderPort` interface and its method-shape types -- no
// `gh`/network/subprocess code lives here. The GitHub implementation is
// `provider-adapter-github.mts`; the in-memory test implementation is
// `provider-adapter-fake.mts`.
//
// A method exists per today's DISTINCT existing call shape, not per
// "logical operation" -- two existing call sites that answer a similar
// question with different queries, pagination, or failure semantics get
// two separate methods, never one shared method with a flag. Unifying
// call shapes is a follow-up concern; this migration only moves transport.
//
// Sync by design, no blanket Promise-ification: every existing `gh`
// invocation this port replaces is `execFileSync`-backed and synchronous,
// and several consumers call into sync-only call chains a Promise-returning
// method cannot satisfy -- e.g. `collaborator-permission.mts`'s
// `resolveTrustedCollaboratorMarkerLogins` calls the permission lookup
// inside a synchronous `Array.filter()` callback, which structurally
// cannot `await`. An async variant is added additively, not retrofitted
// onto the sync methods, where a real consumer genuinely needs one --
// `discover-roadmap-graph.mts`'s bounded-concurrency traversal (step 12,
// `mapPool`-driven) does: its issue/sub-issue loaders run several `gh`
// subprocesses in flight at once via the non-blocking `ghTextAsync`, which
// the synchronous `execFileSync`-backed methods above cannot express
// (they would serialize the fan-out). The `*Async` methods below are that
// addition -- traversal-only, not a general async surface.

import type {
  ProviderCapabilityDeclaration,
  ProviderError,
  ProviderRepositoryLocator,
} from './provider-contract.mts';

/**
 * Provider-neutral work item (GitHub issue) shape, full object. `labels`,
 * `url`, `htmlUrl`, `milestone`, `user`, `authorAssociation`, `createdAt`,
 * and `updatedAt` are raw/untransformed passthroughs of the underlying REST
 * fields (a domain helper does its own shape normalization, e.g.
 * `discover-orphan-filter.mts`'s `normalizeLabels` or
 * `claim-approval-gate.mts`'s `normalizeIssue`) -- `user` stays the raw
 * `{login}`-shaped object rather than a flattened login string, so a
 * consumer that needs the pre-migration snake_case shape (e.g. to feed an
 * existing `user.login` reader unchanged) can remap it back verbatim. All
 * optional because {@link ProviderPort.getWorkItem}'s original single-issue
 * consumer (`discover-viability-gate.mts`) never reads them.
 */
export interface ProviderWorkItem {
  number: number;
  title: string;
  body: string;
  state: string;
  labels?: unknown;
  url?: string;
  htmlUrl?: string;
  milestone?: unknown;
  user?: unknown;
  authorAssociation?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** One issue-comments-API comment (issue or PR -- same endpoint on GitHub).
 * `updatedAt` (#2267) is additive: REST returns it on every response
 * regardless of field selection, so surfacing it widens this existing
 * shared shape rather than adding a competing method -- every #2266
 * consumer that ignores it is unaffected. `review-activity-snapshot.mts`
 * and `pre-merge-readiness.mts`'s disposition-evidence comment
 * normalization need it for their most-recent-activity computation. */
export interface ProviderComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

/** Result of {@link ProviderPort.postWorkItemComment}. */
export interface ProviderPostedComment {
  id: number;
  htmlUrl: string;
}

/** One raw issue-timeline event, GitHub-shaped (event type + fields vary). */
export type ProviderTimelineEvent = Record<string, unknown>;

/**
 * Result of {@link ProviderPort.getWorkItemForTraversalAsync}. `item` is the
 * raw REST issue payload, untyped -- `discover-roadmap-graph.mts`'s own
 * `normalizeIssue` reads fields (`pull_request`, `sub_issues_summary`) no
 * other port method's normalized shape carries, so remapping onto
 * {@link ProviderWorkItem} the way every synchronous method's caller does is
 * not possible here; this is a raw passthrough by necessity, matching
 * {@link ProviderTimelineEvent} and `listReviews`'s existing raw-`unknown`
 * precedent.
 */
export type ProviderTraversalIssueLookup =
  | { outcome: 'found'; item: unknown }
  | { outcome: 'not-found' }
  | { outcome: 'inaccessible' };

export type ProviderCollaboratorPermissionResult =
  | { outcome: 'found'; permission: string; roleName: string }
  | { outcome: 'not-collaborator' }
  | {
      outcome: 'error';
      error: ProviderError;
      /**
       * The raw HTTP status `deriveGhHttpStatus` derived (`null` when it
       * could not be determined), alongside the classified `error` above --
       * `claim-approval-gate.mts`'s `resolveCollaboratorPermission`
       * reconstructs its own pre-migration `permission lookup failed: ${n}`
       * message from this number (with its own `?? 0` sentinel), which
       * `error.message`'s free-text wording cannot losslessly round-trip.
       */
      httpStatus: number | null;
    };

/** One `CONNECTED_EVENT`/`DISCONNECTED_EVENT` timeline node, GitHub-shaped. */
export type ProviderConnectedPrEvent = Record<string, unknown>;

/** One page of `closedByPullRequestsReferences`, GitHub-shaped nodes. */
export interface ProviderClosingPullRequestsPage {
  nodes: { state?: string }[];
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface ProviderChangeRequestSummary {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface ProviderChangeRequestState {
  mergeable: string;
  mergeStateStatus: string;
}

export interface ProviderRequiredCheck {
  name: string;
  state: string;
  completedAt: string | null;
}

// --- #2267: change-request/review/check/merge extension. -----------------
//
// The types and methods below extend this same surface for the broader
// migration named in #2267's own doc comment on `ProviderPort` above. Each
// method exists for one call shape already live in one of the nine named
// PR-facing helpers (`advisory-convergence.mts`, `advisory-wait-state.mts`,
// `review-activity-snapshot.mts`, `resolve-review-thread.mts`,
// `ci-wait-policy.mts`/`ci-wait-state.mts`, `pre-merge-readiness.mts`,
// `idd-merge-execute.mts`, `merged-pr-feedback-sweep.mts`) -- never unified
// across a field-selection, pagination, or failure-semantics delta, per the
// file-header rule above.

/** Result of a governance-style read that discriminates a masked `404`
 * (the response can't tell "genuinely nothing configured" from "the token
 * can't read this") from a real value, so the domain layer keeps deciding
 * how to treat the absence -- mirrors `getCollaboratorPermission`'s
 * existing "raw classified result, caller maps its own outcome" precedent.
 * Any non-404 failure still throws; this type only carries the 404 case. */
export type ProviderGovernanceReadOutcome<T> =
  | { outcome: 'ok'; value: T }
  | { outcome: 'not-found' };

/** Backs {@link ProviderPort.getChangeRequestHeadShaAndAuthor}. */
export interface ProviderChangeRequestHeadShaAndAuthor {
  headSha: string;
  authorLogin: string;
}

/** Backs {@link ProviderPort.getChangeRequestConvergenceView}. `closingIssuesReferences` is a raw passthrough (shape not inspected by this port). */
export interface ProviderChangeRequestConvergenceView {
  headSha: string;
  headRefName: string;
  authorLogin: string;
  url: string;
  closingIssuesReferences: unknown;
}

/** Backs {@link ProviderPort.getChangeRequestReadinessSnapshot} -- the
 * richest single `pr view` call in the codebase (deliberately avoids a
 * second `pr checks` round trip, #1483). `statusCheckRollup` and
 * `closingIssuesReferences` are raw passthroughs. */
export interface ProviderChangeRequestReadinessSnapshot {
  headSha: string;
  baseRefName: string;
  url: string;
  authorLogin: string;
  reviewDecision: string | null;
  statusCheckRollup: unknown;
  mergeable: string;
  mergeStateStatus: string;
  closingIssuesReferences: unknown;
}

/** Backs {@link ProviderPort.getChangeRequestBranchAndChecks}. `statusCheckRollup` is a raw passthrough. */
export interface ProviderChangeRequestBranchAndChecks {
  headSha: string;
  baseRefName: string;
  statusCheckRollup: unknown;
}

/** Backs {@link ProviderPort.listMergedChangeRequests}. */
export interface ProviderMergedChangeRequestSummary {
  number: number;
  mergedAt: string;
}

/** Backs {@link ProviderPort.getMergedChangeRequestMeta}. */
export interface ProviderMergedChangeRequestMeta {
  number: number;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitOid: string | null;
}

/** One reply-target comment inside a review thread, as
 * {@link ProviderPort.listChangeRequestReviewThreadsWithComments} and
 * {@link ProviderPort.listChangeRequestReviewThreadsExtended} return it. */
export interface ProviderReviewThreadComment {
  body: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
  /** The comment's parent review node id, when the query selects it (disposition-evidence matching). */
  pullRequestReviewId?: string | null;
}

/** Backs {@link ProviderPort.listChangeRequestReviewThreadsWithComments} --
 * shared by `review-activity-snapshot.mts` and `pre-merge-readiness.mts`
 * (byte-identical GraphQL query in both). Distinct from the minimal
 * {@link ProviderPort.listChangeRequestReviewThreads} (`{isResolved}[]`
 * only, #2266): this one also needs each thread's comment bodies/authors
 * for disposition-evidence matching. */
export interface ProviderReviewThreadWithComments {
  isResolved: boolean | null;
  comments: ProviderReviewThreadComment[];
}

/** Backs {@link ProviderPort.listChangeRequestReviewThreadsExtended} --
 * `merged-pr-feedback-sweep.mts`'s own distinct query (selects `path`,
 * absent from the shared query above). */
export interface ProviderReviewThreadExtended {
  isResolved: boolean | null;
  path: string | null;
  comments: ProviderReviewThreadComment[];
}

/** Backs {@link ProviderPort.listChangeRequestReviewThreadCommentIds} --
 * `resolve-review-thread.mts`'s own distinct, leaner query (only the
 * GraphQL thread node id and each comment's REST-numeric `databaseId`,
 * needed to target a reply/resolution, not the thread's content). */
export interface ProviderReviewThreadCommentIds {
  threadId: string;
  isResolved: boolean | null;
  commentDatabaseIds: number[];
}

/** Backs {@link ProviderPort.listChangeRequestGraphqlComments}. */
export interface ProviderGraphqlComment {
  body: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
}

/** Backs {@link ProviderPort.listChangeRequestGraphqlReviews}. */
export interface ProviderGraphqlReview {
  body: string;
  url: string;
  state: string;
  submittedAt: string | null;
  authorLogin: string;
}

/** One review node as {@link ProviderPort.getChangeRequestReviewsWithHeadCommitDate}
 * returns it -- distinct field set from {@link ProviderGraphqlReview} (no
 * `url`/`state`; adds the review's own node `id`, `authorTypename`, and
 * `commentCount`), matching `review-clause.mts`'s own Clause-1 evidence
 * shape. */
export interface ProviderReviewClauseNode {
  id: string;
  authorLogin: string;
  authorTypename: string | null;
  submittedAt: string | null;
  commitId: string | null;
  commentCount: number | null;
  body: string | null;
}

/** Backs {@link ProviderPort.getChangeRequestReviewsWithHeadCommitDate}. */
export interface ProviderReviewsWithHeadCommitDate {
  reviews: ProviderReviewClauseNode[];
  headCommittedAt: string;
}

/** Backs {@link ProviderPort.getChangeRequestAuthor}. */
export interface ProviderChangeRequestAuthor {
  login: string;
  typename: string | null;
}

/** One review-thread comment as
 * {@link ProviderPort.listChangeRequestReviewThreadsWithAuthorType} returns
 * it -- like {@link ProviderReviewThreadComment} but also selects
 * `author.__typename` (`advisory-convergence.mts`'s own distinct query;
 * neither `listChangeRequestReviewThreadsWithComments` nor
 * `listChangeRequestReviewThreadsExtended` select this field). */
export interface ProviderReviewThreadCommentWithAuthorType {
  body: string;
  createdAt: string;
  updatedAt: string;
  authorLogin: string;
  authorTypename: string | null;
  pullRequestReviewId: string | null;
}

/** Backs {@link ProviderPort.listChangeRequestReviewThreadsWithAuthorType}. */
export interface ProviderReviewThreadWithAuthorType {
  id: string;
  isResolved: boolean | null;
  comments: ProviderReviewThreadCommentWithAuthorType[];
}

/**
 * Provider port: the operation surface `discover-*.mts`, `claim-approval-
 * gate.mts`, `post-idd-marker.mts`, `resume-claim-routing.mts`,
 * `resume-route-selection.mts`, `idd-roadmap-audit-execute.mts`, and
 * `collaborator-permission.mts` consume instead of `gh`/GitHub endpoints
 * directly (#2266). The change-request methods here are a MINIMAL surface
 * for `resume-route-selection.mts` only -- #2267 extends this same surface
 * for its own broader change-request/review/check migration; method names
 * are chosen so #2267 adds to it rather than renaming it.
 */
export interface ProviderPort {
  /** repository-identity */
  resolveRepositoryLocator(): ProviderRepositoryLocator;

  /**
   * repository-identity. Throws on total failure (REST-then-GraphQL
   * fallback, matches `gh-exec.mts`'s existing `resolveViewerLogin`). The
   * adapter applies `GH_TEXT_LOOP_TIMEOUT_OPTIONS` to the REST leg --
   * `resume-claim-routing.mts`'s pre-migration call already used that
   * profile (the strictest of this method's callers), and since
   * `DEFAULT_GH_TIMEOUT_MS` already equals its 30s timeout, the only
   * actual delta is stdin-hang immunity (`stdio: ['ignore', ...]`), which
   * is strictly hang-preventing and never output-changing for every other
   * caller -- transport hygiene the port encapsulates, not a distinct
   * call shape. The GraphQL fallback leg keeps its own defaults, matching
   * `gh-exec.mts`'s original behavior (options thread to the REST leg
   * only).
   */
  resolveViewerLogin(): string;

  /**
   * repository-identity. Never throws; returns a sentinel on failure
   * instead (matched `idd-roadmap-audit-execute.mts`'s own
   * `resolveViewerLogin`, purpose-built to fix #1396's silent-failure
   * regression -- that local function is now deleted, this method having
   * fully absorbed its job as its sole consumer). REST-only, no GraphQL
   * fallback -- distinct contract from {@link resolveViewerLogin} above,
   * not a variant of it. Applies `GH_TEXT_LOOP_OPTIONS` to match the
   * original call exactly (an earlier draft omitted it, silently dropping
   * the stdin-ignore profile #1396 exists for; corrected before any
   * consumer existed).
   */
  resolveViewerLoginSafe(): {
    viewerLogin: string;
    viewerLoginUnavailable: boolean;
  };

  /**
   * work-items. Full object; null on a genuine 404, throws (typed
   * {@link ProviderError} where the adapter can classify it) on any other
   * failure -- pins `discover-viability-gate.mts`'s existing fail-closed
   * routing as the method's contract.
   */
  getWorkItem(number: number): ProviderWorkItem | null;

  /**
   * work-items. Paginated, pull-requests excluded from results. Full
   * object per item (not the summary shape) -- REST returns the full
   * issue payload regardless of field selection, and
   * `discover-orphan-filter.mts`'s `fetchOpenIssues` needs `labels`,
   * `body`, `url`, and `milestone` alongside `number`/`title`. `state` is
   * passed through in REST's raw lowercase form (unlike
   * {@link getWorkItem}'s uppercased `state`) to keep this method's output
   * byte-stable with `fetchOpenIssues`'s pre-migration CLI output --
   * downstream comparisons already re-uppercase defensively.
   */
  listOpenWorkItems(): ProviderWorkItem[];

  /**
   * work-items. GitHub search-query syntax is an adapter-internal detail.
   * Full object per item, like {@link listOpenWorkItems} -- GitHub's REST
   * search/issues endpoint returns full issue resources regardless of
   * field selection, and `discover-readiness-check.mts`'s
   * `buildRoadmapMarkerResolver` needs `state`/`body`/`labels`/`url`
   * alongside `number`/`title`.
   */
  searchWorkItems(query: string): ProviderWorkItem[];

  /**
   * work-items. Fetches the full paginated timeline; per-caller filtering
   * (labeled-only vs. every event type, any special header) stays in the
   * domain helper, matching today's split between callers.
   */
  getWorkItemTimeline(number: number): ProviderTimelineEvent[];

  /**
   * work-items. The distinct `gh issue view --json state --jq .state` call
   * shape -- GraphQL-resolved, NOT the REST `issues/{number}` shape
   * {@link getWorkItem} uses. Not interchangeable: empirically, `gh issue
   * view` on a PR number returns `MERGED` (a value REST's issue state
   * never produces), so a caller that needs to distinguish an issue from a
   * PR reference cannot substitute `getWorkItem`'s `.state` here. Returns
   * `null` both on ANY failure (unlike `getWorkItem`, this does not
   * distinguish a 404 from another failure) and on a successful-but-empty
   * response -- matches `discover-orphan-filter.mts`'s existing blanket
   * try/catch plus its `state || 'UNRESOLVABLE'` fallback exactly; the
   * caller maps `null` to its own sentinel.
   */
  getWorkItemState(number: number): string | null;

  /** work-items, write. */
  closeWorkItem(number: number, reason: string): void;

  /**
   * work-items. Issue-side `closedByPullRequestsReferences`, one page per
   * call (caller drives pagination) -- matches
   * `idd-roadmap-audit-execute.mts`'s `hasOpenClosingPr` call shape.
   */
  getWorkItemClosingPullRequestsPage(
    number: number,
    after: string | null,
  ): ProviderClosingPullRequestsPage;

  /**
   * work-items. Single unpaginated `last:100` CONNECTED/DISCONNECTED
   * timeline fetch; adapter swallows failures and returns an empty array
   * (fail-open) -- matches `resume-claim-routing.mts`'s existing shape
   * exactly. NOT the same operation as
   * {@link getConnectedPullRequestEventsPage}: different query,
   * different pagination, different failure philosophy -- see #2266's B2
   * plan critique-driven revision for why these stay separate.
   */
  getConnectedPullRequestEventsSingle(
    number: number,
  ): ProviderConnectedPrEvent[];

  /**
   * work-items. Full forward-paginated CONNECTED/DISCONNECTED timeline,
   * one page per call (caller drives pagination and its own fail-closed
   * incomplete-page handling) -- matches
   * `idd-roadmap-audit-execute.mts`'s `hasOpenConnectedPr` call shape.
   */
  getConnectedPullRequestEventsPage(
    number: number,
    after: string | null,
  ): {
    events: ProviderConnectedPrEvent[];
    hasNextPage: boolean;
    endCursor: string | null;
  };

  /**
   * work-items/change-requests boundary. The distinct PR-side
   * `closingIssuesReferences` technique `discover-shared-file-overlap.mts`'s
   * `fetchOpenPrLinkedIssues` uses today -- a single best-effort scan across
   * every open PR, called ONCE per run, NOT a per-issue lookup (an earlier
   * draft of this method took an issue number and re-scanned the full open-PR
   * list per call, which would have replayed that scan once per candidate
   * issue; corrected here before any consumer existed). `limit` is the
   * caller's own advisory-signal page cap (matches the file's existing
   * `OPEN_PR_SCAN_LIMIT`), not a fixed transport constant -- a repo with more
   * open PRs than `limit` silently drops the overflow, the file's existing
   * best-effort contract, unchanged. Returns the flattened, deduplicated set
   * of every issue number referenced by any open PR's
   * `closingIssuesReferences` within that cap.
   */
  listIssueNumbersClosedByOpenChangeRequests(limit: number): number[];

  /** work-items. Issue-branch ref scan (`git/matching-refs/heads/issue/`). */
  listIssueBranchRefs(): string[];

  /** comments-and-labels. Paginated; the most repeated existing operation. */
  listWorkItemComments(number: number): ProviderComment[];

  /**
   * comments-and-labels, write. Adapter posts via stdin-JSON (`--input -`),
   * preserving the existing constraint that `gh issue comment --body=` /
   * `gh pr comment` drop HTML-comment-first bodies. Consolidates
   * `post-idd-marker.mts`'s and `idd-roadmap-audit-execute.mts`'s two
   * independent existing implementations of this same shape.
   */
  postWorkItemComment(number: number, body: string): ProviderPostedComment;

  /** permissions. Raw classified result; each caller maps outcomes onto
   * its own existing shape (see #2266 B2 plan for the two divergent
   * existing callers this preserves). */
  getCollaboratorPermission(
    login: string,
  ): ProviderCollaboratorPermissionResult;

  /** change-requests (minimal surface for resume-route-selection.mts). */
  getChangeRequest(number: number): ProviderChangeRequestState | null;

  /**
   * change-requests. The distinct `gh pr view --json headRefOid --jq
   * .headRefOid` call shape `post-idd-marker.mts`'s `headShaFromPr` uses --
   * NOT unified with {@link getChangeRequest} despite both being `gh pr
   * view` calls: different `--json` field selection is a genuinely
   * different GraphQL-backed query (unlike REST's always-full-object
   * behavior), and the two callers have different failure philosophies
   * (this one throws on ANY failure, no 404-to-null mapping) -- pins
   * `headShaFromPr`'s existing no-try/catch-here contract. SHA-format
   * validation stays in the domain.
   */
  getChangeRequestHeadSha(number: number): string;

  /**
   * change-requests (minimal surface for resume-route-selection.mts). Two
   * failure recoveries preserved from the pre-migration `ghJson`/
   * `recoverJsonFromGhFailure` wrapper this replaces, both load-bearing, not
   * generic hygiene: `gh pr checks --required` exits non-zero on a repo/PR
   * with no required checks configured -- a routine state this method must
   * report as `[]` (letting the caller derive `requiredChecksGenerated:
   * false`), not throw on -- and `gh pr checks` is documented to exit
   * non-zero while checks are still failing/pending even with `--json`,
   * the very state this method exists to classify, so the
   * stdout-on-failure fallback is not speculative hardening. An earlier
   * draft of this method (corrected here before any consumer existed) had
   * neither recovery and would have thrown on both of those routine cases.
   */
  listRequiredChecks(number: number): ProviderRequiredCheck[];

  /** change-requests (minimal surface for resume-route-selection.mts). */
  listReviews(number: number): unknown[];

  /** change-requests (minimal surface for resume-route-selection.mts). */
  listOpenChangeRequests(): ProviderChangeRequestSummary[];

  /**
   * change-requests. Full-walk pagination of PR review-thread resolution
   * status -- `resume-route-selection.mts`'s own `fetchReviewThreads`
   * GraphQL loop, matched exactly. The adapter drives every page
   * internally, unlike {@link getWorkItemClosingPullRequestsPage}'s
   * caller-driven one-page-per-call shape: this file's only caller walks to
   * completion in one call, never inspects a cursor itself. A page with
   * `hasNextPage: true` but a missing `endCursor` throws -- preserved from
   * the pre-migration loop (a malformed payload would otherwise silently
   * undercount unresolved threads), not an artifact of migration.
   */
  listChangeRequestReviewThreads(
    number: number,
  ): { isResolved: boolean | null }[];

  /**
   * work-items, async, traversal-only (see the header comment above). The
   * distinct bounded-concurrency shape `discover-roadmap-graph.mts`'s
   * `buildIssueLoader` uses: non-blocking `ghTextAsync` (several in flight
   * at once, bounded by the traversal's own `mapPool`), bounded-retried
   * (#1394) with a custom classifier that does NOT retry a genuine 404 or
   * an inaccessible-issue failure (403/410/451, or their equivalent
   * stderr-text signature) -- only a transient failure (a truncated
   * captured stdout, a network hiccup) gets the extra bounded attempts.
   * `not-found` and `inaccessible` are reached on the FIRST attempt,
   * byte-identical to no retry wrapper at all. NOT unified with
   * {@link getWorkItem}: that method's `null`-on-404/throw-on-other
   * contract has no room for a THIRD outcome (inaccessible) without either
   * losing the retry-skip distinction or forcing the traversal to
   * re-derive it from a thrown {@link ProviderError}'s category, which
   * cannot express 410/451 as the same bucket as 403 the way this file's
   * own classification does.
   */
  getWorkItemForTraversalAsync(
    number: number,
  ): Promise<ProviderTraversalIssueLookup>;

  /**
   * work-items, async, traversal-only. Full-walk pagination of GitHub's
   * native `subIssues` connection -- `discover-roadmap-graph.mts`'s
   * `buildSubIssueLoader` shape, a query no other port method covers.
   * Bounded-retried (#1394) PER PAGE with the default retry-everything
   * classifier (no pre-existing REST-status classification to preserve,
   * unlike {@link getWorkItemForTraversalAsync}). Both fail-fasts from the
   * pre-migration loop stay inside: an absent `subIssues` connection, and
   * `hasNextPage: true` with a missing `endCursor` (matches
   * {@link listChangeRequestReviewThreads}'s established shape). Returns
   * the raw, un-deduped `nodes` flattened across every page -- NOT
   * numbers: `discover-roadmap-graph.mts`'s own `normalizeSubIssueNumbers`
   * already does that coercion-plus-dedup and is reused elsewhere in the
   * same file (`getReferences`'s native-sub-issue path), so duplicating
   * it here would fork one small pure function into two copies.
   */
  listWorkItemSubIssueNodesAsync(number: number): Promise<unknown[]>;

  /**
   * comments-and-labels, async, traversal-adjacent (NOT part of the
   * concurrent hot path -- `discover-roadmap-graph.mts`'s pre-migration
   * `buildCommentLoader` runs its per-page `gh` call through the
   * SYNCHRONOUS `ghText`, same as every other comment fetch in this
   * migration; the method is only `async` because {@link withBoundedRetry}
   * (#1394, one retry classifier shared with every other traversal loader)
   * needs one). Raw passthrough by design, NOT {@link ProviderComment}:
   * `ClaimStateResolution.loadComments`'s own contract deliberately keeps
   * its element type `unknown` rather than promise a shape the loader
   * never guaranteed pre-migration (its own doc comment says so), and
   * `discover-orphan-filter.mts` already depends on that looseness through
   * `buildClaimStateResolution`. NOT the same operation as
   * {@link listWorkItemComments}: that method's single `--paginate` call
   * retries (if at all) the WHOLE fetch, where this one retries one page
   * at a time -- a real granularity difference, not interchangeable.
   */
  listWorkItemCommentsWithRetryAsync(number: number): Promise<unknown[]>;

  /**
   * work-items. `gh search issues`, the distinct server-side search
   * technique `discover-roadmap-graph.mts`'s `buildOpenRoadmapRootsLoader`
   * uses for `--all-roadmaps` root discovery (a label search and a
   * body-marker search, unioned by the caller) -- not `listOpenWorkItems`/
   * `searchWorkItems`'s REST list/search shape. `limit` is GitHub search's
   * own hard per-query result cap (not a caller-tunable advisory bound like
   * `listIssueNumbersClosedByOpenChangeRequests`'s), passed through rather
   * than hardcoded in the adapter so the domain's own
   * `warnOnSearchResultCap` truncation check and this call share one
   * source of truth instead of two independent literals that could drift.
   * Raw passthrough (`unknown[]`): the caller re-confirms each hit's
   * marker with its own regex over the raw `body` field, and truncation
   * detection needs the untouched result-array length.
   */
  searchOpenWorkItems(query: {
    label?: string;
    matchBody?: string;
    fields: string[];
    limit: number;
  }): unknown[];

  // --- #2267 additions below. -------------------------------------------

  /** repository-identity. `gh api repos/{owner}/{repo} --jq
   * .default_branch`, `null` on any failure -- delegates to `gh-exec.mts`'s
   * existing shared `readGithubRepoDefaultBranch` (#2272), already reused
   * by `pre-merge-readiness.mts`, `ci-wait-state.mts`, and
   * `idd-merge-execute.mts` today. */
  getRepositoryDefaultBranch(owner: string, repo: string): string | null;

  /**
   * repository-identity. Never throws; matches `resolveViewerLoginSafe`'s
   * never-throw contract but for `gh api app --jq '.slug // .app_slug //
   * empty'` -- a distinct query, not a variant of it.
   */
  resolveViewerAppSlugSafe(): { appSlug: string; unavailable: boolean };

  /**
   * repository-identity. Same query/never-throw contract as
   * {@link resolveViewerLoginSafe}, but `advisory-convergence.mts`'s own
   * call varies its subprocess stdio by `GITHUB_ACTIONS` (piped/silent in
   * CI, inherited/visible locally) so a human watching a local run still
   * sees the underlying `gh` stderr -- not a query difference, but not
   * "never output-changing" either (a local run's visible stderr changes),
   * so it gets its own method rather than folding into the existing one
   * (whose doc comment pins exact-options-match for its own consumer).
   */
  resolveViewerLoginSafeQuiet(): {
    viewerLogin: string;
    viewerLoginUnavailable: boolean;
  };

  /**
   * repository-identity, read. `contents/{path}?ref=` GET, full response
   * object; 404 (masked-403-per-GitHub's-docs) tolerated as `null` at the
   * transport level -- `pre-merge-readiness.mts`'s CODEOWNERS fallback
   * chain probes several candidate paths and expects a clean `null` to try
   * the next one. Distinct from {@link getRepositoryFileContentAtRef}
   * below: different content-negotiation path (query-string `ref`, no
   * `--jq` narrowing) and a different repo-scoping caller (this one is
   * always the port's own ambient repo via explicit owner/repo, matching
   * every other two-arg repo method here).
   */
  getRepositoryContentAtRef(
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): unknown | null;

  /**
   * repository-identity, read. `contents/{path}` GET via `--field ref=`
   * (not a query string) narrowed to `.content` (base64), scoped by an
   * explicit `repoRef` (`<owner>/<repo>`) that `idd-merge-execute.mts`'s
   * own `--owner`/`--repo` collector flags can point at a DIFFERENT repo
   * than the port's own ambient locator -- the one genuinely cross-repo
   * call in this migration. `not-found` on a 404; any other failure
   * throws (the caller's pre-migration `deriveGhHttpStatus` re-check on a
   * thrown error is replaced by this explicit outcome instead of trying to
   * preserve that pattern across the port boundary).
   */
  getRepositoryFileContentAtRef(
    repoRef: string,
    path: string,
    ref: string,
  ): ProviderGovernanceReadOutcome<string>;

  /**
   * permissions. `orgs/{org}/teams/{slug}/memberships/{login}` `--jq
   * .state`, never throws (matches
   * `resolveViewerClassicBypassTeamSlugs`'s existing fail-open '' default).
   */
  getTeamMembershipStateSafe(
    org: string,
    teamSlug: string,
    login: string,
  ): string;

  /**
   * change-requests. `pr view --json headRefOid,author` -- the distinct
   * two-field shape `review-activity-snapshot.mts` uses (throws on any
   * failure, no 404-to-null mapping, matching that file's pre-migration
   * no-try/catch call).
   */
  getChangeRequestHeadShaAndAuthor(
    number: number,
  ): ProviderChangeRequestHeadShaAndAuthor;

  /**
   * change-requests. `pr view --json
   * headRefOid,headRefName,closingIssuesReferences,author,url` -- the
   * distinct five-field shape `advisory-convergence.mts` uses.
   */
  getChangeRequestConvergenceView(
    number: number,
  ): ProviderChangeRequestConvergenceView;

  /**
   * change-requests. `pr view --json
   * headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup,
   * mergeable,mergeStateStatus,closingIssuesReferences` -- the distinct
   * nine-field shape `pre-merge-readiness.mts` uses (deliberately folds
   * check status into this one call rather than a second `pr checks`
   * round trip, #1483).
   */
  getChangeRequestReadinessSnapshot(
    number: number,
  ): ProviderChangeRequestReadinessSnapshot;

  /**
   * change-requests. `pr view --json headRefOid,baseRefName,
   * statusCheckRollup` -- the distinct three-field shape `ci-wait-state.mts`
   * uses.
   */
  getChangeRequestBranchAndChecks(
    number: number,
  ): ProviderChangeRequestBranchAndChecks;

  /**
   * change-requests. `pr view --json headRefOid --jq .headRefOid` narrowed
   * further with `--jq .head.ref`-equivalent branch-name extraction (REST
   * `.head.ref`, NOT `.headRefOid`) -- `resolve-review-thread.mts`'s own
   * distinct call, not interchangeable with
   * {@link ProviderPort.getChangeRequestHeadSha} (sha, not branch name).
   */
  getChangeRequestHeadRef(number: number): string;

  /**
   * change-requests. `pr list --state merged --json number,mergedAt
   * [--search merged:>=date]` -- distinct from
   * {@link ProviderPort.listOpenChangeRequests} (open-only, different
   * fields). `sinceDate` (`YYYY-MM-DD` or `null`) maps to the optional
   * `--search` filter `merged-pr-feedback-sweep.mts` applies.
   */
  listMergedChangeRequests(
    limit: number,
    sinceDate: string | null,
  ): ProviderMergedChangeRequestSummary[];

  /**
   * change-requests. GraphQL `pullRequest(number){number merged mergedAt
   * mergeCommit{oid}}` -- `null` when the PR is not (yet) merged, matching
   * `merged-pr-feedback-sweep.mts`'s existing `pr.merged` guard.
   */
  getMergedChangeRequestMeta(
    number: number,
  ): ProviderMergedChangeRequestMeta | null;

  /**
   * change-requests, write. REST POST
   * `pulls/{pr}/comments/{commentId}/replies`, JSON stdin body -- distinct
   * from {@link ProviderPort.postWorkItemComment} (issues-comments API, a
   * different endpoint); this one replies under a specific review comment.
   */
  postReviewCommentReply(
    number: number,
    commentId: number,
    body: string,
  ): { id: number };

  /**
   * change-requests, write. GraphQL mutation `resolveReviewThread(input:
   * {threadId})`; throws unless the response confirms `isResolved ===
   * true` (matches `resolve-review-thread.mts`'s existing verification).
   */
  resolveChangeRequestReviewThread(threadId: string): void;

  /** change-requests, cross-repo. `pr view -R {owner}/{repo} --json
   * headRefOid --jq .headRefOid`, throws on any failure -- the explicit-
   * repo sibling of {@link ProviderPort.getChangeRequestHeadSha} that
   * `idd-merge-execute.mts`'s own `--owner`/`--repo` collector flags need
   * (see {@link getRepositoryFileContentAtRef} for why this file alone
   * gets cross-repo methods). */
  getChangeRequestHeadShaAtRepo(
    owner: string,
    repo: string,
    number: number,
  ): string;

  /** change-requests, cross-repo. `pr view -R {owner}/{repo} --json
   * headRefName --jq .headRefName`, throws on any failure -- used by
   * `idd-merge-execute.mts`'s local-head-drift advisory (#2453) to learn
   * the PR's own branch name, with the same cross-repo scope as
   * {@link ProviderPort.getChangeRequestHeadShaAtRepo}. */
  getChangeRequestHeadRefNameAtRepo(
    owner: string,
    repo: string,
    number: number,
  ): string;

  /** change-requests, cross-repo. `pr view -R {owner}/{repo} --json
   * mergeable,mergeStateStatus`, `null` on failure -- the explicit-repo
   * sibling of {@link ProviderPort.getChangeRequest}. */
  getChangeRequestAtRepo(
    owner: string,
    repo: string,
    number: number,
  ): ProviderChangeRequestState | null;

  /** change-requests, cross-repo, write. `pr merge -R {owner}/{repo}
   * --merge --match-head-commit {headSha}`. */
  mergeChangeRequestAtRepo(
    owner: string,
    repo: string,
    number: number,
    headSha: string,
  ): string;

  /** change-requests, cross-repo, write. Same as
   * {@link mergeChangeRequestAtRepo} plus `--admin` -- a separate method
   * per the port's one-op-per-call-shape rule (no flag parameter). */
  mergeChangeRequestAdminAtRepo(
    owner: string,
    repo: string,
    number: number,
    headSha: string,
  ): string;

  /**
   * change-requests. `pr checks --json name,state,completedAt` WITHOUT
   * `--required` -- every check, not just the required subset
   * {@link ProviderPort.listRequiredChecks} returns. Same two recoveries as
   * that method (routine non-zero exit on no-checks-configured or still-
   * pending/failing checks).
   */
  listChangeRequestChecks(number: number): ProviderRequiredCheck[];

  /**
   * change-requests. REST unpaginated `pulls/{pr}/requested_reviewers`,
   * flattened to logins.
   */
  getChangeRequestRequestedReviewerLogins(number: number): string[];

  /**
   * change-requests. GraphQL `reviewRequests(first:100){nodes{
   * requestedReviewer{...on Bot/User/Mannequin{login}}}}` -- distinct
   * transport/shape from
   * {@link getChangeRequestRequestedReviewerLogins} above; `null` on ANY
   * failure (matches the existing try/catch, never throws).
   */
  getChangeRequestRequestedReviewerLoginsGraphql(
    number: number,
  ): string[] | null;

  /** change-requests. REST paginated `pulls/{pr}/files`, flattened to `.filename`. */
  listChangeRequestChangedFiles(number: number): string[];

  /** change-requests. REST paginated `pulls/{pr}/commits`, raw passthrough. */
  listChangeRequestCommits(number: number): unknown[];

  /**
   * reviews-and-threads. Full-walk paginated GraphQL `reviewThreads` with
   * nested comment bodies/authors/timestamps -- see
   * {@link ProviderReviewThreadWithComments}'s doc comment for why this is
   * distinct from the minimal {@link listChangeRequestReviewThreads}.
   * Shared by `review-activity-snapshot.mts` and `pre-merge-readiness.mts`
   * (byte-identical query in both today).
   */
  listChangeRequestReviewThreadsWithComments(
    number: number,
  ): ProviderReviewThreadWithComments[];

  /**
   * reviews-and-threads. `merged-pr-feedback-sweep.mts`'s own distinct
   * full-walk paginated GraphQL `reviewThreads` query (selects `path`,
   * which the shared query above does not) -- see
   * {@link ProviderReviewThreadExtended}.
   */
  listChangeRequestReviewThreadsExtended(
    number: number,
  ): ProviderReviewThreadExtended[];

  /**
   * reviews-and-threads. `resolve-review-thread.mts`'s own distinct,
   * leaner full-walk paginated GraphQL `reviewThreads` query (thread node
   * id plus each comment's REST-numeric `databaseId` only, no body/author)
   * -- see {@link ProviderReviewThreadCommentIds}.
   */
  listChangeRequestReviewThreadCommentIds(
    number: number,
  ): ProviderReviewThreadCommentIds[];

  /**
   * reviews-and-threads. Full-walk paginated GraphQL `comments(first:100)`
   * -- distinct transport/shape from
   * {@link ProviderPort.listWorkItemComments} (REST, different fields);
   * `merged-pr-feedback-sweep.mts`'s own query.
   */
  listChangeRequestGraphqlComments(number: number): ProviderGraphqlComment[];

  /**
   * reviews-and-threads. Full-walk paginated GraphQL `reviews(first:100)`
   * -- distinct transport/shape from {@link ProviderPort.listReviews}
   * (REST, different fields); `merged-pr-feedback-sweep.mts`'s own query.
   */
  listChangeRequestGraphqlReviews(number: number): ProviderGraphqlReview[];

  /**
   * branch-protection. `rules/branches/{ref}` -- see
   * {@link ProviderGovernanceReadOutcome}'s doc comment for the masked-404
   * rationale shared with {@link getBranchProtection} below (both
   * endpoints document only 200/404 per GitHub's REST reference, never
   * 403, per #1377's citations).
   */
  listBranchRules(
    owner: string,
    repo: string,
    ref: string,
  ): ProviderGovernanceReadOutcome<unknown[]>;

  /** branch-protection. `branches/{ref}/protection` -- see {@link listBranchRules}. */
  getBranchProtection(
    owner: string,
    repo: string,
    ref: string,
  ): ProviderGovernanceReadOutcome<unknown>;

  /**
   * branch-protection. Ruleset detail read at an ALREADY-RESOLVED absolute
   * API path (`repos/{owner}/{repo}/rulesets/{id}`, `orgs/{org}/rulesets/{id}`,
   * or `enterprises/{enterprise}/rulesets/{id}`) -- `pre-merge-readiness.mts`'s
   * `fetchBranchRulesets` resolves which scope applies itself (via
   * `resolveRulesetDetailPath`, protocol-helpers.mts) before fetching, so
   * this method takes the resolved path rather than an owner/repo/id triple
   * it would have to re-derive scope from. GitHub's reference documents only
   * 200/404/500 for this endpoint (no 403), the same masked-404 posture as
   * {@link listBranchRules}.
   */
  getRepositoryRulesetDetail(
    path: string,
  ): ProviderGovernanceReadOutcome<unknown>;

  /** checks. `actions/runs/{runId}` single-run read, raw passthrough.
   * `runId` is `string | number` (not just `number`): a GitHub Actions run
   * id can exceed `Number.MAX_SAFE_INTEGER`, so a caller holding the id as
   * a string must be able to pass it through without a lossy `Number()`
   * round-trip (#2267 regression, caught by
   * `ci-wait-policy.test.mts`'s "preserves a run id above
   * Number.MAX_SAFE_INTEGER exactly" case). */
  getWorkflowRun(owner: string, repo: string, runId: string | number): unknown;

  /** checks. `gh run list --workflow {name} --limit N --json
   * databaseId,conclusion,status,createdAt` -- distinct `gh run list`
   * shape, not a `gh api` call. */
  listWorkflowRuns(
    owner: string,
    repo: string,
    workflowName: string,
    limit: number,
  ): {
    /** `string`, not `number`: a `databaseId` above
     * `Number.MAX_SAFE_INTEGER` loses precision through `Number()` --
     * `ci-wait-policy.mts`'s sibling-exclusion compares this against a
     * string-valued `--run-id`, so a rounded id could wrongly stop
     * matching the current run (Codex review, PR #2429; matches
     * {@link getWorkflowRun}'s `runId` parameter, kept `string | number`
     * for the same reason). */
    id: string;
    conclusion: string | null;
    status: string;
    createdAt: string;
  }[];

  /**
   * change-requests. GraphQL `pullRequest(number){author{login __typename}}`
   * -- `advisory-convergence.mts`'s own minimal author-only query (its
   * `fetchPrAuthor`), distinct from every other author-carrying method here
   * (none else select `__typename`). `null` when the PR/author is absent.
   */
  getChangeRequestAuthor(number: number): ProviderChangeRequestAuthor | null;

  /**
   * reviews-and-threads. Same full-walk two-level pagination as
   * {@link listChangeRequestReviewThreadsWithComments}, but
   * `advisory-convergence.mts`'s own query also selects `author.__typename`
   * -- see {@link ProviderReviewThreadCommentWithAuthorType}.
   */
  listChangeRequestReviewThreadsWithAuthorType(
    number: number,
  ): ProviderReviewThreadWithAuthorType[];

  /**
   * reviews-and-threads. Paginated GraphQL `reviews(first:100)` plus a
   * once-per-call `commits(last:1){nodes{commit{committedDate}}}` sibling
   * field -- `review-clause.mts`'s own distinct query (shared by
   * `advisory-convergence.mts`, `pre-merge-readiness.mts`, and the
   * out-of-scope `rerun-advisory-convergence.mts` today), not unifiable
   * with {@link listChangeRequestGraphqlReviews} (different field set, no
   * head-commit-date sibling).
   */
  getChangeRequestReviewsWithHeadCommitDate(
    number: number,
  ): ProviderReviewsWithHeadCommitDate;

  /** merge, write. `pr merge --merge --match-head-commit {headSha}` on the
   * port's own ambient repo. */
  mergeChangeRequest(number: number, headSha: string): string;

  /** merge, write. Same as {@link mergeChangeRequest} plus `--admin` --
   * separate method per the port's one-op-per-call-shape rule. */
  mergeChangeRequestAdmin(number: number, headSha: string): string;

  /**
   * capability declarations. Static list of what this adapter supports per
   * `provider-contract.mts` capability group -- no network call, no
   * per-repository variance. A caller feeds each declaration through
   * {@link evaluateProviderCapabilityOutcome} to decide `ok` / `fail_closed`
   * / `not_applicable` for that group. The GitHub adapter reports every
   * group supported; a future non-GitHub adapter without an equivalent
   * advisory reviewer would report `advisory-review` unsupported so
   * `advisory-convergence.mts` can resolve it `not_applicable` instead of
   * fail-closing (#2267 AC4).
   */
  listCapabilityDeclarations(): ProviderCapabilityDeclaration[];
}
