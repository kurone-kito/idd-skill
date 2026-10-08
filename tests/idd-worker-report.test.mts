import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultLoadControlDirectory } from '../src/scripts/github-api-load-control.mts';
import {
  appendWorkerReport,
  hasDuplicate,
  observeLock,
  resolveStateBase,
  resolveWorkerReportStore,
  summarizeWorkerReports,
  takeOverLock,
  validateWorkerReport,
  type WorkerReport,
} from '../src/scripts/idd-worker-report.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-worker-report.mjs');

interface Sandbox {
  root: string;
  state: string;
  home: string;
  store: string;
  storeDirectory: string;
}

/**
 * A throwaway per-user state root that is removed afterwards. Every spawn
 * overrides all four variables a state root can come from, so nothing can
 * fall back to the real home directory, and the `tests/isolate-state.mts`
 * leak scan (which only watches its own throwaway root) never sees a file.
 */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'idd-worker-report-'));
  const state = join(root, 'state');
  const home = join(root, 'home');
  mkdirSync(home);
  const storeDirectory = join(state, 'idd-skill', 'worker-reports');
  return {
    root,
    state,
    home,
    store: join(storeDirectory, 'reports.jsonl'),
    storeDirectory,
  };
}

function cleanup(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true });
}

function sandboxEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_STATE_HOME: sandbox.state,
    LOCALAPPDATA: sandbox.state,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
  };
}

function runCli(
  sandbox: Sandbox,
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: sandboxEnv(sandbox),
    input,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Start the CLI without waiting, feeding `input` on stdin. */
function startCli(
  sandbox: Sandbox,
  args: string[],
  input: string,
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: sandboxEnv(sandbox),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    // A child that exits before reading stdin must fail the assertions, not
    // crash the runner with an unhandled EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function report(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return {
    schemaVersion: 1,
    issue: 'kurone-kito/idd-skill#3836',
    pullRequest: 'kurone-kito/idd-skill#3850',
    claimId: 'e6afe472-bb40-4395-9019-7723167c6d57',
    harness: 'claude-code',
    workerHandle: 'agent-a1b2c3',
    terminalPhase: 'F4',
    outcome: 'merged',
    verifiedAt: '2026-10-08T12:40:00Z',
    recordedAt: '2026-10-08T12:41:30Z',
    ...overrides,
  };
}

function storeLines(sandbox: Sandbox): string[] {
  return readFileSync(sandbox.store, 'utf8')
    .split('\n')
    .filter((line) => line !== '');
}

test('a valid record is appended once as one JSON line', () => {
  const sandbox = makeSandbox();
  try {
    const record = report();
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(record),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: 'appended',
      store: sandbox.store,
    });
    assert.deepEqual(
      storeLines(sandbox).map((line) => JSON.parse(line)),
      [record],
    );
    if (process.platform !== 'win32') {
      assert.equal(statSync(sandbox.store).mode & 0o777, 0o600);
      assert.equal(statSync(sandbox.storeDirectory).mode & 0o777, 0o700);
    }
    assert.equal(
      existsSync(`${sandbox.store}.lock`),
      false,
      'the lock file must be released',
    );
  } finally {
    cleanup(sandbox);
  }
});

test('append reads the record from --file', () => {
  const sandbox = makeSandbox();
  try {
    const file = join(sandbox.root, 'record.json');
    writeFileSync(file, JSON.stringify(report()));
    const result = runCli(sandbox, ['append', '--file', file]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(storeLines(sandbox).length, 1);
  } finally {
    cleanup(sandbox);
  }
});

test('an invalid record is rejected and nothing is written', () => {
  const sandbox = makeSandbox();
  try {
    const invalid = { ...report(), outcome: 'done', branch: 'x' };
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(invalid),
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /record fails schema validation/);
    assert.match(result.stderr, /"done" not in enum/);
    assert.equal(
      existsSync(join(sandbox.state, 'idd-skill')),
      false,
      'a rejected record must not even create the directory',
    );
  } finally {
    cleanup(sandbox);
  }
});

test('input that is not JSON is a usage error and writes nothing', () => {
  const sandbox = makeSandbox();
  try {
    const result = runCli(sandbox, ['append', '--stdin'], 'not json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid JSON/);
    assert.equal(existsSync(join(sandbox.state, 'idd-skill')), false);
  } finally {
    cleanup(sandbox);
  }
});

test('the same claimId, workerHandle and terminalPhase is a duplicate; a different workerHandle is appended', () => {
  const sandbox = makeSandbox();
  try {
    const first = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report()),
    );
    assert.equal(first.status, 0, first.stderr);
    // A retried append, even stamped with a later recordedAt, is a duplicate.
    const retried = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ recordedAt: '2026-10-08T13:00:00Z' })),
    );
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(JSON.parse(retried.stdout).status, 'duplicate');
    assert.equal(storeLines(sandbox).length, 1);
    // A replacement worker on the same claim gets its own record.
    const replacement = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ workerHandle: 'agent-replacement' })),
    );
    assert.equal(JSON.parse(replacement.stdout).status, 'appended');
    // A different terminal phase is a different record too.
    const otherPhase = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ terminalPhase: 'F2.5', outcome: 'handed-off' })),
    );
    assert.equal(JSON.parse(otherPhase.stdout).status, 'appended');
    assert.equal(storeLines(sandbox).length, 3);
  } finally {
    cleanup(sandbox);
  }
});

test('a relative XDG_STATE_HOME or LOCALAPPDATA is ignored', () => {
  assert.equal(
    resolveStateBase({ XDG_STATE_HOME: 'relative/state' }, 'linux', '/home/u'),
    '/home/u/.local/state',
  );
  assert.equal(
    resolveStateBase({ XDG_STATE_HOME: '  ' }, 'linux', '/home/u'),
    '/home/u/.local/state',
  );
  assert.equal(
    resolveStateBase({ XDG_STATE_HOME: '/var/state' }, 'linux', '/home/u'),
    '/var/state',
  );
  assert.equal(
    resolveStateBase({ LOCALAPPDATA: 'Local' }, 'win32', 'C:\\Users\\u'),
    'C:\\Users\\u\\AppData\\Local',
  );
  assert.equal(
    resolveStateBase(
      { LOCALAPPDATA: 'D:\\Data\\Local' },
      'win32',
      'C:\\Users\\u',
    ),
    'D:\\Data\\Local',
  );
  assert.equal(
    resolveWorkerReportStore({ XDG_STATE_HOME: '/var/state' }, 'linux', '/h'),
    '/var/state/idd-skill/worker-reports/reports.jsonl',
  );
  assert.equal(
    resolveWorkerReportStore(
      { LOCALAPPDATA: 'D:\\Data\\Local' },
      'win32',
      'C:\\Users\\u',
    ),
    'D:\\Data\\Local\\idd-skill\\worker-reports\\reports.jsonl',
  );
});

test('the state base matches the base github-api-load-control uses', () => {
  const cases: [NodeJS.ProcessEnv, NodeJS.Platform][] = [
    [{ XDG_STATE_HOME: '/var/state' }, 'linux'],
    [{ XDG_STATE_HOME: 'relative' }, 'linux'],
    [{}, 'linux'],
    [{ LOCALAPPDATA: 'D:\\Data\\Local' }, 'win32'],
  ];
  for (const [env, platform] of cases) {
    const loadControl = defaultLoadControlDirectory(env, platform);
    // <base>/idd-skill/github-api-load-control
    assert.equal(
      dirname(dirname(loadControl)),
      resolveStateBase(env, platform, homedir()),
      `${platform} ${JSON.stringify(env)}`,
    );
  }
});

test('two concurrent appends produce two whole lines', async () => {
  const sandbox = makeSandbox();
  try {
    const handles = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
    const results = await Promise.all(
      handles.map(
        (workerHandle) =>
          new Promise<{ status: number | null; stderr: string }>((resolve) => {
            const child = spawn(
              process.execPath,
              [CLI_PATH, 'append', '--stdin'],
              { env: sandboxEnv(sandbox), stdio: ['pipe', 'ignore', 'pipe'] },
            );
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += String(chunk);
            });
            child.on('close', (status) => resolve({ status, stderr }));
            child.stdin.end(JSON.stringify(report({ workerHandle })));
          }),
      ),
    );
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }
    const parsed = storeLines(sandbox).map(
      (line) => JSON.parse(line) as WorkerReport,
    );
    assert.deepEqual(parsed.map((entry) => entry.workerHandle).sort(), handles);
    assert.equal(existsSync(`${sandbox.store}.lock`), false);
  } finally {
    cleanup(sandbox);
  }
});

test('concurrent appends of the same record yield exactly one line', async () => {
  const sandbox = makeSandbox();
  try {
    const input = JSON.stringify(report());
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        startCli(sandbox, ['append', '--stdin'], input),
      ),
    );
    for (const result of results) {
      assert.equal(result.status, 0, result.stderr);
    }
    const statuses = results
      .map((result) => JSON.parse(result.stdout).status as string)
      .sort();
    assert.deepEqual(statuses, [
      'appended',
      ...Array.from({ length: 7 }, () => 'duplicate'),
    ]);
    assert.equal(storeLines(sandbox).length, 1);
  } finally {
    cleanup(sandbox);
  }
});

test('an append waits for a fresh lock and completes once it is released', async () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    const lock = `${sandbox.store}.lock`;
    writeFileSync(lock, '{"pid":1,"token":"live","createdAt":"now"}');
    const pending = startCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report()),
    );
    const early = await Promise.race([
      pending.then(() => 'finished'),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve('waiting'), 600),
      ),
    ]);
    assert.equal(
      early,
      'waiting',
      'the append must not finish without the lock',
    );
    assert.equal(existsSync(sandbox.store), false, 'must wait for the lock');
    rmSync(lock);
    const result = await pending;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'appended');
    assert.equal(storeLines(sandbox).length, 1);
  } finally {
    cleanup(sandbox);
  }
});

test('a stale lock file is taken over', () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    const lock = `${sandbox.store}.lock`;
    writeFileSync(lock, '{"pid":1,"token":"dead","createdAt":"2000-01-01"}');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report()),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(storeLines(sandbox).length, 1);
    assert.equal(existsSync(lock), false, 'the taken-over lock is released');
    assert.deepEqual(
      readdirSync(sandbox.storeDirectory).sort(),
      ['reports.jsonl'],
      'no graveyard file is left behind',
    );
  } finally {
    cleanup(sandbox);
  }
});

test('a fresh lock held by someone else times out and nothing is written', () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    const lock = `${sandbox.store}.lock`;
    writeFileSync(lock, '{"pid":1,"token":"live","createdAt":"now"}');
    assert.throws(
      () =>
        appendWorkerReport(sandbox.store, report(), {
          timeoutMs: 150,
          retryMs: 10,
        }),
      /could not acquire the lock/,
    );
    assert.equal(existsSync(sandbox.store), false);
    assert.equal(
      readFileSync(lock, 'utf8'),
      '{"pid":1,"token":"live","createdAt":"now"}',
      "another holder's lock is left alone",
    );
  } finally {
    cleanup(sandbox);
  }
});

test('a partial last line is not glued onto the next record', () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    writeFileSync(
      sandbox.store,
      `${JSON.stringify(report())}\n{"schemaVersion":1,"is`,
    );
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ workerHandle: 'agent-next' })),
    );
    assert.equal(result.status, 0, result.stderr);
    const lines = storeLines(sandbox);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[2]).workerHandle, 'agent-next');
    const summary = summarizeWorkerReports(sandbox.store);
    assert.equal(summary.total, 2);
    assert.equal(summary.invalidLines, 1);
  } finally {
    cleanup(sandbox);
  }
});

test('summary on an empty store reports zero and creates nothing', () => {
  const sandbox = makeSandbox();
  try {
    const result = runCli(sandbox, ['summary']);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.store, sandbox.store);
    assert.equal(summary.total, 0);
    assert.equal(summary.invalidLines, 0);
    assert.deepEqual(summary.outcomes, {
      merged: 0,
      'handed-off': 0,
      held: 0,
      abandoned: 0,
      failed: 0,
    });
    assert.deepEqual(summary.reviewRounds, { recorded: 0, distribution: {} });
    assert.deepEqual(summary.frictionFiles, []);
    assert.equal(existsSync(join(sandbox.state, 'idd-skill')), false);
  } finally {
    cleanup(sandbox);
  }
});

test('summary on a store with three records counts outcomes, rounds and friction files', () => {
  const sandbox = makeSandbox();
  try {
    const friction = (file: string) => ({
      phase: 'B1',
      summary: 'Confusing wording.',
      file,
    });
    const records: WorkerReport[] = [
      report({
        workerHandle: 'a',
        reviewRounds: 2,
        frictions: [friction('docs/a.md'), friction('docs/b.md')],
        recordedAt: '2026-10-08T10:00:00Z',
      }),
      report({
        workerHandle: 'b',
        outcome: 'failed',
        reviewRounds: 2,
        frictions: [friction('docs/a.md'), { phase: 'C', summary: 'No file.' }],
        recordedAt: '2026-10-08T11:00:00Z',
      }),
      report({
        workerHandle: 'c',
        outcome: 'handed-off',
        reviewRounds: 5,
        recordedAt: '2026-10-08T12:00:00Z',
      }),
    ];
    for (const record of records) {
      const appended = runCli(
        sandbox,
        ['append', '--stdin'],
        JSON.stringify(record),
      );
      assert.equal(appended.status, 0, appended.stderr);
    }
    // A non-JSON line and a schema-invalid line are counted, not fatal.
    writeFileSync(
      sandbox.store,
      `${readFileSync(sandbox.store, 'utf8')}garbage\n{"schemaVersion":2}\n`,
    );
    const summary = JSON.parse(runCli(sandbox, ['summary']).stdout);
    assert.equal(summary.total, 3);
    assert.equal(summary.invalidLines, 2);
    assert.deepEqual(summary.outcomes, {
      merged: 1,
      'handed-off': 1,
      held: 0,
      abandoned: 0,
      failed: 1,
    });
    assert.deepEqual(summary.reviewRounds, {
      recorded: 3,
      distribution: { '2': 2, '5': 1 },
    });
    assert.deepEqual(summary.frictionFiles, [
      { file: 'docs/a.md', count: 2 },
      { file: 'docs/b.md', count: 1 },
    ]);
    // --since filters on recordedAt.
    const since = JSON.parse(
      runCli(sandbox, ['summary', '--since', '2026-10-08T11:00:00Z']).stdout,
    );
    assert.equal(since.total, 2);
    assert.equal(since.since, '2026-10-08T11:00:00Z');
    assert.equal(since.outcomes.merged, 0);
  } finally {
    cleanup(sandbox);
  }
});

test('usage errors exit non-zero and create nothing', () => {
  const sandbox = makeSandbox();
  try {
    const record = JSON.stringify(report());
    const cases: { args: string[]; input?: string; message: RegExp }[] = [
      { args: [], message: /a mode is required/ },
      { args: ['--nope'], message: /unknown argument: --nope/ },
      { args: ['--stdin'], message: /a mode is required before any flag/ },
      { args: ['bogus-mode'], message: /unknown mode "bogus-mode"/ },
      { args: ['append'], message: /exactly one of --file/ },
      {
        args: ['append', '--stdin', '--file', 'x.json'],
        input: record,
        message: /exactly one of --file/,
      },
      {
        args: ['append', '--stdin', '--since', '2026-10-08T00:00:00Z'],
        input: record,
        message: /--since applies to summary only/,
      },
      { args: ['summary', '--stdin'], message: /append only/ },
      { args: ['summary', '--since', 'yesterday'], message: /ISO 8601/ },
      {
        args: ['append', '--file', join(sandbox.root, 'missing.json')],
        message: /cannot read the record/,
      },
    ];
    for (const { args, input, message } of cases) {
      const result = runCli(sandbox, args, input);
      assert.notEqual(result.status, 0, `${args.join(' ')} should fail`);
      assert.match(result.stderr, message, args.join(' '));
    }
    assert.equal(existsSync(join(sandbox.state, 'idd-skill')), false);
    const help = runCli(sandbox, ['--help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /append --file <path>/);
    assert.equal(runCli(sandbox, ['append', '--help']).status, 0);
  } finally {
    cleanup(sandbox);
  }
});

test('validateWorkerReport accepts the valid fixture and rejects the invalid one', () => {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(REPO_ROOT, 'fixtures/schemas', name), 'utf8'));
  assert.deepEqual(validateWorkerReport(read('worker-report.valid.json')), []);
  const errors = validateWorkerReport(read('worker-report.invalid.json'));
  assert.ok(errors.some((error) => error.includes('claimId')));
  assert.ok(errors.some((error) => error.includes('"done" not in enum')));
  assert.ok(errors.some((error) => error.includes('"branch" not allowed')));
});

test('a relative state variable makes the CLI fall back to the home directory', () => {
  const sandbox = makeSandbox();
  try {
    const result = spawnSync(
      process.execPath,
      [CLI_PATH, 'append', '--stdin'],
      {
        encoding: 'utf8',
        input: JSON.stringify(report()),
        env: {
          ...sandboxEnv(sandbox),
          XDG_STATE_HOME: 'relative-state',
          LOCALAPPDATA: 'relative-state',
        },
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const base =
      process.platform === 'win32'
        ? join(sandbox.home, 'AppData', 'Local')
        : join(sandbox.home, '.local', 'state');
    const store = join(base, 'idd-skill', 'worker-reports', 'reports.jsonl');
    assert.equal(JSON.parse(result.stdout).store, store);
    assert.equal(existsSync(store), true);
    assert.equal(
      existsSync(join(REPO_ROOT, 'relative-state')),
      false,
      'a relative value must not create a directory in the working tree',
    );
  } finally {
    cleanup(sandbox);
  }
});

test('--since compares instants, so an offset timestamp is placed correctly', () => {
  const sandbox = makeSandbox();
  try {
    // 11:00 at +09:00 is 02:00 UTC.
    const record = report({ recordedAt: '2026-10-08T11:00:00+09:00' });
    assert.equal(
      runCli(sandbox, ['append', '--stdin'], JSON.stringify(record)).status,
      0,
    );
    const total = (since: string): number =>
      JSON.parse(runCli(sandbox, ['summary', '--since', since]).stdout).total;
    assert.equal(total('2026-10-08T02:00:00Z'), 1);
    assert.equal(total('2026-10-08T02:00:01Z'), 0);
    assert.equal(total('2026-10-08T11:00:00+09:00'), 1);
    // A date without a time or offset is not accepted.
    const dateOnly = runCli(sandbox, ['summary', '--since', '2026-10-08']);
    assert.notEqual(dateOnly.status, 0);
    assert.match(dateOnly.stderr, /ISO 8601/);
  } finally {
    cleanup(sandbox);
  }
});

test('a mode word after the flags gets a pointed error', () => {
  const sandbox = makeSandbox();
  try {
    const result = runCli(sandbox, ['--file', 'x.json', 'append']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /put the mode word first: append/);
    const help = runCli(sandbox, ['--help', 'summary']);
    assert.notEqual(help.status, 0);
    assert.match(help.stderr, /put the mode word first: summary/);
    // A different parse error is not rewritten.
    const bogus = runCli(sandbox, ['--bogus', 'summary']);
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /unknown argument: --bogus/);
    assert.doesNotMatch(bogus.stderr, /put the mode word first/);
  } finally {
    cleanup(sandbox);
  }
});

test('the schema accepts null where allowed and enforces the string bounds', () => {
  const ok = (overrides: Partial<WorkerReport>): boolean =>
    validateWorkerReport(report(overrides)).length === 0;
  assert.equal(ok({ pullRequest: null }), true);
  // Canonical machine-facing phase ids (schemas/phase-graph.json) use an
  // underscore, so a copied id must be accepted everywhere a phase appears.
  assert.equal(ok({ terminalPhase: 'F2_5' }), true);
  assert.equal(ok({ terminalPhase: 'F2.5' }), true);
  assert.equal(ok({ terminalPhase: '2_5' }), false);
  assert.equal(ok({ stalls: [{ phase: 'F2_5', summary: 'x' }] }), true);
  assert.equal(ok({ deviations: [{ phase: 'F2_5', summary: 'x' }] }), true);
  assert.equal(
    ok({ frictions: [{ phase: 'F2_5', summary: 'x', file: 'a.md' }] }),
    true,
  );
  assert.equal(ok({ vendorSessionId: null }), true);
  assert.equal(ok({ vendorSessionId: 'path/like' }), false);
  const bounds: [string, (n: number) => Partial<WorkerReport>, number][] = [
    ['claimId', (n) => ({ claimId: 'c'.repeat(n) }), 200],
    ['workerHandle', (n) => ({ workerHandle: 'w'.repeat(n) }), 200],
    ['terminalPhase', (n) => ({ terminalPhase: `F${'4'.repeat(n - 1)}` }), 32],
    ['vendorSessionId', (n) => ({ vendorSessionId: 's'.repeat(n) }), 200],
    [
      'stalls summary',
      (n) => ({ stalls: [{ phase: 'D', summary: 's'.repeat(n) }] }),
      500,
    ],
    [
      'frictions file',
      (n) => ({
        frictions: [{ phase: 'B1', summary: 'x', file: 'f'.repeat(n) }],
      }),
      300,
    ],
  ];
  for (const [name, build, limit] of bounds) {
    assert.equal(ok(build(limit)), true, `${name} at ${limit}`);
    assert.equal(ok(build(limit + 1)), false, `${name} at ${limit + 1}`);
  }
  assert.equal(ok({ issue: 'owner/repo#0' }), false);
  assert.equal(ok({ issue: 'owner/repo#12' }), true);
  assert.equal(ok({ reviewRounds: -1 }), false);
  assert.equal(ok({ reviewRounds: 0 }), true);
});

test('timestamps that name no real instant are rejected, not normalized', () => {
  const ok = (overrides: Partial<WorkerReport>): boolean =>
    validateWorkerReport(report(overrides)).length === 0;
  const real = [
    '2026-10-08T12:41:30Z',
    '2024-02-29T00:00:00Z',
    '2026-12-31T23:59:59.123456789Z',
    '2026-10-08T12:00:00+23:59',
    '2026-10-08T12:00:00-08:00',
  ];
  const impossible = [
    '2026-02-30T00:00:00Z',
    '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-00T00:00:00Z',
    '2026-10-08T24:00:00Z',
    '2026-10-08T23:60:00Z',
    '2026-10-08T23:59:60Z',
    '2026-10-08T12:00:00+24:00',
    '2026-10-08T12:00:00+00:60',
    '2026-10-08',
    '2026-10-08T12:00:00',
  ];
  for (const field of ['verifiedAt', 'recordedAt'] as const) {
    for (const value of real) {
      assert.equal(ok({ [field]: value }), true, `${field} ${value}`);
    }
    for (const value of impossible) {
      assert.equal(ok({ [field]: value }), false, `${field} ${value}`);
    }
  }
  const errors = validateWorkerReport(
    report({ recordedAt: '2026-02-30T00:00:00Z' }),
  );
  assert.deepEqual(errors, [
    '$.recordedAt: "2026-02-30T00:00:00Z" is not a real calendar date-time',
  ]);
});

test('append rejects an impossible date and summary --since rejects one too', () => {
  const sandbox = makeSandbox();
  try {
    const bad = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ verifiedAt: '2026-02-30T00:00:00Z' })),
    );
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /not a real calendar date-time/);
    assert.equal(existsSync(join(sandbox.state, 'idd-skill')), false);
    const since = runCli(sandbox, [
      'summary',
      '--since',
      '2026-02-30T00:00:00Z',
    ]);
    assert.notEqual(since.status, 0);
    assert.match(since.stderr, /real ISO 8601 date-time/);
  } finally {
    cleanup(sandbox);
  }
});

test('an existing store with group or world access is tightened before the append', {
  skip: process.platform === 'win32',
}, () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true, mode: 0o755 });
    chmodSync(sandbox.storeDirectory, 0o755);
    writeFileSync(sandbox.store, '', { mode: 0o644 });
    chmodSync(sandbox.store, 0o644);
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report()),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(sandbox.storeDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(sandbox.store).mode & 0o777, 0o600);
    // A second append leaves already-private modes alone.
    const again = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report({ workerHandle: 'agent-two' })),
    );
    assert.equal(again.status, 0, again.stderr);
    assert.equal(statSync(sandbox.store).mode & 0o777, 0o600);
    // summary never changes a mode.
    chmodSync(sandbox.store, 0o640);
    assert.equal(runCli(sandbox, ['summary']).status, 0);
    assert.equal(statSync(sandbox.store).mode & 0o777, 0o640);
  } finally {
    cleanup(sandbox);
  }
});

test('stale takeover moves only the lock it judged stale', () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    const lock = `${sandbox.store}.lock`;
    const leftovers = (): string[] =>
      readdirSync(sandbox.storeDirectory).filter(
        (name) => name !== 'reports.jsonl.lock',
      );
    const age = (seconds: number): void => {
      const when = new Date(Date.now() - seconds * 1000);
      utimesSync(lock, when, when);
    };

    // The lock is the one that was inspected: it is removed.
    writeFileSync(lock, '{"pid":1,"token":"stale"}');
    age(60);
    const stale = observeLock(lock, 5_000);
    assert.equal(stale?.stale, true);
    assert.equal(takeOverLock(lock, stale?.identity ?? ''), true);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(leftovers(), []);

    // A fresh lock replaced it before the rename: it is put back untouched.
    writeFileSync(lock, '{"pid":1,"token":"stale"}');
    age(60);
    const judged = observeLock(lock, 5_000);
    unlinkSync(lock);
    const fresh = '{"pid":2,"token":"fresh"}';
    writeFileSync(lock, fresh);
    assert.equal(observeLock(lock, 5_000)?.stale, false);
    assert.equal(takeOverLock(lock, judged?.identity ?? ''), false);
    assert.equal(readFileSync(lock, 'utf8'), fresh);
    assert.deepEqual(leftovers(), []);
    unlinkSync(lock);

    // An empty body (a holder that died before writing) has no token to tell
    // it apart, yet a fresh empty lock still differs by its modification time.
    writeFileSync(lock, '');
    age(60);
    const emptyStale = observeLock(lock, 5_000);
    unlinkSync(lock);
    writeFileSync(lock, '');
    assert.equal(takeOverLock(lock, emptyStale?.identity ?? ''), false);
    assert.equal(existsSync(lock), true, 'the fresh empty lock is restored');
    age(60);
    assert.equal(
      takeOverLock(lock, observeLock(lock, 5_000)?.identity ?? ''),
      true,
    );
    assert.equal(existsSync(lock), false);

    // Already gone (another waiter took it over): nothing left in the way.
    assert.equal(observeLock(lock, 5_000), undefined);
    assert.equal(takeOverLock(lock, 'anything'), true);
    assert.deepEqual(leftovers(), []);
  } finally {
    cleanup(sandbox);
  }
});

test('a stale lock with an empty body is taken over by an append', () => {
  const sandbox = makeSandbox();
  try {
    mkdirSync(sandbox.storeDirectory, { recursive: true });
    const lock = `${sandbox.store}.lock`;
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const result = runCli(
      sandbox,
      ['append', '--stdin'],
      JSON.stringify(report()),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(storeLines(sandbox).length, 1);
    assert.equal(existsSync(lock), false);
    assert.deepEqual(
      readdirSync(sandbox.storeDirectory).sort(),
      ['reports.jsonl'],
      'no graveyard file is left behind',
    );
  } finally {
    cleanup(sandbox);
  }
});

test('the duplicate scan renews the lock lease while it works', () => {
  const key = JSON.stringify(['claim', 'worker', 'F4']);
  const line = (workerHandle: string): string =>
    JSON.stringify({ claimId: 'claim', workerHandle, terminalPhase: 'F4' });
  const content = [
    line('a'),
    'not json',
    '',
    line('b'),
    'null',
    line('c'),
  ].join('\n');
  // A fake clock that advances 600 ms per reading makes the 1 s interval
  // elapse a few times during the scan.
  let clock = 0;
  const tick = (): number => {
    clock += 600;
    return clock;
  };
  let refreshes = 0;
  assert.equal(
    hasDuplicate(content, key, () => (refreshes += 1), tick, 1_000),
    false,
  );
  // 600 ms per reading, a 1 s interval, six lines: renewed on the 2nd, 4th,
  // and 6th line.
  assert.equal(refreshes, 3);

  // A match is found past bad, empty, and non-object lines.
  const withMatch = `${content}\n${line('worker')}\n${line('after')}`;
  refreshes = 0;
  assert.equal(
    hasDuplicate(
      withMatch,
      key,
      () => (refreshes += 1),
      () => 0,
    ),
    true,
  );
  assert.equal(
    refreshes,
    0,
    'a scan that takes no time does not need to renew',
  );
});
