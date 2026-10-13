import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addScratchWorktree,
  DEFAULT_KEEP_LIST,
  runGitHooksOff,
  type ScratchWorktreeOptions,
  type ScratchWorktreeResult,
  scrubbedGitEnv,
  type TrialGitRunner,
} from '../src/scripts/trial-scratch.mts';
import { fixtureEnv } from './test-utils.mts';

const GIT_ENV = {
  ...fixtureEnv(),
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

/** A real-git runner, with the same status mapping the helpers use. */
const realGit: TrialGitRunner = (args, cwd, env) => {
  const result = spawnSync('git', [...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
};

/** A repository with one commit, which holds `blocked.txt`. */
function makeRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, ['init', '--quiet', '-b', 'main']);
  writeFileSync(join(repo, 'blocked.txt'), 'blocked\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--quiet', '-m', 'base']);
  return repo;
}

/** The registration children of a repository, tolerating a missing directory. */
function registrationEntries(repo: string): string[] {
  try {
    return readdirSync(join(repo, '.git', 'worktrees'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

interface RecordedCall {
  /** The full argument list the runner received, hooks prefix included. */
  argv: string[];
  /** The git subcommand arguments, without the hooks prefix. */
  git: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** An injected runner whose answers come from `respond`, and which records calls. */
function scripted(
  respond: (git: string[]) => { status: number; stdout: string },
): { run: TrialGitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const run: TrialGitRunner = (args, cwd, env) => {
    const gitArgs = args.slice(2);
    calls.push({ argv: [...args], git: gitArgs, cwd, env });
    return respond(gitArgs);
  };
  return { run, calls };
}

function scratchOptions(root: string, path: string): ScratchWorktreeOptions {
  return {
    cwd: root,
    hooksDir: join(root, 'hooks'),
    path,
    commit: 'abc123',
    env: { MARK: 'injected' },
  };
}

test('scrubbedGitEnv keeps the four credential variables and drops GIT_DIR (#4095)', () => {
  const input: NodeJS.ProcessEnv = {
    PATH: '/bin',
    GIT_DIR: '/elsewhere',
    GIT_WORK_TREE: '/work',
    GIT_INDEX_FILE: '/index',
    GIT_ASKPASS: 'askpass',
    GIT_SSH: 'ssh',
    GIT_SSH_COMMAND: 'ssh -v',
    GIT_SSH_VARIANT: 'ssh',
  };
  const env = scrubbedGitEnv(input);

  assert.deepEqual(
    [...DEFAULT_KEEP_LIST],
    ['GIT_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT'],
  );
  assert.equal(env.GIT_ASKPASS, 'askpass');
  assert.equal(env.GIT_SSH, 'ssh');
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -v');
  assert.equal(env.GIT_SSH_VARIANT, 'ssh');
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_INDEX_FILE, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.PATH, '/bin');
  assert.equal(input.GIT_DIR, '/elsewhere', 'the input is not modified');
});

test('a post-checkout hook does not run under runGitHooksOff (#4095)', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-hook-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root);
  const marker = join(root, 'hook-ran');
  writeFileSync(
    join(repo, '.git', 'hooks', 'post-checkout'),
    `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`,
    { mode: 0o755 },
  );
  const hooksDir = join(root, 'hooks');
  mkdirSync(hooksDir);

  // Control: a plain checkout runs the host hook, so the marker shows it works.
  git(repo, ['checkout', '--quiet', '--detach']);
  assert.equal(existsSync(marker), true, 'the control checkout ran the hook');
  rmSync(marker);

  runGitHooksOff(realGit, ['checkout', '--quiet', '--detach'], {
    cwd: repo,
    hooksDir,
    env: fixtureEnv(),
  });
  assert.equal(existsSync(marker), false, 'the hook did not run');
});

test('a successful add runs one detached add with the hooks prefix (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-ok-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  const { run, calls } = scripted(() => ({ status: 0, stdout: '' }));

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].argv.slice(0, 2), [
    '-c',
    `core.hooksPath=${join(root, 'hooks')}`,
  ]);
  assert.deepEqual(calls[0].git, [
    'worktree',
    'add',
    '--detach',
    path,
    'abc123',
  ]);
  assert.equal(calls[0].env.MARK, 'injected');
});

test('a failed add removes the listed registration, Windows separators included (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-listed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  // The listing prints the path with `\` separators and a trailing separator.
  const listedPath = `${path.replace(/\//g, '\\')}\\`;
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') return { status: 128, stdout: '' };
    if (args[1] === 'list') {
      return { status: 0, stdout: `worktree ${listedPath}\nHEAD abc\n\n` };
    }
    return { status: 0, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: true,
  });
  const removals = calls.filter((call) => call.git[1] === 'remove');
  assert.equal(removals.length, 1);
  assert.deepEqual(removals[0].git, [
    'worktree',
    'remove',
    '--force',
    '--',
    listedPath,
  ]);
  assert.equal(
    calls.some((call) => call.git.includes('prune')),
    false,
    'worktree prune is never run',
  );
});

test('a listing that spells the path through its real parent still matches (#4095)', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-symlink-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  const link = join(root, 'link');
  mkdirSync(real);
  symlinkSync(real, link);
  // The scratch path goes through the symlink, but git lists the resolved path.
  const path = join(link, 'trial');
  const listedPath = join(realpathSync(real), 'trial');
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') return { status: 128, stdout: '' };
    if (args[1] === 'list') {
      return { status: 0, stdout: `worktree ${listedPath}\n\n` };
    }
    return { status: 0, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: true,
  });
  const removals = calls.filter((call) => call.git[1] === 'remove');
  assert.equal(removals.length, 1, 'the listed registration is removed');
  assert.deepEqual(removals[0].git, [
    'worktree',
    'remove',
    '--force',
    '--',
    listedPath,
  ]);
});

test('a failed removal reports registrationRemoved false (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-refused-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') return { status: 128, stdout: '' };
    if (args[1] === 'list') {
      return { status: 0, stdout: `worktree ${path}\n\n` };
    }
    return { status: 1, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: false,
  });
  assert.equal(
    calls.filter((call) => call.git[1] === 'remove').length,
    1,
    'the removal was attempted once',
  );
});

test('a failed listing runs no removal and reports registrationRemoved false (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-listing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') return { status: 128, stdout: '' };
    return { status: 128, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: false,
  });
  assert.equal(
    calls.some((call) => call.git[1] === 'remove'),
    false,
    'no removal runs when the listing fails',
  );
});

test('a listing without the path after a failed add reports registrationRemoved true (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') return { status: 128, stdout: '' };
    if (args[1] === 'list') {
      return { status: 0, stdout: 'worktree /elsewhere/other\n\n' };
    }
    return { status: 0, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: true,
  });
  assert.equal(
    calls.some((call) => call.git[1] === 'remove'),
    false,
    'no removal runs when the path is not listed',
  );
});

test('a path the failed add left as a directory is removed (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-leftover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  const { run } = scripted((args) => {
    if (args[1] === 'add') {
      // A partial checkout: a directory with content, which git left behind.
      mkdirSync(join(path, 'sub'), { recursive: true });
      writeFileSync(join(path, 'sub', 'file.txt'), 'partial\n');
      return { status: 128, stdout: '' };
    }
    return { status: 0, stdout: '' };
  });

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.equal(result.ok, false);
  assert.equal(existsSync(path), false, 'the leftover directory is removed');
});

test('a leftover that cannot be removed fails closed without a listing (#4095)', {
  // Root ignores directory permissions, so this branch is not covered as root.
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-stuck-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = join(root, 'parent');
  mkdirSync(parent);
  const path = join(parent, 'trial');
  const { run, calls } = scripted((args) => {
    if (args[1] === 'add') {
      // A partial checkout, then a parent that refuses the removal of its child.
      mkdirSync(path);
      writeFileSync(join(path, 'partial.txt'), 'partial\n');
      chmodSync(parent, 0o500);
      return { status: 128, stdout: '' };
    }
    return { status: 0, stdout: '' };
  });
  let result: ScratchWorktreeResult;
  try {
    result = addScratchWorktree(run, scratchOptions(root, path));
  } finally {
    chmodSync(parent, 0o700);
  }

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: false,
  });
  assert.equal(
    calls.some((call) => call.git[1] === 'list'),
    false,
    'no listing runs once the leftover could not be removed',
  );
});

test('an existing path is refused with no git call and is left in place (#4095)', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-existing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  mkdirSync(path);
  writeFileSync(join(path, 'keep.txt'), 'keep\n');
  const { run, calls } = scripted(() => ({ status: 0, stdout: '' }));

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: false,
  });
  assert.equal(calls.length, 0, 'no git call is made');
  assert.equal(existsSync(join(path, 'keep.txt')), true, 'the path is kept');
});

test('a dangling symlink at the path is refused with no git call (#4095)', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-dangling-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'trial');
  symlinkSync(join(root, 'missing-target'), path);
  const { run, calls } = scripted(() => ({ status: 0, stdout: '' }));

  const result = addScratchWorktree(run, scratchOptions(root, path));

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: false,
  });
  assert.equal(calls.length, 0, 'no git call is made');
  assert.equal(lstatSync(path).isSymbolicLink(), true, 'the symlink is kept');
});

test('a smudge filter that fails the add leaves no registration (#4095)', {
  skip: process.platform === 'win32',
}, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'trial-scratch-smudge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root);
  // The filter is set only after the commit, so the commit above is unaffected.
  mkdirSync(join(repo, '.git', 'info'), { recursive: true });
  writeFileSync(
    join(repo, '.git', 'info', 'attributes'),
    'blocked.txt filter=trial-block\n',
  );
  git(repo, ['config', 'filter.trial-block.smudge', 'false']);
  git(repo, ['config', 'filter.trial-block.required', 'true']);
  const hooksDir = join(root, 'hooks');
  mkdirSync(hooksDir);
  const path = join(root, 'trial');

  const result = addScratchWorktree(realGit, {
    cwd: repo,
    hooksDir,
    path,
    commit: 'HEAD',
    env: fixtureEnv(),
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved: true,
  });
  assert.equal(existsSync(path), false, 'no worktree path is left');
  assert.deepEqual(
    registrationEntries(repo),
    [],
    'no .git/worktrees child entry is left',
  );
  assert.equal(
    git(repo, ['worktree', 'list', '--porcelain']).includes(`worktree ${path}`),
    false,
    'no porcelain entry remains for the path',
  );
});
