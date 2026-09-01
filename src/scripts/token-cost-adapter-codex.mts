// idd-generated-from: src/scripts/token-cost-adapter-codex.mts
//
// The scripts/token-cost-adapter-codex.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Codex CLI adapter (#2291) for the token-cost measurement contract
// (#2288). Source-repo only: not HELPER_COMMANDS, not idd-template/. A
// pure library module -- no CLI, no shebang, mirroring
// token-cost-core.mts's own shape -- so it needs no HELPER_COMMANDS
// registration or SOURCE_REPO_INTERNAL_ENTRY_PATHS entry.
//
// Reads Codex CLI rollout files
// (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), each a newline-
// delimited stream of `{ timestamp, type, payload }` lines. This module
// documents the specific record shapes it reads (`session_meta`,
// `turn_context`, `token_count`, `compacted`) as local structural types;
// only the fields actually consumed are declared, and every extraction
// degrades gracefully (never throws) except when the harvested session
// has no usable timestamp at all, which fails closed as a malformed
// rollout.

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

/** Raw token-usage fields Codex CLI reports on a `token_count` payload. */
interface CodexTokenUsageFields {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  reasoning_output_tokens?: unknown;
}

/** One rollout file's parsed lines, plus the filename this adapter's harvest() needs as a last-resort session-id fallback. */
export interface CodexHarvestInput {
  /** One rollout file's parsed JSONL lines, in file order. */
  records: readonly unknown[];
  /** Rollout filename basename only -- never a directory path. */
  fileBasename?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPayload(record: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(record)) {
    return undefined;
  }
  const payload = record.payload;
  return isPlainObject(payload) ? payload : undefined;
}

function getStringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getObjectField(
  obj: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = obj?.[key];
  return isPlainObject(value) ? value : undefined;
}

function isRecordOfType(record: unknown, type: string): boolean {
  return isPlainObject(record) && record.type === type;
}

function findRecordByType(records: readonly unknown[], type: string): unknown {
  return records.find((record) => isRecordOfType(record, type));
}

/** Parse a Codex rollout JSONL file's text into raw, untyped records, tolerating a malformed or truncated trailing line from an interrupted process (unlike token-cost-report.mts's committed-artifact strict parse, this reads real local logs outside this repo's control). */
export function parseCodexRolloutLines(text: string): unknown[] {
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

/** The session's working directory, from `session_meta.payload.cwd` first, falling back to any record carrying a `payload.cwd` string. */
export function extractSessionCwd(
  records: readonly unknown[],
): string | undefined {
  const sessionMeta = findRecordByType(records, 'session_meta');
  const fromMeta = getStringField(getPayload(sessionMeta), 'cwd');
  if (fromMeta) {
    return fromMeta;
  }
  for (const record of records) {
    const cwd = getStringField(getPayload(record), 'cwd');
    if (cwd) {
      return cwd;
    }
  }
  return undefined;
}

/** Whether a session's cwd names an idd-skill worktree or clone. */
export function isIddSkillCwd(cwd: string | undefined): boolean {
  return typeof cwd === 'string' && cwd.includes('idd-skill');
}

function extractSessionId(sessionMeta: unknown): string | undefined {
  return getStringField(getPayload(sessionMeta), 'id');
}

function deriveFallbackSessionId(
  fileBasename: string | undefined,
): string | undefined {
  if (!fileBasename) {
    return undefined;
  }
  // basename() first: a caller-supplied fileBasename is never trusted to
  // already be path-free, so a full path here would otherwise redact
  // away as PATH_LIKE and fail closed downstream instead of just here.
  const stripped = basename(fileBasename).replace(/\.jsonl$/i, '');
  return stripped.length > 0 ? stripped : undefined;
}

/** Most recently reported `payload.model` string across every record, or undefined when none exists. */
function extractModel(records: readonly unknown[]): string | undefined {
  let model: string | undefined;
  for (const record of records) {
    const candidate = getStringField(getPayload(record), 'model');
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
 * Map one `token_count` payload's raw fields to {@link TokenCostUsage}.
 * `input_tokens` may already include the cache reads/writes it reports
 * separately (an inclusive total) or may already exclude them
 * (already-uncached) -- Codex CLI does not flag which. Mirrors the Grok
 * adapter's inclusive-check: when `input_tokens >= cacheRead +
 * cacheCreation`, the total is inclusive, so `inputUncached` is the
 * remainder after subtracting both; otherwise `input_tokens` is already
 * exclusive of cache and is used as `inputUncached` directly.
 */
function usageFromTokenCounts(raw: CodexTokenUsageFields): TokenCostUsage {
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
 * Prefer the latest `token_count` payload's `total_token_usage` snapshot
 * (a cumulative total) when any `token_count` record carries one;
 * otherwise sum every record's `last_token_usage` (per-event deltas). A
 * session with no `token_count` records at all yields all-zero usage,
 * which is a valid, publishable-gate-excluded sample, not an error.
 */
function extractUsage(records: readonly unknown[]): TokenCostUsage {
  const tokenCountPayloads: Record<string, unknown>[] = [];
  for (const record of records) {
    if (isRecordOfType(record, 'token_count')) {
      const payload = getPayload(record);
      if (payload) {
        tokenCountPayloads.push(payload);
      }
    }
  }
  for (let i = tokenCountPayloads.length - 1; i >= 0; i--) {
    const total = getObjectField(tokenCountPayloads[i], 'total_token_usage');
    if (total) {
      return usageFromTokenCounts(total as CodexTokenUsageFields);
    }
  }
  let summed = ZERO_USAGE;
  for (const payload of tokenCountPayloads) {
    const last = getObjectField(payload, 'last_token_usage');
    if (last) {
      summed = addUsage(
        summed,
        usageFromTokenCounts(last as CodexTokenUsageFields),
      );
    }
  }
  return summed;
}

function countCompactions(records: readonly unknown[]): number {
  let count = 0;
  for (const record of records) {
    if (isRecordOfType(record, 'compacted')) {
      count += 1;
    }
  }
  return count;
}

function asCodexHarvestInput(input: unknown): CodexHarvestInput {
  if (!isPlainObject(input) || !Array.isArray(input.records)) {
    throw new Error(
      'token-cost-adapter-codex: harvest input must be { records: unknown[] }',
    );
  }
  const fileBasename =
    typeof input.fileBasename === 'string' ? input.fileBasename : undefined;
  return { records: input.records, fileBasename };
}

/** Codex CLI vendor adapter. `input` must satisfy {@link CodexHarvestInput}. */
export const codexAdapter: TokenCostVendorAdapter = {
  harvest(input: unknown): TokenCostAdapterResult {
    const { records, fileBasename } = asCodexHarvestInput(input);

    const sessionMeta = findRecordByType(records, 'session_meta');
    const vendorSessionId =
      extractSessionId(sessionMeta) ?? deriveFallbackSessionId(fileBasename);
    if (!vendorSessionId) {
      throw new Error(
        'token-cost-adapter-codex: unable to determine a vendorSessionId',
      );
    }

    const timestamps = extractTimestamps(records);
    if (!timestamps) {
      throw new Error(
        'token-cost-adapter-codex: no record has a valid timestamp',
      );
    }

    const cwd = extractSessionCwd(records);
    const issueNumber = cwd
      ? inferIssueNumberFromBasename(basename(cwd))
      : undefined;

    const sample: TokenCostSessionSample = {
      schemaVersion: 1,
      kind: 'session',
      vendor: 'codex',
      model: extractModel(records) ?? 'unknown',
      attribution: 'session-unscoped',
      outcome: 'unknown',
      usage: extractUsage(records),
      compactionCount: countCompactions(records),
      startedAt: timestamps.startedAt,
      endedAt: timestamps.endedAt,
      vendorSessionId,
    };

    const redacted = redactTokenCostRecord(sample) as TokenCostSessionSample;
    assertTokenCostSample(redacted);

    return issueNumber === undefined
      ? { sample: redacted }
      : { sample: redacted, joinHints: { issueNumber } };
  },
};

/** `~/.codex/sessions`, the default rollout root. */
export function defaultCodexSessionsDir(): string {
  return join(homedir(), '.codex', 'sessions');
}

export interface ScanCodexSessionsOptions {
  /** Override the rollout root. Tests must always pass this -- never scan the real home directory. */
  sessionsDir?: string;
}

/**
 * Scan `sessionsDir` (default `~/.codex/sessions`) for
 * `**\/rollout-*.jsonl` files, keep only sessions whose cwd names an
 * idd-skill worktree or clone, and harvest each into a
 * {@link TokenCostAdapterResult}.
 */
export function scanCodexSessions(
  options?: ScanCodexSessionsOptions,
): TokenCostAdapterResult[] {
  const sessionsDir = options?.sessionsDir ?? defaultCodexSessionsDir();
  const files = globSync('**/rollout-*.jsonl', {
    cwd: sessionsDir,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

  const results: TokenCostAdapterResult[] = [];
  for (const file of files) {
    // Read, parse, cwd-filter, and harvest all live inside one try: Codex
    // rotates/deletes rollout files while sessions run, so readFileSync
    // itself can throw (ENOENT/EACCES) between globSync and this line,
    // not only harvest() on malformed content -- either failure must
    // skip just this one file, never abort the whole scan.
    try {
      const records = parseCodexRolloutLines(readFileSync(file, 'utf8'));
      if (!isIddSkillCwd(extractSessionCwd(records))) {
        continue;
      }
      results.push(
        codexAdapter.harvest({
          records,
          fileBasename: basename(file),
        } satisfies CodexHarvestInput),
      );
    } catch {}
  }
  return results;
}
