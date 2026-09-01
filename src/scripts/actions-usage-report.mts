#!/usr/bin/env node

// idd-generated-from: src/scripts/actions-usage-report.mts
//
// The scripts/actions-usage-report.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Dogfood-only measurement tool (#2322): for a given pull request, reports
// per-workflow run counts and per-job durations attributable to it, from
// the Actions API. Maintainer/CI-only -- never distributed to
// idd-template/ and never registered in HELPER_COMMANDS (see
// SOURCE_REPO_INTERNAL_ENTRY_PATHS in
// tests/helper-invocation-profile.test.mts), matching context-tax-report.mts's
// precedent: an adopter repository has its own, entirely different set of
// CI workflows, so a report scoped to this repository's own workflow names
// has nothing to measure there.
//
// This is evidence-gathering only: it never mutates GitHub state, and its
// output informs manual review of .github/workflows/*.yml, not an
// automated gate.

import { parseCliArgs } from './cli-args.mts';
import { GH_TEXT_LOOP_TIMEOUT_OPTIONS, ghText } from './gh-exec.mts';
import { parsePaginatedGhNdjson } from './protocol-helpers.mts';

// ---------------------------------------------------------------------------
// Aggregation (pure -- offline fixture-testable, no network)
// ---------------------------------------------------------------------------

/** One workflow run, reduced to the fields aggregation needs. */
export interface UsageRun {
  id: number;
  workflowName: string;
  event: string;
}

/** One job's timing, tagged with the run it belongs to. `completedAt` is
 * `null` for a job that has not finished yet (e.g. still `in_progress`);
 * such jobs are excluded from the duration total rather than treated as
 * zero-length. */
export interface UsageJob {
  runId: number;
  jobName: string;
  startedAt: string;
  completedAt: string | null;
}

/** Per-workflow aggregate: run count (including runs with no completed
 * job yet), completed-job count, summed job duration (aggregate runner
 * time -- each job's own elapsed span summed together, **not** wall-clock:
 * parallel or overlapping jobs, such as a matrix strategy, each count in
 * full even though they ran concurrently), summed billed minutes (each
 * job rounded up to the whole minute before summing -- GitHub's actual
 * billing unit), and a run-count breakdown by triggering event
 * (`pull_request`, `pull_request_review`, `pull_request_review_comment`,
 * ...). */
export interface WorkflowUsageRow {
  workflowName: string;
  runCount: number;
  jobCount: number;
  totalDurationMs: number;
  totalBilledMinutes: number;
  byEvent: Record<string, number>;
}

/** Full report: totals plus one {@link WorkflowUsageRow} per distinct
 * workflow name, sorted by `totalBilledMinutes` descending (the actual
 * billed-cost driver -- see {@link WorkflowUsageRow}), tie-broken by
 * workflow name ascending for a stable order. */
export interface ActionsUsageReport {
  runCount: number;
  jobCount: number;
  totalDurationMs: number;
  totalBilledMinutes: number;
  workflows: WorkflowUsageRow[];
}

interface WorkflowBucket {
  runIds: Set<number>;
  byEvent: Map<string, Set<number>>;
  jobCount: number;
  totalDurationMs: number;
  totalBilledMinutes: number;
}

/** Ceils a job's elapsed milliseconds to whole billed minutes, per GitHub's
 * actual billing unit -- a job that ran for any positive duration still
 * bills at least one minute (a batch of short jobs is not free just
 * because none individually reached 60s). */
export function billedMinutesFor(durationMs: number): number {
  return Math.max(1, Math.ceil(durationMs / 60_000));
}

/**
 * A branch-name filter alone can also match a run that is not actually
 * `prNumber`'s own (a reused branch name, or a `workflow_dispatch` /
 * `push` run against the same branch outside this PR). `pullRequests` is a
 * run's own `pull_requests[].number` list from the Actions API --
 * populated by GitHub for same-repository runs, but always empty for a
 * fork-originated PR's runs (GitHub does not associate those, so the
 * branch filter is already the best available signal there). A run
 * belongs when its `pull_requests` list is empty (fork case, or
 * genuinely untracked) or includes `prNumber`; a non-empty list that
 * omits `prNumber` means the run belongs to a different pull request.
 *
 * Empty `pull_requests` also covers a same-repository `push` /
 * `workflow_dispatch` run against the same branch that is not part of
 * any pull request -- GitHub never populates that field for those event
 * types either, not only for forks. {@link isPrFamilyEvent} closes that
 * gap: callers apply it first so a non-PR-triggered run is excluded on
 * its event type before this empty-list allowance can apply to it.
 *
 * Known limitation, not closed by either check above: two different
 * fork-originated PRs sharing an identical head branch name would both
 * report an empty `pull_requests` list and both pass this function,
 * merging their runs together. Disambiguating that case needs each
 * run's `head_repository` compared against the target PR's own head
 * repository -- out of scope for this maintainer-only, single-repository
 * dogfood tool, whose only real callers are this repository's own
 * same-repository `issue/<number>-*` branches, never forks.
 */
export function runBelongsToPr(
  pullRequests: readonly number[],
  prNumber: number,
): boolean {
  return pullRequests.length === 0 || pullRequests.includes(prNumber);
}

/** Triggering events that can only fire in the context of a pull request.
 * A `push` or `workflow_dispatch` run sharing the PR's branch name is
 * never one of these, regardless of its `pull_requests` association. */
export const PR_FAMILY_EVENTS: ReadonlySet<string> = new Set([
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
]);

/** Whether `event` is one of {@link PR_FAMILY_EVENTS}. */
export function isPrFamilyEvent(event: string): boolean {
  return PR_FAMILY_EVENTS.has(event);
}

/**
 * Aggregate already-fetched runs and jobs into an {@link ActionsUsageReport}.
 * Pure and offline: takes plain data, never calls `gh` itself -- the network
 * fetch lives in {@link fetchActionsUsageForPr} below, so this function is
 * the one covered by an offline fixture test (#2322's acceptance criterion).
 *
 * A job whose `runId` matches no entry in `runs`, or whose `completedAt` is
 * `null`, is skipped: the former can only happen from mismatched fixture
 * data (never from a real fetch, which always tags a job with the run that
 * produced it), and the latter is a run still in flight, whose eventual
 * duration is unknown, not zero.
 */
export function aggregateActionsUsage(
  runs: readonly UsageRun[],
  jobs: readonly UsageJob[],
): ActionsUsageReport {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const buckets = new Map<string, WorkflowBucket>();
  for (const run of runs) {
    const bucket = buckets.get(run.workflowName) ?? {
      runIds: new Set(),
      byEvent: new Map(),
      jobCount: 0,
      totalDurationMs: 0,
      totalBilledMinutes: 0,
    };
    bucket.runIds.add(run.id);
    const eventRunIds = bucket.byEvent.get(run.event) ?? new Set();
    eventRunIds.add(run.id);
    bucket.byEvent.set(run.event, eventRunIds);
    buckets.set(run.workflowName, bucket);
  }
  for (const job of jobs) {
    if (job.completedAt == null) {
      continue;
    }
    const run = runById.get(job.runId);
    if (!run) {
      continue;
    }
    const durationMs = Date.parse(job.completedAt) - Date.parse(job.startedAt);
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      continue;
    }
    // run.workflowName was just used to seed `buckets` in the loop above,
    // from the same `runs` array, so this lookup always hits.
    const bucket = buckets.get(run.workflowName);
    if (!bucket) {
      continue;
    }
    bucket.jobCount += 1;
    bucket.totalDurationMs += durationMs;
    bucket.totalBilledMinutes += billedMinutesFor(durationMs);
  }
  const workflows: WorkflowUsageRow[] = [...buckets.entries()]
    .map(([workflowName, bucket]) => ({
      workflowName,
      runCount: bucket.runIds.size,
      jobCount: bucket.jobCount,
      totalDurationMs: bucket.totalDurationMs,
      totalBilledMinutes: bucket.totalBilledMinutes,
      byEvent: Object.fromEntries(
        [...bucket.byEvent.entries()].map(([event, ids]) => [event, ids.size]),
      ),
    }))
    .sort(
      (a, b) =>
        b.totalBilledMinutes - a.totalBilledMinutes ||
        a.workflowName.localeCompare(b.workflowName),
    );
  return {
    runCount: runs.length,
    jobCount: workflows.reduce((sum, row) => sum + row.jobCount, 0),
    totalDurationMs: workflows.reduce(
      (sum, row) => sum + row.totalDurationMs,
      0,
    ),
    totalBilledMinutes: workflows.reduce(
      (sum, row) => sum + row.totalBilledMinutes,
      0,
    ),
    workflows,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Formats a millisecond duration as `<minutes>m<seconds>s`, rounded to the
 * nearest second -- matching how Actions itself bills (whole minutes), while
 * keeping second-level precision for comparing workflows below one minute. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, '0')}s`;
}

export function renderTable(report: ActionsUsageReport): string {
  const lines = [
    '| Workflow | Runs | Jobs | Runner time | Billed |',
    '| --- | --- | --- | --- | --- |',
    ...report.workflows.map(
      (row) =>
        `| ${row.workflowName} | ${row.runCount} | ${row.jobCount} | ${formatDuration(
          row.totalDurationMs,
        )} | ${row.totalBilledMinutes}m |`,
    ),
    '',
    `Total: ${report.runCount} runs, ${report.jobCount} jobs, ${formatDuration(
      report.totalDurationMs,
    )} runner time, ${report.totalBilledMinutes} billed minute(s).`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub fetch (I/O -- not exercised by the offline fixture test)
// ---------------------------------------------------------------------------

/**
 * Run a `gh api ... --paginate --jq <program>` call and parse its output as
 * NDJSON. Local copy of the same pattern `stalled-session-quiet-check.mts`
 * and `rerun-advisory-convergence.mts` already use for a wrapped-object
 * list endpoint (`{ total_count, workflow_runs: [...] }` /
 * `{ total_count, jobs: [...] }`), which `ghApiJson`'s own `paginate`
 * option cannot express -- it hardcodes `--jq '.[]'`, which assumes a bare
 * top-level array.
 */
function ghPaginatedJson(args: string[]): unknown[] {
  return parsePaginatedGhNdjson(ghText(args, GH_TEXT_LOOP_TIMEOUT_OPTIONS));
}

interface RawRun {
  id: number;
  name: string;
  event: string;
  pull_requests: number[];
}

interface RawJob {
  name: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Resolves `{owner, repo}` the same way other CLI helpers in this
 * repository do: explicit flags first, else `gh repo view` auto-detection. */
function resolveOwnerRepo(
  owner: string,
  repo: string,
): { owner: string; repo: string } {
  return {
    owner:
      owner ||
      ghText(
        ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      ),
    repo:
      repo ||
      ghText(
        ['repo', 'view', '--json', 'name', '--jq', '.name'],
        GH_TEXT_LOOP_TIMEOUT_OPTIONS,
      ),
  };
}

/**
 * Fetch and aggregate Actions usage for one pull request. Every workflow
 * run tied to a pull request -- `pull_request`, `pull_request_review`, and
 * `pull_request_review_comment` alike -- shares the PR's head branch name,
 * so listing runs by `branch` (rather than the repository-wide recent-runs
 * list) captures the full review-loop cost in one scoped query; each
 * fetched run is then narrowed to this PR specifically via
 * {@link isPrFamilyEvent} and {@link runBelongsToPr}.
 *
 * One extra `gh api` call per run fetches that run's own jobs (per-job
 * duration, not just the run's own wall-clock span, matters for a
 * matrix-strategy workflow like CodeQL), with `filter=all` so a rerun
 * run's earlier attempts are also counted -- the jobs endpoint's own
 * default (`filter=latest`) would otherwise silently drop every
 * attempt but the most recent one, undercounting exactly the repeated-
 * push/rerun cost this tool exists to measure. This is O(runs) API
 * calls -- fine for a manual, on-demand diagnostic tool investigating
 * one merged PR, not
 * something run in a hot path.
 */
export function fetchActionsUsageForPr(
  prNumber: number,
  ownerFlag = '',
  repoFlag = '',
): ActionsUsageReport {
  const { owner, repo } = resolveOwnerRepo(ownerFlag, repoFlag);
  const branch = ghText(
    [
      'pr',
      'view',
      String(prNumber),
      '-R',
      `${owner}/${repo}`,
      '--json',
      'headRefName',
      '--jq',
      '.headRefName',
    ],
    GH_TEXT_LOOP_TIMEOUT_OPTIONS,
  );
  const rawRuns = ghPaginatedJson([
    'api',
    `repos/${owner}/${repo}/actions/runs?branch=${encodeURIComponent(
      branch,
    )}&per_page=100`,
    '--paginate',
    '--jq',
    '.workflow_runs[] | {id: .id, name: .name, event: .event, pull_requests: [.pull_requests[].number]}',
  ]) as RawRun[];
  const runs: UsageRun[] = rawRuns
    .filter(
      (raw) =>
        isPrFamilyEvent(raw.event) &&
        runBelongsToPr(raw.pull_requests, prNumber),
    )
    .map((raw) => ({
      id: raw.id,
      workflowName: raw.name,
      event: raw.event,
    }));
  const jobs: UsageJob[] = [];
  for (const run of runs) {
    const rawJobs = ghPaginatedJson([
      'api',
      `repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
      '--paginate',
      '--jq',
      '.jobs[] | {name: .name, started_at: .started_at, completed_at: .completed_at}',
    ]) as RawJob[];
    for (const rawJob of rawJobs) {
      jobs.push({
        runId: run.id,
        jobName: rawJob.name,
        startedAt: rawJob.started_at ?? '',
        completedAt: rawJob.completed_at,
      });
    }
  }
  return aggregateActionsUsage(runs, jobs);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// Flag-spec keys stay the dashed literal on purpose -- see cli-args.mts's
// module header (tests/flag-name-matrix.test.mts scans each helper's own
// compiled .mjs source text for its canonical flags as quoted literals).
const ACTIONS_USAGE_REPORT_FLAG_SPEC = {
  '--pr': { type: 'string' },
  '--owner': { type: 'string', default: '' },
  '--repo': { type: 'string', default: '' },
  '--format': { type: 'string', default: 'table' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/actions-usage-report.mjs --pr <number> [--owner <owner>] [--repo <repo>] [--format table|json]

  --pr <number>       Pull request number to report on (required).
  --owner <owner>     Repository owner (default: auto-detected via gh repo view).
  --repo <repo>       Repository name (default: auto-detected via gh repo view).
  --format <format>   Output format: table (default) or json.
  --help, -h          Show this help.
`);
}

if (import.meta.main) {
  const { values, help } = parseCliArgs(
    process.argv.slice(2),
    ACTIONS_USAGE_REPORT_FLAG_SPEC,
  );
  if (help) {
    printHelp();
    process.exit(0);
  }
  const prRaw = values.pr as string | undefined;
  const prNumber = Number(prRaw);
  if (!prRaw || !Number.isInteger(prNumber) || prNumber <= 0) {
    process.stderr.write(
      `actions-usage-report: --pr must be a positive integer, got: ${
        prRaw ?? '(missing)'
      }\n`,
    );
    process.exit(2);
  }
  const format = values.format as string;
  if (format !== 'table' && format !== 'json') {
    process.stderr.write(
      `actions-usage-report: --format must be table or json, got: ${format}\n`,
    );
    process.exit(2);
  }
  const report = fetchActionsUsageForPr(
    prNumber,
    values.owner as string,
    values.repo as string,
  );
  process.stdout.write(
    format === 'json'
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderTable(report)}\n`,
  );
}
