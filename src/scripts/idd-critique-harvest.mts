#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-critique-harvest.mts
//
// The scripts/idd-critique-harvest.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood harvest CLI (#3002, child of roadmap #3000).
// Reads the local idd-critique JSONL log(s) that the
// kurone-kito/dotfiles-defined `idd-critique-telemetry` consumer appends
// (one line per C-phase round, per docs/idd-workflow.md's
// "Repository-configurable critique telemetry hook" section) and
// normalizes each well-formed line into a CritiqueTelemetrySample
// appended to a local aggregate samples file -- the same
// harvest-into-a-local-samples-file shape token-cost-harvest.mts already
// uses (docs/token-cost.md), but with no GitHub join or vendor-session
// scan: the hook's own JSON payload is already a complete per-round
// record, so this harvester only validates and dedupes it. Never
// registered in HELPER_COMMANDS or distributed to idd-template/ (see
// SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts) -- an adopter repository has
// no critique-loop telemetry log to harvest.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { parseCliArgs } from './cli-args.mts';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** The three severities the hook's own payload contract names (docs/idd-workflow.md). */
export interface CritiqueSeverityBreakdown {
  high: number;
  medium: number;
  low: number;
}

/**
 * One harvested critique-loop telemetry record. Mirrors the JSON payload
 * documented in docs/idd-workflow.md's "Repository-configurable critique
 * telemetry hook" section: this harvester normalizes (never
 * reconstructs) it -- `severityBreakdown`'s three keys always default to
 * `0` when the raw payload omits them, and `schemaVersion` is added for
 * forward compatibility with a future contract revision. `phase` stays a
 * plain `string` (not the literal `'C'`): docs/idd-workflow.md's own E10
 * section already names extending this hook to E10 as a "not-yet-scoped"
 * future change, and narrowing the type now would make that later
 * contract-only change break this file's own compile.
 */
export interface CritiqueTelemetrySample {
  schemaVersion: 1;
  phase: string;
  round: number;
  repo: string;
  issue: number;
  pr: number | null;
  findingsCount: number;
  severityBreakdown: CritiqueSeverityBreakdown;
  acceptedCount: number;
  rejectedCount: number;
  delegateUsed: boolean;
  delegateCommand?: string;
  timestamp: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

const SEVERITY_KEYS = ['high', 'medium', 'low'] as const;

/**
 * Parse and validate one JSONL line against the documented critique
 * telemetry payload contract. A structurally malformed line (invalid
 * JSON, or a required field with the wrong type or a value the contract
 * cannot express) resolves to `{ error }` rather than throwing -- the
 * harvester must keep processing the rest of the log (Acceptance
 * criteria: "without erroring on a malformed line"). An optional field
 * genuinely absent from an otherwise well-formed line is never an error:
 * `pr` normalizes to `null` when omitted, `severityBreakdown`'s three
 * keys each default to `0` when omitted, and `delegateCommand` stays
 * `undefined` when omitted (regardless of `delegateUsed`'s value -- the
 * contract does not promise that pairing strictly, so this validator
 * does not enforce it as fatal).
 *
 * Also enforces one cross-field sanity bound (#3002 B2 critique):
 * `acceptedCount + rejectedCount` must not exceed `findingsCount`. This
 * is deliberately looser than requiring exact equality, which a
 * partially-scored or delegate-scored round could legitimately violate.
 */
export function parseCritiqueTelemetryLine(
  text: string,
): { sample: CritiqueTelemetrySample } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `invalid JSON (${(error as Error).message})` };
  }
  if (!isPlainObject(raw)) {
    return { error: 'line is not a JSON object' };
  }
  if (typeof raw.phase !== 'string' || raw.phase.length === 0) {
    return { error: 'phase must be a non-empty string' };
  }
  if (!isPositiveInteger(raw.round)) {
    return { error: 'round must be a positive integer' };
  }
  if (typeof raw.repo !== 'string' || raw.repo.length === 0) {
    return { error: 'repo must be a non-empty string' };
  }
  if (!isPositiveInteger(raw.issue)) {
    return { error: 'issue must be a positive integer' };
  }
  let pr: number | null = null;
  if (raw.pr !== null && raw.pr !== undefined) {
    if (!isPositiveInteger(raw.pr)) {
      return { error: 'pr must be a positive integer or null' };
    }
    pr = raw.pr;
  }
  if (!isNonNegativeInteger(raw.findingsCount)) {
    return { error: 'findingsCount must be a non-negative integer' };
  }
  if (!isNonNegativeInteger(raw.acceptedCount)) {
    return { error: 'acceptedCount must be a non-negative integer' };
  }
  if (!isNonNegativeInteger(raw.rejectedCount)) {
    return { error: 'rejectedCount must be a non-negative integer' };
  }
  if (raw.acceptedCount + raw.rejectedCount > raw.findingsCount) {
    return {
      error: 'acceptedCount + rejectedCount must not exceed findingsCount',
    };
  }
  const severityRaw: Record<string, unknown> = isPlainObject(
    raw.severityBreakdown,
  )
    ? raw.severityBreakdown
    : {};
  const severityBreakdown: CritiqueSeverityBreakdown = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const key of SEVERITY_KEYS) {
    const value = severityRaw[key];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeInteger(value)) {
      return {
        error: `severityBreakdown.${key} must be a non-negative integer`,
      };
    }
    severityBreakdown[key] = value;
  }
  if (typeof raw.delegateUsed !== 'boolean') {
    return { error: 'delegateUsed must be a boolean' };
  }
  let delegateCommand: string | undefined;
  if (raw.delegateCommand !== undefined) {
    if (
      typeof raw.delegateCommand !== 'string' ||
      raw.delegateCommand.length === 0
    ) {
      return {
        error: 'delegateCommand must be a non-empty string when present',
      };
    }
    delegateCommand = raw.delegateCommand;
  }
  if (
    typeof raw.timestamp !== 'string' ||
    Number.isNaN(Date.parse(raw.timestamp))
  ) {
    return { error: 'timestamp must be a valid ISO8601 string' };
  }

  const sample: CritiqueTelemetrySample = {
    schemaVersion: 1,
    phase: raw.phase,
    round: raw.round,
    repo: raw.repo,
    issue: raw.issue,
    pr,
    findingsCount: raw.findingsCount,
    severityBreakdown,
    acceptedCount: raw.acceptedCount,
    rejectedCount: raw.rejectedCount,
    delegateUsed: raw.delegateUsed,
    timestamp: raw.timestamp,
  };
  if (delegateCommand !== undefined) {
    sample.delegateCommand = delegateCommand;
  }
  return { sample };
}

// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------

/** Canonical (stable-key-order) JSON string, for content-hash dedup keys. */
function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable content-hash dedup key for one harvested sample. #3002 B2
 * critique: a business-key tuple like repo+issue+round+timestamp has no
 * session/attempt discriminator and can collide across two genuinely
 * different records under this repository's own documented concurrent-
 * session load. Hashing the full normalized record instead means only a
 * byte-for-byte-equivalent re-processed line ever collides.
 */
export function sampleDedupKey(sample: CritiqueTelemetrySample): string {
  return createHash('sha256').update(canonicalStringify(sample)).digest('hex');
}

// ---------------------------------------------------------------------------
// Harvest
// ---------------------------------------------------------------------------

export interface HarvestCounts {
  read: number;
  appended: number;
  skippedDuplicate: number;
  skippedMalformed: number;
  malformedDetails: string[];
}

function readJsonlLines(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function readExistingDedupKeys(outPath: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(outPath)) {
    return keys;
  }
  for (const line of readJsonlLines(outPath)) {
    try {
      const sample = JSON.parse(line) as CritiqueTelemetrySample;
      keys.add(sampleDedupKey(sample));
    } catch {
      // A malformed line in the already-harvested output file is not
      // this pass's concern -- skip it for dedup-key purposes only.
    }
  }
  return keys;
}

/**
 * Harvest every `inPaths` JSONL log into `outPath`'s aggregate samples
 * file. Idempotent: re-running against the same (possibly grown) log
 * never re-appends a sample already present in `outPath` (see
 * {@link sampleDedupKey}). A missing `inPaths` entry is silently
 * skipped -- the hook may not have run yet, or a repository may not
 * configure it at all.
 */
export function harvestCritiqueTelemetry(
  inPaths: readonly string[],
  outPath: string,
  options: { dryRun?: boolean } = {},
): HarvestCounts {
  const counts: HarvestCounts = {
    read: 0,
    appended: 0,
    skippedDuplicate: 0,
    skippedMalformed: 0,
    malformedDetails: [],
  };
  const seenKeys = readExistingDedupKeys(outPath);
  const toAppend: string[] = [];
  for (const inPath of inPaths) {
    if (!existsSync(inPath)) {
      continue;
    }
    const lines = readJsonlLines(inPath);
    for (let index = 0; index < lines.length; index++) {
      counts.read += 1;
      const parsed = parseCritiqueTelemetryLine(lines[index]);
      if ('error' in parsed) {
        counts.skippedMalformed += 1;
        counts.malformedDetails.push(`${inPath}:${index + 1}: ${parsed.error}`);
        continue;
      }
      const key = sampleDedupKey(parsed.sample);
      if (seenKeys.has(key)) {
        counts.skippedDuplicate += 1;
        continue;
      }
      seenKeys.add(key);
      toAppend.push(JSON.stringify(parsed.sample));
      counts.appended += 1;
    }
  }
  if (!options.dryRun && toAppend.length > 0) {
    mkdirSync(dirname(outPath), { recursive: true });
    appendFileSync(outPath, `${toAppend.join('\n')}\n`);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

function xdgStateHome(): string {
  const fromEnv = process.env.XDG_STATE_HOME;
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : join(homedir(), '.local', 'state');
}

/** Default location of the idd-critique-telemetry consumer's own log (kurone-kito/dotfiles). */
export function defaultLogPath(): string {
  return join(xdgStateHome(), 'idd-critique', 'log.jsonl');
}

/** Default location of this repository's own harvested samples file. */
export function defaultSamplesPath(): string {
  return join(xdgStateHome(), 'idd-skill', 'idd-critique', 'samples.jsonl');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const IDD_CRITIQUE_HARVEST_FLAG_SPEC = {
  '--in': { type: 'string', multiple: true },
  '--out': { type: 'string', default: '' },
  '--dry-run': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-critique-harvest.mjs [--in <log.jsonl> ...] [--out <samples.jsonl>] [--dry-run]

  --in <path>    Critique-telemetry JSONL log to harvest (repeatable;
                 default: ${defaultLogPath()}).
  --out <path>   Aggregate samples JSONL file to append validated,
                 deduplicated records to (default: ${defaultSamplesPath()}).
  --dry-run      Report counts only; never write --out.
  --help, -h     Show this help.
`);
}

if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    IDD_CRITIQUE_HARVEST_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const inPaths = (values.in as string[] | undefined) ?? [defaultLogPath()];
  const outPath = (values.out as string) || defaultSamplesPath();
  const dryRun = values['dry-run'] as boolean;
  const counts = harvestCritiqueTelemetry(inPaths, outPath, { dryRun });
  process.stdout.write(
    `idd-critique-harvest: read=${counts.read} appended=${counts.appended} skipped-duplicate=${counts.skippedDuplicate} skipped-malformed=${counts.skippedMalformed}${
      dryRun ? ' (dry-run)' : ` -> ${outPath}`
    }\n`,
  );
  for (const detail of counts.malformedDetails) {
    process.stderr.write(`idd-critique-harvest: warning: ${detail}\n`);
  }
}
