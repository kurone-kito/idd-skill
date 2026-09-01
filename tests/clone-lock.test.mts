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
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * A genuinely dead PID: `spawnSync` blocks until the child has already
 * exited, so its `pid` is guaranteed not to be running by the time it is
 * read back (short of the OS recycling that exact pid in the meantime,
 * which is not realistic within a test's lifetime).
 */
function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  assert.ok(typeof pid === 'number' && pid > 0);
  return pid;
}

function writeLockBody(
  path: string,
  body: { pid: number; token: string; agentId: string },
): void {
  writeFileSync(
    path,
    JSON.stringify({ ...body, acquiredAt: new Date().toISOString() }),
  );
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

test("acquire: a lock recording a live PID is never taken over, however long acquire keeps waiting (this repository's own CI caught a time-based-staleness design regress exactly this invariant)", () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    // This test process's own pid is, by construction, alive for the
    // entire test -- there is no timing window to race here, unlike an
    // elapsed-time threshold: liveness is either true right now or it
    // is not.
    writeLockBody(path, {
      pid: process.pid,
      token: 'live-holder',
      agentId: 'agent-live',
    });

    assert.throws(
      () => acquireCloneLock(primary, 'agent-b', 300),
      CloneLockTimeoutError,
    );
    const check = checkCloneLock(primary);
    assert.equal(check.present, true);
    assert.equal(check.holder?.token, 'live-holder');
  } finally {
    teardown(primary);
  }
});

test('acquire: a lock whose recorded pid is confirmed dead is taken over rather than waited out', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeLockBody(path, {
      pid: deadPid(),
      token: 'dead-holder',
      agentId: 'agent-dead',
    });

    const start = Date.now();
    const handle = acquireCloneLock(primary, 'agent-b', 5_000);
    const elapsedMs = Date.now() - start;

    assert.ok(
      elapsedMs < 2_000,
      `expected an immediate takeover of a dead-pid lock, took ${elapsedMs}ms`,
    );
    assert.notEqual(handle.token, 'dead-holder');
    releaseCloneLock(handle);
  } finally {
    teardown(primary);
  }
});

test('acquire: a malformed lock body is never auto-recovered (no readable pid to confirm dead; this repository deliberately does not add recovery machinery for it -- see the module header comment)', async () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
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
 * A small on-disk fixture script (not an inline `-e` string) so a child
 * process can import the built `clone-lock.mjs` directly and call
 * acquireCloneLock() with a short, test-friendly timeoutMs the CLI
 * itself intentionally does not expose for this purpose. Every
 * contender appends `won <idx> <startMs>` and `released <idx> <endMs>`
 * on success, or `lost <idx>` if it never acquired within its budget.
 */
function writeRaceFixture(dir: string): string {
  const fixturePath = join(dir, 'race-worker.mjs');
  const cloneLockUrl = pathToFileURL(
    join(REPO_ROOT, 'scripts/clone-lock.mjs'),
  ).href;
  writeFileSync(
    fixturePath,
    [
      `import { acquireCloneLock, releaseCloneLock } from ${JSON.stringify(cloneLockUrl)};`,
      "import { appendFileSync } from 'node:fs';",
      'const repo = process.env.IDD_TEST_REPO;',
      'const idx = process.env.IDD_TEST_IDX;',
      'const log = process.env.IDD_TEST_LOG;',
      'const timeoutMs = Number(process.env.IDD_TEST_TIMEOUT_MS);',
      'const holdMs = Number(process.env.IDD_TEST_HOLD_MS);',
      'try {',
      "  const handle = acquireCloneLock(repo, 'agent-' + idx, timeoutMs);",
      "  appendFileSync(log, 'won ' + idx + ' ' + Date.now() + '\\n');",
      '  const until = Date.now() + holdMs;',
      '  while (Date.now() < until) {}',
      "  appendFileSync(log, 'released ' + idx + ' ' + Date.now() + '\\n');",
      '  releaseCloneLock(handle);',
      '} catch (error) {',
      "  appendFileSync(log, 'lost ' + idx + '\\n');",
      '}',
    ].join('\n'),
  );
  return fixturePath;
}

test('acquire: a dead-pid lock takeover across concurrent contenders never lets two of them hold the lock at once', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'dead-pid-race.log');
  writeFileSync(logPath, '');
  try {
    const path = resolveCloneLockPath(primary);
    writeLockBody(path, {
      pid: deadPid(),
      token: 'dead-holder',
      agentId: 'agent-dead',
    });

    const fixturePath = writeRaceFixture(primary);
    const CONTENDERS = 5;
    await Promise.all(
      Array.from({ length: CONTENDERS }, (_unused, index) =>
        execFileAsync(process.execPath, [fixturePath], {
          env: fixtureEnv({
            IDD_TEST_REPO: primary,
            IDD_TEST_IDX: String(index),
            IDD_TEST_LOG: logPath,
            // Every contender starts by racing the SAME pre-seeded
            // dead-pid lock. A generous shared timeout means nobody
            // spuriously times out from ordinary process-spawn jitter;
            // every contender is expected to eventually acquire, one at
            // a time.
            IDD_TEST_TIMEOUT_MS: '10000',
            IDD_TEST_HOLD_MS: '150',
          }),
        }),
      ),
    );

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(
      lines.filter((line) => line.startsWith('lost ')).length,
      0,
      `expected every contender to eventually acquire, got: ${JSON.stringify(lines)}`,
    );
    const intervals = new Map<string, { start: number; end: number }>();
    for (const line of lines) {
      const [kind, idx, ts] = line.split(' ');
      const entry = intervals.get(idx) ?? { start: 0, end: 0 };
      if (kind === 'won') {
        entry.start = Number(ts);
      } else {
        entry.end = Number(ts);
      }
      intervals.set(idx, entry);
    }
    assert.equal(intervals.size, CONTENDERS);
    const sorted = Array.from(intervals.values()).sort(
      (first, second) => first.start - second.start,
    );
    for (let index = 1; index < sorted.length; index += 1) {
      assert.ok(
        sorted[index].start >= sorted[index - 1].end,
        `expected non-overlapping holds even when racing a shared dead-pid lock, got: ${JSON.stringify(sorted)}`,
      );
    }
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

test("withCloneLock: a live wrapped-command holder is never taken over by a waiter, no matter how long the command runs (Codex P1 / this repository's own CI regression: an earlier mtime-staleness-plus-lease-refresh design let a live holder be taken over under scheduling jitter -- PID liveness has no equivalent timing window)", async () => {
  const primary = setupRepo();
  try {
    // The held command runs for 500ms; the waiter's own acquire budget
    // is only 200ms -- deliberately shorter than the hold, so a
    // waiter that (incorrectly) treats the live holder as stale would
    // succeed well before the holder exits, and a correctly-behaving
    // waiter must time out instead.
    const holderPromise = withCloneLock(
      primary,
      'agent-holder',
      process.execPath,
      ['-e', 'const u=Date.now()+500;while(Date.now()<u){}'],
    );

    // Let the holder actually acquire before the waiter starts contending.
    await new Promise((resolve) => setTimeout(resolve, 100));

    await assert.rejects(
      execFileAsync(process.execPath, [
        CLI_PATH,
        '--exec',
        '--agent-id',
        'agent-waiter',
        '--repo',
        primary,
        '--timeout-ms',
        '200',
        '--',
        process.execPath,
        '-e',
        'process.exit(0)',
      ]),
      (error: NodeJS.ErrnoException) => {
        assert.equal(error.code, 3);
        return true;
      },
    );

    await holderPromise;
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
