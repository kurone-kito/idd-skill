import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  GH_TEXT_LOOP_OPTIONS,
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghApiJson,
  ghText,
  safeGhText,
  withBoundedRetry,
} from '../src/scripts/gh-exec.mts';

// Stub `gh` on PATH (the discover-roadmap-graph.test.mts / post-idd-marker.test.mts
// pattern) so every scenario below exercises the real execFileSync + child-process
// contract without network access. Returns a cleanup callback that restores PATH;
// callers must invoke it (ideally in a `finally`) even when the assertion throws.
function stubGh(scriptBody: string): () => void {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const ghPath = join(tempRoot, 'gh');
  writeFileSync(ghPath, `#!/usr/bin/env node\n${scriptBody}`);
  chmodSync(ghPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${tempRoot}:${originalPath ?? ''}`;
  return () => {
    process.env.PATH = originalPath;
  };
}

test('ghText trims stdout and forwards argv to gh', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('  hello world  \\n');
`);
  try {
    const result = ghText(['repo', 'view', '--json', 'name']);
    assert.equal(result, 'hello world');
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

test('ghText accepts a stdio override without changing the trimmed result', () => {
  const restore = stubGh(`process.stdout.write('  ok  \\n');`);
  try {
    const result = ghText(['repo', 'view'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(result, 'ok');
  } finally {
    restore();
  }
});

test('ghText throws on a non-zero gh exit', () => {
  const restore = stubGh(`
process.stderr.write('boom');
process.exit(1);
`);
  try {
    assert.throws(() => ghText(['repo', 'view']));
  } finally {
    restore();
  }
});

test('ghText forwards a timeout override and still returns the trimmed result when gh finishes in time', () => {
  const restore = stubGh(`process.stdout.write('  fast  \\n');`);
  try {
    assert.equal(ghText(['repo', 'view'], { timeout: 30_000 }), 'fast');
  } finally {
    restore();
  }
});

test('ghText times out (throws) when gh exceeds the configured timeout', () => {
  const restore = stubGh(`
// Block synchronously well past the configured timeout so execFileSync's
// own timeout enforcement kills this process before it can exit cleanly.
const start = Date.now();
while (Date.now() - start < 2000) {
  // busy-wait
}
process.stdout.write('too slow');
`);
  try {
    assert.throws(() => ghText(['repo', 'view'], { timeout: 50 }));
  } finally {
    restore();
  }
});

test('GH_TEXT_LOOP_OPTIONS and GH_TEXT_LOOP_TIMEOUT_OPTIONS both ignore stdin', () => {
  const restore = stubGh(`process.stdout.write('  loop-safe  \\n');`);
  try {
    assert.equal(ghText(['repo', 'view'], GH_TEXT_LOOP_OPTIONS), 'loop-safe');
    assert.equal(
      ghText(['repo', 'view'], GH_TEXT_LOOP_TIMEOUT_OPTIONS),
      'loop-safe',
    );
    assert.deepEqual(GH_TEXT_LOOP_OPTIONS.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(GH_TEXT_LOOP_TIMEOUT_OPTIONS.timeout, 30_000);
  } finally {
    restore();
  }
});

test('safeGhText returns the trimmed value on success', () => {
  const restore = stubGh(`process.stdout.write('fine\\n');`);
  try {
    assert.equal(safeGhText(['repo', 'view']), 'fine');
  } finally {
    restore();
  }
});

test('safeGhText forwards its options argument to ghText', () => {
  const restore = stubGh(`process.stdout.write('  loop-safe  \\n');`);
  try {
    assert.equal(
      safeGhText(['repo', 'view'], GH_TEXT_LOOP_OPTIONS),
      'loop-safe',
    );
  } finally {
    restore();
  }
});

test('safeGhText swallows a gh failure and returns an empty string', () => {
  const restore = stubGh(`process.exit(1);`);
  try {
    assert.equal(safeGhText(['repo', 'view']), '');
  } finally {
    restore();
  }
});

test('ghApiJson (non-paginated) parses the raw JSON object', () => {
  const restore = stubGh(`process.stdout.write(JSON.stringify({ id: 42 }));`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1'), { id: 42 });
  } finally {
    restore();
  }
});

test('ghApiJson (non-paginated) falls back to {} on empty stdout', () => {
  const restore = stubGh(`process.stdout.write('');`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1'), {});
  } finally {
    restore();
  }
});

test('ghApiJson forwards extraArgs after the API path', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{}');
`);
  try {
    ghApiJson('repos/o/r/issues/1', { extraArgs: ['--jq', '.title'] });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'repos/o/r/issues/1',
      '--jq',
      '.title',
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) parses NDJSON output, flattening array lines', () => {
  const restore = stubGh(`
process.stdout.write([JSON.stringify([{ id: 1 }, { id: 2 }]), JSON.stringify({ id: 3 })].join('\\n'));
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) forwards --paginate --jq .[] and returns [] on empty output', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('');
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), []);
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'repos/o/r/issues',
      '--paginate',
      '--jq',
      '.[]',
    ]);
  } finally {
    restore();
  }
});

test('ghApiJson tolerates an allow-listed failure status and parses its stdout', () => {
  const restore = stubGh(`
process.stdout.write(JSON.stringify({ tolerated: true }));
process.exit(1);
`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }), {
      tolerated: true,
    });
  } finally {
    restore();
  }
});

test('ghApiJson rethrows a failure status that is not in allowStatuses', () => {
  const restore = stubGh(`
process.stdout.write(JSON.stringify({ tolerated: true }));
process.exit(2);
`);
  try {
    assert.throws(() =>
      ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }),
    );
  } finally {
    restore();
  }
});

test('ghApiJson rethrows an allow-listed failure whose stdout is not JSON-shaped', () => {
  const restore = stubGh(`
process.stdout.write('not json');
process.exit(1);
`);
  try {
    assert.throws(() =>
      ghApiJson('repos/o/r/issues/1', { allowStatuses: [1] }),
    );
  } finally {
    restore();
  }
});

test('withBoundedRetry succeeds after transient failures within the attempt budget', async () => {
  let calls = 0;
  const result = await withBoundedRetry(
    async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error(`transient failure ${calls}`);
      }
      return 'ok';
    },
    { baseDelayMs: 1 },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withBoundedRetry rethrows immediately, without retrying, when isRetryable returns false', async () => {
  let calls = 0;
  const thrown = new Error('not retryable');
  let caught: unknown;
  try {
    await withBoundedRetry(
      async () => {
        calls += 1;
        throw thrown;
      },
      { baseDelayMs: 1, isRetryable: () => false },
    );
    assert.fail('expected withBoundedRetry to reject');
  } catch (error) {
    caught = error;
  }
  // Same instance, never re-wrapped, and called exactly once (no wasted
  // attempt or backoff wait once isRetryable says no).
  assert.equal(caught, thrown);
  assert.equal(calls, 1);
});

test('withBoundedRetry exhausts bounded attempts and rethrows the final error unchanged', async () => {
  let calls = 0;
  let lastError: Error | undefined;
  let caught: unknown;
  try {
    await withBoundedRetry(
      async () => {
        calls += 1;
        lastError = new Error(`persistent failure ${calls}`);
        throw lastError;
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    assert.fail('expected withBoundedRetry to reject');
  } catch (error) {
    caught = error;
  }
  // Bounded to exactly `attempts` tries, and the rethrown error is the same
  // instance the final attempt threw (fail-closed, never re-wrapped).
  assert.equal(calls, 3);
  assert.equal(caught, lastError);
});

test('withBoundedRetry falls back to the default attempt bound on a non-finite attempts value (#1394 Copilot + Codex review)', async () => {
  for (const nonFiniteAttempts of [Number.NaN, Number.POSITIVE_INFINITY]) {
    let calls = 0;
    let caught: unknown;
    try {
      await withBoundedRetry(
        async () => {
          calls += 1;
          throw new Error(`persistent failure ${calls}`);
        },
        { attempts: nonFiniteAttempts, baseDelayMs: 1 },
      );
      assert.fail('expected withBoundedRetry to reject');
    } catch (error) {
      caught = error;
    }
    // Without the Number.isFinite guard, `Math.max(1, Math.trunc(NaN))` is
    // `NaN` and `Math.max(1, Math.trunc(Infinity))` is `Infinity`; either
    // way `attempt >= totalAttempts` is never true, so the loop never
    // terminates. Asserting a bounded call count (the default of 3, not an
    // unbounded count) is the actual regression check.
    assert.ok(caught instanceof Error);
    assert.equal(calls, 3);
  }
});

test('withBoundedRetry falls back to the default backoff on a non-finite baseDelayMs value', async () => {
  let calls = 0;
  const result = await withBoundedRetry(
    async () => {
      calls += 1;
      if (calls < 2) {
        throw new Error('transient failure');
      }
      return 'ok';
    },
    { baseDelayMs: Number.NaN },
  );
  // A non-finite baseDelayMs cannot hang the suite (setTimeout would clamp
  // it), but should not silently disable backoff either; this only proves
  // the call still completes and resolves normally under the fallback.
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});
