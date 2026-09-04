import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildForcedHandoffEnabledGate,
  evaluateFreshClaimGate,
  evaluateResumeClaimRouting,
} from '../src/scripts/resume-claim-routing.mts';
import { stubExecutable } from './test-utils.mts';

function trusted(logins: string[]) {
  const set = new Set(logins);
  return (login: string) => set.has(login);
}

test('returns unclaimed when no trusted markers exist', () => {
  const result = evaluateResumeClaimRouting(
    { events: [], now: '2026-05-12T10:00:00Z' },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.action, 're_claim');
  assert.equal(result.reason, 'legacy-absent');
  assert.equal(result.active_claim, null);
  assert.equal(result.evidence.legacy_claim_seen, false);
});

test('returns already_owned when active claim id matches --claim-id', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.legacy_claim_seen, false);
});

test('legacy_claim_seen is true when history has both marker formats, even though new-format wins routing', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-def',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/9-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-def supersedes: none 2026-05-12T09:00:00Z branch: issue/9-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.evidence.new_format_claim_seen, true);
  assert.equal(result.evidence.legacy_claim_seen, true);
});

test('activation-nonce: matching local nonce keeps already_owned', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-mine',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:05Z',
          author: { login: 'maintainer' },
          body: '<!-- activation-nonce: copilot claim-abc nonce-mine 2026-05-12T09:00:05Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.activation_nonce_winner, 'nonce-mine');
});

test('activation-nonce: mismatched local nonce routes to disputed (second-activation collision)', () => {
  const events = [
    {
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
    },
    {
      createdAt: '2026-05-12T09:00:05Z',
      author: { login: 'maintainer' },
      body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
    },
    {
      createdAt: '2026-05-12T09:00:07Z',
      author: { login: 'maintainer' },
      body: '<!-- activation-nonce: copilot claim-abc nonce-zzz 2026-05-12T09:00:07Z -->',
    },
  ];

  // Both colliding sessions observe the identical event set and must compute
  // the identical winner ("nonce-aaa" sorts first ASCII) -- one sees itself
  // as sole owner, the other as displaced, so exactly one backs off (no
  // livelock where both, or neither, defer).
  const winnerPerspective = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-aaa',
      now: '2026-05-12T10:00:00Z',
      events,
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );
  assert.equal(winnerPerspective.state, 'already_owned');
  assert.equal(winnerPerspective.reason, 'claim-id-match');
  assert.equal(winnerPerspective.evidence.activation_nonce_winner, 'nonce-aaa');

  const loserPerspective = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-zzz',
      now: '2026-05-12T10:00:00Z',
      events,
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );
  assert.equal(loserPerspective.state, 'disputed');
  assert.equal(loserPerspective.action, 'stop');
  assert.equal(loserPerspective.reason, 'activation-nonce-mismatch');
  assert.equal(loserPerspective.evidence.activation_nonce_winner, 'nonce-aaa');
});

test('activation-nonce: no posted nonce marker skips the comparison (AC3 backward compatibility)', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-mine',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.activation_nonce_winner, null);
});

test('activation-nonce: omitting --nonce with 2+ trusted markers is a cold-recovery collision (#1529)', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:05Z',
          author: { login: 'maintainer' },
          body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
        },
        {
          createdAt: '2026-05-12T09:00:07Z',
          author: { login: 'maintainer' },
          body: '<!-- activation-nonce: copilot claim-abc nonce-zzz 2026-05-12T09:00:07Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'cold-recovery-activation-nonce-collision');
  assert.equal(result.evidence.activation_nonce_count, 2);
});

test('activation-nonce: omitting --nonce with a single marker still skips comparison', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/1-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:05Z',
          author: { login: 'maintainer' },
          body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.activation_nonce_count, 1);
});

test('returns non_inheritable for non-stale active claim from another session', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-mine',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:30:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-other supersedes: none 2026-05-12T09:30:00Z branch: issue/2-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
});

test('returns stale for stale active claim from another session', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-mine',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-other supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'active-claim-stale');
});

test('evaluateFreshClaimGate: no markers → claimable', () => {
  const gate = evaluateFreshClaimGate(
    { events: [], now: '2026-05-12T10:00:00Z' },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(gate.verdict, 'claimable');
  assert.equal(gate.winningClaimId, null);
});

test('evaluateFreshClaimGate: fresh active claim from another session → already-claimed', () => {
  const gate = evaluateFreshClaimGate(
    {
      // A stray --claim-id must be ignored: a fresh claim owns none yet, so a
      // matching id must not mask an active competitor.
      claimId: 'claim-other',
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:30:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-other supersedes: none 2026-05-12T09:30:00Z branch: issue/2-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.winningClaimId, 'claim-other');
});

test('evaluateFreshClaimGate: stale active claim → stale-reclaimable', () => {
  const gate = evaluateFreshClaimGate(
    {
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(gate.verdict, 'stale-reclaimable');
  assert.equal(gate.winningClaimId, 'claim-old');
});

test('evaluateFreshClaimGate: later competing claim → already-claimed (disputed)', () => {
  const gate = evaluateFreshClaimGate(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-first supersedes: none 2026-05-12T09:00:00Z branch: issue/4-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:30Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-second supersedes: none 2026-05-12T09:00:30Z branch: issue/4-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.reason, 'later-competing-claim');
});

test('detects same-second tie-break loss as disputed', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-z',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-z supersedes: none 2026-05-12T10:00:00Z branch: issue/4-task -->',
        },
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-a supersedes: none 2026-05-12T10:00:00Z branch: issue/4-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'same-second-claim-tie-break-loss');
  assert.equal(result.active_claim?.claim_id, 'claim-a');
});

test('ignores heartbeat with mismatched branch and records warning', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-branch',
      now: '2026-05-12T10:30:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-branch supersedes: none 2026-05-12T10:00:00Z branch: issue/5-task -->',
        },
        {
          createdAt: '2026-05-12T10:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-branch supersedes: none 2026-05-12T10:10:00Z branch: issue/5-wrong -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.branch, 'issue/5-task');
  assert.equal(result.active_claim?.created_at, '2026-05-12T10:00:00Z');
  assert.equal(result.warnings.length, 1);
});

test('returns disputed when a later competing claim appears after active claim', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/10-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/10-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.reason, 'later-competing-claim');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
});

test('legacy claim released by matching legacy unclaim returns unclaimed', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/6-task -->',
        },
        {
          createdAt: '2026-05-12T08:30:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T08:30:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.reason, 'legacy-released');
  assert.equal(result.active_claim, null);
});

test('legacy non-stale claim is non_inheritable', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/7-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'legacy-claim-non-stale');
  assert.equal(result.evidence.legacy_claim_seen, true);
});

test('legacy stale claim routes to takeover', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T09:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/8-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'legacy-claim-stale');
});

const FORCED_HANDOFF_EVENTS = [
  {
    createdAt: '2026-05-12T10:00:00Z',
    author: { login: 'maintainer' },
    body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
  },
  {
    createdAt: '2026-05-12T10:01:00Z',
    author: { login: 'maintainer' },
    body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-old","newAgentId":"copilot","newClaimId":"claim-new","branch":"issue/11-task","forcedBy":"maintainer","reason":"handoff","timestamp":"2026-05-12T10:01:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
  },
];

test('authorized forced-handoff marker promotes successor claim before routing', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
    },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('evidence.forced_handoff is populated on a bare --issue call (no --claim-id) against a valid forced-handoff successor (#2178)', () => {
  const result = evaluateResumeClaimRouting(
    {
      // claimId omitted: exercises the exact "bare --issue call" gap named
      // in #2178 -- the routing verdict stays non_inheritable/stop for
      // backward compatibility, but the new evidence field must still
      // populate so the caller can retry with --claim-id.
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
  assert.deepEqual(result.evidence.forced_handoff, {
    old_agent_id: 'copilot',
    old_claim_id: 'claim-old',
    new_agent_id: 'copilot',
    new_claim_id: 'claim-new',
    forced_by: 'maintainer',
    timestamp: '2026-05-12T10:01:00Z',
  });
});

test('evidence.forced_handoff is null when no forced-handoff marker applies', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:30:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-plain supersedes: none 2026-05-12T10:00:00Z branch: issue/12-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.evidence.forced_handoff, null);
});

test('evidence.forced_handoff stays null when a forced-handoff marker exists but is ignored (mode disabled)', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      // isForcedHandoffEnabled omitted -> defaults to () => false, so the
      // marker never transfers ownership and must not be reported as
      // applied evidence either.
      isAuthorizedForcedHandoff: () => true,
    },
  );

  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.equal(result.evidence.forced_handoff, null);
});

test('evidence.forced_handoff is not misattributed to a stale, never-applied duplicate handoff sharing the same new-claim target', () => {
  // Regression for the review finding on #2178's first draft: a naive
  // scan for "which forced-handoff marker's new* fields match the final
  // active claim" can pick a marker that was never actually applied by
  // the real reducer, when a later, correctly-applied marker happens to
  // target the identical new-claim-id (e.g. a human retries a handoff
  // after realizing their first attempt cited stale old* fields, reusing
  // the same intended successor claim-id both times).
  //
  // Timeline: fresh claim (agent-A/claim-1) -> stale takeover to
  // agent-D/claim-9 (>24h later) -> a stray forced-handoff still citing
  // the ORIGINAL agent-A/claim-1 as old* (never applied: active was
  // already agent-D/claim-9 by then) -> the real forced-handoff citing
  // agent-D/claim-9 as old*, both targeting the same agent-B/claim-2.
  const events = [
    {
      createdAt: '2026-06-01T10:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: agent-A claim-1 supersedes: none 2026-06-01T10:00:00Z branch: issue/50-task -->',
    },
    {
      createdAt: '2026-06-02T11:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: agent-D claim-9 supersedes: claim-1 2026-06-02T11:00:00Z branch: issue/50-task -->',
    },
    {
      createdAt: '2026-06-02T11:05:00Z',
      author: { login: 'maintainer' },
      body: '<!-- forced-handoff: {"oldAgentId":"agent-A","oldClaimId":"claim-1","newAgentId":"agent-B","newClaimId":"claim-2","branch":"issue/50-task","forcedBy":"maintainer","reason":"stray retry citing stale old-claim","timestamp":"2026-06-02T11:05:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
    },
    {
      createdAt: '2026-06-02T11:10:00Z',
      author: { login: 'maintainer' },
      body: '<!-- forced-handoff: {"oldAgentId":"agent-D","oldClaimId":"claim-9","newAgentId":"agent-B","newClaimId":"claim-2","branch":"issue/50-task","forcedBy":"maintainer","reason":"actual handoff","timestamp":"2026-06-02T11:10:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
    },
  ];

  const result = evaluateResumeClaimRouting(
    { now: '2026-06-02T12:00:00Z', events },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
    },
  );

  assert.equal(result.active_claim?.claim_id, 'claim-2');
  assert.deepEqual(result.evidence.forced_handoff, {
    old_agent_id: 'agent-D',
    old_claim_id: 'claim-9',
    new_agent_id: 'agent-B',
    new_claim_id: 'claim-2',
    forced_by: 'maintainer',
    timestamp: '2026-06-02T11:10:00Z',
  });
});

test('forced-handoff is ignored when forced-handoff mode is disabled', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      // isForcedHandoffEnabled omitted -> defaults to () => false
      isAuthorizedForcedHandoff: () => true,
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.ok(
    result.warnings.some((message) =>
      message.includes('forced-handoff mode is not enabled'),
    ),
    'expected a warning naming the disabled forced-handoff mode',
  );
});

test('forced-handoff is ignored when forcedBy is not an authorized maintainer', () => {
  // Reproduces the same-identity self-signed hijack scenario: a second
  // session running under the trusted marker login posts a forged
  // forced-handoff naming itself as the forcing authority. The
  // authorization callback rejects unauthorized forcedBy actors.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'owner-account',
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'active-claim-non-stale');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.ok(
    result.warnings.some((message) =>
      message.includes('forcedBy maintainer is not an authorized maintainer'),
    ),
    'expected a warning naming the unauthorized forcedBy actor',
  );
});

test('forced-handoff is ignored when comment author does not match forcedBy', () => {
  // A trusted-marker actor (here `copilot`) posts a forged handoff that
  // names a real maintainer as the forcing authority. Without the
  // author-vs-forcedBy binding, the downstream collaborator-permission
  // lookup would happily authorize "real-maintainer". The library must
  // reject the marker before reaching that lookup.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-B',
      now: '2026-05-23T10:05:00Z',
      events: [
        {
          createdAt: '2026-05-23T10:00:00Z',
          author: { login: 'copilot' },
          body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
        },
        {
          createdAt: '2026-05-23T10:02:00Z',
          author: { login: 'copilot' },
          body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-A","newAgentId":"copilot","newClaimId":"claim-B","branch":"issue/100-task","forcedBy":"real-maintainer","reason":"forged","timestamp":"2026-05-23T10:02:00Z","contextScope":"issue-only"} -->\n\n_copilot: forced handoff — IDD automation marker. Do not edit._',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['copilot']),
      isForcedHandoffEnabled: () => true,
      // The forcedBy string passes a naive collaborator-permission lookup
      // but the author binding inside the library must reject the marker
      // before this callback is even consulted.
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'real-maintainer',
    },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.active_claim?.claim_id, 'claim-A');
  assert.ok(
    result.warnings.some((message) =>
      message.includes(
        'comment author copilot does not match forcedBy real-maintainer',
      ),
    ),
    'expected a warning naming the author/forcedBy mismatch',
  );
});

test('self-signed forced-handoff from same identity does not transfer ownership', () => {
  // The PoC scenario: Session B running under the same GitHub login as
  // Session A posts a forced-handoff with `forcedBy: copilot` (its own
  // login). Even though the comment author is trusted (auto-trusted as
  // viewer in the CLI path), `copilot` is not an authorized maintainer,
  // so the handoff must be ignored.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-B',
      now: '2026-05-23T10:05:00Z',
      events: [
        {
          createdAt: '2026-05-23T10:00:00Z',
          author: { login: 'copilot' },
          body: '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
        },
        {
          createdAt: '2026-05-23T10:02:00Z',
          author: { login: 'copilot' },
          body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-A","newAgentId":"copilot","newClaimId":"claim-B","branch":"issue/100-task","forcedBy":"copilot","reason":"unilateral","timestamp":"2026-05-23T10:02:00Z","contextScope":"issue-only"} -->\n\n_copilot: forced handoff — IDD automation marker. Do not edit._',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['copilot']),
      isForcedHandoffEnabled: () => true,
      // The shipped CLI builds this from the collaborator permission
      // policy. Here we hard-code: only `maintainer-account` is
      // authorized. The self-signed `copilot` actor is rejected.
      isAuthorizedForcedHandoff: (forcedBy) =>
        forcedBy === 'maintainer-account',
    },
  );

  assert.notEqual(result.state, 'already_owned');
  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.active_claim?.claim_id, 'claim-A');
});

test('legacy freshness uses marker timestamp over comment metadata timestamp', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-13T09:59:59Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/9-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.reason, 'legacy-claim-stale');
});

test('legacy matching release remains valid after unrelated later unclaim', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T12:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/12-task -->',
        },
        {
          createdAt: '2026-05-12T08:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T08:10:00Z -->',
        },
        {
          createdAt: '2026-05-12T08:20:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: someone-else 2026-05-12T08:20:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.reason, 'legacy-released');
  assert.equal(result.active_claim, null);
});

test('detects a later competing claim that precedes a heartbeat of the active claim', () => {
  // claim-race (10:05) is posted after the original claim (10:00) but before
  // a heartbeat of the active claim (10:10). The heartbeat refreshes the
  // active claim's createdAt; baselining the competitor search on that
  // refreshed time would hide the race, so the search baselines on the
  // original claim event instead.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/11-task -->',
        },
        {
          createdAt: '2026-05-12T10:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:10:00Z branch: issue/11-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.reason, 'later-competing-claim');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
});

test('baselines the competing-claim search by timestamp regardless of event order', () => {
  // The events array is not oldest-first (the heartbeat appears before the
  // original claim). The original-claim baseline must be chosen by
  // timestamp, not array position, so the race is still detected.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:10:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:10:00Z branch: issue/12-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/12-task -->',
        },
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/12-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
});

// Forced-handoff events whose marker scope/linkedPr can be varied to test
// the buildForcedHandoffEnabledGate behavior end-to-end.
function forcedHandoffEvents(scope: {
  contextScope: string;
  linkedPr?: string;
}) {
  const payload = {
    oldAgentId: 'copilot',
    oldClaimId: 'claim-old',
    newAgentId: 'copilot',
    newClaimId: 'claim-new',
    branch: 'issue/11-task',
    forcedBy: 'maintainer',
    reason: 'handoff',
    timestamp: '2026-05-12T10:01:00Z',
    ...scope,
  };
  return [
    {
      createdAt: '2026-05-12T10:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
    },
    {
      createdAt: '2026-05-12T10:01:00Z',
      author: { login: 'maintainer' },
      body: `<!-- forced-handoff: ${JSON.stringify(payload)} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._`,
    },
  ];
}

const route = (
  events: ReturnType<typeof forcedHandoffEvents>,
  gate: ReturnType<typeof buildForcedHandoffEnabledGate>,
) =>
  evaluateResumeClaimRouting(
    { claimId: 'claim-new', now: '2026-05-12T11:00:00Z', events },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: gate,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
    },
  );

test('gate blocks an issue-only forced handoff that displaces a PR-backed claim', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(['77']),
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-only' }),
    gate,
  );
  // Handoff not honored: the original claim stays active, successor rejected.
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('gate honors an issue-plus-pr forced handoff naming the backing PR', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(['77']),
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '77' }),
    gate,
  );
  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('gate rejects an issue-plus-pr handoff naming a different PR', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(['77']),
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '88' }),
    gate,
  );
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('gate honors an issue-only handoff when no open linked PR backs the claim', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(),
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-only' }),
    gate,
  );
  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('gate never honors a forced handoff when forced-handoff mode is disabled', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: false,
    expectedLinkedPrReferences: new Set(),
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '77' }),
    gate,
  );
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

// #1687: a lost different-second claim race must not livelock the issue
// against mechanical reclaim once the active claim clears claim-stale-age --
// even though a later competing claim marker is still present from the
// losing side of the race.
test('stale active claim with a later competing claim still routes to takeover for a fresh session', () => {
  const events = [
    {
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-a supersedes: none 2026-05-12T09:00:00Z branch: issue/20-task -->',
    },
    {
      createdAt: '2026-05-12T09:00:03Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: other claim-b supersedes: none 2026-05-12T09:00:03Z branch: issue/20-task -->',
    },
  ];

  // A fresh session (no --claim-id) checking well past the 24h stale-age
  // boundary must still see a takeover-eligible route -- this is the
  // documented Discover Step 1.5 mechanical path.
  const result = evaluateResumeClaimRouting(
    { now: '2026-05-13T09:00:04Z', events },
    { isTrustedAuthor: trusted(['maintainer']) },
  );
  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'active-claim-stale');
  assert.equal(result.active_claim?.claim_id, 'claim-a');

  // The A5(c) fresh-claim gate (which always ignores --claim-id) must reach
  // the same conclusion: `stale-reclaimable`, never a permanent
  // `already-claimed`/disputed verdict.
  const gate = evaluateFreshClaimGate(
    { now: '2026-05-13T09:00:04Z', events },
    { isTrustedAuthor: trusted(['maintainer']) },
  );
  assert.equal(gate.verdict, 'stale-reclaimable');
  assert.equal(gate.winningClaimId, 'claim-a');
});

// #1687: the owner-resume disputed/stop semantics are test-locked and must
// stay unchanged by the staleness reordering above -- a session that
// verified it owns the active claim (matching --claim-id) still sees
// `disputed` against a later competing claim, even once its own claim has
// crossed the 24h stale-age boundary. Only a *fresh* (non-owner) session
// gets the new staleness escape.
test('owner-resume dispute against a later competing claim is unaffected by the active claim going stale', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-13T10:30:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/21-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/21-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'disputed');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'later-competing-claim');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
});

// PR #1770 (CodeRabbit): when a later competing claim (step 4) and an
// activation-nonce mismatch (step 5) both fail for the same owner-resume
// check, `reason` must say so distinctly -- a caller deciding whether "step
// 4 is the sole failing check" (the safe-to-release precondition in
// idd-claim.instructions.md's Claim verification) cannot tell a step-4-only
// dispute apart from a dual failure if both collapse onto the same
// `later-competing-claim` reason. Releasing on a dual failure would evict
// the second, legitimate activation that shares this exact
// `{agent-id}`/`{claim-id}` pair.
test('reports a distinct reason when a later competing claim and a nonce mismatch both fail', () => {
  const events = [
    {
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-abc supersedes: none 2026-05-12T09:00:00Z branch: issue/24-task -->',
    },
    {
      createdAt: '2026-05-12T09:00:05Z',
      author: { login: 'maintainer' },
      body: '<!-- activation-nonce: copilot claim-abc nonce-aaa 2026-05-12T09:00:05Z -->',
    },
    {
      createdAt: '2026-05-12T09:00:07Z',
      author: { login: 'maintainer' },
      body: '<!-- activation-nonce: copilot claim-abc nonce-zzz 2026-05-12T09:00:07Z -->',
    },
    {
      createdAt: '2026-05-12T09:05:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T09:05:00Z branch: issue/24-task -->',
    },
  ];

  const loserPerspective = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-zzz',
      now: '2026-05-12T10:00:00Z',
      events,
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(loserPerspective.state, 'disputed');
  assert.equal(loserPerspective.action, 'stop');
  assert.equal(
    loserPerspective.reason,
    'later-competing-claim-and-activation-nonce-mismatch',
  );
  assert.equal(
    loserPerspective.evidence.later_competing_claim?.claim_id,
    'claim-race',
  );
  assert.equal(loserPerspective.evidence.activation_nonce_winner, 'nonce-aaa');

  // The nonce winner's own perspective is unaffected: it still fails step 4
  // (the same later competing claim) with the plain reason, since its own
  // nonce comparison passes.
  const winnerPerspective = evaluateResumeClaimRouting(
    {
      claimId: 'claim-abc',
      nonce: 'nonce-aaa',
      now: '2026-05-12T10:00:00Z',
      events,
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );
  assert.equal(winnerPerspective.state, 'disputed');
  assert.equal(winnerPerspective.reason, 'later-competing-claim');
});

// #1687: a competitor that loses the race and courteously releases its own
// raced claim (its own {agent-id}/{claim-id} unclaimed-by, posted after its
// claimed-by) must no longer count as a live competitor -- clearing the
// dispute it created instead of leaving it stuck forever.
test('a released competing claim no longer produces disputed', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-owned',
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/22-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/22-task -->',
        },
        {
          createdAt: '2026-05-12T10:06:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: other claim-race 2026-05-12T10:06:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.later_competing_claim, null);
});

test('evaluateFreshClaimGate: released competing claim is claimable, not already-claimed', () => {
  // Mirrors the fresh-claim-gate scenario from the livelock report: the
  // active claim itself has also been released (the owner's own courteous
  // walk-away, matching the new step-4-only release instruction), so the
  // issue should read as plainly unclaimed once the raced competitor's
  // release is reconciled too -- proving `findLaterCompetingClaim`'s
  // reconciliation never masks the ordinary release path (once
  // `state.activeClaim` clears, the competing-claim scan is never even
  // invoked; see `!state.activeClaim` in `evaluateResumeClaimRouting`).
  const gate = evaluateFreshClaimGate(
    {
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-owned supersedes: none 2026-05-12T10:00:00Z branch: issue/23-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: other claim-race supersedes: none 2026-05-12T10:05:00Z branch: issue/23-task -->',
        },
        {
          createdAt: '2026-05-12T10:06:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: other claim-race 2026-05-12T10:06:00Z -->',
        },
        {
          createdAt: '2026-05-12T10:07:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: copilot claim-owned 2026-05-12T10:07:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(gate.verdict, 'claimable');
  assert.equal(gate.reason, 'no-active-claim');
  assert.equal(gate.winningClaimId, null);
});

test('runCli sources currentLogin from resolveViewerLogin (#2148)', () => {
  // #2266: currentLogin now sources from the provider port's
  // resolveViewerLogin() instead of the bare gh-exec.mts call this regex
  // originally locked in -- the port's adapter hardcodes the same
  // GH_TEXT_LOOP_TIMEOUT_OPTIONS profile internally (see
  // provider-port.mts's doc comment on resolveViewerLogin), so this test's
  // actual intent (runCli must not hand-roll its own lesser viewer-login
  // resolution) is unchanged.
  const source = readFileSync(
    new URL('../src/scripts/resume-claim-routing.mts', import.meta.url),
    'utf8',
  );
  assert.match(source, /port\.resolveViewerLogin\(\)/);
});

// #2195: --token substituted GH_TOKEN/GITHUB_TOKEN for gh auth, ambiguous
// against select-desynced-index.mjs's unrelated same-named session-desync
// token. --gh-token is now canonical; --token stays a deprecated alias for
// one release. A fake `gh` on PATH dumps GH_TOKEN/GITHUB_TOKEN to a side
// file before failing (any real network call is out of scope for this
// flag-propagation test), so the CLI process always exits non-zero -- only
// the dumped env values matter here.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function ghTokenPropagationFixture() {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-token-'),
  );
  const dumpPath = join(tempRoot, 'env-dump.json');
  const restore = stubExecutable(
    'gh',
    `require('fs').writeFileSync(process.env.ENV_DUMP_PATH, JSON.stringify({
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
}));
process.exit(1);
`,
  );
  return { dumpPath, restore };
}

function runResumeClaimRoutingCli(
  extraArgs: string[],
  fixture: ReturnType<typeof ghTokenPropagationFixture>,
) {
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
        '--issue',
        '1',
        ...extraArgs,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
      },
    ),
  );
  return JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
    ghToken: string | null;
    githubToken: string | null;
  };
}

test('--gh-token sets GH_TOKEN/GITHUB_TOKEN for gh auth', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    const dump = runResumeClaimRoutingCli(
      ['--gh-token', 'canonical-test-token'],
      fixture,
    );
    assert.equal(dump.ghToken, 'canonical-test-token');
    assert.equal(dump.githubToken, 'canonical-test-token');
  } finally {
    fixture.restore();
  }
});

test('--token still sets GH_TOKEN/GITHUB_TOKEN and warns as a deprecated alias', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
          '--issue',
          '1',
          '--token',
          'deprecated-test-token',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
        },
      );
      assert.fail('expected the CLI to exit non-zero');
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? '');
    }
    const dump = JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
      ghToken: string | null;
      githubToken: string | null;
    };
    assert.equal(dump.ghToken, 'deprecated-test-token');
    assert.equal(dump.githubToken, 'deprecated-test-token');
    assert.match(stderr, /--token is deprecated; use --gh-token instead\./);
  } finally {
    fixture.restore();
  }
});
