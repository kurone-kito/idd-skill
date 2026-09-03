import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderClaimedByMarker } from '../src/scripts/protocol-helpers.mts';
import {
  buildSuitabilityCloseComment,
  evaluateSuitabilityCloseClaim,
  evaluateSuitabilityCloseEligibility,
  normalizeApplyNow,
  parseArgs,
  runSuitabilityCloseExecute,
  type SuitabilityCloseExecuteArgs,
  type SuitabilityCloseExecuteDeps,
  suitabilityCloseBranchPattern,
} from '../src/scripts/suitability-close-execute.mts';
import type { CheckOutcome } from '../src/scripts/supersession-detection.mts';

const ISSUE = 2222;
const CLAIM_ID = 'claim-20260626T000000Z-2222';
const AGENT_ID = 'claude-test';
const CLAIM_BRANCH = `suitability-close/${ISSUE}-some-slug`;

function claimComment(
  overrides: { claimId?: string; agentId?: string; branch?: string } = {},
) {
  return {
    body: renderClaimedByMarker({
      agentId: overrides.agentId ?? AGENT_ID,
      claimId: overrides.claimId ?? CLAIM_ID,
      supersedes: 'none',
      timestamp: '2026-06-26T00:00:00Z',
      branch: overrides.branch ?? CLAIM_BRANCH,
    }),
    createdAt: '2026-06-26T00:00:00Z',
    author: { login: 'kurone-kito' },
  };
}

// ---------------------------------------------------------------------------
// suitabilityCloseBranchPattern (pure)
// ---------------------------------------------------------------------------

test('suitabilityCloseBranchPattern matches only this issue number under the coordination prefix', () => {
  const pattern = suitabilityCloseBranchPattern(ISSUE);
  assert.equal(pattern.test(`suitability-close/${ISSUE}-some-slug`), true);
  assert.equal(pattern.test(`suitability-close/${ISSUE}-`), true);
  // A different issue number never matches, even with the same prefix.
  assert.equal(pattern.test(`suitability-close/${ISSUE}9-some-slug`), false);
  assert.equal(pattern.test(`suitability-close/${ISSUE + 1}-some-slug`), false);
  // A normal implementation claim branch never matches.
  assert.equal(pattern.test(`issue/${ISSUE}-some-slug`), false);
  // A roadmap-audit coordination branch never matches either.
  assert.equal(pattern.test(`roadmap-audit/${ISSUE}-some-slug`), false);
});

// ---------------------------------------------------------------------------
// evaluateSuitabilityCloseEligibility (pure)
// ---------------------------------------------------------------------------

test('a high-confidence tier fail is eligible, carrying its evidence verbatim', () => {
  const outcome: CheckOutcome = {
    pass: false,
    evidence: 'High-confidence duplicate: merged PR #123.',
    tier: 'high-confidence',
  };
  const result = evaluateSuitabilityCloseEligibility(outcome);
  assert.equal(result.eligible, true);
  assert.equal(result.evidence, outcome.evidence);
});

test('a weak-tier fail is never eligible, even though it shares pass: false', () => {
  const outcome: CheckOutcome = {
    pass: false,
    evidence: 'Exact-title duplicate found: #456',
    tier: 'weak',
  };
  const result = evaluateSuitabilityCloseEligibility(outcome);
  assert.equal(result.eligible, false);
  assert.equal(result.evidence, null);
});

test('a pass carries no tier and is never eligible', () => {
  const outcome: CheckOutcome = {
    pass: true,
    evidence: 'No duplicate candidate matched.',
  };
  assert.equal(evaluateSuitabilityCloseEligibility(outcome).eligible, false);
});

test("no signal at all (null, matching evaluateHighConfidenceDuplicate's own contract) is never eligible", () => {
  assert.equal(evaluateSuitabilityCloseEligibility(null).eligible, false);
});

// ---------------------------------------------------------------------------
// evaluateSuitabilityCloseClaim (pure)
// ---------------------------------------------------------------------------

test('a present, matching, fresh, suitability-close-branch claim is owned', () => {
  const verdict = evaluateSuitabilityCloseClaim([claimComment()], {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    expectedAgentId: AGENT_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, true);
  assert.equal(verdict.reason, 'match');
});

test('a missing or mismatched claim is not owned', () => {
  const missing = evaluateSuitabilityCloseClaim([], {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(missing.owned, false);
  assert.equal(missing.reason, 'missing-active-claim');

  const mismatch = evaluateSuitabilityCloseClaim(
    [claimComment({ claimId: 'other' })],
    {
      issueNumber: ISSUE,
      expectedClaimId: CLAIM_ID,
      isTrustedAuthor: () => true,
      nowIso: '2026-06-26T01:00:00Z',
    },
  );
  assert.equal(mismatch.owned, false);
  assert.equal(mismatch.reason, 'claim-id-mismatch');
});

test('a normal issue/* implementation claim on the same issue does NOT authorize a close', () => {
  const executionClaim = claimComment({ branch: `issue/${ISSUE}-some-task` });
  const verdict = evaluateSuitabilityCloseClaim([executionClaim], {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, 'claim-branch-mismatch');
});

test('a suitability-close claim posted for a DIFFERENT issue number does not authorize this one', () => {
  const otherIssueClaim = claimComment({
    branch: `suitability-close/${ISSUE + 1}-some-slug`,
  });
  const verdict = evaluateSuitabilityCloseClaim([otherIssueClaim], {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: '2026-06-26T01:00:00Z',
  });
  assert.equal(verdict.owned, false);
  assert.equal(verdict.reason, 'claim-branch-mismatch');
});

test('staleness honors the configured claim stale age', () => {
  const comment = [claimComment()]; // createdAt 2026-06-26T00:00:00Z
  const oneHourLater = '2026-06-26T01:00:00Z';

  const shortened = evaluateSuitabilityCloseClaim(comment, {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: oneHourLater,
    staleAgeMs: 30 * 60 * 1000,
  });
  assert.equal(shortened.owned, false);
  assert.equal(shortened.reason, 'claim-stale');

  const lengthened = evaluateSuitabilityCloseClaim(comment, {
    issueNumber: ISSUE,
    expectedClaimId: CLAIM_ID,
    isTrustedAuthor: () => true,
    nowIso: oneHourLater,
    staleAgeMs: 48 * 60 * 60 * 1000,
  });
  assert.equal(lengthened.owned, true);
});

// ---------------------------------------------------------------------------
// buildSuitabilityCloseComment (pure)
// ---------------------------------------------------------------------------

test('the close comment carries the evidence string verbatim and the #1485 reversal-posture note', () => {
  const body = buildSuitabilityCloseComment(
    'High-confidence duplicate: merged PR #123 (merged 2026-06-01T00:00:00Z).',
  );
  assert.match(body, /^A4\.5 high-confidence duplicate\/superseded close/);
  assert.match(
    body,
    /High-confidence duplicate: merged PR #123 \(merged 2026-06-01T00:00:00Z\)\./,
  );
  assert.match(body, /reopen the issue/);
});

// ---------------------------------------------------------------------------
// runSuitabilityCloseExecute (deps-injected orchestration)
// ---------------------------------------------------------------------------

const ISSUE_SHAPE = {
  number: ISSUE,
  title: 'some candidate issue',
  body: '',
  createdAt: '2026-06-01T00:00:00Z',
};

const HIGH_CONFIDENCE_OUTCOME: CheckOutcome = {
  pass: false,
  evidence: 'High-confidence duplicate: merged PR #123.',
  tier: 'high-confidence',
};

function baseArgs(
  overrides: Partial<SuitabilityCloseExecuteArgs> = {},
): SuitabilityCloseExecuteArgs {
  return {
    issue: ISSUE,
    apply: false,
    claimId: CLAIM_ID,
    agentId: AGENT_ID,
    owner: 'kurone-kito',
    repo: 'idd-skill',
    policy: '',
    now: '2026-06-26T01:00:00Z',
    help: false,
    ...overrides,
  };
}

function makeDeps(
  overrides: {
    checkOutcome?: CheckOutcome | null;
    claimComments?: ReturnType<typeof claimComment>[];
  } = {},
) {
  const calls = {
    closed: [] as number[],
    comments: [] as { issue: number; body: string }[],
    released: [] as { issue: number; agentId: string; claimId: string }[],
  };
  const deps: SuitabilityCloseExecuteDeps = {
    getIssue: () => ISSUE_SHAPE,
    loadIssueComments: () => overrides.claimComments ?? [claimComment()],
    collectEvidence: () =>
      overrides.checkOutcome === undefined
        ? HIGH_CONFIDENCE_OUTCOME
        : overrides.checkOutcome,
    isTrustedAuthor: () => true,
    postCloseComment: (issueNumber: number, body: string) => {
      calls.comments.push({ issue: issueNumber, body });
    },
    closeIssue: (issueNumber: number) => {
      calls.closed.push(issueNumber);
    },
    releaseClaim: (
      issueNumber: number,
      fields: { agentId: string; claimId: string },
    ) => {
      calls.released.push({
        issue: issueNumber,
        agentId: fields.agentId,
        claimId: fields.claimId,
      });
    },
    now: () => '2026-06-26T01:00:00Z',
  };
  return { deps, calls };
}

test('dry-run reports ready: true on a high-confidence signal, without mutating', () => {
  const { deps, calls } = makeDeps();
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: false }), deps);
  assert.equal(verdict.mode, 'dry-run');
  assert.equal(verdict.ready, true);
  assert.equal(verdict.eligible, true);
  assert.equal(verdict.evidence, HIGH_CONFIDENCE_OUTCOME.evidence);
  assert.equal(verdict.closed, false);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('dry-run reports ready: false when no high-confidence signal fires', () => {
  const { deps } = makeDeps({ checkOutcome: null });
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: false }), deps);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.eligible, false);
});

test('dry-run reports ready: false on a weak-tier fail (never authorizes a close)', () => {
  const { deps } = makeDeps({
    checkOutcome: {
      pass: false,
      evidence: 'Exact-title duplicate found: #456',
      tier: 'weak',
    },
  });
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: false }), deps);
  assert.equal(verdict.ready, false);
});

test('--apply closes, posts the evidence-bound comment, and releases the claim when owned + eligible', () => {
  const { deps, calls } = makeDeps();
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.mode, 'apply');
  assert.equal(verdict.closed, true);
  assert.deepEqual(calls.closed, [ISSUE]);
  assert.equal(calls.comments.length, 1);
  assert.equal(calls.comments[0]?.issue, ISSUE);
  assert.match(calls.comments[0]?.body ?? '', /High-confidence duplicate/);
  assert.deepEqual(calls.released, [
    { issue: ISSUE, agentId: AGENT_ID, claimId: CLAIM_ID },
  ]);
});

test('--apply re-validates the claim immediately before closeIssue and aborts the close (not the comment) if it was lost in that gap (Copilot review, PR #2558)', () => {
  const { deps, calls } = makeDeps();
  let loadCount = 0;
  deps.loadIssueComments = () => {
    loadCount += 1;
    // First call (before posting the comment): owned. Second call (the
    // final re-validation immediately before closeIssue): taken over.
    return loadCount === 1 ? [claimComment()] : [];
  };
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(loadCount, 2);
  assert.equal(verdict.closed, false);
  assert.equal(verdict.claim?.owned, false);
  assert.equal(verdict.claim?.reason, 'missing-active-claim');
  assert.match(verdict.result, /comment and the close/);
  // The evidence comment was already posted (informing whoever now owns
  // the claim), but the close and release never ran.
  assert.equal(calls.comments.length, 1);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.released, []);
});

test('--apply fails closed (no mutation) when the fresh re-evaluation no longer finds a signal', () => {
  const { deps, calls } = makeDeps({ checkOutcome: null });
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.closed, false);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('--apply fails closed (no mutation) when the coordination claim is not owned', () => {
  const { deps, calls } = makeDeps({ claimComments: [] });
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.closed, false);
  assert.equal(verdict.claim?.owned, false);
  assert.equal(verdict.claim?.reason, 'missing-active-claim');
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('--apply fails closed (no mutation) when the active claim is a normal issue/* implementation claim', () => {
  const { deps, calls } = makeDeps({
    claimComments: [claimComment({ branch: `issue/${ISSUE}-some-task` })],
  });
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.closed, false);
  assert.equal(verdict.claim?.reason, 'claim-branch-mismatch');
  assert.deepEqual(calls.closed, []);
});

test('a missing issue reports a not-found result without mutating', () => {
  const { deps, calls } = makeDeps();
  deps.getIssue = () => null;
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /not found or inaccessible/);
  assert.deepEqual(calls.closed, []);
});

test('a direct call bypassing runCli with issue: null degrades to a clean not-ready verdict, never an unsafe cast (Copilot review, PR #2558)', () => {
  const { deps, calls } = makeDeps();
  const verdict = runSuitabilityCloseExecute(
    baseArgs({ issue: null, apply: true }),
    deps,
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /--issue is required/);
  assert.deepEqual(calls.closed, []);
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});

test('a direct call with a negative issue number is also rejected, not just null (Copilot review, PR #2558)', () => {
  const { deps, calls } = makeDeps();
  const verdict = runSuitabilityCloseExecute(
    baseArgs({ issue: -1, apply: true }),
    deps,
  );
  assert.equal(verdict.ready, false);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /--issue is required/);
  assert.deepEqual(calls.closed, []);
});

// ---------------------------------------------------------------------------
// parseArgs (pure)
// ---------------------------------------------------------------------------

test('parseArgs rejects "0" for --issue, not just non-digit input (Copilot review, PR #2558)', () => {
  assert.equal(parseArgs(['--issue', '0']).issue, null);
  assert.equal(parseArgs(['--issue', 'abc']).issue, null);
  assert.equal(parseArgs(['--issue', '-1']).issue, null);
  assert.equal(parseArgs(['--issue', '2222']).issue, 2222);
});

// ---------------------------------------------------------------------------
// normalizeApplyNow (pure)
// ---------------------------------------------------------------------------

test('normalizeApplyNow strips the millisecond fraction Date#toISOString() always emits (Copilot review, PR #2558)', () => {
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42.719Z'),
    '2026-09-03T15:44:42Z',
  );
  // Already second-precision: unchanged.
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42Z'),
    '2026-09-03T15:44:42Z',
  );
  // A zone offset is normalized to UTC too (matches idd-roadmap-audit-execute.mts).
  assert.equal(
    normalizeApplyNow('2026-09-03T15:44:42.000+09:00'),
    '2026-09-03T06:44:42Z',
  );
});

test('normalizeApplyNow fails closed (null) on an unparseable value', () => {
  assert.equal(normalizeApplyNow('not-a-date'), null);
  assert.equal(normalizeApplyNow(''), null);
});

test("--apply normalizes deps.now()'s millisecond-precision output before it ever reaches releaseClaim, so renderUnclaimedByMarker never throws (Copilot review, PR #2558)", () => {
  const { deps, calls } = makeDeps();
  // A few minutes after the mock claim's createdAt (2026-06-26T00:00:00Z) --
  // well within the default 24h stale window, unlike baseArgs's own
  // '2026-06-26T01:00:00Z' `now` field, which this test overrides via
  // deps.now() (the production code path this bug actually lives in).
  deps.now = () => '2026-06-26T00:05:42.719Z';
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.closed, true);
  assert.equal(calls.released[0]?.issue, ISSUE);
  // renderUnclaimedByMarker itself throws on anything but second-precision
  // `…Z` -- exercising it here (not just asserting the released-timestamp
  // shape) proves the fix actually prevents the production throw.
  assert.doesNotThrow(() =>
    renderClaimedByMarker({
      agentId: AGENT_ID,
      claimId: CLAIM_ID,
      supersedes: 'none',
      timestamp: '2026-09-03T15:44:42Z',
      branch: CLAIM_BRANCH,
    }),
  );
});

test('--apply fails closed (no mutation at all) when deps.now() returns an unparseable value', () => {
  const { deps, calls } = makeDeps();
  deps.now = () => 'not-a-date';
  const verdict = runSuitabilityCloseExecute(baseArgs({ apply: true }), deps);
  assert.equal(verdict.closed, false);
  assert.match(verdict.result, /unparseable timestamp/);
  assert.deepEqual(calls.closed, []);
  // The comment was NOT yet posted either -- the now-validation runs before
  // the first mutation of any kind.
  assert.deepEqual(calls.comments, []);
  assert.deepEqual(calls.released, []);
});
