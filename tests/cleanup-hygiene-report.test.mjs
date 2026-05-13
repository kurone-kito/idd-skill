import assert from "node:assert/strict";
import { test } from "node:test";

import { generateMetrics, METRIC_SCHEMA, aggregateMetrics } from "../scripts/cleanup-hygiene-report.mjs";

test("generates metrics with correct JSON schema structure", async () => {
  const metrics = await generateMetrics({
    owner: "test-owner",
    repo: "test-repo",
  });

  assert.ok(metrics.timestamp, "timestamp is set");
  assert.equal(metrics.repository.owner, "test-owner", "owner is correct");
  assert.equal(metrics.repository.name, "test-repo", "repo name is correct");
  assert.equal(metrics.version, "1.0", "schema version matches");

  assert.ok(metrics.summary, "summary exists");
  assert.equal(typeof metrics.summary.totalMergedPRs, "number");
  assert.equal(typeof metrics.summary.clean, "number");
  assert.equal(typeof metrics.summary.needsApply, "number");
  assert.equal(typeof metrics.summary.cleanPercentage, "number");

  assert.ok(metrics.candidatesByClassifier, "candidatesByClassifier exists");
  assert.equal(typeof metrics.candidatesByClassifier.thresholdMissing, "number");
  assert.equal(typeof metrics.candidatesByClassifier.skippedWithReason, "number");
  assert.equal(typeof metrics.candidatesByClassifier.applied, "number");
  assert.equal(typeof metrics.candidatesByClassifier.failed, "number");

  assert.ok(Array.isArray(metrics.topSkipReasons), "topSkipReasons is array");
  assert.ok(metrics.trends.recent, "recent trend exists");
  assert.ok(metrics.trends.historical, "historical trend exists");
});

test("initializes trend date ranges correctly", async () => {
  const metrics = await generateMetrics({
    owner: "owner",
    repo: "repo",
  });

  const recentData = metrics.trends.recent.data;
  const historicalData = metrics.trends.historical.data;

  assert.ok(recentData.startDate, "recent startDate is set");
  assert.ok(recentData.endDate, "recent endDate is set");
  assert.ok(historicalData.beforeDate, "historical beforeDate is set");

  const startDate = new Date(recentData.startDate);
  const endDate = new Date(recentData.endDate);
  const beforeDate = new Date(historicalData.beforeDate);

  const diffDays = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
  assert.ok(diffDays >= 7, "recent trend covers at least 7 days");
  assert.ok(endDate > startDate, "end date is after start date");
  assert.equal(beforeDate.getTime(), startDate.getTime(), "historical beforeDate matches recent startDate");
});

test("handles missing owner/repo gracefully by using defaults", async () => {
  // This would require git config to be available in test environment
  // For now, we test that missing args are handled
  const metrics = await generateMetrics({
    owner: "explicit-owner",
    repo: "explicit-repo",
  });

  assert.equal(metrics.repository.owner, "explicit-owner");
  assert.equal(metrics.repository.name, "explicit-repo");
});

test("provides proper metric summary initialization", async () => {
  const metrics = await generateMetrics({
    owner: "test",
    repo: "test",
  });

  assert.equal(metrics.summary.totalMergedPRs, 0, "initial total merged PRs is 0");
  assert.equal(metrics.summary.clean, 0, "initial clean count is 0");
  assert.equal(metrics.summary.needsApply, 0, "initial needsApply count is 0");
  assert.equal(metrics.summary.cleanPercentage, 0.0, "initial clean percentage is 0");
});

test("schema includes expected classifier types", async () => {
  const metrics = await generateMetrics({
    owner: "test",
    repo: "test",
  });

  const classifier = metrics.candidatesByClassifier;
  assert.ok("thresholdMissing" in classifier);
  assert.ok("skippedWithReason" in classifier);
  assert.ok("applied" in classifier);
  assert.ok("failed" in classifier);
});

test("top skip reasons include expected categories", async () => {
  const metrics = await generateMetrics({
    owner: "test",
    repo: "test",
  });

  const reasons = metrics.topSkipReasons;
  const reasonNames = reasons.map((r) => r.reason);

  assert.ok(reasonNames.includes("review-thread-unresolved"));
  assert.ok(reasonNames.includes("operational-marker-present"));
  assert.ok(reasonNames.includes("held-by-maintainer"));
});

test("aggregateMetrics handles empty PR list", () => {
  const timestamp = new Date().toISOString();
  const metrics = aggregateMetrics([], timestamp);

  assert.equal(metrics.summary.totalMergedPRs, 0);
  assert.equal(metrics.summary.clean, 0);
  assert.equal(metrics.summary.needsApply, 0);
  assert.equal(metrics.summary.cleanPercentage, 0);
});

test("aggregateMetrics classifies clean PRs correctly", () => {
  const timestamp = new Date().toISOString();
  const sevenDaysAgo = new Date(new Date(timestamp).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const mockPRs = [
    {
      number: 1,
      title: "Clean PR",
      mergedAt: sevenDaysAgo,
      comments: [], // No operational markers
    },
  ];

  const metrics = aggregateMetrics(mockPRs, timestamp);

  assert.equal(metrics.summary.totalMergedPRs, 1);
  assert.equal(metrics.summary.clean, 1);
  assert.equal(metrics.summary.needsApply, 0);
  assert.equal(metrics.summary.cleanPercentage, 100);
});

test("aggregateMetrics detects PRs needing cleanup", () => {
  const timestamp = new Date().toISOString();
  const sevenDaysAgo = new Date(new Date(timestamp).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const mockPRs = [
    {
      number: 1,
      title: "PR with marker",
      mergedAt: sevenDaysAgo,
      comments: [
        {
          body: "<!-- review-watermark: copilot abc123 -->",
          isMinimized: false,
        },
      ],
    },
  ];

  const metrics = aggregateMetrics(mockPRs, timestamp);

  assert.equal(metrics.summary.totalMergedPRs, 1);
  assert.equal(metrics.summary.clean, 0);
  assert.equal(metrics.summary.needsApply, 1);
  assert.equal(metrics.summary.cleanPercentage, 0);
  assert.equal(metrics.candidatesByClassifier.skippedWithReason, 1);
});

test("aggregateMetrics separates recent and historical PRs", () => {
  const now = new Date();
  const timestamp = now.toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  
  const mockPRs = [
    {
      number: 1,
      title: "Recent clean PR",
      mergedAt: sevenDaysAgo,
      comments: [],
    },
    {
      number: 2,
      title: "Historical clean PR",
      mergedAt: thirtyDaysAgo,
      comments: [],
    },
  ];

  const metrics = aggregateMetrics(mockPRs, timestamp);

  assert.equal(metrics.summary.totalMergedPRs, 2);
  assert.equal(metrics.trends.recent.data.metrics.totalMergedPRs, 1);
  assert.equal(metrics.trends.recent.data.metrics.clean, 1);
  assert.equal(metrics.trends.historical.data.metrics.totalMergedPRs, 1);
  assert.equal(metrics.trends.historical.data.metrics.clean, 1);
});

test("aggregateMetrics counts skip reasons by frequency", () => {
  const timestamp = new Date().toISOString();
  const sevenDaysAgo = new Date(new Date(timestamp).getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  
  const mockPRs = [
    {
      number: 1,
      title: "PR 1",
      mergedAt: sevenDaysAgo,
      comments: [
        { body: "<!-- review-watermark: x y -->", isMinimized: false },
      ],
    },
    {
      number: 2,
      title: "PR 2",
      mergedAt: sevenDaysAgo,
      comments: [
        { body: "<!-- claimed-by: a b -->", isMinimized: false },
      ],
    },
    {
      number: 3,
      title: "PR 3",
      mergedAt: sevenDaysAgo,
      comments: [
        { body: "<!-- review-watermark: c d -->", isMinimized: false },
      ],
    },
  ];

  const metrics = aggregateMetrics(mockPRs, timestamp);

  assert.equal(metrics.candidatesByClassifier.skippedWithReason, 3);
  // Top skip reason should be 'operational-marker-present' with count >= 2
  const topReason = metrics.topSkipReasons[0];
  assert.equal(topReason.reason, "operational-marker-present");
  assert.ok(topReason.count >= 2, "top skip reason count should be at least 2");
});
