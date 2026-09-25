import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  acquireClaimLock,
  recordGeneratedClaimTokens,
} from '../src/scripts/claim-lock.mts';
import {
  isCurrentSessionWorktreeOwner,
  resolveCurrentSessionClaimEvidence,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  DEFAULT_STALE_AGE_MS,
  resolveActiveClaimForWriteGate,
  summarizeClaimValidation,
} from '../src/scripts/protocol-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import {
  buildForcedHandoffEnabledGate,
  evaluateFreshClaimGate,
  evaluateResumeClaimRouting,
  fetchOpenLinkedPrReferences,
  loadPolicy,
} from '../src/scripts/resume-claim-routing.mts';
import { stubExecutable } from './test-utils.mts';

function trusted(logins: string[]) {
  const set = new Set(logins);
  return (login: string) => set.has(login);
}

// #3270: before this fix, `loadPolicy`'s own local `parseDurationToMs` was a
// loose, case-insensitive copy that accepted a schema-invalid lowercase
// `pt12h` as 12h, diverging from `pre-merge-readiness.mts`'s case-sensitive
// `normalizePolicyConfig`, which fell back to the distributed 24h default
// for the identical value. `loadPolicy` now delegates to the same shared
// `readClaimStaleAgeMs` both files use, so the two can no longer disagree.
test('loadPolicy (#3270) resolves a schema-invalid claimTiming.staleAge ("pt12h") to the distributed 24h default, matching pre-merge-readiness.mts', () => {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-policy-'),
  );
  const policyPath = join(tempRoot, 'config.json');
  try {
    writeFileSync(
      policyPath,
      JSON.stringify({ claimTiming: { staleAge: 'pt12h' } }),
    );
    assert.equal(loadPolicy(policyPath).staleAgeMs, 24 * 60 * 60 * 1000);

    // A well-formed, case-correct value still parses normally.
    writeFileSync(
      policyPath,
      JSON.stringify({ claimTiming: { staleAge: 'PT12H' } }),
    );
    assert.equal(loadPolicy(policyPath).staleAgeMs, 12 * 60 * 60 * 1000);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

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

test('stale takeover is blocked by a live local worktree', () => {
  const result = evaluateResumeClaimRouting(
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
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'matching local worktree for issue/3-task',
      }),
    },
  );

  assert.equal(result.state, 'local_worktree_occupied');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'stale-claim-local-worktree-occupied');
  assert.deepEqual(result.evidence.local_worktree, {
    status: 'occupied',
    paths: ['/tmp/repo.issue-3-task'],
    reason: 'matching local worktree for issue/3-task',
  });

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
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'matching local worktree for issue/3-task',
      }),
    },
  );
  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.winningClaimId, 'claim-old');
  assert.equal(gate.reason, 'stale-claim-local-worktree-occupied');
});

test('fresh claim gate withholds winningClaimId for a stale claim with an unreadable worktree (#3154)', () => {
  // An unreadable probe cannot verify that the stale active claim's own
  // worktree is what a taker-over would inherit -- exposing its id here
  // (via the active_claim branch, not only the released_claim fallback)
  // would let claim-lock --takeover treat a matching id as sufficient
  // authorization despite the occupancy check being inconclusive.
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
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'unreadable',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'ambiguous detached-operation metadata',
      }),
    },
  );

  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.winningClaimId, null);
  assert.equal(gate.reason, 'stale-claim-local-worktree-unreadable');
});

test('unreadable local worktree blocks stale takeover fail closed', () => {
  const result = evaluateResumeClaimRouting(
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
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'unreadable',
        paths: [],
        reason: 'git worktree list failed',
      }),
    },
  );

  assert.equal(result.state, 'local_worktree_occupied');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'stale-claim-local-worktree-unreadable');
  assert.deepEqual(result.evidence.local_worktree, {
    status: 'unreadable',
    paths: [],
    reason: 'git worktree list failed',
  });
});

test('verified owner resume may keep an occupied worktree', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-old',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'matching local worktree for issue/3-task',
      }),
      isCurrentSessionOwner: () => true,
    },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.local_worktree, undefined);
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

// kurone-kito/idd-skill#3266: an untrusted comment sitting between two
// same-second trusted claims must never make evaluateResumeClaimRouting,
// summarizeClaimValidation, and resolveActiveClaimForWriteGate disagree
// on the winning claim-id. Before #3266, evaluateResumeClaimRouting
// filtered untrusted authors out before ordering while the other two
// ordered the full, unfiltered stream and skipped untrusted events only
// later (inside applyClaimEvent) -- different trusted event sets ordered
// around the same non-transitive comparator could produce different
// winners for the identical underlying claim state (the write gate
// reporting `claimLost` for a session the resume helper reported as
// `already_owned`).
test('evaluateResumeClaimRouting, summarizeClaimValidation, and resolveActiveClaimForWriteGate agree on the winner when an untrusted comment sits between two same-second claims', () => {
  const events = [
    {
      createdAt: '2026-05-13T09:00:00.100Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-zzzzzzzz supersedes: none 2026-05-13T09:00:00Z branch: issue/6-task -->',
    },
    {
      createdAt: '2026-05-13T09:00:00.500Z',
      author: { login: 'stranger' },
      body: 'I would also like to help with this issue!',
    },
    {
      createdAt: '2026-05-13T09:00:00.900Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-aaaaaaaa supersedes: none 2026-05-13T09:00:00Z branch: issue/6-task -->',
    },
  ];
  const isTrustedAuthor = trusted(['maintainer']);

  const resumeResult = evaluateResumeClaimRouting(
    { claimId: 'claim-aaaaaaaa', now: '2026-05-13T10:00:00Z', events },
    { isTrustedAuthor },
  );
  const writeGateSummary = summarizeClaimValidation(events, {
    isTrustedAuthor,
    expectedClaimId: 'claim-aaaaaaaa',
    expectedAgentId: 'copilot',
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });
  const writeGateActive = resolveActiveClaimForWriteGate(events, {
    isTrustedAuthor,
    staleAgeMs: DEFAULT_STALE_AGE_MS,
  });

  assert.equal(resumeResult.active_claim?.claim_id, 'claim-aaaaaaaa');
  assert.equal(writeGateSummary.activeClaim.claimId, 'claim-aaaaaaaa');
  assert.equal(writeGateActive?.claimId, 'claim-aaaaaaaa');
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

// #3268: a later trusted `claimed-by` with a different claim-id can never
// activate while this owner's claim is already active (Claim-state parsing
// rules 4 and 6), so the owner keeps its claim instead of being disputed --
// the loser's own step 3 already fails it. The later claim still surfaces as
// diagnostics (evidence + a warning), never as a route outcome.
test('a later competing claim that never released does not dispute the owner', () => {
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

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
  assert.ok(
    result.warnings.some((warning) => warning.includes('claim-race')),
    'expected a warning naming the later competing claim',
  );
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

test('verified forced-handoff successor may resume occupied stale worktree', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-13T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-11-task'],
        reason: 'matching local worktree for issue/11-task',
      }),
      isCurrentSessionOwner: () => true,
    },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.local_worktree, undefined);
  assert.equal(result.evidence.forced_handoff?.new_claim_id, 'claim-new');
});

test('owner resume stops without independent local ownership evidence', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-old',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'matching local worktree for issue/3-task',
      }),
      isCurrentSessionOwner: () => false,
    },
  );

  // #3272: this is now `owner_evidence_required`, a state distinct from
  // `non_inheritable` -- a claim-id match with no independent owner
  // evidence is not the same fact as a genuinely disputed claim.
  assert.equal(result.state, 'owner_evidence_required');
  assert.notEqual(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(
    result.reason,
    'claim-id-match-without-independent-owner-evidence',
  );
});

test('an explicit --worktree path supplies owner evidence regardless of process.cwd() (#3272)', () => {
  // The lock, generated-tokens record, and branch all live in a worktree
  // this session is proving ownership of by NAME, not by being inside it --
  // process.cwd() is deliberately left pointed at an unrelated, non-git
  // directory to prove the evidence really comes from the passed path.
  const worktree = mkdtempSync(join(tmpdir(), 'idd-resume-worktree-evidence-'));
  const unrelatedCwd = mkdtempSync(join(tmpdir(), 'idd-resume-unrelated-cwd-'));
  const claimId = 'claim-worktree-evidence';
  const branch = 'issue/42-task';
  const originalCwd = process.cwd();
  try {
    execFileSync('git', ['init', '--quiet', '-b', branch], {
      cwd: worktree,
      stdio: 'ignore',
    });
    acquireClaimLock(worktree, 'agent-owner', claimId, false);
    recordGeneratedClaimTokens(worktree, {
      agentId: 'agent-owner',
      claimId,
      nonce: 'nonce-owner',
    });
    process.chdir(unrelatedCwd);

    const result = evaluateResumeClaimRouting(
      {
        claimId,
        now: '2026-05-13T10:00:01Z',
        events: [
          {
            createdAt: '2026-05-12T10:00:00Z',
            author: { login: 'maintainer' },
            body: `<!-- claimed-by: agent-owner ${claimId} supersedes: none 2026-05-12T10:00:00Z branch: ${branch} -->`,
          },
        ],
      },
      {
        isTrustedAuthor: trusted(['maintainer']),
        inspectLocalWorktree: () => ({
          status: 'occupied',
          paths: [worktree],
          reason: `matching local worktree for ${branch}`,
        }),
        isCurrentSessionOwner: (claim) => {
          const evidence = resolveCurrentSessionClaimEvidence(
            claim.claimId,
            worktree,
          );
          if (
            evidence === null ||
            evidence.agentId !== claim.agentId ||
            evidence.branchName !== claim.branch
          ) {
            return false;
          }
          return isCurrentSessionWorktreeOwner(
            evidence.worktreePath,
            evidence.branchName,
            claim.branch,
            { status: 'occupied', paths: [worktree], reason: null },
          );
        },
      },
    );

    assert.equal(result.state, 'already_owned');
    assert.equal(result.action, 'keep');
    assert.equal(result.reason, 'claim-id-match');
  } finally {
    process.chdir(originalCwd);
    rmSync(worktree, { recursive: true, force: true });
    rmSync(unrelatedCwd, { recursive: true, force: true });
  }
});

test('owner resume keeps already_owned before B1 creates the worktree (#3154)', () => {
  // A forced-handoff successor's very first routing check runs before B1
  // ever creates its worktree, so the probe reports `absent` -- the
  // independent-owner-evidence gate must not fire merely because
  // isCurrentSessionOwner can't prove ownership of a worktree that does not
  // exist. Only a non-`absent` result disambiguates a real second session.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: codex claim-new supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'absent',
        paths: [],
        reason: null,
      }),
      isCurrentSessionOwner: () => false,
    },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
});

test('owner resume stops on an unreadable worktree probe too (#3154)', () => {
  // An unreadable probe is ambiguous, not verified-empty: the fail-closed
  // default means it must block owner-resume the same way an occupied
  // result does, not silently fall through to already_owned.
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-old',
      now: '2026-05-13T10:00:01Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/3-task -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'unreadable',
        paths: ['/tmp/repo.issue-3-task'],
        reason: 'ambiguous detached-operation metadata',
      }),
      isCurrentSessionOwner: () => false,
    },
  );

  // #3272: same distinct state as the occupied-probe case above -- an
  // unreadable probe is still "no independent owner evidence", not a
  // genuinely disputed claim.
  assert.equal(result.state, 'owner_evidence_required');
  assert.equal(result.action, 'stop');
  assert.equal(
    result.reason,
    'claim-id-match-without-independent-owner-evidence',
  );
});

test('fresh caller cannot bypass occupied worktree with forced-handoff evidence', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-11-task'],
        reason: 'matching local worktree for issue/11-task',
      }),
    },
  );

  assert.equal(result.state, 'local_worktree_occupied');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'stale-claim-local-worktree-occupied');
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

test('legacy freshness uses the comment created_at, not a stale embedded marker timestamp (#3271)', () => {
  // The embedded timestamp is two days old -- a clock with no skew
  // would read this as stale -- but the comment itself was posted one
  // minute ago. Only the GitHub `created_at` may drive the verdict, so this
  // must resolve as a live (non-stale) claim, not a takeover.
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-13T09:59:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-11T09:59:00Z branch: issue/9-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'legacy-claim-non-stale');
  assert.equal(result.active_claim?.created_at, '2026-05-13T09:59:00Z');
});

test('legacy staleness uses the comment created_at, not a future embedded marker timestamp (#3271)', () => {
  // The embedded timestamp is in the future -- a skewed agent clock --
  // but the comment itself was posted two days ago. Only the GitHub
  // `created_at` may drive the verdict, so this must resolve as stale
  // and eligible for takeover, not locked forever behind a future date.
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-13T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-11T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-20T10:00:00Z branch: issue/10-task -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'legacy-claim-stale');
  assert.equal(result.active_claim?.created_at, '2026-05-11T10:00:00Z');
});

test('legacy release created_at ordering wins even when its embedded timestamp predates the claim (#3271)', () => {
  // The release's embedded timestamp (2026-05-10) predates the claim's
  // own embedded timestamp (2026-05-15), which under embedded-time
  // ordering would make the release look earlier than the claim and so
  // fail the "strictly later" rule. The release comment's real
  // created_at (09:00) is nonetheless later than the claim comment's
  // (08:00), so the release must still apply.
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T12:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-15T00:00:00Z branch: issue/13-task -->',
        },
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-10T00:00:00Z -->',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'unclaimed');
  assert.equal(result.reason, 'legacy-released');
  assert.equal(result.active_claim, null);
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

test('a later competing claim preceding a heartbeat still does not dispute the owner', () => {
  // claim-race (10:05) is posted after the original claim (10:00) but before
  // a heartbeat of the active claim (10:10). The heartbeat refreshes the
  // active claim's createdAt; baselining the competitor search on that
  // refreshed time would hide the race, so the search baselines on the
  // original claim event instead. The race still never disputes the owner
  // (#3268) -- it only ever surfaces as diagnostics.
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

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
  assert.ok(
    result.warnings.some((warning) => warning.includes('claim-race')),
    'expected a warning naming the later competing claim',
  );
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

  assert.equal(result.state, 'already_owned');
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
  // #3276: real callers (runCli) always pass linkedPrLookupFailed to BOTH
  // the gate builder and evaluateResumeClaimRouting's own options -- the
  // latter drives resolveClaimState's warning-text discrimination and
  // linkedPrLookupFailureRejections bookkeeping the --claim-id override
  // reads. Passing it only to the gate builder (the default, for every
  // caller here that isn't testing #3276 itself) would silently produce
  // the misleading generic "mode is not enabled" warning instead.
  linkedPrLookupFailed?: boolean,
) =>
  evaluateResumeClaimRouting(
    { claimId: 'claim-new', now: '2026-05-12T11:00:00Z', events },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: gate,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
      linkedPrLookupFailed,
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

// #3276: a failed linked-PR lookup (PR state unknown, not "no PR") must
// reject an issue-only handoff instead of falling into the empty-set
// shortcut, while leaving an issue-plus-pr handoff exactly as today.
test('gate rejects an issue-only handoff when the linked-PR lookup itself failed', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(),
    linkedPrLookupFailed: true,
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-only' }),
    gate,
    true,
  );
  assert.equal(result.active_claim?.claim_id, 'claim-old');
  assert.ok(
    result.warnings.some((message) =>
      message.includes('linked-PR lookup failed'),
    ),
    'expected the dedicated lookup-failure warning, not the generic one',
  );
  assert.ok(
    !result.warnings.some((message) =>
      message.includes('forced-handoff mode is not enabled'),
    ),
    'must not emit the misleading generic warning -- mode is actually enabled',
  );
});

test('gate still honors an issue-plus-pr handoff when the linked-PR lookup failed (unchanged, out of scope for #3276)', () => {
  const gate = buildForcedHandoffEnabledGate({
    forcedHandoffEnabled: true,
    expectedLinkedPrReferences: new Set(),
    linkedPrLookupFailed: true,
  });
  const result = route(
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '77' }),
    gate,
    true,
  );
  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

// #3276: neither side of a forced handoff blocked solely by a failed
// linked-PR lookup may read as an ordinary claim-state outcome for a
// --claim-id check.
function routeWithLinkedPrLookupFailure(claimId: string) {
  return evaluateResumeClaimRouting(
    {
      claimId,
      now: '2026-05-12T11:00:00Z',
      events: FORCED_HANDOFF_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: buildForcedHandoffEnabledGate({
        forcedHandoffEnabled: true,
        expectedLinkedPrReferences: new Set(),
        linkedPrLookupFailed: true,
      }),
      isAuthorizedForcedHandoff: (forcedBy: string) =>
        forcedBy === 'maintainer',
      linkedPrLookupFailed: true,
    },
  );
}

test('#3276: the displaced original owner (oldClaimId) never reads already_owned when the handoff was blocked by a failed linked-PR lookup', () => {
  const result = routeWithLinkedPrLookupFailure('claim-old');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'forced-handoff-linked-pr-lookup-failed');
  assert.notEqual(result.state, 'already_owned');
  assert.equal(result.evidence.forced_handoff, null);
  assert.ok(
    result.warnings.some((message) =>
      message.includes('linked-PR lookup failed'),
    ),
    'expected a warning naming the lookup failure',
  );
  assert.ok(
    !result.warnings.some((message) =>
      message.includes('forced-handoff mode is not enabled'),
    ),
    'must not also claim forced-handoff mode is disabled -- it is enabled',
  );
});

test('#3276: the would-be successor (newClaimId) also stops with the lookup-failure reason, never a generic non_inheritable stop', () => {
  const result = routeWithLinkedPrLookupFailure('claim-new');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'forced-handoff-linked-pr-lookup-failed');
  assert.equal(result.evidence.forced_handoff, null);
  assert.ok(
    result.warnings.some((message) =>
      message.includes('linked-PR lookup failed'),
    ),
    'expected a warning naming the lookup failure',
  );
});

// #3276 (CodeRabbit review, PR #3386): applyClaimEvent checks
// isForcedHandoffEnabled BEFORE the author/forcedBy match and authorization
// checks, so a forged or unauthorized issue-only marker must not be swept
// into linkedPrLookupFailureRejections (and thus the --claim-id override)
// under a failed lookup -- it would be rejected as forged/unauthorized
// regardless of the lookup outcome, and the override must not misfire for
// its oldClaimId/newClaimId.
function routeWithLinkedPrLookupFailureAndOptions(
  claimId: string,
  events: ReturnType<typeof forcedHandoffEvents>,
  isAuthorizedForcedHandoff: (forcedBy: string) => boolean,
) {
  return evaluateResumeClaimRouting(
    { claimId, now: '2026-05-12T11:00:00Z', events },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: buildForcedHandoffEnabledGate({
        forcedHandoffEnabled: true,
        expectedLinkedPrReferences: new Set(),
        linkedPrLookupFailed: true,
      }),
      isAuthorizedForcedHandoff,
      linkedPrLookupFailed: true,
    },
  );
}

test('#3276: a forged issue-only marker (author does not match forcedBy) under a failed lookup does not trigger the override', () => {
  // forcedHandoffEvents() posts the marker as author 'maintainer' with
  // forcedBy 'maintainer' by default (a match); override forcedBy to a
  // different name so the author no longer matches it.
  const events = [
    {
      createdAt: '2026-05-12T10:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
    },
    {
      createdAt: '2026-05-12T10:01:00Z',
      author: { login: 'maintainer' },
      body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-old","newAgentId":"copilot","newClaimId":"claim-new","branch":"issue/11-task","forcedBy":"someone-else","reason":"forged","timestamp":"2026-05-12T10:01:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
    },
  ];
  const oldResult = routeWithLinkedPrLookupFailureAndOptions(
    'claim-old',
    events,
    () => true,
  );
  assert.equal(oldResult.state, 'already_owned');
  assert.notEqual(oldResult.reason, 'forced-handoff-linked-pr-lookup-failed');

  const newResult = routeWithLinkedPrLookupFailureAndOptions(
    'claim-new',
    events,
    () => true,
  );
  assert.notEqual(newResult.reason, 'forced-handoff-linked-pr-lookup-failed');
});

test('#3276: an unauthorized issue-only marker under a failed lookup does not trigger the override', () => {
  const oldResult = routeWithLinkedPrLookupFailureAndOptions(
    'claim-old',
    forcedHandoffEvents({ contextScope: 'issue-only' }),
    () => false,
  );
  assert.equal(oldResult.state, 'already_owned');
  assert.notEqual(oldResult.reason, 'forced-handoff-linked-pr-lookup-failed');

  const newResult = routeWithLinkedPrLookupFailureAndOptions(
    'claim-new',
    forcedHandoffEvents({ contextScope: 'issue-only' }),
    () => false,
  );
  assert.notEqual(newResult.reason, 'forced-handoff-linked-pr-lookup-failed');
});

test('#3276: a failed linked-PR lookup with no forced-handoff marker present routes identically to a successful empty lookup', () => {
  const events = [
    {
      createdAt: '2026-05-12T10:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
    },
  ];
  const optionsFor = (linkedPrLookupFailed: boolean) => ({
    isTrustedAuthor: trusted(['maintainer']),
    isForcedHandoffEnabled: buildForcedHandoffEnabledGate({
      forcedHandoffEnabled: true,
      expectedLinkedPrReferences: new Set(),
      linkedPrLookupFailed,
    }),
    isAuthorizedForcedHandoff: () => true,
    linkedPrLookupFailed,
  });
  const failedLookup = evaluateResumeClaimRouting(
    { claimId: 'claim-old', now: '2026-05-12T11:00:00Z', events },
    optionsFor(true),
  );
  const successfulLookup = evaluateResumeClaimRouting(
    { claimId: 'claim-old', now: '2026-05-12T11:00:00Z', events },
    optionsFor(false),
  );
  // "Same routing" (the AC's own wording) means state/action/reason/
  // active_claim/warnings, not the whole object -- evidence.linked_pr_lookup
  // legitimately differs, since it reports the real lookup outcome
  // regardless of whether a forced-handoff marker exists to act on it.
  assert.equal(failedLookup.state, successfulLookup.state);
  assert.equal(failedLookup.action, successfulLookup.action);
  assert.equal(failedLookup.reason, successfulLookup.reason);
  assert.deepEqual(failedLookup.active_claim, successfulLookup.active_claim);
  assert.deepEqual(failedLookup.warnings, successfulLookup.warnings);
  assert.equal(failedLookup.evidence.linked_pr_lookup, 'failed');
  assert.equal(successfulLookup.evidence.linked_pr_lookup, 'ok');
  assert.equal(failedLookup.state, 'already_owned');
});

// #3276: fetchOpenLinkedPrReferences itself -- pagination and
// failure-vs-empty distinction, via a fake ProviderPort (no live `gh`).
test('fetchOpenLinkedPrReferences walks every page and reconciles CONNECTED/DISCONNECTED across pages', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        {
          events: [
            {
              __typename: 'ConnectedEvent',
              subject: { __typename: 'PullRequest', number: 77, state: 'OPEN' },
            },
            {
              __typename: 'ConnectedEvent',
              subject: { __typename: 'PullRequest', number: 88, state: 'OPEN' },
            },
          ],
          hasNextPage: true,
          endCursor: 'cursor-1',
        },
        {
          events: [
            {
              __typename: 'DisconnectedEvent',
              subject: { __typename: 'PullRequest', number: 88 },
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11);
  assert.equal(result.lookupFailed, false);
  assert.deepEqual([...result.references], ['77']);
});

test('fetchOpenLinkedPrReferences reports lookupFailed: true (not an empty successful result) when a page throws', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPageErrors: { 11: 'simulated gh failure' },
  });
  const result = fetchOpenLinkedPrReferences(port, 11);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.references.size, 0);
});

test('fetchOpenLinkedPrReferences reports lookupFailed: true on an incomplete page (hasNextPage with no endCursor)', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [{ events: [], hasNextPage: true, endCursor: null }],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.references.size, 0);
});

// #3276 round 4 (CodeRabbit review, PR #3386): a repeated non-progressing
// cursor must not spin the pagination loop forever. `connectedPrEventPages`
// already lets a test hand back the identical `endCursor` across
// successive pages, so no new fixture field is needed to simulate this.
test('fetchOpenLinkedPrReferences reports lookupFailed: true on an immediate repeated cursor (non-progressing pagination)', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        { events: [], hasNextPage: true, endCursor: 'cursor-1' },
        { events: [], hasNextPage: true, endCursor: 'cursor-1' },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.references.size, 0);
});

test('fetchOpenLinkedPrReferences reports lookupFailed: true on a multi-cursor cycle (A -> B -> A)', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        { events: [], hasNextPage: true, endCursor: 'cursor-a' },
        { events: [], hasNextPage: true, endCursor: 'cursor-b' },
        { events: [], hasNextPage: true, endCursor: 'cursor-a' },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11);
  assert.equal(result.lookupFailed, true);
  assert.equal(result.references.size, 0);
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

// #3268: the owner-resume verdict against a later competing claim that never
// released is unaffected by the active claim going stale -- staleness only
// matters on the non-owner / fresh-claim-gate path.
test('owner-resume already-owned verdict against a later competing claim is unaffected by the active claim going stale', () => {
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

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-race');
  assert.ok(
    result.warnings.some((warning) => warning.includes('claim-race')),
    'expected a warning naming the later competing claim',
  );
});

// #3268 zombie heartbeat: A goes stale, B takes over with `supersedes: <A>`,
// and A's delayed heartbeat lands afterward. Claim-state parsing rules 4/6
// never reactivate A (rule 4: A's own re-post says `supersedes: none`, but a
// claim -- B's -- is already active; rule 6: A's claim-id was already
// superseded), so B's owner check must return `already_owned`/`keep`, and
// the F2/F3 write gate (`summarizeClaimValidation`) must agree with `match`
// for the same stream.
test('a zombie heartbeat from a displaced stale owner does not dispute the new owner', () => {
  const events = [
    {
      createdAt: '2026-05-12T09:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-a supersedes: none 2026-05-12T09:00:00Z branch: issue/30-task -->',
    },
    {
      createdAt: '2026-05-13T09:00:05Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: other claim-b supersedes: claim-a 2026-05-13T09:00:05Z branch: issue/30-task -->',
    },
    {
      createdAt: '2026-05-13T10:00:00Z',
      author: { login: 'maintainer' },
      body: '<!-- claimed-by: copilot claim-a supersedes: none 2026-05-13T10:00:00Z branch: issue/30-task -->',
    },
  ];

  const result = evaluateResumeClaimRouting(
    { claimId: 'claim-b', now: '2026-05-13T11:00:00Z', events },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'already_owned');
  assert.equal(result.action, 'keep');
  assert.equal(result.reason, 'claim-id-match');
  assert.equal(result.active_claim?.claim_id, 'claim-b');
  assert.equal(result.evidence.later_competing_claim?.claim_id, 'claim-a');
  assert.ok(
    result.warnings.some((warning) => warning.includes('claim-a')),
    'expected a warning naming the zombie heartbeat claim',
  );

  const summary = summarizeClaimValidation(events, {
    trustedMarkerLogins: ['maintainer'],
    expectedClaimId: 'claim-b',
    expectedAgentId: 'other',
  });
  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, 'match');
});

// PR #1770 (CodeRabbit) / #3268: a later competing claim no longer disputes
// the owner path on its own, so a nonce mismatch (the sticky forced-handoff
// adopt-verbatim collision #1522 exists to catch) reports the plain
// `activation-nonce-mismatch` reason even while a later competing claim is
// also present -- the combined
// `later-competing-claim-and-activation-nonce-mismatch` reason is now
// unreachable. The nonce winner's own perspective is unaffected either way:
// its nonce comparison passes, and the later competing claim only ever
// surfaces as diagnostics.
test('a nonce mismatch reports its own reason even when a later competing claim is also present', () => {
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
  assert.equal(loserPerspective.reason, 'activation-nonce-mismatch');
  assert.equal(
    loserPerspective.evidence.later_competing_claim?.claim_id,
    'claim-race',
  );
  assert.equal(loserPerspective.evidence.activation_nonce_winner, 'nonce-aaa');

  // The nonce winner's own perspective: its nonce comparison passes, and the
  // later competing claim no longer disputes the owner path, so it keeps
  // the claim -- with the later competing claim surfaced as a warning.
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
  assert.equal(winnerPerspective.action, 'keep');
  assert.equal(
    winnerPerspective.evidence.later_competing_claim?.claim_id,
    'claim-race',
  );
  assert.ok(
    winnerPerspective.warnings.some((warning) =>
      warning.includes('claim-race'),
    ),
    'expected a warning naming the later competing claim',
  );
});

// #1687 / #3268: a competitor that loses the race and courteously releases
// its own raced claim (its own {agent-id}/{claim-id} unclaimed-by, posted
// after its claimed-by) must no longer count as a live competitor at all --
// `findLaterCompetingClaim` excludes it before it ever reaches
// `evidence.later_competing_claim`, so no warning is raised either.
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
  assert.equal(result.warnings.length, 0);
});

test('evaluateFreshClaimGate: released competing claim is claimable, not already-claimed', () => {
  // Mirrors the fresh-claim-gate scenario from the livelock report: the
  // active claim itself has also been released (the owner's own
  // courteous walk-away), so the issue should read as plainly unclaimed
  // once the raced competitor's release is reconciled too -- proving
  // `findLaterCompetingClaim`'s
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

test('fresh claim gate blocks a released claim with a live local worktree', () => {
  let inspectedBranch = '';
  const gate = evaluateFreshClaimGate(
    {
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-released supersedes: none 2026-05-12T10:00:00Z branch: issue/24-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: copilot claim-released 2026-05-12T10:05:00Z -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: (branchName) => {
        inspectedBranch = branchName;
        return {
          status: 'occupied',
          paths: ['/tmp/repo.issue-24-task'],
          reason: 'matching local worktree for issue/24-task',
        };
      },
    },
  );

  assert.equal(inspectedBranch, 'issue/24-task');
  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.winningClaimId, 'claim-released');
  assert.equal(gate.reason, 'released-claim-local-worktree-occupied');
});

test('fresh claim gate withholds winningClaimId for an unreadable released-claim worktree (#3154)', () => {
  // An unreadable occupancy probe cannot verify that the released claim's
  // own worktree is what a taker-over would inherit -- exposing its id as
  // winningClaimId here would let `claim-lock --takeover` treat a matching
  // id as sufficient authorization despite the occupancy check being
  // inconclusive, contradicting the stated fail-closed rule.
  const gate = evaluateFreshClaimGate(
    {
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: copilot claim-released supersedes: none 2026-05-12T10:00:00Z branch: issue/24-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: copilot claim-released 2026-05-12T10:05:00Z -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'unreadable',
        paths: ['/tmp/repo.issue-24-task'],
        reason: 'ambiguous detached-operation metadata',
      }),
    },
  );

  assert.equal(gate.verdict, 'already-claimed');
  assert.equal(gate.winningClaimId, null);
  assert.equal(gate.reason, 'released-claim-local-worktree-unreadable');
});

test('released legacy claim stays out of active_claim when its worktree is occupied', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T11:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T10:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T10:00:00Z branch: issue/24-task -->',
        },
        {
          createdAt: '2026-05-12T10:05:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T10:05:00Z -->',
        },
      ],
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-24-task'],
        reason: 'matching local worktree for issue/24-task',
      }),
    },
  );

  assert.equal(result.state, 'local_worktree_occupied');
  assert.equal(result.reason, 'released-claim-local-worktree-occupied');
  assert.equal(result.active_claim, null);
  assert.equal(result.evidence.released_claim?.branch, 'issue/24-task');
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
  return {
    dumpPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
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

// #3188: --format mirrors sibling helpers such as live-status-digest.mjs so a
// caller that always passes `--format json` does not hit `unknown argument:
// --format`. JSON is the only supported output, so `json` must be a no-op
// and every other value must fail loudly rather than silently degrade.
// The fake `gh` answers exactly the three read calls runCli makes for an
// issue with no comments under an empty policy (forced handoff disabled,
// so no timeline lookup) and fails any other call so an unexpected one
// surfaces as a test failure instead of hitting the network.
function formatFlagFixture() {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-format-'),
  );
  const policyPath = join(tempRoot, 'config.json');
  writeFileSync(policyPath, '{}\n');
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('format-tester\\n');
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/1\\/comments/.test(arg))) {
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/1$/.test(arg))) {
  process.stdout.write(JSON.stringify({
    number: 1,
    title: 'format flag fixture',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/1',
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`,
  );
  return {
    policyPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function runFormatFlagCli(policyPath: string, extraArgs: string[]) {
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
      '--issue',
      '1',
      '--owner',
      'o',
      '--repo',
      'r',
      '--now',
      '2026-09-23T00:00:00Z',
      '--policy',
      policyPath,
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

test('--format json is accepted and prints the same JSON as omitting --format (#3188)', () => {
  const fixture = formatFlagFixture();
  try {
    const baseline = runFormatFlagCli(fixture.policyPath, []);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(JSON.parse(baseline.stdout).state, 'unclaimed');
    for (const formatArgs of [['--format', 'json'], ['--format=json']]) {
      const result = runFormatFlagCli(fixture.policyPath, formatArgs);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, baseline.stdout);
    }
  } finally {
    fixture.restore();
  }
});

test('--format rejects every value other than json (#3188)', () => {
  const fixture = formatFlagFixture();
  try {
    for (const value of ['table', 'JSON', '']) {
      const result = runFormatFlagCli(fixture.policyPath, ['--format', value]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /--format must be json/);
      assert.doesNotMatch(result.stderr, /unknown argument: --format/);
    }
  } finally {
    fixture.restore();
  }
});

// #3276: end-to-end CLI wiring check via a fake `gh` -- runCli itself must
// collect the linked-PR-lookup failure from a real (stubbed) `gh api
// graphql` failure and thread it through to the routing override, not only
// the pure functions exercised by the tests above.
function linkedPrLookupFailureCliFixture() {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-linked-pr-failure-'),
  );
  const policyPath = join(tempRoot, 'config.json');
  writeFileSync(
    policyPath,
    `${JSON.stringify({
      trustedMarkerActors: ['maintainer'],
      forcedHandoff: {
        mode: 'human-gated',
        authorityPolicy: 'owners-and-maintainers-only',
      },
    })}\n`,
  );
  const comments = [
    {
      id: 1,
      body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
      created_at: '2026-05-12T10:00:00Z',
      user: { login: 'maintainer' },
    },
    {
      id: 2,
      body: '<!-- forced-handoff: {"oldAgentId":"copilot","oldClaimId":"claim-old","newAgentId":"copilot","newClaimId":"claim-new","branch":"issue/11-task","forcedBy":"maintainer","reason":"handoff","timestamp":"2026-05-12T10:01:00Z","contextScope":"issue-only"} -->\\n\\n_maintainer: forced handoff — IDD automation marker. Do not edit._',
      created_at: '2026-05-12T10:01:00Z',
      user: { login: 'maintainer' },
    },
  ];
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('maintainer\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stderr.write('simulated connected-PR lookup failure\\n');
  process.exit(1);
}
if (args[0] === 'api' && args.some((arg) => /\\/collaborators\\/maintainer\\/permission/.test(arg))) {
  process.stdout.write(JSON.stringify({ permission: 'admin', role_name: 'admin' }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/11\\/comments/.test(arg))) {
  process.stdout.write(${JSON.stringify(JSON.stringify(comments))});
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/11$/.test(arg))) {
  process.stdout.write(JSON.stringify({
    number: 11,
    title: 'linked-pr lookup failure fixture',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/11',
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`,
  );
  return {
    policyPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function runLinkedPrLookupFailureCli(policyPath: string, claimId: string) {
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
      '--issue',
      '11',
      '--owner',
      'o',
      '--repo',
      'r',
      '--claim-id',
      claimId,
      '--now',
      '2026-05-12T11:00:00Z',
      '--policy',
      policyPath,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

test('#3276 end-to-end: runCli routes both the old and new claim-id to the lookup-failure stop when the real gh graphql call fails', () => {
  const fixture = linkedPrLookupFailureCliFixture();
  try {
    for (const claimId of ['claim-old', 'claim-new']) {
      const result = runLinkedPrLookupFailureCli(fixture.policyPath, claimId);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.action, 'stop');
      assert.equal(output.reason, 'forced-handoff-linked-pr-lookup-failed');
      assert.notEqual(output.state, 'already_owned');
      assert.equal(output.evidence.forced_handoff, null);
      assert.equal(output.evidence.linked_pr_lookup, 'failed');
    }
  } finally {
    fixture.restore();
  }
});

function runFreshClaimGateLinkedPrLookupFailureCli(
  policyPath: string,
  now: string,
) {
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
      '--issue',
      '11',
      '--owner',
      'o',
      '--repo',
      'r',
      '--fresh-claim-gate',
      '--now',
      now,
      '--policy',
      policyPath,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

// #3276 acceptance criterion: "--fresh-claim-gate returns already-claimed
// (displaced claim still active) until the claim is past claimTiming.staleAge,
// then stale-reclaimable." --fresh-claim-gate always ignores --claim-id, so
// this exercises the non-owner path the override above must never touch:
// the blocked issue-only handoff leaves claim-old as the active claim, and
// ordinary staleness (default claimTiming.staleAge: 24h) still governs it.
test('#3276 end-to-end: --fresh-claim-gate keeps the displaced claim active (already-claimed) until stale, then stale-reclaimable, unaffected by the blocked handoff', () => {
  const fixture = linkedPrLookupFailureCliFixture();
  try {
    const withinStaleWindow = runFreshClaimGateLinkedPrLookupFailureCli(
      fixture.policyPath,
      '2026-05-12T11:00:00Z', // 1h after claim-old's created_at
    );
    assert.equal(withinStaleWindow.status, 0, withinStaleWindow.stderr);
    const withinOutput = JSON.parse(withinStaleWindow.stdout);
    assert.equal(withinOutput.fresh_claim_gate.verdict, 'already-claimed');
    assert.equal(withinOutput.fresh_claim_gate.winning_claim_id, 'claim-old');

    const pastStaleWindow = runFreshClaimGateLinkedPrLookupFailureCli(
      fixture.policyPath,
      '2026-05-13T11:00:00Z', // 25h after claim-old's created_at
    );
    assert.equal(pastStaleWindow.status, 0, pastStaleWindow.stderr);
    const pastOutput = JSON.parse(pastStaleWindow.stdout);
    assert.equal(pastOutput.fresh_claim_gate.verdict, 'stale-reclaimable');
  } finally {
    fixture.restore();
  }
});

// ---------------------------------------------------------------------------
// Trusted-actor ladder (#3272): runCli now resolves trustedMarkerLogins via
// the shared resolveTrustedMarkerActors ladder (flag, then
// IDD_TRUSTED_MARKER_ACTORS, then the config's trustedMarkerActors array --
// the same precedence pre-merge-readiness.mts already uses), instead of the
// old union-everything resolveTrustedLogins. A non-empty flag now REPLACES
// the env/config sources rather than adding to them; the viewer login is
// still always added on top of whichever source wins.
// ---------------------------------------------------------------------------

/**
 * A fake `gh` that answers exactly the three read calls runCli makes (the
 * viewer login, the issue's own comments, and the issue itself) with a
 * single trusted-marker-ladder-relevant claimed-by comment, and fails any
 * other call so an unexpected one surfaces as a test failure instead of
 * hitting the network. Mirrors formatFlagFixture's shape above.
 */
function trustedLadderFixture({
  policyTrustedMarkerActors = [],
  commentLogin,
  claimId,
  branch,
  createdAt,
  agentId = 'agent-x',
}: {
  policyTrustedMarkerActors?: string[];
  commentLogin: string;
  claimId: string;
  branch: string;
  createdAt: string;
  agentId?: string;
}) {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-trust-ladder-'),
  );
  const policyPath = join(tempRoot, 'config.json');
  writeFileSync(
    policyPath,
    JSON.stringify({ trustedMarkerActors: policyTrustedMarkerActors }),
  );
  const commentJson = JSON.stringify({
    id: 1,
    node_id: 'IC_trust_ladder',
    body: `<!-- claimed-by: ${agentId} ${claimId} supersedes: none ${createdAt} branch: ${branch} -->`,
    created_at: createdAt,
    updated_at: createdAt,
    user: { login: commentLogin },
  });
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('viewer-login\\n');
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/1\\/comments/.test(arg))) {
  process.stdout.write(${JSON.stringify(commentJson)} + '\\n');
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/1$/.test(arg))) {
  process.stdout.write(JSON.stringify({
    number: 1,
    title: 'trust ladder fixture',
    state: 'open',
    html_url: 'https://github.com/o/r/issues/1',
  }));
  process.exit(0);
}
process.stderr.write('unexpected gh call: ' + JSON.stringify(args) + '\\n');
process.exit(1);
`,
  );
  return {
    policyPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function runTrustedLadderCli(
  policyPath: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv,
) {
  return spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
      '--issue',
      '1',
      '--owner',
      'o',
      '--repo',
      'r',
      '--now',
      '2026-09-24T00:01:00Z',
      '--policy',
      policyPath,
      ...extraArgs,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', env },
  );
}

test('a login trusted only via IDD_TRUSTED_MARKER_ACTORS is honored by --fresh-claim-gate (#3272)', () => {
  const fixture = trustedLadderFixture({
    policyTrustedMarkerActors: [],
    commentLogin: 'trusted-via-env',
    claimId: 'claim-ladder-env',
    branch: 'issue/1-task',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runTrustedLadderCli(
      fixture.policyPath,
      ['--fresh-claim-gate'],
      { ...process.env, IDD_TRUSTED_MARKER_ACTORS: 'trusted-via-env' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.policy.trusted_marker_actors_source, 'env');
    assert.equal(output.fresh_claim_gate.verdict, 'already-claimed');
  } finally {
    fixture.restore();
  }
});

test('--trusted-marker-logins replaces the config trustedMarkerActors instead of adding to it (#3272)', () => {
  const fixture = trustedLadderFixture({
    policyTrustedMarkerActors: ['config-only-trusted'],
    commentLogin: 'config-only-trusted',
    claimId: 'claim-ladder-flag',
    branch: 'issue/1-task',
    createdAt: '2026-09-24T00:00:00Z',
  });
  try {
    const result = runTrustedLadderCli(
      fixture.policyPath,
      ['--trusted-marker-logins', 'some-other-login'],
      { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.policy.trusted_marker_actors_source, 'flag');
    // config-only-trusted is no longer trusted -- the flag replaced the
    // config array instead of adding to it, so the claimed-by comment it
    // posted is filtered out and no claim is seen at all.
    assert.equal(output.state, 'unclaimed');
    assert.equal(output.reason, 'legacy-absent');
  } finally {
    fixture.restore();
  }
});

test('--worktree end-to-end: the real compiled CLI proves ownership via an occupied probe (#3272)', () => {
  // Unlike the unit-level '--worktree path supplies owner evidence' test
  // above (which hand-wires resolveCurrentSessionClaimEvidence directly
  // into evaluateResumeClaimRouting), this spawns the actual compiled
  // scripts/resume-claim-routing.mjs CLI so parseArgs()'s --worktree
  // parsing and runCli()'s isCurrentSessionOwner closure are exercised for
  // real (#3272 C1 finding: the unit test alone never proves the CLI
  // argument threading itself is correct).
  //
  // inspectLocalWorktree's real occupancy probe always reads
  // process.cwd() (it has no --worktree override of its own), so an
  // `occupied` result requires a real second git worktree next to the
  // spawned process's cwd. Using a disposable, fully standalone sandbox
  // repo (not this shared host clone) keeps that real `git worktree add`
  // isolated from the live idd-skill repository's own worktree state,
  // which 15+ concurrent IDD sessions may be mutating at the same time.
  const sandboxRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-worktree-flag-sandbox-'),
  );
  const primary = join(sandboxRoot, 'primary');
  const secondary = join(sandboxRoot, 'secondary');
  const branch = 'issue/1-task';
  const claimId = 'claim-worktree-flag-e2e';
  const agentId = 'agent-worktree-flag-e2e';
  const createdAt = '2026-09-24T00:00:00Z';
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'idd-test',
    GIT_AUTHOR_EMAIL: 'idd-test@example.com',
    GIT_COMMITTER_NAME: 'idd-test',
    GIT_COMMITTER_EMAIL: 'idd-test@example.com',
  };
  const fixture = trustedLadderFixture({
    policyTrustedMarkerActors: ['maintainer'],
    commentLogin: 'maintainer',
    claimId,
    branch,
    createdAt,
    agentId,
  });
  try {
    mkdirSync(primary, { recursive: true });
    execFileSync('git', ['init', '--quiet', '-b', 'main'], {
      cwd: primary,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        // Disposable sandbox repo, never pushed or shared: disable commit
        // signing rather than depend on this host's interactive GPG/SSH
        // signing setup, which a non-interactive test run cannot satisfy.
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'root',
      ],
      { cwd: primary, stdio: 'ignore', env: gitEnv },
    );
    execFileSync('git', ['worktree', 'add', '-b', branch, secondary], {
      cwd: primary,
      stdio: 'ignore',
    });
    acquireClaimLock(secondary, agentId, claimId, false);
    recordGeneratedClaimTokens(secondary, {
      agentId,
      claimId,
      nonce: 'nonce-worktree-flag-e2e',
    });

    const result = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
        '--issue',
        '1',
        '--owner',
        'o',
        '--repo',
        'r',
        '--now',
        '2026-09-24T00:01:00Z',
        '--policy',
        fixture.policyPath,
        '--claim-id',
        claimId,
        '--worktree',
        secondary,
      ],
      {
        cwd: primary,
        encoding: 'utf8',
        env: { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.state, 'already_owned');
    assert.equal(output.action, 'keep');
    assert.equal(output.reason, 'claim-id-match');
  } finally {
    fixture.restore();
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});
