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
import { availableParallelism, devNull, tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import {
  acquireClaimLock,
  backfillGeneratedClaimTokens,
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

// Worker-thread payload for the race test below. `eval`-loaded per
// round rather than a separate fixture file, per this suite's existing
// preference for self-contained tests. Deliberately imports the
// *compiled* CLI module (matching the execFileAsync CLI tests
// elsewhere in this file), not the .mts source, since this string is
// handed to Worker's own module loader rather than this file's own
// TypeScript-aware one.
const RACE_WORKER_CODE = `
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs');
  const { worktree, sab, cliUrl } = workerData;
  const ints = new Int32Array(sab);
  // Deterministically widen the fresh-create race window (PR #2923
  // review, Copilot -- a scheduler could otherwise run every acquirer
  // to completion before any reader gets a timeslice, so the readers
  // only prove they saw the stable final file, not the write itself).
  // Intercept any exclusive-create write ({ flag: 'wx' }) this
  // worker's own acquireClaimLock call makes, and yield the CPU for a
  // bounded pause between the file becoming visible (open) and its
  // content finishing (write) -- long enough that a busy-spinning
  // reader on another OS thread is virtually guaranteed to be
  // scheduled during it, on any host including a constrained CI
  // runner. This turns "readers probably sample the window" into
  // "readers provably do," entirely test-side: the patch lives only
  // in this worker's own module registry, propagated from the CJS
  // \`fs\` export object to the compiled CLI module's ESM named
  // import of the same function via node:module's
  // syncBuiltinESMExports (a documented Node mechanism for exactly
  // this). A production-code injection hook was considered instead
  // and rejected as its own reviewable surface for a single test; this
  // needs none.
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (path, data, opts) => {
    if (!opts || opts.flag !== 'wx') {
      return originalWriteFileSync(path, data, opts);
    }
    const fd = fs.openSync(path, 'wx');
    Atomics.add(ints, 4, 1);
    try {
      // ints[5] is never written elsewhere, so this always times out --
      // a bounded, scheduler-yielding pause, not a real wait for a
      // signal.
      Atomics.wait(ints, 5, 0, 20);
    } finally {
      Atomics.sub(ints, 4, 1);
    }
    fs.writeSync(fd, data);
    fs.closeSync(fd);
  };
  require('node:module').syncBuiltinESMExports();
  import(cliUrl).then(({ acquireClaimLock }) => {
    // Signal ready, then block until the main thread releases every
    // worker in this round at (as close to) the same instant.
    Atomics.add(ints, 0, 1);
    Atomics.wait(ints, 1, 0);
    const outcome = acquireClaimLock(worktree, 'agent-a', 'claim-a', false);
    parentPort.postMessage(outcome);
  });
`;

// Reader-thread payload for the same race test: a pure `readFileSync`
// spinner with no `acquireClaimLock` call and therefore no internal
// `execFileSync('git', ...)` spawn (PR #2923 review, Copilot). The
// acquirer race window would otherwise be microseconds wide, and
// process-spawn overhead inside `acquireClaimLock` itself can serialize
// the acquirer workers past it on some hosts (observed: 0/7
// reproductions at up to N=150 acquirer-only workers on a 24-core
// sandbox host) -- an outcome-shape assertion alone could therefore
// miss a regression on such a host. This reader busy-loops
// `readFileSync` on the same lock path from the same release barrier,
// with no spawn overhead of its own, so it can sample many times inside
// the widened window (see `RACE_WORKER_CODE` above) and catch a
// regression to a non-atomic fresh-create directly: any read that
// succeeds but is not a complete, well-formed lock body is a torn read
// the atomic `linkSync` fresh-create path (#2920) must make impossible.
// The shape check mirrors `readLock`'s own validator
// (`src/scripts/claim-lock.mts`), including `acquiredAt`, not just
// `claimId`/`agentId` (CodeRabbit + Copilot review, PR #2923) -- a body
// missing only that field would otherwise pass this check while
// production code classifies it malformed.
const RACE_READER_CODE = `
  const { workerData, parentPort } = require('node:worker_threads');
  const { readFileSync } = require('node:fs');
  const { lockPath, sab } = workerData;
  const ints = new Int32Array(sab);
  Atomics.add(ints, 0, 1);
  Atomics.wait(ints, 1, 0);
  const badReads = [];
  let readCount = 0;
  let nonEnoentReadCount = 0;
  let readsDuringWindow = 0;
  // Must exceed the main thread's release-barrier budget (10s) plus its
  // reader-coverage wait (2s), so the stop flag -- not this fallback --
  // is what normally ends the loop; this is only a last-resort backstop
  // against a hung round (CodeRabbit review, PR #2923).
  const deadline = Date.now() + 20_000;
  while (Atomics.load(ints, 2) === 0 && Date.now() < deadline) {
    readCount += 1;
    // ints[4] > 0 means some acquirer is currently paused between
    // opening its exclusive-create file and finishing its content
    // write (see RACE_WORKER_CODE) -- count every read attempted in
    // that window, regardless of outcome, as evidence this reader was
    // actually scheduled during it rather than only after it closed.
    if (Atomics.load(ints, 4) > 0) {
      readsDuringWindow += 1;
    }
    let body;
    try {
      body = readFileSync(lockPath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        continue;
      }
      badReads.push({
        kind: 'read-error',
        code: error && error.code,
        message: String(error && error.message),
      });
      continue;
    }
    if (nonEnoentReadCount === 0) {
      // Report this reader's first non-ENOENT read so the main thread
      // can wait for every reader to have genuinely sampled the file
      // at least once before signaling stop (CodeRabbit review, PR
      // #2923) -- otherwise a reader the scheduler never got around to
      // before the acquirer race settled could report zero reads and
      // silently contribute no coverage on that run.
      Atomics.add(ints, 3, 1);
    }
    nonEnoentReadCount += 1;
    if (body.length === 0) {
      badReads.push({ kind: 'empty' });
      continue;
    }
    try {
      const parsed = JSON.parse(body);
      if (
        !parsed ||
        typeof parsed.claimId !== 'string' ||
        typeof parsed.agentId !== 'string' ||
        typeof parsed.acquiredAt !== 'string'
      ) {
        badReads.push({ kind: 'malformed-shape', body });
      }
    } catch {
      badReads.push({ kind: 'parse-error', body });
    }
  }
  parentPort.postMessage({
    badReads,
    readCount,
    nonEnoentReadCount,
    readsDuringWindow,
  });
`;

// Kept deliberately small: a full worker_threads race harness costs real
// wall-clock time in CI (measured ~57s at ROUNDS=5, CONCURRENT_ACQUIRES=60
// on a constrained runner -- PR #2917 review, Codex P2), and the constants
// below are a proportionality call, not a precision one -- the test's job
// is verifying hard structural invariants that must hold whenever the race
// manifests, not maximizing the chance it manifests on any given run. See
// the test body below for why a *production*-code deterministic-reproduction
// hook was rejected in favor of a spawn-free reader plus a test-side `fs`
// interposition in the acquirer worker (`RACE_WORKER_CODE`) that
// deterministically widens the race window instead.
const RACE_TEST_ROUNDS = 2;
const RACE_TEST_WORKERS_PER_ROUND = Math.min(
  16,
  Math.max(8, availableParallelism() * 2),
);
// Small and fixed rather than scaled with CONCURRENT_ACQUIRES: readers
// pay no per-worker git-spawn cost, so a handful spinning for the whole
// release window already samples the race far more densely than adding
// more acquirers would.
const RACE_TEST_READERS_PER_ROUND = 4;

test('acquire: structural invariants hold under a same-claim-id race against an absent lock, including the closed torn-read collision gap (PR #2917 review, Codex; gap closed by #2920)', async (t) => {
  // Statistical health check across a couple of rounds, not a proof, like
  // the concurrent-takeovers test above -- but using worker_threads with an
  // Atomics ready-count barrier instead of subprocess spawning. The
  // exclusive-create race window is microseconds wide; process-spawn
  // overhead (milliseconds) reliably swamps it, so a subprocess batch
  // (like the takeover test above) essentially never reproduces this
  // specific race in practice. In-process worker threads sharing one
  // Node process avoid that overhead and do, on hosts with enough cores.
  //
  // A *production*-code injection hook forcing the race window open was
  // considered and rejected: it would add a production seam whose only
  // consumer is this one test -- its own reviewable surface, and out of
  // proportion to the field it verifies. Instead, two test-side
  // mechanisms combine to make the race deterministic without touching
  // production code:
  // - `RACE_WORKER_CODE` (the acquirer payload) intercepts its own
  //   worker's exclusive-create write ({ flag: 'wx' }) via a CJS-side
  //   `fs.writeFileSync` patch synced into the compiled CLI module's ESM
  //   import (`node:module`'s `syncBuiltinESMExports`), and yields the
  //   CPU for a bounded pause between the file becoming visible and its
  //   content finishing -- widening a window that would otherwise be
  //   microseconds wide into one busy-spinning readers on other OS
  //   threads are virtually guaranteed to be scheduled during, on any
  //   host including a constrained CI runner.
  // - `RACE_READER_CODE` (the reader payload) busy-loops `readFileSync`
  //   on the lock path from the same release barrier as the acquirers,
  //   with no git-spawn overhead of its own, and a hard assertion below
  //   requires every read it observes to be either absent (`ENOENT`) or
  //   a complete, well-formed lock body -- never torn -- plus a separate
  //   hard assertion that at least one read across all readers actually
  //   landed inside the widened window each round, so the mechanism's
  //   own liveness is verified rather than assumed.
  // Together these directly catch a regression to a non-atomic
  // fresh-create deterministically, not merely with high probability (PR
  // #2923 review, Copilot -- outcome-shape assertions alone do not
  // reliably exercise the race, and a reader that only ever observes the
  // settled post-write file does not either, per #2920's own acceptance
  // criterion).
  // `acquireClaimLock`'s three `reacquired`-from-a-retry return sites
  // (the source of `racedCreate: true`) are verified by direct code
  // reading, and separately by the deterministic
  // "genuinely pre-existing matching lock" test below, which exercises the
  // *no-race* path exactly. This test's positive `racedCreate`
  // observation stays a diagnostic, not a hard assertion, precisely
  // because a regression that stopped setting `racedCreate` entirely could
  // still pass a run that never happens to observe the race.
  //
  // Structural invariants that must hold on every round regardless of
  // whether a race actually manifests on this host:
  // - every outcome's mode is 'acquired' -- **never** 'collision': #2920
  //   closed the fresh-create path's torn-read window (a same-directory
  //   temp-write + atomic `linkSync` instead of a direct
  //   `writeFileSync(path, ..., { flag: 'wx' })`), so a same-claim-id race
  //   against an absent lock can no longer produce a false collision here;
  //   this batch's own lock starts absent and every acquire uses the same
  //   claim-id, so a genuine different-claim-id collision was never
  //   possible in this scenario either -- any `collision` outcome now
  //   means a regression, not an accepted pre-existing gap
  // - every reader's spin-loop over the same window never observes a
  //   torn (empty, partial, or malformed) lock body -- deterministically
  //   exercised via the widened window above, regardless of whether the
  //   acquirer-only race additionally collides on this host
  // - at least one reader read lands inside the widened window each
  //   round -- proof the interception/yield mechanism itself is live,
  //   not merely assumed to be
  // - exactly one outcome is a true fresh create (mode:'acquired', no
  //   `reacquired`) -- the atomic create is exclusive at the OS level
  // - every `racedCreate:true` co-occurs with `reacquired:true`
  // - the final lock body still names the single fresh creator
  //
  // Whether `racedCreate:true` is actually observed varies with host CPU
  // count and scheduler noise, so it is soft-checked via a diagnostic
  // across multiple rounds rather than a hard per-run assertion -- this
  // test must not fail merely because a given CI runner has few cores.
  const fixture = setupLinkedWorktree();
  try {
    const cliUrl = pathToFileURL(CLI_PATH).href;
    const lockPath = resolveClaimLockPath(fixture.worktree);
    const ROUNDS = RACE_TEST_ROUNDS;
    const CONCURRENT_ACQUIRES = RACE_TEST_WORKERS_PER_ROUND;
    const READERS = RACE_TEST_READERS_PER_ROUND;
    let anyRacedCreate = false;
    let totalReads = 0;
    let totalNonEnoentReads = 0;
    let totalReadsDuringWindow = 0;

    // Round -1 is an unasserted warm-up, not part of ROUNDS. A fresh
    // process's very first worker_threads batch pays one-time costs
    // (V8 isolate/module bootstrap, first-ever dynamic `import()` of the
    // compiled CLI module, first-ever `git` spawn) that can stretch an
    // acquirer's own pre-pause work well past the intended 20ms window,
    // observed directly: round "0" without this warm-up sometimes showed
    // 0 reader reads landing inside the window even though acquirers did
    // reach and execute it, purely because the round finished before a
    // still-warming-up reader's busy-loop or the still-warming-up
    // acquirers' pauses ever overlapped in wall-clock time. Every
    // measured round after the first one reliably shows the window
    // covering most of that round's reads (tens of thousands observed
    // locally), so one throwaway round absorbs the one-time cost instead
    // of the assertions having to tolerate it.
    for (let round = -1; round < ROUNDS; round += 1) {
      const isWarmup = round === -1;
      rmSync(lockPath, { force: true });

      const sab = new SharedArrayBuffer(32);
      const ints = new Int32Array(sab);
      // ints[0]: ready count; ints[1]: go flag; ints[2]: reader-stop
      // flag; ints[3]: count of readers that have had at least one
      // non-ENOENT read; ints[4]: count of acquirers currently paused
      // between opening their exclusive-create file and finishing its
      // content write (RACE_WORKER_CODE's deterministic window); ints[5]
      // is a dedicated always-zero Atomics.wait target used only to
      // yield the CPU for that pause, never written elsewhere.
      Atomics.store(ints, 0, 0);
      Atomics.store(ints, 1, 0);
      Atomics.store(ints, 2, 0);
      Atomics.store(ints, 3, 0);
      Atomics.store(ints, 4, 0);
      Atomics.store(ints, 5, 0);

      const acquirerRefs: Worker[] = [];
      const acquirers = Array.from({ length: CONCURRENT_ACQUIRES }, () => {
        const worker = new Worker(RACE_WORKER_CODE, {
          eval: true,
          workerData: { worktree: fixture.worktree, sab, cliUrl },
        });
        acquirerRefs.push(worker);
        return new Promise((resolve, reject) => {
          worker.on('message', resolve);
          worker.on('error', reject);
        });
      });

      const readerRefs: Worker[] = [];
      const readers = Array.from({ length: READERS }, () => {
        const worker = new Worker(RACE_READER_CODE, {
          eval: true,
          workerData: { lockPath, sab },
        });
        readerRefs.push(worker);
        return new Promise((resolve, reject) => {
          worker.on('message', resolve);
          worker.on('error', reject);
        });
      });

      // Poll until every worker in this round -- acquirers and readers
      // alike -- has reached its own Atomics.wait, then release them
      // together.
      const deadline = Date.now() + 10_000;
      while (
        Atomics.load(ints, 0) < CONCURRENT_ACQUIRES + READERS &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      Atomics.store(ints, 1, 1);
      Atomics.notify(ints, 1);

      const outcomes = (await Promise.all(acquirers)) as Array<{
        mode: string;
        reacquired?: boolean;
        racedCreate?: boolean;
        holder?: unknown;
      }>;
      let readerReports: Array<{
        badReads: Array<{ kind: string }>;
        readCount: number;
        nonEnoentReadCount: number;
        readsDuringWindow: number;
      }>;
      if (isWarmup) {
        // Skip the reader-coverage wait during warm-up -- its own
        // purpose is priming the JIT/worker-creation machinery, not
        // proving coverage, and would be subject to the exact same
        // cold-start variance this round exists to absorb.
        Atomics.store(ints, 2, 1);
        readerReports = (await Promise.all(readers)) as typeof readerReports;
      } else {
        // Every acquirer has settled and the winning lock body is
        // already final on disk, so wait for every reader to have
        // observed at least one non-ENOENT read before signaling stop
        // (CodeRabbit review, PR #2923) -- otherwise a reader the
        // scheduler never got around to during the race window could
        // report zero reads and silently contribute no coverage on
        // this run. The file is stably present at this point, so this
        // wait is expected to resolve almost immediately; a real
        // timeout means a reader never ran at all, worth failing
        // loudly on rather than passing silently.
        const readersSeenDeadline = Date.now() + 2_000;
        while (
          Atomics.load(ints, 3) < READERS &&
          Date.now() < readersSeenDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(
          Atomics.load(ints, 3),
          READERS,
          `expected all ${READERS} reader(s) to observe at least one non-ENOENT read in round ${round} before stopping; only ${Atomics.load(ints, 3)} did -- a reader may never have been scheduled`,
        );
        // Tell the readers to stop spinning and collect their reports.
        Atomics.store(ints, 2, 1);
        readerReports = (await Promise.all(readers)) as typeof readerReports;
      }
      // Terminate only after every worker (acquirers and readers) has
      // already posted its outcome and settled, so tearing one thread
      // down can never race another round's still-in-flight worker in
      // this same batch (PR #2917 review, Codex P2).
      await Promise.all(
        [...acquirerRefs, ...readerRefs].map((worker) => worker.terminate()),
      );

      if (isWarmup) {
        continue;
      }

      for (const outcome of outcomes) {
        assert.equal(
          outcome.mode,
          'acquired',
          `expected every same-claim-id racer to acquire (never collision, #2920) -- got: ${JSON.stringify(outcome)}`,
        );
        if (outcome.racedCreate === true) {
          assert.equal(
            outcome.reacquired,
            true,
            `racedCreate:true without reacquired:true, got: ${JSON.stringify(outcome)}`,
          );
          anyRacedCreate = true;
        }
      }

      let roundReadsDuringWindow = 0;
      for (const report of readerReports) {
        assert.deepEqual(
          report.badReads,
          [],
          `reader observed a torn/malformed lock-file read in round ${round} (regression to a non-atomic fresh-create, #2920): ${JSON.stringify(report.badReads)}`,
        );
        totalReads += report.readCount;
        totalNonEnoentReads += report.nonEnoentReadCount;
        roundReadsDuringWindow += report.readsDuringWindow;
      }
      totalReadsDuringWindow += roundReadsDuringWindow;
      assert.ok(
        roundReadsDuringWindow > 0,
        `expected at least one reader read to land inside the widened exclusive-create window in round ${round} -- got 0, meaning the deterministic-window mechanism itself did not fire or no reader was scheduled during it (PR #2923 review, Copilot)`,
      );

      const freshCreates = outcomes.filter(
        (outcome) => outcome.mode === 'acquired' && outcome.reacquired !== true,
      );
      assert.equal(
        freshCreates.length,
        1,
        `expected exactly one true fresh create in round ${round}, got: ${JSON.stringify(outcomes)}`,
      );

      const finalBody = JSON.parse(readFileSync(lockPath, 'utf8'));
      assert.equal(finalBody.claimId, 'claim-a');
      assert.equal(finalBody.agentId, 'agent-a');
    }

    t.diagnostic(
      anyRacedCreate
        ? `observed racedCreate:true across ${ROUNDS} round(s)`
        : `no racedCreate:true observed across ${ROUNDS} round(s) on this host -- the positive path is verified by construction (acquireClaimLock's three reacquired-from-a-retry return sites), not exercised deterministically here`,
    );
    t.diagnostic(
      `readers performed ${totalReads} read attempt(s) (${totalNonEnoentReads} non-ENOENT, ${totalReadsDuringWindow} inside the widened exclusive-create window) across ${ROUNDS} round(s); zero torn/malformed reads observed`,
    );
  } finally {
    teardown(fixture);
  }
});

test('acquire: a genuinely pre-existing matching lock reacquires with no racedCreate', () => {
  const fixture = setupLinkedWorktree();
  try {
    const first = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(first.mode, 'acquired');
    assert.equal(first.reacquired, undefined);
    assert.equal(first.racedCreate, undefined);

    // A later, separate call against the now-settled, already-present
    // lock -- the ordinary single-session "before every mutation"
    // re-check -- must read as unambiguously pre-existing.
    const second = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(second.mode, 'acquired');
    assert.equal(second.reacquired, true);
    assert.equal(second.racedCreate, undefined);
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

// Backfill-tokens recovery route tests (#2884).

test('backfill-tokens: backfilled — a present, matching lock writes the generated-tokens record using the lock agent-id, with no nonce', () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'backfilled');
    assert.equal(outcome.agentId, 'agent-a');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'present');
    assert.equal(read.status === 'present' && read.record.agentId, 'agent-a');
    assert.equal(read.status === 'present' && read.record.claimId, 'claim-a');
    assert.equal(read.status === 'present' && read.record.nonce, undefined);
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: lock-absent — no lock file exists, writes nothing', () => {
  const fixture = setupLinkedWorktree();
  try {
    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'lock-absent');
    assert.equal(outcome.holder, undefined);

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: lock-malformed — an unparseable lock body writes nothing', () => {
  const fixture = setupLinkedWorktree();
  try {
    const lockPath = resolveClaimLockPath(fixture.worktree);
    writeFileSync(lockPath, 'not json at all {{{');

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'lock-malformed');
    assert.equal(outcome.holder, undefined);

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: lock-malformed — a directory at the lock path writes nothing (same unreadable-path case as --check/--acquire)', () => {
  const fixture = setupLinkedWorktree();
  try {
    const lockPath = resolveClaimLockPath(fixture.worktree);
    mkdirSync(lockPath);

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'lock-malformed');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: lock-mismatch — a lock present for a different claim-id writes nothing and reports the actual holder', () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-b');
    assert.equal(outcome.status, 'lock-mismatch');
    assert.equal(outcome.holder?.agentId, 'agent-a');
    assert.equal(outcome.holder?.claimId, 'claim-a');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-b');
    assert.equal(read.status, 'absent');
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: re-running after a successful backfill is idempotent — reports backfilled again without corrupting the record', () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    const first = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(first.status, 'backfilled');

    const second = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(second.status, 'backfilled');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'present');
    assert.equal(read.status === 'present' && read.record.agentId, 'agent-a');
    assert.equal(read.status === 'present' && read.record.claimId, 'claim-a');
  } finally {
    teardown(fixture);
  }
});

test("backfill-tokens: preserves an existing well-formed record's own nonce rather than erasing it (PR #2917 review, Copilot)", () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    // A nonce-bearing record already exists for this exact claim-id --
    // outside the documented recovery route (which only ever reaches
    // --backfill-tokens when --read-tokens reports absent/malformed, i.e.
    // no well-formed record exists yet), but the CLI itself does not
    // enforce that precondition, so a direct out-of-band invocation must
    // not silently erase the nonce.
    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-a',
      claimId: 'claim-a',
      nonce: 'nonce-a',
    });

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'backfilled');

    const read = readGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(read.status, 'present');
    assert.equal(read.status === 'present' && read.record.agentId, 'agent-a');
    assert.equal(read.status === 'present' && read.record.nonce, 'nonce-a');
  } finally {
    teardown(fixture);
  }
});

// Worker-thread payloads for the concurrent-write regression test below
// (#2922). Unlike `RACE_WORKER_CODE`/`RACE_READER_CODE` above -- which must
// *statistically* widen a microseconds-wide race window because #2920's
// fix is a single atomic syscall with nothing to synchronize against --
// this race is fully deterministic to reproduce: `withGeneratedTokensWriteLock`
// gives the test a real, observable synchronization point (the reader
// worker's own paused `readFileSync`) to drive from, so no fs-interception
// widening trick is needed, only the same worker_threads + Atomics
// ready/release-barrier idiom already established above.
//
// `READER_WORKER_CODE` calls `backfillGeneratedClaimTokens` itself, but
// intercepts `fs.readFileSync` (propagated into the compiled CLI module's
// ESM import via `node:module`'s `syncBuiltinESMExports`, the same
// mechanism `RACE_WORKER_CODE` above uses) so that specifically its own
// read of the generated-tokens record path -- not the unrelated
// `idd-claim.lock` read that happens earlier in the same call -- captures
// the pre-race body, signals the main thread that it is paused
// mid-critical-section (holding the write-lock guard the whole time), and
// blocks until released.
const READER_WORKER_CODE = `
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs');
  const { worktree, claimId, recordPath, sab, cliUrl } = workerData;
  const ints = new Int32Array(sab);
  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = (path, opts) => {
    const result = originalReadFileSync(path, opts);
    if (path === recordPath) {
      // Signal "paused mid read-modify-write, still holding the guard
      // file" and block until the main thread releases it.
      Atomics.store(ints, 0, 1);
      Atomics.notify(ints, 0);
      Atomics.wait(ints, 1, 0);
    }
    return result;
  };
  require('node:module').syncBuiltinESMExports();
  import(cliUrl).then(({ backfillGeneratedClaimTokens }) => {
    const outcome = backfillGeneratedClaimTokens(worktree, claimId);
    parentPort.postMessage(outcome);
  });
`;

// \`WRITER_WORKER_CODE\` is the concurrent plain writer -- the
// activation-nonce minting flow's own \`--record-tokens --nonce\` call in
// production terms. It is launched only after the main thread has already
// confirmed the reader is paused (see the test body), so its own attempt
// to enter \`withGeneratedTokensWriteLock\` is guaranteed to observe the
// guard file already held.
//
// It signals \`ints[2]\` from a \`finally\` wrapped tightly around a
// test-side \`fs.openSync\` interception (the same
// propagate-via-\`syncBuiltinESMExports\` technique \`READER_WORKER_CODE\`
// and the pre-existing race test above both use) of its own lock-acquire
// attempt -- the \`.writelock\`-suffixed, \`'wx'\`-flag exclusive-create call
// inside \`withGeneratedTokensWriteLock\`. This went through several
// rounds of #2922 review tightening, each closing a smaller residual gap
// than the last:
// 1. An earlier revision signaled right after \`import()\` resolved,
//    immediately before calling \`recordGeneratedClaimTokens\`. Copilot
//    (a suppressed/lower-confidence finding) noted a worker could still
//    be preempted between that signal and its first actual lock-acquire
//    attempt, so the main thread's race-window check could in principle
//    start before the writer had attempted anything.
// 2. The fix moved the signal inside an \`fs.writeFileSync\` interception
//    (production's exclusive-create call at the time), but *before*
//    delegating to the real call -- closing most of the gap, but leaving
//    one statement (the delegation itself) between signal and attempt. A
//    further #2922 review round (Copilot, again suppressed) caught this
//    remaining sliver.
// 3. Signaling from a \`finally\` around the real call instead closed the
//    gap completely: the signal fires only once the attempt has
//    genuinely completed (an \`EEXIST\` throw or a successful create),
//    with no scheduling point of its own between the attempt and the
//    signal.
// 4. A later #2922 review round (Copilot) flagged that the *production*
//    exclusive-create itself was not ownership-safe on a non-\`EEXIST\`
//    failure, so \`withGeneratedTokensWriteLock\` switched from a single
//    \`fs.writeFileSync(path, ..., { flag: 'wx' })\` call to
//    \`fs.openSync(path, 'wx')\` (own doc comment has the full rationale)
//    -- this interception moved with it, from \`fs.writeFileSync\` to
//    \`fs.openSync\`, to keep testing the exclusive-create call production
//    code actually makes.
const WRITER_WORKER_CODE = `
  const { workerData, parentPort } = require('node:worker_threads');
  const fs = require('node:fs');
  const { worktree, agentId, claimId, nonce, sab, cliUrl } = workerData;
  const ints = new Int32Array(sab);
  const originalOpenSync = fs.openSync;
  fs.openSync = (path, flags, mode) => {
    const isGuardCreateAttempt =
      typeof path === 'string' && path.endsWith('.writelock') && flags === 'wx';
    if (!isGuardCreateAttempt) {
      return originalOpenSync(path, flags, mode);
    }
    // Signal from a \`finally\` around the *actual* syscall attempt (#2922
    // review round 3, Copilot), not before it: signaling first still left
    // a gap -- between the signal and \`originalOpenSync\` actually
    // running -- where a preempted worker could let the main thread's
    // race-window check pass before the writer had touched the guard at
    // all. A \`finally\` here fires only once the attempt has genuinely
    // completed (EEXIST throw or successful create), with no scheduling
    // point of its own in between.
    try {
      return originalOpenSync(path, flags, mode);
    } finally {
      Atomics.store(ints, 2, 1);
      Atomics.notify(ints, 2);
    }
  };
  require('node:module').syncBuiltinESMExports();
  import(cliUrl).then(({ recordGeneratedClaimTokens }) => {
    const outcome = recordGeneratedClaimTokens(worktree, {
      agentId,
      claimId,
      nonce,
    });
    parentPort.postMessage(outcome);
  });
`;

test('backfill-tokens: a nonce written by a concurrent recordGeneratedClaimTokens call during the read-modify-write window is never silently overwritten or lost (#2922)', async () => {
  // Deterministic reproduction of the exact race #2922 describes:
  // `backfillGeneratedClaimTokens` reads an existing record's `nonce`
  // (capturing "old-nonce") to preserve it, then a concurrent
  // `recordGeneratedClaimTokens` call writes a fresher "new-nonce" for the
  // very same claim-id, then the backfill's own write finally lands.
  // Pre-fix (plain `atomicReplaceFile`, no synchronization at all), the
  // concurrent writer's call is never blocked, so it always completes
  // during the reader's pause and the reader's subsequent write
  // unconditionally clobbers it back to "old-nonce" -- exactly the bug
  // report. Post-fix, both calls share one `withGeneratedTokensWriteLock`
  // critical section keyed by the record's own path, so the writer's call
  // cannot even begin its own write until the reader's full
  // read-modify-write finishes and releases the guard -- provably, not
  // merely statistically, since this test positively asserts the writer's
  // promise has not yet settled while the reader still holds the pause.
  const fixture = setupLinkedWorktree();
  try {
    const claimId = 'claim-2922';
    const recordPath = resolveGeneratedTokensPath(fixture.worktree, claimId);

    // The claim lock `backfillGeneratedClaimTokens` reads to authorize
    // itself and to source the agentId it writes with.
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-reader',
      claimId,
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    // Seed a pre-existing well-formed record so the reader's read captures
    // a real nonce to (attempt to) preserve, matching the "record already
    // exists" defensive path the sibling test above also exercises.
    recordGeneratedClaimTokens(fixture.worktree, {
      agentId: 'agent-reader',
      claimId,
      nonce: 'old-nonce',
    });

    const cliUrl = pathToFileURL(CLI_PATH).href;
    const sab = new SharedArrayBuffer(12);
    const ints = new Int32Array(sab);
    // ints[0]: reader-paused flag; ints[1]: release flag; ints[2]:
    // writer-ready-to-attempt-its-own-write flag.
    Atomics.store(ints, 0, 0);
    Atomics.store(ints, 1, 0);
    Atomics.store(ints, 2, 0);

    const reader = new Worker(READER_WORKER_CODE, {
      eval: true,
      workerData: {
        worktree: fixture.worktree,
        claimId,
        recordPath,
        sab,
        cliUrl,
      },
    });
    const readerDone = new Promise((resolve, reject) => {
      reader.on('message', resolve);
      reader.on('error', reject);
    });
    try {
      // Wait for the reader to signal it has read the existing record and
      // is now paused, still holding the write-lock guard file.
      const pausedDeadline = Date.now() + 10_000;
      while (Atomics.load(ints, 0) === 0 && Date.now() < pausedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        Atomics.load(ints, 0),
        1,
        'expected the reader worker to reach its paused read within the deadline',
      );

      const writer = new Worker(WRITER_WORKER_CODE, {
        eval: true,
        workerData: {
          worktree: fixture.worktree,
          agentId: 'agent-writer',
          claimId,
          nonce: 'new-nonce',
          sab,
          cliUrl,
        },
      });
      const writerDone = new Promise((resolve, reject) => {
        writer.on('message', resolve);
        writer.on('error', reject);
      });
      try {
        // Wait for the writer's own `import()` to resolve and for it to
        // reach its own lock-acquire attempt before starting the race
        // window below -- otherwise a slow cold-start import could eat
        // into that window and make the next assertion vacuously pass.
        const writerReadyDeadline = Date.now() + 10_000;
        while (
          Atomics.load(ints, 2) === 0 &&
          Date.now() < writerReadyDeadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal(
          Atomics.load(ints, 2),
          1,
          'expected the writer worker to reach its own lock-acquire attempt within the deadline',
        );

        // Positive proof of mutual exclusion, not an assumption: the
        // writer's own `withGeneratedTokensWriteLock` acquire must still
        // be blocked (EEXIST-retrying) while the reader holds the guard,
        // so its promise must not have settled yet.
        const settledEarly = await Promise.race([
          writerDone.then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
        assert.equal(
          settledEarly,
          false,
          'expected the concurrent recordGeneratedClaimTokens call to stay blocked on the write-lock guard while the reader is mid-critical-section',
        );

        // Release the reader; it finishes its own (now-redundant) write
        // with the stale "old-nonce" it captured, then releases the guard,
        // finally letting the writer's blocked call proceed.
        Atomics.store(ints, 1, 1);
        Atomics.notify(ints, 1);

        const [readerOutcome, writerOutcome] = (await Promise.all([
          readerDone,
          writerDone,
        ])) as [{ status: string }, { path: string }];
        assert.equal(readerOutcome.status, 'backfilled');
        assert.ok(writerOutcome.path);
      } finally {
        await writer.terminate();
      }
    } finally {
      await reader.terminate();
    }

    // The writer's later, fully-serialized write must be the final state --
    // never silently reverted to the reader's stale capture.
    const finalRead = readGeneratedClaimTokens(fixture.worktree, claimId);
    assert.equal(finalRead.status, 'present');
    assert.equal(
      finalRead.status === 'present' && finalRead.record.nonce,
      'new-nonce',
      `expected the concurrently-written nonce to survive, got: ${JSON.stringify(finalRead)}`,
    );
    assert.equal(
      finalRead.status === 'present' && finalRead.record.agentId,
      'agent-writer',
    );
  } finally {
    teardown(fixture);
  }
});

test('write-lock: an existing guard file blocks a write until the timeout, then fails closed without writing the record or touching the guard (#2922 review round 3, Copilot)', () => {
  // Coverage the reviewer flagged as missing: the regression test above
  // only exercises successful contention (a guard released partway
  // through the wait). This test exercises the *other* documented
  // outcome -- a guard that is never released -- confirming
  // `withGeneratedTokensWriteLock` genuinely fails closed rather than
  // silently reclaiming it or writing anyway, so a future change that
  // reintroduces an unsafe reclaim (or drops the timeout check entirely)
  // would break this test. Costs the real ~5s wait budget (no test-only
  // seam shortens it, matching this suite's existing preference for
  // testing production code exactly as it runs) -- a single test, not a
  // loop, deliberately for that reason.
  const fixture = setupLinkedWorktree();
  try {
    const claimId = 'claim-timeout-2922';
    const recordPath = resolveGeneratedTokensPath(fixture.worktree, claimId);
    const guardPath = `${recordPath}.writelock`;
    // Simulate a guard some other holder still owns (orphaned or
    // genuinely live -- this function cannot tell the difference, and
    // must fail closed either way).
    writeFileSync(guardPath, 'held-by-another-process');

    assert.throws(
      () => {
        recordGeneratedClaimTokens(fixture.worktree, {
          agentId: 'agent-a',
          claimId,
          nonce: 'should-never-be-written',
        });
      },
      (error: unknown) =>
        error instanceof Error && error.message.includes(guardPath),
      'expected a timeout error naming the guard path for manual recovery',
    );

    // Fails closed, not silently: the record itself was never written.
    const read = readGeneratedClaimTokens(fixture.worktree, claimId);
    assert.equal(read.status, 'absent');
    // The guard is left exactly as found -- this function never removes
    // a guard it did not itself create.
    assert.equal(existsSync(guardPath), true);
    assert.equal(readFileSync(guardPath, 'utf8'), 'held-by-another-process');
  } finally {
    teardown(fixture);
  }
});

test('backfill-tokens: reports record-blocked instead of deleting a directory at the generated-tokens path (PR #2917 review, Codex P2 then Copilot)', () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    // Simulate the malformed-token-path-is-a-directory case
    // `readGeneratedClaimTokens` already reports as `malformed` (read side).
    // An earlier fix here made the write side self-heal by deleting the
    // directory, but a matching `idd-claim.lock` only authenticates the
    // *lock*, not this separate path, and the path's hash suffix is not
    // collision-proof -- so a stray/colliding directory's contents must
    // survive, the same invariant the #2879-review regression test below
    // already establishes for a plain --record-tokens call.
    const tokensPath = readGeneratedClaimTokens(
      fixture.worktree,
      'claim-a',
    ).path;
    mkdirSync(tokensPath, { recursive: true });
    writeFileSync(join(tokensPath, 'unrelated-file.txt'), 'do not delete me');
    assert.equal(
      readGeneratedClaimTokens(fixture.worktree, 'claim-a').status,
      'malformed',
    );

    const outcome = backfillGeneratedClaimTokens(fixture.worktree, 'claim-a');
    assert.equal(outcome.status, 'record-blocked');

    assert.equal(statSync(tokensPath).isDirectory(), true);
    assert.equal(
      readFileSync(join(tokensPath, 'unrelated-file.txt'), 'utf8'),
      'do not delete me',
    );
    assert.equal(
      readGeneratedClaimTokens(fixture.worktree, 'claim-a').status,
      'malformed',
    );
  } finally {
    teardown(fixture);
  }
});

test('CLI: --backfill-tokens writes on a matching lock and exits 0, and exits non-zero with no write on a mismatched claim-id', async () => {
  const fixture = setupLinkedWorktree();
  try {
    const acquired = acquireClaimLock(
      fixture.worktree,
      'agent-a',
      'claim-a',
      false,
    );
    assert.equal(acquired.mode, 'acquired');

    const backfillResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--backfill-tokens',
      '--worktree',
      fixture.worktree,
      '--claim-id',
      'claim-a',
    ]);
    const backfillOutcome = JSON.parse(backfillResult.stdout);
    assert.equal(backfillOutcome.status, 'backfilled');
    assert.equal(backfillOutcome.agentId, 'agent-a');

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

    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        '--backfill-tokens',
        '--worktree',
        fixture.worktree,
        '--claim-id',
        'claim-b',
      ]),
      (error: NodeJS.ErrnoException & { stdout?: string }) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout ?? '').status, 'lock-mismatch');
        return true;
      },
    );

    // A different claim-id's record was never written by the failed call.
    const readOtherResult = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--read-tokens',
      '--worktree',
      fixture.worktree,
      '--claim-id',
      'claim-b',
    ]);
    assert.equal(JSON.parse(readOtherResult.stdout).present, false);
  } finally {
    teardown(fixture);
  }
});
