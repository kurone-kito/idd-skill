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
