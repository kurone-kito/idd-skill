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

import type { GhTextOptions } from './gh-exec.mts';
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
} from './gh-exec.mts';
import { deriveGhHttpStatus } from './gh-http-status.mts';
import {
  PROVIDER_CAPABILITY_GROUPS,
  type ProviderCapabilityDeclaration,
  type ProviderError,
  type ProviderErrorCategory,
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

/**
 * `--hostname` args to splice into a hand-built `['api', 'graphql', ...]`
 * array right after `'graphql'`, matching `gh-exec.mts`'s `ghGraphql`/
 * `ghApiJson` (#1962) -- this file's raw GraphQL call sites build their own
 * args (see `fetchReviewThreadsGeneric`'s doc comment for why: a tight-loop
 * stdin hazard, #1396) rather than routing through that shared helper, so
 * each site must resolve the GHES host itself instead of always defaulting
 * to github.com (Copilot review, PR #2429).
 */
function graphqlHostnameArgs(): string[] {
  const hostname = resolveGhApiHostname();
  return hostname ? ['--hostname', hostname] : [];
}

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
function toProviderError(error: unknown): Error & ProviderError {
  const status = deriveGhHttpStatus(error);
  const stderr = String(
    (error as { stderr?: unknown } | null)?.stderr ?? '',
  ).trim();
  const message =
    stderr || (error instanceof Error ? error.message : String(error));
  const wrapped = new Error(message) as Error & ProviderError;
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
function assertNoGraphqlErrors(payload: unknown, context: string): void {
  const errors = (payload as { errors?: { message?: unknown }[] } | null)
    ?.errors;
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
function sleepSync(ms: number): void {
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
 * unrelated API call succeeded). Before every retry, re-read the full
 * (paginated) comment history for an exact-body match: found means the
 * prior attempt actually landed, so return that comment instead of posting
 * again; not found means the prior attempt genuinely failed, so back off
 * and retry the POST. This scan is best-effort only (a transient read
 * failure here must never block the retry it is meant to protect) and only
 * ever runs on the error path, never the common single-attempt success
 * path. Requests the maximum page size (Copilot review, #2504) to bound
 * pagination overhead on a heavily-commented issue/PR.
 */
function findRecentExactBodyMatch(
  deps: GithubProviderAdapterDeps,
  repoPath: string,
  number: number,
  body: string,
): ProviderPostedComment | null {
  // The whole read-and-scan is wrapped in one try/catch, not just the
  // `ghApiJson` call: a malformed row (e.g. a stray `null` entry) thrown
  // from the loop body below must fail this best-effort scan the same
  // way a transport failure does, never abort the retry it exists to
  // protect (Copilot review, #2504).
  try {
    const rows = deps.ghApiJson(
      `${repoPath}/issues/${number}/comments?per_page=100`,
      { paginate: true },
    ) as { id?: unknown; body?: unknown; html_url?: unknown }[];
    let newest: { id: number; htmlUrl: string } | null = null;
    for (const row of rows) {
      if (row === null || typeof row !== 'object') {
        continue;
      }
      if (String(row.body ?? '') !== body) {
        continue;
      }
      const id = Number(row.id);
      const htmlUrl = String(row.html_url ?? '');
      // Same shape requirement as the fresh-POST path below -- a match
      // with no usable id/html_url is not a usable result, so keep
      // scanning instead of returning a comment the caller couldn't
      // act on.
      if (!Number.isInteger(id) || id <= 0 || htmlUrl === '') {
        continue;
      }
      // Comments come back in ascending creation order; keep the last
      // (most recent) exact-body match in the unlikely event more than
      // one exists.
      newest = { id, htmlUrl };
    }
    return newest;
  } catch {
    return null;
  }
}

/**
 * #2460 (Copilot review, #2504): a malformed-but-200 POST response is a
 * shape bug, not a transport blip -- retrying it is unlikely to help, and
 * doing so anyway risks a double-post if the best-effort dedupe read
 * ({@link findRecentExactBodyMatch}) itself fails. A dedicated error class
 * lets {@link postWorkItemCommentWithRetry}'s catch block recognize this
 * case and fail fast instead of consuming the remaining bounded attempts.
 */
class MalformedPostWorkItemCommentResponseError extends Error {}

/**
 * #2460: POST a work-item (issue/PR) comment with a bounded retry against
 * transient `gh` failures, guarding against the resulting duplicate-post
 * risk via {@link findRecentExactBodyMatch}, and validating the response
 * shape before treating the marker as posted (catches a 200-with-
 * malformed-body edge case a bare retry would not -- see
 * {@link MalformedPostWorkItemCommentResponseError} for why that specific
 * case fails fast rather than retrying).
 */
function postWorkItemCommentWithRetry(
  deps: GithubProviderAdapterDeps,
  repoPath: string,
  number: number,
  body: string,
): ProviderPostedComment {
  const sleep = deps.sleepSync ?? sleepSync;
  let lastError: unknown;
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
      const parsed = JSON.parse(out) as { id?: unknown; html_url?: unknown };
      const id = Number(parsed.id);
      const htmlUrl = String(parsed.html_url ?? '');
      if (!Number.isInteger(id) || id <= 0 || htmlUrl === '') {
        throw new MalformedPostWorkItemCommentResponseError(
          `postWorkItemComment: malformed POST response for ${repoPath}/issues/${number} (missing id/html_url)`,
        );
      }
      return { id, htmlUrl };
    } catch (error) {
      if (error instanceof MalformedPostWorkItemCommentResponseError) {
        throw error;
      }
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
function safeGhTextLocal(
  deps: GithubProviderAdapterDeps,
  args: string[],
  options: GhTextOptions = {},
): string {
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
function fetchGovernanceOutcome<T>(
  fetchJson: () => T,
): ProviderGovernanceReadOutcome<T> {
  try {
    return { outcome: 'ok', value: fetchJson() };
  } catch (error) {
    if (deriveGhHttpStatus(error) === 404) {
      return { outcome: 'not-found' };
    }
    throw error;
  }
}

/** Raw GraphQL review-thread comment node, as returned regardless of which
 * optional fields (`url`, `pullRequestReview`) the caller's fragment
 * requested. */
interface RawThreadCommentNode {
  body?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  author?: { login?: unknown; __typename?: unknown } | null;
  pullRequestReview?: { id?: unknown } | null;
  databaseId?: unknown;
}

/** Raw GraphQL review-thread node, as {@link fetchReviewThreadsGeneric}
 * returns it -- always carries `id` (needed for per-thread comment-page
 * continuation) regardless of whether the caller's own return shape
 * exposes it. */
interface RawThreadNode {
  id: string;
  isResolved: boolean | null;
  path: string | null;
  comments: RawThreadCommentNode[];
}

interface RawPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
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
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
  commentFieldsFragment: string,
): RawThreadNode[] {
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
  function runQuery(apiArgs: string[]): unknown {
    const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
    assertNoGraphqlErrors(parsed, 'review thread lookup');
    return parsed;
  }
  function walkThreadComments(
    threadId: string,
    firstPageNodes: RawThreadCommentNode[],
    firstPageInfo: RawPageInfo | undefined,
  ): RawThreadCommentNode[] {
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
      ]) as {
        data?: {
          node?: {
            comments?: {
              nodes?: RawThreadCommentNode[];
              pageInfo?: RawPageInfo;
            } | null;
          } | null;
        };
      };
      const nextComments = parsed.data?.node?.comments;
      comments.push(...(nextComments?.nodes ?? []));
      pageInfo = nextComments?.pageInfo;
    }
    return comments;
  }
  const threads: RawThreadNode[] = [];
  let cursor: string | null = null;
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
    const parsed = runQuery(apiArgs) as {
      data?: {
        repository?: {
          pullRequest?: {
            reviewThreads?: {
              nodes?: {
                id?: unknown;
                isResolved?: unknown;
                path?: unknown;
                comments?: {
                  nodes?: RawThreadCommentNode[];
                  pageInfo?: RawPageInfo;
                } | null;
              }[];
              pageInfo?: RawPageInfo;
            } | null;
          } | null;
        } | null;
      };
    };
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
function resolveTraversalGhExitStatus(error: unknown): number | null {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  const rawStatus = candidate?.status ?? candidate?.code;
  return typeof rawStatus === 'number' ? rawStatus : null;
}

/**
 * Wraps a failed `gh` error into the canonical `{ status, stderr }` shape
 * the two classifiers below read. Returns `''` when the exit status is in
 * `allowStatuses` (the 404-tolerance `getWorkItemForTraversalAsync` relies
 * on); otherwise throws.
 */
function wrapTraversalGhFailure(
  error: unknown,
  args: string[],
  allowStatuses: number[],
): string {
  const status = resolveTraversalGhExitStatus(error);
  if (status !== null && allowStatuses.includes(status)) {
    return '';
  }
  const stderr = String(
    (error as { stderr?: unknown } | null)?.stderr ?? '',
  ).trim();
  const prefix = `gh ${args.join(' ')}`;
  const wrapped = new Error(
    stderr ? `${prefix} failed: ${stderr}` : `${prefix} failed`,
  ) as Error & { status?: number | null; stderr?: string };
  wrapped.status = status;
  wrapped.stderr = stderr;
  throw wrapped;
}

function isTraversalInaccessibleError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const rawStatus = (error as { status?: unknown }).status;
  const status = typeof rawStatus === 'number' ? rawStatus : null;
  if (status !== null && TRAVERSAL_INACCESSIBLE_HTTP_STATUSES.has(status)) {
    return true;
  }
  const stderr = String((error as { stderr?: unknown }).stderr ?? '');
  return /Resource not accessible|access denied|Forbidden|Unavailable for legal reasons/i.test(
    stderr,
  );
}

function isTraversalNotFoundError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const candidate = error as { stderr?: unknown; message?: unknown };
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
  /** Backs the three traversal-only `*Async` methods (step 12, #2266). */
  ghTextAsync: typeof ghTextAsync;
  /**
   * Backs {@link postWorkItemCommentWithRetry}'s backoff (#2460). Optional
   * so existing deps overrides that predate this field keep compiling;
   * defaults to the real `Atomics.wait`-based {@link sleepSync}. Inject a
   * no-op in tests to keep them fast.
   */
  sleepSync?: (ms: number) => void;
}

const DEFAULT_DEPS: GithubProviderAdapterDeps = {
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

    getWorkItem(number: number): ProviderWorkItem | null {
      let data: unknown;
      try {
        data = deps.ghApiJson(`${repoPath}/issues/${number}`);
      } catch (error) {
        if (deriveGhHttpStatus(error) === 404) {
          return null;
        }
        throw toProviderError(error);
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

    listIssueNumbersClosedByOpenChangeRequests(limit: number): number[] {
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
      const list = JSON.parse(raw || '[]') as {
        closingIssuesReferences?: { number?: unknown }[];
      }[];
      const numbers = new Set<number>();
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
        updated_at?: unknown;
        user?: { login?: unknown };
      }[];
      return rows.map((row) => ({
        id: Number(row.id),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
    },

    postWorkItemComment(number: number, body: string): ProviderPostedComment {
      return postWorkItemCommentWithRetry(deps, repoPath, number, body);
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
      let raw: string;
      try {
        raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      } catch (error) {
        const stderr = String(
          (error as { stderr?: unknown } | null)?.stderr ?? '',
        );
        if (/no required checks reported/i.test(stderr)) {
          return [];
        }
        const stdout = String(
          (error as { stdout?: unknown } | null)?.stdout ?? '',
        ).trim();
        if (!stdout) {
          throw error;
        }
        raw = stdout;
      }
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

    listChangeRequestReviewThreads(
      number: number,
    ): { isResolved: boolean | null }[] {
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
      const threads: { isResolved: boolean | null }[] = [];
      let cursor: string | null = null;
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
        const parsed = JSON.parse(
          deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS),
        ) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: {
                  nodes?: { isResolved?: unknown }[];
                  pageInfo?: {
                    hasNextPage?: boolean;
                    endCursor?: string | null;
                  };
                } | null;
              } | null;
            } | null;
          };
        };
        const connection = parsed.data?.repository?.pullRequest?.reviewThreads;
        for (const node of connection?.nodes ?? []) {
          threads.push({
            isResolved: (node.isResolved ?? null) as boolean | null,
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

    async getWorkItemForTraversalAsync(
      number: number,
    ): Promise<ProviderTraversalIssueLookup> {
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
            let raw: string;
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

    async listWorkItemSubIssueNodesAsync(number: number): Promise<unknown[]> {
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
      const nodes: unknown[] = [];
      let after = '';
      for (;;) {
        const variables: Record<string, string | number> = {
          owner,
          repo,
          number,
        };
        if (after) {
          variables.after = after;
        }
        const result = (await withBoundedRetry(async () => {
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
            const parsed = JSON.parse(stdout.trim() || '{}') as {
              errors?: unknown;
            };
            if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
              throw new Error(formatTraversalGraphqlErrors(parsed.errors));
            }
            return parsed;
          } catch (error) {
            const stderr = String(
              (error as { stderr?: unknown } | null)?.stderr ?? '',
            ).trim();
            const detail = stderr || (error as Error).message;
            throw new Error(`gh api graphql failed: ${detail}`);
          }
        })) as {
          data?: {
            repository?: {
              issue?: {
                subIssues?: {
                  nodes?: unknown;
                  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown };
                };
              };
            };
          };
        };
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

    async listWorkItemCommentsWithRetryAsync(
      number: number,
    ): Promise<unknown[]> {
      const comments: unknown[] = [];
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

    searchOpenWorkItems(query: {
      label?: string;
      matchBody?: string;
      fields: string[];
      limit: number;
    }): unknown[] {
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

    getRepositoryDefaultBranch(
      defaultBranchOwner: string,
      defaultBranchRepo: string,
    ): string | null {
      return readGithubRepoDefaultBranch(defaultBranchOwner, defaultBranchRepo);
    },

    resolveViewerAppSlugSafe(): { appSlug: string; unavailable: boolean } {
      const raw = safeGhTextLocal(
        deps,
        ['api', 'app', '--jq', '.slug // .app_slug // empty'],
        GH_TEXT_LOOP_OPTIONS,
      ).trim();
      return raw
        ? { appSlug: raw, unavailable: false }
        : { appSlug: '', unavailable: true };
    },

    resolveViewerLoginSafeQuiet(): {
      viewerLogin: string;
      viewerLoginUnavailable: boolean;
    } {
      // #2267: mirrors resolveViewerLoginSafe's query/never-throw contract,
      // but with advisory-convergence.mts's own env-conditional stdio (CI
      // stays silent/piped; a local run's stderr stays visible to the
      // operator watching it) -- see this method's doc comment in
      // provider-port.mts for why it is not folded into the existing one.
      const stdio: GhTextOptions['stdio'] = process.env.GITHUB_ACTIONS
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

    getRepositoryContentAtRef(
      contentOwner: string,
      contentRepo: string,
      path: string,
      ref: string,
    ): unknown | null {
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

    getRepositoryFileContentAtRef(
      repoRef: string,
      path: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<string> {
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

    getTeamMembershipStateSafe(
      org: string,
      teamSlug: string,
      login: string,
    ): string {
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

    getChangeRequestHeadShaAndAuthor(
      number: number,
    ): ProviderChangeRequestHeadShaAndAuthor {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,author',
      ]);
      const parsed = JSON.parse(raw) as {
        headRefOid?: unknown;
        author?: { login?: unknown } | null;
      };
      return {
        headSha: String(parsed.headRefOid ?? ''),
        authorLogin: String(parsed.author?.login ?? ''),
      };
    },

    getChangeRequestConvergenceView(
      number: number,
    ): ProviderChangeRequestConvergenceView {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,headRefName,closingIssuesReferences,author,url',
      ]);
      const parsed = JSON.parse(raw) as {
        headRefOid?: unknown;
        headRefName?: unknown;
        author?: { login?: unknown } | null;
        url?: unknown;
        closingIssuesReferences?: unknown;
      };
      return {
        headSha: String(parsed.headRefOid ?? ''),
        headRefName: String(parsed.headRefName ?? ''),
        authorLogin: String(parsed.author?.login ?? ''),
        url: String(parsed.url ?? ''),
        closingIssuesReferences: parsed.closingIssuesReferences,
      };
    },

    getChangeRequestReadinessSnapshot(
      number: number,
    ): ProviderChangeRequestReadinessSnapshot {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,baseRefName,url,author,reviewDecision,statusCheckRollup,mergeable,mergeStateStatus,closingIssuesReferences',
      ]);
      const parsed = JSON.parse(raw) as {
        headRefOid?: unknown;
        baseRefName?: unknown;
        url?: unknown;
        author?: { login?: unknown } | null;
        reviewDecision?: unknown;
        statusCheckRollup?: unknown;
        mergeable?: unknown;
        mergeStateStatus?: unknown;
        closingIssuesReferences?: unknown;
      };
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

    getChangeRequestBranchAndChecks(
      number: number,
    ): ProviderChangeRequestBranchAndChecks {
      const raw = deps.ghText([
        'pr',
        'view',
        String(number),
        '-R',
        `${owner}/${repo}`,
        '--json',
        'headRefOid,baseRefName,statusCheckRollup',
      ]);
      const parsed = JSON.parse(raw) as {
        headRefOid?: unknown;
        baseRefName?: unknown;
        statusCheckRollup?: unknown;
      };
      return {
        headSha: String(parsed.headRefOid ?? ''),
        baseRefName: String(parsed.baseRefName ?? ''),
        statusCheckRollup: parsed.statusCheckRollup,
      };
    },

    getChangeRequestHeadRef(number: number): string {
      return deps.ghText([
        'api',
        `${repoPath}/pulls/${number}`,
        '--jq',
        '.head.ref',
      ]);
    },

    listMergedChangeRequests(
      limit: number,
      sinceDate: string | null,
    ): ProviderMergedChangeRequestSummary[] {
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
      const rows = JSON.parse(raw || '[]') as {
        number?: unknown;
        mergedAt?: unknown;
      }[];
      return rows.map((row) => ({
        number: Number(row.number),
        mergedAt: String(row.mergedAt ?? ''),
      }));
    },

    getMergedChangeRequestMeta(
      number: number,
    ): ProviderMergedChangeRequestMeta | null {
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
      const parsed = raw as {
        data?: {
          repository?: {
            pullRequest?: {
              number?: unknown;
              merged?: unknown;
              mergedAt?: unknown;
              mergeCommit?: { oid?: unknown } | null;
            } | null;
          } | null;
        };
      };
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

    listChangeRequestChecks(number: number): ProviderRequiredCheck[] {
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
      let raw: string;
      try {
        raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      } catch (error) {
        const status = Number(
          (error as { status?: unknown } | null)?.status ?? -1,
        );
        const stdout = String(
          (error as { stdout?: unknown } | null)?.stdout ?? '',
        );
        if (![1, 8].includes(status) || !/^\s*[[{]/.test(stdout)) {
          throw error;
        }
        raw = stdout;
      }
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

    getChangeRequestRequestedReviewerLogins(number: number): string[] {
      const result = deps.ghApiJson(
        `${repoPath}/pulls/${number}/requested_reviewers`,
      ) as { users?: { login?: unknown }[] };
      return (result.users ?? []).map((user) => String(user.login ?? ''));
    },

    getChangeRequestRequestedReviewerLoginsGraphql(
      number: number,
    ): string[] | null {
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
        const parsed = JSON.parse(
          deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS),
        ) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewRequests?: {
                  nodes?: { requestedReviewer?: { login?: unknown } | null }[];
                } | null;
              } | null;
            } | null;
          };
        };
        const nodes =
          parsed.data?.repository?.pullRequest?.reviewRequests?.nodes ?? [];
        return nodes
          .map((node) => node.requestedReviewer?.login)
          .filter((login): login is string => typeof login === 'string');
      } catch {
        return null;
      }
    },

    listChangeRequestChangedFiles(number: number): string[] {
      const rows = deps.ghApiJson(`${repoPath}/pulls/${number}/files`, {
        paginate: true,
      }) as { filename?: unknown }[];
      return rows.map((row) => String(row.filename ?? ''));
    },

    listChangeRequestCommits(number: number): unknown[] {
      return deps.ghApiJson(`${repoPath}/pulls/${number}/commits`, {
        paginate: true,
      }) as unknown[];
    },

    listChangeRequestReviewThreadsWithComments(
      number: number,
    ): ProviderReviewThreadWithComments[] {
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

    listChangeRequestReviewThreadsExtended(
      number: number,
    ): ProviderReviewThreadExtended[] {
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

    listChangeRequestReviewThreadCommentIds(
      number: number,
    ): ProviderReviewThreadCommentIds[] {
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
          .filter((id): id is number => typeof id === 'number'),
      }));
    },

    listChangeRequestGraphqlComments(number: number): ProviderGraphqlComment[] {
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
      const out: ProviderGraphqlComment[] = [];
      let cursor: string | null = null;
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
        const parsed = rawComments as {
          data?: {
            repository?: {
              pullRequest?: {
                comments?: {
                  nodes?: {
                    body?: unknown;
                    url?: unknown;
                    createdAt?: unknown;
                    updatedAt?: unknown;
                    author?: { login?: unknown } | null;
                  }[];
                  pageInfo?: {
                    hasNextPage?: boolean;
                    endCursor?: string | null;
                  };
                } | null;
              } | null;
            } | null;
          };
        };
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

    listChangeRequestGraphqlReviews(number: number): ProviderGraphqlReview[] {
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
      const out: ProviderGraphqlReview[] = [];
      let cursor: string | null = null;
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
        const parsed = rawReviews as {
          data?: {
            repository?: {
              pullRequest?: {
                reviews?: {
                  nodes?: {
                    body?: unknown;
                    url?: unknown;
                    state?: unknown;
                    submittedAt?: unknown;
                    author?: { login?: unknown } | null;
                  }[];
                  pageInfo?: {
                    hasNextPage?: boolean;
                    endCursor?: string | null;
                  };
                } | null;
              } | null;
            } | null;
          };
        };
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

    listBranchRules(
      rulesOwner: string,
      rulesRepo: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<unknown[]> {
      return fetchGovernanceOutcome(
        () =>
          deps.ghApiJson(
            `repos/${rulesOwner}/${rulesRepo}/rules/branches/${encodeURIComponent(ref)}`,
            { paginate: true },
          ) as unknown[],
      );
    },

    getBranchProtection(
      protectionOwner: string,
      protectionRepo: string,
      ref: string,
    ): ProviderGovernanceReadOutcome<unknown> {
      return fetchGovernanceOutcome(() =>
        deps.ghApiJson(
          `repos/${protectionOwner}/${protectionRepo}/branches/${encodeURIComponent(ref)}/protection`,
        ),
      );
    },

    getRepositoryRulesetDetail(
      path: string,
    ): ProviderGovernanceReadOutcome<unknown> {
      return fetchGovernanceOutcome(() =>
        deps.ghApiJson(path, {
          extraArgs: ['-H', 'Accept: application/vnd.github+json'],
        }),
      );
    },

    getWorkflowRun(
      runOwner: string,
      runRepo: string,
      runId: string | number,
    ): unknown {
      const raw = deps.ghText(
        ['api', `repos/${runOwner}/${runRepo}/actions/runs/${runId}`],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      );
      return JSON.parse(raw.trim() || '{}');
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
      const rows = JSON.parse(raw || '[]') as {
        databaseId?: unknown;
        conclusion?: unknown;
        status?: unknown;
        createdAt?: unknown;
      }[];
      return rows.map((row) => ({
        // String(...), not Number(...): preserves a databaseId above
        // Number.MAX_SAFE_INTEGER exactly (Codex review, PR #2429).
        id: String(row.databaseId ?? ''),
        conclusion: row.conclusion == null ? null : String(row.conclusion),
        status: String(row.status ?? ''),
        createdAt: String(row.createdAt ?? ''),
      }));
    },

    getChangeRequestHeadShaAtRepo(
      atRepoOwner: string,
      atRepoRepo: string,
      number: number,
    ): string {
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

    getChangeRequestAtRepo(
      atRepoOwner: string,
      atRepoRepo: string,
      number: number,
    ): ProviderChangeRequestState | null {
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

    mergeChangeRequestAtRepo(
      mergeOwner: string,
      mergeRepo: string,
      number: number,
      headSha: string,
    ): string {
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

    mergeChangeRequestAdminAtRepo(
      mergeOwner: string,
      mergeRepo: string,
      number: number,
      headSha: string,
    ): string {
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

    getChangeRequestAuthor(number: number): ProviderChangeRequestAuthor | null {
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
      const parsed = rawAuthor as {
        data?: {
          repository?: {
            pullRequest?: {
              author?: { login?: unknown; __typename?: unknown } | null;
            } | null;
          } | null;
        } | null;
      };
      const author = parsed.data?.repository?.pullRequest?.author;
      if (!author) {
        return null;
      }
      return {
        login: String(author.login ?? ''),
        typename: author.__typename == null ? null : String(author.__typename),
      };
    },

    listChangeRequestReviewThreadsWithAuthorType(
      number: number,
    ): ProviderReviewThreadWithAuthorType[] {
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

    getChangeRequestReviewsWithHeadCommitDate(
      number: number,
    ): ProviderReviewsWithHeadCommitDate {
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
      const nodes: {
        id?: unknown;
        commit?: { oid?: unknown } | null;
        submittedAt?: unknown;
        author?: { login?: unknown; __typename?: unknown } | null;
        comments?: { totalCount?: unknown } | null;
        body?: unknown;
      }[] = [];
      let headCommittedAt = '';
      let cursor: string | null = null;
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
        const parsed = raw as {
          data?: {
            repository?: {
              pullRequest?: {
                reviews?: {
                  pageInfo?: {
                    hasNextPage?: boolean;
                    endCursor?: string | null;
                  };
                  nodes?: typeof nodes;
                } | null;
                commits?: {
                  nodes?: { commit?: { committedDate?: unknown } | null }[];
                } | null;
              } | null;
            } | null;
          };
        };
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

    mergeChangeRequest(number: number, headSha: string): string {
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

    mergeChangeRequestAdmin(number: number, headSha: string): string {
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

    postReviewCommentReply(
      number: number,
      commentId: number,
      body: string,
    ): { id: number } {
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
      const parsed = JSON.parse(out) as { id: number };
      return { id: parsed.id };
    },

    resolveChangeRequestReviewThread(threadId: string): void {
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
      const parsed = raw as {
        data?: { resolveReviewThread?: { thread?: { isResolved?: unknown } } };
      };
      if (parsed.data?.resolveReviewThread?.thread?.isResolved !== true) {
        throw new Error(
          `resolveChangeRequestReviewThread: GitHub did not confirm thread ${threadId} as resolved`,
        );
      }
    },

    listCapabilityDeclarations(): ProviderCapabilityDeclaration[] {
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
function formatTraversalGraphqlErrors(errors: unknown[]): string {
  return errors
    .map((error) =>
      String(
        (error as { message?: unknown } | null)?.message ??
          'unknown GraphQL error',
      ),
    )
    .join('; ');
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
