import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { platform } from 'node:process';
import { test } from 'node:test';

import { loadIddConfig, loadPolicyConfig } from '../src/scripts/idd-config.mts';

// Every scenario runs inside its own freshly `mkdtempSync`-created sandbox
// (never the real repo cwd), mirroring the sandboxing already used by
// forced-handoff-marker.test.mts's `forcedHandoff.mode` tests.
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

test('loadIddConfig always re-reads the file: a later on-disk edit in the same cwd is observed', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['first'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['first'] });

    // Overwrite the same file in the same cwd — a caller that reads config
    // more than once per process (e.g. idd-merge-execute.mts's deliberate
    // "re-validate immediately before merging" second pass) must observe
    // this edit, not a stale cached value.
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['second'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['second'] });
  });
});

test('loadIddConfig reads fresh content for a different cwd (a different sandbox)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['third'] }));
    assert.deepEqual(loadIddConfig(), { trustedMarkerActors: ['third'] });
  });
});

// loadPolicyConfig (#1721): explicit-path-aware reader for the nine
// --policy/--config-aware helpers, with stricter default-path semantics
// than loadIddConfig above (see that function's doc comment).

test('loadPolicyConfig default path: returns { config: null } when the file is genuinely absent (ENOENT)', () => {
  withSandboxCwd((sandbox) => {
    const result = loadPolicyConfig();
    assert.equal(result.config, null);
    assert.equal(result.path, resolve(sandbox, '.github/idd/config.json'));
  });
});

test('loadPolicyConfig default path: parses a valid config and resolves an absolute path', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['a'] }));
    const result = loadPolicyConfig();
    assert.deepEqual(result.config, { trustedMarkerActors: ['a'] });
    assert.equal(result.path, resolve(sandbox, '.github/idd/config.json'));
  });
});

test('loadPolicyConfig default path: throws (does not silently default) on malformed JSON', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '{ not valid json');
    assert.throws(
      () => loadPolicyConfig(),
      /failed to load policy from .*config\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a nonexistent file, naming the path', () => {
  withSandboxCwd(() => {
    assert.throws(
      () => loadPolicyConfig('does-not-exist.json'),
      /failed to load policy from .*does-not-exist\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: throws on malformed JSON, naming the path', () => {
  withSandboxCwd((sandbox) => {
    const badPath = join(sandbox, 'bad-policy.json');
    writeFileSync(badPath, '{ not valid json');
    assert.throws(
      () => loadPolicyConfig('bad-policy.json'),
      /failed to load policy from .*bad-policy\.json: /,
    );
  });
});

test('loadPolicyConfig explicit path: parses a valid config and resolves it against cwd', () => {
  withSandboxCwd((sandbox) => {
    const goodPath = join(sandbox, 'good-policy.json');
    writeFileSync(goodPath, JSON.stringify({ markerPrefix: 'custom' }));
    const result = loadPolicyConfig('good-policy.json');
    assert.deepEqual(result.config, { markerPrefix: 'custom' });
    assert.equal(result.path, resolve(sandbox, 'good-policy.json'));
  });
});

test('loadPolicyConfig explicit path: an empty string is treated as "no explicit path" (default-path ENOENT semantics)', () => {
  withSandboxCwd(() => {
    const result = loadPolicyConfig('');
    assert.equal(result.config, null);
  });
});

// Regression coverage for a Copilot review finding on PR #1776:
// `JSON.parse('null')` succeeds (it does not throw), so an existing config
// file whose top-level JSON value is `null` (or any other non-object, e.g.
// an array) previously flowed through the success path unchecked and
// returned `{ config: null }` -- indistinguishable from this function's own
// "absent" sentinel, silently reopening the fail-open gap this function
// exists to close.

test('loadPolicyConfig default path: throws on a top-level JSON null (existing file, not ENOENT)', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, 'null');
    assert.throws(
      () => loadPolicyConfig(),
      /failed to load policy from .*config\.json: expected a JSON object at the top level, got null/,
    );
  });
});

test('loadPolicyConfig default path: throws on a top-level JSON array', () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, '[]');
    assert.throws(
      () => loadPolicyConfig(),
      /expected a JSON object at the top level, got an array/,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a top-level JSON null, naming the path', () => {
  withSandboxCwd((sandbox) => {
    const nullPath = join(sandbox, 'null-policy.json');
    writeFileSync(nullPath, 'null');
    assert.throws(
      () => loadPolicyConfig('null-policy.json'),
      /failed to load policy from .*null-policy\.json: expected a JSON object at the top level, got null/,
    );
  });
});

test('loadPolicyConfig explicit path: throws on a top-level JSON number', () => {
  withSandboxCwd((sandbox) => {
    const numberPath = join(sandbox, 'number-policy.json');
    writeFileSync(numberPath, '42');
    assert.throws(
      () => loadPolicyConfig('number-policy.json'),
      /expected a JSON object at the top level, got a number/,
    );
  });
});

// Permission-denied is a distinct failure from ENOENT and must throw on the
// default path too (never silently treated as "absent"). Skipped when
// running as root or on a platform where chmod does not restrict the
// owning user's own read access (root ignores POSIX permission bits;
// Windows chmod semantics differ).
const canTestPermissionDenied =
  platform !== 'win32' &&
  typeof process.getuid === 'function' &&
  process.getuid() !== 0;

test('loadPolicyConfig default path: throws (not silently absent) on a permission error', {
  skip: !canTestPermissionDenied,
}, () => {
  withSandboxCwd((sandbox) => {
    writeConfig(sandbox, JSON.stringify({ trustedMarkerActors: ['x'] }));
    const configPath = join(sandbox, '.github', 'idd', 'config.json');
    chmodSync(configPath, 0o000);
    try {
      assert.throws(
        () => loadPolicyConfig(),
        /failed to load policy from .*config\.json: /,
      );
    } finally {
      chmodSync(configPath, 0o644);
    }
  });
});
