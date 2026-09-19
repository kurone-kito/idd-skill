import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

function stubWorktreeList(output: string): typeof execFileSync {
  return ((file: string, args: string[]) => {
    assert.equal(file, 'git');
    assert.deepEqual(args, ['worktree', 'list', '--porcelain', '-z']);
    return output;
  }) as typeof execFileSync;
}

function stubGitCommands(
  worktreePath: string,
  gitPaths: Record<string, string>,
): typeof execFileSync {
  return ((file: string, args: string[]) => {
    assert.equal(file, 'git');
    assert.deepEqual(args.slice(0, 3), ['-C', worktreePath, 'rev-parse']);
    if (args[3] === '--show-toplevel') {
      return `${worktreePath}\n`;
    }
    assert.equal(args[3], '--git-path');
    const path = gitPaths[args[4] ?? ''];
    assert.ok(path, `missing git path for ${args[4] ?? '<empty>'}`);
    return path;
  }) as typeof execFileSync;
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

test('inspects occupied, absent, and present-prunable worktree results', () => {
  const prunablePath = mkdtempSync(`${tmpdir()}/idd-local-worktree-prunable-`);
  try {
    const occupied = inspectLocalWorktreeBranch(
      'refs/heads/issue/42-task',
      process.cwd(),
      process.env,
      stubWorktreeList(
        'worktree /tmp/occupied\0HEAD abc\0branch refs/heads/issue/42-task\0\0',
      ),
    );
    assert.deepEqual(occupied, {
      status: 'occupied',
      paths: ['/tmp/occupied'],
      reason: 'matching local worktree for issue/42-task',
    });

    const absent = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      stubWorktreeList(
        'worktree /tmp/main\0HEAD def\0branch refs/heads/main\0\0',
      ),
    );
    assert.deepEqual(absent, {
      status: 'absent',
      paths: [],
      reason: null,
    });

    const presentPrunable = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      stubWorktreeList(
        `worktree ${prunablePath}\0HEAD ghi\0branch refs/heads/issue/42-task\0prunable gitdir file\0\0`,
      ),
    );
    assert.equal(presentPrunable.status, 'unreadable');
    assert.deepEqual(presentPrunable.paths, [prunablePath]);

    const unrelatedPresentPrunable = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      stubWorktreeList(
        `worktree ${prunablePath}\0HEAD ghi\0branch refs/heads/issue/7-old\0prunable gitdir file\0\0`,
      ),
    );
    assert.deepEqual(unrelatedPresentPrunable, {
      status: 'absent',
      paths: [],
      reason: null,
    });
  } finally {
    rmSync(prunablePath, { recursive: true, force: true });
  }
});

test('ignores ambient git repository overrides while checking occupancy', () => {
  const primary = realpathSync(
    mkdtempSync(`${tmpdir()}/idd-local-worktree-primary-`),
  );
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

test('fails closed for an active bisect in a detached worktree', () => {
  const worktree = mkdtempSync(`${tmpdir()}/idd-local-worktree-bisect-`);
  const gitDirectory = mkdtempSync(`${tmpdir()}/idd-local-git-dir-`);
  try {
    writeFileSync(join(gitDirectory, 'BISECT_START'), 'issue/42-task\n');
    const result = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        return stubGitCommands(worktree, {
          'rebase-merge': join(gitDirectory, 'rebase-merge'),
          'rebase-apply': join(gitDirectory, 'rebase-apply'),
          BISECT_START: join(gitDirectory, 'BISECT_START'),
        })(file, args);
      }) as typeof execFileSync,
    );
    assert.equal(result.status, 'occupied');
    assert.deepEqual(result.paths, [worktree]);

    writeFileSync(join(gitDirectory, 'BISECT_START'), 'issue/7-old\n');
    const unrelated = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        return stubGitCommands(worktree, {
          'rebase-merge': join(gitDirectory, 'rebase-merge'),
          'rebase-apply': join(gitDirectory, 'rebase-apply'),
          BISECT_START: join(gitDirectory, 'BISECT_START'),
        })(file, args);
      }) as typeof execFileSync,
    );
    assert.deepEqual(unrelated, {
      status: 'absent',
      paths: [],
      reason: null,
    });
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(gitDirectory, { recursive: true, force: true });
  }
});

test('fails closed when detached sequencer head-name is empty', () => {
  const worktree = mkdtempSync(`${tmpdir()}/idd-local-worktree-empty-head-`);
  const gitDirectory = mkdtempSync(`${tmpdir()}/idd-local-git-dir-`);
  try {
    mkdirSync(join(gitDirectory, 'rebase-merge'));
    writeFileSync(join(gitDirectory, 'rebase-merge', 'head-name'), '\n');
    const result = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        return stubGitCommands(worktree, {
          'rebase-merge': join(gitDirectory, 'rebase-merge'),
          'rebase-apply': join(gitDirectory, 'rebase-apply'),
          BISECT_START: join(gitDirectory, 'BISECT_START'),
        })(file, args);
      }) as typeof execFileSync,
    );
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.paths, [worktree]);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(gitDirectory, { recursive: true, force: true });
  }
});

test('fails closed when detached sequencer head-name is malformed', () => {
  const worktree = mkdtempSync(`${tmpdir()}/idd-local-worktree-bad-head-`);
  const gitDirectory = mkdtempSync(`${tmpdir()}/idd-local-git-dir-`);
  try {
    mkdirSync(join(gitDirectory, 'rebase-merge'));
    writeFileSync(
      join(gitDirectory, 'rebase-merge', 'head-name'),
      'refs/tags/issue/42-task\n',
    );
    const result = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        return stubGitCommands(worktree, {
          'rebase-merge': join(gitDirectory, 'rebase-merge'),
          'rebase-apply': join(gitDirectory, 'rebase-apply'),
          BISECT_START: join(gitDirectory, 'BISECT_START'),
        })(file, args);
      }) as typeof execFileSync,
    );
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.paths, [worktree]);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(gitDirectory, { recursive: true, force: true });
  }
});

test('fails closed when detached sequencer head-name is Git metadata text', () => {
  const worktree = mkdtempSync(`${tmpdir()}/idd-local-worktree-detached-head-`);
  const gitDirectory = mkdtempSync(`${tmpdir()}/idd-local-git-dir-`);
  try {
    mkdirSync(join(gitDirectory, 'rebase-merge'));
    writeFileSync(
      join(gitDirectory, 'rebase-merge', 'head-name'),
      'detached HEAD\n',
    );
    const result = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        return stubGitCommands(worktree, {
          'rebase-merge': join(gitDirectory, 'rebase-merge'),
          'rebase-apply': join(gitDirectory, 'rebase-apply'),
          BISECT_START: join(gitDirectory, 'BISECT_START'),
        })(file, args);
      }) as typeof execFileSync,
    );
    assert.equal(result.status, 'unreadable');
    assert.deepEqual(result.paths, [worktree]);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
    rmSync(gitDirectory, { recursive: true, force: true });
  }
});

test('fails closed when detached metadata resolves an enclosing repository', () => {
  const enclosing = mkdtempSync(`${tmpdir()}/idd-local-worktree-enclosing-`);
  const worktree = join(enclosing, 'nested-worktree');
  mkdirSync(worktree);
  try {
    const result = inspectLocalWorktreeBranch(
      'issue/42-task',
      process.cwd(),
      process.env,
      ((file: string, args: string[]) => {
        assert.equal(file, 'git');
        if (args[0] === 'worktree') {
          return `worktree ${worktree}\0HEAD abc\0detached\0\0`;
        }
        assert.deepEqual(args, [
          '-C',
          worktree,
          'rev-parse',
          '--show-toplevel',
        ]);
        return `${enclosing}\n`;
      }) as typeof execFileSync,
    );
    assert.deepEqual(result, {
      status: 'unreadable',
      paths: [worktree],
      reason: 'cannot inspect matching local worktree metadata',
    });
  } finally {
    rmSync(enclosing, { recursive: true, force: true });
  }
});
