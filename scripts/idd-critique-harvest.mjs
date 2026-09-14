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
import { parseCliArgs } from './cli-args.mjs';

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
const SEVERITY_KEYS = ['high', 'medium', 'low'];
/**
 * Shared validation for one critique-telemetry JSONL line, parameterized
 * by which contract it must satisfy (#3005 review, Copilot):
 *
 * - `'raw'` ({@link parseCritiqueTelemetryLine}): the hook's own raw
 *   payload, read at harvest time. Tolerates a genuinely absent
 *   `schemaVersion` (the documented hook payload never sends one) and a
 *   genuinely absent `pr` (defaults to `null`), matching the Acceptance
 *   criteria's "record missing an optional field" requirement.
 * - `'harvested'` ({@link parseHarvestedCritiqueTelemetrySample}): an
 *   already-normalized line from this module's own samples file, read
 *   back by the report step. Every field the harvester always writes
 *   must be explicitly present with the exact normalized shape --
 *   reusing the lenient `'raw'` defaults here would silently "repair" a
 *   corrupted or future-schema-drifted already-harvested record instead
 *   of failing closed (#3005 review, Copilot): `schemaVersion` must be
 *   exactly `1`, and `pr` must be present (as a positive integer or
 *   `null`), not merely defaultable from absent.
 *
 * A structurally malformed line (invalid JSON, or a required field with
 * the wrong type or a value the contract cannot express) resolves to
 * `{ error }` rather than throwing in both modes -- the caller decides
 * whether that is fatal (the harvester tolerates it and keeps
 * processing; the report reader's own caller fails closed on it
 * instead).
 *
 * Both modes reject `phase` values other than the literal `'C'`, reject
 * `severityBreakdown` present with a non-object value (only a
 * genuinely absent field defaults to all-zero), reject a present
 * `delegateCommand` when `delegateUsed` is `false` (the documented
 * contract states it is present only when `delegateUsed` is `true`),
 * and enforce the cross-field sanity bound `acceptedCount +
 * rejectedCount <= findingsCount` -- deliberately looser than requiring
 * exact equality, which a partially- or delegate-scored round could
 * legitimately violate.
 */
function parseCritiqueTelemetryRecord(text, mode) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `invalid JSON (${error.message})` };
  }
  if (!isPlainObject(raw)) {
    return { error: 'line is not a JSON object' };
  }
  if (mode === 'harvested') {
    if (raw.schemaVersion !== 1) {
      return { error: 'schemaVersion must be exactly 1' };
    }
  } else if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    // The documented raw hook payload never sends schemaVersion at all,
    // but nothing stops a malformed or future-contract producer from
    // including one -- an explicit value other than 1 signals a
    // contract this harvester does not understand and must not
    // silently reinterpret as version 1 (#3005 review, Codex).
    return { error: 'schemaVersion must be exactly 1 when present' };
  }
  if (raw.phase !== 'C') {
    return { error: "phase must be exactly 'C'" };
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
  if (mode === 'harvested' && raw.pr === undefined) {
    return { error: 'pr must be present (a positive integer or null)' };
  }
  let pr = null;
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
  if (mode === 'harvested' && raw.severityBreakdown === undefined) {
    return { error: 'severityBreakdown must be present' };
  }
  let severityRaw = {};
  if (raw.severityBreakdown !== undefined) {
    if (!isPlainObject(raw.severityBreakdown)) {
      return { error: 'severityBreakdown must be an object when present' };
    }
    severityRaw = raw.severityBreakdown;
  }
  const severityBreakdown = {
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const key of SEVERITY_KEYS) {
    const value = severityRaw[key];
    if (value === undefined) {
      // A genuinely-harvested record always writes all three keys (see
      // the sample construction below), so a harvested-mode record
      // missing one is corrupted, not merely using the raw payload's
      // optional-field leniency -- require it explicitly instead of
      // defaulting (#3005 review, Codex).
      if (mode === 'harvested') {
        return {
          error: `severityBreakdown.${key} must be present`,
        };
      }
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
  let delegateCommand;
  if (raw.delegateCommand !== undefined) {
    if (raw.delegateUsed !== true) {
      return {
        error: 'delegateCommand must not be present when delegateUsed is false',
      };
    }
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
  const sample = {
    schemaVersion: 1,
    phase: 'C',
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
/**
 * Parse and validate one RAW hook-payload JSONL line (harvest time). See
 * {@link parseCritiqueTelemetryRecord}'s `'raw'` mode for the exact
 * contract. A structurally malformed line resolves to `{ error }`
 * rather than throwing -- the harvester must keep processing the rest
 * of the log (Acceptance criteria: "without erroring on a malformed
 * line").
 */
export function parseCritiqueTelemetryLine(text) {
  return parseCritiqueTelemetryRecord(text, 'raw');
}
/**
 * Parse and strictly validate one already-HARVESTED JSONL line (report
 * time), as written by this module's own {@link harvestCritiqueTelemetry}.
 * See {@link parseCritiqueTelemetryRecord}'s `'harvested'` mode for the
 * exact contract; used by idd-critique-report.mts's readCritiqueSamples
 * to fail closed on a corrupted or future-schema-drifted samples file
 * instead of silently normalizing it the way the lenient raw-payload
 * parser above would (#3005 review, Copilot).
 */
export function parseHarvestedCritiqueTelemetrySample(text) {
  return parseCritiqueTelemetryRecord(text, 'harvested');
}
// ---------------------------------------------------------------------------
// Dedup
// ---------------------------------------------------------------------------
/** Canonical (stable-key-order) JSON string, for content-hash dedup keys. */
function canonicalStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value;
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
export function sampleDedupKey(sample) {
  return createHash('sha256').update(canonicalStringify(sample)).digest('hex');
}
function readJsonlLines(path) {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
function readExistingDedupKeys(outPath) {
  const keys = new Set();
  if (!existsSync(outPath)) {
    return keys;
  }
  for (const line of readJsonlLines(outPath)) {
    try {
      const sample = JSON.parse(line);
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
 * file, keeping only records whose own `repo` field matches `repo`
 * (`<owner>/<repo>`, exact string match). The documented log path
 * (`${XDG_STATE_HOME:-$HOME/.local/state}/idd-critique/log.jsonl`) is
 * host-wide, not per-repository, and the hook payload's own `repo`
 * field exists precisely so multiple repositories' telemetry sharing
 * one host can be told apart -- mirroring token-cost-harvest.mts's own
 * required `--repo` scoping (#3005 review, Copilot). A record for a
 * different repository is neither malformed nor a duplicate; it is
 * counted separately as `skippedOtherRepo`.
 *
 * Idempotent: re-running against the same (possibly grown) log never
 * re-appends a sample already present in `outPath` (see
 * {@link sampleDedupKey}). A missing `inPaths` entry is silently
 * skipped -- the hook may not have run yet, or a repository may not
 * configure it at all.
 *
 * Known limitation (#3002 C1 critique): the read-existing-keys-then-
 * append sequence is not atomic across two concurrent invocations
 * against the same `outPath` -- each could miss the other's in-flight
 * write and both append the same record, the same non-atomic shape
 * token-cost-harvest.mts's own local samples file already has. Not
 * hardened further here at the harvest layer: idd-critique-report.mts's
 * own `readCritiqueSamples` deduplicates by the same {@link
 * sampleDedupKey} across every file it reads (#3005 review, Codex and
 * Copilot), so a rare duplicate line never permanently inflates a
 * downstream aggregate even though it can transiently exist in
 * `outPath` between harvest runs.
 */
export function harvestCritiqueTelemetry(inPaths, outPath, repo, options = {}) {
  const counts = {
    read: 0,
    appended: 0,
    skippedDuplicate: 0,
    skippedMalformed: 0,
    skippedOtherRepo: 0,
    malformedDetails: [],
  };
  const seenKeys = readExistingDedupKeys(outPath);
  const toAppend = [];
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
      if (parsed.sample.repo !== repo) {
        counts.skippedOtherRepo += 1;
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
function xdgStateHome() {
  const fromEnv = process.env.XDG_STATE_HOME;
  return fromEnv && fromEnv.length > 0
    ? fromEnv
    : join(homedir(), '.local', 'state');
}
/** Default location of the idd-critique-telemetry consumer's own log (kurone-kito/dotfiles). */
export function defaultLogPath() {
  return join(xdgStateHome(), 'idd-critique', 'log.jsonl');
}
/** Default location of this repository's own harvested samples file. */
export function defaultSamplesPath() {
  return join(xdgStateHome(), 'idd-skill', 'idd-critique', 'samples.jsonl');
}
// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
/** Validates a --repo <owner>/<repo> flag value; null for anything but exactly two non-empty segments. Mirrors token-cost-harvest.mts's own parseRepoFlag. */
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
// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const IDD_CRITIQUE_HARVEST_FLAG_SPEC = {
  '--repo': { type: 'string', default: '' },
  '--in': { type: 'string', multiple: true },
  '--out': { type: 'string', default: '' },
  '--dry-run': { type: 'boolean', default: false },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-critique-harvest.mjs --repo <owner>/<repo> [--in <log.jsonl> ...] [--out <samples.jsonl>] [--dry-run]

  --repo <owner>/<repo>  Repository to keep harvested records for. The
                 documented log path is host-wide, not per-repository,
                 so a record naming a different repo is skipped
                 (skippedOtherRepo), never harvested. Required.
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
  const repoFlag = values.repo;
  const parsedRepo = parseRepoFlag(repoFlag);
  if (!parsedRepo) {
    process.stderr.write(
      repoFlag.trim() === ''
        ? '--repo <owner>/<repo> is required\n'
        : `--repo must be in <owner>/<repo> form, got: ${repoFlag}\n`,
    );
    process.exit(2);
  }
  const repo = `${parsedRepo.owner}/${parsedRepo.repo}`;
  const inPaths = values.in ?? [defaultLogPath()];
  const outPath = values.out || defaultSamplesPath();
  const dryRun = values['dry-run'];
  const counts = harvestCritiqueTelemetry(inPaths, outPath, repo, { dryRun });
  process.stdout.write(
    `idd-critique-harvest: read=${counts.read} appended=${counts.appended} skipped-duplicate=${counts.skippedDuplicate} skipped-other-repo=${counts.skippedOtherRepo} skipped-malformed=${counts.skippedMalformed}${dryRun ? ' (dry-run)' : ` -> ${outPath}`}\n`,
  );
  for (const detail of counts.malformedDetails) {
    process.stderr.write(`idd-critique-harvest: warning: ${detail}\n`);
  }
}
