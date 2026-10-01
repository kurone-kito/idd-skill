#!/usr/bin/env node
// idd-generated-from: src/scripts/clone-lock.mts
//
// The scripts/clone-lock.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Clone-scoped mutual-exclusion lock (#2223): serializes `git worktree
// add`, `git worktree remove`, and `git fetch` against the shared primary
// clone when multiple concurrent sessions operate against it. This is a
// different kind of lock than `claim-lock.mts`: that one records
// worktree-local *ownership* for a whole worker's lifetime and reports a
// same-machine collision immediately (never blocks). This one is a
// short-duration *mutex* around a single git operation -- it blocks
// (retrying with backoff) until it can acquire, up to a bounded timeout,
// because the operations it guards are expected to finish in seconds, not
// the hours a claim can be held for.
//
// The lock file lives in the primary clone's *shared* git-admin directory
// (`git rev-parse --path-format=absolute --git-common-dir`), not any one
// worktree's private admin dir -- every worktree of the same clone shares
// this path, which is exactly the scope a clone-wide mutex needs. A
// linked worktree's own `.git` is a file, not this shared directory, so
// resolving through `--git-common-dir` (rather than `--absolute-git-dir`,
// which `claim-lock.mts` uses for its narrower per-worktree scope) is
// required here.
//
// This module deliberately has NO automatic stale-lock recovery. A
// holder that crashes leaves an orphaned lock file behind -- unlike a
// real `flock(2)`, a plain lock file is not released automatically when
// its owning process dies -- and a timed-out waiter is simply told so,
// with the lock path and the recorded holder's `pid` in the error
// message, and pointed at a manual `rm <lock-path>` once a human has
// confirmed the holder is actually gone (the same approach git's own
// `index.lock` takes on a stale-lock collision). This module went
// through three different automatic-recovery designs across successive
// review rounds on #2223 -- an mtime-elapsed-time threshold with a
// periodic lease refresh, then a PID-tagged arbiter lock with
// inode-verified recovery, then a simplified PID-liveness check with no
// arbiter -- and every one of them was found to have a genuine
// concurrency defect by the next review round: a live, actively
// -refreshing holder taken over anyway under scheduling jitter; a
// wrapper process's own pid going "dead" while the git child it spawned
// was still running and still needed the lock; more than one waiter
// racing to reclaim the exact same confirmed-dead entry. Every
// mitigation attempted for one of these introduced a new gap of its own
// rather than eliminating the underlying problem, because implementing
// a genuinely race-free "is this specific holder now provably gone, and
// can exactly one waiter reclaim it" protocol needs a coordination
// primitive (a kernel-level compare-and-swap, or a real `flock(2)`)
// plain POSIX file read/write/rename operations do not provide. Rather
// than continue layering fixes onto that fundamentally unsound
// foundation, automatic recovery was removed entirely: the only
// remaining decision authority for who acquires this lock is the OS
// kernel's own `O_EXCL` guarantee on a single `{ flag: 'wx' }` create,
// which is unconditionally race-free by construction -- there is no
// removal, no recreation, and no second coordination primitive left for
// a defect to hide in. `idd-skill#2223`'s Acceptance Criteria only ever
// required an acquire/release interface and serializing two concurrent
// invocations against each other, never automatic stale-lock recovery.
// The lock body still records the holder's own `pid` (`isPidAlive`,
// `process.kill(pid, 0)`), but purely as diagnostic information for a
// human deciding whether it is safe to remove the lock by hand -- never
// as input to an automated takeover decision. This is a purely local
// mutex scoped to operations that normally complete in seconds -- it
// carries none of `claim-lock.mts`'s GitHub-reverification requirement,
// because this lock has no cross-machine claim-ownership meaning to
// protect.
//
// One Windows-only refinement stays inside that design (#3679): a create
// there can answer `EPERM` (or, as a precaution, `EACCES`) instead of
// `EEXIST`. Observed 2026-09-30 in the Windows `lint.yml` same-claim-id
// race test (runs 36666761069 and 36709000096); the cause was not
// established (a delete still pending on the name is one unconfirmed
// candidate), and no `EPERM` from a real session has been seen.
// `tryExclusiveCreate` reports it as "did not acquire this round", and the
// loop in `acquireCloneLockAtPath` retries a bounded number of times
// (`CLONE_LOCK_WINDOWS_DENIED_RETRIES`) before rethrowing that error, so a
// real permission problem still fails within seconds. The operating
// system's create remains the only decision authority: treating an `EPERM`
// as contention adds no takeover, no removal, and no second coordination
// path. POSIX behavior is unchanged: any error other than `EEXIST` is
// thrown at once.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';

const CLONE_LOCK_FILE_NAME = 'idd-clone.lock';
const CLONE_LOCK_PATH_ENV = 'IDD_CLONE_LOCK_PATH';
const CLONE_LOCK_TOKEN_ENV = 'IDD_CLONE_LOCK_TOKEN';
/** How long a waiter blocks (retrying) before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Delay between retry attempts while waiting for a held lock. */
const POLL_INTERVAL_MS = 200;
/**
 * Windows only (#3679): how many times `acquireCloneLockAtPath` retries
 * after a create fails with `EPERM`/`EACCES` before it rethrows the error
 * of the last failing create, so a run that never succeeds makes this
 * many plus one create attempts. About 3 seconds at
 * {@link POLL_INTERVAL_MS}: intended to outlast a brief transient
 * condition (its cause is unconfirmed) while a real permission problem
 * still fails far sooner than the 120 s default deadline.
 */
export const CLONE_LOCK_WINDOWS_DENIED_RETRIES = 15;
const CLONE_LOCK_FLAG_SPEC = {
  '--exec': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--repo': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--timeout-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
/**
 * Mirrors `claim-lock.mts`'s environment sanitization: repository
 * discovery must stay tied to the requested `--repo` path, never to an
 * ambient Git override inherited from a hook, wrapper, or parent process.
 */
function sanitizedGitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  return env;
}
/** Pause before the single retry of a spurious `git rev-parse` exit. */
const SPURIOUS_GIT_EXIT_RETRY_PAUSE_MS = 25;
/**
 * `true` only for the one shape a spurious spawn failure took on native
 * Windows CI: `status` exactly `1` and a whitespace-only `stderr` string. A
 * real failure of a read-only `git rev-parse` query prints a `fatal:`
 * diagnostic (a removed worktree or broken gitfile exits `128`), so every
 * other shape fails closed: any other or a null/missing `status` (signal,
 * spawn error, timeout), any non-whitespace `stderr`, and a missing or
 * non-string `stderr` (for example a Buffer from a spawn made without an
 * `encoding`), which cannot be shown to be empty.
 */
function isSpuriousGitExit(error) {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const { status, stderr } = error;
  return status === 1 && typeof stderr === 'string' && stderr.trim() === '';
}
/**
 * Run a read-only `git rev-parse` query (`run`) and retry it exactly once,
 * after one fixed {@link SPURIOUS_GIT_EXIT_RETRY_PAUSE_MS} pause, when its
 * first attempt fails with a spurious exit ({@link isSpuriousGitExit}). The
 * retry's own result is the one used -- whatever stdout the failed attempt
 * carried is discarded, because a spurious exit can still have printed a
 * wrong or partial answer -- and a second failure throws the retry's own
 * error unchanged. Every other failure throws its original error at once.
 *
 * Observed 2026-09-30 (kurone-kito/idd-skill#3664, Windows runs
 * `36722864806` and `36736676813`): up to 16 acquirer threads each
 * spawning `git` made one `rev-parse` exit `1` with empty stderr (once
 * with the correct path still on stdout), failing the same-claim-id race
 * probe. Only `git rev-parse` queries are safe to retry blindly, because
 * they are read-only; never wrap a mutating git call in this.
 */
export function retryOnSpuriousGitExit(run) {
  try {
    return run();
  } catch (error) {
    if (!isSpuriousGitExit(error)) {
      throw error;
    }
  }
  sleepSync(SPURIOUS_GIT_EXIT_RETRY_PAUSE_MS);
  return run();
}
/**
 * Resolve the lock file's path inside the clone's *shared* git-admin
 * directory (`--git-common-dir`, not `--absolute-git-dir`) so every
 * worktree of the same clone resolves to the identical path. The spawn is
 * retried once on a spurious exit ({@link retryOnSpuriousGitExit}).
 */
export function resolveCloneLockPath(repoPath) {
  const gitCommonDir = retryOnSpuriousGitExit(() =>
    execFileSync(
      'git',
      [
        '-C',
        repoPath,
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ],
      { encoding: 'utf8', env: sanitizedGitEnvironment() },
    ),
  ).trim();
  return join(gitCommonDir, CLONE_LOCK_FILE_NAME);
}
/**
 * A `pid` must be a positive-integer-shaped number, not merely
 * `typeof pid === 'number'` -- POSIX gives `0` and negative values
 * special meaning to `kill()` (process group / all processes / signal
 * -to-everyone), so a `0`, negative, `NaN`, or non-integer value must
 * never reach {@link isPidAlive}'s `process.kill(pid, 0)` call, even
 * though that call is diagnostic-only now (see this module's header
 * comment) and not a takeover decision.
 */
function isValidPid(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function isCloneLockBody(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPid(value.pid) &&
    typeof value.token === 'string' &&
    typeof value.agentId === 'string' &&
    typeof value.acquiredAt === 'string'
  );
}
function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'absent' };
    }
    return { status: 'malformed' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed' };
  }
  return isCloneLockBody(parsed)
    ? { status: 'present', lock: parsed }
    : { status: 'malformed' };
}
function renderLockBody(agentId, token) {
  const body = {
    pid: process.pid,
    token,
    agentId,
    acquiredAt: new Date().toISOString(),
  };
  return JSON.stringify(body);
}
function randomToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
/**
 * Blocking, synchronous sleep -- portable across POSIX and Windows, no
 * external process spawn. Used to back off between poll attempts.
 */
function sleepSync(ms) {
  const sharedBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sharedBuffer), 0, 0, ms);
}
/**
 * `true` when `pid` identifies a currently-running process, `false` when
 * it definitely does not. `process.kill(pid, 0)` sends no actual signal
 * -- it only probes existence/permission. `ESRCH` (no such process) is
 * the only outcome that means dead; `EPERM` (the process exists but this
 * one lacks permission to signal it) and success both mean alive.
 * Diagnostic only (see this module's header comment): this is never
 * consulted to decide whether a lock may be taken over, only to help a
 * human reading {@link checkCloneLock}'s or a timeout error's output
 * judge whether the recorded holder is actually still running.
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
/**
 * Exclusively create the lock file, succeeding only when nothing else won
 * the race first. This is the ONLY decision authority for who acquires
 * this lock -- there is no removal or recreation path a defect could
 * hide in (see this module's header comment for the three prior designs
 * that tried to add one, and why each was abandoned).
 *
 * `EEXIST` means another holder won the round. On Windows only (read from
 * `process.platform` each time this runs, #3679), an `EPERM` or `EACCES`
 * from the create is reported as `denied`, "did not acquire this round",
 * so the caller's loop can retry a bounded number of times instead of
 * letting the error escape. That adds no takeover, no removal, and no
 * second coordination path: the operating system's create is still the
 * only authority. Every other error, and every error on POSIX, is thrown
 * at once.
 */
function tryExclusiveCreate(path, agentId, token) {
  try {
    writeFileSync(path, renderLockBody(agentId, token), { flag: 'wx' });
    return { kind: 'created' };
  } catch (error) {
    const code = error.code;
    if (code === 'EEXIST') {
      return { kind: 'exists' };
    }
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES')
    ) {
      return { kind: 'denied', error: error };
    }
    throw error;
  }
}
/**
 * Reuse a clone lock inherited from `withCloneLock` when a wrapped helper
 * needs to acquire the same mutex again. The path and token are a scoped
 * capability: both must match the live lock file, so an unrelated ambient
 * environment value cannot authorize a bypass.
 */
export function inheritedCloneLockAtPath(path) {
  const inheritedPath = process.env[CLONE_LOCK_PATH_ENV];
  const inheritedToken = process.env[CLONE_LOCK_TOKEN_ENV];
  if (!inheritedPath || !inheritedToken) return null;
  if (resolve(inheritedPath) !== resolve(path)) return null;
  const read = readLock(path);
  return read.status === 'present' && read.lock.token === inheritedToken
    ? { path, token: inheritedToken }
    : null;
}
/**
 * Thrown when a lock cannot be acquired within `timeoutMs`. The message
 * names the lock path and, when readable, the recorded holder's `pid`
 * (and whether that process still appears to be alive) so a human can
 * decide whether to remove the lock by hand -- see this module's header
 * comment for why that manual step, not an automatic takeover, is this
 * module's only stale-lock recovery path.
 */
export class CloneLockTimeoutError extends Error {
  constructor(path, timeoutMs) {
    super(`${describeTimeout(path)} after ${timeoutMs}ms`);
    this.name = 'CloneLockTimeoutError';
  }
}
function describeTimeout(path) {
  const read = readLock(path);
  const base = `timed out waiting for clone lock: ${path}`;
  if (read.status === 'absent') {
    return base;
  }
  if (read.status === 'malformed') {
    return `${base} (lock file exists but could not be parsed; if no process needs it, remove it manually: rm ${path})`;
  }
  const aliveNote = isPidAlive(read.lock.pid)
    ? 'still appears to be running'
    : 'no longer appears to be running';
  return (
    `${base} (held by pid ${read.lock.pid}, agent "${read.lock.agentId}", ` +
    `acquired ${read.lock.acquiredAt}; that process ${aliveNote}. If you have ` +
    `independently confirmed it is safe, remove the lock manually: rm ${path})`
  );
}
/**
 * Block (retrying with backoff) until the clone-scoped lock at `repoPath`
 * is acquired, or throw {@link CloneLockTimeoutError} after `timeoutMs`
 * (on Windows, the error of a still-failing `EPERM`/`EACCES` create is
 * thrown instead; see below).
 * A held lock is never taken over automatically, regardless of how long
 * it has been held or whether its recorded holder process is still
 * running -- see this module's header comment. On Windows, a create that
 * fails with `EPERM` or `EACCES` is retried a bounded number of times
 * ({@link CLONE_LOCK_WINDOWS_DENIED_RETRIES}) and then that error is
 * thrown; that adds no takeover, removal, or second coordination path.
 */
export function acquireCloneLock(
  repoPath,
  agentId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const path = resolveCloneLockPath(repoPath);
  return acquireCloneLockAtPath(path, agentId, timeoutMs);
}
/**
 * Acquire a clone lock when the caller already resolved its path. This is
 * useful for a worktree operation that may remove the worktree while waiting:
 * resolving the path before blocking keeps the mutex usable after that
 * worktree disappears. On Windows, an `EPERM`/`EACCES` from the create is
 * retried a bounded number of times, and the error of the last failing
 * create is thrown instead of {@link CloneLockTimeoutError} when the
 * retries or the deadline run out while the most recent create was denied.
 */
export function acquireCloneLockAtPath(
  path,
  agentId,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const token = randomToken();
  const deadline = Date.now() + timeoutMs;
  // #3679: the current run of consecutive Windows-denied creates and the
  // error of the most recent one. `tryExclusiveCreate` holds no state
  // across attempts, so the bound lives here; a created or `EEXIST`
  // result ends the run.
  let deniedRun = 0;
  let lastDenied = null;
  for (;;) {
    const outcome = tryExclusiveCreate(path, agentId, token);
    if (outcome.kind === 'created') {
      return { path, token };
    }
    if (outcome.kind === 'denied') {
      deniedRun += 1;
      lastDenied = outcome.error;
      if (deniedRun > CLONE_LOCK_WINDOWS_DENIED_RETRIES) {
        throw outcome.error;
      }
    } else {
      deniedRun = 0;
      lastDenied = null;
    }
    if (Date.now() >= deadline) {
      // When the most recent create was denied, no holder is known to
      // exist: throw that error rather than a timeout whose message
      // (through `readLock`) would report a lock file that cannot be
      // parsed and tell the operator to delete it by hand.
      throw lastDenied ?? new CloneLockTimeoutError(path, timeoutMs);
    }
    sleepSync(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}
/**
 * Release a lock previously returned by {@link acquireCloneLock}. Only
 * removes the file when it still holds the caller's own `token` -- a
 * defensive check against releasing a lock this handle no longer
 * actually owns; in practice, since this module never takes over a held
 * lock automatically, the token can only ever mismatch after a human
 * has manually removed and something else has since recreated it.
 * Removing an already-absent lock is a silent no-op.
 */
export function releaseCloneLock(handle) {
  const read = readLock(handle.path);
  if (read.status === 'present' && read.lock.token === handle.token) {
    try {
      unlinkSync(handle.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
/** Read-only lock inspection: never creates, mutates, or deletes the lock. */
export function checkCloneLock(repoPath) {
  const path = resolveCloneLockPath(repoPath);
  const read = readLock(path);
  if (read.status === 'absent') {
    return { path, present: false };
  }
  if (read.status === 'malformed') {
    return { path, present: true, malformed: true };
  }
  return {
    path,
    present: true,
    holder: read.lock,
    holderAlive: isPidAlive(read.lock.pid),
  };
}
/**
 * Acquire the clone lock, run `command` with `args` (inheriting stdio,
 * `cwd` set to `repoPath` so the wrapped git operation always targets the
 * same repository the lock scopes, and the same
 * {@link sanitizedGitEnvironment} used to resolve the lock path itself --
 * an ambient `GIT_DIR`/`GIT_WORK_TREE` the caller happened to have set
 * must not redirect the wrapped command at a different repository than
 * the one just locked), then release the lock -- even if the command
 * fails. Returns the command's exit code (`null` when it was killed by a
 * signal).
 */
export async function withCloneLock(
  repoPath,
  agentId,
  command,
  args,
  timeoutMs = DEFAULT_TIMEOUT_MS,
) {
  const handle = acquireCloneLock(repoPath, agentId, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'inherit',
        cwd: repoPath,
        env: {
          ...sanitizedGitEnvironment(),
          [CLONE_LOCK_PATH_ENV]: handle.path,
          [CLONE_LOCK_TOKEN_ENV]: handle.token,
        },
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
  } finally {
    releaseCloneLock(handle);
  }
}
/**
 * Everything after a literal `--` token is the wrapped command and its
 * arguments, passed through untouched -- `parseCliArgs` parses only the
 * flags before it (it never accepts positionals itself).
 */
function splitAtDoubleDash(argv) {
  const index = argv.indexOf('--');
  if (index === -1) {
    return { flags: argv, command: [] };
  }
  return { flags: argv.slice(0, index), command: argv.slice(index + 1) };
}
function parseArgs(argv) {
  const { flags, command } = splitAtDoubleDash(argv);
  const { values, help } = parseCliArgs(flags, CLONE_LOCK_FLAG_SPEC);
  const rawTimeout = values['timeout-ms'];
  let timeoutMs = null;
  if (typeof rawTimeout === 'string') {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw markCliUsageError(
        new Error('--timeout-ms must be a positive integer'),
      );
    }
    timeoutMs = parsed;
  }
  return {
    exec: Boolean(values.exec),
    check: Boolean(values.check),
    repo: typeof values.repo === 'string' ? values.repo : null,
    agentId: typeof values['agent-id'] === 'string' ? values['agent-id'] : null,
    timeoutMs,
    help,
    command,
  };
}
async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.exec === args.check) {
    throw markCliUsageError(
      new Error('exactly one of --exec or --check is required'),
    );
  }
  const repo = args.repo ?? process.cwd();
  if (args.check) {
    process.stdout.write(`${JSON.stringify(checkCloneLock(repo))}\n`);
    return 0;
  }
  if (args.agentId === null) {
    throw markCliUsageError(new Error('--agent-id is required for --exec'));
  }
  if (args.command.length === 0) {
    throw markCliUsageError(new Error('--exec requires a command after `--`'));
  }
  const [command, ...commandArgs] = args.command;
  try {
    const status = await withCloneLock(
      repo,
      args.agentId,
      command,
      commandArgs,
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    return status ?? 1;
  } catch (error) {
    if (error instanceof CloneLockTimeoutError) {
      process.stderr.write(`${error.message}\n`);
      return 3;
    }
    throw error;
  }
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/clone-lock.mjs --exec --agent-id <id> [--repo <path>] [--timeout-ms <n>] -- <command> [args...]
  node scripts/clone-lock.mjs --check [--repo <path>]

Clone-scoped mutual-exclusion lock: serializes \`git worktree add\`,
\`git worktree remove\`, and \`git fetch\` against the shared primary
clone across concurrent sessions. \`--exec\` blocks (retrying) until the
lock is acquired, runs <command> [args...] with stdio inherited and cwd
set to --repo, then releases the lock -- even if the command fails --
and exits with the command's own exit code. A held lock is NEVER taken
over automatically, regardless of how long it has been held: exits 3 if
the lock could not be acquired within --timeout-ms (default 120000),
naming the lock path and its recorded holder's pid in the error message.
If you have independently confirmed that holder is actually gone,
remove the lock file by hand and retry -- the same recovery git's own
\`index.lock\` expects on a stale-lock collision.

--check is read-only: it reports the current lock state without
creating, mutating, or deleting anything. \`malformed: true\` means a
lock file exists but could not be parsed as a well-formed lock body;
\`holderAlive\` reports whether the recorded pid still appears to be
running (diagnostic only). Neither case is ever auto-recovered.

--repo defaults to the current working directory.
`);
}
// This bootstrap call is placed after every declaration in this module,
// not near the top -- `runCli()`'s error path references the
// `CloneLockTimeoutError` class declared earlier in this file, and a
// class binding (unlike a hoisted function declaration) stays in its
// temporal dead zone until its own declaration statement executes.
// Invoking `runCli()` before that point (e.g. from the top of the file)
// would throw a `ReferenceError` on any `--exec` timeout instead of the
// documented message and exit code 3.
if (import.meta.main) {
  // #3343: call runCli() directly when the envelope is disabled -- see
  // applyHelperCliOutcomeWhenDisabled's own doc comment for why, including
  // the async-specific .then() note.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('clone-lock', runCli);
  } else {
    runCli().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}
