import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';

import { stubExecutable } from './test-utils.mts';

function readAttempts(ledgerPath: string): Array<Record<string, unknown>> {
  return readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('caught unexpected real gh attempts still fail their owning process', () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-exit-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const missingGhPath = join(
    guardRoot,
    'missing',
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const source = `
const childProcess = require('node:child_process');
const shell = process.platform === 'win32'
  ? (process.env.ComSpec || 'cmd.exe')
  : '/bin/sh';
const shellFlag = process.platform === 'win32' ? '/c' : '-c';
const calls = [
  ['spawnSync', () => childProcess.spawnSync('gh', ['api', 'repos/o/r'])],
  ['execFileSync', () => childProcess.execFileSync(${JSON.stringify(missingGhPath)}, ['--token', 'secret-token-value'])],
  ['spawnSync shell', () => childProcess.spawnSync(shell, [shellFlag, 'gh api repos/o/r private-payload-should-not-be-recorded'])],
];
for (const [name, call] of calls) {
  try {
    call();
    process.exitCode = 2;
  } catch (error) {
    if (error.code !== 'IDD_UNEXPECTED_REAL_GH') {
      console.error(name + ': ' + error.message);
      process.exitCode = 3;
    }
  }
}
`;
  try {
    const result = spawnSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toLowerCase() !== 'path',
          ),
        ),
        [process.platform === 'win32' ? 'Path' : 'PATH']: guardRoot,
        IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /owning test process must fail/u);
    assert.deepEqual(
      readAttempts(ledgerPath).map((attempt) => attempt.api),
      ['spawnSync', 'execFileSync', 'spawnSync'],
    );
    const attempts = readAttempts(ledgerPath);
    assert.deepEqual(attempts[1]?.args, ['--token', '[redacted]']);
    assert.deepEqual(attempts[2]?.args, ['[shell command omitted]']);
    assert.doesNotMatch(
      readFileSync(ledgerPath, 'utf8'),
      /secret-token-value|private-payload-should-not-be-recorded/u,
    );
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('a caught child CLI attempt fails the owning test process through its shared ledger', () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-owner-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const childSource = `
const { execFileSync } = require('node:child_process');
try {
  execFileSync('gh', ['api', 'repos/o/r']);
} catch (error) {
  if (error.code !== 'IDD_UNEXPECTED_REAL_GH') process.exitCode = 2;
}
`;
  const ownerSource = `
const { spawnSync } = require('node:child_process');
const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(childSource)}], {
  encoding: 'utf8',
  env: { ...process.env, IDD_TEST_GH_GUARD_SELF_CHECK: '0' },
});
if (child.error || child.status !== 0) {
  process.stderr.write(child.stderr || child.error?.message || 'child failed');
  process.exitCode = 2;
}
`;
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env[process.platform === 'win32' ? 'Path' : 'PATH'] = guardRoot;
    env.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
    env.IDD_TEST_GH_GUARD_SELF_CHECK = '1';
    const result = spawnSync(process.execPath, ['-e', ownerSource], {
      encoding: 'utf8',
      env,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /owning test process must fail/u);
    const [attempt] = readAttempts(ledgerPath);
    assert.equal(attempt?.api, 'execFileSync');
    assert.notEqual(attempt?.pid, result.pid);
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('NODE_OPTIONS guards a Worker with empty execArgv and shares its ledger', async () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-worker-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const missingGhPath = join(
    guardRoot,
    'missing',
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
try {
  const result = spawnSync(workerData.ghPath, []);
  parentPort.postMessage({ returned: true, error: result.error?.code });
} catch (error) {
  parentPort.postMessage({ attemptId: error.iddGhGuardAttemptId });
}
`;
  try {
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      workerData: { ghPath: missingGhPath },
      env: {
        ...process.env,
        IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
        IDD_TEST_GH_GUARD_SELF_CHECK: '0',
      },
    });
    const messagePromise = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      },
    );
    const exitCodePromise = new Promise<number>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', resolve);
    });
    const [message, exitCode] = await Promise.all([
      messagePromise,
      exitCodePromise,
    ]);

    assert.equal(exitCode, 0);
    assert.match(String(message.attemptId), /^gh-/u);
    const [attempt] = readAttempts(ledgerPath);
    assert.equal(attempt?.api, 'spawnSync');
    assert.equal(attempt?.threadId, 1);
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('the paginated gh-exec Worker records caught attempts in its owner ledger', () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-paginate-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const modulePath = join(process.cwd(), 'src/scripts/gh-exec.mts');
  const source = `
import { ghApiJson } from ${JSON.stringify(modulePath)};
try {
  ghApiJson('repos/o/r/issues', { paginate: true, timeout: 1000 });
} catch {
  // The owner process must still fail from the worker's shared ledger.
}
`;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  env[process.platform === 'win32' ? 'Path' : 'PATH'] = guardRoot;
  try {
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        cwd: guardRoot,
        encoding: 'utf8',
        env: {
          ...env,
          IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
          IDD_TEST_GH_GUARD_SELF_CHECK: '1',
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const [attempt] = readAttempts(ledgerPath);
    assert.equal(attempt?.api, 'spawn');
    assert.equal(attempt?.executable, 'gh');
    assert.equal(attempt?.threadId, 1);
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('registered fixture gh paths work through nested stubs and paginated workers', () => {
  const restoreOuter = stubExecutable(
    'gh',
    "process.stdout.write('outer-fixture');",
  );
  try {
    const outerRoot = process.env.PATH?.split(delimiter)[0];
    assert.ok(outerRoot);
    const outerPath = join(
      outerRoot,
      process.platform === 'win32' ? 'gh.exe' : 'gh',
    );
    assert.equal(
      execFileSync(outerPath, [], { encoding: 'utf8' }),
      'outer-fixture',
    );

    const restoreInner = stubExecutable(
      'gh',
      'process.stdout.write(\'[{\\"id\\":7}]\\n\');',
    );
    try {
      const innerRoot = process.env.PATH?.split(delimiter)[0];
      assert.ok(innerRoot);
      const innerPath = join(
        innerRoot,
        process.platform === 'win32' ? 'gh.exe' : 'gh',
      );
      assert.deepEqual(
        JSON.parse(execFileSync(innerPath, [], { encoding: 'utf8' })),
        [{ id: 7 }],
      );

      const modulePath = join(process.cwd(), 'src/scripts/gh-exec.mts');
      const source = `
import { ghApiJson } from ${JSON.stringify(modulePath)};
process.stdout.write(JSON.stringify(ghApiJson('repos/o/r/issues', { paginate: true })));
`;
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', source],
        { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), [{ id: 7 }]);
    } finally {
      restoreInner();
    }

    const shell =
      process.platform === 'win32'
        ? process.env.ComSpec || 'cmd.exe'
        : '/bin/sh';
    const shellFlag = process.platform === 'win32' ? '/c' : '-c';
    const shellResult = spawnSync(shell, [shellFlag, 'gh'], {
      encoding: 'utf8',
    });
    assert.equal(shellResult.status, 0, shellResult.stderr);
    assert.equal(shellResult.stdout, 'outer-fixture');
  } finally {
    restoreOuter();
  }
});
