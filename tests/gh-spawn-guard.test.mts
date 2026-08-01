import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';

import { readText } from './test-utils.mts';

// Guard for #1675's acceptance criterion: `gh-exec.mts` is the shared `gh`
// execution layer (bounded default timeout, NDJSON-safe pagination), and
// every other src/scripts/*.mts helper must route its `gh` subprocess calls
// through it instead of spawning `gh` directly. Before #1675, 30 call sites
// across 22 files bypassed gh-exec.mts entirely (none of them timed out).
// This test fails the moment a direct `gh` spawn is reintroduced anywhere
// else, so the pattern documented here can't silently return.

const SCRIPTS_ROOT_URL = new URL('../src/scripts/', import.meta.url);

/**
 * `minimize-superseded-markers.mts` is deliberately self-contained (see its
 * own top-of-file comment and `docs/idd-helper-scripts.md`): it ships
 * standalone in `idd-template/scripts/` with zero local imports, so the
 * template copy works without `gh-exec.mjs`/`protocol-helpers.mjs`. It
 * cannot import gh-exec.mts and keeps its own local `runGh` instead, which
 * carries the same bounded default timeout directly (#1675) rather than by
 * delegation. This is the one narrow, documented exception to the
 * route-through-gh-exec rule below.
 */
const EXEMPT_FILES = new Set([
  'gh-exec.mts',
  'minimize-superseded-markers.mts',
]);

/**
 * Matches a direct `execFileSync('gh', …)`, `execFile('gh', …)`, or
 * `spawnSync('gh', …)` call — the exact three forms named in #1675's
 * acceptance criteria — with `'gh'`/`"gh"` as the literal first argument.
 * Does not catch an indirect alias (e.g. `const run = promisify(execFile);
 * run('gh', …)`); the migration this guards eliminated every such alias, so
 * catching that indirection is out of scope for this literal-call check.
 */
const DIRECT_GH_SPAWN_PATTERN =
  /\b(?:execFileSync|execFile|spawnSync)\s*\(\s*(['"])gh\1/;

/** Every `.mts` file name (not path) directly under `src/scripts/`. */
function findScriptFiles(): string[] {
  return readdirSync(SCRIPTS_ROOT_URL, { encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.mts'))
    .sort();
}

test('src/scripts has at least one file to guard', () => {
  // Guards the derivation itself: if this set ever drops to zero, the test
  // below would pass vacuously without checking anything.
  assert.ok(findScriptFiles().length > 0);
});

test('DIRECT_GH_SPAWN_PATTERN matches every documented direct-spawn shape', () => {
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFileSync('gh', args, {})`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFileSync("gh", args, {})`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFile('gh', args, cb)`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`spawnSync('gh', args)`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`  execFileSync(  'gh' , args)`));
  assert.ok(!DIRECT_GH_SPAWN_PATTERN.test(`execFileSync('git', args, {})`));
  assert.ok(!DIRECT_GH_SPAWN_PATTERN.test(`ghText(args)`));
});

test('no module under src/scripts other than gh-exec.mts (and the documented minimize-superseded-markers.mts exception) spawns `gh` directly (#1675)', () => {
  const violations: string[] = [];
  for (const fileName of findScriptFiles()) {
    if (EXEMPT_FILES.has(fileName)) {
      continue;
    }
    const source = readText(`src/scripts/${fileName}`);
    if (DIRECT_GH_SPAWN_PATTERN.test(source)) {
      violations.push(fileName);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `route every gh subprocess call through gh-exec.mts's ghText / ` +
      `safeGhText / ghApiJson / ghTextAsync instead of spawning gh ` +
      `directly; found direct spawn(s) in: ${violations.join(', ')}`,
  );
});
