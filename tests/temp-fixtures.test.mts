import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { trackTempDirectories } from './temp-fixtures.mts';

// Pins `tests/temp-fixtures.mts` (issue #4049): the tracked directories are
// removed by a file-level after hook, so a prefix must never let that
// recursive removal reach outside the temporary directory.

const makeTempDir = trackTempDirectories();

test('a prefix under tmpdir() creates a tracked directory there (#4049)', () => {
  const directory = makeTempDir(join(tmpdir(), 'idd-temp-fixtures-test-'));
  assert.equal(dirname(directory), resolve(tmpdir()));
  assert.equal(existsSync(directory), true);
});

test('a prefix inside a nested fixture directory is allowed (#4049)', () => {
  const parent = makeTempDir(join(tmpdir(), 'idd-temp-fixtures-parent-'));
  const nested = join(parent, 'nested');
  mkdirSync(nested);
  const directory = makeTempDir(join(nested, 'child-'));
  assert.equal(dirname(directory), nested);
});

test('a prefix outside tmpdir() throws and creates nothing (#4049)', () => {
  const outside = join(resolve(tmpdir()), '..', 'idd-temp-fixtures-escape-');
  assert.throws(() => makeTempDir(outside), /must resolve below/);
  // Matched by name: other processes may write to that parent at any time.
  assert.deepEqual(
    readdirSync(dirname(resolve(outside))).filter((name) =>
      name.startsWith('idd-temp-fixtures-escape-'),
    ),
    [],
  );
});

test('tmpdir() itself is not an accepted prefix (#4049)', () => {
  assert.throws(() => makeTempDir(resolve(tmpdir())), /must resolve below/);
});
