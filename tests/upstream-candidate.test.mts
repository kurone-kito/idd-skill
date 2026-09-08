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
//
// "Composed" here means literal: every auditAuthoredIssue call below
// passes `upstreamEscalationEnabled` derived from a fixture config file
// through `loadPolicyConfig` + `isUpstreamEscalationEnabled` -- not a
// hand-picked literal -- so a regression in either piece (the resolver,
// or the audit's own gating on it) would show up here (#2721 review,
// CodeRabbit).

function fixturePath(relativeToFixtureRoot: string): string {
  return fileURLToPath(
    new URL(
      `./fixtures/upstream-candidate/${relativeToFixtureRoot}`,
      import.meta.url,
    ),
  );
}

function resolveUpstreamEscalationEnabled(
  configRelativeToFixtureRoot: string,
): boolean {
  const { config } = loadPolicyConfig(fixturePath(configRelativeToFixtureRoot));
  return isUpstreamEscalationEnabled(config);
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
  assert.equal(
    resolveUpstreamEscalationEnabled('disabled/.github/idd/config.json'),
    false,
  );
});

test('a fixture config with upstreamEscalation.enabled: true resolves to enabled', () => {
  assert.equal(
    resolveUpstreamEscalationEnabled('enabled/.github/idd/config.json'),
    true,
  );
});

// --- mechanical marker/label check, gated on the resolved config toggle ---
//
// Each test below feeds a fixture config's *resolved* upstreamEscalationEnabled
// value into auditAuthoredIssue, rather than a literal true/false, so the
// config-resolution half and the marker/label-check half are genuinely
// exercised together, not just side-by-side in the same file.

test('with the enabled fixture config, the label-only fixture body fails the upstream-candidate-marker-label check', () => {
  const body = readText(
    'tests/fixtures/upstream-candidate/bodies/label-only.md',
  );
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: ['status:upstream-candidate'],
    upstreamEscalationEnabled: resolveUpstreamEscalationEnabled(
      'enabled/.github/idd/config.json',
    ),
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'fail',
  );
});

test('with the enabled fixture config, the marker-only fixture body fails the upstream-candidate-marker-label check', () => {
  const body = readText(
    'tests/fixtures/upstream-candidate/bodies/marker-only.md',
  );
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: [],
    upstreamEscalationEnabled: resolveUpstreamEscalationEnabled(
      'enabled/.github/idd/config.json',
    ),
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'fail',
  );
});

test('with the enabled fixture config, the both-present fixture body passes the upstream-candidate-marker-label check', () => {
  const body = readText('tests/fixtures/upstream-candidate/bodies/both.md');
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: ['status:upstream-candidate'],
    upstreamEscalationEnabled: resolveUpstreamEscalationEnabled(
      'enabled/.github/idd/config.json',
    ),
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'pass',
  );
});

test('with the enabled fixture config, the neither-present fixture body passes the upstream-candidate-marker-label check', () => {
  const body = readText('tests/fixtures/upstream-candidate/bodies/neither.md');
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: [],
    upstreamEscalationEnabled: resolveUpstreamEscalationEnabled(
      'enabled/.github/idd/config.json',
    ),
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'pass',
  );
});

test('with the disabled fixture config, the same label-only fixture body passes as not applicable (#2700 "no behavior change when disabled")', () => {
  const body = readText(
    'tests/fixtures/upstream-candidate/bodies/label-only.md',
  );
  const report = auditAuthoredIssue(body, {
    shape: 'orphan',
    markerPrefix: 'example-adopter',
    labels: ['status:upstream-candidate'],
    upstreamEscalationEnabled: resolveUpstreamEscalationEnabled(
      'disabled/.github/idd/config.json',
    ),
  });
  assert.equal(
    findingResult(report, 'upstream-candidate-marker-label'),
    'pass',
  );
});
