import assert from 'node:assert/strict';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { renderProviderOutageParkComment } from '../src/scripts/marker-helpers.mts';
import {
  type ChildCloseResult,
  DEFAULT_READ_BUDGET_MS,
  MAX_READ_BUDGET_MS,
  parseReadBudget,
  superviseReadMode,
  terminateOwnedProcessTree,
} from '../src/scripts/provider-outage-park.mts';
import { stubExecutable } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/provider-outage-park.mjs');
const BIN_PATH = join(REPO_ROOT, 'bin/idd-provider-outage-park.mjs');

const GH_SCRIPT = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const route = args.find((arg) => arg.startsWith('repos/')) || args.join(' ');
if (process.env.IDD_TEST_GH_LOG) {
  fs.appendFileSync(process.env.IDD_TEST_GH_LOG, JSON.stringify({ pid: process.pid, route }) + '\\n');
}
const delayMs = route.includes('/comments')
  ? Number(process.env.IDD_TEST_GH_COMMENTS_DELAY_MS || process.env.IDD_TEST_GH_DELAY_MS || 0)
  : route.includes('/pulls?state=all')
    ? Number(process.env.IDD_TEST_GH_HEALTH_DELAY_MS || process.env.IDD_TEST_GH_DELAY_MS || 0)
    : Number(process.env.IDD_TEST_GH_DELAY_MS || 0);
const heartbeatPath = process.env.IDD_TEST_GH_DESCENDANT_HEARTBEAT_PATH;
if (heartbeatPath && (route.includes('/comments') || route.includes('repo view'))) {
  const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");process.on("SIGTERM",()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],"x"),20)', heartbeatPath], { stdio: 'ignore' });
  fs.writeFileSync(heartbeatPath + '.pid', String(child.pid));
}
if (delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write('{"owner":{"login":"example"},"name":"sample"}');
} else if (route.includes('/pulls?state=open')) {
  process.stdout.write(process.env.IDD_TEST_GH_OPEN_PRS || '[]');
} else if (route.includes('/comments')) {
  process.stdout.write(process.env.IDD_TEST_GH_COMMENTS || '[]');
} else {
  process.stdout.write('[]');
}
`;

function createTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'idd-provider-outage-park-'));
}

function ownProcessGroupId(): number {
  const stat = readFileSync('/proc/self/stat', 'utf8');
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  const processGroup = Number(fields[2]);
  assert.ok(Number.isSafeInteger(processGroup));
  return processGroup;
}

function writeProcStat(
  procRoot: string,
  pid: number,
  processGroup: number,
  state: string,
): void {
  const processRoot = join(procRoot, String(pid));
  mkdirSync(processRoot, { recursive: true });
  writeFileSync(
    join(processRoot, 'stat'),
    `${pid} (fake child) ${state} 1 ${processGroup} 1\n`,
  );
}

function ghEnv(
  logPath: string,
  values: {
    delayMs?: number;
    commentsDelayMs?: number;
    openPullRequests?: string;
    comments?: string;
    envelope?: boolean;
    descendantHeartbeatPath?: string;
    healthDelayMs?: number;
  } = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_STATE_HOME: join(dirname(logPath), 'state'),
    TMPDIR: dirname(logPath),
    TMP: dirname(logPath),
    TEMP: dirname(logPath),
    IDD_TEST_GH_LOG: logPath,
    IDD_TEST_GH_DELAY_MS: String(values.delayMs ?? 0),
    IDD_TEST_GH_COMMENTS_DELAY_MS: String(values.commentsDelayMs ?? 0),
    IDD_TEST_GH_HEALTH_DELAY_MS: String(values.healthDelayMs ?? 0),
    IDD_TEST_GH_OPEN_PRS: values.openPullRequests ?? '[]',
    IDD_TEST_GH_COMMENTS: values.comments ?? '[]',
    ...(values.descendantHeartbeatPath
      ? {
          IDD_TEST_GH_DESCENDANT_HEARTBEAT_PATH: values.descendantHeartbeatPath,
        }
      : {}),
    ...(values.envelope ? { IDD_HELPER_ERROR_ENVELOPE: '1' } : {}),
  };
}

function readCalls(logPath: string): { pid: number; route: string }[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { pid: number; route: string });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    stdio: (PassThrough | null)[];
    send: (
      message: unknown,
      callback?: (error: Error | null) => void,
    ) => boolean;
    kill: () => boolean;
  };
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const stage = new PassThrough();
  child.stdio = [null, child.stdout, child.stderr, stage];
  child.send = (_message, callback) => {
    callback?.(null);
    return true;
  };
  child.kill = () => true;
  return child as unknown as ChildProcess;
}

function fakeTaskkillSpawn(
  exitCodes: number[],
  calls: string[][],
): typeof spawn {
  return ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const child = fakeChild(50001 + calls.length);
    const code = exitCodes.shift() ?? 0;
    setImmediate(() => child.emit('close', code, null));
    return child;
  }) as unknown as typeof spawn;
}

function fakeWindowsSupervisorSpawn(
  worker: ChildProcess,
  taskkillExitCodes: number[],
  onTaskkill: () => void,
  calls: string[][],
  workerEnvironment: { value?: NodeJS.ProcessEnv },
): typeof spawn {
  return ((
    command: string,
    args: string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    if (command === 'taskkill') {
      calls.push([command, ...args]);
      const taskkill = fakeChild(50010 + calls.length);
      const exitCode = taskkillExitCodes.shift() ?? 0;
      setImmediate(() => {
        onTaskkill();
        if (exitCode === 0) {
          (worker.stdout as PassThrough).end();
          (worker.stderr as PassThrough).end();
          (worker.stdio[3] as PassThrough).end();
          worker.emit('close', null, 'SIGTERM');
        }
        taskkill.emit('close', exitCode, null);
      });
      return taskkill;
    }

    workerEnvironment.value = options?.env;
    const token = options?.env?.IDD_PROVIDER_OUTAGE_PARK_READ_WORKER_TOKEN;
    setImmediate(() => {
      (worker.stdout as PassThrough).end('{"complete":true}\n');
      (worker.stderr as PassThrough).end();
      (worker.stdio[3] as PassThrough).end();
      setImmediate(() =>
        worker.emit('message', {
          type: 'idd-provider-outage-park-read-worker-completed',
          token,
        }),
      );
    });
    return worker;
  }) as unknown as typeof spawn;
}

test('read-only success works through the direct script and packaged bin', () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'gh.jsonl');
  try {
    for (const entry of [SCRIPT_PATH, BIN_PATH]) {
      const result = spawnSync(
        process.execPath,
        [entry, '--owner', 'example', '--repo', 'sample'],
        { cwd: root, encoding: 'utf8', env: ghEnv(logPath), timeout: 5_000 },
      );
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as Record<string, unknown>;
      assert.deepEqual(report.parkedIssues, []);
      assert.equal(report.parkedIssuesComplete, true);
      assert.equal(result.stderr.includes('provider-outage-park: start'), true);
    }

    const summary = spawnSync(
      process.execPath,
      [BIN_PATH, '--parked-issues', '--owner', 'example', '--repo', 'sample'],
      { cwd: root, encoding: 'utf8', env: ghEnv(logPath), timeout: 5_000 },
    );
    assert.equal(summary.status, 0, summary.stderr);
    assert.deepEqual(JSON.parse(summary.stdout), {
      parkedIssues: [],
      parkedIssuesComplete: true,
    });
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid budgets and an explicit budget with --park fail before gh runs', () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'gh.jsonl');
  try {
    for (const args of [
      ['--budget-ms', '0'],
      ['--budget-ms', '-1'],
      ['--budget-ms', '1.5'],
      ['--budget-ms', 'NaN'],
      ['--budget-ms', 'Infinity'],
      ['--budget-ms', ''],
      ['--budget-ms', '2147483648'],
      ['--park', '--budget-ms', '1'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [BIN_PATH, ...args, '--owner', 'example', '--repo', 'sample'],
        { cwd: root, encoding: 'utf8', env: ghEnv(logPath), timeout: 5_000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(
        result.stderr,
        /invalid --budget-ms|available only in read-only modes/,
      );
    }
    assert.deepEqual(readCalls(logPath), []);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('packaged unknown arguments keep concise usage output', () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'gh.jsonl');
  try {
    const result = spawnSync(process.execPath, [BIN_PATH, '--wat'], {
      cwd: root,
      encoding: 'utf8',
      env: ghEnv(logPath),
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown argument: --wat/);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.deepEqual(readCalls(logPath), []);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker environment flags alone cannot bypass the read supervisor', () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'gh.jsonl');
  try {
    const result = spawnSync(
      process.execPath,
      [
        BIN_PATH,
        '--owner',
        'example',
        '--repo',
        'sample',
        '--budget-ms',
        '700',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...ghEnv(logPath, { delayMs: 2_000, envelope: true }),
          IDD_PROVIDER_OUTAGE_PARK_READ_WORKER: '1',
          IDD_PROVIDER_OUTAGE_PARK_STAGE_FD: '3',
        },
        timeout: 6_000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /provider-outage-park: start mode=list/);
    assert.match(result.stderr, /read budget expired after 700ms/);
    assert.equal((result.stderr.match(/"iddHelperError"/g) ?? []).length, 1);
    assert.ok(readCalls(logPath).length >= 1);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('read budget parsing accepts both inclusive boundaries', () => {
  assert.equal(DEFAULT_READ_BUDGET_MS, 120_000);
  assert.equal(parseReadBudget('1'), 1);
  assert.equal(parseReadBudget(String(MAX_READ_BUDGET_MS)), MAX_READ_BUDGET_MS);
});

test('the parent reports progress while a synchronous gh read is blocked', async () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'gh.jsonl');
  const output: Buffer[] = [];
  const errors: string[] = [];
  try {
    const result = await superviseReadMode(
      'list',
      2_000,
      ['--owner', 'example', '--repo', 'sample'],
      {
        cwd: root,
        env: ghEnv(logPath, { delayMs: 160 }),
        entryPath: SCRIPT_PATH,
        progressIntervalMs: 20,
        writeStdout: (chunk) => output.push(Buffer.from(chunk)),
        writeStderr: (text) => errors.push(text),
      },
    );
    assert.equal(result, 0);
    assert.deepEqual(
      JSON.parse(Buffer.concat(output).toString()).parkedIssues,
      [],
    );
    assert.match(errors.join(''), /start mode=list/);
    assert.match(
      errors.join(''),
      /progress mode=list .*stage=open-pr-enumeration/,
    );
    assert.ok(readCalls(logPath).length >= 1);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a worker that exits before its owned descendants is reaped before success', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(45681);
  const output: Buffer[] = [];
  const errors: string[] = [];
  const signals: NodeJS.Signals[] = [];
  let groupAlive = true;
  const fakeSpawn = (() => {
    setImmediate(() => {
      (child.stdout as PassThrough).end('{"complete":true}\n');
      (child.stderr as PassThrough).end();
      (child.stdio[3] as PassThrough).end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as typeof spawn;

  const result = await superviseReadMode('list', 1_000, [], {
    platform: 'linux',
    spawnProcess: fakeSpawn,
    cleanupBudgetMs: 100,
    signalProcessGroup: (_pid, signal) => {
      signals.push(signal);
      groupAlive = false;
    },
    processGroupExists: () => groupAlive,
    writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    writeStderr: (text) => errors.push(text),
  });

  assert.equal(result, 0);
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(Buffer.concat(output).toString(), '{"complete":true}\n');
  assert.match(errors.join(''), /stopped remaining owned descendants/);
});

test('a closed worker with an unreaped process group cannot publish success', {
  skip: process.platform === 'win32',
}, async () => {
  const child = fakeChild(45682);
  const output: Buffer[] = [];
  const errors: string[] = [];
  const fakeSpawn = (() => {
    setImmediate(() => {
      (child.stdout as PassThrough).end('{"mustNotEscape":true}\n');
      (child.stderr as PassThrough).end();
      (child.stdio[3] as PassThrough).end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as typeof spawn;

  const result = await superviseReadMode('list', 1_000, [], {
    platform: 'linux',
    spawnProcess: fakeSpawn,
    cleanupBudgetMs: 10,
    signalProcessGroup: () => {},
    processGroupExists: () => true,
    writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    writeStderr: (text) => errors.push(text),
  });

  assert.equal(typeof result, 'object');
  if (typeof result === 'object') assert.equal(result.exitCode, 1);
  assert.equal(Buffer.concat(output).length, 0);
  assert.match(errors.join(''), /cleanup failed within 10ms/);
});

test('Linux cleanup ignores a process group containing only zombies', {
  skip: process.platform !== 'linux',
}, async () => {
  const processGroup = ownProcessGroupId();
  const child = fakeChild(processGroup);
  const procRoot = createTempRoot();
  writeProcStat(procRoot, 45686, processGroup, 'Z');
  const signals: NodeJS.Signals[] = [];
  const output: Buffer[] = [];
  const fakeSpawn = (() => {
    setImmediate(() => {
      (child.stdout as PassThrough).end('{"complete":true}\n');
      (child.stderr as PassThrough).end();
      (child.stdio[3] as PassThrough).end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as typeof spawn;

  try {
    const result = await superviseReadMode('list', 1_000, [], {
      platform: 'linux',
      spawnProcess: fakeSpawn,
      procRoot,
      signalProcessGroup: (_pid, signal) => signals.push(signal),
      cleanupBudgetMs: 500,
      progressIntervalMs: 10_000,
      writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    });

    assert.equal(result, 0);
    assert.deepEqual(signals, []);
    assert.equal(Buffer.concat(output).toString(), '{"complete":true}\n');
  } finally {
    rmSync(procRoot, { recursive: true, force: true });
  }
});

test('Linux cleanup waits for live descendants while ignoring zombie siblings', {
  skip: process.platform !== 'linux',
}, async () => {
  const processGroup = ownProcessGroupId();
  const child = fakeChild(processGroup);
  const procRoot = createTempRoot();
  writeProcStat(procRoot, 45687, processGroup, 'S');
  writeProcStat(procRoot, 45688, processGroup, 'Z');
  const signals: NodeJS.Signals[] = [];
  const output: Buffer[] = [];
  const errors: string[] = [];
  const fakeSpawn = (() => {
    setImmediate(() => {
      (child.stdout as PassThrough).end('{"complete":true}\n');
      (child.stderr as PassThrough).end();
      (child.stdio[3] as PassThrough).end();
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as typeof spawn;

  try {
    const result = await superviseReadMode('list', 1_000, [], {
      platform: 'linux',
      spawnProcess: fakeSpawn,
      procRoot,
      signalProcessGroup: (_pid, signal) => {
        signals.push(signal);
        writeProcStat(procRoot, 45687, processGroup, 'Z');
      },
      cleanupBudgetMs: 500,
      progressIntervalMs: 10_000,
      writeStdout: (chunk) => output.push(Buffer.from(chunk)),
      writeStderr: (text) => errors.push(text),
    });

    assert.equal(result, 0);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(Buffer.concat(output).toString(), '{"complete":true}\n');
    assert.match(errors.join(''), /stopped remaining owned descendants/);
    assert.doesNotMatch(errors.join(''), /cleanup failed/);
  } finally {
    rmSync(procRoot, { recursive: true, force: true });
  }
});

test('one deadline covers successive gh reads and suppresses partial JSON', {
  skip: process.platform === 'win32',
}, () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    {
      stdio: 'ignore',
    },
  );
  try {
    for (const [index, [entry, modeArgs]] of [
      [SCRIPT_PATH, []] as const,
      [BIN_PATH, ['--parked-issues']] as const,
    ].entries()) {
      const logPath = join(root, `gh-${index}.jsonl`);
      const heartbeatPath = join(root, `descendant-${index}.heartbeat`);
      const result = spawnSync(
        process.execPath,
        [
          entry,
          ...modeArgs,
          '--owner',
          'example',
          '--repo',
          'sample',
          '--budget-ms',
          '1500',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: ghEnv(logPath, {
            delayMs: 300,
            commentsDelayMs: 4_000,
            openPullRequests:
              '[{"number":9001,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]',
            envelope: true,
            descendantHeartbeatPath: heartbeatPath,
          }),
          timeout: 7_000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /read budget expired/);
      assert.match(
        result.stderr,
        /stage=park-marker-and-issue-comment-reads|at stage park-marker-and-issue-comment-reads/,
      );
      assert.equal((result.stderr.match(/"iddHelperError"/g) ?? []).length, 1);
      const calls = readCalls(logPath);
      assert.ok(calls.some((call) => call.route.includes('/pulls?state=open')));
      assert.ok(calls.some((call) => call.route.includes('/comments')));
      assert.equal(existsSync(heartbeatPath), true);
      const heartbeatSize = statSync(heartbeatPath).size;
      assert.ok(heartbeatSize > 0);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      assert.equal(statSync(heartbeatPath).size, heartbeatSize);
      const unrelatedPid = unrelated.pid;
      assert.ok(unrelatedPid !== undefined);
      assert.doesNotThrow(() => process.kill(unrelatedPid, 0));
    }
  } finally {
    unrelated.kill('SIGTERM');
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the read deadline includes repository and auth resolution', {
  skip: process.platform === 'win32',
}, () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'repo-view.jsonl');
  try {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, '--budget-ms', '3000'],
      {
        cwd: root,
        encoding: 'utf8',
        env: ghEnv(logPath, { delayMs: 8_000, envelope: true }),
        timeout: 12_000,
      },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /at stage repository\/auth-resolution/);
    assert.equal((result.stderr.match(/"iddHelperError"/g) ?? []).length, 1);
    const calls = readCalls(logPath);
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.route ?? '', /^repo view /);
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the read deadline includes provider-health service reads', {
  skip: process.platform === 'win32',
}, () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const logPath = join(root, 'provider-health.jsonl');
  const markerBody = renderProviderOutageParkComment({
    actor: 'test-agent',
    issueNumber: 555,
    service: 'advisory-review',
    headSha: 'a'.repeat(40),
    claimId: 'claim-1',
    parkedAt: '2026-10-22T00:00:00Z',
    blockers: ['advisory-wait'],
  });
  try {
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        '--owner',
        'example',
        '--repo',
        'sample',
        '--budget-ms',
        '4000',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...ghEnv(logPath, {
            openPullRequests:
              '[{"number":9001,"head":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]',
            comments: JSON.stringify([
              {
                body: markerBody,
                created_at: '2026-10-22T00:00:05Z',
                user: { login: 'kurone-kito' },
              },
            ]),
            healthDelayMs: 10_000,
            envelope: true,
          }),
          IDD_TRUSTED_MARKER_ACTORS: 'kurone-kito',
        },
        timeout: 15_000,
      },
    );
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /at stage provider-health-reads/);
    assert.equal((result.stderr.match(/"iddHelperError"/g) ?? []).length, 1);
    assert.ok(
      readCalls(logPath).some((call) =>
        call.route.includes('/pulls?state=all'),
      ),
    );
  } finally {
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('SIGINT and SIGTERM sent to the packaged bin stop its owned process tree', {
  skip: process.platform === 'win32',
}, async () => {
  const restoreGh = stubExecutable('gh', GH_SCRIPT);
  const root = createTempRoot();
  const descendantPids: number[] = [];
  try {
    for (const [signal, expectedCode] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const logPath = join(root, `${signal}.jsonl`);
      const heartbeatPath = join(root, `${signal}.heartbeat`);
      const child = spawn(
        process.execPath,
        [BIN_PATH, '--budget-ms', '10000'],
        {
          cwd: root,
          env: ghEnv(logPath, {
            delayMs: 5_000,
            envelope: true,
            descendantHeartbeatPath: heartbeatPath,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout
        ?.setEncoding('utf8')
        .on('data', (chunk) => (stdout += chunk));
      child.stderr
        ?.setEncoding('utf8')
        .on('data', (chunk) => (stderr += chunk));
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => {
        child.once('close', (code, childSignal) =>
          resolve({ code, signal: childSignal }),
        );
      });
      const start = performance.now();
      while (
        (readCalls(logPath).length === 0 ||
          !existsSync(`${heartbeatPath}.pid`) ||
          !existsSync(heartbeatPath)) &&
        performance.now() - start < 3_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        readCalls(logPath).length,
        1,
        `${signal} test did not reach gh`,
      );
      assert.equal(existsSync(heartbeatPath), true);
      const descendantPid = Number(
        readFileSync(`${heartbeatPath}.pid`, 'utf8'),
      );
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      descendantPids.push(descendantPid);
      const heartbeatSize = statSync(heartbeatPath).size;
      assert.ok(heartbeatSize > 0);
      child.kill(signal);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        child.kill(signal),
        true,
        `${signal} supervisor exited early (code=${child.exitCode}, signal=${child.signalCode})\n${stderr}`,
      );
      const result = await withTimeout(
        closed,
        7_000,
        `${signal} cleanup timed out`,
      );
      assert.equal(result.signal, null);
      assert.equal(result.code, expectedCode, stderr);
      assert.equal(stdout, '');
      assert.match(stderr, new RegExp(`read interrupted by ${signal}`));
      assert.equal((stderr.match(/"iddHelperError"/g) ?? []).length, 1);
      const stoppedHeartbeatSize = statSync(heartbeatPath).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(statSync(heartbeatPath).size, stoppedHeartbeatSize);
    }
  } finally {
    for (const pid of descendantPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The process tree may already have been reaped successfully.
      }
    }
    restoreGh();
    rmSync(root, { recursive: true, force: true });
  }
});

test('monotonic final-boundary expiry discards a worker success', async () => {
  const child = fakeChild(45678);
  let clock = 0;
  let wallClock = 10_000;
  const originalDateNow = Date.now;
  Date.now = () => wallClock;
  const output: Buffer[] = [];
  const errors: string[] = [];
  const fakeSpawn = (() => {
    setImmediate(() => {
      (child.stdout as PassThrough).end('{"shouldNotEscape":true}\n');
      (child.stderr as PassThrough).end();
      (child.stdio[3] as PassThrough).end();
      clock = 100;
      wallClock = 0;
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as typeof spawn;
  try {
    const result = await superviseReadMode('list', 100, [], {
      now: () => clock,
      platform: 'linux',
      spawnProcess: fakeSpawn,
      progressIntervalMs: 10_000,
      signalProcessGroup: () => {},
      processGroupExists: () => false,
      writeStdout: (chunk) => output.push(Buffer.from(chunk)),
      writeStderr: (text) => errors.push(text),
    });
    assert.equal(typeof result, 'object');
    if (typeof result === 'object') assert.equal(result.exitCode, 1);
    assert.equal(Buffer.concat(output).length, 0);
    assert.match(errors.join(''), /read budget expired/);
    assert.equal(wallClock, 0);
  } finally {
    Date.now = originalDateNow;
  }
});

test('Windows cleanup uses taskkill tree mode and escalates to force', async () => {
  for (const [exitCodes, expectedCalls] of [
    [[0], [['taskkill', '/PID', '45679', '/T']]],
    [
      [1, 0],
      [
        ['taskkill', '/PID', '45679', '/T'],
        ['taskkill', '/PID', '45679', '/T', '/F'],
      ],
    ],
  ] as const) {
    const child = fakeChild(45679);
    const calls: string[][] = [];
    const success = await terminateOwnedProcessTree(
      child,
      Promise.resolve({ code: null, signal: 'SIGTERM', error: null }),
      {
        now: () => performance.now(),
        platform: 'win32',
        spawnProcess: fakeTaskkillSpawn([...exitCodes], calls),
        cleanupBudgetMs: 1_000,
        signalProcessGroup: () => {},
        processGroupExists: () => false,
      },
    );
    assert.equal(success, true);
    assert.deepEqual(calls, expectedCalls);
  }
});

test('Windows success reaps the owned tree before publishing worker output', async () => {
  const worker = fakeChild(45683);
  const calls: string[][] = [];
  const workerEnvironment: { value?: NodeJS.ProcessEnv } = {};
  const fakeSpawn = fakeWindowsSupervisorSpawn(
    worker,
    [0],
    () => {},
    calls,
    workerEnvironment,
  );
  const output: Buffer[] = [];
  const errors: string[] = [];

  const result = await superviseReadMode('list', 1_000, [], {
    platform: 'win32',
    spawnProcess: fakeSpawn,
    cleanupBudgetMs: 500,
    progressIntervalMs: 10_000,
    writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    writeStderr: (text) => errors.push(text),
  });

  assert.equal(result, 0);
  assert.equal(
    workerEnvironment.value
      ?.IDD_PROVIDER_OUTAGE_PARK_READ_HOLD_FOR_TREE_CLEANUP,
    '1',
  );
  assert.match(
    workerEnvironment.value?.IDD_PROVIDER_OUTAGE_PARK_READ_WORKER_TOKEN ?? '',
    /^[0-9a-f]{64}$/,
  );
  assert.deepEqual(calls, [['taskkill', '/PID', '45683', '/T']]);
  assert.equal(Buffer.concat(output).toString(), '{"complete":true}\n');
});

test('Windows cleanup that crosses the read deadline cannot publish success', async () => {
  const worker = fakeChild(45684);
  const calls: string[][] = [];
  const workerEnvironment: { value?: NodeJS.ProcessEnv } = {};
  let clock = 0;
  const fakeSpawn = fakeWindowsSupervisorSpawn(
    worker,
    [0],
    () => {
      clock = 100;
    },
    calls,
    workerEnvironment,
  );
  const output: Buffer[] = [];
  const errors: string[] = [];

  const result = await superviseReadMode('list', 100, [], {
    now: () => clock,
    platform: 'win32',
    spawnProcess: fakeSpawn,
    cleanupBudgetMs: 500,
    progressIntervalMs: 10_000,
    writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    writeStderr: (text) => errors.push(text),
  });

  assert.equal(typeof result, 'object');
  if (typeof result === 'object') assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [['taskkill', '/PID', '45684', '/T']]);
  assert.equal(Buffer.concat(output).length, 0);
  assert.match(errors.join(''), /read budget expired after 100ms/);
  assert.match(errors.join(''), /owned process tree stopped and reaped/);
});

test('Windows tree-cleanup failure cannot publish worker output', async () => {
  const worker = fakeChild(45685);
  const calls: string[][] = [];
  const workerEnvironment: { value?: NodeJS.ProcessEnv } = {};
  const fakeSpawn = fakeWindowsSupervisorSpawn(
    worker,
    [1, 1],
    () => {},
    calls,
    workerEnvironment,
  );
  const output: Buffer[] = [];
  const errors: string[] = [];

  const result = await superviseReadMode('list', 1_000, [], {
    platform: 'win32',
    spawnProcess: fakeSpawn,
    cleanupBudgetMs: 200,
    progressIntervalMs: 10_000,
    writeStdout: (chunk) => output.push(Buffer.from(chunk)),
    writeStderr: (text) => errors.push(text),
  });

  assert.equal(typeof result, 'object');
  if (typeof result === 'object') assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, [
    ['taskkill', '/PID', '45685', '/T'],
    ['taskkill', '/PID', '45685', '/T', '/F'],
  ]);
  assert.equal(Buffer.concat(output).length, 0);
  assert.match(errors.join(''), /cleanup failed within 200ms/);
});

test('Windows cleanup reports failure when taskkill cannot stop the owned tree', async () => {
  const child = fakeChild(45681);
  const calls: string[][] = [];
  const startedAt = performance.now();
  const success = await terminateOwnedProcessTree(
    child,
    new Promise<ChildCloseResult>(() => {}),
    {
      now: () => performance.now(),
      platform: 'win32',
      spawnProcess: fakeTaskkillSpawn([1, 1], calls),
      cleanupBudgetMs: 200,
      signalProcessGroup: () => {},
      processGroupExists: () => false,
    },
  );
  assert.equal(success, false);
  assert.deepEqual(calls, [
    ['taskkill', '/PID', '45681', '/T'],
    ['taskkill', '/PID', '45681', '/T', '/F'],
  ]);
  assert.ok(performance.now() - startedAt < 1_000);
});

test('POSIX cleanup reports an owned process group that will not exit', async () => {
  const child = fakeChild(45680);
  const success = await terminateOwnedProcessTree(
    child,
    Promise.resolve({
      code: null,
      signal: null,
      error: null,
    } satisfies ChildCloseResult),
    {
      now: () => performance.now(),
      platform: 'linux',
      spawnProcess: spawn,
      cleanupBudgetMs: 5,
      signalProcessGroup: () => {},
      processGroupExists: () => true,
    },
  );
  assert.equal(success, false);
});
