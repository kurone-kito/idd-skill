import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { extractImportSpecifiers } from './test-utils.mts';

// Guard for the toolless-adopter bare-node import contract (#1707): every
// helper source under src/**/*.mts must import only node: builtins or a
// relative (./ or ../) path. Adopters on the package-manager /
// ephemeral-npx profiles never see node_modules, so a bare third-party
// specifier (e.g. `import { parse } from 'yaml'`) ships broken for them —
// and today the invariant holds by discipline only:
// helper-runtime-manifest.mts's closure walker (findRelativeImports)
// silently ignores any specifier that doesn't start with '.', and Biome's
// noRestrictedImports only bans execSync, not arbitrary bare imports. This
// test fails the moment any src/**/*.mts file gains a bare specifier.

const SOURCE_ROOT_URL = new URL('../src/', import.meta.url);

/** Every `.mts` file path (repo-root-relative), recursively under `src/`. */
function findSourceFiles(): string[] {
  return readdirSync(SOURCE_ROOT_URL, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.mts'))
    .map((entry) => `src/${entry.replaceAll('\\', '/')}`)
    .sort();
}

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/**
 * True for the documented relative forms only (`./…` or `../…`) — plain
 * `specifier.startsWith('.')` would also accept a dot-prefixed bare name
 * like `.foo`, which is not a relative path.
 */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

test('src/**/*.mts has at least one source file to guard', () => {
  // Guards the derivation itself: if this set ever drops to zero, the test
  // below would pass vacuously without checking anything.
  assert.ok(findSourceFiles().length > 0);
});

test('isRelativeSpecifier accepts only ./ and ../ forms', () => {
  assert.equal(isRelativeSpecifier('./foo.mts'), true);
  assert.equal(isRelativeSpecifier('../foo.mts'), true);
  assert.equal(isRelativeSpecifier('.foo'), false);
  assert.equal(isRelativeSpecifier('.'), false);
  assert.equal(isRelativeSpecifier('node:fs'), false);
  assert.equal(isRelativeSpecifier('yaml'), false);
});

test('every src/**/*.mts import/export specifier is a node: builtin or a relative path', () => {
  for (const path of findSourceFiles()) {
    const specifiers = extractImportSpecifiers(readSource(path));
    const bareSpecifiers = specifiers.filter(
      (specifier) =>
        !specifier.startsWith('node:') && !isRelativeSpecifier(specifier),
    );
    assert.deepEqual(
      bareSpecifiers,
      [],
      `${path} must import only node: builtins or relative paths so ` +
        `toolless adopters (package-manager / ephemeral-npx profiles, no ` +
        `node_modules) don't break; found bare specifier(s): ` +
        `${bareSpecifiers.join(', ')}`,
    );
  }
});
