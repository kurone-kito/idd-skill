import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The hooks under test, shipped at the repository root.
const HOOKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.githooks',
);

// Fixture invariant: fixture git processes must never read the ambient
// git environment or the developer's config. Hook runs export GIT_DIR /
// GIT_INDEX_FILE (so an unsanitized fixture would mutate the HOST
// repository when this suite runs inside a pre-commit hook), and a
// global config may enable commit signing (stalling fixture commits on
// pinentry). Build the sanitized env per call so tests can poison
// process.env and prove the isolation holds. The GIT_CONFIG_GLOBAL /
// GIT_CONFIG_SYSTEM overrides require git >= 2.32.
function fixtureEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
  return env;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, env: fixtureEnv(), stdio: 'pipe' });
}

/** Run git for assertions and return its trimmed stdout. */
function gitOut(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

/** Run a hook script directly and return its exit code. */
function runHook(repo: string, hook: string, cwd = repo): number {
  try {
    execFileSync('sh', [join(repo, '.githooks', hook)], {
      cwd,
      env: fixtureEnv(),
      stdio: 'pipe',
    });
    return 0;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/** Poison process.env, run the synchronous callback, then restore keys. */
function withPoisonedEnv(
  poison: Record<string, string>,
  callback: () => void,
): void {
  const saved = new Map(
    Object.keys(poison).map((key) => [key, process.env[key]]),
  );
  try {
    Object.assign(process.env, poison);
    callback();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** Create a throwaway git repo carrying the shipped hooks and a config. */
function setupRepo(configObj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'idd-hook-'));
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  mkdirSync(join(dir, '.github/idd'), { recursive: true });
  if (configObj !== null) {
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify(configObj, null, 2),
    );
  }
  cpSync(HOOKS_DIR, join(dir, '.githooks'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'placeholder\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--no-verify', '-m', 'init']);
  return dir;
}

test('hook allows commit and push from the primary worktree on main', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  try {
    assert.equal(runHook(repo, 'pre-commit'), 0);
    assert.equal(runHook(repo, 'pre-push'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook blocks commit and push from the primary worktree on issue/* when enabled', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  try {
    git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
    assert.equal(runHook(repo, 'pre-commit'), 1);
    assert.equal(runHook(repo, 'pre-push'), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook blocks roadmap-audit/* branches in the primary worktree', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  try {
    git(repo, ['checkout', '-q', '-b', 'roadmap-audit/9-example']);
    assert.equal(runHook(repo, 'pre-commit'), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook is a no-op on issue/* when the guard is disabled', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: false } });
  try {
    git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook is a no-op on issue/* when worktreeGuard is absent (default)', () => {
  const repo = setupRepo({ markerPrefix: 'idd-skill' });
  try {
    git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook honors a custom worktreeGuard.branchPatterns override', () => {
  const repo = setupRepo({
    worktreeGuard: { enabled: true, branchPatterns: ['release/*'] },
  });
  try {
    git(repo, ['checkout', '-q', '-b', 'release/1']);
    assert.equal(runHook(repo, 'pre-commit'), 1); // matches the custom glob
    git(repo, ['checkout', '-q', '-b', 'issue/9-example']);
    assert.equal(runHook(repo, 'pre-commit'), 0); // default issue/* no longer applies
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook allows issue/* commits from a sibling worktree', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  const sibling = `${repo}-sibling`;
  try {
    git(repo, ['worktree', 'add', '-q', sibling, '-b', 'issue/123-example']);
    assert.equal(runHook(repo, 'pre-commit', sibling), 0);
  } finally {
    try {
      git(repo, ['worktree', 'remove', '--force', sibling]);
    } catch {
      // best-effort cleanup
    }
    rmSync(repo, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('fixture git operations cannot reach a sentinel repo via inherited env', () => {
  const sentinel = mkdtempSync(join(tmpdir(), 'idd-sentinel-'));
  let repo: string | undefined;
  try {
    git(sentinel, ['init', '-b', 'main']);
    git(sentinel, ['config', 'user.email', 'sentinel@example.com']);
    git(sentinel, ['config', 'user.name', 'Sentinel']);
    writeFileSync(join(sentinel, 'README.md'), 'sentinel\n');
    git(sentinel, ['add', '-A']);
    git(sentinel, ['commit', '--no-verify', '-m', 'sentinel']);
    const headBefore = gitOut(sentinel, ['rev-parse', 'HEAD']);
    const branchesBefore = gitOut(sentinel, ['branch', '--list']);

    withPoisonedEnv(
      {
        GIT_DIR: join(sentinel, '.git'),
        GIT_INDEX_FILE: join(sentinel, '.git', 'index'),
        GIT_WORK_TREE: sentinel,
      },
      () => {
        repo = setupRepo({ worktreeGuard: { enabled: true } });
        git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
        assert.equal(runHook(repo, 'pre-commit'), 1);
      },
    );

    assert.equal(gitOut(sentinel, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(gitOut(sentinel, ['branch', '--list']), branchesBefore);
    assert.equal(gitOut(sentinel, ['status', '--porcelain']), '');
  } finally {
    if (repo) {
      rmSync(repo, { recursive: true, force: true });
    }
    rmSync(sentinel, { recursive: true, force: true });
  }
});

test('fixture commits ignore a signing-enabled global git config', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'idd-gitconfig-'));
  const configPath = join(configDir, 'gitconfig');
  let repo: string | undefined;
  try {
    writeFileSync(
      configPath,
      '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /bin/false\n',
    );

    withPoisonedEnv({ GIT_CONFIG_GLOBAL: configPath }, () => {
      // setupRepo commits succeeding is the no-signing proof: any signing
      // attempt would invoke /bin/false and fail the commit.
      repo = setupRepo({ worktreeGuard: { enabled: true } });
      assert.equal(runHook(repo, 'pre-commit'), 0);
    });
  } finally {
    if (repo) {
      rmSync(repo, { recursive: true, force: true });
    }
    rmSync(configDir, { recursive: true, force: true });
  }
});
