import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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
  env.GIT_CONFIG_GLOBAL = devNull;
  env.GIT_CONFIG_SYSTEM = devNull;
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
    assert.equal(checkCloneLock(primary).present, true);
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

test('acquire: times out with CloneLockTimeoutError when the lock is never released', () => {
  const primary = setupRepo();
  try {
    const first = acquireCloneLock(primary, 'agent-a', 60_000);
    try {
      assert.throws(
        () => acquireCloneLock(primary, 'agent-b', 300),
        CloneLockTimeoutError,
      );
    } finally {
      releaseCloneLock(first);
    }
  } finally {
    teardown(primary);
  }
});

test('acquire: a lock older than the stale threshold is taken over rather than waited out', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    const ancientAcquiredAt = new Date(Date.now() - 10 * 60_000).toISOString();
    writeFileSync(
      path,
      JSON.stringify({
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: ancientAcquiredAt,
      }),
    );

    const start = Date.now();
    const handle = acquireCloneLock(primary, 'agent-b', 5_000);
    const elapsedMs = Date.now() - start;

    assert.ok(
      elapsedMs < 2_000,
      `expected an immediate takeover of a stale lock, took ${elapsedMs}ms`,
    );
    assert.notEqual(handle.token, 'dead-holder');
    releaseCloneLock(handle);
  } finally {
    teardown(primary);
  }
});

test('acquire: a malformed lock body is waited out, not treated as immediately stale', async () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(path, '{"unexpected": "shape"}');

    await assert.rejects(
      (async () => acquireCloneLock(primary, 'agent-b', 300))(),
      CloneLockTimeoutError,
    );
  } finally {
    teardown(primary);
  }
});

test('withCloneLock: releases even when the wrapped command fails', () => {
  const primary = setupRepo();
  try {
    const status = withCloneLock(primary, 'agent-a', process.execPath, [
      '-e',
      'process.exit(7)',
    ]);
    assert.equal(status, 7);
    assert.equal(checkCloneLock(primary).present, false);
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
