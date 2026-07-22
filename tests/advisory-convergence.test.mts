import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  type AdvisoryConvergenceDeps,
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  classifyCopilotAuthoredThreadIds,
  computeAdvisoryConvergenceVerdict,
  parseArgs,
  pickResolvingClaimEvents,
  runAdvisoryConvergence,
  viewerProbeGhOptions,
} from '../src/scripts/advisory-convergence.mts';
import {
  renderAdvisoryWaitRecoveryMarker,
  renderExternalCheckWaiverComment,
} from '../src/scripts/marker-helpers.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const SCHEMA = loadJson('schemas/advisory-convergence.schema.json');

const HEAD = '1111111111111111111111111111111111111111';
const OTHER_SHA = '2222222222222222222222222222222222222222';
const NOW = '2026-07-11T12:00:00Z';
const RECENT = '2026-07-11T10:00:00Z';
const OLD = '2026-06-01T00:00:00Z'; // >24h before NOW -- deadline passed
const TRUSTED = 'kurone-kito';
const COPILOT_LOGIN = 'copilot-pull-request-reviewer';
const CLAIM_ID = 'claim-abc123';
const AGENT_ID = 'claude-test';
// A repo that has opted this gate into the waiver escape hatch: `mode`
// alone (set per-test via `waiverMode`) is not sufficient -- the check
// must also be registered here, matching the two-dimensional
// `ciGate.externalCheckWaivers` / `ciGate.externalChecks.waivable`
// contract every other F2/F3 waiver already follows.
const ADVISORY_CONVERGENCE_WAIVABLE = [
  { selector: 'idd-advisory-convergence', matchMode: 'exact' },
];

function baseInputs(
  overrides: Partial<AdvisoryConvergenceInputs> = {},
): AdvisoryConvergenceInputs {
  return {
    prNumber: 1234,
    prHeadSha: HEAD,
    reviews: [],
    threads: [],
    comments: [],
    claimEvents: [],
    ...overrides,
  };
}

function baseOptions(
  overrides: Partial<AdvisoryConvergenceOptions> = {},
): AdvisoryConvergenceOptions {
  return {
    now: NOW,
    primaryBotLogin: 'copilot',
    trustedMarkerLogins: [TRUSTED],
    advisoryBotLogins: [],
    prAuthorLogin: '',
    headCommittedAt: RECENT,
    deadlineMinutes: 1440,
    waiverMode: 'disabled',
    waiverMaxValidity: 'PT24H',
    waiverCheckSelector: 'idd-advisory-convergence',
    ...overrides,
  };
}

function copilotReview(overrides: Record<string, unknown> = {}) {
  return {
    author: { login: COPILOT_LOGIN },
    submittedAt: RECENT,
    commitId: HEAD,
    itemCount: 0,
    ...overrides,
  };
}

function claimComment(claimId: string = CLAIM_ID) {
  return {
    author: { login: TRUSTED },
    body: `<!-- claimed-by: ${AGENT_ID} ${claimId} supersedes: none ${OLD} branch: issue/1234-test -->\n\n_${AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
    createdAt: OLD,
  };
}

function assertValidVerdict(verdict: unknown): void {
  assert.deepEqual(validate(verdict, SCHEMA), []);
}

// --- 1. converged --------------------------------------------------------

test('converged: clean primary-bot review on HEAD, no blocking threads', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

// --- 2. zero-review-but-open-thread ---------------------------------------

test('zero-review-but-open-thread: clean HEAD review but an older bot thread is still open', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      threads: [
        {
          id: 'PRT_1',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.threads.blockingCount, 1);
  assert.deepEqual(verdict.threads.blockingIds, ['PRT_1']);
  assert.equal(verdict.threads.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.pending, false);
  assert.equal(verdict.ready, false);
});

// --- 3. non-zero-review ----------------------------------------------------

test('non-zero-review: latest bot review on HEAD carries actionable items', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, false);
  assert.equal(verdict.review.matchesHead, true);
  assert.equal(verdict.review.itemCount, 2);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join('\n'), /2 actionable item/);
});

// --- 4. HEAD-not-yet-reviewed (pending) -------------------------------------

test('pending: the primary bot has not reviewed this pull request yet', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.review.found, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

test('pending: the latest bot review targets an older commit than current HEAD', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ commitId: OTHER_SHA })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.review.found, true);
  assert.equal(verdict.review.matchesHead, false);
  assert.equal(verdict.converged, false);
});

test('idd-claimed scope: matching linked-claim branch keeps the gate applicable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [claimComment()],
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'applicable',
    reason: 'idd-claimed-branch-matched',
  });
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('idd-claimed scope: a branch mismatch short-circuits the gate as not applicable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [claimComment()],
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-different',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'not_applicable',
    reason: 'idd-claimed-branch-mismatch',
  });
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('idd-claimed scope: a PR without a verified linked claim is not applicable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'feature/no-claim',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'not_applicable',
    reason: 'idd-claimed-no-verified-linked-issue-claim',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('regression: a re-request without a new push supersedes an earlier dirty on-HEAD review', () => {
  // Same commit reviewed twice (a legitimate re-request per this repo's own
  // advisory-wait protocol, AW3 REQUEST_NEEDED, without a new push): the
  // FIRST review found issues; the SECOND (later, superseding) review is
  // clean. Requiring every on-HEAD review to be clean would wrongly block
  // this genuinely-converged PR forever.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ submittedAt: OLD, itemCount: 4 }),
        copilotReview({ submittedAt: RECENT, itemCount: 0 }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.matchesHead, true);
  assert.equal(verdict.review.itemCount, 0);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('regression: matchesHead reflects the absolute-latest review, not merely any on-HEAD review', () => {
  // Copilot reviewed the current HEAD first (clean), then its most recent
  // activity overall is a review of a DIFFERENT commit (an unusual
  // force-push/revert-style ordering). The absolute-latest review is the
  // one that must be evaluated, so this must NOT report matchesHead: true
  // off the earlier, now-stale on-HEAD review.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ submittedAt: OLD, commitId: HEAD, itemCount: 0 }),
        copilotReview({
          submittedAt: RECENT,
          commitId: OTHER_SHA,
          itemCount: 0,
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.matchesHead, false);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.converged, false);
});

test('regression: a dirty on-HEAD review is never silently ignored just because its own submittedAt is missing', () => {
  // Both reviews target the current HEAD. The earlier one is clean and has a
  // valid timestamp; the later one carries actionable items but its
  // `submittedAt` is missing (a real, if unlikely, GraphQL possibility).
  // Clause 1 must fail closed here rather than silently trusting the clean
  // review just because it happens to sort more confidently.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ submittedAt: OLD, itemCount: 0 }),
        copilotReview({ submittedAt: null, itemCount: 3 }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, false);
  assert.equal(verdict.review.matchesHead, true);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.review.itemCount, 3);
  assert.equal(verdict.converged, false);
});

test('regression: resolved bot thread with no disposition marker at all satisfies the thread clause', () => {
  // The issue's Clause 2 is "resolved OR carries a valid disposition
  // marker" -- resolution alone must be sufficient, independent of whether
  // any marker was ever posted.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      threads: [
        {
          id: 'PRT_3',
          isResolved: true,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.threads.blockingCount, 0);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('regression: classifyCopilotAuthoredThreadIds keeps nodes[0] as the originating comment even when a later reply has an invalid createdAt', () => {
  const ids = classifyCopilotAuthoredThreadIds(
    [
      {
        id: 'D',
        comments: {
          nodes: [
            { author: { login: COPILOT_LOGIN }, createdAt: OLD },
            { author: { login: TRUSTED }, createdAt: null },
          ],
        },
      },
    ],
    'copilot',
  );
  assert.deepEqual([...ids], ['D']);
});

// --- 5. valid Reject-disposition ---------------------------------------------

test('valid Reject-disposition: an unresolved bot thread with a fresh Rejected marker satisfies the thread clause', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      threads: [
        {
          id: 'PRT_2',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
              },
              {
                author: { login: TRUSTED },
                body: '**Rejected** — not applicable to this change.',
                createdAt: RECENT,
                updatedAt: RECENT,
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.threads.blockingCount, 0);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

// --- 6. deadline-passed-with-waiver -------------------------------------------

test('deadline-passed-with-waiver: a valid maintainer waiver flips a stale-pending PR ready', () => {
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'Copilot review API outage, maintainer verified the diff manually',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [], // still pending -- the primary bot never reviewed
      claimEvents: [claimComment()],
      comments: [
        { author: { login: TRUSTED }, body: waiverBody, createdAt: RECENT },
      ],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waiver.activeClaimId, CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
});

test('deadline-passed-with-waiver: an otherwise-valid marker does not waive unless this gate is in the configured waivable list', () => {
  // Same valid marker as above, but the repo never opted `idd-advisory-
  // convergence` into `ciGate.externalChecks.waivable` -- only `mode` is
  // "maintainer-authorized". The existing two-dimensional waiver contract
  // (mode AND a per-check registration) must still hold for this gate.
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'Copilot review API outage, maintainer verified the diff manually',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        { author: { login: TRUSTED }, body: waiverBody, createdAt: RECENT },
      ],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: [], // not registered
    }),
  );
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test("#1512: this repository's own .github/idd/config.json wires the maintainer-waiver backstop end to end", () => {
  // Unlike the tests above (which supply a hand-rolled waiver policy),
  // this one normalizes the REAL repo-committed config and threads its
  // `ciGate.externalCheckWaivers.mode` / `ciGate.externalChecks.waivable`
  // straight into the pure verdict function -- proving the actual
  // shipped config (not just the mechanism in the abstract) makes a
  // post-deadline maintainer waiver for `idd-advisory-convergence` flip
  // `ready` true. See #1512 and #1465.
  const repoPolicy = normalizePolicyConfig(loadJson('.github/idd/config.json'));
  assert.equal(repoPolicy.advisoryWait.convergenceScope, 'idd-claimed');
  assert.equal(
    repoPolicy.ciGate.externalCheckWaivers.mode,
    'maintainer-authorized',
  );
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'repo config regression coverage (#1512)',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        { author: { login: TRUSTED }, body: waiverBody, createdAt: RECENT },
      ],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: repoPolicy.ciGate.externalCheckWaivers.mode,
      waivableSelectors: repoPolicy.ciGate.externalChecks.waivable,
      waiverMaxValidity: repoPolicy.ciGate.externalCheckWaivers.maxValidity,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

// --- 7. deadline-passed-no-waiver -----------------------------------------

test('deadline-passed-no-waiver: no waiver comment leaves a stale-pending PR blocked', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [claimComment()] }),
    baseOptions({ headCommittedAt: OLD, waiverMode: 'maintainer-authorized' }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

test('deadline-passed-no-waiver: waiver mode disabled never waives, even with an otherwise-valid marker', () => {
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'attempted waiver while waivers are disabled',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        { author: { login: TRUSTED }, body: waiverBody, createdAt: RECENT },
      ],
    }),
    baseOptions({ headCommittedAt: OLD, waiverMode: 'disabled' }),
  );
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('deadline not yet passed: no waiver path is consulted even in maintainer-authorized mode', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [claimComment()] }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
    }),
  );
  assert.equal(verdict.deadline.passed, false);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.ready, false);
});

test('regression: the deadline-passed reason names the waiver mode instead of implying a waiver would work when waivers are disabled', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [claimComment()] }),
    baseOptions({ headCommittedAt: OLD, waiverMode: 'disabled' }),
  );
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join('\n'), /no waiver is available/);
  assert.doesNotMatch(
    verdict.reasons.join('\n'),
    /no valid maintainer external-check waiver/,
  );
});

test('regression: the default deadline minutes come from the shared advisory-wait-policy constant', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions({ deadlineMinutes: undefined }),
  );
  assert.equal(verdict.deadline.minutes, 1440);
});

test('regression: elapsedMinutes is floored to a non-negative whole number', () => {
  // headCommittedAt 90 seconds before `now` -- a fractional 1.5 minutes
  // must floor to 1, not report a fractional value.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions({ headCommittedAt: '2026-07-11T11:58:30Z' }),
  );
  assert.equal(verdict.deadline.elapsedMinutes, 1);
  assert.equal(Number.isInteger(verdict.deadline.elapsedMinutes), true);
});

test('regression: elapsedMinutes clamps to 0 instead of going negative when headCommittedAt is after now', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions({ headCommittedAt: '2026-07-11T13:00:00Z' }), // after NOW
  );
  assert.equal(verdict.deadline.elapsedMinutes, 0);
});

// --- 8. forced-handoff / collaborator-marker-trust claim-resolution parity
// --- (#1344) -- both are opt-in, off-by-default repository features;
// --- `pre-merge-readiness.mts` already threads them into its own
// --- `summarizeClaimValidation` call, this section proves
// --- `advisory-convergence.mts` now agrees with it instead of silently
// --- rejecting a waiver the sibling gate would accept.

const SUCCESSOR_AGENT_ID = 'claude-test-2';
const SUCCESSOR_CLAIM_ID = 'claim-successor';
const HANDOFF_AT = '2026-06-05T00:00:00Z'; // after OLD, before PR_FIRST_COMMIT_AT
const PR_FIRST_COMMIT_AT = '2026-06-10T00:00:00Z';

function forcedHandoffComment({
  newAgentId = SUCCESSOR_AGENT_ID,
  newClaimId = SUCCESSOR_CLAIM_ID,
  contextScope = 'issue-plus-pr',
  linkedPr = '1234',
  createdAt = RECENT,
  author = TRUSTED,
} = {}) {
  const payload = {
    'old-agent-id': AGENT_ID,
    'old-claim-id': CLAIM_ID,
    'new-agent-id': newAgentId,
    'new-claim-id': newClaimId,
    branch: 'issue/1234-test',
    'forced-by': TRUSTED,
    reason: 'operator-approved-recovery',
    timestamp: createdAt,
    'context-scope': contextScope,
    ...(linkedPr ? { 'linked-pr': linkedPr } : {}),
  };
  return {
    author: { login: author },
    // `forced-by` stays TRUSTED regardless of `author` -- a non-default
    // `author` models a collaborator RELAYING a separately-authorized
    // maintainer's approval (`requireAuthorMatchesForcedBy` defaults to
    // `false` for this gate's lenient merge-side resolution, matching
    // `pre-merge-readiness.mts`; see `summarizeClaimValidation`'s own
    // doc comment in protocol-helpers.mts). The comment AUTHOR still must
    // independently pass the trusted-marker-actor gate (idd-claim rule 2)
    // for this marker to be considered at all.
    body: `<!-- forced-handoff: ${JSON.stringify(payload)} -->\n\nForced handoff approved by ${TRUSTED}.`,
    createdAt,
  };
}

/** Defaults to a maintainer-authorized waiver bound to the SUCCESSOR claim
 * (`SUCCESSOR_AGENT_ID`/`SUCCESSOR_CLAIM_ID`), posted by `TRUSTED`. Pass
 * `agentId`/`claimId: AGENT_ID/CLAIM_ID` to bind to the original claim
 * instead (the collaborator-marker-trust tests below, which exercise
 * waiver-author trust in isolation from any forced-handoff transition). */
function waiverComment({
  agentId = SUCCESSOR_AGENT_ID,
  claimId = SUCCESSOR_CLAIM_ID,
  reason = 'maintainer approved after forced-handoff takeover',
  actor = TRUSTED,
}: {
  agentId?: string;
  claimId?: string;
  reason?: string;
  actor?: string;
} = {}) {
  return {
    author: { login: actor },
    body: renderExternalCheckWaiverComment({
      agentId,
      claimId,
      headSha: HEAD,
      checkSelector: 'idd-advisory-convergence',
      reason,
      expiresAt: '2026-07-12T00:00:00Z',
      actor,
    }),
    createdAt: RECENT,
  };
}

test('forced-handoff takeover (issue-plus-pr): a waiver bound to the successor claim-id validates', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment(), forcedHandoffComment()],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      forcedHandoffEnabled: true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === TRUSTED,
      expectedLinkedPrs: ['1234'],
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('forced-handoff takeover (issue-only, predates the PR): honored via prFirstCommitAt, matching pre-merge-readiness.mts Part B (#1058)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [
        claimComment(),
        forcedHandoffComment({
          contextScope: 'issue-only',
          linkedPr: '',
          createdAt: HANDOFF_AT,
        }),
      ],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      forcedHandoffEnabled: true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === TRUSTED,
      // Non-empty even for an issue-only marker -- always true in
      // production (`--pr` is required), which is exactly why
      // `prFirstCommitAt` (not just an empty `expectedLinkedPrs`) is
      // required to reach this branch at all.
      expectedLinkedPrs: ['1234'],
      prFirstCommitAt: PR_FIRST_COMMIT_AT,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('forced-handoff (issue-only) is rejected once it no longer predates the PR (prFirstCommitAt fails closed)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [
        claimComment(),
        forcedHandoffComment({
          contextScope: 'issue-only',
          linkedPr: '',
          createdAt: HANDOFF_AT,
        }),
      ],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      forcedHandoffEnabled: true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === TRUSTED,
      expectedLinkedPrs: ['1234'],
      // The handoff (HANDOFF_AT) no longer predates this -- Part B denies
      // the issue-only allowance, so the claim stays with the ORIGINAL
      // agent and the successor-bound waiver must not validate.
      prFirstCommitAt: '2026-06-01T00:00:01Z',
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('regression: forced-handoff options default OFF -- the marker is inert and a successor-bound waiver never validates', () => {
  // Identical fixture to the first forced-handoff test above, but through
  // `baseOptions()` alone (no forcedHandoffEnabled / isAuthorizedForced-
  // Handoff / expectedLinkedPrs) -- proves the four new options are a
  // true no-op when a caller never sets them, matching today's exact
  // behavior before #1344.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment(), forcedHandoffComment()],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('collaborator-marker trust (PR side): a waiver from a login outside trustedMarkerActors is honored once it is folded into trustedMarkerLogins', () => {
  // `collectFromGitHub` (I/O layer, not under test here) folds a
  // Write/Maintain/Admin collaborator's login into `trustedMarkerLogins`
  // only when `markerTrust.allowCollaboratorMarkers` /
  // `IDD_TRUST_COLLABORATOR_MARKERS` is enabled -- see
  // `resolveTrustedCollaboratorMarkerLogins`. This test supplies the
  // resolved set directly (the pure-function half of that feature) the
  // same way every other test in this file supplies pre-resolved
  // evidence; the I/O permission lookup itself is not mocked here,
  // matching this codebase's own convention (see
  // `tests/collaborator-permission.test.mts`'s documented #1212 scope
  // note: the `gh api .../permission` subprocess path is deliberately
  // left untested, exercised only via its cache-seeding seam).
  const COLLABORATOR = 'collab-write-user';
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        waiverComment({
          agentId: AGENT_ID,
          claimId: CLAIM_ID,
          actor: COLLABORATOR,
        }),
      ],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      trustedMarkerLogins: [TRUSTED, COLLABORATOR],
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('collaborator-marker trust (claim-issue side): a forced-handoff marker AUTHORED by a login outside trustedMarkerActors is honored once folded into trustedMarkerLogins', () => {
  // Regression coverage added during #1344's own review loop: forced-
  // handoff markers are always posted to the claim ISSUE, never the PR
  // (see `forced-handoff-marker.mts`), so `collectFromGitHub` must fold
  // collaborator-marker-trust logins from the resolved claim issue's
  // comments too, not just PR `comments` -- see
  // `resolveTrustedCollaboratorMarkerLogins`'s call site (the union of
  // `comments` and `claimEvents`, matching `pre-merge-readiness.mts`'s
  // `[...comments, ...claimComments]` exactly). As above, this test
  // supplies the already-resolved `trustedMarkerLogins` directly and
  // proves the CONSEQUENCE: once a Write-permission collaborator's login
  // is trusted, a forced-handoff marker they AUTHORED (relaying a
  // separately-authorized maintainer's approval; see
  // `forcedHandoffComment`'s `author` parameter) is honored the same way
  // a `trustedMarkerActors`-listed author's marker already is.
  const COLLABORATOR = 'collab-write-user';
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [
        claimComment(),
        forcedHandoffComment({ author: COLLABORATOR }),
      ],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      forcedHandoffEnabled: true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === TRUSTED,
      expectedLinkedPrs: ['1234'],
      trustedMarkerLogins: [TRUSTED, COLLABORATOR],
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('regression: collaborator-marker trust defaults OFF -- an untrusted marker author cannot force a handoff even with a valid forced-by maintainer', () => {
  // Companion to both collaborator-marker-trust tests above: identical
  // claim-issue-side fixture, but COLLABORATOR is never added to
  // trustedMarkerLogins (baseOptions()'s default, [TRUSTED]) -- the
  // marker's author fails the trusted-actor gate (idd-claim rule 2)
  // before forced-handoff authorization is even evaluated, so the claim
  // never transfers, regardless of markerTrust being the reason
  // COLLABORATOR was omitted or simply not configured.
  const COLLABORATOR = 'collab-write-user';
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [
        claimComment(),
        forcedHandoffComment({ author: COLLABORATOR }),
      ],
      comments: [waiverComment()],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      forcedHandoffEnabled: true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === TRUSTED,
      expectedLinkedPrs: ['1234'],
      // trustedMarkerLogins left at baseOptions()'s default ([TRUSTED]) --
      // COLLABORATOR is never folded in.
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('staleAgeMs: a configured shorter stale window allows a takeover the hardcoded 24h default would reject', () => {
  // claimComment() is dated OLD (2026-06-01T00:00:00Z). TAKEOVER_AT is only
  // 2h later -- fresh under the hardcoded 24h default (takeover rejected,
  // active claim stays CLAIM_ID) but stale under a configured 1h window
  // (takeover accepted, active claim becomes SUCCESSOR_CLAIM_ID). Proves
  // `staleAgeMs` actually reaches `summarizeClaimValidation`, not just that
  // it type-checks.
  const TAKEOVER_AT = '2026-06-01T02:00:00Z';
  const takeoverClaim = {
    author: { login: TRUSTED },
    body: `<!-- claimed-by: ${SUCCESSOR_AGENT_ID} ${SUCCESSOR_CLAIM_ID} supersedes: ${CLAIM_ID} ${TAKEOVER_AT} branch: issue/1234-test -->\n\n_${SUCCESSOR_AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
    createdAt: TAKEOVER_AT,
  };
  const claimEvents = [claimComment(), takeoverClaim];

  const underDefault = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents, comments: [waiverComment()] }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      // staleAgeMs omitted -- hardcoded 24h default; the 2h gap is not stale.
    }),
  );
  assertValidVerdict(underDefault);
  assert.equal(underDefault.waiver.activeClaimId, CLAIM_ID);

  const underConfiguredWindow = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents, comments: [waiverComment()] }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      staleAgeMs: 60 * 60 * 1000, // 1h -- the 2h gap now counts as stale.
    }),
  );
  assertValidVerdict(underConfiguredWindow);
  assert.equal(underConfiguredWindow.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
});

// --- 9. sameHeadReroll (#1511) -----------------------------------------------
// --- Bounded same-HEAD advisory reroll evidence: `itemCount` (Clause 1) is
// --- a STATIC submission-time snapshot, so rejecting/resolving every item
// --- in triage never clears it -- `converged` can stay false PERMANENTLY on
// --- a HEAD the bot has already reviewed. This section proves the trigger
// --- condition, the bounded counter (incl. K-exhaustion fall-through), the
// --- inFlight/requestable state machine (resume-safe: derived fresh from
// --- GitHub state, never in-session memory), separateness from
// --- REQUEST_CAP, and that converged/waived/ready never reference this
// --- field group at all.

// 1h before NOW, 1h after RECENT -- old enough that the default 30-min
// advisoryWait.pendingWindow has elapsed by NOW, so a marker at this time is
// never "inFlight" purely from staleness (isolates count/cap assertions from
// the inFlight state machine).
const REROLL_AT = '2026-07-11T11:00:00Z';
// A second, earlier reroll timestamp for the two-marker K-exhaustion case.
const EARLIER_REROLL_AT = '2026-07-11T09:00:00Z';
// 10 min before NOW -- within the default 30-min pendingWindow, so a marker
// at this time (with no fresher review) IS "inFlight".
const REROLL_JUST_NOW = '2026-07-11T11:50:00Z';

/** `advisory-reroll:` marker comment. `createdAt` is the GitHub server
 * timestamp the code must use; `embeddedAt` (defaults to the same value) is
 * the marker body's own agent-supplied timestamp, which several tests below
 * deliberately set to a DIFFERENT (even bogus) value to prove the code never
 * reads it. */
function rerollMarkerComment(
  createdAt: string,
  overrides: {
    login?: string;
    headSha?: string;
    embeddedAt?: string;
  } = {},
) {
  const headSha = overrides.headSha ?? HEAD;
  const embeddedAt = overrides.embeddedAt ?? createdAt;
  return {
    author: { login: overrides.login ?? TRUSTED },
    body: `advisory-reroll: ${AGENT_ID} ${headSha} ${embeddedAt}`,
    createdAt,
  };
}

test('sameHeadReroll: eligible when matchesHead, itemCount > 0, and no blocking thread -- the exact permanent-block residual', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.converged, false); // the permanent-block bug itself
  assert.equal(verdict.sameHeadReroll.eligible, true);
  assert.equal(verdict.sameHeadReroll.count, 0);
  assert.equal(verdict.sameHeadReroll.cap, 2); // DEFAULT_ADVISORY_SAME_HEAD_REROLL_CAP
  assert.equal(verdict.sameHeadReroll.exhausted, false);
  assert.equal(verdict.sameHeadReroll.latestAt, '');
  assert.equal(verdict.sameHeadReroll.inFlight, false);
  assert.equal(verdict.sameHeadReroll.requestable, true);
});

test('sameHeadReroll: NOT eligible when itemCount is already 0 (already converged, nothing to reroll)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }), // itemCount: 0 default
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.sameHeadReroll.eligible, false);
  assert.equal(verdict.sameHeadReroll.requestable, false);
});

test('sameHeadReroll: NOT eligible when an unresolved, undispositioned bot thread remains (PATH A work still outstanding)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
      threads: [
        {
          id: 'PRT_1',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.threads.satisfied, false);
  assert.equal(verdict.sameHeadReroll.eligible, false);
  assert.equal(verdict.sameHeadReroll.requestable, false);
});

test('sameHeadReroll: NOT eligible when an unaddressed regular comment remains, even with every bot thread resolved (PR #1517 review)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
      // No review threads at all -- threadClause is vacuously satisfied --
      // but a regular (non-thread) PR comment from a non-trusted login has
      // no subsequent disposition-marker reply, so genuine triage work is
      // still outstanding even though every Copilot-authored thread is
      // fine. Eligibility must stay false until that is cleared too.
      comments: [
        {
          id: 1,
          createdAt: OLD,
          body: 'please double check this edge case',
          author: { login: 'some-reviewer' },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.sameHeadReroll.eligible, false);
  assert.equal(verdict.sameHeadReroll.requestable, false);
});

test('sameHeadReroll: NOT eligible when matchesHead is false (bot has not reviewed current HEAD)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ commitId: OTHER_SHA, itemCount: 2 })],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, true);
  assert.equal(verdict.sameHeadReroll.eligible, false);
  assert.equal(verdict.sameHeadReroll.requestable, false);
});

test('sameHeadReroll: a trusted same-HEAD marker counts and is not yet exhausted under the default cap', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_AT)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.count, 1);
  assert.equal(verdict.sameHeadReroll.exhausted, false);
  assert.equal(verdict.sameHeadReroll.latestAt, REROLL_AT);
  assert.equal(verdict.sameHeadReroll.requestable, true);
});

test('sameHeadReroll: K-exhaustion -- two trusted same-HEAD markers hit the default cap of 2, blocking a further reroll', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [
        rerollMarkerComment(EARLIER_REROLL_AT),
        rerollMarkerComment(REROLL_AT),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.eligible, true); // still eligible in principle
  assert.equal(verdict.sameHeadReroll.count, 2);
  assert.equal(verdict.sameHeadReroll.exhausted, true);
  assert.equal(verdict.sameHeadReroll.requestable, false); // but budget is spent
  assert.equal(verdict.sameHeadReroll.latestAt, REROLL_AT); // the LATER of the two
});

test('sameHeadReroll: configurable cap (sameHeadRerollCap: 1) exhausts after a single reroll', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_AT)],
    }),
    baseOptions({ sameHeadRerollCap: 1 }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.cap, 1);
  assert.equal(verdict.sameHeadReroll.count, 1);
  assert.equal(verdict.sameHeadReroll.exhausted, true);
  assert.equal(verdict.sameHeadReroll.requestable, false);
});

test('regression: sameHeadRerollCap: 0 or negative fails closed to the default cap instead of silently exhausting immediately (PR #1517 review)', () => {
  const zero = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions({ sameHeadRerollCap: 0 }),
  );
  assertValidVerdict(zero);
  assert.equal(zero.sameHeadReroll.cap, 2); // default, not 0
  assert.equal(zero.sameHeadReroll.exhausted, false);

  const negative = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions({ sameHeadRerollCap: -1 }),
  );
  assertValidVerdict(negative);
  assert.equal(negative.sameHeadReroll.cap, 2); // default, not -1
  assert.equal(negative.sameHeadReroll.exhausted, false);
});

test('regression: pendingWindowMinutes: 0 or negative fails closed to the default window instead of breaking inFlight (PR #1517 review)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_JUST_NOW)],
    }),
    baseOptions({ pendingWindowMinutes: 0 }),
  );
  assertValidVerdict(verdict);
  // With the default 30-min window (not the invalid 0), a marker posted 10
  // min ago is still inFlight -- proving the invalid value was rejected,
  // not merely tolerated by coincidence.
  assert.equal(verdict.sameHeadReroll.inFlight, true);
});

test('sameHeadReroll: inFlight while a recent marker exists and no fresher review has landed yet', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_JUST_NOW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.count, 1);
  assert.equal(verdict.sameHeadReroll.exhausted, false);
  assert.equal(verdict.sameHeadReroll.inFlight, true);
  assert.equal(verdict.sameHeadReroll.requestable, false); // in flight -- do not repost
});

test('sameHeadReroll: inFlight clears once the bot submits a review AFTER the reroll marker, even if itemCount is still non-zero (routed to E1, never suppressed)', () => {
  const laterReview = '2026-07-11T11:55:00Z'; // after REROLL_JUST_NOW, within the pending window
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 3, submittedAt: laterReview })],
      comments: [rerollMarkerComment(REROLL_JUST_NOW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, 3); // a flat/worse re-review -- not converged
  assert.equal(verdict.sameHeadReroll.inFlight, false); // but the request WAS answered
  assert.equal(verdict.sameHeadReroll.requestable, true); // free to try again (or fall through)
});

test('sameHeadReroll: inFlight clears once the pending window elapses even with no fresher review at all (do not wait forever)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      // The review PREDATES the reroll marker (no answer has arrived), yet
      // REROLL_AT is over 30 minutes before NOW -- the default
      // advisoryWait.pendingWindow has elapsed, so waiting is abandoned.
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_AT)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.inFlight, false);
  assert.equal(verdict.sameHeadReroll.requestable, true);
});

test('sameHeadReroll: an untrusted marker author is not counted', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_AT, { login: 'random-passerby' })],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.count, 0);
  assert.equal(verdict.sameHeadReroll.latestAt, '');
});

test('sameHeadReroll: a marker whose embedded HEAD SHA does not match current HEAD is not counted', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [rerollMarkerComment(REROLL_AT, { headSha: OTHER_SHA })],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.count, 0);
});

test('regression: a malformed reroll marker (bad timestamp, or trailing prose) is not counted, matching the canonical OPERATIONAL_MARKERS shape (PR #1517 review)', () => {
  const badTimestamp = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [
        {
          author: { login: TRUSTED },
          body: `advisory-reroll: ${AGENT_ID} ${HEAD} not-a-timestamp`,
          createdAt: REROLL_AT,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(badTimestamp);
  assert.equal(badTimestamp.sameHeadReroll.count, 0);

  const trailingProse = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [
        {
          author: { login: TRUSTED },
          body: `advisory-reroll: ${AGENT_ID} ${HEAD} ${REROLL_AT} please review soon`,
          createdAt: REROLL_AT,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(trailingProse);
  assert.equal(trailingProse.sameHeadReroll.count, 0);
});

test('sameHeadReroll: latestAt uses the GitHub comment createdAt, never the embedded (agent-supplied) timestamp', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [
        rerollMarkerComment(REROLL_AT, { embeddedAt: '1999-01-01T00:00:00Z' }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.latestAt, REROLL_AT);
});

test('sameHeadReroll: separateness from REQUEST_CAP -- an advisory-wait: marker (distinct prefix) is never counted as a reroll', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
      comments: [
        {
          author: { login: TRUSTED },
          body: `advisory-wait: ${AGENT_ID} ${HEAD} ${REROLL_AT}`,
          createdAt: REROLL_AT,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.count, 0);
  assert.equal(verdict.sameHeadReroll.requestable, true);
});

test('regression: converged/waived/ready are identical with and without advisory-reroll: markers present -- sameHeadReroll never affects the gate exit code', () => {
  const inputsWithoutMarker = baseInputs({
    reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
  });
  const inputsWithMarkers = baseInputs({
    reviews: [copilotReview({ itemCount: 2, submittedAt: RECENT })],
    comments: [
      rerollMarkerComment(EARLIER_REROLL_AT),
      rerollMarkerComment(REROLL_AT),
    ],
  });
  const without = computeAdvisoryConvergenceVerdict(
    inputsWithoutMarker,
    baseOptions(),
  );
  const with_ = computeAdvisoryConvergenceVerdict(
    inputsWithMarkers,
    baseOptions(),
  );
  assertValidVerdict(without);
  assertValidVerdict(with_);
  // The only field group allowed to differ is sameHeadReroll itself (count/
  // exhausted/latestAt/requestable move; eligible does not, since it never
  // looks at markers at all).
  assert.equal(without.sameHeadReroll.count, 0);
  assert.equal(with_.sameHeadReroll.count, 2);
  assert.equal(with_.sameHeadReroll.exhausted, true);
  assert.equal(without.converged, with_.converged);
  assert.equal(without.waived, with_.waived);
  assert.equal(without.ready, with_.ready);
  assert.equal(without.pending, with_.pending);
  assert.deepEqual(without.review, with_.review);
  assert.deepEqual(without.threads, with_.threads);
});

// --- 10. terminal Copilot unavailability (#1570/#1572) ----------------------
// --- The `#1572` terminal-recovery contract (buildCopilotRecoverySummary,
// --- advisory-wait-state.mts) is reused here unmodified: exhausting its
// --- bounded recovery-cycle cap (default 2) and letting its 12h terminal
// --- window elapse proves `terminal.state === "COPILOT_UNAVAILABLE"`. This
// --- section proves the #1570 wiring on top of it: `terminal` is reported
// --- separately from `deadline`, `ready` never flips from
// --- `COPILOT_UNAVAILABLE` alone, a valid maintainer waiver for the SAME
// --- `idd-advisory-convergence` selector opens an INDEPENDENT (potentially
// --- earlier-available) readiness path, every relevant mismatch on that
// --- waiver still blocks, and a late Copilot review on HEAD clears the
// --- terminal hold entirely (recomputed fresh every call, never sticky).

const RECOVERY_ANCHOR_1 = '2026-07-10T00:00:00Z';
const RECOVERY_ANCHOR_2 = '2026-07-10T01:00:00Z';

function terminalRecoveryComments() {
  return [
    {
      author: { login: TRUSTED },
      body: renderAdvisoryWaitRecoveryMarker({
        agentId: AGENT_ID,
        headSha: HEAD,
        timestamp: RECOVERY_ANCHOR_1,
        claimId: CLAIM_ID,
        attempt: 1,
      }),
      createdAt: RECOVERY_ANCHOR_1,
    },
    {
      author: { login: TRUSTED },
      body: renderAdvisoryWaitRecoveryMarker({
        agentId: AGENT_ID,
        headSha: HEAD,
        timestamp: RECOVERY_ANCHOR_2,
        claimId: CLAIM_ID,
        attempt: 2,
      }),
      createdAt: RECOVERY_ANCHOR_2,
    },
  ];
}

function terminalWaiverComment(
  overrides: {
    headSha?: string;
    claimId?: string;
    actor?: string;
    expiresAt?: string;
  } = {},
) {
  const { actor = TRUSTED, ...rest } = overrides;
  return {
    author: { login: actor },
    body: renderExternalCheckWaiverComment({
      agentId: AGENT_ID,
      claimId: CLAIM_ID,
      headSha: HEAD,
      checkSelector: 'idd-advisory-convergence',
      reason:
        'Copilot review API confirmed unavailable; recovery cycles exhausted',
      expiresAt: '2026-07-12T00:00:00Z',
      actor,
      ...rest,
    }),
    createdAt: RECENT,
  };
}

test('terminal-unavailable-no-waiver: COPILOT_UNAVAILABLE alone never flips ready, and a maintainer-hold reason is reported', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [], // Copilot never reviewed this HEAD
      claimEvents: [claimComment()],
      comments: terminalRecoveryComments(),
    }),
    baseOptions({
      headCommittedAt: RECENT, // the ordinary 24h deadline has NOT passed
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.terminal.capExhausted, true);
  assert.equal(verdict.terminal.windowElapsed, true);
  assert.equal(verdict.deadline.passed, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
  assert.ok(
    verdict.reasons.some((reason) => reason.includes('terminally unavailable')),
  );
});

test('terminal-unavailable-with-waiver: a valid maintainer waiver flips ready via the terminal path, independent of the ordinary 24h deadline', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [...terminalRecoveryComments(), terminalWaiverComment()],
    }),
    baseOptions({
      headCommittedAt: RECENT, // still NOT past the ordinary deadline
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.deadline.passed, false);
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
});

test('terminal-unavailable: a waiver bound to a different HEAD does not satisfy the terminal path', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        ...terminalRecoveryComments(),
        terminalWaiverComment({ headSha: OTHER_SHA }),
      ],
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('terminal-unavailable: a waiver bound to a different claim-id does not satisfy the terminal path', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        ...terminalRecoveryComments(),
        terminalWaiverComment({ claimId: 'claim-unrelated' }),
      ],
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.ready, false);
});

test('terminal-unavailable: a waiver posted by an untrusted actor does not satisfy the terminal path', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        ...terminalRecoveryComments(),
        terminalWaiverComment({ actor: 'random-untrusted-user' }),
      ],
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.ready, false);
});

test('terminal-unavailable: an expired waiver does not satisfy the terminal path', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [
        ...terminalRecoveryComments(),
        terminalWaiverComment({ expiresAt: '2026-07-01T00:00:00Z' }), // before NOW
      ],
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.ready, false);
});

test('terminal-unavailable: an otherwise-valid waiver does not satisfy the terminal path unless this selector is configured waivable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [...terminalRecoveryComments(), terminalWaiverComment()],
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: [], // idd-advisory-convergence never registered
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.ready, false);
});

test('regression: terminal reports NOT_TERMINAL and never affects ready when no recovery markers exist (backward compatible)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 0 })],
      claimEvents: [claimComment()],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'NOT_TERMINAL');
  assert.equal(verdict.terminal.reason, 'no-trusted-recovery-markers');
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('late Copilot review recovery: a fresh clean review landing on HEAD clears COPILOT_UNAVAILABLE and converges normally', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 0, commitId: HEAD })],
      claimEvents: [claimComment()],
      comments: terminalRecoveryComments(),
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'NOT_TERMINAL');
  assert.equal(verdict.terminal.reason, 'current-head-review-exists');
  assert.equal(verdict.converged, true);
  assert.equal(verdict.waived, false); // never needed -- the ordinary path resolved it
  assert.equal(verdict.ready, true);
});

// --- #1570 AC6: no code path this issue adds ever invokes `gh pr merge
// --- --admin` -- advisory-convergence.mts and this touched region of
// --- protocol-helpers.mts / pre-merge-readiness.mts are read-only evidence
// --- collectors by design (see each file's own module-header claim); this
// --- is a static assertion that they stay that way.
test('#1570 AC6: touched read-only helper sources never contain a `pr merge --admin` invocation', () => {
  // Matches the actual invocation shape (`pr merge` together with
  // `--admin` on the same line, in either order), not a bare `--admin`
  // substring or a bare `merge` + `--admin` pairing -- so prose that
  // mentions either token alone, or an unrelated command that happens to
  // use both words, cannot false-positive this guard. Tightened twice
  // per Copilot's #1570 findings on PR #1646 (first: bare substring;
  // second: bare `merge`/`--admin` pairing without requiring `pr merge`).
  const forbiddenInvocation =
    /\bpr\s+merge\b[^\n]*--admin\b|--admin\b[^\n]*\bpr\s+merge\b/i;
  const readFile = (path: string) =>
    readFileSync(new URL(path, import.meta.url), 'utf8');
  for (const path of [
    '../src/scripts/advisory-convergence.mts',
    '../src/scripts/pre-merge-readiness.mts',
    '../src/scripts/rerun-advisory-convergence.mts',
  ]) {
    const source = readFile(path);
    assert.ok(
      !forbiddenInvocation.test(source),
      `${path} must not invoke gh pr merge --admin`,
    );
  }
});

// --- pickResolvingClaimEvents (pure helper; #1347 regression) ---------------
// --- #1347: the collaborator-marker-trust fix in #1344 threaded
// --- `trustedMarkerLogins` into claim-issue disambiguation using a set
// --- resolved from ONLY the already-picked candidate's comments -- circular,
// --- since a lone candidate whose claim-establishing marker is authored by a
// --- collaborator-only-trusted login would never register as "active" for
// --- the presence check to pick it in the first place. This section proves
// --- the fix: `collectFromGitHub` now resolves `trustedMarkerLogins` from
// --- ALL candidates' comments before calling this function, so the
// --- disambiguation itself sees the fully-resolved set.

test('pickResolvingClaimEvents: a lone candidate trusted only via collaborator-marker trust resolves correctly (the #1347 regression)', () => {
  const COLLABORATOR = 'collab-write-user';
  const collaboratorClaim = [
    {
      author: { login: COLLABORATOR },
      body: `<!-- claimed-by: ${AGENT_ID} ${CLAIM_ID} supersedes: none ${OLD} branch: issue/1234-test -->\n\n_${AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
      createdAt: OLD,
    },
  ];

  // Without COLLABORATOR in trustedMarkerLogins: the claim-establishing
  // marker's author fails idd-claim rule 2 (untrusted author), so
  // activeClaimPresent is false and the sole candidate is discarded.
  assert.deepEqual(
    pickResolvingClaimEvents([collaboratorClaim], [TRUSTED], false),
    [],
  );

  // With COLLABORATOR folded in (what collectFromGitHub's fixed ordering
  // now guarantees -- resolved from ALL candidates' comments before this
  // call, not just the one this call ends up picking): the same candidate
  // now resolves correctly.
  assert.deepEqual(
    pickResolvingClaimEvents(
      [collaboratorClaim],
      [TRUSTED, COLLABORATOR],
      false,
    ),
    collaboratorClaim,
  );
});

test('pickResolvingClaimEvents: an explicit candidate (--claim-issue) is returned unconditionally, bypassing disambiguation', () => {
  const untrustedOnlyClaim = [
    {
      author: { login: 'nobody-trusted' },
      body: `<!-- claimed-by: ${AGENT_ID} ${CLAIM_ID} supersedes: none ${OLD} branch: issue/1234-test -->\n\n_${AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
      createdAt: OLD,
    },
  ];
  // isExplicit: true skips the presence check entirely -- matches the
  // pre-#1344 behavior of the original resolveClaimEvents's `if
  // (explicitIssueNumber) { return fetchClaimComments(...); }` early return.
  assert.deepEqual(
    pickResolvingClaimEvents([untrustedOnlyClaim], [TRUSTED], true),
    untrustedOnlyClaim,
  );
});

test('pickResolvingClaimEvents: zero or multiple resolving candidates still fail closed to [] (unchanged from pre-#1344/#1347 behavior)', () => {
  const claimA = [claimComment('claim-a')];
  const claimB = [claimComment('claim-b')];
  const noClaim = [
    { author: { login: TRUSTED }, body: 'just a comment', createdAt: OLD },
  ];

  // Zero resolving candidates.
  assert.deepEqual(pickResolvingClaimEvents([noClaim], [TRUSTED], false), []);
  // Multiple resolving candidates -- ambiguous, fails closed.
  assert.deepEqual(
    pickResolvingClaimEvents([claimA, claimB], [TRUSTED], false),
    [],
  );
  // Exactly one resolving candidate among several -- picks it.
  assert.deepEqual(
    pickResolvingClaimEvents([noClaim, claimA], [TRUSTED], false),
    claimA,
  );
});

// --- classifyCopilotAuthoredThreadIds (pure helper) -------------------------

test('classifyCopilotAuthoredThreadIds: a thread counts only when its ORIGINATING comment is bot-authored', () => {
  const ids = classifyCopilotAuthoredThreadIds(
    [
      {
        id: 'A',
        comments: {
          nodes: [
            { author: { login: COPILOT_LOGIN }, createdAt: OLD },
            { author: { login: TRUSTED }, createdAt: RECENT },
          ],
        },
      },
      {
        id: 'B',
        comments: {
          nodes: [
            { author: { login: TRUSTED }, createdAt: OLD },
            { author: { login: COPILOT_LOGIN }, createdAt: RECENT },
          ],
        },
      },
      { id: 'C', comments: { nodes: [] } },
    ],
    'copilot',
  );
  assert.deepEqual([...ids].sort(), ['A']);
});

// --- parseArgs ---------------------------------------------------------------

test('parseArgs: parses --pr, --assert, and --claim-issue', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--claim-issue',
    '7',
    '--assert',
    '--trusted-marker-logins',
    'a,b',
  ]);
  assert.equal(args.prNumber, 42);
  assert.equal(args.claimIssueNumber, 7);
  assert.equal(args.assert, true);
  assert.equal(args.trustedMarkerLogins, 'a,b');
  assert.equal(args.help, false);
});

test('parseArgs: an invalid --pr resolves to null (fails closed at the caller)', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed (#1450 acceptance criterion)', () => {
  // The issue's flagship example: --pr 5 --owner --assert must throw
  // instead of assigning owner='--assert' and silently leaving
  // assert=false (the gate would otherwise silently downgrade from
  // "exit non-zero unless ready" to report-only exit 0).
  assert.throws(() => parseArgs(['--pr', '5', '--owner', '--assert']));
});

// --- runAdvisoryConvergence (--assert exit-code contract, DI pattern) -------

function depsFor(
  inputs: AdvisoryConvergenceInputs,
  options: AdvisoryConvergenceOptions,
): AdvisoryConvergenceDeps {
  return { collect: () => ({ inputs, options }) };
}

test('runAdvisoryConvergence: --assert exits 0 when the verdict is ready', () => {
  const deps = depsFor(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions(),
  );
  const { verdict, exitCode, help } = runAdvisoryConvergence(
    ['--pr', '1234', '--assert'],
    deps,
  );
  assert.equal(help, false);
  assert.equal(verdict?.ready, true);
  assert.equal(exitCode, 0);
});

test('runAdvisoryConvergence: --assert exits non-zero when the verdict is not ready', () => {
  const deps = depsFor(baseInputs({ reviews: [] }), baseOptions());
  const { verdict, exitCode } = runAdvisoryConvergence(
    ['--pr', '1234', '--assert'],
    deps,
  );
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 1);
});

test('runAdvisoryConvergence: without --assert always exits 0 regardless of the verdict', () => {
  const deps = depsFor(baseInputs({ reviews: [] }), baseOptions());
  const { verdict, exitCode } = runAdvisoryConvergence(['--pr', '1234'], deps);
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 0);
});

test('runAdvisoryConvergence: --help short-circuits before collecting any evidence', () => {
  let called = false;
  const deps: AdvisoryConvergenceDeps = {
    collect: () => {
      called = true;
      return { inputs: baseInputs(), options: baseOptions() };
    },
  };
  const { help, exitCode } = runAdvisoryConvergence(['--help'], deps);
  assert.equal(help, true);
  assert.equal(exitCode, 0);
  assert.equal(called, false);
});

test('runAdvisoryConvergence: missing --pr throws before any collection happens', () => {
  let called = false;
  const deps: AdvisoryConvergenceDeps = {
    collect: () => {
      called = true;
      return { inputs: baseInputs(), options: baseOptions() };
    },
  };
  assert.throws(() => runAdvisoryConvergence([], deps));
  assert.equal(called, false);
});

test('viewerProbeGhOptions captures gh stderr only under GitHub Actions', () => {
  // Under Actions: capture stderr (pipe) so the expected `gh api user` 403 does
  // not leak into the run log; stdout is still piped so viewerLogin is read.
  const ci = viewerProbeGhOptions({ GITHUB_ACTIONS: 'true' });
  assert.deepEqual(ci.stdio, ['ignore', 'pipe', 'pipe']);

  // Outside Actions: inherit stderr so a real local viewer-lookup failure
  // stays visible (the #1396 fail-noisy concern). Both are set explicitly.
  const local = ['ignore', 'pipe', 'inherit'];
  assert.deepEqual(viewerProbeGhOptions({}).stdio, local);
  assert.deepEqual(
    viewerProbeGhOptions({ GITHUB_ACTIONS: 'false' }).stdio,
    local,
  );
  // Only the literal string 'true' opts in (matches GitHub's own value).
  assert.deepEqual(viewerProbeGhOptions({ GITHUB_ACTIONS: '1' }).stdio, local);
});
