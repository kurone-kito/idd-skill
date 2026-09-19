import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';

import {
  inspectLocalWorktreeBranch,
  parseLocalWorktreeList,
} from '../src/scripts/local-worktree-occupancy.mts';
import { fixtureEnv } from './test-utils.mts';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: fixtureEnv(), stdio: 'pipe' });
}

test('parses branch, detached, and prunable worktree records', () => {
  const records = parseLocalWorktreeList(
    [
      'worktree /repo/main\0HEAD abc\0branch refs/heads/main\0\0',
      'worktree /repo/rebase\0HEAD def\0detached\0\0',
      'worktree /repo/old\0HEAD ghi\0branch refs/heads/issue/42-task\0prunable gitdir file\0\0',
    ].join(''),
  );

  assert.deepEqual(records, [
    {
      path: '/repo/main',
      branchRef: 'refs/heads/main',
      detached: false,
      prunable: false,
    },
    {
      path: '/repo/rebase',
      branchRef: null,
      detached: true,
      prunable: false,
    },
    {
      path: '/repo/old',
      branchRef: 'refs/heads/issue/42-task',
      detached: false,
      prunable: true,
    },
  ]);
});

test('fails closed when the current directory cannot list worktrees', () => {
  const directory = mkdtempSync(`${tmpdir()}/idd-local-worktree-`);
  try {
    const result = inspectLocalWorktreeBranch('issue/42-task', directory);
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.paths, []);
    assert.equal(typeof result.reason, 'string');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ignores ambient git repository overrides while checking occupancy', () => {
  const primary = mkdtempSync(`${tmpdir()}/idd-local-worktree-primary-`);
  const sentinel = mkdtempSync(`${tmpdir()}/idd-local-worktree-sentinel-`);
  const worktree = join(primary, '..', `${basename(primary)}-issue-42-task`);
  const branch = 'issue/42-task';
  try {
    for (const repository of [primary, sentinel]) {
      git(repository, ['init', '--quiet', '-b', 'main']);
      git(repository, ['config', 'user.email', 'test@example.com']);
      git(repository, ['config', 'user.name', 'Test']);
      writeFileSync(join(repository, 'seed.txt'), 'seed\n');
      git(repository, ['add', 'seed.txt']);
      git(repository, ['commit', '--quiet', '-m', 'seed']);
    }
    git(primary, ['worktree', 'add', '--quiet', '-b', branch, worktree]);

    const poisonedEnvironment = {
      ...process.env,
      GIT_DIR: join(sentinel, '.git'),
      GIT_INDEX_FILE: join(sentinel, '.git', 'index'),
      GIT_WORK_TREE: sentinel,
      GIT_COMMON_DIR: join(sentinel, '.git'),
      GIT_OBJECT_DIRECTORY: join(sentinel, '.git', 'objects'),
    };
    const result = inspectLocalWorktreeBranch(
      branch,
      primary,
      poisonedEnvironment,
    );

    assert.equal(result.status, 'occupied');
    assert.deepEqual(result.paths, [worktree]);
  } finally {
    try {
      git(primary, ['worktree', 'remove', '--force', worktree]);
    } catch {
      // Best-effort cleanup; the recursive removal below is authoritative.
    }
    rmSync(worktree, { recursive: true, force: true });
    rmSync(primary, { recursive: true, force: true });
    rmSync(sentinel, { recursive: true, force: true });
  }
});
