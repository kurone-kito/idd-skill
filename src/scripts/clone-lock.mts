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

import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mts';

/** Shape of the JSON lock body written to disk. */
interface CloneLockBody {
  pid: number;
  token: string;
  agentId: string;
  acquiredAt: string;
}

const CLONE_LOCK_FILE_NAME = 'idd-clone.lock';
/** How long a waiter blocks (retrying) before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Delay between retry attempts while waiting for a held lock. */
const POLL_INTERVAL_MS = 200;

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

/**
 * A `pid` must be a positive-integer-shaped number, not merely
 * `typeof pid === 'number'` -- POSIX gives `0` and negative values
 * special meaning to `kill()` (process group / all processes / signal
 * -to-everyone), so a `0`, negative, `NaN`, or non-integer value must
 * never reach {@link isPidAlive}'s `process.kill(pid, 0)` call, even
 * though that call is diagnostic-only now (see this module's header
 * comment) and not a takeover decision.
 */
function isValidPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isCloneLockBody(value: unknown): value is CloneLockBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    isValidPid((value as Record<string, unknown>).pid) &&
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
    pid: process.pid,
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
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exclusively create the lock file, succeeding only when nothing else won
 * the race first. This is the ONLY decision authority for who acquires
 * this lock -- there is no removal or recreation path a defect could
 * hide in (see this module's header comment for the three prior designs
 * that tried to add one, and why each was abandoned).
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

/** A held lock: pass to {@link releaseCloneLock} to release it. */
export interface CloneLockHandle {
  path: string;
  token: string;
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
  constructor(path: string, timeoutMs: number) {
    super(`${describeTimeout(path)} after ${timeoutMs}ms`);
    this.name = 'CloneLockTimeoutError';
  }
}

function describeTimeout(path: string): string {
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
 * is acquired, or throw {@link CloneLockTimeoutError} after `timeoutMs`.
 * A held lock is never taken over automatically, regardless of how long
 * it has been held or whether its recorded holder process is still
 * running -- see this module's header comment.
 */
export function acquireCloneLock(
  repoPath: string,
  agentId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): CloneLockHandle {
  const path = resolveCloneLockPath(repoPath);
  const token = randomToken();
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (tryExclusiveCreate(path, agentId, token)) {
      return { path, token };
    }

    if (Date.now() >= deadline) {
      throw new CloneLockTimeoutError(path, timeoutMs);
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

/** Outcome shape returned by {@link checkCloneLock}. */
export interface CheckCloneLockOutcome {
  path: string;
  present: boolean;
  malformed?: boolean;
  holder?: CloneLockBody;
  /** Diagnostic only -- see {@link isPidAlive}'s own doc comment. */
  holderAlive?: boolean;
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
  repoPath: string,
  agentId: string,
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<number | null> {
  const handle = acquireCloneLock(repoPath, agentId, timeoutMs);
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
  await runCli();
}
