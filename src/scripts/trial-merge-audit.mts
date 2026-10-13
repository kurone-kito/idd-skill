#!/usr/bin/env node
// idd-generated-from: src/scripts/trial-merge-audit.mts
//
// The scripts/trial-merge-audit.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Local, push-free evidence for a PR: builds the merged tree of the PR head
// and the current base tip, runs the fixed verification commands in a
// temporary worktree under base-tip tooling, and prints one JSON verdict.
// It never pushes and never moves a ref. The verdict is evidence only; F1's
// routing does not change.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  MERGE_BASE_FETCH_STEPS,
  resolveFetchOrigin,
  resolveMergeBaseWithRetry,
} from './branch-conflict-state.mts';
import { parseCliArgs } from './cli-args.mts';
import {
  acquireCloneLock,
  type CloneLockHandle,
  releaseCloneLock,
} from './clone-lock.mts';
import { ghText, resolveGhOwnerRepo } from './gh-exec.mts';
import type { HelperCliResult } from './helper-cli-runner.mts';
import {
  applyHelperCliOutcomeWhenDisabled,
  isHelperErrorEnvelopeEnabled,
  markCliUsageError,
  runHelperCli,
} from './helper-cli-runner.mts';
import {
  addScratchWorktree,
  DEFAULT_KEEP_LIST,
  scrubbedGitEnv,
  type TrialGitRunner,
} from './trial-scratch.mts';

/** Directories whose content install and the fixed commands read as tooling. */
const TOOLING_DIRS = [
  'scripts/',
  'src/',
  'bin/',
  'schemas/',
  'audit/',
  '.husky/',
  '.githooks/',
];
const TOOLING_FILES = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.npmrc',
  '.github/idd/config.json',
]);
// Root-level only. A tsconfig or pnpmfile in a subdirectory is not read by
// install or by the fixed commands.
const TOOLING_ROOT_PATTERNS = [
  /^tsconfig[^/]*\.json$/,
  /^\.?pnpmfile(\.[cm]?js)?$/,
];

export function isToolingPath(path: string): boolean {
  if (TOOLING_FILES.has(path)) return true;
  // A workspace package manifest is an install input at any depth.
  if (path.endsWith('/package.json')) return true;
  // A node_modules tree committed by the PR would be read by the install and
  // the commands, so it counts as tooling at any depth (review, 2026-10-12).
  if (path.split('/').includes('node_modules')) return true;
  // A nested tsconfig can be reached through a root config's extends, and a
  // tracked .gitignore or .gitattributes changes what the commands see and how
  // the checkout behaves (review, 2026-10-12).
  const name = path.split('/').pop() ?? '';
  if (
    /^tsconfig[^/]*\.json$/.test(name) ||
    name === '.gitignore' ||
    name === '.gitattributes'
  ) {
    return true;
  }
  if (TOOLING_DIRS.some((dir) => path.startsWith(dir))) return true;
  return TOOLING_ROOT_PATTERNS.some((pattern) => pattern.test(path));
}

/** The frozen-lockfile install, with lifecycle scripts disabled. */
const INSTALL_ARGV = [
  'pnpm',
  'install',
  '--frozen-lockfile',
  '--ignore-scripts',
];

export type CommandId = 'audit-docs' | 'sync-docs' | 'typecheck';

/** The three fixed commands, in order. `script` must exist on the base tip. */
export const FIXED_COMMANDS: readonly {
  id: CommandId;
  argv: string[];
  script: string;
}[] = [
  {
    id: 'audit-docs',
    argv: ['node', 'scripts/audit-docs.mjs', '--check'],
    script: 'scripts/audit-docs.mjs',
  },
  {
    id: 'sync-docs',
    argv: ['node', 'scripts/sync-docs.mjs', '--check'],
    script: 'scripts/sync-docs.mjs',
  },
  {
    id: 'typecheck',
    argv: ['pnpm', 'run', 'typecheck'],
    script: 'package.json#scripts.typecheck',
  },
];

export interface TrialCommandResult {
  id: CommandId;
  argv: string[];
  exitCode: number | null;
  passed: boolean;
}

export interface TrialMergeAuditResult {
  protocolVersion: '1';
  verdict: 'passed' | 'failed' | 'not-run';
  prHeadSha: string | null;
  baseSha: string | null;
  trialCommit: string | null;
  commands: TrialCommandResult[];
  toolingChanged: string[];
  install: { exitCode: number | null; passed: boolean } | null;
  worktreeRemoved: boolean;
  reasons: string[];
}

interface CommandRun {
  exitCode: number | null;
  error?: NodeJS.ErrnoException;
}

/** Injectable boundaries, so tests run without gh, pnpm or the network. */
export interface TrialMergeAuditDeps {
  readPr?: (
    owner: string,
    repo: string,
    pr: string,
  ) => { headRefOid: string; baseRefOid: string; baseRefName: string };
  runInstall?: (cwd: string, argv: string[]) => CommandRun;
  runCommand?: (
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => CommandRun;
  agentId?: string;
  lockTimeoutMs?: number;
  fetchUrl?: string;
}

interface GitOutcome {
  status: number | null;
  stdout: string;
}

/** A fetch that stalls is cut off, so it cannot hold the clone lock forever. */
const FETCH_TIMEOUT_MS = 180_000;

/**
 * The install and the verification commands run outside the clone lock, but
 * a stalled one must still end, so the audit returns a verdict (review).
 */
const INSTALL_TIMEOUT_MS = 900_000;
const COMMAND_TIMEOUT_MS = 600_000;

/**
 * A file listing of a large repository exceeds spawnSync's 1 MiB default
 * output buffer, which would make the listing read as empty or fail.
 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The scratch-trial runner for the steps in trial-scratch.mts. It is a plain
 * spawn: runGitHooksOff adds the hooks-path prefix, so this adds none.
 */
const runScratchGit: TrialGitRunner = (args, cwd, env) => {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: GIT_MAX_BUFFER,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/**
 * One budget for the whole deepen sequence of the merge-base retry. The
 * sequence runs under the clone-wide lock, so it must not multiply the fetch
 * timeout by the number of steps (review, 2026-10-12).
 */
const MERGE_BASE_DEEPEN_BUDGET_MS = 120_000;

/**
 * Splits paths into checkout argument lists that stay well under Windows'
 * command-line limit. The count cap alone does not bound a long path list.
 */
function batchPaths(
  paths: string[],
  maxCount = 500,
  maxChars = 8000,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (
      current.length > 0 &&
      (current.length >= maxCount || chars + path.length > maxChars)
    ) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 1;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Run git with an empty hooks directory, so no hook runs in this audit,
 * including the post-checkout hook that `worktree add` fires.
 */
function git(
  cwd: string,
  hooksDir: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  timeout?: number,
): GitOutcome {
  const result = spawnSync(
    'git',
    ['-c', `core.hooksPath=${hooksDir}`, ...args],
    {
      cwd,
      encoding: 'utf8',
      env: env ?? scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
      timeout,
      maxBuffer: GIT_MAX_BUFFER,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
  };
}

function gitAtLeast(hooksDir: string, major: number, minor: number): boolean {
  const out = git(process.cwd(), hooksDir, ['--version']);
  const match = out.stdout.match(/git version (\d+)\.(\d+)/);
  if (!match) return false;
  const gotMajor = Number(match[1]);
  const gotMinor = Number(match[2]);
  return gotMajor > major || (gotMajor === major && gotMinor >= minor);
}

function listFiles(
  repo: string,
  hooksDir: string,
  rev: string,
): string[] | null {
  // -z for the same reason as the diff below: quoted names would not match.
  const out = git(repo, hooksDir, ['ls-tree', '-r', '-z', '--name-only', rev]);
  if (out.status !== 0) return null;
  return out.stdout.split('\0').filter((line) => line.length > 0);
}

function defaultReadPr(
  owner: string,
  repo: string,
  pr: string,
): { headRefOid: string; baseRefOid: string; baseRefName: string } {
  const raw = ghText([
    'pr',
    'view',
    pr,
    '-R',
    `${owner}/${repo}`,
    '--json',
    'headRefOid,baseRefOid,baseRefName',
    '--jq',
    '.',
  ]);
  return JSON.parse(raw) as {
    headRefOid: string;
    baseRefOid: string;
    baseRefName: string;
  };
}

/**
 * Git config for the verification commands. audit-docs and sync-docs list
 * untracked files with --exclude-standard, so a host's core.excludesFile
 * would change which files they check (review, 2026-10-12). The excludes file
 * and the global config point at an empty file in the scratch root, which
 * works on every platform, where the null device does not. Command-line
 * config outranks the repository's own config. The fetch keeps its
 * credentials, because it runs through scrubbedGitEnv() on its own.
 */
function pinnedGitEnv(scratchRoot: string): NodeJS.ProcessEnv {
  const emptyConfig = join(scratchRoot, 'empty-gitconfig');
  writeFileSync(emptyConfig, '');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.excludesFile',
    GIT_CONFIG_VALUE_0: emptyConfig,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function defaultRun(
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  timeoutMs: number = COMMAND_TIMEOUT_MS,
): CommandRun {
  const [command, ...args] = argv;
  // On Windows pnpm is a .cmd shim, which only a shell resolves. A run that
  // exceeds timeoutMs fails with ETIMEDOUT, so the audit always returns.
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
      ...extraEnv,
    },
    shell: process.platform === 'win32',
    timeout: timeoutMs,
  });
  return {
    exitCode: result.status,
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

interface AuditContext {
  worktreeCreated: boolean;
  /** False when a failed scratch add left its registration behind. */
  registrationRemoved: boolean;
}

/**
 * Run the trial-merge audit for one PR in the clone at `repo`.
 *
 * The clone-scoped lock covers the steps that change the shared clone's
 * refs or worktree records: fetch, `worktree add`, and `worktree remove`.
 * Install and the commands do not hold it, since they can run for minutes.
 * There is no `git worktree prune`. A plain prune is clone-wide and would
 * clear other sessions' gone records. Only a worktree this run created is
 * removed.
 */
export function runTrialMergeAudit(
  repo: string,
  pr: string,
  owner: string,
  repoName: string,
  deps: TrialMergeAuditDeps = {},
): TrialMergeAuditResult {
  const readPr = deps.readPr ?? defaultReadPr;
  const runInstall =
    deps.runInstall ??
    ((cwd: string, argv: string[]) =>
      defaultRun(argv, cwd, {}, INSTALL_TIMEOUT_MS));
  const runCommand =
    deps.runCommand ??
    ((argv: string[], cwd: string, extraEnv: NodeJS.ProcessEnv) =>
      defaultRun(argv, cwd, extraEnv, COMMAND_TIMEOUT_MS));
  const agentId = deps.agentId ?? `trial-merge-audit-${process.pid}`;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 60_000;

  const hooksDir = mkdtempSync(join(tmpdir(), 'idd-trial-hooks-'));
  const tmp = join(mkdtempSync(join(tmpdir(), 'idd-trial-merge-')), 'worktree');
  const ctx: AuditContext = {
    worktreeCreated: false,
    registrationRemoved: true,
  };
  const origin = resolveFetchOrigin(
    scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
    {
      readOriginUrl: () =>
        git(repo, hooksDir, ['remote', 'get-url', 'origin']).stdout.trim(),
    },
  );
  const fetchUrl =
    deps.fetchUrl ??
    `${origin.scheme}://${origin.host}/${owner}/${repoName}.git`;
  let result: TrialMergeAuditResult;
  let worktreeRemoved = true;
  try {
    result = audit({
      repo,
      pr,
      owner,
      repoName,
      hooksDir,
      tmp,
      ctx,
      readPr,
      runInstall,
      runCommand,
      agentId,
      lockTimeoutMs,
      fetchUrl,
    });
  } finally {
    if (ctx.worktreeCreated) {
      // Re-acquire the lock for removal. A failed removal is reported, and the
      // directory is left in place for the operator. Nothing is pruned.
      try {
        const lock = acquireCloneLock(repo, agentId, lockTimeoutMs);
        try {
          const removed = git(repo, hooksDir, [
            'worktree',
            'remove',
            '--force',
            tmp,
          ]);
          worktreeRemoved = removed.status === 0 && !existsSync(tmp);
        } finally {
          releaseCloneLock(lock);
        }
      } catch {
        worktreeRemoved = false;
      }
    }
    // A failed add that kept its registration leaves the worktree for the
    // operator, so its parent directory is kept as well.
    if (!ctx.registrationRemoved) worktreeRemoved = false;
    rmSync(hooksDir, { recursive: true, force: true });
    if (worktreeRemoved)
      rmSync(join(tmp, '..'), { recursive: true, force: true });
  }
  result.worktreeRemoved = worktreeRemoved;
  if (!worktreeRemoved) result.reasons.push('worktree-remove-failed');
  return result;
}

interface AuditArgs {
  repo: string;
  pr: string;
  owner: string;
  repoName: string;
  hooksDir: string;
  tmp: string;
  ctx: AuditContext;
  readPr: NonNullable<TrialMergeAuditDeps['readPr']>;
  runInstall: NonNullable<TrialMergeAuditDeps['runInstall']>;
  runCommand: NonNullable<TrialMergeAuditDeps['runCommand']>;
  agentId: string;
  lockTimeoutMs: number;
  fetchUrl: string;
}

function emptyResult(
  reason: string,
  fields: Partial<TrialMergeAuditResult> = {},
): TrialMergeAuditResult {
  return {
    protocolVersion: '1',
    verdict: 'not-run',
    prHeadSha: null,
    baseSha: null,
    trialCommit: null,
    commands: [],
    toolingChanged: [],
    install: null,
    worktreeRemoved: true,
    reasons: [reason],
    ...fields,
  };
}

function audit(args: AuditArgs): TrialMergeAuditResult {
  const { repo, pr, hooksDir, tmp, ctx } = args;
  if (!gitAtLeast(hooksDir, 2, 38)) {
    return emptyResult('unsupported-git');
  }

  let pull: ReturnType<AuditArgs['readPr']>;
  try {
    pull = args.readPr(args.owner, args.repoName, pr);
  } catch {
    return emptyResult('pr-read-failed');
  }
  const headSha = pull.headRefOid;
  const baseSha = pull.baseRefOid;

  // Lock scope 1: fetch, merge-base, merge-tree, commit-tree and worktree add.
  let lock: CloneLockHandle;
  try {
    lock = acquireCloneLock(repo, args.agentId, args.lockTimeoutMs);
  } catch {
    return emptyResult('clone-lock-unavailable', {
      prHeadSha: headSha,
      baseSha,
    });
  }
  let trialCommit = '';
  let mergeBase = '';
  try {
    const fetched = git(
      repo,
      hooksDir,
      [
        'fetch',
        // FETCH_HEAD is shared by the clone, and a named ref is never moved.
        '--no-write-fetch-head',
        '--no-tags',
        args.fetchUrl,
        // Fully qualified, so a branch name can never parse as a git option.
        `refs/heads/${pull.baseRefName}`,
        `refs/pull/${pr}/head`,
      ],
      undefined,
      FETCH_TIMEOUT_MS,
    );
    if (fetched.status !== 0) {
      return emptyResult('fetch-failed', { prHeadSha: headSha, baseSha });
    }
    // The SHAs must still be the tips read before the lock. A PR that moved
    // during the wait would otherwise be merged at an older commit.
    let again: ReturnType<AuditArgs['readPr']>;
    try {
      again = args.readPr(args.owner, args.repoName, pr);
    } catch {
      return emptyResult('pr-read-failed', { prHeadSha: headSha, baseSha });
    }
    if (again.headRefOid !== headSha || again.baseRefOid !== baseSha) {
      return emptyResult('pr-moved', { prHeadSha: headSha, baseSha });
    }
    for (const sha of [headSha, baseSha]) {
      if (
        git(repo, hooksDir, ['cat-file', '-e', `${sha}^{commit}`]).status !== 0
      ) {
        return emptyResult('fetch-failed', { prHeadSha: headSha, baseSha });
      }
    }

    // Decision 2 (2026-10-12): resolve the merge base before merge-tree. On a
    // shallow clone the base can be missing, and merge-tree would then report
    // a conflict that is not there. The bounded deepen steps run first, under
    // this lock, the same way branch-conflict-state runs them.
    // Deepening only applies to a clone that is already shallow. A `--depth`
    // fetch into a complete clone would make the shared clone shallow, so a
    // complete clone with no merge base is reported as unreachable as it is.
    const shallow =
      git(repo, hooksDir, [
        'rev-parse',
        '--is-shallow-repository',
      ]).stdout.trim() === 'true';
    const deepenSteps = shallow ? MERGE_BASE_FETCH_STEPS.slice(1) : [];
    const deepenDeadline = Date.now() + MERGE_BASE_DEEPEN_BUDGET_MS;
    mergeBase =
      resolveMergeBaseWithRetry(
        () =>
          git(repo, hooksDir, ['merge-base', baseSha, headSha]).stdout.trim(),
        (step) => {
          const remaining = deepenDeadline - Date.now();
          if (remaining <= 0) return false;
          return (
            git(
              repo,
              hooksDir,
              [
                'fetch',
                '--no-write-fetch-head',
                '--no-tags',
                ...deepenSteps[step],
                args.fetchUrl,
                `refs/heads/${pull.baseRefName}`,
                `refs/pull/${pr}/head`,
              ],
              undefined,
              Math.min(FETCH_TIMEOUT_MS, remaining),
            ).status === 0
          );
        },
        deepenSteps.length,
      ) ?? '';
    if (mergeBase.length === 0) {
      return emptyResult('merge-base-unreachable', {
        prHeadSha: headSha,
        baseSha,
      });
    }

    const merged = git(repo, hooksDir, [
      'merge-tree',
      '--write-tree',
      baseSha,
      headSha,
    ]);
    if (merged.status === 1) {
      return emptyResult('content-conflict', {
        prHeadSha: headSha,
        baseSha,
      });
    }
    if (merged.status !== 0) {
      return emptyResult('merge-tree-failed', {
        prHeadSha: headSha,
        baseSha,
      });
    }
    const tree = merged.stdout.split('\n')[0].trim();

    const trial = git(
      repo,
      hooksDir,
      ['commit-tree', tree, '-p', headSha, '-p', baseSha, '-m', 'trial merge'],
      {
        ...scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
        GIT_AUTHOR_NAME: 'trial-merge-audit',
        GIT_AUTHOR_EMAIL: 'trial-merge-audit@localhost',
        GIT_COMMITTER_NAME: 'trial-merge-audit',
        GIT_COMMITTER_EMAIL: 'trial-merge-audit@localhost',
      },
    );
    trialCommit = trial.stdout.trim();
    if (trial.status !== 0 || trialCommit.length === 0) {
      return emptyResult('commit-tree-failed', {
        prHeadSha: headSha,
        baseSha,
      });
    }

    const added = addScratchWorktree(runScratchGit, {
      cwd: repo,
      hooksDir,
      path: tmp,
      commit: trialCommit,
      env: scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
    });
    if (!added.ok) {
      ctx.registrationRemoved = added.registrationRemoved;
      return emptyResult('worktree-add-failed', {
        prHeadSha: headSha,
        baseSha,
        trialCommit,
      });
    }
    ctx.worktreeCreated = true;
  } finally {
    releaseCloneLock(lock);
  }

  // Overlay base-tip tooling. A tooling path that the PR changed is replaced
  // by the base tip's copy, and a tooling path the base lacks is removed.
  // Every such path is listed as toolingChanged.
  // -z keeps a path verbatim: without it git quotes a non-ASCII name, so the
  // path would miss both toolingChanged and the base-tip overlay.
  const changed = git(repo, hooksDir, [
    'diff',
    '-z',
    '--no-renames',
    '--name-only',
    mergeBase,
    headSha,
  ]);
  const baseFiles = listFiles(repo, hooksDir, baseSha);
  const mergedFiles = listFiles(repo, hooksDir, trialCommit);
  if (changed.status !== 0 || baseFiles === null || mergedFiles === null) {
    return emptyResult('tooling-read-failed', {
      prHeadSha: headSha,
      baseSha,
      trialCommit,
    });
  }
  const toolingChanged = changed.stdout
    .split('\0')
    .filter((path) => path.length > 0 && isToolingPath(path))
    .sort();
  const baseTooling = baseFiles.filter(isToolingPath);
  const mergedTooling = mergedFiles.filter(isToolingPath);
  const baseSet = new Set(baseTooling);
  const prOnlyTooling = mergedTooling.filter((path) => !baseSet.has(path));
  for (const path of prOnlyTooling) {
    // Recursive, so a gitlink that checked out as an empty directory is removed.
    rmSync(join(tmp, path), { recursive: true, force: true });
  }
  // The scratch index still lists these paths, and the commands enumerate it
  // with git ls-files --cached, so they must leave the index as well.
  for (const batch of batchPaths(prOnlyTooling)) {
    const removal = git(tmp, hooksDir, [
      'rm',
      '--cached',
      '--quiet',
      '--ignore-unmatch',
      '--',
      ...batch,
    ]);
    if (removal.status !== 0) {
      return emptyResult('overlay-failed', {
        prHeadSha: headSha,
        baseSha,
        trialCommit,
      });
    }
  }
  for (const batch of batchPaths(baseTooling)) {
    const overlay = git(tmp, hooksDir, ['checkout', baseSha, '--', ...batch]);
    if (overlay.status !== 0) {
      return emptyResult('overlay-failed', {
        prHeadSha: headSha,
        baseSha,
        trialCommit,
      });
    }
  }

  // audit-docs reads the base from GITHUB_EVENT_PATH first, so give it the
  // base SHA this run merged rather than the checkout's stale origin/main.
  const eventPath = join(dirname(tmp), 'event.json');
  writeFileSync(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: baseSha } } }),
  );
  // Any node_modules the PR committed is already removed as tooling above; a
  // fresh install starts from a directory with no node_modules at all.
  rmSync(join(tmp, 'node_modules'), { recursive: true, force: true });
  const install = args.runInstall(tmp, INSTALL_ARGV);
  if (install.error !== undefined || install.exitCode !== 0) {
    return {
      protocolVersion: '1',
      verdict: 'not-run',
      prHeadSha: headSha,
      baseSha,
      trialCommit,
      commands: [],
      toolingChanged,
      install: { exitCode: install.exitCode, passed: false },
      worktreeRemoved: true,
      reasons: ['install-failed'],
    };
  }

  // The commands always run, even when tooling changed, as evidence against
  // base-tip tooling. A command whose script is absent on the base tip is
  // recorded with a null exit code and passed false (decision 1, 2026-10-12),
  // and the verdict then names commands-unavailable.
  const absent: string[] = [];
  const timedOut: string[] = [];
  const commands: TrialCommandResult[] = FIXED_COMMANDS.map((command) => {
    if (!scriptPresent(tmp, command.script)) {
      absent.push(command.id);
      return {
        id: command.id,
        argv: command.argv,
        exitCode: null,
        passed: false,
      };
    }
    const run = args.runCommand(command.argv, tmp, {
      GITHUB_EVENT_PATH: eventPath,
      ...pinnedGitEnv(dirname(tmp)),
    });
    if (run.error?.code === 'ETIMEDOUT') timedOut.push(command.id);
    return {
      id: command.id,
      argv: command.argv,
      exitCode: run.exitCode,
      passed: run.error === undefined && run.exitCode === 0,
    };
  });

  const reasons: string[] = [];
  let verdict: TrialMergeAuditResult['verdict'];
  if (toolingChanged.length > 0) {
    verdict = 'not-run';
    reasons.push('tooling-changed');
  } else if (timedOut.length > 0) {
    // A command cut off by its timeout is incomplete evidence, not a failure.
    verdict = 'not-run';
    reasons.push('command-timed-out');
  } else if (absent.length > 0) {
    verdict = 'not-run';
    reasons.push('commands-unavailable');
  } else if (commands.every((command) => command.passed)) {
    verdict = 'passed';
  } else {
    verdict = 'failed';
    reasons.push('command-failed');
  }
  return {
    protocolVersion: '1',
    verdict,
    prHeadSha: headSha,
    baseSha,
    trialCommit,
    commands,
    toolingChanged,
    install: { exitCode: install.exitCode, passed: true },
    worktreeRemoved: true,
    reasons,
  };
}

function scriptPresent(tmp: string, script: string): boolean {
  if (script === 'package.json#scripts.typecheck') {
    try {
      const pkg = JSON.parse(
        readFileSync(join(tmp, 'package.json'), 'utf8'),
      ) as {
        scripts?: Record<string, unknown>;
      };
      return typeof pkg.scripts?.typecheck === 'string';
    } catch {
      return false;
    }
  }
  return existsSync(join(tmp, script));
}

const TRIAL_MERGE_AUDIT_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  // Mirrors branch-conflict-state's helper-runtime handling.
  if (isHelperErrorEnvelopeEnabled()) {
    runHelperCli('trial-merge-audit', main);
  } else {
    main().then(applyHelperCliOutcomeWhenDisabled, (error) => {
      throw error;
    });
  }
}

async function main(): Promise<HelperCliResult> {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    TRIAL_MERGE_AUDIT_FLAG_SPEC,
  );
  if (help) {
    process.stdout.write(
      'Usage:\n  node scripts/trial-merge-audit.mjs --pr <number> [--owner <owner>] [--repo <repo>]\n',
    );
    process.exit(0);
  }
  const rawPr = values.pr as string | undefined;
  if (rawPr === undefined) {
    throw markCliUsageError(
      new Error('missing required --pr <number> argument'),
    );
  }
  if (!/^[1-9]\d*$/.test(rawPr)) {
    throw markCliUsageError(new Error(`invalid --pr value: ${rawPr}`));
  }
  const { owner, repo } = resolveGhOwnerRepo({
    owner: values.owner as string | undefined,
    repo: values.repo as string | undefined,
  });
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: scrubbedGitEnv(process.env, DEFAULT_KEEP_LIST),
  });
  const repoRoot = (top.stdout ?? '').trim();
  if (top.status !== 0 || repoRoot.length === 0) {
    throw new Error('not inside a git repository');
  }
  const result = runTrialMergeAudit(repoRoot, rawPr, owner, repo);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
