import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  computeBranchName,
  computeBranchSlug,
} from '../src/scripts/branch-name.mts';

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
  // 40-char cut that lands mid-token and trims back to the last hyphen
  {
    number: 123,
    title:
      'Implement comprehensive authentication authorization middleware system',
    branch: 'issue/123-implement-comprehensive-authentication',
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
  assert.equal(computeBranchName(8, null), 'issue/8-task');
});
