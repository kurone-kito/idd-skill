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
  parseRepoFlag,
  readEventWindows,
  readExistingVendorSessionKeys,
  resolveIssueLoopContext,
  resolveTrustedMarkerLogins,
  type StageEventWindow,
  type VendorSession,
  vendorSessionKey,
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

test('resolveIssueLoopContext: a superseding claim from the SAME agent is not a takeover', () => {
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
      // filtered out entirely, simulating "no takeover marker visible" --
      // isolates that humanHandoff is false absent a superseding marker.
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
