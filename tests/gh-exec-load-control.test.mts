import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ghApiJson,
  ghApiJsonWithHeaders,
  ghGraphql,
  ghText,
  ghTextAsync,
  ghTextUnbounded,
  setGithubApiLoadControlForTests,
  withBoundedRetry,
  wrapGhCompatibilityError,
} from '../src/scripts/gh-exec.mts';
import {
  type GithubApiLoadControlRuntimePolicy,
  type LoadControlIdentity,
  type LoadControlRuntime,
  loadControlScopeName,
} from '../src/scripts/github-api-load-control.mts';
import { setGithubApiTelemetryPolicyForTests } from '../src/scripts/github-api-observation.mts';
import {
  findLoadControlRefusal,
  isNotDispatchedRefusal,
} from '../src/scripts/github-api-refusal.mts';
import { stubExecutable } from './test-utils.mts';

const IDENTITY: LoadControlIdentity = {
  host: 'github.com',
  credentialMaterial: 'credential-a',
};
const T0 = 1_800_000_000_000;

// A stub `gh` that records every argv, answers `gh auth token`, and behaves
// according to a mode file, so each scenario counts the processes it spawns.
const STUB = String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = process.env.IDD_STUB_LOG;
const modeFile = process.env.IDD_STUB_MODE;
fs.appendFileSync(log, JSON.stringify(args) + '\n');
if (args[0] === 'auth') {
  if (process.env.IDD_STUB_FAIL_AUTH) process.exit(1);
  const pause = Number(process.env.IDD_STUB_AUTH_DELAY_MS || 0);
  if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
  const at = args.indexOf('--hostname');
  process.stdout.write('token-for-' + (at >= 0 ? args[at + 1] : 'default') + '\n');
  process.exit(0);
}
const mode = fs.existsSync(modeFile) ? fs.readFileSync(modeFile, 'utf8').trim() : 'ok';
if (mode === 'secondary') {
  process.stderr.write('gh: You have exceeded a secondary rate limit. (HTTP 403)\n');
  process.stdout.write('HTTP/2.0 403 Forbidden\r\nRetry-After: 90\r\n\r\n{"message":"You have exceeded a secondary rate limit"}');
  process.exit(1);
}
if (mode === 'already-exceeded') {
  process.stderr.write('GraphQL: API rate limit already exceeded for user ID 12345.\n');
  process.exit(1);
}
if (mode === 'graphql-limited') {
  process.stdout.write('{"data":null,"errors":[{"type":"RATE_LIMITED","message":"slow down"}]}');
  process.exit(0);
}
if (mode === 'plain-failure') {
  process.stderr.write('gh: Server Error (HTTP 502)\n');
  process.exit(1);
}
const respond = () => {
  if (args.includes('graphql')) {
    process.stdout.write('{"data":{"viewer":{"login":"monalisa"}}}');
  } else if (args.includes('--include')) {
    process.stdout.write('HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 4999\r\n\r\n{"ok":true}');
  } else {
    process.stdout.write('{"ok":true}');
  }
};
if (mode === 'hold') {
  // Hold the request open until the test says so: no timing guesses.
  const release = process.env.IDD_STUB_RELEASE;
  fs.appendFileSync(log, JSON.stringify({ start: Date.now() }) + '\n');
  const began = Date.now();
  while (!fs.existsSync(release) && Date.now() - began < 60000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  respond();
} else if (mode.startsWith('slow')) {
  const delay = Number(mode.split(':')[1] || 250);
  fs.appendFileSync(log, JSON.stringify({ start: Date.now() }) + '\n');
  setTimeout(() => {
    fs.appendFileSync(log, JSON.stringify({ end: Date.now() }) + '\n');
    respond();
  }, delay);
} else {
  respond();
}
`;

interface Fixture {
  root: string;
  state: string;
  log: string;
  mode(value: string): void;
  calls(): string[][];
  clock: { wall: number; mono: number };
  runtime(extra?: LoadControlRuntime): LoadControlRuntime;
  enable(
    policy?: Partial<GithubApiLoadControlRuntimePolicy>,
    identity?: LoadControlIdentity | null,
    extra?: LoadControlRuntime,
  ): void;
  /** Enable load control but let the wrapper resolve the identity itself. */
  enableResolving(policy?: Partial<GithubApiLoadControlRuntimePolicy>): void;
  cleanup(): void;
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  setGithubApiLoadControlForTests(null);
  setGithubApiTelemetryPolicyForTests(null);
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'idd-gh-load-control-'));
  const state = join(root, 'state');
  const log = join(root, 'calls.log');
  const modeFile = join(root, 'mode');
  const restoreStub = stubExecutable('gh', STUB);
  const saved: Record<string, string | undefined> = {
    IDD_STUB_LOG: process.env.IDD_STUB_LOG,
    IDD_STUB_MODE: process.env.IDD_STUB_MODE,
    IDD_STUB_FAIL_AUTH: process.env.IDD_STUB_FAIL_AUTH,
    GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
  };
  process.env.IDD_STUB_LOG = log;
  process.env.IDD_STUB_MODE = modeFile;
  delete process.env.IDD_STUB_FAIL_AUTH;
  // Hermetic: never read the developer's own gh configuration.
  process.env.GH_CONFIG_DIR = join(root, 'gh-config');
  const clock = { wall: T0, mono: 0 };
  const self: Fixture = {
    root,
    state,
    log,
    clock,
    mode(value) {
      writeFileSync(modeFile, value);
    },
    calls() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter(Array.isArray) as string[][];
    },
    runtime(extra = {}) {
      return {
        directory: state,
        now: () => clock.wall,
        monotonic: () => clock.mono,
        uptimeMs: () => clock.mono + 5_000_000,
        sleepSync: (ms) => {
          clock.wall += ms;
          clock.mono += ms;
        },
        sleep: async (ms) => {
          clock.wall += ms;
          clock.mono += ms;
        },
        isPidAlive: () => true,
        processIdentity: () => ({}),
        pidNamespace: 'ns',
        ...extra,
      };
    },
    enable(policy = {}, identity = IDENTITY, extra = {}) {
      setGithubApiLoadControlForTests({
        policy: {
          enabled: true,
          maxConcurrent: 1,
          maxWaitMs: 5_000,
          ...policy,
        },
        identity,
        runtime: self.runtime(extra),
      });
    },
    enableResolving(policy = {}) {
      setGithubApiLoadControlForTests({
        policy: {
          enabled: true,
          maxConcurrent: 1,
          maxWaitMs: 5_000,
          ...policy,
        },
        runtime: self.runtime(),
      });
    },
    cleanup() {
      restoreStub();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
  cleanups.push(() => self.cleanup());
  return self;
}

function stateFiles(f: Fixture, sub: 'cooldown' | 'slots'): string[] {
  if (!existsSync(f.state)) return [];
  const scope = join(f.state, loadControlScopeName(IDENTITY));
  if (!existsSync(scope)) return [];
  return readdirSync(scope)
    .filter((name) => name === sub || name.startsWith(`${sub}-`))
    .flatMap((name) => readdirSync(join(scope, name)));
}

function refusalOf(action: () => unknown) {
  try {
    action();
  } catch (error) {
    const detail = findLoadControlRefusal(error);
    assert.ok(detail, `expected a refusal, got ${String(error)}`);
    return { error: error as Error & { ghCommand?: boolean }, detail };
  }
  assert.fail('expected the call to be refused');
}

// -- disabled default ------------------------------------------------------------

test('with load control off, argv, results, and files are unchanged', async () => {
  const f = fixture();
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = f.state;
  try {
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.deepEqual(ghApiJson('repos/o/r'), { ok: true });
    assert.deepEqual(ghApiJson('repos/o/r', { paginate: true }), [
      { ok: true },
    ]);
    assert.deepEqual(ghGraphql('query { viewer { login } }', {}), {
      data: { viewer: { login: 'monalisa' } },
    });
    assert.equal(await ghTextAsync(['api', 'user']), '{"ok":true}');
    assert.equal(ghTextUnbounded(['api', 'user']), '{"ok":true}');
    const calls = f.calls();
    assert.deepEqual(calls[0], ['api', 'user']);
    assert.deepEqual(calls[1], ['api', 'repos/o/r']);
    assert.ok(
      calls.every((call) => !call.includes('--include')),
      'no --include when the policy is off',
    );
    assert.ok(
      calls.every((call) => call[0] !== 'auth'),
      'no identity lookup when the policy is off',
    );
    assert.equal(existsSync(f.state), false, 'no state directory is created');
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
  }
});

test('an explicit disabled policy is the same as no policy', () => {
  const f = fixture();
  f.enable({ enabled: false });
  assert.equal(ghText(['api', 'user']), '{"ok":true}');
  assert.equal(existsSync(f.state), false);
  assert.deepEqual(f.calls(), [['api', 'user']]);
});

test('an unverified identity runs uncoordinated and creates nothing', () => {
  const f = fixture();
  f.enable({}, null);
  f.mode('secondary');
  assert.throws(() => ghText(['api', 'user']));
  f.mode('ok');
  // The throttle above recorded nothing, so the next call is not refused.
  assert.equal(ghText(['api', 'user']), '{"ok":true}');
  assert.equal(existsSync(f.state), false);
  assert.equal(f.calls().length, 2);
});

// -- admission -----------------------------------------------------------------------

test('a coordinated call is admitted, asks for headers, and releases its lease', async () => {
  const f = fixture();
  f.enable();
  assert.deepEqual(ghApiJson('repos/o/r'), { ok: true });
  assert.ok(f.calls()[0].includes('--include'), 'headers are requested');
  assert.deepEqual(ghApiJson('repos/o/r', { paginate: true }), [{ ok: true }]);
  assert.ok(!f.calls()[1].includes('--include'));
  assert.equal(ghText(['api', 'user']), '{"ok":true}');
  assert.equal(await ghTextAsync(['api', 'user']), '{"ok":true}');
  assert.equal(ghTextUnbounded(['api', 'user']), '{"ok":true}');
  const leases = stateFiles(f, 'slots').map((name) =>
    readFileSync(
      join(
        f.state,
        loadControlScopeName(IDENTITY),
        readdirSync(join(f.state, loadControlScopeName(IDENTITY))).find(
          (entry) => entry.startsWith('slots-'),
        ) as string,
        name,
      ),
      'utf8',
    ),
  );
  assert.ok(leases.length >= 1);
  assert.ok(
    leases.every((text) => JSON.parse(text).released === true),
    'every lease was released',
  );
  assert.equal(f.calls().length, 5);
});

test('a paginated read runs through the capture worker behind the same gate', () => {
  const f = fixture();
  f.enable();
  assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), [
    { ok: true },
  ]);
  const [call] = f.calls();
  assert.ok(call.includes('--paginate'));
  assert.ok(!call.includes('--include'), 'pagination cannot observe headers');
  const leases = stateFiles(f, 'slots');
  assert.ok(leases.length >= 1);
  // A second paginated read is admitted too: the first released its lease.
  assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), [
    { ok: true },
  ]);
  assert.equal(f.calls().length, 2);
});

test('a throttled paginated read starts the shared cooldown, and the next one is refused without spawning', () => {
  const f = fixture();
  f.enable({ maxWaitMs: 1_000 });
  f.mode('secondary');
  assert.throws(
    () => ghApiJson('repos/o/r/issues', { paginate: true }),
    (error) => isNotDispatchedRefusal(error) === false,
  );
  assert.equal(stateFiles(f, 'cooldown').length, 1);
  const spawned = f.calls().length;
  f.mode('ok');
  const paginated = refusalOf(() =>
    ghApiJson('repos/o/r/issues', { paginate: true }),
  );
  assert.equal(paginated.detail.reason, 'cooldown');
  assert.equal(paginated.error.ghCommand, true);
  refusalOf(() => ghApiJson('repos/o/r'));
  assert.equal(f.calls().length, spawned, 'no refused read spawned gh');
});

test('a failed call still releases its lease and rethrows the original error', () => {
  const f = fixture();
  f.enable();
  f.mode('plain-failure');
  assert.throws(
    () => ghText(['api', 'user']),
    (error) => {
      assert.equal((error as { ghCommand?: boolean }).ghCommand, true);
      assert.equal(isNotDispatchedRefusal(error), false);
      return true;
    },
  );
  assert.deepEqual(stateFiles(f, 'cooldown'), [], 'a 502 is not a throttle');
  f.mode('ok');
  assert.equal(ghText(['api', 'user']), '{"ok":true}');
});

test('two concurrent async requests are admitted one at a time', async () => {
  const f = fixture();
  // Real clocks and timers: the second request must wait for the first.
  setGithubApiLoadControlForTests({
    policy: { enabled: true, maxConcurrent: 1, maxWaitMs: 10_000 },
    identity: IDENTITY,
    runtime: { directory: f.state, pidNamespace: 'ns' },
  });
  f.mode('slow');
  const results = await Promise.all([
    ghTextAsync(['api', 'user']),
    ghTextAsync(['api', 'user']),
  ]);
  assert.deepEqual(results, ['{"ok":true}', '{"ok":true}']);
  const events = readFileSync(f.log, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((entry) => !Array.isArray(entry)) as {
    start?: number;
    end?: number;
  }[];
  assert.equal(events.length, 4);
  const starts = events.filter((event) => event.start !== undefined);
  const ends = events.filter((event) => event.end !== undefined);
  assert.ok(
    (starts[1].start as number) >= (ends[0].end as number),
    'the second request started after the first finished',
  );
});

test('an async read that cannot be admitted before its deadline is refused without spawning gh', async () => {
  const f = fixture();
  setGithubApiLoadControlForTests({
    policy: { enabled: true, maxConcurrent: 1, maxWaitMs: 10_000 },
    identity: IDENTITY,
    runtime: { directory: f.state, pidNamespace: 'ns' },
  });
  f.mode('slow');
  const running = ghTextAsync(['api', 'user']);
  // Let the first request take the slot and start.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(
    ghTextAsync(['api', 'user'], { admissionDeadlineMs: 20 }),
    (error) => {
      const detail = findLoadControlRefusal(error);
      assert.equal(detail?.outcome, 'deadline-expired');
      assert.equal(detail?.reason, 'busy');
      assert.equal((error as { ghCommand?: boolean }).ghCommand, true);
      return true;
    },
  );
  await running;
  assert.equal(
    f.calls().filter((call) => call[0] === 'api').length,
    1,
    'the refused request never spawned gh',
  );
});

// -- cooldown ------------------------------------------------------------------------

test('a throttle failure starts a shared cooldown that refuses later reads, writes, and GraphQL without spawning', () => {
  const f = fixture();
  f.enable({ maxWaitMs: 1_000 });
  f.mode('secondary');
  assert.throws(
    () => ghApiJson('repos/o/r'),
    (error) => {
      assert.equal(
        isNotDispatchedRefusal(error),
        false,
        'the failure itself is not a refusal',
      );
      return true;
    },
  );
  assert.equal(stateFiles(f, 'cooldown').length, 1);
  const spawned = f.calls().length;
  f.mode('ok');

  const read = refusalOf(() => ghText(['api', 'repos/o/r']));
  assert.equal(read.detail.outcome, 'deadline-expired');
  assert.equal(read.detail.reason, 'cooldown');
  assert.equal(read.detail.retryAt, new Date(T0 + 90_000).toISOString());
  assert.equal(read.detail.retryAtSource, 'server');
  assert.equal(read.error.ghCommand, true);

  const graphql = refusalOf(() => ghGraphql('query { viewer { login } }', {}));
  assert.equal(graphql.detail.reason, 'cooldown');
  const mutation = refusalOf(() =>
    ghText(['api', 'graphql', '-f', 'query=mutation { x }']),
  );
  assert.equal(mutation.detail.outcome, 'not-dispatched');
  const write = refusalOf(() =>
    ghText(
      [
        'api',
        '--method',
        'POST',
        'repos/o/r/issues/1/comments',
        '--input',
        '-',
      ],
      {
        input: '{}',
      },
    ),
  );
  assert.equal(write.detail.outcome, 'not-dispatched');
  assert.equal(write.detail.retryAt, new Date(T0 + 90_000).toISOString());
  const unclassified = refusalOf(() => ghText(['pr', 'merge', '1']));
  assert.equal(unclassified.detail.outcome, 'not-dispatched');
  assert.equal(f.calls().length, spawned, 'no refused request spawned gh');
});

test('a write refused during a cooldown is never dispatched once the cooldown clears', () => {
  const f = fixture();
  f.enable();
  f.mode('secondary');
  assert.throws(() => ghText(['api', 'repos/o/r']));
  f.mode('ok');
  const spawned = f.calls().length;
  const args = [
    'api',
    '--method',
    'POST',
    'repos/o/r/issues/1/comments',
    '--input',
    '-',
  ];
  refusalOf(() => ghText(args, { input: '{}' }));
  // The cooldown ends. Nothing was queued, so nothing runs by itself; the
  // caller reruns its own gates and issues a new request.
  f.clock.wall += 91_000;
  f.clock.mono += 91_000;
  assert.equal(f.calls().length, spawned);
  assert.equal(ghText(args, { input: '{}' }), '{"ok":true}');
  assert.equal(f.calls().length, spawned + 1);
});

test('the #3560 failure text starts a shared cooldown even though no header names a subtype', () => {
  const f = fixture();
  f.enable();
  f.mode('already-exceeded');
  assert.throws(() => ghText(['issue', 'list', '--repo', 'o/r']));
  f.mode('ok');
  const detail = refusalOf(() =>
    ghText(['api', '--method', 'POST', 'repos/o/r/issues', '--input', '-'], {
      input: '{}',
    }),
  ).detail;
  assert.equal(detail.reason, 'cooldown');
  assert.equal(detail.retryAt, new Date(T0 + 60_000).toISOString());
  assert.equal(detail.retryAtSource, 'backoff');
});

test('a throttle inside a tolerated allowStatuses failure is still recorded', () => {
  const f = fixture();
  f.enable();
  f.mode('secondary');
  const data = ghApiJson('repos/o/r', { allowStatuses: [1] });
  assert.deepEqual(data, {
    message: 'You have exceeded a secondary rate limit',
  });
  assert.equal(stateFiles(f, 'cooldown').length, 1);
});

test('a real throttle failure is retried through the gate, a refusal is not', async () => {
  let attempts = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        attempts += 1;
        throw new Error('transient');
      },
      { baseDelayMs: 1 },
    ),
  );
  assert.equal(attempts, 3);

  const f = fixture();
  f.enable();
  f.mode('secondary');
  assert.throws(() => ghText(['api', 'user']));
  f.mode('ok');
  let refused = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        refused += 1;
        return ghTextAsync([
          'api',
          '--method',
          'POST',
          'repos/o/r',
          '--input',
          '-',
        ]);
      },
      { baseDelayMs: 1 },
    ),
    (error) => isNotDispatchedRefusal(error),
  );
  assert.equal(refused, 1, 'a refusal is not retried');

  // A wrapper that rebuilds the error must not hide it from the retry loop.
  let wrapped = 0;
  await assert.rejects(
    withBoundedRetry(
      async () => {
        wrapped += 1;
        const { error } = refusalOf(() => ghText(['pr', 'merge', '1']));
        throw wrapGhCompatibilityError(error);
      },
      { baseDelayMs: 1, isRetryable: () => true },
    ),
  );
  assert.equal(wrapped, 1);
});

test('a refusal is not counted as a failed invocation by request telemetry', () => {
  const f = fixture();
  const telemetryPath = join(f.root, 'telemetry.jsonl');
  setGithubApiTelemetryPolicyForTests({
    enabled: true,
    maxRecords: 10,
    path: telemetryPath,
  });
  f.enable();
  f.mode('secondary');
  assert.throws(() => ghApiJson('repos/o/r'));
  const recorded = () =>
    existsSync(telemetryPath)
      ? readFileSync(telemetryPath, 'utf8').trim().split('\n').filter(Boolean)
          .length
      : 0;
  assert.equal(recorded(), 1, 'the real failure is one record');
  f.mode('ok');
  refusalOf(() => ghApiJson('repos/o/r', { admissionDeadlineMs: 0 }));
  refusalOf(() =>
    ghApiJsonWithHeaders('repos/o/r', { admissionDeadlineMs: 0 }),
  );
  refusalOf(() => ghGraphql('query { viewer { login } }', {}));
  assert.equal(
    recorded(),
    1,
    'a refusal started no process and adds no record',
  );
});

test('an explicit spawn timeout caps the admission wait at half of it', () => {
  const f = fixture();
  f.enable({ maxWaitMs: 60_000 });
  f.mode('secondary');
  assert.throws(() => ghText(['api', 'user']));
  f.mode('ok');
  const before = f.clock.mono;
  // The cooldown is 90 s. With a 4 s timeout the wait may use at most 2 s,
  // so the read is refused at once instead of waiting.
  const { detail } = refusalOf(() =>
    ghText(['api', 'user'], { timeout: 4_000 }),
  );
  assert.equal(detail.outcome, 'deadline-expired');
  assert.equal(f.clock.mono, before, 'a doomed wait is not slept');
});

// -- identity ---------------------------------------------------------------------------

test('identity comes from the environment token, or one memoized gh auth token lookup', () => {
  const f = fixture();
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_HOST: process.env.GH_HOST,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_HOST;
  delete process.env.GITHUB_SERVER_URL;
  try {
    f.enableResolving();
    ghText(['api', 'user']);
    ghText(['api', 'user']);
    ghApiJson('repos/o/r');
    const lookups = f.calls().filter((call) => call[0] === 'auth');
    assert.equal(
      lookups.length,
      1,
      'the identity is looked up once per process',
    );
    assert.deepEqual(lookups[0], ['auth', 'token', '--hostname', 'github.com']);
    const expected = loadControlScopeName({
      host: 'github.com',
      credentialMaterial: 'token-for-github.com',
    });
    assert.deepEqual(readdirSync(f.state), [expected]);

    // A token in the environment is used without any lookup, per host.
    process.env.GH_HOST = 'ghe.example.com';
    process.env.GH_ENTERPRISE_TOKEN = 'enterprise-token';
    setGithubApiLoadControlForTests({
      policy: { enabled: true, maxConcurrent: 1, maxWaitMs: 5_000 },
      runtime: f.runtime(),
    });
    const before = f.calls().filter((call) => call[0] === 'auth').length;
    ghText(['api', 'user']);
    assert.equal(f.calls().filter((call) => call[0] === 'auth').length, before);
    assert.ok(
      readdirSync(f.state).includes(
        loadControlScopeName({
          host: 'ghe.example.com',
          credentialMaterial: 'enterprise-token',
        }),
      ),
    );
  } finally {
    delete process.env.GH_ENTERPRISE_TOKEN;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

function withCleanHostEnv(run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
    'GH_HOST',
    'GITHUB_SERVER_URL',
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('the host comes from the one configured gh host, and an ambiguous one stays uncoordinated', () => {
  const f = fixture();
  withCleanHostEnv(() => {
    const config = process.env.GH_CONFIG_DIR as string;
    mkdirSync(config, { recursive: true });
    // Exactly one configured host: gh itself would use it.
    writeFileSync(
      join(config, 'hosts.yml'),
      'ghe.example.com:\n    user: octocat\n    git_protocol: https\n',
    );
    f.enableResolving();
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.equal(ghText(['issue', 'list', '--repo', 'o/r']), '{"ok":true}');
    assert.deepEqual(
      f.calls().filter((call) => call[0] === 'auth'),
      [['auth', 'token', '--hostname', 'ghe.example.com']],
    );
    assert.deepEqual(readdirSync(f.state), [
      loadControlScopeName({
        host: 'ghe.example.com',
        credentialMaterial: 'token-for-ghe.example.com',
      }),
    ]);

    // Several configured hosts and no GH_HOST: `gh api` falls to github.com,
    // but a higher-level command takes its host from the git remote, which is
    // not visible here, so it must not borrow github.com's scope.
    setGithubApiLoadControlForTests(null);
    rmSync(f.state, { recursive: true, force: true });
    writeFileSync(
      join(config, 'hosts.yml'),
      'github.com:\n    user: a\nghe.example.com:\n    user: b\n',
    );
    f.enableResolving();
    assert.equal(ghText(['issue', 'list', '--repo', 'o/r']), '{"ok":true}');
    assert.equal(
      existsSync(f.state),
      false,
      'the ambiguous command ran uncoordinated',
    );
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.deepEqual(readdirSync(f.state), [
      loadControlScopeName({
        host: 'github.com',
        credentialMaterial: 'token-for-github.com',
      }),
    ]);
    // An explicit host in the repo flag is honored even then.
    ghText(['issue', 'list', '-R', 'ghe.example.com/o/r']);
    assert.ok(
      readdirSync(f.state).includes(
        loadControlScopeName({
          host: 'ghe.example.com',
          credentialMaterial: 'token-for-ghe.example.com',
        }),
      ),
    );
  });
});

test('no gh configuration at all means github.com', () => {
  const f = fixture();
  withCleanHostEnv(() => {
    f.enableResolving();
    assert.equal(ghText(['issue', 'list', '--repo', 'o/r']), '{"ok":true}');
    assert.deepEqual(readdirSync(f.state), [
      loadControlScopeName({
        host: 'github.com',
        credentialMaterial: 'token-for-github.com',
      }),
    ]);
  });
});

test('hosts.yml with a BOM or quoted keys still lists its hosts, and an unfamiliar non-empty file is unresolved', () => {
  const f = fixture();
  withCleanHostEnv(() => {
    const config = process.env.GH_CONFIG_DIR as string;
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, 'hosts.yml'),
      '\uFEFF"ghe.example.com":\r\n    user: octocat\r\n',
    );
    f.enableResolving();
    ghText(['api', 'user']);
    assert.deepEqual(readdirSync(f.state), [
      loadControlScopeName({
        host: 'ghe.example.com',
        credentialMaterial: 'token-for-ghe.example.com',
      }),
    ]);

    // A non-empty file this parser cannot read is not "no hosts": guessing
    // github.com could share a scope with the wrong host.
    setGithubApiLoadControlForTests(null);
    rmSync(f.state, { recursive: true, force: true });
    writeFileSync(join(config, 'hosts.yml'), '  - unfamiliar layout\n');
    f.enableResolving();
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.equal(existsSync(f.state), false, 'unresolved host: uncoordinated');
  });
});

test('the gh config directory follows GH_CONFIG_DIR, then XDG_CONFIG_HOME', () => {
  const f = fixture();
  withCleanHostEnv(() => {
    const savedDir = process.env.GH_CONFIG_DIR;
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.GH_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = join(f.root, 'xdg-config');
    try {
      mkdirSync(join(f.root, 'xdg-config', 'gh'), { recursive: true });
      writeFileSync(
        join(f.root, 'xdg-config', 'gh', 'hosts.yml'),
        'ghe.example.com:\n    user: octocat\n',
      );
      f.enableResolving();
      ghText(['api', 'user']);
      assert.deepEqual(
        f.calls().filter((call) => call[0] === 'auth'),
        [['auth', 'token', '--hostname', 'ghe.example.com']],
      );
    } finally {
      if (savedDir === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = savedDir;
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = savedXdg;
    }
  });
});

test('a rate-limit error inside a successful GraphQL response starts the cooldown through ghGraphql', () => {
  const f = fixture();
  f.enable({ maxWaitMs: 1_000 });
  f.mode('graphql-limited');
  const response = ghGraphql('query { viewer { login } }', {});
  assert.deepEqual((response as { data: unknown }).data, null);
  assert.equal(stateFiles(f, 'cooldown').length, 1);
  f.mode('ok');
  const spawned = f.calls().length;
  refusalOf(() => ghText(['api', 'repos/o/r']));
  assert.equal(f.calls().length, spawned);
});

test('a failed identity lookup runs uncoordinated and is not retried on every call', () => {
  const f = fixture();
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  process.env.IDD_STUB_FAIL_AUTH = '1';
  try {
    f.enableResolving();
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.equal(f.calls().filter((call) => call[0] === 'auth').length, 1);
    assert.equal(existsSync(f.state), false);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a removed working directory keeps load control off and the call unchanged', () => {
  const f = fixture();
  const original = process.cwd;
  process.cwd = () => {
    throw new Error('ENOENT: process.cwd failed');
  };
  try {
    assert.equal(ghText(['api', 'user']), '{"ok":true}');
    assert.deepEqual(ghApiJson('repos/o/r'), { ok: true });
    assert.deepEqual(f.calls(), [
      ['api', 'user'],
      ['api', 'repos/o/r'],
    ]);
  } finally {
    process.cwd = original;
  }
});

test('the first async identity lookup does not block the event loop', async () => {
  const f = fixture();
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_HOST: process.env.GH_HOST,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.IDD_STUB_AUTH_DELAY_MS = '400';
  try {
    f.enableResolving();
    const began = performance.now();
    const pending = ghTextAsync(['api', 'user']);
    const returnedAfter = performance.now() - began;
    // ghTextAsync returned its promise while gh auth token was still
    // running, so this process's own in-flight requests could still finish.
    assert.ok(
      returnedAfter < 200,
      `the call blocked for ${Math.round(returnedAfter)} ms`,
    );
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    assert.equal(await pending, '{"ok":true}');
    clearInterval(timer);
    assert.ok(ticks >= 3, 'timers kept running during the lookup');
    assert.equal(f.calls().filter((call) => call[0] === 'auth').length, 1);
  } finally {
    delete process.env.IDD_STUB_AUTH_DELAY_MS;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('a burst of first async calls shares one identity lookup', async () => {
  const f = fixture();
  const saved = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_HOST: process.env.GH_HOST,
    GITHUB_SERVER_URL: process.env.GITHUB_SERVER_URL,
  };
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.IDD_STUB_AUTH_DELAY_MS = '300';
  try {
    f.enableResolving({ maxConcurrent: 8 });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => ghTextAsync(['api', 'user'])),
    );
    assert.deepEqual(results, Array(6).fill('{"ok":true}'));
    assert.equal(
      f.calls().filter((call) => call[0] === 'auth').length,
      1,
      'one gh auth token for the whole burst',
    );
    assert.equal(readdirSync(f.state).length, 1, 'every call used one scope');
  } finally {
    delete process.env.IDD_STUB_AUTH_DELAY_MS;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the compatibility wrapper keeps a refusal reason instead of an empty message', () => {
  const f = fixture();
  f.enable();
  f.mode('secondary');
  assert.throws(() => ghText(['api', 'user']));
  f.mode('ok');
  const { error } = refusalOf(() => ghText(['pr', 'merge', '1']));
  const wrapped = wrapGhCompatibilityError(error);
  assert.match(
    wrapped.message,
    /^gh command failed: gh request not dispatched/,
  );
  assert.equal(isNotDispatchedRefusal(wrapped), true);
  // Every other failure keeps the historical text.
  const plain = wrapGhCompatibilityError(
    Object.assign(new Error('boom'), { stderr: 'gh: Not Found (HTTP 404)' }),
  );
  assert.equal(plain.message, 'gh command failed: gh: Not Found (HTTP 404)');
  assert.equal(
    wrapGhCompatibilityError(new Error('no stderr')).message,
    'gh command failed: ',
  );
});

// -- two repositories, through the real config --------------------------------------------

const WORKER = new URL('./gh-exec-load-control-worker.mts', import.meta.url);

function runWorker(
  env: Record<string, string>,
  cwd: string,
): { exited: Promise<number>; stdout: () => string; stderr: () => string } {
  const flags = process.execArgv.filter(
    (arg) => arg !== '--test' && !arg.startsWith('--test-'),
  );
  let out = '';
  let err = '';
  const child = spawn(process.execPath, [...flags, fileURLToPath(WORKER)], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? -1));
  });
  return { exited, stdout: () => out, stderr: () => err };
}

test('two repositories with their own config share one host-local admission and cooldown', {
  skip: process.platform === 'win32',
}, async () => {
  const f = fixture();
  const repoA = join(f.root, 'repo-a');
  const repoB = join(f.root, 'repo-b');
  for (const repo of [repoA, repoB]) {
    mkdirSync(join(repo, '.github', 'idd'), { recursive: true });
    writeFileSync(
      join(repo, '.github', 'idd', 'config.json'),
      JSON.stringify({
        githubApi: { loadControl: { enabled: true, maxWait: 'PT2S' } },
      }),
    );
  }
  const env = {
    XDG_STATE_HOME: join(f.root, 'xdg'),
    GH_TOKEN: 'shared-token',
    GH_HOST: '',
    GITHUB_SERVER_URL: '',
  };
  const write = 'write';
  const release = join(f.root, 'release');
  process.env.IDD_STUB_RELEASE = release;
  cleanups.push(() => {
    delete process.env.IDD_STUB_RELEASE;
  });
  f.mode('hold');
  // Repository A starts a write and holds the only slot until released.
  const holder = runWorker({ ...env, IDD_WORKER_CALL: write }, repoA);
  const started = Date.now();
  while (!f.calls().some((call) => call[0] === 'api')) {
    if (Date.now() - started > 60_000)
      throw new Error('holder never spawned gh');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  // A write from repository B is refused while A's request is running.
  const blocked = runWorker({ ...env, IDD_WORKER_CALL: write }, repoB);
  assert.equal(await blocked.exited, 0, blocked.stderr());
  const blockedOut = JSON.parse(
    blocked.stdout().trim().split('\n').at(-1) ?? '{}',
  );
  assert.equal(blockedOut.refused, true);
  assert.equal(blockedOut.detail.reason, 'busy');
  writeFileSync(release, '1');
  assert.equal(await holder.exited, 0, holder.stderr());
  assert.equal(
    f.calls().filter((call) => call[0] === 'api').length,
    1,
    'only the holder ever spawned gh',
  );

  // After a throttle seen by A, B is refused with the shared retryAt.
  f.mode('secondary');
  const thrower = runWorker({ ...env, IDD_WORKER_CALL: 'read' }, repoA);
  assert.equal(await thrower.exited, 0, thrower.stderr());
  f.mode('ok');
  const after = runWorker({ ...env, IDD_WORKER_CALL: write }, repoB);
  assert.equal(await after.exited, 0, after.stderr());
  const afterOut = JSON.parse(after.stdout().trim().split('\n').at(-1) ?? '{}');
  assert.equal(afterOut.refused, true);
  assert.equal(afterOut.detail.reason, 'cooldown');
  assert.equal(typeof afterOut.detail.retryAt, 'string');
});
