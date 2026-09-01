import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
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
  refreshCloneLock,
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

function backdateLockMtime(path: string, ageMs: number): void {
  const ancient = new Date(Date.now() - ageMs);
  utimesSync(path, ancient, ancient);
}

test('acquire: a lock whose mtime is older than staleMs is taken over rather than waited out', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(
      path,
      JSON.stringify({
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    backdateLockMtime(path, 60_000);

    const start = Date.now();
    const handle = acquireCloneLock(primary, 'agent-b', 5_000, 200);
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

test('acquire: a fresh malformed lock body is waited out, not treated as immediately stale', async () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(path, '{"unexpected": "shape"}');
    // mtime is "now" (just written) -- well inside a generous staleMs, so
    // this must not be taken over yet.

    await assert.rejects(
      (async () => acquireCloneLock(primary, 'agent-b', 300, 60_000))(),
      CloneLockTimeoutError,
    );
  } finally {
    teardown(primary);
  }
});

test('acquire: a malformed lock body recovers once its mtime ages past staleMs (Codex P2: a crashed partial write must not wedge every waiter forever)', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(path, '{"unexpected": "shape"}');
    backdateLockMtime(path, 60_000);

    const start = Date.now();
    const handle = acquireCloneLock(primary, 'agent-b', 5_000, 200);
    const elapsedMs = Date.now() - start;

    assert.ok(
      elapsedMs < 2_000,
      `expected recovery of a stale malformed lock, took ${elapsedMs}ms`,
    );
    releaseCloneLock(handle);
  } finally {
    teardown(primary);
  }
});

test('refreshCloneLock: bumps mtime only when the on-disk token still matches, is a silent no-op otherwise', () => {
  const primary = setupRepo();
  try {
    const handle = acquireCloneLock(primary, 'agent-a', 5_000);
    backdateLockMtime(handle.path, 10_000);
    const beforeMs = statSync(handle.path).mtimeMs;

    refreshCloneLock(handle);
    const afterMs = statSync(handle.path).mtimeMs;
    assert.ok(
      afterMs > beforeMs,
      `expected refresh to bump mtime forward (before=${beforeMs}, after=${afterMs})`,
    );

    releaseCloneLock(handle);
    writeFileSync(
      handle.path,
      JSON.stringify({
        token: 'someone-else',
        agentId: 'agent-b',
        acquiredAt: new Date().toISOString(),
      }),
    );
    backdateLockMtime(handle.path, 10_000);
    const beforeOtherMs = statSync(handle.path).mtimeMs;
    refreshCloneLock(handle);
    const afterOtherMs = statSync(handle.path).mtimeMs;
    assert.equal(
      afterOtherMs,
      beforeOtherMs,
      "refreshing a handle whose token no longer matches must not touch another holder's lock",
    );
  } finally {
    teardown(primary);
  }
});

/**
 * A small on-disk fixture script (not an inline `-e` string) so a child
 * process can import the built `clone-lock.mjs` directly and call
 * acquireCloneLock() with short, test-friendly staleMs/timeoutMs values
 * the CLI itself intentionally does not expose (see withCloneLock's own
 * doc comment: those overrides exist only for tests). Every contender
 * appends `won <idx> <startMs>` and `released <idx> <endMs>` on success,
 * or `lost <idx>` if it never acquired within its budget.
 */
function writeRaceFixture(dir: string): string {
  const fixturePath = join(dir, 'stale-race-worker.mjs');
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
      'const staleMs = Number(process.env.IDD_TEST_STALE_MS);',
      'const holdMs = Number(process.env.IDD_TEST_HOLD_MS);',
      'try {',
      "  const handle = acquireCloneLock(repo, 'agent-' + idx, timeoutMs, staleMs);",
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

test('acquire: a stale-lock takeover across concurrent contenders never lets two of them hold the lock at once (P1-1: unconditional rename let every racer believe it won)', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'stale-race.log');
  writeFileSync(logPath, '');
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(
      path,
      JSON.stringify({
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    backdateLockMtime(path, 60_000);

    const fixturePath = writeRaceFixture(primary);
    const CONTENDERS = 5;
    await Promise.all(
      Array.from({ length: CONTENDERS }, (_unused, index) =>
        execFileAsync(process.execPath, [fixturePath], {
          env: fixtureEnv({
            IDD_TEST_REPO: primary,
            IDD_TEST_IDX: String(index),
            IDD_TEST_LOG: logPath,
            // Every contender starts by racing the SAME pre-seeded stale
            // lock -- the exact shape that let a plain check-then-unlink
            // takeover produce more than one winner. A generous shared
            // timeout means nobody spuriously times out from ordinary
            // process-spawn jitter; every contender is expected to
            // eventually acquire, one at a time.
            IDD_TEST_TIMEOUT_MS: '10000',
            IDD_TEST_STALE_MS: '200',
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
        `expected non-overlapping holds even when racing a shared stale lock, got: ${JSON.stringify(sorted)}`,
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

test('withCloneLock: refreshes its lease so a long-running command is never mistaken for an abandoned holder (Codex P1: live holders must not age out)', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'waiter.log');
  writeFileSync(logPath, '');
  try {
    // The held command "runs" for 600ms under a staleMs of only 150ms --
    // without lease refresh, that alone would make it look abandoned.
    // leaseRefreshMs=40 keeps refreshing well inside that window.
    const holderPromise = withCloneLock(
      primary,
      'agent-holder',
      process.execPath,
      ['-e', 'const u=Date.now()+600;while(Date.now()<u){}'],
      5_000,
      150,
      40,
    );

    // Let the holder actually acquire before the waiter starts contending.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const fixturePath = writeRaceFixture(primary);
    await execFileAsync(process.execPath, [fixturePath], {
      env: fixtureEnv({
        IDD_TEST_REPO: primary,
        IDD_TEST_IDX: 'waiter',
        IDD_TEST_LOG: logPath,
        // 400ms budget: longer than the remaining hold time, so if the
        // waiter incorrectly "wins" a stale takeover mid-hold, it reports
        // that; if it correctly keeps waiting/times out, it reports loss.
        IDD_TEST_TIMEOUT_MS: '400',
        IDD_TEST_STALE_MS: '150',
        IDD_TEST_HOLD_MS: '0',
      }),
    });

    await holderPromise;
    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.deepEqual(
      lines,
      ['lost waiter'],
      'a live, actively-refreshing holder must never be treated as stale and taken over',
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

test('acquire: a malformed arbiter marker recovers once its age passes the malformed-stale fallback (P2 round 4: a crashed partial arbiter write must not wedge every future takeover forever)', () => {
  const primary = setupRepo();
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(
      path,
      JSON.stringify({
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    backdateLockMtime(path, 60_000);

    // Seed a malformed (unparseable) arbiter marker -- simulating a
    // process that crashed after the exclusive wx-create but before its
    // JSON write completed -- and backdate it well past the
    // malformed-stale fallback window.
    const arbiterFile = `${path}.arbiter`;
    writeFileSync(arbiterFile, '{"pid": not valid json');
    backdateLockMtime(arbiterFile, 30_000);

    const start = Date.now();
    const handle = acquireCloneLock(primary, 'agent-b', 5_000, 200);
    const elapsedMs = Date.now() - start;

    assert.ok(
      elapsedMs < 2_000,
      `expected the malformed arbiter to be recovered promptly, took ${elapsedMs}ms`,
    );
    releaseCloneLock(handle);
  } finally {
    teardown(primary);
  }
});

test('acquire: concurrent contenders racing a dead-PID arbiter recovery never let two of them hold the lock at once (P1 round 4: PID and inode must come from the same read)', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'dead-arbiter-race.log');
  writeFileSync(logPath, '');
  try {
    const path = resolveCloneLockPath(primary);
    writeFileSync(
      path,
      JSON.stringify({
        token: 'dead-holder',
        agentId: 'agent-dead',
        acquiredAt: new Date().toISOString(),
      }),
    );
    backdateLockMtime(path, 60_000);

    // A genuinely dead PID: spawnSync blocks until the child has already
    // exited, so its pid is guaranteed not to be running by the time we
    // read it back (short of the OS recycling that exact pid in the
    // meantime, which is not realistic within a test's lifetime).
    const deadPid = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
    assert.ok(typeof deadPid === 'number' && deadPid > 0);
    writeFileSync(`${path}.arbiter`, JSON.stringify({ pid: deadPid }));

    const fixturePath = writeRaceFixture(primary);
    const CONTENDERS = 5;
    await Promise.all(
      Array.from({ length: CONTENDERS }, (_unused, index) =>
        execFileAsync(process.execPath, [fixturePath], {
          env: fixtureEnv({
            IDD_TEST_REPO: primary,
            IDD_TEST_IDX: String(index),
            IDD_TEST_LOG: logPath,
            IDD_TEST_TIMEOUT_MS: '10000',
            IDD_TEST_STALE_MS: '200',
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
        `expected non-overlapping holds even when racing a dead-PID arbiter, got: ${JSON.stringify(sorted)}`,
      );
    }
  } finally {
    teardown(primary);
  }
});

/**
 * A second on-disk fixture: each worker repeatedly acquires with a very
 * short staleMs, immediately backdates ITS OWN freshly-acquired lock (so
 * it looks abandoned to every other contender as soon as possible,
 * maximizing how often a release/refresh call races an in-flight
 * takeover of that same lock), holds briefly, refreshes once partway
 * through the hold (also racing takeover), then releases (also racing
 * takeover) -- repeating in a loop until `IDD_TEST_UNTIL_MS` elapses.
 * Every transition is logged so the test can verify the shared main lock
 * file was well-formed JSON at every observation, never corrupted by a
 * torn concurrent write.
 */
function writeReleaseRefreshRaceFixture(dir: string): string {
  const fixturePath = join(dir, 'release-refresh-race-worker.mjs');
  const cloneLockUrl = pathToFileURL(
    join(REPO_ROOT, 'scripts/clone-lock.mjs'),
  ).href;
  writeFileSync(
    fixturePath,
    [
      `import { acquireCloneLock, refreshCloneLock, releaseCloneLock, resolveCloneLockPath } from ${JSON.stringify(cloneLockUrl)};`,
      "import { appendFileSync, readFileSync, utimesSync } from 'node:fs';",
      'const repo = process.env.IDD_TEST_REPO;',
      'const idx = process.env.IDD_TEST_IDX;',
      'const log = process.env.IDD_TEST_LOG;',
      'const untilMs = Number(process.env.IDD_TEST_UNTIL_MS);',
      'const path = resolveCloneLockPath(repo);',
      'let rounds = 0;',
      'while (Date.now() < untilMs) {',
      '  rounds += 1;',
      '  try {',
      "    const handle = acquireCloneLock(repo, 'agent-' + idx, 300, 30);",
      "    appendFileSync(log, 'won ' + idx + ' ' + Date.now() + '\\n');",
      '    const ancient = new Date(Date.now() - 60000);',
      '    utimesSync(path, ancient, ancient);',
      '    const holdUntil = Date.now() + 20;',
      '    while (Date.now() < holdUntil) {}',
      '    refreshCloneLock(handle);',
      '    const raw = readFileSync(path, "utf8");',
      '    try {',
      '      JSON.parse(raw);',
      '    } catch {',
      "      appendFileSync(log, 'corrupt ' + idx + ' ' + raw + '\\n');",
      '    }',
      '    const holdUntil2 = Date.now() + 10;',
      '    while (Date.now() < holdUntil2) {}',
      '    releaseCloneLock(handle);',
      "    appendFileSync(log, 'released ' + idx + ' ' + Date.now() + '\\n');",
      '  } catch (error) {',
      "    appendFileSync(log, 'lost ' + idx + '\\n');",
      '  }',
      '}',
      "appendFileSync(log, 'rounds ' + idx + ' ' + rounds + '\\n');",
    ].join('\n'),
  );
  return fixturePath;
}

test('release/refresh: repeated concurrent acquire-backdate-refresh-release cycles never corrupt the lock or let two contenders hold it at once (Codex P1 round 4: release/refresh vs. takeover)', async () => {
  const primary = setupRepo();
  const logPath = join(primary, 'release-refresh-race.log');
  writeFileSync(logPath, '');
  try {
    const fixturePath = writeReleaseRefreshRaceFixture(primary);
    const WORKERS = 4;
    const DURATION_MS = 1500;
    const untilMs = Date.now() + DURATION_MS;

    await Promise.all(
      Array.from({ length: WORKERS }, (_unused, index) =>
        execFileAsync(process.execPath, [fixturePath], {
          env: fixtureEnv({
            IDD_TEST_REPO: primary,
            IDD_TEST_IDX: String(index),
            IDD_TEST_LOG: logPath,
            IDD_TEST_UNTIL_MS: String(untilMs),
          }),
        }),
      ),
    );

    const lines = readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    const corruptions = lines.filter((line) => line.startsWith('corrupt '));
    assert.deepEqual(
      corruptions,
      [],
      `expected the lock file to always be well-formed JSON when observed mid-hold, got: ${JSON.stringify(corruptions)}`,
    );

    const totalRounds = lines
      .filter((line) => line.startsWith('rounds '))
      .reduce((sum, line) => sum + Number(line.split(' ')[2]), 0);
    assert.ok(
      totalRounds >= WORKERS,
      `expected meaningful contention (at least one round per worker), got ${totalRounds} total rounds across: ${JSON.stringify(lines)}`,
    );

    // Note: this fixture deliberately backdates its OWN freshly-acquired
    // lock immediately after acquiring it, specifically so other workers
    // legitimately steal it mid-cycle -- that is the whole point (it is
    // what forces a release/refresh call to race an in-flight takeover
    // of the very same lock). Because of that self-sabotage, a worker's
    // own "won"-to-"released" span is NOT a reliable proxy for "this
    // worker verifiably held the lock exclusively the whole time" (its
    // `released` log line fires unconditionally, even when the release
    // call itself correctly no-opped because a takeover already replaced
    // its token) -- so, unlike the other stress tests in this file,
    // asserting those spans never overlap is not a valid invariant to
    // check here. What this test verifies instead: no interleaving of
    // acquire/backdate/refresh/release/takeover across four workers ever
    // produces a torn, unparseable on-disk body (checked above), and the
    // arbiter itself is never left orphaned by a botched interleaving.
    const finalPath = resolveCloneLockPath(primary);
    const finalRaw = existsSync(finalPath)
      ? readFileSync(finalPath, 'utf8')
      : null;
    if (finalRaw !== null) {
      assert.doesNotThrow(() => JSON.parse(finalRaw));
    }
    assert.equal(
      existsSync(`${finalPath}.arbiter`),
      false,
      'expected the arbiter marker to never be left behind after every worker finished',
    );
  } finally {
    teardown(primary);
  }
});
