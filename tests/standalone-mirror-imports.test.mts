import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readJson, readText } from './test-utils.mts';

/** A minimal view of an `audit/sync-manifest.json` `syncPairs[]` entry. */
interface SyncPair {
  id?: string;
  mode?: string;
  source?: string;
  target?: string;
}

/**
 * Extracts the module specifier of every static `import` / `export … from`
 * declaration in `source` — including side-effect `import 'x'` and
 * `export * from 'x'` / `export { a } from 'x'` re-exports — while ignoring
 * anything that appears only inside a `//` or `/* … *\/`-style comment.
 * Dynamic `import()` calls are intentionally excluded: they are runtime
 * expressions rather than static declarations, and the self-containment
 * constraint this test enforces (see `docs/idd-helper-scripts.md`) is about
 * a file's static dependency closure.
 *
 * The clause between the keyword and the specifier is restricted to the
 * characters an import/export clause can actually contain (identifiers,
 * commas, `*`, braces, whitespace). This is deliberately a *positive* class
 * rather than "anything but a quote or semicolon": a plain `export function
 * f(x) {` or `export const x = 'literal';` contains a `(` or `=` before any
 * quote, which this class excludes, so scanning stops there instead of
 * misreading an unrelated string literal deeper in the function body as an
 * import specifier.
 */
function extractStaticImportSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const clause = '[A-Za-z0-9_$,\\s*{}]*?';
  const declaration = new RegExp(
    `^[ \\t]*(?:import\\b${clause}(?:\\bfrom\\s+)?|export\\b${clause}\\bfrom\\s+)['"]([^'"]+)['"]`,
    'gm',
  );
  return [...withoutComments.matchAll(declaration)].map((match) => match[1]);
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

test('extractStaticImportSpecifiers finds import/export-from specifiers and ignores comments', () => {
  const sample = `
// import { fake } from 'ignored-line-comment';
/* export * from 'ignored-block-comment'; */
import { readFileSync } from 'node:fs';
import 'node:process';
export * from 'node:util';
export const noSpecifierHere = 1;
`;
  assert.deepEqual(extractStaticImportSpecifiers(sample), [
    'node:fs',
    'node:process',
    'node:util',
  ]);
});

test('audit/sync-manifest.json has at least one exact-mode idd-template/scripts/ mirror to guard', () => {
  // Guards the derivation itself: if this set ever drops to zero, the test
  // below would pass vacuously without checking anything.
  assert.ok(findExactTemplateScriptMirrors().length > 0);
});

test('exact-mode idd-template/scripts/ mirror sources import only Node built-ins', () => {
  for (const { id, source } of findExactTemplateScriptMirrors()) {
    const specifiers = extractStaticImportSpecifiers(readText(source));
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
