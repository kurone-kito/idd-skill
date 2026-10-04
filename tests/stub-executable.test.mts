import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  type RmOptions,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  installFixtureGh,
  removeStubDirectory,
  STUB_REMOVAL_POLL_COUNT,
  stubExecutable,
} from './test-utils.mts';

// #2571: `stubExecutable` is the shared cross-platform replacement for the
// PATH-stubbed-`gh`-CLI fixture pattern every affected test file used to
// hand-roll (POSIX-only: a literal `:`-joined PATH plus a shebang script,
// neither of which Windows resolves the way `execFileSync('gh', ...)`
// needs). These tests pin the parts of its Windows behavior that are least
// obvious from reading the implementation alone -- argv shape, non-zero
// exit propagation, async work surviving to completion, and that an outer
// real Node process sharing the same env is never mistaken for the stub.

test('argv reaches the stub script in the same shape execFileSync passed', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-stub-executable-argv-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubExecutable(
    'gh',
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('ok');
`,
  );
  try {
    const out = execFileSync('gh', ['repo', 'view', '--json', 'name'], {
      encoding: 'utf8',
    });
    assert.equal(out, 'ok');
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'repo',
      'view',
      '--json',
      'name',
    ]);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a single-word first argument round-trips through argv (regression: Node resolves argv[1] against cwd before this stub runs)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-stub-executable-firstarg-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubExecutable(
    'gh',
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
`,
  );
  try {
    execFileSync('gh', ['api'], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['api']);
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('a non-zero process.exitCode propagates without an explicit process.exit() call', () => {
  const restore = stubExecutable(
    'gh',
    `process.stdout.write('sync-only');
process.exitCode = 3;
`,
  );
  try {
    assert.throws(
      () => execFileSync('gh', ['x'], { encoding: 'utf8', stdio: 'pipe' }),
      (error: unknown) => {
        const e = error as { status?: number; stdout?: string };
        assert.equal(e.status, 3);
        assert.equal(e.stdout, 'sync-only');
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('an explicit process.exit() call still propagates', () => {
  const restore = stubExecutable('gh', 'process.exit(7);\n');
  try {
    assert.throws(
      () => execFileSync('gh', ['x'], { encoding: 'utf8', stdio: 'pipe' }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 7);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('pending async work (a process.stdin listener) still runs to completion before the process exits', () => {
  const restore = stubExecutable(
    'gh',
    `const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(Buffer.concat(chunks).toString('utf8'));
});
`,
  );
  try {
    const out = execFileSync('gh', ['api', '--input', '-'], {
      encoding: 'utf8',
      input: 'hello-stdin',
      timeout: 5_000,
    });
    assert.equal(out, 'hello-stdin');
  } finally {
    restore();
  }
});

test('a real outer Node process sharing the stub env is never hijacked by it', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-stub-executable-outer-'));
  const realScript = join(tempRoot, 'real.mjs');
  writeFileSync(
    realScript,
    "console.log('REAL:' + JSON.stringify(process.argv.slice(2)));",
  );
  const restore = stubExecutable(
    'gh',
    "process.stdout.write('SHOULD-NOT-RUN');\n",
  );
  try {
    const out = execFileSync(process.execPath, [realScript, 'q', 'r'], {
      encoding: 'utf8',
      env: { ...process.env },
    });
    assert.equal(out.trim(), 'REAL:["q","r"]');
  } finally {
    restore();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('the returned cleanup callback restores PATH and NODE_OPTIONS', () => {
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const restore = stubExecutable('gh', "process.stdout.write('x');\n");
  restore();
  assert.equal(process.env.PATH, originalPath);
  assert.equal(process.env.NODE_OPTIONS, originalNodeOptions);
});

test('the returned cleanup callback removes the temp directory it created (regression: a leaked hard-linked node.exe per Windows call site)', () => {
  const restore = stubExecutable('gh', "process.stdout.write('x');\n");
  // `node:test` runs test files in parallel, and a concurrent file's own
  // stubExecutable('gh', ...) call can create an `idd-stub-gh-*` directory
  // in the same os.tmpdir() window -- diffing a before/after directory
  // listing to spot "the new one" is racy against that. stubExecutable
  // always prepends its own temp dir as PATH's first entry, so reading it
  // straight from PATH identifies this call's own directory deterministically.
  const createdPath = (process.env.PATH as string).split(delimiter)[0];
  assert.match(createdPath, /idd-stub-gh-/);
  assert.ok(existsSync(createdPath));
  restore();
  assert.equal(existsSync(createdPath), false);
});

// #3680: `removeStubDirectory` is exercised through injected collaborators, so
// every assertion below is about call counts, recorded arguments and
// warnings, never elapsed time.
function removalRecorder(
  failures: (callNumber: number) => NodeJS.ErrnoException | undefined,
) {
  const calls: { path: string; options: RmOptions }[] = [];
  const sleeps: number[] = [];
  const warnings: string[] = [];
  return {
    calls,
    sleeps,
    warnings,
    options: {
      remove: (path: string, options: RmOptions) => {
        calls.push({ path, options });
        const failure = failures(calls.length);
        if (failure) {
          throw failure;
        }
      },
      sleep: (milliseconds: number) => void sleeps.push(milliseconds),
      warn: (message: string) => void warnings.push(message),
      pollIntervalMs: 7,
    },
  };
}

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('injected removal failure'), { code });
}

function assertEveryCallIsRecursiveAndForced(
  calls: readonly { options: RmOptions }[],
) {
  for (const { options } of calls) {
    assert.equal(options.recursive, true);
    assert.equal(options.force, true);
  }
}

test('removeStubDirectory: an EPERM that clears inside the bound returns with no warning (win32)', () => {
  const recorder = removalRecorder((n) =>
    n <= 3 ? errnoError('EPERM') : undefined,
  );
  removeStubDirectory('C:\\tmp\\idd-stub-x', {
    ...recorder.options,
    platform: 'win32',
  });
  assert.equal(recorder.calls.length, 4);
  assert.deepEqual(recorder.calls[0].options, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  for (const { options } of recorder.calls.slice(1)) {
    assert.equal(options.maxRetries, 0);
    assert.equal(options.retryDelay, 0);
  }
  assertEveryCallIsRecursiveAndForced(recorder.calls);
  assert.deepEqual(recorder.sleeps, [7, 7, 7]);
  assert.deepEqual(recorder.warnings, []);
});

test('removeStubDirectory: success on the last polling call is still silent (off-by-one guard)', () => {
  const lastCall = 1 + STUB_REMOVAL_POLL_COUNT;
  const recorder = removalRecorder((n) =>
    n < lastCall ? errnoError('EPERM') : undefined,
  );
  removeStubDirectory('C:\\tmp\\idd-stub-x', {
    ...recorder.options,
    platform: 'win32',
  });
  assert.equal(recorder.calls.length, lastCall);
  assert.equal(recorder.sleeps.length, STUB_REMOVAL_POLL_COUNT);
  assert.deepEqual(recorder.warnings, []);
});

for (const code of ['EPERM', 'EBUSY']) {
  test(`removeStubDirectory: ${code} on every call (win32) returns after the initial call plus every polling call, with one warning naming the directory`, () => {
    const recorder = removalRecorder(() => errnoError(code));
    const directory = 'C:\\tmp\\idd-stub-locked';
    removeStubDirectory(directory, {
      ...recorder.options,
      platform: 'win32',
    });
    assert.equal(recorder.calls.length, 1 + STUB_REMOVAL_POLL_COUNT);
    assert.equal(recorder.sleeps.length, STUB_REMOVAL_POLL_COUNT);
    assertEveryCallIsRecursiveAndForced(recorder.calls);
    assert.equal(recorder.warnings.length, 1);
    assert.ok(recorder.warnings[0].includes(directory));
    assert.ok(recorder.warnings[0].includes(code));
  });
}

for (const platform of ['linux', 'darwin'] as const) {
  test(`removeStubDirectory: EPERM on ${platform} is thrown after one attempt`, () => {
    const injected = errnoError('EPERM');
    const recorder = removalRecorder(() => injected);
    assert.throws(
      () =>
        removeStubDirectory('/tmp/idd-stub-x', {
          ...recorder.options,
          platform,
        }),
      (thrown) => thrown === injected,
    );
    assert.equal(recorder.calls.length, 1);
    assert.deepEqual(recorder.sleeps, []);
    assert.deepEqual(recorder.warnings, []);
  });
}

test('removeStubDirectory: an error other than EPERM or EBUSY (win32) is thrown after one attempt', () => {
  const injected = errnoError('ENOSPC');
  const recorder = removalRecorder(() => injected);
  assert.throws(
    () =>
      removeStubDirectory('C:\\tmp\\idd-stub-x', {
        ...recorder.options,
        platform: 'win32',
      }),
    (thrown) => thrown === injected,
  );
  assert.equal(recorder.calls.length, 1);
  assert.deepEqual(recorder.sleeps, []);
  assert.deepEqual(recorder.warnings, []);
});

test('removeStubDirectory: a non-transient error during polling (win32) is thrown at once, not swallowed into the warning', () => {
  const injected = errnoError('ENOTEMPTY');
  const recorder = removalRecorder((n) =>
    n === 1 ? errnoError('EPERM') : n === 3 ? injected : errnoError('EPERM'),
  );
  assert.throws(
    () =>
      removeStubDirectory('C:\\tmp\\idd-stub-x', {
        ...recorder.options,
        platform: 'win32',
      }),
    (thrown) => thrown === injected,
  );
  assert.equal(recorder.calls.length, 3);
  assert.equal(recorder.sleeps.length, 2);
  assert.deepEqual(recorder.warnings, []);
});

test('removeStubDirectory: removes a real directory with the default collaborators', () => {
  const directory = mkdtempSync(join(tmpdir(), 'idd-stub-remove-real-'));
  writeFileSync(join(directory, 'file.txt'), 'x');
  removeStubDirectory(directory);
  assert.equal(existsSync(directory), false);
});

test('removeStubDirectory: the default sleep and warning sink work when every removal fails (win32)', () => {
  const recorder = removalRecorder(() => errnoError('EPERM'));
  const directory = 'C:\\tmp\\idd-stub-default-sinks';
  const written: string[] = [];
  const realWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    // A zero interval keeps the default blocking sleep out of the wall-clock
    // budget (`Atomics.wait` with a zero timeout returns at once).
    removeStubDirectory(directory, {
      remove: recorder.options.remove,
      platform: 'win32',
      pollIntervalMs: 0,
    });
  } finally {
    process.stderr.write = realWrite;
  }
  assert.equal(recorder.calls.length, 1 + STUB_REMOVAL_POLL_COUNT);
  assert.equal(written.length, 1);
  assert.ok(written[0].includes(directory));
  assert.ok(written[0].endsWith('\n'));
});

test('an originally-unset PATH is stubbed without a trailing delimiter and restored by deletion, not the literal string "undefined" (regression, Copilot review on PR #2575)', () => {
  const realPath = process.env.PATH;
  delete process.env.PATH;
  try {
    const restore = stubExecutable('gh', "process.stdout.write('x');\n");
    try {
      assert.ok(
        process.env.PATH,
        'PATH should be set to just the stub temp dir',
      );
      assert.ok(
        !(process.env.PATH as string).endsWith(delimiter),
        'PATH should not carry a trailing delimiter (an empty, cwd-implying PATH entry) when it was originally unset',
      );
      // POSIX only: with PATH reduced to just the stub temp dir, `#!/usr/bin/env
      // node` could no longer resolve `node` at all (regression, Copilot
      // review PR #2575) -- the shebang names process.execPath directly, so
      // confirm the stub still actually runs, not just that PATH looks right.
      if (process.platform !== 'win32') {
        assert.equal(execFileSync('gh', ['x'], { encoding: 'utf8' }), 'x');
      }
    } finally {
      restore();
    }
    assert.equal(
      process.env.PATH,
      undefined,
      'restore() should delete PATH, not set it to the literal string "undefined"',
    );
  } finally {
    if (realPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = realPath;
    }
  }
});

test('a stub-setup failure never mutates PATH/NODE_OPTIONS (regression, Copilot review PR #2575: setup must fully commit before either variable is touched)', () => {
  const originalPath = process.env.PATH;
  const originalNodeOptions = process.env.NODE_OPTIONS;
  // An embedded NUL byte is invalid in a path argument to every `node:fs`
  // call this function's setup makes (writeFileSync/chmodSync/linkSync/
  // copyFileSync) on both POSIX and Windows -- Node validates this
  // synchronously before any syscall, so this deterministically exercises
  // the setup-failure path without touching the real filesystem.
  assert.throws(() =>
    stubExecutable('bad\0name', "process.stdout.write('x');\n"),
  );
  assert.equal(process.env.PATH, originalPath);
  assert.equal(process.env.NODE_OPTIONS, originalNodeOptions);
});

// --- #3702: a gh stub keeps load-control state out of the real directory ----

const STATE_ENV_NAMES = ['XDG_STATE_HOME', 'LOCALAPPDATA'] as const;

/** Run `body` with both state variables set to `value` (or removed), restored after. */
function withStateEnv(value: string | undefined, body: () => void): void {
  const saved = STATE_ENV_NAMES.map((key) => [key, process.env[key]] as const);
  for (const key of STATE_ENV_NAMES) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    body();
  } finally {
    for (const [key, original] of saved) {
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

test('a gh stub redirects both load-control state variables into its own temp directory and restores them (#3702)', () => {
  const preset = mkdtempSync(join(tmpdir(), 'idd-stub-state-preset-'));
  try {
    withStateEnv(preset, () => {
      const restore = stubExecutable('gh', "process.stdout.write('x');\n");
      const redirected = STATE_ENV_NAMES.map((key) => process.env[key]);
      assert.equal(redirected[0], redirected[1]);
      assert.notEqual(redirected[0], preset, 'a preset value is overridden');
      assert.ok(redirected[0]?.startsWith(tmpdir()));
      assert.ok(redirected[0]?.includes('idd-stub-gh-'));
      const stateRoot = redirected[0] as string;
      // Stand in for what a helper under test would write there, so the
      // removal check below can actually fail.
      mkdirSync(join(stateRoot, 'leases'), { recursive: true });
      writeFileSync(join(stateRoot, 'leases', 'slot.json'), '{}');
      restore();
      for (const key of STATE_ENV_NAMES) {
        assert.equal(process.env[key], preset, `${key} is restored`);
      }
      assert.equal(existsSync(stateRoot), false, 'the state root is removed');
    });
    withStateEnv(undefined, () => {
      const restore = stubExecutable('gh', "process.stdout.write('x');\n");
      for (const key of STATE_ENV_NAMES) {
        assert.ok(process.env[key], `${key} is set while the stub is active`);
      }
      restore();
      for (const key of STATE_ENV_NAMES) {
        assert.equal(process.env[key], undefined, `${key} is removed again`);
      }
    });
  } finally {
    rmSync(preset, { recursive: true, force: true });
  }
});

test('a value a test assigns after stubbing gh survives the stub cleanup (#3702)', () => {
  const original = mkdtempSync(join(tmpdir(), 'idd-stub-state-original-'));
  const own = mkdtempSync(join(tmpdir(), 'idd-stub-state-own-'));
  try {
    withStateEnv(original, () => {
      const restore = stubExecutable('gh', "process.stdout.write('x');\n");
      for (const key of STATE_ENV_NAMES) process.env[key] = own;
      restore();
      for (const key of STATE_ENV_NAMES) {
        assert.equal(
          process.env[key],
          own,
          `${key} keeps the test's own value`,
        );
      }
    });
  } finally {
    rmSync(original, { recursive: true, force: true });
    rmSync(own, { recursive: true, force: true });
  }
});

test('a stub that is not gh leaves the load-control state variables alone (#3702)', () => {
  const preset = mkdtempSync(join(tmpdir(), 'idd-stub-state-other-'));
  try {
    withStateEnv(preset, () => {
      const restore = stubExecutable('git', "process.stdout.write('x');\n");
      for (const key of STATE_ENV_NAMES) {
        assert.equal(process.env[key], preset, `${key} is untouched`);
      }
      restore();
      for (const key of STATE_ENV_NAMES) {
        assert.equal(process.env[key], preset, `${key} is untouched`);
      }
    });
  } finally {
    rmSync(preset, { recursive: true, force: true });
  }
});

// #3746: `installFixtureGh` serves the GitHub reads the collector suites make
// and records everything else, instead of letting a blocked or real `gh`
// answer (and the code under test swallow the failure).
const gh = (...args: string[]): string =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const OBSERVED_QUERY =
  'query($owner:String!,$repo:String!,$number:Int!,$after:String){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ headRefOid commits(last:1){ nodes{ commit{ oid checkSuites(first:100, after:$after){ nodes{ createdAt } } } } } } } }';
const observedArgs = (after?: string, ...extra: string[]): string[] => [
  'api',
  'graphql',
  ...extra,
  '-f',
  `query=${OBSERVED_QUERY}`,
  '-f',
  'owner=acme',
  '-f',
  'repo=widgets',
  '-F',
  'number=7',
  ...(after ? ['-f', `after=${after}`] : []),
];

test('fixture gh serves the viewer read, signs out on request, and records every call', () => {
  const fixture = installFixtureGh();
  try {
    assert.equal(gh('api', 'user', '--jq', '.login'), 'kurone-kito\n');
    fixture.setViewer('someone-else');
    assert.equal(gh('api', 'user', '--jq', '.login'), 'someone-else\n');
    fixture.setViewer(null);
    assert.throws(() => gh('api', 'user', '--jq', '.login'), /signed out/);
    assert.deepEqual(fixture.unexpectedCalls(), []);
    assert.equal(fixture.calls().length, 3);
  } finally {
    fixture.restore();
  }
});

test('fixture gh answers the check-suite read with consistent head, createdAt values and paging', () => {
  const fixture = installFixtureGh({
    checkSuites: {
      headRefOid: 'a'.repeat(40),
      commitOid: 'a'.repeat(40),
      pages: [['2026-05-17T03:00:00Z'], ['2026-05-17T01:00:00Z']],
    },
  });
  try {
    const first = JSON.parse(gh(...observedArgs()));
    const pr = first.data.repository.pullRequest;
    assert.equal(pr.headRefOid, 'a'.repeat(40));
    assert.equal(pr.commits.nodes[0].commit.oid, 'a'.repeat(40));
    assert.deepEqual(pr.commits.nodes[0].commit.checkSuites.nodes, [
      { createdAt: '2026-05-17T03:00:00Z' },
    ]);
    assert.deepEqual(pr.commits.nodes[0].commit.checkSuites.pageInfo, {
      hasNextPage: true,
      endCursor: 'page:1',
    });
    const second = JSON.parse(gh(...observedArgs('page:1')));
    const suites =
      second.data.repository.pullRequest.commits.nodes[0].commit.checkSuites;
    assert.deepEqual(suites.nodes, [{ createdAt: '2026-05-17T01:00:00Z' }]);
    assert.equal(suites.pageInfo.hasNextPage, false);
    // A GHES server URL inserts `--hostname <host>`; the answer is unchanged.
    assert.deepEqual(
      JSON.parse(
        gh(...observedArgs(undefined, '--hostname', 'ghe.example.com')),
      ),
      first,
    );
    assert.deepEqual(fixture.unexpectedCalls(), []);
    fixture.setCheckSuites({ commitOid: 'b'.repeat(40) });
    const moved = JSON.parse(gh(...observedArgs()));
    assert.notEqual(
      moved.data.repository.pullRequest.headRefOid,
      moved.data.repository.pullRequest.commits.nodes[0].commit.oid,
    );
  } finally {
    fixture.restore();
  }
});

test('fixture gh records and rejects any shape it does not serve, including a query missing a required field', () => {
  const fixture = installFixtureGh();
  try {
    assert.throws(() => gh('repo', 'view'), /unexpected invocation/);
    assert.throws(
      () => gh('api', 'graphql', '-f', 'query=query{viewer{login}}'),
      /unexpected invocation/,
    );
    assert.throws(
      () =>
        gh(
          'api',
          'graphql',
          '-f',
          `query=${OBSERVED_QUERY}`,
          '-f',
          'owner=acme',
        ),
      /unexpected invocation/,
    );
    assert.deepEqual(
      fixture.unexpectedCalls().map((call) => call[0]),
      ['repo', 'api', 'api'],
    );
  } finally {
    fixture.restore();
  }
});

test('fixture gh does not serve another GraphQL query that merely carries owner, repo and a numeric number, nor a non-numeric number', () => {
  const fixture = installFixtureGh();
  try {
    const other = (
      number: string,
      query = 'query($owner:String!){ viewer { login } }',
    ) => [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      'owner=acme',
      '-f',
      'repo=widgets',
      '-F',
      `number=${number}`,
    ];
    assert.throws(() => gh(...other('7')), /unexpected invocation/);
    // Each required fragment is needed on its own: a `checkSuites` marker
    // with neither of the others, with `pullRequest(number:$number)` but no
    // `commits(last:1)`, with `commits(last:1)` but no pull-request lookup, and
    // the pull-request commit walk without `checkSuites` are all other queries.
    assert.throws(
      () =>
        gh(
          ...other(
            '7',
            'query($owner:String!){ node { checkSuites(first:100) } }',
          ),
        ),
      /unexpected invocation/,
    );
    assert.throws(
      () =>
        gh(
          ...other(
            '7',
            'query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ checkSuites(first:100) } } }',
          ),
        ),
      /unexpected invocation/,
    );
    assert.throws(
      () =>
        gh(
          ...other(
            '7',
            'query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ commits(last:1){ nodes{ commit{ oid } } } } } }',
          ),
        ),
      /unexpected invocation/,
    );
    assert.throws(
      () =>
        gh(
          ...other(
            '7',
            'query($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ ref(qualifiedName:"main"){ target { ... on Commit { commits(last:1){ nodes{ checkSuites(first:100) } } } } } } }',
          ),
        ),
      /unexpected invocation/,
    );
    assert.throws(
      () => gh(...other('seven', OBSERVED_QUERY)),
      /unexpected invocation/,
    );
    assert.equal(fixture.unexpectedCalls().length, 6);
  } finally {
    fixture.restore();
  }
});

test('fixture gh serves canned rules by exact argv, prefix and fragment, in order, before the built-ins, and records the rest', () => {
  const fixture = installFixtureGh({
    responses: [
      { args: ['api', 'user', '--jq', '.login'], stdout: 'from-rule\n' },
      { args: ['repo', 'view'], match: 'prefix', stdout: '{"name":"widgets"}' },
      { args: ['repo'], match: 'prefix', stdout: '{"name":"shadowed"}' },
      {
        args: ['api', 'graphql'],
        match: 'prefix',
        includes: ['nodes(ids:'],
        stdout: '{"data":{"nodes":[]}}',
      },
      { args: ['auth', 'status'], status: 1, stderr: 'not logged in\n' },
    ],
  });
  try {
    // A rule wins over the built-in viewer answer, and the first matching rule
    // wins over a later one that would also match.
    assert.equal(gh('api', 'user', '--jq', '.login'), 'from-rule\n');
    assert.equal(gh('repo', 'view', 'acme/widgets'), '{"name":"widgets"}');
    assert.equal(
      gh('repo', 'view', 'acme/widgets', '--json', 'name'),
      '{"name":"widgets"}',
    );
    // Status and stderr come from the rule; a `--hostname` pair is stripped.
    assert.throws(
      () => gh('auth', 'status', '--hostname', 'github.com'),
      /not logged in/,
    );
    // A fragment narrows a prefix rule to the one query it is meant for.
    assert.equal(
      gh(
        'api',
        'graphql',
        '-f',
        'query=query($ids:[ID!]!){ nodes(ids:$ids){ id } }',
        '-f',
        'ids[]=1',
      ),
      '{"data":{"nodes":[]}}',
    );
    assert.throws(
      () => gh('api', 'graphql', '-f', 'query=query{ viewer { login } }'),
      /unexpected invocation/,
    );
    // An exact rule does not accept a longer argv, and the built-ins answer
    // again once the rule is removed.
    assert.throws(
      () => gh('api', 'user', '--jq', '.login', '--paginate'),
      /unexpected invocation/,
    );
    // `respond` appends, so an earlier rule still wins over a later one.
    fixture.respond({
      args: ['api', 'user', '--jq', '.login'],
      stdout: 'late\n',
    });
    assert.equal(gh('api', 'user', '--jq', '.login'), 'from-rule\n');
    fixture.setResponses([]);
    assert.equal(gh('api', 'user', '--jq', '.login'), 'kurone-kito\n');
    fixture.respond({ args: ['issue', 'list'], match: 'prefix', stdout: '[]' });
    assert.equal(gh('issue', 'list', '--state', 'open'), '[]');
    assert.deepEqual(
      fixture.unexpectedCalls().map((call) => call.join(' ')),
      [
        'api graphql -f query=query{ viewer { login } }',
        'api user --jq .login --paginate',
      ],
    );
  } finally {
    fixture.restore();
  }
});

test('fixture gh keeps the isolate-state variables a preload set, and restores PATH and tokens', () => {
  const state = mkdtempSync(join(tmpdir(), 'idd-fixture-gh-state-'));
  const savedPath = process.env.PATH;
  const savedToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'inert-placeholder';
  try {
    withStateEnv(state, () => {
      const fixture = installFixtureGh();
      try {
        for (const key of STATE_ENV_NAMES) {
          assert.equal(
            process.env[key],
            state,
            `${key} keeps the preload's root`,
          );
        }
        assert.equal(
          process.env.GH_TOKEN,
          undefined,
          'token variables are scrubbed',
        );
        assert.equal(gh('api', 'user', '--jq', '.login'), 'kurone-kito\n');
      } finally {
        fixture.restore();
      }
      for (const key of STATE_ENV_NAMES) {
        assert.equal(process.env[key], state);
      }
    });
    assert.equal(process.env.PATH, savedPath);
    assert.equal(process.env.GH_TOKEN, 'inert-placeholder');
  } finally {
    if (savedToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = savedToken;
    rmSync(state, { recursive: true, force: true });
  }
});

test('a child process spawned while fixture gh is active inherits it', () => {
  const fixture = installFixtureGh({ viewer: 'child-viewer' });
  try {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "process.stdout.write(require('node:child_process').execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }))",
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'child-viewer\n');
  } finally {
    fixture.restore();
  }
});

test('a state-directory write is still reported as a leak while fixture gh is active (#3725)', () => {
  const testUtils = pathToFileURL(
    join(import.meta.dirname, 'test-utils.mts'),
  ).href;
  const preload = pathToFileURL(
    join(import.meta.dirname, 'isolate-state.mts'),
  ).href;
  const script = `
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { installFixtureGh } from ${JSON.stringify(testUtils)};
    const fixture = installFixtureGh();
    const dir = join(process.env.XDG_STATE_HOME ?? process.env.LOCALAPPDATA, 'idd-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leak.json'), '{}');
    fixture.restore();
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--import', preload, '-e', script],
    { encoding: 'utf8', env: { ...process.env, IDD_TEST_STATE_ROOT: '' } },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /isolate-state: LEAK/);
  assert.match(result.stderr, /leak\.json/);
});

test('useFixtureGh fails the test file when any gh call went unserved, and passes without one', () => {
  const testUtils = pathToFileURL(
    join(import.meta.dirname, 'test-utils.mts'),
  ).href;
  const root = mkdtempSync(join(tmpdir(), 'idd-use-fixture-gh-'));
  const write = (name: string, body: string): string => {
    const path = join(root, name);
    writeFileSync(
      path,
      `import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { useFixtureGh } from ${JSON.stringify(testUtils)};
useFixtureGh();
test('body', () => {
${body}
});
`,
    );
    return path;
  };
  try {
    // `NODE_TEST_CONTEXT` makes a nested `node --test` report to its parent
    // and exit 0 even when a test fails, so the child must not inherit it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = (file: string) =>
      spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env });
    const clean = run(
      write(
        'clean.test.mjs',
        "  execFileSync('gh', ['api', 'user', '--jq', '.login']);",
      ),
    );
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    const dirty = run(
      write(
        'dirty.test.mjs',
        "  try { execFileSync('gh', ['repo', 'view'], { stdio: 'ignore' }); } catch {}",
      ),
    );
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stdout + dirty.stderr, /repo/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Copilot review on PR #3767: on Windows `NODE_OPTIONS` stacks one preload per
// installed stub and every preload ran whenever the executable was `<name>.exe`,
// so an OUTER same-name stub (the file-wide fixture gh) answered a call meant
// for a nested one. Same-name stubs now nest LIFO on every platform.
test('a nested same-name stub shadows the outer one, and the outer answers again once it is restored', () => {
  const outer = stubExecutable('gh', "process.stdout.write('outer');\n");
  try {
    assert.equal(gh('x'), 'outer');
    const inner = stubExecutable('gh', "process.stdout.write('inner');\n");
    try {
      assert.equal(gh('x'), 'inner');
      const innermost = stubExecutable(
        'gh',
        "process.stdout.write('innermost');\n",
      );
      try {
        assert.equal(gh('x'), 'innermost');
      } finally {
        innermost();
      }
      assert.equal(gh('x'), 'inner');
    } finally {
      inner();
    }
    assert.equal(gh('x'), 'outer');
  } finally {
    outer();
  }
});

// The Windows route (`<name>.exe` plus a `NODE_OPTIONS` preload) is not reached
// on POSIX, so run it there too: a child reports `win32` before the helper
// reads the platform, and the stub `.exe` is a hard link of this node binary,
// which is runnable on Linux and macOS as `gh.exe`.
test('the Windows preload route nests same-name stubs LIFO (simulated on POSIX)', {
  skip: process.platform === 'win32' ? 'the real route runs on win32' : false,
}, () => {
  const testUtils = pathToFileURL(
    join(import.meta.dirname, 'test-utils.mts'),
  ).href;
  const script = `
    import { execFileSync } from 'node:child_process';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { stubExecutable } = await import(${JSON.stringify(testUtils)});
    const run = () => execFileSync('gh.exe', ['x'], { encoding: 'utf8' });
    const seen = [];
    const outer = stubExecutable('gh', "process.stdout.write('outer');");
    seen.push(run());
    const inner = stubExecutable('gh', "process.stdout.write('inner');");
    seen.push(run());
    inner();
    seen.push(run());
    outer();
    process.stdout.write(JSON.stringify(seen));
  `;
  // `os.tmpdir()` reads TEMP/TMP once the child reports `win32`.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TEMP: tmpdir(),
    TMP: tmpdir(),
  };
  delete env.NODE_OPTIONS;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    {
      encoding: 'utf8',
      env,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['outer', 'inner', 'outer']);
});
