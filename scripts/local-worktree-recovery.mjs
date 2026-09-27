#!/usr/bin/env node
// idd-generated-from: src/scripts/local-worktree-recovery.mts
//
// The scripts/local-worktree-recovery.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// #3536: consolidates docs/idd-resume-detail.md's §LWR (Local Worktree
// Recovery) steps 1 ("confirm the block"), 3 ("preserve"), and 4 ("remove")
// into a single invocation, composing the existing building-block helpers
// rather than reimplementing their logic:
//
// - Step 1 spawns the compiled `resume-claim-routing.mjs` CLI (network,
//   `gh`-backed) -- `runCli`/`fetchIssueComments` are not exported there, so
//   this mirrors `post-idd-marker.mts`'s own sibling-spawn composition
//   (`runReviewActivitySnapshot`) rather than reimplementing that file's CLI
//   glue. The new helper's own `--worktree` is NEVER forwarded to this
//   spawn -- that flag has an unrelated, documented meaning on
//   `resume-claim-routing.mjs` (an owner-evidence redirect); only
//   `--issue`/`--owner`/`--repo`/`--policy`/`--now` are forwarded.
// - `checkClaimLock` (claim-lock.mts) and `acquireCloneLock`/
//   `releaseCloneLock` (clone-lock.mts) are imported and called in-process
//   -- both are pure/synchronous/network-free, so importing them directly
//   avoids both a redundant subprocess and the manual `clone-lock.mjs
//   --exec -- bash -c '...'` wrapper the issue cites as today's toil.
// - §LWR's step 2 ("rule out a live session") is intentionally NOT
//   automated: `claim-lock.mts`'s own header documents why no local
//   process-liveness signal is recorded (a one-shot CLI's own PID would be
//   a tombstone before any concurrent session could observe it as alive).
//   `--operator-confirmed-no-live-session` is the operator's own explicit
//   attestation for that step, checked before ANY mutation, regardless of
//   what step 1 finds or whether `--apply` is set.
//
// Default mode is dry-run (no mutation); `--apply` performs steps 3 and 4.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import { checkClaimLock } from './claim-lock.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { acquireCloneLock, releaseCloneLock } from './clone-lock.mjs';
import { readGithubRepoDefaultBranch } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { loadIddConfig } from './idd-config.mjs';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mjs';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mjs';

// ---------------------------------------------------------------------------
// Local git plumbing (a file-scoped copy of the sanitized-environment /
// non-throwing-exec pattern already used by idd-roadmap-audit-execute.mts
// and local-worktree-occupancy.mts -- neither exports it, and this file is
// outside their own candidate-files scope, so this mirrors rather than
// imports).
// ---------------------------------------------------------------------------
/** Strip ambient `GIT_*` overrides so every git call below targets exactly
 * the repository/worktree its own `cwd` names, never one an inherited
 * environment variable silently redirects to. */
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
function runLocalGitCommand(argv, cwd) {
  try {
    const stdout = execFileSync('git', argv, {
      cwd,
      env: sanitizedGitEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error;
    return {
      ok: false,
      status: execError.status ?? null,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message ?? '',
    };
  }
}
function pathExistsOnDisk(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function realpathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}
function readlinkOrNull(path) {
  try {
    return readlinkSync(path, 'utf8');
  } catch {
    return null;
  }
}
// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------
/** True when `routing.reason` matches §LWR step 1's own accepted prefixes. */
export function isAcceptedBlockReason(reason) {
  return (
    reason.startsWith('stale-claim-') || reason.startsWith('released-claim-')
  );
}
/** Match a worktree-local lock to the claim recovered by routing. Legacy
 * releases may have no lock or an explicitly legacy/null holder, but a
 * non-null holder must never be treated as legacy. */
function lockMatchesRecoveredClaim(lock, recoveredClaimId) {
  if (lock.malformed) return false;
  if (recoveredClaimId === null) {
    return !lock.present || lock.holder?.claimId === null;
  }
  return lock.present && lock.holder?.claimId === recoveredClaimId;
}
/** Extract the recovered claim-id (null for a legacy pre-claim-id release)
 * and the occupying branch from a confirmed `local_worktree_occupied`
 * routing result. */
export function extractRecoveredClaim(routing) {
  if (routing.active_claim) {
    return {
      claimId: routing.active_claim.claim_id,
      branch: routing.active_claim.branch,
    };
  }
  if (routing.evidence?.released_claim) {
    return {
      claimId: routing.evidence.released_claim.claim_id,
      branch: routing.evidence.released_claim.branch,
    };
  }
  return { claimId: null, branch: null };
}
/** Normalize a `git worktree list --porcelain -z` path for comparisons with
 * Node's native `resolve` output. Git emits forward slashes on Windows even
 * though `resolve` and the filesystem APIs use backslashes there. Keep the
 * POSIX case byte-for-byte: a backslash is a valid filename character on
 * POSIX and must not be rewritten there. */
export function normalizeGitWorktreePathForComparison(
  worktreePath,
  pathSeparator = sep,
) {
  return pathSeparator === '\\'
    ? worktreePath.replaceAll('\\', '/')
    : worktreePath;
}
/**
 * Mirrors `inspectLocalWorktreeBranch`'s (local-worktree-occupancy.mts) own
 * fail-closed conditions for exactly the record naming `targetPath`: a
 * prunable record whose path is absent on disk is a safe force-remove
 * shortcut only when it is not locked and its own `branchRef` names
 * `requestedBranch` exactly. A detached record (`branchRef === null`) is
 * never shortcut, even when `requestedBranch` is known -- matching
 * `inspectLocalWorktreeBranch`'s own fail-closed behavior there: it cannot
 * run its `resolveDetachedBranch` sequencer lookup once the path is already
 * absent (that lookup itself reads files at the path), so it always treats
 * a detached+prunable+absent record as blocking, regardless of relevance.
 * This function does not replicate every other branch
 * `inspectLocalWorktreeBranch` walks (e.g. a non-prunable record, or a
 * present-on-disk prunable record) -- it only judges the one specific
 * record this helper's own targetPath resolves to, for the one shortcut
 * decision made here.
 */
export function evaluatePrunableShortcut(
  records,
  targetPath,
  requestedBranch,
  pathExists,
) {
  const targetComparisonPath =
    normalizeGitWorktreePathForComparison(targetPath);
  const record =
    records.find(
      (candidate) =>
        normalizeGitWorktreePathForComparison(candidate.path) ===
        targetComparisonPath,
    ) ?? null;
  if (!record) {
    return {
      eligible: false,
      record: null,
      reason: 'no matching worktree record',
    };
  }
  if (!record.prunable) {
    return { eligible: false, record, reason: 'record is not prunable' };
  }
  if (pathExists(record.path)) {
    return { eligible: false, record, reason: 'path still exists on disk' };
  }
  if (record.locked) {
    return { eligible: false, record, reason: 'record is locked' };
  }
  if (requestedBranch === null) {
    return {
      eligible: false,
      record,
      reason: 'requested branch is unknown; cannot confirm the record',
    };
  }
  if (record.branchRef === null) {
    // Detached + prunable + absent: `inspectLocalWorktreeBranch` can never
    // resolve which branch a detached, on-disk-absent record held (its
    // own resolveDetachedBranch needs to read files at a path that no
    // longer exists), so it fails closed and treats the record as
    // unreadable/blocking regardless of relevance. Mirror that here --
    // never shortcut a detached record just because its branch happens to
    // be unresolvable; an ambiguous match must never authorize a
    // force-remove.
    return {
      eligible: false,
      record,
      reason:
        'record is detached; its branch cannot be confirmed (fail closed, mirrors inspectLocalWorktreeBranch)',
    };
  }
  if (
    record.branchRef !== `refs/heads/${requestedBranch}` &&
    record.branchRef !== requestedBranch
  ) {
    return {
      eligible: false,
      record,
      reason: 'record names a different, unrelated branch',
    };
  }
  return {
    eligible: true,
    record,
    reason: 'prunable, absent, unlocked, matching',
  };
}
/** Detect an in-progress merge/rebase/cherry-pick/bisect in `path`, returning
 * the pre-operation tip to preserve (`orig-head` for rebase, else HEAD). */
export function detectInProgressOperation(path, runGit, pathExists, readFile) {
  const merge = runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path);
  if (merge.ok) {
    const head = runGit(['rev-parse', 'HEAD'], path);
    // A failed `rev-parse HEAD` here must never silently resolve to an
    // empty-string "tip" -- fail closed (null) the same way the bisect
    // branch below does, rather than let a blank tipSha slip through.
    return { kind: 'merge', tipSha: head.ok ? head.stdout.trim() : null };
  }
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const gitPath = runGit(['rev-parse', '--git-path', name], path);
    if (!gitPath.ok) continue;
    const resolved = gitPath.stdout.trim();
    if (!resolved) continue;
    const absolute = isAbsolute(resolved) ? resolved : join(path, resolved);
    if (!pathExists(absolute)) continue;
    // The sequencer directory exists, so a rebase IS in progress -- an
    // unreadable `orig-head` must report the operation with an
    // unresolved tip (fail closed downstream), never silently `continue`
    // as if no rebase were detected at all.
    const origHead = readFile(join(absolute, 'orig-head'));
    return { kind: 'rebase', tipSha: origHead ? origHead.trim() : null };
  }
  const cherryPick = runGit(
    ['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'],
    path,
  );
  if (cherryPick.ok) {
    const head = runGit(['rev-parse', 'HEAD'], path);
    return {
      kind: 'cherry-pick',
      tipSha: head.ok ? head.stdout.trim() : null,
    };
  }
  const bisectLogPath = runGit(['rev-parse', '--git-path', 'BISECT_LOG'], path);
  if (bisectLogPath.ok) {
    const resolved = bisectLogPath.stdout.trim();
    const absolute = isAbsolute(resolved) ? resolved : join(path, resolved);
    if (resolved && pathExists(absolute)) {
      // Codex review: during an active bisect, `HEAD` is the commit
      // currently being tested, not the tip the bisect started from --
      // `git bisect reset` returns to THAT original state, per Git's own
      // bisect documentation. `BISECT_START` (a plain file containing the
      // ref name bisect started from, not a SHA) is git's own record of
      // it; resolve that ref to a SHA instead of recording `HEAD`. `null`
      // when it cannot be read/resolved, so the caller fails closed
      // rather than silently falling back to the ordinary unpushed-commit
      // check.
      const bisectStartPath = runGit(
        ['rev-parse', '--git-path', 'BISECT_START'],
        path,
      );
      let tipSha = null;
      if (bisectStartPath.ok) {
        const startResolved = bisectStartPath.stdout.trim();
        const startAbsolute = isAbsolute(startResolved)
          ? startResolved
          : join(path, startResolved);
        const startRef = readFile(startAbsolute)?.trim();
        if (startRef) {
          const startTip = runGit(['rev-parse', startRef], path);
          if (startTip.ok) {
            tipSha = startTip.stdout.trim();
          }
        }
      }
      return { kind: 'bisect', tipSha };
    }
  }
  return null;
}
/** True when `git status --porcelain --ignored --untracked-files=normal`
 * reports at least one tracked/untracked change (any line not prefixed
 * `!!`, which marks an ignored path). */
export function hasWorkingTreeChanges(statusPorcelain) {
  return statusPorcelain
    .split('\n')
    .some((line) => line.length > 0 && !line.startsWith('!!'));
}
/** The ignored-file paths (`!!`-prefixed lines) reported by the same status
 * scan, relative to the scanned path. */
export function extractIgnoredPaths(statusPorcelain) {
  const nulDelimited = statusPorcelain.includes('\0');
  const records = nulDelimited
    ? statusPorcelain.split('\0')
    : statusPorcelain.split('\n');
  return records
    .filter((record) => record.startsWith('!! '))
    .map((record) => {
      const path = record.slice(3);
      // `git status --porcelain -z` emits raw paths, including literal quote
      // characters. Only ordinary porcelain output uses C quoting.
      return nulDelimited ? path : decodeGitQuotedPath(path);
    })
    .filter((path) => path.length > 0);
}
/** Decode a Git porcelain C-quoted path. `-z` output normally avoids this
 * format, but accepting it keeps this parser safe for ordinary porcelain
 * output with core.quotePath enabled. */
function decodeGitQuotedPath(path) {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) {
    return path;
  }
  const input = path.slice(1, -1);
  const bytes = [];
  const simpleEscapes = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    '\\': 0x5c,
    '"': 0x22,
  };
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== '\\') {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const next = input[index + 1];
    const octal = input.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const escaped = next === undefined ? undefined : simpleEscapes[next];
    if (escaped !== undefined) {
      bytes.push(escaped);
      index += 1;
      continue;
    }
    bytes.push(...Buffer.from(next ?? '\\'));
    if (next !== undefined) index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}
/**
 * Every tracked/untracked dirty path (any line not `!!`-prefixed) reported
 * by the same `git status --porcelain --ignored --untracked-files=normal`
 * scan -- used by the unmerged-`stash push`-failure fallback (Codex review
 * finding): that fallback must preserve every dirty path in the scope, not
 * only the `--diff-filter=U` conflicted subset, or a coexisting untracked
 * file / non-conflicting modification is silently lost. A rename line
 * (`R  old -> new`) reports only the new path -- the working tree copy at
 * the old path no longer exists to back up.
 */
export function extractDirtyPaths(statusPorcelain) {
  const paths = [];
  for (const line of statusPorcelain.split('\n')) {
    if (line.length < 3 || line.startsWith('!!')) continue;
    let rest = line.slice(3).trim();
    const status = line.slice(0, 2);
    if (status.includes('R')) {
      const arrow = findPorcelainRenameSeparator(rest);
      if (arrow !== -1) {
        rest = rest.slice(arrow + 4);
      }
    }
    if (rest.length > 0) {
      paths.push(decodeGitQuotedPath(rest));
    }
  }
  return paths;
}
/** Find the porcelain rename separator without mistaking an arrow inside a
 * C-quoted filename for the status record's delimiter. */
function findPorcelainRenameSeparator(record) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= record.length - 4; index += 1) {
    const character = record[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (record.slice(index, index + 4) === ' -> ') {
      return index;
    }
  }
  return -1;
}
/**
 * True when `relativePath` is safe to join under a preserve-directory
 * destination: not absolute, and no `..` path segment. Defense in depth for
 * the ignored-file and unmerged-conflict copy-out paths -- a normal `git
 * status`/`git diff` relative path never escapes the scanned worktree, but
 * neither loop should trust that unconditionally when the destination join
 * result is about to be passed to a real filesystem copy.
 */
export function isSafeRelativePath(relativePath) {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    return false;
  }
  const separators = sep === '\\' ? /[\\/]+/ : /[/]+/;
  return relativePath.split(separators).every((segment) => segment !== '..');
}
/**
 * True when `child` is `parent` itself or a path underneath it, using
 * `path.relative` rather than a hardcoded `/` prefix check (Copilot review:
 * the earlier `startsWith('/')`-based checks were POSIX-only and passed a
 * `--preserve-dir` below the target on Windows, where `resolve`/
 * `realpathSync` produce `\`-separated paths). `path.relative` resolves
 * separators per-platform, so this is correct on both.
 */
export function isPathContainedIn(child, parent) {
  if (child === parent) {
    return true;
  }
  const rel = relative(parent, child);
  // `path.relative` returns a path starting with `..` (platform-appropriate
  // separator) whenever `child` is NOT underneath `parent` -- including the
  // Windows cross-drive case, where it instead returns an absolute path
  // (caught by `isAbsolute` below).
  return (
    rel !== '' &&
    !isAbsolute(rel) &&
    !rel.split(/[\\/]+/).some((segment) => segment === '..')
  );
}
/** Return false when a copy destination (including a not-yet-existing suffix)
 * resolves into the worktree that is about to be removed. Checking the
 * effective path catches a symlinked child directory under an otherwise safe
 * preserve root. Unknown resolution is fail-closed for an actual copy. */
function isCopyDestinationOutsideTarget(destination, targetPath, deps) {
  const targetReal = deps.realpathOrNull(targetPath);
  const destinationReal = resolveEffectiveRealpath(
    destination,
    deps.realpathOrNull,
    deps.readlinkOrNull,
  );
  return (
    targetReal !== null &&
    destinationReal !== null &&
    !isPathContainedIn(destinationReal, targetReal)
  );
}
/**
 * Resolve the effective realpath of `path`, even when it (or some suffix of
 * it) does not exist yet -- by walking up to the nearest ancestor
 * `realpathOrNull` CAN resolve, then re-appending the non-existent suffix.
 * Read-only (never creates anything), so this is safe to call from a
 * dry-run guard, unlike creating the directory first to force realpath to
 * resolve it (Copilot/Codex review: a `--preserve-dir` that does not exist
 * yet previously returned `null` from a plain `realpathOrNull` call and
 * skipped the containment check entirely, so an existing symlinked
 * ancestor -- e.g. `/tmp/link -> <target>/.cache` with `--preserve-dir
 * /tmp/link/run` -- could redirect the eventual directory back inside the
 * target worktree without tripping it).
 */
export function resolveEffectiveRealpath(
  path,
  realpathOrNull,
  readlinkOrNull = () => null,
) {
  return resolveEffectiveRealpathInternal(
    path,
    realpathOrNull,
    readlinkOrNull,
    new Set(),
  );
}
function resolveEffectiveRealpathInternal(
  path,
  realpathOrNull,
  readlinkOrNull,
  seen,
) {
  if (seen.has(path)) return null;
  seen.add(path);
  const real = realpathOrNull(path);
  if (real !== null) {
    return real;
  }
  const linkTarget = readlinkOrNull(path);
  if (linkTarget !== null) {
    return resolveEffectiveRealpathInternal(
      isAbsolute(linkTarget) ? linkTarget : resolve(dirname(path), linkTarget),
      realpathOrNull,
      readlinkOrNull,
      seen,
    );
  }
  const parent = dirname(path);
  if (parent === path) {
    return null;
  }
  const parentReal = resolveEffectiveRealpathInternal(
    parent,
    realpathOrNull,
    readlinkOrNull,
    seen,
  );
  if (parentReal === null) {
    return null;
  }
  return join(parentReal, basename(path));
}
/** Count of stash entries whose subject contains `tag` verbatim. */
export function countTaggedStashEntries(stashList, tag) {
  if (stashList.trim().length === 0) {
    return 0;
  }
  return stashList.split('\n').filter((line) => line.includes(tag)).length;
}
// ---------------------------------------------------------------------------
// Orchestration (pure over injected deps -- unit-testable without a real
// git repository or subprocess; the compiled CLI's own production deps wire
// these to real git/gh calls, exercised end-to-end by the sandboxed tests).
// ---------------------------------------------------------------------------
// `git submodule status` lines: "<status><sha> <path>[ (<describe>)]". Git
// permits spaces in a submodule path, so splitting on whitespace (Copilot
// review finding) truncates a path like "libs/my module" to "libs/my" --
// the real submodule is then never inspected or backed up. The trailing
// "(<describe>)" suffix is only ever emitted for an INITIALIZED submodule
// (a `-`/uninitialized entry has nothing checked out to describe), so
// stripping it unconditionally (Codex review finding) mis-parses a valid
// uninitialized path that itself ends in a parenthesized component, e.g.
// `lib (foo)`, down to `lib`.
const SUBMODULE_STATUS_LINE_PATTERN = /^([ +\-U])([0-9a-f]{4,64}) (.+)$/;
const SUBMODULE_DESCRIBE_SUFFIX_PATTERN = / \([^()]*\)$/;
export function submoduleStatusEntries(raw) {
  const entries = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    const match = SUBMODULE_STATUS_LINE_PATTERN.exec(line);
    if (!match) continue;
    const status = match[1];
    let path = match[3];
    if (status !== '-') {
      path = path.replace(SUBMODULE_DESCRIBE_SUFFIX_PATTERN, '');
    }
    entries.push({ status, path });
  }
  return entries;
}
/** Convert recursive repository-relative submodule paths into paths relative
 * to one initialized submodule, so its parent scope can exclude nested
 * submodules from its own stash probe. */
function nestedSubmodulePathsForScope(submodulePaths, scope) {
  const prefix = `${scope}/`;
  return submodulePaths
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => candidate.slice(prefix.length));
}
/** Preserve one scope (the worktree itself, or a submodule path relative to
 * it) -- stash tracked/untracked changes under `tag`, or fall back to
 * copying conflicted files out on an unmerged-path stash failure. Returns
 * the plan entry; `--apply` semantics (actually stashing) are gated by the
 * caller passing `apply: false` for a dry-run report only. */
function planAndMaybeStashScope(
  scopePath,
  scopeLabel,
  tag,
  apply,
  targetPath,
  deps,
  excludedDirtyPaths = [],
) {
  const status = deps.runGit(
    ['status', '--porcelain', '--ignored', '--untracked-files=normal'],
    scopePath,
  );
  // Codex/Copilot review: a failed status probe must never read as "clean".
  // `preservationVerified` fails closed on `statusReadFailed` regardless of
  // `hasChanges` below.
  const statusReadFailed = !status.ok;
  const hasChanges =
    status.ok &&
    (excludedDirtyPaths.length === 0
      ? hasWorkingTreeChanges(status.stdout)
      : extractDirtyPaths(status.stdout).some(
          (dirtyPath) => !excludedDirtyPaths.includes(dirtyPath),
        ));
  const baselineList = deps.runGit(['stash', 'list'], scopePath);
  const baselineCount = countTaggedStashEntries(baselineList.stdout, tag);
  const entry = {
    scope: scopeLabel,
    tag,
    hasChanges,
    statusReadFailed,
    stashListReadFailed: !baselineList.ok,
    baselineCount,
    stashed: false,
    verifiedCount: null,
    unmergedFallbackCopiedTo: null,
    unmergedFallbackCopiedFiles: [],
    unmergedFallbackAllPreserved: null,
    hardStashFailure: false,
  };
  if (statusReadFailed || entry.stashListReadFailed || !hasChanges || !apply) {
    return entry;
  }
  const stash = deps.runGit(
    ['stash', 'push', '--include-untracked', '-m', tag],
    scopePath,
  );
  if (!stash.ok) {
    // Copilot review: only a `stash push` failure actually CAUSED by
    // unmerged paths (the documented §LWR case: a backed-up interrupted
    // merge/rebase/cherry-pick left conflict markers behind) is safe to
    // treat via the copy-out fallback below. A permission error,
    // repository-lock contention, or any other `stash push` failure is a
    // genuine hard failure -- copying working-tree files without the
    // index state stash would have captured is not equivalent
    // preservation, so this must fail closed instead of silently
    // "succeeding" via the fallback.
    if (!/unmerged/i.test(stash.stderr)) {
      entry.hardStashFailure = true;
      return entry;
    }
    // Unmerged-path fallback: `stash push` itself refused (unmerged paths
    // from a backed-up interrupted operation) -- copy out EVERY dirty path
    // in this scope, not only the `--diff-filter=U` conflicted subset
    // (Codex review finding: a coexisting untracked file or non-conflicting
    // modification would otherwise be silently lost), and verify each one
    // actually landed before trusting this scope as preserved.
    const allDirtyPaths = extractDirtyPaths(status.stdout);
    const dirtyPaths = allDirtyPaths.filter(isSafeRelativePath);
    if (dirtyPaths.length > 0) {
      const preserveDir = deps.ensurePreserveDir();
      const destination = join(
        preserveDir,
        `unmerged-${Buffer.from(scopeLabel).toString('base64url')}`,
      );
      let allLanded = dirtyPaths.length === allDirtyPaths.length;
      for (const relPath of dirtyPaths) {
        const from = join(scopePath, relPath);
        const to = join(destination, relPath);
        entry.unmergedFallbackCopiedFiles.push(to);
        if (
          !isCopyDestinationOutsideTarget(to, targetPath, deps) ||
          !deps.pathExists(from)
        ) {
          allLanded = false;
          continue;
        }
        deps.copyPath(from, to);
        if (!deps.pathExists(to)) {
          allLanded = false;
        }
      }
      entry.unmergedFallbackCopiedTo = destination;
      entry.unmergedFallbackAllPreserved = allLanded;
    } else {
      // Nothing dirty by this scan's own accounting, so there is nothing to
      // preserve -- vacuously satisfied.
      entry.unmergedFallbackAllPreserved = allDirtyPaths.length === 0;
    }
    return entry;
  }
  entry.stashed = true;
  const afterList = deps.runGit(['stash', 'list'], scopePath);
  entry.stashListReadFailed = entry.stashListReadFailed || !afterList.ok;
  entry.verifiedCount = afterList.ok
    ? countTaggedStashEntries(afterList.stdout, tag)
    : null;
  return entry;
}
/** Preserve unpushed commits for one scope on `refs/idd-lwr/<branch>`. */
function planAndMaybeBackupRef(
  scopePath,
  scopeLabel,
  branch,
  inProgressOperation,
  apply,
  runGit,
) {
  const ref = `refs/idd-lwr/${branch}`;
  let tipSha = null;
  let hasUnpushed = false;
  // Copilot/Codex review: a failed `git log @{u}..HEAD` (or `git rev-parse
  // HEAD`) probe must never read as "no unpushed commits" -- unlike the
  // other preservation probes, this one previously failed OPEN. Recorded
  // separately from `hasUnpushed` so `preservationVerified` can block on it
  // even when the (unreliable) `hasUnpushed` reads false. An in-progress
  // operation whose own tip could not be resolved (e.g. an unreadable
  // `BISECT_START` ref) fails closed the same way, rather than silently
  // falling through to the ordinary upstream-based check below.
  let unpushedQueryFailed = false;
  if (inProgressOperation) {
    if (inProgressOperation.tipSha === null) {
      unpushedQueryFailed = true;
    } else {
      tipSha = inProgressOperation.tipSha;
      hasUnpushed = true;
    }
  } else {
    const upstream = runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
      scopePath,
    );
    const head = runGit(['rev-parse', 'HEAD'], scopePath);
    tipSha = head.ok ? head.stdout.trim() : null;
    if (!head.ok) {
      unpushedQueryFailed = true;
    } else if (!upstream.ok) {
      // No upstream: every commit counts as unpushed (§LWR step 3).
      hasUnpushed = tipSha !== null;
    } else {
      const unpushed = runGit(['log', '@{u}..HEAD', '--oneline'], scopePath);
      if (!unpushed.ok) {
        unpushedQueryFailed = true;
      } else {
        hasUnpushed = unpushed.stdout.trim().length > 0;
      }
    }
  }
  const entry = {
    scope: scopeLabel,
    ref,
    hasUnpushed,
    unpushedQueryFailed,
    tipSha,
    written: false,
    verifiedOid: null,
  };
  if (unpushedQueryFailed || !hasUnpushed || !tipSha || !apply) {
    return entry;
  }
  const write = runGit(['update-ref', ref, tipSha], scopePath);
  if (write.ok) {
    entry.written = true;
    const verify = runGit(['rev-parse', '--verify', ref], scopePath);
    entry.verifiedOid = verify.ok ? verify.stdout.trim() : null;
  }
  return entry;
}
/** Run §LWR step 3 (preserve) for the worktree and every submodule; a pure
 * function over injected deps so both the plan (dry-run) and the actual
 * mutation (`--apply`) share one code path -- `apply` toggles only whether
 * the stash/ref-write commands actually run. */
/**
 * Scan one scope's ignored files (worktree or an initialized submodule) and
 * copy them out under `--apply` -- extracted so `planAndMaybePreserve` can
 * call it per submodule too (Codex review finding): the original single
 * top-level-only scan never saw ignored, non-reproducible data (e.g.
 * `submodule/.env`) living inside an initialized submodule, since the
 * top-level `git status --porcelain` does not enumerate a submodule's own
 * ignored contents. Returns `scanFailed: true` (never silently swallowed)
 * when the status probe itself fails, mirroring the same fail-closed
 * contract `planAndMaybeStashScope`'s `statusReadFailed` uses.
 */
function scanAndMaybeCopyIgnoredFiles(
  scopePath,
  scopeLabel,
  apply,
  targetPath,
  deps,
) {
  const status = deps.runGit(
    ['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'],
    scopePath,
  );
  if (!status.ok) {
    return { copied: [], scanFailed: true };
  }
  const copied = [];
  let scanFailed = false;
  for (const ignoredPath of extractIgnoredPaths(status.stdout)) {
    if (!isSafeRelativePath(ignoredPath)) {
      scanFailed = true;
      copied.push({ path: ignoredPath, copiedTo: null });
      continue;
    }
    const preserveDir = apply ? deps.ensurePreserveDir() : null;
    const destination = preserveDir
      ? join(
          preserveDir,
          'ignored',
          scopeLabel === '.' ? '' : scopeLabel,
          ignoredPath,
        )
      : null;
    if (apply && destination) {
      if (
        !isCopyDestinationOutsideTarget(destination, targetPath, deps) ||
        !deps.pathExists(join(scopePath, ignoredPath))
      ) {
        // If the source disappeared or a symlinked destination redirects
        // into the target, do not remove the worktree without a verified
        // artifact.
        scanFailed = true;
        copied.push({ path: ignoredPath, copiedTo: null });
        continue;
      }
      deps.copyPath(join(scopePath, ignoredPath), destination);
    }
    copied.push({ path: ignoredPath, copiedTo: destination });
  }
  return { copied, scanFailed };
}
function planAndMaybePreserve(path, branch, tag, apply, deps) {
  const readFile = (p) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  };
  const inProgressOperation = detectInProgressOperation(
    path,
    deps.runGit,
    deps.pathExists,
    readFile,
  );
  const submoduleStatus = deps.runGit(
    ['submodule', 'status', '--recursive'],
    path,
  );
  const submodules = submoduleStatus.ok
    ? submoduleStatusEntries(submoduleStatus.stdout)
    : [];
  // A clean initialized submodule's own stash scope handles the ` M path`
  // that the parent status probe reports for its dirty files. Do not exclude
  // a `+`/`U`/`-` entry, though: those statuses mean the superproject's
  // gitlink itself differs from the index or cannot be checked out, so the
  // parent stash must retain that gitlink change (Copilot review #4114207705).
  const submodulePaths = submodules
    .filter((submodule) => submodule.status === ' ')
    .map((submodule) => submodule.path)
    .filter((submodulePath) => submodulePath.length > 0);
  const stashes = [
    planAndMaybeStashScope(path, '.', tag, apply, path, deps, submodulePaths),
  ];
  const uninitializedSubmodules = [];
  const submoduleOperations = new Map();
  for (const submodule of submodules) {
    if (!submodule.path) continue;
    if (submodule.status === '-') {
      // Uninitialized: not a git repository at all -- copy files out
      // directly rather than attempting any `git -C` command there.
      const submodulePath = join(path, submodule.path);
      if (deps.pathExists(submodulePath)) {
        // Dry-run must have zero side effects: only create the preserve
        // directory (and copy into it) when actually applying.
        let destination = null;
        if (apply) {
          const preserveDir = deps.ensurePreserveDir();
          destination = join(
            preserveDir,
            `uninitialized-${Buffer.from(submodule.path).toString('base64url')}`,
          );
          if (isCopyDestinationOutsideTarget(destination, path, deps)) {
            try {
              deps.copyPath(submodulePath, destination);
            } catch {
              destination = null;
            }
          } else {
            destination = null;
          }
        }
        uninitializedSubmodules.push({
          path: submodule.path,
          copiedTo: destination,
        });
      }
      continue;
    }
    const submodulePath = join(path, submodule.path);
    const submoduleOperation = detectInProgressOperation(
      submodulePath,
      deps.runGit,
      deps.pathExists,
      readFile,
    );
    submoduleOperations.set(submodule.path, submoduleOperation);
    stashes.push(
      planAndMaybeStashScope(
        submodulePath,
        submodule.path,
        tag,
        apply,
        path,
        deps,
        nestedSubmodulePathsForScope(submodulePaths, submodule.path),
      ),
    );
  }
  const backupRefs = [
    planAndMaybeBackupRef(
      path,
      '.',
      branch,
      inProgressOperation,
      apply,
      deps.runGit,
    ),
  ];
  for (const submodule of submodules) {
    if (!submodule.path || submodule.status === '-') continue;
    backupRefs.push(
      planAndMaybeBackupRef(
        join(path, submodule.path),
        submodule.path,
        branch,
        submoduleOperations.get(submodule.path) ?? null,
        apply,
        deps.runGit,
      ),
    );
  }
  let ignoredFilesCopied = [];
  let ignoredFilesScanFailed = false;
  const topLevelIgnored = scanAndMaybeCopyIgnoredFiles(
    path,
    '.',
    apply,
    path,
    deps,
  );
  ignoredFilesCopied = ignoredFilesCopied.concat(topLevelIgnored.copied);
  ignoredFilesScanFailed = ignoredFilesScanFailed || topLevelIgnored.scanFailed;
  for (const submodule of submodules) {
    if (!submodule.path || submodule.status === '-') continue;
    const submoduleIgnored = scanAndMaybeCopyIgnoredFiles(
      join(path, submodule.path),
      submodule.path,
      apply,
      path,
      deps,
    );
    ignoredFilesCopied = ignoredFilesCopied.concat(submoduleIgnored.copied);
    ignoredFilesScanFailed =
      ignoredFilesScanFailed || submoduleIgnored.scanFailed;
  }
  const submoduleAdminCopies = [];
  let submoduleAdminCopyFailed = false;
  if (apply) {
    for (const submodule of submodules) {
      if (!submodule.path || submodule.status === '-') continue;
      const stash = stashes.find((entry) => entry.scope === submodule.path);
      const ref = backupRefs.find((entry) => entry.scope === submodule.path);
      const operation = submoduleOperations.get(submodule.path);
      if (!stash?.stashed && !ref?.written && operation === null) continue;
      const submodulePath = join(path, submodule.path);
      const gitDir = deps.runGit(
        ['rev-parse', '--absolute-git-dir'],
        submodulePath,
      );
      if (!gitDir.ok || !gitDir.stdout.trim()) {
        submoduleAdminCopyFailed = true;
        submoduleAdminCopies.push({ path: submodule.path, copiedTo: null });
        continue;
      }
      const preserveDir = deps.ensurePreserveDir();
      const destination = join(
        preserveDir,
        'submodule-gitdir',
        Buffer.from(submodule.path).toString('base64url'),
      );
      if (!isCopyDestinationOutsideTarget(destination, path, deps)) {
        submoduleAdminCopyFailed = true;
        submoduleAdminCopies.push({ path: submodule.path, copiedTo: null });
        continue;
      }
      try {
        deps.copyPath(gitDir.stdout.trim(), destination);
      } catch {
        submoduleAdminCopyFailed = true;
        submoduleAdminCopies.push({ path: submodule.path, copiedTo: null });
        continue;
      }
      submoduleAdminCopies.push({
        path: submodule.path,
        copiedTo: destination,
      });
    }
  }
  return {
    inProgressOperation,
    stashes,
    uninitializedSubmodules,
    backupRefs,
    ignoredFilesCopied,
    ignoredFilesScanFailed,
    submoduleAdminCopies,
    submoduleAdminCopyFailed,
    submoduleListFailed: !submoduleStatus.ok,
  };
}
/** Verify every step-3 preservation action that claimed a change actually
 * landed, before step 4 is ever allowed to remove anything. */
function preservationVerified(preserve, pathExists) {
  if (preserve.ignoredFilesScanFailed) return false;
  // A failed `git submodule status --recursive` must never silently
  // degrade to "no submodules" -- an unbacked-up dirty/uninitialized
  // submodule would otherwise be indistinguishable from one that
  // genuinely does not exist.
  if (preserve.submoduleListFailed) return false;
  for (const stash of preserve.stashes) {
    // Codex/Copilot review: a failed status probe must block removal
    // regardless of what `hasChanges` reads as -- it was never a genuine
    // "clean" observation.
    if (stash.statusReadFailed || stash.stashListReadFailed) return false;
    if (!stash.hasChanges) continue;
    if (stash.hardStashFailure) return false;
    if (stash.unmergedFallbackCopiedTo !== null) {
      // Copilot review: a non-null destination alone is not proof every
      // dirty path actually landed there.
      if (stash.unmergedFallbackAllPreserved !== true) return false;
      if (
        stash.unmergedFallbackCopiedFiles.some(
          (destination) => !pathExists(destination),
        )
      ) {
        return false;
      }
      continue;
    }
    if (!stash.stashed) return false;
    if (
      stash.verifiedCount === null ||
      stash.verifiedCount !== stash.baselineCount + 1
    ) {
      return false;
    }
  }
  for (const ref of preserve.backupRefs) {
    if (ref.unpushedQueryFailed) return false;
    if (!ref.hasUnpushed) continue;
    if (
      !ref.written ||
      ref.verifiedOid === null ||
      ref.verifiedOid !== ref.tipSha
    ) {
      return false;
    }
  }
  for (const submodule of preserve.uninitializedSubmodules) {
    if (submodule.copiedTo === null) return false;
    if (!pathExists(submodule.copiedTo)) return false;
  }
  // Copilot review: `ignoredFilesCopied` was never included in verification
  // at all -- a failed or partial ignored-file copy could not block
  // removal despite §LWR requiring these copies verified before step 4.
  for (const ignored of preserve.ignoredFilesCopied) {
    if (ignored.copiedTo === null) return false;
    if (!pathExists(ignored.copiedTo)) return false;
  }
  if (preserve.submoduleAdminCopyFailed) return false;
  for (const admin of preserve.submoduleAdminCopies) {
    if (admin.copiedTo === null || !pathExists(admin.copiedTo)) return false;
  }
  return true;
}
/**
 * Re-read and re-verify the stash/ref preservation artifacts fresh, while
 * the clone-scoped lock is held, immediately before removal (Copilot
 * review finding): `preservationVerified` above runs BEFORE the lock is
 * acquired, so its cached counts/booleans can go stale during the wait to
 * acquire it -- a concurrent process could pop or drop the stash, or
 * delete the backup ref, in that window. This re-derives the same counts
 * and OIDs from a fresh `git stash list` / `git rev-parse --verify` against
 * each scope's own path, rather than trusting the earlier snapshot.
 */
function reverifyPreservationArtifactsFresh(
  preserve,
  targetPath,
  runGit,
  pathExists,
) {
  const scopePath = (scope) =>
    scope === '.' ? targetPath : join(targetPath, scope);
  for (const stash of preserve.stashes) {
    if (stash.stashListReadFailed) return false;
    if (stash.stashed) {
      const list = runGit(['stash', 'list'], scopePath(stash.scope));
      if (!list.ok) return false;
      // A lower bound, not exact equality: the fresh recheck's only
      // question is "is THIS attempt's stash still there" -- a stale or
      // concurrent same-tag entry appearing during the lock wait is MORE
      // preservation than required, never less, so it must not fail this
      // check (the step-3 verify immediately after the push already
      // enforced exactly-one against its own baseline).
      if (
        countTaggedStashEntries(list.stdout, stash.tag) <
        stash.baselineCount + 1
      ) {
        return false;
      }
    }
    // Copilot review: the fresh re-verification previously only covered
    // stash entries and backup refs -- an ignored-file, uninitialized-
    // submodule, or unmerged-fallback copy could be silently deleted
    // during the lock wait and removal would still proceed. Re-confirm
    // every copy destination this scope recorded still exists.
    if (
      stash.unmergedFallbackCopiedTo !== null &&
      !pathExists(stash.unmergedFallbackCopiedTo)
    ) {
      return false;
    }
    if (
      stash.unmergedFallbackCopiedFiles.some(
        (destination) => !pathExists(destination),
      )
    ) {
      return false;
    }
  }
  for (const ref of preserve.backupRefs) {
    if (!ref.written) continue;
    const verify = runGit(
      ['rev-parse', '--verify', ref.ref],
      scopePath(ref.scope),
    );
    if (!verify.ok || verify.stdout.trim() !== ref.tipSha) {
      return false;
    }
  }
  for (const submodule of preserve.uninitializedSubmodules) {
    if (submodule.copiedTo !== null && !pathExists(submodule.copiedTo)) {
      return false;
    }
  }
  for (const ignored of preserve.ignoredFilesCopied) {
    if (ignored.copiedTo !== null && !pathExists(ignored.copiedTo)) {
      return false;
    }
  }
  for (const admin of preserve.submoduleAdminCopies) {
    if (admin.copiedTo !== null && !pathExists(admin.copiedTo)) {
      return false;
    }
  }
  return true;
}
/**
 * Run the full §LWR steps 1/3/4 sequence. Pure over injected `deps` so a
 * unit test can assert exact call order (acquire-lock before recheck,
 * recheck before removal, release always runs) without a real git
 * repository. Never mutates when `!args.apply`, and never mutates when
 * `!args.operatorConfirmedNoLiveSession` regardless of `--apply` or what
 * step 1 finds -- both gates are checked before ANY git write.
 */
export function runLocalWorktreeRecovery(args, deps) {
  const mode = args.apply ? 'apply' : 'dry-run';
  const cwd = deps.cwd();
  // Known limitation (CodeRabbit review, #3536): this is a lexical
  // resolution, compared below against other lexical paths (git's own
  // `worktree list` output, and `evidence.local_worktree.paths`) with plain
  // string equality -- never realpath-resolved. A `--worktree` argument
  // that reaches the same directory through a symlink, or that differs
  // only by trailing-slash/case normalization, fails closed as
  // `path-mismatch` or misclassifies `primaryOrLinked` rather than
  // matching -- safe (no silent wrong-target mutation), but requires the
  // operator to pass the exact path git itself reports. Follow-up:
  // realpath both sides before comparing, if this proves disruptive in
  // practice.
  const targetPath = resolve(cwd, args.worktree);
  const verdict = {
    protocolVersion: '1',
    mode,
    issueNumber: args.issue ?? Number.NaN,
    worktree: targetPath,
    primaryWorktree: null,
    operatorConfirmed: args.operatorConfirmedNoLiveSession,
    step1: {
      outcome: 'confirm-failed',
      claimId: null,
      branch: null,
      reason: 'not evaluated',
    },
    ready: false,
    primaryOrLinked: null,
    plan: {
      prunableShortcut: false,
      inProgressOperation: null,
      stashes: [],
      uninitializedSubmodules: [],
      backupRefs: [],
      ignoredFilesCopied: [],
      ignoredFilesScanFailed: false,
      submoduleListFailed: false,
      submoduleAdminCopies: [],
      removal: null,
    },
    preserveDir: null,
    mutated: false,
    result: '',
  };
  const records = deps.listWorktreeRecords(cwd);
  if (records === null || records.length === 0) {
    // Copilot review: `git worktree list` failing (or producing
    // unparseable output) must stop here -- a repository always has at
    // least the primary worktree, so an empty result is never genuinely
    // "no worktrees", only an inspection failure. Continuing would
    // misclassify the target as `linked` without ever establishing which
    // record is actually primary, or whether the target record itself is
    // valid.
    verdict.step1.outcome = 'worktree-list-failed';
    verdict.step1.reason =
      'git worktree list failed or produced unparseable output; cannot determine which worktree is primary or confirm the target record';
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const primary = records[0] ?? null;
  verdict.primaryWorktree = primary?.path ?? null;
  const targetComparisonPath =
    normalizeGitWorktreePathForComparison(targetPath);
  verdict.primaryOrLinked =
    primary &&
    normalizeGitWorktreePathForComparison(primary.path) === targetComparisonPath
      ? 'primary'
      : 'linked';
  if (verdict.primaryOrLinked === 'linked') {
    const insideLexical = isPathContainedIn(cwd, targetPath);
    const cwdReal = deps.realpathOrNull(cwd);
    const targetReal = deps.realpathOrNull(targetPath);
    const insideReal =
      cwdReal !== null && targetReal !== null
        ? isPathContainedIn(cwdReal, targetReal)
        : false;
    if (insideLexical || insideReal) {
      verdict.step1.outcome = 'cwd-inside-target';
      verdict.step1.reason =
        'must be invoked from the primary worktree, never from the linked worktree being recovered';
      verdict.result = verdict.step1.reason;
      return verdict;
    }
  }
  // Copilot/Codex review: `--preserve-dir` was passed through with no
  // check that it names a location OUTSIDE the target worktree, and no
  // platform-portable containment logic at all (a hardcoded `/` prefix
  // check passes a destination below the target on Windows; a
  // not-yet-existing destination reached through a symlinked ancestor
  // could also redirect back inside the target without tripping a plain
  // realpath check). An operator pointing it inside the target would have
  // every ignored/unmerged/uninitialized backup copied into the very
  // directory `git worktree remove` (or the primary-worktree checkout) is
  // about to delete -- silently defeating this helper's entire recovery
  // guarantee. Reject that up front: lexically, via realpath when the
  // destination already exists, and via the nearest-existing-ancestor
  // realpath otherwise -- all through the same platform-aware
  // `isPathContainedIn` the cwd guard above uses.
  if (args.preserveDir) {
    const preserveDirResolved = resolve(cwd, args.preserveDir);
    const targetReal = deps.realpathOrNull(targetPath);
    const preserveDirEffectiveReal = resolveEffectiveRealpath(
      preserveDirResolved,
      deps.realpathOrNull,
      deps.readlinkOrNull,
    );
    const insideLexical = isPathContainedIn(preserveDirResolved, targetPath);
    const insideReal =
      preserveDirEffectiveReal !== null && targetReal !== null
        ? isPathContainedIn(preserveDirEffectiveReal, targetReal)
        : false;
    if (insideLexical || insideReal) {
      verdict.step1.outcome = 'preserve-dir-inside-target';
      verdict.step1.reason = `--preserve-dir (${preserveDirResolved}) must be outside the target worktree (${targetPath}) -- a backup destination inside it would be deleted by the removal it is meant to survive`;
      verdict.result = verdict.step1.reason;
      return verdict;
    }
  }
  // Step 1: confirm-the-block ALWAYS runs first, per the written procedure
  // ("Run the profile-selected resume-claim-routing helper... If <path> no
  // longer exists on disk (a prunable record), skip to git worktree remove
  // --force... Otherwise run the... claim-lock helper's check form"): the
  // prunable-record shortcut below only ever skips the claim-lock check,
  // never the confirm-the-block spawn itself.
  const confirmed = deps.confirmBlock(cwd);
  if (!confirmed.ok || !confirmed.routing) {
    verdict.step1.outcome = 'confirm-failed';
    verdict.step1.reason = confirmed.error ?? 'confirm-the-block check failed';
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const routing = confirmed.routing;
  if (
    routing.state !== 'local_worktree_occupied' ||
    !isAcceptedBlockReason(routing.reason)
  ) {
    verdict.step1.outcome = 'not-blocked';
    verdict.step1.reason = `resume-claim-routing reports state=${routing.state} reason=${routing.reason}; nothing to recover`;
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const reportedPaths = routing.evidence?.local_worktree?.paths ?? [];
  if (
    !reportedPaths.some(
      (reportedPath) =>
        normalizeGitWorktreePathForComparison(reportedPath) ===
        targetComparisonPath,
    )
  ) {
    verdict.step1.outcome = 'path-mismatch';
    verdict.step1.reason = `--worktree ${targetPath} is not among the occupied paths reported (${reportedPaths.join(', ') || 'none'})`;
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const recovered = extractRecoveredClaim(routing);
  const recoveredClaimId = recovered.claimId;
  const recoveredBranch = recovered.branch;
  // The prunable-and-absent shortcut skips the claim-lock check only
  // (nothing to preserve or remove either, since the path is already gone)
  // -- never the confirm-the-block spawn above. Passing the now-known
  // recovered branch lets the locked/branch-matching guard actually apply,
  // instead of the shortcut being reachable for an unrelated branch.
  const shortcut = evaluatePrunableShortcut(
    records,
    targetPath,
    recoveredBranch,
    deps.pathExists,
  );
  if (shortcut.eligible) {
    verdict.step1.outcome = 'blocked-prunable';
    verdict.step1.reason = 'prunable record, absent on disk, unlocked';
    verdict.plan.prunableShortcut = true;
  } else if (routing.reason.endsWith('-local-worktree-unreadable')) {
    // Copilot review: `isAcceptedBlockReason` above only checks the
    // `stale-claim-`/`released-claim-` PREFIX, so an `-unreadable` suffix
    // (occupancy could not be verified either way) passed through
    // identically to a confirmed `-occupied` one. `local-worktree-
    // occupancy.mts`'s own `inspectLocalWorktreeBranch` treats `unreadable`
    // as fail-closed precisely because the true state is unknown --
    // preserving and force-removing a worktree whose git status cannot
    // even be read reliably is unsafe. The prunable-and-absent shortcut
    // (checked above) is the one specific unreadable sub-case this helper
    // still handles, via its own independent fail-closed conditions; every
    // other unreadable reason refuses here instead.
    verdict.step1.outcome = 'blocked-unreadable';
    verdict.step1.reason = `resume-claim-routing reports an unreadable local worktree occupancy (${routing.reason}); refusing to preserve/remove an unverifiable worktree`;
    verdict.result = verdict.step1.reason;
    return verdict;
  } else {
    const lock = deps.checkLock(targetPath);
    if (lock.malformed) {
      verdict.step1.outcome = 'lock-malformed';
      verdict.step1.reason = 'worktree-local claim lock is malformed';
      verdict.result = verdict.step1.reason;
      return verdict;
    }
    if (!lockMatchesRecoveredClaim(lock, recoveredClaimId)) {
      verdict.step1.outcome = 'lock-mismatch';
      verdict.step1.reason = `lock holder claim-id (${lock.holder?.claimId ?? 'unknown'}) does not match the recovered claim-id (${recoveredClaimId ?? 'legacy'})`;
      verdict.result = verdict.step1.reason;
      return verdict;
    }
    verdict.step1.outcome = routing.reason.startsWith('released-claim-')
      ? 'blocked-released'
      : 'blocked-stale';
    verdict.step1.reason = routing.reason;
  }
  verdict.step1.claimId = recoveredClaimId;
  verdict.step1.branch = recoveredBranch;
  verdict.ready = true;
  // Dry-run always reports the full plan, regardless of the operator flag
  // -- reporting never mutates, so there is no safety reason to withhold it,
  // and it lets the operator preview everything before adding both
  // `--operator-confirmed-no-live-session` and `--apply`. The operator-flag
  // gate below applies to the ACTUAL mutation only.
  if (!args.apply) {
    const tag = `idd-lwr ${recoveredClaimId ?? 'legacy'}`;
    if (!shortcut.eligible) {
      const preserve = planAndMaybePreserve(
        targetPath,
        recoveredBranch ?? '',
        tag,
        false,
        deps,
      );
      verdict.plan.inProgressOperation = preserve.inProgressOperation;
      verdict.plan.stashes = preserve.stashes;
      verdict.plan.uninitializedSubmodules = preserve.uninitializedSubmodules;
      verdict.plan.backupRefs = preserve.backupRefs;
      verdict.plan.ignoredFilesCopied = preserve.ignoredFilesCopied;
      verdict.plan.ignoredFilesScanFailed = preserve.ignoredFilesScanFailed;
      verdict.plan.submoduleListFailed = preserve.submoduleListFailed;
      verdict.plan.submoduleAdminCopies = preserve.submoduleAdminCopies;
    }
    verdict.plan.removal = {
      kind: verdict.primaryOrLinked ?? 'linked',
      developmentBranch:
        verdict.primaryOrLinked === 'primary'
          ? deps.resolveDevelopmentBranch()
          : null,
      wouldRun: true,
      ran: false,
      detail:
        verdict.primaryOrLinked === 'primary'
          ? 'would checkout {development-branch} then hand-remove the lock file'
          : 'would run git worktree remove (retry --force only after a submodule-removal failure)',
    };
    verdict.result = 'dry-run: no mutation performed';
    return verdict;
  }
  // --apply: gate on the operator's own attestation BEFORE any mutation,
  // regardless of what step 1 found.
  if (!args.operatorConfirmedNoLiveSession) {
    verdict.result =
      'refusing: --operator-confirmed-no-live-session was not given (step 2 is never checked mechanically); no mutation';
    return verdict;
  }
  // --apply: steps 3 and 4.
  const tag = `idd-lwr ${recoveredClaimId ?? 'legacy'}`;
  if (!shortcut.eligible) {
    const preserve = planAndMaybePreserve(
      targetPath,
      recoveredBranch ?? '',
      tag,
      true,
      deps,
    );
    verdict.plan.inProgressOperation = preserve.inProgressOperation;
    verdict.plan.stashes = preserve.stashes;
    verdict.plan.uninitializedSubmodules = preserve.uninitializedSubmodules;
    verdict.plan.backupRefs = preserve.backupRefs;
    verdict.plan.ignoredFilesCopied = preserve.ignoredFilesCopied;
    verdict.plan.ignoredFilesScanFailed = preserve.ignoredFilesScanFailed;
    verdict.plan.submoduleListFailed = preserve.submoduleListFailed;
    verdict.plan.submoduleAdminCopies = preserve.submoduleAdminCopies;
    verdict.mutated =
      preserve.stashes.some((s) => s.stashed) ||
      preserve.backupRefs.some((r) => r.written) ||
      preserve.uninitializedSubmodules.some((s) => s.copiedTo !== null) ||
      preserve.ignoredFilesCopied.some((entry) => entry.copiedTo !== null) ||
      preserve.stashes.some(
        (stash) => stash.unmergedFallbackCopiedTo !== null,
      ) ||
      preserve.submoduleAdminCopies.some((entry) => entry.copiedTo !== null);
    if (!preservationVerified(preserve, deps.pathExists)) {
      verdict.result =
        'step 3 preservation could not be fully verified; stopping before removal';
      return verdict;
    }
  }
  const repoPath = verdict.primaryWorktree ?? cwd;
  const lockHandle = deps.acquireCloneLock(repoPath, args.agentId);
  try {
    const recheck = deps.confirmBlock(cwd);
    if (!recheck.ok || !recheck.routing) {
      verdict.plan.removal = {
        kind: verdict.primaryOrLinked ?? 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail: `fresh re-check failed: ${recheck.error ?? 'unknown error'}`,
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
    // CodeRabbit/Copilot findings: the shortcut path must be re-verified
    // fresh too, not merely exempted from the ordinary occupied re-check --
    // the clone-scoped lock's whole purpose is closing the window between
    // step 1's read and this mutation, and that window applies to the
    // shortcut exactly as much as the ordinary path. The ordinary
    // occupied/reason/path condition is required in BOTH branches (Copilot
    // review: the shortcut previously derived eligibility only from the
    // fresh worktree record and ignored the fresh routing result entirely,
    // so a claim that became live, or moved to a different claim, while the
    // record stayed prunable-and-absent could still authorize removal).
    const ordinaryStillOccupied =
      recheck.routing.state === 'local_worktree_occupied' &&
      isAcceptedBlockReason(recheck.routing.reason) &&
      (recheck.routing.evidence?.local_worktree?.paths ?? []).some(
        (reportedPath) =>
          normalizeGitWorktreePathForComparison(reportedPath) ===
          targetComparisonPath,
      );
    let stillEligible;
    let staleReason;
    if (shortcut.eligible) {
      const freshRecords = deps.listWorktreeRecords(cwd);
      stillEligible =
        freshRecords !== null &&
        evaluatePrunableShortcut(
          freshRecords,
          targetPath,
          recoveredBranch,
          deps.pathExists,
        ).eligible &&
        ordinaryStillOccupied;
      staleReason =
        'the prunable-and-absent record no longer matches at recheck time (it may have reappeared on disk, been locked, no longer names the recovered branch, or the issue claim state itself changed); stopping';
    } else {
      // Copilot review: the ordinary (non-shortcut) path must reject an
      // `-unreadable` reason here exactly as step 1 does -- unlike the
      // shortcut's own prunable-and-absent case (inherently unreadable by
      // construction, and independently gated by its own fail-closed
      // conditions), an ordinary worktree becoming unreadable AFTER step 1
      // means its true state is unknown, and proceeding to preserve/remove
      // it is unsafe.
      stillEligible =
        ordinaryStillOccupied &&
        !recheck.routing.reason.endsWith('-local-worktree-unreadable');
      staleReason =
        'the situation changed since step 1 (a live session resumed the claim, a different claim-id now holds the lock, the worktree became unreadable, or the branch no longer reports local_worktree_occupied); stopping';
    }
    if (!stillEligible) {
      verdict.plan.removal = {
        kind: verdict.primaryOrLinked ?? 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail: staleReason,
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
    // Copilot review: the fresh routing check above validates only
    // state/reason/path -- it never compared the rechecked active/released
    // claim (or branch) against the claim step 1 actually recovered. If the
    // issue moved to a DIFFERENT stale or legacy-released claim while this
    // session waited for the clone lock, an absent worktree-local lock
    // would still pass the lock-recheck below, and this session could
    // remove the new claim's worktree while tagging preserved artifacts
    // under the OLD, no-longer-current claim-id.
    const freshRecovered = extractRecoveredClaim(recheck.routing);
    if (
      freshRecovered.claimId !== recoveredClaimId ||
      freshRecovered.branch !== recoveredBranch
    ) {
      verdict.plan.removal = {
        kind: verdict.primaryOrLinked ?? 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail: `the claim being recovered changed since step 1 (was claim-id ${recoveredClaimId ?? 'legacy'} / branch ${recoveredBranch ?? 'unknown'}, now claim-id ${freshRecovered.claimId ?? 'legacy'} / branch ${freshRecovered.branch ?? 'unknown'}); stopping`,
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
    // Re-run the claim-lock check too, while the clone lock is held --
    // step 1's own lock check is stale the moment a concurrent session
    // could have replaced this shared admin directory's lock during the
    // wait to acquire the clone-scoped lock (mirrors step 1's own skip:
    // never re-checked for the prunable-and-absent shortcut, which never
    // checked it in the first place).
    if (!shortcut.eligible) {
      const lockRecheck = deps.checkLock(targetPath);
      // Mirrors step 1's own lock-check pass condition exactly: malformed
      // always fails; an active/recovered claim must still have its matching
      // lock, while a legacy release may have no lock or a legacy null-holder
      // lock; a present lock otherwise passes only when its holder matches.
      const lockStillMatches = lockMatchesRecoveredClaim(
        lockRecheck,
        recoveredClaimId,
      );
      if (!lockStillMatches) {
        verdict.plan.removal = {
          kind: verdict.primaryOrLinked ?? 'linked',
          developmentBranch: null,
          wouldRun: true,
          ran: false,
          detail:
            'the worktree-local claim lock no longer matches the recovered claim-id (a different session may have taken over); stopping',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      // Copilot review: step 3's own preservation check ran BEFORE this
      // lock was acquired, so its cached counts/booleans can go stale
      // during the wait to acquire it. Re-derive the same artifacts fresh,
      // now that the lock is actually held, immediately before removal.
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
          },
          targetPath,
          deps.runGit,
          deps.pathExists,
        )
      ) {
        verdict.plan.removal = {
          kind: verdict.primaryOrLinked ?? 'linked',
          developmentBranch: null,
          wouldRun: true,
          ran: false,
          detail:
            'a preservation artifact (stash entry or backup ref) no longer verifies fresh under the clone lock; stopping before removal',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
    }
    if (verdict.primaryOrLinked === 'primary') {
      const developmentBranch = deps.resolveDevelopmentBranch();
      const checkout = deps.runGit(['checkout', developmentBranch], targetPath);
      if (!checkout.ok) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `checkout ${developmentBranch} failed: ${checkout.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const confirmAbsent = deps.confirmBlock(cwd);
      const nowAbsent =
        confirmAbsent.ok &&
        confirmAbsent.routing?.evidence?.local_worktree?.status === 'absent';
      if (!nowAbsent) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail:
            'checked out {development-branch}, but resume-claim-routing does not yet report the branch absent; stopping before removing the lock file',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      // Copilot review: the documented primary flow requires the final
      // lock check to run immediately before deletion, on the primary
      // worktree NOW (after checkout) -- not the earlier `lockRecheck`
      // captured before the checkout even ran. A lock created or replaced
      // during the checkout window must not be silently deleted (or a
      // newly-created lock silently left behind while still reporting
      // success).
      const finalLockCheck = deps.checkLock(targetPath);
      if (finalLockCheck.malformed) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `checked out ${developmentBranch}, but the worktree-local lock is malformed on final check; stopping before removing anything`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      // Codex/Copilot review: only delete the lock file the fresh, final
      // `checkLock` positively observed -- never a bare "does a file
      // happen to exist now" check, which could delete a DIFFERENT lock
      // (re)created by another session after the recheck. When the final
      // check finds no lock, only a legacy release with no claim-id may
      // treat that as nothing further to do; an active/recovered claim that
      // lost its lock must stop. Any failure to resolve the git directory
      // or delete the positively-observed lock is a failed release, not a
      // silent best-effort no-op -- the CLI must not exit successfully
      // while a stale lock may still block recovery.
      if (!finalLockCheck.present) {
        if (recoveredClaimId !== null) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail:
              'checked out the development branch, but the recovered claim lock disappeared before the final check; stopping before removal',
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: true,
          detail: `checked out ${developmentBranch}; no worktree-local lock was present to remove`,
        };
        verdict.mutated = true;
        verdict.result = 'primary worktree released';
        return verdict;
      }
      if (!lockMatchesRecoveredClaim(finalLockCheck, recoveredClaimId)) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail:
            'the final primary-worktree lock belongs to a different claim-id; stopping before deletion',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const lockPath = deps.runGit(
        ['rev-parse', '--absolute-git-dir'],
        targetPath,
      );
      if (!lockPath.ok) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `checked out ${developmentBranch}, but could not resolve the git directory to remove the lock file: ${lockPath.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const idLockFile = join(lockPath.stdout.trim(), 'idd-claim.lock');
      try {
        unlinkSync(idLockFile);
      } catch (error) {
        const code = error.code;
        if (code !== 'ENOENT') {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail: `checked out ${developmentBranch}, but removing the lock file failed: ${error.message}`,
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        // ENOENT: already gone (e.g. removed by the same recovery on a
        // retried attempt) -- the positively-observed lock is confirmed
        // absent either way, matching claim-lock.mts's own release
        // semantics for an absent lock.
      }
      verdict.plan.removal = {
        kind: 'primary',
        developmentBranch,
        wouldRun: true,
        ran: true,
        detail: `checked out ${developmentBranch} and removed the lock file`,
      };
      verdict.mutated = true;
      verdict.result = 'primary worktree released';
      return verdict;
    }
    // Linked worktrees have no checkout transition that naturally forces a
    // final routing observation. Re-run routing and the local claim lock
    // immediately before `git worktree remove`, after every preservation
    // check, so a replacement claim cannot be removed by this recovery.
    const finalLinkedConfirm = deps.confirmBlock(cwd);
    const finalLinkedRouting = finalLinkedConfirm.routing;
    const finalLinkedRecovered = finalLinkedRouting
      ? extractRecoveredClaim(finalLinkedRouting)
      : null;
    const finalLinkedStillMatches =
      finalLinkedConfirm.ok &&
      finalLinkedRouting !== null &&
      finalLinkedRouting.state === 'local_worktree_occupied' &&
      isAcceptedBlockReason(finalLinkedRouting.reason) &&
      (shortcut.eligible ||
        !finalLinkedRouting.reason.endsWith('-local-worktree-unreadable')) &&
      (finalLinkedRouting.evidence?.local_worktree?.paths ?? []).includes(
        targetPath,
      ) &&
      finalLinkedRecovered?.claimId === recoveredClaimId &&
      finalLinkedRecovered.branch === recoveredBranch;
    if (!finalLinkedStillMatches) {
      verdict.plan.removal = {
        kind: 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail:
          'the final linked-worktree routing/claim identity no longer matches; stopping before removal',
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
    if (!shortcut.eligible) {
      const finalLinkedLock = deps.checkLock(targetPath);
      if (!lockMatchesRecoveredClaim(finalLinkedLock, recoveredClaimId)) {
        verdict.plan.removal = {
          kind: 'linked',
          developmentBranch: null,
          wouldRun: true,
          ran: false,
          detail:
            'the final linked-worktree lock no longer matches the recovered claim-id; stopping before removal',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
    }
    let remove = deps.runGit(
      shortcut.eligible
        ? ['worktree', 'remove', '--force', targetPath]
        : ['worktree', 'remove', targetPath],
      repoPath,
    );
    if (
      !shortcut.eligible &&
      !remove.ok &&
      /submodules cannot be moved or removed/i.test(remove.stderr)
    ) {
      remove = deps.runGit(
        ['worktree', 'remove', '--force', targetPath],
        repoPath,
      );
    }
    if (!remove.ok) {
      verdict.plan.removal = {
        kind: 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail: `git worktree remove failed: ${remove.stderr}`,
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
    deps.runGit(['worktree', 'prune'], repoPath);
    verdict.plan.removal = {
      kind: 'linked',
      developmentBranch: null,
      wouldRun: true,
      ran: true,
      detail: 'git worktree remove succeeded',
    };
    verdict.mutated = true;
    verdict.result = 'linked worktree removed';
    return verdict;
  } finally {
    deps.releaseCloneLock(lockHandle);
  }
}
// ---------------------------------------------------------------------------
// Production dependency wiring (real git / gh)
// ---------------------------------------------------------------------------
const VALID_BRANCH_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/;
/**
 * Resolve `{development-branch}` (§LWR step 4's primary-worktree branch):
 * `developmentBranch` from `.github/idd/config.json` when valid, else the
 * live GitHub default branch -- routed through `gh-exec.mts`'s
 * `readGithubRepoDefaultBranch` / `resolveCurrentGithubRepository` (never a
 * direct `gh` spawn; `tests/gh-spawn-guard.test.mts` enforces this
 * repository-wide).
 */
function resolveDevelopmentBranchProduction(args) {
  const config = loadIddConfig();
  const configured = config?.developmentBranch;
  if (typeof configured === 'string' && VALID_BRANCH_PATTERN.test(configured)) {
    return configured;
  }
  let fromGh;
  try {
    const resolvedRepo =
      args.owner && args.repo
        ? { owner: args.owner, repo: args.repo }
        : resolveCurrentGithubRepository();
    fromGh = readGithubRepoDefaultBranch(resolvedRepo.owner, resolvedRepo.repo);
  } catch (error) {
    throw new Error(
      `local-worktree-recovery: could not resolve {development-branch} (no valid developmentBranch in .github/idd/config.json, and the live default-branch lookup failed: ${error.message})`,
    );
  }
  if (!fromGh || !VALID_BRANCH_PATTERN.test(fromGh)) {
    throw new Error(
      `local-worktree-recovery: could not resolve a valid default branch name (got: ${fromGh ?? 'none'})`,
    );
  }
  return fromGh;
}
function copyPathProduction(from, to) {
  cpSync(from, to, { recursive: true, errorOnExist: false, force: true });
}
let preserveDirMemo = null;
function ensurePreserveDirProduction(explicit, targetPath) {
  return () => {
    if (preserveDirMemo) {
      return preserveDirMemo;
    }
    if (explicit) {
      preserveDirMemo = resolve(process.cwd(), explicit);
      return preserveDirMemo;
    }
    // Validate the base before mkdtempSync creates anything. Otherwise a
    // TMPDIR nested under the target would create the very backup directory
    // that the subsequent worktree removal is meant to preserve.
    const targetReal = realpathOrNull(targetPath);
    const tempBase = resolve(tmpdir());
    const tempBaseEffectiveReal = resolveEffectiveRealpath(
      tempBase,
      realpathOrNull,
      readlinkOrNull,
    );
    if (
      isPathContainedIn(tempBase, targetPath) ||
      (targetReal !== null &&
        tempBaseEffectiveReal !== null &&
        isPathContainedIn(tempBaseEffectiveReal, targetReal))
    ) {
      throw new Error(
        `local-worktree-recovery: generated preserve directory base (${tempBase}) must be outside the target worktree (${targetPath})`,
      );
    }
    preserveDirMemo = mkdtempSync(join(tempBase, 'idd-lwr-preserve-'));
    return preserveDirMemo;
  };
}
/**
 * Spawns the compiled sibling `resume-claim-routing.mjs` (§LWR step 1's
 * own documented invocation) -- resolved via `resolveBundleRoot` (not a
 * bare `import.meta.dirname`-relative join) so this also works when a test
 * imports this `.mts` source directly, one directory level deeper than the
 * compiled `.mjs` pair. Forwards ONLY `--issue`/`--owner`/`--repo`/
 * `--policy`/`--now` -- never this helper's own `--worktree`, which names
 * an unrelated owner-evidence redirect on that CLI.
 */
function confirmBlockProduction(args) {
  return (cwd) => {
    const root = resolveBundleRoot(import.meta.dirname);
    const script = join(root, 'scripts/resume-claim-routing.mjs');
    const argv = [script, '--issue', String(args.issue)];
    if (args.owner) argv.push('--owner', args.owner);
    if (args.repo) argv.push('--repo', args.repo);
    if (args.policy) argv.push('--policy', args.policy);
    if (args.now) argv.push('--now', args.now);
    try {
      const stdout = execFileSync(process.execPath, argv, {
        cwd,
        encoding: 'utf8',
      });
      return {
        ok: true,
        routing: JSON.parse(stdout),
        error: null,
      };
    } catch (error) {
      const execError = error;
      // A non-zero exit can still have printed a valid JSON verdict
      // (resume-claim-routing.mjs itself only ever exits non-zero on a
      // genuine usage/internal error, but tolerate a parseable payload
      // regardless of exit status rather than discarding it).
      if (execError.stdout) {
        try {
          return {
            ok: true,
            routing: JSON.parse(execError.stdout),
            error: null,
          };
        } catch {
          // fall through to the error report below
        }
      }
      return { ok: false, routing: null, error: error.message };
    }
  };
}
function listWorktreeRecordsProduction(cwd) {
  const result = runLocalGitCommand(
    ['worktree', 'list', '--porcelain', '-z'],
    cwd,
  );
  if (!result.ok) {
    return null;
  }
  try {
    return parseLocalWorktreeList(result.stdout);
  } catch {
    return null;
  }
}
function createProductionDeps(args) {
  return {
    cwd: () => process.cwd(),
    listWorktreeRecords: listWorktreeRecordsProduction,
    confirmBlock: confirmBlockProduction(args),
    checkLock: (worktreePath) => checkClaimLock(worktreePath),
    runGit: runLocalGitCommand,
    pathExists: pathExistsOnDisk,
    realpathOrNull,
    readlinkOrNull,
    acquireCloneLock: (repoPath, agentId) =>
      acquireCloneLock(repoPath, agentId),
    releaseCloneLock: (handle) => releaseCloneLock(handle),
    resolveDevelopmentBranch: () => resolveDevelopmentBranchProduction(args),
    copyPath: copyPathProduction,
    ensurePreserveDir: ensurePreserveDirProduction(
      args.preserveDir,
      resolve(process.cwd(), args.worktree),
    ),
    now: () => args.now || new Date().toISOString(),
  };
}
// ---------------------------------------------------------------------------
// CLI glue
// ---------------------------------------------------------------------------
const LOCAL_WORKTREE_RECOVERY_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--worktree': { type: 'string' },
  '--operator-confirmed-no-live-session': { type: 'boolean', default: false },
  '--apply': { type: 'boolean', default: false },
  '--agent-id': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--policy': { type: 'string' },
  '--now': { type: 'string' },
  '--preserve-dir': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
};
export function parseArgs(argv) {
  const { values, help } = parseCliArgs(
    argv,
    LOCAL_WORKTREE_RECOVERY_FLAG_SPEC,
  );
  const issueRaw = values.issue;
  const parsedIssue =
    issueRaw !== undefined && /^\d+$/.test(issueRaw) ? Number(issueRaw) : null;
  const issue = parsedIssue !== null && parsedIssue > 0 ? parsedIssue : null;
  const owner = (values.owner ?? '').trim();
  const repo = (values.repo ?? '').trim();
  if ((owner === '') !== (repo === '')) {
    throw markCliUsageError(
      new Error(
        'local-worktree-recovery: --owner and --repo must be provided together or not at all',
      ),
    );
  }
  return {
    issue,
    worktree: (values.worktree ?? '').trim(),
    operatorConfirmedNoLiveSession: Boolean(
      values['operator-confirmed-no-live-session'],
    ),
    apply: Boolean(values.apply),
    agentId: (values['agent-id'] ?? 'idd-lwr-operator').trim(),
    owner,
    repo,
    policy: (values.policy ?? '').trim(),
    now: (values.now ?? '').trim(),
    preserveDir: (values['preserve-dir'] ?? '').trim(),
    help: Boolean(help),
  };
}
function printHelp() {
  process.stdout.write(`
Usage:
  node scripts/local-worktree-recovery.mjs --issue <number> --worktree <path> [options]

  #3536: consolidates docs/idd-resume-detail.md's §LWR (Local Worktree
  Recovery) steps 1 ("confirm the block"), 3 ("preserve"), and 4 ("remove")
  into one invocation. Step 2 ("rule out a live session") is never checked
  mechanically -- see below.

Options:
  --issue <number>                          the issue whose stale/released claim occupies <path> (required)
  --worktree <path>                         the occupied worktree path to recover (required)
  --operator-confirmed-no-live-session      your own attestation that step 2 was performed independently (required for any mutation)
  --apply                                   perform steps 3/4 (default: dry-run report only, no mutation)
  --agent-id <id>                           clone-lock holder identity (default: idd-lwr-operator)
  --owner <owner> --repo <repo>             forwarded to the confirm-the-block check (both or neither)
  --policy <path>                           forwarded to the confirm-the-block check
  --now <ISO8601>                           forwarded to the confirm-the-block check
  --preserve-dir <path>                     destination for ignored-file / uninitialized-submodule / unmerged-path copies (default: a fresh temp directory, created only when needed)
  --help                                    show this help

Default (no --apply): dry-run. Reports step 1's confirm-the-block verdict
and exactly what step 3/4 would do, without mutating anything.

Refuses before ANY mutation, regardless of --apply or what step 1 finds,
when --operator-confirmed-no-live-session is not given -- this flag is the
operator's own attestation, never a mechanical check (claim-lock.mts's own
header documents why no local process-liveness signal is recorded).

Must be invoked from the primary worktree (or the primary worktree itself,
when that IS <path>), never from the linked worktree being recovered.
`);
}
function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.issue === null) {
    throw markCliUsageError(
      new Error('--issue is required and must be a positive integer'),
    );
  }
  if (!args.worktree) {
    throw markCliUsageError(new Error('--worktree is required'));
  }
  const deps = createProductionDeps(args);
  const verdict = runLocalWorktreeRecovery(args, deps);
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  // Under --apply, success means step 4's removal (or primary-worktree
  // release) actually ran -- `verdict.mutated` alone is not enough: step 3
  // can have already stashed changes or written a backup ref before a LATER
  // step-4 failure (a failed re-check, a lost claim, or `git worktree
  // remove` itself failing), which would otherwise report false success
  // while the worktree is still sitting there, unremoved.
  const success = args.apply
    ? (verdict.plan.removal?.ran ?? false)
    : verdict.ready;
  return success ? 0 : 1;
}
if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('local-worktree-recovery', () => {
      try {
        return runCli();
      } catch (error) {
        process.stderr.write(`Error: ${error.message}\n`);
        const classified = classifyHelperError(error);
        return {
          exitCode: 1,
          kind: classified.kind,
          message: classified.message,
          httpStatus: classified.httpStatus,
        };
      }
    });
  } else {
    try {
      applyHelperCliOutcomeWhenDisabled(runCli());
    } catch (error) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
