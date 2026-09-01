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
export function createFakeProviderAdapter(fixture) {
  fixture.postedComments ??= [];
  fixture.closedWorkItems ??= [];
  fixture.nextCommentId ??= 1;
  // Per-instance pagination-call counters: each `createFakeProviderAdapter`
  // call gets independent state, so parallel/repeated tests never leak
  // page-cursor progress into one another the way module-level state would.
  const closingPageCallIndex = {};
  const connectedPageCallIndex = {};
  return {
    resolveRepositoryLocator() {
      return (
        fixture.locator ?? {
          provider: 'github',
          owner: 'fake-owner',
          name: 'fake-repo',
        }
      );
    },
    resolveViewerLogin() {
      if (fixture.viewerLoginUnavailable || !fixture.viewerLogin) {
        throw new Error('fake provider: viewer login unavailable');
      }
      return fixture.viewerLogin;
    },
    resolveViewerLoginSafe() {
      if (fixture.viewerLoginUnavailable || !fixture.viewerLogin) {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
      return {
        viewerLogin: fixture.viewerLogin,
        viewerLoginUnavailable: false,
      };
    },
    getWorkItem(number) {
      return fixture.workItems?.[number] ?? null;
    },
    listOpenWorkItems() {
      // Port contract: raw REST lowercase state ('open'/'closed'), unlike
      // getWorkItem's uppercased 'OPEN' -- see provider-port.mts's doc
      // comment on this method (Copilot review, #2400).
      return Object.values(fixture.workItems ?? {}).filter(
        (item) => item.state === 'open',
      );
    },
    searchWorkItems() {
      return Object.values(fixture.workItems ?? {});
    },
    getWorkItemTimeline(number) {
      return fixture.timelines?.[number] ?? [];
    },
    getWorkItemState(number) {
      return fixture.issueStates?.[number] ?? null;
    },
    closeWorkItem(number, reason) {
      fixture.closedWorkItems?.push({ number, reason });
      const item = fixture.workItems?.[number];
      if (item) {
        item.state = 'CLOSED';
      }
    },
    getWorkItemClosingPullRequestsPage(number) {
      const pages = fixture.closingPullRequestPages?.[number] ?? [];
      const index = closingPageCallIndex[number] ?? 0;
      closingPageCallIndex[number] = index + 1;
      return pages[index] ?? { nodes: [], hasNextPage: false, endCursor: null };
    },
    getConnectedPullRequestEventsSingle(number) {
      return fixture.connectedPrEventsSingle?.[number] ?? [];
    },
    getConnectedPullRequestEventsPage(number) {
      const pages = fixture.connectedPrEventPages?.[number] ?? [];
      const index = connectedPageCallIndex[number] ?? 0;
      connectedPageCallIndex[number] = index + 1;
      return (
        pages[index] ?? { events: [], hasNextPage: false, endCursor: null }
      );
    },
    listIssueNumbersClosedByOpenChangeRequests() {
      return fixture.issueNumbersClosedByOpenChangeRequests ?? [];
    },
    listIssueBranchRefs() {
      return fixture.issueBranchRefs ?? [];
    },
    listWorkItemComments(number) {
      return fixture.comments?.[number] ?? [];
    },
    postWorkItemComment(number, body) {
      fixture.postedComments?.push({ number, body });
      const id = fixture.nextCommentId ?? 1;
      fixture.nextCommentId = id + 1;
      const comment = {
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
    getCollaboratorPermission(login) {
      return (
        fixture.collaboratorPermissions?.[login.trim().toLowerCase()] ?? {
          outcome: 'not-collaborator',
        }
      );
    },
    getChangeRequest(number) {
      return fixture.changeRequests?.[number] ?? null;
    },
    getChangeRequestHeadSha(number) {
      const sha = fixture.changeRequestHeadShas?.[number];
      if (sha === undefined) {
        throw new Error(`fake provider: no head SHA fixture for PR ${number}`);
      }
      return sha;
    },
    listRequiredChecks(number) {
      return fixture.requiredChecks?.[number] ?? [];
    },
    listReviews(number) {
      return fixture.reviews?.[number] ?? [];
    },
    listOpenChangeRequests() {
      return fixture.openChangeRequests ?? [];
    },
    listChangeRequestReviewThreads(number) {
      return fixture.reviewThreads?.[number] ?? [];
    },
    async getWorkItemForTraversalAsync(number) {
      return (
        fixture.traversalIssueLookups?.[number] ?? { outcome: 'not-found' }
      );
    },
    async listWorkItemSubIssueNodesAsync(number) {
      return fixture.subIssueNodes?.[number] ?? [];
    },
    async listWorkItemCommentsWithRetryAsync(number) {
      return fixture.traversalComments?.[number] ?? [];
    },
    searchOpenWorkItems() {
      return fixture.searchResults ?? [];
    },
  };
}
