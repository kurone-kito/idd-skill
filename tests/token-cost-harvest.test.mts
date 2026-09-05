import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type {
  TokenCostIssueLoopSample,
  TokenCostStageId,
  TokenCostUsage,
} from '../src/scripts/token-cost-core.mts';
import {
  allocateStageUsage,
  buildCompletedIssueWindows,
  buildSample,
  type CompletedIssueWindow,
  computeStageWindows,
  deriveOutcome,
  extractClaudeUsageTimeline,
  extractCodexUsageTimeline,
  fetchIssueLoopGithubContext,
  type HarvestedSample,
  type IssueLoopGithubContext,
  markAmbiguousOverlaps,
  parseRepoFlag,
  readEventWindows,
  readExistingVendorSessionKeys,
  resolveIssueLoopContext,
  resolveTrustedMarkerLogins,
  type StageEventWindow,
  scanClaudeVendorSessions,
  segmentRecordsByEventWindow,
  type VendorSession,
  vendorSessionKey,
} from '../src/scripts/token-cost-harvest.mts';
import { readJson, stubExecutable } from './test-utils.mts';

const ms = (iso: string) => Date.parse(iso);

const ZERO: TokenCostUsage = {
  inputUncached: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  reasoning: 0,
};

function usage(output: number): TokenCostUsage {
  return { ...ZERO, output };
}

function usageSum(...values: TokenCostUsage[]): number {
  return values.reduce(
    (total, v) =>
      total +
      v.inputUncached +
      v.cacheRead +
      v.cacheCreation +
      v.output +
      v.reasoning,
    0,
  );
}

// Stub `gh` on PATH (the tests/gh-exec.test.mts / discover-roadmap-graph.test.mts
// pattern) so the GitHub-join layer runs the real execFileSync + child-process
// contract without network access.
function stubGh(scriptBody: string): () => void {
  return stubExecutable('gh', scriptBody);
}

function stubGhReturningJson(fixture: unknown): () => void {
  return stubGh(
    `process.stdout.write(${JSON.stringify(JSON.stringify(fixture))});`,
  );
}

// ---------------------------------------------------------------------------
// Per-vendor usage timelines
// ---------------------------------------------------------------------------

test('extractClaudeUsageTimeline sums per-message deltas, sorted by timestamp', () => {
  const records = [
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:05:00Z',
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2,
          output_tokens: 5,
        },
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-01-01T00:01:00Z',
      message: {
        usage: {
          input_tokens: 3,
          cache_creation: {
            ephemeral_5m_input_tokens: 4,
            ephemeral_1h_input_tokens: 6,
          },
          output_tokens: 1,
        },
      },
    },
    { type: 'user', timestamp: '2026-01-01T00:02:00Z' },
  ];

  const timeline = extractClaudeUsageTimeline(records);
  assert.equal(timeline.mode, 'delta');
  assert.equal(timeline.points.length, 2);
  assert.equal(timeline.points[0].atMs, ms('2026-01-01T00:01:00Z'));
  assert.deepEqual(timeline.points[0].usage, {
    inputUncached: 3,
    cacheRead: 0,
    cacheCreation: 10,
    output: 1,
    reasoning: 0,
  });
  assert.equal(timeline.points[1].atMs, ms('2026-01-01T00:05:00Z'));
  assert.deepEqual(timeline.points[1].usage, {
    inputUncached: 10,
    cacheRead: 1,
    cacheCreation: 2,
    output: 5,
    reasoning: 0,
  });
});

test('scanClaudeVendorSessions warns (not silently returns []) when projectDir does not exist -- #2439', (t) => {
  const stderrWrite = t.mock.method(process.stderr, 'write', () => true);
  const missingDir = join(
    mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-missing-')),
    'does-not-exist',
  );

  const sessions = scanClaudeVendorSessions(missingDir);

  assert.deepEqual(sessions, []);
  const warnings = stderrWrite.mock.calls
    .map((call) => call.arguments[0])
    .filter(
      (message): message is string =>
        typeof message === 'string' &&
        message.includes('Claude project directory'),
    );
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0],
    new RegExp(missingDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.match(warnings[0], /does not exist/);
  assert.match(warnings[0], /primary worktree/);
});

test("scanClaudeVendorSessions scopes each cwd segment's timeline to just that segment's records -- #2404", () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-test-'));
  writeFileSync(
    join(sandbox, 'session-multi.jsonl'),
    // Mirrors tests/fixtures/token-cost/claude/session-multi-cwd-segments.jsonl:
    // segment 0 (primary repo, one assistant usage), segment 1
    // (issue/4343-* worktree, two assistant usages), segment 2 (back to
    // the primary repo, one assistant usage).
    `${[
      '{"type":"user","timestamp":"2026-08-25T09:00:00.000Z","sessionId":"sess-multi-0001","cwd":"/repo"}',
      '{"type":"assistant","timestamp":"2026-08-25T09:00:05.000Z","sessionId":"sess-multi-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":50,"cache_creation_input_tokens":0,"output_tokens":2}}}',
      '{"type":"assistant","timestamp":"2026-08-25T09:05:00.000Z","sessionId":"sess-multi-0001","cwd":"/repo.issue-4343-x","message":{"model":"m","usage":{"input_tokens":7,"cache_read_input_tokens":30,"cache_creation_input_tokens":5,"output_tokens":3}}}',
      '{"type":"assistant","timestamp":"2026-08-25T09:06:00.000Z","sessionId":"sess-multi-0001","cwd":"/repo.issue-4343-x","message":{"model":"m","usage":{"input_tokens":2,"cache_read_input_tokens":5,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      '{"type":"assistant","timestamp":"2026-08-25T09:10:00.000Z","sessionId":"sess-multi-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":4,"cache_read_input_tokens":10,"cache_creation_input_tokens":0,"output_tokens":1}}}',
    ].join('\n')}\n`,
  );

  const sessions = scanClaudeVendorSessions(sandbox);

  assert.equal(sessions.length, 3);
  const byId = new Map(
    sessions.map((s) => [s.adapterResult.sample.vendorSessionId, s]),
  );
  const primary0 = byId.get('sess-multi-0001#0');
  const issueSeg = byId.get('sess-multi-0001#1');
  const primary2 = byId.get('sess-multi-0001#2');

  // The issue segment's timeline holds only its own two points -- not the
  // whole file's four assistant messages.
  assert.equal(issueSeg?.timeline.points.length, 2);
  assert.equal(
    issueSeg?.timeline.points[0].atMs,
    ms('2026-08-25T09:05:00.000Z'),
  );
  assert.equal(
    issueSeg?.timeline.points[1].atMs,
    ms('2026-08-25T09:06:00.000Z'),
  );
  assert.deepEqual(issueSeg?.adapterResult.joinHints, { issueNumber: 4343 });

  assert.equal(primary0?.timeline.points.length, 1);
  assert.equal(primary0?.adapterResult.joinHints, undefined);
  assert.equal(primary2?.timeline.points.length, 1);
  assert.equal(primary2?.adapterResult.joinHints, undefined);
});

// --- #2418: event-window issue-number fallback -----------------------------

function stageWindow(
  startIso: string,
  endIso: string,
  vendorSessionId?: string,
  claimId?: string,
): StageEventWindow {
  return {
    startMs: ms(startIso),
    endMs: ms(endIso),
    ...(vendorSessionId !== undefined ? { vendorSessionId } : {}),
    ...(claimId !== undefined ? { claimId } : {}),
  };
}

// #2424: builds one raw --events JSONL line, matching TokenCostEvent's
// own shape.
function tokenCostEvent(
  event: 'enter' | 'exit',
  stageId: string,
  atIso: string,
  issueNumber: number,
  vendorSessionId?: string,
  vendor = 'claude',
  claimId?: string,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    event,
    stageId,
    at: atIso,
    vendor,
    issueNumber,
    ...(vendorSessionId !== undefined ? { vendorSessionId } : {}),
    ...(claimId !== undefined ? { claimId } : {}),
  });
}

function writeEventsFile(lines: readonly string[]): {
  dir: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'idd-token-cost-events-'));
  const path = join(dir, 'events.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return { dir, path };
}

test('buildCompletedIssueWindows: builds an overall window only for an issue with a CLOSED cleanup stage', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:55:00Z', '2026-01-01T01:00:00Z'),
    ],
    // issue 502 never closed its cleanup stage -- excluded even though it
    // has other stage windows.
    [
      '502:claude:work',
      stageWindow('2026-01-02T00:00:00Z', '2026-01-02T00:30:00Z'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.deepEqual(windows, [
    {
      issueNumber: 501,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T01:00:00Z'),
      primaryWindows: [
        {
          startMs: ms('2026-01-01T00:00:00Z'),
          endMs: ms('2026-01-01T00:30:00Z'),
        },
        {
          startMs: ms('2026-01-01T00:55:00Z'),
          endMs: ms('2026-01-01T01:00:00Z'),
        },
      ],
    },
  ]);
});

test('buildCompletedIssueWindows: filters by vendor', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z'),
    ],
    [
      '501:codex:cleanup',
      stageWindow('2026-01-01T02:00:00Z', '2026-01-01T02:10:00Z'),
    ],
  ]);
  const claudeWindows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(claudeWindows.length, 1);
  assert.equal(claudeWindows[0].startMs, ms('2026-01-01T00:00:00Z'));
  const codexWindows = buildCompletedIssueWindows(all, 'codex');
  assert.equal(codexWindows.length, 1);
  assert.equal(codexWindows[0].startMs, ms('2026-01-01T02:00:00Z'));
});

test('segmentRecordsByEventWindow: groups records by the single window each timestamp falls inside', () => {
  const windows: CompletedIssueWindow[] = [
    {
      issueNumber: 501,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T01:00:00Z'),
      primaryWindows: [],
    },
    {
      issueNumber: 502,
      startMs: ms('2026-01-02T00:00:00Z'),
      endMs: ms('2026-01-02T01:00:00Z'),
      primaryWindows: [],
    },
  ];
  const records = [
    { id: 'a', timestamp: '2026-01-01T00:10:00Z' },
    { id: 'b', timestamp: '2026-01-02T00:10:00Z' },
    { id: 'c', timestamp: '2026-01-01T00:20:00Z' },
  ];
  const groups = segmentRecordsByEventWindow(records, windows, (r) =>
    Date.parse((r as { timestamp: string }).timestamp),
  );
  assert.deepEqual(
    (groups.get(501) as { id: string }[]).map((r) => r.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    (groups.get(502) as { id: string }[]).map((r) => r.id),
    ['b'],
  );
});

test('segmentRecordsByEventWindow: drops a record with no timestamp, and one matching zero windows', () => {
  const windows: CompletedIssueWindow[] = [
    {
      issueNumber: 501,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T01:00:00Z'),
      primaryWindows: [],
    },
  ];
  const records = [
    { id: 'no-ts' },
    { id: 'outside', timestamp: '2026-03-01T00:00:00Z' },
  ];
  const groups = segmentRecordsByEventWindow(records, windows, (r) =>
    typeof (r as { timestamp?: string }).timestamp === 'string'
      ? Date.parse((r as { timestamp: string }).timestamp)
      : undefined,
  );
  assert.equal(groups.size, 0);
});

test('segmentRecordsByEventWindow: drops a record matching MORE than one window (concurrent-session overlap)', () => {
  // Two different issues' windows genuinely overlap in wall-clock -- two
  // concurrent sessions writing to the same shared events.jsonl.
  const windows: CompletedIssueWindow[] = [
    {
      issueNumber: 501,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T02:00:00Z'),
      primaryWindows: [],
    },
    {
      issueNumber: 502,
      startMs: ms('2026-01-01T01:00:00Z'),
      endMs: ms('2026-01-01T03:00:00Z'),
      primaryWindows: [],
    },
  ];
  const records = [{ id: 'ambiguous', timestamp: '2026-01-01T01:30:00Z' }];
  const groups = segmentRecordsByEventWindow(records, windows, (r) =>
    Date.parse((r as { timestamp: string }).timestamp),
  );
  assert.equal(groups.size, 0);
});

test('segmentRecordsByEventWindow: a record at the exact instant one window ends and an adjacent one begins matches only the later window (half-open interval, Copilot review finding, #2423)', () => {
  const windows: CompletedIssueWindow[] = [
    {
      issueNumber: 501,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T01:00:00Z'),
      primaryWindows: [],
    },
    {
      issueNumber: 502,
      startMs: ms('2026-01-01T01:00:00Z'),
      endMs: ms('2026-01-01T02:00:00Z'),
      primaryWindows: [],
    },
  ];
  const records = [{ id: 'boundary', timestamp: '2026-01-01T01:00:00Z' }];
  const groups = segmentRecordsByEventWindow(records, windows, (r) =>
    Date.parse((r as { timestamp: string }).timestamp),
  );
  assert.deepEqual(
    (groups.get(502) as { id: string }[]).map((r) => r.id),
    ['boundary'],
  );
  assert.equal(groups.has(501), false);
});

test('scanClaudeVendorSessions: a CLOSED event window supplies issueNumber when cwd-inference fails', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew.jsonl'),
    `${[
      // Before the window -- stays unattributed, only counted in the base
      // session-kind sample.
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sess-ew-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      // Inside issue 501's closed window.
      '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}',
    ].join('\n')}\n`,
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);

  assert.equal(sessions.length, 2);
  const byId = new Map(
    sessions.map((s) => [s.adapterResult.sample.vendorSessionId, s]),
  );
  const base = byId.get('sess-ew-0001');
  const eventWindowSample = byId.get('sess-ew-0001#ew501');

  assert.equal(base?.adapterResult.joinHints, undefined);
  assert.equal(base?.timeline.points.length, 2);

  assert.deepEqual(eventWindowSample?.adapterResult.joinHints, {
    issueNumber: 501,
  });
  assert.equal(eventWindowSample?.timeline.points.length, 1);
  assert.equal(
    eventWindowSample?.timeline.points[0].atMs,
    ms('2026-01-01T00:20:00.000Z'),
  );

  // Deterministic: re-running against the same inputs produces the same
  // vendorSessionId, so the harvester's own dedup (readExistingVendorSessionKeys)
  // treats a second run as already-present rather than a new sample.
  const rerun = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  assert.deepEqual(
    rerun.map((s) => s.adapterResult.sample.vendorSessionId).sort(),
    sessions.map((s) => s.adapterResult.sample.vendorSessionId).sort(),
  );
});

test('scanClaudeVendorSessions: two CLOSED event windows in one file produce two distinct #ew samples', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew2.jsonl'),
    `${[
      '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew2-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      '{"type":"assistant","timestamp":"2026-01-02T00:20:00.000Z","sessionId":"sess-ew2-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}',
    ].join('\n')}\n`,
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
    [
      '502:claude:work',
      stageWindow('2026-01-02T00:10:00Z', '2026-01-02T00:25:00Z'),
    ],
    [
      '502:claude:cleanup',
      stageWindow('2026-01-02T00:26:00Z', '2026-01-02T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const byId = new Map(
    sessions.map((s) => [s.adapterResult.sample.vendorSessionId, s]),
  );

  assert.deepEqual(byId.get('sess-ew2-0001#ew501')?.adapterResult.joinHints, {
    issueNumber: 501,
  });
  assert.deepEqual(byId.get('sess-ew2-0001#ew502')?.adapterResult.joinHints, {
    issueNumber: 502,
  });
});

test('scanClaudeVendorSessions: two DIFFERENT cwd-segments in one file that both fall in the SAME issue window produce exactly one #ew sample, not a duplicate-keyed pair (Copilot review finding, #2423)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-multiseg.jsonl'),
    `${[
      // Segment 0: cwd "/repo" -- cwd-inference fails.
      '{"type":"assistant","timestamp":"2026-01-01T00:15:00.000Z","sessionId":"sess-ew-ms-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      // Segment 1: cwd changes to an ordinary, non-issue-shaped directory
      // (a ordinary "cd", not a worktree move) -- cwd-inference also
      // fails here, and this record ALSO falls in issue 501's window.
      '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-ms-0001","cwd":"/repo/some/subdir","message":{"model":"m","usage":{"input_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}',
    ].join('\n')}\n`,
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  // Exactly one #ew501 sample, combining both segments' matching records --
  // not two duplicate-keyed ones (the bug: partitioning per-segment would
  // independently re-derive the same #ew501 suffix from each segment).
  assert.equal(ewSamples.length, 1);
  assert.equal(
    ewSamples[0].adapterResult.sample.vendorSessionId,
    'sess-ew-ms-0001#ew501',
  );
  assert.equal(ewSamples[0].timeline.points.length, 2);
});

test('scanClaudeVendorSessions: an OPEN event window (no cleanup exit yet) never produces an event-window sample', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-open.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-open-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  // work is closed, but cleanup only has an enter -- the loop is still
  // in-flight from this agent's perspective.
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);

  assert.equal(sessions.length, 1);
  assert.equal(
    sessions[0].adapterResult.sample.vendorSessionId,
    'sess-ew-open-0001',
  );
  assert.equal(sessions[0].adapterResult.joinHints, undefined);
});

test("buildCompletedIssueWindows: a REVERSED cleanup window (a re-attempt's enter paired with a stale earlier exit) is not treated as closed (Codex review finding, #2423)", () => {
  const all = new Map<string, StageEventWindow>([
    // A completed first attempt's cleanup enter/exit...
    // ...then a second attempt re-enters cleanup later than the first
    // attempt's own exit. readEventWindows pairs the LATEST enter with
    // the LATEST exit regardless of attempt, producing a reversed
    // window here (startMs > endMs).
    [
      '501:claude:cleanup',
      {
        startMs: ms('2026-01-01T02:00:00Z'),
        endMs: ms('2026-01-01T01:00:00Z'),
      },
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.deepEqual(windows, []);
});

test('scanClaudeVendorSessions: a reversed cleanup window never produces an event-window sample', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-reversed.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T01:30:00.000Z","sessionId":"sess-ew-reversed-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:cleanup',
      {
        startMs: ms('2026-01-01T02:00:00Z'),
        endMs: ms('2026-01-01T01:00:00Z'),
      },
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].adapterResult.joinHints, undefined);
});

test('buildCompletedIssueWindows: a valid, closed cleanup pair caps the window even when a LATER retry stage extends past it (Codex review finding round 2, #2423)', () => {
  // Issue 501 completed once: cleanup enter@00:55, exit@01:00 (valid).
  // A re-attempt later did a fresh `work` enter/exit (02:00-02:30) that
  // has NOT yet reached its own cleanup -- the original cleanup pair is
  // untouched (still valid), but the retry's work window must not widen
  // the completed span past the original cleanup's own exit.
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:55:00Z', '2026-01-01T01:00:00Z'),
    ],
    // Careful: eventKey is `${issueNumber}:${vendor}:${stageId}`, one
    // entry per stageId -- a real retry would overwrite the SAME 'work'
    // key via readEventWindows' own latest-wins pairing. Modeling that
    // directly: 'work' now reflects the RETRY's later window, not the
    // original run's.
  ]);
  all.set(
    '501:claude:work',
    stageWindow('2026-01-01T02:00:00Z', '2026-01-01T02:30:00Z'),
  );
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  // endMs stays at cleanup's own exit, never extended by the retry's
  // later work window.
  assert.equal(windows[0].endMs, ms('2026-01-01T01:00:00Z'));
  // startMs is NOT widened back to the retry's work window either (it
  // falls after cleanup's endMs, so it doesn't qualify) -- it stays
  // anchored at cleanup's own start.
  assert.equal(windows[0].startMs, ms('2026-01-01T00:55:00Z'));
});

test('buildCompletedIssueWindows: a reversed non-cleanup stage window overlapping the completed run is treated as contamination, not silently narrowed (Codex review finding round 3, #2423)', () => {
  // A later attempt's OWN `work` enter posts (00:58), but its `work` exit
  // fails to post (token-cost-event.mjs is deliberately fail-open) --
  // readEventWindows still pairs that enter with an EARLIER, unrelated
  // attempt's stale exit (00:30), producing a reversed window whose own
  // startMs falls at or before this run's cleanup.endMs. That is direct
  // evidence the issue's event history is corrupted for this harvest, so
  // the whole issue must be skipped rather than emitted with a
  // cleanup-only window that silently hides the contamination.
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:58:00Z', '2026-01-01T00:30:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:55:00Z', '2026-01-01T01:00:00Z'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.deepEqual(windows, []);
});

test('buildCompletedIssueWindows: a reversed non-cleanup stage window entirely PAST the completed run is ordinary retry noise, not contamination (Codex review finding round 3, #2423)', () => {
  // Same reversed-pairing shape as above, but this time both ends of the
  // reversed window fall AFTER the completed run's own cleanup.endMs --
  // ordinary mid-retry noise from a later, distinct attempt that has not
  // yet reached its own valid cleanup. It must not block emission of the
  // already-completed window.
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T02:00:00Z', '2026-01-01T01:30:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:55:00Z', '2026-01-01T01:00:00Z'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:55:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T01:00:00Z'));
});

test('buildCompletedIssueWindows: excludes a non-cleanup stage window whose vendorSessionId differs from the winning cleanup attempt, even though it is internally valid (#2424)', () => {
  // Attempt A's own 'work' pair is internally valid (non-reversed) but
  // belongs to an EARLIER attempt than the one that reached cleanup
  // (attempt B). Pre-#2424, this shape was mechanically indistinguishable
  // from a genuine early start and silently widened startMs back to A's
  // own enter. With vendorSessionId available, the mismatch excludes it
  // outright: startMs stays at cleanup's own startMs.
  const all = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z', 'attempt-A'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:20:00Z', '2026-01-01T00:25:00Z', 'attempt-B'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:20:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T00:25:00Z'));
  assert.equal(windows[0].vendorSessionId, 'attempt-B');
});

test('buildCompletedIssueWindows: recovers a same-attempt stage window instead of a later, unrelated attempt shadowing it (#2424)', () => {
  // Attempt A completes fully (work + cleanup). Attempt B later retries
  // 'work' with its own valid pair but never reaches cleanup. Without
  // identity, readEventWindows' latest-wins pairing would expose B's
  // 'work' window (shadowing A's own), which buildCompletedIssueWindows
  // would then have excluded from widening as "extends past cleanup.endMs"
  // -- collapsing to a cleanup-only window even though A's own matching
  // 'work' window exists. With identity, buildCompletedIssueWindows sees
  // A's own tagged 'work' window here (this is what readEventWindows is
  // responsible for selecting -- see its own dedicated test below) and
  // widens startMs to it.
  const all = new Map<string, StageEventWindow>([
    [
      '502:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z', 'attempt-A'),
    ],
    [
      '502:claude:cleanup',
      stageWindow('2026-01-01T00:02:00Z', '2026-01-01T00:03:00Z', 'attempt-A'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:00:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T00:03:00Z'));
});

test('buildCompletedIssueWindows: an identity-matched reversed non-cleanup window is still treated as contamination (#2424)', () => {
  // Same attempt re-enters 'work' without a matching new exit -- reversed,
  // but the vendorSessionId matches cleanup's own, so the mismatch guard
  // does not exclude it; the pre-#2424 reversed-window contamination check
  // still fires and the whole issue is skipped.
  const all = new Map<string, StageEventWindow>([
    [
      '503:claude:work',
      stageWindow('2026-01-01T00:04:00Z', '2026-01-01T00:02:00Z', 'attempt-A'),
    ],
    [
      '503:claude:cleanup',
      stageWindow('2026-01-01T00:05:00Z', '2026-01-01T00:06:00Z', 'attempt-A'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 0);
});

test('buildCompletedIssueWindows: a valid non-cleanup window straddling cleanup.endMs is excluded by the existing boundary check regardless of a MATCHING identity (PR #2423 review, re-verified under #2424)', () => {
  // Raised and rejected on PR #2423 review: a valid (non-reversed) window
  // whose endMs lands after cleanup.endMs was already excluded from
  // widening by the pre-#2424 boundary check. Confirms that stays true
  // even when its vendorSessionId matches cleanup's own -- same-attempt
  // jitter, not a different-attempt mismatch, but the outcome is identical.
  const all = new Map<string, StageEventWindow>([
    [
      '504:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:07:00Z', 'attempt-A'),
    ],
    [
      '504:claude:cleanup',
      stageWindow('2026-01-01T00:05:00Z', '2026-01-01T00:06:00Z', 'attempt-A'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:05:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T00:06:00Z'));
});

test('buildCompletedIssueWindows: an unidentified non-cleanup window is unaffected when cleanup itself has an identity (mixed old/new data, #2424)', () => {
  // cleanup carries an identity (post-#2424 event) but 'work' predates
  // this field entirely. Absence on one side is not a mismatch -- 'work'
  // still flows through the pre-#2424 checks exactly as before.
  const all = new Map<string, StageEventWindow>([
    [
      '505:claude:work',
      stageWindow('2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'),
    ],
    [
      '505:claude:cleanup',
      stageWindow('2026-01-01T00:02:00Z', '2026-01-01T00:03:00Z', 'attempt-A'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:00:00Z'));
  assert.equal(windows[0].vendorSessionId, 'attempt-A');
});

test('buildCompletedIssueWindows: an IDENTIFIED non-cleanup window from a stale attempt is excluded when cleanup itself is UNIDENTIFIED (Codex review finding round 3, PR #2430, #2424)', () => {
  // The reverse of the case above, and NOT symmetric: cleanup belongs to
  // a fresh, unidentified retry (it legitimately won readEventWindows'
  // own recency comparison over a stale identified completion). 'work'
  // is a STALE, identified window from an EARLIER, different attempt.
  // vendorSessionId is derived once per Claude Code process lifetime, so
  // an identified stage and an unidentified cleanup can never
  // legitimately be the same attempt -- 'work' must be excluded, not
  // treated as compatible just because cleanup itself lacks an identity.
  const all = new Map<string, StageEventWindow>([
    [
      '511:claude:work',
      stageWindow('2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z', 'attempt-A'),
    ],
    [
      '511:claude:cleanup',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:10:05Z'),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:10:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T00:10:05Z'));
  assert.equal('vendorSessionId' in windows[0], false);
});

test('buildCompletedIssueWindows: a claimId match widens the window across a different vendorSessionId and records a contributingWindows entry (#2432)', () => {
  // Attempt A (earlier handoff session) posted 'work' under the SAME
  // claim-id as attempt B (the session that reached cleanup), but a
  // DIFFERENT vendorSessionId. #2424 alone would exclude 'work' as a
  // vendorSessionId mismatch; the claimId match is the positive evidence
  // that this is a genuine handoff, not an unrelated attempt.
  const all = new Map<string, StageEventWindow>([
    [
      '601:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '601:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:00:00Z'));
  assert.equal(windows[0].endMs, ms('2026-01-01T00:25:00Z'));
  assert.equal(windows[0].vendorSessionId, 'attempt-B');
  assert.equal(windows[0].claimId, 'claim-shared');
  assert.deepEqual(windows[0].contributingWindows, [
    {
      vendorSessionId: 'attempt-A',
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:05:00Z'),
    },
  ]);
});

test('buildCompletedIssueWindows: a DIFFERENT vendorSessionId AND a different (or absent) claimId is still excluded (#2432 regression guard on #2424 behavior)', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '602:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'attempt-A',
        'claim-unrelated',
      ),
    ],
    [
      '602:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:20:00Z'));
  assert.equal('contributingWindows' in windows[0], false);
});

test('buildCompletedIssueWindows: a claimId-matched but reversed window still trips contamination (safety checks apply uniformly, #2432)', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '603:claude:work',
      stageWindow(
        '2026-01-01T00:04:00Z',
        '2026-01-01T00:02:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '603:claude:cleanup',
      stageWindow(
        '2026-01-01T00:05:00Z',
        '2026-01-01T00:06:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 0);
});

test('buildCompletedIssueWindows: one vendorSessionId contributing two stages keeps two separate contributingWindows entries (#2432, Codex review PR #2627)', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '604:claude:claim',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:01:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '604:claude:work',
      stageWindow(
        '2026-01-01T00:01:00Z',
        '2026-01-01T00:05:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '604:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  // Two separate entries, never unioned into one enclosing span -- a union
  // would falsely "overlap" any primary-session activity that merely falls
  // inside the GAP between attempt-A's own claim and work stages.
  assert.deepEqual(windows[0].contributingWindows, [
    {
      vendorSessionId: 'attempt-A',
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:01:00Z'),
    },
    {
      vendorSessionId: 'attempt-A',
      startMs: ms('2026-01-01T00:01:00Z'),
      endMs: ms('2026-01-01T00:05:00Z'),
    },
  ]);
});

test('buildCompletedIssueWindows: two claimId-matched windows from different vendorSessionIds that OVERLAP each other skip the whole issue (#2432 cross-session overlap guard)', () => {
  // A documented, narrow TOCTOU race (idd-claim.instructions.md) can leave
  // two sessions momentarily sharing one active claim-id without one
  // being a clean sequential continuation -- overlapping activity under a
  // shared claim-id is evidence of exactly that race, not a genuine
  // handoff, so this must NOT merge.
  const all = new Map<string, StageEventWindow>([
    [
      '605:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:22:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '605:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 0);
});

test("buildCompletedIssueWindows: a contributor overlapping the primary session's OWN earlier stage (not cleanup itself) still trips the overlap guard (#2432, C1 review finding)", () => {
  // The primary session (attempt-B) posted an earlier 'work' stage of its
  // own, well before its own 'cleanup'. A contributor (attempt-A) whose
  // window overlaps that earlier 'work' stage -- without overlapping
  // cleanup's own narrow slice -- is just as much evidence of the
  // documented TOCTOU race as one overlapping cleanup directly; comparing
  // only against cleanup's own [startMs, endMs) would miss this.
  const all = new Map<string, StageEventWindow>([
    [
      '607:claude:work',
      stageWindow('2026-01-01T00:05:00Z', '2026-01-01T00:15:00Z', 'attempt-B'),
    ],
    [
      '607:claude:claim',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:20:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '607:claude:cleanup',
      stageWindow(
        '2026-01-01T00:25:00Z',
        '2026-01-01T00:30:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 0);
});

test('buildCompletedIssueWindows: claimId-matched windows that are exactly back-to-back (touching, not overlapping) still merge (#2432)', () => {
  const all = new Map<string, StageEventWindow>([
    [
      '606:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:20:00Z',
        'attempt-A',
        'claim-shared',
      ),
    ],
    [
      '606:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'attempt-B',
        'claim-shared',
      ),
    ],
  ]);
  const windows = buildCompletedIssueWindows(all, 'claude');
  assert.equal(windows.length, 1);
  assert.equal(windows[0].startMs, ms('2026-01-01T00:00:00Z'));
});

test("scanClaudeVendorSessions: a completed cleanup window does not absorb a later retry's activity", () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-retry.jsonl'),
    `${[
      // Inside the original completed window (00:55-01:00).
      '{"type":"assistant","timestamp":"2026-01-01T00:57:00.000Z","sessionId":"sess-ew-retry-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      // During the later, still-in-progress retry -- must NOT be folded
      // into issue 501's completed sample.
      '{"type":"assistant","timestamp":"2026-01-01T02:15:00.000Z","sessionId":"sess-ew-retry-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":99,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":99}}}',
    ].join('\n')}\n`,
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:55:00Z', '2026-01-01T01:00:00Z'),
    ],
    [
      '501:claude:work',
      stageWindow('2026-01-01T02:00:00Z', '2026-01-01T02:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSample = sessions.find((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.ok(ewSample);
  assert.equal(ewSample.timeline.points.length, 1);
  assert.equal(
    ewSample.timeline.points[0].atMs,
    ms('2026-01-01T00:57:00.000Z'),
  );
});

test('scanClaudeVendorSessions: the event-window fallback is skipped for the whole file when ANY segment already resolved a cwd-inferred issue number (Copilot review finding round 2, #2423)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-mixed.jsonl'),
    `${[
      // Segment 0: a real worktree cwd -- resolves issue 4242 via cwd.
      '{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","sessionId":"sess-ew-mixed-0001","cwd":"/repo.issue-4242-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
      // Segment 1: an ordinary subdirectory -- cwd-inference fails, but
      // its own timestamp happens to fall inside issue 501's completed
      // window purely by coincidence.
      '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-mixed-0001","cwd":"/repo/some/subdir","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}',
    ].join('\n')}\n`,
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  // No event-window sample at all -- the file already produced a real,
  // cwd-attributed issue-loop sample (4242) from segment 0.
  assert.equal(ewSamples.length, 0);
  const byId = new Map(
    sessions.map((s) => [s.adapterResult.sample.vendorSessionId, s]),
  );
  assert.deepEqual(byId.get('sess-ew-mixed-0001#0')?.adapterResult.joinHints, {
    issueNumber: 4242,
  });
  assert.equal(
    byId.get('sess-ew-mixed-0001#1')?.adapterResult.joinHints,
    undefined,
  );
});

test('scanClaudeVendorSessions: two DIFFERENT project log files both matching the same issue window are BOTH dropped (cross-file ambiguity guard, Codex review finding, #2423)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-fileA.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-fileA-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-fileB.jsonl'),
    // An unrelated concurrent session whose own unattributed activity
    // happens to fall inside the SAME wall-clock window purely by
    // coincidence.
    '{"type":"assistant","timestamp":"2026-01-01T00:21:00.000Z","sessionId":"sess-ew-fileB-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  // Neither file's activity is attributed to issue 501 -- emitting one
  // (or both) would risk crediting an unrelated session's usage to this
  // issue, and would also make markAmbiguousOverlaps flag any genuine
  // future sample as ambiguous too. Both files' own plain base samples
  // are still produced normally.
  assert.equal(ewSamples.length, 0);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.adapterResult.joinHints === undefined));
});

test('scanClaudeVendorSessions: two DIFFERENT project log files matching the same issue window with DISJOINT (non-overlapping) activity ranges are STILL both dropped, not merged (#2425 -- merge investigated and rejected, see docstring)', (t) => {
  const stderrWrite = t.mock.method(process.stderr, 'write', () => true);
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-disjointA.jsonl'),
    // Clearly-disjoint, wide-ish range: 00:10 to 00:14.
    '{"type":"assistant","timestamp":"2026-01-01T00:10:00.000Z","sessionId":"sess-ew-disjointA-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n' +
      '{"type":"assistant","timestamp":"2026-01-01T00:14:00.000Z","sessionId":"sess-ew-disjointA-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-disjointB.jsonl'),
    // A DIFFERENT file, entirely after fileA's range ends: 00:18 to 00:20.
    // A naive range-disjointness check would call these two files
    // "sequential continuations" and merge them; #2425 rejected that --
    // sparse candidates like these are indistinguishable from an
    // unrelated concurrent session that just happens not to overlap.
    '{"type":"assistant","timestamp":"2026-01-01T00:18:00.000Z","sessionId":"sess-ew-disjointB-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n' +
      '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-disjointB-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '502:claude:work',
      stageWindow('2026-01-01T00:05:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '502:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 0);
  assert.equal(sessions.length, 2);
  assert.ok(sessions.every((s) => s.adapterResult.joinHints === undefined));

  const skipMessages = stderrWrite.mock.calls
    .map((call) => call.arguments[0])
    .filter(
      (message): message is string =>
        typeof message === 'string' &&
        message.includes('skipping event-window issue #502'),
    );
  assert.equal(skipMessages.length, 1);
  assert.match(skipMessages[0], /disjoint activity ranges/);
  assert.match(skipMessages[0], /#2424/);
});

test("scanClaudeVendorSessions: a cross-file match is resolved (not skipped) when exactly one candidate file's own sessionId matches the window's vendorSessionId (#2424)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  // The file that actually posted the winning cleanup attempt's events.
  writeFileSync(
    join(sandbox, 'session-ew-idA.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-idA-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  // A genuinely unrelated concurrent session whose own activity happens
  // to fall in the same wall-clock window.
  writeFileSync(
    join(sandbox, 'session-ew-idB.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:21:00.000Z","sessionId":"sess-ew-idB-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:25:00Z',
        'sess-ew-idA-0001',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:26:00Z',
        '2026-01-01T00:30:00Z',
        'sess-ew-idA-0001',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  // Resolved to fileA only -- fileB's unrelated activity is never folded
  // in, and this issue is no longer skipped the way an unidentified
  // cross-file match still is (see the two tests above).
  assert.equal(ewSamples.length, 1);
  assert.equal(
    ewSamples[0].adapterResult.sample.vendorSessionId,
    'sess-ew-idA-0001#ew501',
  );
  assert.equal(sessions.length, 3);
});

test("scanClaudeVendorSessions: a cross-file match resolves via the SAME basename fallback claudeAdapter.harvest() uses, when the winning file's own records carry no top-level sessionId (Copilot review finding, PR #2430, #2424)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  // No top-level "sessionId" field on this file's records -- extractSessionId()
  // alone returns undefined here; only the basename fallback recovers the
  // real id ($CLAUDE_CODE_SESSION_ID matches a session log's own basename).
  writeFileSync(
    join(sandbox, 'session-ew-idH.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-idI.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:21:00.000Z","sessionId":"sess-ew-idI-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:25:00Z',
        'session-ew-idH',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:26:00Z',
        '2026-01-01T00:30:00Z',
        'session-ew-idH',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  assert.equal(
    ewSamples[0].adapterResult.sample.vendorSessionId,
    'session-ew-idH#ew501',
  );
  assert.equal(sessions.length, 3);
});

test("scanClaudeVendorSessions: falls back to classify-and-skip when no candidate file's sessionId matches the window's vendorSessionId (#2424)", () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-idC.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-idC-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-idD.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:21:00.000Z","sessionId":"sess-ew-idD-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  // Neither file's own sessionId equals the window's vendorSessionId --
  // e.g. the events were posted from a THIRD, un-scanned file/session.
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:25:00Z',
        'sess-ew-idE-elsewhere',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:26:00Z',
        '2026-01-01T00:30:00Z',
        'sess-ew-idE-elsewhere',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 0);
  assert.equal(sessions.length, 2);
});

test("scanClaudeVendorSessions: a SOLE candidate file is still skipped when the window has an identity and the file's own sessionId does not match it (#2424)", () => {
  // A single-candidate window is NOT automatically the right file: this
  // locks in that the identity check also gates the length-1 fast path,
  // not just the multi-file classify-and-skip branch above. Realistic
  // shape: this loop's own event-window session file got excluded
  // upstream (one of its segments already resolved a cwd-inferred issue
  // number), leaving only an unrelated concurrent session as the sole
  // candidate.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-idF.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-idF-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:25:00Z',
        'sess-ew-idG-elsewhere',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:26:00Z',
        '2026-01-01T00:30:00Z',
        'sess-ew-idG-elsewhere',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 0);
  assert.equal(sessions.length, 1);
});

test('scanClaudeVendorSessions: a SOLE candidate file is still harvested unconditionally when the window carries no identity (backward compat, #2424)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-idH.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-idH-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
});

test('scanClaudeVendorSessions: a genuine handoff (matching claimId, differing vendorSessionId) merges both files into one #ew sample, identity anchored to the primary/cleanup file, with correct startedAt/endedAt despite the contributing session being chronologically EARLIER (#2432)', () => {
  // The realistic handoff shape: the contributing (earlier) session's own
  // records are chronologically BEFORE the primary/cleanup session's.
  // This is the regression test for the ordering bug caught in review --
  // `extractTimestamps` takes the first/last record in ARRAY order, not a
  // true min/max, so a naive "concatenate contributing after primary"
  // merge would produce startedAt > endedAt and throw. The merge must
  // sort by timestamp before harvesting.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-contrib.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:01:00.000Z","sessionId":"sess-contrib-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":3}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-primary.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0001',
        'claim-shared',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0001',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  const sample = ewSamples[0].adapterResult.sample;
  assert.equal(sample.vendorSessionId, 'sess-primary-0001#ew501');
  assert.equal(sample.usage.output, 10);
  assert.equal(sample.startedAt, '2026-01-01T00:01:00.000Z');
  assert.equal(sample.endedAt, '2026-01-01T00:24:00.000Z');
  // Each file's own plain per-file sample plus the one merged #ew sample.
  assert.equal(sessions.length, 3);
});

test('scanClaudeVendorSessions: a same-issue match from an unrelated concurrent session (different vendorSessionId, no shared claimId) never merges its usage in (#2432 regression guard on #2423/#2424/#2425)', () => {
  // fileA is the primary/cleanup file; fileB has a DIFFERENT
  // vendorSessionId AND no claimId relationship to fileA's cleanup event
  // at all (a genuinely unrelated concurrent session, not a handoff).
  // Unlike the #2424 "cross-file match resolved via identity" test above
  // (same vendorSessionId on both ends), this exercises the NEW claimId
  // branch's negative case through the full merge pipeline: fileB's
  // own file is present and structurally eligible (unattributed,
  // timestamp inside the widened window), but must never be pulled in.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-idA.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-idA-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-idB.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:21:00.000Z","sessionId":"sess-ew-idB-0001","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":5,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow(
        '2026-01-01T00:10:00Z',
        '2026-01-01T00:19:00Z',
        'sess-ew-idB-0001',
        'claim-unrelated',
      ),
    ],
    [
      '501:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-ew-idA-0001',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  const sample = ewSamples[0].adapterResult.sample;
  assert.equal(sample.vendorSessionId, 'sess-ew-idA-0001#ew501');
  // Only fileA's own usage (1) -- fileB's usage (5) is never folded in.
  assert.equal(sample.usage.output, 1);
  assert.equal(sessions.length, 3);
});

test('scanClaudeVendorSessions: a contributing session whose file cannot be uniquely resolved skips the whole issue rather than freezing an undercount (#2432, Codex review PR #2627)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  // No file in this sandbox has sessionId 'sess-contrib-missing' -- the
  // contributing window's own file was never scanned (e.g. rotated out,
  // or on a different machine).
  writeFileSync(
    join(sandbox, 'session-ew-primary.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0002","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '502:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-missing',
        'claim-shared',
      ),
    ],
    [
      '502:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0002',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  // No sample at all for issue 502 -- a primary-only sample would freeze
  // this undercount permanently under the stable `#ew502` id, since the
  // CLI's append-side dedup would then skip a later, fuller harvest once
  // the missing contributor file becomes available.
  assert.equal(ewSamples.length, 0);
});

test('scanClaudeVendorSessions: a contributing candidate whose file already independently produced a cwd-attributed sample is never re-absorbed (#2432)', () => {
  // fileA's own cwd resolves to a DIFFERENT issue (4242) via a real
  // issue-worktree path -- it already produced its own independent
  // cwd-attributed sample and must never also be pulled in as a
  // contributing session for issue 503's merged #ew sample, even though
  // its own sessionId matches the contributing window's vendorSessionId.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-cwd-attributed.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:01:00.000Z","sessionId":"sess-contrib-0003","cwd":"/home/user/repo.issue-4242-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":3}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-ew-primary.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0003","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '503:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0003',
        'claim-shared',
      ),
    ],
    [
      '503:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0003',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  // Only the primary file's own usage (7) -- the cwd-attributed file's
  // usage (3) is never folded in.
  assert.equal(ewSamples[0].adapterResult.sample.usage.output, 7);
});

test('scanClaudeVendorSessions: one vendorSessionId contributing two stages merges both stages worth of that session file, not just the last one (#2432)', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-contrib.jsonl'),
    `${[
      '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","sessionId":"sess-contrib-0004","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}',
      '{"type":"assistant","timestamp":"2026-01-01T00:03:00.000Z","sessionId":"sess-contrib-0004","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":4}}}',
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(sandbox, 'session-ew-primary.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0004","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '504:claude:claim',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:01:00Z',
        'sess-contrib-0004',
        'claim-shared',
      ),
    ],
    [
      '504:claude:work',
      stageWindow(
        '2026-01-01T00:01:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0004',
        'claim-shared',
      ),
    ],
    [
      '504:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0004',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  // 2 (claim stage) + 4 (work stage) + 7 (primary) -- both of the
  // contributing session's own records are pulled in, not just one.
  assert.equal(ewSamples[0].adapterResult.sample.usage.output, 13);
});

test('scanClaudeVendorSessions: a cwd-attributed primary (cleanup session launched inside the issue worktree) still merges a contributor, and its own standalone sample is suppressed (#2432, Codex review PR #2627)', () => {
  // The cleanup-owning session was launched directly inside the issue's
  // own worktree, so it cwd-resolves normally and is excluded from the
  // #2418 unattributed-record fallback pool -- the merge must still fire
  // by resolving this cwd-attributed file as primary directly.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-primary-506.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0005","cwd":"/home/user/repo.issue-506-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-contrib-506.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","sessionId":"sess-contrib-0005","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '506:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0005',
        'claim-shared',
      ),
    ],
    [
      '506:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0005',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const issue506Samples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('506'),
  );

  // Exactly one sample for issue 506 -- not the merged #ew sample AND a
  // separate standalone cwd-derived sample for the same completed loop.
  assert.equal(issue506Samples.length, 1);
  assert.equal(
    issue506Samples[0].adapterResult.sample.vendorSessionId,
    'sess-primary-0005#ew506',
  );
  assert.equal(issue506Samples[0].adapterResult.sample.usage.output, 9);
});

test('scanClaudeVendorSessions: a cwd-attributed primary that moved out of and back into the issue worktree (two segments, one file) still resolves (#2432, Codex review PR #2627)', () => {
  // The cleanup-owning session's own file produces TWO cwd-attributed
  // segments for the SAME issue (#2404 segmentation, moved out then back
  // in) -- this must not read as "matched more than one file" and reject
  // the resolution; both segments' records belong to the one, uniquely
  // resolved primary file.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-primary-508.jsonl'),
    `${[
      '{"type":"assistant","timestamp":"2026-01-01T00:15:00.000Z","sessionId":"sess-primary-0007","cwd":"/home/user/repo.issue-508-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":3}}}',
      '{"type":"assistant","timestamp":"2026-01-01T00:18:00.000Z","sessionId":"sess-primary-0007","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":5}}}',
      '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0007","cwd":"/home/user/repo.issue-508-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}',
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(sandbox, 'session-contrib-508.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","sessionId":"sess-contrib-0007","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '508:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0007',
        'claim-shared',
      ),
    ],
    [
      '508:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0007',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const issue508Samples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('508'),
  );

  assert.equal(issue508Samples.length, 1);
  assert.equal(
    issue508Samples[0].adapterResult.sample.vendorSessionId,
    'sess-primary-0007#ew508',
  );
  // 3 + 7 (both cwd-508-attributed segments' own records) + 2
  // (contributor) -- the middle segment's own 5 tokens, recorded while
  // cwd was NOT the issue-508 worktree, are correctly excluded: only the
  // cwd-attributed segments belong to this primary.
  assert.equal(issue508Samples[0].adapterResult.sample.usage.output, 12);
});

test('scanClaudeVendorSessions: a contributor eligible for one contributing window is not disqualified by an EARLIER, non-overlapping cwd segment for a different issue (#2432, Codex review PR #2627)', () => {
  // The contributing session's own file also touched an unrelated issue
  // (#100) much earlier, at a time that does not overlap this contributing
  // window at all -- the file-wide eligibility check must not reject the
  // contributor on that basis alone.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-contrib-507.jsonl'),
    `${[
      '{"type":"assistant","timestamp":"2025-12-31T00:00:00.000Z","sessionId":"sess-contrib-0006","cwd":"/home/user/repo.issue-100-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":99}}}',
      '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","sessionId":"sess-contrib-0006","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}',
    ].join('\n')}\n`,
  );
  writeFileSync(
    join(sandbox, 'session-ew-primary-507.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-primary-0006","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":7}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '507:claude:work',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:05:00Z',
        'sess-contrib-0006',
        'claim-shared',
      ),
    ],
    [
      '507:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-primary-0006',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew507'),
  );

  assert.equal(ewSamples.length, 1);
  // 7 (primary) + 2 (contributor's own in-window record) -- the
  // contributor is NOT disqualified by its earlier, disjoint issue-100
  // segment (99 tokens, correctly excluded from this sum).
  assert.equal(ewSamples[0].adapterResult.sample.usage.output, 9);
});

test('scanClaudeVendorSessions: a multi-hop handoff across THREE different sessions (not just two) merges all of them (#2432, C1 review coverage gap)', () => {
  // A -> B -> C: three different vendorSessionIds, one shared claimId,
  // each contributing a different stage from its own file. The primary
  // (cleanup-owning) session is C.
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-hop-a.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:00:30.000Z","sessionId":"sess-hop-A","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":2}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-hop-b.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:06:00.000Z","sessionId":"sess-hop-B","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":4}}}\n',
  );
  writeFileSync(
    join(sandbox, 'session-hop-c.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:24:00.000Z","sessionId":"sess-hop-C","cwd":"/repo","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":8}}}\n',
  );
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '505:claude:claim',
      stageWindow(
        '2026-01-01T00:00:00Z',
        '2026-01-01T00:01:00Z',
        'sess-hop-A',
        'claim-shared',
      ),
    ],
    [
      '505:claude:work',
      stageWindow(
        '2026-01-01T00:05:00Z',
        '2026-01-01T00:10:00Z',
        'sess-hop-B',
        'claim-shared',
      ),
    ],
    [
      '505:claude:cleanup',
      stageWindow(
        '2026-01-01T00:20:00Z',
        '2026-01-01T00:25:00Z',
        'sess-hop-C',
        'claim-shared',
      ),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);
  const ewSamples = sessions.filter((s) =>
    s.adapterResult.sample.vendorSessionId.includes('#ew'),
  );

  assert.equal(ewSamples.length, 1);
  const sample = ewSamples[0].adapterResult.sample;
  assert.equal(sample.vendorSessionId, 'sess-hop-C#ew505');
  // 2 (A) + 4 (B) + 8 (C) -- all three hops' usage is pulled in.
  assert.equal(sample.usage.output, 14);
  assert.equal(sample.startedAt, '2026-01-01T00:00:30.000Z');
  assert.equal(sample.endedAt, '2026-01-01T00:24:00.000Z');
});

test('scanClaudeVendorSessions: an event window is ignored when the segment already has a cwd-inferred issueNumber', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-ew-'));
  writeFileSync(
    join(sandbox, 'session-ew-cwd.jsonl'),
    '{"type":"assistant","timestamp":"2026-01-01T00:20:00.000Z","sessionId":"sess-ew-cwd-0001","cwd":"/repo.issue-777-x","message":{"model":"m","usage":{"input_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}\n',
  );
  // A closed window exists for a DIFFERENT issue at this same timestamp --
  // must not override the already-successful cwd inference (777), and
  // must not additionally emit an event-window sample for 501 either,
  // since the fallback only runs when cwd-inference itself failed.
  const eventWindowsAll = new Map<string, StageEventWindow>([
    [
      '501:claude:work',
      stageWindow('2026-01-01T00:10:00Z', '2026-01-01T00:25:00Z'),
    ],
    [
      '501:claude:cleanup',
      stageWindow('2026-01-01T00:26:00Z', '2026-01-01T00:30:00Z'),
    ],
  ]);

  const sessions = scanClaudeVendorSessions(sandbox, eventWindowsAll);

  assert.equal(sessions.length, 1);
  assert.deepEqual(sessions[0].adapterResult.joinHints, { issueNumber: 777 });
});

test('extractCodexUsageTimeline prefers cumulative total_token_usage when any record has one', () => {
  const records = [
    {
      type: 'token_count',
      timestamp: '2026-01-01T00:01:00Z',
      payload: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
    },
    {
      type: 'token_count',
      timestamp: '2026-01-01T00:02:00Z',
      payload: { total_token_usage: { input_tokens: 150, output_tokens: 20 } },
    },
  ];
  const timeline = extractCodexUsageTimeline(records);
  assert.equal(timeline.mode, 'cumulative');
  assert.equal(timeline.points.length, 2);
  assert.equal(timeline.points[1].usage.inputUncached, 150);
  assert.equal(timeline.points[1].usage.output, 20);
});

test('extractCodexUsageTimeline falls back to last_token_usage deltas when no record has a cumulative total', () => {
  const records = [
    {
      type: 'token_count',
      timestamp: '2026-01-01T00:01:00Z',
      payload: { last_token_usage: { input_tokens: 5, output_tokens: 1 } },
    },
    {
      type: 'token_count',
      timestamp: '2026-01-01T00:02:00Z',
      payload: { last_token_usage: { input_tokens: 7, output_tokens: 2 } },
    },
  ];
  const timeline = extractCodexUsageTimeline(records);
  assert.equal(timeline.mode, 'delta');
  assert.equal(timeline.points.length, 2);
  assert.equal(timeline.points[0].usage.inputUncached, 5);
  assert.equal(timeline.points[1].usage.inputUncached, 7);
});

// ---------------------------------------------------------------------------
// Stage windows
// ---------------------------------------------------------------------------

const EMPTY_EVENTS = new Map<TokenCostStageId, StageEventWindow>();

test('computeStageWindows tiles all seven stages contiguously for a full merged loop', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:02:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: ms('2026-01-01T00:45:00Z'),
    firstReviewAtMs: ms('2026-01-01T00:30:00Z'),
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows, attribution } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T01:10:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  assert.equal(attribution, 'marker-join');
  assert.deepEqual(
    windows.map((w) => w.id),
    ['discover', 'claim', 'work', 'submit-pr', 'review', 'merge', 'cleanup'],
  );
  // Contiguous: each window starts exactly where the previous ended.
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].startMs, windows[i - 1].endMs);
  }
  assert.equal(windows[0].startMs, ms('2026-01-01T00:00:00Z'));
  assert.equal(windows[1].startMs, ms('2026-01-01T00:02:00Z')); // claim starts at claimedAt
  assert.equal(windows[1].endMs, ms('2026-01-01T00:17:00Z')); // capped at claimedAt+15m (< prCreatedAt)
  assert.equal(windows[2].endMs, ms('2026-01-01T00:25:00Z')); // work ends at prCreatedAt
  assert.equal(windows[4].endMs, ms('2026-01-01T00:45:00Z')); // review ends at mergedAt
  assert.equal(windows[5].endMs, ms('2026-01-01T01:00:00Z')); // merge: no cleanup marker, mergedAt+15m thin cap
  assert.equal(windows[6].endMs, ms('2026-01-01T01:10:00Z')); // cleanup runs to session end
});

test('computeStageWindows without a PR yet: claim capped, work runs to session end, no later stages', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    prCreatedAtMs: null,
    prHeadRefName: null,
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:20:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  assert.deepEqual(
    windows.map((w) => w.id),
    ['claim', 'work'],
  );
  assert.equal(windows[0].endMs, ms('2026-01-01T00:15:00Z'));
  assert.equal(windows[1].endMs, ms('2026-01-01T00:20:00Z'));
});

test('computeStageWindows omits a window that would collapse to zero width', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    // PR created before the 15m claim cap: claim end == PR createdAt, so the
    // 'work' window (end of claim -> PR createdAt) is empty and omitted.
    prCreatedAtMs: ms('2026-01-01T00:10:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:30:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  assert.ok(!windows.some((w) => w.id === 'work'));
});

test('computeStageWindows: a review submitted after merge clamps submit-pr to mergedAt instead of overlapping merge', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:02:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:22:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: ms('2026-01-01T00:32:00Z'),
    // A bot reviewing an admin-merged PR post hoc: firstReviewAtMs > prMergedAtMs.
    firstReviewAtMs: ms('2026-01-01T00:45:00Z'),
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T01:10:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  // review collapses to zero width (nothing happened between merge and the
  // clamped submit-pr end) and is correctly omitted, not stretched past mergedAt.
  assert.deepEqual(
    windows.map((w) => w.id),
    ['discover', 'claim', 'work', 'submit-pr', 'merge', 'cleanup'],
  );
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].startMs, windows[i - 1].endMs);
  }
  const submitPr = windows.find((w) => w.id === 'submit-pr');
  assert.equal(submitPr?.endMs, ms('2026-01-01T00:32:00Z'));
  const merge = windows.find((w) => w.id === 'merge');
  assert.equal(merge?.startMs, ms('2026-01-01T00:32:00Z'));
});

test('computeStageWindows: a merged PR with no resolvable review still emits merge and cleanup', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:02:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:22:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: ms('2026-01-01T00:32:00Z'),
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T01:10:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  assert.deepEqual(
    windows.map((w) => w.id),
    ['discover', 'claim', 'work', 'submit-pr', 'merge', 'cleanup'],
  );
  const submitPr = windows.find((w) => w.id === 'submit-pr');
  assert.equal(submitPr?.endMs, ms('2026-01-01T00:32:00Z'));
  const merge = windows.find((w) => w.id === 'merge');
  assert.equal(merge?.startMs, ms('2026-01-01T00:32:00Z'));
  assert.equal(merge?.endMs, ms('2026-01-01T00:47:00Z'));
  const cleanup = windows.find((w) => w.id === 'cleanup');
  assert.equal(cleanup?.endMs, ms('2026-01-01T01:10:00Z'));
});

test('computeStageWindows: an --events window overrides the marker-derived one and flips attribution', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const events = new Map<TokenCostStageId, StageEventWindow>([
    [
      'work',
      {
        startMs: ms('2026-01-01T00:16:00Z'),
        endMs: ms('2026-01-01T00:19:00Z'),
      },
    ],
  ]);
  const { windows, attribution } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:30:00Z'),
    ctx,
    events,
  );
  assert.equal(attribution, 'phase-event');
  const work = windows.find((w) => w.id === 'work');
  assert.ok(work);
  assert.equal(work?.source, 'event');
  assert.equal(work?.startMs, ms('2026-01-01T00:16:00Z'));
  assert.equal(work?.endMs, ms('2026-01-01T00:19:00Z'));
});

test('computeStageWindows: an --events override that runs past a later marker-derived stage is clamped, never overlapping', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  // The marker-derived tiling would put 'work' at [00:15, 00:25). An
  // --events override stretches 'claim' out to 00:20, past where 'work'
  // would otherwise start.
  const events = new Map<TokenCostStageId, StageEventWindow>([
    [
      'claim',
      {
        startMs: ms('2026-01-01T00:05:00Z'),
        endMs: ms('2026-01-01T00:20:00Z'),
      },
    ],
  ]);
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:30:00Z'),
    ctx,
    events,
  );
  for (let i = 1; i < windows.length; i++) {
    assert.ok(
      windows[i].startMs >= windows[i - 1].endMs,
      `${windows[i].id} [${windows[i].startMs}, ${windows[i].endMs}) overlaps ${
        windows[i - 1].id
      } [${windows[i - 1].startMs}, ${windows[i - 1].endMs})`,
    );
  }
  const claim = windows.find((w) => w.id === 'claim');
  assert.equal(claim?.source, 'event');
  assert.equal(claim?.startMs, ms('2026-01-01T00:05:00Z'));
  assert.equal(claim?.endMs, ms('2026-01-01T00:20:00Z'));
  const work = windows.find((w) => w.id === 'work');
  // work's marker-derived start (00:15) is clamped forward past claim's
  // event-sourced end (00:20) instead of overlapping it.
  assert.equal(work?.source, 'marker');
  assert.equal(work?.startMs, ms('2026-01-01T00:20:00Z'));
  assert.equal(work?.endMs, ms('2026-01-01T00:25:00Z'));
});

test('computeStageWindows: a following marker window flows backward to fill the gap an event override leaves behind', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  // The marker-derived tiling would put 'work' at [00:15, 00:25). An
  // --events override shrinks 'work' to [00:16, 00:19), well short of
  // 00:25 -- the marker-derived 'submit-pr' that follows it must flow
  // backward to 00:19 rather than leaving [00:19, 00:25) unattributed.
  const events = new Map<TokenCostStageId, StageEventWindow>([
    [
      'work',
      {
        startMs: ms('2026-01-01T00:16:00Z'),
        endMs: ms('2026-01-01T00:19:00Z'),
      },
    ],
  ]);
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:30:00Z'),
    ctx,
    events,
  );
  for (let i = 1; i < windows.length; i++) {
    assert.ok(
      windows[i].startMs >= windows[i - 1].endMs,
      `${windows[i].id} [${windows[i].startMs}, ${windows[i].endMs}) overlaps ${
        windows[i - 1].id
      } [${windows[i - 1].startMs}, ${windows[i - 1].endMs})`,
    );
  }
  // 'claim' (marker-sourced) must flow FORWARD to close the gap before
  // 'work' (event-sourced) too: claim's own marker-derived end (00:15) is
  // retroactively extended to meet work's explicit start (00:16).
  const claim = windows.find((w) => w.id === 'claim');
  const work = windows.find((w) => w.id === 'work');
  assert.equal(work?.startMs, ms('2026-01-01T00:16:00Z'));
  assert.equal(claim?.endMs, work?.startMs);
  assert.equal(claim?.endMs, ms('2026-01-01T00:16:00Z'));
  // 'submit-pr' (marker-sourced) must flow backward to close the gap work's
  // shrink left AFTER it, rather than leaving [00:19, 00:25) unattributed.
  const submitPr = windows.find((w) => w.id === 'submit-pr');
  assert.equal(submitPr?.source, 'marker');
  assert.equal(submitPr?.startMs, work?.endMs);
  assert.equal(submitPr?.startMs, ms('2026-01-01T00:19:00Z'));
  assert.equal(submitPr?.endMs, ms('2026-01-01T00:30:00Z'));
});

test('computeStageWindows: extending a marker window to meet a later event window clamps to sessionEndedAtMs, never past it', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:00:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  // A stale --events entry (e.g. from a later/different session) whose
  // startMs is past this session's own end -- the gap-filling extension
  // must not stretch 'claim' past sessionEndedAtMs to reach it.
  const events = new Map<TokenCostStageId, StageEventWindow>([
    [
      'work',
      {
        startMs: ms('2026-01-01T00:35:00Z'),
        endMs: ms('2026-01-01T00:40:00Z'),
      },
    ],
  ]);
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:30:00Z'),
    ctx,
    events,
  );
  // 'work' itself is dropped: after clamping to sessionEndedAtMs, its
  // interval is empty.
  assert.ok(!windows.some((w) => w.id === 'work'));
  const claim = windows.find((w) => w.id === 'claim');
  assert.equal(claim?.endMs, ms('2026-01-01T00:30:00Z'));
  for (const window of windows) {
    assert.ok(window.endMs <= ms('2026-01-01T00:30:00Z'));
  }
});

test('computeStageWindows returns no windows when there is no claim in range', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: null,
    prCreatedAtMs: null,
    prHeadRefName: null,
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T00:10:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  assert.deepEqual(windows, []);
});

// ---------------------------------------------------------------------------
// Usage allocation (AC1: stage usage sums to session usage)
// ---------------------------------------------------------------------------

test('allocateStageUsage (delta mode): every stage sums exactly to the session total', () => {
  const ctx: IssueLoopGithubContext = {
    claimedAtMs: ms('2026-01-01T00:02:00Z'),
    prCreatedAtMs: ms('2026-01-01T00:25:00Z'),
    prHeadRefName: 'issue/1-test',
    prMergedAtMs: ms('2026-01-01T00:45:00Z'),
    firstReviewAtMs: ms('2026-01-01T00:30:00Z'),
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  const { windows } = computeStageWindows(
    ms('2026-01-01T00:00:00Z'),
    ms('2026-01-01T01:10:00Z'),
    ctx,
    EMPTY_EVENTS,
  );
  const points = [
    { atMs: ms('2026-01-01T00:01:00Z'), usage: usage(10) }, // discover
    { atMs: ms('2026-01-01T00:10:00Z'), usage: usage(20) }, // claim
    { atMs: ms('2026-01-01T00:20:00Z'), usage: usage(30) }, // work
    { atMs: ms('2026-01-01T00:27:00Z'), usage: usage(40) }, // submit-pr
    { atMs: ms('2026-01-01T00:35:00Z'), usage: usage(50) }, // review
    { atMs: ms('2026-01-01T00:50:00Z'), usage: usage(60) }, // merge
    { atMs: ms('2026-01-01T01:05:00Z'), usage: usage(70) }, // cleanup
  ];
  const stages = allocateStageUsage(windows, { mode: 'delta', points });
  assert.equal(stages.length, 7);
  const sum = stages.reduce((total, s) => total + usageSum(s.usage), 0);
  assert.equal(sum, usageSum(...points.map((p) => p.usage)));
  assert.equal(stages.find((s) => s.id === 'discover')?.usage.output, 10);
  assert.equal(stages.find((s) => s.id === 'cleanup')?.usage.output, 70);
});

test('allocateStageUsage (cumulative mode): windows telescope to the final snapshot with a zero baseline', () => {
  const windows = [
    {
      id: 'claim' as const,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:10:00Z'),
      source: 'marker' as const,
    },
    {
      id: 'work' as const,
      startMs: ms('2026-01-01T00:10:00Z'),
      endMs: ms('2026-01-01T00:20:00Z'),
      source: 'marker' as const,
    },
  ];
  const points = [
    { atMs: ms('2026-01-01T00:05:00Z'), usage: usage(40) },
    { atMs: ms('2026-01-01T00:15:00Z'), usage: usage(100) },
  ];
  const stages = allocateStageUsage(windows, { mode: 'cumulative', points });
  assert.equal(stages.find((s) => s.id === 'claim')?.usage.output, 40);
  assert.equal(stages.find((s) => s.id === 'work')?.usage.output, 60);
  const sum = stages.reduce((total, s) => total + usageSum(s.usage), 0);
  assert.equal(sum, 100); // matches the final (latest) cumulative snapshot
});

test('allocateStageUsage (cumulative mode): a gap between windows excludes that growth, never folds it into the next window', () => {
  const windows = [
    {
      id: 'claim' as const,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:10:00Z'),
      source: 'marker' as const,
    },
    // A genuine gap: [00:10, 00:15) is not covered by any window.
    {
      id: 'work' as const,
      startMs: ms('2026-01-01T00:15:00Z'),
      endMs: ms('2026-01-01T00:25:00Z'),
      source: 'event' as const,
    },
  ];
  const points = [
    { atMs: ms('2026-01-01T00:05:00Z'), usage: usage(5) },
    // Grows during the gap -- this +3 must not attribute to either window.
    { atMs: ms('2026-01-01T00:12:00Z'), usage: usage(8) },
    { atMs: ms('2026-01-01T00:20:00Z'), usage: usage(12) },
  ];
  const stages = allocateStageUsage(windows, { mode: 'cumulative', points });
  assert.equal(stages.find((s) => s.id === 'claim')?.usage.output, 5);
  // Not 7 (12 - the running baseline of 5): the +3 that grew during the gap
  // (5 -> 8) is excluded, matching delta mode's gap exclusion.
  assert.equal(stages.find((s) => s.id === 'work')?.usage.output, 4);
  const sum = stages.reduce((total, s) => total + usageSum(s.usage), 0);
  assert.equal(sum, 9); // 12 (final snapshot) - 3 (unattributed gap growth)
});

test("allocateStageUsage (cumulative mode): a point exactly at the first window's startMs counts as usage, not as the baseline", () => {
  const windows = [
    {
      id: 'claim' as const,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:10:00Z'),
      source: 'marker' as const,
    },
  ];
  const points = [
    // Coincides exactly with the window's own start -- must not be
    // consumed as the subtraction baseline (which would silently drop
    // this point's own usage instead of allocating it).
    { atMs: ms('2026-01-01T00:00:00Z'), usage: usage(5) },
    { atMs: ms('2026-01-01T00:10:00Z'), usage: usage(8) },
  ];
  const stages = allocateStageUsage(windows, { mode: 'cumulative', points });
  assert.equal(stages.find((s) => s.id === 'claim')?.usage.output, 8);
});

test('allocateStageUsage (cumulative mode): a point exactly at a shared boundary between two contiguous windows is not double-counted', () => {
  const windows = [
    {
      id: 'claim' as const,
      startMs: ms('2026-01-01T00:00:00Z'),
      endMs: ms('2026-01-01T00:10:00Z'),
      source: 'marker' as const,
    },
    {
      id: 'work' as const,
      startMs: ms('2026-01-01T00:10:00Z'),
      endMs: ms('2026-01-01T00:20:00Z'),
      source: 'marker' as const,
    },
  ];
  const points = [
    { atMs: ms('2026-01-01T00:00:00Z'), usage: usage(5) },
    // Exactly at the shared boundary between claim and work.
    { atMs: ms('2026-01-01T00:10:00Z'), usage: usage(8) },
    { atMs: ms('2026-01-01T00:20:00Z'), usage: usage(12) },
  ];
  const stages = allocateStageUsage(windows, { mode: 'cumulative', points });
  assert.equal(stages.find((s) => s.id === 'claim')?.usage.output, 8);
  assert.equal(stages.find((s) => s.id === 'work')?.usage.output, 4);
  const sum = stages.reduce((total, s) => total + usageSum(s.usage), 0);
  assert.equal(sum, 12); // must equal the final snapshot, not 15
});

test('allocateStageUsage omits an all-zero-usage window', () => {
  const windows = [
    {
      id: 'discover' as const,
      startMs: 0,
      endMs: 1000,
      source: 'marker' as const,
    },
    {
      id: 'claim' as const,
      startMs: 1000,
      endMs: 2000,
      source: 'marker' as const,
    },
  ];
  const stages = allocateStageUsage(windows, {
    mode: 'delta',
    points: [{ atMs: 1500, usage: usage(5) }],
  });
  assert.deepEqual(
    stages.map((s) => s.id),
    ['claim'],
  );
});

// ---------------------------------------------------------------------------
// Outcome + ambiguity
// ---------------------------------------------------------------------------

test('deriveOutcome: merged takes priority; then human-handoff; then unclaimed; else aborted', () => {
  const base: IssueLoopGithubContext = {
    claimedAtMs: 0,
    prCreatedAtMs: null,
    prHeadRefName: null,
    prMergedAtMs: null,
    firstReviewAtMs: null,
    cleanupAtMs: null,
    unclaimedMatched: false,
    humanHandoff: false,
  };
  assert.equal(deriveOutcome({ ...base, prMergedAtMs: 1 }), 'merged');
  assert.equal(deriveOutcome({ ...base, humanHandoff: true }), 'human-handoff');
  assert.equal(deriveOutcome({ ...base, unclaimedMatched: true }), 'unclaimed');
  assert.equal(deriveOutcome(base), 'aborted');
});

function issueLoopSample(
  issueNumber: number,
  startedAt: string,
  endedAt: string,
): HarvestedSample {
  const sample: TokenCostIssueLoopSample = {
    schemaVersion: 1,
    kind: 'issue-loop',
    vendor: 'claude',
    model: 'test-model',
    attribution: 'marker-join',
    outcome: 'merged',
    usage: usage(1),
    compactionCount: 0,
    startedAt,
    endedAt,
    vendorSessionId: `session-${issueNumber}-${startedAt}`,
    issueNumber,
    stages: [],
  };
  return {
    sample,
    issueNumber,
    startedAtMs: ms(startedAt),
    endedAtMs: ms(endedAt),
  };
}

test('markAmbiguousOverlaps flags two overlapping sessions on the same issue', () => {
  const a = issueLoopSample(42, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z');
  const b = issueLoopSample(42, '2026-01-01T00:30:00Z', '2026-01-01T01:30:00Z');
  markAmbiguousOverlaps([a, b]);
  assert.equal((a.sample as TokenCostIssueLoopSample).ambiguous, true);
  assert.equal((b.sample as TokenCostIssueLoopSample).ambiguous, true);
  assert.equal(a.sample.outcome, 'unknown');
  assert.equal(b.sample.outcome, 'unknown');
});

test('markAmbiguousOverlaps leaves non-overlapping sessions on the same issue untouched', () => {
  const a = issueLoopSample(43, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z');
  const b = issueLoopSample(43, '2026-01-01T02:00:00Z', '2026-01-01T03:00:00Z');
  markAmbiguousOverlaps([a, b]);
  assert.equal((a.sample as TokenCostIssueLoopSample).ambiguous, undefined);
  assert.equal(a.sample.outcome, 'merged');
});

// ---------------------------------------------------------------------------
// --events file
// ---------------------------------------------------------------------------

test('readEventWindows: missing file returns an empty map', () => {
  const windows = readEventWindows(
    join(tmpdir(), 'does-not-exist-token-cost-events.jsonl'),
  );
  assert.equal(windows.size, 0);
});

test('readEventWindows: pairs a trusted enter/exit for the same (issueNumber, stageId)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-token-cost-events-'));
  const path = join(dir, 'events.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({
        schemaVersion: 1,
        event: 'enter',
        stageId: 'work',
        at: '2026-01-01T00:10:00Z',
        vendor: 'claude',
        issueNumber: 7,
      }),
      JSON.stringify({
        schemaVersion: 1,
        event: 'exit',
        stageId: 'work',
        at: '2026-01-01T00:20:00Z',
        vendor: 'claude',
        issueNumber: 7,
      }),
      // enter with no matching exit: must not appear in the result.
      JSON.stringify({
        schemaVersion: 1,
        event: 'enter',
        stageId: 'review',
        at: '2026-01-01T00:30:00Z',
        vendor: 'claude',
        issueNumber: 7,
      }),
    ].join('\n'),
  );
  try {
    const windows = readEventWindows(path);
    assert.equal(windows.size, 1);
    const window = windows.get('7:claude:work');
    assert.ok(window);
    assert.equal(window?.startMs, ms('2026-01-01T00:10:00Z'));
    assert.equal(window?.endMs, ms('2026-01-01T00:20:00Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: does not pair an enter/exit across two different vendors for the same issue/stage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-token-cost-events-'));
  const path = join(dir, 'events.jsonl');
  writeFileSync(
    path,
    [
      // claude enters 'work' but never exits (handed off).
      JSON.stringify({
        schemaVersion: 1,
        event: 'enter',
        stageId: 'work',
        at: '2026-01-01T00:10:00Z',
        vendor: 'claude',
        issueNumber: 7,
      }),
      // codex resumes and exits 'work' -- must not pair with claude's enter.
      JSON.stringify({
        schemaVersion: 1,
        event: 'exit',
        stageId: 'work',
        at: '2026-01-01T00:20:00Z',
        vendor: 'codex',
        issueNumber: 7,
      }),
    ].join('\n'),
  );
  try {
    const windows = readEventWindows(path);
    assert.equal(windows.size, 0);
    assert.equal(windows.get('7:claude:work'), undefined);
    assert.equal(windows.get('7:codex:work'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: tags a window with vendorSessionId when both enter and exit share one (#2424)', () => {
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'work', '2026-01-01T00:10:00Z', 7, 'sess-A'),
    tokenCostEvent('exit', 'work', '2026-01-01T00:20:00Z', 7, 'sess-A'),
  ]);
  try {
    const windows = readEventWindows(path);
    assert.equal(windows.get('7:claude:work')?.vendorSessionId, 'sess-A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: tags a window with claimId when both enter and exit share one (#2432)', () => {
  const { dir, path } = writeEventsFile([
    tokenCostEvent(
      'enter',
      'work',
      '2026-01-01T00:10:00Z',
      7,
      'sess-A',
      'claude',
      'claim-shared',
    ),
    tokenCostEvent(
      'exit',
      'work',
      '2026-01-01T00:20:00Z',
      7,
      'sess-A',
      'claude',
      'claim-shared',
    ),
  ]);
  try {
    const windows = readEventWindows(path);
    assert.equal(windows.get('7:claude:work')?.claimId, 'claim-shared');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: leaves a window claimId-untagged when the enter and exit claimId disagree (#2432, defensive)', () => {
  const { dir, path } = writeEventsFile([
    tokenCostEvent(
      'enter',
      'work',
      '2026-01-01T00:10:00Z',
      7,
      'sess-A',
      'claude',
      'claim-one',
    ),
    tokenCostEvent(
      'exit',
      'work',
      '2026-01-01T00:20:00Z',
      7,
      'sess-A',
      'claude',
      'claim-two',
    ),
  ]);
  try {
    const windows = readEventWindows(path);
    const window = windows.get('7:claude:work');
    assert.ok(window);
    assert.equal('claimId' in (window ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: leaves a window untagged when an event carries no vendorSessionId (historical-data fallback, #2424)', () => {
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'work', '2026-01-01T00:10:00Z', 7),
    tokenCostEvent('exit', 'work', '2026-01-01T00:20:00Z', 7),
  ]);
  try {
    const windows = readEventWindows(path);
    const window = windows.get('7:claude:work');
    assert.ok(window);
    assert.equal(window?.startMs, ms('2026-01-01T00:10:00Z'));
    assert.equal(window?.endMs, ms('2026-01-01T00:20:00Z'));
    assert.equal('vendorSessionId' in (window ?? {}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEventWindows: prefers the winning cleanup attempt's own stage candidate over a later, unrelated attempt shadowing it (#2424)", () => {
  // Attempt A completes fully: work + cleanup, both id=sess-A. Attempt B
  // later retries 'work' with its own valid pair (id=sess-B) but never
  // reaches cleanup. Pure latest-wins (pre-#2424) would expose B's 'work'
  // window here, shadowing A's own -- this locks in that the resolved
  // 'work' window instead belongs to the SAME attempt as the winning
  // 'cleanup' window.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'work', '2026-01-01T00:00:00Z', 502, 'sess-A'),
    tokenCostEvent('exit', 'work', '2026-01-01T00:01:00Z', 502, 'sess-A'),
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:02:00Z', 502, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:03:00Z', 502, 'sess-A'),
    tokenCostEvent('enter', 'work', '2026-01-01T00:05:00Z', 502, 'sess-B'),
    tokenCostEvent('exit', 'work', '2026-01-01T00:06:00Z', 502, 'sess-B'),
  ]);
  try {
    const windows = readEventWindows(path);
    const work = windows.get('502:claude:work');
    assert.equal(work?.vendorSessionId, 'sess-A');
    assert.equal(work?.startMs, ms('2026-01-01T00:00:00Z'));
    assert.equal(work?.endMs, ms('2026-01-01T00:01:00Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: a claimId match beats an unrelated, differently-identified attempt with a later endMs (Codex review finding, PR #2627, #2432)', () => {
  // Attempt A (claim-shared) completes 'work'. Attempt Z is a wholly
  // unrelated, later attempt at the same stage with NO matching claimId,
  // but a LATER endMs. Attempt B (claim-shared) later completes cleanup
  // without ever re-posting 'work' itself. Pure latest-endMs-wins would
  // expose Z's window here (and #2432's idCompatible would then reject it
  // outright, silently discarding A's genuinely claim-linked contribution
  // before it ever gets a chance) -- claimId, once matched, must outrank
  // mere recency.
  const { dir, path } = writeEventsFile([
    tokenCostEvent(
      'enter',
      'work',
      '2026-01-01T00:00:00Z',
      504,
      'sess-A',
      'claude',
      'claim-shared',
    ),
    tokenCostEvent(
      'exit',
      'work',
      '2026-01-01T00:05:00Z',
      504,
      'sess-A',
      'claude',
      'claim-shared',
    ),
    tokenCostEvent('enter', 'work', '2026-01-01T00:06:00Z', 504, 'sess-Z'),
    tokenCostEvent('exit', 'work', '2026-01-01T00:08:00Z', 504, 'sess-Z'),
    tokenCostEvent(
      'enter',
      'cleanup',
      '2026-01-01T00:20:00Z',
      504,
      'sess-B',
      'claude',
      'claim-shared',
    ),
    tokenCostEvent(
      'exit',
      'cleanup',
      '2026-01-01T00:25:00Z',
      504,
      'sess-B',
      'claude',
      'claim-shared',
    ),
  ]);
  try {
    const windows = readEventWindows(path);
    const work = windows.get('504:claude:work');
    assert.equal(work?.vendorSessionId, 'sess-A');
    assert.equal(work?.claimId, 'claim-shared');
    assert.equal(work?.startMs, ms('2026-01-01T00:00:00Z'));
    assert.equal(work?.endMs, ms('2026-01-01T00:05:00Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: falls back to the identity-agnostic pairing when a stage has no identified events at all, even though cleanup does (#2424)', () => {
  // 'work' predates vendorSessionId entirely (token-cost-event.mjs's own
  // rollout, or a vendor with no session-id source); 'cleanup' is a
  // post-#2424 identified event. 'work' has zero identified candidates,
  // so it resolves via the same identity-agnostic pairing this function
  // used before #2424, untouched by cleanup's own identity.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'work', '2026-01-01T00:00:00Z', 503),
    tokenCostEvent('exit', 'work', '2026-01-01T00:01:00Z', 503),
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:07:00Z', 503, 'sess-B'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:08:00Z', 503, 'sess-B'),
  ]);
  try {
    const windows = readEventWindows(path);
    const work = windows.get('503:claude:work');
    assert.equal('vendorSessionId' in (work ?? {}), false);
    assert.equal(work?.startMs, ms('2026-01-01T00:00:00Z'));
    assert.equal(work?.endMs, ms('2026-01-01T00:01:00Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: a fresher UNIDENTIFIED completion beats a stale identified one for the same stage (Codex review finding, PR #2430, #2424)', () => {
  // Attempt A completes cleanup with an identity (older). Attempt B later
  // ALSO completes cleanup, but without an identity (e.g. a straddling
  // deploy transient, or CLAUDE_CODE_SESSION_ID unset for that run). An
  // unconditional "prefer any identified candidate" rule would freeze on
  // A's stale completion forever -- the resolved window's own stable
  // #ew<issueNumber> id makes a later harvest treat it as already-present.
  // The fix compares recency and lets B's more-recent, internally clean
  // legacy pairing win.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:00:01Z', 507, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:02Z', 507, 'sess-A'),
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:00:05Z', 507),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:06Z', 507),
  ]);
  try {
    const windows = readEventWindows(path);
    const cleanup = windows.get('507:claude:cleanup');
    assert.equal('vendorSessionId' in (cleanup ?? {}), false);
    assert.equal(cleanup?.startMs, ms('2026-01-01T00:00:05Z'));
    assert.equal(cleanup?.endMs, ms('2026-01-01T00:00:06Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: an identified completion still wins on a tie against the identity-agnostic pairing describing the exact same pair (#2424)', () => {
  // The common case: a single, fully identified attempt. legacyWindow
  // (identity-agnostic) trivially describes the SAME pair here, since
  // enterAt/exitAt are populated unconditionally regardless of identity
  // -- ties must resolve to the identified (tagged) result, not silently
  // drop the identity.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:00:01Z', 508, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:02Z', 508, 'sess-A'),
  ]);
  try {
    const windows = readEventWindows(path);
    const cleanup = windows.get('508:claude:cleanup');
    assert.equal(cleanup?.vendorSessionId, 'sess-A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readEventWindows: rejects a legacy pairing that mixes one attempt's enter with a DIFFERENT attempt's exit (Codex review finding round 2, PR #2430, #2424)", () => {
  // Attempt A posts both cleanup boundaries (identified, valid). A later
  // attempt B's own --enter call fails to post (token-cost-event.mjs is
  // fail-open) but its --exit succeeds, landing after A's. The legacy
  // (identity-agnostic) latest-enter/latest-exit pairing would combine
  // A's enter with B's exit -- internally valid-LOOKING, but spanning two
  // attempts. That must never win the recency comparison against A's own
  // clean pair: A's own window is the only trustworthy result here.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:00:01Z', 509, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:02Z', 509, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:09Z', 509, 'sess-B'),
  ]);
  try {
    const windows = readEventWindows(path);
    const cleanup = windows.get('509:claude:cleanup');
    assert.equal(cleanup?.vendorSessionId, 'sess-A');
    assert.equal(cleanup?.startMs, ms('2026-01-01T00:00:01Z'));
    assert.equal(cleanup?.endMs, ms('2026-01-01T00:00:02Z'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readEventWindows: rejects a legacy pairing whose latest enter and exit belong to two DIFFERENT identified attempts, with no identified candidate to fall back to either (#2424)', () => {
  // Neither attempt ever completes its own pair (A's exit missing, B's
  // enter missing), so there is no bestIdentified candidate at all. The
  // legacy pairing would still mix A's enter with B's exit if not gated
  // -- must resolve to no window at all rather than a cross-attempt mix.
  const { dir, path } = writeEventsFile([
    tokenCostEvent('enter', 'cleanup', '2026-01-01T00:00:01Z', 510, 'sess-A'),
    tokenCostEvent('exit', 'cleanup', '2026-01-01T00:00:09Z', 510, 'sess-B'),
  ]);
  try {
    const windows = readEventWindows(path);
    assert.equal(windows.get('510:claude:cleanup'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Trusted marker logins
// ---------------------------------------------------------------------------

test('resolveTrustedMarkerLogins: an explicit flag wins over config', () => {
  assert.deepEqual(resolveTrustedMarkerLogins('alice, bob'), ['alice', 'bob']);
});

test("resolveTrustedMarkerLogins: falls back to this repository's own configured trustedMarkerActors", () => {
  assert.deepEqual(resolveTrustedMarkerLogins(''), ['kurone-kito']);
});

// ---------------------------------------------------------------------------
// GitHub join (stubbed gh, no network) + AC1 end-to-end
// ---------------------------------------------------------------------------

test('fetchIssueLoopGithubContext resolves the earliest PR that closed the issue via closedByPullRequestsReferences (#2444)', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const result = fetchIssueLoopGithubContext('acme', 'repo', 9001, [
      'claude-test',
    ]);
    assert.equal(result.prNumber, 9101);
    assert.equal(result.prCreatedAtMs, ms('2026-01-01T00:10:00Z'));
    assert.equal(result.prMergedAtMs, ms('2026-01-01T00:30:00Z'));
    // This is the PR's own first submitted review only -- resolveIssueLoopContext
    // (tested below) additionally folds in the earlier review-watermark comment.
    assert.equal(result.firstReviewAtMs, ms('2026-01-01T00:22:00Z'));
  } finally {
    restore();
  }
});

test('fetchIssueLoopGithubContext resolves prMergedAtMs even when the closing PR is on an unconventionally-named branch (#2444: closedByPullRequestsReferences scopes by CLOSING relationship, not branch-name pattern)', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const patched = JSON.parse(JSON.stringify(fixture));
  patched.data.repository.issue.closedByPullRequestsReferences.nodes[0].headRefName =
    'hotfix/unrelated-branch-name';
  const restore = stubGhReturningJson(patched);
  try {
    const result = fetchIssueLoopGithubContext('acme', 'repo', 9001, [
      'claude-test',
    ]);
    assert.equal(result.prNumber, 9101);
    assert.equal(result.prMergedAtMs, ms('2026-01-01T00:30:00Z'));
    assert.equal(result.prHeadRefName, 'hotfix/unrelated-branch-name');
  } finally {
    restore();
  }
});

test('fetchIssueLoopGithubContext resolves prMergedAtMs: null when the issue has no closing PR (#2444)', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-unclaimed.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const result = fetchIssueLoopGithubContext('acme', 'repo', 9002, [
      'claude-test',
    ]);
    assert.equal(result.prNumber, null);
    assert.equal(result.prMergedAtMs, null);
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: trusted-login matching is case-insensitive', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    // The fixture's claimed-by comment author is "claude-test"; passing a
    // differently cased trusted login must still resolve the claim (GitHub
    // logins are case-insensitive for account identity) instead of
    // silently treating the marker as untrusted and returning null.
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9001,
      ms('2025-12-31T23:55:00Z'),
      ms('2026-01-01T00:35:00Z'),
      ['Claude-Test'],
    );
    assert.ok(ctx);
    assert.equal(ctx?.claimedAtMs, ms('2026-01-01T00:00:00Z'));
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: firstReviewAtMs is the earlier of the review-watermark and the first submitted review', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9001,
      ms('2025-12-31T23:55:00Z'),
      ms('2026-01-01T00:35:00Z'),
      ['claude-test'],
    );
    assert.ok(ctx);
    // The review-watermark (00:20) predates the submitted review (00:22).
    assert.equal(ctx?.firstReviewAtMs, ms('2026-01-01T00:20:00Z'));
    assert.equal(ctx?.prMergedAtMs, ms('2026-01-01T00:30:00Z'));
    assert.equal(deriveOutcome(ctx as IssueLoopGithubContext), 'merged');
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: a claim marker at exactly sessionEndedAtMs is excluded (half-open interval)', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    // The fixture's only claimed-by marker is at 2026-01-01T00:00:00Z --
    // set sessionEndedAtMs to exactly that instant. The documented window
    // is [sessionStartedAtMs, sessionEndedAtMs), so the claim must not be
    // treated as in-range, leaving no claim and thus no context.
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9001,
      ms('2025-12-31T23:55:00Z'),
      ms('2026-01-01T00:00:00Z'),
      ['claude-test'],
    );
    assert.equal(ctx, null);
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: outcome is unclaimed when a matching unclaimed-by exists and nothing merged', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-unclaimed.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9002,
      ms('2026-02-01T00:00:00Z'),
      ms('2026-02-01T00:10:00Z'),
      ['claude-test'],
    );
    assert.ok(ctx);
    assert.equal(ctx?.claimedAtMs, ms('2026-02-01T00:00:00Z'));
    assert.equal(ctx?.prCreatedAtMs, null);
    assert.equal(ctx?.unclaimedMatched, true);
    assert.equal(deriveOutcome(ctx as IssueLoopGithubContext), 'unclaimed');
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: a later claimed-by marker superseding this claimId from a different agent is a takeover (human-handoff), regardless of session window', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-takeover.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    // claude-a's own session ends at 00:10; the superseding claim from
    // claude-b lands at 00:15, after this session's own window ended --
    // takeover detection is not session-windowed (docs/token-cost.md's
    // Attribution: an issue loop can span multiple vendor sessions).
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9003,
      ms('2026-01-01T00:00:00Z'),
      ms('2026-01-01T00:10:00Z'),
      ['claude-a', 'claude-b'],
    );
    assert.ok(ctx);
    assert.equal(ctx?.humanHandoff, true);
    assert.equal(deriveOutcome(ctx as IssueLoopGithubContext), 'human-handoff');
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: a superseding claim from an untrusted (filtered-out) login is invisible, not a takeover', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-takeover.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9003,
      ms('2026-01-01T00:00:00Z'),
      ms('2026-01-01T00:10:00Z'),
      // Only claude-a is trusted here: the second (claude-b) comment is
      // filtered out entirely before parseClaimComment ever sees it --
      // isolates that humanHandoff is false absent a visible superseding
      // marker at all (distinct from the same-agent guard test below).
      ['claude-a'],
    );
    assert.ok(ctx);
    assert.equal(ctx?.humanHandoff, false);
  } finally {
    restore();
  }
});

test('resolveIssueLoopContext: a superseding claim from the SAME agent is not a takeover', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-resume-same-agent.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    // Both claimed-by comments are trusted and visible here (unlike the
    // filtered-out case above), so this exercises the actual
    // takeover.agentId !== claimAgentId guard: a self re-claim (same
    // agent, superseding its own earlier claimId) must not count as
    // human-handoff.
    const ctx = resolveIssueLoopContext(
      'acme',
      'repo',
      9004,
      ms('2026-01-01T00:00:00Z'),
      ms('2026-01-01T00:10:00Z'),
      ['claude-a'],
    );
    assert.ok(ctx);
    assert.equal(ctx?.humanHandoff, false);
  } finally {
    restore();
  }
});

test('buildSample: an adapter session with an unparseable startedAt skips the GitHub join and stays kind: session', () => {
  const session: VendorSession = {
    vendor: 'claude',
    adapterResult: {
      sample: {
        schemaVersion: 1,
        kind: 'session',
        vendor: 'claude',
        model: 'fake-model',
        attribution: 'session-unscoped',
        outcome: 'unknown',
        usage: usage(1),
        compactionCount: 0,
        startedAt: 'not-a-timestamp',
        endedAt: '2026-01-01T00:10:00Z',
        vendorSessionId: 'fake-session-3',
      },
      joinHints: { issueNumber: 9001 },
    },
    timeline: { mode: 'delta', points: [] },
  };
  // No stubGh: if buildSample attempted the join anyway, the real `gh`
  // binary (or its absence) would make this test fail or hang, proving no
  // network call was attempted.
  const built = buildSample(session, 'acme', 'repo', new Map(), [
    'claude-test',
  ]);
  assert.equal(built.sample.kind, 'session');
  assert.equal(built.startedAtMs, 0);
});

test('AC1: a fake adapter session joined against fixture GitHub markers produces one issue-loop sample whose stage usage sums to the session usage, outcome merged', () => {
  const fixture = readJson(
    'tests/fixtures/token-cost/github/issue-loop-merged.json',
  );
  const restore = stubGhReturningJson(fixture);
  try {
    const session: VendorSession = {
      vendor: 'claude',
      adapterResult: {
        sample: {
          schemaVersion: 1,
          kind: 'session',
          vendor: 'claude',
          model: 'fake-model',
          attribution: 'session-unscoped',
          outcome: 'unknown',
          usage: usage(3),
          compactionCount: 0,
          startedAt: '2025-12-31T23:55:00Z',
          endedAt: '2026-01-01T00:35:00Z',
          vendorSessionId: 'fake-session-1',
        },
        joinHints: { issueNumber: 9001 },
      },
      timeline: {
        mode: 'delta',
        points: [
          { atMs: ms('2025-12-31T23:56:00Z'), usage: usage(1) }, // before claim -> discover
          { atMs: ms('2026-01-01T00:05:00Z'), usage: usage(1) }, // claim
          { atMs: ms('2026-01-01T00:25:00Z'), usage: usage(1) }, // review (no submit-pr/work: PR precedes claim cap)
        ],
      },
    };
    const built = buildSample(session, 'acme', 'repo', new Map(), [
      'claude-test',
    ]);
    assert.equal(built.sample.kind, 'issue-loop');
    const sample = built.sample as TokenCostIssueLoopSample;
    assert.equal(sample.outcome, 'merged');
    assert.equal(sample.attribution, 'marker-join');
    const stageSum = sample.stages.reduce(
      (total, s) => total + usageSum(s.usage),
      0,
    );
    assert.equal(
      stageSum,
      usageSum(...session.timeline.points.map((p) => p.usage)),
    );
  } finally {
    restore();
  }
});

test('AC3: a session with no joinHints.issueNumber stays kind: session, never rewritten to issue-loop', () => {
  const session: VendorSession = {
    vendor: 'codex',
    adapterResult: {
      sample: {
        schemaVersion: 1,
        kind: 'session',
        vendor: 'codex',
        model: 'fake-model',
        attribution: 'session-unscoped',
        outcome: 'unknown',
        usage: usage(1),
        compactionCount: 0,
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:10:00Z',
        vendorSessionId: 'fake-session-2',
      },
    },
    timeline: { mode: 'delta', points: [] },
  };
  const built = buildSample(session, 'acme', 'repo', new Map(), [
    'claude-test',
  ]);
  assert.equal(built.sample.kind, 'session');
  assert.equal(
    (built.sample as { attribution: string }).attribution,
    'session-unscoped',
  );
});

// ---------------------------------------------------------------------------
// Output-file append/dedup (every run rescans full vendor history, so the
// documented "appends to samples.jsonl" behavior must skip sessions already
// recorded rather than overwrite or duplicate them)
// ---------------------------------------------------------------------------

test('vendorSessionKey combines vendor and vendorSessionId', () => {
  assert.equal(
    vendorSessionKey({ vendor: 'claude', vendorSessionId: 'abc' }),
    'claude:abc',
  );
});

test('readExistingVendorSessionKeys: missing file returns an empty set', () => {
  const keys = readExistingVendorSessionKeys(
    join(tmpdir(), 'does-not-exist-token-cost-samples.jsonl'),
  );
  assert.equal(keys.size, 0);
});

test('readExistingVendorSessionKeys: reads (vendor, vendorSessionId) pairs and skips a malformed line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idd-token-cost-samples-'));
  const path = join(dir, 'samples.jsonl');
  writeFileSync(
    path,
    [
      JSON.stringify({ vendor: 'claude', vendorSessionId: 'session-1' }),
      'not valid json',
      JSON.stringify({ vendor: 'codex', vendorSessionId: 'session-2' }),
    ].join('\n'),
  );
  try {
    const keys = readExistingVendorSessionKeys(path);
    assert.equal(keys.size, 2);
    assert.ok(keys.has('claude:session-1'));
    assert.ok(keys.has('codex:session-2'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// --repo flag validation
// ---------------------------------------------------------------------------

test('parseRepoFlag accepts exactly two non-empty segments', () => {
  assert.deepEqual(parseRepoFlag('acme/repo'), { owner: 'acme', repo: 'repo' });
});

test('parseRepoFlag rejects extra, missing, or empty segments', () => {
  assert.equal(parseRepoFlag('owner/repo/extra'), null);
  assert.equal(parseRepoFlag('/repo'), null);
  assert.equal(parseRepoFlag('owner/'), null);
  assert.equal(parseRepoFlag('owner'), null);
  assert.equal(parseRepoFlag(''), null);
});

test('parseRepoFlag trims surrounding and per-segment whitespace', () => {
  assert.deepEqual(parseRepoFlag(' acme/repo '), {
    owner: 'acme',
    repo: 'repo',
  });
  assert.deepEqual(parseRepoFlag('acme / repo'), {
    owner: 'acme',
    repo: 'repo',
  });
  assert.equal(parseRepoFlag('  '), null);
});
