import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findOrphanGeneratedNames } from '../src/scripts/repository-inventory-audit.mts';

test('findOrphanGeneratedNames flags a hand-written mjs with no mts source', () => {
  assert.deepEqual(
    findOrphanGeneratedNames(['known.mjs', 'orphan.mjs'], ['known.mts']),
    ['orphan.mjs'],
  );
});

test('findOrphanGeneratedNames finds no orphan when every generated name is paired', () => {
  assert.deepEqual(
    findOrphanGeneratedNames(['known.mjs'], ['known.mts', 'unused.mts']),
    [],
  );
});
