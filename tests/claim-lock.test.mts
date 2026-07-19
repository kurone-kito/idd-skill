import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  acquireClaimLock,
  checkClaimLock,
  resolveClaimLockPath,
} from '../src/scripts/claim-lock.mts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/claim-lock.mjs');

// Fixture invariant mirrored from tests/worktree-guard-hook.test.mts: fixture
// git processes must never read the ambient git environment or the
// developer's config, and must never inherit GIT_DIR/GIT_WORK_TREE from a
// hook or wrapper invoking this suite.
function fixtureEnv(): NodeJS.ProcessEnv {
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

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: fixtureEnv(), stdio: 'pipe' });
}

/**
 * Build a throwaway primary repo plus one linked worktree, so
 * `resolveClaimLockPath` exercises the real `.git`-is-a-file linked-worktree
 * case rather than a plain repo's own `.git` directory.
 */
function setupLinkedWorktree(): { primary: string; worktree: string } {
  const primary = mkdtempSync(join(tmpdir(), 'idd-claim-lock-'));
  git(primary, ['init', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  execFileSync('sh', ['-c', 'echo seed > seed.txt'], {
    cwd: primary,
    env: fixtureEnv(),
  });
  git(primary, ['add', 'seed.txt']);
  git(primary, ['commit', '-m', 'seed']);

  const worktree = join(primary, '..', `${basename(primary)}-wt`);
  git(primary, ['worktree', 'add', worktree, '-b', 'issue/1-test', 'main']);
  return { primary, worktree };
}

function teardown(fixture: { primary: string; worktree: string }): void {
  try {
    git(fixture.primary, ['worktree', 'remove', '--force', fixture.worktree]);
  } catch {
    // best-effort; fall through to rmSync below regardless
  }
  rmSync(fixture.worktree, { recursive: true, force: true });
  rmSync(fixture.primary, { recursive: true, force: true });
}

test('resolveClaimLockPath resolves inside the linked worktree private git-dir, not a literal .git path', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    assert.equal(basename(path), 'idd-claim.lock');
    assert.ok(
      path.split(sep).includes('worktrees'),
      `expected the linked worktree's private admin dir, got: ${path}`,
    );
  } finally {
    teardown(fixture);
  }
});

test('resolveClaimLockPath ignores ambient Git repository override variables', () => {
  const fixture = setupLinkedWorktree();
  const keys = [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
  ] as const;
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = join(fixture.primary, '.git');
    process.env.GIT_INDEX_FILE = join(fixture.primary, '.git', 'index');
    process.env.GIT_WORK_TREE = fixture.primary;
    process.env.GIT_COMMON_DIR = join(fixture.primary, '.git');
    process.env.GIT_OBJECT_DIRECTORY = join(fixture.primary, '.git', 'objects');

    const path = resolveClaimLockPath(fixture.worktree);
    assert.ok(
      path.split(sep).includes('worktrees'),
      `expected the requested worktree's private admin dir, got: ${path}`,
    );
  } finally {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    teardown(fixture);
  }
});

test('acquire: lock-acquired — fresh acquire succeeds with no prior lock', () => {
  const fixture = setupLinkedWorktree();
  try {
    const outcome = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(outcome.mode, 'acquired');
    assert.equal(outcome.reacquired, undefined);
    assert.equal(outcome.forcedTakeover, undefined);

    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.present, true);
    assert.equal(check.holder?.agentId, 'agent-a');
    assert.equal(check.holder?.claimId, 'claim-a');
  } finally {
    teardown(fixture);
  }
});

test('acquire: same claim-id re-acquires purely locally (fast path), confirming without writing', () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    const second = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(second.mode, 'acquired');
    assert.equal(second.reacquired, true);

    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.holder?.claimId, 'claim-a');
  } finally {
    teardown(fixture);
  }
});

test('acquire: a same-claim-id reacquire performs no destructive write — the lock file is never removed or replaced (regression for the Codex-reported unlink-then-create race)', () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    const path = resolveClaimLockPath(fixture.worktree);
    const before = statSync(path);
    const bodyBefore = readFileSync(path, 'utf8');

    const second = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(second.mode, 'acquired');
    assert.equal(second.reacquired, true);

    const after = statSync(path);
    // Same inode means the file was never unlinked/recreated -- a
    // destructive reacquire would allocate a new inode. If the file had
    // been deleted and recreated, a competing session's fresh `wx` create
    // could have raced into the gap; an unchanged inode proves that gap
    // never opened.
    assert.equal(after.ino, before.ino);
    assert.equal(readFileSync(path, 'utf8'), bodyBefore);
  } finally {
    teardown(fixture);
  }
});

test('acquire: lock-collision — a different claim-id is refused without --takeover, regardless of lock age', () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    const collision = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      false,
    );
    assert.equal(collision.mode, 'collision');
    assert.equal(collision.holder?.claimId, 'claim-a');

    // The lock must be unchanged after a refused collision.
    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.holder?.claimId, 'claim-a');
  } finally {
    teardown(fixture);
  }
});

test('acquire: stale-lock (GitHub-authorized) — an explicit --takeover overrides a colliding lock', () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    const takeover = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      true,
    );
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.forcedTakeover, true);
    assert.equal(takeover.holder?.claimId, 'claim-a');

    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.holder?.claimId, 'claim-b');
  } finally {
    teardown(fixture);
  }
});

test('check: reports absence without creating a lock', () => {
  const fixture = setupLinkedWorktree();
  try {
    const before = checkClaimLock(fixture.worktree);
    assert.equal(before.present, false);
    assert.equal(existsSync(before.path), false);
  } finally {
    teardown(fixture);
  }
});

test('acquire: a malformed lock body is treated as a collision, never silently overwritten or skipped as absent', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    writeFileSync(path, 'not json at all {{{');

    const collision = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      false,
    );
    assert.equal(collision.mode, 'collision');
    assert.equal(collision.holder, undefined);

    // Unchanged: still the malformed body, not silently replaced.
    assert.equal(readFileSync(path, 'utf8'), 'not json at all {{{');

    const takeover = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      true,
    );
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.forcedTakeover, true);
  } finally {
    teardown(fixture);
  }
});

test('check: reports a malformed lock body as present+malformed, without throwing', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    writeFileSync(path, '{"unexpected": "shape"}');

    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.present, true);
    assert.equal(check.malformed, true);
    assert.equal(check.holder, undefined);
  } finally {
    teardown(fixture);
  }
});

test('acquire/check: a nonexistent or non-git --worktree path fails loudly rather than silently no-op', () => {
  const missing = join(tmpdir(), `idd-claim-lock-missing-${process.pid}`);
  assert.throws(() => checkClaimLock(missing));
  assert.throws(() => acquireClaimLock(missing, 'agent-a', 'claim-a', false));
});

test('acquire: N concurrent forced-takeovers never corrupt the lock — every writer reports acquired and the final body is exactly one well-formed winner', async () => {
  // This is a statistical health check, not a proof of atomicity: with a
  // small JSON payload, even a non-atomic `writeFileSync` (no `wx`) rarely
  // produces a torn/truncated write in practice, so a single race window
  // alone would not reliably distinguish this implementation from a naive
  // one. Atomicity itself is guaranteed by `overwriteLockAtomically`'s
  // same-directory temp-write + `renameSync` pattern (reviewed in
  // `src/scripts/claim-lock.mts`);
  // this test's job is only to catch a regression that corrupts the file
  // or crashes a concurrent writer, exercised across enough concurrent
  // takeovers to make a genuine interleaving bug likely to surface.
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    const CONCURRENT_TAKEOVERS = 5;
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_TAKEOVERS }, (_, index) =>
        execFileAsync(process.execPath, [
          CLI_PATH,
          '--acquire',
          '--worktree',
          fixture.worktree,
          '--agent-id',
          `agent-${index}`,
          '--claim-id',
          `claim-${index}`,
          '--takeover',
        ]),
      ),
    );

    const outcomes = results.map((result) => JSON.parse(result.stdout));
    for (const outcome of outcomes) {
      assert.equal(outcome.mode, 'acquired');
    }

    const lockPath = resolveClaimLockPath(fixture.worktree);
    const finalBody = JSON.parse(readFileSync(lockPath, 'utf8'));
    const winningClaimIds = Array.from(
      { length: CONCURRENT_TAKEOVERS },
      (_, index) => `claim-${index}`,
    );
    assert.ok(
      winningClaimIds.includes(finalBody.claimId),
      `expected the final lock to record exactly one of the racing claim-ids, got: ${JSON.stringify(finalBody)}`,
    );
  } finally {
    teardown(fixture);
  }
});
