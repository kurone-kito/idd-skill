#!/usr/bin/env node
// idd-generated-from: src/scripts/review-activity-snapshot.mts
//
// The scripts/review-activity-snapshot.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseCliArgs } from './cli-args.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  buildActivitySnapshotSummary,
  countUncoveredCodeRabbitEmbeddedFindings,
  extractCodeRabbitEmbeddedFindings,
  normalizeTrustedMarkerLogins,
  resolveAdvisoryBotLogins,
  resolveTrustedMarkerActors,
  summarizeDispositionEvidenceForGate,
} from './protocol-helpers.mts';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mts';
import type {
  ProviderComment,
  ProviderReviewThreadWithComments,
} from './provider-port.mts';

/** Author reference embedded in GitHub REST/GraphQL payloads. */
interface GhAuthorPayload {
  login?: string | null;
}

/** PR review payload fields consumed by this helper -- raw REST shape,
 * unchanged by the #2267 port migration ({@link ProviderPort.listReviews}
 * is a raw passthrough). */
interface ReviewPayload {
  state?: string | null;
  body?: string | null;
  node_id?: string | null;
  user?: GhAuthorPayload | null;
  submitted_at?: string | null;
  updated_at?: string | null;
}

/** REST logins `REVIEW_BOT_LOGINS` lists for CodeRabbit. Codex connector
 * logins in that same set are not CodeRabbit reviews. */
const CODE_RABBIT_REVIEW_LOGINS = new Set([
  'coderabbitai',
  'coderabbitai[bot]',
]);

export interface CodeRabbitEmbeddedFindingReport {
  reviewId: string;
  embeddedFindingCount: number;
  uncoveredCount: number;
}

/** Parsed CLI arguments. */
interface ReviewActivitySnapshotArgs {
  prNumber: number | null;
  owner: string;
  repo: string;
  trustedMarkerLogins: string;
  advisoryBotLogins: string;
  help: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant. (This
// comment deliberately avoids writing that key inside matching quote
// marks, so it cannot itself satisfy the scan if the real key is ever
// renamed -- see #1446's PR description for why that matters.)
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls main() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see ci-wait-policy.mts's identical note).
const REVIEW_ACTIVITY_SNAPSHOT_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--advisory-bot-logins': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  // #3344: call main() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('review-activity-snapshot', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}

// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call. Returns 0 or throws -- `runHelperCli` (#3344) classifies a
// thrown error when the opt-in JSON error envelope is enabled.
function main(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw markCliUsageError(
      new Error('missing required --pr <number> argument'),
    );
  }

  const currentRepo =
    args.owner && args.repo ? null : resolveCurrentGithubRepository();
  const owner = args.owner || currentRepo?.owner || '';
  const repo = args.repo || currentRepo?.repo || '';
  const port = createGithubProviderAdapter(owner, repo);
  const iddConfig = loadIddConfig();
  const { actors: trustedMarkerLogins, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: args.trustedMarkerLogins,
      envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
      config: iddConfig,
    });
  const { logins: advisoryBotLogins, source: advisoryBotLoginsSource } =
    resolveAdvisoryBotLogins({
      flagValue: args.advisoryBotLogins,
      envValue: process.env.IDD_ADVISORY_BOT_LOGINS,
      config: iddConfig,
    });
  // Issue #3337: the viewer-merged set feeds every trust/disposition-author
  // input below (both `buildActivitySnapshotSummary` and
  // `summarizeDispositionEvidenceForGate`) so an agent with no configured
  // trusted actor still has its own digest and other operational markers
  // recognized consistently on both the E1 activity side and the
  // disposition-evidence side -- see `resolveActivitySnapshotTrustedMarkerLogins`'s
  // own doc comment. The diagnostic `trustedMarkerActors` field in this
  // helper's JSON output (below) intentionally keeps reporting the
  // configured-only `trustedMarkerLogins` resolution, unchanged.
  const activityTrustedMarkerLogins =
    resolveActivitySnapshotTrustedMarkerLogins(
      trustedMarkerLogins,
      port.resolveViewerLoginSafe(),
    );

  // #1833: also reads the PR author's login (not just headSha) --
  // `summarizeDispositionEvidenceForGate` below needs it to exclude the
  // author's own comments/thread replies from "missing disposition" (they
  // never require one), the same way `buildPreMergeReadinessSummary`'s own
  // call to that function does. A missing/unresolvable head SHA fails
  // closed downstream (`watermarkFieldsFromSnapshot` in post-idd-marker.mts
  // throws "missing a usable headSha"), not a silent bad watermark.
  const { headSha: rawHeadSha, authorLogin: rawAuthorLogin } =
    port.getChangeRequestHeadShaAndAuthor(args.prNumber);
  const headSha = rawHeadSha;
  const prAuthorLogin = rawAuthorLogin.trim().toLowerCase();
  const checks = port.listChangeRequestChecks(args.prNumber);
  const reviews = port.listReviews(args.prNumber) as ReviewPayload[];
  const comments = port.listWorkItemComments(args.prNumber);
  const threads = port.listChangeRequestReviewThreadsWithComments(
    args.prNumber,
  );
  const normalizedComments = comments.map(normalizeComment);
  const normalizedThreads = threads.map(normalizeThread);

  const summary = buildActivitySnapshotSummary(
    {
      comments: normalizedComments,
      reviews: reviews.map(normalizeReview),
      threads: normalizedThreads,
      checks,
    },
    {
      trustedMarkerLogins: activityTrustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      // Advisory bots are excluded from disposition authorship inside the
      // summary builder, so the viewer-merged trusted-marker set is a safe
      // default here.
      dispositionAuthorLogins: activityTrustedMarkerLogins,
    },
  );

  // #1833 / #3482: exposed so a `--from-pr` watermark post
  // (post-idd-marker.mts) can warn, in its own success output, when the
  // fresh snapshot it is about to become the watermark still has
  // comments/threads lacking disposition evidence. The two counters mirror
  // `AdvisoryConvergenceDispositionEvidence`. This snapshot also forwards
  // `soleCauseAckOnlyPostDisposition`: `classifyThreadAckOnlyPostDisposition`
  // already classifies a courtesy ack when no snapshot boundary exists, so
  // that one flag is meaningful here. The other advisory-only sub-flags
  // stay omitted; this is not `pre-merge-readiness`'s full
  // `DispositionEvidenceSummary`.
  const embeddedFindings = buildCodeRabbitEmbeddedFindings(
    reviews,
    normalizedThreads,
  );

  const dispositionEvidence = summarizeDispositionEvidenceForGate(
    { comments: normalizedComments, threads: normalizedThreads },
    {
      iddAgentLogins: activityTrustedMarkerLogins,
      advisoryBotLogins,
      trustedMarkerLogins: activityTrustedMarkerLogins,
      prAuthorLogin,
    },
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        headSha,
        trustedMarkerActors: trustedMarkerLogins,
        trustedMarkerActorsSource,
        totalItemCount: summary.totalItemCount,
        maxActivityUpdatedAt: summary.maxActivityUpdatedAt,
        latestCiCompletedAt: summary.latestCiCompletedAt,
        latestPassingCiCompletedAt: summary.latestPassingCiCompletedAt,
        counts: summary.counts,
        ackOnly: summary.ackOnly,
        effective: summary.effective,
        dispositionEvidence: {
          missingRegularCommentCount:
            dispositionEvidence.missingRegularCommentCount,
          missingThreadCount: dispositionEvidence.missingThreadCount,
          soleCauseAckOnlyPostDisposition:
            dispositionEvidence.soleCauseAckOnlyPostDisposition,
        },
        embeddedFindings,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

/**
 * Restores this file's pre-#1450 permissive `Number.parseInt` contract:
 * `Number.parseInt` accepts trailing-garbage ("42abc" -> 42) and
 * leading-zero ("007" -> 7) tokens the same way the original hand-rolled
 * `Number.parseInt(value ?? '', 10)` always did, then the original's own
 * `!Number.isInteger(...) || (... ?? 0) < 1` post-check collapses an
 * invalid or absent value to `null`. `cli-args.mts`'s
 * `parseCanonicalIntegerOrNull` is a poor substitute: its canonical-pattern
 * regex rejects those same permissive tokens outright, which is a real
 * contract change a CodeRabbit review on PR #1466 caught -- #1450's
 * acceptance criteria protect the post-parse integer contract as-is, only
 * flag *syntax* (missing/flag-shaped values, unknown flags) is meant to
 * tighten.
 */
function parseLenientPositiveIntegerOrNull(
  token: string | undefined,
): number | null {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

export function parseArgs(argv: string[]): ReviewActivitySnapshotArgs {
  const { values, help } = parseCliArgs(
    argv,
    REVIEW_ACTIVITY_SNAPSHOT_FLAG_SPEC,
  );
  return {
    prNumber: parseLenientPositiveIntegerOrNull(
      values.pr as string | undefined,
    ),
    owner: values.owner as string,
    repo: values.repo as string,
    trustedMarkerLogins: values['trusted-marker-logins'] as string,
    advisoryBotLogins: values['advisory-bot-logins'] as string,
    help,
  };
}

/**
 * Issue #3337: merges the current-session viewer login into the
 * configured trusted-marker-actor set, mirroring
 * `pre-merge-readiness.mts`'s own `[viewerLogin, ...configuredTrustedActors]`
 * construction, so an agent with no separately configured trusted actor
 * still has its own live-status-digest edit (and other operational
 * markers) excluded from `buildActivitySnapshotSummary` and
 * `summarizeDispositionEvidenceForGate` alike -- the digest-exclusion fix
 * this issue makes to both producers otherwise stays inert for an
 * unconfigured agent. When the viewer login is unavailable, the returned
 * set is the configured trusted actors alone: the agent's own digest then
 * counts as activity, the pre-#3194 behavior, which can only send a PR
 * back to E1, never toward a merge.
 */
export function resolveActivitySnapshotTrustedMarkerLogins(
  trustedMarkerLogins: readonly unknown[],
  viewer: { viewerLogin: string; viewerLoginUnavailable: boolean },
): string[] {
  return normalizeTrustedMarkerLogins([
    viewer.viewerLoginUnavailable ? '' : viewer.viewerLogin,
    ...trustedMarkerLogins,
  ]);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/review-activity-snapshot.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>]
`);
}

/** One row per CodeRabbit COMMENTED review. Thread coverage is the number of
 * review threads whose first comment's `pullRequestReview.id` equals
 * the review's REST `node_id`. An empty `node_id` covers nothing, so
 * a null review id cannot match every thread that also has none. */
export function buildCodeRabbitEmbeddedFindings(
  reviews: readonly ReviewPayload[],
  threads: readonly {
    comments?: {
      nodes?: readonly {
        pullRequestReview?: { id?: string | null } | null;
      }[];
    };
  }[],
): CodeRabbitEmbeddedFindingReport[] {
  return reviews.flatMap((review) => {
    if (review.state !== 'COMMENTED') {
      return [];
    }
    const login = String(review.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!CODE_RABBIT_REVIEW_LOGINS.has(login)) {
      return [];
    }
    const reviewId = String(review.node_id ?? '');
    const body = review.body ?? '';
    const embeddedFindingCount = extractCodeRabbitEmbeddedFindings(body).length;
    const threadedCount =
      reviewId === ''
        ? 0
        : threads.filter((thread) => {
            const first = thread.comments?.nodes?.[0];
            return String(first?.pullRequestReview?.id ?? '') === reviewId;
          }).length;
    return [
      {
        reviewId,
        embeddedFindingCount,
        uncoveredCount: countUncoveredCodeRabbitEmbeddedFindings(
          body,
          threadedCount,
        ),
      },
    ];
  });
}

function normalizeComment(comment: ProviderComment) {
  return {
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt || comment.createdAt,
  };
}

function normalizeReview(review: ReviewPayload) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}

function normalizeThread(thread: ProviderReviewThreadWithComments) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: thread.comments.map((comment) => ({
        author: { login: comment.authorLogin },
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt || comment.createdAt,
        pullRequestReview: { id: comment.pullRequestReviewId ?? null },
      })),
    },
  };
}
