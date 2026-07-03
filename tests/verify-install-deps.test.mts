import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyInstallDepsOutcome } from '../src/scripts/verify-install-deps.mts';

test('present-after-install when the key binary exists before any retry', () => {
  assert.deepEqual(classifyInstallDepsOutcome(true, false), {
    status: 'present-after-install',
  });
});

test('present-after-install ignores existsAfterRetry when already present (retry never ran)', () => {
  assert.deepEqual(classifyInstallDepsOutcome(true, true), {
    status: 'present-after-install',
  });
});

test('recovered-after-retry when the retry install produced the binary', () => {
  assert.deepEqual(classifyInstallDepsOutcome(false, true), {
    status: 'recovered-after-retry',
  });
});

test('missing-after-retry when the binary is still absent after the retry', () => {
  assert.deepEqual(classifyInstallDepsOutcome(false, false), {
    status: 'missing-after-retry',
  });
});

// ---------------------------------------------------------------------------
// CLI integration: spawn the emitted scripts/verify-install-deps.mjs (what
// install-deps actually runs) with a fabricated --install-command, mirroring
// the docs/typescript-sources.md convention of exercising the emitted
// artifact rather than only the typed source.
// ---------------------------------------------------------------------------

const CLI_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'verify-install-deps.mjs',
);
const KEY_BINARY = 'node_modules/.bin/tsc';

/**
 * A shell one-liner (run via `sh -c`, same as the tool's own runInstallCommand)
 * that counts its own invocations via CALL_LOG and, once `calls` reaches
 * `hitOnAttempt`, creates KEY_BINARY. `exitNonZeroBefore` optionally makes
 * every call before that attempt exit 1, to simulate a hard install failure.
 */
function fakeInstallCommand(
  hitOnAttempt: number,
  exitNonZeroBefore = false,
): string {
  return [
    'calls=0',
    '[ -f "$CALL_LOG" ] && calls=$(wc -l < "$CALL_LOG" | tr -d \' \')',
    'echo x >> "$CALL_LOG"',
    'calls=$((calls + 1))',
    `if [ "$calls" -ge ${hitOnAttempt} ]; then mkdir -p node_modules/.bin && touch ${KEY_BINARY}; exit 0; fi`,
    exitNonZeroBefore ? 'exit 1' : 'exit 0',
  ].join('; ');
}

interface CliRun {
  status: number | null;
  stderr: string;
  attempts: number;
}

function runCli(installCommand: string): CliRun {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-verify-install-deps-'));
  const callLog = join(cwd, '.call-log');
  try {
    const result = spawnSync(
      'node',
      [
        CLI_ENTRY,
        '--key-binary',
        KEY_BINARY,
        '--install-command',
        installCommand,
      ],
      {
        cwd,
        env: { ...process.env, CALL_LOG: callLog },
        encoding: 'utf8',
      },
    );
    let attempts = 0;
    try {
      attempts = readFileSync(callLog, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0).length;
    } catch {
      attempts = 0;
    }
    return { status: result.status, stderr: result.stderr ?? '', attempts };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('CLI: exits 0 with a single attempt when the binary is present after install', () => {
  const { status, attempts } = runCli(fakeInstallCommand(1));
  assert.equal(status, 0);
  assert.equal(attempts, 1);
});

test('CLI: retries exactly once and exits 0 when the binary appears on the second attempt', () => {
  const { status, attempts, stderr } = runCli(fakeInstallCommand(2));
  assert.equal(status, 0);
  assert.equal(attempts, 2);
  assert.match(stderr, /missing or install failed; retrying/);
  assert.match(stderr, /present after retry/);
});

test('CLI: retries once and recovers when the install command itself fails on the first attempt', () => {
  const { status, attempts } = runCli(fakeInstallCommand(2, true));
  assert.equal(status, 0);
  assert.equal(attempts, 2);
});

test('CLI: exits 1 with an actionable message when the binary never appears', () => {
  const { status, attempts, stderr } = runCli(fakeInstallCommand(99));
  assert.equal(status, 1);
  // Never a third attempt: "retry exactly once" is a hard ceiling.
  assert.equal(attempts, 2);
  assert.match(stderr, /still missing after retrying/);
  assert.match(stderr, /retry manually/);
});

test('CLI: --help prints usage and exits 0 without running any install', () => {
  const result = spawnSync('node', [CLI_ENTRY, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test('CLI: exits non-zero with a clear error when a required argument is missing', () => {
  const result = spawnSync('node', [CLI_ENTRY, '--install-command', 'true'], {
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--key-binary is required/);
});
