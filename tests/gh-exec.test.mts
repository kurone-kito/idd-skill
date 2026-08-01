import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  DEFAULT_GH_TIMEOUT_MS,
  GH_TEXT_LOOP_OPTIONS,
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghApiJson,
  ghText,
  ghTextAsync,
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

test('DEFAULT_GH_TIMEOUT_MS and DEFAULT_GH_PAGINATED_TIMEOUT_MS match the documented 30s/120s convention', () => {
  assert.equal(DEFAULT_GH_TIMEOUT_MS, 30_000);
  assert.equal(DEFAULT_GH_PAGINATED_TIMEOUT_MS, 120_000);
});

test('ghText succeeds under the default timeout when the caller supplies none (#1675)', () => {
  const restore = stubGh(`process.stdout.write('  under-default  \\n');`);
  try {
    assert.equal(ghText(['repo', 'view']), 'under-default');
  } finally {
    restore();
  }
});

test('ghText forwards an input option to the child process stdin (#1675)', () => {
  const restore = stubGh(`
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  process.stdout.write(Buffer.concat(chunks).toString('utf8'));
});
`);
  try {
    const result = ghText(['api', '--input', '-'], {
      input: JSON.stringify({ body: 'hello' }),
    });
    assert.deepEqual(JSON.parse(result), { body: 'hello' });
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

test('ghApiJson (non-paginated) forwards an explicit timeout override and throws when gh exceeds it (#1675)', () => {
  const restore = stubGh(`
const start = Date.now();
while (Date.now() - start < 2000) {
  // busy-wait
}
process.stdout.write('{}');
`);
  try {
    assert.throws(() => ghApiJson('repos/o/r/issues/1', { timeout: 50 }));
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) forwards an explicit timeout override and throws when gh exceeds it (#1675)', () => {
  const restore = stubGh(`
const start = Date.now();
while (Date.now() - start < 2000) {
  // busy-wait
}
process.stdout.write('[]');
`);
  try {
    assert.throws(() =>
      ghApiJson('repos/o/r/issues', { paginate: true, timeout: 50 }),
    );
  } finally {
    restore();
  }
});

test('ghApiJson (non-paginated) succeeds under the default timeout when the caller supplies none (#1675)', () => {
  const restore = stubGh(`process.stdout.write(JSON.stringify({ ok: true }));`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues/1'), { ok: true });
  } finally {
    restore();
  }
});

test('ghApiJson (paginated) succeeds under the default paginated timeout when the caller supplies none (#1675)', () => {
  const restore = stubGh(`process.stdout.write(JSON.stringify({ id: 1 }));`);
  try {
    assert.deepEqual(ghApiJson('repos/o/r/issues', { paginate: true }), [
      { id: 1 },
    ]);
  } finally {
    restore();
  }
});

test('ghTextAsync trims stdout and forwards argv to gh', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('  hello async  \\n');
`);
  try {
    const result = await ghTextAsync(['repo', 'view', '--json', 'name']);
    assert.equal(result, 'hello async');
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

test('ghTextAsync throws on a non-zero gh exit', async () => {
  const restore = stubGh(`
process.stderr.write('boom');
process.exit(1);
`);
  try {
    await assert.rejects(() => ghTextAsync(['repo', 'view']));
  } finally {
    restore();
  }
});

test('ghTextAsync succeeds under the default timeout when the caller supplies none (#1675)', async () => {
  const restore = stubGh(`process.stdout.write('  fast-async  \\n');`);
  try {
    assert.equal(await ghTextAsync(['repo', 'view']), 'fast-async');
  } finally {
    restore();
  }
});

test('ghTextAsync forwards a timeout override and rejects when gh exceeds it', async () => {
  const restore = stubGh(`
const start = Date.now();
while (Date.now() - start < 2000) {
  // busy-wait
}
process.stdout.write('too slow');
`);
  try {
    await assert.rejects(() => ghTextAsync(['repo', 'view'], { timeout: 50 }));
  } finally {
    restore();
  }
});

test('ghTextAsync throws when stdout exceeds the default maxBuffer', async () => {
  const restore = stubGh(`process.stdout.write('x'.repeat(2 * 1024 * 1024));`);
  try {
    await assert.rejects(() => ghTextAsync(['repo', 'view']));
  } finally {
    restore();
  }
});

test('ghTextAsync forwards a maxBuffer override to tolerate larger output', async () => {
  const restore = stubGh(`process.stdout.write('x'.repeat(2 * 1024 * 1024));`);
  try {
    const result = await ghTextAsync(['repo', 'view'], {
      maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.length, 2 * 1024 * 1024);
  } finally {
    restore();
  }
});

test('ghTextAsync preserves an explicit maxBuffer: 0 instead of silently falling back to execFile default (#1784 CodeRabbit review)', async () => {
  const restore = stubGh(`process.stdout.write('a');`);
  try {
    // A single byte of stdout already exceeds maxBuffer: 0. If the option
    // construction used a truthy check (`options.maxBuffer ? … : {}`) rather
    // than `!== undefined`, an explicit 0 would be dropped and execFile's own
    // 1 MiB default would silently apply instead, making this resolve
    // instead of reject.
    await assert.rejects(() => ghTextAsync(['repo', 'view'], { maxBuffer: 0 }));
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
