import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Guard for the append-mostly helper-inventory surfaces (#1032). Each of these
// lists is appended to whenever a helper is registered, so two concurrent
// sessions that each add a helper conflict on adjacent appends unless the list
// has a deterministic canonical order. The canonical order is **ascending
// string sort** of the list's stable key (bin name, script-attribute line,
// HELPER_COMMANDS `id`, syncPairs `id`, or bundle file path). This test fails
// when any covered list is out of that order so the "keep both, in order"
// conflict resolution is enforced mechanically.

const read = (relativePath: string): string =>
  readFileSync(new URL(relativePath, new URL('../', import.meta.url)), 'utf8');

/** Assert `values` equals its own ascending string sort, with a helpful diff. */
function assertSorted(label: string, values: string[]): void {
  const sorted = [...values].sort();
  const firstOutOfOrder = values.findIndex(
    (value, index) => value !== sorted[index],
  );
  assert.deepEqual(
    values,
    sorted,
    `${label} must be in ascending canonical order; first out-of-order entry: ${
      firstOutOfOrder >= 0 ? values[firstOutOfOrder] : '(none)'
    } (run the sort lever in #1032 / re-sort the list)`,
  );
}

test('package.json bin keys are in canonical order', () => {
  const pkg = JSON.parse(read('package.json')) as {
    bin?: Record<string, string>;
  };
  assertSorted('package.json `bin` keys', Object.keys(pkg.bin ?? {}));
});

test('.gitattributes scripts/*.mjs linguist-generated lines are in canonical order', () => {
  const lines = read('.gitattributes')
    .split('\n')
    .filter((line) =>
      /^scripts\/[^/]+\.mjs linguist-generated=true$/.test(line),
    );
  assert.ok(
    lines.length > 0,
    'expected scripts/*.mjs linguist-generated lines',
  );
  assertSorted('.gitattributes scripts/*.mjs lines', lines);
});

test('.gitattributes lists exactly the generated scripts/*.mjs (no missing or stale)', () => {
  // A generated artifact carries the `idd-generated-from` provenance header; a
  // hand-authored helper does not. The marked set must equal the set listed in
  // .gitattributes so a newly generated script is never left unmarked (linguist
  // stats / diff-collapsing would silently skip it) and a removed script never
  // leaves a dangling entry — completeness, alongside the order guard above.
  const scriptsDir = new URL('scripts/', new URL('../', import.meta.url));
  const generated = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) =>
      /idd-generated-from/.test(
        readFileSync(new URL(name, scriptsDir), 'utf8').slice(0, 200),
      ),
    )
    .sort();
  const listed = [
    ...read('.gitattributes').matchAll(
      /^scripts\/([^/\n]+\.mjs) linguist-generated=true$/gm,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(
    listed,
    generated,
    'the .gitattributes scripts/*.mjs linguist-generated block must list exactly the generated scripts (add any newly generated script in sorted position; drop entries whose script no longer exists)',
  );
});

test('helper-runtime-manifest HELPER_COMMANDS are ordered by id', () => {
  const source = read('src/scripts/helper-runtime-manifest.mts');
  const marker = 'const HELPER_COMMANDS: HelperCommand[] = [';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'HELPER_COMMANDS array not found');
  // Slice from the array opener to the first line that starts with the array
  // terminator `];`. This avoids counting `[`/`]` that appear inside entry
  // strings/comments (e.g. a description that mentions brackets), which a
  // bracket-depth scan would miscount into a false CI failure.
  const afterMarker = source.slice(start + marker.length);
  const terminator = afterMarker.search(/^\];/m);
  assert.ok(terminator >= 0, 'HELPER_COMMANDS array terminator `];` not found');
  const arrayBody = afterMarker.slice(0, terminator);
  // Entry ids sit at the 4-space top-level indent; nested fields are deeper.
  const ids = [...arrayBody.matchAll(/^ {4}id: '([^']+)'/gm)].map(
    (match) => match[1],
  );
  assert.ok(ids.length > 0, 'expected HELPER_COMMANDS entries');
  assertSorted('HELPER_COMMANDS ids', ids);
});

test('sync-manifest syncPairs and bundleBudgets[].files are in canonical order', () => {
  const manifest = JSON.parse(read('audit/sync-manifest.json')) as {
    syncPairs?: { id: string }[];
    bundleBudgets?: { id: string; files: string[] }[];
  };
  // syncPairs order is not load-bearing: each pair has a unique target and is
  // generated from a source read straight off disk (sync-docs never chains one
  // pair's output into another pair's source), so sorting by id is safe.
  assertSorted(
    'sync-manifest syncPairs ids',
    (manifest.syncPairs ?? []).map((pair) => pair.id),
  );
  for (const budget of manifest.bundleBudgets ?? []) {
    // bundleBudgets[].files only feed a byte-sum total, so file order is purely
    // cosmetic and safe to sort.
    assertSorted(`bundleBudgets[${budget.id}].files`, budget.files);
  }
});

// Completion guard for the TypeScript helper migration (#1365): every
// scripts/*.mjs and bin/*.mjs on disk must be generated from a
// src/scripts/*.mts / src/bin/*.mts source, so a future hand-written helper
// with no .mts source cannot silently reopen the dual-path the migration
// removed. This is deliberately keyed on **source existence**, not the
// `idd-generated-from` banner scan used elsewhere in this file: a
// shebang-led bin/*.mjs still carries the banner reliably today, but source
// existence is the invariant that actually matters and does not depend on
// banner placement at all. Complements (does not replace)
// scripts/audit-docs.mjs's banner-based forward/reverse pairing guard, which
// cannot see a hand-written .mjs that carries no banner in the first place.

/**
 * Returns the `.mjs` names in `generatedNames` that have no matching `.mts`
 * source in `sourceNames` (compared by shared basename). A non-empty result
 * names a hand-written orphan.
 */
function orphanGeneratedNames(
  generatedNames: readonly string[],
  sourceNames: readonly string[],
): string[] {
  const sourceBasenames = new Set(
    sourceNames
      .filter((name) => name.endsWith('.mts'))
      .map((name) => name.slice(0, -'.mts'.length)),
  );
  return generatedNames
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => !sourceBasenames.has(name.slice(0, -'.mjs'.length)))
    .sort();
}

test('orphanGeneratedNames flags a hand-written .mjs with no .mts source', () => {
  assert.deepEqual(
    orphanGeneratedNames(['known.mjs', 'orphan.mjs'], ['known.mts']),
    ['orphan.mjs'],
  );
});

test('orphanGeneratedNames finds no orphan when every generated name is paired', () => {
  assert.deepEqual(
    orphanGeneratedNames(['known.mjs'], ['known.mts', 'unused.mts']),
    [],
  );
});

test('every scripts/*.mjs and bin/*.mjs on disk has a src/**/*.mts source', () => {
  const root = new URL('../', import.meta.url);
  const scriptOrphans = orphanGeneratedNames(
    readdirSync(new URL('scripts/', root)),
    readdirSync(new URL('src/scripts/', root)),
  );
  const binOrphans = orphanGeneratedNames(
    readdirSync(new URL('bin/', root)),
    readdirSync(new URL('src/bin/', root)),
  );
  assert.deepEqual(
    [...scriptOrphans, ...binOrphans],
    [],
    'hand-written helper with no src/**/*.mts source — the TypeScript helper migration is complete and no hand-written scripts/bin path remains; see docs/typescript-sources.md',
  );
});
