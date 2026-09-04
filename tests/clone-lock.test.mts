import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  acquireCloneLock,
  CloneLockTimeoutError,
  checkCloneLock,
  releaseCloneLock,
  resolveCloneLockPath,
  withCloneLock,
} from '../src/scripts/clone-lock.mts';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/clone-lock.mjs');

// A git-config-file-safe null-device path. `node:os`'s `devNull` is the
// Win32 device-namespace form (`\\.\nul`) on win32, which Git for Windows
// cannot open as a GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM value (`fatal:
// unable to access '//./nul': Invalid argument`); the bare `'NUL'` device
// name is the form git itself accepts there. POSIX is unaffected -- devNull
// there is already `/dev/null`. See kurone-kito/idd-skill#2570.
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

// Fixture invariant mirrored from tests/claim-lock.test.mts: fixture git
// processes must never read the ambient git environment or the
// developer's config.
function fixtureEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
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

function setupRepo(): string {
  const primary = mkdtempSync(join(tmpdir(), 'idd-clone-lock-'));
  git(primary, ['init', '-b', 'main']);
  git(primary, ['config', 'user.email', 'test@example.com']);
  git(primary, ['config', 'user.name', 'Test']);
  writeFileSync(join(primary, 'seed.txt'), 'seed\n');
  git(primary, ['add', 'seed.txt']);
  git(primary, ['commit', '-m', 'seed']);
  return primary;
}

function teardown(primary: string): void {
  rmSync(primary, { recursive: true, force: true });
}

test('resolveCloneLockPath resolves to the shared git-common-dir, identically from the primary and a linked worktree', () => {
  const primary = setupRepo();
  try {
    const worktree = join(primary, '..', 'linked-wt');
    git(primary, ['worktree', 'add', worktree, '-b', 'issue/1-test', 'main']);
    try {
      const fromPrimary = resolveCloneLockPath(primary);
      const fromWorktree = resolveCloneLockPath(worktree);
      assert.equal(fromPrimary, fromWorktree);
      assert.ok(fromPrimary.endsWith('idd-clone.lock'));
    } finally {
      git(primary, ['worktree', 'remove', '--force', worktree]);
    }
  } finally {
    teardown(primary);
  }
});

test('check: reports absence without creating a lock', () => {
  const primary = setupRepo();
  try {
    const check = checkCloneLock(primary);
    assert.equal(check.present, false);
    assert.equal(existsSync(resolveCloneLockPath(primary)), false);
  } finally {
    teardown(primary);
  }
});

test('acquire/release: a fresh acquire succeeds and release removes the lock', () => {
  const primary = setupRepo();
  try {
    const handle = acquireCloneLock(primary, 'agent-a', 5_000);
    const check = checkCloneLock(primary);
    assert.equal(check.present, true);
    assert.equal(check.holder?.pid, process.pid);
    assert.equal(check.holderAlive, true);
    releaseCloneLock(handle);
    assert.equal(checkCloneLock(primary).present, false);
  } finally {
    teardown(primary);
  }
});

test('release: a stale token mismatch is a no-op, never disturbs the current holder', () => {
  const primary = setupRepo();
  try {
    const handle = acquireCloneLock(primary, 'agent-a', 5_000);
    releaseCloneLock({ path: handle.path, token: 'not-the-real-token' });
    assert.equal(checkCloneLock(primary).present, true);
    releaseCloneLock(handle);
  } finally {
    teardown(primary);
  }
});

test('acquire: a held lock blocks a separate-process acquirer until the first releases', async () => {
  // acquireCloneLock() is intentionally fully synchronous (it blocks via
  // Atomics.wait, matching the rest of this module's sync style), so it
  // cannot be raced against a same-process setTimeout -- the busy-wait
  // would starve the event loop the timer needs to fire. Cross-process
  // concurrency is this lock's real use case anyway (see the CLI
  // concurrent-invocations test below), so the "second acquirer" here is a
  // genuine child process via the CLI, not an in-process call.
  const primary = setupRepo();
  try {
    const first = acquireCloneLock(primary, 'agent-a', 5_000);

    const waiter = execFileAsync(process.execPath, [
      CLI_PATH,
      '--exec',
      '--agent-id',
      'agent-b',
      '--repo',
      primary,
      '--timeout-ms',
      '5000',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write(String(Date.now()))',
    ]);

    await new Promise((resolve) => setTimeout(resolve, 300));
    const releasedAt = Date.now();
    releaseCloneLock(first);

    const { stdout } = await waiter;
    const acquiredAt = Number(stdout);
    assert.ok(
      acquiredAt >= releasedAt - 50,
      `expected the waiter to acquire only after release (acquiredAt=${acquiredAt}, releasedAt=${releasedAt})`,
    );
  } finally {
    teardown(primary);
  }
});

test('acquire: times out with CloneLockTimeoutError, naming the lock path and the recorded holder, when the lock is never released', () => {
  const primary = setupRepo();
  try {
    const first = acquireCloneLock(primary, 'agent-a', 60_000);
    try {
      assert.throws(
        () => acquireCloneLock(primary, 'agent-b', 300),
        (error: unknown) => {
          assert.ok(error instanceof CloneLockTimeoutError);
          assert.match(error.message, /timed out waiting for clone lock:/);
          assert.match(error.message, new RegExp(`held by pid ${process.pid}`));
          assert.match(error.message, /agent "agent-a"/);
          assert.match(error.message, /still appears to be running/);
          assert.match(error.message, /remove the lock manually: rm /);
          return true;
        },
      );
    } finally {
      releaseCloneLock(first);
    }
  } finally {
    teardown(primary);
  }
});

test('acquire: NEVER automatically takes over a lock, even one recording a confirmed-dead pid or a malformed body -- this module deliberately has no automatic stale-lock recovery (see the module header comment: three prior auto-recovery designs each had a genuine concurrency defect found in review)', async () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);

    // A lock recording a pid that is, by construction, not running.
    const deadPid = spawnDeadPid();
    writeFileSync(
      path,
      JSON.stringify({
        pid: deadPid,
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    await assert.rejects(
      (async () => acquireCloneLock(primary, 'agent-b', 300))(),
      CloneLockTimeoutError,
    );
    assert.equal(checkCloneLock(primary).holder?.token, 'dead-holder');

    // A malformed body is likewise left untouched.
    writeFileSync(path, '{"unexpected": "shape"}');
    await assert.rejects(
      (async () => acquireCloneLock(primary, 'agent-b', 300))(),
      CloneLockTimeoutError,
    );
    const check = checkCloneLock(primary);
    assert.equal(check.present, true);
    assert.equal(check.malformed, true);
  } finally {
    teardown(primary);
  }
});

/**
 * A genuinely dead PID: `spawnSync` blocks until the child has already
 * exited, so its `pid` is guaranteed not to be running by the time it is
 * read back (short of the OS recycling that exact pid in the meantime,
 * which is not realistic within a test's lifetime).
 */
function spawnDeadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.ok(typeof pid === 'number' && pid > 0);
  return pid;
}

test('check: a lock body with an unsafe pid (0, negative, or non-integer -- POSIX gives kill() special meaning for those) is treated as malformed, never passed to process.kill()', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    for (const badPid of [0, -1, 1.5, Number.NaN]) {
      writeFileSync(
        path,
        JSON.stringify({
          pid: badPid,
          token: 'bad-pid-holder',
          agentId: 'agent-bad',
          acquiredAt: new Date().toISOString(),
        }),
      );
      const check = checkCloneLock(primary);
      assert.equal(check.present, true);
      assert.equal(
        check.malformed,
        true,
        `expected pid ${badPid} to be treated as malformed`,
      );
      assert.equal(check.holder, undefined);
    }
  } finally {
    teardown(primary);
  }
});

test('check: holderAlive reports false for a lock recording a confirmed-dead pid', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(
      path,
      JSON.stringify({
        pid: spawnDeadPid(),
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    const check = checkCloneLock(primary);
    assert.equal(check.present, true);
    assert.equal(check.holderAlive, false);
  } finally {
    teardown(primary);
  }
});

test('withCloneLock: releases even when the wrapped command fails', async () => {
  const primary = setupRepo();
  try {
    const status = await withCloneLock(primary, 'agent-a', process.execPath, [
      '-e',
      'process.exit(7)',
    ]);
    assert.equal(status, 7);
    assert.equal(checkCloneLock(primary).present, false);
  } finally {
    teardown(primary);
  }
});

test('withCloneLock: runs the wrapped command with cwd set to repoPath', async () => {
  const primary = setupRepo();
  try {
    const outPath = join(primary, 'cwd-observed.txt');
    const status = await withCloneLock(primary, 'agent-a', process.execPath, [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(outPath)}, process.cwd())`,
    ]);
    assert.equal(status, 0);
    assert.equal(
      realpathSync(readFileSync(outPath, 'utf8')),
      realpathSync(primary),
    );
  } finally {
    teardown(primary);
  }
});

test('CLI: --check reports a malformed lock body as present+malformed, without throwing', () => {
  const primary = setupRepo();
  try {
    writeFileSync(resolveCloneLockPath(primary), '{"unexpected": "shape"}');
    const stdout = execFileSync(
      process.execPath,
      [CLI_PATH, '--check', '--repo', primary],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.present, true);
    assert.equal(parsed.malformed, true);
  } finally {
    teardown(primary);
  }
});

test('CLI: --exec exits 3 with a diagnostic message on timeout', async () => {
  const primary = setupRepo();
  try {
    const holder = acquireCloneLock(primary, 'agent-a', 60_000);
    try {
      await assert.rejects(
        execFileAsync(process.execPath, [
          CLI_PATH,
          '--exec',
          '--agent-id',
          'agent-b',
          '--repo',
          primary,
          '--timeout-ms',
          '200',
          '--',
          process.execPath,
          '-e',
          'process.exit(0)',
        ]),
        (error: NodeJS.ErrnoException & { stderr?: string }) => {
          assert.equal(error.code, 3);
          assert.match(error.stderr ?? '', /timed out waiting for clone lock:/);
          assert.match(error.stderr ?? '', /remove the lock manually: rm /);
          return true;
        },
      );
    } finally {
      releaseCloneLock(holder);
    }
  } finally {
    teardown(primary);
  }
});

test('CLI: --exec propagates the wrapped command exit code and requires a `--` command', async () => {
  const primary = setupRepo();
  try {
    const ok = await execFileAsync(process.execPath, [
      CLI_PATH,
      '--exec',
      '--agent-id',
      'agent-a',
      '--repo',
      primary,
      '--',
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    assert.equal(ok.stdout, '');

    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        '--exec',
        '--agent-id',
        'agent-a',
        '--repo',
        primary,
        '--',
        process.execPath,
        '-e',
        'process.exit(9)',
      ]),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 9);
        return true;
      },
    );

    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        '--exec',
        '--agent-id',
        'agent-a',
        '--repo',
        primary,
      ]),
      (error: NodeJS.ErrnoException & { stderr?: string }) => {
        assert.match(error.stderr ?? '', /requires a command after `--`/);
        return true;
      },
    );
  } finally {
    teardown(primary);
  }
});

test('CLI: concurrent --exec invocations serialize the wrapped command — no two critical sections overlap', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'activity.log');
  writeFileSync(logPath, '');
  try {
    const CONCURRENT_WORKERS = 4;
    const criticalSectionScript =
      'const fs=require("fs");const log=process.env.IDD_TEST_LOG;const idx=process.env.IDD_TEST_IDX;' +
      'fs.appendFileSync(log,"start "+idx+" "+Date.now()+"\\n");' +
      'const until=Date.now()+120;while(Date.now()<until){}' +
      'fs.appendFileSync(log,"end "+idx+" "+Date.now()+"\\n");';

    await Promise.all(
      Array.from({ length: CONCURRENT_WORKERS }, (_unused, index) =>
        execFileAsync(
          process.execPath,
          [
            CLI_PATH,
            '--exec',
            '--agent-id',
            `agent-${index}`,
            '--repo',
            primary,
            '--timeout-ms',
            '20000',
            '--',
            process.execPath,
            '-e',
            criticalSectionScript,
          ],
          {
            env: fixtureEnv({
              IDD_TEST_LOG: logPath,
              IDD_TEST_IDX: String(index),
            }),
          },
        ),
      ),
    );

    const lines = readFileSync(logPath, 'utf8').trim().split('\n');
    const intervals = new Map<string, { start: number; end: number }>();
    for (const line of lines) {
      const [kind, idx, ts] = line.split(' ');
      const entry = intervals.get(idx) ?? { start: 0, end: 0 };
      if (kind === 'start') {
        entry.start = Number(ts);
      } else {
        entry.end = Number(ts);
      }
      intervals.set(idx, entry);
    }
    assert.equal(intervals.size, CONCURRENT_WORKERS);

    const sorted = Array.from(intervals.values()).sort(
      (first, second) => first.start - second.start,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(
        sorted[index].start >= sorted[index - 1].end,
        `expected non-overlapping critical sections, got: ${JSON.stringify(sorted)}`,
      );
    }
  } finally {
    teardown(primary);
  }
});
