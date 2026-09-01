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
// A holder that crashes leaves an orphaned lock file behind -- unlike a
// real `flock(2)`, a plain lock file is not released automatically when
// its owning process dies. Staleness is judged by process liveness
// (`isPidAlive`, `process.kill(pid, 0)`), not elapsed time: the lock body
// records the holder's own `pid`, alongside `claim-lock.mts`'s existing
// `token`/`agentId`/`acquiredAt` shape, and a lock is only ever eligible
// for takeover once that exact PID is confirmed dead. This replaced an
// earlier mtime-based design (recover anything older than a fixed
// threshold, with the holder periodically refreshing its own lease to
// prove it was still alive) after that design's CI run exposed the
// failure mode it was always structurally prone to: a live,
// actively-refreshing holder got taken over anyway, because "has this
// timestamp aged past a threshold" is inherently a race against ordinary
// process-scheduling jitter (a refresh landing late, a waiter's own
// staleness check landing early) in a way "is this specific PID still
// running" simply is not -- a process is never "probably dead by now,"
// it is either scheduled on the OS right now or it does not exist.
// Because the holder process for this lock (the one running `withExec`'s
// wrapped command) stays alive for its own entire hold, no periodic
// lease refresh is needed at all: liveness is continuously, automatically
// true for as long as the holder is doing anything, and instantly,
// unambiguously false the moment it exits or crashes. This also makes
// release and takeover logically disjoint rather than a race to close:
// release only ever runs from the live holder's own still-running
// process (whose PID is, by definition, alive), so a takeover's PID
// -liveness check can never mistake an active release-in-progress for a
// dead holder -- no arbiter, inode verification, or other coordination
// primitive beyond the plain `wx`-exclusive-create every acquire already
// uses is needed to keep the two from conflicting. A takeover
// re-confirms the lock is still the exact dead entry it inspected
// (re-reading immediately before removing) rather than trusting a
// possibly-stale earlier check, then goes through the SAME
// `{ flag: 'wx' }` primitive a fresh acquire uses to recreate it -- the
// only decision authority for who wins a contested recreate is the OS
// kernel's own `O_EXCL` guarantee, not any bookkeeping this module
// performs itself. One race is knowingly NOT closed: the single-syscall
// gap between that re-confirmation read and the `unlinkSync` that acts
// on it. Closing it fully would need a kernel-level compare-and-swap
// this module does not have access to from plain POSIX file primitives;
// every design this module has tried carries an equivalent residual gap
// somewhere, and the ones that attempted to close this exact one (a
// PID-tagged arbiter lock plus inode-verified recovery) each introduced
// a NEW, worse gap of their own across three consecutive review rounds
// (#2223) rather than actually eliminating it. This narrow, explicitly
// accepted gap is deliberately simpler to reason about than that
// alternative. A malformed lock body (e.g. a crashed partial write) has
// no readable `pid` to check liveness against and is therefore never
// auto-recovered -- `writeFileSync`'s single, small write is atomic in
// practice on every realistic filesystem, so genuinely torn content is
// vanishingly rare, and this module intentionally does not add recovery
// machinery for it; see `--check`'s `malformed: true` output for manual
// diagnosis. This is a purely local liveness heuristic scoped to
// operations that normally complete in seconds -- it carries none of
// `claim-lock.mts`'s GitHub-reverification requirement, because this
// lock has no cross-machine claim-ownership meaning to protect.

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

function isCloneLockBody(value: unknown): value is CloneLockBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).pid === 'number' &&
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
 * one lacks permission to signal it) and success both mean alive. This
 * is a reliable, instantaneous, non-time-based liveness check: unlike an
 * elapsed-time threshold, there is no ambiguity window where a process
 * might be "probably dead by now" -- it either currently exists or it
 * does not.
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
 * `true` when `path` currently holds a well-formed lock whose recorded
 * `pid` is confirmed dead. `false` for an absent, malformed (no `pid` to
 * check -- see this module's header comment for why that edge case is
 * not auto-recovered), or live lock.
 */
function isDeadLock(read: LockReadResult): boolean {
  return read.status === 'present' && !isPidAlive(read.lock.pid);
}

/**
 * Exclusively create the lock file, succeeding only when nothing else won
 * the race first. Both a fresh acquire and a dead-lock takeover funnel
 * through this same primitive, so at most one contender ever wins either
 * path -- the OS kernel's own `O_EXCL` guarantee is the sole decision
 * authority for who wins a contested create.
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
 * Attempt to recover a lock at `path` whose recorded holder is confirmed
 * dead, then immediately recreate it as `agentId`/`token`. Re-reads the
 * lock immediately before removing it, rather than trusting the
 * caller's own (possibly now-stale) check, to narrow -- though, per this
 * module's header comment, not fully close -- the gap between
 * confirming death and acting on it. Returns `false` (never throws for
 * this) when the lock is no longer confirmed dead by the time of the
 * re-check, or recreation lost to an unrelated fresh acquirer in the
 * brief gap after this function's own removal (that acquirer's
 * `wx`-create is exclusive by construction either way, so this is safe
 * regardless of how it resolves).
 */
function tryTakeOverDeadLock(
  path: string,
  agentId: string,
  token: string,
): boolean {
  if (!isDeadLock(readLock(path))) {
    return false;
  }
  if (!isDeadLock(readLock(path))) {
    return false;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  return tryExclusiveCreate(path, agentId, token);
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
 * A lock whose recorded holder PID is confirmed dead (see
 * {@link isPidAlive}) is eligible for takeover via
 * {@link tryTakeOverDeadLock}; a live holder's lock is never taken over,
 * regardless of how long it has been held.
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
    if (tryTakeOverDeadLock(path, agentId, token)) {
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
 * removes the file when it still holds the caller's own `token` -- if a
 * different token is present, another session already took the lock over
 * (necessarily after this caller's own process had already died, since a
 * live holder's lock is never taken over) and this release must not
 * disturb it. Removing an already-absent lock is a silent no-op.
 *
 * This is a plain token-check-then-unlink, unlike a design that must
 * also guard against an in-flight takeover of the SAME still-live lock:
 * that scenario cannot occur here, because release only ever runs from
 * the live holder's own still-running process, and a takeover's PID
 * -liveness check can never mistake a live, currently-executing process
 * for a dead one.
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
 * fails. No periodic lease refresh is needed: this process itself stays
 * alive for the wrapped command's entire run, so the lock's recorded
 * `pid` (this process's own) is continuously, automatically live for as
 * long as the command is running. Returns the command's exit code
 * (`null` when it was killed by a signal).
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
and exits with the command's own exit code. A lock is eligible for
takeover only once its recorded holder process is confirmed dead (not
after any fixed time period); a live holder's lock is never taken over,
however long it is held. Exits 3 if the lock could not be acquired
within --timeout-ms (default 120000).

--check is read-only: it reports the current lock state without
creating, mutating, or deleting anything. \`malformed: true\` means a
lock file exists but could not be parsed as a well-formed lock body --
this is never auto-recovered; delete it manually after confirming no
live process still needs it.

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
