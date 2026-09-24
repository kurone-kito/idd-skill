import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import { resolveBundleRoot } from '../src/scripts/bundle-root.mts';

const createdFixtureDirs: string[] = [];

function makeFixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-root-'));
  createdFixtureDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdFixtureDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** True when any ancestor of `startDir` (up to and including the
 * filesystem root) already contains `relativePath` — the same
 * precondition-check pattern the reachability test in
 * `tests/idd-onboard.test.mts` uses, so a real filesystem's own root
 * unexpectedly carrying one of these marker files can never turn this
 * test flaky. */
function anyAncestorContains(startDir: string, relativePath: string): boolean {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, relativePath))) {
      return true;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

test('resolveBundleRoot resolves to the nearest ancestor holding the bundle marker, even when a farther ancestor holds package.json', () => {
  const outer = makeFixtureDir();
  writeFileSync(join(outer, 'package.json'), '{}\n');
  const inner = join(outer, 'inner');
  mkdirSync(join(inner, 'schemas'), { recursive: true });
  writeFileSync(join(inner, 'schemas', 'policy.schema.json'), '{}\n');
  const start = join(inner, 'src', 'scripts');
  mkdirSync(start, { recursive: true });

  assert.equal(resolveBundleRoot(start), inner);
});

test('resolveBundleRoot resolves to the nearest ancestor holding package.json when no ancestor holds the bundle marker', () => {
  const project = makeFixtureDir();
  writeFileSync(join(project, 'package.json'), '{}\n');
  const start = join(project, 'src', 'scripts');
  mkdirSync(start, { recursive: true });

  assert.equal(resolveBundleRoot(start), project);
});

test('resolveBundleRoot throws naming the start directory when neither marker is found', (t) => {
  const start = join(makeFixtureDir(), 'src', 'scripts');
  mkdirSync(start, { recursive: true });
  if (
    anyAncestorContains(start, 'schemas/policy.schema.json') ||
    anyAncestorContains(start, 'package.json')
  ) {
    t.skip(
      'an ancestor of this fixture tree (up to the filesystem root) already ' +
        'contains schemas/policy.schema.json or package.json',
    );
    return;
  }

  assert.throws(
    () => resolveBundleRoot(start),
    (error: unknown) => error instanceof Error && error.message.includes(start),
  );
});
