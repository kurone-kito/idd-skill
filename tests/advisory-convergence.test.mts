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
    baseOptions({ headCommittedAt: OLD, waiverMode: 'maintainer-authorized' }),
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
