import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type AdvisoryWaitStateReport,
  advisoryMarkerComment,
  buildCopilotRecoverySummary,
  evaluateStaleRequestRecoveryAction,
  parseArgs,
  readAdvisoryWaitState,
  resolveNowFlag,
  resolveWaitFlags,
  waitForAdvisoryWaitState,
} from '../src/scripts/advisory-wait-state.mts';
import {
  NOW_FLAG_USAGE_MESSAGE,
  renderAdvisoryWaitMarker,
  renderReviewAckMarker,
} from '../src/scripts/marker-helpers.mts';
import {
  buildAdvisoryWaitSummary,
  renderAdvisoryWaitRecoveryMarker,
} from '../src/scripts/protocol-helpers.mts';
import {
  createFakeProviderAdapter,
  type FakeProviderFixture,
} from '../src/scripts/provider-adapter-fake.mts';
import type {
  ProviderComment,
  ProviderPort,
} from '../src/scripts/provider-port.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';
import { spawnHelperBinWithEnvelope, stubExecutable } from './test-utils.mts';

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
  lastEditedAt?: string | null;
}) {
  const {
    login = AGENT,
    createdAt,
    agentId = AGENT,
    headSha = SHA,
    claimId = CLAIM,
    attempt = 1,
    timestamp = '2026-07-20T00:00:00Z',
    lastEditedAt = null,
  } = overrides;
  const payload: Record<string, unknown> = { agentId, headSha, timestamp };
  if (claimId !== null) payload.claimId = claimId;
  if (attempt !== null) payload.attempt = attempt;
  return {
    author: { login },
    body: renderAdvisoryWaitRecoveryMarker(payload),
    createdAt,
    lastEditedAt,
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

// #3249: an edited (or edit-state-unresolved) trusted advisory-wait-recovery
// marker still consumes the bounded cycle budget but cannot contribute a
// trusted clock anchor -- editing the marker after posting must not reopen
// an exhausted cap or fabricate terminal timing evidence.
test('buildCopilotRecoverySummary counts edited or edit-state-unresolved recovery markers only toward the budget', () => {
  const edited = buildCopilotRecoverySummary(
    {
      comments: [
        recoveryComment({
          createdAt: '2026-07-22T00:00:00Z',
          lastEditedAt: '2026-07-22T00:30:00Z',
        }),
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(edited.completedCycleCount, 1);
  assert.equal(edited.remainingBudget, 1);
  assert.equal(edited.clockAnchor, '');
  assert.equal(edited.reason, 'no-trusted-recovery-markers');

  const unknownEditState = buildCopilotRecoverySummary(
    {
      // `recoveryComment` defaults `lastEditedAt` to `null` (unedited) --
      // this fixture explicitly omits it to model a caller that never
      // fetched edit state, distinct from a genuinely unedited marker.
      comments: [
        {
          ...recoveryComment({ createdAt: '2026-07-22T00:00:00Z' }),
          lastEditedAt: undefined,
        },
      ],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(unknownEditState.completedCycleCount, 1);
  assert.equal(unknownEditState.remainingBudget, 1);
  assert.equal(unknownEditState.clockAnchor, '');

  // Minimized shape (`lastEditedAt: null`) is still honored (control case).
  const unedited = buildCopilotRecoverySummary(
    {
      comments: [recoveryComment({ createdAt: '2026-07-22T00:00:00Z' })],
      prHeadSha: SHA,
      lastCopilotCommit: '',
    },
    BASE_OPTIONS,
  );
  assert.equal(unedited.completedCycleCount, 1);
  assert.equal(unedited.clockAnchor, '2026-07-22T00:00:00Z');
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

// --- #1742: collaborator-trust discovery must recognize advisory-reroll: ---
//
// resolveTrustedCollaboratorMarkerLogins() (not exported: it shells out to
// `gh api .../collaborators/.../permission`, which none of this file's other
// gh-backed helpers unit-test either) pre-filters candidate comments through
// this exported predicate before checking collaborator permission. A
// reroll-only-authored comment must pass the pre-filter -- otherwise its
// author is never even considered as a collaborator-trust candidate,
// regardless of their actual repository permission.

test('advisoryMarkerComment: recognizes an advisory-reroll: marker as a candidate', () => {
  assert.equal(
    advisoryMarkerComment(
      'advisory-reroll: agent-id abc123 2026-07-30T00:00:00Z',
    ),
    true,
  );
});

test('advisoryMarkerComment: still recognizes advisory-wait: and advisory-wait-recovery:', () => {
  assert.equal(advisoryMarkerComment('advisory-wait: agent-id'), true);
  assert.equal(advisoryMarkerComment('advisory-wait-recovery: agent-id'), true);
  assert.equal(advisoryMarkerComment('<!-- advisory-wait: agent-id -->'), true);
});

test('advisoryMarkerComment: rejects unrelated comment bodies', () => {
  assert.equal(advisoryMarkerComment('just a regular comment'), false);
  assert.equal(advisoryMarkerComment(''), false);
});

// --- #3541: --now CLI-boundary normalization --------------------------------

test("resolveNowFlag: an empty value returns an empty now with no error -- late sampling is the caller's job (#3551 Codex review)", () => {
  // Deliberately does NOT sample new Date() here: the CLI's own call site
  // samples the real current time immediately before buildAdvisoryWaitSummary
  // (after evidence collection), not inside resolveNowFlag (before it) --
  // see resolveNowFlag's own doc comment for why an early sample would be
  // stale by the time collection finishes.
  const { now, error } = resolveNowFlag('');
  assert.equal(error, null);
  assert.equal(now, '');
});

test('resolveNowFlag: an offset value normalizes to canonical UTC', () => {
  const { now, error } = resolveNowFlag('2026-09-27T02:20:20+09:00');
  assert.equal(error, null);
  assert.equal(now, '2026-09-26T17:20:20Z');
});

test("parseArgs + resolveNowFlag: the CLI's own argument handling normalizes an offset --now to canonical UTC", () => {
  const args = parseArgs(['--pr', '42', '--now', '2026-09-27T02:20:20+09:00']);
  const { now, error } = resolveNowFlag(args.now);
  assert.equal(error, null);
  assert.equal(now, '2026-09-26T17:20:20Z');
});

test('resolveNowFlag: a malformed value returns a one-line usage error instead of a value', () => {
  const { now, error } = resolveNowFlag('Sep 27 2026');
  assert.equal(now, '');
  assert.equal(error, NOW_FLAG_USAGE_MESSAGE);
});

// #3551 Codex review: with IDD_HELPER_ERROR_ENVELOPE=1, a malformed --now
// must classify as a usage error (kind "usage"), not a genuine advisory-wait
// state failure (kind "gate").
test('bin/idd-advisory-wait-state.mjs: a malformed --now classifies as a usage error under the opt-in error envelope', () => {
  const result = spawnHelperBinWithEnvelope('idd-advisory-wait-state.mjs', [
    '--pr',
    '1',
    '--now',
    'Sep 27 2026',
  ]);
  assert.equal(result.status, 1, JSON.stringify(result));
  assert.ok(result.envelope, JSON.stringify(result));
  assert.equal(result.envelope?.kind, 'usage');
  assert.equal(result.envelope?.exitCode, 1);
});

// --- #4116: the required-field lists must name every schema `required` entry.

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STANDARD_ADVISORY_WAIT_DOC =
  'idd-template/.github/instructions/idd-advisory-wait.instructions.md';
const MERGE_INSTRUCTIONS_DOC =
  'idd-template/.github/instructions/idd-merge.instructions.md';
const LITE_ADVISORY_WAIT_DOC =
  'idd-template/.github/instructions/lite/idd-advisory-wait-lite.instructions.md';
const HELPER_REFERENCE_DOC = 'idd-template/docs/idd-helper-scripts.md';
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;
const WHITESPACE_RUN = /\s+/;
const EVIDENCE_HEADING = /^### Advisory-wait evidence$/gm;
const NEXT_HEADING = /^#{2,4} /m;
// One bare field name in backticks: letters and digits only.
const FIELD_NAME = '`[A-Za-z][A-Za-z0-9]*`';
const FIELD_NAMES = new RegExp(FIELD_NAME, 'g');
// A run of bare names that ends with the sentence period (the standard and
// lite lists). Any other token, such as a dotted name, breaks the match, so the
// list does not parse and the test fails.
const LIST_WITH_PERIOD = new RegExp(
  `^((?:${FIELD_NAME},\\s*)*${FIELD_NAME}\\.)`,
);
const BULLET_END = /\n(?=- |\n)/;
const SEPARATORS = /[,\s]/g;

// A line-anchored label, matched whatever whitespace separates its words.
const labelPattern = (label: string): string =>
  `^${label
    .split(WHITESPACE_RUN)
    .map((word) => word.replace(REGEX_METACHARACTERS, '\\$&'))
    .join('\\s+')}`;

// The text after `label`; exactly one line may start with the label.
function textAfterLabel(text: string, label: string): string {
  const matches = [...text.matchAll(new RegExp(labelPattern(label), 'gm'))];
  assert.equal(matches.length, 1, `expected one line starting with: ${label}`);
  const [match] = matches;
  return text.slice((match.index ?? 0) + match[0].length);
}

const fieldNames = (fragment: string): string[] =>
  [...fragment.matchAll(FIELD_NAMES)].map((match) => match[0].slice(1, -1));

// The names in the list that follows `label`, up to the sentence period.
function listNamesAfterLabel(text: string, label: string): string[] {
  const list = LIST_WITH_PERIOD.exec(textAfterLabel(text, label).trimStart());
  assert.ok(list, `no field-name list ending with a period after: ${label}`);
  return fieldNames(list[1]);
}

// The names in the "Schema-required fields" bullet of the
// "### Advisory-wait evidence" section, which must be the only such heading.
function helperEvidenceBulletNames(doc: string): string[] {
  const headings = [...doc.matchAll(EVIDENCE_HEADING)];
  assert.equal(headings.length, 1, 'expected one "### Advisory-wait evidence"');
  const [heading] = headings;
  const afterHeading = doc.slice((heading.index ?? 0) + heading[0].length);
  const next = NEXT_HEADING.exec(afterHeading);
  const section = next ? afterHeading.slice(0, next.index) : afterHeading;
  const rest = textAfterLabel(section, '- Schema-required fields:');
  const bulletEnd = BULLET_END.exec(rest);
  const bullet = bulletEnd ? rest.slice(0, bulletEnd.index) : rest;
  // The bullet must hold only bare names, commas, and line breaks, so wrapped
  // prose after the last name (for example "and `x`") fails rather than passes.
  assert.equal(
    bullet.replace(FIELD_NAMES, '').replace(SEPARATORS, ''),
    '',
    'the helper bullet holds text other than bare field names',
  );
  return fieldNames(bullet);
}

test("the required-field lists match the schema's `required` array", () => {
  const required = (advisoryWaitStateSchema as { required: string[] }).required;
  assert.ok(required.length > 0, 'the schema has no required array');
  const lists: Record<string, string[]> = {
    'standard advisory-wait ("Required helper fields")': listNamesAfterLabel(
      readFileSync(join(REPO_ROOT, STANDARD_ADVISORY_WAIT_DOC), 'utf8'),
      'Required helper fields:',
    ),
    'lite advisory-wait ("Required fields")': listNamesAfterLabel(
      readFileSync(join(REPO_ROOT, LITE_ADVISORY_WAIT_DOC), 'utf8'),
      'Required fields (stop and ask if any are missing):',
    ),
    'helper reference ("Schema-required fields")': helperEvidenceBulletNames(
      readFileSync(join(REPO_ROOT, HELPER_REFERENCE_DOC), 'utf8'),
    ),
  };
  for (const [name, names] of Object.entries(lists)) {
    assert.deepEqual(
      {
        missing: required.filter((field) => !names.includes(field)),
        extra: names.filter((field) => !required.includes(field)),
        duplicates: names.filter((field, i) => names.indexOf(field) !== i),
      },
      { missing: [], extra: [], duplicates: [] },
      `${name} differs from the schema's required array`,
    );
  }
});

test('staleRequestRecovery stays claim-bound and validates its action contract', () => {
  const schema = advisoryWaitStateSchema as {
    required: string[];
    properties: Record<
      string,
      {
        required?: string[];
        properties?: Record<string, { enum?: string[] }>;
      }
    >;
  };
  const staleRequestRecovery = schema.properties.staleRequestRecovery;
  assert.ok(staleRequestRecovery);
  assert.equal(schema.required.includes('staleRequestRecovery'), false);
  assert.deepEqual(staleRequestRecovery.required, ['action', 'reason']);
  assert.deepEqual(staleRequestRecovery.properties?.action?.enum, [
    'attempt',
    'cap-exhausted',
    'not-applicable',
  ]);

  const valid = { action: 'attempt', reason: 'recovery-attempt-eligible' };
  assert.deepEqual(
    validate({ staleRequestRecovery: valid }, relaxedAdvisoryWaitStateSchema),
    [],
  );
  assert.notDeepEqual(
    validate(
      { staleRequestRecovery: { reason: valid.reason } },
      relaxedAdvisoryWaitStateSchema,
    ),
    [],
  );
  assert.notDeepEqual(
    validate(
      { staleRequestRecovery: { ...valid, action: 'unknown' } },
      relaxedAdvisoryWaitStateSchema,
    ),
    [],
  );

  const standard = readFileSync(
    join(REPO_ROOT, STANDARD_ADVISORY_WAIT_DOC),
    'utf8',
  );
  const eligibility = standard.slice(
    standard.indexOf('**Eligibility.**', standard.indexOf('AW3-S')),
    standard.indexOf('**Bounded cycle**', standard.indexOf('AW3-S')),
  );
  const normalizedEligibility = eligibility.replace(/\s+/g, ' ');
  assert.match(
    normalizedEligibility,
    /With both active-claim arguments, require/,
  );
  assert.match(
    normalizedEligibility,
    /schema-valid `staleRequestRecovery` \(`action`, `reason`\) and a recognized `action`/,
  );
  assert.match(
    normalizedEligibility,
    /missing\/invalid evidence fails closed before recovery or merge/,
  );
  assert.match(
    normalizedEligibility,
    /Without both, keep the full budget and `not-applicable` behavior/,
  );

  const helperDocs = readFileSync(
    join(REPO_ROOT, HELPER_REFERENCE_DOC),
    'utf8',
  );
  const helperContract = helperDocs.slice(
    helperDocs.indexOf('### Advisory-wait evidence'),
    helperDocs.indexOf('### Caller mapping'),
  );
  const normalizedHelperContract = helperContract.replace(/\s+/g, ' ');
  assert.match(
    normalizedHelperContract,
    /When both claim arguments are supplied, it is required with a schema-valid object containing the schema-required `action` and `reason` fields and a recognized `action`/,
  );
  assert.match(
    normalizedHelperContract,
    /Validate it before AW3-S recovery and before either F3 direct-merge branch; incomplete or unknown evidence uses the fail-closed route before recovery or merge/,
  );

  const merge = readFileSync(join(REPO_ROOT, MERGE_INSTRUCTIONS_DOC), 'utf8');
  const f3Advisory = merge.slice(
    merge.indexOf('**Advisory state revalidation (blocking)**'),
    merge.indexOf(
      '\n4. Merge the PR',
      merge.indexOf('**Advisory state revalidation (blocking)**'),
    ),
  );
  const normalizedF3Advisory = f3Advisory.replace(/\s+/g, ' ');
  assert.match(
    normalizedF3Advisory,
    /With both claim args, validate AW3-S's recovery object before either direct merge/,
  );
  assert.match(normalizedF3Advisory, /missing or invalid data stops F3/);
  assert.match(
    normalizedF3Advisory,
    /`attempt` runs AW2\/AW3-S then returns to F2 without a same-pass merge/,
  );
  assert.match(normalizedF3Advisory, /`cap-exhausted` follows AW4 and stops/);
  assert.match(
    normalizedF3Advisory,
    /Only `not-applicable` uses ordinary mapping/,
  );
  assert.match(
    normalizedF3Advisory,
    /If \*\*SATISFIED\*\*[^.]*either claim argument is omitted or its action is `not-applicable` → merge/,
  );
  assert.match(
    normalizedF3Advisory,
    /If `COPILOT_PENDING` is `"false"`[^.]*either claim argument is omitted or its action is `not-applicable` → merge/,
  );
});

test('stale-request recovery cannot attempt when either claim argument is absent', () => {
  const evidence = {
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
  };
  for (const options of [
    { ...BASE_OPTIONS, claimId: '' },
    { ...BASE_OPTIONS, agentId: '' },
  ]) {
    const copilotRecovery = buildCopilotRecoverySummary(
      { comments: [], prHeadSha: SHA, lastCopilotCommit: '' },
      options,
    );
    assert.equal(copilotRecovery.activeClaimProvided, false);
    assert.equal(copilotRecovery.remainingBudget, copilotRecovery.cap);
    assert.deepEqual(
      evaluateStaleRequestRecoveryAction({
        ...evidence,
        remainingBudget: copilotRecovery.remainingBudget,
        activeClaimProvided: copilotRecovery.activeClaimProvided,
      }),
      {
        action: 'not-applicable',
        reason: 'active-claim-not-provided',
      },
    );
  }
});

// --- Copilot "wasn't able to review any files" decline (#4142) -----------
// A declined head is terminal at once: no recovery marker, no clock anchor,
// and no cap or window wait. Without a claim binding it still fails closed.

test('decline (#4142): copilotDeclinedHead reaches COPILOT_UNAVAILABLE with no marker, no clock anchor, and no cap or window wait', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [],
      prHeadSha: SHA,
      lastCopilotCommit: '',
      copilotDeclinedHead: true,
    },
    BASE_OPTIONS,
  );
  assert.equal(result.state, 'COPILOT_UNAVAILABLE');
  assert.equal(result.reason, 'copilot-declined-no-reviewable-files');
  assert.equal(result.clockAnchor, '');
  assert.equal(result.completedCycleCount, 0);
  assert.equal(result.capExhausted, false);
  assert.equal(result.windowElapsed, false);
});

test('decline (#4142): without a claim binding the decline still fails closed to NOT_TERMINAL', () => {
  const result = buildCopilotRecoverySummary(
    {
      comments: [],
      prHeadSha: SHA,
      lastCopilotCommit: '',
      copilotDeclinedHead: true,
    },
    { ...BASE_OPTIONS, claimId: '', agentId: '' },
  );
  assert.equal(result.state, 'NOT_TERMINAL');
  assert.equal(result.reason, 'active-claim-not-provided');
});

test('decline (#4142): a declined head never yields a recovery attempt, while the same evidence without the decline still does', () => {
  const evidence = {
    copilotPending: true,
    copilotPendingCoversHead: false,
    sameHeadMarkerPresent: false,
    remainingBudget: 2,
    activeClaimProvided: true,
  };
  assert.deepEqual(
    evaluateStaleRequestRecoveryAction({
      ...evidence,
      copilotDeclinedHead: true,
    }),
    {
      action: 'not-applicable',
      reason: 'copilot-declined-no-reviewable-files',
    },
  );
  assert.equal(
    evaluateStaleRequestRecoveryAction({
      ...evidence,
      copilotDeclinedHead: false,
    }).action,
    'attempt',
  );
});

// --- CLI baseline (#4378): the printed state of a run without --wait ---------
// A stubbed `gh` answers the ten call forms one read makes, so these tests run
// the real helper binary end to end. The stub counts head-SHA reads in a file
// (every call is a new process) and fails from the Nth one on.

const CLI_HEAD_SHA = 'a'.repeat(40);

interface GhStubOptions {
  /** The head-SHA read that fails, and every one after it (1 = the first). */
  failHeadFrom: number;
  /** GraphQL comment nodes served for the pull request. */
  commentNodes: unknown[];
}

function advisoryWaitGhStubBody(
  stateDir: string,
  options: GhStubOptions,
): string {
  return `const fs = require('node:fs');
const CONFIG = ${JSON.stringify({ ...options, stateDir, head: CLI_HEAD_SHA })};
const args = process.argv.slice(2);
fs.appendFileSync(CONFIG.stateDir + '/calls', args.join(' ') + '\\n');
const include = args.includes('--include');
const reply = (text) => process.stdout.write(
  include ? 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n\\r\\n' + text : text,
);
const fail = (why) => {
  process.stderr.write('gh stub: ' + why + '\\n');
  process.exit(1);
};
if (args[0] === 'auth') {
  process.stdout.write('stub-token\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('viewer\\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'view') {
  const counter = CONFIG.stateDir + '/head-calls';
  let calls = 0;
  try { calls = Number(fs.readFileSync(counter, 'utf8')); } catch {}
  calls += 1;
  fs.writeFileSync(counter, String(calls));
  if (calls >= CONFIG.failHeadFrom) fail('HTTP 502 on a head read');
  process.stdout.write(CONFIG.head + '\\n');
  process.exit(0);
}
const path = args[0] === 'api' ? String(args[1]) : '';
if (/\\/pulls\\/\\d+\\/reviews$/.test(path)) process.exit(0);
if (/\\/issues\\/\\d+\\/timeline$/.test(path)) process.exit(0);
if (/\\/pulls\\/\\d+\\/requested_reviewers$/.test(path)) {
  reply(JSON.stringify({ users: [] }));
  process.exit(0);
}
if (path === 'graphql') {
  const text = args.join('\\n');
  if (text.includes('comments(first')) {
    process.stdout.write(JSON.stringify({ data: { repository: { issue: { comments: {
      nodes: CONFIG.commentNodes,
      pageInfo: { hasNextPage: false, endCursor: null },
    } } } } }));
    process.exit(0);
  }
  if (text.includes('reviewRequests')) {
    process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: {
      reviewRequests: { nodes: [] },
    } } } }));
    process.exit(0);
  }
}
fail('unexpected call: ' + args.join(' ').slice(0, 200));
`;
}

/** Run `run` with a stubbed `gh` and an empty working directory (no config). */
function withAdvisoryWaitGhStub<T>(
  options: GhStubOptions,
  run: (cwd: string) => T,
): T {
  const root = mkdtempSync(join(tmpdir(), 'idd-aw-cli-'));
  const restoreGh = stubExecutable('gh', advisoryWaitGhStubBody(root, options));
  try {
    return run(root);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
}

const CLI_ARGS = ['--pr', '1', '--owner', 'o', '--repo', 'r'] as const;

test('bin/idd-advisory-wait-state.mjs: a run without --wait prints the state with neither wait field (#4378 baseline)', () => {
  const result = withAdvisoryWaitGhStub(
    { failHeadFrom: 99, commentNodes: [] },
    (cwd) =>
      spawnHelperBinWithEnvelope('idd-advisory-wait-state.mjs', [...CLI_ARGS], {
        cwd,
      }),
  );
  assert.equal(result.status, 0, JSON.stringify(result));
  const printed = JSON.parse(result.stdout) as Record<string, unknown>;
  const { now, ...rest } = printed;
  assert.match(String(now), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  assert.deepEqual(rest, {
    protocolVersion: '1',
    prHeadSha: CLI_HEAD_SHA,
    lastCopilotCommit: '',
    copilotPending: false,
    copilotPendingCoversHead: false,
    outcome: 'REQUEST_NEEDED',
    f3Outcome: 'SATISFIED',
    secondaryBotLogin: '',
    secondaryBotLogins: [],
    secondaryRequestLogins: [],
    secondaryRequestNeeded: false,
    requestCap: 30,
    pendingWindowMinutes: 30,
    settledWindowMinutes: 10,
    pollIntervalMinutes: 2,
    capExhaustedRoute: 'phase-specific',
    elapsedMinutes: 0,
    sameHeadMarkerPresent: false,
    sameHeadRequestMarkerPresent: false,
    earliestSameHeadAt: '',
    sameHeadMarkerCount: 0,
    requestMarkerCount: 0,
    trustedMarkerSummary: {
      viewerLogin: 'viewer',
      configuredTrustedActors: [],
      collaboratorTrustEnabled: false,
      trustedMarkerLogins: ['viewer'],
      trustedSameHeadMarkerCount: 0,
      untrustedSameHeadMarkerCount: 0,
      trustedRequestMarkerCount: 0,
      untrustedRequestMarkerCount: 0,
    },
    trustedMarkerActors: [],
    trustedMarkerActorsSource: 'none',
    copilotRecovery: {
      cap: 2,
      completedCycleCount: 0,
      remainingBudget: 2,
      capExhausted: false,
      terminalWindowMinutes: 720,
      clockAnchor: '',
      elapsedMinutes: 0,
      windowElapsed: false,
      activeClaimProvided: false,
      state: 'NOT_TERMINAL',
      reason: 'active-claim-not-provided',
    },
    staleRequestRecovery: {
      action: 'not-applicable',
      reason: 'active-claim-not-provided',
    },
  });
});

// --- #4378: --wait polling at the provider-port seam -----------------------
// The fake provider adapter sits behind a default-deny wrapper: it counts the
// read methods this helper calls and throws on any other method (every
// mutator included), so a row that ever wrote would fail at once. An injected
// clock and `sleep` stand in for real time; the injected `sleep` is the only
// thing that advances the clock, and a row may change the fixture there.

const WAIT_PR = 4378;
const WAIT_SHA = '1'.repeat(40);
const WAIT_OTHER_SHA = '2'.repeat(40);
const WAIT_START_MS = Date.parse('2026-10-16T00:00:00Z');
const MINUTE_MS = 60_000;
const WAIT_INPUT = {
  prNumber: WAIT_PR,
  owner: 'o',
  repo: 'r',
  trustedMarkerLogins: '',
  claimId: '',
  agentId: '',
};
const CLAIMED_WAIT_INPUT = {
  ...WAIT_INPUT,
  claimId: 'clm-4378',
  agentId: 'claude-4378',
};
// The provider reads one run of the helper makes. Anything else is refused.
const WAIT_READ_METHODS = new Set([
  'resolveViewerLoginSafe',
  'getChangeRequestHeadSha',
  'listReviews',
  'getChangeRequestRequestedReviewerLogins',
  'getChangeRequestRequestedReviewerLoginsGraphql',
  'getWorkItemTimeline',
  'listWorkItemComments',
  'getCollaboratorPermission',
]);

const isoSeconds = (ms: number): string =>
  new Date(ms).toISOString().replace('.000Z', 'Z');

function markerComment(
  id: number,
  headSha: string,
  ageMinutes: number,
): ProviderComment {
  const at = isoSeconds(WAIT_START_MS - ageMinutes * MINUTE_MS);
  return {
    id,
    body: renderAdvisoryWaitMarker({
      agentId: 'agent',
      headSha,
      timestamp: at,
    }),
    createdAt: at,
    updatedAt: at,
    authorLogin: 'idd-bot',
    lastEditedAt: null,
  };
}

/** A fixture whose same-head request marker is `ageMinutes` old at the start. */
function waitFixture(
  overrides: {
    markerAgeMinutes?: number | null;
    comments?: ProviderComment[];
    reviews?: unknown[];
  } = {},
): FakeProviderFixture {
  const age =
    overrides.markerAgeMinutes === undefined ? 0 : overrides.markerAgeMinutes;
  return {
    viewerLogin: 'idd-bot',
    changeRequestHeadShas: { [WAIT_PR]: WAIT_SHA },
    reviews: { [WAIT_PR]: overrides.reviews ?? [] },
    comments: {
      [WAIT_PR]: [
        ...(age === null ? [] : [markerComment(1, WAIT_SHA, age)]),
        ...(overrides.comments ?? []),
      ],
    },
  };
}

interface MeteredPort {
  port: ProviderPort;
  /** Every counted read call. */
  reads: () => number;
  /** Every refused method name, in call order. */
  denied: string[];
}

function meteredPort(fixture: FakeProviderFixture): MeteredPort {
  const inner = createFakeProviderAdapter(fixture);
  let reads = 0;
  const denied: string[] = [];
  const port = new Proxy(inner, {
    get(target, name) {
      const member = Reflect.get(target, name) as unknown;
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        const method = String(name);
        if (!WAIT_READ_METHODS.has(method)) {
          denied.push(method);
          throw new Error(
            `provider method refused in a read-only run: ${method}`,
          );
        }
        reads += 1;
        return member.apply(target, args);
      };
    },
  });
  return { port, reads: () => reads, denied };
}

/** Run `run` with the working directory set to an empty directory, so the policy is the distributed default. */
function withEmptyCwd<T>(run: () => T): T {
  const previous = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), 'idd-aw-wait-'));
  process.chdir(dir);
  try {
    return run();
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

interface WaitRun {
  report: AdvisoryWaitStateReport;
  /** Every `sleep` argument, in call order. */
  sleeps: number[];
  /** Counted read calls over the whole wait. */
  reads: number;
  /** Counted read calls of one run without --wait on the starting fixture. */
  singleRunReads: number;
  /** The injected clock after the call, in ms since the start. */
  elapsedMs: number;
}

function runWait(
  fixture: FakeProviderFixture,
  options: {
    waitMs: number;
    pollIntervalMs?: number | null;
    input?: typeof WAIT_INPUT;
    /** Called inside `sleep` after the clock advances (1-based). */
    onSleep?: (sleepNumber: number, fixture: FakeProviderFixture) => void;
  },
): WaitRun {
  return withEmptyCwd(() => {
    const single = meteredPort(fixture);
    readAdvisoryWaitState(single.port, {
      ...(options.input ?? WAIT_INPUT),
      now: '',
      clock: () => WAIT_START_MS,
    });
    assert.deepEqual(single.denied, []);
    const metered = meteredPort(fixture);
    let nowMs = WAIT_START_MS;
    const sleeps: number[] = [];
    const report = waitForAdvisoryWaitState(
      metered.port,
      options.input ?? WAIT_INPUT,
      {
        waitMs: options.waitMs,
        pollIntervalMs: options.pollIntervalMs,
        sleep: (ms) => {
          sleeps.push(ms);
          nowMs += ms;
          options.onSleep?.(sleeps.length, fixture);
        },
        now: () => nowMs,
      },
    );
    assert.deepEqual(metered.denied, [], 'a mutating method was called');
    return {
      report,
      sleeps,
      reads: metered.reads(),
      singleRunReads: single.reads(),
      elapsedMs: nowMs - WAIT_START_MS,
    };
  });
}

const POLICY_INTERVAL_MS = 2 * MINUTE_MS;

test('--wait seam: a first read that is not WAIT returns at once with waitedSeconds 0', () => {
  const run = runWait(waitFixture({ markerAgeMinutes: null }), {
    waitMs: 8 * MINUTE_MS,
  });
  assert.notEqual(run.report.outcome, 'WAIT');
  assert.equal(run.report.waitEnded, 'settled');
  assert.equal(run.report.waitedSeconds, 0);
  assert.deepEqual(run.sleeps, []);
  assert.ok(run.singleRunReads > 0);
  assert.equal(run.reads, run.singleRunReads);
});

test('--wait seam: WAIT, WAIT, then SATISFIED sleeps two policy intervals and settles', () => {
  // The marker is 6 minutes old at the start, so the 10-minute settled window
  // closes at the third read (6, 8, 10 minutes old).
  const run = runWait(waitFixture({ markerAgeMinutes: 6 }), {
    waitMs: 8 * MINUTE_MS,
  });
  assert.equal(run.report.pollIntervalMinutes * MINUTE_MS, POLICY_INTERVAL_MS);
  assert.deepEqual(run.sleeps, [POLICY_INTERVAL_MS, POLICY_INTERVAL_MS]);
  assert.equal(run.report.outcome, 'SATISFIED');
  assert.equal(run.report.waitEnded, 'settled');
  assert.equal(run.report.waitedSeconds, run.elapsedMs / 1000);
  assert.equal(run.report.waitedSeconds, 240);
  assert.equal(run.reads, 3 * run.singleRunReads);
});

// A default-bot decline review plus a trusted review-ack keeps `outcome` at
// WAIT (the marker is fresh) while the head is a terminal Copilot decline.
const DECLINE_REVIEW = {
  state: 'COMMENTED',
  user: { login: 'copilot-pull-request-reviewer[bot]', type: 'Bot' },
  submitted_at: '2026-10-15T23:59:00Z',
  commit_id: WAIT_SHA,
  body: "Copilot wasn't able to review any files in this pull request. Check if the **files changed** in this pull request are included in [default exclusions](https://docs.github.com/en/copilot/reference/review-excluded-files).",
};

function declinedHeadFixture(): FakeProviderFixture {
  const ackAt = isoSeconds(WAIT_START_MS - MINUTE_MS / 2);
  return waitFixture({
    markerAgeMinutes: 1,
    reviews: [DECLINE_REVIEW],
    comments: [
      {
        id: 2,
        body: renderReviewAckMarker({
          agentId: 'agent',
          headSha: WAIT_SHA,
          timestamp: ackAt,
        }),
        createdAt: ackAt,
        updatedAt: ackAt,
        authorLogin: 'idd-bot',
        lastEditedAt: null,
      },
    ],
  });
}

test('--wait seam: WAIT with COPILOT_UNAVAILABLE returns at once when the claim and agent ids are given', () => {
  const run = runWait(declinedHeadFixture(), {
    waitMs: 8 * MINUTE_MS,
    input: CLAIMED_WAIT_INPUT,
  });
  assert.equal(run.report.outcome, 'WAIT');
  assert.equal(run.report.copilotRecovery.state, 'COPILOT_UNAVAILABLE');
  assert.equal(run.report.waitEnded, 'settled');
  assert.deepEqual(run.sleeps, []);
});

test('--wait seam: the same input without the claim and agent ids stays NOT_TERMINAL and keeps waiting, even with f3Outcome SATISFIED', () => {
  const run = runWait(declinedHeadFixture(), { waitMs: 4 * MINUTE_MS });
  assert.equal(run.report.outcome, 'WAIT');
  assert.equal(run.report.f3Outcome, 'SATISFIED');
  assert.equal(run.report.copilotRecovery.state, 'NOT_TERMINAL');
  assert.deepEqual(run.sleeps, [POLICY_INTERVAL_MS, POLICY_INTERVAL_MS]);
  assert.equal(run.report.waitEnded, 'bound-elapsed');
});

test('--wait seam: PT8M with PT70S reads at 0, 70, ..., 420 and 480 seconds and ends bound-elapsed', () => {
  // A fresh marker stays WAIT for 10 minutes, so the state never settles.
  const run = runWait(waitFixture({ markerAgeMinutes: 0 }), {
    waitMs: 8 * MINUTE_MS,
    pollIntervalMs: 70_000,
  });
  assert.deepEqual(
    run.sleeps,
    [70_000, 70_000, 70_000, 70_000, 70_000, 70_000, 60_000],
  );
  assert.equal(run.report.waitEnded, 'bound-elapsed');
  assert.equal(run.report.waitedSeconds, 480);
  assert.ok(run.singleRunReads > 0);
  assert.equal(run.reads, 8 * run.singleRunReads);
  assert.equal(run.reads, run.singleRunReads * (1 + Math.ceil(480 / 70)));
});

test('--wait seam: WAIT until the deadline and SATISFIED on the final read ends settled, with the final read printed', () => {
  // 3 minutes old at the start: 3, 5, 7, 9 minutes old at the first four
  // reads, then the clamped sleep ends at 8 minutes (11 minutes old).
  const run = runWait(waitFixture({ markerAgeMinutes: 3 }), {
    waitMs: 8 * MINUTE_MS,
  });
  assert.equal(run.report.outcome, 'SATISFIED');
  assert.equal(run.report.elapsedMinutes, 11);
  assert.equal(run.report.waitEnded, 'settled');
  assert.equal(run.report.waitedSeconds, 480);
  assert.equal(run.sleeps.at(-1), 2 * MINUTE_MS);
});

test('--wait seam: a default interval longer than --wait collapses to --wait, one sleep and one final read', () => {
  const run = runWait(waitFixture({ markerAgeMinutes: 0 }), {
    waitMs: MINUTE_MS,
  });
  assert.deepEqual(run.sleeps, [MINUTE_MS]);
  assert.equal(run.report.waitEnded, 'bound-elapsed');
  assert.equal(run.reads, 2 * run.singleRunReads);
});

test('--wait seam: a later head ends the wait at once as head-changed and prints that later read', () => {
  const run = runWait(waitFixture({ markerAgeMinutes: 0 }), {
    waitMs: 8 * MINUTE_MS,
    onSleep: (number, fixture) => {
      if (number === 1) {
        // A push: the new head carries no marker, so its state is REQUEST_NEEDED.
        fixture.changeRequestHeadShas = { [WAIT_PR]: WAIT_OTHER_SHA };
      }
    },
  });
  assert.equal(run.report.waitEnded, 'head-changed');
  assert.equal(run.report.prHeadSha, WAIT_OTHER_SHA);
  assert.equal(run.report.outcome, 'REQUEST_NEEDED');
  assert.deepEqual(run.sleeps, [POLICY_INTERVAL_MS]);
});

test('--wait seam: a head change on the read at the deadline is head-changed, not bound-elapsed', () => {
  // The new head still reads WAIT (it has its own fresh marker), so only the
  // head rule can end this wait with something other than bound-elapsed.
  const fixture = waitFixture({
    markerAgeMinutes: 0,
    comments: [markerComment(3, WAIT_OTHER_SHA, 0)],
  });
  const run = runWait(fixture, {
    waitMs: 2 * MINUTE_MS,
    onSleep: (_number, current) => {
      current.changeRequestHeadShas = { [WAIT_PR]: WAIT_OTHER_SHA };
    },
  });
  assert.equal(run.report.outcome, 'WAIT');
  assert.equal(run.report.prHeadSha, WAIT_OTHER_SHA);
  assert.equal(run.report.waitEnded, 'head-changed');
  assert.equal(run.report.waitedSeconds, 120);
});

test('--wait seam: a read that throws on a later poll propagates unchanged', () => {
  assert.throws(
    () =>
      runWait(waitFixture({ markerAgeMinutes: 0 }), {
        waitMs: 8 * MINUTE_MS,
        onSleep: (number, fixture) => {
          if (number === 2) fixture.changeRequestHeadShas = {};
        },
      }),
    { message: `fake provider: no head SHA fixture for PR ${WAIT_PR}` },
  );
});

test('--wait seam: the read after a clamped last sleep is final even when the clock wakes early', () => {
  // A clock that runs 1 ms behind every sleep. After six 70-second sleeps the
  // remaining time is 60006 ms; that clamped sleep ends 1 ms before the
  // deadline, and without the "final read" rule the loop would sleep and read
  // once more (a ninth read).
  const fixture = waitFixture({ markerAgeMinutes: 0 });
  const { report, sleeps, reads, singleRunReads } = withEmptyCwd(() => {
    const single = meteredPort(fixture);
    readAdvisoryWaitState(single.port, {
      ...WAIT_INPUT,
      now: '',
      clock: () => WAIT_START_MS,
    });
    const metered = meteredPort(fixture);
    let nowMs = WAIT_START_MS;
    const sleepLog: number[] = [];
    const result = waitForAdvisoryWaitState(metered.port, WAIT_INPUT, {
      waitMs: 8 * MINUTE_MS,
      pollIntervalMs: 70_000,
      sleep: (ms) => {
        sleepLog.push(ms);
        nowMs += ms - 1;
      },
      now: () => nowMs,
    });
    return {
      report: result,
      sleeps: sleepLog,
      reads: metered.reads(),
      singleRunReads: single.reads(),
    };
  });
  assert.equal(report.waitEnded, 'bound-elapsed');
  // 479999 ms elapsed: the seconds round down, never up.
  assert.equal(report.waitedSeconds, 479);
  assert.equal(sleeps.length, 7);
  assert.equal(sleeps.at(-1), 60_006);
  assert.equal(reads, 8 * singleRunReads);
});

test('--wait seam: every report validates against the schema, with and without --wait', () => {
  const waited = runWait(waitFixture({ markerAgeMinutes: 6 }), {
    waitMs: 8 * MINUTE_MS,
  });
  assert.deepEqual(validate(waited.report, advisoryWaitStateSchema), []);
  const single = withEmptyCwd(() =>
    readAdvisoryWaitState(meteredPort(waitFixture()).port, {
      ...WAIT_INPUT,
      now: '',
      clock: () => WAIT_START_MS,
    }),
  );
  assert.equal('waitedSeconds' in single, false);
  assert.equal('waitEnded' in single, false);
  assert.deepEqual(validate(single, advisoryWaitStateSchema), []);
});

test('--wait seam: the schema keeps waitedSeconds and waitEnded optional', () => {
  const schema = advisoryWaitStateSchema as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.ok('waitedSeconds' in schema.properties);
  assert.ok('waitEnded' in schema.properties);
  assert.equal(schema.required.includes('waitedSeconds'), false);
  assert.equal(schema.required.includes('waitEnded'), false);
});

test('--wait seam: a wait bound that is not a positive number is refused', () => {
  for (const waitMs of [0, -1, Number.NaN]) {
    assert.throws(
      () =>
        waitForAdvisoryWaitState(meteredPort(waitFixture()).port, WAIT_INPUT, {
          waitMs,
          sleep: () => undefined,
          now: () => WAIT_START_MS,
        }),
      /waitMs must be a positive number/,
    );
  }
});

// --- #4378: argument handling ------------------------------------------------

test('parseArgs: --wait and --poll-interval are null when absent and kept as typed when given', () => {
  const absent = parseArgs(['--pr', '1']);
  assert.equal(absent.wait, null);
  assert.equal(absent.pollInterval, null);
  const given = parseArgs([
    '--pr',
    '1',
    '--wait',
    'PT5M',
    '--poll-interval',
    'PT2M',
  ]);
  assert.equal(given.wait, 'PT5M');
  assert.equal(given.pollInterval, 'PT2M');
});

interface WaitFlagInput {
  wait: string | null;
  pollInterval: string | null;
  now: string;
}

const noWaitFlags: WaitFlagInput = { wait: null, pollInterval: null, now: '' };

test('resolveWaitFlags: no --wait resolves to a single read', () => {
  assert.deepEqual(resolveWaitFlags(noWaitFlags), {
    error: null,
    waitMs: null,
    pollIntervalMs: null,
  });
});

test('resolveWaitFlags: --wait and --poll-interval resolve to milliseconds', () => {
  assert.deepEqual(resolveWaitFlags({ ...noWaitFlags, wait: 'PT8M' }), {
    error: null,
    waitMs: 480_000,
    pollIntervalMs: null,
  });
  assert.deepEqual(resolveWaitFlags({ ...noWaitFlags, wait: 'PT1S' }), {
    error: null,
    waitMs: 1000,
    pollIntervalMs: null,
  });
  assert.deepEqual(
    resolveWaitFlags({ ...noWaitFlags, wait: 'PT8M', pollInterval: 'PT70S' }),
    { error: null, waitMs: 480_000, pollIntervalMs: 70_000 },
  );
  assert.deepEqual(
    resolveWaitFlags({ ...noWaitFlags, wait: 'PT60S', pollInterval: 'PT60S' }),
    { error: null, waitMs: 60_000, pollIntervalMs: 60_000 },
  );
});

const BAD_WAIT_FLAGS: readonly [string, Partial<WaitFlagInput>][] = [
  ['an empty --wait', { wait: '' }],
  ['a zero --wait', { wait: 'PT0S' }],
  ['a malformed --wait', { wait: '8m' }],
  ['a --wait above PT8M', { wait: 'PT8M1S' }],
  ['a day-sized --wait', { wait: 'P1D' }],
  ['a --poll-interval below PT60S', { wait: 'PT8M', pollInterval: 'PT59S' }],
  ['a --poll-interval above --wait', { wait: 'PT2M', pollInterval: 'PT121S' }],
  ['an empty --poll-interval', { wait: 'PT8M', pollInterval: '' }],
  ['a malformed --poll-interval', { wait: 'PT8M', pollInterval: 'soon' }],
  ['a --poll-interval without --wait', { pollInterval: 'PT2M' }],
  ['--now combined with --wait', { wait: 'PT1M', now: '2026-10-16T00:00:00Z' }],
];

for (const [name, flags] of BAD_WAIT_FLAGS) {
  test(`resolveWaitFlags: ${name} is a usage error`, () => {
    const resolved = resolveWaitFlags({ ...noWaitFlags, ...flags });
    assert.equal(typeof resolved.error, 'string');
    assert.notEqual(resolved.error, '');
  });
}

for (const [name, flags] of BAD_WAIT_FLAGS) {
  const argv = ['--pr', '1', '--owner', 'o', '--repo', 'r'];
  const optional: [string, string | null | undefined][] = [
    ['--wait', flags.wait],
    ['--poll-interval', flags.pollInterval],
    ['--now', flags.now],
  ];
  for (const [flag, value] of optional) {
    if (typeof value === 'string') argv.push(flag, value);
  }
  test(`bin/idd-advisory-wait-state.mjs: ${name} classifies as a usage error before any gh call`, () => {
    const { result, ghCalls } = withAdvisoryWaitGhStub(
      { failHeadFrom: 99, commentNodes: [] },
      (cwd) => ({
        result: spawnHelperBinWithEnvelope(
          'idd-advisory-wait-state.mjs',
          argv,
          { cwd },
        ),
        ghCalls: existsSync(join(cwd, 'calls'))
          ? readFileSync(join(cwd, 'calls'), 'utf8')
          : '',
      }),
    );
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.equal(result.stdout, '');
    assert.equal(result.envelope?.kind, 'usage', JSON.stringify(result));
    assert.equal(result.envelope?.exitCode, 1);
    assert.equal(ghCalls, '', 'a usage error must not reach gh');
  });
}

// --- #4378: --wait through the real binary -----------------------------------
// The stubbed `gh` serves a fresh same-head request marker, so every read
// reports WAIT. With --wait PT1S the default interval (two minutes) collapses
// to --wait, so these tests sleep one real second.

function freshWaitComments(): unknown[] {
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return [
    {
      id: 'IC_1',
      databaseId: 1,
      body: renderAdvisoryWaitMarker({
        agentId: 'agent',
        headSha: CLI_HEAD_SHA,
        timestamp: at,
      }),
      createdAt: at,
      updatedAt: at,
      lastEditedAt: null,
      author: { login: 'viewer', __typename: 'User' },
    },
  ];
}

test('bin/idd-advisory-wait-state.mjs: --wait PT1S polls once more and ends bound-elapsed while the state stays WAIT', () => {
  const result = withAdvisoryWaitGhStub(
    { failHeadFrom: 99, commentNodes: freshWaitComments() },
    (cwd) =>
      spawnHelperBinWithEnvelope(
        'idd-advisory-wait-state.mjs',
        [...CLI_ARGS, '--wait', 'PT1S'],
        { cwd },
      ),
  );
  assert.equal(result.status, 0, JSON.stringify(result));
  const printed = JSON.parse(result.stdout) as AdvisoryWaitStateReport;
  assert.equal(printed.outcome, 'WAIT');
  assert.equal(printed.waitEnded, 'bound-elapsed');
  assert.ok((printed.waitedSeconds ?? 0) >= 1, JSON.stringify(printed));
  assert.deepEqual(validate(printed, advisoryWaitStateSchema), []);
});

test('bin/idd-advisory-wait-state.mjs: a failing second read ends with the same status and error envelope as a failing run without --wait', () => {
  const control = withAdvisoryWaitGhStub(
    { failHeadFrom: 1, commentNodes: freshWaitComments() },
    (cwd) =>
      spawnHelperBinWithEnvelope('idd-advisory-wait-state.mjs', [...CLI_ARGS], {
        cwd,
      }),
  );
  assert.notEqual(control.status, 0, JSON.stringify(control));
  assert.equal(control.stdout, '');
  assert.ok(control.envelope, JSON.stringify(control));

  // The second read only runs when the first one finishes inside the bound.
  // On a host so slow that the first read alone outlasts PT1S the run ends
  // bound-elapsed instead, so retry with a longer bound before failing.
  let waited = control;
  let headReads = '';
  for (const bound of ['PT1S', 'PT2S', 'PT4S']) {
    ({ result: waited, headReads } = withAdvisoryWaitGhStub(
      { failHeadFrom: 2, commentNodes: freshWaitComments() },
      (cwd) => ({
        result: spawnHelperBinWithEnvelope(
          'idd-advisory-wait-state.mjs',
          [...CLI_ARGS, '--wait', bound],
          { cwd },
        ),
        headReads: readFileSync(join(cwd, 'head-calls'), 'utf8'),
      }),
    ));
    if (waited.status !== 0) break;
  }
  assert.equal(waited.status, control.status, JSON.stringify(waited));
  assert.equal(waited.stdout, '', 'nothing is printed when a poll fails');
  assert.deepEqual(waited.envelope, control.envelope);
  // One served head read, then the failing one: the failure is the second read.
  assert.equal(headReads, '2');
});

// --- #4378: the instruction sentence and the helper reference ----------------

const ADVISORY_WAIT_DOC_COPIES = [
  STANDARD_ADVISORY_WAIT_DOC,
  '.github/instructions/idd-advisory-wait.instructions.md',
] as const;
const CALLER_MAPPING_END = '<!-- dprint-ignore-end -->';
const WAIT_ROW =
  "| `WAIT` | wait for Copilot's review; rerun `idd-advisory-convergence`; resume D4 | continue polling | poll then restart F2 from top | do not merge; return to F2 |";

for (const path of ADVISORY_WAIT_DOC_COPIES) {
  test(`${path}: the --wait sentence follows the caller-mapping table and the WAIT row is unchanged`, () => {
    const doc = readFileSync(join(REPO_ROOT, path), 'utf8');
    assert.equal(doc.split(WAIT_ROW).length - 1, 1, 'the WAIT row changed');
    const heading = doc.indexOf('### Caller mapping');
    assert.notEqual(heading, -1);
    const tableEnd = doc.indexOf(CALLER_MAPPING_END, heading);
    assert.notEqual(tableEnd, -1);
    assert.ok(
      tableEnd > doc.indexOf(WAIT_ROW),
      'the sentence is not in the table',
    );
    // The first paragraph after the table, with dprint's line wrapping undone.
    const paragraph = doc
      .slice(tableEnd + CALLER_MAPPING_END.length)
      .trim()
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ');
    assert.ok(
      Buffer.byteLength(paragraph) <= 300,
      `${Buffer.byteLength(paragraph)} bytes: ${paragraph}`,
    );
    for (const needle of [
      '`--wait <duration>`',
      '`bound-elapsed`',
      'timeout',
    ]) {
      assert.ok(paragraph.includes(needle), `missing ${needle}: ${paragraph}`);
    }
  });
}

test('the helper reference documents --wait, --poll-interval, waitedSeconds and waitEnded', () => {
  const doc = readFileSync(join(REPO_ROOT, HELPER_REFERENCE_DOC), 'utf8');
  for (const needle of [
    '`--wait <duration>`',
    '`--poll-interval <duration>`',
    '`waitedSeconds`',
    '`waitEnded`',
    '`head-changed`',
    '`bound-elapsed`',
  ]) {
    assert.ok(doc.includes(needle), `missing ${needle}`);
  }
});
