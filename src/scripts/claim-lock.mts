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
// a same-directory temp-write + `renameSync` rather than unlink-then-create.
// POSIX replaces an existing regular file atomically; Windows requires that
// regular file to be removed before the rename, so that platform-specific
// fallback necessarily leaves a brief gap. A malformed directory at the lock
// path is the other recovery exception: an authorized takeover removes that
// exact directory before installing the replacement.
//
// This lock intentionally does not try to perfectly serialize two
// concurrent authorized takeovers of the same worktree -- that is a much
// narrower race than the collision above, and the claim revalidation gate
// (re-reading the GitHub claim-id before every mutation, independent of this
// lock) is the real authority there: GitHub claim parsing is deterministic,
// so only one concurrent takeover's claim-id can actually be the active one,
// regardless of what this local lock file happens to contain.
//
// Generated-tokens record (#2719): a second, sibling on-disk artifact in
// the same admin directory, answering a narrower question than the lock
// above -- not "does anyone else hold this worktree" but "did *this*
// session actually generate the agent-id/claim-id it is about to trust,
// on disk, independent of (possibly compacted) conversation memory."
// Keyed by claim-id rather than a single fixed filename because the
// *first* write happens at A5 claim time, before the B1 worktree exists --
// the current cwd is then the primary worktree, whose admin directory is
// shared by every concurrent session in the same clone. A fixed filename
// there would let two sessions generating two different claim-ids clobber
// each other; a claim-id-keyed filename (plus a short content hash suffix,
// so sanitization collapsing two distinct claim-ids to the same string
// still resolves to different paths in all but an astronomically unlikely
// collision -- an 8-hex-char truncated hash cannot make that provably
// impossible) makes that far less likely. B1 repeats the same write into
// the new worktree's own private admin directory once it exists,
// mirroring how `idd-claim.lock` already works there. Unlike the lock,
// this record has no collision or
// `--takeover` concept: it is per-claim-id evidence, not a mutual-exclusion
// primitive, so re-recording (idempotent overwrite) is always safe and
// expected -- both writes above, plus the follow-up write once the
// activation-nonce is minted, target the same path for a given cwd.
//
// This record does not itself replace GitHub claim state as authority.
// The GitHub claim-id parse (`idd-overview-core.instructions.md`'s Claim
// revalidation gate) always stays authoritative for *whether* a claim is
// active; this record answers a narrower question that gate alone cannot:
// whether the claim-id it finds active is one this session actually
// generated, rather than one merely recalled from (possibly compacted)
// conversation context.
//
// Backfill recovery route (#2884): an adopter who upgrades their
// `idd-template/` copy to gain the generated-tokens-record feature while a
// claim already has its B1 worktree (created before this feature existed)
// never reruns the claim-posting sequence or B1, so no generated-tokens
// record is ever created in that worktree -- every subsequent
// `--read-tokens` check then fails closed forever, even though the
// session still legitimately owns the claim (PR #2879 review, Codex P1).
// `--backfill-tokens` closes that gap by trusting the worktree's own
// `idd-claim.lock` file instead of a live GitHub round-trip: that lock
// already carries the legitimate `agentId` for exactly this scenario, and
// is mechanically verifiable on disk rather than relying on the current
// session's own (possibly compacted) recollection. It writes only when
// the lock is present and its own `claimId` matches the caller's
// `--claim-id` exactly; an absent, malformed, or mismatched lock all fail
// closed with a distinct status and write nothing. The caller -- the
// Claim revalidation gate's documented recovery route -- is responsible
// for having already independently confirmed the live claim-id via
// GitHub before ever reaching this step; this command itself never makes
// a GitHub round-trip, matching `--acquire`'s own same-machine, no-network
// design.
//
// Scope of the ownership proof (#2879 review, Codex P1): a `present: true`
// `--read-tokens` result proves "a `--record-tokens` call for this exact
// claim-id landed at this path" -- it does not cryptographically bind that
// call to the specific process or conversation now reading it back, since
// each CLI invocation is a stateless one-shot child (see above) with no
// tracked process/session identity to check against. During the narrow
// A5-to-B1 window, the primary worktree's admin directory is shared by
// every concurrent session in the same clone, so a `--read-tokens` check
// made *against that shared path* is corroborating bootstrap evidence,
// not sole proof of current-session ownership. This is why every caller
// must resolve `--read-tokens`/`--acquire` against its **own current
// cwd** (never an explicit different worktree's path): once B1 creates
// the dedicated worktree, that admin directory is private to the one
// claim/branch it represents, and the pre-mutation claim revalidation
// gate (`idd-overview-core.instructions.md`) already scopes its own
// cwd-vs-claim check to exactly that post-B1 contract (B3, D, E, F2/F3),
// where this record's guarantee is strongest. The existing GitHub
// claim-state, branch-collision, and worktree-local-lock checks remain
// the primary defense against a genuinely different session mutating
// under a claim-id it never generated; this record's own job is narrower
// and complementary: helping *this* session's own memory survive its own
// context compaction, not adjudicating between two sessions.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const GENERATED_TOKENS_FILE_PREFIX = 'idd-generated-tokens';
const MAX_RETRY_ATTEMPTS = 5;
/**
 * Cap on the sanitized-claim-id portion of a generated-tokens filename
 * (see {@link sanitizeClaimIdForFilename}). A claim-id is an opaque
 * token -- forced-handoff recovery can adopt one this process never
 * generated -- so nothing upstream bounds its length; without a cap
 * here, a long enough claim-id pushes the interpolated filename past
 * the filesystem's `NAME_MAX` and `--record-tokens` fails with
 * `ENAMETOOLONG`, permanently blocking the fail-closed ownership gate
 * for that claim (#2879 review, Codex P1). The content-hash suffix
 * already disambiguates, so
 * truncating this prefix costs only human-readability, not safety.
 */
const MAX_SANITIZED_CLAIM_ID_LENGTH = 64;

const CLAIM_LOCK_FLAG_SPEC = {
  '--acquire': { type: 'boolean' },
  '--check': { type: 'boolean' },
  '--record-tokens': { type: 'boolean' },
  '--read-tokens': { type: 'boolean' },
  '--backfill-tokens': { type: 'boolean' },
  '--worktree': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--takeover': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

/**
 * Keep repository discovery tied to the requested worktree rather than to
 * ambient Git overrides inherited from a hook, wrapper, or parent process.
 * Config override variables are cleared as well so a caller cannot redirect
 * repository discovery through an injected config path or parameter. Git's
 * normal system/global config remains available because it may contain a
 * required `safe.directory` exception for shared or mounted worktrees.
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
 * Resolve `cwd`'s own private git-admin directory (`git rev-parse
 * --absolute-git-dir`) — inside a linked worktree, `.git` is a *file* (a
 * `gitdir:` pointer), not a directory, so a literal `.git/...` path would
 * throw `ENOTDIR`. Shared by every path resolved inside this admin
 * directory (the lock file and the generated-tokens record below).
 *
 * When `cwd` is a **linked** worktree (the normal B1-onward case),
 * `git worktree remove` deletes this whole admin directory together with
 * the worktree, with no separate cleanup step required. That guarantee
 * does **not** hold when `cwd` is the **primary** worktree (the A5,
 * pre-B1 generated-tokens record write, #2879 review): the primary
 * worktree's admin directory is never removed by `git worktree remove`,
 * is shared by every concurrent session in the same clone, and persists
 * indefinitely — callers must not assume it is ever cleaned up.
 */
function resolveWorktreeAdminDir(cwd: string): string {
  return execFileSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], {
    encoding: 'utf8',
    env: sanitizedGitEnvironment(),
  }).trim();
}

/**
 * Resolve the lock file's path inside `worktree`'s own private git-admin
 * directory, never a literal `.git/idd-claim.lock` (see
 * {@link resolveWorktreeAdminDir}).
 */
export function resolveClaimLockPath(worktree: string): string {
  return join(resolveWorktreeAdminDir(worktree), CLAIM_LOCK_FILE_NAME);
}

/**
 * Sanitize `claimId` into a filesystem-safe, length-bounded token:
 * anything outside `[A-Za-z0-9._-]` becomes `_`, then the result is
 * truncated to {@link MAX_SANITIZED_CLAIM_ID_LENGTH} characters. Claim-ids
 * already follow that character set and a much shorter length by
 * convention, but neither is assumed -- combined with the content-hash
 * suffix in {@link resolveGeneratedTokensPath}, two distinct claim-ids
 * resolving to the same sanitized filename is astronomically unlikely,
 * even when an out-of-convention claim-id defeats the character-class
 * sanitization and the length cap both (the truncated 8-hex-char hash
 * makes this vanishingly improbable, not provably impossible).
 */
function sanitizeClaimIdForFilename(claimId: string): string {
  return claimId
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_SANITIZED_CLAIM_ID_LENGTH);
}

/**
 * Resolve the generated-tokens record's path inside `cwd`'s own private
 * git-admin directory, sibling to `idd-claim.lock` (see
 * {@link resolveWorktreeAdminDir}). Keyed by `claimId` rather than a
 * single fixed filename: the first write happens at A5 claim time,
 * before the B1 worktree exists, so `cwd` is then the *primary*
 * worktree — its admin directory is shared by every concurrent session
 * in the same clone. A claim-id-keyed filename means two sessions
 * generating two different claim-ids resolve to different paths (in all
 * but an astronomically unlikely hash-suffix collision, see
 * {@link sanitizeClaimIdForFilename}), even while they momentarily share
 * that admin directory; once B1 creates the sibling worktree, its own
 * private admin directory is unique per worktree anyway (matching
 * `idd-claim.lock`'s existing guarantee), so the same scheme still works
 * there unchanged. A `present: true` result from a `--read-tokens` check
 * against this **shared primary** path is bootstrap evidence only, not
 * proof of current-session ownership by itself — see the header comment's
 * "Generated-tokens record" note and {@link resolveWorktreeAdminDir} for
 * why a caller must always resolve against its **own** current cwd, never
 * an explicit different worktree's path.
 */
export function resolveGeneratedTokensPath(
  cwd: string,
  claimId: string,
): string {
  const sanitized = sanitizeClaimIdForFilename(claimId);
  const contentHash = createHash('sha256')
    .update(claimId, 'utf8')
    .digest('hex')
    .slice(0, 8);
  return join(
    resolveWorktreeAdminDir(cwd),
    `${GENERATED_TOKENS_FILE_PREFIX}-${sanitized}-${contentHash}.json`,
  );
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
    // Any other read failure means the path cannot be trusted as absent or
    // valid (for example EACCES/EPERM, EISDIR, or a transient filesystem
    // error). Fail closed as malformed so callers take the collision path
    // instead of silently bypassing a lock they cannot inspect.
    return { status: 'malformed' };
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
 * Replace `path` with `body`. The temp file is written in the same
 * directory as `path` (a cross-filesystem rename is not atomic), then
 * renamed into place. POSIX `rename` onto an existing regular file is
 * atomic, but Windows does not replace an existing destination, so a regular
 * file must be removed before retrying the rename on that platform. The
 * `finally` cleans up the temp file if `renameSync` throws, so a failed
 * replace never leaks it. Shared by the lock file's authorized-takeover
 * path and the generated-tokens record's always-idempotent write.
 *
 * A directory at `path` is replaced (recursively removed, then the temp
 * file renamed in) **only** when `options.replaceDirectory` is `true` —
 * the authorized-takeover recovery path for a malformed lock directory.
 * Every other caller (including the generated-tokens record's plain
 * idempotent write) must never silently delete an unrelated directory
 * that happens to occupy the resolved path; that case throws instead,
 * surfacing it as a genuine error for the caller to investigate (#2879
 * review).
 */
function atomicReplaceFile(
  path: string,
  body: string,
  options: { replaceDirectory?: boolean } = {},
): void {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, body, { flag: 'wx' });
  try {
    try {
      renameSync(tmpPath, path);
    } catch (error) {
      let targetKind: 'directory' | 'other' | 'unavailable' = 'unavailable';
      try {
        targetKind = statSync(path).isDirectory() ? 'directory' : 'other';
      } catch {
        // Preserve the original rename error when the target disappeared or
        // cannot be inspected safely.
      }
      if (targetKind === 'unavailable') {
        throw error;
      }
      if (targetKind === 'other') {
        // Windows does not let rename replace an existing regular file. Keep
        // the operation scoped to the exact target and retry the
        // same-directory rename. The brief absence is unavoidable on that
        // platform; the caller's GitHub claim gate remains authoritative.
        rmSync(path, { force: true });
        renameSync(tmpPath, path);
        return;
      }
      if (!options.replaceDirectory) {
        throw error;
      }
      rmSync(path, { recursive: true, force: true });
      renameSync(tmpPath, path);
    }
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
 * Replace `path` with a freshly-rendered lock body. Only reached from an
 * authorized `--takeover` (see {@link acquireClaimLock}), which is also
 * the malformed-lock-directory recovery path, so directory replacement is
 * intentionally enabled here; see {@link atomicReplaceFile} for the write
 * mechanics.
 */
function overwriteLockAtomically(
  path: string,
  agentId: string,
  claimId: string,
): void {
  atomicReplaceFile(path, renderLockBody(agentId, claimId), {
    replaceDirectory: true,
  });
}

/** Outcome shape returned by {@link acquireClaimLock}. */
export interface AcquireLockOutcome {
  mode: 'acquired' | 'collision';
  path: string;
  reacquired?: boolean;
  forcedTakeover?: boolean;
  holder?: ClaimLockBody;
}

/**
 * Acquire (or idempotently re-acquire) the worktree-local claim lock.
 * Safe to call before every mutation, not just once at worktree creation.
 *
 * A matching `claimId` is a pure read: it confirms nobody else holds the
 * lock and returns `acquired`/`reacquired` without writing anything (the
 * fast path — no GitHub round-trip, and no window where the lock briefly
 * disappears). A different `claimId` is always a `collision` unless
 * `takeover` is set, regardless of how long the lock has existed: the
 * configured GitHub `claim-stale-age` is the sole staleness authority, so the caller must
 * independently re-verify live claim state (e.g.
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
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
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
  // Re-read once after the final EEXIST so a well-formed winner is reported
  // to the caller instead of being returned as an unexplained collision. If
  // the winner disappeared before this read, make one last create attempt so
  // a transiently absent lock is not reported as a false collision.
  const finalRead = readLock(path);
  if (finalRead.status === 'present' && finalRead.lock.claimId === claimId) {
    return { mode: 'acquired', path, reacquired: true };
  }
  if (finalRead.status === 'absent') {
    try {
      writeFileSync(path, renderLockBody(agentId, claimId), { flag: 'wx' });
      return { mode: 'acquired', path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const racedRead = readLock(path);
      if (
        racedRead.status === 'present' &&
        racedRead.lock.claimId === claimId
      ) {
        return { mode: 'acquired', path, reacquired: true };
      }
      return {
        mode: 'collision',
        path,
        holder: racedRead.status === 'present' ? racedRead.lock : undefined,
      };
    }
  }
  return {
    mode: 'collision',
    path,
    holder: finalRead.status === 'present' ? finalRead.lock : undefined,
  };
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

/**
 * Shape of the JSON generated-tokens record written to disk (#2719).
 * `recordedAt` is audit-only, mirroring {@link ClaimLockBody}'s
 * `acquiredAt` -- no code path here reads it back to make a decision.
 */
interface GeneratedTokensBody {
  agentId: string;
  claimId: string;
  nonce?: string;
  recordedAt: string;
}

function isGeneratedTokensBody(value: unknown): value is GeneratedTokensBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.agentId === 'string' &&
    typeof candidate.claimId === 'string' &&
    typeof candidate.recordedAt === 'string' &&
    (candidate.nonce === undefined || typeof candidate.nonce === 'string')
  );
}

/**
 * A read of the generated-tokens path resolves to exactly one of: absent
 * (never recorded, or recorded for a different claim-id -- a different
 * claim-id resolves to a different path by construction, see
 * {@link resolveGeneratedTokensPath}), malformed (a file exists at the
 * resolved path but is not a well-formed record for that exact claim-id --
 * corrupted write, truncated crash, foreign content, or its own internal
 * `claimId` field disagrees with the path it was found at), or a valid
 * parsed body. Callers must never silently *report* `malformed` as if it
 * were `absent` -- a record that cannot be trusted is a diagnostically
 * distinct state ("something is here but unreadable") from "this claim-id
 * was never recorded", and collapsing the two loses that signal. For the
 * ownership *decision* itself both statuses converge to the same fail-closed
 * outcome (not owned): a caller checking ownership must never trust a
 * claim-id this record does not affirmatively confirm as `present`.
 */
export type GeneratedTokensReadResult =
  | { status: 'absent'; path: string }
  | { status: 'malformed'; path: string }
  | { status: 'present'; path: string; record: GeneratedTokensBody };

/**
 * Read-only inspection of the generated-tokens record for `claimId` at
 * `cwd`'s own private git-admin directory. Never creates, mutates, or
 * deletes anything.
 */
export function readGeneratedClaimTokens(
  cwd: string,
  claimId: string,
): GeneratedTokensReadResult {
  const path = resolveGeneratedTokensPath(cwd, claimId);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'absent', path };
    }
    // Any other read failure means the path cannot be trusted as absent or
    // valid (EACCES/EPERM, EISDIR, a transient filesystem error). Fail
    // closed as malformed, matching {@link readLock}'s own convention.
    return { status: 'malformed', path };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed', path };
  }
  if (!isGeneratedTokensBody(parsed) || parsed.claimId !== claimId) {
    // The claim-id check defends against a would-be hash-suffix collision
    // or manual tampering, not just a missing/corrupt file: a record whose
    // own recorded claim-id disagrees with the one this path was resolved
    // for is never trustworthy evidence for that claim-id.
    return { status: 'malformed', path };
  }
  return { status: 'present', path, record: parsed };
}

/**
 * Write (create or idempotently replace) the generated-tokens record for
 * `claimId` at `cwd`'s own private git-admin directory. Unlike the lock
 * file, this has no collision/`--takeover` concept: the record is
 * per-claim-id evidence, not a mutual-exclusion primitive, so re-invoking
 * (once in the primary worktree at A5 claim time with `{agentId,
 * claimId}`, again with `{agentId, claimId, nonce}` right before the
 * activation-nonce marker posts, and again in the new sibling worktree at
 * B1) is always a safe, expected, idempotent overwrite of the same path.
 */
export function recordGeneratedClaimTokens(
  cwd: string,
  fields: { agentId: string; claimId: string; nonce?: string },
): { path: string } {
  const path = resolveGeneratedTokensPath(cwd, fields.claimId);
  const body: GeneratedTokensBody = {
    agentId: fields.agentId,
    claimId: fields.claimId,
    ...(fields.nonce === undefined ? {} : { nonce: fields.nonce }),
    recordedAt: new Date().toISOString(),
  };
  atomicReplaceFile(path, JSON.stringify(body));
  return { path };
}

/**
 * Outcome shape returned by {@link backfillGeneratedClaimTokens}. `path` is
 * the generated-tokens record's own path, reported on every status
 * (mirroring {@link GeneratedTokensReadResult}'s convention of reporting
 * `path` even when absent/malformed) since it is resolved from `worktree`
 * and `claimId` alone, independent of whether the lock read succeeded.
 * `lockPath` is the separate `idd-claim.lock` path this command reads to
 * decide. `holder` is populated only for `lock-mismatch`, naming the
 * lock's actual (different) claim -- mirroring {@link AcquireLockOutcome}'s
 * own `holder` field on a collision. `agentId` is populated only for
 * `backfilled`, naming the lock-sourced agent-id that was written.
 */
export interface BackfillTokensOutcome {
  status: 'backfilled' | 'lock-absent' | 'lock-malformed' | 'lock-mismatch';
  lockPath: string;
  path: string;
  agentId?: string;
  holder?: ClaimLockBody;
}

/**
 * Recovery route (#2884) for a worktree whose generated-tokens record
 * (#2719) was never created because its B1 worktree predates that
 * feature: reconstruct it from the worktree's own `idd-claim.lock` file,
 * which already carries the legitimate `agentId` for exactly this
 * rollout-gap scenario (PR #2879 review, Codex P1) -- see the header
 * comment's "Backfill recovery route" paragraph for the full rationale.
 *
 * Fails closed -- writes nothing -- unless the lock is present and its
 * own `claimId` matches `claimId` exactly:
 *
 * - Absent lock → `lock-absent`.
 * - Malformed lock (unparseable, or an unreadable path such as a
 *   directory) → `lock-malformed`.
 * - Present lock recorded for a different `claimId` → `lock-mismatch`
 *   (with `holder` naming the actual lock holder, never silently trusted).
 * - Present lock whose `claimId` matches → writes the generated-tokens
 *   record via {@link recordGeneratedClaimTokens}, using the lock's own
 *   `agentId` and no `nonce` (matching a fresh pre-nonce `--record-tokens`
 *   call) → `backfilled`. If a well-formed record for this exact `claimId`
 *   already exists (outside the documented recovery route, which only ever
 *   reaches this function when `--read-tokens` reported absent/malformed --
 *   meaning no well-formed record exists yet -- so this is a defensive
 *   guard against a caller invoking this function directly against
 *   caller-discipline), its own `nonce` is preserved rather than silently
 *   erased: {@link recordGeneratedClaimTokens} replaces the whole record,
 *   so writing with no `nonce` unconditionally would otherwise drop an
 *   existing one (#2917 review, Copilot).
 *
 * Performs no GitHub round-trip on any path, matching `--acquire`'s own
 * same-machine, no-network design. Re-invoking after a successful backfill
 * always reports `backfilled` again -- a safe, idempotent overwrite via
 * `recordGeneratedClaimTokens`'s own existing idempotency contract, not a
 * separate `already-present` status.
 */
export function backfillGeneratedClaimTokens(
  worktree: string,
  claimId: string,
): BackfillTokensOutcome {
  const lockPath = resolveClaimLockPath(worktree);
  const path = resolveGeneratedTokensPath(worktree, claimId);
  const read = readLock(lockPath);

  if (read.status === 'absent') {
    return { status: 'lock-absent', lockPath, path };
  }
  if (read.status === 'malformed') {
    return { status: 'lock-malformed', lockPath, path };
  }
  if (read.lock.claimId !== claimId) {
    return { status: 'lock-mismatch', lockPath, path, holder: read.lock };
  }

  // Preserve an existing well-formed record's own nonce, if any -- see the
  // function-level doc comment above.
  const existing = readGeneratedClaimTokens(worktree, claimId);
  const nonce =
    existing.status === 'present' ? existing.record.nonce : undefined;

  recordGeneratedClaimTokens(worktree, {
    agentId: read.lock.agentId,
    claimId,
    ...(nonce === undefined ? {} : { nonce }),
  });
  return { status: 'backfilled', lockPath, path, agentId: read.lock.agentId };
}

interface ParsedArgs {
  acquire: boolean;
  check: boolean;
  recordTokens: boolean;
  readTokens: boolean;
  backfillTokens: boolean;
  worktree: string | null;
  agentId: string | null;
  claimId: string | null;
  nonce: string | null;
  takeover: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, CLAIM_LOCK_FLAG_SPEC);
  return {
    acquire: Boolean(values.acquire),
    check: Boolean(values.check),
    recordTokens: Boolean(values['record-tokens']),
    readTokens: Boolean(values['read-tokens']),
    backfillTokens: Boolean(values['backfill-tokens']),
    worktree: typeof values.worktree === 'string' ? values.worktree : null,
    agentId:
      typeof values['agent-id'] === 'string'
        ? (values['agent-id'] as string)
        : null,
    claimId:
      typeof values['claim-id'] === 'string'
        ? (values['claim-id'] as string)
        : null,
    nonce: typeof values.nonce === 'string' ? values.nonce : null,
    takeover: Boolean(values.takeover),
    help,
  };
}

/** Exactly one of the five mode flags, for the `runCli` mode-selection error. */
function selectedModeCount(args: ParsedArgs): number {
  return [
    args.acquire,
    args.check,
    args.recordTokens,
    args.readTokens,
    args.backfillTokens,
  ].filter(Boolean).length;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (selectedModeCount(args) !== 1) {
    throw new Error(
      'exactly one of --acquire, --check, --record-tokens, --read-tokens, or --backfill-tokens is required',
    );
  }
  if (args.worktree === null) {
    throw new Error('--worktree is required');
  }

  if (args.check) {
    process.stdout.write(`${JSON.stringify(checkClaimLock(args.worktree))}\n`);
    return;
  }

  if (args.readTokens) {
    if (args.claimId === null) {
      throw new Error('--claim-id is required for --read-tokens');
    }
    const read = readGeneratedClaimTokens(args.worktree, args.claimId);
    const outcome =
      read.status === 'present'
        ? { path: read.path, present: true, record: read.record }
        : read.status === 'malformed'
          ? { path: read.path, present: true, malformed: true }
          : { path: read.path, present: false };
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return;
  }

  if (args.recordTokens) {
    if (args.agentId === null) {
      throw new Error('--agent-id is required for --record-tokens');
    }
    if (args.claimId === null) {
      throw new Error('--claim-id is required for --record-tokens');
    }
    const outcome = recordGeneratedClaimTokens(args.worktree, {
      agentId: args.agentId,
      claimId: args.claimId,
      ...(args.nonce === null ? {} : { nonce: args.nonce }),
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return;
  }

  if (args.backfillTokens) {
    if (args.claimId === null) {
      throw new Error('--claim-id is required for --backfill-tokens');
    }
    const outcome = backfillGeneratedClaimTokens(args.worktree, args.claimId);
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    if (outcome.status !== 'backfilled') {
      process.exitCode = 2;
    }
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
  if (outcome.mode === 'collision') {
    process.exitCode = 2;
  }
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/claim-lock.mjs --acquire --worktree <path> --agent-id <id> --claim-id <id> [--takeover]
  node scripts/claim-lock.mjs --check --worktree <path>
  node scripts/claim-lock.mjs --record-tokens --worktree <path> --agent-id <id> --claim-id <id> [--nonce <nonce>]
  node scripts/claim-lock.mjs --read-tokens --worktree <path> --claim-id <id>
  node scripts/claim-lock.mjs --backfill-tokens --worktree <path> --claim-id <id>

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
\`claimable\`, \`stale-reclaimable\`, or \`already-claimed\` with a
\`winning_claim_id\` that matches a \`claim-id\` the caller has already
independently verified as its own) to override a collision; \`holder\`
in the JSON output reports the previous occupant on both a plain collision
and an authorized takeover.

--check is read-only: it reports the current lock state without creating,
mutating, or deleting anything. \`malformed: true\` means a lock file
exists but could not be parsed as a well-formed lock body.

--record-tokens writes (creating or idempotently replacing) the
generated-tokens record (#2719) for --claim-id at <path>'s own private
git-admin directory -- a sibling artifact to the lock file above, keyed by
claim-id so it is safe to call before the B1 worktree exists (<path> is
then the primary worktree, whose admin directory is shared by every
concurrent session in the same clone). Call it once right after
generating --agent-id/--claim-id, before posting the \`claimed-by\`
marker, and again with --nonce right before posting the activation-nonce
marker. Unlike --acquire, this has no collision concept: re-invoking is
always a safe, expected overwrite.

--read-tokens is read-only: it reports whether --claim-id was actually
recorded on disk by this mechanism, distinguishing \`present\` (a
well-formed record whose own claim-id matches) from \`malformed\` (a
file exists at the resolved path but cannot be trusted as that claim-id's
record) from neither field set, meaning absent -- this claim-id was never
recorded (or was recorded under a different claim-id, which resolves to a
different path). Both \`malformed\` and absent must be treated the same
way by a caller checking ownership: never trust a claim-id this record
does not affirmatively confirm.

--backfill-tokens is the recovery route for a worktree whose
generated-tokens record was never created because its B1 worktree
predates the record feature: it reads the existing \`idd-claim.lock\` file
and, only when present with a --claim-id that matches exactly, writes the
generated-tokens record using the lock's own recorded agent-id, with no
--nonce unless an existing well-formed record for this --claim-id already
carries one, which is preserved rather than erased. An absent lock reports
\`lock-absent\`, an unparseable or
unreadable lock reports \`lock-malformed\`, and a lock recorded for a
different claim-id reports \`lock-mismatch\` (naming the actual holder) --
all three write nothing. A successful write reports \`backfilled\` and
exits 0; the three failure statuses exit 2, mirroring --acquire's own
collision exit-code contract so a caller can chain
\`--backfill-tokens && --read-tokens\`. Like --acquire, this performs no
GitHub round-trip -- the caller must have already independently confirmed
the live claim-id via GitHub before reaching this recovery step.
Re-invoking after a successful backfill is always a safe, idempotent
overwrite (reports \`backfilled\` again), matching --record-tokens's own
idempotency contract.
`);
}
