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

/** One issue-comments-API comment (issue or PR -- same endpoint on GitHub). */
export interface ProviderComment {
  id: number;
  body: string;
  createdAt: string;
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
}
