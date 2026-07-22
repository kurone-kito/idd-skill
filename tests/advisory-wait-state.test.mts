import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildCopilotRecoverySummary,
  parseArgs,
} from '../src/scripts/advisory-wait-state.mts';
import {
  buildAdvisoryWaitSummary,
  renderAdvisoryWaitRecoveryMarker,
} from '../src/scripts/protocol-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const advisoryWaitStateSchema = loadJson(
  'schemas/advisory-wait-state.schema.json',
);
// A relaxed clone (no top-level `required`) so a bare `{ copilotRecovery }`
// object -- not the full CLI output envelope -- can be validated against
// just that one nested schema's own `required` list.
const relaxedAdvisoryWaitStateSchema = {
  ...(advisoryWaitStateSchema as Record<string, unknown>),
  required: [],
};

// This file previously had no parse-level coverage at all (#1450: roughly
// 30 of the repository's parsers were in that state before this issue).
// It only tests the #1446 shared cli-args.mts wrapper migration; the
// business-logic summary building (buildAdvisoryWaitSummary et al.) is
// covered via protocol-helpers.test.mts. #1572's buildCopilotRecoverySummary
// lives in THIS file (advisory-wait-state.mts, not protocol-helpers.mts) and
// is covered directly below.

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses --pr, --owner, --repo, --trusted-marker-logins, and --now', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--owner',
    'kurone-kito',
    '--repo',
    'idd-skill',
    '--trusted-marker-logins',
    'a,b',
    '--now',
    '2026-07-17T00:00:00Z',
  ]);
  assert.equal(args.prNumber, 42);
  assert.equal(args.owner, 'kurone-kito');
  assert.equal(args.repo, 'idd-skill');
  assert.equal(args.trustedMarkerLogins, 'a,b');
  assert.equal(args.now, '2026-07-17T00:00:00Z');
  assert.equal(args.help, false);
});

test('parseArgs: an invalid --pr resolves to null (fails closed at the caller)', () => {
  const args = parseArgs(['--pr', 'not-a-number']);
  assert.equal(args.prNumber, null);
});

test('parseArgs: an absent --pr also resolves to null', () => {
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
  // Previously --owner would greedily accept '--now' as its literal
  // value, silently leaving --now unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--pr', '42', '--owner', '--now']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --pr', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

// --- #1572: --claim-id / --agent-id are OPTIONAL, default to '' ------------

test('parseArgs: --claim-id and --agent-id default to empty strings when absent', () => {
  const args = parseArgs(['--pr', '1572']);
  assert.equal(args.claimId, '');
  assert.equal(args.agentId, '');
});

test('parseArgs: parses --claim-id and --agent-id when supplied', () => {
  const args = parseArgs([
    '--pr',
    '1572',
    '--claim-id',
    'clm-2d1b106e486d',
    '--agent-id',
    'claude-b8bb632d',
  ]);
  assert.equal(args.claimId, 'clm-2d1b106e486d');
  assert.equal(args.agentId, 'claude-b8bb632d');
});

// =============================================================================
// #1572: buildCopilotRecoverySummary -- the terminal Copilot stall-recovery
// state contract (recovery-cycle cap accounting, terminal clock anchoring,
// fail-closed COPILOT_UNAVAILABLE determination).
// =============================================================================

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';
const AGENT = 'claude-b8bb632d';
const CLAIM = 'clm-2d1b106e486d';
const TRUSTED = [AGENT];

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

const BASE_OPTIONS = {
  now: '2026-07-22T12:00:00Z',
  trustedMarkerLogins: TRUSTED,
  claimId: CLAIM,
  agentId: AGENT,
  recoveryCycleCap: 2,
  terminalWindowMinutes: 720,
};

test('buildCopilotRecoverySummary fails closed to NOT_TERMINAL when no claim-id/agent-id is provided', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [recoveryComment({ createdAt: '2026-07-22T00:00:00Z' })],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    { ...BASE_OPTIONS, claimId: '', agentId: '' },
  );
  assert.equal(result.activeClaimProvided, false);
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'active-claim-not-provided');
  // No evidence can be trusted without the active-claim binding, so the
  // cycle count stays 0 rather than guessing.
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.clockAnchor, '');
});

test('buildCopilotRecoverySummary fails closed when only one of claim-id/agent-id is provided', () => {
  const withClaimOnly = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    { ...BASE_OPTIONS, agentId: '' },
  );
  const withAgentOnly = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    { ...BASE_OPTIONS, claimId: '' },
  );
  assert.equal(withClaimOnly.activeClaimProvided, false);
  assert.equal(withClaimOnly.reason, 'active-claim-not-provided');
  assert.equal(withAgentOnly.activeClaimProvided, false);
  assert.equal(withAgentOnly.reason, 'active-claim-not-provided');
});

test('buildCopilotRecoverySummary reports no-trusted-recovery-markers with the active claim bound but no evidence', () => {
  const result = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  assert.equal(result.activeClaimProvided, true);
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.remainingBudget, 2);
  assert.equal(result.capExhausted, false);
  assert.equal(result.clockAnchor, '');
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'no-trusted-recovery-markers');
});

test('buildCopilotRecoverySummary counts one valid bound marker and reports recovery-cap-not-exhausted', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [recoveryComment({ createdAt: '2026-07-22T00:00:00Z' })],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 1);
  assert.equal(result.remainingBudget, 1);
  assert.equal(result.capExhausted, false);
  assert.equal(result.clockAnchor, '2026-07-22T00:00:00Z');
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'recovery-cap-not-exhausted');
});

test('buildCopilotRecoverySummary exhausts the cap at two markers and reports terminal-window-not-elapsed', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({ createdAt: '2026-07-22T11:00:00Z', attempt: 1 }),
        recoveryComment({ createdAt: '2026-07-22T11:30:00Z', attempt: 2 }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS, // now = 2026-07-22T12:00:00Z, terminalWindowMinutes = 720 (12h)
  );
  assert.equal(result.completedCycleCount, 2);
  assert.equal(result.remainingBudget, 0);
  assert.equal(result.capExhausted, true);
  // Anchor is the EARLIEST of the two markers.
  assert.equal(result.clockAnchor, '2026-07-22T11:00:00Z');
  assert.equal(result.windowElapsed, false);
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'terminal-window-not-elapsed');
});

test('buildCopilotRecoverySummary reports current-head-review-exists when the terminal window elapsed but Copilot reviewed HEAD', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({ createdAt: '2026-07-21T00:00:00Z', attempt: 1 }),
        recoveryComment({ createdAt: '2026-07-21T01:00:00Z', attempt: 2 }),
      ],
      prHeadSha: SHA,
      // A current-HEAD Copilot review DOES exist.
      lastCopilotCommit: SHA,
    },
    BASE_OPTIONS,
  );
  assert.equal(result.capExhausted, true);
  assert.equal(result.windowElapsed, true);
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'current-head-review-exists');
});

test('buildCopilotRecoverySummary reports COPILOT_UNAVAILABLE only when cap exhausted, window elapsed, and no current-HEAD review, all at once', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({ createdAt: '2026-07-21T00:00:00Z', attempt: 1 }),
        recoveryComment({ createdAt: '2026-07-21T01:00:00Z', attempt: 2 }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 2);
  assert.equal(result.capExhausted, true);
  assert.equal(result.windowElapsed, true);
  assert.equal(result.state, 'COPILOT_UNAVAILABLE');
  assert.equal(
    result.reason,
    'recovery-cap-exhausted-and-terminal-window-elapsed-and-no-current-head-review',
  );
});

// --- Exclusion cases: malformed / unbound / foreign-agent / mismatched-claim
// / mismatched-HEAD / untrusted markers must never count or anchor -------

test('buildCopilotRecoverySummary excludes a malformed marker body', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        {
          author: { login: AGENT },
          body: 'advisory-wait-recovery: not a valid marker body at all',
          createdAt: '2026-07-22T00:00:00Z',
        },
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.clockAnchor, '');
});

test('buildCopilotRecoverySummary excludes a marker with an invalid/missing server createdAt (ambiguous clock evidence)', () => {
  // A structurally well-formed, correctly bound marker whose GitHub
  // `createdAt` did not validate (parseAdvisoryRecoveryComment sets this to
  // 'none') must be excluded from BOTH cycle counting and clock anchoring --
  // not anchoring alone. Otherwise it could still consume recovery-cycle
  // budget (and even flip capExhausted) without ever contributing a
  // trustworthy clock anchor, contradicting the "both counting and
  // anchoring must be derived from trusted server-created_at evidence"
  // fail-closed contract (#1572 AC4/AC5).
  const result = buildCopilotRecoverySummary(
    {
      comments: [recoveryComment({ createdAt: 'not-a-real-timestamp' })],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.remainingBudget, 2);
  assert.equal(result.capExhausted, false);
  assert.equal(result.clockAnchor, '');
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'no-trusted-recovery-markers');
});

test('buildCopilotRecoverySummary excludes a marker with an invalid createdAt even when a valid marker is also present (mixed evidence)', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({ createdAt: '2026-07-22T00:00:00Z', attempt: 1 }),
        recoveryComment({ createdAt: 'not-a-real-timestamp', attempt: 2 }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  // Only the valid-createdAt marker counts -- the invalid one contributes
  // to neither the count nor the anchor, even alongside good evidence.
  assert.equal(result.completedCycleCount, 1);
  assert.equal(result.clockAnchor, '2026-07-22T00:00:00Z');
  assert.equal(result.capExhausted, false);
});

test('buildCopilotRecoverySummary excludes the legacy unbound 3-field advisory-recovery form', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        // No claimId/attempt -> renders the legacy 3-field form, still a
        // well-formed marker but not usable recovery-cycle evidence.
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          claimId: null,
          attempt: null,
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.clockAnchor, '');
  assert.equal(result.reason, 'no-trusted-recovery-markers');
});

test('buildCopilotRecoverySummary excludes a foreign-agent marker (embedded agentId does not match)', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          agentId: 'claude-foreign00',
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
});

test('buildCopilotRecoverySummary excludes a mismatched-claim marker', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          claimId: 'clm-someone-elses-claim',
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
});

test('buildCopilotRecoverySummary excludes a mismatched-HEAD marker (both an earlier and a later HEAD)', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          headSha: OTHER_SHA,
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
});

test('buildCopilotRecoverySummary excludes an untrusted-author marker', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          login: 'some-random-user',
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 0);
});

test('buildCopilotRecoverySummary counts a mix of one valid and several excluded markers correctly', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({ createdAt: '2026-07-22T00:00:00Z' }), // valid
        recoveryComment({
          createdAt: '2026-07-22T00:05:00Z',
          login: 'untrusted',
        }),
        recoveryComment({
          createdAt: '2026-07-22T00:10:00Z',
          claimId: 'other-claim',
        }),
        recoveryComment({
          createdAt: '2026-07-22T00:15:00Z',
          headSha: OTHER_SHA,
        }),
        recoveryComment({
          createdAt: '2026-07-22T00:20:00Z',
          agentId: 'foreign-agent',
        }),
        recoveryComment({
          createdAt: '2026-07-22T00:25:00Z',
          claimId: null,
          attempt: null,
        }),
        recoveryComment({
          createdAt: 'not-a-real-timestamp',
          attempt: 3,
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(result.completedCycleCount, 1);
  assert.equal(result.clockAnchor, '2026-07-22T00:00:00Z');
});

// --- Clock anchoring: GitHub created_at only, never the embedded timestamp -

test('buildCopilotRecoverySummary anchors on the earliest GitHub created_at, ignoring embedded marker timestamps', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [
        // Posted (created_at) SECOND, but claims an EARLIER embedded
        // timestamp -- the embedded value must never win.
        recoveryComment({
          createdAt: '2026-07-22T02:00:00Z',
          timestamp: '2026-01-01T00:00:00Z',
          attempt: 2,
        }),
        // Posted (created_at) FIRST, with a LATER embedded timestamp.
        recoveryComment({
          createdAt: '2026-07-22T01:00:00Z',
          timestamp: '2026-12-31T00:00:00Z',
          attempt: 1,
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  // The anchor follows created_at (earliest = 01:00), not the embedded
  // timestamp field (which would have picked the other marker) and not
  // attempt order.
  assert.equal(result.clockAnchor, '2026-07-22T01:00:00Z');
});

// --- Idempotent re-reads: pure function, deterministic, order-independent -

test('buildCopilotRecoverySummary is idempotent across repeated calls with identical input', () => {
  const input = {
    comments: [
      recoveryComment({ createdAt: '2026-07-22T00:00:00Z', attempt: 1 }),
      recoveryComment({ createdAt: '2026-07-22T01:00:00Z', attempt: 2 }),
    ],
    prHeadSha: SHA,
    lastCopilotCommit: '',
  };
  const first = buildCopilotRecoverySummary(input, BASE_OPTIONS);
  const second = buildCopilotRecoverySummary(input, BASE_OPTIONS);
  assert.deepEqual(first, second);
});

test('buildCopilotRecoverySummary is order-independent: a shuffled comment list yields the same count and anchor', () => {
  const a = recoveryComment({ createdAt: '2026-07-22T00:00:00Z', attempt: 1 });
  const b = recoveryComment({ createdAt: '2026-07-22T01:00:00Z', attempt: 2 });
  const c = {
    author: { login: 'untrusted' },
    body: 'advisory-wait-recovery: garbage',
    createdAt: '2026-07-22T00:30:00Z',
  };
  const forward = buildCopilotRecoverySummary(
    { comments: [a, b, c], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  const reversed = buildCopilotRecoverySummary(
    { comments: [c, b, a], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  assert.deepEqual(forward, reversed);
  assert.equal(forward.completedCycleCount, 2);
  assert.equal(forward.clockAnchor, '2026-07-22T00:00:00Z');
});

// --- Validation: throws on invalid now/prHeadSha ---------------------------

test('buildCopilotRecoverySummary throws on an invalid now', () => {
  assert.throws(
    () =>
      buildCopilotRecoverySummary(
        { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
        { ...BASE_OPTIONS, now: 'not-a-timestamp' },
      ),
    /now must be an ISO 8601 UTC timestamp/,
  );
});

test('buildCopilotRecoverySummary throws on an invalid prHeadSha', () => {
  assert.throws(
    () =>
      buildCopilotRecoverySummary(
        { comments: [], prHeadSha: 'not-a-sha', lastCopilotCommit: '' },
        BASE_OPTIONS,
      ),
    /prHeadSha must be a 40-character lowercase commit SHA/,
  );
});

test("buildCopilotRecoverySummary throws on an uppercase prHeadSha (matches buildAdvisoryWaitSummary's convention: validate raw, never silently lowercase)", () => {
  // protocol-helpers.mts's buildAdvisoryWaitSummary validates prHeadSha
  // against /^[0-9a-f]{40}$/ WITHOUT lowercasing first, so an uppercase SHA
  // is rejected there. buildCopilotRecoverySummary must match that
  // convention exactly, not silently accept-and-normalize an uppercase
  // input the shared error message claims is rejected.
  assert.throws(
    () =>
      buildCopilotRecoverySummary(
        { comments: [], prHeadSha: SHA.toUpperCase(), lastCopilotCommit: '' },
        BASE_OPTIONS,
      ),
    /prHeadSha must be a 40-character lowercase commit SHA/,
  );
});

// --- Independence from requestCap / sameHeadRerollCap ----------------------

test('buildCopilotRecoverySummary cap accounting is independent of the caller passing an unrelated requestCap-shaped option', () => {
  // buildCopilotRecoverySummary has no requestCap/sameHeadRerollCap
  // parameter at all -- passing recoveryCycleCap/terminalWindowMinutes is
  // the only way to influence it, proving the two counters can never
  // collide even if a caller reuses the same options object as
  // buildAdvisoryWaitSummary.
  // Object.assign (not a fresh literal) so the unrelated extra fields do not
  // need an `any` cast to satisfy the options parameter's narrower type.
  const sharedOptions = Object.assign({}, BASE_OPTIONS, {
    requestCap: 999,
    sameHeadRerollCap: 999,
  });
  const result = buildCopilotRecoverySummary(
    {
      comments: [recoveryComment({ createdAt: '2026-07-22T00:00:00Z' })],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    sharedOptions,
  );
  assert.equal(result.cap, 2);
  assert.equal(result.completedCycleCount, 1);
});

// --- Non-bypass invariant: outcome/f3Outcome never derive from
// copilotRecovery, and vice versa -------------------------------------------

test('non-bypass invariant: COPILOT_UNAVAILABLE never forces outcome/f3Outcome to SATISFIED', () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-22T11:00:00Z', attempt: 1 }),
    recoveryComment({ createdAt: '2026-07-22T11:10:00Z', attempt: 2 }),
  ];
  const now = '2026-07-22T11:20:00Z'; // 20 min after the earliest marker

  // Copilot is still genuinely pending on this HEAD (never reviewed it),
  // and the ordinary PENDING_WINDOW_MINUTES (default 30) has NOT elapsed --
  // the shipped advisory-wait outcome must stay WAIT/REQUEST_NEEDED-shaped
  // and must never read COPILOT_UNAVAILABLE as satisfaction.
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: SHA,
      reviews: [],
      requestedReviewers: [{ login: 'copilot' }],
      timelineEvents: [],
      comments,
    },
    {
      now,
      trustedMarkerLogins: TRUSTED,
    },
  );

  // A short terminalWindowMinutes (5) makes the SAME evidence already
  // COPILOT_UNAVAILABLE from the #1572 contract's own, entirely separate,
  // computation.
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: summary.lastCopilotCommit },
    { ...BASE_OPTIONS, now, terminalWindowMinutes: 5 },
  );

  assert.equal(copilotRecovery.state, 'COPILOT_UNAVAILABLE');
  // The pre-existing, unmodified advisory-wait outcome is untouched: still
  // WAIT (Copilot is pending and the pending window has not elapsed), never
  // silently promoted to SATISFIED because the terminal signal fired.
  assert.equal(summary.outcome, 'WAIT');
  assert.notEqual(summary.outcome, 'SATISFIED');
  assert.notEqual(summary.f3Outcome, 'SATISFIED');
});

// --- Schema validation: copilotRecovery -------------------------------------

test('a NOT_TERMINAL copilotRecovery object validates against the schema', () => {
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  assert.deepEqual(
    validate({ copilotRecovery }, relaxedAdvisoryWaitStateSchema),
    [],
  );
});

test('a COPILOT_UNAVAILABLE copilotRecovery object validates against the schema', () => {
  const comments = [
    recoveryComment({ createdAt: '2026-07-21T00:00:00Z', attempt: 1 }),
    recoveryComment({ createdAt: '2026-07-21T01:00:00Z', attempt: 2 }),
  ];
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  assert.equal(copilotRecovery.state, 'COPILOT_UNAVAILABLE');
  assert.deepEqual(
    validate({ copilotRecovery }, relaxedAdvisoryWaitStateSchema),
    [],
  );
});

test('the schema rejects a copilotRecovery object missing a required field or an unknown field', () => {
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
    BASE_OPTIONS,
  );
  const relaxedSchema = relaxedAdvisoryWaitStateSchema;

  const { reason: _omitted, ...missingReason } = copilotRecovery;
  assert.notDeepEqual(
    validate({ copilotRecovery: missingReason }, relaxedSchema),
    [],
  );

  assert.notDeepEqual(
    validate(
      { copilotRecovery: { ...copilotRecovery, extraField: 'nope' } },
      relaxedSchema,
    ),
    [],
  );

  assert.notDeepEqual(
    validate(
      { copilotRecovery: { ...copilotRecovery, state: 'BOGUS_STATE' } },
      relaxedSchema,
    ),
    [],
  );
});

test('a full CLI output shape (summary fields + copilotRecovery) validates cleanly together', () => {
  // Mirrors what main() actually prints: the untouched buildAdvisoryWaitSummary
  // fields, spread alongside the new copilotRecovery object -- proving the two
  // compose against one schema without conflict.
  const comments = [
    recoveryComment({ createdAt: '2026-07-21T00:00:00Z', attempt: 1 }),
    recoveryComment({ createdAt: '2026-07-21T01:00:00Z', attempt: 2 }),
  ];
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: SHA,
      reviews: [],
      requestedReviewers: [],
      timelineEvents: [],
      comments,
    },
    { now: BASE_OPTIONS.now, trustedMarkerLogins: TRUSTED },
  );
  const copilotRecovery = buildCopilotRecoverySummary(
    { comments, prHeadSha: SHA, lastCopilotCommit: summary.lastCopilotCommit },
    BASE_OPTIONS,
  );
  const fullOutput = {
    ...summary,
    trustedMarkerActors: TRUSTED,
    trustedMarkerActorsSource: 'config',
    copilotRecovery,
  };
  assert.deepEqual(validate(fullOutput, advisoryWaitStateSchema), []);
});
