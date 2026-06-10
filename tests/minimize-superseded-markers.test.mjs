import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  computeExitCode,
  isTrustedAuthor,
  resolveTrustedActors,
} from '../scripts/minimize-superseded-markers.mjs';

test('computeExitCode returns 0 when no failures', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 2,
        applied: 2,
        failed: 0,
        alreadyMinimized: 0,
        cannotMinimize: 0,
        untrusted: 0,
      },
    }),
    0,
  );
});

test('computeExitCode returns 1 when any item failed', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 2,
        applied: 1,
        failed: 1,
        alreadyMinimized: 0,
        cannotMinimize: 0,
        untrusted: 0,
      },
    }),
    1,
  );
});

test('computeExitCode returns 0 even when all candidates were skipped', () => {
  assert.equal(
    computeExitCode({
      counts: {
        eligible: 0,
        applied: 0,
        failed: 0,
        alreadyMinimized: 1,
        cannotMinimize: 1,
        untrusted: 1,
      },
    }),
    0,
  );
});

test('isTrustedAuthor matches case-insensitively', () => {
  const trusted = new Set(['kurone-kito', 'copilot']);
  assert.equal(isTrustedAuthor('kurone-kito', trusted), true);
  assert.equal(isTrustedAuthor('Kurone-Kito', trusted), true);
  assert.equal(isTrustedAuthor('CoPilot', trusted), true);
});

test('isTrustedAuthor rejects unknown logins', () => {
  const trusted = new Set(['kurone-kito']);
  assert.equal(isTrustedAuthor('random-user', trusted), false);
  assert.equal(isTrustedAuthor('', trusted), false);
  assert.equal(isTrustedAuthor(null, trusted), false);
  assert.equal(isTrustedAuthor(undefined, trusted), false);
});

test('isTrustedAuthor returns false when trusted set is empty', () => {
  const trusted = new Set();
  assert.equal(isTrustedAuthor('kurone-kito', trusted), false);
});

test('resolveTrustedActors follows flag > env > config precedence', () => {
  const config = { trustedMarkerActors: ['config-actor'] };
  assert.deepEqual(
    resolveTrustedActors({
      flagValue: 'Flag-Actor',
      envValue: 'env-actor',
      config,
    }),
    { actors: ['flag-actor'], source: 'flag' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: 'Env-Actor', config }),
    { actors: ['env-actor'], source: 'env' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: '', config }),
    { actors: ['config-actor'], source: 'config' },
  );
  assert.deepEqual(
    resolveTrustedActors({ flagValue: '', envValue: '', config: null }),
    { actors: [], source: 'none' },
  );
});

test('config-only resolution passes the author gate end to end', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-minimize-'));
  try {
    mkdirSync(join(sandbox, '.github/idd'), { recursive: true });
    writeFileSync(
      join(sandbox, '.github/idd/config.json'),
      JSON.stringify({ trustedMarkerActors: ['kurone-kito'] }),
    );
    // Stub gh so the run is deterministic and offline: probe failures
    // surface as per-item failures (exit 1), never the author-gate
    // configuration error (exit 2).
    const binDir = join(sandbox, 'bin');
    mkdirSync(binDir);
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(binDir, 'gh'), 0o755);

    const script = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'scripts',
      'minimize-superseded-markers.mjs',
    );
    const result = spawnSync(
      process.execPath,
      [script, '--subject-ids', 'IC_test', '--format', 'json'],
      {
        cwd: sandbox,
        env: {
          ...process.env,
          PATH: binDir,
          IDD_TRUSTED_MARKER_ACTORS: '',
        },
        encoding: 'utf8',
      },
    );

    assert.notEqual(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.trustedMarkerActorsSource, 'config');
    assert.deepEqual(report.trustedMarkerActors, ['kurone-kito']);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
