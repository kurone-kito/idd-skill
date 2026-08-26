import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  claudeAdapter,
  defaultClaudeProjectDir,
  defaultClaudeProjectsRoot,
  encodeClaudeProjectDirName,
  parseClaudeProjectLines,
  scanClaudeSessions,
} from '../src/scripts/context-tax-adapter-claude.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const FIXTURE_DIR = 'tests/fixtures/context-tax/claude';

function readFixtureRecords(name: string): unknown[] {
  return parseClaudeProjectLines(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

function harvestFixture(name: string) {
  return claudeAdapter.harvest({
    records: readFixtureRecords(name),
    fileBasename: name,
  });
}

test('two assistant usages sum into a schema-valid sample', () => {
  const { sample, joinHints } = harvestFixture('session-basic.jsonl');
  assert.equal(sample.kind, 'session');
  assert.equal(sample.vendor, 'claude');
  assert.equal(sample.model, 'claude-sonnet-5');
  assert.equal(sample.attribution, 'session-unscoped');
  assert.equal(sample.outcome, 'unknown');
  assert.equal(sample.vendorSessionId, 'sess-claude-basic-0001');
  assert.deepEqual(sample.usage, {
    inputUncached: 15,
    cacheRead: 180,
    cacheCreation: 20,
    output: 7,
    reasoning: 0,
  });
  assert.equal(sample.compactionCount, 0);
  assert.equal(sample.includesSubagents, false);
  assert.equal(sample.startedAt, '2026-08-20T10:00:00.000Z');
  assert.equal(sample.endedAt, '2026-08-20T10:00:10.000Z');
  // The fixture cwd basename ("idd-skill") carries no issue-<n> suffix.
  assert.equal(joinHints, undefined);
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\/|main/);
  assert.deepEqual(
    validate(sample, loadJson('schemas/context-tax-sample.schema.json')),
    [],
  );
});

test('a sidechain row is summed into usage and sets includesSubagents true', () => {
  const { sample } = harvestFixture('session-sidechain.jsonl');
  assert.equal(sample.includesSubagents, true);
  assert.deepEqual(sample.usage, {
    inputUncached: 48,
    cacheRead: 250,
    cacheCreation: 10,
    output: 17,
    reasoning: 0,
  });
});

test('a session with no sidechain row sets includesSubagents false', () => {
  const { sample } = harvestFixture('session-no-sidechain.jsonl');
  assert.equal(sample.includesSubagents, false);
});

test('an ephemeral cache_creation split is summed instead of trusting the stale scalar', () => {
  const { sample } = harvestFixture('session-ephemeral-split.jsonl');
  // cache_creation_input_tokens (999) is deliberately stale; the ephemeral
  // 5m/1h split (300 + 200 = 500) is authoritative.
  assert.equal(sample.usage.cacheCreation, 500);
});

test('three compact_boundary records yield compactionCount 3', () => {
  const { sample } = harvestFixture('session-three-compactions.jsonl');
  assert.equal(sample.compactionCount, 3);
});

test('a missing top-level sessionId falls back to the project filename', () => {
  const { sample } = harvestFixture('session-no-session-id.jsonl');
  assert.equal(sample.vendorSessionId, 'session-no-session-id');
});

test('a worktree cwd with an issue number yields joinHints.issueNumber, never a path string', () => {
  const { sample, joinHints } = harvestFixture(
    'session-issue-worktree-cwd.jsonl',
  );
  assert.deepEqual(joinHints, { issueNumber: 4242 });
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\/|issue\/4242/);
});

test('adapter output never carries a leaked secret, prompt text, or absolute path from raw records', () => {
  const { sample } = harvestFixture('session-sensitive-fields.jsonl');
  const serialized = JSON.stringify(sample);
  assert.doesNotMatch(serialized, /ghp_/);
  assert.doesNotMatch(serialized, /\.ssh/);
  assert.doesNotMatch(serialized, /\/home\//);
  assert.doesNotMatch(serialized, /secret\.env/);
  assert.equal(sample.vendorSessionId, 'sess-claude-sensitive-0001');
});

test('encodeClaudeProjectDirName replaces every non-alphanumeric character with a hyphen', () => {
  assert.equal(
    encodeClaudeProjectDirName('/home/me/ghq/github.com/kurone-kito/idd-skill'),
    '-home-me-ghq-github-com-kurone-kito-idd-skill',
  );
});

test('defaultClaudeProjectDir joins the projects root with the encoded cwd', () => {
  assert.equal(
    defaultClaudeProjectDir('/x/idd-skill'),
    join(defaultClaudeProjectsRoot(), '-x-idd-skill'),
  );
});

test('parseClaudeProjectLines tolerates a truncated trailing line', () => {
  const records = parseClaudeProjectLines(
    '{"type":"user","sessionId":"s-1"}\n{"type":"assist',
  );
  assert.equal(records.length, 1);
});

test('scanClaudeSessions harvests every jsonl file in the project directory', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-context-tax-adapter-claude-test-'),
  );
  writeFileSync(
    join(sandbox, 'session-a.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'session-basic.jsonl'), 'utf8'),
  );
  writeFileSync(
    join(sandbox, 'session-b.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'session-no-sidechain.jsonl'), 'utf8'),
  );

  const results = scanClaudeSessions({ projectDir: sandbox });

  assert.equal(results.length, 2);
  const sessionIds = results.map((r) => r.sample.vendorSessionId).sort();
  assert.deepEqual(sessionIds, [
    'sess-claude-basic-0001',
    'sess-claude-nosidechain-0001',
  ]);
});

test('scanClaudeSessions skips a malformed session that fails to harvest, keeping the rest', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-context-tax-adapter-claude-test-'),
  );
  // No record has a valid timestamp, so harvest() throws for this file
  // specifically.
  writeFileSync(
    join(sandbox, 'malformed.jsonl'),
    '{"type":"assistant","sessionId":"sess-bad","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'kept.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'session-basic.jsonl'), 'utf8'),
  );

  const results = scanClaudeSessions({ projectDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'sess-claude-basic-0001');
});

test('scanClaudeSessions on an empty directory returns no results', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-context-tax-adapter-claude-test-'),
  );
  mkdirSync(sandbox, { recursive: true });
  assert.deepEqual(scanClaudeSessions({ projectDir: sandbox }), []);
});

test('harvest rejects an input that is not { records: unknown[] }', () => {
  assert.throws(() => claudeAdapter.harvest('not an object'), /records/);
  assert.throws(
    () => claudeAdapter.harvest({ records: 'not an array' }),
    /records/,
  );
});

test('harvest fails closed when no record has a valid timestamp', () => {
  assert.throws(
    () =>
      claudeAdapter.harvest({
        records: [
          {
            type: 'assistant',
            sessionId: 'sess-x',
            message: {
              model: 'm',
              usage: {
                input_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                output_tokens: 1,
              },
            },
          },
        ],
      }),
    /timestamp/,
  );
});

test('harvest fails closed when no vendorSessionId is derivable', () => {
  assert.throws(
    () =>
      claudeAdapter.harvest({
        records: [
          {
            type: 'assistant',
            timestamp: '2026-08-26T00:00:00.000Z',
            message: { model: 'm' },
          },
        ],
      }),
    /vendorSessionId/,
  );
});
