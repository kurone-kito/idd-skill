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

import {
  PROVIDER_CAPABILITY_GROUPS,
  type ProviderCapabilityDeclaration,
  type ProviderRepositoryLocator,
} from './provider-contract.mts';
import type {
  ProviderChangeRequestAuthor,
  ProviderChangeRequestBranchAndChecks,
  ProviderChangeRequestConvergenceView,
  ProviderChangeRequestHeadShaAndAuthor,
  ProviderChangeRequestReadinessSnapshot,
  ProviderChangeRequestState,
  ProviderChangeRequestSummary,
  ProviderClosingPullRequestsPage,
  ProviderCollaboratorPermissionResult,
  ProviderComment,
  ProviderConnectedPrEvent,
  ProviderGovernanceReadOutcome,
  ProviderGraphqlComment,
  ProviderGraphqlReview,
  ProviderMergedChangeRequestMeta,
  ProviderMergedChangeRequestSummary,
  ProviderPort,
  ProviderPostedComment,
  ProviderRequiredCheck,
  ProviderReviewsWithHeadCommitDate,
  ProviderReviewThreadCommentIds,
  ProviderReviewThreadExtended,
  ProviderReviewThreadWithAuthorType,
  ProviderReviewThreadWithComments,
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

  // --- #2267 additions below. -------------------------------------------

  /** Backs {@link ProviderPort.getRepositoryDefaultBranch}. */
  repositoryDefaultBranch?: string | null;
  /** Backs {@link ProviderPort.resolveViewerAppSlugSafe}. */
  viewerAppSlug?: string;
  viewerAppSlugUnavailable?: boolean;
  /** Backs {@link ProviderPort.getRepositoryContentAtRef}, keyed by
   * `${owner}/${repo}/${path}@${ref}`; absent key means `null` (404). */
  repositoryContentAtRef?: Record<string, unknown>;
  /** Backs {@link ProviderPort.getRepositoryFileContentAtRef}, keyed by
   * `${repoRef}/${path}@${ref}`; absent key means `not-found`. */
  repositoryFileContentAtRef?: Record<string, string>;
  /** Backs {@link ProviderPort.getTeamMembershipStateSafe}, keyed by
   * `${org}/${teamSlug}/${login}`; absent key means `''`. */
  teamMembershipStates?: Record<string, string>;
  /** Backs {@link ProviderPort.getChangeRequestHeadShaAndAuthor}. */
  changeRequestHeadShaAndAuthor?: Record<
    number,
    ProviderChangeRequestHeadShaAndAuthor
  >;
  /** Backs {@link ProviderPort.getChangeRequestConvergenceView}. */
  changeRequestConvergenceViews?: Record<
    number,
    ProviderChangeRequestConvergenceView
  >;
  /** Backs {@link ProviderPort.getChangeRequestReadinessSnapshot}. */
  changeRequestReadinessSnapshots?: Record<
    number,
    ProviderChangeRequestReadinessSnapshot
  >;
  /** Backs {@link ProviderPort.getChangeRequestBranchAndChecks}. */
  changeRequestBranchAndChecks?: Record<
    number,
    ProviderChangeRequestBranchAndChecks
  >;
  /** Backs {@link ProviderPort.getChangeRequestHeadRef}. */
  changeRequestHeadRefs?: Record<number, string>;
  /** Backs {@link ProviderPort.listMergedChangeRequests}. */
  mergedChangeRequests?: ProviderMergedChangeRequestSummary[];
  /** Backs {@link ProviderPort.getMergedChangeRequestMeta}; absent key means `null`. */
  mergedChangeRequestMeta?: Record<number, ProviderMergedChangeRequestMeta>;
  /** Backs {@link ProviderPort.listChangeRequestChecks} (ALL checks, not just required). */
  allChecks?: Record<number, ProviderRequiredCheck[]>;
  /** Backs {@link ProviderPort.getChangeRequestRequestedReviewerLogins}. */
  requestedReviewerLogins?: Record<number, string[]>;
  /** Backs {@link ProviderPort.getChangeRequestRequestedReviewerLoginsGraphql}; absent key means `null`. */
  requestedReviewerLoginsGraphql?: Record<number, string[]>;
  /** Backs {@link ProviderPort.listChangeRequestChangedFiles}. */
  changedFiles?: Record<number, string[]>;
  /** Backs {@link ProviderPort.listChangeRequestCommits}. */
  changeRequestCommits?: Record<number, unknown[]>;
  /** Backs {@link ProviderPort.listChangeRequestReviewThreadsWithComments}. */
  reviewThreadsWithComments?: Record<
    number,
    ProviderReviewThreadWithComments[]
  >;
  /** Backs {@link ProviderPort.listChangeRequestReviewThreadsExtended}. */
  reviewThreadsExtended?: Record<number, ProviderReviewThreadExtended[]>;
  /** Backs {@link ProviderPort.listChangeRequestReviewThreadCommentIds}. */
  reviewThreadCommentIds?: Record<number, ProviderReviewThreadCommentIds[]>;
  /** Backs {@link ProviderPort.listChangeRequestGraphqlComments}. */
  changeRequestGraphqlComments?: Record<number, ProviderGraphqlComment[]>;
  /** Backs {@link ProviderPort.listChangeRequestGraphqlReviews}. */
  changeRequestGraphqlReviews?: Record<number, ProviderGraphqlReview[]>;
  /** Backs {@link ProviderPort.listBranchRules}, keyed by `${owner}/${repo}/${ref}`;
   * absent key means `{outcome:'not-found'}`. */
  branchRules?: Record<string, unknown[]>;
  /** Backs {@link ProviderPort.getBranchProtection}, keyed by `${owner}/${repo}/${ref}`;
   * absent key means `{outcome:'not-found'}`. */
  branchProtection?: Record<string, unknown>;
  /** Backs {@link ProviderPort.getRepositoryRulesetDetail}, keyed by the
   * resolved absolute path passed in; absent key means `{outcome:'not-found'}`. */
  rulesetDetails?: Record<string, unknown>;
  /** Backs {@link ProviderPort.getWorkflowRun}, keyed by
   * `${owner}/${repo}/${runId}`; an absent key throws (matches the
   * adapter's own no-catch, throw-on-failure contract). */
  workflowRuns?: Record<string, unknown>;
  /** Backs {@link ProviderPort.listWorkflowRuns}, keyed by `${owner}/${repo}/${workflowName}`. */
  workflowRunLists?: Record<
    string,
    {
      id: string;
      conclusion: string | null;
      status: string;
      createdAt: string;
    }[]
  >;
  /** Backs {@link ProviderPort.getChangeRequestHeadShaAtRepo}, keyed by
   * `${owner}/${repo}/${number}`; an absent key throws (matches the adapter's
   * own no-catch, throw-on-failure contract). */
  changeRequestHeadShasAtRepo?: Record<string, string>;
  /** Backs {@link ProviderPort.getChangeRequestAtRepo}, keyed by
   * `${owner}/${repo}/${number}`. */
  changeRequestsAtRepo?: Record<string, ProviderChangeRequestState>;
  /** Every merge call (ambient or cross-repo, admin or not) is appended
   * here, in call order. */
  mergedChangeRequestCalls?: {
    owner: string;
    repo: string;
    number: number;
    headSha: string;
    admin: boolean;
  }[];
  /** Every posted review-comment reply is appended here, in call order. */
  postedReviewCommentReplies?: {
    number: number;
    commentId: number;
    body: string;
  }[];
  nextReviewCommentReplyId?: number;
  /** Every resolved review-thread id is appended here, in call order. */
  resolvedReviewThreadIds?: string[];
  /** Thread ids in this set fail {@link ProviderPort.resolveChangeRequestReviewThread}
   * (simulates GitHub not confirming `isResolved`). */
  unresolvableReviewThreadIds?: Set<string>;
  /** Backs {@link ProviderPort.getChangeRequestReviewsWithHeadCommitDate}. */
  reviewsWithHeadCommitDate?: Record<number, ProviderReviewsWithHeadCommitDate>;
  /** Backs {@link ProviderPort.getChangeRequestAuthor}; absent key means `null`. */
  changeRequestAuthors?: Record<number, ProviderChangeRequestAuthor>;
  /** Backs {@link ProviderPort.listChangeRequestReviewThreadsWithAuthorType}. */
  reviewThreadsWithAuthorType?: Record<
    number,
    ProviderReviewThreadWithAuthorType[]
  >;
  /** Backs {@link ProviderPort.listCapabilityDeclarations}. Defaults to
   * every capability group `supported: true` (the GitHub adapter's own
   * posture) so a test only overrides the one group it's exercising, e.g.
   * an `advisory-review: { supported: false }` override to simulate a
   * non-GitHub provider without an advisory reviewer. */
  capabilityDeclarations?: ProviderCapabilityDeclaration[];
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
      const item = fixture.workItems?.[number];
      if (!item) {
        return null;
      }
      // `fixture.workItems` stores REST's raw casing as its one canonical
      // form -- listOpenWorkItems/searchWorkItems pass it through
      // unchanged, and this method uppercases on read to match
      // getWorkItem's own documented uppercase contract, mirroring the
      // real adapter (Copilot review, #2400).
      return { ...item, state: item.state.toUpperCase() };
    },

    listOpenWorkItems(): ProviderWorkItem[] {
      // Port contract: raw REST lowercase state ('open'/'closed'), unlike
      // getWorkItem's uppercased 'OPEN' -- see provider-port.mts's doc
      // comment on this method (Copilot review, #2400).
      return Object.values(fixture.workItems ?? {}).filter(
        (item) => item.state === 'open',
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
        // Lowercase, matching fixture.workItems's one canonical raw-REST
        // casing -- getWorkItem uppercases on read regardless, but
        // listOpenWorkItems/searchWorkItems pass this through unchanged,
        // so a stored uppercase value would drift from their contract on
        // a later read of the same fixture (Copilot review, #2400).
        item.state = 'closed';
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
        updatedAt: new Date(0).toISOString(),
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

    // --- #2267 additions below. -------------------------------------------

    getRepositoryDefaultBranch(
      _defaultBranchOwner: string,
      _defaultBranchRepo: string,
    ): string | null {
      // Accepts owner/repo to match the port's declared arity (Copilot
      // review, PR #2429: an unaccepted parameter is silently hidden by
      // structural typing) -- unused because every fixture in this file
      // represents a single ambient repo, and this method's one real call
      // site (pre-merge-readiness.mts) always passes that same repo back.
      return fixture.repositoryDefaultBranch ?? null;
    },

    resolveViewerAppSlugSafe(): { appSlug: string; unavailable: boolean } {
      // Mirrors the GitHub adapter's own raw.trim() on the CLI output,
      // for the same reason as resolveViewerLoginSafeQuiet's normalization
      // above.
      const trimmed = fixture.viewerAppSlug?.trim() ?? '';
      if (fixture.viewerAppSlugUnavailable || !trimmed) {
        return { appSlug: '', unavailable: true };
      }
      return { appSlug: trimmed, unavailable: false };
    },

    resolveViewerLoginSafeQuiet(): {
      viewerLogin: string;
      viewerLoginUnavailable: boolean;
    } {
      // Mirrors the GitHub adapter's own trim().toLowerCase() normalization
      // (Copilot review, PR #2429) so a fixture login differing only in
      // case/whitespace does not diverge fake-provider tests from
      // production behavior.
      const normalized = fixture.viewerLogin?.trim().toLowerCase() ?? '';
      if (fixture.viewerLoginUnavailable || !normalized) {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
      return { viewerLogin: normalized, viewerLoginUnavailable: false };
    },

    getRepositoryContentAtRef(
      contentOwner: string,
      contentRepo: string,
      path: string,
      ref: string,
    ): unknown | null {
      const key = `${contentOwner}/${contentRepo}/${path}@${ref}`;
      return fixture.repositoryContentAtRef?.[key] ?? null;
    },

    getRepositoryFileContentAtRef(
      repoRef: string,
      path: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<string> {
      const key = `${repoRef}/${path}@${ref}`;
      const value = fixture.repositoryFileContentAtRef?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },

    getTeamMembershipStateSafe(
      org: string,
      teamSlug: string,
      login: string,
    ): string {
      const key = `${org}/${teamSlug}/${login}`;
      return fixture.teamMembershipStates?.[key] ?? '';
    },

    getChangeRequestHeadShaAndAuthor(
      number: number,
    ): ProviderChangeRequestHeadShaAndAuthor {
      const value = fixture.changeRequestHeadShaAndAuthor?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no headSha/author fixture for PR ${number}`,
        );
      }
      return value;
    },

    getChangeRequestConvergenceView(
      number: number,
    ): ProviderChangeRequestConvergenceView {
      const value = fixture.changeRequestConvergenceViews?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no convergence-view fixture for PR ${number}`,
        );
      }
      return value;
    },

    getChangeRequestReadinessSnapshot(
      number: number,
    ): ProviderChangeRequestReadinessSnapshot {
      const value = fixture.changeRequestReadinessSnapshots?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no readiness-snapshot fixture for PR ${number}`,
        );
      }
      return value;
    },

    getChangeRequestBranchAndChecks(
      number: number,
    ): ProviderChangeRequestBranchAndChecks {
      const value = fixture.changeRequestBranchAndChecks?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no branch-and-checks fixture for PR ${number}`,
        );
      }
      return value;
    },

    getChangeRequestHeadRef(number: number): string {
      const value = fixture.changeRequestHeadRefs?.[number];
      if (value === undefined) {
        throw new Error(`fake provider: no head-ref fixture for PR ${number}`);
      }
      return value;
    },

    listMergedChangeRequests(
      limit: number,
      sinceDate: string | null,
    ): ProviderMergedChangeRequestSummary[] {
      // Honors both parameters the GitHub adapter's `gh pr list --limit
      // --search merged:>=date` call applies (Copilot review, PR #2429),
      // so a collection-wiring test cannot pass on unrealistic behavior --
      // more rows than requested, or an unfiltered date range.
      const rows = fixture.mergedChangeRequests ?? [];
      const filtered = sinceDate
        ? rows.filter((row) => row.mergedAt >= sinceDate)
        : rows;
      return filtered.slice(0, limit);
    },

    getMergedChangeRequestMeta(
      number: number,
    ): ProviderMergedChangeRequestMeta | null {
      return fixture.mergedChangeRequestMeta?.[number] ?? null;
    },

    listChangeRequestChecks(number: number): ProviderRequiredCheck[] {
      return fixture.allChecks?.[number] ?? [];
    },

    getChangeRequestRequestedReviewerLogins(number: number): string[] {
      return fixture.requestedReviewerLogins?.[number] ?? [];
    },

    getChangeRequestRequestedReviewerLoginsGraphql(
      number: number,
    ): string[] | null {
      return fixture.requestedReviewerLoginsGraphql?.[number] ?? null;
    },

    listChangeRequestChangedFiles(number: number): string[] {
      return fixture.changedFiles?.[number] ?? [];
    },

    listChangeRequestCommits(number: number): unknown[] {
      return fixture.changeRequestCommits?.[number] ?? [];
    },

    listChangeRequestReviewThreadsWithComments(
      number: number,
    ): ProviderReviewThreadWithComments[] {
      return fixture.reviewThreadsWithComments?.[number] ?? [];
    },

    listChangeRequestReviewThreadsExtended(
      number: number,
    ): ProviderReviewThreadExtended[] {
      return fixture.reviewThreadsExtended?.[number] ?? [];
    },

    listChangeRequestReviewThreadCommentIds(
      number: number,
    ): ProviderReviewThreadCommentIds[] {
      return fixture.reviewThreadCommentIds?.[number] ?? [];
    },

    listChangeRequestGraphqlComments(number: number): ProviderGraphqlComment[] {
      return fixture.changeRequestGraphqlComments?.[number] ?? [];
    },

    listChangeRequestGraphqlReviews(number: number): ProviderGraphqlReview[] {
      return fixture.changeRequestGraphqlReviews?.[number] ?? [];
    },

    listBranchRules(
      rulesOwner: string,
      rulesRepo: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<unknown[]> {
      const key = `${rulesOwner}/${rulesRepo}/${ref}`;
      const value = fixture.branchRules?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },

    getBranchProtection(
      protectionOwner: string,
      protectionRepo: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<unknown> {
      const key = `${protectionOwner}/${protectionRepo}/${ref}`;
      const value = fixture.branchProtection?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },

    getRepositoryRulesetDetail(
      path: string,
    ): ProviderGovernanceReadOutcome<unknown> {
      const value = fixture.rulesetDetails?.[path];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },

    getWorkflowRun(
      runOwner: string,
      runRepo: string,
      runId: string | number,
    ): unknown {
      // Throws on a missing fixture, matching the GitHub adapter's own
      // no-catch `deps.ghText` call (Copilot review, PR #2429) -- a fake
      // adapter returning null here can both mask a missing fixture and
      // produce a confusing downstream TypeError instead of failing
      // closed like production.
      const key = `${runOwner}/${runRepo}/${runId}`;
      const value = fixture.workflowRuns?.[key];
      if (value === undefined) {
        throw new Error(`fake provider: no workflow-run fixture for ${key}`);
      }
      return value;
    },

    listWorkflowRuns(
      runsOwner: string,
      runsRepo: string,
      workflowName: string,
      limit: number,
    ): {
      id: string;
      conclusion: string | null;
      status: string;
      createdAt: string;
    }[] {
      // Honors `limit`, matching the GitHub adapter's own `gh run list
      // --limit N` call (Copilot review, PR #2429) -- an ignored limit let
      // a collection-wiring test pass against an unrealistically large
      // sibling sweep.
      const key = `${runsOwner}/${runsRepo}/${workflowName}`;
      return (fixture.workflowRunLists?.[key] ?? []).slice(0, limit);
    },

    getChangeRequestHeadShaAtRepo(
      atRepoOwner: string,
      atRepoRepo: string,
      number: number,
    ): string {
      const key = `${atRepoOwner}/${atRepoRepo}/${number}`;
      const sha = fixture.changeRequestHeadShasAtRepo?.[key];
      if (sha === undefined) {
        throw new Error(
          `fake provider: no cross-repo head SHA fixture for ${key}`,
        );
      }
      return sha;
    },

    getChangeRequestAtRepo(
      atRepoOwner: string,
      atRepoRepo: string,
      number: number,
    ): ProviderChangeRequestState | null {
      const key = `${atRepoOwner}/${atRepoRepo}/${number}`;
      return fixture.changeRequestsAtRepo?.[key] ?? null;
    },

    mergeChangeRequestAtRepo(
      mergeOwner: string,
      mergeRepo: string,
      number: number,
      headSha: string,
    ): string {
      fixture.mergedChangeRequestCalls ??= [];
      fixture.mergedChangeRequestCalls.push({
        owner: mergeOwner,
        repo: mergeRepo,
        number,
        headSha,
        admin: false,
      });
      return `fake merge commit for ${mergeOwner}/${mergeRepo}#${number}`;
    },

    mergeChangeRequestAdminAtRepo(
      mergeOwner: string,
      mergeRepo: string,
      number: number,
      headSha: string,
    ): string {
      fixture.mergedChangeRequestCalls ??= [];
      fixture.mergedChangeRequestCalls.push({
        owner: mergeOwner,
        repo: mergeRepo,
        number,
        headSha,
        admin: true,
      });
      return `fake admin merge commit for ${mergeOwner}/${mergeRepo}#${number}`;
    },

    mergeChangeRequest(number: number, headSha: string): string {
      const locator = fixture.locator ?? {
        provider: 'github' as const,
        owner: 'fake-owner',
        name: 'fake-repo',
      };
      fixture.mergedChangeRequestCalls ??= [];
      fixture.mergedChangeRequestCalls.push({
        owner: locator.owner,
        repo: locator.name,
        number,
        headSha,
        admin: false,
      });
      return `fake merge commit for ${locator.owner}/${locator.name}#${number}`;
    },

    mergeChangeRequestAdmin(number: number, headSha: string): string {
      const locator = fixture.locator ?? {
        provider: 'github' as const,
        owner: 'fake-owner',
        name: 'fake-repo',
      };
      fixture.mergedChangeRequestCalls ??= [];
      fixture.mergedChangeRequestCalls.push({
        owner: locator.owner,
        repo: locator.name,
        number,
        headSha,
        admin: true,
      });
      return `fake admin merge commit for ${locator.owner}/${locator.name}#${number}`;
    },

    postReviewCommentReply(
      number: number,
      commentId: number,
      body: string,
    ): { id: number } {
      fixture.postedReviewCommentReplies ??= [];
      fixture.postedReviewCommentReplies.push({ number, commentId, body });
      const id = fixture.nextReviewCommentReplyId ?? 1;
      fixture.nextReviewCommentReplyId = id + 1;
      return { id };
    },

    getChangeRequestAuthor(number: number): ProviderChangeRequestAuthor | null {
      return fixture.changeRequestAuthors?.[number] ?? null;
    },

    listChangeRequestReviewThreadsWithAuthorType(
      number: number,
    ): ProviderReviewThreadWithAuthorType[] {
      return fixture.reviewThreadsWithAuthorType?.[number] ?? [];
    },

    getChangeRequestReviewsWithHeadCommitDate(
      number: number,
    ): ProviderReviewsWithHeadCommitDate {
      // Throws on a missing fixture, matching the GitHub adapter's own
      // no-catch GraphQL call and this file's sibling PR-view methods
      // (Copilot review, PR #2429) -- review-clause.mts's own caller has
      // no try/catch around this call, so a silent empty default here
      // would hide a missing fixture instead of failing closed.
      const value = fixture.reviewsWithHeadCommitDate?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no reviews/head-commit-date fixture for PR ${number}`,
        );
      }
      return value;
    },

    resolveChangeRequestReviewThread(threadId: string): void {
      if (fixture.unresolvableReviewThreadIds?.has(threadId)) {
        throw new Error(
          `fake provider: GitHub did not confirm thread ${threadId} as resolved`,
        );
      }
      fixture.resolvedReviewThreadIds ??= [];
      fixture.resolvedReviewThreadIds.push(threadId);
    },

    listCapabilityDeclarations(): ProviderCapabilityDeclaration[] {
      return (
        fixture.capabilityDeclarations ??
        PROVIDER_CAPABILITY_GROUPS.map((group) => ({
          group,
          requirement: group === 'advisory-review' ? 'optional' : 'required',
          supported: true,
        }))
      );
    },
  };
}
