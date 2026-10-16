// idd-generated-from: src/scripts/token-cost-adapter-claude.mts
//
// The scripts/token-cost-adapter-claude.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Claude Code adapter (#2290) for the token-cost measurement contract
// (#2288). Source-repo only: not HELPER_COMMANDS, not idd-template/. A
// pure library module -- no CLI, no shebang, mirroring
// token-cost-core.mts's own shape -- so it needs no HELPER_COMMANDS
// registration or SOURCE_REPO_INTERNAL_ENTRY_PATHS entry.
//
// Reads Claude Code project JSONL files
// (`~/.claude/projects/<encoded-cwd>/*.jsonl`), each a newline-delimited
// stream of records. Claude Code writes one record per content block of an
// API response, and those records share a `requestId` and a `message.id`,
// so assistant records are grouped into API requests (`groupClaudeRequests`,
// #4380) before usage and turns are counted. This module documents the
// specific record shapes it reads (assistant records carrying
// `message.usage`, and `type: "system", subtype: "compact_boundary"`
// records) as local
// structural types; only the fields actually consumed are declared, and
// every extraction degrades gracefully (never throws) except when the
// harvested session has no usable timestamp or no derivable
// vendorSessionId, either of which fails closed as a malformed project
// log. Compaction is not a first-class event type in
// sampled logs and is counted best-effort: any record whose `subtype`
// clearly names a compaction (`compact_boundary` and similar) counts;
// none matching emits `0` rather than guessing from message gaps.
//
// `gitBranch` appears on every record but is never read here:
// `TokenCostJoinHints` (token-cost-core.mts) has no branch field to
// carry it through as a join hint, and the sample record itself must
// never hold a branch string (privacy) -- so this adapter leaves it
// alone entirely rather than inventing a new interface field for it.
//
// #2404: a long-lived interactive session that works across many issues
// and worktrees within one continuous conversation records a different
// `cwd` on different stretches of the SAME project JSONL file -- the
// file's `cwd` is not a per-file constant, only per-stretch. Reading only
// the first `cwd` found (the original `extractCwd` behavior) can never
// produce an issue-loop sample for any later worktree, no matter how much
// real per-issue work happens there. `scanClaudeSessions` below now
// segments each file's records into contiguous cwd-stable runs
// (`segmentRecordsByCwd`) and calls `claudeAdapter.harvest()` once per
// segment, scoping usage/timestamp extraction to just that segment's
// records; `claudeAdapter.harvest()` itself is unchanged in shape (still
// one call in, one `TokenCostAdapterResult` out) and stays exactly as
// valid for a single-segment (the common, unchanged case) as before.
//
// #2418: #2404's cwd-segmentation only helps when a session's `cwd`
// actually varies mid-file. On a workstation where every session is
// launched once from the primary worktree and moves between issue
// worktrees only via in-conversation `cd` (never a fresh Claude Code
// launch), `cwd` never varies at all, so #2404's fix is never exercised.
// `ClaudeHarvestInput.issueNumberOverride` lets a caller (the
// harvester's event-window fallback in `token-cost-harvest.mts`, which
// this module has no events.jsonl access to implement itself) supply the
// issue number directly, bypassing cwd-inference for that call. This
// module stays cwd-only otherwise; `scanClaudeSessions` below never sets
// `issueNumberOverride` (it has no events.jsonl input to derive one
// from) and keeps its documented cwd-only contract.
//
// #4383: Claude Code writes a subagent's records to
// `<project dir>/<session id>/subagents/agent-<agent id>.jsonl`, not into the
// session file this module is handed, so a session file alone misses every
// subagent API request. Each assistant record there carries
// `isSidechain: true`, the subagent's `agentId`, and the parent's `sessionId`;
// the other lines are user, attachment and system rows, and the first line of
// a fork transcript is a `fork-context-ref` row. That first assistant record
// repeats a request and a `tool_use` id of the parent file (observed
// 2026-10-15 on this machine: 17 fork transcripts repeat 13 parent requests).
// No session file here carries an inline `isSidechain: true` row, so the
// inline layout that the session-sidechain fixture describes is unobserved.
// `ClaudeHarvestInput.subagentRecords` takes those parsed lines as one flat
// array, so a request repeated across agents counts once. Its assistant
// records count toward `usage`, `turnCount` and `toolCallCount` under the
// same rules as `records`, and set `includesSubagents`; `model`, timestamps,
// `compactionCount`, cwd and the join hints still come from `records` alone.
// Only counts leave this module, never subagent content. Reading the
// `subagents/` files and routing them to samples is a follow-up, so no
// production caller passes the field yet.

import { globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assertTokenCostSample,
  inferIssueNumberFromBasename,
  redactTokenCostRecord,
  type TokenCostAdapterResult,
  type TokenCostSessionSample,
  type TokenCostUsage,
  type TokenCostVendorAdapter,
} from './token-cost-core.mts';

/** Raw usage fields Claude Code reports on an assistant message. */
interface ClaudeUsageFields {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation?: {
    ephemeral_5m_input_tokens?: unknown;
    ephemeral_1h_input_tokens?: unknown;
  };
}

/** One project JSONL file's parsed lines, plus the filename this adapter's harvest() needs as a last-resort session-id fallback. */
export interface ClaudeHarvestInput {
  /** One project JSONL file's parsed lines, in file order. */
  records: readonly unknown[];
  /** Project JSONL filename basename only -- never a directory path. */
  fileBasename?: string;
  /**
   * Disambiguates multiple harvest() calls whose `records` all come from
   * the SAME underlying project JSONL file -- one call per contiguous cwd
   * segment (see `segmentRecordsByCwd` / `scanClaudeSessions`) -- so each
   * segment's sample gets a distinct, stable `vendorSessionId` instead of
   * colliding on the file's own shared `sessionId`. Leave undefined for a
   * whole-file / single-segment harvest: the common case (a file that
   * never changes `cwd`) keeps its pre-existing `vendorSessionId` exactly
   * as before, with no suffix at all. Ignored when `issueNumberOverride`
   * is set (mutually exclusive call patterns -- see below).
   */
  segmentIndex?: number;
  /**
   * #2418: supplies the issue number directly, bypassing this adapter's
   * own cwd-based inference, for a caller (the harvester's event-window
   * fallback) that has already determined `records` belongs to this issue
   * by correlating their own timestamps against `token-cost-event.mjs`
   * enter/exit windows rather than any `cwd` field. Takes priority over
   * cwd-inference when present. Also switches the `vendorSessionId` suffix
   * scheme to `#ew<issueNumber>` (self-describing, and collision-safe
   * against the numeric `#<segmentIndex>` scheme above) since these two
   * fallback paths are never combined on the same harvest() call.
   */
  issueNumberOverride?: number;
  /**
   * #2432: pins the resulting sample's identity to a specific vendor
   * session id, bypassing `extractSessionId(records) ??
   * deriveFallbackSessionId(fileBasename)` outright. For a merged
   * cross-session handoff harvest, `records` carries lines from more than
   * one project JSONL file concatenated together -- `extractSessionId`'s
   * "first non-empty `sessionId` in file order" scan would then pick
   * whichever file's own id happens to sort first in the merged array,
   * not necessarily the primary (winning `cleanup`) session's own id.
   * Set this explicitly instead of relying on record order.
   */
  vendorSessionIdOverride?: string;
  /**
   * #4383: parsed lines of the `subagents/agent-<agent id>.jsonl` transcripts
   * that Claude Code writes beside the session file, as one flat array in any
   * order, so a request repeated across agents counts once. Only assistant
   * records count, toward `usage`, `turnCount` and `toolCallCount`, and they
   * set `includesSubagents`; any other entry is ignored, and a value that is
   * not an array is treated as absent. `model`, the timestamps,
   * `compactionCount`, the cwd and the join hints still come from `records`
   * alone.
   */
  subagentRecords?: readonly unknown[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMessage(record: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(record)) {
    return undefined;
  }
  const message = record.message;
  return isPlainObject(message) ? message : undefined;
}

function getUsage(record: unknown): Record<string, unknown> | undefined {
  const usage = getMessage(record)?.usage;
  return isPlainObject(usage) ? usage : undefined;
}

function getStringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isAssistantRecord(record: unknown): boolean {
  return isPlainObject(record) && record.type === 'assistant';
}

function isSidechainRecord(record: unknown): boolean {
  return isPlainObject(record) && record.isSidechain === true;
}

/** `type: "system"` records name their kind via `subtype`, e.g. `compact_boundary`. Requires `type === 'system'` so an unrelated record kind that happens to carry a compaction-shaped `subtype` is never miscounted; `subtype` is matched by substring so a future vendor-added variant (`compaction`, etc.) still counts without an enum update here. A record with no documented compact `subtype` at all is not counted -- see the module doc comment on best-effort compaction counting. */
function isCompactionRecord(record: unknown): boolean {
  if (!isPlainObject(record) || record.type !== 'system') {
    return false;
  }
  const subtype = getStringField(record, 'subtype');
  return subtype !== undefined && /compact/i.test(subtype);
}

/** Parse a Claude Code project JSONL file's text into raw, untyped records, tolerating a malformed or truncated trailing line from an interrupted process (unlike token-cost-report.mts's committed-artifact strict parse, this reads real local logs outside this repo's control). */
export function parseClaudeProjectLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** The first non-empty top-level `sessionId` across `records`, in file order -- stable per project JSONL file (it matches the file's own basename). */
export function extractSessionId(
  records: readonly unknown[],
): string | undefined {
  for (const record of records) {
    const sessionId = isPlainObject(record)
      ? getStringField(record, 'sessionId')
      : undefined;
    if (sessionId) {
      return sessionId;
    }
  }
  return undefined;
}

/**
 * Normalizes with `path.basename()` first (never trusts a caller's
 * `fileBasename` to already be path-free) so a full path passed in by
 * mistake can't survive into a path-like fallback `vendorSessionId` that
 * `redactTokenCostRecord()` would later strip to `undefined`, silently
 * producing a schema-invalid sample instead of failing closed.
 */
export function deriveFallbackSessionId(
  fileBasename: string | undefined,
): string | undefined {
  if (!fileBasename) {
    return undefined;
  }
  const stripped = basename(fileBasename).replace(/\.jsonl$/i, '');
  return stripped.length > 0 ? stripped : undefined;
}

/**
 * Appends `segmentIndex` to `base` (`#2404`) so multiple harvest() calls
 * against records from the SAME project JSONL file -- one call per cwd
 * segment -- get distinct `vendorSessionId`s instead of colliding on the
 * file's own shared `sessionId`. `segmentIndex === undefined` (the
 * single-segment / whole-file case) returns `base` completely unchanged,
 * so a file that never changes `cwd` keeps its pre-existing
 * `vendorSessionId` and stays deduplicated against samples already
 * harvested before this change.
 *
 * Known, deliberate one-time migration edge: a live session already
 * harvested once as single-segment (its `base` id, with no suffix, recorded in
 * `samples.jsonl`) that later `cd`s into a worktree becomes multi-segment
 * on its next harvest; that segment's usage re-enters under `base#0`
 * while the earlier whole-file snapshot under the bare `base` remains, so
 * the overlapping usage is counted twice across those two runs. Leaving
 * segment 0 without a suffix instead would only move the same double-count onto
 * segments 1+ the first time an already-harvested single-segment file
 * gains a second segment -- unavoidable without content-hashing each
 * segment, and out of scope here since it is a one-time transition, not a
 * steady-state gap.
 */
function deriveVendorSessionId(
  base: string | undefined,
  segmentIndex: number | undefined,
  eventWindowIssueNumber: number | undefined,
): string | undefined {
  if (base === undefined) {
    return undefined;
  }
  if (eventWindowIssueNumber !== undefined) {
    return `${base}#ew${eventWindowIssueNumber}`;
  }
  return segmentIndex === undefined ? base : `${base}#${segmentIndex}`;
}

/** The first non-empty top-level `cwd` across `records`, in file order. */
function extractCwd(records: readonly unknown[]): string | undefined {
  for (const record of records) {
    const cwd = isPlainObject(record)
      ? getStringField(record, 'cwd')
      : undefined;
    if (cwd) {
      return cwd;
    }
  }
  return undefined;
}

/** One contiguous run of `records` (in file order) that shares the same `cwd`. `cwd` is `undefined` only when no record in the run carries one at all. */
export interface ClaudeCwdSegment {
  cwd: string | undefined;
  records: unknown[];
}

/**
 * Splits `records` into contiguous segments wherever the recorded `cwd`
 * changes (`#2404`), in file order. A record that carries no `cwd` field
 * joins whichever segment is currently open rather than forcing a split --
 * only a genuine change to a NEW non-empty `cwd` value starts a new
 * segment. A file that never changes `cwd` (the common case), or never
 * records one at all, still produces exactly one segment covering every
 * record -- byte-for-byte the same grouping `extractCwd`'s old
 * whole-file "first cwd found" behavior implied, so scanClaudeSessions
 * can special-case a single segment to skip vendorSessionId suffixing.
 */
export function segmentRecordsByCwd(
  records: readonly unknown[],
): ClaudeCwdSegment[] {
  const segments: ClaudeCwdSegment[] = [];
  let currentCwd: string | undefined;
  let haveCwd = false;
  let currentRecords: unknown[] = [];
  for (const record of records) {
    const cwd = isPlainObject(record)
      ? getStringField(record, 'cwd')
      : undefined;
    if (cwd !== undefined) {
      if (haveCwd && cwd !== currentCwd) {
        segments.push({ cwd: currentCwd, records: currentRecords });
        currentRecords = [];
      }
      currentCwd = cwd;
      haveCwd = true;
    }
    currentRecords.push(record);
  }
  if (currentRecords.length > 0) {
    segments.push({ cwd: currentCwd, records: currentRecords });
  }
  return segments;
}

/** Most recently reported `message.model` string across every record, or undefined when none exists. */
function extractModel(records: readonly unknown[]): string | undefined {
  let model: string | undefined;
  for (const record of records) {
    const candidate = getStringField(getMessage(record), 'model');
    if (candidate) {
      model = candidate;
    }
  }
  return model;
}

function toValidTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * One record's own `timestamp` field, parsed to epoch milliseconds, or
 * undefined when absent/invalid. Exported for the harvester's
 * event-window fallback (#2418), which needs each record's own timestamp
 * independent of any `cwd` field to determine which issue's event window
 * (if any) that record falls inside.
 */
export function extractRecordTimestampMs(record: unknown): number | undefined {
  if (!isPlainObject(record) || typeof record.timestamp !== 'string') {
    return undefined;
  }
  const atMs = Date.parse(record.timestamp);
  return Number.isFinite(atMs) ? atMs : undefined;
}

/** First and last valid record `timestamp` fields, in file order. Undefined when no record has one. */
function extractTimestamps(
  records: readonly unknown[],
): { startedAt: string; endedAt: string } | undefined {
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  for (const record of records) {
    if (!isPlainObject(record)) {
      continue;
    }
    const ts = toValidTimestamp(record.timestamp);
    if (!ts) {
      continue;
    }
    if (startedAt === undefined) {
      startedAt = ts;
    }
    endedAt = ts;
  }
  return startedAt !== undefined && endedAt !== undefined
    ? { startedAt, endedAt }
    : undefined;
}

function toNonNegativeInt(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Map one assistant message's raw `message.usage` fields to
 * {@link TokenCostUsage}. `input_tokens` is already uncached (never
 * subtract cache fields from it). `cache_creation` may split ephemeral
 * 5m/1h buckets; when present, sum both into `cacheCreation` instead of
 * trusting the scalar `cache_creation_input_tokens` alone. Claude Code
 * does not report a separate reasoning-token count, so `reasoning` is
 * always `0`.
 */
function usageFromFields(raw: ClaudeUsageFields): TokenCostUsage {
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

/**
 * One API request's assistant records, reduced to the values the adapter's
 * session totals and the harvester's per-stage timelines each need. Built
 * by {@link groupClaudeRequests}.
 */
export interface ClaudeRequest {
  /**
   * Field-wise maximum of {@link usageFromFields} across the request's
   * records that carry a `usage` object, so the records of one response
   * (identical or streaming snapshots) count once. All zero when none does.
   */
  usage: TokenCostUsage;
  /**
   * Epoch ms of the greatest-timestamped record that has both a valid
   * timestamp and a `usage` object. Undefined when no record has both; such
   * a request still counts in `usage` for the session total, but has no
   * per-stage usage point.
   */
  usageAtMs: number | undefined;
  /**
   * Epoch ms of the greatest valid timestamp across the request's records.
   * Undefined when none has a valid timestamp, in which case the request
   * counts in the session totals only.
   */
  turnAtMs: number | undefined;
  /** `tool_use` content blocks summed across all of the request's records. */
  toolCallCount: number;
}

/**
 * The request key of one assistant record: the pair of its top-level
 * `requestId` and its `message.id`, each taken only when it is a non-empty
 * string. A response's records share both, so the pair names one response.
 * Two responses that share a `requestId` (a silent Claude Code retry, see
 * Claude Code issue #46398) carry different `message.id` values and stay
 * apart. A record with only one identifier is keyed by that identifier alone,
 * with the other slot null. Undefined when neither is present.
 */
function requestIdentifierOf(
  record: Record<string, unknown>,
): string | undefined {
  const requestId = getStringField(record, 'requestId') ?? null;
  const messageId = getStringField(getMessage(record), 'id') ?? null;
  if (requestId === null && messageId === null) {
    return undefined;
  }
  return JSON.stringify([requestId, messageId]);
}

function newClaudeRequest(): ClaudeRequest {
  return {
    usage: { ...ZERO_USAGE },
    usageAtMs: undefined,
    turnAtMs: undefined,
    toolCallCount: 0,
  };
}

/** Field-wise maximum of two usages. */
function maxUsage(a: TokenCostUsage, b: TokenCostUsage): TokenCostUsage {
  return {
    inputUncached: Math.max(a.inputUncached, b.inputUncached),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheCreation: Math.max(a.cacheCreation, b.cacheCreation),
    output: Math.max(a.output, b.output),
    reasoning: Math.max(a.reasoning, b.reasoning),
  };
}

/** Folds one assistant record into its request. */
function addRecordToRequest(
  request: ClaudeRequest,
  record: Record<string, unknown>,
): void {
  const atMs = extractRecordTimestampMs(record);
  const usage = getUsage(record);
  if (usage) {
    request.usage = maxUsage(
      request.usage,
      usageFromFields(usage as ClaudeUsageFields),
    );
    if (
      atMs !== undefined &&
      (request.usageAtMs === undefined || atMs > request.usageAtMs)
    ) {
      request.usageAtMs = atMs;
    }
  }
  if (
    atMs !== undefined &&
    (request.turnAtMs === undefined || atMs > request.turnAtMs)
  ) {
    request.turnAtMs = atMs;
  }
  request.toolCallCount += countToolUseBlocksInRecord(record);
}

/**
 * Groups the assistant records of `records` into one {@link ClaudeRequest}
 * per API request (#4380). Claude Code writes one record per content block
 * of an API response, and those records share a `requestId` and a
 * `message.id`; records are grouped by that pair (see requestIdentifierOf).
 * A record with only one of the two identifiers is keyed by that identifier
 * alone, and a record with neither identifier is a request of its own, counted
 * with its own usage as before.
 *
 * The request's usage is the field-wise maximum across its records (see
 * {@link ClaudeRequest.usage}), so repeated and streaming-snapshot records
 * do not inflate the total. Its usage point is stamped at its
 * greatest-timestamped record that has a valid timestamp and usage. A
 * request whose records have no such record still counts in the session
 * totals, with no per-stage point.
 *
 * Grouping is within the given `records` array. A request split across cwd
 * segments or event-window groups therefore counts once per group. A
 * record that carries only one of the two identifiers is not joined to the
 * records that carry both, a known limit of this key rule. None is observed
 * in the local logs (checked 2026-10-15): no assistant record carries a
 * requestId without a message.id, and no message.id-only record shares its id
 * with a record that carries a requestId. Requests come back in
 * first-appearance order.
 */
export function groupClaudeRequests(
  records: readonly unknown[],
): ClaudeRequest[] {
  const requests: ClaudeRequest[] = [];
  const byIdentifier = new Map<string, ClaudeRequest>();
  for (const record of records) {
    if (!isAssistantRecord(record)) {
      continue;
    }
    const assistant = record as Record<string, unknown>;
    const identifier = requestIdentifierOf(assistant);
    const existing =
      identifier === undefined ? undefined : byIdentifier.get(identifier);
    const request = existing ?? newClaudeRequest();
    if (existing === undefined) {
      requests.push(request);
      if (identifier !== undefined) {
        byIdentifier.set(identifier, request);
      }
    }
    addRecordToRequest(request, assistant);
  }
  return requests;
}

/**
 * Sum every API request's usage (see {@link groupClaudeRequests}) into one
 * session total. The caller passes `records` and `subagentRecords` together
 * (#4383), so the inline `isSidechain: true` rows of `records` and the
 * subagent requests both count, and a request repeated across the two
 * counts once.
 */
function extractUsage(records: readonly unknown[]): TokenCostUsage {
  let summed = ZERO_USAGE;
  for (const request of groupClaudeRequests(records)) {
    summed = addUsage(summed, request.usage);
  }
  return summed;
}

function countCompactions(records: readonly unknown[]): number {
  let count = 0;
  for (const record of records) {
    if (isCompactionRecord(record)) {
      count += 1;
    }
  }
  return count;
}

/**
 * True when `records` holds an inline `isSidechain: true` row, or when
 * `subagentRecords` (the `subagents/` transcripts, #4383) holds at least one
 * assistant record. Only assistant records count on the subagent side, so a
 * subagent input of non-assistant rows alone (a fork's `fork-context-ref`
 * row, for example) leaves this false.
 */
function extractIncludesSubagents(
  records: readonly unknown[],
  subagentRecords: readonly unknown[] | undefined,
): boolean {
  return (
    records.some((record) => isSidechainRecord(record)) ||
    (subagentRecords ?? []).some((record) => isAssistantRecord(record))
  );
}

/** An assistant message's `message.content`, when it is an array of content blocks (tool calls, text, etc.); `[]` for a plain-string `content` or a missing message. */
function getContentBlocks(record: unknown): readonly unknown[] {
  const content = getMessage(record)?.content;
  return Array.isArray(content) ? content : [];
}

/** Count of `type: "tool_use"` blocks in one assistant record's `message.content` array. */
function countToolUseBlocksInRecord(record: unknown): number {
  let count = 0;
  for (const block of getContentBlocks(record)) {
    if (isPlainObject(block) && block.type === 'tool_use') {
      count += 1;
    }
  }
  return count;
}

/**
 * Every API request is one turn (see {@link groupClaudeRequests}), matching
 * {@link extractUsage}'s own inclusive convention: the sidechain rows of
 * `records` and the subagent requests of `subagentRecords` (#4383) both count.
 */
function extractTurnCount(records: readonly unknown[]): number {
  return groupClaudeRequests(records).length;
}

/**
 * Distinct `tool_use` ids across every assistant record of the caller's
 * inputs (`records` and `subagentRecords`, #4383), plus one for each block
 * with no usable id. A fork transcript repeats its parent's `tool_use`
 * blocks (observed 2026-10-15), so a repeated id counts once. A block whose
 * `id` is missing, not a string, or empty counts on its own.
 */
function extractToolCallCount(records: readonly unknown[]): number {
  const toolUseIds = new Set<string>();
  let blocksWithoutId = 0;
  for (const record of records) {
    if (!isAssistantRecord(record)) {
      continue;
    }
    for (const block of getContentBlocks(record)) {
      if (!isPlainObject(block) || block.type !== 'tool_use') {
        continue;
      }
      const id = getStringField(block, 'id');
      if (id === undefined) {
        blocksWithoutId += 1;
      } else {
        toolUseIds.add(id);
      }
    }
  }
  return toolUseIds.size + blocksWithoutId;
}

function asClaudeHarvestInput(input: unknown): ClaudeHarvestInput {
  if (!isPlainObject(input) || !Array.isArray(input.records)) {
    throw new Error(
      'token-cost-adapter-claude: harvest input must be { records: unknown[] }',
    );
  }
  const fileBasename =
    typeof input.fileBasename === 'string' ? input.fileBasename : undefined;
  const segmentIndex =
    typeof input.segmentIndex === 'number' ? input.segmentIndex : undefined;
  const issueNumberOverride =
    typeof input.issueNumberOverride === 'number'
      ? input.issueNumberOverride
      : undefined;
  const vendorSessionIdOverride =
    typeof input.vendorSessionIdOverride === 'string' &&
    input.vendorSessionIdOverride.length > 0
      ? input.vendorSessionIdOverride
      : undefined;
  const subagentRecords = Array.isArray(input.subagentRecords)
    ? input.subagentRecords
    : undefined;
  return {
    records: input.records,
    fileBasename,
    segmentIndex,
    issueNumberOverride,
    vendorSessionIdOverride,
    subagentRecords,
  };
}

/** Claude Code vendor adapter. `input` must satisfy {@link ClaudeHarvestInput}. */
export const claudeAdapter: TokenCostVendorAdapter = {
  harvest(input: unknown): TokenCostAdapterResult {
    const {
      records,
      fileBasename,
      segmentIndex,
      issueNumberOverride,
      vendorSessionIdOverride,
      subagentRecords,
    } = asClaudeHarvestInput(input);
    // #4383: subagent records count toward usage, turns and tool calls. The
    // identity and metadata fields below read `records` alone.
    const countedRecords =
      subagentRecords === undefined
        ? records
        : [...records, ...subagentRecords];

    const vendorSessionId = deriveVendorSessionId(
      vendorSessionIdOverride ??
        extractSessionId(records) ??
        deriveFallbackSessionId(fileBasename),
      segmentIndex,
      issueNumberOverride,
    );
    if (!vendorSessionId) {
      throw new Error(
        'token-cost-adapter-claude: unable to determine a vendorSessionId',
      );
    }

    const timestamps = extractTimestamps(records);
    if (!timestamps) {
      throw new Error(
        'token-cost-adapter-claude: no record has a valid timestamp',
      );
    }

    const cwd = extractCwd(records);
    const issueNumber =
      issueNumberOverride ??
      (cwd ? inferIssueNumberFromBasename(basename(cwd)) : undefined);

    const sample: TokenCostSessionSample = {
      schemaVersion: 1,
      kind: 'session',
      vendor: 'claude',
      model: extractModel(records) ?? 'unknown',
      attribution: 'session-unscoped',
      outcome: 'unknown',
      usage: extractUsage(countedRecords),
      compactionCount: countCompactions(records),
      startedAt: timestamps.startedAt,
      endedAt: timestamps.endedAt,
      vendorSessionId,
      includesSubagents: extractIncludesSubagents(records, subagentRecords),
      turnCount: extractTurnCount(countedRecords),
      toolCallCount: extractToolCallCount(countedRecords),
    };

    const redacted = redactTokenCostRecord(sample) as TokenCostSessionSample;
    assertTokenCostSample(redacted);

    return issueNumber === undefined
      ? { sample: redacted }
      : { sample: redacted, joinHints: { issueNumber } };
  },
};

/** `~/.claude/projects`, the root Claude Code stores one directory per encoded cwd under. */
export function defaultClaudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

/** Claude Code's project-directory encoding: every character that is not `[A-Za-z0-9]` (path separators, dots, etc.) becomes `-`. */
export function encodeClaudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** `~/.claude/projects/<encoded-cwd>`, the default project log directory for `cwd` (defaults to `process.cwd()`). */
export function defaultClaudeProjectDir(cwd: string = process.cwd()): string {
  return join(defaultClaudeProjectsRoot(), encodeClaudeProjectDirName(cwd));
}

export interface ScanClaudeSessionsOptions {
  /** Override the project directory containing `*.jsonl` files. Tests must always pass this -- never scan the real `~/.claude/projects` tree. */
  projectDir?: string;
}

/**
 * Scan `projectDir` (default `~/.claude/projects/<encoded-cwd>`) for
 * `*.jsonl` files and harvest each into zero or more
 * {@link TokenCostAdapterResult}s. Unlike the Codex rollout tree, Claude
 * Code already scopes one directory per project cwd, so no additional
 * idd-skill-cwd filter is needed here.
 *
 * A file's records are first split into contiguous cwd segments
 * (`#2404`, `segmentRecordsByCwd`) -- one `harvest()` call per segment, so
 * a long-lived session that moves across several `issue/<n>-*` worktrees
 * within one continuous conversation still produces a correctly-scoped
 * sample per worktree, not just one sample pinned to whichever cwd the
 * file happened to record first.
 */
// audit:ignore-dead-export: no production caller found by #3478's first repo-wide run; left for follow-up triage
export function scanClaudeSessions(
  options?: ScanClaudeSessionsOptions,
): TokenCostAdapterResult[] {
  const projectDir = options?.projectDir ?? defaultClaudeProjectDir();
  const files = globSync('*.jsonl', {
    cwd: projectDir,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const results: TokenCostAdapterResult[] = [];
  for (const file of files) {
    // A live Claude Code session can still be writing (or an unrelated
    // process can delete) a project JSONL file between globSync and this
    // line, so readFileSync itself can throw (ENOENT/EACCES) -- that
    // failure must skip just this one file, never abort the whole scan.
    let records: unknown[];
    try {
      records = parseClaudeProjectLines(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    const fileBasename = basename(file);
    const segments = segmentRecordsByCwd(records);
    segments.forEach((segment, index) => {
      // Each segment's harvest() call is its own try: one malformed or
      // timestamp-less segment (e.g. a stretch with no valid timestamp)
      // must not discard its sibling segments from the same file.
      try {
        results.push(
          claudeAdapter.harvest({
            records: segment.records,
            fileBasename,
            // Suffix only when a file actually produced more than one
            // segment -- the common single-segment case keeps its
            // pre-existing vendorSessionId (no suffix) so already-harvested
            // samples stay deduplicated against this change.
            segmentIndex: segments.length > 1 ? index : undefined,
          } satisfies ClaudeHarvestInput),
        );
      } catch {}
    });
  }
  return results;
}
