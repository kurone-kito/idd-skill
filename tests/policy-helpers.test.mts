import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getReviewEscalationChangesRequestedPolicy,
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
  selectDesyncedIndex,
} from '../src/scripts/policy-helpers.mts';

test('issueScope defaults to roadmap-first and accepts all values', () => {
  assert.equal(POLICY_DEFAULTS.issueScope, 'roadmap-first');
  assert.equal(normalizePolicyConfig({}).issueScope, 'roadmap-first');
  assert.equal(
    normalizePolicyConfig({ issueScope: 'roadmap' }).issueScope,
    'roadmap',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'roadmap-first' }).issueScope,
    'roadmap-first',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'orphan-first' }).issueScope,
    'orphan-first',
  );
  assert.equal(
    normalizePolicyConfig({ issueScope: 'bogus' }).issueScope,
    'roadmap-first',
  );
});

test('POLICY_DEFAULTS.labels exposes the three reserved label name defaults', () => {
  // Additive only (#1272): POLICY_DEFAULTS carries the literal defaults,
  // and normalizePolicyConfig normalizes this namespace too (for shape
  // parity — see its labels branch), but no consuming helper outside
  // policy-helpers.mts reads it yet. Wiring the discover/claim/
  // roadmap-audit label lookups to it is deferred to the follow-up
  // (#1273).
  assert.deepEqual(POLICY_DEFAULTS.labels, {
    roadmapLabelName: 'roadmap',
    blockedByHumanLabelName: 'status:blocked-by-human',
    needsDecisionLabelName: 'status:needs-decision',
  });
});

test('claimTiming.staleAge defaults to PT24H and accepts a configured override', () => {
  // #1310: the canonical single parse point for claimTiming.staleAge, so
  // write-gate callers read it here instead of hand-rolling
  // `config?.claimTiming?.staleAge` access.
  assert.equal(POLICY_DEFAULTS.claimTiming.staleAge, 'PT24H');
  assert.equal(normalizePolicyConfig({}).claimTiming.staleAge, 'PT24H');
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'PT18H' } }).claimTiming
      .staleAge,
    'PT18H',
  );
  // Malformed or non-positive values fall back to the 24h default.
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'not-a-duration' } })
      .claimTiming.staleAge,
    'PT24H',
  );
  assert.equal(
    normalizePolicyConfig({ claimTiming: { staleAge: 'PT0S' } }).claimTiming
      .staleAge,
    'PT24H',
  );
});

test('ciWait.rerunPolicy defaults to rerun-once and accepts hold', () => {
  // #1359: CI_RERUN_POLICIES previously only accepted 'rerun-once',
  // silently downgrading a configured 'hold' — the schema and
  // ci-wait-policy.mts's own RERUN_POLICIES both accept 'hold'.
  assert.equal(POLICY_DEFAULTS.ciWait.rerunPolicy, 'rerun-once');
  assert.equal(normalizePolicyConfig({}).ciWait.rerunPolicy, 'rerun-once');
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'hold' } }).ciWait
      .rerunPolicy,
    'hold',
  );
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'rerun-once' } }).ciWait
      .rerunPolicy,
    'rerun-once',
  );
  // An unrecognized value still falls back to the default.
  assert.equal(
    normalizePolicyConfig({ ciWait: { rerunPolicy: 'rerun-forever' } }).ciWait
      .rerunPolicy,
    'rerun-once',
  );
});

test('parseIsoDurationToMs parses supported ISO durations', () => {
  assert.equal(parseIsoDurationToMs('PT5S'), 5000);
  assert.equal(parseIsoDurationToMs('PT2H'), 2 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs('P1DT2H'), 26 * 60 * 60 * 1000);
  assert.equal(parseIsoDurationToMs('PT0S'), null);
  assert.equal(parseIsoDurationToMs('invalid'), null);
});

test('changes-requested escalation policy keeps 24h + 24h default windows', () => {
  assert.deepEqual(getReviewEscalationChangesRequestedPolicy({}), {
    escalateAfterMs: 24 * 60 * 60 * 1000,
    releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
  });
});

test('changes-requested escalation overrides map first/second thresholds to two windows', () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT2H',
        changesRequestedSecondEscalation: 'PT6H',
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 4 * 60 * 60 * 1000,
    },
  );
});

test('changes-requested escalation falls back when second threshold is invalid', () => {
  assert.deepEqual(
    getReviewEscalationChangesRequestedPolicy({
      reviewEscalation: {
        changesRequestedFirstEscalation: 'PT2H',
        changesRequestedSecondEscalation: 'PT1H',
      },
    }),
    {
      escalateAfterMs: 2 * 60 * 60 * 1000,
      releaseAfterEscalationMs: 24 * 60 * 60 * 1000,
    },
  );
});

test('discover.selectionDesync defaults to off and accepts session-offset', () => {
  assert.equal(POLICY_DEFAULTS.discover.selectionDesync, 'off');
  assert.equal(normalizePolicyConfig({}).discover.selectionDesync, 'off');
  assert.equal(
    normalizePolicyConfig({ discover: { selectionDesync: 'session-offset' } })
      .discover.selectionDesync,
    'session-offset',
  );
  // Unknown value falls back to the default.
  assert.equal(
    normalizePolicyConfig({ discover: { selectionDesync: 'random' } }).discover
      .selectionDesync,
    'off',
  );
});

test('discover.legacyRoots defaults to [] and accepts a valid issue-number array', () => {
  assert.deepEqual(POLICY_DEFAULTS.discover.legacyRoots, []);
  assert.deepEqual(normalizePolicyConfig({}).discover.legacyRoots, []);
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [12, 7, 99] } }).discover
      .legacyRoots,
    [12, 7, 99],
  );
});

test('discover.legacyRoots fails safe to [] on invalid input', () => {
  // Non-array, empty array, and an out-of-range/non-integer entry all fall
  // back to the default `[]` — the whole array is rejected rather than
  // silently dropping just the bad entry, so a typo'd issue number cannot
  // vanish unnoticed.
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: 'not-an-array' } })
      .discover.legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, 0] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, 1.5] } }).discover
      .legacyRoots,
    [],
  );
  assert.deepEqual(
    normalizePolicyConfig({ discover: { legacyRoots: [1, '2'] } }).discover
      .legacyRoots,
    [],
  );
});

test('selectDesyncedIndex returns 0 for empty, singleton, or invalid bands', () => {
  assert.equal(selectDesyncedIndex('any-token', 0), 0);
  assert.equal(selectDesyncedIndex('any-token', 1), 0);
  assert.equal(selectDesyncedIndex('any-token', -3), 0);
  assert.equal(selectDesyncedIndex('any-token', 2.5), 0);
  assert.equal(selectDesyncedIndex('any-token', 'x'), 0);
});

test('selectDesyncedIndex returns 0 for a non-string or empty token', () => {
  assert.equal(selectDesyncedIndex('', 4), 0);
  assert.equal(selectDesyncedIndex(null, 4), 0);
  assert.equal(selectDesyncedIndex(undefined, 4), 0);
  assert.equal(selectDesyncedIndex(42, 4), 0);
});

test('selectDesyncedIndex is deterministic and stays within the band', () => {
  const bandSize = 5;
  // Same token always maps to the same index.
  assert.equal(
    selectDesyncedIndex('claude-82e2247e', bandSize),
    selectDesyncedIndex('claude-82e2247e', bandSize),
  );
  // Every result is a valid in-band index.
  for (const token of ['a', 'session-1', 'claude-5bee6c1b', 'zzz', '0xdead']) {
    const index = selectDesyncedIndex(token, bandSize);
    assert.ok(
      Number.isInteger(index) && index >= 0 && index < bandSize,
      `index ${index} out of band for ${token}`,
    );
  }
});

test('selectDesyncedIndex spreads distinct session tokens across the band', () => {
  const bandSize = 4;
  // A spread of distinct tokens should not all collapse to a single index;
  // distinct sessions must be able to land on different band offsets.
  const tokens = Array.from({ length: 24 }, (_, i) => `session-token-${i}`);
  const indices = new Set(tokens.map((t) => selectDesyncedIndex(t, bandSize)));
  assert.ok(
    indices.size > 1,
    `expected distinct tokens to spread across the band, got ${[...indices]}`,
  );
});
