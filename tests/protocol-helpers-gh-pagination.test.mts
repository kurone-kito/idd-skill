import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePaginatedGhNdjson } from '../src/scripts/protocol-helpers.mts';

test('parsePaginatedGhNdjson preserves object order across lines', () => {
  const raw = [
    '{"id":1,"name":"first"}',
    '{"id":2,"name":"second"}',
    '{"id":3,"name":"third"}',
  ].join('\n');

  assert.deepEqual(parsePaginatedGhNdjson(raw), [
    { id: 1, name: 'first' },
    { id: 2, name: 'second' },
    { id: 3, name: 'third' },
  ]);
});

test('parsePaginatedGhNdjson ignores blank lines and flattens arrays defensively', () => {
  const raw = '\n{"id":1}\n\n[{"id":2},{"id":3}]\n';

  assert.deepEqual(parsePaginatedGhNdjson(raw), [
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ]);
});

test('parsePaginatedGhNdjson returns an empty array for empty output', () => {
  assert.deepEqual(parsePaginatedGhNdjson(' \n '), []);
});
