#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));

if (!args.issueNumber) {
  throw new Error("missing required --issue <number> argument");
}

if (!args.prNumber) {
  throw new Error("missing required --pr <number> argument");
}

if (!args.branchName) {
  throw new Error("missing required --branch <name> argument");
}

const owner = args.owner || ghText(["repo", "view", "--json", "owner", "--jq", ".owner.login"]);
const repo = args.repo || ghText(["repo", "view", "--json", "name", "--jq", ".name"]);
const repoRef = `${owner}/${repo}`;
const windowMinutes = args.windowMinutes || 30;
const windowMs = windowMinutes * 60 * 1000;

// Fetch all required GitHub state
const now = new Date(args.now || new Date().toISOString());
const issueComments = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.issueNumber}/comments`,
  true,
);
const prData = ghApiJson(`repos/${owner}/${repo}/pulls/${args.prNumber}`, false);
const prHeadSha = prData.head?.sha ?? "";
const prTimeline = ghApiJson(
  `repos/${owner}/${repo}/issues/${args.prNumber}/timeline`,
  true,
  ["-H", "Accept: application/vnd.github+json"],
);
const reviewThreads = ghApiJson(
  `repos/${owner}/${repo}/pulls/${args.prNumber}/reviews`,
  true,
);

const branchRef = ghApiJson(
  `repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(args.branchName)}`,
  false,
);
const branchTipSha = branchRef.object?.sha ?? "";

const prChecks = ghApiJson(
  `repos/${owner}/${repo}/commits/${prHeadSha}/check-runs`,
  true,
  ["-H", "Accept: application/vnd.github+json"],
);

const evidence = detectQuietWindow(
  {
    issueComments,
    prHeadSha,
    prTimeline,
    reviewThreads,
    branchTipSha,
    prChecks,
  },
  {
    now,
    windowMs,
    windowMinutes,
  },
);

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

function detectQuietWindow(state, options) {
  const {
    issueComments,
    prHeadSha,
    prTimeline,
    reviewThreads,
    branchTipSha,
    prChecks,
  } = state;
  const { now, windowMs, windowMinutes } = options;

  const quietWindowStart = new Date(now.getTime() - windowMs);
  const details = [];
  let isQuiet = true;

  // 1. Check for trusted heartbeat within window
  const recentHeartbeat = issueComments.find((comment) => {
    const claimedByMatch = comment.body?.match(
      /<!-- claimed-by: \S+ (\S+) .*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/,
    );
    if (!claimedByMatch) {
      return false;
    }
    const heartbeatTime = new Date(claimedByMatch[2]);
    return heartbeatTime >= quietWindowStart;
  });

  if (recentHeartbeat) {
    isQuiet = false;
    details.push(
      `Recent heartbeat found at ${recentHeartbeat.created_at}: claim activity within window`,
    );
  }

  // 2. Check for PR head SHA changes (PR head movement)
  const prHeadChanges = prTimeline.filter(
    (event) =>
      event.event === "committed" &&
      event.sha &&
      new Date(event.created_at ?? event.timestamp ?? "") >= quietWindowStart,
  );

  if (prHeadChanges.length > 0) {
    isQuiet = false;
    details.push(
      `PR head movement detected: ${prHeadChanges.length} commit(s) within window`,
    );
  }

  // 3. Check for branch tip SHA changes (remote branch tip movement)
  if (args.previousBranchTipSha && branchTipSha !== args.previousBranchTipSha) {
    isQuiet = false;
    details.push(
      `Branch tip changed from ${args.previousBranchTipSha.slice(0, 7)} to ${branchTipSha.slice(0, 7)}`,
    );
  }

  // 4. Check for running CI activity (queued/in_progress checks)
  const runningChecks = prChecks.filter((check) => {
    const status = check.status ?? "";
    return status === "queued" || status === "in_progress";
  });

  if (runningChecks.length > 0) {
    isQuiet = false;
    details.push(
      `Active CI runs detected: ${runningChecks.length} check(s) in progress`,
    );
  }

  // 5. Check for new review/comment/CI completion activity
  const recentReviewActivity = reviewThreads.filter((review) => {
    const reviewTime = new Date(review.submitted_at ?? "");
    return reviewTime >= quietWindowStart;
  });

  if (recentReviewActivity.length > 0) {
    isQuiet = false;
    details.push(
      `Review activity detected: ${recentReviewActivity.length} review(s) within window`,
    );
  }

  const recentComments = issueComments.filter((comment) => {
    const commentTime = new Date(comment.created_at ?? "");
    return (
      commentTime >= quietWindowStart &&
      !comment.body?.startsWith("<!-- claimed-by:") &&
      !comment.body?.startsWith("<!-- unclaimed-by:")
    );
  });

  if (recentComments.length > 0) {
    isQuiet = false;
    details.push(`Comment activity detected: ${recentComments.length} comment(s) within window`);
  }

  const recentChecksCompleted = prChecks.filter((check) => {
    const completedTime = check.completed_at ? new Date(check.completed_at) : null;
    return completedTime && completedTime >= quietWindowStart;
  });

  if (recentChecksCompleted.length > 0) {
    isQuiet = false;
    details.push(`CI completion detected: ${recentChecksCompleted.length} check(s) completed`);
  }

  const latestActivityTime = Math.max(
    ...[
      ...issueComments.map((c) => new Date(c.created_at ?? "").getTime()),
      ...prTimeline.map((e) => new Date(e.created_at ?? e.timestamp ?? "").getTime()),
      ...reviewThreads.map((r) => new Date(r.submitted_at ?? "").getTime()),
      ...prChecks.map((c) => (c.completed_at ? new Date(c.completed_at).getTime() : 0)),
    ].filter(Boolean),
  );

  return {
    isQuiet,
    evidence: {
      windowMinutes,
      windowStartUtc: quietWindowStart.toISOString(),
      windowEndUtc: now.toISOString(),
      latestActivityUtc: Number.isFinite(latestActivityTime)
        ? new Date(latestActivityTime).toISOString()
        : null,
      reason: isQuiet
        ? "No activity detected within quiet window"
        : `Activity detected within ${windowMinutes}-minute window`,
      details,
      checkSummary: {
        heartbeatCheck: recentHeartbeat ? "FAILED" : "PASSED",
        prHeadMovementCheck: prHeadChanges.length === 0 ? "PASSED" : "FAILED",
        branchTipMovementCheck:
          !args.previousBranchTipSha || branchTipSha === args.previousBranchTipSha
            ? "PASSED"
            : "FAILED",
        runningCiCheck: runningChecks.length === 0 ? "PASSED" : "FAILED",
        reviewActivityCheck: recentReviewActivity.length === 0 ? "PASSED" : "FAILED",
        commentActivityCheck: recentComments.length === 0 ? "PASSED" : "FAILED",
        ciCompletionCheck: recentChecksCompleted.length === 0 ? "PASSED" : "FAILED",
      },
    },
  };
}

function parseArgs(argv) {
  const parsed = {
    issueNumber: null,
    prNumber: null,
    branchName: "",
    owner: "",
    repo: "",
    windowMinutes: 30,
    now: "",
    previousBranchTipSha: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];

    if (token === "--issue") {
      parsed.issueNumber = Number.parseInt(value ?? "", 10);
      index += 1;
      continue;
    }
    if (token === "--pr") {
      parsed.prNumber = Number.parseInt(value ?? "", 10);
      index += 1;
      continue;
    }
    if (token === "--branch") {
      parsed.branchName = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--owner") {
      parsed.owner = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--repo") {
      parsed.repo = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--window-minutes") {
      parsed.windowMinutes = Number.parseInt(value ?? "", 10) || 30;
      index += 1;
      continue;
    }
    if (token === "--now") {
      parsed.now = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--previous-branch-tip-sha") {
      parsed.previousBranchTipSha = value ?? "";
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${token}`);
  }

  if (!Number.isInteger(parsed.issueNumber) || parsed.issueNumber < 1) {
    parsed.issueNumber = null;
  }
  if (!Number.isInteger(parsed.prNumber) || parsed.prNumber < 1) {
    parsed.prNumber = null;
  }

  return parsed;
}

function printHelp() {
  process.stdout.write(`Usage:
  node scripts/stalled-session-quiet-check.mjs --issue <number> --pr <number> --branch <name> [--owner <owner>] [--repo <repo>] [--window-minutes <minutes>] [--now <ISO8601>] [--previous-branch-tip-sha <sha>]

  Detects quiet windows (no activity) for stalled session recovery per Resume/S2 specification.

  Options:
    --issue <number>              Issue number (required)
    --pr <number>                 PR number (required)
    --branch <name>               Branch name (required)
    --owner <owner>               Repository owner (defaults to current repo)
    --repo <repo>                 Repository name (defaults to current repo)
    --window-minutes <minutes>    Quiet window duration in minutes (default: 30)
    --now <ISO8601>               Reference timestamp (defaults to current time)
    --previous-branch-tip-sha     Previous branch tip SHA for movement detection
    --help                        Show this help message
`);
}

function ghText(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function ghApiJson(path, paginate = false, extraArgs = []) {
  const args = ["api", path, ...extraArgs];
  if (paginate) {
    args.splice(1, 0, "--paginate", "--slurp");
    return JSON.parse(execFileSync("gh", args, { encoding: "utf8" })).flat();
  }
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8" }));
}
