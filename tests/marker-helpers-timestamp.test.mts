import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidIsoTimestamp } from '../src/scripts/marker-helpers.mts';

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
