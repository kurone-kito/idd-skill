// idd-generated-from: src/scripts/provider-adapter-github.mts
//
// The scripts/provider-adapter-github.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// GitHub implementation of `provider-port.mts` (#2266). Every method here
// is a 1:1 transport swap for an existing call shape found in the 11 files
// this issue migrates -- see the issue's B2 plan for the research this is
// built from. `gh` invocation is an implementation detail of this module;
// domain helpers never see it.
import {
  GH_TEXT_LOOP_OPTIONS,
  ghApiJson,
  resolveViewerLogin as ghExecResolveViewerLogin,
  ghGraphql,
  ghText,
} from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';

function statusToCategory(status) {
  if (status === 401) return 'authentication';
  if (status === 403) return 'authorization';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status === 409) return 'conflict';
  if (status !== null && status >= 400 && status < 500) return 'validation';
  if (status !== null && status >= 500) return 'unavailable';
  return 'unknown';
}
/**
 * GitHub implementation of {@link ProviderPort}. `owner`/`repo` are resolved
 * once at construction (matching every migrated file's existing
 * `gh repo view` boilerplate) rather than re-resolved per call.
 */
export function createGithubProviderAdapter(owner, repo) {
  const repoPath = `repos/${owner}/${repo}`;
  return {
    resolveRepositoryLocator() {
      return { provider: 'github', owner, name: repo };
    },
    resolveViewerLogin() {
      return ghExecResolveViewerLogin();
    },
    resolveViewerLoginSafe() {
      try {
        const raw = ghText(['api', 'user', '--jq', '.login']);
        const normalized = raw.trim().toLowerCase();
        if (!normalized) {
          return { viewerLogin: '', viewerLoginUnavailable: true };
        }
        return { viewerLogin: normalized, viewerLoginUnavailable: false };
      } catch {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
    },
    async getWorkItem(number) {
      let data;
      try {
        data = ghApiJson(`${repoPath}/issues/${number}`);
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return null;
        }
        throw error;
      }
      const issue = data;
      if (!issue) {
        return null;
      }
      return {
        number: Number(issue.number ?? number),
        title: String(issue.title ?? ''),
        body: String(issue.body ?? ''),
        state: String(issue.state ?? '').toUpperCase(),
      };
    },
    async listOpenWorkItems() {
      const rows = ghApiJson(`${repoPath}/issues?state=open`, {
        paginate: true,
      });
      return rows
        .filter((row) => row.pull_request == null)
        .map((row) => ({
          number: Number(row.number),
          title: String(row.title ?? ''),
        }));
    },
    async searchWorkItems(query) {
      const result = ghApiJson(
        `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      );
      return (result.items ?? []).map((item) => ({
        number: Number(item.number),
        title: String(item.title ?? ''),
      }));
    },
    async getWorkItemTimeline(number) {
      return ghApiJson(`${repoPath}/issues/${number}/timeline`, {
        paginate: true,
        extraArgs: ['-H', 'Accept: application/vnd.github+json'],
      });
    },
    async closeWorkItem(number, reason) {
      ghText(
        [
          'issue',
          'close',
          String(number),
          '--repo',
          `${owner}/${repo}`,
          '--reason',
          reason,
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
    },
    getWorkItemClosingPullRequestsPage(number, after) {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      closedByPullRequestsReferences(first:50,after:$after,includeClosedPrs:false){
        nodes { state }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
      const parsed = ghGraphql(query, {
        owner,
        repo,
        number,
        after: after ?? undefined,
      });
      const connection =
        parsed.data?.repository?.issue?.closedByPullRequestsReferences;
      if (!connection) {
        throw new Error(
          'closedByPullRequestsReferences: connection is null/absent',
        );
      }
      return {
        nodes: (connection.nodes ?? []).map((node) => ({
          state: node.state === undefined ? undefined : String(node.state),
        })),
        hasNextPage: connection.pageInfo?.hasNextPage ?? false,
        endCursor: connection.pageInfo?.endCursor ?? null,
      };
    },
    async getConnectedPullRequestEventsSingle(number) {
      try {
        const parsed = JSON.parse(
          ghText([
            'api',
            'graphql',
            '-f',
            `query=query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){timelineItems(last:100,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){nodes{__typename ... on ConnectedEvent { subject { __typename ... on PullRequest { number state } } } ... on DisconnectedEvent { subject { __typename ... on PullRequest { number } } } }}}}}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `repo=${repo}`,
            '-F',
            `number=${number}`,
          ]),
        );
        const nodes = parsed?.data?.repository?.issue?.timelineItems?.nodes;
        return Array.isArray(nodes) ? nodes : [];
      } catch {
        return [];
      }
    },
    getConnectedPullRequestEventsPage(number, after) {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      timelineItems(first:50,after:$after,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){
        nodes {
          __typename
          ... on ConnectedEvent { subject { __typename ... on PullRequest { number state } } }
          ... on DisconnectedEvent { subject { __typename ... on PullRequest { number } } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
      const parsed = ghGraphql(query, {
        owner,
        repo,
        number,
        after: after ?? undefined,
      });
      const connection = parsed.data?.repository?.issue?.timelineItems;
      if (!connection) {
        throw new Error('timelineItems: connection is null/absent');
      }
      return {
        events: connection.nodes ?? [],
        hasNextPage: connection.pageInfo?.hasNextPage ?? false,
        endCursor: connection.pageInfo?.endCursor ?? null,
      };
    },
    async getPullRequestsClosingIssue(number) {
      // Uses `gh pr list`, not `gh api`, matching
      // discover-shared-file-overlap.mts's existing call shape exactly.
      const raw = ghText(
        [
          'pr',
          'list',
          '--repo',
          `${owner}/${repo}`,
          '--state',
          'open',
          '--limit',
          '100',
          '--json',
          'number,closingIssuesReferences',
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      const list = JSON.parse(raw || '[]');
      return list
        .filter((pr) =>
          (pr.closingIssuesReferences ?? []).some(
            (ref) => Number(ref.number) === number,
          ),
        )
        .map((pr) => Number(pr.number));
    },
    async listIssueBranchRefs() {
      const refs = ghApiJson(`${repoPath}/git/matching-refs/heads/issue/`, {
        paginate: true,
      });
      return refs.map((entry) => String(entry.ref ?? ''));
    },
    async listWorkItemComments(number) {
      const rows = ghApiJson(`${repoPath}/issues/${number}/comments`, {
        paginate: true,
      });
      return rows.map((row) => ({
        id: Number(row.id),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
    },
    async postWorkItemComment(number, body) {
      const out = ghText(
        [
          'api',
          '--method',
          'POST',
          `${repoPath}/issues/${number}/comments`,
          '--input',
          '-',
        ],
        { input: JSON.stringify({ body }) },
      );
      const parsed = JSON.parse(out);
      return { id: parsed.id, htmlUrl: parsed.html_url };
    },
    async getCollaboratorPermission(login) {
      const normalized = login.trim().toLowerCase();
      try {
        const raw = ghText(
          [
            'api',
            `${repoPath}/collaborators/${encodeURIComponent(normalized)}/permission`,
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const parsed = JSON.parse(raw);
        return {
          outcome: 'found',
          permission: String(parsed?.permission ?? '')
            .trim()
            .toLowerCase(),
          roleName: String(parsed?.role_name ?? '')
            .trim()
            .toLowerCase(),
        };
      } catch (error) {
        const status = deriveGhHttpStatus(error);
        if (status === 404) {
          return { outcome: 'not-collaborator' };
        }
        return {
          outcome: 'error',
          error: {
            category: statusToCategory(status),
            message: `collaborator permission lookup failed: ${status ?? 'unknown'}`,
            cause: error,
          },
        };
      }
    },
    async getChangeRequest(number) {
      try {
        const raw = ghText(
          [
            'pr',
            'view',
            String(number),
            '--repo',
            `${owner}/${repo}`,
            '--json',
            'mergeable,mergeStateStatus',
          ],
          GH_TEXT_LOOP_OPTIONS,
        );
        const parsed = JSON.parse(raw);
        return {
          mergeable: String(parsed.mergeable ?? ''),
          mergeStateStatus: String(parsed.mergeStateStatus ?? ''),
        };
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return null;
        }
        throw error;
      }
    },
    async listRequiredChecks(number) {
      const raw = ghText(
        [
          'pr',
          'checks',
          String(number),
          '--repo',
          `${owner}/${repo}`,
          '--required',
          '--json',
          'name,state,completedAt',
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        name: String(row.name ?? ''),
        state: String(row.state ?? ''),
        completedAt: row.completedAt ? String(row.completedAt) : null,
      }));
    },
    async listReviews(number) {
      return ghApiJson(`${repoPath}/pulls/${number}/reviews`, {
        paginate: true,
      });
    },
    async listOpenChangeRequests() {
      const raw = ghText(
        [
          'pr',
          'list',
          '--repo',
          `${owner}/${repo}`,
          '--state',
          'open',
          '--limit',
          '100',
          '--json',
          'number,title,body,url',
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        number: Number(row.number),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        url: String(row.url ?? ''),
      }));
    },
  };
}
/** Resolve the current repository's owner/name via `gh repo view` (the
 * boilerplate every one of the 11 migrated files already performs). */
export function resolveCurrentGithubRepository() {
  return {
    owner: ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_OPTIONS,
    ).trim(),
    repo: ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_OPTIONS,
    ).trim(),
  };
}
