#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-pr-cleanup.mts
//
// The scripts/audit-pr-cleanup.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { CleanupReport } from './audit-pr-cleanup-summary.mts';
import { computeReportSummary } from './audit-pr-cleanup-summary.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import type { ClaimValidationSummary } from './protocol-helpers.mts';
import {
  classifyRegularBotComment,
  hasFreshDisposition,
  indexLatestGatingReviewsByAuthor,
  indexThreadsByReview,
  isDispositionComment,
  isKnownReviewBot,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  summarizeClaimValidation,
  unionTrustedMarkerActorSources,
  unsafeTextReason,
} from './protocol-helpers.mts';

/** Author reference embedded in GraphQL payloads. */
interface GqlAuthorPayload {
  login?: string | null;
}

/** Minimizable GraphQL node fields shared by every subject type. */
interface MinimizableNode {
  id: string;
  url: string;
  isMinimized?: boolean | null;
  minimizedReason?: string | null;
  viewerCanMinimize?: boolean | null;
}

/** PR issue-comment node from the comments connection. */
interface IssueCommentNode extends MinimizableNode {
  body: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  author?: GqlAuthorPayload | null;
}

/** PR review node from the reviews connection. */
interface ReviewNode extends MinimizableNode {
  body?: string | null;
  state?: string | null;
  submittedAt?: string | null;
  author?: GqlAuthorPayload | null;
}

/** Review-thread reply node from the reviewThreads connection. */
interface ThreadCommentNode extends MinimizableNode {
  body?: string | null;
  createdAt?: string | null;
  author?: GqlAuthorPayload | null;
  pullRequestReview?: { id?: string | null } | null;
}

/** Review-thread node from the reviewThreads connection. */
interface ReviewThreadNode {
  id?: string | null;
  isResolved?: boolean | null;
  comments?: {
    pageInfo?: { hasNextPage?: boolean | null } | null;
    nodes?: ThreadCommentNode[] | null;
  } | null;
}

/** Pull-request node fields consumed by this helper. */
interface PullRequestNode {
  number?: number | null;
  url: string;
  merged: boolean;
}

/** Minimized-comment node returned by the minimizeComment mutation. */
interface MinimizedCommentNode {
  __typename?: string;
  id?: string;
  url?: string;
  isMinimized: boolean;
  minimizedReason: string | null;
}

/** Paginated GraphQL connection payload. */
interface ConnectionPayload<TNode> {
  nodes?: TNode[] | null;
  pageInfo?: { hasNextPage?: boolean | null; endCursor?: string | null } | null;
}

/** GraphQL error entry. */
interface GraphqlErrorEntry {
  message?: string | null;
}

/** Error-routing options for the GraphQL helpers. */
interface GraphqlCallOptions {
  throwOnError?: boolean;
}

/** Report subject derived from a minimizable node. */
type SubjectInfo = {
  subjectId: string;
  url: string;
  type: string;
  classifier: string;
  viewerCanMinimize: boolean;
  isMinimized: boolean;
  minimizedReason: string | null;
};

/** Report row: a subject plus per-disposition metadata. */
type ReportRow = SubjectInfo & {
  markerPrefix?: string;
  author?: string;
  threadId?: string | null;
  associatedThreads?: number;
  unresolvedThreads?: number;
  missingDispositionThreads?: number;
  reason?: string;
  skipReason?: string;
  error?: string;
};

/** Aggregated per-review thread stats from {@link indexThreadsByReview}. */
interface AssociatedThreadStats {
  total: number;
  unresolved: number;
  missingDisposition: number;
  incomplete: boolean;
  threadIds: (string | null | undefined)[];
}

/** Full cleanup-audit report emitted by this helper. */
interface CleanupAuditReport extends CleanupReport {
  repository: string;
  pr: number;
  prUrl: string;
  merged: boolean;
  mode: string;
  trustedMarkerActors: string[];
  trustedMarkerActorsSources: string[];
  collaboratorTrustEnabled: boolean;
  candidates: ReportRow[];
  skipped: ReportRow[];
  applied: ReportRow[];
  failed: ReportRow[];
  summary: Record<string, number> | null;
  status: string | null;
}

/** Active claim resolved from the trusted claim-marker stream. */
type ActiveClaim = ClaimValidationSummary['activeClaim'];

/** Parsed CLI arguments. */
interface CleanupArgs {
  format: string;
  help?: boolean;
  pr?: string;
  repo?: string;
  dryRun?: boolean;
  apply?: boolean;
  claimIssue?: string;
  claimId?: string;
  agentId?: string;
  skipClaimCheck?: boolean;
}

const TRUSTED_MARKER_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const trustedMarkerAuthorCache = new Map<string, boolean>();
const collaboratorPermissionCache: CollaboratorPermissionCache = new Map();
let cachedConfiguredTrustedMarkerActorSources: {
  actors: Set<string>;
  sources: string[];
} | null = null;
let cachedCurrentViewerLogin: string | null = null;

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printUsage();
  process.exit(0);
}

if (!args.pr) {
  fail('missing required --pr <number>');
}

if (args.apply && args.dryRun) {
  fail('choose only one of --dry-run or --apply');
}

if (!args.apply) {
  args.dryRun = true;
}

if (args.apply && args.skipClaimCheck && (args.claimIssue || args.claimId)) {
  fail(
    '--skip-claim-check cannot be combined with --claim-issue or --claim-id',
  );
}

if (args.apply && !args.skipClaimCheck && (!args.claimIssue || !args.claimId)) {
  fail(
    '--apply requires --claim-issue and --claim-id, or explicit --skip-claim-check',
  );
}

const repository = args.repo ?? detectRepository();
const [owner, repo] = parseRepository(repository);

const prNumber = parsePositiveInteger(args.pr, '--pr');
const claimContext = {
  expectedLinkedPrs: buildExpectedLinkedPrReferences(owner, repo, prNumber),
};

if (args.claimIssue) {
  args.claimIssue = String(
    parsePositiveInteger(args.claimIssue, '--claim-issue'),
  );
}

const report = await buildReport(owner, repo, prNumber);

if (args.apply) {
  report.mode = 'apply';
  for (const candidate of report.candidates) {
    if (!args.skipClaimCheck) {
      try {
        assertActiveClaim(
          owner,
          repo,
          args.claimIssue,
          args.agentId,
          args.claimId,
          claimContext,
        );
      } catch (error) {
        report.failed.push({
          ...candidate,
          error: (error as Error).message,
        });
        break;
      }
    }
    try {
      const freshCandidate = await revalidateCandidate(
        owner,
        repo,
        prNumber,
        candidate,
        report,
      );
      if (!freshCandidate) {
        continue;
      }
      if (!args.skipClaimCheck) {
        try {
          assertActiveClaim(
            owner,
            repo,
            args.claimIssue,
            args.agentId,
            args.claimId,
            claimContext,
          );
        } catch (error) {
          report.failed.push({
            ...freshCandidate,
            error: (error as Error).message,
          });
          break;
        }
      }
      const minimized = minimizeComment(
        freshCandidate.subjectId,
        freshCandidate.classifier,
      );
      report.applied.push({
        ...freshCandidate,
        isMinimized: minimized.isMinimized,
        minimizedReason: minimized.minimizedReason,
      });
    } catch (error) {
      report.failed.push({
        ...candidate,
        error: (error as Error).message,
      });
    }
  }

  computeReportSummary(report);
  if (report.failed.length > 0) {
    writeReport(report, args.format);
    process.exit(1);
  }
}

computeReportSummary(report);
writeReport(report, args.format);

// Build an IDD-scoped disposition-author predicate from the resolved
// trusted-marker actors (the accounts the IDD agent posts dispositions under).
// The non-gate `hasFreshDisposition` callers must use this so a human
// reviewer's `**Accepted**`/`**Rejected**` is not mistaken for a completed IDD
// disposition.
function makeIddDispositionAuthorPredicate(
  iddLogins: string[],
): (login: string) => boolean {
  const set = new Set(iddLogins);
  return (login) =>
    set.has(
      String(login ?? '')
        .trim()
        .toLowerCase(),
    );
}

async function buildReport(
  owner: string,
  repo: string,
  prNumber: number,
  options: GraphqlCallOptions = {},
): Promise<CleanupAuditReport> {
  const pr = fetchPullRequest(owner, repo, prNumber, options);
  const comments = fetchIssueComments(owner, repo, prNumber, options);
  const reviews = fetchReviews(owner, repo, prNumber, options);
  const threads = fetchReviewThreads(owner, repo, prNumber, options);

  const configuredTrust = configuredTrustedMarkerActorSources();
  const iddAgentLogins = normalizeTrustedMarkerLogins([
    currentViewerLogin(),
    ...configuredTrust.actors,
  ]);
  const threadIndex = indexThreadsByReview(threads, {
    isDispositionAuthor: makeIddDispositionAuthorPredicate(iddAgentLogins),
  });
  const latestGatingReviews = indexLatestGatingReviewsByAuthor(reviews);

  const report: CleanupAuditReport = {
    repository: `${owner}/${repo}`,
    pr: prNumber,
    prUrl: pr.url,
    merged: pr.merged,
    mode: 'dry-run',
    trustedMarkerActors: iddAgentLogins,
    trustedMarkerActorsSources: [
      ...(currentViewerLogin() ? ['viewer'] : []),
      ...configuredTrust.sources,
    ],
    collaboratorTrustEnabled: trustCollaboratorMarkers(),
    candidates: [],
    skipped: [],
    applied: [],
    failed: [],
    summary: null,
    status: null,
  };

  for (const comment of comments) {
    if (evaluateOperationalComment(comment, pr, report, owner, repo)) {
      continue;
    }
    evaluateRegularBotComment(comment, comments, threads, pr, report);
  }

  for (const thread of threads) {
    evaluateReviewComments(thread, pr, latestGatingReviews, report);
  }

  for (const review of reviews) {
    evaluateReviewParent(review, pr, threadIndex, latestGatingReviews, report);
  }

  // Collaborator trust is evaluated lazily per author; record it in the
  // source mix only when the collaborator path actually trusted someone
  // during this report's evaluation.
  if (
    report.collaboratorTrustEnabled &&
    [...trustedMarkerAuthorCache.values()].some(Boolean)
  ) {
    report.trustedMarkerActorsSources.push('collaborators');
  }

  return report;
}

function evaluateOperationalComment(
  comment: IssueCommentNode,
  pr: PullRequestNode,
  report: CleanupAuditReport,
  owner: string,
  repo: string,
): boolean {
  const prefix = operationalMarkerPrefix(comment.body);
  if (!prefix) {
    return false;
  }

  const subject = subjectFromNode(comment, 'IssueComment', 'OUTDATED');
  const author = comment.author?.login ?? '';

  if (!isTrustedMarkerAuthor(owner, repo, author)) {
    addSkipped(report, subject, 'operational marker author is not trusted');
    return true;
  }

  if (prefix === '<!-- forced-handoff:') {
    addSkipped(report, subject, 'forced-handoff markers remain audit evidence');
    return true;
  }

  if (!pr.merged) {
    addSkipped(report, subject, 'PR is not merged');
    return true;
  }

  const unsafeReason = unsafeTextReason(comment.body);
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return true;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, 'already minimized');
    return true;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, 'viewer cannot minimize this comment');
    return true;
  }

  report.candidates.push({
    ...subject,
    markerPrefix: prefix,
    reason: 'stale IDD operational marker on a merged PR',
  });
  return true;
}

function evaluateRegularBotComment(
  comment: IssueCommentNode,
  comments: IssueCommentNode[],
  threads: ReviewThreadNode[],
  pr: PullRequestNode,
  report: CleanupAuditReport,
): void {
  const author = comment.author?.login ?? '';
  if (!isKnownReviewBot(author)) {
    return;
  }

  const classification = classifyRegularBotComment(comment, comments, threads, {
    isDispositionAuthor: makeIddDispositionAuthorPredicate(
      report.trustedMarkerActors,
    ),
  });
  const subject = subjectFromNode(
    comment,
    'IssueComment',
    classification?.classifier ?? 'RESOLVED',
  );

  if (!pr.merged) {
    addSkipped(report, subject, 'PR is not merged');
    return;
  }

  const unsafeReason = unsafeTextReason(comment.body ?? '');
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, 'already minimized');
    return;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, 'viewer cannot minimize this comment');
    return;
  }

  if (!classification) {
    addSkipped(
      report,
      subject,
      'known review-bot regular comment lacks a completed-review signal',
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    reason: classification.reason,
  });
}

function evaluateReviewParent(
  review: ReviewNode,
  pr: PullRequestNode,
  threadIndex: Map<string, AssociatedThreadStats>,
  latestGatingReviews: ReturnType<typeof indexLatestGatingReviewsByAuthor>,
  report: CleanupAuditReport,
): void {
  const author = review.author?.login ?? '';
  if (!isKnownReviewBot(author)) {
    return;
  }

  const subject = subjectFromNode(review, 'PullRequestReview', 'RESOLVED');
  const associated =
    threadIndex.get(review.id) ??
    ({
      total: 0,
      unresolved: 0,
      threadIds: [] as (string | null | undefined)[],
    } as AssociatedThreadStats);
  const latestGatingReview = latestGatingReviews.get(author.toLowerCase());

  if (!pr.merged) {
    addSkipped(report, subject, 'PR is not merged');
    return;
  }

  const unsafeReason = unsafeTextReason(review.body ?? '');
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (review.isMinimized) {
    addSkipped(report, subject, 'already minimized');
    return;
  }

  if (!review.viewerCanMinimize) {
    addSkipped(report, subject, 'viewer cannot minimize this review');
    return;
  }

  if (
    review.state === 'CHANGES_REQUESTED' ||
    latestGatingReview?.state === 'CHANGES_REQUESTED'
  ) {
    addSkipped(
      report,
      subject,
      'review author still has an active changes-requested state',
    );
    return;
  }

  if (associated.total === 0) {
    addSkipped(report, subject, 'review has no associated review threads');
    return;
  }

  if (associated.incomplete) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: associated.unresolved,
        missingDispositionThreads: associated.missingDisposition,
      },
      'associated review threads have truncated comment data',
    );
    return;
  }

  if (associated.unresolved > 0) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: associated.unresolved,
        missingDispositionThreads: associated.missingDisposition,
      },
      'review has unresolved associated review threads',
    );
    return;
  }

  if (associated.missingDisposition > 0) {
    addSkipped(
      report,
      {
        ...subject,
        associatedThreads: associated.total,
        unresolvedThreads: 0,
        missingDispositionThreads: associated.missingDisposition,
      },
      'associated review threads are missing IDD accept/reject dispositions',
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    associatedThreads: associated.total,
    unresolvedThreads: 0,
    missingDispositionThreads: 0,
    reason:
      'known bot review parent with all associated review threads resolved',
  });
}

function evaluateReviewComments(
  thread: ReviewThreadNode,
  pr: PullRequestNode,
  latestGatingReviews: ReturnType<typeof indexLatestGatingReviewsByAuthor>,
  report: CleanupAuditReport,
): void {
  for (const comment of thread.comments?.nodes ?? []) {
    evaluateReviewComment(comment, thread, pr, latestGatingReviews, report);
  }
}

function evaluateReviewComment(
  comment: ThreadCommentNode,
  thread: ReviewThreadNode,
  pr: PullRequestNode,
  latestGatingReviews: ReturnType<typeof indexLatestGatingReviewsByAuthor>,
  report: CleanupAuditReport,
): void {
  const author = comment.author?.login ?? '';
  if (!isKnownReviewBot(author) || isDispositionComment(comment)) {
    return;
  }

  const subject = subjectFromNode(
    comment,
    'PullRequestReviewComment',
    'RESOLVED',
  );
  const latestGatingReview = latestGatingReviews.get(author.toLowerCase());

  if (!pr.merged) {
    addSkipped(report, subject, 'PR is not merged');
    return;
  }

  const unsafeReason = unsafeTextReason(comment.body ?? '');
  if (unsafeReason) {
    addSkipped(report, subject, unsafeReason);
    return;
  }

  if (comment.isMinimized) {
    addSkipped(report, subject, 'already minimized');
    return;
  }

  if (!comment.viewerCanMinimize) {
    addSkipped(report, subject, 'viewer cannot minimize this review comment');
    return;
  }

  if (latestGatingReview?.state === 'CHANGES_REQUESTED') {
    addSkipped(
      report,
      subject,
      'review author still has an active changes-requested state',
    );
    return;
  }

  if (!thread.isResolved) {
    addSkipped(
      report,
      { ...subject, threadId: thread.id },
      'review thread is unresolved',
    );
    return;
  }

  if (thread.comments?.pageInfo?.hasNextPage) {
    addSkipped(
      report,
      { ...subject, threadId: thread.id },
      'review thread comment data is truncated',
    );
    return;
  }

  if (
    !hasFreshDisposition(thread, {
      isDispositionAuthor: makeIddDispositionAuthorPredicate(
        report.trustedMarkerActors,
      ),
    })
  ) {
    addSkipped(
      report,
      { ...subject, threadId: thread.id },
      'review thread is missing an IDD accept/reject disposition',
    );
    return;
  }

  report.candidates.push({
    ...subject,
    author,
    threadId: thread.id,
    reason: 'known bot feedback comment in a resolved review thread',
  });
}

function subjectFromNode(
  node: MinimizableNode,
  type: string,
  classifier: string,
): SubjectInfo {
  return {
    subjectId: node.id,
    url: node.url,
    type,
    classifier,
    viewerCanMinimize: Boolean(node.viewerCanMinimize),
    isMinimized: Boolean(node.isMinimized),
    minimizedReason: node.minimizedReason || null,
  };
}

function addSkipped(
  report: CleanupAuditReport,
  subject: ReportRow,
  reason: string,
): void {
  report.skipped.push({
    ...subject,
    skipReason: reason,
  });
}

function fetchPullRequest(
  owner: string,
  repo: string,
  number: number,
  options: GraphqlCallOptions = {},
): PullRequestNode {
  const query = `query($owner:String!,$repo:String!,$number:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        number
        url
        merged
      }
    }
  }`;
  const result = ghGraphql(query, { owner, repo, number }, options) as {
    data?: {
      repository?: { pullRequest?: PullRequestNode | null } | null;
    } | null;
  };
  const pr = result.data?.repository?.pullRequest;
  if (!pr) {
    handleGraphqlFailure(`PR #${number} was not found`, options);
  }
  return pr;
}

function fetchIssueComments(
  owner: string,
  repo: string,
  number: number,
  options: GraphqlCallOptions = {},
): IssueCommentNode[] {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        comments(first:100,after:$after){
          nodes{
            id
            url
            body
            createdAt
            updatedAt
            isMinimized
            minimizedReason
            viewerCanMinimize
            author{login}
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(
    query,
    { owner, repo, number },
    (data) => {
      return (
        data as {
          repository: {
            pullRequest: { comments: ConnectionPayload<IssueCommentNode> };
          };
        }
      ).repository.pullRequest.comments;
    },
    options,
  );
}

function fetchReviews(
  owner: string,
  repo: string,
  number: number,
  options: GraphqlCallOptions = {},
): ReviewNode[] {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviews(first:100,after:$after){
          nodes{
            id
            url
            body
            state
            submittedAt
            isMinimized
            minimizedReason
            viewerCanMinimize
            author{login}
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(
    query,
    { owner, repo, number },
    (data) => {
      return (
        data as {
          repository: {
            pullRequest: { reviews: ConnectionPayload<ReviewNode> };
          };
        }
      ).repository.pullRequest.reviews;
    },
    options,
  );
}

function fetchReviewThreads(
  owner: string,
  repo: string,
  number: number,
  options: GraphqlCallOptions = {},
): ReviewThreadNode[] {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        reviewThreads(first:100,after:$after){
          nodes{
            id
            isResolved
            comments(first:100){
              pageInfo{hasNextPage}
              nodes{
                id
                url
                body
                createdAt
                isMinimized
                minimizedReason
                viewerCanMinimize
                author{login}
                pullRequestReview{id}
              }
            }
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  return fetchConnection(
    query,
    { owner, repo, number },
    (data) => {
      return (
        data as {
          repository: {
            pullRequest: {
              reviewThreads: ConnectionPayload<ReviewThreadNode>;
            };
          };
        }
      ).repository.pullRequest.reviewThreads;
    },
    options,
  );
}

function fetchConnection<TNode>(
  query: string,
  baseVariables: Record<string, string | number>,
  pickConnection: (
    data: unknown,
  ) => ConnectionPayload<TNode> | null | undefined,
  options: GraphqlCallOptions = {},
): TNode[] {
  const nodes: TNode[] = [];
  let after: string | null | undefined = null;

  do {
    const variables: Record<string, string | number> = { ...baseVariables };
    if (after) {
      variables.after = after;
    }
    const result = ghGraphql(query, variables, options) as {
      data?: unknown;
      errors?: GraphqlErrorEntry[] | null;
    };
    if (result.errors?.length) {
      handleGraphqlFailure(
        `GraphQL connection query failed: ${formatGraphqlErrors(result.errors)}; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    if (!result.data) {
      handleGraphqlFailure(
        `GraphQL connection query returned no data; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    const connection = pickConnection(result.data);
    if (!connection) {
      handleGraphqlFailure(
        `GraphQL connection query returned no connection; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    nodes.push(...(connection.nodes ?? []));
    after = connection.pageInfo?.hasNextPage
      ? connection.pageInfo.endCursor
      : null;
  } while (after);

  return nodes;
}

function formatGraphqlErrors(errors: GraphqlErrorEntry[]): string {
  return errors
    .map((error) => error.message ?? JSON.stringify(error))
    .join('; ');
}

function formatGraphqlContext(
  query: string,
  variables: Record<string, string | number | null | undefined>,
): string {
  const compactQuery = query.replace(/\s+/g, ' ').trim();
  const queryPreview =
    compactQuery.length > 240
      ? `${compactQuery.slice(0, 237)}...`
      : compactQuery;
  return `query=${queryPreview}; variables=${JSON.stringify(variables)}`;
}

function minimizeComment(
  subjectId: string,
  classifier: string,
): MinimizedCommentNode {
  const query = `mutation($id:ID!,$classifier:ReportedContentClassifiers!){
    minimizeComment(input:{subjectId:$id,classifier:$classifier}){
      minimizedComment{
        __typename
        ... on IssueComment{id url isMinimized minimizedReason}
        ... on PullRequestReview{id url isMinimized minimizedReason}
        ... on PullRequestReviewComment{id url isMinimized minimizedReason}
      }
    }
  }`;
  const result = ghGraphql(
    query,
    { id: subjectId, classifier },
    { throwOnError: true },
  ) as {
    data?: {
      minimizeComment?: {
        minimizedComment?: MinimizedCommentNode | null;
      } | null;
    } | null;
    errors?: GraphqlErrorEntry[] | null;
  };
  if (result.errors?.length) {
    throw new Error(
      `GraphQL mutation failed: ${formatGraphqlErrors(result.errors)}; ${formatGraphqlContext(query, { id: subjectId, classifier })}`,
    );
  }
  const minimized = result.data?.minimizeComment?.minimizedComment;
  if (!minimized) {
    throw new Error(
      `GraphQL mutation returned no minimized comment; ${formatGraphqlContext(query, { id: subjectId, classifier })}`,
    );
  }
  return minimized;
}

async function revalidateCandidate(
  owner: string,
  repo: string,
  prNumber: number,
  candidate: ReportRow,
  report: CleanupAuditReport,
): Promise<ReportRow | null> {
  const freshReport = await buildReport(owner, repo, prNumber, {
    throwOnError: true,
  });
  const freshCandidate = freshReport.candidates.find((current) => {
    return (
      current.subjectId === candidate.subjectId &&
      current.classifier === candidate.classifier
    );
  });
  if (freshCandidate) {
    return freshCandidate;
  }

  const skipped = freshReport.skipped.find((current) => {
    return (
      current.subjectId === candidate.subjectId &&
      current.classifier === candidate.classifier
    );
  });
  // Carry the FRESH state of the candidate (not the stale scan row) so the
  // summary classifies it correctly: a candidate that was minimized between the
  // scan and this apply — typically a cascade when its parent was minimized
  // earlier in the same run — now has `isMinimized: true` and is counted as an
  // already-minimized (converged) skip, while a candidate that became
  // permission-blocked keeps `viewerCanMinimize: false` and is counted as a
  // genuine remainder. Without this, a cascade-minimized child kept the stale
  // `isMinimized: false`, so the run looked `incomplete` even though it
  // converged (#1039).
  addSkipped(
    report,
    skipped ?? candidate,
    `pre-minimize revalidation failed: ${skipped?.skipReason ?? 'candidate is no longer eligible'}`,
  );
  return null;
}

function assertActiveClaim(
  owner: string,
  repo: string,
  issueNumber: string | undefined,
  agentId: string | undefined,
  claimId: string | undefined,
  options: { expectedLinkedPrs?: string[] } = {},
): void {
  const active = readActiveClaim(owner, repo, issueNumber, options);
  if (
    !active ||
    active.claimId !== claimId ||
    (agentId && active.agentId !== agentId)
  ) {
    const activeLabel = active ? `${active.agentId} ${active.claimId}` : 'none';
    throw new Error(
      `claim check failed for #${issueNumber}: active claim is ${activeLabel}`,
    );
  }
}

function readActiveClaim(
  owner: string,
  repo: string,
  issueNumber: string | undefined,
  options: { expectedLinkedPrs?: string[] } = {},
): ActiveClaim | null {
  const result = JSON.parse(
    execFileSync(
      'gh',
      [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        `${owner}/${repo}`,
        '--json',
        'comments',
      ],
      { encoding: 'utf8' },
    ),
  ) as {
    comments?:
      | {
          body?: string | null;
          createdAt?: string | null;
          author?: GqlAuthorPayload | null;
        }[]
      | null;
  };

  const comments = (result.comments ?? []).map((comment) => ({
    body: comment.body ?? '',
    createdAt: comment.createdAt ?? '',
    author: { login: comment.author?.login ?? '' },
  }));

  // Read the authority policy once per call; the
  // isAuthorizedForcedHandoff callback may fire multiple times during
  // claim parsing and re-reading .github/idd/config.json on each call
  // would be a needless I/O hot path.
  const forcedHandoffAuthorityPolicyValue = readForcedHandoffAuthorityPolicy();
  const summary = summarizeClaimValidation(comments, {
    trustedMarkerLogins: resolveTrustedMarkerLogins(owner, repo, comments),
    forcedHandoffEnabled: readForcedHandoffMode() === 'human-gated',
    expectedLinkedPrs: options.expectedLinkedPrs ?? [],
    isAuthorizedForcedHandoff: (forcedBy) =>
      isAuthorizedForcedHandoffActor(
        owner,
        repo,
        forcedBy,
        forcedHandoffAuthorityPolicyValue,
        collaboratorPermissionCache,
      ),
  });

  return summary.activeClaimPresent ? summary.activeClaim : null;
}

function buildExpectedLinkedPrReferences(
  owner: string,
  repo: string,
  prNumber: number,
): string[] {
  const normalized = String(prNumber ?? '').trim();
  if (!normalized) {
    return [];
  }
  return [
    normalized,
    `#${normalized}`,
    `https://github.com/${owner}/${repo}/pull/${normalized}`,
  ];
}

function resolveTrustedMarkerLogins(
  owner: string,
  repo: string,
  comments: { author?: { login?: string | null } | null }[],
): string[] {
  return normalizeTrustedMarkerLogins(
    comments
      .map((comment) => comment.author?.login ?? '')
      .filter(Boolean)
      .filter((login) => isTrustedMarkerAuthor(owner, repo, login)),
  );
}

function isTrustedMarkerAuthor(
  owner: string,
  repo: string,
  login: string,
): boolean {
  if (!login) {
    return false;
  }

  const normalized = login.toLowerCase();
  if (normalized === currentViewerLogin()) {
    return true;
  }
  if (configuredTrustedMarkerAuthors().has(normalized)) {
    return true;
  }

  if (!trustCollaboratorMarkers()) {
    return false;
  }

  const cacheKey = `${owner}/${repo}:${normalized}`;
  if (trustedMarkerAuthorCache.has(cacheKey)) {
    return trustedMarkerAuthorCache.get(cacheKey) ?? false;
  }

  let trusted = false;
  try {
    const permission = execFileSync(
      'gh',
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .toLowerCase();
    trusted = TRUSTED_MARKER_PERMISSIONS.has(permission);
  } catch {
    trusted = false;
  }

  trustedMarkerAuthorCache.set(cacheKey, trusted);
  return trusted;
}

function currentViewerLogin(): string {
  if (cachedCurrentViewerLogin !== null) {
    return cachedCurrentViewerLogin;
  }

  try {
    cachedCurrentViewerLogin = execFileSync(
      'gh',
      ['api', 'user', '--jq', '.login'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .trim()
      .toLowerCase();
  } catch {
    cachedCurrentViewerLogin = '';
  }
  return cachedCurrentViewerLogin;
}

function configuredTrustedMarkerActorSources(): {
  actors: Set<string>;
  sources: string[];
} {
  if (cachedConfiguredTrustedMarkerActorSources) {
    return cachedConfiguredTrustedMarkerActorSources;
  }

  let config: { trustedMarkerActors?: unknown } | null = null;
  try {
    config = JSON.parse(readFileSync('.github/idd/config.json', 'utf8')) as {
      trustedMarkerActors?: unknown;
    };
  } catch {
    config = null;
  }
  const { actors, sources } = unionTrustedMarkerActorSources({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS ?? '',
    config,
  });
  cachedConfiguredTrustedMarkerActorSources = {
    actors: new Set(actors),
    sources,
  };
  return cachedConfiguredTrustedMarkerActorSources;
}

function configuredTrustedMarkerAuthors(): Set<string> {
  return configuredTrustedMarkerActorSources().actors;
}

function trustCollaboratorMarkers(): boolean {
  try {
    return resolveCollaboratorMarkerTrust(
      JSON.parse(readFileSync('.github/idd/config.json', 'utf8')),
      process.env.IDD_TRUST_COLLABORATOR_MARKERS,
    );
  } catch {
    // Fall through to env-var fallback.
  }
  return /^(1|true|yes)$/i.test(
    process.env.IDD_TRUST_COLLABORATOR_MARKERS ?? '',
  );
}

function ghGraphql(
  query: string,
  variables: Record<string, string | number | null | undefined>,
  options: GraphqlCallOptions = {},
): unknown {
  const commandArgs = ['api', 'graphql', '-f', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Number.isInteger(value)) {
      commandArgs.push('-F', `${key}=${value}`);
    } else {
      commandArgs.push('-f', `${key}=${value}`);
    }
  }

  try {
    return JSON.parse(execFileSync('gh', commandArgs, { encoding: 'utf8' }));
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };
    const stdout = String(e.stdout ?? '').trim();
    const stderr = String(e.stderr ?? '').trim();
    const response = parseJsonOrNull(stdout) as {
      errors?: GraphqlErrorEntry[] | null;
    } | null;
    if (response?.errors?.length) {
      handleGraphqlFailure(
        `GraphQL request failed: ${formatGraphqlErrors(response.errors)}; ${formatGraphqlContext(query, variables)}`,
        options,
      );
    }
    handleGraphqlFailure(
      `gh api graphql failed: ${stderr || e.message}; ${formatGraphqlContext(query, variables)}`,
      options,
    );
  }
}

function handleGraphqlFailure(
  message: string,
  options: GraphqlCallOptions,
): never {
  if (options.throwOnError) {
    throw new Error(message);
  }
  fail(message);
}

function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function detectRepository(): string {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  return execFileSync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      encoding: 'utf8',
    },
  ).trim();
}

function parseRepository(value: string): [string, string] {
  const parts = value.split('/');
  if (
    parts.length !== 2 ||
    parts.some((part) => part.length === 0 || /\s/.test(part))
  ) {
    fail(`invalid repository ${value}; expected owner/name`);
  }
  return parts as [string, string];
}

function writeReport(report: CleanupAuditReport, format: string): void {
  if (format === 'json') {
    console.log(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  // Print summary header
  if (report.summary) {
    console.log(
      `summary: status=${report.status}, candidates=${report.summary.candidate}, applied=${report.summary.applied}, failed=${report.summary.failed}, skipped=${report.summary.skipped}`,
    );
    console.log('');
  }

  printRows('candidates', report.candidates);
  printRows('skipped', report.skipped);
  if (report.applied.length > 0) {
    printRows('applied', report.applied);
  }
  if (report.failed.length > 0) {
    printRows('failed', report.failed);
  }
}

function printRows(label: string, rows: ReportRow[]): void {
  console.log(`${label}: ${rows.length}`);
  if (rows.length === 0) {
    return;
  }
  console.log(
    [
      'subjectId',
      'type',
      'classifier',
      'viewerCanMinimize',
      'isMinimized',
      'minimizedReason',
      'reason',
      'url',
    ].join('\t'),
  );
  for (const row of rows) {
    console.log(
      [
        row.subjectId,
        row.type,
        row.classifier,
        row.viewerCanMinimize,
        row.isMinimized,
        row.minimizedReason ?? '',
        row.error ?? row.skipReason ?? row.reason ?? '',
        row.url,
      ].join('\t'),
    );
  }
}

function parseArgs(argv: string[]): CleanupArgs {
  const parsed: CleanupArgs = {
    format: 'json',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--pr':
        parsed.pr = readValue(argv, ++index, arg);
        break;
      case '--repo':
        parsed.repo = readValue(argv, ++index, arg);
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--apply':
        parsed.apply = true;
        break;
      case '--format':
        parsed.format = readValue(argv, ++index, arg);
        if (!['json', 'table'].includes(parsed.format)) {
          fail('--format must be json or table');
        }
        break;
      case '--claim-issue':
        parsed.claimIssue = readValue(argv, ++index, arg);
        break;
      case '--claim-id':
        parsed.claimId = readValue(argv, ++index, arg);
        break;
      case '--agent-id':
        parsed.agentId = readValue(argv, ++index, arg);
        break;
      case '--skip-claim-check':
        parsed.skipClaimCheck = true;
        break;
      default:
        fail(`unknown argument ${arg}`);
    }
  }

  return parsed;
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function printUsage(): void {
  console.log(`usage: node scripts/audit-pr-cleanup.mjs --pr <number> [options]

Options:
  --dry-run                         list candidates without mutating (default)
  --apply                           minimize safe candidates
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override
  --format <json|table>             output format (default: json)
  --help                            show this help

Environment:
  IDD_TRUSTED_MARKER_ACTORS         comma-separated trusted bot/app logins
                                    (combined with config.json trustedMarkerActors)
  IDD_TRUST_COLLABORATOR_MARKERS    set true to trust Write/Maintain/Admin collaborators
`);
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(2);
}
