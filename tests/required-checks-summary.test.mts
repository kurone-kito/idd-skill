import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { summarizeRequiredChecks } from '../src/scripts/protocol-helpers.mts';

// A branch ruleset that requires the "lint" status check.
const protectedRules = [
  {
    type: 'required_status_checks',
    parameters: { required_status_checks: [{ context: 'lint' }] },
  },
];

function summarize(
  checks: Parameters<typeof summarizeRequiredChecks>[0],
  rules: Parameters<typeof summarizeRequiredChecks>[1] = [],
) {
  return summarizeRequiredChecks(checks, rules, {});
}

test('protected branch with passing required checks: required gate passes', () => {
  const r = summarize([{ name: 'lint', state: 'SUCCESS' }], protectedRules);
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.requiredChecksPassing, true);
});

test('protected branch with a failing required check: gate does not pass', () => {
  const r = summarize([{ name: 'lint', state: 'FAILURE' }], protectedRules);
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.requiredChecksPassing, false);
});

test('unprotected + green runs: reported distinctly from a passing required gate', () => {
  const r = summarize([{ name: 'build', state: 'SUCCESS' }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.requiredChecksPassing, false);
  assert.equal(r.presentRunConclusion, 'all-passing');
});

test('unprotected + a failing run: presentRunConclusion is some-failing', () => {
  const r = summarize([{ name: 'build', state: 'FAILURE' }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'some-failing');
});

test('unprotected + no runs: presentRunConclusion is none, never vacuously passing', () => {
  const r = summarize([], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'none');
  assert.equal(r.requiredChecksPassing, false);
});

test('unprotected + pending runs: presentRunConclusion is pending', () => {
  const r = summarize([{ name: 'build', state: 'IN_PROGRESS' }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'pending');
});

// A pinned/indeterminate required-check source (workflows rule, or an app-pinned
// classic check with no enumerable context) must NOT be reported as "no required
// checks configured" — there may be required checks we cannot enumerate, so F2
// must stay conservative rather than fall back to verifying raw run conclusions.
test('a workflows-based required-check rule is not treated as no-required-checks', () => {
  const r = summarizeRequiredChecks(
    [],
    [{ type: 'workflows', parameters: {} }],
    {},
  );
  assert.equal(r.noRequiredChecksConfigured, false);
});

test('an app-pinned classic required check with no context is not no-required-checks', () => {
  const r = summarizeRequiredChecks([], [], {
    required_status_checks: { checks: [{ context: '', app_id: 1 }] },
  });
  assert.equal(r.noRequiredChecksConfigured, false);
});

// #1377: a masked-403-as-404 on the branch-protection or ruleset reads must
// not fall through to "no required checks configured" just because the
// (fallback-empty) reads found nothing — that is indistinguishable from a
// genuinely unprotected branch at the response level (see
// idd-ci.instructions.md's Required-check discovery step 4).
test('unprotected + green runs, but the protection/ruleset reads were unreadable: noRequiredChecksConfigured stays false', () => {
  const r = summarizeRequiredChecks(
    [{ name: 'build', state: 'SUCCESS' }],
    [],
    {},
    {
      protectionReadsUnreadable: true,
    },
  );
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.protectionReadsUnreadable, true);
  assert.equal(r.requiredChecksPassing, false);
});

test('a genuinely protected branch reports protectionReadsUnreadable: false even without the option', () => {
  const r = summarize([{ name: 'lint', state: 'SUCCESS' }], protectedRules);
  assert.equal(r.protectionReadsUnreadable, false);
});

// #1471: a stale check-run instance for a name must not falsely block
// pre-merge readiness once a later instance for that same name converged.
test('unprotected: presentRunConclusion reflects the latest instance, not a stale instance sharing its name', () => {
  const r = summarize(
    [
      {
        name: 'idd-advisory-convergence',
        state: 'CANCELLED',
        completedAt: '2026-07-17T15:59:36Z',
      },
      {
        name: 'idd-advisory-convergence',
        state: 'CANCELLED',
        completedAt: '2026-07-17T15:59:51Z',
      },
      {
        name: 'idd-advisory-convergence',
        state: 'FAILURE',
        completedAt: '2026-07-17T16:00:06Z',
      },
      {
        name: 'idd-advisory-convergence',
        state: 'SUCCESS',
        completedAt: '2026-07-17T16:25:47Z',
      },
    ],
    [],
  );
  assert.equal(r.presentRunConclusion, 'all-passing');
});

test('protected branch: requiredChecksPassing is true when the required check’s latest instance succeeded despite older cancelled/failure instances', () => {
  // An end-to-end variant of the PR #1434 / issue #1431 real-world
  // reproduction, exercised here through summarizeRequiredChecks against
  // protectedRules' required 'lint' check (see the exact four-instance
  // idd-advisory-convergence repro, name included, in
  // advisory-wait.test.mts): a stale cancelled/failure rollup superseded
  // by the latest success must not report a false CI blocker once GitHub
  // itself has converged.
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'CANCELLED',
        completedAt: '2026-07-17T15:59:36Z',
      },
      { name: 'lint', state: 'FAILURE', completedAt: '2026-07-17T16:00:06Z' },
      { name: 'lint', state: 'SUCCESS', completedAt: '2026-07-17T16:25:47Z' },
    ],
    protectedRules,
  );
  assert.equal(r.requiredChecksPassing, true);
  assert.equal(r.status, 'success');
});
