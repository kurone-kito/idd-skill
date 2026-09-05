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
// stream of per-turn records. This module documents the specific record
// shapes it reads (assistant messages carrying `message.usage`, and
// `type: "system", subtype: "compact_boundary"` records) as local
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
import { globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assertTokenCostSample,
  inferIssueNumberFromBasename,
  redactTokenCostRecord,
} from './token-cost-core.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function getMessage(record) {
  if (!isPlainObject(record)) {
    return undefined;
  }
  const message = record.message;
  return isPlainObject(message) ? message : undefined;
}
function getUsage(record) {
  const usage = getMessage(record)?.usage;
  return isPlainObject(usage) ? usage : undefined;
}
function getStringField(obj, key) {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function isAssistantRecord(record) {
  return isPlainObject(record) && record.type === 'assistant';
}
function isSidechainRecord(record) {
  return isPlainObject(record) && record.isSidechain === true;
}
/** `type: "system"` records name their kind via `subtype`, e.g. `compact_boundary`. Requires `type === 'system'` so an unrelated record kind that happens to carry a compaction-shaped `subtype` is never miscounted; `subtype` is matched by substring so a future vendor-added variant (`compaction`, etc.) still counts without an enum update here. A record with no documented compact `subtype` at all is not counted -- see the module doc comment on best-effort compaction counting. */
function isCompactionRecord(record) {
  if (!isPlainObject(record) || record.type !== 'system') {
    return false;
  }
  const subtype = getStringField(record, 'subtype');
  return subtype !== undefined && /compact/i.test(subtype);
}
/** Parse a Claude Code project JSONL file's text into raw, untyped records, tolerating a malformed or truncated trailing line from an interrupted process (unlike token-cost-report.mts's committed-artifact strict parse, this reads real local logs outside this repo's control). */
export function parseClaudeProjectLines(text) {
  const out = [];
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
export function extractSessionId(records) {
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
export function deriveFallbackSessionId(fileBasename) {
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
function deriveVendorSessionId(base, segmentIndex, eventWindowIssueNumber) {
  if (base === undefined) {
    return undefined;
  }
  if (eventWindowIssueNumber !== undefined) {
    return `${base}#ew${eventWindowIssueNumber}`;
  }
  return segmentIndex === undefined ? base : `${base}#${segmentIndex}`;
}
/** The first non-empty top-level `cwd` across `records`, in file order. */
function extractCwd(records) {
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
export function segmentRecordsByCwd(records) {
  const segments = [];
  let currentCwd;
  let haveCwd = false;
  let currentRecords = [];
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
function extractModel(records) {
  let model;
  for (const record of records) {
    const candidate = getStringField(getMessage(record), 'model');
    if (candidate) {
      model = candidate;
    }
  }
  return model;
}
function toValidTimestamp(value) {
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
export function extractRecordTimestampMs(record) {
  if (!isPlainObject(record) || typeof record.timestamp !== 'string') {
    return undefined;
  }
  const atMs = Date.parse(record.timestamp);
  return Number.isFinite(atMs) ? atMs : undefined;
}
/** First and last valid record `timestamp` fields, in file order. Undefined when no record has one. */
function extractTimestamps(records) {
  let startedAt;
  let endedAt;
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
function toNonNegativeInt(value) {
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
function usageFromFields(raw) {
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
/** Sum every assistant message's usage into one session total, including `isSidechain: true` rows. */
function extractUsage(records) {
  let summed = ZERO_USAGE;
  for (const record of records) {
    if (!isAssistantRecord(record)) {
      continue;
    }
    const usage = getUsage(record);
    if (!usage) {
      continue;
    }
    summed = addUsage(summed, usageFromFields(usage));
  }
  return summed;
}
function countCompactions(records) {
  let count = 0;
  for (const record of records) {
    if (isCompactionRecord(record)) {
      count += 1;
    }
  }
  return count;
}
function extractIncludesSubagents(records) {
  return records.some((record) => isSidechainRecord(record));
}
function asClaudeHarvestInput(input) {
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
  return {
    records: input.records,
    fileBasename,
    segmentIndex,
    issueNumberOverride,
    vendorSessionIdOverride,
  };
}
/** Claude Code vendor adapter. `input` must satisfy {@link ClaudeHarvestInput}. */
export const claudeAdapter = {
  harvest(input) {
    const {
      records,
      fileBasename,
      segmentIndex,
      issueNumberOverride,
      vendorSessionIdOverride,
    } = asClaudeHarvestInput(input);
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
    const sample = {
      schemaVersion: 1,
      kind: 'session',
      vendor: 'claude',
      model: extractModel(records) ?? 'unknown',
      attribution: 'session-unscoped',
      outcome: 'unknown',
      usage: extractUsage(records),
      compactionCount: countCompactions(records),
      startedAt: timestamps.startedAt,
      endedAt: timestamps.endedAt,
      vendorSessionId,
      includesSubagents: extractIncludesSubagents(records),
    };
    const redacted = redactTokenCostRecord(sample);
    assertTokenCostSample(redacted);
    return issueNumber === undefined
      ? { sample: redacted }
      : { sample: redacted, joinHints: { issueNumber } };
  },
};
/** `~/.claude/projects`, the root Claude Code stores one directory per encoded cwd under. */
export function defaultClaudeProjectsRoot() {
  return join(homedir(), '.claude', 'projects');
}
/** Claude Code's project-directory encoding: every character that is not `[A-Za-z0-9]` (path separators, dots, etc.) becomes `-`. */
export function encodeClaudeProjectDirName(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
/** `~/.claude/projects/<encoded-cwd>`, the default project log directory for `cwd` (defaults to `process.cwd()`). */
export function defaultClaudeProjectDir(cwd = process.cwd()) {
  return join(defaultClaudeProjectsRoot(), encodeClaudeProjectDirName(cwd));
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
export function scanClaudeSessions(options) {
  const projectDir = options?.projectDir ?? defaultClaudeProjectDir();
  const files = globSync('*.jsonl', {
    cwd: projectDir,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const results = [];
  for (const file of files) {
    // A live Claude Code session can still be writing (or an unrelated
    // process can delete) a project JSONL file between globSync and this
    // line, so readFileSync itself can throw (ENOENT/EACCES) -- that
    // failure must skip just this one file, never abort the whole scan.
    let records;
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
          }),
        );
      } catch {}
    });
  }
  return results;
}
