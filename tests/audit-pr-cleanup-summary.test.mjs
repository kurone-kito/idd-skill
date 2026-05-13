import assert from "node:assert/strict";
import test from "node:test";

import { computeReportSummary } from "../scripts/audit-pr-cleanup-summary.mjs";

function createReport(overrides = {}) {
  return {
    mode: "dry-run",
    candidates: [],
    skipped: [],
    applied: [],
    failed: [],
    summary: null,
    status: null,
    ...overrides,
  };
}

test("computeReportSummary counts viewer eligibility from evaluated subjects", () => {
  const report = createReport({
    candidates: [{ subjectId: "candidate-1" }, { subjectId: "candidate-2" }],
    skipped: [
      { subjectId: "skip-1", isMinimized: true, viewerCanMinimize: true },
      { subjectId: "skip-2", isMinimized: false, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.summary.candidate, 2);
  assert.equal(report.summary.skipped, 2);
  assert.equal(report.summary["already-minimized"], 1);
  assert.equal(report.summary["viewer-can-minimize"], 3);
  assert.equal(report.summary["viewer-cannot-minimize"], 1);
  assert.equal(report.status, "needs-apply");
});

test("computeReportSummary reflects apply results after mutations", () => {
  const report = createReport({
    mode: "apply",
    candidates: [{ subjectId: "candidate-1" }],
    skipped: [{ subjectId: "skip-1", isMinimized: false, viewerCanMinimize: true }],
    applied: [],
    failed: [],
  });

  computeReportSummary(report);
  assert.equal(report.status, "incomplete");
  assert.equal(report.summary.applied, 0);

  report.applied.push({ subjectId: "candidate-1" });
  computeReportSummary(report);

  assert.equal(report.status, "applied");
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.skipped, 1);
});

test("computeReportSummary emits clean when there are no candidates and no permission-blocked items", () => {
  const report = createReport({
    candidates: [],
    skipped: [{ subjectId: "skip-1", isMinimized: true, viewerCanMinimize: true }],
  });

  computeReportSummary(report);

  assert.equal(report.status, "clean");
  assert.equal(report.summary.candidate, 0);
  assert.equal(report.summary["viewer-cannot-minimize"], 0);
});

test("computeReportSummary emits permission-blocked when all items are viewer-cannot-minimize", () => {
  const report = createReport({
    candidates: [],
    skipped: [
      { subjectId: "skip-1", isMinimized: false, viewerCanMinimize: false },
      { subjectId: "skip-2", isMinimized: false, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, "permission-blocked");
  assert.equal(report.summary["viewer-cannot-minimize"], 2);
  assert.equal(report.summary.candidate, 0);
});

test("computeReportSummary emits needs-apply even when some items are viewer-cannot-minimize", () => {
  const report = createReport({
    candidates: [{ subjectId: "candidate-1" }],
    skipped: [{ subjectId: "skip-1", isMinimized: false, viewerCanMinimize: false }],
  });

  computeReportSummary(report);

  assert.equal(report.status, "needs-apply");
  assert.equal(report.summary["viewer-cannot-minimize"], 1);
  assert.equal(report.summary.candidate, 1);
});

test("computeReportSummary emits failed when apply is attempted but all candidates fail", () => {
  const report = createReport({
    mode: "apply",
    candidates: [{ subjectId: "candidate-1" }, { subjectId: "candidate-2" }],
    skipped: [],
    applied: [],
    failed: [
      { subjectId: "candidate-1", error: "GraphQL error" },
      { subjectId: "candidate-2", error: "timeout" },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, "failed");
  assert.equal(report.summary.failed, 2);
  assert.equal(report.summary.applied, 0);
});

test("computeReportSummary emits incomplete when apply is partial", () => {
  const report = createReport({
    mode: "apply",
    candidates: [{ subjectId: "candidate-1" }, { subjectId: "candidate-2" }],
    skipped: [],
    applied: [{ subjectId: "candidate-1" }],
    failed: [],
  });

  computeReportSummary(report);

  assert.equal(report.status, "incomplete");
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.failed, 0);
});

test("computeReportSummary emits failed when apply has both applied and failed candidates", () => {
  const report = createReport({
    mode: "apply",
    candidates: [{ subjectId: "candidate-1" }, { subjectId: "candidate-2" }],
    skipped: [],
    applied: [{ subjectId: "candidate-1" }],
    failed: [{ subjectId: "candidate-2", error: "GraphQL error" }],
  });

  computeReportSummary(report);

  assert.equal(report.status, "failed");
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.failed, 1);
});
