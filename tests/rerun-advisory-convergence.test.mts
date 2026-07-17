import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildCheckRunsForRefArgs,
  buildIddConfigContentsArgs,
  computeRerunPlan,
  describeNoActionState,
  parseArgs,
  parseRunIdFromUrl,
  RERUN_PLAN_CHECK_NAME,
  type RerunPlanInput,
  type RerunPlanOptions,
  type RerunPlanRawInstance,
  resolveCheckRunUrl,
  runRerunAdvisoryConvergence,
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

test('classifies a bot-triggered failure (actor.type === Bot) as bot-gated-skip even without action_required', () => {
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
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
  assert.match(plan.instances[0]?.reason ?? '', /bot/);
});

test('classifies a bot-triggered run via configured advisoryBotLogins fallback (type missing)', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          actorLogin: 'coderabbitai[bot]',
          actorType: null,
          triggeringActorLogin: 'coderabbitai[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions(),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
});

// Regression (#1434 review, Codex P2): a repository can configure a bare
// login (`my-bot`) while the Actions payload reports the GitHub-appended
// `[bot]`-suffixed form (`my-bot[bot]`), or vice versa. An un-normalized
// set lookup would miss that match and let a bot-triggered run fall
// through as rerun-eligible.
test('classifies a bot-triggered run when the configured login is bare but the actual actor login is [bot]-suffixed', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          actorLogin: 'coderabbitai[bot]',
          actorType: null,
          triggeringActorLogin: 'coderabbitai[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ advisoryBotLogins: ['coderabbitai'] }),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
});

test('classifies a bot-triggered run when the configured login is [bot]-suffixed but the actual actor login is bare', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          actorLogin: 'coderabbitai',
          actorType: null,
          triggeringActorLogin: 'coderabbitai',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ advisoryBotLogins: ['coderabbitai[bot]'] }),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
});

// Regression (#1434 review, Codex P2, second occurrence): the sibling gap
// to the advisoryBotLogins normalization above, but on the separate
// primaryBotLogin path -- isCopilotReviewerLogin's non-default branch does
// an exact, un-normalized comparison, so a configured custom primary bot
// login whose [bot]-suffix form doesn't match the actual actor login
// (or vice versa) would otherwise fall through as rerun-eligible.
test('classifies a bot-triggered run when a custom primaryBotLogin is bare but the actual actor login is [bot]-suffixed', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          actorLogin: 'my-bot[bot]',
          actorType: null,
          triggeringActorLogin: 'my-bot[bot]',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ primaryBotLogin: 'my-bot', advisoryBotLogins: [] }),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
});

test('classifies a bot-triggered run when a custom primaryBotLogin is [bot]-suffixed but the actual actor login is bare', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [
        baseInstance({
          conclusion: 'failure',
          actorLogin: 'my-bot',
          actorType: null,
          triggeringActorLogin: 'my-bot',
          triggeringActorType: null,
        }),
      ],
    }),
    baseOptions({ primaryBotLogin: 'my-bot[bot]', advisoryBotLogins: [] }),
  );
  assert.equal(plan.instances[0]?.classification, 'bot-gated-skip');
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

test('treats a null run_attempt as attempt 1 (never rerun), not budget-exhausted', () => {
  const plan = computeRerunPlan(
    baseInput({
      instances: [baseInstance({ conclusion: 'failure', runAttempt: null })],
    }),
    baseOptions(),
  );
  assert.equal(plan.plan.length, 1);
  assert.equal(plan.counts.rerunBudgetHeld, 0);
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

// --- buildIddConfigContentsArgs (regression: #1434 review, Codex P2) ----
//
// Fetching .github/idd/config.json without pinning `ref` reads whichever
// ref `gh` defaults to (the target repository's default branch) instead
// of the exact commit the diagnosed check-runs ran against, silently
// applying the wrong primaryBotLogin / advisoryBotLogins /
// ciWait.rerunPolicy to a PR whose own config differs. Same `--method GET`
// hazard as buildCheckRunsForRefArgs above: `gh api` defaults to POST as
// soon as any `-f` value is present, and the Contents API only accepts
// GET -- confirmed empirically that an unqualified `-f ref=...` 404s on
// every call, which loadRemoteIddConfig's own catch block would otherwise
// silently treat as "config genuinely absent, use defaults".

test('buildIddConfigContentsArgs includes --method GET and pins -f ref to the given SHA', () => {
  const args = buildIddConfigContentsArgs('kurone-kito', 'idd-skill', HEAD);
  assert.deepEqual(args, [
    'api',
    'repos/kurone-kito/idd-skill/contents/.github/idd/config.json',
    '--method',
    'GET',
    '-f',
    `ref=${HEAD}`,
    '--jq',
    '.content',
  ]);
});

test('buildIddConfigContentsArgs places --method immediately before GET (gh api requires the value to follow its flag)', () => {
  const args = buildIddConfigContentsArgs('o', 'r', HEAD);
  const methodIndex = args.indexOf('--method');
  assert.notEqual(methodIndex, -1);
  assert.equal(args[methodIndex + 1], 'GET');
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

test('parseArgs recognizes --help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

// parseArgs delegates mechanical parsing to node:util's own stable
// `parseArgs` (a maintainer's review suggestion, adopted -- see the
// function's doc comment). Its `strict: true` mode raises Node's own
// stable `ERR_PARSE_ARGS_*` error codes for an unknown option or a
// missing/ambiguous value; these tests assert on the stable `code`
// rather than message text, which is Node's own to change.
test('parseArgs rejects an unknown argument', () => {
  assert.throws(() => parseArgs(['--bogus']), {
    code: 'ERR_PARSE_ARGS_UNKNOWN_OPTION',
  });
});

// Regression (#1434 review, Copilot): `strict: true` alone only governs
// unknown *options*, not leftover positional (non-option) tokens, so
// `--pr 1431 extra` would otherwise silently accept `extra` instead of
// failing fast on a likely typo. `allowPositionals: false` closes this.
test('parseArgs rejects an unexpected positional argument', () => {
  assert.throws(() => parseArgs(['--pr', '1431', 'extra']), {
    code: 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
  });
});

// Regression (#1434 review, Copilot + CodeRabbit): a value-taking flag
// with no following token, or followed by another option -- long
// (`--repo`) or short (`-h`) alike -- previously degraded into a
// confusing "unknown argument" error (or, worse, silently accepted the
// next flag as a value). node:util's parseArgs rejects all of these
// forms natively.
test('parseArgs fails fast when --owner is the last argument (missing value)', () => {
  assert.throws(() => parseArgs(['--pr', '1431', '--owner']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  });
});

test('parseArgs fails fast when --owner is immediately followed by another long flag', () => {
  assert.throws(
    () => parseArgs(['--pr', '1431', '--owner', '--repo', 'idd-skill']),
    { code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' },
  );
});

test('parseArgs fails fast when --owner is immediately followed by the short help flag', () => {
  assert.throws(() => parseArgs(['--owner', '-h']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  });
});

test('parseArgs fails fast when --repo has a missing value', () => {
  assert.throws(() => parseArgs(['--repo']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  });
});

test('parseArgs fails fast when --now has a missing value', () => {
  assert.throws(() => parseArgs(['--now']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
  });
});

test('parseArgs fails fast when --pr has a missing value', () => {
  assert.throws(() => parseArgs(['--pr']), {
    code: 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE',
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
