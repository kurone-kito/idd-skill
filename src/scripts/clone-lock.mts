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
// same-machine collision immediately (never blocks). This one is a short
// -duration *mutex* around a single git operation -- it blocks (retrying
// with backoff) until it can acquire, up to a bounded timeout, because the
// operations it guards are expected to finish in seconds, not the hours a
// claim can be held for.
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
// automatically when its owning process dies. `STALE_LOCK_MS` bounds how
// long a stuck lock can block every other session: once a lock's recorded
// `acquiredAt` is older than that, a waiter treats it as abandoned and
// force-takes it over. This is a purely local liveness heuristic scoped to
// operations that normally complete in seconds -- it carries none of
// `claim-lock.mts`'s GitHub-reverification requirement, because this lock
// has no cross-machine claim-ownership meaning to protect.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  readFileSync,
  renameSync,
  rmSync,
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
/** A lock older than this is treated as abandoned by a dead holder. */
const STALE_LOCK_MS = 5 * 60_000;

const CLONE_LOCK_FLAG_SPEC = {
  '--exec': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--repo': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--timeout-ms': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

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
 * Force-remove an abandoned (stale or malformed) lock at `path` and
 * install a fresh one, mirroring `claim-lock.mts`'s
 * `overwriteLockAtomically`: write a same-directory temp file, then
 * `renameSync` into place (atomic on POSIX; the existing-file fallback
 * below covers Windows, which requires the destination removed first).
 */
function takeOverLock(path: string, agentId: string, token: string): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, renderLockBody(agentId, token), { flag: 'wx' });
  try {
    try {
      renameSync(tmpPath, path);
    } catch {
      rmSync(path, { recursive: true, force: true });
      renameSync(tmpPath, path);
    }
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort: a successful rename already moved tmpPath away.
    }
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
 * A lock older than `STALE_LOCK_MS` is treated as abandoned and taken
 * over rather than waited out.
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
    const read = readLock(path);

    if (read.status === 'absent') {
      try {
        writeFileSync(path, renderLockBody(agentId, token), { flag: 'wx' });
        return { path, token };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        // Raced with a concurrent acquire between the read and this
        // create; fall through to the wait/retry path below.
      }
    } else if (read.status === 'malformed') {
      // A malformed body's age can't be determined; treat it the same as
      // a fresh, definitely-not-stale lock and wait for it rather than
      // taking it over immediately -- an in-progress writer's partial
      // write should not be mistaken for an abandoned lock.
    } else {
      const ageMs = Date.now() - Date.parse(read.lock.acquiredAt);
      if (Number.isFinite(ageMs) && ageMs > STALE_LOCK_MS) {
        takeOverLock(path, agentId, token);
        return { path, token };
      }
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
 * Acquire the clone lock, run `command` with `args` (inheriting stdio),
 * then release the lock -- even if the command fails. Returns the
 * command's exit code (`null` when it was killed by a signal).
 */
export function withCloneLock(
  repoPath: string,
  agentId: string,
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): number | null {
  const handle = acquireCloneLock(repoPath, agentId, timeoutMs);
  try {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) {
      throw result.error;
    }
    return result.status;
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

function runCli(): void {
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
    const status = withCloneLock(
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
lock is acquired, runs <command> [args...] with stdio inherited, then
releases the lock -- even if the command fails -- and exits with the
command's own exit code. A lock held longer than 5 minutes is treated
as abandoned by a dead holder and taken over rather than waited out.
Exits 3 if the lock could not be acquired within --timeout-ms
(default 120000).

--check is read-only: it reports the current lock state without
creating, mutating, or deleting anything. \`malformed: true\` means a
lock file exists but could not be parsed as a well-formed lock body.

--repo defaults to the current working directory.
`);
}
