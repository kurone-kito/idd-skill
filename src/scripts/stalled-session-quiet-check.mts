#!/usr/bin/env node
// idd-generated-from: src/scripts/stalled-session-quiet-check.mts
//
// The scripts/stalled-session-quiet-check.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseCliArgs } from './cli-args.mts';
import {
  DEFAULT_GH_PAGINATED_TIMEOUT_MS,
  GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  ghText,
} from './gh-exec.mts';
import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

const DEFAULT_QUIET_WINDOW_MS = 30 * 60 * 1000;

interface Activity {
  type: string;
  timestamp: string | null;
}

interface RawActivity {
  type: string;
  timestamp: unknown;
}

interface QuietWindowResult {
  quiet_window_met: boolean;
  quiet_window_ms: number;
  window_start: string;
  now: string;
  latest_activity: string | null;
  latest_activity_type: string | null;
  reason: string;
  evidence: {
    activity_count_in_window: number;
    blocking_activities: Activity[];
    has_heartbeat_in_window: boolean;
    has_ci_running: boolean;
    has_branch_tip_movement: boolean;
  };
}

/**
 * JSON state document printed by this CLI: repository / PR / policy
 * context plus the quiet-window evaluation result
 * (schemas/stalled-session-quiet-check.schema.json).
 */
export interface StalledSessionQuietCheckReport extends QuietWindowResult {
  repository: { owner: string; repo: string };
  pr: { number: number; title: string; head_sha: string; html_url: string };
  policy: { quiet_window_ms: number; claim_created_at: string | null };
}

interface QuietArgs {
  pr: number | null;
  owner: string;
  repo: string;
  ghToken: string;
  now: string;
  quietWindowMs: number;
  claimCreatedAt: string;
  policy: string;
  help: boolean;
}

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `pr:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --pr spec key
// below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const STALLED_SESSION_QUIET_CHECK_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string' },
  '--repo': { type: 'string' },
  '--gh-token': { type: 'string' },
  '--token': { type: 'string' },
  '--now': { type: 'string' },
  '--quiet-window-ms': { type: 'string' },
  '--claim-created-at': { type: 'string' },
  '--policy': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

/**
 * Evaluate whether a quiet window has been met for stalled-session detection.
 *
 * A quiet window is met when no externally observable progress appears
 * in the window `[now - quietWindowMs, now]`. Activities of type
 * `ci-running` represent currently-running CI and always break the window
 * regardless of timestamp.
 */
export function evaluateQuietWindow(input: unknown): QuietWindowResult {
  const inp = input as
    | { now?: unknown; quietWindowMs?: unknown; activities?: unknown }
    | null
    | undefined;
  const now = normalizeIso(inp?.now);
  if (!now) {
    throw new TypeError('input.now must be a valid ISO8601 timestamp');
  }

  const quietWindowMs = resolveQuietWindowMs(inp?.quietWindowMs);
  const windowStart = new Date(Date.parse(now) - quietWindowMs)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const activities = normalizeActivities(inp?.activities);

  const blocking: Activity[] = [];
  for (const activity of activities) {
    if (activity.type === 'ci-running') {
      blocking.push(activity);
      continue;
    }
    if (
      activity.timestamp &&
      compareIso(activity.timestamp, windowStart) >= 0
    ) {
      blocking.push(activity);
    }
  }

  const latestBlocking =
    blocking.length > 0
      ? blocking.reduce<Activity | null>((latest, act) => {
          if (!latest) return act;
          if (act.type === 'ci-running' && latest.type !== 'ci-running')
            return act;
          if (latest.type === 'ci-running' && act.type !== 'ci-running')
            return latest;
          return compareIso(act.timestamp, latest.timestamp) > 0 ? act : latest;
        }, null)
      : null;

  const quietWindowMet = blocking.length === 0;

  const reason = quietWindowMet
    ? 'no-activity-in-window'
    : buildReason(blocking);

  return {
    quiet_window_met: quietWindowMet,
    quiet_window_ms: quietWindowMs,
    window_start: windowStart,
    now,
    latest_activity: latestBlocking?.timestamp ?? null,
    latest_activity_type: latestBlocking?.type ?? null,
    reason,
    evidence: {
      activity_count_in_window: blocking.length,
      blocking_activities: blocking,
      has_heartbeat_in_window: blocking.some((a) => a.type === 'heartbeat'),
      has_ci_running: blocking.some((a) => a.type === 'ci-running'),
      has_branch_tip_movement: blocking.some(
        (a) => a.type === 'branch-tip-movement',
      ),
    },
  };
}

function buildReason(blocking: Activity[]): string {
  const types = [...new Set(blocking.map((a) => a.type))];
  return `activity-in-window: ${types.join(', ')}`;
}

function resolveQuietWindowMs(value: unknown): number {
  if (value === null || value === undefined) {
    return DEFAULT_QUIET_WINDOW_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_QUIET_WINDOW_MS;
  }
  return Math.floor(parsed);
}

function normalizeActivities(raw: unknown): Activity[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as unknown[])
    .map((item) => ({
      type: String((item as { type?: unknown })?.type ?? ''),
      timestamp: normalizeIso((item as { timestamp?: unknown })?.timestamp),
    }))
    .filter((item) => {
      if (!item.type) return false;
      if (item.type === 'ci-running') return true;
      return item.timestamp !== null;
    });
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.pr === null || !Number.isInteger(args.pr) || args.pr <= 0) {
    throw new Error('--pr is required and must be a positive integer');
  }
  if (args.ghToken) {
    process.env.GH_TOKEN = args.ghToken;
    process.env.GITHUB_TOKEN = args.ghToken;
  }

  const owner =
    args.owner ||
    ghText(
      ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repo =
    args.repo ||
    ghText(
      ['repo', 'view', '--json', 'name', '--jq', '.name'],
      GH_TEXT_LOOP_TIMEOUT_OPTIONS,
    );
  const repository = `${owner}/${repo}`;
  const now = args.now || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const quietWindowMs =
    args.quietWindowMs > 0
      ? args.quietWindowMs
      : resolveWindowFromPolicy(args.policy);
  const claimCreatedAt = args.claimCreatedAt || null;

  const activities = collectActivities({
    repository,
    pr: args.pr,
    now,
    claimCreatedAt,
  });

  const input = { now, quietWindowMs, activities };
  const result = evaluateQuietWindow(input);

  const pr = ghJson([
    'api',
    `repos/${repository}/pulls/${args.pr}`,
    '--jq',
    '{number: .number, title: .title, head_sha: .head.sha, html_url: .html_url}',
  ]) as {
    number?: unknown;
    title?: unknown;
    head_sha?: unknown;
    html_url?: unknown;
  };

  const output: StalledSessionQuietCheckReport = {
    repository: { owner, repo },
    pr: {
      number: Number(pr.number),
      title: String(pr.title ?? ''),
      head_sha: String(pr.head_sha ?? ''),
      html_url: String(pr.html_url ?? ''),
    },
    policy: {
      quiet_window_ms: quietWindowMs,
      claim_created_at: claimCreatedAt,
    },
    ...result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function collectActivities({
  repository,
  pr,
  now,
  claimCreatedAt,
}: {
  repository: string;
  pr: number;
  now: string;
  claimCreatedAt: string | null;
}): RawActivity[] {
  const activities: RawActivity[] = [];

  const prData = ghJson([
    'api',
    `repos/${repository}/pulls/${pr}`,
    '--jq',
    '{head_sha: .head.sha, merged_at: .merged_at}',
  ]) as { head_sha?: unknown; merged_at?: unknown };

  const headSha = prData.head_sha;
  if (headSha) {
    // Fetch head commit timestamp for branch-tip-movement. Prefer the
    // committer date over the author date: the committer date is refreshed
    // whenever the commit is (re)created — including rebase, cherry-pick,
    // and amend — so it tracks when the commit was last placed on the
    // branch, whereas the author date preserves the original authorship
    // time and can be arbitrarily old. A recent push of an older-authored
    // commit would otherwise look stale and falsely satisfy the quiet
    // window. (Both are Git commit-object fields, not server timestamps.)
    const headCommit = ghJson([
      'api',
      `repos/${repository}/commits/${headSha}`,
      '--jq',
      '{commit_timestamp: .commit.committer.date}',
    ]) as { commit_timestamp?: unknown };
    if (headCommit.commit_timestamp) {
      activities.push({
        type: 'branch-tip-movement',
        timestamp: headCommit.commit_timestamp,
      });
    }
  }

  // Paginate issue comments (includes PR comments)
  const prComments = ghPaginatedJson([
    'api',
    `repos/${repository}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    '.[] | {timestamp: .created_at}',
  ]) as { timestamp?: unknown }[];
  for (const c of prComments) {
    activities.push({ type: 'comment', timestamp: c.timestamp });
  }

  // Paginate PR reviews
  const reviews = ghPaginatedJson([
    'api',
    `repos/${repository}/pulls/${pr}/reviews`,
    '--paginate',
    '--jq',
    '.[] | {timestamp: .submitted_at}',
  ]) as { timestamp?: unknown }[];
  for (const r of reviews) {
    activities.push({ type: 'review', timestamp: r.timestamp });
  }

  // Paginate PR review comments
  const reviewComments = ghPaginatedJson([
    'api',
    `repos/${repository}/pulls/${pr}/comments`,
    '--paginate',
    '--jq',
    '.[] | {timestamp: .created_at}',
  ]) as { timestamp?: unknown }[];
  for (const rc of reviewComments) {
    activities.push({ type: 'comment', timestamp: rc.timestamp });
  }

  if (headSha) {
    // Paginate check-runs for CI activity
    const checkRuns = ghPaginatedJson([
      'api',
      `repos/${repository}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '.check_runs[] | {status: .status, started_at: .started_at, completed_at: .completed_at}',
    ]) as { status?: unknown; completed_at?: unknown }[];
    for (const run of checkRuns) {
      if (run.status === 'queued' || run.status === 'in_progress') {
        activities.push({ type: 'ci-running', timestamp: now });
      } else if (run.completed_at) {
        activities.push({ type: 'ci-completed', timestamp: run.completed_at });
      }
    }
  }

  if (claimCreatedAt) {
    activities.push({ type: 'heartbeat', timestamp: claimCreatedAt });
  }

  return activities;
}

function resolveWindowFromPolicy(policyPath: string): number {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), '.github/idd/config.json');
  try {
    const config = JSON.parse(readFileSync(source, 'utf8')) as {
      stallRecovery?: { quietWindow?: unknown };
    };
    return (
      parseDurationToMs(config?.stallRecovery?.quietWindow) ??
      DEFAULT_QUIET_WINDOW_MS
    );
  } catch {
    return DEFAULT_QUIET_WINDOW_MS;
  }
}

function parseDurationToMs(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    text,
  );
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? '0', 10);
  const hours = Number.parseInt(match[2] ?? '0', 10);
  const minutes = Number.parseInt(match[3] ?? '0', 10);
  const seconds = Number.parseInt(match[4] ?? '0', 10);
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function warnDeprecatedFlag(deprecated: string, canonical: string): void {
  process.stderr.write(
    `warning: ${deprecated} is deprecated; use ${canonical} instead.\n`,
  );
}

/**
 * Find `flag`'s last occurrence in `argv`, recognizing both the
 * two-token form (`--flag value`) and the single-token `--flag=value`
 * form `parseCliArgs` also accepts.
 */
function findLastFlagOccurrenceIndex(
  argv: readonly string[],
  flag: string,
): number {
  const equalsPrefix = `${flag}=`;
  for (let index = argv.length - 1; index >= 0; index -= 1) {
    if (argv[index] === flag || argv[index].startsWith(equalsPrefix)) {
      return index;
    }
  }
  return -1;
}

/**
 * Resolve a canonical/deprecated flag pair: whichever flag's LAST
 * occurrence comes later in argv wins when both spellings are given
 * together (matches `pre-merge-readiness.mts`'s `--claim-id` /
 * `--expected-claim-id` precedent). `-1` (never given) sorts before any
 * real index, so an absent flag never wins against one that was
 * actually passed.
 */
function resolveLastGivenAlias(
  argv: readonly string[],
  canonicalFlag: string,
  canonicalValue: string | undefined,
  deprecatedFlag: string,
  deprecatedValue: string | undefined,
): string | undefined {
  if (canonicalValue === undefined) {
    return deprecatedValue;
  }
  if (deprecatedValue === undefined) {
    return canonicalValue;
  }
  const lastCanonicalIndex = findLastFlagOccurrenceIndex(argv, canonicalFlag);
  const lastDeprecatedIndex = findLastFlagOccurrenceIndex(argv, deprecatedFlag);
  return lastDeprecatedIndex > lastCanonicalIndex
    ? deprecatedValue
    : canonicalValue;
}

function parseArgs(argv: string[]): QuietArgs {
  const { values, help } = parseCliArgs(
    argv,
    STALLED_SESSION_QUIET_CHECK_FLAG_SPEC,
  );
  const prToken = values.pr as string | undefined;
  const quietWindowMsToken = values['quiet-window-ms'] as string | undefined;
  const ghToken = resolveLastGivenAlias(
    argv,
    '--gh-token',
    values['gh-token'] as string | undefined,
    '--token',
    values.token as string | undefined,
  );
  const deprecatedTokenValue = values.token as string | undefined;
  if (deprecatedTokenValue !== undefined) {
    warnDeprecatedFlag('--token', '--gh-token');
  }
  return {
    // Both --pr and --quiet-window-ms are kept as lenient Number.parseInt
    // (not the canonical-integer helper), matching the pre-migration
    // contract exactly: --pr is re-validated by this file's own
    // "!Number.isInteger(args.pr) || args.pr <= 0" post-check (in runCli,
    // unchanged), and --quiet-window-ms already flows through
    // resolveQuietWindowMs()'s own fail-safe (falls back to
    // DEFAULT_QUIET_WINDOW_MS on any non-finite / non-positive value) --
    // tightening either at this layer would be an untested, out-of-scope
    // behavior change for this behavior-preserving migration (see #1451).
    pr: prToken === undefined ? null : Number.parseInt(prToken, 10),
    owner: (values.owner as string | undefined) ?? '',
    repo: (values.repo as string | undefined) ?? '',
    ghToken: ghToken ?? '',
    now: (values.now as string | undefined) ?? '',
    quietWindowMs:
      quietWindowMsToken === undefined
        ? 0
        : Number.parseInt(quietWindowMsToken, 10),
    claimCreatedAt: (values['claim-created-at'] as string | undefined) ?? '',
    policy: (values.policy as string | undefined) ?? '',
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/stalled-session-quiet-check.mjs --pr <number> [--owner <owner>] [--repo <repo>]
    [--gh-token <token>] [--now <ISO8601>] [--quiet-window-ms <ms>]
    [--claim-created-at <ISO8601>] [--policy <path>]
  Deprecated aliases (one release): --token -> --gh-token

Evaluates the S2 quiet-window check for stalled-session detection.
Outputs JSON with quiet_window_met and evidence fields.
`);
}

function normalizeIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function compareIso(left: unknown, right: unknown): number {
  const leftTime = Date.parse(String(left ?? ''));
  const rightTime = Date.parse(String(right ?? ''));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  return leftTime - rightTime;
}

function ghJson(args: string[]): unknown {
  return JSON.parse(runGh(args).trim() || 'null') ?? [];
}

/**
 * Run a `gh api ... --paginate --jq <program>` call and parse its output as
 * NDJSON (#1692). `<program>` must stream individual values per page (e.g.
 * `.[] | {...}` or `.check_runs[] | {...}`), not wrap them back into a
 * per-page array (`[.[] | {...}]`) -- the latter made `gh --paginate` emit
 * one JSON array per page, which this file's prior single whole-stdout
 * `JSON.parse` (via `ghJson`) could not parse once there was more than one
 * page. Matches the shared NDJSON convention `gh-exec.mts`'s `ghApiJson`
 * already uses.
 *
 * Requires `args` to already include `--paginate` and `--jq` (Copilot
 * review on PR #1763): a call site missing either flag would still parse
 * without error -- `--jq`-less output as a single JSON.parse of one big
 * value, or non-paginated output as a trivially "one item" NDJSON stream --
 * silently returning only a first page or a wrong shape instead of failing
 * loudly. Every current call site already passes both; this only guards
 * against a future call site accidentally dropping one.
 */
function ghPaginatedJson(args: string[]): unknown[] {
  if (!args.includes('--paginate') || !args.includes('--jq')) {
    throw new Error(
      `ghPaginatedJson requires both --paginate and --jq in args, got: ${args.join(' ')}`,
    );
  }
  return parsePaginatedGhNdjson(runGh(args));
}

function runGh(args: string[]): string {
  try {
    return ghText(args, {
      ...GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      ...(args.includes('--paginate')
        ? { timeout: DEFAULT_GH_PAGINATED_TIMEOUT_MS }
        : {}),
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
    if (stderr) throw new Error(`gh command failed: ${stderr}`);
    throw error;
  }
}
