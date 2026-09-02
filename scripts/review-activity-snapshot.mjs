#!/usr/bin/env node
// idd-generated-from: src/scripts/review-activity-snapshot.mts
//
// The scripts/review-activity-snapshot.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { parseCliArgs } from './cli-args.mjs';
import { loadIddConfig } from './idd-config.mjs';
import {
  buildActivitySnapshotSummary,
  resolveAdvisoryBotLogins,
  resolveTrustedMarkerActors,
  summarizeDispositionEvidenceForGate,
} from './protocol-helpers.mjs';
import {
  createGithubProviderAdapter,
  resolveCurrentGithubRepository,
} from './provider-adapter-github.mjs';

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
};
if (import.meta.main) {
  main();
}
// The CLI body. Guarded behind `import.meta.main` so importing this
// module (for unit tests) does not parse process.argv, fail, or make a
// `gh` call.
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.prNumber) {
    throw new Error('missing required --pr <number> argument');
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
  const reviews = port.listReviews(args.prNumber);
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
      trustedMarkerLogins,
      advisoryBotLogins,
      advisoryBotLoginsSource,
      // Advisory bots are excluded from disposition authorship inside the
      // summary builder, so the trusted-marker set is a safe default here.
      dispositionAuthorLogins: trustedMarkerLogins,
    },
  );
  // #1833: exposed so a `--from-pr` watermark post (post-idd-marker.mts) can
  // warn, in its own success output, when the fresh snapshot it is about to
  // become the watermark still has comments/threads lacking disposition
  // evidence -- instead of that only surfacing later via the readiness
  // report's `reviewCurrency.comparisonRoute`. Trimmed to the two counters,
  // mirroring `AdvisoryConvergenceDispositionEvidence`
  // (advisory-convergence.mts) rather than re-exporting the full
  // `DispositionEvidenceSummary` shape (`pre-merge-readiness.mjs`'s own
  // richer `dispositionEvidence` field) -- no `snapshotBoundaryAt` is
  // available here (no watermark exists yet at snapshot time), so the
  // advisory-only ack sub-flags this function also returns would be
  // meaningless; only the two counters are stable to expose.
  const dispositionEvidence = summarizeDispositionEvidenceForGate(
    { comments: normalizedComments, threads: normalizedThreads },
    {
      iddAgentLogins: trustedMarkerLogins,
      advisoryBotLogins,
      trustedMarkerLogins,
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
        },
      },
      null,
      2,
    )}\n`,
  );
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
function parseLenientPositiveIntegerOrNull(token) {
  const value = Number.parseInt(token ?? '', 10);
  return Number.isInteger(value) && value >= 1 ? value : null;
}
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    REVIEW_ACTIVITY_SNAPSHOT_FLAG_SPEC,
  );
  return {
    prNumber: parseLenientPositiveIntegerOrNull(values.pr),
    owner: values.owner,
    repo: values.repo,
    trustedMarkerLogins: values['trusted-marker-logins'],
    advisoryBotLogins: values['advisory-bot-logins'],
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/review-activity-snapshot.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--trusted-marker-logins <login1,login2>] [--advisory-bot-logins <login1,login2>]
`);
}
function normalizeComment(comment) {
  return {
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt || comment.createdAt,
  };
}
function normalizeReview(review) {
  return {
    author: { login: review.user?.login ?? '' },
    state: review.state ?? '',
    submittedAt: review.submitted_at ?? '',
    createdAt: review.submitted_at ?? '',
    updatedAt: review.updated_at ?? review.submitted_at ?? '',
  };
}
function normalizeThread(thread) {
  return {
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
