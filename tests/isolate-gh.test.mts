import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
  const registeredFixtureGh = join(
    guardRoot,
    'registered',
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
  ['spawnSync shell option', () => childProcess.spawnSync(shell, [shellFlag, 'gh api repos/o/r'], { shell: true })],
  ['spawnSync shell command', () => childProcess.spawnSync('printf', ['ok', '&&', 'gh api repos/o/r'], { shell: true })],
  ['spawnSync ksh', () => childProcess.spawnSync('ksh', ['-c', 'gh api repos/o/r'])],
  ['spawnSync registered fixture shell', () => childProcess.spawnSync(${JSON.stringify(registeredFixtureGh)}, ['--version', '&&', 'gh', 'api'], { shell: true })],
  ['spawnSync null args placeholder', () => childProcess.spawnSync('printf ok && gh api repos/o/r', null, { shell: true })],
  ['spawn undefined args placeholder', () => childProcess.spawn('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['execFile null args placeholder', () => childProcess.execFile('printf ok && gh api repos/o/r', null, { shell: true })],
  ['execFileSync undefined args placeholder', () => childProcess.execFileSync('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['fork null args placeholder', () => childProcess.fork('unused-worker.cjs', null, { execPath: ${JSON.stringify(missingGhPath)} }).on('error', () => {})],
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
        IDD_TEST_GH_GUARD_ALLOWED_STUBS: JSON.stringify([registeredFixtureGh]),
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /owning test process must fail/u);
    assert.deepEqual(
      readAttempts(ledgerPath).map((attempt) => attempt.api),
      [
        'spawnSync',
        'execFileSync',
        'spawnSync',
        'spawnSync',
        'spawnSync',
        'spawnSync',
        'spawnSync',
        'spawnSync',
        'spawn',
        'execFile',
        'execFileSync',
        'fork',
      ],
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

test('Worker guards honor nullish child-process argument placeholders', async () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-nullish-worker-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const missingGhPath = join(
    guardRoot,
    'missing',
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const workerSource = `
const { parentPort } = require('node:worker_threads');
const childProcess = require('node:child_process');
const calls = [
  ['spawnSync', () => childProcess.spawnSync('printf ok && gh api repos/o/r', null, { shell: true })],
  ['spawn', () => childProcess.spawn('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['execFile', () => childProcess.execFile('printf ok && gh api repos/o/r', null, { shell: true })],
  ['execFileSync', () => childProcess.execFileSync('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['fork', () => childProcess.fork('unused-worker.cjs', undefined, { execPath: ${JSON.stringify(missingGhPath)} }).on('error', () => {})],
];
const results = calls.map(([name, call]) => {
  try {
    call();
    return { name, code: 'not-blocked' };
  } catch (error) {
    return { name, code: error.code };
  }
});
parentPort.postMessage(results);
parentPort.close();
`;
  const workerEnv = { ...process.env };
  for (const key of Object.keys(workerEnv)) {
    if (key.toLowerCase() === 'path') delete workerEnv[key];
  }
  workerEnv[process.platform === 'win32' ? 'Path' : 'PATH'] = guardRoot;
  workerEnv.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
  workerEnv.IDD_TEST_GH_GUARD_ALLOWED_STUBS = '[]';
  const worker = new Worker(workerSource, {
    eval: true,
    env: workerEnv,
  });
  const messagePromise = new Promise<Array<{ name: string; code: string }>>(
    (resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    },
  );
  const exitPromise = new Promise<number>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', resolve);
  });
  try {
    const [results, exitCode] = await Promise.all([
      messagePromise,
      exitPromise,
    ]);

    assert.equal(exitCode, 0);
    assert.deepEqual(
      results,
      ['spawnSync', 'spawn', 'execFile', 'execFileSync', 'fork'].map(
        (name) => ({ name, code: 'IDD_UNEXPECTED_REAL_GH' }),
      ),
    );
    assert.deepEqual(
      readAttempts(ledgerPath).map((attempt) => attempt.api),
      ['spawnSync', 'spawn', 'execFile', 'execFileSync', 'fork'],
    );
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('promisified exec and execFile custom handlers keep the ESM guard', () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-promisify-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const source = `
const { promisify } = require('node:util');
const { exec, execFile } = require('node:child_process');
Promise.all([
  promisify(execFile)('gh', ['api', 'repos/o/r']).then(
    () => { process.exitCode = 2; },
    (error) => { if (error.code !== 'IDD_UNEXPECTED_REAL_GH') process.exitCode = 3; },
  ),
  promisify(exec)('gh api repos/o/r').then(
    () => { process.exitCode = 2; },
    (error) => { if (error.code !== 'IDD_UNEXPECTED_REAL_GH') process.exitCode = 3; },
  ),
]);
`;
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env[process.platform === 'win32' ? 'Path' : 'PATH'] = guardRoot;
    const result = spawnSync(process.execPath, ['-e', source], {
      encoding: 'utf8',
      env: {
        ...env,
        IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /owning test process must fail/u);
    assert.deepEqual(
      readAttempts(ledgerPath)
        .map((attempt) => attempt.api)
        .sort(),
      ['exec', 'execFile'],
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
  parentPort.postMessage({
    attemptId: error.iddGhGuardAttemptId,
    filename: __filename,
    dirname: __dirname,
    argv: process.argv,
  });
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
    assert.equal(message.filename, '[worker eval]');
    assert.equal(message.dirname, '.');
    assert.equal((message.argv as unknown[])[1], '[worker eval]');
    const [attempt] = readAttempts(ledgerPath);
    assert.equal(attempt?.api, 'spawnSync');
    assert.ok(Number(attempt?.threadId) > 0);
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('guarded Workers preserve eval-import and ESM-entry main semantics', async () => {
  const workerRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-main-worker-'));
  const entryPath = join(workerRoot, 'entry.mjs');
  writeFileSync(
    entryPath,
    [
      "import { parentPort } from 'node:worker_threads';",
      'parentPort.postMessage({ isMain: import.meta.main });',
      'parentPort.close();',
    ].join('\n'),
    'utf8',
  );
  try {
    const worker = new Worker(
      [
        "const { parentPort, workerData } = require('node:worker_threads');",
        'import(workerData.entryUrl).catch((error) => {',
        '  parentPort.postMessage({ error: error.message });',
        '});',
      ].join('\n'),
      {
        eval: true,
        workerData: { entryUrl: pathToFileURL(entryPath).href },
      },
    );
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
    assert.deepEqual(message, { isMain: false });

    const fileWorker = new Worker(entryPath, { execArgv: [] });
    const fileMessagePromise = new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        fileWorker.once('message', resolve);
        fileWorker.once('error', reject);
      },
    );
    const fileExitCodePromise = new Promise<number>((resolve, reject) => {
      fileWorker.once('error', reject);
      fileWorker.once('exit', resolve);
    });
    const [fileMessage, fileExitCode] = await Promise.all([
      fileMessagePromise,
      fileExitCodePromise,
    ]);

    assert.equal(fileExitCode, 0);
    assert.deepEqual(fileMessage, { isMain: true });
  } finally {
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test('guarded CJS file Workers preserve their main module and argv', async () => {
  const workerRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-file-worker-'));
  const workerPath = join(workerRoot, 'worker.cjs');
  writeFileSync(
    workerPath,
    [
      "const { parentPort } = require('node:worker_threads');",
      'parentPort.postMessage({',
      '  filename: __filename,',
      '  dirname: __dirname,',
      '  main: require.main?.filename,',
      '  argv: process.argv,',
      '});',
    ].join('\n'),
    'utf8',
  );
  try {
    const worker = new Worker(workerPath, {
      argv: ['idd-worker-argument'],
      env: { ...process.env, IDD_TEST_GH_GUARD_SELF_CHECK: '0' },
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
    assert.equal(message.filename, workerPath);
    assert.equal(message.dirname, workerRoot);
    assert.equal(message.main, workerPath);
    assert.equal((message.argv as unknown[])[1], workerPath);
    assert.equal((message.argv as unknown[])[2], 'idd-worker-argument');
  } finally {
    rmSync(workerRoot, { recursive: true, force: true });
  }
});

test('the paginated gh-exec Worker records caught attempts in its owner ledger', () => {
  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-paginate-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  writeFileSync(join(guardRoot, 'package.json'), '{', 'utf8');
  const modulePath = join(process.cwd(), 'src/scripts/gh-exec.mts');
  const registeredFixtureGh = join(
    guardRoot,
    'registered',
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellFlag = process.platform === 'win32' ? '/c' : '-c';
  const quotedFixtureGh = `"${registeredFixtureGh.replaceAll('"', '\\"')}"`;
  const mixedFixtureCommand = `${quotedFixtureGh} --version && gh api repos/o/r`;
  const source = `
import { ghApiJson } from ${JSON.stringify(modulePath)};
import { Worker } from 'node:worker_threads';
try {
  ghApiJson('repos/o/r/issues', { paginate: true, timeout: 1000 });
} catch {
  // The owner process must still fail from the worker's shared ledger.
}
const worker = new Worker(\`
  const { parentPort, workerData } = require('node:worker_threads');
  const { exec, execFile, spawnSync } = require('node:child_process');
  const { promisify } = require('node:util');
  const calls = [
    promisify(execFile)(workerData.ghPath, ['api', 'repos/o/r']),
    promisify(exec)('gh api repos/o/r'),
  ].map((promise) => promise.then(() => null, (error) => error.code));
  try {
    spawnSync(workerData.shell, [workerData.shellFlag, workerData.mixedFixtureCommand]);
    calls.push(Promise.resolve('not-blocked'));
  } catch (error) {
    calls.push(Promise.resolve(error.code));
  }
  try {
    spawnSync(workerData.registeredFixtureGh, ['--version', '&&', 'gh', 'api'], { shell: true });
    calls.push(Promise.resolve('not-blocked'));
  } catch (error) {
    calls.push(Promise.resolve(error.code));
  }
  Promise.all(calls).then((codes) => parentPort.postMessage(codes));
\`, {
  eval: true,
  execArgv: [],
  workerData: {
    ghPath: ${JSON.stringify(join(guardRoot, 'missing', process.platform === 'win32' ? 'gh.exe' : 'gh'))},
    shell: ${JSON.stringify(shell)},
    shellFlag: ${JSON.stringify(shellFlag)},
    mixedFixtureCommand: ${JSON.stringify(mixedFixtureCommand)},
    registeredFixtureGh: ${JSON.stringify(registeredFixtureGh)},
  },
});
await new Promise((resolve, reject) => {
  worker.once('message', resolve);
  worker.once('error', reject);
});
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
          IDD_TEST_GH_GUARD_ALLOWED_STUBS: JSON.stringify([
            registeredFixtureGh,
          ]),
          IDD_TEST_GH_GUARD_SELF_CHECK: '1',
        },
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    let attempts: Array<Record<string, unknown>>;
    try {
      attempts = readAttempts(ledgerPath);
    } catch (error) {
      assert.fail(
        `expected the guarded Worker to write its attempt ledger: ${String(error)}\n${result.stderr}`,
      );
    }
    assert.deepEqual(attempts.map((attempt) => attempt.api).sort(), [
      'exec',
      'execFile',
      'spawn',
      'spawnSync',
      'spawnSync',
    ]);
    assert.ok(attempts.every((attempt) => Number(attempt.threadId) > 0));
    assert.ok(attempts.some((attempt) => attempt.executable === 'gh'));
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('registered fixture gh paths work through nested stubs and paginated workers', async () => {
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
    const callbackOutput = await new Promise<string>((resolve, reject) => {
      execFile(outerPath, [], { encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    assert.equal(callbackOutput, 'outer-fixture');
    const promisedOutput = await promisify(execFile)(outerPath, [], {
      encoding: 'utf8',
    });
    assert.equal(promisedOutput.stdout, 'outer-fixture');
    assert.equal(promisedOutput.stderr, '');

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

    const fixtureWorkerSource = [
      "const { parentPort, workerData } = require('node:worker_threads');",
      "const { execFile } = require('node:child_process');",
      "const { promisify } = require('node:util');",
      "const result = promisify(execFile)(workerData.ghPath, [], { encoding: 'utf8' });",
      'result.then(({ stdout, stderr }) => {',
      '  parentPort.postMessage({ stdout, stderr, hasChild: Boolean(result.child) });',
      '}, (error) => {',
      '  parentPort.postMessage({ error: error.message });',
      '});',
    ].join('\n');
    const fixtureWorker = new Worker(fixtureWorkerSource, {
      eval: true,
      workerData: { ghPath: outerPath },
    });
    const fixtureWorkerResult = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        fixtureWorker.once('message', resolve);
        fixtureWorker.once('error', reject);
      },
    );
    assert.deepEqual(fixtureWorkerResult, {
      stdout: 'outer-fixture',
      stderr: '',
      hasChild: true,
    });
  } finally {
    restoreOuter();
  }
});
