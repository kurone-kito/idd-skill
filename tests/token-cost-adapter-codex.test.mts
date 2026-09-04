import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  codexAdapter,
  extractSessionCwd,
  isIddSkillCwd,
  parseCodexRolloutLines,
  scanCodexSessions,
} from '../src/scripts/token-cost-adapter-codex.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const FIXTURE_DIR = 'tests/fixtures/token-cost/codex';

function readFixtureRecords(name: string): unknown[] {
  return parseCodexRolloutLines(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function harvestFixture(name: string) {
  return codexAdapter.harvest({
    records: readFixtureRecords(name),
    fileBasename: name,
  });
}

test('a total_token_usage snapshot maps to a schema-valid sample with reasoning', () => {
  const { sample, joinHints } = harvestFixture('rollout-basic.jsonl');
  assert.equal(sample.kind, 'session');
  assert.equal(sample.vendor, 'codex');
  assert.equal(sample.model, 'gpt-5.1-codex');
  assert.equal(sample.attribution, 'session-unscoped');
  assert.equal(sample.outcome, 'unknown');
  assert.equal(sample.vendorSessionId, 'sess-basic-0001');
  // input_tokens (15000) >= cacheRead + cacheCreation (13000): inclusive
  // total, so inputUncached is the remainder after subtracting both.
  assert.deepEqual(sample.usage, {
    inputUncached: 2000,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 800,
    reasoning: 300,
  });
  assert.equal(sample.compactionCount, 0);
  assert.equal(sample.startedAt, '2026-08-20T10:00:00.000Z');
  assert.equal(sample.endedAt, '2026-08-20T10:10:00.000Z');
  // The fixture cwd basename ("idd-skill") carries no issue-<n> suffix.
  assert.equal(joinHints, undefined);
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\//);
  assert.deepEqual(
    validate(sample, loadJson('schemas/token-cost-sample.schema.json')),
    [],
  );
});

test('input_tokens below cacheRead+cacheCreation is already exclusive of cache', () => {
  const { sample } = harvestFixture('rollout-exclusive-input.jsonl');
  // input_tokens (900) < cacheRead + cacheCreation (13000): already
  // exclusive, so input_tokens is used as inputUncached directly.
  assert.deepEqual(sample.usage, {
    inputUncached: 900,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 150,
    reasoning: 40,
  });
});

test('three compacted records yield compactionCount 3', () => {
  const { sample } = harvestFixture('rollout-three-compactions.jsonl');
  assert.equal(sample.compactionCount, 3);
  assert.equal(sample.model, 'unknown');
});

test('no total_token_usage anywhere sums every last_token_usage delta', () => {
  const { sample } = harvestFixture('rollout-summed-last-usage.jsonl');
  assert.deepEqual(sample.usage, {
    inputUncached: 280,
    cacheRead: 50,
    cacheCreation: 0,
    output: 65,
    reasoning: 15,
  });
});

test('a missing session_meta.payload.id falls back to the rollout filename', () => {
  const { sample } = harvestFixture('rollout-no-session-id.jsonl');
  assert.equal(sample.vendorSessionId, 'rollout-no-session-id');
});

test('a worktree cwd with an issue number yields joinHints.issueNumber, never a path string', () => {
  const { sample, joinHints } = harvestFixture(
    'rollout-issue-worktree-cwd.jsonl',
  );
  assert.deepEqual(joinHints, { issueNumber: 4242 });
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\//);
});

test('adapter output never carries a leaked secret or absolute path from raw records', () => {
  const { sample } = harvestFixture('rollout-sensitive-fields.jsonl');
  const serialized = JSON.stringify(sample);
  assert.doesNotMatch(serialized, /ghp_/);
  assert.doesNotMatch(serialized, /\.ssh/);
  assert.doesNotMatch(serialized, /\/home\//);
  assert.equal(sample.vendorSessionId, 'sess-sensitive-0006');
});

test('extractSessionCwd prefers session_meta over any other record', () => {
  const records = readFixtureRecords('rollout-basic.jsonl');
  assert.equal(
    extractSessionCwd(records),
    '/home/testuser/ghq/github.com/kurone-kito/idd-skill',
  );
});

test('isIddSkillCwd only matches an idd-skill cwd', () => {
  assert.equal(isIddSkillCwd('/home/me/ghq/github.com/x/idd-skill'), true);
  assert.equal(
    isIddSkillCwd('/home/me/ghq/github.com/x/some-other-repo'),
    false,
  );
  assert.equal(isIddSkillCwd(undefined), false);
});

test('parseCodexRolloutLines tolerates a truncated trailing line', () => {
  const records = parseCodexRolloutLines(
    '{"type":"session_meta","payload":{"cwd":"/x/idd-skill"}}\n{"type":"token_cou',
  );
  assert.equal(records.length, 1);
});

test('scanCodexSessions keeps an idd-skill session and skips a non-idd-skill session', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-codex-test-'),
  );
  const dayDir = join(sandbox, '2026', '08', '26');
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(
    join(dayDir, 'rollout-2026-08-26T00-00-00-kept.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'rollout-basic.jsonl'), 'utf8'),
  );
  writeFileSync(
    join(dayDir, 'rollout-2026-08-26T01-00-00-skipped.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'rollout-other-repo-cwd.jsonl'), 'utf8'),
  );

  const results = scanCodexSessions({ sessionsDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'sess-basic-0001');
});

test('scanCodexSessions skips a malformed session that fails to harvest, keeping the rest', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-codex-test-'),
  );
  const dayDir = join(sandbox, '2026', '08', '26');
  mkdirSync(dayDir, { recursive: true });
  // Matches the idd-skill cwd filter but has no valid timestamp anywhere,
  // so harvest() throws for this file specifically.
  writeFileSync(
    join(dayDir, 'rollout-2026-08-26T00-00-00-malformed.jsonl'),
    '{"type":"session_meta","payload":{"id":"sess-bad","cwd":"/x/idd-skill"}}\n',
  );
  writeFileSync(
    join(dayDir, 'rollout-2026-08-26T01-00-00-kept.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'rollout-basic.jsonl'), 'utf8'),
  );

  const results = scanCodexSessions({ sessionsDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'sess-basic-0001');
});

// Skipped on Windows (#2580): `chmodSync(file, 0o000)` doesn't block a
// subsequent `readFileSync` there -- verified empirically, Windows' own
// read-only attribute (the closest analogue chmodSync can set) blocks
// writes only, never reads, and an explicit `icacls ... /deny` ACE
// doesn't block the read either for an administrator-class account
// (the common case for CI runners too). POSIX/Linux CI stays the
// authoritative coverage for this POSIX-permission-semantics check,
// unaffected by this skip.
test('scanCodexSessions skips an unreadable file, keeping the rest', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-codex-test-'),
  );
  const dayDir = join(sandbox, '2026', '08', '26');
  mkdirSync(dayDir, { recursive: true });
  const unreadable = join(
    dayDir,
    'rollout-2026-08-26T00-00-00-unreadable.jsonl',
  );
  writeFileSync(
    unreadable,
    readFileSync(join(FIXTURE_DIR, 'rollout-basic.jsonl'), 'utf8'),
  );
  chmodSync(unreadable, 0o000);
  writeFileSync(
    join(dayDir, 'rollout-2026-08-26T01-00-00-kept.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'rollout-summed-last-usage.jsonl'), 'utf8'),
  );

  try {
    const results = scanCodexSessions({ sessionsDir: sandbox });
    assert.equal(results.length, 1);
    assert.equal(results[0].sample.vendorSessionId, 'sess-summed-0004');
  } finally {
    chmodSync(unreadable, 0o644);
  }
});

test('scanCodexSessions on an empty directory returns no results', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-codex-test-'),
  );
  assert.deepEqual(scanCodexSessions({ sessionsDir: sandbox }), []);
});

test('harvest rejects an input that is not { records: unknown[] }', () => {
  assert.throws(() => codexAdapter.harvest('not an object'), /records/);
  assert.throws(
    () => codexAdapter.harvest({ records: 'not an array' }),
    /records/,
  );
});

test('harvest fails closed when no record has a valid timestamp', () => {
  assert.throws(
    () =>
      codexAdapter.harvest({
        records: [
          {
            type: 'session_meta',
            payload: { id: 'sess-x', cwd: '/x/idd-skill' },
          },
        ],
      }),
    /timestamp/,
  );
});

test('harvest fails closed when no vendorSessionId is derivable', () => {
  assert.throws(
    () =>
      codexAdapter.harvest({
        records: [
          {
            timestamp: '2026-08-26T00:00:00.000Z',
            type: 'session_meta',
            payload: {},
          },
        ],
      }),
    /vendorSessionId/,
  );
});
