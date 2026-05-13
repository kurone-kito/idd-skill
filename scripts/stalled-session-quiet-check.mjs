#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_QUIET_WINDOW_MS = 30 * 60 * 1000;

if (isCliExecution()) {
  runCli();
}

/**
 * Evaluate whether a quiet window has been met for stalled-session detection.
 *
 * A quiet window is met when no externally observable progress appears
 * in the window `[now - quietWindowMs, now]`. Activities of type
 * `ci-running` represent currently-running CI and always break the window
 * regardless of timestamp.
 *
 * @param {Object} input
 * @param {string} input.now - ISO8601 current timestamp
 * @param {number} [input.quietWindowMs] - window size in ms (default 1800000)
 * @param {Array<{type: string, timestamp: string}>} input.activities
 * @returns {Object} evaluation result with quiet_window_met and evidence fields
 */
export function evaluateQuietWindow(input) {
  const now = normalizeIso(input?.now);
  if (!now) {
    throw new TypeError("input.now must be a valid ISO8601 timestamp");
  }

  const quietWindowMs = resolveQuietWindowMs(input?.quietWindowMs);
  const windowStart = new Date(Date.parse(now) - quietWindowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  const activities = normalizeActivities(input?.activities);

  const blocking = [];
  for (const activity of activities) {
    if (activity.type === "ci-running") {
      blocking.push(activity);
      continue;
    }
    if (activity.timestamp && compareIso(activity.timestamp, windowStart) >= 0) {
      blocking.push(activity);
    }
  }

  const latestBlocking = blocking.length > 0
    ? blocking.reduce((latest, act) => {
      if (!latest) return act;
      if (act.type === "ci-running" && latest.type !== "ci-running") return act;
      if (latest.type === "ci-running" && act.type !== "ci-running") return latest;
      return compareIso(act.timestamp, latest.timestamp) > 0 ? act : latest;
    }, null)
    : null;

  const quietWindowMet = blocking.length === 0;

  const reason = quietWindowMet
    ? "no-activity-in-window"
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
      has_heartbeat_in_window: blocking.some((a) => a.type === "heartbeat"),
      has_ci_running: blocking.some((a) => a.type === "ci-running"),
      has_pr_head_movement: blocking.some((a) => a.type === "pr-head-movement"),
      has_branch_tip_movement: blocking.some((a) => a.type === "branch-tip-movement"),
    },
  };
}

function buildReason(blocking) {
  const types = [...new Set(blocking.map((a) => a.type))];
  return `activity-in-window: ${types.join(", ")}`;
}

function resolveQuietWindowMs(value) {
  if (value === null || value === undefined) {
    return DEFAULT_QUIET_WINDOW_MS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_QUIET_WINDOW_MS;
  }
  return Math.floor(parsed);
}

function normalizeActivities(raw) {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((item) => ({
      type: String(item?.type ?? ""),
      timestamp: normalizeIso(item?.timestamp),
    }))
    .filter((item) => {
      if (!item.type) return false;
      if (item.type === "ci-running") return true;
      return item.timestamp !== null;
    });
}

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!Number.isInteger(args.pr) || args.pr <= 0) {
    throw new Error("--pr is required and must be a positive integer");
  }
  if (args.token) {
    process.env.GH_TOKEN = args.token;
    process.env.GITHUB_TOKEN = args.token;
  }

  const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
  const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
  const repository = `${owner}/${repo}`;
  const now = args.now || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const quietWindowMs = args.quietWindowMs > 0 ? args.quietWindowMs : resolveWindowFromPolicy(args.policy);
  const claimCreatedAt = args.claimCreatedAt || null;

  const activities = collectActivities({ repository, pr: args.pr, now, claimCreatedAt });

  const input = { now, quietWindowMs, activities };
  const result = evaluateQuietWindow(input);

  const pr = ghJson(["api", `repos/${repository}/pulls/${args.pr}`, "--jq", "{number: .number, title: .title, head_sha: .head.sha, html_url: .html_url}"]);

  const output = {
    repository: { owner, repo },
    pr: {
      number: Number(pr.number),
      title: String(pr.title ?? ""),
      head_sha: String(pr.head_sha ?? ""),
      html_url: String(pr.html_url ?? ""),
    },
    policy: {
      quiet_window_ms: quietWindowMs,
      claim_created_at: claimCreatedAt,
    },
    ...result,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

function collectActivities({ repository, pr, now, claimCreatedAt }) {
  const activities = [];

  const prData = ghJson(["api", `repos/${repository}/pulls/${pr}`, "--jq",
    "{head_sha: .head.sha, merged_at: .merged_at}"]);

  const headSha = prData.head_sha;
  if (headSha) {
    // Fetch head commit timestamp for branch-tip-movement
    const headCommit = ghJson(["api", `repos/${repository}/commits/${headSha}`, "--jq",
      "{commit_timestamp: .commit.author.date}"]);
    if (headCommit.commit_timestamp) {
      activities.push({ type: "branch-tip-movement", timestamp: headCommit.commit_timestamp });
    }
  }

  // Paginate issue comments (includes PR comments)
  const prComments = ghJson(["api", `repos/${repository}/issues/${pr}/comments`, "--paginate", "--jq", "[.[] | {timestamp: .created_at}]"]);
  for (const c of prComments) {
    activities.push({ type: "comment", timestamp: c.timestamp });
  }

  // Paginate PR reviews
  const reviews = ghJson(["api", `repos/${repository}/pulls/${pr}/reviews`, "--paginate", "--jq", "[.[] | {timestamp: .submitted_at}]"]);
  for (const r of reviews) {
    activities.push({ type: "review", timestamp: r.timestamp });
  }

  // Paginate PR review comments
  const reviewComments = ghJson(["api", `repos/${repository}/pulls/${pr}/comments`, "--paginate", "--jq", "[.[] | {timestamp: .created_at}]"]);
  for (const rc of reviewComments) {
    activities.push({ type: "comment", timestamp: rc.timestamp });
  }

  if (headSha) {
    // Paginate check-runs for CI activity
    const checkRuns = ghJson(["api", `repos/${repository}/commits/${headSha}/check-runs`, "--paginate", "--jq",
      "[.check_runs[] | {status: .status, started_at: .started_at, completed_at: .completed_at}]"]);
    for (const run of checkRuns) {
      if (run.status === "queued" || run.status === "in_progress") {
        activities.push({ type: "ci-running", timestamp: now });
      } else if (run.completed_at) {
        activities.push({ type: "ci-completed", timestamp: run.completed_at });
      }
    }
  }

  if (claimCreatedAt) {
    activities.push({ type: "heartbeat", timestamp: claimCreatedAt });
  }

  return activities;
}

function resolveWindowFromPolicy(policyPath) {
  const source = policyPath
    ? resolve(process.cwd(), policyPath)
    : resolve(process.cwd(), ".github/idd/config.json");
  try {
    const config = JSON.parse(readFileSync(source, "utf8"));
    return parseDurationToMs(config?.stallRecovery?.quietWindow) ?? DEFAULT_QUIET_WINDOW_MS;
  } catch {
    return DEFAULT_QUIET_WINDOW_MS;
  }
}

function parseDurationToMs(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(text);
  if (!match) return null;
  const days = Number.parseInt(match[1] ?? "0", 10);
  const hours = Number.parseInt(match[2] ?? "0", 10);
  const minutes = Number.parseInt(match[3] ?? "0", 10);
  const seconds = Number.parseInt(match[4] ?? "0", 10);
  return ((((days * 24) + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

function parseArgs(argv) {
  const parsed = {
    pr: null,
    owner: "",
    repo: "",
    token: "",
    now: "",
    quietWindowMs: 0,
    claimCreatedAt: "",
    policy: "",
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const requireValue = () => {
      if (value === undefined || String(value).startsWith("--")) {
        throw new Error(`missing value for argument: ${flag}`);
      }
      return value;
    };
    if (flag === "--pr") { parsed.pr = Number.parseInt(String(requireValue()), 10); i += 1; continue; }
    if (flag === "--owner") { parsed.owner = requireValue(); i += 1; continue; }
    if (flag === "--repo") { parsed.repo = requireValue(); i += 1; continue; }
    if (flag === "--token") { parsed.token = requireValue(); i += 1; continue; }
    if (flag === "--now") { parsed.now = requireValue(); i += 1; continue; }
    if (flag === "--quiet-window-ms") { parsed.quietWindowMs = Number.parseInt(String(requireValue()), 10); i += 1; continue; }
    if (flag === "--claim-created-at") { parsed.claimCreatedAt = requireValue(); i += 1; continue; }
    if (flag === "--policy") { parsed.policy = requireValue(); i += 1; continue; }
    if (flag === "--help" || flag === "-h") { parsed.help = true; continue; }
    throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/stalled-session-quiet-check.mjs --pr <number> [--owner <owner>] [--repo <repo>]
    [--token <token>] [--now <ISO8601>] [--quiet-window-ms <ms>]
    [--claim-created-at <ISO8601>] [--policy <path>]

Evaluates the S2 quiet-window check for stalled-session detection.
Outputs JSON with quiet_window_met and evidence fields.
`);
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function compareIso(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  return leftTime - rightTime;
}

function ghJson(args) {
  return JSON.parse(runGh(args).trim() || "null") ?? [];
}

function ghText(args) {
  return runGh(args).trim();
}

function runGh(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    if (stderr) throw new Error(`gh command failed: ${stderr}`);
    throw error;
  }
}

function isCliExecution() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}
