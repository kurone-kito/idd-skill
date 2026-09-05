// idd-generated-from: src/scripts/token-cost-harvest.mts
//
// The scripts/token-cost-harvest.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Token-cost harvest CLI (#2292). Source-repo only: not HELPER_COMMANDS,
// registered in tests/helper-invocation-profile.test.mts's
// SOURCE_REPO_INTERNAL_ENTRY_PATHS instead (see docs/token-cost.md).
//
// Scans the already-shipped vendor adapters (token-cost-adapter-claude.mts
// #2290, token-cost-adapter-codex.mts #2291, token-cost-adapter-grok.mts
// #2289), joins each harvested session against this repository's own
// GitHub IDD markers (claim, review-watermark, merge) to reconstruct
// per-issue IDD stage windows, and writes TokenCostSample JSONL. Does
// not render the README -- that stays token-cost-report.mjs's job.

import {
  appendFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { parseCliArgs } from './cli-args.mts';
import { combineOwnerRepoFlags, ghGraphql } from './gh-exec.mts';
import {
  parseClaimComment,
  parseForcedHandoffComment,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from './marker-helpers.mts';
import {
  type ClaudeHarvestInput,
  claudeAdapter,
  defaultClaudeProjectDir,
  deriveFallbackSessionId,
  extractRecordTimestampMs,
  extractSessionId,
  parseClaudeProjectLines,
  segmentRecordsByCwd,
} from './token-cost-adapter-claude.mts';
import {
  type CodexHarvestInput,
  codexAdapter,
  defaultCodexSessionsDir,
  extractSessionCwd,
  isIddSkillCwd,
  parseCodexRolloutLines,
} from './token-cost-adapter-codex.mts';
import {
  defaultGrokSessionsDir,
  scanGrokSessions,
} from './token-cost-adapter-grok.mts';
import {
  assertTokenCostSample,
  redactTokenCostRecord,
  TOKEN_COST_STAGE_IDS,
  type TokenCostAdapterResult,
  type TokenCostAttribution,
  type TokenCostEvent,
  type TokenCostIssueLoopSample,
  type TokenCostOutcome,
  type TokenCostSample,
  type TokenCostSessionSample,
  type TokenCostStageId,
  type TokenCostStageUsage,
  type TokenCostUsage,
  type TokenCostVendor,
} from './token-cost-core.mts';

// ---------------------------------------------------------------------------
// Shared usage arithmetic
// ---------------------------------------------------------------------------

const ZERO_USAGE: TokenCostUsage = {
  inputUncached: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  reasoning: 0,
};

function addUsage(a: TokenCostUsage, b: TokenCostUsage): TokenCostUsage {
  return {
    inputUncached: a.inputUncached + b.inputUncached,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

function subtractUsageClamped(
  a: TokenCostUsage,
  b: TokenCostUsage,
): TokenCostUsage {
  const clamp = (x: number, y: number) => Math.max(0, x - y);
  return {
    inputUncached: clamp(a.inputUncached, b.inputUncached),
    cacheRead: clamp(a.cacheRead, b.cacheRead),
    cacheCreation: clamp(a.cacheCreation, b.cacheCreation),
    output: clamp(a.output, b.output),
    reasoning: clamp(a.reasoning, b.reasoning),
  };
}

function usageTotal(u: TokenCostUsage): number {
  return (
    u.inputUncached + u.cacheRead + u.cacheCreation + u.output + u.reasoning
  );
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

// ---------------------------------------------------------------------------
// Per-vendor usage timelines
//
// Adapters (token-cost-adapter-claude.mts / -codex.mts) intentionally
// expose only one aggregate `usage` total per session -- their public
// contract is one-sample-per-session. Stage-window splitting needs a
// per-timestamp series, so this module re-derives one locally from the
// same raw records the adapters already parse (via the already-exported
// parseClaudeProjectLines / parseCodexRolloutLines), reading each file
// once and feeding the identical `records` array to both the adapter's
// own harvest() and the local timeline extractor below -- never two
// divergent reads. The small per-record field-mapping duplication here
// is deliberate; each function cites its adapter-module source of truth
// so drift is visible in review.
// ---------------------------------------------------------------------------

/** One usage observation at a point in session time. */
interface UsagePoint {
  atMs: number;
  usage: TokenCostUsage;
}

/** A vendor's usage timeline is either per-message deltas or cumulative snapshots. */
export interface UsageTimeline {
  mode: 'delta' | 'cumulative';
  points: readonly UsagePoint[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toValidTimestampMs(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Mirrors token-cost-adapter-claude.mts's usageFromFields (per-message delta). */
function claudeUsageFromFields(raw: Record<string, unknown>): TokenCostUsage {
  const split = raw.cache_creation;
  const cacheCreation = isPlainObject(split)
    ? toNonNegativeInt(split.ephemeral_5m_input_tokens) +
      toNonNegativeInt(split.ephemeral_1h_input_tokens)
    : toNonNegativeInt(raw.cache_creation_input_tokens);
  return {
    inputUncached: toNonNegativeInt(raw.input_tokens),
    cacheRead: toNonNegativeInt(raw.cache_read_input_tokens),
    cacheCreation,
    output: toNonNegativeInt(raw.output_tokens),
    reasoning: 0,
  };
}

/** Mirrors token-cost-adapter-claude.mts's extractUsage's per-record source: assistant records' message.usage. */
export function extractClaudeUsageTimeline(
  records: readonly unknown[],
): UsageTimeline {
  const points: UsagePoint[] = [];
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'assistant') {
      continue;
    }
    const atMs = toValidTimestampMs(record.timestamp);
    const message = isPlainObject(record.message) ? record.message : undefined;
    const usageRaw =
      message && isPlainObject(message.usage) ? message.usage : undefined;
    if (atMs === undefined || !usageRaw) {
      continue;
    }
    points.push({ atMs, usage: claudeUsageFromFields(usageRaw) });
  }
  points.sort((a, b) => a.atMs - b.atMs);
  return { mode: 'delta', points };
}

/** Mirrors token-cost-adapter-codex.mts's usageFromTokenCounts (shared field shape for both cumulative and delta payloads). */
function codexUsageFromTokenCounts(
  raw: Record<string, unknown>,
): TokenCostUsage {
  const inputTokens = toNonNegativeInt(raw.input_tokens);
  const cacheRead = toNonNegativeInt(raw.cached_input_tokens);
  const cacheCreation = toNonNegativeInt(raw.cache_write_input_tokens);
  const inputUncached =
    inputTokens >= cacheRead + cacheCreation
      ? inputTokens - cacheRead - cacheCreation
      : inputTokens;
  return {
    inputUncached,
    cacheRead,
    cacheCreation,
    output: toNonNegativeInt(raw.output_tokens),
    reasoning: toNonNegativeInt(raw.reasoning_output_tokens),
  };
}

/**
 * Mirrors token-cost-adapter-codex.mts's extractUsage's own per-session
 * preference (total_token_usage when any record carries one, else
 * last_token_usage deltas) -- applied per record here instead of
 * collapsed to one session total, since stage-window splitting needs
 * the whole timeline, not just the final value.
 */
export function extractCodexUsageTimeline(
  records: readonly unknown[],
): UsageTimeline {
  const tokenCountRecords: {
    atMs: number;
    payload: Record<string, unknown>;
  }[] = [];
  for (const record of records) {
    if (!isPlainObject(record) || record.type !== 'token_count') {
      continue;
    }
    const atMs = toValidTimestampMs(record.timestamp);
    const payload = isPlainObject(record.payload) ? record.payload : undefined;
    if (atMs === undefined || !payload) {
      continue;
    }
    tokenCountRecords.push({ atMs, payload });
  }
  tokenCountRecords.sort((a, b) => a.atMs - b.atMs);

  const hasCumulative = tokenCountRecords.some((r) =>
    isPlainObject(r.payload.total_token_usage),
  );
  if (hasCumulative) {
    const points: UsagePoint[] = [];
    for (const { atMs, payload } of tokenCountRecords) {
      const total = payload.total_token_usage;
      if (isPlainObject(total)) {
        points.push({ atMs, usage: codexUsageFromTokenCounts(total) });
      }
    }
    return { mode: 'cumulative', points };
  }
  const points: UsagePoint[] = [];
  for (const { atMs, payload } of tokenCountRecords) {
    const last = payload.last_token_usage;
    if (isPlainObject(last)) {
      points.push({ atMs, usage: codexUsageFromTokenCounts(last) });
    }
  }
  return { mode: 'delta', points };
}

// ---------------------------------------------------------------------------
// Stage windows
// ---------------------------------------------------------------------------

interface StageWindow {
  id: TokenCostStageId;
  startMs: number;
  endMs: number;
  source: 'marker' | 'event';
}

/** GitHub-derived context needed to reconstruct one session's stage windows. Any field left null omits the stages it would have bounded. */
export interface IssueLoopGithubContext {
  claimedAtMs: number | null;
  prCreatedAtMs: number | null;
  prHeadRefName: string | null;
  prMergedAtMs: number | null;
  firstReviewAtMs: number | null;
  cleanupAtMs: number | null;
  unclaimedMatched: boolean;
  humanHandoff: boolean;
}

/** Event-derived window override for one (issueNumber, stageId) pair, from a trusted enter/exit pair in the --events file. */
export interface StageEventWindow {
  startMs: number;
  endMs: number;
  /** The enter/exit pair's shared vendorSessionId (#2424), when both events carried one. Absent for historical data and vendors with no known session-id source. */
  vendorSessionId?: string;
  /** The enter/exit pair's shared IDD {claim-id} (#2432), when both events carried the SAME one and the pair is itself identified (has a vendorSessionId). Positive evidence this window belongs to a specific claim lineage, independent of which process/session posted it. */
  claimId?: string;
}

const CLAIM_STAGE_CAP_MS = 15 * 60 * 1000;
/** Thin cap for the merge stage when no cleanup marker activity is resolvable. */
const MERGE_STAGE_THIN_CAP_MS = 15 * 60 * 1000;

/**
 * Builds the stage-window tiling of [sessionStartedAtMs, sessionEndedAtMs)
 * per the issue's marker-join table, then lets --events override individual
 * stage boundaries. Contiguous tiling (each window starts exactly where the
 * previous one ended) is what makes the per-stage usage allocation below sum
 * back to the session total exactly, in both delta and cumulative modes --
 * the marker-only pass always produces it. Once --events overrides are
 * applied, an event window's timestamps are authoritative and never
 * expanded, while a marker window always flows to fill the space around it
 * (backward past its own original start, forward past its own original
 * end) -- so the result stays gap-free everywhere a marker window can
 * reach. A residual gap is possible only immediately before an event
 * window whose immediately preceding window is itself event-sourced (or
 * absent, at session start): there, no marker exists to flow into it, and
 * that usage is genuinely unattributed to any stage rather than misattributed.
 */
export function computeStageWindows(
  sessionStartedAtMs: number,
  sessionEndedAtMs: number,
  ctx: IssueLoopGithubContext,
  eventWindows: ReadonlyMap<TokenCostStageId, StageEventWindow>,
): { windows: StageWindow[]; attribution: 'marker-join' | 'phase-event' } {
  const windows: StageWindow[] = [];
  const push = (id: TokenCostStageId, startMs: number, endMs: number) => {
    if (endMs > startMs) {
      windows.push({ id, startMs, endMs, source: 'marker' });
    }
  };

  if (ctx.claimedAtMs === null) {
    return { windows: [], attribution: 'marker-join' };
  }

  let cursor = ctx.claimedAtMs;
  push('discover', sessionStartedAtMs, cursor);

  const claimCap = cursor + CLAIM_STAGE_CAP_MS;
  if (ctx.prCreatedAtMs !== null) {
    const claimEnd = Math.min(claimCap, ctx.prCreatedAtMs);
    push('claim', cursor, claimEnd);
    cursor = claimEnd;
    push('work', cursor, ctx.prCreatedAtMs);
    cursor = ctx.prCreatedAtMs;

    // A review submitted after the merge (e.g. a bot reviewing an
    // admin-merged PR post hoc) must not push submit-pr's end past
    // prMergedAtMs — otherwise the merge window below would start before
    // submit-pr's own end and double-count the overlap. Clamp to whichever
    // is earlier.
    const effectiveFirstReviewAtMs =
      ctx.firstReviewAtMs !== null && ctx.prMergedAtMs !== null
        ? Math.min(ctx.firstReviewAtMs, ctx.prMergedAtMs)
        : ctx.firstReviewAtMs;

    const submitPrEnd =
      effectiveFirstReviewAtMs !== null
        ? effectiveFirstReviewAtMs
        : ctx.prMergedAtMs !== null
          ? ctx.prMergedAtMs
          : sessionEndedAtMs;
    push('submit-pr', cursor, submitPrEnd);
    cursor = submitPrEnd;

    if (ctx.prMergedAtMs !== null) {
      // A merged PR always emits review/merge/cleanup, even when no
      // pre-merge review was resolvable (review is then zero-width and
      // omitted by push()) — merged usage must never fall entirely into
      // submit-pr just because nobody reviewed before merging.
      push('review', cursor, ctx.prMergedAtMs);
      cursor = ctx.prMergedAtMs;

      const uncappedMergeEnd =
        ctx.cleanupAtMs !== null
          ? ctx.cleanupAtMs
          : ctx.prMergedAtMs + MERGE_STAGE_THIN_CAP_MS;
      const mergeEnd = Math.min(uncappedMergeEnd, sessionEndedAtMs);
      push('merge', cursor, mergeEnd);
      cursor = mergeEnd;
      push('cleanup', cursor, sessionEndedAtMs);
      cursor = sessionEndedAtMs;
    } else if (effectiveFirstReviewAtMs !== null) {
      push('review', cursor, sessionEndedAtMs);
      cursor = sessionEndedAtMs;
    }
  } else {
    const claimEnd = Math.min(claimCap, sessionEndedAtMs);
    push('claim', cursor, claimEnd);
    cursor = claimEnd;
    push('work', cursor, sessionEndedAtMs);
    cursor = sessionEndedAtMs;
  }

  let attribution: 'marker-join' | 'phase-event' = 'marker-join';
  const byId = new Map<TokenCostStageId, StageWindow>(
    windows.map((w) => [w.id, w]),
  );
  for (const [stageId, eventWindow] of eventWindows) {
    if (eventWindow.endMs <= eventWindow.startMs) {
      continue;
    }
    byId.set(stageId, {
      id: stageId,
      startMs: eventWindow.startMs,
      endMs: eventWindow.endMs,
      source: 'event',
    });
    attribution = 'phase-event';
  }

  // Re-tile in canonical stage order: an --events override's timestamps can
  // disagree with its marker-derived neighbors (or two overrides can
  // disagree with each other), and naively overlaying them can leave
  // windows that overlap -- which would double-count delta-mode usage in
  // allocateStageUsage below. An event window is an authoritative explicit
  // timestamp, so it is only ever clamped forward past a conflicting
  // predecessor, never expanded. A marker window is a synthetic
  // reconstruction with no independent authority, so it always starts
  // exactly at the running cursor (flowing backward to fill a gap an event
  // override left behind it) and, symmetrically, is retroactively extended
  // forward to meet the start of an event window that follows it with a
  // gap -- rather than leaving that usage unattributed to any stage.
  const finalWindows: StageWindow[] = [];
  let normalizeCursor = sessionStartedAtMs;
  for (const stageId of TOKEN_COST_STAGE_IDS) {
    const window = byId.get(stageId);
    if (!window) {
      continue;
    }
    if (window.source === 'event' && window.startMs > normalizeCursor) {
      const prevIndex = finalWindows.length - 1;
      const prev = finalWindows[prevIndex];
      if (prev && prev.source === 'marker') {
        const extendedEndMs = Math.min(window.startMs, sessionEndedAtMs);
        finalWindows[prevIndex] = { ...prev, endMs: extendedEndMs };
        normalizeCursor = extendedEndMs;
      }
    }
    const startMs =
      window.source === 'event'
        ? Math.max(window.startMs, normalizeCursor)
        : normalizeCursor;
    const endMs = Math.min(window.endMs, sessionEndedAtMs);
    if (endMs > startMs) {
      finalWindows.push({ ...window, startMs, endMs });
      normalizeCursor = endMs;
    }
  }
  return { windows: finalWindows, attribution };
}

/** Sums every delta-mode point whose timestamp falls in [startMs, endMs). */
function sumDeltaInRange(
  points: readonly UsagePoint[],
  startMs: number,
  endMs: number,
): TokenCostUsage {
  let sum = ZERO_USAGE;
  for (const point of points) {
    if (point.atMs >= startMs && point.atMs < endMs) {
      sum = addUsage(sum, point.usage);
    }
  }
  return sum;
}

/**
 * Last cumulative snapshot at or before atMs (or strictly before, when
 * exclusive), or null when none exists yet. exclusive matters for a
 * window's own START boundary: a point exactly at window.startMs
 * represents usage that happened AT the start of this window, not before
 * it, so it must not be picked up as the subtraction baseline (which
 * would silently drop that point's own contribution) -- unlike the END
 * boundary, which correctly wants an inclusive lookup so a point exactly
 * at window.endMs still counts toward this window.
 */
function cumulativeSnapshotAt(
  points: readonly UsagePoint[],
  atMs: number,
  exclusive = false,
): TokenCostUsage | null {
  let result: TokenCostUsage | null = null;
  for (const point of points) {
    if (exclusive ? point.atMs < atMs : point.atMs <= atMs) {
      result = point.usage;
    } else {
      break;
    }
  }
  return result;
}

/**
 * Allocates each stage window's usage from a timeline. Cumulative mode uses
 * a running baseline carried from the previous window (the previous
 * window's own end snapshot) whenever this window starts exactly where the
 * previous one ended -- a point exactly at that shared boundary must be
 * counted in exactly one of the two windows, and re-deriving the baseline
 * from a fresh lookup instead of reusing the running value can skip past
 * that point onto an earlier one, double-counting its growth (a point at a
 * shared boundary would then be included via the earlier window's inclusive
 * end AND again via the later window's own growth). When this window does
 * NOT start where the previous one ended -- computeStageWindows can leave
 * a gap before an event window whose predecessor is also event-sourced --
 * the baseline is looked up fresh, exclusive of a point exactly at the gap
 * window's own start (so that point's growth, which happened AT this
 * window's start, is counted as this window's usage rather than treated as
 * a prior baseline); this also covers the very first window, and is what
 * excludes a gap's cumulative growth from folding into the next window's
 * delta, matching delta mode's natural gap exclusion via sumDeltaInRange.
 * For fully contiguous windows (the common case) this telescopes exactly:
 * every window's delta sums to the timeline's final cumulative snapshot
 * minus zero, matching the adapter's own `usage` total.
 */
export function allocateStageUsage(
  windows: readonly StageWindow[],
  timeline: UsageTimeline,
): TokenCostStageUsage[] {
  const out: TokenCostStageUsage[] = [];
  let previousEndMs: number | null = null;
  let previousEndSnapshot: TokenCostUsage = ZERO_USAGE;
  for (const window of windows) {
    let usage: TokenCostUsage;
    if (timeline.mode === 'cumulative') {
      const contiguous = previousEndMs === window.startMs;
      const startSnapshot = contiguous
        ? previousEndSnapshot
        : (cumulativeSnapshotAt(timeline.points, window.startMs, true) ??
          ZERO_USAGE);
      const endSnapshot =
        cumulativeSnapshotAt(timeline.points, window.endMs) ?? startSnapshot;
      usage = subtractUsageClamped(endSnapshot, startSnapshot);
      previousEndMs = window.endMs;
      previousEndSnapshot = endSnapshot;
    } else {
      usage = sumDeltaInRange(timeline.points, window.startMs, window.endMs);
    }
    if (usageTotal(usage) > 0) {
      out.push({ id: window.id, usage });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outcome + ambiguity
// ---------------------------------------------------------------------------

export function deriveOutcome(ctx: IssueLoopGithubContext): TokenCostOutcome {
  if (ctx.prMergedAtMs !== null) {
    return 'merged';
  }
  if (ctx.humanHandoff) {
    return 'human-handoff';
  }
  if (ctx.unclaimedMatched) {
    return 'unclaimed';
  }
  return 'aborted';
}

export interface HarvestedSample {
  sample: TokenCostSample;
  issueNumber?: number;
  startedAtMs: number;
  endedAtMs: number;
}

/**
 * Two harvested issue-loop samples on the same issue with overlapping
 * [startedAt, endedAt) ranges mean two concurrent sessions genuinely
 * worked the same issue -- neither's usage can be cleanly attributed, so
 * both are marked ambiguous/unknown rather than either being trusted.
 */
export function markAmbiguousOverlaps(samples: HarvestedSample[]): void {
  const byIssue = new Map<number, HarvestedSample[]>();
  for (const entry of samples) {
    if (entry.issueNumber === undefined || entry.sample.kind !== 'issue-loop') {
      continue;
    }
    const group = byIssue.get(entry.issueNumber) ?? [];
    group.push(entry);
    byIssue.set(entry.issueNumber, group);
  }
  for (const group of byIssue.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const overlap =
          a.startedAtMs < b.endedAtMs && b.startedAtMs < a.endedAtMs;
        if (overlap) {
          const sampleA = a.sample as TokenCostIssueLoopSample;
          const sampleB = b.sample as TokenCostIssueLoopSample;
          sampleA.ambiguous = true;
          sampleB.ambiguous = true;
          sampleA.outcome = 'unknown';
          sampleB.outcome = 'unknown';
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GitHub join
// ---------------------------------------------------------------------------

interface TrustedComment {
  body: string;
  createdAt: string;
  login: string;
}

// GitHub logins are case-insensitive for account identity; compare
// case-insensitively so a --trusted-marker-logins/config entry typed with
// different casing than the GraphQL-reported author.login still matches,
// rather than silently treating every marker as untrusted.
function isTrusted(login: string, trustedLogins: readonly string[]): boolean {
  const normalized = login.toLowerCase();
  return trustedLogins.some((trusted) => trusted.toLowerCase() === normalized);
}

/** flag > config.json trustedMarkerActors > empty (fail closed: nothing is trusted). */
export function resolveTrustedMarkerLogins(flagValue: string): string[] {
  const fromFlag = flagValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (fromFlag.length > 0) {
    return fromFlag;
  }
  try {
    const raw = readFileSync(
      join(process.cwd(), '.github/idd/config.json'),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { trustedMarkerActors?: unknown };
    if (Array.isArray(parsed.trustedMarkerActors)) {
      return parsed.trustedMarkerActors.filter(
        (v): v is string => typeof v === 'string',
      );
    }
  } catch {}
  return [];
}

const ISSUE_LOOP_CONTEXT_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      comments(first:100){nodes{body createdAt author{login}}}
      closedByPullRequestsReferences(first:10){
        nodes{
          number headRefName createdAt mergedAt
          reviews(first:1){nodes{submittedAt}}
        }
      }
    }
  }
}`;

interface RawIssueLoopContextResponse {
  data?: {
    repository?: {
      issue?: {
        comments?: { nodes?: unknown };
        closedByPullRequestsReferences?: { nodes?: unknown };
      };
    };
  };
}

/** Fetches issue comments plus the earliest PR that closed this issue (with its first review + merge timestamp) via one batched GraphQL query. */
export function fetchIssueLoopGithubContext(
  owner: string,
  repo: string,
  issueNumber: number,
  trustedLogins: readonly string[],
): {
  comments: TrustedComment[];
  prNumber: number | null;
  prHeadRefName: string | null;
  prCreatedAtMs: number | null;
  prMergedAtMs: number | null;
  firstReviewAtMs: number | null;
} {
  const response = ghGraphql(ISSUE_LOOP_CONTEXT_QUERY, {
    owner,
    repo,
    number: issueNumber,
  }) as RawIssueLoopContextResponse;

  const issue = response.data?.repository?.issue;
  const commentNodes = Array.isArray(issue?.comments?.nodes)
    ? issue.comments.nodes
    : [];
  const comments: TrustedComment[] = [];
  for (const node of commentNodes) {
    if (!isPlainObject(node)) {
      continue;
    }
    const login =
      isPlainObject(node.author) && typeof node.author.login === 'string'
        ? node.author.login
        : '';
    const body = typeof node.body === 'string' ? node.body : '';
    const createdAt = typeof node.createdAt === 'string' ? node.createdAt : '';
    if (login && body && createdAt && isTrusted(login, trustedLogins)) {
      comments.push({ body, createdAt, login });
    }
  }

  // closedByPullRequestsReferences already scopes to PRs GitHub recorded
  // as actually CLOSING this issue (the "Closes #N" keyword this
  // repository's own IDD workflow exclusively uses), so no branch-name
  // guard is needed here. This field's predecessor,
  // ConnectedEvent/DisconnectedEvent, only recorded a manual
  // Development-panel LINK -- which merely connects a PR to an issue
  // without closing it -- so it never matched this repository's automated
  // keyword-closed PRs at all (#2444). Normally exactly one PR closes a
  // given issue in this repository's workflow; the earliest-createdAt
  // tie-break below is defensive for the rare case of more than one.
  const prNodes = Array.isArray(issue?.closedByPullRequestsReferences?.nodes)
    ? issue.closedByPullRequestsReferences.nodes
    : [];
  let chosen: Record<string, unknown> | null = null;
  let chosenNumber: number | null = null;
  for (const node of prNodes) {
    if (!isPlainObject(node) || typeof node.number !== 'number') {
      continue;
    }
    const createdAtMs = toValidTimestampMs(node.createdAt);
    if (createdAtMs === undefined) {
      continue;
    }
    const chosenCreatedAtMs = chosen
      ? (toValidTimestampMs(chosen.createdAt) ?? Infinity)
      : Infinity;
    if (createdAtMs < chosenCreatedAtMs) {
      chosen = node;
      chosenNumber = node.number;
    }
  }

  if (!chosen) {
    return {
      comments,
      prNumber: null,
      prHeadRefName: null,
      prCreatedAtMs: null,
      prMergedAtMs: null,
      firstReviewAtMs: null,
    };
  }

  const reviews =
    isPlainObject(chosen.reviews) && Array.isArray(chosen.reviews.nodes)
      ? chosen.reviews.nodes
      : [];
  let firstReviewAtMs: number | null = null;
  for (const review of reviews) {
    if (!isPlainObject(review)) {
      continue;
    }
    const submittedAtMs = toValidTimestampMs(review.submittedAt);
    if (
      submittedAtMs !== undefined &&
      (firstReviewAtMs === null || submittedAtMs < firstReviewAtMs)
    ) {
      firstReviewAtMs = submittedAtMs;
    }
  }

  return {
    comments,
    prNumber: chosenNumber,
    prHeadRefName:
      typeof chosen.headRefName === 'string' ? chosen.headRefName : null,
    prCreatedAtMs: toValidTimestampMs(chosen.createdAt) ?? null,
    prMergedAtMs: toValidTimestampMs(chosen.mergedAt) ?? null,
    firstReviewAtMs,
  };
}

/**
 * Resolves the full {@link IssueLoopGithubContext} for one session's
 * [sessionStartedAtMs, sessionEndedAtMs) window: the first trusted
 * claimed-by comment posted in that range, the earliest first trusted
 * review-watermark (compared against the linked PR's first submitted
 * review), and whether that claim was later released or handed off
 * before merge.
 */
export function resolveIssueLoopContext(
  owner: string,
  repo: string,
  issueNumber: number,
  sessionStartedAtMs: number,
  sessionEndedAtMs: number,
  trustedLogins: readonly string[],
): IssueLoopGithubContext | null {
  const github = fetchIssueLoopGithubContext(
    owner,
    repo,
    issueNumber,
    trustedLogins,
  );

  let claimedAtMs: number | null = null;
  let claimAgentId: string | null = null;
  let claimId: string | null = null;
  for (const comment of github.comments) {
    const claim = parseClaimComment(comment.body, comment.createdAt);
    if (!claim) {
      continue;
    }
    const atMs = toValidTimestampMs(claim.createdAt);
    // Half-open [sessionStartedAtMs, sessionEndedAtMs), matching this
    // function's documented session window: a claim marker at exactly
    // sessionEndedAtMs is out of range.
    if (
      atMs === undefined ||
      atMs < sessionStartedAtMs ||
      atMs >= sessionEndedAtMs
    ) {
      continue;
    }
    if (claimedAtMs === null || atMs < claimedAtMs) {
      claimedAtMs = atMs;
      claimAgentId = claim.agentId;
      claimId = claim.claimId;
    }
  }

  if (claimedAtMs === null) {
    return null;
  }

  let firstWatermarkAtMs: number | null = null;
  for (const comment of github.comments) {
    const watermark = parseReviewWatermarkComment(
      comment.body,
      comment.createdAt,
    );
    if (
      !watermark ||
      watermark.agentId !== claimAgentId ||
      watermark.claimId !== claimId
    ) {
      // Skip watermarks bound to a different claim attempt (for example a
      // stale one from before a takeover) -- same ownership check the
      // release/handoff matching below already applies.
      continue;
    }
    const atMs = toValidTimestampMs(watermark.createdAt);
    if (
      atMs !== undefined &&
      (firstWatermarkAtMs === null || atMs < firstWatermarkAtMs)
    ) {
      firstWatermarkAtMs = atMs;
    }
  }
  const firstReviewAtMs = [firstWatermarkAtMs, github.firstReviewAtMs]
    .filter((v): v is number => v !== null)
    .reduce(
      (min, v) => (min === null || v < min ? v : min),
      null as number | null,
    );

  let unclaimedMatched = false;
  let humanHandoff = false;
  for (const comment of github.comments) {
    const release = parseReleaseComment(comment.body);
    if (
      release &&
      release.agentId === claimAgentId &&
      release.claimId === claimId
    ) {
      unclaimedMatched = true;
    }
    const handoff = parseForcedHandoffComment(comment.body, comment.createdAt);
    if (
      handoff &&
      handoff.oldAgentId === claimAgentId &&
      handoff.oldClaimId === claimId
    ) {
      humanHandoff = true;
    }
    // A later claimed-by marker naming this session's own claimId in its
    // supersedes field, from a different agent, is a silent takeover --
    // the outcome table's "a different actor takes the claim before
    // merge" row, same as an explicit forced-handoff marker.
    const takeover = parseClaimComment(comment.body, comment.createdAt);
    if (
      takeover &&
      takeover.supersedes === claimId &&
      takeover.agentId !== claimAgentId
    ) {
      humanHandoff = true;
    }
  }

  return {
    claimedAtMs,
    prCreatedAtMs: github.prCreatedAtMs,
    prHeadRefName: github.prHeadRefName,
    prMergedAtMs: github.prMergedAtMs,
    firstReviewAtMs,
    cleanupAtMs: null,
    unclaimedMatched,
    humanHandoff,
  };
}

// ---------------------------------------------------------------------------
// --events file
// ---------------------------------------------------------------------------

const TOKEN_COST_VENDORS = ['grok', 'claude', 'codex'] as const;

function isTokenCostVendor(value: unknown): value is TokenCostVendor {
  return (
    typeof value === 'string' &&
    (TOKEN_COST_VENDORS as readonly string[]).includes(value)
  );
}

// Keyed by vendor too, not just (issueNumber, stageId): two different vendor
// sessions can both log phase events for the same issue and stage (a
// claude->codex handoff mid-loop), and their enter/exit timestamps must not
// be paired across vendors into one bogus window.
function eventKey(
  issueNumber: number,
  vendor: TokenCostVendor,
  stageId: TokenCostStageId,
): string {
  return `${issueNumber}:${vendor}:${stageId}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface AttemptCandidate {
  vendorSessionId: string;
  startMs: number;
  endMs: number;
  claimId?: string;
}

/**
 * Reads a --events JSONL file into per-(issueNumber, vendor, stageId)
 * enter/exit window overrides. A missing file is not an error -- returns
 * an empty map.
 *
 * #2424: `TokenCostEvent.vendorSessionId`, when present on BOTH the enter
 * and the exit an event carries, scopes pairing to that one attempt --
 * two attempts for the same (issueNumber, vendor, stageId) key no longer
 * silently pair one's `--enter` with the other's stale `--exit`. Per
 * (issueNumber, vendor) group, `cleanup`'s own window is resolved first;
 * every other stage then prefers the candidate sharing `cleanup`'s own
 * winning `vendorSessionId` when one exists (regardless of recency -- a
 * same-attempt candidate is always correct once matched). Absent a
 * preferred-identity match (including `cleanup`'s own resolution, which
 * has no preference to match against), this compares the latest VALID
 * (`startMs < endMs`) pairing among identified attempts against the
 * identity-agnostic latest-wins pairing this function used before #2424,
 * and returns whichever has the more recent `endMs` -- identified breaks
 * a tie. An event with no `vendorSessionId` at all (all historical data,
 * and any vendor with no known session-id source) never populates an
 * attempt bucket, so a bareKey whose events are entirely unidentified
 * resolves via the untouched identity-agnostic path, byte-identical to
 * this function's pre-#2424 behavior. The recency comparison (rather
 * than always preferring identified) matters for a completed, identified
 * attempt followed by a later retry that completes WITHOUT an identity
 * (env var unset, a deploy-straddling transient) -- an unconditional
 * identified preference would freeze on the STALE identified completion
 * forever, since the resulting window's own stable `#ew<issueNumber>` id
 * makes a later harvest treat it as already-present (Codex review
 * finding, PR #2430).
 *
 * #2432/Codex review (PR #2627): absent an exact-session match, a
 * candidate sharing `cleanup`'s own `claimId` is preferred over the plain
 * recency-based `bestIdentified`/legacy comparison above -- claimId, once
 * matched, is this repository's own ground-truth ownership token for
 * "same claim lineage, possibly handed off across sessions," so it must
 * outrank a merely-more-recent but unrelated attempt at the same bareKey.
 * Without this tier, a single stray same-stage event from ANY differently-
 * or un-identified attempt (an unrelated concurrent session, an aborted
 * retry) could win purely on `endMs` and get returned instead of the
 * genuine claim-linked candidate -- which `buildCompletedIssueWindows`'s
 * `idCompatible` would then exclude outright, silently defeating claim-id
 * recovery before it ever runs. This tier does not close every residual:
 * if the earlier handoff session and the winning `cleanup` session both
 * post the identical stage id (a redundant re-post, not the common
 * disjoint-stage handoff shape), only one window survives per bareKey --
 * a documented limitation, not a regression, since neither pre-#2424 nor
 * pre-#2432 behavior could recover it either.
 */
export function readEventWindows(path: string): Map<string, StageEventWindow> {
  const result = new Map<string, StageEventWindow>();
  if (!existsSync(path)) {
    return result;
  }
  const enterAt = new Map<string, number>();
  const exitAt = new Map<string, number>();
  // bareKey -> vendorSessionId of whichever event set enterAt/exitAt's
  // CURRENT value for that key (undefined when that latest event carried
  // no identity). Lets the legacy pairing's own trustworthiness be
  // checked before it competes with an identified candidate -- see
  // resolveWindow below.
  const enterAtOwner = new Map<string, string | undefined>();
  const exitAtOwner = new Map<string, string | undefined>();
  // bareKey -> vendorSessionId -> latest timestamp. Only populated for
  // events that carry a non-empty vendorSessionId.
  const enterAtByAttempt = new Map<string, Map<string, number>>();
  const exitAtByAttempt = new Map<string, Map<string, number>>();
  // bareKey -> vendorSessionId -> claimId of whichever event set that
  // attempt's CURRENT latest timestamp above (#2432). Only meaningful
  // alongside an identified (vendorSessionId-bearing) attempt -- an
  // unidentified event has no attempt bucket to disambiguate a claimId
  // against, so claimId is never tracked on the legacy bareKey path.
  const enterClaimIdByAttempt = new Map<
    string,
    Map<string, string | undefined>
  >();
  const exitClaimIdByAttempt = new Map<
    string,
    Map<string, string | undefined>
  >();
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) {
      continue;
    }
    const event = parsed as Partial<TokenCostEvent>;
    if (
      typeof event.issueNumber !== 'number' ||
      typeof event.stageId !== 'string' ||
      !(TOKEN_COST_STAGE_IDS as readonly string[]).includes(event.stageId) ||
      !isTokenCostVendor(event.vendor) ||
      (event.event !== 'enter' && event.event !== 'exit')
    ) {
      continue;
    }
    const atMs = toValidTimestampMs(event.at);
    if (atMs === undefined) {
      continue;
    }
    const key = eventKey(
      event.issueNumber,
      event.vendor,
      event.stageId as TokenCostStageId,
    );
    const vendorSessionId = isNonEmptyString(event.vendorSessionId)
      ? event.vendorSessionId
      : undefined;
    const claimId = isNonEmptyString(event.claimId) ? event.claimId : undefined;
    if (event.event === 'enter') {
      enterAt.set(key, atMs);
      enterAtOwner.set(key, vendorSessionId);
      if (vendorSessionId !== undefined) {
        const byAttempt =
          enterAtByAttempt.get(key) ?? new Map<string, number>();
        byAttempt.set(vendorSessionId, atMs);
        enterAtByAttempt.set(key, byAttempt);
        const claimIdByAttempt =
          enterClaimIdByAttempt.get(key) ??
          new Map<string, string | undefined>();
        claimIdByAttempt.set(vendorSessionId, claimId);
        enterClaimIdByAttempt.set(key, claimIdByAttempt);
      }
    } else {
      exitAt.set(key, atMs);
      exitAtOwner.set(key, vendorSessionId);
      if (vendorSessionId !== undefined) {
        const byAttempt = exitAtByAttempt.get(key) ?? new Map<string, number>();
        byAttempt.set(vendorSessionId, atMs);
        exitAtByAttempt.set(key, byAttempt);
        const claimIdByAttempt =
          exitClaimIdByAttempt.get(key) ??
          new Map<string, string | undefined>();
        claimIdByAttempt.set(vendorSessionId, claimId);
        exitClaimIdByAttempt.set(key, claimIdByAttempt);
      }
    }
  }

  const attemptCandidates = (key: string): AttemptCandidate[] => {
    const enters = enterAtByAttempt.get(key);
    const exits = exitAtByAttempt.get(key);
    if (!enters || !exits) {
      return [];
    }
    const enterClaimIds = enterClaimIdByAttempt.get(key);
    const exitClaimIds = exitClaimIdByAttempt.get(key);
    const candidates: AttemptCandidate[] = [];
    for (const [vendorSessionId, startMs] of enters) {
      const endMs = exits.get(vendorSessionId);
      if (endMs !== undefined) {
        // The attempt's own claimId requires its enter and exit to agree
        // (both undefined, or the same value) -- one stage's enter/exit
        // share one claim in practice, so disagreement is defensive: it
        // degrades to undefined rather than guessing which side is right.
        const enterClaimId = enterClaimIds?.get(vendorSessionId);
        const exitClaimId = exitClaimIds?.get(vendorSessionId);
        const claimId = enterClaimId === exitClaimId ? enterClaimId : undefined;
        candidates.push({
          vendorSessionId,
          startMs,
          endMs,
          ...(claimId !== undefined ? { claimId } : {}),
        });
      }
    }
    return candidates;
  };

  const resolveWindow = (
    key: string,
    preferredVendorSessionId: string | undefined,
    preferredClaimId: string | undefined,
  ): StageEventWindow | undefined => {
    const candidates = attemptCandidates(key);
    if (preferredVendorSessionId !== undefined) {
      const preferred = candidates.find(
        (candidate) => candidate.vendorSessionId === preferredVendorSessionId,
      );
      if (preferred) {
        return {
          startMs: preferred.startMs,
          endMs: preferred.endMs,
          vendorSessionId: preferred.vendorSessionId,
          ...(preferred.claimId !== undefined
            ? { claimId: preferred.claimId }
            : {}),
        };
      }
    }
    const valid = candidates.filter(
      (candidate) => candidate.startMs < candidate.endMs,
    );
    // #2432/Codex review (PR #2627): no exact-session match above means
    // this stage was posted by some OTHER process than cleanup's own --
    // among those, a candidate sharing cleanup's own claimId is the SAME
    // claim lineage (a genuine handoff contributor) and must not be
    // shadowed by an unrelated, differently- or un-identified attempt
    // that merely happens to have a later `endMs`. Without this, a single
    // stray same-stage event from any unrelated attempt would silently
    // defeat claim-id recovery entirely, before `idCompatible` ever gets
    // a chance to run.
    const claimMatched =
      preferredClaimId !== undefined
        ? valid.filter((candidate) => candidate.claimId === preferredClaimId)
        : [];
    const claimPreferred =
      claimMatched.length > 0
        ? claimMatched.reduce((a, b) => (b.endMs > a.endMs ? b : a))
        : undefined;
    if (claimPreferred) {
      return {
        startMs: claimPreferred.startMs,
        endMs: claimPreferred.endMs,
        vendorSessionId: claimPreferred.vendorSessionId,
        claimId: claimPreferred.claimId as string,
      };
    }
    const bestIdentified =
      valid.length > 0
        ? valid.reduce((a, b) => (b.endMs > a.endMs ? b : a))
        : undefined;
    const legacyStartMs = enterAt.get(key);
    const legacyEndMs = exitAt.get(key);
    // Codex review finding round 2, PR #2430: the latest enter and the
    // latest exit for this bareKey can belong to two DIFFERENT attempts
    // -- e.g. attempt A posts both cleanup boundaries, and a later
    // attempt B's own `--enter` call fails to post (fail-open) while its
    // `--exit` succeeds and lands after A's. enterAt/exitAt would then
    // mix A's enter with B's exit into a window that looks internally
    // valid but spans two attempts, permanently corrupting attribution
    // if it wins the recency comparison below. legacyWindow is only
    // considered when its own latest enter and latest exit share the
    // SAME owner (both unidentified, or the same identified attempt --
    // the latter is always redundant with a `bestIdentified` candidate,
    // since an identified event updates both the bucketed AND the
    // unconditional maps together). "Both unidentified" is a necessary
    // check, not a sufficient one: it cannot distinguish one genuine
    // unidentified attempt's own clean pair from two DIFFERENT
    // unidentified attempts whose latest enter and exit happen to line
    // up (e.g. concurrent sessions C and D, neither stamped, C's enter
    // and D's exit both being the bareKey's own latest). That residual
    // is byte-identical to the pairing ambiguity this whole function
    // pre-#2424 could never resolve either -- identity adds no signal
    // when neither side carries one.
    const legacyOwnersMatch = enterAtOwner.get(key) === exitAtOwner.get(key);
    const legacyWindow =
      legacyOwnersMatch &&
      legacyStartMs !== undefined &&
      legacyEndMs !== undefined &&
      legacyStartMs < legacyEndMs
        ? { startMs: legacyStartMs, endMs: legacyEndMs }
        : undefined;
    // Codex review finding round 1, PR #2430: an identified valid
    // candidate is not automatically more current than a TRUSTED legacy
    // pairing -- e.g. a completed, identified attempt A followed by a
    // later retry B that completes WITHOUT an identity (env var unset, a
    // straddling deploy transient). legacyWindow already reflects B's
    // own clean pair whenever B's own enter and exit are each
    // individually the latest seen (and thus share the same
    // -- undefined -- owner) -- prefer whichever candidate is more
    // recent (its own endMs), identified breaking a tie (the common
    // single-attempt or already-identified case, where both sides
    // describe the exact same pair).
    if (bestIdentified && legacyWindow) {
      return bestIdentified.endMs >= legacyWindow.endMs
        ? {
            startMs: bestIdentified.startMs,
            endMs: bestIdentified.endMs,
            vendorSessionId: bestIdentified.vendorSessionId,
            ...(bestIdentified.claimId !== undefined
              ? { claimId: bestIdentified.claimId }
              : {}),
          }
        : legacyWindow;
    }
    if (bestIdentified) {
      return {
        startMs: bestIdentified.startMs,
        endMs: bestIdentified.endMs,
        vendorSessionId: bestIdentified.vendorSessionId,
        ...(bestIdentified.claimId !== undefined
          ? { claimId: bestIdentified.claimId }
          : {}),
      };
    }
    return legacyWindow;
  };

  const issueVendorPrefixes = new Set<string>();
  for (const key of enterAt.keys()) {
    issueVendorPrefixes.add(key.slice(0, key.lastIndexOf(':')));
  }
  for (const key of exitAt.keys()) {
    issueVendorPrefixes.add(key.slice(0, key.lastIndexOf(':')));
  }

  for (const prefix of issueVendorPrefixes) {
    const cleanupKey = `${prefix}:cleanup`;
    const cleanupWindow = resolveWindow(cleanupKey, undefined, undefined);
    if (cleanupWindow) {
      result.set(cleanupKey, cleanupWindow);
    }
    for (const stageId of TOKEN_COST_STAGE_IDS) {
      if (stageId === 'cleanup') {
        continue;
      }
      const key = `${prefix}:${stageId}`;
      const window = resolveWindow(
        key,
        cleanupWindow?.vendorSessionId,
        cleanupWindow?.claimId,
      );
      if (window) {
        result.set(key, window);
      }
    }
  }
  return result;
}

function eventWindowsForIssue(
  all: ReadonlyMap<string, StageEventWindow>,
  issueNumber: number,
  vendor: TokenCostVendor,
): Map<TokenCostStageId, StageEventWindow> {
  const out = new Map<TokenCostStageId, StageEventWindow>();
  for (const stageId of TOKEN_COST_STAGE_IDS) {
    const window = all.get(eventKey(issueNumber, vendor, stageId));
    if (window) {
      out.set(stageId, window);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Event-window issue-number fallback (#2418)
// ---------------------------------------------------------------------------

/** One issue's overall [earliest enter, latest exit] span across every stage it has an event window for, for a single vendor. */
export interface CompletedIssueWindow {
  issueNumber: number;
  startMs: number;
  endMs: number;
  /** The winning `cleanup` window's own vendorSessionId (#2424), when known -- lets a cross-file resolver attribute this window to the one file that actually posted it. */
  vendorSessionId?: string;
  /** The winning `cleanup` window's own claimId (#2432), when known. */
  claimId?: string;
  /**
   * The primary (cleanup-owning) session's own qualifying stage windows
   * -- cleanup itself plus every boundary-consistent, same-vendorSessionId
   * -or-unidentified stage -- kept as INDIVIDUAL windows, never unioned
   * into one enclosing span. `scanClaudeVendorSessions` filters the
   * primary file's own records against this set (a record must fall
   * inside at least one of these windows to count), and the cross-session
   * overlap guard below compares these same individual windows against
   * each contributor's -- an enclosing span would falsely "overlap" a
   * contributor sandwiched inside an idle gap between two of the
   * primary's own stages (Copilot review finding round on PR #2627, #2432).
   */
  primaryWindows: { startMs: number; endMs: number }[];
  /**
   * Other sessions' own qualifying stage windows, one entry PER admitted
   * stage (never unioned or deduplicated by vendorSessionId -- the same
   * reasoning as `primaryWindows` above: a consumer groups entries by
   * `vendorSessionId` when resolving which file to pull from, but must
   * keep each stage's own individual bounds for both record filtering and
   * the overlap guard). Present only when at least one non-cleanup window
   * was admitted via the claimId branch of `idCompatible` (a different
   * vendorSessionId than `cleanup`'s own). Absent for a single-session
   * completed window, exactly as before #2432.
   */
  contributingWindows?: {
    vendorSessionId: string;
    startMs: number;
    endMs: number;
  }[];
}

/**
 * Builds one overall window per issue number that has a CLOSED, VALID
 * `cleanup` stage event window (both `--enter` and `--exit` posted, with
 * `startMs < endMs`) for `vendor`. The `cleanup` requirement is
 * deliberate: an in-progress issue-loop's mid-flight harvest would
 * otherwise permanently freeze that issue's sample at partial usage the
 * first time it is harvested -- the `#ew<issueNumber>` `vendorSessionId`
 * suffix this fallback produces (see `token-cost-adapter-claude.mts`) is
 * stable, so `vendorSessionKey` dedup would silently skip every later,
 * fuller harvest as "already present." Gating on a closed `cleanup`
 * window matches roadmap #2296's locked "one *completed* issue-loop"
 * unit, at the cost of never harvesting an issue whose loop was
 * abandoned before reaching cleanup (deferred rather than wrong, not a
 * data-loss concern: `events.jsonl` is append-only, so a later harvest
 * picks it up if cleanup ever runs).
 *
 * The window's `endMs` is ALWAYS the valid cleanup window's own `endMs`
 * -- never a max across every stage -- and a stage only widens `startMs`
 * when its OWN window (both ends) falls at or before that cleanup exit.
 * This guards against `readEventWindows`'s own pairing: it pairs the
 * LATEST `--enter` seen for a (issue, vendor, stage) key with the LATEST
 * `--exit`, across the whole append-only file, with no knowledge of
 * which attempt either belongs to.
 *
 * - A completed run followed by a re-attempt that enters `cleanup` again
 *   but never exits pairs that new, still-open enter with the FIRST
 *   attempt's stale exit, producing a reversed window (`startMs >
 *   endMs`) -- `startMs < endMs` rejects this outright, so the mere
 *   presence of a `cleanup` key is never enough on its own.
 * - A completed run followed by a re-attempt that has NOT yet re-entered
 *   `cleanup` at all leaves the original, still-valid cleanup pair
 *   untouched, but the re-attempt's OTHER stage events (e.g. a fresh
 *   `work` enter/exit) land in `eventWindowsAll` too, with timestamps
 *   AFTER the original cleanup's own exit. Capping `endMs` at cleanup's
 *   own exit, and excluding any stage window that extends past it from
 *   widening `startMs`, keeps that later, still-in-progress activity out
 *   of the completed window -- without this, its partial usage would be
 *   folded into the union and permanently frozen under the stable
 *   `#ew<issueNumber>` id as if the (unfinished) retry were the
 *   completed loop.
 * - A later attempt whose own `--enter` (or `--exit`) call for some
 *   non-`cleanup` stage silently fails (`token-cost-event.mjs` is
 *   deliberately fail-open) can leave that stage's pairing mixing one
 *   attempt's enter with an EARLIER, unrelated attempt's exit, which
 *   `readEventWindows` reports as reversed (`startMs > endMs`) once the
 *   later attempt's own timestamp is newer than the stale one it paired
 *   with. Excluding such a window from the union (as `startMs < endMs`
 *   already does above) is not enough on its own: `startMs` still
 *   silently degrades to the stable `cleanup`-only window instead of
 *   surfacing the contamination. A reversed non-`cleanup` stage window
 *   whose own `startMs` falls at or before the completed run's own
 *   `cleanup.endMs` is treated as direct evidence that this issue's
 *   event history is corrupted for THIS harvest, so the whole issue is
 *   skipped rather than emitted with a silently narrowed window (no
 *   sample beats a wrong one). A reversed window entirely past
 *   `cleanup.endMs` is ordinary mid-retry noise from a later, distinct
 *   attempt and does not block emission of the already-completed window.
 *   The remaining case -- a stage whose stale, EARLIER-attempt pairing
 *   happens to still be internally valid (non-reversed), e.g. because
 *   BOTH of the later attempt's own enter/exit calls for that stage
 *   failed -- is mechanically indistinguishable from a genuine early
 *   start WITHOUT an attempt/session identity on the underlying events.
 *   #2424 closes this: `readEventWindows` now tags a window with the
 *   `vendorSessionId` its enter/exit pair shared (when both events
 *   carried one), and this function excludes a non-`cleanup` stage from
 *   BOTH the widening loop and the contamination check above whenever
 *   its own `vendorSessionId` is known and differs from the winning
 *   `cleanup` window's own -- before either of those checks even runs,
 *   so a mismatched attempt's window can neither poison the widened
 *   `startMs` nor trigger a whole-issue skip on a different attempt's
 *   behalf. A window with no identity on either side (historical data,
 *   non-Claude vendors, or an issue whose loop straddles this feature's
 *   own deployment) is unaffected: identity-compatible windows still
 *   flow through the pre-#2424 checks exactly as before.
 */
export function buildCompletedIssueWindows(
  eventWindowsAll: ReadonlyMap<string, StageEventWindow>,
  vendor: TokenCostVendor,
): CompletedIssueWindow[] {
  const stagesByIssue = new Map<number, Map<string, StageEventWindow>>();
  for (const [key, window] of eventWindowsAll) {
    const [issueNumberRaw, keyVendor, stageId] = key.split(':');
    if (keyVendor !== vendor) {
      continue;
    }
    const issueNumber = Number(issueNumberRaw);
    if (!Number.isInteger(issueNumber)) {
      continue;
    }
    const stages = stagesByIssue.get(issueNumber) ?? new Map();
    stages.set(stageId, window);
    stagesByIssue.set(issueNumber, stages);
  }
  const out: CompletedIssueWindow[] = [];
  for (const [issueNumber, stages] of stagesByIssue) {
    const cleanup = stages.get('cleanup');
    if (!cleanup || cleanup.startMs >= cleanup.endMs) {
      continue;
    }
    // #2424: a non-cleanup window whose vendorSessionId is known and
    // differs from cleanup's own belongs to a different attempt --
    // exclude it outright, before either check below runs. This is
    // deliberately ASYMMETRIC, not "undefined on either side means
    // unidentified, treat as compatible" (Codex review finding round 3,
    // PR #2430: that symmetric form let an UNIDENTIFIED cleanup --
    // e.g. a fresh retry that legitimately won readEventWindows' own
    // recency comparison over a stale identified completion -- absorb
    // ANY identified stage window unconditionally, including one that
    // provably belongs to a DIFFERENT, earlier attempt). A window's own
    // identity, once present, is real evidence of a distinct attempt --
    // `vendorSessionId` is derived once per Claude Code process
    // lifetime, so an identified stage and an unidentified cleanup can
    // never legitimately be the SAME attempt. The only "no contradicting
    // evidence" case is when the WINDOW itself lacks an identity
    // (historical data, or a stage that predates this field even though
    // cleanup itself is a fresh, identified completion).
    //
    // Two residuals stay unreachable from event identity alone, both
    // pre-answered rather than fixed:
    // - identified cleanup + unidentified stage from a genuinely
    //   DIFFERENT attempt is indistinguishable from the deploy-straddling
    //   case above: no event-level signal separates "the stage predates
    //   this field" from "the stage belongs to an unrelated attempt that
    //   never got identified." Treated as compatible; the ambiguity
    //   self-resolves once every event postdates this feature's rollout.
    // - when BOTH the winning cleanup and a stage window are unidentified
    //   (owners undefined on both sides), this check proves nothing about
    //   whether they're the same real attempt or two different
    //   unidentified ones -- byte-identical to the pre-#2424 residual;
    //   identity cannot see it either way.
    //
    // A third case (Codex review finding round 5, PR #2430, #2424; shipped
    // in #2432): a `vendorSessionId` mismatch proves a different PROCESS,
    // not a different ATTEMPT -- docs/token-cost.md's own Scope explicitly
    // allows one issue loop to span multiple Claude sessions via a
    // handoff or resume, and this check alone can't tell that legitimate
    // case apart from a genuinely unrelated, abandoned earlier attempt.
    // `idCompatible` below adds a second, independent admission path for
    // exactly this case: a non-cleanup window whose own `claimId` (#2432,
    // threaded from the IDD `{claim-id}` a caller optionally passes to
    // `token-cost-event.mjs --claim-id`) MATCHES cleanup's own is treated
    // as compatible even when its `vendorSessionId` differs -- `claimId`
    // is this repository's own ground-truth ownership token for "same
    // claim lineage, possibly handed off across sessions," independent of
    // which process posted the event. A window admitted only via this
    // claimId branch (not also same-`vendorSessionId`-or-unidentified) is
    // additionally recorded as a `contributingWindows` entry so
    // `scanClaudeVendorSessions` can pull that session's own file's
    // records in too, instead of merely widening the bounds without the
    // usage to back them. `claimId` absent on either side (historical
    // data, or a caller that doesn't pass `--claim-id`) falls back to
    // today's narrower, single-session-only behavior unchanged. Two
    // claim-id-matched windows from DIFFERENT vendorSessionIds that
    // OVERLAP each other in time (a narrow, documented TOCTOU race in
    // `idd-claim.instructions.md` where two sessions can momentarily
    // share one active `{claim-id}`) are treated as contamination and
    // skip the whole issue, same as a reversed window below -- a genuine
    // sequential handoff never produces overlapping activity.
    const idCompatible = (window: StageEventWindow): boolean =>
      window.vendorSessionId === undefined ||
      window.vendorSessionId === cleanup.vendorSessionId ||
      (window.claimId !== undefined && window.claimId === cleanup.claimId);
    const candidateStages = [...stages].filter(
      ([stageId, window]) => stageId === 'cleanup' || idCompatible(window),
    );
    const hasContaminatedStage = candidateStages.some(
      ([stageId, window]) =>
        stageId !== 'cleanup' &&
        window.startMs >= window.endMs &&
        window.startMs <= cleanup.endMs,
    );
    if (hasContaminatedStage) {
      continue;
    }
    // Named once, reused by the `startMs`/`primaryWindows` widening loop
    // below and by the `contributingWindows` loop after it, so a future
    // change to either predicate can't silently desync the two (Copilot
    // review, PR #2627).
    const isBoundaryConsistent = (window: StageEventWindow): boolean =>
      window.startMs <= cleanup.endMs && window.endMs <= cleanup.endMs;
    const isSameSessionOrUnidentified = (window: StageEventWindow): boolean =>
      window.vendorSessionId === undefined ||
      window.vendorSessionId === cleanup.vendorSessionId;
    let startMs = cleanup.startMs;
    // The primary/cleanup-owning session's own INDIVIDUAL stage windows
    // (every same-vendorSessionId-or-unidentified window, boundary
    // consistent) -- kept as separate intervals rather than one enclosing
    // span, so the cross-session overlap guard below can tell a real
    // overlap apart from a contributor's window merely falling inside a
    // GAP between two of the primary session's own disjoint stages (e.g.
    // an A -> B -> A handoff, where A owns an early stage plus the later
    // `cleanup` and B owns an intervening stage that never actually
    // touches either of A's own windows).
    const primaryWindows: { startMs: number; endMs: number }[] = [];
    for (const [, window] of candidateStages) {
      if (isBoundaryConsistent(window)) {
        startMs = Math.min(startMs, window.startMs);
        if (isSameSessionOrUnidentified(window)) {
          primaryWindows.push({
            startMs: window.startMs,
            endMs: window.endMs,
          });
        }
      }
    }
    // #2432: a boundary-consistent, claimId-matched window whose own
    // vendorSessionId differs from cleanup's own is a genuine
    // contributing session. Kept as INDIVIDUAL per-stage windows -- never
    // unioned into one enclosing range per vendorSessionId -- for the same
    // reason `primaryWindows` above is: a contributing session's own two
    // stages can themselves be non-adjacent (e.g. an early `work` and a
    // much later `review`), and a union would falsely "overlap" the
    // primary session's own unrelated activity that merely falls inside
    // that GAP, or pull that gap's unrelated records into the merge.
    const contributingWindows: {
      vendorSessionId: string;
      startMs: number;
      endMs: number;
    }[] = [];
    for (const [stageId, window] of candidateStages) {
      if (
        stageId === 'cleanup' ||
        isSameSessionOrUnidentified(window) ||
        !isBoundaryConsistent(window)
      ) {
        continue;
      }
      contributingWindows.push({
        // Guaranteed non-undefined here: `isSameSessionOrUnidentified`
        // already returned false, so `window.vendorSessionId` must be a
        // defined string that differs from `cleanup.vendorSessionId`.
        vendorSessionId: window.vendorSessionId as string,
        startMs: window.startMs,
        endMs: window.endMs,
      });
    }
    // Cross-session overlap guard: a genuine sequential handoff never
    // produces overlapping activity between two different sessions. Two
    // claim-id-matched windows from DIFFERENT vendorSessionIds that DO
    // overlap is evidence of the narrow, documented TOCTOU race in
    // `idd-claim.instructions.md` where two sessions can momentarily
    // share one active claim-id without one being a clean continuation of
    // the other -- treat the whole issue as contaminated, same as a
    // reversed window above (no sample beats a wrong one). Compares each
    // contributor against the primary session's own INDIVIDUAL stage
    // windows (`primaryWindows`), not one enclosing span from its
    // earliest stage to `cleanup.endMs` -- an enclosing span would falsely
    // flag a legitimate A -> B -> A handoff, where B's own window merely
    // falls inside the GAP between two of A's own disjoint stages
    // (Codex review finding, PR #2627).
    // Deliberately its own local closure, not a reuse of `rangesOverlap`
    // below: that one compares closed `[min, max]` RecordTimeRanges (real
    // observed record timestamps), while this compares half-open
    // `[startMs, endMs)` stage windows (the same convention
    // `segmentRecordsByEventWindow` uses) -- the boundary is strict `<`
    // here, not `rangesOverlap`'s inclusive `<=`, because two windows
    // merely touching at a shared instant is not a genuine overlap under
    // that convention.
    const overlaps = (
      a: { startMs: number; endMs: number },
      b: { startMs: number; endMs: number },
    ): boolean => a.startMs < b.endMs && b.startMs < a.endMs;
    const hasCrossSessionOverlap =
      contributingWindows.some((contributing) =>
        primaryWindows.some((primaryWindow) =>
          overlaps(primaryWindow, contributing),
        ),
      ) ||
      contributingWindows.some((a, i) =>
        contributingWindows.some((b, j) => i < j && overlaps(a, b)),
      );
    if (hasCrossSessionOverlap) {
      continue;
    }
    out.push({
      issueNumber,
      startMs,
      endMs: cleanup.endMs,
      primaryWindows,
      ...(cleanup.vendorSessionId !== undefined
        ? { vendorSessionId: cleanup.vendorSessionId }
        : {}),
      ...(cleanup.claimId !== undefined ? { claimId: cleanup.claimId } : {}),
      ...(contributingWindows.length > 0 ? { contributingWindows } : {}),
    });
  }
  return out;
}

/**
 * Partitions `records` by which single `CompletedIssueWindow` (if any)
 * each record's own timestamp falls inside, via `getTimestampMs`. A
 * record with no valid timestamp, or one whose timestamp falls inside
 * zero or more than one window, is left out of every group rather than
 * guessed: concurrent sessions append to one shared, HOME-keyed
 * `events.jsonl`, so two different issues' windows can genuinely overlap
 * in wall-clock, and "exactly one match" is the only safe attribution.
 * Windows are half-open (`[startMs, endMs)`, matching `computeStageWindows`'s
 * own convention) so a record at the exact instant one issue's window ends
 * and an adjacent issue's window begins matches only the later window,
 * rather than being wrongly treated as ambiguous between the two.
 * Preserves each group's original file-order relative to itself.
 */
export function segmentRecordsByEventWindow(
  records: readonly unknown[],
  issueWindows: readonly CompletedIssueWindow[],
  getTimestampMs: (record: unknown) => number | undefined,
): Map<number, unknown[]> {
  const groups = new Map<number, unknown[]>();
  for (const record of records) {
    const atMs = getTimestampMs(record);
    if (atMs === undefined) {
      continue;
    }
    const matches = issueWindows.filter(
      (window) => atMs >= window.startMs && atMs < window.endMs,
    );
    if (matches.length !== 1) {
      continue;
    }
    const issueNumber = matches[0].issueNumber;
    const group = groups.get(issueNumber);
    if (group) {
      group.push(record);
    } else {
      groups.set(issueNumber, [record]);
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Vendor scan
// ---------------------------------------------------------------------------

export interface VendorSession {
  vendor: TokenCostVendor;
  adapterResult: TokenCostAdapterResult;
  timeline: UsageTimeline;
}

interface RecordTimeRange {
  minMs: number;
  maxMs: number;
}

function computeRecordTimeRange(
  records: readonly unknown[],
  getTimestampMs: (record: unknown) => number | undefined,
): RecordTimeRange | undefined {
  let minMs: number | undefined;
  let maxMs: number | undefined;
  for (const record of records) {
    const atMs = getTimestampMs(record);
    if (atMs === undefined) {
      continue;
    }
    minMs = minMs === undefined ? atMs : Math.min(minMs, atMs);
    maxMs = maxMs === undefined ? atMs : Math.max(maxMs, atMs);
  }
  return minMs === undefined || maxMs === undefined
    ? undefined
    : { minMs, maxMs };
}

function rangesOverlap(a: RecordTimeRange, b: RecordTimeRange): boolean {
  return a.minMs <= b.maxMs && b.minMs <= a.maxMs;
}

/**
 * #2404: a long-lived session's project JSONL file is not necessarily one
 * cwd for its whole lifetime -- `segmentRecordsByCwd` (see
 * token-cost-adapter-claude.mts) splits it into contiguous per-cwd runs
 * first, and this scans one `VendorSession` per segment instead of one per
 * file, so a session that moves across several `issue/<n>-*` worktrees
 * still produces a correctly-scoped, correctly-joined sample per worktree.
 * `extractClaudeUsageTimeline` is called with just the segment's own
 * records (not the whole file's), matching `claudeAdapter.harvest()`'s own
 * per-segment scoping -- otherwise a segment's stage-usage allocation
 * would double-count usage from its sibling segments.
 *
 * #2418: #2404 only helps a session whose `cwd` actually varies mid-file.
 * On a workstation where every session is launched once from the primary
 * worktree and reaches other worktrees only via in-conversation `cd`
 * (never a fresh Claude Code launch), `cwd` never varies at all, so
 * #2404's segmentation is never exercised and #2404 alone still produces
 * zero issue-loop samples. This additionally partitions by event window
 * (`segmentRecordsByEventWindow`, gated to CLOSED `cleanup` windows only
 * -- see `buildCompletedIssueWindows`) and calls `claudeAdapter.harvest()`
 * once more per matched issue, via `issueNumberOverride`. This is
 * additive, not a replacement: every cwd-segment's own plain cwd-only
 * sample (`kind: 'session'` when cwd-inference fails) is still produced
 * exactly as before, so nothing already working regresses.
 * `aggregateSnapshot` (`token-cost-report.mts`) only ever counts
 * `kind: 'issue-loop'` samples toward the published snapshot, so a
 * `session`-kind sample coexisting with event-window-derived
 * `issue-loop` samples drawn from the same underlying records cannot
 * double-count anything published.
 *
 * Event-window partitioning runs ONCE per FILE, across every cwd-segment
 * whose own cwd-inference failed, not once per segment. A file whose
 * `cwd` changes to some non-`issue/<n>-*` value more than once (any
 * ordinary directory switch, not just a worktree move) would otherwise
 * split those records across separate cwd-segments; partitioning
 * per-segment would independently re-derive the SAME `#ew<issueNumber>`
 * suffix from more than one segment and push a duplicate-keyed
 * `VendorSession` within a single harvest run, which the append-side
 * dedup (keyed only against samples from PRIOR runs) cannot catch.
 *
 * #2425: event windows carry no session/file identity, so the SAME issue
 * number's unattributed candidates can come from more than one project
 * log file. #2418 skips the issue entirely whenever more than one file
 * contributes, on the theory that this is a rare, genuinely-concurrent
 * overlap. #2419 measured this on a real workstation and found it is the
 * DOMINANT case, not the rare one (10 of 12 completed issue-loops), which
 * initially suggested a MERGE (rather than skip) of file candidates whose
 * matched-record time ranges are provably disjoint -- a sequential
 * continuation, not concurrency.
 *
 * That merge was investigated and explicitly REJECTED after implementing
 * it: checked directly against real file timestamps, and the actual
 * multi-file matches on this workstation are genuinely CONCURRENT,
 * overlapping activity (two files both spanning the same ~24h range,
 * both still being appended to) -- not a sequential split, so the merge
 * recovers nothing real. Worse, a range-disjointness check is a weak
 * discriminator for SPARSE candidates: a single stray record from an
 * unrelated concurrent session can never "overlap" anything by
 * definition, so a naive disjoint-range merge would misattribute that
 * unrelated file's usage into this issue's sample under the stable
 * `#ew<issueNumber>` id, permanently -- exactly the class of bug the
 * original #2418 guard exists to prevent (see the test locking this in:
 * "two DIFFERENT project log files both matching the same issue window
 * are BOTH dropped"). Multi-file skips are still classified as
 * disjoint-or-overlapping (visible in stderr) for diagnostic value.
 *
 * #2424: a `CompletedIssueWindow`'s own `vendorSessionId` (from its
 * winning `cleanup` event, when identified) is matched against each
 * candidate file's own `extractSessionId()` -- the SAME value a project
 * JSONL file's own records carry throughout (stable per file, matches
 * the file's basename). Exactly one candidate file matching resolves the
 * issue to that file deterministically, no timestamp heuristic involved;
 * the others are silently NOT harvested (they belong to a different,
 * concurrent attempt for the same issue number). Zero or more than one
 * match -- including every case where the window carries no identity at
 * all, i.e. every issue whose loop predates this field -- falls back to
 * the #2425 classify-and-skip behavior unchanged.
 */
export function scanClaudeVendorSessions(
  projectDir: string,
  eventWindowsAll: ReadonlyMap<string, StageEventWindow> = new Map(),
): VendorSession[] {
  const out: VendorSession[] = [];
  if (!existsSync(projectDir)) {
    // Unlike Codex/Grok's session directories, this one is cwd-encoded
    // (#2439): a missing directory here usually means the CLI was
    // invoked from an issue worktree rather than the primary worktree
    // Claude Code actually launched the session from, not a genuine
    // "no sessions yet" case -- silently returning [] made that gap
    // indistinguishable from a real empty result (#2426).
    process.stderr.write(
      `token-cost-harvest: Claude project directory ${projectDir} does not exist -- this CLI's Claude scan is cwd-sensitive; re-run from the workstation's primary worktree (the cwd Claude Code sessions actually launch from), not an issue-specific worktree.\n`,
    );
    return out;
  }
  const completedIssueWindows = buildCompletedIssueWindows(
    eventWindowsAll,
    'claude',
  );
  const files = globSync('*.jsonl', { cwd: projectDir, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  // Event windows carry no file/session identity (issueNumber + vendor
  // only), so a candidate is collected per FILE here and only actually
  // harvested after every file has been scanned -- see the cross-file
  // ambiguity guard below.
  const eventWindowCandidates: {
    fileBasename: string;
    issueNumber: number;
    records: unknown[];
  }[] = [];
  // #2432: every file's own FULL record set (regardless of whether any
  // segment resolved a cwd issue number), cached for a later
  // contributingWindows lookup -- a genuine handoff session is very often
  // launched right inside the issue worktree it is resuming, so its own
  // records typically already carry a cwd-attributed segment for the
  // exact issue being merged. Restricting this pool to unattributed-only
  // records (the pre-#2432 #2418 scoping) would make such a session
  // permanently unresolvable as a contributor (Codex review finding, PR
  // #2627); which of its records actually belong to the merge is instead
  // decided by the contributing window's own timestamp bounds below, not
  // by which segment they happened to land in.
  const allRecordsByBasename = new Map<string, unknown[]>();
  // Every issue number any segment of a file resolved via cwd inference
  // (almost always zero or one entry; #2404 segmentation can add more for
  // a session that moved across several worktrees in one file). A file
  // that cwd-resolved to some OTHER issue is never eligible as a
  // contributor for a DIFFERENT target issue -- matching its own sessionId
  // is not enough on its own, or a session that briefly touched an
  // unrelated issue's worktree could have that unrelated activity folded
  // into this merge (Codex review finding, PR #2627 -- distinct from the
  // same-issue suppression case above, which this does not affect).
  const cwdIssueNumbersByBasename = new Map<string, Set<number>>();
  // Per-file `resolveCandidateSessionId` result, computed once per file
  // instead of once per (contributor x file) comparison (Copilot review,
  // PR #2627) -- `extractSessionId` can scan the whole records array.
  const sessionIdByBasename = new Map<string, string | undefined>();
  const resolveCandidateSessionId = (
    fileBasename: string,
  ): string | undefined => {
    if (sessionIdByBasename.has(fileBasename)) {
      return sessionIdByBasename.get(fileBasename);
    }
    const resolved =
      extractSessionId(allRecordsByBasename.get(fileBasename) ?? []) ??
      deriveFallbackSessionId(fileBasename);
    sessionIdByBasename.set(fileBasename, resolved);
    return resolved;
  };
  // #2432: a file's own cwd-derived issue-loop sample(s) whose issue
  // number turns out to match a confirmed merge target are suppressed
  // (not pushed to `out`) once that file is resolved as a contributor for
  // that SAME issue number, so its usage is counted exactly once -- via
  // the merged `#ew<issueNumber>` sample -- instead of also standing on
  // its own. A cwd-derived sample for any OTHER issue number is never
  // touched. Pushing is therefore deferred until every contributor
  // resolution below has run.
  const pendingCwdSessions: {
    fileBasename: string;
    issueNumber: number;
    session: VendorSession;
  }[] = [];
  const consumedCwdIssueNumbersByBasename = new Map<string, Set<number>>();
  for (const file of files) {
    let records: unknown[];
    try {
      records = parseClaudeProjectLines(readFileSync(file, 'utf8'));
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping ${file}: ${(error as Error).message}\n`,
      );
      continue;
    }
    const fileBasename = basename(file);
    allRecordsByBasename.set(fileBasename, records);
    const segments = segmentRecordsByCwd(records);
    const unattributedRecords: unknown[] = [];
    let anySegmentHadCwdIssueNumber = false;
    segments.forEach((segment, index) => {
      let adapterResult: TokenCostAdapterResult;
      try {
        adapterResult = claudeAdapter.harvest({
          records: segment.records,
          fileBasename,
          // Suffix only when the file actually produced more than one
          // segment, so a single-cwd file (the common case) keeps its
          // pre-existing vendorSessionId (no suffix) and stays deduplicated
          // against samples already harvested before this change.
          segmentIndex: segments.length > 1 ? index : undefined,
        } satisfies ClaudeHarvestInput);
      } catch (error) {
        process.stderr.write(
          `token-cost-harvest: skipping ${file} segment ${index}: ${(error as Error).message}\n`,
        );
        return;
      }
      const session: VendorSession = {
        vendor: 'claude',
        adapterResult,
        timeline: extractClaudeUsageTimeline(segment.records),
      };
      const cwdIssueNumber = adapterResult.joinHints?.issueNumber;
      if (cwdIssueNumber === undefined) {
        out.push(session);
        unattributedRecords.push(...segment.records);
      } else {
        anySegmentHadCwdIssueNumber = true;
        const cwdIssues =
          cwdIssueNumbersByBasename.get(fileBasename) ?? new Set<number>();
        cwdIssues.add(cwdIssueNumber);
        cwdIssueNumbersByBasename.set(fileBasename, cwdIssues);
        // #2432: deferred, not pushed yet -- see `pendingCwdSessions`
        // above. Suppressed later only if this exact (file, issue number)
        // pair is confirmed as a merge contributor.
        pendingCwdSessions.push({
          fileBasename,
          issueNumber: cwdIssueNumber,
          session,
        });
      }
    });

    // Only fall back to event-window attribution (for PRIMARY/cleanup-file
    // selection) when NO segment in this file resolved a cwd-inferred
    // issue number. Otherwise a segment whose cwd merely isn't
    // issue-shaped (an ordinary subdirectory, not a worktree move) but
    // whose records still happen to fall inside a DIFFERENT segment's
    // already cwd-attributed issue window would produce a second,
    // independent issue-loop sample for that same issue -- splitting one
    // completed loop's usage across two samples that markAmbiguousOverlaps
    // has no reason to catch (their time ranges don't overlap; they're
    // just both attributed to the same issue). This restriction applies
    // only to PRIMARY selection: a file excluded here can still be found
    // as a claim-id-matched CONTRIBUTOR via `allRecordsByBasename` above,
    // which is never restricted this way (Codex review finding, PR
    // #2627).
    if (!anySegmentHadCwdIssueNumber && unattributedRecords.length > 0) {
      if (completedIssueWindows.length > 0) {
        const eventWindowGroups = segmentRecordsByEventWindow(
          unattributedRecords,
          completedIssueWindows,
          extractRecordTimestampMs,
        );
        for (const [issueNumber, groupRecords] of eventWindowGroups) {
          eventWindowCandidates.push({
            fileBasename,
            issueNumber,
            records: groupRecords,
          });
        }
      }
    }
  }

  // A record with no valid timestamp sorts last via MAX_SAFE_INTEGER --
  // Number.POSITIVE_INFINITY would subtract to NaN when two such records
  // are compared, which Array.prototype.sort tolerates (undefined order)
  // but is needlessly fragile.
  const sortByTimestampAscending = (records: unknown[]): unknown[] =>
    [...records].sort(
      (a, b) =>
        (extractRecordTimestampMs(a) ?? Number.MAX_SAFE_INTEGER) -
        (extractRecordTimestampMs(b) ?? Number.MAX_SAFE_INTEGER),
    );

  // #2432: pull each confirmed contributing session's own file's records
  // (restricted to that session's own qualifying window bounds) into the
  // primary file's own records, one merged harvest() call per issue. A
  // contribution whose own file can't be uniquely resolved skips the
  // WHOLE issue rather than emitting a primary-only sample under the
  // stable `#ew<issueNumber>` id: the CLI's append-side `vendorSessionKey`
  // dedup treats that key as already-present on every later run, which
  // would otherwise permanently freeze exactly the undercount this
  // feature exists to fix, once the missing contributor becomes available
  // (Codex review finding, PR #2627).
  const harvestEventWindowCandidate = (
    issueNumber: number,
    fileBasename: string,
    records: unknown[],
  ): void => {
    const vendorSessionIdOverride = resolveCandidateSessionId(fileBasename);
    const contributingWindows =
      completedIssueWindowByIssue.get(issueNumber)?.contributingWindows ?? [];
    // #2432/Codex review (PR #2627): the primary candidate's own `records`
    // were selected against the OVERALL (already-widened) issue window,
    // so they can include this same file's unrelated activity that
    // happens to fall inside a time range a confirmed contributor already
    // owns. Drop those before merging in the contributors' own records,
    // so that time is charged exactly once.
    const isOwnedByAContributor = (atMs: number | undefined): boolean =>
      atMs !== undefined &&
      contributingWindows.some(
        (contributing) =>
          atMs >= contributing.startMs && atMs < contributing.endMs,
      );
    const mergedRecords = records.filter(
      (record) => !isOwnedByAContributor(extractRecordTimestampMs(record)),
    );
    // A candidate file cwd-attributed to some OTHER issue number is never
    // eligible to lend its records to THIS merge -- a file cwd-attributed
    // only to THIS same issue (the #2432 same-worktree-handoff case) or to
    // no issue at all (the pre-#2432 unattributed case) is eligible on a
    // sessionId match; one cwd-attributed to a different issue is not,
    // even on a sessionId match (Codex review finding, PR #2627). Unlike a
    // truly unresolvable contributor below, this is a PERMANENT, structural
    // disqualification, not a transient gap a later harvest could fix --
    // so it drops just this one contributor and proceeds, rather than
    // skipping the whole issue.
    const isEligibleContributorFile = (candidateBasename: string): boolean => {
      const cwdIssues = cwdIssueNumbersByBasename.get(candidateBasename);
      return (
        cwdIssues === undefined ||
        [...cwdIssues].every((cwdIssue) => cwdIssue === issueNumber)
      );
    };
    for (const contributing of contributingWindows) {
      const sessionIdMatches = [...allRecordsByBasename].filter(
        ([candidateBasename]) =>
          resolveCandidateSessionId(candidateBasename) ===
          contributing.vendorSessionId,
      );
      if (sessionIdMatches.length !== 1) {
        process.stderr.write(
          `token-cost-harvest: skipping issue #${issueNumber} entirely: contributing session ${contributing.vendorSessionId} ${
            sessionIdMatches.length === 0
              ? 'has no matching file'
              : `matched more than one file (${sessionIdMatches.map(([b]) => b).join(', ')})`
          } -- emitting a primary-only sample would freeze an undercount under a stable id\n`,
        );
        return;
      }
      const [contributingBasename, candidateRecords] = sessionIdMatches[0];
      if (!isEligibleContributorFile(contributingBasename)) {
        process.stderr.write(
          `token-cost-harvest: dropping contributing session ${contributing.vendorSessionId} for issue #${issueNumber}: its file (${contributingBasename}) is cwd-attributed to a different issue -- proceeding without this contributor\n`,
        );
        continue;
      }
      let contributorHadRecords = false;
      for (const record of candidateRecords) {
        const atMs = extractRecordTimestampMs(record);
        if (
          atMs !== undefined &&
          atMs >= contributing.startMs &&
          atMs < contributing.endMs
        ) {
          mergedRecords.push(record);
          contributorHadRecords = true;
        }
      }
      if (contributorHadRecords) {
        const consumed =
          consumedCwdIssueNumbersByBasename.get(contributingBasename) ??
          new Set<number>();
        consumed.add(issueNumber);
        consumedCwdIssueNumbersByBasename.set(contributingBasename, consumed);
      }
    }
    try {
      const eventWindowResult = claudeAdapter.harvest({
        records: sortByTimestampAscending(mergedRecords),
        fileBasename,
        issueNumberOverride: issueNumber,
        vendorSessionIdOverride,
      } satisfies ClaudeHarvestInput);
      out.push({
        vendor: 'claude',
        adapterResult: eventWindowResult,
        timeline: extractClaudeUsageTimeline(mergedRecords),
      });
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping event-window issue #${issueNumber}: ${(error as Error).message}\n`,
      );
    }
  };

  // Cross-file resolution: event windows carry no session/file identity,
  // so more than one project log file can independently match the same
  // issue. Two distinct producers of that shape need different handling
  // -- see the #2425 rationale on this function's own docstring above.
  const candidatesByIssue = new Map<
    number,
    { fileBasename: string; records: unknown[] }[]
  >();
  for (const candidate of eventWindowCandidates) {
    const list = candidatesByIssue.get(candidate.issueNumber) ?? [];
    list.push({
      fileBasename: candidate.fileBasename,
      records: candidate.records,
    });
    candidatesByIssue.set(candidate.issueNumber, list);
  }
  const completedIssueWindowByIssue = new Map<number, CompletedIssueWindow>();
  for (const window of completedIssueWindows) {
    if (!completedIssueWindowByIssue.has(window.issueNumber)) {
      completedIssueWindowByIssue.set(window.issueNumber, window);
    }
  }
  for (const [issueNumber, fileCandidates] of candidatesByIssue) {
    // #2424: resolve by attempt identity before falling back to
    // classify-and-skip (or, for a single candidate, unconditional
    // harvest). This also gates the length-1 case: a sole candidate is
    // NOT automatically the right one when the window has an identity a
    // file provably fails to match -- e.g. this loop's own event window
    // whose own session file got excluded upstream (a cwd-inferred
    // segment already claimed it), leaving only an unrelated concurrent
    // session's file as candidate.
    const windowVendorSessionId =
      completedIssueWindowByIssue.get(issueNumber)?.vendorSessionId;
    if (windowVendorSessionId !== undefined) {
      const matching = fileCandidates.filter(
        (candidate) =>
          resolveCandidateSessionId(candidate.fileBasename) ===
          windowVendorSessionId,
      );
      if (matching.length === 1) {
        harvestEventWindowCandidate(
          issueNumber,
          matching[0].fileBasename,
          matching[0].records,
        );
        continue;
      }
      if (fileCandidates.length === 1) {
        process.stderr.write(
          `token-cost-harvest: skipping event-window issue #${issueNumber}: the sole candidate file's sessionId does not match the window's vendorSessionId (${fileCandidates[0].fileBasename})\n`,
        );
        continue;
      }
    } else if (fileCandidates.length === 1) {
      harvestEventWindowCandidate(
        issueNumber,
        fileCandidates[0].fileBasename,
        fileCandidates[0].records,
      );
      continue;
    }
    const ranges = fileCandidates.map((candidate) =>
      computeRecordTimeRange(candidate.records, extractRecordTimestampMs),
    );
    const fileNames = fileCandidates.map((candidate) => candidate.fileBasename);
    const anyOverlap = ranges.some((a, i) =>
      ranges.some(
        (b, j) =>
          i < j && a !== undefined && b !== undefined && rangesOverlap(a, b),
      ),
    );
    // Classify-only: both shapes still skip (see the #2425 rationale on
    // this function's own docstring above for why a disjoint-range merge
    // was investigated and rejected). The distinction is diagnostic only
    // -- it tells a maintainer reading stderr which residual gap this
    // instance is, without changing behavior for either.
    const classification = anyOverlap
      ? 'overlapping activity ranges'
      : 'disjoint activity ranges -- resolvable once events carry session identity, #2424';
    process.stderr.write(
      `token-cost-harvest: skipping event-window issue #${issueNumber}: matched by more than one project log file (${classification}: ${fileNames.join(', ')})\n`,
    );
  }
  // #2432: emit each file's own cwd-derived issue-loop sample now that
  // every contributor resolution above is final, suppressing only the
  // exact (file, issue number) pairs confirmed as merged into a
  // contributor above -- any other cwd-derived sample from the same file
  // (a different issue number it also touched) is unaffected.
  for (const pending of pendingCwdSessions) {
    if (
      consumedCwdIssueNumbersByBasename
        .get(pending.fileBasename)
        ?.has(pending.issueNumber)
    ) {
      continue;
    }
    out.push(pending.session);
  }
  return out;
}

function scanCodexVendorSessions(sessionsDir: string): VendorSession[] {
  const out: VendorSession[] = [];
  if (!existsSync(sessionsDir)) {
    return out;
  }
  const files = globSync('**/rollout-*.jsonl', {
    cwd: sessionsDir,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    try {
      const records = parseCodexRolloutLines(readFileSync(file, 'utf8'));
      if (!isIddSkillCwd(extractSessionCwd(records))) {
        continue;
      }
      const adapterResult = codexAdapter.harvest({
        records,
        fileBasename: basename(file),
      } satisfies CodexHarvestInput);
      out.push({
        vendor: 'codex',
        adapterResult,
        timeline: extractCodexUsageTimeline(records),
      });
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping ${file}: ${(error as Error).message}\n`,
      );
    }
  }
  return out;
}

/**
 * Grok sessions are joined and classified the same as claude/codex, but
 * without per-stage usage splitting yet: `scanGrokSessions` already owns
 * a materially more complex read (subagent updates.jsonl rollups,
 * signals.json, events.jsonl fallback -- see token-cost-adapter-grok.mts's
 * module doc), so replicating "read once, feed the same records to a
 * local timeline extractor" here would mean re-deriving that whole read,
 * not just one small per-record usage-field mapping the way the
 * claude/codex extractors do. An empty timeline means allocateStageUsage
 * omits every stage for a grok issue-loop sample (the session's own
 * aggregate `usage` total is still present and correct); a follow-up
 * issue can add extractGrokUsageTimeline once that read is worth sharing.
 */
function scanGrokVendorSessions(sessionsDir: string): VendorSession[] {
  return scanGrokSessions({ sessionsDir }).map((adapterResult) => ({
    vendor: 'grok' as const,
    adapterResult,
    timeline: { mode: 'delta' as const, points: [] },
  }));
}

// ---------------------------------------------------------------------------
// Sample assembly
// ---------------------------------------------------------------------------

export function buildSample(
  session: VendorSession,
  owner: string,
  repo: string,
  eventWindowsAll: ReadonlyMap<string, StageEventWindow>,
  trustedLogins: readonly string[],
): HarvestedSample {
  const base = session.adapterResult.sample;
  const validStartedAtMs = toValidTimestampMs(base.startedAt);
  const validEndedAtMs = toValidTimestampMs(base.endedAt);
  const startedAtMs = validStartedAtMs ?? 0;
  const endedAtMs = validEndedAtMs ?? startedAtMs;
  const issueNumber = session.adapterResult.joinHints?.issueNumber;

  if (
    issueNumber === undefined ||
    validStartedAtMs === undefined ||
    validEndedAtMs === undefined
  ) {
    // An adapter's own timestamp fields are malformed, or there is no
    // issue to join against: skip the GitHub join rather than resolving
    // a context against a nonsensical (e.g. epoch-anchored) session
    // window. assertTokenCostSample would reject a malformed startedAt
    // downstream anyway; this just avoids the wasted join work first.
    return { sample: base, issueNumber, startedAtMs, endedAtMs };
  }

  const ctx = resolveIssueLoopContext(
    owner,
    repo,
    issueNumber,
    startedAtMs,
    endedAtMs,
    trustedLogins,
  );
  if (ctx === null) {
    return { sample: base, issueNumber, startedAtMs, endedAtMs };
  }

  const eventWindows = eventWindowsForIssue(
    eventWindowsAll,
    issueNumber,
    session.vendor,
  );
  const { windows, attribution } = computeStageWindows(
    startedAtMs,
    endedAtMs,
    ctx,
    eventWindows,
  );
  const stages = allocateStageUsage(windows, session.timeline);

  const sample: TokenCostIssueLoopSample = {
    ...(base as TokenCostSessionSample),
    kind: 'issue-loop',
    issueNumber,
    stages,
    attribution: attribution as TokenCostAttribution,
    outcome: deriveOutcome(ctx),
  };
  const redacted = redactTokenCostRecord(sample) as TokenCostIssueLoopSample;
  return { sample: redacted, issueNumber, startedAtMs, endedAtMs };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function defaultStateDir(): string {
  const base =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'idd-skill', 'token-cost');
}

// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header for the full invariant.
const TOKEN_COST_HARVEST_FLAG_SPEC = {
  '--repo': { type: 'string', default: '' },
  '--owner': { type: 'string', default: '' },
  '--out': { type: 'string', default: '' },
  '--events': { type: 'string', default: '' },
  '--dry-run': { type: 'boolean', default: false },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/token-cost-harvest.mjs --repo <owner>/<repo> [--out <path>] [--events <path>] [--dry-run]
  node scripts/token-cost-harvest.mjs --owner <owner> --repo <repo> [--out <path>] [--events <path>] [--dry-run]

  --repo <owner>/<repo>         Repository to join harvested sessions against.
                                Required: either the combined <owner>/<repo>
                                form alone, or the bare <repo> name paired
                                with --owner.
  --owner <owner>               Repository owner, split form (pair with
                                --repo <repo>, the bare repository name --
                                not both --owner and a combined --repo
                                together).
  --out <path>                 Output samples JSONL path (default:
                                ${defaultStateDir()}/samples.jsonl).
  --events <path>               Phase-event JSONL path (default:
                                ${defaultStateDir()}/events.jsonl). Missing file is not an error.
  --dry-run                    Print counts to stderr; write nothing.
  --trusted-marker-logins a,b   Logins whose IDD markers are trusted (default: .github/idd/config.json's trustedMarkerActors).
  --help, -h                   Show this help.
`);
}

export function vendorSessionKey(sample: {
  vendor: string;
  vendorSessionId: string;
}): string {
  return `${sample.vendor}:${sample.vendorSessionId}`;
}

/**
 * Every run rescans every vendor's full session history (there is no
 * incremental cursor), so appending unconditionally would duplicate a
 * session's sample on every subsequent run. Reads the current output file's
 * existing (vendor, vendorSessionId) keys so the caller can skip samples
 * already recorded, keeping the documented append semantics idempotent. A
 * malformed existing line is skipped rather than failing the whole read --
 * this is a read-side safety net, not a place to validate the file.
 */
export function readExistingVendorSessionKeys(outPath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(outPath)) {
    return keys;
  }
  const lines = readFileSync(outPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        vendor?: unknown;
        vendorSessionId?: unknown;
      };
      if (
        typeof parsed.vendor === 'string' &&
        typeof parsed.vendorSessionId === 'string'
      ) {
        keys.add(
          vendorSessionKey({
            vendor: parsed.vendor,
            vendorSessionId: parsed.vendorSessionId,
          }),
        );
      }
    } catch {
      // Malformed line in an existing file: skip it, don't fail the harvest.
    }
  }
  return keys;
}

/** Validates and splits a --repo <owner>/<repo> flag value; null for anything but exactly two non-empty segments. */
export function parseRepoFlag(
  repoFlag: string,
): { owner: string; repo: string } | null {
  const parts = repoFlag
    .trim()
    .split('/')
    .map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    return null;
  }
  const [owner, repo] = parts;
  return { owner, repo };
}

function runCli(argv: string[]): void {
  const { values, help } = parseCliArgs(argv, TOKEN_COST_HARVEST_FLAG_SPEC);
  if (help) {
    printHelp();
    return;
  }
  let repoFlag: string;
  try {
    repoFlag =
      combineOwnerRepoFlags({
        owner: values.owner as string,
        repo: values.repo as string,
      }) ?? '';
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const parsedRepo = parseRepoFlag(repoFlag);
  if (!parsedRepo) {
    process.stderr.write(
      repoFlag.trim() === ''
        ? '--repo <owner>/<repo> is required\n'
        : `--repo must be in <owner>/<repo> form, got: ${repoFlag}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { owner, repo } = parsedRepo;
  const dryRun = values['dry-run'] as boolean;
  const outPath =
    (values.out as string) || join(defaultStateDir(), 'samples.jsonl');
  const eventsPath =
    (values.events as string) || join(defaultStateDir(), 'events.jsonl');
  const trustedLogins = resolveTrustedMarkerLogins(
    values['trusted-marker-logins'] as string,
  );

  const eventWindows = readEventWindows(eventsPath);

  const sessions: VendorSession[] = [
    ...scanClaudeVendorSessions(defaultClaudeProjectDir(), eventWindows),
    ...scanCodexVendorSessions(defaultCodexSessionsDir()),
    ...scanGrokVendorSessions(defaultGrokSessionsDir()),
  ];

  const harvested: HarvestedSample[] = [];
  for (const session of sessions) {
    try {
      const built = buildSample(
        session,
        owner,
        repo,
        eventWindows,
        trustedLogins,
      );
      assertTokenCostSample(built.sample);
      harvested.push(built);
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping ${session.vendor} session: ${(error as Error).message}\n`,
      );
    }
  }

  markAmbiguousOverlaps(harvested);

  const issueLoopCount = harvested.filter(
    (h) => h.sample.kind === 'issue-loop',
  ).length;
  process.stderr.write(
    `token-cost-harvest: ${harvested.length} sample(s) (${issueLoopCount} issue-loop, ${
      harvested.length - issueLoopCount
    } session)\n`,
  );

  if (dryRun) {
    return;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  const existingIds = readExistingVendorSessionKeys(outPath);
  const newSamples = harvested.filter(
    (h) => !existingIds.has(vendorSessionKey(h.sample)),
  );
  if (newSamples.length > 0) {
    const body = newSamples.map((h) => JSON.stringify(h.sample)).join('\n');
    appendFileSync(outPath, `${body}\n`);
  }
  process.stdout.write(
    `token-cost-harvest: appended ${newSamples.length} new sample(s) to ${outPath} (skipped ${
      harvested.length - newSamples.length
    } already present)\n`,
  );
}

if (import.meta.main) {
  runCli(process.argv.slice(2));
}
