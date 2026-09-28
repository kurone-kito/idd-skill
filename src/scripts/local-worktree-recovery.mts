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
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';
import { resolveBundleRoot } from './bundle-root.mts';
import {
  type CheckLockOutcome,
  checkClaimLock,
  type PrimaryRecoveryLockMarker,
  updatePrimaryRecoveryLockMarker,
} from './claim-lock.mts';
import { parseCliArgs } from './cli-args.mts';
import {
  acquireCloneLock,
  type CloneLockHandle,
  releaseCloneLock,
} from './clone-lock.mts';
import { readGithubRepoDefaultBranch } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  classifyHelperError,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  type LocalWorktreeRecord,
  parseLocalWorktreeList,
} from './local-worktree-occupancy.mts';
import { inspectDevelopmentBranch } from './policy-helpers.mts';
import { resolveCurrentGithubRepository } from './provider-adapter-github.mts';

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
function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Recovery branches on a small number of Git diagnostics (for example
  // `needs merge` and `submodules cannot be moved or removed`). Keep those
  // predicates stable when the operator's locale is not English (Codex
  // review #4114376798).
  env.LC_ALL = 'C';
  env.LANG = 'C';
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

/** Non-throwing `git <argv>` in `cwd`. */
export interface LocalGitCommandResult {
  ok: boolean;
  status: number | null;
  stdout: string;
  stderr: string;
}

function runLocalGitCommand(
  argv: string[],
  cwd: string,
): LocalGitCommandResult {
  try {
    const stdout = execFileSync('git', argv, {
      cwd,
      env: sanitizedGitEnvironment(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, status: 0, stdout, stderr: '' };
  } catch (error) {
    const execError = error as {
      status?: number | null;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      ok: false,
      status: execError.status ?? null,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? execError.message ?? '',
    };
  }
}

export type PathPresence = 'present' | 'absent' | 'unknown';

function pathPresenceOnDisk(path: string): PathPresence {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

function pathExistsOnDisk(path: string): boolean {
  return pathPresenceOnDisk(path) === 'present';
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readlinkOrNull(path: string): string | null {
  try {
    return readlinkSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed subset of `resume-claim-routing.mjs`'s JSON output this helper
 * actually reads. The full shape is documented in
 * `idd-overview-core.instructions.md`'s Claim-state parsing section; only
 * the fields step 1 needs are modeled here. */
export interface ConfirmBlockRouting {
  state: string;
  reason: string;
  active_claim: { claim_id: string | null; branch: string | null } | null;
  evidence?: {
    local_worktree?: { status: string; paths: string[]; reason: string | null };
    released_claim?: { claim_id: string | null; branch: string | null };
  };
}

/** Outcome of a single confirm-the-block spawn (production) or stub (tests). */
export interface ConfirmBlockOutcome {
  ok: boolean;
  /** Raw parsed JSON when `ok`, else null. */
  routing: ConfirmBlockRouting | null;
  /** Diagnostic text when `!ok` (spawn/parse failure). */
  error: string | null;
}

/** Filesystem identity for a directory whose path may be reused by a
 * concurrent worktree replacement. String values keep the verdict and test
 * seams serializable across POSIX and Windows bigint stat implementations. */
export interface DirectoryIdentity {
  dev: string;
  ino: string;
}

interface TargetWorktreeIdentity {
  worktreePath: string;
  worktree: DirectoryIdentity;
  adminPath: string;
  admin: DirectoryIdentity;
}

function readDirectoryIdentity(path: string): DirectoryIdentity {
  const stat = statSync(path, { bigint: true });
  if (!stat.isDirectory()) {
    throw new Error(`not a directory: ${path}`);
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() };
}

function sameDirectoryIdentity(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function resolveTargetWorktreeIdentity(
  targetPath: string,
  deps: Pick<LocalWorktreeRecoveryDeps, 'runGit' | 'readDirectoryIdentity'>,
): TargetWorktreeIdentity | null {
  const gitDir = deps.runGit(['rev-parse', '--absolute-git-dir'], targetPath);
  if (!gitDir.ok || gitDir.stdout.trim().length === 0) return null;
  const adminPath = resolve(gitDir.stdout.trim());
  return {
    worktreePath: targetPath,
    worktree: deps.readDirectoryIdentity(targetPath),
    adminPath,
    admin: deps.readDirectoryIdentity(adminPath),
  };
}

function sameTargetWorktreeIdentity(
  before: TargetWorktreeIdentity,
  after: TargetWorktreeIdentity | null,
): boolean {
  return (
    after !== null &&
    before.worktreePath === after.worktreePath &&
    before.adminPath === after.adminPath &&
    sameDirectoryIdentity(before.worktree, after.worktree) &&
    sameDirectoryIdentity(before.admin, after.admin)
  );
}

/** In-progress-operation kinds §LWR step 3 must detect and back up rather
 * than resume. */
export type InProgressOperationKind =
  | 'merge'
  | 'rebase'
  | 'cherry-pick'
  | 'bisect';

export interface InProgressOperation {
  kind: InProgressOperationKind;
  /** The pre-operation tip to preserve -- `orig-head` for rebase, the
   * `BISECT_START` ref's own tip for bisect (never the mid-bisect `HEAD`,
   * which is the commit currently under test), else HEAD. `null` when the
   * operation is detected but its tip could not be resolved -- the caller
   * must fail closed (never fall back to the ordinary unpushed-commit
   * check) rather than silently skip preservation. */
  tipSha: string | null;
}

export interface SubmoduleInProgressOperation {
  path: string;
  operation: InProgressOperation;
}

/** One stash-preservation record (the worktree itself, scope `'.'`, or a
 * submodule's relative path). */
export interface StashPlanEntry {
  scope: string;
  tag: string;
  hasChanges: boolean;
  /** True when the scope already had any stash entry, not only this tag. */
  hasStashes: boolean;
  /** True when the `git status` probe itself failed (not merely "clean") --
   * Codex/Copilot review: this must block removal, never read as `hasChanges:
   * false`. */
  statusReadFailed: boolean;
  /** True when either baseline or post-stash `git stash list` failed. */
  stashListReadFailed: boolean;
  baselineCount: number;
  stashed: boolean;
  verifiedCount: number | null;
  /** Exact default-format stash-list line created by this recovery. */
  createdStashEntry: string | null;
  unmergedFallbackCopiedTo: string | null;
  /** Every individual destination attempted by the unmerged-path fallback.
   * The directory itself is not proof that each dirty path survived. */
  unmergedFallbackCopiedFiles: string[];
  /** True only once every dirty path in this scope (not just the
   * `--diff-filter=U` conflicted subset) was confirmed copied out, when the
   * `stash push` fallback ran. `null` when the fallback never ran. */
  unmergedFallbackAllPreserved: boolean | null;
  /** True when `stash push` failed for a reason OTHER than the verified
   * unmerged-path case (Copilot review) -- a hard failure that must block
   * removal; a plain working-tree file copy is not equivalent
   * preservation to a stash's index state. */
  hardStashFailure: boolean;
}

/** One unpushed-commits backup-ref record. */
export interface BackupRefPlanEntry {
  scope: string;
  ref: string;
  hasUnpushed: boolean;
  /** True when the unpushed-commit probe itself (`git rev-parse HEAD` or
   * `git log @{u}..HEAD`) failed -- must block removal even though
   * `hasUnpushed` reads `false` in that case (Copilot/Codex review). */
  unpushedQueryFailed: boolean;
  tipSha: string | null;
  /** True when any local ref is reachable from a commit not advertised by a
   * remote; submodule admin data must be copied before worktree removal. */
  hasLocalOnlyRefs: boolean;
  /** True when the local-only-ref probe failed and preservation is unknown. */
  localRefsQueryFailed: boolean;
  /** Snapshot of the private local-ref names used to verify a resumed
   * primary recovery. Persist it in the marker instead of relying on a
   * process-local object identity. */
  localRefsSnapshot: string | null;
  written: boolean;
  verifiedOid: string | null;
}

export interface UninitializedSubmoduleEntry {
  path: string;
  copiedTo: string | null;
  /** True when copying started but failed, possibly leaving a partial
   * destination. Keep the attempted destination visible while failing
   * closed before worktree removal. */
  copyFailed: boolean;
}

export interface IgnoredFileEntry {
  scope: string;
  path: string;
  copiedTo: string | null;
  /** True when copying started but failed, possibly leaving a partial
   * destination. Keep the attempted destination visible while failing
   * closed before worktree removal. */
  copyFailed: boolean;
}

export interface SubmoduleAdminCopyEntry {
  path: string;
  copiedTo: string | null;
  plannedTo: string | null;
  /** True when the recursive copy may have left a partial destination. */
  copyFailed: boolean;
}

export interface WorktreeAdminCopyEntry {
  copiedTo: string | null;
  plannedTo: string | null;
}

export interface PrunableAdminCopyEntry {
  source: string;
  copiedTo: string | null;
  /** True when the recursive copy may have left a partial destination. */
  copyFailed: boolean;
  /** Destination that `--apply` will use, when it can be planned without
   * creating the preserve directory during a dry-run. */
  plannedTo: string | null;
}

export interface WorktreeAdminDirLookup {
  path: string | null;
  error: string | null;
}

export interface RemovalPlan {
  kind: 'primary' | 'linked';
  developmentBranch: string | null;
  wouldRun: boolean;
  ran: boolean;
  detail: string;
}

export interface LocalWorktreeRecoveryVerdict {
  protocolVersion: '1';
  mode: 'dry-run' | 'apply';
  issueNumber: number;
  worktree: string;
  primaryWorktree: string | null;
  operatorConfirmed: boolean;
  step1: {
    outcome:
      | 'blocked-stale'
      | 'blocked-released'
      | 'blocked-prunable'
      | 'blocked-primary-resume'
      | 'not-blocked'
      | 'lock-mismatch'
      | 'lock-malformed'
      | 'confirm-failed'
      | 'path-mismatch'
      | 'cwd-inside-target'
      | 'cwd-outside-primary'
      | 'preserve-dir-inside-target-gitdir'
      | 'target-gitdir-unresolved'
      | 'blocked-unreadable'
      | 'preserve-dir-inside-target'
      | 'preserve-dir-exists'
      | 'worktree-list-failed';
    claimId: string | null;
    branch: string | null;
    reason: string;
  };
  ready: boolean;
  primaryOrLinked: 'primary' | 'linked' | null;
  plan: {
    prunableShortcut: boolean;
    inProgressOperation: InProgressOperation | null;
    submoduleInProgressOperations: SubmoduleInProgressOperation[];
    stashes: StashPlanEntry[];
    uninitializedSubmodules: UninitializedSubmoduleEntry[];
    backupRefs: BackupRefPlanEntry[];
    ignoredFilesCopied: IgnoredFileEntry[];
    ignoredFilesScanFailed: boolean;
    submoduleListFailed: boolean;
    submoduleAdminCopies: SubmoduleAdminCopyEntry[];
    worktreeAdminCopy: WorktreeAdminCopyEntry | null;
    prunableAdminCopy: PrunableAdminCopyEntry | null;
    removal: RemovalPlan | null;
  };
  preserveDir: string | null;
  mutated: boolean;
  result: string;
}

export interface LocalWorktreeRecoveryArgs {
  issue: number | null;
  worktree: string;
  operatorConfirmedNoLiveSession: boolean;
  apply: boolean;
  agentId: string;
  owner: string;
  repo: string;
  policy: string;
  now: string;
  preserveDir: string;
  help: boolean;
}

type PrimaryRecoveryPreservationManifest = {
  inProgressOperation: InProgressOperation | null;
  submoduleInProgressOperations: SubmoduleInProgressOperation[];
  stashes: StashPlanEntry[];
  uninitializedSubmodules: UninitializedSubmoduleEntry[];
  backupRefs: BackupRefPlanEntry[];
  ignoredFilesCopied: IgnoredFileEntry[];
  ignoredFilesScanFailed: boolean;
  submoduleListFailed: boolean;
  submoduleAdminCopies: SubmoduleAdminCopyEntry[];
  worktreeAdminCopy: WorktreeAdminCopyEntry | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isInProgressOperation(value: unknown): value is InProgressOperation {
  return (
    isRecord(value) &&
    (value.kind === 'merge' ||
      value.kind === 'rebase' ||
      value.kind === 'cherry-pick' ||
      value.kind === 'bisect') &&
    isNullableString(value.tipSha)
  );
}

function isStashPlanEntry(value: unknown): value is StashPlanEntry {
  return (
    isRecord(value) &&
    typeof value.scope === 'string' &&
    typeof value.tag === 'string' &&
    typeof value.hasChanges === 'boolean' &&
    typeof value.hasStashes === 'boolean' &&
    typeof value.statusReadFailed === 'boolean' &&
    typeof value.stashListReadFailed === 'boolean' &&
    typeof value.baselineCount === 'number' &&
    typeof value.stashed === 'boolean' &&
    (value.verifiedCount === null || typeof value.verifiedCount === 'number') &&
    isNullableString(value.createdStashEntry) &&
    isNullableString(value.unmergedFallbackCopiedTo) &&
    Array.isArray(value.unmergedFallbackCopiedFiles) &&
    value.unmergedFallbackCopiedFiles.every(
      (entry) => typeof entry === 'string',
    ) &&
    (value.unmergedFallbackAllPreserved === null ||
      typeof value.unmergedFallbackAllPreserved === 'boolean') &&
    typeof value.hardStashFailure === 'boolean'
  );
}

function isBackupRefPlanEntry(value: unknown): value is BackupRefPlanEntry {
  return (
    isRecord(value) &&
    typeof value.scope === 'string' &&
    typeof value.ref === 'string' &&
    typeof value.hasUnpushed === 'boolean' &&
    typeof value.unpushedQueryFailed === 'boolean' &&
    isNullableString(value.tipSha) &&
    typeof value.hasLocalOnlyRefs === 'boolean' &&
    typeof value.localRefsQueryFailed === 'boolean' &&
    (value.localRefsSnapshot === undefined ||
      isNullableString(value.localRefsSnapshot)) &&
    typeof value.written === 'boolean' &&
    isNullableString(value.verifiedOid)
  );
}

function isPrimaryRecoveryPreservationManifest(
  value: unknown,
): value is PrimaryRecoveryPreservationManifest {
  if (!isRecord(value)) return false;
  const submoduleOperations = value.submoduleInProgressOperations;
  const uninitialized = value.uninitializedSubmodules;
  const ignored = value.ignoredFilesCopied;
  const submoduleAdmin = value.submoduleAdminCopies;
  const worktreeAdmin = value.worktreeAdminCopy;
  return (
    (value.inProgressOperation === null ||
      isInProgressOperation(value.inProgressOperation)) &&
    Array.isArray(submoduleOperations) &&
    submoduleOperations.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        isInProgressOperation(entry.operation),
    ) &&
    Array.isArray(value.stashes) &&
    value.stashes.every(isStashPlanEntry) &&
    Array.isArray(uninitialized) &&
    uninitialized.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        isNullableString(entry.copiedTo) &&
        typeof entry.copyFailed === 'boolean',
    ) &&
    Array.isArray(value.backupRefs) &&
    value.backupRefs.every(isBackupRefPlanEntry) &&
    Array.isArray(ignored) &&
    ignored.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.scope === 'string' &&
        typeof entry.path === 'string' &&
        isNullableString(entry.copiedTo) &&
        typeof entry.copyFailed === 'boolean',
    ) &&
    typeof value.ignoredFilesScanFailed === 'boolean' &&
    typeof value.submoduleListFailed === 'boolean' &&
    Array.isArray(submoduleAdmin) &&
    submoduleAdmin.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.path === 'string' &&
        isNullableString(entry.copiedTo) &&
        isNullableString(entry.plannedTo) &&
        typeof entry.copyFailed === 'boolean',
    ) &&
    (worktreeAdmin === null ||
      (isRecord(worktreeAdmin) &&
        isNullableString(worktreeAdmin.copiedTo) &&
        isNullableString(worktreeAdmin.plannedTo)))
  );
}

function parsePrimaryRecoveryPreservationManifest(
  encoded: string | undefined,
): PrimaryRecoveryPreservationManifest | null {
  if (encoded === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!isPrimaryRecoveryPreservationManifest(parsed)) return null;
    return {
      ...parsed,
      // Older interrupted recoveries did not persist this process-local
      // snapshot. Treat those markers as having an unknown snapshot so they
      // remain resumable without weakening the post-checkout verification.
      backupRefs: parsed.backupRefs.map((entry) => ({
        ...entry,
        localRefsSnapshot: entry.localRefsSnapshot ?? null,
      })),
    };
  } catch {
    return null;
  }
}

function primaryRecoveryManifestFromPlan(
  plan: LocalWorktreeRecoveryVerdict['plan'],
): PrimaryRecoveryPreservationManifest {
  return {
    inProgressOperation: plan.inProgressOperation,
    submoduleInProgressOperations: plan.submoduleInProgressOperations,
    stashes: plan.stashes,
    uninitializedSubmodules: plan.uninitializedSubmodules,
    backupRefs: plan.backupRefs,
    ignoredFilesCopied: plan.ignoredFilesCopied,
    ignoredFilesScanFailed: plan.ignoredFilesScanFailed,
    submoduleListFailed: plan.submoduleListFailed,
    submoduleAdminCopies: plan.submoduleAdminCopies,
    worktreeAdminCopy: plan.worktreeAdminCopy,
  };
}

export interface LocalWorktreeRecoveryDeps {
  /** `process.cwd()`, injectable for tests. */
  cwd: () => string;
  /** `git worktree list --porcelain -z` parsed, run from `cwd`. */
  /** `null` when `git worktree list` itself failed or produced unparseable
   * output -- distinct from (impossible in practice) a genuinely empty
   * list, since a repository always has at least the primary worktree.
   * Must never silently degrade to `[]` (Copilot review): that would
   * misclassify the target as `linked` and let `primaryWorktree` resolve
   * to `null` without ever establishing which record is actually primary. */
  listWorktreeRecords: (cwd: string) => LocalWorktreeRecord[] | null;
  /** Spawns (production) or stubs (tests) the confirm-the-block check.
   * Called once for step 1 and again for step 4's fresh re-check. */
  confirmBlock: (cwd: string) => ConfirmBlockOutcome;
  /** `checkClaimLock`, called directly (no network, no subprocess). */
  checkLock: (worktreePath: string) => CheckLockOutcome;
  /** Remove only a lock whose ownership token still matches the final read. */
  removeLockIfMatches: (
    worktreePath: string,
    expected: CheckLockOutcome,
  ) => boolean;
  /** Run a forced linked-worktree removal only while the complete claim-lock
   * ownership token still matches the final read. `null` means that the
   * token changed before the destructive command could start. */
  removeWorktreeIfLockMatches?: (
    worktreePath: string,
    repoPath: string,
    expected: CheckLockOutcome,
    force: boolean,
  ) => LocalGitCommandResult | null;
  /** Add or clear the primary-checkout recovery marker while the clone lock
   * is held. Optional for pure unit-test seams; production always provides it. */
  updatePrimaryRecoveryLockMarker?: (
    worktreePath: string,
    expected: CheckLockOutcome,
    marker: PrimaryRecoveryLockMarker | null,
  ) => boolean;
  /** Locate the primary repository's private admin directory for a worktree
   * whose checkout directory has already disappeared. */
  findWorktreeAdminDir?: (
    repoPath: string,
    worktreePath: string,
  ) => WorktreeAdminDirLookup;
  /** Non-throwing `git <argv>` in `cwd`. */
  runGit: (argv: string[], cwd: string) => LocalGitCommandResult;
  pathExists: (path: string) => boolean;
  /** Distinguishes a positively absent path from an unreadable one for
   * destructive shortcut decisions. */
  pathPresence?: (path: string) => PathPresence;
  /** Read the filesystem identity of a directory before and after the
   * clone-lock wait. Device/inode identity distinguishes a worktree or its
   * private git-admin directory being removed and recreated at the same
   * path while preservation is in progress. */
  readDirectoryIdentity: (path: string) => DirectoryIdentity;
  realpathOrNull: (path: string) => string | null;
  readlinkOrNull: (path: string) => string | null;
  acquireCloneLock: (repoPath: string, agentId: string) => CloneLockHandle;
  releaseCloneLock: (handle: CloneLockHandle) => void;
  resolveDevelopmentBranch: () => string;
  copyPath: (
    from: string,
    to: string,
    sourceRoot?: string,
    additionalSourceRoots?: string[],
  ) => void;
  /** Remove one already-verified recovery source path. */
  removePath: (path: string) => void;
  ensurePreserveDir: () => string;
  now: () => string;
}

function pathPresenceForDeps(
  deps: Pick<LocalWorktreeRecoveryDeps, 'pathExists' | 'pathPresence'>,
  path: string,
): PathPresence {
  return (
    deps.pathPresence?.(path) ?? (deps.pathExists(path) ? 'present' : 'absent')
  );
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

/** True when `routing.reason` matches §LWR step 1's own accepted prefixes. */
export function isAcceptedBlockReason(reason: string): boolean {
  return (
    reason.startsWith('stale-claim-') || reason.startsWith('released-claim-')
  );
}

/** True when routing proves that the prior claim was released. An active
 * legacy claim also has a null claim-id, but its lockless recovery is not
 * safe because the absence of a lock does not prove release. */
function isReleasedClaimRouting(routing: ConfirmBlockRouting): boolean {
  return (
    routing.active_claim === null &&
    (routing.reason.startsWith('released-claim-') ||
      (routing.state === 'unclaimed' &&
        (routing.reason === 'legacy-released' ||
          (routing.reason === 'no-active-claim' &&
            routing.evidence?.released_claim?.claim_id !== null &&
            routing.evidence?.released_claim?.branch !== null))))
  );
}

/** True when an explicit absent probe still belongs to a takeover-eligible
 * stale claim or to a released claim with retained released-claim evidence.
 * A prunable record is not enough by itself: a fresh claim can leave the
 * record absent while its live owner still has the right to recreate or use
 * the worktree. */
function isPrunableShortcutRouting(routing: ConfirmBlockRouting): boolean {
  return routing.state === 'stale' || isReleasedClaimRouting(routing);
}

/** True only when an absent worktree is still eligible for stale/legacy
 * takeover. An absent path alone is not enough: a fresh claim may have
 * already become non-inheritable while the checkout is being released. */
function isTakeoverEligibleAbsentRouting(
  routing: ConfirmBlockRouting,
): boolean {
  return (
    isPrunableShortcutRouting(routing) &&
    routing.evidence?.local_worktree?.status === 'absent' &&
    (routing.evidence.local_worktree.paths ?? []).length === 0
  );
}

/** Match a worktree-local lock to the claim recovered by routing. Legacy
 * releases may have no lock or an explicitly legacy/null holder, but a
 * non-null holder must never be treated as legacy. Active legacy claims are
 * never allowed through this lockless branch. */
function lockMatchesRecoveredClaim(
  lock: CheckLockOutcome,
  recoveredClaimId: string | null,
  legacyRelease: boolean,
): boolean {
  if (lock.malformed) return false;
  if (recoveredClaimId === null) {
    return (
      legacyRelease &&
      (!lock.present ||
        lock.holder?.claimId === null ||
        (lock.holder?.claimId === '' &&
          lock.holder.primaryRecovery?.claimId === '' &&
          lock.holder.primaryRecovery.releasedClaim))
    );
  }
  return lock.present && lock.holder?.claimId === recoveredClaimId;
}

function sameClaimLock(
  left: CheckLockOutcome,
  right: CheckLockOutcome,
): boolean {
  if (
    left.path === right.path &&
    !left.present &&
    !right.present &&
    !left.malformed &&
    !right.malformed
  ) {
    return true;
  }
  return (
    left.path === right.path &&
    left.present &&
    !left.malformed &&
    right.present &&
    !right.malformed &&
    left.holder?.agentId === right.holder?.agentId &&
    left.holder?.claimId === right.holder?.claimId &&
    left.holder?.acquiredAt === right.holder?.acquiredAt
  );
}

/** Extract the recovered claim-id (null for a legacy pre-claim-id release)
 * and the occupying branch from a confirmed `local_worktree_occupied`
 * routing result. */
export function extractRecoveredClaim(routing: ConfirmBlockRouting): {
  claimId: string | null;
  branch: string | null;
} {
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
  worktreePath: string,
  pathSeparator = sep,
): string {
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
  records: LocalWorktreeRecord[],
  targetPath: string,
  requestedBranch: string | null,
  pathExists: (path: string) => boolean,
  pathPresence: (path: string) => PathPresence = (path) =>
    pathExists(path) ? 'present' : 'absent',
): { eligible: boolean; record: LocalWorktreeRecord | null; reason: string } {
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
  const presence = pathPresence(record.path);
  if (presence !== 'absent') {
    return {
      eligible: false,
      record,
      reason:
        presence === 'present'
          ? 'path still exists on disk'
          : 'path presence is unknown; refusing shortcut',
    };
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
export function detectInProgressOperation(
  path: string,
  runGit: (argv: string[], cwd: string) => LocalGitCommandResult,
  pathExists: (p: string) => boolean,
  readFile: (p: string) => string | null,
  pathPresence: (p: string) => PathPresence = (candidate) =>
    pathExists(candidate) ? 'present' : 'absent',
): InProgressOperation | null {
  const markerPresence = (
    marker: 'MERGE_HEAD' | 'CHERRY_PICK_HEAD',
  ): PathPresence | null => {
    const markerPath = runGit(['rev-parse', '--git-path', marker], path);
    const resolved = markerPath.ok ? markerPath.stdout.trim() : '';
    if (!resolved) return null;
    const absolute = isAbsolute(resolved) ? resolved : join(path, resolved);
    return pathPresence(absolute);
  };
  const merge = runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], path);
  if (merge.ok) {
    const head = runGit(['rev-parse', 'HEAD'], path);
    // A failed `rev-parse HEAD` here must never silently resolve to an
    // empty-string "tip" -- fail closed (null) the same way the bisect
    // branch below does, rather than let a blank tipSha slip through.
    return { kind: 'merge', tipSha: head.ok ? head.stdout.trim() : null };
  }
  const mergePresence = markerPresence('MERGE_HEAD');
  if (mergePresence === 'present' || mergePresence === 'unknown') {
    return { kind: 'merge', tipSha: null };
  }
  for (const name of ['rebase-merge', 'rebase-apply'] as const) {
    const gitPath = runGit(['rev-parse', '--git-path', name], path);
    if (!gitPath.ok) continue;
    const resolved = gitPath.stdout.trim();
    if (!resolved) continue;
    const absolute = isAbsolute(resolved) ? resolved : join(path, resolved);
    const presence = pathPresence(absolute);
    if (presence === 'absent') continue;
    if (presence === 'unknown') {
      return { kind: 'rebase', tipSha: null };
    }
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
  const cherryPickPresence = markerPresence('CHERRY_PICK_HEAD');
  if (cherryPickPresence === 'present' || cherryPickPresence === 'unknown') {
    return { kind: 'cherry-pick', tipSha: null };
  }
  const bisectLogPath = runGit(['rev-parse', '--git-path', 'BISECT_LOG'], path);
  if (bisectLogPath.ok) {
    const resolved = bisectLogPath.stdout.trim();
    const absolute = isAbsolute(resolved) ? resolved : join(path, resolved);
    const presence = resolved ? pathPresence(absolute) : 'absent';
    if (presence === 'unknown') {
      return { kind: 'bisect', tipSha: null };
    }
    if (resolved && presence === 'present') {
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
      let tipSha: string | null = null;
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

function clearInProgressOperation(
  path: string,
  operation: InProgressOperation,
  runGit: LocalWorktreeRecoveryDeps['runGit'],
  pathPresence?: LocalWorktreeRecoveryDeps['pathPresence'],
): string | null {
  const command: string[] =
    operation.kind === 'rebase'
      ? ['rebase', '--quit']
      : operation.kind === 'merge'
        ? ['merge', '--abort']
        : operation.kind === 'cherry-pick'
          ? ['cherry-pick', '--abort']
          : ['bisect', 'reset'];
  const cleared = runGit(command, path);
  if (!cleared.ok) {
    return `could not clear the in-progress ${operation.kind}: ${cleared.stderr}`;
  }
  if (operation.kind === 'rebase') {
    // `rebase --quit` is the documented recovery cleanup: it removes the
    // operation metadata without rewinding the recovered worktree. A
    // conflicted rebase can still leave unmerged index entries behind,
    // though, and Git refuses the primary-worktree checkout until that
    // index and its conflict files are released. The conflict files were
    // already copied by the unmerged-stash fallback before this point, so a
    // hard reset can safely clear the recovered worktree before checkout.
    const unmerged = runGit(
      ['diff', '--name-only', '--diff-filter=U', '--'],
      path,
    );
    if (!unmerged.ok) {
      return `could not inspect the rebase index after cleanup: ${unmerged.stderr}`;
    }
    if (unmerged.stdout.trim().length > 0) {
      const reset = runGit(['reset', '--hard'], path);
      if (!reset.ok) {
        return `could not clear unmerged rebase index entries: ${reset.stderr}`;
      }
    }
  }
  const remaining = detectInProgressOperation(
    path,
    runGit,
    (candidate) => {
      try {
        statSync(candidate);
        return true;
      } catch {
        return false;
      }
    },
    (candidate) => {
      try {
        return readFileSync(candidate, 'utf8');
      } catch {
        return null;
      }
    },
    pathPresence,
  );
  return remaining === null
    ? null
    : `the in-progress ${operation.kind} remained after cleanup`;
}

function resolveDeinitializedSubmoduleGitDir(
  targetGitDir: string | null,
  submodulePath: string,
  initializedSubmodulePaths: readonly string[],
  pathExists: (path: string) => boolean,
): string | null {
  if (targetGitDir === null) return null;
  const segments = submodulePath.split(/[\\/]/g).filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '.' || segment === '..')
  ) {
    return null;
  }
  const initialized = new Set(
    initializedSubmodulePaths.map((path) =>
      path.split(/[\\/]/g).filter(Boolean).join('/'),
    ),
  );
  // Git nests a child submodule's admin directory below the `modules/`
  // directory of each initialized ancestor. Build that one layout directly
  // from the known initialized boundaries, plus the plain layout as a
  // compatibility fallback. The former recursive enumeration considered
  // every possible `modules/` insertion and grew as 2^(N-1) candidates for a
  // path with N components (Copilot review #4116253158).
  const canonicalParts = ['modules'];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    canonicalParts.push(segment);
    const prefix = segments.slice(0, index + 1).join('/');
    if (index < segments.length - 1 && initialized.has(prefix)) {
      canonicalParts.push('modules');
    }
  }
  const canonical = join(targetGitDir, ...canonicalParts);
  const plain = join(targetGitDir, 'modules', ...segments);
  const candidates = canonical === plain ? [canonical] : [canonical, plain];
  return candidates.find(pathExists) ?? canonical;
}

/** True when `git status --porcelain --ignored --untracked-files=normal`
 * reports at least one tracked/untracked change (any line not prefixed
 * `!!`, which marks an ignored path). */
export function hasWorkingTreeChanges(statusPorcelain: string): boolean {
  return statusPorcelain
    .split('\n')
    .some((line) => line.length > 0 && !line.startsWith('!!'));
}

/** The ignored-file paths (`!!`-prefixed lines) reported by the same status
 * scan, relative to the scanned path. */
export function extractIgnoredPaths(statusPorcelain: string): string[] {
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
function decodeGitQuotedPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) {
    return path;
  }
  const input = path.slice(1, -1);
  const bytes: number[] = [];
  const simpleEscapes: Record<string, number> = {
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
export interface DirtyPathEntry {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
}

/** Git porcelain's seven unmerged XY pairs. */
function isUnmergedStatus(
  indexStatus: string,
  worktreeStatus: string,
): boolean {
  return new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']).has(
    `${indexStatus}${worktreeStatus}`,
  );
}

export function extractDirtyEntries(statusPorcelain: string): DirtyPathEntry[] {
  const entries: DirtyPathEntry[] = [];
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
      entries.push({
        path: decodeGitQuotedPath(rest),
        indexStatus: status[0] ?? ' ',
        worktreeStatus: status[1] ?? ' ',
      });
    }
  }
  return entries;
}

/** True only for Git's structured diagnostics for an unmerged-path stash
 * refusal. A filename containing the word "unmerged" (or an unrelated
 * permission/lock error mentioning it) must not activate the copy-out
 * fallback, because a plain worktree copy cannot preserve the index state. */
function isUnmergedStashFailure(result: LocalGitCommandResult): boolean {
  const lines = `${result.stdout}\n${result.stderr}`.split(/\r?\n/);
  return lines.some(
    (line) =>
      /^\s*(?:error:\s*)?.+?:\s*needs merge\s*$/i.test(line) ||
      /^\s*unmerged paths:\s*$/i.test(line),
  );
}

// audit:ignore-dead-export: exported for focused parser tests; production use remains in this module
export function extractDirtyPaths(statusPorcelain: string): string[] {
  return extractDirtyEntries(statusPorcelain).map((entry) => entry.path);
}

/** Find the porcelain rename separator without mistaking an arrow inside a
 * C-quoted filename for the status record's delimiter. */
function findPorcelainRenameSeparator(record: string): number {
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
export function isSafeRelativePath(relativePath: string): boolean {
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
export function isPathContainedIn(child: string, parent: string): boolean {
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
    !rel
      .split(sep === '\\' ? /[\\/]+/ : /[/]+/)
      .some((segment) => segment === '..')
  );
}

/** Return false when a copy destination (including a not-yet-existing suffix)
 * resolves into the worktree or its private linked-worktree gitdir, either of
 * which can disappear during removal. Checking the effective path catches a
 * symlinked child directory under an otherwise safe preserve root. Unknown
 * resolution is fail-closed for an actual copy (Codex/Copilot review).
 */
function isCopyDestinationOutsideTarget(
  destination: string,
  targetPath: string,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    'runGit' | 'realpathOrNull' | 'readlinkOrNull'
  >,
): boolean {
  const targetReal = deps.realpathOrNull(targetPath);
  const destinationReal = resolveEffectiveRealpath(
    destination,
    deps.realpathOrNull,
    deps.readlinkOrNull,
  );
  const targetGitDirResult = deps.runGit(
    ['rev-parse', '--absolute-git-dir'],
    targetPath,
  );
  const targetGitDir =
    targetGitDirResult.ok && targetGitDirResult.stdout.trim().length > 0
      ? resolve(targetGitDirResult.stdout.trim())
      : null;
  const targetGitDirReal = targetGitDir
    ? resolveEffectiveRealpath(
        targetGitDir,
        deps.realpathOrNull,
        deps.readlinkOrNull,
      )
    : null;
  return (
    targetReal !== null &&
    destinationReal !== null &&
    !isPathContainedIn(destinationReal, targetReal) &&
    targetGitDirReal !== null &&
    !isPathContainedIn(destinationReal, targetGitDirReal)
  );
}

/** The prunable shortcut cannot ask Git for the vanished worktree's private
 * gitdir, so apply the same containment guard against the admin directory we
 * located by its `gitdir` pointer (and the vanished worktree's lexical path).
 */
function isCopyDestinationOutsideKnownPaths(
  destination: string,
  paths: readonly string[],
  deps: Pick<LocalWorktreeRecoveryDeps, 'realpathOrNull' | 'readlinkOrNull'>,
): boolean {
  if (paths.some((path) => isPathContainedIn(destination, path))) {
    return false;
  }
  const destinationReal = resolveEffectiveRealpath(
    destination,
    deps.realpathOrNull,
    deps.readlinkOrNull,
  );
  if (destinationReal === null) return false;
  return paths.every((path) => {
    const pathReal = resolveEffectiveRealpath(
      path,
      deps.realpathOrNull,
      deps.readlinkOrNull,
    );
    return pathReal !== null && !isPathContainedIn(destinationReal, pathReal);
  });
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
  path: string,
  realpathOrNull: (p: string) => string | null,
  readlinkOrNull: (p: string) => string | null = () => null,
): string | null {
  return resolveEffectiveRealpathInternal(
    path,
    realpathOrNull,
    readlinkOrNull,
    new Set(),
  );
}

function resolveEffectiveRealpathInternal(
  path: string,
  realpathOrNull: (p: string) => string | null,
  readlinkOrNull: (p: string) => string | null,
  seen: Set<string>,
): string | null {
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

/** Count of stash entries whose final message field is exactly `tag`. */
export function countTaggedStashEntries(
  stashList: string,
  tag: string,
): number {
  if (stashList.trim().length === 0) {
    return 0;
  }
  return stashList.split('\n').filter((line) => line.endsWith(`: ${tag}`))
    .length;
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
function stripSubmoduleDescribeSuffix(path: string): string {
  if (!path.endsWith(')')) return path;
  let depth = 0;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const character = path[index];
    if (character === ')') {
      depth += 1;
    } else if (character === '(') {
      depth -= 1;
      if (depth === 0) {
        return index > 0 && path[index - 1] === ' '
          ? path.slice(0, index - 1)
          : path;
      }
      if (depth < 0) return path;
    }
  }
  return path;
}

export function submoduleStatusEntries(
  raw: string,
): { status: string; path: string }[] {
  const entries: { status: string; path: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const match = SUBMODULE_STATUS_LINE_PATTERN.exec(line);
    if (!match) continue;
    const status = match[1];
    let path = match[3];
    if (status !== '-') {
      path = stripSubmoduleDescribeSuffix(path);
    }
    entries.push({ status, path });
  }
  return entries;
}

function submoduleStatusOutputIsValid(raw: string): boolean {
  return raw.split(/\r?\n/).every((line) => {
    if (line.length === 0) return true;
    const match = SUBMODULE_STATUS_LINE_PATTERN.exec(line);
    if (match === null) return false;
    let path = match[3];
    if (match[1] !== '-') {
      path = stripSubmoduleDescribeSuffix(path);
    }
    // The parsed path is joined to the target worktree by every caller.
    // Reject hostile or malformed status output before any preservation or
    // cleanup mutation can consume it (Copilot review).
    return isSafeRelativePath(path);
  });
}

/** Convert recursive repository-relative submodule paths into paths relative
 * to one initialized submodule, so its parent scope can exclude nested
 * submodules from its own stash probe. */
function nestedSubmodulePathsForScope(
  submodulePaths: readonly string[],
  scope: string,
): string[] {
  const prefix = `${scope}/`;
  return submodulePaths
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => candidate.slice(prefix.length));
}

/** Treat recovery paths as literal Git pathspecs, never as globs. */
function literalGitPathspec(path: string): string {
  return `:(literal)${path}`;
}

function excludedLiteralGitPathspec(path: string): string {
  return `:(exclude,literal)${path}`;
}

/** Preserve one scope (the worktree itself, or a submodule path relative to
 * it) -- stash tracked/untracked changes under `tag`, or fall back to
 * copying conflicted files out on an unmerged-path stash failure. Returns
 * the plan entry; `--apply` semantics (actually stashing) are gated by the
 * caller passing `apply: false` for a dry-run report only. */
function planAndMaybeStashScope(
  scopePath: string,
  scopeLabel: string,
  tag: string,
  apply: boolean,
  targetPath: string,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    | 'runGit'
    | 'copyPath'
    | 'ensurePreserveDir'
    | 'pathExists'
    | 'realpathOrNull'
    | 'readlinkOrNull'
  >,
  excludedDirtyPaths: readonly string[] = [],
  targetGitDirForScope: string | null = null,
): StashPlanEntry {
  const status = deps.runGit(
    [
      'status',
      '--porcelain',
      '--ignored',
      '--untracked-files=normal',
      '--ignore-submodules=none',
    ],
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
      : extractDirtyEntries(status.stdout).some(
          (entry) =>
            !excludedDirtyPaths.includes(entry.path) ||
            (entry.indexStatus !== ' ' &&
              entry.indexStatus !== '?' &&
              entry.indexStatus !== '!'),
        ));
  const baselineList = deps.runGit(['stash', 'list'], scopePath);
  const baselineCount = countTaggedStashEntries(baselineList.stdout, tag);
  const entry: StashPlanEntry = {
    scope: scopeLabel,
    tag,
    hasChanges,
    hasStashes: baselineList.ok && baselineList.stdout.trim().length > 0,
    statusReadFailed,
    stashListReadFailed: !baselineList.ok,
    baselineCount,
    stashed: false,
    verifiedCount: null,
    createdStashEntry: null,
    unmergedFallbackCopiedTo: null,
    unmergedFallbackCopiedFiles: [],
    unmergedFallbackAllPreserved: null,
    hardStashFailure: false,
  };
  if (statusReadFailed || entry.stashListReadFailed || !hasChanges || !apply) {
    return entry;
  }
  const stashArgv = ['stash', 'push', '--include-untracked', '-m', tag];
  if (excludedDirtyPaths.length > 0) {
    stashArgv.push(
      '--',
      '.',
      ...excludedDirtyPaths.map(excludedLiteralGitPathspec),
    );
  }
  const stash = deps.runGit(stashArgv, scopePath);
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
    if (!isUnmergedStashFailure(stash)) {
      entry.hardStashFailure = true;
      return entry;
    }
    // Unmerged-path fallback: `stash push` itself refused (unmerged paths
    // from a backed-up interrupted operation) -- copy out EVERY dirty path
    // in this scope, not only the `--diff-filter=U` conflicted subset
    // (Codex review finding: a coexisting untracked file or non-conflicting
    // modification would otherwise be silently lost), and verify each one
    // actually landed before trusting this scope as preserved.
    const dirtyEntries = extractDirtyEntries(status.stdout);
    if (
      dirtyEntries.some(
        (entry) =>
          entry.indexStatus !== ' ' &&
          entry.indexStatus !== '?' &&
          entry.indexStatus !== '!' &&
          !isUnmergedStatus(entry.indexStatus, entry.worktreeStatus),
      )
    ) {
      // A worktree copy cannot preserve the staged/index side of an ordinary
      // staged change such as `MM`. Fail closed for those entries instead of
      // removing the private index while claiming that the working-tree
      // version was sufficient. Genuine unmerged entries (`UU`, `AU`, `UA`,
      // and the other porcelain unmerged pairs) are different: the documented
      // fallback exists specifically to copy their working-tree conflict
      // files out when `stash push` refuses them (Copilot review).
      entry.unmergedFallbackAllPreserved = false;
      return entry;
    }
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
        try {
          deps.copyPath(
            from,
            to,
            targetPath,
            targetGitDirForScope ? [targetGitDirForScope] : undefined,
          );
        } catch {
          // Keep the attempted destination in the public plan even when a
          // recursive copy wrote only a prefix before failing. The caller
          // must retain that partial artifact and block removal rather than
          // losing the only record of where recovery may have mutated data.
          allLanded = false;
          continue;
        }
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
  entry.createdStashEntry = afterList.ok
    ? (afterList.stdout.split('\n').find((line) => line.endsWith(`: ${tag}`)) ??
      null)
    : null;
  return entry;
}

/** Preserve unpushed commits for one scope on `refs/idd-lwr/<branch>`. */
function planAndMaybeBackupRef(
  scopePath: string,
  scopeLabel: string,
  branch: string,
  inProgressOperation: InProgressOperation | null,
  apply: boolean,
  runGit: LocalWorktreeRecoveryDeps['runGit'],
): BackupRefPlanEntry {
  const ref = `refs/idd-lwr/${branch}`;
  let tipSha: string | null = null;
  let hasUnpushed = false;
  // A submodule's initialized admin directory is disposable with the linked
  // worktree, so every ref below `refs/` can be lost with it. Do not whitelist
  // namespaces here: private refs such as `refs/bisect/*` and recovery refs
  // are preservation-relevant even when their tips are already remote.
  const refNamespaces =
    scopeLabel === '.' ? ['refs/worktree', 'refs/bisect'] : ['refs'];
  const localRefs = runGit(
    [
      'for-each-ref',
      '--format=%(refname)',
      '--exclude=refs/remotes/**',
      ...refNamespaces,
    ],
    scopePath,
  );
  const localRefsQueryFailed = !localRefs.ok;
  // The recovery ref is written by this helper between the initial plan and
  // the late refresh. It is the artifact being verified, not an unrelated
  // local ref whose appearance proves the submodule changed underneath us.
  // Normalize the snapshot while excluding exactly this expected ref so the
  // late comparison remains meaningful after the helper-created write.
  const localRefsSnapshot = localRefs.ok
    ? localRefs.stdout
        .split(/\r?\n/)
        .filter(
          (line) =>
            line.length > 0 &&
            line !== ref &&
            !line.startsWith('refs/remotes/'),
        )
        .join('\n')
    : null;
  // A commit-reachability scan is insufficient for disposable submodule
  // repositories: a local tag or branch can point at an object already
  // reachable from a remote while its ref name remains private to the
  // worktree's disposable admin directory. Top-level linked worktrees use
  // only Git's worktree-specific and private bisect ref namespaces because
  // ordinary top-level branches and tags are shared by the clone and must
  // not trigger a full admin-directory copy.
  const hasLocalOnlyRefs =
    localRefsSnapshot !== null && localRefsSnapshot.length > 0;
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
  const entry: BackupRefPlanEntry = {
    scope: scopeLabel,
    ref,
    hasUnpushed,
    unpushedQueryFailed,
    tipSha,
    hasLocalOnlyRefs,
    localRefsQueryFailed,
    localRefsSnapshot,
    written: false,
    verifiedOid: null,
  };
  if (
    localRefsQueryFailed ||
    unpushedQueryFailed ||
    !hasUnpushed ||
    !tipSha ||
    !apply
  ) {
    return entry;
  }
  // Use compare-and-swap semantics so an earlier recovery ref is never
  // overwritten by a later recovery of the same branch. If another process
  // already preserved this exact tip, reusing it is safe; any other existing
  // tip fails closed and blocks removal.
  const write = runGit(
    ['update-ref', ref, tipSha, '0'.repeat(tipSha.length)],
    scopePath,
  );
  const alreadyPreserved = !write.ok
    ? runGit(['rev-parse', '--verify', ref], scopePath)
    : null;
  if (
    write.ok ||
    (alreadyPreserved?.ok && alreadyPreserved.stdout.trim() === tipSha)
  ) {
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
  scopePath: string,
  scopeLabel: string,
  apply: boolean,
  targetPath: string,
  plannedPreserveDir: string | null,
  sourceRoots: string[],
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    | 'runGit'
    | 'copyPath'
    | 'ensurePreserveDir'
    | 'pathExists'
    | 'realpathOrNull'
    | 'readlinkOrNull'
  >,
  destinationNamespace = '',
): { copied: IgnoredFileEntry[]; scanFailed: boolean } {
  const status = deps.runGit(
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--ignored',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ],
    scopePath,
  );
  if (!status.ok) {
    return { copied: [], scanFailed: true };
  }
  const copied: IgnoredFileEntry[] = [];
  let scanFailed = false;
  for (const ignoredPath of extractIgnoredPaths(status.stdout)) {
    if (!isSafeRelativePath(ignoredPath)) {
      scanFailed = true;
      copied.push({
        scope: scopeLabel,
        path: ignoredPath,
        copiedTo: null,
        copyFailed: false,
      });
      continue;
    }
    const preserveDir = apply ? deps.ensurePreserveDir() : plannedPreserveDir;
    const destination = preserveDir
      ? join(
          preserveDir,
          'ignored',
          ...(destinationNamespace ? [destinationNamespace] : []),
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
        copied.push({
          scope: scopeLabel,
          path: ignoredPath,
          copiedTo: null,
          copyFailed: false,
        });
        continue;
      }
      try {
        deps.copyPath(
          join(scopePath, ignoredPath),
          destination,
          targetPath,
          sourceRoots,
        );
      } catch {
        // Earlier entries may already have landed and the preserve directory
        // may already exist. Keep those entries in the returned plan, mark
        // this scan failed, and let the caller report the partial mutation
        // while still stopping before removal (Codex review).
        scanFailed = true;
        copied.push({
          scope: scopeLabel,
          path: ignoredPath,
          copiedTo: destination,
          copyFailed: true,
        });
        continue;
      }
    }
    copied.push({
      scope: scopeLabel,
      path: ignoredPath,
      copiedTo: destination,
      copyFailed: false,
    });
  }
  return { copied, scanFailed };
}

/** Remove ignored paths that were copied out before destructive cleanup.
 * Unlike linked-worktree removal, a checkout leaves ignored files in place,
 * while a linked-worktree removal can refuse an untracked file that became
 * visible after `stash push --include-untracked` restored the committed
 * ignore rules. The caller has already verified the backup, so remove only
 * the exact relative paths recorded by the preservation scan and fail closed
 * if any path remains. */
function cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
  entries: readonly IgnoredFileEntry[],
  targetPath: string,
  deps: Pick<LocalWorktreeRecoveryDeps, 'runGit' | 'pathExists'>,
): string | null {
  const pathsByScope = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (entry.copyFailed) {
      return `ignored path ${entry.scope}/${entry.path} was only partially preserved`;
    }
    if (entry.copiedTo === null) {
      return `ignored path ${entry.scope}/${entry.path} was not preserved`;
    }
    if (!isSafeRelativePath(entry.path)) {
      return `ignored path ${entry.scope}/${entry.path} is unsafe`;
    }
    const paths = pathsByScope.get(entry.scope) ?? new Set<string>();
    paths.add(entry.path);
    pathsByScope.set(entry.scope, paths);
  }
  for (const [scope, paths] of pathsByScope) {
    const scopePath = scope === '.' ? targetPath : join(targetPath, scope);
    const currentStatus = deps.runGit(
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      scopePath,
    );
    if (!currentStatus.ok) {
      return `could not revalidate preserved ignored paths in ${scope} before cleanup: ${currentStatus.stderr}`;
    }
    const currentIgnoredPaths = new Set(
      extractIgnoredPaths(currentStatus.stdout),
    );
    for (const path of paths) {
      // An already-removed path is safe: an earlier cleanup may have handled
      // it. A path that still exists but is no longer reported as ignored may
      // have been replaced with new untracked or tracked content, so do not
      // let the path-scoped clean delete that unpreserved content (Copilot
      // review #4120862945).
      if (
        deps.pathExists(join(scopePath, path)) &&
        !currentIgnoredPaths.has(path)
      ) {
        return `preserved ignored path ${scope}/${path} changed status before cleanup`;
      }
    }
    const cleaned = deps.runGit(
      ['clean', '-fdx', '--', ...Array.from(paths, literalGitPathspec)],
      scopePath,
    );
    if (!cleaned.ok) {
      return `git clean failed for preserved ignored paths in ${scope}: ${cleaned.stderr}`;
    }
    for (const path of paths) {
      if (deps.pathExists(join(scopePath, path))) {
        return `preserved ignored path ${scope}/${path} remained after cleanup`;
      }
    }
  }
  return null;
}

/** Remove deinitialized-submodule checkout directories that were copied out
 * before a primary-worktree checkout. `git submodule update --recursive` does
 * not initialize or remove those directories, so leaving them in place would
 * leak recovered issue data into the development branch. Restrict removal to
 * Git-reported safe relative submodule paths and fail closed if any copied
 * path remains or becomes unreadable. */
function cleanPreservedUninitializedSubmodulesBeforePrimaryCheckout(
  entries: readonly UninitializedSubmoduleEntry[],
  targetPath: string,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    'pathExists' | 'pathPresence' | 'removePath'
  >,
): string | null {
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.copiedTo === null) {
      return `uninitialized submodule ${entry.path} was not preserved`;
    }
    if (entry.copyFailed) {
      return `uninitialized submodule ${entry.path} was only partially preserved`;
    }
    if (!isSafeRelativePath(entry.path)) {
      return `uninitialized submodule ${entry.path} is unsafe`;
    }
    paths.add(entry.path);
  }
  if (paths.size === 0) return null;
  for (const path of paths) {
    const sourcePath = join(targetPath, path);
    try {
      deps.removePath(sourcePath);
    } catch (error) {
      return `could not remove preserved uninitialized submodule ${path}: ${errorMessageForProduction(error)}`;
    }
    const presence = pathPresenceForDeps(deps, sourcePath);
    if (presence === 'unknown') {
      return `could not verify cleanup of uninitialized submodule ${path}`;
    }
    if (presence === 'present') {
      return `preserved uninitialized submodule ${path} remained after cleanup`;
    }
  }
  return null;
}

function gitlinkPathsAtRevision(output: string): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split('\0')) {
    const separator = record.indexOf('\t');
    if (separator < 0 || !record.startsWith('160000 ')) continue;
    const path = record.slice(separator + 1);
    if (path.length > 0) paths.add(path);
  }
  return paths;
}

/** Remove initialized submodule checkouts that the development branch no
 * longer names. `git submodule update --recursive` only visits gitlinks in
 * the checked-out tree, so Git otherwise leaves a populated old submodule
 * directory behind and the post-checkout cleanliness gate reports it as an
 * untracked path. The checkout was already preserved and verified, so remove
 * only those recorded initialized paths whose target-branch tree is not a
 * gitlink, then verify their absence before checkout. */
function cleanPreservedInitializedSubmodulesBeforePrimaryCheckout(
  stashes: readonly StashPlanEntry[],
  developmentBranch: string,
  targetPath: string,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    'runGit' | 'pathExists' | 'pathPresence' | 'removePath'
  >,
): string | null {
  const tree = deps.runGit(
    ['ls-tree', '-r', '-z', '--full-tree', developmentBranch],
    targetPath,
  );
  if (!tree.ok) {
    return `could not inspect ${developmentBranch}'s gitlinks before checkout: ${tree.stderr}`;
  }
  const developmentGitlinks = gitlinkPathsAtRevision(tree.stdout);
  const initializedPaths = new Set(
    stashes.map((stash) => stash.scope).filter((scope) => scope !== '.'),
  );
  for (const submodulePath of initializedPaths) {
    if (developmentGitlinks.has(submodulePath)) continue;
    if (!isSafeRelativePath(submodulePath)) {
      return `initialized submodule ${submodulePath} is unsafe; stopping before checkout`;
    }
    const checkoutPath = join(targetPath, submodulePath);
    try {
      deps.removePath(checkoutPath);
    } catch (error) {
      return `could not remove initialized submodule ${submodulePath} deleted by ${developmentBranch}: ${errorMessageForProduction(error)}`;
    }
    const presence = pathPresenceForDeps(deps, checkoutPath);
    if (presence === 'unknown') {
      return `could not verify cleanup of initialized submodule ${submodulePath} deleted by ${developmentBranch}`;
    }
    if (presence === 'present') {
      return `initialized submodule ${submodulePath} deleted by ${developmentBranch} remained before checkout`;
    }
  }
  return null;
}

function planAndMaybePreserve(
  path: string,
  branch: string,
  tag: string,
  apply: boolean,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    | 'runGit'
    | 'pathExists'
    | 'copyPath'
    | 'ensurePreserveDir'
    | 'realpathOrNull'
    | 'readlinkOrNull'
    | 'pathPresence'
  >,
  plannedPreserveDir: string | null = null,
  targetGitDirForScope: string | null = null,
): {
  preserveDir: string | null;
  inProgressOperation: InProgressOperation | null;
  submoduleInProgressOperations: SubmoduleInProgressOperation[];
  stashes: StashPlanEntry[];
  uninitializedSubmodules: UninitializedSubmoduleEntry[];
  backupRefs: BackupRefPlanEntry[];
  ignoredFilesCopied: IgnoredFileEntry[];
  ignoredFilesScanFailed: boolean;
  submoduleAdminCopies: SubmoduleAdminCopyEntry[];
  submoduleAdminCopyFailed: boolean;
  worktreeAdminCopy: WorktreeAdminCopyEntry | null;
  worktreeAdminCopyFailed: boolean;
  /** True when `git submodule status --recursive` itself failed --
   * distinct from "no submodules": a failure here must never silently
   * degrade to an empty submodule list, or a dirty/uninitialized
   * submodule's own changes go completely unbacked-up with no failure
   * signal at all (same fail-closed class as Codex #1/Copilot #5's
   * top-level status-probe finding). */
  submoduleListFailed: boolean;
} {
  let preserveDir: string | null = null;
  const preserveDeps = {
    ...deps,
    ensurePreserveDir: (): string => {
      preserveDir = deps.ensurePreserveDir();
      return preserveDir;
    },
  };
  const readFile = (p: string): string | null => {
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
    deps.pathPresence,
  );

  const submoduleStatus = deps.runGit(
    ['submodule', 'status', '--recursive'],
    path,
  );
  const sourceRootsForScope = (scopePath: string): string[] => {
    const gitDir =
      scopePath === path
        ? targetGitDirForScope
        : (() => {
            const result = deps.runGit(
              ['rev-parse', '--absolute-git-dir'],
              scopePath,
            );
            return result.ok && result.stdout.trim().length > 0
              ? result.stdout.trim()
              : null;
          })();
    return [
      path,
      scopePath,
      ...(targetGitDirForScope ? [targetGitDirForScope] : []),
      ...(gitDir ? [gitDir] : []),
    ].filter((root, index, roots) => roots.indexOf(root) === index);
  };
  const submoduleListFailed =
    !submoduleStatus.ok ||
    !submoduleStatusOutputIsValid(submoduleStatus.stdout);
  const submodules =
    submoduleStatus.ok && !submoduleListFailed
      ? submoduleStatusEntries(submoduleStatus.stdout)
      : [];
  const initializedSubmodulePaths = submodules
    .filter((submodule) => submodule.status !== '-')
    .map((submodule) => submodule.path);
  // A clean initialized submodule's own stash scope handles the ` M path`
  // that the parent status probe reports for its dirty files. A `+` entry
  // means the submodule HEAD differs from the superproject's recorded
  // gitlink, so retain it as a parent-level change: the submodule scope alone
  // cannot preserve the superproject index state. Retain `U`/`-` entries for
  // the same reason (Copilot review #4114207705), while excluding their
  // contents from the parent stash below so an uninitialized checkout is
  // preserved by its own copy plan first (Copilot review #4116363405). The
  // per-submodule loop below still preserves every initialized submodule,
  // including `+`, in its own scope so ordinary files inside a changed
  // submodule are not lost.
  const submodulePaths = submodules
    .filter((submodule) => submodule.status === ' ' || submodule.status === '-')
    .map((submodule) => submodule.path)
    .filter((submodulePath) => submodulePath.length > 0);

  // Capture ignored files before any stash changes the ignore rules. In
  // particular, an untracked or modified `.gitignore` can make files that
  // were initially ignored appear untracked after `stash push --include-
  // untracked`; scanning only afterward would lose those files before a
  // forced worktree removal (Codex review #4114227141).
  let ignoredFilesCopied: IgnoredFileEntry[] = [];
  let ignoredFilesScanFailed = false;
  const topLevelIgnored = scanAndMaybeCopyIgnoredFiles(
    path,
    '.',
    apply,
    path,
    plannedPreserveDir,
    sourceRootsForScope(path),
    preserveDeps,
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
      plannedPreserveDir,
      sourceRootsForScope(join(path, submodule.path)),
      preserveDeps,
    );
    ignoredFilesCopied = ignoredFilesCopied.concat(submoduleIgnored.copied);
    ignoredFilesScanFailed =
      ignoredFilesScanFailed || submoduleIgnored.scanFailed;
  }

  const stashes: StashPlanEntry[] = [
    planAndMaybeStashScope(
      path,
      '.',
      tag,
      apply,
      path,
      preserveDeps,
      submodulePaths,
      targetGitDirForScope,
    ),
  ];
  const uninitializedSubmodules: UninitializedSubmoduleEntry[] = [];
  const submoduleOperations = new Map<string, InProgressOperation | null>();
  for (const submodule of submodules) {
    if (!submodule.path) continue;
    if (submodule.status === '-') {
      // Uninitialized: not a git repository at all -- copy files out
      // directly rather than attempting any `git -C` command there.
      const submodulePath = join(path, submodule.path);
      const submodulePresence = pathPresenceForDeps(deps, submodulePath);
      if (submodulePresence === 'unknown') {
        uninitializedSubmodules.push({
          path: submodule.path,
          copiedTo: null,
          copyFailed: false,
        });
      } else if (submodulePresence === 'present') {
        // Dry-run must have zero side effects: report the planned destination
        // when an explicit preserve directory makes it deterministic, but
        // create the directory and copy into it only when applying.
        const preserveDirForSubmodule = apply
          ? preserveDeps.ensurePreserveDir()
          : plannedPreserveDir;
        let destination = preserveDirForSubmodule
          ? join(
              preserveDirForSubmodule,
              `uninitialized-${Buffer.from(submodule.path).toString('base64url')}`,
            )
          : null;
        let copyFailed = false;
        if (apply && destination) {
          if (isCopyDestinationOutsideTarget(destination, path, deps)) {
            try {
              deps.copyPath(
                submodulePath,
                destination,
                path,
                targetGitDirForScope ? [targetGitDirForScope] : undefined,
              );
            } catch {
              copyFailed = true;
            }
          } else {
            // Keep the planned path visible in dry-run only; an unsafe apply
            // destination must never be reported as preserved.
            destination = null;
          }
        }
        uninitializedSubmodules.push({
          path: submodule.path,
          copiedTo: destination,
          copyFailed,
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
      deps.pathPresence,
    );
    submoduleOperations.set(submodule.path, submoduleOperation);
    stashes.push(
      planAndMaybeStashScope(
        submodulePath,
        submodule.path,
        tag,
        apply,
        path,
        preserveDeps,
        nestedSubmodulePathsForScope(submodulePaths, submodule.path),
        targetGitDirForScope,
      ),
    );
  }

  const backupRefs: BackupRefPlanEntry[] = [
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

  const submoduleAdminCopies: SubmoduleAdminCopyEntry[] = [];
  let submoduleAdminCopyFailed = false;
  let worktreeAdminCopy: WorktreeAdminCopyEntry | null = null;
  let worktreeAdminCopyFailed = false;
  const topLevelRefs = backupRefs.find((entry) => entry.scope === '.');
  if (
    targetGitDirForScope !== null &&
    (topLevelRefs?.hasLocalOnlyRefs || inProgressOperation !== null)
  ) {
    const plannedDestination = plannedPreserveDir
      ? join(plannedPreserveDir, 'worktree-gitdir')
      : null;
    worktreeAdminCopy = {
      copiedTo: null,
      plannedTo: plannedDestination,
    };
    if (apply) {
      const preserveDirForAdmin = preserveDeps.ensurePreserveDir();
      const destination = join(preserveDirForAdmin, 'worktree-gitdir');
      worktreeAdminCopy.plannedTo = destination;
      if (
        !deps.pathExists(targetGitDirForScope) ||
        !isCopyDestinationOutsideKnownPaths(
          destination,
          [path, targetGitDirForScope],
          deps,
        )
      ) {
        worktreeAdminCopyFailed = true;
      } else {
        try {
          deps.copyPath(
            targetGitDirForScope,
            destination,
            targetGitDirForScope,
            [path],
          );
          worktreeAdminCopy.copiedTo = destination;
        } catch {
          // Retain the attempted destination so a partial recursive copy is
          // visible to the verdict and counts as a mutation, while the
          // separate failure flag keeps preservation verification fail-closed.
          worktreeAdminCopy.copiedTo = destination;
          worktreeAdminCopyFailed = true;
        }
      }
    }
  }
  for (const submodule of submodules) {
    if (!submodule.path) continue;
    const deinitialized = submodule.status === '-';
    const stash = stashes.find((entry) => entry.scope === submodule.path);
    const ref = backupRefs.find((entry) => entry.scope === submodule.path);
    const operation = submoduleOperations.get(submodule.path);
    const submodulePath = join(path, submodule.path);
    const gitDir = deinitialized
      ? resolveDeinitializedSubmoduleGitDir(
          targetGitDirForScope,
          submodule.path,
          initializedSubmodulePaths,
          deps.pathExists,
        )
      : (() => {
          const result = preserveDeps.runGit(
            ['rev-parse', '--absolute-git-dir'],
            submodulePath,
          );
          return result.ok && result.stdout.trim().length > 0
            ? result.stdout.trim()
            : null;
        })();
    const adminPresence =
      gitDir === null ? 'absent' : pathPresenceForDeps(deps, gitDir);
    const hasAdminData = adminPresence === 'present';
    const shouldCopy = deinitialized
      ? gitDir !== null && adminPresence !== 'absent'
      : apply
        ? submodule.status === '+' ||
          Boolean(
            stash?.stashed ||
              stash?.hasStashes ||
              ref?.written ||
              ref?.hasLocalOnlyRefs ||
              operation !== null,
          )
        : submodule.status === '+' ||
          Boolean(
            stash?.hasChanges ||
              stash?.hasStashes ||
              ref?.hasUnpushed ||
              ref?.hasLocalOnlyRefs ||
              operation !== null,
          );
    if (!shouldCopy) continue;
    const plannedDestination = plannedPreserveDir
      ? join(
          plannedPreserveDir,
          'submodule-gitdir',
          Buffer.from(submodule.path).toString('base64url'),
        )
      : null;
    if (gitDir === null || !hasAdminData) {
      submoduleAdminCopyFailed = true;
      submoduleAdminCopies.push({
        path: submodule.path,
        copiedTo: null,
        plannedTo: plannedDestination,
        copyFailed: true,
      });
      continue;
    }
    if (!apply) {
      submoduleAdminCopies.push({
        path: submodule.path,
        copiedTo: null,
        plannedTo: plannedDestination,
        copyFailed: false,
      });
      continue;
    }
    const preserveDirForAdmin = preserveDeps.ensurePreserveDir();
    const destination = join(
      preserveDirForAdmin,
      'submodule-gitdir',
      Buffer.from(submodule.path).toString('base64url'),
    );
    if (!isCopyDestinationOutsideTarget(destination, path, deps)) {
      submoduleAdminCopyFailed = true;
      submoduleAdminCopies.push({
        path: submodule.path,
        copiedTo: null,
        plannedTo: destination,
        copyFailed: true,
      });
      continue;
    }
    try {
      deps.copyPath(gitDir, destination, gitDir, [
        path,
        ...(targetGitDirForScope ? [targetGitDirForScope] : []),
      ]);
    } catch {
      submoduleAdminCopyFailed = true;
      submoduleAdminCopies.push({
        path: submodule.path,
        copiedTo: destination,
        plannedTo: destination,
        copyFailed: true,
      });
      continue;
    }
    submoduleAdminCopies.push({
      path: submodule.path,
      copiedTo: destination,
      plannedTo: destination,
      copyFailed: false,
    });
  }

  const submoduleInProgressOperations = Array.from(submoduleOperations).flatMap(
    ([submodulePath, operation]) =>
      operation === null ? [] : [{ path: submodulePath, operation }],
  );

  return {
    preserveDir,
    inProgressOperation,
    submoduleInProgressOperations,
    stashes,
    uninitializedSubmodules,
    backupRefs,
    ignoredFilesCopied,
    ignoredFilesScanFailed,
    submoduleAdminCopies,
    submoduleAdminCopyFailed,
    worktreeAdminCopy,
    worktreeAdminCopyFailed,
    submoduleListFailed,
  };
}

/** Check read-only preservation probes before dry-run reports removal ready. */
function preservationPlanReady(preserve: {
  stashes: StashPlanEntry[];
  backupRefs: BackupRefPlanEntry[];
  ignoredFilesScanFailed: boolean;
  submoduleListFailed: boolean;
  submoduleAdminCopyFailed: boolean;
  worktreeAdminCopyFailed: boolean;
}): boolean {
  if (
    preserve.ignoredFilesScanFailed ||
    preserve.submoduleListFailed ||
    preserve.submoduleAdminCopyFailed ||
    preserve.worktreeAdminCopyFailed
  ) {
    return false;
  }
  for (const stash of preserve.stashes) {
    if (stash.statusReadFailed || stash.stashListReadFailed) return false;
  }
  for (const ref of preserve.backupRefs) {
    if (ref.localRefsQueryFailed || ref.unpushedQueryFailed) return false;
  }
  return true;
}

function preservationVerified(
  preserve: {
    stashes: StashPlanEntry[];
    backupRefs: BackupRefPlanEntry[];
    uninitializedSubmodules: UninitializedSubmoduleEntry[];
    ignoredFilesCopied: IgnoredFileEntry[];
    ignoredFilesScanFailed: boolean;
    submoduleListFailed: boolean;
    submoduleAdminCopies: SubmoduleAdminCopyEntry[];
    submoduleAdminCopyFailed: boolean;
    worktreeAdminCopy: WorktreeAdminCopyEntry | null;
    worktreeAdminCopyFailed: boolean;
  },
  pathExists: (path: string) => boolean,
): boolean {
  if (!preservationPlanReady(preserve)) return false;
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
      stash.verifiedCount !== stash.baselineCount + 1 ||
      stash.createdStashEntry === null
    ) {
      return false;
    }
  }
  for (const ref of preserve.backupRefs) {
    if (ref.localRefsQueryFailed) return false;
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
    if (submodule.copyFailed) return false;
    if (!pathExists(submodule.copiedTo)) return false;
  }
  // Copilot review: `ignoredFilesCopied` was never included in verification
  // at all -- a failed or partial ignored-file copy could not block
  // removal despite §LWR requiring these copies verified before step 4.
  for (const ignored of preserve.ignoredFilesCopied) {
    if (ignored.copyFailed || ignored.copiedTo === null) return false;
    if (!pathExists(ignored.copiedTo)) return false;
  }
  if (preserve.submoduleAdminCopyFailed) return false;
  for (const admin of preserve.submoduleAdminCopies) {
    if (
      admin.copyFailed ||
      admin.copiedTo === null ||
      !pathExists(admin.copiedTo)
    ) {
      return false;
    }
  }
  if (preserve.worktreeAdminCopyFailed) return false;
  if (
    preserve.worktreeAdminCopy !== null &&
    (preserve.worktreeAdminCopy.copiedTo === null ||
      !pathExists(preserve.worktreeAdminCopy.copiedTo))
  ) {
    return false;
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
  preserve: {
    stashes: StashPlanEntry[];
    backupRefs: BackupRefPlanEntry[];
    uninitializedSubmodules: UninitializedSubmoduleEntry[];
    ignoredFilesCopied: IgnoredFileEntry[];
    submoduleAdminCopies: SubmoduleAdminCopyEntry[];
    worktreeAdminCopy?: WorktreeAdminCopyEntry | null;
  },
  targetPath: string,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    'runGit' | 'pathExists' | 'realpathOrNull' | 'readlinkOrNull'
  >,
  scopesMissingFromCurrentTree: ReadonlySet<string> = new Set(),
): boolean {
  const scopePath = (scope: string): string =>
    scope === '.' ? targetPath : join(targetPath, scope);
  const copyVerified = (destination: string): boolean =>
    deps.pathExists(destination) &&
    isCopyDestinationOutsideTarget(destination, targetPath, deps);
  const normalizeStashEntry = (line: string): string =>
    line.replace(/^stash@\{\d+\}: /, '');
  const stashGroups = new Map<
    string,
    { entries: StashPlanEntry[]; list: string }
  >();
  for (const stash of preserve.stashes) {
    // Primary recovery may deliberately remove an initialized submodule
    // before checking out a development branch that no longer contains its
    // gitlink. Its stash lives in the submodule's private gitdir, but the
    // removed checkout is no longer a usable cwd for `git stash list`.
    // The same artifact was freshly verified immediately before that
    // deliberate removal; keep verifying its copied admin data below while
    // skipping only the now-unreachable checkout probe.
    if (scopesMissingFromCurrentTree.has(stash.scope)) continue;
    if (stash.stashListReadFailed) return false;
    if (!stash.stashed) continue;
    const key = `${stash.scope}\0${stash.tag}`;
    let group = stashGroups.get(key);
    if (!group) {
      const list = deps.runGit(['stash', 'list'], scopePath(stash.scope));
      if (!list.ok) return false;
      group = { entries: [], list: list.stdout };
      stashGroups.set(key, group);
    }
    group.entries.push(stash);
  }
  for (const group of stashGroups.values()) {
    // Entries in one group may come from sequential preserve passes. Each
    // entry's baseline already includes the earlier entries, so the final
    // count is the maximum per-entry `baseline + 1`, not the maximum baseline
    // plus the number of entries (Copilot review).
    const expectedCount = Math.max(
      ...group.entries.map((entry) => entry.baselineCount + 1),
    );
    const taggedCount = countTaggedStashEntries(
      group.list,
      group.entries[0]?.tag ?? '',
    );
    if (taggedCount !== expectedCount) return false;
    for (const entry of group.entries) {
      if (
        entry.createdStashEntry === null ||
        !group.list
          .split(/\r?\n/)
          .some(
            (line) =>
              normalizeStashEntry(line) ===
              normalizeStashEntry(entry.createdStashEntry ?? ''),
          )
      ) {
        return false;
      }
    }
  }
  for (const stash of preserve.stashes) {
    // Copilot review: the fresh re-verification previously only covered
    // stash entries and backup refs -- an ignored-file, uninitialized-
    // submodule, or unmerged-fallback copy could be silently deleted
    // during the lock wait and removal would still proceed. Re-confirm
    // every copy destination this scope recorded still exists.
    if (
      stash.unmergedFallbackCopiedTo !== null &&
      !copyVerified(stash.unmergedFallbackCopiedTo)
    ) {
      return false;
    }
    if (
      stash.unmergedFallbackCopiedFiles.some(
        (destination) => !copyVerified(destination),
      )
    ) {
      return false;
    }
  }
  for (const ref of preserve.backupRefs) {
    // See the stash-scope exception above. A removed initialized submodule
    // cannot be used as `cwd` for `git rev-parse`, while its backup copy was
    // verified before checkout and is still checked below.
    if (scopesMissingFromCurrentTree.has(ref.scope)) continue;
    if (!ref.written) continue;
    const verify = deps.runGit(
      ['rev-parse', '--verify', ref.ref],
      scopePath(ref.scope),
    );
    if (!verify.ok || verify.stdout.trim() !== ref.tipSha) {
      return false;
    }
  }
  for (const submodule of preserve.uninitializedSubmodules) {
    if (submodule.copyFailed) return false;
    if (submodule.copiedTo !== null && !copyVerified(submodule.copiedTo)) {
      return false;
    }
  }
  for (const ignored of preserve.ignoredFilesCopied) {
    if (
      ignored.copyFailed ||
      (ignored.copiedTo !== null && !copyVerified(ignored.copiedTo))
    ) {
      return false;
    }
  }
  for (const admin of preserve.submoduleAdminCopies) {
    if (admin.copyFailed) return false;
    if (admin.copiedTo !== null && !copyVerified(admin.copiedTo)) {
      return false;
    }
  }
  if (
    preserve.worktreeAdminCopy !== null &&
    preserve.worktreeAdminCopy !== undefined
  ) {
    if (
      preserve.worktreeAdminCopy.copiedTo !== null &&
      !copyVerified(preserve.worktreeAdminCopy.copiedTo)
    ) {
      return false;
    }
  }
  return true;
}

/** Refresh uninitialized-submodule copies immediately before linked-worktree
 * removal. An uninitialized submodule has no stash scope, and its plain
 * checkout directory can appear or gain files after the initial step-3
 * snapshot. Re-scan the status list, copy newly present paths, and re-copy
 * known paths into the same destination; containment and existence checks
 * fail closed if the source or destination becomes unsafe. */
interface UninitializedSubmoduleRefresh {
  error: string | null;
  added: UninitializedSubmoduleEntry[];
  preserveDir: string | null;
}

function refreshUninitializedSubmoduleCopies(
  entries: readonly UninitializedSubmoduleEntry[],
  targetPath: string,
  targetGitDir: string | null,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    | 'copyPath'
    | 'ensurePreserveDir'
    | 'pathExists'
    | 'pathPresence'
    | 'runGit'
    | 'realpathOrNull'
    | 'readlinkOrNull'
  >,
): UninitializedSubmoduleRefresh {
  const added: UninitializedSubmoduleEntry[] = [];
  let preserveDir: string | null = null;
  // A prunable shortcut has no live target or private gitdir to rescan. Keep
  // this fast path side-effect-free as well as avoiding an extra target
  // existence probe in the already-absent branch.
  if (targetGitDir === null && entries.length === 0) {
    return { error: null, added, preserveDir };
  }
  const targetPresence = pathPresenceForDeps(deps, targetPath);
  if (targetPresence === 'unknown') {
    return {
      error:
        'could not establish the target worktree path before rescanning uninitialized submodules; stopping before removal',
      added,
      preserveDir,
    };
  }
  if (targetPresence === 'absent') {
    return { error: null, added, preserveDir };
  }

  const status = deps.runGit(
    ['submodule', 'status', '--recursive'],
    targetPath,
  );
  if (!status.ok || !submoduleStatusOutputIsValid(status.stdout)) {
    return {
      error:
        'could not rescan uninitialized submodules immediately before removal; stopping before removal',
      added,
      preserveDir,
    };
  }
  const knownEntries = new Map(entries.map((entry) => [entry.path, entry]));
  const currentSubmodules = submoduleStatusEntries(status.stdout);
  const currentByPath = new Map(
    currentSubmodules.map((submodule) => [submodule.path, submodule]),
  );
  for (const entry of entries) {
    const current = currentByPath.get(entry.path);
    if (current !== undefined && current.status !== '-') {
      return {
        error: `uninitialized submodule ${entry.path} became initialized before removal; stopping before removal`,
        added,
        preserveDir,
      };
    }
  }
  const lateSubmodules = currentSubmodules.filter(
    (submodule) => submodule.status === '-',
  );
  const ensurePreserveDir = (): string => {
    preserveDir ??= deps.ensurePreserveDir();
    return preserveDir;
  };
  for (const submodule of lateSubmodules) {
    let entry = knownEntries.get(submodule.path);
    const submodulePath = join(targetPath, submodule.path);
    const submodulePresence = pathPresenceForDeps(deps, submodulePath);
    if (submodulePresence === 'unknown') {
      return {
        error: `could not establish the uninitialized submodule ${submodule.path} path before removal; stopping before removal`,
        added,
        preserveDir,
      };
    }
    if (entry === undefined && submodulePresence === 'present') {
      const destination = join(
        ensurePreserveDir(),
        `uninitialized-${Buffer.from(submodule.path).toString('base64url')}`,
      );
      entry = {
        path: submodule.path,
        copiedTo: destination,
        copyFailed: false,
      };
      knownEntries.set(submodule.path, entry);
      added.push(entry);
    }
    if (entry === undefined) continue;
    if (entry.copyFailed) {
      return {
        error: `late preservation for uninitialized submodule ${entry.path} was already partially copied; stopping before removal`,
        added,
        preserveDir,
      };
    }
    if (entry.copiedTo === null) {
      return {
        error: `late preservation for uninitialized submodule ${entry.path} has no verified destination; stopping before removal`,
        added,
        preserveDir,
      };
    }
    if (submodulePresence === 'absent') continue;
    if (!isCopyDestinationOutsideTarget(entry.copiedTo, targetPath, deps)) {
      return {
        error: `late preservation for uninitialized submodule ${entry.path} has an unsafe destination; stopping before removal`,
        added,
        preserveDir,
      };
    }
    try {
      deps.copyPath(
        submodulePath,
        entry.copiedTo,
        targetPath,
        targetGitDir ? [targetGitDir] : undefined,
      );
    } catch {
      entry.copyFailed = true;
      return {
        error: `late preservation for uninitialized submodule ${entry.path} could not be copied; stopping before removal`,
        added,
        preserveDir,
      };
    }
    if (
      !deps.pathExists(entry.copiedTo) ||
      !isCopyDestinationOutsideTarget(entry.copiedTo, targetPath, deps)
    ) {
      entry.copyFailed = true;
      return {
        error: `late preservation for uninitialized submodule ${entry.path} could not be verified; stopping before removal`,
        added,
        preserveDir,
      };
    }
  }
  return { error: null, added, preserveDir };
}

/** Refresh initialized-submodule stashes immediately before primary cleanup.
 * The primary path may remove an initialized checkout when the development
 * branch no longer contains its gitlink. Re-scan every initialized
 * submodule, including one that appeared after the initial plan, and stash
 * any tracked or untracked changes that arrived after the first pass. */
interface InitializedSubmoduleRefresh {
  error: string | null;
  refreshed: StashPlanEntry[];
}

function refreshInitializedSubmoduleStashes(
  stashes: readonly StashPlanEntry[],
  backupRefs: readonly BackupRefPlanEntry[],
  submoduleInProgressOperations: readonly SubmoduleInProgressOperation[],
  backupBranch: string,
  targetPath: string,
  tag: string,
  targetGitDirForScope: string | null,
  deps: Pick<
    LocalWorktreeRecoveryDeps,
    | 'copyPath'
    | 'ensurePreserveDir'
    | 'pathExists'
    | 'pathPresence'
    | 'realpathOrNull'
    | 'readlinkOrNull'
    | 'runGit'
  >,
): InitializedSubmoduleRefresh {
  const knownScopes = new Set(
    stashes.map((stash) => stash.scope).filter((scope) => scope !== '.'),
  );
  const status = deps.runGit(
    ['submodule', 'status', '--recursive'],
    targetPath,
  );
  if (!status.ok || !submoduleStatusOutputIsValid(status.stdout)) {
    return {
      error:
        'could not rescan initialized submodules immediately before primary cleanup; stopping before checkout',
      refreshed: [],
    };
  }
  const submodules = submoduleStatusEntries(status.stdout);
  const byPath = new Map(
    submodules.map((submodule) => [submodule.path, submodule]),
  );
  for (const scope of knownScopes) {
    const submodule = byPath.get(scope);
    if (submodule === undefined || submodule.status === '-') {
      return {
        error: `initialized submodule ${scope} disappeared or became uninitialized before primary cleanup; stopping before checkout`,
        refreshed: [],
      };
    }
  }
  const initialized = submodules.filter(
    (submodule) => submodule.status !== '-',
  );
  const allInitializedPaths = initialized.map((submodule) => submodule.path);
  const knownBackupRefs = new Map(
    backupRefs.map((backupRef) => [backupRef.scope, backupRef]),
  );
  const knownOperations = new Map(
    submoduleInProgressOperations.map((entry) => [entry.path, entry.operation]),
  );
  const readFile = (path: string): string | null => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  };
  const refreshed: StashPlanEntry[] = [];
  for (const submodule of initialized) {
    const initialBackupRef = knownBackupRefs.get(submodule.path);
    if (initialBackupRef === undefined) {
      return {
        error: `initialized submodule ${submodule.path} appeared after preservation; stopping before checkout`,
        refreshed,
      };
    }
    const submodulePath = join(targetPath, submodule.path);
    const operation = detectInProgressOperation(
      submodulePath,
      deps.runGit,
      deps.pathExists,
      readFile,
      (path) => pathPresenceForDeps(deps, path),
    );
    const initialOperation = knownOperations.get(submodule.path) ?? null;
    if (
      (initialOperation === null && operation !== null) ||
      (initialOperation !== null &&
        operation !== null &&
        (operation.kind !== initialOperation.kind ||
          operation.tipSha !== initialOperation.tipSha))
    ) {
      return {
        error: `initialized submodule ${submodule.path} changed its in-progress operation after preservation; stopping before checkout`,
        refreshed,
      };
    }
    const freshBackupRef = planAndMaybeBackupRef(
      submodulePath,
      submodule.path,
      backupBranch,
      operation,
      false,
      deps.runGit,
    );
    const initialLocalRefs = initialBackupRef.localRefsSnapshot;
    const freshLocalRefs = freshBackupRef.localRefsSnapshot;
    if (
      initialLocalRefs === undefined ||
      freshLocalRefs === undefined ||
      freshBackupRef.localRefsQueryFailed ||
      freshBackupRef.unpushedQueryFailed ||
      (!(initialOperation !== null && operation === null) &&
        (freshBackupRef.tipSha !== initialBackupRef.tipSha ||
          freshBackupRef.hasUnpushed !== initialBackupRef.hasUnpushed)) ||
      freshBackupRef.hasLocalOnlyRefs !== initialBackupRef.hasLocalOnlyRefs ||
      freshLocalRefs !== initialLocalRefs
    ) {
      return {
        error: `initialized submodule ${submodule.path} changed its preserved tip or admin state after preservation; stopping before checkout`,
        refreshed,
      };
    }
    const refreshedStash = planAndMaybeStashScope(
      submodulePath,
      submodule.path,
      tag,
      true,
      targetPath,
      deps,
      nestedSubmodulePathsForScope(allInitializedPaths, submodule.path),
      targetGitDirForScope,
    );
    refreshed.push(refreshedStash);
    if (
      refreshedStash.statusReadFailed ||
      refreshedStash.stashListReadFailed ||
      refreshedStash.hardStashFailure ||
      (refreshedStash.hasChanges &&
        !refreshedStash.stashed &&
        refreshedStash.unmergedFallbackAllPreserved !== true)
    ) {
      return {
        error: `late preservation for initialized submodule ${submodule.path} could not be fully verified; stopping before checkout`,
        refreshed,
      };
    }
  }
  return { error: null, refreshed };
}

/**
 * Run the full §LWR steps 1/3/4 sequence. Pure over injected `deps` so a
 * unit test can assert exact call order (acquire-lock before recheck,
 * recheck before removal, release always runs) without a real git
 * repository. Never mutates when `!args.apply`, and never mutates when
 * `!args.operatorConfirmedNoLiveSession` regardless of `--apply` or what
 * step 1 finds -- both gates are checked before ANY git write.
 */
export function runLocalWorktreeRecovery(
  args: LocalWorktreeRecoveryArgs,
  deps: LocalWorktreeRecoveryDeps,
): LocalWorktreeRecoveryVerdict {
  const mode: 'dry-run' | 'apply' = args.apply ? 'apply' : 'dry-run';
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

  const verdict: LocalWorktreeRecoveryVerdict = {
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
      submoduleInProgressOperations: [],
      stashes: [],
      uninitializedSubmodules: [],
      backupRefs: [],
      ignoredFilesCopied: [],
      ignoredFilesScanFailed: false,
      submoduleListFailed: false,
      submoduleAdminCopies: [],
      worktreeAdminCopy: null,
      prunableAdminCopy: null,
      removal: null,
    },
    preserveDir: null,
    mutated: false,
    result: '',
  };
  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const recordRemovalFailure = (
    detail: string,
  ): LocalWorktreeRecoveryVerdict => {
    verdict.ready = false;
    verdict.plan.removal = {
      kind: verdict.primaryOrLinked ?? 'linked',
      developmentBranch: null,
      wouldRun: true,
      ran: false,
      detail,
    };
    verdict.result = detail;
    return verdict;
  };
  const incorporatePreservation = (
    preserve: ReturnType<typeof planAndMaybePreserve>,
    append: boolean,
  ): void => {
    verdict.preserveDir = preserve.preserveDir ?? verdict.preserveDir;
    if (append) {
      verdict.plan.stashes.push(...preserve.stashes);
      verdict.plan.uninitializedSubmodules.push(
        ...preserve.uninitializedSubmodules,
      );
      verdict.plan.backupRefs.push(...preserve.backupRefs);
      verdict.plan.ignoredFilesCopied.push(...preserve.ignoredFilesCopied);
      verdict.plan.submoduleAdminCopies.push(...preserve.submoduleAdminCopies);
      if (preserve.worktreeAdminCopy != null) {
        verdict.plan.worktreeAdminCopy = preserve.worktreeAdminCopy;
      }
      verdict.plan.submoduleInProgressOperations.push(
        ...preserve.submoduleInProgressOperations,
      );
    } else {
      verdict.plan.inProgressOperation = preserve.inProgressOperation;
      verdict.plan.submoduleInProgressOperations =
        preserve.submoduleInProgressOperations;
      verdict.plan.stashes = preserve.stashes;
      verdict.plan.uninitializedSubmodules = preserve.uninitializedSubmodules;
      verdict.plan.backupRefs = preserve.backupRefs;
      verdict.plan.ignoredFilesCopied = preserve.ignoredFilesCopied;
      verdict.plan.submoduleAdminCopies = preserve.submoduleAdminCopies;
      verdict.plan.worktreeAdminCopy = preserve.worktreeAdminCopy;
    }
    verdict.plan.ignoredFilesScanFailed ||= preserve.ignoredFilesScanFailed;
    verdict.plan.submoduleListFailed ||= preserve.submoduleListFailed;
    verdict.mutated ||= preserve.stashes.some((stash) => stash.stashed);
    verdict.mutated ||= preserve.backupRefs.some((ref) => ref.written);
    verdict.mutated ||= preserve.uninitializedSubmodules.some(
      (submodule) => submodule.copiedTo !== null,
    );
    verdict.mutated ||= preserve.ignoredFilesCopied.some(
      (ignored) => ignored.copiedTo !== null,
    );
    verdict.mutated ||= preserve.stashes.some(
      (stash) => stash.unmergedFallbackCopiedTo !== null,
    );
    verdict.mutated ||= preserve.submoduleAdminCopies.some(
      (admin) => admin.copiedTo !== null,
    );
    verdict.mutated ||= preserve.worktreeAdminCopy?.copiedTo != null;
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

  const primaryPath = primary ? resolve(primary.path) : null;
  const invokingCwd = resolve(cwd);
  const invokingCwdReal = deps.realpathOrNull(invokingCwd);
  const primaryPathReal = primaryPath ? deps.realpathOrNull(primaryPath) : null;
  const invokingCwdInsidePrimary =
    primaryPath !== null &&
    (isPathContainedIn(invokingCwd, primaryPath) ||
      (invokingCwdReal !== null &&
        primaryPathReal !== null &&
        isPathContainedIn(invokingCwdReal, primaryPathReal)));
  if (!invokingCwdInsidePrimary) {
    verdict.step1.outcome = 'cwd-outside-primary';
    verdict.step1.reason =
      'must be invoked from the primary worktree (or a directory beneath it), never from another linked worktree';
    verdict.result = verdict.step1.reason;
    return verdict;
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
  // A linked worktree's private gitdir is outside `targetPath`, but
  // `git worktree remove` deletes it along with the worktree. Resolve it
  // separately so an explicit preserve directory (or the generated temp
  // directory base) cannot put the only backup inside that soon-to-be-deleted
  // admin directory (Codex review #4114245289).
  const targetGitDirResult =
    verdict.primaryOrLinked === 'linked'
      ? deps.runGit(['rev-parse', '--absolute-git-dir'], targetPath)
      : null;
  const targetGitDir =
    targetGitDirResult?.ok && targetGitDirResult.stdout.trim().length > 0
      ? resolve(targetGitDirResult.stdout.trim())
      : null;
  if (
    verdict.primaryOrLinked === 'linked' &&
    deps.pathExists(targetPath) &&
    targetGitDir === null
  ) {
    verdict.step1.outcome = 'target-gitdir-unresolved';
    verdict.step1.reason =
      'could not resolve the linked worktree private git directory while the target still exists; refusing recovery';
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const targetGitDirEffectiveReal = targetGitDir
    ? resolveEffectiveRealpath(
        targetGitDir,
        deps.realpathOrNull,
        deps.readlinkOrNull,
      )
    : null;
  const preserveRootResolved = args.preserveDir
    ? resolve(cwd, args.preserveDir)
    : resolve(tmpdir());
  const preserveRootEffectiveReal = resolveEffectiveRealpath(
    preserveRootResolved,
    deps.realpathOrNull,
    deps.readlinkOrNull,
  );
  const preserveRootInsideGitDir =
    targetGitDirEffectiveReal !== null && preserveRootEffectiveReal !== null
      ? isPathContainedIn(preserveRootEffectiveReal, targetGitDirEffectiveReal)
      : false;
  if (preserveRootInsideGitDir) {
    verdict.step1.outcome = 'preserve-dir-inside-target-gitdir';
    verdict.step1.reason = `backup destination (${preserveRootResolved}) must be outside the target worktree's private git directory (${targetGitDir}) -- worktree removal deletes that directory too`;
    verdict.result = verdict.step1.reason;
    return verdict;
  }

  if (args.preserveDir) {
    const preserveDirResolved = preserveRootResolved;
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
  let confirmed: ConfirmBlockOutcome;
  try {
    confirmed = deps.confirmBlock(cwd);
  } catch (error) {
    verdict.step1.outcome = 'confirm-failed';
    verdict.step1.reason = `confirm-the-block threw: ${errorMessage(error)}`;
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  if (!confirmed.ok || !confirmed.routing) {
    verdict.step1.outcome = 'confirm-failed';
    verdict.step1.reason = confirmed.error ?? 'confirm-the-block check failed';
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  const routing = confirmed.routing;
  const recovered = extractRecoveredClaim(routing);
  let recoveredClaimId = recovered.claimId;
  let recoveredBranch = recovered.branch;
  let recoveredFromReleasedClaim = isReleasedClaimRouting(routing);
  // A prunable record whose checkout is already absent is represented by the
  // routing helper as an explicit `absent` local-worktree probe, which keeps
  // the overall routing state stale rather than producing the ordinary
  // occupied state. Evaluate this narrow shortcut before the general
  // occupied-state gate so a verified prunable record remains reachable;
  // every other stale, absent, or unreadable result still fails closed below.
  const shortcut = evaluatePrunableShortcut(
    records,
    targetPath,
    recoveredBranch,
    deps.pathExists,
    deps.pathPresence,
  );
  const reportedPaths = routing.evidence?.local_worktree?.paths ?? [];
  const routingReportsTargetPath =
    routing.state === 'local_worktree_occupied' &&
    isAcceptedBlockReason(routing.reason) &&
    reportedPaths.some(
      (reportedPath) =>
        normalizeGitWorktreePathForComparison(reportedPath) ===
        targetComparisonPath,
    );
  let primaryRecoveryResume = false;
  let primaryRecoveryMarker: PrimaryRecoveryLockMarker | null = null;
  let primaryRecoveryManifest: PrimaryRecoveryPreservationManifest | null =
    null;
  if (
    verdict.primaryOrLinked === 'primary' &&
    !routingReportsTargetPath &&
    routing.state !== 'local_worktree_occupied'
  ) {
    const recoveryLock = deps.checkLock(targetPath);
    const marker = recoveryLock.holder?.primaryRecovery;
    const markerPreservationManifest = parsePrimaryRecoveryPreservationManifest(
      marker?.preservation,
    );
    const requestedPreserveDir = args.preserveDir
      ? resolve(cwd, args.preserveDir)
      : null;
    const preserveDirMatchesMarker =
      marker?.preserveDir !== undefined &&
      (args.preserveDir === '' ||
        requestedPreserveDir === null ||
        requestedPreserveDir === marker.preserveDir);
    const currentBranch = marker
      ? deps.runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], targetPath)
      : null;
    const routingClaimConflicts =
      (recovered.claimId !== null && recovered.claimId !== marker?.claimId) ||
      (recovered.branch !== null && recovered.branch !== marker?.branch);
    const markerIsLegacyReleased =
      marker !== undefined &&
      marker.claimId === '' &&
      marker.releasedClaim &&
      recovered.claimId === null;
    if (
      marker !== undefined &&
      marker.worktree === targetPath &&
      (marker.claimId.length > 0 || markerIsLegacyReleased) &&
      marker.branch.length > 0 &&
      marker.developmentBranch.length > 0 &&
      markerPreservationManifest !== null &&
      preserveDirMatchesMarker &&
      isTakeoverEligibleAbsentRouting(routing) &&
      !routingClaimConflicts &&
      !routing.reason.endsWith('-local-worktree-unreadable') &&
      currentBranch?.ok === true &&
      currentBranch.stdout.trim() === marker.developmentBranch &&
      lockMatchesRecoveredClaim(
        recoveryLock,
        marker.claimId,
        marker.releasedClaim,
      )
    ) {
      recoveredClaimId = marker.claimId.length > 0 ? marker.claimId : null;
      recoveredBranch = marker.branch;
      primaryRecoveryMarker = marker;
      primaryRecoveryManifest = markerPreservationManifest;
      recoveredFromReleasedClaim = isReleasedClaimRouting(routing);
      primaryRecoveryResume = true;
    }
  }
  const primaryRecoveryPreserveDir = primaryRecoveryResume
    ? primaryRecoveryMarker?.preserveDir
    : null;
  const primaryRecoveryDeps = primaryRecoveryPreserveDir
    ? {
        ...deps,
        ensurePreserveDir: (): string => primaryRecoveryPreserveDir,
      }
    : deps;
  const restorePrimaryRecoveryPlan = (): boolean => {
    if (primaryRecoveryMarker === null || primaryRecoveryManifest === null) {
      return false;
    }
    // A resumed invocation must use the exact preservation plan that was
    // recorded before the first checkout. Replanning here would lose the
    // original stash/ref/copy destinations and could make a missing artifact
    // look like a clean, empty plan.
    verdict.preserveDir = primaryRecoveryMarker.preserveDir ?? null;
    verdict.plan.inProgressOperation =
      primaryRecoveryManifest.inProgressOperation;
    verdict.plan.submoduleInProgressOperations =
      primaryRecoveryManifest.submoduleInProgressOperations;
    verdict.plan.stashes = primaryRecoveryManifest.stashes;
    verdict.plan.uninitializedSubmodules =
      primaryRecoveryManifest.uninitializedSubmodules;
    verdict.plan.backupRefs = primaryRecoveryManifest.backupRefs;
    verdict.plan.ignoredFilesCopied =
      primaryRecoveryManifest.ignoredFilesCopied;
    verdict.plan.ignoredFilesScanFailed =
      primaryRecoveryManifest.ignoredFilesScanFailed;
    verdict.plan.submoduleListFailed =
      primaryRecoveryManifest.submoduleListFailed;
    verdict.plan.submoduleAdminCopies =
      primaryRecoveryManifest.submoduleAdminCopies;
    verdict.plan.worktreeAdminCopy = primaryRecoveryManifest.worktreeAdminCopy;
    verdict.mutated =
      verdict.plan.stashes.some((stash) => stash.stashed) ||
      verdict.plan.backupRefs.some((ref) => ref.written) ||
      verdict.plan.uninitializedSubmodules.some(
        (entry) => entry.copiedTo !== null,
      ) ||
      verdict.plan.ignoredFilesCopied.some(
        (entry) => entry.copiedTo !== null,
      ) ||
      verdict.plan.submoduleAdminCopies.some(
        (entry) => entry.copiedTo !== null,
      ) ||
      verdict.plan.worktreeAdminCopy?.copiedTo !== null;
    return preservationVerified(
      {
        ...primaryRecoveryManifest,
        submoduleAdminCopyFailed: false,
        worktreeAdminCopyFailed: false,
      },
      deps.pathExists,
    );
  };
  const updatePrimaryRecoveryMarkerFromPlan = (
    developmentBranch: string,
  ): boolean => {
    if (deps.updatePrimaryRecoveryLockMarker === undefined) return true;
    const currentLock = deps.checkLock(targetPath);
    const marker: PrimaryRecoveryLockMarker = {
      phase: 'primary-checkout',
      worktree: targetPath,
      claimId: recoveredClaimId ?? '',
      branch: recoveredBranch ?? '',
      developmentBranch,
      releasedClaim:
        primaryRecoveryMarker?.releasedClaim ?? recoveredFromReleasedClaim,
      preserveDir: verdict.preserveDir,
      preservation: JSON.stringify(
        primaryRecoveryManifestFromPlan(verdict.plan),
      ),
    };
    return deps.updatePrimaryRecoveryLockMarker(
      targetPath,
      currentLock,
      marker,
    );
  };
  const routingReportsExplicitAbsence =
    isPrunableShortcutRouting(routing) &&
    routing.evidence?.local_worktree?.status === 'absent' &&
    reportedPaths.length === 0;
  if (
    !routingReportsTargetPath &&
    !(shortcut.eligible && routingReportsExplicitAbsence) &&
    !primaryRecoveryResume
  ) {
    if (
      routing.state === 'local_worktree_occupied' &&
      isAcceptedBlockReason(routing.reason)
    ) {
      verdict.step1.outcome = 'path-mismatch';
      verdict.step1.reason = `--worktree ${targetPath} is not among the occupied paths reported (${reportedPaths.join(', ') || 'none'})`;
      verdict.result = verdict.step1.reason;
      return verdict;
    }
    verdict.step1.outcome = 'not-blocked';
    verdict.step1.reason = `resume-claim-routing reports state=${routing.state} reason=${routing.reason}; nothing to recover`;
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  if (recoveredClaimId === null && !recoveredFromReleasedClaim) {
    verdict.step1.outcome = 'lock-mismatch';
    verdict.step1.reason =
      'the active legacy claim has no claim-id and is not explicitly released; refusing lockless recovery';
    verdict.result = verdict.step1.reason;
    return verdict;
  }
  if (primaryRecoveryResume) {
    verdict.step1.outcome = 'blocked-primary-resume';
    verdict.step1.reason =
      'resuming primary-worktree cleanup after a completed development-branch checkout';
  } else if (shortcut.eligible) {
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
    if (
      !lockMatchesRecoveredClaim(
        lock,
        recoveredClaimId,
        recoveredFromReleasedClaim,
      )
    ) {
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
    if (args.preserveDir && !primaryRecoveryResume && !shortcut.eligible) {
      const preserveDirResolved = resolve(cwd, args.preserveDir);
      const preserveDirPresence = pathPresenceForDeps(
        deps,
        preserveDirResolved,
      );
      if (preserveDirPresence !== 'absent') {
        verdict.ready = false;
        verdict.step1.outcome = 'preserve-dir-exists';
        verdict.step1.reason = `--preserve-dir (${preserveDirResolved}) must name a new directory; the destination already exists or cannot be inspected during dry-run`;
        verdict.result = verdict.step1.reason;
        return verdict;
      }
    }
    const tag = `idd-lwr ${recoveredClaimId ?? 'legacy'}`;
    if (primaryRecoveryResume) {
      if (!restorePrimaryRecoveryPlan()) {
        return recordRemovalFailure(
          'a primary-worktree preservation artifact from the interrupted recovery is missing or incomplete; stopping before resume',
        );
      }
    } else if (shortcut.eligible) {
      const adminLookup = deps.findWorktreeAdminDir
        ? deps.findWorktreeAdminDir(verdict.primaryWorktree ?? cwd, targetPath)
        : { path: null, error: null };
      if (adminLookup.error) {
        return recordRemovalFailure(
          `could not plan the prunable worktree private admin-directory backup: ${adminLookup.error}`,
        );
      }
      if (adminLookup.path !== null) {
        const plannedPreserveDir = args.preserveDir
          ? resolve(cwd, args.preserveDir)
          : null;
        const plannedDestination = plannedPreserveDir
          ? join(plannedPreserveDir, 'prunable-gitdir')
          : null;
        if (
          plannedDestination !== null &&
          !isCopyDestinationOutsideKnownPaths(
            plannedDestination,
            [targetPath, adminLookup.path],
            deps,
          )
        ) {
          verdict.preserveDir = plannedPreserveDir;
          verdict.plan.prunableAdminCopy = {
            source: adminLookup.path,
            copiedTo: null,
            copyFailed: false,
            plannedTo: plannedDestination,
          };
          return recordRemovalFailure(
            'the prunable worktree admin-data backup destination is inside the vanished worktree or its private admin directory; stopping before removal',
          );
        }
        verdict.preserveDir = plannedPreserveDir;
        verdict.plan.prunableAdminCopy = {
          source: adminLookup.path,
          copiedTo: null,
          copyFailed: false,
          plannedTo: plannedDestination,
        };
      }
    } else {
      const preserve = planAndMaybePreserve(
        targetPath,
        recoveredBranch ?? '',
        tag,
        false,
        deps,
        args.preserveDir ? resolve(cwd, args.preserveDir) : null,
        targetGitDir,
      );
      verdict.preserveDir = preserve.preserveDir ?? verdict.preserveDir;
      verdict.plan.inProgressOperation = preserve.inProgressOperation;
      verdict.plan.submoduleInProgressOperations =
        preserve.submoduleInProgressOperations;
      verdict.plan.stashes = preserve.stashes;
      verdict.plan.uninitializedSubmodules = preserve.uninitializedSubmodules;
      verdict.plan.backupRefs = preserve.backupRefs;
      verdict.plan.ignoredFilesCopied = preserve.ignoredFilesCopied;
      verdict.plan.ignoredFilesScanFailed = preserve.ignoredFilesScanFailed;
      verdict.plan.submoduleListFailed = preserve.submoduleListFailed;
      verdict.plan.submoduleAdminCopies = preserve.submoduleAdminCopies;
      verdict.plan.worktreeAdminCopy = preserve.worktreeAdminCopy;
      if (!preservationPlanReady(preserve)) {
        return recordRemovalFailure(
          'dry-run preservation probes were incomplete or failed; stopping before removal',
        );
      }
    }
    let dryRunDevelopmentBranch: string | null = null;
    if (verdict.primaryOrLinked === 'primary') {
      try {
        dryRunDevelopmentBranch = primaryRecoveryResume
          ? (primaryRecoveryMarker?.developmentBranch ?? null)
          : deps.resolveDevelopmentBranch();
      } catch (error) {
        return recordRemovalFailure(
          `could not plan primary-worktree release: ${errorMessage(error)}`,
        );
      }
    }
    verdict.plan.removal = {
      kind: verdict.primaryOrLinked ?? 'linked',
      developmentBranch: dryRunDevelopmentBranch,
      wouldRun: true,
      ran: false,
      detail:
        verdict.primaryOrLinked === 'primary'
          ? 'would checkout {development-branch} then hand-remove the lock file'
          : 'would run git worktree remove (retry --force only after a submodule-removal failure or a dirty removal failure with a freshly verified unmerged fallback)',
    };
    verdict.result = 'dry-run: no mutation performed';
    return verdict;
  }

  // --apply: gate on the operator's own attestation BEFORE any mutation,
  // regardless of what step 1 found.
  if (!args.operatorConfirmedNoLiveSession) {
    verdict.ready = false;
    verdict.result =
      'refusing: --operator-confirmed-no-live-session was not given (step 2 is never checked mechanically); no mutation';
    return verdict;
  }

  // Regular-file preservation uses an atomic no-follow source/temp open.
  // Node does not expose that primitive on every platform (notably
  // Windows), so reject apply before any stash, ref, or copy mutation rather
  // than discovering the limitation after partial preservation.
  if (
    constants.O_NOFOLLOW === undefined ||
    constants.O_NONBLOCK === undefined
  ) {
    return recordRemovalFailure(
      'refusing --apply: this platform does not support the no-follow and nonblocking file opens required for recovery copies; no mutation',
    );
  }

  if (primaryRecoveryResume) {
    if (!restorePrimaryRecoveryPlan()) {
      return recordRemovalFailure(
        'a primary-worktree preservation artifact from the interrupted recovery is missing or incomplete; stopping before resume',
      );
    }
  }

  // Capture the target checkout and its private git-admin directory before
  // step 3 waits for the clone-scoped lock. A concurrent recovery can remove
  // and recreate the same worktree path while this invocation is preserving
  // the original checkout; matching routing/claim state after the wait is
  // not enough to prove that the cached preservation plan belongs to the
  // checkout that will be removed. Device/inode identity closes that
  // replacement-worktree window, mirroring claim-lock's acquisition guard.
  let initialTargetIdentity: TargetWorktreeIdentity | null = null;
  if (
    args.apply &&
    verdict.primaryOrLinked === 'linked' &&
    !shortcut.eligible &&
    deps.pathExists(targetPath)
  ) {
    try {
      initialTargetIdentity = resolveTargetWorktreeIdentity(targetPath, deps);
    } catch (error) {
      return recordRemovalFailure(
        `could not establish the target worktree identity before preservation: ${errorMessage(error)}`,
      );
    }
    if (initialTargetIdentity === null) {
      return recordRemovalFailure(
        'could not resolve the target worktree private git-admin directory before preservation; stopping before removal',
      );
    }
  }

  const repoPath = verdict.primaryWorktree ?? cwd;
  let lockHandle: CloneLockHandle;
  try {
    lockHandle = deps.acquireCloneLock(repoPath, args.agentId);
  } catch (error) {
    return recordRemovalFailure(
      `could not acquire the clone-scoped lock: ${errorMessage(error)}`,
    );
  }
  try {
    let postWaitTargetIdentity: TargetWorktreeIdentity | null = null;
    if (initialTargetIdentity !== null) {
      try {
        postWaitTargetIdentity = resolveTargetWorktreeIdentity(
          targetPath,
          deps,
        );
      } catch {
        postWaitTargetIdentity = null;
      }
    }
    if (
      initialTargetIdentity !== null &&
      !sameTargetWorktreeIdentity(initialTargetIdentity, postWaitTargetIdentity)
    ) {
      return recordRemovalFailure(
        'the target worktree or private git-admin identity changed while waiting for the clone lock; stopping before removal',
      );
    }
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
      !recheck.routing.reason.endsWith('-local-worktree-unreadable') &&
      (recheck.routing.evidence?.local_worktree?.paths ?? []).some(
        (reportedPath) =>
          normalizeGitWorktreePathForComparison(reportedPath) ===
          targetComparisonPath,
      );
    const prunableStillExplicitlyAbsent =
      shortcut.eligible && isTakeoverEligibleAbsentRouting(recheck.routing);
    const freshRecovered = extractRecoveredClaim(recheck.routing);
    const freshRecoveredFromReleasedClaim = isReleasedClaimRouting(
      recheck.routing,
    );
    const primaryRecoveryStillEligible =
      primaryRecoveryResume &&
      isTakeoverEligibleAbsentRouting(recheck.routing) &&
      freshRecovered.claimId === recoveredClaimId &&
      freshRecovered.branch === recoveredBranch;
    let stillEligible: boolean;
    let staleReason: string;
    if (shortcut.eligible) {
      const freshRecords = deps.listWorktreeRecords(cwd);
      const freshShortcut =
        freshRecords === null
          ? null
          : evaluatePrunableShortcut(
              freshRecords,
              targetPath,
              recoveredBranch,
              deps.pathExists,
              deps.pathPresence,
            );
      // The occupancy helper deliberately reports a matching prunable record
      // whose path is absent as `unreadable`, because its general callers do
      // not own the destructive cleanup decision. This helper has an
      // independent record/branch/unlocked check, so it may accept that
      // narrow shape while retaining the stale/released routing and claim
      // identity gates below (Copilot review #4116363405).
      const prunableStillIndependentlyAbsent =
        freshShortcut?.eligible === true &&
        recheck.routing.state === 'local_worktree_occupied' &&
        isAcceptedBlockReason(recheck.routing.reason) &&
        recheck.routing.reason.endsWith('-local-worktree-unreadable') &&
        (recheck.routing.evidence?.local_worktree?.paths ?? []).some(
          (reportedPath) =>
            normalizeGitWorktreePathForComparison(reportedPath) ===
            targetComparisonPath,
        );
      stillEligible =
        freshShortcut?.eligible === true &&
        (ordinaryStillOccupied ||
          prunableStillExplicitlyAbsent ||
          prunableStillIndependentlyAbsent);
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
        (ordinaryStillOccupied &&
          !recheck.routing.reason.endsWith('-local-worktree-unreadable')) ||
        primaryRecoveryStillEligible;
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
    if (primaryRecoveryStillEligible) {
      recoveredFromReleasedClaim = freshRecoveredFromReleasedClaim;
    }
    if (
      freshRecovered.claimId !== recoveredClaimId ||
      freshRecovered.branch !== recoveredBranch ||
      freshRecoveredFromReleasedClaim !== recoveredFromReleasedClaim
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
    if (!shortcut.eligible && !primaryRecoveryResume) {
      const lockRecheck = deps.checkLock(targetPath);
      // Mirrors step 1's own lock-check pass condition exactly: malformed
      // always fails; an active/recovered claim must still have its matching
      // lock, while a legacy release may have no lock or a legacy null-holder
      // lock; a present lock otherwise passes only when its holder matches.
      const lockStillMatches = lockMatchesRecoveredClaim(
        lockRecheck,
        recoveredClaimId,
        freshRecoveredFromReleasedClaim,
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
    }

    // Resolve the development branch before any preservation mutation. A
    // malformed local config or failed default-branch lookup must leave the
    // operator with an intact verdict rather than throwing after stashes,
    // refs, or copied artifacts have already been created (Codex review).
    let applyDevelopmentBranch: string | null = null;
    if (verdict.primaryOrLinked === 'primary') {
      try {
        applyDevelopmentBranch = primaryRecoveryResume
          ? (primaryRecoveryMarker?.developmentBranch ?? null)
          : deps.resolveDevelopmentBranch();
      } catch (error) {
        return recordRemovalFailure(
          `could not resolve the primary development branch before preservation: ${errorMessage(error)}`,
        );
      }
      const developmentBranchRef = deps.runGit(
        [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${applyDevelopmentBranch}`,
        ],
        targetPath,
      );
      if (!developmentBranchRef.ok) {
        return recordRemovalFailure(
          `the configured development branch ${applyDevelopmentBranch} is not available locally; stopping before preservation`,
        );
      }
    }

    // Step 3 must run only after the clone-scoped exclusion is held and the
    // routing/claim/lock state has been rechecked under that exclusion. This
    // prevents a stale same-claim session from reacquiring its lock and
    // writing new work into the target while recovery is preserving it.
    const tag = `idd-lwr ${recoveredClaimId ?? 'legacy'}`;
    // Reserve an explicit destination before step 3 can create a stash,
    // backup ref, or copied artifact. `ensurePreserveDir()` is also the
    // production EEXIST guard for an existing --preserve-dir; deferring it
    // until the first filesystem copy could leave earlier Git mutations
    // unreported when that later copy needs the destination (Codex review).
    let applyPreserveDir: string | null = null;
    if (args.preserveDir && !primaryRecoveryResume && !shortcut.eligible) {
      try {
        applyPreserveDir = deps.ensurePreserveDir();
        verdict.preserveDir = applyPreserveDir;
      } catch (error) {
        return recordRemovalFailure(
          `could not reserve --preserve-dir before preservation: ${errorMessage(error)}`,
        );
      }
    }
    if (primaryRecoveryResume) {
      applyPreserveDir = verdict.preserveDir;
    }
    if (!shortcut.eligible && !primaryRecoveryResume) {
      const preserve = planAndMaybePreserve(
        targetPath,
        recoveredBranch ?? '',
        tag,
        true,
        deps,
        applyPreserveDir,
        targetGitDir,
      );
      verdict.preserveDir = preserve.preserveDir ?? verdict.preserveDir;
      verdict.plan.inProgressOperation = preserve.inProgressOperation;
      verdict.plan.submoduleInProgressOperations =
        preserve.submoduleInProgressOperations;
      verdict.plan.stashes = preserve.stashes;
      verdict.plan.uninitializedSubmodules = preserve.uninitializedSubmodules;
      verdict.plan.backupRefs = preserve.backupRefs;
      verdict.plan.ignoredFilesCopied = preserve.ignoredFilesCopied;
      verdict.plan.ignoredFilesScanFailed = preserve.ignoredFilesScanFailed;
      verdict.plan.submoduleListFailed = preserve.submoduleListFailed;
      verdict.plan.submoduleAdminCopies = preserve.submoduleAdminCopies;
      verdict.plan.worktreeAdminCopy = preserve.worktreeAdminCopy;
      verdict.mutated =
        preserve.stashes.some((s) => s.stashed) ||
        preserve.backupRefs.some((r) => r.written) ||
        preserve.uninitializedSubmodules.some((s) => s.copiedTo !== null) ||
        preserve.ignoredFilesCopied.some((entry) => entry.copiedTo !== null) ||
        preserve.stashes.some(
          (stash) => stash.unmergedFallbackCopiedTo !== null,
        ) ||
        preserve.submoduleAdminCopies.some((entry) => entry.copiedTo !== null);
      verdict.mutated ||= preserve.worktreeAdminCopy?.copiedTo != null;
      if (!preservationVerified(preserve, deps.pathExists)) {
        verdict.result =
          'step 3 preservation could not be fully verified; stopping before removal';
        return verdict;
      }
    }

    // Preservation was performed under the exclusion, but its artifacts must
    // still be reverified before the destructive step because the copy/stash
    // operations themselves can race with unrelated filesystem writers.
    if (
      !shortcut.eligible &&
      !primaryRecoveryResume &&
      !reverifyPreservationArtifactsFresh(
        {
          stashes: verdict.plan.stashes,
          backupRefs: verdict.plan.backupRefs,
          uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
          ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
          submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
          worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
        },
        targetPath,
        deps,
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

    if (verdict.primaryOrLinked === 'primary') {
      const developmentBranch = applyDevelopmentBranch;
      if (developmentBranch === null) {
        return recordRemovalFailure(
          'could not resolve the primary development branch before cleanup',
        );
      }
      if (verdict.plan.inProgressOperation !== null) {
        // `stash push` can clear a paused merge/cherry-pick while preserving
        // its working-tree state. Re-detect the operation after preservation:
        // a vanished operation is already cleaned up, while a changed
        // operation must block rather than aborting a different operation.
        const currentOperation = detectInProgressOperation(
          targetPath,
          deps.runGit,
          deps.pathExists,
          readFileOrNull,
          deps.pathPresence,
        );
        if (
          currentOperation !== null &&
          (currentOperation.kind !== verdict.plan.inProgressOperation.kind ||
            currentOperation.tipSha !== verdict.plan.inProgressOperation.tipSha)
        ) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail:
              'the in-progress operation changed during preservation; stopping before cleanup',
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        if (currentOperation !== null) {
          const operationError = clearInProgressOperation(
            targetPath,
            currentOperation,
            deps.runGit,
            deps.pathPresence,
          );
          if (operationError !== null) {
            verdict.plan.removal = {
              kind: 'primary',
              developmentBranch,
              wouldRun: true,
              ran: false,
              detail: `checked out ${developmentBranch}, but ${operationError}`,
            };
            verdict.result = verdict.plan.removal.detail;
            return verdict;
          }
        }
      }
      for (const { path: submodulePath, operation } of verdict.plan
        .submoduleInProgressOperations) {
        const submoduleRoot = join(targetPath, submodulePath);
        const currentOperation = detectInProgressOperation(
          submoduleRoot,
          deps.runGit,
          deps.pathExists,
          readFileOrNull,
          deps.pathPresence,
        );
        if (
          currentOperation !== null &&
          (currentOperation.kind !== operation.kind ||
            currentOperation.tipSha !== operation.tipSha)
        ) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail: `the in-progress operation in submodule ${submodulePath} changed during preservation; stopping before cleanup`,
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        if (currentOperation !== null) {
          const operationError = clearInProgressOperation(
            submoduleRoot,
            currentOperation,
            deps.runGit,
            deps.pathPresence,
          );
          if (operationError !== null) {
            verdict.plan.removal = {
              kind: 'primary',
              developmentBranch,
              wouldRun: true,
              ran: false,
              detail: `checked out ${developmentBranch}, but could not release submodule ${submodulePath}: ${operationError}`,
            };
            verdict.result = verdict.plan.removal.detail;
            return verdict;
          }
        }
      }
      // An editor can create an ignored file after the initial preservation
      // scan. Capture it before primary checkout, which otherwise leaves
      // ignored files in place and could carry stale recovery data into the
      // development branch (Copilot review).
      const lateIgnoredEntries: IgnoredFileEntry[] = [];
      let lateIgnoredScanFailed = false;
      const lateIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [targetPath, ...(targetGitDir ? [targetGitDir] : [])],
        primaryRecoveryDeps,
      );
      lateIgnoredEntries.push(...lateIgnored.copied);
      lateIgnoredScanFailed ||= lateIgnored.scanFailed;
      for (const stash of verdict.plan.stashes) {
        if (stash.scope === '.') continue;
        const submodulePath = join(targetPath, stash.scope);
        const submoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          submodulePath,
        );
        const submoduleGitDir =
          submoduleGitDirResult.ok && submoduleGitDirResult.stdout.trim()
            ? submoduleGitDirResult.stdout.trim()
            : null;
        const lateSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          submodulePath,
          stash.scope,
          true,
          targetPath,
          null,
          [
            targetPath,
            submodulePath,
            ...(targetGitDir ? [targetGitDir] : []),
            ...(submoduleGitDir ? [submoduleGitDir] : []),
          ],
          primaryRecoveryDeps,
        );
        lateIgnoredEntries.push(...lateSubmoduleIgnored.copied);
        lateIgnoredScanFailed ||= lateSubmoduleIgnored.scanFailed;
      }
      verdict.plan.ignoredFilesCopied.push(...lateIgnoredEntries);
      verdict.plan.ignoredFilesScanFailed ||= lateIgnoredScanFailed;
      verdict.mutated ||= lateIgnoredEntries.some(
        (ignored) => ignored.copiedTo !== null,
      );
      const ignoredCleanupError =
        lateIgnoredScanFailed ||
        lateIgnoredEntries.some(
          (ignored) =>
            ignored.copyFailed ||
            ignored.copiedTo === null ||
            !deps.pathExists(ignored.copiedTo),
        )
          ? 'preserved ignored files could not be fully verified before primary checkout'
          : null;
      if (ignoredCleanupError !== null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `before checkout ${developmentBranch}, ${ignoredCleanupError}; stopping`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const ignoredCleanupAfterLateScanError =
        cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
          verdict.plan.ignoredFilesCopied,
          targetPath,
          deps,
        );
      if (ignoredCleanupAfterLateScanError !== null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `before checkout ${developmentBranch}, ${ignoredCleanupAfterLateScanError}; stopping`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const lateUninitialized = refreshUninitializedSubmoduleCopies(
        verdict.plan.uninitializedSubmodules,
        targetPath,
        targetGitDir,
        primaryRecoveryDeps,
      );
      if (lateUninitialized.preserveDir !== null) {
        verdict.preserveDir ??= lateUninitialized.preserveDir;
      }
      if (lateUninitialized.added.length > 0) {
        verdict.plan.uninitializedSubmodules.push(...lateUninitialized.added);
        verdict.mutated ||= lateUninitialized.added.some(
          (entry) => entry.copiedTo !== null,
        );
      }
      if (lateUninitialized.error !== null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `before checkout ${developmentBranch}, ${lateUninitialized.error}; stopping`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const uninitializedCleanupError =
        cleanPreservedUninitializedSubmodulesBeforePrimaryCheckout(
          verdict.plan.uninitializedSubmodules,
          targetPath,
          deps,
        );
      if (uninitializedCleanupError !== null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `before checkout ${developmentBranch}, ${uninitializedCleanupError}; stopping`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      // A resumed recovery is already on the development branch. The
      // pre-checkout refresh compares the current submodule tree with the
      // saved issue-branch plan, so replaying it here would reject expected
      // gitlink deletions or tip changes before post-checkout validation can
      // complete the recovery (Codex review).
      if (!primaryRecoveryResume) {
        const initializedRefresh = refreshInitializedSubmoduleStashes(
          verdict.plan.stashes,
          verdict.plan.backupRefs,
          verdict.plan.submoduleInProgressOperations,
          recoveredBranch ?? '',
          targetPath,
          tag,
          targetGitDir,
          primaryRecoveryDeps,
        );
        verdict.plan.stashes.push(...initializedRefresh.refreshed);
        verdict.mutated ||= initializedRefresh.refreshed.some(
          (stash) => stash.stashed || stash.unmergedFallbackCopiedTo !== null,
        );
        if (initializedRefresh.error !== null) {
          return recordRemovalFailure(initializedRefresh.error);
        }
        // Remove initialized submodule checkouts that the development branch
        // deletes before the final claim/lock confirmation below. The final
        // confirmation must remain immediately before `checkout`; otherwise a
        // new claim can arrive while this cleanup mutates the primary tree and
        // the later checkout can switch that new claim's worktree.
        const initializedSubmoduleCleanupError =
          cleanPreservedInitializedSubmodulesBeforePrimaryCheckout(
            verdict.plan.stashes,
            developmentBranch,
            targetPath,
            deps,
          );
        if (initializedSubmoduleCleanupError !== null) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail: `before checkout ${developmentBranch}, ${initializedSubmoduleCleanupError}; stopping`,
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
      }
      // The preservation and in-progress-operation cleanup above can take
      // long enough for the remote claim or worktree-local lock to change.
      // Re-run the complete identity gate while the clone lock is still held
      // and immediately before checkout, so a failed later confirmation
      // cannot leave the primary worktree switched to the development branch.
      if (!primaryRecoveryResume) {
        const preCheckoutConfirm = deps.confirmBlock(cwd);
        const preCheckoutRouting = preCheckoutConfirm.routing;
        const preCheckoutRecovered = preCheckoutRouting
          ? extractRecoveredClaim(preCheckoutRouting)
          : null;
        const preCheckoutLegacyReleased =
          preCheckoutRouting !== null &&
          isReleasedClaimRouting(preCheckoutRouting);
        const preCheckoutStillOccupied =
          preCheckoutConfirm.ok &&
          preCheckoutRouting !== null &&
          preCheckoutRouting.state === 'local_worktree_occupied' &&
          isAcceptedBlockReason(preCheckoutRouting.reason) &&
          !preCheckoutRouting.reason.endsWith('-local-worktree-unreadable') &&
          (preCheckoutRouting.evidence?.local_worktree?.paths ?? []).some(
            (reportedPath) =>
              normalizeGitWorktreePathForComparison(reportedPath) ===
              targetComparisonPath,
          );
        const preCheckoutClaimMatches =
          preCheckoutRecovered !== null &&
          preCheckoutRecovered.claimId === recoveredClaimId &&
          preCheckoutRecovered.branch === recoveredBranch &&
          preCheckoutLegacyReleased === recoveredFromReleasedClaim;
        const preCheckoutLock =
          preCheckoutStillOccupied && preCheckoutRouting !== null
            ? deps.checkLock(targetPath)
            : null;
        const preCheckoutLockMatches =
          preCheckoutLock !== null &&
          lockMatchesRecoveredClaim(
            preCheckoutLock,
            recoveredClaimId,
            preCheckoutLegacyReleased,
          );
        if (
          !preCheckoutStillOccupied ||
          !preCheckoutClaimMatches ||
          !preCheckoutLockMatches
        ) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail:
              'the primary-worktree claim/branch/lock identity changed immediately before checkout; stopping before checkout',
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        const primaryRecoveryMarker: PrimaryRecoveryLockMarker = {
          phase: 'primary-checkout',
          worktree: targetPath,
          claimId: recoveredClaimId ?? '',
          branch: recoveredBranch ?? '',
          developmentBranch,
          releasedClaim: recoveredFromReleasedClaim,
          preserveDir: verdict.preserveDir,
          preservation: JSON.stringify(
            primaryRecoveryManifestFromPlan(verdict.plan),
          ),
        };
        const markerUpdated =
          deps.updatePrimaryRecoveryLockMarker === undefined ||
          (preCheckoutLock !== null &&
            deps.updatePrimaryRecoveryLockMarker(
              targetPath,
              preCheckoutLock,
              primaryRecoveryMarker,
            ));
        if (!markerUpdated) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail:
              'could not record the primary-worktree recovery marker before checkout; stopping before checkout',
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        const checkout = deps.runGit(
          ['checkout', developmentBranch],
          targetPath,
        );
        if (!checkout.ok) {
          const currentLock = deps.checkLock(targetPath);
          const markerCleared =
            deps.updatePrimaryRecoveryLockMarker === undefined ||
            deps.updatePrimaryRecoveryLockMarker(targetPath, currentLock, null);
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail: markerCleared
              ? `checkout ${developmentBranch} failed: ${checkout.stderr}`
              : `checkout ${developmentBranch} failed and the recovery marker could not be cleared: ${checkout.stderr}`,
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
      }
      const submoduleSync = deps.runGit(
        ['submodule', 'sync', '--recursive'],
        targetPath,
      );
      if (!submoduleSync.ok) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `submodule sync after checkout ${developmentBranch} failed: ${submoduleSync.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const submoduleUpdate = deps.runGit(
        ['submodule', 'update', '--recursive'],
        targetPath,
      );
      if (!submoduleUpdate.ok) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `submodule update after checkout ${developmentBranch} failed: ${submoduleUpdate.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const symbolicBranch = deps.runGit(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        targetPath,
      );
      const actualBranch = symbolicBranch.ok
        ? symbolicBranch.stdout.trim()
        : '';
      if (!symbolicBranch.ok || actualBranch !== developmentBranch) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: symbolicBranch.ok
            ? `checkout ${developmentBranch} landed on ${actualBranch || 'detached HEAD'}, not the configured development branch; stopping`
            : `checked out ${developmentBranch}, but could not verify the symbolic branch: ${symbolicBranch.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const postCheckoutStatus = deps.runGit(
        [
          'status',
          '--porcelain',
          '--ignored',
          '--untracked-files=normal',
          '--ignore-submodules=none',
        ],
        targetPath,
      );
      // Checkout hooks and `submodule update` can create ignored files after
      // the pre-checkout scan has already cleaned the recovered worktree.
      // Preserve and remove only those newly observed paths before the
      // post-checkout cleanliness gate; otherwise `hasWorkingTreeChanges`
      // deliberately ignores them and the primary worktree can report a
      // false release with stale generated data left behind (Copilot review).
      const postCheckoutIgnoredEntries: IgnoredFileEntry[] = [];
      let postCheckoutIgnoredScanFailed = false;
      let persistedPostCheckoutEntries = 0;
      const persistPostCheckoutPlan = (): boolean => {
        const newEntries = postCheckoutIgnoredEntries.slice(
          persistedPostCheckoutEntries,
        );
        verdict.plan.ignoredFilesCopied.push(...newEntries);
        verdict.plan.ignoredFilesScanFailed ||= postCheckoutIgnoredScanFailed;
        verdict.mutated ||= newEntries.some(
          (ignored) => ignored.copiedTo !== null,
        );
        persistedPostCheckoutEntries = postCheckoutIgnoredEntries.length;
        return updatePrimaryRecoveryMarkerFromPlan(developmentBranch);
      };
      const postCheckoutIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [targetPath, ...(targetGitDir ? [targetGitDir] : [])],
        primaryRecoveryDeps,
        'post-checkout',
      );
      postCheckoutIgnoredEntries.push(...postCheckoutIgnored.copied);
      postCheckoutIgnoredScanFailed ||= postCheckoutIgnored.scanFailed;
      if (!persistPostCheckoutPlan()) {
        return recordRemovalFailure(
          `could not update the primary-worktree recovery marker after preserving files created during checkout ${developmentBranch}; stopping before lock removal`,
        );
      }
      const postCheckoutSubmodules = deps.runGit(
        ['submodule', 'status', '--recursive'],
        targetPath,
      );
      if (
        !postCheckoutSubmodules.ok ||
        !submoduleStatusOutputIsValid(postCheckoutSubmodules.stdout)
      ) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `could not inspect submodules for ignored files after checkout ${developmentBranch}; stopping before lock removal`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      for (const submodule of submoduleStatusEntries(
        postCheckoutSubmodules.stdout,
      )) {
        if (submodule.status === '-') continue;
        const submodulePath = join(targetPath, submodule.path);
        const submoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          submodulePath,
        );
        const submoduleGitDir =
          submoduleGitDirResult.ok && submoduleGitDirResult.stdout.trim()
            ? submoduleGitDirResult.stdout.trim()
            : null;
        const postCheckoutSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          submodulePath,
          submodule.path,
          true,
          targetPath,
          null,
          [
            targetPath,
            submodulePath,
            ...(targetGitDir ? [targetGitDir] : []),
            ...(submoduleGitDir ? [submoduleGitDir] : []),
          ],
          primaryRecoveryDeps,
          'post-checkout',
        );
        postCheckoutIgnoredEntries.push(...postCheckoutSubmoduleIgnored.copied);
        postCheckoutIgnoredScanFailed ||=
          postCheckoutSubmoduleIgnored.scanFailed;
      }
      if (!persistPostCheckoutPlan()) {
        return recordRemovalFailure(
          `could not update the primary-worktree recovery marker after preserving submodule files created during checkout ${developmentBranch}; stopping before lock removal`,
        );
      }
      if (
        postCheckoutIgnoredScanFailed ||
        postCheckoutIgnoredEntries.some(
          (ignored) =>
            ignored.copyFailed ||
            ignored.copiedTo === null ||
            !deps.pathExists(ignored.copiedTo),
        )
      ) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `ignored files created during checkout ${developmentBranch} could not be fully preserved; stopping before lock removal`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      const postCheckoutIgnoredCleanupError =
        cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
          postCheckoutIgnoredEntries,
          targetPath,
          deps,
        );
      if (postCheckoutIgnoredCleanupError !== null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `before removing the primary lock after checkout ${developmentBranch}, ${postCheckoutIgnoredCleanupError}; stopping`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      if (
        !postCheckoutStatus.ok ||
        hasWorkingTreeChanges(postCheckoutStatus.stdout)
      ) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: postCheckoutStatus.ok
            ? `checkout ${developmentBranch} left the primary worktree dirty after submodule update; stopping`
            : `could not verify the primary worktree after submodule update: ${postCheckoutStatus.stderr}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      let confirmAbsent = deps.confirmBlock(cwd);
      let absentRouting = confirmAbsent.routing;
      let absentRecovered = absentRouting
        ? extractRecoveredClaim(absentRouting)
        : null;
      let nowAbsent =
        confirmAbsent.ok &&
        absentRouting !== null &&
        isTakeoverEligibleAbsentRouting(absentRouting) &&
        absentRecovered?.claimId === recoveredClaimId &&
        absentRecovered.branch === recoveredBranch &&
        isReleasedClaimRouting(absentRouting) === recoveredFromReleasedClaim;
      // The post-checkout routing query is a network-backed confirmation. A
      // transient fetch/API failure must not strand the primary worktree on
      // the development branch with the recovered lock still present. Retry
      // the confirmation a bounded number of times while the clone lock is
      // still held, then fail closed if the same recovered claim is not
      // reported absent.
      for (let attempt = 1; attempt < 3 && !nowAbsent; attempt += 1) {
        confirmAbsent = deps.confirmBlock(cwd);
        absentRouting = confirmAbsent.routing;
        absentRecovered = absentRouting
          ? extractRecoveredClaim(absentRouting)
          : null;
        nowAbsent =
          confirmAbsent.ok &&
          absentRouting !== null &&
          isTakeoverEligibleAbsentRouting(absentRouting) &&
          absentRecovered?.claimId === recoveredClaimId &&
          absentRecovered.branch === recoveredBranch &&
          isReleasedClaimRouting(absentRouting) === recoveredFromReleasedClaim;
      }
      if (!nowAbsent || absentRouting === null) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail:
            'checked out {development-branch}, but resume-claim-routing does not yet report the same recovered claim/branch absent; stopping before removing the lock file',
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
        if (recoveredClaimId !== null || !recoveredFromReleasedClaim) {
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
      if (
        !lockMatchesRecoveredClaim(
          finalLockCheck,
          recoveredClaimId,
          isReleasedClaimRouting(absentRouting),
        )
      ) {
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
      const scopesMissingFromCurrentTree = new Set<string>();
      if (verdict.plan.stashes.some((stash) => stash.scope !== '.')) {
        const currentTree = deps.runGit(
          ['ls-tree', '-r', '-z', '--full-tree', 'HEAD'],
          targetPath,
        );
        if (!currentTree.ok) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail: `could not inspect the checked-out development tree before final preservation verification: ${currentTree.stderr}`,
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
        const currentGitlinks = gitlinkPathsAtRevision(currentTree.stdout);
        for (const stash of verdict.plan.stashes) {
          if (stash.scope !== '.' && !currentGitlinks.has(stash.scope)) {
            scopesMissingFromCurrentTree.add(stash.scope);
          }
        }
      }
      // The checkout and final identity/lock checks above are themselves a
      // concurrency window. Re-read every preservation artifact once more
      // after those checks and immediately before deleting the primary lock;
      // an artifact disappearing in that interval must still stop cleanup
      // (Copilot review #4114224357).
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
          scopesMissingFromCurrentTree,
        )
      ) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail:
            'a preservation artifact disappeared after the final primary identity checks; stopping before lock deletion',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      // The preservation re-check above is another concurrency window:
      // claim-lock.mts can replace the worktree-local lock without taking
      // this clone lock. Re-read the lock after the final artifact check and
      // immediately before resolving and unlinking it, so this release can
      // never delete a replacement claim's lock.
      const immediatelyBeforeDeleteLock = deps.checkLock(targetPath);
      if (
        immediatelyBeforeDeleteLock.malformed ||
        !lockMatchesRecoveredClaim(
          immediatelyBeforeDeleteLock,
          recoveredClaimId,
          isReleasedClaimRouting(absentRouting),
        )
      ) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail:
            'the primary-worktree lock no longer matches the recovered claim-id immediately before deletion; stopping before lock removal',
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
      }
      let lockForDeletion = immediatelyBeforeDeleteLock;
      const finalPrimaryIgnoredEntries: IgnoredFileEntry[] = [];
      let finalPrimaryIgnoredScanFailed = false;
      let persistedFinalPrimaryEntries = 0;
      const persistFinalPrimaryPlan = (): boolean => {
        const newEntries = finalPrimaryIgnoredEntries.slice(
          persistedFinalPrimaryEntries,
        );
        verdict.plan.ignoredFilesCopied.push(...newEntries);
        verdict.plan.ignoredFilesScanFailed ||= finalPrimaryIgnoredScanFailed;
        verdict.mutated ||= newEntries.some(
          (ignored) => ignored.copiedTo !== null,
        );
        persistedFinalPrimaryEntries = finalPrimaryIgnoredEntries.length;
        return updatePrimaryRecoveryMarkerFromPlan(developmentBranch);
      };
      const finalPrimaryIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [targetPath, ...(targetGitDir ? [targetGitDir] : [])],
        primaryRecoveryDeps,
        'final-lock',
      );
      finalPrimaryIgnoredEntries.push(...finalPrimaryIgnored.copied);
      finalPrimaryIgnoredScanFailed ||= finalPrimaryIgnored.scanFailed;
      if (!persistFinalPrimaryPlan()) {
        return recordRemovalFailure(
          `could not update the primary-worktree recovery marker after preserving files created before lock removal after checkout ${developmentBranch}; stopping`,
        );
      }
      const finalPrimarySubmodules = deps.runGit(
        ['submodule', 'status', '--recursive'],
        targetPath,
      );
      if (
        !finalPrimarySubmodules.ok ||
        !submoduleStatusOutputIsValid(finalPrimarySubmodules.stdout)
      ) {
        return recordRemovalFailure(
          `could not inspect submodules for ignored files before removing the primary lock after checkout ${developmentBranch}; stopping before lock removal`,
        );
      }
      for (const submodule of submoduleStatusEntries(
        finalPrimarySubmodules.stdout,
      )) {
        if (submodule.status === '-') continue;
        const submodulePath = join(targetPath, submodule.path);
        const submoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          submodulePath,
        );
        const submoduleGitDir =
          submoduleGitDirResult.ok && submoduleGitDirResult.stdout.trim()
            ? submoduleGitDirResult.stdout.trim()
            : null;
        const finalSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          submodulePath,
          submodule.path,
          true,
          targetPath,
          null,
          [
            targetPath,
            submodulePath,
            ...(targetGitDir ? [targetGitDir] : []),
            ...(submoduleGitDir ? [submoduleGitDir] : []),
          ],
          primaryRecoveryDeps,
          'final-lock',
        );
        finalPrimaryIgnoredEntries.push(...finalSubmoduleIgnored.copied);
        finalPrimaryIgnoredScanFailed ||= finalSubmoduleIgnored.scanFailed;
      }
      if (!persistFinalPrimaryPlan()) {
        return recordRemovalFailure(
          `could not update the primary-worktree recovery marker after preserving submodule files created before lock removal after checkout ${developmentBranch}; stopping`,
        );
      }
      if (
        finalPrimaryIgnoredScanFailed ||
        finalPrimaryIgnoredEntries.some(
          (ignored) =>
            ignored.copyFailed ||
            ignored.copiedTo === null ||
            !deps.pathExists(ignored.copiedTo),
        )
      ) {
        return recordRemovalFailure(
          `ignored files created after the final primary confirmation could not be fully preserved; stopping before removing the lock after checkout ${developmentBranch}`,
        );
      }
      const finalPrimaryIgnoredCleanupError =
        cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
          finalPrimaryIgnoredEntries,
          targetPath,
          deps,
        );
      if (finalPrimaryIgnoredCleanupError !== null) {
        return recordRemovalFailure(
          `before removing the primary lock after checkout ${developmentBranch}, ${finalPrimaryIgnoredCleanupError}; stopping`,
        );
      }
      const finalPrimaryConfirmAfterIgnored = deps.confirmBlock(cwd);
      const finalPrimaryRoutingAfterIgnored =
        finalPrimaryConfirmAfterIgnored.routing;
      const finalPrimaryRecoveredAfterIgnored = finalPrimaryRoutingAfterIgnored
        ? extractRecoveredClaim(finalPrimaryRoutingAfterIgnored)
        : null;
      const finalPrimaryAbsentAfterIgnored =
        finalPrimaryConfirmAfterIgnored.ok &&
        finalPrimaryRoutingAfterIgnored !== null &&
        isTakeoverEligibleAbsentRouting(finalPrimaryRoutingAfterIgnored) &&
        finalPrimaryRecoveredAfterIgnored?.claimId === recoveredClaimId &&
        finalPrimaryRecoveredAfterIgnored.branch === recoveredBranch &&
        isReleasedClaimRouting(finalPrimaryRoutingAfterIgnored) ===
          recoveredFromReleasedClaim;
      if (!finalPrimaryAbsentAfterIgnored) {
        return recordRemovalFailure(
          `checked out ${developmentBranch}, but the final ignored-file scan changed the resume-claim-routing result; stopping before removing the lock file`,
        );
      }
      const finalPrimaryLockAfterIgnored = deps.checkLock(targetPath);
      if (
        finalPrimaryLockAfterIgnored.malformed ||
        !lockMatchesRecoveredClaim(
          finalPrimaryLockAfterIgnored,
          recoveredClaimId,
          isReleasedClaimRouting(finalPrimaryRoutingAfterIgnored),
        )
      ) {
        return recordRemovalFailure(
          `the primary-worktree lock changed after the final ignored-file scan; stopping before removing the lock after checkout ${developmentBranch}`,
        );
      }
      lockForDeletion = finalPrimaryLockAfterIgnored;
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
          scopesMissingFromCurrentTree,
        )
      ) {
        return recordRemovalFailure(
          `a preservation artifact disappeared after the final ignored-file scan; stopping before removing the lock after checkout ${developmentBranch}`,
        );
      }
      const finalPrimaryStatus = deps.runGit(
        [
          'status',
          '--porcelain',
          '--ignored',
          '--untracked-files=all',
          '--ignore-submodules=none',
        ],
        targetPath,
      );
      if (!finalPrimaryStatus.ok || finalPrimaryStatus.stdout.length > 0) {
        return recordRemovalFailure(
          finalPrimaryStatus.ok
            ? `the final primary-worktree status after checkout ${developmentBranch} was not clean; stopping before removing the lock`
            : `could not verify the final primary-worktree status after checkout ${developmentBranch}: ${finalPrimaryStatus.stderr}`,
        );
      }
      try {
        if (!deps.removeLockIfMatches(targetPath, lockForDeletion)) {
          verdict.plan.removal = {
            kind: 'primary',
            developmentBranch,
            wouldRun: true,
            ran: false,
            detail:
              'the primary-worktree lock changed before compare-and-delete; stopping before lock removal',
          };
          verdict.result = verdict.plan.removal.detail;
          return verdict;
        }
      } catch (error) {
        verdict.plan.removal = {
          kind: 'primary',
          developmentBranch,
          wouldRun: true,
          ran: false,
          detail: `checked out ${developmentBranch}, but compare-and-delete of the lock file failed: ${(error as Error).message}`,
        };
        verdict.result = verdict.plan.removal.detail;
        return verdict;
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

    // A late ignored-file scan is required immediately before linked
    // worktree removal. An editor can create an ignored file after the
    // initial step-3 scan; ordinary `git worktree remove` deletes that file
    // successfully, so waiting for the submodule-removal failure path would
    // be too late (Codex review #4114350924). Scan only this late-arriving
    // artifact class here: re-running the complete preservation plan would
    // duplicate already-created stashes, backup refs, and submodule-admin
    // copies without adding safety.
    if (!shortcut.eligible) {
      const lateTargetGitDirResult = deps.runGit(
        ['rev-parse', '--absolute-git-dir'],
        targetPath,
      );
      const lateTargetGitDir =
        lateTargetGitDirResult.ok && lateTargetGitDirResult.stdout.trim()
          ? lateTargetGitDirResult.stdout.trim()
          : null;
      const lateIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [targetPath, ...(lateTargetGitDir ? [lateTargetGitDir] : [])],
        deps,
      );
      verdict.plan.ignoredFilesCopied.push(...lateIgnored.copied);
      verdict.plan.ignoredFilesScanFailed ||= lateIgnored.scanFailed;
      verdict.mutated ||= lateIgnored.copied.some(
        (ignored) => ignored.copiedTo !== null,
      );
      for (const stash of verdict.plan.stashes) {
        if (stash.scope === '.') continue;
        const lateSubmodulePath = join(targetPath, stash.scope);
        const lateSubmoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          lateSubmodulePath,
        );
        const lateSubmoduleGitDir =
          lateSubmoduleGitDirResult.ok &&
          lateSubmoduleGitDirResult.stdout.trim()
            ? lateSubmoduleGitDirResult.stdout.trim()
            : null;
        const lateSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          lateSubmodulePath,
          stash.scope,
          true,
          targetPath,
          null,
          [
            targetPath,
            join(targetPath, stash.scope),
            ...(lateTargetGitDir ? [lateTargetGitDir] : []),
            ...(lateSubmoduleGitDir ? [lateSubmoduleGitDir] : []),
          ],
          deps,
        );
        verdict.plan.ignoredFilesCopied.push(...lateSubmoduleIgnored.copied);
        verdict.plan.ignoredFilesScanFailed ||= lateSubmoduleIgnored.scanFailed;
        verdict.mutated ||= lateSubmoduleIgnored.copied.some(
          (ignored) => ignored.copiedTo !== null,
        );
        if (
          lateSubmoduleIgnored.scanFailed ||
          lateSubmoduleIgnored.copied.some(
            (ignored) =>
              ignored.copyFailed ||
              ignored.copiedTo === null ||
              !deps.pathExists(ignored.copiedTo),
          )
        ) {
          return recordRemovalFailure(
            `late preservation for initialized submodule ${stash.scope} could not be fully verified; stopping before removal`,
          );
        }
      }
      if (
        lateIgnored.scanFailed ||
        lateIgnored.copied.some(
          (ignored) =>
            ignored.copyFailed ||
            ignored.copiedTo === null ||
            !deps.pathExists(ignored.copiedTo),
        )
      ) {
        return recordRemovalFailure(
          'late preservation before linked-worktree removal could not be fully verified; stopping before removal',
        );
      }
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
        )
      ) {
        return recordRemovalFailure(
          'a late preservation artifact disappeared before linked-worktree removal; stopping before removal',
        );
      }
      const ignoredCleanupBeforeLinkedRemovalError =
        cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
          verdict.plan.ignoredFilesCopied,
          targetPath,
          deps,
        );
      if (ignoredCleanupBeforeLinkedRemovalError !== null) {
        return recordRemovalFailure(
          `before linked-worktree removal, ${ignoredCleanupBeforeLinkedRemovalError}; stopping before removal`,
        );
      }
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
    const finalLinkedFromReleasedClaim =
      finalLinkedRouting !== null && isReleasedClaimRouting(finalLinkedRouting);
    const finalLinkedReportsTargetPath =
      finalLinkedRouting !== null &&
      finalLinkedRouting.state === 'local_worktree_occupied' &&
      isAcceptedBlockReason(finalLinkedRouting.reason) &&
      (shortcut.eligible ||
        !finalLinkedRouting.reason.endsWith('-local-worktree-unreadable')) &&
      (finalLinkedRouting.evidence?.local_worktree?.paths ?? []).some(
        (reportedPath) =>
          normalizeGitWorktreePathForComparison(reportedPath) ===
          targetComparisonPath,
      );
    const finalLinkedReportsPrunableAbsence =
      shortcut.eligible &&
      finalLinkedRouting !== null &&
      isPrunableShortcutRouting(finalLinkedRouting) &&
      finalLinkedRouting?.evidence?.local_worktree?.status === 'absent' &&
      (finalLinkedRouting.evidence?.local_worktree?.paths ?? []).length === 0;
    const finalLinkedStillMatches =
      finalLinkedConfirm.ok &&
      finalLinkedRouting !== null &&
      (finalLinkedReportsTargetPath || finalLinkedReportsPrunableAbsence) &&
      finalLinkedRecovered?.claimId === recoveredClaimId &&
      finalLinkedRecovered.branch === recoveredBranch &&
      finalLinkedFromReleasedClaim === recoveredFromReleasedClaim;
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
    let finalLinkedLock: CheckLockOutcome | null = null;
    if (!shortcut.eligible) {
      finalLinkedLock = deps.checkLock(targetPath);
      if (
        !lockMatchesRecoveredClaim(
          finalLinkedLock,
          recoveredClaimId,
          finalLinkedFromReleasedClaim,
        )
      ) {
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

    // The final linked routing/lock checks above are themselves a
    // concurrency window. Re-read every preservation artifact immediately
    // before the remove call, rather than relying on the earlier recheck
    // that preceded those identity checks (Copilot review #4114224357).
    if (
      !shortcut.eligible &&
      !reverifyPreservationArtifactsFresh(
        {
          stashes: verdict.plan.stashes,
          backupRefs: verdict.plan.backupRefs,
          uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
          ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
          submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
          worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
        },
        targetPath,
        deps,
      )
    ) {
      verdict.plan.removal = {
        kind: 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail:
          'a preservation artifact disappeared after the final linked identity checks; stopping before removal',
      };
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }

    const lateUninitialized = shortcut.eligible
      ? { error: null, added: [], preserveDir: null }
      : refreshUninitializedSubmoduleCopies(
          verdict.plan.uninitializedSubmodules,
          targetPath,
          targetGitDir,
          deps,
        );
    if (lateUninitialized.preserveDir !== null) {
      verdict.preserveDir ??= lateUninitialized.preserveDir;
    }
    if (lateUninitialized.added.length > 0) {
      verdict.plan.uninitializedSubmodules.push(...lateUninitialized.added);
      verdict.mutated ||= lateUninitialized.added.some(
        (entry) => entry.copiedTo !== null,
      );
    }
    if (lateUninitialized.error !== null) {
      return recordRemovalFailure(lateUninitialized.error);
    }

    // The late uninitialized-submodule refresh above copies filesystem data
    // after the earlier routing and lock checks. A concurrent session can
    // still change the remote claim while that copy runs, so repeat the
    // complete ownership check before allowing the destructive remove.
    if (verdict.plan.uninitializedSubmodules.length > 0) {
      const postRefreshConfirm = deps.confirmBlock(cwd);
      const postRefreshRouting = postRefreshConfirm.routing;
      const postRefreshRecovered = postRefreshRouting
        ? extractRecoveredClaim(postRefreshRouting)
        : null;
      const postRefreshFromReleasedClaim =
        postRefreshRouting !== null &&
        isReleasedClaimRouting(postRefreshRouting);
      const postRefreshReportsTargetPath =
        postRefreshRouting !== null &&
        postRefreshRouting.state === 'local_worktree_occupied' &&
        isAcceptedBlockReason(postRefreshRouting.reason) &&
        !postRefreshRouting.reason.endsWith('-local-worktree-unreadable') &&
        (postRefreshRouting.evidence?.local_worktree?.paths ?? []).some(
          (reportedPath) =>
            normalizeGitWorktreePathForComparison(reportedPath) ===
            targetComparisonPath,
        );
      const postRefreshReportsPrunableAbsence =
        shortcut.eligible &&
        postRefreshRouting !== null &&
        isPrunableShortcutRouting(postRefreshRouting) &&
        postRefreshRouting.evidence?.local_worktree?.status === 'absent' &&
        (postRefreshRouting.evidence.local_worktree.paths ?? []).length === 0;
      const postRefreshStillMatches =
        postRefreshConfirm.ok &&
        postRefreshRouting !== null &&
        (postRefreshReportsTargetPath || postRefreshReportsPrunableAbsence) &&
        postRefreshRecovered?.claimId === recoveredClaimId &&
        postRefreshRecovered.branch === recoveredBranch &&
        postRefreshFromReleasedClaim === recoveredFromReleasedClaim;
      if (!postRefreshStillMatches) {
        return recordRemovalFailure(
          'the routing/claim identity changed during late preservation; stopping before removal',
        );
      }
      if (!shortcut.eligible) {
        finalLinkedLock = deps.checkLock(targetPath);
        if (
          !lockMatchesRecoveredClaim(
            finalLinkedLock,
            recoveredClaimId,
            postRefreshFromReleasedClaim,
          )
        ) {
          return recordRemovalFailure(
            'the worktree-local claim lock changed during late preservation; stopping before removal',
          );
        }
      }
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
        )
      ) {
        return recordRemovalFailure(
          'a preservation artifact disappeared after late preservation; stopping before removal',
        );
      }
    }

    if (shortcut.eligible) {
      const adminLookup = deps.findWorktreeAdminDir
        ? deps.findWorktreeAdminDir(repoPath, targetPath)
        : { path: null, error: null };
      if (adminLookup.error) {
        return recordRemovalFailure(
          `could not locate the prunable worktree's private admin directory; stopping before removal: ${adminLookup.error}`,
        );
      }
      if (adminLookup.path !== null) {
        const requestedPreserveDir = args.preserveDir
          ? resolve(cwd, args.preserveDir)
          : null;
        const plannedDestination = requestedPreserveDir
          ? join(requestedPreserveDir, 'prunable-gitdir')
          : null;
        // A prunable target no longer has a resolvable target gitdir, so the
        // general upfront containment check cannot see that an explicit
        // destination is inside the private admin directory we just found.
        // Validate before ensurePreserveDir() creates anything there.
        if (
          plannedDestination !== null &&
          !isCopyDestinationOutsideKnownPaths(
            plannedDestination,
            [targetPath, adminLookup.path],
            deps,
          )
        ) {
          verdict.preserveDir = requestedPreserveDir;
          verdict.plan.prunableAdminCopy = {
            source: adminLookup.path,
            copiedTo: null,
            copyFailed: false,
            plannedTo: plannedDestination,
          };
          return recordRemovalFailure(
            'the prunable worktree admin-data backup destination is inside the vanished worktree or its private admin directory; stopping before removal',
          );
        }
        const preserveDir = deps.ensurePreserveDir();
        const destination = join(preserveDir, 'prunable-gitdir');
        const entry: PrunableAdminCopyEntry = {
          source: adminLookup.path,
          copiedTo: null,
          copyFailed: false,
          plannedTo: destination,
        };
        if (
          !isCopyDestinationOutsideKnownPaths(
            destination,
            [targetPath, adminLookup.path],
            deps,
          )
        ) {
          verdict.plan.prunableAdminCopy = entry;
          return recordRemovalFailure(
            'the prunable worktree admin-data backup destination is inside the vanished worktree or its private admin directory; stopping before removal',
          );
        }
        try {
          deps.copyPath(adminLookup.path, destination, adminLookup.path);
          entry.copiedTo = destination;
        } catch {
          // Retain the attempted destination so a partial recursive copy is
          // visible to the verdict and counts as a mutation, while the
          // explicit failure flag keeps the recovery fail-closed.
          entry.copiedTo = destination;
          entry.copyFailed = true;
          verdict.preserveDir = preserveDir;
          verdict.mutated = true;
          verdict.plan.prunableAdminCopy = entry;
          return recordRemovalFailure(
            'could not copy the prunable worktree private admin directory; stopping before removal',
          );
        }
        verdict.preserveDir = preserveDir;
        verdict.plan.prunableAdminCopy = entry;
        verdict.mutated = true;
        if (!deps.pathExists(destination)) {
          return recordRemovalFailure(
            'the copied prunable worktree private admin directory could not be verified; stopping before removal',
          );
        }
      }
      const finalShortcutRecords = deps.listWorktreeRecords(cwd);
      if (
        finalShortcutRecords === null ||
        !evaluatePrunableShortcut(
          finalShortcutRecords,
          targetPath,
          recoveredBranch,
          deps.pathExists,
          deps.pathPresence,
        ).eligible
      ) {
        return recordRemovalFailure(
          'the prunable-and-absent record changed before forced removal; stopping before removal',
        );
      }
      const shortcutRoutingStillMatches = (): boolean => {
        const finalRecords = deps.listWorktreeRecords(cwd);
        const finalShortcut =
          finalRecords === null
            ? null
            : evaluatePrunableShortcut(
                finalRecords,
                targetPath,
                recoveredBranch,
                deps.pathExists,
                deps.pathPresence,
              );
        const confirmation = deps.confirmBlock(cwd);
        const routing = confirmation.routing;
        const recovered = routing ? extractRecoveredClaim(routing) : null;
        const reportsTargetPath =
          routing !== null &&
          routing.state === 'local_worktree_occupied' &&
          isAcceptedBlockReason(routing.reason) &&
          (routing.evidence?.local_worktree?.paths ?? []).some(
            (reportedPath) =>
              normalizeGitWorktreePathForComparison(reportedPath) ===
              targetComparisonPath,
          );
        const reportsPrunableAbsence =
          routing !== null &&
          isPrunableShortcutRouting(routing) &&
          routing?.evidence?.local_worktree?.status === 'absent' &&
          (routing.evidence?.local_worktree?.paths ?? []).length === 0;
        return (
          finalShortcut?.eligible === true &&
          confirmation.ok &&
          routing !== null &&
          (reportsTargetPath || reportsPrunableAbsence) &&
          recovered?.claimId === recoveredClaimId &&
          recovered.branch === recoveredBranch &&
          isReleasedClaimRouting(routing) === recoveredFromReleasedClaim
        );
      };
      // The private admin-directory copy above is itself a mutation window:
      // claim state can change while it runs, even though the target record
      // remains prunable and absent. Re-run the same routing/claim identity
      // check before the backup verification, then repeat it after every
      // filesystem check so the shortcut cannot delete a worktree whose
      // stale claim changed hands during the final gap.
      if (!shortcutRoutingStillMatches()) {
        return recordRemovalFailure(
          'the final prunable-worktree routing/claim identity no longer matches; stopping before forced removal',
        );
      }
      const prunableAdminCopy = verdict.plan.prunableAdminCopy;
      if (
        prunableAdminCopy !== null &&
        (prunableAdminCopy.copyFailed ||
          (prunableAdminCopy.copiedTo !== null &&
            (!deps.pathExists(prunableAdminCopy.copiedTo) ||
              !isCopyDestinationOutsideKnownPaths(
                prunableAdminCopy.copiedTo,
                [targetPath, prunableAdminCopy.source],
                deps,
              ))))
      ) {
        return recordRemovalFailure(
          'the prunable worktree admin-data backup disappeared or moved before forced removal; stopping before removal',
        );
      }
      if (!shortcutRoutingStillMatches()) {
        return recordRemovalFailure(
          'the final prunable-worktree routing/claim identity no longer matches; stopping before forced removal',
        );
      }
    }

    // The guarded removal checks the local lock atomically, but a replacement
    // claim can still be posted after the last routing observation above and
    // before that guard runs. Re-read routing and the lock immediately before
    // the destructive call so the removal cannot act on a stale remote claim
    // (Copilot review #4116307851).
    if (!shortcut.eligible) {
      const immediatelyBeforeRemovalConfirm = deps.confirmBlock(cwd);
      const immediatelyBeforeRemovalRouting =
        immediatelyBeforeRemovalConfirm.routing;
      const immediatelyBeforeRemovalRecovered = immediatelyBeforeRemovalRouting
        ? extractRecoveredClaim(immediatelyBeforeRemovalRouting)
        : null;
      const immediatelyBeforeRemovalReleased =
        immediatelyBeforeRemovalRouting !== null &&
        isReleasedClaimRouting(immediatelyBeforeRemovalRouting);
      const immediatelyBeforeRemovalReportsTarget =
        immediatelyBeforeRemovalRouting !== null &&
        immediatelyBeforeRemovalRouting.state === 'local_worktree_occupied' &&
        isAcceptedBlockReason(immediatelyBeforeRemovalRouting.reason) &&
        !immediatelyBeforeRemovalRouting.reason.endsWith(
          '-local-worktree-unreadable',
        ) &&
        (
          immediatelyBeforeRemovalRouting.evidence?.local_worktree?.paths ?? []
        ).some(
          (reportedPath) =>
            normalizeGitWorktreePathForComparison(reportedPath) ===
            targetComparisonPath,
        );
      if (
        !immediatelyBeforeRemovalConfirm.ok ||
        !immediatelyBeforeRemovalReportsTarget ||
        immediatelyBeforeRemovalRecovered?.claimId !== recoveredClaimId ||
        immediatelyBeforeRemovalRecovered.branch !== recoveredBranch ||
        immediatelyBeforeRemovalReleased !== recoveredFromReleasedClaim
      ) {
        return recordRemovalFailure(
          'the linked-worktree routing/claim identity changed immediately before removal; stopping before removal',
        );
      }
      finalLinkedLock = deps.checkLock(targetPath);
      if (
        !lockMatchesRecoveredClaim(
          finalLinkedLock,
          recoveredClaimId,
          immediatelyBeforeRemovalReleased,
        )
      ) {
        return recordRemovalFailure(
          'the worktree-local claim lock changed immediately before removal; stopping before removal',
        );
      }
    }

    // The final identity checks above are network-backed and can leave a
    // watcher window before `git worktree remove`. Scan ignored files after
    // those checks and clean only the entries found by this final scan, so
    // ordinary removal cannot silently delete a late ignored file (Codex
    // review #4120561218).
    if (!shortcut.eligible) {
      const finalLateTargetGitDirResult = deps.runGit(
        ['rev-parse', '--absolute-git-dir'],
        targetPath,
      );
      const finalLateTargetGitDir =
        finalLateTargetGitDirResult.ok &&
        finalLateTargetGitDirResult.stdout.trim()
          ? finalLateTargetGitDirResult.stdout.trim()
          : null;
      const finalLateIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [targetPath, ...(finalLateTargetGitDir ? [finalLateTargetGitDir] : [])],
        deps,
        'final-removal',
      );
      const finalIgnoredEntries: IgnoredFileEntry[] = [
        ...finalLateIgnored.copied,
      ];
      verdict.plan.ignoredFilesCopied.push(...finalIgnoredEntries);
      verdict.plan.ignoredFilesScanFailed ||= finalLateIgnored.scanFailed;
      verdict.mutated ||= finalLateIgnored.copied.some(
        (ignored) => ignored.copiedTo !== null,
      );
      for (const stash of verdict.plan.stashes) {
        if (stash.scope === '.') continue;
        const finalSubmodulePath = join(targetPath, stash.scope);
        const finalSubmoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          finalSubmodulePath,
        );
        const finalSubmoduleGitDir =
          finalSubmoduleGitDirResult.ok &&
          finalSubmoduleGitDirResult.stdout.trim()
            ? finalSubmoduleGitDirResult.stdout.trim()
            : null;
        const finalSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          finalSubmodulePath,
          stash.scope,
          true,
          targetPath,
          null,
          [
            targetPath,
            finalSubmodulePath,
            ...(finalLateTargetGitDir ? [finalLateTargetGitDir] : []),
            ...(finalSubmoduleGitDir ? [finalSubmoduleGitDir] : []),
          ],
          deps,
          'final-removal',
        );
        finalIgnoredEntries.push(...finalSubmoduleIgnored.copied);
        verdict.plan.ignoredFilesCopied.push(...finalSubmoduleIgnored.copied);
        verdict.plan.ignoredFilesScanFailed ||=
          finalSubmoduleIgnored.scanFailed;
        verdict.mutated ||= finalSubmoduleIgnored.copied.some(
          (ignored) => ignored.copiedTo !== null,
        );
        if (
          finalSubmoduleIgnored.scanFailed ||
          finalSubmoduleIgnored.copied.some(
            (ignored) =>
              ignored.copyFailed ||
              ignored.copiedTo === null ||
              !deps.pathExists(ignored.copiedTo),
          )
        ) {
          return recordRemovalFailure(
            `final preservation for initialized submodule ${stash.scope} could not be fully verified; stopping before removal`,
          );
        }
      }
      if (
        finalLateIgnored.scanFailed ||
        finalLateIgnored.copied.some(
          (ignored) =>
            ignored.copyFailed ||
            ignored.copiedTo === null ||
            !deps.pathExists(ignored.copiedTo),
        )
      ) {
        return recordRemovalFailure(
          'final ignored-file preservation before linked-worktree removal could not be fully verified; stopping before removal',
        );
      }
      const finalIgnoredCleanupError =
        cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
          finalIgnoredEntries,
          targetPath,
          deps,
        );
      if (finalIgnoredCleanupError !== null) {
        return recordRemovalFailure(
          `before final linked-worktree removal, ${finalIgnoredCleanupError}; stopping before removal`,
        );
      }
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
        )
      ) {
        return recordRemovalFailure(
          'a final ignored-file preservation artifact disappeared before linked-worktree removal; stopping before removal',
        );
      }
      // The final scan and cleanup above are themselves a concurrency window:
      // a replacement claim can be posted while they run. Reconfirm routing
      // and the worktree-local lock after that scan, immediately before the
      // identity-bound removal (Copilot review #4120863032).
      const finalLinkedConfirmAfterIgnored = deps.confirmBlock(cwd);
      const finalLinkedRoutingAfterIgnored =
        finalLinkedConfirmAfterIgnored.routing;
      const finalLinkedRecoveredAfterIgnored = finalLinkedRoutingAfterIgnored
        ? extractRecoveredClaim(finalLinkedRoutingAfterIgnored)
        : null;
      const finalLinkedReleasedAfterIgnored =
        finalLinkedRoutingAfterIgnored !== null &&
        isReleasedClaimRouting(finalLinkedRoutingAfterIgnored);
      const finalLinkedReportsTargetAfterIgnored =
        finalLinkedRoutingAfterIgnored !== null &&
        finalLinkedRoutingAfterIgnored.state === 'local_worktree_occupied' &&
        isAcceptedBlockReason(finalLinkedRoutingAfterIgnored.reason) &&
        !finalLinkedRoutingAfterIgnored.reason.endsWith(
          '-local-worktree-unreadable',
        ) &&
        (
          finalLinkedRoutingAfterIgnored.evidence?.local_worktree?.paths ?? []
        ).some(
          (reportedPath) =>
            normalizeGitWorktreePathForComparison(reportedPath) ===
            targetComparisonPath,
        );
      if (
        !finalLinkedConfirmAfterIgnored.ok ||
        !finalLinkedReportsTargetAfterIgnored ||
        finalLinkedRecoveredAfterIgnored?.claimId !== recoveredClaimId ||
        finalLinkedRecoveredAfterIgnored.branch !== recoveredBranch ||
        finalLinkedReleasedAfterIgnored !== recoveredFromReleasedClaim
      ) {
        return recordRemovalFailure(
          'the linked-worktree routing/claim identity changed after final ignored-file cleanup; stopping before removal',
        );
      }
      finalLinkedLock = deps.checkLock(targetPath);
      if (
        !lockMatchesRecoveredClaim(
          finalLinkedLock,
          recoveredClaimId,
          finalLinkedReleasedAfterIgnored,
        )
      ) {
        return recordRemovalFailure(
          'the worktree-local claim lock changed after final ignored-file cleanup; stopping before removal',
        );
      }

      // The confirmation above is itself a concurrency window: an editor or
      // hook can create a new ignored file after the scan and cleanup but
      // before the identity-bound removal. Scan once more after that
      // confirmation, then repeat the identity checks after this second
      // preservation pass so the final remove cannot discard the new file.
      const postConfirmTargetGitDirResult = deps.runGit(
        ['rev-parse', '--absolute-git-dir'],
        targetPath,
      );
      const postConfirmTargetGitDir =
        postConfirmTargetGitDirResult.ok &&
        postConfirmTargetGitDirResult.stdout.trim()
          ? postConfirmTargetGitDirResult.stdout.trim()
          : null;
      const postConfirmIgnoredEntries: IgnoredFileEntry[] = [];
      let postConfirmIgnoredScanFailed = false;
      const postConfirmIgnored = scanAndMaybeCopyIgnoredFiles(
        targetPath,
        '.',
        true,
        targetPath,
        null,
        [
          targetPath,
          ...(postConfirmTargetGitDir ? [postConfirmTargetGitDir] : []),
        ],
        deps,
        'final-removal-after-confirm',
      );
      postConfirmIgnoredEntries.push(...postConfirmIgnored.copied);
      postConfirmIgnoredScanFailed ||= postConfirmIgnored.scanFailed;
      for (const stash of verdict.plan.stashes) {
        if (stash.scope === '.') continue;
        const submodulePath = join(targetPath, stash.scope);
        const submoduleGitDirResult = deps.runGit(
          ['rev-parse', '--absolute-git-dir'],
          submodulePath,
        );
        const submoduleGitDir =
          submoduleGitDirResult.ok && submoduleGitDirResult.stdout.trim()
            ? submoduleGitDirResult.stdout.trim()
            : null;
        const postConfirmSubmoduleIgnored = scanAndMaybeCopyIgnoredFiles(
          submodulePath,
          stash.scope,
          true,
          targetPath,
          null,
          [
            targetPath,
            submodulePath,
            ...(postConfirmTargetGitDir ? [postConfirmTargetGitDir] : []),
            ...(submoduleGitDir ? [submoduleGitDir] : []),
          ],
          deps,
          'final-removal-after-confirm',
        );
        postConfirmIgnoredEntries.push(...postConfirmSubmoduleIgnored.copied);
        postConfirmIgnoredScanFailed ||= postConfirmSubmoduleIgnored.scanFailed;
      }
      if (
        postConfirmIgnoredScanFailed ||
        postConfirmIgnoredEntries.length > 0
      ) {
        verdict.plan.ignoredFilesCopied.push(...postConfirmIgnoredEntries);
        verdict.plan.ignoredFilesScanFailed ||= postConfirmIgnoredScanFailed;
        verdict.mutated ||= postConfirmIgnoredEntries.some(
          (ignored) => ignored.copiedTo !== null,
        );
        if (
          postConfirmIgnoredScanFailed ||
          postConfirmIgnoredEntries.some(
            (ignored) =>
              ignored.copyFailed ||
              ignored.copiedTo === null ||
              !deps.pathExists(ignored.copiedTo),
          )
        ) {
          return recordRemovalFailure(
            'ignored-file preservation after the final linked confirmation could not be fully verified; stopping before removal',
          );
        }
        const postConfirmIgnoredCleanupError =
          cleanPreservedIgnoredFilesBeforeDestructiveRemoval(
            postConfirmIgnoredEntries,
            targetPath,
            deps,
          );
        if (postConfirmIgnoredCleanupError !== null) {
          return recordRemovalFailure(
            `before final linked-worktree removal after the final confirmation, ${postConfirmIgnoredCleanupError}; stopping before removal`,
          );
        }
        if (
          !reverifyPreservationArtifactsFresh(
            {
              stashes: verdict.plan.stashes,
              backupRefs: verdict.plan.backupRefs,
              uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
              ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
              submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
              worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
            },
            targetPath,
            deps,
          )
        ) {
          return recordRemovalFailure(
            'a preservation artifact disappeared after the final linked confirmation scan; stopping before removal',
          );
        }
        const finalLinkedConfirmAfterPostConfirmIgnored =
          deps.confirmBlock(cwd);
        const finalLinkedRoutingAfterPostConfirmIgnored =
          finalLinkedConfirmAfterPostConfirmIgnored.routing;
        const finalLinkedRecoveredAfterPostConfirmIgnored =
          finalLinkedRoutingAfterPostConfirmIgnored
            ? extractRecoveredClaim(finalLinkedRoutingAfterPostConfirmIgnored)
            : null;
        const finalLinkedReleasedAfterPostConfirmIgnored =
          finalLinkedRoutingAfterPostConfirmIgnored !== null &&
          isReleasedClaimRouting(finalLinkedRoutingAfterPostConfirmIgnored);
        const finalLinkedReportsTargetAfterPostConfirmIgnored =
          finalLinkedRoutingAfterPostConfirmIgnored !== null &&
          finalLinkedRoutingAfterPostConfirmIgnored.state ===
            'local_worktree_occupied' &&
          isAcceptedBlockReason(
            finalLinkedRoutingAfterPostConfirmIgnored.reason,
          ) &&
          !finalLinkedRoutingAfterPostConfirmIgnored.reason.endsWith(
            '-local-worktree-unreadable',
          ) &&
          (
            finalLinkedRoutingAfterPostConfirmIgnored.evidence?.local_worktree
              ?.paths ?? []
          ).some(
            (reportedPath) =>
              normalizeGitWorktreePathForComparison(reportedPath) ===
              targetComparisonPath,
          );
        if (
          !finalLinkedConfirmAfterPostConfirmIgnored.ok ||
          !finalLinkedReportsTargetAfterPostConfirmIgnored ||
          finalLinkedRecoveredAfterPostConfirmIgnored?.claimId !==
            recoveredClaimId ||
          finalLinkedRecoveredAfterPostConfirmIgnored.branch !==
            recoveredBranch ||
          finalLinkedReleasedAfterPostConfirmIgnored !==
            recoveredFromReleasedClaim
        ) {
          return recordRemovalFailure(
            'the linked-worktree routing/claim identity changed after the final confirmation preservation; stopping before removal',
          );
        }
        finalLinkedLock = deps.checkLock(targetPath);
        if (
          !lockMatchesRecoveredClaim(
            finalLinkedLock,
            recoveredClaimId,
            finalLinkedReleasedAfterPostConfirmIgnored,
          )
        ) {
          return recordRemovalFailure(
            'the worktree-local claim lock changed after the final confirmation preservation; stopping before removal',
          );
        }
      }
    }

    let remove: LocalGitCommandResult;
    if (shortcut.eligible) {
      remove = deps.runGit(
        ['worktree', 'remove', '--force', targetPath],
        repoPath,
      );
    } else {
      if (!finalLinkedLock || !deps.removeWorktreeIfLockMatches) {
        return recordRemovalFailure(
          'no identity-bound linked-worktree removal guard is available; stopping before removal',
        );
      }
      const guardedRemove = deps.removeWorktreeIfLockMatches(
        targetPath,
        repoPath,
        finalLinkedLock,
        false,
      );
      if (guardedRemove === null) {
        return recordRemovalFailure(
          'the worktree-local claim lock changed before the identity-bound removal; stopping before removal',
        );
      }
      remove = guardedRemove;
    }
    const submoduleRemovalFailure =
      /submodules cannot be moved or removed/i.test(remove.stderr);
    const dirtyWorktreeRemovalFailure =
      /contains modified or untracked files/i.test(remove.stderr);
    if (
      !shortcut.eligible &&
      !remove.ok &&
      (submoduleRemovalFailure || dirtyWorktreeRemovalFailure)
    ) {
      // `git worktree remove --force` can delete content that appeared after
      // step 3. Re-run the complete preservation scan while the clone lock is
      // still held, then re-confirm the claim and worktree-local lock before
      // authorizing the destructive retry after Git's confirmed submodule
      // removal diagnostic (Codex review #4114311005).
      //
      // An unmerged-path stash refusal is a distinct, narrowly authorized
      // dirty-worktree case: the fallback copies every dirty path because
      // Git cannot stash an unmerged index, but the source checkout remains
      // dirty by design. Permit `--force` only when this fresh preservation
      // pass again copied and verified at least one unmerged fallback path;
      // a generic dirty-worktree failure must never broaden the force path.
      const latePreserve = planAndMaybePreserve(
        targetPath,
        recoveredBranch ?? '',
        tag,
        true,
        deps,
        applyPreserveDir,
        targetGitDir,
      );
      incorporatePreservation(latePreserve, true);
      if (!preservationVerified(latePreserve, deps.pathExists)) {
        return recordRemovalFailure(
          'late preservation before forced removal could not be fully verified; stopping before removal',
        );
      }
      if (
        dirtyWorktreeRemovalFailure &&
        !latePreserve.stashes.some(
          (stash) =>
            stash.unmergedFallbackCopiedTo !== null &&
            stash.unmergedFallbackAllPreserved === true &&
            stash.unmergedFallbackCopiedFiles.length > 0,
        )
      ) {
        return recordRemovalFailure(
          'the dirty-worktree removal failure was not caused by a freshly verified unmerged fallback; stopping before forced removal',
        );
      }
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
        )
      ) {
        return recordRemovalFailure(
          'a late preservation artifact disappeared before forced removal; stopping before removal',
        );
      }
      const forceConfirm = deps.confirmBlock(cwd);
      const forceRouting = forceConfirm.routing;
      const forceRecovered = forceRouting
        ? extractRecoveredClaim(forceRouting)
        : null;
      const forceFromReleasedClaim =
        forceRouting !== null && isReleasedClaimRouting(forceRouting);
      const forceStillMatches =
        forceConfirm.ok &&
        forceRouting !== null &&
        forceRouting.state === 'local_worktree_occupied' &&
        isAcceptedBlockReason(forceRouting.reason) &&
        !forceRouting.reason.endsWith('-local-worktree-unreadable') &&
        (forceRouting.evidence?.local_worktree?.paths ?? []).some(
          (reportedPath) =>
            normalizeGitWorktreePathForComparison(reportedPath) ===
            targetComparisonPath,
        ) &&
        forceRecovered?.claimId === recoveredClaimId &&
        forceRecovered.branch === recoveredBranch &&
        forceFromReleasedClaim === recoveredFromReleasedClaim;
      if (!forceStillMatches) {
        return recordRemovalFailure(
          'the forced-removal routing/claim identity no longer matches; stopping before removal',
        );
      }
      const forceLock = deps.checkLock(targetPath);
      if (
        !lockMatchesRecoveredClaim(
          forceLock,
          recoveredClaimId,
          forceFromReleasedClaim,
        )
      ) {
        return recordRemovalFailure(
          'the worktree-local claim lock no longer matches before forced removal; stopping before removal',
        );
      }
      // The final routing/lock checks above are another concurrency window.
      // Reverify every stash, backup ref, and copied artifact immediately
      // before the identity-bound forced removal, just as the ordinary
      // linked path does before its first removal attempt.
      if (
        !reverifyPreservationArtifactsFresh(
          {
            stashes: verdict.plan.stashes,
            backupRefs: verdict.plan.backupRefs,
            uninitializedSubmodules: verdict.plan.uninitializedSubmodules,
            ignoredFilesCopied: verdict.plan.ignoredFilesCopied,
            submoduleAdminCopies: verdict.plan.submoduleAdminCopies,
            worktreeAdminCopy: verdict.plan.worktreeAdminCopy,
          },
          targetPath,
          deps,
        )
      ) {
        return recordRemovalFailure(
          'a forced-removal preservation artifact disappeared after the final identity checks; stopping before removal',
        );
      }
      if (!deps.removeWorktreeIfLockMatches) {
        return recordRemovalFailure(
          'no identity-bound forced-removal guard is available; stopping before removal',
        );
      }
      const forcedRemove = deps.removeWorktreeIfLockMatches(
        targetPath,
        repoPath,
        forceLock,
        true,
      );
      if (forcedRemove === null) {
        return recordRemovalFailure(
          'the worktree-local claim lock changed before the identity-bound forced removal; stopping before removal',
        );
      }
      remove = forcedRemove;
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
    const prune = deps.runGit(['worktree', 'prune'], repoPath);
    if (!prune.ok) {
      verdict.plan.removal = {
        kind: 'linked',
        developmentBranch: null,
        wouldRun: true,
        ran: false,
        detail: `git worktree remove succeeded, but git worktree prune failed: ${prune.stderr}`,
      };
      verdict.mutated = true;
      verdict.result = verdict.plan.removal.detail;
      return verdict;
    }
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
  } catch (error) {
    return recordRemovalFailure(
      `step 4 dependency failed: ${errorMessage(error)}`,
    );
  } finally {
    deps.releaseCloneLock(lockHandle);
    // `ready` means the apply operation completed its destructive release,
    // not merely that step 1 found a recoverable claim. Any apply-mode return
    // that did not report `removal.ran === true` is therefore a failed or
    // held release and must not retain the ready gate (Copilot review).
    if (mode === 'apply' && verdict.plan.removal?.ran !== true) {
      verdict.ready = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Production dependency wiring (real git / gh)
// ---------------------------------------------------------------------------

/**
 * Resolve `{development-branch}` (§LWR step 4's primary-worktree branch):
 * `developmentBranch` from `.github/idd/config.json` when configured, or
 * the live GitHub default branch when the policy value is absent. A present
 * but invalid policy value fails closed rather than silently falling back to
 * a different branch (Copilot review #4114224382). The live lookup is routed
 * through `gh-exec.mts`'s `readGithubRepoDefaultBranch` /
 * `resolveCurrentGithubRepository` (never a direct `gh` spawn;
 * `tests/gh-spawn-guard.test.mts` enforces this repository-wide).
 */
export function resolveDevelopmentBranchProduction(
  args: Pick<LocalWorktreeRecoveryArgs, 'owner' | 'repo'>,
  repositoryRoot: string,
): string {
  const config = loadRecoveryIddConfig(repositoryRoot);
  const inspection = inspectDevelopmentBranch(config);
  if (inspection.status === 'invalid') {
    throw new Error(
      `local-worktree-recovery: invalid developmentBranch in .github/idd/config.json: ${inspection.reason ?? 'invalid value'}`,
    );
  }
  if (inspection.status === 'configured' && inspection.branch) {
    return inspection.branch;
  }
  if (inspection.status === 'configured') {
    throw new Error(
      'local-worktree-recovery: configured developmentBranch did not include a branch name',
    );
  }
  let fromGh: string | null;
  try {
    const resolvedRepo =
      args.owner && args.repo
        ? { owner: args.owner, repo: args.repo }
        : resolveCurrentGithubRepository();
    fromGh = readGithubRepoDefaultBranch(resolvedRepo.owner, resolvedRepo.repo);
  } catch (error) {
    throw new Error(
      `local-worktree-recovery: could not resolve {development-branch} (no valid developmentBranch in .github/idd/config.json, and the live default-branch lookup failed: ${(error as Error).message})`,
    );
  }
  const liveInspection = inspectDevelopmentBranch({
    developmentBranch: fromGh,
  });
  if (liveInspection.status !== 'configured') {
    throw new Error(
      `local-worktree-recovery: could not resolve a valid default branch name (got: ${fromGh ?? 'none'})`,
    );
  }
  if (!liveInspection.branch) {
    throw new Error(
      'local-worktree-recovery: validated default branch did not include a branch name',
    );
  }
  return liveInspection.branch;
}

/**
 * Read the recovery helper's local config without collapsing malformed or
 * unreadable files into the legitimate "not configured" case. The shared
 * `loadIddConfig()` contract is intentionally permissive for its existing
 * callers, but primary-worktree recovery must not check out a live default
 * branch when the local policy file is present and broken.
 */
function loadRecoveryIddConfig(repositoryRoot: string): unknown | null {
  const configPath = join(repositoryRoot, '.github/idd/config.json');
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error(
        `expected a JSON object at the top level, got ${
          parsed === null
            ? 'null'
            : Array.isArray(parsed)
              ? 'an array'
              : `a ${typeof parsed}`
        }`,
      );
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(
      `could not read ${configPath}: ${errorMessageForProduction(error)}`,
    );
  }
}

/**
 * Copy recovery data without leaving links into the removed worktree dangling.
 * Symlinks whose resolved target is inside `sourceRoot` are materialized;
 * links to external targets retain their original link text. A dangling link
 * that lexically points into the source root fails closed rather than being
 * recorded as preserved merely because its directory entry exists.
 */
export function copyPathWithSafeSymlinks(
  from: string,
  to: string,
  sourceRoot: string = from,
  additionalSourceRoots: string[] = [],
): void {
  const sourceRootsAbsolute = [sourceRoot, ...additionalSourceRoots].map(
    (root) => resolve(root),
  );
  const sourceRootsReal = sourceRootsAbsolute.map((root) => realpathSync(root));
  const activeDirectories = new Set<string>();
  const sameSourceMetadata = (before: Stats, after: Stats): boolean =>
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs;

  const ensureDestinationParent = (destination: string): string => {
    const parent = resolve(dirname(destination));
    const root = parse(parent).root;
    let current = root;
    const suffix = relative(root, parent);
    for (const segment of suffix.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const existing = lstatSync(current);
        if (!existing.isDirectory() || existing.isSymbolicLink()) {
          throw new Error(
            `destination parent is not a real directory: ${current}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        mkdirSync(current);
        const created = lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw new Error(
            `destination parent was replaced during creation: ${current}`,
          );
        }
      }
    }
    return realpathSync(parent);
  };

  const assertDestinationParentStable = (
    destination: string,
    expectedParentReal: string,
  ): void => {
    const actualParentReal = realpathSync(dirname(destination));
    if (actualParentReal !== expectedParentReal) {
      throw new Error(
        `destination parent changed during copy: ${dirname(destination)}`,
      );
    }
  };

  const assertSourceSymlinkStable = (
    source: string,
    sourceStat: Stats,
    linkText: string,
    resolvedTarget: string | null,
  ): void => {
    let currentStat: Stats;
    try {
      currentStat = lstatSync(source);
    } catch {
      throw new Error(`source symlink changed during copy: ${source}`);
    }
    if (
      !currentStat.isSymbolicLink() ||
      !sameSourceMetadata(sourceStat, currentStat)
    ) {
      throw new Error(`source symlink changed during copy: ${source}`);
    }
    let currentLinkText: string;
    try {
      currentLinkText = readlinkSync(source, 'utf8');
    } catch {
      throw new Error(`source symlink changed during copy: ${source}`);
    }
    if (currentLinkText !== linkText) {
      throw new Error(`source symlink changed during copy: ${source}`);
    }
    let currentResolvedTarget: string | null = null;
    try {
      currentResolvedTarget = realpathSync(source);
    } catch {
      // A dangling external link is preserved by link text. The before and
      // after null values still compare equal below; a link that becomes
      // readable (or changes to another target) fails closed.
    }
    if (currentResolvedTarget !== resolvedTarget) {
      throw new Error(`source symlink changed during copy: ${source}`);
    }
  };

  const ensureDestinationDirectory = (destination: string): string => {
    const parentReal = ensureDestinationParent(destination);
    try {
      const existing = lstatSync(destination);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new Error(`destination is not a real directory: ${destination}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(destination);
    }
    assertDestinationParentStable(destination, parentReal);
    const created = lstatSync(destination);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw new Error(`destination is not a real directory: ${destination}`);
    }
    return parentReal;
  };

  const copyEntry = (source: string, destination: string): void => {
    const sourceStat = lstatSync(source);
    const parentReal = ensureDestinationParent(destination);

    if (sourceStat.isSymbolicLink()) {
      const linkText = readlinkSync(source, 'utf8');
      const lexicalTarget = resolve(dirname(source), linkText);
      let resolvedTarget: string | null = null;
      try {
        resolvedTarget = realpathSync(source);
      } catch {
        if (
          sourceRootsAbsolute.some((root) =>
            isPathContainedIn(lexicalTarget, root),
          )
        ) {
          throw new Error(
            `source symlink points to an unreadable path inside the worktree: ${source}`,
          );
        }
      }

      if (
        resolvedTarget !== null &&
        sourceRootsReal.some((root) => isPathContainedIn(resolvedTarget, root))
      ) {
        copyEntry(resolvedTarget, destination);
        assertSourceSymlinkStable(source, sourceStat, linkText, resolvedTarget);
        return;
      }

      const externalTarget = resolvedTarget ?? lexicalTarget;
      const destinationLink = isAbsolute(linkText)
        ? linkText
        : relative(dirname(destination), externalTarget) || '.';
      try {
        const existing = lstatSync(destination);
        if (existing.isSymbolicLink()) {
          unlinkSync(destination);
        } else {
          throw new Error(
            `destination is not a replaceable symlink: ${destination}`,
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      symlinkSync(destinationLink, destination);
      assertDestinationParentStable(destination, parentReal);
      assertSourceSymlinkStable(source, sourceStat, linkText, resolvedTarget);
      return;
    }

    if (sourceStat.isDirectory()) {
      const sourceReal = realpathSync(source);
      if (
        !sourceRootsReal.some((root) => isPathContainedIn(sourceReal, root))
      ) {
        throw new Error(
          `source directory escaped the declared roots during copy: ${source}`,
        );
      }
      if (activeDirectories.has(sourceReal)) {
        throw new Error(`source directory cycle detected: ${source}`);
      }
      activeDirectories.add(sourceReal);
      try {
        ensureDestinationDirectory(destination);
        const entriesBeforeCopy = readdirSync(source).sort();
        for (const entry of entriesBeforeCopy) {
          copyEntry(join(source, entry), join(destination, entry));
        }
        const entriesAfterCopy = readdirSync(source).sort();
        const sourceAfterCopyStat = lstatSync(source);
        if (
          !sourceAfterCopyStat.isDirectory() ||
          sourceAfterCopyStat.isSymbolicLink() ||
          !sameSourceMetadata(sourceStat, sourceAfterCopyStat) ||
          entriesBeforeCopy.length !== entriesAfterCopy.length ||
          entriesBeforeCopy.some(
            (entry, index) => entry !== entriesAfterCopy[index],
          )
        ) {
          throw new Error(`source directory changed during copy: ${source}`);
        }
      } finally {
        activeDirectories.delete(sourceReal);
      }
      return;
    }

    if (!sourceStat.isFile()) {
      throw new Error(`unsupported special file in recovery source: ${source}`);
    }

    // A directory can be replaced with a symlink after its own containment
    // check but before readdirSync. Re-check every regular child here so a
    // traversal through that replacement cannot copy a file from outside the
    // declared source roots.
    const sourceRealBeforeOpen = realpathSync(source);
    if (
      !sourceRootsReal.some((root) =>
        isPathContainedIn(sourceRealBeforeOpen, root),
      )
    ) {
      throw new Error(
        `source file escaped the declared roots during copy: ${source}`,
      );
    }

    // Copy into a private, no-follow temporary leaf and atomically rename it
    // into place. A final lstat after copy cannot protect the destination
    // leaf from being replaced with a symlink between the parent check and
    // the copy; rename replaces that leaf rather than following it.
    const canonicalDestination = join(parentReal, basename(destination));
    const temporaryDirectory = mkdtempSync(join(parentReal, '.idd-lwr-copy-'));
    const temporaryPath = join(
      temporaryDirectory,
      basename(canonicalDestination),
    );
    try {
      let sourceFd: number | null = null;
      let temporaryFd: number | null = null;
      let copiedSourceStat: Stats | null = null;
      try {
        const noFollow = constants.O_NOFOLLOW;
        const nonBlocking = constants.O_NONBLOCK;
        if (noFollow === undefined || nonBlocking === undefined) {
          throw new Error(
            'recovery source copy requires platform-supported no-follow and nonblocking opens',
          );
        }
        sourceFd = openSync(
          source,
          constants.O_RDONLY | noFollow | nonBlocking,
        );
        const openedSourceStat = fstatSync(sourceFd);
        if (!openedSourceStat.isFile()) {
          throw new Error(
            `recovery source changed to a special file during copy: ${source}`,
          );
        }
        temporaryFd = openSync(
          temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
          0o600 | (sourceStat.mode & 0o111),
        );
        const buffer = Buffer.allocUnsafe(64 * 1024);
        for (;;) {
          const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          let offset = 0;
          while (offset < bytesRead) {
            offset += writeSync(
              temporaryFd,
              buffer,
              offset,
              bytesRead - offset,
            );
          }
        }
        copiedSourceStat = fstatSync(sourceFd);
      } finally {
        if (temporaryFd !== null) closeSync(temporaryFd);
        if (sourceFd !== null) closeSync(sourceFd);
      }
      if (
        copiedSourceStat === null ||
        !sameSourceMetadata(sourceStat, copiedSourceStat)
      ) {
        throw new Error(`source changed during copy: ${source}`);
      }
      const finalSourceStat = lstatSync(source);
      if (
        !finalSourceStat.isFile() ||
        !sameSourceMetadata(sourceStat, finalSourceStat)
      ) {
        throw new Error(`source changed during copy: ${source}`);
      }
      const sourceRealAfterCopy = realpathSync(source);
      if (
        !sourceRootsReal.some((root) =>
          isPathContainedIn(sourceRealAfterCopy, root),
        )
      ) {
        throw new Error(
          `source file escaped the declared roots during copy: ${source}`,
        );
      }
      assertDestinationParentStable(destination, parentReal);
      try {
        const existing = lstatSync(canonicalDestination);
        if (existing.isDirectory()) {
          throw new Error(
            `destination is not a regular file: ${canonicalDestination}`,
          );
        }
        // Removing a replaced leaf is safe: a later rename targets the
        // directory entry itself and cannot follow a newly inserted symlink.
        unlinkSync(canonicalDestination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      assertDestinationParentStable(destination, parentReal);
      renameSync(temporaryPath, canonicalDestination);
      assertDestinationParentStable(destination, parentReal);
      const copied = lstatSync(canonicalDestination);
      if (copied.isDirectory() || copied.isSymbolicLink()) {
        throw new Error(
          `destination is not a regular file: ${canonicalDestination}`,
        );
      }
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The copy failure itself is the authoritative safety result; a
        // missing temporary leaf after rename is expected.
      }
      try {
        rmdirSync(temporaryDirectory);
      } catch {
        // A successful rename leaves the private directory empty.
      }
    }
  };

  copyEntry(from, to);
}

function copyPathProduction(
  from: string,
  to: string,
  sourceRoot: string = from,
  additionalSourceRoots: string[] = [],
): void {
  copyPathWithSafeSymlinks(from, to, sourceRoot, additionalSourceRoots);
}

let preserveDirMemo: string | null = null;

function ensurePreserveDirProduction(
  explicit: string,
  targetPath: string,
): () => string {
  return () => {
    if (preserveDirMemo) {
      return preserveDirMemo;
    }
    if (explicit) {
      const explicitDir = resolve(process.cwd(), explicit);
      try {
        mkdirSync(dirname(explicitDir), { recursive: true });
        mkdirSync(explicitDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(
            `local-worktree-recovery: --preserve-dir must name a new directory; refusing to overwrite existing recovery data at ${explicitDir}`,
          );
        }
        throw error;
      }
      preserveDirMemo = explicitDir;
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
function confirmBlockProduction(
  args: Pick<
    LocalWorktreeRecoveryArgs,
    'issue' | 'owner' | 'repo' | 'policy' | 'now'
  >,
  repositoryRoot: string | null = null,
): (cwd: string) => ConfirmBlockOutcome {
  return (cwd: string) => {
    const root = resolveBundleRoot(import.meta.dirname);
    const script = join(root, 'scripts/resume-claim-routing.mjs');
    const argv = [script, '--issue', String(args.issue)];
    if (args.owner) argv.push('--owner', args.owner);
    if (args.repo) argv.push('--repo', args.repo);
    if (args.policy) argv.push('--policy', args.policy);
    if (args.now) argv.push('--now', args.now);
    try {
      const stdout = execFileSync(process.execPath, argv, {
        cwd: repositoryRoot ?? cwd,
        encoding: 'utf8',
      });
      return {
        ok: true,
        routing: JSON.parse(stdout) as ConfirmBlockRouting,
        error: null,
      };
    } catch (error) {
      const execError = error as { stdout?: string; message?: string };
      // A non-zero exit can still have printed a valid JSON verdict
      // (resume-claim-routing.mjs itself only ever exits non-zero on a
      // genuine usage/internal error, but tolerate a parseable payload
      // regardless of exit status rather than discarding it).
      if (execError.stdout) {
        try {
          return {
            ok: true,
            routing: JSON.parse(execError.stdout) as ConfirmBlockRouting,
            error: null,
          };
        } catch {
          // fall through to the error report below
        }
      }
      return { ok: false, routing: null, error: (error as Error).message };
    }
  };
}

function listWorktreeRecordsProduction(
  cwd: string,
): LocalWorktreeRecord[] | null {
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

/** Find a vanished worktree's private admin directory by matching the
 * `gitdir` pointer Git stores under the primary repository's
 * `.git/worktrees/<name>/` entry. A prunable record can still own submodule
 * repositories and an index there, even though its checkout path is gone
 * (Codex review #4114376790). */
function findWorktreeAdminDirProduction(
  repoPath: string,
  worktreePath: string,
): WorktreeAdminDirLookup {
  const rootResult = runLocalGitCommand(
    ['rev-parse', '--git-path', 'worktrees'],
    repoPath,
  );
  if (!rootResult.ok || !rootResult.stdout.trim()) {
    return {
      path: null,
      error: `could not resolve the primary repository worktrees directory: ${rootResult.stderr || 'git rev-parse failed'}`,
    };
  }
  const root = resolve(repoPath, rootResult.stdout.trim());
  const targetGitDir = resolve(worktreePath, '.git');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch (error) {
    return {
      path: null,
      error: `could not read the primary repository worktrees directory: ${errorMessageForProduction(error)}`,
    };
  }
  for (const name of names) {
    const adminPath = join(root, name);
    try {
      if (!lstatSync(adminPath).isDirectory()) continue;
      const pointer = readFileSync(join(adminPath, 'gitdir'), 'utf8').trim();
      if (!pointer) {
        continue;
      }
      const pointedPath = resolve(dirname(join(adminPath, 'gitdir')), pointer);
      if (
        normalizeGitWorktreePathForComparison(pointedPath) ===
        normalizeGitWorktreePathForComparison(targetGitDir)
      ) {
        return { path: adminPath, error: null };
      }
    } catch {
      // Keep scanning unrelated entries, but do not treat an unreadable
      // entry as proof that the target has no recoverable admin directory.
      // If no readable pointer matches below, the caller fails closed rather
      // than removing the prunable worktree without a backup.
    }
  }
  return {
    path: null,
    error: `could not establish ownership of the prunable worktree private admin directory for ${worktreePath}: no readable gitdir pointer matched ${targetGitDir}`,
  };
}

function errorMessageForProduction(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Delete the final primary-worktree lock only after re-reading and matching
 * its complete ownership token. This keeps the cleanup operation from
 * unlinking a replacement lock observed after the caller's earlier check. */
function removeClaimLockIfMatchesProduction(
  worktreePath: string,
  expected: CheckLockOutcome,
): boolean {
  const current = checkClaimLock(worktreePath);
  if (!sameClaimLock(current, expected)) return false;
  try {
    unlinkSync(current.path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Run the destructive forced linked-worktree removal only after re-reading
 * and matching the complete ownership token. This keeps a replacement claim
 * from winning the check-then-remove window between the caller's final
 * routing/lock check and `git worktree remove --force` (Copilot review
 * #4114353778). */
function removeWorktreeIfLockMatchesProduction(
  worktreePath: string,
  repoPath: string,
  expected: CheckLockOutcome,
  force: boolean,
): LocalGitCommandResult | null {
  const current = checkClaimLock(worktreePath);
  if (!sameClaimLock(current, expected)) return null;
  return runLocalGitCommand(
    ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath],
    repoPath,
  );
}

/** Refuse a network-repository override that does not name the local clone. */
export function assertRepositoryOverrideMatchesLocal(
  requested: Pick<LocalWorktreeRecoveryArgs, 'owner' | 'repo'>,
  local: { owner: string; repo: string },
): void {
  if (!requested.owner && !requested.repo) return;
  if (
    requested.owner.toLowerCase() !== local.owner.toLowerCase() ||
    requested.repo.toLowerCase() !== local.repo.toLowerCase()
  ) {
    throw markCliUsageError(
      new Error(
        `local-worktree-recovery: --owner/--repo (${requested.owner}/${requested.repo}) do not match the local repository (${local.owner}/${local.repo}); refusing recovery`,
      ),
    );
  }
}

function createProductionDeps(
  args: LocalWorktreeRecoveryArgs,
): LocalWorktreeRecoveryDeps {
  const repositoryRootResult = runLocalGitCommand(
    ['rev-parse', '--show-toplevel'],
    process.cwd(),
  );
  const repositoryRoot =
    repositoryRootResult.ok && repositoryRootResult.stdout.trim().length > 0
      ? resolve(repositoryRootResult.stdout.trim())
      : null;
  if (args.owner && args.repo) {
    assertRepositoryOverrideMatchesLocal(
      args,
      resolveCurrentGithubRepository(),
    );
  }
  const routingPolicy = args.policy ? resolve(process.cwd(), args.policy) : '';
  return {
    cwd: () => process.cwd(),
    listWorktreeRecords: listWorktreeRecordsProduction,
    confirmBlock: confirmBlockProduction(
      { ...args, policy: routingPolicy },
      repositoryRoot,
    ),
    checkLock: (worktreePath: string) => checkClaimLock(worktreePath),
    removeLockIfMatches: removeClaimLockIfMatchesProduction,
    removeWorktreeIfLockMatches: removeWorktreeIfLockMatchesProduction,
    updatePrimaryRecoveryLockMarker: (
      worktreePath: string,
      expected: CheckLockOutcome,
      marker: PrimaryRecoveryLockMarker | null,
    ) => updatePrimaryRecoveryLockMarker(worktreePath, expected, marker),
    findWorktreeAdminDir: findWorktreeAdminDirProduction,
    runGit: (argv, cwd) =>
      runLocalGitCommand(
        args.apply ? argv : ['--no-optional-locks', ...argv],
        cwd,
      ),
    pathExists: pathExistsOnDisk,
    pathPresence: pathPresenceOnDisk,
    readDirectoryIdentity,
    realpathOrNull,
    readlinkOrNull,
    acquireCloneLock: (repoPath: string, agentId: string) =>
      acquireCloneLock(repoPath, agentId),
    releaseCloneLock: (handle: CloneLockHandle) => releaseCloneLock(handle),
    resolveDevelopmentBranch: () => {
      if (repositoryRoot === null) {
        throw new Error(
          'local-worktree-recovery: could not resolve the primary repository root before reading developmentBranch',
        );
      }
      return resolveDevelopmentBranchProduction(args, repositoryRoot);
    },
    copyPath: copyPathProduction,
    removePath: (path: string) =>
      rmSync(path, { recursive: true, force: true }),
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
} as const;

export function parseArgs(argv: string[]): LocalWorktreeRecoveryArgs {
  const { values, help } = parseCliArgs(
    argv,
    LOCAL_WORKTREE_RECOVERY_FLAG_SPEC,
  );
  const issueRaw = values.issue as string | undefined;
  const parsedIssue =
    issueRaw !== undefined && /^\d+$/.test(issueRaw) ? Number(issueRaw) : null;
  const issue =
    parsedIssue !== null && Number.isSafeInteger(parsedIssue) && parsedIssue > 0
      ? parsedIssue
      : null;
  const owner = ((values.owner as string | undefined) ?? '').trim();
  const repo = ((values.repo as string | undefined) ?? '').trim();
  if ((owner === '') !== (repo === '')) {
    throw markCliUsageError(
      new Error(
        'local-worktree-recovery: --owner and --repo must be provided together or not at all',
      ),
    );
  }
  return {
    issue,
    worktree: ((values.worktree as string | undefined) ?? '').trim(),
    operatorConfirmedNoLiveSession: Boolean(
      values['operator-confirmed-no-live-session'],
    ),
    apply: Boolean(values.apply),
    agentId: (
      (values['agent-id'] as string | undefined) ?? 'idd-lwr-operator'
    ).trim(),
    owner,
    repo,
    policy: ((values.policy as string | undefined) ?? '').trim(),
    now: ((values.now as string | undefined) ?? '').trim(),
    preserveDir: ((values['preserve-dir'] as string | undefined) ?? '').trim(),
    help: Boolean(help),
  };
}

function printHelp(): void {
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

function runCli(): HelperCliResult {
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
  if (args.apply && args.now) {
    throw markCliUsageError(
      new Error(
        'local-worktree-recovery: --now cannot be used with --apply; mutation gates must use real time',
      ),
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
      } catch (error: unknown) {
        process.stderr.write(`Error: ${(error as Error).message}\n`);
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
    } catch (error: unknown) {
      process.stderr.write(`Error: ${(error as Error).message}\n`);
      process.exitCode = 1;
    }
  }
}
