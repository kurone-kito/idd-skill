import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  defaultGitRunner,
  type GitRunner,
  runPrePushTrialBudget,
} from '../src/scripts/pre-push-trial-budget.mts';

// A stub audit-docs in the printed shape of the real one: a budget breach and a
// tooling-ledger failure each print one `- <rule>: <message>` line. The base
// tip's copy is what the trial runs, so a breach that only the merged tree
// carries fails. `ledger-stale.txt` stands in for a helper the base ledger does
// not list.
const AUDIT_STUB = `import { existsSync, readFileSync } from 'node:fs';
const failures = [];
if (readFileSync('budget.txt', 'utf8').trim() !== 'ok') {
  failures.push('- context-ceiling-200k: budget breached');
}
if (existsSync('ledger-stale.txt')) {
  failures.push('- repository-inventory-audit/help-flag-coverage: helper missing from COVERED_HELPERS');
}
if (failures.length > 0) {
  console.log('documentation audit failed:');
  for (const line of failures) console.log(line);
  process.exitCode = 1;
}
`;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function commitFile(
  cwd: string,
  name: string,
  content: string,
  message: string,
): void {
  writeFileSync(join(cwd, name), content);
  git(cwd, ['add', name]);
  git(cwd, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@invalid',
    'commit',
    '-m',
    message,
  ]);
}

/**
 * A bare origin, a seed that pushes `main`, and a work clone on `feature`.
 * `main` then moves on in the seed and is fetched, so the work clone's HEAD is
 * behind `origin/main`. Returns the paths and the feature tip.
 */
function behindFixture(): {
  root: string;
  origin: string;
  seed: string;
  work: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'idd-trial-budget-test-'));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--quiet', '-b', 'main', origin]);
  execFileSync('git', ['init', '--quiet', '-b', 'main', seed]);
  mkdirSync(join(seed, 'scripts'));
  commitFile(seed, 'scripts/audit-docs.mjs', AUDIT_STUB, 'add audit stub');
  commitFile(seed, 'budget.txt', 'ok\n', 'budget ok');
  git(seed, ['remote', 'add', 'origin', origin]);
  git(seed, ['push', '--quiet', 'origin', 'main']);
  execFileSync('git', ['clone', '--quiet', origin, work]);
  git(work, ['checkout', '-q', '-b', 'feature']);
  commitFile(work, 'feature.txt', 'branch work\n', 'feature work');
  return { root, origin, seed, work };
}

/** Move `main` forward in the seed and push it, then fetch it into `work`. */
function advanceMain(
  f: { seed: string; work: string },
  name: string,
  content: string,
): void {
  git(f.seed, ['checkout', '-q', 'main']);
  commitFile(f.seed, name, content, `main: ${name}`);
  git(f.seed, ['push', '--quiet', 'origin', 'main']);
  git(f.work, ['fetch', '--quiet', 'origin']);
}

function auditAt(cwd: string): number {
  return (
    spawnSync('node', ['scripts/audit-docs.mjs', '--check'], { cwd }).status ??
    1
  );
}

test('a branch behind main fails when the merged tree breaches the budget (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'budget.txt', 'over\n');
  // The branch alone is within budget, so the existing branch-only check passes.
  assert.equal(auditAt(f.work), 0);

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.behind, true);
  assert.equal(result.exitCode, 1);
});

test('a behind branch whose merge stays within budget passes the trial (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.behind, true);
  assert.equal(result.exitCode, 0);
});

test('a merge conflict is reported without running the audit (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  commitFile(f.work, 'shared.txt', 'branch version\n', 'branch shared');
  git(f.work, ['push', '--quiet', 'origin', 'feature']);
  advanceMain(f, 'shared.txt', 'main version\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'merge-conflict');
  assert.equal(result.exitCode, 1);
});

test('a branch that already contains main is a no-op, so the chain is unchanged (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'budget.txt', 'over\n');
  git(f.work, [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@invalid',
    'merge',
    '--no-edit',
    'origin/main',
  ]);

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'not-behind');
  assert.equal(result.behind, false);
  assert.equal(result.exitCode, 0);
});

test('the check never pushes or moves a branch or remote ref (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'budget.txt', 'over\n');
  const before = {
    head: git(f.work, ['rev-parse', 'HEAD']),
    base: git(f.work, ['rev-parse', 'origin/main']),
    remote: git(f.origin, [
      'for-each-ref',
      '--format=%(refname) %(objectname)',
    ]),
    worktrees: git(f.work, ['worktree', 'list', '--porcelain']),
  };

  // Record every git invocation, so the absence of a push is observed rather
  // than inferred from unchanged refs (an attempted push can also leave refs as
  // they were).
  const calls: string[][] = [];
  const recording: GitRunner = (cwd, args) => {
    calls.push([...args]);
    return defaultGitRunner(cwd, args);
  };
  runPrePushTrialBudget({ cwd: f.work, runGit: recording });

  assert.ok(calls.length > 0, 'the check ran git');
  assert.equal(
    calls.some((args) => args.includes('push')),
    false,
    'no git invocation pushes',
  );
  assert.equal(git(f.work, ['rev-parse', 'HEAD']), before.head);
  assert.equal(git(f.work, ['rev-parse', 'origin/main']), before.base);
  assert.equal(
    git(f.origin, ['for-each-ref', '--format=%(refname) %(objectname)']),
    before.remote,
  );
  assert.equal(
    git(f.work, ['worktree', 'list', '--porcelain']),
    before.worktrees,
  );
});

test('an unresolvable base fails closed (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));

  const result = runPrePushTrialBudget({
    cwd: f.work,
    base: 'origin/does-not-exist',
  });
  assert.equal(result.outcome, 'unresolved-ref');
  assert.equal(result.exitCode, 1);
  assert.equal(readFileSync(join(f.work, 'budget.txt'), 'utf8'), 'ok\n');
});

test('a host post-checkout hook does not run during the scratch operations (#4010)', {
  skip: process.platform === 'win32',
}, (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'budget.txt', 'over\n');
  const marker = join(f.root, 'hook-ran');
  const hook = join(f.work, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nexit 1\n`, {
    mode: 0o755,
  });

  const result = runPrePushTrialBudget({ cwd: f.work });

  assert.equal(existsSync(marker), false, 'the host hook did not run');
  assert.equal(result.outcome, 'fail');
});

test('a tooling-ledger failure alone is reported and not counted (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // The branch adds a helper that the base ledger does not list. Its ledger
  // failure is reported, but the budget itself is within limits.
  commitFile(f.work, 'ledger-stale.txt', 'helper\n', 'branch adds a helper');
  advanceMain(f, 'unrelated.txt', 'main work\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'pass');
  assert.deepEqual(result.auditFailures, []);
  assert.deepEqual(result.ignoredTooling, [
    'repository-inventory-audit/help-flag-coverage: helper missing from COVERED_HELPERS',
  ]);
  assert.equal(result.exitCode, 0);
});

test('a budget failure is counted even when a ledger failure is also present (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  commitFile(f.work, 'ledger-stale.txt', 'helper\n', 'branch adds a helper');
  advanceMain(f, 'budget.txt', 'over\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(result.auditFailures, [
    'context-ceiling-200k: budget breached',
  ]);
  assert.equal(result.ignoredTooling.length, 1);
  assert.equal(result.exitCode, 1);
});

test('a GIT_DIR inherited from a hook does not redirect the scratch operations (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = join(f.root, 'not-a-repository');
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  });

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'pass');
  assert.equal(result.exitCode, 0);
});

test('a worktree that cannot be unregistered fails the check closed (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');
  const removals: string[] = [];
  const refusingRemove: GitRunner = (cwd, args) => {
    if (args.includes('remove')) {
      removals.push(args[args.length - 1] ?? '');
      return { status: 1, stdout: '' };
    }
    return defaultGitRunner(cwd, args);
  };

  const result = runPrePushTrialBudget({ cwd: f.work, runGit: refusingRemove });
  // Clean up what the refused removal left behind, so the fixture is removed.
  t.after(() => {
    for (const path of removals) {
      defaultGitRunner(f.work, ['worktree', 'remove', '--force', path]);
      rmSync(join(path, '..'), { recursive: true, force: true });
    }
  });

  assert.equal(result.outcome, 'pass');
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.exitCode, 1);
  assert.ok(removals.length > 0, 'the check tried to remove its worktrees');
});
