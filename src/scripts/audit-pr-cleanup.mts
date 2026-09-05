#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-pr-cleanup.mts
//
// The scripts/audit-pr-cleanup.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CleanupReport } from './audit-pr-cleanup-summary.mts';
import { computeReportSummary } from './audit-pr-cleanup-summary.mts';
import { parseCliArgs } from './cli-args.mts';
import type { CollaboratorPermissionCache } from './collaborator-permission.mts';
import {
  isAuthorizedForcedHandoffActor,
  readForcedHandoffAuthorityPolicy,
  readForcedHandoffMode,
} from './collaborator-permission.mts';
import { combineOwnerRepoFlags, ghText } from './gh-exec.mts';
import { resolveCollaboratorMarkerTrust } from './policy-helpers.mts';
import type { ClaimValidationSummary } from './protocol-helpers.mts';
import {
  classifyRegularBotComment,
  classifyThreadAckOnlyPostDisposition,
  hasFreshDisposition,
  indexLatestGatingReviewsByAuthor,
  indexThreadsByReview,
  isDispositionComment,
  isKnownReviewBot,
  normalizeTrustedMarkerLogins,
  operationalMarkerPrefix,
  resolveAdvisoryBotLogins,
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
export interface ReviewThreadNode {
  id?: string | null;
  isResolved?: boolean | null;
  comments?: {
    pageInfo?: {
      hasNextPage?: boolean | null;
      endCursor?: string | null;
    } | null;
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
export interface CleanupAuditReport extends CleanupReport {
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
  /**
   * Number of internal whole-pass apply attempts `runApplyWithRetry` ran
   * (#2011). Present only in apply mode.
   */
  retryAttempts?: number;
  /**
   * True when the internal retry bound was reached while a fresh rescan
   * still reported candidates (#2011) — distinct from an ordinary
   * `applied`/`clean` convergence, which leaves this unset. Does not alter
   * `status`, computed by the shared, untouched `computeReportSummary`.
   */
  retryBoundExhausted?: boolean;
  /**
   * Set when a confirming rescan itself failed (#2011) — the report still
   * carries every candidate this run genuinely applied before the
   * failure, rather than losing that record to an uncaught exit.
   */
  rescanError?: string;
}

/** Active claim resolved from the trusted claim-marker stream. */
type ActiveClaim = ClaimValidationSummary['activeClaim'];

/** Parsed CLI arguments. */
export interface CleanupArgs {
  format: string;
  help?: boolean;
  pr?: string;
  prs?: string;
  repo?: string;
  owner?: string;
  dryRun?: boolean;
  apply?: boolean;
  claimIssue?: string;
  claimId?: string;
  agentId?: string;
  skipClaimCheck?: boolean;
}

/**
 * Claim-check context threaded through apply-mode candidate processing
 * (#2011's `applyCandidatePass`), matching {@link assertActiveClaim}'s
 * `options` shape.
 */
interface ClaimContext {
  expectedLinkedPrs?: string[];
  prFirstCommitAt?: string | null;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant.
const AUDIT_PR_CLEANUP_FLAG_SPEC = {
  '--help': { type: 'boolean', short: 'h', default: false },
  '--pr': { type: 'string' },
  '--prs': { type: 'string' },
  '--repo': { type: 'string' },
  '--owner': { type: 'string' },
  '--dry-run': { type: 'boolean', default: false },
  '--apply': { type: 'boolean', default: false },
  '--format': { type: 'string', default: 'json' },
  '--claim-issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--skip-claim-check': { type: 'boolean', default: false },
} as const;

const TRUSTED_MARKER_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const trustedMarkerAuthorCache = new Map<string, boolean>();
const collaboratorPermissionCache: CollaboratorPermissionCache = new Map();
let cachedConfiguredTrustedMarkerActorSources: {
  actors: Set<string>;
  sources: string[];
} | null = null;
let cachedCurrentViewerLogin: string | null = null;
let cachedConfiguredAdvisoryBotLogins: string[] | null = null;

/** Default bound on whole-pass apply retries (#2011). */
const DEFAULT_APPLY_RETRY_MAX_ATTEMPTS = 3;

/** Base backoff (ms) before each rescan; linear-ish with jitter, matching
 * {@link withBoundedRetry}'s formula in gh-exec.mts. */
const DEFAULT_APPLY_RETRY_BACKOFF_MS = 200;

const REVIEW_THREAD_COMMENT_FIELDS = `
  id
  url
  body
  createdAt
  isMinimized
  minimizedReason
  viewerCanMinimize
  author{login}
  pullRequestReview{id}
`;

// #2478: a thread with more than 100 comments needs its own continuation
// query -- `node(id)` re-entry is the only way to page an inner connection
// past its first page, since the outer reviewThreads cursor only advances
// between threads. 50 pages (5,000 comments) is far beyond any real review
// thread; hitting it leaves `pageInfo.hasNextPage: true` on the returned
// node exactly as an un-paginated first page would, so the existing
// truncated-data skip in evaluateReviewComment (thread.comments.pageInfo.
// hasNextPage) still fires rather than misreporting a capped thread as
// complete.
const MAX_REVIEW_THREAD_COMMENT_PAGES = 50;

if (import.meta.main) {
  await main();
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call. This one stays async
// because it retains a pre-existing await (buildReport) from before the
// guard was added.
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
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

  if (
    args.apply &&
    !args.skipClaimCheck &&
    (!args.claimIssue || !args.claimId)
  ) {
    fail(
      '--apply requires --claim-issue and --claim-id, or explicit --skip-claim-check',
    );
  }

  assertBatchApplyClaimScope(args);

  let repository: string;
  try {
    repository = combineOwnerRepoFlags(args) ?? detectRepository();
  } catch (error) {
    fail((error as Error).message);
  }
  const [owner, repo] = parseRepository(repository);

  const prNumbers = parsePrNumbers(args);

  if (args.claimIssue) {
    args.claimIssue = String(
      parsePositiveInteger(args.claimIssue, '--claim-issue'),
    );
  }

  // #2224: owner/repo detection above and the module-level trust/permission
  // caches (trustedMarkerAuthorCache, collaboratorPermissionCache,
  // cachedConfiguredTrustedMarkerActorSources, cachedCurrentViewerLogin) are
  // process-lifetime state, so a --prs batch already shares that
  // per-invocation setup cost across every PR in the loop below.
  //
  // Table-format batches print a header before each PR's block: the table
  // renderer's summary/candidate rows never include the `pr`/`repository`
  // fields (unlike JSON, where each report object already self-identifies
  // via its own `pr` field), so consecutive same-shaped blocks would
  // otherwise be indistinguishable (Copilot review, PR #2305).
  const printBatchHeader = args.format === 'table' && prNumbers.length > 1;
  let anyFailed = false;
  for (const prNumber of prNumbers) {
    if (printBatchHeader) {
      console.log(`=== PR #${prNumber} ===`);
    }
    if (await processOnePr(owner, repo, prNumber, args)) {
      anyFailed = true;
    }
  }

  if (anyFailed) {
    process.exit(1);
  }
}

/**
 * Rejects a claim-gated `--apply` batch (#2224, CodeRabbit review on PR
 * #2305): `assertActiveClaim` only verifies the caller holds
 * `--claim-issue`'s active claim; it does not bind that claim to any
 * specific PR (`expectedLinkedPrs` only feeds forced-handoff resolution). A
 * single-PR `--apply` already carries that weak binding, but `--prs` would
 * let one active claim authorize `--apply` mutations across every PR in the
 * batch at once, widening the blast radius of a single claim check.
 * `--skip-claim-check` (the explicit maintainer override) opts out of this
 * guard, same as it does for the existing single-PR claim requirement.
 */
export function assertBatchApplyClaimScope(args: CleanupArgs): void {
  if (args.apply && args.prs && !args.skipClaimCheck) {
    fail(
      '--prs with --apply requires --skip-claim-check (a single active claim would otherwise authorize --apply across every PR in the batch)',
    );
  }
}

/**
 * Resolves `--pr`/`--prs` into an ordered, de-duplicated list of PR numbers.
 * Validates that exactly one of the two is present itself (Copilot review,
 * PR #2305) rather than trusting the caller to have checked first — an
 * unconditional `args.prs as string` cast on a direct call with neither flag
 * would otherwise throw a raw `TypeError` instead of failing consistently
 * through {@link fail}. `--prs` splits on `,`, trims whitespace, drops empty
 * tokens, and validates each remaining token with the same
 * {@link parsePositiveInteger} used by `--pr`.
 */
export function parsePrNumbers(args: CleanupArgs): number[] {
  if (!args.pr && !args.prs) {
    fail('missing required --pr <number> or --prs <n1,n2,...>');
  }
  if (args.pr && args.prs) {
    fail('choose only one of --pr or --prs');
  }
  if (args.pr) {
    return [parsePositiveInteger(args.pr, '--pr')];
  }
  const seen = new Set<number>();
  const numbers: number[] = [];
  for (const token of (args.prs as string).split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') {
      continue;
    }
    const value = parsePositiveInteger(trimmed, '--prs');
    if (!seen.has(value)) {
      seen.add(value);
      numbers.push(value);
    }
  }
  if (numbers.length === 0) {
    fail('--prs must contain at least one PR number');
  }
  return numbers;
}

/**
 * Runs the audit-and-optionally-apply pass for one PR (extracted verbatim
 * from the pre-#2224 single-PR `main()` body) and prints its report in the
 * existing single-PR output shape. Returns whether this PR's report
 * indicates a failure instead of calling `process.exit(1)` directly, so a
 * `--prs` batch's aggregate exit code (set by the caller) reflects any PR's
 * failure without one PR's failure skipping the rest of the batch.
 */
async function processOnePr(
  owner: string,
  repo: string,
  prNumber: number,
  args: CleanupArgs,
): Promise<boolean> {
  const claimContext = {
    expectedLinkedPrs: buildExpectedLinkedPrReferences(owner, repo, prNumber),
    // The PR's first-commit time backs the Part B forced-handoff rule (#1058):
    // a legitimate issue-only handoff that predates the PR is honored even
    // against this PR-backed claim. Resolve it once for both claim asserts.
    prFirstCommitAt: args.apply
      ? fetchPrFirstCommitAt(owner, repo, prNumber)
      : null,
  };

  const report = await buildReport(owner, repo, prNumber);

  if (args.apply) {
    report.mode = 'apply';
    const {
      report: finalReport,
      attempts,
      boundExhausted,
    } = await runApplyWithRetry(
      report,
      (pass) =>
        applyCandidatePass(owner, repo, prNumber, pass, args, claimContext),
      // throwOnError so a transient GraphQL/gh failure on this confirming
      // rescan is catchable by runApplyWithRetry (which preserves the
      // already-applied work) instead of exiting the process outright.
      () => buildReport(owner, repo, prNumber, { throwOnError: true }),
    );
    finalReport.retryAttempts = attempts;
    if (boundExhausted) {
      finalReport.retryBoundExhausted = true;
    }

    computeReportSummary(finalReport);
    if (finalReport.failed.length > 0 || finalReport.rescanError) {
      writeReport(finalReport, args.format);
      return true;
    }

    computeReportSummary(finalReport);
    writeReport(finalReport, args.format);
    return false;
  }

  computeReportSummary(report);
  writeReport(report, args.format);
  return false;
}

/**
 * Runs one whole apply pass over `report.candidates`, mutating
 * `report.applied` / `report.failed` in place (#2011, extracted verbatim
 * from the previous single-pass `main()` body). Re-validates the active
 * claim before each candidate, and again after `revalidateCandidate`'s
 * fresh per-candidate re-fetch, matching the pre-existing behavior.
 */
async function applyCandidatePass(
  owner: string,
  repo: string,
  prNumber: number,
  report: CleanupAuditReport,
  args: CleanupArgs,
  claimContext: ClaimContext,
): Promise<void> {
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
}

/** Default backoff before a rescan: gives GraphQL read-after-write lag on
 * the previous pass's minimizeComment calls a moment to settle (#2011). */
async function defaultApplyRetryBackoff(attempt: number): Promise<void> {
  await sleep(
    DEFAULT_APPLY_RETRY_BACKOFF_MS * attempt +
      Math.random() * DEFAULT_APPLY_RETRY_BACKOFF_MS,
  );
}

/** Outcome of {@link runApplyWithRetry}. */
export interface ApplyRetryResult {
  report: CleanupAuditReport;
  attempts: number;
  boundExhausted: boolean;
}

/**
 * Retries a whole apply-and-rescan pass, bounded by `maxAttempts`, so a
 * candidate that only becomes eligible after the previous pass finished
 * (e.g. GraphQL read-after-write lag on `minimizeComment`, #2011) still
 * converges within one `--apply` invocation instead of requiring a second,
 * manual call.
 *
 * `applyPass`, `rescan`, and `backoff` are injected rather than calling
 * `buildReport` / `gh` / real timers directly, so this orchestration is
 * unit-testable with fakes. `applyPass` must mutate its report argument's
 * `applied` / `failed` arrays in place (matching
 * {@link applyCandidatePass}); `rescan` must return a fresh
 * dry-run-equivalent report reflecting current state; `backoff` waits
 * before each rescan (default: a short linear-ish delay with jitter, so
 * GraphQL read-after-write lag on the pass's own mutations has a moment
 * to settle before re-querying).
 *
 * Stops immediately, without any further rescan, the first time a pass
 * leaves `failed` non-empty (matches the pre-existing fail-fast
 * behavior). Otherwise rescans after every pass: zero candidates means
 * converged; a non-empty rescan below the attempt bound starts another
 * pass, carrying the accumulated `applied` list onto the fresh report;
 * a non-empty rescan at the attempt bound is reported as
 * `boundExhausted` rather than retried further.
 */
export async function runApplyWithRetry(
  initialReport: CleanupAuditReport,
  applyPass: (report: CleanupAuditReport) => Promise<void>,
  rescan: () => Promise<CleanupAuditReport>,
  maxAttempts: number = DEFAULT_APPLY_RETRY_MAX_ATTEMPTS,
  backoff: (attempt: number) => Promise<void> = defaultApplyRetryBackoff,
): Promise<ApplyRetryResult> {
  // A non-finite `maxAttempts` (`Infinity`) would defeat the bounded-retry
  // contract with an unbounded loop; a fractional value (e.g. `2.5`) would
  // never satisfy `attempt === maxAttempts` below and fall through to the
  // fallback return with an incorrect `attempts: 0` (same class of bug as
  // `withBoundedRetry`'s `attempts` guard, gh-exec.mts, #1394).
  const totalAttempts = Number.isFinite(maxAttempts)
    ? Math.max(1, Math.trunc(maxAttempts))
    : DEFAULT_APPLY_RETRY_MAX_ATTEMPTS;
  let report = initialReport;
  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    await applyPass(report);
    if (report.failed.length > 0) {
      return { report, attempts: attempt, boundExhausted: false };
    }

    // A short backoff before rescanning gives GraphQL read-after-write lag
    // on this pass's minimizeComment calls a moment to settle, instead of
    // immediately re-querying the same stale state.
    await backoff(attempt);

    let freshReport: CleanupAuditReport;
    try {
      freshReport = await rescan();
    } catch (error) {
      // Preserve the already-mutated report (including the accumulated
      // `applied` list) instead of losing it to an uncaught rescan
      // failure — `rescan` is expected to be called with a
      // throw-on-error option so a transient GraphQL/gh hiccup lands
      // here rather than exiting the process outright.
      report.rescanError = (error as Error).message;
      return { report, attempts: attempt, boundExhausted: false };
    }
    freshReport.mode = 'apply';
    // Exclude subjects this run already applied from the fresh rescan's
    // `candidates` / `skipped`: `buildReport` classifies a just-minimized
    // comment as an already-minimized skip, so grafting `applied` onto an
    // unfiltered rescan would place the same subject in both arrays
    // (inflating skipped counts) and, left in `candidates`, would get
    // re-mutated by the next pass (wasting the retry bound on rediscovering
    // work already done instead of finding genuinely new candidates).
    const appliedSubjectIds = new Set(
      report.applied.map((row) => row.subjectId),
    );
    freshReport.candidates = freshReport.candidates.filter(
      (row) => !appliedSubjectIds.has(row.subjectId),
    );
    freshReport.skipped = freshReport.skipped.filter(
      (row) => !appliedSubjectIds.has(row.subjectId),
    );
    // Carry the accumulated `applied` list onto the fresh rescan so the
    // returned report's `candidates` / `skipped` reflect confirmed
    // post-apply state (e.g. cascade-minimized items now show up as
    // already-minimized skips) rather than the stale pre-apply snapshot
    // that fed this pass.
    freshReport.applied = report.applied;
    if (freshReport.candidates.length === 0) {
      return { report: freshReport, attempts: attempt, boundExhausted: false };
    }
    if (attempt === totalAttempts) {
      return { report: freshReport, attempts: attempt, boundExhausted: true };
    }

    report = freshReport;
  }
  // Unreachable: totalAttempts is normalized to >= 1 above, so the loop
  // always runs at least one attempt and returns from inside it.
  return { report, attempts: 0, boundExhausted: true };
}

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
    iddAgentLogins,
    advisoryBotLogins: configuredAdvisoryBotLogins(),
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

/** Exported for direct unit testing (#2618); not part of the CLI surface. */
export function evaluateReviewComment(
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
    }) &&
    !classifyThreadAckOnlyPostDisposition(thread, {
      iddAgentLogins: report.trustedMarkerActors,
      advisoryBotLogins: configuredAdvisoryBotLogins(),
    }).ackOnlyPostDisposition
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

/**
 * Resolve the PR's first-commit time as an ISO string for the Part B
 * forced-handoff rule (#1058): the minimum committed date (falling back to
 * authored date) across the PR's commits. Returns `null` when no commit
 * carries a parseable date — which makes the Part B gate fail closed
 * (issue-only handoffs against a PR-backed claim stay rejected). Fails safe to
 * `null` on any lookup error rather than aborting the claim assertion.
 */
function fetchPrFirstCommitAt(
  owner: string,
  repo: string,
  number: number,
): string | null {
  const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$number){
        commits(first:100,after:$after){
          nodes{commit{committedDate authoredDate}}
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  let earliestMs: number | null = null;
  let earliestIso: string | null = null;
  let after: string | null = null;
  try {
    for (;;) {
      const result = ghGraphql(
        query,
        { owner, repo, number, after },
        // Fail safe: a lookup error throws (caught below) instead of aborting
        // the whole claim assertion via the default process-exit path.
        { throwOnError: true },
      ) as {
        data?: {
          repository?: {
            pullRequest?: {
              commits?: {
                nodes?:
                  | {
                      commit?: {
                        committedDate?: string | null;
                        authoredDate?: string | null;
                      } | null;
                    }[]
                  | null;
                pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
              } | null;
            } | null;
          } | null;
        } | null;
      } | null;
      const connection = result?.data?.repository?.pullRequest?.commits;
      if (!connection) {
        break;
      }
      for (const node of connection.nodes ?? []) {
        const date =
          String(node?.commit?.committedDate ?? '').trim() ||
          String(node?.commit?.authoredDate ?? '').trim();
        if (!date) {
          continue;
        }
        const ms = Date.parse(date);
        if (!Number.isFinite(ms)) {
          continue;
        }
        if (earliestMs === null || ms < earliestMs) {
          earliestMs = ms;
          earliestIso = date;
        }
      }
      if (!connection.pageInfo?.hasNextPage) {
        break;
      }
      after = connection.pageInfo.endCursor ?? null;
      if (!after) {
        break;
      }
    }
  } catch {
    return null;
  }
  return earliestIso;
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

// Exported for tests/audit-pr-cleanup.test.mts (#2478): the only way to
// exercise the >100-comment inner-pagination walk without spawning the full
// CLI and stubbing every gh call `buildReport` needs.
export function fetchReviewThreads(
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
              pageInfo{hasNextPage endCursor}
              nodes{${REVIEW_THREAD_COMMENT_FIELDS}}
            }
          }
          pageInfo{hasNextPage endCursor}
        }
      }
    }
  }`;
  const threads = fetchConnection(
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
  for (const thread of threads) {
    if (thread.id && thread.comments?.pageInfo?.hasNextPage) {
      thread.comments = fetchRemainingThreadComments(
        thread.id,
        thread.comments,
        options,
      );
    }
  }
  return threads;
}

function fetchRemainingThreadComments(
  threadId: string,
  firstPage: NonNullable<ReviewThreadNode['comments']>,
  options: GraphqlCallOptions,
): NonNullable<ReviewThreadNode['comments']> {
  const query = `query($id:ID!,$after:String){
    node(id:$id){
      ... on PullRequestReviewThread{
        comments(first:100,after:$after){
          pageInfo{hasNextPage endCursor}
          nodes{${REVIEW_THREAD_COMMENT_FIELDS}}
        }
      }
    }
  }`;
  const nodes = [...(firstPage.nodes ?? [])];
  let pageInfo = firstPage.pageInfo;
  let pagesFetched = 1;
  while (pageInfo?.hasNextPage) {
    if (pagesFetched >= MAX_REVIEW_THREAD_COMMENT_PAGES) {
      break;
    }
    if (!pageInfo.endCursor) {
      // Mirrors fetchReviewThreadsGeneric's same guard in
      // provider-adapter-github.mts: fail loudly on a contract-violating
      // hasNextPage:true-with-no-endCursor page rather than silently
      // re-requesting page 1 (ghGraphql drops a null `after` variable),
      // which could otherwise "self-heal" into duplicate comment nodes.
      handleGraphqlFailure(
        `GraphQL thread-comment continuation: hasNextPage without endCursor for thread ${threadId}`,
        options,
      );
    }
    const result = ghGraphql(
      query,
      { id: threadId, after: pageInfo.endCursor },
      options,
    ) as {
      data?: {
        node?: {
          comments?: {
            pageInfo?: {
              hasNextPage?: boolean | null;
              endCursor?: string | null;
            } | null;
            nodes?: ThreadCommentNode[] | null;
          } | null;
        } | null;
      };
      errors?: GraphqlErrorEntry[] | null;
    };
    if (result.errors?.length) {
      handleGraphqlFailure(
        `GraphQL thread-comment continuation failed: ${formatGraphqlErrors(result.errors)}; thread=${threadId}`,
        options,
      );
    }
    const nextComments = result.data?.node?.comments;
    if (!nextComments) {
      handleGraphqlFailure(
        `GraphQL thread-comment continuation returned no comments; thread=${threadId}`,
        options,
      );
    }
    nodes.push(...(nextComments.nodes ?? []));
    pageInfo = nextComments.pageInfo;
    pagesFetched += 1;
  }
  return { pageInfo: pageInfo ?? null, nodes };
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
  options: {
    expectedLinkedPrs?: string[];
    prFirstCommitAt?: string | null;
  } = {},
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
  options: {
    expectedLinkedPrs?: string[];
    prFirstCommitAt?: string | null;
  } = {},
): ActiveClaim | null {
  const result = JSON.parse(
    ghText([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'comments',
    ]),
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
    prFirstCommitAt: options.prFirstCommitAt ?? null,
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
    const permission = ghText(
      [
        'api',
        `repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
        '--jq',
        '.permission',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toLowerCase();
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
    cachedCurrentViewerLogin = ghText(['api', 'user', '--jq', '.login'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toLowerCase();
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

// #2618: this repository's configured advisory-bot logins, feeding the
// ack-only-post-disposition carve-out (`classifyThreadAckOnlyPostDisposition`)
// so F4 recognizes the same courtesy-ack shape F2/F3 already does.
function configuredAdvisoryBotLogins(): string[] {
  if (cachedConfiguredAdvisoryBotLogins) {
    return cachedConfiguredAdvisoryBotLogins;
  }
  let config: { advisoryBotLogins?: unknown } | null = null;
  try {
    config = JSON.parse(readFileSync('.github/idd/config.json', 'utf8')) as {
      advisoryBotLogins?: unknown;
    };
  } catch {
    config = null;
  }
  cachedConfiguredAdvisoryBotLogins = resolveAdvisoryBotLogins({
    config,
  }).logins;
  return cachedConfiguredAdvisoryBotLogins;
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
    return JSON.parse(ghText(commandArgs));
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
  return ghText([
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
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
    const retrySuffix =
      report.retryAttempts === undefined
        ? ''
        : `, retryAttempts=${report.retryAttempts}, retryBoundExhausted=${Boolean(report.retryBoundExhausted)}`;
    const rescanErrorSuffix = report.rescanError
      ? `, rescanError=${report.rescanError}`
      : '';
    console.log(
      `summary: status=${report.status}, candidates=${report.summary.candidate}, applied=${report.summary.applied}, failed=${report.summary.failed}, skipped=${report.summary.skipped}${retrySuffix}${rescanErrorSuffix}`,
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
  // No test in this file asserts the pre-migration message text or the
  // no-colon "unknown argument X" / "X requires a value" spelling (see
  // #1451's PR description), so a parse failure adopts the wrapper's
  // uniform message. The exit-code-2 contract IS preserved: catch the
  // wrapper's thrown Error here and route it through this file's own
  // fail() exactly as every other malformed-input path already does.
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv, AUDIT_PR_CLEANUP_FLAG_SPEC);
  } catch (error) {
    fail((error as Error).message);
  }
  const { values, help } = parsed;

  // The pre-migration readValue() used `!value` (not `=== undefined`), so
  // an explicit empty-string value was rejected the same as an omitted
  // flag for EVERY flag in this file. parseCliArgs accepts an empty
  // string (matching bare node:util parseArgs), so this check restores
  // that exact uniform pre-migration behavior. The message matches
  // parseCliArgs' own "missing value for argument: <flag>" phrasing
  // (Copilot review finding on PR #1467) so an empty-string value and an
  // omitted/flag-shaped value report the same failure style.
  const requireNonEmpty = (
    token: string | undefined,
    flag: string,
  ): string | undefined => {
    if (token === '') {
      fail(`missing value for argument: ${flag}`);
    }
    return token;
  };

  const pr = requireNonEmpty(values.pr as string | undefined, '--pr');
  const prs = requireNonEmpty(values.prs as string | undefined, '--prs');
  const repo = requireNonEmpty(values.repo as string | undefined, '--repo');
  const owner = requireNonEmpty(values.owner as string | undefined, '--owner');
  const format = requireNonEmpty(values.format as string, '--format') as string;
  if (!['json', 'table'].includes(format)) {
    fail('--format must be json or table');
  }
  const claimIssue = requireNonEmpty(
    values['claim-issue'] as string | undefined,
    '--claim-issue',
  );
  const claimId = requireNonEmpty(
    values['claim-id'] as string | undefined,
    '--claim-id',
  );
  const agentId = requireNonEmpty(
    values['agent-id'] as string | undefined,
    '--agent-id',
  );

  return {
    format,
    help,
    pr,
    prs,
    repo,
    owner,
    dryRun: values['dry-run'] as boolean,
    apply: values.apply as boolean,
    claimIssue,
    claimId,
    agentId,
    skipClaimCheck: values['skip-claim-check'] as boolean,
  };
}

function parsePositiveInteger(value: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    fail(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

function printUsage(): void {
  console.log(`usage: node scripts/audit-pr-cleanup.mjs (--pr <number> | --prs <n1,n2,...>) [options]

Options:
  --pr <number>                     single-PR mode (mutually exclusive with --prs)
  --prs <n1,n2,...>                 batch mode: audit several PRs in one
                                     invocation, emitting one report per PR
                                     in the existing output shape (mutually
                                     exclusive with --pr)
  --dry-run                         list candidates without mutating (default)
  --apply                           minimize safe candidates
  --claim-issue <number>            issue whose active claim protects apply mode
  --claim-id <id>                   active claim id required for apply mode
  --agent-id <id>                   optionally require this claim agent id
  --skip-claim-check                explicit maintainer override for apply mode
  --repo <owner/name>               repository override, combined form
  --owner <owner>                   repository override, split form (use
                                     with --repo <name>, the bare
                                     repository name -- not both --owner
                                     and a combined --repo together)
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
