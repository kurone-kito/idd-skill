import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
  readGeneratedClaimTokens,
  recordGeneratedClaimTokens,
  resolveClaimLockPath,
  resolveGeneratedTokensPath,
} from '../src/scripts/claim-lock.mts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/claim-lock.mjs');

// A git-config-file-safe null-device path. `node:os`'s `devNull` is the
// Win32 device-namespace form (`\\.\nul`) on win32, which Git for Windows
// cannot open as a GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM value (`fatal:
// unable to access '//./nul': Invalid argument`); the bare `'NUL'` device
// name is the form git itself accepts there. POSIX is unaffected -- devNull
// there is already `/dev/null`. See kurone-kito/idd-skill#2570.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

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
  env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
  env.GIT_CONFIG_SYSTEM = GIT_NULL_DEVICE;
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
  writeFileSync(join(primary, 'seed.txt'), 'seed\n');
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
    chmodSync(path, 0o444);
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
    // Read-only reacquisition must not rewrite or recreate the file. The
    // mode, mtime, and ctime remain unchanged across platforms; a
    // destructive unlink/recreate would reset at least the mode and ctime.
    assert.equal(after.mode & 0o777, before.mode & 0o777);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
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

test('CLI: acquire collision exits non-zero after printing the collision outcome', async () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');

    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        '--acquire',
        '--worktree',
        fixture.worktree,
        '--agent-id',
        'agent-b',
        '--claim-id',
        'claim-b',
      ]),
      (error: NodeJS.ErrnoException & { stdout?: string }) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout ?? '').mode, 'collision');
        return true;
      },
    );
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

test('check/acquire: an unreadable lock path is a malformed collision', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    mkdirSync(path);

    const check = checkClaimLock(fixture.worktree);
    assert.equal(check.present, true);
    assert.equal(check.malformed, true);
    assert.equal(check.holder, undefined);

    const collision = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      false,
    );
    assert.equal(collision.mode, 'collision');
    assert.equal(collision.holder, undefined);
  } finally {
    teardown(fixture);
  }
});

test('acquire: authorized takeover replaces a malformed lock directory', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    mkdirSync(path);
    writeFileSync(join(path, 'unexpected-entry'), 'not a lock');

    const takeover = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      true,
    );
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.forcedTakeover, true);
    assert.equal(existsSync(join(path, 'unexpected-entry')), false);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).claimId, 'claim-b');
  } finally {
    teardown(fixture);
  }
});

test('acquire: authorized takeover replaces a malformed lock file', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveClaimLockPath(fixture.worktree);
    writeFileSync(path, 'not a lock');

    const takeover = acquireClaimLock(
      fixture.worktree,
      'agent-b',
      'claim-b',
      true,
    );
    assert.equal(takeover.mode, 'acquired');
    assert.equal(takeover.forcedTakeover, true);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).claimId, 'claim-b');
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

// Generated-tokens record tests (#2719).

test('generated-tokens: record/read round trip reports the recorded fields', () => {
  const fixture = setupLinkedWorktree();
  try {
    const written = recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
      nonce: 'nonce-a',
    });
    assert.equal(
      basename(written.path).startsWith('idd-generated-tokens-'),
      true,
    );

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'present');
    assert.equal(read.status === 'present' && read.record.agentId, 'agent-a');
    assert.equal(read.status === 'present' && read.record.claimId, 'claim-a');
    assert.equal(read.status === 'present' && read.record.nonce, 'nonce-a');
    assert.equal(read.path, written.path);
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: a never-recorded claim-id reads absent, never treated as owned', () => {
  const fixture = setupLinkedWorktree();
  try {
    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
    });

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-b');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: a malformed record file reads malformed, never silently absent', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveGeneratedTokensPath(fixture.worktree, 'claim-a');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'not json at all {{{');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'malformed');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: a record whose internal claim-id disagrees with the requested one reads malformed', () => {
  const fixture = setupLinkedWorktree();
  try {
    // Simulate a tampered/collided file: written for "claim-a" but its own
    // internal claimId field names a different claim entirely.
    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
    });
    const path = resolveGeneratedTokensPath(fixture.worktree, 'claim-a');
    writeFileSync(
      path,
      JSON.stringify({
        agentId: 'agent-a',
        claimId: 'claim-other',
        recordedAt: new Date().toISOString(),
      }),
    );

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'malformed');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: re-recording the same claim-id idempotently overwrites (e.g. to add a nonce)', () => {
  const fixture = setupLinkedWorktree();
  try {
    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
    });
    const first = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(first.status === 'present' && first.record.nonce, undefined);

    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
      nonce: 'nonce-a',
    });
    const second = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(second.status === 'present' && second.record.nonce, 'nonce-a');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: recording never deletes a pre-existing directory at the resolved path (regression, #2879 review)', () => {
  const fixture = setupLinkedWorktree();
  try {
    const path = resolveGeneratedTokensPath(fixture.worktree, 'claim-a');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'unrelated-file.txt'), 'do not delete me');

    assert.throws(() =>
      recordGeneratedClaimTokens(fixture.worktree, {
        agentId: 'agent-a',
        claimId: 'claim-a',
      }),
    );

    // The pre-existing directory and its contents must survive untouched —
    // unlike the lock file's authorized-takeover path, plain token
    // recording must never silently delete a directory that happens to
    // occupy the resolved path.
    assert.equal(statSync(path).isDirectory(), true);
    assert.equal(
      readFileSync(join(path, 'unrelated-file.txt'), 'utf8'),
      'do not delete me',
    );
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: primary-worktree admin dir is shared across concurrent "sessions" -- two different claim-ids do not clobber each other there', () => {
  // Exercises the actual A5 pre-B1 scenario the claim-id keying scheme
  // exists for (#2879 review): before the B1 worktree exists, `cwd` for
  // this write is the *primary* worktree, whose admin directory every
  // concurrent session in the clone shares. Uses `fixture.primary`
  // directly, unlike every other case in this file (which exercises the
  // dedicated linked-worktree path).
  const fixture = setupLinkedWorktree();
  try {
    recordGeneratedClaimTokens(fixture.primary, {
      agentId: 'agent-a',
      claimId: 'claim-a',
    });
    recordGeneratedClaimTokens(fixture.primary, {
      agentId: 'agent-b',
      claimId: 'claim-b',
    });

    const readA = readGeneratedClaimTokens(fixture.primary, 'claim-a');
    const readB = readGeneratedClaimTokens(fixture.primary, 'claim-b');
    assert.equal(readA.status === 'present' && readA.record.agentId, 'agent-a');
    assert.equal(readB.status === 'present' && readB.record.agentId, 'agent-b');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: documented limitation -- a --read-tokens hit against the shared primary path is not proof a *different* caller generated it (#2879 review, Codex P1)', () => {
  // This is the documented boundary, not a bug: `readGeneratedClaimTokens`
  // has no process/session identity to check, so any caller resolving the
  // *same* cwd sees the *same* record. The mitigation is procedural (every
  // caller must resolve `--read-tokens` against its own current cwd, never
  // an explicit different worktree's path -- see the "Scope of the
  // ownership proof" header comment) and by the existing GitHub
  // claim-state / branch-collision / worktree-local-lock defenses, not a
  // guarantee this function itself can provide. This test documents that
  // boundary so it cannot silently regress into an unnoticed assumption.
  const fixture = setupLinkedWorktree();
  try {
    // "Session A" records its own claim-id in the shared primary dir.
    recordGeneratedClaimTokens(fixture.primary, {
      agentId: 'agent-a',
      claimId: 'claim-a',
    });

    // "Session B" merely recalls that same claim-id (for example, having
    // read it off a GitHub claimed-by comment) and checks it against the
    // *same shared primary path* -- `readGeneratedClaimTokens` has no way
    // to distinguish this from session A's own genuine self-check.
    const sessionBRead = readGeneratedClaimTokens(fixture.primary, 'claim-a');
    assert.equal(sessionBRead.status, 'present');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: two claim-ids that sanitize to the same string still resolve to different paths', () => {
  const fixture = setupLinkedWorktree();
  try {
    // Both sanitize to "claim_a" under the [A-Za-z0-9._-] allowlist, but the
    // content-hash suffix keeps their resolved paths distinct.
    const pathA = resolveGeneratedTokensPath(fixture.worktree, 'claim:a');
    const pathB = resolveGeneratedTokensPath(fixture.worktree, 'claim/a');
    assert.notEqual(pathA, pathB);

    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim:a',
    });
    // The differently-punctuated claim-id was never recorded, and must not
    // resolve to the same on-disk evidence as "claim:a" above.
    const read = readGeneratedClaimTokens(fixture.worktree, 'claim/a');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: a very long claim-id does not push the filename past NAME_MAX', () => {
  const fixture = setupLinkedWorktree();
  try {
    // Claim-ids are opaque tokens -- forced-handoff recovery can adopt one
    // this process never generated -- so nothing upstream bounds their
    // length. Without truncating the sanitized prefix, this filename would
    // exceed most filesystems' 255-byte NAME_MAX and `--record-tokens`
    // would fail with ENAMETOOLONG, permanently blocking the fail-closed
    // ownership gate for that claim.
    const longClaimId = `claude-idd-thin-c1b296-20260910T130055Z-${'a'.repeat(300)}`;
    const path = resolveGeneratedTokensPath(fixture.worktree, longClaimId);
    assert.ok(
      Buffer.byteLength(basename(path), 'utf8') <= 255,
      `expected the filename to stay under NAME_MAX, got ${Buffer.byteLength(basename(path), 'utf8')} bytes: ${basename(
        path,
      )}`,
    );

    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: longClaimId,
    });
    const read = readGeneratedClaimTokens(fixture.worktree, longClaimId);
    assert.equal(read.status, 'present');
  } finally {
    teardown(fixture);
  }
});

test('generated-tokens: resolveGeneratedTokensPath resolves inside the linked worktree private git-dir, sibling to the lock file', () => {
  const fixture = setupLinkedWorktree();
  try {
    const lockPath = resolveClaimLockPath(fixture.worktree);
    const tokensPath = resolveGeneratedTokensPath(fixture.worktree, 'claim-a');
    assert.equal(join(tokensPath, '..'), join(lockPath, '..'));
    assert.ok(
      tokensPath.split(sep).includes('worktrees'),
      `expected the linked worktree's private admin dir, got: ${tokensPath}`,
    );
  } finally {
    teardown(fixture);
  }
});

test('CLI: --record-tokens then --read-tokens round trip via the compiled CLI', async () => {
  const fixture = setupLinkedWorktree();
  try {
    const recordResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--record-tokens',
      '--worktree',
      fixture.worktree,
      '--agent-id',
      'agent-a',
      '--claim-id',
      'claim-a',
      '--nonce',
      'nonce-a',
    ]);
    const recordOutcome = JSON.parse(recordResult.stdout);
    assert.equal(typeof recordOutcome.path, 'string');

    const readResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--read-tokens',
      '--worktree',
      fixture.worktree,
      '--claim-id',
      'claim-a',
    ]);
    const readOutcome = JSON.parse(readResult.stdout);
    assert.equal(readOutcome.present, true);
    assert.equal(readOutcome.record.agentId, 'agent-a');
    assert.equal(readOutcome.record.claimId, 'claim-a');
    assert.equal(readOutcome.record.nonce, 'nonce-a');

    // A different claim-id was never recorded.
    const readOtherResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--read-tokens',
      '--worktree',
      fixture.worktree,
      '--claim-id',
      'claim-b',
    ]);
    const readOtherOutcome = JSON.parse(readOtherResult.stdout);
    assert.equal(readOtherOutcome.present, false);

    // A corrupt record at the resolved path reads malformed, not absent.
    const malformedPath = resolveGeneratedTokensPath(
      fixture.worktree,
      'claim-c',
    );
    writeFileSync(malformedPath, 'not json at all {{{');
    const readMalformedResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--read-tokens',
      '--worktree',
      fixture.worktree,
      '--claim-id',
      'claim-c',
    ]);
    const readMalformedOutcome = JSON.parse(readMalformedResult.stdout);
    assert.equal(readMalformedOutcome.present, true);
    assert.equal(readMalformedOutcome.malformed, true);
  } finally {
    teardown(fixture);
  }
});
