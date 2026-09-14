#!/usr/bin/env node
// idd-generated-from: src/scripts/idd-critique-report.mts
//
// The scripts/idd-critique-report.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Source-repo-only dogfood reporter (#3002, child of roadmap #3000):
// aggregates the locally-harvested critique-telemetry samples produced
// by idd-critique-harvest.mts into a committed snapshot, then renders
// that snapshot into docs/critique-telemetry.md's marked region --
// the same --apply/--check shape token-cost-report.mts already uses
// (docs/token-cost.md), independently reimplemented here rather than
// imported: this is a much smaller, single-producer/single-consumer
// pipeline with no vendor or per-stage dimension, so sharing code with
// the far larger token-cost reporter would trade a few dozen duplicated
// lines for cross-module coupling between two otherwise-independent
// measurements. Never registered in HELPER_COMMANDS or distributed to
// idd-template/ (see SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts) -- an adopter repository has
// no critique-loop telemetry data to report.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
import {
  parseHarvestedCritiqueTelemetrySample,
  sampleDedupKey,
} from './idd-critique-harvest.mjs';

const DEFAULT_SNAPSHOT_PATH = 'docs/idd-critique-snapshot.json';
// Deliberately NOT docs/idd-critique-telemetry.md: audit/sync-manifest.json's
// idd-template-docs-set pair treats every docs/idd-*.md file as required to
// have an idd-template/docs/idd-*.md mirror (adopter-distributed) --
// docs/token-cost.md avoids this the same way, by not starting with "idd-".
const DEFAULT_DOCS_PATH = 'docs/critique-telemetry.md';
const DOCS_START = '<!-- idd-critique-docs:start -->';
const DOCS_END = '<!-- idd-critique-docs:end -->';
const MIN_PUBLISHABLE_SAMPLES = 10;
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}
function isRateOrNull(value) {
  return (
    value === null || (typeof value === 'number' && value >= 0 && value <= 1)
  );
}
/**
 * Validate a snapshot's own shape and invariants (mirrors
 * token-cost-core.mts's assertTokenCostSnapshot's role for its own
 * snapshot type). Throws on the first violation.
 */
export function assertCritiqueTelemetrySnapshot(snapshot) {
  if (!isPlainObject(snapshot)) {
    throw new Error('snapshot is not a JSON object');
  }
  if (snapshot.schemaVersion !== 1) {
    throw new Error('snapshot.schemaVersion must be 1');
  }
  assertUtcCalendarDate(snapshot.generatedOn);
  if (!isNonNegativeInteger(snapshot.sampleCount)) {
    throw new Error('snapshot.sampleCount must be a non-negative integer');
  }
  if (!isNonNegativeInteger(snapshot.totalFindings)) {
    throw new Error('snapshot.totalFindings must be a non-negative integer');
  }
  const severity = snapshot.severityBreakdown;
  if (
    !isPlainObject(severity) ||
    !isNonNegativeInteger(severity.high) ||
    !isNonNegativeInteger(severity.medium) ||
    !isNonNegativeInteger(severity.low)
  ) {
    throw new Error(
      'snapshot.severityBreakdown must have non-negative integer high/medium/low',
    );
  }
  if (!isNonNegativeInteger(snapshot.acceptedCount)) {
    throw new Error('snapshot.acceptedCount must be a non-negative integer');
  }
  if (!isNonNegativeInteger(snapshot.rejectedCount)) {
    throw new Error('snapshot.rejectedCount must be a non-negative integer');
  }
  if (!isRateOrNull(snapshot.acceptRate)) {
    throw new Error('snapshot.acceptRate must be null or a number in [0, 1]');
  }
  if (!isRateOrNull(snapshot.rejectRate)) {
    throw new Error('snapshot.rejectRate must be null or a number in [0, 1]');
  }
  if (!isNonNegativeInteger(snapshot.delegateUsageCount)) {
    throw new Error(
      'snapshot.delegateUsageCount must be a non-negative integer',
    );
  }
  if (!isRateOrNull(snapshot.delegateUsageRate)) {
    throw new Error(
      'snapshot.delegateUsageRate must be null or a number in [0, 1]',
    );
  }
  // A rate that is merely shape-valid (null or in [0, 1]) can still be
  // stale relative to its own source counts -- e.g. one accepted and
  // one rejected finding with an unchanged acceptRate: 1 left over from
  // an earlier, different aggregation. --check never rereads samples,
  // so this recomputation is the only place that catches a corrupted
  // committed snapshot passing as clean (#3005 review, Codex).
  const decidedCount = snapshot.acceptedCount + snapshot.rejectedCount;
  const expectedAcceptRate =
    decidedCount > 0 ? snapshot.acceptedCount / decidedCount : null;
  if (snapshot.acceptRate !== expectedAcceptRate) {
    throw new Error(
      'snapshot.acceptRate must match acceptedCount/(acceptedCount + rejectedCount)',
    );
  }
  const expectedRejectRate =
    decidedCount > 0 ? snapshot.rejectedCount / decidedCount : null;
  if (snapshot.rejectRate !== expectedRejectRate) {
    throw new Error(
      'snapshot.rejectRate must match rejectedCount/(acceptedCount + rejectedCount)',
    );
  }
  const expectedDelegateUsageRate =
    snapshot.sampleCount > 0
      ? snapshot.delegateUsageCount / snapshot.sampleCount
      : null;
  if (snapshot.delegateUsageRate !== expectedDelegateUsageRate) {
    throw new Error(
      'snapshot.delegateUsageRate must match delegateUsageCount/sampleCount',
    );
  }
  if (!isNonNegativeInteger(snapshot.minPublishableSamples)) {
    throw new Error(
      'snapshot.minPublishableSamples must be a non-negative integer',
    );
  }
  if (typeof snapshot.publishable !== 'boolean') {
    throw new Error('snapshot.publishable must be a boolean');
  }
  const eligible = snapshot.sampleCount >= snapshot.minPublishableSamples;
  if (snapshot.publishable !== eligible) {
    throw new Error(
      'snapshot.publishable must match the sampleCount/minPublishableSamples gate',
    );
  }
}
/**
 * Validate a UTC calendar date string (`YYYY-MM-DD`), rejecting a
 * shape-valid but impossible date such as `2026-02-30` (#3005 review,
 * Copilot) by round-tripping through `Date`, mirroring
 * token-cost-core.mts's own `assertUtcCalendarDate`.
 */
function assertUtcCalendarDate(value) {
  if (typeof value !== 'string') {
    throw new Error('snapshot.generatedOn must be a YYYY-MM-DD UTC date');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('snapshot.generatedOn must be a YYYY-MM-DD UTC date');
  }
}
function readJsonlLines(path) {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .map((text, index) => ({ lineNumber: index + 1, text: text.trim() }))
    .filter((line) => line.text.length > 0);
}
/**
 * Read every `--in` file's already-harvested samples. Unlike the
 * harvester (which tolerates a malformed RAW log line by design), a
 * malformed line in an already-harvested samples file is a hard error:
 * fail closed rather than silently drop it from the aggregate, mirroring
 * token-cost-report.mts's own readSamples contract.
 *
 * Uses the harvester's own {@link parseHarvestedCritiqueTelemetrySample}
 * -- a strict validator for already-normalized records, distinct from
 * the lenient raw-payload {@link parseCritiqueTelemetryLine} -- rather
 * than a second hand-rolled shape check: #3002 C1 critique found an
 * earlier hand-rolled check here validated only that `severityBreakdown`
 * was a plain object, never its sub-fields or the `acceptedCount +
 * rejectedCount <= findingsCount` invariant; the fix for that first
 * reused the lenient raw parser directly, but #3005 review (Copilot)
 * found THAT silently "repaired" an already-harvested record with a
 * wrong `schemaVersion` or a missing `pr` key instead of failing closed.
 * The strict parser closes both gaps at once.
 *
 * Also deduplicates by {@link sampleDedupKey} across every `--in` file
 * combined (#3005 review, Codex and Copilot): a harvested samples file
 * can itself carry a duplicate record -- e.g. from two concurrent
 * harvester invocations racing past each other's in-flight write (see
 * harvestCritiqueTelemetry's own doc comment) -- and the harvester's own
 * dedup only ever prevents a *future* append, never retroactively
 * removes one already written. Without this, a duplicate permanently
 * inflates every downstream aggregate metric.
 */
export function readCritiqueSamples(paths) {
  const samples = [];
  const seenKeys = new Set();
  for (const path of paths) {
    for (const { lineNumber, text } of readJsonlLines(path)) {
      const parsed = parseHarvestedCritiqueTelemetrySample(text);
      if ('error' in parsed) {
        throw new Error(`${path}:${lineNumber}: ${parsed.error}`);
      }
      const key = sampleDedupKey(parsed.sample);
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);
      samples.push(parsed.sample);
    }
  }
  return samples;
}
// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------
/**
 * Aggregate harvested samples into a snapshot. Rates are `number | null`
 * (never `NaN`): `null` when their denominator is 0, distinguishable
 * from a genuine `0` observed rate.
 */
export function aggregateCritiqueSnapshot(samples, now) {
  let totalFindings = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let acceptedCount = 0;
  let rejectedCount = 0;
  let delegateUsageCount = 0;
  for (const sample of samples) {
    totalFindings += sample.findingsCount;
    high += sample.severityBreakdown.high;
    medium += sample.severityBreakdown.medium;
    low += sample.severityBreakdown.low;
    acceptedCount += sample.acceptedCount;
    rejectedCount += sample.rejectedCount;
    if (sample.delegateUsed) {
      delegateUsageCount += 1;
    }
  }
  const decidedCount = acceptedCount + rejectedCount;
  const acceptRate = decidedCount > 0 ? acceptedCount / decidedCount : null;
  const rejectRate = decidedCount > 0 ? rejectedCount / decidedCount : null;
  const delegateUsageRate =
    samples.length > 0 ? delegateUsageCount / samples.length : null;
  return {
    schemaVersion: 1,
    generatedOn: now.toISOString().slice(0, 10),
    sampleCount: samples.length,
    totalFindings,
    severityBreakdown: { high, medium, low },
    acceptedCount,
    rejectedCount,
    acceptRate,
    rejectRate,
    delegateUsageCount,
    delegateUsageRate,
    minPublishableSamples: MIN_PUBLISHABLE_SAMPLES,
    publishable: samples.length >= MIN_PUBLISHABLE_SAMPLES,
  };
}
// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function formatRate(rate) {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`;
}
/** Renders the `docs/critique-telemetry.md` embedded region's inner content. */
export function renderDocsTableRegion(snapshot) {
  if (!snapshot.publishable) {
    return `Not yet publishable, n=${snapshot.sampleCount}.`;
  }
  const lines = [
    '| Metric | Value |',
    '| --- | --- |',
    `| Total rounds | ${snapshot.sampleCount} |`,
    `| Total findings | ${snapshot.totalFindings} |`,
    `| Severity — high | ${snapshot.severityBreakdown.high} |`,
    `| Severity — medium | ${snapshot.severityBreakdown.medium} |`,
    `| Severity — low | ${snapshot.severityBreakdown.low} |`,
    `| Accepted | ${snapshot.acceptedCount} |`,
    `| Rejected | ${snapshot.rejectedCount} |`,
    `| Accept rate | ${formatRate(snapshot.acceptRate)} |`,
    `| Reject rate | ${formatRate(snapshot.rejectRate)} |`,
    `| Delegate usage rate | ${formatRate(snapshot.delegateUsageRate)} |`,
    '',
    `n=${snapshot.sampleCount}, as of ${snapshot.generatedOn}.`,
  ];
  return lines.join('\n');
}
/** Replace the text strictly between two marker lines, keeping the markers. Mirrors token-cost-report.mts's own generic marked-region replacer. */
export function replaceMarkedRegion(
  text,
  startMarker,
  endMarker,
  innerContent,
) {
  const startIndex = text.indexOf(startMarker);
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
function writeRenderedFile(docsPath, snapshot) {
  const docsPage = readFileSync(docsPath, 'utf8');
  writeFileSync(
    docsPath,
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
 * committed snapshot would render (empty when in sync). Mirrors
 * token-cost-report.mts's own checkRenderedFiles contract.
 */
export function checkRenderedFiles(snapshot, docsPath) {
  const drifted = [];
  const content = readFileSync(docsPath, 'utf8');
  let expected;
  try {
    expected = replaceMarkedRegion(
      content,
      DOCS_START,
      DOCS_END,
      renderDocsTableRegion(snapshot),
    );
  } catch (error) {
    return [`${docsPath}: ${error.message}`];
  }
  if (expected !== content) {
    drifted.push(
      `${docsPath}: marked region drifted from the committed snapshot`,
    );
  }
  return drifted;
}
const defaultBranchGuardDeps = {
  getCurrentBranch() {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  },
  getDefaultBranch() {
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
// CLI
// ---------------------------------------------------------------------------
// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const IDD_CRITIQUE_REPORT_FLAG_SPEC = {
  '--in': { type: 'string', multiple: true },
  '--snapshot': { type: 'string', default: DEFAULT_SNAPSHOT_PATH },
  '--docs': { type: 'string', default: DEFAULT_DOCS_PATH },
  '--apply': { type: 'boolean', default: false },
  '--check': { type: 'boolean', default: false },
  '--allow-default-branch': { type: 'boolean', default: false },
  '--now': { type: 'string', default: '' },
  '--help': { type: 'boolean', short: 'h' },
};
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/idd-critique-report.mjs --in <samples.jsonl> [--in <samples.jsonl> ...] [--snapshot <path>] [--docs <path>] --apply
  node scripts/idd-critique-report.mjs [--snapshot <path>] [--docs <path>] --check

  --in <path>        Harvested samples JSONL file (repeatable). Required
                      with --apply.
  --snapshot <path>   Snapshot artifact path (default: ${DEFAULT_SNAPSHOT_PATH}).
  --docs <path>       Reference doc whose marked region to refresh/check
                      (default: ${DEFAULT_DOCS_PATH}).
  --apply             Aggregate --in samples, write the snapshot, and
                      refresh the doc's marked region. Refused when the
                      current branch is the repository's default branch;
                      pass --allow-default-branch to proceed anyway.
  --allow-default-branch  Allow --apply to run while the current branch is
                          the repository's default branch.
  --check             Verify the committed snapshot's region has not
                      drifted from --docs. Exits non-zero on drift. Does
                      not read --in.
  --now <ISO8601>     Override the current time (tests only).
  --help, -h          Show this help.
`);
}
if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    IDD_CRITIQUE_REPORT_FLAG_SPEC,
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
  const docsPath = values.docs;
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
        `idd-critique-report --apply: refusing to run on the repository's default branch "${guard.defaultBranch}" (current branch: "${guard.currentBranch}"). Pass --allow-default-branch to override.\n`,
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
    const samples = readCritiqueSamples(inPaths);
    const snapshot = aggregateCritiqueSnapshot(samples, now);
    writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    writeRenderedFile(docsPath, snapshot);
    process.stdout.write(
      `idd-critique-report: wrote ${snapshotPath} (n=${snapshot.sampleCount}, publishable=${snapshot.publishable})\n`,
    );
  } else {
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    assertCritiqueTelemetrySnapshot(snapshot);
    const drifted = checkRenderedFiles(snapshot, docsPath);
    if (drifted.length > 0) {
      process.stderr.write(
        `idd-critique-report --check: drift found:\n${drifted.map((d) => `  - ${d}`).join('\n')}\n`,
      );
      process.exit(1);
    }
    process.stdout.write('idd-critique-report: no drift.\n');
  }
}
