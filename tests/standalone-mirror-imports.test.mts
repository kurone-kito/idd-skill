import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractImportSpecifiers,
  findExactTemplateScriptMirrors,
  findNonNodeSpecifiers,
} from '../src/scripts/lint-source-boundaries.mts';

// Detector regressions for the standalone-mirror contract: a source that is
// mirrored `exact` into `idd-template/scripts/` must stay self-contained (Node
// built-ins only) so the mirror runs standalone. The scan of the real
// audit/sync-manifest.json is the STANDALONE-MIRROR-IMPORTS rule of
// scripts/lint-source-boundaries.mjs (#3748); this file keeps the import
// extraction and mirror derivation cases.

test('extractImportSpecifiers finds import/export-from and dynamic import() specifiers, ignoring comments', () => {
  const sample = `
// import { fake } from 'ignored-line-comment';
/* export * from 'ignored-block-comment'; */
import { readFileSync } from 'node:fs';
import 'node:process';
export * from 'node:util';
export const noSpecifierHere = 1;
const lazy = await import('node:crypto');
const withAttributes = await import('node:test', { with: { type: 'json' } });
const bareWithAttributes = await import('bare-package', {});
const templateLiteral = await import(\`node:assert\`);
const bareTemplateLiteral = await import(\`another-bare-package\`);
`;
  assert.deepEqual(extractImportSpecifiers(sample), [
    'node:fs',
    'node:process',
    'node:util',
    'node:crypto',
    'node:test',
    'bare-package',
    'node:assert',
    'another-bare-package',
  ]);
});

test('extractImportSpecifiers ignores an interpolated (non-static) template-literal import', () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${} chars under test, not a forgotten template placeholder.
  const sample = 'const pkg = await import(`node:${suffix}`);';
  assert.deepEqual(extractImportSpecifiers(sample), []);
});

test('findNonNodeSpecifiers flags relative and bare specifiers alike, unlike a node: builtin', () => {
  const sample = `
import { readFileSync } from 'node:fs';
import { helper } from './helper.mjs';
import { parse } from 'yaml';
`;
  assert.deepEqual(findNonNodeSpecifiers(sample), ['./helper.mjs', 'yaml']);
  assert.deepEqual(findNonNodeSpecifiers("import fetch from 'node-fetch';\n"), [
    'node-fetch',
  ]);
});

test('findExactTemplateScriptMirrors derives only exact-mode idd-template/scripts/ pairs', () => {
  const manifest = JSON.stringify({
    syncPairs: [
      {
        id: 'script-mirror',
        mode: 'exact',
        source: 'scripts/a.mjs',
        target: 'idd-template/scripts/a.mjs',
      },
      // The id falls back to the target when a pair has none.
      {
        mode: 'exact',
        source: 'scripts/b.mjs',
        target: 'idd-template/scripts/b.mjs',
      },
      {
        id: 'concreted-script',
        mode: 'concreted',
        source: 'scripts/c.mjs',
        target: 'idd-template/scripts/c.mjs',
      },
      {
        id: 'exact-doc',
        mode: 'exact',
        source: 'docs/d.md',
        target: 'idd-template/docs/d.md',
      },
      { id: 'no-target', mode: 'exact', source: 'scripts/e.mjs' },
    ],
  });
  assert.deepEqual(findExactTemplateScriptMirrors(manifest), [
    { id: 'script-mirror', source: 'scripts/a.mjs' },
    { id: 'idd-template/scripts/b.mjs', source: 'scripts/b.mjs' },
  ]);
  assert.deepEqual(findExactTemplateScriptMirrors('{}'), []);
});
