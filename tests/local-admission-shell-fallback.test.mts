/**
 * Runs the helper-free shell fallback from `idd-template/docs/idd-helper-scripts.md`
 * (the canonical source of its fenced block) and checks the slot lifetime on
 * ordinary completion, not only on signals (issue `#4702`).
 *
 * The fragment is documented as Bash-compatible, so the wrapper runs under
 * bash. Under dash, `kill -SIG -- -PGID` is refused ("Illegal number"), so
 * forwarded group signals never reach the group; that predates this change and
 * is not covered here.
 *
 * Every case uses bounded children that also stop when the test writes a
 * release file, readiness files so the contender starts only after the holder
 * owns the slot, and a teardown that kills the holder groups it created.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findExecutableOnPath } from '../src/scripts/idd-local-admission.mts';
import { trackTempDirectories } from './temp-fixtures.mts';

const TEMPLATE_DOC = fileURLToPath(
  new URL('../idd-template/docs/idd-helper-scripts.md', import.meta.url),
);
const WAIT_LINE =
  'wait_seconds=7200 # Replace with the validated repository maxWait when set.';
const WRAPPER_SHELL = '/bin/bash';
const SKIP =
  process.platform === 'win32' ||
  !existsSync(WRAPPER_SHELL) ||
  !existsSync('/proc') ||
  ['flock', 'setsid', 'ps'].some(
    (tool) => findExecutableOnPath(tool, process.env) === null,
  )
    ? 'needs POSIX host with bash, flock, setsid, ps, and procfs'
    : false;
const REAL_PS = findExecutableOnPath('ps', process.env) ?? '/bin/ps';
const LOCK_RELATIVE = join('idd-skill', 'local-admission', 'validate.lock');
/** Upper bound for any one wait in this file. */
const WAIT_MS = 20_000;
/** Upper bound for a whole case, so a hang fails instead of stalling the run. */
const TEST_TIMEOUT_MS = 120_000;

const makeTempDirectory = trackTempDirectories();

/** A tracked directory under the suite's temporary root, named with `prefix`. */
function tempDir(prefix: string): string {
  return makeTempDirectory(join(tmpdir(), prefix));
}

/** Single-quotes `value` for POSIX sh. */
function sq(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

/** Waits until `predicate` holds, failing with `what` after the bound. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await delay(20);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True while any member of the process group `pgid` is alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file: string): number {
  return Number(readFileSync(file, 'utf8').trim());
}

/** True once `file` exists and holds a pid, so a half-written file is not read. */
function hasPid(file: string): boolean {
  return existsSync(file) && readFileSync(file, 'utf8').trim() !== '';
}

/** The bounded loop: it stops on the release file or after about 30 seconds. */
function holdLoop(release: string): string {
  return `i=0; while [ ! -e ${sq(release)} ] && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done`;
}

/** A contender command: records `after` when `marker` exists at its entry. */
function probe(marker: string, order: string): string {
  return `if [ -e ${sq(marker)} ]; then echo after > ${sq(order)}; else echo before > ${sq(order)}; fi; exit 0`;
}

/**
 * The fenced sh block, with the shell and command set and `wait_seconds`
 * bounded. The command is read from `commandFile` so no quoting is needed.
 */
function fallbackScript(commandFile: string, waitSeconds: number): string {
  const matches = [
    ...readFileSync(TEMPLATE_DOC, 'utf8').matchAll(
      /```sh\n(child_pid=\n[\s\S]*?)\n```/g,
    ),
  ];
  assert.equal(matches.length, 1, 'one fallback fenced block');
  const block = matches[0]?.[1] ?? '';
  assert.equal(
    block.split(WAIT_LINE).length - 1,
    1,
    'the wait_seconds line appears once',
  );
  return [
    'shell=/bin/sh',
    `command=$(cat ${sq(commandFile)})`,
    block.replace(WAIT_LINE, `wait_seconds=${waitSeconds}`),
    '',
  ].join('\n');
}

interface Wrapper {
  child: ChildProcess;
  /** Resolves with the exit status, or 128 plus the signal number. */
  exited: Promise<number>;
  settled: () => boolean;
  stderr: () => string;
}

/** Starts one fallback wrapper with `command` as its child argv. */
function startWrapper(
  dir: string,
  name: string,
  command: string,
  env: NodeJS.ProcessEnv,
  waitSeconds: number,
): Wrapper {
  const commandFile = join(dir, `${name}.cmd`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(commandFile, command);
  writeFileSync(script, fallbackScript(commandFile, waitSeconds));
  // Detached, so the wrapper leads its own group and teardown also ends its
  // flock waiter, which would otherwise hold the stdio pipes open.
  const child = spawn(WRAPPER_SHELL, [script], {
    detached: true,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let done = false;
  child.stdout?.resume();
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<number>((resolve) => {
    child.once('close', (code, signal) => {
      done = true;
      resolve(
        code ??
          128 + (signal === null ? 0 : (osConstants.signals[signal] ?? 0)),
      );
    });
  });
  return { child, exited, settled: () => done, stderr: () => stderr };
}

/** Environment for a wrapper: fresh state, and `stubDir` first on PATH when set. */
function fallbackEnv(dir: string, stubDir?: string): NodeJS.ProcessEnv {
  const basePath = process.env.PATH ?? '/usr/bin:/bin';
  return {
    HOME: dir,
    LC_ALL: 'C',
    PATH: stubDir === undefined ? basePath : `${stubDir}:${basePath}`,
    XDG_STATE_HOME: join(dir, 'state'),
  };
}

/**
 * Stops everything the case started: releases the bounded children, kills any
 * live wrapper, and kills each recorded holder group, then waits for the
 * wrappers to settle.
 */
async function teardown(
  dir: string,
  wrappers: Wrapper[],
  groups: number[],
): Promise<void> {
  writeFileSync(join(dir, 'release'), '');
  for (const wrapper of wrappers) {
    if (wrapper.settled()) continue;
    const pid = wrapper.child.pid;
    if (pid !== undefined && pid > 0) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    }
    wrapper.child.kill('SIGKILL');
  }
  for (const pid of groups) {
    if (pid <= 0) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
  await Promise.all(wrappers.map((wrapper) => wrapper.exited));
}

/** Writes an executable `ps` stub that delegates to the real ps. */
function writePsStub(dir: string, body: string): string {
  const stubDir = join(dir, 'bin');
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, 'ps');
  writeFileSync(stub, `#!/bin/sh\n${body}`);
  chmodSync(stub, 0o755);
  return stubDir;
}

test('a same-group child holds the slot until the group drains after a normal root exit', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-drain-');
  const env = fallbackEnv(dir);
  const release = join(dir, 'release');
  const childDone = join(dir, 'child-done');
  const started = join(dir, 'started');
  const rootPidFile = join(dir, 'root.pid');
  const order = join(dir, 'order');
  const wrappers: Wrapper[] = [];
  const groups: number[] = [];
  try {
    // The root exits 7 at once; its subshell child is in the same group.
    const holder = startWrapper(
      dir,
      'holder',
      `: > ${sq(started)}; ( ${holdLoop(release)}; touch ${sq(childDone)} ) </dev/null >/dev/null 2>&1 & echo $$ > ${sq(rootPidFile)}; exit 7`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => hasPid(rootPidFile), 'the root to record its pid');
    const rootPid = readPid(rootPidFile);
    groups.push(rootPid);
    await waitFor(() => !isAlive(rootPid), 'the root to exit');
    assert.equal(holder.settled(), false, 'the holder waits for the group');
    assert.equal(existsSync(childDone), false, 'the group child is alive');

    const early = startWrapper(
      dir,
      'early',
      `echo entered > ${sq(join(dir, 'early-order'))}; exit 0`,
      env,
      2,
    );
    wrappers.push(early);
    assert.equal(await early.exited, 75, 'the early contender expires');
    assert.match(early.stderr(), /expired/);
    assert.equal(existsSync(join(dir, 'early-order')), false);

    const queued = startWrapper(
      dir,
      'queued',
      probe(childDone, order),
      env,
      60,
    );
    wrappers.push(queued);
    await delay(1000);
    assert.equal(queued.settled(), false, 'the queued contender stays queued');

    writeFileSync(release, '');
    assert.equal(await holder.exited, 7, 'the original root status is kept');
    assert.equal(existsSync(childDone), true, 'the group drained first');
    assert.equal(await queued.exited, 0);
    assert.equal(readFileSync(order, 'utf8').trim(), 'after');
  } finally {
    await teardown(dir, wrappers, groups);
  }
});

test('SIGTERM during the drain is forwarded and the slot waits for the group', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-term-');
  const env = fallbackEnv(dir);
  const release = join(dir, 'release');
  const termSeen = join(dir, 'term-seen');
  const started = join(dir, 'started');
  const rootPidFile = join(dir, 'root.pid');
  const order = join(dir, 'order');
  const wrappers: Wrapper[] = [];
  const groups: number[] = [];
  try {
    const holder = startWrapper(
      dir,
      'holder',
      `: > ${sq(started)}; ( trap 'touch ${sq(termSeen)}; exit 0' TERM; ${holdLoop(release)} ) </dev/null >/dev/null 2>&1 & echo $$ > ${sq(rootPidFile)}; exit 0`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => hasPid(rootPidFile), 'the root to record its pid');
    groups.push(readPid(rootPidFile));
    await waitFor(() => !isAlive(readPid(rootPidFile)), 'the root to exit');
    assert.equal(holder.settled(), false, 'the holder waits for the group');

    const queued = startWrapper(dir, 'queued', probe(termSeen, order), env, 60);
    wrappers.push(queued);
    await delay(1000);
    assert.equal(queued.settled(), false);

    holder.child.kill('SIGTERM');
    assert.equal(await holder.exited, 143, 'TERM keeps the 143 status');
    assert.equal(await queued.exited, 0);
    assert.equal(readFileSync(order, 'utf8').trim(), 'after');
    assert.equal(existsSync(started), true);
  } finally {
    await teardown(dir, wrappers, groups);
  }
});

test('SIGINT during the command is forwarded and the slot waits for the group', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-int-');
  const env = fallbackEnv(dir);
  const sleeping = join(dir, 'sleeping');
  const rootPidFile = join(dir, 'root.pid');
  const order = join(dir, 'order');
  const wrappers: Wrapper[] = [];
  const groups: number[] = [];
  try {
    const holder = startWrapper(
      dir,
      'holder',
      `echo $$ > ${sq(rootPidFile)}; : > ${sq(sleeping)}; sleep 30`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => existsSync(sleeping), 'the command to start sleeping');
    groups.push(readPid(rootPidFile));
    await delay(200);

    const rootPid = groups[0] ?? 0;
    assert.equal(
      groupAlive(rootPid),
      true,
      'the group is alive before the signal',
    );
    const queued = startWrapper(
      dir,
      'queued',
      `if kill -s 0 -- -${rootPid} 2>/dev/null; then echo alive > ${sq(order)}; else echo gone > ${sq(order)}; fi; exit 0`,
      env,
      60,
    );
    wrappers.push(queued);
    await delay(500);
    assert.equal(queued.settled(), false, 'the slot is held before the signal');

    holder.child.kill('SIGINT');
    assert.equal(await holder.exited, 130, 'INT keeps the 130 status');
    assert.equal(await queued.exited, 0);
    assert.equal(readFileSync(order, 'utf8').trim(), 'gone');
  } finally {
    await teardown(dir, wrappers, groups);
  }
});

test('a ps failure or malformed listing after start keeps the slot until ps recovers', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-ps-');
  const count = join(dir, 'ps-count');
  const recovered = join(dir, 'recovered');
  const started = join(dir, 'started');
  const order = join(dir, 'order');
  // Call 1 is the start probe. Calls 2-3 fail, calls 4-5 are malformed,
  // and call 6 onward is real.
  const stubDir = writePsStub(
    dir,
    `n=$(cat ${sq(count)} 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > ${sq(count)}
if [ "$n" -eq 1 ]; then exec ${sq(REAL_PS)} "$@"; fi
if [ "$n" -le 3 ]; then exit 1; fi
if [ "$n" -le 5 ]; then echo 'not a process listing'; exit 0; fi
: > ${sq(recovered)}
exec ${sq(REAL_PS)} "$@"
`,
  );
  const env = fallbackEnv(dir, stubDir);
  const wrappers: Wrapper[] = [];
  try {
    const holder = startWrapper(
      dir,
      'holder',
      `: > ${sq(started)}; exit 0`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => existsSync(started), 'the holder to start');
    const queued = startWrapper(
      dir,
      'queued',
      probe(recovered, order),
      env,
      60,
    );
    wrappers.push(queued);
    assert.equal(await holder.exited, 0, 'the root status is kept');
    assert.equal(
      await queued.exited,
      0,
      'the contender is admitted only after ps recovers',
    );
    assert.equal(readFileSync(order, 'utf8').trim(), 'after');
    assert.ok(
      Number(readFileSync(count, 'utf8').trim()) >= 6,
      'the failing and malformed listings were consumed',
    );
  } finally {
    await teardown(dir, wrappers, []);
  }
});

for (const state of ['Z', 'X']) {
  test(`a group whose only remaining members are ${state} releases the slot`, {
    skip: SKIP,
    timeout: TEST_TIMEOUT_MS,
  }, async () => {
    const dir = tempDir(`idd-fallback-${state.toLowerCase()}-`);
    const rootPidFile = join(dir, 'root.pid');
    const started = join(dir, 'started');
    const order = join(dir, 'order');
    // The stub lists the root group as having only dead members.
    const stubDir = writePsStub(
      dir,
      `${sq(REAL_PS)} "$@" || exit $?
if [ -f ${sq(rootPidFile)} ]; then printf '%s ${state}\\n' "$(cat ${sq(rootPidFile)})"; fi
`,
    );
    const env = fallbackEnv(dir, stubDir);
    const wrappers: Wrapper[] = [];
    try {
      const holder = startWrapper(
        dir,
        'holder',
        `echo $$ > ${sq(rootPidFile)}; : > ${sq(started)}; exit 7`,
        env,
        30,
      );
      wrappers.push(holder);
      await waitFor(() => existsSync(started), 'the holder to start');
      const queued = startWrapper(
        dir,
        'queued',
        `echo admitted > ${sq(order)}; exit 0`,
        env,
        60,
      );
      wrappers.push(queued);
      assert.equal(await holder.exited, 7, 'the root status is kept');
      assert.equal(await queued.exited, 0, 'the slot is released');
      assert.equal(readFileSync(order, 'utf8').trim(), 'admitted');
    } finally {
      await teardown(dir, wrappers, []);
    }
  });
}

test('a detached daemon in another process group does not hold the slot', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-daemon-');
  const env = fallbackEnv(dir);
  const release = join(dir, 'release');
  const daemonDone = join(dir, 'daemon-done');
  const daemonScript = join(dir, 'daemon.sh');
  const daemonPidFile = join(dir, 'daemon.pid');
  const started = join(dir, 'started');
  const order = join(dir, 'order');
  writeFileSync(
    daemonScript,
    `${holdLoop(release)}; touch ${sq(daemonDone)}\n`,
  );
  const wrappers: Wrapper[] = [];
  const groups: number[] = [];
  try {
    // setsid gives the daemon its own group, so the root group drains at once.
    const holder = startWrapper(
      dir,
      'holder',
      `setsid /bin/sh ${sq(daemonScript)} </dev/null >/dev/null 2>&1 & echo $! > ${sq(daemonPidFile)}; : > ${sq(started)}; exit 0`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => hasPid(daemonPidFile), 'the daemon to start');
    const daemonPid = readPid(daemonPidFile);
    groups.push(daemonPid);
    assert.equal(
      await holder.exited,
      0,
      'the holder does not wait for the daemon',
    );
    assert.equal(existsSync(daemonDone), false, 'the daemon is still alive');

    const lockPath = realpathSync(join(dir, 'state', LOCK_RELATIVE));
    const heldDescriptors = readdirSync(`/proc/${daemonPid}/fd`).filter(
      (fd) => {
        try {
          return readlinkSync(`/proc/${daemonPid}/fd/${fd}`) === lockPath;
        } catch {
          return false;
        }
      },
    );
    assert.deepEqual(
      heldDescriptors,
      [],
      'the daemon holds no lock descriptor',
    );

    const queued = startWrapper(
      dir,
      'queued',
      `if [ -e ${sq(daemonDone)} ]; then echo finished > ${sq(order)}; else echo alive > ${sq(order)}; fi; exit 0`,
      env,
      60,
    );
    wrappers.push(queued);
    assert.equal(
      await queued.exited,
      0,
      'the slot is admitted while the daemon lives',
    );
    assert.equal(readFileSync(order, 'utf8').trim(), 'alive');
  } finally {
    await teardown(dir, wrappers, groups);
  }
});

test('a SIGKILLed wrapper frees the slot while a detached daemon survives', {
  skip: SKIP,
  timeout: TEST_TIMEOUT_MS,
}, async () => {
  const dir = tempDir('idd-fallback-kill-');
  const env = fallbackEnv(dir);
  const release = join(dir, 'release');
  const daemonScript = join(dir, 'daemon.sh');
  const daemonDone = join(dir, 'daemon-done');
  const daemonPidFile = join(dir, 'daemon.pid');
  const rootPidFile = join(dir, 'root.pid');
  const started = join(dir, 'started');
  const order = join(dir, 'order');
  writeFileSync(
    daemonScript,
    `${holdLoop(release)}; touch ${sq(daemonDone)}\n`,
  );
  const wrappers: Wrapper[] = [];
  const groups: number[] = [];
  try {
    // The root keeps running in the foreground while the wrapper is killed.
    // Its own stdio is detached so the killed wrapper's pipes can close.
    const holder = startWrapper(
      dir,
      'holder',
      `exec </dev/null >/dev/null 2>&1; echo $$ > ${sq(rootPidFile)}; setsid /bin/sh ${sq(daemonScript)} </dev/null >/dev/null 2>&1 & echo $! > ${sq(daemonPidFile)}; : > ${sq(started)}; sleep 30`,
      env,
      30,
    );
    wrappers.push(holder);
    await waitFor(() => existsSync(started), 'the holder to start');
    groups.push(readPid(rootPidFile));
    groups.push(readPid(daemonPidFile));
    holder.child.kill('SIGKILL');
    assert.equal(await holder.exited, 137, 'the wrapper was killed');
    assert.equal(existsSync(daemonDone), false, 'the daemon is still alive');

    const queued = startWrapper(
      dir,
      'queued',
      `: > ${sq(order)}; exit 0`,
      env,
      5,
    );
    wrappers.push(queued);
    assert.equal(
      await queued.exited,
      0,
      'the slot is free once the wrapper dies',
    );
    assert.equal(existsSync(order), true);
    assert.equal(existsSync(daemonDone), false, 'the daemon outlived the slot');
  } finally {
    await teardown(dir, wrappers, groups);
  }
});
