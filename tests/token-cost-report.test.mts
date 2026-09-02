import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { TokenCostSample } from '../src/scripts/token-cost-core.mts';
import {
  aggregateSnapshot,
  checkRenderedFiles,
  readEvents,
  readSamples,
  renderDocsTableRegion,
  renderReadmeRegionEn,
  renderReadmeRegionJa,
  replaceMarkedRegion,
  resolveDefaultBranchGuard,
} from '../src/scripts/token-cost-report.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const NOW = new Date('2026-08-26T00:00:00Z');

const README_START = '<!-- token-cost-readme:start -->';
const README_END = '<!-- token-cost-readme:end -->';
const DOCS_START = '<!-- token-cost-docs:start -->';
const DOCS_END = '<!-- token-cost-docs:end -->';

const UNPUBLISHABLE_EN =
  'Token-cost measurement is in progress; see\n[`docs/token-cost.md`](docs/token-cost.md) for the methodology.';
const UNPUBLISHABLE_JA =
  'トークンコストの計測は現在進行中です。\n詳しい方法論は [`docs/token-cost.md`](docs/token-cost.md) を参照してください。';
const UNPUBLISHABLE_DOCS = 'Not yet publishable, n=0.';

function stubReadmeText(): string {
  return `# Title\n\n## Proven in production\n\n${README_START}\n\nstub\n\n${README_END}\n\n## Quick Start\n`;
}

function stubDocsText(): string {
  return `# Token-Cost Methodology\n\n## Current snapshot\n\n${DOCS_START}\n\nstub\n\n${DOCS_END}\n`;
}

function issueLoopSample(
  overrides: Partial<TokenCostSample> & { issueNumber: number },
): TokenCostSample {
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
  } as TokenCostSample;
}

/** Run `fn` inside a fresh sandbox cwd with README.md/README.ja.md/docs/token-cost.md seeded to the unpublishable stub. */
function withSandboxCwd(fn: () => void): void {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-report-test-'));
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
      'docs/token-cost.md',
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
  const samples: TokenCostSample[] = [
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

test("aggregateSnapshot cacheHitRatio is the median of each sample's own ratio, not the ratio of independent medians", () => {
  // Three samples with wildly different per-sample cache-hit ratios:
  // 0.0, 0.5, and 1.0. The ratio-of-medians bug this test guards against
  // would divide the p50 of each usage field independently -- which,
  // because each field's median can come from a different sample, need
  // not equal any real sample's own ratio.
  const samples = [
    issueLoopSample({
      issueNumber: 600,
      usage: {
        inputUncached: 1000,
        cacheRead: 0,
        cacheCreation: 0,
        output: 1,
        reasoning: 1,
      },
    }),
    issueLoopSample({
      issueNumber: 601,
      usage: {
        inputUncached: 500,
        cacheRead: 500,
        cacheCreation: 0,
        output: 1,
        reasoning: 1,
      },
    }),
    issueLoopSample({
      issueNumber: 602,
      usage: {
        inputUncached: 0,
        cacheRead: 1000,
        cacheCreation: 0,
        output: 1,
        reasoning: 1,
      },
    }),
  ];
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.sampleCount, 3);
  // Per-sample ratios sorted: [0, 0.5, 1] -> median 0.5, matching the
  // middle sample's own ratio exactly.
  assert.equal(snapshot.cacheHitRatio, 0.5);
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
      'docs/token-cost.md',
      replaceMarkedRegion(
        stubDocsText(),
        DOCS_START,
        DOCS_END,
        'hand-edited table',
      ),
    );
    const drifted = checkRenderedFiles(snapshot);
    assert.equal(drifted.length, 1);
    assert.match(drifted[0], /token-cost\.md/);
  });
});

test('renderReadmeRegionEn/Ja never exceed markdownlint MD013 line length (80) even with large dynamic values', () => {
  // Deliberately large-magnitude figures, well beyond any realistic
  // sample, to guard against a future regression once real data flows
  // through this path (#2294's snapshot data is currently only a
  // synthetic n=0 stub).
  const samples = Array.from({ length: 12 }, (_, i) =>
    issueLoopSample({
      issueNumber: 800 + i,
      vendor: i % 2 === 0 ? 'grok' : 'claude',
      usage: {
        inputUncached: 1234567,
        cacheRead: 234567,
        cacheCreation: 3456,
        output: 4567,
        reasoning: 567,
      },
      compactionCount: 4321,
    }),
  );
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.publishable, true);
  for (const line of renderReadmeRegionEn(snapshot).split('\n')) {
    assert.ok(
      line.length <= 80,
      `EN line exceeds 80 chars: "${line}" (${line.length})`,
    );
  }
  for (const line of renderReadmeRegionJa(snapshot).split('\n')) {
    assert.ok(
      line.length <= 80,
      `JA line exceeds 80 chars: "${line}" (${line.length})`,
    );
  }
});

test('renderDocsTableRegion includes per-stage usage and success-rate breakdowns when publishable', () => {
  const samples = Array.from({ length: 10 }, (_, i) =>
    issueLoopSample({
      issueNumber: 700 + i,
      vendor: i % 2 === 0 ? 'grok' : 'claude',
      model: 'grok-4.6',
      outcome: i < 9 ? 'merged' : 'aborted',
    }),
  );
  const snapshot = aggregateSnapshot(samples, NOW);
  assert.equal(snapshot.publishable, true);
  const rendered = renderDocsTableRegion(snapshot);
  assert.match(rendered, /### Total usage/);
  assert.match(rendered, /### By stage \(inputUncached\)/);
  assert.match(rendered, /\| work \|/);
  assert.match(rendered, /### Success rate by model/);
  assert.match(rendered, /\| grok-4\.6 \| 9 \| 1 \| 0 \| 0 \| 90\.0% \|/);
  assert.match(rendered, /### Success rate by vendor/);
});

test('replaceMarkedRegion searches for the end marker only after the start marker', () => {
  const text = `${README_END}\nnoise\n${README_START}\nold\n${README_END}\nafter`;
  const result = replaceMarkedRegion(text, README_START, README_END, 'new');
  // The first line (a stray END marker before START) must be left alone;
  // only the pair after START should be replaced.
  assert.match(result, new RegExp(`^${README_END}\\nnoise\\n${README_START}`));
  assert.equal(
    result,
    `${README_END}\nnoise\n${README_START}\n\nnew\n\n${README_END}\nafter`,
  );
});

test('readSamples reports the source path and line number on invalid JSON', () => {
  withSandboxCwd(() => {
    writeFileSync(
      'samples.jsonl',
      `${JSON.stringify(issueLoopSample({ issueNumber: 1 }))}\nnot json\n`,
    );
    assert.throws(
      () => readSamples(['samples.jsonl']),
      /samples\.jsonl:2: invalid JSON/,
    );
  });
});

test('readEvents reports the source path and line number on a non-object line', () => {
  withSandboxCwd(() => {
    writeFileSync('events.jsonl', '{}\n"just a string"\n');
    assert.throws(
      () => readEvents(['events.jsonl']),
      /events\.jsonl:2: event line is not a JSON object/,
    );
  });
});

test('CLI: --now rejects an invalid timestamp with a clean usage error, not a raw exception', () => {
  withSandboxCwd(() => {
    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/token-cost-report.mjs'),
          '--check',
          '--now',
          'not-a-date',
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      threw = true;
      const e = error as { status: number; stderr: string };
      assert.equal(e.status, 2);
      assert.match(
        e.stderr,
        /--now is not a valid ISO8601 timestamp: not-a-date/,
      );
      assert.doesNotMatch(e.stderr, /RangeError|Invalid time value/);
    }
    assert.ok(threw, 'expected the CLI to exit non-zero');
  });
});

test('resolveDefaultBranchGuard blocks --apply on the default branch without an override (#2452)', () => {
  const result = resolveDefaultBranchGuard(false, {
    getCurrentBranch: () => 'main',
    getDefaultBranch: () => 'main',
  });
  assert.deepEqual(result, {
    blocked: true,
    currentBranch: 'main',
    defaultBranch: 'main',
  });
});

test('resolveDefaultBranchGuard --allow-default-branch bypasses the block on the default branch (#2452)', () => {
  const result = resolveDefaultBranchGuard(true, {
    getCurrentBranch: () => 'main',
    getDefaultBranch: () => 'main',
  });
  assert.equal(result.blocked, false);
});

test('resolveDefaultBranchGuard passes through unaffected on a non-default branch (#2452)', () => {
  const withoutOverride = resolveDefaultBranchGuard(false, {
    getCurrentBranch: () => 'issue/2452-fix-token-cost-refuse-apply-on',
    getDefaultBranch: () => 'main',
  });
  assert.equal(withoutOverride.blocked, false);

  const withOverride = resolveDefaultBranchGuard(true, {
    getCurrentBranch: () => 'issue/2452-fix-token-cost-refuse-apply-on',
    getDefaultBranch: () => 'main',
  });
  assert.equal(withOverride.blocked, false);
});

test('resolveDefaultBranchGuard real getDefaultBranch falls back to "main" when origin/HEAD is unset locally (#2452)', () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-report-git-'));
  process.chdir(sandbox);
  try {
    execFileSync('git', ['init', '-b', 'main', '-q']);
    // No `origin` remote configured at all, matching a clone that never
    // ran `git remote set-head origin -a` -- `git symbolic-ref --short
    // refs/remotes/origin/HEAD` fails, and the real getDefaultBranch must
    // fall back to the fixed 'main' rather than throwing.
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=test',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'init',
      ],
      { stdio: 'pipe' },
    );
    // Real deps (no injected stub): exercises both the git subprocess
    // calls and the fallback branch together.
    const result = resolveDefaultBranchGuard(false);
    assert.equal(result.currentBranch, 'main');
    assert.equal(result.defaultBranch, 'main');
    assert.equal(result.blocked, true);
  } finally {
    process.chdir(originalCwd);
  }
});

/** Initializes a throwaway git repo on `branch` with one empty commit and
 * runs `fn` with it as `process.cwd()`, restoring the original cwd after --
 * lets a CLI-level test drive the real `getCurrentBranch`/`getDefaultBranch`
 * git subprocess calls end to end (#2452). */
function withGitSandboxCwd(branch: string, fn: () => void): void {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), 'idd-token-cost-report-cli-git-'));
  process.chdir(sandbox);
  try {
    execFileSync('git', ['init', '-b', branch, '-q']);
    execFileSync(
      'git',
      [
        '-c',
        'commit.gpgsign=false',
        '-c',
        'user.email=test@example.com',
        '-c',
        'user.name=test',
        'commit',
        '--allow-empty',
        '-q',
        '-m',
        'init',
      ],
      { stdio: 'pipe' },
    );
    fn();
  } finally {
    process.chdir(originalCwd);
  }
}

test('CLI: --apply refuses on the default branch without --allow-default-branch, before any write (#2452)', () => {
  withGitSandboxCwd('main', () => {
    let threw = false;
    try {
      execFileSync(
        process.execPath,
        [join(REPO_ROOT, 'scripts/token-cost-report.mjs'), '--apply'],
        { encoding: 'utf8', stdio: 'pipe' },
      );
    } catch (error) {
      threw = true;
      const e = error as { status: number; stderr: string };
      assert.equal(e.status, 2);
      assert.match(
        e.stderr,
        /refusing to run on the repository's default branch "main".*Pass --allow-default-branch to override/s,
      );
    }
    assert.ok(threw, 'expected the CLI to exit non-zero');
    assert.equal(
      existsSync('docs/token-cost-snapshot.json'),
      false,
      'the default-branch guard must fire before any write',
    );
  });
});

test('CLI: --apply --allow-default-branch bypasses the guard on the default branch (#2452)', () => {
  withGitSandboxCwd('main', () => {
    // No --in supplied: the guard must pass through, so the run fails on
    // the pre-existing, already-covered "requires at least one --in"
    // error instead of the branch-refusal message -- proving the override
    // actually reached past the guard rather than short-circuiting it.
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            join(REPO_ROOT, 'scripts/token-cost-report.mjs'),
            '--apply',
            '--allow-default-branch',
          ],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      (error: unknown) => {
        const e = error as { status: number; stderr: string };
        assert.equal(e.status, 2);
        assert.match(e.stderr, /--apply requires at least one --in/);
        assert.doesNotMatch(e.stderr, /refusing to run on the repository/);
        return true;
      },
    );
  });
});

test('CLI: --apply passes through unaffected on a non-default branch (#2452)', () => {
  withGitSandboxCwd('issue/2452-fix-token-cost-refuse-apply-on', () => {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [join(REPO_ROOT, 'scripts/token-cost-report.mjs'), '--apply'],
          { encoding: 'utf8', stdio: 'pipe' },
        ),
      (error: unknown) => {
        const e = error as { status: number; stderr: string };
        assert.equal(e.status, 2);
        assert.match(e.stderr, /--apply requires at least one --in/);
        assert.doesNotMatch(e.stderr, /refusing to run on the repository/);
        return true;
      },
    );
  });
});
