import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { trackTempDirectories } from './temp-fixtures.mts';

// #4049: every fixture directory below is removed when the file finishes.
const makeTempDir = trackTempDirectories();

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
  assert.equal(sample.turnCount, 2);
  assert.equal(sample.toolCallCount, 0);
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

test('turnCount counts requests; toolCallCount sums tool_use blocks across all records', () => {
  const { sample } = harvestFixture('session-tool-calls.jsonl');
  // 2 assistant records, each its own request (distinct message.id values):
  // the first carries 2 tool_use blocks, the second none.
  assert.equal(sample.turnCount, 2);
  assert.equal(sample.toolCallCount, 2);
  assert.deepEqual(
    validate(sample, loadJson('schemas/token-cost-sample.schema.json')),
    [],
  );
});

/** Counter that keeps the `tool_use` ids the helper mints unique across records (#4383). */
let mintedToolUseIds = 0;

/**
 * An inline Claude assistant record for the request-grouping tests (#4380).
 * Without `toolUseIds`, `toolUses` blocks get ids no other record reuses
 * (#4383). With it (#4383), each entry sets one block's id, and `null` or
 * `''` leaves that block without a usable id.
 */
function assistantRecord(options: {
  timestamp?: string;
  requestId?: string;
  messageId?: string;
  model?: string;
  usage?: { input: number; output: number; cacheRead?: number };
  toolUses?: number;
  toolUseIds?: readonly (string | null)[];
}): Record<string, unknown> {
  const toolUseIds =
    options.toolUseIds ??
    Array.from({ length: options.toolUses ?? 0 }, () => {
      mintedToolUseIds += 1;
      return `tool-${mintedToolUseIds}`;
    });
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: toolUseIds.map((id) =>
      id === null
        ? { type: 'tool_use', name: 'Bash' }
        : { type: 'tool_use', id, name: 'Bash' },
    ),
  };
  if (options.messageId !== undefined) {
    message.id = options.messageId;
  }
  if (options.model !== undefined) {
    message.model = options.model;
  }
  if (options.usage !== undefined) {
    message.usage = {
      input_tokens: options.usage.input,
      output_tokens: options.usage.output,
      cache_read_input_tokens: options.usage.cacheRead ?? 0,
      cache_creation_input_tokens: 0,
    };
  }
  const record: Record<string, unknown> = { type: 'assistant', message };
  if (options.timestamp !== undefined) {
    record.timestamp = options.timestamp;
  }
  if (options.requestId !== undefined) {
    record.requestId = options.requestId;
  }
  return record;
}

test('records sharing a requestId count their usage once and make one turn (#4380)', () => {
  const usage = { input: 2, output: 7, cacheRead: 100 };
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-A',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage,
      }),
      assistantRecord({
        requestId: 'req-A',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage,
      }),
      assistantRecord({
        requestId: 'req-A',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage,
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 2,
    cacheRead: 100,
    cacheCreation: 0,
    output: 7,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
});

test('records with different requestIds count as separate requests that add up (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-A',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 2, output: 7, cacheRead: 100 },
      }),
      assistantRecord({
        requestId: 'req-B',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 3, output: 4, cacheRead: 50 },
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 5,
    cacheRead: 150,
    cacheCreation: 0,
    output: 11,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 2);
});

test('streaming snapshots of one request take the field-wise maximum (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-S',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 2, output: 7, cacheRead: 100 },
      }),
      assistantRecord({
        requestId: 'req-S',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 2, output: 7, cacheRead: 100 },
      }),
      assistantRecord({
        requestId: 'req-S',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 4, output: 330, cacheRead: 300 },
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 4,
    cacheRead: 300,
    cacheCreation: 0,
    output: 330,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
});

test('a non-monotone request takes the field-wise maximum, not its last record (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-M',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 10, output: 5 },
      }),
      assistantRecord({
        requestId: 'req-M',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 8, output: 9 },
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 10,
    cacheRead: 0,
    cacheCreation: 0,
    output: 9,
    reasoning: 0,
  });
});

test('message.id groups records that carry no requestId, and a record with neither identifier counts alone (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        messageId: 'msg-B',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 1, output: 1 },
      }),
      assistantRecord({
        messageId: 'msg-B',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 1, output: 2 },
      }),
      assistantRecord({
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 1, output: 5 },
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 2,
    cacheRead: 0,
    cacheCreation: 0,
    output: 7,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 2);
});

test('records sharing a requestId but carrying different message.ids are separate requests, as in a silent retry (#4380)', () => {
  // Two responses under one requestId (Claude Code issue #46398): msg-1
  // has two records with the same usage, which count once, and msg-2 is its
  // own request.
  const usage = { input: 2, output: 7, cacheRead: 100 };
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-R',
        messageId: 'msg-1',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage,
      }),
      assistantRecord({
        requestId: 'req-R',
        messageId: 'msg-1',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage,
      }),
      assistantRecord({
        requestId: 'req-R',
        messageId: 'msg-2',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage,
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.equal(sample.turnCount, 2);
  assert.deepEqual(sample.usage, {
    inputUncached: 4,
    cacheRead: 200,
    cacheCreation: 0,
    output: 14,
    reasoning: 0,
  });
});

test('a record that carries only a requestId is not joined to records that carry both identifiers (a known limit, #4380)', () => {
  // A known limit, pinned here: none is observed in the local logs.
  const usage = { input: 2, output: 7, cacheRead: 100 };
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-K',
        messageId: 'msg-K',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage,
      }),
      assistantRecord({
        requestId: 'req-K',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage,
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.equal(sample.turnCount, 2);
  assert.equal(sample.usage.inputUncached, 4);
});

test('turnCount counts distinct requests, and toolCallCount sums tool_use blocks across all their records (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-T',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 1, output: 1 },
        toolUses: 2,
      }),
      assistantRecord({
        requestId: 'req-T',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 1, output: 1 },
        toolUses: 1,
      }),
      assistantRecord({
        requestId: 'req-U',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 1, output: 1 },
        toolUses: 1,
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.equal(sample.turnCount, 2);
  assert.equal(sample.toolCallCount, 4);
});

test('usage on a record without a valid timestamp still counts in the session usage (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-V',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 2, output: 0 },
      }),
      assistantRecord({ requestId: 'req-W', usage: { input: 3, output: 0 } }),
      assistantRecord({ requestId: 'req-W', usage: { input: 3, output: 0 } }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  // req-W's two untimed records carry the same usage, so it counts once.
  assert.equal(sample.usage.inputUncached, 5);
  assert.equal(sample.turnCount, 2);
});

test('an empty requestId falls back to message.id, so the two records form one request (#4380)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      {
        ...assistantRecord({
          messageId: 'msg-X',
          timestamp: '2026-08-20T10:00:01.000Z',
          usage: { input: 1, output: 1 },
        }),
        requestId: '',
      },
      assistantRecord({
        messageId: 'msg-X',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 1, output: 1 },
      }),
    ],
    fileBasename: 'grouping.jsonl',
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.usage.inputUncached, 1);
});

/** A timestamped user row: the session file's own record when its subagents carry the requests (#4383). */
function userRecord(timestamp: string): Record<string, unknown> {
  return {
    type: 'user',
    timestamp,
    message: { role: 'user', content: 'hello' },
  };
}

test('subagentRecords from two agents add their distinct requests to usage, turnCount and toolCallCount (#4383)', () => {
  // The flat subagentRecords array holds the lines of both agents' transcripts.
  const { sample } = claudeAdapter.harvest({
    records: [
      userRecord('2026-08-20T10:00:00.000Z'),
      assistantRecord({
        requestId: 'req-P',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 1, output: 2, cacheRead: 3 },
        toolUses: 1,
      }),
    ],
    subagentRecords: [
      assistantRecord({
        requestId: 'req-A',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 10, output: 20, cacheRead: 30 },
        toolUses: 2,
      }),
      assistantRecord({
        requestId: 'req-B',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 100, output: 200, cacheRead: 300 },
        toolUses: 1,
      }),
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 111,
    cacheRead: 333,
    cacheCreation: 0,
    output: 222,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 3);
  assert.equal(sample.toolCallCount, 4);
  assert.equal(sample.includesSubagents, true);
});

test('streaming snapshots inside subagentRecords take the field-wise maximum and make one turn (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [userRecord('2026-08-20T10:00:00.000Z')],
    subagentRecords: [
      assistantRecord({
        requestId: 'req-SS',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 2, output: 7, cacheRead: 100 },
      }),
      assistantRecord({
        requestId: 'req-SS',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 2, output: 7, cacheRead: 100 },
      }),
      assistantRecord({
        requestId: 'req-SS',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 4, output: 330, cacheRead: 300 },
      }),
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 4,
    cacheRead: 300,
    cacheCreation: 0,
    output: 330,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.includesSubagents, true);
});

test('a fork transcript repeats its parent request: the per-field maximum counts once and a repeated tool_use id counts once (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-F',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 5, output: 3, cacheRead: 10 },
        toolUseIds: ['tool-shared'],
      }),
    ],
    subagentRecords: [
      {
        ...assistantRecord({
          requestId: 'req-F',
          timestamp: '2026-08-20T10:00:02.000Z',
          usage: { input: 2, output: 9, cacheRead: 10 },
          toolUseIds: ['tool-shared'],
        }),
        isSidechain: true,
      },
    ],
    fileBasename: 'session-4383.jsonl',
  });
  // Input is higher in the parent record and output in the fork record.
  assert.deepEqual(sample.usage, {
    inputUncached: 5,
    cacheRead: 10,
    cacheCreation: 0,
    output: 9,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.toolCallCount, 1);
  assert.equal(sample.includesSubagents, true);
});

test('two subagents repeating one request with different tool_use ids count those ids apart, and blocks without a usable id count on their own (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [userRecord('2026-08-20T10:00:00.000Z')],
    subagentRecords: [
      assistantRecord({
        requestId: 'req-G',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 1, output: 1 },
        toolUseIds: ['tool-a1'],
      }),
      assistantRecord({
        requestId: 'req-G',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 1, output: 1 },
        toolUseIds: ['tool-a2', null, ''],
      }),
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.usage.inputUncached, 1);
  // tool-a1 and tool-a2 are two distinct ids; the null and empty ids each
  // count on their own.
  assert.equal(sample.toolCallCount, 4);
});

test('non-assistant and non-object subagentRecords entries are ignored beside a valid subagent request (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [userRecord('2026-08-20T10:00:00.000Z')],
    subagentRecords: [
      { type: 'fork-context-ref' },
      {
        type: 'user',
        timestamp: '2026-08-20T10:00:01.000Z',
        message: { role: 'user', content: 'SUBAGENT-USER-TEXT-4383' },
      },
      null,
      42,
      'a string entry',
      [
        assistantRecord({
          requestId: 'req-N',
          timestamp: '2026-08-20T10:00:02.000Z',
          usage: { input: 900, output: 900 },
        }),
      ],
      assistantRecord({
        requestId: 'req-V',
        timestamp: '2026-08-20T10:00:03.000Z',
        usage: { input: 6, output: 7 },
      }),
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.deepEqual(sample.usage, {
    inputUncached: 6,
    cacheRead: 0,
    cacheCreation: 0,
    output: 7,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.includesSubagents, true);
  assert.doesNotMatch(JSON.stringify(sample), /SUBAGENT-USER-TEXT-4383/);
});

test('subagent records leave model, timestamps, compactionCount, cwd and join hints to the session file (#4383)', () => {
  const sessionRecords = [
    {
      type: 'user',
      sessionId: 'sess-meta-4383',
      cwd: '/work/idd-skill.issue-4001-session',
      timestamp: '2026-08-20T10:00:00.000Z',
      message: { role: 'user', content: 'hello' },
    },
    assistantRecord({
      requestId: 'req-M1',
      timestamp: '2026-08-20T10:00:01.000Z',
      usage: { input: 1, output: 1 },
      model: 'claude-sonnet-5',
    }),
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-08-20T10:00:02.000Z',
    },
  ];
  const subagentRecords = [
    {
      ...assistantRecord({
        requestId: 'req-SM',
        timestamp: '2026-08-19T09:00:00.000Z',
        usage: { input: 50, output: 60 },
        model: 'claude-haiku-5-5',
      }),
      isSidechain: true,
      cwd: '/work/idd-skill.issue-4383-other',
    },
    {
      ...assistantRecord({
        requestId: 'req-SN',
        timestamp: '2026-08-21T11:00:00.000Z',
        usage: { input: 7, output: 8 },
        model: 'claude-haiku-5-5',
      }),
      isSidechain: true,
      cwd: '/work/idd-skill.issue-4383-other',
    },
    {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: '2026-08-21T12:00:00.000Z',
    },
  ];
  const without = claudeAdapter.harvest({
    records: sessionRecords,
    fileBasename: 'session-4383.jsonl',
  });
  const withSubagents = claudeAdapter.harvest({
    records: sessionRecords,
    subagentRecords,
    fileBasename: 'session-4383.jsonl',
  });
  assert.equal(withSubagents.sample.model, 'claude-sonnet-5');
  assert.equal(withSubagents.sample.model, without.sample.model);
  assert.equal(withSubagents.sample.startedAt, without.sample.startedAt);
  assert.equal(withSubagents.sample.endedAt, without.sample.endedAt);
  assert.equal(withSubagents.sample.compactionCount, 1);
  assert.equal(
    withSubagents.sample.compactionCount,
    without.sample.compactionCount,
  );
  assert.equal(
    withSubagents.sample.vendorSessionId,
    without.sample.vendorSessionId,
  );
  assert.deepEqual(withSubagents.joinHints, { issueNumber: 4001 });
  assert.deepEqual(withSubagents.joinHints, without.joinHints);
  // The subagent requests are counted on top of the session's own.
  assert.equal(
    withSubagents.sample.usage.inputUncached,
    without.sample.usage.inputUncached + 57,
  );
  assert.equal(
    withSubagents.sample.usage.output,
    without.sample.usage.output + 68,
  );
  assert.equal(without.sample.turnCount, 1);
  assert.equal(withSubagents.sample.turnCount, 3);
  assert.equal(withSubagents.sample.includesSubagents, true);
  assert.equal(without.sample.includesSubagents, false);
});

test('a subagent record holding prompt text and a file path leaves neither in the sample (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [userRecord('2026-08-20T10:00:00.000Z')],
    subagentRecords: [
      {
        type: 'assistant',
        isSidechain: true,
        requestId: 'req-PT',
        timestamp: '2026-08-20T10:00:02.000Z',
        message: {
          id: 'msg-PT',
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            { type: 'text', text: 'PROMPT-MARKER-4383 rewrite the adapter' },
            {
              type: 'tool_use',
              id: 'tool-pt',
              name: 'Read',
              input: { file_path: '/home/someone/secret-dir-4383/notes.md' },
            },
          ],
          usage: {
            input_tokens: 3,
            output_tokens: 4,
            cache_read_input_tokens: 5,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.doesNotMatch(
    JSON.stringify(sample),
    /PROMPT-MARKER-4383|secret-dir-4383|notes\.md|\/home\//,
  );
  assert.deepEqual(sample.usage, {
    inputUncached: 3,
    cacheRead: 5,
    cacheCreation: 0,
    output: 4,
    reasoning: 0,
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.toolCallCount, 1);
  assert.equal(sample.includesSubagents, true);
});

test('subagentRecords holding only non-assistant rows leaves includesSubagents false and the session result unchanged (#4383)', () => {
  const records = readFixtureRecords('session-no-sidechain.jsonl');
  const baseline = claudeAdapter.harvest({
    records,
    fileBasename: 'session-no-sidechain.jsonl',
  });
  const result = claudeAdapter.harvest({
    records,
    fileBasename: 'session-no-sidechain.jsonl',
    subagentRecords: [
      { type: 'fork-context-ref' },
      {
        type: 'user',
        timestamp: '2026-08-20T10:00:05.000Z',
        message: { role: 'user', content: 'x' },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-08-20T10:00:06.000Z',
      },
    ],
  });
  assert.equal(result.sample.includesSubagents, false);
  assert.deepEqual(result, baseline);
});

test('an absent, empty, or non-array subagentRecords returns the same harvest result as before (#4383)', () => {
  const records = readFixtureRecords('session-basic.jsonl');
  const baseline = claudeAdapter.harvest({
    records,
    fileBasename: 'session-basic.jsonl',
  });
  const variants: unknown[] = [
    undefined,
    [],
    null,
    'not-an-array',
    7,
    {
      0: assistantRecord({
        requestId: 'req-O',
        timestamp: '2026-08-20T10:00:05.000Z',
        usage: { input: 99, output: 99 },
      }),
    },
  ];
  for (const subagentRecords of variants) {
    assert.deepEqual(
      claudeAdapter.harvest({
        records,
        fileBasename: 'session-basic.jsonl',
        subagentRecords,
      }),
      baseline,
    );
  }
});

test('a tool_use id repeated within records counts once in toolCallCount (#4383)', () => {
  const { sample } = claudeAdapter.harvest({
    records: [
      assistantRecord({
        requestId: 'req-RD',
        timestamp: '2026-08-20T10:00:01.000Z',
        usage: { input: 1, output: 1 },
        toolUseIds: ['tool-dup'],
      }),
      assistantRecord({
        requestId: 'req-RD',
        timestamp: '2026-08-20T10:00:02.000Z',
        usage: { input: 1, output: 1 },
        toolUseIds: ['tool-dup'],
      }),
    ],
    fileBasename: 'session-4383.jsonl',
  });
  assert.equal(sample.turnCount, 1);
  assert.equal(sample.toolCallCount, 1);
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

test('an empty-string vendorSessionIdOverride is ignored, falling back to extractSessionId (Copilot review finding, PR #2627)', () => {
  // A `??`-based fallback treats '' as authoritative (unlike undefined),
  // which would otherwise produce a malformed vendorSessionId like
  // '#ew501' with no real base -- asClaudeHarvestInput must reject an
  // empty override the same way extractSessionId/deriveFallbackSessionId
  // already reject an empty sessionId/fileBasename.
  const { sample } = claudeAdapter.harvest({
    records: [
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00Z',
        sessionId: 'sess-real-0001',
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
    vendorSessionIdOverride: '',
  });
  assert.equal(sample.vendorSessionId, 'sess-real-0001#ew501');
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
  const sandbox = makeTempDir(
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
  const sandbox = makeTempDir(
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
  const sandbox = makeTempDir(
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
  const sandbox = makeTempDir(
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
  const sandbox = makeTempDir(
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
