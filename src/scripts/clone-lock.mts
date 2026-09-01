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
// long-running operation is never mistaken for a dead holder. Recovering
// a stale (or malformed-and-stale) lock is two exclusive races, not one:
// first for the right to remove the abandoned entry (`renameSync` on a
// specific source path -- POSIX serializes concurrent renames of the
// same directory entry, so exactly one racer's removal ever succeeds,
// see `tryClaimStaleLockForRemoval`'s own doc comment for why a plain
// check-then-`unlinkSync` pair cannot make this same guarantee), then
// for the right to recreate it (the same `{ flag: 'wx' }` primitive a
// fresh acquire uses). Every loser at either step falls back to the
// normal wait/retry loop rather than assuming it acquired. This is a
// purely local liveness heuristic scoped to operations that normally
// complete in seconds -- it carries none of
// `claim-lock.mts`'s GitHub-reverification requirement, because this lock
// has no cross-machine claim-ownership meaning to protect.

import { execFileSync, spawn } from 'node:child_process';
import {
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
 * Exclusively claim the (believed-stale) lock at `path` for removal, so
 * that even when multiple contenders simultaneously observe the same
 * stale mtime, only one of them ever actually removes it. `renameSync`
 * on a specific SOURCE path is itself the race-free primitive this needs
 * -- POSIX serializes concurrent rename operations against the same
 * directory entry, so among any number of racing
 * `renameSync(path, <unique-destination>)` calls, exactly one succeeds
 * (moving `path` away) and every later call sees `ENOENT`, since by the
 * time it runs `path` no longer exists to rename from. This closes a
 * race a plain check-then-`unlinkSync` pair cannot: two contenders can
 * both observe the same stale mtime from independent reads, and a plain
 * `unlinkSync` never verifies the file it deletes is still the one that
 * was checked -- it happily deletes whatever a faster contender already
 * replaced it with (including that contender's brand new, non-stale
 * lock), letting both contenders believe they won.
 *
 * Returns `false` (a lost race, not an error) on `ENOENT` -- the normal
 * outcome for every contender except the one that actually wins. The
 * destination is a unique per-attempt "graveyard" path so concurrent
 * winners of DIFFERENT stale-lock generations never collide with each
 * other; it is then discarded immediately (`unlinkSync`, with a
 * `recursive: true` `rmSync` fallback for the
 * malformed-lock-is-a-directory edge case `claim-lock.mts`'s own
 * takeover path also handles) -- this cleanup is unconditionally safe
 * regardless of recursion, since nothing else can ever reference this
 * exact path.
 */
function tryClaimStaleLockForRemoval(path: string): boolean {
  const graveyardPath = `${path}.graveyard-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(path, graveyardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  try {
    unlinkSync(graveyardPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EPERM') {
      rmSync(graveyardPath, { recursive: true, force: true });
    } else if (code !== 'ENOENT') {
      throw error;
    }
  }
  return true;
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
 * every waiter that notices races for its removal via
 * {@link tryClaimStaleLockForRemoval} (exactly one ever wins, by
 * construction) and then for its recreation via the same
 * exclusive-create primitive a fresh acquire uses -- every loser at
 * either step simply continues waiting rather than assuming it
 * acquired. `staleMs` defaults to `STALE_LOCK_MS` and is exposed only
 * for tests that need a short-lived clock; production callers should
 * not override it.
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
      tryClaimStaleLockForRemoval(path) &&
      tryExclusiveCreate(path, agentId, token)
    ) {
      return { path, token };
    }
    // Either not (yet provably) stale, lost the removal race to another
    // contender, or -- vanishingly unlikely -- won the removal race but
    // then lost the immediate recreate to an unrelated fresh acquirer;
    // every case falls through to the normal wait/retry path below
    // rather than assuming acquisition.

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
 */
export function releaseCloneLock(handle: CloneLockHandle): void {
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
}

/**
 * Rewrite the lock body at `handle.path`, bumping its mtime, but only
 * when the on-disk token still matches `handle.token` -- this never
 * refreshes (or resurrects) a lock a different session now holds. Used
 * by {@link withCloneLock} to keep a legitimately long-running holder's
 * lease from lapsing into apparent staleness. A read-then-write race
 * against a concurrent stale takeover is inherent to a plain lock file
 * (there is no atomic compare-and-swap primitive here); the default
 * refresh cadence is sized generously relative to the staleness window
 * specifically to make that race vanishingly unlikely to matter in
 * practice. A failed refresh (e.g. the path became briefly inaccessible)
 * is silently swallowed: the next timer tick simply retries, and
 * `releaseCloneLock`'s own token check means a truly lost lease never
 * gets misreported as released.
 */
export function refreshCloneLock(handle: CloneLockHandle): void {
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
 * same repository the lock scopes), then release the lock -- even if the
 * command fails. While the command runs, the lease is refreshed every
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
      const child = spawn(command, args, { stdio: 'inherit', cwd: repoPath });
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
// `CloneLockTimeoutError` class below, and a class binding (unlike a
// hoisted function declaration) stays in its temporal dead zone until its
// own declaration statement executes. Invoking `runCli()` before that
// point would throw a `ReferenceError` on any `--exec` timeout instead of
// the documented message and exit code 3.
if (import.meta.main) {
  runCli();
}
