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

import type {
  ProviderError,
  ProviderRepositoryLocator,
} from './provider-contract.mts';

/** Provider-neutral work item (GitHub issue) shape, full object. */
export interface ProviderWorkItem {
  number: number;
  title: string;
  body: string;
  state: string;
}

/** Minimal locator/summary shape for a work item found via list/search. */
export interface ProviderWorkItemSummary {
  number: number;
  title: string;
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

export type ProviderCollaboratorPermissionResult =
  | { outcome: 'found'; permission: string; roleName: string }
  | { outcome: 'not-collaborator' }
  | { outcome: 'error'; error: ProviderError };

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
   * fallback, matches `gh-exec.mts`'s existing `resolveViewerLogin`).
   */
  resolveViewerLogin(): string;

  /**
   * repository-identity. Never throws; returns a sentinel on failure
   * instead (matches `idd-roadmap-audit-execute.mts`'s own
   * `resolveViewerLogin`, purpose-built to fix #1396's silent-failure
   * regression). REST-only, no GraphQL fallback -- distinct contract from
   * {@link resolveViewerLogin} above, not a variant of it.
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
  getWorkItem(number: number): Promise<ProviderWorkItem | null>;

  /** work-items. Paginated, pull-requests excluded from results. */
  listOpenWorkItems(): Promise<ProviderWorkItemSummary[]>;

  /** work-items. GitHub search-query syntax is an adapter-internal detail. */
  searchWorkItems(query: string): Promise<ProviderWorkItemSummary[]>;

  /**
   * work-items. Fetches the full paginated timeline; per-caller filtering
   * (labeled-only vs. every event type, any special header) stays in the
   * domain helper, matching today's split between callers.
   */
  getWorkItemTimeline(number: number): Promise<ProviderTimelineEvent[]>;

  /** work-items, write. */
  closeWorkItem(number: number, reason: string): Promise<void>;

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
  ): Promise<ProviderConnectedPrEvent[]>;

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
   * `closingIssuesReferences` technique `discover-shared-file-overlap.mts`
   * uses today -- not unified with the issue-side methods above.
   */
  getPullRequestsClosingIssue(number: number): Promise<number[]>;

  /** work-items. Issue-branch ref scan (`git/matching-refs/heads/issue/`). */
  listIssueBranchRefs(): Promise<string[]>;

  /** comments-and-labels. Paginated; the most repeated existing operation. */
  listWorkItemComments(number: number): Promise<ProviderComment[]>;

  /**
   * comments-and-labels, write. Adapter posts via stdin-JSON (`--input -`),
   * preserving the existing constraint that `gh issue comment --body=` /
   * `gh pr comment` drop HTML-comment-first bodies. Consolidates
   * `post-idd-marker.mts`'s and `idd-roadmap-audit-execute.mts`'s two
   * independent existing implementations of this same shape.
   */
  postWorkItemComment(
    number: number,
    body: string,
  ): Promise<ProviderPostedComment>;

  /** permissions. Raw classified result; each caller maps outcomes onto
   * its own existing shape (see #2266 B2 plan for the two divergent
   * existing callers this preserves). */
  getCollaboratorPermission(
    login: string,
  ): Promise<ProviderCollaboratorPermissionResult>;

  /** change-requests (minimal surface for resume-route-selection.mts). */
  getChangeRequest(number: number): Promise<ProviderChangeRequestState | null>;

  /** change-requests (minimal surface for resume-route-selection.mts). */
  listRequiredChecks(number: number): Promise<ProviderRequiredCheck[]>;

  /** change-requests (minimal surface for resume-route-selection.mts). */
  listReviews(number: number): Promise<unknown[]>;

  /** change-requests (minimal surface for resume-route-selection.mts). */
  listOpenChangeRequests(): Promise<ProviderChangeRequestSummary[]>;
}
