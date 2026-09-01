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
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghApiJson,
  resolveViewerLogin as ghExecResolveViewerLogin,
  ghText,
} from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import type {
  ProviderErrorCategory,
  ProviderRepositoryLocator,
} from './provider-contract.mts';
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
} from './provider-port.mts';

/** Raw REST issue-payload fields this adapter reads, GitHub-shaped. */
interface RawIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  labels?: unknown;
  url?: unknown;
  html_url?: unknown;
  milestone?: unknown;
  user?: unknown;
  author_association?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
}

function statusToCategory(status: number | null): ProviderErrorCategory {
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
 * Transport primitives {@link createGithubProviderAdapter} calls, injectable
 * so a unit test can assert the exact `gh` command/API argument shape each
 * port method builds without spawning a real `gh` process (AC: "GitHub
 * adapter tests cover the existing command/API argument and response
 * shapes"). Defaults to the real `gh-exec.mts` functions.
 */
export interface GithubProviderAdapterDeps {
  ghText: typeof ghText;
  ghApiJson: typeof ghApiJson;
  resolveViewerLogin: typeof ghExecResolveViewerLogin;
}

const DEFAULT_DEPS: GithubProviderAdapterDeps = {
  ghText,
  ghApiJson,
  resolveViewerLogin: ghExecResolveViewerLogin,
};

/**
 * GitHub implementation of {@link ProviderPort}. `owner`/`repo` are resolved
 * once at construction (matching every migrated file's existing
 * `gh repo view` boilerplate) rather than re-resolved per call.
 */
export function createGithubProviderAdapter(
  owner: string,
  repo: string,
  deps: GithubProviderAdapterDeps = DEFAULT_DEPS,
): ProviderPort {
  const repoPath = `repos/${owner}/${repo}`;

  return {
    resolveRepositoryLocator(): ProviderRepositoryLocator {
      return { provider: 'github', owner, name: repo };
    },

    resolveViewerLogin(): string {
      return deps.resolveViewerLogin(GH_TEXT_LOOP_TIMEOUT_OPTIONS);
    },

    resolveViewerLoginSafe(): {
      viewerLogin: string;
      viewerLoginUnavailable: boolean;
    } {
      try {
        const raw = deps.ghText(['api', 'user', '--jq', '.login']);
        const normalized = raw.trim().toLowerCase();
        if (!normalized) {
          return { viewerLogin: '', viewerLoginUnavailable: true };
        }
        return { viewerLogin: normalized, viewerLoginUnavailable: false };
      } catch {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
    },

    getWorkItem(number: number): ProviderWorkItem | null {
      let data: unknown;
      try {
        data = deps.ghApiJson(`${repoPath}/issues/${number}`);
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return null;
        }
        throw error;
      }
      const issue = data as RawIssue | null;
      if (!issue) {
        return null;
      }
      return {
        number: Number(issue.number ?? number),
        title: String(issue.title ?? ''),
        body: String(issue.body ?? ''),
        state: String(issue.state ?? '').toUpperCase(),
        labels: issue.labels,
        url: issue.url === undefined ? undefined : String(issue.url),
        htmlUrl:
          issue.html_url === undefined ? undefined : String(issue.html_url),
        milestone: issue.milestone,
        user: issue.user,
        authorAssociation:
          issue.author_association === undefined
            ? undefined
            : String(issue.author_association),
        createdAt:
          issue.created_at === undefined ? undefined : String(issue.created_at),
        updatedAt:
          issue.updated_at === undefined ? undefined : String(issue.updated_at),
      };
    },

    listOpenWorkItems(): ProviderWorkItem[] {
      const rows = deps.ghApiJson(`${repoPath}/issues?state=open`, {
        paginate: true,
      }) as (RawIssue & { pull_request?: unknown })[];
      return rows
        .filter((row) => row.pull_request == null)
        .map((row) => ({
          number: Number(row.number),
          title: String(row.title ?? ''),
          body: String(row.body ?? ''),
          // Raw REST casing (lowercase "open"/"closed"), NOT uppercased
          // like getWorkItem's state -- see provider-port.mts's doc
          // comment on this method for why the two differ.
          state: String(row.state ?? ''),
          labels: row.labels,
          url: row.url === undefined ? undefined : String(row.url),
          htmlUrl:
            row.html_url === undefined ? undefined : String(row.html_url),
          milestone: row.milestone,
        }));
    },

    searchWorkItems(query: string): ProviderWorkItem[] {
      const result = deps.ghApiJson(
        `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      ) as { items?: RawIssue[] };
      return (result.items ?? []).map((item) => ({
        number: Number(item.number),
        title: String(item.title ?? ''),
        body: String(item.body ?? ''),
        state: String(item.state ?? '').toUpperCase(),
        labels: item.labels,
        url: item.url === undefined ? undefined : String(item.url),
        htmlUrl:
          item.html_url === undefined ? undefined : String(item.html_url),
        milestone: item.milestone,
      }));
    },

    getWorkItemTimeline(number: number): ProviderTimelineEvent[] {
      return deps.ghApiJson(`${repoPath}/issues/${number}/timeline`, {
        paginate: true,
        extraArgs: ['-H', 'Accept: application/vnd.github+json'],
      }) as ProviderTimelineEvent[];
    },

    getWorkItemState(number: number): string | null {
      try {
        const state = deps.ghText(
          [
            'issue',
            'view',
            String(number),
            '--repo',
            `${owner}/${repo}`,
            '--json',
            'state',
            '--jq',
            '.state',
          ],
          GH_TEXT_LOOP_TIMEOUT_OPTIONS,
        );
        return state || null;
      } catch {
        return null;
      }
    },

    closeWorkItem(number: number, reason: string): void {
      deps.ghText(
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

    // The two paginated GraphQL methods below build `gh api graphql` args
    // by hand and call `ghText(args, GH_TEXT_LOOP_OPTIONS)` directly rather
    // than routing through gh-exec.mts's shared `ghGraphql` helper, which
    // has no loop-options parameter. Both are called from a per-issue
    // pagination loop -- the exact tight-loop stdin hazard
    // `GH_TEXT_LOOP_OPTIONS` exists for (#1396) -- mirroring
    // `idd-roadmap-audit-execute.mts`'s pre-existing local `ghGraphql`
    // verbatim so this migration does not silently re-lose that bugfix.

    getWorkItemClosingPullRequestsPage(
      number: number,
      after: string | null,
    ): ProviderClosingPullRequestsPage {
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
      const apiArgs = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${number}`,
      ];
      if (after) {
        apiArgs.push('-f', `after=${after}`);
      }
      const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS)) as {
        data?: {
          repository?: {
            issue?: {
              closedByPullRequestsReferences?: {
                nodes?: { state?: unknown }[];
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              };
            } | null;
          } | null;
        };
      };
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

    getConnectedPullRequestEventsSingle(
      number: number,
    ): ProviderConnectedPrEvent[] {
      try {
        const parsed = JSON.parse(
          deps.ghText([
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
        ) as {
          data?: {
            repository?: { issue?: { timelineItems?: { nodes?: unknown } } };
          };
        };
        const nodes = parsed?.data?.repository?.issue?.timelineItems?.nodes;
        return Array.isArray(nodes)
          ? (nodes as ProviderConnectedPrEvent[])
          : [];
      } catch {
        return [];
      }
    },

    getConnectedPullRequestEventsPage(
      number: number,
      after: string | null,
    ): {
      events: ProviderConnectedPrEvent[];
      hasNextPage: boolean;
      endCursor: string | null;
    } {
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
      const apiArgs = [
        'api',
        'graphql',
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${number}`,
      ];
      if (after) {
        apiArgs.push('-f', `after=${after}`);
      }
      const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS)) as {
        data?: {
          repository?: {
            issue?: {
              timelineItems?: {
                nodes?: unknown[];
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              };
            } | null;
          } | null;
        };
      };
      const connection = parsed.data?.repository?.issue?.timelineItems;
      if (!connection) {
        throw new Error('timelineItems: connection is null/absent');
      }
      return {
        events: (connection.nodes ?? []) as ProviderConnectedPrEvent[],
        hasNextPage: connection.pageInfo?.hasNextPage ?? false,
        endCursor: connection.pageInfo?.endCursor ?? null,
      };
    },

    getPullRequestsClosingIssue(number: number): number[] {
      // Uses `gh pr list`, not `gh api`, matching
      // discover-shared-file-overlap.mts's existing call shape exactly.
      const raw = deps.ghText(
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
      const list = JSON.parse(raw || '[]') as {
        number?: unknown;
        closingIssuesReferences?: { number?: unknown }[];
      }[];
      return list
        .filter((pr) =>
          (pr.closingIssuesReferences ?? []).some(
            (ref) => Number(ref.number) === number,
          ),
        )
        .map((pr) => Number(pr.number));
    },

    listIssueBranchRefs(): string[] {
      const refs = deps.ghApiJson(
        `${repoPath}/git/matching-refs/heads/issue/`,
        {
          paginate: true,
        },
      ) as { ref?: unknown }[];
      return refs.map((entry) => String(entry.ref ?? ''));
    },

    listWorkItemComments(number: number): ProviderComment[] {
      const rows = deps.ghApiJson(`${repoPath}/issues/${number}/comments`, {
        paginate: true,
      }) as {
        id?: unknown;
        body?: unknown;
        created_at?: unknown;
        user?: { login?: unknown };
      }[];
      return rows.map((row) => ({
        id: Number(row.id),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
    },

    postWorkItemComment(number: number, body: string): ProviderPostedComment {
      const out = deps.ghText(
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
      const parsed = JSON.parse(out) as { id: number; html_url: string };
      return { id: parsed.id, htmlUrl: parsed.html_url };
    },

    getCollaboratorPermission(
      login: string,
    ): ProviderCollaboratorPermissionResult {
      const normalized = login.trim().toLowerCase();
      try {
        const raw = deps.ghText(
          [
            'api',
            `${repoPath}/collaborators/${encodeURIComponent(normalized)}/permission`,
          ],
          { stdio: ['ignore', 'pipe', 'ignore'] },
        );
        const parsed = JSON.parse(raw) as {
          permission?: unknown;
          role_name?: unknown;
        };
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
          httpStatus: status,
        };
      }
    },

    getChangeRequest(number: number): ProviderChangeRequestState | null {
      try {
        const raw = deps.ghText(
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
        const parsed = JSON.parse(raw) as {
          mergeable?: unknown;
          mergeStateStatus?: unknown;
        };
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

    getChangeRequestHeadSha(number: number): string {
      return deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]);
    },

    listRequiredChecks(number: number): ProviderRequiredCheck[] {
      const raw = deps.ghText(
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
      const rows = JSON.parse(raw || '[]') as {
        name?: unknown;
        state?: unknown;
        completedAt?: unknown;
      }[];
      return rows.map((row) => ({
        name: String(row.name ?? ''),
        state: String(row.state ?? ''),
        completedAt: row.completedAt ? String(row.completedAt) : null,
      }));
    },

    listReviews(number: number): unknown[] {
      return deps.ghApiJson(`${repoPath}/pulls/${number}/reviews`, {
        paginate: true,
      }) as unknown[];
    },

    listOpenChangeRequests(): ProviderChangeRequestSummary[] {
      const raw = deps.ghText(
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
      const rows = JSON.parse(raw || '[]') as {
        number?: unknown;
        title?: unknown;
        body?: unknown;
        url?: unknown;
      }[];
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
export function resolveCurrentGithubRepository(): {
  owner: string;
  repo: string;
} {
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
