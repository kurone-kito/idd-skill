#!/usr/bin/env node
// idd-generated-from: src/scripts/f4-worktree-branch-cleanup.mts
//
// The scripts/f4-worktree-branch-cleanup.mjs copy is generated from this .mts
// source by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// The F4 steps 4 to 6 helper (#4370). The flow and its gates live in
// f4-worktree-branch-steps.mts. This module binds them to the real git,
// filesystem, `resume-claim-routing` and `post-idd-marker` commands, `gh`
// reads, the clone-scoped lock, and delete-remote-branch. Run it from the
// primary worktree. A dry run is the default; `--apply` mutates.
import { spawnSync } from 'node:child_process';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { acquireCloneLock, releaseCloneLock } from './clone-lock.mjs';
import { runRemoteBranchDelete } from './delete-remote-branch.mjs';
import {
  claimCheckSpawnOptions,
  resolveCheckoutRepository,
} from './f4-head-proof-live.mjs';
import { runF4WorktreeBranchSteps } from './f4-worktree-branch-steps.mjs';
import { ghApiJson } from './gh-exec.mjs';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mjs';
import { parseLocalWorktreeList } from './local-worktree-occupancy.mjs';
import { gitChildEnvironment } from './provider-adapter-github.mjs';

const F4_CLEANUP_FLAG_SPEC = {
  '--issue': { type: 'string' },
  '--claim-id': { type: 'string' },
  '--nonce': { type: 'string' },
  '--agent-id': { type: 'string' },
  '--worktree': { type: 'string' },
  '--apply': { type: 'boolean' },
  '--help': { type: 'boolean', short: 'h' },
};
/** Largest stdout the helper accepts from one git call (`ls-files` on a big tree). */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
export function parseArgs(argv) {
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
  const issue = values.issue?.trim() ?? '';
  if (!/^[1-9][0-9]*$/.test(issue)) {
    throw markCliUsageError(
      new Error('--issue must be a positive issue number'),
    );
  }
  const claimId = values['claim-id']?.trim() ?? '';
  const nonce = values.nonce?.trim() ?? '';
  const agentId = values['agent-id']?.trim() ?? '';
  const worktree = values.worktree?.trim() ?? '';
  for (const [flag, value] of [
    ['--claim-id', claimId],
    ['--nonce', nonce],
    ['--agent-id', agentId],
  ]) {
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
function printUsage() {
  process.stdout.write(
    'Usage:\n' +
      '  node scripts/f4-worktree-branch-cleanup.mjs --issue <n> --claim-id <id> --nonce <nonce> --agent-id <id> --worktree <abs-path> [--apply]\n\n' +
      'Run from the primary worktree. F4 steps 4 to 6, gated on the head proof.\n' +
      'Dry-run is the default. --apply mutates: fetch, fast-forward, worktree and branch removal, remote branch deletion.\n',
  );
}
/** Run one git command with the child environment's locale fixed to C. */
export function runGit(args, cwd) {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...gitChildEnvironment(), LANG: 'C', LC_ALL: 'C' },
    maxBuffer: GIT_MAX_BUFFER,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? result.error.message : ''),
  };
}
/** The primary worktree: the first record `git worktree list` prints. */
export function primaryWorktreeRoot(cwd) {
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
function isMissingPathError(error) {
  const code = error.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
/** The kind of one path, read without following links. */
export function lstatKind(path) {
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
function realpathOrNull(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}
/** The production dependencies of the flow, bound to this checkout. */
export function createLiveDeps(options) {
  const root = resolveBundleRoot(import.meta.dirname);
  const { owner, repo } = resolveCheckoutRepository();
  const repoPath = `repos/${owner}/${repo}`;
  return {
    lstat: lstatKind,
    readlink: (path) => readlinkSync(path),
    realpath: realpathOrNull,
    git: (args, cwd) => runGit(args, cwd),
    assertClaim: (worktree) => {
      const result = spawnSync(
        process.execPath,
        [
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
        ],
        claimCheckSpawnOptions(),
      );
      return {
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    proofDryRun: () => {
      // Never `--apply`: this helper reads the proof and never posts one.
      const result = spawnSync(
        process.execPath,
        [
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
          options.worktree,
        ],
        claimCheckSpawnOptions(),
      );
      return {
        exitCode: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    prBaseRef: (pr) => {
      try {
        const data = ghApiJson(`${repoPath}/pulls/${pr}`);
        return typeof data?.base?.ref === 'string' ? data.base.ref : null;
      } catch {
        return null;
      }
    },
    deleteBranchOnMerge: () => {
      try {
        const data = ghApiJson(repoPath);
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
        (args) => runGit(args, options.primaryRoot),
      ),
    withCloneLock: (run) => {
      let handle;
      try {
        handle = acquireCloneLock(options.primaryRoot, options.agentId);
      } catch {
        return { acquired: false };
      }
      try {
        return { acquired: true, value: run() };
      } finally {
        releaseCloneLock(handle);
      }
    },
  };
}
function main() {
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
