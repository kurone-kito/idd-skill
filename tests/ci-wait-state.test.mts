import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildCiWaitStateSummary,
  ciWaitSummaryIsPreMergeCiPassing,
  collectCiWaitState,
  isProtectionReadUnreadable,
  latestPassingCompletedAt,
  parseArgs,
  selectLatestCheckEntry,
} from '../src/scripts/ci-wait-state.mts';
import { classifyCiChecks } from '../src/scripts/protocol-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses --pr, --owner, and --repo', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
  ]);
  assert.equal(args.prNumber, 42);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
  assert.equal(args.help, false);
});

test('parseArgs: an invalid --pr resolves to null (fails closed at the caller)', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

test('parseArgs: an absent --pr also resolves to null', () => {
  // CodeRabbit review finding on #1450: only the invalid-value case was
  // covered; --help doesn't assert prNumber, so the absent-value contract
  // was unprotected.
  const args = parseArgs([]);
  assert.equal(args.prNumber, null);
});

test('parseArgs: --pr keeps its pre-#1450 permissive Number.parseInt contract', () => {
  // Regression coverage for a CodeRabbit review finding on #1450: the
  // wrapper migration must not swap in cli-args.mts's stricter
  // canonical-pattern integer parser here, which would reject trailing-
  // garbage and leading-zero tokens the original Number.parseInt-based
  // parser always accepted.
  assert.equal(parseArgs(['--pr', '42abc']).prNumber, 42);
  assert.equal(parseArgs(['--pr', '007']).prNumber, 7);
});

test('parseArgs: a missing --pr value throws', () => {
  assert.throws(() => parseArgs(['--pr']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --owner would greedily accept '--repo' as its literal
  // value, silently leaving --repo unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--pr', '42', '--owner', '--repo']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

const HEAD_SHA = 'a'.repeat(40);

function checkRun(overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'CheckRun',
    name: 'lint',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    workflowName: 'push',
    detailsUrl: 'https://example/run',
    startedAt: '2026-07-09T00:00:00Z',
    completedAt: '2026-07-09T00:05:00Z',
    ...overrides,
  };
}

test('keys duplicate-name checks by (checkName, workflowName) instead of collapsing them', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          workflowName: 'push as feature branch',
          status: 'COMPLETED',
          conclusion: 'SUCCESS',
        }),
        checkRun({
          workflowName: 'merge as main branch',
          status: 'IN_PROGRESS',
          conclusion: '',
        }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );

  assert.equal(summary.checks.length, 2);
  const byWorkflow = new Map(
    summary.checks.map((check) => [check.workflowName, check]),
  );
  assert.equal(byWorkflow.get('push as feature branch')?.status, 'success');
  assert.equal(byWorkflow.get('merge as main branch')?.status, 'pending');
  // Both entries share the display name; disambiguation must not merge them.
  assert.equal(
    summary.checks.every((check) => check.checkName === 'lint'),
    true,
  );
});

test('required-checks rollup: mixed pending/passing reports anyRequiredPending, not passing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
        checkRun({
          name: 'test',
          workflowName: 'ci',
          status: 'IN_PROGRESS',
          conclusion: '',
        }),
      ],
    },
    { requiredCheckNames: ['lint', 'test'] },
  );

  assert.equal(summary.requiredChecks.allRequiredPresent, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.anyRequiredPending, true);
  assert.equal(summary.requiredChecks.anyRequiredFailing, false);
  assert.equal(summary.requiredChecks.status, 'pending');
});

test('required-checks rollup: a failing required check reports anyRequiredFailing and status failing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
        checkRun({ name: 'test', workflowName: 'ci', conclusion: 'FAILURE' }),
      ],
    },
    { requiredCheckNames: ['lint', 'test'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.status, 'failing');
});

// #1478: buildCiWaitStateSummary had the same multi-instance stale-rollup
// defect #1471 fixed in classifyCiChecks (protocol-helpers.mts). Timestamps
// below deliberately mirror required-checks-summary.test.mts's #1471
// regression tests (strictly increasing, distinct `completedAt` values) so
// these exercise latest-completedAt selection, not the FAILURE/CANCELLED
// same-instant tie-break — a tied `completedAt` would pass or fail these
// scenarios for the wrong reason.
test('required-checks rollup: a stale cancelled instance superseded by a later success no longer reports failing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'CANCELLED',
          completedAt: '2026-07-17T15:59:36Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-17T16:25:47Z',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, true);
  assert.equal(summary.requiredChecks.status, 'success');
});

test('required-checks rollup: a genuinely failing latest instance still reports failing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-17T15:59:36Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'FAILURE',
          completedAt: '2026-07-17T16:25:47Z',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.status, 'failing');
});

test('required-checks rollup: the PR #1434 real-world shape (2 cancelled, 1 failure, 1 success, same name) reports success', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'CANCELLED',
          completedAt: '2026-07-17T15:59:36Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'CANCELLED',
          completedAt: '2026-07-17T15:59:51Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'FAILURE',
          completedAt: '2026-07-17T16:00:06Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-17T16:25:47Z',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, true);
  assert.equal(summary.requiredChecks.status, 'success');
});

// #1504: at the time, ciStateTieRank (protocol-helpers.mts) special-cased
// only the two literal strings 'FAILURE' and 'CANCELLED'; this file's own
// wider FAILURE_STATES vocabulary (TIMED_OUT, ACTION_REQUIRED,
// STARTUP_FAILURE, STALE, ERROR) fell into the shared tie-break's generic
// rank-1 bucket, so a same-instant completedAt tie against a success-family
// state resolved by raw lexicographic comparison instead of "the failure
// should win". #1688 closed that shared corner: ciStateTieRank now ranks
// every CI_FAILURE_CONCLUSION_STATES member (which FAILURE_STATES above is
// derived from) at 0 directly, so these tests -- originally written to pin
// the #1504 local-only workaround -- now exercise the shared fix instead and
// still pass unchanged. These tests deliberately tie every pair at the
// identical completedAt to exercise that same-instant fallback specifically,
// unlike the #1478 tests above (which use strictly increasing timestamps to
// exercise latest-completedAt selection instead).
test('required-checks rollup: a same-instant TIMED_OUT vs success-family tie still reports failing', () => {
  for (const successConclusion of [
    'SUCCESS',
    'NEUTRAL',
    'SKIPPED',
    'NOT_APPLICABLE',
  ]) {
    const summary = buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [
          checkRun({
            name: 'idd-advisory-convergence',
            workflowName: 'ci',
            conclusion: 'TIMED_OUT',
            completedAt: '2026-07-17T16:25:47Z',
          }),
          checkRun({
            name: 'idd-advisory-convergence',
            workflowName: 'ci',
            conclusion: successConclusion,
            completedAt: '2026-07-17T16:25:47Z',
          }),
        ],
      },
      { requiredCheckNames: ['idd-advisory-convergence'] },
    );

    assert.equal(
      summary.requiredChecks.anyRequiredFailing,
      true,
      `expected a same-instant TIMED_OUT vs ${successConclusion} tie to report failing`,
    );
    assert.equal(summary.requiredChecks.allRequiredPassing, false);
    assert.equal(summary.requiredChecks.status, 'failing');
  }
});

test('required-checks rollup: a same-instant STARTUP_FAILURE/STALE vs success-family tie still reports failing', () => {
  for (const failureConclusion of ['STARTUP_FAILURE', 'STALE']) {
    for (const successConclusion of ['NEUTRAL', 'SKIPPED', 'NOT_APPLICABLE']) {
      const summary = buildCiWaitStateSummary(
        {
          headRefOid: HEAD_SHA,
          statusCheckRollup: [
            checkRun({
              name: 'idd-advisory-convergence',
              workflowName: 'ci',
              conclusion: failureConclusion,
              completedAt: '2026-07-17T16:25:47Z',
            }),
            checkRun({
              name: 'idd-advisory-convergence',
              workflowName: 'ci',
              conclusion: successConclusion,
              completedAt: '2026-07-17T16:25:47Z',
            }),
          ],
        },
        { requiredCheckNames: ['idd-advisory-convergence'] },
      );

      assert.equal(
        summary.requiredChecks.anyRequiredFailing,
        true,
        `expected a same-instant ${failureConclusion} vs ${successConclusion} tie to report failing`,
      );
      assert.equal(summary.requiredChecks.status, 'failing');
    }
  }
});

test('required-checks rollup: a same-instant ACTION_REQUIRED vs success-family tie still reports failing', () => {
  // The issue's own hand analysis found ACTION_REQUIRED already won a
  // same-instant tie against every success-family state before this fix,
  // by lexicographic happenstance (it starts with a letter earlier than
  // every success state's first letter). Covered here too for
  // completeness/symmetry with the other FAILURE_STATES members above,
  // and as a regression guard in case a future success-family addition
  // ever breaks that happenstance.
  for (const successConclusion of [
    'SUCCESS',
    'NEUTRAL',
    'SKIPPED',
    'NOT_APPLICABLE',
  ]) {
    const summary = buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [
          checkRun({
            name: 'idd-advisory-convergence',
            workflowName: 'ci',
            conclusion: 'ACTION_REQUIRED',
            completedAt: '2026-07-17T16:25:47Z',
          }),
          checkRun({
            name: 'idd-advisory-convergence',
            workflowName: 'ci',
            conclusion: successConclusion,
            completedAt: '2026-07-17T16:25:47Z',
          }),
        ],
      },
      { requiredCheckNames: ['idd-advisory-convergence'] },
    );

    assert.equal(
      summary.requiredChecks.anyRequiredFailing,
      true,
      `expected a same-instant ACTION_REQUIRED vs ${successConclusion} tie to report failing`,
    );
    assert.equal(summary.requiredChecks.status, 'failing');
  }
});

test('required-checks rollup: a same-instant StatusContext ERROR vs (CheckRun) success-family tie still reports failing', () => {
  // ERROR is StatusContext-only (a CheckRun never reports it as a
  // conclusion), so this exercises the actual StatusContext normalization
  // path -- and, since the paired success entry is a CheckRun, a genuine
  // cross-type tie under the same checkName (Copilot review, PR #1530;
  // the original version of this test fed ERROR through the generic
  // checkRun() CheckRun fixture, which never exercises the StatusContext
  // branch at all). completedAt must be set explicitly and identically on
  // both entries: normalizeCheckEntry defaults a StatusContext's
  // completedAt to '' when absent, which parses to a *missing* timestamp
  // -- isNewerCheckInstance's incomplete-always-wins branch would then
  // make ERROR win for the wrong reason (treated as still-running, never
  // reaching the #1504 tie-break rank comparison this test means to
  // cover) regardless of whether the tie-break fix works at all.
  for (const successConclusion of [
    'SUCCESS',
    'NEUTRAL',
    'SKIPPED',
    'NOT_APPLICABLE',
  ]) {
    const summary = buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [
          {
            __typename: 'StatusContext',
            context: 'idd-advisory-convergence',
            state: 'ERROR',
            targetUrl: '',
            completedAt: '2026-07-17T16:25:47Z',
          },
          checkRun({
            name: 'idd-advisory-convergence',
            workflowName: 'ci',
            conclusion: successConclusion,
            completedAt: '2026-07-17T16:25:47Z',
          }),
        ],
      },
      { requiredCheckNames: ['idd-advisory-convergence'] },
    );

    assert.equal(
      summary.requiredChecks.anyRequiredFailing,
      true,
      `expected a same-instant ERROR vs ${successConclusion} tie to report failing`,
    );
    assert.equal(summary.requiredChecks.status, 'failing');
    // Note: `summary.checks` is the raw, *not-deduped* list (dedup happens
    // only inside buildRequiredChecksRollup's internal
    // selectLatestCheckEntryPerName call), so it always has both entries
    // here regardless of which one wins the tie -- not a signal of which
    // instance was selected. The completedAt values above are explicit
    // and identical on both entries by construction, which is what
    // guarantees this exercises the rank-based tie-break rather than the
    // incomplete-always-wins path (see the comment at the top of this
    // test), independent of anything observable at runtime here.
  }
});

test('selectLatestCheckEntry: a same-instant tie between two distinct FAILURE_STATES members resolves deterministically regardless of input order', () => {
  // Originally added for Copilot review, PR #1530, when selectLatestCheckEntry
  // still normalized every failure-bucketed entry to the same literal
  // 'FAILURE' string before comparing (tieBreakState(), removed by #1688):
  // two *different* raw failure states (e.g. TIMED_OUT and STARTUP_FAILURE)
  // tied on both completedAt and normalized state, so an explicit pre-sort
  // was needed to keep the winner deterministic regardless of input order.
  // #1688 widened the shared `ciStateTieRank` itself to rank every
  // CI_FAILURE_CONCLUSION_STATES member at 0 directly, so selectLatestCheckEntry
  // no longer normalizes or pre-sorts at all -- it compares each entry's own
  // real `state`. The two raw states below now tie at rank 0 without ever
  // colliding on a shared normalized string, so the existing residual
  // fallback (lexicographically smallest raw state wins, matching this
  // tie-break's pre-#1504 argmin-by-value behavior) is naturally
  // order-independent again, and this test still pins that same fixed
  // winner. The winning instance's identity is not observable through
  // buildCiWaitStateSummary's public shape (see the note on the ERROR
  // test above), so this calls the exported reducer directly instead.
  const timedOut = {
    checkName: 'idd-advisory-convergence',
    workflowName: 'ci',
    type: 'check-run' as const,
    state: 'TIMED_OUT',
    status: 'failure' as const,
    required: true,
    url: 'https://example/timed-out',
    startedAt: '2026-07-17T16:00:00Z',
    completedAt: '2026-07-17T16:25:47Z',
  };
  const startupFailure = {
    checkName: 'idd-advisory-convergence',
    workflowName: 'ci',
    type: 'check-run' as const,
    state: 'STARTUP_FAILURE',
    status: 'failure' as const,
    required: true,
    url: 'https://example/startup-failure',
    startedAt: '2026-07-17T16:00:00Z',
    completedAt: '2026-07-17T16:25:47Z',
  };

  // 'STARTUP_FAILURE' < 'TIMED_OUT' lexicographically ('S' < 'T').
  assert.equal(
    selectLatestCheckEntry([timedOut, startupFailure]).state,
    'STARTUP_FAILURE',
  );
  assert.equal(
    selectLatestCheckEntry([startupFailure, timedOut]).state,
    'STARTUP_FAILURE',
  );
});

test('required-checks rollup: a same-instant CANCELLED vs SUCCESS tie still resolves to success (unchanged)', () => {
  // Guard against a regression in the #1504 fix: CANCELLED must keep
  // losing a same-instant tie exactly as it did before this fix (a
  // cancelled run reached no verdict, so it defers to a real success).
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'CANCELLED',
          completedAt: '2026-07-17T16:25:47Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-17T16:25:47Z',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, true);
  assert.equal(summary.requiredChecks.status, 'success');
});

test('required-checks rollup: a same-instant literal FAILURE vs SUCCESS tie still reports failing (unchanged)', () => {
  // Guard against a regression in the #1504 fix: the literal 'FAILURE'
  // conclusion already won a same-instant tie before this fix and must
  // still win it after.
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'FAILURE',
          completedAt: '2026-07-17T16:25:47Z',
        }),
        checkRun({
          name: 'idd-advisory-convergence',
          workflowName: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-17T16:25:47Z',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );

  assert.equal(summary.requiredChecks.anyRequiredFailing, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.status, 'failing');
});

// #1688 acceptance criterion: "ci-wait-state and classifyCiChecks agree on
// the failure-family vocabulary (asserted by a test that feeds both the
// same instances)". Feeds identical {name, state, completedAt} check
// instances into both classifyCiChecks (protocol-helpers.mts) and
// buildCiWaitStateSummary (this file) and asserts both report a failing
// outcome for every genuine failure-family conclusion (all six
// CI_FAILURE_CONCLUSION_STATES members: FAILURE, TIMED_OUT,
// ACTION_REQUIRED, STARTUP_FAILURE, STALE via the shared loop below, and
// ERROR via its own StatusContext-shaped assertion after the loop, since
// ERROR is StatusContext-only and the loop's CheckRun fixture cannot
// exercise it). CANCELLED is fed too, but asserted as the deliberate,
// documented exception: ci-wait-state still buckets a lone CANCELLED as
// failing for wait-gate purposes (its own local FAILURE_STATES includes
// it), while classifyCiChecks deliberately does not
// (CI_FAILURE_CONCLUSION_STATES excludes it, since a cancelled run reached
// no real verdict) -- so this pins the carve-out itself as a tested
// contract instead of only documenting it in prose.
test('classifyCiChecks and ci-wait-state agree on the failure-family vocabulary (fed the same instances)', () => {
  const completedAt = '2026-07-17T16:00:06Z';
  for (const failureState of [
    'FAILURE',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
  ]) {
    const classifyResult = classifyCiChecks([
      { name: 'gated', state: failureState, completedAt },
    ]);
    assert.equal(
      classifyResult.status,
      'failed',
      `expected classifyCiChecks to bucket a sole ${failureState} as failed`,
    );

    const waitSummary = buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [
          checkRun({
            name: 'gated',
            workflowName: 'ci',
            conclusion: failureState,
            completedAt,
          }),
        ],
      },
      { requiredCheckNames: ['gated'] },
    );
    assert.equal(
      waitSummary.requiredChecks.anyRequiredFailing,
      true,
      `expected ci-wait-state to bucket a sole ${failureState} as failing`,
    );
    assert.equal(waitSummary.requiredChecks.status, 'failing');
  }

  // CANCELLED: deliberate divergence, not agreement -- pin both sides.
  const classifyCancelled = classifyCiChecks([
    { name: 'gated', state: 'CANCELLED', completedAt },
  ]);
  assert.equal(
    classifyCancelled.status,
    'unknown',
    'classifyCiChecks deliberately does not bucket a sole CANCELLED as failed',
  );

  const waitCancelled = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'gated',
          workflowName: 'ci',
          conclusion: 'CANCELLED',
          completedAt,
        }),
      ],
    },
    { requiredCheckNames: ['gated'] },
  );
  assert.equal(
    waitCancelled.requiredChecks.anyRequiredFailing,
    true,
    'ci-wait-state deliberately still buckets a sole CANCELLED as failing',
  );
  assert.equal(waitCancelled.requiredChecks.status, 'failing');

  // ERROR: StatusContext-only (a CheckRun conclusion never reports it), so
  // it needs its own assertion outside the loop above -- the loop's
  // checkRun() fixture always builds a CheckRun-shaped entry (via
  // `conclusion`), which never exercises ci-wait-state's StatusContext
  // branch (`normalizeCheckEntry`'s `__typename === 'StatusContext'` path;
  // see the "a same-instant StatusContext ERROR..." test above). Copilot
  // review, PR #1735: the loop originally omitted ERROR from the
  // cross-module agreement claim entirely.
  const classifyError = classifyCiChecks([
    { name: 'gated', state: 'ERROR', completedAt },
  ]);
  assert.equal(
    classifyError.status,
    'failed',
    'expected classifyCiChecks to bucket a sole ERROR as failed',
  );

  const waitError = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        {
          __typename: 'StatusContext',
          context: 'gated',
          state: 'ERROR',
          targetUrl: '',
          completedAt,
        },
      ],
    },
    { requiredCheckNames: ['gated'] },
  );
  assert.equal(
    waitError.requiredChecks.anyRequiredFailing,
    true,
    'expected ci-wait-state to bucket a sole StatusContext ERROR as failing',
  );
  assert.equal(waitError.requiredChecks.status, 'failing');
});

test('required-checks rollup: a not-yet-generated required check reports missing, not vacuously passing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    { requiredCheckNames: ['lint', 'test'] },
  );

  assert.deepEqual(summary.requiredChecks.missingNames, ['test']);
  assert.equal(summary.requiredChecks.allRequiredPresent, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.status, 'missing');
});

test('required-checks rollup: no required checks configured is reported distinctly, not as passing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build' })],
    },
    { requiredCheckNames: [] },
  );

  assert.equal(summary.requiredChecks.status, 'no-required-checks');
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.names.length, 0);
  assert.equal(summary.requiredChecks.requiredCheckSourcePinned, false);
});

test('a source-pinned required check (empty names) reports source-pinned, never the vacuous no-required-checks pass', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build', conclusion: 'SUCCESS' })],
    },
    { requiredCheckNames: [], requiredCheckSourcePinned: true },
  );

  assert.equal(summary.requiredChecks.status, 'source-pinned');
  assert.equal(summary.requiredChecks.requiredCheckSourcePinned, true);
  assert.equal(summary.requiredChecks.allRequiredPresent, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

test('mixed source-pinned case: named required checks all pass, but never reports success while an unnamed source-pinned requirement is unverified', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    { requiredCheckNames: ['lint'], requiredCheckSourcePinned: true },
  );

  assert.equal(summary.requiredChecks.allRequiredPresent, true);
  assert.equal(summary.requiredChecks.anyRequiredFailing, false);
  assert.equal(summary.requiredChecks.anyRequiredPending, false);
  // The critical assertion: never a vacuous success/allRequiredPassing while
  // requiredCheckSourcePinned is true, even though the one named check passed.
  assert.equal(summary.requiredChecks.status, 'source-pinned');
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

// #1689: without this knob, a D-phase CI-wait caller polling `ci-wait-state`
// after F2/F3 already opted in via `ciGate.trustSourcePinnedRequiredChecks`
// would still see `status: 'source-pinned'` forever and never reach
// idd-ci.instructions.md's on-success route -- moving the same livelock
// #1689 fixes in pre-merge-readiness.mts one phase earlier instead of
// removing it. `trustSourcePinnedRequiredChecks: true` must let the named,
// present, and passing case report `success`.
test('trustSourcePinnedRequiredChecks opts the named/present/passing mixed case into success', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    {
      requiredCheckNames: ['lint'],
      requiredCheckSourcePinned: true,
      trustSourcePinnedRequiredChecks: true,
    },
  );

  assert.equal(summary.requiredChecks.status, 'success');
  assert.equal(summary.requiredChecks.allRequiredPassing, true);
});

// The knob must not relax the fully-unnamed pinned case: there is no check
// name to correlate with a live run at all, so it stays unconditionally
// conservative regardless of the opt-in.
test('trustSourcePinnedRequiredChecks does not relax the unnamed (empty names) source-pinned case', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build', conclusion: 'SUCCESS' })],
    },
    {
      requiredCheckNames: [],
      requiredCheckSourcePinned: true,
      trustSourcePinnedRequiredChecks: true,
    },
  );

  assert.equal(summary.requiredChecks.status, 'source-pinned');
  assert.equal(summary.requiredChecks.allRequiredPresent, false);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

// #1689: a mixed shape -- a named-and-present-and-passing required check
// alongside a SEPARATE unresolved pinned source (e.g. a ruleset
// `workflows` rule with no enumerable check name). The opt-in must not
// bypass the downgrade here even though the named check alone would
// qualify: `requiredCheckSourcePinnedUnresolved: true` means there is no
// check name to correlate the unresolved pinning with a live run at all.
test('trustSourcePinnedRequiredChecks does not relax a mixed named-check-plus-unresolved-pin case', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    {
      requiredCheckNames: ['lint'],
      requiredCheckSourcePinned: true,
      requiredCheckSourcePinnedUnresolved: true,
      trustSourcePinnedRequiredChecks: true,
    },
  );

  assert.equal(summary.requiredChecks.status, 'source-pinned');
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

test('all required checks passing reports allRequiredPassing and status success', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
        checkRun({ name: 'test', workflowName: 'ci', conclusion: 'SKIPPED' }),
      ],
    },
    { requiredCheckNames: ['lint', 'test'] },
  );

  assert.equal(summary.requiredChecks.allRequiredPassing, true);
  assert.equal(summary.requiredChecks.status, 'success');
});

test('a StatusContext entry is normalized alongside CheckRun entries', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        {
          __typename: 'StatusContext',
          context: 'CodeRabbit',
          state: 'SUCCESS',
          targetUrl: '',
          startedAt: '2026-07-09T00:00:00Z',
        },
      ],
    },
    { requiredCheckNames: [] },
  );

  assert.equal(summary.checks.length, 1);
  assert.equal(summary.checks[0]?.type, 'status-context');
  assert.equal(summary.checks[0]?.checkName, 'CodeRabbit');
  assert.equal(summary.checks[0]?.workflowName, '');
  assert.equal(summary.checks[0]?.status, 'success');
});

test('reports the live headRefOid unchanged, for caller-side HEAD-drift detection', () => {
  const summary = buildCiWaitStateSummary(
    { headRefOid: HEAD_SHA, statusCheckRollup: [] },
    { requiredCheckNames: [] },
  );
  assert.equal(summary.headRefOid, HEAD_SHA);
});

test('a failure-family state (cancelled/timed_out/action_required/stale) buckets as failure, not unknown', () => {
  for (const conclusion of [
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'STALE',
  ]) {
    const summary = buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [checkRun({ name: 'lint', conclusion })],
      },
      { requiredCheckNames: [] },
    );
    assert.equal(
      summary.checks[0]?.status,
      'failure',
      `expected ${conclusion} to bucket as failure`,
    );
  }
});

test('a genuinely unrecognized state buckets as unknown and marks the rollup unknown, not passing', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', status: 'COMPLETED', conclusion: 'WEIRD' }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(summary.checks[0]?.status, 'unknown');
  assert.equal(summary.requiredChecks.anyRequiredUnknown, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
  assert.equal(summary.requiredChecks.status, 'pending');
});

test('a StatusContext ERROR state buckets as failure, distinct from FAILURE but equally blocking', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        {
          __typename: 'StatusContext',
          context: 'external-check',
          state: 'ERROR',
          targetUrl: '',
        },
      ],
    },
    { requiredCheckNames: ['external-check'] },
  );
  assert.equal(summary.checks[0]?.status, 'failure');
  assert.equal(summary.requiredChecks.anyRequiredFailing, true);
  assert.equal(summary.requiredChecks.status, 'failing');
});

test('workflowName is trimmed so whitespace-only differences do not produce spurious distinct entries', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'lint',
          workflowName: '  ci  ',
          conclusion: 'SUCCESS',
        }),
      ],
    },
    { requiredCheckNames: [] },
  );
  assert.equal(summary.checks[0]?.workflowName, 'ci');
});

// No separate "importing ci-wait-state.mts has no import-time side effect"
// dynamic-import test here: this file already statically imports
// buildCiWaitStateSummary from ci-wait-state.mts above, so a later dynamic
// `import('../src/scripts/ci-wait-state.mts')` would just return the
// already-cached module and re-run no top-level code, making that assertion
// vacuous — it would pass even if the `import.meta.main` guard were
// removed. ci-wait-policy.test.mts (a fellow builder+CLI single-file
// helper whose test file statically imports its builder functions too)
// follows the same precedent and omits this test for the same reason.

// --- #3300: unreadable protection/ruleset reads -----------------------

test('isProtectionReadUnreadable: an ok outcome is always readable, regardless of the opt-in', () => {
  assert.equal(
    isProtectionReadUnreadable({ outcome: 'ok', value: [] }, false),
    false,
  );
  assert.equal(
    isProtectionReadUnreadable({ outcome: 'ok', value: [] }, true),
    false,
  );
});

test('isProtectionReadUnreadable: a not-found outcome is unreadable unless the opt-in is set', () => {
  assert.equal(
    isProtectionReadUnreadable({ outcome: 'not-found' }, false),
    true,
  );
  assert.equal(
    isProtectionReadUnreadable({ outcome: 'not-found' }, true),
    false,
  );
});

test('required-checks rollup: an unreadable protection/ruleset read reports status unreadable even when every named required check passes', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    { requiredCheckNames: ['lint'], protectionReadsUnreadable: true },
  );

  assert.equal(summary.requiredChecks.protectionReadsUnreadable, true);
  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

test('required-checks rollup: protectionReadsUnreadable false (the trustEmptyProtectionReads opt-in case) yields the pre-#3300 status unchanged', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    { requiredCheckNames: ['lint'], protectionReadsUnreadable: false },
  );

  assert.equal(summary.requiredChecks.protectionReadsUnreadable, false);
  assert.equal(summary.requiredChecks.status, 'success');
  assert.equal(summary.requiredChecks.allRequiredPassing, true);
});

test('required-checks rollup: protectionReadsUnreadable defaults to false when omitted, matching every pre-#3300 caller', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build' })],
    },
    { requiredCheckNames: [] },
  );

  assert.equal(summary.requiredChecks.protectionReadsUnreadable, false);
  assert.equal(summary.requiredChecks.status, 'no-required-checks');
});

test('required-checks rollup: unreadable takes precedence over the empty-names no-required-checks status', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build', conclusion: 'SUCCESS' })],
    },
    { requiredCheckNames: [], protectionReadsUnreadable: true },
  );

  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.equal(summary.requiredChecks.protectionReadsUnreadable, true);
  assert.equal(summary.requiredChecks.allRequiredPassing, false);
});

test('required-checks rollup: unreadable takes precedence over the empty-names source-pinned status', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'build', conclusion: 'SUCCESS' })],
    },
    {
      requiredCheckNames: [],
      requiredCheckSourcePinned: true,
      protectionReadsUnreadable: true,
    },
  );

  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.equal(summary.requiredChecks.requiredCheckSourcePinned, true);
});

test('required-checks rollup: unreadable takes precedence over a failing required check', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'FAILURE' }),
      ],
    },
    { requiredCheckNames: ['lint'], protectionReadsUnreadable: true },
  );

  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.equal(summary.requiredChecks.anyRequiredFailing, true);
});

test('required-checks rollup: unreadable takes precedence over a not-yet-generated (missing) required check', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', workflowName: 'ci', conclusion: 'SUCCESS' }),
      ],
    },
    {
      requiredCheckNames: ['lint', 'test'],
      protectionReadsUnreadable: true,
    },
  );

  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.deepEqual(summary.requiredChecks.missingNames, ['test']);
  assert.equal(summary.requiredChecks.allRequiredPresent, false);
});

// --- #3300 (Copilot review, PR #3350): end-to-end coverage for
// collectCiWaitState's own orchestration -- trusted-config-ref resolution
// and the ciGate.trustEmptyProtectionReads opt-in -- via
// createFakeProviderAdapter, mirroring pre-merge-readiness.mts's
// collectPreMergeReadiness fake-provider smoke tests. Before this, only the
// pure functions above (isProtectionReadUnreadable, buildCiWaitStateSummary)
// had a test seam; main()'s own wiring (choosing trustedConfigRef, applying
// the opt-in) had none.

test('collectCiWaitState against a fake provider: an unreadable governance read reports status unreadable with no gh process spawned', () => {
  const port = createFakeProviderAdapter({
    changeRequestBranchAndChecks: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: 'main',
        statusCheckRollup: [],
      },
    },
    // branchRules/branchProtection deliberately omit the 'o/r/main' key,
    // so listBranchRules/getBranchProtection both report {outcome:
    // 'not-found'} -- the masked-403-as-404 case this issue fixes.
  });

  const summary = collectCiWaitState(
    ['--pr', '42', '--owner', 'o', '--repo', 'r'],
    () => port,
    // trustEmptyProtectionReads defaults to false (absent), matching the
    // pre-#3300 conservative default.
    () => ({}),
  );

  assert.equal(summary.requiredChecks.protectionReadsUnreadable, true);
  assert.equal(summary.requiredChecks.status, 'unreadable');
});

test('collectCiWaitState against a fake provider: ciGate.trustEmptyProtectionReads from the trusted config suppresses the unreadable status', () => {
  const port = createFakeProviderAdapter({
    changeRequestBranchAndChecks: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: 'main',
        statusCheckRollup: [],
      },
    },
    // Same missing-fixture shape as the previous test -- only the
    // trusted-config opt-in differs.
  });

  let loadTrustedConfigCalledWithRef: string | null = null;
  const summary = collectCiWaitState(
    ['--pr', '42', '--owner', 'o', '--repo', 'r'],
    () => port,
    (_owner, _repo, ref) => {
      loadTrustedConfigCalledWithRef = ref;
      return { ciGate: { trustEmptyProtectionReads: true } };
    },
  );

  // The config read must use the PR's actual base ref ('main'), the trust
  // boundary #2373/#3300 require -- never the PR worktree's own local copy.
  assert.equal(loadTrustedConfigCalledWithRef, 'main');
  assert.equal(summary.requiredChecks.protectionReadsUnreadable, false);
  assert.equal(summary.requiredChecks.status, 'no-required-checks');
});

test('collectCiWaitState against a fake provider: an empty baseRefName falls back to the repository default branch for the trusted config read, while the governance reads themselves still key on the empty ref (fail closed)', () => {
  // Regression test for the exact asymmetry a Copilot review on PR #3350
  // flagged: listBranchRules/getBranchProtection intentionally keep using
  // the PR's own (possibly empty) baseRefName -- never the default-branch
  // fallback, which would read protection for the wrong branch -- so an
  // empty baseRefName still resolves the trusted CONFIG ref via the
  // fallback, but the governance reads themselves come back unreadable
  // (fail closed), never a silent "nothing configured" pass.
  const port = createFakeProviderAdapter({
    changeRequestBranchAndChecks: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: '',
        statusCheckRollup: [],
      },
    },
    repositoryDefaultBranch: 'main',
    // branchRules/branchProtection omit the 'o/r/' (empty-ref) key, so both
    // governance reads report not-found.
  });

  let loadTrustedConfigCalledWithRef: string | null = null;
  const summary = collectCiWaitState(
    ['--pr', '42', '--owner', 'o', '--repo', 'r'],
    () => port,
    (_owner, _repo, ref) => {
      loadTrustedConfigCalledWithRef = ref;
      return {};
    },
  );

  assert.equal(loadTrustedConfigCalledWithRef, 'main');
  assert.equal(summary.requiredChecks.protectionReadsUnreadable, true);
  assert.equal(summary.requiredChecks.status, 'unreadable');
});

test('collectCiWaitState against a fake provider: an empty baseRefName with no resolvable default branch fails closed with a thrown error', () => {
  const port = createFakeProviderAdapter({
    changeRequestBranchAndChecks: {
      42: {
        headSha: 'a'.repeat(40),
        baseRefName: '',
        statusCheckRollup: [],
      },
    },
    // repositoryDefaultBranch omitted -> getRepositoryDefaultBranch returns
    // null, so no trusted ref can be resolved at all.
  });

  assert.throws(
    () =>
      collectCiWaitState(
        ['--pr', '42', '--owner', 'o', '--repo', 'r'],
        () => port,
        () => ({}),
      ),
    /cannot resolve a trusted ref for \.github\/idd\/config\.json/,
  );
});

test('#3465: pre-merge CI predicate follows required-check success, pending, failure, and a non-required failure', () => {
  const passing = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', conclusion: 'SUCCESS' }),
        checkRun({ name: 'docs', conclusion: 'FAILURE' }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(passing), true);

  const failing = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'lint', conclusion: 'FAILURE' })],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(failing), false);

  const pending = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', status: 'IN_PROGRESS', conclusion: '' }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(pending), false);

  const unreadable = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'lint', conclusion: 'SUCCESS' })],
    },
    { requiredCheckNames: ['lint'], protectionReadsUnreadable: true },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(unreadable), false);

  const sourcePinned = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'lint', conclusion: 'SUCCESS' })],
    },
    {
      requiredCheckNames: ['lint'],
      requiredCheckSourcePinned: true,
    },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(sourcePinned), false);

  const noRequired = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'ci', conclusion: 'SUCCESS' })],
    },
    {},
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(noRequired), true);

  const staleFailureThenSuccess = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'ci',
          conclusion: 'FAILURE',
          completedAt: '2026-07-09T00:01:00Z',
        }),
        checkRun({
          name: 'ci',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-09T00:05:00Z',
        }),
      ],
    },
    {},
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(staleFailureThenSuccess), true);

  const otherProducerStillFailing = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'ci',
          workflowName: 'push',
          conclusion: 'FAILURE',
          completedAt: '2026-07-09T00:01:00Z',
        }),
        checkRun({
          name: 'ci',
          workflowName: 'merge',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-09T00:05:00Z',
        }),
      ],
    },
    {},
  );
  assert.equal(
    ciWaitSummaryIsPreMergeCiPassing(otherProducerStillFailing),
    false,
  );
});

test('#3465: a later success from another workflow does not hide a required failure', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'lint',
          workflowName: 'push',
          conclusion: 'FAILURE',
          completedAt: '2026-07-09T00:01:00Z',
        }),
        checkRun({
          name: 'lint',
          workflowName: 'merge',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-09T00:05:00Z',
        }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false);
});

test('#3465: a raw required-check failure refuses without consulting waivers', () => {
  // collectCiWaitState does not read external-check waivers. A failing
  // required check stays non-passing for the watermark gate even when a
  // later pre-merge pass would treat a valid waiver as covered.
  const failing = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'lint', conclusion: 'FAILURE' })],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(failing), false);
});

test('#3465: a green advisory-convergence rollup still refuses when readiness would downgrade it', () => {
  const green = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          conclusion: 'SUCCESS',
        }),
      ],
    },
    { requiredCheckNames: ['idd-advisory-convergence'] },
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(green), true);

  assert.equal(
    ciWaitSummaryIsPreMergeCiPassing({
      ...green,
      advisoryConvergenceNonTargetEventOnly: true,
    }),
    false,
  );
  assert.equal(
    ciWaitSummaryIsPreMergeCiPassing({
      ...green,
      advisoryConvergenceIdentityUnresolved: true,
    }),
    false,
  );

  const lintOnly = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [checkRun({ name: 'lint', conclusion: 'SUCCESS' })],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(
    ciWaitSummaryIsPreMergeCiPassing({
      ...lintOnly,
      advisoryConvergenceNonTargetEventOnly: true,
    }),
    true,
  );

  const presentRun = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'idd-advisory-convergence',
          conclusion: 'SUCCESS',
        }),
      ],
    },
    {},
  );
  assert.equal(
    ciWaitSummaryIsPreMergeCiPassing({
      ...presentRun,
      advisoryConvergenceNonTargetEventOnly: true,
    }),
    false,
  );
});

test('#3465: collectCiWaitState records a non-target advisory pass and a qualifying target pass', () => {
  const headSha = 'b'.repeat(40);
  const detailsUrl = 'https://github.com/o/r/actions/runs/99/job/1';
  const rollup = [
    {
      __typename: 'CheckRun',
      name: 'idd-advisory-convergence',
      status: 'COMPLETED',
      conclusion: 'SUCCESS',
      workflowName: 'IDD advisory-convergence gate',
      detailsUrl,
      startedAt: '2026-07-09T00:00:00Z',
      completedAt: '2026-07-09T00:05:00Z',
    },
  ];
  const governance = {
    branchRules: { 'o/r/main': [] },
    branchProtection: {
      'o/r/main': {
        required_status_checks: { contexts: ['idd-advisory-convergence'] },
      },
    },
  };
  const collect = (event: string) =>
    collectCiWaitState(
      ['--pr', '42', '--owner', 'o', '--repo', 'r'],
      () =>
        createFakeProviderAdapter({
          changeRequestBranchAndChecks: {
            42: { headSha, baseRefName: 'main', statusCheckRollup: rollup },
          },
          ...governance,
          checkRunWorkflowPaths: {
            [`o/r/${headSha}/idd-advisory-convergence`]: [
              {
                detailsUrl,
                workflowPath: '.github/workflows/idd-advisory-convergence.yml',
                event,
              },
            ],
          },
        }),
      () => ({}),
    );

  const nonTarget = collect('pull_request');
  assert.equal(nonTarget.advisoryConvergenceNonTargetEventOnly, true);
  assert.equal(nonTarget.advisoryConvergenceIdentityUnresolved, false);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(nonTarget), false);

  const qualifying = collect('pull_request_target');
  assert.equal(qualifying.advisoryConvergenceNonTargetEventOnly, false);
  assert.equal(
    qualifying.checks[0]?.workflowPath,
    '.github/workflows/idd-advisory-convergence.yml',
  );
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(qualifying), true);
});

test('#3465: latestPassingCompletedAt ignores sentinel and malformed passing timestamps', () => {
  const summary = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'lint',
          conclusion: 'SUCCESS',
          completedAt: '0001-01-01T00:00:00Z',
        }),
        checkRun({
          name: 'docs',
          conclusion: 'SUCCESS',
          completedAt: 'not-a-timestamp',
        }),
        checkRun({
          name: 'build',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-09T00:05:00Z',
        }),
      ],
    },
    {},
  );
  assert.equal(latestPassingCompletedAt(summary), '2026-07-09T00:05:00Z');

  const onlyInvalid = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'lint',
          conclusion: 'SUCCESS',
          completedAt: '0001-01-01T00:00:00Z',
        }),
      ],
    },
    {},
  );
  assert.equal(latestPassingCompletedAt(onlyInvalid), 'none');

  const fractional = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'lint',
          conclusion: 'SUCCESS',
          completedAt: '2026-06-25T11:00:00Z',
        }),
        checkRun({
          name: 'docs',
          conclusion: 'SUCCESS',
          completedAt: '2026-06-25T11:00:00.123Z',
        }),
      ],
    },
    {},
  );
  assert.equal(
    latestPassingCompletedAt(fractional),
    '2026-06-25T11:00:00.123Z',
  );
});
