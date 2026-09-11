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
// Fresh-create atomicity (#2920): the very first `--acquire` against an
// absent lock also writes to the lock path, via `createLockFileExclusively`
// below -- a same-directory temp-write + `linkSync` (atomic, EEXIST-exclusive
// hard link), never a direct `writeFileSync(path, ..., { flag: 'wx' })`. A
// direct `wx` create leaves a window between the file becoming visible at
// `path` (open+create) and its content finishing (write) where a concurrent
// `readLock` can observe a torn/partial body and misclassify it as
// `malformed` -- producing a false `collision` result even when the same
// `claimId` is about to win the race. Writing the full body to a temp file
// first (fully written and closed before it is ever linked in) and then
// atomically hard-linking it into place closes that window structurally: a
// concurrent reader can only ever observe "absent" or a fully-formed body at
// `path`, never a partial one. `linkSync` is create-only (no replace
// semantics), so unlike the takeover path's `renameSync` fallback above, it
// needs no Windows-specific recovery branch -- `CreateHardLinkW` fails
// cleanly with `EEXIST` there too when the destination already exists.
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
// Generated-tokens write lock (#2922): `--backfill-tokens` preserves an
// existing record's own `nonce` by reading it, then writing the backfilled
// record back with that captured value -- a read-modify-write with nothing
// serializing it against a concurrent plain `--record-tokens --nonce` call
// (the activation-nonce minting flow's own second write) landing in
// between. Because every write to this file was previously a plain
// `atomicReplaceFile` replace, not a compare-and-swap, that interleaving
// could silently clobber a fresher nonce with the stale value the backfill
// captured moments earlier. Both call sites now share one
// `withGeneratedTokensWriteLock` critical section, keyed by the record's
// own path: a same-directory `.writelock` guard file created via a plain
// `wx`-flag exclusive create (existence alone needs no atomic-visibility
// trick, unlike the claim lock body `linkSync` closes for #2920 above --
// nothing ever reads this guard file's content). This makes the two writers
// fully mutually exclusive rather than merely narrowing the window: a
// concurrent write either completes entirely before the backfill's read
// (and is correctly preserved) or entirely after its write (a normal,
// non-lossy last-writer-wins overwrite), never in between. A guard file
// orphaned by a killed process (rather than released via a normal
// `finally`) fails every future write against that claim-id closed with a
// clear recovery message rather than silently reclaiming itself: an
// earlier revision self-reclaimed a guard old enough (by file modification
// time) to have outlived one full wait budget, but three independent
// reviewers (Codex, Copilot, CodeRabbit) flagged that as its own ABA race
// -- two callers can both classify the same guard as stale, and the
// second's unconditional unlink can delete the first reclaimer's fresh
// replacement (or a still-live holder's own guard), letting both enter
// the critical section at once and reintroducing the exact clobber this
// lock exists to prevent. Closing that safely needs a real
// compare-and-swap or ownership-token primitive this file does not yet
// have, so failing closed -- explicit operator cleanup required -- is the
// safer default for now.
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
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';

const CLAIM_LOCK_FILE_NAME = 'idd-claim.lock';
const GENERATED_TOKENS_FILE_PREFIX = 'idd-generated-tokens';
const MAX_RETRY_ATTEMPTS = 5;
/**
 * Bounded wait budget for the generated-tokens record's own write-lock
 * (#2922, see {@link withGeneratedTokensWriteLock}). Every critical section
 * it guards is a handful of synchronous `fs` calls (real disk I/O, not
 * microseconds-scale, but with no `await` and no external process spawn in
 * between) -- genuine contention is expected to resolve well under this
 * budget; a caller still waiting past it has almost certainly hit a guard
 * file orphaned by a killed process rather than a live holder, so it
 * fails loudly instead of hanging forever.
 */
const GENERATED_TOKENS_WRITE_LOCK_TIMEOUT_MS = 5_000;
const GENERATED_TOKENS_WRITE_LOCK_RETRY_INTERVAL_MS = 5;
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
};
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
function resolveWorktreeAdminDir(cwd) {
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
export function resolveClaimLockPath(worktree) {
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
function sanitizeClaimIdForFilename(claimId) {
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
export function resolveGeneratedTokensPath(cwd, claimId) {
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
    // Any other read failure means the path cannot be trusted as absent or
    // valid (for example EACCES/EPERM, EISDIR, or a transient filesystem
    // error). Fail closed as malformed so callers take the collision path
    // instead of silently bypassing a lock they cannot inspect.
    return { status: 'malformed' };
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
function atomicReplaceFile(path, body, options = {}) {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, body, { flag: 'wx' });
  try {
    try {
      renameSync(tmpPath, path);
    } catch (error) {
      let targetKind = 'unavailable';
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
function overwriteLockAtomically(path, agentId, claimId) {
  atomicReplaceFile(path, renderLockBody(agentId, claimId), {
    replaceDirectory: true,
  });
}
/**
 * Create the lock file at `path` atomically, only when nothing exists there
 * yet (#2920). Writes the full lock body to a same-directory temp file first
 * -- fully written and closed before it is ever linked in -- then
 * `linkSync`s that temp file into `path`. `linkSync` is both atomic and
 * `EEXIST`-exclusive: a losing concurrent caller gets a clean `EEXIST`, never
 * a chance to observe partial content at `path` mid-write, unlike a direct
 * `writeFileSync(path, ..., { flag: 'wx' })` (open+create, then a separate
 * write). Returns `'created'` on success or `'exists'` on a losing race
 * (`EEXIST`); any other error rethrows -- deliberately, rather than falling
 * back to the direct `wx` write this function replaces: a worktree's private
 * git-admin directory lives on the same filesystem as the rest of the git
 * repository, so the mainstream, hard-link-capable filesystems this
 * repository already depends on elsewhere (ext4, APFS, NTFS) cover the
 * supported case. A filesystem that rejects `linkSync` entirely (no
 * hard-link support) fails this call loudly instead of silently
 * reintroducing the exact torn-read race this function exists to close.
 */
function createLockFileExclusively(path, agentId, claimId) {
  const tmpPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmpPath, renderLockBody(agentId, claimId), { flag: 'wx' });
  try {
    linkSync(tmpPath, path);
    return 'created';
  } catch (error) {
    if (error.code === 'EEXIST') {
      return 'exists';
    }
    throw error;
  } finally {
    // Unlike `atomicReplaceFile`'s finally (where a successful `renameSync`
    // already moved `tmpPath` away, making this a no-op ENOENT), a
    // successful `linkSync` here leaves `tmpPath` in place as a second,
    // now-redundant hard link to the same content -- this unlink is what
    // actually removes it. Best-effort: a cleanup failure here never masks
    // a real create/link error, and a leaked temp file is harmless.
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
 * `takeover` is set, regardless of how long the lock has existed: the
 * configured GitHub `claim-stale-age` is the sole staleness authority, so the caller must
 * independently re-verify live claim state (e.g.
 * `resume-claim-routing.mjs --fresh-claim-gate`) before retrying with
 * `takeover: true`.
 *
 * `reacquired: true` from this function's very first read (before this
 * call has attempted any write of its own) means the lock definitely
 * predates this call. Every other path that produces `reacquired: true`
 * -- a later loop iteration, or either post-retry fallback below -- is
 * reached only after this call's own first read found the lock *absent*
 * and its own create attempt then hit `EEXIST`, meaning some concurrent
 * writer created the matching lock while this call was still running.
 * That is a genuine race this call itself observed, not evidence the
 * lock is old, so those paths also set `racedCreate: true` -- a caller
 * treating `reacquired: true` as proof of pre-existence (the
 * `--backfill-tokens` recovery route does) must require `racedCreate` to
 * be absent too (#2917 review, Codex).
 */
export function acquireClaimLock(worktree, agentId, claimId, takeover) {
  const path = resolveClaimLockPath(worktree);
  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    const read = readLock(path);
    if (read.status === 'present' && read.lock.claimId === claimId) {
      return attempt === 0
        ? { mode: 'acquired', path, reacquired: true }
        : { mode: 'acquired', path, reacquired: true, racedCreate: true };
    }
    if (read.status === 'absent') {
      if (createLockFileExclusively(path, agentId, claimId) === 'created') {
        return { mode: 'acquired', path };
      }
      // Raced with a concurrent fresh acquire between the read above and
      // this create; loop around to re-read and re-decide. Any
      // `reacquired: true` this call reports from here on is no longer
      // from its own first look, so it also carries `racedCreate: true`
      // (see the function-level doc comment above).
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
    overwriteLockAtomically(path, agentId, claimId);
    return { mode: 'acquired', path, forcedTakeover: true, holder };
  }
  // Exhausted retries on the narrow absent-then-raced-create loop above.
  // Re-read once after the final EEXIST so a well-formed winner is reported
  // to the caller instead of being returned as an unexplained collision. If
  // the winner disappeared before this read, make one last create attempt so
  // a transiently absent lock is not reported as a false collision. Every
  // return below is reached only after this call's own first read already
  // found the lock absent (that is how the loop above was entered at all),
  // so every `reacquired: true` from here on carries `racedCreate: true`.
  const finalRead = readLock(path);
  if (finalRead.status === 'present' && finalRead.lock.claimId === claimId) {
    return { mode: 'acquired', path, reacquired: true, racedCreate: true };
  }
  if (finalRead.status === 'absent') {
    if (createLockFileExclusively(path, agentId, claimId) === 'created') {
      return { mode: 'acquired', path };
    }
    const racedRead = readLock(path);
    if (racedRead.status === 'present' && racedRead.lock.claimId === claimId) {
      return { mode: 'acquired', path, reacquired: true, racedCreate: true };
    }
    return {
      mode: 'collision',
      path,
      holder: racedRead.status === 'present' ? racedRead.lock : undefined,
    };
  }
  return {
    mode: 'collision',
    path,
    holder: finalRead.status === 'present' ? finalRead.lock : undefined,
  };
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
function isGeneratedTokensBody(value) {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value;
  return (
    typeof candidate.agentId === 'string' &&
    typeof candidate.claimId === 'string' &&
    typeof candidate.recordedAt === 'string' &&
    (candidate.nonce === undefined || typeof candidate.nonce === 'string')
  );
}
/**
 * Block the calling thread for `ms` milliseconds. Node's main thread (unlike
 * a browser UI thread) permits a blocking `Atomics.wait`, so a private,
 * never-`notify`'d `SharedArrayBuffer` slot works as a plain synchronous
 * sleep -- there is no cross-process or cross-thread signalling involved,
 * only a timer, matching this CLI's fully synchronous execution model.
 */
function sleepSyncMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/** Resolve the write-lock guard path for the generated-tokens record at `recordPath`. */
function resolveGeneratedTokensWriteLockPath(recordPath) {
  return `${recordPath}.writelock`;
}
/**
 * Serialize every critical section that reads and/or writes the
 * generated-tokens record at `recordPath` against every other one for that
 * same path (#2922). Closes the race where {@link backfillGeneratedClaimTokens}
 * captures an existing record's `nonce` via {@link readGeneratedClaimTokens},
 * then a concurrent plain write -- the activation-nonce minting flow's own
 * `--record-tokens --nonce` call, via {@link recordGeneratedClaimTokens} --
 * lands in between, and backfill's own subsequent write (a plain
 * {@link atomicReplaceFile} replace, not a compare-and-swap) silently
 * clobbers that fresher nonce with the stale value it captured moments
 * earlier. Both call sites resolve to the same lock path for the same
 * `(cwd, claimId)` pair (they share {@link resolveGeneratedTokensPath}), so
 * true mutual exclusion holds between them: a plain write either completes
 * entirely before backfill's read (and backfill observes it, preserving its
 * nonce correctly) or entirely after backfill's write (and simply
 * overwrites, which is the expected, non-lossy last-writer-wins outcome --
 * never a write landing invisibly *inside* backfill's own read-then-write
 * window).
 *
 * **Scope: writers only, not a general readers/writers lock** (#2922
 * review, Copilot). A standalone {@link readGeneratedClaimTokens} /
 * {@link readGeneratedTokensAtPath} call made *outside* another write's own
 * `critical` callback is never guarded by this lock -- only the two
 * call sites that mutate the record (this file's own `recordGeneratedClaimTokens`
 * and `backfillGeneratedClaimTokens`) participate. On Windows,
 * {@link atomicReplaceFile}'s existing-file branch removes the old target
 * before renaming the replacement in (see that function's own doc
 * comment, and `overwriteLockAtomically`'s identical, pre-existing gap
 * for the claim lock file above), so an unguarded concurrent read can in
 * principle observe a transient `absent` during any write to this record,
 * with or without this lock. That gap predates this lock and is
 * unrelated to the nonce-clobber race it closes; guarding reads too (or
 * changing the read contract to rule out a transient `absent`) is a
 * separate, broader design question out of scope for #2922.
 *
 * `critical` must call only the unlocked write primitive
 * ({@link writeGeneratedClaimTokensRecord}), never the locked
 * {@link recordGeneratedClaimTokens} wrapper -- this guard is not
 * re-entrant, and nesting would deadlock a caller against itself.
 *
 * No *contending* reader ever needs to inspect the guard file's content
 * before the creator finishes writing and closes it -- unlike the claim
 * lock's `linkSync`-based fresh-create fix (#2920), which exists
 * specifically so a *third-party reader* never observes a torn body -- so a
 * plain `wx`-flag exclusive create is sufficient here: POSIX and Windows
 * both make `O_CREAT | O_EXCL` (`CREATE_NEW`) atomic for existence alone,
 * with no partial-content window to close. (This creator's *own* later
 * release does read the body back, to verify the token it wrote at create
 * time is still present -- see {@link releaseGeneratedTokensWriteLockIfOwned}
 * -- #2922 review round 11, Copilot; only a torn-body window relevant to a
 * different reader is what this paragraph rules out.)
 *
 * The create step uses {@link openSync}/{@link writeSync}/{@link closeSync}
 * directly, rather than a single {@link writeFileSync} call, specifically to
 * track ownership precisely (#2922 review round 5, Copilot): only a
 * *successful* `openSync(path, 'wx')` proves this call exclusively created
 * `lockPath` and is its sole owner from that instant on, so only a failure
 * *after* that point (finishing the write, or closing the descriptor) is
 * safe to clean up with an unlink. A failure *at* `openSync` itself (for
 * example `EMFILE`/`ENFILE`, transient descriptor exhaustion) proves the
 * opposite -- nothing was created by this call -- so nothing is touched;
 * unlinking there could delete a different, possibly concurrent, holder's
 * genuine guard, landing right back in the same ABA-race territory as the
 * stale-guard reclaim already removed below. An earlier revision used the
 * single-call `writeFileSync(path, ..., { flag: 'wx' })` form and cleaned
 * up on *any* non-`EEXIST` error, which could not tell these two cases
 * apart.
 *
 * Fails closed after {@link GENERATED_TOKENS_WRITE_LOCK_TIMEOUT_MS} rather
 * than self-reclaiming an aged guard (#2922 review -- Codex, Copilot, and
 * CodeRabbit each independently flagged a since-removed timeout-then-unlink
 * reclaim path as an ABA race: two callers can both classify the same
 * guard as stale, and an unconditional `unlinkSync` by the second can
 * delete the first reclaimer's freshly created replacement -- or a still
 * genuinely live holder's own guard -- letting two callers enter this
 * critical section at once, reintroducing the exact clobber this lock
 * exists to prevent). An orphaned guard (left behind by a process killed
 * between acquiring it and reaching its own `finally` release) therefore
 * requires explicit operator cleanup -- removing the reported path -- per
 * the thrown error's own recovery instructions, rather than an automatic
 * reclaim this codebase cannot yet prove safe without a real
 * compare-and-swap or ownership-token primitive.
 *
 * Both releases below (the `critical()`-failure cleanup and the
 * `critical()`-success release) are **token-verified**, not a bare
 * `unlinkSync(lockPath)` (#2922 review round 10, Copilot): each acquisition
 * writes a fresh random token into the guard body, and release re-reads the
 * guard and only unlinks it when that same token is still present. This
 * mirrors this repository's own existing precedent for exactly this
 * problem -- `releaseCloneLock` in `clone-lock.mts` -- which likewise
 * refuses to remove a lock file whose recorded `token` no longer matches
 * the releasing handle's own. Without this check, a guard manually removed
 * by an operator (per the timeout error's own recovery instructions) while
 * the original holder's `critical()` is still genuinely running could be
 * recreated by a new writer before the original holder's release runs;
 * that release would then delete the *new* writer's guard instead of a
 * guard it actually owns, letting two writers believe they hold exclusive
 * access at once -- the same class of hazard already solved on the
 * acquire side (see the `openSync`/`writeSync`/`closeSync` ownership
 * comment above), now closed on the release side too.
 *
 * This narrows the guard-recreation window rather than eliminating it:
 * the same kind of race could still, in principle, land *between* the
 * token read and the `unlinkSync` call the check guards, because no
 * `wx`-only filesystem primitive gives a true atomic compare-and-delete.
 * Closing that residual sliver would need a real compare-and-swap or
 * `flock(2)`-style primitive this module deliberately avoids taking on
 * (see the header comment). It is accepted as a known limitation: it only
 * matters when a live holder's own guard is manually removed while that
 * holder's `critical()` is still running -- a precondition violation of
 * the timeout error's own recovery instructions -- and #2922's Acceptance
 * Criteria only ever covers nonce-preservation under normal concurrent
 * operation, not safety after an operator has manually intervened on a
 * guard that turns out not to have been actually orphaned.
 */
function withGeneratedTokensWriteLock(recordPath, critical) {
  const lockPath = resolveGeneratedTokensWriteLockPath(recordPath);
  const deadline = Date.now() + GENERATED_TOKENS_WRITE_LOCK_TIMEOUT_MS;
  const token = randomGeneratedTokensWriteLockToken();
  for (;;) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') {
        // `openSync` itself never returned a descriptor, so this call
        // never became the guard's owner -- see the function-level doc
        // comment above for why nothing here is safe to touch.
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for the generated-tokens write lock at ${lockPath}; ` +
            `a crashed holder may have left it behind. Remove ${lockPath} ` +
            `to recover (only safe once you have confirmed no live process ` +
            `still holds it).`,
        );
      }
      sleepSyncMs(GENERATED_TOKENS_WRITE_LOCK_RETRY_INTERVAL_MS);
      continue;
    }
    // `openSync` succeeded: this call exclusively created `lockPath` and
    // is its sole, syscall-proven owner from this point on, so a failure
    // finishing the write below is always safe to clean up.
    try {
      // A single `writeSync(fd, token)` call is not guaranteed to write
      // every byte -- `write(2)` (and thus `writeSync`) may legitimately
      // return fewer bytes than requested without throwing (#2922 review
      // round 12, Codex and Copilot independently). A truncated guard
      // body would then never match `token` again: release's own
      // token-comparison in {@link releaseGeneratedTokensWriteLockIfOwned}
      // would treat it as "not mine" and leave the guard behind forever,
      // even though this call's own write, and the caller's `critical()`,
      // both otherwise succeed -- every later writer for this claim-id
      // then waits the full timeout and fails closed until an operator
      // manually removes it. Loop on the buffer form until every byte is
      // written, the same pattern Node's own `writeFileSync` uses
      // internally for exactly this reason.
      const buffer = Buffer.from(token, 'utf8');
      let written = 0;
      while (written < buffer.length) {
        written += writeSync(fd, buffer, written, buffer.length - written);
      }
    } catch (error) {
      // `writeSync` failing leaves `fd` genuinely still open (a write
      // failure does not close the descriptor), so this is the correct,
      // and only, place to close it for this branch. A bare `unlinkSync`
      // (not the token-verified {@link releaseGeneratedTokensWriteLockIfOwned})
      // is safe here: `critical()` has not run yet, so no wall-clock window
      // has opened in which an operator could have manually removed this
      // still-fresh guard for a different reason to recreate it.
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort: never mask the real error above.
      }
      throw error;
    }
    try {
      closeSync(fd);
    } catch (error) {
      // Do NOT retry `closeSync(fd)` here (#2922 review round 8,
      // Codex): POSIX close() semantics mean the descriptor is no longer
      // ours to touch once this call has been made, whether or not it
      // reported an error -- the kernel may already have recycled that
      // exact descriptor number for something else (for example another
      // thread's own `open()`), so a second close attempt on it here
      // could silently disrupt unrelated I/O elsewhere in the process.
      // A bare `unlinkSync` remains safe for the same reason as the
      // `writeSync` failure branch above: `critical()` has not run yet.
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort: never mask the real error above.
      }
      throw error;
    }
    break;
  }
  let result;
  try {
    result = critical();
  } catch (error) {
    // Best-effort cleanup on a `critical()` failure: a cleanup failure
    // here must never *replace* the real error the caller needs to see,
    // so on a clean cleanup this rethrows `error` verbatim -- a leaked
    // guard file then only costs the next caller a bounded wait before
    // this same fail-closed behavior applies to them too. But when the
    // cleanup *also* fails, report both instead of silently swallowing
    // the second failure (#2922 review round 9, Copilot): the caller
    // would otherwise have no way to learn a guard was left behind until
    // a later, unrelated caller independently discovers it via its own
    // timeout -- minutes or more later, and by a completely different
    // caller than the one whose failure actually caused it. Token-verified
    // (#2922 review round 10, Copilot): see the function-level doc comment
    // above for why this must not be a bare `unlinkSync`.
    try {
      releaseGeneratedTokensWriteLockIfOwned(lockPath, token);
    } catch (cleanupError) {
      const combined = new Error(
        `${error.message} (additionally failed to remove the ` +
          `generated-tokens write lock guard at ${lockPath} during ` +
          `cleanup: ${cleanupError.message})`,
      );
      combined.cause = error;
      throw combined;
    }
    throw error;
  }
  // `critical()` succeeded: do NOT swallow a release failure here (#2922
  // review, Codex). Reporting success while silently leaving the guard
  // behind would give the caller no signal that anything needs recovery
  // -- every subsequent write for this claim-id would otherwise just
  // silently wait out a full timeout before failing, with nothing
  // pointing at the actual cause. Token-verified (#2922 review round 10,
  // Copilot): see the function-level doc comment above.
  releaseGeneratedTokensWriteLockIfOwned(lockPath, token);
  return result;
}
/** Generate a fresh, effectively-unique token for one lock acquisition. */
function randomGeneratedTokensWriteLockToken() {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
/**
 * Release the generated-tokens write-lock guard at `lockPath` only if it
 * still holds `token` -- the token this same acquisition wrote when it
 * created the guard (see {@link withGeneratedTokensWriteLock}'s doc
 * comment for the full ABA rationale and its residual-race caveat). A
 * missing guard (already released, or never observed) and a guard whose
 * token no longer matches (recreated by a different owner) are both
 * treated as "nothing this call may remove" and silently return, mirroring
 * `releaseCloneLock`'s own token-mismatch handling in `clone-lock.mts`. The
 * guard can also disappear *after* this function's own token read confirms
 * ownership but *before* its `unlinkSync` call below runs -- swallow that
 * `ENOENT` the same way (#2922 review round 11, Copilot), matching
 * `releaseCloneLock`'s identical handling at `clone-lock.mts:329-333`:
 * a guard that is simply already gone by the time of the unlink is still
 * "nothing left for this call to remove," not a failure to report.
 */
function releaseGeneratedTokensWriteLockIfOwned(lockPath, token) {
  let body;
  try {
    body = readFileSync(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (body !== token) {
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
/**
 * Read-only inspection of the generated-tokens record for `claimId` at
 * `cwd`'s own private git-admin directory. Never creates, mutates, or
 * deletes anything.
 */
export function readGeneratedClaimTokens(cwd, claimId) {
  return readGeneratedTokensAtPath(
    resolveGeneratedTokensPath(cwd, claimId),
    claimId,
  );
}
/**
 * Path-based counterpart of {@link readGeneratedClaimTokens}, for a caller
 * that has already resolved the record's path and must not re-resolve it
 * (#2922 review, CodeRabbit): `resolveGeneratedTokensPath` shells out to
 * `git rev-parse` via {@link resolveWorktreeAdminDir}, a synchronous child
 * process spawn that can easily cost tens of milliseconds -- re-running it
 * from inside a {@link withGeneratedTokensWriteLock} critical section would
 * needlessly stretch that critical section with work the lock's bounded
 * wait budget doesn't need to account for at all.
 * {@link backfillGeneratedClaimTokens} uses this directly with its own
 * already-resolved `path`, never the
 * public `cwd`-based function above, once inside that lock.
 */
function readGeneratedTokensAtPath(path, claimId) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 'absent', path };
    }
    // Any other read failure means the path cannot be trusted as absent or
    // valid (EACCES/EPERM, EISDIR, a transient filesystem error). Fail
    // closed as malformed, matching {@link readLock}'s own convention.
    return { status: 'malformed', path };
  }
  let parsed;
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
 * file, this exposes no collision/`--takeover` concept of its own: the
 * record is per-claim-id evidence, not a caller-visible mutual-exclusion
 * primitive, so re-invoking (once in the primary worktree at A5 claim time
 * with `{agentId, claimId}`, again with `{agentId, claimId, nonce}` right
 * before the activation-nonce marker posts, and again in the new sibling
 * worktree at B1) is always a safe, expected, idempotent overwrite of the
 * same path. Internally, every write (and {@link backfillGeneratedClaimTokens}'s
 * own read-then-write) is now serialized through
 * {@link withGeneratedTokensWriteLock} (#2922) so a concurrent writer's
 * nonce can never be silently lost -- that locking is this function's own
 * implementation detail, not a contract callers need to coordinate with.
 *

 * Never replaces a directory occupying the resolved path (regression,
 * #2879 review): a matching `idd-claim.lock` authenticates the claim
 * lock, not the token record's own path, and this filename's hash
 * suffix is not collision-proof, so lock authority alone does not prove
 * a directory here is disposable -- unlike `overwriteLockAtomically`'s
 * narrower, GitHub-reverified-takeover-gated grant for the lock file
 * itself (#2917 review, Copilot). {@link backfillGeneratedClaimTokens}
 * reports a distinct `record-blocked` status for exactly this case
 * instead of calling this function at all.
 */
export function recordGeneratedClaimTokens(cwd, fields) {
  const path = resolveGeneratedTokensPath(cwd, fields.claimId);
  withGeneratedTokensWriteLock(path, () => {
    writeGeneratedClaimTokensRecord(path, fields);
  });
  return { path };
}
/**
 * Unlocked write primitive shared by {@link recordGeneratedClaimTokens} and
 * {@link backfillGeneratedClaimTokens} (#2922). Never call this directly
 * from outside {@link withGeneratedTokensWriteLock}'s `critical` callback --
 * it performs no locking of its own, by design, so both callers can share
 * one lock acquisition around their own (possibly read-then-write) critical
 * section without deadlocking against a non-re-entrant guard.
 */
function writeGeneratedClaimTokensRecord(path, fields) {
  const body = {
    agentId: fields.agentId,
    claimId: fields.claimId,
    ...(fields.nonce === undefined ? {} : { nonce: fields.nonce }),
    recordedAt: new Date().toISOString(),
  };
  atomicReplaceFile(path, JSON.stringify(body));
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
 * - Present lock whose `claimId` matches, but a directory already
 *   occupies the generated-tokens record's own path → `record-blocked`.
 *   A matching lock authenticates the *lock*, not this separate path, and
 *   the path's hash suffix is not collision-proof, so lock authority
 *   alone does not prove a directory here is disposable -- this stays
 *   fail-closed rather than deleting it, unlike the lock file's own
 *   GitHub-reverified-takeover-gated directory replacement (#2917
 *   review, Copilot). `--read-tokens` already reports this same
 *   directory-at-path case as `malformed`, so a caller following the
 *   documented gated sequence stops here with no further action needed.
 * - Present lock whose `claimId` matches, and no directory blocks the
 *   record path → writes the generated-tokens record via
 *   {@link writeGeneratedClaimTokensRecord}, using the lock's own `agentId`
 *   and no `nonce` (matching a fresh pre-nonce `--record-tokens` call) →
 *   `backfilled`. If a well-formed record for this exact `claimId`
 *   already exists (outside the documented recovery route, which only ever
 *   reaches this function when `--read-tokens` reported absent/malformed --
 *   meaning no well-formed record exists yet -- so this is a defensive
 *   guard against a caller invoking this function directly against
 *   caller-discipline), its own `nonce` is preserved rather than silently
 *   erased: {@link writeGeneratedClaimTokensRecord} replaces the whole
 *   record, so writing with no `nonce` unconditionally would otherwise
 *   drop an existing one (#2917 review, Copilot). The read that discovers
 *   this existing nonce and the write that preserves it now share one
 *   {@link withGeneratedTokensWriteLock} critical section (#2922), so a
 *   concurrent writer's own fresher nonce can never land invisibly between
 *   them.
 *
 * Performs no GitHub round-trip on any path, matching `--acquire`'s own
 * same-machine, no-network design. Re-invoking after a successful backfill
 * always reports `backfilled` again -- a safe, idempotent overwrite via
 * `writeGeneratedClaimTokensRecord`'s own existing idempotency contract, not
 * a separate `already-present` status.
 */
export function backfillGeneratedClaimTokens(worktree, claimId) {
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
  // The directory check, the nonce-preserving read, and the write below all
  // run inside one write-lock critical section (#2922): without it, a
  // concurrent plain `recordGeneratedClaimTokens` write (e.g. the
  // activation-nonce minting flow's own `--record-tokens --nonce` call)
  // could land between the read and the write, and this function's own
  // subsequent write -- built from the nonce it captured moments earlier --
  // would silently clobber that fresher nonce. See
  // {@link withGeneratedTokensWriteLock} for the full rationale; its
  // `critical` callback here calls only the unlocked
  // {@link writeGeneratedClaimTokensRecord} primitive, never the locked
  // {@link recordGeneratedClaimTokens} wrapper, to avoid deadlocking against
  // this same non-re-entrant guard.
  return withGeneratedTokensWriteLock(path, () => {
    // A directory at the record's own path is never authorized to be
    // replaced here -- see the function-level doc comment above and
    // recordGeneratedClaimTokens's own doc comment.
    try {
      if (statSync(path).isDirectory()) {
        return { status: 'record-blocked', lockPath, path };
      }
    } catch {
      // Absent, or an unreadable non-directory path: fall through and let
      // writeGeneratedClaimTokensRecord's own atomic-write handle it the
      // same way it always has.
    }
    // Preserve an existing well-formed record's own nonce, if any -- see
    // the function-level doc comment above. Uses the already-resolved
    // `path`, not the public cwd-based `readGeneratedClaimTokens` (#2922
    // review, CodeRabbit): that would re-run `resolveGeneratedTokensPath`'s
    // synchronous `git rev-parse` spawn from inside this critical section.
    const existing = readGeneratedTokensAtPath(path, claimId);
    const nonce =
      existing.status === 'present' ? existing.record.nonce : undefined;
    writeGeneratedClaimTokensRecord(path, {
      agentId: read.lock.agentId,
      claimId,
      ...(nonce === undefined ? {} : { nonce }),
    });
    return {
      status: 'backfilled',
      lockPath,
      path,
      agentId: read.lock.agentId,
    };
  });
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, CLAIM_LOCK_FLAG_SPEC);
  return {
    acquire: Boolean(values.acquire),
    check: Boolean(values.check),
    recordTokens: Boolean(values['record-tokens']),
    readTokens: Boolean(values['read-tokens']),
    backfillTokens: Boolean(values['backfill-tokens']),
    worktree: typeof values.worktree === 'string' ? values.worktree : null,
    agentId: typeof values['agent-id'] === 'string' ? values['agent-id'] : null,
    claimId: typeof values['claim-id'] === 'string' ? values['claim-id'] : null,
    nonce: typeof values.nonce === 'string' ? values.nonce : null,
    takeover: Boolean(values.takeover),
    help,
  };
}
/** Exactly one of the five mode flags, for the `runCli` mode-selection error. */
function selectedModeCount(args) {
  return [
    args.acquire,
    args.check,
    args.recordTokens,
    args.readTokens,
    args.backfillTokens,
  ].filter(Boolean).length;
}
function runCli() {
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
function printHelp() {
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
unreadable lock reports \`lock-malformed\`, a lock recorded for a
different claim-id reports \`lock-mismatch\` (naming the actual holder),
and a matching lock whose own record path is blocked by a directory
reports \`record-blocked\` (a matching lock authenticates the lock, not
that separate path, so this stays fail-closed rather than deleting it)
-- all four write nothing. A successful write reports \`backfilled\` and
exits 0; the four failure statuses exit 2, mirroring --acquire's own
collision exit-code contract so a caller can chain
\`--backfill-tokens && --read-tokens\`. Like --acquire, this performs no
GitHub round-trip -- the caller must have already independently confirmed
the live claim-id via GitHub before reaching this recovery step.
Re-invoking after a successful backfill is always a safe, idempotent
overwrite (reports \`backfilled\` again), matching --record-tokens's own
idempotency contract.
`);
}
