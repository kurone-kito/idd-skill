import assert from "node:assert/strict";
import { test } from "node:test";

import { countLatestChangesRequestedByReviewer, selectResumeRoute } from "../scripts/resume-route-selection.mjs";

test("routes D4 when no PR and required checks are not generated", () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: false,
    worktreeDirty: false,
  });
  assert.equal(result.route, "D4");
});

test("routes stop when multiple matching open PRs are detected", () => {
  const result = selectResumeRoute({
    prAmbiguous: true,
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, "stop");
  assert.equal(result.reason, "multiple-open-prs-for-issue");
});

test("routes D1 when no PR and clean worktree has unpushed commits", () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, "D1");
});

test("routes D4 when no PR and worktree is dirty", () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: true,
  });
  assert.equal(result.route, "D4");
});

test("routes D4 when PR exists, CI is running, and no reviews exist", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: false,
    reviewPending: false,
  });
  assert.equal(result.route, "D4");
});

test("routes E15 when PR exists, CI is running, and reviews exist", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, "E15");
});

test("routes E1 when PR exists, CI succeeded, and reviews are pending", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, "E1");
});

test("routes F1 when PR exists, CI succeeded, no pending reviews, and merge needs rebase", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    mergeNeedsRebase: true,
  });
  assert.equal(result.route, "F1");
});

test("routes F2 when PR exists, CI succeeded, no pending reviews, and merge is clean", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    mergeNeedsRebase: false,
  });
  assert.equal(result.route, "F2");
});

test("routes E15 when PR exists, CI fails, and reviews exist", () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciFailed: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, "E15");
});

test("counts CHANGES_REQUESTED using each reviewer's latest gating state", () => {
  const count = countLatestChangesRequestedByReviewer([
    {
      user: { login: "alice" },
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-05-12T10:00:00Z",
    },
    {
      user: { login: "alice" },
      state: "APPROVED",
      submitted_at: "2026-05-12T11:00:00Z",
    },
    {
      user: { login: "bob" },
      state: "CHANGES_REQUESTED",
      submitted_at: "2026-05-12T09:00:00Z",
    },
  ]);
  assert.equal(count, 1);
});
