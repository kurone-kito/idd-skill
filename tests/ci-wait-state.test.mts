import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildCiWaitStateSummary,
  parseArgs,
  selectLatestCheckEntry,
} from '../src/scripts/ci-wait-state.mts';
import { classifyCiChecks } from '../src/scripts/protocol-helpers.mts';

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
