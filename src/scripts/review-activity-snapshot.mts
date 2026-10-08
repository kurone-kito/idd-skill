#!/usr/bin/env node
// idd-generated-from: src/scripts/review-activity-snapshot.mts
//
// The scripts/review-activity-snapshot.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseCliArgs } from './cli-args.mts';
import {
  parseOverviewSections,
  type Severity,
  type SeverityCounts,
} from './copilot-overview-sections.mts';
import {
  classifyCopilotReviewBody,
  extractCopilotReviewBodyRemark,
} from './copilot-review-body.mts';
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
  isCopilotReviewerLogin,
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
  ProviderPort,
  ProviderReviewThreadWithComments,
} from './provider-port.mts';
import { enrichThreadsWithBotEditHistories } from './review-thread-edit-histories.mts';

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
  /** The commit the review was submitted against (#3672). */
  commit_id?: string | null;
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

/** One Copilot `COMMENTED` review whose body carries a "Needs a closer
 * look" remark (#3672). Evidence only: never a snapshot item or gate input. */
export interface CopilotReviewBodyRemarkReport {
  reviewId: string;
  author: string;
  commitId: string;
  remark: string;
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

/** Methods one rich activity collection uses. No persisted snapshot input. */
export type ReviewActivityCollectors = Pick<
  ProviderPort,
  | 'resolveViewerLoginSafe'
  | 'getChangeRequestHeadShaAndAuthor'
  | 'listChangeRequestChecks'
  | 'listReviews'
  | 'listWorkItemComments'
  | 'listChangeRequestReviewThreadsWithComments'
  | 'getReviewThreadCommentUserContentEdits'
>;

/**
 * Collect one PR's review activity and derive the snapshot JSON.
 * Callers that also need watermark fields must reuse this object in the
 * same operation. A later operation calls this again; nothing here is cached.
 */
export function collectReviewActivitySnapshot(input: {
  prNumber: number;
  owner: string;
  repo: string;
  trustedMarkerLoginsFlag: string;
  advisoryBotLoginsFlag: string;
  envTrustedMarkerActors?: string | undefined;
  envAdvisoryBotLogins?: string | undefined;
  iddConfig?: ReturnType<typeof loadIddConfig>;
  port: ReviewActivityCollectors;
}): Record<string, unknown> {
  const iddConfig = input.iddConfig ?? loadIddConfig();
  const { actors: trustedMarkerLogins, source: trustedMarkerActorsSource } =
    resolveTrustedMarkerActors({
      flagValue: input.trustedMarkerLoginsFlag,
      envValue: input.envTrustedMarkerActors,
      config: iddConfig,
    });
  const { logins: advisoryBotLogins, source: advisoryBotLoginsSource } =
    resolveAdvisoryBotLogins({
      flagValue: input.advisoryBotLoginsFlag,
      envValue: input.envAdvisoryBotLogins,
      config: iddConfig,
    });
  const activityTrustedMarkerLogins =
    resolveActivitySnapshotTrustedMarkerLogins(
      trustedMarkerLogins,
      input.port.resolveViewerLoginSafe(),
    );
  const { headSha: rawHeadSha, authorLogin: rawAuthorLogin } =
    input.port.getChangeRequestHeadShaAndAuthor(input.prNumber);
  const headSha = rawHeadSha;
  const prAuthorLogin = rawAuthorLogin.trim().toLowerCase();
  const checks = input.port.listChangeRequestChecks(input.prNumber);
  const reviews = input.port.listReviews(input.prNumber) as ReviewPayload[];
  const comments = input.port.listWorkItemComments(input.prNumber, {
    includeEditState: true,
  });
  const threads = input.port.listChangeRequestReviewThreadsWithComments(
    input.prNumber,
  );
  const normalizedComments = comments.map(normalizeComment);
  // #3655: the same bounded second pass the merge gate runs (#3269), so a
  // cosmetic in-place edit of an advisory-bot thread comment is dated by
  // content activity here too and both collectors report the same
  // `dispositionEvidence`. The disposition-author logins are the trusted set
  // this collector hands the summarizers below.
  const normalizedThreads = enrichThreadsWithBotEditHistories(
    input.port,
    threads.map(normalizeThread),
    {
      dispositionAuthorLogins: activityTrustedMarkerLogins,
      advisoryBotLogins,
    },
  );
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
      dispositionAuthorLogins: activityTrustedMarkerLogins,
    },
  );
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
      prHeadSha: headSha,
      prAuthorLogin,
    },
  );
  return {
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
    reviewBodyRemarks: buildCopilotReviewBodyRemarks(reviews),
    copilotOverviewLabels: buildCopilotOverviewLabels(reviews),
  };
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
  const snapshot = collectReviewActivitySnapshot({
    prNumber: args.prNumber,
    owner,
    repo,
    trustedMarkerLoginsFlag: args.trustedMarkerLogins,
    advisoryBotLoginsFlag: args.advisoryBotLogins,
    envTrustedMarkerActors: process.env.IDD_TRUSTED_MARKER_ACTORS,
    envAdvisoryBotLogins: process.env.IDD_ADVISORY_BOT_LOGINS,
    port: createGithubProviderAdapter(owner, repo),
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
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

/** Exported for direct unit testing (#3249), mirroring
 * `pre-merge-readiness.mts`'s own `normalizeComment`. */
export function normalizeComment(comment: ProviderComment) {
  return {
    id: String(comment.id),
    author: { login: comment.authorLogin },
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt || comment.createdAt,
    // #3249: carried through so `summarizeDispositionEvidenceForGate` can
    // require `unedited` -- `undefined` unless `includeEditState` was
    // requested.
    lastEditedAt: comment.lastEditedAt,
  };
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

/**
 * One row per Copilot `COMMENTED` review whose body yields a remark
 * (#3672): a one-sentence "Needs a closer look" remark can sit beside
 * `**Findings:** None` with no inline thread, and no counter reads it
 * (`classifyCopilotReviewBody` keeps its suppressed count to the counted
 * blocks). Evidence only -- the result never feeds
 * `buildActivitySnapshotSummary` or any counter, so `effective`, the counts,
 * `embeddedFindings` and the exit status are the same with or without it.
 * `APPROVED` and `CHANGES_REQUESTED` reviews and other authors are omitted.
 *
 * Uses the default-primary-bot `isCopilotReviewerLogin`, not the configured
 * `primaryBotLogin` (unlike `pre-merge-readiness`): only Copilot emits this
 * body shape, so threading a configured non-Copilot primary bot would narrow
 * away the one author whose bodies the extractor parses. One row per
 * review, so earlier reviews' rows are historical -- a consumer compares
 * `commitId` with `headSha`.
 */
export function buildCopilotReviewBodyRemarks(
  reviews: readonly ReviewPayload[],
): CopilotReviewBodyRemarkReport[] {
  return reviews.flatMap((review) => {
    if (review.state !== 'COMMENTED') {
      return [];
    }
    const author = String(review.user?.login ?? '').trim();
    if (!isCopilotReviewerLogin(author)) {
      return [];
    }
    const remark = extractCopilotReviewBodyRemark(review.body);
    if (remark === null) {
      return [];
    }
    return [
      {
        reviewId: String(review.node_id ?? ''),
        author,
        commitId: String(review.commit_id ?? ''),
        remark,
      },
    ];
  });
}

/** One Open item of the latest Copilot overview: its severity label and the
 * `#discussion_r<id>` it links (#3868). The label is only what the body
 * carries; the helper never supplies a severity the body does not. */
export interface CopilotOverviewLabelItem {
  discussionId: number;
  severity: Severity;
  isNew: boolean;
}

/** The latest non-error Copilot `COMMENTED` review's overview labels
 * (#3868). `kind`: `v2` (overview-v2 and its sections are consistent),
 * `unparsed` (overview-v2 but not consistent; `items` is the partial list,
 * for diagnosis only, and `reason` says why), `legacy` (overview-legacy), or
 * `other` (any remaining shape). Evidence only, like `reviewBodyRemarks`:
 * no counter or `effective` value reads it. The row is historical; a
 * consumer compares `commitId` with `headSha`. */
export interface CopilotOverviewLabelRow {
  reviewId: string;
  commitId: string;
  kind: 'v2' | 'unparsed' | 'legacy' | 'other';
  items: CopilotOverviewLabelItem[];
  previouslyMissed: SeverityCounts | null;
  reason: string | null;
}

/**
 * Select the last `COMMENTED` Copilot review in `listReviews` order whose
 * body is not an error body (the same skip `review-clause.mts` applies, so an
 * error-bodied last review does not hide the earlier labels), and report its
 * overview labels. `null` when no such review exists. Earlier reviews' Open
 * sections are not returned, which bounds the output at one row.
 */
export function buildCopilotOverviewLabels(
  reviews: readonly ReviewPayload[],
): CopilotOverviewLabelRow | null {
  let latest: ReviewPayload | null = null;
  for (const review of reviews) {
    if (review.state !== 'COMMENTED') {
      continue;
    }
    const author = String(review.user?.login ?? '').trim();
    if (!isCopilotReviewerLogin(author)) {
      continue;
    }
    if (classifyCopilotReviewBody(review.body).shape === 'error') {
      continue;
    }
    latest = review;
  }
  if (latest === null) {
    return null;
  }

  const body = String(latest.body ?? '');
  const base = {
    reviewId: String(latest.node_id ?? ''),
    commitId: String(latest.commit_id ?? ''),
  };
  const shape = classifyCopilotReviewBody(body).shape;
  if (shape === 'overview-v2') {
    const sections = parseOverviewSections(body);
    const consistent = sections.unparsedReasons.length === 0;
    return {
      ...base,
      kind: consistent ? 'v2' : 'unparsed',
      items: sections.open.map((item) => ({
        discussionId: item.id,
        severity: item.severity,
        isNew: item.isNew,
      })),
      previouslyMissed: sections.previouslyMissed,
      reason: consistent ? null : sections.unparsedReasons.join('; '),
    };
  }
  return {
    ...base,
    kind: shape === 'overview-legacy' ? 'legacy' : 'other',
    items: [],
    previouslyMissed: null,
    reason: null,
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

/** Exported for direct unit testing (#3249), mirroring
 * `pre-merge-readiness.mts`'s own `normalizeThread`. */
export function normalizeThread(thread: ProviderReviewThreadWithComments) {
  return {
    id: thread.id,
    isResolved: Boolean(thread.isResolved),
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: thread.comments.map((comment) => ({
        // #3655: the bounded edit-history pass names candidates by id.
        id: comment.id,
        author: { login: comment.authorLogin },
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt || comment.createdAt,
        pullRequestReview: { id: comment.pullRequestReviewId ?? null },
        // #3249: carried through so `hasFreshDisposition` can require
        // `unedited` -- `listChangeRequestReviewThreadsWithComments`
        // always populates this field.
        lastEditedAt: comment.lastEditedAt,
      })),
    },
  };
}
