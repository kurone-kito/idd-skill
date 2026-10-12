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
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  /** Audit failures that are budget or documentation failures, so they count. */
  auditFailures: string[];
  /**
   * Audit failures from the tooling ledger (`repository-inventory-audit`). They
   * are reported but not counted: the base tip's ledger cannot list a helper
   * that the branch adds, and the branch's own CI audits the merged tree.
   */
  ignoredTooling: string[];
  /** True when a scratch worktree could not be unregistered. Fails closed. */
  cleanupFailed: boolean;
  exitCode: 0 | 1;
}

const DEFAULT_BASE = 'origin/main';
const LEDGER_RULE_PREFIX = 'repository-inventory-audit';
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

/**
 * The inherited environment without `GIT_*` variables. A pre-push hook sets
 * `GIT_DIR` and related variables, and they would redirect every scratch
 * command to the host's repository or index.
 */
export function sanitizedEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

/** The default runner, a plain `git -C <cwd>` spawn with a sanitized env. */
export const defaultGitRunner: GitRunner = (cwd, args) => {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: sanitizedEnv(),
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
 * The failure lines of an audit-docs run. Its errors are printed as `- <rule>:
 * <message>` lines after `documentation audit failed:`.
 */
export function auditFailureLines(output: string): string[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

function isLedgerFailure(line: string): boolean {
  return line.startsWith(LEDGER_RULE_PREFIX);
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
  const finish = (
    outcome: PrePushTrialBudgetOutcome,
    behind: boolean,
    extra: { auditFailures?: string[]; ignoredTooling?: string[] } = {},
    cleanupFailed = false,
  ): PrePushTrialBudgetResult => {
    const passed = outcome === 'not-behind' || outcome === 'pass';
    return {
      outcome,
      behind,
      headSha,
      baseSha,
      auditFailures: extra.auditFailures ?? [],
      ignoredTooling: extra.ignoredTooling ?? [],
      cleanupFailed,
      exitCode: passed && !cleanupFailed ? 0 : 1,
    };
  };
  if (headSha === null || baseSha === null) {
    return finish('unresolved-ref', false);
  }
  if (
    runGit(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0
  ) {
    return finish('not-behind', false);
  }

  const scratch = mkdtempSync(join(tmpdir(), 'idd-pre-push-trial-'));
  const trialTree = join(scratch, 'trial');
  const baseTooling = join(scratch, 'base');
  // An empty hooks directory, so no host hook runs during the scratch work (as
  // the trial-merge helper does), and signing is off for the throwaway merge.
  const hooksOff = join(scratch, 'hooks');
  mkdirSync(hooksOff);
  const scratchConfig = [
    '-c',
    `core.hooksPath=${hooksOff}`,
    '-c',
    'commit.gpgSign=false',
  ];
  const gitScratch = (cwd: string, args: readonly string[]) =>
    runGit(cwd, [...scratchConfig, ...args]);
  const created: string[] = [];
  const cleanupFailures: string[] = [];

  // The trial: resolves to an outcome and the audit lines, and never cleans up.
  const trial = (): {
    outcome: PrePushTrialBudgetOutcome;
    auditFailures?: string[];
    ignoredTooling?: string[];
  } => {
    // Each worktree is recorded before its status is checked, so a worktree a
    // failed add still created is removed by the cleanup below.
    created.push(trialTree);
    if (
      gitScratch(repo, ['worktree', 'add', '--detach', trialTree, headSha])
        .status !== 0
    ) {
      return { outcome: 'worktree-failed' };
    }
    created.push(baseTooling);
    if (
      gitScratch(repo, ['worktree', 'add', '--detach', baseTooling, baseSha])
        .status !== 0
    ) {
      return { outcome: 'worktree-failed' };
    }

    const merged = gitScratch(trialTree, [
      ...GIT_IDENTITY,
      'merge',
      '--no-edit',
      '--no-ff',
      '--no-gpg-sign',
      baseSha,
    ]);
    if (merged.status !== 0) {
      gitScratch(trialTree, ['merge', '--abort']);
      return { outcome: 'merge-conflict' };
    }

    const audit = spawnSync(
      'node',
      [join(baseTooling, 'scripts', 'audit-docs.mjs'), '--check'],
      { cwd: trialTree, encoding: 'utf8', env: sanitizedEnv() },
    );
    if (audit.status === 0) {
      return { outcome: 'pass' };
    }
    const lines = auditFailureLines(
      `${audit.stdout ?? ''}${audit.stderr ?? ''}`,
    );
    const ignoredTooling = lines.filter(isLedgerFailure);
    const auditFailures = lines.filter((line) => !isLedgerFailure(line));
    // A non-zero exit with no parsable failure line is unknown, so it fails
    // closed with a reason rather than passing.
    if (lines.length === 0) {
      return {
        outcome: 'fail',
        auditFailures: ['audit-docs exited non-zero with no parsable failure'],
      };
    }
    if (auditFailures.length > 0) {
      return { outcome: 'fail', auditFailures, ignoredTooling };
    }
    return { outcome: 'pass', ignoredTooling };
  };

  let verdict: ReturnType<typeof trial> = { outcome: 'worktree-failed' };
  try {
    verdict = trial();
  } finally {
    for (const path of created.reverse()) {
      // Only the worktree this check created is unregistered. No branch or ref
      // is touched, and `prune` is not run because it is repository-wide.
      const removed = gitScratch(repo, ['worktree', 'remove', '--force', path]);
      // A path that a failed add never created is not a cleanup failure.
      if (removed.status !== 0 && existsSync(path)) {
        cleanupFailures.push(path);
      }
    }
    // The scratch directory is kept when a worktree stayed registered, so the
    // operator can recover it.
    if (cleanupFailures.length === 0) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  // Reaching the trial means HEAD is behind the base.
  return finish(verdict.outcome, true, verdict, cleanupFailures.length > 0);
}

const USAGE = `usage: node scripts/pre-push-trial-budget.mjs [--cwd <repo>] [--base <ref>] [--help]

Budget check on a trial merge of the base tip into HEAD, run only when the
branch is behind the base. Prints one JSON result and exits 0 for not-behind
or pass, 1 otherwise. It never pushes and never moves a branch or remote ref.
Tooling-ledger failures (repository-inventory-audit) are listed as
ignoredTooling and are not counted.

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
