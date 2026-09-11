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

// #2714's fix is deliberately scoped to resolvePresentRunConclusion (the
// no-required-checks fallback), not classifyCiChecks itself, because a
// REQUIRED check that is itself CANCELLED with no successor must not
// silently read as passing. Lock that design intent directly: the
// required-checks status must stay 'unknown', never 'success'.
test('protected branch with a lone CANCELLED required check: status stays unknown, gate does not pass', () => {
  const r = summarize([{ name: 'lint', state: 'CANCELLED' }], protectedRules);
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.status, 'unknown');
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

// #2714: a lone CANCELLED instance with no same-producer successor to dedup
// against is deliberately excluded from both classifyCiChecks's `failed`
// and `passing` buckets, landing in its residual `unknown` bucket. Before
// this fix, resolvePresentRunConclusion folded that `unknown` status into
// 'some-failing' -- reproducing exactly the outcome CANCELLED's exclusion
// from `failed` exists to avoid. A single genuinely-passing companion check
// (`lint`) alongside it rules out a passing-run-count coincidence.
test('unprotected + a lone CANCELLED run with no successor: presentRunConclusion is pending, not some-failing', () => {
  const r = summarize(
    [
      { name: 'lint', state: 'SUCCESS' },
      { name: 'companion', state: 'CANCELLED' },
    ],
    [],
  );
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'pending');
});

// A CANCELLED instance that DOES have a same-producer successor is an
// ordinary, already-handled dedup case (#1471/#1745): selectLatestCheckPerName
// selects the successor, so the CANCELLED instance never reaches the
// `unknown` bucket at all. This must stay 'all-passing', not 'pending' --
// confirms the #2714 fix is scoped to the lone/no-successor shape only.
test('unprotected + a CANCELLED run superseded by a later SUCCESS for the same name: presentRunConclusion is all-passing', () => {
  const r = summarize(
    [
      {
        name: 'build',
        state: 'CANCELLED',
        completedAt: '2026-01-01T00:00:00Z',
      },
      { name: 'build', state: 'SUCCESS', completedAt: '2026-01-01T00:05:00Z' },
    ],
    [],
  );
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'all-passing');
});

// The #2714 fix is scoped to CANCELLED specifically -- an `unknown` bucket
// caused by some other, genuinely unrecognized state string stays
// 'some-failing', the conservative default, rather than being broadened to
// every `unknown` cause.
test('unprotected + an unrecognized non-CANCELLED state: presentRunConclusion stays some-failing', () => {
  const r = summarize(
    [
      { name: 'lint', state: 'SUCCESS' },
      { name: 'companion', state: 'SOME_FUTURE_GITHUB_STATE' },
    ],
    [],
  );
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'some-failing');
});

// A mix of CANCELLED and a genuinely unrecognized state in the `unknown`
// bucket must not be laxly treated as "contains a CANCELLED, so pending" --
// the `.every()` check exists precisely to require the WHOLE bucket be
// CANCELLED before relaxing to 'pending'.
test('unprotected + CANCELLED mixed with an unrecognized state: presentRunConclusion stays some-failing', () => {
  const r = summarize(
    [
      { name: 'lint', state: 'SUCCESS' },
      { name: 'companion-a', state: 'CANCELLED' },
      { name: 'companion-b', state: 'SOME_FUTURE_GITHUB_STATE' },
    ],
    [],
  );
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, 'some-failing');
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

// #1689: a named, present, and pass-equivalent required check whose
// ruleset entry carries an `app_id`/`integration_id` (source-pinned)
// downgrades to `unknown` by default -- this codebase fetches no
// producer-identity data for a live check-run, so it cannot verify the
// pinning -- but the `ciGate.trustSourcePinnedRequiredChecks` opt-in lets
// a repository operator who has verified the pinning out-of-band treat it
// as trusted. Without the opt-in, `isPreMergeCiAllPassing` (protocol-
// helpers.mts) has no passing path at all for this shape; see the
// `sourcePinnedRequiredCheckNames` field this test also locks.
test('a source-pinned but present-and-passing required check downgrades to unknown by default, and the trust opt-in restores success', () => {
  const rules = [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'lint', app_id: 1 }],
      },
    },
  ];
  const untrusted = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
  );
  assert.equal(untrusted.status, 'unknown');
  assert.equal(untrusted.requiredChecksPassing, false);
  assert.deepEqual(untrusted.sourcePinnedRequiredCheckNames, ['lint']);
  assert.equal(untrusted.sourcePinnedUnresolved, false);

  const trusted = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
    {},
    { trustSourcePinnedRequiredChecks: true },
  );
  assert.equal(trusted.status, 'success');
  assert.equal(trusted.requiredChecksPassing, true);
  assert.deepEqual(trusted.sourcePinnedRequiredCheckNames, []);
  assert.equal(trusted.sourcePinnedUnresolved, false);
});

// #1689: a `workflows` rule (no enumerable check name) coexisting with a
// separate, named-and-unpinned required check must still surface
// sourcePinnedUnresolved: true even though sourcePinnedRequiredCheckNames
// is empty -- the two fields are independently meaningful, and a caller
// that only checks the names array would wrongly fall back to a generic
// detail for this shape. The opt-in must not clear it either: there is no
// check name to correlate the workflows-rule pinning with a live run.
test('an unnamed workflows-rule pin coexisting with a named-and-unpinned check reports sourcePinnedUnresolved, and the opt-in does not clear it', () => {
  const rules = [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'lint' }] },
    },
    { type: 'workflows', parameters: {} },
  ];
  const untrusted = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
  );
  assert.equal(untrusted.status, 'unknown');
  assert.equal(untrusted.requiredChecksPassing, false);
  assert.deepEqual(untrusted.sourcePinnedRequiredCheckNames, []);
  assert.equal(untrusted.sourcePinnedUnresolved, true);

  const trusted = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
    {},
    { trustSourcePinnedRequiredChecks: true },
  );
  assert.equal(trusted.status, 'unknown');
  assert.equal(trusted.requiredChecksPassing, false);
  assert.equal(trusted.sourcePinnedUnresolved, true);
});

// The opt-in must not flip a genuinely failing source-pinned required
// check to passing -- it only removes the unconditional downgrade of an
// otherwise-`success` classification, never overrides a real failure.
test('the trust opt-in does not mask a genuinely failing source-pinned required check', () => {
  const rules = [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'lint', app_id: 1 }],
      },
    },
  ];
  const r = summarizeRequiredChecks(
    [{ name: 'lint', state: 'FAILURE' }],
    rules,
    {},
    { trustSourcePinnedRequiredChecks: true },
  );
  assert.equal(r.status, 'failed');
  assert.equal(r.requiredChecksPassing, false);
  assert.deepEqual(r.sourcePinnedRequiredCheckNames, []);
  assert.equal(r.sourcePinnedUnresolved, false);
});

// kurone-kito/idd-skill#2919 (round 3 -- Codex review on PR #2921, P2): a
// required check that is BOTH source-pinned AND identity-unresolved must
// still surface the identity-unresolved evidence even though the source-
// pinned downgrade already changed `status` away from `'success'` first.
// An earlier revision computed `identityUnresolvedRequiredCheckNames` only
// when `status === 'success'` at that point, so this exact shape silently
// lost the identity-unresolved evidence -- the blocker detail would then
// name only the source-pinned cause, and once an operator opted into
// `ciGate.trustSourcePinnedRequiredChecks` to clear THAT cause, a later
// pass would stay blocked with no evidence explaining the real remaining
// reason.
test('a required check that is both source-pinned AND identity-unresolved reports both causes, even after the source-pinned downgrade already changed status', () => {
  const rules = [
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [{ context: 'lint', app_id: 1 }],
      },
    },
  ];
  const r = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
    {},
    { identityUnresolvedCheckNames: ['lint'] },
  );
  assert.equal(r.status, 'unknown');
  assert.equal(r.requiredChecksPassing, false);
  assert.deepEqual(r.sourcePinnedRequiredCheckNames, ['lint']);
  assert.deepEqual(r.identityUnresolvedRequiredCheckNames, ['lint']);

  // Once the operator opts into trusting the pinned source, the
  // source-pinned cause clears -- but the SEPARATE identity-unresolved
  // cause must still keep the gate blocked and still be attributable.
  const trusted = summarizeRequiredChecks(
    [{ name: 'lint', state: 'SUCCESS' }],
    rules,
    {},
    {
      trustSourcePinnedRequiredChecks: true,
      identityUnresolvedCheckNames: ['lint'],
    },
  );
  assert.equal(trusted.status, 'unknown');
  assert.equal(trusted.requiredChecksPassing, false);
  assert.deepEqual(trusted.sourcePinnedRequiredCheckNames, []);
  assert.deepEqual(trusted.identityUnresolvedRequiredCheckNames, ['lint']);
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

// Regression (#1745): live on PR #1741, the F2/F3 authoritative CI read
// reported ci.status: "success" for a HEAD GitHub itself blocked on --
// summarizeRequiredChecks must forward classifyCiChecks's
// discardedNonPassingInstances onto its own discardedNonPassingRequiredChecks
// field (scoped to required checks only) so a 'success' verdict is never
// silently opaque about a discarded non-passing same-name sibling.
test('surfaces a discarded CANCELLED sibling for a required check via discardedNonPassingRequiredChecks', () => {
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'CANCELLED',
        completedAt: '2026-07-18T03:45:56Z',
        type: 'check-run',
        workflowName: 'Lint gate',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-18T03:47:01Z',
        type: 'check-run',
        workflowName: 'Lint gate',
      },
    ],
    protectedRules,
  );
  assert.equal(r.status, 'success');
  assert.equal(r.requiredChecksPassing, true);
  assert.equal(r.discardedNonPassingRequiredChecks.length, 1);
  assert.equal(
    r.discardedNonPassingRequiredChecks[0]?.discardedState,
    'CANCELLED',
  );
  assert.equal(
    r.discardedNonPassingRequiredChecks[0]?.selectedState,
    'SUCCESS',
  );
  assert.equal(r.discardedNonPassingRequiredChecks[0]?.name, 'lint');
});

// Regression (#1753): a Codex review on PR #1749 (#1745's own PR) found
// that summarizeRequiredChecks computed discardedNonPassingRequiredChecks
// from the waiver-adjusted effectiveChecks -- where a waived non-passing
// instance's `state` is rewritten to 'SKIPPED' (pass-equivalent) before
// classifyCiChecks runs -- so a waived CANCELLED sibling silently dropped
// out of this evidence field the moment a maintainer authorized a waiver
// for it. That is exactly the divergence-masking scenario #1745 exists to
// surface. This is a generic waiver + discarded-sibling test using the
// same 'lint' stand-in check name as its neighbors above; the real-world
// motivating check is `idd-advisory-convergence`, which this repo's own
// `.github/idd/config.json` marks waivable, but this fixture does not
// exercise that specific check name/config.
test('discardedNonPassingRequiredChecks still surfaces a waived CANCELLED sibling even though the waiver rewrites it to SKIPPED for status purposes', () => {
  const waivers = {
    valid: [
      {
        authorLogin: 'kurone-kito',
        checkSelector: 'lint',
        reason: 'known-flaky-cancel',
        expiresAt: '2099-01-01T00:00:00Z',
        createdAt: '2026-07-17T00:00:00Z',
      },
    ],
    expired: [],
    wrongHead: [],
    wrongClaim: [],
    unauthorized: [],
    malformed: [],
  };
  const r = summarizeRequiredChecks(
    [
      {
        name: 'lint',
        state: 'CANCELLED',
        completedAt: '2026-07-18T03:45:56Z',
        type: 'check-run',
        workflowName: 'Lint gate',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-18T03:47:01Z',
        type: 'check-run',
        workflowName: 'Lint gate',
      },
    ],
    protectedRules,
    {},
    { waivers },
  );
  // status/requiredChecksPassing must keep honoring the waiver exactly as
  // before this fix -- no regression to existing waiver behavior.
  assert.equal(r.status, 'success');
  assert.equal(r.requiredChecksPassing, true);
  assert.equal(
    r.checks.find((c) => c.state === 'CANCELLED')?.coveredByWaiver,
    true,
  );
  // The discarded CANCELLED sibling must still be visible even though the
  // waiver rewrote its `state` to 'SKIPPED' in the effectiveChecks used by
  // `status` above.
  assert.equal(r.discardedNonPassingRequiredChecks.length, 1);
  assert.equal(
    r.discardedNonPassingRequiredChecks[0]?.discardedState,
    'CANCELLED',
  );
  assert.equal(
    r.discardedNonPassingRequiredChecks[0]?.selectedState,
    'SUCCESS',
  );
  assert.equal(r.discardedNonPassingRequiredChecks[0]?.name, 'lint');
});

test('discardedNonPassingRequiredChecks is empty when nothing was discarded', () => {
  const r = summarize([{ name: 'lint', state: 'SUCCESS' }], protectedRules);
  assert.deepEqual(r.discardedNonPassingRequiredChecks, []);
});

test('discardedNonPassingRequiredChecks is empty when no required checks are configured', () => {
  const r = summarize(
    [
      {
        name: 'build',
        state: 'CANCELLED',
        completedAt: '2026-07-18T03:45:56Z',
        type: 'check-run',
        workflowName: 'Build gate',
      },
      {
        name: 'build',
        state: 'SUCCESS',
        completedAt: '2026-07-18T03:47:01Z',
        type: 'check-run',
        workflowName: 'Build gate',
      },
    ],
    [],
  );
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.deepEqual(r.discardedNonPassingRequiredChecks, []);
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

// #1483: summarizeRequiredChecks must inherit classifyCiChecks's producer-
// identity discriminator, so a required check name is never falsely
// reported as passing because an independently-sourced entry sharing that
// name reported success.
test('protected branch: requiredChecksPassing stays false when a same-named commit-status success cannot supersede the check-run FAILURE (different producers, #1483)', () => {
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'FAILURE',
        completedAt: '2026-07-17T16:00:06Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-17T16:25:47Z',
        type: 'status-context',
        workflowName: '',
      },
    ],
    protectedRules,
  );
  assert.equal(r.requiredChecksPassing, false);
  assert.equal(r.status, 'failed');
});

// #2919: `workflowName` alone is only the workflow YAML's top-level `name:`
// display string, which two DIFFERENT workflow FILES can declare
// identically -- widen the producer key to `(name, type, workflowName,
// workflowPath)` so a decoy check-run sharing every OTHER discriminator can
// no longer mask a genuine same-name FAILURE from a different file.
test('protected branch: requiredChecksPassing stays false when a same-named/type/workflowName check-run success cannot supersede a check-run FAILURE from a DIFFERENT workflow file (#2919)', () => {
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'FAILURE',
        completedAt: '2026-07-17T16:00:06Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
        workflowPath: '.github/workflows/lint.yml',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-17T16:25:47Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
        workflowPath: '.github/workflows/lint-decoy.yml',
      },
    ],
    protectedRules,
  );
  assert.equal(r.requiredChecksPassing, false);
  assert.equal(r.status, 'failed');
});

// #2919 regression guard: a pre-#2919 caller/fixture that never resolves
// `workflowPath` (absent on every entry, exactly like the pre-#1483
// absent-`type`/`workflowName` shape) must keep deduping by
// `(name, type, workflowName)` alone -- this field's addition must never
// change behavior for a caller that doesn't opt in.
test('protected branch: absent workflowPath on both sides still dedupes by name/type/workflowName alone (pre-#2919 shape unaffected)', () => {
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'FAILURE',
        completedAt: '2026-07-17T16:00:06Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-17T16:25:47Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
      },
    ],
    protectedRules,
  );
  assert.equal(r.requiredChecksPassing, true);
  assert.equal(r.status, 'success');
});

// #2919: the actual motivating scenario from this issue's own Background
// (this repository's own `.github/workflows/idd-advisory-convergence.yml`)
// -- two GENUINELY legitimate same-FILE instances (e.g. concurrent
// `pull_request` / `pull_request_target` variants during a migration
// window) share `workflowPath` too, so they must still dedupe as one
// producer, exactly as before this field existed. The issue's own
// Disposition section is explicit that this case is NOT a false-negative
// risk this fix should introduce.
test('protected branch: two same-name/type/workflowName/workflowPath check-run instances (genuine same-file siblings) still dedupe to the latest', () => {
  const r = summarize(
    [
      {
        name: 'lint',
        state: 'CANCELLED',
        completedAt: '2026-07-17T15:59:36Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
        workflowPath: '.github/workflows/lint.yml',
      },
      {
        name: 'lint',
        state: 'SUCCESS',
        completedAt: '2026-07-17T16:25:47Z',
        type: 'check-run',
        workflowName: 'Linting workflow',
        workflowPath: '.github/workflows/lint.yml',
      },
    ],
    protectedRules,
  );
  assert.equal(r.requiredChecksPassing, true);
  assert.equal(r.status, 'success');
});
