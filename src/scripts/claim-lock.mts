#!/usr/bin/env node
// idd-generated-from: src/scripts/claim-lock.mts
//
// The scripts/claim-lock.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Worktree-local lock file: a same-machine fast path that complements the
// cross-machine activation-nonce claim check (#1522). The lock never judges
// staleness itself -- GitHub claim state stays the sole authority. A
// different-claim-id lock is always a collision; only an explicit
// `--takeover`, issued after the caller independently re-verifies live
// GitHub claim state (`resume-claim-routing.mjs --fresh-claim-gate`), may
// override it. This deliberately excludes any local liveness signal (e.g.
// process PID): under this repository's execution model, the process
// invoking this CLI is a one-shot child that exits the moment the call
// returns, so a recorded PID would be a tombstone before any competing
// session could ever observe it as "alive" -- checking it would silently
// defeat the very collision this lock exists to catch. See `## Claim
// revalidation gate` in idd-overview-core.instructions.md for the full
// protocol this helper implements (#1523).

import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mts';

/**
 * Shape of the JSON lock body written to disk. `acquiredAt` is audit-only
 * (surfaced for humans inspecting the file / `--check` output) -- no code
 * path in this module reads it to make a staleness decision.
 */
interface ClaimLockBody {
  agentId: string;
  claimId: string;
  acquiredAt: string;
}

const CLAIM_LOCK_FILE_NAME = 'idd-claim.lock';
const MAX_OVERWRITE_ATTEMPTS = 5;

const CLAIM_LOCK_FLAG_SPEC = {
  '--acquire': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--worktree': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--takeover': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

/**
 * Resolve the lock file's path inside `worktree`'s own private git-admin
 * directory (`git rev-parse --absolute-git-dir`), never a literal
 * `.git/idd-claim.lock` — inside a linked worktree, `.git` is a *file*
 * (a `gitdir:` pointer), not a directory, so that literal path would throw
 * `ENOTDIR`. Using the worktree's own admin dir also means `git worktree
 * remove` deletes the lock together with the worktree, with no separate
 * cleanup step required.
 */
export function resolveClaimLockPath(worktree: string): string {
  const gitDir = execFileSync(
    'git',
    ['-C', worktree, 'rev-parse', '--absolute-git-dir'],
    { encoding: 'utf8' },
  ).trim();
  return join(gitDir, CLAIM_LOCK_FILE_NAME);
}

/**
 * A read of the lock path resolves to exactly one of: absent (no file),
 * malformed (a file exists but is not a well-formed lock body — corrupted
 * write, truncated crash, or foreign content), or a valid parsed body.
 * Callers must never treat `malformed` the same as `absent`: a corrupted
 * lock still means *something* holds this worktree and must be resolved
 * through the same collision path as a genuine different-claim-id lock,
 * never silently skipped or overwritten as if nothing were there.
 */
type LockReadResult =
  | { status: 'absent' }
  | { status: 'malformed' }
  | { status: 'present'; lock: ClaimLockBody };

function isClaimLockBody(value: unknown): value is ClaimLockBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).agentId === 'string' &&
    typeof (value as Record<string, unknown>).claimId === 'string' &&
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
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed' };
  }
  return isClaimLockBody(parsed)
    ? { status: 'present', lock: parsed }
    : { status: 'malformed' };
}

function renderLockBody(agentId: string, claimId: string): string {
  const body: ClaimLockBody = {
    agentId,
    claimId,
    acquiredAt: new Date().toISOString(),
  };
  return JSON.stringify(body);
}

/**
 * Overwrite `path` with a freshly-rendered lock body, atomically: delete the
 * existing file (ignoring `ENOENT` — another session may have already
 * cleaned it up) then create with `wx` (`O_CREAT|O_EXCL`) so a concurrent
 * overwriter racing the same decision is detected instead of silently
 * clobbered. Returns `true` on success, `false` when the inner create lost
 * a race (caller re-reads and re-decides rather than retrying blindly).
 */
function tryAtomicOverwrite(
  path: string,
  agentId: string,
  claimId: string,
): boolean {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  try {
    writeFileSync(path, renderLockBody(agentId, claimId), { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/** Outcome shape returned by {@link acquireClaimLock}. */
export interface AcquireLockOutcome {
  mode: 'acquired' | 'collision' | 'contended';
  path: string;
  reacquired?: boolean;
  forcedTakeover?: boolean;
  holder?: ClaimLockBody;
}

/**
 * Acquire (or idempotently re-acquire) the worktree-local claim lock.
 * Safe to call before every mutation, not just once at worktree creation.
 *
 * A matching `claimId` always re-acquires purely locally (the fast path —
 * no GitHub round-trip). A different `claimId` is always a `collision`
 * unless `takeover` is set, regardless of how long the lock has existed:
 * GitHub's 24h claim-stale-age is the sole staleness authority, so the
 * caller must independently re-verify live claim state (e.g.
 * `resume-claim-routing.mjs --fresh-claim-gate`) before retrying with
 * `takeover: true`.
 */
export function acquireClaimLock(
  worktree: string,
  agentId: string,
  claimId: string,
  takeover: boolean,
): AcquireLockOutcome {
  const path = resolveClaimLockPath(worktree);

  for (let attempt = 0; attempt < MAX_OVERWRITE_ATTEMPTS; attempt += 1) {
    try {
      writeFileSync(path, renderLockBody(agentId, claimId), { flag: 'wx' });
      return { mode: 'acquired', path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }

    const read = readLock(path);
    if (read.status === 'absent') {
      // Raced with a concurrent release/prune between the failed create
      // and this read; loop around to retry the create.
      continue;
    }
    if (read.status === 'present' && read.lock.claimId === claimId) {
      if (tryAtomicOverwrite(path, agentId, claimId)) {
        return { mode: 'acquired', path, reacquired: true };
      }
      continue;
    }

    // Either a different claim-id, or a malformed body whose holder can't
    // be determined safely: always a same-machine collision either way.
    // Local state (including how old the lock is) never authorizes an
    // override — only an explicit, GitHub-reverified `takeover` may.
    const holder = read.status === 'present' ? read.lock : undefined;
    if (!takeover) {
      return { mode: 'collision', path, holder };
    }
    if (tryAtomicOverwrite(path, agentId, claimId)) {
      return { mode: 'acquired', path, forcedTakeover: true, holder };
    }
  }

  return { mode: 'contended', path };
}

/** Outcome shape returned by {@link checkClaimLock}. */
export interface CheckLockOutcome {
  path: string;
  present: boolean;
  malformed?: boolean;
  holder?: ClaimLockBody;
}

/** Read-only lock inspection: never creates, mutates, or deletes the lock. */
export function checkClaimLock(worktree: string): CheckLockOutcome {
  const path = resolveClaimLockPath(worktree);
  const read = readLock(path);
  if (read.status === 'absent') {
    return { path, present: false };
  }
  if (read.status === 'malformed') {
    return { path, present: true, malformed: true };
  }
  return { path, present: true, holder: read.lock };
}

interface ParsedArgs {
  acquire: boolean;
  check: boolean;
  worktree: string | null;
  agentId: string | null;
  claimId: string | null;
  takeover: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, CLAIM_LOCK_FLAG_SPEC);
  return {
    acquire: Boolean(values.acquire),
    check: Boolean(values.check),
    worktree: typeof values.worktree === 'string' ? values.worktree : null,
    agentId:
      typeof values['agent-id'] === 'string'
        ? (values['agent-id'] as string)
        : null,
    claimId:
      typeof values['claim-id'] === 'string'
        ? (values['claim-id'] as string)
        : null,
    takeover: Boolean(values.takeover),
    help,
  };
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.acquire === args.check) {
    throw new Error('exactly one of --acquire or --check is required');
  }
  if (args.worktree === null) {
    throw new Error('--worktree is required');
  }

  if (args.check) {
    process.stdout.write(`${JSON.stringify(checkClaimLock(args.worktree))}\n`);
    return;
  }

  if (args.agentId === null) {
    throw new Error('--agent-id is required for --acquire');
  }
  if (args.claimId === null) {
    throw new Error('--claim-id is required for --acquire');
  }
  const outcome = acquireClaimLock(
    args.worktree,
    args.agentId,
    args.claimId,
    args.takeover,
  );
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/claim-lock.mjs --acquire --worktree <path> --agent-id <id> --claim-id <id> [--takeover]
  node scripts/claim-lock.mjs --check --worktree <path>

Worktree-local lock file: a same-machine fast path that complements the
cross-machine activation-nonce claim check. Resolves the lock file inside
<path>'s own private git-admin directory (\`git rev-parse
--absolute-git-dir\`), so \`git worktree remove\` deletes it together with
the worktree -- no separate release step is needed.

--acquire is idempotent for a matching --claim-id: it re-acquires
(refreshes the lock) purely locally, with no GitHub round-trip -- this is
the fast path used before every mutation. A different --claim-id is always
reported as a collision, regardless of how old the existing lock is: this
helper never judges staleness locally. Pass --takeover only after
independently re-verifying live GitHub claim state (e.g. via
\`resume-claim-routing.mjs --fresh-claim-gate\` reporting \`claimable\` or
\`stale-reclaimable\`) to override a collision.

--check is read-only: it reports the current lock state without creating,
mutating, or deleting anything.
`);
}
