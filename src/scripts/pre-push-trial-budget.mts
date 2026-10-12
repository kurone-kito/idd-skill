#!/usr/bin/env node
// idd-generated-from: src/scripts/pre-push-trial-budget.mts
//
// The scripts/pre-push-trial-budget.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Pre-push budget check on a trial merge (#4010). A branch can pass the budget
// audit on its own and still breach it once it merges the current base, because
// the base may have moved the same measured bytes. When the branch is behind
// origin/main, this check merges origin/main into a throwaway detached worktree
// of HEAD and runs the base tip's audit-docs script there, so a breach that only
// appears after the merge fails the push. The base tip's script is used so the
// branch cannot relax its own budget. The check never pushes and never moves a
// branch or a remote ref. A branch that is not behind is a no-op.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseCliArgs } from './cli-args.mts';

/** Flag spec for `parseCliArgs`. */
export const PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--base': { type: 'string' },
  '--help': { type: 'boolean' },
} as const;

/**
 * `not-behind`: HEAD already contains the base tip, so nothing is merged.
 * `pass` / `fail`: the base tip's audit-docs passed or failed on the trial
 * merge. `merge-conflict`: the merge itself failed, so no audit ran.
 * `unresolved-ref`: HEAD or the base cannot be resolved, so the check fails
 * closed. `worktree-failed`: a scratch worktree could not be created.
 */
export type PrePushTrialBudgetOutcome =
  | 'not-behind'
  | 'pass'
  | 'fail'
  | 'merge-conflict'
  | 'unresolved-ref'
  | 'worktree-failed';

export interface PrePushTrialBudgetResult {
  outcome: PrePushTrialBudgetOutcome;
  behind: boolean;
  headSha: string | null;
  baseSha: string | null;
  exitCode: 0 | 1;
}

const DEFAULT_BASE = 'origin/main';
const GIT_IDENTITY = [
  '-c',
  'user.name=idd-trial-budget',
  '-c',
  'user.email=idd-trial-budget@invalid',
];

/** One git invocation in a working directory: the status and stdout. */
export type GitRunner = (
  cwd: string,
  args: readonly string[],
) => { status: number; stdout: string };

/** The default runner, a plain `git -C <cwd>` spawn with no extra config. */
export const defaultGitRunner: GitRunner = (cwd, args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

function resolveCommit(
  runGit: GitRunner,
  cwd: string,
  ref: string,
): string | null {
  const result = runGit(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Run the trial-merge budget check for the repository at `cwd`. `base` names
 * the base tip the branch is compared with (default `origin/main`).
 */
export function runPrePushTrialBudget(options: {
  cwd: string;
  base?: string;
  runGit?: GitRunner;
}): PrePushTrialBudgetResult {
  const repo = options.cwd;
  const base = options.base ?? DEFAULT_BASE;
  const runGit = options.runGit ?? defaultGitRunner;
  const headSha = resolveCommit(runGit, repo, 'HEAD');
  const baseSha = resolveCommit(runGit, repo, base);
  const fail = (
    outcome: PrePushTrialBudgetOutcome,
    behind: boolean,
  ): PrePushTrialBudgetResult => ({
    outcome,
    behind,
    headSha,
    baseSha,
    exitCode: outcome === 'not-behind' || outcome === 'pass' ? 0 : 1,
  });
  if (headSha === null || baseSha === null) {
    return fail('unresolved-ref', false);
  }
  if (
    runGit(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0
  ) {
    return fail('not-behind', false);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'idd-pre-push-trial-'));
  const trialTree = join(scratch, 'trial');
  const baseTooling = join(scratch, 'base');
  // An empty hooks directory, so no post-checkout or merge hook of the host
  // runs during the scratch operations (as the trial-merge helper does).
  const hooksOff = join(scratch, 'hooks');
  mkdirSync(hooksOff);
  const noHooks = [`-c`, `core.hooksPath=${hooksOff}`];
  const gitScratch = (cwd: string, args: readonly string[]) =>
    runGit(cwd, [...noHooks, ...args]);
  // Each worktree is recorded before its status is checked, so a worktree that
  // a failed add still created is removed by the cleanup below.
  const created: string[] = [];
  try {
    created.push(trialTree);
    if (
      gitScratch(repo, ['worktree', 'add', '--detach', trialTree, headSha])
        .status !== 0
    ) {
      return fail('worktree-failed', true);
    }
    created.push(baseTooling);
    if (
      gitScratch(repo, ['worktree', 'add', '--detach', baseTooling, baseSha])
        .status !== 0
    ) {
      return fail('worktree-failed', true);
    }

    const merged = gitScratch(trialTree, [
      ...GIT_IDENTITY,
      'merge',
      '--no-edit',
      '--no-ff',
      baseSha,
    ]);
    if (merged.status !== 0) {
      gitScratch(trialTree, ['merge', '--abort']);
      return fail('merge-conflict', true);
    }

    const audit = spawnSync(
      'node',
      [join(baseTooling, 'scripts', 'audit-docs.mjs'), '--check'],
      { cwd: trialTree, encoding: 'utf8' },
    );
    return fail(audit.status === 0 ? 'pass' : 'fail', true);
  } finally {
    for (const path of created.reverse()) {
      // Only the worktree this check created is unregistered. No branch or
      // ref is touched, and `prune` is not run because it is repository-wide.
      gitScratch(repo, ['worktree', 'remove', '--force', path]);
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

const USAGE = `usage: node scripts/pre-push-trial-budget.mjs [--cwd <repo>] [--base <ref>] [--help]

Budget check on a trial merge of the base tip into HEAD, run only when the
branch is behind the base. Prints one JSON result and exits 0 for not-behind
or pass, 1 otherwise. It never pushes and never moves a branch or remote ref.

  --cwd <repo>   repository to check (default: the current directory)
  --base <ref>   base tip the branch is compared with (default: origin/main)
  --help         print this usage and exit 0
`;

function run(argv: readonly string[]): number {
  const { values } = parseCliArgs(argv, PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC);
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }
  const result = runPrePushTrialBudget({
    cwd: typeof values.cwd === 'string' ? values.cwd : process.cwd(),
    base: typeof values.base === 'string' ? values.base : undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.exitCode;
}

function main(argv: readonly string[]): number {
  try {
    return run(argv);
  } catch (error) {
    console.error(`pre-push-trial-budget: ${(error as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
