import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DIRECT_GH_SPAWN_PATTERN,
  GH_SPAWN_EXEMPT_FILES,
} from '../src/scripts/lint-source-boundaries.mts';

// Detector regressions for #1675's acceptance criterion: `gh-exec.mts` is the
// shared `gh` execution layer (bounded default timeout, NDJSON-safe
// pagination), and every other src/scripts/*.mts helper must route its `gh`
// subprocess calls through it instead of spawning `gh` directly. Before
// #1675, 30 call sites across 22 files bypassed gh-exec.mts entirely (none of
// them timed out). The whole-tree scan is the GH-SPAWN-DIRECT rule of
// scripts/lint-source-boundaries.mjs (#3748); this file keeps the matcher
// cases and pins the exemption list.

test('DIRECT_GH_SPAWN_PATTERN matches every documented direct-spawn shape', () => {
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFileSync('gh', args, {})`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFileSync("gh", args, {})`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFile('gh', args, cb)`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`spawnSync('gh', args)`));
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`  execFileSync(  'gh' , args)`));
  assert.ok(
    DIRECT_GH_SPAWN_PATTERN.test(`childProcess.execFileSync('gh', args)`),
  );
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`cp.spawnSync('gh', args)`));
  assert.ok(!DIRECT_GH_SPAWN_PATTERN.test(`execFileSync('git', args, {})`));
  assert.ok(
    !DIRECT_GH_SPAWN_PATTERN.test(`childProcess.execFileSync('git', args)`),
  );
  assert.ok(DIRECT_GH_SPAWN_PATTERN.test(`execFileSync\n  ('gh', args)`));
  assert.ok(!DIRECT_GH_SPAWN_PATTERN.test(`ghText(args)`));
});

test('the direct-spawn exemption stays the two documented files', () => {
  // `minimize-superseded-markers.mts` ships standalone in idd-template/scripts/
  // with zero local imports, so it cannot import gh-exec.mts and keeps its own
  // runner with the same bounded default timeout (#1675). Widening this set
  // reopens the bypass the rule exists to close.
  assert.deepEqual([...GH_SPAWN_EXEMPT_FILES].sort(), [
    'gh-exec.mts',
    'minimize-superseded-markers.mts',
  ]);
});
