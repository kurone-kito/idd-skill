import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditAuthoredIssue } from '../src/scripts/audit-authored-issue.mts';
import {
  isUpstreamEscalationEnabled,
  loadPolicyConfig,
} from '../src/scripts/idd-config.mts';
import { readText } from './test-utils.mts';

// Exercises the composed config-resolution + marker/label-check behavior
// (#2700/#2703) against a synthetic adopter-repository-shaped fixture tree
// (tests/fixtures/upstream-candidate/), modeled on the existing
// tests/fixtures/consistency/placeholders/{dirty,clean} pattern. Runs
// without depending on this repository's own dogfooding state or
// `.github/idd/config.json`: every config/body input is a fixture file
// under this tree, never the live repo config.

function fixturePath(relativeToFixtureRoot: string): string {
  return fileURLToPath(
    new URL(
      `./fixtures/upstream-candidate/${relativeToFixtureRoot}`,
      import.meta.url,
    ),
  );
}

function findingResult(
  report: ReturnType<typeof auditAuthoredIssue>,
  id: string,
): 'pass' | 'fail' {
  const finding = report.findings.find((entry) => entry.id === id);
  assert.ok(finding, `expected a finding with id ${id}`);
  return finding.result;
}

// --- config resolution: fixture .github/idd/config.json -> isUpstreamEscalationEnabled ---

test('a fixture config with upstreamEscalation absent resolves to disabled', () => {
  const { config } = loadPolicyConfig(
    fixturePath('disabled/.github/idd/config.json'),
  );
  assert.equal(isUpstreamEscalationEnabled(config), false);
});

test('a fixture config with upstreamEscalation.enabled: true resolves to enabled', () => {
  const { config } = loadPolicyConfig(
    fixturePath('enabled/.github/idd/config.json'),
  );
  assert.equal(isUpstreamEscalationEnabled(config), true);
});

// --- mechanical marker/label check: fixture issue bodies, all four combinations ---

test('the label-only fixture body fails the upstream-candidate-marker-label check', () => {
  const body = readText(
    'tests/fixtures/upstream-candidate/bodies/label-only.md',
  );
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: ['status:upstream-candidate'],
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'fail',
  );
});

test('the marker-only fixture body fails the upstream-candidate-marker-label check', () => {
  const body = readText(
    'tests/fixtures/upstream-candidate/bodies/marker-only.md',
  );
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: [],
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'fail',
  );
});

test('the both-present fixture body passes the upstream-candidate-marker-label check', () => {
  const body = readText('tests/fixtures/upstream-candidate/bodies/both.md');
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: ['status:upstream-candidate'],
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'pass',
  );
});

test('the neither-present fixture body passes the upstream-candidate-marker-label check', () => {
  const body = readText('tests/fixtures/upstream-candidate/bodies/neither.md');
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: [],
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'pass',
  );
});
