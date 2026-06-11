import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  getReviewEscalationChangesRequestedPolicy,
  normalizePolicyConfig,
  POLICY_DEFAULTS,
  parseIsoDurationToMs,
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
