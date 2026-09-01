// idd-generated-from: src/scripts/provider-adapter-fake.mts
//
// The scripts/provider-adapter-fake.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// In-memory fake implementation of `provider-port.mts` (#2266), for unit
// tests that exercise discovery/claim/permission logic without an
// authenticated `gh` process. Every method reads/writes the fixture object
// passed to `createFakeProviderAdapter`; nothing here spawns a subprocess
// or makes a network call.

import type { ProviderRepositoryLocator } from './provider-contract.mts';
import type {
  ProviderChangeRequestState,
  ProviderChangeRequestSummary,
  ProviderClosingPullRequestsPage,
  ProviderCollaboratorPermissionResult,
  ProviderComment,
  ProviderConnectedPrEvent,
  ProviderPort,
  ProviderPostedComment,
  ProviderRequiredCheck,
  ProviderTimelineEvent,
  ProviderTraversalIssueLookup,
  ProviderWorkItem,
} from './provider-port.mts';

export interface FakeProviderFixture {
  locator?: ProviderRepositoryLocator;
  viewerLogin?: string;
  viewerLoginUnavailable?: boolean;
  workItems?: Record<number, ProviderWorkItem>;
  timelines?: Record<number, ProviderTimelineEvent[]>;
  comments?: Record<number, ProviderComment[]>;
  closingPullRequestPages?: Record<number, ProviderClosingPullRequestsPage[]>;
  connectedPrEventsSingle?: Record<number, ProviderConnectedPrEvent[]>;
  connectedPrEventPages?: Record<
    number,
    {
      events: ProviderConnectedPrEvent[];
      hasNextPage: boolean;
      endCursor: string | null;
    }[]
  >;
  /** Backs {@link ProviderPort.listIssueNumbersClosedByOpenChangeRequests}. */
  issueNumbersClosedByOpenChangeRequests?: number[];
  issueBranchRefs?: string[];
  collaboratorPermissions?: Record<
    string,
    ProviderCollaboratorPermissionResult
  >;
  changeRequests?: Record<number, ProviderChangeRequestState>;
  /** Backs {@link ProviderPort.getChangeRequestHeadSha}; an absent key
   * throws (matches the adapter's own no-catch, throw-on-failure contract). */
  changeRequestHeadShas?: Record<number, string>;
  requiredChecks?: Record<number, ProviderRequiredCheck[]>;
  reviews?: Record<number, unknown[]>;
  openChangeRequests?: ProviderChangeRequestSummary[];
  /** Backs {@link ProviderPort.listChangeRequestReviewThreads}. */
  reviewThreads?: Record<number, { isResolved: boolean | null }[]>;
  /** Backs {@link ProviderPort.getWorkItemState}; absent key or an
   * explicit `null` value both mean "not found". */
  issueStates?: Record<number, string | null>;
  /** Every posted comment is appended here, in call order. */
  postedComments?: { number: number; body: string }[];
  /** Every closed work item is appended here, in call order. */
  closedWorkItems?: { number: number; reason: string }[];
  nextCommentId?: number;
  /** Backs {@link ProviderPort.getWorkItemForTraversalAsync}; absent key
   * means `not-found` (matches the adapter's own not-found default). */
  traversalIssueLookups?: Record<number, ProviderTraversalIssueLookup>;
  /** Backs {@link ProviderPort.listWorkItemSubIssueNodesAsync}. */
  subIssueNodes?: Record<number, unknown[]>;
  /** Backs {@link ProviderPort.listWorkItemCommentsWithRetryAsync}; raw
   * passthrough, distinct from {@link comments} (ProviderComment-typed). */
  traversalComments?: Record<number, unknown[]>;
  /** Backs {@link ProviderPort.searchOpenWorkItems}. */
  searchResults?: unknown[];
}

export function createFakeProviderAdapter(
  fixture: FakeProviderFixture,
): ProviderPort {
  fixture.postedComments ??= [];
  fixture.closedWorkItems ??= [];
  fixture.nextCommentId ??= 1;
  // Per-instance pagination-call counters: each `createFakeProviderAdapter`
  // call gets independent state, so parallel/repeated tests never leak
  // page-cursor progress into one another the way module-level state would.
  const closingPageCallIndex: Record<number, number> = {};
  const connectedPageCallIndex: Record<number, number> = {};

  return {
    resolveRepositoryLocator(): ProviderRepositoryLocator {
      return (
        fixture.locator ?? {
          provider: 'github',
          owner: 'fake-owner',
          name: 'fake-repo',
        }
      );
    },

    resolveViewerLogin(): string {
      if (fixture.viewerLoginUnavailable || !fixture.viewerLogin) {
        throw new Error('fake provider: viewer login unavailable');
      }
      return fixture.viewerLogin;
    },

    resolveViewerLoginSafe(): {
      viewerLogin: string;
      viewerLoginUnavailable: boolean;
    } {
      if (fixture.viewerLoginUnavailable || !fixture.viewerLogin) {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
      return {
        viewerLogin: fixture.viewerLogin,
        viewerLoginUnavailable: false,
      };
    },

    getWorkItem(number: number): ProviderWorkItem | null {
      return fixture.workItems?.[number] ?? null;
    },

    listOpenWorkItems(): ProviderWorkItem[] {
      return Object.values(fixture.workItems ?? {}).filter(
        (item) => item.state === 'OPEN',
      );
    },

    searchWorkItems(): ProviderWorkItem[] {
      return Object.values(fixture.workItems ?? {});
    },

    getWorkItemTimeline(number: number): ProviderTimelineEvent[] {
      return fixture.timelines?.[number] ?? [];
    },

    getWorkItemState(number: number): string | null {
      return fixture.issueStates?.[number] ?? null;
    },

    closeWorkItem(number: number, reason: string): void {
      fixture.closedWorkItems?.push({ number, reason });
      const item = fixture.workItems?.[number];
      if (item) {
        item.state = 'CLOSED';
      }
    },

    getWorkItemClosingPullRequestsPage(
      number: number,
    ): ProviderClosingPullRequestsPage {
      const pages = fixture.closingPullRequestPages?.[number] ?? [];
      const index = closingPageCallIndex[number] ?? 0;
      closingPageCallIndex[number] = index + 1;
      return pages[index] ?? { nodes: [], hasNextPage: false, endCursor: null };
    },

    getConnectedPullRequestEventsSingle(
      number: number,
    ): ProviderConnectedPrEvent[] {
      return fixture.connectedPrEventsSingle?.[number] ?? [];
    },

    getConnectedPullRequestEventsPage(number: number): {
      events: ProviderConnectedPrEvent[];
      hasNextPage: boolean;
      endCursor: string | null;
    } {
      const pages = fixture.connectedPrEventPages?.[number] ?? [];
      const index = connectedPageCallIndex[number] ?? 0;
      connectedPageCallIndex[number] = index + 1;
      return (
        pages[index] ?? { events: [], hasNextPage: false, endCursor: null }
      );
    },

    listIssueNumbersClosedByOpenChangeRequests(): number[] {
      return fixture.issueNumbersClosedByOpenChangeRequests ?? [];
    },

    listIssueBranchRefs(): string[] {
      return fixture.issueBranchRefs ?? [];
    },

    listWorkItemComments(number: number): ProviderComment[] {
      return fixture.comments?.[number] ?? [];
    },

    postWorkItemComment(number: number, body: string): ProviderPostedComment {
      fixture.postedComments?.push({ number, body });
      const id = fixture.nextCommentId ?? 1;
      fixture.nextCommentId = id + 1;
      const comment: ProviderComment = {
        id,
        body,
        createdAt: new Date(0).toISOString(),
        authorLogin: fixture.viewerLogin ?? 'fake-actor',
      };
      fixture.comments ??= {};
      fixture.comments[number] = [...(fixture.comments[number] ?? []), comment];
      return {
        id,
        htmlUrl: `https://example.invalid/issues/${number}#issuecomment-${id}`,
      };
    },

    getCollaboratorPermission(
      login: string,
    ): ProviderCollaboratorPermissionResult {
      return (
        fixture.collaboratorPermissions?.[login.trim().toLowerCase()] ?? {
          outcome: 'not-collaborator',
        }
      );
    },

    getChangeRequest(number: number): ProviderChangeRequestState | null {
      return fixture.changeRequests?.[number] ?? null;
    },

    getChangeRequestHeadSha(number: number): string {
      const sha = fixture.changeRequestHeadShas?.[number];
      if (sha === undefined) {
        throw new Error(`fake provider: no head SHA fixture for PR ${number}`);
      }
      return sha;
    },

    listRequiredChecks(number: number): ProviderRequiredCheck[] {
      return fixture.requiredChecks?.[number] ?? [];
    },

    listReviews(number: number): unknown[] {
      return fixture.reviews?.[number] ?? [];
    },

    listOpenChangeRequests(): ProviderChangeRequestSummary[] {
      return fixture.openChangeRequests ?? [];
    },

    listChangeRequestReviewThreads(
      number: number,
    ): { isResolved: boolean | null }[] {
      return fixture.reviewThreads?.[number] ?? [];
    },

    async getWorkItemForTraversalAsync(
      number: number,
    ): Promise<ProviderTraversalIssueLookup> {
      return (
        fixture.traversalIssueLookups?.[number] ?? { outcome: 'not-found' }
      );
    },

    async listWorkItemSubIssueNodesAsync(number: number): Promise<unknown[]> {
      return fixture.subIssueNodes?.[number] ?? [];
    },

    async listWorkItemCommentsWithRetryAsync(
      number: number,
    ): Promise<unknown[]> {
      return fixture.traversalComments?.[number] ?? [];
    },

    searchOpenWorkItems(): unknown[] {
      return fixture.searchResults ?? [];
    },
  };
}
