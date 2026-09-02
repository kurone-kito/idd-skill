// Read-only, cross-pull-request provider-health classifier (#2319).
//
// IDD already observes advisory-review and Actions degradation, but only
// one pull request at a time, in three unconnected places (advisory
// non-review notices, the Actions billing-block CI shape, and
// advisory-wait-state.mts's own per-PR terminal state). Nothing
// aggregates those signals across pull requests, so a session cannot
// distinguish "this pull request is stuck" from "the service is down for
// everything". This module supplies the shared verdict other tracks may
// read; it changes no gate by itself -- it emits no marker, mutates no
// issue/PR/check, and exposes no field any merge-readiness output could
// consume as a pass.
//
// Split into two layers per the design decision: `classifyProviderHealth`
// is a pure function of an injected evidence snapshot (no network, no
// credentials, offline-testable); the `collect*Evidence` functions are a
// thin, separable read layer that turns live GitHub state into that
// snapshot shape.
//
// #2327 (PR #2346, `evaluateStaleRequestRecoveryAction` in
// advisory-wait-state.mts) already owns the "requested-but-never-
// registered" predicate's timing/budget logic. This module's
// `advisory-review` evidence collector reuses that same
// `advisoryWait.settledWindowMinutes` grace period rather than
// re-deriving a separate timing rule: a trusted `advisory-wait:`
// request marker with neither a subsequent `review_requested` timeline
// event nor a submitted review from the primary bot, anchored to the
// marker's own embedded requested-at timestamp, is 'failure' evidence
// only once that window has elapsed -- an unregistered request still
// inside it contributes no observation yet.

import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisoryWaitPolicy,
} from './advisory-wait-policy.mts';
import { parseCliArgs } from './cli-args.mts';
import { ghApiJson, ghText } from './gh-exec.mts';
import { loadIddConfig } from './idd-config.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  isCopilotReviewerLogin,
  resolveTrustedMarkerActors,
} from './protocol-helpers.mts';

export const PROVIDER_HEALTH_SERVICES = [
  'advisory-review',
  'ci-actions',
] as const;
export type ProviderHealthService = (typeof PROVIDER_HEALTH_SERVICES)[number];

export const PROVIDER_HEALTH_VERDICTS = [
  'healthy',
  'degraded',
  'unavailable',
  'unknown',
] as const;
export type ProviderHealthVerdict = (typeof PROVIDER_HEALTH_VERDICTS)[number];

/** One per-pull-request evidence data point feeding a service's snapshot. */
export interface ProviderHealthObservation {
  /** The distinct pull-request identity this evidence is scoped to. */
  prNumber: number;
  /**
   * 'failure': provider-level failure evidence for this PR (never an
   * ordinary code-caused failure -- the read layer only emits 'failure'
   * for the documented service-level signatures: a trusted advisory-wait
   * request marker with neither a subsequent `review_requested` timeline
   * event nor a submitted review from the primary bot, once the
   * settling-window grace period has elapsed; or a workflow run whose
   * every job fails near-instantly with no steps executed).
   * 'success': the provider worked normally for this PR within the
   * sampled window.
   */
  outcome: 'failure' | 'success';
}

/** Already-collected evidence for one service, ready for classification. */
export interface ProviderHealthSnapshot {
  service: ProviderHealthService;
  /** ISO-8601 capture instant. */
  now: string;
  /**
   * True only when evidence collection itself could not resolve a
   * coherent signal for a specific observation (e.g. a raw signal that
   * reads as neither clearly success nor clearly failure). Distinct from
   * an empty `observations` array, which means "no evidence yet" and
   * resolves to `unknown` via the no-evidence path, not this one.
   */
  contradictory: boolean;
  /** True when evidence could not be fetched or parsed at all. */
  unreadable: boolean;
  observations: ProviderHealthObservation[];
}

export interface ProviderHealthServiceVerdict {
  service: ProviderHealthService;
  verdict: ProviderHealthVerdict;
  reason: string;
  distinctFailingPrCount: number;
  distinctSuccessPrCount: number;
  minCorroboratingPrs: number;
}

export interface ProviderHealthReport {
  protocolVersion: '1';
  now: string;
  services: Record<ProviderHealthService, ProviderHealthServiceVerdict>;
}

const PROVIDER_HEALTH_REASONS = {
  evidenceUnreadable: 'evidence-unreadable',
  contradictoryEvidence: 'contradictory-evidence',
  noEvidence: 'no-evidence',
  allHealthy: 'all-healthy',
  belowCorroborationThreshold: 'failure-below-corroboration-threshold',
  mixedWithCorroboration: 'mixed-evidence-with-corroboration',
  fullFailureWithCorroboration: 'full-failure-with-corroboration',
} as const;

/**
 * Pure classification: `unknown` is the floor for every insufficient,
 * contradictory, or unreadable evidence path -- never `unavailable`.
 * Corroboration is counted over DISTINCT pull-request identities, not
 * observation count, so a single pull request's failure burst always
 * caps at `degraded` regardless of how many failure observations it
 * contributes. Contradiction is an explicit read-layer signal, never
 * derived by majority-voting successes against failures -- a genuine mix
 * of both across distinct PRs is the ordinary `degraded` case, not
 * `unknown`.
 */
export function classifyProviderHealth(
  snapshot: ProviderHealthSnapshot,
  policy: { minCorroboratingPrs: number },
): ProviderHealthServiceVerdict {
  const minCorroboratingPrs = policy.minCorroboratingPrs;
  const base = {
    service: snapshot.service,
    minCorroboratingPrs,
  };

  if (snapshot.unreadable) {
    return {
      ...base,
      verdict: 'unknown',
      reason: PROVIDER_HEALTH_REASONS.evidenceUnreadable,
      distinctFailingPrCount: 0,
      distinctSuccessPrCount: 0,
    };
  }

  if (snapshot.contradictory) {
    return {
      ...base,
      verdict: 'unknown',
      reason: PROVIDER_HEALTH_REASONS.contradictoryEvidence,
      distinctFailingPrCount: 0,
      distinctSuccessPrCount: 0,
    };
  }

  const failingPrs = new Set<number>();
  const successPrs = new Set<number>();
  for (const observation of snapshot.observations) {
    if (observation.outcome === 'failure') {
      failingPrs.add(observation.prNumber);
    } else {
      successPrs.add(observation.prNumber);
    }
  }
  const distinctFailingPrCount = failingPrs.size;
  const distinctSuccessPrCount = successPrs.size;

  if (distinctFailingPrCount === 0 && distinctSuccessPrCount === 0) {
    return {
      ...base,
      verdict: 'unknown',
      reason: PROVIDER_HEALTH_REASONS.noEvidence,
      distinctFailingPrCount,
      distinctSuccessPrCount,
    };
  }

  if (distinctFailingPrCount === 0) {
    return {
      ...base,
      verdict: 'healthy',
      reason: PROVIDER_HEALTH_REASONS.allHealthy,
      distinctFailingPrCount,
      distinctSuccessPrCount,
    };
  }

  if (distinctFailingPrCount < minCorroboratingPrs) {
    return {
      ...base,
      verdict: 'degraded',
      reason: PROVIDER_HEALTH_REASONS.belowCorroborationThreshold,
      distinctFailingPrCount,
      distinctSuccessPrCount,
    };
  }

  if (distinctSuccessPrCount > 0) {
    return {
      ...base,
      verdict: 'degraded',
      reason: PROVIDER_HEALTH_REASONS.mixedWithCorroboration,
      distinctFailingPrCount,
      distinctSuccessPrCount,
    };
  }

  return {
    ...base,
    verdict: 'unavailable',
    reason: PROVIDER_HEALTH_REASONS.fullFailureWithCorroboration,
    distinctFailingPrCount,
    distinctSuccessPrCount,
  };
}

// ---------------------------------------------------------------------
// Read layer (network). Kept separable from the pure classifier above:
// every function below performs `gh` calls and is exercised by wiring
// tests only, not the fixture-driven classifier test suite.
// ---------------------------------------------------------------------

interface GhTimelineReviewRequestedEvent {
  event?: string;
  created_at?: string;
  requested_reviewer?: { login?: string | null } | null;
}

interface GhCommentPayload {
  body?: string;
  created_at?: string;
  user?: { login?: string | null } | null;
}

interface GhReviewPayload {
  user?: { login?: string | null } | null;
  submitted_at?: string;
}

interface GhPullRequestListItem {
  number?: number;
  updated_at?: string;
}

interface GhWorkflowJob {
  conclusion?: string | null;
  steps?: unknown[] | null;
}

interface GhWorkflowRun {
  id?: number;
  conclusion?: string | null;
  updated_at?: string;
  pull_requests?: { number?: number }[] | null;
}

// Matches both canonical `advisory-wait:` request-marker forms a trusted
// actor may post (marker-helpers.mts OPERATIONAL_MARKER_ENTRIES): the
// plain-text `advisory-wait: {agentId} {headSha} {timestamp}` line and the
// `<!-- advisory-wait: {agentId} {headSha} {timestamp} -->` HTML-comment
// form. Anchored to the whole trimmed comment body -- both forms are always
// posted as their own dedicated comment, never embedded in a larger one.
const ISO_TIMESTAMP_SOURCE =
  '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z';
const ADVISORY_WAIT_REQUEST_MARKER_RE = new RegExp(
  `^advisory-wait:\\s+\\S+\\s+[0-9a-f]{40}\\s+(${ISO_TIMESTAMP_SOURCE})\\s*$`,
);
const ADVISORY_WAIT_REQUEST_MARKER_HTML_RE = new RegExp(
  `^<!--\\s*advisory-wait:\\s*\\S+\\s+[0-9a-f]{40}\\s+(${ISO_TIMESTAMP_SOURCE})\\s*-->\\s*$`,
);

/**
 * Extracts a marker body's own embedded `{ISO8601-requested-at}` field --
 * distinct from the comment's `created_at`. `idd-review-fix.instructions.md`
 * documents the REQUEST_NEEDED flow as requesting the bot's review FIRST,
 * then posting this marker, so the comment is always posted at or after the
 * embedded timestamp; using `created_at` as the registration-timing anchor
 * would make the review_requested timeline event (recorded at request time)
 * look like it arrived BEFORE the request, misclassifying the ordinary
 * healthy case as failure.
 */
function parseAdvisoryWaitRequestMarker(body: string): string | null {
  const trimmed = body.trim();
  const match =
    ADVISORY_WAIT_REQUEST_MARKER_RE.exec(trimmed) ??
    ADVISORY_WAIT_REQUEST_MARKER_HTML_RE.exec(trimmed);
  return match ? match[1] : null;
}

/**
 * Compares two ISO-8601 timestamps by parsed instant (epoch ms), not
 * lexical string order. GitHub API timestamps are typically
 * second-precision while this module's own `resolveCutoffIso()` output
 * always carries fractional seconds (`toISOString()`); lexical comparison
 * of those two shapes can disagree with true chronological order (e.g.
 * `"...:00Z"` sorts lexically AFTER `"...:00.500Z"` despite being
 * chronologically earlier). An unparsable side parses to `NaN`, and every
 * comparison against `NaN` is `false` -- fails safe to "no ordering
 * established" rather than throwing or misordering.
 */
function compareIsoTimestamps(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b);
}

/** A trusted `advisory-wait:` request marker's two distinct timestamps. */
interface TrustedAdvisoryWaitRequest {
  /** The marker COMMENT's own `created_at` -- when it was posted. Used for
   * latest-marker selection and the sampling-window cutoff, both of which
   * are legitimately about when the marker itself appeared. */
  postedAt: string;
  /** The marker's embedded `{ISO8601-requested-at}` field -- when the
   * review was actually requested (before the marker was posted, per the
   * documented flow). Used for the registration-timing comparison. */
  requestedAt: string;
}

/**
 * The LATEST trusted `advisory-wait:` request marker among `comments` (by
 * `postedAt`) -- "did the most recent request register" is the observable,
 * not "did the first request ever posted on this PR register". A marker
 * counts only when its author is a `trustedMarkerLogins` member
 * (case-insensitive); an untrusted actor could otherwise post a fabricated
 * marker to poison this service's verdict.
 */
function latestTrustedAdvisoryWaitRequest(
  comments: GhCommentPayload[],
  trustedMarkerLogins: ReadonlySet<string>,
): TrustedAdvisoryWaitRequest | null {
  let latest: TrustedAdvisoryWaitRequest | null = null;
  for (const comment of comments) {
    const authorLogin = String(comment?.user?.login ?? '')
      .trim()
      .toLowerCase();
    if (!trustedMarkerLogins.has(authorLogin)) continue;
    const requestedAt = parseAdvisoryWaitRequestMarker(
      String(comment?.body ?? ''),
    );
    if (requestedAt === null) continue;
    const postedAt = String(comment?.created_at ?? '');
    // An unparsable postedAt must never become `latest` -- otherwise every
    // later comparison is `NaN > 0` (always false) and the bogus marker
    // "sticks" forever, blocking every genuinely later valid marker.
    if (postedAt === '' || Number.isNaN(Date.parse(postedAt))) continue;
    if (
      latest === null ||
      compareIsoTimestamps(postedAt, latest.postedAt) > 0
    ) {
      latest = { postedAt, requestedAt };
    }
  }
  return latest;
}

/**
 * Pure decision for one pull request's `advisory-review` evidence, given
 * already-fetched comments/timeline/reviews. Kept separate from the network
 * layer below so the trust filter, sampling-window cutoff, latest-marker
 * selection, and both registration paths (timeline event or submitted
 * review) are fixture-testable without a live `gh` call.
 */
export function deriveAdvisoryReviewObservation(
  prNumber: number,
  comments: GhCommentPayload[],
  timeline: GhTimelineReviewRequestedEvent[],
  reviews: GhReviewPayload[],
  options: {
    trustedMarkerLogins: ReadonlySet<string>;
    primaryBotLogin: string;
    cutoffIso: string | null;
    now: string;
    settledWindowMs: number;
  },
): ProviderHealthObservation | null {
  const request = latestTrustedAdvisoryWaitRequest(
    comments,
    options.trustedMarkerLogins,
  );
  if (request === null) return null;
  if (options.cutoffIso !== null) {
    const cmp = compareIsoTimestamps(request.postedAt, options.cutoffIso);
    // An unparsable postedAt compares as NaN, which fails every ordering
    // check including `< 0` -- without this explicit NaN check that would
    // silently bypass the cutoff instead of failing closed (skip).
    if (Number.isNaN(cmp) || cmp < 0) return null;
  }

  const registeredByTimeline = timeline.some((event) => {
    if (String(event?.event ?? '') !== 'review_requested') return false;
    const reviewerLogin = String(event?.requested_reviewer?.login ?? '');
    if (!isCopilotReviewerLogin(reviewerLogin, options.primaryBotLogin)) {
      return false;
    }
    const eventAt = String(event?.created_at ?? '');
    return (
      eventAt !== '' && compareIsoTimestamps(eventAt, request.requestedAt) >= 0
    );
  });
  const registeredByReview = reviews.some((review) => {
    const reviewerLogin = String(review?.user?.login ?? '');
    if (!isCopilotReviewerLogin(reviewerLogin, options.primaryBotLogin)) {
      return false;
    }
    const submittedAt = String(review?.submitted_at ?? '');
    return (
      submittedAt !== '' &&
      compareIsoTimestamps(submittedAt, request.requestedAt) >= 0
    );
  });

  if (registeredByTimeline || registeredByReview) {
    return { prNumber, outcome: 'success' };
  }

  // Not yet registered -- but a request posted moments ago hasn't had time
  // for ordinary GitHub propagation lag to resolve. #2327's own
  // `advisoryWait.settledWindowMinutes` already draws exactly this
  // ordinary-lag-vs-genuine-failure line for a single pull request; reuse
  // it here rather than treating every fresh marker as immediate failure
  // evidence. Anchored to requestedAt (the request action), matching what
  // "elapsed since the request" means for the registration check above.
  const elapsedMs = Date.parse(options.now) - Date.parse(request.requestedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < options.settledWindowMs) {
    return null;
  }

  return { prNumber, outcome: 'failure' };
}

export function resolveCutoffIso(
  nowIso: string,
  windowMs: number | null,
): string | null {
  if (windowMs === null) return null;
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return null;
  const cutoff = new Date(nowMs - windowMs);
  // An absurdly large but schema-valid samplingWindow (e.g. a duration with
  // an excessive digit count) can push this outside the representable Date
  // range; `toISOString()` throws on that rather than producing a value,
  // which would otherwise crash the whole CLI. Treat it as no cutoff
  // instead of a fatal error.
  return Number.isNaN(cutoff.getTime()) ? null : cutoff.toISOString();
}

/**
 * Collect `advisory-review` evidence across recent pull requests. For each
 * of the most-recently-updated open or closed PRs (bounded by `sampleSize`),
 * a trusted `advisory-wait:` request marker with no subsequent
 * `review_requested` timeline event for the primary bot, and no submitted
 * review from the primary bot, is 'failure' evidence (#2327's own
 * observable, extended with the submitted-review path); either path
 * registering is 'success' evidence. A PR with no request marker at all
 * within the sampling window contributes no observation (out of scope for
 * this window, not evidence either way).
 */
export function collectAdvisoryReviewEvidence(
  owner: string,
  repo: string,
  options: {
    primaryBotLogin?: string;
    sampleSize?: number;
    now?: string;
    trustedMarkerLogins?: readonly string[];
    samplingWindowMs?: number | null;
    settledWindowMs?: number;
  } = {},
): ProviderHealthSnapshot {
  const now = options.now ?? new Date().toISOString();
  const primaryBotLogin =
    options.primaryBotLogin ?? DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const sampleSize = options.sampleSize ?? 20;
  const trustedMarkerLogins = new Set(
    (options.trustedMarkerLogins ?? []).map((login) =>
      login.trim().toLowerCase(),
    ),
  );
  const cutoffIso = resolveCutoffIso(now, options.samplingWindowMs ?? null);
  const settledWindowMs =
    options.settledWindowMs ?? DEFAULT_ADVISORY_SETTLED_WINDOW_MINUTES * 60_000;
  const observations: ProviderHealthObservation[] = [];

  let payload: unknown;
  try {
    payload = ghApiJson(
      `repos/${owner}/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${sampleSize}`,
    );
  } catch {
    return {
      service: 'advisory-review',
      now,
      contradictory: false,
      unreadable: true,
      observations,
    };
  }
  // A malformed or empty `gh` response can resolve to `{}` rather than an
  // array; iterating that unguarded would throw outside this try block and
  // crash the whole CLI instead of degrading to `unreadable: true`.
  if (!Array.isArray(payload)) {
    return {
      service: 'advisory-review',
      now,
      contradictory: false,
      unreadable: true,
      observations,
    };
  }
  const pulls = payload as GhPullRequestListItem[];

  for (const pull of pulls) {
    const prNumber = pull.number;
    if (typeof prNumber !== 'number') continue;

    let comments: GhCommentPayload[];
    let timeline: GhTimelineReviewRequestedEvent[];
    let reviews: GhReviewPayload[];
    try {
      comments = ghApiJson(
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { paginate: true },
      ) as GhCommentPayload[];
      timeline = ghApiJson(
        `repos/${owner}/${repo}/issues/${prNumber}/timeline`,
        {
          paginate: true,
          extraArgs: ['-H', 'Accept: application/vnd.github+json'],
        },
      ) as GhTimelineReviewRequestedEvent[];
      reviews = ghApiJson(`repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        paginate: true,
      }) as GhReviewPayload[];
    } catch {
      // A single PR's read failure is not the whole snapshot's failure --
      // the fetchable PRs still yield real evidence. Skip this PR only.
      continue;
    }

    const observation = deriveAdvisoryReviewObservation(
      prNumber,
      comments,
      timeline,
      reviews,
      { trustedMarkerLogins, primaryBotLogin, cutoffIso, now, settledWindowMs },
    );
    if (observation !== null) observations.push(observation);
  }

  return {
    service: 'advisory-review',
    now,
    contradictory: false,
    unreadable: false,
    observations,
  };
}

/**
 * True when `updatedAt` falls outside a configured sampling window --
 * including when it is missing or unparsable, which must fail closed
 * (excluded) rather than silently bypassing the cutoff and reading as
 * always-in-window.
 */
function isOutsideSamplingWindow(
  updatedAt: unknown,
  cutoffIso: string | null,
): boolean {
  if (cutoffIso === null) return false;
  if (typeof updatedAt !== 'string') return true;
  const cmp = compareIsoTimestamps(updatedAt, cutoffIso);
  return Number.isNaN(cmp) || cmp < 0;
}

/**
 * Pure decision for one workflow run's `ci-actions` evidence. `jobs` is
 * `null` when the caller never fetched the jobs endpoint (only failing runs
 * need it); kept separate from the network layer for the same fixture-
 * testability reason as `deriveAdvisoryReviewObservation` above.
 */
export function deriveCiActionsObservation(
  run: GhWorkflowRun,
  jobs: GhWorkflowJob[] | null,
  options: { cutoffIso: string | null },
): ProviderHealthObservation | null {
  const prNumber = run.pull_requests?.[0]?.number;
  if (typeof prNumber !== 'number') return null;
  if (isOutsideSamplingWindow(run.updated_at, options.cutoffIso)) {
    return null;
  }

  if (run.conclusion === 'success') {
    return { prNumber, outcome: 'success' };
  }
  if (run.conclusion !== 'failure') return null;
  if (jobs === null || jobs.length === 0) return null;
  const everyJobRanNoSteps = jobs.every(
    (job) => Array.isArray(job.steps) && job.steps.length === 0,
  );
  return everyJobRanNoSteps ? { prNumber, outcome: 'failure' } : null;
}

/**
 * Collect `ci-actions` evidence from recently completed workflow runs. A
 * failing run whose jobs all executed zero steps matches the documented
 * account-level Actions billing/spend-limit block shape (the run starts
 * but no steps run, unlike an ordinary step failure) and is 'failure'
 * evidence; any other failing run is an ordinary code-caused failure and
 * contributes no observation. A successful run is 'success' evidence.
 * Runs unassociated with any pull request are skipped -- corroboration is
 * defined over distinct pull requests. The jobs read is bounded to a single
 * `per_page=100` page rather than fully paginated: this repository's own
 * workflow runs stay far under that per-run job count, and the billing-block
 * signature (every job zero-steps) is unaffected by jobs on a page this
 * helper never fetches.
 */
export function collectCiActionsEvidence(
  owner: string,
  repo: string,
  options: {
    sampleSize?: number;
    now?: string;
    samplingWindowMs?: number | null;
  } = {},
): ProviderHealthSnapshot {
  const now = options.now ?? new Date().toISOString();
  const sampleSize = options.sampleSize ?? 50;
  const cutoffIso = resolveCutoffIso(now, options.samplingWindowMs ?? null);
  const observations: ProviderHealthObservation[] = [];

  let runs: GhWorkflowRun[];
  try {
    const payload = ghApiJson(
      `repos/${owner}/${repo}/actions/runs?status=completed&per_page=${sampleSize}`,
    ) as { workflow_runs?: unknown };
    // A malformed response (e.g. `{}`) must not silently read as "zero
    // runs" -- that would resolve to unknown/no-evidence instead of
    // unknown/evidence-unreadable, the same crash-vs-degrade distinction
    // already guarded on the advisory-review pulls-list read above.
    if (!Array.isArray(payload.workflow_runs)) {
      return {
        service: 'ci-actions',
        now,
        contradictory: false,
        unreadable: true,
        observations,
      };
    }
    runs = payload.workflow_runs as GhWorkflowRun[];
  } catch {
    return {
      service: 'ci-actions',
      now,
      contradictory: false,
      unreadable: true,
      observations,
    };
  }

  for (const run of runs) {
    if (typeof run.id !== 'number') continue;
    // A run with no associated pull request contributes no observation
    // either way (corroboration is PR-scoped) -- skip the jobs fetch
    // entirely rather than spending an avoidable API call on it, which
    // only adds rate-limit/timeout risk during an actual degradation.
    if (typeof run.pull_requests?.[0]?.number !== 'number') continue;
    // Likewise, a run outside the sampling window contributes no
    // observation either way (deriveCiActionsObservation applies this
    // same cutoff) -- check it before the jobs fetch, not after, so a
    // quiet-repository report with mostly-expired runs doesn't spend a
    // jobs-endpoint call per run just to discard the result.
    if (isOutsideSamplingWindow(run.updated_at, cutoffIso)) {
      continue;
    }

    let jobs: GhWorkflowJob[] | null = null;
    if (run.conclusion === 'failure') {
      try {
        const payload = ghApiJson(
          `repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        ) as { jobs?: unknown };
        // A malformed jobs payload must skip this run, not silently read
        // as "zero jobs" -- same crash-vs-degrade distinction as the
        // workflow_runs-list guard above, applied per-run.
        if (!Array.isArray(payload.jobs)) continue;
        jobs = payload.jobs as GhWorkflowJob[];
      } catch {
        continue;
      }
    }

    const observation = deriveCiActionsObservation(run, jobs, { cutoffIso });
    if (observation !== null) observations.push(observation);
  }

  return {
    service: 'ci-actions',
    now,
    contradictory: false,
    unreadable: false,
    observations,
  };
}

export function buildProviderHealthReport(
  owner: string,
  repo: string,
  options: { config?: unknown; now?: string } = {},
): ProviderHealthReport {
  const config = options.config ?? loadIddConfig();
  const policy = normalizePolicyConfig(config).providerHealth;
  const primaryBotLogin = resolveAdvisoryPrimaryBotLogin(config ?? {});
  const now = options.now ?? new Date().toISOString();
  const { actors: trustedMarkerLogins } = resolveTrustedMarkerActors({
    envValue: process.env.IDD_TRUSTED_MARKER_ACTORS,
    config: config as { trustedMarkerActors?: unknown } | null,
  });
  const samplingWindowMs = parseIsoDurationToMs(policy.samplingWindow);
  const settledWindowMs =
    resolveAdvisoryWaitPolicy(config).settledWindowMinutes * 60_000;

  const advisoryReviewSnapshot = collectAdvisoryReviewEvidence(owner, repo, {
    primaryBotLogin,
    now,
    trustedMarkerLogins,
    samplingWindowMs,
    settledWindowMs,
  });
  const ciActionsSnapshot = collectCiActionsEvidence(owner, repo, {
    now,
    samplingWindowMs,
  });

  return {
    protocolVersion: '1',
    now,
    services: {
      'advisory-review': classifyProviderHealth(advisoryReviewSnapshot, policy),
      'ci-actions': classifyProviderHealth(ciActionsSnapshot, policy),
    },
  };
}

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `owner:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --owner spec key
// below. See cli-args.mts's module header for the full invariant.
const PROVIDER_HEALTH_FLAG_SPEC = {
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  main();
}

function main(): void {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    PROVIDER_HEALTH_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }

  const owner =
    (values.owner as string) ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    (values.repo as string) ||
    ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);

  const report = buildProviderHealthReport(owner, repo);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/provider-health.mjs [--owner <owner>] [--repo <repo>]

Read-only, cross-pull-request health classifier for two services:
advisory-review and ci-actions. Aggregates already-observable per-PR
evidence -- for advisory-review, a trusted advisory-wait: request marker
(config trustedMarkerActors / IDD_TRUSTED_MARKER_ACTORS) with neither a
subsequent review_requested timeline event nor a submitted review from
the primary bot; for ci-actions, a workflow run whose every job executes
zero steps -- into a healthy/degraded/unavailable/unknown verdict per
service. Evidence outside providerHealth.samplingWindow (default PT24H)
is excluded. Never a gate: emits no marker, mutates nothing, and exposes
no field any merge-readiness or CI-gate output could consume as a pass.

--owner/--repo default to the current repository (gh repo view).
`);
}
