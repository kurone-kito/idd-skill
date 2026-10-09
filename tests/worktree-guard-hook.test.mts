import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fixtureEnv } from './test-utils.mts';

// The hooks under test, shipped at the repository root.
const HOOKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '.githooks',
);
const TEMPLATE_HOOKS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'idd-template',
  '.githooks',
);

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

/**
 * Run a hook script directly and return its exit code. `stdin` is fed to the
 * hook as git would feed pre-push its ref lines; `'closed'` runs the hook with
 * its standard input closed (#3854).
 */
function runHook(
  repo: string,
  hook: string,
  cwd = repo,
  stdin: string | 'closed' = '',
): number {
  try {
    if (stdin === 'closed') {
      // Close the hook's standard input through a wrapper file. An inline
      // `sh -c` payload is one the test isolation layer cannot resolve, so it
      // reports a gh attempt that never happened (#3854).
      const hookPath = join(repo, '.githooks', hook);
      const wrapper = join(repo, '.git', 'close-stdin.sh');
      writeFileSync(wrapper, `sh ${JSON.stringify(hookPath)} <&-\n`);
      execFileSync('sh', [wrapper], {
        cwd,
        env: fixtureEnv(),
        stdio: 'pipe',
      });
    } else {
      execFileSync('sh', [join(repo, '.githooks', hook)], {
        cwd,
        env: fixtureEnv(),
        input: stdin,
        stdio: 'pipe',
      });
    }
    return 0;
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === 'number' ? status : 1;
  }
}

/** Run the sourced guard and report its status and caller's noglob state. */
function runGuardWithNoglobState(
  repo: string,
  initiallyNoglob: boolean,
): { status: number; noglob: boolean } {
  const script = [
    'set +e',
    '. "$1"',
    'idd_worktree_guard_check commit',
    'status=$?',
    'case $- in *f*) noglob=1;; *) noglob=0;; esac',
    'printf "%s %s\\n" "$status" "$noglob"',
  ].join('; ');
  const args = initiallyNoglob ? ['-f', '-c'] : ['-c'];
  args.push(
    script,
    'idd-worktree-guard',
    join(repo, '.githooks', '_idd-worktree-guard.sh'),
  );
  const output = execFileSync('sh', args, {
    cwd: repo,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  const [status, noglob] = output.split(/\s+/).map(Number);
  return { status, noglob: noglob === 1 };
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
function setupRepo(configObj: unknown, hooksSource = HOOKS_DIR): string {
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
  cpSync(hooksSource, join(dir, '.githooks'), { recursive: true });
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

test('root and distributed hooks keep branch globs literal when a matching path exists', () => {
  for (const hooksSource of [HOOKS_DIR, TEMPLATE_HOOKS_DIR]) {
    const repo = setupRepo({ worktreeGuard: { enabled: true } }, hooksSource);
    try {
      mkdirSync(join(repo, 'issue'));
      writeFileSync(join(repo, 'issue', 'template.md'), 'fixture\n');
      git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
      assert.equal(runHook(repo, 'pre-commit'), 1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("hooks preserve the caller's noglob state while matching branch patterns", () => {
  for (const hooksSource of [HOOKS_DIR, TEMPLATE_HOOKS_DIR]) {
    const repo = setupRepo({ worktreeGuard: { enabled: true } }, hooksSource);
    try {
      mkdirSync(join(repo, 'issue'));
      writeFileSync(join(repo, 'issue', 'template.md'), 'fixture\n');
      git(repo, ['checkout', '-q', '-b', 'issue/123-example']);
      assert.deepEqual(runGuardWithNoglobState(repo, false), {
        status: 1,
        noglob: false,
      });
      assert.deepEqual(runGuardWithNoglobState(repo, true), {
        status: 1,
        noglob: true,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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

test('hook blocks a base-branch commit in the primary worktree when refuseBaseBranchCommits is enabled (#2801)', () => {
  const repo = setupRepo({
    worktreeGuard: { enabled: true, refuseBaseBranchCommits: true },
    developmentBranch: 'main',
  });
  try {
    // setupRepo's init commit already leaves HEAD on "main".
    assert.equal(runHook(repo, 'pre-commit'), 1);
    assert.equal(runHook(repo, 'pre-push'), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook leaves base-branch commits allowed when refuseBaseBranchCommits is absent (default off)', () => {
  const repo = setupRepo({
    worktreeGuard: { enabled: true },
    developmentBranch: 'main',
  });
  try {
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook leaves base-branch commits allowed when refuseBaseBranchCommits is true but developmentBranch is unset', () => {
  // developmentBranch absent: the hook has no network access to resolve
  // the live GitHub default branch the way idd-work.instructions.md's
  // B1 does, so this stricter check is documented to no-op rather than
  // guessing.
  const repo = setupRepo({
    worktreeGuard: { enabled: true, refuseBaseBranchCommits: true },
  });
  try {
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook still allows a non-base, non-pattern-matched branch when refuseBaseBranchCommits is enabled', () => {
  const repo = setupRepo({
    worktreeGuard: { enabled: true, refuseBaseBranchCommits: true },
    developmentBranch: 'main',
  });
  try {
    git(repo, ['checkout', '-q', '-b', 'feature-not-guarded']);
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook allows a detached HEAD in the primary worktree when enabled', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  try {
    const head = gitOut(repo, ['rev-parse', 'HEAD']);
    git(repo, ['checkout', '-q', '--detach', head]);
    assert.equal(runHook(repo, 'pre-commit'), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('hook allows an unborn HEAD in the primary worktree when enabled', () => {
  // Deliberately does not use setupRepo: that helper always creates an
  // initial commit, but this case is specifically about a repo with a
  // config file present and no commits at all yet (idd-skill#2068).
  const dir = mkdtempSync(join(tmpdir(), 'idd-hook-unborn-'));
  try {
    git(dir, ['init', '-b', 'issue/123-example']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    mkdirSync(join(dir, '.github/idd'), { recursive: true });
    writeFileSync(
      join(dir, '.github/idd/config.json'),
      JSON.stringify({ worktreeGuard: { enabled: true } }, null, 2),
    );
    cpSync(HOOKS_DIR, join(dir, '.githooks'), { recursive: true });
    assert.equal(runHook(dir, 'pre-commit'), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook is a no-op run from outside any work tree', () => {
  const repo = setupRepo({ worktreeGuard: { enabled: true } });
  const outside = mkdtempSync(join(tmpdir(), 'idd-hook-outside-'));
  try {
    assert.equal(runHook(repo, 'pre-commit', outside), 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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

// Ref lines as git's pre-push passes them on stdin (#3854). Every case runs
// against the repository copy and the distributed template copy of the hook,
// so a template-only regression cannot pass.
const ZERO_SHA = '0'.repeat(40);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const HOOK_COPIES = [
  ['repository', HOOKS_DIR],
  ['distributed template', TEMPLATE_HOOKS_DIR],
] as const;

const GUARDED_CONFIG = {
  worktreeGuard: { enabled: true, refuseBaseBranchCommits: true },
  developmentBranch: 'main',
};

test('refuseBaseBranchCommits allows only deletions of other refs from the base branch in the primary worktree (#3854)', () => {
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const repo = setupRepo(GUARDED_CONFIG, hooksSource);
    try {
      // Deleting a merged feature branch leaves the base branch untouched, so
      // it passes from the base-branch worktree, one ref or several.
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/feature/x ${SHA_A}\n`,
        ),
        0,
        `${copy}: deleting another ref must be allowed`,
      );
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/feature/x ${SHA_A}\n(delete) ${ZERO_SHA} refs/heads/feature/y ${SHA_B}\n`,
        ),
        0,
        `${copy}: deleting several other refs must be allowed`,
      );
      // Creating or updating any ref is refused, a feature ref included.
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `${SHA_B} ${SHA_B} refs/heads/feature/y ${ZERO_SHA}\n`,
        ),
        1,
        `${copy}: creating a feature ref must be refused`,
      );
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/feature/x ${SHA_A}\n${SHA_B} ${SHA_C} refs/heads/feature/y ${SHA_A}\n`,
        ),
        1,
        `${copy}: a mix that updates a feature ref must be refused`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('refuseBaseBranchCommits refuses a push that updates or deletes the base branch (#3854)', () => {
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const repo = setupRepo(GUARDED_CONFIG, hooksSource);
    try {
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `${SHA_B} ${SHA_C} refs/heads/main ${SHA_A}\n`,
        ),
        1,
        `${copy}: updating main must be refused`,
      );
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/main ${SHA_A}\n`,
        ),
        1,
        `${copy}: deleting main must be refused`,
      );
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/feature/x ${SHA_A}\n${SHA_B} ${SHA_C} refs/heads/main ${SHA_A}\n`,
        ),
        1,
        `${copy}: mixed lines that include main must be refused`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('refuseBaseBranchCommits keeps the HEAD-based refusal without ref lines or with stdin closed (#3854)', () => {
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const repo = setupRepo(GUARDED_CONFIG, hooksSource);
    try {
      // An empty stream is what an up-to-date push gives the hook.
      assert.equal(
        runHook(repo, 'pre-push', repo, ''),
        1,
        `${copy}: empty stdin`,
      );
      assert.equal(
        runHook(repo, 'pre-push', repo, 'closed'),
        1,
        `${copy}: closed stdin`,
      );
      assert.equal(runHook(repo, 'pre-commit'), 1, `${copy}: commit`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('refuseBaseBranchCommits off leaves base-branch pushes and commits allowed (#3854)', () => {
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const repo = setupRepo(
      { worktreeGuard: { enabled: true }, developmentBranch: 'main' },
      hooksSource,
    );
    try {
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `${SHA_B} ${SHA_C} refs/heads/main ${SHA_A}\n`,
        ),
        0,
        `${copy}: push with the opt-in off`,
      );
      assert.equal(
        runHook(repo, 'pre-commit'),
        0,
        `${copy}: commit with the opt-in off`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('an accepted deletion passes when developmentBranch also matches branchPatterns (#3854)', () => {
  // issue/main matches the default issue/* pattern, so the implementation-branch
  // check below would refuse anything that reached it.
  const overlapping = {
    worktreeGuard: { enabled: true, refuseBaseBranchCommits: true },
    developmentBranch: 'issue/main',
  };
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const repo = setupRepo(overlapping, hooksSource);
    try {
      git(repo, ['checkout', '-b', 'issue/main']);
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `(delete) ${ZERO_SHA} refs/heads/feature/x ${SHA_A}\n`,
        ),
        0,
        `${copy}: an accepted deletion must pass the pattern check too`,
      );
      assert.equal(
        runHook(
          repo,
          'pre-push',
          repo,
          `${SHA_B} ${SHA_C} refs/heads/issue/main ${SHA_A}\n`,
        ),
        1,
        `${copy}: an update of the development branch must be refused`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('a merged feature branch is deleted from the primary worktree on the base branch, and a base update stays refused (#3854)', () => {
  const helper = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'scripts',
    'delete-remote-branch.mjs',
  );
  for (const [copy, hooksSource] of HOOK_COPIES) {
    const remoteRoot = mkdtempSync(join(tmpdir(), 'idd-hook-remote-'));
    const remote = join(remoteRoot, 'origin.git');
    const repo = setupRepo(GUARDED_CONFIG, hooksSource);
    try {
      git(remoteRoot, ['init', '--bare', '-b', 'main', remote]);
      git(repo, ['remote', 'add', 'origin', remote]);
      git(repo, ['config', 'core.hooksPath', '.githooks']);
      // Publish main and two feature branches with the guard skipped, so the
      // fixture does not depend on the behaviour under test.
      git(repo, ['push', '--no-verify', 'origin', 'main']);
      git(repo, [
        'push',
        '--no-verify',
        'origin',
        'main:refs/heads/feature/merged',
      ]);
      git(repo, [
        'push',
        '--no-verify',
        'origin',
        'main:refs/heads/feature/helper',
      ]);
      const tip = gitOut(repo, ['rev-parse', 'HEAD']);

      // git push --delete from the primary worktree on the base branch.
      git(repo, ['push', 'origin', '--delete', 'feature/merged']);
      assert.equal(
        gitOut(repo, ['ls-remote', '--heads', 'origin', 'feature/merged']),
        '',
        `${copy}: merged feature branch must be gone`,
      );

      // The helper's own deletion path, which F4 step 6 relies on.
      const verdict = JSON.parse(
        execFileSync(
          'node',
          [
            helper,
            '--branch',
            'feature/helper',
            '--expected-sha',
            tip,
            '--apply',
          ],
          { cwd: repo, env: fixtureEnv(), encoding: 'utf8', stdio: 'pipe' },
        ),
      ) as { status: string; action: string };
      assert.equal(verdict.status, 'complete', `${copy}: helper completes`);
      assert.equal(verdict.action, 'deleted', `${copy}: helper deletes`);

      // A real base update from the same worktree is still refused, and the
      // refusal must be the guard's own message, not any failed push.
      writeFileSync(join(repo, 'README.md'), 'changed\n');
      git(repo, ['commit', '--no-verify', '-am', 'local base commit']);
      const refused = spawnSync('git', ['push', 'origin', 'main'], {
        cwd: repo,
        env: fixtureEnv(),
        encoding: 'utf8',
      });
      assert.notEqual(
        refused.status,
        0,
        `${copy}: base update must be refused`,
      );
      assert.match(
        refused.stderr,
        /refusing to push directly on "main"/,
        `${copy}: the refusal must be the guard's own message`,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
    }
  }
});
