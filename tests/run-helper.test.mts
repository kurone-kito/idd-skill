import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
// A raw filesystem path is not a valid ESM import specifier on Windows
// (backslashes) -- generated fixture wrappers below import via this
// `file:` URL form instead (Copilot review finding), never the bare path.
const RUN_HELPER_MJS_URL = pathToFileURL(RUN_HELPER_MJS).href;
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
 * Always removes its scratch directory on the way out, success or failure
 * (Copilot review finding on an earlier revision of this suite: the
 * directory was never cleaned up, leaking one per test run under the OS
 * temp folder).
 */
function spawnFixture(
  fixtureBody: string,
  args: readonly string[] = [],
): SpawnCapture {
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-run-helper-fixture-'));
  try {
    const fixturePath = join(tempRoot, 'fixture.mjs');
    writeFileSync(fixturePath, fixtureBody);
    const wrapperPath = join(tempRoot, 'wrapper.mjs');
    writeFileSync(
      wrapperPath,
      `import { runHelper } from ${JSON.stringify(RUN_HELPER_MJS_URL)};\nrunHelper(${JSON.stringify(fixturePath)});\n`,
    );
    return spawnCapture(wrapperPath, args);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
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

test('bin/idd-branch-name.mjs: a stray positional whose value contains an embedded newline is preserved in full, not truncated at the first line (chatgpt-codex-connector review finding)', () => {
  const result = spawnCapture(BRANCH_NAME_BIN, ['foo\nbar']);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.split('\n')[0], 'unknown argument: foo');
  // The full token, including the embedded newline, is on the stream --
  // this is what the earlier `.`-based (non-dotAll) line regex silently
  // dropped.
  assert.match(result.stderr, /^unknown argument: foo\nbar\nUsage:\n/);
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

test('runHelper(): a moderately large unrelated error message is not truncated within the documented ceiling', () => {
  // 48 KiB stays safely clear of the ~146 KiB ceiling Node's own
  // uncaught-exception write to a piped stderr is empirically capped at
  // (see the design comment in src/bin/run-helper.mts) -- realistic for
  // any diagnostic this repository's helpers actually produce. The far
  // larger, multi-hundred-KiB case this suite previously asserted against
  // is a disclosed, accepted limitation of the pipe-based redesign (traded
  // for live streaming and no tmpdir dependency, both of which are
  // required by real current behavior -- see the two run-helper.test.mts
  // tests below), not something this suite still guards.
  const payloadSize = 48 * 1024;
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

test('runHelper(): does not require a writable temp directory for an ordinary invocation (regression test for a pipe-only redesign -- a prior temp-file-based capture made every invocation, including this one, hard-depend on os.tmpdir())', () => {
  const result = spawnSync(
    process.execPath,
    [BRANCH_NAME_BIN, '--number', '42', '--title', 'foo'],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, TMPDIR: '/definitely/missing/idd-temp' },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'issue/42-foo\n');
});

test("runHelper(): a long-running helper's stderr streams live, not buffered until exit (regression test for idd-doctor's emitCleanupBacklogProgress UX)", async () => {
  // Two lines a full second apart, well past the 200ms grace window --
  // if streaming is broken (buffered until the child exits), both lines
  // arrive in the same burst at the very end; if it works, the first line
  // arrives promptly and the second only after the sleep.
  const fixtureBody = [
    "process.stderr.write('first\\n');",
    'await new Promise((r) => setTimeout(r, 1000));',
    "process.stderr.write('second\\n');",
  ].join('\n');
  const tempRoot = mkdtempSync(join(tmpdir(), 'idd-run-helper-fixture-'));
  try {
    const fixturePath = join(tempRoot, 'fixture.mjs');
    writeFileSync(fixturePath, fixtureBody);
    const wrapperPath = join(tempRoot, 'wrapper.mjs');
    writeFileSync(
      wrapperPath,
      `import { runHelper } from ${JSON.stringify(RUN_HELPER_MJS_URL)};\nrunHelper(${JSON.stringify(fixturePath)});\n`,
    );

    const child = spawn(process.execPath, [wrapperPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let firstLineAt: number | null = null;
    const start = Date.now();
    // Accumulate into a persistent buffer and search that, rather than
    // testing each chunk in isolation (Copilot review finding): stream
    // chunk boundaries are arbitrary, so "first" is not guaranteed to
    // land wholly within a single 'data' event even though the fixture
    // writes it in one process.stderr.write() call.
    let seenSoFar = '';
    child.stderr.on('data', (chunk: Buffer) => {
      seenSoFar += chunk.toString('utf8');
      if (firstLineAt === null && seenSoFar.includes('first')) {
        firstLineAt = Date.now() - start;
      }
    });
    let closeAt: number | null = null;
    await new Promise<void>((resolvePromise, reject) => {
      child.on('close', () => {
        closeAt = Date.now() - start;
        resolvePromise();
      });
      child.on('error', reject);
    });

    // assert.ok (unlike assert.notEqual) is a recognized TypeScript
    // assertion signature, narrowing both timestamps to `number` for the
    // gap check below.
    assert.ok(firstLineAt !== null, 'expected the first line to arrive');
    assert.ok(closeAt !== null, 'expected the child to close');
    // Measure the GAP between the first line arriving and the child
    // closing, not an absolute wall-clock bound from spawn -- an absolute
    // bound also counts two nested Node process boots (this test's own
    // wrapper, then runHelper's spawned fixture) before the fixture's
    // first line is even written, which a loaded CI runner can push past
    // any reasonable fixed threshold on its own, independent of whether
    // streaming actually works (chatgpt-codex-connector review finding on
    // an earlier revision of this test: observed 532-582ms real CI
    // latency against a naive 500ms bound, flaking a test proving a
    // behavior that was in fact working). The gap check is immune to that
    // startup latency: if streaming were broken (buffered until exit),
    // the first line and the close would arrive together and the gap
    // would be near zero regardless of how long startup took; a large gap
    // is only possible if the first line really did arrive while the
    // child was still running its ~1000ms sleep.
    const gapMs = closeAt - firstLineAt;
    assert.ok(
      gapMs > 700,
      `expected a gap of well over 700ms between the first line and child close (the fixture sleeps ~1000ms in between), got ${gapMs}ms`,
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('runHelper(): a shaped-looking error thrown after the grace window has elapsed streams live with its raw trace, not intercepted (documented design boundary, not an oversight)', () => {
  const fixtureBody = [
    "process.stderr.write('warming up\\n');",
    'await new Promise((r) => setTimeout(r, 500));',
    "throw new Error('unknown argument: --late');",
  ].join('\n');
  const result = spawnFixture(fixtureBody);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^warming up$/m);
  // The raw trace streamed live -- it is NOT collapsed to the shaped
  // one-liner the way an immediate (within-window) throw would be.
  assert.match(result.stderr, /^Error: unknown argument: --late/m);
  assert.match(result.stderr, /\n\s+at /);
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
