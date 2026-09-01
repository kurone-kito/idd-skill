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
// `advisory-review` evidence collector cites that same observable
// (absence of a `review_requested` timeline event after a request that
// returned success) rather than re-deriving a separate timing rule.
import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  resolveAdvisoryPrimaryBotLogin,
} from './advisory-wait-policy.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { ghApiJson, ghText } from './gh-exec.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { normalizePolicyConfig } from './policy-helpers.mjs';
import { isCopilotReviewerLogin } from './protocol-helpers.mjs';
export const PROVIDER_HEALTH_SERVICES = ['advisory-review', 'ci-actions'];
export const PROVIDER_HEALTH_VERDICTS = [
  'healthy',
  'degraded',
  'unavailable',
  'unknown',
];
const PROVIDER_HEALTH_REASONS = {
  evidenceUnreadable: 'evidence-unreadable',
  contradictoryEvidence: 'contradictory-evidence',
  noEvidence: 'no-evidence',
  allHealthy: 'all-healthy',
  belowCorroborationThreshold: 'failure-below-corroboration-threshold',
  mixedWithCorroboration: 'mixed-evidence-with-corroboration',
  fullFailureWithCorroboration: 'full-failure-with-corroboration',
};
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
export function classifyProviderHealth(snapshot, policy) {
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
  const failingPrs = new Set();
  const successPrs = new Set();
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
const ADVISORY_WAIT_REQUEST_MARKER_RE =
  /<!--\s*advisory-wait:\s*(\S+)\s+([0-9a-f]{40})\s+(\S+)\s*-->/;
/**
 * Collect `advisory-review` evidence across recent pull requests. For each
 * of the most-recently-updated open or closed PRs (bounded by `sampleSize`),
 * a trusted `advisory-wait:` request marker with no subsequent
 * `review_requested` timeline event for the primary bot is 'failure'
 * evidence (#2327's own observable); a marker followed by a
 * `review_requested` event, or a submitted review from the primary bot, is
 * 'success' evidence. A PR with no request marker at all contributes no
 * observation (out of scope for this window, not evidence either way).
 */
export function collectAdvisoryReviewEvidence(owner, repo, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const primaryBotLogin =
    options.primaryBotLogin ?? DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN;
  const sampleSize = options.sampleSize ?? 20;
  const observations = [];
  let pulls;
  try {
    pulls = ghApiJson(
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
  for (const pull of pulls) {
    const prNumber = pull.number;
    if (typeof prNumber !== 'number') continue;
    let comments;
    let timeline;
    try {
      comments = ghApiJson(
        `repos/${owner}/${repo}/issues/${prNumber}/comments`,
        { paginate: true },
      );
      timeline = ghApiJson(
        `repos/${owner}/${repo}/issues/${prNumber}/timeline`,
        {
          paginate: true,
          extraArgs: ['-H', 'Accept: application/vnd.github+json'],
        },
      );
    } catch {
      // A single PR's read failure is not the whole snapshot's failure --
      // the fetchable PRs still yield real evidence. Skip this PR only.
      continue;
    }
    const requestMarkerAt = earliestTrustedAdvisoryWaitRequestAt(comments);
    if (!requestMarkerAt) continue;
    const registered = timeline.some((event) => {
      if (String(event?.event ?? '') !== 'review_requested') return false;
      const reviewerLogin = String(event?.requested_reviewer?.login ?? '');
      if (!isCopilotReviewerLogin(reviewerLogin, primaryBotLogin)) return false;
      const eventAt = String(event?.created_at ?? '');
      return eventAt !== '' && eventAt >= requestMarkerAt;
    });
    observations.push({
      prNumber,
      outcome: registered ? 'success' : 'failure',
    });
  }
  return {
    service: 'advisory-review',
    now,
    contradictory: false,
    unreadable: false,
    observations,
  };
}
function earliestTrustedAdvisoryWaitRequestAt(comments) {
  let earliest = null;
  for (const comment of comments) {
    const body = String(comment?.body ?? '');
    if (!ADVISORY_WAIT_REQUEST_MARKER_RE.test(body)) continue;
    const createdAt = String(comment?.created_at ?? '');
    if (createdAt === '') continue;
    if (earliest === null || createdAt < earliest) {
      earliest = createdAt;
    }
  }
  return earliest;
}
/**
 * Collect `ci-actions` evidence from recently completed workflow runs. A
 * failing run whose jobs all executed zero steps matches the documented
 * account-level Actions billing/spend-limit block shape (the run starts
 * but no steps run, unlike an ordinary step failure) and is 'failure'
 * evidence; any other failing run is an ordinary code-caused failure and
 * contributes no observation. A successful run is 'success' evidence.
 * Runs unassociated with any pull request are skipped -- corroboration is
 * defined over distinct pull requests.
 */
export function collectCiActionsEvidence(owner, repo, options = {}) {
  const now = options.now ?? new Date().toISOString();
  const sampleSize = options.sampleSize ?? 50;
  const observations = [];
  let runs;
  try {
    const payload = ghApiJson(
      `repos/${owner}/${repo}/actions/runs?status=completed&per_page=${sampleSize}`,
    );
    runs = payload.workflow_runs ?? [];
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
    const prNumber = run.pull_requests?.[0]?.number;
    if (typeof prNumber !== 'number') continue;
    if (run.conclusion === 'success') {
      observations.push({ prNumber, outcome: 'success' });
      continue;
    }
    if (run.conclusion !== 'failure') continue;
    let jobs;
    try {
      const payload = ghApiJson(
        `repos/${owner}/${repo}/actions/runs/${run.id}/jobs`,
      );
      jobs = payload.jobs ?? [];
    } catch {
      continue;
    }
    if (jobs.length === 0) continue;
    const everyJobRanNoSteps = jobs.every(
      (job) => Array.isArray(job.steps) && job.steps.length === 0,
    );
    if (everyJobRanNoSteps) {
      observations.push({ prNumber, outcome: 'failure' });
    }
  }
  return {
    service: 'ci-actions',
    now,
    contradictory: false,
    unreadable: false,
    observations,
  };
}
export function buildProviderHealthReport(owner, repo, options = {}) {
  const config = options.config ?? loadIddConfig();
  const policy = normalizePolicyConfig(config).providerHealth;
  const primaryBotLogin = resolveAdvisoryPrimaryBotLogin(config ?? {});
  const now = options.now ?? new Date().toISOString();
  const advisoryReviewSnapshot = collectAdvisoryReviewEvidence(owner, repo, {
    primaryBotLogin,
    now,
  });
  const ciActionsSnapshot = collectCiActionsEvidence(owner, repo, { now });
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
};
if (import.meta.main) {
  main();
}
function main() {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    PROVIDER_HEALTH_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const owner =
    values.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    values.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
  const report = buildProviderHealthReport(owner, repo);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/provider-health.mjs [--owner <owner>] [--repo <repo>]

Read-only, cross-pull-request health classifier for two services:
advisory-review and ci-actions. Aggregates already-observable per-PR
evidence (absence of a review_requested event after a successful
request; a workflow run whose every job executes zero steps) into a
healthy/degraded/unavailable/unknown verdict per service. Never a gate:
emits no marker, mutates nothing, and exposes no field any
merge-readiness or CI-gate output could consume as a pass.

--owner/--repo default to the current repository (gh repo view).
`);
}
