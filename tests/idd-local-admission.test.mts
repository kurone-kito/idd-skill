import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { Writable } from 'node:stream';
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
  type LocalAdmissionDeps,
  parseProcessGroupStateOutput,
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

interface FakePueue {
  env: NodeJS.ProcessEnv;
  path: string;
  statePath: string;
}

function makeFakePueue(
  env: NodeJS.ProcessEnv,
  scenario: Record<string, unknown> = {},
): FakePueue {
  const dir = tempDir('fake-pueue-');
  const path = join(dir, 'pueue');
  const statePath = join(dir, 'state.json');
  writeFileSync(statePath, JSON.stringify({ calls: [], ...scenario }));
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const file = process.env.FAKE_PUEUE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => {
  const temporary = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state));
  fs.renameSync(temporary, file);
};
const taskId = args[1];
state.calls.push(args);
const task = (id) => state.tasks?.[id];
const output = (value) => process.stdout.write(value);
const timestamp = '2026-10-19T00:00:00+00:00';
const wireStatus = (status) => {
  if (typeof status === 'string') {
    if (status === 'Queued') {
      return { Queued: { enqueued_at: timestamp } };
    }
    if (status === 'Running' || status === 'Paused') {
      return { [status]: { enqueued_at: timestamp, start: timestamp } };
    }
    if (status === 'Stashed') return { Stashed: { enqueue_at: null } };
    if (status === 'Locked') {
      return { Locked: { previous_status: { Queued: { enqueued_at: timestamp } } } };
    }
    return status;
  }
  if (
    !status ||
    typeof status !== 'object' ||
    !status.Done ||
    typeof status.Done !== 'object'
  ) {
    return status;
  }
  const done = status.Done;
  const variant = Object.keys(done).find(
    (key) => !['enqueued_at', 'start', 'end', 'result'].includes(key),
  );
  let result = done.result;
  if (result === undefined && variant) {
    const value = done[variant];
    result = value === null ? variant : { [variant]: value };
  }
  return {
    Done: {
      enqueued_at: done.enqueued_at ?? timestamp,
      start: done.start ?? timestamp,
      end: done.end ?? timestamp,
      result,
    },
  };
};
if (args[0] === 'status') {
  if (state.statusHang) {
    save();
    if (state.statusReady) fs.writeFileSync(state.statusReady, 'ready');
    setInterval(() => {}, 1000);
    return;
  }
  output(state.statusOutput ?? '{}');
  save();
  process.exit(state.daemonExit ?? 0);
}
if (args[0] === 'group' && args[1] === '--json') {
  output(JSON.stringify(state.groups ?? {}));
  const groupReads = state.calls.filter((call) => call[0] === 'group' && call[1] === '--json').length;
  save();
  process.exit(state.groupListExitAfterFirst && groupReads > 1 ? state.groupListExitAfterFirst : (state.groupListExit ?? 0));
}
if (args[0] === 'group' && args[1] === 'add') {
  if (state.groupAddExit) {
    if (state.groupsAfterFailedAdd) state.groups = state.groupsAfterFailedAdd;
    save();
    process.exit(state.groupAddExit);
  }
  const name = args.at(-1);
  const parallel = Number(args[args.indexOf('--parallel') + 1]);
  state.groups ??= {};
  state.groups[name] = { parallel_tasks: parallel, status: 'Running' };
  save();
  process.exit(0);
}
if (args[0] === 'add') {
  const value = (flag) => args[args.indexOf(flag) + 1];
  const id = String(state.addId ?? 17);
  const label = value('-l');
  const command = args.at(-1);
  const cwd = value('-w');
  const groupArgument = args.find((arg) => arg.startsWith('--group='));
  state.tasks ??= {};
  const taskData = { label: state.taskLabelOverride ?? label, status: state.initialStatus ?? 'Queued', output: state.taskOutput ?? '' };
  if (state.runCommandOnAdd) {
    const child = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: process.env });
    taskData.status = { Done: child.status === 0 ? { Success: null } : { Failed: child.status } };
    taskData.output = child.stdout ?? '';
    taskData.childStatus = child.status;
  }
  if (state.initialStatus === 'Done') taskData.status = { Done: { Success: null } };
  state.tasks[id] = taskData;
  state.added = {
    id,
    label,
    command,
    cwd,
    group:
      groupArgument === undefined
        ? value('-g')
        : groupArgument.slice('--group='.length),
  };
  save();
  if (state.addHang) {
    if (state.addReady) fs.writeFileSync(state.addReady, 'ready');
    setTimeout(() => { output(state.addOutput ?? id + '\\n'); process.exit(state.addExit ?? 0); }, state.addDelay ?? 150);
    return;
  }
  output(state.addOutput ?? id + '\\n');
  process.exit(state.addExit ?? 0);
}
if (args[0] === 'log') {
  state.logCalls = (state.logCalls ?? 0) + 1;
  if (state.logHang) { save(); setInterval(() => {}, 1000); return; }
  const value = task(taskId);
  if (state.logExit || state.logFailOnCall === state.logCalls) { save(); process.exit(state.logExit || 1); }
  if (state.deleteTaskOnLogCall === state.logCalls && state.tasks) delete state.tasks[taskId];
  if (!value) { save(); process.exit(1); }
  const responses = state.logResponses?.[taskId] ?? state.logResponses;
  if (responses?.length) value.status = responses.shift();
  save();
  const envelopeId = String(state.logEnvelopeId ?? taskId);
  const taskIdInResponse = Number(state.logTaskId ?? taskId);
  output(
    JSON.stringify({
      [envelopeId]: {
        task: {
          id: taskIdInResponse,
          label: value.label,
          status: wireStatus(value.status),
        },
        output: value.output,
      },
    }),
  );
  process.exit(0);
}
if (args[0] === 'follow') {
  if (state.followFailAndSignal) {
    process.kill(process.ppid, 'SIGTERM');
    process.exit(1);
  }
  if (state.followHang) {
    save();
    if (state.followReady) fs.writeFileSync(state.followReady, String(process.pid));
    if (state.followDrainDelay !== undefined) {
      setTimeout(() => {
        output(state.streamOutput ?? '');
        if (state.streamStderr) process.stderr.write(state.streamStderr);
        process.exit(state.followExit ?? 0);
      }, state.followDrainDelay);
      return;
    }
    process.on('SIGTERM', () => process.exit(0));
    process.stdout.on('close', () => process.exit(0));
    setInterval(() => {}, 1000);
    return;
  } else {
    const value = task(taskId);
    if (value && state.followFinalStatus) value.status = state.followFinalStatus;
    save();
    if (state.followOutputBytes !== undefined) {
      const chunk = 'x'.repeat(1024);
      let remaining = Number(state.followOutputBytes);
      const writeNext = () => {
        while (remaining > 0) {
          const next = chunk.slice(0, Math.min(chunk.length, remaining));
          remaining -= next.length;
          if (!process.stdout.write(next)) {
            process.stdout.once('drain', writeNext);
            return;
          }
        }
        process.stdout.end();
      };
      writeNext();
      return;
    }
    output(value?.streamOutput ?? state.streamOutput ?? '');
    if (state.streamStderr) process.stderr.write(state.streamStderr);
    process.exit(state.followExit ?? 0);
  }
}
if (args[0] === 'stash') {
  const value = task(taskId);
  if (state.stashExit) { save(); process.exit(state.stashExit); }
  if (!value || ['Running', 'Paused', 'Done'].includes(typeof value.status === 'string' ? value.status : Object.keys(value.status)[0])) { save(); process.exit(1); }
  value.status = 'Stashed';
  save();
  process.exit(0);
}
if (args[0] === 'kill') {
  const value = task(taskId);
  if (state.killExit) { save(); process.exit(state.killExit); }
  if (value) value.status = { Done: { Killed: null } };
  save();
  process.exit(0);
}
if (args[0] === 'remove') {
  if (state.removeExit) { save(); process.exit(state.removeExit); }
  if (state.removeHang) { if (state.removeReady) fs.writeFileSync(state.removeReady, 'ready'); setTimeout(() => process.exit(0), 150); return; }
  if (state.tasks) { state.lastRemovedTask = state.tasks[taskId]; delete state.tasks[taskId]; }
  save();
  process.exit(0);
}
save();
process.exit(2);
`,
  );
  chmodSync(path, 0o755);
  const fakeEnv = {
    ...env,
    PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`,
    FAKE_PUEUE_STATE: statePath,
  };
  return { env: fakeEnv, path, statePath };
}

function readFakePueue(fake: FakePueue): Record<string, unknown> {
  return JSON.parse(readFileSync(fake.statePath, 'utf8')) as Record<
    string,
    unknown
  >;
}

async function runPueueTest(
  policy: Record<string, unknown>,
  scenario: Record<string, unknown>,
  command: string[] = ['true'],
  overrides: Partial<LocalAdmissionDeps> = {},
): Promise<{ status: number; stderr: string; fake: FakePueue; repo: string }> {
  const h = makeHarness();
  const repo = makeRepo(policy);
  const fake = makeFakePueue(h.env, scenario);
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', ...command], {
    cwd: repo,
    env: fake.env,
    platform: 'linux',
    stderr: (text: string) => notes.push(text),
    waitNoticeIntervalMs: 5,
    pueueClientTimeoutMs: 3000,
    pueuePollIntervalMs: 2,
    ...overrides,
  });
  return { status, stderr: notes.join(''), fake, repo };
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
  detached = false,
): { child: ChildProcess; done: Promise<Run> } {
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd,
    env,
    detached,
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(
  pid: number,
  stopFile: string,
  exitFile: string,
): Promise<void> {
  writeFileSync(stopFile, 'stop\n');
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The bounded child may already have exited.
  }
  await waitFor(() => existsSync(exitFile), 5000);
}

test('buildFlockArguments locks inherited descriptor 3 with a bounded wait', () => {
  const args = buildFlockArguments(1000);
  assert.deepEqual(args, ['--timeout', '1', '--conflict-exit-code', '75', '3']);
  assert.equal(args.includes('--'), false);
  assert.deepEqual(buildFlockArguments(1500).slice(0, 2), ['--timeout', '2']);
  assert.deepEqual(buildFlockArguments(7_200_000).slice(0, 2), [
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

test('process-group state waits for live members and drains zombie-only groups', () => {
  const pgid = 4321;
  assert.equal(
    parseProcessGroupStateOutput(
      ['4321 Z', '4321 X', '7654 S'].join('\n'),
      pgid,
    ),
    false,
  );
  assert.equal(
    parseProcessGroupStateOutput(['4321 Z', '4321 S'].join('\n'), pgid),
    true,
  );
  assert.equal(parseProcessGroupStateOutput('malformed output', pgid), null);
  assert.equal(parseProcessGroupStateOutput('4321 Z\n\n7654 S', pgid), null);
  assert.equal(parseProcessGroupStateOutput('', pgid), null);
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

test('a raw stored cap above one refuses with exit 2 before any lock or spawn', {
  skip: !REAL_LOCK,
}, async () => {
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

test('an unavailable ps refuses before starting a locked command', async () => {
  const h = makeHarness();
  const notes: string[] = [];
  let spawned = false;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    platform: 'linux',
    cwd: makeWorkDir(),
    stderr: (text) => notes.push(text),
    readPolicy: () => ({ localExec: { admission: { enabled: true } } }),
    findFlock: () => '/usr/bin/flock',
    findPs: () => null,
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  });
  assert.equal(status, 2);
  assert.equal(spawned, false);
  assert.match(notes.join(''), /ps is not available.*command not started/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('an unusable ps refuses before starting a locked command', async () => {
  const h = makeHarness();
  const notes: string[] = [];
  let spawned = false;
  const status = await runLocalAdmission(['--', 'true'], {
    env: h.env,
    platform: 'linux',
    cwd: makeWorkDir(),
    stderr: (text) => notes.push(text),
    readPolicy: () => ({ localExec: { admission: { enabled: true } } }),
    findFlock: () => '/usr/bin/flock',
    findPs: () => process.execPath,
    spawn: () => {
      spawned = true;
      throw new Error('must not spawn');
    },
  });
  assert.equal(status, 2);
  assert.equal(spawned, false);
  assert.match(
    notes.join(''),
    /ps .*unusable process-state output.*command not started/,
  );
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
  const status = await runLocalAdmission(
    ['--', process.execPath, '-e', 'process.exit(0)'],
    {
      env: h.env,
      cwd: repo,
      platform: 'win32',
      stderr: (text) => notes.push(text),
      findFlock: () => '/usr/bin/flock',
    },
  );
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /flock is not available/);
  assert.equal(existsSync(join(h.state, 'idd-skill')), false);
});

test('win32 runs the command directly with one notice and never creates the lock', async () => {
  const h = makeHarness();
  const work = makeWorkDir();
  const notes: string[] = [];
  const status = await runLocalAdmission(
    ['--', process.execPath, '-e', 'process.exit(0)'],
    {
      env: h.env,
      cwd: work,
      platform: 'win32',
      stderr: (text) => notes.push(text),
      findFlock: () => '/usr/bin/flock',
    },
  );
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

test('pueue creates a missing group at the cap and preserves shell argv', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = {
    localExec: { admission: { backend: 'pueue', maxConcurrent: 4 } },
  };
  const code =
    'process.stdout.write(JSON.stringify({admitted:process.env.IDD_LOCAL_ADMISSION,args:process.argv.slice(1)}))';
  const argv = [
    process.execPath,
    '-e',
    code,
    'a space',
    "it's quoted",
    '$HOME',
  ];
  const result = await runPueueTest(policy, { runCommandOnAdd: true }, argv, {
    findFlock: () => null,
  });
  assert.equal(result.status, 0);
  const state = readFakePueue(result.fake);
  const added = state.added as Record<string, unknown>;
  assert.equal(added.group, 'idd-validate');
  assert.equal(added.cwd, result.repo);
  assert.match(String(added.command), /^IDD_LOCAL_ADMISSION=1 /);
  assert.deepEqual(
    JSON.parse(
      String((state.lastRemovedTask as Record<string, unknown>).output),
    ),
    {
      admitted: '1',
      args: ['a space', "it's quoted", '$HOME'],
    },
  );
  const calls = state.calls as string[][];
  assert.deepEqual(calls[0]?.slice(0, 2), ['status', '--json']);
  assert.match(
    calls[0]?.[2] ?? '',
    /^label=idd-local-admission-health-[0-9a-f-]{36}$/,
  );
  assert.deepEqual(calls[0]?.slice(3), ['first', '1']);
  assert.deepEqual(calls[1], ['group', '--json']);
  assert.deepEqual(calls[2], [
    'group',
    'add',
    '--parallel',
    '4',
    '--',
    'idd-validate',
  ]);
  const addIndex = calls.findIndex((call) => call[0] === 'add');
  assert.ok(addIndex >= 0);
  for (const call of calls.slice(addIndex + 1)) {
    if (['log', 'follow', 'stash', 'remove', 'kill'].includes(call[0] ?? '')) {
      assert.equal(call[1], added.id);
    }
  }
});

test('pueue creates missing groups at both supported cap endpoints', {
  skip: process.platform === 'win32',
}, async () => {
  for (const cap of [1, 8]) {
    const result = await runPueueTest(
      { localExec: { admission: { backend: 'pueue', maxConcurrent: cap } } },
      { runCommandOnAdd: true },
      ['true'],
      { findFlock: () => null },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(readFakePueue(result.fake).groups, {
      'idd-validate': { parallel_tasks: cap, status: 'Running' },
    });
  }
});

test('pueue preserves an existing group literally named groups', {
  skip: process.platform === 'win32',
}, async () => {
  const result = await runPueueTest(
    {
      localExec: {
        admission: { backend: 'pueue', maxConcurrent: 2, pueueGroup: 'groups' },
      },
    },
    {
      groups: { groups: { parallel_tasks: 2, status: 'Running' } },
      runCommandOnAdd: true,
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(result.status, 0);
  const state = readFakePueue(result.fake);
  assert.deepEqual(state.groups, {
    groups: { parallel_tasks: 2, status: 'Running' },
  });
  assert.equal((state.added as Record<string, unknown>).group, 'groups');
  assert.equal(
    (state.calls as string[][]).some(
      (call) => call[0] === 'group' && call[1] === 'add',
    ),
    false,
  );
});

test('pueue passes leading-hyphen group names as values and positionals', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = {
    localExec: {
      admission: { backend: 'pueue', maxConcurrent: 1, pueueGroup: '--help' },
    },
  };
  const existing = await runPueueTest(policy, {
    groups: { '--help': { parallel_tasks: 1, status: 'Running' } },
    runCommandOnAdd: true,
  });
  assert.equal(existing.status, 0);
  const existingState = readFakePueue(existing.fake);
  assert.equal(
    (existingState.added as Record<string, unknown>).group,
    '--help',
  );
  const existingCalls = existingState.calls as string[][];
  assert.ok(
    existingCalls.some(
      (call) => call.slice(0, 2).join(' ') === 'add --group=--help',
    ),
  );
  assert.equal(
    existingCalls.some((call) => call[0] === 'group' && call[1] === 'add'),
    false,
  );

  const missing = await runPueueTest(policy, { runCommandOnAdd: true });
  assert.equal(missing.status, 0);
  const missingState = readFakePueue(missing.fake);
  assert.equal((missingState.added as Record<string, unknown>).group, '--help');
  const missingCalls = missingState.calls as string[][];
  assert.deepEqual(
    missingCalls.find((call) => call[0] === 'group' && call[1] === 'add'),
    ['group', 'add', '--parallel', '1', '--', '--help'],
  );
  assert.ok(
    missingCalls.some(
      (call) => call.slice(0, 2).join(' ') === 'add --group=--help',
    ),
  );
});

test('pueue daemon failure uses flock without changing policy despite cap above one', {
  skip: !REAL_LOCK,
}, async () => {
  const policy = {
    localExec: { admission: { backend: 'pueue', maxConcurrent: 4 } },
  };
  const h = makeHarness();
  const repo = makeRepo(policy);
  const before = readFileSync(join(repo, POLICY), 'utf8');
  const fake = makeFakePueue(h.env, { daemonExit: 1 });
  const notes: string[] = [];
  const status = await runLocalAdmission(['--', 'true'], {
    cwd: repo,
    env: fake.env,
    platform: 'linux',
    stderr: (text: string) => notes.push(text),
    pueueClientTimeoutMs: 3000,
    pueuePollIntervalMs: 2,
  });
  const result = { status, stderr: notes.join(''), fake, repo };
  assert.equal(result.status, 0);
  assert.match(result.stderr, /pueue daemon is not accepting commands/);
  assert.equal(Array.isArray(readFakePueue(result.fake).calls), true);
  assert.equal(
    (readFakePueue(result.fake).calls as string[][]).some(
      (call) => call[0] === 'add',
    ),
    false,
  );
  assert.equal(readFileSync(join(result.repo, POLICY), 'utf8'), before);
});

test('pueue daemon timeout uses flock and a missing client never calls pueue', {
  skip: !REAL_LOCK,
}, async () => {
  const policy = {
    localExec: { admission: { backend: 'pueue', maxConcurrent: 4 } },
  };
  const timed = await runPueueTest(policy, { statusHang: true }, ['true'], {
    pueueClientTimeoutMs: 10,
  });
  assert.equal(timed.status, 0);
  assert.match(timed.stderr, /pueue daemon is not accepting commands/);
  const h = makeHarness();
  const repo = makeRepo(policy);
  const notes: string[] = [];
  const missing = await runLocalAdmission(['--', 'true'], {
    cwd: repo,
    env: h.env,
    stderr: (text: string) => notes.push(text),
    findPueue: () => null,
  });
  assert.equal(missing, 0);
  assert.match(notes.join(''), /pueue client is not available/);
  const connectionError = await runPueueTest(policy, {}, ['true'], {
    findPueue: () => '/definitely/missing/pueue',
  });
  assert.equal(connectionError.status, 0);
  assert.match(
    connectionError.stderr,
    /pueue daemon is not accepting commands/,
  );
});

test('pueue cap outside the supported range falls back to one without rewriting policy', {
  skip: process.platform === 'win32',
}, async () => {
  for (const cap of [12, 2.5]) {
    const policy = {
      localExec: { admission: { backend: 'pueue', maxConcurrent: cap } },
    };
    const h = makeHarness();
    const repo = makeRepo(policy);
    const before = readFileSync(join(repo, POLICY), 'utf8');
    const fake = makeFakePueue(h.env, { runCommandOnAdd: true });
    const status = await runLocalAdmission(['--', 'true'], {
      cwd: repo,
      env: fake.env,
      readPolicy: () => policy,
      stderr: () => {},
      findFlock: () => null,
    });
    assert.equal(status, 0);
    const state = readFakePueue(fake);
    assert.deepEqual(state.groups, {
      'idd-validate': { parallel_tasks: 1, status: 'Running' },
    });
    assert.equal(readFileSync(join(repo, POLICY), 'utf8'), before);
  }
});

test('pueue uses an existing group, reports its cap and paused state, and works without flock', {
  skip: process.platform === 'win32',
}, async () => {
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue', maxConcurrent: 3 } } },
    {
      groups: { 'idd-validate': { parallel_tasks: 1, status: 'Paused' } },
      runCommandOnAdd: true,
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(result.status, 0);
  assert.match(result.stderr, /parallel_tasks=1, expected 3/);
  assert.match(result.stderr, /group idd-validate is paused/);
  assert.equal(
    (readFakePueue(result.fake).calls as string[][]).some(
      (call) => call[0] === 'group' && call[1] === 'add',
    ),
    false,
  );
});

test('a paused pueue group keeps the submitted task queued until maxWait expires', {
  skip: !REAL_LOCK,
}, async () => {
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue', maxWait: 'PT1S' } } },
    {
      groups: { 'idd-validate': { parallel_tasks: 1, status: 'Paused' } },
      initialStatus: 'Queued',
    },
  );
  assert.equal(result.status, 75);
  assert.match(result.stderr, /group idd-validate is paused/);
  assert.match(result.stderr, /expired/);
  assert.ok(
    (readFakePueue(result.fake).calls as string[][]).some(
      (call) => call[0] === 'add',
    ),
  );
});

test('pueue create race rereads a group; a missing or unreadable group falls back before add', {
  skip: !REAL_LOCK,
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const raced = await runPueueTest(policy, {
    groupAddExit: 1,
    groupsAfterFailedAdd: {
      'idd-validate': { parallel_tasks: 1, status: 'Running' },
    },
    runCommandOnAdd: true,
  });
  assert.equal(raced.status, 0);
  assert.ok(
    (readFakePueue(raced.fake).calls as string[][]).some(
      (call) => call[0] === 'add',
    ),
  );
  const missing = await runPueueTest(policy, { groupAddExit: 1 });
  assert.equal(missing.status, 0);
  assert.match(missing.stderr, /could not create the configured group/);
  assert.equal(
    (readFakePueue(missing.fake).calls as string[][]).some(
      (call) => call[0] === 'add',
    ),
    false,
  );
  const unreadable = await runPueueTest(policy, { groupListExit: 1 });
  assert.equal(unreadable.status, 0);
  assert.match(unreadable.stderr, /could not read the group list/);
  const unreadableAfterCreate = await runPueueTest(policy, {
    groupAddExit: 1,
    groupListExitAfterFirst: 1,
  });
  assert.equal(unreadableAfterCreate.status, 0);
  assert.match(
    unreadableAfterCreate.stderr,
    /could not create the configured group/,
  );
});

test('pueue add uncertainty never falls back or submits a second task', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  for (const scenario of [{ addExit: 1 }, { addOutput: 'not-an-id' }]) {
    const result = await runPueueTest(policy, scenario, ['true'], {
      findFlock: () => null,
    });
    assert.equal(result.status, 3);
    assert.match(
      result.stderr,
      /pueue task outcome unknown \(label idd-local-admission-/,
    );
    const calls = readFakePueue(result.fake).calls as string[][];
    assert.equal(
      calls.some((call) => call[0] === 'log' || call[0] === 'remove'),
      false,
    );
  }
  const timeout = await runPueueTest(
    policy,
    { addHang: true, addDelay: 1500 },
    ['true'],
    { findFlock: () => null, pueueClientTimeoutMs: 800 },
  );
  assert.equal(timeout.status, 3);
  assert.match(timeout.stderr, /outcome unknown \(label idd-local-admission-/);
});

test('pueue log reads only the requested task-ID entry from the JSON response', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const result = await runPueueTest(policy, { logEnvelopeId: '18' }, ['true'], {
    findFlock: () => null,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /pueue task outcome unknown \(task 17\)/);
  const calls = readFakePueue(result.fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'log' && call[1] === '17'));
  assert.equal(
    calls.some((call) => call[0] === 'log' && call.includes('--full')),
    false,
  );
  assert.equal(
    calls.some((call) => call[0] === 'remove'),
    false,
  );
});

test('pueue fetches full output only for a task already finished', {
  skip: process.platform === 'win32',
}, async () => {
  const output: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      callback();
    },
  });
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue' } } },
    {
      initialStatus: { Done: { Success: null } },
      taskOutput: 'finished before follow\n',
    },
    ['true'],
    { findFlock: () => null, stdout },
  );
  await new Promise<void>((resolveFinish) => stdout.end(resolveFinish));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.join(''), 'finished before follow\n');
  const logCalls = (readFakePueue(result.fake).calls as string[][]).filter(
    (call) => call[0] === 'log',
  );
  assert.equal(logCalls.length, 2);
  assert.equal(logCalls[0]?.includes('--full'), false);
  assert.equal(logCalls[1]?.includes('--full'), true);
});

test('pueue full-log error placeholders keep completed tasks outcome unknown', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const errorOutputs = [
    '(Pueue error) Failed to get log file handle: missing log file',
    '(Pueue error) Failed to read local log output file: read failed',
    '(Pueue error) Failed to decompress remote log output: invalid data',
  ];

  for (const taskOutput of errorOutputs) {
    const output: string[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const result = await runPueueTest(
      policy,
      {
        initialStatus: { Done: { Success: null } },
        taskOutput,
      },
      ['true'],
      { findFlock: () => null, stdout },
    );
    await new Promise<void>((resolveFinish) => stdout.end(resolveFinish));
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /pueue task outcome unknown \(task 17\)/);
    assert.equal(output.join(''), '');
    const state = readFakePueue(result.fake);
    assert.ok((state.tasks as Record<string, unknown>)['17']);
    assert.equal(
      (state.calls as string[][]).some(
        (call) => call[0] === 'remove' && call[1] === '17',
      ),
      false,
    );
  }
});

test('pueue returns command status, reports results without exit codes, and tolerates removal failure', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const cases = [
    { status: { Done: { Success: null } }, expected: 0 },
    { status: { Done: { Failed: 23 } }, expected: 23 },
    { status: { Done: { Failed: 75 } }, expected: 75 },
    {
      status: { Done: { FailedToSpawn: 'could not spawn command' } },
      expected: 126,
    },
    { status: { Done: { Killed: null } }, expected: 1 },
    { status: { Done: { Errored: null } }, expected: 1 },
    { status: { Done: { DependencyFailed: null } }, expected: 1 },
  ];
  for (const testCase of cases) {
    const result = await runPueueTest(
      policy,
      {
        initialStatus: testCase.status,
        taskOutput: 'finished output\n',
        removeExit: 1,
      },
      ['true'],
      { findFlock: () => null },
    );
    assert.equal(result.status, testCase.expected);
    if (testCase.expected === 75) assert.doesNotMatch(result.stderr, /expired/);
    assert.match(result.stderr, /could not remove pueue task 17/);
  }
});

test('queued pueue tasks expire by id; stash/removal failures keep expiry definite only after stash', {
  skip: !REAL_LOCK,
}, async () => {
  const policy = {
    localExec: { admission: { backend: 'pueue', maxWait: 'PT1S' } },
  };
  const expired = await runPueueTest(policy, { initialStatus: 'Queued' });
  assert.equal(expired.status, 75);
  assert.match(expired.stderr, /local-admission: expired/);
  assert.match(expired.stderr, /waiting for the pueue validation slot/);
  const calls = readFakePueue(expired.fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'stash' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === '17'));
  const failedRemove = await runPueueTest(policy, {
    initialStatus: 'Queued',
    removeExit: 1,
  });
  assert.equal(failedRemove.status, 75);
  assert.match(failedRemove.stderr, /expired/);
  assert.match(failedRemove.stderr, /could not remove pueue task 17/);
  const unknown = await runPueueTest(policy, {
    initialStatus: 'Queued',
    stashExit: 1,
  });
  assert.equal(unknown.status, 3);
  assert.match(unknown.stderr, /outcome unknown \(task 17\)/);
  for (const status of ['Stashed', 'Locked']) {
    const waiting = await runPueueTest(policy, {
      initialStatus: status,
      stashExit: 1,
    });
    assert.notEqual(waiting.status, 0);
    assert.equal(
      (readFakePueue(waiting.fake).calls as string[][]).some(
        (call) => call[0] === 'follow',
      ),
      false,
    );
  }
  const startedRace = await runPueueTest(policy, {
    initialStatus: 'Queued',
    stashExit: 1,
    logResponses: ['Queued', 'Queued', 'Running'],
    followFinalStatus: { Done: { Success: null } },
    streamOutput: 'ran after queue wait\n',
  });
  assert.equal(startedRace.status, 0);
  assert.doesNotMatch(startedRace.stderr, /expired/);
});

test('pueue follow keeps client stderr separate from task output', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followFinalStatus: { Done: { Success: null } },
    streamOutput: 'task output\n',
    streamStderr: 'pueue diagnostic\n',
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  const result = await run.done;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'task output\n');
  assert.match(result.stderr, /pueue diagnostic/);
});

test('pueue follow pauses output reads when the caller applies backpressure', {
  skip: process.platform === 'win32',
}, async () => {
  const output: string[] = [];
  let maxBuffered = 0;
  let slowStdout!: Writable;
  slowStdout = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      maxBuffered = Math.max(maxBuffered, slowStdout.writableLength);
      setTimeout(callback, 2);
    },
  });
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue' } } },
    {
      initialStatus: 'Running',
      followFinalStatus: { Done: { Success: null } },
      followOutputBytes: 512 * 1024,
    },
    ['true'],
    { stdout: slowStdout },
  );
  await new Promise<void>((resolveFinish) => slowStdout.end(resolveFinish));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.join('').length, 512 * 1024);
  assert.ok(
    maxBuffered <= 128 * 1024,
    `stdout buffer grew to ${maxBuffered} bytes`,
  );
});

test('pueue follow keeps completed tasks when local log diagnostics mean output is incomplete', {
  skip: process.platform === 'win32',
}, async () => {
  const output: string[] = [];
  const diagnostics: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output.push(chunk.toString());
      callback();
    },
  });
  const stderrOutput = new Writable({
    write(chunk, _encoding, callback) {
      diagnostics.push(chunk.toString());
      callback();
    },
  });
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue' } } },
    {
      initialStatus: 'Running',
      followFinalStatus: { Done: { Success: null } },
      followExit: 0,
      streamOutput: 'partial task output\n',
      streamStderr: 'Pueue: Error while reading file: simulated read failure\n',
      taskOutput: 'full task output\n',
    },
    ['true'],
    { stdout, stderrOutput },
  );
  await Promise.all([
    new Promise<void>((resolveFinish) => stdout.end(resolveFinish)),
    new Promise<void>((resolveFinish) => stderrOutput.end(resolveFinish)),
  ]);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(output.join(''), 'partial task output\n');
  assert.match(diagnostics.join(''), /Error while reading file/);
  const state = readFakePueue(result.fake);
  assert.ok((state.tasks as Record<string, unknown>)['17']);
  assert.equal(
    (state.calls as string[][]).some(
      (call) => call[0] === 'remove' && call[1] === '17',
    ),
    false,
  );
});

test('pueue state read failures and task-label mismatches are outcome unknown without task actions', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const readFailure = await runPueueTest(policy, { logExit: 1 }, ['true'], {
    findFlock: () => null,
  });
  assert.equal(readFailure.status, 3);
  assert.ok(
    (readFakePueue(readFailure.fake).tasks as Record<string, unknown>)['17'],
  );
  const readTimeout = await runPueueTest(policy, { logHang: true }, ['true'], {
    findFlock: () => null,
    pueueClientTimeoutMs: 800,
  });
  assert.equal(readTimeout.status, 3);
  assert.ok(
    (readFakePueue(readTimeout.fake).tasks as Record<string, unknown>)['17'],
  );
  const mismatch = await runPueueTest(
    policy,
    {
      taskLabelOverride: 'another-task',
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(mismatch.status, 3);
  const actions = (readFakePueue(mismatch.fake).calls as string[][]).filter(
    (call) => ['stash', 'remove', 'kill'].includes(call[0] ?? ''),
  );
  assert.deepEqual(actions, []);
  const embeddedIdMismatch = await runPueueTest(
    policy,
    { logTaskId: 18 },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(embeddedIdMismatch.status, 3);
  const embeddedIdActions = (
    readFakePueue(embeddedIdMismatch.fake).calls as string[][]
  ).filter((call) => ['stash', 'remove', 'kill'].includes(call[0] ?? ''));
  assert.deepEqual(embeddedIdActions, []);
  assert.ok(
    (readFakePueue(embeddedIdMismatch.fake).tasks as Record<string, unknown>)[
      '17'
    ],
  );
  const disappeared = await runPueueTest(
    policy,
    { deleteTaskOnLogCall: 1 },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(disappeared.status, 3);
});

test('pueue follow failure and early stream end leave a running task outcome unknown', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const followFailure = await runPueueTest(
    policy,
    {
      initialStatus: 'Running',
      followExit: 1,
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(followFailure.status, 3);
  const earlyEnd = await runPueueTest(
    policy,
    {
      initialStatus: 'Running',
      followExit: 0,
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(earlyEnd.status, 3);
  const resultReadFailure = await runPueueTest(
    policy,
    {
      initialStatus: 'Running',
      followExit: 0,
      logFailOnCall: 2,
    },
    ['true'],
    { findFlock: () => null },
  );
  assert.equal(resultReadFailure.status, 3);
});

test('pueue retains a completed task when its follow read fails', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const h = makeHarness();
  const repo = makeRepo(policy);
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followExit: 1,
    followFinalStatus: { Done: { Failed: { exit_code: 7 } } },
    streamOutput: 'partial task output\n',
    taskOutput: 'full task output\n',
  });
  const result = await runBin(['--', 'true'], repo, fake.env).done;
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, 'partial task output\n');
  assert.match(result.stderr, /pueue task outcome unknown \(task 17\)/);
  const state = readFakePueue(fake);
  assert.ok((state.tasks as Record<string, unknown>)['17']);
  assert.equal(
    (state.calls as string[][]).some(
      (call) => call[0] === 'remove' && call[1] === '17',
    ),
    false,
  );
});

test('a signal race retains a completed task when pueue follow fails', {
  skip: process.platform === 'win32',
}, async () => {
  const signalListenersBefore = new Set(process.listeners('SIGTERM'));
  const spawnWithSignalAfterFollowClose = (
    command: string,
    args: string[],
    options: import('node:child_process').SpawnOptions,
  ): ChildProcess => {
    const child = spawn(command, args, options);
    if (args[0] === 'follow') {
      queueMicrotask(() => {
        child.once('close', () => {
          const signalHandler = process
            .listeners('SIGTERM')
            .filter((listener) => !signalListenersBefore.has(listener))
            .at(-1);
          if (typeof signalHandler === 'function') signalHandler('SIGTERM');
        });
      });
    }
    return child;
  };
  const scenarios: {
    logResponses: unknown[];
    killExit?: number;
    expectKill: boolean;
  }[] = [
    {
      logResponses: ['Running', { Done: { Failed: 19 } }],
      expectKill: false,
    },
    {
      logResponses: ['Running', 'Running', { Done: { Failed: 19 } }],
      killExit: 1,
      expectKill: true,
    },
  ];

  for (const scenario of scenarios) {
    const output: string[] = [];
    const stdout = new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const result = await runPueueTest(
      { localExec: { admission: { backend: 'pueue' } } },
      {
        initialStatus: 'Running',
        followExit: 1,
        streamOutput: 'partial task output\n',
        logResponses: scenario.logResponses,
        ...(scenario.killExit === undefined
          ? {}
          : { killExit: scenario.killExit }),
      },
      ['true'],
      {
        findFlock: () => null,
        spawn: spawnWithSignalAfterFollowClose,
        stdout,
      },
    );

    assert.equal(result.status, 3, result.stderr);
    assert.equal(output.join(''), 'partial task output\n');
    assert.match(result.stderr, /pueue task outcome unknown \(task 17\)/);
    const state = readFakePueue(result.fake);
    assert.ok((state.tasks as Record<string, unknown>)['17']);
    const calls = state.calls as string[][];
    assert.equal(
      calls.some((call) => call[0] === 'kill' && call[1] === '17'),
      scenario.expectKill,
    );
    assert.equal(
      calls.some((call) => call[0] === 'remove' && call[1] === '17'),
      false,
    );
  }
});

test('a failed pueue follow racing with SIGTERM still kills and removes the task', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followFailAndSignal: true,
  });
  const result = await runBin(['--', 'true'], repo, fake.env).done;
  assert.equal(result.status, 143, result.stderr);
  const calls = readFakePueue(fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'kill' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === '17'));
});

test('win32 pueue configuration keeps the direct-run behavior with one notice', async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const notes: string[] = [];
  const spawnCalls: string[] = [];
  const status = await runLocalAdmission(
    ['--', process.execPath, '-e', 'process.exit(0)'],
    {
      env: h.env,
      cwd: repo,
      platform: 'win32',
      stderr: (text) => notes.push(text),
      findPueue: () => null,
      spawn: (command, args, options) => {
        spawnCalls.push(command);
        return spawn(command, args, options);
      },
    },
  );
  assert.equal(status, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0] ?? '', /unavailable on win32/);
  assert.deepEqual(spawnCalls, [process.execPath]);
});

test('signals before add stop the client call and submit no task', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'daemon.ready');
  const fake = makeFakePueue(h.env, { statusHang: true, statusReady: ready });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  assert.equal(
    (readFakePueue(fake).calls as string[][]).some((call) => call[0] === 'add'),
    false,
  );
});

test('a signal to the helper process group follows the pre-add signal path', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'daemon.ready');
  const fake = makeFakePueue(h.env, { statusHang: true, statusReady: ready });
  const run = runBin(['--', 'true'], repo, fake.env, true);
  await waitFor(() => existsSync(ready));
  assert.notEqual(run.child.pid, undefined);
  process.kill(-(run.child.pid as number), 'SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  assert.equal(
    (readFakePueue(fake).calls as string[][]).some((call) => call[0] === 'add'),
    false,
  );
});

test('a signal during add waits for its id, then stashes and removes the queued task', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'add.ready');
  const fake = makeFakePueue(h.env, { addHang: true, addReady: ready });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  const calls = readFakePueue(fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'stash' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === '17'));
});

test('a signal during add without a returned task id is outcome unknown', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'add.ready');
  const fake = makeFakePueue(h.env, {
    addHang: true,
    addReady: ready,
    addOutput: 'no task id',
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    /pueue task outcome unknown \(label idd-local-admission-/,
  );
  assert.equal(
    (readFakePueue(fake).calls as string[][]).some(
      (call) => call[0] === 'log' || call[0] === 'stash',
    ),
    false,
  );
});

test('a signal while queued stashes the task and exits with the signal status', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const fake = makeFakePueue(h.env, { initialStatus: 'Queued' });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() =>
    (readFakePueue(fake).calls as string[][]).some((call) => call[0] === 'log'),
  );
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  const calls = readFakePueue(fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'stash' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === '17'));
});

test('a queued signal with failed stash and no observed start is outcome unknown', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Queued',
    stashExit: 1,
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() =>
    (readFakePueue(fake).calls as string[][]).some((call) => call[0] === 'log'),
  );
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 3);
  const calls = readFakePueue(fake).calls as string[][];
  assert.equal(
    calls.some((call) => call[0] === 'remove' || call[0] === 'follow'),
    false,
  );
});

test('a signal while running kills the pueue task; failed kill exits even if follow stays open', {
  skip: process.platform === 'win32',
}, async () => {
  const policy = { localExec: { admission: { backend: 'pueue' } } };
  const h = makeHarness();
  const repo = makeRepo(policy);
  const ready = join(h.state, 'follow.pid');
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followHang: true,
    followReady: ready,
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(
    result.status,
    143,
    `${result.stderr}\n${JSON.stringify(readFakePueue(fake))}`,
  );
  assert.ok(
    (readFakePueue(fake).calls as string[][]).some(
      (call) => call[0] === 'kill' && call[1] === '17',
    ),
  );
  assert.ok(
    (readFakePueue(fake).calls as string[][]).some(
      (call) => call[0] === 'remove' && call[1] === '17',
    ),
  );

  const h2 = makeHarness();
  const repo2 = makeRepo(policy);
  const ready2 = join(h2.state, 'follow.pid');
  const fake2 = makeFakePueue(h2.env, {
    initialStatus: 'Running',
    followHang: true,
    followReady: ready2,
    killExit: 1,
  });
  const run2 = runBin(['--', 'true'], repo2, fake2.env);
  await waitFor(() => existsSync(ready2));
  run2.child.kill('SIGTERM');
  const result2 = await run2.done;
  assert.equal(result2.status, 3);
  assert.match(result2.stderr, /pueue task outcome unknown \(task 17\)/);
  const calls2 = readFakePueue(fake2).calls as string[][];
  assert.ok(calls2.some((call) => call[0] === 'kill' && call[1] === '17'));
  assert.equal(
    calls2.some((call) => call[0] === 'remove' && call[1] === '17'),
    false,
  );

  const h3 = makeHarness();
  const repo3 = makeRepo(policy);
  const ready3 = join(h3.state, 'follow.pid');
  const fake3 = makeFakePueue(h3.env, {
    initialStatus: 'Running',
    followHang: true,
    followDrainDelay: 100,
    followExit: 1,
    followReady: ready3,
  });
  const run3 = runBin(['--', 'true'], repo3, fake3.env);
  await waitFor(() => existsSync(ready3));
  run3.child.kill('SIGTERM');
  const result3 = await run3.done;
  assert.equal(result3.status, 143, result3.stderr);
  const calls3 = readFakePueue(fake3).calls as string[][];
  assert.ok(calls3.some((call) => call[0] === 'kill' && call[1] === '17'));
  assert.ok(calls3.some((call) => call[0] === 'remove' && call[1] === '17'));
});

test('a pending signal still kills a running task when the follow output is incomplete', {
  skip: process.platform === 'win32',
}, async () => {
  const signalListenersBefore = new Set(process.listeners('SIGTERM'));
  const spawnWithSignalAfterFollowClose = (
    command: string,
    args: string[],
    options: import('node:child_process').SpawnOptions,
  ): ChildProcess => {
    const child = spawn(command, args, options);
    if (args[0] === 'follow') {
      queueMicrotask(() => {
        child.once('close', () => {
          const signalHandler = process
            .listeners('SIGTERM')
            .filter((listener) => !signalListenersBefore.has(listener))
            .at(-1);
          if (typeof signalHandler === 'function') signalHandler('SIGTERM');
        });
      });
    }
    return child;
  };
  const result = await runPueueTest(
    { localExec: { admission: { backend: 'pueue' } } },
    {
      initialStatus: 'Running',
      followExit: 1,
      followFinalStatus: 'Running',
      streamStderr: 'Pueue: Error while reading file: simulated failure\n',
    },
    ['true'],
    { findFlock: () => null, spawn: spawnWithSignalAfterFollowClose },
  );
  assert.equal(result.status, 143, result.stderr);
  const calls = readFakePueue(result.fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'kill' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'remove' && call[1] === '17'));
});

test('a signal after the task finishes lets pueue follow drain its remaining output', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'follow.pid');
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followHang: true,
    followDrainDelay: 100,
    followReady: ready,
    streamOutput: 'final output chunk\n',
    logResponses: ['Running', { Done: { Success: null } }],
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'final output chunk\n');
  assert.equal(
    (readFakePueue(fake).calls as string[][]).some(
      (call) => call[0] === 'kill' && call[1] === '17',
    ),
    false,
  );
});

test('a queued signal that races with task start is handled as a running task', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Queued',
    stashExit: 1,
    logResponses: ['Queued', 'Queued', 'Running', 'Running'],
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() =>
    (readFakePueue(fake).calls as string[][]).some((call) => call[0] === 'log'),
  );
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 143);
  const calls = readFakePueue(fake).calls as string[][];
  assert.ok(calls.some((call) => call[0] === 'stash' && call[1] === '17'));
  assert.ok(calls.some((call) => call[0] === 'kill' && call[1] === '17'));
});

test('a failed running kill returns a newly observed finished task status', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'follow.pid');
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followHang: true,
    followDrainDelay: 400,
    followReady: ready,
    killExit: 1,
    logResponses: ['Running', 'Running', { Done: { Failed: 19 } }],
    streamOutput: 'final output chunk\n',
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 19);
  assert.equal(result.stdout, 'final output chunk\n');
  assert.ok(
    (readFakePueue(fake).calls as string[][]).some(
      (call) => call[0] === 'remove' && call[1] === '17',
    ),
  );
});

test('a signal during removal does not replace the finished task status', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'remove.ready');
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Done',
    removeHang: true,
    removeReady: ready,
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  run.child.kill('SIGTERM');
  const result = await run.done;
  assert.equal(result.status, 0);
});

test('SIGKILL of the helper leaves the daemon task untouched', {
  skip: process.platform === 'win32',
}, async () => {
  const h = makeHarness();
  const repo = makeRepo({ localExec: { admission: { backend: 'pueue' } } });
  const ready = join(h.state, 'follow.pid');
  const fake = makeFakePueue(h.env, {
    initialStatus: 'Running',
    followHang: true,
    followReady: ready,
  });
  const run = runBin(['--', 'true'], repo, fake.env);
  await waitFor(() => existsSync(ready));
  const followPid = Number(readFileSync(ready, 'utf8'));
  run.child.kill('SIGKILL');
  await run.done;
  try {
    process.kill(followPid, 'SIGTERM');
  } catch {
    // The fake follow process may already have observed the closed output pipe.
  }
  const calls = readFakePueue(fake).calls as string[][];
  assert.equal(
    calls.some((call) => call[0] === 'kill' || call[0] === 'remove'),
    false,
  );
  assert.ok((readFakePueue(fake).tasks as Record<string, unknown>)['17']);
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

test('a detached descendant cannot retain the validation slot', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'daemon.json');
  const stopFile = join(h.state, 'daemon.stop');
  const exitFile = join(h.state, 'daemon.exit');
  const nextReady = join(h.state, 'next.ready');
  const lockPath = join(h.state, LOCK_RELATIVE);
  const childScript = [
    `const fs = require('node:fs');`,
    `const stopFile = ${JSON.stringify(stopFile)};`,
    `const exitFile = ${JSON.stringify(exitFile)};`,
    `process.on('exit', () => fs.writeFileSync(exitFile, 'exited'));`,
    `const deadline = Date.now() + 5000;`,
    `const timer = setInterval(() => {`,
    `  if (fs.existsSync(stopFile) || Date.now() >= deadline) clearInterval(timer);`,
    `}, 20);`,
    `process.on('SIGTERM', () => clearInterval(timer));`,
  ].join('\n');
  const commandScript = [
    `const fs = require('node:fs');`,
    `const { spawn } = require('node:child_process');`,
    `let inheritedLockFd = false;`,
    `try { const fd = fs.fstatSync(3); const lock = fs.statSync(${JSON.stringify(lockPath)}); inheritedLockFd = fd.dev === lock.dev && fd.ino === lock.ino; } catch {}`,
    `const stdio = inheritedLockFd ? ['ignore', 'ignore', 'ignore', 'inherit'] : 'ignore';`,
    `const daemon = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { detached: true, stdio });`,
    `daemon.unref();`,
    `fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: daemon.pid, inheritedLockFd }));`,
  ].join('\n');
  const first = runBin(
    ['--', process.execPath, '-e', commandScript],
    makeWorkDir(),
    h.env,
  );
  let daemonPid: number | undefined;
  try {
    assert.equal((await first.done).status, 0);
    await waitFor(() => existsSync(ready));
    const daemon = JSON.parse(readFileSync(ready, 'utf8')) as {
      pid: number;
      inheritedLockFd: boolean;
    };
    daemonPid = daemon.pid;
    assert.equal(daemon.inheritedLockFd, false);
    assert.equal(processIsAlive(daemon.pid), true);
    assert.equal(flockStatus(join(h.state, LOCK_RELATIVE)), 0);

    const nextScript = `require('node:fs').writeFileSync(${JSON.stringify(nextReady)}, 'started');`;
    const next = runBin(
      ['--', process.execPath, '-e', nextScript],
      makeWorkDir(),
      h.env,
    );
    assert.equal((await next.done).status, 0);
    assert.equal(existsSync(nextReady), true);
    assert.equal(processIsAlive(daemon.pid), true);
  } finally {
    if (daemonPid === undefined && existsSync(ready)) {
      try {
        daemonPid = (JSON.parse(readFileSync(ready, 'utf8')) as { pid: number })
          .pid;
      } catch {
        // The command may have failed before it wrote a complete readiness file.
      }
    }
    if (daemonPid !== undefined) {
      await stopProcess(daemonPid, stopFile, exitFile);
    }
  }
});

test('a live supervised process group holds the slot after command exit', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'group.ready');
  const pidFile = join(h.state, 'group.pid');
  const pgidFile = join(h.state, 'group.pgid');
  const groupEnded = join(h.state, 'group.ended');
  const nextReady = join(h.state, 'next.ready');
  const commandScript = `(sleep 1; touch "$1") & echo "$!" > "$2"; echo "$PPID" > "$3"; touch "$4"`;
  const first = runBin(
    [
      '--',
      'sh',
      '-c',
      commandScript,
      'sh',
      groupEnded,
      pidFile,
      pgidFile,
      ready,
    ],
    makeWorkDir(),
    h.env,
  );
  let next: ReturnType<typeof runBin> | undefined;
  let supervisedPgid: number | undefined;
  try {
    await waitFor(() => existsSync(ready));
    const childPid = Number(readFileSync(pidFile, 'utf8'));
    supervisedPgid = Number(readFileSync(pgidFile, 'utf8'));
    assert.equal(processIsAlive(childPid), true);
    next = runBin(
      [
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(nextReady)}, 'started');`,
      ],
      makeWorkDir(),
      h.env,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(existsSync(nextReady), false);
    assert.equal(first.child.exitCode, null);

    assert.equal((await first.done).status, 0);
    assert.equal(existsSync(groupEnded), true);
    assert.equal((await next.done).status, 0);
    assert.equal(existsSync(nextReady), true);
  } finally {
    if (supervisedPgid !== undefined) {
      try {
        process.kill(-supervisedPgid, 'SIGTERM');
      } catch {
        // The supervised group may already have ended.
      }
    }
    if (first.child.exitCode === null && first.child.signalCode === null) {
      first.child.kill('SIGTERM');
      await first.done;
    }
    if (
      next !== undefined &&
      next.child.exitCode === null &&
      next.child.signalCode === null
    ) {
      next.child.kill('SIGTERM');
      await next.done;
    }
  }
});

test('the wrapper holds the slot after its helper is killed', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const groupEnded = join(h.state, 'killed-helper.group-ended');
  const pgidFile = join(h.state, 'killed-helper.pgid');
  const ready = join(h.state, 'killed-helper.ready');
  const nextReady = join(h.state, 'killed-helper.next-ready');
  const commandScript =
    `(sleep 1.5; touch "$1") & ` + `echo "$PPID" > "$2"; touch "$3"`;
  const first = runBin(
    ['--', 'sh', '-c', commandScript, 'sh', groupEnded, pgidFile, ready],
    makeWorkDir(),
    h.env,
  );
  let supervisedPgid: number | undefined;
  let next: ReturnType<typeof runBin> | undefined;
  try {
    await waitFor(() => existsSync(ready));
    supervisedPgid = Number(readFileSync(pgidFile, 'utf8'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    first.child.kill('SIGKILL');

    next = runBin(
      [
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(nextReady)}, 'started');`,
      ],
      makeWorkDir(),
      h.env,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    assert.equal(flockStatus(join(h.state, LOCK_RELATIVE)), 1);
    assert.equal(existsSync(nextReady), false);

    await waitFor(() => existsSync(groupEnded), 5000);
    assert.equal((await first.done).signal, 'SIGKILL');
    assert.equal((await next.done).status, 0);
    assert.equal(existsSync(nextReady), true);
  } finally {
    if (supervisedPgid !== undefined) {
      try {
        process.kill(-supervisedPgid, 'SIGTERM');
      } catch {
        // The supervised group may already have ended.
      }
    }
    if (first.child.exitCode === null && first.child.signalCode === null) {
      first.child.kill('SIGKILL');
      await first.done;
    }
    if (
      next !== undefined &&
      next.child.exitCode === null &&
      next.child.signalCode === null
    ) {
      next.child.kill('SIGTERM');
      await next.done;
    }
  }
});

test('SIGTERM keeps the slot until the signalled process group exits', {
  skip: !REAL_LOCK,
}, async () => {
  const h = makeHarness();
  const ready = join(h.state, 'signal.ready');
  const termed = join(h.state, 'signal.termed');
  const groupEnded = join(h.state, 'signal.ended');
  const nextReady = join(h.state, 'next.ready');
  const script =
    `trap 'touch "$1"; sleep 0.8; touch "$2"; exit 0' TERM; ` +
    `touch "$3"; while :; do sleep 1; done`;
  const first = runBin(
    ['--', 'sh', '-c', script, 'sh', termed, groupEnded, ready],
    makeWorkDir(),
    h.env,
  );
  let next: ReturnType<typeof runBin> | undefined;
  try {
    await waitFor(() => existsSync(ready));
    first.child.kill('SIGTERM');
    await waitFor(() => existsSync(termed));
    next = runBin(
      [
        '--',
        process.execPath,
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(nextReady)}, 'started');`,
      ],
      makeWorkDir(),
      h.env,
    );
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
    assert.equal(existsSync(nextReady), false);

    assert.equal((await first.done).status, 143);
    assert.equal(existsSync(groupEnded), true);
    assert.equal((await next.done).status, 0);
    assert.equal(existsSync(nextReady), true);
  } finally {
    if (first.child.exitCode === null && first.child.signalCode === null) {
      first.child.kill('SIGTERM');
      await first.done;
    }
    if (
      next !== undefined &&
      next.child.exitCode === null &&
      next.child.signalCode === null
    ) {
      next.child.kill('SIGTERM');
      await next.done;
    }
  }
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
