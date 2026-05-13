#!/usr/bin/env node
/**
 * cleanup-hygiene-report.mjs
 * 
 * Produces auditable cleanup hygiene snapshots for merged PRs.
 * Generates metrics for trend reporting and CI audit purposes.
 */

import { execSync } from "child_process";

/**
 * Aggregate cleanup metrics from PR data
 * 
 * This function computes cleanup hygiene metrics from merged PRs.
 * In production, it queries real PR data; in tests, it accepts mock data.
 */
export function aggregateMetrics(prs, timestamp) {
  // Validate inputs
  if (!Array.isArray(prs)) {
    throw new Error("prs must be an array");
  }
  
  if (!timestamp || isNaN(new Date(timestamp).getTime())) {
    throw new Error("timestamp must be a valid ISO 8601 date string");
  }

  const metrics = JSON.parse(JSON.stringify(METRIC_SCHEMA));

  metrics.timestamp = timestamp;

  // Set date ranges
  const now = new Date(timestamp);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  metrics.trends.recent.data.startDate = sevenDaysAgo.toISOString();
  metrics.trends.recent.data.endDate = now.toISOString();
  metrics.trends.historical.data.beforeDate = sevenDaysAgo.toISOString();

  // Separate recent and historical PRs
  const recentPRs = prs.filter((pr) => {
    const mergedAt = new Date(pr.mergedAt);
    return !isNaN(mergedAt.getTime()) && mergedAt >= sevenDaysAgo;
  });
  const historicalPRs = prs.filter((pr) => {
    const mergedAt = new Date(pr.mergedAt);
    return !isNaN(mergedAt.getTime()) && mergedAt < sevenDaysAgo;
  });

  // Classify recent PRs
  const skipReasonCounts = {};
  let recentClean = 0;
  let recentNeedsApply = 0;

  for (const pr of recentPRs) {
    const status = classifyPRCleanupStatus(pr);

    if (status.status === "clean") {
      recentClean++;
    } else if (status.status === "needs_apply") {
      recentNeedsApply++;
      skipReasonCounts[status.reason] = (skipReasonCounts[status.reason] || 0) + (status.count || 1);
    } else if (status.status === "failed") {
      metrics.candidatesByClassifier.failed++;
    } else {
      metrics.candidatesByClassifier.thresholdMissing++;
    }
  }

  // Update summary metrics (recent + historical)
  const totalMergedPRs = prs.length;
  metrics.summary.totalMergedPRs = totalMergedPRs;
  metrics.summary.clean = recentClean;
  metrics.summary.needsApply = recentNeedsApply;
  metrics.summary.cleanPercentage =
    totalMergedPRs > 0 ? (recentClean / totalMergedPRs) * 100 : 0;

  // Update candidatesByClassifier
  metrics.candidatesByClassifier.skippedWithReason = Object.values(skipReasonCounts).reduce((a, b) => a + b, 0);

  // Update recent trend
  metrics.trends.recent.data.metrics.totalMergedPRs = recentPRs.length;
  metrics.trends.recent.data.metrics.clean = recentClean;
  metrics.trends.recent.data.metrics.needsApply = recentNeedsApply;

  // Classify historical PRs
  let historicalClean = 0;
  let historicalNeedsApply = 0;
  let historicalSkipped = 0;
  for (const pr of historicalPRs) {
    const status = classifyPRCleanupStatus(pr);
    if (status.status === "clean") {
      historicalClean++;
    } else if (status.status === "needs_apply") {
      historicalNeedsApply++;
      historicalSkipped += status.count || 1;
      // Also count skip reasons from historical PRs for complete frequency analysis
      skipReasonCounts[status.reason] = (skipReasonCounts[status.reason] || 0) + (status.count || 1);
    }
  }

  metrics.trends.historical.data.metrics.totalMergedPRs = historicalPRs.length;
  metrics.trends.historical.data.metrics.clean = historicalClean;
  metrics.trends.historical.data.metrics.needsApply = historicalNeedsApply;

  // Populate top skip reasons (sorted by frequency)
  const sortedReasons = Object.entries(skipReasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  // Reset top skip reasons and populate from sorted data
  metrics.topSkipReasons = sortedReasons.map(([reason, count]) => ({
    reason,
    count,
  }));
  
  // Ensure we always have 3 entries (pad with defaults if needed)
  const defaultReasons = [
    { reason: "review-thread-unresolved", count: 0 },
    { reason: "operational-marker-present", count: 0 },
    { reason: "held-by-maintainer", count: 0 },
  ];
  
  while (metrics.topSkipReasons.length < 3) {
    const nextDefault = defaultReasons.find(
      (dr) => !metrics.topSkipReasons.some((tr) => tr.reason === dr.reason)
    );
    if (nextDefault) {
      metrics.topSkipReasons.push({ ...nextDefault });
    } else {
      break;
    }
  }

  return metrics;
}

/**
 * Classify a PR's cleanup status based on its comments
 */
function classifyPRCleanupStatus(pr) {
  const comments = pr.comments || [];
  const candidates = [];

  for (const comment of comments) {
    if (isOperationalMarker(comment.body) && !comment.isMinimized) {
      candidates.push(comment);
    }
  }

  if (candidates.length === 0) {
    return { status: "clean", reason: null };
  }

  return {
    status: "needs_apply",
    reason: "operational-marker-present",
    count: candidates.length,
  };
}

/**
 * Check if text is an operational marker
 */
function isOperationalMarker(body) {
  return /<!--\s*(review-watermark|review-baseline|claimed-by|unclaimed-by|advisory-wait)/.test(body);
}

/**
 * Parse CLI arguments
 */
function parseArgs(argv) {
  const args = {
    owner: null,
    repo: null,
    since: null,
    format: "json",
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--owner") {
      args.owner = argv[++i];
    } else if (arg === "--repo") {
      args.repo = argv[++i];
    } else if (arg === "--since") {
      args.since = argv[++i];
    } else if (arg === "--format") {
      args.format = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

/**
 * Get current GitHub repository info from git
 */
function getRepoInfo() {
  const remoteUrl = execSync("git config --get remote.origin.url")
    .toString()
    .trim();
  
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)(\.git)?$/);
  if (!match) {
    throw new Error("Unable to extract owner/repo from git remote");
  }

  return {
    owner: match[1],
    repo: match[2],
  };
}

/**
 * Metric schema definition
 */
export const METRIC_SCHEMA = {
  version: "1.0",
  timestamp: null,
  repository: { owner: null, name: null },
  summary: {
    totalMergedPRs: 0,
    clean: 0,
    needsApply: 0,
    cleanPercentage: 0.0,
  },
  candidatesByClassifier: {
    thresholdMissing: 0,
    skippedWithReason: 0,
    applied: 0,
    failed: 0,
  },
  topSkipReasons: [
    { reason: "review-thread-unresolved", count: 0 },
    { reason: "operational-marker-present", count: 0 },
    { reason: "held-by-maintainer", count: 0 },
  ],
  trends: {
    recent: {
      days: 7,
      data: {
        startDate: null,
        endDate: null,
        metrics: {
          totalMergedPRs: 0,
          clean: 0,
          needsApply: 0,
        },
      },
    },
    historical: {
      data: {
        beforeDate: null,
        metrics: {
          totalMergedPRs: 0,
          clean: 0,
          needsApply: 0,
        },
      },
    },
  },
};

/**
 * Generate cleanup hygiene metrics
 * Optionally accepts mock PR data for testing
 */
export async function generateMetrics(args, mockPRs = null) {
  const timestamp = new Date().toISOString();

  if (mockPRs !== null) {
    // Test mode: use mock data
    const metrics = aggregateMetrics(mockPRs, timestamp);
    if (args.owner) metrics.repository.owner = args.owner;
    if (args.repo) metrics.repository.name = args.repo;
    return metrics;
  }

  // Production mode: would query real PR data
  // For now, return empty metrics template with date ranges (requires full API integration)
  const metrics = JSON.parse(JSON.stringify(METRIC_SCHEMA));
  const repoInfo = getRepoInfo();
  metrics.repository.owner = args.owner || repoInfo.owner;
  metrics.repository.name = args.repo || repoInfo.repo;
  metrics.timestamp = timestamp;
  
  // Set date ranges
  const now = new Date(timestamp);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  
  metrics.trends.recent.data.startDate = sevenDaysAgo.toISOString();
  metrics.trends.recent.data.endDate = now.toISOString();
  metrics.trends.historical.data.beforeDate = sevenDaysAgo.toISOString();
  
  // In production, this would call an actual API to fetch merged PRs
  // and aggregate their cleanup status. For now, return the template.
  return metrics;
}

/**
 * Format output as JSON
 */
function formatJSON(metrics) {
  return JSON.stringify(metrics, null, 2);
}

/**
 * Format output as CSV
 */
function formatCSV(metrics) {
  const lines = [];
  lines.push("Cleanup Hygiene Report");
  lines.push(`Repository,${metrics.repository.owner}/${metrics.repository.name}`);
  lines.push(`Timestamp,${metrics.timestamp}`);
  lines.push("");
  lines.push("Metric,Value");
  lines.push(`Total Merged PRs,${metrics.summary.totalMergedPRs}`);
  lines.push(`Clean,${metrics.summary.clean}`);
  lines.push(`Needs Apply,${metrics.summary.needsApply}`);
  lines.push(`Clean Percentage,${metrics.summary.cleanPercentage.toFixed(2)}%`);

  return lines.join("\n");
}

/**
 * Print usage
 */
function printUsage() {
  console.log(`
cleanup-hygiene-report.mjs - Generate cleanup hygiene metrics

Usage:
  cleanup-hygiene-report.mjs [options]

Options:
  --owner <name>      Repository owner (defaults to current repo)
  --repo <name>       Repository name (defaults to current repo)
  --since <date>      Filter by merge date (ISO 8601 format)
  --format <type>     Output format: json (default) or csv
  --help              Show this help message
  `);
}

/**
 * Main
 */
async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printUsage();
      process.exit(0);
    }

    const metrics = await generateMetrics(args);
    let output = "";

    if (args.format === "json") {
      output = formatJSON(metrics);
    } else if (args.format === "csv") {
      output = formatCSV(metrics);
    } else {
      throw new Error(`unknown format: ${args.format}`);
    }

    console.log(output);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
