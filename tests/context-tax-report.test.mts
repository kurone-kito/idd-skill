import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ContextTaxSample } from '../src/scripts/context-tax-core.mts';
import {
  aggregateSnapshot,
  checkRenderedFiles,
  readEvents,
  readSamples,
  replaceMarkedRegion,
} from '../src/scripts/context-tax-report.mts';

const NOW = new Date('2026-08-26T00:00:00Z');

const README_START = '<!-- context-tax-readme:start -->';
const README_END = '<!-- context-tax-readme:end -->';
const DOCS_START = '<!-- context-tax-docs:start -->';
const DOCS_END = '<!-- context-tax-docs:end -->';

const UNPUBLISHABLE_EN =
  'Context-tax measurement is in progress; see\n[`docs/context-tax.md`](docs/context-tax.md) for the methodology.';
const UNPUBLISHABLE_JA =
  'コンテキスト税の計測は現在進行中です。詳しい方法論は [`docs/context-tax.md`](docs/context-tax.md) を参照してください。';
const UNPUBLISHABLE_DOCS = 'Not yet publishable, n=0.';

function stubReadmeText(): string {
  return `# Title\n\n## Proven in production\n\n${README_START}\n\nstub\n\n${README_END}\n\n## Quick Start\n`;
}

function stubDocsText(): string {
  return `# Context-Tax Methodology\n\n## Current snapshot\n\n${DOCS_START}\n\nstub\n\n${DOCS_END}\n`;
}

function issueLoopSample(
  overrides: Partial<ContextTaxSample> & { issueNumber: number },
): ContextTaxSample {
  return {
    schemaVersion: 1,
    kind: 'issue-loop',
    vendor: 'grok',
    model: 'grok-4.6',
    attribution: 'marker-join',
    outcome: 'merged',
    usage: {
      inputUncached: 1000,
      cacheRead: 500,
      cacheCreation: 50,
      output: 200,
      reasoning: 10,
    },
    compactionCount: 1,
    startedAt: '2026-08-25T00:00:00Z',
    endedAt: '2026-08-25T01:00:00Z',
    vendorSessionId: `sess-${overrides.issueNumber}`,
    stages: [
      {
        id: 'work',
        usage: {
          inputUncached: 500,
          cacheRead: 200,
          cacheCreation: 10,
          output: 100,
          reasoning: 5,
        },
      },
    ],
    ...overrides,
  } as ContextTaxSample;
}

/** Run `fn` inside a fresh sandbox cwd with README.md/README.ja.md/docs/context-tax.md seeded to the unpublishable stub. */
function withSandboxCwd(fn: () => void): void {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-context-tax-report-test-'));
  process.chdir(sandbox);
  try {
    mkdirSync('docs', { recursive: true });
    writeFileSync(
      'README.md',
      replaceMarkedRegion(
        stubReadmeText(),
        README_START,
        README_END,
        UNPUBLISHABLE_EN,
      ),
    );
    writeFileSync(
      'README.ja.md',
      replaceMarkedRegion(
        stubReadmeText(),
        README_START,
        README_END,
        UNPUBLISHABLE_JA,
      ),
    );
    writeFileSync(
      'docs/context-tax.md',
      replaceMarkedRegion(
        stubDocsText(),
        DOCS_START,
        DOCS_END,
        UNPUBLISHABLE_DOCS,
      ),
    );
    fn();
  } finally {
    process.chdir(originalCwd);
  }
}

test('aggregateSnapshot below the publish gate stays unpublishable with n samples', () => {
  const samples = Array.from({ length: 5 }, (_, i) =>
    issueLoopSample({ issueNumber: 100 + i, vendor: 'grok' }),
  );
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.publishable, false);
  assert.equal(snapshot.sampleCount, 5);
  assert.deepEqual(snapshot.vendors, ['grok']);
});

test('aggregateSnapshot at the gate (10 samples, 2 vendors) is publishable', () => {
  const samples = Array.from({ length: 10 }, (_, i) =>
    issueLoopSample({
      issueNumber: 200 + i,
      vendor: i % 2 === 0 ? 'grok' : 'claude',
      usage: {
        inputUncached: 900 + i * 100,
        cacheRead: 400,
        cacheCreation: 40,
        output: 150,
        reasoning: 5,
      },
    }),
  );
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.publishable, true);
  assert.equal(snapshot.sampleCount, 10);
  assert.deepEqual(snapshot.vendors, ['claude', 'grok']);
  // 10 evenly-spaced values from 900 to 1800 (step 100); p50 sits at the
  // interpolated midpoint between the 5th and 6th sorted values.
  assert.equal(snapshot.totalUsage.inputUncached.p50, 1350);
});

test('aggregateSnapshot excludes outcome: unknown and non-issue-loop samples from every figure', () => {
  const samples: ContextTaxSample[] = [
    ...Array.from({ length: 9 }, (_, i) =>
      issueLoopSample({ issueNumber: 300 + i, vendor: 'grok' }),
    ),
    issueLoopSample({ issueNumber: 400, vendor: 'claude', outcome: 'unknown' }),
    {
      schemaVersion: 1,
      kind: 'session',
      vendor: 'codex',
      model: 'gpt-test',
      attribution: 'session-unscoped',
      outcome: 'merged',
      usage: {
        inputUncached: 1,
        cacheRead: 1,
        cacheCreation: 1,
        output: 1,
        reasoning: 1,
      },
      compactionCount: 0,
      startedAt: '2026-08-25T00:00:00Z',
      endedAt: '2026-08-25T01:00:00Z',
      vendorSessionId: 'sess-session-only',
    },
  ];
  const snapshot = aggregateSnapshot(samples, NOW);
  // Only the 9 issue-loop/non-unknown grok samples count: gate not met.
  assert.equal(snapshot.sampleCount, 9);
  assert.deepEqual(snapshot.vendors, ['grok']);
});

test('aggregateSnapshot computes cache-hit ratio and per-model/vendor success rates', () => {
  const samples = [
    ...Array.from({ length: 6 }, (_, i) =>
      issueLoopSample({
        issueNumber: 500 + i,
        vendor: 'grok',
        model: 'grok-4.6',
        outcome: 'merged',
      }),
    ),
    ...Array.from({ length: 2 }, (_, i) =>
      issueLoopSample({
        issueNumber: 510 + i,
        vendor: 'grok',
        model: 'grok-4.6',
        outcome: 'aborted',
      }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      issueLoopSample({
        issueNumber: 520 + i,
        vendor: 'claude',
        model: 'claude-opus',
        outcome: 'merged',
      }),
    ),
  ];
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.sampleCount, 12);
  // cacheRead=500, cacheCreation=50, inputUncached=1000 for every sample.
  assert.equal(snapshot.cacheHitRatio, 500 / (500 + 50 + 1000));
  assert.equal(snapshot.successRateByModel['grok-4.6'].merged, 6);
  assert.equal(snapshot.successRateByModel['grok-4.6'].aborted, 2);
  assert.equal(snapshot.successRateByModel['grok-4.6'].rate, 6 / 8);
  assert.equal(snapshot.successRateByVendor.claude?.rate, 1);
});

test('readSamples rejects a malformed line', () => {
  withSandboxCwd(() => {
    writeFileSync(
      'samples.jsonl',
      `${JSON.stringify(issueLoopSample({ issueNumber: 1 }))}\nnot json\n`,
    );
    assert.throws(() => readSamples(['samples.jsonl']));
  });
});

test('readEvents rejects a non-object line', () => {
  withSandboxCwd(() => {
    writeFileSync('events.jsonl', '"just a string"\n');
    assert.throws(() => readEvents(['events.jsonl']), /not a JSON object/);
  });
});

test('replaceMarkedRegion swaps only the content between the markers', () => {
  const text = `before\n${README_START}\nold\n${README_END}\nafter`;
  const result = replaceMarkedRegion(
    text,
    README_START,
    README_END,
    'new content',
  );
  assert.match(result, /before/);
  assert.match(result, /after/);
  assert.doesNotMatch(result, /old/);
  assert.match(result, /new content/);
});

test('replaceMarkedRegion throws when a marker is missing', () => {
  assert.throws(
    () => replaceMarkedRegion('no markers here', README_START, README_END, 'x'),
    /marked region .* not found/,
  );
});

test('checkRenderedFiles reports no drift when regions match the unpublishable stub', () => {
  withSandboxCwd(() => {
    const snapshot = aggregateSnapshot([], NOW);
    const drifted = checkRenderedFiles(snapshot);
    assert.deepEqual(drifted, []);
  });
});

test('checkRenderedFiles reports drift when a README region is mutated without updating the snapshot', () => {
  withSandboxCwd(() => {
    const snapshot = aggregateSnapshot([], NOW);
    writeFileSync(
      'README.md',
      replaceMarkedRegion(
        stubReadmeText(),
        README_START,
        README_END,
        'hand-edited, does not match the snapshot',
      ),
    );
    const drifted = checkRenderedFiles(snapshot);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0], /README\.md/);
  });
});

test('checkRenderedFiles reports drift when the docs table region is mutated without updating the snapshot', () => {
  withSandboxCwd(() => {
    const snapshot = aggregateSnapshot([], NOW);
    writeFileSync(
      'docs/context-tax.md',
      replaceMarkedRegion(
        stubDocsText(),
        DOCS_START,
        DOCS_END,
        'hand-edited table',
      ),
    );
    const drifted = checkRenderedFiles(snapshot);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0], /context-tax\.md/);
  });
});
