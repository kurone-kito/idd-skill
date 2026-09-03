import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES,
  DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  readAdvisoryConvergenceDeadlineMinutes,
  readAdvisoryPrimaryBotLogin,
  readAdvisoryRecoveryCycleCap,
  readAdvisorySecondaryBotLogin,
  readAdvisorySecondaryQuietWindowMinutes,
  readAdvisoryTerminalWindowMinutes,
  readAdvisoryWaitPolicy,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisoryRecoveryCycleCap,
  resolveAdvisorySecondaryBotLogin,
  resolveAdvisorySecondaryQuietWindowMinutes,
  resolveAdvisoryTerminalWindowMinutes,
  resolveAdvisoryWaitPolicy,
  resolveEffectiveAdvisoryTerminalWindowMinutes,
  resolveProviderOutageTerminalWindowMinutes,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  buildAdvisoryWaitSummary,
  classifyCiChecks,
  computeSecondaryRequestedForHead,
  isCopilotReviewerLogin,
  operationalMarkerPrefix,
  resolveCopilotPending,
  unsafeTextReason,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { readJson } from './test-utils.mts';

const ciSuccess = readJson('fixtures/ci/success.json');
const ciPending = readJson('fixtures/ci/pending.json');
const ciFailed = readJson('fixtures/ci/failed.json');
const ciMixed = readJson('fixtures/ci/mixed.json');
const ciSkippedNeutral = readJson('fixtures/ci/skipped-neutral.json');
const advisoryWaitSchema = loadJson('schemas/advisory-wait-state.schema.json');

test('classifies CI check states for advisory wait decisions', () => {
  assert.equal(classifyCiChecks(ciSuccess).status, 'success');
  assert.equal(classifyCiChecks(ciPending).status, 'pending');
  assert.equal(classifyCiChecks(ciFailed).status, 'failed');
  assert.equal(classifyCiChecks(ciMixed).status, 'unknown');
  assert.equal(classifyCiChecks(ciSkippedNeutral).status, 'success');
});

// #1471: `classifyCiChecks` must dedupe multiple check-run instances that
// share the same `name` down to the latest one before classifying, instead
// of letting a stale instance for that name outvote the current one.
test('classifyCiChecks: a stale cancelled-only instance is superseded by a later success for the same name', () => {
  // Without dedup this shape misclassifies as 'unknown' (the stale
  // CANCELLED instance is neither failing nor passing on its own), not
  // 'failed' — a distinct branch from the FAILURE-triggered repro below.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'CANCELLED',
      completedAt: '2026-07-17T15:59:36Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:25:47Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('classifyCiChecks: a genuinely failing latest instance still fails despite older passing instances', () => {
  // Guards against an over-broad fix that ignores any failure anywhere in
  // the list — this must stay 'failed' because the latest instance for the
  // name is the one that failed.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T15:00:00Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T15:30:00Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'FAILURE',
      completedAt: '2026-07-17T16:00:00Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'failed');
});

test('classifyCiChecks: PR #1434 four-instance repro (2 cancelled, 1 failure, 1 success) classifies success', () => {
  const checks = [
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
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('classifyCiChecks: an in-progress rerun is not shadowed by an older completed success for the same name', () => {
  // The mirror-image failure mode: a live rerun (no completedAt yet) must
  // win over a stale completed SUCCESS for the same name, matching
  // GitHub's own semantics where an in-progress required check leaves the
  // branch not-clean rather than falling back to an old passing verdict.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:00:06Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'IN_PROGRESS',
      completedAt: null,
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'pending');
});

test('classifyCiChecks: a same-instant failure/success tie for one name still fails, regardless of input order', () => {
  // A tie must never resolve by raw input array order — two independent
  // runs can genuinely complete within the same recorded second, and this
  // dedup must never let ordering happenstance hide a real failure behind
  // a same-instant success.
  const tiedAt = '2026-07-17T16:00:06Z';
  const failureFirst = [
    { name: 'flaky', state: 'FAILURE', completedAt: tiedAt },
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
  ];
  const successFirst = [
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
    { name: 'flaky', state: 'FAILURE', completedAt: tiedAt },
  ];
  assert.equal(classifyCiChecks(failureFirst).status, 'failed');
  assert.equal(classifyCiChecks(successFirst).status, 'failed');
});

test('classifyCiChecks: a same-instant cancelled/success tie for one name prefers success, regardless of input order', () => {
  const tiedAt = '2026-07-17T16:00:06Z';
  const cancelledFirst = [
    { name: 'flaky', state: 'CANCELLED', completedAt: tiedAt },
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
  ];
  const successFirst = [
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
    { name: 'flaky', state: 'CANCELLED', completedAt: tiedAt },
  ];
  assert.equal(classifyCiChecks(cancelledFirst).status, 'success');
  assert.equal(classifyCiChecks(successFirst).status, 'success');
});

// #1688: ciStateTieRank previously ranked only the literal 'FAILURE'
// conclusion at 0; TIMED_OUT (and the other failure-family conclusions
// below) shared the generic rank-1 bucket with SUCCESS, so a same-instant
// tie fell back to lexicographic string comparison -- and 'SUCCESS' <
// 'TIMED_OUT', so SUCCESS won. This is the issue's own reproduction.
test('classifyCiChecks: #1688 repro -- a same-instant SUCCESS/TIMED_OUT tie now reports failed, not success', () => {
  const tiedAt = '2026-07-17T16:00:06Z';
  const timedOutFirst = [
    { name: 'lint', state: 'TIMED_OUT', completedAt: tiedAt },
    { name: 'lint', state: 'SUCCESS', completedAt: tiedAt },
  ];
  const successFirst = [
    { name: 'lint', state: 'SUCCESS', completedAt: tiedAt },
    { name: 'lint', state: 'TIMED_OUT', completedAt: tiedAt },
  ];
  assert.equal(classifyCiChecks(timedOutFirst).status, 'failed');
  assert.equal(classifyCiChecks(successFirst).status, 'failed');
});

// Note on test teeth: TIMED_OUT is the only state in this loop where the
// rank-0 promotion actually flips the tie's outcome pre- vs. post-#1688 --
// ACTION_REQUIRED/ERROR/STALE/STARTUP_FAILURE already happened to win a
// same-instant tie against every SUCCESS-family state pre-fix, purely by
// lexicographic accident (each starts with a letter earlier than 'S'/'N').
// This loop still asserts all five deliberately, as a regression guard
// against a future SUCCESS-family addition ever breaking that alphabetical
// happenstance (matching the equivalent ACTION_REQUIRED comment in
// tests/ci-wait-state.test.mts); the "sole, non-tied" test below is what
// actually exercises the classifyCiChecks vocabulary-widening fix for the
// four non-TIMED_OUT states.
test('classifyCiChecks: a same-instant tie against SUCCESS now reports failed for every newly-ranked failure-family state', () => {
  const tiedAt = '2026-07-17T16:00:06Z';
  for (const failureState of [
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
    'ERROR',
  ]) {
    const failureFirst = [
      { name: 'gated', state: failureState, completedAt: tiedAt },
      { name: 'gated', state: 'SUCCESS', completedAt: tiedAt },
    ];
    const successFirst = [
      { name: 'gated', state: 'SUCCESS', completedAt: tiedAt },
      { name: 'gated', state: failureState, completedAt: tiedAt },
    ];
    assert.equal(
      classifyCiChecks(failureFirst).status,
      'failed',
      `expected a same-instant ${failureState} vs SUCCESS tie to report failed (failure-first order)`,
    );
    assert.equal(
      classifyCiChecks(successFirst).status,
      'failed',
      `expected a same-instant ${failureState} vs SUCCESS tie to report failed (success-first order)`,
    );
  }
});

test('classifyCiChecks: a sole, non-tied failure-family conclusion classifies as failed, not unknown', () => {
  // Distinct from the tie-break fix above: even with only one instance (no
  // competing SUCCESS at all), TIMED_OUT/ACTION_REQUIRED/STARTUP_FAILURE/
  // STALE/ERROR previously fell into 'unknown' because only the literal
  // 'FAILURE' string matched classifyCiChecks's `failed` filter -- the
  // "vocabulary drift" #1688 also fixes, independent of the tie-break path.
  for (const failureState of [
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
    'ERROR',
  ]) {
    const checks = [
      {
        name: 'gated',
        state: failureState,
        completedAt: '2026-07-17T16:00:06Z',
      },
    ];
    assert.equal(
      classifyCiChecks(checks).status,
      'failed',
      `expected a sole ${failureState} conclusion to classify as failed`,
    );
  }
});

test('classifyCiChecks: CANCELLED alone still classifies as unknown, not failed (deliberate carve-out, unchanged)', () => {
  // CANCELLED is deliberately excluded from CI_FAILURE_CONCLUSION_STATES: a
  // cancelled run reached no real verdict, unlike the concrete failure
  // conclusions above. This guards the existing `ciMixed` fixture behavior
  // (see "classifies CI check states for advisory wait decisions" above)
  // against a future over-broad widening.
  const checks = [
    { name: 'gated', state: 'CANCELLED', completedAt: '2026-07-17T16:00:06Z' },
  ];
  assert.equal(classifyCiChecks(checks).status, 'unknown');
});

test('classifyCiChecks: a same-instant tie between two non-failure/non-cancelled states is deterministic regardless of input order', () => {
  // PR review finding: the reducer previously kept whichever instance
  // was listed first for any tie not involving FAILURE or CANCELLED
  // (e.g. SUCCESS vs NEUTRAL), so input order still mattered even
  // though it never flipped `.status` for this particular pairing (both
  // are pass-equivalent). Assert full order-independence anyway, since
  // a future passing-vs-non-passing tie (e.g. SUCCESS vs ACTION_REQUIRED)
  // would otherwise inherit the same order dependence and could flip
  // `.status`.
  const tiedAt = '2026-07-17T16:00:06Z';
  const successFirst = [
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
    { name: 'flaky', state: 'NEUTRAL', completedAt: tiedAt },
  ];
  const neutralFirst = [
    { name: 'flaky', state: 'NEUTRAL', completedAt: tiedAt },
    { name: 'flaky', state: 'SUCCESS', completedAt: tiedAt },
  ];
  assert.equal(classifyCiChecks(successFirst).status, 'success');
  assert.equal(classifyCiChecks(neutralFirst).status, 'success');
  const successAndActionRequiredFirst = [
    { name: 'gated', state: 'SUCCESS', completedAt: tiedAt },
    { name: 'gated', state: 'ACTION_REQUIRED', completedAt: tiedAt },
  ];
  const actionRequiredFirst = [
    { name: 'gated', state: 'ACTION_REQUIRED', completedAt: tiedAt },
    { name: 'gated', state: 'SUCCESS', completedAt: tiedAt },
  ];
  assert.equal(
    classifyCiChecks(successAndActionRequiredFirst).status,
    classifyCiChecks(actionRequiredFirst).status,
  );
});

test('classifyCiChecks: a pending rerun carrying the zero-value completedAt sentinel is not shadowed by a stale success', () => {
  // PR review finding (P1): gh pr checks (and similar API surfaces)
  // report `0001-01-01T00:00:00Z` -- Go's zero Time value -- as
  // `completedAt` for a check that has not actually completed, rather
  // than omitting the field. That string is a syntactically valid ISO
  // timestamp, so treating validity alone as "has this check completed"
  // let a stale completed SUCCESS outrank a currently-pending rerun
  // carrying the sentinel, silently discarding the fact that a new run
  // is in flight for that same check name.
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-17T16:00:06Z',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'IN_PROGRESS',
      completedAt: '0001-01-01T00:00:00Z',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'pending');
});

test('classifyCiChecks: two check-run entries with no name are never collapsed into one group', () => {
  // PR review finding: grouping by `String(check.name ?? '')` collapses
  // every missing/empty-name entry into a single bucket, so an unrelated
  // unnamed failure could be discarded in favor of an unrelated unnamed
  // success sharing no real identity with it.
  const checks = [
    { name: '', state: 'FAILURE', completedAt: '2026-07-17T16:00:06Z' },
    { name: '', state: 'SUCCESS', completedAt: '2026-07-17T16:25:47Z' },
  ];
  assert.equal(classifyCiChecks(checks).status, 'failed');
});

// #1483: `classifyCiChecks` must not conflate two independently-sourced
// checks that happen to share a display `name` -- e.g. a GitHub Actions
// check-run and a legacy commit-status, or two check-runs from different
// workflows -- by also grouping on the `type` / `workflowName` producer
// discriminator (see `selectLatestCheckPerName` in protocol-helpers.mts).
test('classifyCiChecks: two same-name instances sharing type and workflowName still dedupe to the latest (no #1471 regression)', () => {
  const checks = [
    {
      name: 'idd-advisory-convergence',
      state: 'CANCELLED',
      completedAt: '2026-07-18T03:45:56Z',
      type: 'check-run',
      workflowName: 'IDD advisory-convergence gate',
    },
    {
      name: 'idd-advisory-convergence',
      state: 'SUCCESS',
      completedAt: '2026-07-18T03:47:01Z',
      type: 'check-run',
      workflowName: 'IDD advisory-convergence gate',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('classifyCiChecks: a check-run and a same-named commit-status never dedupe -- the commit-status FAILURE is never hidden by the check-run SUCCESS', () => {
  // The issue's own motivating example: a check-run and a legacy commit
  // status can report under an identical name/context string while being
  // genuinely independent. `type` differs here ('check-run' vs.
  // 'status-context'), so both must survive as separate groups.
  const checks = [
    {
      name: 'build',
      state: 'FAILURE',
      completedAt: '2026-07-18T03:45:56Z',
      type: 'status-context',
      workflowName: '',
    },
    {
      name: 'build',
      state: 'SUCCESS',
      completedAt: '2026-07-18T03:47:01Z',
      type: 'check-run',
      workflowName: 'Some Workflow',
    },
  ];
  const result = classifyCiChecks(checks);
  assert.equal(result.status, 'failed');
  assert.ok(
    result.failed?.some(
      (check) => check.type === 'status-context' && check.state === 'FAILURE',
    ),
    'the commit-status FAILURE must be present in the failed list',
  );
});

test('classifyCiChecks: two check-runs sharing a name from different workflows never dedupe', () => {
  // Same `type` ('check-run') on both sides, but a different `workflowName`
  // is just as strong a producer-conflict signal as a different `type`.
  const checks = [
    {
      name: 'build',
      state: 'FAILURE',
      completedAt: '2026-07-18T03:45:56Z',
      type: 'check-run',
      workflowName: 'Workflow A',
    },
    {
      name: 'build',
      state: 'SUCCESS',
      completedAt: '2026-07-18T03:47:01Z',
      type: 'check-run',
      workflowName: 'Workflow B',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'failed');
});

test('classifyCiChecks: same type, one entry with a workflowName and one without, same name -- never dedupe', () => {
  // A narrower variant of the check-run/commit-status split: both entries
  // are `type: 'check-run'` here, but only one carries a `workflowName`
  // (e.g. an Actions-routed job vs. a check-run posted directly by a
  // non-Actions GitHub App under the same display name). Presence vs.
  // absence of workflowName is itself a producer-conflict signal, just
  // like two differing non-empty values.
  const checks = [
    {
      name: 'build',
      state: 'FAILURE',
      completedAt: '2026-07-18T03:45:56Z',
      type: 'check-run',
      workflowName: '',
    },
    {
      name: 'build',
      state: 'SUCCESS',
      completedAt: '2026-07-18T03:47:01Z',
      type: 'check-run',
      workflowName: 'Some Workflow',
    },
  ];
  const result = classifyCiChecks(checks);
  assert.equal(result.status, 'failed');
  assert.ok(
    result.failed?.some(
      (check) => check.workflowName === '' && check.state === 'FAILURE',
    ),
    'the workflowName-less FAILURE must be present in the failed list',
  );
});

test('classifyCiChecks: the (name, type, workflowName) dedup key is deterministic regardless of input order', () => {
  const checkRun = {
    name: 'idd-advisory-convergence',
    state: 'CANCELLED',
    completedAt: '2026-07-18T03:45:56Z',
    type: 'check-run',
    workflowName: 'IDD advisory-convergence gate',
  };
  const rerun = {
    ...checkRun,
    state: 'SUCCESS',
    completedAt: '2026-07-18T03:47:01Z',
  };
  const statusContext = {
    name: 'idd-advisory-convergence',
    state: 'FAILURE',
    completedAt: '2026-07-18T03:46:00Z',
    type: 'status-context',
    workflowName: '',
  };
  const checkRunFirst = [checkRun, rerun, statusContext];
  const statusContextFirst = [statusContext, rerun, checkRun];
  const reversed = [statusContext, checkRun, rerun];
  assert.equal(classifyCiChecks(checkRunFirst).status, 'failed');
  assert.equal(classifyCiChecks(statusContextFirst).status, 'failed');
  assert.equal(classifyCiChecks(reversed).status, 'failed');
  // The check-run pair (same type + workflowName) must still dedupe to its
  // latest (SUCCESS) instance regardless of order -- only the independent
  // status-context FAILURE is what makes the overall result 'failed'.
  for (const input of [checkRunFirst, statusContextFirst, reversed]) {
    const checkRunEntries = classifyCiChecks(input).failed?.filter(
      (check) => check.type === 'check-run',
    );
    assert.equal(
      checkRunEntries?.length,
      0,
      'the check-run pair must dedupe to its passing latest instance, not appear in failed',
    );
  }
});

// Regression (#1745): live on PR #1741, classifyCiChecks reported
// ci.status: "success" for a HEAD whose GitHub statusCheckRollup.state was
// "FAILURE" -- the dedup path resolved an idd-advisory-convergence
// check-run group to a SUCCESS "latest" instance while a CANCELLED
// bot-triggered sibling for the same (name, type, workflowName) also
// existed in the same group, and nothing in classifyCiChecks's own output
// surfaced that a non-passing instance had been discarded. This asserts the
// discrepancy is now visible in the output itself, not just the final
// 'success' status.
test('classifyCiChecks: surfaces a discarded CANCELLED sibling when the dedup-selected latest instance is SUCCESS', () => {
  const cancelled = {
    name: 'idd-advisory-convergence',
    state: 'CANCELLED',
    completedAt: '2026-07-18T03:45:56Z',
    type: 'check-run',
    workflowName: 'IDD advisory-convergence gate',
  };
  const success = {
    ...cancelled,
    state: 'SUCCESS',
    completedAt: '2026-07-18T03:47:01Z',
  };
  const result = classifyCiChecks([cancelled, success]);
  assert.equal(result.status, 'success');
  assert.equal(result.discardedNonPassingInstances?.length, 1);
  assert.deepEqual(result.discardedNonPassingInstances?.[0], {
    name: 'idd-advisory-convergence',
    type: 'check-run',
    workflowName: 'IDD advisory-convergence gate',
    selectedState: 'SUCCESS',
    selectedCompletedAt: '2026-07-18T03:47:01Z',
    discardedState: 'CANCELLED',
    discardedCompletedAt: '2026-07-18T03:45:56Z',
  });
});

test('classifyCiChecks: reports an empty discardedNonPassingInstances list when nothing was discarded', () => {
  const result = classifyCiChecks([
    { name: 'lint', state: 'SUCCESS', completedAt: '2026-07-18T03:45:56Z' },
  ]);
  assert.deepEqual(result.discardedNonPassingInstances, []);
});

test('classifyCiChecks: does not flag a discarded pass-equivalent sibling as a discrepancy', () => {
  // A discarded NEUTRAL sibling in favor of a later SUCCESS is two
  // pass-equivalent instances, not a masked failure -- only a genuinely
  // non-passing discarded sibling (CI_FAILURE_CONCLUSION_STATES or
  // CANCELLED) is worth flagging.
  const older = {
    name: 'idd-advisory-convergence',
    state: 'NEUTRAL',
    completedAt: '2026-07-18T03:45:56Z',
    type: 'check-run',
    workflowName: 'IDD advisory-convergence gate',
  };
  const newer = {
    ...older,
    state: 'SUCCESS',
    completedAt: '2026-07-18T03:47:01Z',
  };
  const result = classifyCiChecks([older, newer]);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.discardedNonPassingInstances, []);
});

test('classifyCiChecks: characterization -- two same-name, same-type entries that both lack a workflowName still dedupe (accepted residual limitation)', () => {
  // Documents the deliberately-accepted residual gap: without a real
  // producer identity (e.g. the owning GitHub App) for two check-runs
  // that are not routed through any Actions workflow, they remain
  // indistinguishable from reruns of one another -- matching
  // ci-wait-state.mts's own accepted `(checkName, workflowName)` gap. This
  // is also what keeps every pre-#1483 `classifyCiChecks` caller (which
  // never sets `type`/`workflowName` at all) behavior-identical: those
  // callers hit this exact same uniformly-absent path.
  const checks = [
    {
      name: 'legacy-check',
      state: 'FAILURE',
      completedAt: '2026-07-18T03:45:56Z',
      type: 'check-run',
      workflowName: '',
    },
    {
      name: 'legacy-check',
      state: 'SUCCESS',
      completedAt: '2026-07-18T03:47:01Z',
      type: 'check-run',
      workflowName: '',
    },
  ];
  assert.equal(classifyCiChecks(checks).status, 'success');
});

test('detects operational marker prefixes', () => {
  assert.equal(
    operationalMarkerPrefix(
      '<!-- review-watermark: agent claim sha 2026-05-09T00:00:00Z 0 none -->\n\n_foo: review triage snapshot — IDD automation marker. Do not edit._',
    ),
    '<!-- review-watermark:',
  );
  assert.equal(
    operationalMarkerPrefix(
      '<!-- review-baseline: agent claim sha -->\n\n_foo: critique baseline — IDD automation marker. Do not edit._',
    ),
    '<!-- review-baseline:',
  );
  assert.equal(
    operationalMarkerPrefix(
      'advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z',
    ),
    'advisory-wait:',
  );
  assert.equal(
    operationalMarkerPrefix(
      '  advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z',
    ),
    null,
  );
});

test('flags unsafe text reasons for failed states', () => {
  assert.equal(
    unsafeTextReason('CI failure is blocking merge'),
    'contains failed-CI context',
  );
  assert.equal(
    unsafeTextReason('The failed checks need attention'),
    'contains failed-CI context',
  );
  assert.equal(unsafeTextReason('SUCCESS'), null);
});

for (const fixtureName of [
  'satisfied',
  'request-needed',
  'recovery-needed',
  'cap-exhausted',
  'wait',
  'untrusted-marker',
  'pending-covers-head-force-push',
  'recovery-markers-excluded',
]) {
  test(`advisory wait fixture: ${fixtureName}`, () => {
    const fixture = readJson(`fixtures/advisory-wait/${fixtureName}.json`);
    const { input, expected } = fixture;
    const summary = buildAdvisoryWaitSummary(
      {
        prHeadSha: input.prHeadSha,
        reviews: input.reviews,
        requestedReviewers: input.requestedReviewers,
        timelineEvents: input.timelineEvents,
        comments: input.comments,
      },
      {
        now: input.now,
        requestCap: input.requestCap,
        pendingWindowMinutes: input.pendingWindowMinutes,
        settledWindowMinutes: input.settledWindowMinutes,
        trustedMarkerLogins: input.trustedMarkerLogins,
        viewerLogin: input.viewerLogin,
        configuredTrustedActors: input.configuredTrustedActors,
        collaboratorTrustEnabled: input.collaboratorTrustEnabled,
      },
    );

    assert.equal(summary.outcome, expected.outcome);
    assert.equal(summary.lastCopilotCommit, expected.lastCopilotCommit);
    assert.equal(summary.copilotPending, expected.copilotPending);
    assert.equal(
      summary.copilotPendingCoversHead,
      expected.copilotPendingCoversHead,
    );
    assert.equal(summary.sameHeadMarkerPresent, expected.sameHeadMarkerPresent);
    assert.equal(summary.sameHeadMarkerCount, expected.sameHeadMarkerCount);
    assert.equal(summary.requestMarkerCount, expected.requestMarkerCount);
    assert.equal(summary.requestCap, input.requestCap ?? 30);
    assert.equal(
      summary.pendingWindowMinutes,
      input.pendingWindowMinutes ?? 30,
    );
    assert.equal(
      summary.settledWindowMinutes,
      input.settledWindowMinutes ?? 10,
    );
    assert.equal(summary.pollIntervalMinutes, 2);
    assert.equal(summary.capExhaustedRoute, 'phase-specific');
    assert.equal(summary.earliestSameHeadAt, expected.earliestSameHeadAt);
    assert.equal(summary.elapsedMinutes, expected.elapsedMinutes);
    assert.equal(
      summary.trustedMarkerSummary.trustedSameHeadMarkerCount,
      expected.trustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedSameHeadMarkerCount,
      expected.untrustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.trustedRequestMarkerCount,
      expected.trustedRequestMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedRequestMarkerCount,
      expected.untrustedRequestMarkerCount,
    );
    assert.deepEqual(validate(summary, advisoryWaitSchema), []);
  });
}

test('advisory wait policy resolves defaults, explicit values, and fail-safe fallbacks', () => {
  assert.deepEqual(resolveAdvisoryWaitPolicy({}), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: 12,
        pendingWindow: 'PT45M',
        settledWindow: 'PT15M',
        pollInterval: 'PT3M',
        capExhaustedRoute: 'hold',
      },
    }),
    {
      requestCap: 12,
      pendingWindowMinutes: 45,
      settledWindowMinutes: 15,
      pollIntervalMinutes: 3,
      capExhaustedRoute: 'hold',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: 0,
        pendingWindow: 'P1DT',
        settledWindow: 'PT',
        pollInterval: 'P',
        capExhaustedRoute: 'merge-anyway',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        requestCap: '1',
        pendingWindow: 'pt1m',
        settledWindow: ' PT5M ',
        pollInterval: 'pt3m',
        capExhaustedRoute: ' hold ',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        pendingWindow: 'PT0M',
        settledWindow: 'PT60S',
        pollInterval: 'PT90S',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );

  assert.deepEqual(
    resolveAdvisoryWaitPolicy({
      advisoryWait: {
        pendingWindow: 'PT30S',
        settledWindow: 'PT30S',
        pollInterval: 'PT90S',
      },
    }),
    {
      requestCap: 30,
      pendingWindowMinutes: 30,
      settledWindowMinutes: 10,
      pollIntervalMinutes: 2,
      capExhaustedRoute: 'phase-specific',
    },
  );
});

test('advisory wait policy only applies file overrides from a schema-valid advisoryWait section', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-policy-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );

  validConfig.advisoryWait = {
    requestCap: 12,
    pendingWindow: 'PT45M',
    settledWindow: 'PT15M',
    pollInterval: 'PT3M',
    capExhaustedRoute: 'hold',
  };

  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // The pendingWindow value itself is a genuine advisoryWait schema
  // violation (fails the whole-minute-duration pattern), so the
  // advisoryWait subtree is invalid on its own terms and still reverts.
  writeFileSync(
    invalidPath,
    JSON.stringify({
      advisoryWait: {
        pendingWindow: 'not-a-duration',
      },
    }),
    'utf8',
  );

  assert.deepEqual(readAdvisoryWaitPolicy(validPath), {
    requestCap: 12,
    pendingWindowMinutes: 45,
    settledWindowMinutes: 15,
    pollIntervalMinutes: 3,
    capExhaustedRoute: 'hold',
  });

  assert.deepEqual(readAdvisoryWaitPolicy(invalidPath), {
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
  });
});

test('advisory wait policy still honors advisoryWait when an unrelated top-level field is schema-invalid', () => {
  // #1359 regression: an unknown top-level key trips `additionalProperties:
  // false` at the whole-document level, but must not zero out an otherwise
  // schema-valid advisoryWait section — validation is scoped to
  // advisoryWait's own subtree.
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-policy-scoped-'));
  const configPath = join(root, 'policy.json');
  const config = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );

  config.advisoryWait = {
    requestCap: 12,
    pendingWindow: 'PT45M',
    settledWindow: 'PT15M',
    pollInterval: 'PT3M',
    capExhaustedRoute: 'hold',
  };
  config.unsupportedTopLevelKey = true;

  writeFileSync(configPath, JSON.stringify(config), 'utf8');

  assert.deepEqual(readAdvisoryWaitPolicy(configPath), {
    requestCap: 12,
    pendingWindowMinutes: 45,
    settledWindowMinutes: 15,
    pollIntervalMinutes: 3,
    capExhaustedRoute: 'hold',
  });
});

test('isCopilotReviewerLogin keeps the dual Copilot match by default and matches a configured bot exactly', () => {
  // Default (Copilot): exact `copilot` plus the GitHub App login family.
  assert.equal(isCopilotReviewerLogin('copilot'), true);
  assert.equal(isCopilotReviewerLogin('Copilot'), true);
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]'),
    true,
  );
  assert.equal(isCopilotReviewerLogin('coderabbitai[bot]'), false);
  assert.equal(isCopilotReviewerLogin(''), false);
  // An explicit Copilot default behaves identically to the implicit default.
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]', 'copilot'),
    true,
  );

  // A configured non-Copilot bot is matched by exact normalized equality only,
  // and the Copilot prefix family no longer matches.
  assert.equal(
    isCopilotReviewerLogin('coderabbitai[bot]', 'coderabbitai[bot]'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('CodeRabbitAI[bot]', 'coderabbitai[bot]'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin(
      'copilot-pull-request-reviewer[bot]',
      'coderabbitai[bot]',
    ),
    false,
  );
  // A blank configured login falls back to the Copilot default.
  assert.equal(isCopilotReviewerLogin('copilot', '   '), true);
});

test('#1686: isCopilotReviewerLogin matches only the exact Copilot login set and rejects a registrable lookalike', () => {
  // The three exact logins the default Copilot match now recognizes.
  assert.equal(isCopilotReviewerLogin('copilot'), true);
  assert.equal(isCopilotReviewerLogin('Copilot'), true);
  assert.equal(isCopilotReviewerLogin('copilot-pull-request-reviewer'), true);
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer[bot]'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('Copilot-Pull-Request-Reviewer[Bot]'),
    true,
  );
  // The acceptance-criterion regression: a GitHub username is alphanumeric-
  // plus-hyphen, so `copilot-pull-request-reviewer1` is a REGISTRABLE login
  // distinct from the real bot's own two forms above. The pre-#1686 prefix
  // match (`startsWith('copilot-pull-request-reviewer')`) accepted it; the
  // exact-set match must not.
  assert.equal(isCopilotReviewerLogin('copilot-pull-request-reviewer1'), false);
  // A handful of other lookalike shapes a prefix match would also have let
  // through.
  assert.equal(
    isCopilotReviewerLogin('copilot-pull-request-reviewer-fake'),
    false,
  );
  assert.equal(isCopilotReviewerLogin('copilot-impersonator'), false);
});

test('advisory wait summary resolves coverage against a configured primary bot', () => {
  const headSha = 'b'.repeat(40);
  const input = {
    prHeadSha: headSha,
    reviews: [
      {
        user: { login: 'coderabbitai[bot]' },
        submitted_at: '2026-05-11T17:01:00Z',
        commit_id: headSha,
      },
      // A Copilot review must be ignored when the primary bot is CodeRabbit.
      {
        user: { login: 'copilot-pull-request-reviewer[bot]' },
        submitted_at: '2026-05-11T17:02:00Z',
        commit_id: 'c'.repeat(40),
      },
    ],
    requestedReviewers: [{ login: 'coderabbitai[bot]' }],
    timelineEvents: [],
    comments: [],
  };

  const customBot = buildAdvisoryWaitSummary(input, {
    now: '2026-05-11T17:05:00Z',
    primaryBotLogin: 'coderabbitai[bot]',
  });
  // Coverage is computed against the CodeRabbit review on HEAD, and the
  // CodeRabbit pending request is detected; the Copilot review is ignored.
  assert.equal(customBot.lastCopilotCommit, headSha);
  assert.equal(customBot.copilotPending, true);

  // With the default (Copilot) primary bot, the same payload resolves against
  // the Copilot review (off HEAD) and no Copilot pending request.
  const defaultBot = buildAdvisoryWaitSummary(input, {
    now: '2026-05-11T17:05:00Z',
  });
  assert.equal(defaultBot.lastCopilotCommit, 'c'.repeat(40));
  assert.equal(defaultBot.copilotPending, false);
});

// #2167: REST `requested_reviewers` can report empty while Copilot review
// is still genuinely outstanding for the current HEAD (observed on this
// source repository during PR #2158 -- REST returned `{"users":[]}` while
// GraphQL `reviewRequests` still listed the primary bot and the timeline
// already proved `copilotPendingCoversHead: true`). These cases exercise
// `resolveCopilotPending`'s precedence directly, and via
// `buildAdvisoryWaitSummary`'s `graphqlRequestedReviewerLogins` input.
test('resolveCopilotPending: REST empty, timeline coverage true -> pending true without any GraphQL data', () => {
  assert.equal(
    resolveCopilotPending(
      [],
      /* copilotPendingCoversHead */ true,
      /* lastCopilotCommit */ 'a'.repeat(40),
      /* prHeadSha */ 'b'.repeat(40),
      /* graphqlRequestedReviewerLogins */ null,
    ),
    true,
  );
});

test('resolveCopilotPending: REST empty, timeline inconclusive, GraphQL lists the bot -> pending true', () => {
  assert.equal(
    resolveCopilotPending(
      [],
      /* copilotPendingCoversHead */ false,
      /* lastCopilotCommit */ '',
      /* prHeadSha */ 'b'.repeat(40),
      /* graphqlRequestedReviewerLogins */ ['copilot-pull-request-reviewer'],
    ),
    true,
  );
});

test('resolveCopilotPending: REST empty, timeline inconclusive, GraphQL empty -> pending false', () => {
  assert.equal(
    resolveCopilotPending(
      [],
      /* copilotPendingCoversHead */ false,
      /* lastCopilotCommit */ '',
      /* prHeadSha */ 'b'.repeat(40),
      /* graphqlRequestedReviewerLogins */ [],
    ),
    false,
  );
});

test('resolveCopilotPending: REST empty, timeline inconclusive, GraphQL failed (null) -> keeps the REST result (false)', () => {
  // A `null` graphqlRequestedReviewerLogins means "not attempted, or the
  // attempt failed" -- a GraphQL 4xx (or any other failure) must never be
  // read as pending.
  assert.equal(
    resolveCopilotPending(
      [],
      /* copilotPendingCoversHead */ false,
      /* lastCopilotCommit */ '',
      /* prHeadSha */ 'b'.repeat(40),
      /* graphqlRequestedReviewerLogins */ null,
    ),
    false,
  );
});

test('resolveCopilotPending: REST already pending short-circuits before consulting timeline or GraphQL', () => {
  assert.equal(
    resolveCopilotPending(
      [{ login: 'copilot-pull-request-reviewer' }],
      /* copilotPendingCoversHead */ false,
      /* lastCopilotCommit */ 'a'.repeat(40),
      /* prHeadSha */ 'a'.repeat(40),
      /* graphqlRequestedReviewerLogins */ null,
    ),
    true,
  );
});

test('buildAdvisoryWaitSummary: empty REST requestedReviewers plus timeline coverage yields copilotPending true without any GraphQL evidence', () => {
  // Reproduces the observed #2158 incident end-to-end through the public
  // summary function: REST requested_reviewers is empty, but the timeline
  // already proves the primary bot was re-requested after the current
  // HEAD's own commit event, and no prior Copilot review covers this HEAD.
  const headSha = 'e'.repeat(40);
  const priorHeadSha = 'f'.repeat(40);
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: headSha,
      reviews: [
        {
          user: { login: 'copilot-pull-request-reviewer' },
          submitted_at: '2026-08-18T23:00:00Z',
          commit_id: priorHeadSha,
        },
      ],
      requestedReviewers: [],
      timelineEvents: [
        { event: 'committed', sha: priorHeadSha },
        { event: 'committed', sha: headSha },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'copilot-pull-request-reviewer' },
        },
      ],
      comments: [],
      graphqlRequestedReviewerLogins: null,
    },
    { now: '2026-08-19T00:00:00Z' },
  );
  assert.equal(summary.lastCopilotCommit, priorHeadSha);
  assert.equal(summary.copilotPendingCoversHead, true);
  assert.equal(summary.copilotPending, true);
});

test('buildAdvisoryWaitSummary: empty REST requestedReviewers plus a GraphQL-listed bot yields copilotPending true', () => {
  const headSha = 'd'.repeat(40);
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: headSha,
      reviews: [],
      requestedReviewers: [],
      timelineEvents: [],
      comments: [],
      graphqlRequestedReviewerLogins: ['copilot-pull-request-reviewer'],
    },
    { now: '2026-08-19T00:00:00Z' },
  );
  assert.equal(summary.copilotPending, true);
});

test('buildAdvisoryWaitSummary: empty REST requestedReviewers and no GraphQL evidence yields copilotPending false', () => {
  const headSha = 'd'.repeat(40);
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: headSha,
      reviews: [],
      requestedReviewers: [],
      timelineEvents: [],
      comments: [],
      graphqlRequestedReviewerLogins: null,
    },
    { now: '2026-08-19T00:00:00Z' },
  );
  assert.equal(summary.copilotPending, false);
});

test('primary advisory bot login resolves defaults, overrides, and fail-safe fallbacks', () => {
  assert.equal(DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN, 'copilot');
  assert.equal(resolveAdvisoryPrimaryBotLogin({}), 'copilot');
  assert.equal(resolveAdvisoryPrimaryBotLogin(), 'copilot');
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({
      advisoryWait: { primaryBotLogin: 'CodeRabbitAI[bot]' },
    }),
    'coderabbitai[bot]',
  );
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({ advisoryWait: { primaryBotLogin: '  ' } }),
    'copilot',
  );
  assert.equal(
    resolveAdvisoryPrimaryBotLogin({ advisoryWait: { primaryBotLogin: 42 } }),
    'copilot',
  );
});

test('readAdvisoryPrimaryBotLogin only applies a schema-valid file override', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-primary-bot-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { primaryBotLogin: 'coderabbitai[bot]' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string primaryBotLogin violates the schema, so the file is
  // schema-invalid and the reader fails closed to the Copilot default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { primaryBotLogin: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisoryPrimaryBotLogin(validPath), 'coderabbitai[bot]');
  assert.equal(readAdvisoryPrimaryBotLogin(invalidPath), 'copilot');
  assert.equal(
    readAdvisoryPrimaryBotLogin(join(root, 'missing.json')),
    'copilot',
  );
});

test('secondary advisory bot login resolves to empty when absent and normalizes when present', () => {
  // The secondary is OPTIONAL — absence resolves to '' (disabled), with no
  // Copilot default, so it never accidentally matches the Copilot family.
  assert.equal(resolveAdvisorySecondaryBotLogin({}), '');
  assert.equal(resolveAdvisorySecondaryBotLogin(), '');
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: 'CodeRabbitAI[bot]' },
    }),
    'coderabbitai[bot]',
  );
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: '  ' },
    }),
    '',
  );
  assert.equal(
    resolveAdvisorySecondaryBotLogin({
      advisoryWait: { secondaryBotLogin: 42 },
    }),
    '',
  );
});

test('readAdvisorySecondaryBotLogin only applies a schema-valid file override, else empty', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-secondary-bot-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { secondaryBotLogin: 'coderabbitai[bot]' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string secondaryBotLogin violates the schema, so the reader fails
  // closed to '' (secondary disabled).
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { secondaryBotLogin: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisorySecondaryBotLogin(validPath), 'coderabbitai[bot]');
  assert.equal(readAdvisorySecondaryBotLogin(invalidPath), '');
  assert.equal(readAdvisorySecondaryBotLogin(join(root, 'missing.json')), '');
});

test('readAdvisoryConvergenceDeadlineMinutes applies a schema-valid override and is scoped to advisoryWait', () => {
  const root = mkdtempSync(
    join(tmpdir(), 'idd-advisory-convergence-deadline-'),
  );
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { convergenceDeadline: 'PT6H' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string convergenceDeadline violates the advisoryWait schema, so
  // the reader fails closed to the default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { convergenceDeadline: 5 } }),
    'utf8',
  );

  assert.equal(readAdvisoryConvergenceDeadlineMinutes(validPath), 6 * 60);
  assert.equal(
    readAdvisoryConvergenceDeadlineMinutes(invalidPath),
    DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  );
  assert.equal(
    readAdvisoryConvergenceDeadlineMinutes(join(root, 'missing.json')),
    DEFAULT_ADVISORY_CONVERGENCE_DEADLINE_MINUTES,
  );
});

// #1572: recovery-cycle cap (default 2), accounted independently of
// requestCap and sameHeadRerollCap.

test('resolveAdvisoryRecoveryCycleCap defaults to 2 on absent/empty config', () => {
  assert.equal(resolveAdvisoryRecoveryCycleCap({}), 2);
  assert.equal(resolveAdvisoryRecoveryCycleCap(), 2);
  assert.equal(resolveAdvisoryRecoveryCycleCap(null), 2);
});

test('resolveAdvisoryRecoveryCycleCap accepts an explicit positive integer', () => {
  assert.equal(
    resolveAdvisoryRecoveryCycleCap({ advisoryWait: { recoveryCycleCap: 5 } }),
    5,
  );
});

test('resolveAdvisoryRecoveryCycleCap falls back to the default on a non-positive-integer value', () => {
  assert.equal(
    resolveAdvisoryRecoveryCycleCap({ advisoryWait: { recoveryCycleCap: 0 } }),
    2,
  );
  assert.equal(
    resolveAdvisoryRecoveryCycleCap({ advisoryWait: { recoveryCycleCap: -1 } }),
    2,
  );
  assert.equal(
    resolveAdvisoryRecoveryCycleCap({
      advisoryWait: { recoveryCycleCap: 1.5 },
    }),
    2,
  );
  assert.equal(
    resolveAdvisoryRecoveryCycleCap({
      advisoryWait: { recoveryCycleCap: '3' },
    }),
    2,
  );
});

test('readAdvisoryRecoveryCycleCap applies a schema-valid override and is scoped to advisoryWait', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-recovery-cap-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { recoveryCycleCap: 4 };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-integer recoveryCycleCap violates the advisoryWait schema, so the
  // reader fails closed to the default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { recoveryCycleCap: 'four' } }),
    'utf8',
  );

  assert.equal(readAdvisoryRecoveryCycleCap(validPath), 4);
  assert.equal(
    readAdvisoryRecoveryCycleCap(invalidPath),
    DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  );
  assert.equal(
    readAdvisoryRecoveryCycleCap(join(root, 'missing.json')),
    DEFAULT_ADVISORY_RECOVERY_CYCLE_CAP,
  );
});

// #1572: 12h terminal Copilot-unavailability window.

test('resolveAdvisoryTerminalWindowMinutes defaults to 720 (12h) on absent/empty config', () => {
  assert.equal(resolveAdvisoryTerminalWindowMinutes({}), 720);
  assert.equal(resolveAdvisoryTerminalWindowMinutes(), 720);
  assert.equal(resolveAdvisoryTerminalWindowMinutes(null), 720);
});

test('resolveAdvisoryTerminalWindowMinutes accepts an explicit ISO8601 duration', () => {
  assert.equal(
    resolveAdvisoryTerminalWindowMinutes({
      advisoryWait: { terminalWindow: 'PT6H' },
    }),
    6 * 60,
  );
  assert.equal(
    resolveAdvisoryTerminalWindowMinutes({
      advisoryWait: { terminalWindow: 'P1D' },
    }),
    24 * 60,
  );
});

test('resolveAdvisoryTerminalWindowMinutes falls back to the default on an invalid duration', () => {
  assert.equal(
    resolveAdvisoryTerminalWindowMinutes({
      advisoryWait: { terminalWindow: 'not-a-duration' },
    }),
    720,
  );
  assert.equal(
    resolveAdvisoryTerminalWindowMinutes({
      advisoryWait: { terminalWindow: 'PT0H' },
    }),
    720,
  );
});

test('readAdvisoryTerminalWindowMinutes applies a schema-valid override and is scoped to advisoryWait', () => {
  const root = mkdtempSync(join(tmpdir(), 'idd-advisory-terminal-window-'));
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { terminalWindow: 'PT8H' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string terminalWindow violates the advisoryWait schema, so the
  // reader fails closed to the default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { terminalWindow: 8 } }),
    'utf8',
  );

  assert.equal(readAdvisoryTerminalWindowMinutes(validPath), 8 * 60);
  assert.equal(
    readAdvisoryTerminalWindowMinutes(invalidPath),
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
  assert.equal(
    readAdvisoryTerminalWindowMinutes(join(root, 'missing.json')),
    DEFAULT_ADVISORY_TERMINAL_WINDOW_MINUTES,
  );
});

// #2554: declaration-scoped `advisoryWait.providerOutage.terminalWindow`
// override, applied only while a currently-valid outage declaration is
// active.

test('resolveProviderOutageTerminalWindowMinutes returns null when unset, unparseable, or non-positive', () => {
  assert.equal(resolveProviderOutageTerminalWindowMinutes({}), null);
  assert.equal(resolveProviderOutageTerminalWindowMinutes(), null);
  assert.equal(resolveProviderOutageTerminalWindowMinutes(null), null);
  assert.equal(
    resolveProviderOutageTerminalWindowMinutes({
      advisoryWait: { providerOutage: {} },
    }),
    null,
  );
  assert.equal(
    resolveProviderOutageTerminalWindowMinutes({
      advisoryWait: { providerOutage: { terminalWindow: 'not-a-duration' } },
    }),
    null,
  );
  assert.equal(
    resolveProviderOutageTerminalWindowMinutes({
      advisoryWait: { providerOutage: { terminalWindow: 'PT0H' } },
    }),
    null,
  );
});

test('resolveProviderOutageTerminalWindowMinutes accepts an explicit ISO8601 duration', () => {
  assert.equal(
    resolveProviderOutageTerminalWindowMinutes({
      advisoryWait: { providerOutage: { terminalWindow: 'PT2H' } },
    }),
    2 * 60,
  );
});

test('resolveEffectiveAdvisoryTerminalWindowMinutes: no declaration active is byte-identical to resolveAdvisoryTerminalWindowMinutes', () => {
  const configs = [
    {},
    { advisoryWait: { terminalWindow: 'PT6H' } },
    {
      advisoryWait: {
        terminalWindow: 'PT6H',
        providerOutage: { terminalWindow: 'PT1H' },
      },
    },
  ];
  for (const config of configs) {
    assert.equal(
      resolveEffectiveAdvisoryTerminalWindowMinutes({
        config,
        declarationActive: false,
      }),
      resolveAdvisoryTerminalWindowMinutes(config),
    );
    // Also true when `declarationActive` is omitted entirely (default false).
    assert.equal(
      resolveEffectiveAdvisoryTerminalWindowMinutes({ config }),
      resolveAdvisoryTerminalWindowMinutes(config),
    );
  }
});

test('resolveEffectiveAdvisoryTerminalWindowMinutes: active declaration with a shorter configured override applies the shorter value', () => {
  const config = {
    advisoryWait: {
      terminalWindow: 'PT12H',
      providerOutage: { terminalWindow: 'PT1H' },
    },
  };
  assert.equal(
    resolveEffectiveAdvisoryTerminalWindowMinutes({
      config,
      declarationActive: true,
    }),
    60,
  );
});

test('resolveEffectiveAdvisoryTerminalWindowMinutes: active declaration with no configured override is unchanged', () => {
  const config = { advisoryWait: { terminalWindow: 'PT12H' } };
  assert.equal(
    resolveEffectiveAdvisoryTerminalWindowMinutes({
      config,
      declarationActive: true,
    }),
    12 * 60,
  );
});

test('resolveEffectiveAdvisoryTerminalWindowMinutes: an invalid configured override falls back to the base window even while active', () => {
  const config = {
    advisoryWait: {
      terminalWindow: 'PT12H',
      providerOutage: { terminalWindow: 'not-a-duration' },
    },
  };
  assert.equal(
    resolveEffectiveAdvisoryTerminalWindowMinutes({
      config,
      declarationActive: true,
    }),
    12 * 60,
  );
});

// #2335: opt-in secondary-quiet-window (off by default when omitted).

test('resolveAdvisorySecondaryQuietWindowMinutes defaults to 0 (off) on absent/empty config', () => {
  assert.equal(resolveAdvisorySecondaryQuietWindowMinutes({}), 0);
  assert.equal(resolveAdvisorySecondaryQuietWindowMinutes(), 0);
  assert.equal(resolveAdvisorySecondaryQuietWindowMinutes(null), 0);
});

test('resolveAdvisorySecondaryQuietWindowMinutes accepts an explicit ISO8601 duration', () => {
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes({
      advisoryWait: { secondaryQuietWindow: 'PT5M' },
    }),
    5,
  );
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes({
      advisoryWait: { secondaryQuietWindow: 'PT1H' },
    }),
    60,
  );
});

test('resolveAdvisorySecondaryQuietWindowMinutes falls back to 0 (off) on an unparseable or non-positive duration', () => {
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes({
      advisoryWait: { secondaryQuietWindow: 'not-a-duration' },
    }),
    0,
  );
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes({
      advisoryWait: { secondaryQuietWindow: 'PT0H' },
    }),
    0,
  );
  // The shared duration parser has no negative-duration syntax to accept,
  // so a negative value is unparseable and already falls back to 0.
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes({
      advisoryWait: { secondaryQuietWindow: '-PT5M' },
    }),
    0,
  );
});

test('readAdvisorySecondaryQuietWindowMinutes applies a schema-valid override and is scoped to advisoryWait', () => {
  const root = mkdtempSync(
    join(tmpdir(), 'idd-advisory-secondary-quiet-window-'),
  );
  const validPath = join(root, 'policy.valid.json');
  const invalidPath = join(root, 'policy.invalid.json');
  const validConfig = JSON.parse(
    JSON.stringify(loadJson('fixtures/schemas/policy.valid.json')),
  );
  validConfig.advisoryWait = { secondaryQuietWindow: 'PT20M' };
  writeFileSync(validPath, JSON.stringify(validConfig), 'utf8');
  // A non-string secondaryQuietWindow violates the advisoryWait schema, so
  // the reader fails closed to the default.
  writeFileSync(
    invalidPath,
    JSON.stringify({ advisoryWait: { secondaryQuietWindow: 20 } }),
    'utf8',
  );

  assert.equal(readAdvisorySecondaryQuietWindowMinutes(validPath), 20);
  assert.equal(
    readAdvisorySecondaryQuietWindowMinutes(invalidPath),
    DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES,
  );
  assert.equal(
    readAdvisorySecondaryQuietWindowMinutes(join(root, 'missing.json')),
    DEFAULT_ADVISORY_SECONDARY_QUIET_WINDOW_MINUTES,
  );
});

test('secondary quiet window is independent of requestCap, recoveryCycleCap, and terminalWindow', () => {
  const config = {
    advisoryWait: {
      requestCap: 99,
      recoveryCycleCap: 9,
      terminalWindow: 'PT1H',
    },
  };
  assert.equal(resolveAdvisorySecondaryQuietWindowMinutes(config), 0);

  const quietWindowConfig = {
    advisoryWait: { secondaryQuietWindow: 'PT20M' },
  };
  assert.equal(resolveAdvisoryWaitPolicy(quietWindowConfig).requestCap, 30);
  assert.equal(resolveAdvisoryRecoveryCycleCap(quietWindowConfig), 2);
  assert.equal(resolveAdvisoryTerminalWindowMinutes(quietWindowConfig), 720);
  assert.equal(
    resolveAdvisorySecondaryQuietWindowMinutes(quietWindowConfig),
    20,
  );
});

test('recovery-cycle cap and terminal window are independent of requestCap and sameHeadRerollCap', () => {
  // Setting requestCap and sameHeadRerollCap must never change the
  // recovery-cycle cap or terminal window defaults, and vice versa -- each
  // is its own counter/knob (#1572 AC1).
  const config = {
    advisoryWait: {
      requestCap: 99,
      sameHeadRerollCap: 7,
    },
  };
  assert.equal(resolveAdvisoryRecoveryCycleCap(config), 2);
  assert.equal(resolveAdvisoryTerminalWindowMinutes(config), 720);
  assert.equal(resolveAdvisoryWaitPolicy(config).requestCap, 99);

  const recoveryConfig = {
    advisoryWait: { recoveryCycleCap: 9, terminalWindow: 'PT1H' },
  };
  assert.equal(resolveAdvisoryWaitPolicy(recoveryConfig).requestCap, 30);
  assert.equal(resolveAdvisoryRecoveryCycleCap(recoveryConfig), 9);
  assert.equal(resolveAdvisoryTerminalWindowMinutes(recoveryConfig), 60);
});

test('computeSecondaryRequestedForHead detects a same-HEAD secondary request and resets per HEAD', () => {
  const head = 'b'.repeat(40);
  // No timeline → not requested.
  assert.equal(
    computeSecondaryRequestedForHead([], head, 'coderabbitai[bot]'),
    false,
  );
  // Empty login short-circuits, even with a matching request event.
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        { event: 'committed', sha: head },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
      ],
      head,
      '',
    ),
    false,
  );
  // review_requested AFTER the HEAD committed event → requested (case-folded).
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        { event: 'committed', sha: head },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'CodeRabbitAI[bot]' },
        },
      ],
      head,
      'coderabbitai[bot]',
    ),
    true,
  );
  // A request BEFORE the current HEAD committed event does not count — the
  // per-HEAD reset that lets a new HEAD re-request the secondary.
  assert.equal(
    computeSecondaryRequestedForHead(
      [
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
        { event: 'committed', sha: head },
      ],
      head,
      'coderabbitai[bot]',
    ),
    false,
  );
});

test('secondary bot is requested once per HEAD when primary is cap-exhausted, without touching the gate', () => {
  const fixture = readJson('fixtures/advisory-wait/cap-exhausted.json');
  const base = {
    prHeadSha: fixture.input.prHeadSha,
    reviews: fixture.input.reviews,
    requestedReviewers: fixture.input.requestedReviewers,
    timelineEvents: fixture.input.timelineEvents,
    comments: fixture.input.comments,
  };
  const opts = {
    now: fixture.input.now,
    requestCap: fixture.input.requestCap,
    trustedMarkerLogins: fixture.input.trustedMarkerLogins,
  };

  const withoutSecondary = buildAdvisoryWaitSummary(base, opts);
  const withSecondary = buildAdvisoryWaitSummary(base, {
    ...opts,
    secondaryBotLogin: 'coderabbitai[bot]',
  });

  // Trigger: primary cap-exhausted and never reviewed HEAD → request once.
  assert.equal(withoutSecondary.outcome, 'CAP_EXHAUSTED');
  assert.equal(withSecondary.secondaryRequestNeeded, true);
  assert.equal(withSecondary.secondaryBotLogin, 'coderabbitai[bot]');
  // No secondary configured ⇒ identical to the primary-only (#1098) behavior.
  assert.equal(withoutSecondary.secondaryRequestNeeded, false);
  assert.equal(withoutSecondary.secondaryBotLogin, '');

  // Contract (a): the secondary never alters the primary gate.
  assert.equal(withSecondary.outcome, withoutSecondary.outcome);
  assert.equal(withSecondary.f3Outcome, withoutSecondary.f3Outcome);
  assert.equal(withSecondary.copilotPending, withoutSecondary.copilotPending);
  assert.equal(
    withSecondary.lastCopilotCommit,
    withoutSecondary.lastCopilotCommit,
  );
  // Contract (b): no primary advisory-wait marker / cap consumption is added.
  assert.equal(
    withSecondary.requestMarkerCount,
    withoutSecondary.requestMarkerCount,
  );
  assert.equal(
    withSecondary.sameHeadMarkerPresent,
    withoutSecondary.sameHeadMarkerPresent,
  );

  // Once per HEAD: a secondary review_requested after HEAD suppresses re-request.
  const alreadyRequested = buildAdvisoryWaitSummary(
    {
      ...base,
      timelineEvents: [
        { event: 'committed', sha: fixture.input.prHeadSha },
        {
          event: 'review_requested',
          requested_reviewer: { login: 'coderabbitai[bot]' },
        },
      ],
    },
    { ...opts, secondaryBotLogin: 'coderabbitai[bot]' },
  );
  assert.equal(alreadyRequested.secondaryRequestNeeded, false);

  // Misconfiguration: a secondary equal to the primary is treated as absent.
  const samePrimary = buildAdvisoryWaitSummary(base, {
    ...opts,
    primaryBotLogin: 'coderabbitai[bot]',
    secondaryBotLogin: 'coderabbitai[bot]',
  });
  assert.equal(samePrimary.secondaryRequestNeeded, false);
  assert.equal(samePrimary.secondaryBotLogin, '');
});

test('secondary bot fires on a stalled settled-window wait but not on a HEAD-reviewed satisfy', () => {
  // Stalled / rate-limited: SATISFIED via the elapsed settle window with no
  // HEAD review (lastCopilotCommit empty) → request the secondary supplement.
  const waitFixture = readJson('fixtures/advisory-wait/wait.json');
  const stalled = buildAdvisoryWaitSummary(
    {
      prHeadSha: waitFixture.input.prHeadSha,
      reviews: waitFixture.input.reviews,
      requestedReviewers: waitFixture.input.requestedReviewers,
      timelineEvents: waitFixture.input.timelineEvents,
      comments: waitFixture.input.comments,
    },
    {
      now: waitFixture.input.now,
      // elapsed (4 min) >= 1 ⇒ SATISFIED by the window, not by a HEAD review.
      settledWindowMinutes: 1,
      trustedMarkerLogins: waitFixture.input.trustedMarkerLogins,
      secondaryBotLogin: 'coderabbitai[bot]',
    },
  );
  assert.equal(stalled.outcome, 'SATISFIED');
  assert.equal(stalled.lastCopilotCommit, '');
  assert.equal(stalled.secondaryRequestNeeded, true);

  // A genuine HEAD review (SATISFIED with lastCopilotCommit === HEAD) needs no
  // supplement — the follow-up the secondary exists for is not needed.
  const satisfiedFixture = readJson('fixtures/advisory-wait/satisfied.json');
  const headReviewed = buildAdvisoryWaitSummary(
    {
      prHeadSha: satisfiedFixture.input.prHeadSha,
      reviews: satisfiedFixture.input.reviews,
      requestedReviewers: satisfiedFixture.input.requestedReviewers,
      timelineEvents: satisfiedFixture.input.timelineEvents,
      comments: satisfiedFixture.input.comments,
    },
    {
      now: satisfiedFixture.input.now,
      trustedMarkerLogins: satisfiedFixture.input.trustedMarkerLogins,
      secondaryBotLogin: 'coderabbitai[bot]',
    },
  );
  assert.equal(headReviewed.outcome, 'SATISFIED');
  assert.equal(
    headReviewed.lastCopilotCommit,
    satisfiedFixture.input.prHeadSha,
  );
  assert.equal(headReviewed.secondaryRequestNeeded, false);
});

test('advisory wait summary normalizes invalid direct options to defaults', () => {
  const fixture = readJson('fixtures/advisory-wait/request-needed.json');
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: fixture.input.prHeadSha,
      reviews: fixture.input.reviews,
      requestedReviewers: fixture.input.requestedReviewers,
      timelineEvents: fixture.input.timelineEvents,
      comments: fixture.input.comments,
    },
    {
      now: fixture.input.now,
      requestCap: 0,
      pendingWindowMinutes: -45,
      settledWindowMinutes: 0,
      pollIntervalMinutes: -3,
      capExhaustedRoute: 'merge-anyway',
      trustedMarkerLogins: fixture.input.trustedMarkerLogins,
      viewerLogin: fixture.input.viewerLogin,
      configuredTrustedActors: fixture.input.configuredTrustedActors,
      collaboratorTrustEnabled: fixture.input.collaboratorTrustEnabled,
    },
  );

  assert.equal(summary.requestCap, 30);
  assert.equal(summary.pendingWindowMinutes, 30);
  assert.equal(summary.settledWindowMinutes, 10);
  assert.equal(summary.pollIntervalMinutes, 2);
  assert.equal(summary.capExhaustedRoute, 'phase-specific');
});

// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main` (#1210, migrated from
// isCliExecution() by #1447); previously the import parsed process.argv and
// called a `gh` command, aborting the test process when no --pr argument or
// gh binary was available.
test('importing advisory-wait-state.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(
      import('../src/scripts/advisory-wait-state.mts'),
    );
  } finally {
    process.env.PATH = originalPath;
  }
});
