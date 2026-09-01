import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyProviderHealth,
  type ProviderHealthSnapshot,
} from '../src/scripts/provider-health.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const NOW = '2026-09-01T00:00:00Z';
const POLICY = { minCorroboratingPrs: 2 };

function snapshot(
  overrides: Partial<ProviderHealthSnapshot> = {},
): ProviderHealthSnapshot {
  return {
    service: 'advisory-review',
    now: NOW,
    contradictory: false,
    unreadable: false,
    observations: [],
    ...overrides,
  };
}

test('healthy: zero failure observations', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'success' },
        { prNumber: 2, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'healthy');
  assert.equal(result.reason, 'all-healthy');
  assert.equal(result.distinctFailingPrCount, 0);
  assert.equal(result.distinctSuccessPrCount, 2);
});

test('degraded: a single pull request failure burst never resolves stronger than degraded', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.reason, 'failure-below-corroboration-threshold');
  assert.equal(result.distinctFailingPrCount, 1);
});

test('degraded: corroborated failures alongside surviving successes stay degraded, not unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.reason, 'mixed-evidence-with-corroboration');
  assert.equal(result.distinctFailingPrCount, 2);
  assert.equal(result.distinctSuccessPrCount, 1);
});

test('unavailable: failure corroborated across the threshold with zero successes', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unavailable');
  assert.equal(result.reason, 'full-failure-with-corroboration');
  assert.equal(result.distinctFailingPrCount, 3);
  assert.equal(result.distinctSuccessPrCount, 0);
});

test('unknown: unreadable evidence never resolves to unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      unreadable: true,
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'evidence-unreadable');
});

test('unknown: contradictory evidence is an explicit signal, not derived from a success/failure vote', () => {
  const result = classifyProviderHealth(
    snapshot({
      contradictory: true,
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'success' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'contradictory-evidence');
});

test('unknown: no observations at all is insufficient evidence, not healthy', () => {
  const result = classifyProviderHealth(snapshot(), POLICY);
  assert.equal(result.verdict, 'unknown');
  assert.equal(result.reason, 'no-evidence');
});

test('ci-actions service: same classifier, same verdict shape', () => {
  const result = classifyProviderHealth(
    snapshot({
      service: 'ci-actions',
      observations: [
        { prNumber: 10, outcome: 'failure' },
        { prNumber: 11, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.service, 'ci-actions');
  assert.equal(result.verdict, 'unavailable');
});

test('corroboration threshold is configurable: a higher minCorroboratingPrs keeps more failure below unavailable', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 3, outcome: 'failure' },
      ],
    }),
    { minCorroboratingPrs: 5 },
  );
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.minCorroboratingPrs, 5);
});

test('a repeated observation for the same PR counts once toward corroboration', () => {
  const result = classifyProviderHealth(
    snapshot({
      observations: [
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 1, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
        { prNumber: 2, outcome: 'failure' },
      ],
    }),
    POLICY,
  );
  assert.equal(result.distinctFailingPrCount, 2);
  assert.equal(result.verdict, 'unavailable');
});

test('committed provider-health fixture validates against its schema', () => {
  const schema = loadJson('schemas/provider-health.schema.json');
  const fixture = loadJson('fixtures/schemas/provider-health.valid.json');
  assert.deepEqual(validate(fixture, schema), []);
});

test('a classifier result for each service round-trips through the report schema shape', () => {
  const advisoryReview = classifyProviderHealth(
    snapshot({
      observations: [{ prNumber: 1, outcome: 'success' }],
    }),
    POLICY,
  );
  const ciActions = classifyProviderHealth(
    snapshot({ service: 'ci-actions' }),
    POLICY,
  );
  const report = {
    protocolVersion: '1',
    now: NOW,
    services: {
      'advisory-review': advisoryReview,
      'ci-actions': ciActions,
    },
  };
  const fullSchema = loadJson('schemas/provider-health.schema.json');
  assert.deepEqual(validate(report, fullSchema), []);
});
