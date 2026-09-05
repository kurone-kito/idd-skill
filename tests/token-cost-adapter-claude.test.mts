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
  extractRecordTimestampMs,
  parseClaudeProjectLines,
  scanClaudeSessions,
  segmentRecordsByCwd,
} from '../src/scripts/token-cost-adapter-claude.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const FIXTURE_DIR = 'tests/fixtures/token-cost/claude';

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
  assert.equal(Object.hasOwn(sample, 'cwd'), false);
  assert.equal(Object.hasOwn(sample, 'gitBranch'), false);
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\//);
  assert.deepEqual(
    validate(sample, loadJson('schemas/token-cost-sample.schema.json')),
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

test('a non-system record with a compact-shaped subtype is not counted as a compaction', () => {
  const { sample } = harvestFixture('session-non-system-compact-subtype.jsonl');
  assert.equal(sample.compactionCount, 0);
});

test('a missing top-level sessionId falls back to the project filename', () => {
  const { sample } = harvestFixture('session-no-session-id.jsonl');
  assert.equal(sample.vendorSessionId, 'session-no-session-id');
});

test('a path-shaped fileBasename falls back to just its basename, not the full path', () => {
  const { sample } = claudeAdapter.harvest({
    records: readFixtureRecords('session-no-session-id.jsonl'),
    fileBasename: '/some/caller/mistake/session-no-session-id.jsonl',
  });
  assert.equal(sample.vendorSessionId, 'session-no-session-id');
});

test('a worktree cwd with an issue number yields joinHints.issueNumber, never a path string', () => {
  const { sample, joinHints } = harvestFixture(
    'session-issue-worktree-cwd.jsonl',
  );
  assert.deepEqual(joinHints, { issueNumber: 4242 });
  assert.doesNotMatch(JSON.stringify(sample), /ghq|\/home\/|issue\/4242/);
});

test('issueNumberOverride supplies joinHints.issueNumber even when cwd-inference would fail -- #2418', () => {
  const { sample, joinHints } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-ew-0001',
        cwd: '/repo',
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
    issueNumberOverride: 501,
  });
  assert.deepEqual(joinHints, { issueNumber: 501 });
  assert.equal(sample.vendorSessionId, 'sess-ew-0001#ew501');
});

test('issueNumberOverride takes priority over a real cwd-inferable issue number', () => {
  const { joinHints, sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-ew-0002',
        cwd: '/repo.issue-4242-x',
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
    issueNumberOverride: 999,
  });
  assert.deepEqual(joinHints, { issueNumber: 999 });
  assert.equal(sample.vendorSessionId, 'sess-ew-0002#ew999');
});

test('segmentIndex is ignored (not appended) when issueNumberOverride is also present', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-ew-0003',
        cwd: '/repo',
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
    segmentIndex: 7,
    issueNumberOverride: 501,
  });
  assert.equal(sample.vendorSessionId, 'sess-ew-0003#ew501');
});

test('vendorSessionIdOverride wins over extractSessionId, e.g. when records from a second file were merged in (#2432)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        // A DIFFERENT session's own id -- simulates a contributing
        // handoff session's record concatenated in ahead of the primary
        // file's own records.
        sessionId: 'sess-contributor-0001',
        cwd: '/repo',
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
    issueNumberOverride: 501,
    vendorSessionIdOverride: 'sess-primary-0001',
  });
  assert.equal(sample.vendorSessionId, 'sess-primary-0001#ew501');
});

test('vendorSessionIdOverride wins over the fileBasename fallback too', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        cwd: '/repo',
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
    fileBasename: 'session-contributor.jsonl',
    issueNumberOverride: 501,
    vendorSessionIdOverride: 'sess-primary-0002',
  });
  assert.equal(sample.vendorSessionId, 'sess-primary-0002#ew501');
});

test('no issueNumberOverride and no cwd: behavior is unchanged from before #2418', () => {
  const { joinHints, sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-plain-0001',
        cwd: '/repo',
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
  });
  assert.equal(joinHints, undefined);
  assert.equal(sample.vendorSessionId, 'sess-plain-0001');
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
    join(tmpdir(), 'idd-token-cost-adapter-claude-test-'),
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
    join(tmpdir(), 'idd-token-cost-adapter-claude-test-'),
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
    join(tmpdir(), 'idd-token-cost-adapter-claude-test-'),
  );
  mkdirSync(sandbox, { recursive: true });
  assert.deepEqual(scanClaudeSessions({ projectDir: sandbox }), []);
});

test("extractRecordTimestampMs: reads a record's own valid timestamp -- #2418", () => {
  assert.equal(
    extractRecordTimestampMs({ timestamp: '2026-01-01T00:00:00Z' }),
    Date.parse('2026-01-01T00:00:00Z'),
  );
});

test('extractRecordTimestampMs: undefined for a missing, malformed, or non-string timestamp', () => {
  assert.equal(extractRecordTimestampMs({}), undefined);
  assert.equal(
    extractRecordTimestampMs({ timestamp: 'not-a-date' }),
    undefined,
  );
  assert.equal(extractRecordTimestampMs({ timestamp: 12345 }), undefined);
  assert.equal(extractRecordTimestampMs('not an object'), undefined);
  assert.equal(extractRecordTimestampMs(null), undefined);
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

test('segmentRecordsByCwd groups records into one segment per contiguous cwd -- #2404', () => {
  const records = readFixtureRecords('session-multi-cwd-segments.jsonl');
  const segments = segmentRecordsByCwd(records);
  assert.equal(segments.length, 3);
  assert.equal(
    segments[0].cwd,
    '/home/testuser/ghq/github.com/kurone-kito/idd-skill',
  );
  assert.equal(segments[0].records.length, 2);
  assert.equal(
    segments[1].cwd,
    '/home/testuser/ghq/github.com/kurone-kito/idd-skill.issue-4343-some-feature',
  );
  assert.equal(segments[1].records.length, 2);
  assert.equal(
    segments[2].cwd,
    '/home/testuser/ghq/github.com/kurone-kito/idd-skill',
  );
  assert.equal(segments[2].records.length, 1);
});

test('segmentRecordsByCwd returns exactly one segment for a single-cwd file, matching the pre-existing whole-file grouping -- #2404', () => {
  const records = readFixtureRecords('session-basic.jsonl');
  const segments = segmentRecordsByCwd(records);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].records.length, records.length);
});

test('segmentRecordsByCwd keeps a cwd-less record in whichever segment is currently open -- #2404', () => {
  const records = [
    { type: 'user', cwd: '/repo/a' },
    { type: 'system', subtype: 'turn_duration' }, // no cwd field at all
    { type: 'assistant', cwd: '/repo/a' },
    { type: 'assistant', cwd: '/repo/b' },
  ];
  const segments = segmentRecordsByCwd(records);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].cwd, '/repo/a');
  assert.equal(segments[0].records.length, 3);
  assert.equal(segments[1].cwd, '/repo/b');
  assert.equal(segments[1].records.length, 1);
});

test('scanClaudeSessions splits a multi-cwd file into one correctly-scoped sample per worktree segment -- #2404', () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-claude-test-'),
  );
  writeFileSync(
    join(sandbox, 'session-multi.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'session-multi-cwd-segments.jsonl'), 'utf8'),
  );

  const results = scanClaudeSessions({ projectDir: sandbox });

  assert.equal(results.length, 3);
  // Segments from the same file get distinct, deterministic
  // vendorSessionIds so they never collide under the harvester's
  // (vendor, vendorSessionId) dedup key.
  const ids = results.map((r) => r.sample.vendorSessionId).sort();
  assert.deepEqual(ids, [
    'sess-claude-multi-cwd-0001#0',
    'sess-claude-multi-cwd-0001#1',
    'sess-claude-multi-cwd-0001#2',
  ]);

  const byId = new Map(results.map((r) => [r.sample.vendorSessionId, r]));
  const primarySegment0 = byId.get('sess-claude-multi-cwd-0001#0');
  const issueSegment = byId.get('sess-claude-multi-cwd-0001#1');
  const primarySegment2 = byId.get('sess-claude-multi-cwd-0001#2');

  // The primary-repo segments never resolve an issue number.
  assert.equal(primarySegment0?.joinHints, undefined);
  assert.equal(primarySegment2?.joinHints, undefined);
  assert.deepEqual(primarySegment0?.sample.usage, {
    inputUncached: 10,
    cacheRead: 50,
    cacheCreation: 0,
    output: 2,
    reasoning: 0,
  });
  assert.equal(primarySegment0?.sample.startedAt, '2026-08-25T09:00:00.000Z');
  assert.equal(primarySegment0?.sample.endedAt, '2026-08-25T09:00:05.000Z');

  // Only the issue/4343-* worktree segment resolves an issue number, and
  // its usage/timestamps are scoped to just its own two records -- not
  // the whole file's five.
  assert.deepEqual(issueSegment?.joinHints, { issueNumber: 4343 });
  assert.deepEqual(issueSegment?.sample.usage, {
    inputUncached: 9,
    cacheRead: 35,
    cacheCreation: 5,
    output: 4,
    reasoning: 0,
  });
  assert.equal(issueSegment?.sample.startedAt, '2026-08-25T09:05:00.000Z');
  assert.equal(issueSegment?.sample.endedAt, '2026-08-25T09:06:00.000Z');
  assert.doesNotMatch(
    JSON.stringify(issueSegment?.sample),
    /ghq|\/home\/|issue\/4343/,
  );

  assert.equal(primarySegment2?.joinHints, undefined);
  assert.deepEqual(primarySegment2?.sample.usage, {
    inputUncached: 4,
    cacheRead: 10,
    cacheCreation: 0,
    output: 1,
    reasoning: 0,
  });

  // A segment-suffixed vendorSessionId ("...#1") is still a schema-valid
  // sample -- the schema only requires a non-empty string, no pattern
  // restriction.
  const schema = loadJson('schemas/token-cost-sample.schema.json');
  assert.deepEqual(validate(primarySegment0?.sample, schema), []);
  assert.deepEqual(validate(issueSegment?.sample, schema), []);
  assert.deepEqual(validate(primarySegment2?.sample, schema), []);
});

test("scanClaudeSessions leaves a single-cwd file's vendorSessionId without a suffix, unchanged from before #2404", () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), 'idd-token-cost-adapter-claude-test-'),
  );
  writeFileSync(
    join(sandbox, 'session-a.jsonl'),
    readFileSync(join(FIXTURE_DIR, 'session-basic.jsonl'), 'utf8'),
  );

  const results = scanClaudeSessions({ projectDir: sandbox });

  assert.equal(results.length, 1);
  assert.equal(results[0].sample.vendorSessionId, 'sess-claude-basic-0001');
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
