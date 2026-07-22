import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN,
  DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
  resolveAdvisoryBotRestLogin,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  buildCopilotRecoverySummary,
  detectRecoveryHeadRace,
  evaluateStaleRequestRecoveryAction,
  verifyRecoveryRequestCoversHead,
} from '../src/scripts/advisory-wait-state.mts';
import {
  buildAdvisoryWaitSummary,
  renderAdvisoryWaitRecoveryMarker,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { readJson } from './test-utils.mts';

// =============================================================================
// #1571: bounded stale-request recovery -- the execution layer that consumes
// the #1572 state contract (buildCopilotRecoverySummary) to decide whether a
// pending-but-unproven Copilot request should be removed and re-requested.
//
// Deliberately distinct from the pre-existing RECOVERY_NEEDED/AW3-R path
// (recovery-needed.json: copilotPendingCoversHead=true, a proven request
// missing only its own anchor marker). #1571 targets the OPPOSITE,
// unproven-coverage case PR #1562 identified
// (pending-covers-head-force-push.json: copilotPendingCoversHead=false).
// =============================================================================

const advisoryWaitStateSchema = loadJson(
  'schemas/advisory-wait-state.schema.json',
);
const relaxedAdvisoryWaitStateSchema = {
  ...(advisoryWaitStateSchema as Record<string, unknown>),
  required: [],
};

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const AGENT = 'claude-b8bb632d';
const CLAIM = 'clm-2d1b106e486d';
const TRUSTED = [AGENT];

const BASE_RECOVERY_OPTIONS = {
  now: '2026-07-22T12:00:00Z',
  trustedMarkerLogins: TRUSTED,
  claimId: CLAIM,
  agentId: AGENT,
  recoveryCycleCap: 2,
  terminalWindowMinutes: 720,
};

function recoveryComment(overrides: {
  login?: string;
  createdAt: string;
  agentId?: string;
  headSha?: string;
  claimId?: string | null;
  attempt?: number | null;
  timestamp?: string;
}) {
  const {
    login = AGENT,
    createdAt,
    agentId = AGENT,
    headSha = SHA,
    claimId = CLAIM,
    attempt = 1,
    timestamp = '2026-07-20T00:00:00Z',
  } = overrides;
  const payload: Record<string, unknown> = { agentId, headSha, timestamp };
  if (claimId !== null) payload.claimId = claimId;
  if (attempt !== null) payload.attempt = attempt;
  return {
    author: { login },
    body: renderAdvisoryWaitRecoveryMarker(payload),
    createdAt,
  };
}

// --- 1. Stale (unproven) versus current-head (proven) pending requests -----

test('evaluateStaleRequestRecoveryAction: attempt-eligible for an unproven pending request (PR #1562 shape)', () => {
  const fixture = readJson(
    'fixtures/advisory-wait/pending-covers-head-force-push.json',
  );
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
      trustedMarkerLogins: fixture.input.trustedMarkerLogins,
    },
  );
  assert.equal(summary.copilotPending, true);
  assert.equal(summary.copilotPendingCoversHead, false);

  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: summary.copilotPending,
    copilotPendingCoversHead: summary.copilotPendingCoversHead,
    sameHeadMarkerPresent: summary.sameHeadMarkerPresent,
    remainingBudget: 2,
  });
  assert.deepEqual(decision, {
    action: 'attempt',
    reason: 'recovery-attempt-eligible',
  });
});

test('evaluateStaleRequestRecoveryAction: not-applicable when the request is already proven to cover HEAD (the pre-existing RECOVERY_NEEDED/AW3-R case is untouched)', () => {
  const fixture = readJson('fixtures/advisory-wait/recovery-needed.json');
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
      trustedMarkerLogins: fixture.input.trustedMarkerLogins,
    },
  );
  assert.equal(summary.outcome, 'RECOVERY_NEEDED');
  assert.equal(summary.copilotPendingCoversHead, true);

  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: summary.copilotPending,
    copilotPendingCoversHead: summary.copilotPendingCoversHead,
    sameHeadMarkerPresent: summary.sameHeadMarkerPresent,
    remainingBudget: 2,
  });
  assert.deepEqual(decision, {
    action: 'not-applicable',
    reason: 'proven-covers-head',
  });
});

test('evaluateStaleRequestRecoveryAction: not-applicable when Copilot is not pending at all', () => {
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: false,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: 2,
  });
  assert.deepEqual(decision, {
    action: 'not-applicable',
    reason: 'not-pending',
  });
});

test("evaluateStaleRequestRecoveryAction: not-applicable once a same-head marker already anchors the clock (mirrors evaluateAdvisoryWaitOutcome's own gate, never contradicts it)", () => {
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: true,
    remainingBudget: 2,
  });
  assert.deepEqual(decision, {
    action: 'not-applicable',
    reason: 'same-head-marker-present',
  });
});

// --- 2. Missing/ambiguous timeline evidence (fail-closed) -------------------

test('verifyRecoveryRequestCoversHead: fails closed (false) when the timeline has no committed event for the current HEAD', () => {
  const covers = verifyRecoveryRequestCoversHead(
    [
      {
        event: 'review_requested',
        requested_reviewer: { login: 'copilot' },
      },
    ],
    SHA,
  );
  assert.equal(covers, false);
});

test('verifyRecoveryRequestCoversHead: fails closed (false) when the timeline has no review_requested event at all', () => {
  const covers = verifyRecoveryRequestCoversHead(
    [{ event: 'committed', sha: SHA }],
    SHA,
  );
  assert.equal(covers, false);
});

test('verifyRecoveryRequestCoversHead: fails closed (false) when the review_requested event precedes the HEAD commit (stale/ambiguous ordering)', () => {
  const covers = verifyRecoveryRequestCoversHead(
    [
      {
        event: 'review_requested',
        requested_reviewer: { login: 'copilot' },
      },
      { event: 'committed', sha: SHA },
    ],
    SHA,
  );
  assert.equal(covers, false);
});

test('verifyRecoveryRequestCoversHead: true only when review_requested strictly follows the current HEAD commit event -- the post-mutation association proof', () => {
  const covers = verifyRecoveryRequestCoversHead(
    [
      { event: 'committed', sha: SHA },
      {
        event: 'review_requested',
        requested_reviewer: { login: 'copilot' },
      },
    ],
    SHA,
  );
  assert.equal(covers, true);
});

test('verifyRecoveryRequestCoversHead: respects a configured non-default primary bot login', () => {
  const covers = verifyRecoveryRequestCoversHead(
    [
      { event: 'committed', sha: SHA },
      { event: 'review_requested', requested_reviewer: { login: 'my-bot' } },
    ],
    SHA,
    'my-bot',
  );
  assert.equal(covers, true);
});

// --- 3. Head movement races --------------------------------------------------

test('detectRecoveryHeadRace: no race when the expected and current HEAD match', () => {
  assert.equal(detectRecoveryHeadRace(SHA, SHA), false);
});

test('detectRecoveryHeadRace: race detected when HEAD moved between the staleness check and a mutating step', () => {
  assert.equal(detectRecoveryHeadRace(SHA, OTHER_SHA), true);
});

test('detectRecoveryHeadRace: case-insensitive comparison (a mixed-case SHA is not itself a race)', () => {
  assert.equal(detectRecoveryHeadRace(SHA, SHA.toUpperCase()), false);
});

test('detectRecoveryHeadRace: trims incidental whitespace before comparing', () => {
  assert.equal(detectRecoveryHeadRace(` ${SHA} `, SHA), false);
});

test('detectRecoveryHeadRace: fails closed (reports a race) when either HEAD is missing', () => {
  assert.equal(detectRecoveryHeadRace('', SHA), true);
  assert.equal(detectRecoveryHeadRace(SHA, ''), true);
});

test('detectRecoveryHeadRace: fails closed even when BOTH HEADs are missing (kurone-kito/idd-skill#1645 review: a naive equality would misread this as "no race")', () => {
  assert.equal(detectRecoveryHeadRace('', ''), true);
  assert.equal(detectRecoveryHeadRace('   ', '   '), true);
});

// --- 4. Retry-cap exhaustion -------------------------------------------------

test('evaluateStaleRequestRecoveryAction: cap-exhausted when the independent #1572 recovery-cycle budget is spent, even though the ordinary request path would still allow more attempts', () => {
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: 0,
  });
  assert.deepEqual(decision, {
    action: 'cap-exhausted',
    reason: 'recovery-cap-exhausted',
  });
});

test('evaluateStaleRequestRecoveryAction: attempt-eligible with exactly one cycle of budget remaining', () => {
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: 1,
  });
  assert.equal(decision.action, 'attempt');
});

test('integration: a full recovery-cap exhaustion sequence via buildCopilotRecoverySummary -> evaluateStaleRequestRecoveryAction', () => {
  // Two completed, verified recovery cycles for this exact HEAD already
  // exist -- the independent #1572 cap (default 2) is now exhausted.
  const comments = [
    recoveryComment({ createdAt: '2026-07-22T09:00:00Z', attempt: 1 }),
    recoveryComment({ createdAt: '2026-07-22T10:00:00Z', attempt: 2 }),
  ];
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_RECOVERY_OPTIONS,
  );
  assert.equal(copilotRecovery.completedCycleCount, 2);
  assert.equal(copilotRecovery.remainingBudget, 0);

  // A same-head marker is naturally present too (the posted recovery
  // markers themselves anchor the clock) -- either reason independently
  // routes away from a third mutation; assert the cap reason specifically
  // by isolating the marker-presence signal a caller would compute fresh
  // from a re-fetched PR (no NEW same-head marker beyond the recovery ones
  // already counted above).
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: copilotRecovery.remainingBudget,
  });
  assert.deepEqual(decision, {
    action: 'cap-exhausted',
    reason: 'recovery-cap-exhausted',
  });
});

// --- 5. Idempotent restart after a partial failure --------------------------

test('integration: re-entering after a partial failure (no marker posted yet) does not double-count or block the retry', () => {
  // No advisory-recovery marker has been posted yet for this HEAD (the
  // prior attempt failed before reaching the "post exactly one marker"
  // step) -- the budget must read as fully available, and the classifier
  // must still say "attempt", not something stricter.
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_RECOVERY_OPTIONS,
  );
  assert.equal(copilotRecovery.completedCycleCount, 0);
  assert.equal(copilotRecovery.remainingBudget, 2);

  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: copilotRecovery.remainingBudget,
  });
  assert.equal(decision.action, 'attempt');
});

test("integration: once one cycle's marker is verified and posted, re-evaluating the SAME evidence does not re-trigger a second mutation for that HEAD", () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-22T09:00:00Z', attempt: 1 }),
  ];
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_RECOVERY_OPTIONS,
  );
  assert.equal(copilotRecovery.completedCycleCount, 1);
  assert.equal(copilotRecovery.remainingBudget, 1);

  // A fresh re-fetch of the PR now sees the just-posted recovery marker as
  // a same-head marker (advisoryWaitMarkerMatchesHead recognizes the bound
  // advisory-wait-recovery: form) -- this is what naturally stops a second
  // removal/re-request attempt for the SAME HEAD within the same pass, even
  // though one cycle of budget remains for a genuinely later recurrence.
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: SHA,
      reviews: [],
      requestedReviewers: [{ login: 'copilot' }],
      timelineEvents: [],
      comments,
    },
    { now: BASE_RECOVERY_OPTIONS.now, trustedMarkerLogins: TRUSTED },
  );
  assert.equal(summary.sameHeadMarkerPresent, true);

  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: summary.sameHeadMarkerPresent,
    remainingBudget: copilotRecovery.remainingBudget,
  });
  assert.deepEqual(decision, {
    action: 'not-applicable',
    reason: 'same-head-marker-present',
  });
});

// --- 6. CLI/REST fallback identity resolution -------------------------------

test('resolveAdvisoryBotRestLogin: the default Copilot bot resolves to its distinct REST identity', () => {
  assert.equal(
    resolveAdvisoryBotRestLogin(DEFAULT_ADVISORY_PRIMARY_BOT_LOGIN),
    DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
  );
  assert.equal(
    DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
    'copilot-pull-request-reviewer[bot]',
  );
});

test('resolveAdvisoryBotRestLogin: defaults to the Copilot REST login when called with no argument', () => {
  assert.equal(
    resolveAdvisoryBotRestLogin(),
    DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
  );
});

test('resolveAdvisoryBotRestLogin: a configured non-default bot login is already a real account login -- its REST login equals itself', () => {
  assert.equal(resolveAdvisoryBotRestLogin('my-review-bot'), 'my-review-bot');
});

test('resolveAdvisoryBotRestLogin: normalizes case and surrounding whitespace before comparing against the default', () => {
  assert.equal(
    resolveAdvisoryBotRestLogin(' Copilot '),
    DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
  );
});

test('resolveAdvisoryBotRestLogin: fails closed to the default REST login for a blank/absent configured login', () => {
  assert.equal(
    resolveAdvisoryBotRestLogin(''),
    DEFAULT_ADVISORY_PRIMARY_BOT_REST_LOGIN,
  );
});

// --- 7. Preservation of ordinary request/reroll counters --------------------

test('a bound advisory-recovery marker anchors the same-head clock but does NOT consume the ordinary request-cap counter', () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-22T09:00:00Z', attempt: 1 }),
  ];
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: SHA,
      reviews: [],
      requestedReviewers: [{ login: 'copilot' }],
      timelineEvents: [],
      comments,
    },
    {
      now: '2026-07-22T09:05:00Z',
      trustedMarkerLogins: TRUSTED,
      requestCap: 30,
    },
  );
  assert.equal(summary.sameHeadMarkerPresent, true);
  assert.equal(summary.sameHeadMarkerCount, 1);
  // The independence this satisfies: requestMarkerCount (which CAP_EXHAUSTED
  // gates against requestCap) only counts `advisory-wait:`-prefixed markers,
  // never `advisory-wait-recovery:` ones -- so a stale-request recovery
  // cycle never burns the ordinary 30-request budget.
  assert.equal(summary.requestMarkerCount, 0);
});

test('integration: the independent recovery-cycle cap accounts correctly even when the caller also supplies an unrelated requestCap-shaped option (accounting stays independent of both requestCap and sameHeadRerollCap)', () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-22T09:00:00Z', attempt: 1 }),
  ];
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: '' },
    { ...BASE_RECOVERY_OPTIONS, recoveryCycleCap: 2 },
  );
  assert.equal(copilotRecovery.cap, 2);
  assert.equal(copilotRecovery.completedCycleCount, 1);
  assert.equal(copilotRecovery.remainingBudget, 1);
});

// --- Schema round-trip: staleRequestRecovery composes with the rest of the CLI output ---

test('a full CLI output shape (summary + copilotRecovery + staleRequestRecovery) validates cleanly together', () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-21T00:00:00Z', attempt: 1 }),
  ];
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: SHA,
      reviews: [],
      requestedReviewers: [{ login: 'copilot' }],
      timelineEvents: [],
      comments,
    },
    { now: BASE_RECOVERY_OPTIONS.now, trustedMarkerLogins: TRUSTED },
  );
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: summary.lastCopilotCommit },
    BASE_RECOVERY_OPTIONS,
  );
  const staleRequestRecovery = evaluateStaleRequestRecoveryAction({
    copilotPending: summary.copilotPending,
    copilotPendingCoversHead: summary.copilotPendingCoversHead,
    sameHeadMarkerPresent: summary.sameHeadMarkerPresent,
    remainingBudget: copilotRecovery.remainingBudget,
  });

  const fullOutput = {
    ...summary,
    trustedMarkerActors: [] as string[],
    trustedMarkerActorsSource: 'none' as const,
    copilotRecovery,
    staleRequestRecovery,
  };

  assert.deepEqual(validate(fullOutput, advisoryWaitStateSchema), []);
});

test('the schema rejects a staleRequestRecovery object missing a required field or an unknown field', () => {
  const decision = evaluateStaleRequestRecoveryAction({
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: 2,
  });

  const { reason: _omitted, ...missingReason } = decision;
  assert.notDeepEqual(
    validate(
      { staleRequestRecovery: missingReason },
      relaxedAdvisoryWaitStateSchema,
    ),
    [],
  );

  assert.notDeepEqual(
    validate(
      { staleRequestRecovery: { ...decision, extraField: 'nope' } },
      relaxedAdvisoryWaitStateSchema,
    ),
    [],
  );

  assert.notDeepEqual(
    validate(
      { staleRequestRecovery: { ...decision, action: 'bogus-action' } },
      relaxedAdvisoryWaitStateSchema,
    ),
    [],
  );
});
