#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-worker-report.mts
//
// The scripts/idd-worker-report.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Local store for a worker's final report (issue #3836, roadmap #3834). An
// orchestrator that disposes of each worker once its outcome is verified
// loses whatever the worker did not post to its issue or pull request: how
// many review rounds it ran, where it stalled, where it left the documented
// procedure, which instruction text caused friction, and which follow-up
// issues it filed. `append` validates one record against
// `schemas/worker-report.schema.json` and appends it as one JSONL line under
// the per-user state root; `summary` reads the store back. Nothing is ever
// posted to GitHub, and this helper makes no `gh` call.
//
// Concurrency: the duplicate check and the write happen together under an
// exclusive lock file next to the store (`O_EXCL`). A holder that dies leaves
// a lock that goes stale after `LOCK_STALE_MS` and is taken over by a waiter:
// the waiter renames the lock aside, confirms the moved file is the very lock
// it judged stale (same inode, modification time, and token), and puts a
// fresh lock back when it is not. The holder also refreshes the lock's age
// before it reads the store and about every `LOCK_REFRESH_MS` between lines
// while it scans them, so a slow scan of a large store does not age it out.
// The read of the file, the split into lines, and the parse of one very long
// line cannot be interrupted, so they must finish within the stale age.
// Residual risks: between the rename and the restore another writer can
// create a lock, and a process suspended for longer than
// `LOCK_STALE_MS` can wake up after its lock was taken over. Either way two
// writers hold the lock at once; the line is a single `O_APPEND` write, so the
// worst outcome is a duplicate row, never a torn line. Two bounded delays:
// a holder that releases while its lock is parked aside finds nothing to
// remove, so the restored lock lingers until it ages out (at most
// `LOCK_STALE_MS`, below the acquire timeout); and on a filesystem whose inode
// changes across a rename, every takeover mismatches and a waiter times out
// with "could not acquire the lock" instead of proceeding.

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';
import { parseCliArgs } from './cli-args.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { loadJson, validate } from './validate-schemas.mts';

const SCHEMA_PATH = 'schemas/worker-report.schema.json';

// Loaded once: `summary` validates every stored line.
let cachedSchema: unknown;

/** A lock older than this is treated as left behind by a dead holder. */
const LOCK_STALE_MS = 5_000;
/** How often the duplicate scan renews the lock (at most a fifth of the stale age). */
const LOCK_REFRESH_MS = 1_000;
/** Longer than the stale age, so one dead holder never fails every append. */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
/**
 * Errors from the exclusive create that mean another process holds the lock
 * (or, on Windows, is still deleting the previous one), so the loop retries
 * within its deadline. Anything else is a real failure and is thrown.
 */
const RETRYABLE_OPEN_CODES: ReadonlySet<string> = new Set(
  process.platform === 'win32'
    ? ['EEXIST', 'EPERM', 'EACCES', 'EBUSY']
    : ['EEXIST'],
);
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
/** RFC 3339 date-time with an offset, captured by component. */
const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** How many `frictions[].file` values `summary` lists. */
const FRICTION_FILE_LIMIT = 10;

const OUTCOMES = [
  'merged',
  'handed-off',
  'held',
  'abandoned',
  'failed',
] as const;

export type WorkerReportOutcome = (typeof OUTCOMES)[number];

export type WorkerReportHarness =
  | 'claude-code'
  | 'codex-cli'
  | 'opencode'
  | 'grok-build'
  | 'cursor-cli'
  | 'copilot-cli'
  | 'antigravity-cli'
  | 'other';

/** One `stalls` or `deviations` entry. */
export interface WorkerReportNote {
  phase: string;
  summary: string;
}

/** One `frictions` entry: a note that may name the instruction or doc path. */
export interface WorkerReportFriction extends WorkerReportNote {
  file?: string;
}

/** One line of the worker-report store (`schemas/worker-report.schema.json`). */
export interface WorkerReport {
  schemaVersion: 1;
  /** `owner/repo#number`. */
  issue: string;
  /** `owner/repo#number`, or `null` when the worker opened no pull request. */
  pullRequest: string | null;
  claimId: string;
  harness: WorkerReportHarness;
  workerHandle: string;
  /** The last phase the worker completed, such as `F4` or the canonical `F2_5`. */
  terminalPhase: string;
  outcome: WorkerReportOutcome;
  verifiedAt: string;
  recordedAt: string;
  vendorSessionId?: string | null;
  reviewRounds?: number;
  stalls?: WorkerReportNote[];
  deviations?: WorkerReportNote[];
  frictions?: WorkerReportFriction[];
  followUps?: string[];
}

export interface AppendResult {
  status: 'appended' | 'duplicate';
  store: string;
}

export interface WorkerReportSummary {
  store: string;
  since: string | null;
  total: number;
  /** Lines that were not valid JSON or did not match the schema. */
  invalidLines: number;
  outcomes: Record<WorkerReportOutcome, number>;
  reviewRounds: {
    /** Reports that carry `reviewRounds`. */
    recorded: number;
    /** Report count by round count, ascending by round. */
    distribution: Record<string, number>;
  };
  frictionFiles: { file: string; count: number }[];
}

interface LockOptions {
  staleMs: number;
  timeoutMs: number;
  retryMs: number;
}

const DEFAULT_LOCK_OPTIONS: LockOptions = {
  staleMs: LOCK_STALE_MS,
  timeoutMs: LOCK_ACQUIRE_TIMEOUT_MS,
  retryMs: LOCK_RETRY_MS,
};

// Flag-spec keys stay the dashed literal on purpose: the flag-name checks scan
// this file's compiled .mjs source text for quoted flag literals. Declared
// above the import.meta.main trigger so it is initialized when runCli() runs.
const WORKER_REPORT_FLAG_SPEC = {
  '--file': { type: 'string' },
  '--stdin': { type: 'boolean', default: false },
  '--since': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('idd-worker-report', runCli);
  } else {
    applyHelperCliOutcomeWhenDisabled(runCli());
  }
}

// ---------------------------------------------------------------------------
// State root and store path
// ---------------------------------------------------------------------------

/**
 * Per-user state base, resolved like `defaultLoadControlDirectory` in
 * `github-api-load-control.mts`: an absolute `XDG_STATE_HOME`, else
 * `~/.local/state`; on Windows an absolute `LOCALAPPDATA`, else
 * `~/AppData/Local`. A relative value is ignored, because it would resolve
 * against each caller's working directory and split the store across
 * worktrees. Kept as its own copy so this helper does not pull the
 * 1400-line load-control module into a vendored bundle; a test pins the two
 * to the same base.
 */
// audit:ignore-dead-export: reached in production through resolveWorkerReportStore; exported so the platform cases are unit-tested (issue #3836)
export function resolveStateBase(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  const absolute = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    return pathApi.isAbsolute(trimmed) ? trimmed : undefined;
  };
  if (platform === 'win32') {
    return (
      absolute(env.LOCALAPPDATA) ?? pathApi.join(homeDir, 'AppData', 'Local')
    );
  }
  return (
    absolute(env.XDG_STATE_HOME) ?? pathApi.join(homeDir, '.local', 'state')
  );
}

/** `<state base>/idd-skill/worker-reports/reports.jsonl`. */
// audit:ignore-dead-export: reached in production through runCli; exported so the path is unit-tested (issue #3836)
export function resolveWorkerReportStore(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = homedir(),
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  return pathApi.join(
    resolveStateBase(env, platform, homeDir),
    'idd-skill',
    'worker-reports',
    'reports.jsonl',
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * True when `value` is an RFC 3339 date-time with an offset that names a real
 * instant: month 1-12, a day that exists in that month and year, hour 0-23,
 * minute and second 0-59, and an offset within 23:59. The schema validator's
 * `date-time` format only asks `Date.parse`, which normalizes `02-30` to
 * March 2 and `T24:00:00` to the next day, so the record would otherwise be
 * stored under a different instant than the one written.
 */
function isRealTimestamp(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (
    match[7] !== undefined &&
    (Number(match[7]) > 23 || Number(match[8]) > 59)
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Schema errors for one candidate record; an empty list means valid. */
export function validateWorkerReport(record: unknown): string[] {
  cachedSchema ??= loadJson(SCHEMA_PATH);
  const errors = validate(record, cachedSchema);
  for (const field of ['verifiedAt', 'recordedAt'] as const) {
    const value = (record as Record<string, unknown> | null)?.[field];
    if (
      typeof value === 'string' &&
      !errors.some((error) => error.startsWith(`$.${field}:`)) &&
      !isRealTimestamp(value)
    ) {
      errors.push(`$.${field}: "${value}" is not a real calendar date-time`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The token a lock file carries: `undefined` when there is no file, `''` when
 * the body is empty or garbled (a holder that died between creating the file
 * and writing it), otherwise the holder's token.
 */
function readLockToken(lockPath: string): string | undefined {
  try {
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      token?: unknown;
    };
    return typeof body.token === 'string' ? body.token : '';
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? undefined : '';
  }
}

interface LockObservation {
  /** Inode, modification time, and token: distinguishes a fresh lock. */
  identity: string;
  stale: boolean;
}

/**
 * Inspect the lock (one stat, then one read of its body): its identity and
 * whether it is older than `staleMs`. If the lock is replaced between the two
 * calls the identity mixes both files, which can only cause a mismatch.
 * `undefined` when there is no lock. An unidentifiable body (empty or
 * garbled) still has an inode and a modification time, so a fresh lock never
 * shares its identity with a stale one.
 */
// audit:ignore-dead-export: reached in production through acquireLock; exported so the takeover cases are unit-tested (issue #3836)
export function observeLock(
  lockPath: string,
  staleMs: number,
): LockObservation | undefined {
  try {
    const stats = statSync(lockPath);
    return {
      identity: `${stats.ino}:${stats.mtimeMs}:${readLockToken(lockPath) ?? ''}`,
      stale: Date.now() - stats.mtimeMs > staleMs,
    };
  } catch {
    return undefined;
  }
}

/**
 * Put a lock that was moved aside by mistake back. A hard link cannot
 * clobber, so `EEXIST` means a newer lock exists and is left alone; on a
 * filesystem without hard links, fall back to an exclusive copy.
 */
function restoreLock(from: string, to: string): void {
  try {
    linkSync(from, to);
    return;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return;
  }
  try {
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  } catch {
    // Either a newer lock exists, or nothing can restore this one; the
    // stale-age takeover covers whatever is left.
  }
}

/**
 * Move the stale lock aside, then delete it, but only if what was moved is the
 * lock the caller judged stale (`identity` from `observeLock`). The lock can be
 * released and a fresh one created between the staleness check and the
 * rename; renaming would then steal a live lock, so a mismatch puts the moved
 * file back and reports failure. Only one waiter's rename can succeed.
 * Returns true when the lock is gone, false when it is still in the way, so
 * the caller falls back to the bounded wait instead of spinning.
 */
// audit:ignore-dead-export: reached in production through acquireLock; exported so the ownership-mismatch case is unit-tested (issue #3836)
export function takeOverLock(lockPath: string, identity: string): boolean {
  const graveyard = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, graveyard);
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
  if (observeLock(graveyard, 0)?.identity !== identity) {
    restoreLock(graveyard, lockPath);
    try {
      unlinkSync(graveyard);
    } catch {
      // A leftover graveyard file is harmless.
    }
    return false;
  }
  try {
    unlinkSync(graveyard);
  } catch {
    // A leftover graveyard file is harmless; the next takeover uses a new name.
  }
  return true;
}

/** Keep the lock's age young while its holder works (best effort). */
function refreshLock(lockPath: string): void {
  try {
    const now = new Date();
    utimesSync(lockPath, now, now);
  } catch {
    // Best effort: a failed refresh only shortens the effective stale age.
  }
}

/** Create the lock exclusively; returns the token that proves ownership. */
function acquireLock(lockPath: string, options: LockOptions): string {
  const token = randomUUID();
  const deadline = Date.now() + options.timeoutMs;
  let lastCode = 'EEXIST';
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', FILE_MODE);
    } catch (error) {
      lastCode = errorCode(error) ?? '';
      if (!RETRYABLE_OPEN_CODES.has(lastCode)) throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            token,
            createdAt: new Date().toISOString(),
          }),
        );
      } catch (error) {
        // Do not leave an empty lock that blocks every other writer.
        try {
          closeSync(fd);
        } catch {
          // The lock removal below is what matters.
        }
        try {
          unlinkSync(lockPath);
        } catch {
          // The stale-age takeover covers anything left behind.
        }
        throw error;
      }
      closeSync(fd);
      return token;
    }
    const seen = observeLock(lockPath, options.staleMs);
    if (seen?.stale && takeOverLock(lockPath, seen.identity)) {
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not acquire the lock ${lockPath} within ${options.timeoutMs} ms (last error ${lastCode})`,
      );
    }
    sleepSync(options.retryMs);
  }
}

/** Remove the lock only while it is still ours. */
function releaseLock(lockPath: string, token: string): void {
  try {
    const body = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      token?: unknown;
    };
    if (body.token !== token) return;
    unlinkSync(lockPath);
  } catch (error) {
    // Already gone, replaced, or briefly held open by another process on
    // Windows: the stale-age takeover covers anything left behind.
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'EPERM' || code === 'EBUSY') return;
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function duplicateKey(record: {
  claimId?: unknown;
  workerHandle?: unknown;
  terminalPhase?: unknown;
}): string {
  return JSON.stringify([
    record.claimId,
    record.workerHandle,
    record.terminalPhase,
  ]);
}

/**
 * `mkdirSync` and `appendFileSync` apply their mode only when they create the
 * entry, so a directory or store that already exists keeps its old mode. On
 * POSIX, tighten one that grants group or world access (the records can hold
 * session ids and free-form friction text) and refuse one owned by another
 * user. On Windows the per-user profile's access control applies instead.
 */
function ensurePrivate(path: string, mode: number): void {
  if (process.platform === 'win32') return;
  const stats = statSync(path);
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error(
      `refusing to use ${path}: it is owned by another user (point XDG_STATE_HOME at a directory you own)`,
    );
  }
  if ((stats.mode & 0o077) !== 0) {
    try {
      chmodSync(path, mode);
    } catch (error) {
      throw new Error(
        `cannot restrict ${path} to mode ${mode.toString(8)}: ${(error as Error).message} (set the mode by hand or point XDG_STATE_HOME elsewhere)`,
      );
    }
  }
}

function readStore(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return '';
    throw error;
  }
}

function parseLines(content: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      parsed.push(undefined);
    }
  }
  return parsed;
}

/**
 * True when a stored line carries the duplicate key `wanted`. Lines that are
 * not valid JSON are skipped. `refresh` renews the lock's lease every
 * `intervalMs` so a slow scan of a large store cannot let it go stale while
 * this writer still holds it.
 */
// audit:ignore-dead-export: reached in production through appendWorkerReport; exported so the lease renewal is unit-tested with a fake clock (issue #3836)
export function hasDuplicate(
  content: string,
  wanted: string,
  refresh: () => void,
  now: () => number = Date.now,
  intervalMs: number = LOCK_REFRESH_MS,
): boolean {
  let renewedAt = now();
  for (const line of content.split('\n')) {
    if (now() - renewedAt >= intervalMs) {
      refresh();
      renewedAt = now();
    }
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      duplicateKey(parsed as Partial<WorkerReport>) === wanted
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validate `record`, then append it as one line unless a line with the same
 * `claimId`, `workerHandle` and `terminalPhase` already exists. Throws
 * (writing nothing and creating no directory) when the record is invalid.
 * The caller's record is stored verbatim: nothing is stamped or rewritten.
 */
export function appendWorkerReport(
  file: string,
  record: unknown,
  lockOptions: Partial<LockOptions> = {},
): AppendResult {
  const errors = validateWorkerReport(record);
  if (errors.length > 0) {
    throw markCliUsageError(
      new Error(`record fails schema validation: ${errors.join('; ')}`),
    );
  }
  const options = { ...DEFAULT_LOCK_OPTIONS, ...lockOptions };
  mkdirSync(dirname(file), {
    recursive: true,
    mode: DIRECTORY_MODE,
  });
  ensurePrivate(dirname(file), DIRECTORY_MODE);
  const lockPath = `${file}.lock`;
  const token = acquireLock(lockPath, options);
  try {
    refreshLock(lockPath);
    const content = readStore(file);
    if (existsSync(file)) ensurePrivate(file, FILE_MODE);
    refreshLock(lockPath);
    const wanted = duplicateKey(record as WorkerReport);
    const renewEveryMs = Math.min(
      LOCK_REFRESH_MS,
      Math.max(1, Math.floor(options.staleMs / 5)),
    );
    if (
      hasDuplicate(
        content,
        wanted,
        () => refreshLock(lockPath),
        Date.now,
        renewEveryMs,
      )
    ) {
      return { status: 'duplicate', store: file };
    }
    // A writer that died mid-line leaves no trailing newline; start a fresh
    // line so the new record is not glued onto the torn one.
    const prefix = content !== '' && !content.endsWith('\n') ? '\n' : '';
    appendFileSync(file, `${prefix}${JSON.stringify(record)}\n`, {
      mode: FILE_MODE,
    });
    return { status: 'appended', store: file };
  } finally {
    releaseLock(lockPath, token);
  }
}

/** Counts over the store; read-only, never takes the lock or creates a path. */
export function summarizeWorkerReports(
  file: string,
  since: string | null = null,
): WorkerReportSummary {
  const sinceMs = since === null ? null : Date.parse(since);
  const outcomes = Object.fromEntries(
    OUTCOMES.map((outcome) => [outcome, 0]),
  ) as Record<WorkerReportOutcome, number>;
  const rounds = new Map<number, number>();
  const frictionFiles = new Map<string, number>();
  let total = 0;
  let invalidLines = 0;
  let recorded = 0;
  for (const entry of parseLines(readStore(file))) {
    if (entry === undefined || validateWorkerReport(entry).length > 0) {
      invalidLines += 1;
      continue;
    }
    const report = entry as WorkerReport;
    if (sinceMs !== null && Date.parse(report.recordedAt) < sinceMs) continue;
    total += 1;
    outcomes[report.outcome] += 1;
    if (report.reviewRounds !== undefined) {
      recorded += 1;
      rounds.set(
        report.reviewRounds,
        (rounds.get(report.reviewRounds) ?? 0) + 1,
      );
    }
    for (const friction of report.frictions ?? []) {
      if (friction.file === undefined) continue;
      frictionFiles.set(
        friction.file,
        (frictionFiles.get(friction.file) ?? 0) + 1,
      );
    }
  }
  const distribution: Record<string, number> = {};
  for (const round of [...rounds.keys()].sort((a, b) => a - b)) {
    distribution[String(round)] = rounds.get(round) ?? 0;
  }
  return {
    store: file,
    since,
    total,
    invalidLines,
    outcomes,
    reviewRounds: { recorded, distribution },
    frictionFiles: [...frictionFiles.entries()]
      .map(([path, count]) => ({ file: path, count }))
      .sort(
        (a, b) =>
          b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0),
      )
      .slice(0, FRICTION_FILE_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readRecordInput(file: string | undefined, stdin: boolean): unknown {
  let text: string;
  try {
    text = stdin
      ? readFileSync(0, 'utf8')
      : readFileSync(file as string, 'utf8');
  } catch (error) {
    throw markCliUsageError(
      new Error(
        `cannot read the record from ${stdin ? 'stdin' : (file as string)}: ${(error as Error).message}`,
      ),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw markCliUsageError(
      new Error('the record is not valid JSON (expected one JSON object)'),
    );
  }
}

function isModeWord(token: string): boolean {
  return token === 'append' || token === 'summary';
}

function runCli(): HelperCliResult {
  const argv = process.argv.slice(2);
  const first = argv[0];
  if (first === undefined) {
    throw markCliUsageError(
      new Error('a mode is required: append or summary (see --help)'),
    );
  }
  // A leading flag (including --help and any unknown one) goes straight to
  // the shared parser; otherwise the first token is the mode word.
  const modeWord = first.startsWith('-') ? undefined : first;
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(
      modeWord === undefined ? argv : argv.slice(1),
      WORKER_REPORT_FLAG_SPEC,
    );
  } catch (error) {
    const late = modeWord === undefined ? argv.find(isModeWord) : undefined;
    if (
      late !== undefined &&
      (error as Error).message === `unknown argument: ${late}`
    ) {
      throw markCliUsageError(
        new Error(`put the mode word first: ${late} [flags]`),
      );
    }
    throw error;
  }
  const { values, help } = parsed;
  if (help) {
    printHelp();
    return 0;
  }
  if (modeWord === undefined) {
    throw markCliUsageError(
      new Error('a mode is required before any flag: append or summary'),
    );
  }
  const file = typeof values.file === 'string' ? values.file : undefined;
  const stdin = values.stdin === true;
  const since = typeof values.since === 'string' ? values.since : undefined;
  if (modeWord === 'append') {
    if (since !== undefined) {
      throw markCliUsageError(new Error('--since applies to summary only'));
    }
    if ((file === undefined) === !stdin) {
      throw markCliUsageError(
        new Error('append needs exactly one of --file <path> or --stdin'),
      );
    }
    const record = readRecordInput(file, stdin);
    const result = appendWorkerReport(resolveWorkerReportStore(), record);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  if (modeWord === 'summary') {
    if (file !== undefined || stdin) {
      throw markCliUsageError(
        new Error('--file and --stdin apply to append only'),
      );
    }
    if (since !== undefined && !isRealTimestamp(since)) {
      throw markCliUsageError(
        new Error(
          `--since must be a real ISO 8601 date-time with an offset, got "${since}"`,
        ),
      );
    }
    const summary = summarizeWorkerReports(
      resolveWorkerReportStore(),
      since ?? null,
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  throw markCliUsageError(
    new Error(`unknown mode "${modeWord}": expected append or summary`),
  );
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/idd-worker-report.mjs append --file <path>
  node scripts/idd-worker-report.mjs append --stdin
  node scripts/idd-worker-report.mjs summary [--since <ISO8601>]

Local store for a worker's final report. Nothing is posted to GitHub.

  append             Validate one JSON record against
                     schemas/worker-report.schema.json, then append it as one
                     line to idd-skill/worker-reports/reports.jsonl under the
                     per-user state root. The record must carry schemaVersion 1
                     and every other required field; it is stored verbatim and
                     nothing is stamped. verifiedAt and recordedAt must be real
                     calendar date-times. Invalid input exits 1 and writes
                     nothing. A record with the same claimId, workerHandle and
                     terminalPhase as an existing line is reported as
                     {"status":"duplicate"} (exit 0) and not appended.
  summary            Print outcome counts, the review-round distribution and
                     the most frequent frictions files. Never writes.

  --file <path>      append: read the record from this file.
  --stdin            append: read the record from standard input.
  --since <ISO8601>  summary: only count records whose recordedAt is at or
                     after this time. A real ISO 8601 date-time with an
                     offset, such as 2026-10-08T02:00:00Z or
                     2026-10-08T11:00:00+09:00 (2026-02-30 is rejected).
  --help, -h         Show this help.

State root: an absolute XDG_STATE_HOME, else ~/.local/state; on Windows an
absolute LOCALAPPDATA, else ~/AppData/Local. A relative value is ignored.
`);
}
