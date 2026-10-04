import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  findBareSpecifiers,
  isRelativeSpecifier,
} from '../src/scripts/lint-source-boundaries.mts';

// Detector regressions for the toolless-adopter bare-node import contract
// (#1707): every helper source under src/**/*.mts must import only node:
// builtins or a relative (./ or ../) path, because adopters on the
// package-manager / ephemeral-npx profiles never see node_modules.
// helper-runtime-manifest.mts's closure walker (findRelativeImports) silently
// ignores any specifier that doesn't start with '.', and Biome's
// noRestrictedImports only bans execSync, not arbitrary bare imports, so the
// whole-tree scan is its own rule: NODE-IMPORT-BOUNDARY in
// scripts/lint-source-boundaries.mjs (#3748), which `pnpm run lint:minimum`
// and the bare-node lint lane run. This file keeps the matcher cases; the
// CLI fixtures in lint-source-boundaries.test.mts cover the scan itself.

test('isRelativeSpecifier accepts only ./ and ../ forms', () => {
  assert.equal(isRelativeSpecifier('./foo.mts'), true);
  assert.equal(isRelativeSpecifier('../foo.mts'), true);
  assert.equal(isRelativeSpecifier('.foo'), false);
  assert.equal(isRelativeSpecifier('.'), false);
  assert.equal(isRelativeSpecifier('node:fs'), false);
  assert.equal(isRelativeSpecifier('yaml'), false);
});

test('findBareSpecifiers keeps node: builtins and relative paths, and flags every other specifier', () => {
  const sample = `
import { readFileSync } from 'node:fs';
import { helper } from './helper.mts';
import { parent } from '../parent.mts';
import { parse } from 'yaml';
import scoped from '@scope/package';
import dotted from '.hidden';
export * from 'left-pad';
const lazy = await import('another-bare-package');
const lazyNode = await import('node:crypto');
`;
  assert.deepEqual(findBareSpecifiers(sample), [
    'yaml',
    '@scope/package',
    '.hidden',
    'left-pad',
    'another-bare-package',
  ]);
  assert.deepEqual(findBareSpecifiers("import 'node:process';\n"), []);
  // A bare package whose name merely starts with `node` is still bare.
  assert.deepEqual(
    findBareSpecifiers(
      "import fetch from 'node-fetch';\nimport mail from 'nodemailer';\n",
    ),
    ['node-fetch', 'nodemailer'],
  );
});
