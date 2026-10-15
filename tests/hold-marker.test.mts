import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  detectMalformedOperationalMarker,
  IDD_AGENT_DERIVED_MARKERS,
  MARKER_HIDE_POLICY,
  operationalMarkerPrefix,
  operationalMarkerPrefixByStart,
  parseHoldMarker,
  renderClaimedByMarker,
  renderHoldMarker,
  renderUnclaimedByMarker,
  resolveActiveClaim,
  resolveActiveClaimWithForcedHandoffTrace,
  resolveTrustedHoldMarkers,
} from '../src/scripts/protocol-helpers.mts';

// kurone-kito/idd-skill#4310: the `<!-- idd-hold: ... -->` marker a delegated
// worker posts when it stops at a hold (docs/idd-workflow.md, "Hold marker").

const AGENT = 'claude-23c12b20';
const CLAIM = 'ecc3a888-5391-4a13-85b3-5c909b7fbcbb';
const OWNER = 'kurone-kito';
const TS = '2026-10-15T03:00:00Z';
const TRUSTED = [OWNER];

function holdBody(agentId = AGENT, claimId = CLAIM, timestamp = TS): string {
  return renderHoldMarker({ agentId, claimId, timestamp });
}

function claimBody(timestamp: string): string {
  return renderClaimedByMarker({
    agentId: AGENT,
    claimId: CLAIM,
    supersedes: 'none',
    timestamp,
    branch: 'issue/4310-feat-markers-add-idd-hold-marker-type',
  });
}

function comment(
  id: number,
  body: string,
  createdAt: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    author: { login: OWNER },
    body,
    createdAt,
    lastEditedAt: null,
    ...extra,
  };
}

const RESOLVE_DEFAULTS = {
  agentId: AGENT,
  claimId: CLAIM,
  claimActorLogin: OWNER,
  trustedMarkerLogins: TRUSTED,
};

test('renderHoldMarker renders the exact body with the token as the first bytes', () => {
  const body = holdBody();
  assert.equal(
    body,
    `<!-- idd-hold: ${AGENT} ${CLAIM} ${TS} -->\n\n` +
      `_${AGENT}: issue hold — IDD automation marker. Do not edit._`,
  );
  assert.ok(body.startsWith('<!-- idd-hold: '));
});

test('renderHoldMarker names the missing or invalid field', () => {
  assert.throws(
    () => renderHoldMarker({ claimId: CLAIM, timestamp: TS }),
    /invalid idd-hold marker payload: missing "agentId"/,
  );
  assert.throws(
    () => renderHoldMarker({ agentId: AGENT, timestamp: TS }),
    /invalid idd-hold marker payload: missing "claimId"/,
  );
  assert.throws(
    () => renderHoldMarker({ agentId: AGENT, claimId: CLAIM }),
    /invalid idd-hold marker payload: missing "timestamp"/,
  );
  assert.throws(
    () =>
      renderHoldMarker({ agentId: AGENT, claimId: CLAIM, timestamp: 'later' }),
    /invalid idd-hold marker payload: invalid "timestamp"/,
  );
  // A token that could break the HTML comment is refused, not rendered.
  assert.throws(
    () =>
      renderHoldMarker({ agentId: 'a --> b', claimId: CLAIM, timestamp: TS }),
    /invalid idd-hold marker payload/,
  );
});

test('parseHoldMarker round-trips the rendered body and keeps created_at apart from the embedded timestamp', () => {
  const createdAt = '2026-10-15T03:00:09Z';
  assert.deepEqual(parseHoldMarker(holdBody(), createdAt), {
    agentId: AGENT,
    claimId: CLAIM,
    timestamp: TS,
    createdAt,
  });
  // A bare token with no visible note is also a valid marker.
  assert.ok(
    parseHoldMarker(`<!-- idd-hold: ${AGENT} ${CLAIM} ${TS} -->`, createdAt),
  );
  // An unusable created_at is kept out of the ordering clock, not guessed.
  assert.equal(parseHoldMarker(holdBody(), 'yesterday')?.createdAt, 'none');
});

test('parseHoldMarker rejects anything that is not the literal first-bytes marker', () => {
  const createdAt = TS;
  for (const body of [
    '',
    'not a marker',
    // The token must be the first bytes: a preamble defeats it.
    `quoted: ${holdBody()}`,
    ` ${holdBody()}`,
    // Missing or invalid fields.
    `<!-- idd-hold: ${AGENT} ${CLAIM} -->`,
    `<!-- idd-hold: ${AGENT} ${CLAIM} 2026-13-45T99:00:00Z -->`,
    `<!-- idd-hold: ${AGENT} ${CLAIM} ${TS} extra -->`,
    // Content after the marker other than one IDD note line.
    `${holdBody()}\n\nand some more text`,
    // An identifier that closes the HTML comment early, which the renderer
    // also refuses, so a hand-built body cannot parse as a hold marker.
    `<!-- idd-hold: actor--> ${CLAIM} ${TS} -->`,
    `<!-- idd-hold: ${AGENT} <!--claim ${TS} -->`,
    // Another marker family.
    renderUnclaimedByMarker({ agentId: AGENT, claimId: CLAIM, timestamp: TS }),
    claimBody(TS),
  ]) {
    assert.equal(parseHoldMarker(body, createdAt), null, JSON.stringify(body));
  }
});

test('the hold marker is a recognized operational marker that is kept visible', () => {
  const body = holdBody();
  assert.equal(operationalMarkerPrefix(body), '<!-- idd-hold:');
  assert.equal(operationalMarkerPrefixByStart(body), '<!-- idd-hold:');
  assert.equal(detectMalformedOperationalMarker(body), null);
  // A valid token followed by anything but one IDD note is flagged as
  // malformed; a body whose fields are broken is not marker-shaped at all.
  assert.equal(
    detectMalformedOperationalMarker(`<!-- idd-hold: ${AGENT} ${CLAIM} -->`),
    null,
  );
  assert.equal(
    detectMalformedOperationalMarker(`${holdBody()}\n\nand some more text`),
    '<!-- idd-hold:',
  );
  assert.equal(MARKER_HIDE_POLICY.get('<!-- idd-hold:')?.policy, 'excluded');
  // A worker posts it as itself, like activation-nonce, so its author is an
  // IDD agent login.
  assert.ok(IDD_AGENT_DERIVED_MARKERS.has('<!-- idd-hold:'));
});

test('resolveTrustedHoldMarkers returns the newest trusted marker for the claim, with the whole ordered run', () => {
  const first = comment(11, holdBody(), '2026-10-15T03:00:00Z');
  const second = comment(
    12,
    holdBody(AGENT, CLAIM, '2026-10-15T03:30:00Z'),
    '2026-10-15T03:30:01Z',
  );
  const third = comment(
    13,
    holdBody(AGENT, CLAIM, '2026-10-15T04:00:00Z'),
    '2026-10-15T04:00:02Z',
  );
  // Input order does not matter: the result is oldest first by created_at.
  const run = resolveTrustedHoldMarkers({
    ...RESOLVE_DEFAULTS,
    comments: [third, first, second],
  });
  assert.ok(run);
  assert.deepEqual(
    run.markers.map((marker) => marker.createdAt),
    ['2026-10-15T03:00:00Z', '2026-10-15T03:30:01Z', '2026-10-15T04:00:02Z'],
  );
  assert.equal(run.first.createdAt, '2026-10-15T03:00:00Z');
  assert.equal(run.newest.createdAt, '2026-10-15T04:00:02Z');
  assert.equal(run.newest.claimId, CLAIM);
});

test('resolveTrustedHoldMarkers orders by created_at, never by the embedded timestamp', () => {
  // The poster's own clock is skewed: the newer comment embeds an older time.
  const earlier = comment(
    21,
    holdBody(AGENT, CLAIM, '2026-10-15T09:00:00Z'),
    '2026-10-15T03:00:00Z',
  );
  const later = comment(
    22,
    holdBody(AGENT, CLAIM, '2026-10-15T01:00:00Z'),
    '2026-10-15T04:00:00Z',
  );
  const run = resolveTrustedHoldMarkers({
    ...RESOLVE_DEFAULTS,
    comments: [earlier, later],
  });
  assert.equal(run?.first.createdAt, '2026-10-15T03:00:00Z');
  assert.equal(run?.newest.createdAt, '2026-10-15T04:00:00Z');
  assert.equal(run?.newest.timestamp, '2026-10-15T01:00:00Z');
});

test('resolveTrustedHoldMarkers breaks a same-second tie by comment id, then input order', () => {
  // Same created_at second; the embedded timestamps only label which is which.
  const lowId = comment(30, holdBody(AGENT, CLAIM, '2026-10-15T03:00:00Z'), TS);
  const highId = comment(
    31,
    holdBody(AGENT, CLAIM, '2026-10-15T03:00:01Z'),
    TS,
  );
  const byId = resolveTrustedHoldMarkers({
    ...RESOLVE_DEFAULTS,
    comments: [highId, lowId],
  });
  assert.deepEqual(
    byId?.markers.map((marker) => marker.timestamp),
    ['2026-10-15T03:00:00Z', '2026-10-15T03:00:01Z'],
  );
  // GraphQL node ids carry no order, so the input order decides.
  const nodeA = comment(0, holdBody(AGENT, CLAIM, '2026-10-15T03:00:00Z'), TS, {
    id: 'IC_a',
  });
  const nodeB = comment(0, holdBody(AGENT, CLAIM, '2026-10-15T03:00:01Z'), TS, {
    id: 'IC_b',
  });
  const byInput = resolveTrustedHoldMarkers({
    ...RESOLVE_DEFAULTS,
    comments: [nodeB, nodeA],
  });
  assert.deepEqual(
    byInput?.markers.map((marker) => marker.timestamp),
    ['2026-10-15T03:00:01Z', '2026-10-15T03:00:00Z'],
  );
});

test('resolveTrustedHoldMarkers ignores a marker from an untrusted actor', () => {
  const trusted = comment(41, holdBody(), '2026-10-15T03:00:00Z');
  const untrustedNewer = comment(
    42,
    holdBody(AGENT, CLAIM, '2026-10-15T05:00:00Z'),
    '2026-10-15T05:00:00Z',
    { author: { login: 'mallory' } },
  );
  const run = resolveTrustedHoldMarkers({
    ...RESOLVE_DEFAULTS,
    comments: [trusted, untrustedNewer],
  });
  assert.equal(run?.markers.length, 1);
  assert.equal(run?.newest.createdAt, '2026-10-15T03:00:00Z');
  // With only the untrusted marker there is no hold at all.
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      comments: [untrustedNewer],
    }),
    null,
  );
});

test('resolveTrustedHoldMarkers decides trust by the author login, not by the marker text', () => {
  // The marker names the right agent and claim, but a different account
  // posted it. The ids alone are public, so the text proves nothing.
  const spoofed = comment(51, holdBody(), TS, {
    author: { login: 'someone-else' },
  });
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      trustedMarkerLogins: [OWNER, 'someone-else'],
      comments: [spoofed],
    }),
    null,
    'a trusted login other than the one that posted the claim is not enough',
  );
  // The claim actor and trusted logins compare case-insensitively.
  const mixedCase = comment(52, holdBody(), TS, {
    author: { login: 'Kurone-Kito' },
  });
  assert.ok(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      claimActorLogin: ' KURONE-kito ',
      comments: [mixedCase],
    }),
  );
  // A flat authorLogin and the REST `user` shape resolve the same way.
  assert.ok(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      comments: [
        {
          id: 53,
          body: holdBody(),
          created_at: TS,
          last_edited_at: null,
          user: { login: OWNER },
        },
      ],
    }),
  );
  assert.ok(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      comments: [
        {
          id: 54,
          body: holdBody(),
          createdAt: TS,
          lastEditedAt: null,
          authorLogin: OWNER,
        },
      ],
    }),
  );
  // No known claim actor, or no trusted logins, means nothing is trusted.
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      claimActorLogin: '',
      comments: [comment(55, holdBody(), TS)],
    }),
    null,
  );
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      trustedMarkerLogins: [],
      comments: [comment(56, holdBody(), TS)],
    }),
    null,
  );
});

test('resolveTrustedHoldMarkers ignores an edited marker and one with an unresolved edit state, without throwing', () => {
  const edited = comment(61, holdBody(), TS, {
    lastEditedAt: '2026-10-15T03:05:00Z',
  });
  const unresolved = comment(62, holdBody(), TS, { lastEditedAt: undefined });
  const missingField = {
    id: 63,
    author: { login: OWNER },
    body: holdBody(),
    createdAt: TS,
  };
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      comments: [edited, unresolved, missingField],
    }),
    null,
  );
});

test('resolveTrustedHoldMarkers ignores a hand-built marker whose identifier closes the HTML comment early', () => {
  // The same claim and agent as the real one, spelled so the token ends the
  // comment: it must not count as a hold for that claim.
  const early = comment(
    78,
    `<!-- idd-hold: ${AGENT}--> ${CLAIM} ${TS} -->`,
    TS,
  );
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      agentId: `${AGENT}-->`,
      comments: [early],
    }),
    null,
  );
});

test('resolveTrustedHoldMarkers ignores a marker for another claim or agent, a quoted marker, and unusable created_at', () => {
  const otherClaim = comment(
    71,
    holdBody(AGENT, 'a-different-claim-id', TS),
    TS,
  );
  const otherAgent = comment(72, holdBody('codex-cli', CLAIM, TS), TS);
  const quoted = comment(73, `> ${holdBody()}`, TS);
  const preamble = comment(74, `Holding.\n\n${holdBody()}`, TS);
  const noClock = comment(75, holdBody(), 'not-a-timestamp');
  const plain = comment(76, 'a plain human comment', TS);
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      comments: [otherClaim, otherAgent, quoted, preamble, noClock, plain],
    }),
    null,
  );
  assert.equal(
    resolveTrustedHoldMarkers({ ...RESOLVE_DEFAULTS, comments: null }),
    null,
  );
  assert.equal(
    resolveTrustedHoldMarkers({
      ...RESOLVE_DEFAULTS,
      agentId: '',
      comments: [comment(77, holdBody(), TS)],
    }),
    null,
  );
});

// --- A hold marker never changes who owns a claim ---------------------------

const CLAIM_AT = '2026-10-15T02:50:24Z';
const HOLD_AT = '2026-10-15T03:00:00Z';

function claimEvent() {
  return comment(1, claimBody(CLAIM_AT), CLAIM_AT);
}

test('a hold marker alone does not start a claim', () => {
  const hold = comment(2, holdBody(), HOLD_AT);
  assert.equal(resolveActiveClaim([hold]), null);
  assert.equal(
    resolveActiveClaim([hold], () => true),
    null,
  );
  const traced = resolveActiveClaimWithForcedHandoffTrace([hold]);
  assert.equal(traced.activeClaim, null);
  assert.equal(traced.releasedClaim, null);
});

test('a hold marker does not end, refresh, or move an active claim', () => {
  const baseline = resolveActiveClaimWithForcedHandoffTrace([claimEvent()]);
  assert.equal(baseline.activeClaim?.claimId, CLAIM);

  const withHold = resolveActiveClaimWithForcedHandoffTrace([
    claimEvent(),
    comment(2, holdBody(), HOLD_AT),
  ]);
  // Same claim, and the claim's own clock is not refreshed the way a
  // heartbeat would refresh it.
  assert.deepEqual(withHold, baseline);
  assert.equal(withHold.activeClaim?.createdAt, CLAIM_AT);
  assert.equal(withHold.activeSince, CLAIM_AT);

  // A marker naming another claim or agent does not displace it either.
  const withStranger = resolveActiveClaim([
    claimEvent(),
    comment(3, holdBody('codex-cli', 'another-claim', HOLD_AT), HOLD_AT),
  ]);
  assert.equal(withStranger?.claimId, CLAIM);
});

test('a hold marker does not revive a released claim', () => {
  const released = comment(
    2,
    renderUnclaimedByMarker({
      agentId: AGENT,
      claimId: CLAIM,
      timestamp: '2026-10-15T02:55:00Z',
    }),
    '2026-10-15T02:55:00Z',
  );
  const events = [claimEvent(), released, comment(3, holdBody(), HOLD_AT)];
  const traced = resolveActiveClaimWithForcedHandoffTrace(events);
  assert.equal(traced.activeClaim, null);
  assert.equal(traced.releasedClaim?.claimId, CLAIM);
});

test('claim resolution ignores a hold marker whose edit state is unresolved instead of throwing', () => {
  // Claim-family markers fail loudly on an unresolved edit state. The hold
  // marker is not in that family, so it neither throws nor affects the claim.
  const unresolved = {
    id: 2,
    author: { login: OWNER },
    body: holdBody(),
    createdAt: HOLD_AT,
  };
  assert.equal(resolveActiveClaim([claimEvent(), unresolved])?.claimId, CLAIM);
});
