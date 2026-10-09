import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireClaimLock,
  checkClaimLock,
  readGeneratedClaimTokens,
  recordGeneratedClaimTokens,
} from '../src/scripts/claim-lock.mts';
import {
  evaluateCurrentSessionOwnerEvidence,
  firstFailedOwnerProof,
  isCurrentSessionWorktreeOwner,
  resolveCurrentSessionClaimEvidence,
} from '../src/scripts/discover-roadmap-graph.mts';
import {
  inspectLocalWorktreeBranch,
  type LocalWorktreeInspection,
} from '../src/scripts/local-worktree-occupancy.mts';
import {
  DEFAULT_STALE_AGE_MS,
  resolveActiveClaimForWriteGate as resolveActiveClaimForWriteGateImpl,
  summarizeClaimValidation as summarizeClaimValidationImpl,
} from '../src/scripts/protocol-helpers.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import type { ProviderPort } from '../src/scripts/provider-port.mts';
import {
  buildForcedHandoffEnabledGate,
  evaluateFreshClaimGate as evaluateFreshClaimGateImpl,
  evaluateResumeClaimRouting as evaluateResumeClaimRoutingImpl,
  fetchOpenLinkedPrReferences,
  loadPolicy,
  resolveAssertOutcome,
  resolveResumeLinkedPrState,
} from '../src/scripts/resume-claim-routing.mts';
import { stubExecutable } from './test-utils.mts';

function trusted(logins: string[]) {
  const set = new Set(logins);
  return (login: string) => set.has(login);
}

function withClaimEditState(events: unknown): unknown {
  if (!Array.isArray(events)) return events;
  return events.map((event) => {
    if (event === null || typeof event !== 'object') return event;
    const record = event as Record<string, unknown>;
    return 'lastEditedAt' in record || 'last_edited_at' in record
      ? event
      : { ...record, lastEditedAt: null };
  });
}

function evaluateResumeClaimRouting(
  input: Parameters<typeof evaluateResumeClaimRoutingImpl>[0],
  options?: Parameters<typeof evaluateResumeClaimRoutingImpl>[1],
): ReturnType<typeof evaluateResumeClaimRoutingImpl> {
  return evaluateResumeClaimRoutingImpl(
    {
      ...input,
      events: withClaimEditState(input.events) as typeof input.events,
    },
    options,
  );
}

function evaluateFreshClaimGate(
  input: Parameters<typeof evaluateFreshClaimGateImpl>[0],
  options?: Parameters<typeof evaluateFreshClaimGateImpl>[1],
): ReturnType<typeof evaluateFreshClaimGateImpl> {
  return evaluateFreshClaimGateImpl(
    {
      ...input,
      events: withClaimEditState(input.events) as typeof input.events,
    },
    options,
  );
}

function summarizeClaimValidation(
  events: Parameters<typeof summarizeClaimValidationImpl>[0],
  options: Parameters<typeof summarizeClaimValidationImpl>[1],
): ReturnType<typeof summarizeClaimValidationImpl> {
  return summarizeClaimValidationImpl(
    withClaimEditState(events) as typeof events,
    options,
  );
}

function resolveActiveClaimForWriteGate(
  events: Parameters<typeof resolveActiveClaimForWriteGateImpl>[0],
  options: Parameters<typeof resolveActiveClaimForWriteGateImpl>[1],
): ReturnType<typeof resolveActiveClaimForWriteGateImpl> {
  return resolveActiveClaimForWriteGateImpl(
    withClaimEditState(events) as typeof events,
    options,
  );
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

test('stale claim preserves an explicit absent local-worktree probe', () => {
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
        status: 'absent',
        paths: [],
        reason: null,
      }),
    },
  );

  assert.equal(result.state, 'stale');
  assert.equal(result.action, 'takeover');
  assert.equal(result.reason, 'active-claim-stale');
  assert.deepEqual(result.evidence.local_worktree, {
    status: 'absent',
    paths: [],
    reason: null,
  });
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
  // A new lock is refused on the primary worktree. The named evidence
  // path is a linked worktree checked out at the claim's branch.
  const primary = mkdtempSync(join(tmpdir(), 'idd-resume-worktree-evidence-'));
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  const unrelatedCwd = mkdtempSync(join(tmpdir(), 'idd-resume-unrelated-cwd-'));
  const claimId = 'claim-worktree-evidence';
  const branch = 'issue/42-task';
  const originalCwd = process.cwd();
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'idd-test',
    GIT_AUTHOR_EMAIL: 'idd-test@example.com',
    GIT_COMMITTER_NAME: 'idd-test',
    GIT_COMMITTER_EMAIL: 'idd-test@example.com',
  };
  try {
    execFileSync('git', ['init', '--quiet', '-b', 'main'], {
      cwd: primary,
      stdio: 'ignore',
    });
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'seed',
      ],
      { cwd: primary, stdio: 'ignore', env: gitEnv },
    );
    execFileSync(
      'git',
      ['worktree', 'add', '--quiet', '-b', branch, worktree, 'main'],
      { cwd: primary, stdio: 'ignore' },
    );
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
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktree], {
        cwd: primary,
        stdio: 'ignore',
      });
    } catch {
      // best-effort; rmSync below still runs
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
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

test('edited trusted legacy release is ignored and leaves the claim active', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T12:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T08:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T08:00:00Z branch: issue/14-task -->',
          lastEditedAt: null,
        },
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- unclaimed-by: old-agent 2026-05-12T09:00:00Z -->',
          lastEditedAt: '2026-05-12T09:05:00Z',
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'legacy-claim-non-stale');
  assert.equal(result.active_claim?.agent_id, 'old-agent');
});

test('snake_case edit state is accepted for a trusted legacy claim', () => {
  const result = evaluateResumeClaimRouting(
    {
      now: '2026-05-12T10:00:00Z',
      events: [
        {
          createdAt: '2026-05-12T09:00:00Z',
          author: { login: 'maintainer' },
          body: '<!-- claimed-by: old-agent 2026-05-12T09:00:00Z branch: issue/15-task -->',
          lastEditedAt: undefined,
          last_edited_at: null,
        },
      ],
    },
    { isTrustedAuthor: trusted(['maintainer']) },
  );

  assert.equal(result.state, 'non_inheritable');
  assert.equal(result.reason, 'legacy-claim-non-stale');
  assert.equal(result.active_claim?.agent_id, 'old-agent');
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
  const result = fetchOpenLinkedPrReferences(port, 11, 'kurone-kito/idd-skill');
  assert.equal(result.lookupFailed, false);
  assert.deepEqual([...result.references], ['77']);
});

test('fetchOpenLinkedPrReferences reports lookupFailed: true (not an empty successful result) when a page throws', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPageErrors: { 11: 'simulated gh failure' },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, 'kurone-kito/idd-skill');
  assert.equal(result.lookupFailed, true);
  assert.equal(result.references.size, 0);
});

test('fetchOpenLinkedPrReferences reports lookupFailed: true on an incomplete page (hasNextPage with no endCursor)', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [{ events: [], hasNextPage: true, endCursor: null }],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, 'kurone-kito/idd-skill');
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
  const result = fetchOpenLinkedPrReferences(port, 11, 'kurone-kito/idd-skill');
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
  const result = fetchOpenLinkedPrReferences(port, 11, 'kurone-kito/idd-skill');
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
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
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
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
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
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('databaseId'))) {
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        pullRequest: null,
      },
    },
  }));
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
      node_id: 'IC_linked_claim',
      body: '<!-- claimed-by: copilot claim-old supersedes: none 2026-05-12T10:00:00Z branch: issue/11-task -->',
      created_at: '2026-05-12T10:00:00Z',
      user: { login: 'maintainer' },
    },
    {
      id: 2,
      node_id: 'IC_linked_handoff',
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
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('databaseId'))) {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: comments.map((row) => ({
                id: row.node_id,
                databaseId: row.id,
                body: row.body,
                createdAt: row.created_at,
                updatedAt: row.created_at,
                lastEditedAt: null,
                author: { login: row.user.login, __typename: 'User' },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          pullRequest: null,
        },
      },
    }),
  )});
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => /nodes\\(ids/.test(arg))) {
  process.stdout.write(JSON.stringify({ data: { nodes: [
    { id: 'IC_linked_claim', lastEditedAt: null },
    { id: 'IC_linked_handoff', lastEditedAt: null },
  ] } }));
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
  activationNonce,
}: {
  policyTrustedMarkerActors?: string[];
  commentLogin: string;
  claimId: string;
  branch: string;
  createdAt: string;
  agentId?: string;
  // #3480: an optional trusted `activation-nonce` marker comment, appended
  // after the `claimed-by` comment, for a test proving the nonce
  // comparison itself agrees (not merely that it is silently skipped when
  // no nonce is posted at all -- the pre-existing AC3 backward-compat
  // path).
  activationNonce?: { nonce: string; createdAt: string };
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
  const nonceCommentJson = activationNonce
    ? JSON.stringify({
        id: 2,
        node_id: 'IC_trust_ladder_nonce',
        body: `<!-- activation-nonce: ${agentId} ${claimId} ${activationNonce.nonce} ${activationNonce.createdAt} -->`,
        created_at: activationNonce.createdAt,
        updated_at: activationNonce.createdAt,
        user: { login: commentLogin },
      })
    : null;
  const commentPayloadsJs = JSON.stringify(
    [commentJson, nonceCommentJson].filter(
      (payload): payload is string => payload !== null,
    ),
  );
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
const commentPayloads = ${commentPayloadsJs};
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('viewer-login\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('databaseId'))) {
  const nodes = commentPayloads.map((payload) => {
    const row = JSON.parse(payload);
    return {
      id: row.node_id,
      databaseId: row.id,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
      lastEditedAt: null,
      author: { login: row.user.login, __typename: 'User' },
    };
  });
  process.stdout.write(JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
        pullRequest: null,
      },
    },
  }));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => /nodes\\(ids/.test(arg))) {
  // #3480: generalized from a single hard-coded 'IC_trust_ladder' node so
  // an optional second (activation-nonce) comment's node_id also resolves
  // -- echoes back whichever ids fetchLastEditedAtByNodeId actually
  // requested, in the same order, each with a null lastEditedAt (never
  // edited).
  const requestedIds = args
    .filter((arg) => /^ids\\[\\]=/.test(arg))
    .map((arg) => arg.slice('ids[]='.length));
  process.stdout.write(JSON.stringify({
    data: { nodes: requestedIds.map((id) => ({ id, lastEditedAt: null })) },
  }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/1\\/comments/.test(arg))) {
  process.stdout.write(commentPayloads.map((payload) => payload + '\\n').join(''));
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

// #3480: "network-free contract test" for Resume Step 1's own documented
// `resume-claim-routing.mjs` invocation, extending the same idea
// `idd-template/docs/idd-design-rationale.md` already coins for bot-comment
// wording classifiers to an instruction file's own documented CLI
// invocation. Issue #3273 fixed the drift this catches: at commit
// `fa49fb6c` Step 1's documented invocation never threaded
// `--claim-id`/`--nonce`/`--worktree`, so a session holding its own
// verified claim could never reach `already_owned` through the
// *documented* call, even though `evaluateResumeClaimRouting` already
// handled those flags correctly when a caller passed them directly.

const STEP_ONE_OWN_CLAIM_FLAGS = [
  '--claim-id',
  '--nonce',
  '--worktree',
] as const;
type StepOneOwnClaimFlag = (typeof STEP_ONE_OWN_CLAIM_FLAGS)[number];

/**
 * Parses a `.instructions.md` file's text (real file content, or a test
 * fixture string) and reports which of `--claim-id`, `--nonce`,
 * `--worktree` its `## Step 1` section documents appending to the
 * `resume-claim-routing.mjs --issue` invocation, for a session that
 * already holds a recorded, verified, active claim-id for the issue.
 *
 * This is a behavioral drift check, not a hand-copy of today's wording: a
 * later edit to Step 1's own text is what actually drives the result, so
 * token detection only ever looks at literal invocation lines -- a line
 * naming both `resume-claim-routing.mjs` and `--issue` -- never at
 * unrelated prose. Scoping to invocation lines specifically (rather than
 * `includes()` over the whole section) matters: `idd-resume.instructions.md`
 * itself still mentions a bare `--claim-id` and a bare `--worktree` in two
 * unrelated forced-handoff-retry/owner-evidence-retry sentences within the
 * same section, and the real pre-#3273 wording (commit `fa49fb6c`) already
 * mentioned a `--claim-id` forced-handoff retry even though Step 1's own
 * invocation never threaded it -- a prose-wide search would have reported
 * a false positive on that historical, already-broken wording.
 *
 * Step 1's own heading-to-heading span (its heading through the line
 * before the next `## ` heading, or end of text) is checked *first* and
 * preferred whenever it contains at least one invocation line -- a line
 * naming both `resume-claim-routing.mjs` and `--issue`. Only when Step
 * 1's own span contains *no* invocation line at all does the search widen
 * to the *nearest preceding* invocation line before Step 1 (not every
 * matching line in the widened range): `idd-resume-lite.instructions.md`'s
 * own Step 1 section deliberately says "run the Claim-state command
 * above" instead of repeating the invocation, so the flags it documents
 * live on the one invocation line immediately above Step 1, never inside
 * Step 1's own span and never on some other, possibly-unrelated
 * invocation line further back in the file.
 *
 * Two precision-gap fixes landed here, both from Copilot review on
 * #3480: preferring Step 1's own span first closes the original,
 * unconditionally-widened design's gap, where unioning flags from every
 * matching invocation line in the widened range regardless of where it
 * fell would have let a stale, flag-less invocation line inserted
 * directly inside Step 1's own body hide behind an unrelated,
 * still-correct invocation earlier in that same range. Narrowing the
 * fallback to only the nearest preceding line (rather than still
 * unioning every match before Step 1) closes a second, symmetric gap:
 * an older full-flag invocation added earlier in the file could
 * otherwise mask a real flag drop on the line actually immediately
 * above Step 1 -- the one lite's own "above" wording actually refers
 * to.
 *
 * Step 1's own span is likewise narrowed to only its *first* invocation
 * line rather than a union of every match inside the span (Codex review,
 * #3480) -- the same masking risk, symmetrically, in case a later,
 * fully-spelled-out example line ever appears in the same span.
 *
 * "Nearest preceding" excludes a `--fresh-claim-gate` invocation line:
 * `idd-resume-lite.instructions.md`'s real "Always run helpers first"
 * section documents that fresh-claim-gate form on its own line
 * immediately *below* the actual Claim-state command this parser needs
 * -- textually nearer to Step 1 than the Claim-state command is. That
 * form is a categorically different `resume-claim-routing.mjs` mode
 * (Step 1's own file already documents that it "ignores any
 * `--claim-id`" by design), so it can never be the invocation Step 1's
 * own "run the command above" prose refers to, and including it in the
 * nearest-preceding candidate pool would silently pick the wrong line.
 *
 * Every specific-token check here -- the three own-claim flags, the
 * `--issue`/`--fresh-claim-gate` tokens used to select invocation lines
 * in the first place, and the helper executable name -- matches a
 * complete whitespace-separated token, tolerant of the
 * `[--flag {value}]`/`[--flag <value>]` bracket form both live files
 * use, not a plain substring check (Copilot/Codex review, #3480 and
 * #3533, across many rounds summarized below).
 *
 * **Design history (why this is tokenized, not one regex per check).**
 * The original implementation matched each token with its own
 * hand-written regex (a word-boundary lookbehind/lookahead pair per
 * flag, a separate pair for the helper filename, a separate alternation
 * for the operand placeholder). Six review rounds across #3480 and
 * #3533 (Copilot and a Codex bot, plus internal self-critique) each
 * found a new false-positive shape that regex design let through --
 * `.includes()` substring matches (round 1); a negative
 * exclusion-class boundary that could never enumerate every character
 * that continues a shell word or documentation token, found and
 * "fixed" one side at a time only to leak on the opposite,
 * still-unconverted side of the same check (rounds 2-5: operand
 * placeholder suffix, filename suffix, filename prefix, flag-name
 * prefix, `--issue`/`--fresh-claim-gate` line-selection); and finally
 * an unpaired-bracket corruption (round 6) where "allow a bare flag"
 * and "allow a `]`-closed bracketed flag" were each individually
 * correct as independent lookbehind/lookahead assertions, but their
 * combination accepted a flag opened without a bracket yet closed with
 * one (or the reverse) -- a class of bug regex lookaround cannot
 * express a fix for, since lookaround assertions can't correlate two
 * positions in the string with each other.
 *
 * The fix is structural, not another lookaround patch: split each line
 * on whitespace first, then compare whole tokens with `===`/`.endsWith()`
 * and validate each flag/operand *pair* together as a single unit. This
 * makes an entire prior bug class structurally unrepresentable --
 * exact string/array equality has no "boundary class" to enumerate
 * incompletely, and a flag/operand pair is validated as one coupled
 * unit instead of two independently-satisfiable assertions, so a
 * bracket opened on one side and closed as a different token spacing
 * can no longer combine into a false accept.
 */
function parseStepOneOwnClaimFlags(
  instructionsText: string,
): ReadonlySet<StepOneOwnClaimFlag> {
  const lines = instructionsText.split(/\r?\n/);
  const stepOneIndex = lines.findIndex((line) => line.startsWith('## Step 1'));
  if (stepOneIndex === -1) {
    throw new Error(
      'parseStepOneOwnClaimFlags: no "## Step 1" heading found in the given text',
    );
  }
  let sectionEnd = lines.length;
  for (let index = stepOneIndex + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) {
      sectionEnd = index;
      break;
    }
  }
  // Tokenize on whitespace runs so every check below compares whole
  // tokens (`===`/`.endsWith()`), never a regex boundary assertion --
  // see the design-history comment above for why.
  const tokenize = (line: string): readonly string[] =>
    line.split(/\s+/).filter((token) => token.length > 0);
  const isPlaceholderToken = (token: string): boolean =>
    /^\{[^\s{}<>]+\}$/.test(token) || /^<[^\s{}<>]+>$/.test(token);
  // Exact-token membership test for `--issue`/`--fresh-claim-gate`
  // (line selection) -- a corrupted `--issue.bak`, a glued
  // `{issue}--issue`, or an `--issue-number` edit is simply a different
  // string than `--issue` once split on whitespace, so no boundary
  // reasoning is needed at all.
  const hasExactToken = (line: string, token: string): boolean =>
    tokenize(line).includes(token);
  // For a given own-claim flag, find a token that is either the bare
  // flag name or `[`-prefixed, then require the very next token to be a
  // matching-form operand: a bare placeholder for the bare flag, or a
  // placeholder immediately closed with `]` for the bracketed flag.
  // Validating the flag/operand pair as one coupled unit (instead of
  // independently matching "is the flag preceded by `[`" and "is the
  // operand followed by `]`") is what actually closes the unpaired-
  // bracket class of corruption: a bracket opened on one side can no
  // longer combine with an unrelated bracket closing the other, because
  // there is only one bracketed alternative and it requires both
  // together. The bare form additionally rejects a stray `[`/`]` token
  // immediately adjacent (space-separated) to the flag or operand, so a
  // malformed extra space inside the bracket convention (`[ --claim-id
  // {claim-id}`) can't decouple into "flag looks bare, ignore the
  // nearby bracket".
  const hasOperandAfterToken = (line: string, flag: string): boolean => {
    const tokens = tokenize(line);
    for (let index = 0; index < tokens.length; index += 1) {
      const current = tokens[index];
      const next = tokens[index + 1];
      if (next === undefined) continue;
      if (current === `[${flag}`) {
        const closed = /^(.+)\]$/.exec(next);
        if (closed && isPlaceholderToken(closed[1])) return true;
        continue;
      }
      if (current === flag) {
        if (tokens[index - 1] === '[') continue;
        if (!isPlaceholderToken(next)) continue;
        if (tokens[index + 2] === ']') continue;
        return true;
      }
    }
    return false;
  };
  // Exact-or-path-suffix membership test for the helper filename: a
  // token qualifies only by being exactly `resume-claim-routing.mjs` or
  // ending in `/resume-claim-routing.mjs`, so `.mjs.bak`, `.mjs/backup`,
  // `.mjs~`, `+resume-claim-routing.mjs`, and `legacy-resume-claim-
  // routing.mjs` are all simply different strings that fail both
  // comparisons -- again, no boundary-character reasoning required.
  const HELPER_SCRIPT_NAME = 'resume-claim-routing.mjs';
  const isExactHelperScriptToken = (line: string): boolean =>
    tokenize(line).some(
      (token) =>
        token === HELPER_SCRIPT_NAME ||
        token.endsWith(`/${HELPER_SCRIPT_NAME}`),
    );
  const isInvocationLine = (line: string): boolean =>
    isExactHelperScriptToken(line) && hasExactToken(line, '--issue');
  const isFreshClaimGateLine = (line: string): boolean =>
    hasExactToken(line, '--fresh-claim-gate');
  const ownSpanInvocationLines = lines
    .slice(stepOneIndex, sectionEnd)
    .filter(isInvocationLine);
  let invocationLines: readonly string[];
  if (ownSpanInvocationLines.length > 0) {
    // Use only the first (primary) invocation line Step 1's own span
    // introduces, not a union of every match in the span: a later,
    // fully-spelled-out example elsewhere in the same span (e.g. a
    // forced-handoff retry re-typed in full) could otherwise mask a
    // dropped flag on the actual primary invocation the same way an
    // unrelated earlier line could in the fallback branch below.
    invocationLines = [ownSpanInvocationLines[0]];
  } else {
    const precedingInvocationLines = lines
      .slice(0, stepOneIndex)
      .filter((line) => isInvocationLine(line) && !isFreshClaimGateLine(line));
    const nearestPreceding =
      precedingInvocationLines[precedingInvocationLines.length - 1];
    invocationLines = nearestPreceding === undefined ? [] : [nearestPreceding];
  }
  const found = new Set<StepOneOwnClaimFlag>();
  for (const line of invocationLines) {
    for (const flag of STEP_ONE_OWN_CLAIM_FLAGS) {
      if (hasOperandAfterToken(line, flag)) {
        found.add(flag);
      }
    }
  }
  return found;
}

test("parseStepOneOwnClaimFlags finds all three own-claim flags in idd-resume.instructions.md's live Step 1 (#3480)", () => {
  const text = readFileSync(
    join(REPO_ROOT, '.github/instructions/idd-resume.instructions.md'),
    'utf8',
  );
  const found = parseStepOneOwnClaimFlags(text);
  assert.deepEqual([...found].sort(), ['--claim-id', '--nonce', '--worktree']);
});

test("parseStepOneOwnClaimFlags finds all three own-claim flags in idd-resume-lite.instructions.md's live Step 1 (#3480)", () => {
  const text = readFileSync(
    join(
      REPO_ROOT,
      '.github/instructions/lite/idd-resume-lite.instructions.md',
    ),
    'utf8',
  );
  const found = parseStepOneOwnClaimFlags(text);
  assert.deepEqual([...found].sort(), ['--claim-id', '--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags reports all three own-claim flags missing against the real pre-#3273 wording (#3480)', () => {
  // Faithfully trimmed from the real `idd-resume.instructions.md` Step 1
  // section at commit `fa49fb6c` (the SHA #3273's own background cites):
  // the invocation line carries no flags at all, and the only other
  // mention of any of these three tokens anywhere in the section is the
  // unrelated forced-handoff-retry sentence's bare `--claim-id` -- kept
  // here deliberately so this case also proves that mention alone does
  // not produce a false positive.
  const preIssue3273Fixture = `## Step 1 — Identify claim state

When helper runtime is enabled, you may collect Step 1 evidence with:

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number}
\`\`\`

Use helper output as evidence mapped to this table, not as an
authoritative replacement:

- \`state: already_owned\` + \`action: keep\` → continue with the same
  \`{claim-id}\` route.

A \`non_inheritable\`/\`stop\` verdict whose \`evidence.forced_handoff\` is
non-null (#2178) means a valid successor pair already exists — retry
with \`--claim-id <evidence.forced_handoff.new_claim_id>\` before
concluding the claim is not inheritable.

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(preIssue3273Fixture);
  assert.deepEqual([...found], []);
});

test('parseStepOneOwnClaimFlags reports a bare own-claim flag as missing when no operand placeholder follows it (#3533)', () => {
  // `--claim-id` here is immediately followed by another bracketed
  // `[--flag ...]` group, not a `{value}`/`<value>` placeholder --
  // deliberately not "nothing after it at all", so this also proves the
  // check reads the actual next token rather than merely "the line has
  // more text after the flag". `--nonce` and `--worktree` both keep
  // well-formed placeholders, so a pass here can only come from the
  // operand check itself, not from the line failing to be selected as
  // an invocation at all (PR #3531 review comment
  // https://github.com/kurone-kito/idd-skill/pull/3531#discussion_r4112343330).
  const bareOperandFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number} --claim-id [--nonce {nonce}] [--worktree {path}]
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(bareOperandFixture);
  assert.deepEqual([...found].sort(), ['--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags does not select a corrupted helper filename as a Step 1 invocation (#3533)', () => {
  // The only invocation-shaped candidate anywhere in this fixture names
  // `resume-claim-routing.mjs.bak`, carrying `--issue` and all three
  // own-claim flags with well-formed operands -- if `isInvocationLine`
  // ever regressed to a plain substring check, this line would still be
  // selected and every flag would report present. There is no other
  // invocation-shaped line before Step 1 either, so the fallback
  // "nearest preceding" branch has nothing to mask a wrong result with
  // (PR #3531 review comment
  // https://github.com/kurone-kito/idd-skill/pull/3531#discussion_r4112412098).
  const corruptedFilenameFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs.bak --issue {issue-number} --claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(corruptedFilenameFixture);
  assert.deepEqual([...found], []);
});

test('parseStepOneOwnClaimFlags reports an own-claim flag as missing when its operand placeholder carries a stray trailing suffix (#3533)', () => {
  // `{claim-id}.bak` is a well-formed placeholder *prefix* followed by
  // stray text -- a naive placeholder regex with no anchor after its own
  // closing brace still matches the `{claim-id}` substring and reports
  // the flag present. `--nonce`/`--worktree` both keep clean placeholders
  // with no trailing suffix, so a pass here can only come from the
  // operand-boundary check itself, not from the line failing to be
  // selected as an invocation at all (Codex review, PR #3537, round 2).
  const trailingSuffixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number} --claim-id {claim-id}.bak --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(trailingSuffixFixture);
  assert.deepEqual([...found].sort(), ['--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags does not select a helper filename with a stray trailing suffix as a Step 1 invocation (#3533)', () => {
  // Two corrupted-filename shapes a *negative* lookahead exclusion class
  // can never fully enumerate (Codex review, PR #3537, round 2): a
  // path-continuing `/backup` suffix, and a shell-tilde `~` suffix.
  // Neither `/` nor `~` was ever in the original `[\w.-]` exclusion
  // class, so both slipped through the same way `.bak` did before
  // #3531's own fix -- exactly the same false-positive-drift risk this
  // whole parser exists to close. Each fixture is otherwise identical to
  // the `.bak` corrupted-filename fixture above (well-formed `--issue`
  // and all three own-claim flags, no other invocation-shaped line
  // anywhere earlier), so a pass proves the filename-delimiter check
  // alone rejects the line.
  const pathSuffixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs/backup --issue {issue-number} --claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  assert.deepEqual([...parseStepOneOwnClaimFlags(pathSuffixFixture)], []);

  const tildeSuffixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs~ --issue {issue-number} --claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  assert.deepEqual([...parseStepOneOwnClaimFlags(tildeSuffixFixture)], []);
});

test('parseStepOneOwnClaimFlags does not select a helper filename with a stray leading prefix as a Step 1 invocation (#3533)', () => {
  // The symmetric gap to the trailing-suffix test above, on the
  // filename check's *lookbehind* instead of its lookahead (Codex
  // review, PR #3537, round 3): `+` and `~` were never in the original
  // `[\w.-]` exclusion class either, so `scripts/+resume-claim-
  // routing.mjs` and `scripts/~resume-claim-routing.mjs` both still
  // passed as an exact token match. Each fixture is otherwise identical
  // to the trailing-suffix fixtures (well-formed `--issue` and all
  // three own-claim flags, no other invocation-shaped line anywhere
  // earlier).
  const plusPrefixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/+resume-claim-routing.mjs --issue {issue-number} --claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  assert.deepEqual([...parseStepOneOwnClaimFlags(plusPrefixFixture)], []);

  const tildePrefixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/~resume-claim-routing.mjs --issue {issue-number} --claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  assert.deepEqual([...parseStepOneOwnClaimFlags(tildePrefixFixture)], []);
});

test('parseStepOneOwnClaimFlags reports an own-claim flag as missing when its bracketed placeholder carries a stray trailing suffix (#3533)', () => {
  // The symmetric gap to the bare-placeholder-suffix test above, one
  // layer deeper: `[--claim-id {claim-id}].bak` has a well-formed
  // placeholder *and* a well-formed closing `]`, but stray text after
  // that bracket (Codex review, PR #3537, round 3) -- the prior fix's
  // `(?=[\s\]]|$)` lookahead only checked for the bracket's presence,
  // not what followed it. `--nonce`/`--worktree` both keep clean
  // `[--flag {value}]` groups with nothing appended, so a pass here can
  // only come from the boundary-after-`]` check itself.
  const bracketSuffixFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number} [--claim-id {claim-id}].bak [--nonce {nonce}] [--worktree {path}]
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(bracketSuffixFixture);
  assert.deepEqual([...found].sort(), ['--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags reports an own-claim flag as missing when its own name is glued to preceding text with no separating whitespace (#3533)', () => {
  // The symmetric gap to the earlier suffix-corruption tests, on the
  // flag *name*'s own opening boundary instead of the placeholder's
  // closing one (self-critique, round 4): `{issue-number}--claim-id`
  // (a dropped space -- a realistic doc-edit slip, not a contrived
  // string) previously still matched, because reusing `hasExactToken`'s
  // negative-class lookbehind treated `}` as an acceptable preceding
  // character the same way `/`/`~`/`+` were acceptable to the
  // filename check before rounds 2-3 fixed those. `--nonce`/`--worktree`
  // both stay normally whitespace-separated, so a pass here can only
  // come from the flag-name boundary check itself.
  const gluedFlagNameFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number}--claim-id {claim-id} --nonce {nonce} --worktree {path}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(gluedFlagNameFixture);
  assert.deepEqual([...found].sort(), ['--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags does not let a corrupted `--issue` token select the wrong line as the Step 1 invocation (#3533)', () => {
  // A materially different failure mode from every fixture above (self-
  // critique, round 5): those all proved a *selected* invocation line's
  // own-claim flags were validated correctly. This proves *which line
  // gets selected* in the first place is also correct. `hasExactToken`
  // drives `isInvocationLine`'s `--issue` check, so its own
  // pre-round-5 negative-class boundary let a corrupted `--issue.bak`
  // token still count as a valid `--issue` match -- meaning a flagless
  // decoy line inside Step 1's own span (real filename, corrupted
  // `--issue`) could outrank a real, fully-flagged invocation line
  // sitting earlier in the file, silently reporting every own-claim
  // flag missing even though a correct command exists. Placing the real
  // invocation *before* `## Step 1` and the decoy *inside* Step 1's own
  // span exercises the "own span preferred over nearest-preceding"
  // selection rule directly: if the decoy still qualified as an
  // invocation line, it would win outright (own span is checked first),
  // masking the real line's flags entirely.
  const wrongLineSelectionFixture = `node scripts/resume-claim-routing.mjs --issue {issue-number} [--claim-id {claim-id}] [--nonce {nonce}] [--worktree {path}]

## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue.bak {issue-number}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(wrongLineSelectionFixture);
  assert.deepEqual([...found].sort(), ['--claim-id', '--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags does not let a glued-prefix `--issue` token select the wrong line as the Step 1 invocation (#3533)', () => {
  // The symmetric gap to the fixture above, on `hasExactToken`'s
  // *lookbehind* instead of its lookahead (self-critique, round 5,
  // second pass): `{foo}--issue {issue-number}` has a real, uncorrupted
  // filename and a real `--issue` token immediately glued to preceding
  // text with no separating whitespace -- the pre-round-5 negative-class
  // lookbehind treated `}` as an acceptable preceding character the same
  // way it treated every other non-`[\w-]` character, so this decoy
  // would have outranked the real invocation the same way the
  // corrupted-suffix decoy above did. Same fixture shape as above: real
  // invocation before `## Step 1`, decoy inside Step 1's own span.
  const wrongLineSelectionPrefixFixture = `node scripts/resume-claim-routing.mjs --issue {issue-number} [--claim-id {claim-id}] [--nonce {nonce}] [--worktree {path}]

## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs {foo}--issue {issue-number}
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(wrongLineSelectionPrefixFixture);
  assert.deepEqual([...found].sort(), ['--claim-id', '--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags reports an own-claim flag as missing when it has a closing bracket with no matching opening bracket (#3533)', () => {
  // A different shape from every fixture above (Copilot review, PR
  // #3537, round 6): `--claim-id {claim-id}]` is a *bare* (unbracketed)
  // flag mention whose placeholder is followed by a stray closing `]`
  // with no opening `[` anywhere before the flag. The round-2 fix's
  // `]`-closing alternative accepted any closing `]` regardless of
  // whether the flag was ever opened with a matching `[`, so this
  // unpaired-bracket corruption still passed even though it is exactly
  // as malformed as the earlier `.bak`-suffix corruptions.
  // `--nonce`/`--worktree` both stay correctly bracketed (matching
  // opener and closer), so a pass here can only come from the
  // bracket-pairing check itself.
  const unmatchedBracketFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number} --claim-id {claim-id}] [--nonce {nonce}] [--worktree {path}]
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(unmatchedBracketFixture);
  assert.deepEqual([...found].sort(), ['--nonce', '--worktree']);
});

test('parseStepOneOwnClaimFlags reports an own-claim flag as missing when a stray bracket is space-separated from the flag or placeholder (#3533)', () => {
  // A redesign-time self-critique adversarial pass found this before any
  // external reviewer did: a malformed extra space inside the optional-
  // bracket convention -- `[ --claim-id {claim-id}` (space after the
  // opening bracket) or `--claim-id {claim-id} ]` (space before the
  // closing bracket) -- makes the stray `[`/`]` its own separate
  // whitespace-delimited token, so the flag or placeholder token itself
  // looks bare even though a bracket sits immediately adjacent. Both
  // shapes are exercised in one fixture; `--worktree` stays cleanly
  // bracketed throughout as the control.
  const spaceSeparatedBracketFixture = `## Step 1 — Identify claim state

\`\`\`sh
node scripts/resume-claim-routing.mjs --issue {issue-number} [ --claim-id {claim-id}] --nonce {nonce} ] [--worktree {path}]
\`\`\`

## Step 2 — Locate or restore worktree
`;
  const found = parseStepOneOwnClaimFlags(spaceSeparatedBracketFixture);
  assert.deepEqual([...found].sort(), ['--worktree']);
});

test("own-claim CLI proof reusing Step 1's own parsed flags (#3480): --worktree present is already_owned, omitted is owner_evidence_required", () => {
  // Reuses this test file's existing "--worktree end-to-end" sandbox
  // technique (#3272) -- a real second git worktree next to a disposable
  // sandbox repo, carrying a matching claim lock and generated-tokens
  // record -- but assembles argv from parseStepOneOwnClaimFlags's own
  // output against the live idd-resume.instructions.md text, instead of
  // hand-typing the CLI flags. This proves Step 1's *documented*
  // invocation itself, not just the CLI's own already-tested flag
  // handling, reaches `already_owned`/`keep` for a session holding its
  // own claim, and `owner_evidence_required`/`stop` -- not a
  // `non_inheritable` live-competitor stop -- once `--worktree` is no
  // longer part of that same argv (Resume Step 1 running before Step 2
  // locates the worktree, the precise gap issue #3272 fixed).
  const stepOneInstructionsText = readFileSync(
    join(REPO_ROOT, '.github/instructions/idd-resume.instructions.md'),
    'utf8',
  );
  const parsedFlags = parseStepOneOwnClaimFlags(stepOneInstructionsText);
  assert.deepEqual([...parsedFlags].sort(), [
    '--claim-id',
    '--nonce',
    '--worktree',
  ]);

  const sandboxRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-step1-own-claim-cli-'),
  );
  const primary = join(sandboxRoot, 'primary');
  const secondary = join(sandboxRoot, 'secondary');
  const branch = 'issue/2-task';
  const claimId = 'claim-step1-own-claim-cli';
  const agentId = 'agent-step1-own-claim-cli';
  const nonce = 'nonce-step1-own-claim-cli';
  const createdAt = '2026-09-24T00:00:00Z';
  const nonceCreatedAt = '2026-09-24T00:00:05Z';
  const nowIso = '2026-09-24T00:01:00Z';
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
    activationNonce: { nonce, createdAt: nonceCreatedAt },
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
    recordGeneratedClaimTokens(secondary, { agentId, claimId, nonce });

    const flagValues: Record<StepOneOwnClaimFlag, string> = {
      '--claim-id': claimId,
      '--nonce': nonce,
      '--worktree': secondary,
    };
    const baseArgs = [
      join(REPO_ROOT, 'scripts/resume-claim-routing.mjs'),
      '--issue',
      '1',
      '--owner',
      'o',
      '--repo',
      'r',
      '--now',
      nowIso,
      '--policy',
      fixture.policyPath,
    ];
    const spawnEnv = { ...process.env, IDD_TRUSTED_MARKER_ACTORS: '' };

    const withWorktreeArgs = [
      ...baseArgs,
      ...[...parsedFlags].flatMap((flag) => [flag, flagValues[flag]]),
    ];
    const withWorktree = spawnSync(process.execPath, withWorktreeArgs, {
      cwd: primary,
      encoding: 'utf8',
      env: spawnEnv,
    });
    assert.equal(withWorktree.status, 0, withWorktree.stderr);
    const withWorktreeOutput = JSON.parse(withWorktree.stdout);
    assert.equal(withWorktreeOutput.state, 'already_owned');
    assert.equal(withWorktreeOutput.action, 'keep');
    // Also prove the nonce comparison itself agreed, not merely that it
    // was silently skipped (the pre-existing AC3 backward-compat path):
    // the trusted activation-nonce winner the CLI resolved must equal the
    // fixture's own posted nonce.
    assert.equal(withWorktreeOutput.evidence.activation_nonce_winner, nonce);

    // Reuses the exact same fixture -- the second worktree still exists on
    // disk and is still occupied -- but this time omits `--worktree` from
    // the CLI argv while still passing the parsed `--claim-id` (and
    // `--nonce`).
    const withoutWorktreeArgs = [
      ...baseArgs,
      ...[...parsedFlags]
        .filter((flag) => flag !== '--worktree')
        .flatMap((flag) => [flag, flagValues[flag]]),
    ];
    const withoutWorktree = spawnSync(process.execPath, withoutWorktreeArgs, {
      cwd: primary,
      encoding: 'utf8',
      env: spawnEnv,
    });
    assert.equal(withoutWorktree.status, 0, withoutWorktree.stderr);
    const withoutWorktreeOutput = JSON.parse(withoutWorktree.stdout);
    assert.equal(withoutWorktreeOutput.state, 'owner_evidence_required');
    assert.equal(withoutWorktreeOutput.action, 'stop');
  } finally {
    fixture.restore();
    rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

// A forced-handoff successor whose clone still holds the predecessor's
// worktree (kurone-kito/idd-skill#3645, docs/idd-resume-detail.md section FH).
// The fixture is the file's forced-handoff one with a distinct successor
// agent-id and an activation-nonce marker for the successor.

const SUCCESSOR_BRANCH = 'issue/11-task';
const SUCCESSOR_EVENTS = [
  {
    createdAt: '2026-05-12T10:00:00Z',
    author: { login: 'maintainer' },
    body: `<!-- claimed-by: agent-old claim-old supersedes: none 2026-05-12T10:00:00Z branch: ${SUCCESSOR_BRANCH} -->`,
  },
  {
    createdAt: '2026-05-12T10:01:00Z',
    author: { login: 'maintainer' },
    body: `<!-- forced-handoff: {"oldAgentId":"agent-old","oldClaimId":"claim-old","newAgentId":"agent-new","newClaimId":"claim-new","branch":"${SUCCESSOR_BRANCH}","forcedBy":"maintainer","reason":"handoff","timestamp":"2026-05-12T10:01:00Z","contextScope":"issue-only"} -->\n\n_maintainer: forced handoff — IDD automation marker. Do not edit._`,
  },
  {
    createdAt: '2026-05-12T10:02:00Z',
    author: { login: 'maintainer' },
    body: '<!-- activation-nonce: agent-new claim-new nonce-new 2026-05-12T10:02:00Z -->',
  },
];

// A git-config-file-safe null device: the Win32 device-namespace form of
// `devNull` cannot be opened as GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM by Git for
// Windows, the bare `NUL` name can (kurone-kito/idd-skill#2570).
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

/**
 * The fixture's git processes must never read the ambient git environment
 * (a hook can export GIT_DIR or GIT_INDEX_FILE) or the developer's config, the
 * same invariant tests/clone-lock.test.mts keeps.
 */
function hermeticGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) delete env[key];
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: GIT_NULL_DEVICE,
    GIT_CONFIG_SYSTEM: GIT_NULL_DEVICE,
    GIT_AUTHOR_NAME: 'idd-test',
    GIT_AUTHOR_EMAIL: 'idd-test@example.com',
    GIT_COMMITTER_NAME: 'idd-test',
    GIT_COMMITTER_EMAIL: 'idd-test@example.com',
  };
}

function gitIn(cwd: string, args: string[], env: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
}

/**
 * A sandbox git repository (the primary checkout) with a linked worktree on
 * the claimed branch and a lock plus generated-claim record left there by
 * the displaced predecessor, as a successor's clone would have them.
 */
function withSuccessorSandbox(
  body: (sandbox: {
    primary: string;
    worktree: string;
    env: NodeJS.ProcessEnv;
  }) => void,
): void {
  const primary = mkdtempSync(join(tmpdir(), 'idd-successor-primary-'));
  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  const env = hermeticGitEnv();
  try {
    gitIn(primary, ['init', '--quiet', '-b', 'main'], env);
    gitIn(primary, ['commit', '--quiet', '--allow-empty', '-m', 'seed'], env);
    gitIn(
      primary,
      ['worktree', 'add', '--quiet', '-b', SUCCESSOR_BRANCH, worktree, 'main'],
      env,
    );
    acquireClaimLock(worktree, 'agent-old', 'claim-old', false);
    recordGeneratedClaimTokens(worktree, {
      agentId: 'agent-old',
      claimId: 'claim-old',
      nonce: 'nonce-old',
    });
    body({ primary, worktree, env });
  } finally {
    try {
      gitIn(primary, ['worktree', 'remove', '--force', worktree], env);
    } catch {
      // best-effort; rmSync below still runs
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
  }
}

/** Routing as the successor runs it, with the real occupancy probe. */
function routeAsSuccessor(sandbox: { primary: string; worktree: string }) {
  const inspect = (branch: string) =>
    inspectLocalWorktreeBranch(branch, sandbox.primary);
  return evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      nonce: 'nonce-new',
      now: '2026-05-12T11:00:00Z',
      events: SUCCESSOR_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
      inspectLocalWorktree: inspect,
      isCurrentSessionOwner: (claim) => {
        const evidence = resolveCurrentSessionClaimEvidence(
          claim.claimId,
          sandbox.worktree,
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
          inspect(claim.branch),
        );
      },
    },
  );
}

function assertSuccessorStop(result: ReturnType<typeof routeAsSuccessor>) {
  assert.equal(result.state, 'owner_evidence_required');
  assert.equal(result.action, 'stop');
  assert.equal(
    result.reason,
    'claim-id-match-without-independent-owner-evidence',
  );
  assert.deepEqual(
    {
      old: result.evidence.forced_handoff?.old_claim_id,
      next: result.evidence.forced_handoff?.new_claim_id,
      agent: result.evidence.forced_handoff?.new_agent_id,
      winner: result.evidence.activation_nonce_winner,
    },
    {
      old: 'claim-old',
      next: 'claim-new',
      agent: 'agent-new',
      winner: 'nonce-new',
    },
  );
}

test('a forced-handoff successor turns the owner-evidence stop into already_owned by recording against the occupying worktree and taking the lock over (#3645)', () => {
  withSuccessorSandbox((sandbox) => {
    const { worktree } = sandbox;
    // The stop: the lock in the worktree still names the displaced claim and
    // no generated-claim record exists for the successor's claim-id.
    assertSuccessorStop(routeAsSuccessor(sandbox));

    // Recording the identity against the occupying worktree is not enough
    // while the lock still names the displaced claim.
    recordGeneratedClaimTokens(worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    assertSuccessorStop(routeAsSuccessor(sandbox));

    // The fresh-claim gate names the successor's claim as the winner, which
    // is what authorizes the takeover of a lock held by the displaced claim.
    const gate = evaluateFreshClaimGate(
      { now: '2026-05-12T11:00:00Z', events: SUCCESSOR_EVENTS },
      {
        isTrustedAuthor: trusted(['maintainer']),
        isForcedHandoffEnabled: () => true,
        isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
        inspectLocalWorktree: (branch) =>
          inspectLocalWorktreeBranch(branch, sandbox.primary),
      },
    );
    assert.equal(gate.verdict, 'already-claimed');
    assert.equal(gate.winningClaimId, 'claim-new');
    assert.equal(checkClaimLock(worktree).holder?.claimId, 'claim-old');

    const takeover = acquireClaimLock(worktree, 'agent-new', 'claim-new', true);
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.forcedTakeover, true);
    assert.equal(takeover.holder?.claimId, 'claim-old');

    const result = routeAsSuccessor(sandbox);
    assert.equal(result.state, 'already_owned');
    assert.equal(result.action, 'keep');
    assert.equal(result.reason, 'claim-id-match');
  });
});

test('a takeover after recording the identity against another worktree still stops with owner_evidence_required (#3645)', () => {
  withSuccessorSandbox((sandbox) => {
    // The claim docs record a fresh claim's identity in the primary checkout;
    // for a successor that lets the takeover succeed and routing still stops.
    recordGeneratedClaimTokens(sandbox.primary, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    const takeover = acquireClaimLock(
      sandbox.worktree,
      'agent-new',
      'claim-new',
      true,
    );
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.holder?.claimId, 'claim-old');
    // The lock now names the successor, but nothing was recorded in the
    // worktree the routing reads, so no owner evidence exists there.
    assert.equal(
      resolveCurrentSessionClaimEvidence('claim-new', sandbox.worktree),
      null,
    );
    assertSuccessorStop(routeAsSuccessor(sandbox));
  });
});

/**
 * Leave the sandbox worktree in a real conflicting rebase: the same new file
 * with different content on main and on the claimed branch. (A plain `git
 * checkout --detach` would make the probe report the branch absent, which
 * routes already_owned.)
 */
function leaveWorktreeMidRebase(sandbox: {
  primary: string;
  worktree: string;
  env: NodeJS.ProcessEnv;
}): void {
  const { primary, worktree, env } = sandbox;
  writeFileSync(join(primary, 'conflict.txt'), 'main\n');
  gitIn(primary, ['add', 'conflict.txt'], env);
  gitIn(primary, ['commit', '--quiet', '-m', 'main side'], env);
  writeFileSync(join(worktree, 'conflict.txt'), 'branch\n');
  gitIn(worktree, ['add', 'conflict.txt'], env);
  gitIn(worktree, ['commit', '--quiet', '-m', 'branch side'], env);
  assert.throws(() => gitIn(worktree, ['rebase', 'main'], env));
  const rebaseState = gitIn(
    worktree,
    ['rev-parse', '--git-path', 'rebase-merge'],
    env,
  ).trim();
  assert.equal(
    readdirSync(resolve(worktree, rebaseState)).length > 0,
    true,
    'expected the conflicting rebase to be left in progress',
  );
}

test('a takeover of a worktree the dead predecessor left mid-rebase still stops with owner_evidence_required (#3645)', () => {
  withSuccessorSandbox((sandbox) => {
    const { primary, worktree } = sandbox;
    leaveWorktreeMidRebase(sandbox);

    // The real probe still reports the branch occupied by this worktree (it
    // reads the rebase metadata); it is the detached HEAD that leaves the
    // session without owner evidence.
    const probe = inspectLocalWorktreeBranch(SUCCESSOR_BRANCH, primary);
    assert.equal(probe.status, 'occupied');

    recordGeneratedClaimTokens(worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    const takeover = acquireClaimLock(worktree, 'agent-new', 'claim-new', true);
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.holder?.claimId, 'claim-old');
    assert.equal(
      resolveCurrentSessionClaimEvidence('claim-new', worktree),
      null,
    );
    assertSuccessorStop(routeAsSuccessor(sandbox));
  });
});

// #3667: the owner proof, broken down by proof. `evaluateCurrentSessionOwnerEvidence`
// reports which of the six proofs failed while its `owner` verdict stays the
// one the boolean pair (`resolveCurrentSessionClaimEvidence` plus
// `isCurrentSessionWorktreeOwner`) gives.

const OWNER_PROOF_ORDER = [
  'worktree_identity',
  'claim_lock_matches',
  'generated_tokens_match',
  'agent_and_branch_match',
  'occupancy_probe',
  'occupancy_paths_match',
];

const SUCCESSOR_CLAIM = {
  claimId: 'claim-new',
  agentId: 'agent-new',
  branch: SUCCESSOR_BRANCH,
};

/**
 * The owner check as it ran before #3667, inlined as the oracle: one
 * fail-closed chain over worktree identity, claim lock and generated tokens,
 * then the same agent-id / branch / probe comparison the CLI made. It does
 * not call the staged function it is compared against.
 */
function booleanOwnerVerdict(
  claim: typeof SUCCESSOR_CLAIM,
  probe: LocalWorktreeInspection,
  worktree: string,
): boolean {
  try {
    const env = hermeticGitEnv();
    const git = (args: string[]) =>
      execFileSync('git', ['-C', worktree, ...args], {
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).replace(/\n$/, '');
    const worktreePath = realpathSync(git(['rev-parse', '--show-toplevel']));
    const branchName = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const lock = checkClaimLock(worktree);
    const holder = lock.holder;
    if (
      !worktreePath ||
      !branchName ||
      !lock.present ||
      lock.malformed ||
      holder === undefined ||
      holder.claimId !== claim.claimId ||
      !holder.agentId
    ) {
      return false;
    }
    const tokens = readGeneratedClaimTokens(worktree, claim.claimId);
    if (
      !(
        tokens.status === 'present' &&
        tokens.record.claimId === claim.claimId &&
        tokens.record.agentId === holder.agentId
      ) ||
      holder.agentId !== claim.agentId ||
      branchName !== claim.branch
    ) {
      return false;
    }
    return isCurrentSessionWorktreeOwner(
      worktreePath,
      branchName,
      claim.branch,
      probe,
    );
  } catch {
    return false;
  }
}

function ownerEvidenceFor(
  sandbox: { primary: string; worktree: string },
  probe?: LocalWorktreeInspection,
  claim: typeof SUCCESSOR_CLAIM = SUCCESSOR_CLAIM,
) {
  const real = inspectLocalWorktreeBranch(SUCCESSOR_BRANCH, sandbox.primary);
  const check = evaluateCurrentSessionOwnerEvidence(
    claim,
    probe ?? real,
    sandbox.worktree,
  );
  assert.equal(
    check.owner,
    booleanOwnerVerdict(claim, probe ?? real, sandbox.worktree),
    'owner must match the boolean pair it replaces',
  );
  assert.deepEqual(Object.keys(check.evidence), OWNER_PROOF_ORDER);
  return check;
}

test('owner evidence names a lock held by another claim-id and leaves later booleans null (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    const { owner, evidence } = ownerEvidenceFor(sandbox);
    assert.equal(owner, false);
    assert.deepEqual(evidence, {
      worktree_identity: true,
      claim_lock_matches: false,
      generated_tokens_match: null,
      agent_and_branch_match: null,
      occupancy_probe: 'occupied',
      occupancy_paths_match: null,
    });
    assert.equal(firstFailedOwnerProof(evidence), 'claim_lock_matches');
  });
});

test('owner evidence names a missing generated-tokens record once the lock matches (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox);
    assert.equal(owner, false);
    assert.deepEqual(evidence, {
      worktree_identity: true,
      claim_lock_matches: true,
      generated_tokens_match: false,
      agent_and_branch_match: null,
      occupancy_probe: 'occupied',
      occupancy_paths_match: null,
    });
    assert.equal(firstFailedOwnerProof(evidence), 'generated_tokens_match');
  });
});

test('owner evidence names an agent-id or branch mismatch after the lock and tokens match (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    for (const claim of [
      { ...SUCCESSOR_CLAIM, agentId: 'agent-someone-else' },
      { ...SUCCESSOR_CLAIM, branch: 'issue/99-other' },
    ]) {
      const { owner, evidence } = ownerEvidenceFor(sandbox, undefined, claim);
      assert.equal(owner, false);
      assert.equal(evidence.claim_lock_matches, true);
      assert.equal(evidence.generated_tokens_match, true);
      assert.equal(evidence.agent_and_branch_match, false);
      assert.equal(evidence.occupancy_paths_match, null);
      assert.equal(firstFailedOwnerProof(evidence), 'agent_and_branch_match');
    }
  });
});

test('owner evidence is all-true with no failed proof for the real owner (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox);
    assert.equal(owner, true);
    assert.deepEqual(evidence, {
      worktree_identity: true,
      claim_lock_matches: true,
      generated_tokens_match: true,
      agent_and_branch_match: true,
      occupancy_probe: 'occupied',
      occupancy_paths_match: true,
    });
    assert.equal(firstFailedOwnerProof(evidence), null);
  });
});

test('owner evidence names no resolvable worktree identity for a mid-rebase worktree (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    leaveWorktreeMidRebase(sandbox);
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox);
    assert.equal(owner, false);
    assert.deepEqual(evidence, {
      worktree_identity: false,
      claim_lock_matches: null,
      generated_tokens_match: null,
      agent_and_branch_match: null,
      occupancy_probe: 'occupied',
      occupancy_paths_match: null,
    });
    assert.equal(firstFailedOwnerProof(evidence), 'worktree_identity');
  });
});

test('owner evidence keeps an unreadable probe and never compares its paths (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox, {
      status: 'unreadable',
      paths: [sandbox.worktree],
      reason: 'ambiguous detached-operation metadata',
    });
    assert.equal(owner, false);
    assert.deepEqual(evidence, {
      worktree_identity: true,
      claim_lock_matches: true,
      generated_tokens_match: true,
      agent_and_branch_match: true,
      occupancy_probe: 'unreadable',
      occupancy_paths_match: null,
    });
    assert.equal(firstFailedOwnerProof(evidence), 'occupancy_probe');
  });
});

test('owner evidence names an occupied probe whose path is another worktree (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox, {
      status: 'occupied',
      paths: [sandbox.worktree, join(tmpdir(), 'idd-some-other-worktree')],
      reason: null,
    });
    assert.equal(owner, false);
    assert.equal(evidence.occupancy_probe, 'occupied');
    assert.equal(evidence.occupancy_paths_match, false);
    assert.equal(firstFailedOwnerProof(evidence), 'occupancy_paths_match');
  });
});

test('owner evidence reports a probe that is absent without evaluating its paths (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordGeneratedClaimTokens(sandbox.worktree, {
      agentId: 'agent-new',
      claimId: 'claim-new',
      nonce: 'nonce-new',
    });
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const { owner, evidence } = ownerEvidenceFor(sandbox, {
      status: 'absent',
      paths: [],
      reason: null,
    });
    assert.equal(owner, false);
    assert.equal(evidence.occupancy_probe, 'absent');
    assert.equal(evidence.occupancy_paths_match, null);
    assert.equal(firstFailedOwnerProof(evidence), 'occupancy_probe');
  });
});

test('the owner proof fails closed when the current directory no longer exists (#3667)', {
  skip: process.platform === 'win32',
}, () => {
  // `process.cwd()` throws once the directory is deleted; the old single
  // `try` around the whole chain turned that into "no evidence".
  const dir = mkdtempSync(join(tmpdir(), 'idd-deleted-cwd-'));
  const moduleUrl = pathToFileURL(
    join(REPO_ROOT, 'src/scripts/discover-roadmap-graph.mts'),
  ).href;
  const script = `
    import { rmSync } from 'node:fs';
    import {
      evaluateCurrentSessionOwnerEvidence,
      resolveCurrentSessionClaimEvidence,
    } from ${JSON.stringify(moduleUrl)};
    process.chdir(${JSON.stringify(dir)});
    rmSync(${JSON.stringify(dir)}, { recursive: true });
    let cwdThrew = false;
    try { process.cwd(); } catch { cwdThrew = true; }
    const claim = { claimId: 'claim-x', agentId: 'agent-x', branch: 'issue/1-x' };
    process.stdout.write(JSON.stringify({
      cwdThrew,
      evidence: resolveCurrentSessionClaimEvidence('claim-x'),
      check: evaluateCurrentSessionOwnerEvidence(claim, { status: 'occupied', paths: [], reason: null }),
    }));
  `;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { encoding: 'utf8', env: hermeticGitEnv() },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.cwdThrew, true);
    assert.equal(output.evidence, null);
    assert.equal(output.check.owner, false);
    assert.equal(output.check.evidence.worktree_identity, false);
    assert.equal(output.check.evidence.claim_lock_matches, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #3667: the same proofs, reported through the routing itself.

/** Routing as the CLI wires it: a structured owner callback over the probe. */
function routeWithOwnerEvidence(
  sandbox: { primary: string; worktree: string },
  overrides: { probe?: LocalWorktreeInspection; nonce?: string } = {},
) {
  const inspect = (branch: string) =>
    overrides.probe ?? inspectLocalWorktreeBranch(branch, sandbox.primary);
  return evaluateResumeClaimRouting(
    {
      claimId: 'claim-new',
      nonce: overrides.nonce ?? 'nonce-new',
      now: '2026-05-12T11:00:00Z',
      events: SUCCESSOR_EVENTS,
    },
    {
      isTrustedAuthor: trusted(['maintainer']),
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === 'maintainer',
      inspectLocalWorktree: inspect,
      isCurrentSessionOwner: (claim, localWorktree) =>
        evaluateCurrentSessionOwnerEvidence(
          claim,
          localWorktree ?? inspect(claim.branch),
          sandbox.worktree,
        ),
    },
  );
}

function ownerEvidenceWarnings(warnings: string[]): string[] {
  return warnings.filter((line) => line.startsWith('owner evidence required'));
}

function recordSuccessorTokens(worktree: string): void {
  recordGeneratedClaimTokens(worktree, {
    agentId: 'agent-new',
    claimId: 'claim-new',
    nonce: 'nonce-new',
  });
}

test('owner_evidence_required reports the lock proof, the warning and the local worktree (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    const result = routeWithOwnerEvidence(sandbox);
    assertSuccessorStop(result);
    assert.deepEqual(Object.keys(result.evidence.owner_evidence ?? {}), [
      ...OWNER_PROOF_ORDER,
    ]);
    assert.deepEqual(result.evidence.owner_evidence, {
      worktree_identity: true,
      claim_lock_matches: false,
      generated_tokens_match: null,
      agent_and_branch_match: null,
      occupancy_probe: 'occupied',
      occupancy_paths_match: null,
    });
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), [
      'owner evidence required: first failed proof is claim_lock_matches',
    ]);
    assert.deepEqual(
      result.evidence.local_worktree,
      inspectLocalWorktreeBranch(SUCCESSOR_BRANCH, sandbox.primary),
    );
    assert.equal(result.evidence.local_worktree?.status, 'occupied');
  });
});

test('owner_evidence_required names a missing generated-tokens record (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const result = routeWithOwnerEvidence(sandbox);
    assertSuccessorStop(result);
    assert.equal(result.evidence.owner_evidence?.claim_lock_matches, true);
    assert.equal(result.evidence.owner_evidence?.generated_tokens_match, false);
    assert.equal(result.evidence.owner_evidence?.agent_and_branch_match, null);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), [
      'owner evidence required: first failed proof is generated_tokens_match',
    ]);
  });
});

test('owner_evidence_required names no resolvable worktree identity (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    leaveWorktreeMidRebase(sandbox);
    recordSuccessorTokens(sandbox.worktree);
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const result = routeWithOwnerEvidence(sandbox);
    assertSuccessorStop(result);
    assert.equal(result.evidence.owner_evidence?.worktree_identity, false);
    assert.equal(result.evidence.owner_evidence?.claim_lock_matches, null);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), [
      'owner evidence required: first failed proof is worktree_identity',
    ]);
  });
});

test('owner_evidence_required names an unreadable probe with its status (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordSuccessorTokens(sandbox.worktree);
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const probe: LocalWorktreeInspection = {
      status: 'unreadable',
      paths: [sandbox.worktree],
      reason: 'ambiguous detached-operation metadata',
    };
    const result = routeWithOwnerEvidence(sandbox, { probe });
    assertSuccessorStop(result);
    assert.equal(result.evidence.owner_evidence?.occupancy_probe, 'unreadable');
    assert.equal(result.evidence.owner_evidence?.occupancy_paths_match, null);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), [
      'owner evidence required: first failed proof is occupancy_probe (unreadable)',
    ]);
    assert.deepEqual(result.evidence.local_worktree, probe);
  });
});

test('owner_evidence_required names an occupied probe at another path (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordSuccessorTokens(sandbox.worktree);
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const probe: LocalWorktreeInspection = {
      status: 'occupied',
      paths: [join(tmpdir(), 'idd-some-other-worktree')],
      reason: null,
    };
    const result = routeWithOwnerEvidence(sandbox, { probe });
    assertSuccessorStop(result);
    assert.equal(result.evidence.owner_evidence?.occupancy_probe, 'occupied');
    assert.equal(result.evidence.owner_evidence?.occupancy_paths_match, false);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), [
      'owner evidence required: first failed proof is occupancy_paths_match',
    ]);
    assert.deepEqual(result.evidence.local_worktree, probe);
  });
});

test('already_owned reports all-true owner evidence and no local_worktree or failed-proof warning (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    recordSuccessorTokens(sandbox.worktree);
    acquireClaimLock(sandbox.worktree, 'agent-new', 'claim-new', true);
    const result = routeWithOwnerEvidence(sandbox);
    assert.equal(result.state, 'already_owned');
    assert.equal(result.action, 'keep');
    assert.deepEqual(result.evidence.owner_evidence, {
      worktree_identity: true,
      claim_lock_matches: true,
      generated_tokens_match: true,
      agent_and_branch_match: true,
      occupancy_probe: 'occupied',
      occupancy_paths_match: true,
    });
    assert.equal(result.evidence.local_worktree, undefined);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), []);
  });
});

test('an absent probe reports no owner_evidence and keeps already_owned (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    const result = routeWithOwnerEvidence(sandbox, {
      probe: { status: 'absent', paths: [], reason: null },
    });
    assert.equal(result.state, 'already_owned');
    assert.equal(result.evidence.owner_evidence, undefined);
    assert.equal(result.evidence.local_worktree, undefined);
  });
});

test('a nonce-mismatch dispute still reports owner_evidence without changing the verdict (#3667)', () => {
  withSuccessorSandbox((sandbox) => {
    const result = routeWithOwnerEvidence(sandbox, { nonce: 'nonce-other' });
    assert.equal(result.state, 'disputed');
    assert.equal(result.action, 'stop');
    assert.equal(result.reason, 'activation-nonce-mismatch');
    assert.equal(result.evidence.owner_evidence?.claim_lock_matches, false);
    assert.deepEqual(ownerEvidenceWarnings(result.warnings), []);
    assert.equal(result.evidence.local_worktree, undefined);
  });
});

test('a boolean owner callback reports no owner_evidence and no failed-proof warning (#3667)', () => {
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
        reason: null,
      }),
      isCurrentSessionOwner: () => false,
    },
  );
  assert.equal(result.state, 'owner_evidence_required');
  assert.equal(result.evidence.owner_evidence, undefined);
  assert.deepEqual(ownerEvidenceWarnings(result.warnings), []);
  // The blocking probe is still reported on this verdict.
  assert.equal(result.evidence.local_worktree?.status, 'occupied');
});

test('a forced-handoff lookup failure override never carries the owner-evidence warning or local_worktree (#3667)', () => {
  const result = evaluateResumeClaimRouting(
    {
      claimId: 'claim-old',
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
      inspectLocalWorktree: () => ({
        status: 'occupied',
        paths: ['/tmp/repo.issue-11-task'],
        reason: null,
      }),
      isCurrentSessionOwner: (claim, localWorktree) =>
        evaluateCurrentSessionOwnerEvidence(
          claim,
          localWorktree ?? { status: 'absent', paths: [], reason: null },
          '/nonexistent/idd-3667-worktree',
        ),
    },
  );
  assert.equal(result.state, 'disputed');
  assert.equal(result.reason, 'forced-handoff-linked-pr-lookup-failed');
  // The owner check did run (so this override is what dropped the warning).
  assert.equal(result.evidence.owner_evidence?.worktree_identity, false);
  assert.deepEqual(ownerEvidenceWarnings(result.warnings), []);
  assert.equal(result.evidence.local_worktree, undefined);
});

// #3667: --assert turns the routing verdict into an exit status. The stdout
// JSON is the same with and without the flag; only already_owned / keep
// exits 0.

test('resolveAssertOutcome exits 0 only for already_owned with keep (#3667)', () => {
  const none = { owner_evidence: undefined };
  assert.deepEqual(
    resolveAssertOutcome({
      state: 'already_owned',
      action: 'keep',
      reason: 'claim-id-match',
      evidence: none,
    }),
    { exitCode: 0, message: '' },
  );
  for (const [state, action, reason] of [
    ['non_inheritable', 'stop', 'active-claim-non-stale'],
    ['unclaimed', 're_claim', 'no-active-claim'],
    ['local_worktree_occupied', 'stop', 'stale-claim-local-worktree-occupied'],
    ['disputed', 'stop', 'activation-nonce-mismatch'],
    ['stale', 'takeover', 'active-claim-stale'],
  ]) {
    const outcome = resolveAssertOutcome({
      state,
      action,
      reason,
      evidence: none,
    });
    assert.equal(outcome.exitCode, 1, state);
    assert.equal(
      outcome.message,
      `resume-claim-routing --assert: state=${state} action=${action} reason=${reason}`,
    );
    assert.doesNotMatch(outcome.message, /\n/);
  }
});

test('resolveAssertOutcome names the first failed owner proof when the evidence has one (#3667)', () => {
  const outcome = resolveAssertOutcome({
    state: 'owner_evidence_required',
    action: 'stop',
    reason: 'claim-id-match-without-independent-owner-evidence',
    evidence: {
      owner_evidence: {
        worktree_identity: true,
        claim_lock_matches: false,
        generated_tokens_match: null,
        agent_and_branch_match: null,
        occupancy_probe: 'occupied',
        occupancy_paths_match: null,
      },
    },
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(
    outcome.message,
    'resume-claim-routing --assert: state=owner_evidence_required action=stop reason=claim-id-match-without-independent-owner-evidence first_failed_proof=claim_lock_matches',
  );
});

test('resolveAssertOutcome leaves first_failed_proof off a disputed route that also carries owner evidence (#3667)', () => {
  const outcome = resolveAssertOutcome({
    state: 'disputed',
    action: 'stop',
    reason: 'activation-nonce-mismatch',
    evidence: {
      owner_evidence: {
        worktree_identity: true,
        claim_lock_matches: false,
        generated_tokens_match: null,
        agent_and_branch_match: null,
        occupancy_probe: 'occupied',
        occupancy_paths_match: null,
      },
    },
  });
  assert.equal(outcome.exitCode, 1);
  assert.equal(
    outcome.message,
    'resume-claim-routing --assert: state=disputed action=stop reason=activation-nonce-mismatch',
  );
});

const ASSERT_CLI_CLAIM = {
  id: 1,
  node_id: 'IC_assert_claim',
  body: `<!-- claimed-by: agent-old claim-old supersedes: none 2026-05-12T10:00:00Z branch: ${SUCCESSOR_BRANCH} -->`,
  created_at: '2026-05-12T10:00:00Z',
  user: { login: 'maintainer' },
};

function assertCliFixture(comments: (typeof ASSERT_CLI_CLAIM)[]) {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-claim-routing-assert-'),
  );
  const policyPath = join(tempRoot, 'config.json');
  writeFileSync(
    policyPath,
    `${JSON.stringify({ trustedMarkerActors: ['maintainer'] })}\n`,
  );
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stdout.write('maintainer\\n');
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('databaseId'))) {
  process.stdout.write(${JSON.stringify(
    JSON.stringify({
      data: {
        repository: {
          issue: {
            comments: {
              nodes: comments.map((row) => ({
                id: row.node_id,
                databaseId: row.id,
                body: row.body,
                createdAt: row.created_at,
                updatedAt: row.created_at,
                lastEditedAt: null,
                author: { login: row.user.login, __typename: 'User' },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          pullRequest: null,
        },
      },
    }),
  )});
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => /nodes\\(ids/.test(arg))) {
  process.stdout.write(JSON.stringify({ data: { nodes: ${JSON.stringify(
    comments.map((row) => ({ id: row.node_id, lastEditedAt: null })),
  )} } }));
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/11\\/comments/.test(arg))) {
  process.stdout.write(${JSON.stringify(JSON.stringify(comments))});
  process.exit(0);
}
if (args[0] === 'api' && args.some((arg) => /\\/issues\\/11$/.test(arg))) {
  process.stdout.write(JSON.stringify({
    number: 11,
    title: 'assert fixture',
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

function runAssertCli(
  fixture: { policyPath: string },
  cwd: string,
  extraArgs: string[],
  env: NodeJS.ProcessEnv = {},
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
      '--policy',
      fixture.policyPath,
      ...extraArgs,
    ],
    { cwd, encoding: 'utf8', env: { ...hermeticGitEnv(), ...env } },
  );
}

const ASSERT_NON_STALE = ['--now', '2026-05-12T11:00:00Z'];
const ASSERT_STALE = ['--now', '2026-05-14T11:00:00Z'];

function lastLine(text: string): string {
  return text.trimEnd().split('\n').at(-1) ?? '';
}

test('--assert exits 0 for the proven owner and leaves stdout identical to a run without it (#3667)', () => {
  const fixture = assertCliFixture([ASSERT_CLI_CLAIM]);
  try {
    withSuccessorSandbox(({ primary, worktree }) => {
      const args = [
        '--claim-id',
        'claim-old',
        '--worktree',
        worktree,
        ...ASSERT_NON_STALE,
      ];
      const plain = runAssertCli(fixture, primary, args);
      const asserted = runAssertCli(fixture, primary, [...args, '--assert']);
      assert.equal(plain.status, 0, plain.stderr);
      assert.equal(asserted.status, 0, asserted.stderr);
      assert.equal(asserted.stderr, '');
      assert.equal(asserted.stdout, plain.stdout);
      const output = JSON.parse(asserted.stdout);
      assert.equal(output.state, 'already_owned');
      assert.equal(output.action, 'keep');
      assert.equal(output.evidence.owner_evidence.occupancy_paths_match, true);
    });
  } finally {
    fixture.restore();
  }
});

test('--assert exits non-zero with a gate line naming the failed owner proof, stdout unchanged (#3667)', () => {
  const fixture = assertCliFixture([ASSERT_CLI_CLAIM]);
  try {
    withSuccessorSandbox(({ primary }) => {
      const args = ['--claim-id', 'claim-old', ...ASSERT_NON_STALE];
      const plain = runAssertCli(fixture, primary, args);
      const asserted = runAssertCli(fixture, primary, [...args, '--assert']);
      // Without --assert the helper exits 0 on a stop verdict.
      assert.equal(plain.status, 0, plain.stderr);
      assert.equal(asserted.status, 1);
      assert.equal(asserted.stdout, plain.stdout);
      const output = JSON.parse(asserted.stdout);
      assert.equal(output.state, 'owner_evidence_required');
      assert.equal(output.evidence.owner_evidence.claim_lock_matches, false);
      assert.equal(
        asserted.stderr,
        'resume-claim-routing --assert: state=owner_evidence_required action=stop reason=claim-id-match-without-independent-owner-evidence first_failed_proof=claim_lock_matches\n',
      );
    });
  } finally {
    fixture.restore();
  }
});

test('--assert exits non-zero for non_inheritable and for a stale claim with an occupied worktree (#3667)', () => {
  const fixture = assertCliFixture([ASSERT_CLI_CLAIM]);
  try {
    withSuccessorSandbox(({ primary }) => {
      const live = runAssertCli(fixture, primary, [
        '--claim-id',
        'claim-other',
        '--assert',
        ...ASSERT_NON_STALE,
      ]);
      assert.equal(live.status, 1);
      assert.equal(
        live.stderr,
        'resume-claim-routing --assert: state=non_inheritable action=stop reason=active-claim-non-stale\n',
      );
      const stale = runAssertCli(fixture, primary, [
        '--claim-id',
        'claim-other',
        '--assert',
        ...ASSERT_STALE,
      ]);
      assert.equal(stale.status, 1);
      assert.equal(
        stale.stderr,
        'resume-claim-routing --assert: state=local_worktree_occupied action=stop reason=stale-claim-local-worktree-occupied\n',
      );
    });
  } finally {
    fixture.restore();
  }
});

test('--assert exits non-zero for an unclaimed issue (#3667)', () => {
  const fixture = assertCliFixture([]);
  try {
    const result = runAssertCli(fixture, REPO_ROOT, [
      '--claim-id',
      'claim-old',
      '--assert',
      ...ASSERT_NON_STALE,
    ]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).state, 'unclaimed');
    assert.equal(
      result.stderr,
      'resume-claim-routing --assert: state=unclaimed action=re_claim reason=legacy-absent\n',
    );
  } finally {
    fixture.restore();
  }
});

test('--assert reports kind gate with the envelope line last under IDD_HELPER_ERROR_ENVELOPE (#3667)', () => {
  const fixture = assertCliFixture([ASSERT_CLI_CLAIM]);
  try {
    withSuccessorSandbox(({ primary }) => {
      const result = runAssertCli(
        fixture,
        primary,
        ['--claim-id', 'claim-old', '--assert', ...ASSERT_NON_STALE],
        { IDD_HELPER_ERROR_ENVELOPE: '1' },
      );
      assert.equal(result.status, 1);
      const lines = result.stderr.trimEnd().split('\n');
      assert.equal(lines.length, 2);
      assert.match(lines[0], /^resume-claim-routing --assert: state=/);
      const envelope = JSON.parse(lastLine(result.stderr)).iddHelperError;
      assert.equal(envelope.kind, 'gate');
      assert.equal(envelope.exitCode, 1);
      assert.equal(envelope.helper, 'resume-claim-routing');
      assert.equal(envelope.message, lines[0]);
    });
  } finally {
    fixture.restore();
  }
});

test('--assert without --claim-id, or with --fresh-claim-gate, is a usage error before any gh call (#3667)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-resume-assert-usage-'));
  const callLog = join(tempRoot, 'gh-called');
  const restore = stubExecutable(
    'gh',
    `require('fs').writeFileSync(${JSON.stringify(callLog)}, 'called');
process.exit(1);
`,
  );
  try {
    for (const [extraArgs, message] of [
      [['--assert'], /--assert requires --claim-id/],
      [
        ['--assert', '--claim-id', 'claim-old', '--fresh-claim-gate'],
        /--assert cannot be combined with --fresh-claim-gate/,
      ],
    ] as const) {
      const result = runAssertCli({ policyPath: devNull }, REPO_ROOT, [
        ...extraArgs,
      ]);
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, message);
      const enveloped = runAssertCli(
        { policyPath: devNull },
        REPO_ROOT,
        [...extraArgs],
        { IDD_HELPER_ERROR_ENVELOPE: '1' },
      );
      assert.equal(
        JSON.parse(lastLine(enveloped.stderr)).iddHelperError.kind,
        'usage',
      );
    }
    assert.throws(() => readFileSync(callLog), /ENOENT/);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

// #3871: fetchOpenLinkedPrReferences also reads the closing references, so a
// pull request whose body closes the issue (no ConnectedEvent) backs the claim.
const REPO = 'kurone-kito/idd-skill';

function closingNode(
  number: number | undefined,
  state: string | undefined,
  repository: string | undefined,
) {
  return { state, number, repository };
}

test('#3871: an open closing reference of this repository backs the claim without a ConnectedEvent', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(3875, 'OPEN', REPO)],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, false);
  assert.deepEqual([...result.references], ['3875']);
});

test('#3871: a PR that is both a closing reference and a ConnectedEvent appears once', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        {
          events: [
            {
              __typename: 'ConnectedEvent',
              subject: {
                __typename: 'PullRequest',
                number: 3875,
                state: 'OPEN',
              },
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(3875, 'OPEN', REPO)],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.deepEqual([...result.references], ['3875']);
});

test('#3871: a merged or closed closing reference and another repository are not expected references', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [
            closingNode(3801, 'MERGED', REPO),
            closingNode(3802, 'CLOSED', REPO),
            closingNode(3803, 'OPEN', 'someone-else/other-repo'),
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, false);
  assert.deepEqual([...result.references], []);
});

test('#3871: the repository comparison is case-insensitive', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(3875, 'OPEN', 'Kurone-Kito/IDD-Skill')],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  assert.deepEqual(
    [...fetchOpenLinkedPrReferences(port, 11, REPO).references],
    ['3875'],
  );
});

test('#3871: an open closing reference without a number or repository is a lookup failure', () => {
  for (const node of [
    closingNode(undefined, 'OPEN', REPO),
    closingNode(3875, 'OPEN', undefined),
  ]) {
    const port = createFakeProviderAdapter({
      closingPullRequestPages: {
        11: [{ nodes: [node], hasNextPage: false, endCursor: null }],
      },
    });
    const result = fetchOpenLinkedPrReferences(port, 11, REPO);
    assert.equal(result.lookupFailed, true);
    assert.deepEqual([...result.references], []);
  }
});

test('#3871: a failed closing-references read is a lookup failure, as is a closing page without a cursor or a repeated one', () => {
  const thrown = createFakeProviderAdapter({
    closingPullRequestPageErrors: { 11: 'closing page unavailable' },
  });
  assert.equal(
    fetchOpenLinkedPrReferences(thrown, 11, REPO).lookupFailed,
    true,
  );

  const noCursor = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [{ nodes: [], hasNextPage: true, endCursor: null }],
    },
  });
  assert.equal(
    fetchOpenLinkedPrReferences(noCursor, 11, REPO).lookupFailed,
    true,
  );

  const repeated = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        { nodes: [], hasNextPage: true, endCursor: 'same' },
        { nodes: [], hasNextPage: true, endCursor: 'same' },
      ],
    },
  });
  assert.equal(
    fetchOpenLinkedPrReferences(repeated, 11, REPO).lookupFailed,
    true,
  );
});

test('#3871: a DISCONNECTED_EVENT removes a manually linked PR that the closing page does not list', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        {
          events: [
            {
              __typename: 'ConnectedEvent',
              subject: { __typename: 'PullRequest', number: 88, state: 'OPEN' },
            },
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
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, false);
  assert.deepEqual([...result.references], []);
});

// #3871: the first-commit time. Resume judges an issue-only handoff against
// a PR-backed claim with the same time rule the merge gate uses (#1058), and
// it reads the commits only when such a marker is among the fetched comments.
const COMMIT_BEFORE_MARKER = '2026-05-12T10:00:30Z';
const COMMIT_AFTER_MARKER = '2026-05-12T10:30:00Z';

function commitAt(date: string) {
  return { commit: { committer: { date } } };
}

function resumeWithLinkedPr(
  port: ProviderPort,
  events: ReturnType<typeof forcedHandoffEvents>,
) {
  const hasIssueOnlyHandoff = events.some((event) =>
    event.body.includes('"contextScope":"issue-only"'),
  );
  const state = resolveResumeLinkedPrState(port, 11, REPO, {
    forcedHandoffEnabled: true,
    hasIssueOnlyHandoff,
  });
  return route(events, state.isForcedHandoffEnabled, state.lookupFailed);
}

function openClosingPr(number: number) {
  return {
    nodes: [closingNode(number, 'OPEN', REPO)],
    hasNextPage: false,
    endCursor: null,
  };
}

test('#3871: an issue-only handoff that predates the first commit of a closing-reference PR is honored', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [commitAt(COMMIT_AFTER_MARKER)] },
  });
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('#3871: an issue-only handoff posted after the first commit of a closing-reference PR is refused', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [commitAt(COMMIT_BEFORE_MARKER)] },
  });
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.notEqual(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('#3871: an issue-plus-pr handoff naming the backing PR is honored whatever the commit times', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [commitAt(COMMIT_BEFORE_MARKER)] },
  });
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '77' }),
  );
  assert.equal(result.state, 'already_owned');
  assert.equal(result.active_claim?.claim_id, 'claim-new');
});

test('#3871: an issue-plus-pr handoff naming a different PR is refused', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [commitAt(COMMIT_AFTER_MARKER)] },
  });
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '88' }),
  );
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('#3871: a failed commits read is a lookup failure and the issue-only handoff is refused', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommitErrors: { 77: 'commits unavailable' },
  });
  // One resolution only: the fake closing page advances on every read.
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.equal(result.state, 'disputed');
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'forced-handoff-linked-pr-lookup-failed');
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('#3871: an empty commit list makes the first-commit time unknown and refuses the issue-only handoff', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [] },
  });
  const result = resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.equal(result.active_claim?.claim_id, 'claim-old');
});

test('#3871: with two backing PRs the marker must predate the earliest, so one PR that predates it refuses it', () => {
  const both = (first: string, second: string) =>
    createFakeProviderAdapter({
      closingPullRequestPages: {
        11: [
          {
            nodes: [
              closingNode(77, 'OPEN', REPO),
              closingNode(88, 'OPEN', REPO),
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
      changeRequestCommits: {
        77: [commitAt(first)],
        88: [commitAt(second)],
      },
    });
  // Both first commits follow the marker: it predates the earliest, so honored.
  assert.equal(
    resumeWithLinkedPr(
      both(COMMIT_AFTER_MARKER, COMMIT_AFTER_MARKER),
      forcedHandoffEvents({ contextScope: 'issue-only' }),
    ).active_claim?.claim_id,
    'claim-new',
  );
  // PR 88's first commit predates the marker, so the marker is refused.
  assert.equal(
    resumeWithLinkedPr(
      both(COMMIT_AFTER_MARKER, COMMIT_BEFORE_MARKER),
      forcedHandoffEvents({ contextScope: 'issue-only' }),
    ).active_claim?.claim_id,
    'claim-old',
  );
  // A PR whose first-commit time cannot be read makes the time unknown.
  const unreadable = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(77, 'OPEN', REPO), closingNode(88, 'OPEN', REPO)],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
    changeRequestCommits: {
      77: [commitAt(COMMIT_AFTER_MARKER)],
      88: [{ commit: {} }],
    },
  });
  assert.equal(
    resumeWithLinkedPr(
      unreadable,
      forcedHandoffEvents({ contextScope: 'issue-only' }),
    ).active_claim?.claim_id,
    'claim-old',
  );
});

test('#3871: the commits are not read when no issue-only marker is among the comments', () => {
  const base = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
    changeRequestCommits: { 77: [commitAt(COMMIT_AFTER_MARKER)] },
  });
  const reads: number[] = [];
  const port: ProviderPort = {
    ...base,
    listChangeRequestCommits(number: number) {
      reads.push(number);
      return base.listChangeRequestCommits(number);
    },
  };
  resumeWithLinkedPr(
    port,
    forcedHandoffEvents({ contextScope: 'issue-plus-pr', linkedPr: '77' }),
  );
  assert.deepEqual(reads, []);
});

test('#3871: a PR visible only as a ConnectedEvent follows the same time rule as a closing reference', () => {
  const connectedPort = (commitDate: string) =>
    createFakeProviderAdapter({
      connectedPrEventPages: {
        11: [
          {
            events: [
              {
                __typename: 'ConnectedEvent',
                subject: {
                  __typename: 'PullRequest',
                  number: 77,
                  state: 'OPEN',
                },
              },
            ],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
      changeRequestCommits: { 77: [commitAt(commitDate)] },
    });
  const before = resumeWithLinkedPr(
    connectedPort(COMMIT_AFTER_MARKER),
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.equal(before.state, 'already_owned');
  const after = resumeWithLinkedPr(
    connectedPort(COMMIT_BEFORE_MARKER),
    forcedHandoffEvents({ contextScope: 'issue-only' }),
  );
  assert.equal(after.active_claim?.claim_id, 'claim-old');
});

test('#3871: a closing-reference node without a state fails the lookup instead of being skipped', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [{ number: 3875, repository: REPO }],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, true);
  assert.deepEqual([...result.references], []);
});

test('#3871: an open closing-reference node with a non-positive PR number fails the lookup', () => {
  for (const number of [0, -4]) {
    const port = createFakeProviderAdapter({
      closingPullRequestPages: {
        11: [
          {
            nodes: [closingNode(number, 'OPEN', REPO)],
            hasNextPage: false,
            endCursor: null,
          },
        ],
      },
    });
    assert.equal(
      fetchOpenLinkedPrReferences(port, 11, REPO).lookupFailed,
      true,
    );
  }
});

test('#3871: a failed closing-references read keeps the connected references and still fails the lookup', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPages: {
      11: [
        {
          events: [
            {
              __typename: 'ConnectedEvent',
              subject: { __typename: 'PullRequest', number: 77, state: 'OPEN' },
            },
          ],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
    closingPullRequestPageErrors: { 11: 'closing page unavailable' },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, true);
  assert.deepEqual([...result.references], ['77']);
});

test('#3871: a non-array commits response is a failed read, not an unknown time', () => {
  const base = createFakeProviderAdapter({
    closingPullRequestPages: { 11: [openClosingPr(77)] },
  });
  const port: ProviderPort = {
    ...base,
    listChangeRequestCommits: () => ({}) as unknown as unknown[],
  };
  const state = resolveResumeLinkedPrState(port, 11, REPO, {
    forcedHandoffEnabled: true,
    hasIssueOnlyHandoff: true,
  });
  assert.equal(state.lookupFailed, true);
  assert.equal(state.prFirstCommitAt, null);
});

test('#3871: a failed connected read still reads the closing references, which are kept, and fails the lookup', () => {
  const port = createFakeProviderAdapter({
    connectedPrEventPageErrors: { 11: 'timeline unavailable' },
    closingPullRequestPages: { 11: [openClosingPr(77)] },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, REPO);
  assert.equal(result.lookupFailed, true);
  assert.deepEqual([...result.references], ['77']);
});

test('#3871: a blank repository fails the closing-reference read instead of matching blank values', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(3875, 'OPEN', '')],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  const result = fetchOpenLinkedPrReferences(port, 11, '  ');
  assert.equal(result.lookupFailed, true);
  assert.deepEqual([...result.references], []);
});

test('#3871: an open closing-reference node with a blank repository fails the lookup instead of being skipped', () => {
  const port = createFakeProviderAdapter({
    closingPullRequestPages: {
      11: [
        {
          nodes: [closingNode(3875, 'OPEN', ' ')],
          hasNextPage: false,
          endCursor: null,
        },
      ],
    },
  });
  assert.equal(fetchOpenLinkedPrReferences(port, 11, REPO).lookupFailed, true);
});
