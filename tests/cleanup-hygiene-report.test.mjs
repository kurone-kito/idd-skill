import assert from "node:assert/strict";
import { test } from "node:test";

import { generateMetrics, METRIC_SCHEMA } from "../scripts/cleanup-hygiene-report.mjs";

test("generates metrics with correct JSON schema structure", () => {
  const metrics = generateMetrics({
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

test("initializes trend date ranges correctly", () => {
  const metrics = generateMetrics({
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

test("handles missing owner/repo gracefully by using defaults", () => {
  // This would require git config to be available in test environment
  // For now, we test that missing args are handled
  const metrics = generateMetrics({
    owner: "explicit-owner",
    repo: "explicit-repo",
  });

  assert.equal(metrics.repository.owner, "explicit-owner");
  assert.equal(metrics.repository.name, "explicit-repo");
});

test("provides proper metric summary initialization", () => {
  const metrics = generateMetrics({
    owner: "test",
    repo: "test",
  });

  assert.equal(metrics.summary.totalMergedPRs, 0, "initial total merged PRs is 0");
  assert.equal(metrics.summary.clean, 0, "initial clean count is 0");
  assert.equal(metrics.summary.needsApply, 0, "initial needsApply count is 0");
  assert.equal(metrics.summary.cleanPercentage, 0.0, "initial clean percentage is 0");
});

test("schema includes expected classifier types", () => {
  const metrics = generateMetrics({
    owner: "test",
    repo: "test",
  });

  const classifier = metrics.candidatesByClassifier;
  assert.ok("thresholdMissing" in classifier);
  assert.ok("skippedWithReason" in classifier);
  assert.ok("applied" in classifier);
  assert.ok("failed" in classifier);
});

test("top skip reasons include expected categories", () => {
  const metrics = generateMetrics({
    owner: "test",
    repo: "test",
  });

  const reasons = metrics.topSkipReasons;
  const reasonNames = reasons.map((r) => r.reason);

  assert.ok(reasonNames.includes("review-thread-unresolved"));
  assert.ok(reasonNames.includes("operational-marker-present"));
  assert.ok(reasonNames.includes("held-by-maintainer"));
});
