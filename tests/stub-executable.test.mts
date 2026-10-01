import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  type RmOptions,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import {
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
