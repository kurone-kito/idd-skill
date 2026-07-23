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

test('errors when exemptBundles is present but not an array', () => {
  const result = collectContextCeilingViolations(
    { ...BASE_CONFIG, exemptBundles: 'bundle-a' },
    [{ id: 'bundle-a', limitBytes: 1000, totalBytes: 500 }],
  );
  assert.equal(result.errors.length, 1);
  assert.match(
    result.errors[0],
    /exemptBundles must be an array of bundle id strings/,
  );
});

test('a bundle with a zero-byte limitBytes never gets a spurious notice', () => {
  // Regression: the notice comparison's RHS (limitBytes * pct) is 0 when
  // limitBytes is 0, so an unguarded ">=" would fire unconditionally,
  // including for a bundle with zero content.
  const bundles = [{ id: 'bundle-a', limitBytes: 0, totalBytes: 0 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.deepEqual(result.notices, []);
});

test('a zero-byte limitBytes with content reports the error without a misleading percentage', () => {
  // Regression: utilizationPct is forced to 0 for display when limitBytes
  // is 0, which previously made the error string read "utilization
  // 0.00% exceeds 98%" even though the bundle is effectively unbounded.
  const bundles = [{ id: 'bundle-a', limitBytes: 0, totalBytes: 1 }];
  const result = collectContextCeilingViolations(BASE_CONFIG, bundles);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /unbounded \(zero-byte limit\)/);
  assert.doesNotMatch(result.errors[0], /0\.00%/);
});

test('an exemptBundles list only silences the named violators, not the rest', () => {
  // Synthetic fixture (not live repo byte totals, which would make this
  // test churn on unrelated content edits): every id in exemptBundles
  // is crafted to violate one or both checks; every other id is crafted
  // to stay well within both, mirroring the day-one exemption shape
  // documented in audit/sync-manifest.json without depending on it.
  const config = {
    id: 'context-ceiling-128k',
    maxBundleLimitBytes: 120000,
    maxUtilizationPct: 98,
    noticeUtilizationPct: 95,
    exemptBundles: [
      'exempt-over-ceiling',
      'exempt-over-utilization',
      'exempt-over-both',
    ],
  };
  const bundles = [
    { id: 'safe-a', limitBytes: 45000, totalBytes: 30000 },
    { id: 'safe-b', limitBytes: 23700, totalBytes: 15000 },
    { id: 'exempt-over-ceiling', limitBytes: 130000, totalBytes: 1000 },
    { id: 'exempt-over-utilization', limitBytes: 1000, totalBytes: 999 },
    { id: 'exempt-over-both', limitBytes: 143000, totalBytes: 142980 },
  ];
  const result = collectContextCeilingViolations(config, bundles);
  assert.deepEqual(result.errors, []);
});
