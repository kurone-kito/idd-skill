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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs } from './cli-args.mjs';
/** Flag spec for `parseCliArgs`. */
export const PRE_PUSH_TRIAL_BUDGET_FLAG_SPEC = {
  '--cwd': { type: 'string' },
  '--base': { type: 'string' },
  '--help': { type: 'boolean' },
};
const DEFAULT_BASE = 'origin/main';
const GIT_IDENTITY = [
  '-c',
  'user.name=idd-trial-budget',
  '-c',
  'user.email=idd-trial-budget@invalid',
];
function git(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}
function resolveCommit(cwd, ref) {
  const result = git(cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]);
  return result.status === 0 ? result.stdout.trim() : null;
}
/**
 * Unregister a scratch worktree. It removes only the worktree that this check
 * created, never a branch or ref, and leaves the scratch directory to the
 * caller so that a second worktree is not deleted under the first.
 */
function removeWorktree(repo, path) {
  git(repo, ['worktree', 'remove', '--force', path]);
  git(repo, ['worktree', 'prune']);
}
/**
 * Run the trial-merge budget check for the repository at `cwd`. `base` names
 * the base tip the branch is compared with (default `origin/main`).
 */
export function runPrePushTrialBudget(options) {
  const repo = options.cwd;
  const base = options.base ?? DEFAULT_BASE;
  const headSha = resolveCommit(repo, 'HEAD');
  const baseSha = resolveCommit(repo, base);
  const fail = (outcome, behind) => ({
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
    git(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0
  ) {
    return fail('not-behind', false);
  }
  const scratch = mkdtempSync(join(tmpdir(), 'idd-pre-push-trial-'));
  const trialTree = join(scratch, 'trial');
  const baseTooling = join(scratch, 'base');
  const created = [];
  try {
    if (
      git(repo, ['worktree', 'add', '--detach', trialTree, headSha]).status !==
      0
    ) {
      return fail('worktree-failed', true);
    }
    created.push(trialTree);
    if (
      git(repo, ['worktree', 'add', '--detach', baseTooling, baseSha])
        .status !== 0
    ) {
      return fail('worktree-failed', true);
    }
    created.push(baseTooling);
    const merged = git(trialTree, [
      ...GIT_IDENTITY,
      'merge',
      '--no-edit',
      '--no-ff',
      baseSha,
    ]);
    if (merged.status !== 0) {
      git(trialTree, ['merge', '--abort']);
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
      removeWorktree(repo, path);
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
function run(argv) {
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
function main(argv) {
  try {
    return run(argv);
  } catch (error) {
    console.error(`pre-push-trial-budget: ${error.message}`);
    return 1;
  }
}
if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
