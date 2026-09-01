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
// A holder that crashes mid-operation leaves an orphaned lock file behind
// -- unlike a real `flock(2)`, a plain lock file is not released
// automatically when its owning process dies. Staleness is judged by the
// lock file's own mtime, not the `acquiredAt` field inside its JSON body
// -- so a malformed lock (e.g. a crashed partial write, which can never
// be parsed back into a valid `acquiredAt`) ages out and recovers exactly
// like a well-formed one, instead of blocking every future waiter
// forever. `STALE_LOCK_MS` bounds how long an abandoned lock can block
// every other session; `withCloneLock`'s `--exec` path refreshes its own
// lease (rewrites the file, which bumps its mtime) at roughly half that
// interval while the wrapped command runs, so a legitimately
// long-running operation is never mistaken for a dead holder.
//
// Recovering a stale lock is NOT simply "remove it, then race the usual
// exclusive-create": two contenders can independently observe the same
// stale mtime, and neither a plain `unlinkSync` nor a plain `renameSync`
// on its own verifies the file it removes is still the exact entry that
// was checked -- both happily remove whatever a faster contender already
// replaced it with (including that contender's brand-new, non-stale
// lock), letting more than one contender believe it took over (this
// repository's own review history on #2223 caught and reproduced exactly
// that double-winner failure from an earlier `renameSync`-only attempt at
// this fix, roughly one run in ten under concurrent load). The real fix
// is a second, PID-tagged arbiter lock (`tryAcquireArbiter`): every
// operation that mutates an EXISTING main lock -- takeover, release,
// refresh -- runs only while holding it, so at most one contender is
// ever doing that at a time, regardless of how many independently
// observed the same stale mtime or the same token. Release and refresh
// need this too, not only takeover: without it, a holder whose own
// process stalled long enough for its lease to go stale and get taken
// over by someone else could read a stale-but-still-matching token, then
// delete or overwrite the NEW holder's fresh lock in the gap before its
// own act (unlink or write) runs -- this repository's review history on
// #2223 caught this as a separate gap from takeover's own, in the SAME
// round that also caught takeover's residual double-winner race (an
// earlier `renameSync`-only takeover attempt, with no arbiter at all,
// reproduced roughly one run in ten under concurrent load). The
// arbiter's own staleness is judged primarily by process liveness
// (`isPidAlive`), not a time threshold, because its critical section is
// always a handful of synchronous, no-I/O-wait statements -- "the
// recorded PID no longer exists" is both necessary and sufficient to
// know its holder crashed and can never finish or release it, with none
// of a time threshold's inherent "probably dead by now" ambiguity; a
// marker whose body can't be parsed (no PID to check) falls back to a
// short, generous age threshold instead, so a crash mid-write there
// isn't permanently unrecoverable either. This is a purely local
// liveness heuristic scoped to operations that normally complete in
// seconds -- it carries none of `claim-lock.mts`'s GitHub-reverification
// requirement, because this lock has no cross-machine claim-ownership
// meaning to protect.

import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mts';

/** Shape of the JSON lock body written to disk. */
interface CloneLockBody {
  token: string;
  agentId: string;
  acquiredAt: string;
}

const CLONE_LOCK_FILE_NAME = 'idd-clone.lock';
/** How long a waiter blocks (retrying) before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Delay between retry attempts while waiting for a held lock. */
const POLL_INTERVAL_MS = 200;
/** A lock whose mtime is older than this is treated as abandoned. */
const STALE_LOCK_MS = 5 * 60_000;
/**
 * How often `withCloneLock` refreshes its own lease while the wrapped
 * command runs. Comfortably inside `STALE_LOCK_MS` so a live holder's
 * lease never lapses into apparent staleness between refreshes.
 */
const DEFAULT_LEASE_REFRESH_MS = Math.floor(STALE_LOCK_MS / 2);
/**
 * An arbiter marker whose body can't be parsed (e.g. a crashed partial
 * write) has no recorded PID to check liveness against. Its critical
 * section is always a handful of synchronous, no-I/O-wait statements, so
 * this age threshold only ever needs to be "generous relative to a
 * syscall," not to any real operation's duration -- unlike
 * `STALE_LOCK_MS`, which must outlast a genuine `git fetch`.
 */
const ARBITER_MALFORMED_STALE_MS = 5_000;
/**
 * Bounds how many times {@link releaseCloneLock} / {@link refreshCloneLock}
 * retry a contended arbiter before giving up for this one call. Every
 * arbiter hold in this module is a handful of synchronous statements, so
 * contention clears in microseconds; this is a small, bounded backstop,
 * not a real wait budget. Giving up is safe, not catastrophic: a release
 * that couldn't get in leaves the lock for the module's own
 * staleness+takeover machinery to eventually reclaim, and a refresh that
 * couldn't get in is simply retried on the next heartbeat tick.
 */
const ARBITER_RETRY_ATTEMPTS = 50;
const ARBITER_RETRY_DELAY_MS = 2;

const CLONE_LOCK_FLAG_SPEC = {
  '--exec': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--repo': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--timeout-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/**
 * Mirrors `claim-lock.mts`'s environment sanitization: repository
 * discovery must stay tied to the requested `--repo` path, never to an
 * ambient Git override inherited from a hook, wrapper, or parent process.
 */
function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
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

/**
 * Resolve the lock file's path inside the clone's *shared* git-admin
 * directory (`--git-common-dir`, not `--absolute-git-dir`) so every
 * worktree of the same clone resolves to the identical path.
 */
export function resolveCloneLockPath(repoPath: string): string {
  const gitCommonDir = execFileSync(
    'git',
    ['-C', repoPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8', env: sanitizedGitEnvironment() },
  ).trim();
  return join(gitCommonDir, CLONE_LOCK_FILE_NAME);
}

type LockReadResult =
  | { status: 'absent' }
  | { status: 'malformed' }
  | { status: 'present'; lock: CloneLockBody };

function isCloneLockBody(value: unknown): value is CloneLockBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).token === 'string' &&
    typeof (value as Record<string, unknown>).agentId === 'string' &&
    typeof (value as Record<string, unknown>).acquiredAt === 'string'
  );
}

function readLock(path: string): LockReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent' };
    }
    return { status: 'malformed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed' };
  }
  return isCloneLockBody(parsed)
    ? { status: 'present', lock: parsed }
    : { status: 'malformed' };
}

function renderLockBody(agentId: string, token: string): string {
  const body: CloneLockBody = {
    token,
    agentId,
    acquiredAt: new Date().toISOString(),
  };
  return JSON.stringify(body);
}

function randomToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Blocking, synchronous sleep -- portable across POSIX and Windows, no
 * external process spawn. Used to back off between poll attempts.
 */
function sleepSync(ms: number): void {
  const sharedBuffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sharedBuffer), 0, 0, ms);
}

/**
 * The lock file's own mtime age in ms, or `null` when the path doesn't
 * exist (raced away between the caller's failed create and this stat --
 * treated as "not (yet provably) stale"; the caller's next loop
 * iteration re-reads and, finding it absent, wins a fresh acquire).
 * Deliberately reads filesystem mtime rather than the JSON body's
 * `acquiredAt` field: mtime is set by every write (including a crashed,
 * unparseable partial one) and by every lease refresh, so one staleness
 * check works uniformly for a malformed lock, a well-formed one, and a
 * refreshed live one.
 */
function lockAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Exclusively create the lock file, succeeding only when nothing else won
 * the race first. Both a fresh acquire and a stale-lock takeover funnel
 * through this same primitive, so at most one contender ever wins either
 * path.
 */
function tryExclusiveCreate(
  path: string,
  agentId: string,
  token: string,
): boolean {
  try {
    writeFileSync(path, renderLockBody(agentId, token), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Companion path for the PID-tagged arbiter lock that guards a stale
 * -takeover REMOVAL against `path` -- see {@link tryAcquireArbiter}.
 */
function arbiterPath(path: string): string {
  return `${path}.arbiter`;
}

/**
 * `true` when `pid` identifies a currently-running process, `false` when
 * it definitely does not. `process.kill(pid, 0)` sends no actual signal
 * -- it only probes existence/permission. `ESRCH` (no such process) is
 * the only outcome that means dead; `EPERM` (the process exists but this
 * one lacks permission to signal it) and success both mean alive. This
 * is a reliable, instantaneous, non-time-based liveness check -- unlike
 * an mtime-based staleness threshold, there is no ambiguity window where
 * a process might be "probably dead by now": it either currently exists
 * or it does not.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Best-effort remove `path`, falling back to a recursive `rmSync` only
 * for the directory-shaped edge case (a malformed marker or lock that
 * happens to be a directory, not the expected regular file) -- mirroring
 * `claim-lock.mts`'s own takeover path. Every caller of this helper only
 * ever targets a path nothing else can reference (a per-attempt
 * graveyard copy this process alone renamed there), so recursion here is
 * unconditionally safe regardless of what it finds.
 */
function discardBestEffort(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM') {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Best-effort; nothing more can safely be done here.
      }
    }
    // ENOENT and anything else: best-effort, nothing to clean up.
  }
}

/**
 * Called after {@link tryAcquireArbiter}'s inode check finds it grabbed
 * the WRONG file at `graveyardPath` -- not the confirmed-dead marker it
 * verified, but a live contender's fresh claim that happened to replace
 * it in the interim. Restores the live contender's marker to `destPath`
 * whenever possible, rather than discarding it: a discarded marker
 * leaves `destPath` briefly absent for as long as that live contender's
 * ENTIRE arbiter-protected critical section takes to finish, during
 * which a third contender's ordinary fresh `wx`-create can ALSO succeed
 * there, producing two simultaneous believed-arbiters -- exactly the
 * double-winner class of bug this whole mechanism exists to prevent.
 * Restoring narrows that exposure window to roughly the time this one
 * rename-back takes, instead of the live contender's full critical
 * section.
 *
 * The restore itself uses exclusive create (`{ flag: 'wx' }`), not an
 * unconditional `renameSync`, so it can never clobber a THIRD
 * contender's own legitimate claim that already filled the gap `path`
 * exposed the moment this function's caller renamed it away in the
 * first place: if the restore loses that race (`EEXIST`), the live
 * contender's original marker is discarded instead -- its holder does
 * not depend on the marker file continuing to exist to keep running its
 * own already-in-progress critical section (see `tryAcquireArbiter`'s
 * own doc comment), and the slot at `destPath` is by then some OTHER
 * contender's own equally legitimate exclusive claim, which must not be
 * overwritten either.
 */
function restoreOrDiscard(graveyardPath: string, destPath: string): void {
  let content: Buffer | null = null;
  try {
    content = readFileSync(graveyardPath);
  } catch {
    content = null;
  }
  if (content !== null) {
    try {
      writeFileSync(destPath, content, { flag: 'wx' });
      discardBestEffort(graveyardPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      // Lost the restore race to a third contender's own fresh claim;
      // fall through to discarding our accidental grab.
    }
  }
  discardBestEffort(graveyardPath);
}

/**
 * Exclusively acquire the arbiter for one stale-lock-removal attempt
 * against `path`'s main lock, or return `false` when another contender
 * is already arbitrating (or just won a recovery race for a dead
 * arbiter). Every operation this module performs against an EXISTING
 * main lock -- takeover, release, refresh -- runs only while holding
 * this arbiter, which is what actually closes the races a plain
 * check-then-act pair on the main lock cannot: two contenders observing
 * the same stale mtime (or the same token) from independent reads can no
 * longer both proceed to mutate the main lock concurrently, because only
 * one of them ever wins this arbiter first. A genuinely fresh acquire
 * (the main lock path is truly absent) does not need the arbiter at all
 * -- `wx`-create is already exclusive for that case on its own.
 *
 * The arbiter is itself just a `{ flag: 'wx' }` claim recording the
 * arbitrating PID -- exclusive by the same primitive a fresh main-lock
 * acquire uses. Its OWN staleness (an arbiter whose holder crashed
 * mid-arbitration) is judged primarily by {@link isPidAlive}, not a time
 * threshold: the arbitration critical section is always a handful of
 * synchronous, no-I/O-wait statements, so "the recorded PID no longer
 * exists" is both necessary and sufficient to know the holder can never
 * finish or release it. A marker whose body can't be parsed (e.g. a
 * crashed partial write) has no PID to check, so it falls back to
 * `ARBITER_MALFORMED_STALE_MS` age instead, rather than being permanently
 * unrecoverable.
 *
 * The PID (or age) used for that liveness verdict and the inode later
 * verified against are captured from a SINGLE open file descriptor, not
 * two separate reads: reading them separately leaves a gap where the
 * verdict and the inode describe two DIFFERENT files -- a dead PID read
 * moments ago, then (after another contender's own concurrent recovery
 * of that same dead marker completed) a live contender's brand-new
 * marker by the time a second, later read re-opens the path. This
 * repository's own review history on #2223 caught exactly that gap in
 * an earlier revision that read the PID via one `readFileSync(path)`
 * call and the inode via a later, separate `openSync`.
 *
 * Recovering a confirmed-dead marker still races multiple contenders
 * (more than one can independently reach the same dead verdict), so it
 * goes through an inode-verified rename: `renameSync` the marker away,
 * then confirm (via the inode captured together with the liveness
 * verdict above) that what actually got moved is the exact entry
 * inspected, not a live contender's fresh arbiter claim that happened to
 * replace it in the interim. On a mismatch, {@link restoreOrDiscard}
 * puts the wrongly-grabbed file back (via its own exclusive-create race,
 * never an unconditional overwrite) rather than deleting it: this
 * repository's review history on #2223 caught that an earlier revision
 * which discarded a mismatched grab instead left the live contender's
 * marker path briefly absent for as long as that contender's ENTIRE
 * arbiter-protected critical section took to finish, during which a
 * third contender's ordinary fresh `wx`-create could ALSO succeed there
 * -- reproducing the very double-arbiter failure this whole mechanism
 * exists to close, just relocated one level down.
 */
function tryAcquireArbiter(path: string): boolean {
  const marker = arbiterPath(path);
  try {
    writeFileSync(marker, JSON.stringify({ pid: process.pid }), {
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
  }

  let fd: number;
  try {
    fd = openSync(marker, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  let observedIno: number;
  let observedAgeMs: number;
  let holderPid: number | null = null;
  try {
    const stat = fstatSync(fd);
    observedIno = stat.ino;
    observedAgeMs = Date.now() - stat.mtimeMs;
    try {
      const parsed = JSON.parse(readFileSync(fd, 'utf8'));
      if (typeof parsed?.pid === 'number') {
        holderPid = parsed.pid;
      }
    } catch {
      // Malformed body -- judged by observedAgeMs below instead.
    }
  } finally {
    closeSync(fd);
  }

  const holderConfirmedDead =
    holderPid !== null
      ? !isPidAlive(holderPid)
      : observedAgeMs > ARBITER_MALFORMED_STALE_MS;
  if (!holderConfirmedDead) {
    return false;
  }

  const graveyard = `${marker}.graveyard-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(marker, graveyard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  let movedIno: number | undefined;
  try {
    movedIno = statSync(graveyard).ino;
  } catch {
    movedIno = undefined;
  }
  if (movedIno === undefined || movedIno !== observedIno) {
    restoreOrDiscard(graveyard, marker);
    return false;
  }
  discardBestEffort(graveyard);

  try {
    writeFileSync(marker, JSON.stringify({ pid: process.pid }), {
      flag: 'wx',
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Release the arbiter acquired via {@link tryAcquireArbiter}. */
function releaseArbiter(path: string): void {
  try {
    unlinkSync(arbiterPath(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Acquire the arbiter for `path`, retrying briefly if another contender
 * currently holds it. See `ARBITER_RETRY_ATTEMPTS`'s own doc comment for
 * why a small bounded retry (not indefinite blocking) is the right
 * shape here.
 */
function acquireArbiterWithRetry(path: string): boolean {
  for (let attempt = 0; attempt < ARBITER_RETRY_ATTEMPTS; attempt += 1) {
    if (tryAcquireArbiter(path)) {
      return true;
    }
    sleepSync(ARBITER_RETRY_DELAY_MS);
  }
  return false;
}

/**
 * Remove the (believed-stale) main lock at `path` and immediately
 * recreate it as `agentId`/`token`, but ONLY while holding the arbiter
 * -- see {@link tryAcquireArbiter} for why that is what makes the plain
 * `unlinkSync` here safe. Re-verifies staleness against `staleMs` once
 * more immediately after winning the arbiter (arbitration itself can
 * take a moment under contention, during which the lock's own live
 * holder may have refreshed its lease, or an unrelated contender may
 * have already recovered it) rather than trusting the caller's earlier,
 * now-possibly-stale check. Returns `false` (never throws for this) when
 * the arbiter itself could not be acquired, the re-check finds the lock
 * no longer stale, or recreation lost to an unrelated fresh acquirer in
 * the brief gap after this function's own removal (vanishingly unlikely,
 * and still safe: that acquirer's `wx`-create is exclusive by
 * construction).
 */
function tryTakeOverStaleLock(
  path: string,
  agentId: string,
  token: string,
  staleMs: number,
): boolean {
  if (!tryAcquireArbiter(path)) {
    return false;
  }
  try {
    const ageMs = lockAgeMs(path);
    if (ageMs === null || ageMs <= staleMs) {
      return false;
    }
    try {
      unlinkSync(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EISDIR' || code === 'EPERM') {
        rmSync(path, { recursive: true, force: true });
      } else if (code !== 'ENOENT') {
        throw error;
      }
    }
    return tryExclusiveCreate(path, agentId, token);
  } finally {
    releaseArbiter(path);
  }
}

/** A held lock: pass to {@link releaseCloneLock} to release it. */
export interface CloneLockHandle {
  path: string;
  token: string;
}

/**
 * Thrown when a lock cannot be acquired within `timeoutMs`.
 */
export class CloneLockTimeoutError extends Error {
  constructor(path: string, timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms waiting for clone lock: ${path}`);
    this.name = 'CloneLockTimeoutError';
  }
}

/**
 * Block (retrying with backoff) until the clone-scoped lock at `repoPath`
 * is acquired, or throw {@link CloneLockTimeoutError} after `timeoutMs`.
 * A lock whose mtime is older than `staleMs` is treated as abandoned;
 * every waiter that notices attempts recovery via
 * {@link tryTakeOverStaleLock}, which holds the PID-tagged arbiter (see
 * {@link tryAcquireArbiter}) for the whole remove-then-recreate sequence
 * so that even when multiple contenders observe the same stale mtime
 * from independent reads, at most one of them ever actually removes and
 * recreates it -- every loser simply continues waiting rather than
 * assuming it acquired. `staleMs` defaults to `STALE_LOCK_MS` and is
 * exposed only for tests that need a short-lived clock; production
 * callers should not override it.
 */
export function acquireCloneLock(
  repoPath: string,
  agentId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  staleMs: number = STALE_LOCK_MS,
): CloneLockHandle {
  const path = resolveCloneLockPath(repoPath);
  const token = randomToken();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryExclusiveCreate(path, agentId, token)) {
      return { path, token };
    }

    const ageMs = lockAgeMs(path);
    if (
      ageMs !== null &&
      ageMs > staleMs &&
      tryTakeOverStaleLock(path, agentId, token, staleMs)
    ) {
      return { path, token };
    }
    // Either not (yet provably) stale, lost the arbiter race to another
    // contender, the arbiter's own re-check found it no longer stale, or
    // -- vanishingly unlikely -- won the takeover but then lost the
    // immediate recreate to an unrelated fresh acquirer; every case
    // falls through to the normal wait/retry path below rather than
    // assuming acquisition.

    if (Date.now() >= deadline) {
      throw new CloneLockTimeoutError(path, timeoutMs);
    }
    sleepSync(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Release a lock previously returned by {@link acquireCloneLock}. Only
 * removes the file when it still holds the caller's own `token` -- if a
 * different token is present, another session already took the lock over
 * (e.g. after this caller's own hold went stale) and this release must
 * not disturb it. Removing an already-absent lock is a silent no-op.
 *
 * The token check and the removal happen while holding the arbiter (see
 * {@link tryAcquireArbiter}), not as two independent steps: without that,
 * a holder whose own process stalled badly enough for its lease to have
 * gone stale and already been taken over by someone else could read a
 * stale-but-still-matching token, then delete the NEW holder's fresh
 * lock in the gap before its own `unlinkSync` runs -- this repository's
 * review history on #2223 caught exactly this gap in an earlier
 * revision. If the arbiter cannot be acquired within a bounded number of
 * retries (see `ARBITER_RETRY_ATTEMPTS`), this call simply gives up
 * rather than releasing incorrectly: an unreleased lock still recovers
 * later through the module's own staleness+takeover machinery, which is
 * safe, whereas releasing without the arbiter's protection would not be.
 */
export function releaseCloneLock(handle: CloneLockHandle): void {
  if (!acquireArbiterWithRetry(handle.path)) {
    return;
  }
  try {
    const read = readLock(handle.path);
    if (read.status === 'present' && read.lock.token === handle.token) {
      try {
        unlinkSync(handle.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }
  } finally {
    releaseArbiter(handle.path);
  }
}

/**
 * Rewrite the lock body at `handle.path`, bumping its mtime, but only
 * when the on-disk token still matches `handle.token` -- this never
 * refreshes (or resurrects) a lock a different session now holds. Used
 * by {@link withCloneLock} to keep a legitimately long-running holder's
 * lease from lapsing into apparent staleness.
 *
 * Like {@link releaseCloneLock}, the token check and the write happen
 * while holding the arbiter, not as two independent steps: without that,
 * a holder whose lease had already gone stale and been taken over by
 * someone else could read a stale-but-still-matching token, then
 * truncate and overwrite the NEW holder's fresh lock with its own token
 * in the gap before its own `writeFileSync` runs -- silently resurrecting
 * a lease that should have stayed lost. If the arbiter cannot be
 * acquired within a bounded number of retries, or the write itself fails
 * (e.g. the path became briefly inaccessible), this call silently gives
 * up: the next heartbeat tick simply retries, and `releaseCloneLock`'s
 * own arbiter-protected token check means a truly lost lease never gets
 * misreported as released.
 */
export function refreshCloneLock(handle: CloneLockHandle): void {
  if (!acquireArbiterWithRetry(handle.path)) {
    return;
  }
  try {
    const read = readLock(handle.path);
    if (read.status === 'present' && read.lock.token === handle.token) {
      try {
        writeFileSync(
          handle.path,
          renderLockBody(read.lock.agentId, handle.token),
        );
      } catch {
        // Best-effort; see the doc comment above.
      }
    }
  } finally {
    releaseArbiter(handle.path);
  }
}

/** Outcome shape returned by {@link checkCloneLock}. */
export interface CheckCloneLockOutcome {
  path: string;
  present: boolean;
  malformed?: boolean;
  holder?: CloneLockBody;
}

/** Read-only lock inspection: never creates, mutates, or deletes the lock. */
export function checkCloneLock(repoPath: string): CheckCloneLockOutcome {
  const path = resolveCloneLockPath(repoPath);
  const read = readLock(path);
  if (read.status === 'absent') {
    return { path, present: false };
  }
  if (read.status === 'malformed') {
    return { path, present: true, malformed: true };
  }
  return { path, present: true, holder: read.lock };
}

/**
 * Acquire the clone lock, run `command` with `args` (inheriting stdio,
 * `cwd` set to `repoPath` so the wrapped git operation always targets the
 * same repository the lock scopes, and the same
 * {@link sanitizedGitEnvironment} used to resolve the lock path itself --
 * an ambient `GIT_DIR`/`GIT_WORK_TREE` the caller happened to have set
 * must not redirect the wrapped command at a different repository than
 * the one just locked), then release the lock -- even if the command
 * fails. While the command runs, the lease is refreshed every
 * `leaseRefreshMs` (default {@link DEFAULT_LEASE_REFRESH_MS}) so a
 * legitimately long-running operation is never mistaken for an abandoned
 * holder by another waiter. Returns the command's exit code (`null` when
 * it was killed by a signal). `staleMs`/`leaseRefreshMs` are exposed only
 * for tests that need a short-lived clock; production callers should not
 * override them.
 */
export async function withCloneLock(
  repoPath: string,
  agentId: string,
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  staleMs: number = STALE_LOCK_MS,
  leaseRefreshMs: number = DEFAULT_LEASE_REFRESH_MS,
): Promise<number | null> {
  const handle = acquireCloneLock(repoPath, agentId, timeoutMs, staleMs);
  const heartbeat = setInterval(() => refreshCloneLock(handle), leaseRefreshMs);
  try {
    return await new Promise<number | null>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'inherit',
        cwd: repoPath,
        env: sanitizedGitEnvironment(),
      });
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
  } finally {
    clearInterval(heartbeat);
    releaseCloneLock(handle);
  }
}

interface ParsedArgs {
  exec: boolean;
  check: boolean;
  repo: string | null;
  agentId: string | null;
  timeoutMs: number | null;
  help: boolean;
  command: string[];
}

/**
 * Everything after a literal `--` token is the wrapped command and its
 * arguments, passed through untouched -- `parseCliArgs` parses only the
 * flags before it (it never accepts positionals itself).
 */
function splitAtDoubleDash(argv: string[]): {
  flags: string[];
  command: string[];
} {
  const index = argv.indexOf('--');
  if (index === -1) {
    return { flags: argv, command: [] };
  }
  return { flags: argv.slice(0, index), command: argv.slice(index + 1) };
}

function parseArgs(argv: string[]): ParsedArgs {
  const { flags, command } = splitAtDoubleDash(argv);
  const { values, help } = parseCliArgs(flags, CLONE_LOCK_FLAG_SPEC);
  const rawTimeout = values['timeout-ms'];
  let timeoutMs: number | null = null;
  if (typeof rawTimeout === 'string') {
    const parsed = Number(rawTimeout);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error('--timeout-ms must be a positive integer');
    }
    timeoutMs = parsed;
  }
  return {
    exec: Boolean(values.exec),
    check: Boolean(values.check),
    repo: typeof values.repo === 'string' ? values.repo : null,
    agentId:
      typeof values['agent-id'] === 'string'
        ? (values['agent-id'] as string)
        : null,
    timeoutMs,
    help,
    command,
  };
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.exec === args.check) {
    throw new Error('exactly one of --exec or --check is required');
  }
  const repo = args.repo ?? process.cwd();

  if (args.check) {
    process.stdout.write(`${JSON.stringify(checkCloneLock(repo))}\n`);
    return;
  }

  if (args.agentId === null) {
    throw new Error('--agent-id is required for --exec');
  }
  if (args.command.length === 0) {
    throw new Error('--exec requires a command after `--`');
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
    process.exitCode = status ?? 1;
  } catch (error) {
    if (error instanceof CloneLockTimeoutError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    throw error;
  }
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/clone-lock.mjs --exec --agent-id <id> [--repo <path>] [--timeout-ms <n>] -- <command> [args...]
  node scripts/clone-lock.mjs --check [--repo <path>]

Clone-scoped mutual-exclusion lock: serializes \`git worktree add\`,
\`git worktree remove\`, and \`git fetch\` against the shared primary
clone across concurrent sessions. \`--exec\` blocks (retrying) until the
lock is acquired, runs <command> [args...] with stdio inherited and cwd
set to --repo, then releases the lock -- even if the command fails --
and exits with the command's own exit code. A lock whose lease has not
been refreshed for 5 minutes is treated as abandoned by a dead holder
and taken over; \`--exec\` refreshes its own lease periodically while
the wrapped command runs, so a legitimately long-running operation is
never mistaken for a dead holder. Exits 3 if the lock could not be
acquired within --timeout-ms (default 120000).

--check is read-only: it reports the current lock state without
creating, mutating, or deleting anything. \`malformed: true\` means a
lock file exists but could not be parsed as a well-formed lock body.

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
  await runCli();
}
