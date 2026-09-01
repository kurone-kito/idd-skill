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
  ProviderWorkItem,
  ProviderWorkItemSummary,
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
  pullRequestsClosingIssue?: Record<number, number[]>;
  issueBranchRefs?: string[];
  collaboratorPermissions?: Record<
    string,
    ProviderCollaboratorPermissionResult
  >;
  changeRequests?: Record<number, ProviderChangeRequestState>;
  requiredChecks?: Record<number, ProviderRequiredCheck[]>;
  reviews?: Record<number, unknown[]>;
  openChangeRequests?: ProviderChangeRequestSummary[];
  /** Every posted comment is appended here, in call order. */
  postedComments?: { number: number; body: string }[];
  /** Every closed work item is appended here, in call order. */
  closedWorkItems?: { number: number; reason: string }[];
  nextCommentId?: number;
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

    async getWorkItem(number: number): Promise<ProviderWorkItem | null> {
      return fixture.workItems?.[number] ?? null;
    },

    async listOpenWorkItems(): Promise<ProviderWorkItemSummary[]> {
      return Object.values(fixture.workItems ?? {})
        .filter((item) => item.state === 'OPEN')
        .map((item) => ({ number: item.number, title: item.title }));
    },

    async searchWorkItems(): Promise<ProviderWorkItemSummary[]> {
      return Object.values(fixture.workItems ?? {}).map((item) => ({
        number: item.number,
        title: item.title,
      }));
    },

    async getWorkItemTimeline(
      number: number,
    ): Promise<ProviderTimelineEvent[]> {
      return fixture.timelines?.[number] ?? [];
    },

    async closeWorkItem(number: number, reason: string): Promise<void> {
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

    async getConnectedPullRequestEventsSingle(
      number: number,
    ): Promise<ProviderConnectedPrEvent[]> {
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

    async getPullRequestsClosingIssue(number: number): Promise<number[]> {
      return fixture.pullRequestsClosingIssue?.[number] ?? [];
    },

    async listIssueBranchRefs(): Promise<string[]> {
      return fixture.issueBranchRefs ?? [];
    },

    async listWorkItemComments(number: number): Promise<ProviderComment[]> {
      return fixture.comments?.[number] ?? [];
    },

    async postWorkItemComment(
      number: number,
      body: string,
    ): Promise<ProviderPostedComment> {
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

    async getCollaboratorPermission(
      login: string,
    ): Promise<ProviderCollaboratorPermissionResult> {
      return (
        fixture.collaboratorPermissions?.[login.trim().toLowerCase()] ?? {
          outcome: 'not-collaborator',
        }
      );
    },

    async getChangeRequest(
      number: number,
    ): Promise<ProviderChangeRequestState | null> {
      return fixture.changeRequests?.[number] ?? null;
    },

    async listRequiredChecks(number: number): Promise<ProviderRequiredCheck[]> {
      return fixture.requiredChecks?.[number] ?? [];
    },

    async listReviews(number: number): Promise<unknown[]> {
      return fixture.reviews?.[number] ?? [];
    },

    async listOpenChangeRequests(): Promise<ProviderChangeRequestSummary[]> {
      return fixture.openChangeRequests ?? [];
    },
  };
}
