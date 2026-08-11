import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// #1922 — bin/run-helper.mts intercepts a shaped CLI parse error across the
// child-process spawn boundary and prints only the clean one-line message
// (plus, best-effort, the failing script's own --help usage text) instead of
// letting Node's default uncaught-exception handler dump a full raw stack
// trace. Every other error class must keep its stack trace untouched.
//
// Two coverage strategies:
// - Real fleet members (bin/idd-branch-name.mjs, bin/idd-review-disposition-
//   verify.mjs): exercise the actual compiled artifacts end to end,
//   mirroring tests/cli-entry-smoke.test.mts's shelling-out convention.
// - Synthetic fixture scripts spawned through a temp wrapper that imports
//   the real runHelper() (resolve()'s absolute-path short-circuit lets an
//   absolute fixture path stand in for the normally-relative
//   relativeScriptPath argument) — used for cases the real fleet can't
//   easily exercise, such as confirming a *successful* run's stderr output
//   (e.g. idd-doctor's streamed progress) is never dropped.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const RUN_HELPER_MJS = join(REPO_ROOT, 'bin', 'run-helper.mjs');
const BRANCH_NAME_BIN = join(REPO_ROOT, 'bin', 'idd-branch-name.mjs');
const REVIEW_DISPOSITION_VERIFY_BIN = join(
  REPO_ROOT,
  'bin',
  'idd-review-disposition-verify.mjs',
);

interface SpawnCapture {
  stdout: string;
  stderr: string;
  status: number | null;
}

/**
 * Spawn `binPath` with `args`, capturing stdout/stderr/exit status either
 * way. Uses `spawnSync` (not `execFileSync`) specifically because
 * `execFileSync` only returns stdout on a zero exit and discards stderr
 * entirely in that case -- this suite needs stderr on the success path too
 * (e.g. confirming idd-doctor-style streamed progress isn't dropped).
 */
function spawnCapture(
  binPath: string,
  args: readonly string[] = [],
): SpawnCapture {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Write `fixtureBody` as a throwaway script and a wrapper that invokes the
 * real `runHelper()` against it (via an absolute path, which `resolve()`
 * returns unchanged regardless of the `relativeScriptPath` name), then spawn
 * the wrapper and capture the result -- exercises the real interception
 * logic without needing a permanent bin/*.mjs entry for a synthetic case.
 */
function spawnFixture(
  fixtureBody: string,
  args: readonly string[] = [],
): SpawnCapture {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-run-helper-fixture-'));
  const fixturePath = join(tempRoot, 'fixture.mjs');
  writeFileSync(fixturePath, fixtureBody);
  const wrapperPath = join(tempRoot, 'wrapper.mjs');
  writeFileSync(
    wrapperPath,
    `import { runHelper } from ${JSON.stringify(RUN_HELPER_MJS)};\nrunHelper(${JSON.stringify(fixturePath)});\n`,
  );
  return spawnCapture(wrapperPath, args);
}

// --- Real fleet member: bin/idd-branch-name.mjs ------------------------------

test('bin/idd-branch-name.mjs: an unknown flag prints only the shaped one-line message, no stack frames, and exits non-zero', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['--bogus-flag', 'foo']);
  assert.notEqual(result.status, 0);
  const firstLine = result.stderr.split('\n')[0];
  assert.equal(firstLine, 'unknown argument: --bogus-flag');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.doesNotMatch(result.stderr, /ReferenceError/);
});

test('bin/idd-branch-name.mjs: a missing value for a declared flag prints only the shaped message', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['--number']);
  assert.notEqual(result.status, 0);
  const firstLine = result.stderr.split('\n')[0];
  assert.equal(firstLine, 'missing value for argument: --number');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

test("bin/idd-branch-name.mjs: the shaped message is followed by the script's own usage line", () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['--bogus-flag']);
  assert.match(result.stderr, /^unknown argument: --bogus-flag\nUsage:\n/);
});

test('bin/idd-branch-name.mjs: an unrelated error (missing required --number) keeps its stack trace intact', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['--title', 'foo']);
  assert.notEqual(result.status, 0);
  // Node's own uncaught-exception rendering prints a source-line preview
  // before the "Error: " line itself, so this is a plain substring/`m`-flag
  // check, not an anchor on the very first byte of the stream (unlike the
  // shaped-error cases above, where run-helper.mts's own output IS exactly
  // that first line).
  assert.match(result.stderr, /^Error: --number is required/m);
  assert.match(result.stderr, /\n\s+at /);
});

test('bin/idd-branch-name.mjs: --help is unchanged -- still exits 0 and prints usage', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:\n {2}node scripts\/branch-name\.mjs/);
});

test('bin/idd-branch-name.mjs: a normal successful run is unaffected (stdout intact, exit 0)', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, [
    '--number',
    '42',
    '--title',
    'Add the OAuth login flow',
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'issue/42-add-oauth-login-flow\n');
});

// #1922: the only bin/*.mjs that previously bypassed runHelper() entirely
// (its own hand-rolled spawn/exit/error handling) -- migrated onto
// runHelper() so the shaped-error fix applies uniformly to every packaged
// idd-* CLI command, not just the 33 that already used it.
test('bin/idd-review-disposition-verify.mjs: now goes through runHelper() too -- an unknown flag is shaped, not a raw stack trace', () => {
  const result = spawnCapture(REVIEW_DISPOSITION_VERIFY_BIN, ['--bogus-flag']);
  assert.notEqual(result.status, 0);
  const firstLine = result.stderr.split('\n')[0];
  assert.equal(firstLine, 'unknown argument: --bogus-flag');
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

// --- Synthetic fixtures: cases the real fleet can't easily exercise --------

test("runHelper(): a successful run's stderr output is forwarded unchanged, not dropped", () => {
  // Mirrors idd-doctor's intentional streamed-progress-to-stderr pattern
  // (docs/idd-helper-scripts.md) -- confirms piping stderr for inspection
  // never silently swallows it on the success path.
  const result = spawnFixture(
    "process.stdout.write('known-stdout-line\\n');\nprocess.stderr.write('known-stderr-line\\n');\nprocess.exit(0);\n",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'known-stdout-line\n');
  assert.equal(result.stderr, 'known-stderr-line\n');
});

test('runHelper(): an unrelated thrown error (not one of the three shaped forms) forwards its full stack trace verbatim', () => {
  const result = spawnFixture(
    "throw new Error('totally unrelated failure');\n",
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^Error: totally unrelated failure/m);
  assert.match(result.stderr, /\n\s+at /);
});

test("runHelper(): a large unrelated error message is NOT truncated (regression test -- Node's own uncaught-exception write to a piped stderr silently caps around ~146 KiB; capturing via a temp file instead of a pipe avoids it)", () => {
  // 300 KiB comfortably clears the ~146 KiB ceiling this test guards
  // against while staying under this test harness's own spawnSync
  // maxBuffer (Node's 1 MiB default) for the *outer* capture.
  const payloadSize = 300 * 1024;
  const result = spawnFixture(
    `throw new Error('payload: ' + 'z'.repeat(${payloadSize}));\n`,
  );
  assert.notEqual(result.status, 0);
  // Measure the longest contiguous run of "z" rather than asserting exact
  // byte length -- Node's own uncaught-exception rendering echoes the
  // throwing source line as a preview, which itself contains one isolated
  // "z" (inside the literal `'z'.repeat(...)` call); matching a long run
  // isolates the actual repeated payload from that single stray character.
  const longestRun = (result.stderr.match(/z+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  assert.equal(longestRun, payloadSize);
});

test('runHelper(): a script with no --help support degrades to no usage line, still shaped', () => {
  const result = spawnFixture(
    "throw new Error('unknown argument: --bogus');\n",
    ['--bogus'],
  );
  assert.notEqual(result.status, 0);
  // No --help handling in this fixture -- --help itself would throw
  // "unknown argument: --help", so fetchUsageLine() must see a non-zero
  // exit and silently omit the usage line rather than propagating that
  // secondary failure.
  assert.equal(result.stderr, 'unknown argument: --bogus\n');
});
