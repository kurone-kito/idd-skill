// idd-generated-from: src/scripts/context-tax-core.mts
//
// The scripts/context-tax-core.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Shared context-tax measurement contracts (#2288). Source-repo only:
// not HELPER_COMMANDS, not idd-template/. Later adapter/harvest issues
// import this module. No CLI.

/** IDD stages a harvested sample may break usage into. */
export const CONTEXT_TAX_STAGE_IDS = [
  'discover',
  'claim',
  'work',
  'submit-pr',
  'review',
  'merge',
  'cleanup',
] as const;

export type ContextTaxStageId = (typeof CONTEXT_TAX_STAGE_IDS)[number];

export type ContextTaxVendor = 'grok' | 'claude' | 'codex';

export type ContextTaxKind = 'issue-loop' | 'session';

export type ContextTaxAttribution =
  | 'marker-join'
  | 'phase-event'
  | 'session-unscoped';

export type ContextTaxOutcome =
  | 'merged'
  | 'aborted'
  | 'unclaimed'
  | 'human-handoff'
  | 'unknown';

export type ContextTaxEffort = 'S' | 'M' | 'L';

/** Token usage. Every field is >= 0. */
export interface ContextTaxUsage {
  inputUncached: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
  reasoning: number;
}

export interface ContextTaxStageUsage {
  id: ContextTaxStageId;
  usage: ContextTaxUsage;
}

interface ContextTaxSampleBase {
  schemaVersion: 1;
  vendor: ContextTaxVendor;
  model: string;
  attribution: ContextTaxAttribution;
  outcome: ContextTaxOutcome;
  usage: ContextTaxUsage;
  compactionCount: number;
  startedAt: string;
  endedAt: string;
  vendorSessionId: string;
  claimId?: string | null;
  prNumber?: number | null;
  effort?: ContextTaxEffort | null;
  toolCallCount?: number | null;
  turnCount?: number | null;
  includesSubagents?: boolean;
  ambiguous?: boolean;
}

/** Per-issue harvested sample. issueNumber and stages are required. */
export interface ContextTaxIssueLoopSample extends ContextTaxSampleBase {
  kind: 'issue-loop';
  issueNumber: number;
  stages: readonly ContextTaxStageUsage[];
}

/** Unscoped session sample. Join fields stay optional. */
export interface ContextTaxSessionSample extends ContextTaxSampleBase {
  kind: 'session';
  issueNumber?: number;
  stages?: readonly ContextTaxStageUsage[];
}

/**
 * One harvested sample. Matches schemas/context-tax-sample.schema.json.
 * JSON Schema cannot express the issue-loop conditional without oneOf;
 * the TypeScript union and assertContextTaxSample enforce it.
 */
export type ContextTaxSample =
  | ContextTaxIssueLoopSample
  | ContextTaxSessionSample;

/** One explicit phase enter/exit line. */
export interface ContextTaxEvent {
  schemaVersion: 1;
  event: 'enter' | 'exit';
  stageId: ContextTaxStageId;
  at: string;
  vendor: ContextTaxVendor;
  vendorSessionId?: string | null;
  issueNumber?: number | null;
  usage?: ContextTaxUsage | null;
}

/** p25/p50/p75 for one measured quantity. */
export interface ContextTaxPercentiles {
  p25: number;
  p50: number;
  p75: number;
}

/** p25/p50/p75 for every {@link ContextTaxUsage} field. */
export interface ContextTaxUsagePercentiles {
  inputUncached: ContextTaxPercentiles;
  cacheRead: ContextTaxPercentiles;
  cacheCreation: ContextTaxPercentiles;
  output: ContextTaxPercentiles;
  reasoning: ContextTaxPercentiles;
}

export interface ContextTaxStageUsagePercentiles {
  id: ContextTaxStageId;
  usage: ContextTaxUsagePercentiles;
}

/** merged/(merged+aborted+unclaimed+humanHandoff), plus the raw counts. */
export interface ContextTaxSuccessRate {
  merged: number;
  aborted: number;
  unclaimed: number;
  humanHandoff: number;
  rate: number;
}

/** Committed aggregates a later reporter renders. */
export interface ContextTaxSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  minPublishableSamples: 10;
  minPublishableVendors: 2;
  publishable: boolean;
  sampleCount: number;
  vendors: readonly ContextTaxVendor[];
  /** UTC calendar date (`YYYY-MM-DD`) the rendered blurb should cite. */
  asOf: string;
  totalUsage: ContextTaxUsagePercentiles;
  stageUsage: readonly ContextTaxStageUsagePercentiles[];
  compactionCount: ContextTaxPercentiles;
  /** cacheRead / max(1, cacheRead + cacheCreation + inputUncached), in [0, 1]. */
  cacheHitRatio: number;
  successRateByModel: Readonly<Record<string, ContextTaxSuccessRate>>;
  successRateByVendor: Readonly<
    Partial<Record<ContextTaxVendor, ContextTaxSuccessRate>>
  >;
}

/**
 * Join hints an adapter may return. Only a numeric issue number is
 * allowed -- never a path or branch string.
 */
export interface ContextTaxJoinHints {
  issueNumber?: number;
}

export interface ContextTaxAdapterResult {
  sample: ContextTaxSample;
  joinHints?: ContextTaxJoinHints;
}

/** Vendor adapter. Later harvest issues implement this. */
export interface ContextTaxVendorAdapter {
  harvest(input: unknown): ContextTaxAdapterResult;
}

const DROPPED_KEYS = new Set([
  'prompt',
  'assistant',
  'messages',
  'content',
  'arguments',
  'toolarguments',
  'toolargs',
  'toolinput',
  'filecontents',
  'filecontent',
  'cwd',
  'path',
  'filepath',
  'pathname',
  'branch',
  'worktree',
  'logfile',
  'logpath',
  'home',
]);

/**
 * Boundary-agnostic path detection: the POSIX/drive/dot-relative branch
 * requires only that the match not be glued to an alphanumeric run (no
 * delimiter whitelist -- ":", ",", ";", etc. all work without enumerating
 * each one); the backslash-segment branch (single-leading-backslash
 * Windows-root-relative paths and UNC paths alike -- both are just
 * "backslash, segment, backslash, segment") and the `ghq/` branch have no
 * boundary requirement at all and match anywhere in the string.
 */
const PATH_LIKE =
  /(?<![A-Za-z0-9])(?:\/[^\s"'`]+|[A-Za-z]:[\\/][^\s"'`]*|[.~]\/[^\s"'`]*)|\\[^\s\\]+\\[^\s\\]*|ghq\//i;

const SECRET_LIKE =
  /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-|xox(?:b|a|p|r|s)-)[A-Za-z0-9_-]+/;

/**
 * Match by substring, not exact key, so compound vendor field names
 * (`systemPrompt`, `assistantMessage`, `toolInput`) are dropped without
 * enumerating every variant of each sensitive keyword.
 */
function isDroppedKey(key: string): boolean {
  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  for (const dropped of DROPPED_KEYS) {
    if (normalized.includes(dropped)) {
      return true;
    }
  }
  return false;
}

function redactString(value: string): string | undefined {
  if (PATH_LIKE.test(value) || SECRET_LIKE.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * Drop or replace privacy-sensitive fields from an untrusted harvested
 * record. Absolute paths, secret-shaped strings, and known
 * prompt/assistant/tool-argument key names (including recognizable
 * compound variants) do not survive -- as values or as object keys. This
 * is a defense-in-depth net for stray fields, not a substitute for an
 * adapter choosing what to extract:
 * `ContextTaxSample`/`ContextTaxEvent` have no field for raw conversational
 * text, so a correctly built adapter never passes a role/message/tool-call
 * container through here in the first place.
 */
export function redactContextTaxRecord(input: unknown): unknown {
  if (typeof input === 'string') {
    return redactString(input);
  }
  if (input === null || typeof input !== 'object') {
    return input;
  }
  if (Array.isArray(input)) {
    return input
      .map((item) => redactContextTaxRecord(item))
      .filter((item) => item !== undefined);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isDroppedKey(key) || redactString(key) === undefined) {
      continue;
    }
    const redacted = redactContextTaxRecord(value);
    if (redacted !== undefined) {
      out[key] = redacted;
    }
  }
  return out;
}

/**
 * Infer an issue number from a worktree or cwd *basename* only
 * (`issue-<n>-…` or `.issue-<n>-…`, including B1 `repo.issue-<n>-…`).
 * A value that still contains a path separator is treated as a path
 * and ignored.
 */
export function inferIssueNumberFromBasename(
  basename: string,
): number | undefined {
  if (basename.includes('/') || basename.includes('\\')) {
    return undefined;
  }
  const match = basename.match(/(?:^|\.)issue-(\d+)(?:-|$)/);
  if (!match) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export function isIssueLoopSample(
  sample: ContextTaxSample,
): sample is ContextTaxIssueLoopSample {
  return (
    sample.kind === 'issue-loop' &&
    typeof sample.issueNumber === 'number' &&
    Array.isArray(sample.stages)
  );
}

/**
 * Enforce cross-field constraints the JSON Schema cannot express:
 * `startedAt`/`endedAt` must both parse to a valid instant and `endedAt`
 * must not precede `startedAt` (any kind); the issue-loop join contract
 * without `oneOf` -- `issueNumber`/`stages` for `issue-loop`; and that
 * `attribution` agrees with `kind` (a `session-unscoped` sample was never
 * joined to an issue, so it cannot claim `issue-loop`, and vice versa).
 */
export function assertContextTaxSample(sample: ContextTaxSample): void {
  const startedAtMs = new Date(sample.startedAt).getTime();
  const endedAtMs = new Date(sample.endedAt).getTime();
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    throw new Error('sample startedAt/endedAt must be valid timestamps');
  }
  if (endedAtMs < startedAtMs) {
    throw new Error('sample endedAt must not precede startedAt');
  }
  if (sample.kind !== 'issue-loop') {
    if (sample.attribution !== 'session-unscoped') {
      throw new Error('session sample must use session-unscoped attribution');
    }
    return;
  }
  if (!Number.isInteger(sample.issueNumber) || sample.issueNumber <= 0) {
    throw new Error('issue-loop sample requires a positive issueNumber');
  }
  if (!Array.isArray(sample.stages)) {
    throw new Error('issue-loop sample requires stages');
  }
  if (sample.attribution === 'session-unscoped') {
    throw new Error(
      'issue-loop sample cannot use session-unscoped attribution',
    );
  }
}

function assertPercentileOrder(label: string, p: ContextTaxPercentiles): void {
  if (!(p.p25 <= p.p50 && p.p50 <= p.p75)) {
    throw new Error(
      `snapshot ${label} percentiles must satisfy p25 <= p50 <= p75`,
    );
  }
}

function assertUsagePercentileOrder(
  label: string,
  usage: ContextTaxUsagePercentiles,
): void {
  for (const field of [
    'inputUncached',
    'cacheRead',
    'cacheCreation',
    'output',
    'reasoning',
  ] as const) {
    assertPercentileOrder(`${label}.${field}`, usage[field]);
  }
}

function assertRateInUnitInterval(
  label: string,
  rate: ContextTaxSuccessRate,
): void {
  if (!(rate.rate >= 0 && rate.rate <= 1)) {
    throw new Error(`snapshot ${label} rate must be in [0, 1]`);
  }
  const denom = rate.merged + rate.aborted + rate.unclaimed + rate.humanHandoff;
  const expected = denom === 0 ? 0 : rate.merged / denom;
  if (Math.abs(rate.rate - expected) > 1e-9) {
    throw new Error(
      `snapshot ${label} rate must equal merged / (merged + aborted + unclaimed + humanHandoff)`,
    );
  }
}

function assertUtcCalendarDate(value: string): void {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error('snapshot asOf must be a valid UTC calendar date');
  }
}

/**
 * Enforce the constraints the JSON Schema cannot express: distinct
 * `vendors` (`uniqueItems` is outside `validate-schemas.mts`'s enforced
 * keyword subset), that `publishable` agrees with the
 * `sampleCount`/`vendors` gate the schema documents but cannot compare
 * across fields on its own, that `asOf` is a real UTC calendar date (the
 * schema's `pattern` accepts a shape like `2026-02-30`), that every
 * percentile triple is ordered (the schema has no `maximum`/cross-field
 * comparison keyword), that `stageUsage` has at most one entry per stage
 * id, that `cacheHitRatio` and every success rate fall in `[0, 1]`, that
 * each success rate's `rate` field agrees with its own raw counts, and
 * that `successRateByVendor` names only vendors present in `vendors`.
 */
export function assertContextTaxSnapshot(snapshot: ContextTaxSnapshot): void {
  if (new Set(snapshot.vendors).size !== snapshot.vendors.length) {
    throw new Error('snapshot vendors must be distinct');
  }
  const eligible =
    snapshot.sampleCount >= snapshot.minPublishableSamples &&
    snapshot.vendors.length >= snapshot.minPublishableVendors;
  if (snapshot.publishable !== eligible) {
    throw new Error(
      'snapshot publishable must match the sampleCount/vendors gate',
    );
  }
  assertUtcCalendarDate(snapshot.asOf);
  assertUsagePercentileOrder('totalUsage', snapshot.totalUsage);
  const seenStageIds = new Set<string>();
  for (const stage of snapshot.stageUsage) {
    if (seenStageIds.has(stage.id)) {
      throw new Error(
        `snapshot stageUsage has a duplicate entry for "${stage.id}"`,
      );
    }
    seenStageIds.add(stage.id);
    assertUsagePercentileOrder(`stageUsage[${stage.id}].usage`, stage.usage);
  }
  assertPercentileOrder('compactionCount', snapshot.compactionCount);
  if (!(snapshot.cacheHitRatio >= 0 && snapshot.cacheHitRatio <= 1)) {
    throw new Error('snapshot cacheHitRatio must be in [0, 1]');
  }
  for (const [model, rate] of Object.entries(snapshot.successRateByModel)) {
    assertRateInUnitInterval(`successRateByModel[${model}]`, rate);
  }
  const vendorSet = new Set(snapshot.vendors);
  for (const [vendor, rate] of Object.entries(snapshot.successRateByVendor)) {
    if (rate === undefined) {
      continue;
    }
    if (!vendorSet.has(vendor as ContextTaxVendor)) {
      throw new Error(
        `snapshot successRateByVendor names "${vendor}", which is not present in vendors`,
      );
    }
    assertRateInUnitInterval(`successRateByVendor[${vendor}]`, rate);
  }
}
