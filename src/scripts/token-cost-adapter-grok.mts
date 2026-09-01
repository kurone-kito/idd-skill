// idd-generated-from: src/scripts/token-cost-adapter-grok.mts
//
// The scripts/token-cost-adapter-grok.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
//
// Grok CLI adapter (#2289) for the token-cost measurement contract
// (#2288). Source-repo only: not HELPER_COMMANDS, not idd-template/. A
// pure library module -- no CLI, no shebang, mirroring
// token-cost-core.mts's own shape -- so it needs no HELPER_COMMANDS
// registration or SOURCE_REPO_INTERNAL_ENTRY_PATHS entry.
//
// Reads Grok CLI session directories
// (`~/.grok/sessions/<url-encoded-cwd>/<session-id>/`), each holding
// `updates.jsonl` (the ACP session update stream, where this module
// looks for a per-update `usage` snapshot), an optional `signals.json`
// (session rollup: `compactionCount`, `toolCallCount`, `modelsUsed`),
// and an optional `events.jsonl` (compaction/turn records, used only
// as the `compactionCount` fallback when `signals.json` is missing or
// carries no usable count). `signals.json`'s `contextTokensUsed` is a
// context-window metric, not a billed-usage figure `TokenCostUsage`
// has a field for, and is deliberately left unread here. This module
// documents the specific record shapes it reads as local structural
// types; only the fields actually consumed are declared, and every
// extraction degrades gracefully (never throws) except when the
// harvested session has no usable timestamp or no derivable
// vendorSessionId, either of which fails closed as a malformed
// session.

import { readdirSync, readFileSync } from 'node:fs';
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

/** Raw token-usage fields a Grok updates.jsonl record's `usage` snapshot reports. */
interface GrokTokenUsageFields {
  inputTokens?: unknown;
  cachedReadTokens?: unknown;
  cacheCreationTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
}

/** Grok session harvest input: one session's parsed files, plus its subagents' updates.jsonl records (already parsed, never raw text -- this module never reads a filesystem path itself). */
export interface GrokHarvestInput {
  /** Parsed updates.jsonl records, in file order. */
  updateRecords: readonly unknown[];
  /** Parsed signals.json content, when the file exists. */
  signals?: unknown;
  /** Parsed events.jsonl records, when the file exists. */
  eventRecords?: readonly unknown[];
  /** The `<session-id>` directory basename -- last-resort vendorSessionId fallback. */
  sessionIdBasename?: string;
  /** The session's URL-decoded working directory, when known -- the scanner derives this from the `<url-encoded-cwd>` directory-tree segment. */
  cwd?: string;
  /** Each subagent session's own parsed updates.jsonl records, rolled into this sample's usage total. */
  subagentUpdateRecords?: readonly (readonly unknown[])[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getUsage(record: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(record)) {
    return undefined;
  }
  const usage = record.usage;
  return isPlainObject(usage) ? usage : undefined;
}

/** Parse a Grok session JSONL file's text into raw, untyped records, tolerating a malformed or truncated trailing line from an interrupted process (unlike token-cost-report.mts's committed-artifact strict parse, this reads real local logs outside this repo's control). */
export function parseGrokSessionLines(text: string): unknown[] {
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

/** Whether a session's cwd names an idd-skill worktree or clone. */
export function isIddSkillCwd(cwd: string | undefined): boolean {
  return typeof cwd === 'string' && cwd.includes('idd-skill');
}

/** The first non-empty top-level `sessionId` across `records`, in file order. */
function extractSessionId(records: readonly unknown[]): string | undefined {
  for (const record of records) {
    const id = isPlainObject(record)
      ? getStringField(record, 'sessionId')
      : undefined;
    if (id) {
      return id;
    }
  }
  return undefined;
}

/**
 * Normalizes with `path.basename()` first (never trusts a caller's
 * `sessionIdBasename` to already be path-free) so a full path passed in
 * by mistake can't survive into a path-like fallback `vendorSessionId`
 * that `redactTokenCostRecord()` would later strip to `undefined`,
 * silently producing a schema-invalid sample instead of failing closed.
 */
function deriveFallbackSessionId(
  sessionIdBasename: string | undefined,
): string | undefined {
  if (!sessionIdBasename) {
    return undefined;
  }
  const stripped = basename(sessionIdBasename);
  return stripped.length > 0 ? stripped : undefined;
}

/** The first non-empty top-level `cwd` across `records`, in file order -- a fallback for when the caller has no directory-derived cwd to pass in. */
function extractCwdFromRecords(
  records: readonly unknown[],
): string | undefined {
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

/** Most recently reported `model` string across every record, or undefined when none exists. */
function extractModelFromRecords(
  records: readonly unknown[],
): string | undefined {
  let model: string | undefined;
  for (const record of records) {
    const candidate = isPlainObject(record)
      ? getStringField(record, 'model')
      : undefined;
    if (candidate) {
      model = candidate;
    }
  }
  return model;
}

/** The last entry of `signals.modelsUsed`, when it is a non-empty array of strings. */
function extractModelFromSignals(signals: unknown): string | undefined {
  if (!isPlainObject(signals) || !Array.isArray(signals.modelsUsed)) {
    return undefined;
  }
  for (let i = signals.modelsUsed.length - 1; i >= 0; i--) {
    const candidate = signals.modelsUsed[i];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
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
 * Map one `usage` snapshot's raw fields to {@link TokenCostUsage}.
 * `inputTokens` may already include the cache reads/writes it reports
 * separately (an inclusive total) or may already exclude them
 * (already-uncached) -- Grok does not flag which. Mirrors the Codex
 * adapter's inclusive-check: when `inputTokens >= cachedReadTokens +
 * cacheCreationTokens`, the total is inclusive, so `inputUncached` is
 * the remainder after subtracting both; otherwise `inputTokens` is
 * already exclusive of cache and is used as `inputUncached` directly.
 * Kept in this one function (per fixture-per-shape, #2218's own lesson
 * on regex precision applies equally to arithmetic: verify both shapes
 * with a dedicated fixture rather than assuming one).
 */
function usageFromFields(raw: GrokTokenUsageFields): TokenCostUsage {
  const inputTokens = toNonNegativeInt(raw.inputTokens);
  const cacheRead = toNonNegativeInt(raw.cachedReadTokens);
  const cacheCreation = toNonNegativeInt(raw.cacheCreationTokens);
  const inputUncached =
    inputTokens >= cacheRead + cacheCreation
      ? inputTokens - cacheRead - cacheCreation
      : inputTokens;
  return {
    inputUncached,
    cacheRead,
    cacheCreation,
    output: toNonNegativeInt(raw.outputTokens),
    reasoning: toNonNegativeInt(raw.reasoningTokens),
  };
}

/** The last `usage` snapshot found across `records`, in file order -- treated as the session's cumulative running total, mirroring how Grok's own TUI reports a running token count. Undefined when no record carries one. */
function extractLatestUsage(
  records: readonly unknown[],
): TokenCostUsage | undefined {
  let latest: TokenCostUsage | undefined;
  for (const record of records) {
    const usage = getUsage(record);
    if (usage) {
      latest = usageFromFields(usage as GrokTokenUsageFields);
    }
  }
  return latest;
}

/** `signals.compactionCount`, when it is present and a finite number. */
function extractCompactionCountFromSignals(
  signals: unknown,
): number | undefined {
  if (!isPlainObject(signals)) {
    return undefined;
  }
  const value = signals.compactionCount;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

/** A record whose `type` field names a compaction, matched by substring (case-insensitive) so a future vendor-added variant still counts without an enum update here. */
function isCompactionEventRecord(record: unknown): boolean {
  if (!isPlainObject(record)) {
    return false;
  }
  const type = getStringField(record, 'type');
  return type !== undefined && /compact/i.test(type);
}

/** `signals.compactionCount` when present; otherwise counts compaction-named `eventRecords` (some short sessions have no `signals.json`). */
function extractCompactionCount(
  signals: unknown,
  eventRecords: readonly unknown[],
): number {
  const fromSignals = extractCompactionCountFromSignals(signals);
  if (fromSignals !== undefined) {
    return fromSignals;
  }
  let count = 0;
  for (const record of eventRecords) {
    if (isCompactionEventRecord(record)) {
      count += 1;
    }
  }
  return count;
}

/** `signals.toolCallCount`, when it is present and a finite number. */
function extractToolCallCount(signals: unknown): number | undefined {
  if (!isPlainObject(signals)) {
    return undefined;
  }
  const value = signals.toolCallCount;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function asGrokHarvestInput(input: unknown): GrokHarvestInput {
  if (!isPlainObject(input) || !Array.isArray(input.updateRecords)) {
    throw new Error(
      'token-cost-adapter-grok: harvest input must be { updateRecords: unknown[] }',
    );
  }
  return {
    updateRecords: input.updateRecords,
    signals: input.signals,
    eventRecords: Array.isArray(input.eventRecords)
      ? input.eventRecords
      : undefined,
    sessionIdBasename:
      typeof input.sessionIdBasename === 'string'
        ? input.sessionIdBasename
        : undefined,
    cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
    subagentUpdateRecords: Array.isArray(input.subagentUpdateRecords)
      ? (input.subagentUpdateRecords as readonly (readonly unknown[])[])
      : undefined,
  };
}

/** Grok CLI vendor adapter. `input` must satisfy {@link GrokHarvestInput}. */
export const grokAdapter: TokenCostVendorAdapter = {
  harvest(input: unknown): TokenCostAdapterResult {
    const {
      updateRecords,
      signals,
      eventRecords = [],
      sessionIdBasename,
      cwd: providedCwd,
      subagentUpdateRecords = [],
    } = asGrokHarvestInput(input);

    const vendorSessionId =
      extractSessionId(updateRecords) ??
      deriveFallbackSessionId(sessionIdBasename);
    if (!vendorSessionId) {
      throw new Error(
        'token-cost-adapter-grok: unable to determine a vendorSessionId',
      );
    }

    const timestamps = extractTimestamps(updateRecords);
    if (!timestamps) {
      throw new Error(
        'token-cost-adapter-grok: no record has a valid timestamp',
      );
    }

    const cwd = providedCwd ?? extractCwdFromRecords(updateRecords);
    const issueNumber = cwd
      ? inferIssueNumberFromBasename(basename(cwd))
      : undefined;

    let usage = extractLatestUsage(updateRecords) ?? ZERO_USAGE;
    for (const subagentRecords of subagentUpdateRecords) {
      const subagentUsage = extractLatestUsage(subagentRecords);
      if (subagentUsage) {
        usage = addUsage(usage, subagentUsage);
      }
    }

    const sample: TokenCostSessionSample = {
      schemaVersion: 1,
      kind: 'session',
      vendor: 'grok',
      model:
        extractModelFromSignals(signals) ??
        extractModelFromRecords(updateRecords) ??
        'unknown',
      attribution: 'session-unscoped',
      outcome: 'unknown',
      usage,
      compactionCount: extractCompactionCount(signals, eventRecords),
      startedAt: timestamps.startedAt,
      endedAt: timestamps.endedAt,
      vendorSessionId,
      toolCallCount: extractToolCallCount(signals),
      includesSubagents: subagentUpdateRecords.length > 0,
    };

    const redacted = redactTokenCostRecord(sample) as TokenCostSessionSample;
    // assertTokenCostSample does not check vendorSessionId (it is outside
    // that function's cross-field-constraint scope), and redaction can, in
    // principle, strip a vendorSessionId value that happens to look like a
    // path or a secret -- which would silently omit the key rather than
    // producing a visibly invalid sample. Fail closed instead of returning
    // a schema-invalid result with a missing required field (CodeRabbit
    // review, #2289).
    if (!redacted.vendorSessionId) {
      throw new Error(
        'token-cost-adapter-grok: redaction removed vendorSessionId',
      );
    }
    assertTokenCostSample(redacted);

    return issueNumber === undefined
      ? { sample: redacted }
      : { sample: redacted, joinHints: { issueNumber } };
  },
};

/** `~/.grok/sessions`, the default session root. */
export function defaultGrokSessionsDir(): string {
  return join(homedir(), '.grok', 'sessions');
}

/**
 * Decodes one `~/.grok/sessions/<url-encoded-cwd>` directory-tree
 * segment back to the working-directory path it names ("organized by
 * URL-encoded working directory", per Grok CLI's own session-persistence
 * documentation). Returns the raw segment unchanged if it is not valid
 * percent-encoding, rather than throwing.
 */
export function decodeGrokEncodedCwd(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function readJsonlIfPresent(path: string): unknown[] {
  try {
    return parseGrokSessionLines(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

function readJsonIfPresent(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function listSubdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Each subagent session directory's own `updates.jsonl`, parsed, when a `subagents/` subdirectory exists under `sessionDir`. */
function readSubagentUpdateRecords(sessionDir: string): unknown[][] {
  const subagentsDir = join(sessionDir, 'subagents');
  const out: unknown[][] = [];
  for (const subagentId of listSubdirNames(subagentsDir)) {
    const records = readJsonlIfPresent(
      join(subagentsDir, subagentId, 'updates.jsonl'),
    );
    if (records.length > 0) {
      out.push(records);
    }
  }
  return out;
}

export interface ScanGrokSessionsOptions {
  /** Override the session root. Tests must always pass this -- never scan the real home directory. */
  sessionsDir?: string;
}

/**
 * Scan `sessionsDir` (default `~/.grok/sessions`) for
 * `<url-encoded-cwd>/<session-id>/` session directories, keep only
 * sessions whose decoded cwd names an idd-skill worktree or clone, roll
 * each session's own `subagents/*\/updates.jsonl` into its parent, and
 * harvest each into a {@link TokenCostAdapterResult}.
 */
export function scanGrokSessions(
  options?: ScanGrokSessionsOptions,
): TokenCostAdapterResult[] {
  const sessionsDir = options?.sessionsDir ?? defaultGrokSessionsDir();
  const results: TokenCostAdapterResult[] = [];

  for (const encodedCwd of listSubdirNames(sessionsDir)) {
    const cwd = decodeGrokEncodedCwd(encodedCwd);
    if (!isIddSkillCwd(cwd)) {
      continue;
    }
    const cwdDir = join(sessionsDir, encodedCwd);
    for (const sessionId of listSubdirNames(cwdDir)) {
      // Read, parse, and harvest all live inside one try: a live Grok
      // session can still be writing (or an unrelated process can delete)
      // a session file between listSubdirNames and this line, and
      // harvest() itself throws on a malformed session (no usable
      // timestamp/vendorSessionId) -- either failure must skip just this
      // one session, never abort the whole scan.
      try {
        const sessionDir = join(cwdDir, sessionId);
        const updateRecords = readJsonlIfPresent(
          join(sessionDir, 'updates.jsonl'),
        );
        const signals = readJsonIfPresent(join(sessionDir, 'signals.json'));
        const eventRecords = readJsonlIfPresent(
          join(sessionDir, 'events.jsonl'),
        );
        const subagentUpdateRecords = readSubagentUpdateRecords(sessionDir);
        results.push(
          grokAdapter.harvest({
            updateRecords,
            signals,
            eventRecords,
            sessionIdBasename: sessionId,
            cwd,
            subagentUpdateRecords,
          } satisfies GrokHarvestInput),
        );
      } catch {}
    }
  }
  return results;
}
