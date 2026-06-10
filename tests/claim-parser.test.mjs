import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  applyClaimEvent,
  isStaleAt,
  parseClaimComment,
  parseReleaseComment,
} from '../scripts/protocol-helpers.mjs';

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
  assert.equal(after.createdAt, '2026-05-23T13:00:00Z');
  assert.equal(after.branch, 'issue/100-task');
  assert.equal(after.claimId, 'claim-A');
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
  assert.equal(after.createdAt, '2026-05-23T10:00:00Z');
  assert.equal(after.branch, 'issue/100-task');
});

test('onAnomalousHeartbeat callback receives the anomalous heartbeat metadata', () => {
  const active = parseClaimComment(
    '<!-- claimed-by: copilot claim-A supersedes: none 2026-05-23T10:00:00Z branch: issue/100-task -->',
    '2026-05-23T10:00:00Z',
  );
  const seen = [];
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
  const seen = [];
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

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}
