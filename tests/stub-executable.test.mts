import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const before = new Set(readdirSync(tmpdir()));
  const restore = stubExecutable('gh', "process.stdout.write('x');\n");
  const createdEntry = readdirSync(tmpdir()).find(
    (entry) => entry.startsWith('idd-stub-gh-') && !before.has(entry),
  );
  assert.ok(
    createdEntry,
    'stubExecutable should create an idd-stub-gh-* temp directory',
  );
  const createdPath = join(tmpdir(), createdEntry as string);
  assert.ok(existsSync(createdPath));
  restore();
  assert.equal(existsSync(createdPath), false);
});
