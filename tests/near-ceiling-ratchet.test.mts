import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectNearCeilingRatchetViolations,
  selectStricterNoticeUtilizationPct,
} from '../src/scripts/consistency-helpers.mts';

const NOTICE_PCT = 95;

test('selectStricterNoticeUtilizationPct keeps the current value when the base value is missing', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, undefined), 95);
});

test('selectStricterNoticeUtilizationPct keeps the current value when the base value is not a valid number', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, 'not-a-number'), 95);
});

test('selectStricterNoticeUtilizationPct picks the lower base value over a raised current value', () => {
  // #2697 Codex review finding: raising noticeUtilizationPct in the same PR
  // that raises a bundle's limitBytes must not loosen the guard.
  assert.equal(selectStricterNoticeUtilizationPct(97, 95), 95);
});

test('selectStricterNoticeUtilizationPct picks the lower current value when the base value is higher', () => {
  assert.equal(selectStricterNoticeUtilizationPct(90, 95), 90);
});

test('selectStricterNoticeUtilizationPct picks the shared value when base and current match', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, 95), 95);
});

test('a brand-new bundle with no base-ref entry does not error', () => {
  const current = [{ id: 'bundle-new', limitBytes: 10000, totalBytes: 9000 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, []);
  assert.deepEqual(result, []);
});

test('limitBytes unchanged does not error even at high base utilization', () => {
  const current = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 990 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('limitBytes decreased does not error even at high base utilization', () => {
  const current = [{ id: 'bundle-a', limitBytes: 900, totalBytes: 500 }];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 990 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('limitBytes raised while base utilization is below the threshold does not error', () => {
  const current = [{ id: 'bundle-a', limitBytes: 2000, totalBytes: 500 }];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 900 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('limitBytes raised while base utilization is at or above the threshold errors', () => {
  const current = [{ id: 'bundle-a', limitBytes: 2000, totalBytes: 1000 }];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 950 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.equal(result.length, 1);
  assert.match(
    result[0],
    /bundle-a limitBytes raised from 1000 to 2000 while already at 95\.00% utilization at the base ref \(950\/1000 bytes\)/,
  );
});

test('base utilization strictly above the threshold also errors', () => {
  const current = [{ id: 'bundle-a', limitBytes: 2000, totalBytes: 1000 }];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 990 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.equal(result.length, 1);
});

test('a base limitBytes of zero is skipped (nothing to ratchet a percentage from)', () => {
  const current = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }];
  const base = [{ id: 'bundle-a', limitBytes: 0, totalBytes: 0 }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('multiple bundles are evaluated independently', () => {
  const current = [
    { id: 'bundle-a', limitBytes: 2000, totalBytes: 1000 },
    { id: 'bundle-b', limitBytes: 2000, totalBytes: 100 },
  ];
  const base = [
    { id: 'bundle-a', limitBytes: 1000, totalBytes: 950 },
    { id: 'bundle-b', limitBytes: 1000, totalBytes: 100 },
  ];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.equal(result.length, 1);
  assert.match(result[0], /bundle-a/);
});
