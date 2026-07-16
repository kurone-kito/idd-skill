import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeBranchName,
  computeBranchSlug,
} from '../src/scripts/branch-name.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/branch-name.mjs');

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

// Worked examples shared verbatim with the "Worked examples" block in
// `.github/instructions/idd-claim.instructions.md` pre-check (e). This is
// the drift guard: the helper and the written algorithm must agree on
// these, so prose and code cannot silently diverge.
const WORKED_EXAMPLES: ReadonlyArray<{
  number: number;
  title: string;
  branch: string;
}> = [
  // stop-word removal (`the`)
  {
    number: 42,
    title: 'Add the OAuth login flow',
    branch: 'issue/42-add-oauth-login-flow',
  },
  // 40-char cut that lands exactly on a token boundary (this issue's own
  // branch — the helper computes the branch of the issue that introduced
  // it)
  {
    number: 901,
    title:
      'Add a helper that computes the canonical issue/<number>-<slug> branch name',
    branch: 'issue/901-add-helper-that-computes-canonical-issue',
  },
  // empty slug falls back to `task`
  { number: 7, title: '!!!', branch: 'issue/7-task' },
  // non-ASCII characters drop out, ASCII tokens remain
  { number: 99, title: '日本語 calendar 機能', branch: 'issue/99-calendar' },
];

test('drift: helper reproduces the instruction worked examples', () => {
  for (const example of WORKED_EXAMPLES) {
    assert.equal(
      computeBranchName(example.number, example.title),
      example.branch,
      `${example.number} / ${example.title}`,
    );
  }
});

test('lowercases and replaces every non-[a-z0-9] run with hyphens', () => {
  assert.equal(computeBranchSlug('Add OAuth Login'), 'add-oauth-login');
  assert.equal(computeBranchSlug('Fix API/DB sync'), 'fix-api-db-sync');
});

test('removes whole-token stop-words only (not substrings)', () => {
  assert.equal(
    computeBranchSlug('Refactor for the API and DB'),
    'refactor-api-db',
  );
  // "android" contains "and" but is not the whole token, so it stays
  assert.equal(computeBranchSlug('Android theme'), 'android-theme');
});

test('40-char cut trims back to the last hyphen when it lands mid-token', () => {
  assert.equal(
    computeBranchSlug('aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd'),
    'aaaaaaaaaa-bbbbbbbbbb-cccccccccc',
  );
});

test('40-char cut keeps the hard cut when there is no hyphen to trim to', () => {
  const slug = computeBranchSlug('a'.repeat(50));
  assert.equal(slug, 'a'.repeat(40));
  assert.equal(slug.length, 40);
});

test('a slug of exactly 40 characters is returned unchanged', () => {
  // Exercises the `slug.length > 40` boundary (the `>` vs `>=` guard): a
  // 40-char slug must not enter the cut path.
  const slug = computeBranchSlug('aaaaaaaaa bbbbbbbbb ccccccccc dddddddddd');
  assert.equal(slug, 'aaaaaaaaa-bbbbbbbbb-ccccccccc-dddddddddd');
  assert.equal(slug.length, 40);
});

test('cut on a hyphen boundary keeps whole tokens and strips the trailing hyphen', () => {
  assert.equal(
    computeBranchSlug('aaaaaaaaa bbbbbbbbb ccccccccc ddddddddd eee'),
    'aaaaaaaaa-bbbbbbbbb-ccccccccc-ddddddddd',
  );
});

test('falls back to `task` when nothing survives normalization', () => {
  for (const title of ['!!!', '---', '   ', '🎉', '日本語', '', '/<>-']) {
    assert.equal(computeBranchSlug(title), 'task', JSON.stringify(title));
  }
});

test('drops non-ASCII characters while keeping ASCII tokens', () => {
  assert.equal(computeBranchSlug('日本語 calendar 機能'), 'calendar');
  assert.equal(computeBranchSlug('Update 設定 page'), 'update-page');
});

test('computeBranchName composes issue/<number>-<slug>', () => {
  assert.equal(computeBranchName(5, 'Hello World'), 'issue/5-hello-world');
});

test('handles nullish and non-string titles defensively', () => {
  assert.equal(computeBranchSlug(null), 'task');
  assert.equal(computeBranchSlug(undefined), 'task');
  // non-string inputs are out of the documented (title-string) domain and
  // fall back to `task` rather than producing coerced slugs like
  // `123` / `object-object`
  assert.equal(computeBranchSlug(123), 'task');
  assert.equal(computeBranchSlug({}), 'task');
  assert.equal(computeBranchSlug([1, 2]), 'task');
  assert.equal(computeBranchSlug(true), 'task');
  assert.equal(computeBranchName(8, null), 'issue/8-task');
  assert.equal(computeBranchName(9, 123), 'issue/9-task');
});

// ---------------------------------------------------------------------------
// CLI: drift guard plus invalid-input rejection. `parseArgs`/`runCli` are not
// exported (only the pure `computeBranchName`/`computeBranchSlug` are), so
// these cases run against the built CLI, mirroring the CLI test structure in
// `tests/select-desynced-index.test.mts`.
// ---------------------------------------------------------------------------

test('drift: CLI output equals computeBranchName for an ordinary number and title', () => {
  const number = 42;
  const title = 'Add the OAuth login flow';
  assert.equal(
    runCli(['--number', String(number), '--title', title]),
    computeBranchName(number, title),
  );
});

test('missing --number exits non-zero with a clear message', () => {
  const { stderr } = runCliExpectFailure(['--title', 'x']);
  assert.match(stderr, /--number is required and must be a positive integer/);
});

test('non-positive --number exits non-zero with a clear message', () => {
  for (const number of ['0', '-3']) {
    const { stderr } = runCliExpectFailure([
      '--number',
      number,
      '--title',
      'x',
    ]);
    assert.match(stderr, /--number is required and must be a positive integer/);
  }
});

test('non-integer --number exits non-zero with a clear message', () => {
  // Includes non-integer-*looking* values (`3.5`, `5abc`) that
  // `Number.parseInt` alone would silently truncate to a valid integer
  // (`3`, `5`) before any positivity check ever ran.
  for (const number of ['not-a-number', '3.5', '5abc']) {
    const { stderr } = runCliExpectFailure([
      '--number',
      number,
      '--title',
      'x',
    ]);
    assert.match(stderr, /--number is required and must be a positive integer/);
  }
});

test('missing --title exits non-zero with a clear message', () => {
  const { stderr } = runCliExpectFailure(['--number', '5']);
  assert.match(stderr, /--title is required/);
});

test('--help prints usage and exits 0', () => {
  const output = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(output, /^Usage:/);
  assert.match(output, /--number <issue-number> --title <issue-title>/);
  // The worked example in the help text must itself be correct.
  assert.match(output, /=> issue\/42-add-oauth-login-flow\n/);
});
