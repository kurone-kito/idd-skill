#!/usr/bin/env node
// idd-generated-from: src/scripts/stalled-session-quiet-check.mts
//
// The scripts/stalled-session-quiet-check.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ghText, isCliExecution } from './gh-exec.mts';

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
  token: string;
  now: string;
  quietWindowMs: number;
  claimCreatedAt: string;
  policy: string;
  help: boolean;
}

if (isCliExecution(import.meta.url)) {
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
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner =
    args.owner ||
    ghText(['repo', 'view', '--json', 'owner', '--jq', '.owner.login']);
  const repo =
    args.repo || ghText(['repo', 'view', '--json', 'name', '--jq', '.name']);
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
  const prComments = ghJson([
    'api',
    `repos/${repository}/issues/${pr}/comments`,
    '--paginate',
    '--jq',
    '[.[] | {timestamp: .created_at}]',
  ]) as { timestamp?: unknown }[];
  for (const c of prComments) {
    activities.push({ type: 'comment', timestamp: c.timestamp });
  }

  // Paginate PR reviews
  const reviews = ghJson([
    'api',
    `repos/${repository}/pulls/${pr}/reviews`,
    '--paginate',
    '--jq',
    '[.[] | {timestamp: .submitted_at}]',
  ]) as { timestamp?: unknown }[];
  for (const r of reviews) {
    activities.push({ type: 'review', timestamp: r.timestamp });
  }

  // Paginate PR review comments
  const reviewComments = ghJson([
    'api',
    `repos/${repository}/pulls/${pr}/comments`,
    '--paginate',
    '--jq',
    '[.[] | {timestamp: .created_at}]',
  ]) as { timestamp?: unknown }[];
  for (const rc of reviewComments) {
    activities.push({ type: 'comment', timestamp: rc.timestamp });
  }

  if (headSha) {
    // Paginate check-runs for CI activity
    const checkRuns = ghJson([
      'api',
      `repos/${repository}/commits/${headSha}/check-runs`,
      '--paginate',
      '--jq',
      '[.check_runs[] | {status: .status, started_at: .started_at, completed_at: .completed_at}]',
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

function parseArgs(argv: string[]): QuietArgs {
  const parsed: QuietArgs = {
    pr: null,
    owner: '',
    repo: '',
    token: '',
    now: '',
    quietWindowMs: 0,
    claimCreatedAt: '',
    policy: '',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const requireValue = (): string => {
      if (value === undefined || String(value).startsWith('--')) {
        throw new Error(`missing value for argument: ${flag}`);
      }
      return value;
    };
    if (flag === '--pr') {
      parsed.pr = Number.parseInt(String(requireValue()), 10);
      i += 1;
      continue;
    }
    if (flag === '--owner') {
      parsed.owner = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--repo') {
      parsed.repo = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--token') {
      parsed.token = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--now') {
      parsed.now = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--quiet-window-ms') {
      parsed.quietWindowMs = Number.parseInt(String(requireValue()), 10);
      i += 1;
      continue;
    }
    if (flag === '--claim-created-at') {
      parsed.claimCreatedAt = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--policy') {
      parsed.policy = requireValue();
      i += 1;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/stalled-session-quiet-check.mjs --pr <number> [--owner <owner>] [--repo <repo>]
    [--token <token>] [--now <ISO8601>] [--quiet-window-ms <ms>]
    [--claim-created-at <ISO8601>] [--policy <path>]

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

function runGh(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown })?.stderr ?? '').trim();
    if (stderr) throw new Error(`gh command failed: ${stderr}`);
    throw error;
  }
}
