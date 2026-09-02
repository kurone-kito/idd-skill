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
import { parseCliArgs } from './cli-args.mjs';
import { ghGraphql } from './gh-exec.mjs';
import {
  parseClaimComment,
  parseForcedHandoffComment,
  parseReleaseComment,
  parseReviewWatermarkComment,
} from './marker-helpers.mjs';
import {
  claudeAdapter,
  defaultClaudeProjectDir,
  extractRecordTimestampMs,
  parseClaudeProjectLines,
  segmentRecordsByCwd,
} from './token-cost-adapter-claude.mjs';
import {
  codexAdapter,
  defaultCodexSessionsDir,
  extractSessionCwd,
  isIddSkillCwd,
  parseCodexRolloutLines,
} from './token-cost-adapter-codex.mjs';
import {
  defaultGrokSessionsDir,
  scanGrokSessions,
} from './token-cost-adapter-grok.mjs';
import {
  assertTokenCostSample,
  redactTokenCostRecord,
  TOKEN_COST_STAGE_IDS,
} from './token-cost-core.mjs';

// ---------------------------------------------------------------------------
// Shared usage arithmetic
// ---------------------------------------------------------------------------
const ZERO_USAGE = {
  inputUncached: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  reasoning: 0,
};
function addUsage(a, b) {
  return {
    inputUncached: a.inputUncached + b.inputUncached,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}
function subtractUsageClamped(a, b) {
  const clamp = (x, y) => Math.max(0, x - y);
  return {
    inputUncached: clamp(a.inputUncached, b.inputUncached),
    cacheRead: clamp(a.cacheRead, b.cacheRead),
    cacheCreation: clamp(a.cacheCreation, b.cacheCreation),
    output: clamp(a.output, b.output),
    reasoning: clamp(a.reasoning, b.reasoning),
  };
}
function usageTotal(u) {
  return (
    u.inputUncached + u.cacheRead + u.cacheCreation + u.output + u.reasoning
  );
}
function toNonNegativeInt(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function toValidTimestampMs(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
/** Mirrors token-cost-adapter-claude.mts's usageFromFields (per-message delta). */
function claudeUsageFromFields(raw) {
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
export function extractClaudeUsageTimeline(records) {
  const points = [];
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
function codexUsageFromTokenCounts(raw) {
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
export function extractCodexUsageTimeline(records) {
  const tokenCountRecords = [];
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
    const points = [];
    for (const { atMs, payload } of tokenCountRecords) {
      const total = payload.total_token_usage;
      if (isPlainObject(total)) {
        points.push({ atMs, usage: codexUsageFromTokenCounts(total) });
      }
    }
    return { mode: 'cumulative', points };
  }
  const points = [];
  for (const { atMs, payload } of tokenCountRecords) {
    const last = payload.last_token_usage;
    if (isPlainObject(last)) {
      points.push({ atMs, usage: codexUsageFromTokenCounts(last) });
    }
  }
  return { mode: 'delta', points };
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
  sessionStartedAtMs,
  sessionEndedAtMs,
  ctx,
  eventWindows,
) {
  const windows = [];
  const push = (id, startMs, endMs) => {
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
  let attribution = 'marker-join';
  const byId = new Map(windows.map((w) => [w.id, w]));
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
  const finalWindows = [];
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
function sumDeltaInRange(points, startMs, endMs) {
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
function cumulativeSnapshotAt(points, atMs, exclusive = false) {
  let result = null;
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
export function allocateStageUsage(windows, timeline) {
  const out = [];
  let previousEndMs = null;
  let previousEndSnapshot = ZERO_USAGE;
  for (const window of windows) {
    let usage;
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
export function deriveOutcome(ctx) {
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
/**
 * Two harvested issue-loop samples on the same issue with overlapping
 * [startedAt, endedAt) ranges mean two concurrent sessions genuinely
 * worked the same issue -- neither's usage can be cleanly attributed, so
 * both are marked ambiguous/unknown rather than either being trusted.
 */
export function markAmbiguousOverlaps(samples) {
  const byIssue = new Map();
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
          const sampleA = a.sample;
          const sampleB = b.sample;
          sampleA.ambiguous = true;
          sampleB.ambiguous = true;
          sampleA.outcome = 'unknown';
          sampleB.outcome = 'unknown';
        }
      }
    }
  }
}
// GitHub logins are case-insensitive for account identity; compare
// case-insensitively so a --trusted-marker-logins/config entry typed with
// different casing than the GraphQL-reported author.login still matches,
// rather than silently treating every marker as untrusted.
function isTrusted(login, trustedLogins) {
  const normalized = login.toLowerCase();
  return trustedLogins.some((trusted) => trusted.toLowerCase() === normalized);
}
/** flag > config.json trustedMarkerActors > empty (fail closed: nothing is trusted). */
export function resolveTrustedMarkerLogins(flagValue) {
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
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.trustedMarkerActors)) {
      return parsed.trustedMarkerActors.filter((v) => typeof v === 'string');
    }
  } catch {}
  return [];
}
const ISSUE_LOOP_CONTEXT_QUERY = `
query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    issue(number:$number){
      comments(first:100){nodes{body createdAt author{login}}}
      timelineItems(last:100,itemTypes:[CONNECTED_EVENT,DISCONNECTED_EVENT]){
        nodes{
          __typename
          ... on ConnectedEvent{subject{__typename ... on PullRequest{
            number state headRefName createdAt mergedAt
            reviews(first:1){nodes{submittedAt}}
          }}}
          ... on DisconnectedEvent{subject{__typename ... on PullRequest{number}}}
        }
      }
    }
  }
}`;
/** Fetches issue comments plus the earliest live-connected same-branch PR (with its first review + merge timestamp) via one batched GraphQL query. */
export function fetchIssueLoopGithubContext(
  owner,
  repo,
  issueNumber,
  trustedLogins,
) {
  const response = ghGraphql(ISSUE_LOOP_CONTEXT_QUERY, {
    owner,
    repo,
    number: issueNumber,
  });
  const issue = response.data?.repository?.issue;
  const commentNodes = Array.isArray(issue?.comments?.nodes)
    ? issue.comments.nodes
    : [];
  const comments = [];
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
  const timelineNodes = Array.isArray(issue?.timelineItems?.nodes)
    ? issue.timelineItems.nodes
    : [];
  const connected = new Map();
  const disconnected = new Set();
  for (const node of timelineNodes) {
    if (!isPlainObject(node)) {
      continue;
    }
    const subject = isPlainObject(node.subject) ? node.subject : undefined;
    const prNumber =
      subject && typeof subject.number === 'number'
        ? subject.number
        : undefined;
    if (prNumber === undefined) {
      continue;
    }
    if (node.__typename === 'ConnectedEvent') {
      connected.set(prNumber, subject);
      disconnected.delete(prNumber);
    } else if (node.__typename === 'DisconnectedEvent') {
      disconnected.add(prNumber);
    }
  }
  let chosen = null;
  let chosenNumber = null;
  for (const [prNumber, subject] of connected) {
    if (disconnected.has(prNumber)) {
      continue;
    }
    const headRefName =
      typeof subject.headRefName === 'string' ? subject.headRefName : '';
    if (!headRefName.startsWith(`issue/${issueNumber}-`)) {
      continue;
    }
    const createdAtMs = toValidTimestampMs(subject.createdAt);
    if (createdAtMs === undefined) {
      continue;
    }
    const chosenCreatedAtMs = chosen
      ? (toValidTimestampMs(chosen.createdAt) ?? Infinity)
      : Infinity;
    if (createdAtMs < chosenCreatedAtMs) {
      chosen = subject;
      chosenNumber = prNumber;
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
  let firstReviewAtMs = null;
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
  owner,
  repo,
  issueNumber,
  sessionStartedAtMs,
  sessionEndedAtMs,
  trustedLogins,
) {
  const github = fetchIssueLoopGithubContext(
    owner,
    repo,
    issueNumber,
    trustedLogins,
  );
  let claimedAtMs = null;
  let claimAgentId = null;
  let claimId = null;
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
  let firstWatermarkAtMs = null;
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
    .filter((v) => v !== null)
    .reduce((min, v) => (min === null || v < min ? v : min), null);
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
const TOKEN_COST_VENDORS = ['grok', 'claude', 'codex'];
function isTokenCostVendor(value) {
  return typeof value === 'string' && TOKEN_COST_VENDORS.includes(value);
}
// Keyed by vendor too, not just (issueNumber, stageId): two different vendor
// sessions can both log phase events for the same issue and stage (a
// claude->codex handoff mid-loop), and their enter/exit timestamps must not
// be paired across vendors into one bogus window.
function eventKey(issueNumber, vendor, stageId) {
  return `${issueNumber}:${vendor}:${stageId}`;
}
/** Reads a --events JSONL file into per-(issueNumber, vendor, stageId) enter/exit window overrides. A missing file is not an error -- returns an empty map. */
export function readEventWindows(path) {
  const result = new Map();
  if (!existsSync(path)) {
    return result;
  }
  const enterAt = new Map();
  const exitAt = new Map();
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) {
      continue;
    }
    const event = parsed;
    if (
      typeof event.issueNumber !== 'number' ||
      typeof event.stageId !== 'string' ||
      !TOKEN_COST_STAGE_IDS.includes(event.stageId) ||
      !isTokenCostVendor(event.vendor) ||
      (event.event !== 'enter' && event.event !== 'exit')
    ) {
      continue;
    }
    const atMs = toValidTimestampMs(event.at);
    if (atMs === undefined) {
      continue;
    }
    const key = eventKey(event.issueNumber, event.vendor, event.stageId);
    if (event.event === 'enter') {
      enterAt.set(key, atMs);
    } else {
      exitAt.set(key, atMs);
    }
  }
  for (const [key, start] of enterAt) {
    const end = exitAt.get(key);
    if (end !== undefined) {
      result.set(key, { startMs: start, endMs: end });
    }
  }
  return result;
}
function eventWindowsForIssue(all, issueNumber, vendor) {
  const out = new Map();
  for (const stageId of TOKEN_COST_STAGE_IDS) {
    const window = all.get(eventKey(issueNumber, vendor, stageId));
    if (window) {
      out.set(stageId, window);
    }
  }
  return out;
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
 * `startMs < endMs` guards against `readEventWindows`'s own pairing: it
 * pairs the LATEST `--enter` seen for a (issue, vendor, stage) key with
 * the LATEST `--exit`, across the whole append-only file, with no
 * knowledge of which attempt either belongs to. A completed run followed
 * by a re-attempt that enters `cleanup` again but never exits pairs that
 * new, still-open enter with the FIRST attempt's stale exit, producing a
 * reversed window (`startMs > endMs`) -- without this guard, its mere
 * presence would still count as "closed" and the new, unfinished
 * attempt's partial usage would be harvested and permanently frozen
 * under the stable `#ew<issueNumber>` id.
 */
export function buildCompletedIssueWindows(eventWindowsAll, vendor) {
  const byIssue = new Map();
  for (const [key, window] of eventWindowsAll) {
    const [issueNumberRaw, keyVendor, stageId] = key.split(':');
    if (keyVendor !== vendor) {
      continue;
    }
    const issueNumber = Number(issueNumberRaw);
    if (!Number.isInteger(issueNumber)) {
      continue;
    }
    const existing = byIssue.get(issueNumber);
    byIssue.set(issueNumber, {
      startMs: existing
        ? Math.min(existing.startMs, window.startMs)
        : window.startMs,
      endMs: existing ? Math.max(existing.endMs, window.endMs) : window.endMs,
      hasClosedCleanup:
        (existing?.hasClosedCleanup ?? false) ||
        (stageId === 'cleanup' && window.startMs < window.endMs),
    });
  }
  const out = [];
  for (const [issueNumber, entry] of byIssue) {
    if (entry.hasClosedCleanup) {
      out.push({
        issueNumber,
        startMs: entry.startMs,
        endMs: entry.endMs,
      });
    }
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
  records,
  issueWindows,
  getTimestampMs,
) {
  const groups = new Map();
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
 */
export function scanClaudeVendorSessions(
  projectDir,
  eventWindowsAll = new Map(),
) {
  const out = [];
  if (!existsSync(projectDir)) {
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
  const eventWindowCandidates = [];
  for (const file of files) {
    let records;
    try {
      records = parseClaudeProjectLines(readFileSync(file, 'utf8'));
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping ${file}: ${error.message}\n`,
      );
      continue;
    }
    const fileBasename = basename(file);
    const segments = segmentRecordsByCwd(records);
    const unattributedRecords = [];
    segments.forEach((segment, index) => {
      let adapterResult;
      try {
        adapterResult = claudeAdapter.harvest({
          records: segment.records,
          fileBasename,
          // Suffix only when the file actually produced more than one
          // segment, so a single-cwd file (the common case) keeps its
          // pre-existing vendorSessionId (no suffix) and stays deduplicated
          // against samples already harvested before this change.
          segmentIndex: segments.length > 1 ? index : undefined,
        });
      } catch (error) {
        process.stderr.write(
          `token-cost-harvest: skipping ${file} segment ${index}: ${error.message}\n`,
        );
        return;
      }
      out.push({
        vendor: 'claude',
        adapterResult,
        timeline: extractClaudeUsageTimeline(segment.records),
      });
      if (adapterResult.joinHints?.issueNumber === undefined) {
        unattributedRecords.push(...segment.records);
      }
    });
    if (unattributedRecords.length > 0 && completedIssueWindows.length > 0) {
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
  // Cross-file ambiguity guard: event windows carry no session identity,
  // so two DIFFERENT project log files -- e.g. an unrelated concurrent
  // session whose own unattributed activity happens to fall inside this
  // issue's completed window purely by wall-clock coincidence -- can both
  // independently match the same issue. Emitting both would not just
  // misattribute the stray file's usage; buildSample's markAmbiguousOverlaps
  // would then also flag the LEGITIMATE sample as ambiguous (outcome:
  // unknown), discarding the real measurement too. Emitting for NEITHER
  // file when more than one contributes to the same issue is strictly
  // safer than emitting a contaminated pair.
  const fileCountByIssue = new Map();
  for (const candidate of eventWindowCandidates) {
    const filesForIssue =
      fileCountByIssue.get(candidate.issueNumber) ?? new Set();
    filesForIssue.add(candidate.fileBasename);
    fileCountByIssue.set(candidate.issueNumber, filesForIssue);
  }
  for (const candidate of eventWindowCandidates) {
    const contributingFiles = fileCountByIssue.get(candidate.issueNumber);
    if ((contributingFiles?.size ?? 0) > 1) {
      process.stderr.write(
        `token-cost-harvest: skipping event-window issue #${candidate.issueNumber}: matched by more than one project log file (${[...(contributingFiles ?? [])].join(', ')})\n`,
      );
      continue;
    }
    try {
      const eventWindowResult = claudeAdapter.harvest({
        records: candidate.records,
        fileBasename: candidate.fileBasename,
        issueNumberOverride: candidate.issueNumber,
      });
      out.push({
        vendor: 'claude',
        adapterResult: eventWindowResult,
        timeline: extractClaudeUsageTimeline(candidate.records),
      });
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping event-window issue #${candidate.issueNumber}: ${error.message}\n`,
      );
    }
  }
  return out;
}
function scanCodexVendorSessions(sessionsDir) {
  const out = [];
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
      });
      out.push({
        vendor: 'codex',
        adapterResult,
        timeline: extractCodexUsageTimeline(records),
      });
    } catch (error) {
      process.stderr.write(
        `token-cost-harvest: skipping ${file}: ${error.message}\n`,
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
function scanGrokVendorSessions(sessionsDir) {
  return scanGrokSessions({ sessionsDir }).map((adapterResult) => ({
    vendor: 'grok',
    adapterResult,
    timeline: { mode: 'delta', points: [] },
  }));
}
// ---------------------------------------------------------------------------
// Sample assembly
// ---------------------------------------------------------------------------
export function buildSample(
  session,
  owner,
  repo,
  eventWindowsAll,
  trustedLogins,
) {
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
  const sample = {
    ...base,
    kind: 'issue-loop',
    issueNumber,
    stages,
    attribution: attribution,
    outcome: deriveOutcome(ctx),
  };
  const redacted = redactTokenCostRecord(sample);
  return { sample: redacted, issueNumber, startedAtMs, endedAtMs };
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function defaultStateDir() {
  const base =
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), '.local', 'state');
  return join(base, 'idd-skill', 'token-cost');
}
// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header for the full invariant.
const TOKEN_COST_HARVEST_FLAG_SPEC = {
  '--repo': { type: 'string', default: '' },
  '--out': { type: 'string', default: '' },
  '--events': { type: 'string', default: '' },
  '--dry-run': { type: 'boolean', default: false },
  '--trusted-marker-logins': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/token-cost-harvest.mjs --repo <owner>/<repo> [--out <path>] [--events <path>] [--dry-run]

  --repo <owner>/<repo>         Repository to join harvested sessions against. Required.
  --out <path>                 Output samples JSONL path (default:
                                ${defaultStateDir()}/samples.jsonl).
  --events <path>               Phase-event JSONL path (default:
                                ${defaultStateDir()}/events.jsonl). Missing file is not an error.
  --dry-run                    Print counts to stderr; write nothing.
  --trusted-marker-logins a,b   Logins whose IDD markers are trusted (default: .github/idd/config.json's trustedMarkerActors).
  --help, -h                   Show this help.
`);
}
export function vendorSessionKey(sample) {
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
export function readExistingVendorSessionKeys(outPath) {
  const keys = new Set();
  if (!existsSync(outPath)) {
    return keys;
  }
  const lines = readFileSync(outPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
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
export function parseRepoFlag(repoFlag) {
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
function runCli(argv) {
  const { values, help } = parseCliArgs(argv, TOKEN_COST_HARVEST_FLAG_SPEC);
  if (help) {
    printHelp();
    return;
  }
  const repoFlag = values.repo;
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
  const dryRun = values['dry-run'];
  const outPath = values.out || join(defaultStateDir(), 'samples.jsonl');
  const eventsPath = values.events || join(defaultStateDir(), 'events.jsonl');
  const trustedLogins = resolveTrustedMarkerLogins(
    values['trusted-marker-logins'],
  );
  const eventWindows = readEventWindows(eventsPath);
  const sessions = [
    ...scanClaudeVendorSessions(defaultClaudeProjectDir(), eventWindows),
    ...scanCodexVendorSessions(defaultCodexSessionsDir()),
    ...scanGrokVendorSessions(defaultGrokSessionsDir()),
  ];
  const harvested = [];
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
        `token-cost-harvest: skipping ${session.vendor} session: ${error.message}\n`,
      );
    }
  }
  markAmbiguousOverlaps(harvested);
  const issueLoopCount = harvested.filter(
    (h) => h.sample.kind === 'issue-loop',
  ).length;
  process.stderr.write(
    `token-cost-harvest: ${harvested.length} sample(s) (${issueLoopCount} issue-loop, ${harvested.length - issueLoopCount} session)\n`,
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
    `token-cost-harvest: appended ${newSamples.length} new sample(s) to ${outPath} (skipped ${harvested.length - newSamples.length} already present)\n`,
  );
}
if (import.meta.main) {
  runCli(process.argv.slice(2));
}
