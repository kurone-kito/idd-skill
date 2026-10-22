#!/usr/bin/env node
// idd-generated-from: src/scripts/f4-worktree-branch-cleanup.mts
//
// The scripts/f4-worktree-branch-cleanup.mjs copy is generated from this .mts
// source by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// The F4 steps 4 to 6 helper (#4370). The flow and its gates live in
// f4-worktree-branch-steps.mts. This module binds them to the real git,
// filesystem (including preserving a lone ignored node_modules/ tree),
// `resume-claim-routing` and `post-idd-marker` commands, `gh` reads, the
// clone-scoped lock, and delete-remote-branch. Run it from the primary
// worktree. A dry run is the default; `--apply` mutates.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mts';
import { parseCliArgs } from './cli-args.mts';
import {
  acquireCloneLock,
  CloneLockTimeoutError,
  releaseCloneLock,
} from './clone-lock.mts';
import {
  type GitCommandResult,
  runRemoteBranchDelete,
} from './delete-remote-branch.mts';
import {
  claimCheckSpawnOptions,
  resolveCheckoutRepository,
} from './f4-head-proof-live.mts';
import type {
  DirectoryPrivacy,
  F4WorktreeBranchDeps,
  GitResult,
  LstatKind,
  SpawnedResult,
} from './f4-worktree-branch-steps.mts';
import { runF4WorktreeBranchSteps } from './f4-worktree-branch-steps.mts';
import { ghApiJson } from './gh-exec.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  type HelperCliResult,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import { resolveStateBase } from './idd-local-admission.mts';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mts';
import { gitChildEnvironment } from './provider-adapter-github.mts';
import {
  evaluateWindowsAcl,
  readWindowsAcl,
  type WindowsAclReader,
} from './windows-acl.mts';

const F4_CLEANUP_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--worktree': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

/** Largest stdout the helper accepts from one git call (`ls-files` on a big tree). */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** Upper bound on one git call, so a stalled remote cannot hang the helper. */
const GIT_TIMEOUT_MS = 600_000;

export interface F4CleanupArgs {
  readonly help: boolean;
  readonly issueNumber: number;
  readonly claimId: string;
  readonly nonce: string;
  readonly agentId: string;
  readonly worktree: string;
  readonly apply: boolean;
}

export function parseArgs(argv: string[]): F4CleanupArgs {
  const { values, help } = parseCliArgs(argv, F4_CLEANUP_FLAG_SPEC);
  if (help) {
    return {
      help,
      issueNumber: 0,
      claimId: '',
      nonce: '',
      agentId: '',
      worktree: '',
      apply: false,
    };
  }
  const issue = (values.issue as string | undefined)?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(issue)) {
    throw markCliUsageError(
      new Error('--issue must be a positive issue number'),
    );
  }
  const claimId = (values['claim-id'] as string | undefined)?.trim() ?? '';
  const nonce = (values.nonce as string | undefined)?.trim() ?? '';
  const agentId = (values['agent-id'] as string | undefined)?.trim() ?? '';
  const worktree = (values.worktree as string | undefined)?.trim() ?? '';
  for (const [flag, value] of [
    ['--claim-id', claimId],
    ['--nonce', nonce],
    ['--agent-id', agentId],
  ] as const) {
    if (value.length === 0) {
      throw markCliUsageError(new Error(`${flag} must not be empty`));
    }
  }
  if (!isAbsolute(worktree)) {
    throw markCliUsageError(
      new Error('--worktree must be an absolute path to the claimed worktree'),
    );
  }
  return {
    help,
    issueNumber: Number(issue),
    claimId,
    nonce,
    agentId,
    worktree: resolve(worktree),
    apply: values.apply === true,
  };
}

function printUsage(): void {
  process.stdout.write(
    'Usage:\n' +
      '  node scripts/f4-worktree-branch-cleanup.mjs --issue <n> --claim-id <id> --nonce <nonce> --agent-id <id> --worktree <abs-path> [--apply]\n\n' +
      'Run from the primary worktree. F4 steps 4 to 6, gated on the head proof.\n' +
      'Dry-run is the default. --apply mutates: fetch, fast-forward, secure the state destination, preserve a lone ignored node_modules/, worktree and branch removal, remote branch deletion.\n',
  );
}

/** Run one git command with the child environment's locale fixed to C. */
export function runGit(args: readonly string[], cwd: string): GitResult {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...gitChildEnvironment(),
      LANG: 'C',
      LC_ALL: 'C',
      // A helper run must not stop at a credential prompt.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}

/** The primary worktree: the first record `git worktree list` prints. */
export function primaryWorktreeRoot(cwd: string): string {
  const listing = runGit(['worktree', 'list', '--porcelain', '-z'], cwd);
  if (listing.status !== 0) {
    throw new Error(`git worktree list failed: ${listing.stderr.trim()}`);
  }
  const [first] = parseLocalWorktreeList(listing.stdout);
  if (first === undefined) {
    throw new Error('git worktree list names no primary worktree');
  }
  return first.path;
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** The kind of one path, read without following links. */
export function lstatKind(path: string): LstatKind {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return 'symlink';
    }
    if (stat.isDirectory()) {
      return 'directory';
    }
    return stat.isFile() ? 'file' : 'other';
  } catch (error) {
    if (isMissingPathError(error)) {
      return 'absent';
    }
    throw error;
  }
}

/** Return a stable identity for a real directory without following links. */
function directoryIdentity(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.ino === 0n) {
      return null;
    }
    return `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch (error) {
    // Only a missing path is null. Any other failure is raised, so an
    // unreadable path can never match another one.
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function inspectDirectoryPrivacy(
  path: string,
  platform: NodeJS.Platform,
  windowsAclReader: WindowsAclReader,
): DirectoryPrivacy {
  try {
    const lexical = lstatSync(path);
    const target = statSync(path);
    if (!target.isDirectory()) return 'unsafe';
    if (platform === 'win32') {
      return evaluateWindowsAcl(windowsAclReader(realpathSync.native(path))) ===
        'private'
        ? 'private'
        : 'unsafe';
    }
    const uid = process.getuid?.();
    if (uid !== undefined && target.uid !== uid) return 'unsafe';
    if ((target.mode & 0o077) === 0 && (target.mode & 0o700) === 0o700) {
      return 'private';
    }
    return lexical.isSymbolicLink() ? 'unsafe' : 'tightenable';
  } catch {
    return 'unsafe';
  }
}

function ensurePrivateStateDirectory(
  path: string,
  platform: NodeJS.Platform,
  windowsAclReader: WindowsAclReader,
): void {
  const privacy = inspectDirectoryPrivacy(path, platform, windowsAclReader);
  if (privacy === 'private') return;
  if (privacy !== 'tightenable') {
    throw new Error('directory ownership or privacy could not be verified');
  }
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error('a state-root symlink target is not private');
  }
  const uid = process.getuid?.();
  const target = statSync(path);
  if (uid !== undefined && target.uid !== uid) {
    throw new Error('directory belongs to another user');
  }
  chmodSync(path, 0o700);
  if (inspectDirectoryPrivacy(path, platform, windowsAclReader) !== 'private') {
    throw new Error('directory could not be restricted to its owner');
  }
}

export interface LiveCleanupOptions {
  readonly issueNumber: number;
  readonly claimId: string;
  readonly nonce: string;
  readonly agentId: string;
  readonly worktree: string;
  readonly primaryRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly home?: string;
  readonly now?: () => Date;
  readonly windowsAclReader?: WindowsAclReader;
}

/** The argv of `resume-claim-routing --assert` for the claimed worktree. */
export function claimCheckArgv(
  options: Pick<LiveCleanupOptions, 'issueNumber' | 'claimId' | 'nonce'>,
  worktree: string,
  owner: string,
  repo: string,
  root: string,
): string[] {
  return [
    join(root, 'scripts', 'resume-claim-routing.mjs'),
    '--issue',
    String(options.issueNumber),
    '--assert',
    '--claim-id',
    options.claimId,
    '--nonce',
    options.nonce,
    '--worktree',
    worktree,
    '--owner',
    owner,
    '--repo',
    repo,
  ];
}

/**
 * The argv of the marker command's dry run. It never carries `--apply`:
 * this helper reads the proof and never posts one.
 */
export function proofDryRunArgv(
  options: Pick<LiveCleanupOptions, 'issueNumber' | 'claimId' | 'agentId'>,
  worktree: string,
  root: string,
): string[] {
  return [
    join(root, 'scripts', 'post-idd-marker.mjs'),
    '--type',
    'f4-head-proof',
    '--target',
    'issue',
    String(options.issueNumber),
    '--agent-id',
    options.agentId,
    '--claim-id',
    options.claimId,
    '--worktree',
    worktree,
  ];
}

/** Run one spawned helper and keep its exit status, stdout, and stderr. */
function runSpawned(argv: string[]): SpawnedResult {
  const result = spawnSync(process.execPath, argv, claimCheckSpawnOptions());
  return {
    exitCode: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** The production dependencies of the flow, bound to this checkout. */
export function createLiveDeps(
  options: LiveCleanupOptions,
): F4WorktreeBranchDeps {
  const root = resolveBundleRoot(import.meta.dirname);
  const { owner, repo } = resolveCheckoutRepository();
  const repoPath = `repos/${owner}/${repo}`;
  const platform = options.platform ?? process.platform;
  const windowsAclReader = options.windowsAclReader ?? readWindowsAcl;
  const stateRoot = resolveStateBase(
    options.env ?? process.env,
    platform,
    options.home ?? homedir(),
  );
  return {
    lstat: lstatKind,
    directoryIdentity,
    realpath: realpathOrNull,
    stateRoot,
    now: options.now ?? (() => new Date()),
    temporaryId: randomUUID,
    inspectDirectoryPrivacy: (path) =>
      inspectDirectoryPrivacy(path, platform, windowsAclReader),
    ensurePrivateDirectory: (path) =>
      ensurePrivateStateDirectory(path, platform, windowsAclReader),
    mkdir: (path, mode) => mkdirSync(path, { mode }),
    rename: (source, destination) => renameSync(source, destination),
    git: (args, cwd) => runGit(args, cwd),
    assertClaim: (worktree) =>
      runSpawned(claimCheckArgv(options, worktree, owner, repo, root)),
    proofDryRun: () =>
      runSpawned(proofDryRunArgv(options, options.worktree, root)),
    prBaseRef: (pr) => {
      try {
        const data = ghApiJson(`${repoPath}/pulls/${pr}`) as {
          base?: { ref?: unknown };
        };
        return typeof data?.base?.ref === 'string' ? data.base.ref : null;
      } catch {
        return null;
      }
    },
    deleteBranchOnMerge: () => {
      try {
        const data = ghApiJson(repoPath) as {
          delete_branch_on_merge?: unknown;
        };
        return typeof data?.delete_branch_on_merge === 'boolean'
          ? data.delete_branch_on_merge
          : null;
      } catch {
        return null;
      }
    },
    remoteDelete: (mode, branch, expectedSha) =>
      runRemoteBranchDelete(
        { branch, expectedSha, apply: mode === 'apply' },
        (args): GitCommandResult => runGit(args, options.primaryRoot),
      ),
    withCloneLock: (run) => {
      let handle: ReturnType<typeof acquireCloneLock>;
      try {
        handle = acquireCloneLock(options.primaryRoot, options.agentId);
      } catch (error) {
        // Only a timeout means another session holds the lock. Any other
        // failure is an error, not a busy lock, and nothing has changed yet.
        if (error instanceof CloneLockTimeoutError) {
          return { acquired: false };
        }
        throw error;
      }
      try {
        return { acquired: true, value: run() };
      } finally {
        releaseCloneLock(handle);
      }
    },
  };
}

function main(): HelperCliResult {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }
  const cwd = process.cwd();
  const primaryRoot = primaryWorktreeRoot(cwd);
  const top = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (
    top.status !== 0 ||
    realpathOrNull(top.stdout.trim()) === null ||
    realpathOrNull(primaryRoot) === null ||
    realpathOrNull(top.stdout.trim()) !== realpathOrNull(primaryRoot)
  ) {
    throw markCliUsageError(
      new Error(
        'run from the primary worktree; this helper never runs from the worktree it removes',
      ),
    );
  }
  const report = runF4WorktreeBranchSteps(
    {
      issueNumber: args.issueNumber,
      claimId: args.claimId,
      agentId: args.agentId,
      worktree: args.worktree,
      primaryRoot,
      apply: args.apply,
    },
    createLiveDeps({
      issueNumber: args.issueNumber,
      claimId: args.claimId,
      nonce: args.nonce,
      agentId: args.agentId,
      worktree: args.worktree,
      primaryRoot,
    }),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === 'complete' || report.status === 'dry-run' ? 0 : 1;
}

if (import.meta.main) {
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('f4-worktree-branch-cleanup', main);
  } else {
    applyHelperCliOutcomeWhenDisabled(main());
  }
}
