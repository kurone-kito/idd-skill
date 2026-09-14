import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CritiqueTelemetrySample } from '../src/scripts/idd-critique-harvest.mts';
import {
  aggregateCritiqueSnapshot,
  assertCritiqueTelemetrySnapshot,
  type CritiqueTelemetrySnapshot,
  checkRenderedFiles,
  readCritiqueSamples,
  renderDocsTableRegion,
  replaceMarkedRegion,
  resolveDefaultBranchGuard,
} from '../src/scripts/idd-critique-report.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-critique-report.mjs');
const NOW = new Date('2026-09-15T00:00:00Z');

const DOCS_START = '<!-- idd-critique-docs:start -->';
const DOCS_END = '<!-- idd-critique-docs:end -->';

function sample(
  overrides: Partial<CritiqueTelemetrySample> = {},
): CritiqueTelemetrySample {
  return {
    schemaVersion: 1,
    phase: 'C',
    round: 1,
    repo: 'kurone-kito/idd-skill',
    issue: 3002,
    pr: null,
    findingsCount: 2,
    severityBreakdown: { high: 1, medium: 1, low: 0 },
    acceptedCount: 1,
    rejectedCount: 1,
    delegateUsed: false,
    timestamp: '2026-09-08T12:00:00Z',
    ...overrides,
  };
}

function sandboxDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'idd-critique-report-test-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  return dir;
}

function stubDocsText(): string {
  return `# Title\n\n## Current snapshot\n\n${DOCS_START}\n\nstub\n\n${DOCS_END}\n`;
}

// ---------------------------------------------------------------------------
// aggregateCritiqueSnapshot
// ---------------------------------------------------------------------------

test('aggregateCritiqueSnapshot sums findings, severities, decisions and delegate usage', () => {
  const snapshot = aggregateCritiqueSnapshot(
    [
      sample({
        findingsCount: 3,
        severityBreakdown: { high: 1, medium: 1, low: 1 },
        acceptedCount: 2,
        rejectedCount: 1,
        delegateUsed: true,
      }),
      sample({
        findingsCount: 0,
        severityBreakdown: { high: 0, medium: 0, low: 0 },
        acceptedCount: 0,
        rejectedCount: 0,
        delegateUsed: false,
      }),
      sample({
        findingsCount: 1,
        severityBreakdown: { high: 0, medium: 1, low: 0 },
        acceptedCount: 1,
        rejectedCount: 0,
        delegateUsed: false,
      }),
    ],
    NOW,
  );
  assert.equal(snapshot.sampleCount, 3);
  assert.equal(snapshot.totalFindings, 4);
  assert.deepEqual(snapshot.severityBreakdown, { high: 1, medium: 2, low: 1 });
  assert.equal(snapshot.acceptedCount, 3);
  assert.equal(snapshot.rejectedCount, 1);
  assert.equal(snapshot.acceptRate, 0.75);
  assert.equal(snapshot.rejectRate, 0.25);
  assert.equal(snapshot.delegateUsageCount, 1);
  assert.ok(Math.abs((snapshot.delegateUsageRate ?? 0) - 1 / 3) < 1e-9);
  assert.equal(snapshot.generatedOn, '2026-09-15');
  assert.equal(snapshot.publishable, false);
});

test('aggregateCritiqueSnapshot reports null rates (never NaN) when every count is zero', () => {
  const snapshot = aggregateCritiqueSnapshot([], NOW);
  assert.equal(snapshot.sampleCount, 0);
  assert.equal(snapshot.acceptRate, null);
  assert.equal(snapshot.rejectRate, null);
  assert.equal(snapshot.delegateUsageRate, null);
  assert.equal(snapshot.publishable, false);
});

test('aggregateCritiqueSnapshot marks publishable once sampleCount reaches the threshold', () => {
  const samples = Array.from({ length: 10 }, (_, i) =>
    sample({ round: i + 1, timestamp: `2026-09-0${(i % 9) + 1}T00:00:00Z` }),
  );
  const snapshot = aggregateCritiqueSnapshot(samples, NOW);
  assert.equal(snapshot.sampleCount, 10);
  assert.equal(snapshot.publishable, true);
});

// ---------------------------------------------------------------------------
// assertCritiqueTelemetrySnapshot
// ---------------------------------------------------------------------------

test('assertCritiqueTelemetrySnapshot accepts a well-formed snapshot', () => {
  const snapshot = aggregateCritiqueSnapshot([sample()], NOW);
  assert.doesNotThrow(() => assertCritiqueTelemetrySnapshot(snapshot));
});

test('assertCritiqueTelemetrySnapshot rejects a malformed snapshot', () => {
  assert.throws(() => assertCritiqueTelemetrySnapshot({ schemaVersion: 1 }));
});

test('assertCritiqueTelemetrySnapshot rejects an out-of-range rate', () => {
  const snapshot = aggregateCritiqueSnapshot([sample()], NOW);
  assert.throws(() =>
    assertCritiqueTelemetrySnapshot({ ...snapshot, acceptRate: 1.5 }),
  );
});

// ---------------------------------------------------------------------------
// readCritiqueSamples
// ---------------------------------------------------------------------------

test('readCritiqueSamples reads well-formed harvested samples', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'samples.jsonl');
  writeFileSync(inPath, `${JSON.stringify(sample())}\n`);
  const samples = readCritiqueSamples([inPath]);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].issue, 3002);
});

test('readCritiqueSamples throws on a malformed already-harvested line (fail closed, unlike the harvester)', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'samples.jsonl');
  writeFileSync(inPath, 'not json\n');
  assert.throws(() => readCritiqueSamples([inPath]), /invalid JSON/);
});

test('readCritiqueSamples throws on a non-numeric severityBreakdown sub-field (#3002 C1 critique regression)', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'samples.jsonl');
  const corrupted = {
    ...sample(),
    severityBreakdown: { high: 'not-a-number', medium: 1, low: 0 },
  };
  writeFileSync(inPath, `${JSON.stringify(corrupted)}\n`);
  assert.throws(() => readCritiqueSamples([inPath]), /severityBreakdown\.high/);
});

test('readCritiqueSamples throws when acceptedCount + rejectedCount exceeds findingsCount (#3002 C1 critique regression)', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'samples.jsonl');
  const corrupted = {
    ...sample(),
    findingsCount: 1,
    acceptedCount: 1,
    rejectedCount: 1,
  };
  writeFileSync(inPath, `${JSON.stringify(corrupted)}\n`);
  assert.throws(
    () => readCritiqueSamples([inPath]),
    /acceptedCount \+ rejectedCount/,
  );
});

// ---------------------------------------------------------------------------
// Rendering / replaceMarkedRegion / checkRenderedFiles
// ---------------------------------------------------------------------------

test('renderDocsTableRegion renders the unpublishable stub below the sample-count gate', () => {
  const snapshot = aggregateCritiqueSnapshot([], NOW);
  assert.equal(renderDocsTableRegion(snapshot), 'Not yet publishable, n=0.');
});

test('renderDocsTableRegion renders a table once publishable', () => {
  const samples = Array.from({ length: 10 }, (_, i) =>
    sample({ round: i + 1 }),
  );
  const snapshot = aggregateCritiqueSnapshot(samples, NOW);
  const rendered = renderDocsTableRegion(snapshot);
  assert.match(rendered, /Total rounds \| 10/);
  assert.match(rendered, /n=10, as of 2026-09-15\./);
});

test('replaceMarkedRegion replaces only the content between the markers', () => {
  const text = `before\n${DOCS_START}\nold\n${DOCS_END}\nafter`;
  const replaced = replaceMarkedRegion(text, DOCS_START, DOCS_END, 'new');
  assert.match(replaced, /before/);
  assert.match(replaced, /after/);
  assert.match(replaced, /new/);
  assert.ok(!replaced.includes('old'));
});

test('replaceMarkedRegion throws when a marker is missing', () => {
  assert.throws(() =>
    replaceMarkedRegion('no markers here', DOCS_START, DOCS_END, 'x'),
  );
});

test('checkRenderedFiles reports drift when the doc region does not match the snapshot', () => {
  const dir = sandboxDir();
  const docsPath = join(dir, 'docs/critique-telemetry.md');
  writeFileSync(docsPath, stubDocsText());
  const snapshot: CritiqueTelemetrySnapshot = {
    ...aggregateCritiqueSnapshot([], NOW),
  };
  const drifted = checkRenderedFiles(snapshot, docsPath);
  assert.equal(drifted.length, 1);
  assert.match(drifted[0], /drifted/);
});

test('checkRenderedFiles reports no drift once the doc region matches', () => {
  const dir = sandboxDir();
  const docsPath = join(dir, 'docs/critique-telemetry.md');
  const snapshot = aggregateCritiqueSnapshot([], NOW);
  writeFileSync(
    docsPath,
    replaceMarkedRegion(
      stubDocsText(),
      DOCS_START,
      DOCS_END,
      renderDocsTableRegion(snapshot),
    ),
  );
  assert.deepEqual(checkRenderedFiles(snapshot, docsPath), []);
});

// ---------------------------------------------------------------------------
// resolveDefaultBranchGuard
// ---------------------------------------------------------------------------

test('resolveDefaultBranchGuard blocks apply on the default branch unless overridden', () => {
  const deps = {
    getCurrentBranch: () => 'main',
    getDefaultBranch: () => 'main',
  };
  assert.equal(resolveDefaultBranchGuard(false, deps).blocked, true);
  assert.equal(resolveDefaultBranchGuard(true, deps).blocked, false);
});

test('resolveDefaultBranchGuard never blocks a non-default branch', () => {
  const deps = {
    getCurrentBranch: () => 'issue/3002-build-harvest-aggregation-pipeline',
    getDefaultBranch: () => 'main',
  };
  assert.equal(resolveDefaultBranchGuard(false, deps).blocked, false);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: idd-critique-report.mjs --apply then --check round-trips with no drift', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'samples.jsonl');
  const samples = Array.from({ length: 10 }, (_, i) =>
    sample({ round: i + 1, timestamp: `2026-09-0${(i % 9) + 1}T00:00:00Z` }),
  );
  writeFileSync(
    inPath,
    `${samples.map((s) => JSON.stringify(s)).join('\n')}\n`,
  );
  const snapshotPath = join(dir, 'snapshot.json');
  const docsPath = join(dir, 'docs/critique-telemetry.md');
  writeFileSync(docsPath, stubDocsText());

  const applyStdout = execFileSync(
    process.execPath,
    [
      CLI_PATH,
      '--in',
      inPath,
      '--snapshot',
      snapshotPath,
      '--docs',
      docsPath,
      '--apply',
      '--allow-default-branch',
      '--now',
      '2026-09-15T00:00:00Z',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(applyStdout, /n=10, publishable=true/);

  const checkStdout = execFileSync(
    process.execPath,
    [CLI_PATH, '--snapshot', snapshotPath, '--docs', docsPath, '--check'],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(checkStdout, /no drift/);

  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  assert.equal(snapshot.sampleCount, 10);
  assert.equal(snapshot.publishable, true);
});

test('CLI: idd-critique-report.mjs --check exits non-zero on drift', () => {
  const dir = sandboxDir();
  const snapshotPath = join(dir, 'snapshot.json');
  const docsPath = join(dir, 'docs/critique-telemetry.md');
  writeFileSync(
    snapshotPath,
    `${JSON.stringify(aggregateCritiqueSnapshot([], NOW), null, 2)}\n`,
  );
  writeFileSync(
    docsPath,
    `${stubDocsText()}`.replace('stub', 'drifted-content'),
  );
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [CLI_PATH, '--snapshot', snapshotPath, '--docs', docsPath, '--check'],
      { encoding: 'utf8', timeout: 60_000 },
    ),
  );
});

test('CLI: idd-critique-report.mjs rejects passing both --apply and --check', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [CLI_PATH, '--apply', '--check'], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    }),
  );
});

test('CLI: idd-critique-report.mjs --help exits 0', () => {
  const stdout = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(stdout, /Usage:/);
});
