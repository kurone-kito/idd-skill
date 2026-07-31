import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditCodeSpanWraps,
  globToRegExp,
  parseMarkdownlintIgnores,
} from '../src/scripts/audit-code-span-wrap.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('parseMarkdownlintIgnores reads the flat ignores: list shape', () => {
  const config = [
    'ignores:',
    '  - .github/CODE_OF_CONDUCT*',
    '  - fixtures/issue-comments/*.md',
    '  - node_modules/**/*.md',
  ].join('\n');
  assert.deepEqual(parseMarkdownlintIgnores(config), [
    '.github/CODE_OF_CONDUCT*',
    'fixtures/issue-comments/*.md',
    'node_modules/**/*.md',
  ]);
});

test('parseMarkdownlintIgnores strips surrounding quotes', () => {
  const config = [
    'ignores:',
    "  - 'quoted/path/*.md'",
    '  - "double/*.md"',
  ].join('\n');
  assert.deepEqual(parseMarkdownlintIgnores(config), [
    'quoted/path/*.md',
    'double/*.md',
  ]);
});

test('parseMarkdownlintIgnores returns an empty array when the key is absent', () => {
  assert.deepEqual(parseMarkdownlintIgnores('default: true\n'), []);
});

test('parseMarkdownlintIgnores stops at the first non-list-item line', () => {
  const config = ['ignores:', '  - a/*.md', 'default: true', '  - b/*.md'].join(
    '\n',
  );
  assert.deepEqual(parseMarkdownlintIgnores(config), ['a/*.md']);
});

test("parseMarkdownlintIgnores matches this repository's actual .markdownlint-cli2.yaml", () => {
  const config = readFileSync(
    join(REPO_ROOT, '.markdownlint-cli2.yaml'),
    'utf8',
  );
  const ignores = parseMarkdownlintIgnores(config);
  assert.ok(ignores.includes('node_modules/**/*.md'));
  assert.ok(ignores.length > 0);
});

test('globToRegExp matches a node_modules/**/*.md ignore pattern across nested directories', () => {
  const pattern = globToRegExp('node_modules/**/*.md');
  assert.ok(pattern.test('node_modules/foo/bar.md'));
  assert.ok(pattern.test('node_modules/foo/bar/baz.md'));
  assert.ok(!pattern.test('src/scripts/foo.md'));
});

test('globToRegExp matches a single-segment prefix-star pattern', () => {
  const pattern = globToRegExp('.github/CODE_OF_CONDUCT*');
  assert.ok(pattern.test('.github/CODE_OF_CONDUCT.md'));
  assert.ok(!pattern.test('.github/CODE_OF_CONDUCT/nested.md'));
  assert.ok(!pattern.test('.github/OTHER.md'));
});

test('globToRegExp matches a single-segment star inside a fixed directory', () => {
  const pattern = globToRegExp('fixtures/issue-comments/*.md');
  assert.ok(pattern.test('fixtures/issue-comments/example.md'));
  assert.ok(!pattern.test('fixtures/issue-comments/nested/example.md'));
});

test("this repository's ignore patterns actually exclude a matching path from the audit scope", () => {
  // Direct regression for the exclusion behavior auditCodeSpanWraps relies
  // on: parse the real .markdownlint-cli2.yaml ignores, then confirm a
  // path that must be excluded (per that config) matches, and a normal
  // in-scope Markdown path does not.
  const config = readFileSync(
    join(REPO_ROOT, '.markdownlint-cli2.yaml'),
    'utf8',
  );
  const patterns = parseMarkdownlintIgnores(config).map(globToRegExp);
  assert.ok(
    patterns.some((pattern) => pattern.test('node_modules/some-pkg/README.md')),
    'a node_modules path must be excluded by the real ignore list',
  );
  assert.ok(
    !patterns.some((pattern) => pattern.test('docs/idd-workflow.md')),
    'an ordinary tracked doc must not be excluded by the real ignore list',
  );
});

test('auditCodeSpanWraps finds no corrupting wraps on the current repository tree', () => {
  // End-to-end regression: this is the same scan `node
  // scripts/audit-code-span-wrap.mjs` runs as part of pre-push-validate
  // and post-fix-validate. Keeping it here means a future corrupting
  // instance fails `node --test tests/*.test.mts` too, not only the
  // separately-invoked CLI.
  assert.deepEqual(auditCodeSpanWraps(), []);
});
