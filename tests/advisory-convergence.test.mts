import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type AdvisoryConvergenceDeps,
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  classifyCopilotAuthoredThreadIds,
  computeAdvisoryConvergenceVerdict,
  parseArgs,
  runAdvisoryConvergence,
} from '../src/scripts/advisory-convergence.mts';
import { renderExternalCheckWaiverComment } from '../src/scripts/marker-helpers.mts';
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
