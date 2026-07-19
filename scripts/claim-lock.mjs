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
//
// Re-acquiring a matching claim-id is read-only (no write at all): a
// same-claim-id "reacquire" only needs to confirm nobody else took over,
// never to refresh anything on disk (`acquiredAt` is audit-only -- no code
// path here reads it back to make a decision). An earlier revision deleted
// and recreated the file on every reacquire, which opened a window where an
// unrelated, unauthorized different-claim-id session could slip through a
// fresh `wx` create as if nobody held the lock -- exactly the collision
// this lock exists to catch. Making reacquire read-only removes that window
// entirely on the common fast path. The only path that still writes over an
// existing lock is an authorized `--takeover`, and it replaces the file via
// a same-directory temp-write + `renameSync` rather than unlink-then-create,
// so the lock path is never briefly absent for that path either.
//
// This lock intentionally does not try to perfectly serialize two
// concurrent authorized takeovers of the same worktree -- that is a much
// narrower race than the collision above, and the claim revalidation gate
// (re-reading the GitHub claim-id before every mutation, independent of this
// lock) is the real authority there: GitHub claim parsing is deterministic,
// so only one concurrent takeover's claim-id can actually be the active one,
// regardless of what this local lock file happens to contain.
import { execFileSync } from 'node:child_process';
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';

const CLAIM_LOCK_FILE_NAME = 'idd-claim.lock';
const MAX_RETRY_ATTEMPTS = 5;
const CLAIM_LOCK_FLAG_SPEC = {
  '--acquire': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--worktree': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--takeover': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
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
export function resolveClaimLockPath(worktree) {
  const gitDir = execFileSync(
    'git',
    ['-C', worktree, 'rev-parse', '--absolute-git-dir'],
    { encoding: 'utf8' },
  ).trim();
  return join(gitDir, CLAIM_LOCK_FILE_NAME);
}
function isClaimLockBody(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.agentId === 'string' &&
    typeof value.claimId === 'string' &&
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
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed' };
  }
  return isClaimLockBody(parsed)
    ? { status: 'present', lock: parsed }
    : { status: 'malformed' };
}
function renderLockBody(agentId, claimId) {
  const body = {
    agentId,
    claimId,
    acquiredAt: new Date().toISOString(),
  };
  return JSON.stringify(body);
}
/**
 * Replace `path` with a freshly-rendered lock body without ever leaving it
 * absent: write to a same-directory temp file, then `renameSync` it onto
 * `path`. POSIX `rename` onto an existing target is atomic — readers always
 * see the old or the new content, never a missing file or a partial write —
 * so an unrelated session's fresh `wx` create can never slip through the
 * gap the earlier unlink-then-create design left open. The temp file must
 * live in the same directory as `path` (a cross-filesystem rename is not
 * atomic and can silently fall back to copy+delete); the `finally` cleans it
 * up if `renameSync` itself throws, so a failed replace never leaks it.
 */
function overwriteLockAtomically(path, agentId, claimId) {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, renderLockBody(agentId, claimId), { flag: 'wx' });
  try {
    renameSync(tmpPath, path);
  } finally {
    // Best-effort cleanup only: a successful rename already moved tmpPath
    // away (this is a no-op ENOENT), and a failed rename's own error is
    // what the caller needs to see, so any cleanup failure here is
    // deliberately swallowed rather than masking that original error.
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore
    }
  }
}
/**
 * Acquire (or idempotently re-acquire) the worktree-local claim lock.
 * Safe to call before every mutation, not just once at worktree creation.
 *
 * A matching `claimId` is a pure read: it confirms nobody else holds the
 * lock and returns `acquired`/`reacquired` without writing anything (the
 * fast path — no GitHub round-trip, and no window where the lock briefly
 * disappears). A different `claimId` is always a `collision` unless
 * `takeover` is set, regardless of how long the lock has existed: GitHub's
 * 24h claim-stale-age is the sole staleness authority, so the caller must
 * independently re-verify live claim state (e.g.
 * `resume-claim-routing.mjs --fresh-claim-gate`) before retrying with
 * `takeover: true`.
 */
export function acquireClaimLock(worktree, agentId, claimId, takeover) {
  const path = resolveClaimLockPath(worktree);
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    const read = readLock(path);
    if (read.status === 'present' && read.lock.claimId === claimId) {
      return { mode: 'acquired', path, reacquired: true };
    }
    if (read.status === 'absent') {
      try {
        writeFileSync(path, renderLockBody(agentId, claimId), { flag: 'wx' });
        return { mode: 'acquired', path };
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
        // Raced with a concurrent fresh acquire between the read above and
        // this create; loop around to re-read and re-decide.
        continue;
      }
    }
    // Either a different claim-id, or a malformed body whose holder can't
    // be determined safely: always a same-machine collision either way.
    // Local state (including how old the lock is) never authorizes an
    // override — only an explicit, GitHub-reverified `takeover` may.
    const holder = read.status === 'present' ? read.lock : undefined;
    if (!takeover) {
      return { mode: 'collision', path, holder };
    }
    overwriteLockAtomically(path, agentId, claimId);
    return { mode: 'acquired', path, forcedTakeover: true, holder };
  }
  // Exhausted retries on the narrow absent-then-raced-create loop above.
  return { mode: 'collision', path };
}
/** Read-only lock inspection: never creates, mutates, or deletes the lock. */
export function checkClaimLock(worktree) {
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
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, CLAIM_LOCK_FLAG_SPEC);
  return {
    acquire: Boolean(values.acquire),
    check: Boolean(values.check),
    worktree: typeof values.worktree === 'string' ? values.worktree : null,
    agentId: typeof values['agent-id'] === 'string' ? values['agent-id'] : null,
    claimId: typeof values['claim-id'] === 'string' ? values['claim-id'] : null,
    takeover: Boolean(values.takeover),
    help,
  };
}
function runCli() {
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
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/claim-lock.mjs --acquire --worktree <path> --agent-id <id> --claim-id <id> [--takeover]
  node scripts/claim-lock.mjs --check --worktree <path>

Worktree-local lock file: a same-machine fast path that complements the
cross-machine activation-nonce claim check. Resolves the lock file inside
<path>'s own private git-admin directory (\`git rev-parse
--absolute-git-dir\`), so \`git worktree remove\` deletes it together with
the worktree -- no separate release step is needed.

--acquire is idempotent for a matching --claim-id: it re-acquires
(confirms nobody else holds it) as a pure read, with no write and no GitHub
round-trip -- this is the fast path used before every mutation. A different
--claim-id is always reported as a collision, regardless of how old the
existing lock is: this helper never judges staleness locally. Pass
--takeover only after independently re-verifying live GitHub claim state
(e.g. via \`resume-claim-routing.mjs --fresh-claim-gate\` reporting
\`claimable\` or \`stale-reclaimable\`) to override a collision; \`holder\`
in the JSON output reports the previous occupant on both a plain collision
and an authorized takeover.

--check is read-only: it reports the current lock state without creating,
mutating, or deleting anything. \`malformed: true\` means a lock file
exists but could not be parsed as a well-formed lock body.
`);
}
