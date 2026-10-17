import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  constants as fsConstants,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { defaultLoadControlDirectory } from '../src/scripts/github-api-load-control.mts';
import { classifyHelperError } from '../src/scripts/helper-cli-runner.mts';
import {
  buildFlockArguments,
  findExecutableOnPath,
  findRepositoryRoot,
  LOCAL_ADMISSION_ENV_VAR,
  LOCK_OPEN_FLAGS,
  resolveStateBase,
  runLocalAdmission,
  storedCapAboveOne,
} from '../src/scripts/idd-local-admission.mts';
import { trackTempDirectories } from './temp-fixtures.mts';

const BIN = fileURLToPath(
  new URL('../bin/idd-local-admission.mjs', import.meta.url),
);
const POLICY = join('.github', 'idd', 'config.json');
const LOCK_RELATIVE = join('idd-skill', 'local-admission', 'validate.lock');
/** The real-lock rows need a POSIX host with `flock(1)` on PATH. */
const REAL_LOCK =
  process.platform !== 'win32' &&
  findExecutableOnPath('flock', process.env) !== null;

const makeTempDirectory = trackTempDirectories();

/** A tracked directory under the suite's temporary root, named with `prefix`. */
function tempDir(prefix: string): string {
  return makeTempDirectory(join(tmpdir(), prefix));
}

interface Harness {
  state: string;
  env: NodeJS.ProcessEnv;
}

/** A per-test state root, so no run writes under the suite-wide one. */
function makeHarness(): Harness {
  const state = tempDir('4428-state-');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: state,
    LOCALAPPDATA: join(state, 'local-appdata'),
  };
  delete env[LOCAL_ADMISSION_ENV_VAR];
  return { state, env };
}

function makeWorkDir(): string {
  return tempDir('4428-work-');
}

/** A directory with a `.git` entry, and optionally a policy file at its root. */
function makeRepo(config?: unknown): string {
  const root = tempDir('4428-repo-');
  mkdirSync(join(root, '.git'));
  if (config !== undefined) {
    mkdirSync(join(root, '.github', 'idd'), { recursive: true });
    writeFileSync(join(root, POLICY), `${JSON.stringify(config, null, 2)}\n`);
  }
  return root;
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runBin(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
  const done = new Promise<Run>((resolveRun, rejectRun) => {
    child.on('error', rejectRun);
    child.on('close', (status, signal) => {
      resolveRun({ status, signal, stdout, stderr });
    });
  });
  return { child, done };
}

function runBinSync(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met in time');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}

/** `flock -n` exit status: 0 when the file is free, 1 while something holds it. */
function flockStatus(path: string): number | null {
  return spawnSync('flock', ['-n', path, 'true']).status;
}

test('buildFlockArguments locks /dev/fd/3 with no -- before the path', () => {
  const args = buildFlockArguments(['pnpm', 'test'], 1000);
  assert.deepEqual(args.slice(0, 6), [
    '--timeout',
    '1',
    '--conflict-exit-code',
    '75',
    '/dev/fd/3',
    'sh',
  ]);
  assert.equal(args.includes('--'), false);
  assert.deepEqual(args.slice(-2), ['pnpm', 'test']);
  assert.deepEqual(buildFlockArguments(['x'], 1500).slice(0, 2), [
    '--timeout',
    '2',
  ]);
  assert.deepEqual(buildFlockArguments(['x'], 7_200_000).slice(0, 2), [
    '--timeout',
    '7200',
  ]);
});

test('the lock descriptor opens read-only, never truncating, and refuses symlinks', {
  skip: process.platform === 'win32',
}, () => {
  assert.notEqual(LOCK_OPEN_FLAGS & fsConstants.O_NOFOLLOW, 0);
  assert.notEqual(LOCK_OPEN_FLAGS & fsConstants.O_CREAT, 0);
  assert.equal(
    LOCK_OPEN_FLAGS &
      (fsConstants.O_WRONLY | fsConstants.O_RDWR | fsConstants.O_TRUNC),
    0,
  );
});

test('the lock directory is a sibling of github-api-load-control', () => {
  const env = { XDG_STATE_HOME: '/x/state' } as NodeJS.ProcessEnv;
  const base = resolveStateBase(env, 'linux', '/home/u');
  assert.equal(
    dirname(join(base, 'idd-skill', 'local-admission')),
    dirname(defaultLoadControlDirectory(env, 'linux')),
  );
});

test('resolveStateBase ignores a relative XDG_STATE_HOME and reads LOCALAPPDATA on win32', () => {
  assert.equal(
    resolveStateBase({ XDG_STATE_HOME: '/abs' }, 'linux', '/home/u'),
    '/abs',
  );
  assert.equal(
    resolveStateBase({ XDG_STATE_HOME: 'rel/dir' }, 'linux', '/home/u'),
    '/home/u/.local/state',
  );
  assert.equal(
    resolveStateBase({}, 'linux', '/home/u'),
    '/home/u/.local/state',
  );
  assert.equal(
    resolveStateBase({ LOCALAPPDATA: 'C:\\Local' }, 'win32', 'C:\\Users\\u'),
    'C:\\Local',
  );
  assert.equal(
    resolveStateBase({ LOCALAPPDATA: 'rel' }, 'win32', 'C:\\Users\\u'),
    'C:\\Users\\u\\AppData\\Local',
  );
});

test('storedCapAboveOne reads a stored cap above one as a number or numeric string', () => {
  for (const raw of [2, 9, '4', ' 9 ', Number.POSITIVE_INFINITY]) {
    assert.equal(storedCapAboveOne(raw), true, String(raw));
  }
  for (const raw of [1, 0, -3, '', '  ', 'abc', true, null, undefined, NaN]) {
    assert.equal(storedCapAboveOne(raw), false, String(raw));
  }
});

test('findRepositoryRoot returns the nearest ancestor holding .git', () => {
  const repo = makeRepo();
  const nested = join(repo, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  assert.equal(findRepositoryRoot(nested), repo);
  assert.equal(findRepositoryRoot(makeWorkDir()), null);
});

test('usage errors: a missing command and an unknown flag are usage errors', async () => {
  await assert.rejects(runLocalAdmission([]), (error: unknown) => {
    return classifyHelperError(error).kind === 'usage';
  });
  await assert.rejects(
    runLocalAdmission(['--bogus', '--', 'true']),
    (error: unknown) => classifyHelperError(error).kind === 'usage',
  );
});

test('a raw stored cap above one refuses with exit 2 before any lock or spawn', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { maxConcurrent: 9 } } });
  const notes: string[] = [];
  let spawned = false;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    cwd: repo,
    stderr: (text) => notes.push(text),
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  });
  assert.equal(status, 2);
  assert.equal(spawned, false);
  assert.match(notes.join(''), /maxConcurrent is 9/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('a caller in a repository subdirectory reads the root policy by absolute path', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { enabled: false } } });
  const sub = join(repo, 'packages', 'a');
  mkdirSync(sub, { recursive: true });
  const seen: string[] = [];
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 6'], {
    env: h.env,
    cwd: sub,
    stderr: () => undefined,
    readPolicy: (path) => {
      seen.push(path);
      return { localExec: { admission: { enabled: false } } };
    },
  });
  assert.equal(status, 6);
  assert.deepEqual(seen, [join(repo, POLICY)]);
});

test('a repository without a policy file uses the defaults and never calls the loader', async () => {
  const h = makeHarness();
  const repo = makeRepo();
  let calls = 0;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    cwd: repo,
    stderr: () => undefined,
    readPolicy: () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(status, 0);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(h.state, LOCK_RELATIVE)), true);
});

test('a caller with no .git ancestor uses the defaults without the loader', async () => {
  const h = makeHarness();
  const work = makeWorkDir();
  assert.equal(findRepositoryRoot(work), null);
  let calls = 0;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    cwd: work,
    stderr: () => undefined,
    readPolicy: () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(status, 0);
  assert.equal(calls, 0);
});

test('a malformed policy file exits 2 before any lock or spawn', async () => {
  const h = makeHarness();
  const repo = makeRepo({ placeholder: true });
  const notes: string[] = [];
  let spawned = false;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    cwd: repo,
    stderr: (text) => notes.push(text),
    readPolicy: () => {
      throw new Error('failed to load policy from x: Unexpected token');
    },
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  });
  assert.equal(status, 2);
  assert.equal(spawned, false);
  assert.match(notes.join(''), /failed to load policy/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('enabled false is accepted by the loader and runs the command with no lock file', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { enabled: false } } });
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: h.env,
    cwd: repo,
    stderr: () => undefined,
  });
  assert.equal(status, 0);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('IDD_LOCAL_ADMISSION in the environment skips the policy read and the lock', async () => {
  const h = makeHarness();
  const repo = makeRepo();
  let calls = 0;
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: { ...h.env, [LOCAL_ADMISSION_ENV_VAR]: '1' },
    cwd: repo,
    stderr: () => undefined,
    readPolicy: () => {
      calls += 1;
      return null;
    },
  });
  assert.equal(status, 0);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('a missing flock on PATH runs the command directly with one notice', async () => {
  const h = makeHarness();
  const work = makeWorkDir();
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: h.env,
    cwd: work,
    stderr: (text) => notes.push(text),
    findFlock: () => null,
  });
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /flock is not available/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('a missing flock bypasses raw-cap validation and runs directly', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { maxConcurrent: 9 } } });
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: h.env,
    cwd: repo,
    stderr: (text) => notes.push(text),
    findFlock: () => null,
  });
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /flock is not available/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('win32 bypasses raw-cap validation and runs directly', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { maxConcurrent: 9 } } });
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: h.env,
    cwd: repo,
    platform: 'win32',
    stderr: (text) => notes.push(text),
    findFlock: () => '/usr/bin/flock',
  });
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /flock is not available/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('win32 runs the command directly with one notice and never creates the lock', async () => {
  const h = makeHarness();
  const work = makeWorkDir();
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', 'sh', '-c', 'exit 0'], {
    env: h.env,
    cwd: work,
    platform: 'win32',
    stderr: (text) => notes.push(text),
    findFlock: () => '/usr/bin/flock',
  });
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('the waiting notice repeats before the expiry (waitNoticeIntervalMs 10)', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'holder.ready');
  const holder = runBin(
    ['--', 'sh', '-c', `touch '${ready}'; sleep 2`],
    makeWorkDir(),
    h.env,
  );
  await waitFor(() => existsSync(ready));
  const repo = makeRepo({ localExec: { admission: { maxWait: 'PT1S' } } });
  const lines: string[] = [];
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    cwd: repo,
    stderr: (text) => lines.push(text),
    waitNoticeIntervalMs: 10,
  });
  assert.equal(status, 75);
  const text = lines.join('');
  assert.match(text, /local-admission: waiting/);
  assert.match(text, /local-admission: expired/);
  assert.equal((await holder.done).status, 0);
});

test('two callers in different working directories share one slot', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const log = join(h.state, 'order.log');
  const first = runBin(
    [
      '--',
      'sh',
      '-c',
      `echo A-start >> '${log}'; sleep 1; echo A-end >> '${log}'`,
    ],
    makeWorkDir(),
    h.env,
  );
  await waitFor(() => existsSync(log));
  const second = runBin(
    ['--', 'sh', '-c', `echo B-start >> '${log}'`],
    makeWorkDir(),
    h.env,
  );
  const [a, b] = await Promise.all([first.done, second.done]);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'A-start',
    'A-end',
    'B-start',
  ]);
});

test('a held lock past maxWait exits 75 and the command never starts', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'holder.ready');
  const holder = runBin(
    ['--', 'sh', '-c', `touch '${ready}'; sleep 3`],
    makeWorkDir(),
    h.env,
  );
  await waitFor(() => existsSync(ready));
  const started = join(h.state, 'waiter.started');
  const repo = makeRepo({ localExec: { admission: { maxWait: 'PT1S' } } });
  const waiter = await runBin(
    ['--', 'sh', '-c', `touch '${started}'`],
    repo,
    h.env,
  ).done;
  assert.equal(waiter.status, 75);
  assert.match(waiter.stderr, /local-admission: expired/);
  assert.equal(existsSync(started), false);
  assert.equal((await holder.done).status, 0);
});

test('a child that exits 75 is returned as 75 without the expired line', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const result = runBinSync(
    ['--', 'sh', '-c', 'exit 75'],
    makeWorkDir(),
    h.env,
  );
  assert.equal(result.status, 75);
  assert.doesNotMatch(result.stderr, /local-admission: expired/);
});

test('a command that cannot be found exits 127 after the lock is taken', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const result = runBinSync(
    ['--', 'no-such-command-4428-xyz'],
    makeWorkDir(),
    h.env,
  );
  assert.equal(result.status, 127);
});

test('an admitted command sees IDD_LOCAL_ADMISSION=1, and a set variable skips the lock', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const admitted = runBinSync(
    ['--', 'sh', '-c', 'printf %s "$IDD_LOCAL_ADMISSION"'],
    makeWorkDir(),
    h.env,
  );
  assert.equal(admitted.status, 0);
  assert.equal(admitted.stdout, '1');

  const skipped = runBinSync(['--', 'true'], makeWorkDir(), {
    ...h.env,
    [LOCAL_ADMISSION_ENV_VAR]: '1',
  });
  assert.equal(skipped.status, 0);
});

test('pueue takes the flock path with one notice, does not refuse, and keeps the stored cap', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const repo = makeRepo({
    localExec: { admission: { backend: 'pueue', maxConcurrent: 4 } },
  });
  const before = readFileSync(join(repo, POLICY), 'utf8');
  const result = runBinSync(['--', 'true'], repo, h.env);
  assert.equal(result.status, 0);
  const notices = result.stderr
    .split('\n')
    .filter((line) => line.includes('pueue'));
  assert.equal(notices.length, 1);
  assert.equal(existsSync(join(h.state, LOCK_RELATIVE)), true);
  assert.equal(readFileSync(join(repo, POLICY), 'utf8'), before);
});

test('SIGTERM to the helper reaches the admitted command and frees the lock', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'child.ready');
  const termed = join(h.state, 'child.termed');
  const script = `trap 'echo got-term > "${termed}"; exit 0' TERM; touch '${ready}'; while :; do sleep 0.1; done`;
  const run = runBin(['--', 'sh', '-c', script], makeWorkDir(), h.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  assert.equal(existsSync(termed), true);
  assert.equal(flockStatus(join(h.state, LOCK_RELATIVE)), 0);
});

test('SIGKILL to the helper leaves the slot held until the admitted command exits', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'a.ready');
  const log = join(h.state, 'order.log');
  const first = runBin(
    ['--', 'sh', '-c', `touch '${ready}'; sleep 2; echo A-end >> '${log}'`],
    makeWorkDir(),
    h.env,
  );
  const exited = new Promise<void>((resolveExit) => {
    first.child.once('exit', () => resolveExit());
  });
  await waitFor(() => existsSync(ready));
  first.child.kill('SIGKILL');
  await exited;
  const second = await runBin(
    ['--', 'sh', '-c', `echo B-start >> '${log}'`],
    makeWorkDir(),
    h.env,
  ).done;
  assert.equal(second.status, 0);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
    'A-end',
    'B-start',
  ]);
});

test('a symlinked lock file exits 2 with the command not started and the link kept', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const lockDir = join(h.state, 'idd-skill', 'local-admission');
  mkdirSync(lockDir, { recursive: true });
  const target = join(h.state, 'elsewhere.lock');
  writeFileSync(target, 'x');
  symlinkSync(target, join(lockDir, 'validate.lock'));
  const marker = join(h.state, 'started');
  const result = runBinSync(['--', 'touch', marker], makeWorkDir(), h.env);
  assert.equal(result.status, 2);
  assert.equal(existsSync(marker), false);
  assert.equal(
    lstatSync(join(lockDir, 'validate.lock')).isSymbolicLink(),
    true,
  );
});

test('a symlinked parent directory exits 2 and writes nothing into its target', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const elsewhere = tempDir('4428-elsewhere-');
  symlinkSync(elsewhere, join(h.state, 'idd-skill'));
  const result = runBinSync(['--', 'true'], makeWorkDir(), h.env);
  assert.equal(result.status, 2);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('a pre-existing regular lock file is locked, byte-identical, and keeps its hard link', {
  skip: !REAL_LOCK,
}, () => {
  const h = makeHarness();
  const lockDir = join(h.state, 'idd-skill', 'local-admission');
  mkdirSync(lockDir, { recursive: true });
  const lock = join(lockDir, 'validate.lock');
  writeFileSync(lock, 'user contents\n');
  const alias = join(lockDir, 'alias.lock');
  linkSync(lock, alias);
  const result = runBinSync(['--', 'true'], makeWorkDir(), h.env);
  assert.equal(result.status, 0);
  assert.equal(readFileSync(lock, 'utf8'), 'user contents\n');
  assert.equal(statSync(lock).nlink, 2);
  assert.equal(existsSync(alias), true);
});

test('renaming the lock path after the open leaves the lock on the opened inode', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'holder.ready');
  const holder = runBin(
    ['--', 'sh', '-c', `touch '${ready}'; sleep 2`],
    makeWorkDir(),
    h.env,
  );
  await waitFor(() => existsSync(ready));
  const lock = join(h.state, LOCK_RELATIVE);
  const moved = `${lock}.moved`;
  renameSync(lock, moved);
  writeFileSync(lock, '');
  try {
    assert.equal(flockStatus(moved), 1);
    assert.equal(flockStatus(lock), 0);
  } finally {
    rmSync(moved, { force: true });
  }
  assert.equal((await holder.done).status, 0);
});
