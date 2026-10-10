import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatBundleReportLine,
  injectGeneratedFromBanner,
} from '../src/scripts/consistency-helpers.mts';
import { fixtureEnv } from './test-utils.mts';

// `audit-docs --check --report` prints one `report:` line per bundle that
// checkBundleBudgets measures. The line formatter is pure and tested directly;
// the CLI cases drive scripts/audit-docs.mjs against a minimal git fixture,
// the same way tests/audit-docs-near-ceiling-ratchet.test.mts does, so the
// byte count comes from the real measurement path (banner stripped, UTF-8).

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMMIT_ENV = {
  ...fixtureEnv(),
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runAudit(cwd: string, args: readonly string[]): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'audit-docs.mjs'), ...args],
      {
        cwd,
        env: fixtureEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

function reportLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('report:'));
}

// A body of exactly `bytes` UTF-8 bytes, ending in a newline.
function bodyOfBytes(bytes: number): string {
  return `${'a'.repeat(bytes - 1)}\n`;
}

const CEILING = {
  id: 'fixture-ceiling',
  maxBundleLimitBytes: 1_000_000,
  maxUtilizationPct: 98,
  noticeUtilizationPct: 95,
};

function manifestWith(limitBytes: number, withCeiling: boolean): object {
  const manifest: Record<string, unknown> = {
    bundleBudgets: [
      {
        id: 'fixture-bundle',
        description: 'fixture bundle for the report tests',
        files: ['bundle.md'],
        limitBytes,
      },
    ],
  };
  if (withCeiling) manifest.contextCeiling = CEILING;
  return manifest;
}

/**
 * A fixture git repo whose bundle file is the banner-prefixed `body`, with
 * `manifest` on disk as audit/sync-manifest.json.
 */
function makeFixture(
  manifest: object,
  bundleText: string,
): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-report-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  mkdirSync(join(dir, 'audit'), { recursive: true });
  writeFileSync(
    join(dir, 'audit', 'sync-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
  writeFileSync(join(dir, 'bundle.md'), bundleText, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir, env: COMMIT_ENV });
  execFileSync('git', ['commit', '--quiet', '-m', 'base'], {
    cwd: dir,
    env: COMMIT_ENV,
  });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('formatBundleReportLine: maxBytes is the largest total the strict utilization check accepts', () => {
  // The utilization check fails when total * 100 > limit * pct. With a
  // limit of 1000 and 98 percent, 980 passes (98000 > 98000 is false) and 981
  // fails (98100 > 98000), so the headroom is 0 at 980 and -1 at 981.
  assert.equal(
    formatBundleReportLine(
      { id: 'fixture', limitBytes: 1000, totalBytes: 980 },
      98,
    ),
    'report: fixture bytes=980 limit=1000 maxBytes=980 headroom=0',
  );
  assert.equal(
    formatBundleReportLine(
      { id: 'fixture', limitBytes: 1000, totalBytes: 981 },
      98,
    ),
    'report: fixture bytes=981 limit=1000 maxBytes=980 headroom=-1',
  );
});

test('formatBundleReportLine: no valid maxUtilizationPct prints n/a for maxBytes and headroom', () => {
  assert.equal(
    formatBundleReportLine(
      { id: 'fixture', limitBytes: 1000, totalBytes: 980 },
      null,
    ),
    'report: fixture bytes=980 limit=1000 maxBytes=n/a headroom=n/a',
  );
});

test('audit-docs --report: a 980-byte bundle prints bytes=980 and headroom=0 and exits 0', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(1000, true),
    injectGeneratedFromBanner(bodyOfBytes(980), 'bundle.md'),
  );
  t.after(cleanup);

  const result = runAudit(dir, ['--check', '--report']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(reportLines(result.stdout), [
    'report: fixture-bundle bytes=980 limit=1000 maxBytes=980 headroom=0',
  ]);
});

test('audit-docs --report: a 981-byte bundle prints headroom=-1 and exits 1', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(1000, true),
    injectGeneratedFromBanner(bodyOfBytes(981), 'bundle.md'),
  );
  t.after(cleanup);

  const result = runAudit(dir, ['--check', '--report']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(reportLines(result.stdout), [
    'report: fixture-bundle bytes=981 limit=1000 maxBytes=980 headroom=-1',
  ]);
});

test('audit-docs --check without --report prints no report lines and keeps the same exit status', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(1000, true),
    injectGeneratedFromBanner(bodyOfBytes(980), 'bundle.md'),
  );
  t.after(cleanup);

  const withReport = runAudit(dir, ['--check', '--report']);
  const withoutReport = runAudit(dir, ['--check']);
  assert.equal(withoutReport.status, withReport.status);
  assert.deepEqual(reportLines(withoutReport.stdout), []);
});

test('audit-docs --report: without contextCeiling the lines print n/a and the exit status is unchanged', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(1000, false),
    injectGeneratedFromBanner(bodyOfBytes(980), 'bundle.md'),
  );
  t.after(cleanup);

  const result = runAudit(dir, ['--check', '--report']);
  const plain = runAudit(dir, ['--check']);
  assert.equal(result.status, plain.status, result.stdout + result.stderr);
  assert.deepEqual(reportLines(result.stdout), [
    'report: fixture-bundle bytes=980 limit=1000 maxBytes=n/a headroom=n/a',
  ]);
});

test('audit-docs --report: a bundle with an invalid limitBytes gets no report line', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(-1, true),
    injectGeneratedFromBanner(bodyOfBytes(980), 'bundle.md'),
  );
  t.after(cleanup);

  const result = runAudit(dir, ['--check', '--report']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(reportLines(result.stdout), []);
});

test('audit-docs --report without --check keeps the usage error and exit status 2', (t) => {
  const { dir, cleanup } = makeFixture(
    manifestWith(1000, true),
    injectGeneratedFromBanner(bodyOfBytes(980), 'bundle.md'),
  );
  t.after(cleanup);

  const result = runAudit(dir, ['--report']);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.deepEqual(reportLines(result.stdout), []);
});

test('audit-docs --check --report on the current tree prints the bundle-work-phase line and exits 0', () => {
  // bundle-work-phase is exempt from the utilization error, so its headroom
  // can be negative while the run still passes. The line reports the figure
  // without making it a failure.
  const result = runAudit(REPO_ROOT, ['--check', '--report']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(
    reportLines(result.stdout).some((line) =>
      line.startsWith('report: bundle-work-phase bytes='),
    ),
    result.stdout,
  );
});
