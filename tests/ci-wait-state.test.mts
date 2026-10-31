import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildCiWaitStateSummary,
  ciWaitSummaryIsPreMergeCiPassing,
  collectCiWaitState,
  isProtectionReadUnreadable,
  latestPassingCompletedAt,
  parseArgs,
  requiredCiHeadAgreementFromSummary,
  selectLatestCheckEntry,
} from '../src/scripts/ci-wait-state.mts';
import type { ActivationResult } from '../src/scripts/idd-activation.mts';
import {
  CHECK_PASS_EQUIVALENT_STATES,
  classifyCiChecks,
  isPreMergeCiAllPassing,
} from '../src/scripts/protocol-helpers.mts';
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
  // branch at all). Completion time must be set explicitly and identically
  // on both entries: normalizeCheckEntry maps a StatusContext's updatedAt to
  // its normalized completedAt; if updatedAt is absent, the normalized
  // timestamp parses to a *missing* timestamp
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
            updatedAt: '2026-07-17T16:25:47Z',
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
    // instance was selected. The raw updatedAt/completedAt values above
    // normalize to explicit, identical completion times by construction,
    // which guarantees this exercises the rank-based tie-break rather than the
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
          updatedAt: completedAt,
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
          updatedAt: '2026-07-09T00:05:00Z',
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
  assert.equal(summary.checks[0]?.completedAt, '2026-07-09T00:05:00Z');
});

test('mixed rollup selects the latest completion time independent of row order', () => {
  const earlier = '2026-07-09T00:04:00Z';
  const later = '2026-07-09T00:05:00Z';

  const statusContextWins = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({
          name: 'mixed-check',
          conclusion: 'FAILURE',
          completedAt: earlier,
        }),
        {
          __typename: 'StatusContext',
          context: 'mixed-check',
          state: 'SUCCESS',
          targetUrl: '',
          updatedAt: later,
        },
      ],
    },
    { requiredCheckNames: ['mixed-check'] },
  );

  assert.deepEqual(
    statusContextWins.checks.map(({ type, completedAt }) => ({
      type,
      completedAt,
    })),
    [
      { type: 'check-run', completedAt: earlier },
      { type: 'status-context', completedAt: later },
    ],
  );
  assert.equal(statusContextWins.requiredChecks.allRequiredPassing, true);
  assert.equal(statusContextWins.requiredChecks.status, 'success');

  const checkRunWins = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        {
          __typename: 'StatusContext',
          context: 'mixed-check',
          state: 'ERROR',
          targetUrl: '',
          completedAt: earlier,
        },
        checkRun({
          name: 'mixed-check',
          conclusion: 'SUCCESS',
          completedAt: later,
        }),
      ],
    },
    { requiredCheckNames: ['mixed-check'] },
  );

  assert.deepEqual(
    checkRunWins.checks.map(({ type, completedAt }) => ({
      type,
      completedAt,
    })),
    [
      { type: 'status-context', completedAt: earlier },
      { type: 'check-run', completedAt: later },
    ],
  );
  assert.equal(checkRunWins.requiredChecks.allRequiredPassing, true);
  assert.equal(checkRunWins.requiredChecks.status, 'success');
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

// --- #3670: the agreement names why CI is not passing ------------------------

test('#3670: the agreement carries noRequiredChecksConfigured and the blocking present runs', () => {
  const agreementFor = (
    statusCheckRollup: ReturnType<typeof checkRun>[],
    options: Parameters<typeof buildCiWaitStateSummary>[1] = {},
    overrides: Record<string, unknown> = {},
  ) =>
    requiredCiHeadAgreementFromSummary({
      ...buildCiWaitStateSummary(
        { headRefOid: HEAD_SHA, statusCheckRollup },
        options,
      ),
      ...overrides,
    });

  // No required check plus a failing non-required run: the run is named.
  const failing = agreementFor([
    checkRun({ name: 'lint', conclusion: 'SUCCESS' }),
    checkRun({ name: 'docs', conclusion: 'FAILURE' }),
  ]);
  assert.equal(failing.requiredChecksPassing, false);
  assert.equal(failing.noRequiredChecksConfigured, true);
  assert.deepEqual(failing.blockingPresentRunNames, ['docs']);

  // Several blocking runs are sorted, and two failing runs that share a name
  // (different workflows) are listed once.
  const several = agreementFor([
    checkRun({ name: 'zeta', conclusion: 'FAILURE', workflowName: 'push' }),
    checkRun({ name: 'zeta', conclusion: 'FAILURE', workflowName: 'merge' }),
    checkRun({ name: 'alpha', conclusion: 'TIMED_OUT' }),
    checkRun({ name: 'mid', conclusion: 'SUCCESS' }),
  ]);
  assert.deepEqual(several.blockingPresentRunNames, ['alpha', 'zeta']);

  // A still-running or cancelled-only run set blocks nothing by name.
  const pending = agreementFor([
    checkRun({ name: 'ci', status: 'IN_PROGRESS', conclusion: '' }),
  ]);
  assert.equal(pending.requiredChecksPassing, false);
  assert.equal(pending.noRequiredChecksConfigured, true);
  assert.deepEqual(pending.blockingPresentRunNames, []);
  const cancelledOnly = agreementFor([
    checkRun({ name: 'ci', conclusion: 'CANCELLED' }),
  ]);
  assert.equal(cancelledOnly.noRequiredChecksConfigured, true);
  assert.deepEqual(cancelledOnly.blockingPresentRunNames, []);

  // Every present run passing is not blocked, and names nothing.
  const passing = agreementFor([
    checkRun({ name: 'ci', conclusion: 'SUCCESS' }),
  ]);
  assert.equal(passing.requiredChecksPassing, true);
  assert.equal(passing.noRequiredChecksConfigured, true);
  assert.deepEqual(passing.blockingPresentRunNames, []);

  // With a required check configured the names stay empty, even beside a
  // failing non-required run, so the required-checks text is what applies.
  const required = agreementFor(
    [
      checkRun({ name: 'lint', conclusion: 'FAILURE' }),
      checkRun({ name: 'docs', conclusion: 'FAILURE' }),
    ],
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(required.requiredChecksPassing, false);
  assert.equal(required.noRequiredChecksConfigured, false);
  assert.deepEqual(required.blockingPresentRunNames, []);
});

test('#4803: the PR base ref read with the head reaches the required-CI agreement', () => {
  const green = [checkRun({ name: 'lint', conclusion: 'SUCCESS' })];
  const summary = buildCiWaitStateSummary(
    { headRefOid: HEAD_SHA, statusCheckRollup: green },
    {},
  );
  assert.equal(requiredCiHeadAgreementFromSummary(summary).baseRefName, '');
  assert.equal(
    requiredCiHeadAgreementFromSummary({ ...summary, baseRefName: 'main' })
      .baseRefName,
    'main',
  );
  assert.equal(
    requiredCiHeadAgreementFromSummary({
      ...summary,
      baseRefName: '  release/x  ',
    }).baseRefName,
    'release/x',
  );
});

test('#3670: a green advisory-convergence run the downgrade blocks is named as blocking', () => {
  const green = [
    checkRun({ name: 'idd-advisory-convergence', conclusion: 'SUCCESS' }),
    checkRun({ name: 'lint', conclusion: 'SUCCESS' }),
  ];
  const summary = buildCiWaitStateSummary(
    { headRefOid: HEAD_SHA, statusCheckRollup: green },
    {},
  );

  const clean = requiredCiHeadAgreementFromSummary(summary);
  assert.equal(clean.requiredChecksPassing, true);
  assert.deepEqual(clean.blockingPresentRunNames, []);

  for (const flag of [
    'advisoryConvergenceNonTargetEventOnly',
    'advisoryConvergenceIdentityUnresolved',
  ] as const) {
    const downgraded = requiredCiHeadAgreementFromSummary({
      ...summary,
      [flag]: true,
    });
    assert.equal(downgraded.requiredChecksPassing, false, flag);
    assert.equal(downgraded.noRequiredChecksConfigured, true, flag);
    assert.deepEqual(
      downgraded.blockingPresentRunNames,
      ['idd-advisory-convergence'],
      flag,
    );
  }

  // A failing run beside the downgraded one is a second, separate cause.
  const both = requiredCiHeadAgreementFromSummary({
    ...buildCiWaitStateSummary(
      {
        headRefOid: HEAD_SHA,
        statusCheckRollup: [
          ...green,
          checkRun({ name: 'docs', conclusion: 'FAILURE' }),
        ],
      },
      {},
    ),
    advisoryConvergenceNonTargetEventOnly: true,
  });
  assert.deepEqual(both.blockingPresentRunNames, [
    'docs',
    'idd-advisory-convergence',
  ]);
});

// --- #4349: F2's no-required-checks path ignores a non-required
// action_required run. The pass predicate, the `ci-wait-state` rollup, and the
// watermark agreement all reach the same answer. A required action_required
// run keeps failing on the required-check path, and a non-required failure
// keeps holding.

test('#4349: with no required checks, a non-required action_required run does not hold the pass predicate', () => {
  const summaryFor = (
    statusCheckRollup: ReturnType<typeof checkRun>[],
    options: Parameters<typeof buildCiWaitStateSummary>[1] = {},
  ) =>
    buildCiWaitStateSummary(
      { headRefOid: HEAD_SHA, statusCheckRollup },
      options,
    );
  const gatedCompanion = checkRun({
    name: 'idd-advisory-convergence-comment',
    conclusion: 'ACTION_REQUIRED',
  });

  // Beside a passing run, the gated companion no longer holds F2.
  const beside = summaryFor([
    checkRun({ name: 'lint', conclusion: 'SUCCESS' }),
    gatedCompanion,
  ]);
  assert.equal(beside.requiredChecks.status, 'no-required-checks');
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(beside), true);
  const besideAgreement = requiredCiHeadAgreementFromSummary(beside);
  assert.equal(besideAgreement.requiredChecksPassing, true);
  assert.deepEqual(besideAgreement.blockingPresentRunNames, []);

  // A sole gated run is ignored, so nothing has run: the vacuous-green hold
  // stays, and the run is not named as a failure.
  const sole = summaryFor([gatedCompanion]);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(sole), false);
  const soleAgreement = requiredCiHeadAgreementFromSummary(sole);
  assert.equal(soleAgreement.requiredChecksPassing, false);
  assert.deepEqual(soleAgreement.blockingPresentRunNames, []);

  // A non-required failure still holds, and is the only run named.
  const failing = summaryFor([
    gatedCompanion,
    checkRun({ name: 'docs', conclusion: 'FAILURE' }),
  ]);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(failing), false);
  assert.deepEqual(
    requiredCiHeadAgreementFromSummary(failing).blockingPresentRunNames,
    ['docs'],
  );

  // A sole non-required failure holds.
  const soleFailure = summaryFor([
    checkRun({ name: 'docs', conclusion: 'FAILURE' }),
  ]);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(soleFailure), false);
  assert.deepEqual(
    requiredCiHeadAgreementFromSummary(soleFailure).blockingPresentRunNames,
    ['docs'],
  );
});

test('#4349: with no required checks, a sole waiting run waits and is not named as failing', () => {
  const agreementFor = (statusCheckRollup: Record<string, unknown>[]) => {
    const summary = buildCiWaitStateSummary(
      { headRefOid: HEAD_SHA, statusCheckRollup },
      {},
    );
    assert.equal(summary.requiredChecks.status, 'no-required-checks');
    return {
      passing: ciWaitSummaryIsPreMergeCiPassing(summary),
      names:
        requiredCiHeadAgreementFromSummary(summary).blockingPresentRunNames,
    };
  };

  // A running check run waits (not passing, not named).
  assert.deepEqual(
    agreementFor([
      checkRun({ name: 'ci', status: 'IN_PROGRESS', conclusion: '' }),
    ]),
    { passing: false, names: [] },
  );
  // A commit status still pending waits too; it is not read as failing.
  for (const state of ['PENDING', 'EXPECTED', 'REQUESTED']) {
    assert.deepEqual(
      agreementFor([{ __typename: 'StatusContext', context: 'ci/ext', state }]),
      { passing: false, names: [] },
      state,
    );
  }
  // A pending commit status beside a failing one is held on the failure.
  assert.deepEqual(
    agreementFor([
      { __typename: 'StatusContext', context: 'ci/ext', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/docs', state: 'FAILURE' },
    ]),
    { passing: false, names: ['ci/docs'] },
  );
});

test('#4349: a required action_required run still fails on the required-check path', () => {
  const required = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', conclusion: 'ACTION_REQUIRED' }),
        checkRun({ name: 'docs', conclusion: 'SUCCESS' }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(required.requiredChecks.status, 'failing');
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(required), false);

  // A non-required action_required run beside a passing required check is not
  // part of the required-check gate at all.
  const nonRequired = buildCiWaitStateSummary(
    {
      headRefOid: HEAD_SHA,
      statusCheckRollup: [
        checkRun({ name: 'lint', conclusion: 'SUCCESS' }),
        checkRun({ name: 'docs', conclusion: 'ACTION_REQUIRED' }),
      ],
    },
    { requiredCheckNames: ['lint'] },
  );
  assert.equal(nonRequired.requiredChecks.status, 'success');
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(nonRequired), true);
});

// --- #4053: the zero-check global-only opt-in on the E1 watermark path. The
// pass predicate, the `ci-wait-state` JSON the E1 precondition reads, and the
// watermark agreement all reach the same answer. The setting passes only the
// named region (zero required checks, no present run, active profile); every
// MUST-KEEP shape keeps deferring.

const GLOBAL_ONLY_HEAD = 'c'.repeat(40);
const GLOBAL_ONLY_OPT_IN = 'ciGate.allowNoRequiredChecksInGlobalOnly';
const ADVISORY_CHECK = 'idd-advisory-convergence';
const ADVISORY_WORKFLOW = '.github/workflows/idd-advisory-convergence.yml';
const GLOBAL_ONLY_ACTIVE: ActivationResult = {
  active: true,
  tier: 'user-global-override',
  instructionsRoot: '/payload/idd',
  reason: 'repository-policy-minimal-import',
};
const REPOSITORY_LOCAL_ACTIVATION: ActivationResult = {
  active: true,
  tier: 'repository-local',
  instructionsRoot: '/repo/.github/instructions',
  reason: 'repository-instruction-files',
};

interface GlobalOnlyPortOptions {
  rollup?: unknown[];
  /** `null` leaves both governance reads absent, so they are unreadable. */
  branchRules?: unknown[] | null;
  /** Plants the advisory workflow file at this ref, so the profile is inactive. */
  workflowAt?: string;
}

function globalOnlyPort(options: GlobalOnlyPortOptions = {}) {
  const readable = options.branchRules !== null;
  return createFakeProviderAdapter({
    changeRequestBranchAndChecks: {
      42: {
        headSha: GLOBAL_ONLY_HEAD,
        baseRefName: 'main',
        statusCheckRollup: options.rollup ?? [],
      },
    },
    branchRules: readable ? { 'o/r/main': options.branchRules ?? [] } : {},
    branchProtection: readable ? { 'o/r/main': {} } : {},
    // The root listing must read back as an array on both the trusted ref and
    // the head SHA, so `baseWorkflowAbsentAt` proves absence.
    repositoryContentAtRef: {
      'o/r/@main': [],
      [`o/r/@${GLOBAL_ONLY_HEAD}`]: [],
      ...(options.workflowAt
        ? { [`o/r/${ADVISORY_WORKFLOW}@${options.workflowAt}`]: { name: 'x' } }
        : {}),
    },
  });
}

interface GlobalOnlyCollectOptions {
  /** `undefined` leaves the setting absent from the trusted config. */
  setting?: boolean;
  globalOnly?: boolean;
  activation?: ActivationResult | null;
  /** Records each ref the trusted-config loader is asked for. */
  loads?: string[];
}

function collectGlobalOnly(
  port: ReturnType<typeof globalOnlyPort>,
  options: GlobalOnlyCollectOptions = {},
) {
  const globalOnly = options.globalOnly ?? true;
  return collectCiWaitState(
    [
      '--pr',
      '42',
      '--owner',
      'o',
      '--repo',
      'r',
      ...(globalOnly ? ['--global-only'] : []),
    ],
    () => port,
    (_owner, _repo, ref) => {
      options.loads?.push(ref);
      return options.setting === undefined
        ? {}
        : { ciGate: { allowNoRequiredChecksInGlobalOnly: options.setting } };
    },
    () =>
      options.activation === undefined
        ? GLOBAL_ONLY_ACTIVE
        : options.activation,
  );
}

test('#4053: the zero-check global-only opt-in passes CI on the E1 precondition and the watermark agreement', () => {
  const summary = collectGlobalOnly(globalOnlyPort(), { setting: true });
  assert.deepEqual(summary.checks, []);
  assert.equal(summary.requiredChecks.status, 'no-required-checks');
  assert.equal(summary.allowedByPolicySetting, GLOBAL_ONLY_OPT_IN);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), true);

  const agreement = requiredCiHeadAgreementFromSummary(summary);
  assert.equal(agreement.headRefOid, GLOBAL_ONLY_HEAD);
  assert.equal(agreement.requiredChecksPassing, true);
  assert.equal(agreement.noRequiredChecksConfigured, true);
  assert.equal(agreement.latestPassingCompletedAt, 'none');
});

test('#4053: the advisory name the ruleset requires is dropped under the profile, so the opt-in reaches zero required checks', () => {
  const rules = [
    {
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: ADVISORY_CHECK }] },
    },
  ];
  const passing = collectGlobalOnly(globalOnlyPort({ branchRules: rules }), {
    setting: true,
  });
  assert.equal(passing.requiredChecks.status, 'no-required-checks');
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(passing), true);

  // With the setting unset, the rollup stays unfiltered: the advisory name
  // is still required and missing, so the gate defers as it did before.
  const unset = collectGlobalOnly(globalOnlyPort({ branchRules: rules }), {});
  assert.equal(unset.requiredChecks.status, 'missing');
  assert.equal(unset.allowedByPolicySetting, undefined);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(unset), false);
});

test('#4053: the setting unset or false defers the same zero-check global-only state', () => {
  for (const setting of [undefined, false]) {
    const summary = collectGlobalOnly(globalOnlyPort(), { setting });
    assert.equal(summary.allowedByPolicySetting, undefined);
    assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false);
    assert.equal(
      requiredCiHeadAgreementFromSummary(summary).requiredChecksPassing,
      false,
    );
  }
});

test('#4053: with the setting unset or false, --global-only makes no activation read', () => {
  for (const setting of [undefined, false]) {
    let activationReads = 0;
    const summary = collectCiWaitState(
      ['--pr', '42', '--owner', 'o', '--repo', 'r', '--global-only'],
      () => globalOnlyPort(),
      () => ({
        ciGate:
          setting === undefined
            ? {}
            : { allowNoRequiredChecksInGlobalOnly: setting },
      }),
      () => {
        activationReads += 1;
        return GLOBAL_ONLY_ACTIVE;
      },
    );
    assert.equal(activationReads, 0);
    assert.deepEqual(summary.globalOnlyPolicy, {
      optIn: false,
      globalOnlyActive: false,
    });
    assert.equal(summary.allowedByPolicySetting, undefined);
  }
});

test('#4053: the setting true still defers when the global-only profile is not active', () => {
  const cases: [string, ReturnType<typeof collectGlobalOnly>][] = [
    [
      'no --global-only flag',
      collectGlobalOnly(globalOnlyPort(), {
        setting: true,
        globalOnly: false,
      }),
    ],
    [
      'a repository-local activation',
      collectGlobalOnly(globalOnlyPort(), {
        setting: true,
        activation: REPOSITORY_LOCAL_ACTIVATION,
      }),
    ],
    [
      'no resolvable activation',
      collectGlobalOnly(globalOnlyPort(), {
        setting: true,
        activation: null,
      }),
    ],
    [
      'the advisory workflow present on the trusted base ref',
      collectGlobalOnly(globalOnlyPort({ workflowAt: 'main' }), {
        setting: true,
      }),
    ],
    [
      'the advisory workflow present on the pull-request head',
      collectGlobalOnly(globalOnlyPort({ workflowAt: GLOBAL_ONLY_HEAD }), {
        setting: true,
      }),
    ],
  ];
  for (const [label, summary] of cases) {
    assert.equal(summary.allowedByPolicySetting, undefined, label);
    assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false, label);
  }
});

test('#4053: the setting true still defers a pending or failing present run', () => {
  const pending = [
    {
      __typename: 'CheckRun',
      name: 'lint',
      status: 'IN_PROGRESS',
      conclusion: null,
      workflowName: 'CI',
      detailsUrl: '',
      startedAt: '2026-10-12T00:00:00Z',
      completedAt: null,
    },
  ];
  const failing = [
    {
      __typename: 'CheckRun',
      name: 'lint',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      workflowName: 'CI',
      detailsUrl: '',
      startedAt: '2026-10-12T00:00:00Z',
      completedAt: '2026-10-12T00:05:00Z',
    },
  ];
  for (const rollup of [pending, failing]) {
    const summary = collectGlobalOnly(globalOnlyPort({ rollup }), {
      setting: true,
    });
    // The run is present, so the region is left: no allowance, no pass.
    assert.equal(summary.checks.length, 1);
    assert.equal(summary.allowedByPolicySetting, undefined);
    assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false);
  }
});

test('#4053: the setting true still defers when protection reads are unreadable', () => {
  const summary = collectGlobalOnly(globalOnlyPort({ branchRules: null }), {
    setting: true,
  });
  assert.equal(summary.requiredChecks.protectionReadsUnreadable, true);
  assert.equal(summary.requiredChecks.status, 'unreadable');
  assert.equal(summary.allowedByPolicySetting, undefined);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false);
});

test('#4053: the setting true still defers a source-pinned required-check requirement', () => {
  // An unnamed `workflows` ruleset rule: source-pinned with no name to drop.
  const unnamed = collectGlobalOnly(
    globalOnlyPort({ branchRules: [{ type: 'workflows', parameters: {} }] }),
    { setting: true },
  );
  assert.equal(unnamed.requiredChecks.status, 'source-pinned');
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(unnamed), false);

  // A named advisory requirement pinned to an integration: the profile must
  // not drop it, so it stays required and missing.
  const named = collectGlobalOnly(
    globalOnlyPort({
      branchRules: [
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [
              { context: ADVISORY_CHECK, integration_id: 15368 },
            ],
          },
        },
      ],
    }),
    { setting: true },
  );
  assert.equal(named.requiredChecks.requiredCheckSourcePinned, true);
  assert.deepEqual(named.requiredChecks.names, [ADVISORY_CHECK]);
  assert.equal(named.requiredChecks.status, 'missing');
  assert.equal(named.allowedByPolicySetting, undefined);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(named), false);
});

test('#4053: a stray allowedByPolicySetting marker without the matching state is not trusted', () => {
  // A zero-check summary with the marker but no opt-in inputs (the pure
  // builder leaves `globalOnlyPolicy` absent, which means off).
  const stray = buildCiWaitStateSummary(
    { headRefOid: GLOBAL_ONLY_HEAD, statusCheckRollup: [] },
    { requiredCheckNames: [] },
  );
  stray.allowedByPolicySetting = GLOBAL_ONLY_OPT_IN;
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(stray), false);

  // The opt-in inputs are on, but a present run is pending: the marker names
  // a state the summary does not have, so it does not pass.
  const pendingRun = buildCiWaitStateSummary(
    {
      headRefOid: GLOBAL_ONLY_HEAD,
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'lint',
          status: 'IN_PROGRESS',
          conclusion: null,
          workflowName: 'CI',
          detailsUrl: '',
          startedAt: '2026-10-12T00:00:00Z',
          completedAt: null,
        },
      ],
    },
    { requiredCheckNames: [] },
  );
  pendingRun.allowedByPolicySetting = GLOBAL_ONLY_OPT_IN;
  pendingRun.globalOnlyPolicy = { optIn: true, globalOnlyActive: true };
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(pendingRun), false);

  // The pass predicate re-checks the matching state on its own.
  assert.equal(
    isPreMergeCiAllPassing({
      allowedByPolicySetting: GLOBAL_ONLY_OPT_IN,
      noRequiredChecksConfigured: false,
      presentRunConclusion: 'none',
      protectionReadsUnreadable: false,
      requiredChecksPassing: false,
      status: 'failed',
    }),
    false,
  );
  assert.equal(
    isPreMergeCiAllPassing({
      allowedByPolicySetting: GLOBAL_ONLY_OPT_IN,
      noRequiredChecksConfigured: true,
      presentRunConclusion: 'some-failing',
      protectionReadsUnreadable: false,
      requiredChecksPassing: false,
      status: 'failed',
    }),
    false,
  );
});

test('#4053: the opt-in is read from the trusted base ref only, never a pull-request head value', () => {
  const loads: string[] = [];
  // Only the head branch name carries the opt-in. The loader is asked for the
  // trusted base ref alone, and that config has no opt-in, so the gate defers.
  const summary = collectCiWaitState(
    ['--pr', '42', '--owner', 'o', '--repo', 'r', '--global-only'],
    () => globalOnlyPort(),
    (_owner, _repo, ref) => {
      loads.push(ref);
      return {
        ciGate: { allowNoRequiredChecksInGlobalOnly: ref === 'feature/head' },
      };
    },
    () => GLOBAL_ONLY_ACTIVE,
  );
  assert.deepEqual(loads, ['main']);
  assert.equal(summary.allowedByPolicySetting, undefined);
  assert.equal(ciWaitSummaryIsPreMergeCiPassing(summary), false);
});

test('#4053: parseArgs reads --global-only and defaults it off', () => {
  assert.equal(parseArgs(['--pr', '42', '--global-only']).globalOnly, true);
  assert.equal(parseArgs(['--pr', '42']).globalOnly, false);
});

// --- #4401: one shared pass-equivalent state set ---------------------------

const PASS_EQUIVALENT_STATE_NAMES = [
  'NEUTRAL',
  'NOT_APPLICABLE',
  'SKIPPED',
  'SUCCESS',
];

/**
 * Offsets of every `[` in `source` that opens a single-level array whose
 * entries are only string literals (single, double or back quotes, with
 * comments allowed between them) and whose member set is exactly the four
 * pass-equivalent states, compared case-insensitively. Any other token before
 * the closing `]` (a spread, an identifier, a nested array) disqualifies the
 * array, so `[...CI_FAILURE_CONCLUSION_STATES, 'CANCELLED']` is never a copy.
 * Member order and duplicates do not matter. Comments are not stripped, so a
 * comment that spells the four states as a bracketed list is reported too;
 * reword such a comment instead of weakening the scan.
 */
function findPassEquivalentLiteralArrays(source: string): number[] {
  const offsets: number[] = [];
  for (
    let open = source.indexOf('[');
    open !== -1;
    open = source.indexOf('[', open + 1)
  ) {
    const members = literalMembers(source, open + 1);
    if (members === null || members.length === 0) continue;
    const memberSet = new Set(members.map((name) => name.toUpperCase()));
    if (
      memberSet.size === PASS_EQUIVALENT_STATE_NAMES.length &&
      PASS_EQUIVALENT_STATE_NAMES.every((name) => memberSet.has(name))
    ) {
      offsets.push(open);
    }
  }
  return offsets;
}

/**
 * The string-literal members of the bracket body that starts at `start`, or
 * `null` unless the body closes with `]` after only string literals, commas,
 * whitespace and comments. The sticky regex consumes one token at a time, so
 * a `]` inside a comment or string never closes the body early, and a `//`
 * inside a string stays part of that string.
 */
function literalMembers(source: string, start: number): string[] | null {
  const token = /\s+|,|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(['"`])([^'"`\n]*)\1/y;
  const members: string[] = [];
  let position = start;
  while (position < source.length) {
    if (source[position] === ']') return members;
    token.lastIndex = position;
    const found = token.exec(source);
    if (found === null) return null;
    if (found[1] !== undefined) members.push(found[2] ?? '');
    position = token.lastIndex;
  }
  return null;
}

test('#4401: CHECK_PASS_EQUIVALENT_STATES holds exactly the four pass-equivalent states', () => {
  assert.deepEqual(
    [...CHECK_PASS_EQUIVALENT_STATES].sort(),
    PASS_EQUIVALENT_STATE_NAMES,
  );
});

test('#4401: the pass-equivalent literal scan flags the shapes it exists to catch', () => {
  const sample = [
    "const a = ['SUCCESS', 'SKIPPED', 'NEUTRAL', 'NOT_APPLICABLE'].includes(s);",
    'const b = new Set(["NOT_APPLICABLE", "NEUTRAL", "SKIPPED", "SUCCESS", ]);',
    'const c = [',
    "  'SKIPPED', // legacy copy [see docs]",
    "  'success',",
    "  'NEUTRAL',",
    "  'NOT_APPLICABLE',",
    '];',
    "const d = [...CI_FAILURE_CONCLUSION_STATES, 'CANCELLED'];",
    "const e = ['SUCCESS', 'FAILURE', 'NEUTRAL', 'SKIPPED'];",
  ].join('\n');
  const lines = findPassEquivalentLiteralArrays(sample).map(
    (offset) => sample.slice(0, offset).split('\n').length,
  );
  assert.deepEqual(lines, [1, 2, 3]);
});

test('#4401: protocol-helpers and ci-wait-state declare the pass-equivalent states only in CHECK_PASS_EQUIVALENT_STATES', () => {
  const sourceDir = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'src',
    'scripts',
  );
  const offenders: string[] = [];
  let initializers = 0;
  for (const file of ['ci-wait-state.mts', 'protocol-helpers.mts']) {
    const source = readFileSync(join(sourceDir, file), 'utf8');
    for (const offset of findPassEquivalentLiteralArrays(source)) {
      const isSharedInitializer =
        file === 'protocol-helpers.mts' &&
        /\bCHECK_PASS_EQUIVALENT_STATES\s*(?::\s*ReadonlySet<string>\s*)?=\s*new Set\(\s*$/.test(
          source.slice(Math.max(0, offset - 200), offset),
        );
      if (isSharedInitializer) {
        initializers += 1;
        continue;
      }
      const line = source.slice(0, offset).split('\n').length;
      offenders.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'read the pass-equivalent states from CHECK_PASS_EQUIVALENT_STATES instead of copying them',
  );
  assert.equal(
    initializers,
    1,
    'the CHECK_PASS_EQUIVALENT_STATES initializer must be found exactly once',
  );
});

test('#4401: latestPassingCompletedAt still uppercases a lowercase state', () => {
  const completedAt = '2026-10-15T20:00:00Z';
  const summaryOf = (state: string) =>
    ({ checks: [{ name: 'ci', state, completedAt }] }) as unknown as Parameters<
      typeof latestPassingCompletedAt
    >[0];
  assert.equal(latestPassingCompletedAt(summaryOf('success')), completedAt);
  assert.equal(latestPassingCompletedAt(summaryOf('cancelled')), 'none');
});
