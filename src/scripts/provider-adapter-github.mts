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
import {
  classifyInaccessibleIssueLookup,
  deriveGhHttpStatus,
  ghErrorText,
} from './gh-http-status.mts';
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
  ProviderCheckRunWorkflowPath,
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
  ProviderRequiredChecksSummary,
  ProviderReviewsWithHeadCommitDate,
  ProviderReviewThreadCommentIds,
  ProviderReviewThreadExtended,
  ProviderReviewThreadWithAuthorType,
  ProviderReviewThreadWithComments,
  ProviderTimelineEvent,
  ProviderTraversalIssueLookup,
  ProviderUserContentEdit,
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
 * #3246: map a raw GraphQL `lastEditedAt` field value onto
 * {@link ProviderComment.lastEditedAt}'s three-state contract. Used by
 * every ALREADY-GraphQL comment query (review threads,
 * `listChangeRequestGraphqlComments`) that selects this field
 * unconditionally -- `undefined` here means the field came back missing,
 * empty, or unparseable on an otherwise-successful response, never a
 * transport failure (a failed call throws before this runs).
 */
function mapLastEditedAt(raw: unknown): string | null | undefined {
  if (raw === null) {
    return null;
  }
  if (
    typeof raw === 'string' &&
    raw.trim() !== '' &&
    !Number.isNaN(Date.parse(raw))
  ) {
    return raw;
  }
  return undefined;
}

/**
 * #3246: batch-resolve GraphQL `IssueComment.lastEditedAt` for the given
 * comment node ids via `nodes(ids:)`, chunked to 100 ids per request
 * (matching this file's own `first:100` page-size convention). Backs
 * {@link ProviderPort.listWorkItemComments}'s and
 * {@link ProviderPort.listWorkItemCommentsWithRetryAsync}'s opt-in
 * `includeEditState` -- both read REST `issues/{n}/comments`, which has
 * no edit-timestamp field, so resolving it needs this separate GraphQL
 * round trip. Exported so `external-check-waiver.mts` -- which predates
 * the #2266 provider-port migration and still calls `gh` directly for its
 * own REST comment read (needing `html_url`/`url`, fields
 * {@link ProviderComment} does not carry) -- can share this one
 * resolution instead of forking a second copy.
 *
 * Every requested id must resolve to a well-formed `IssueComment` node
 * with a three-state-contract-valid `lastEditedAt`
 * (`null`/parseable-timestamp): a missing, mismatched, or malformed node
 * throws rather than silently reporting 'unknown' for a caller that
 * explicitly opted in and needs a definitive answer -- mirrors this
 * file's other GraphQL methods' fail-fast-on-malformed-page contract.
 */
export function fetchLastEditedAtByNodeId(
  ghTextFn: typeof ghText,
  nodeIds: string[],
): Map<string, string | null> {
  const result = new Map<string, string | null>();
  if (nodeIds.length === 0) {
    return result;
  }
  const query = `query($ids:[ID!]!){
  nodes(ids:$ids) { id ... on IssueComment { lastEditedAt } }
}`;
  const chunkSize = 100;
  for (let start = 0; start < nodeIds.length; start += chunkSize) {
    const chunk = nodeIds.slice(start, start + chunkSize);
    const apiArgs = [
      'api',
      'graphql',
      ...graphqlHostnameArgs(),
      '-f',
      `query=${query}`,
      ...chunk.flatMap((id) => ['-f', `ids[]=${id}`]),
    ];
    const parsed = JSON.parse(ghTextFn(apiArgs, GH_TEXT_LOOP_OPTIONS));
    assertNoGraphqlErrors(parsed, 'fetchLastEditedAtByNodeId');
    const nodes = (parsed as { data?: { nodes?: unknown[] } })?.data?.nodes;
    if (!Array.isArray(nodes) || nodes.length !== chunk.length) {
      throw new Error(
        `fetchLastEditedAtByNodeId: expected ${chunk.length} node(s), got ${
          Array.isArray(nodes) ? nodes.length : 'none'
        }`,
      );
    }
    nodes.forEach((node, index) => {
      const expectedId = chunk[index];
      const typed = node as { id?: unknown; lastEditedAt?: unknown } | null;
      if (typed == null || String(typed.id ?? '') !== expectedId) {
        throw new Error(
          `fetchLastEditedAtByNodeId: node ${expectedId} missing or mismatched in response`,
        );
      }
      const mapped = mapLastEditedAt(typed.lastEditedAt);
      if (mapped === undefined) {
        throw new Error(
          `fetchLastEditedAtByNodeId: node ${expectedId} has a missing/unparseable lastEditedAt`,
        );
      }
      result.set(expectedId, mapped);
    });
  }
  return result;
}

/**
 * Backs {@link ProviderPort.getWorkItemUserContentEdits} (via
 * {@link fetchWorkItemUserContentEdits}'s full backward-pagination loop
 * over this single-page fetch) and, directly (one call, no pagination --
 * Codex review, PR #2840, round 12; previously a thin `.map` over the
 * former's full result, which paginated the entire history just to read
 * one timestamp), {@link ProviderPort.getWorkItemUserContentEditTimestamps}.
 * Extracted to a standalone function, rather than one method calling the
 * other via `this`, since every other method on the returned adapter
 * object is a plain closure over `deps`/`owner`/`repo` with no `this`
 * usage anywhere else in this file.
 *
 * #2767: widened from #2762's original `editedAt`-only query to also
 * select `editor { login }`, so a caller can evaluate WHO made each edit
 * (a `trustedEditor` structural-evidence signal) as well as WHEN.
 * `editor` resolves to `null` for a deleted/ghost account -- GitHub still
 * records the edit itself.
 */
/** Bounds the backward-pagination loop in {@link fetchWorkItemUserContentEdits}
 * below: 10 pages of 100 edits each (1,000 total) is far beyond any
 * realistic issue's edit history, so hitting it indicates a runaway
 * connection (or a malicious/corrupted response) rather than a genuine
 * long-lived issue -- fail closed (throw) past this rather than silently
 * truncating the trust-relevant editor set the way the un-paginated
 * `last:100` query already did. */
const USER_CONTENT_EDITS_MAX_PAGES = 10;

/** Bounds the forward-pagination loop in
 * {@link fetchCheckRunWorkflowPaths} (kurone-kito/idd-skill#2926, Copilot +
 * Codex review, PR #2930): 20 pages of 100 check suites each (2,000 total)
 * is far beyond any realistic commit's check-suite count -- fail closed
 * (throw) past this rather than silently truncating the coverage the
 * un-paginated `first:100` query originally claimed but did not enforce. */
const CHECK_RUN_WORKFLOW_PATH_MAX_PAGES = 20;

/** Bounds the forward-pagination loop for a PR's status-check rollup. */
const STATUS_CHECK_ROLLUP_MAX_PAGES = 20;

function normalizeStatusCheckRollupNode(
  node: unknown,
): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return null;
  }
  const raw = node as Record<string, unknown>;
  const type = String(raw.__typename ?? '');
  if (type === 'CheckRun') {
    const checkSuite =
      raw.checkSuite &&
      typeof raw.checkSuite === 'object' &&
      !Array.isArray(raw.checkSuite)
        ? (raw.checkSuite as Record<string, unknown>)
        : {};
    const app =
      checkSuite.app &&
      typeof checkSuite.app === 'object' &&
      !Array.isArray(checkSuite.app)
        ? (checkSuite.app as Record<string, unknown>)
        : {};
    const rawWorkflowRun = checkSuite.workflowRun;
    const workflowRunPresent =
      rawWorkflowRun !== null &&
      typeof rawWorkflowRun === 'object' &&
      !Array.isArray(rawWorkflowRun);
    const workflowRun = workflowRunPresent
      ? (rawWorkflowRun as Record<string, unknown>)
      : {};
    const file =
      workflowRun.file &&
      typeof workflowRun.file === 'object' &&
      !Array.isArray(workflowRun.file)
        ? (workflowRun.file as Record<string, unknown>)
        : {};
    const workflow =
      workflowRun.workflow &&
      typeof workflowRun.workflow === 'object' &&
      !Array.isArray(workflowRun.workflow)
        ? (workflowRun.workflow as Record<string, unknown>)
        : {};
    return {
      __typename: 'CheckRun',
      name: raw.name,
      status: raw.status,
      conclusion: raw.conclusion,
      detailsUrl: raw.detailsUrl,
      startedAt: raw.startedAt,
      completedAt: raw.completedAt,
      appSlug: app.slug == null ? null : String(app.slug).trim() || null,
      workflowRunPresent,
      // GitHub's GraphQL statusCheckRollup does not expose workflowName or
      // workflowPath directly; derive both from the check suite's associated
      // workflow run, whose identity is provider-owned rather than inferred
      // from a check-run display name.
      workflowName: String(workflow.name ?? ''),
      workflowPath: file.path == null ? null : String(file.path),
    };
  }
  if (type === 'StatusContext') {
    return {
      __typename: 'StatusContext',
      context: raw.context,
      state: raw.state,
      targetUrl: raw.targetUrl,
      // StatusContext has no startedAt field in GraphQL. Its creation time is
      // the closest equivalent and preserves the ordering signal gh exposes.
      startedAt: raw.createdAt,
    };
  }
  return raw;
}

/** Fetch the complete, workflow-identity-enriched status rollup for a PR. */
function fetchChangeRequestBranchAndChecks(
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
): ProviderChangeRequestBranchAndChecks {
  let after: string | null = null;
  let headSha = '';
  let baseRefName = '';
  const statusCheckRollup: Record<string, unknown>[] = [];

  for (let page = 0; page < STATUS_CHECK_ROLLUP_MAX_PAGES; page += 1) {
    const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      headRefOid
      baseRefName
      statusCheckRollup{
        contexts(first:100,after:$after){
          nodes{
            __typename
            ... on CheckRun{
              name status conclusion detailsUrl startedAt completedAt
              checkSuite{
                app{slug}
                workflowRun{
                  file{path}
                  workflow{name}
                }
              }
            }
            ... on StatusContext{context state targetUrl createdAt}
          }
          pageInfo{hasNextPage endCursor}
        }
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
    if (after) {
      apiArgs.push('-f', `after=${after}`);
    }
    const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
    assertNoGraphqlErrors(raw, 'getChangeRequestBranchAndChecks');
    const pullRequest = raw?.data?.repository?.pullRequest as
      | {
          headRefOid?: unknown;
          baseRefName?: unknown;
          statusCheckRollup?: {
            contexts?: {
              nodes?: unknown;
              pageInfo?: {
                hasNextPage?: unknown;
                endCursor?: unknown;
              };
            } | null;
          } | null;
        }
      | null
      | undefined;
    if (!pullRequest) {
      throw new Error(
        `getChangeRequestBranchAndChecks failed: pull request #${number} was not found`,
      );
    }
    const pageHeadSha = String(pullRequest.headRefOid ?? '');
    const pageBaseRefName = String(pullRequest.baseRefName ?? '');
    if (page === 0) {
      headSha = pageHeadSha;
      baseRefName = pageBaseRefName;
    } else if (pageHeadSha !== headSha || pageBaseRefName !== baseRefName) {
      throw new Error(
        'getChangeRequestBranchAndChecks: PR head or base ref changed during status-check pagination',
      );
    }
    const contexts = pullRequest.statusCheckRollup?.contexts;
    for (const node of Array.isArray(contexts?.nodes) ? contexts.nodes : []) {
      const normalized = normalizeStatusCheckRollupNode(node);
      if (normalized) {
        statusCheckRollup.push(normalized);
      }
    }
    const hasNextPage = contexts?.pageInfo?.hasNextPage === true;
    if (!hasNextPage) {
      return { headSha, baseRefName, statusCheckRollup };
    }
    const nextCursor = String(contexts?.pageInfo?.endCursor ?? '');
    if (!nextCursor) {
      throw new Error(
        'getChangeRequestBranchAndChecks: page reported hasNextPage without endCursor',
      );
    }
    after = nextCursor;
  }

  throw new Error(
    `getChangeRequestBranchAndChecks: exceeded ${STATUS_CHECK_ROLLUP_MAX_PAGES} status-check pages`,
  );
}

/**
 * One page of {@link listCheckRunWorkflowPaths}'s check-suite connection,
 * flattened into `{detailsUrl, workflowPath}` entries.
 *
 * kurone-kito/idd-skill#2926 (Copilot review, PR #2930): a check suite
 * legitimately produces AT MOST ONE check-run instance of a given name --
 * the documented multi-instance `idd-advisory-convergence` scenario always
 * arises from TWO SEPARATE workflow runs (two separate check suites), never
 * two check-runs sharing ONE suite. More than one same-named check-run in a
 * single suite is exactly what GitHub's own documented check-suite pooling
 * quirk produces when a forged check-run -- its own unique `detailsUrl`, so
 * the caller's duplicate-`detailsUrl` defense never fires on it -- gets
 * attached to an existing GENUINE suite instead of its own creating job's
 * suite: the collector would otherwise hand that suite's real
 * `workflowPath` to the forged instance too, reopening the exact
 * `groupChecksByProducer` dedup this issue exists to close. So a suite
 * with more than one matching check-run reports `workflowPath: null` for
 * ALL of them -- unresolved, never silently trusted -- rather than reports
 * the suite's real path for any of them. This empirically does NOT
 * conflict with this repository's own `gh run rerun`-based recovery
 * (`rerun-advisory-convergence.mts`): a live check against this issue's
 * own PR #2930, whose `idd-advisory-convergence` check was itself rerun 3
 * times during review, still showed exactly one matching check-run per
 * suite throughout (Codex review round 3 raised this as a P1 concern;
 * rejected with that evidence -- see the PR's own review thread).
 *
 * The "more than one" count uses the RAW node list, including any `null`
 * entries (round 3 -- Copilot review, PR #2930): filtering nulls out
 * first let `[validCheckRun, null]` look like a trusted singleton even
 * though a second, unidentifiable check-run could be hiding behind the
 * `null`.
 */
function checkRunWorkflowPathsFromSuiteNodes(
  suiteNodes: unknown,
): ProviderCheckRunWorkflowPath[] {
  const out: ProviderCheckRunWorkflowPath[] = [];
  if (!Array.isArray(suiteNodes)) {
    return out;
  }
  for (const suite of suiteNodes as ({
    workflowRun?: { file?: { path?: unknown } | null } | null;
    checkRuns?: { nodes?: ({ detailsUrl?: unknown } | null)[] } | null;
  } | null)[]) {
    // GraphQL can return a `null` list item for a nullable type under a
    // partial-error response -- guarded explicitly (matching this file's
    // `Array.isArray` convention) rather than relying on the sole caller's
    // try/catch to turn a thrown TypeError into the same fail-closed
    // outcome a skip already produces here.
    if (!suite) continue;
    const path = suite.workflowRun?.file?.path;
    const workflowPath = path == null ? null : String(path);
    const checkRunNodes = suite.checkRuns?.nodes;
    if (!Array.isArray(checkRunNodes)) continue;
    // kurone-kito/idd-skill#2926 (round 3 -- Copilot review, PR #2930):
    // count the RAW node list, INCLUDING any `null` entries, not just the
    // live ones filtered below -- a `null` item can mask an ADDITIONAL
    // check-run this defense cannot otherwise identify, so
    // `[validCheckRun, null]` must be treated exactly like two live
    // check-runs (unresolved), never silently trusted as a singleton.
    const suiteWorkflowPath = checkRunNodes.length > 1 ? null : workflowPath;
    const liveCheckRuns = checkRunNodes.filter(
      (checkRun): checkRun is { detailsUrl?: unknown } => !!checkRun,
    );
    for (const checkRun of liveCheckRuns) {
      out.push({
        detailsUrl: String(checkRun.detailsUrl ?? ''),
        workflowPath: suiteWorkflowPath,
      });
    }
  }
  return out;
}

/** One page of {@link listCheckRunWorkflowPaths}'s underlying GraphQL
 * connection -- kept a separate function so the loop in
 * {@link fetchCheckRunWorkflowPaths} reads the same way
 * {@link fetchWorkItemUserContentEditsPage} / its own caller do above. */
function fetchCheckRunWorkflowPathsPage(
  deps: GithubProviderAdapterDeps,
  pathsOwner: string,
  pathsRepo: string,
  headSha: string,
  checkName: string,
  after: string | null,
): {
  entries: ProviderCheckRunWorkflowPath[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  // The per-suite `checkRuns(first:50, ...)` page is deliberately NOT
  // itself paginated: a suite with more than one matching check-run is
  // ALREADY reported fully unresolved by
  // {@link checkRunWorkflowPathsFromSuiteNodes} regardless of the EXACT
  // count beyond one, so a truncated inner page can never turn an
  // unresolved suite into a falsely-trusted one -- only the OUTER
  // check-suite connection (whose total count can legitimately be large,
  // e.g. one suite per Actions workflow file times reruns) needs a real
  // pagination loop.
  const query = `query($owner:String!,$repo:String!,$sha:GitObjectID!,$name:String!,$after:String){
  repository(owner:$owner,name:$repo){
    object(oid:$sha){
      ... on Commit {
        checkSuites(first:100, after:$after){
          nodes{
            workflowRun{ file{ path } }
            checkRuns(first:50, filterBy:{checkName:$name}){
              nodes{ detailsUrl }
            }
          }
          pageInfo{ hasNextPage endCursor }
        }
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
    `owner=${pathsOwner}`,
    '-f',
    `repo=${pathsRepo}`,
    '-f',
    `sha=${headSha}`,
    '-f',
    `name=${checkName}`,
  ];
  if (after) {
    apiArgs.push('-f', `after=${after}`);
  }
  const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
  assertNoGraphqlErrors(raw, 'listCheckRunWorkflowPaths');
  const parsed = raw as {
    data?: {
      repository?: {
        object?: {
          checkSuites?: {
            nodes?: unknown;
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          } | null;
        } | null;
      } | null;
    };
  };
  const connection = parsed.data?.repository?.object?.checkSuites;
  return {
    entries: checkRunWorkflowPathsFromSuiteNodes(connection?.nodes),
    hasNextPage: connection?.pageInfo?.hasNextPage ?? false,
    endCursor: connection?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Full-walk pagination for {@link ProviderPort.listCheckRunWorkflowPaths}
 * (kurone-kito/idd-skill#2926, round 2 -- Copilot + Codex review, PR
 * #2930): the original `checkSuites(first:100)` alone was not accompanied
 * by pagination, so a commit with more than 100 check suites silently lost
 * coverage the port method's own contract claims to provide, which could
 * downgrade an otherwise-passing required check to identity-unresolved.
 * Mirrors {@link fetchWorkItemUserContentEdits}'s own bounded full-walk
 * loop shape and failure modes (throw past
 * {@link CHECK_RUN_WORKFLOW_PATH_MAX_PAGES}; throw on `hasNextPage` without
 * an `endCursor`) rather than introducing a new pagination idiom.
 */
function fetchCheckRunWorkflowPaths(
  deps: GithubProviderAdapterDeps,
  pathsOwner: string,
  pathsRepo: string,
  headSha: string,
  checkName: string,
): ProviderCheckRunWorkflowPath[] {
  const out: ProviderCheckRunWorkflowPath[] = [];
  let after: string | null = null;
  for (let page = 0; page < CHECK_RUN_WORKFLOW_PATH_MAX_PAGES; page += 1) {
    const result = fetchCheckRunWorkflowPathsPage(
      deps,
      pathsOwner,
      pathsRepo,
      headSha,
      checkName,
      after,
    );
    out.push(...result.entries);
    if (!result.hasNextPage) {
      return out;
    }
    if (!result.endCursor) {
      throw new Error(
        'listCheckRunWorkflowPaths: page reported hasNextPage without endCursor',
      );
    }
    after = result.endCursor;
  }
  throw new Error(
    `listCheckRunWorkflowPaths: exceeded ${CHECK_RUN_WORKFLOW_PATH_MAX_PAGES} check-suite pages`,
  );
}

const HEAD_OBSERVED_AT_MAX_PAGES = 20;

/** One page of {@link ProviderPort.getChangeRequestHeadObservedAt}'s
 * underlying GraphQL connection -- same split-into-a-page-function shape as
 * {@link fetchCheckRunWorkflowPathsPage}. Re-selects `headRefOid` and the
 * queried commit's own `oid` on every page (not only the first) so the
 * caller can detect a HEAD move mid-walk at any point, not only at the
 * start. */
function fetchChangeRequestHeadObservedAtPage(
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
  after: string | null,
): {
  headRefOid: string;
  commitOid: string;
  createdAts: string[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      headRefOid
      commits(last:1){
        nodes{
          commit{
            oid
            checkSuites(first:100, after:$after){
              nodes{ createdAt }
              pageInfo{ hasNextPage endCursor }
            }
          }
        }
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
  if (after) {
    apiArgs.push('-f', `after=${after}`);
  }
  const raw = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS));
  assertNoGraphqlErrors(raw, 'getChangeRequestHeadObservedAt');
  const parsed = raw as {
    data?: {
      repository?: {
        pullRequest?: {
          headRefOid?: unknown;
          commits?: {
            nodes?:
              | {
                  commit?: {
                    oid?: unknown;
                    checkSuites?: {
                      nodes?: { createdAt?: unknown }[];
                      pageInfo?: {
                        hasNextPage?: boolean;
                        endCursor?: string | null;
                      };
                    } | null;
                  } | null;
                }[]
              | null;
          } | null;
        } | null;
      } | null;
    };
  };
  const pullRequest = parsed.data?.repository?.pullRequest;
  const commit = pullRequest?.commits?.nodes?.[0]?.commit;
  const checkSuites = commit?.checkSuites;
  return {
    headRefOid: String(pullRequest?.headRefOid ?? ''),
    commitOid: String(commit?.oid ?? ''),
    createdAts: (checkSuites?.nodes ?? [])
      .map((node) => String(node?.createdAt ?? ''))
      .filter((value) => value !== ''),
    hasNextPage: checkSuites?.pageInfo?.hasNextPage ?? false,
    endCursor: checkSuites?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Full-walk pagination for {@link ProviderPort.getChangeRequestHeadObservedAt}
 * (kurone-kito/idd-skill#3253). Mirrors {@link fetchCheckRunWorkflowPaths}'s
 * bounded-loop shape, but deliberately fails closed to `''` instead of
 * throwing -- see that port method's own doc comment for why. A HEAD move
 * detected on ANY page (not only the first) aborts the whole walk with `''`,
 * since a page fetched before the move could otherwise contribute stale
 * check-suite timestamps to the result.
 */
function fetchChangeRequestHeadObservedAt(
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
): string {
  try {
    let earliest = '';
    let after: string | null = null;
    // kurone-kito/idd-skill#3253 (Copilot review, PR #3404): a per-page
    // headRefOid === commitOid check alone cannot detect a HEAD move
    // between pages when both values advance together -- page 1 can
    // report sha1/sha1 (internally consistent), then a push lands, and
    // page 2 reports sha2/sha2 (also internally consistent, since each
    // fetch re-reads the PR's now-current headRefOid). Pin the FIRST
    // page's headRefOid and reject any later page whose headRefOid
    // differs from it, in addition to each page's own internal check.
    let firstHeadRefOid: string | null = null;
    for (let page = 0; page < HEAD_OBSERVED_AT_MAX_PAGES; page += 1) {
      const result = fetchChangeRequestHeadObservedAtPage(
        deps,
        owner,
        repo,
        number,
        after,
      );
      if (!result.headRefOid || result.commitOid !== result.headRefOid) {
        return '';
      }
      if (firstHeadRefOid === null) {
        firstHeadRefOid = result.headRefOid;
      } else if (result.headRefOid !== firstHeadRefOid) {
        return '';
      }
      for (const createdAt of result.createdAts) {
        if (!earliest || createdAt < earliest) {
          earliest = createdAt;
        }
      }
      if (!result.hasNextPage) {
        return earliest;
      }
      if (!result.endCursor) {
        return '';
      }
      after = result.endCursor;
    }
    return '';
  } catch {
    return '';
  }
}

function fetchWorkItemUserContentEditsPage(
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
  before: string | null,
): {
  nodes: { editedAt?: unknown; editor?: { login?: unknown } | null }[];
  hasPreviousPage: boolean;
  startCursor: string | null;
} {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$before:String){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      userContentEdits(last:100, before:$before){
        pageInfo { hasPreviousPage startCursor }
        nodes { editedAt editor { login } }
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
  // Omit the `before` variable entirely on the first page (rather than
  // passing an empty-string `-f before=`, which GraphQL would treat as a
  // literal empty-string cursor, not "unset") -- mirrors
  // getWorkItemClosingPullRequestsPage's own `after` handling below.
  if (before) {
    apiArgs.push('-f', `before=${before}`);
  }
  const parsed = JSON.parse(deps.ghText(apiArgs, GH_TEXT_LOOP_OPTIONS)) as {
    data?: {
      repository?: {
        issue?: {
          userContentEdits?: {
            pageInfo?: {
              hasPreviousPage?: unknown;
              startCursor?: unknown;
            } | null;
            nodes?:
              | { editedAt?: unknown; editor?: { login?: unknown } | null }[]
              | null;
          } | null;
        } | null;
      } | null;
    };
    errors?: { message?: unknown }[];
  };
  assertNoGraphqlErrors(parsed, 'userContentEdits lookup');
  // Codex review, PR #2836: reject an absent connection/nodes array
  // instead of defaulting to `[]` -- a null `issue` (deleted/
  // inaccessible between the earlier REST fetch and this call), a null
  // `userContentEdits`, or a payload missing `nodes` entirely are all
  // genuine read failures, indistinguishable from "zero edits" if
  // silently coerced to an empty array. Every caller of this method
  // already treats a throw as "anchor unknown" and degrades accordingly
  // (never falling back to a bare `created_at` anchor) -- swallowing
  // this case here would silently reintroduce that exact failure mode
  // one layer down.
  const connection = parsed.data?.repository?.issue?.userContentEdits;
  if (!connection || !Array.isArray(connection.nodes)) {
    throw new Error(
      'userContentEdits: issue, connection, or nodes is null/absent',
    );
  }
  return {
    nodes: connection.nodes,
    hasPreviousPage: connection.pageInfo?.hasPreviousPage === true,
    startCursor:
      typeof connection.pageInfo?.startCursor === 'string'
        ? connection.pageInfo.startCursor
        : null,
  };
}

/** #2767 (Codex/CodeRabbit review, PR #2840): the `trustedEditor` signal
 * requires every recorded editor to be trusted, so a single `last:100`
 * page silently dropped an untrusted editor beyond the most recent 100
 * edits -- exactly the laundering path the signal exists to block. Pages
 * backward via `before:`/`hasPreviousPage` until the full connection is
 * read, bounded by {@link USER_CONTENT_EDITS_MAX_PAGES}. Each individual
 * page is itself chronologically ascending (GitHub's own connection
 * order), but backward pagination reads the *newest* page first --
 * appending each successively older page after the previous one would
 * leave the newest edits first and the oldest last overall, breaking
 * {@link ProviderPort.getWorkItemUserContentEdits}'s documented ascending
 * contract (Copilot review, PR #2840); sort by `editedAt` below rather
 * than weaken that contract to match the pagination order. */
function fetchWorkItemUserContentEdits(
  deps: GithubProviderAdapterDeps,
  owner: string,
  repo: string,
  number: number,
): ProviderUserContentEdit[] {
  const allNodes: {
    editedAt?: unknown;
    editor?: { login?: unknown } | null;
  }[] = [];
  let before: string | null = null;
  for (let page = 0; page < USER_CONTENT_EDITS_MAX_PAGES; page += 1) {
    const result = fetchWorkItemUserContentEditsPage(
      deps,
      owner,
      repo,
      number,
      before,
    );
    allNodes.push(...result.nodes);
    if (!result.hasPreviousPage) {
      return allNodes
        .filter(
          (
            node,
          ): node is {
            editedAt: string;
            editor?: { login?: unknown } | null;
          } => typeof node?.editedAt === 'string',
        )
        .map((node) => ({
          editedAt: node.editedAt,
          editorLogin:
            typeof node.editor?.login === 'string' ? node.editor.login : null,
        }))
        .sort(
          (left, right) =>
            Date.parse(left.editedAt) - Date.parse(right.editedAt),
        );
    }
    if (!result.startCursor) {
      throw new Error(
        'userContentEdits: hasPreviousPage is true but startCursor is absent',
      );
    }
    before = result.startCursor;
  }
  throw new Error(
    `userContentEdits: exceeded ${USER_CONTENT_EDITS_MAX_PAGES} pages without reaching the start of the connection`,
  );
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
 * #3275: statuses that cannot succeed on retry -- the write is known NOT to
 * have landed (bad credentials, target gone, or a validation failure the
 * next identical attempt would repeat), so retrying only burns the bounded
 * attempt budget. Deliberately excludes every ambiguous shape (`5xx`, a
 * `403` secondary rate limit, or no derivable status at all, e.g. a
 * timeout/transport error) -- those may have landed server-side and must
 * go through the duplicate-check path in
 * {@link postWorkItemCommentWithRetry} instead of failing immediately.
 */
const POST_WORK_ITEM_COMMENT_NON_RETRYABLE_STATUSES = new Set([401, 404, 422]);

/**
 * #3275: upper bound on how long a single retry wait may honor a failed
 * POST's `Retry-After` (or rate-limit-reset) hint. `sleepSync` blocks the
 * whole process, so a multi-minute secondary-rate-limit reset must not be
 * slept through inline -- above this cap,
 * {@link postWorkItemCommentWithRetry} fails closed with
 * {@link PostWorkItemCommentNotVerifiedError} instead of sleeping.
 */
const POST_WORK_ITEM_COMMENT_MAX_RETRY_AFTER_MS = 5000;

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
 * and retry the POST. This scan is best-effort only for a malformed row --
 * a stray non-object entry among the rows is skipped, never treated as a
 * scan failure -- but a genuine failure to fetch/paginate the comment
 * history at all (#3275) is now distinguished from that "no match found"
 * outcome, since the caller must not retry blindly when it cannot prove
 * the previous attempt didn't land. Requests the maximum page size
 * (Copilot review, #2504) to bound pagination overhead on a
 * heavily-commented issue/PR.
 */
type DuplicateCommentCheckOutcome =
  | { kind: 'match'; comment: ProviderPostedComment }
  | { kind: 'no-match' }
  | { kind: 'check-failed'; cause: unknown };

function findRecentExactBodyMatch(
  deps: GithubProviderAdapterDeps,
  repoPath: string,
  number: number,
  body: string,
): DuplicateCommentCheckOutcome {
  // The whole read-and-scan is wrapped in one try/catch, not just the
  // `ghApiJson` call: a malformed `rows` value (non-iterable, or a row
  // whose shape trips an unexpected exception while scanning) must be
  // classified `check-failed` the same way a transport failure is --
  // never let it escape uncaught and skip the caller's own
  // not-verified handling (Copilot review, #2504; regression caught by
  // code review, #3275).
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
    return newest ? { kind: 'match', comment: newest } : { kind: 'no-match' };
  } catch (cause) {
    return { kind: 'check-failed', cause };
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
 * #3275: thrown instead of retrying when a possibly-landed POST failure's
 * outcome could not be confirmed -- either the duplicate-body re-read
 * itself failed (so neither "it landed" nor "it didn't" can be proven), or
 * the failure carried a `Retry-After`/rate-limit-reset wait longer than
 * {@link POST_WORK_ITEM_COMMENT_MAX_RETRY_AFTER_MS}. The caller must re-read
 * live state before acting again rather than assume either outcome.
 */
class PostWorkItemCommentNotVerifiedError extends Error {}

/**
 * #3275: extract the JSON body from a `gh api --include` response, which
 * prefixes the body with an HTTP status line and header block separated by
 * a blank line. Tolerates a bare JSON body with no header envelope at all
 * -- used both by tests that mock a plain successful response directly and
 * by any other caller shape that never received the `--include` envelope
 * -- by treating the whole trimmed text as the body when it doesn't start
 * with an HTTP status line. The headers themselves are not needed here on
 * the success path; a failed attempt's headers (for `Retry-After`) are
 * read separately by {@link deriveRetryAfterMs}, from the thrown error's
 * own captured stderr/stdout text.
 *
 * Deliberately not reusing `gh-exec.mts`'s existing
 * `ghApiJsonWithHeaders`/`parseIncludedGhApiResponse`: that pair is
 * success-only -- `execFileSync` throws before it can return headers for a
 * FAILED request, which is exactly the case this module needs headers
 * for (a `Retry-After` on an ambiguous 5xx/403 failure) -- and it isn't
 * exported for reuse. Doing so would mean exporting a private helper and
 * reshaping every existing `postWorkItemComment` test's `ghText` mock
 * shape; not worth it for this bug-fix-scoped change (code review,
 * #3275).
 */
function extractIncludedResponseBody(raw: string): string {
  const trimmed = raw.trim();
  if (!/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(trimmed)) {
    return trimmed;
  }
  const sections = trimmed.split(/\r?\n\r?\n/);
  return sections.pop()?.trim() ?? '';
}

/**
 * #3275: best-effort `Retry-After` (seconds) or rate-limit-reset
 * (`x-ratelimit-reset` epoch seconds, only when paired with
 * `x-ratelimit-remaining: 0`) extraction from a failed POST's captured
 * output. Scans the same combined stderr/stdout/message text
 * {@link ghErrorText} already assembles -- a `gh api --include` failure
 * response's headers may surface on either stream depending on `gh`
 * version -- so this works whether or not the header block survived as a
 * clean `--include` envelope. Returns `null` when no wait is derivable,
 * letting the caller fall back to the existing fixed jittered backoff.
 */
function deriveRetryAfterMs(error: unknown, nowMs: number): number | null {
  const text = ghErrorText(error);
  if (!text) {
    return null;
  }
  const retryAfterMatch = text.match(/^retry-after:\s*(\d+)\s*$/im);
  if (retryAfterMatch) {
    return Number.parseInt(retryAfterMatch[1], 10) * 1000;
  }
  const remainingIsZero = /^x-ratelimit-remaining:\s*0\s*$/im.test(text);
  const resetMatch = text.match(/^x-ratelimit-reset:\s*(\d+)\s*$/im);
  if (remainingIsZero && resetMatch) {
    return Math.max(0, Number.parseInt(resetMatch[1], 10) * 1000 - nowMs);
  }
  return null;
}

/**
 * #2460 / #3275: POST a work-item (issue/PR) comment with a bounded retry
 * against transient `gh` failures. A failure is classified first via
 * {@link deriveGhHttpStatus}: `401`/`404`/`422` cannot succeed on retry and
 * fail immediately with the original error, no re-read, no further
 * attempt. Every other failure (a `5xx`, a `403` secondary rate limit, or
 * no derivable status at all, e.g. a timeout/transport error) may have
 * landed server-side, so the next attempt only proceeds after
 * {@link findRecentExactBodyMatch} proves no duplicate exists -- a
 * duplicate returns it instead of posting again, and a failed re-read
 * throws {@link PostWorkItemCommentNotVerifiedError} instead of guessing.
 * A `Retry-After`/rate-limit-reset hint on the failure
 * ({@link deriveRetryAfterMs}) is honored before that next attempt, capped
 * at {@link POST_WORK_ITEM_COMMENT_MAX_RETRY_AFTER_MS} -- above the cap,
 * this also throws {@link PostWorkItemCommentNotVerifiedError} rather than
 * blocking the process for the full wait. Once every attempt is
 * exhausted, one final {@link findRecentExactBodyMatch} check runs before
 * giving up -- the last attempt's own failure is just as ambiguous as any
 * earlier one, so this confirms whether it actually landed instead of
 * throwing a plain "all attempts failed" error that could tempt a caller
 * into re-posting the same marker (code review, #3275). Also validates the
 * response shape before treating the marker as posted (catches a
 * 200-with-malformed-body edge case a bare retry would not -- see
 * {@link MalformedPostWorkItemCommentResponseError}).
 */
function postWorkItemCommentWithRetry(
  deps: GithubProviderAdapterDeps,
  repoPath: string,
  number: number,
  body: string,
): ProviderPostedComment {
  const sleep = deps.sleepSync ?? sleepSync;
  const now = deps.now ?? Date.now;
  let lastError: unknown;
  for (
    let attempt = 1;
    attempt <= POST_WORK_ITEM_COMMENT_TOTAL_ATTEMPTS;
    attempt += 1
  ) {
    if (attempt > 1) {
      const existing = findRecentExactBodyMatch(deps, repoPath, number, body);
      if (existing.kind === 'match') {
        return existing.comment;
      }
      if (existing.kind === 'check-failed') {
        throw new PostWorkItemCommentNotVerifiedError(
          `postWorkItemComment: POST to ${repoPath}/issues/${number} may have landed but the duplicate-body re-read failed; not verified, not retrying: ${String(lastError)}`,
        );
      }
      const retryAfterMs = deriveRetryAfterMs(lastError, now());
      if (
        retryAfterMs !== null &&
        retryAfterMs > POST_WORK_ITEM_COMMENT_MAX_RETRY_AFTER_MS
      ) {
        throw new PostWorkItemCommentNotVerifiedError(
          `postWorkItemComment: POST to ${repoPath}/issues/${number} carried a Retry-After wait of ${retryAfterMs}ms, exceeding the ${POST_WORK_ITEM_COMMENT_MAX_RETRY_AFTER_MS}ms cap; not verified, not retrying: ${String(lastError)}`,
        );
      }
      sleep(
        retryAfterMs ??
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
          '--include',
        ],
        { input: JSON.stringify({ body }) },
      );
      const responseBody = extractIncludedResponseBody(out);
      const parsed = JSON.parse(responseBody) as {
        id?: unknown;
        html_url?: unknown;
      };
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
      const status = deriveGhHttpStatus(error);
      if (
        status !== null &&
        POST_WORK_ITEM_COMMENT_NON_RETRYABLE_STATUSES.has(status)
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  // #3275 (code review): every failure reaching this point already passed
  // the non-retryable-status check above without throwing, so it is
  // necessarily a "may have landed" failure -- the same ambiguity the rest
  // of this function exists to resolve. Reusing "throw the last error and
  // give up" here without one final duplicate check would silently
  // reintroduce that ambiguity for the LAST attempt specifically: a caller
  // that sees this exception and (incorrectly) assumes nothing was posted
  // could still re-post the same marker if this final attempt actually
  // landed. Confirm one way or the other before giving up.
  const finalCheck = findRecentExactBodyMatch(deps, repoPath, number, body);
  if (finalCheck.kind === 'match') {
    return finalCheck.comment;
  }
  if (finalCheck.kind === 'check-failed') {
    throw new PostWorkItemCommentNotVerifiedError(
      `postWorkItemComment: POST to ${repoPath}/issues/${number} may have landed but the final duplicate-body re-read failed; not verified: ${String(lastError)}`,
    );
  }
  // Copilot review, #2504: `lastError` is `unknown` -- a non-`Error` thrown
  // by `deps.ghText`/`JSON.parse` (a string, `undefined`, ...) would make
  // downstream handling/logging inconsistent. Always throw a real `Error`.
  throw lastError instanceof Error
    ? lastError
    : new Error(
        `postWorkItemComment: all ${POST_WORK_ITEM_COMMENT_TOTAL_ATTEMPTS} attempts failed for ${repoPath}/issues/${number}: ${String(lastError)}`,
      );
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
  /** #3246: present only when the caller's own fragment selects it. */
  lastEditedAt?: unknown;
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

// The helper below backs getWorkItemForTraversalAsync only, wrapping a
// failed `gh` invocation into a normalized shape for the shared
// classifyInaccessibleIssueLookup() classifier (gh-http-status.mts) --
// preserving the retry-skip classification (#1394) the
// statusToCategory/ProviderError classification above cannot express: it
// maps 410/451 to 'validation', not the same bucket as 403. This used to
// be a verbatim port of discover-roadmap-graph.mts's pre-migration
// resolveGhExitStatus/wrapGhFailure/isNotFoundIssueLookupError/
// isInaccessibleIssueLookupError, which classified on the child-process
// exit status -- always `1` for every gh HTTP failure, so that branch
// could never fire (#3335). It now derives the real status from gh's own
// stderr/stdout text via the shared classifier instead, matching
// discover-readiness-check.mts's isInaccessibleIssueLookupError.

/**
 * Wraps a failed `gh` error into a normalized `{ stderr, stdout }` shape
 * the shared classifier re-derives its status and wording classification
 * from. Returns `''` on a genuine 404 (`getWorkItemForTraversalAsync`
 * treats "not found" as an empty successful lookup, not a thrown error);
 * otherwise re-throws with the *original* error's real `stderr`/`stdout`
 * streams preserved **separately and verbatim** (never flattened together
 * with `.message` into a single field), so a status or wording match
 * embedded in either stream still classifies correctly once re-derived
 * from the wrapped error.
 *
 * Deliberately keeps `args` (the `repos/{owner}/{repo}/issues/{n}`
 * endpoint) out of `.stderr`/`.stdout` entirely, using it only inside
 * `.message` -- a human-readable summary the shared classifier's wording
 * check never reads once either real stream is non-empty
 * (`classifyInaccessibleIssueLookup`'s stream-preferring text getter,
 * gh-http-status.mts). Without this separation, an owner/repo name that
 * happens to contain "visibility" could false-positive the 403 wording
 * check and silently downgrade an unrelated 403 (e.g. a secondary rate
 * limit) instead of retrying it -- first found folded into `.message` via
 * a hand-built prefix (CodeRabbit review), then found again once Node's
 * own `execFile`/`ghTextAsync` rejection shape was accounted for: its
 * `.message` is synthesized as `Command failed: <full command line>\n
 * <stderr>`, so it always embeds the endpoint regardless of what this
 * function constructs, unless the wording check is kept off `.message`
 * whenever real stream text exists (Copilot review, #3335).
 */
function wrapTraversalGhFailure(error: unknown, args: string[]): string {
  if (classifyInaccessibleIssueLookup(error) === 'not-found') {
    return '';
  }
  const candidate = error as { stderr?: unknown; stdout?: unknown } | null;
  const stderr = candidate?.stderr == null ? '' : String(candidate.stderr);
  const stdout = candidate?.stdout == null ? '' : String(candidate.stdout);
  const summary =
    ghErrorText(error).trim() ||
    `gh ${args.join(' ')} failed with no diagnostic output`;
  const wrapped = new Error(summary) as Error & {
    stderr?: string;
    stdout?: string;
  };
  wrapped.stderr = stderr;
  wrapped.stdout = stdout;
  throw wrapped;
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
  /**
   * Backs {@link postWorkItemCommentWithRetry}'s rate-limit-reset-based
   * `Retry-After` derivation (#3275). Optional so existing deps overrides
   * keep compiling; defaults to the real `Date.now`. Inject a fixed value
   * in tests for a deterministic `x-ratelimit-reset` wait computation.
   */
  now?: () => number;
}

const DEFAULT_DEPS: GithubProviderAdapterDeps = {
  ghText,
  ghApiJson,
  resolveViewerLogin: ghExecResolveViewerLogin,
  ghTextAsync,
  sleepSync,
  now: Date.now,
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
          // #2767 (CodeRabbit review, PR #2840): populate user like
          // getWorkItem() above already does -- discover-orphan-filter.mts's
          // structural-evidence trustedEditor signal reads the author login
          // straight off the bulk listOpenWorkItems() result (no secondary
          // per-issue fetch), so an absent value here silently made the
          // author check fail closed for every live orphan candidate.
          user: row.user,
          // #2243 (Copilot review, PR #2557): populate createdAt like
          // getWorkItem() above already does -- discover-orphan-filter.mts's
          // triage-verdict staleness anchor reads this field straight off
          // the bulk listOpenWorkItems() result (no secondary per-issue
          // fetch), so an absent value here silently made that exclusion
          // never fire for a never-edited issue in real runs.
          createdAt:
            row.created_at === undefined ? undefined : String(row.created_at),
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

    getWorkItemUserContentEdits(number: number): ProviderUserContentEdit[] {
      return fetchWorkItemUserContentEdits(deps, owner, repo, number);
    },

    getWorkItemUserContentEditTimestamps(number: number): string[] {
      // #2767 round 12 (Codex review, PR #2840): a single bounded page --
      // GraphQL's own `last:100`, no `before` cursor -- is enough for
      // every existing timestamp-only consumer (discover-readiness-check.mts,
      // discover-orphan-filter.mts, claim-approval-gate.mts, all via
      // resolveLatestSubstantiveIssueEditAt or an equivalent max-of-array
      // read): the true newest edit is always among the newest page,
      // regardless of total edit count, and none of them assume any
      // particular ordering. Delegating to fetchWorkItemUserContentEdits
      // (the full backward-paginated fetch #2767 added so the
      // trustedEditor signal sees EVERY editor, not just the most recent
      // 100) previously multiplied GraphQL cost by up to
      // USER_CONTENT_EDITS_MAX_PAGES for an issue with a large edit
      // history, and its 1,000-edit throw turned a freshness-only read
      // into a hard failure -- discover-orphan-filter.mts's own
      // freshness-anchor logic treats a thrown fetch as "anchor unknown"
      // and retains a candidate despite an actual, current trusted
      // rejection. getWorkItemUserContentEdits itself is unchanged: it
      // still needs the full paginated history.
      const page = fetchWorkItemUserContentEditsPage(
        deps,
        owner,
        repo,
        number,
        null,
      );
      return page.nodes
        .filter(
          (node): node is { editedAt: string } =>
            typeof node?.editedAt === 'string',
        )
        .map((node) => node.editedAt);
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

    // See provider-port.mts's doc comment on this method: no caller uses it
    // today (#3276 moved resume-claim-routing.mts's sole call site to
    // getConnectedPullRequestEventsPage below, which throws on failure
    // instead of this method's fail-open empty-array swallow).
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
      // #3276 (Copilot review, PR #3386): a top-level GraphQL `errors` entry
      // can accompany a partial `data` object that still looks like a valid
      // (even if empty) timelineItems connection -- check errors first, the
      // same choke point every other GraphQL-backed method in this file
      // uses, so a failed lookup never falls through to the connection
      // validation below as though it had succeeded.
      assertNoGraphqlErrors(parsed, 'getConnectedPullRequestEventsPage');
      const connection = parsed.data?.repository?.issue?.timelineItems;
      // #3276 (Copilot review, PR #3386): a present `timelineItems`
      // connection with a missing/malformed `nodes` or `pageInfo` field is
      // malformed GraphQL data (a partial/truncated response), not a
      // legitimately empty terminal page -- validate explicitly instead of
      // defaulting each field independently to `[]`/`false`/`null`, which
      // would otherwise let fetchOpenLinkedPrReferences
      // (resume-claim-routing.mts) read a malformed page as
      // `lookupFailed: false` and still honor an issue-only forced handoff
      // the lookup never actually resolved. `hasNextPage` specifically must
      // be checked as a boolean, not merely that `pageInfo` exists -- a
      // `pageInfo: {}` shape would otherwise pass a bare truthiness check
      // and `hasNextPage ?? false` would silently read unknown pagination
      // state as terminal. Mirrors the established fail-closed pattern in
      // authoring-owner-provenance.mts's page validation.
      if (
        !connection ||
        !Array.isArray(connection.nodes) ||
        connection.pageInfo == null ||
        typeof connection.pageInfo !== 'object' ||
        typeof connection.pageInfo.hasNextPage !== 'boolean'
      ) {
        throw new Error(
          'timelineItems: connection is null/absent or malformed (missing nodes/pageInfo/hasNextPage)',
        );
      }
      return {
        events: connection.nodes as ProviderConnectedPrEvent[],
        hasNextPage: connection.pageInfo.hasNextPage,
        endCursor:
          typeof connection.pageInfo.endCursor === 'string'
            ? connection.pageInfo.endCursor
            : null,
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

    listWorkItemComments(
      number: number,
      options?: { timeoutMs?: number; includeEditState?: boolean },
    ): ProviderComment[] {
      const rows = deps.ghApiJson(`${repoPath}/issues/${number}/comments`, {
        paginate: true,
        ...(options?.timeoutMs !== undefined
          ? { timeout: options.timeoutMs }
          : {}),
      }) as {
        id?: unknown;
        node_id?: unknown;
        body?: unknown;
        created_at?: unknown;
        updated_at?: unknown;
        user?: { login?: unknown };
      }[];
      const mapped = rows.map((row) => ({
        id: Number(row.id),
        nodeId: String(row.node_id ?? ''),
        body: String(row.body ?? ''),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? row.created_at ?? ''),
        authorLogin: String(row.user?.login ?? ''),
      }));
      if (!options?.includeEditState) {
        return mapped;
      }
      // #3246: REST has no edit-timestamp field -- resolve it via one
      // follow-up GraphQL batch read, keyed by each comment's own
      // `node_id`. A comment missing `node_id` cannot be resolved at all;
      // fail closed rather than silently reporting it 'unknown'.
      const nodeIds = mapped.map((comment) => comment.nodeId);
      if (nodeIds.some((id) => id === '')) {
        throw new Error(
          `listWorkItemComments: includeEditState requires every comment on #${number} to carry a node_id`,
        );
      }
      const lastEditedAtByNodeId = fetchLastEditedAtByNodeId(
        deps.ghText,
        nodeIds,
      );
      return mapped.map((comment) => {
        if (!lastEditedAtByNodeId.has(comment.nodeId)) {
          throw new Error(
            `listWorkItemComments: missing edit-state resolution for comment #${comment.id}`,
          );
        }
        return {
          ...comment,
          lastEditedAt: lastEditedAtByNodeId.get(comment.nodeId) ?? null,
        };
      });
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

    getChangeRequestHeadSha(
      number: number,
      options?: { timeoutMs?: number },
    ): string {
      return deps.ghText(
        [
          'pr',
          'view',
          String(number),
          '-R',
          `${owner}/${repo}`,
          '--json',
          'headRefOid',
          '--jq',
          '.headRefOid',
        ],
        options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {},
      );
    },

    listRequiredChecksSummary(number: number): ProviderRequiredChecksSummary {
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
      let noRequiredChecksConfigured = false;
      try {
        raw = deps.ghText(args, GH_TEXT_LOOP_OPTIONS);
      } catch (error) {
        const stderr = String(
          (error as { stderr?: unknown } | null)?.stderr ?? '',
        );
        if (/no required checks reported/i.test(stderr)) {
          raw = '[]';
          noRequiredChecksConfigured = true;
        } else {
          const stdout = String(
            (error as { stdout?: unknown } | null)?.stdout ?? '',
          ).trim();
          if (!stdout) {
            throw error;
          }
          raw = stdout;
        }
      }
      const rows = JSON.parse(raw || '[]') as {
        name?: unknown;
        state?: unknown;
        completedAt?: unknown;
      }[];
      return {
        checks: rows.map((row) => ({
          name: String(row.name ?? ''),
          state: String(row.state ?? ''),
          completedAt: row.completedAt ? String(row.completedAt) : null,
        })),
        noRequiredChecksConfigured,
      };
    },

    listRequiredChecks(number: number): ProviderRequiredCheck[] {
      return this.listRequiredChecksSummary(number).checks;
    },

    listReviews(number: number): unknown[] {
      return deps.ghApiJson(`${repoPath}/pulls/${number}/reviews`, {
        paginate: true,
      }) as unknown[];
    },

    // #3336: `gh pr list --limit 100` silently capped this at 100 rows, so
    // a repository with more than 100 open pull requests could miss an
    // issue's own open PR (findIssueRelatedOpenPrs in
    // resume-route-selection.mts filters this result by body reference).
    // Page through every open PR via the paginated REST endpoint instead,
    // matching listOpenWorkItems's own `issues?state=open` pagination
    // pattern above. `html_url` (not the REST API `url` field) is the web
    // URL `gh pr list --json url` returned before this change.
    listOpenChangeRequests(): ProviderChangeRequestSummary[] {
      const rows = deps.ghApiJson(`${repoPath}/pulls?state=open&per_page=100`, {
        paginate: true,
      }) as {
        number?: unknown;
        title?: unknown;
        body?: unknown;
        html_url?: unknown;
      }[];
      return rows.map((row) => ({
        number: Number(row.number),
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        url: String(row.html_url ?? ''),
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
              raw = wrapTraversalGhFailure(error, args);
            }
            const trimmed = raw.trim();
            if (!trimmed || trimmed === 'null') {
              return null;
            }
            return JSON.parse(trimmed);
          },
          {
            isRetryable: (error) =>
              classifyInaccessibleIssueLookup(error) === null,
          },
        );
        if (parsed === null) {
          return { outcome: 'not-found' };
        }
        return { outcome: 'found', item: parsed };
      } catch (error) {
        const classification = classifyInaccessibleIssueLookup(error);
        if (classification === 'not-found') {
          return { outcome: 'not-found' };
        }
        if (classification === 'inaccessible') {
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
      options?: { includeEditState?: boolean },
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
      if (!options?.includeEditState) {
        return comments;
      }
      // #3246: same edit-state resolution as `listWorkItemComments`, but
      // merged onto each raw REST row as snake_case `last_edited_at` --
      // this method's return type is a raw passthrough, not
      // `ProviderComment`.
      const nodeIds = comments.map((row) =>
        String((row as { node_id?: unknown })?.node_id ?? ''),
      );
      if (nodeIds.some((id) => id === '')) {
        throw new Error(
          `listWorkItemCommentsWithRetryAsync: includeEditState requires every comment on #${number} to carry a node_id`,
        );
      }
      const lastEditedAtByNodeId = fetchLastEditedAtByNodeId(
        deps.ghText,
        nodeIds,
      );
      return comments.map((row, index) => {
        const nodeId = nodeIds[index];
        if (!lastEditedAtByNodeId.has(nodeId)) {
          throw new Error(
            `listWorkItemCommentsWithRetryAsync: missing edit-state resolution for node ${nodeId}`,
          );
        }
        return {
          ...(row as Record<string, unknown>),
          last_edited_at: lastEditedAtByNodeId.get(nodeId) ?? null,
        };
      });
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
      return fetchChangeRequestBranchAndChecks(deps, owner, repo, number);
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
          const stderr = String(
            (error as { stderr?: unknown } | null)?.stderr ?? '',
          );
          if (status === 1 && /no checks reported/i.test(stderr)) {
            raw = '[]';
          } else {
            throw error;
          }
        } else {
          raw = stdout;
        }
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
      // kurone-kito/idd-skill#2657 (Codex review, PR #2895, round 12):
      // current path only -- never a renamed-away `.previous_filename`.
      // This general-purpose list also backs CODEOWNERS resolution and
      // required-reviewer pattern matching (pre-merge-readiness.mts),
      // where a stale rename source could pull in an obsolete owner or
      // let an approval from it substitute for the destination path's
      // real owner. See {@link listChangeRequestRenamedFromPaths} for the
      // one consumer that specifically needs the old path too.
      return rows.map((row) => String(row.filename ?? ''));
    },

    listChangeRequestRenamedFromPaths(number: number): string[] {
      const rows = deps.ghApiJson(`${repoPath}/pulls/${number}/files`, {
        paginate: true,
      }) as { filename?: unknown; previous_filename?: unknown }[];
      // kurone-kito/idd-skill#2657 (Codex review, PR #2895): a renamed
      // file's OLD path, deliberately kept out of the general-purpose
      // `listChangeRequestChangedFiles` above (see its own doc comment).
      // A consumer matching changed files against a committed allowlist
      // of paths (the self-referential-bootstrap-auto trigger-file check)
      // must recognize a renamed file by its OLD path too, or a
      // rename-shaped checker repair away from an allowlisted path
      // recreates the exact self-referential deadlock that mechanism
      // exists to solve.
      return rows.flatMap((row) => {
        const filename = String(row.filename ?? '');
        const previousFilename =
          typeof row.previous_filename === 'string'
            ? row.previous_filename
            : '';
        return previousFilename && previousFilename !== filename
          ? [previousFilename]
          : [];
      });
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
        'body createdAt updatedAt lastEditedAt author { login } pullRequestReview { id }',
      );
      return nodes.map((node) => ({
        id: node.id,
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
          lastEditedAt: mapLastEditedAt(comment.lastEditedAt),
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
        'body url createdAt updatedAt lastEditedAt author { login }',
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
          lastEditedAt: mapLastEditedAt(comment.lastEditedAt),
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
        nodes { body url createdAt updatedAt lastEditedAt author { login } }
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
                    lastEditedAt?: unknown;
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
            lastEditedAt: mapLastEditedAt(node.lastEditedAt),
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
        nodes { body url state submittedAt author { login } commit { oid } }
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
                    commit?: { oid?: unknown } | null;
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
            commitOid:
              node.commit?.oid == null ? null : String(node.commit.oid),
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

    // kurone-kito/idd-skill#2926 (round 2 -- Copilot + Codex review, PR
    // #2930): delegates to the module-level {@link fetchCheckRunWorkflowPaths}
    // (full-walk pagination + same-suite ownership defense), matching the
    // `fetchWorkItemUserContentEdits`-style split this file already uses
    // for its other bounded-pagination method above rather than inlining
    // the loop into the returned adapter object.
    listCheckRunWorkflowPaths(
      pathsOwner: string,
      pathsRepo: string,
      headSha: string,
      checkName: string,
    ): ProviderCheckRunWorkflowPath[] {
      return fetchCheckRunWorkflowPaths(
        deps,
        pathsOwner,
        pathsRepo,
        headSha,
        checkName,
      );
    },

    getWorkflowRunJobs(
      jobsOwner: string,
      jobsRepo: string,
      runId: string | number,
    ): unknown {
      // Not `--paginate`: bounded to a handful of jobs per run (this
      // workflow declares two), well under the API's own per-page cap, and
      // `--paginate` without `--jq` would emit one JSON object per page
      // rather than a single parseable document.
      const raw = deps.ghText(
        ['api', `repos/${jobsOwner}/${jobsRepo}/actions/runs/${runId}/jobs`],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      );
      return JSON.parse(raw.trim() || '{}');
    },

    listWorkflowRunArtifacts(
      artifactsOwner: string,
      artifactsRepo: string,
      runId: string | number,
    ): unknown {
      // Not `--paginate`, same rationale as getWorkflowRunJobs above: a
      // run legitimately uploads at most a handful of artifacts, well
      // under the API's own per-page cap.
      const raw = deps.ghText(
        [
          'api',
          `repos/${artifactsOwner}/${artifactsRepo}/actions/runs/${runId}/artifacts`,
        ],
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

    getChangeRequestHeadRefNameAtRepo(
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
        'headRefName',
        '--jq',
        '.headRefName',
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
        'body createdAt updatedAt lastEditedAt author { login __typename } pullRequestReview { id }',
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
          lastEditedAt: mapLastEditedAt(comment.lastEditedAt),
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

    getChangeRequestHeadObservedAt(number: number): string {
      return fetchChangeRequestHeadObservedAt(deps, owner, repo, number);
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
