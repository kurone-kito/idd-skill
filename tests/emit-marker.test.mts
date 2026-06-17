import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseClaimComment,
  parseReviewWatermarkComment,
  renderClaimedByMarker,
  renderReviewBaselineMarker,
  renderReviewWatermarkMarker,
} from '../src/scripts/protocol-helpers.mts';

// A real 40-hex commit SHA — the watermark/claim parsers and the published
// schemas require this exact shape, so the tests must use one.
const SHA = '0123456789abcdef0123456789abcdef01234567';

test('renderClaimedByMarker emits the exact claimed-by body', () => {
  assert.equal(
    renderClaimedByMarker({
      agentId: 'claude-1cab217a',
      claimId: 'abc123',
      supersedes: 'none',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'issue/901-add-foo',
    }),
    '<!-- claimed-by: claude-1cab217a abc123 supersedes: none 2026-06-17T09:47:08Z branch: issue/901-add-foo -->\n\n_claude-1cab217a: issue claim — IDD automation marker. Do not edit._',
  );
});

test('renderClaimedByMarker defaults supersedes to none and carries a takeover id', () => {
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: none /,
  );
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      supersedes: 'prior9',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: prior9 /,
  );
});

test('renderClaimedByMarker normalizes any case-variant of the none sentinel', () => {
  // applyClaimEvent only treats `supersedes === 'none'` (exact lowercase) as a
  // fresh claim, so the renderer must fold case-variants down to lowercase.
  for (const variant of ['None', 'NONE', 'nOnE']) {
    assert.match(
      renderClaimedByMarker({
        agentId: 'a',
        claimId: 'c',
        supersedes: variant,
        timestamp: '2026-06-17T09:47:08Z',
        branch: 'b',
      }),
      /supersedes: none /,
    );
  }
  // a real prior claim id (never a case-variant of none) passes through verbatim
  assert.match(
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      supersedes: 'AbCdEf12',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
    /supersedes: AbCdEf12 /,
  );
});

test('renderReviewWatermarkMarker emits the exact watermark body', () => {
  assert.equal(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      maxActivityAt: '2026-06-17T10:00:00Z',
      totalItemCount: 7,
      ciCompletedAt: '2026-06-17T09:59:00Z',
    }),
    `<!-- review-watermark: a c ${SHA} 2026-06-17T10:00:00Z 7 2026-06-17T09:59:00Z -->\n\n_a: review triage snapshot — IDD automation marker. Do not edit._`,
  );
});

test('renderReviewWatermarkMarker accepts a numeric-string count and defaults none fields', () => {
  assert.equal(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: '0',
    }),
    `<!-- review-watermark: a c ${SHA} none 0 none -->\n\n_a: review triage snapshot — IDD automation marker. Do not edit._`,
  );
});

test('renderReviewWatermarkMarker accepts a count up to the safe-integer max', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.match(
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: max,
    }),
    new RegExp(` ${max} none `),
  );
});

test('renderReviewBaselineMarker emits the exact baseline body', () => {
  assert.equal(
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: SHA }),
    `<!-- review-baseline: a c ${SHA} -->\n\n_a: critique baseline — IDD automation marker. Do not edit._`,
  );
});

test('round-trip: rendered claim and watermark bodies satisfy their own parsers', () => {
  const claimBody = renderClaimedByMarker({
    agentId: 'claude-1cab217a',
    claimId: 'abc123',
    supersedes: 'none',
    timestamp: '2026-06-17T09:47:08Z',
    branch: 'issue/901-add-foo',
  });
  assert.ok(
    parseClaimComment(claimBody, '2026-06-17T09:47:08Z'),
    'claimed-by must round-trip',
  );

  const watermarkBody = renderReviewWatermarkMarker({
    agentId: 'a',
    claimId: 'c',
    headSha: SHA,
    maxActivityAt: '2026-06-17T10:00:00Z',
    totalItemCount: 7,
    ciCompletedAt: '2026-06-17T09:59:00Z',
  });
  assert.ok(
    parseReviewWatermarkComment(watermarkBody, '2026-06-17T10:00:00Z'),
    'review-watermark must round-trip',
  );
});

test('renderers reject payloads that would not round-trip', () => {
  // blank required tokens
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: '',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'b',
    }),
  );
  // fractional-second timestamp (claim parser requires second precision)
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08.123Z',
      branch: 'b',
    }),
  );
  // branch containing `>` (parser/schema forbid it)
  assert.throws(() =>
    renderClaimedByMarker({
      agentId: 'a',
      claimId: 'c',
      timestamp: '2026-06-17T09:47:08Z',
      branch: 'feat/>x',
    }),
  );
  // non-40-hex head SHA (watermark parser requires [0-9a-f]{40})
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: 'deadbeef',
      totalItemCount: 0,
    }),
  );
  // non-ISO activity timestamp
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      maxActivityAt: 'garbage',
      totalItemCount: 0,
    }),
  );
  // non-numeric / negative count
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: 'abc',
    }),
  );
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: -1,
    }),
  );
  // count beyond the safe-integer range (watermark parser reads it back with
  // Number.parseInt; a huge digit string or exponential number cannot round-trip)
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: '99999999999999999999',
    }),
  );
  assert.throws(() =>
    renderReviewWatermarkMarker({
      agentId: 'a',
      claimId: 'c',
      headSha: SHA,
      totalItemCount: 1e21,
    }),
  );
  assert.throws(() =>
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: '' }),
  );
  // non-40-hex baseline SHA (baseline tracks HEAD; must be a real commit SHA)
  assert.throws(() =>
    renderReviewBaselineMarker({ agentId: 'a', claimId: 'c', sha: 'deadbeef' }),
  );
});
