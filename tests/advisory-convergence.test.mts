import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  ADVISORY_CONVERGENCE_NEXT_ACTION_TOKEN,
  type AdvisoryConvergenceDeps,
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  classifyClaimCandidateAmbiguity,
  classifyCopilotAuthoredThreadIds,
  collectAssertNextActions,
  computeAdvisoryConvergenceVerdict,
  DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS,
  DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
  formatAssertNextActions,
  hasTrustedClaimMarkerHistory,
  isSoleCopilotNotReviewedYetReason,
  parseArgs,
  pickResolvingClaimEvents,
  readCopilotReviewPollPolicy,
  resolveClaimEvidence,
  retryTransientGhFailure,
  reviewPolicyNotApplicableReason,
  runAdvisoryConvergence,
  runAdvisoryConvergenceWithPoll,
  SAME_HEAD_REROLL_INELIGIBLE_REASON,
  viewerProbeGhOptions,
  writeAdvisoryConvergenceCliOutput,
} from '../src/scripts/advisory-convergence.mts';
import {
  renderAdvisoryWaitRecoveryMarker,
  renderExternalCheckWaiverComment,
} from '../src/scripts/marker-helpers.mts';
import { normalizePolicyConfig } from '../src/scripts/policy-helpers.mts';
import { summarizeClaimValidation } from '../src/scripts/protocol-helpers.mts';
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
    claimMarkerHistoryPresent: false,
    claimCandidateAmbiguous: false,
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

test('idd-claimed scope: a branch mismatch against an active trusted claim makes the gate indeterminate, not not_applicable (#1686 path 3)', () => {
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
    status: 'indeterminate',
    reason: 'idd-claimed-branch-mismatch',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.converged, false);
  // Indeterminate must never let `ready` become true through the ordinary
  // convergence path -- only a maintainer waiver (tested separately below)
  // can clear it, unlike the pre-#1686 not_applicable behavior this test
  // used to assert (`ready: true` unconditionally).
  assert.equal(verdict.ready, false);
  assert.match(
    verdict.reasons.join('\n'),
    /applicability is indeterminate \(idd-claimed-branch-mismatch\)/,
  );
});

test('idd-claimed scope: an indeterminate branch mismatch still falls through the existing maintainer-waiver escape hatch (#1686)', () => {
  // The active claim here has a real, non-empty claimId, so a waiver CAN
  // bind to it -- unlike paths 2/4 below, where `activeClaimId` stays ''
  // and `summarizeExternalCheckWaivers` fails closed on an unbound waiver.
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: AGENT_ID,
    claimId: CLAIM_ID,
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'confirmed benign branch-name mismatch (#1686)',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [claimComment()],
      comments: [
        { author: { login: TRUSTED }, body: waiverBody, createdAt: RECENT },
      ],
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-different',
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.applicability.status, 'indeterminate');
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('idd-claimed scope: multiple resolving claim candidates make the gate indeterminate, not not_applicable (#1686 path 2)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      // Disambiguation already failed closed to [] upstream (mirrors
      // `pickResolvingClaimEvents`'s own contract) -- `claimCandidateAmbiguous`
      // is the separate signal that tells this apart from "no claim at all".
      claimEvents: [],
      claimCandidateAmbiguous: true,
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'indeterminate',
    reason: 'idd-claimed-multiple-resolving-claim-candidates',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  // No activeClaimId exists to bind a waiver to -- summarizeExternalCheckWaivers
  // fails closed on an unbound waiver, so this path is not waivable in practice
  // even with waiverMode: 'maintainer-authorized' (unlike the branch-mismatch
  // path above, which has a real activeClaimId).
});

test('idd-claimed scope: a stale trusted claim (claim-marker history present, no currently active claim) yields a failing outcome, not not_applicable (#1686 path 4)', () => {
  // `resolveActiveClaim` (protocol-helpers.mts) has no `now` and never
  // expires a claim by elapsed time alone; staleness there only matters when
  // a LATER event attempts to supersede the active claim. So the concrete
  // way `activeClaimPresent` becomes false while claim history genuinely
  // exists is an explicit release, not a bare age check -- this fixture
  // demonstrates that shape (a stale, well-past-staleAge claimed-by marker,
  // explicitly released) rather than asserting on elapsed time. See
  // `hasTrustedClaimMarkerHistory`'s doc comment for the full finding.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [],
      claimMarkerHistoryPresent: true,
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'indeterminate',
    reason: 'idd-claimed-claim-history-without-active-claim',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

// --- claim-evidence runtime validation (#1821) ------------------------------
// `claimMarkerHistoryPresent` / `claimCandidateAmbiguous` are required
// `boolean` fields at the TS level (#1814), but that guard is erased at
// emit -- an untyped caller of the exported `.mjs` can still pass
// `undefined` or a non-boolean value through. These cases pin the runtime
// rejection this issue adds, so it cannot silently regress back to the old
// `=== true` coercion. `as never` bypasses the TS type that already
// forbids constructing these bad inputs directly.

test('computeAdvisoryConvergenceVerdict: rejects a non-boolean claimMarkerHistoryPresent instead of coercing it to false', () => {
  assert.throws(
    () =>
      computeAdvisoryConvergenceVerdict(
        baseInputs({ claimMarkerHistoryPresent: undefined as never }),
        baseOptions(),
      ),
    { message: 'claimMarkerHistoryPresent must be a boolean' },
  );
  assert.throws(
    () =>
      computeAdvisoryConvergenceVerdict(
        baseInputs({ claimMarkerHistoryPresent: 'true' as never }),
        baseOptions(),
      ),
    { message: 'claimMarkerHistoryPresent must be a boolean' },
  );
});

test('computeAdvisoryConvergenceVerdict: rejects a non-boolean claimCandidateAmbiguous instead of coercing it to false', () => {
  assert.throws(
    () =>
      computeAdvisoryConvergenceVerdict(
        baseInputs({ claimCandidateAmbiguous: undefined as never }),
        baseOptions(),
      ),
    { message: 'claimCandidateAmbiguous must be a boolean' },
  );
  assert.throws(
    () =>
      computeAdvisoryConvergenceVerdict(
        baseInputs({ claimCandidateAmbiguous: 1 as never }),
        baseOptions(),
      ),
    { message: 'claimCandidateAmbiguous must be a boolean' },
  );
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

// --- exemptBotAuthoredPrs (#1906) -------------------------------------------

test('exemptBotAuthoredPrs: all-prs scope, flag on, Bot-typed author, no claim history -> not_applicable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
      claimEvents: [],
      prAuthorIsBot: true,
    }),
    baseOptions({ exemptBotAuthoredPrs: true }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'not_applicable',
    reason: 'bot-authored-no-claim-history',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
  // Bonus: the existing `scopeNotApplicable`-gated `ineligibleReasons`
  // computation is scope-generic (reads `applicability.status`, not
  // `convergenceScope`), so it already covers this new `all-prs` cause
  // with no code change of its own -- confirm that holds.
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.SCOPE_NOT_APPLICABLE,
  ]);
});

test('exemptBotAuthoredPrs: all-prs scope, flag on, Bot-typed author WITH claim history -> unchanged applicable/all-prs', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [],
      claimMarkerHistoryPresent: true,
      prAuthorIsBot: true,
    }),
    baseOptions({ exemptBotAuthoredPrs: true }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
});

test('exemptBotAuthoredPrs: all-prs scope, flag on, human-authored PR -> unchanged applicable/all-prs', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()], claimEvents: [] }),
    baseOptions({ exemptBotAuthoredPrs: true }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
});

test('exemptBotAuthoredPrs: idd-claimed scope never changes output, even for a Bot author with no claim history (#1906 AC)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [], prAuthorIsBot: true }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'feature/no-claim',
      exemptBotAuthoredPrs: true,
    }),
  );
  assertValidVerdict(verdict);
  // Same token as the pre-existing idd-claimed test above -- NOT the new
  // `bot-authored-no-claim-history` reason. This is the one a careless
  // implementation (hoisting the bot check above the scope ternary)
  // would silently break.
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'not_applicable',
    reason: 'idd-claimed-no-verified-linked-issue-claim',
  });
  assert.equal(verdict.ready, true);
});

test('exemptBotAuthoredPrs: flag unset (default false) -> unchanged applicable/all-prs even for a Bot author with no claim history', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: [],
      prAuthorIsBot: true,
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
});

// --- reviewPolicy applicability (#2137) -------------------------------------

test('reviewPolicyNotApplicableReason: exact human-required / no-advisory only', () => {
  assert.equal(
    reviewPolicyNotApplicableReason('human-required'),
    'review-policy-human-required',
  );
  assert.equal(
    reviewPolicyNotApplicableReason('no-advisory'),
    'review-policy-no-advisory',
  );
  assert.equal(reviewPolicyNotApplicableReason('copilot-advisory'), null);
  assert.equal(reviewPolicyNotApplicableReason('external-bot'), null);
  assert.equal(reviewPolicyNotApplicableReason(undefined), null);
  assert.equal(reviewPolicyNotApplicableReason(''), null);
  assert.equal(reviewPolicyNotApplicableReason('HUMAN-REQUIRED'), null);
  assert.equal(reviewPolicyNotApplicableReason('not-a-real-policy'), null);
});

test('reviewPolicy human-required: no Copilot review is not_applicable and ready, not fake-converged', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({ reviewPolicy: 'human-required' }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'not_applicable',
    reason: 'review-policy-human-required',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('reviewPolicy no-advisory: no Copilot review is not_applicable and ready, not fake-converged', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({ reviewPolicy: 'no-advisory' }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'not_applicable',
    reason: 'review-policy-no-advisory',
  });
  assert.equal(verdict.pending, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('reviewPolicy copilot-advisory: same fixture still fails until Copilot converges', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({ reviewPolicy: 'copilot-advisory' }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
  assert.equal(verdict.pending, true);
  assert.equal(verdict.ready, false);
});

test('reviewPolicy absent: same fixture still fails until Copilot converges', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.applicability.status, 'applicable');
  assert.equal(verdict.pending, true);
  assert.equal(verdict.ready, false);
});

test('reviewPolicy invalid: does not widen past copilot-advisory applicability', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({ reviewPolicy: 'not-a-real-policy' }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
  assert.equal(verdict.pending, true);
  assert.equal(verdict.ready, false);
});

test('reviewPolicy external-bot: keeps the configured primaryBotLogin path', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [], claimEvents: [] }),
    baseOptions({ reviewPolicy: 'external-bot' }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'all-prs',
    status: 'applicable',
    reason: 'all-prs',
  });
  assert.equal(verdict.pending, true);
  assert.equal(verdict.ready, false);
});

test('reviewPolicy human-required wins under idd-claimed with a matching claim (hybrid PR)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
    }),
    baseOptions({
      reviewPolicy: 'human-required',
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'not_applicable',
    reason: 'review-policy-human-required',
  });
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('reviewPolicy human-required does not treat a dirty Copilot review as converged', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 3 })] }),
    baseOptions({ reviewPolicy: 'human-required' }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.applicability.status, 'not_applicable');
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
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

// --- #1905: claimless waiver (claim-id "none") escape hatch ----------------

test('claimless waiver: a maintainer-posted none-claim-id waiver flips a stale-pending claimless PR ready', () => {
  // A genuinely claimless PR (Dependabot, Renovate, ImgBot, or similar):
  // no claim events at all, so `activeClaimId` resolves to '' inside the
  // gate -- exactly the shape `advisoryWait.convergenceScope: "all-prs"`
  // (the documented default) leaves stuck with no way to waive, before
  // #1905's `none` sentinel.
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: TRUSTED,
    claimId: 'none',
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'Dependabot PR has no IDD claim; Copilot review never lands',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [], // still pending -- the primary bot never reviewed
      claimEvents: [], // no IDD claim at all
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
  assert.equal(verdict.waiver.activeClaimId, '');
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, true);
});

test('claimless waiver: a non-none claim id posted on a claimless PR does not waive (still fails closed)', () => {
  const waiverBody = renderExternalCheckWaiverComment({
    agentId: TRUSTED,
    claimId: CLAIM_ID, // not the "none" sentinel, and no claim resolves to match it
    headSha: HEAD,
    checkSelector: 'idd-advisory-convergence',
    reason: 'attempted waiver on a claimless PR with the wrong claim id',
    expiresAt: '2026-07-12T00:00:00Z',
    actor: TRUSTED,
  });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [],
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
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
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

test('waiver: a marker bound to the superseded claim still waives after an in-policy takeover (#2080)', () => {
  const TAKEOVER_AT = '2026-06-01T02:00:00Z';
  const takeoverClaim = {
    author: { login: TRUSTED },
    body: `<!-- claimed-by: ${SUCCESSOR_AGENT_ID} ${SUCCESSOR_CLAIM_ID} supersedes: ${CLAIM_ID} ${TAKEOVER_AT} branch: issue/1234-test -->\n\n_${SUCCESSOR_AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
    createdAt: TAKEOVER_AT,
  };
  const predecessorWaiver = waiverComment({ claimId: CLAIM_ID });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment(), takeoverClaim],
      comments: [predecessorWaiver],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      staleAgeMs: 60 * 60 * 1000,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 1);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('waiver: a two-hop-old claim id does not waive after takeover (#2080)', () => {
  const TAKEOVER_AT = '2026-06-01T02:00:00Z';
  const takeoverClaim = {
    author: { login: TRUSTED },
    body: `<!-- claimed-by: ${SUCCESSOR_AGENT_ID} ${SUCCESSOR_CLAIM_ID} supersedes: ${CLAIM_ID} ${TAKEOVER_AT} branch: issue/1234-test -->\n\n_${SUCCESSOR_AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
    createdAt: TAKEOVER_AT,
  };
  const staleWaiver = waiverComment({ claimId: 'claim-grandparent' });
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment(), takeoverClaim],
      comments: [staleWaiver],
    }),
    baseOptions({
      headCommittedAt: OLD,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      staleAgeMs: 60 * 60 * 1000,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.waiver.activeClaimId, SUCCESSOR_CLAIM_ID);
  assert.equal(verdict.waiver.validCount, 0);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
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

test('sameHeadReroll: eligible when itemCount is 0 but suppressedCount > 0 (#1880 -- the same static-snapshot recovery shape as itemCount > 0)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: '<details>\n<summary>Suppressed comments (1)</summary>\nnote\n</details>',
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.sameHeadReroll.eligible, true);
  assert.equal(verdict.sameHeadReroll.requestable, true);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, []);
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

// --- 9b. sameHeadReroll.ineligibleReasons / dispositionEvidence (#1719) -----
// --- `eligible` is a conjunction of seven boolean terms (see the
// --- computation in advisory-convergence.mts); `ineligibleReasons` is
// --- derived from the SAME seven terms (`.every()` / `.filter().map()`
// --- over one shared array), so the two can never disagree. This section
// --- proves: the known-token set stays pinned to exactly seven (so a
// --- term added to the conjunction without a paired token trips a test),
// --- the array is empty exactly when eligible is true, each term
// --- produces its own token when it is the (sole, where isolable)
// --- failing one, and the `dispositionEvidence` counters that feed one
// --- of those terms are exposed on the report.

test('ineligibleReasons: the known-token set is pinned to exactly the seven eligibility terms', () => {
  // An 8th conjunct added to `sameHeadRerollEligible` without a paired
  // token in `SAME_HEAD_REROLL_INELIGIBLE_REASON` would leave this set
  // at 7, failing this pin -- the reviewer must touch this test to add
  // one.
  assert.deepEqual(
    Object.values(SAME_HEAD_REROLL_INELIGIBLE_REASON).sort(),
    [
      'already-satisfied-via-review-ack',
      'missing-regular-comment-disposition',
      'review-item-count-not-positive',
      'review-item-count-unknown',
      'review-pending',
      'scope-not-applicable',
      'unresolved-copilot-threads',
    ].sort(),
  );
});

test('ineligibleReasons: empty exactly when eligible is true', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.sameHeadReroll.eligible, true);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, []);
});

test('ineligibleReasons: scope-not-applicable fires alone when applicability is not_applicable', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })], claimEvents: [] }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'feature/no-claim',
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.applicability.status, 'not_applicable');
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.SCOPE_NOT_APPLICABLE,
  ]);
});

test('ineligibleReasons: scope-not-applicable also fires alone when applicability is indeterminate (#1686)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
      claimEvents: [claimComment()],
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-different',
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.applicability.status, 'indeterminate');
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.SCOPE_NOT_APPLICABLE,
  ]);
});

test('ineligibleReasons: review-pending co-fires with review-item-count-unknown (matchesHead false forces itemCount null)', () => {
  // Not isolable to a single token: `resolveLatestCopilotReviewClause`
  // always reports `itemCount: null` off-HEAD, so these two terms always
  // fail together -- this test documents that coupling rather than
  // asserting an unreachable single-token result.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ commitId: OTHER_SHA, itemCount: 2 })],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, true);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_PENDING,
    SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_UNKNOWN,
  ]);
});

test('ineligibleReasons: unresolved-copilot-threads fires alone when only the thread term fails', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
      threads: [
        {
          id: 'PRT_ISOLATE_THREAD',
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
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.UNRESOLVED_COPILOT_THREADS,
  ]);
});

test('ineligibleReasons: missing-regular-comment-disposition fires alone when only the disposition term fails', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
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
  assert.equal(verdict.dispositionEvidence.missingRegularCommentCount, 1);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.MISSING_REGULAR_COMMENT_DISPOSITION,
  ]);
});

test('ineligibleReasons: review-item-count-unknown fires alone when itemCount is unavailable on a matching-HEAD review', () => {
  // No `itemCount` key at all (rather than an explicit `undefined`
  // override): `Number.isFinite(undefined)` is false, so
  // `resolveLatestCopilotReviewClause` reports `itemCount: null` even
  // though `matchesHead` is true -- unlike the review-pending case above,
  // `review-item-count-not-positive` is deliberately designed NOT to
  // co-fire here (see its "unknown counts as satisfied" doc comment).
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, false);
  assert.equal(verdict.review.itemCount, null);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_UNKNOWN,
  ]);
});

test('ineligibleReasons: review-item-count-not-positive fires alone when itemCount is exactly zero', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }), // itemCount: 0 default
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.converged, true); // already fully converged
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.REVIEW_ITEM_COUNT_NOT_POSITIVE,
  ]);
});

test('reasons: itemCount > 0 with every visible Copilot thread resolved points at the review body (#1719 incident shape)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 1 })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.review.itemCount, 1);
  assert.match(
    verdict.reasons.join('\n'),
    /check the review body directly for an item suppressed due to low confidence/,
  );
});

test('reasons: itemCount > 0 with an unresolved blocking thread does NOT add the review-body pointer (a real thread already explains it)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_BLOCK', itemCount: 2 })],
      threads: [
        {
          id: 'PRT_REAL_BLOCK',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
                // #2050: binds this thread to the review under test so
                // classifyThreadIdsForReview recognizes it as real,
                // review-scoped evidence (not the zero-thread-evidence
                // shape this test is deliberately distinguishing from).
                pullRequestReview: { id: 'REVIEW_BLOCK' },
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
  assert.doesNotMatch(
    verdict.reasons.join('\n'),
    /check the review body directly/,
  );
  assert.match(verdict.reasons.join('\n'), /2 actionable item/);
});

// --- 9c. Suppressed-only Copilot review findings (#1880) --------------------

const SUPPRESSED_COMMENTS_BODY = [
  '<details>',
  '<summary>Suppressed comments (1)</summary>',
  '',
  '**tests/idd-onboard.test.mts:2122**',
  '* This test is described as exercising the documented `cspell lint',
  '  "**" --no-progress` command path, but it adds an extra `--no-cache`',
  "  flag that isn't present in the docs or in the repo's own",
  '  `lint:minimum` script. ...',
  '</details>',
].join('\n');

test('reasons: itemCount 0 with a suppressed-comments body section does NOT converge (PR #1875 commit 9711d404 shape)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.pending, false);
  assert.equal(verdict.review.itemCount, 0);
  assert.equal(verdict.review.suppressedCount, 1);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  assert.notDeepEqual(verdict.reasons, []);
  assert.match(verdict.reasons.join('\n'), /1 suppressed comment/);
  assert.match(verdict.reasons.join('\n'), /check the review body directly/);
});

test('reasons: itemCount 0 with NO suppressed-comments section still converges normally (no false block)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: '<details>\n<summary>Some unrelated collapsed section</summary>\nnothing suppressed here\n</details>',
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 0);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('reasons: itemCount 0 with an empty/absent body still converges normally (no false block)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 0 })] }), // no body key
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 0);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('reasons: a PLAIN-TEXT mention of "Suppressed comments (N)" outside a <summary> tag does NOT false-block (prose-quoted-example class, #1614)', () => {
  // Simulates an advisory bot quoting the phrase back in ordinary review
  // prose (e.g. discussing this very fix's test fixture) rather than a
  // real GitHub-rendered suppressed-comments heading -- the parser must
  // require the literal <summary>...</summary> wrapper, not a bare
  // substring match, or reviewing THIS pull request could self-block it.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: 'nit: the test fixture hardcodes the string "Suppressed comments (1)" -- consider extracting it into a shared constant.',
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 0);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('reasons: the literal <summary>...</summary> tag pair QUOTED INSIDE a code span does NOT false-block (PR #1884 Copilot review finding)', () => {
  // A reviewer discussing this exact detection logic could quote the real
  // HTML tags back in inline code or a fenced block rather than plain
  // prose -- the <summary> anchoring alone does not exclude that case;
  // parseSuppressedCommentCount must strip code regions first.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: 'consider guarding against a body that contains `<summary>Suppressed comments (1)</summary>` as a quoted example rather than a real heading.',
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 0);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('reasons: the literal <summary>...</summary> tag pair QUOTED INSIDE a fenced code block does NOT false-block', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: [
            'Example of the shape to guard against:',
            '```html',
            '<summary>Suppressed comments (1)</summary>',
            '```',
          ].join('\n'),
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 0);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('reasons: itemCount > 0 AND a suppressed section both mentioned, existing #1719 hint path unaffected', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 2, body: SUPPRESSED_COMMENTS_BODY }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, 2);
  assert.equal(verdict.review.suppressedCount, 1);
  assert.equal(verdict.converged, false);
  assert.match(verdict.reasons.join('\n'), /2 actionable item/);
  assert.match(
    verdict.reasons.join('\n'),
    /check the review body directly for an item suppressed due to low confidence/,
  );
  assert.match(verdict.reasons.join('\n'), /1 suppressed comment/);
});

test('dispositionEvidence: exposes missingRegularCommentCount feeding sameHeadReroll.eligible, plus its missingThreadCount sibling', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ itemCount: 2 })],
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
  assert.equal(verdict.dispositionEvidence.missingRegularCommentCount, 1);
  assert.equal(typeof verdict.dispositionEvidence.missingThreadCount, 'number');
});

test('dispositionEvidence: missingRegularCommentCount is zero when nothing is outstanding', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ itemCount: 2 })] }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.dispositionEvidence.missingRegularCommentCount, 0);
});

// --- 9d. review-ack disposition-aware Clause 1 (#2050) ----------------------
//
// `copilotReview()`'s default `submittedAt` is `RECENT`
// (2026-07-11T10:00:00Z) -- `ACK_AFTER_REVIEW` / `ACK_BEFORE_REVIEW` are
// chosen relative to it.

const ACK_AFTER_REVIEW = '2026-07-11T10:30:00Z'; // after RECENT
const ACK_BEFORE_REVIEW = OLD; // well before RECENT

/** `review-ack:` marker comment, matching `rerollMarkerComment`'s shape
 * above -- `createdAt` is the GitHub server timestamp the code must use;
 * `embeddedAt` (defaults to the same value) is the marker body's own
 * agent-supplied timestamp, deliberately irrelevant to validity (#2050
 * anchors on the comment's own `createdAt`, never the embedded text). */
function reviewAckComment(
  createdAt: string,
  overrides: { login?: string; headSha?: string; embeddedAt?: string } = {},
) {
  const headSha = overrides.headSha ?? HEAD;
  const embeddedAt = overrides.embeddedAt ?? createdAt;
  return {
    author: { login: overrides.login ?? TRUSTED },
    body: `review-ack: ${AGENT_ID} ${headSha} ${embeddedAt}`,
    createdAt,
  };
}

test('review-ack: nonzero itemCount with Clause 2 satisfied (via existing thread disposition) converges (#2039 shape)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_LATEST', itemCount: 1 })],
      threads: [
        {
          id: 'PRT_ACK_1',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
                // #2050: binds this thread to the LATEST review specifically
                // (classifyThreadIdsForReview) -- a resolved/dispositioned
                // thread from an OLDER, different review must not stand in
                // for the current review's own coverage.
                pullRequestReview: { id: 'REVIEW_LATEST' },
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
  assert.equal(verdict.review.itemCount, 1);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
});

test('review-ack: nonzero itemCount with Clause 2 NOT satisfied does not converge, even given a valid review-ack (#2050 acceptance criterion)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_LATEST', itemCount: 1 })],
      threads: [
        {
          id: 'PRT_ACK_2',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'nit: consider extracting this into a helper',
                createdAt: OLD,
                updatedAt: OLD,
                pullRequestReview: { id: 'REVIEW_LATEST' },
              },
            ],
          },
        },
      ],
      comments: [reviewAckComment(ACK_AFTER_REVIEW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, 1);
  assert.equal(verdict.threads.satisfied, false);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

test("review-ack: an OLDER, already-resolved thread from a DIFFERENT review does not cover the LATEST review's own itemCount (PR #2054 review)", () => {
  // A resolved Copilot thread exists PR-wide (threadClause.satisfied would
  // be true, and copilotThreadCount > 0), but it belongs to an EARLIER
  // review, not the current one -- the latest review's own itemCount: 1
  // has NO thread representation at all. Reusing the PR-wide threadClause
  // alone (without binding to review.reviewId) would incorrectly converge
  // here; classifyThreadIdsForReview must keep it blocked.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          id: 'REVIEW_OLD',
          itemCount: 0,
          submittedAt: OLD,
        }),
        copilotReview({ id: 'REVIEW_LATEST', itemCount: 1 }), // submittedAt: RECENT
      ],
      threads: [
        {
          id: 'PRT_OLD_RESOLVED',
          isResolved: true,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'an older, already-resolved finding',
                createdAt: OLD,
                updatedAt: OLD,
                pullRequestReview: { id: 'REVIEW_OLD' },
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, 1);
  assert.equal(verdict.threads.copilotThreadCount, 1);
  assert.equal(verdict.threads.satisfied, true);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  assert.match(
    verdict.reasons.join('\n'),
    /no copilot-authored review-thread evidence accounts for them/,
  );
});

test('review-ack: an unknown itemCount (null) does not converge even with a resolved review-scoped thread (PR #2054 review)', () => {
  // Copilot + CodeRabbit (independently, #2054 review): the thread-evidence
  // disjunct must fail closed on itemCount: null, not treat "at least one
  // resolved thread exists" as sufficient when the count itself is unknown.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_LATEST', itemCount: null })],
      threads: [
        {
          id: 'PRT_UNKNOWN_COUNT',
          isResolved: true,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'a finding under an unknown item count',
                createdAt: RECENT,
                updatedAt: RECENT,
                pullRequestReview: { id: 'REVIEW_LATEST' },
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, null);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

test('review-ack: itemCount 2 with only ONE review-scoped resolved thread does not converge (partial coverage, PR #2054 review)', () => {
  // Copilot + CodeRabbit (independently, #2054 review): the thread-evidence
  // disjunct must require as many review-scoped threads as claimed items,
  // not merely "at least one" -- otherwise one posted item stays
  // unaccounted for.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_LATEST', itemCount: 2 })],
      threads: [
        {
          id: 'PRT_PARTIAL_1',
          isResolved: true,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'the only dispositioned finding',
                createdAt: RECENT,
                updatedAt: RECENT,
                pullRequestReview: { id: 'REVIEW_LATEST' },
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.itemCount, 2);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  assert.match(
    verdict.reasons.join('\n'),
    /only 1 of 2 items have copilot-authored review-thread evidence/,
  );
});

test('review-ack: nonzero suppressedCount with a valid post-review ack converges', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [reviewAckComment(ACK_AFTER_REVIEW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 1);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.reasons, []);
});

test('review-ack: an ack predating the latest review does NOT cover a nonzero suppressedCount', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [reviewAckComment(ACK_BEFORE_REVIEW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 1);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
  assert.match(verdict.reasons.join('\n'), /post a trusted review-ack marker/);
});

test('review-ack: an ack from an untrusted login does not count', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [
        reviewAckComment(ACK_AFTER_REVIEW, { login: 'random-contributor' }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
});

test('review-ack: a fresh review submitted after a valid ack invalidates it automatically, no separate invalidation step', () => {
  // The same PR HEAD carries TWO Copilot reviews (an AW6 same-HEAD reroll is
  // a live example) -- the ack posted after the FIRST review must not cover
  // the SECOND, later one.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({
          itemCount: 0,
          body: SUPPRESSED_COMMENTS_BODY,
          submittedAt: OLD,
        }),
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }), // submittedAt: RECENT
      ],
      // Posted after the FIRST review (OLD) but before the SECOND (RECENT).
      comments: [reviewAckComment('2026-06-15T00:00:00Z')],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.submittedAt, RECENT);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
});

test('review-ack: a malformed marker (bad timestamp, or trailing prose) is not counted, matching the canonical OPERATIONAL_MARKERS shape', () => {
  const badTimestamp = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [
        {
          author: { login: TRUSTED },
          body: `review-ack: ${AGENT_ID} ${HEAD} not-a-timestamp`,
          createdAt: ACK_AFTER_REVIEW,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(badTimestamp);
  assert.equal(badTimestamp.review.satisfied, false);

  const trailingProse = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [
        {
          author: { login: TRUSTED },
          body: `review-ack: ${AGENT_ID} ${HEAD} ${ACK_AFTER_REVIEW} please see above`,
          createdAt: ACK_AFTER_REVIEW,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(trailingProse);
  assert.equal(trailingProse.review.satisfied, false);

  // #2054 review: a digit-shaped but semantically invalid embedded
  // calendar date/time (month 99, day 99, hour/minute/second 99) matches
  // the bare digit-count regex but must still be rejected -- proves
  // `isValidIsoTimestamp` is applied to the captured embedded field, not
  // only the digit-shape match.
  const invalidCalendarDate = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [
        {
          author: { login: TRUSTED },
          body: `review-ack: ${AGENT_ID} ${HEAD} 2026-99-99T99:99:99Z`,
          createdAt: ACK_AFTER_REVIEW,
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(invalidCalendarDate);
  assert.equal(invalidCalendarDate.review.satisfied, false);
});

test('review-ack: validity is governed by the GitHub createdAt, never the embedded timestamp (asymmetric trust-boundary cases, PR #2054 review)', () => {
  // Post-review createdAt with an OLD/bogus embedded timestamp still
  // counts -- the embedded field is untrusted operator input, never
  // consulted for validity.
  const oldEmbeddedStillCounts = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [reviewAckComment(ACK_AFTER_REVIEW, { embeddedAt: OLD })],
    }),
    baseOptions(),
  );
  assertValidVerdict(oldEmbeddedStillCounts);
  assert.equal(oldEmbeddedStillCounts.review.satisfied, true);

  // Pre-review createdAt with a FUTURE embedded timestamp must NOT count --
  // an operator cannot fake freshness by writing a future date into the
  // marker body; only the GitHub-assigned createdAt is authoritative.
  const futureEmbeddedDoesNotCount = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [
        reviewAckComment(ACK_BEFORE_REVIEW, {
          embeddedAt: '2099-01-01T00:00:00Z',
        }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(futureEmbeddedDoesNotCount);
  assert.equal(futureEmbeddedDoesNotCount.review.satisfied, false);
});

test('review-ack: an ack whose embedded HEAD SHA is not current HEAD does not validate, even when createdAt postdates the newer review (#2056 delayed-POST race)', () => {
  // Marker rendered against HEAD A, PR advances to HEAD B, Copilot
  // reviews B, then the delayed POST lands with createdAt after B's
  // submittedAt. Ordering alone would treat this as an ack of B.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [reviewAckComment(ACK_AFTER_REVIEW, { headSha: OTHER_SHA })],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
});

test('review-ack: sameHeadReroll is not eligible/requestable once a valid ack already satisfies the review (#2056)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ itemCount: 0, body: SUPPRESSED_COMMENTS_BODY }),
      ],
      comments: [reviewAckComment(ACK_AFTER_REVIEW)],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.suppressedCount, 1);
  assert.equal(verdict.review.satisfied, true);
  assert.equal(verdict.converged, true);
  assert.equal(verdict.sameHeadReroll.eligible, false);
  assert.equal(verdict.sameHeadReroll.requestable, false);
  assert.deepEqual(verdict.sameHeadReroll.ineligibleReasons, [
    SAME_HEAD_REROLL_INELIGIBLE_REASON.ALREADY_SATISFIED_VIA_REVIEW_ACK,
  ]);
});

test('review-ack: a negative itemCount with zero threads does not cover the review (#2056 fail-closed)', () => {
  // Hand-constructed: GraphQL totalCount cannot be negative, but the
  // boundary used to treat `0 >= -1` as coverage. The output itemCount
  // stays the raw -1, which the report schema rejects (minimum: 0), so
  // this case is asserted without assertValidVerdict.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview({ id: 'REVIEW_NEG', itemCount: -1 })],
    }),
    baseOptions(),
  );
  assert.equal(verdict.review.itemCount, -1);
  assert.equal(verdict.review.satisfied, false);
  assert.equal(verdict.converged, false);
  assert.equal(verdict.ready, false);
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
  assert.equal(verdict.waiver.outageRelieved, false);
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

// --- #2353: provider-outage declaration relief -----------------------

test('outage-relief: an active provider-outage declaration satisfies the terminal path with no waiver marker posted (AC1)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [], // Copilot never reviewed this HEAD -- CI check un-rerun
      claimEvents: [claimComment()],
      comments: terminalRecoveryComments(), // proves terminalUnavailable, no waiver comment
    }),
    baseOptions({
      headCommittedAt: RECENT, // the ordinary 24h deadline has NOT passed
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      outageDeclarationActive: true,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.validCount, 0); // stays direct-waiver-only, per #2021
  assert.equal(verdict.waiver.outageRelieved, true);
  assert.equal(verdict.waived, true);
  assert.equal(verdict.ready, true);
});

test('outage-relief: an active declaration does NOT relieve the deadline-only path (no proven terminal-unavailable state) (AC4)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: [], // no recovery markers at all -- terminal stays NOT_TERMINAL
    }),
    baseOptions({
      headCommittedAt: OLD, // the ordinary 24h deadline HAS passed
      waiverMode: 'maintainer-authorized',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      outageDeclarationActive: true,
    }),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.terminal.state, 'NOT_TERMINAL');
  assert.equal(verdict.deadline.passed, true);
  assert.equal(verdict.waiver.outageRelieved, false);
  assert.equal(verdict.waived, false);
  assert.equal(verdict.ready, false);
});

test('outage-relief: an active declaration does not relieve a selector outside the configured waivable scope', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: terminalRecoveryComments(),
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'maintainer-authorized',
      waivableSelectors: [], // idd-advisory-convergence never registered
      outageDeclarationActive: true,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.outageRelieved, false);
  assert.equal(verdict.ready, false);
});

test('outage-relief: waiverMode not maintainer-authorized never relieves via a declaration either', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [],
      claimEvents: [claimComment()],
      comments: terminalRecoveryComments(),
    }),
    baseOptions({
      headCommittedAt: RECENT,
      waiverMode: 'disabled',
      waivableSelectors: ADVISORY_CONVERGENCE_WAIVABLE,
      outageDeclarationActive: true,
    }),
  );
  assert.equal(verdict.terminal.state, 'COPILOT_UNAVAILABLE');
  assert.equal(verdict.waiver.outageRelieved, false);
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

test('classifyCopilotAuthoredThreadIds: #1686 -- a login-matching author is excluded when __typename proves it is not a Bot', () => {
  const ids = classifyCopilotAuthoredThreadIds(
    [
      {
        id: 'A',
        comments: {
          nodes: [
            {
              author: { login: COPILOT_LOGIN, __typename: 'User' },
              createdAt: OLD,
            },
          ],
        },
      },
      {
        id: 'B',
        comments: {
          nodes: [
            {
              author: { login: COPILOT_LOGIN, __typename: 'Bot' },
              createdAt: OLD,
            },
          ],
        },
      },
      {
        id: 'C',
        comments: {
          // No __typename on the payload at all: treated as unknown, not a
          // rejection -- preserves every pre-#1686 fixture/caller.
          nodes: [{ author: { login: COPILOT_LOGIN }, createdAt: OLD }],
        },
      },
    ],
    'copilot',
  );
  assert.deepEqual([...ids].sort(), ['B', 'C']);
});

test('#1686: Clause 1 rejects a login-matching review whose __typename proves it is not a Bot', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ author: { login: COPILOT_LOGIN, __typename: 'User' } }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.review.found, false);
  assert.equal(verdict.pending, true);
});

test('#1686: Clause 1 still accepts a login-matching review whose __typename is Bot or absent', () => {
  const withBotTypename = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        copilotReview({ author: { login: COPILOT_LOGIN, __typename: 'Bot' } }),
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(withBotTypename);
  assert.equal(withBotTypename.converged, true);

  const withoutTypename = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions(),
  );
  assertValidVerdict(withoutTypename);
  assert.equal(withoutTypename.converged, true);
});

// --- classifyClaimCandidateAmbiguity (#1686 path 2) -------------------------

test('classifyClaimCandidateAmbiguity: false when zero or exactly one candidate resolves', () => {
  const noClaim = [
    { author: { login: TRUSTED }, body: 'not a claim', createdAt: OLD },
  ];
  const claimA = [claimComment('claim-a')];
  assert.equal(
    classifyClaimCandidateAmbiguity([noClaim], [TRUSTED], false),
    false,
  );
  assert.equal(
    classifyClaimCandidateAmbiguity([claimA], [TRUSTED], false),
    false,
  );
  assert.equal(
    classifyClaimCandidateAmbiguity([noClaim, claimA], [TRUSTED], false),
    false,
  );
});

test('classifyClaimCandidateAmbiguity: true when two or more candidates each resolve an active claim', () => {
  const claimA = [claimComment('claim-a')];
  const claimB = [claimComment('claim-b')];
  assert.equal(
    classifyClaimCandidateAmbiguity([claimA, claimB], [TRUSTED], false),
    true,
  );
});

test('classifyClaimCandidateAmbiguity: an explicit candidate (--claim-issue) is never ambiguous', () => {
  const claimA = [claimComment('claim-a')];
  const claimB = [claimComment('claim-b')];
  assert.equal(
    classifyClaimCandidateAmbiguity([claimA, claimB], [TRUSTED], true),
    false,
  );
});

// --- hasTrustedClaimMarkerHistory (#1686 path 4) ----------------------------

test('hasTrustedClaimMarkerHistory: false when no candidate ever carried a trusted claim marker', () => {
  assert.equal(hasTrustedClaimMarkerHistory([], [TRUSTED]), false);
  assert.equal(
    hasTrustedClaimMarkerHistory(
      [
        [
          {
            author: { login: TRUSTED },
            body: 'just a comment',
            createdAt: OLD,
          },
        ],
      ],
      [TRUSTED],
    ),
    false,
  );
});

test('hasTrustedClaimMarkerHistory: false when the only claim marker is from an untrusted author', () => {
  assert.equal(
    hasTrustedClaimMarkerHistory(
      [[{ ...claimComment(), author: { login: 'random-account' } }]],
      [TRUSTED],
    ),
    false,
  );
});

test('hasTrustedClaimMarkerHistory: true for a still-active trusted claim (the ordinary case)', () => {
  assert.equal(
    hasTrustedClaimMarkerHistory([[claimComment()]], [TRUSTED]),
    true,
  );
});

test('hasTrustedClaimMarkerHistory: true for a STALE trusted claim -- a claimed-by marker well past staleAge with no active claim resolving', () => {
  // Ground truth for path 4: `resolveActiveClaim` never expires a claim by
  // elapsed time alone (see this function's own doc comment) -- the
  // concrete way `activeClaimPresent` becomes false while history exists is
  // an explicit release. This fixture is exactly that shape: an old
  // `claimed-by` (`OLD`, well past the 24h staleAge default relative to
  // `NOW`) followed by a trusted `unclaimed-by` release for the SAME
  // agent/claim -- `summarizeClaimValidation` resolves no active claim, but
  // the claim marker history is unambiguously real.
  const claimId = 'stale-claim-1';
  const agentId = 'claude-test';
  const released = [
    claimComment(claimId),
    {
      author: { login: TRUSTED },
      body: `<!-- unclaimed-by: ${agentId} ${claimId} ${RECENT} -->\n\n_${agentId}: issue claim released — IDD automation marker. Do not edit._`,
      createdAt: RECENT,
    },
  ];
  assert.equal(
    summarizeClaimValidation(released, { trustedMarkerLogins: [TRUSTED] })
      .activeClaimPresent,
    false,
  );
  assert.equal(hasTrustedClaimMarkerHistory([released], [TRUSTED]), true);
});

// --- resolveClaimEvidence (idd-skill#1810: collectFromGitHub's call-site
// wiring, not just the three helpers above in isolation) --------------------
//
// #1810's audit found that `pickResolvingClaimEvents`,
// `classifyClaimCandidateAmbiguity`, and `hasTrustedClaimMarkerHistory` each
// have direct unit tests (above), and `computeAdvisoryConvergenceVerdict`'s
// own `indeterminate` handling is directly tested too (the "idd-claimed
// scope" tests earlier in this file) -- but nothing proved the real
// `collectFromGitHub` call site actually COMPUTES and FORWARDS the two
// #1686 fields from raw claim-candidate data, as opposed to those fields
// silently defaulting to `false` (the exact fail-open #1686 exists to
// close). `resolveClaimEvidence` is the extracted, directly-testable form of
// that call site's wiring; the tests below exercise it with the same
// realistic candidate shapes `classifyClaimCandidateAmbiguity` (path 2) and
// `hasTrustedClaimMarkerHistory` (path 4) use above, then -- unlike the
// "idd-claimed scope" tests earlier, which hand-supply
// `claimCandidateAmbiguous`/`claimMarkerHistoryPresent` as booleans -- feed
// `resolveClaimEvidence`'s own COMPUTED output straight into
// `computeAdvisoryConvergenceVerdict`, proving the end-to-end wire.

test('resolveClaimEvidence: happy path -- a lone candidate resolves cleanly, unambiguous', () => {
  const claimA = [claimComment('claim-a')];
  // `claimMarkerHistoryPresent` is `true` here too -- a resolving active
  // claim always carries a trusted `claimed-by` marker, so the two are not
  // mutually exclusive (see `AdvisoryConvergenceInputs.claimCandidateAmbiguous`'s
  // doc comment); `claimCandidateAmbiguous: false` is what actually
  // distinguishes this happy path from #1686 path 2 below.
  assert.deepEqual(resolveClaimEvidence([claimA], [TRUSTED], false), {
    claimEvents: claimA,
    claimCandidateAmbiguous: false,
    claimMarkerHistoryPresent: true,
  });
});

test('resolveClaimEvidence: reproduces #1686 path 2 -- two candidates each independently resolve an active claim', () => {
  const claimA = [claimComment('claim-a')];
  const claimB = [claimComment('claim-b')];
  assert.deepEqual(resolveClaimEvidence([claimA, claimB], [TRUSTED], false), {
    claimEvents: [],
    claimCandidateAmbiguous: true,
    claimMarkerHistoryPresent: true,
  });
});

test('resolveClaimEvidence: reproduces #1686 path 4 -- a stale/released trusted claim marker with no currently active claim', () => {
  // Same fixture shape as the `hasTrustedClaimMarkerHistory` STALE test
  // above: an old `claimed-by` followed by a trusted `unclaimed-by` release
  // for the same agent/claim, so `activeClaimPresent` is false but genuine
  // claim history exists.
  const claimId = 'stale-claim-resolve-1';
  const agentId = 'claude-test';
  const released = [
    claimComment(claimId),
    {
      author: { login: TRUSTED },
      body: `<!-- unclaimed-by: ${agentId} ${claimId} ${RECENT} -->\n\n_${agentId}: issue claim released — IDD automation marker. Do not edit._`,
      createdAt: RECENT,
    },
  ];
  assert.deepEqual(resolveClaimEvidence([released], [TRUSTED], false), {
    claimEvents: [],
    claimCandidateAmbiguous: false,
    claimMarkerHistoryPresent: true,
  });
});

test('resolveClaimEvidence: an explicit --claim-issue candidate is returned unconditionally, never ambiguous', () => {
  const untrustedOnlyClaim = [
    {
      author: { login: 'nobody-trusted' },
      body: `<!-- claimed-by: ${AGENT_ID} ${CLAIM_ID} supersedes: none ${OLD} branch: issue/1234-test -->\n\n_${AGENT_ID}: issue claim — IDD automation marker. Do not edit._`,
      createdAt: OLD,
    },
  ];
  assert.deepEqual(
    resolveClaimEvidence([untrustedOnlyClaim], [TRUSTED], true),
    {
      claimEvents: untrustedOnlyClaim,
      claimCandidateAmbiguous: false,
      claimMarkerHistoryPresent: false,
    },
  );
});

test('resolveClaimEvidence end-to-end: its COMPUTED path-2 output (not hand-supplied booleans) drives computeAdvisoryConvergenceVerdict to indeterminate', () => {
  const claimA = [claimComment('claim-a')];
  const claimB = [claimComment('claim-b')];
  const evidence = resolveClaimEvidence([claimA, claimB], [TRUSTED], false);
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: evidence.claimEvents,
      claimCandidateAmbiguous: evidence.claimCandidateAmbiguous,
      claimMarkerHistoryPresent: evidence.claimMarkerHistoryPresent,
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'indeterminate',
    reason: 'idd-claimed-multiple-resolving-claim-candidates',
  });
  assert.equal(verdict.ready, false);
});

test('resolveClaimEvidence end-to-end: its COMPUTED path-4 output (not hand-supplied booleans) drives computeAdvisoryConvergenceVerdict to indeterminate', () => {
  const claimId = 'stale-claim-e2e-1';
  const agentId = 'claude-test';
  const released = [
    claimComment(claimId),
    {
      author: { login: TRUSTED },
      body: `<!-- unclaimed-by: ${agentId} ${claimId} ${RECENT} -->\n\n_${agentId}: issue claim released — IDD automation marker. Do not edit._`,
      createdAt: RECENT,
    },
  ];
  const evidence = resolveClaimEvidence([released], [TRUSTED], false);
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [copilotReview()],
      claimEvents: evidence.claimEvents,
      claimCandidateAmbiguous: evidence.claimCandidateAmbiguous,
      claimMarkerHistoryPresent: evidence.claimMarkerHistoryPresent,
    }),
    baseOptions({
      convergenceScope: 'idd-claimed',
      prHeadRefName: 'issue/1234-test',
    }),
  );
  assertValidVerdict(verdict);
  assert.deepEqual(verdict.applicability, {
    scope: 'idd-claimed',
    status: 'indeterminate',
    reason: 'idd-claimed-claim-history-without-active-claim',
  });
  assert.equal(verdict.ready, false);
});

test('collectFromGitHub sources claimEvents/claimCandidateAmbiguous/claimMarkerHistoryPresent from resolveClaimEvidence (idd-skill#1810: pins the call-site forwarding shape)', () => {
  // A lightweight structural pin, in the same spirit as this file's existing
  // `forbiddenInvocation` source-text check: `resolveClaimEvidence` itself
  // is proven correct above, so the one remaining risk at the real call
  // site is someone re-inlining separate calls (or dropping the forward)
  // instead of destructuring this single delegated call -- a regression
  // that would otherwise have no test coverage at all, matching #1810's own
  // "cover the call site, not just the extracted helper" framing.
  const source = readFileSync(
    new URL('../src/scripts/advisory-convergence.mts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const \{ claimEvents, claimCandidateAmbiguous, claimMarkerHistoryPresent \} =\s*\n?\s*resolveClaimEvidence\(/,
  );
});

test('collectFromGitHub sources prAuthorIsBot/exemptBotAuthoredPrs into the returned inputs/options (#1906: pins the call-site forwarding shape)', () => {
  // Same "pin the call site" spirit as the #1810 test above: the computed
  // `prAuthorIsBot` and `exemptBotAuthoredPrs` values are only useful if
  // they actually reach the returned `inputs`/`options` objects a future
  // refactor could otherwise silently drop, with no other test coverage.
  const source = readFileSync(
    new URL('../src/scripts/advisory-convergence.mts', import.meta.url),
    'utf8',
  );
  assert.match(source, /inputs:\s*\{[^}]*\bprAuthorIsBot,[^}]*\}/s);
  assert.match(source, /options:\s*\{[^}]*\bexemptBotAuthoredPrs,[^}]*\}/s);
});

test('collectFromGitHub sources reviewPolicy into the returned options (#2137: pins the call-site forwarding shape)', () => {
  const source = readFileSync(
    new URL('../src/scripts/advisory-convergence.mts', import.meta.url),
    'utf8',
  );
  assert.match(source, /options:\s*\{[^}]*\breviewPolicy,[^}]*\}/s);
});

test('collectFromGitHub resolves the provider-outage declaration at the SAME injected now the returned verdict uses (#2353, Codex review on PR #2370)', () => {
  // Same "pin the call site" spirit as the #1810/#1906/#2137 tests above:
  // `resolveProviderOutageDeclaration` must read the resolved `resolvedNow`
  // variable (which also becomes `options.now`), never a second,
  // independently-computed wall-clock `new Date()` -- a `--now`-overridden
  // invocation must evaluate declaration validity at that SAME instant,
  // not the real clock, matching every other deadline/waiver/terminal
  // computation in this same verdict.
  const source = readFileSync(
    new URL('../src/scripts/advisory-convergence.mts', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /resolveProviderOutageDeclaration\(\{[^}]*now:\s*new Date\(resolvedNow\),?[^}]*\}\)/s,
  );
  assert.match(source, /options:\s*\{\s*now:\s*resolvedNow,/);
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

// --- isSoleCopilotNotReviewedYetReason / runAdvisoryConvergenceWithPoll ----
// (#2015: bounded poll for the "not reviewed yet" race only)

test('isSoleCopilotNotReviewedYetReason: true when the bot has never reviewed and that is the only reason', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [] }),
    baseOptions(),
  );
  assert.equal(verdict.pending, true);
  assert.equal(verdict.review.found, false);
  assert.deepEqual(verdict.reasons, [
    'copilot has not reviewed this pull request yet',
  ]);
  assert.equal(isSoleCopilotNotReviewedYetReason(verdict), true);
});

test('isSoleCopilotNotReviewedYetReason: false when the verdict is already ready', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview()] }),
    baseOptions(),
  );
  assert.equal(verdict.ready, true);
  assert.equal(isSoleCopilotNotReviewedYetReason(verdict), false);
});

test('isSoleCopilotNotReviewedYetReason: false when the bot reviewed an older commit (different reason string)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [copilotReview({ commitId: OTHER_SHA })] }),
    baseOptions(),
  );
  assert.equal(verdict.pending, true);
  assert.equal(verdict.review.found, true);
  assert.equal(isSoleCopilotNotReviewedYetReason(verdict), false);
});

test('isSoleCopilotNotReviewedYetReason: false when an unrelated blocking reason accompanies the pending one', () => {
  // Zero reviews (pending, review.found === false) BUT the deadline has
  // already passed with no valid waiver, which appends its own reason
  // alongside the pending one -- reasons.length > 1, so this must not poll.
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({ reviews: [] }),
    baseOptions({ headCommittedAt: OLD, waiverMode: 'disabled' }),
  );
  assert.equal(verdict.pending, true);
  assert.equal(verdict.review.found, false);
  assert.ok(verdict.reasons.length > 1);
  assert.equal(isSoleCopilotNotReviewedYetReason(verdict), false);
});

function pollDepsFor(
  inputsSequence: AdvisoryConvergenceInputs[],
  options: AdvisoryConvergenceOptions,
): { deps: AdvisoryConvergenceDeps; collectCalls: () => number } {
  let index = 0;
  let calls = 0;
  const deps: AdvisoryConvergenceDeps = {
    collect: () => {
      calls += 1;
      const inputs = inputsSequence[Math.min(index, inputsSequence.length - 1)];
      if (index < inputsSequence.length - 1) index += 1;
      return { inputs, options };
    },
  };
  return { deps, collectCalls: () => calls };
}

// A combined fake sleep + fake clock: `sleep` advances the SAME virtual
// `now()` it is paired with, so `runAdvisoryConvergenceWithPoll`'s
// wall-clock deadline (`now() + maxWaitMs`) advances deterministically and
// instantly instead of requiring real elapsed time. Faking `sleep` alone
// (leaving `now` as the real `Date.now`) would hang the test for up to the
// real `maxWaitMs`, since a real clock barely advances between near-instant
// fake-sleep iterations.
function fakeClock(startAt = 0): {
  sleep: (ms: number) => void;
  now: () => number;
  calls: () => number;
  sleptMs: () => number[];
} {
  let time = startAt;
  const sleptMs: number[] = [];
  return {
    sleep: (ms: number) => {
      sleptMs.push(ms);
      time += ms;
    },
    now: () => time,
    calls: () => sleptMs.length,
    sleptMs: () => [...sleptMs],
  };
}

test('runAdvisoryConvergenceWithPoll: review landing within the window resolves without exhausting it', () => {
  const { deps, collectCalls } = pollDepsFor(
    [
      baseInputs({ reviews: [] }),
      baseInputs({ reviews: [] }),
      baseInputs({ reviews: [copilotReview()] }),
    ],
    baseOptions(),
  );
  const { sleep, now, calls } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 60_000, pollIntervalMs: 7_500, sleep, now },
  );
  assert.equal(verdict?.ready, true);
  assert.equal(exitCode, 0);
  // 3 collect() calls total (1 initial + 2 poll re-checks); the loop must
  // stop as soon as the review lands, well short of the 8-attempt max-wait
  // budget (60_000 / 7_500 ~= 8).
  assert.equal(collectCalls(), 3);
  assert.equal(calls(), 2);
});

test('runAdvisoryConvergenceWithPoll: review never landing still fails with the existing reason string after the window', () => {
  const { deps, collectCalls } = pollDepsFor(
    [baseInputs({ reviews: [] })],
    baseOptions(),
  );
  const { sleep, now, calls, sleptMs } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 20_000, pollIntervalMs: 7_500, sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.deepEqual(verdict?.reasons, [
    'copilot has not reviewed this pull request yet',
  ]);
  assert.equal(exitCode, 1);
  // 3 sleeps (7_500, 7_500, then capped to the remaining 5_000) but only 2
  // in-loop re-checks (collectCalls() == 3 == 1 initial + 2): the 3rd sleep
  // consumes the entire remaining budget, so the guard added in #2023
  // review round 2 (Codex/Copilot: "avoid launching a recheck after the
  // remaining budget is consumed") skips the re-check that would otherwise
  // start exactly AT the deadline.
  assert.equal(calls(), 3);
  assert.equal(collectCalls(), 3);
  // The bound is wall-clock (a deadline), not a sum of nominal intervals:
  // the final sleep is capped to the REMAINING budget (20_000 - 15_000 =
  // 5_000), not the full 7_500 nominal interval -- PR #2023 review (Codex
  // P2). Without this cap the loop would run 500ms past its documented
  // 20s bound on this exact input.
  assert.deepEqual(sleptMs(), [7_500, 7_500, 5_000]);
  assert.equal(now(), 20_000);
});

test('runAdvisoryConvergenceWithPoll: pollIntervalMs >= maxWaitMs yields zero re-checks, not an over-budget one', () => {
  // Edge case flagged during #2023 review round 2's guard fix: a caller
  // (never production, which always uses the < defaults below) configuring
  // an interval at least as large as the whole budget means the first sleep
  // alone exhausts it, so the guard must skip the re-check entirely rather
  // than launch one over an already-consumed budget.
  const { deps, collectCalls } = pollDepsFor(
    [baseInputs({ reviews: [] })],
    baseOptions(),
  );
  const { sleep, now, calls, sleptMs } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 10_000, pollIntervalMs: 30_000, sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 1);
  assert.equal(calls(), 1);
  assert.deepEqual(sleptMs(), [10_000]);
  // Only the initial (pre-loop) collect() call -- zero in-loop re-checks.
  assert.equal(collectCalls(), 1);
});

test('runAdvisoryConvergenceWithPoll: slow collection time counts against the wall-clock budget, not just sleep time', () => {
  // Simulate a slow `gh` collection pass (production `collectFromGitHub`
  // performs several real, potentially paginated API calls per re-check)
  // by having `collect()` itself advance the shared fake clock by 6s --
  // exactly the scenario Codex's P2 finding warned a sleep-only budget
  // would miss. With a 1s nominal poll interval and a 20s bound, a
  // sleep-only-counting implementation (the pre-fix behavior, which summed
  // only the nominal interval per iteration) would run roughly 20
  // iterations before noticing the budget was exhausted. The wall-clock
  // deadline fix must notice the extra 6s consumed by each collect() call
  // too, and stop far sooner.
  const { sleep, now } = fakeClock();
  let collectCalls = 0;
  const collectStartTimes: number[] = [];
  const collectEndTimes: number[] = [];
  const deps: AdvisoryConvergenceDeps = {
    collect: () => {
      collectCalls += 1;
      collectStartTimes.push(now());
      sleep(6_000);
      collectEndTimes.push(now());
      return { inputs: baseInputs({ reviews: [] }), options: baseOptions() };
    },
  };
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 20_000, pollIntervalMs: 1_000, sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 1);
  // A sleep-only-counting loop would need ~20 poll iterations (21 total
  // collect() calls) before its naive waitedMs sum reached 20_000. The
  // wall-clock deadline fix stops in single digits once real elapsed time
  // (sleep + collection) crosses the bound.
  assert.ok(
    collectCalls < 10,
    `expected far fewer than 10 collect() calls under the wall-clock fix, got ${collectCalls}`,
  );
  // #2023 review round 2 (Codex/Copilot, on this exact test): asserting
  // only the call count missed that the LAST re-check could still start at
  // or after the deadline and run long uncounted. Assert elapsed virtual
  // time directly: `runAdvisoryConvergenceWithPoll` reads `now()` for its
  // deadline right after the initial (pre-loop) collect() call returns, so
  // the deadline is `collectEndTimes[0] + maxWaitMs`; no IN-LOOP re-check
  // (every collectStartTimes entry after the first) may start at or after
  // it -- that is exactly the guard this fix adds.
  const deadline = collectEndTimes[0] + 20_000;
  for (const startedAt of collectStartTimes.slice(1)) {
    assert.ok(
      startedAt < deadline,
      `expected re-check start ${startedAt} to be before deadline ${deadline}`,
    );
  }
});

test('runAdvisoryConvergenceWithPoll: does not poll for any other not-ready reason', () => {
  const { deps, collectCalls } = pollDepsFor(
    [
      baseInputs({
        reviews: [copilotReview({ commitId: OTHER_SHA })],
      }),
    ],
    baseOptions(),
  );
  const { sleep, now, calls } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 1);
  assert.equal(collectCalls(), 1);
  assert.equal(calls(), 0);
});

test('runAdvisoryConvergenceWithPoll: without --assert never polls regardless of verdict', () => {
  const { deps, collectCalls } = pollDepsFor(
    [baseInputs({ reviews: [] })],
    baseOptions(),
  );
  const { sleep, now, calls } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234'],
    deps,
    { sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 0);
  assert.equal(collectCalls(), 1);
  assert.equal(calls(), 0);
});

test('runAdvisoryConvergenceWithPoll: --help short-circuits before collecting or sleeping', () => {
  let called = false;
  const deps: AdvisoryConvergenceDeps = {
    collect: () => {
      called = true;
      return { inputs: baseInputs(), options: baseOptions() };
    },
  };
  const { sleep, now, calls } = fakeClock();
  const { help, exitCode } = runAdvisoryConvergenceWithPoll(['--help'], deps, {
    sleep,
    now,
  });
  assert.equal(help, true);
  assert.equal(exitCode, 0);
  assert.equal(called, false);
  assert.equal(calls(), 0);
});

test('runAdvisoryConvergenceWithPoll: a reason change mid-poll stops the loop immediately instead of exhausting the window', () => {
  const { deps, collectCalls } = pollDepsFor(
    [
      baseInputs({ reviews: [] }),
      baseInputs({ reviews: [copilotReview({ commitId: OTHER_SHA })] }),
    ],
    baseOptions(),
  );
  const { sleep, now, calls } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 60_000, pollIntervalMs: 7_500, sleep, now },
  );
  assert.equal(verdict?.ready, false);
  assert.equal(verdict?.review.found, true);
  assert.equal(exitCode, 1);
  // Stops after the single re-check that reveals the new (off-HEAD) review
  // -- must not keep polling out the rest of the 60s window once the
  // blocking reason is no longer the sole "not reviewed yet" case.
  assert.equal(calls(), 1);
  assert.equal(collectCalls(), 2);
});

test('runAdvisoryConvergenceWithPoll: review lands on HEAD mid-poll with outstanding items still fails (no weakening)', () => {
  // The issue's own acceptance criterion: "lands with outstanding items"
  // must still fail exactly as today -- landing on HEAD is not itself
  // enough to pass if the review carries actionable items.
  const { deps, collectCalls } = pollDepsFor(
    [
      baseInputs({ reviews: [] }),
      baseInputs({ reviews: [copilotReview({ itemCount: 1 })] }),
    ],
    baseOptions(),
  );
  const { sleep, now, calls } = fakeClock();
  const { verdict, exitCode } = runAdvisoryConvergenceWithPoll(
    ['--pr', '1234', '--assert'],
    deps,
    { maxWaitMs: 60_000, pollIntervalMs: 7_500, sleep, now },
  );
  assert.equal(verdict?.review.found, true);
  assert.equal(verdict?.review.matchesHead, true);
  assert.equal(verdict?.review.satisfied, false);
  assert.equal(verdict?.converged, false);
  assert.equal(verdict?.ready, false);
  assert.equal(exitCode, 1);
  assert.ok(
    verdict?.reasons.some((reason) => reason.includes('actionable item')),
  );
  // Stops after the single re-check that reveals the on-HEAD review with
  // outstanding items -- not the sole "not reviewed yet" case anymore, so
  // it must not keep polling out the rest of the window.
  assert.equal(calls(), 1);
  assert.equal(collectCalls(), 2);
});

function baseValidConfig(overrides: Record<string, unknown> = {}) {
  return {
    iddVersion: '0.1.0',
    markerPrefix: 'idd-skill',
    mergePolicy: 'fully_autonomous_merge',
    reviewPolicy: 'copilot-advisory',
    threadResolutionPolicy: 'fast-agent-resolve',
    claimTiming: { staleAge: 'PT24H', heartbeatInterval: 'PT12H' },
    trustedMarkerActors: ['kurone-kito'],
    commands: {
      'install-deps': 'true',
      'fix-validate': 'true',
      'pre-push-validate': 'true',
      'post-fix-validate': 'true',
    },
    ...overrides,
  };
}

function writeConfigFixture(
  sandbox: string,
  config: Record<string, unknown>,
): string {
  const configPath = join(sandbox, '.github', 'idd', 'config.json');
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

test('readCopilotReviewPollPolicy: absent config path reproduces the hardcoded defaults exactly (#2333)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-advisory-convergence-poll-'));
  try {
    assert.deepEqual(
      readCopilotReviewPollPolicy(join(sandbox, 'does-not-exist.json')),
      {
        pollIntervalMs: DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS,
        maxWaitMs: DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
      },
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('readCopilotReviewPollPolicy: reads a configured advisoryConvergence section', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-advisory-convergence-poll-'));
  try {
    const configPath = writeConfigFixture(
      sandbox,
      baseValidConfig({
        advisoryConvergence: {
          copilotReviewPollInterval: 'PT10S',
          copilotReviewPollMaxWait: 'PT2M',
        },
      }),
    );
    assert.deepEqual(readCopilotReviewPollPolicy(configPath), {
      pollIntervalMs: 10_000,
      maxWaitMs: 120_000,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('readCopilotReviewPollPolicy: still honors advisoryConvergence when an unrelated top-level field is schema-invalid (#1359)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-advisory-convergence-poll-'));
  try {
    const configPath = writeConfigFixture(
      sandbox,
      baseValidConfig({
        advisoryConvergence: { copilotReviewPollInterval: 'PT10S' },
        unsupportedTopLevelKey: true,
      }),
    );
    assert.deepEqual(readCopilotReviewPollPolicy(configPath), {
      pollIntervalMs: 10_000,
      maxWaitMs: DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test('readCopilotReviewPollPolicy: falls back to defaults when its own advisoryConvergence section is schema-invalid', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-advisory-convergence-poll-'));
  try {
    const configPath = writeConfigFixture(
      sandbox,
      baseValidConfig({
        // Fractional seconds are not a valid whole-second duration.
        advisoryConvergence: { copilotReviewPollInterval: 'PT7.5S' },
      }),
    );
    assert.deepEqual(readCopilotReviewPollPolicy(configPath), {
      pollIntervalMs: DEFAULT_COPILOT_REVIEW_POLL_INTERVAL_MS,
      maxWaitMs: DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
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

test('formatAssertNextActions is empty when the verdict is ready (#2142)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
          itemCount: 0,
          body: '',
        },
      ],
    }),
    baseOptions(),
  );
  assert.equal(verdict.ready, true);
  assert.equal(formatAssertNextActions(verdict), '');
});

test('formatAssertNextActions covers no-review and off-HEAD (#2142)', () => {
  const none = computeAdvisoryConvergenceVerdict(baseInputs(), baseOptions());
  const noneText = formatAssertNextActions(none);
  assert.match(noneText, /has not reviewed this PR/);
  assert.match(noneText, /gh pr edit \d+ --add-reviewer copilot/);
  // #2159: the gh add-reviewer form alone is not sufficient for the
  // default bot login (GraphQL fails to resolve it) — the REST
  // requested_reviewers fallback from E14 must also be present.
  assert.match(
    noneText,
    /gh api repos\/\{owner\}\/\{repo\}\/pulls\/\d+\/requested_reviewers -X POST -f "reviewers\[\]=copilot-pull-request-reviewer\[bot\]"/,
  );
  assert.match(noneText, /post-idd-marker\.mjs --type advisory/);
  assert.doesNotMatch(
    noneText,
    /copilot has not reviewed this pull request yet/,
  );

  const offHead = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: OTHER_SHA,
          itemCount: 0,
          body: '',
        },
      ],
    }),
    baseOptions(),
  );
  const offText = formatAssertNextActions(offHead);
  assert.match(offText, /not HEAD/);
  assert.match(offText, /advisory-wait-state\.mjs/);
});

test('formatAssertNextActions covers posted items, threads, and suppressed (#2142)', () => {
  const posted = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
          itemCount: 2,
          body: '',
        },
      ],
    }),
    baseOptions(),
  );
  assert.match(formatAssertNextActions(posted), /2 posted item/);
  assert.match(formatAssertNextActions(posted), /resolve-review-thread/);

  const threads = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
          itemCount: 0,
          body: '',
        },
      ],
      threads: [
        {
          id: 'thread-copilot-1',
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: COPILOT_LOGIN },
                body: 'please extract this',
                createdAt: RECENT,
              },
            ],
          },
        },
      ],
    }),
    baseOptions(),
  );
  const threadText = formatAssertNextActions(threads);
  assert.match(threadText, /thread-copilot-1/);
  assert.match(threadText, /resolve-review-thread/);

  const suppressed = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
          itemCount: 0,
          body: '<details><summary>Suppressed comments (2)</summary></details>',
        },
      ],
    }),
    baseOptions(),
  );
  assert.match(formatAssertNextActions(suppressed), /suppressed comment/);
  assert.match(formatAssertNextActions(suppressed), /--type review-ack/);
});

test('formatAssertNextActions covers deadline, terminal, and reroll (#2142)', () => {
  const deadline = computeAdvisoryConvergenceVerdict(
    baseInputs(),
    baseOptions({ headCommittedAt: OLD, waiverMode: 'maintainer-authorized' }),
  );
  assert.equal(deadline.deadline.passed, true);
  assert.match(formatAssertNextActions(deadline), /deadline/);
  assert.match(formatAssertNextActions(deadline), /external-check waiver/);

  const terminal = computeAdvisoryConvergenceVerdict(
    baseInputs(),
    baseOptions(),
  );
  const terminalText = formatAssertNextActions({
    ...terminal,
    ready: false,
    terminal: { ...terminal.terminal, state: 'COPILOT_UNAVAILABLE' },
    waiver: { ...terminal.waiver, mode: 'disabled' },
  });
  assert.match(terminalText, /terminally unavailable/);
  assert.match(terminalText, /Hold for a maintainer/);

  const reroll = formatAssertNextActions({
    ...terminal,
    ready: false,
    sameHeadReroll: { ...terminal.sameHeadReroll, requestable: true },
  });
  assert.match(reroll, /Same-HEAD reroll/);
  assert.match(reroll, /rerun-advisory-convergence/);
});

test('formatAssertNextActions covers indeterminate applicability (#2142)', () => {
  const base = computeAdvisoryConvergenceVerdict(baseInputs(), baseOptions());
  const text = formatAssertNextActions({
    ...base,
    ready: false,
    applicability: {
      scope: 'idd-claimed',
      status: 'indeterminate',
      reason: 'idd-claimed-branch-mismatch',
    },
  });
  assert.match(text, /indeterminate/);
  assert.match(text, /claimed-by/);
  assert.doesNotMatch(text, /external-check waiver/);
});

test('nextActions token catalog is pinned and matches the schema enum (#2143)', () => {
  const tokens = Object.values(ADVISORY_CONVERGENCE_NEXT_ACTION_TOKEN).sort();
  assert.deepEqual(
    tokens,
    [
      'ack-suppressed',
      'disposition-posted-items',
      'disposition-threads',
      'hold-deadline',
      'hold-terminal',
      'indeterminate-applicability',
      'request-re-review',
      'request-review',
      'reread-verdict',
      'same-head-reroll',
      'waiver-deadline',
      'waiver-terminal',
    ].sort(),
  );
  const schemaTokens = (
    SCHEMA as {
      properties: {
        nextActions: {
          items: { properties: { token: { enum: string[] } } };
        };
      };
    }
  ).properties.nextActions.items.properties.token.enum;
  assert.deepEqual([...schemaTokens].sort(), tokens);
});

test('computeAdvisoryConvergenceVerdict: ready nextActions is empty (#2143)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs({
      reviews: [
        {
          author: { login: COPILOT_LOGIN },
          submittedAt: RECENT,
          commitId: HEAD,
          itemCount: 0,
          body: '',
        },
      ],
    }),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.ready, true);
  assert.deepEqual(verdict.nextActions, []);
  assert.deepEqual(collectAssertNextActions(verdict), []);
});

test('computeAdvisoryConvergenceVerdict: not-ready nextActions match stderr (#2143)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs(),
    baseOptions(),
  );
  assertValidVerdict(verdict);
  assert.equal(verdict.ready, false);
  assert.ok(verdict.nextActions.length > 0);
  const first = verdict.nextActions[0];
  assert.equal(
    first?.token,
    ADVISORY_CONVERGENCE_NEXT_ACTION_TOKEN.REQUEST_REVIEW,
  );
  assert.ok(first);
  const stderr = formatAssertNextActions(verdict);
  assert.match(stderr, /has not reviewed this PR/);
  for (const line of first.pointer.split('\n')) {
    assert.ok(
      stderr.includes(line),
      `stderr must contain pointer line: ${line}`,
    );
  }
  assert.deepEqual(collectAssertNextActions(verdict), verdict.nextActions);
  assert.doesNotMatch(
    JSON.stringify(verdict.reasons),
    /request-review|nextActions/,
  );
});

test('writeAdvisoryConvergenceCliOutput writes guidance before JSON (#2142)', () => {
  const verdict = computeAdvisoryConvergenceVerdict(
    baseInputs(),
    baseOptions(),
  );
  assert.equal(verdict.ready, false);
  let stdout = '';
  let stderr = '';
  writeAdvisoryConvergenceCliOutput(verdict, {
    emitGuidance: true,
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk;
      },
    },
    env: {},
  });
  assert.match(stderr, /Next action/);
  assert.match(stderr, /has not reviewed this PR/);
  const parsed = JSON.parse(stdout) as { ready: boolean; reasons: string[] };
  assert.equal(parsed.ready, false);
  assert.ok(parsed.reasons.length > 0);
  assert.doesNotMatch(stdout, /Next action/);

  let actionsErr = '';
  writeAdvisoryConvergenceCliOutput(verdict, {
    emitGuidance: true,
    stdout: { write: () => undefined },
    stderr: {
      write: (chunk) => {
        actionsErr += chunk;
      },
    },
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.match(actionsErr, /::notice::/);

  let reportErr = '';
  writeAdvisoryConvergenceCliOutput(verdict, {
    emitGuidance: false,
    stdout: { write: () => undefined },
    stderr: {
      write: (chunk) => {
        reportErr += chunk;
      },
    },
    env: { GITHUB_ACTIONS: 'true' },
  });
  assert.equal(reportErr, '');
});

test('retryTransientGhFailure retries a status-less (transport-level) failure, then succeeds (#2459)', () => {
  let calls = 0;
  const result = retryTransientGhFailure(() => {
    calls += 1;
    if (calls < 2) {
      throw new Error('unexpected end of JSON input');
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryTransientGhFailure retries a 5xx failure, then succeeds (#2459)', () => {
  let calls = 0;
  const result = retryTransientGhFailure(() => {
    calls += 1;
    if (calls < 2) {
      throw Object.assign(new Error('gh: Service Unavailable (HTTP 503)'), {
        stderr: 'gh: Service Unavailable (HTTP 503)',
      });
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('retryTransientGhFailure rethrows a definitive 4xx immediately, without retrying (#2459)', () => {
  let calls = 0;
  const notFound = Object.assign(new Error('gh: Not Found (HTTP 404)'), {
    stderr: 'gh: Not Found (HTTP 404)',
  });
  assert.throws(
    () =>
      retryTransientGhFailure(() => {
        calls += 1;
        throw notFound;
      }),
    notFound,
  );
  assert.equal(calls, 1);
});

test('retryTransientGhFailure exhausts bounded attempts and rethrows the final error unchanged (#2459)', () => {
  let calls = 0;
  let lastError: Error | undefined;
  let caught: unknown;
  try {
    retryTransientGhFailure(() => {
      calls += 1;
      lastError = new Error(`persistent transport failure ${calls}`);
      throw lastError;
    });
    assert.fail('expected retryTransientGhFailure to throw');
  } catch (error) {
    caught = error;
  }
  // Bounded to 3 attempts total, and the rethrown error is the exact same
  // instance the final attempt threw (fail-closed, never re-wrapped).
  assert.equal(calls, 3);
  assert.equal(caught, lastError);
});
