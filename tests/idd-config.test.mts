import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadIddConfig } from '../src/scripts/idd-config.mts';

// Every scenario runs inside its own freshly `mkdtempSync`-created sandbox
// (never the real repo cwd) so each gets a distinct resolved config path —
// this is what lets loadIddConfig's per-path memoization coexist safely with
// per-test isolation (mirrors the sandboxing already used by
// forced-handoff-marker.test.mts's `forcedHandoff.mode` tests).
function withSandboxCwd<T>(run: (sandbox: string) => T): T {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-idd-config-test-'));
  process.chdir(sandbox);
  try {
    return run(sandbox);
  } finally {
    process.chdir(originalCwd);
  }
}

function writeConfig(sandbox: string, body: string): void {
  mkdirSync(join(sandbox, '.github', 'idd'), { recursive: true });
  writeFileSync(join(sandbox, '.github', 'idd', 'config.json'), body);
}

test('loadIddConfig returns null when the config file is missing', () => {
  withSandboxCwd(() => {
    assert.equal(loadIddConfig(), null);
  });
});

test('loadIddConfig returns null on invalid JSON', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{ not valid json');
    assert.equal(loadIddConfig(), null);
  });
});

test('loadIddConfig parses a valid config file', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(
      sandbox,
      JSON.stringify({
        trustedMarkerActors: ['kurone-kito'],
        advisoryBotLogins: ['coderabbitai[bot]'],
      }),
    );
    assert.deepEqual(loadIddConfig(), {
      trustedMarkerActors: ['kurone-kito'],
      advisoryBotLogins: ['coderabbitai[bot]'],
    });
  });
});

test('loadIddConfig memoizes per resolved path: a later on-disk edit is not observed', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['first'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['first'] });

    // Overwrite the same file at the same resolved path — memoization means
    // this change must not be observed by a later call from this same cwd.
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['second'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['first'] });
  });
});

test('loadIddConfig reads fresh content for a different resolved path (a different sandbox)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['third'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['third'] });
  });
});
