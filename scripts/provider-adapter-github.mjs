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
  ghTextAsync,
  withBoundedRetry,
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
// The traversal-only helpers below (through wrapTraversalGhFailure) back
// getWorkItemForTraversalAsync only -- a verbatim port of
// discover-roadmap-graph.mts's pre-migration resolveGhExitStatus/
// wrapGhFailure/isNotFoundIssueLookupError/isInaccessibleIssueLookupError,
// which existed to preserve retry-skip classification (#1394) the
// statusToCategory/ProviderError classification above cannot express: it
// maps 410/451 to 'validation', not the same bucket as 403, where this
// file's own INACCESSIBLE_HTTP_STATUSES treats all three as one signal.
const TRAVERSAL_INACCESSIBLE_HTTP_STATUSES = new Set([403, 410, 451]);
/** Mirrors resolveGhExitStatus: sync `.status` first, async `.code` second. */
function resolveTraversalGhExitStatus(error) {
  const candidate = error;
  const rawStatus = candidate?.status ?? candidate?.code;
  return typeof rawStatus === 'number' ? rawStatus : null;
}
/**
 * Wraps a failed `gh` error into the canonical `{ status, stderr }` shape
 * the two classifiers below read. Returns `''` when the exit status is in
 * `allowStatuses` (the 404-tolerance `getWorkItemForTraversalAsync` relies
 * on); otherwise throws.
 */
function wrapTraversalGhFailure(error, args, allowStatuses) {
  const status = resolveTraversalGhExitStatus(error);
  if (status !== null && allowStatuses.includes(status)) {
    return '';
  }
  const stderr = String(error?.stderr ?? '').trim();
  const prefix = `gh ${args.join(' ')}`;
  const wrapped = new Error(
    stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`,
  );
  wrapped.status = status;
  wrapped.stderr = stderr;
  throw wrapped;
}
function isTraversalInaccessibleError(error) {
  if (!error) {
    return false;
  }
  const rawStatus = error.status;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  if (status !== null && TRAVERSAL_INACCESSIBLE_HTTP_STATUSES.has(status)) {
    return true;
  }
  const stderr = String(error.stderr ?? '');
  return /Resource not accessible|access denied|Forbidden|Unavailable for legal reasons/i.test(
    stderr,
  );
}
function isTraversalNotFoundError(error) {
  if (!error) {
    return false;
  }
  const candidate = error;
  const stderr = String(candidate.stderr ?? candidate.message ?? '');
  return stderr.includes('HTTP 404');
}
// #1449: explicit above the promisified execFile's 1 MiB default, applied
// PER STREAM. The two traversal hot-path callers (a single GitHub issue's
// REST JSON -- body capped at 64 KiB by GitHub -- and a paginated 100-node
// sub-issue GraphQL page) stay far below this; 10 MiB per stream is a
// generous ceiling bounding worst-case memory rather than accepting
// unbounded accumulation (Copilot review, #1463).
const GH_ASYNC_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_DEPS = {
  ghText,
  ghApiJson,
  resolveViewerLogin: ghExecResolveViewerLogin,
  ghTextAsync,
};
/**
 * GitHub implementation of {@link ProviderPort}. `owner`/`repo` are resolved
 * once at construction (matching every migrated file's existing
 * `gh repo view` boilerplate) rather than re-resolved per call.
 */
export function createGithubProviderAdapter(owner, repo, deps = DEFAULT_DEPS) {
  const repoPath = `repos/${owner}/${repo}`;
  return {
    resolveRepositoryLocator() {
      return { provider: 'github', owner, name: repo };
    },
    resolveViewerLogin() {
      return deps.resolveViewerLogin(GH_TEXT_LOOP_TIMEOUT_OPTIONS);
    },
    resolveViewerLoginSafe() {
      try {
        const raw = deps.ghText(
          ['api', 'user', '--jq', '.login'],
          GH_TEXT_LOOP_OPTIONS,
        );
        const normalized = raw.trim().toLowerCase();
        if (!normalized) {
          return { viewerLogin: '', viewerLoginUnavailable: true };
        }
        return { viewerLogin: normalized, viewerLoginUnavailable: false };
      } catch {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
    },
    getWorkItem(number) {
      let data;
      try {
        data = deps.ghApiJson(`${repoPath}/issues/${number}`);
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
    listOpenWorkItems() {
      const rows = deps.ghApiJson(`${repoPath}/issues?state=open`, {
        paginate: true,
      });
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
    searchWorkItems(query) {
      const result = deps.ghApiJson(
        `search/issues?q=${encodeURIComponent(query)}&per_page=100`,
      );
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
    getWorkItemTimeline(number) {
      return deps.ghApiJson(`${repoPath}/issues/${number}/timeline`, {
        paginate: true,
        extraArgs: ['-H', 'Accept: application/vnd.github+json'],
      });
    },
    getWorkItemState(number) {
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
    closeWorkItem(number, reason) {
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
      const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
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
    getConnectedPullRequestEventsSingle(number) {
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
      const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
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
    listIssueNumbersClosedByOpenChangeRequests(limit) {
      // Uses `gh pr list`, not `gh api`, matching
      // discover-shared-file-overlap.mts's existing call shape exactly: one
      // best-effort scan of every open PR's closingIssuesReferences, bounded
      // by the caller's own limit.
      const raw = deps.ghText(
        [
          'pr',
          'list',
          '--repo',
          `${owner}/${repo}`,
          '--state',
          'open',
          '--limit',
          String(limit),
          '--json',
          'closingIssuesReferences',
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      const list = JSON.parse(raw || '[]');
      const numbers = new Set();
      for (const pr of list) {
        for (const ref of pr.closingIssuesReferences ?? []) {
          const value = Number(ref.number);
          if (Number.isInteger(value) && value > 0) {
            numbers.add(value);
          }
        }
      }
      return [...numbers];
    },
    listIssueBranchRefs() {
      const refs = deps.ghApiJson(
        `${repoPath}/git/matching-refs/heads/issue/`,
        {
          paginate: true,
        },
      );
      return refs.map((entry) => String(entry.ref ?? ''));
    },
    listWorkItemComments(number) {
      const rows = deps.ghApiJson(`${repoPath}/issues/${number}/comments`, {
        paginate: true,
      });
      return rows.map((row) => ({
        id: Number(row.id),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
    },
    postWorkItemComment(number, body) {
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
      const parsed = JSON.parse(out);
      return { id: parsed.id, htmlUrl: parsed.html_url };
    },
    getCollaboratorPermission(login) {
      const normalized = login.trim().toLowerCase();
      try {
        const raw = deps.ghText(
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
          httpStatus: status,
        };
      }
    },
    getChangeRequest(number) {
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
    getChangeRequestHeadSha(number) {
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
    listRequiredChecks(number) {
      const args = [
        'pr',
        'checks',
        String(number),
        '--repo',
        `${owner}/${repo}`,
        '--required',
        '--json',
        'name,state,completedAt',
      ];
      let raw;
      try {
        raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      } catch (error) {
        const stderr = String(error?.stderr ?? '');
        if (/no required checks reported/i.test(stderr)) {
          return [];
        }
        const stdout = String(error?.stdout ?? '').trim();
        if (!stdout) {
          throw error;
        }
        raw = stdout;
      }
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        name: String(row.name ?? ''),
        state: String(row.state ?? ''),
        completedAt: row.completedAt ? String(row.completedAt) : null,
      }));
    },
    listReviews(number) {
      return deps.ghApiJson(`${repoPath}/pulls/${number}/reviews`, {
        paginate: true,
      });
    },
    listOpenChangeRequests() {
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
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        number: Number(row.number),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        url: String(row.url ?? ''),
      }));
    },
    listChangeRequestReviewThreads(number) {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
      const threads = [];
      let cursor = null;
      while (true) {
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
        if (cursor) {
          apiArgs.push('-f', `cursor=${cursor}`);
        }
        const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
        const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
        for (const node of connection?.nodes ?? []) {
          threads.push({
            isResolved: node.isResolved ?? null,
          });
        }
        const pageInfo = connection?.pageInfo;
        if (!pageInfo?.hasNextPage) {
          break;
        }
        if (!pageInfo.endCursor) {
          throw new Error(
            'review thread pagination payload is missing endCursor',
          );
        }
        cursor = pageInfo.endCursor;
      }
      return threads;
    },
    async getWorkItemForTraversalAsync(number) {
      const args = [
        'api',
        `repos/${owner}/${repo}/issues/${number}`,
        '--jq',
        '.',
      ];
      try {
        // #1394: parse INSIDE the retry task, not after it resolves. A
        // truncated-but-successful gh exit (the field evidence's "unexpected
        // end of JSON input") surfaces as a JSON.parse failure on a resolved
        // string, not a thrown transport error -- parsing outside the task
        // would let that SyntaxError escape the retry loop and the
        // classifiers below, aborting the whole traversal on exactly the
        // transient hiccup the retry exists for.
        const parsed = await withBoundedRetry(
          async () => {
            let raw;
            try {
              raw = await deps.ghTextAsync(args, {
                maxBuffer: GH_ASYNC_MAX_BUFFER,
              });
            } catch (error) {
              raw = wrapTraversalGhFailure(error, args, [404]);
            }
            const trimmed = raw.trim();
            if (!trimmed || trimmed === 'null') {
              return null;
            }
            return JSON.parse(trimmed);
          },
          {
            isRetryable: (error) =>
              !isTraversalNotFoundError(error) &&
              !isTraversalInaccessibleError(error),
          },
        );
        if (parsed === null) {
          return { outcome: 'not-found' };
        }
        return { outcome: 'found', item: parsed };
      } catch (error) {
        if (isTraversalNotFoundError(error)) {
          return { outcome: 'not-found' };
        }
        if (isTraversalInaccessibleError(error)) {
          return { outcome: 'inaccessible' };
        }
        throw error;
      }
    },
    async listWorkItemSubIssueNodesAsync(number) {
      const query = `query($owner:String!, $repo:String!, $number:Int!, $after:String) {
  repository(owner:$owner, name:$repo) {
    issue(number:$number) {
      subIssues(first:100, after:$after) {
        nodes {
          number
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;
      const nodes = [];
      let after = '';
      for (;;) {
        const variables = {
          owner,
          repo,
          number,
        };
        if (after) {
          variables.after = after;
        }
        const result = await withBoundedRetry(async () => {
          const apiArgs = ['api', 'graphql', '-f', `query=${query}`];
          for (const [name, value] of Object.entries(variables)) {
            if (value === '' || value === null || value === undefined) {
              continue;
            }
            const flag = typeof value === 'number' ? '-F' : '-f';
            apiArgs.push(flag, `${name}=${value}`);
          }
          try {
            const stdout = await deps.ghTextAsync(apiArgs, {
              maxBuffer: GH_ASYNC_MAX_BUFFER,
            });
            const parsed = JSON.parse(stdout.trim() || '{}');
            if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              throw new Error(formatTraversalGraphqlErrors(parsed.errors));
            }
            return parsed;
          } catch (error) {
            const stderr = String(error?.stderr ?? '').trim();
            const detail = stderr || error.message;
            throw new Error(`gh api graphql failed: ${detail}`);
          }
        });
        const connection = result?.data?.repository?.issue?.subIssues;
        if (
          !connection ||
          !Array.isArray(connection.nodes) ||
          !connection.pageInfo
        ) {
          throw new Error(`subIssues connection missing for issue #${number}`);
        }
        nodes.push(...connection.nodes);
        if (!connection.pageInfo.hasNextPage) {
          break;
        }
        if (!connection.pageInfo.endCursor) {
          throw new Error(
            `subIssues pagination cursor missing for issue #${number}`,
          );
        }
        after = String(connection.pageInfo.endCursor);
      }
      return nodes;
    },
    async listWorkItemCommentsWithRetryAsync(number) {
      const comments = [];
      const pageSize = 100;
      for (let page = 1; ; page += 1) {
        const pageItems = await withBoundedRetry(async () => {
          const raw = deps
            .ghText(
              [
                'api',
                `repos/${owner}/${repo}/issues/${number}/comments?per_page=${pageSize}&page=${page}`,
                '--jq',
                '.',
              ],
              GH_TEXT_LOOP_OPTIONS,
            )
            .trim();
          return raw && raw !== 'null' ? JSON.parse(raw) : [];
        });
        if (!Array.isArray(pageItems) || pageItems.length === 0) {
          break;
        }
        comments.push(...pageItems);
        if (pageItems.length < pageSize) {
          break;
        }
      }
      return comments;
    },
    searchOpenWorkItems(query) {
      const args = [
        'search',
        'issues',
        '--repo',
        `${owner}/${repo}`,
        '--state',
        'open',
        '--limit',
        String(query.limit),
        '--json',
        query.fields.join(','),
      ];
      if (query.label) {
        args.push('--label', query.label);
      }
      if (query.matchBody) {
        args.push('--match', 'body', query.matchBody);
      }
      const raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS).trim();
      const parsed = raw && raw !== 'null' ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    },
  };
}
/** Coerce a GraphQL response's `errors[]` array into one readable string;
 * backs {@link createGithubProviderAdapter}'s `listWorkItemSubIssueNodesAsync`. */
function formatTraversalGraphqlErrors(errors) {
  return errors
    .map((error) => String(error?.message ?? 'unknown GraphQL error'))
    .join('; ');
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
