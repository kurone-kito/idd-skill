import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeRerunPlan,
  parseArgs,
  parseRunIdFromUrl,
  RERUN_PLAN_CHECK_NAME,
  type RerunPlanInput,
  type RerunPlanOptions,
  type RerunPlanRawInstance,
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
  for (const entry of plan.plan) {
    assert.match(entry.command, /^gh run rerun \d+$/);
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

test('parseRunIdFromUrl returns null for a non-matching URL', () => {
  assert.equal(
    parseRunIdFromUrl('https://github.com/kurone-kito/idd-skill/pull/1431'),
    null,
  );
});

test('parseRunIdFromUrl returns null for an empty URL', () => {
  assert.equal(parseRunIdFromUrl(''), null);
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

test('parseArgs recognizes --help', () => {
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['-h']).help, true);
});

test('parseArgs rejects an unknown argument', () => {
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
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
