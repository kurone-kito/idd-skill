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
  decodeGrokEncodedCwd,
  grokAdapter,
  isIddSkillCwd,
  parseGrokSessionLines,
  scanGrokSessions,
} from '../src/scripts/token-cost-adapter-grok.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const FIXTURE_DIR = 'tests/fixtures/token-cost/grok';

function readFixtureRecords(name: string): unknown[] {
  return parseGrokSessionLines(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function readFixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

test('a total usage snapshot maps to a schema-valid sample with reasoning, preferring signals over record-scan for model and toolCallCount', () => {
  const { sample, joinHints } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-basic.jsonl'),
    signals: readFixtureJson('signals-basic.json'),
    sessionIdBasename: 'updates-basic',
  });
  assert.equal(sample.kind, 'session');
  assert.equal(sample.vendor, 'grok');
  assert.equal(sample.model, 'grok-4-fast');
  assert.equal(sample.attribution, 'session-unscoped');
  assert.equal(sample.outcome, 'unknown');
  assert.equal(sample.vendorSessionId, 'grok-basic-0001');
  // inputTokens (15000) >= cacheRead + cacheCreation (13000): inclusive
  // total, so inputUncached is the remainder after subtracting both. The
  // last usage snapshot in the file is treated as the session's
  // cumulative running total, not summed with the earlier one.
  assert.deepEqual(sample.usage, {
    inputUncached: 2000,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 800,
    reasoning: 300,
  });
  // The inclusive-total invariant itself, not just the hardcoded values
  // above, so a later change to the inclusive/exclusive heuristic still
  // fails this test even if it happens to preserve these exact numbers.
  assert.equal(
    sample.usage.inputUncached +
      sample.usage.cacheRead +
      sample.usage.cacheCreation,
    15000,
  );
  assert.equal(sample.compactionCount, 0);
  assert.equal(sample.toolCallCount, 6);
  assert.equal(sample.includesSubagents, false);
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

test('inputTokens below cacheRead+cacheCreation is already exclusive of cache', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-exclusive-input.jsonl'),
  });
  // inputTokens (900) < cacheRead + cacheCreation (13000): already
  // exclusive, so inputTokens is used as inputUncached directly.
  assert.deepEqual(sample.usage, {
    inputUncached: 900,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 150,
    reasoning: 40,
  });
});

test('compactionCount is read from signals.json when present', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-events-fallback.jsonl'),
    signals: { compactionCount: 2 },
  });
  assert.equal(sample.compactionCount, 2);
});

test('compactionCount falls back to counting compaction-named events when signals.json is missing', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-events-fallback.jsonl'),
    eventRecords: readFixtureRecords('events-two-compactions.jsonl'),
  });
  assert.equal(sample.compactionCount, 2);
});

test('compactionCount is 0 when neither signals.json nor events.jsonl is present', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-events-fallback.jsonl'),
  });
  assert.equal(sample.compactionCount, 0);
});

test('model falls back to scanning update records when signals.json has no modelsUsed', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-basic.jsonl'),
  });
  assert.equal(sample.model, 'grok-4-fast');
});

test('model is "unknown" when neither signals.modelsUsed nor any record carries a model', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-no-session-id.jsonl'),
    sessionIdBasename: 'updates-no-session-id',
  });
  assert.equal(sample.model, 'unknown');
});

test('a missing sessionId field falls back to the session-id directory basename', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-no-session-id.jsonl'),
    sessionIdBasename: 'updates-no-session-id',
  });
  assert.equal(sample.vendorSessionId, 'updates-no-session-id');
});

test('a worktree cwd with an issue number yields joinHints.issueNumber, never a path string', () => {
  const { sample, joinHints } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-issue-worktree-cwd.jsonl'),
  });
  assert.deepEqual(joinHints, { issueNumber: 4242 });
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\//);
});

test('adapter output never carries a leaked secret or absolute path from raw records', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-sensitive-fields.jsonl'),
  });
  const serialized = JSON.stringify(sample);
  assert.doesNotMatch(serialized, /ghp_/);
  assert.doesNotMatch(serialized, /\.ssh/);
  assert.doesNotMatch(serialized, /\/home\//);
  assert.equal(sample.vendorSessionId, 'grok-sensitive-0006');
});

test('subagent updates.jsonl records are summed into the parent usage and includesSubagents is set', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-basic.jsonl'),
    signals: readFixtureJson('signals-basic.json'),
    subagentUpdateRecords: [readFixtureRecords('updates-subagent.jsonl')],
  });
  assert.equal(sample.includesSubagents, true);
  assert.deepEqual(sample.usage, {
    inputUncached: 2000 + 200,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 800 + 40,
    reasoning: 300 + 5,
  });
});

test('includesSubagents is true even when a subagent directory has no harvestable updates.jsonl -- #2289 (Copilot)', () => {
  // A subagent session directory existed (the caller pushed an entry),
  // even though its updates.jsonl was missing/unreadable/empty. Presence
  // of the directory, not usage data, drives includesSubagents.
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-basic.jsonl'),
    signals: readFixtureJson('signals-basic.json'),
    subagentUpdateRecords: [[]],
  });
  assert.equal(sample.includesSubagents, true);
  assert.deepEqual(sample.usage, {
    inputUncached: 2000,
    cacheRead: 12000,
    cacheCreation: 1000,
    output: 800,
    reasoning: 300,
  });
});

test('harvest ignores a non-array inner subagentUpdateRecords element instead of throwing -- #2289 (CodeRabbit)', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: readFixtureRecords('updates-basic.jsonl'),
    // The outer array passes Array.isArray; the inner element does not.
    subagentUpdateRecords: [123, readFixtureRecords('updates-subagent.jsonl')],
  });
  assert.equal(sample.includesSubagents, true);
  assert.equal(sample.usage.inputUncached, 2000 + 200);
});

test('parseGrokSessionLines tolerates a truncated trailing line', () => {
  const records = parseGrokSessionLines(
    '{"type":"session_start","cwd":"/x/idd-skill"}\n{"type":"agent_message_c',
  );
  assert.equal(records.length, 1);
});

test('isIddSkillCwd only matches an idd-skill cwd', () => {
  assert.equal(isIddSkillCwd('/home/me/ghq/github.com/x/idd-skill'), true);
  assert.equal(
    isIddSkillCwd('/home/me/ghq/github.com/x/some-other-repo'),
    false,
  );
  assert.equal(isIddSkillCwd(undefined), false);
});

test('decodeGrokEncodedCwd decodes a URL-encoded working directory, and passes an invalid segment through unchanged', () => {
  assert.equal(
    decodeGrokEncodedCwd(
      encodeURIComponent('/home/testuser/ghq/github.com/kurone-kito/idd-skill'),
    ),
    '/home/testuser/ghq/github.com/kurone-kito/idd-skill',
  );
  assert.equal(decodeGrokEncodedCwd('not%encoded%'), 'not%encoded%');
});

test('harvest rejects an input that is not { updateRecords: unknown[] }', () => {
  assert.throws(() => grokAdapter.harvest('not an object'), /updateRecords/);
  assert.throws(
    () => grokAdapter.harvest({ updateRecords: 'not an array' }),
    /updateRecords/,
  );
});

test('harvest fails closed when no record has a valid timestamp', () => {
  assert.throws(
    () =>
      grokAdapter.harvest({
        updateRecords: [{ type: 'session_start', sessionId: 'sess-x' }],
      }),
    /timestamp/,
  );
});

test('harvest fails closed when no vendorSessionId is derivable', () => {
  assert.throws(
    () =>
      grokAdapter.harvest({
        updateRecords: [{ timestamp: '2026-08-26T00:00:00.000Z' }],
      }),
    /vendorSessionId/,
  );
});

test('a path-shaped sessionId is normalized with basename() before redaction, so a session with an unusual but legitimate id still harvests -- #2289 (CodeRabbit)', () => {
  const { sample } = grokAdapter.harvest({
    updateRecords: [
      {
        timestamp: '2026-08-26T00:00:00.000Z',
        sessionId: '/tmp/leaked-path-session-id',
        type: 'session_start',
      },
    ],
  });
  assert.equal(sample.vendorSessionId, 'leaked-path-session-id');
});

test('harvest fails closed when redaction still strips a secret-shaped vendorSessionId (basename() does not change it), rather than returning a sample missing a required field -- #2289 (CodeRabbit)', () => {
  assert.throws(
    () =>
      grokAdapter.harvest({
        updateRecords: [
          {
            timestamp: '2026-08-26T00:00:00.000Z',
            sessionId: 'ghp_abcdefghijklmnopqrstuvwx',
            type: 'session_start',
          },
        ],
      }),
    /vendorSessionId/,
  );
});

function writeSessionDir(
  sessionsDir: string,
  encodedCwd: string,
  sessionId: string,
  fixtureName: string,
  extras?: { signalsJson?: unknown; eventsFixtureName?: string },
): string {
  const sessionDir = join(sessionsDir, encodedCwd, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, 'updates.jsonl'),
    readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8'),
  );
  if (extras?.signalsJson !== undefined) {
    writeFileSync(
      join(sessionDir, 'signals.json'),
      JSON.stringify(extras.signalsJson),
    );
  }
  if (extras?.eventsFixtureName) {
    writeFileSync(
      join(sessionDir, 'events.jsonl'),
      readFileSync(join(FIXTURE_DIR, extras.eventsFixtureName), 'utf8'),
    );
  }
  return sessionDir;
}

test('scanGrokSessions keeps an idd-skill session and skips a non-idd-skill session, decoding the encoded-cwd directory name', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-grok-test-'),
  );
  const iddCwd = '/home/testuser/ghq/github.com/kurone-kito/idd-skill';
  const otherCwd = '/home/testuser/ghq/github.com/kurone-kito/some-other-repo';
  writeSessionDir(
    sandbox,
    encodeURIComponent(iddCwd),
    'grok-basic-0001',
    'updates-basic.jsonl',
    { signalsJson: readFixtureJson('signals-basic.json') },
  );
  writeSessionDir(
    sandbox,
    encodeURIComponent(otherCwd),
    'grok-other-0008',
    'updates-other-repo-cwd.jsonl',
  );

  const results = scanGrokSessions({ sessionsDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'grok-basic-0001');
});

test('scanGrokSessions rolls a subagents/ subdirectory into the parent sample', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-grok-test-'),
  );
  const iddCwd = '/home/testuser/ghq/github.com/kurone-kito/idd-skill';
  const sessionDir = writeSessionDir(
    sandbox,
    encodeURIComponent(iddCwd),
    'grok-basic-0001',
    'updates-basic.jsonl',
    { signalsJson: readFixtureJson('signals-basic.json') },
  );
  const subagentDir = join(sessionDir, 'subagents', 'grok-subagent-child-0009');
  mkdirSync(subagentDir, { recursive: true });
  writeFileSync(
    join(subagentDir, 'updates.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'updates-subagent.jsonl'), 'utf8'),
  );

  const results = scanGrokSessions({ sessionsDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.includesSubagents, true);
  assert.equal(results[0].sample.usage.inputUncached, 2000 + 200);
});

test('scanGrokSessions skips a malformed session that fails to harvest, keeping the rest', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-grok-test-'),
  );
  const iddCwd = '/home/testuser/ghq/github.com/kurone-kito/idd-skill';
  const malformedDir = join(sandbox, encodeURIComponent(iddCwd), 'grok-bad');
  mkdirSync(malformedDir, { recursive: true });
  // Matches the idd-skill cwd filter but has no valid timestamp anywhere,
  // so harvest() throws for this session specifically.
  writeFileSync(
    join(malformedDir, 'updates.jsonl'),
    '{"type":"session_start","sessionId":"grok-bad"}\n',
  );
  writeSessionDir(
    sandbox,
    encodeURIComponent(iddCwd),
    'grok-basic-0001',
    'updates-basic.jsonl',
  );

  const results = scanGrokSessions({ sessionsDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'grok-basic-0001');
});

// Skipped on Windows (#2580): `chmodSync(file, 0o000)` doesn't block a
// subsequent `readFileSync` there -- verified empirically, Windows' own
// read-only attribute (the closest analogue chmodSync can set) blocks
// writes only, never reads, and an explicit `icacls ... /deny` ACE
// doesn't block the read either for an administrator-class account
// (the common case for CI runners too). POSIX/Linux CI stays the
// authoritative coverage for this POSIX-permission-semantics check,
// unaffected by this skip.
test('scanGrokSessions skips an unreadable updates.jsonl, keeping the rest', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-grok-test-'),
  );
  const iddCwd = '/home/testuser/ghq/github.com/kurone-kito/idd-skill';
  const unreadableDir = writeSessionDir(
    sandbox,
    encodeURIComponent(iddCwd),
    'grok-unreadable',
    'updates-basic.jsonl',
  );
  const unreadableFile = join(unreadableDir, 'updates.jsonl');
  chmodSync(unreadableFile, 0o000);
  writeSessionDir(
    sandbox,
    encodeURIComponent(iddCwd),
    'grok-exclusive-0002',
    'updates-exclusive-input.jsonl',
  );

  try {
    const results = scanGrokSessions({ sessionsDir: sandbox });
    assert.equal(results.length, 1);
    assert.equal(results[0].sample.vendorSessionId, 'grok-exclusive-0002');
  } finally {
    chmodSync(unreadableFile, 0o644);
  }
});

test('scanGrokSessions on an empty directory returns no results', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-grok-test-'),
  );
  assert.deepEqual(scanGrokSessions({ sessionsDir: sandbox }), []);
});
