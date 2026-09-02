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
        // Lowercase, matching fixture.workItems's one canonical raw-REST
        // casing -- getWorkItem uppercases on read regardless, but
        // listOpenWorkItems/searchWorkItems pass this through unchanged,
        // so a stored uppercase value would drift from their contract on
        // a later read of the same fixture (Copilot review, #2400).
        item.state = 'closed';
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
    // --- #2267 additions below. -------------------------------------------
    getRepositoryDefaultBranch() {
      return fixture.repositoryDefaultBranch ?? null;
    },
    resolveViewerAppSlugSafe() {
      if (fixture.viewerAppSlugUnavailable || !fixture.viewerAppSlug) {
        return { appSlug: '', unavailable: true };
      }
      return { appSlug: fixture.viewerAppSlug, unavailable: false };
    },
    resolveViewerLoginSafeQuiet() {
      if (fixture.viewerLoginUnavailable || !fixture.viewerLogin) {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
      return {
        viewerLogin: fixture.viewerLogin,
        viewerLoginUnavailable: false,
      };
    },
    getRepositoryContentAtRef(contentOwner, contentRepo, path, ref) {
      const key = `${contentOwner}/${contentRepo}/${path}@${ref}`;
      return fixture.repositoryContentAtRef?.[key] ?? null;
    },
    getRepositoryFileContentAtRef(repoRef, path, ref) {
      const key = `${repoRef}/${path}@${ref}`;
      const value = fixture.repositoryFileContentAtRef?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },
    getTeamMembershipStateSafe(org, teamSlug, login) {
      const key = `${org}/${teamSlug}/${login}`;
      return fixture.teamMembershipStates?.[key] ?? '';
    },
    getChangeRequestHeadShaAndAuthor(number) {
      const value = fixture.changeRequestHeadShaAndAuthor?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no headSha/author fixture for PR ${number}`,
        );
      }
      return value;
    },
    getChangeRequestConvergenceView(number) {
      const value = fixture.changeRequestConvergenceViews?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no convergence-view fixture for PR ${number}`,
        );
      }
      return value;
    },
    getChangeRequestReadinessSnapshot(number) {
      const value = fixture.changeRequestReadinessSnapshots?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no readiness-snapshot fixture for PR ${number}`,
        );
      }
      return value;
    },
    getChangeRequestBranchAndChecks(number) {
      const value = fixture.changeRequestBranchAndChecks?.[number];
      if (!value) {
        throw new Error(
          `fake provider: no branch-and-checks fixture for PR ${number}`,
        );
      }
      return value;
    },
    getChangeRequestHeadRef(number) {
      const value = fixture.changeRequestHeadRefs?.[number];
      if (value === undefined) {
        throw new Error(`fake provider: no head-ref fixture for PR ${number}`);
      }
      return value;
    },
    listMergedChangeRequests() {
      return fixture.mergedChangeRequests ?? [];
    },
    getMergedChangeRequestMeta(number) {
      return fixture.mergedChangeRequestMeta?.[number] ?? null;
    },
    listChangeRequestChecks(number) {
      return fixture.allChecks?.[number] ?? [];
    },
    getChangeRequestRequestedReviewerLogins(number) {
      return fixture.requestedReviewerLogins?.[number] ?? [];
    },
    getChangeRequestRequestedReviewerLoginsGraphql(number) {
      return fixture.requestedReviewerLoginsGraphql?.[number] ?? null;
    },
    listChangeRequestChangedFiles(number) {
      return fixture.changedFiles?.[number] ?? [];
    },
    listChangeRequestCommits(number) {
      return fixture.changeRequestCommits?.[number] ?? [];
    },
    listChangeRequestReviewThreadsWithComments(number) {
      return fixture.reviewThreadsWithComments?.[number] ?? [];
    },
    listChangeRequestReviewThreadsExtended(number) {
      return fixture.reviewThreadsExtended?.[number] ?? [];
    },
    listChangeRequestReviewThreadCommentIds(number) {
      return fixture.reviewThreadCommentIds?.[number] ?? [];
    },
    listChangeRequestGraphqlComments(number) {
      return fixture.changeRequestGraphqlComments?.[number] ?? [];
    },
    listChangeRequestGraphqlReviews(number) {
      return fixture.changeRequestGraphqlReviews?.[number] ?? [];
    },
    listBranchRules(rulesOwner, rulesRepo, ref) {
      const key = `${rulesOwner}/${rulesRepo}/${ref}`;
      const value = fixture.branchRules?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },
    getBranchProtection(protectionOwner, protectionRepo, ref) {
      const key = `${protectionOwner}/${protectionRepo}/${ref}`;
      const value = fixture.branchProtection?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },
    getRepositoryRulesetDetail(rulesetOwner, rulesetRepo, rulesetId) {
      const key = `${rulesetOwner}/${rulesetRepo}/${rulesetId}`;
      const value = fixture.rulesetDetails?.[key];
      return value === undefined
        ? { outcome: 'not-found' }
        : { outcome: 'ok', value };
    },
    getWorkflowRun(runOwner, runRepo, runId) {
      const key = `${runOwner}/${runRepo}/${runId}`;
      return fixture.workflowRuns?.[key] ?? null;
    },
    listWorkflowRuns(runsOwner, runsRepo, workflowName) {
      const key = `${runsOwner}/${runsRepo}/${workflowName}`;
      return fixture.workflowRunLists?.[key] ?? [];
    },
    getChangeRequestHeadShaAtRepo(atRepoOwner, atRepoRepo, number) {
      const key = `${atRepoOwner}/${atRepoRepo}/${number}`;
      const sha = fixture.changeRequestHeadShasAtRepo?.[key];
      if (sha === undefined) {
        throw new Error(
          `fake provider: no cross-repo head SHA fixture for ${key}`,
        );
      }
      return sha;
    },
    getChangeRequestAtRepo(atRepoOwner, atRepoRepo, number) {
      const key = `${atRepoOwner}/${atRepoRepo}/${number}`;
      return fixture.changeRequestsAtRepo?.[key] ?? null;
    },
    mergeChangeRequestAtRepo(mergeOwner, mergeRepo, number, headSha) {
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
    mergeChangeRequestAdminAtRepo(mergeOwner, mergeRepo, number, headSha) {
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
    mergeChangeRequest(number, headSha) {
      const locator = fixture.locator ?? {
        provider: 'github',
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
    mergeChangeRequestAdmin(number, headSha) {
      const locator = fixture.locator ?? {
        provider: 'github',
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
    postReviewCommentReply(number, commentId, body) {
      fixture.postedReviewCommentReplies ??= [];
      fixture.postedReviewCommentReplies.push({ number, commentId, body });
      const id = fixture.nextReviewCommentReplyId ?? 1;
      fixture.nextReviewCommentReplyId = id + 1;
      return { id };
    },
    getChangeRequestReviewsWithHeadCommitDate(number) {
      return (
        fixture.reviewsWithHeadCommitDate?.[number] ?? {
          reviews: [],
          headCommittedAt: '',
        }
      );
    },
    resolveChangeRequestReviewThread(threadId) {
      if (fixture.unresolvableReviewThreadIds?.has(threadId)) {
        throw new Error(
          `fake provider: GitHub did not confirm thread ${threadId} as resolved`,
        );
      }
      fixture.resolvedReviewThreadIds ??= [];
      fixture.resolvedReviewThreadIds.push(threadId);
    },
  };
}
