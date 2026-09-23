import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

import { assertEntrySignal } from '../src/scripts/node-runtime-guard.mts';

// #3240: `import.meta.main` is `undefined` -- not `false` -- on a Node
// release that predates it (v20.20.2/v22.17.1/v24.1.0 confirmed live), so
// assertEntrySignal() must fail loudly for exactly that "not a boolean"
// shape, and stay a silent no-op for the two real boolean shapes
// `import.meta.main` takes on a supported runtime.

test('assertEntrySignal returns without exiting when meta.main is true', () => {
  assert.doesNotThrow(() => assertEntrySignal({ main: true }));
});

test('assertEntrySignal returns without exiting when meta.main is false', () => {
  assert.doesNotThrow(() => assertEntrySignal({ main: false }));
});

test('assertEntrySignal({}) exits 1 with a stderr line naming process.version and the engines range', () => {
  // Spawned as a real subprocess (rather than stubbing process.exit in this
  // process) so the actual exit-code/stderr contract is what's asserted,
  // not a mocked stand-in for it. Dynamic import() of the real .mts module
  // relies on Node's unflagged type stripping (unflagged since 22.18,
  // matching this repository's own engines.node floor); the module's own
  // top-level `assertEntrySignal(import.meta)` call runs harmlessly first
  // here, since the dynamically-imported module is never the process's
  // "main" module and Node still reports a boolean `import.meta.main` for
  // it on this test's own supported runtime.
  const guardModuleUrl = new URL(
    '../src/scripts/node-runtime-guard.mts',
    import.meta.url,
  ).href;
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [
          '-e',
          `import(${JSON.stringify(guardModuleUrl)}).then(({ assertEntrySignal }) => { assertEntrySignal({}); });`,
        ],
        { encoding: 'utf8', timeout: 30_000 },
      );
    },
    (error: unknown) => {
      const status = (error as { status?: unknown }).status;
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      assert.equal(status, 1);
      assert.ok(
        stderr.includes(process.version),
        `expected stderr to name process.version (${process.version}): ${stderr}`,
      );
      assert.ok(
        stderr.includes('^22.23.2 || ^24.2.0 || >=26.0.0'),
        `expected stderr to name the engines.node range: ${stderr}`,
      );
      return true;
    },
  );
});
