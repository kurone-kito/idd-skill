import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseProviderOutageParkComment,
  renderProviderOutageParkComment,
  toSecondPrecisionIso,
} from '../src/scripts/protocol-helpers.mts';
import {
  buildParkedChangeList,
  computeBoundReached,
  PARK_ELIGIBLE_BLOCKER_GATES,
  type RawParkMarker,
  resolveParkEligibility,
} from '../src/scripts/provider-outage-park.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

// ---------------------------------------------------------------------------
// toSecondPrecisionIso -- Copilot review finding (PR #2421): the default
// `now` in runParkPullRequest/buildParkedChangeReport must never carry
// fractional seconds, or renderProviderOutageParkComment's strict
// second-precision check throws on every ordinary --park --apply call. The
// pure function itself is now the shared implementation in
// marker-helpers.mts (#2568); see tests/marker-helpers-timestamp.test.mts
// for direct unit coverage. This test keeps the integration regression.
// ---------------------------------------------------------------------------

test('toSecondPrecisionIso output is accepted by renderProviderOutageParkComment (regression for PR #2421 review finding)', () => {
  const now = toSecondPrecisionIso(new Date('2026-09-02T00:00:00.999Z'));
  assert.doesNotThrow(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'a'.repeat(40),
      claimId: 'claim-1',
      parkedAt: now,
      blockers: ['advisory-wait'],
    }),
  );
});

// ---------------------------------------------------------------------------
// computeBoundReached -- Codex/CodeRabbit review finding (PR #2421): a
// sampled open-PR read must never let an undercounted `count` read as
// "still under the limit".
// ---------------------------------------------------------------------------

test('computeBoundReached: below the limit and not truncated is not reached', () => {
  assert.equal(computeBoundReached(3, 10, false), false);
});

test('computeBoundReached: at or above the limit is reached regardless of truncation', () => {
  assert.equal(computeBoundReached(10, 10, false), true);
  assert.equal(computeBoundReached(15, 10, false), true);
});

test('computeBoundReached: a truncated sample fails closed to reached even when the sampled count is low', () => {
  assert.equal(computeBoundReached(1, 10, true), true);
});

// ---------------------------------------------------------------------------
// resolveParkEligibility (#2321) -- the fail-closed gate
// ---------------------------------------------------------------------------

test('resolveParkEligibility: unavailable verdict with a mapped blocker is eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'advisory-wait',
  ]);
  assert.deepEqual(result, {
    eligible: true,
    reason: 'eligible',
    unmappedBlockers: [],
  });
});

test('resolveParkEligibility: an empty blocker list is never eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', []);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'no-blockers');
});

test('resolveParkEligibility: one unmapped gate refuses the whole request', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'advisory-wait',
    'review-currency',
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unmapped-blocker');
  assert.deepEqual(result.unmappedBlockers, ['review-currency']);
});

test('resolveParkEligibility: a blocker that maps to the OTHER service is not eligible', () => {
  const result = resolveParkEligibility('advisory-review', 'unavailable', [
    'ci',
  ]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'unmapped-blocker');
  assert.deepEqual(result.unmappedBlockers, ['ci']);
});

test('resolveParkEligibility: degraded/unknown/healthy verdicts are never eligible even with mapped blockers', () => {
  for (const verdict of ['degraded', 'unknown', 'healthy']) {
    const result = resolveParkEligibility('advisory-review', verdict, [
      'advisory-wait',
    ]);
    assert.equal(result.eligible, false, `verdict ${verdict} must not park`);
    assert.equal(result.reason, 'verdict-not-unavailable');
  }
});

test('resolveParkEligibility: ci-actions maps to ci and discarded-required-check-siblings only', () => {
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', ['ci']).eligible,
    true,
  );
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', [
      'discarded-required-check-siblings',
    ]).eligible,
    true,
  );
  assert.equal(
    resolveParkEligibility('ci-actions', 'unavailable', ['advisory-wait'])
      .eligible,
    false,
  );
});

test('PARK_ELIGIBLE_BLOCKER_GATES: never includes review-currency or disposition-evidence for either service', () => {
  for (const gates of Object.values(PARK_ELIGIBLE_BLOCKER_GATES)) {
    assert.equal(gates.has('review-currency'), false);
    assert.equal(gates.has('disposition-evidence'), false);
  }
});

// ---------------------------------------------------------------------------
// buildParkedChangeList (#2321) -- deterministic ordering, resumability
// ---------------------------------------------------------------------------

function rawMarker(
  overrides: Partial<RawParkMarker['marker']> = {},
): RawParkMarker['marker'] {
  return {
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait'],
    createdAt: 'none',
    ...overrides,
  };
}

test('buildParkedChangeList: sorted by parkedAt, earliest first', () => {
  const { entries } = buildParkedChangeList(
    [
      { prNumber: 10, marker: rawMarker({ parkedAt: '2026-09-02T12:00:00Z' }) },
      { prNumber: 20, marker: rawMarker({ parkedAt: '2026-09-01T00:00:00Z' }) },
    ],
    new Map([['advisory-review', 'unavailable']]),
  );
  assert.deepEqual(
    entries.map((e) => e.prNumber),
    [20, 10],
  );
});

test('buildParkedChangeList: same parkedAt breaks the tie by pull request number', () => {
  const { entries } = buildParkedChangeList(
    [
      { prNumber: 30, marker: rawMarker({ parkedAt: '2026-09-02T00:00:00Z' }) },
      { prNumber: 15, marker: rawMarker({ parkedAt: '2026-09-02T00:00:00Z' }) },
    ],
    new Map([['advisory-review', 'unavailable']]),
  );
  assert.deepEqual(
    entries.map((e) => e.prNumber),
    [15, 30],
  );
});

test('buildParkedChangeList: resumable only once the live verdict is healthy', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'healthy']]),
  );
  assert.equal(entries[0].resumable, true);
  assert.equal(entries[0].verdict, 'healthy');

  const stillParked = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map([['advisory-review', 'degraded']]),
  );
  assert.equal(stillParked.entries[0].resumable, false);
});

test('buildParkedChangeList: a service with no live verdict entry reports unknown, not resumable', () => {
  const { entries } = buildParkedChangeList(
    [{ prNumber: 1, marker: rawMarker() }],
    new Map(),
  );
  assert.equal(entries[0].verdict, 'unknown');
  assert.equal(entries[0].resumable, false);
});

test('buildParkedChangeList: count matches the entry count', () => {
  const { entries, count } = buildParkedChangeList(
    [
      { prNumber: 1, marker: rawMarker() },
      { prNumber: 2, marker: rawMarker() },
      { prNumber: 3, marker: rawMarker() },
    ],
    new Map(),
  );
  assert.equal(count, 3);
  assert.equal(entries.length, 3);
});

// ---------------------------------------------------------------------------
// Marker render/parse round-trip
// ---------------------------------------------------------------------------

test('renderProviderOutageParkComment / parseProviderOutageParkComment round-trip', () => {
  const body = renderProviderOutageParkComment({
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'b'.repeat(40),
    claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait', 'copilot-terminal-unavailable'],
  });
  const parsed = parseProviderOutageParkComment(body, '2026-09-02T00:00:05Z');
  assert.deepEqual(parsed, {
    actor: 'claude-29738796',
    issueNumber: 2321,
    service: 'advisory-review',
    headSha: 'b'.repeat(40),
    claimId: 'f22dd6db-83f8-4e92-aaa9-23db47d10650',
    parkedAt: '2026-09-02T00:00:00Z',
    blockers: ['advisory-wait', 'copilot-terminal-unavailable'],
    createdAt: '2026-09-02T00:00:05Z',
  });
});

test('renderProviderOutageParkComment: rejects a malformed payload', () => {
  assert.throws(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'not-40-hex',
      claimId: 'claim-1',
      parkedAt: '2026-09-02T00:00:00Z',
      blockers: ['advisory-wait'],
    }),
  );
});

test('renderProviderOutageParkComment: rejects an empty blockers list (the issue AC requires naming the blocking evidence)', () => {
  assert.throws(() =>
    renderProviderOutageParkComment({
      actor: 'claude-29738796',
      issueNumber: 2321,
      service: 'advisory-review',
      headSha: 'a'.repeat(40),
      claimId: 'claim-1',
      parkedAt: '2026-09-02T00:00:00Z',
      blockers: [],
    }),
  );
});

test('parseProviderOutageParkComment: an ordinary comment is not a park marker', () => {
  assert.equal(
    parseProviderOutageParkComment(
      'just a regular PR comment',
      '2026-09-02T00:00:00Z',
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test('committed provider-outage-park fixture validates against its schema', () => {
  const schema = loadJson('schemas/provider-outage-park.schema.json');
  const fixture = JSON.parse(
    readFileSync('fixtures/schemas/provider-outage-park.valid.json', 'utf8'),
  );
  const errors = validate(fixture, schema);
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// Never a merge-readiness/CI-gate result, never thread/gate/merge mutation
// ---------------------------------------------------------------------------

test('provider-outage-park.mts never generates a raw new Date().toISOString() default (regression for PR #2421 review finding)', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  assert.ok(
    !source.includes('new Date().toISOString()'),
    'every default `now` must go through toSecondPrecisionIso, never a raw millisecond-precision Date#toISOString()',
  );
});

test('provider-outage-park.mts sorts the open pull request sample by most-recently-updated (regression for PR #2421 review finding)', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  assert.ok(
    source.includes('sort=updated&direction=desc'),
    'the open pull request list read must sort by updated/desc to match the "most-recently-updated" contract its own docstring claims',
  );
});

test('provider-outage-park.mts never imports thread-resolution, merge-execution, or pre-merge-readiness mutation modules', () => {
  const source = readFileSync('src/scripts/provider-outage-park.mts', 'utf8');
  for (const forbidden of [
    'resolve-review-thread.mts',
    'idd-merge-execute.mts',
  ]) {
    assert.ok(
      !source.includes(forbidden),
      `provider-outage-park.mts must not import ${forbidden} -- parking never resolves a thread, satisfies a gate, or merges`,
    );
  }
});
