import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  classifyInstallDepsOutcome,
  classifyPnpmVersionCheck,
  describeCorepackGuidance,
  describePnpmVersionMismatch,
  parsePnpmMajorFromPackageManager,
  parsePnpmMajorFromVersionOutput,
  parsePnpmVersionToken,
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

test('parsePnpmMajorFromPackageManager extracts the major from a pnpm pin', () => {
  assert.equal(parsePnpmMajorFromPackageManager('pnpm@12.4.1+sha512-abc'), 12);
});

test('parsePnpmMajorFromPackageManager returns null for a non-pnpm packageManager', () => {
  assert.equal(parsePnpmMajorFromPackageManager('yarn@4.0.0'), null);
  assert.equal(parsePnpmMajorFromPackageManager('npm@10.2.0'), null);
});

test('parsePnpmMajorFromPackageManager returns null when the field is absent', () => {
  assert.equal(parsePnpmMajorFromPackageManager(undefined), null);
});

test('parsePnpmMajorFromVersionOutput extracts the major from a plain version string', () => {
  assert.equal(parsePnpmMajorFromVersionOutput('12.4.1\n'), 12);
});

test('parsePnpmMajorFromVersionOutput tolerates incidental output around the version token', () => {
  // A corepack first-run banner line ahead of the version, plus a trailing
  // CRLF, must not break parsing (#3043 critique finding).
  assert.equal(
    parsePnpmMajorFromVersionOutput(
      'Preparing pnpm@11.9.0 for first use\n11.9.0\r\n',
    ),
    11,
  );
});

test('parsePnpmMajorFromVersionOutput returns null when no version-like token is present', () => {
  assert.equal(parsePnpmMajorFromVersionOutput('command not found'), null);
});

test('parsePnpmMajorFromVersionOutput does not mistake a version-shaped preamble for the real version', () => {
  // Copilot review finding on PR #3053: a naive first-match-anywhere regex
  // read "corepack 0.30.0" as the resolved pnpm version (major 0) instead
  // of the real "12.4.1" on the next line, because "0.30.0" is embedded in
  // a longer preamble line, not a line consisting solely of the version.
  assert.equal(
    parsePnpmMajorFromVersionOutput('corepack 0.30.0\n12.4.1\n'),
    12,
  );
});

test('parsePnpmMajorFromVersionOutput does not mistake trailing notifier text for the real version', () => {
  // The mirror case of the preamble finding above: a hypothetical
  // update-notifier line *after* the real version must not win either.
  // Deliberately uses different majors (13/14) on the notifier line than
  // the real version (12): a same-major trailing example would pass
  // under a naive substring-anywhere match too and prove nothing (E10
  // critique finding on PR #3053 -- the original version of this test
  // used matching majors throughout and was tautological). "13.0.0" and
  // "14.0.0" here are embedded in a longer line, not their own bare-
  // version line, so only the real "12.4.1" line qualifies.
  assert.equal(
    parsePnpmMajorFromVersionOutput(
      '12.4.1\nUpdate available! 13.0.0 -> 14.0.0\n',
    ),
    12,
  );
});

test('parsePnpmVersionToken returns the last bare-version line, not the first version-shaped substring', () => {
  assert.equal(parsePnpmVersionToken('corepack 0.30.0\n12.4.1\n'), '12.4.1');
});

test('parsePnpmVersionToken returns null when no line consists solely of a bare version', () => {
  assert.equal(parsePnpmVersionToken('corepack 0.30.0'), null);
});

test('parsePnpmVersionToken preserves a SemVer prerelease suffix', () => {
  assert.equal(parsePnpmVersionToken('12.4.1-rc.1\n'), '12.4.1-rc.1');
});

test('parsePnpmVersionToken preserves a SemVer build-metadata suffix', () => {
  assert.equal(parsePnpmVersionToken('12.4.1+abc123\n'), '12.4.1+abc123');
});

test('parsePnpmMajorFromVersionOutput extracts the major from a prerelease version', () => {
  assert.equal(parsePnpmMajorFromVersionOutput('12.4.1-rc.1\n'), 12);
});

test('classifyPnpmVersionCheck returns not-applicable when packageManager does not pin pnpm', () => {
  assert.deepEqual(classifyPnpmVersionCheck(null, '12.4.1'), {
    status: 'not-applicable',
  });
});

test('classifyPnpmVersionCheck returns match when majors are equal', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, '12.4.1'), {
    status: 'match',
    requiredMajor: 12,
    detectedVersion: '12.4.1',
  });
});

test('classifyPnpmVersionCheck returns mismatch when majors differ', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, '11.9.0'), {
    status: 'mismatch',
    requiredMajor: 12,
    detectedVersion: '11.9.0',
  });
});

test('classifyPnpmVersionCheck returns undetermined when the resolved version could not be read', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, null), {
    status: 'undetermined',
    requiredMajor: 12,
  });
});

test('classifyPnpmVersionCheck returns undetermined when the resolved version output is unparseable', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, 'command not found'), {
    status: 'undetermined',
    requiredMajor: 12,
  });
});

test('classifyPnpmVersionCheck reports the clean parsed version, not the raw multi-line output, on a mismatch', () => {
  // E2 critique finding on PR #3053: detectedVersion previously echoed the
  // whole trimmed raw output rather than the parsed token, so a mismatch
  // against noisy output would have dumped a multi-line blob into the
  // actionable error message instead of naming a single clean version.
  assert.deepEqual(
    classifyPnpmVersionCheck(
      12,
      'Preparing pnpm@11.9.0 for first use\n11.9.0\r\n',
    ),
    { status: 'mismatch', requiredMajor: 12, detectedVersion: '11.9.0' },
  );
});

test('classifyPnpmVersionCheck returns match for a matching-major prerelease version', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, '12.4.1-rc.1\n'), {
    status: 'match',
    requiredMajor: 12,
    detectedVersion: '12.4.1-rc.1',
  });
});

test('classifyPnpmVersionCheck returns mismatch for a mismatched-major prerelease version', () => {
  assert.deepEqual(classifyPnpmVersionCheck(12, '11.9.0-rc.1\n'), {
    status: 'mismatch',
    requiredMajor: 12,
    detectedVersion: '11.9.0-rc.1',
  });
});

test('describePnpmVersionMismatch names both the detected and required versions', () => {
  const message = describePnpmVersionMismatch('11.9.0', 12);
  assert.match(message, /11\.9\.0/);
  assert.match(message, /12\.x/);
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

/**
 * Writes a fake, executable `pnpm` script into `binDir` that prints
 * `stdout` verbatim (a bare version, or a multi-line banner-plus-version
 * blob), so the CLI's `pnpm --version` shell-out resolves to a controlled
 * value regardless of whether real pnpm/corepack are present on this
 * host. Emits each line as its own single-quoted `printf` argument rather
 * than shelling out to `cat` on a data file: the isolated PATH below
 * deliberately contains no external binaries at all (not even `cat`), so
 * the script may use only POSIX shell builtins (`printf`, `echo`) to
 * produce its output. POSIX-only (shebang + executable bit) -- callers
 * skip this on win32, mirroring the absent-corepack isolation test above.
 */
function writeFakePnpmScript(binDir: string, stdout: string): void {
  const content = stdout.endsWith('\n') ? stdout : `${stdout}\n`;
  const lines = content.split('\n');
  lines.pop(); // drop the trailing empty segment after the final newline
  const quotedLines = lines
    .map((line) => `'${line.replace(/'/g, `'\\''`)}'`)
    .join(' ');
  const scriptPath = join(binDir, 'pnpm');
  writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s\\n' ${quotedLines}\n`);
  chmodSync(scriptPath, 0o755);
}

/**
 * Runs the CLI in an isolated cwd carrying a `package.json` with the given
 * `packageManager` pin, and an isolated PATH containing only a `node`
 * symlink and a fake `pnpm` script printing `fakePnpmStdout` (a bare
 * version, or noisier multi-line output). Mirrors the absent-corepack
 * isolation test's PATH-replacement approach so the pnpm-version check is
 * exercised deterministically, independent of the host's real
 * corepack/pnpm state.
 */
function runCliWithFakePnpm(
  installCommand: string,
  packageManagerField: string,
  fakePnpmStdout: string,
): CliRun {
  const cwd = mkdtempSync(join(tmpdir(), 'idd-verify-install-deps-'));
  const isolatedBin = mkdtempSync(join(tmpdir(), 'idd-fake-pnpm-bin-'));
  const callLog = join(cwd, '.call-log');
  try {
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ packageManager: packageManagerField }),
    );
    symlinkSync(process.execPath, join(isolatedBin, 'node'));
    writeFakePnpmScript(isolatedBin, fakePnpmStdout);
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
        env: { PATH: isolatedBin, CALL_LOG: callLog },
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
    rmSync(isolatedBin, { recursive: true, force: true });
  }
}

test('CLI: pnpm-version check passes and proceeds to install when the resolved major matches packageManager', {
  skip: process.platform === 'win32',
}, () => {
  const { status, attempts, stderr } = runCliWithFakePnpm(
    fakeInstallCommand(1),
    'pnpm@12.4.1+sha512-fakehash',
    '12.4.1',
  );
  assert.equal(status, 0);
  assert.equal(attempts, 1);
  assert.doesNotMatch(stderr, /does not satisfy/);
});

test('CLI: pnpm-version check fails fast with an actionable message on a major mismatch, before any install attempt', {
  skip: process.platform === 'win32',
}, () => {
  const { status, attempts, stderr } = runCliWithFakePnpm(
    fakeInstallCommand(1),
    'pnpm@12.4.1+sha512-fakehash',
    '11.9.0',
  );
  assert.equal(status, 1);
  // The install command must never run at all on a mismatch.
  assert.equal(attempts, 0);
  assert.match(stderr, /resolved pnpm 11\.9\.0 does not satisfy/);
  assert.match(stderr, /pnpm 12\.x major/);
});

test('CLI: pnpm-version mismatch message names the clean parsed version, not raw banner noise, end-to-end', {
  skip: process.platform === 'win32',
}, () => {
  // Closes the loop on both #3053 review findings at the CLI level: the
  // fake pnpm here prints a corepack-style banner ahead of a mismatched
  // real version, and the actionable error must name only the clean
  // "11.9.0" token, never the banner line.
  const { status, attempts, stderr } = runCliWithFakePnpm(
    fakeInstallCommand(1),
    'pnpm@12.4.1+sha512-fakehash',
    'Preparing pnpm@11.9.0 for first use\n11.9.0\n',
  );
  assert.equal(status, 1);
  assert.equal(attempts, 0);
  assert.match(stderr, /resolved pnpm 11\.9\.0 does not satisfy/);
  assert.doesNotMatch(stderr, /Preparing pnpm@11\.9\.0 for first use/);
});

test('CLI: pnpm-version check is a no-op when package.json has no packageManager field (existing missing-after-retry path unaffected)', () => {
  const { status, attempts, stderr } = runCli(fakeInstallCommand(99));
  assert.equal(status, 1);
  assert.equal(attempts, 2);
  assert.doesNotMatch(stderr, /does not satisfy/);
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
