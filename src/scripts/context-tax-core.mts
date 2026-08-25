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

/** One harvested sample. Matches schemas/context-tax-sample.schema.json. */
export interface ContextTaxSample {
  schemaVersion: 1;
  kind: ContextTaxKind;
  vendor: ContextTaxVendor;
  model: string;
  attribution: ContextTaxAttribution;
  outcome: ContextTaxOutcome;
  usage: ContextTaxUsage;
  compactionCount: number;
  startedAt: string;
  endedAt: string;
  vendorSessionId: string;
  issueNumber?: number;
  stages?: readonly ContextTaxStageUsage[];
  claimId?: string | null;
  prNumber?: number | null;
  effort?: ContextTaxEffort | null;
  toolCallCount?: number | null;
  turnCount?: number | null;
  includesSubagents?: boolean;
  ambiguous?: boolean;
}

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

const PATH_LIKE =
  /(?:^|[\s"'`=(])(?:\/(?:home|Users|tmp|var|opt|usr)\/|\w:\\|\\\\|[.~]\/|ghq\/|issue\/\d+-|\.issue-\d+-)/i;

const SECRET_LIKE =
  /\b(?:ghp_|gho_|ghs_|ghu_|github_pat_|sk-|xox(?:b|a|p|r|s)-)[A-Za-z0-9_-]+/;

function isDroppedKey(key: string): boolean {
  return DROPPED_KEYS.has(key.replace(/[_-]/g, '').toLowerCase());
}

function redactString(value: string): string | undefined {
  if (PATH_LIKE.test(value) || SECRET_LIKE.test(value)) {
    return undefined;
  }
  return value;
}

/**
 * Drop or replace privacy-sensitive fields from an untrusted harvested
 * record. Absolute paths, prompt/assistant/tool-argument text, file
 * contents, and secret-shaped strings do not survive.
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
 * (`issue/<n>-…` or `.issue-<n>-…`). A value that still contains a
 * path separator is treated as a path and ignored.
 */
export function inferIssueNumberFromBasename(
  basename: string,
): number | undefined {
  if (basename.includes('/') || basename.includes('\\')) {
    return undefined;
  }
  const match = basename.match(/issue[/.-](\d+)/);
  if (!match) {
    return undefined;
  }
  const n = Number(match[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
