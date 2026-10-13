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
  acquireCloneLock,
  releaseCloneLock,
} from '../src/scripts/clone-lock.mts';
import {
  defaultGitRunner,
  type GitRunner,
  runPrePushTrialBudget,
} from '../src/scripts/pre-push-trial-budget.mts';
import { stubExecutable } from './test-utils.mts';

// A stub audit-docs in the printed shape of the real one. Its budget is the
// size in budget.txt against the limit in audit/sync-manifest.json, read from
// the working directory, as the real audit reads its policy. Each failure is one
// `- <rule>: <message>` line. `ledger-stale.txt` stands in for a helper the base
// ledger does not list, and `required-missing.txt` for a missing required input.
const AUDIT_STUB = `import { existsSync, readFileSync } from 'node:fs';
const limit = JSON.parse(readFileSync('audit/sync-manifest.json', 'utf8')).limit;
const size = Number(readFileSync('budget.txt', 'utf8').trim());
const failures = [];
if (size > limit) {
  failures.push(\`- context-ceiling-200k: \${size} bytes exceeds the \${limit}-byte limit\`);
}
if (existsSync('ledger-stale.txt')) {
  failures.push('- repository-inventory-audit/help-flag-coverage: helper missing from COVERED_HELPERS');
}
if (existsSync('required-missing.txt')) {
  failures.push('- repository-inventory-audit-required-file: scripts/x.mjs is missing');
}
if (failures.length > 0) {
  console.log('documentation audit failed:');
  for (const line of failures) console.log(line);
  process.exitCode = 1;
}
`;

const BREACH_MESSAGE =
  '- context-ceiling-200k: 20 bytes exceeds the 10-byte limit';

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
 * The budget is 5 against a limit of 10, so the base is within budget. `main`
 * then moves on in the seed and is fetched, so the work clone's HEAD is behind
 * `origin/main`.
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
  mkdirSync(join(seed, 'audit'));
  commitFile(seed, 'scripts/audit-docs.mjs', AUDIT_STUB, 'add audit stub');
  commitFile(
    seed,
    'audit/sync-manifest.json',
    '{"limit": 10}\n',
    'add manifest',
  );
  commitFile(seed, 'budget.txt', '5\n', 'budget 5');
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
  advanceMain(f, 'budget.txt', '20\n');
  // The branch alone is within budget, so the existing branch-only check passes.
  assert.equal(auditAt(f.work), 0);

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.equal(result.behind, true);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.auditFailures, [BREACH_MESSAGE.slice(2)]);
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
  advanceMain(f, 'budget.txt', '20\n');
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
  advanceMain(f, 'budget.txt', '20\n');
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
  assert.equal(readFileSync(join(f.work, 'budget.txt'), 'utf8'), '5\n');
});

test('a host post-checkout hook does not run during the scratch operations (#4010)', {
  skip: process.platform === 'win32',
}, (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'budget.txt', '20\n');
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
  advanceMain(f, 'budget.txt', '20\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(result.auditFailures, [BREACH_MESSAGE.slice(2)]);
  assert.equal(result.ignoredTooling.length, 1);
  assert.equal(result.exitCode, 1);
});

test('a required-input failure is not mistaken for a ledger failure (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // A missing required input means the audit cannot run, so it counts.
  commitFile(f.work, 'required-missing.txt', 'x\n', 'branch removes an input');
  advanceMain(f, 'unrelated.txt', 'main work\n');

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(result.auditFailures, [
    'repository-inventory-audit-required-file: scripts/x.mjs is missing',
  ]);
  assert.deepEqual(result.ignoredTooling, []);
  assert.equal(result.exitCode, 1);
});

test('a branch cannot relax the budget through its own manifest (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  // The branch raises the limit in its own manifest. Its branch-only audit then
  // passes, but the trial pins the base tip's policy, so the breach still fails.
  commitFile(
    f.work,
    'audit/sync-manifest.json',
    '{"limit": 100}\n',
    'branch raises the limit',
  );
  advanceMain(f, 'budget.txt', '20\n');
  assert.equal(auditAt(f.work), 0);

  const result = runPrePushTrialBudget({ cwd: f.work });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(result.auditFailures, [BREACH_MESSAGE.slice(2)]);
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

test('a held clone lock fails the check closed before any worktree is created (#4010)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');
  const held = acquireCloneLock(f.work, 'another-session', 60_000);
  t.after(() => releaseCloneLock(held));
  const before = git(f.work, ['worktree', 'list', '--porcelain']);

  const result = runPrePushTrialBudget({ cwd: f.work, lockTimeoutMs: 200 });

  assert.equal(result.outcome, 'clone-lock-unavailable');
  assert.equal(result.exitCode, 1);
  assert.equal(git(f.work, ['worktree', 'list', '--porcelain']), before);
});

test('git runs with the scrubbed environment, and GIT_DIR does not reach it (#4095)', {
  skip: process.platform === 'win32',
}, (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');
  // Resolve the real git before the stub goes on PATH.
  const realGit = spawnSync('sh', ['-c', 'command -v git'], {
    encoding: 'utf8',
  }).stdout.trim();
  const record = join(f.root, 'git-env.jsonl');
  // The stub records the GIT_* variables of each call, then runs the real git.
  const restoreStub = stubExecutable(
    'git',
    `const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = {};
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('GIT_') || key === 'GCM_INTERACTIVE') env[key] = value;
}
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env }) + '\\n');
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit', env: process.env });
process.exitCode = result.status ?? 1;
`,
  );
  t.after(restoreStub);
  // Seed the variables after the fixture, so the fixture's own git is unaffected.
  const seeded = {
    GIT_DIR: join(f.root, 'not-a-repository'),
    GIT_ASKPASS: 'askpass-sentinel',
    GIT_SSH: 'ssh-sentinel',
    GIT_SSH_COMMAND: 'ssh-command-sentinel',
    GIT_SSH_VARIANT: 'ssh-variant-sentinel',
  };
  const saved = Object.fromEntries(
    Object.keys(seeded).map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, seeded);

  const result = runPrePushTrialBudget({ cwd: f.work });

  const recorded = readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { args: string[]; env: Record<string, string> },
    );
  // The clone lock's own `--git-common-dir` probe is not a pre-push git call
  // and does not go through the default runner, so it is not asserted here.
  const calls = recorded.filter(
    (call) => !call.args.includes('--git-common-dir'),
  );
  assert.equal(result.outcome, 'pass');
  assert.ok(calls.length > 0, 'git ran through the stub');
  for (const call of calls) {
    assert.equal(call.env.GIT_DIR, undefined, 'GIT_DIR is removed');
    assert.equal(call.env.GIT_ASKPASS, 'askpass-sentinel');
    assert.equal(call.env.GIT_SSH, 'ssh-sentinel');
    assert.equal(call.env.GIT_SSH_COMMAND, 'ssh-command-sentinel');
    assert.equal(call.env.GIT_SSH_VARIANT, 'ssh-variant-sentinel');
    assert.equal(call.env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(call.env.GCM_INTERACTIVE, 'never');
  }
});

test('a failed add that keeps its registration fails the check closed (#4095)', (t) => {
  const f = behindFixture();
  t.after(() => rmSync(f.root, { recursive: true, force: true }));
  advanceMain(f, 'unrelated.txt', 'main work\n');
  const addedPaths: string[] = [];
  // The add fails, the listing still shows the path, and the removal is refused.
  const refusing: GitRunner = (cwd, args, env) => {
    const at = args.indexOf('worktree');
    if (at < 0) return defaultGitRunner(cwd, args, env);
    const verb = args[at + 1];
    if (verb === 'add') {
      addedPaths.push(args[at + 3] ?? '');
      return { status: 128, stdout: '' };
    }
    if (verb === 'list') {
      const listed = addedPaths.map((path) => `worktree ${path}\n`).join('');
      return { status: 0, stdout: `${listed}\n` };
    }
    if (verb === 'remove') return { status: 1, stdout: '' };
    return defaultGitRunner(cwd, args, env);
  };

  const result = runPrePushTrialBudget({ cwd: f.work, runGit: refusing });

  const [addedPath] = addedPaths;
  if (addedPath === undefined || addedPath === '') {
    assert.fail('the scratch add was attempted');
  }
  // The scratch directory is the parent of the added path. It is kept.
  const scratch = join(addedPath, '..');
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  assert.equal(result.outcome, 'worktree-failed');
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.exitCode, 1);
  assert.equal(existsSync(scratch), true, 'the scratch directory is kept');
});
