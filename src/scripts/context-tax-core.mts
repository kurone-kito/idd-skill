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

/** Committed aggregates a later reporter renders. */
export interface ContextTaxSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  minPublishableSamples: 10;
  minPublishableVendors: 2;
  publishable: boolean;
  sampleCount: number;
  vendors: readonly ContextTaxVendor[];
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
 * compound variants) do not survive. This is a defense-in-depth net for
 * stray fields, not a substitute for an adapter choosing what to extract:
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
    if (isDroppedKey(key)) {
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
 * Enforce the issue-loop join contract the JSON Schema cannot express
 * without oneOf: `issueNumber`/`stages` for `issue-loop`, and that
 * `attribution` agrees with `kind` (a `session-unscoped` sample was never
 * joined to an issue, so it cannot claim `issue-loop`, and vice versa).
 */
export function assertContextTaxSample(sample: ContextTaxSample): void {
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

/**
 * Enforce the constraints the JSON Schema cannot express: distinct
 * `vendors` (`uniqueItems` is outside `validate-schemas.mts`'s enforced
 * keyword subset), and that `publishable` agrees with the
 * `sampleCount`/`vendors` gate the schema documents but cannot compare
 * across fields on its own.
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
}
