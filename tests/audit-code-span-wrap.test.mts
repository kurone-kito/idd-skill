import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  auditCodeSpanWraps,
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

test('auditCodeSpanWraps finds no corrupting wraps on the current repository tree', () => {
  // End-to-end regression: this is the same scan `node
  // scripts/audit-code-span-wrap.mjs` runs as part of pre-push-validate
  // and post-fix-validate. Keeping it here means a future corrupting
  // instance fails `node --test tests/*.test.mts` too, not only the
  // separately-invoked CLI.
  assert.deepEqual(auditCodeSpanWraps(), []);
});
