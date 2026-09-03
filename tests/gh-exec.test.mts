import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  combineOwnerRepoFlags,
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  DEFAULT_GH_TIMEOUT_MS,
  GH_TEXT_LOOP_OPTIONS,
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghApiJson,
  ghGraphql,
  ghText,
  ghTextAsync,
  resolveGhApiHostname,
  resolveViewerLogin,
  safeGhText,
  viewerLoginFailureIsGraphqlEligible,
  withBoundedRetry,
} from '../src/scripts/gh-exec.mts';

/**
 * Save/restore `GH_HOST` and `GITHUB_SERVER_URL` around a test body (the
 * `stubGh`/`process.env.PATH` pattern already used below) so a test that
 * sets either variable can never leak into a later test -- both matter
 * because CI itself defines `GITHUB_SERVER_URL=https://github.com` in the
 * runner environment (#1962).
 */
function withGhHostEnv(
  overrides: { GH_HOST?: string; GITHUB_SERVER_URL?: string },
  run: () => void,
): void {
  const originalGhHost = process.env.GH_HOST;
  const originalServerUrl = process.env.GITHUB_SERVER_URL;
  if (overrides.GH_HOST === undefined) {
    delete process.env.GH_HOST;
  } else {
    process.env.GH_HOST = overrides.GH_HOST;
  }
  if (overrides.GITHUB_SERVER_URL === undefined) {
    delete process.env.GITHUB_SERVER_URL;
  } else {
    process.env.GITHUB_SERVER_URL = overrides.GITHUB_SERVER_URL;
  }
  try {
    run();
  } finally {
    if (originalGhHost === undefined) {
      delete process.env.GH_HOST;
    } else {
      process.env.GH_HOST = originalGhHost;
    }
    if (originalServerUrl === undefined) {
      delete process.env.GITHUB_SERVER_URL;
    } else {
      process.env.GITHUB_SERVER_URL = originalServerUrl;
    }
  }
}

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

test('resolveGhApiHostname returns undefined with no GH_HOST / GITHUB_SERVER_URL signal', () => {
  withGhHostEnv({}, () => {
    assert.equal(resolveGhApiHostname(), undefined);
  });
});

test('resolveGhApiHostname returns undefined when GH_HOST is set, even alongside a GHES GITHUB_SERVER_URL (#1962)', () => {
  withGhHostEnv(
    {
      GH_HOST: 'ghes.example.com',
      GITHUB_SERVER_URL: 'https://other-ghes.example.com',
    },
    () => {
      // gh already reads GH_HOST itself; a --hostname override here would
      // be redundant at best and could disagree with an operator's
      // explicit choice at worst.
      assert.equal(resolveGhApiHostname(), undefined);
    },
  );
});

test('resolveGhApiHostname returns undefined for GITHUB_SERVER_URL=https://github.com (no behavior change on github.com, #1962)', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://github.com' }, () => {
    assert.equal(resolveGhApiHostname(), undefined);
  });
});

test('resolveGhApiHostname strips scheme and trailing slash for a GHES GITHUB_SERVER_URL (#1962)', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com/' }, () => {
    assert.equal(resolveGhApiHostname(), 'ghes.example.com');
  });
});

test('resolveGhApiHostname lowercases a mixed-case GHES host and tolerates http scheme (#1962)', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: 'http://GHES.Example.com' }, () => {
    assert.equal(resolveGhApiHostname(), 'ghes.example.com');
  });
});

test('resolveGhApiHostname returns undefined for an empty GITHUB_SERVER_URL', () => {
  withGhHostEnv({ GITHUB_SERVER_URL: '' }, () => {
    assert.equal(resolveGhApiHostname(), undefined);
  });
});

test('ghApiJson adds --hostname before extraArgs on a GHES GITHUB_SERVER_URL, and never on github.com (#1962)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{}');
`);
  try {
    withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com' }, () => {
      ghApiJson('repos/o/r/issues/1', { extraArgs: ['--jq', '.title'] });
    });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'repos/o/r/issues/1',
      '--hostname',
      'ghes.example.com',
      '--jq',
      '.title',
    ]);
    withGhHostEnv({ GITHUB_SERVER_URL: 'https://github.com' }, () => {
      ghApiJson('repos/o/r/issues/1', { extraArgs: ['--jq', '.title'] });
    });
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

test('ghGraphql adds --hostname before -f query on a GHES GITHUB_SERVER_URL, and never on github.com (#1962)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-gh-exec-test-'));
  const argsFile = join(tempRoot, 'args.json');
  const restore = stubGh(`
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write('{}');
`);
  try {
    withGhHostEnv({ GITHUB_SERVER_URL: 'https://ghes.example.com' }, () => {
      ghGraphql('query { viewer { login } }', {});
    });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'graphql',
      '--hostname',
      'ghes.example.com',
      '-f',
      'query=query { viewer { login } }',
    ]);
    withGhHostEnv({ GITHUB_SERVER_URL: 'https://github.com' }, () => {
      ghGraphql('query { viewer { login } }', {});
    });
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
      'api',
      'graphql',
      '-f',
      'query=query { viewer { login } }',
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

// #1449: ghTextAsync was swapped from a hand-rolled `spawn` (explicit
// `stdio: ['ignore', 'pipe', 'pipe']`) to `promisify(execFile)`, which has
// no `stdio` option and does not close the child's stdin by default. The
// runner now calls `run.child.stdin?.end()` immediately to reproduce the
// old ignore behavior. This `gh` stub actively reads stdin to EOF before
// responding — exactly the shape that hung under plain `execFile` in local
// verification — so a regression of the stdin-close fix would hang this
// test. Race against a short timeout so a regression fails fast with a
// clear message instead of hanging the whole suite. Moved here from
// discover-roadmap-graph.test.mts (#2266): this is ghTextAsync's own
// contract, not that file's, and it kept working through buildIssueLoader
// only indirectly.
test('ghTextAsync closes the child stdin so a stdin-reading gh stub cannot hang it (#1449)', async () => {
  const restore = stubGh(`
// Synchronous fd-0 read blocks this process until stdin sees EOF --
// instantly if the runner closed it (the fix), indefinitely if not (the
// regression this test guards against). A synchronous read is required
// here: an async 'data'/'end' listener would return control to this
// stub's own top-level script immediately, before EOF ever arrives.
const stdinBytes = require('node:fs').readFileSync(0).length;
process.stdout.write(JSON.stringify({ stdinBytesSeen: stdinBytes }));
`);
  // Captured so the finally block can clear it: an uncleared timer keeps
  // the event loop alive for the rest of the 3s window even after the gh
  // call already resolved (Copilot review, #1463).
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise((_resolve, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(
              'timed out: gh stub never saw stdin EOF — stdin.end() regression',
            ),
          ),
        3000,
      );
      timeoutHandle.unref();
    });
    const result = await Promise.race([ghTextAsync(['repo', 'view']), timeout]);
    assert.deepEqual(JSON.parse(result as string), { stdinBytesSeen: 0 });
  } finally {
    clearTimeout(timeoutHandle);
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

test('resolveViewerLogin uses REST /user when it returns a login', () => {
  let graphqlCalls = 0;
  const login = resolveViewerLogin(
    {},
    {
      rest: () => ' kurone-kito ',
      graphql: () => {
        graphqlCalls += 1;
        return 'graphql-user';
      },
    },
  );
  assert.equal(login, 'kurone-kito');
  assert.equal(graphqlCalls, 0);
});

test('resolveViewerLogin falls back to GraphQL viewer after REST 503', () => {
  const restError = Object.assign(new Error('HTTP 503'), {
    stderr: 'gh: Service Unavailable (HTTP 503)',
  });
  const login = resolveViewerLogin(
    {},
    {
      rest: () => {
        throw restError;
      },
      graphql: () => 'graphql-user',
    },
  );
  assert.equal(login, 'graphql-user');
});

test('resolveViewerLogin falls back to GraphQL when REST returns an empty body', () => {
  const login = resolveViewerLogin(
    {},
    {
      rest: () => '',
      graphql: () => 'graphql-user',
    },
  );
  assert.equal(login, 'graphql-user');
});

test('resolveViewerLogin does not fall back on REST 403', () => {
  const restError = Object.assign(new Error('HTTP 403'), {
    stderr: 'gh: Resource not accessible by integration (HTTP 403)',
  });
  assert.equal(viewerLoginFailureIsGraphqlEligible(restError), false);
  assert.throws(
    () =>
      resolveViewerLogin(
        {},
        {
          rest: () => {
            throw restError;
          },
          graphql: () => 'graphql-user',
        },
      ),
    restError,
  );
});

test('resolveViewerLogin rethrows the REST error when GraphQL also fails after 503', () => {
  const restError = Object.assign(new Error('HTTP 503'), {
    stderr: 'gh: Service Unavailable (HTTP 503)',
  });
  assert.throws(
    () =>
      resolveViewerLogin(
        {},
        {
          rest: () => {
            throw restError;
          },
          graphql: () => {
            throw new Error('graphql down');
          },
        },
      ),
    restError,
  );
});

test('viewerLoginFailureIsGraphqlEligible treats timeout as eligible', () => {
  assert.equal(
    viewerLoginFailureIsGraphqlEligible(
      Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    ),
    true,
  );
});

test('viewerLoginFailureIsGraphqlEligible treats unclassified errors as fail-closed', () => {
  assert.equal(
    viewerLoginFailureIsGraphqlEligible(new Error('something went wrong')),
    false,
  );
});

test('resolveViewerLogin does not fall back on an unclassified REST error', () => {
  const restError = new Error('gh: mysterious failure');
  assert.throws(
    () =>
      resolveViewerLogin(
        {},
        {
          rest: () => {
            throw restError;
          },
          graphql: () => 'graphql-user',
        },
      ),
    restError,
  );
});

test('resolveViewerLogin live seam: REST 503 then GraphQL viewer login', () => {
  const restore = stubGh(`
const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'user') {
  process.stderr.write('gh: Service Unavailable (HTTP 503)\\n');
  process.exit(1);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  process.stdout.write(JSON.stringify({ data: { viewer: { login: 'graphql-user' } } }) + '\\n');
  process.exit(0);
}
process.stderr.write('unexpected: ' + args.join(' ') + '\\n');
process.exit(1);
`);
  try {
    assert.equal(resolveViewerLogin(), 'graphql-user');
  } finally {
    restore();
  }
});

// #2454: combineOwnerRepoFlags lets the five combined-only scripts also
// accept the majority's split --owner/--repo form without changing their
// own downstream parser/default-resolution pipeline -- it only folds a
// split pair into the single combined string that pipeline already
// consumes unchanged.
test('combineOwnerRepoFlags: neither flag given returns repo unchanged (undefined)', () => {
  assert.equal(combineOwnerRepoFlags({}), undefined);
});

test('combineOwnerRepoFlags: neither flag given returns repo unchanged (empty-string default)', () => {
  // Mirrors token-cost-harvest.mts / local-validation-evidence.mts /
  // provider-outage-declaration.mts's own `{ type: 'string', default: '' }`
  // CLI spec -- their existing "neither given" behavior (a required-flag
  // error, or a gh-view fallback) must see this same empty string.
  assert.equal(combineOwnerRepoFlags({ repo: '' }), '');
});

test('combineOwnerRepoFlags: combined form (--repo owner/name alone) is returned unchanged', () => {
  assert.equal(
    combineOwnerRepoFlags({ repo: 'kurone-kito/idd-skill' }),
    'kurone-kito/idd-skill',
  );
});

test('combineOwnerRepoFlags: split form (--owner + bare --repo) combines into owner/name', () => {
  assert.equal(
    combineOwnerRepoFlags({ owner: 'kurone-kito', repo: 'idd-skill' }),
    'kurone-kito/idd-skill',
  );
});

test('combineOwnerRepoFlags: --owner with a slash-containing --repo throws a specific conflict error', () => {
  assert.throws(
    () =>
      combineOwnerRepoFlags({
        owner: 'kurone-kito',
        repo: 'kurone-kito/idd-skill',
      }),
    /--owner and a combined --repo "kurone-kito\/idd-skill" conflict/,
  );
});

test('combineOwnerRepoFlags: --owner without --repo throws (an owner alone cannot resolve a repository)', () => {
  assert.throws(
    () => combineOwnerRepoFlags({ owner: 'kurone-kito' }),
    /--owner requires --repo <name>/,
  );
});

test('combineOwnerRepoFlags: --owner with an empty-string --repo throws the same missing-repo error', () => {
  assert.throws(
    () => combineOwnerRepoFlags({ owner: 'kurone-kito', repo: '' }),
    /--owner requires --repo <name>/,
  );
});
