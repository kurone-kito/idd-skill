#!/usr/bin/env node
// idd-generated-from: src/scripts/token-cost-report.mts
//
// The scripts/token-cost-report.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood reporter (#2294): aggregates locally-harvested
// token-cost samples (#2288's contract) into a committed snapshot, then
// renders that snapshot into fixed-template README/docs regions. CI never
// sees the raw JSONL (it lives outside git, under `~/.grok` / `~/.claude` /
// `~/.codex`) -- `--check` only compares the committed snapshot against the
// committed regions, so it never needs `--in`. Not registered in
// HELPER_COMMANDS: this is a maintainer/CI-only dogfood tool, never an
// adopter-facing helper (see SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import {
  assertTokenCostSample,
  assertTokenCostSnapshot,
  isIssueLoopSample,
  TOKEN_COST_STAGE_IDS,
} from './token-cost-core.mjs';

const DEFAULT_SNAPSHOT_PATH = 'docs/token-cost-snapshot.json';
const README_PATH = 'README.md';
const README_JA_PATH = 'README.ja.md';
const TOKEN_COST_DOCS_PATH = 'docs/token-cost.md';
const MIN_PUBLISHABLE_SAMPLES = 10;
const MIN_PUBLISHABLE_VENDORS = 2;
const USAGE_FIELDS = [
  'inputUncached',
  'cacheRead',
  'cacheCreation',
  'output',
  'reasoning',
];
const README_START = '<!-- token-cost-readme:start -->';
const README_END = '<!-- token-cost-readme:end -->';
const DOCS_START = '<!-- token-cost-docs:start -->';
const DOCS_END = '<!-- token-cost-docs:end -->';
/** Parse one JSONL file into non-blank, trimmed lines, each tagged with its line number. */
function readJsonlLines(path) {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((text, index) => ({ lineNumber: index + 1, text: text.trim() }))
    .filter((line) => line.text.length > 0);
}
/**
 * Read and validate every `--in` file's samples. A line that fails to
 * parse as JSON or fails {@link assertTokenCostSample} throws immediately,
 * quoting the source file and line number (fail closed -- a malformed
 * harvested record must not silently vanish from the aggregate).
 */
export function readSamples(paths) {
  const samples = [];
  for (const path of paths) {
    for (const { lineNumber, text } of readJsonlLines(path)) {
      let sample;
      try {
        sample = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${path}:${lineNumber}: invalid JSON (${error.message})`,
        );
      }
      assertTokenCostSample(sample);
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
export function readEvents(paths) {
  const events = [];
  for (const path of paths) {
    for (const { lineNumber, text } of readJsonlLines(path)) {
      let event;
      try {
        event = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${path}:${lineNumber}: invalid JSON (${error.message})`,
        );
      }
      if (typeof event !== 'object' || event === null) {
        throw new Error(
          `${path}:${lineNumber}: event line is not a JSON object: ${text}`,
        );
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
function interpolatedPercentile(sorted, p) {
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
function computePercentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: interpolatedPercentile(sorted, 25),
    p50: interpolatedPercentile(sorted, 50),
    p75: interpolatedPercentile(sorted, 75),
  };
}
function computeUsagePercentiles(usages) {
  const out = {};
  for (const field of USAGE_FIELDS) {
    out[field] = computePercentiles(usages.map((usage) => usage[field]));
  }
  return out;
}
function computeStageUsage(samples) {
  const byStage = new Map();
  for (const sample of samples) {
    for (const stage of sample.stages) {
      const bucket = byStage.get(stage.id) ?? [];
      bucket.push(stage.usage);
      byStage.set(stage.id, bucket);
    }
  }
  const out = [];
  for (const id of TOKEN_COST_STAGE_IDS) {
    const usages = byStage.get(id);
    if (usages && usages.length > 0) {
      out.push({ id, usage: computeUsagePercentiles(usages) });
    }
  }
  return out;
}
/**
 * Median of each sample's own cache-hit ratio, not the ratio of the three
 * usage fields' independent medians -- each field's p50 can come from a
 * different sample, so dividing them directly can report a figure outside
 * every observed per-sample ratio on a skewed sample set.
 */
function computeCacheHitRatio(samples) {
  const ratios = samples.map(({ usage }) => {
    const denom = usage.cacheRead + usage.cacheCreation + usage.inputUncached;
    return usage.cacheRead / Math.max(1, denom);
  });
  return computePercentiles(ratios).p50;
}
function computeSuccessRate(samples, keyOf) {
  const buckets = new Map();
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
  const out = {};
  for (const [key, bucket] of buckets) {
    const denom =
      bucket.merged + bucket.aborted + bucket.unclaimed + bucket.humanHandoff;
    out[key] = { ...bucket, rate: denom === 0 ? 0 : bucket.merged / denom };
  }
  return out;
}
/**
 * Aggregate raw samples into a committed {@link TokenCostSnapshot}. Only
 * `kind: 'issue-loop'` samples with a non-`'unknown'` outcome count -- per
 * #2294's spec, `outcome: 'unknown'` and session-unscoped records are
 * excluded from every figure in the snapshot, not only the success-rate
 * breakdown.
 */
export function aggregateSnapshot(samples, now) {
  const issueLoopSamples = samples
    .filter(isIssueLoopSample)
    .filter((sample) => sample.outcome !== 'unknown');
  const sampleCount = issueLoopSamples.length;
  const vendors = [
    ...new Set(issueLoopSamples.map((sample) => sample.vendor)),
  ].sort();
  const publishable =
    sampleCount >= MIN_PUBLISHABLE_SAMPLES &&
    vendors.length >= MIN_PUBLISHABLE_VENDORS;
  const totalUsage = computeUsagePercentiles(
    issueLoopSamples.map((sample) => sample.usage),
  );
  const snapshot = {
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
    cacheHitRatio: computeCacheHitRatio(issueLoopSamples),
    successRateByModel: computeSuccessRate(
      issueLoopSamples,
      (sample) => sample.model,
    ),
    successRateByVendor: computeSuccessRate(
      issueLoopSamples,
      (sample) => sample.vendor,
    ),
  };
  assertTokenCostSnapshot(snapshot);
  return snapshot;
}
// ---------------------------------------------------------------------------
// Rendering (fixed templates only -- never a live translation)
// ---------------------------------------------------------------------------
function formatVendorList(vendors) {
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
function wrapProse(text, width = 76) {
  const words = text.split(' ');
  const lines = [];
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
/**
 * Wrap Japanese (space-free) prose at `、`/`。` boundaries so every line
 * stays within `width`. Unlike {@link wrapProse}, a chunk boundary is a
 * punctuation mark, not whitespace: joining chunks with a bare `\n`
 * (no inserted space) keeps the rendered text correct, since CommonMark
 * renders a soft line break as a space and Japanese prose has none there
 * naturally. A single chunk longer than `width` on its own (for example
 * one holding the markdown link) is still emitted as its own line rather
 * than being force-split mid-token.
 */
function wrapCjkProse(text, width = 38) {
  const chunks = text.split(/(?<=[、。])/);
  const lines = [];
  let current = '';
  for (const chunk of chunks) {
    if (current.length > 0 && current.length + chunk.length > width) {
      lines.push(current);
      current = chunk;
    } else {
      current += chunk;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  return lines.join('\n');
}
export function renderReadmeRegionEn(snapshot) {
  if (!snapshot.publishable) {
    return wrapProse(
      'Token-cost measurement is in progress; see [`docs/token-cost.md`](docs/token-cost.md) for the methodology.',
    );
  }
  const cacheHitPct = Math.round(snapshot.cacheHitRatio * 100);
  return wrapProse(
    `Token cost: median ${Math.round(snapshot.totalUsage.inputUncached.p50)} input tokens, ` +
      `${cacheHitPct}% cache-hit rate, ${Math.round(snapshot.compactionCount.p50)} compactions ` +
      `per issue loop (n=${snapshot.sampleCount}, ${formatVendorList(snapshot.vendors)}, as of ${snapshot.asOf}). ` +
      'See [`docs/token-cost.md`](docs/token-cost.md) for the full methodology.',
  );
}
export function renderReadmeRegionJa(snapshot) {
  if (!snapshot.publishable) {
    return wrapCjkProse(
      'トークンコストの計測は現在進行中です。詳しい方法論は [`docs/token-cost.md`](docs/token-cost.md) を参照してください。',
    );
  }
  const cacheHitPct = Math.round(snapshot.cacheHitRatio * 100);
  return wrapCjkProse(
    `トークンコスト: issue ループ1件あたり中央値 ${Math.round(snapshot.totalUsage.inputUncached.p50)} 入力トークン、` +
      `キャッシュヒット率 ${cacheHitPct}%、コンパクション ${Math.round(snapshot.compactionCount.p50)} 回` +
      `(n=${snapshot.sampleCount}、${formatVendorList(snapshot.vendors)}、${snapshot.asOf} 時点)。` +
      '詳しい方法論は [`docs/token-cost.md`](docs/token-cost.md) を参照してください。',
  );
}
function renderSuccessRateTable(title, rates) {
  const keys = Object.keys(rates).sort();
  if (keys.length === 0) {
    return [];
  }
  return [
    `### ${title}`,
    '',
    '| Key | Merged | Aborted | Unclaimed | Human handoff | Rate |',
    '| --- | --- | --- | --- | --- | --- |',
    ...keys.map((key) => {
      const r = rates[key];
      return `| ${key} | ${r.merged} | ${r.aborted} | ${r.unclaimed} | ${r.humanHandoff} | ${(r.rate * 100).toFixed(1)}% |`;
    }),
    '',
  ];
}
export function renderDocsTableRegion(snapshot) {
  if (!snapshot.publishable) {
    return `Not yet publishable, n=${snapshot.sampleCount}.`;
  }
  const lines = [
    '### Total usage',
    '',
    '| Metric | p25 | p50 | p75 |',
    '| --- | --- | --- | --- |',
    ...USAGE_FIELDS.map((field) => {
      const p = snapshot.totalUsage[field];
      return `| ${field} | ${Math.round(p.p25)} | ${Math.round(p.p50)} | ${Math.round(p.p75)} |`;
    }),
    `| compactionCount | ${Math.round(snapshot.compactionCount.p25)} | ${Math.round(snapshot.compactionCount.p50)} | ${Math.round(snapshot.compactionCount.p75)} |`,
    '',
  ];
  if (snapshot.stageUsage.length > 0) {
    lines.push(
      '### By stage (inputUncached)',
      '',
      '| Stage | p25 | p50 | p75 |',
      '| --- | --- | --- | --- |',
    );
    for (const stage of snapshot.stageUsage) {
      const p = stage.usage.inputUncached;
      lines.push(
        `| ${stage.id} | ${Math.round(p.p25)} | ${Math.round(p.p50)} | ${Math.round(p.p75)} |`,
      );
    }
    lines.push('');
  }
  lines.push(
    ...renderSuccessRateTable(
      'Success rate by model',
      snapshot.successRateByModel,
    ),
  );
  lines.push(
    ...renderSuccessRateTable(
      'Success rate by vendor',
      snapshot.successRateByVendor,
    ),
  );
  lines.push(
    `n=${snapshot.sampleCount}, vendors=${formatVendorList(snapshot.vendors)}, cache-hit ratio=${(snapshot.cacheHitRatio * 100).toFixed(1)}%, as of ${snapshot.asOf}.`,
  );
  return lines.join('\n');
}
/** Replace the text strictly between two marker lines, keeping the markers. */
export function replaceMarkedRegion(
  text,
  startMarker,
  endMarker,
  innerContent,
) {
  const startIndex = text.indexOf(startMarker);
  // Search for endMarker only after startMarker, not from the start of the
  // file -- otherwise a same-named marker (or endMarker text) appearing
  // earlier in the file would match first and silently pick the wrong
  // region boundary.
  const endIndex =
    startIndex === -1
      ? -1
      : text.indexOf(endMarker, startIndex + startMarker.length);
  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`marked region ${startMarker} .. ${endMarker} not found`);
  }
  const before = text.slice(0, startIndex + startMarker.length);
  const after = text.slice(endIndex);
  return `${before}\n\n${innerContent}\n\n${after}`;
}
const defaultBranchGuardDeps = {
  getCurrentBranch: () =>
    execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim(),
  getDefaultBranch: () => {
    try {
      return execFileSync(
        'git',
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .trim()
        .replace(/^origin\//, '');
    } catch {
      return 'main';
    }
  },
};
/**
 * #2452: refuse `--apply` on the repository's default branch unless
 * `--allow-default-branch` was passed. Running the aggregator from the
 * shared PRIMARY worktree while it happens to be checked out on the
 * default branch leaves dirty, uncommitted output sitting there, which can
 * block every concurrent session's next B1 `git merge --ff-only` worktree
 * creation (a footgun already hit once during #2439). The caller must run
 * this before any write.
 */
export function resolveDefaultBranchGuard(
  allowOverride,
  deps = defaultBranchGuardDeps,
) {
  const currentBranch = deps.getCurrentBranch();
  const defaultBranch = deps.getDefaultBranch();
  return {
    blocked: !allowOverride && currentBranch === defaultBranch,
    currentBranch,
    defaultBranch,
  };
}
// ---------------------------------------------------------------------------
// Apply / check
// ---------------------------------------------------------------------------
function writeRenderedFiles(snapshot) {
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
  const docsPage = readFileSync(TOKEN_COST_DOCS_PATH, 'utf8');
  writeFileSync(
    TOKEN_COST_DOCS_PATH,
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
export function checkRenderedFiles(snapshot) {
  const drifted = [];
  const checks = [
    [README_PATH, renderReadmeRegionEn(snapshot)],
    [README_JA_PATH, renderReadmeRegionJa(snapshot)],
    [TOKEN_COST_DOCS_PATH, renderDocsTableRegion(snapshot)],
  ];
  for (const [path, expectedInner] of checks) {
    const content = readFileSync(path, 'utf8');
    const marker =
      path === TOKEN_COST_DOCS_PATH
        ? [DOCS_START, DOCS_END]
        : [README_START, README_END];
    let expected;
    try {
      expected = replaceMarkedRegion(
        content,
        marker[0],
        marker[1],
        expectedInner,
      );
    } catch (error) {
      drifted.push(`${path}: ${error.message}`);
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
const TOKEN_COST_REPORT_FLAG_SPEC = {
  '--in': { type: 'string', multiple: true },
  '--events': { type: 'string', multiple: true },
  '--snapshot': { type: 'string', default: DEFAULT_SNAPSHOT_PATH },
  '--apply': { type: 'boolean', default: false },
  '--check': { type: 'boolean', default: false },
  '--allow-default-branch': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/token-cost-report.mjs --in <samples.jsonl> [--in <samples.jsonl> ...] [--events <events.jsonl> ...] [--snapshot <path>] --apply
  node scripts/token-cost-report.mjs [--snapshot <path>] --check

  --in <path>        Sample JSONL file (repeatable). Required with --apply.
  --events <path>     Event JSONL file (repeatable, optional). Accepted for
                      CLI-surface parity; not joined into the aggregate.
  --snapshot <path>   Snapshot artifact path (default: ${DEFAULT_SNAPSHOT_PATH}).
  --apply             Aggregate --in samples, write the snapshot, and
                      refresh the README.md / README.ja.md / docs/token-cost.md
                      marked regions. Refused when the current branch is
                      the repository's default branch; pass
                      --allow-default-branch to proceed anyway.
  --allow-default-branch  Allow --apply to run while the current branch is
                          the repository's default branch (refused by
                          default -- see docs/token-cost.md).
  --check             Verify the committed snapshot's regions have not
                      drifted from README.md / README.ja.md / docs/token-cost.md.
                      Exits non-zero on drift. Does not read --in.
  --now <ISO8601>     Override the current time (tests only).
  --help, -h          Show this help.
`);
}
if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    TOKEN_COST_REPORT_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const apply = values.apply;
  const check = values.check;
  if (apply === check) {
    process.stderr.write('exactly one of --apply or --check is required\n');
    process.exit(2);
  }
  const snapshotPath = values.snapshot;
  let now = new Date();
  if (values.now) {
    now = new Date(values.now);
    if (Number.isNaN(now.getTime())) {
      process.stderr.write(
        `--now is not a valid ISO8601 timestamp: ${values.now}\n`,
      );
      process.exit(2);
    }
  }
  if (apply) {
    const guard = resolveDefaultBranchGuard(values['allow-default-branch']);
    if (guard.blocked) {
      process.stderr.write(
        `token-cost-report --apply: refusing to run on the repository's default branch "${guard.defaultBranch}" (current branch: "${guard.currentBranch}"). Pass --allow-default-branch to override.\n`,
      );
      process.exit(2);
    }
    const inPaths = values.in ?? [];
    if (inPaths.length === 0) {
      process.stderr.write(
        '--apply requires at least one --in <samples.jsonl>\n',
      );
      process.exit(2);
    }
    readEvents(values.events ?? []);
    const samples = readSamples(inPaths);
    const snapshot = aggregateSnapshot(samples, now);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeRenderedFiles(snapshot);
    process.stdout.write(
      `token-cost-report: wrote ${snapshotPath} (n=${snapshot.sampleCount}, publishable=${snapshot.publishable})\n`,
    );
  } else {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assertTokenCostSnapshot(snapshot);
    const drifted = checkRenderedFiles(snapshot);
    if (drifted.length > 0) {
      process.stderr.write(
        `token-cost-report --check: drift found:\n${drifted.map((d) => `  - ${d}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('token-cost-report: no drift.\n');
  }
}
