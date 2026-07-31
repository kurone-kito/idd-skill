import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractImportSpecifiers, readJson, readText } from './test-utils.mts';

/** A minimal view of an `audit/sync-manifest.json` `syncPairs[]` entry. */
interface SyncPair {
  id?: string;
  mode?: string;
  source?: string;
  target?: string;
}

/**
 * Derives the exact-mode `idd-template/scripts/` mirror set from
 * `audit/sync-manifest.json` at test-run time instead of hardcoding a file
 * name, so any future addition to this mirror pattern is automatically
 * covered.
 */
function findExactTemplateScriptMirrors(): { id: string; source: string }[] {
  const manifest = readJson('audit/sync-manifest.json') as {
    syncPairs?: SyncPair[];
  };
  return (manifest.syncPairs ?? []).flatMap((pair) =>
    pair.mode === 'exact' &&
    typeof pair.source === 'string' &&
    typeof pair.target === 'string' &&
    pair.target.startsWith('idd-template/scripts/')
      ? [{ id: pair.id ?? pair.target, source: pair.source }]
      : [],
  );
}

test('extractImportSpecifiers finds import/export-from and dynamic import() specifiers, ignoring comments', () => {
  const sample = `
// import { fake } from 'ignored-line-comment';
/* export * from 'ignored-block-comment'; */
import { readFileSync } from 'node:fs';
import 'node:process';
export * from 'node:util';
export const noSpecifierHere = 1;
const lazy = await import('node:crypto');
`;
  assert.deepEqual(extractImportSpecifiers(sample), [
    'node:fs',
    'node:process',
    'node:util',
    'node:crypto',
  ]);
});

test('audit/sync-manifest.json has at least one exact-mode idd-template/scripts/ mirror to guard', () => {
  // Guards the derivation itself: if this set ever drops to zero, the test
  // below would pass vacuously without checking anything.
  assert.ok(findExactTemplateScriptMirrors().length > 0);
});

test('exact-mode idd-template/scripts/ mirror sources import only Node built-ins', () => {
  for (const { id, source } of findExactTemplateScriptMirrors()) {
    const specifiers = extractImportSpecifiers(readText(source));
    const nonNodeImports = specifiers.filter(
      (specifier) => !specifier.startsWith('node:'),
    );
    assert.deepEqual(
      nonNodeImports,
      [],
      `sync pair "${id}" (${source}) must stay self-contained (Node ` +
        `built-ins only) so the idd-template/scripts/ mirror runs ` +
        `standalone; found: ${nonNodeImports.join(', ')}`,
    );
  }
});
