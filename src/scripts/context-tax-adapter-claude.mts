// idd-generated-from: src/scripts/context-tax-adapter-claude.mts
//
// The scripts/context-tax-adapter-claude.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Claude Code adapter (#2290) for the context-tax measurement contract
// (#2288). Source-repo only: not HELPER_COMMANDS, not idd-template/. A
// pure library module -- no CLI, no shebang, mirroring
// context-tax-core.mts's own shape -- so it needs no HELPER_COMMANDS
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
// `ContextTaxJoinHints` (context-tax-core.mts) has no branch field to
// carry it through as a join hint, and the sample record itself must
// never hold a branch string (privacy) -- so this adapter leaves it
// alone entirely rather than inventing a new interface field for it.

import { globSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import {
  assertContextTaxSample,
  type ContextTaxAdapterResult,
  type ContextTaxSessionSample,
  type ContextTaxUsage,
  type ContextTaxVendorAdapter,
  inferIssueNumberFromBasename,
  redactContextTaxRecord,
} from './context-tax-core.mts';

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

/** Parse a Claude Code project JSONL file's text into raw, untyped records, tolerating a malformed or truncated trailing line from an interrupted process (unlike context-tax-report.mts's committed-artifact strict parse, this reads real local logs outside this repo's control). */
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
function extractSessionId(records: readonly unknown[]): string | undefined {
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
 * `redactContextTaxRecord()` would later strip to `undefined`, silently
 * producing a schema-invalid sample instead of failing closed.
 */
function deriveFallbackSessionId(
  fileBasename: string | undefined,
): string | undefined {
  if (!fileBasename) {
    return undefined;
  }
  const stripped = basename(fileBasename).replace(/\.jsonl$/i, '');
  return stripped.length > 0 ? stripped : undefined;
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
 * {@link ContextTaxUsage}. `input_tokens` is already uncached (never
 * subtract cache fields from it). `cache_creation` may split ephemeral
 * 5m/1h buckets; when present, sum both into `cacheCreation` instead of
 * trusting the scalar `cache_creation_input_tokens` alone. Claude Code
 * does not report a separate reasoning-token count, so `reasoning` is
 * always `0`.
 */
function usageFromFields(raw: ClaudeUsageFields): ContextTaxUsage {
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

const ZERO_USAGE: ContextTaxUsage = {
  inputUncached: 0,
  cacheRead: 0,
  cacheCreation: 0,
  output: 0,
  reasoning: 0,
};

function addUsage(a: ContextTaxUsage, b: ContextTaxUsage): ContextTaxUsage {
  return {
    inputUncached: a.inputUncached + b.inputUncached,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** Sum every assistant message's usage into one session total, including `isSidechain: true` rows. */
function extractUsage(records: readonly unknown[]): ContextTaxUsage {
  let summed = ZERO_USAGE;
  for (const record of records) {
    if (!isAssistantRecord(record)) {
      continue;
    }
    const usage = getUsage(record);
    if (!usage) {
      continue;
    }
    summed = addUsage(summed, usageFromFields(usage as ClaudeUsageFields));
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

function extractIncludesSubagents(records: readonly unknown[]): boolean {
  return records.some((record) => isSidechainRecord(record));
}

function asClaudeHarvestInput(input: unknown): ClaudeHarvestInput {
  if (!isPlainObject(input) || !Array.isArray(input.records)) {
    throw new Error(
      'context-tax-adapter-claude: harvest input must be { records: unknown[] }',
    );
  }
  const fileBasename =
    typeof input.fileBasename === 'string' ? input.fileBasename : undefined;
  return { records: input.records, fileBasename };
}

/** Claude Code vendor adapter. `input` must satisfy {@link ClaudeHarvestInput}. */
export const claudeAdapter: ContextTaxVendorAdapter = {
  harvest(input: unknown): ContextTaxAdapterResult {
    const { records, fileBasename } = asClaudeHarvestInput(input);

    const vendorSessionId =
      extractSessionId(records) ?? deriveFallbackSessionId(fileBasename);
    if (!vendorSessionId) {
      throw new Error(
        'context-tax-adapter-claude: unable to determine a vendorSessionId',
      );
    }

    const timestamps = extractTimestamps(records);
    if (!timestamps) {
      throw new Error(
        'context-tax-adapter-claude: no record has a valid timestamp',
      );
    }

    const cwd = extractCwd(records);
    const issueNumber = cwd
      ? inferIssueNumberFromBasename(basename(cwd))
      : undefined;

    const sample: ContextTaxSessionSample = {
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

    const redacted = redactContextTaxRecord(sample) as ContextTaxSessionSample;
    assertContextTaxSample(redacted);

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
 * `*.jsonl` files and harvest each into a {@link ContextTaxAdapterResult}.
 * Unlike the Codex rollout tree, Claude Code already scopes one directory
 * per project cwd, so no additional idd-skill-cwd filter is needed here.
 */
export function scanClaudeSessions(
  options?: ScanClaudeSessionsOptions,
): ContextTaxAdapterResult[] {
  const projectDir = options?.projectDir ?? defaultClaudeProjectDir();
  const files = globSync('*.jsonl', {
    cwd: projectDir,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const results: ContextTaxAdapterResult[] = [];
  for (const file of files) {
    // Read, parse, and harvest all live inside one try: a live Claude Code
    // session can still be writing (or an unrelated process can delete) a
    // project JSONL file between globSync and this line, so readFileSync
    // itself can throw (ENOENT/EACCES), not only harvest() on malformed
    // content -- either failure must skip just this one file, never abort
    // the whole scan.
    try {
      const records = parseClaudeProjectLines(readFileSync(file, 'utf8'));
      results.push(
        claudeAdapter.harvest({
          records,
          fileBasename: basename(file),
        } satisfies ClaudeHarvestInput),
      );
    } catch {}
  }
  return results;
}
