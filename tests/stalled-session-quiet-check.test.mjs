#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mock detection logic for testing
function detectQuietWindow(state, options) {
  const {
    issueComments,
    prHeadSha,
    prTimeline,
    reviewThreads,
    branchTipSha,
    prChecks,
  } = state;
  const { now, windowMs } = options;

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
  if (state.previousBranchTipSha && branchTipSha !== state.previousBranchTipSha) {
    isQuiet = false;
    details.push(
      `Branch tip changed from ${state.previousBranchTipSha.slice(0, 7)} to ${branchTipSha.slice(0, 7)}`,
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

  return {
    isQuiet,
    evidence: {
      reason: isQuiet
        ? "No activity detected within quiet window"
        : "Activity detected within quiet window",
      details,
      checkSummary: {
        heartbeatCheck: recentHeartbeat ? "FAILED" : "PASSED",
        prHeadMovementCheck: prHeadChanges.length === 0 ? "PASSED" : "FAILED",
        branchTipMovementCheck:
          !state.previousBranchTipSha || branchTipSha === state.previousBranchTipSha
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

describe("stalled-session-quiet-check", () => {
  const now = new Date("2024-05-13T12:00:00Z");
  const windowMs = 30 * 60 * 1000; // 30 minutes

  it("Case 1: No activity in window → isQuiet=true", () => {
    const state = {
      issueComments: [],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, true);
    assert.strictEqual(result.evidence.checkSummary.heartbeatCheck, "PASSED");
    assert.strictEqual(result.evidence.checkSummary.prHeadMovementCheck, "PASSED");
    assert.strictEqual(result.evidence.checkSummary.runningCiCheck, "PASSED");
  });

  it("Case 2: Recent heartbeat within window → isQuiet=false", () => {
    const recentTime = "2024-05-13T11:50:00Z"; // 10 minutes before now
    const state = {
      issueComments: [
        {
          body: `<!-- claimed-by: copilot abc123 supersedes: none ${recentTime} branch: issue/123 -->`,
          created_at: recentTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.heartbeatCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("heartbeat")));
  });

  it("Case 3: PR head SHA changed → isQuiet=false", () => {
    const recentTime = "2024-05-13T11:50:00Z";
    const state = {
      issueComments: [],
      prHeadSha: "abc123",
      prTimeline: [
        {
          event: "committed",
          sha: "def456",
          created_at: recentTime,
        },
      ],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.prHeadMovementCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("PR head movement")));
  });

  it("Case 4: Branch tip changed → isQuiet=false", () => {
    const state = {
      issueComments: [],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "def456",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.branchTipMovementCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("Branch tip changed")));
  });

  it("Case 5: Running CI checks → isQuiet=false", () => {
    const state = {
      issueComments: [],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [
        {
          status: "in_progress",
          name: "test-suite",
        },
      ],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.runningCiCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("Active CI runs")));
  });

  it("Case 6: Recent comment activity → isQuiet=false", () => {
    const recentTime = "2024-05-13T11:50:00Z";
    const state = {
      issueComments: [
        {
          body: "This is a regular comment",
          created_at: recentTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.commentActivityCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("Comment activity")));
  });

  it("Case 7: Multiple activity types → isQuiet=false", () => {
    const recentTime = "2024-05-13T11:50:00Z";
    const state = {
      issueComments: [
        {
          body: "This is a comment",
          created_at: recentTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [
        {
          event: "committed",
          sha: "def456",
          created_at: recentTime,
        },
      ],
      reviewThreads: [
        {
          submitted_at: recentTime,
        },
      ],
      branchTipSha: "abc123",
      prChecks: [
        {
          status: "queued",
          name: "test",
        },
      ],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert(result.evidence.details.length >= 4, `Expected at least 4 details, got ${result.evidence.details.length}`);
  });

  it("Case 8: Edge case - activity at exact window boundary → isQuiet=false", () => {
    const boundaryTime = "2024-05-13T11:30:00Z"; // Exactly 30 min before now
    const state = {
      issueComments: [
        {
          body: "Comment at boundary",
          created_at: boundaryTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    // Activity at exact boundary is considered within window (>= check)
    assert.strictEqual(result.isQuiet, false);
    assert(result.evidence.details.some((d) => d.includes("Comment activity")));
  });

  it("Case 9: Old heartbeat outside window → isQuiet=true", () => {
    const oldTime = "2024-05-13T11:20:00Z"; // 40 min before now
    const state = {
      issueComments: [
        {
          body: `<!-- claimed-by: copilot xyz ${oldTime} branch: issue/123 -->`,
          created_at: oldTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, true);
    assert.strictEqual(result.evidence.checkSummary.heartbeatCheck, "PASSED");
  });

  it("Case 10: Filtered comments (heartbeat/unclaim markers) don't count", () => {
    const recentTime = "2024-05-13T11:50:00Z";
    const state = {
      issueComments: [
        {
          body: `<!-- claimed-by: copilot xyz ${recentTime} branch: issue/123 -->`,
          created_at: recentTime,
        },
        {
          body: `<!-- unclaimed-by: copilot xyz ${recentTime} -->`,
          created_at: recentTime,
        },
      ],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    // First heartbeat marks it as not quiet
    assert.strictEqual(result.evidence.checkSummary.heartbeatCheck, "FAILED");
    // But unclaim marker should be filtered from comment activity
    assert.strictEqual(result.evidence.checkSummary.commentActivityCheck, "PASSED");
  });

  it("Case 11: CI completion detection", () => {
    const recentTime = "2024-05-13T11:50:00Z";
    const state = {
      issueComments: [],
      prHeadSha: "abc123",
      prTimeline: [],
      reviewThreads: [],
      branchTipSha: "abc123",
      prChecks: [
        {
          status: "success",
          completed_at: recentTime,
        },
      ],
      previousBranchTipSha: "abc123",
    };

    const result = detectQuietWindow(state, { now, windowMs });

    assert.strictEqual(result.isQuiet, false);
    assert.strictEqual(result.evidence.checkSummary.ciCompletionCheck, "FAILED");
    assert(result.evidence.details.some((d) => d.includes("CI completion")));
  });
});
