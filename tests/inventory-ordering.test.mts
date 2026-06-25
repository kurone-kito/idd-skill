import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('helper-runtime-manifest HELPER_COMMANDS are ordered by id', () => {
  const source = read('src/scripts/helper-runtime-manifest.mts');
  const marker = 'const HELPER_COMMANDS: HelperCommand[] = [';
  const start = source.indexOf(marker);
  assert.ok(start >= 0, 'HELPER_COMMANDS array not found');
  // Scan to the matching close bracket so ids outside the array are ignored.
  let depth = 1;
  let index = start + marker.length;
  for (; index < source.length && depth > 0; index += 1) {
    const char = source[index];
    if (char === '[') depth += 1;
    else if (char === ']') depth -= 1;
  }
  const arrayBody = source.slice(start + marker.length, index - 1);
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
