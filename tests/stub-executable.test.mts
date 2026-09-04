import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

import { stubExecutable } from './test-utils.mts';

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
