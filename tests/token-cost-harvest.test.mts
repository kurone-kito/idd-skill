import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  buildSample,
  computeStageWindows,
  deriveOutcome,
  extractClaudeUsageTimeline,
  extractCodexUsageTimeline,
  fetchIssueLoopGithubContext,
  type HarvestedSample,
  type IssueLoopGithubContext,
  markAmbiguousOverlaps,
  readEventWindows,
  resolveIssueLoopContext,
  resolveTrustedMarkerLogins,
  type StageEventWindow,
  type VendorSession,
} from '../src/scripts/token-cost-harvest.mts';
import { readJson } from './test-utils.mts';

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
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-token-cost-harvest-test-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempRoot}:${originalPath ?? ''}`;
  return () => {
    process.env.PATH = originalPath;
    rmSync(tempRoot, { recursive: true, force: true });
  };
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
    const window = windows.get('7:work');
    assert.ok(window);
    assert.equal(window?.startMs, ms('2026-01-01T00:10:00Z'));
    assert.equal(window?.endMs, ms('2026-01-01T00:20:00Z'));
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

test('fetchIssueLoopGithubContext resolves the earliest live-connected same-branch PR', () => {
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
