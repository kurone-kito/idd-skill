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
 * GitHub, and a same-user process can deny reads of its `/proc` entry. The
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
import { basename, dirname, join, resolve } from 'node:path';
import {
  matchDecisionRecord,
  readConfirmationIssue,
} from './auto-decision-records.mjs';
import { readTrustedAutoDecideWithConfig } from './idd-config.mjs';
import { resolveStateBase } from './idd-local-admission.mjs';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
} from './policy-helpers.mjs';
import {
  ensurePrivateStateDirectory,
  inspectDirectoryPrivacy,
  isWithinRoot,
} from './preserve-destination.mjs';
import { readWindowsAcl } from './windows-acl.mjs';
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
  "The step 2 basis is mechanical evidence, not an attestation. No condition proves that the other session is gone: a harness can keep no working directory between commands, a session can be paused past the stale age or can only poll GitHub, and a same-user process can deny reads of its /proc entry. If the evidence is wrong, a live session's worktree is removed after its changes are preserved.";
/** The risks the run cannot close; the report names them. */
export const OPEN_RISKS = [
  'The window between the post-lock recheck of conditions 1, 4, 5, and 6 and step 3 cannot be closed by this helper; only a writer outside IDD can use it, because IDD sessions take the clone lock.',
  'The PR #3550 race stays open: a same-claim session that re-acquires its worktree lock just before this run takes the clone lock is not detected.',
  'A state root that is a link is resolved once (kurone-kito/idd-skill#4957); a link retargeted afterwards is not detected.',
];
const CONDITION_TEMPLATES = [
  { number: 1, id: 'class-enabled' },
  { number: 2, id: 'linked-worktree' },
  { number: 3, id: 'stale-or-released-claim' },
  { number: 4, id: 'quiet-window' },
  { number: 5, id: 'no-process-cwd' },
  { number: 6, id: 'confirmation-record' },
];
export function newEvidenceReport() {
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
export function setCondition(report, number, status, detail) {
  const condition = report.conditions.find((entry) => entry.number === number);
  if (condition === undefined) {
    throw new Error(`no evidence condition ${number}`);
  }
  condition.status = status;
  condition.detail = detail;
  report.met = report.conditions.every((entry) => entry.status === 'met');
}
/**
 * Why a routing does not carry the claim basis of condition 3, or `null`. A
 * `stale-claim-` or `released-claim-` reason with a claim ID is required. An
 * explicit-absence routing (reasons such as `active-claim-stale` or
 * `no-active-claim`) has neither prefix, and a legacy release has no claim ID;
 * both keep the attestation path.
 */
export function claimBasisProblem(routing) {
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
export function staleAgeProblem(routing) {
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
export function evidenceBasisProblem(routing) {
  return claimBasisProblem(routing) ?? staleAgeProblem(routing);
}
/**
 * Condition 1: the trusted read (live default branch) reports `worktreeRemnant`
 * as `enabled` with a usable `quietWindow`, and a stale claim's routing meets
 * the 24-hour floor.
 */
export function evaluateClassGate(readTrusted, repository, routing) {
  const refuse = (detail, snapshot = null, quietWindow = null) => ({
    ok: false,
    detail,
    quietWindow,
    quietWindowMs: null,
    snapshot,
  });
  let snapshot;
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
/**
 * The time that counts for one entry. A file with more than one link counts by
 * its modification time only: pnpm hard-links store files into every
 * worktree, so another worktree's install changes their change time. Every
 * other entry counts by the later of its modification and change times. A
 * directory always uses both, because its link count counts subdirectories,
 * not hard links.
 */
export function entryChangeTimeMs(entry) {
  return !entry.isDirectory && entry.nlink > 1
    ? entry.mtimeMs
    : Math.max(entry.mtimeMs, entry.ctimeMs);
}
/** A time in the future, or one that is not a number, counts as recent. */
function isRecent(timeMs, nowMs, windowMs) {
  return !Number.isFinite(timeMs) || nowMs - timeMs < windowMs;
}
/**
 * Condition 4: no entry under any root changed within the quiet window. The
 * walk never follows a symlink, so a link is one entry and its target is not
 * visited. It stops at the first recent or unreadable entry and names it.
 */
export function walkQuietWindow(ports, roots, windowMs, nowMs) {
  let walked = 0;
  for (const root of roots) {
    const pending = [root];
    while (pending.length > 0) {
      const path = pending.pop();
      let entry;
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
      let names;
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
function errorCode(error) {
  const code = error?.code;
  return typeof code === 'string'
    ? code
    : error instanceof Error
      ? error.message
      : String(error);
}
/**
 * Condition 5: no process of the current user has its working directory
 * inside a root. Both the lexical path and its resolved path are compared. On
 * Linux it reads `/proc/<pid>/cwd`: an exited process (`ENOENT`, `ESRCH`) is
 * skipped; a process of another user is outside the condition and only
 * counted; a process that denies the read (`EACCES`), whose owner is this user
 * or root (a process that forbids inspection shows as root-owned), is listed
 * as not inspected without refusing; and any other read error fails the
 * condition. A platform without `/proc`, or with no current user, fails it
 * too. Finding no process proves only the absence of a known use.
 */
export function inspectProcessDirectories(ports, roots) {
  const result = {
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
  const targets = new Set();
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
  let pids;
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
  const ownerOf = (pid) => {
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
    let cwd;
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
    let real;
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
    const first = result.matches[0];
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
  return {
    ...result,
    detail: `no process of the current user has its working directory inside the worktree; ${result.notInspected.count} process(es) denied the read and were not inspected${
      result.otherUsers > 0
        ? `; ${result.otherUsers} process(es) of other users are there and are not counted`
        : ''
    }`,
  };
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
  ports,
  report,
  roots,
  processRoots,
  quietWindowMs,
) {
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
/**
 * The `Subject:` form #4961 defines for a path: absolute, with its parent
 * directory resolved and its last component kept as written, without
 * following it.
 */
export function canonicalSubject(path, realpath) {
  const absolute = resolve(path);
  const parent = realpath(dirname(absolute));
  return parent === null ? absolute : join(parent, basename(absolute));
}
const CONFIRMATION_PATTERN =
  /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
/** `<owner>/<repo>#<number>`, the shape `claim-issue --confirmation` takes. */
export function parseConfirmationReference(text) {
  const match = CONFIRMATION_PATTERN.exec(text);
  const number = Number(match?.[3]);
  return match === null || !Number.isSafeInteger(number)
    ? null
    : { owner: match[1], repo: match[2], number };
}
/** The decision ID rule of the confirmation contract: no whitespace, no `;`, no `-->`. */
const DECISION_ID_PATTERN = /^(?:(?!-->)[^\s;]){1,128}$/u;
export function isDecisionIdText(value) {
  return DECISION_ID_PATTERN.test(value);
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
  readConfirmation,
  snapshot,
  request,
) {
  const refuse = (detail) => ({ ok: false, detail });
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
  let authoringLabel;
  try {
    authoringLabel = normalizePolicyConfig(snapshot.policyConfig).issueAuthoring
      .authoringLabelName;
  } catch (error) {
    return refuse(
      `the trusted repository policy could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let read;
  try {
    read = readConfirmation({
      repository: { owner: confirmation.owner, repo: confirmation.repo },
      number: confirmation.number,
      confirmationLabel,
      authoringLabel,
      // Marker trust stays tied to the ref the label came from.
      trustedPolicyConfig: snapshot.policyConfig,
    });
  } catch (error) {
    return refuse(
      `${reference} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (read.status === 'unreadable') {
    return refuse(`${reference} is unreadable: ${read.error}`);
  }
  const problems = [];
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
function isMissingPathError(error) {
  const code = error.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
function lstatKind(path) {
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
function directoryIdentity(path) {
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
function realpathOrNull(path) {
  try {
    return realpathSync.native(path);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}
/** The production ports: live GitHub reads, the real filesystem, and `/proc`. */
export function createDefaultEvidencePorts(options) {
  const platform = options.platform ?? process.platform;
  const windowsAclReader = options.windowsAclReader ?? readWindowsAcl;
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
