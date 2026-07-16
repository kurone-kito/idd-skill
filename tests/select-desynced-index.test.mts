import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { selectDesyncedIndex } from '../src/scripts/policy-helpers.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/select-desynced-index.mjs');

/** Run the built CLI and return its trimmed stdout. */
function runCli(args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
  }).trim();
}

/** Run the built CLI expecting a non-zero exit, and return its stderr. */
function runCliExpectFailure(args: string[]): {
  status: number;
  stderr: string;
} {
  try {
    execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    throw new Error('expected the CLI to exit non-zero, but it succeeded');
  } catch (error) {
    const status = (error as { status?: number }).status;
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    assert.ok(
      typeof status === 'number' && status !== 0,
      `expected a non-zero exit status, got ${String(status)}`,
    );
    return { status: status as number, stderr };
  }
}

// ---------------------------------------------------------------------------
// Drift guard: CLI output must equal a direct selectDesyncedIndex(...) call
// for the same inputs, so the CLI and the library function can never
// silently diverge. Band-size 1 and the multi-byte token are kept as
// separate cases: band-size 1 short-circuits selectDesyncedIndex before the
// token is ever read, so combining them would never actually exercise the
// FNV-1a hash path for the multi-byte token.
// ---------------------------------------------------------------------------

test('drift: CLI output equals selectDesyncedIndex for an ordinary token and band size', () => {
  const token = 'claude-loop-2';
  const bandSize = 5;
  assert.equal(
    runCli(['--token', token, '--band-size', String(bandSize)]),
    String(selectDesyncedIndex(token, bandSize)),
  );
});

test('drift: CLI output equals selectDesyncedIndex for band-size 1 (always 0)', () => {
  const token = 'any-token';
  const bandSize = 1;
  const expected = String(selectDesyncedIndex(token, bandSize));
  assert.equal(expected, '0');
  assert.equal(
    runCli(['--token', token, '--band-size', String(bandSize)]),
    expected,
  );
});

test('drift: CLI output equals selectDesyncedIndex for a multi-byte (Japanese) token', () => {
  const token = '日本語セッション';
  const bandSize = 4;
  assert.equal(
    runCli(['--token', token, '--band-size', String(bandSize)]),
    String(selectDesyncedIndex(token, bandSize)),
  );
});

test('drift: CLI output is deterministic across repeated invocations', () => {
  const token = 'session-token-7';
  const bandSize = 6;
  const first = runCli(['--token', token, '--band-size', String(bandSize)]);
  const second = runCli(['--token', token, '--band-size', String(bandSize)]);
  assert.equal(first, second);
  assert.equal(first, String(selectDesyncedIndex(token, bandSize)));
});

// ---------------------------------------------------------------------------
// Invalid input: missing token, and a missing / non-positive band size, each
// exit non-zero with a clear message rather than silently printing
// selectDesyncedIndex's own safe-default `0`.
// ---------------------------------------------------------------------------

test('missing --token exits non-zero with a clear message', () => {
  const { stderr } = runCliExpectFailure(['--band-size', '5']);
  assert.match(stderr, /--token is required/);
});

test('missing --band-size exits non-zero with a clear message', () => {
  const { stderr } = runCliExpectFailure(['--token', 'x']);
  assert.match(
    stderr,
    /--band-size is required and must be a positive integer/,
  );
});

test('non-positive --band-size exits non-zero with a clear message', () => {
  for (const bandSize of ['0', '-3']) {
    const { stderr } = runCliExpectFailure([
      '--token',
      'x',
      '--band-size',
      bandSize,
    ]);
    assert.match(
      stderr,
      /--band-size is required and must be a positive integer/,
    );
  }
});

test('non-integer --band-size exits non-zero with a clear message', () => {
  const { stderr } = runCliExpectFailure([
    '--token',
    'x',
    '--band-size',
    'not-a-number',
  ]);
  assert.match(
    stderr,
    /--band-size is required and must be a positive integer/,
  );
});

// ---------------------------------------------------------------------------
// --help
// ---------------------------------------------------------------------------

test('--help prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(output, /^Usage:/);
  assert.match(output, /--token <session-token> --band-size <n>/);
  // The worked example in the help text must itself be correct.
  assert.match(output, /claude-loop-2 --band-size 5\n {2}=> 4\n/);
});
