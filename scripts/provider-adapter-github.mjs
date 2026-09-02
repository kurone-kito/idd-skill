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
  readGithubRepoDefaultBranch,
  resolveGhApiHostname,
  withBoundedRetry,
} from './gh-exec.mjs';
import { deriveGhHttpStatus } from './gh-http-status.mjs';
import { PROVIDER_CAPABILITY_GROUPS } from './provider-contract.mjs';

/**
 * `--hostname` args to splice into a hand-built `['api', 'graphql', ...]`
 * array right after `'graphql'`, matching `gh-exec.mts`'s `ghGraphql`/
 * `ghApiJson` (#1962) -- this file's raw GraphQL call sites build their own
 * args (see `fetchReviewThreadsGeneric`'s doc comment for why: a tight-loop
 * stdin hazard, #1396) rather than routing through that shared helper, so
 * each site must resolve the GHES host itself instead of always defaulting
 * to github.com (Copilot review, PR #2429).
 */
function graphqlHostnameArgs() {
  const hostname = resolveGhApiHostname();
  return hostname ? ['--hostname', hostname] : [];
}
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
 * Wraps a raw gh-exec failure into an `Error` that also carries
 * {@link ProviderError}'s fields as own properties, for a port method
 * documented to throw a typed `ProviderError` on non-404 failure (only
 * {@link getWorkItem} today -- see its doc comment in provider-port.mts).
 * `ProviderError` itself is a plain data interface, not an `Error`
 * subclass, so the thrown value must still be a real `Error` (preserving
 * a stack trace and `instanceof Error` checks elsewhere) that also
 * satisfies the interface, rather than throwing a bare object (Copilot
 * review, #2400).
 */
function toProviderError(error) {
  const status = deriveGhHttpStatus(error);
  const stderr = String(error?.stderr ?? '').trim();
  const message =
    stderr || (error instanceof Error ? error.message : String(error));
  const wrapped = new Error(message);
  wrapped.category = statusToCategory(status);
  wrapped.cause = error;
  return wrapped;
}
/**
 * #2267: throw when a GraphQL response carries top-level `errors`, so a bad
 * PR/repo/auth or any server-side GraphQL failure fails fast with a clear
 * message instead of being silently read as an empty result -- ported
 * verbatim from `resolve-review-thread.mts`'s pre-migration
 * `assertNoGraphqlErrors` (its own review-thread queries relied on this;
 * every other GraphQL-backed port method here shares the same choke point
 * now via {@link fetchReviewThreadsGeneric}'s `runQuery`).
 */
function assertNoGraphqlErrors(payload, context) {
  const errors = payload?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(
      `${context} failed: ${errors
        .map((entry) => String(entry.message ?? ''))
        .filter(Boolean)
        .join('; ')
        .slice(0, 200)}`,
    );
  }
}
/**
 * #2460: synchronous bounded sleep via `Atomics.wait` on a throwaway
 * `SharedArrayBuffer` -- the same technique `advisory-convergence.mts`,
 * `clone-lock.mts`, and `rerun-advisory-convergence.mts` each already
 * duplicate locally rather than switching to `async`/`await` (the existing
 * `withBoundedRetry` in `gh-exec.mts` is `Promise`-returning and would force
 * every synchronous caller of {@link ProviderPort.postWorkItemComment} --
 * and the whole `ProviderPort` interface -- to become async for one retry
 * loop). Duplicated here as this one-line function, mirroring that same
 * established precedent, rather than adding new cross-file coupling.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const POST_WORK_ITEM_COMMENT_TOTAL_ATTEMPTS = 3;
const POST_WORK_ITEM_COMMENT_BASE_DELAY_MS = 200;
/**
 * #2460: the issues-comments POST endpoint is not idempotent -- each
 * successful call creates a new comment -- so a bare retry-on-any-failure
 * risks posting the same marker twice when a failure is ambiguous (the
 * write landed server-side, but the client never saw a successful
 * response; observed live as a one-off transient failure whose very next
 * unrelated API call succeeded). Before every retry, re-read recent
 * comments for an exact-body match: found means the prior attempt actually
 * landed, so return that comment instead of posting again; not found means
 * the prior attempt genuinely failed, so back off and retry the POST. This
 * scan is best-effort only (a transient read failure here must never block
 * the retry it is meant to protect) and only ever runs on the error path,
 * never the common single-attempt success path.
 */
function findRecentExactBodyMatch(deps, repoPath, number, body) {
  let rows;
  try {
    rows = deps.ghApiJson(`${repoPath}/issues/${number}/comments`, {
      paginate: true,
    });
  } catch {
    return null;
  }
  let newest = null;
  for (const row of rows) {
    if (String(row.body ?? '') !== body) {
      continue;
    }
    const id = Number(row.id);
    const htmlUrl = String(row.html_url ?? '');
    // Same shape requirement as the fresh-POST path below -- a match with
    // no usable id/html_url is not a usable result, so keep scanning
    // instead of returning a comment the caller couldn't act on.
    if (!Number.isInteger(id) || id <= 0 || htmlUrl === '') {
      continue;
    }
    // Comments come back in ascending creation order; keep the last (most
    // recent) exact-body match in the unlikely event more than one exists.
    newest = { id, htmlUrl };
  }
  return newest;
}
/**
 * #2460: POST a work-item (issue/PR) comment with a bounded retry against
 * transient `gh` failures, guarding against the resulting duplicate-post
 * risk via {@link findRecentExactBodyMatch}, and validating the response
 * shape before treating the marker as posted (catches a 200-with-
 * malformed-body edge case a bare retry would not).
 */
function postWorkItemCommentWithRetry(deps, repoPath, number, body) {
  const sleep = deps.sleepSync ?? sleepSync;
  let lastError;
  for (
    let attempt = 1;
    attempt <= POST_WORK_ITEM_COMMENT_TOTAL_ATTEMPTS;
    attempt += 1
  ) {
    if (attempt > 1) {
      const existing = findRecentExactBodyMatch(deps, repoPath, number, body);
      if (existing) {
        return existing;
      }
      sleep(
        POST_WORK_ITEM_COMMENT_BASE_DELAY_MS * (attempt - 1) +
          Math.random() * POST_WORK_ITEM_COMMENT_BASE_DELAY_MS,
      );
    }
    try {
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
      const id = Number(parsed.id);
      const htmlUrl = String(parsed.html_url ?? '');
      if (!Number.isInteger(id) || id <= 0 || htmlUrl === '') {
        throw new Error(
          `postWorkItemComment: malformed POST response for ${repoPath}/issues/${number} (missing id/html_url)`,
        );
      }
      return { id, htmlUrl };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
/** #2267: {@link GithubProviderAdapterDeps.ghText}, swallowing any failure
 * and returning `''` instead -- the injectable-`deps` equivalent of
 * `gh-exec.mts`'s own module-level `safeGhText`, needed here so a unit test
 * can still assert the exact command shape of a never-throw method without
 * spawning a real `gh` process. */
function safeGhTextLocal(deps, args, options = {}) {
  try {
    return deps.ghText(args, options);
  } catch {
    return '';
  }
}
/** #2267: run a governance-style read (branch rules, branch protection,
 * ruleset detail), discriminating a masked `404` (see
 * {@link ProviderGovernanceReadOutcome}'s doc comment) from a real value.
 * Any non-404 failure rethrows unchanged. */
function fetchGovernanceOutcome(fetchJson) {
  try {
    return { outcome: 'ok', value: fetchJson() };
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return { outcome: 'not-found' };
    }
    throw error;
  }
}
/**
 * #2267: shared full-walk pagination for the three distinct
 * `reviewThreads` queries this migration needs
 * ({@link ProviderPort.listChangeRequestReviewThreadsWithComments},
 * {@link ProviderPort.listChangeRequestReviewThreadsExtended},
 * {@link ProviderPort.listChangeRequestReviewThreadCommentIds}) --
 * `commentFieldsFragment` selects each method's own distinct comment field
 * set (see each port method's doc comment for why they stay separate
 * types); this helper only shares the two-level pagination walk (outer
 * `reviewThreads` cursor, inner per-thread `comments` cursor via a
 * `node(id)` continuation query), which is identical machinery across all
 * three. Always requests the thread `id` internally (continuation needs
 * it) even for a caller whose own return shape omits it. Throws on a page
 * that reports `hasNextPage` without an `endCursor`, at either level --
 * preserves `resolve-review-thread.mts`'s and
 * `pre-merge-readiness.mts`'s existing fail-fast-on-malformed-page
 * behavior (a malformed payload would otherwise silently undercount
 * threads or comments).
 */
function fetchReviewThreadsGeneric(
  deps,
  owner,
  repo,
  number,
  commentFieldsFragment,
) {
  const outerQuery = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100,after:$cursor){
        nodes {
          id
          isResolved
          path
          comments(first:100) {
            nodes { ${commentFieldsFragment} }
            pageInfo { hasNextPage endCursor }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  const continuationQuery = `query($id:ID!,$cursor:String){
  node(id:$id){
    ... on PullRequestReviewThread{
      comments(first:100,after:$cursor){
        nodes { ${commentFieldsFragment} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
  function runQuery(apiArgs) {
    const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
    assertNoGraphqlErrors(parsed, 'review thread lookup');
    return parsed;
  }
  function walkThreadComments(threadId, firstPageNodes, firstPageInfo) {
    const comments = [...firstPageNodes];
    let pageInfo = firstPageInfo;
    while (pageInfo?.hasNextPage) {
      if (!pageInfo.endCursor) {
        throw new Error(
          `fetchReviewThreadsGeneric: comment page reported hasNextPage without endCursor for thread ${threadId}`,
        );
      }
      const parsed = runQuery([
        'api',
        'graphql',
        ...graphqlHostnameArgs(),
        '-f',
        `query=${continuationQuery}`,
        '-f',
        `id=${threadId}`,
        '-f',
        `cursor=${pageInfo.endCursor}`,
      ]);
      const nextComments = parsed.data?.node?.comments;
      comments.push(...(nextComments?.nodes ?? []));
      pageInfo = nextComments?.pageInfo;
    }
    return comments;
  }
  const threads = [];
  let cursor = null;
  while (true) {
    const apiArgs = [
      'api',
      'graphql',
      ...graphqlHostnameArgs(),
      '-f',
      `query=${outerQuery}`,
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
    const parsed = runQuery(apiArgs);
    const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
    for (const node of connection?.nodes ?? []) {
      const threadId = String(node.id ?? '');
      threads.push({
        id: threadId,
        isResolved:
          typeof node.isResolved === 'boolean' ? node.isResolved : null,
        path: node.path == null ? null : String(node.path),
        comments: walkThreadComments(
          threadId,
          node.comments?.nodes ?? [],
          node.comments?.pageInfo,
        ),
      });
    }
    const pageInfo = connection?.pageInfo;
    if (!pageInfo?.hasNextPage) {
      break;
    }
    if (!pageInfo.endCursor) {
      throw new Error(
        `fetchReviewThreadsGeneric: thread page reported hasNextPage without endCursor for PR #${number}`,
      );
    }
    cursor = pageInfo.endCursor;
  }
  return threads;
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
  sleepSync,
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
        throw toProviderError(error);
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
        // Raw REST casing (lowercase "open"/"closed"), NOT uppercased --
        // this method's own doc comment says "like listOpenWorkItems",
        // which deliberately preserves REST's raw casing (Copilot review,
        // #2400).
        state: String(item.state ?? ''),
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
        updatedAt: String(row.updated_at ?? row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
    },
    postWorkItemComment(number, body) {
      return postWorkItemCommentWithRetry(deps, repoPath, number, body);
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
    // --- #2267 additions below. -------------------------------------------
    getRepositoryDefaultBranch(defaultBranchOwner, defaultBranchRepo) {
      return readGithubRepoDefaultBranch(defaultBranchOwner, defaultBranchRepo);
    },
    resolveViewerAppSlugSafe() {
      const raw = safeGhTextLocal(
        deps,
        ['api', 'app', '--jq', '.slug // .app_slug // empty'],
        GH_TEXT_LOOP_OPTIONS,
      ).trim();
      return raw
        ? { appSlug: raw, unavailable: false }
        : { appSlug: '', unavailable: true };
    },
    resolveViewerLoginSafeQuiet() {
      // #2267: mirrors resolveViewerLoginSafe's query/never-throw contract,
      // but with advisory-convergence.mts's own env-conditional stdio (CI
      // stays silent/piped; a local run's stderr stays visible to the
      // operator watching it) -- see this method's doc comment in
      // provider-port.mts for why it is not folded into the existing one.
      const stdio = process.env.GITHUB_ACTIONS
        ? ['ignore', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'inherit'];
      try {
        const raw = deps.ghText(['api', 'user', '--jq', '.login'], { stdio });
        const normalized = raw.trim().toLowerCase();
        if (!normalized) {
          return { viewerLogin: '', viewerLoginUnavailable: true };
        }
        return { viewerLogin: normalized, viewerLoginUnavailable: false };
      } catch {
        return { viewerLogin: '', viewerLoginUnavailable: true };
      }
    },
    getRepositoryContentAtRef(contentOwner, contentRepo, path, ref) {
      try {
        return deps.ghApiJson(
          `repos/${contentOwner}/${contentRepo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
        );
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return null;
        }
        throw error;
      }
    },
    getRepositoryFileContentAtRef(repoRef, path, ref) {
      try {
        const content = deps.ghText([
          'api',
          `repos/${repoRef}/contents/${path}`,
          '--method',
          'GET',
          '--field',
          `ref=${ref}`,
          '--jq',
          '.content',
        ]);
        return { outcome: 'ok', value: content };
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return { outcome: 'not-found' };
        }
        throw error;
      }
    },
    getTeamMembershipStateSafe(org, teamSlug, login) {
      return safeGhTextLocal(
        deps,
        [
          'api',
          `orgs/${org}/teams/${teamSlug}/memberships/${encodeURIComponent(login)}`,
          '--jq',
          '.state',
        ],
        GH_TEXT_LOOP_OPTIONS,
      ).trim();
    },
    getChangeRequestHeadShaAndAuthor(number) {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,author',
      ]);
      const parsed = JSON.parse(raw);
      return {
        headSha: String(parsed.headRefOid ?? ''),
        authorLogin: String(parsed.author?.login ?? ''),
      };
    },
    getChangeRequestConvergenceView(number) {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,headRefName,closingIssuesReferences,author,url',
      ]);
      const parsed = JSON.parse(raw);
      return {
        headSha: String(parsed.headRefOid ?? ''),
        headRefName: String(parsed.headRefName ?? ''),
        authorLogin: String(parsed.author?.login ?? ''),
        url: String(parsed.url ?? ''),
        closingIssuesReferences: parsed.closingIssuesReferences,
      };
    },
    getChangeRequestReadinessSnapshot(number) {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,closingIssuesReferences',
      ]);
      const parsed = JSON.parse(raw);
      return {
        headSha: String(parsed.headRefOid ?? ''),
        baseRefName: String(parsed.baseRefName ?? ''),
        url: String(parsed.url ?? ''),
        authorLogin: String(parsed.author?.login ?? ''),
        reviewDecision:
          parsed.reviewDecision == null ? null : String(parsed.reviewDecision),
        statusCheckRollup: parsed.statusCheckRollup,
        mergeable: String(parsed.mergeable ?? ''),
        mergeStateStatus: String(parsed.mergeStateStatus ?? ''),
        closingIssuesReferences: parsed.closingIssuesReferences,
      };
    },
    getChangeRequestBranchAndChecks(number) {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,baseRefName,statusCheckRollup',
      ]);
      const parsed = JSON.parse(raw);
      return {
        headSha: String(parsed.headRefOid ?? ''),
        baseRefName: String(parsed.baseRefName ?? ''),
        statusCheckRollup: parsed.statusCheckRollup,
      };
    },
    getChangeRequestHeadRef(number) {
      return deps.ghText([
        'api',
        `${repoPath}/pulls/${number}`,
        '--jq',
        '.head.ref',
      ]);
    },
    listMergedChangeRequests(limit, sinceDate) {
      const args = [
        'pr',
        'list',
        '-R',
        `${owner}/${repo}`,
        '--state',
        'merged',
        '--limit',
        String(limit),
        '--json',
        'number,mergedAt',
      ];
      if (sinceDate) {
        args.push('--search', `merged:>=${sinceDate}`);
      }
      const raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        number: Number(row.number),
        mergedAt: String(row.mergedAt ?? ''),
      }));
    },
    getMergedChangeRequestMeta(number) {
      const query = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){ number merged mergedAt mergeCommit{oid} }
  }
}`;
      const apiArgs = [
        'api',
        'graphql',
        ...graphqlHostnameArgs(),
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${number}`,
      ];
      const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
      assertNoGraphqlErrors(raw, 'getMergedChangeRequestMeta');
      const parsed = raw;
      const pr = parsed.data?.repository?.pullRequest;
      if (pr?.merged !== true) {
        return null;
      }
      return {
        number: Number(pr.number ?? number),
        merged: true,
        mergedAt: pr.mergedAt == null ? null : String(pr.mergedAt),
        mergeCommitOid:
          pr.mergeCommit?.oid == null ? null : String(pr.mergeCommit.oid),
      };
    },
    listChangeRequestChecks(number) {
      // #2267: matches review-activity-snapshot.mts's pre-migration
      // `ghJson(..., { allowStatuses: [1, 8] })` exactly -- an exit-code
      // allowlist requiring stdout to actually look like JSON, not a
      // stderr-content match. `gh pr checks` (no `--required`) exits 1 or 8
      // while checks are pending/failing or reporting a mixed state, a
      // routine outcome for this ALL-checks call -- but an allowed exit
      // status with genuinely empty/non-JSON stdout (a different failure
      // wearing the same exit code) still rethrows, unlike
      // {@link listRequiredChecks}'s stricter `--required` recovery, which
      // matches on stderr content instead.
      const args = [
        'pr',
        'checks',
        String(number),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'name,state,completedAt',
      ];
      let raw;
      try {
        raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      } catch (error) {
        const status = Number(error?.status ?? -1);
        const stdout = String(error?.stdout ?? '');
        if (![1, 8].includes(status) || !/^\s*[[{]/.test(stdout)) {
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
    getChangeRequestRequestedReviewerLogins(number) {
      const result = deps.ghApiJson(
        `${repoPath}/pulls/${number}/requested_reviewers`,
      );
      return (result.users ?? []).map((user) => String(user.login ?? ''));
    },
    getChangeRequestRequestedReviewerLoginsGraphql(number) {
      try {
        const query = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewRequests(first:100){
        nodes { requestedReviewer { ...on Bot{login} ...on User{login} ...on Mannequin{login} } }
      }
    }
  }
}`;
        const apiArgs = [
          'api',
          'graphql',
          ...graphqlHostnameArgs(),
          '-f',
          `query=${query}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `repo=${repo}`,
          '-F',
          `number=${number}`,
        ];
        const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
        const nodes =
          parsed.data?.repository?.pullRequest?.reviewRequests?.nodes ?? [];
        return nodes
          .map((node) => node.requestedReviewer?.login)
          .filter((login) => typeof login === 'string');
      } catch {
        return null;
      }
    },
    listChangeRequestChangedFiles(number) {
      const rows = deps.ghApiJson(`${repoPath}/pulls/${number}/files`, {
        paginate: true,
      });
      return rows.map((row) => String(row.filename ?? ''));
    },
    listChangeRequestCommits(number) {
      return deps.ghApiJson(`${repoPath}/pulls/${number}/commits`, {
        paginate: true,
      });
    },
    listChangeRequestReviewThreadsWithComments(number) {
      const nodes = fetchReviewThreadsGeneric(
        deps,
        owner,
        repo,
        number,
        'body createdAt updatedAt author { login } pullRequestReview { id }',
      );
      return nodes.map((node) => ({
        isResolved: node.isResolved,
        comments: node.comments.map((comment) => ({
          body: String(comment.body ?? ''),
          createdAt: String(comment.createdAt ?? ''),
          updatedAt: String(comment.updatedAt ?? ''),
          authorLogin: String(comment.author?.login ?? ''),
          pullRequestReviewId:
            comment.pullRequestReview?.id == null
              ? null
              : String(comment.pullRequestReview.id),
        })),
      }));
    },
    listChangeRequestReviewThreadsExtended(number) {
      const nodes = fetchReviewThreadsGeneric(
        deps,
        owner,
        repo,
        number,
        'body url createdAt updatedAt author { login }',
      );
      return nodes.map((node) => ({
        isResolved: node.isResolved,
        path: node.path,
        comments: node.comments.map((comment) => ({
          body: String(comment.body ?? ''),
          url: comment.url == null ? undefined : String(comment.url),
          createdAt: String(comment.createdAt ?? ''),
          updatedAt: String(comment.updatedAt ?? ''),
          authorLogin: String(comment.author?.login ?? ''),
        })),
      }));
    },
    listChangeRequestReviewThreadCommentIds(number) {
      const nodes = fetchReviewThreadsGeneric(
        deps,
        owner,
        repo,
        number,
        'databaseId',
      );
      return nodes.map((node) => ({
        threadId: node.id,
        isResolved: node.isResolved,
        commentDatabaseIds: node.comments
          .map((comment) => comment.databaseId)
          .filter((id) => typeof id === 'number'),
      }));
    },
    listChangeRequestGraphqlComments(number) {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      comments(first:100,after:$cursor){
        nodes { body url createdAt updatedAt author { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
      const out = [];
      let cursor = null;
      while (true) {
        const apiArgs = [
          'api',
          'graphql',
          ...graphqlHostnameArgs(),
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
        const rawComments = JSON.parse(
          deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS),
        );
        assertNoGraphqlErrors(rawComments, 'listChangeRequestGraphqlComments');
        const parsed = rawComments;
        // Fail fast on a missing pullRequest node or connection, matching
        // merged-pr-feedback-sweep.mts's pre-migration fetchAllNodes
        // (Codex review, PR #2429): an absent node/connection is otherwise
        // read as zero comments, making a PR look "clean" -- the silent
        // false negative this check exists to prevent.
        const pullRequest = parsed.data?.repository?.pullRequest;
        if (pullRequest == null) {
          throw new Error(
            `listChangeRequestGraphqlComments: PR #${number} returned no pullRequest node`,
          );
        }
        const connection = pullRequest.comments;
        if (connection == null) {
          throw new Error(
            `listChangeRequestGraphqlComments: PR #${number} returned a null comments connection`,
          );
        }
        for (const node of connection.nodes ?? []) {
          out.push({
            body: String(node.body ?? ''),
            url: String(node.url ?? ''),
            createdAt: String(node.createdAt ?? ''),
            updatedAt: String(node.updatedAt ?? ''),
            authorLogin: String(node.author?.login ?? ''),
          });
        }
        const pageInfo = connection.pageInfo;
        if (!pageInfo?.hasNextPage) {
          break;
        }
        if (!pageInfo.endCursor) {
          throw new Error(
            `listChangeRequestGraphqlComments: page reported hasNextPage without endCursor for PR #${number}`,
          );
        }
        cursor = pageInfo.endCursor;
      }
      return out;
    },
    listChangeRequestGraphqlReviews(number) {
      const query = `query($owner:String!,$repo:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviews(first:100,after:$cursor){
        nodes { body url state submittedAt author { login } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
      const out = [];
      let cursor = null;
      while (true) {
        const apiArgs = [
          'api',
          'graphql',
          ...graphqlHostnameArgs(),
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
        const rawReviews = JSON.parse(
          deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS),
        );
        assertNoGraphqlErrors(rawReviews, 'listChangeRequestGraphqlReviews');
        const parsed = rawReviews;
        // Fail fast on a missing pullRequest node or connection, matching
        // merged-pr-feedback-sweep.mts's pre-migration fetchAllNodes
        // (Codex review, PR #2429) -- see listChangeRequestGraphqlComments's
        // identical check above for the full rationale.
        const pullRequest = parsed.data?.repository?.pullRequest;
        if (pullRequest == null) {
          throw new Error(
            `listChangeRequestGraphqlReviews: PR #${number} returned no pullRequest node`,
          );
        }
        const connection = pullRequest.reviews;
        if (connection == null) {
          throw new Error(
            `listChangeRequestGraphqlReviews: PR #${number} returned a null reviews connection`,
          );
        }
        for (const node of connection.nodes ?? []) {
          out.push({
            body: String(node.body ?? ''),
            url: String(node.url ?? ''),
            state: String(node.state ?? ''),
            submittedAt:
              node.submittedAt == null ? null : String(node.submittedAt),
            authorLogin: String(node.author?.login ?? ''),
          });
        }
        const pageInfo = connection.pageInfo;
        if (!pageInfo?.hasNextPage) {
          break;
        }
        if (!pageInfo.endCursor) {
          throw new Error(
            `listChangeRequestGraphqlReviews: page reported hasNextPage without endCursor for PR #${number}`,
          );
        }
        cursor = pageInfo.endCursor;
      }
      return out;
    },
    listBranchRules(rulesOwner, rulesRepo, ref) {
      return fetchGovernanceOutcome(() =>
        deps.ghApiJson(
          `repos/${rulesOwner}/${rulesRepo}/rules/branches/${encodeURIComponent(ref)}`,
          { paginate: true },
        ),
      );
    },
    getBranchProtection(protectionOwner, protectionRepo, ref) {
      return fetchGovernanceOutcome(() =>
        deps.ghApiJson(
          `repos/${protectionOwner}/${protectionRepo}/branches/${encodeURIComponent(ref)}/protection`,
        ),
      );
    },
    getRepositoryRulesetDetail(path) {
      return fetchGovernanceOutcome(() =>
        deps.ghApiJson(path, {
          extraArgs: ['-H', 'Accept: application/vnd.github+json'],
        }),
      );
    },
    getWorkflowRun(runOwner, runRepo, runId) {
      const raw = deps.ghText(
        ['api', `repos/${runOwner}/${runRepo}/actions/runs/${runId}`],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      );
      return JSON.parse(raw.trim() || '{}');
    },
    listWorkflowRuns(runsOwner, runsRepo, workflowName, limit) {
      const raw = deps.ghText(
        [
          'run',
          'list',
          '--repo',
          `${runsOwner}/${runsRepo}`,
          '--workflow',
          workflowName,
          '--limit',
          String(limit),
          '--json',
          'databaseId,conclusion,status,createdAt',
        ],
        GH_TEXT_LOOP_OPTIONS,
      );
      const rows = JSON.parse(raw || '[]');
      return rows.map((row) => ({
        // String(...), not Number(...): preserves a databaseId above
        // Number.MAX_SAFE_INTEGER exactly (Codex review, PR #2429).
        id: String(row.databaseId ?? ''),
        conclusion: row.conclusion == null ? null : String(row.conclusion),
        status: String(row.status ?? ''),
        createdAt: String(row.createdAt ?? ''),
      }));
    },
    getChangeRequestHeadShaAtRepo(atRepoOwner, atRepoRepo, number) {
      return deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${atRepoOwner}/${atRepoRepo}`,
        '--json',
        'headRefOid',
        '--jq',
        '.headRefOid',
      ]);
    },
    getChangeRequestAtRepo(atRepoOwner, atRepoRepo, number) {
      try {
        const raw = deps.ghText(
          [
            'pr',
            'view',
            String(number),
            '-R',
            `${atRepoOwner}/${atRepoRepo}`,
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
    mergeChangeRequestAtRepo(mergeOwner, mergeRepo, number, headSha) {
      return deps.ghText([
        'pr',
        'merge',
        String(number),
        '-R',
        `${mergeOwner}/${mergeRepo}`,
        '--merge',
        '--match-head-commit',
        headSha,
      ]);
    },
    mergeChangeRequestAdminAtRepo(mergeOwner, mergeRepo, number, headSha) {
      return deps.ghText([
        'pr',
        'merge',
        String(number),
        '-R',
        `${mergeOwner}/${mergeRepo}`,
        '--merge',
        '--match-head-commit',
        headSha,
        '--admin',
      ]);
    },
    getChangeRequestAuthor(number) {
      const query = `
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              author { login __typename }
            }
          }
        }`;
      const apiArgs = [
        'api',
        'graphql',
        ...graphqlHostnameArgs(),
        '-f',
        `query=${query}`,
        '-f',
        `owner=${owner}`,
        '-f',
        `repo=${repo}`,
        '-F',
        `number=${number}`,
      ];
      const rawAuthor = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
      assertNoGraphqlErrors(rawAuthor, 'getChangeRequestAuthor');
      const parsed = rawAuthor;
      const author = parsed.data?.repository?.pullRequest?.author;
      if (!author) {
        return null;
      }
      return {
        login: String(author.login ?? ''),
        typename: author.__typename == null ? null : String(author.__typename),
      };
    },
    listChangeRequestReviewThreadsWithAuthorType(number) {
      const nodes = fetchReviewThreadsGeneric(
        deps,
        owner,
        repo,
        number,
        'body createdAt updatedAt author { login __typename } pullRequestReview { id }',
      );
      return nodes.map((node) => ({
        id: node.id,
        isResolved: node.isResolved,
        comments: node.comments.map((comment) => ({
          body: String(comment.body ?? ''),
          createdAt: String(comment.createdAt ?? ''),
          updatedAt: String(comment.updatedAt ?? ''),
          authorLogin: String(comment.author?.login ?? ''),
          authorTypename:
            comment.author?.__typename == null
              ? null
              : String(comment.author.__typename),
          pullRequestReviewId:
            comment.pullRequestReview?.id == null
              ? null
              : String(comment.pullRequestReview.id),
        })),
      }));
    },
    getChangeRequestReviewsWithHeadCommitDate(number) {
      const query = `
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviews(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  commit { oid }
                  submittedAt
                  author { login __typename }
                  comments { totalCount }
                  body
                }
              }
              commits(last: 1) {
                nodes { commit { committedDate } }
              }
            }
          }
        }`;
      const nodes = [];
      let headCommittedAt = '';
      let cursor = null;
      while (true) {
        const apiArgs = [
          'api',
          'graphql',
          ...graphqlHostnameArgs(),
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
        const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
        assertNoGraphqlErrors(raw, 'getChangeRequestReviewsWithHeadCommitDate');
        const parsed = raw;
        const pullRequest = parsed.data?.repository?.pullRequest;
        nodes.push(...(pullRequest?.reviews?.nodes ?? []));
        if (!headCommittedAt) {
          headCommittedAt = String(
            pullRequest?.commits?.nodes?.[0]?.commit?.committedDate ?? '',
          );
        }
        const pageInfo = pullRequest?.reviews?.pageInfo;
        if (!pageInfo?.hasNextPage) {
          break;
        }
        if (!pageInfo.endCursor) {
          throw new Error(
            `getChangeRequestReviewsWithHeadCommitDate: review page reported hasNextPage without endCursor for PR #${number}`,
          );
        }
        cursor = pageInfo.endCursor;
      }
      return {
        reviews: nodes.map((node) => ({
          id: String(node.id ?? ''),
          authorLogin: String(node.author?.login ?? ''),
          authorTypename:
            node.author?.__typename == null
              ? null
              : String(node.author.__typename),
          submittedAt:
            node.submittedAt == null ? null : String(node.submittedAt),
          commitId: node.commit?.oid == null ? null : String(node.commit.oid),
          commentCount:
            typeof node.comments?.totalCount === 'number'
              ? node.comments.totalCount
              : null,
          body: node.body == null ? null : String(node.body),
        })),
        headCommittedAt,
      };
    },
    mergeChangeRequest(number, headSha) {
      return deps.ghText([
        'pr',
        'merge',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--merge',
        '--match-head-commit',
        headSha,
      ]);
    },
    mergeChangeRequestAdmin(number, headSha) {
      return deps.ghText([
        'pr',
        'merge',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--merge',
        '--match-head-commit',
        headSha,
        '--admin',
      ]);
    },
    postReviewCommentReply(number, commentId, body) {
      const out = deps.ghText(
        [
          'api',
          '--method',
          'POST',
          `${repoPath}/pulls/${number}/comments/${commentId}/replies`,
          '--input',
          '-',
        ],
        { input: JSON.stringify({ body }) },
      );
      const parsed = JSON.parse(out);
      return { id: parsed.id };
    },
    resolveChangeRequestReviewThread(threadId) {
      const mutation = `mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread { isResolved } }
}`;
      const apiArgs = [
        'api',
        'graphql',
        ...graphqlHostnameArgs(),
        '-f',
        `query=${mutation}`,
        '-f',
        `threadId=${threadId}`,
      ];
      const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
      assertNoGraphqlErrors(raw, 'resolveReviewThread');
      const parsed = raw;
      if (parsed.data?.resolveReviewThread?.thread?.isResolved !== true) {
        throw new Error(
          `resolveChangeRequestReviewThread: GitHub did not confirm thread ${threadId} as resolved`,
        );
      }
    },
    listCapabilityDeclarations() {
      return PROVIDER_CAPABILITY_GROUPS.map((group) => ({
        group,
        requirement: group === 'advisory-review' ? 'optional' : 'required',
        supported: true,
      }));
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
