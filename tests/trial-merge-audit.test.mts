import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  acquireCloneLock,
  releaseCloneLock,
} from '../src/scripts/clone-lock.mts';
import {
  isToolingPath,
  runTrialMergeAudit,
  type TrialMergeAuditDeps,
} from '../src/scripts/trial-merge-audit.mts';
import { stubExecutable } from './test-utils.mts';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : devNull,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
  }).trim();
}

function write(root: string, path: string, body: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

const createdRoots: string[] = [];

after(() => {
  for (const root of createdRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  work: string;
  remote: string;
  headSha: string;
  baseSha: string;
}

/**
 * A bare remote plus a working clone. `main` holds the base tip, `feature`
 * holds the PR head, and `refs/pull/1/head` names the head, as GitHub does.
 * Base advances after the branch point, so the merge is a real three-way
 * merge.
 */
function makeFixture(
  options: { featureChanges?: Record<string, string>; conflict?: boolean } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'trial-merge-audit-test-'));
  createdRoots.push(root);
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, ['init', '--bare', '--quiet', remote]);
  mkdirSync(work);
  git(work, ['init', '--quiet', '-b', 'main']);
  git(work, ['remote', 'add', 'origin', 'https://github.com/o/r.git']);
  git(work, [
    'config',
    `url.${remote}.insteadOf`,
    'https://github.com/o/r.git',
  ]);
  write(
    work,
    'package.json',
    '{"scripts":{"typecheck":"node -e \\"process.exit(0)\\""}}\n',
  );
  write(work, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
  write(work, 'scripts/audit-docs.mjs', '// exit 0\n');
  write(work, 'scripts/sync-docs.mjs', '// exit 0\n');
  write(work, 'docs/shared.md', 'shared base\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'base']);
  git(work, ['checkout', '--quiet', '-b', 'feature']);
  for (const [path, body] of Object.entries(
    options.featureChanges ?? { 'docs/feature.md': 'feature\n' },
  )) {
    write(work, path, body);
  }
  if (options.conflict) write(work, 'docs/shared.md', 'feature edit\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'feature']);
  const headSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['checkout', '--quiet', 'main']);
  write(work, 'docs/base-only.md', 'base advanced\n');
  if (options.conflict) write(work, 'docs/shared.md', 'base edit\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '--quiet', '-m', 'base advances']);
  const baseSha = git(work, ['rev-parse', 'HEAD']);
  git(work, ['push', '--quiet', 'origin', 'main', 'feature']);
  git(work, ['push', '--quiet', 'origin', `${headSha}:refs/pull/1/head`]);
  return { root, work, remote, headSha, baseSha };
}

function stubPr(fixture: Fixture): NonNullable<TrialMergeAuditDeps['readPr']> {
  return () => ({
    headRefOid: fixture.headSha,
    baseRefOid: fixture.baseSha,
    baseRefName: 'main',
  });
}

/** Install stub that creates a real node_modules directory, never a link. */
const realInstall: NonNullable<TrialMergeAuditDeps['runInstall']> = (cwd) => {
  mkdirSync(join(cwd, 'node_modules'));
  return { exitCode: 0 };
};

test('isToolingPath names the overlay set and nothing else', () => {
  for (const path of [
    'scripts/audit-docs.mjs',
    'src/scripts/x.mts',
    'bin/idd-x.mjs',
    'schemas/x.schema.json',
    'audit/sync-manifest.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'tsconfig.json',
    'tsconfig.build.json',
    '.pnpmfile.cjs',
    '.github/idd/config.json',
    '.husky/pre-commit',
  ]) {
    assert.equal(isToolingPath(path), true, path);
  }
  for (const path of [
    'docs/a.md',
    'tests/a.test.mts',
    'idd-template/x.md',
    'packages/x/tsconfig.json',
  ]) {
    assert.equal(isToolingPath(path), false, path);
  }
});

test('passed: merged tree under base tooling, no ref moved, no push', () => {
  const fixture = makeFixture();
  const refsBefore = git(fixture.work, ['ls-remote', 'origin']);
  const seen: string[][] = [];
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: realInstall,
    runCommand: (argv) => {
      seen.push(argv);
      return { exitCode: 0 };
    },
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'passed');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.prHeadSha, fixture.headSha);
  assert.equal(result.baseSha, fixture.baseSha);
  assert.match(result.trialCommit ?? '', /^[0-9a-f]{40}$/);
  assert.deepEqual(result.toolingChanged, []);
  assert.equal(result.worktreeRemoved, true);
  assert.deepEqual(
    result.commands.map((command) => command.id),
    ['audit-docs', 'sync-docs', 'typecheck'],
  );
  assert.ok(result.commands.every((command) => command.passed));
  assert.equal(
    seen.some((argv) => argv.includes('push')),
    false,
  );
  assert.equal(git(fixture.work, ['ls-remote', 'origin']), refsBefore);
  assert.equal(git(fixture.work, ['rev-parse', 'HEAD']), fixture.baseSha);
});

test('tooling-changed: base tip copy runs, verdict is not-run, change is listed', () => {
  const fixture = makeFixture({
    featureChanges: {
      'scripts/audit-docs.mjs': '// exit 1 on the PR side\n',
      'docs/feature.md': 'feature\n',
    },
  });
  const executed: string[] = [];
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: realInstall,
    runCommand: (argv, cwd) => {
      if (argv[1] === 'scripts/audit-docs.mjs') {
        executed.push(
          readFileSync(join(cwd, 'scripts/audit-docs.mjs'), 'utf8'),
        );
      }
      return { exitCode: 0 };
    },
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'not-run');
  assert.deepEqual(result.reasons, ['tooling-changed']);
  assert.deepEqual(result.toolingChanged, ['scripts/audit-docs.mjs']);
  assert.equal(executed[0], '// exit 0\n');
  assert.ok(result.commands.length > 0);
});

test('content-conflict: no install and no commands, trial commit absent', () => {
  const fixture = makeFixture({ conflict: true, featureChanges: {} });
  let installed = false;
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: () => {
      installed = true;
      return { exitCode: 0 };
    },
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'not-run');
  assert.deepEqual(result.reasons, ['content-conflict']);
  assert.equal(result.trialCommit, null);
  assert.deepEqual(result.commands, []);
  assert.equal(installed, false);
});

test('install-failed: verdict not-run with the install exit code', () => {
  const fixture = makeFixture();
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: () => ({ exitCode: 1 }),
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'not-run');
  assert.deepEqual(result.reasons, ['install-failed']);
  assert.deepEqual(result.install, { exitCode: 1, passed: false });
  assert.equal(result.worktreeRemoved, true);
});

test('failed: a command failure on the merged content gives failed', () => {
  const fixture = makeFixture();
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: realInstall,
    runCommand: (argv) => ({
      exitCode: argv[1] === 'scripts/sync-docs.mjs' ? 1 : 0,
    }),
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'failed');
  assert.deepEqual(result.reasons, ['command-failed']);
  assert.equal(
    result.commands.find((command) => command.id === 'sync-docs')?.passed,
    false,
  );
});

test('a command whose script is absent on the base tip counts as failed', () => {
  // The script is removed from the base tip and from the PR head.
  const fixture = makeFixture();
  git(fixture.work, ['checkout', '--quiet', 'feature']);
  git(fixture.work, ['rm', '--quiet', 'scripts/sync-docs.mjs']);
  git(fixture.work, ['commit', '--quiet', '-m', 'drop sync-docs on head']);
  const headSha = git(fixture.work, ['rev-parse', 'HEAD']);
  git(fixture.work, [
    'push',
    '--quiet',
    'origin',
    `${headSha}:refs/pull/1/head`,
    '--force',
  ]);
  git(fixture.work, ['checkout', '--quiet', 'main']);
  git(fixture.work, ['rm', '--quiet', 'scripts/sync-docs.mjs']);
  git(fixture.work, ['commit', '--quiet', '-m', 'drop sync-docs on base']);
  const baseSha = git(fixture.work, ['rev-parse', 'HEAD']);
  git(fixture.work, ['push', '--quiet', 'origin', 'main']);
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: () => ({
      headRefOid: headSha,
      baseRefOid: baseSha,
      baseRefName: 'main',
    }),
    runInstall: realInstall,
    runCommand: () => ({ exitCode: 0 }),
    lockTimeoutMs: 2000,
  });
  const sync = result.commands.find((command) => command.id === 'sync-docs');
  assert.equal(sync?.passed, false);
  assert.equal(sync?.exitCode, null);
  // The PR deletes the script relative to its merge base, so the tooling change
  // is reported and the verdict is not-run, while the absent command still fails.
  assert.deepEqual(result.toolingChanged, ['scripts/sync-docs.mjs']);
  assert.equal(result.verdict, 'not-run');
  assert.deepEqual(result.reasons, ['tooling-changed']);
});

test('clone lock held by another session: not-run, and no worktree is added', () => {
  const fixture = makeFixture();
  const worktreesBefore = git(fixture.work, [
    'worktree',
    'list',
    '--porcelain',
  ]);
  const holder = acquireCloneLock(fixture.work, 'other-session', 2000);
  try {
    const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
      readPr: stubPr(fixture),
      runInstall: realInstall,
      lockTimeoutMs: 50,
    });
    assert.equal(result.verdict, 'not-run');
    assert.deepEqual(result.reasons, ['clone-lock-unavailable']);
  } finally {
    releaseCloneLock(holder);
  }
  assert.equal(
    git(fixture.work, ['worktree', 'list', '--porcelain']),
    worktreesBefore,
  );
});

test('worktree records are unchanged after a successful run and after an install failure', () => {
  const fixture = makeFixture();
  const before = git(fixture.work, ['worktree', 'list', '--porcelain']);
  runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: realInstall,
    runCommand: () => ({ exitCode: 0 }),
    lockTimeoutMs: 2000,
  });
  assert.equal(git(fixture.work, ['worktree', 'list', '--porcelain']), before);
  runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: stubPr(fixture),
    runInstall: () => ({ exitCode: 1 }),
    lockTimeoutMs: 2000,
  });
  assert.equal(git(fixture.work, ['worktree', 'list', '--porcelain']), before);
});

test('CLI: --help prints usage and a missing --pr is a usage error', () => {
  const help = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/isolate-state.mts',
      'src/scripts/trial-merge-audit.mts',
      '--help',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /trial-merge-audit\.mjs --pr <number>/);
  const missing = spawnSync(
    process.execPath,
    [
      '--import',
      './tests/isolate-state.mts',
      'src/scripts/trial-merge-audit.mts',
    ],
    { encoding: 'utf8' },
  );
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing required --pr/);
});

test('pr-moved: a PR whose tip changed during the lock wait is not-run', () => {
  const fixture = makeFixture();
  let calls = 0;
  const result = runTrialMergeAudit(fixture.work, '1', 'o', 'r', {
    readPr: () => {
      calls += 1;
      return {
        headRefOid: fixture.headSha,
        baseRefOid: calls === 1 ? fixture.baseSha : fixture.headSha,
        baseRefName: 'main',
      };
    },
    runInstall: realInstall,
    lockTimeoutMs: 2000,
  });
  assert.equal(result.verdict, 'not-run');
  assert.deepEqual(result.reasons, ['pr-moved']);
  assert.equal(result.trialCommit, null);
});

test('CLI: a successful run prints one JSON verdict with the fixed commands', {
  skip: process.platform === 'win32',
}, () => {
  const fixture = makeFixture();
  const payload = JSON.stringify({
    headRefOid: fixture.headSha,
    baseRefOid: fixture.baseSha,
    baseRefName: 'main',
  });
  const restoreGh = stubExecutable(
    'gh',
    `process.stdout.write(${JSON.stringify(payload)});`,
  );
  const restorePnpm = stubExecutable('pnpm', 'process.exit(0);');
  try {
    const run = spawnSync(
      process.execPath,
      [
        '--import',
        join(process.cwd(), 'tests/isolate-state.mts'),
        join(process.cwd(), 'src/scripts/trial-merge-audit.mts'),
        '--pr',
        '1',
        '--owner',
        'o',
        '--repo',
        'r',
      ],
      { cwd: fixture.work, encoding: 'utf8', env: process.env },
    );
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout) as {
      verdict: string;
      prHeadSha: string;
      baseSha: string;
      commands: unknown[];
    };
    assert.equal(out.verdict, 'passed');
    assert.equal(out.prHeadSha, fixture.headSha);
    assert.equal(out.baseSha, fixture.baseSha);
    assert.equal(out.commands.length, 3);
  } finally {
    restorePnpm();
    restoreGh();
  }
});
