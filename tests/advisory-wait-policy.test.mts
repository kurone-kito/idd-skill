import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAdvisoryConvergenceWaiverPrecondition,
  normalizeAdvisoryWaitRuntimeOptions,
} from '../src/scripts/advisory-wait-policy.mts';

// normalizeAdvisoryWaitRuntimeOptions is the only export of this module
// without direct dedicated coverage: readAdvisoryWaitPolicy,
// resolveAdvisoryWaitPolicy, resolveAdvisoryPrimaryBotLogin,
// readAdvisoryPrimaryBotLogin, resolveAdvisorySecondaryBotLogin, and
// readAdvisorySecondaryBotLogin already have direct, named test() blocks in
// tests/advisory-wait.test.mts.

test('normalizeAdvisoryWaitRuntimeOptions applies every default on empty input', () => {
  assert.deepEqual(normalizeAdvisoryWaitRuntimeOptions({}), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });
});

test('normalizeAdvisoryWaitRuntimeOptions applies every default on absent input', () => {
  assert.deepEqual(normalizeAdvisoryWaitRuntimeOptions(), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });
});

test('normalizeAdvisoryWaitRuntimeOptions accepts explicit valid values', () => {
  assert.deepEqual(
    normalizeAdvisoryWaitRuntimeOptions({
      requestCap: 12,
      pendingWindowMinutes: 45,
      settledWindowMinutes: 15,
      pollIntervalMinutes: 3,
      capExhaustedRoute: 'hold',
    }),
    {
      requestCap: 12,
      pendingWindowMinutes: 45,
      settledWindowMinutes: 15,
      pollIntervalMinutes: 3,
      capExhaustedRoute: 'hold',
    },
  );
});

test('normalizeAdvisoryWaitRuntimeOptions coerces a numeric string, unlike the config-file path', () => {
  // resolveAdvisoryWaitPolicy's config-path sibling requires
  // `typeof value === 'number'` and would reject a string to the default;
  // this runtime-options variant uses `Number(value)` coercion instead,
  // so a numeric string is accepted. This distinction is the reason this
  // function needs its own dedicated coverage.
  assert.deepEqual(
    normalizeAdvisoryWaitRuntimeOptions({
      requestCap: '5',
      pendingWindowMinutes: '20',
    }),
    {
      requestCap: 5,
      pendingWindowMinutes: 20,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );
});

test('normalizeAdvisoryWaitRuntimeOptions falls back on a non-positive requestCap', () => {
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ requestCap: 0 }).requestCap,
    30,
  );
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ requestCap: -1 }).requestCap,
    30,
  );
});

test('normalizeAdvisoryWaitRuntimeOptions falls back on a non-integer requestCap', () => {
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ requestCap: 1.5 }).requestCap,
    30,
  );
});

test('normalizeAdvisoryWaitRuntimeOptions accepts a non-integer positive window minutes value', () => {
  // The window/interval fields use normalizePositiveNumber (Number.isFinite),
  // not normalizePositiveInteger, so a fractional value is accepted.
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ pendingWindowMinutes: 2.5 })
      .pendingWindowMinutes,
    2.5,
  );
});

test('normalizeAdvisoryWaitRuntimeOptions falls back on a non-positive window minutes value', () => {
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ settledWindowMinutes: 0 })
      .settledWindowMinutes,
    10,
  );
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ pollIntervalMinutes: -3 })
      .pollIntervalMinutes,
    2,
  );
});

test('normalizeAdvisoryWaitRuntimeOptions falls back on a non-numeric window minutes value', () => {
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ settledWindowMinutes: 'soon' })
      .settledWindowMinutes,
    10,
  );
});

test('normalizeAdvisoryWaitRuntimeOptions accepts only a recognized capExhaustedRoute', () => {
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ capExhaustedRoute: 'hold' })
      .capExhaustedRoute,
    'hold',
  );
  assert.equal(
    normalizeAdvisoryWaitRuntimeOptions({ capExhaustedRoute: 'unknown-route' })
      .capExhaustedRoute,
    'phase-specific',
  );
});

// #2328: the waiver precondition was built inline inside
// pre-merge-readiness's reducer; extracting it is what lets
// external-check-waiver report the same verdict instead of a second
// implementation that can disagree with the gate.

test('buildAdvisoryConvergenceWaiverPrecondition keeps the hatch closed before the deadline (#2328)', () => {
  const { precondition, deadlineOpensAt } =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: '2026-08-30T18:13:24Z',
      deadlineMinutes: 540,
      now: '2026-08-30T22:02:24Z',
    });
  assert.deepEqual(precondition, {
    checkSelector: 'idd-advisory-convergence',
    deadlineMinutes: 540,
    headCommittedAt: '2026-08-30T18:13:24Z',
    elapsedMinutes: 229,
    deadlinePassed: false,
    terminalUnavailable: false,
    open: false,
  });
  // No open moment while the deadline itself has not passed.
  assert.equal(deadlineOpensAt, '');
});

test('buildAdvisoryConvergenceWaiverPrecondition opens on the deadline and reports its moment (#2328)', () => {
  const { precondition, deadlineOpensAt } =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: '2026-08-30T18:13:24Z',
      deadlineMinutes: 540,
      now: '2026-08-31T03:13:24Z',
    });
  assert.equal(precondition.elapsedMinutes, 540);
  assert.equal(precondition.deadlinePassed, true);
  assert.equal(precondition.open, true);
  assert.equal(deadlineOpensAt, '2026-08-31T03:13:24.000Z');
});

test('buildAdvisoryConvergenceWaiverPrecondition opens on terminal unavailability alone (#2328)', () => {
  const { precondition, deadlineOpensAt } =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: '2026-08-30T18:13:24Z',
      deadlineMinutes: 540,
      terminalUnavailable: true,
      now: '2026-08-30T22:02:24Z',
    });
  assert.equal(precondition.deadlinePassed, false);
  assert.equal(precondition.terminalUnavailable, true);
  assert.equal(precondition.open, true);
  // The terminal path has no anchor of its own, so it reports no moment
  // even though the hatch is open.
  assert.equal(deadlineOpensAt, '');
});

test('buildAdvisoryConvergenceWaiverPrecondition never opens on an unusable head timestamp (#2328)', () => {
  // `none` is reported only for an absent value; a present-but-unparseable
  // string is echoed back verbatim so the operator can see what was
  // configured. Either way the hatch must stay shut, which is the half that
  // matters: an unusable anchor can never prove the deadline elapsed.
  for (const headCommittedAt of ['', null, undefined]) {
    const { precondition } = buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt,
      deadlineMinutes: 540,
      now: '2026-08-30T22:02:24Z',
    });
    assert.equal(precondition.headCommittedAt, 'none');
    assert.equal(precondition.elapsedMinutes, null);
    assert.equal(precondition.deadlinePassed, false);
    assert.equal(precondition.open, false);
  }

  const { precondition, deadlineOpensAt } =
    buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: 'not-a-timestamp',
      deadlineMinutes: 540,
      now: '2026-08-30T22:02:24Z',
    });
  assert.equal(precondition.headCommittedAt, 'not-a-timestamp');
  assert.equal(precondition.elapsedMinutes, null);
  assert.equal(
    precondition.deadlinePassed,
    false,
    'an unparseable anchor must never open the hatch',
  );
  assert.equal(precondition.open, false);
  assert.equal(deadlineOpensAt, '');
});

test('buildAdvisoryConvergenceWaiverPrecondition defaults the deadline when it is not finite (#2328)', () => {
  for (const deadlineMinutes of [undefined, null, 'soon', Number.NaN]) {
    const { precondition } = buildAdvisoryConvergenceWaiverPrecondition({
      headCommittedAt: '2026-08-30T18:13:24Z',
      deadlineMinutes,
      now: '2026-08-30T22:02:24Z',
    });
    assert.equal(precondition.deadlineMinutes, 1440);
  }
});
