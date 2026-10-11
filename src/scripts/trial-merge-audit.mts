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
import { resolveFetchOrigin } from './branch-conflict-state.mts';
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

/**
 * Run git with an empty hooks directory, so no hook runs in this audit,
 * including the post-checkout hook that `worktree add` fires.
 */
/**
 * The inherited environment without repository overrides (GIT_DIR,
 * GIT_WORK_TREE and the rest), so a hook or wrapper that exports them cannot
 * point this audit at another repository. Credential prompts are disabled so
 * a stalled fetch fails instead of waiting for input.
 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Credential helpers stay usable; repository routing and config do not.
  const kept = new Set([
    'GIT_ASKPASS',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_SSH_VARIANT',
  ]);
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && !kept.has(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return env;
}

/** A fetch that stalls is cut off, so it cannot hold the clone lock forever. */
const FETCH_TIMEOUT_MS = 180_000;

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
      env: env ?? sanitizedEnv(),
      timeout,
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
  const out = git(repo, hooksDir, ['ls-tree', '-r', '--name-only', rev]);
  if (out.status !== 0) return null;
  return out.stdout.split('\n').filter((line) => line.length > 0);
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

function defaultRun(
  argv: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
): CommandRun {
  const [command, ...args] = argv;
  // On Windows pnpm is a .cmd shim, which only a shell resolves.
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'ignore',
    env: { ...sanitizedEnv(), ...extraEnv },
    shell: process.platform === 'win32',
  });
  return {
    exitCode: result.status,
    error: result.error as NodeJS.ErrnoException | undefined,
  };
}

interface AuditContext {
  worktreeCreated: boolean;
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
    deps.runInstall ?? ((cwd: string, argv: string[]) => defaultRun(argv, cwd));
  const runCommand = deps.runCommand ?? defaultRun;
  const agentId = deps.agentId ?? `trial-merge-audit-${process.pid}`;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 60_000;

  const hooksDir = mkdtempSync(join(tmpdir(), 'idd-trial-hooks-'));
  const tmp = join(mkdtempSync(join(tmpdir(), 'idd-trial-merge-')), 'worktree');
  const ctx: AuditContext = { worktreeCreated: false };
  const origin = resolveFetchOrigin(sanitizedEnv(), {
    readOriginUrl: () =>
      git(repo, hooksDir, ['remote', 'get-url', 'origin']).stdout.trim(),
  });
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

  // Lock scope 1: fetch, merge-tree, commit-tree and worktree add.
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
        pull.baseRefName,
        `pull/${pr}/head`,
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
        ...sanitizedEnv(),
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

    const added = git(repo, hooksDir, [
      'worktree',
      'add',
      '--detach',
      tmp,
      trialCommit,
    ]);
    if (added.status !== 0) {
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
  const mergeBaseRead = git(repo, hooksDir, ['merge-base', baseSha, headSha]);
  const mergeBase = mergeBaseRead.stdout.trim();
  if (mergeBaseRead.status !== 0 || mergeBase.length === 0) {
    return emptyResult('merge-base-failed', { prHeadSha: headSha, baseSha });
  }
  const changed = git(repo, hooksDir, [
    'diff',
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
    .split('\n')
    .filter((path) => path.length > 0 && isToolingPath(path))
    .sort();
  const baseTooling = baseFiles.filter(isToolingPath);
  const mergedTooling = mergedFiles.filter(isToolingPath);
  const baseSet = new Set(baseTooling);
  for (const path of mergedTooling) {
    if (!baseSet.has(path)) {
      rmSync(join(tmp, path), { force: true });
    }
  }
  for (let i = 0; i < baseTooling.length; i += 500) {
    const overlay = git(tmp, hooksDir, [
      'checkout',
      baseSha,
      '--',
      ...baseTooling.slice(i, i + 500),
    ]);
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
  // base-tip tooling. A command whose script is absent on the base tip fails.
  const commands: TrialCommandResult[] = FIXED_COMMANDS.map((command) => {
    if (!scriptPresent(tmp, command.script)) {
      return {
        id: command.id,
        argv: command.argv,
        exitCode: null,
        passed: false,
      };
    }
    const run = args.runCommand(command.argv, tmp, {
      GITHUB_EVENT_PATH: eventPath,
    });
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
    env: sanitizedEnv(),
  });
  const repoRoot = (top.stdout ?? '').trim();
  if (top.status !== 0 || repoRoot.length === 0) {
    throw new Error('not inside a git repository');
  }
  const result = runTrialMergeAudit(repoRoot, rawPr, owner, repo);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}
