import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildAdvisoryConvergenceWaiverPrecondition,
  buildSecondaryQuietWindowStatus,
  normalizeAdvisoryWaitRuntimeOptions,
} from '../src/scripts/advisory-wait-policy.mts';

// normalizeAdvisoryWaitRuntimeOptions is the only export of this module
// without direct dedicated coverage: readAdvisoryWaitPolicy,
// resolveAdvisoryWaitPolicy, resolveAdvisoryPrimaryBotLogin,
// readAdvisoryPrimaryBotLogin, resolveAdvisorySecondaryBotLogin,
// readAdvisorySecondaryBotLogin, resolveAdvisorySecondaryQuietWindowMinutes,
// and readAdvisorySecondaryQuietWindowMinutes already have direct, named
// test() blocks in tests/advisory-wait.test.mts.

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

test('buildAdvisoryConvergenceWaiverPrecondition clamps a future-dated HEAD commit to zero (#2328 review)', () => {
  // `minutesBetweenIso` — what pre-merge-readiness used before this
  // extraction, and what advisory-convergence still uses — returns 0 when the
  // end precedes the start. A raw subtraction would report a negative elapsed
  // and disagree with the gate on a clock-skewed or deliberately future-dated
  // commit.
  const { precondition } = buildAdvisoryConvergenceWaiverPrecondition({
    headCommittedAt: '2026-08-31T06:00:00Z',
    deadlineMinutes: 540,
    now: '2026-08-30T22:00:00Z',
  });
  assert.equal(precondition.elapsedMinutes, 0);
  assert.equal(precondition.deadlinePassed, false);
  assert.equal(precondition.open, false);
});

test('buildAdvisoryConvergenceWaiverPrecondition reports null elapsed on an unusable now (#2328 review)', () => {
  const { precondition } = buildAdvisoryConvergenceWaiverPrecondition({
    headCommittedAt: '2026-08-30T18:13:24Z',
    deadlineMinutes: 540,
    now: 'not-a-timestamp',
  });
  assert.equal(precondition.elapsedMinutes, null);
  assert.equal(precondition.deadlinePassed, false);
});

// #2335: buildSecondaryQuietWindowStatus.

test('buildSecondaryQuietWindowStatus reports elapsed unconditionally when the window is off (0/absent)', () => {
  for (const minutes of [0, undefined, null, -5, 'soon', Number.NaN]) {
    const status = buildSecondaryQuietWindowStatus({
      minutes,
      effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
      now: '2026-08-30T22:00:30Z',
    });
    assert.equal(status.elapsed, true);
    assert.equal(status.elapsedMinutes, null);
    assert.equal(status.remainingMinutes, 0);
    assert.equal(status.anchorAt, '2026-08-30T22:00:00Z');
  }
});

test('buildSecondaryQuietWindowStatus reports elapsed unconditionally when there is no substantive activity to anchor on', () => {
  for (const anchor of [undefined, null, '', 'not-a-timestamp']) {
    const status = buildSecondaryQuietWindowStatus({
      minutes: 15,
      effectiveMaxActivityUpdatedAt: anchor,
      now: '2026-08-30T22:00:00Z',
    });
    assert.equal(status.elapsed, true);
    assert.equal(status.elapsedMinutes, null);
    assert.equal(status.remainingMinutes, 0);
    assert.equal(status.anchorAt, 'none');
  }
});

test('buildSecondaryQuietWindowStatus reports not-elapsed with the correct remaining minutes inside the window', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 15,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:10:00Z',
  });
  assert.equal(status.elapsed, false);
  assert.equal(status.elapsedMinutes, 10);
  assert.equal(status.remainingMinutes, 5);
  assert.equal(status.anchorAt, '2026-08-30T22:00:00Z');
});

test('buildSecondaryQuietWindowStatus reports elapsed once the window has fully passed', () => {
  const exact = buildSecondaryQuietWindowStatus({
    minutes: 15,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:15:00Z',
  });
  assert.equal(exact.elapsed, true);
  assert.equal(exact.elapsedMinutes, 15);
  assert.equal(exact.remainingMinutes, 0);

  const past = buildSecondaryQuietWindowStatus({
    minutes: 15,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T23:00:00Z',
  });
  assert.equal(past.elapsed, true);
  assert.equal(past.elapsedMinutes, 60);
  assert.equal(past.remainingMinutes, 0);
});

test('buildSecondaryQuietWindowStatus clamps a future-dated anchor to zero elapsed (mirrors buildAdvisoryConvergenceWaiverPrecondition)', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 15,
    effectiveMaxActivityUpdatedAt: '2026-08-31T06:00:00Z',
    now: '2026-08-30T22:00:00Z',
  });
  assert.equal(status.elapsedMinutes, 0);
  assert.equal(status.elapsed, false);
  assert.equal(status.remainingMinutes, 15);
});

test('buildSecondaryQuietWindowStatus reports null elapsed on an unusable now', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 15,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: 'not-a-timestamp',
  });
  assert.equal(status.elapsedMinutes, null);
  assert.equal(status.elapsed, false);
  assert.equal(status.remainingMinutes, null);
});

test('buildSecondaryQuietWindowStatus floors a non-integer minutes so remainingMinutes stays a whole number (#2352 review)', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 2.9,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:01:00Z',
  });
  assert.equal(status.minutes, 2);
  assert.equal(status.elapsedMinutes, 1);
  assert.equal(status.elapsed, false);
  assert.equal(status.remainingMinutes, 1);
  assert.ok(Number.isInteger(status.remainingMinutes));
});

// #2544: secondaryBotSettledAt settled-buffer branch.

test('buildSecondaryQuietWindowStatus uses the short settled buffer, not the full window, once secondaryBotSettledAt is valid', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 60,
    // Far in the past, so the unsettled path (anchored here) would still be
    // well within its 60-minute window -- proving the settled anchor below
    // is what the gate actually used, not this one.
    effectiveMaxActivityUpdatedAt: '2026-08-30T20:00:00Z',
    secondaryBotSettledAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:04:00Z',
  });
  assert.equal(status.anchorAt, '2026-08-30T22:00:00Z');
  assert.equal(status.minutes, 5);
  assert.equal(status.elapsedMinutes, 4);
  assert.equal(status.elapsed, false);
  assert.equal(status.remainingMinutes, 1);
});

test('buildSecondaryQuietWindowStatus reports elapsed once the settled buffer itself has passed', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 60,
    effectiveMaxActivityUpdatedAt: '2026-08-30T20:00:00Z',
    secondaryBotSettledAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:05:00Z',
  });
  assert.equal(status.elapsed, true);
  assert.equal(status.elapsedMinutes, 5);
  assert.equal(status.remainingMinutes, 0);
});

test('buildSecondaryQuietWindowStatus never waits longer than the configured minutes even once settled', () => {
  // Configured window (2 min) is shorter than the settled buffer (5 min) --
  // settlement must not make the wait LONGER than what was explicitly asked
  // for.
  const status = buildSecondaryQuietWindowStatus({
    minutes: 2,
    effectiveMaxActivityUpdatedAt: '2026-08-30T20:00:00Z',
    secondaryBotSettledAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:02:00Z',
  });
  assert.equal(status.minutes, 2);
  assert.equal(status.elapsed, true);
  assert.equal(status.remainingMinutes, 0);
});

test('buildSecondaryQuietWindowStatus falls through to the unsettled path when secondaryBotSettledAt is absent or invalid', () => {
  for (const settledAt of [undefined, null, '', 'not-a-timestamp']) {
    const status = buildSecondaryQuietWindowStatus({
      minutes: 15,
      effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
      secondaryBotSettledAt: settledAt,
      now: '2026-08-30T22:10:00Z',
    });
    assert.equal(status.anchorAt, '2026-08-30T22:00:00Z');
    assert.equal(status.minutes, 15);
    assert.equal(status.elapsedMinutes, 10);
    assert.equal(status.elapsed, false);
    assert.equal(status.remainingMinutes, 5);
  }
});

test('buildSecondaryQuietWindowStatus stays elapsed:true at minutes:0 regardless of secondaryBotSettledAt (byte-identical off default)', () => {
  const withSettledAt = buildSecondaryQuietWindowStatus({
    minutes: 0,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    secondaryBotSettledAt: '2026-08-30T22:03:00Z',
    now: '2026-08-30T22:03:30Z',
  });
  const withoutSettledAt = buildSecondaryQuietWindowStatus({
    minutes: 0,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:03:30Z',
  });
  assert.deepEqual(withSettledAt, withoutSettledAt);
  assert.equal(withSettledAt.elapsed, true);
  assert.equal(withSettledAt.remainingMinutes, 0);
  assert.equal(withSettledAt.anchorAt, '2026-08-30T22:00:00Z');
});

// #2547: `secondaryBotDeclined: true` skips the wait entirely -- the bot
// has already, definitively, declined to review this exact HEAD, so
// #2335's "might still be mid-review" protection has nothing left to wait
// for.
test('buildSecondaryQuietWindowStatus reports elapsed unconditionally when secondaryBotDeclined is true, even with a fresh activity anchor', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 60,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    secondaryBotDeclined: true,
    now: '2026-08-30T22:00:30Z',
  });
  assert.equal(status.elapsed, true);
  assert.equal(status.remainingMinutes, 0);
  assert.equal(status.declined, true);
});

test('buildSecondaryQuietWindowStatus still requires the full window when secondaryBotDeclined is absent (still pending, #2335 protection preserved)', () => {
  const status = buildSecondaryQuietWindowStatus({
    minutes: 60,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:00:30Z',
  });
  assert.equal(status.elapsed, false);
  assert.equal(status.declined, false);
});

test('buildSecondaryQuietWindowStatus reports declined:false on every non-declined path (settled buffer, off, no-anchor, unsettled)', () => {
  assert.equal(
    buildSecondaryQuietWindowStatus({
      minutes: 60,
      effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
      secondaryBotSettledAt: '2026-08-30T22:03:00Z',
      now: '2026-08-30T22:03:30Z',
    }).declined,
    false,
  );
  assert.equal(
    buildSecondaryQuietWindowStatus({
      minutes: 0,
      now: '2026-08-30T22:03:30Z',
    }).declined,
    false,
  );
  assert.equal(
    buildSecondaryQuietWindowStatus({
      minutes: 60,
      now: '2026-08-30T22:03:30Z',
    }).declined,
    false,
  );
});

test('buildSecondaryQuietWindowStatus: secondaryBotDeclined false is treated the same as absent (still the full window)', () => {
  const declinedFalse = buildSecondaryQuietWindowStatus({
    minutes: 60,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    secondaryBotDeclined: false,
    now: '2026-08-30T22:00:30Z',
  });
  const declinedAbsent = buildSecondaryQuietWindowStatus({
    minutes: 60,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:00:30Z',
  });
  assert.deepEqual(declinedFalse, declinedAbsent);
});

test('buildSecondaryQuietWindowStatus: minutes<=0 stays unconditional even when secondaryBotDeclined is true (off default wins)', () => {
  const withDeclined = buildSecondaryQuietWindowStatus({
    minutes: 0,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    secondaryBotDeclined: true,
    now: '2026-08-30T22:00:30Z',
  });
  const withoutDeclined = buildSecondaryQuietWindowStatus({
    minutes: 0,
    effectiveMaxActivityUpdatedAt: '2026-08-30T22:00:00Z',
    now: '2026-08-30T22:00:30Z',
  });
  assert.deepEqual(withDeclined, withoutDeclined);
});
