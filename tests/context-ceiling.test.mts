import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectContextCeilingViolations } from '../src/scripts/consistency-helpers.mts';

const BASE_CONFIG = {
  id: 'context-ceiling-128k',
  maxBundleLimitBytes: 120000,
  maxUtilizationPct: 98,
  noticeUtilizationPct: 95,
  exemptBundles: [],
};

test('config null is a no-op', () => {
  assert.deepEqual(collectContextCeilingViolations(null, []), {
    errors: [],
    notices: [],
  });
});

test('passes with no errors or notices when every bundle is well under both thresholds', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 10000, totalBytes: 5000 }];
  assert.deepEqual(collectContextCeilingViolations(BASE_CONFIG, bundles), {
    errors: [],
    notices: [],
  });
});

test('errors when a non-exempt bundle limitBytes exceeds the absolute ceiling', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 130000, totalBytes: 1000 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /bundle-a limitBytes 130000 exceeds the 120000-byte context ceiling/,
  );
});

test('errors when a non-exempt bundle utilization exceeds maxUtilizationPct', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 990 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /bundle-a utilization 99\.00% exceeds 98%/);
});

test('a bundle at exactly maxUtilizationPct does not error (strict greater-than)', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 980 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.deepEqual(result.errors, []);
});

test('a bundle at exactly noticeUtilizationPct notices (inclusive)', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 950 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.equal(result.notices.length, 1);
  assert.match(
    result.notices[0],
    /bundle-a utilization is 95\.00% \(>= 95% notice threshold\)/,
  );
});

test('a bundle just below noticeUtilizationPct does not notice', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 949 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.deepEqual(result.notices, []);
});

test('an exempt bundle that currently violates neither check gets a stale-exemption notice', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }];
  const config = { ...BASE_CONFIG, exemptBundles: ['bundle-a'] };
  const result = collectContextCeilingViolations(config, bundles);
  assert.equal(result.errors.length, 0);
  assert.equal(result.notices.length, 1);
  assert.match(
    result.notices[0],
    /bundle-a is listed in exemptBundles but currently violates neither ceiling check/,
  );
});

test('an exempt bundle that does violate is silenced with no error and no stale-exemption notice', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 130000, totalBytes: 129900 }];
  const config = { ...BASE_CONFIG, exemptBundles: ['bundle-a'] };
  const result = collectContextCeilingViolations(config, bundles);
  assert.deepEqual(result.errors, []);
  assert.equal(
    result.notices.some((notice) => notice.includes('violates neither')),
    false,
  );
  // The >= notice threshold still fires regardless of exemption.
  assert.equal(
    result.notices.some((notice) => notice.includes('notice threshold')),
    true,
  );
});

test('errors when exemptBundles names an id absent from the supplied bundle list', () => {
  const bundles = [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }];
  const config = { ...BASE_CONFIG, exemptBundles: ['bundle-does-not-exist'] };
  const result = collectContextCeilingViolations(config, bundles);
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /exemptBundles names unknown bundle id "bundle-does-not-exist"/,
  );
});

test('errors on a malformed maxBundleLimitBytes', () => {
  const result = collectContextCeilingViolations(
    { ...BASE_CONFIG, maxBundleLimitBytes: 'not-a-number' },
    [],
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /maxBundleLimitBytes must be a non-negative integer/,
  );
});

test('errors on a malformed maxUtilizationPct', () => {
  const result = collectContextCeilingViolations(
    { ...BASE_CONFIG, maxUtilizationPct: -1 },
    [],
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /maxUtilizationPct must be a non-negative number/,
  );
});

test('errors on a malformed noticeUtilizationPct', () => {
  const result = collectContextCeilingViolations(
    { ...BASE_CONFIG, noticeUtilizationPct: null },
    [],
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /noticeUtilizationPct must be a non-negative number/,
  );
});

test('errors on a malformed exemptBundles entry', () => {
  const result = collectContextCeilingViolations(
    { ...BASE_CONFIG, exemptBundles: ['bundle-a', 42] },
    [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }],
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /exemptBundles must be an array of non-empty bundle id strings/,
  );
});

test('reflects the live day-one exemptions: exactly the four documented bundles stay green', () => {
  const config = {
    id: 'context-ceiling-128k',
    maxBundleLimitBytes: 120000,
    maxUtilizationPct: 98,
    noticeUtilizationPct: 95,
    exemptBundles: [
      'bundle-review',
      'bundle-work',
      'bundle-merge',
      'bundle-pr-submit-lite',
    ],
  };
  const bundles = [
    { id: 'bundle-discovery', limitBytes: 112700, totalBytes: 107228 },
    { id: 'bundle-resume', limitBytes: 43300, totalBytes: 41109 },
    { id: 'bundle-work', limitBytes: 45000, totalBytes: 44978 },
    { id: 'bundle-work-lite', limitBytes: 24000, totalBytes: 10190 },
    { id: 'bundle-resume-lite', limitBytes: 16000, totalBytes: 15523 },
    { id: 'bundle-claim-lite', limitBytes: 21000, totalBytes: 20233 },
    { id: 'bundle-pre-merge-lite', limitBytes: 16000, totalBytes: 8481 },
    { id: 'bundle-pr-submit-lite', limitBytes: 23700, totalBytes: 23352 },
    { id: 'bundle-review-fix-lite', limitBytes: 21000, totalBytes: 20117 },
    { id: 'bundle-review-snapshot-lite', limitBytes: 13000, totalBytes: 12460 },
    { id: 'bundle-review', limitBytes: 143000, totalBytes: 142980 },
    { id: 'bundle-merge', limitBytes: 116100, totalBytes: 116027 },
  ];
  const result = collectContextCeilingViolations(config, bundles);
  assert.deepEqual(result.errors, []);
});
