import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type CritiqueTelemetrySample,
  harvestCritiqueTelemetry,
  parseCritiqueTelemetryLine,
  parseHarvestedCritiqueTelemetrySample,
  parseRepoFlag,
  sampleDedupKey,
} from '../src/scripts/idd-critique-harvest.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI_PATH = join(REPO_ROOT, 'scripts/idd-critique-harvest.mjs');
const FIXTURE_LOG = join(REPO_ROOT, 'tests/fixtures/idd-critique/log.jsonl');

function sandboxDir(): string {
  return mkdtempSync(join(tmpdir(), 'idd-critique-harvest-test-'));
}

function validLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: 'C',
    round: 1,
    repo: 'kurone-kito/idd-skill',
    issue: 3002,
    pr: null,
    findingsCount: 3,
    severityBreakdown: { high: 1, medium: 1, low: 1 },
    acceptedCount: 2,
    rejectedCount: 1,
    delegateUsed: true,
    delegateCommand: 'coderabbit-critique',
    timestamp: '2026-09-08T12:00:00Z',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// parseCritiqueTelemetryLine
// ---------------------------------------------------------------------------

test('parseCritiqueTelemetryLine accepts a fully-populated well-formed line', () => {
  const parsed = parseCritiqueTelemetryLine(validLine());
  assert.ok('sample' in parsed, 'expected a valid sample');
  const sample = (parsed as { sample: CritiqueTelemetrySample }).sample;
  assert.equal(sample.schemaVersion, 1);
  assert.equal(sample.phase, 'C');
  assert.equal(sample.round, 1);
  assert.equal(sample.repo, 'kurone-kito/idd-skill');
  assert.equal(sample.issue, 3002);
  assert.equal(sample.pr, null);
  assert.equal(sample.findingsCount, 3);
  assert.deepEqual(sample.severityBreakdown, { high: 1, medium: 1, low: 1 });
  assert.equal(sample.acceptedCount, 2);
  assert.equal(sample.rejectedCount, 1);
  assert.equal(sample.delegateUsed, true);
  assert.equal(sample.delegateCommand, 'coderabbit-critique');
  assert.equal(sample.timestamp, '2026-09-08T12:00:00Z');
});

test('parseCritiqueTelemetryLine normalizes a zero-finding round missing every optional field', () => {
  const line = JSON.stringify({
    phase: 'C',
    round: 2,
    repo: 'kurone-kito/idd-skill',
    issue: 3002,
    findingsCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    delegateUsed: false,
    timestamp: '2026-09-09T09:00:00Z',
  });
  const parsed = parseCritiqueTelemetryLine(line);
  assert.ok('sample' in parsed, 'expected a valid sample');
  const sample = (parsed as { sample: CritiqueTelemetrySample }).sample;
  assert.equal(sample.pr, null);
  assert.deepEqual(sample.severityBreakdown, { high: 0, medium: 0, low: 0 });
  assert.equal(sample.delegateCommand, undefined);
  assert.ok(
    !Object.hasOwn(sample, 'delegateCommand') ||
      sample.delegateCommand === undefined,
  );
});

test('parseCritiqueTelemetryLine defaults a partial severityBreakdown', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ severityBreakdown: { medium: 2 } }),
  );
  assert.ok('sample' in parsed, 'expected a valid sample');
  const sample = (parsed as { sample: CritiqueTelemetrySample }).sample;
  assert.deepEqual(sample.severityBreakdown, { high: 0, medium: 2, low: 0 });
});

test('parseCritiqueTelemetryLine rejects invalid JSON', () => {
  const parsed = parseCritiqueTelemetryLine('not json at all');
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /invalid JSON/);
});

test('parseCritiqueTelemetryLine rejects a required field with the wrong type', () => {
  const parsed = parseCritiqueTelemetryLine(validLine({ findingsCount: '3' }));
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /findingsCount/);
});

test('parseCritiqueTelemetryLine rejects acceptedCount + rejectedCount exceeding findingsCount', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ findingsCount: 1, acceptedCount: 1, rejectedCount: 1 }),
  );
  assert.ok('error' in parsed);
  assert.match(
    (parsed as { error: string }).error,
    /acceptedCount \+ rejectedCount/,
  );
});

test('parseCritiqueTelemetryLine tolerates acceptedCount + rejectedCount below findingsCount (no strict equality required)', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ findingsCount: 3, acceptedCount: 1, rejectedCount: 0 }),
  );
  assert.ok('sample' in parsed, 'expected a valid sample');
});

test('parseCritiqueTelemetryLine rejects a non-object line', () => {
  const parsed = parseCritiqueTelemetryLine('[1,2,3]');
  assert.ok('error' in parsed);
});

test('parseCritiqueTelemetryLine rejects an empty delegateCommand', () => {
  const parsed = parseCritiqueTelemetryLine(validLine({ delegateCommand: '' }));
  assert.ok('error' in parsed);
});

test('parseCritiqueTelemetryLine rejects an invalid timestamp', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ timestamp: 'not-a-date' }),
  );
  assert.ok('error' in parsed);
});

test('parseCritiqueTelemetryLine rejects a phase other than "C" (#3005 review, Copilot)', () => {
  const parsed = parseCritiqueTelemetryLine(validLine({ phase: 'E10' }));
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /phase/);
});

test('parseCritiqueTelemetryLine rejects a non-object severityBreakdown instead of treating it as absent (#3005 review, Copilot)', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ severityBreakdown: 'not-an-object' }),
  );
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /severityBreakdown/);
});

test('parseCritiqueTelemetryLine rejects a null severityBreakdown instead of treating it as absent (#3005 review, Copilot)', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ severityBreakdown: null }),
  );
  assert.ok('error' in parsed);
});

test('parseCritiqueTelemetryLine rejects delegateCommand present when delegateUsed is false (#3005 review, Copilot)', () => {
  const parsed = parseCritiqueTelemetryLine(
    validLine({ delegateUsed: false, delegateCommand: 'coderabbit-critique' }),
  );
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /delegateCommand/);
});

// ---------------------------------------------------------------------------
// parseHarvestedCritiqueTelemetrySample
// ---------------------------------------------------------------------------

test('parseHarvestedCritiqueTelemetrySample accepts a well-formed already-harvested line', () => {
  const harvested = parseCritiqueTelemetryLine(validLine());
  assert.ok('sample' in harvested);
  const parsed = parseHarvestedCritiqueTelemetrySample(
    JSON.stringify((harvested as { sample: CritiqueTelemetrySample }).sample),
  );
  assert.ok('sample' in parsed, 'expected a valid sample');
});

test('parseHarvestedCritiqueTelemetrySample rejects a schemaVersion other than 1 (#3005 review, Codex)', () => {
  const harvested = parseCritiqueTelemetryLine(validLine());
  assert.ok('sample' in harvested);
  const corrupted = {
    ...(harvested as { sample: CritiqueTelemetrySample }).sample,
    schemaVersion: 2,
  };
  const parsed = parseHarvestedCritiqueTelemetrySample(
    JSON.stringify(corrupted),
  );
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /schemaVersion/);
});

test('parseHarvestedCritiqueTelemetrySample rejects an already-harvested line missing pr entirely (#3005 review, Copilot)', () => {
  const harvested = parseCritiqueTelemetryLine(validLine());
  assert.ok('sample' in harvested);
  const { pr: _pr, ...withoutPr } = (
    harvested as { sample: CritiqueTelemetrySample }
  ).sample;
  const parsed = parseHarvestedCritiqueTelemetrySample(
    JSON.stringify(withoutPr),
  );
  assert.ok('error' in parsed);
  assert.match((parsed as { error: string }).error, /\bpr\b/);
});

// ---------------------------------------------------------------------------
// sampleDedupKey
// ---------------------------------------------------------------------------

test('sampleDedupKey is stable regardless of source key order', () => {
  const a = parseCritiqueTelemetryLine(validLine());
  const b = parseCritiqueTelemetryLine(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(validLine()) as Record<string, unknown>).sort(
          ([x], [y]) => y.localeCompare(x),
        ),
      ),
    ),
  );
  assert.ok('sample' in a && 'sample' in b);
  assert.equal(
    sampleDedupKey((a as { sample: CritiqueTelemetrySample }).sample),
    sampleDedupKey((b as { sample: CritiqueTelemetrySample }).sample),
  );
});

test('sampleDedupKey differs for two records sharing repo+issue+round+timestamp but different content', () => {
  const a = parseCritiqueTelemetryLine(
    validLine({
      round: 5,
      timestamp: '2026-09-08T12:00:00Z',
      findingsCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
    }),
  );
  const b = parseCritiqueTelemetryLine(
    validLine({
      round: 5,
      timestamp: '2026-09-08T12:00:00Z',
      findingsCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
    }),
  );
  assert.ok('sample' in a && 'sample' in b);
  assert.notEqual(
    sampleDedupKey((a as { sample: CritiqueTelemetrySample }).sample),
    sampleDedupKey((b as { sample: CritiqueTelemetrySample }).sample),
  );
});

// ---------------------------------------------------------------------------
// harvestCritiqueTelemetry
// ---------------------------------------------------------------------------

const FIXTURE_REPO = 'kurone-kito/idd-skill';

test('harvestCritiqueTelemetry harvests the fixture log, skipping malformed lines and reporting counts', () => {
  const dir = sandboxDir();
  const outPath = join(dir, 'samples.jsonl');
  const counts = harvestCritiqueTelemetry([FIXTURE_LOG], outPath, FIXTURE_REPO);
  assert.equal(counts.read, 5);
  assert.equal(counts.appended, 3);
  assert.equal(counts.skippedMalformed, 2);
  assert.equal(counts.skippedDuplicate, 0);
  assert.equal(counts.skippedOtherRepo, 0);
  const lines = readFileSync(outPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  assert.equal(lines.length, 3);
});

test('harvestCritiqueTelemetry is idempotent across repeated runs against the same log', () => {
  const dir = sandboxDir();
  const outPath = join(dir, 'samples.jsonl');
  harvestCritiqueTelemetry([FIXTURE_LOG], outPath, FIXTURE_REPO);
  const firstRunContent = readFileSync(outPath, 'utf8');
  const counts = harvestCritiqueTelemetry([FIXTURE_LOG], outPath, FIXTURE_REPO);
  assert.equal(counts.appended, 0);
  assert.equal(counts.skippedDuplicate, 3);
  assert.equal(readFileSync(outPath, 'utf8'), firstRunContent);
});

test('harvestCritiqueTelemetry --dry-run reports counts without writing --out', () => {
  const dir = sandboxDir();
  const outPath = join(dir, 'samples.jsonl');
  const counts = harvestCritiqueTelemetry(
    [FIXTURE_LOG],
    outPath,
    FIXTURE_REPO,
    {
      dryRun: true,
    },
  );
  assert.equal(counts.appended, 3);
  assert.throws(() => readFileSync(outPath, 'utf8'));
});

test('harvestCritiqueTelemetry silently skips a missing --in path', () => {
  const dir = sandboxDir();
  const outPath = join(dir, 'samples.jsonl');
  const counts = harvestCritiqueTelemetry(
    [join(dir, 'does-not-exist.jsonl')],
    outPath,
    FIXTURE_REPO,
  );
  assert.equal(counts.read, 0);
  assert.equal(counts.appended, 0);
});

test('harvestCritiqueTelemetry skips a well-formed record for a different repository (#3005 review, Copilot)', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'log.jsonl');
  writeFileSync(inPath, `${validLine({ repo: 'someone-else/other-repo' })}\n`);
  const outPath = join(dir, 'samples.jsonl');
  const counts = harvestCritiqueTelemetry([inPath], outPath, FIXTURE_REPO);
  assert.equal(counts.read, 1);
  assert.equal(counts.appended, 0);
  assert.equal(counts.skippedOtherRepo, 1);
  assert.throws(() => readFileSync(outPath, 'utf8'));
});

test('parseRepoFlag validates the <owner>/<repo> shape', () => {
  assert.deepEqual(parseRepoFlag('kurone-kito/idd-skill'), {
    owner: 'kurone-kito',
    repo: 'idd-skill',
  });
  assert.equal(parseRepoFlag(''), null);
  assert.equal(parseRepoFlag('no-slash'), null);
  assert.equal(parseRepoFlag('too/many/slashes'), null);
  assert.equal(parseRepoFlag('owner/'), null);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI: idd-critique-harvest.mjs writes appended records and prints counts', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'log.jsonl');
  writeFileSync(inPath, `${validLine()}\n`);
  const outPath = join(dir, 'samples.jsonl');
  const stdout = execFileSync(
    process.execPath,
    [CLI_PATH, '--repo', FIXTURE_REPO, '--in', inPath, '--out', outPath],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(
    stdout,
    /read=1 appended=1 skipped-duplicate=0 skipped-other-repo=0 skipped-malformed=0/,
  );
  const lines = readFileSync(outPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
  assert.equal(lines.length, 1);
});

test('CLI: idd-critique-harvest.mjs --dry-run never creates --out', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'log.jsonl');
  writeFileSync(inPath, `${validLine()}\n`);
  const outPath = join(dir, 'samples.jsonl');
  execFileSync(
    process.execPath,
    [
      CLI_PATH,
      '--repo',
      FIXTURE_REPO,
      '--in',
      inPath,
      '--out',
      outPath,
      '--dry-run',
    ],
    { encoding: 'utf8', timeout: 60_000 },
  );
  assert.throws(() => readFileSync(outPath, 'utf8'));
});

test('CLI: idd-critique-harvest.mjs requires --repo', () => {
  const dir = sandboxDir();
  const inPath = join(dir, 'log.jsonl');
  writeFileSync(inPath, `${validLine()}\n`);
  assert.throws(() =>
    execFileSync(process.execPath, [CLI_PATH, '--in', inPath], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    }),
  );
});

test('CLI: idd-critique-harvest.mjs --help exits 0', () => {
  const stdout = execFileSync(process.execPath, [CLI_PATH, '--help'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.match(stdout, /Usage:/);
});
