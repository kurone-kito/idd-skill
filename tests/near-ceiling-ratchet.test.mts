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

// CodeRabbit review finding on PR #2736: a bare `Number(...)` coercion turns
// each of these into a valid-looking `0`, which would wrongly apply an
// effective 0% threshold instead of falling back to currentPct.
test('selectStricterNoticeUtilizationPct falls back to currentPct for null', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, null), 95);
});

test('selectStricterNoticeUtilizationPct falls back to currentPct for an empty string', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, ''), 95);
});

test('selectStricterNoticeUtilizationPct falls back to currentPct for false', () => {
  assert.equal(selectStricterNoticeUtilizationPct(95, false), 95);
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

// Codex review finding on PR #2736: an id rename alone must not exempt an
// already-near-ceiling bundle from this guard as though it were brand-new.
test('a bundle renamed with an identical file set is matched by the rename fallback and errors', () => {
  const files = ['a.md', 'b.md'];
  const current = [
    { id: 'bundle-a-v2', limitBytes: 2000, totalBytes: 1000, files },
  ];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 950, files }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.equal(result.length, 1);
  assert.match(result[0], /bundle-a-v2 limitBytes raised from 1000 to 2000/);
});

test('a bundle renamed with an identical file set and an unchanged limitBytes does not error', () => {
  const files = ['a.md', 'b.md'];
  const current = [
    { id: 'bundle-a-v2', limitBytes: 1000, totalBytes: 950, files },
  ];
  const base = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 950, files }];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('a bundle renamed with a different file set is treated as genuinely new, not a rename', () => {
  const current = [
    {
      id: 'bundle-a-v2',
      limitBytes: 2000,
      totalBytes: 1000,
      files: ['a.md', 'c.md'],
    },
  ];
  const base = [
    {
      id: 'bundle-a',
      limitBytes: 1000,
      totalBytes: 950,
      files: ['a.md', 'b.md'],
    },
  ];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('two base bundles sharing an identical file set are ambiguous and never used as a rename match', () => {
  const files = ['a.md', 'b.md'];
  const current = [
    { id: 'bundle-a-v2', limitBytes: 2000, totalBytes: 1000, files },
  ];
  const base = [
    { id: 'bundle-a', limitBytes: 1000, totalBytes: 950, files },
    { id: 'bundle-a-dup', limitBytes: 1000, totalBytes: 950, files },
  ];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.deepEqual(result, []);
});

test('file order does not affect the rename fallback match', () => {
  const current = [
    {
      id: 'bundle-a-v2',
      limitBytes: 2000,
      totalBytes: 1000,
      files: ['b.md', 'a.md'],
    },
  ];
  const base = [
    {
      id: 'bundle-a',
      limitBytes: 1000,
      totalBytes: 950,
      files: ['a.md', 'b.md'],
    },
  ];
  const result = collectNearCeilingRatchetViolations(NOTICE_PCT, current, base);
  assert.equal(result.length, 1);
});
