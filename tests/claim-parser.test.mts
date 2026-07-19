import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyClaimEvent,
  DEFAULT_STALE_AGE_MS,
  detectMalformedOperationalMarker,
  isStaleAt,
  isStaleByAge,
  operationalMarkerPrefix,
  parseActivationNonceComment,
  parseClaimComment,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from '../src/scripts/protocol-helpers.mts';
import { readText } from './test-utils.mts';

const fixtures = {
  active: readText('fixtures/issue-comments/active-claim.md'),
  heartbeat: readText('fixtures/issue-comments/heartbeat.md'),
  stale: readText('fixtures/issue-comments/stale-claim.md'),
  superseded: readText('fixtures/issue-comments/superseded-claim.md'),
  release: readText('fixtures/issue-comments/release.md'),
  staleRelease: readText('fixtures/issue-comments/release-stale.md'),
};

test('parses active, stale, and superseded claim comments', () => {
  const active = parseClaimComment(fixtures.active, '2026-05-09T10:00:00Z');
  const stale = parseClaimComment(fixtures.stale, '2026-05-10T11:00:00Z');
  const superseded = parseClaimComment(
    fixtures.superseded,
    '2026-05-09T12:00:00Z',
  );

  assert.deepEqual(active, {
    agentId: 'codex-cli',
    claimId: '11111111111111111111111111111111',
    supersedes: 'none',
    branch: 'issue/118-protocol-test-fixtures',
    createdAt: '2026-05-09T10:00:00Z',
  });
  assert.deepEqual(stale, {
    agentId: 'codex-cli',
    claimId: '22222222222222222222222222222222',
    supersedes: '11111111111111111111111111111111',
    branch: 'issue/118-protocol-test-fixtures',
    createdAt: '2026-05-10T11:00:00Z',
  });
  assert.deepEqual(superseded, {
    agentId: 'codex-cli',
    claimId: '33333333333333333333333333333333',
    supersedes: '11111111111111111111111111111111',
    branch: 'issue/118-protocol-test-fixtures',
    createdAt: '2026-05-09T12:00:00Z',
  });
});

test('parses the release comment and stale threshold', () => {
  const release = parseReleaseComment(fixtures.release);
  assert.deepEqual(release, {
    agentId: 'codex-cli',
    claimId: '11111111111111111111111111111111',
  });
  assert.equal(isStaleAt('2026-05-09T10:00:00Z', '2026-05-10T11:00:00Z'), true);
  assert.equal(
    isStaleAt('2026-05-09T10:00:00Z', '2026-05-09T23:59:59Z'),
    false,
  );
});

test('isStaleByAge honors a configured staleAge in the 18-24h gap', () => {
  // ~20h gap: not stale under the old hardcoded 24h constant, but stale
  // under a configured 18h staleAge (the write-gate bug in #1310).
  const activeCreatedAt = '2026-05-09T10:00:00Z';
  const nextCreatedAt = '2026-05-10T06:00:00Z';
  const eighteenHoursMs = 18 * 60 * 60 * 1000;

  assert.equal(
    isStaleByAge(activeCreatedAt, nextCreatedAt, DEFAULT_STALE_AGE_MS),
    false,
  );
  assert.equal(
    isStaleByAge(activeCreatedAt, nextCreatedAt, eighteenHoursMs),
    true,
  );
});

test('isStaleByAge at the configured boundary is inclusive, matching isStaleAt', () => {
  const eighteenHoursMs = 18 * 60 * 60 * 1000;
  assert.equal(
    isStaleByAge(
      '2026-05-09T10:00:00Z',
      '2026-05-10T04:00:00Z',
      eighteenHoursMs,
    ),
    true, // exactly 18h
  );
  assert.equal(
    isStaleByAge(
      '2026-05-09T10:00:00Z',
      '2026-05-10T03:59:59Z',
      eighteenHoursMs,
    ),
    false, // 1s under 18h
  );
});

test('isStaleByAge delegates to isStaleAt at the default 24h window', () => {
  // Same fast path resume-claim-routing.mts relied on: staleAgeMs equal to
  // the default must produce byte-identical results to isStaleAt.
  const cases: [string, string][] = [
    ['2026-05-09T10:00:00Z', '2026-05-10T11:00:00Z'],
    ['2026-05-09T10:00:00Z', '2026-05-09T23:59:59Z'],
  ];
  for (const [activeCreatedAt, nextCreatedAt] of cases) {
    assert.equal(
      isStaleByAge(activeCreatedAt, nextCreatedAt, DEFAULT_STALE_AGE_MS),
      isStaleAt(activeCreatedAt, nextCreatedAt),
    );
  }
});

test('isStaleByAge fails closed on unparseable timestamps', () => {
  assert.equal(
    isStaleByAge('not-a-date', '2026-05-10T06:00:00Z', 18 * 60 * 60 * 1000),
    false,
  );
  assert.equal(
    isStaleByAge('2026-05-09T10:00:00Z', 'not-a-date', 18 * 60 * 60 * 1000),
    false,
  );
});

test('applies claim transitions across heartbeat, takeover, and release', () => {
  const active = parseClaimComment(fixtures.active, '2026-05-09T10:00:00Z');
  const heartbeat = applyClaimEvent(active, {
    body: fixtures.heartbeat,
    createdAt: '2026-05-09T11:00:00Z',
  });
  const ignored = applyClaimEvent(heartbeat, {
    body: fixtures.superseded,
    createdAt: '2026-05-09T12:00:00Z',
  });
  const stale = applyClaimEvent(ignored, {
    body: fixtures.stale,
    createdAt: '2026-05-10T11:00:00Z',
  });
  const ignoredRelease = applyClaimEvent(stale, {
    body: fixtures.release,
    createdAt: '2026-05-10T12:00:00Z',
  });
  const released = applyClaimEvent(stale, {
    body: fixtures.staleRelease,
    createdAt: '2026-05-10T12:30:00Z',
  });

  assert.deepEqual(heartbeat, {
    agentId: 'codex-cli',
    claimId: '11111111111111111111111111111111',
    supersedes: 'none',
    branch: 'issue/118-protocol-test-fixtures',
    createdAt: '2026-05-09T11:00:00Z',
  });
  assert.deepEqual(ignored, heartbeat);
  assert.deepEqual(stale, {
    agentId: 'codex-cli',
    claimId: '22222222222222222222222222222222',
    supersedes: '11111111111111111111111111111111',
    branch: 'issue/118-protocol-test-fixtures',
    createdAt: '2026-05-10T11:00:00Z',
  });
  assert.deepEqual(ignoredRelease, stale);
  assert.equal(released, null);
});

test("matching-branch heartbeat refreshes the active claim's createdAt", () => {
  const active = parseClaimComment(
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
    '2026-05-23T10:00:00Z',
  );
  const after = applyClaimEvent(active, {
    body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T13:00:00Z branch: issue/100-task -->',
    createdAt: '2026-05-23T13:00:00Z',
  });
  assert.equal(after?.createdAt, '2026-05-23T13:00:00Z');
  assert.equal(after?.branch, 'issue/100-task');
  assert.equal(after?.claimId, 'claim-A');
});

test('branch-mismatched heartbeat is anomalous and does not refresh the stale clock', () => {
  // idd-claim.instructions.md rule 3.5: heartbeat whose {branch} does
  // not match the active claim's branch is anomalous and must not
  // refresh the stale clock. Without this guard, a spurious heartbeat
  // could extend the stale clock indefinitely and block stale-takeover
  // recovery.
  const active = parseClaimComment(
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
    '2026-05-23T10:00:00Z',
  );
  const after = applyClaimEvent(active, {
    body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-24T11:00:00Z branch: issue/999-WRONG -->',
    createdAt: '2026-05-24T11:00:00Z',
  });
  // createdAt unchanged: still 10:00, not 11:00 (which would be ~25 h
  // newer and would have masked staleness).
  assert.equal(after?.createdAt, '2026-05-23T10:00:00Z');
  assert.equal(after?.branch, 'issue/100-task');
});

test('onAnomalousHeartbeat callback receives the anomalous heartbeat metadata', () => {
  const active = parseClaimComment(
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
    '2026-05-23T10:00:00Z',
  );
  const seen: unknown[] = [];
  applyClaimEvent(
    active,
    {
      body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-24T11:00:00Z branch: issue/999-WRONG -->',
      createdAt: '2026-05-24T11:00:00Z',
    },
    {
      onAnomalousHeartbeat: (info) => seen.push(info),
    },
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], {
    agentId: 'copilot',
    claimId: 'claim-A',
    activeBranch: 'issue/100-task',
    heartbeatBranch: 'issue/999-WRONG',
    createdAt: '2026-05-24T11:00:00Z',
  });
});

test('matching heartbeat does not invoke the onAnomalousHeartbeat callback', () => {
  const active = parseClaimComment(
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
    '2026-05-23T10:00:00Z',
  );
  const seen: unknown[] = [];
  applyClaimEvent(
    active,
    {
      body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T13:00:00Z branch: issue/100-task -->',
      createdAt: '2026-05-23T13:00:00Z',
    },
    {
      onAnomalousHeartbeat: (info) => seen.push(info),
    },
  );
  assert.equal(seen.length, 0);
});

// #1316: a marker comment whose body starts with a correct token + note but
// has extra content appended after the note must not be silently dropped as
// indistinguishable "other" content -- it should be surfaced as a distinct
// malformed-marker signal, while the security-critical parse functions
// keep failing closed (still `null`, exactly as before this issue).
test('claimed-by with appended prose stays null in parseClaimComment but is flagged malformed', () => {
  const body =
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->\n\n' +
    '_copilot: issue claim — IDD automation marker. Do not edit._\n\n' +
    'Note: superseding the prior claim because the original session stalled.';
  assert.equal(parseClaimComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(detectMalformedOperationalMarker(body), '<!-- claimed-by:');
});

test('unclaimed-by with appended prose stays null in parseReleaseComment but is flagged malformed', () => {
  const body =
    '<!-- unclaimed-by: copilot claim-A 2026-05-23T10:00:00Z -->\n\n' +
    '_copilot: issue claim released — IDD automation marker. Do not edit._\n\n' +
    'Releasing early: blocked on a decision from the maintainer.';
  assert.equal(parseReleaseComment(body), null);
  assert.equal(detectMalformedOperationalMarker(body), '<!-- unclaimed-by:');
});

test('activation-nonce with appended prose stays null in parseActivationNonceComment but is flagged malformed', () => {
  const body =
    '<!-- activation-nonce: copilot claim-A nonce-1 2026-05-23T10:00:00Z -->\n\n' +
    '_copilot: claim activation nonce — IDD automation marker. Do not edit._\n\n' +
    'Posted at activation time alongside the fresh claim.';
  assert.equal(parseActivationNonceComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(
    detectMalformedOperationalMarker(body),
    '<!-- activation-nonce:',
  );
});

test('a well-formed activation-nonce marker is not flagged malformed (no regression to the happy path)', () => {
  const body =
    '<!-- activation-nonce: copilot claim-A nonce-1 2026-05-23T10:00:00Z -->\n\n' +
    '_copilot: claim activation nonce — IDD automation marker. Do not edit._';
  assert.notEqual(
    parseActivationNonceComment(body, '2026-05-23T10:00:00Z'),
    null,
  );
  assert.equal(detectMalformedOperationalMarker(body), null);
});

test('review-watermark with appended prose stays null in parseReviewWatermarkComment but is flagged malformed', () => {
  const sha = 'a'.repeat(40);
  const body =
    `<!-- review-watermark: copilot claim-A ${sha} none 0 none -->\n\n` +
    '_copilot: review triage snapshot — IDD automation marker. Do not edit._\n\n' +
    'No CI has run yet, so both freshness fields are none for now.';
  assert.equal(parseReviewWatermarkComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(
    detectMalformedOperationalMarker(body),
    '<!-- review-watermark:',
  );
});

test('review-baseline with appended prose is flagged malformed', () => {
  const sha = 'b'.repeat(40);
  const body =
    `<!-- review-baseline: copilot claim-A ${sha} -->\n\n` +
    '_copilot: critique baseline — IDD automation marker. Do not edit._\n\n' +
    'This baseline covers the E2 pass that started after the last rebase.';
  assert.equal(operationalMarkerPrefix(body), null);
  assert.equal(detectMalformedOperationalMarker(body), '<!-- review-baseline:');
});

test('a well-formed review-baseline marker is not flagged malformed (no regression to the happy path)', () => {
  const sha = 'b'.repeat(40);
  const body =
    `<!-- review-baseline: copilot claim-A ${sha} -->\n\n` +
    '_copilot: critique baseline — IDD automation marker. Do not edit._';
  assert.equal(operationalMarkerPrefix(body), '<!-- review-baseline:');
  assert.equal(detectMalformedOperationalMarker(body), null);
});

test('a well-formed claimed-by marker is not flagged malformed (no regression to the happy path)', () => {
  const body =
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->\n\n' +
    '_copilot: issue claim — IDD automation marker. Do not edit._';
  assert.notEqual(parseClaimComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(detectMalformedOperationalMarker(body), null);
});

test('a marker quoted mid-prose is neither a live marker nor flagged malformed (anti-spoofing)', () => {
  const body =
    'For reference, a claim comment looks like this:\n' +
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->\n\n' +
    '_copilot: issue claim — IDD automation marker. Do not edit._';
  assert.equal(parseClaimComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(detectMalformedOperationalMarker(body), null);
});

test('a code-fenced marker is neither a live marker nor flagged malformed (anti-spoofing)', () => {
  const body =
    '```\n<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->\n```';
  assert.equal(parseClaimComment(body, '2026-05-23T10:00:00Z'), null);
  assert.equal(detectMalformedOperationalMarker(body), null);
});
