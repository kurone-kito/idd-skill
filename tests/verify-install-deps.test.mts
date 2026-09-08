import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyInstallDepsOutcome,
  describeCorepackGuidance,
} from '../src/scripts/verify-install-deps.mts';

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

test('describeCorepackGuidance returns null when corepack is available', () => {
  assert.equal(describeCorepackGuidance(true), null);
});

test('describeCorepackGuidance hints at installing corepack when absent', () => {
  const hint = describeCorepackGuidance(false);
  assert.match(hint ?? '', /corepack was not found/);
  assert.match(hint ?? '', /npm install -g corepack/);
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
 * A `node -e` one-liner (run via the platform shell, same as the tool's own
 * runInstallCommand) that counts its own invocations via CALL_LOG and, once
 * `calls` reaches `hitOnAttempt`, creates KEY_BINARY. `exitNonZeroBefore`
 * optionally makes every call before that attempt exit 1, to simulate a hard
 * install failure. Using `node -e` instead of POSIX shell syntax (`[ -f ... ]`,
 * `wc -l`, `mkdir -p`) means the same generated string works whether
 * `execFileSync(installCommand, [], { shell: true })` invokes `/bin/sh`
 * (POSIX) or `cmd.exe` (Windows) -- the script body uses only single-quoted
 * JS string literals and no `$`/`%...%` shell-expansion syntax, so the whole
 * `-e` argument can be safely double-quoted for either shell.
 */
function fakeInstallCommand(
  hitOnAttempt: number,
  exitNonZeroBefore = false,
): string {
  const script = [
    "const fs = require('fs')",
    'const p = process.env.CALL_LOG',
    'let calls = 0',
    "try { calls = fs.readFileSync(p, 'utf8').split('\\n').filter(Boolean).length } catch {}",
    'calls += 1',
    "fs.appendFileSync(p, 'x\\n')",
    `if (calls >= ${hitOnAttempt}) { fs.mkdirSync('node_modules/.bin', { recursive: true }); fs.writeFileSync('${KEY_BINARY}', ''); process.exit(0) }`,
    exitNonZeroBefore ? 'process.exit(1)' : 'process.exit(0)',
  ].join('; ');
  return `node -e "${script}"`;
}

/**
 * Same probe the CLI itself runs (`isCorepackAvailable` in
 * verify-install-deps.mts): whether *this* environment actually has
 * corepack, so tests can assert against reality instead of assuming a
 * dev-machine default. `engines.node` supports Node 26.x, which does
 * not bundle corepack, so this can genuinely be false in CI.
 */
function isCorepackOnPath(): boolean {
  return (
    spawnSync('corepack', ['--version'], { shell: true, stdio: 'ignore' })
      .status === 0
  );
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
  // The corepack hint's presence mirrors this environment's own
  // corepack availability -- asserting a fixed expectation here would
  // be wrong on a Node >=25 runner with no corepack installed, exactly
  // the population this issue exists to help. See the isolated-PATH
  // test below for a deterministic check of the absent-corepack path.
  if (isCorepackOnPath()) {
    assert.doesNotMatch(stderr, /corepack was not found/);
  } else {
    assert.match(stderr, /corepack was not found/);
  }
});

test('CLI: hints at installing corepack when it is absent from PATH', {
  skip: process.platform === 'win32',
}, () => {
  // Deterministic, environment-independent check for the absent-corepack
  // path: isolate PATH down to a directory containing only a `node`
  // symlink, so `isCorepackAvailable()`'s `corepack --version` probe
  // genuinely fails regardless of whether this host has corepack
  // installed. Skipped on win32: symlinking an executable there needs
  // elevated privilege or Developer Mode, which CI cannot assume.
  const cwd = mkdtempSync(join(tmpdir(), 'idd-verify-install-deps-'));
  const isolatedBin = mkdtempSync(join(tmpdir(), 'idd-no-corepack-bin-'));
  const callLog = join(cwd, '.call-log');
  try {
    symlinkSync(process.execPath, join(isolatedBin, 'node'));
    const result = spawnSync(
      'node',
      [
        CLI_ENTRY,
        '--key-binary',
        KEY_BINARY,
        '--install-command',
        fakeInstallCommand(99),
      ],
      {
        cwd,
        env: { PATH: isolatedBin, CALL_LOG: callLog },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? '', /corepack was not found/);
    assert.match(result.stderr ?? '', /npm install -g corepack/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(isolatedBin, { recursive: true, force: true });
  }
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
