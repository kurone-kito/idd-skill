#!/usr/bin/env node
// idd-generated-from: src/scripts/context-tax-report.mts
//
// The scripts/context-tax-report.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood reporter (#2294): aggregates locally-harvested
// context-tax samples (#2288's contract) into a committed snapshot, then
// renders that snapshot into fixed-template README/docs regions. CI never
// sees the raw JSONL (it lives outside git, under `~/.grok` / `~/.claude` /
// `~/.codex`) -- `--check` only compares the committed snapshot against the
// committed regions, so it never needs `--in`. Not registered in
// HELPER_COMMANDS: this is a maintainer/CI-only dogfood tool, never an
// adopter-facing helper (see SOURCE_REPO_INTERNAL_ENTRY_PATHS /
// DOGFOOD_ONLY_CONCRETE_TOOLS in the two guard test files).

import { readFileSync, writeFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mts';
import {
  assertContextTaxSample,
  assertContextTaxSnapshot,
  CONTEXT_TAX_STAGE_IDS,
  type ContextTaxIssueLoopSample,
  type ContextTaxPercentiles,
  type ContextTaxSample,
  type ContextTaxSnapshot,
  type ContextTaxStageId,
  type ContextTaxStageUsagePercentiles,
  type ContextTaxSuccessRate,
  type ContextTaxUsage,
  type ContextTaxUsagePercentiles,
  type ContextTaxVendor,
  isIssueLoopSample,
} from './context-tax-core.mts';

const DEFAULT_SNAPSHOT_PATH = 'docs/context-tax-snapshot.json';
const README_PATH = 'README.md';
const README_JA_PATH = 'README.ja.md';
const CONTEXT_TAX_DOCS_PATH = 'docs/context-tax.md';
const MIN_PUBLISHABLE_SAMPLES = 10;
const MIN_PUBLISHABLE_VENDORS = 2;

const USAGE_FIELDS = [
  'inputUncached',
  'cacheRead',
  'cacheCreation',
  'output',
  'reasoning',
] as const;

const README_START = '<!-- context-tax-readme:start -->';
const README_END = '<!-- context-tax-readme:end -->';
const DOCS_START = '<!-- context-tax-docs:start -->';
const DOCS_END = '<!-- context-tax-docs:end -->';

// ---------------------------------------------------------------------------
// JSONL input
// ---------------------------------------------------------------------------

/** Parse one JSONL file into non-blank, trimmed lines. */
function readJsonlLines(path: string): string[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Read and validate every `--in` file's samples. A line that fails to
 * parse as JSON or fails {@link assertContextTaxSample} throws immediately
 * (fail closed -- a malformed harvested record must not silently vanish
 * from the aggregate).
 */
export function readSamples(paths: readonly string[]): ContextTaxSample[] {
  const samples: ContextTaxSample[] = [];
  for (const path of paths) {
    for (const line of readJsonlLines(path)) {
      const sample = JSON.parse(line) as ContextTaxSample;
      assertContextTaxSample(sample);
      samples.push(sample);
    }
  }
  return samples;
}

/**
 * Read every `--events` file. Events are accepted for CLI-surface parity
 * with the harvest/adapter issues that produce them, and validated as
 * well-formed JSON objects, but this reporter does not join them into the
 * aggregate: an `issue-loop` sample already carries its own per-stage
 * `usage` breakdown (required by its own schema), so no further join is
 * needed at report time -- any marker-join/phase-event reconciliation
 * happens upstream, at harvest time.
 */
export function readEvents(paths: readonly string[]): unknown[] {
  const events: unknown[] = [];
  for (const path of paths) {
    for (const line of readJsonlLines(path)) {
      const event = JSON.parse(line);
      if (typeof event !== 'object' || event === null) {
        throw new Error(`${path}: event line is not a JSON object: ${line}`);
      }
      events.push(event);
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Linear-interpolation percentile over an already-sorted ascending array. */
function interpolatedPercentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function computePercentiles(values: readonly number[]): ContextTaxPercentiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: interpolatedPercentile(sorted, 25),
    p50: interpolatedPercentile(sorted, 50),
    p75: interpolatedPercentile(sorted, 75),
  };
}

function computeUsagePercentiles(
  usages: readonly ContextTaxUsage[],
): ContextTaxUsagePercentiles {
  const out = {} as Record<
    (typeof USAGE_FIELDS)[number],
    ContextTaxPercentiles
  >;
  for (const field of USAGE_FIELDS) {
    out[field] = computePercentiles(usages.map((usage) => usage[field]));
  }
  return out as ContextTaxUsagePercentiles;
}

function computeStageUsage(
  samples: readonly ContextTaxIssueLoopSample[],
): ContextTaxStageUsagePercentiles[] {
  const byStage = new Map<ContextTaxStageId, ContextTaxUsage[]>();
  for (const sample of samples) {
    for (const stage of sample.stages) {
      const bucket = byStage.get(stage.id) ?? [];
      bucket.push(stage.usage);
      byStage.set(stage.id, bucket);
    }
  }
  const out: ContextTaxStageUsagePercentiles[] = [];
  for (const id of CONTEXT_TAX_STAGE_IDS) {
    const usages = byStage.get(id);
    if (usages && usages.length > 0) {
      out.push({ id, usage: computeUsagePercentiles(usages) });
    }
  }
  return out;
}

function computeCacheHitRatio(totalUsage: ContextTaxUsagePercentiles): number {
  const cacheRead = totalUsage.cacheRead.p50;
  const cacheCreation = totalUsage.cacheCreation.p50;
  const inputUncached = totalUsage.inputUncached.p50;
  return cacheRead / Math.max(1, cacheRead + cacheCreation + inputUncached);
}

function computeSuccessRate<K extends string>(
  samples: readonly ContextTaxIssueLoopSample[],
  keyOf: (sample: ContextTaxIssueLoopSample) => K,
): Record<K, ContextTaxSuccessRate> {
  const buckets = new Map<
    K,
    { merged: number; aborted: number; unclaimed: number; humanHandoff: number }
  >();
  for (const sample of samples) {
    const key = keyOf(sample);
    const bucket = buckets.get(key) ?? {
      merged: 0,
      aborted: 0,
      unclaimed: 0,
      humanHandoff: 0,
    };
    if (sample.outcome === 'merged') {
      bucket.merged += 1;
    } else if (sample.outcome === 'aborted') {
      bucket.aborted += 1;
    } else if (sample.outcome === 'unclaimed') {
      bucket.unclaimed += 1;
    } else if (sample.outcome === 'human-handoff') {
      bucket.humanHandoff += 1;
    }
    buckets.set(key, bucket);
  }
  const out = {} as Record<K, ContextTaxSuccessRate>;
  for (const [key, bucket] of buckets) {
    const denom =
      bucket.merged + bucket.aborted + bucket.unclaimed + bucket.humanHandoff;
    out[key] = { ...bucket, rate: denom === 0 ? 0 : bucket.merged / denom };
  }
  return out;
}

/**
 * Aggregate raw samples into a committed {@link ContextTaxSnapshot}. Only
 * `kind: 'issue-loop'` samples with a non-`'unknown'` outcome count -- per
 * #2294's spec, `outcome: 'unknown'` and session-unscoped records are
 * excluded from every figure in the snapshot, not only the success-rate
 * breakdown.
 */
export function aggregateSnapshot(
  samples: readonly ContextTaxSample[],
  now: Date,
): ContextTaxSnapshot {
  const issueLoopSamples = samples
    .filter(isIssueLoopSample)
    .filter((sample) => sample.outcome !== 'unknown');
  const sampleCount = issueLoopSamples.length;
  const vendors = [
    ...new Set(issueLoopSamples.map((sample) => sample.vendor)),
  ].sort() as ContextTaxVendor[];
  const publishable =
    sampleCount >= MIN_PUBLISHABLE_SAMPLES &&
    vendors.length >= MIN_PUBLISHABLE_VENDORS;
  const totalUsage = computeUsagePercentiles(
    issueLoopSamples.map((sample) => sample.usage),
  );
  const snapshot: ContextTaxSnapshot = {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    minPublishableSamples: MIN_PUBLISHABLE_SAMPLES,
    minPublishableVendors: MIN_PUBLISHABLE_VENDORS,
    publishable,
    sampleCount,
    vendors,
    asOf: now.toISOString().slice(0, 10),
    totalUsage,
    stageUsage: computeStageUsage(issueLoopSamples),
    compactionCount: computePercentiles(
      issueLoopSamples.map((sample) => sample.compactionCount),
    ),
    cacheHitRatio: computeCacheHitRatio(totalUsage),
    successRateByModel: computeSuccessRate(
      issueLoopSamples,
      (sample) => sample.model,
    ),
    successRateByVendor: computeSuccessRate(
      issueLoopSamples,
      (sample) => sample.vendor,
    ),
  };
  assertContextTaxSnapshot(snapshot);
  return snapshot;
}

// ---------------------------------------------------------------------------
// Rendering (fixed templates only -- never a live translation)
// ---------------------------------------------------------------------------

function formatVendorList(vendors: readonly ContextTaxVendor[]): string {
  return [...vendors].sort().join(', ');
}

/**
 * Word-wrap at whitespace so every line stays within `width` (MD013's
 * default `line_length`, minus a safety margin) -- Markdown collapses a
 * single newline inside a paragraph to a space, so this never changes the
 * rendered meaning. Space-delimited (English) content only: CJK prose has
 * no spaces to break on, and this repository's markdownlint config does
 * not flag long space-free lines, so the Japanese blurb is left as one
 * line.
 */
function wrapProse(text: string, width = 76): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.join('\n');
}

function renderReadmeRegionEn(snapshot: ContextTaxSnapshot): string {
  if (!snapshot.publishable) {
    return wrapProse(
      'Context-tax measurement is in progress; see [`docs/context-tax.md`](docs/context-tax.md) for the methodology.',
    );
  }
  const cacheHitPct = Math.round(snapshot.cacheHitRatio * 100);
  return wrapProse(
    `Context tax: median ${Math.round(snapshot.totalUsage.inputUncached.p50)} input tokens, ` +
      `${cacheHitPct}% cache-hit rate, ${Math.round(snapshot.compactionCount.p50)} compactions ` +
      `per issue loop (n=${snapshot.sampleCount}, ${formatVendorList(snapshot.vendors)}, as of ${snapshot.asOf}). ` +
      'See [`docs/context-tax.md`](docs/context-tax.md) for the full methodology.',
  );
}

function renderReadmeRegionJa(snapshot: ContextTaxSnapshot): string {
  if (!snapshot.publishable) {
    return 'コンテキスト税の計測は現在進行中です。詳しい方法論は [`docs/context-tax.md`](docs/context-tax.md) を参照してください。';
  }
  const cacheHitPct = Math.round(snapshot.cacheHitRatio * 100);
  return (
    `コンテキスト税: issue ループ1件あたり中央値 ${Math.round(snapshot.totalUsage.inputUncached.p50)} 入力トークン、` +
    `キャッシュヒット率 ${cacheHitPct}%、コンパクション ${Math.round(snapshot.compactionCount.p50)} 回` +
    `(n=${snapshot.sampleCount}、${formatVendorList(snapshot.vendors)}、${snapshot.asOf} 時点)。` +
    '詳しい方法論は [`docs/context-tax.md`](docs/context-tax.md) を参照してください。'
  );
}

function renderDocsTableRegion(snapshot: ContextTaxSnapshot): string {
  if (!snapshot.publishable) {
    return `Not yet publishable, n=${snapshot.sampleCount}.`;
  }
  const lines = [
    '| Metric | p25 | p50 | p75 |',
    '| --- | --- | --- | --- |',
    ...USAGE_FIELDS.map((field) => {
      const p = snapshot.totalUsage[field];
      return `| ${field} | ${Math.round(p.p25)} | ${Math.round(p.p50)} | ${Math.round(p.p75)} |`;
    }),
    `| compactionCount | ${Math.round(snapshot.compactionCount.p25)} | ${Math.round(snapshot.compactionCount.p50)} | ${Math.round(snapshot.compactionCount.p75)} |`,
    '',
    `n=${snapshot.sampleCount}, vendors=${formatVendorList(snapshot.vendors)}, cache-hit ratio=${(snapshot.cacheHitRatio * 100).toFixed(1)}%, as of ${snapshot.asOf}.`,
  ];
  return lines.join('\n');
}

/** Replace the text strictly between two marker lines, keeping the markers. */
export function replaceMarkedRegion(
  text: string,
  startMarker: string,
  endMarker: string,
  innerContent: string,
): string {
  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`marked region ${startMarker} .. ${endMarker} not found`);
  }
  const before = text.slice(0, startIndex + startMarker.length);
  const after = text.slice(endIndex);
  return `${before}\n\n${innerContent}\n\n${after}`;
}

// ---------------------------------------------------------------------------
// Apply / check
// ---------------------------------------------------------------------------

function writeRenderedFiles(snapshot: ContextTaxSnapshot): void {
  const readme = readFileSync(README_PATH, 'utf8');
  writeFileSync(
    README_PATH,
    replaceMarkedRegion(
      readme,
      README_START,
      README_END,
      renderReadmeRegionEn(snapshot),
    ),
  );
  const readmeJa = readFileSync(README_JA_PATH, 'utf8');
  writeFileSync(
    README_JA_PATH,
    replaceMarkedRegion(
      readmeJa,
      README_START,
      README_END,
      renderReadmeRegionJa(snapshot),
    ),
  );
  const docsPage = readFileSync(CONTEXT_TAX_DOCS_PATH, 'utf8');
  writeFileSync(
    CONTEXT_TAX_DOCS_PATH,
    replaceMarkedRegion(
      docsPage,
      DOCS_START,
      DOCS_END,
      renderDocsTableRegion(snapshot),
    ),
  );
}

/**
 * Returns the list of files whose marked region does not match what the
 * committed snapshot would render (empty when everything is in sync).
 */
export function checkRenderedFiles(snapshot: ContextTaxSnapshot): string[] {
  const drifted: string[] = [];
  const checks: [string, string][] = [
    [README_PATH, renderReadmeRegionEn(snapshot)],
    [README_JA_PATH, renderReadmeRegionJa(snapshot)],
    [CONTEXT_TAX_DOCS_PATH, renderDocsTableRegion(snapshot)],
  ];
  for (const [path, expectedInner] of checks) {
    const content = readFileSync(path, 'utf8');
    const marker =
      path === CONTEXT_TAX_DOCS_PATH
        ? [DOCS_START, DOCS_END]
        : [README_START, README_END];
    let expected: string;
    try {
      expected = replaceMarkedRegion(
        content,
        marker[0],
        marker[1],
        expectedInner,
      );
    } catch (error) {
      drifted.push(`${path}: ${(error as Error).message}`);
      continue;
    }
    if (expected !== content) {
      drifted.push(
        `${path}: marked region drifted from the committed snapshot`,
      );
    }
  }
  return drifted;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const CONTEXT_TAX_REPORT_FLAG_SPEC = {
  '--in': { type: 'string', multiple: true },
  '--events': { type: 'string', multiple: true },
  '--snapshot': { type: 'string', default: DEFAULT_SNAPSHOT_PATH },
  '--apply': { type: 'boolean', default: false },
  '--check': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/context-tax-report.mjs --in <samples.jsonl> [--in <samples.jsonl> ...] [--events <events.jsonl> ...] [--snapshot <path>] --apply
  node scripts/context-tax-report.mjs [--snapshot <path>] --check

  --in <path>        Sample JSONL file (repeatable). Required with --apply.
  --events <path>     Event JSONL file (repeatable, optional). Accepted for
                      CLI-surface parity; not joined into the aggregate.
  --snapshot <path>   Snapshot artifact path (default: ${DEFAULT_SNAPSHOT_PATH}).
  --apply             Aggregate --in samples, write the snapshot, and
                      refresh the README.md / README.ja.md / docs/context-tax.md
                      marked regions.
  --check             Verify the committed snapshot's regions have not
                      drifted from README.md / README.ja.md / docs/context-tax.md.
                      Exits non-zero on drift. Does not read --in.
  --now <ISO8601>     Override the current time (tests only).
  --help, -h          Show this help.
`);
}

if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    CONTEXT_TAX_REPORT_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const apply = values.apply as boolean;
  const check = values.check as boolean;
  if (apply === check) {
    process.stderr.write('exactly one of --apply or --check is required\n');
    process.exit(2);
  }
  const snapshotPath = values.snapshot as string;
  const now = values.now ? new Date(values.now as string) : new Date();

  if (apply) {
    const inPaths = (values.in as string[] | undefined) ?? [];
    if (inPaths.length === 0) {
      process.stderr.write(
        '--apply requires at least one --in <samples.jsonl>\n',
      );
      process.exit(2);
    }
    readEvents((values.events as string[] | undefined) ?? []);
    const samples = readSamples(inPaths);
    const snapshot = aggregateSnapshot(samples, now);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeRenderedFiles(snapshot);
    process.stdout.write(
      `context-tax-report: wrote ${snapshotPath} (n=${snapshot.sampleCount}, publishable=${snapshot.publishable})\n`,
    );
  } else {
    const snapshot = JSON.parse(
      readFileSync(snapshotPath, 'utf8'),
    ) as ContextTaxSnapshot;
    assertContextTaxSnapshot(snapshot);
    const drifted = checkRenderedFiles(snapshot);
    if (drifted.length > 0) {
      process.stderr.write(
        `context-tax-report --check: drift found:\n${drifted.map((d) => `  - ${d}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('context-tax-report: no drift.\n');
  }
}
