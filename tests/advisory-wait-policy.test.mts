import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeAdvisoryWaitRuntimeOptions } from '../src/scripts/advisory-wait-policy.mts';

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
