import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

import {
  inspectLocalWorktreeBranch,
  parseLocalWorktreeList,
} from '../src/scripts/local-worktree-occupancy.mts';

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
