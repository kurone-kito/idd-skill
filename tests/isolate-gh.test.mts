import assert from 'node:assert/strict';
import {
  execFile,
  execFileSync,
  type SpawnSyncReturns,
  spawn,
  spawnSync,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { SHARE_ENV, Worker, type WorkerOptions } from 'node:worker_threads';

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
  const registeredFixtureBin = join(guardRoot, 'registered-bin');
  const registeredPathFixtureGh = join(
    registeredFixtureBin,
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const unregisteredBin = join(guardRoot, 'unregistered-bin');
  const missingPathCwd = join(guardRoot, 'missing-path-cwd');
  const missingPathGh = join(
    missingPathCwd,
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const unregisteredGh = join(
    unregisteredBin,
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  if (process.platform !== 'win32') {
    mkdirSync(registeredFixtureBin, { recursive: true });
    mkdirSync(unregisteredBin, { recursive: true });
    mkdirSync(missingPathCwd, { recursive: true });
    writeFileSync(registeredPathFixtureGh, '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    writeFileSync(unregisteredGh, '#!/bin/sh\nexit 0\n', 'utf8');
    writeFileSync(missingPathGh, '#!/bin/sh\nexit 0\n', 'utf8');
  }
  const backtickSubstitutionCommand = `printf "%s" "\`gh api repos/o/r\`"`;
  const continuedCommentCommand = ['echo x\\', '# "$(gh api repos/o/r)"'].join(
    '\n',
  );
  const parameterLengthCommand = `n=\${#x}; gh api repos/o/r`;
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
  ...(process.platform === 'win32'
    ? []
    : [
        ['spawnSync quoted command substitution', () => childProcess.spawnSync(shell, [shellFlag, 'printf "%s" "$(gh api repos/o/r)"'])],
        ['spawnSync quoted backtick substitution', () => childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify(backtickSubstitutionCommand)}])],
        ['spawnSync env wrapper', () => childProcess.spawnSync('/usr/bin/env', ['gh', 'api', 'repos/o/r'])],
        ['spawnSync env PATH override', () => childProcess.spawnSync('/usr/bin/env', ['PATH=' + ${JSON.stringify(unregisteredBin)}, 'gh', 'api', 'repos/o/r'], { env: { ...process.env, PATH: ${JSON.stringify(registeredFixtureBin)} } })],
        ['spawnSync shell env PATH override', () => childProcess.spawnSync(shell, [shellFlag, 'env PATH=' + ${JSON.stringify(unregisteredBin)} + ' gh api repos/o/r'])],
        ['spawnSync env credential', () => childProcess.spawnSync('/usr/bin/env', ['GH_TOKEN=opaque-secret-value', 'gh', 'api', 'repos/o/r'])],
        ['spawnSync env split gh', () => childProcess.spawnSync('/usr/bin/env', ['-S', 'FOO=harmless GH_TOKEN=opaque-secret-value gh --token split-secret-value api repos/o/r'])],
        ['spawnSync env deep wrapper', () => childProcess.spawnSync('/usr/bin/env', [...Array(9).fill('env'), 'gh', 'api', 'repos/o/r'])],
        ['spawnSync env default signal', () => childProcess.spawnSync('/usr/bin/env', ['--default-signal', 'gh', 'api', 'repos/o/r'])],
        ['spawnSync env ignore signal', () => childProcess.spawnSync('/usr/bin/env', ['--ignore-signal', 'gh', 'api', 'repos/o/r'])],
        ['spawnSync env assignment after terminator', () => childProcess.spawnSync('/usr/bin/env', ['--', 'PATH=' + ${JSON.stringify(unregisteredBin)}, 'gh', 'api', 'repos/o/r'])],
        ['spawnSync gh with missing PATH', () => { process.chdir(${JSON.stringify(missingPathCwd)}); const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path')); return childProcess.spawnSync('gh', ['api', 'repos/o/r'], { env }); }],
        ['spawnSync shell line continuation substitution', () => childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify(continuedCommentCommand)}])],
        ['spawnSync unquoted here-document substitution', () => childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify("cat <<EOF\n'$(\ngh api repos/o/r\n)'\nEOF")}])],
        ['spawnSync unterminated here-document substitution', () => childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify("cat <<EOF\n'$(\ngh api repos/o/r\n)'")}])],
        ['spawnSync shell bundled command flag', () => childProcess.spawnSync(shell, ['-lc', 'gh api repos/o/r'])],
        ['spawnSync shell command wrapper options', () => childProcess.spawnSync(shell, [shellFlag, 'command -p gh api repos/o/r'])],
        ['spawnSync shell sudo wrapper options', () => childProcess.spawnSync(shell, [shellFlag, 'sudo -u nobody gh api repos/o/r'])],
        ['spawnSync shell negation operator', () => childProcess.spawnSync(shell, [shellFlag, '! gh api repos/o/r'])],
        ['spawnSync shell output redirection before command', () => childProcess.spawnSync(shell, [shellFlag, '>redirect-target gh api repos/o/r'])],
        ['spawnSync shell input redirection before command', () => childProcess.spawnSync(shell, [shellFlag, '<redirect-source gh api repos/o/r'])],
        ['spawnSync shell parameter length expansion', () => childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify(parameterLengthCommand)}])],
      ]),
  ...(process.platform === 'win32'
    ? [['spawnSync PowerShell substitution', () => childProcess.spawnSync('pwsh', ['-Command', 'Write-Output "$(gh api repos/o/r)"'])]]
    : []),
  ['spawnSync registered fixture shell', () => childProcess.spawnSync(${JSON.stringify(registeredFixtureGh)}, ['--version', '&&', 'gh', 'api'], { shell: true })],
  ['spawnSync null args placeholder', () => childProcess.spawnSync('printf ok && gh api repos/o/r', null, { shell: true })],
  ['spawn undefined args placeholder', () => childProcess.spawn('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['execFile null args placeholder', () => childProcess.execFile('printf ok && gh api repos/o/r', null, { shell: true })],
  ['execFileSync undefined args placeholder', () => childProcess.execFileSync('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['fork null args placeholder', () => childProcess.fork('unused-worker.cjs', null, { execPath: ${JSON.stringify(missingGhPath)} }).on('error', () => {})],
  ['execFileSync equals token', () => childProcess.execFileSync(${JSON.stringify(missingGhPath)}, ['--token=secret-token-value'])],
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
if (process.platform !== 'win32') {
  try {
    childProcess.spawnSync('/usr/bin/env', ['-S', 'printf ok; gh api repos/o/r']);
  } catch (error) {
    process.exitCode = 4;
  }
  try {
    childProcess.spawnSync(shell, [shellFlag, 'echo ok # "$(gh api repos/o/r)"']);
  } catch {
    process.exitCode = 4;
  }
  try {
    childProcess.spawnSync(shell, [shellFlag, ${JSON.stringify('cat <<\'EOF\'\n"$(gh api repos/o/r)"\nEOF')}]);
  } catch {
    process.exitCode = 4;
  }
  const pathAssignmentResult = childProcess.spawnSync(
    shell,
    [shellFlag, 'PATH=' + ${JSON.stringify(registeredFixtureBin)} + ' gh --version'],
    { env: { ...process.env, PATH: ${JSON.stringify(unregisteredBin)} } },
  );
  if (pathAssignmentResult.status !== 0) process.exitCode = 4;
} else {
  try {
    childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'echo $(gh api repos/o/r)']);
  } catch {
    process.exitCode = 4;
  }
  try {
    childProcess.spawnSync('pwsh', ['-Command', '<# "$(gh api repos/o/r)" #> Write-Output ok']);
  } catch {
    process.exitCode = 4;
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
        IDD_TEST_GH_GUARD_ALLOWED_STUBS: JSON.stringify([
          registeredFixtureGh,
          ...(process.platform === 'win32'
            ? []
            : [registeredPathFixtureGh, missingPathGh]),
        ]),
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /owning test process must fail/u);
    const expectedApis = [
      'spawnSync',
      'execFileSync',
      'spawnSync',
      'spawnSync',
      'spawnSync',
      'spawnSync',
      ...(process.platform === 'win32'
        ? []
        : [
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
            'spawnSync',
          ]),
      ...(process.platform === 'win32' ? ['spawnSync'] : []),
      'spawnSync',
      'spawnSync',
      'spawn',
      'execFile',
      'execFileSync',
      'fork',
      'execFileSync',
    ];
    assert.deepEqual(
      readAttempts(ledgerPath).map((attempt) => attempt.api),
      expectedApis,
    );
    const attempts = readAttempts(ledgerPath);
    assert.deepEqual(attempts[1]?.args, ['--token', '[redacted]']);
    const equalsTokenAttempt = attempts.find(
      (attempt) =>
        Array.isArray(attempt.args) && attempt.args[0] === '--token=[redacted]',
    );
    assert.deepEqual(equalsTokenAttempt?.args, ['--token=[redacted]']);
    assert.deepEqual(attempts[2]?.args, ['[shell command omitted]']);
    if (process.platform !== 'win32') {
      assert.deepEqual(attempts[9]?.args, [
        'PATH=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
      assert.deepEqual(attempts[11]?.args, [
        'GH_TOKEN=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
      assert.equal(attempts[9]?.resolvedExecutable, unregisteredGh);
      assert.deepEqual(attempts[12]?.args, ['-S', '[split string omitted]']);
      assert.equal(
        attempts[13]?.executable,
        'env wrapper with unresolved command',
      );
      assert.deepEqual(attempts[16]?.args, [
        '--',
        'PATH=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
      assert.notEqual(attempts[17]?.resolvedExecutable, missingPathGh);
    }
    assert.doesNotMatch(
      readFileSync(ledgerPath, 'utf8'),
      /secret-token-value|private-payload-should-not-be-recorded|opaque-secret-value|split-secret-value/u,
    );
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('guards resolve effective cwd and inspect executable launch wrappers', (t) => {
  if (process.platform === 'win32') {
    t.skip('covers POSIX executable wrappers and relative PATH entries');
    return;
  }

  const guardRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-launch-test-'));
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const childCwd = join(guardRoot, 'child-cwd');
  const registeredBin = join(guardRoot, 'bin');
  const unregisteredBin = join(guardRoot, 'unregistered-bin');
  const markerPath = join(guardRoot, 'gh-dispatched');
  const shellScriptPath = join(guardRoot, 'unexpected-gh.sh');
  const registeredGh = join(registeredBin, 'gh');
  const unregisteredGh = join(unregisteredBin, 'gh');
  const cwdGh = join(childCwd, 'bin', 'gh');
  const fixtureGh = join(guardRoot, 'registered-gh', 'gh');
  const script = `#!/bin/sh\nprintf invoked >> ${JSON.stringify(markerPath)}\n`;
  mkdirSync(registeredBin, { recursive: true });
  mkdirSync(unregisteredBin, { recursive: true });
  mkdirSync(join(childCwd, 'bin'), { recursive: true });
  mkdirSync(join(guardRoot, 'registered-gh'), { recursive: true });
  writeFileSync(registeredGh, '#!/bin/sh\nexit 0\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
  writeFileSync(fixtureGh, '#!/bin/sh\nexit 0\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
  writeFileSync(shellScriptPath, '#!/bin/sh\ngh api repos/o/r\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
  for (const executable of [unregisteredGh, cwdGh]) {
    writeFileSync(executable, script, { encoding: 'utf8', mode: 0o755 });
  }

  const paths = {
    childCwd,
    fixtureCwd: guardRoot,
    fixtureGh,
    registeredBin,
    shellScriptPath,
    shellGhPath: unregisteredGh,
  };
  const checks = `
const runChecks = (paths) => {
  const childProcess = require('node:child_process');
  const cases = [
    ['relative child cwd', () => childProcess.spawnSync('gh', ['api'], { cwd: paths.childCwd, env: { ...process.env, PATH: 'bin' } })],
    ['env chdir relative PATH', () => childProcess.spawnSync('/usr/bin/env', ['-C', paths.childCwd, 'PATH=bin', 'gh', 'api'])],
    ['gh custom shell', () => childProcess.spawnSync('printf', ['ok'], { shell: paths.shellGhPath })],
    ['nohup argv wrapper', () => childProcess.spawnSync('nohup', ['gh', 'api'])],
    ['time argv wrapper', () => childProcess.spawnSync('time', ['gh', 'api'])],
    ['xargs argv wrapper', () => childProcess.spawnSync('xargs', ['gh', 'api'])],
    ['env split wrapper chain', () => childProcess.spawnSync('/usr/bin/env', ['-S', 'nohup gh api'])],
    ['xargs shell wrapper', () => childProcess.spawnSync('/bin/sh', ['-c', 'printf x | xargs -n 1 gh api'])],
    ['command -p shell wrapper', () => childProcess.spawnSync('/bin/sh', ['-c', 'command -p gh api'])],
    ['command -p ignores a registered PATH fixture', () => childProcess.spawnSync('/bin/sh', ['-c', 'command -p gh api'], { env: { ...process.env, PATH: paths.registeredBin } })],
    ['timeout shell wrapper', () => childProcess.spawnSync('/bin/sh', ['-c', 'timeout 2 gh api'])],
    ['eval payload', () => childProcess.spawnSync('/bin/sh', ['-c', 'eval "gh api repos/o/r"'])],
    ['nested shell payload', () => childProcess.spawnSync('/bin/sh', ['-c', 'sh -c "gh api repos/o/r"'])],
    ['escaped command word', () => childProcess.spawnSync('/bin/sh', ['-c', '\\gh api repos/o/r'])],
    ['escaped character in command word', () => childProcess.spawnSync('/bin/sh', ['-c', 'g\\\\h api repos/o/r'])],
    ['shell script path', () => childProcess.spawnSync('/bin/sh', [paths.shellScriptPath])],
    ['shell cwd after separator', () => childProcess.spawnSync('/bin/sh', ['-c', 'cd ' + paths.childCwd + ' && PATH=bin gh api'])],
    ['shell assignment expands command name', () => childProcess.spawnSync('/bin/sh', ['-c', 'tool=gh; "$tool" api repos/o/r'])],
    ['unresolved command expansion fails closed', () => childProcess.spawnSync('/bin/sh', ['-c', '"$UNSET_GH_COMMAND" api'])],
    ['sudo chdir shell wrapper', () => childProcess.spawnSync('/bin/sh', ['-c', 'sudo --chdir ' + paths.childCwd + ' gh api'])],
    ['sudo chdir argv wrapper', () => childProcess.spawnSync('sudo', ['--chdir', paths.childCwd, 'gh', 'api'])],
    ['sudo chdir equals argv wrapper', () => childProcess.spawnSync('sudo', ['--chdir=' + paths.childCwd, 'gh', 'api'])],
    ['fork inspects full executable argv', () => childProcess.fork('unused-worker.cjs', ['api'], { execPath: '/usr/bin/env', execArgv: ['gh'] }).on('error', () => {})],
    ['execSync uses the platform shell', () => childProcess.execSync('gh api repos/o/r')],
    ['cmd call wrapper', () => childProcess.spawnSync(process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'cmd.exe', ['/c', 'call gh api repos/o/r'])],
    ['multiline quoted literal', () => childProcess.spawnSync('/bin/sh', ['-c', 'printf "%s" "first\\n# gh api repos/o/r\\nlast"'])],
    ['multiline quoted comment', () => childProcess.spawnSync('/bin/sh', ['-c', 'printf "%s" "line one\\n# $(gh api repos/o/r)\\nline three"'])],
    ['registered relative fixture cwd', () => {
      const result = childProcess.spawnSync('gh', ['--version'], {
        cwd: paths.fixtureCwd,
        env: { ...process.env, PATH: 'registered-gh' },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error('registered relative fixture exited unsuccessfully');
      }
    }],
  ];
  return cases.map(([name, call]) => {
    try {
      call();
      return { name, code: 'not-blocked' };
    } catch (error) {
      return { name, code: error.code };
    }
  });
};
`;
  const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
${checks}
parentPort.postMessage(runChecks(workerData));
`;
  const source = `
const { Worker } = require('node:worker_threads');
${checks}
(async () => {
  const paths = ${JSON.stringify(paths)};
  const results = runChecks(paths);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'node_options') delete env[key];
  const worker = new Worker(${JSON.stringify(workerSource)}, {
    eval: true,
    execArgv: [],
    env,
    workerData: paths,
  });
  const nested = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  process.stdout.write(JSON.stringify({ results, nested }));
})();
`;

  try {
    const child = spawnSync(process.execPath, ['-e', source], {
      cwd: guardRoot,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !['path', 'node_options'].includes(key.toLowerCase()),
          ),
        ),
        PATH: unregisteredBin,
        IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
        IDD_TEST_GH_GUARD_ALLOWED_STUBS: JSON.stringify([
          registeredGh,
          fixtureGh,
        ]),
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });

    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /owning test process must fail/u);
    const { results, nested } = JSON.parse(child.stdout) as {
      results: Array<{ name: string; code: string }>;
      nested: Array<{ name: string; code: string }>;
    };
    for (const result of [...results, ...nested]) {
      if (
        result.name === 'registered relative fixture cwd' ||
        result.name === 'multiline quoted literal'
      ) {
        assert.equal(result.code, 'not-blocked', result.name);
      } else {
        assert.equal(result.code, 'IDD_UNEXPECTED_REAL_GH', result.name);
      }
    }
    const attempts = readAttempts(ledgerPath);
    assert.equal(
      attempts.length,
      [...results, ...nested].filter(
        (result) =>
          result.name !== 'registered relative fixture cwd' &&
          result.name !== 'multiline quoted literal',
      ).length,
    );
    assert.ok(attempts.some((attempt) => Number(attempt.threadId) > 0));
    assert.equal(existsSync(markerPath), false);
    assert.doesNotMatch(readFileSync(ledgerPath, 'utf8'), /secret|token/u);
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
  const registeredBin = join(guardRoot, 'registered-bin');
  const registeredGh = join(
    registeredBin,
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const unregisteredBin = join(guardRoot, 'unregistered-bin');
  const unregisteredGh = join(
    unregisteredBin,
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  if (process.platform !== 'win32') {
    mkdirSync(registeredBin, { recursive: true });
    mkdirSync(unregisteredBin, { recursive: true });
    writeFileSync(registeredGh, '#!/bin/sh\nexit 0\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
    writeFileSync(unregisteredGh, '#!/bin/sh\nexit 0\n', 'utf8');
  }
  const continuedCommentCommand = ['echo x\\', '# "$(gh api repos/o/r)"'].join(
    '\n',
  );
  const parameterLengthCommand = `n=\${#x}; gh api repos/o/r`;
  const workerSource = `
const { parentPort } = require('node:worker_threads');
const childProcess = require('node:child_process');
const cmdShell = process.platform === 'win32'
  ? (process.env.ComSpec || 'cmd.exe')
  : 'cmd.exe';
const calls = [
  ['spawnSync', () => childProcess.spawnSync('printf ok && gh api repos/o/r', null, { shell: true })],
  ['spawn', () => childProcess.spawn('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['execFile', () => childProcess.execFile('printf ok && gh api repos/o/r', null, { shell: true })],
  ['execFileSync', () => childProcess.execFileSync('printf ok && gh api repos/o/r', undefined, { shell: true })],
  ['fork', () => childProcess.fork('unused-worker.cjs', undefined, { execPath: ${JSON.stringify(missingGhPath)} }).on('error', () => {})],
  ['execSync', () => childProcess.execSync('gh api repos/o/r')],
  ['cmd call wrapper', () => childProcess.spawnSync(cmdShell, ['/c', 'call gh api repos/o/r'])],
  ...(process.platform === 'win32' ? [] : [
    ['spawnSync env PATH override', () => childProcess.spawnSync('/usr/bin/env', ['PATH=' + ${JSON.stringify(unregisteredBin)}, 'gh', 'api', 'repos/o/r'], { env: { ...process.env, PATH: ${JSON.stringify(registeredBin)} } })],
    ['spawnSync env credential', () => childProcess.spawnSync('/usr/bin/env', ['GH_TOKEN=opaque-secret-value', 'gh', 'api', 'repos/o/r'])],
    ['spawnSync env split gh', () => childProcess.spawnSync('/usr/bin/env', ['-S', 'FOO=harmless GH_TOKEN=opaque-secret-value gh --token split-secret-value api repos/o/r'])],
    ['spawnSync env deep wrapper', () => childProcess.spawnSync('/usr/bin/env', [...Array(9).fill('env'), 'gh', 'api', 'repos/o/r'])],
    ['spawnSync env default signal', () => childProcess.spawnSync('/usr/bin/env', ['--default-signal', 'gh', 'api', 'repos/o/r'])],
    ['spawnSync env ignore signal', () => childProcess.spawnSync('/usr/bin/env', ['--ignore-signal', 'gh', 'api', 'repos/o/r'])],
    ['spawnSync env assignment after terminator', () => childProcess.spawnSync('/usr/bin/env', ['--', 'PATH=' + ${JSON.stringify(unregisteredBin)}, 'gh', 'api', 'repos/o/r'])],
    ['spawnSync shell line continuation substitution', () => childProcess.spawnSync('/bin/sh', ['-c', ${JSON.stringify(continuedCommentCommand)}])],
    ['spawnSync unquoted here-document substitution', () => childProcess.spawnSync('/bin/sh', ['-c', ${JSON.stringify("cat <<EOF\n'$(\ngh api repos/o/r\n)'\nEOF")}])],
    ['spawnSync unterminated here-document substitution', () => childProcess.spawnSync('/bin/sh', ['-c', ${JSON.stringify("cat <<EOF\n'$(\ngh api repos/o/r\n)'")}])],
    ['spawnSync shell bundled command flag', () => childProcess.spawnSync('/bin/sh', ['-lc', 'gh api repos/o/r'])],
    ['spawnSync shell command wrapper options', () => childProcess.spawnSync('/bin/sh', ['-c', 'command -p gh api repos/o/r'])],
    ['spawnSync shell sudo wrapper options', () => childProcess.spawnSync('/bin/sh', ['-c', 'sudo -u nobody gh api repos/o/r'])],
    ['spawnSync shell negation operator', () => childProcess.spawnSync('/bin/sh', ['-c', '! gh api repos/o/r'])],
    ['spawnSync shell output redirection before command', () => childProcess.spawnSync('/bin/sh', ['-c', '>redirect-target gh api repos/o/r'])],
    ['spawnSync shell input redirection before command', () => childProcess.spawnSync('/bin/sh', ['-c', '<redirect-source gh api repos/o/r'])],
    ['spawnSync shell PATH assignment override', () => childProcess.spawnSync('/bin/sh', ['-c', 'PATH=' + ${JSON.stringify(unregisteredBin)} + ' gh api repos/o/r'], { env: { ...process.env, PATH: ${JSON.stringify(registeredBin)} } })],
    ['spawnSync shell parameter length expansion', () => childProcess.spawnSync('/bin/sh', ['-c', ${JSON.stringify(parameterLengthCommand)}])],
  ]),
  ...(process.platform === 'win32'
    ? [['spawnSync PowerShell substitution', () => childProcess.spawnSync('pwsh', ['-Command', 'Write-Output "$(gh api repos/o/r)"'])]]
    : []),
];
const results = calls.map(([name, call]) => {
  try {
    call();
    return { name, code: 'not-blocked' };
  } catch (error) {
    return { name, code: error.code };
  }
});
if (process.platform !== 'win32') {
  try {
    childProcess.spawnSync('/usr/bin/env', ['-S', 'printf ok; gh api repos/o/r']);
    results.push({ name: 'env split separator literal', code: 'not-blocked' });
  } catch (error) {
    results.push({ name: 'env split separator literal', code: error.code });
  }
  try {
    childProcess.spawnSync('/bin/sh', ['-c', ${JSON.stringify('cat <<\'EOF\'\n"$(gh api repos/o/r)"\nEOF')}]);
    results.push({ name: 'quoted here-document literal', code: 'not-blocked' });
  } catch (error) {
    results.push({ name: 'quoted here-document literal', code: error.code });
  }
} else {
  try {
    childProcess.spawnSync('pwsh', ['-Command', '<# "$(gh api repos/o/r)" #> Write-Output ok']);
    results.push({ name: 'PowerShell block comment literal', code: 'not-blocked' });
  } catch (error) {
    results.push({ name: 'PowerShell block comment literal', code: error.code });
  }
}
parentPort.postMessage(results);
parentPort.close();
`;
  const workerEnv = { ...process.env };
  for (const key of Object.keys(workerEnv)) {
    if (key.toLowerCase() === 'path') delete workerEnv[key];
  }
  workerEnv[process.platform === 'win32' ? 'Path' : 'PATH'] = guardRoot;
  workerEnv.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
  workerEnv.IDD_TEST_GH_GUARD_ALLOWED_STUBS = JSON.stringify(
    process.platform === 'win32' ? [] : [registeredGh],
  );
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
      [
        'spawnSync',
        'spawn',
        'execFile',
        'execFileSync',
        'fork',
        'execSync',
        'cmd call wrapper',
        ...(process.platform === 'win32'
          ? []
          : [
              'spawnSync env PATH override',
              'spawnSync env credential',
              'spawnSync env split gh',
              'spawnSync env deep wrapper',
              'spawnSync env default signal',
              'spawnSync env ignore signal',
              'spawnSync env assignment after terminator',
              'spawnSync shell line continuation substitution',
              'spawnSync unquoted here-document substitution',
              'spawnSync unterminated here-document substitution',
              'spawnSync shell bundled command flag',
              'spawnSync shell command wrapper options',
              'spawnSync shell sudo wrapper options',
              'spawnSync shell negation operator',
              'spawnSync shell output redirection before command',
              'spawnSync shell input redirection before command',
              'spawnSync shell PATH assignment override',
              'spawnSync shell parameter length expansion',
              'env split separator literal',
              'quoted here-document literal',
            ]),
        ...(process.platform === 'win32'
          ? [
              'spawnSync PowerShell substitution',
              'PowerShell block comment literal',
            ]
          : []),
      ].map((name) => ({
        name,
        code:
          name === 'env split separator literal' ||
          name === 'quoted here-document literal' ||
          name === 'PowerShell block comment literal'
            ? 'not-blocked'
            : 'IDD_UNEXPECTED_REAL_GH',
      })),
    );
    const attempts = readAttempts(ledgerPath);
    assert.deepEqual(
      attempts.map((attempt) => attempt.api),
      [
        'spawnSync',
        'spawn',
        'execFile',
        'execFileSync',
        'fork',
        'execSync',
        'spawnSync',
        ...(process.platform === 'win32'
          ? []
          : [
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
              'spawnSync',
            ]),
        ...(process.platform === 'win32' ? ['spawnSync'] : []),
      ],
    );
    assert.doesNotMatch(
      readFileSync(ledgerPath, 'utf8'),
      /opaque-secret-value|split-secret-value/u,
    );
    if (process.platform !== 'win32') {
      const pathAttempt = attempts[7];
      assert.equal(pathAttempt?.resolvedExecutable, unregisteredGh);
      assert.deepEqual(pathAttempt?.args, [
        'PATH=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
      assert.deepEqual(attempts[8]?.args, [
        'GH_TOKEN=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
      assert.deepEqual(attempts[9]?.args, ['-S', '[split string omitted]']);
      assert.equal(
        attempts[10]?.executable,
        'env wrapper with unresolved command',
      );
      assert.deepEqual(attempts[13]?.args, [
        '--',
        'PATH=[redacted]',
        'gh',
        'api',
        'repos/o/r',
      ]);
    }
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

test('eval Worker bridge preserves a leading strict-mode directive', async () => {
  const worker = new Worker(
    `'use strict';\nconst { parentPort } = require('node:worker_threads');\nparentPort.postMessage((function () { return this; })() === undefined);`,
    { eval: true, execArgv: [] },
  );
  // Both listeners are registered before the first await: a Worker that posts
  // one message and returns can emit `exit` before a listener added after the
  // `message` await would exist, leaving that promise pending forever.
  const messagePromise = new Promise<boolean>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const exitPromise = new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker exited with code ${code}`));
    });
  });
  const [result] = await Promise.all([messagePromise, exitPromise]);
  assert.equal(result, true);
});

test('eval Worker bridge scans a comment-heavy source prefix in linear time', async () => {
  // An unterminated comment opener followed by many adjacent closer-and-opener
  // pairs made the earlier regular-expression scan backtrack exponentially
  // (CodeQL js/redos); the hand-written scan must return at once.
  const source = `/*${'*//*'.repeat(20_000)}`;
  const started = performance.now();
  const worker = new Worker(source, { eval: true, execArgv: [] });
  const elapsed = performance.now() - started;
  worker.on('error', () => {});
  await worker.terminate();
  assert.ok(elapsed < 5_000, `constructing the Worker took ${elapsed}ms`);
});

test('eval Worker bridge keeps directives that follow comments and blank lines', async () => {
  const worker = new Worker(
    `/* block */ // line\r\n\n  "use strict"\n;const { parentPort } = require('node:worker_threads');\nparentPort.postMessage((function () { return this; })() === undefined);`,
    { eval: true, execArgv: [] },
  );
  const result = await new Promise<boolean>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  assert.equal(result, true);
});

test('an explicit empty NODE_OPTIONS cannot bypass the child GH guard', () => {
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
  env: { ...process.env, IDD_TEST_GH_GUARD_SELF_CHECK: '0', NODE_OPTIONS: '' },
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

test('loads the test guard through relay argv without changing its environment', async () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND = 'node relay-target';
  const relaySource =
    'const command = process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND; ' +
    'process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? "<unset>", execArgv: process.execArgv }));';
  const child = spawn(
    process.execPath,
    ['--input-type=commonjs', '-e', relaySource],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout) as {
    nodeOptions: string;
    execArgv: string[];
  };
  assert.equal(result.nodeOptions, '<unset>');
  assert.ok(
    result.execArgv.includes(
      `--import=${process.env.IDD_TEST_GH_GUARD_IMPORT}`,
    ),
  );
});

test('CJS Worker guard loads in a telemetry relay without changing NODE_OPTIONS', async () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'NODE_OPTIONS') delete env[key];
  }
  const relaySource =
    'const command = process.env.IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND; ' +
    'process.stdout.write(JSON.stringify({ nodeOptions: process.env.NODE_OPTIONS ?? "<unset>", execArgv: process.execArgv }));';
  const workerSource = `
const { parentPort } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const env = {
  ...process.env,
  IDD_CRITIQUE_TELEMETRY_HOOK_WIN32_RELAY_COMMAND: 'node relay-target',
};
const child = spawnSync(
  process.execPath,
  ['--input-type=commonjs', '-e', ${JSON.stringify(relaySource)}],
  { encoding: 'utf8', env },
);
parentPort.postMessage({
  status: child.status,
  error: child.error?.message,
  stdout: child.stdout,
  stderr: child.stderr,
});
`;
  const worker = new Worker(workerSource, {
    eval: true,
    execArgv: [],
    env,
  });
  const result = await new Promise<{
    status: number | null;
    error?: string;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    let received = false;
    worker.once('message', (message) => {
      received = true;
      resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!received)
        reject(new Error(`worker exited before its result: ${code}`));
    });
  });

  assert.equal(result.status, 0, result.stderr || result.error || '');
  const relay = JSON.parse(result.stdout) as {
    nodeOptions: string;
    execArgv: string[];
  };
  assert.equal(relay.nodeOptions, '<unset>');
  const guardImport = process.env.IDD_TEST_GH_GUARD_IMPORT;
  assert.ok(guardImport);
  assert.ok(relay.execArgv.includes(`--import=${guardImport}`));
});

test('reinstalls the GH guard when an explicit child environment clears NODE_OPTIONS', () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'node_options') delete env[key];
  }
  env.NODE_OPTIONS = '';
  const result = spawnSync(
    process.execPath,
    ['-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? "<unset>")'],
    { encoding: 'utf8', env },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(process.env.IDD_TEST_GH_GUARD_IMPORT ?? ''));
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
let attemptId;
try {
  const result = spawnSync(workerData.ghPath, []);
  parentPort.postMessage({ returned: true, error: result.error?.code });
} catch (error) {
  attemptId = error.iddGhGuardAttemptId;
}
let tokenAttemptId;
try {
  spawnSync(workerData.ghPath, ['--token=worker-secret-value']);
} catch (error) {
  tokenAttemptId = error.iddGhGuardAttemptId;
}
parentPort.postMessage({
  attemptId,
  tokenAttemptId,
  filename: __filename,
  dirname: __dirname,
  argv: process.argv,
});
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
    assert.match(String(message.tokenAttemptId), /^gh-/u);
    assert.equal(message.filename, '[worker eval]');
    assert.equal(message.dirname, '.');
    assert.equal((message.argv as unknown[])[1], '[worker eval]');
    const attempts = readAttempts(ledgerPath);
    const [attempt, tokenAttempt] = attempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempt?.api, 'spawnSync');
    assert.ok(Number(attempt?.threadId) > 0);
    assert.deepEqual(tokenAttempt?.args, ['--token=[redacted]']);
    assert.doesNotMatch(
      readFileSync(ledgerPath, 'utf8'),
      /worker-secret-value/u,
    );
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('a guarded Worker adds the bridge when a child env clears NODE_OPTIONS', async () => {
  const guardRoot = mkdtempSync(
    join(tmpdir(), 'idd-gh-guard-worker-child-test-'),
  );
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const missingGhPath = join(
    guardRoot,
    'missing',
    process.platform === 'win32' ? 'gh.exe' : 'gh',
  );
  const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
const childSource = 'require("node:child_process").spawnSync(' + JSON.stringify(workerData.ghPath) + ', []);';
const result = spawnSync(process.execPath, ['-e', childSource], {
  encoding: 'utf8',
  env: { ...process.env, NODE_OPTIONS: '' },
});
parentPort.postMessage({ status: result.status, stderr: result.stderr });
`;
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'node_options') delete env[key];
    }
    env.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
    env.IDD_TEST_GH_GUARD_SELF_CHECK = '0';
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      env,
      workerData: { ghPath: missingGhPath },
    });
    const [message, exitCode] = await Promise.all([
      new Promise<{ status: number | null; stderr: string }>(
        (resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        },
      ),
      new Promise<number>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', resolve);
      }),
    ]);

    assert.equal(exitCode, 0);
    assert.equal(message.status, 1, message.stderr);
    assert.match(
      message.stderr,
      /blocked unexpected (?:worker gh|real gh) invocation/u,
    );
    const [attempt] = readAttempts(ledgerPath);
    assert.equal(attempt?.api, 'spawnSync');
    assert.equal(attempt?.threadId, 0);
  } finally {
    rmSync(guardRoot, { recursive: true, force: true });
  }
});

test('guarded Workers propagate the bridge into nested Workers with custom env', async (t) => {
  if (process.platform === 'win32') {
    t.skip('uses a POSIX gh fixture executable');
    return;
  }

  const guardRoot = mkdtempSync(
    join(tmpdir(), 'idd-gh-guard-nested-worker-test-'),
  );
  const ledgerPath = join(guardRoot, 'attempts.jsonl');
  const markerPath = join(guardRoot, 'gh-was-run');
  const ghPath = join(guardRoot, 'bin', 'gh');
  mkdirSync(join(guardRoot, 'bin'), { recursive: true });
  writeFileSync(ghPath, '#!/bin/sh\nprintf invoked > "$1"\n', {
    encoding: 'utf8',
    mode: 0o755,
  });
  const nestedWorkerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { spawnSync } = require('node:child_process');
try {
  spawnSync(workerData.ghPath, [workerData.markerPath]);
  parentPort.postMessage({ blocked: false });
} catch (error) {
  parentPort.postMessage({
    blocked: error.code === 'IDD_UNEXPECTED_REAL_GH',
    attemptId: error.iddGhGuardAttemptId,
  });
}
`;
  const workerSource = `
const { Worker, parentPort, workerData } = require('node:worker_threads');
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'node_options') delete env[key];
}
const nested = new Worker(workerData.nestedWorkerSource, {
  eval: true,
  execArgv: [],
  env,
  workerData: workerData.nestedWorkerData,
});
nested.once('message', (message) => parentPort.postMessage(message));
`;
  try {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'node_options') delete env[key];
    }
    env.IDD_TEST_GH_GUARD_LEDGER = ledgerPath;
    env.IDD_TEST_GH_GUARD_ALLOWED_STUBS = '[]';
    env.IDD_TEST_GH_GUARD_SELF_CHECK = '0';
    const worker = new Worker(workerSource, {
      eval: true,
      execArgv: [],
      env,
      workerData: {
        nestedWorkerSource,
        nestedWorkerData: { ghPath, markerPath },
      },
    });
    const [message, exitCode] = await Promise.all([
      new Promise<{ blocked: boolean; attemptId?: string }>(
        (resolve, reject) => {
          worker.once('message', resolve);
          worker.once('error', reject);
        },
      ),
      new Promise<number>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', resolve);
      }),
    ]);

    assert.equal(exitCode, 0);
    assert.equal(message.blocked, true);
    assert.match(String(message.attemptId), /^gh-/u);
    assert.equal(existsSync(markerPath), false);
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

test('guarded eval Workers keep module sources as ESM', async () => {
  const worker = new Worker(
    [
      "import { parentPort } from 'node:worker_threads';",
      'parentPort.postMessage({ moduleWorker: true });',
      'parentPort.close();',
    ].join('\n'),
    { eval: true, type: 'module', execArgv: [] } as WorkerOptions,
  );
  const [message, exitCode] = await Promise.all([
    new Promise<{ moduleWorker: boolean }>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }),
    new Promise<number>((resolve, reject) => {
      worker.once('error', reject);
      worker.once('exit', resolve);
    }),
  ]);

  assert.deepEqual(message, { moduleWorker: true });
  assert.equal(exitCode, 0);
});

test('guarded Workers preserve implicit execArgv with SHARE_ENV', async () => {
  const workerRoot = mkdtempSync(join(tmpdir(), 'idd-gh-guard-shared-env-'));
  const entryPath = join(workerRoot, 'entry.cjs');
  writeFileSync(
    entryPath,
    [
      "const { parentPort } = require('node:worker_threads');",
      'parentPort.postMessage({ workerStarted: true });',
      'parentPort.close();',
    ].join('\n'),
    'utf8',
  );
  try {
    const worker = new Worker(entryPath, { env: SHARE_ENV });
    const [message, exitCode] = await Promise.all([
      new Promise<{ workerStarted: boolean }>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      }),
      new Promise<number>((resolve, reject) => {
        worker.once('error', reject);
        worker.once('exit', resolve);
      }),
    ]);
    assert.deepEqual(message, { workerStarted: true });
    assert.equal(exitCode, 0);
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
  const substitutionCommand = 'printf "%s" "$(gh api repos/o/r)"';
  const backtickCommand = 'printf "%s" "`gh api repos/o/r`"';
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
  if (process.platform !== 'win32') {
    try {
      spawnSync(workerData.shell, [workerData.shellFlag, workerData.substitutionCommand]);
      calls.push(Promise.resolve('not-blocked'));
    } catch (error) {
      calls.push(Promise.resolve(error.code));
    }
    try {
      spawnSync(workerData.shell, [workerData.shellFlag, workerData.backtickCommand]);
      calls.push(Promise.resolve('not-blocked'));
    } catch (error) {
      calls.push(Promise.resolve(error.code));
    }
    try {
      spawnSync('/usr/bin/env', ['gh', 'api', 'repos/o/r']);
      calls.push(Promise.resolve('not-blocked'));
    } catch (error) {
      calls.push(Promise.resolve(error.code));
    }
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
    substitutionCommand: ${JSON.stringify(substitutionCommand)},
    backtickCommand: ${JSON.stringify(backtickCommand)},
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
      ...(process.platform === 'win32'
        ? []
        : ['spawnSync', 'spawnSync', 'spawnSync']),
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
      execFile(
        outerPath,
        ['idd-stub-stay-alive'],
        { encoding: 'utf8' },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    assert.equal(callbackOutput, 'outer-fixture');
    const promisedOutput = await promisify(execFile)(
      outerPath,
      ['idd-stub-stay-alive'],
      {
        encoding: 'utf8',
      },
    );
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
import { ghApiJson } from ${JSON.stringify(pathToFileURL(modulePath).href)};
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
      "const result = promisify(execFile)(workerData.ghPath, ['idd-stub-stay-alive'], { encoding: 'utf8' });",
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

// The PATH shim (tests/isolate-gh-shim.cjs, launched by the `gh` file or
// `gh.cmd` that the owner process writes into the guard root's `bin`
// directory) is what catches these spellings. The in-process parser misses
// each one, and the shell resolves `gh` through PATH to the shim instead.
// Each payload runs as its own child with its own ledger.
function runGuardedChild(
  childSource: string,
  extraFiles: Record<string, string> = {},
): {
  result: SpawnSyncReturns<string>;
  attempts: Array<Record<string, unknown>>;
  ledgerText: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'idd-gh-path-shim-'));
  try {
    const ledgerPath = join(root, 'attempts.jsonl');
    for (const [file, body] of Object.entries(extraFiles)) {
      writeFileSync(join(root, file), body, { encoding: 'utf8', mode: 0o755 });
    }
    const scriptPath = join(root, 'payload.cjs');
    writeFileSync(scriptPath, childSource, 'utf8');
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        IDD_TEST_GH_GUARD_ROOT: root,
        IDD_TEST_GH_GUARD_LEDGER: ledgerPath,
        IDD_TEST_GH_GUARD_SELF_CHECK: '1',
      },
    });
    const ledgerText = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8')
      : '';
    return {
      result,
      attempts: ledgerText ? readAttempts(ledgerPath) : [],
      ledgerText,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function shellPayloadChild(command: string): string {
  return [
    "const childProcess = require('node:child_process');",
    'try {',
    `  process.stdout.write(childProcess.execSync(${JSON.stringify(command)}, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));`,
    '} catch (error) {',
    '  process.stderr.write(String(error.stderr || error.message));',
    '  process.exitCode = error.status || 1;',
    '}',
    '',
  ].join('\n');
}

function assertCaughtByShim(
  run: ReturnType<typeof runGuardedChild>,
  expectedApi = 'path-shim',
): void {
  assert.notEqual(run.result.status, 0, run.result.stderr);
  assert.match(run.result.stderr, /IDD_UNEXPECTED_REAL_GH/u);
  assert.doesNotMatch(run.result.stdout, /gh version/u);
  assert.equal(run.attempts.length, 1, run.ledgerText);
  assert.equal(run.attempts[0]?.api, expectedApi, run.ledgerText);
  assert.equal(run.attempts[0]?.executable, 'gh', run.ledgerText);
  assert.equal(run.attempts[0]?.resolvedExecutable, null, run.ledgerText);
}

const posixShellPayloads = [
  { name: 'dot-sourced script', command: '. "./source-gh.sh"' },
  {
    name: 'default expansion word',
    command: `unset tool; "\${tool:-gh}" --version`,
  },
  { name: 'command substitution word', command: '$(printf gh) --version' },
  { name: 'IFS separator', command: `gh\${IFS} --version` },
  { name: 'empty quotes inside the name', command: 'g""h --version' },
];

function posixProbeChild(method: 'execFileSync' | 'spawnSync'): string {
  return method === 'execFileSync'
    ? [
        "const childProcess = require('node:child_process');",
        'try {',
        "  process.stdout.write(childProcess.execFileSync('./probe.sh', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));",
        '} catch (error) {',
        '  process.stderr.write(String(error.stderr || error.message));',
        '  process.exitCode = error.status || 1;',
        '}',
        '',
      ].join('\n')
    : [
        "const childProcess = require('node:child_process');",
        "const probe = childProcess.spawnSync('./probe.sh', [], { encoding: 'utf8' });",
        'process.stdout.write(probe.stdout ?? "");',
        'process.stderr.write(probe.stderr ?? "");',
        'if (probe.status !== 0) process.exitCode = probe.status ?? 1;',
        '',
      ].join('\n');
}

// Every POSIX payload, shell and executable probe alike, with the files the
// shell forms and the probes read. The shim and fixture tests share this list.
const posixPayloadRuns = [
  ...posixShellPayloads.map((payload) => ({
    name: payload.name,
    child: shellPayloadChild(payload.command),
  })),
  {
    name: 'executable probe via execFileSync',
    child: posixProbeChild('execFileSync'),
  },
  {
    name: 'executable probe via spawnSync',
    child: posixProbeChild('spawnSync'),
  },
];
const posixPayloadFiles = {
  'source-gh.sh': 'gh --version\n',
  'probe.sh': '#!/bin/sh\ngh --version\n',
};

for (const run of posixPayloadRuns) {
  test(`path shim: posix ${run.name} never reaches the real CLI`, {
    skip: process.platform === 'win32',
  }, () => {
    assertCaughtByShim(runGuardedChild(run.child, posixPayloadFiles));
  });
}

test('path shim: a shim-launched attempt stores credential-shaped arguments redacted', {
  skip: process.platform === 'win32',
}, () => {
  const run = runGuardedChild(
    shellPayloadChild('g""h --token=secret-token-value api repos/o/r'),
  );
  assertCaughtByShim(run);
  assert.deepEqual(run.attempts[0]?.args, [
    '--token=[redacted]',
    'api',
    'repos/o/r',
  ]);
  assert.doesNotMatch(run.ledgerText, /secret-token-value/u);
});

test('path shim: a registered gh fixture still runs ahead of the shim for every posix payload', {
  skip: process.platform === 'win32',
}, () => {
  const restore = stubExecutable(
    'gh',
    "process.stdout.write('gh version fixture');",
  );
  try {
    for (const payload of posixPayloadRuns) {
      const run = runGuardedChild(payload.child, posixPayloadFiles);
      assert.equal(
        run.result.status,
        0,
        `${payload.name}: ${run.result.stderr}`,
      );
      assert.equal(run.result.stdout, 'gh version fixture', payload.name);
      assert.equal(
        run.attempts.length,
        0,
        `${payload.name}: ${run.ledgerText}`,
      );
    }
  } finally {
    restore();
  }
});

test('path shim: the owner process puts the guard bin first on PATH', {
  skip: !process.env.IDD_TEST_GH_GUARD_ROOT,
}, () => {
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const binDirectory = join(process.env.IDD_TEST_GH_GUARD_ROOT ?? '', 'bin');
  assert.ok(
    (process.env[pathKey] ?? '').split(delimiter)[0]?.toLowerCase() ===
      binDirectory.toLowerCase() ||
      (process.env[pathKey] ?? '').split(delimiter)[0] === binDirectory,
    `PATH should start with ${binDirectory}`,
  );
  assert.ok(
    existsSync(
      join(binDirectory, process.platform === 'win32' ? 'gh.cmd' : 'gh'),
    ),
  );
});

test('path shim: windows cmd resolves gh through the guard bin', {
  skip: process.platform !== 'win32',
}, () => {
  const run = runGuardedChild(
    [
      "const childProcess = require('node:child_process');",
      "const probe = childProcess.spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '%GH% --version'], { encoding: 'utf8', env: { ...process.env, GH: 'gh' } });",
      'process.stdout.write(probe.stdout ?? "");',
      'process.stderr.write(probe.stderr ?? "");',
      'if (probe.status !== 0) process.exitCode = probe.status ?? 1;',
      '',
    ].join('\n'),
  );
  assertCaughtByShim(run);
});

test('path shim: windows powershell resolves gh through the guard bin', {
  skip: process.platform !== 'win32',
}, () => {
  const run = runGuardedChild(
    [
      "const childProcess = require('node:child_process');",
      "const probe = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '& $env:GH --version'], { encoding: 'utf8', env: { ...process.env, GH: 'gh' } });",
      'process.stdout.write(probe.stdout ?? "");',
      'process.stderr.write(probe.stderr ?? "");',
      'if (probe.status !== 0) process.exitCode = probe.status ?? 1;',
      '',
    ].join('\n'),
  );
  assertCaughtByShim(run);
});
