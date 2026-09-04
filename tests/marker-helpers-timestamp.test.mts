import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isValidIsoTimestamp,
  normalizeApplyNow,
  normalizeSecondPrecisionIsoTimestamp,
  toSecondPrecisionIso,
} from '../src/scripts/marker-helpers.mts';

// #2215: Date.parse coerces its argument, and a narrow band of numeric
// values (small integers Date.parse happens to interpret as a valid
// date/year) reached the .replace(...) call on a number instead of a
// string, throwing instead of returning false.
test('isValidIsoTimestamp never throws for non-string input, including the numeric band Date.parse coerces to a valid date', () => {
  for (const value of [123, 2024, 1700000000000, null, undefined, {}, []]) {
    assert.doesNotThrow(() => isValidIsoTimestamp(value));
    assert.equal(isValidIsoTimestamp(value), false);
  }
});

test('isValidIsoTimestamp still accepts a well-formed ISO-8601 UTC string', () => {
  assert.equal(isValidIsoTimestamp('2026-01-01T00:00:00Z'), true);
});

test('isValidIsoTimestamp still rejects a malformed string', () => {
  assert.equal(isValidIsoTimestamp('not-a-timestamp'), false);
  assert.equal(isValidIsoTimestamp(''), false);
});

// ---------------------------------------------------------------------------
// toSecondPrecisionIso / normalizeApplyNow (#2568) -- the one canonical
// implementation `idd-roadmap-audit-execute.mts`, `suitability-close-execute.mts`,
// `provider-outage-park.mts`, and `provider-outage-declaration.mts` all
// import instead of each re-deriving their own copy.
// ---------------------------------------------------------------------------

test('toSecondPrecisionIso strips the fractional-second component Date#toISOString() always emits', () => {
  const withMillis = new Date('2026-09-02T00:00:00.123Z');
  assert.equal(toSecondPrecisionIso(withMillis), '2026-09-02T00:00:00Z');
});

test('normalizeApplyNow strips the millisecond fraction Date#toISOString() always emits', () => {
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42.719Z'),
    '2026-09-03T15:44:42Z',
  );
  // Already second-precision: unchanged.
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42Z'),
    '2026-09-03T15:44:42Z',
  );
});

test('normalizeApplyNow normalizes a non-UTC-offset input to UTC', () => {
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42.000+09:00'),
    '2026-09-03T06:44:42Z',
  );
});

test('normalizeApplyNow fails closed (null) on an unparseable value', () => {
  assert.equal(normalizeApplyNow('not-a-date'), null);
  assert.equal(normalizeApplyNow(''), null);
});

// ---------------------------------------------------------------------------
// normalizeSecondPrecisionIsoTimestamp (#2592) -- gates 18 operational-marker
// constructors (claimed-by, unclaimed-by, activation-nonce, advisory-wait,
// advisory-wait-recovery, advisory-reroll, review-ack, copilot-unavailable,
// and the outage-park marker fields), all reachable from
// post-idd-marker.mts's --timestamp flag. It previously rejected any
// fractional-second value outright instead of truncating it, even though
// Date#toISOString() -- the idiomatic way to obtain "now" -- always emits
// millisecond precision.
// ---------------------------------------------------------------------------

test('normalizeSecondPrecisionIsoTimestamp truncates a millisecond-precision toISOString() value instead of rejecting it', () => {
  assert.equal(
    normalizeSecondPrecisionIsoTimestamp('2026-09-04T09:25:43.219Z'),
    '2026-09-04T09:25:43Z',
  );
  // A real Date#toISOString() call always carries millisecond precision.
  const now = new Date('2026-09-04T09:25:43.219Z');
  assert.equal(
    normalizeSecondPrecisionIsoTimestamp(now.toISOString()),
    '2026-09-04T09:25:43Z',
  );
});

test('normalizeSecondPrecisionIsoTimestamp leaves an already-second-precision value unchanged', () => {
  assert.equal(
    normalizeSecondPrecisionIsoTimestamp('2026-09-04T09:25:43Z'),
    '2026-09-04T09:25:43Z',
  );
});

test('normalizeSecondPrecisionIsoTimestamp still rejects a non-UTC-offset timestamp', () => {
  assert.equal(
    normalizeSecondPrecisionIsoTimestamp('2026-09-04T09:25:43.219+09:00'),
    '',
  );
});

test('normalizeSecondPrecisionIsoTimestamp still rejects a genuinely malformed value', () => {
  assert.equal(normalizeSecondPrecisionIsoTimestamp('not-a-timestamp'), '');
  assert.equal(normalizeSecondPrecisionIsoTimestamp(''), '');
  assert.equal(normalizeSecondPrecisionIsoTimestamp(undefined), '');
  assert.equal(normalizeSecondPrecisionIsoTimestamp(123), '');
});
