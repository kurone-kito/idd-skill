import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { trackTempDirectories } from './temp-fixtures.mts';

/**
 * A prefix unique to one run, so a leftover from an earlier run or another
 * process in the shared parent directory cannot match it.
 */
function uniquePrefix(label: string): string {
  return `idd-temp-fixtures-${label}-${randomUUID()}-`;
}

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
  const escapePrefix = uniquePrefix('escape');
  const outside = join(resolve(tmpdir()), '..', escapePrefix);
  assert.throws(() => makeTempDir(outside), /must resolve below/);
  // Matched by this run's unique prefix: other processes write there too.
  assert.deepEqual(
    readdirSync(dirname(resolve(outside))).filter((name) =>
      name.startsWith(escapePrefix),
    ),
    [],
  );
});

test('a prefix with a .. segment throws, even one that stays inside (#4049)', () => {
  const parent = makeTempDir(join(tmpdir(), 'idd-temp-fixtures-dots-'));
  mkdirSync(join(parent, 'inner'));
  assert.throws(
    () => makeTempDir(`${parent}/inner/../child-`),
    /must resolve below/,
  );
  assert.deepEqual(readdirSync(parent), ['inner']);
});

test('tmpdir() itself is not an accepted prefix (#4049)', () => {
  assert.throws(() => makeTempDir(resolve(tmpdir())), /must resolve below/);
});

test('a prefix through a symbolic link that leaves tmpdir() throws and creates nothing (#4049)', {
  skip:
    process.platform === 'win32'
      ? 'creating a symlink needs privileges'
      : false,
}, () => {
  // The link points at tmpdir()'s own parent, which is outside it.
  const outside = dirname(resolve(tmpdir()));
  const viaLink = uniquePrefix('via-link');
  const parent = makeTempDir(join(tmpdir(), 'idd-temp-fixtures-link-'));
  symlinkSync(outside, join(parent, 'link'));
  // Also with a trailing separator or `.` segment, which `resolve` drops.
  // Only the named prefix is checked for leftovers below: had the check
  // let the other two through, they would have created a bare or
  // dot-prefixed random name there, which cannot be told apart from what
  // other processes write.
  for (const prefix of [
    join(parent, 'link', viaLink),
    `${join(parent, 'link')}/`,
    `${join(parent, 'link')}/.`,
  ]) {
    assert.throws(() => makeTempDir(prefix), /must resolve below/, prefix);
  }
  // Matched by this run's unique prefix: other processes write there too.
  assert.deepEqual(
    readdirSync(outside).filter((name) => name.startsWith(viaLink)),
    [],
  );
});
