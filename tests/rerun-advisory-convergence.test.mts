import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyRerunPlan,
  buildCheckRunsForRefArgs,
  buildRerunPlanTextSections,
  buildRunViewLogArgs,
  computeRerunPlan,
  describeNoActionState,
  describeOutstandingStates,
  describeRecoveryRefreshHeader,
  extractAdvisoryVerdictReasonsFromLog,
  formatApplySummary,
  hasNeverReviewedVerdictReason,
  hasUncoveredHeadVerdictReason,
  isNeverReviewedVerdictReason,
  isUncoveredHeadVerdictReason,
  NEVER_REVIEWED_REASON_MARKER,
  parseArgs,
  parseRunIdFromUrl,
  RERUN_PLAN_CHECK_NAME,
  type RerunPlanInput,
  type RerunPlanOptions,
  type RerunPlanRawInstance,
  resolveCheckName,
  resolveCheckRunUrl,
  runRerunAdvisoryConvergence,
  sanitizeRemoteConfig,
  UNCOVERED_HEAD_REASON_MARKER,
} from '../src/scripts/rerun-advisory-convergence.mts';

const HEAD = '1111111111111111111111111111111111111111';
const NOW = '2026-07-16T12:00:00Z';

function baseInstance(
  overrides: Partial<RerunPlanRawInstance> = {},
): RerunPlanRawInstance {
  return {
    checkRunId: '1001',
    status: 'completed',
    conclusion: 'success',
    htmlUrl:
      'https://github.com/kurone-kito/idd-skill/actions/runs/5001/job/9001',
    startedAt: '2026-07-16T10:00:00Z',
    completedAt: '2026-07-16T10:05:00Z',
    runId: '5001',
    runLookupFailed: false,
    runEvent: 'pull_request',
    actorLogin: 'kurone-kito',
    actorType: 'User',
    triggeringActorLogin: 'kurone-kito',
    triggeringActorType: 'User',
    runAttempt: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<RerunPlanInput> = {}): RerunPlanInput {
  return {
    prNumber: 1431,
    prHeadSha: HEAD,
    checkName: RERUN_PLAN_CHECK_NAME,
    instances: [],
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<RerunPlanOptions> = {},
): RerunPlanOptions {
  return {
    now: NOW,
    primaryBotLogin: 'copilot',
    advisoryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector[bot]'],
    ...overrides,
  };
}

// --- Classification: pass ---------------------------------------------

test('classifies a success conclusion as pass', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'pass');
  assert.equal(plan.counts.pass, 1);
  assert.equal(plan.plan.length, 0);
});

test('treats neutral and skipped conclusions as pass-equivalent', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({ checkRunId: '1', conclusion: 'neutral' }),
        baseInstance({ checkRunId: '2', conclusion: 'skipped' }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.counts.pass, 2);
  assert.deepEqual(
    plan.instances.map((i) => i.classification),
    ['pass', 'pass'],
  );
});

// --- Classification: pending -------------------------------------------

test('classifies a still-running instance as pending, not rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'pending');
  assert.equal(plan.counts.pending, 1);
  assert.equal(plan.plan.length, 0);
});

test('classifies a queued instance as pending', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({ status: 'queued', conclusion: null, completedAt: null }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'pending');
});

// --- Classification: bot-gated-skip ------------------------------------

test('classifies an action_required conclusion as bot-gated-skip', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'action_required' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
  assert.match(plan.instances[0]?.reason ?? '', /action_required/);
  assert.equal(plan.counts.botGatedSkip, 1);
  assert.equal(plan.plan.length, 0);
});

// Regression (#1745): a CANCELLED-conclusion bot-triggered instance is no
// longer classified bot-gated-skip. #1424 only established that an
// action_required-conclusion Copilot-triggered run is gated by GitHub; a
// direct experiment on PR #1741 confirmed a CANCELLED-conclusion
// bot-triggered instance reran and completed normally, never re-entering
// action_required. The prior, over-broad "action_required OR botTriggered"
// rule withheld exactly this working recovery action from the plan and
// contributed to a false CODEOWNER-deadlock misdiagnosis (issue #1745).
test('classifies a CANCELLED, bot-triggered instance as rerun-eligible, not bot-gated-skip', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'cancelled',
          actorLogin: 'copilot-pull-request-reviewer[bot]',
          actorType: 'Bot',
          triggeringActorLogin: 'copilot-pull-request-reviewer[bot]',
          triggeringActorType: 'Bot',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.counts.botGatedSkip, 0);
  assert.equal(plan.plan.length, 1);
  assert.match(plan.instances[0]?.reason ?? '', /is a bot/);
});

// The isBotTriggered login-normalization fallbacks below (#1434 review,
// Codex P2) no longer affect classifyInstance's own bot-gated-skip
// decision post-#1745 (only an action_required conclusion gates now), but
// they still matter for selectRecoveryRefreshCandidates: an already-PASSING
// instance must still be excluded from the recovery-refresh plan when it is
// itself bot-triggered (rerunning it would not force a genuinely fresh
// non-bot evaluation). These tests retarget the same fixtures to that
// surviving usage site instead of losing the regression coverage.

test('excludes a bot-triggered passing instance from the recovery-refresh plan via configured advisoryBotLogins fallback (type missing)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorLogin: 'coderabbitai[bot]',
          actorType: null,
          triggeringActorLogin: 'coderabbitai[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

// Regression (#1434 review, Codex P2): a repository can configure a bare
// login (`my-bot`) while the Actions payload reports the GitHub-appended
// `[bot]`-suffixed form (`my-bot[bot]`), or vice versa. An un-normalized
// set lookup would miss that match and let a bot-triggered passing instance
// fall through as a recovery-refresh candidate.
test('excludes a bot-triggered passing instance from the recovery-refresh plan when the configured login is bare but the actual actor login is [bot]-suffixed', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorLogin: 'coderabbitai[bot]',
          actorType: null,
          triggeringActorLogin: 'coderabbitai[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ advisoryBotLogins: ['coderabbitai'] }),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('excludes a bot-triggered passing instance from the recovery-refresh plan when the configured login is [bot]-suffixed but the actual actor login is bare', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorLogin: 'coderabbitai',
          actorType: null,
          triggeringActorLogin: 'coderabbitai',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ advisoryBotLogins: ['coderabbitai[bot]'] }),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

// Regression (#1434 review, Codex P2, second occurrence): the sibling gap
// to the advisoryBotLogins normalization above, but on the separate
// primaryBotLogin path -- isCopilotReviewerLogin's non-default branch does
// an exact, un-normalized comparison, so a configured custom primary bot
// login whose [bot]-suffix form doesn't match the actual actor login
// (or vice versa) would otherwise fall through as a recovery-refresh
// candidate.
test('excludes a bot-triggered passing instance from the recovery-refresh plan when a custom primaryBotLogin is bare but the actual actor login is [bot]-suffixed', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorLogin: 'my-bot[bot]',
          actorType: null,
          triggeringActorLogin: 'my-bot[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ primaryBotLogin: 'my-bot', advisoryBotLogins: [] }),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('excludes a bot-triggered passing instance from the recovery-refresh plan when a custom primaryBotLogin is [bot]-suffixed but the actual actor login is bare', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorLogin: 'my-bot',
          actorType: null,
          triggeringActorLogin: 'my-bot',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ primaryBotLogin: 'my-bot[bot]', advisoryBotLogins: [] }),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('does not classify a plain human failure as bot-gated-skip', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
});

// --- Classification: unresolved -----------------------------------------

test('classifies an unparseable run id as unresolved and never places it in the plan', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          htmlUrl: 'https://github.com/kurone-kito/idd-skill/pull/1431',
          runId: null,
          runEvent: null,
          actorLogin: null,
          actorType: null,
          triggeringActorLogin: null,
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'unresolved');
  assert.equal(plan.counts.unresolved, 1);
  assert.equal(plan.plan.length, 0);
});

test('classifies a failed per-run lookup as unresolved', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          runLookupFailed: true,
          runEvent: null,
          actorLogin: null,
          actorType: null,
          triggeringActorLogin: null,
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'unresolved');
  assert.match(plan.instances[0]?.reason ?? '', /could not be fetched/);
});

test('classifies a completed run with no conclusion as unresolved (malformed payload)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ status: 'completed', conclusion: null })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'unresolved');
});

// Regression (#1434 review, Codex P1): a non-bot, terminal, resolved
// workflow_dispatch run must never be classified rerun-eligible -- this
// helper's own CI guidance documents that a manually dispatched run has
// no pull_request context of its own and is not reliably associated with
// the PR's HEAD SHA, so rerunning it would not dependably clear a stuck
// rollup.
test('classifies a non-bot workflow_dispatch failure as unresolved, not rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({ conclusion: 'failure', runEvent: 'workflow_dispatch' }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'unresolved');
  assert.match(plan.instances[0]?.reason ?? '', /workflow_dispatch/);
  assert.equal(plan.plan.length, 0);
});

test('classifies an instance with an unknown/empty triggering event as unresolved', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runEvent: null })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'unresolved');
});

for (const event of [
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]) {
  test(`treats a non-bot terminal failure triggered by "${event}" as rerun-eligible`, () => {
    const plan = computeRerunPlan(
      baseInput({
        instances: [baseInstance({ conclusion: 'failure', runEvent: event })],
      }),
      baseOptions(),
    );
    assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  });
}

// --- Classification: awaiting-fresh-review (#1775) -----------------------

test('#1775: classifies an uncovered-HEAD verdict reason as awaiting-fresh-review, not rerun-eligible', () => {
  const uncovered =
    'latest copilot review (commit dd0360511785c070a41da94f51de14aa2f2951f8) does not cover current HEAD a479827a75a92962222ce702a3467d1725135c1e';
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [uncovered],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.counts.awaitingFreshReview, 1);
  assert.equal(plan.counts.rerunEligible, 0);
  assert.equal(plan.plan.length, 0);
  assert.match(plan.instances[0]?.reason ?? '', /wait for a fresh review/);
  assert.match(
    describeOutstandingStates(plan),
    /awaiting a fresh review covering the current HEAD/,
  );
});

test('#1775: a missing verdictReasons leaves a terminal failure rerun-eligible (no invented hold)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.plan.length, 1);
});

test('#1775: non-coverage reasons (e.g. unresolved threads) stay rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [
            '1 copilot-authored review thread(s) are neither resolved nor validly dispositioned',
          ],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.plan.length, 1);
});

test('#1775: applyRerunPlan never spends budget on an awaiting-fresh-review instance', () => {
  const initialPlan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [
            `latest copilot review (commit ${HEAD}) does not cover current HEAD ${HEAD}`,
          ],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(initialPlan.plan.length, 0);

  let rerunCalled = false;
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      rerunCalled = true;
    },
    recomputePlan: () => {
      throw new Error('recomputePlan should not be called');
    },
  });

  assert.equal(rerunCalled, false);
  assert.equal(result.executed.length, 0);
  assert.equal(result.resolved, true);
});

// --- Classification: never-reviewed (#2326) -------------------------------

const NEVER_REVIEWED_HISTORICAL_REASON =
  'copilot has not reviewed this pull request yet';

test('#2326: classifies a never-reviewed verdict reason as awaiting-fresh-review, not rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [NEVER_REVIEWED_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.counts.awaitingFreshReview, 1);
  assert.equal(plan.counts.rerunEligible, 0);
  assert.equal(plan.plan.length, 0);
  assert.match(plan.instances[0]?.reason ?? '', /wait for a fresh review/);
  assert.match(
    plan.instances[0]?.reason ?? '',
    /has not reviewed this pull request yet/,
  );
});

test('#2326: applyRerunPlan never spends budget on a never-reviewed instance', () => {
  const initialPlan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [NEVER_REVIEWED_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(initialPlan.plan.length, 0);

  let rerunCalled = false;
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      rerunCalled = true;
    },
    recomputePlan: () => {
      throw new Error('recomputePlan should not be called');
    },
  });

  assert.equal(rerunCalled, false);
  assert.equal(result.executed.length, 0);
  assert.equal(result.resolved, true);
});

test('#2326: headCoverageSatisfied true also recovers a never-reviewed hold to rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [NEVER_REVIEWED_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.counts.awaitingFreshReview, 0);
  assert.equal(plan.plan.length, 1);
  assert.match(plan.instances[0]?.reason ?? '', /historically reported/);
  assert.match(plan.instances[0]?.reason ?? '', /#1806/);
});

test('#2326: headCoverageSatisfied omitted (undefined) fails closed to the never-reviewed hold', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [NEVER_REVIEWED_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.plan.length, 0);
});

// --- Classification: live-coverage recovery (#1806) ----------------------

const UNCOVERED_HEAD_HISTORICAL_REASON =
  'latest copilot review (commit dd0360511785c070a41da94f51de14aa2f2951f8) does not cover current HEAD a479827a75a92962222ce702a3467d1725135c1e';

test('#1806: headCoverageSatisfied false keeps the historical uncovered-HEAD hold', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: false }),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.counts.awaitingFreshReview, 1);
  assert.equal(plan.counts.rerunEligible, 0);
  assert.equal(plan.plan.length, 0);
  assert.match(plan.instances[0]?.reason ?? '', /wait for a fresh review/);
});

test('#1806: headCoverageSatisfied omitted (undefined) fails closed to the historical hold', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.plan.length, 0);
});

test('#1806: headCoverageSatisfied explicit null fails closed to the historical hold', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: null }),
  );
  assert.equal(plan.instances[0]?.classification, 'awaiting-fresh-review');
  assert.equal(plan.plan.length, 0);
});

test('#1806: headCoverageSatisfied true recovers the instance to rerun-eligible', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.counts.awaitingFreshReview, 0);
  assert.equal(plan.plan.length, 1);
  // The reason text must distinguish this recovery from an ordinary
  // rerun-eligible instance (surfaces in the CLI's full JSON output).
  assert.match(plan.instances[0]?.reason ?? '', /historically reported/);
  assert.match(plan.instances[0]?.reason ?? '', /live check now confirms/);
  assert.match(plan.instances[0]?.reason ?? '', /#1806/);
});

test('#1806: applyRerunPlan spends budget on a live-coverage-recovered instance', () => {
  const initialPlan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.equal(initialPlan.plan.length, 1);

  let rerunCalled = false;
  const resolvedPlan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions(),
  );
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      rerunCalled = true;
    },
    recomputePlan: () => resolvedPlan,
  });

  assert.equal(rerunCalled, true);
  assert.equal(result.executed.length, 1);
  assert.equal(result.resolved, true);
});

test('#1806: existing #1775 behavior is unchanged when headCoverageSatisfied is not involved (non-coverage reason)', () => {
  // Guards against a regression where the new step-7 branch accidentally
  // widens beyond the uncovered-HEAD marker itself.
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          verdictReasons: [
            '1 copilot-authored review thread(s) are neither resolved nor validly dispositioned',
          ],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.plan.length, 1);
  assert.doesNotMatch(plan.instances[0]?.reason ?? '', /#1806/);
});

// --- extractAdvisoryVerdictReasonsFromLog / uncovered-HEAD helpers ------

test('#1775: extractAdvisoryVerdictReasonsFromLog parses gh-run-view-shaped logs', () => {
  const log = [
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000000Z {',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000001Z   "protocolVersion": "1",',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000002Z   "ready": false,',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000003Z   "reasons": [',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000004Z     "latest copilot review (commit abc) does not cover current HEAD def"',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000005Z   ]',
    'idd-advisory-convergence\tRun advisory-convergence verdict (--assert)\t2026-08-01T11:13:10.0000006Z }',
  ].join('\n');
  const reasons = extractAdvisoryVerdictReasonsFromLog(log);
  assert.deepEqual(reasons, [
    'latest copilot review (commit abc) does not cover current HEAD def',
  ]);
  assert.equal(hasUncoveredHeadVerdictReason(reasons), true);
  const firstReason = reasons?.[0] ?? '';
  assert.equal(isUncoveredHeadVerdictReason(firstReason), true);
  assert.equal(
    isUncoveredHeadVerdictReason(
      'copilot has not reviewed this pull request yet',
    ),
    false,
  );
  assert.equal(hasUncoveredHeadVerdictReason(null), false);
  assert.match(UNCOVERED_HEAD_REASON_MARKER, /does not cover current HEAD/);
});

test('#2326: never-reviewed helpers match their marker and reject the uncovered-HEAD reason', () => {
  const neverReviewed = 'copilot has not reviewed this pull request yet';
  assert.equal(isNeverReviewedVerdictReason(neverReviewed), true);
  assert.equal(hasNeverReviewedVerdictReason([neverReviewed]), true);
  assert.equal(
    isNeverReviewedVerdictReason(
      'latest copilot review (commit abc) does not cover current HEAD def',
    ),
    false,
  );
  assert.equal(hasNeverReviewedVerdictReason(null), false);
  assert.equal(hasNeverReviewedVerdictReason(undefined), false);
  assert.match(
    NEVER_REVIEWED_REASON_MARKER,
    /has not reviewed this pull request yet/,
  );
});

test('#1775: extractAdvisoryVerdictReasonsFromLog returns null when no verdict JSON is present', () => {
  assert.equal(extractAdvisoryVerdictReasonsFromLog(''), null);
  assert.equal(
    extractAdvisoryVerdictReasonsFromLog('Process completed with exit code 1.'),
    null,
  );
});

test('#1775: buildRunViewLogArgs pins the plain-text run-log command', () => {
  assert.deepEqual(buildRunViewLogArgs('o', 'r', '99'), [
    'run',
    'view',
    '99',
    '-R',
    'o/r',
    '--log',
  ]);
});

// --- Classification: rerun-eligible + ordered plan -----------------------

test('classifies a resolved, non-bot, terminal failure as rerun-eligible and includes it in the plan', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'cancelled' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.deepEqual(plan.plan, [
    {
      runId: '5001',
      command: 'gh run rerun 5001',
      checkRunIds: ['1001'],
      startedAt: '2026-07-16T10:00:00Z',
    },
  ]);
});

// #1570: absent an explicit uncovered-HEAD verdict reason (#1775), this
// helper classifies on check-run/run-instance shape (conclusion, actor,
// event, run_attempt) and does not re-derive the underlying
// `idd-advisory-convergence` verdict. A stale instance whose non-passing
// conclusion traces to a terminal `COPILOT_UNAVAILABLE`-without-waiver
// hold (advisory-convergence.mts) is therefore classified and planned
// identically to any other non-bot, terminal, resolved failure: once a
// maintainer posts a valid terminal waiver, rerunning THIS SAME existing
// PR-associated run (`gh run rerun`, never `workflow_dispatch`)
// re-evaluates the verdict fresh and observes the now-`ready: true`
// result -- no separate rerun code path is needed.
test('#1570: a terminal-unavailable-without-waiver failure is classified rerun-eligible the same as any other resolved non-bot failure', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'rerun-eligible');
  assert.equal(plan.counts.rerunEligible, 1);
  assert.deepEqual(plan.plan, [
    {
      runId: '5001',
      command: 'gh run rerun 5001',
      checkRunIds: ['1001'],
      startedAt: '2026-07-16T10:00:00Z',
    },
  ]);
});

// Regression (#1434 review, Codex P2 + CodeRabbit Major): `gh run rerun
// <id>` alone resolves its target repository from the caller's own
// cwd/`GH_REPO`, not from whatever `--owner`/`--repo` this helper was
// invoked with -- following the plan from a different checkout could
// silently target the wrong repository. Every generated command must
// carry `-R owner/repo` whenever both are known.
test('embeds -R owner/repo in each generated plan command when owner/repo are known', () => {
  const plan = computeRerunPlan(
    baseInput({
      owner: 'kurone-kito',
      repo: 'idd-skill',
      instances: [baseInstance({ conclusion: 'cancelled' })],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.plan, [
    {
      runId: '5001',
      command: 'gh run rerun 5001 -R kurone-kito/idd-skill',
      checkRunIds: ['1001'],
      startedAt: '2026-07-16T10:00:00Z',
    },
  ]);
});

test('omits -R from generated plan commands when owner/repo are not provided', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'cancelled' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan[0]?.command, 'gh run rerun 5001');
});

test('orders the plan by earliest startedAt, then numeric run id, and dedupes by run id', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'a',
          runId: '9000',
          conclusion: 'failure',
          startedAt: '2026-07-16T12:00:00Z',
        }),
        baseInstance({
          checkRunId: 'b',
          runId: '2000',
          conclusion: 'cancelled',
          startedAt: '2026-07-16T09:00:00Z',
        }),
        // Same run id as 'b' -- a second check-run instance (e.g. a
        // differently-attempted job) resolving to the identical run.
        // Must collapse into ONE plan entry, not two.
        baseInstance({
          checkRunId: 'c',
          runId: '2000',
          conclusion: 'timed_out',
          startedAt: '2026-07-16T09:05:00Z',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 2);
  assert.deepEqual(
    plan.plan.map((entry) => entry.runId),
    ['2000', '9000'],
  );
  assert.deepEqual(plan.plan[0]?.checkRunIds, ['b', 'c']);
  assert.equal(plan.plan[0]?.startedAt, '2026-07-16T09:00:00Z');
});

// Regression (#1434 review, Copilot): checkRunIds previously preserved
// insertion order (the source API/candidate iteration order, not
// guaranteed stable), which could produce noisy diffs across runs. Sorted
// (and de-duped) output is deterministic regardless of input order.
test('sorts checkRunIds for a single run id regardless of contributing-instance order', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'z-run',
          runId: '3000',
          conclusion: 'failure',
        }),
        baseInstance({
          checkRunId: 'a-run',
          runId: '3000',
          conclusion: 'cancelled',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 1);
  assert.deepEqual(plan.plan[0]?.checkRunIds, ['a-run', 'z-run']);
});

// --- Recovery-refresh plan (regression: #1434 review, Codex P1) ---------
//
// idd-ci.instructions.md's Rerun mechanics documents that when a required
// check is stuck on a bot-gated `action_required` instance, the recovery
// is to rerun the EXISTING non-bot pull_request-family run for the same
// SHA -- even when that run already passed. Without this, a PR whose only
// instances are one bot-gated-skip entry and one already-passing non-bot
// entry would get an empty rerun plan, silently leaving the actual
// documented recovery action off the table.

test('offers a recovery-refresh plan when the only instances are bot-gated-skip and an already-passing non-bot run', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
          startedAt: '2026-07-16T11:00:00Z',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 0);
  assert.deepEqual(plan.recoveryRefreshPlan, [
    {
      runId: '7002',
      command: 'gh run rerun 7002',
      checkRunIds: ['passing'],
      startedAt: '2026-07-16T11:00:00Z',
    },
  ]);
  assert.notEqual(plan.recoveryRefreshCaveat, '');
});

test('does not offer a recovery-refresh plan when a genuine rerun-eligible instance already exists', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'failed',
          runId: '7003',
          conclusion: 'failure',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 1);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
  assert.equal(plan.recoveryRefreshCaveat, '');
});

// Regression (#1806 E2 critique pass): a live-coverage-recovered instance
// (classified rerun-eligible instead of awaiting-fresh-review) is a genuine
// rerun-eligible instance for rule 1's purposes too -- when ITS OWN
// runAttempt already exhausted the rerun-once budget, it must suppress
// recoveryRefreshPlan for the whole rollup exactly the same way any other
// budget-held rerun-eligible instance already does (see the "genuine
// rerun-eligible instance already exists" test above), even though the
// instance came from the #1806 recovery path rather than an ordinary
// terminal failure. This locks in that the widened classification path does
// not accidentally create a second, looser rule.
// Pre-#2549, this exact fixture (a budget-exhausted #1806-recovered
// instance coexisting with a bot-gated sibling AND an already-passing
// sibling) pinned that rule 1 suppresses recoveryRefreshPlan uniformly,
// with no exception. #2549 narrowly changes precisely this combination:
// the SAME passing sibling that makes recoveryRefreshPlan's own
// precondition true also proves the rollup is otherwise already resolved,
// so `recovered` is promoted into `liveCoverageRecoveryPlan` instead of
// staying a silent hold -- and, promoted, it no longer suppresses
// recoveryRefreshPlan for the separate `gated` problem either. See the
// "run-attempt-unknown" and "no passing sibling" tests below for the
// cases rule 1 still governs unchanged.
test('#2549: a budget-exhausted live-coverage-recovered instance with a passing sibling promotes to liveCoverageRecoveryPlan and stops suppressing recovery-refresh', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
          startedAt: '2026-07-16T11:00:00Z',
        }),
        baseInstance({
          checkRunId: 'recovered',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: 2, // already used its one rerun-once budget
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  const recovered = plan.instances.find((i) => i.checkRunId === 'recovered');
  assert.equal(recovered?.classification, 'rerun-eligible');
  assert.equal(recovered?.isLiveCoverageRecovery, true);
  // No longer reported as budget-held: it is being handled via
  // liveCoverageRecoveryPlan, not silently withheld.
  assert.equal(recovered?.rerunBudgetHeld, false);
  assert.equal(plan.plan.length, 0);
  assert.deepEqual(
    plan.liveCoverageRecoveryPlan.map((entry) => entry.runId),
    ['7003'],
  );
  assert.match(
    plan.liveCoverageRecoveryPlan[0]?.originalHoldReason ?? '',
    /rerun-budget-exhausted/,
  );
  assert.match(
    plan.liveCoverageRecoveryPlan[0]?.originalHoldReason ?? '',
    /recovered/,
  );
  assert.notEqual(plan.liveCoverageRecoveryCaveat, '');
  // The `recovered` promotion no longer suppresses recoveryRefreshPlan --
  // the separate `gated`/`passing` pairing still qualifies for it.
  assert.deepEqual(
    plan.recoveryRefreshPlan.map((entry) => entry.runId),
    ['7002'],
  );
  assert.equal(plan.rerunPolicyHoldNotice, '');
});

// The non-vacuous regression guard for rule 1 post-#2549: an unconfirmed
// budget ('run-attempt-unknown', `runAttempt: null`) is NOT a spent one,
// so it must not qualify for the #2549 promotion even though every other
// precondition (live-coverage-recovery classification, a passing sibling,
// a bot-gated sibling, rerunPolicy rerun-once) is met -- rule 1 still
// suppresses recoveryRefreshPlan here exactly as before #2549.
test('#2549: a run-attempt-unknown live-coverage-recovered instance is NOT promoted and still suppresses recovery-refresh', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
          startedAt: '2026-07-16T11:00:00Z',
        }),
        baseInstance({
          checkRunId: 'recovered',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: null,
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  const recovered = plan.instances.find((i) => i.checkRunId === 'recovered');
  assert.equal(recovered?.isLiveCoverageRecovery, true);
  assert.equal(recovered?.rerunBudgetHeld, true);
  assert.deepEqual(plan.liveCoverageRecoveryPlan, []);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
  assert.notEqual(plan.rerunPolicyHoldNotice, '');
});

// A live-coverage-recovered instance with NO passing sibling anywhere in
// the batch never satisfies the #2549 promotion's "rollup otherwise
// resolved" precondition, regardless of `anyEligibleHeld` -- it stays
// held exactly as before #2549.
test('#2549: a budget-exhausted live-coverage-recovered instance with no passing sibling is NOT promoted', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'recovered',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: 2,
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  const recovered = plan.instances.find((i) => i.checkRunId === 'recovered');
  assert.equal(recovered?.isLiveCoverageRecovery, true);
  assert.equal(recovered?.rerunBudgetHeld, true);
  assert.deepEqual(plan.liveCoverageRecoveryPlan, []);
  assert.notEqual(plan.rerunPolicyHoldNotice, '');
});

// A repository that opted out of ALL automatic reruns (`ciWait.rerunPolicy:
// "hold"`) must not get the #2549 exception either -- every other
// rerun-budget-held path already withholds under "hold", and this one
// must too.
test('#2549: rerunPolicy "hold" withholds the live-coverage-recovery promotion too', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
        baseInstance({
          checkRunId: 'recovered',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: 2,
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true, rerunPolicy: 'hold' }),
  );
  assert.deepEqual(plan.liveCoverageRecoveryPlan, []);
  assert.equal(plan.rerunPolicy, 'hold');
});

// An ordinary rerun-eligible instance whose budget is exhausted, but
// which was NEVER reclassified via #1806 live-coverage recovery (e.g. the
// waiver-rebind case, or simply a plain non-passing conclusion that used
// its rerun already) is a wholly different `rerun-budget-held` cause and
// must keep today's manual-decision behavior unchanged -- the #2549
// exception is scoped exactly to the live-coverage-recovery
// classification, never wider.
test('#2549: an ordinary (non-live-coverage-recovery) budget-exhausted instance is NOT promoted, even with a passing sibling', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
        baseInstance({
          checkRunId: 'ordinary-held',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: 2,
        }),
      ],
    }),
    baseOptions(),
  );
  const ordinaryHeld = plan.instances.find(
    (i) => i.checkRunId === 'ordinary-held',
  );
  assert.equal(ordinaryHeld?.classification, 'rerun-eligible');
  assert.equal(ordinaryHeld?.isLiveCoverageRecovery, undefined);
  assert.equal(ordinaryHeld?.rerunBudgetHeld, true);
  assert.deepEqual(plan.liveCoverageRecoveryPlan, []);
  assert.notEqual(plan.rerunPolicyHoldNotice, '');
});

test('#2549: applyRerunPlan executes a liveCoverageRecoveryPlan entry only after plan and recoveryRefreshPlan are exhausted, carrying originalHoldReason', () => {
  const initialPlan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
        baseInstance({
          checkRunId: 'recovered',
          runId: '7003',
          conclusion: 'failure',
          runAttempt: 2,
          verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
        }),
      ],
    }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.deepEqual(initialPlan.plan, []);
  assert.equal(initialPlan.recoveryRefreshPlan.length, 1);
  assert.equal(initialPlan.liveCoverageRecoveryPlan.length, 1);

  const resolvedPlan = computeRerunPlan(
    baseInput({ instances: [] }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  const rerunAndWaitCalls: string[] = [];
  const recomputeQueue = [
    // After rerunning the recovery-refresh entry, still nothing left in
    // `plan`, but the live-coverage-recovery entry is still outstanding.
    { ...initialPlan, plan: [], recoveryRefreshPlan: [] },
    // After rerunning the liveCoverageRecoveryPlan entry, everything
    // resolves.
    resolvedPlan,
  ];
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: (command) => {
      rerunAndWaitCalls.push(command.runId);
    },
    recomputePlan: () => recomputeQueue.shift() ?? resolvedPlan,
  });

  assert.deepEqual(rerunAndWaitCalls, ['7002', '7003']);
  assert.deepEqual(
    result.executed.map((entry) => entry.section),
    ['recoveryRefreshPlan', 'liveCoverageRecoveryPlan'],
  );
  const liveCoverageEntry = result.executed.find(
    (entry) => entry.section === 'liveCoverageRecoveryPlan',
  );
  assert.match(liveCoverageEntry?.originalHoldReason ?? '', /recovered/);
  assert.equal(result.resolved, true);
  assert.match(formatApplySummary(result), /originally held/);
});

// Issue #2549 acceptance criterion: MAX_APPLY_RERUNS still bounds the
// total reruns in one --apply call even when MULTIPLE
// live-coverage-recovery-held siblings exist and qualify for promotion --
// this is not a second, larger, or unbounded loop layered on top of the
// existing safety bound.
test('#2549: MAX_APPLY_RERUNS still bounds a run with multiple liveCoverageRecoveryPlan siblings', () => {
  const instances = [
    baseInstance({
      checkRunId: 'passing',
      runId: '9000',
      conclusion: 'success',
    }),
    baseInstance({
      checkRunId: 'recovered-a',
      runId: '9001',
      conclusion: 'failure',
      runAttempt: 2,
      verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
    }),
    baseInstance({
      checkRunId: 'recovered-b',
      runId: '9002',
      conclusion: 'failure',
      runAttempt: 2,
      verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
    }),
    baseInstance({
      checkRunId: 'recovered-c',
      runId: '9003',
      conclusion: 'failure',
      runAttempt: 2,
      verdictReasons: [UNCOVERED_HEAD_HISTORICAL_REASON],
    }),
  ];
  const initialPlan = computeRerunPlan(
    baseInput({ instances }),
    baseOptions({ headCoverageSatisfied: true }),
  );
  assert.equal(initialPlan.liveCoverageRecoveryPlan.length, 3);

  let calls = 0;
  // recomputePlan always hands back the SAME never-resolving plan, so
  // the loop cannot terminate early via `resolved` -- only
  // MAX_APPLY_RERUNS itself can stop it, exactly as the pre-existing
  // "stops after its safety bound" test exercises for `plan`.
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      calls += 1;
    },
    recomputePlan: () => initialPlan,
  });

  assert.equal(result.resolved, false);
  assert.equal(calls, 20);
  assert.equal(result.executed.length, 20);
  assert.ok(
    result.executed.every(
      (entry) => entry.section === 'liveCoverageRecoveryPlan',
    ),
  );
});

// Regression (#1745 Codex review on this same PR, P2): a bot-triggered
// rerun-eligible instance (e.g. a CANCELLED sibling, narrowed out of
// bot-gated-skip by this same PR) does NOT itself supply the "fresh
// non-bot-triggered evaluation" the recovery-refresh mechanism exists to
// force -- its rerun preserves the original triggering actor. When a
// still-genuinely-gated action_required instance ALSO exists in the same
// batch, both plan (rerun the bot-triggered CANCELLED instance) and
// recoveryRefreshPlan (rerun the already-passing non-bot instance) must be
// offered together; suppressing recoveryRefreshPlan just because *some*
// instance is rerun-eligible would silently omit the documented first
// recovery step when GitHub's rollup happens to still be pinned to the
// action_required entry.
test('offers both plan and recoveryRefreshPlan when a bot-triggered rerun-eligible instance coexists with a genuinely gated action_required instance', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'cancelled-bot',
          runId: '7004',
          conclusion: 'cancelled',
          actorLogin: 'copilot-pull-request-reviewer[bot]',
          actorType: 'Bot',
          triggeringActorLogin: 'copilot-pull-request-reviewer[bot]',
          triggeringActorType: 'Bot',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(
    plan.plan.map((entry) => entry.runId),
    ['7004'],
  );
  assert.deepEqual(
    plan.recoveryRefreshPlan.map((entry) => entry.runId),
    ['7002'],
  );
  assert.notEqual(plan.recoveryRefreshCaveat, '');
});

// A genuinely NON-bot rerun-eligible instance is the mirror-opposite case:
// its own rerun already forces the same "fresh non-bot evaluation" the
// refresh mechanism exists to provide, so recoveryRefreshPlan stays
// suppressed even though a bot-gated action_required instance also exists
// -- unchanged from the pre-#1745 behavior (the prior test above).
test('still suppresses recoveryRefreshPlan when the coexisting rerun-eligible instance is non-bot', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'failed-non-bot',
          runId: '7005',
          conclusion: 'failure',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(
    plan.plan.map((entry) => entry.runId),
    ['7005'],
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('does not offer a recovery-refresh plan without a bot-gated-skip instance present', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'success' })],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 0);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('does not offer a recovery-refresh plan when the only passing instance is itself bot-triggered', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'bot-passing',
          runId: '7002',
          conclusion: 'success',
          actorType: 'Bot',
          triggeringActorType: 'Bot',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('does not offer a recovery-refresh plan when the only passing instance is workflow_dispatch-triggered', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'dispatch-passing',
          runId: '7002',
          conclusion: 'success',
          runEvent: 'workflow_dispatch',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

test('embeds -R owner/repo in recovery-refresh plan commands when known', () => {
  const plan = computeRerunPlan(
    baseInput({
      owner: 'kurone-kito',
      repo: 'idd-skill',
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(
    plan.recoveryRefreshPlan[0]?.command,
    'gh run rerun 7002 -R kurone-kito/idd-skill',
  );
});

// --- ciWait.rerunPolicy gating (regression: #1434 review, Codex P1) ------
//
// idd-ci.instructions.md §Rerun mechanics makes the advisory-convergence
// recovery explicitly subject to the resolved ciWait.rerunPolicy: a
// "hold" policy means the repository has deliberately opted out of
// automatic reruns, so this helper must not still hand out ready-to-run
// `gh run rerun` commands.

test('defaults to "rerun-once" and populates the plan when rerunPolicy is omitted', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'failure' })] }),
    baseOptions(),
  );
  assert.equal(plan.rerunPolicy, 'rerun-once');
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.rerunPolicyHoldNotice, '');
});

test('suppresses the rerun plan and reports a hold notice when rerunPolicy is "hold"', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'failure' })] }),
    baseOptions({ rerunPolicy: 'hold' }),
  );
  assert.equal(plan.rerunPolicy, 'hold');
  assert.deepEqual(plan.plan, []);
  assert.equal(plan.counts.rerunEligible, 1);
  assert.match(plan.rerunPolicyHoldNotice, /1 rerun-eligible instance\(s\)/);
  assert.match(plan.rerunPolicyHoldNotice, /"hold"/);
});

test('suppresses the recovery-refresh plan and reports a hold notice when rerunPolicy is "hold"', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions({ rerunPolicy: 'hold' }),
  );
  assert.deepEqual(plan.plan, []);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
  assert.match(plan.rerunPolicyHoldNotice, /1 recovery-refresh candidate\(s\)/);
});

test('does not report a hold notice when rerunPolicy is "hold" but nothing was actually suppressed', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions({ rerunPolicy: 'hold' }),
  );
  assert.equal(plan.rerunPolicyHoldNotice, '');
});

test('normalizes an unrecognized rerunPolicy value to "rerun-once"', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'failure' })] }),
    baseOptions({ rerunPolicy: 'not-a-real-policy' }),
  );
  assert.equal(plan.rerunPolicy, 'rerun-once');
  assert.equal(plan.plan.length, 1);
});

// --- Rerun-once budget (regression: #1434 review, Codex P1) --------------
//
// The "hold" *policy string* alone is not the whole picture:
// resolveCiRerunDecision (ci-wait-policy.mts) also holds once a run's own
// run_attempt shows a rerun already happened, even under the default
// "rerun-once" policy. Without this, rerunning this helper after a failed
// recovery would emit `gh run rerun` again for the same run, bypassing the
// configured one-rerun limit.

test('withholds a rerun-eligible instance whose run_attempt already shows a prior rerun', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: 2 })],
    }),
    baseOptions(),
  );
  assert.equal(plan.rerunPolicy, 'rerun-once');
  assert.deepEqual(plan.plan, []);
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.counts.rerunBudgetHeld, 1);
  assert.equal(plan.instances[0]?.rerunBudgetHeld, true);
  assert.match(plan.rerunPolicyHoldNotice, /rerun-once/);
  assert.match(plan.rerunPolicyHoldNotice, /1 rerun-eligible instance\(s\)/);
});

test('still includes a rerun-eligible instance whose run_attempt is 1 (never rerun)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: 1 })],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.counts.rerunBudgetHeld, 0);
  assert.equal(plan.instances[0]?.rerunBudgetHeld, false);
  assert.equal(plan.rerunPolicyHoldNotice, '');
});

// Regression (CodeRabbit review, #1434): a null run_attempt previously
// defaulted to attempt 1 (the most permissive interpretation -- "never
// rerun") and silently derived rerunCount: 0 from that guess, rather
// than failing closed on a budget that could not be confirmed. An unresolvable
// attempt count is withheld the same way a confirmed-exhausted one is,
// distinguished only by its own reason ('run-attempt-unknown').
test('withholds a rerun-eligible instance whose run_attempt is null (cannot be confirmed, not "never rerun")', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: null })],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.plan, []);
  assert.equal(plan.counts.rerunEligible, 1);
  assert.equal(plan.counts.rerunBudgetHeld, 1);
  assert.equal(plan.instances[0]?.rerunBudgetHeld, true);
  assert.match(
    plan.rerunPolicyHoldNotice,
    /run_attempt could not be confirmed/,
  );
});

test('a "hold" policy still holds a null-run_attempt instance via policy-hold, not run-attempt-unknown', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: null })],
    }),
    baseOptions({ rerunPolicy: 'hold' }),
  );
  assert.deepEqual(plan.plan, []);
  // The policy-level hold notice fires (not the run-attempt-unknown
  // reason), and the per-instance budget-held flag stays false: this
  // instance was never actually charged against its own budget --
  // matches every other instance's fate equally under a blanket hold.
  assert.equal(plan.counts.rerunBudgetHeld, 0);
  assert.equal(plan.instances[0]?.rerunBudgetHeld, false);
  assert.match(plan.rerunPolicyHoldNotice, /"hold"/);
});

test('withholds a recovery-refresh candidate whose run_attempt already shows a prior rerun', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
          runAttempt: 2,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(plan.plan, []);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
  assert.equal(plan.counts.rerunBudgetHeld, 1);
  const passingInstance = plan.instances.find(
    (instance) => instance.checkRunId === 'passing',
  );
  assert.equal(passingInstance?.rerunBudgetHeld, true);
  assert.match(plan.rerunPolicyHoldNotice, /1 recovery-refresh candidate\(s\)/);
});

// Regression (CodeRabbit review, #1434): recovery-refresh must NOT
// activate merely because `plan` ended up empty -- it must only activate
// when there was never a genuinely rerun-eligible instance to begin with
// (`eligibleInstances.length === 0`). A budget-held FAILED instance
// (genuinely rerun-eligible, just out of budget) alongside a bot-gated
// instance AND an unused, already-passing instance previously fell
// through to recommending a rerun of the passing instance instead --
// circumventing the "one rerun, then a human reviews it" boundary the
// budget hold exists to enforce.
test('does not fall through to recovery-refresh when the only rerun-eligible instance is budget-held (not genuinely absent)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'budget-held-failure',
          runId: '8001',
          conclusion: 'failure',
          runAttempt: 2,
        }),
        baseInstance({
          checkRunId: 'gated',
          runId: '8002',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'unused-passing',
          runId: '8003',
          conclusion: 'success',
          runAttempt: 1,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.counts.rerunEligible, 1);
  assert.deepEqual(plan.plan, []);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
  assert.equal(plan.recoveryRefreshCaveat, '');
  const unusedPassing = plan.instances.find(
    (instance) => instance.checkRunId === 'unused-passing',
  );
  // The passing instance was never even considered as a refresh
  // candidate (eligibleInstances.length > 0 short-circuits before
  // recoveryRefreshCandidates' own decisions are computed), so it is
  // not itself budget-held -- only the genuinely-eligible failed
  // instance is.
  assert.equal(unusedPassing?.rerunBudgetHeld, false);
  assert.match(plan.rerunPolicyHoldNotice, /1 rerun-eligible instance\(s\)/);
});

test('a "hold" policy still holds every instance regardless of run_attempt', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: 1 })],
    }),
    baseOptions({ rerunPolicy: 'hold' }),
  );
  assert.deepEqual(plan.plan, []);
  assert.equal(plan.counts.rerunBudgetHeld, 0);
  assert.equal(plan.instances[0]?.rerunBudgetHeld, false);
  assert.match(plan.rerunPolicyHoldNotice, /"hold"/);
});

// --- describeNoActionState (regression: #1434 review, Codex P2) ---------
//
// "No rerun-eligible instances; nothing to do" previously covered every
// terminal state with no plan, including pending/unresolved/bot-gated-only
// results that actually still need an operator action.

test('describeNoActionState reports a clean "nothing to do" only when every instance passed', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions(),
  );
  assert.match(
    describeNoActionState(plan),
    /Every instance is pass-equivalent/,
  );
});

test('describeNoActionState reports no instances found when the batch is empty', () => {
  const plan = computeRerunPlan(baseInput({ instances: [] }), baseOptions());
  assert.match(
    describeNoActionState(plan),
    /No ".*" check-run instances found/,
  );
});

// #1935: the not-found message must name the ACTUAL check-run name that
// was searched, not the hardcoded default -- so a `--check-name` override
// (an adopter's job carries a `name:` display-name key) names its own
// cause instead of only its symptom.
test('describeNoActionState names the custom check-run name that was searched, not the default', () => {
  const plan = computeRerunPlan(
    baseInput({
      checkName: 'The idd-advisory-convergence check',
      instances: [],
    }),
    baseOptions(),
  );
  const message = describeNoActionState(plan);
  assert.match(message, /"The idd-advisory-convergence check"/);
  assert.doesNotMatch(message, new RegExp(`"${RERUN_PLAN_CHECK_NAME}"`));
});

test('describeNoActionState surfaces pending, bot-gated, and unresolved counts instead of claiming nothing to do', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: '1',
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
        baseInstance({ checkRunId: '2', conclusion: 'action_required' }),
        baseInstance({
          checkRunId: '3',
          conclusion: 'failure',
          runId: null,
          runEvent: null,
          actorLogin: null,
          actorType: null,
          triggeringActorLogin: null,
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  const description = describeNoActionState(plan);
  assert.match(description, /1 instance\(s\) are still running/);
  assert.match(description, /1 instance\(s\) are bot-gated/);
  assert.match(description, /1 instance\(s\) could not be resolved/);
  assert.doesNotMatch(description, /^Every instance is pass-equivalent/);
});

// --- describeOutstandingStates (regression: CodeRabbit review, #1434) ---
//
// Extracted from describeNoActionState so the CLI can surface pending /
// bot-gated / unresolved counts INDEPENDENTLY of whether a rerun plan,
// recovery-refresh plan, or hold notice also exists for a DIFFERENT
// instance in the same run -- previously the CLI's own exclusive
// if/else-if chain hid these counts entirely whenever any of those three
// branches fired first.

test('describeOutstandingStates reports pending, bot-gated, and unresolved counts', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: '1',
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
        baseInstance({ checkRunId: '2', conclusion: 'action_required' }),
        baseInstance({
          checkRunId: '3',
          conclusion: 'failure',
          runId: null,
          runEvent: null,
          actorLogin: null,
          actorType: null,
          triggeringActorLogin: null,
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  const description = describeOutstandingStates(plan);
  assert.match(description, /1 instance\(s\) are still running/);
  assert.match(description, /1 instance\(s\) are bot-gated/);
  assert.match(description, /1 instance\(s\) could not be resolved/);
});

test('describeOutstandingStates returns an empty string when nothing is outstanding', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions(),
  );
  assert.equal(describeOutstandingStates(plan), '');
});

test('describeOutstandingStates reports a pending instance even when a genuine rerun plan also exists for a different instance', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({ checkRunId: 'failed', conclusion: 'failure' }),
        baseInstance({
          checkRunId: 'still-running',
          status: 'in_progress',
          conclusion: null,
          completedAt: null,
        }),
      ],
    }),
    baseOptions(),
  );
  // The rerun-eligible instance still populates plan as before ...
  assert.equal(plan.plan.length, 1);
  // ... but the pending instance is no longer silently hidden just
  // because a plan also exists.
  assert.match(
    describeOutstandingStates(plan),
    /1 instance\(s\) are still running/,
  );
});

// --- describeRecoveryRefreshHeader / buildRerunPlanTextSections
// (regression: #1752, post-merge Codex review on PR #1749/#1745) ---------
//
// The CLI's stderr renderer previously treated plan.plan and
// plan.recoveryRefreshPlan as mutually exclusive (`if`/`else if`), so
// whenever #1745 made both non-empty at once (a bot-triggered
// rerun-eligible instance in `plan` does not itself supply the non-bot
// trigger a separately bot-gated instance still needs from
// `recoveryRefreshPlan`), only the first-checked section ever printed,
// silently dropping the other's recovery command. These tests cover
// SECTION SELECTION directly (not just wording), matching the same
// combined-instance fixture as the existing computeRerunPlan-level
// regression test above ("offers both plan and recoveryRefreshPlan ...").

function combinedCasePlan() {
  return computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'cancelled-bot',
          runId: '7004',
          conclusion: 'cancelled',
          actorLogin: 'copilot-pull-request-reviewer[bot]',
          actorType: 'Bot',
          triggeringActorLogin: 'copilot-pull-request-reviewer[bot]',
          triggeringActorType: 'Bot',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
}

test('describeRecoveryRefreshHeader: sole case still says no rerun-eligible instances exist', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 0);
  assert.equal(plan.recoveryRefreshPlan.length, 1);
  assert.match(
    describeRecoveryRefreshHeader(plan),
    /No rerun-eligible instances/,
  );
});

test('describeRecoveryRefreshHeader: combined case no longer claims no rerun-eligible instances exist', () => {
  const plan = combinedCasePlan();
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.recoveryRefreshPlan.length, 1);
  const header = describeRecoveryRefreshHeader(plan);
  assert.doesNotMatch(header, /No rerun-eligible instances/);
  // Per idd-ci.instructions.md §Rerun mechanics, the recovery-refresh
  // rerun is the documented FIRST step in this exact combined scenario.
  assert.match(header, /try this FIRST/);
});

test('buildRerunPlanTextSections: sole sequential-plan case prints only that section', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'failure' })] }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.recoveryRefreshPlan.length, 0);
  const sections = buildRerunPlanTextSections(plan);
  assert.equal(sections.length, 1);
  assert.match(sections[0] ?? '', /^Sequential recovery plan/);
});

test('buildRerunPlanTextSections: sole recovery-refresh case prints only that section', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 0);
  assert.equal(plan.recoveryRefreshPlan.length, 1);
  const sections = buildRerunPlanTextSections(plan);
  assert.equal(sections.length, 1);
  assert.match(sections[0] ?? '', /No rerun-eligible instances/);
});

test('buildRerunPlanTextSections: combined case prints BOTH sections, recovery-refresh first', () => {
  const plan = combinedCasePlan();
  const sections = buildRerunPlanTextSections(plan);
  assert.equal(sections.length, 2);
  // Recovery-refresh section prints first (matches idd-ci.instructions.md
  // §Rerun mechanics' documented recovery order for this scenario: rerun
  // the already-passing non-bot instance first, and only fall back to the
  // bot-triggered sequential reruns if that alone doesn't clear the
  // rollup).
  assert.match(sections[0] ?? '', /recovery-refresh option/);
  assert.doesNotMatch(sections[0] ?? '', /No rerun-eligible instances/);
  assert.match(sections[0] ?? '', /gh run rerun 7002/);
  assert.match(sections[1] ?? '', /^Sequential recovery plan/);
  assert.match(sections[1] ?? '', /gh run rerun 7004/);
});

test('buildRerunPlanTextSections: returns no sections when both plan and recoveryRefreshPlan are empty', () => {
  const plan = computeRerunPlan(
    baseInput({ instances: [baseInstance({ conclusion: 'success' })] }),
    baseOptions(),
  );
  assert.deepEqual(buildRerunPlanTextSections(plan), []);
});

// --- Empty case -----------------------------------------------------------

test('reports zero counts and an empty plan when there are no check-run instances', () => {
  const plan = computeRerunPlan(baseInput({ instances: [] }), baseOptions());
  assert.equal(plan.instances.length, 0);
  assert.equal(plan.counts.total, 0);
  assert.equal(plan.counts.pass, 0);
  assert.equal(plan.counts.pending, 0);
  assert.equal(plan.counts.botGatedSkip, 0);
  assert.equal(plan.counts.unresolved, 0);
  assert.equal(plan.counts.rerunEligible, 0);
  assert.deepEqual(plan.plan, []);
  assert.deepEqual(plan.recoveryRefreshPlan, []);
});

// --- Read-only / never-mutating shape ------------------------------------

test('the emitted plan document never contains a mutation command; only gh run rerun read-plan entries', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({ conclusion: 'failure' }),
        baseInstance({ checkRunId: '2', conclusion: 'action_required' }),
      ],
    }),
    baseOptions(),
  );
  // The optional `-R owner/repo` suffix (present whenever `baseInput`
  // supplies owner/repo -- see the dedicated tests above) is allowed here
  // too: the real invariant this test expresses is "only a read-only `gh
  // run rerun` command, never anything else," not "no optional suffix"
  // (#1434 review, Copilot).
  for (const entry of plan.plan) {
    assert.match(entry.command, /^gh run rerun \d+( -R \S+\/\S+)?$/);
  }
});

// --- Validation -------------------------------------------------------------

test('throws on an invalid now timestamp', () => {
  assert.throws(
    () => computeRerunPlan(baseInput(), baseOptions({ now: 'not-a-date' })),
    /ISO 8601/,
  );
});

test('throws on an invalid prHeadSha', () => {
  assert.throws(
    () => computeRerunPlan(baseInput({ prHeadSha: 'nope' }), baseOptions()),
    /40-character hexadecimal/,
  );
});

// --- parseRunIdFromUrl ------------------------------------------------------

test('parseRunIdFromUrl extracts the run id from a job URL', () => {
  assert.equal(
    parseRunIdFromUrl(
      'https://github.com/kurone-kito/idd-skill/actions/runs/12345/job/6789',
    ),
    '12345',
  );
});

test('parseRunIdFromUrl extracts the run id from a bare run URL', () => {
  assert.equal(
    parseRunIdFromUrl(
      'https://github.com/kurone-kito/idd-skill/actions/runs/12345',
    ),
    '12345',
  );
});

// Regression (#1434 review, Copilot): a run id followed directly by a
// query string (GitHub appends `?check_suite_focus=true` to some check-run
// permalinks) previously failed to match, since the run id had to be
// followed by `/` or end-of-string only.
test('parseRunIdFromUrl extracts the run id when followed by a query string', () => {
  assert.equal(
    parseRunIdFromUrl(
      'https://github.com/kurone-kito/idd-skill/actions/runs/12345?check_suite_focus=true',
    ),
    '12345',
  );
});

test('parseRunIdFromUrl returns null for a non-matching URL', () => {
  assert.equal(
    parseRunIdFromUrl('https://github.com/kurone-kito/idd-skill/pull/1431'),
    null,
  );
});

test('parseRunIdFromUrl returns null for an empty URL', () => {
  assert.equal(parseRunIdFromUrl(''), null);
});

// Regression (#1434 review, Copilot, 2 threads): the Checks API's `html_url`
// is more likely than `details_url` to diverge to a non-Actions permalink
// for a check run; `details_url` is documented as "the full details of the
// check" and must be preferred so an otherwise-resolvable run is never
// marked unresolved.
test('resolveCheckRunUrl prefers details_url over html_url when both are present', () => {
  const url = resolveCheckRunUrl({
    html_url: 'https://github.com/o/r/checks/999',
    details_url: 'https://github.com/o/r/actions/runs/12345/job/6789',
  });
  assert.equal(url, 'https://github.com/o/r/actions/runs/12345/job/6789');
});

test('resolveCheckRunUrl falls back to html_url when details_url is absent', () => {
  const url = resolveCheckRunUrl({
    html_url: 'https://github.com/o/r/actions/runs/12345/job/6789',
  });
  assert.equal(url, 'https://github.com/o/r/actions/runs/12345/job/6789');
});

test('resolveCheckRunUrl returns an empty string when neither URL is present', () => {
  assert.equal(resolveCheckRunUrl({}), '');
});

// --- fetchCheckRunsForRef argv construction (regression: #1431 review) --
//
// `gh api` defaults to POST as soon as any `-f`/`-F` value is present
// (per `gh help api`), and the commit check-runs endpoint only accepts
// GET -- an earlier draft of this helper omitted `--method GET` and every
// real invocation 404'd (confirmed against the live GitHub API while
// fixing this during review). These tests assert the exact constructed
// argv without shelling out to `gh`, so a future edit cannot silently
// drop `--method GET` again.

test('buildCheckRunsForRefArgs includes --method GET and filter=all alongside the -f check_name field', () => {
  const args = buildCheckRunsForRefArgs(
    'kurone-kito',
    'idd-skill',
    HEAD,
    RERUN_PLAN_CHECK_NAME,
  );
  assert.deepEqual(args, [
    'api',
    `repos/kurone-kito/idd-skill/commits/${HEAD}/check-runs`,
    '--method',
    'GET',
    '-f',
    `check_name=${RERUN_PLAN_CHECK_NAME}`,
    '-f',
    'filter=all',
    '--paginate',
    '--jq',
    '.check_runs[]',
  ]);
});

// Regression (#1434 review, Codex P1): the commit check-runs endpoint's
// `filter` query parameter defaults to `latest`, which collapses same-named
// check runs down to only the most-recently-completed instance -- silently
// dropping exactly the older non-passing instance this helper exists to
// recover. Confirmed empirically against this repo's own PR history during
// review (the default-filter result omitted the very first check-run
// instance that `filter=all` correctly included).
test('buildCheckRunsForRefArgs requests filter=all so older non-passing instances are never silently dropped', () => {
  const args = buildCheckRunsForRefArgs('o', 'r', HEAD, 'name');
  const filterIndex = args.indexOf('-f', args.indexOf('-f') + 1);
  assert.notEqual(filterIndex, -1, 'expected a second -f flag for filter=all');
  assert.equal(args[filterIndex + 1], 'filter=all');
});

test('buildCheckRunsForRefArgs places --method immediately before GET (gh api requires the value to follow its flag)', () => {
  const args = buildCheckRunsForRefArgs('o', 'r', HEAD, 'name');
  const methodIndex = args.indexOf('--method');
  assert.notEqual(methodIndex, -1);
  assert.equal(args[methodIndex + 1], 'GET');
});

// buildIddConfigContentsArgs now lives in idd-config.mts (#2373, shared
// with pre-merge-readiness.mts) -- its own tests moved to
// tests/idd-config.test.mts alongside it.

// --- sanitizeRemoteConfig (regression: Codex P2, #1434 review) ----------
//
// readCiWaitPolicy / readAdvisoryPrimaryBotLogin validate their own
// local-disk config reads against policy.schema.json's ciWait /
// advisoryWait sections (additionalProperties: false) and fall back to
// documented defaults on any violation. Reading a fetched remote config's
// rerunPolicy/primaryBotLogin directly, without the same validation,
// could let this helper apply a value from a section that the
// established resolver would have discarded entirely -- disagreeing
// with, and incorrectly overriding, the documented policy resolution.

test('sanitizeRemoteConfig discards a ciWait section with an unknown property, even though rerunPolicy itself is a valid enum value', () => {
  const sanitized = sanitizeRemoteConfig({
    ciWait: { rerunPolicy: 'hold', unknownProperty: true },
  });
  assert.equal(sanitized?.ciWait, undefined);
});

test('sanitizeRemoteConfig keeps a schema-valid ciWait section', () => {
  const sanitized = sanitizeRemoteConfig({
    ciWait: { rerunPolicy: 'hold' },
  });
  assert.deepEqual(sanitized?.ciWait, { rerunPolicy: 'hold' });
});

test('sanitizeRemoteConfig discards an advisoryWait section with an invalid enum value', () => {
  const sanitized = sanitizeRemoteConfig({
    advisoryWait: { primaryBotLogin: 'my-bot', capExhaustedRoute: 'bogus' },
  });
  assert.equal(sanitized?.advisoryWait, undefined);
});

test('sanitizeRemoteConfig keeps a schema-valid advisoryWait section', () => {
  const sanitized = sanitizeRemoteConfig({
    advisoryWait: { primaryBotLogin: 'my-bot' },
  });
  assert.deepEqual(sanitized?.advisoryWait, { primaryBotLogin: 'my-bot' });
});

test('sanitizeRemoteConfig discards an advisoryBotLogins array containing a non-string item', () => {
  const sanitized = sanitizeRemoteConfig({
    advisoryBotLogins: ['coderabbitai', 42],
  });
  assert.equal(sanitized?.advisoryBotLogins, undefined);
});

test('sanitizeRemoteConfig keeps a schema-valid advisoryBotLogins array', () => {
  const sanitized = sanitizeRemoteConfig({
    advisoryBotLogins: ['coderabbitai', 'chatgpt-codex-connector'],
  });
  assert.deepEqual(sanitized?.advisoryBotLogins, [
    'coderabbitai',
    'chatgpt-codex-connector',
  ]);
});

test('sanitizeRemoteConfig leaves other fields and an absent section untouched', () => {
  const sanitized = sanitizeRemoteConfig({
    ciWait: { rerunPolicy: 'hold' },
    someUnrelatedTopLevelField: 'kept as-is',
  });
  assert.deepEqual(sanitized?.ciWait, { rerunPolicy: 'hold' });
  assert.equal(sanitized?.someUnrelatedTopLevelField, 'kept as-is');
  assert.equal(sanitized?.advisoryWait, undefined);
});

test('sanitizeRemoteConfig passes null through unchanged', () => {
  assert.equal(sanitizeRemoteConfig(null), null);
});

// --- CLI argument parsing ----------------------------------------------

test('parseArgs parses --pr, --owner, --repo, --now', () => {
  const args = parseArgs([
    '--pr',
    '1431',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--now',
    NOW,
  ]);
  assert.deepEqual(args, {
    prNumber: 1431,
    owner: 'kurone-kito',
    repo: 'idd-skill',
    now: NOW,
    help: false,
    apply: false,
    checkName: '',
  });
});

test('parseArgs normalizes an invalid --pr to null', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

// Regression (#1434 review, Codex P2): Number.parseInt parses only a
// leading numeric prefix ("1431abc" -> 1431), which would silently run
// this recovery helper -- and whatever `gh run rerun` plan it prints --
// against the wrong PR on a typo. The entire value must be digits.
test('parseArgs rejects a partially-numeric --pr value instead of truncating it', () => {
  const args = parseArgs(['--pr', '1431abc']);
  assert.equal(args.prNumber, null);
});

test('parseArgs rejects a --pr value with trailing whitespace and garbage', () => {
  assert.equal(parseArgs(['--pr', '1431 abc']).prNumber, null);
});

test('parseArgs still accepts a plain numeric --pr value', () => {
  assert.equal(parseArgs(['--pr', '1431']).prNumber, 1431);
});

// Disclosed behavior change (#1955 migration onto parseCliArgs(), C1
// self-review): the pre-migration hand-rolled /^\d+$/ grammar accepted a
// leading-zero value like "007" (Number.parseInt parsed it to 7).
// parseCanonicalIntegerOrNull's stricter canonical-integer grammar
// (/^(?:0|[1-9]\d*)$/) rejects any leading zero, resolving "007" to null
// -- the same clean fail-closed outcome as any other malformed --pr
// value, not a crash. GitHub never emits a zero-padded PR number, so
// this narrows an already-unrealistic input rather than a real one; see
// the function's own doc comment for the full disclosure.
test('parseArgs resolves a leading-zero --pr value to null (behavior change from the pre-migration parser)', () => {
  assert.equal(parseArgs(['--pr', '007']).prNumber, null);
});

// Regression (self-discovered while evaluating #1446's cli-args.mts,
// user-directed fix): node:util's own parseArgs (strict: true) throws
// ERR_PARSE_ARGS_INVALID_OPTION_VALUE for a bare `--pr -5` (a
// single-dash-prefixed value looks like it could be another option) --
// verified to throw uncaught before this fix. A negative PR number is
// never valid, but the failure mode must be the same clean
// `prNumber: null` every other malformed --pr value already gets, not an
// uncaught crash. Since #1955's migration onto parseCliArgs(), this
// disambiguation is provided generically by cli-args.mts rather than by a
// --pr-only local helper, but the observable outcome for this case is
// unchanged.
test('parseArgs resolves a dash-prefixed --pr value to null instead of throwing', () => {
  assert.equal(parseArgs(['--pr', '-5']).prNumber, null);
});

test('parseArgs still resolves a dash-prefixed --pr value to null when --owner/--repo are also given', () => {
  const args = parseArgs([
    '--pr',
    '-5',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
  ]);
  assert.equal(args.prNumber, null);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
});

test('parseArgs leaves an ordinary --pr value taking a following flag untouched', () => {
  // Sanity check that the --pr=-5 rewrite is scoped to genuinely
  // ambiguous single-dash values: an ordinary --pr value immediately
  // followed by another flag is unaffected.
  const args = parseArgs(['--pr', '1431', '--owner', 'o', '--repo', 'r']);
  assert.equal(args.prNumber, 1431);
  assert.equal(args.owner, 'o');
  assert.equal(args.repo, 'r');
});

test('parseArgs recognizes --help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs recognizes --apply, defaulting to false when omitted', () => {
  assert.equal(parseArgs(['--pr', '1431']).apply, false);
  assert.equal(parseArgs(['--pr', '1431', '--apply']).apply, true);
});

// --- --check-name (#1935: escape hatch for a job `name:` override) ------

test('parseArgs defaults checkName to the empty string when --check-name is omitted', () => {
  assert.equal(parseArgs(['--pr', '1431']).checkName, '');
});

test('parseArgs parses --check-name', () => {
  const args = parseArgs([
    '--pr',
    '1431',
    '--check-name',
    'The idd-advisory-convergence check',
  ]);
  assert.equal(args.checkName, 'The idd-advisory-convergence check');
});

test('parseArgs trims --check-name', () => {
  const args = parseArgs(['--pr', '1431', '--check-name', '  custom-name  ']);
  assert.equal(args.checkName, 'custom-name');
});

test('parseArgs fails fast when --check-name has a missing value', () => {
  assert.throws(() => parseArgs(['--pr', '1431', '--check-name']), {
    message: 'missing value for argument: --check-name',
  });
});

test('resolveCheckName falls back to RERUN_PLAN_CHECK_NAME when checkName is empty (flag omitted) -- keeps output byte-identical to before this flag existed', () => {
  assert.equal(resolveCheckName({ checkName: '' }), RERUN_PLAN_CHECK_NAME);
});

test('resolveCheckName falls back to RERUN_PLAN_CHECK_NAME when checkName is whitespace-only', () => {
  assert.equal(resolveCheckName({ checkName: '   ' }), RERUN_PLAN_CHECK_NAME);
});

test('resolveCheckName honors a custom checkName', () => {
  assert.equal(
    resolveCheckName({ checkName: 'The idd-advisory-convergence check' }),
    'The idd-advisory-convergence check',
  );
});

// parseArgs delegates mechanical parsing to the shared parseCliArgs()
// wrapper (cli-args.mts, #1446), migrated here from a direct node:util
// parseArgs() call so this helper's parse errors get the same
// bin/run-helper.mts shaped-error interception every other packaged
// idd-* CLI command already gets (#1955; see the function's doc
// comment). node:util's own strict-mode ERR_PARSE_ARGS_* error is
// re-shaped by parseCliArgs()'s toRepoShapedError() into this
// repository's established `unknown argument: --x` / `missing value for
// argument: --x` idiom -- these tests assert on that shaped message text
// (cli-args.mts's own contract), not Node's `.code`, which the shaped
// Error no longer carries.
test('parseArgs rejects an unknown argument', () => {
  assert.throws(() => parseArgs(['--bogus']), {
    message: 'unknown argument: --bogus',
  });
});

// Regression (#1434 review, Copilot): `strict: true` alone only governs
// unknown *options*, not leftover positional (non-option) tokens, so
// `--pr 1431 extra` would otherwise silently accept `extra` instead of
// failing fast on a likely typo. `allowPositionals: false` closes this;
// parseCliArgs() re-shapes both the unknown-option and
// unexpected-positional codes onto the same `unknown argument: ` prefix.
test('parseArgs rejects an unexpected positional argument', () => {
  assert.throws(() => parseArgs(['--pr', '1431', 'extra']), {
    message: 'unknown argument: extra',
  });
});

// Regression (#1434 review, Copilot + CodeRabbit): a value-taking flag
// with no following token, or followed by another long option, previously
// degraded into a confusing "unknown argument" error (or, worse, silently
// accepted the next flag as a value). node:util's parseArgs rejects both
// forms natively; parseCliArgs() re-shapes the result onto this
// repository's `missing value for argument: ` idiom.
test('parseArgs fails fast when --owner is the last argument (missing value)', () => {
  assert.throws(() => parseArgs(['--pr', '1431', '--owner']), {
    message: 'missing value for argument: --owner',
  });
});

test('parseArgs fails fast when --owner is immediately followed by another long flag', () => {
  assert.throws(
    () => parseArgs(['--pr', '1431', '--owner', '--repo', 'idd-skill']),
    { message: 'missing value for argument: --owner' },
  );
});

// parseCliArgs()'s own generic single-dash-value disambiguation (see
// cli-args.mts's disambiguateSingleDashValues doc comment) applies to
// every declared string flag, not just --pr -- disclosed as an
// intentional #1955 migration behavior change at the time. That
// disclosure named a real gap: `-h` after --owner used to look like an
// ordinary ambiguous value to the rewrite, so it was captured as --owner's
// literal value "-h" instead of ever being recognized as the declared
// --help alias it actually is. #1961 closes that gap: a value token that
// itself exactly matches one of the spec's own declared short option
// forms (here, -h for --help) is now reserved and left un-rewritten, so
// node:util's own strict-mode parser sees the genuinely ambiguous
// `--owner -h` pair and reports its usual ambiguous-value error --
// re-shaped by parseCliArgs() onto the same missing-value idiom every
// other missing --owner value already gets, rather than resolving to a
// value --owner can never actually mean.
test('parseArgs fails fast when --owner is immediately followed by the short help flag, instead of silently swallowing it as a literal value (#1961)', () => {
  assert.throws(() => parseArgs(['--owner', '-h']), {
    message: 'missing value for argument: --owner',
  });
});

test('parseArgs fails fast when --repo has a missing value', () => {
  assert.throws(() => parseArgs(['--repo']), {
    message: 'missing value for argument: --repo',
  });
});

test('parseArgs fails fast when --now has a missing value', () => {
  assert.throws(() => parseArgs(['--now']), {
    message: 'missing value for argument: --now',
  });
});

test('parseArgs fails fast when --pr has a missing value', () => {
  assert.throws(() => parseArgs(['--pr']), {
    message: 'missing value for argument: --pr',
  });
});

// Regression (#1434 review, Copilot): --owner/--repo/--now values were
// not trimmed, so accidental whitespace could break API path
// construction downstream.
test('parseArgs trims --owner, --repo, and --now values', () => {
  const args = parseArgs([
    '--owner',
    '  kurone-kito  ',
    '--repo',
    '  idd-skill  ',
    '--now',
    '  2026-07-17T00:00:00Z  ',
  ]);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
  assert.equal(args.now, '2026-07-17T00:00:00Z');
});

// Regression (#1434 review, Copilot): passing only one of --owner/--repo
// let `collectFromGitHub` mix a user-supplied value with a
// `gh repo view`-derived value, constructing a mismatched, unintended
// repository.
test('parseArgs rejects --owner without --repo', () => {
  assert.throws(
    () => parseArgs(['--owner', 'kurone-kito']),
    /provide both --owner and --repo, or neither/,
  );
});

test('parseArgs rejects --repo without --owner', () => {
  assert.throws(
    () => parseArgs(['--repo', 'idd-skill']),
    /provide both --owner and --repo, or neither/,
  );
});

test('parseArgs accepts neither --owner nor --repo', () => {
  const args = parseArgs(['--pr', '1431']);
  assert.equal(args.owner, '');
  assert.equal(args.repo, '');
});

test('parseArgs accepts both --owner and --repo together', () => {
  const args = parseArgs(['--owner', 'kurone-kito', '--repo', 'idd-skill']);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
});

// Regression (Copilot review, #1434): --owner/--repo were only trimmed
// and presence-checked, never validated -- a value containing whitespace
// or a shell metacharacter would still build a syntactically-valid
// -R owner/repo string, but the generated `gh run rerun <id> -R
// owner/repo` recovery commands are meant to be copy-pasted directly by
// an operator, so an unvalidated value could make that copy-paste unsafe.

test('parseArgs rejects an --owner value containing whitespace', () => {
  assert.throws(
    () => parseArgs(['--owner', 'owner name', '--repo', 'idd-skill']),
    /--owner must contain only letters, digits, hyphens, underscores, or periods/,
  );
});

test('parseArgs rejects a --repo value containing a shell metacharacter', () => {
  assert.throws(
    () =>
      parseArgs(['--owner', 'kurone-kito', '--repo', 'idd-skill; rm -rf /']),
    /--repo must contain only letters, digits, hyphens, underscores, or periods/,
  );
});

test('parseArgs still accepts ordinary GitHub owner/repo identifiers with dots and underscores', () => {
  const args = parseArgs([
    '--owner',
    'my_org.name',
    '--repo',
    'my-repo_name.js',
  ]);
  assert.equal(args.owner, 'my_org.name');
  assert.equal(args.repo, 'my-repo_name.js');
});

// --- runRerunAdvisoryConvergence (DI) -----------------------------------

test('runRerunAdvisoryConvergence returns help without calling collect', () => {
  let called = false;
  const result = runRerunAdvisoryConvergence(['--help'], {
    collect: () => {
      called = true;
      throw new Error('should not be called');
    },
  });
  assert.equal(result.help, true);
  assert.equal(result.plan, null);
  assert.equal(called, false);
});

test('runRerunAdvisoryConvergence throws when --pr is missing', () => {
  assert.throws(
    () =>
      runRerunAdvisoryConvergence([], {
        collect: () => {
          throw new Error('should not be called');
        },
      }),
    /missing required --pr/,
  );
});

test('runRerunAdvisoryConvergence computes a plan from injected collect output (no network)', () => {
  const result = runRerunAdvisoryConvergence(['--pr', '1431'], {
    collect: () => ({
      input: baseInput({
        instances: [baseInstance({ conclusion: 'cancelled' })],
      }),
      options: baseOptions(),
    }),
  });
  assert.equal(result.help, false);
  assert.equal(result.plan?.counts.rerunEligible, 1);
  assert.equal(result.plan?.plan.length, 1);
});

test('runRerunAdvisoryConvergence returns the parsed args alongside the plan', () => {
  const result = runRerunAdvisoryConvergence(['--pr', '1431', '--apply'], {
    collect: () => ({ input: baseInput(), options: baseOptions() }),
  });
  assert.equal(result.args.prNumber, 1431);
  assert.equal(result.args.apply, true);
});

test('runRerunAdvisoryConvergence threads --check-name through to deps.collect', () => {
  let receivedCheckName: string | null = null;
  const result = runRerunAdvisoryConvergence(
    ['--pr', '1431', '--check-name', 'The idd-advisory-convergence check'],
    {
      collect: (args) => {
        receivedCheckName = args.checkName;
        return {
          input: baseInput({
            checkName: args.checkName || RERUN_PLAN_CHECK_NAME,
          }),
          options: baseOptions(),
        };
      },
    },
  );
  assert.equal(receivedCheckName, 'The idd-advisory-convergence check');
  assert.equal(result.plan?.checkName, 'The idd-advisory-convergence check');
});

test('runRerunAdvisoryConvergence leaves checkName empty (default) when --check-name is omitted', () => {
  let receivedCheckName: string | null = null;
  runRerunAdvisoryConvergence(['--pr', '1431'], {
    collect: (args) => {
      receivedCheckName = args.checkName;
      return { input: baseInput(), options: baseOptions() };
    },
  });
  assert.equal(receivedCheckName, '');
});

// --- applyRerunPlan -------------------------------------------------------

test('applyRerunPlan reruns each plan entry in order, waiting for each before recomputing', () => {
  const instanceA = baseInstance({
    checkRunId: '1001',
    runId: '5001',
    htmlUrl:
      'https://github.com/kurone-kito/idd-skill/actions/runs/5001/job/9001',
    startedAt: '2026-07-16T10:00:00Z',
    conclusion: 'cancelled',
  });
  const instanceB = baseInstance({
    checkRunId: '1002',
    runId: '5002',
    htmlUrl:
      'https://github.com/kurone-kito/idd-skill/actions/runs/5002/job/9002',
    startedAt: '2026-07-16T10:05:00Z',
    conclusion: 'cancelled',
  });
  const initialPlan = computeRerunPlan(
    baseInput({ instances: [instanceA, instanceB] }),
    baseOptions(),
  );
  assert.deepEqual(
    initialPlan.plan.map((entry) => entry.runId),
    ['5001', '5002'],
  );

  const afterFirst = computeRerunPlan(
    baseInput({ instances: [instanceB] }),
    baseOptions(),
  );
  const afterSecond = computeRerunPlan(
    baseInput({ instances: [] }),
    baseOptions(),
  );

  const rerunCalls: string[] = [];
  let recomputeCallCount = 0;
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: (command) => {
      rerunCalls.push(command.runId);
    },
    recomputePlan: () => {
      recomputeCallCount += 1;
      return recomputeCallCount === 1 ? afterFirst : afterSecond;
    },
  });

  assert.deepEqual(rerunCalls, ['5001', '5002']);
  assert.equal(result.executed.length, 2);
  assert.equal(result.executed[0]?.section, 'plan');
  assert.equal(result.resolved, true);
  assert.equal(result.finalPlan, afterSecond);
});

test('applyRerunPlan stops early once the recomputed plan resolves, skipping the rest of the original plan', () => {
  const instanceA = baseInstance({
    checkRunId: '1001',
    conclusion: 'cancelled',
  });
  const instanceB = baseInstance({
    checkRunId: '1002',
    runId: '5002',
    htmlUrl:
      'https://github.com/kurone-kito/idd-skill/actions/runs/5002/job/9002',
    conclusion: 'cancelled',
  });
  const initialPlan = computeRerunPlan(
    baseInput({ instances: [instanceA, instanceB] }),
    baseOptions(),
  );
  assert.equal(initialPlan.plan.length, 2);

  const resolvedPlan = computeRerunPlan(
    baseInput({ instances: [] }),
    baseOptions(),
  );
  const rerunCalls: string[] = [];
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: (command) => {
      rerunCalls.push(command.runId);
    },
    recomputePlan: () => resolvedPlan,
  });

  assert.equal(rerunCalls.length, 1);
  assert.equal(result.executed.length, 1);
  assert.equal(result.resolved, true);
});

test('applyRerunPlan never reruns a bot-gated-skip instance, and resolves immediately when nothing is eligible', () => {
  const gated = baseInstance({ conclusion: 'action_required' });
  const initialPlan = computeRerunPlan(
    baseInput({ instances: [gated] }),
    baseOptions(),
  );
  assert.equal(initialPlan.plan.length, 0);
  assert.equal(initialPlan.recoveryRefreshPlan.length, 0);

  let rerunCalled = false;
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      rerunCalled = true;
    },
    recomputePlan: () => {
      throw new Error('recomputePlan should not be called');
    },
  });

  assert.equal(rerunCalled, false);
  assert.equal(result.executed.length, 0);
  assert.equal(result.resolved, true);
});

test('applyRerunPlan prefers the recovery-refresh entry over the sequential plan when both are non-empty', () => {
  const initialPlan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          checkRunId: 'gated',
          runId: '7001',
          conclusion: 'action_required',
        }),
        baseInstance({
          checkRunId: 'cancelled-bot',
          runId: '7004',
          conclusion: 'cancelled',
          actorLogin: 'copilot-pull-request-reviewer[bot]',
          actorType: 'Bot',
          triggeringActorLogin: 'copilot-pull-request-reviewer[bot]',
          triggeringActorType: 'Bot',
        }),
        baseInstance({
          checkRunId: 'passing',
          runId: '7002',
          conclusion: 'success',
        }),
      ],
    }),
    baseOptions(),
  );
  assert.deepEqual(
    initialPlan.plan.map((entry) => entry.runId),
    ['7004'],
  );
  assert.deepEqual(
    initialPlan.recoveryRefreshPlan.map((entry) => entry.runId),
    ['7002'],
  );

  const resolvedPlan = computeRerunPlan(
    baseInput({ instances: [] }),
    baseOptions(),
  );
  const order: string[] = [];
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: (command) => {
      order.push(command.runId);
    },
    recomputePlan: () => resolvedPlan,
  });

  assert.deepEqual(order, ['7002']);
  assert.equal(result.executed[0]?.section, 'recoveryRefreshPlan');
});

test('applyRerunPlan stops after its safety bound instead of looping forever when the plan never resolves', () => {
  const instanceA = baseInstance({
    checkRunId: '1001',
    conclusion: 'cancelled',
  });
  const initialPlan = computeRerunPlan(
    baseInput({ instances: [instanceA] }),
    baseOptions(),
  );
  assert.equal(initialPlan.plan.length, 1);

  let calls = 0;
  const result = applyRerunPlan(initialPlan, {
    rerunAndWait: () => {
      calls += 1;
    },
    recomputePlan: () => initialPlan,
  });

  assert.equal(result.resolved, false);
  assert.ok(calls >= 1);
  assert.equal(result.executed.length, calls);
});

// --- formatApplySummary ----------------------------------------------------

test('formatApplySummary reports each executed command and a resolved verdict', () => {
  const text = formatApplySummary({
    executed: [
      { runId: '5001', command: 'gh run rerun 5001', section: 'plan' },
    ],
    finalPlan: computeRerunPlan(baseInput({ instances: [] }), baseOptions()),
    resolved: true,
  });
  assert.match(text, /executed 1 rerun/);
  assert.match(text, /gh run rerun 5001/);
  assert.match(text, /resolved/);
  assert.doesNotMatch(text, /NOT resolved/);
});

test('formatApplySummary reports an unresolved verdict when nothing cleared the rollup', () => {
  const text = formatApplySummary({
    executed: [],
    finalPlan: computeRerunPlan(baseInput({ instances: [] }), baseOptions()),
    resolved: false,
  });
  assert.match(text, /executed 0 rerun/);
  assert.match(text, /NOT resolved/);
});
