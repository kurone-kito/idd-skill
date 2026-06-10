import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findPnpmCommandLeaks } from '../scripts/check-pnpm-boundary.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('passes when template command rows avoid pnpm', () => {
  const overview = `
| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`npx dprint fmt "**/*.md"\` |
| **pre-push-validate** | \`npx markdownlint-cli2 "**/*.md"\` |
| **post-fix-validate** | \`node --test tests/*.mjs\` |
| **install-deps** | \`true\` |
`;

  assert.deepEqual(findPnpmCommandLeaks(overview), []);
});

test('fails when any command row leaks pnpm', () => {
  const overview = `
| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`pnpm run lint\` |
| **pre-push-validate** | \`npx markdownlint-cli2 "**/*.md"\` |
| **post-fix-validate** | \`node --test tests/*.mjs\` |
| **install-deps** | \`pnpm install --frozen-lockfile\` |
`;

  assert.deepEqual(findPnpmCommandLeaks(overview), [
    'fix-validate: contains forbidden token "pnpm" (pnpm run lint)',
    'install-deps: contains forbidden token "pnpm" (pnpm install --frozen-lockfile)',
  ]);
});

test('passes when command rows use npm, yarn, or npx examples', () => {
  const overview = `
| Name | Commands |
| ---- | -------- |
| **fix-validate** | \`npm run lint\` |
| **pre-push-validate** | \`yarn test\` |
| **post-fix-validate** | \`npx markdownlint-cli2 "**/*.md"\` |
| **install-deps** | \`npm install\` |
`;

  assert.deepEqual(findPnpmCommandLeaks(overview), []);
});

test('helper runtime docs avoid pnpm-only command assumptions', () => {
  const files = [
    'docs/idd-helper-scripts.md',
    'idd-template/docs/idd-helper-scripts.md',
  ];

  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    assert.doesNotMatch(text, /`[^`\n]*\bpnpm\s+\S+[^`\n]*`/i, file);
  }
});
