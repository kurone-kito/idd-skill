// idd-generated-from: src/scripts/worktree-remnant-evidence.mts
//
// The scripts/worktree-remnant-evidence.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

/**
 * The mechanical-evidence basis of `local-worktree-recovery`
 * (kurone-kito/idd-skill#4969, roadmap #4955).
 *
 * §LWR step 2 ("rule out a live session") is the operator's attestation,
 * because a recorded PID is no liveness evidence (`claim-lock.mts` header).
 * With the `worktreeRemnant` auto-decide class switched on, a defined set of
 * conditions may stand in for that attestation. No condition proves that the
 * other session is gone: an agent harness keeps no working directory between
 * commands, a session can be paused past the stale age or can only poll
 * GitHub, and a same-user process can deny reads of its working directory (its
 * `/proc` entry on Linux). The
 * safety of the mode rests on the stale-or-released rule, the quiet window,
 * and durable preservation, and the report says so.
 *
 * This module holds the pure evaluation. It does no I/O of its own: the trusted
 * policy read, the confirmation record read, the quiet-window walk, the
 * process check, and the preserve-destination filesystem are injected ports, so
 * tests run against fakes or fixture directories. `local-worktree-recovery.mts`
 * owns step 1 (conditions 2 and 3), the clone lock, and steps 3 and 4.
 *
 * Every check fails closed. The only condition that can be reported unmet
 * without refusing is the record (condition 6) in a dry run, so that the order
 * dry run, then record, then apply works.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, win32 } from 'node:path';
import {
  type ConfirmationIssueInput,
  type ConfirmationIssueRead,
  matchDecisionRecord,
  readConfirmationIssue,
} from './auto-decision-records.mts';
import {
  readTrustedAutoDecideWithConfig,
  type TrustedAutoDecideSnapshot,
  type TrustedPolicyReadInput,
} from './idd-config.mts';
import { resolveStateBase } from './idd-local-admission.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mts';
import {
  ensurePrivateStateDirectory,
  inspectDirectoryPrivacy,
  isWithinRoot,
  type LstatKind,
  type PreserveGuardDeps,
} from './preserve-destination.mts';
import { readWindowsAcl, type WindowsAclReader } from './windows-acl.mts';
import {
  readWindowsProcessRecords,
  type WindowsProcessRecords,
} from './windows-process-cwd.mts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** A stale claim must be at least this old before the evidence may act. A
 * released claim needs no age. A repository whose `claimTiming.staleAge` is
 * shorter still gets this floor. */
export const MINIMUM_STALE_AGE_MS = 24 * 60 * 60 * 1000;

/** The class name in the trusted read and in the confirmation record. */
const CLASS_NAME = 'worktreeRemnant';

/** Not-inspected processes are listed up to this many; the count is exact. */
const NOT_INSPECTED_SAMPLE = 50;

/** One statement of what the basis is, repeated in every report. */
export const EVIDENCE_STATEMENT =
  "The step 2 basis is mechanical evidence, not an attestation. No condition proves that the other session is gone: a harness can keep no working directory between commands, a session can be paused past the stale age or can only poll GitHub, and a same-user process can deny reads of its working directory (its /proc entry on Linux). If the evidence is wrong, a live session's worktree is removed after its changes are preserved.";

/** The risks the run cannot close; the report names them. */
export const OPEN_RISKS: readonly string[] = [
  'The window between the post-lock recheck of conditions 1, 4, 5, and 6 and step 3 cannot be closed by this helper; only a writer outside IDD can use it, because IDD sessions take the clone lock.',
  'The PR #3550 race stays open: a same-claim session that re-acquires its worktree lock just before this run takes the clone lock is not detected.',
  'A state root that is a link is resolved once (kurone-kito/idd-skill#4957); a link retargeted afterwards is not detected.',
];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type EvidenceStatus = 'met' | 'unmet' | 'not-evaluated';

export interface EvidenceCondition {
  /** The condition's number in the issue (1 to 6). */
  number: number;
  id:
    | 'class-enabled'
    | 'linked-worktree'
    | 'stale-or-released-claim'
    | 'quiet-window'
    | 'no-process-cwd'
    | 'confirmation-record';
  status: EvidenceStatus;
  detail: string;
}

export interface ProcessNotInspected {
  pid: number;
  reason: string;
}

export interface WorktreeRemnantEvidenceReport {
  basis: 'mechanical-evidence';
  statement: string;
  /** The six conditions, in order; a condition that was never reached is
   * `not-evaluated`. */
  conditions: EvidenceCondition[];
  /** Every condition is `met`. */
  met: boolean;
  /** The trusted `quietWindow` as configured, or `null` when unread. */
  quietWindow: string | null;
  /** How many entries the last quiet-window walk visited. */
  entriesWalked: number | null;
  /** The processes whose working directory could not be read because the read
   * was denied. They are not refused. */
  processesNotInspected: {
    count: number;
    sample: ProcessNotInspected[];
  };
  confirmation: string | null;
  decision: string | null;
  /** The planned or created durable destination. */
  preserveDestination: { path: string | null; created: boolean };
  /** What step 3 preserved, for the caller's comment on the confirmation
   * issue. Filled from the verdict on every return path. */
  locations: {
    stashTag: string | null;
    stashes: string[];
    backupRefs: string[];
    preserveDir: string | null;
  } | null;
  openRisks: readonly string[];
}

const CONDITION_TEMPLATES: ReadonlyArray<
  Pick<EvidenceCondition, 'number' | 'id'>
> = [
  { number: 1, id: 'class-enabled' },
  { number: 2, id: 'linked-worktree' },
  { number: 3, id: 'stale-or-released-claim' },
  { number: 4, id: 'quiet-window' },
  { number: 5, id: 'no-process-cwd' },
  { number: 6, id: 'confirmation-record' },
];

export function newEvidenceReport(): WorktreeRemnantEvidenceReport {
  return {
    basis: 'mechanical-evidence',
    statement: EVIDENCE_STATEMENT,
    conditions: CONDITION_TEMPLATES.map((template) => ({
      ...template,
      status: 'not-evaluated',
      detail: 'not evaluated: an earlier check stopped the run',
    })),
    met: false,
    quietWindow: null,
    entriesWalked: null,
    processesNotInspected: { count: 0, sample: [] },
    confirmation: null,
    decision: null,
    preserveDestination: { path: null, created: false },
    locations: null,
    openRisks: OPEN_RISKS,
  };
}

export function setCondition(
  report: WorktreeRemnantEvidenceReport,
  number: number,
  status: EvidenceStatus,
  detail: string,
): void {
  const condition = report.conditions.find((entry) => entry.number === number);
  if (condition === undefined) {
    throw new Error(`no evidence condition ${number}`);
  }
  condition.status = status;
  condition.detail = detail;
  report.met = report.conditions.every((entry) => entry.status === 'met');
}

// ---------------------------------------------------------------------------
// Condition 1 and 3: class gate and the stale-or-released basis
// ---------------------------------------------------------------------------

export interface EvidenceRouting {
  reason: string;
  /** The recovered claim's ID; `null` for a legacy release. */
  claimId: string | null;
  /** The routing's `stale_age_ms`; `null` when it is absent. */
  staleAgeMs: number | null;
}

/**
 * Why a routing does not carry the claim basis of condition 3, or `null`. A
 * `stale-claim-` or `released-claim-` reason with a claim ID is required. An
 * explicit-absence routing (reasons such as `active-claim-stale` or
 * `no-active-claim`) has neither prefix, and a legacy release has no claim ID;
 * both keep the attestation path.
 */
export function claimBasisProblem(routing: EvidenceRouting): string | null {
  if (
    !routing.reason.startsWith('stale-claim-') &&
    !routing.reason.startsWith('released-claim-')
  ) {
    return `the routing reason ${routing.reason} is neither stale-claim-* nor released-claim-*, so the attestation path applies`;
  }
  // Strictly a non-empty string: routing JSON that lacks the field reads as
  // `undefined`, and that must refuse like a legacy release does.
  if (typeof routing.claimId !== 'string' || routing.claimId === '') {
    return 'the recovered claim has no claim ID (a legacy release), so the attestation path applies';
  }
  return null;
}

/**
 * Why a stale claim's routing misses the 24-hour floor of condition 1, or
 * `null`. The reason prefix, not the routing state, selects the floor: the
 * state is `local_worktree_occupied` for both a stale and a released claim. A
 * released claim needs no age.
 */
export function staleAgeProblem(routing: EvidenceRouting): string | null {
  if (!routing.reason.startsWith('stale-claim-')) return null;
  const age = routing.staleAgeMs;
  if (typeof age !== 'number' || !Number.isFinite(age)) {
    return 'the routing carries no readable stale age, so the 24-hour floor cannot be checked';
  }
  return age < MINIMUM_STALE_AGE_MS
    ? `the stale age the routing used is ${age} ms, below the ${MINIMUM_STALE_AGE_MS} ms (PT24H) floor`
    : null;
}

/** Both problems at once, for every routing read after the first. */
export function evidenceBasisProblem(routing: EvidenceRouting): string | null {
  return claimBasisProblem(routing) ?? staleAgeProblem(routing);
}

export interface ClassGate {
  ok: boolean;
  detail: string;
  quietWindow: string | null;
  quietWindowMs: number | null;
  /** The snapshot the gate read; condition 6 reuses its label and policy. */
  snapshot: TrustedAutoDecideSnapshot | null;
}

/**
 * Condition 1: the trusted read (live default branch) reports `worktreeRemnant`
 * as `enabled` with a usable `quietWindow`, and a stale claim's routing meets
 * the 24-hour floor.
 */
export function evaluateClassGate(
  readTrusted: (input: TrustedPolicyReadInput) => TrustedAutoDecideSnapshot,
  repository: { owner: string; repo: string },
  routing: EvidenceRouting,
): ClassGate {
  const refuse = (
    detail: string,
    snapshot: TrustedAutoDecideSnapshot | null = null,
    quietWindow: string | null = null,
  ): ClassGate => ({
    ok: false,
    detail,
    quietWindow,
    quietWindowMs: null,
    snapshot,
  });
  let snapshot: TrustedAutoDecideSnapshot;
  try {
    snapshot = readTrusted({ owner: repository.owner, repo: repository.repo });
  } catch (error) {
    return refuse(
      `the trusted policy read threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const report = snapshot.report;
  if (report.status !== 'readable') {
    return refuse(
      `the trusted policy read is unreadable: ${report.error ?? 'no detail'}`,
      snapshot,
    );
  }
  const verdict = report.classes[CLASS_NAME];
  if (verdict !== 'enabled') {
    return refuse(
      `the ${CLASS_NAME} class is ${verdict} at ref ${report.ref}`,
      snapshot,
    );
  }
  const quietWindow = report.quietWindow ?? null;
  const quietWindowMs = parseIsoDurationToMs(quietWindow);
  if (quietWindow === null || quietWindowMs === null) {
    return refuse(
      `the trusted quietWindow ${JSON.stringify(quietWindow)} is not a positive ISO 8601 duration`,
      snapshot,
      quietWindow,
    );
  }
  const problem = staleAgeProblem(routing);
  if (problem !== null) {
    return { ...refuse(problem, snapshot, quietWindow), quietWindowMs };
  }
  return {
    ok: true,
    detail: `the ${CLASS_NAME} class is enabled at ref ${report.ref}, the quiet window is ${quietWindow}, and ${routing.reason} meets the stale-age floor`,
    quietWindow,
    quietWindowMs,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// Condition 4: the quiet-window walk
// ---------------------------------------------------------------------------

/** What the walk reads about one entry, taken without following a link. */
export interface WalkEntry {
  isDirectory: boolean;
  nlink: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface WalkPorts {
  /** No-follow stat. Throws on any error. */
  lstat: (path: string) => WalkEntry;
  /** Child names. Throws on any error. */
  readdir: (path: string) => string[];
}

/**
 * The time that counts for one entry. A file with more than one link counts by
 * its modification time only: pnpm hard-links store files into every
 * worktree, so another worktree's install changes their change time. Every
 * other entry counts by the later of its modification and change times. A
 * directory always uses both, because its link count counts subdirectories,
 * not hard links.
 */
export function entryChangeTimeMs(entry: WalkEntry): number {
  return !entry.isDirectory && entry.nlink > 1
    ? entry.mtimeMs
    : Math.max(entry.mtimeMs, entry.ctimeMs);
}

/** A time in the future, or one that is not a number, counts as recent. */
function isRecent(timeMs: number, nowMs: number, windowMs: number): boolean {
  return !Number.isFinite(timeMs) || nowMs - timeMs < windowMs;
}

export interface QuietWalkResult {
  status: 'quiet' | 'recent' | 'unreadable';
  detail: string;
  /** The first recent or unreadable entry. */
  entry: string | null;
  walked: number;
}

/**
 * Condition 4: no entry under any root changed within the quiet window. The
 * walk never follows a symlink, so a link is one entry and its target is not
 * visited. It stops at the first recent or unreadable entry and names it.
 */
export function walkQuietWindow(
  ports: WalkPorts,
  roots: readonly string[],
  windowMs: number,
  nowMs: number,
): QuietWalkResult {
  let walked = 0;
  for (const root of roots) {
    const pending: string[] = [root];
    while (pending.length > 0) {
      const path = pending.pop() as string;
      let entry: WalkEntry;
      try {
        entry = ports.lstat(path);
      } catch (error) {
        return {
          status: 'unreadable',
          detail: `${path} could not be read: ${errorCode(error)}`,
          entry: path,
          walked,
        };
      }
      walked += 1;
      if (path === root && !entry.isDirectory) {
        return {
          status: 'unreadable',
          detail: `${path} is not a directory, so its tree cannot be walked`,
          entry: path,
          walked,
        };
      }
      const time = entryChangeTimeMs(entry);
      if (isRecent(time, nowMs, windowMs)) {
        const age = nowMs - time;
        return {
          status: 'recent',
          detail: Number.isFinite(time)
            ? age < 0
              ? `${path} carries a time in the future`
              : `${path} changed ${Math.round(age / 1000)} s ago, inside the quiet window`
            : `${path} has a time that is not a number`,
          entry: path,
          walked,
        };
      }
      if (!entry.isDirectory) continue;
      let names: string[];
      try {
        names = ports.readdir(path);
      } catch (error) {
        return {
          status: 'unreadable',
          detail: `${path} could not be listed: ${errorCode(error)}`,
          entry: path,
          walked,
        };
      }
      for (const name of names) pending.push(join(path, name));
    }
  }
  return {
    status: 'quiet',
    detail: `no entry changed within the quiet window (${walked} entries walked)`,
    entry: null,
    walked,
  };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string'
    ? code
    : error instanceof Error
      ? error.message
      : String(error);
}

// ---------------------------------------------------------------------------
// Condition 5: process working directories
// ---------------------------------------------------------------------------

export interface ProcPorts {
  platform: NodeJS.Platform;
  /** The numeric entries of `/proc`. Throws when it cannot be listed. */
  listPids: () => string[];
  /** The text of the `/proc/<pid>/cwd` link. Throws an errno-coded error. */
  readCwd: (pid: string) => string;
  /** The owner of the process: the user ID of its `/proc/<pid>` entry. Throws
   * an errno-coded error. */
  ownerUid: (pid: string) => number;
  /** The user ID of this process; `null` where the platform has none. */
  currentUid: number | null;
  /** `realpath`, or `null` when the path does not resolve. */
  realpath: (path: string) => string | null;
  /**
   * The batch reader of `windows-process-cwd.mts`: the current user's SID and
   * one record per process. Present only on `win32`, where there is no `/proc`;
   * it throws when the read fails. The members above are not used there.
   */
  readWindowsProcesses?: () => WindowsProcessRecords;
}

export interface ProcessCwdResult {
  status: 'clear' | 'match' | 'error' | 'unsupported';
  detail: string;
  matches: Array<{ pid: number; cwd: string }>;
  notInspected: { count: number; sample: ProcessNotInspected[] };
  /** Processes of other users with a working directory inside a root. They
   * are outside the condition and are not refused. */
  otherUsers: number;
}

/**
 * Condition 5: no process of the current user has its working directory
 * inside a root. Both the lexical path and its resolved path are compared. On
 * Linux it reads `/proc/<pid>/cwd`: an exited process (`ENOENT`, `ESRCH`) is
 * skipped; a process of another user is outside the condition and only
 * counted; a process that denies the read (`EACCES`), whose owner is this user
 * or root (a process that forbids inspection shows as root-owned), is listed
 * as not inspected without refusing; and any other read error fails the
 * condition. On `win32` the records of the batch reader are classified
 * instead (see {@link inspectWindowsProcessRecords}). A platform with neither,
 * or with no current user, fails the condition too. Finding no process proves
 * only the absence of a known use.
 */
export function inspectProcessDirectories(
  ports: ProcPorts,
  roots: readonly string[],
): ProcessCwdResult {
  if (ports.platform === 'win32') {
    return inspectWindowsProcessRecords(ports, roots);
  }
  const result: ProcessCwdResult = {
    status: 'clear',
    detail: '',
    matches: [],
    notInspected: { count: 0, sample: [] },
    otherUsers: 0,
  };
  if (ports.platform !== 'linux') {
    return {
      ...result,
      status: 'unsupported',
      detail: `the process check reads /proc and cannot run on ${ports.platform}`,
    };
  }
  const currentUid = ports.currentUid;
  if (currentUid === null) {
    return {
      ...result,
      status: 'error',
      detail: 'the current user could not be determined',
    };
  }
  const targets = new Set<string>();
  try {
    for (const root of roots) {
      targets.add(resolve(root));
      const real = ports.realpath(root);
      if (real !== null) targets.add(real);
    }
  } catch (error) {
    return {
      ...result,
      status: 'error',
      detail: `a root could not be resolved: ${errorCode(error)}`,
    };
  }
  let pids: string[];
  try {
    pids = ports.listPids();
  } catch (error) {
    return {
      ...result,
      status: 'error',
      detail: `/proc could not be listed: ${errorCode(error)}`,
    };
  }
  // The owner of one process, or `null` when it exited since the listing.
  const ownerOf = (pid: string): number | null | 'error' => {
    try {
      return ports.ownerUid(pid);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ESRCH') return null;
      result.status = 'error';
      result.detail = `the owner of process ${pid} could not be read: ${code}`;
      return 'error';
    }
  };
  for (const pid of pids) {
    let cwd: string;
    try {
      cwd = ports.readCwd(pid);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT' || code === 'ESRCH') continue;
      if (code === 'EACCES') {
        const owner = ownerOf(pid);
        if (owner === 'error') return result;
        // Another user's process is outside the condition. A process that
        // forbids inspection shows as root-owned, so root's stay listed.
        if (owner === null || (owner !== currentUid && owner !== 0)) continue;
        result.notInspected.count += 1;
        if (result.notInspected.sample.length < NOT_INSPECTED_SAMPLE) {
          result.notInspected.sample.push({ pid: Number(pid), reason: code });
        }
        continue;
      }
      return {
        ...result,
        status: 'error',
        detail: `the working directory of process ${pid} could not be read: ${code}`,
      };
    }
    // A removed directory reads `<path> (deleted)`; the prefix still matches.
    let real: string | null;
    try {
      real = ports.realpath(cwd);
    } catch (error) {
      return {
        ...result,
        status: 'error',
        detail: `the working directory of process ${pid} could not be resolved: ${errorCode(error)}`,
      };
    }
    const inside = [...targets].some(
      (target) =>
        isWithinRoot(target, cwd) ||
        (real !== null && isWithinRoot(target, real)),
    );
    if (!inside) continue;
    const owner = ownerOf(pid);
    if (owner === 'error') return result;
    if (owner === null) continue;
    if (owner === currentUid) {
      result.matches.push({ pid: Number(pid), cwd });
    } else {
      result.otherUsers += 1;
    }
  }
  if (result.matches.length > 0) {
    const first = result.matches[0] as { pid: number; cwd: string };
    return {
      ...result,
      status: 'match',
      detail: `process ${first.pid} has its working directory at ${first.cwd}${
        result.matches.length > 1
          ? ` (and ${result.matches.length - 1} more)`
          : ''
      }`,
    };
  }
  return { ...result, detail: clearDetail(result) };
}

/** The detail of a `clear` result, the same sentence on every platform. */
function clearDetail(result: ProcessCwdResult): string {
  return `no process of the current user has its working directory inside the worktree; ${result.notInspected.count} process(es) denied the read and were not inspected${
    result.otherUsers > 0
      ? `; ${result.otherUsers} process(es) of other users are there and are not counted`
      : ''
  }`;
}

// ---------------------------------------------------------------------------
// Condition 5 on Windows
// ---------------------------------------------------------------------------

/** LocalSystem. It stands for root in the Linux rule for a denied read. */
const LOCAL_SYSTEM_SID = 'S-1-5-18';

/**
 * A well-formed SID string. The parser of the reader checks `currentSid`
 * against the same pattern, which `windows-process-cwd.mts` keeps private; the
 * ports are injected, so the evaluator checks it again, for the current user
 * and for every owner: a current user that is no SID would make every
 * current-user process read as another account's.
 */
const SID_PATTERN = /^S-1-\d+(?:-\d+)+$/;

/** A drive-absolute path (`C:\`) or a UNC path with a server and a share. */
const WIN32_QUALIFIED_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/;

/** The most characters of a reader failure message that the detail keeps. */
const READER_MESSAGE_LIMIT = 120;

/** The failure text for a thrown value that cannot be turned into text. */
const UNPRINTABLE_FAILURE = 'a thrown value that cannot be printed';

/** `\\?\C:\x` as `C:\x` and `\\?\UNC\server\share` as `\\server\share`. */
function stripExtendedPrefix(path: string): string {
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

function isQualifiedWin32Path(path: string): boolean {
  return WIN32_QUALIFIED_PATH.test(stripExtendedPrefix(path));
}

/**
 * True when `target` is `root` or lies inside it, compared as Windows paths on
 * any host: both sides lose an extended-length prefix, are normalized by
 * `path.win32`, and are compared without regard to letter case, as NTFS does.
 * A path that is not a full drive or UNC path is outside every root, because
 * it cannot be placed; a caller that must not miss one rejects it first.
 * `isWithinRoot` in `preserve-destination.mts` is bound to the host's
 * `node:path`, so it cannot compare a Windows path on another platform.
 */
export function isWithinWin32Root(root: string, target: string): boolean {
  const base = stripExtendedPrefix(root);
  const candidate = stripExtendedPrefix(target);
  if (!isQualifiedWin32Path(base) || !isQualifiedWin32Path(candidate)) {
    return false;
  }
  const rel = win32.relative(
    win32.resolve(base.toLowerCase()),
    win32.resolve(candidate.toLowerCase()),
  );
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel))
  );
}

/**
 * A short text for a reader failure. An `execFileSync` message can embed the
 * whole PowerShell program, so the detail takes the error code, the exit
 * status, or the signal, and only then the first line of the message, cut.
 */
function readerFailureText(error: unknown): string {
  try {
    const failure = (error ?? {}) as {
      code?: unknown;
      status?: unknown;
      signal?: unknown;
    };
    if (typeof failure.code === 'string' && failure.code !== '') {
      return failure.code;
    }
    if (typeof failure.status === 'number') {
      return `exit status ${failure.status}`;
    }
    if (typeof failure.signal === 'string' && failure.signal !== '') {
      return `signal ${failure.signal}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    const line = (message.split('\n')[0] ?? '').trim();
    return line.length > READER_MESSAGE_LIMIT
      ? `${line.slice(0, READER_MESSAGE_LIMIT)}...`
      : line;
  } catch {
    // A thrown value whose properties or string form throw (a null-prototype
    // object, a getter that throws) must still give the condition its `error`
    // result, so the text falls back to a fixed one.
    return UNPRINTABLE_FAILURE;
  }
}

const WINDOWS_RECORD_KINDS: ReadonlySet<string> = new Set([
  'exited',
  'denied',
  'live',
  'error',
]);

function isNone(value: unknown): boolean {
  return value === null || value === undefined;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Why a record breaks the per-kind shape the reader documents, or `null`. The
 * invariants of `parseWindowsProcessRecords` that decide how a record is
 * classified; the injected ports do not have to pass through that parser, so a
 * record that contradicts its kind (a denied one with a bitness, an exited one
 * with a directory) is not classified as if it were well formed. The field
 * types of an `error` record are not checked, because its classification reads
 * only the reason. `kind` is already known to be one of the four.
 */
function recordShapeProblem(record: Record<string, unknown>): string | null {
  const { kind, bitness, directory, reason } = record;
  if (kind !== 'error' && !isNone(reason)) {
    return 'a reason on a record that is not an error';
  }
  switch (kind) {
    case 'exited':
      return isNone(bitness) && isNone(directory) && isNone(record.ownerSid)
        ? null
        : 'an exited record with a bitness, a directory, or an owner';
    case 'denied':
      return isNone(bitness) && isNone(directory)
        ? null
        : 'a denied record with a bitness or a directory';
    case 'live':
      if (bitness === 32) {
        return isNone(directory) ? null : 'a 32-bit record with a directory';
      }
      return bitness === 64 && isText(directory)
        ? null
        : 'a live record with no bitness, or a 64-bit one with no directory';
    default:
      return isText(reason) ? null : 'an error record with no reason';
  }
}

/**
 * Condition 5 on `win32`, from the records of the batch reader (kurone-kito/
 * idd-skill#5347, roadmap #5285). The current user is the owner SID equal to
 * the reader's `currentSid`. Every record is classified once and none stops the
 * run, so the detail can name both a match and an error. A `live` record of a
 * 32-bit process is an error for any owner (reason `wow64`), because its
 * directory is not read and so cannot be placed inside or outside a root; that
 * rule comes first. Then:
 *
 * - `exited`: skipped.
 * - `denied`, owned by the current user or by LocalSystem, or with an owner
 *   that could not be read: listed as not inspected (reason `denied`) without
 *   refusing. Unlike Linux, a failed owner read is listed, not an error. Any
 *   other owner: skipped.
 * - `live`, owned by another account: counted when its directory is inside a
 *   root, never refused.
 * - `live`, owned by the current user: a match when its directory is inside a
 *   root, else ignored. With an owner that could not be read: an error (reason
 *   `owner-unreadable`) when inside a root, else ignored.
 * - `error`: an error with the reader's own reason.
 *
 * The lexical path is compared first and the resolved path only on a miss, so a
 * failed resolution cannot hide a lexical match. A resolution that throws, or
 * that returns nothing, is an error for a record that could count (the current
 * user, or an unreadable owner), and ignored for another account's record,
 * which can never change the status (reason `unresolvable`). Linux ignores a
 * directory that resolves to nothing; Windows does not, because a drive letter
 * is scoped to a logon session and can name nothing in this one. A root that
 * resolves to nothing is still compared by its lexical form alone. Anything
 * outside the reader's documented shape is an error (reason `malformed`), as is
 * a missing or throwing reader (reason `error`) and a record whose fields
 * cannot be read: the ports are injected, so the evaluator does not trust the
 * parser to have run, and each field is read once. A match gives status
 * `match`, whatever else was found; otherwise any error gives `error`.
 */
function inspectWindowsProcessRecords(
  ports: ProcPorts,
  roots: readonly string[],
): ProcessCwdResult {
  const result: ProcessCwdResult = {
    status: 'clear',
    detail: '',
    matches: [],
    notInspected: { count: 0, sample: [] },
    otherUsers: 0,
  };
  const fail = (detail: string): ProcessCwdResult => ({
    ...result,
    status: 'error',
    detail,
  });
  // The roots come first, as on Linux, so a root that cannot be resolved costs
  // no process read.
  const targets: string[] = [];
  try {
    for (const root of roots) {
      // Before `win32.resolve`: on a Windows host it would anchor a relative
      // root to the current directory and make it look like a full path.
      if (!isQualifiedWin32Path(root)) {
        return fail(
          'a root is not a full Windows path (reason unresolvable), so no directory can be compared with it',
        );
      }
      targets.push(win32.resolve(root));
      const real = ports.realpath(root);
      if (real !== null) targets.push(real);
    }
  } catch (error) {
    return fail(
      `a root could not be resolved (reason unresolvable): ${errorCode(error)}`,
    );
  }
  if (!targets.every(isQualifiedWin32Path)) {
    return fail(
      'a resolved root is not a full Windows path (reason unresolvable), so no directory can be compared with it',
    );
  }
  const reader = ports.readWindowsProcesses;
  if (reader === undefined) {
    return fail('the Windows process reader is not available (reason error)');
  }
  let read: WindowsProcessRecords;
  try {
    read = reader();
  } catch (error) {
    return fail(
      `the Windows process reader failed (reason error): ${readerFailureText(error)}`,
    );
  }
  const currentSid = read?.currentSid;
  const records: unknown = read?.records;
  if (typeof currentSid !== 'string' || !SID_PATTERN.test(currentSid)) {
    return fail(
      'the Windows process reader gave no current user SID (reason malformed)',
    );
  }
  if (!Array.isArray(records) || records.length === 0) {
    return fail(
      'the Windows process reader gave no process records (reason malformed)',
    );
  }
  const errors: string[] = [];
  const insideTargets = (path: string): boolean =>
    targets.some((target) => isWithinWin32Root(target, path));

  const list = records as unknown[];
  for (let index = 0; index < list.length; index += 1) {
    // The ports are injected, so a record is not trusted to be a plain object:
    // the element and each of its six fields are read once, here, into a plain
    // snapshot, and a read that throws makes only this record malformed.
    let record: Record<string, unknown>;
    try {
      const entry = (list[index] ?? {}) as Record<string, unknown>;
      record = {
        pid: entry.pid,
        kind: entry.kind,
        bitness: entry.bitness,
        directory: entry.directory,
        reason: entry.reason,
        ownerSid: entry.ownerSid ?? null,
      };
    } catch {
      errors.push(`record ${index} could not be read (reason malformed)`);
      continue;
    }
    const { pid, kind, bitness, directory, reason, ownerSid } = record;
    if (
      typeof pid !== 'number' ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof kind !== 'string' ||
      !WINDOWS_RECORD_KINDS.has(kind) ||
      (ownerSid !== null &&
        (typeof ownerSid !== 'string' || !SID_PATTERN.test(ownerSid)))
    ) {
      errors.push(`record ${index} is not a process record (reason malformed)`);
      continue;
    }
    const shapeProblem = recordShapeProblem(record);
    if (shapeProblem !== null) {
      errors.push(
        `the record of process ${pid} is out of shape: ${shapeProblem} (reason malformed)`,
      );
      continue;
    }
    const owner = ownerSid as string | null;
    if (kind === 'exited') continue;
    if (kind === 'error') {
      errors.push(
        `the working directory of process ${pid} could not be read (reason ${reason})`,
      );
      continue;
    }
    if (kind === 'denied') {
      if (
        owner === null ||
        owner === currentSid ||
        owner === LOCAL_SYSTEM_SID
      ) {
        result.notInspected.count += 1;
        if (result.notInspected.sample.length < NOT_INSPECTED_SAMPLE) {
          result.notInspected.sample.push({ pid, reason: 'denied' });
        }
      }
      continue;
    }
    // A live record. The 32-bit rule is first, for any owner.
    if (bitness === 32) {
      errors.push(
        `process ${pid} is a 32-bit process on 64-bit Windows, so its working directory is not read and may be inside a root (reason wow64)`,
      );
      continue;
    }
    const other = owner !== null && owner !== currentSid;
    // The shape check above leaves a 64-bit record with a text directory.
    const cwd = directory as string;
    if (!isQualifiedWin32Path(cwd)) {
      // A directory that cannot be placed. Another account's never counts.
      if (!other) {
        errors.push(
          `process ${pid} has no usable working directory (reason malformed)`,
        );
      }
      continue;
    }
    let inside = insideTargets(cwd);
    if (!inside) {
      let real: string | null;
      try {
        real = ports.realpath(cwd);
      } catch (error) {
        if (!other) {
          errors.push(
            `the working directory of process ${pid} could not be resolved (reason unresolvable): ${errorCode(error)}`,
          );
        }
        continue;
      }
      if (real === null) {
        // Windows scopes a drive letter (SUBST, a network mapping) to a logon
        // session, so a process can work inside a root under a letter that
        // this session maps elsewhere or not at all. A directory that could
        // count and cannot be placed does not clear the condition, unlike on
        // Linux. Another account's record can never change the status.
        if (!other) {
          errors.push(
            `the working directory of process ${pid} could not be resolved (reason unresolvable): the path does not resolve`,
          );
        }
        continue;
      }
      inside = insideTargets(real);
    }
    if (!inside) continue;
    if (other) {
      result.otherUsers += 1;
    } else if (owner === null) {
      errors.push(
        `the owner of process ${pid} could not be read (reason owner-unreadable)`,
      );
    } else {
      result.matches.push({ pid, cwd });
    }
  }

  const firstError = errors[0];
  if (result.matches.length > 0) {
    const first = result.matches[0] as { pid: number; cwd: string };
    return {
      ...result,
      status: 'match',
      detail: `process ${first.pid} has its working directory at ${first.cwd}${
        result.matches.length > 1
          ? ` (and ${result.matches.length - 1} more)`
          : ''
      }${
        firstError === undefined
          ? ''
          : `; ${errors.length} process(es) could not be classified, the first: ${firstError}`
      }`,
    };
  }
  if (firstError !== undefined) {
    return {
      ...result,
      status: 'error',
      detail: `${firstError}${
        errors.length > 1 ? ` (and ${errors.length - 1} more)` : ''
      }`,
    };
  }
  return { ...result, detail: clearDetail(result) };
}

/**
 * Conditions 4 and 5 together. The quiet-window walk covers `roots`: the
 * worktree and its private git-admin directory, or only the admin directory for
 * the prunable shortcut. The process check covers `processRoots`: the worktree
 * alone, because the condition is about a working directory inside the
 * worktree (and, for the prunable shortcut, inside the admin directory that is
 * all that is left). It runs twice: before the clone lock, and again right
 * before step 3. `quietWindowMs` is `null` when condition 1 could not read it,
 * which leaves condition 4 unevaluated.
 */
export function evaluateQuietWindowAndProcesses(
  ports: Pick<WorktreeRemnantEvidencePorts, 'walk' | 'proc' | 'nowMs'>,
  report: WorktreeRemnantEvidenceReport,
  roots: readonly string[],
  processRoots: readonly string[],
  quietWindowMs: number | null,
): void {
  if (quietWindowMs === null) {
    setCondition(
      report,
      4,
      'not-evaluated',
      'the trusted quietWindow could not be read (condition 1)',
    );
  } else {
    const walk = walkQuietWindow(
      ports.walk,
      roots,
      quietWindowMs,
      ports.nowMs(),
    );
    report.entriesWalked = walk.walked;
    setCondition(
      report,
      4,
      walk.status === 'quiet' ? 'met' : 'unmet',
      walk.detail,
    );
  }
  const processes = inspectProcessDirectories(ports.proc, processRoots);
  report.processesNotInspected = processes.notInspected;
  setCondition(
    report,
    5,
    processes.status === 'clear' ? 'met' : 'unmet',
    processes.detail,
  );
}

// ---------------------------------------------------------------------------
// Condition 6: the confirmation record
// ---------------------------------------------------------------------------

export interface ConfirmationReference {
  owner: string;
  repo: string;
  number: number;
}

export interface RecordRequest {
  repository: { owner: string; repo: string };
  /** The claimed issue the worktree belongs to: the record's `source`. */
  issue: number;
  confirmation: ConfirmationReference | null;
  decision: string | null;
  /** The claim step 1 recovered. */
  claimId: string;
  /** The canonical target path, as {@link canonicalSubject} builds it. */
  subject: string;
}

/**
 * The `Subject:` form #4961 defines for a path: absolute, with its parent
 * directory resolved and its last component kept as written, without
 * following it.
 */
export function canonicalSubject(
  path: string,
  realpath: (path: string) => string | null,
): string {
  const absolute = resolve(path);
  const parent = realpath(dirname(absolute));
  return parent === null ? absolute : join(parent, basename(absolute));
}

const CONFIRMATION_PATTERN =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;

/** `<owner>/<repo>#<number>`, the shape `claim-issue --confirmation` takes. */
export function parseConfirmationReference(
  text: string,
): ConfirmationReference | null {
  const match = CONFIRMATION_PATTERN.exec(text);
  const number = Number(match?.[3]);
  return match === null || !Number.isSafeInteger(number)
    ? null
    : { owner: match[1] as string, repo: match[2] as string, number };
}

/** The decision ID rule of the confirmation contract: no whitespace, no `;`, no `-->`. */
const DECISION_ID_PATTERN = /^(?:(?!-->)[^\s;]){1,128}$/u;

export function isDecisionIdText(value: string): boolean {
  return DECISION_ID_PATTERN.test(value);
}

export interface RecordCheck {
  ok: boolean;
  detail: string;
}

/**
 * Condition 6: the confirmation issue and decision named on the command line
 * match a trusted record, read through #4962. The issue is open, carries the
 * configured confirmation label, and no longer carries the authoring label;
 * the record has `class=worktreeRemnant`, this issue as `source`, the
 * recovered claim, the decision, and a `Subject:` equal to the target path. A
 * voided decision, and one with a counting `location` or `failure` note, does
 * not match, so a retry after a failure records a new decision.
 */
export function evaluateConfirmationRecord(
  readConfirmation: (input: ConfirmationIssueInput) => ConfirmationIssueRead,
  snapshot: TrustedAutoDecideSnapshot | null,
  request: RecordRequest,
): RecordCheck {
  const refuse = (detail: string): RecordCheck => ({ ok: false, detail });
  const { confirmation, decision } = request;
  if (confirmation === null || decision === null || decision === '') {
    return refuse('no --confirmation and --decision were named');
  }
  const reference = `${confirmation.owner}/${confirmation.repo}#${confirmation.number}`;
  if (
    `${confirmation.owner}/${confirmation.repo}`.toLowerCase() !==
      `${request.repository.owner}/${request.repository.repo}`.toLowerCase() ||
    confirmation.number === request.issue
  ) {
    return refuse(
      `${reference} must be another issue of this repository than the claimed issue`,
    );
  }
  if (snapshot === null || snapshot.report.status !== 'readable') {
    return refuse('the trusted policy read is unavailable');
  }
  const confirmationLabel = snapshot.report.confirmationLabelName;
  if (
    typeof confirmationLabel !== 'string' ||
    confirmationLabel.trim() === ''
  ) {
    return refuse(
      'the confirmation label name is not available from the trusted read',
    );
  }
  let authoringLabel: string;
  try {
    authoringLabel = normalizePolicyConfig(snapshot.policyConfig).issueAuthoring
      .authoringLabelName;
  } catch (error) {
    return refuse(
      `the trusted repository policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let read: ConfirmationIssueRead;
  try {
    read = readConfirmation({
      repository: { owner: confirmation.owner, repo: confirmation.repo },
      number: confirmation.number,
      confirmationLabel,
      authoringLabel,
      // Marker trust stays tied to the ref the label came from.
      trustedPolicyConfig:
        snapshot.policyConfig as ConfirmationIssueInput['trustedPolicyConfig'],
    });
  } catch (error) {
    return refuse(
      `${reference} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (read.status === 'unreadable') {
    return refuse(`${reference} is unreadable: ${read.error}`);
  }
  const problems: string[] = [];
  if (read.state !== 'open') problems.push('it is not open');
  if (!read.confirmationLabel) {
    problems.push(`it lacks the ${confirmationLabel} label`);
  }
  if (read.authoringLabel)
    problems.push('it still carries the authoring label');
  if (problems.length > 0)
    return refuse(`${reference}: ${problems.join(', ')}`);

  const source = `${request.repository.owner}/${request.repository.repo}#${request.issue}`;
  const match = matchDecisionRecord(read, {
    class: CLASS_NAME,
    source,
    claim: request.claimId,
    subject: request.subject,
    decision,
  });
  if (match.verdict !== 'match') {
    const why = read.voidedDecisions.includes(decision)
      ? 'it is voided'
      : read.conflictingDecisions.includes(decision)
        ? 'its records disagree'
        : match.reason;
    return refuse(
      `decision ${decision} in ${reference} matches no record for source ${source}, claim ${request.claimId}, and subject ${request.subject}: ${why}`,
    );
  }
  const record = match.records[0];
  if (record === undefined) return refuse(`decision ${decision} has no record`);
  if (record.locationNote || record.failureNote) {
    return refuse(
      `decision ${decision} was already acted on or failed (a counting ${record.locationNote ? 'location' : 'failure'} note exists); a new attempt needs a new decision`,
    );
  }
  return {
    ok: true,
    detail: `${reference} is open, labeled, and released, and decision ${decision} has a counting ${CLASS_NAME} record for this claim and path`,
  };
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The filesystem half of the #4957 guards; `git` comes from the caller. */
export type PreserveGuardFilesystem = Omit<PreserveGuardDeps, 'git'>;

/** Everything the evidence reads, besides step 1 and the verdict. */
export interface WorktreeRemnantEvidencePorts {
  /** The trusted read of #4958, from the live default branch. */
  readTrusted: (input: TrustedPolicyReadInput) => TrustedAutoDecideSnapshot;
  /** The trusted confirmation-record reader of #4962. */
  readConfirmation: (input: ConfirmationIssueInput) => ConfirmationIssueRead;
  walk: WalkPorts;
  proc: ProcPorts;
  /** The real clock. The walk never uses `--now` or the helper's own clock. */
  nowMs: () => number;
  guards: PreserveGuardFilesystem;
  /** The repository whose trusted policy and issues are read. */
  repository: { owner: string; repo: string };
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function lstatKind(path: string): LstatKind {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'symlink';
    if (stat.isDirectory()) return 'directory';
    return stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (isMissingPathError(error)) return 'absent';
    throw error;
  }
}

function directoryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino === 0n) {
      return null;
    }
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export interface DefaultEvidencePortsOptions {
  repository: { owner: string; repo: string };
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  windowsAclReader?: WindowsAclReader;
  /** Replaces the batch reader of Windows processes; `win32` only. */
  windowsProcessReader?: () => WindowsProcessRecords;
}

/**
 * The production ports: live GitHub reads, the real filesystem, `/proc`, and
 * on `win32` the batch reader of process records.
 */
export function createDefaultEvidencePorts(
  options: DefaultEvidencePortsOptions,
): WorktreeRemnantEvidencePorts {
  const platform = options.platform ?? process.platform;
  const windowsAclReader = options.windowsAclReader ?? readWindowsAcl;
  const windowsProcessReader =
    options.windowsProcessReader ?? (() => readWindowsProcessRecords());
  return {
    readTrusted: (input) => readTrustedAutoDecideWithConfig(input),
    readConfirmation: (input) => readConfirmationIssue(input),
    walk: {
      lstat: (path) => {
        const stat = lstatSync(path);
        return {
          isDirectory: stat.isDirectory(),
          nlink: stat.nlink,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        };
      },
      readdir: (path) => readdirSync(path),
    },
    proc: {
      platform,
      listPids: () =>
        readdirSync('/proc').filter((name) => /^[1-9][0-9]*$/.test(name)),
      readCwd: (pid) => readlinkSync(`/proc/${pid}/cwd`),
      ownerUid: (pid) => statSync(`/proc/${pid}`).uid,
      currentUid: process.getuid?.() ?? null,
      realpath: realpathOrNull,
      ...(platform === 'win32'
        ? { readWindowsProcesses: windowsProcessReader }
        : {}),
    },
    nowMs: () => Date.now(),
    guards: {
      lstat: lstatKind,
      directoryIdentity,
      realpath: realpathOrNull,
      stateRoot: resolveStateBase(
        options.env ?? process.env,
        platform,
        options.home ?? homedir(),
      ),
      now: () => new Date(),
      inspectDirectoryPrivacy: (path) =>
        inspectDirectoryPrivacy(path, platform, windowsAclReader),
      ensurePrivateDirectory: (path) =>
        ensurePrivateStateDirectory(path, platform, windowsAclReader),
      mkdir: (path, mode) => mkdirSync(path, { mode }),
    },
    repository: options.repository,
  };
}
