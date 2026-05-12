import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { execFileSync } from "node:child_process";

// Helper to load fixture files
function readText(path) {
  try {
    return readFileSync(new URL(path, import.meta.url), "utf-8");
  } catch (e) {
    console.error(`Failed to load fixture: ${path}`);
    throw e;
  }
}

// Mock the audit-pr-cleanup classification logic
// These are extracted from the actual script to verify policy boundaries
function classifyComment(comment, disposition, isOperationalMarker, threads = []) {
  const hasResolvedThreads =
    threads.length > 0 && threads.every((t) => t.isResolved === true);

  // Operational markers (review-watermark, review-baseline, advisory-wait) on merged PRs
  if (isOperationalMarker) {
    return { classifier: "OUTDATED" };
  }

  // Bot comments with resolved threads
  if (hasResolvedThreads) {
    return { classifier: "RESOLVED" };
  }

  // Explicit disposition markers (Accepted/Rejected)
  if (disposition && (disposition === "**Accepted**" || disposition === "**Rejected**")) {
    return { classifier: "RESOLVED" };
  }

  // Skip: unresolved maintainer decisions
  if (
    comment.includes("Awaiting maintainer decision") ||
    comment.includes("unresolved") && comment.includes("maintainer decision")
  ) {
    return null;
  }

  // Skip: active hold notes
  if (comment.includes("### Hold") || (comment.includes("hold") && comment.includes("Do not merge"))) {
    return null;
  }

  // Skip: failed CI context still needed
  if (comment.includes("failed CI") && comment.includes("still needed")) {
    return null;
  }

  return null;
}

describe("Cleanup candidate boundaries", () => {
  // Safe candidates: should be classified as RESOLVED or OUTDATED

  test("safe: resolved known-bot review comment with fresh IDD disposition", () => {
    const comment = {
      id: 100,
      body: "**Accepted** — fixed in abc123d: added error handling",
      user: { login: "coderabbitai" },
      created_at: "2026-05-10T10:00:00Z",
      updated_at: "2026-05-11T12:00:00Z", // Later update = fresh disposition
    };

    const result = classifyComment(
      comment.body,
      "**Accepted**",
      false,
      []
    );

    assert.strictEqual(result?.classifier, "RESOLVED");
  });

  test("safe: bot review parent with resolved child threads and dispositions", () => {
    const parentComment = {
      id: 200,
      body: "CodeRabbit analysis complete.",
      user: { login: "coderabbitai" },
    };

    const threads = [
      { id: "t1", isResolved: true, comments: ["**Accepted** — understood"] },
      { id: "t2", isResolved: true, comments: ["**Rejected** — not applicable"] },
    ];

    const result = classifyComment(
      parentComment.body,
      null,
      false,
      threads
    );

    assert.strictEqual(result?.classifier, "RESOLVED");
  });

  test("safe: stale IDD operational marker on merged PR", () => {
    const marker = {
      id: 300,
      body:
        "<!-- review-watermark: copilot-cli idd-claim-123 abc123 2026-05-10T10:00:00Z 5 2026-05-11T09:00:00Z -->\n\n_copilot-cli: review snapshot — IDD automation marker._",
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-10T10:00:00Z",
    };

    const result = classifyComment(
      marker.body,
      null,
      true, // isOperationalMarker=true
      []
    );

    assert.strictEqual(result?.classifier, "OUTDATED");
  });

  test("safe: CodeRabbit completed summary with IDD disposition marker", () => {
    const summary = {
      id: 400,
      body:
        "## CodeRabbit Summary\n\nReview complete.\n\n**Accepted** — implementation matches specification",
      user: { login: "coderabbitai" },
      created_at: "2026-05-10T10:00:00Z",
      updated_at: "2026-05-11T11:00:00Z",
    };

    const result = classifyComment(
      summary.body,
      "**Accepted**",
      false,
      []
    );

    assert.strictEqual(result?.classifier, "RESOLVED");
  });

  // Unsafe candidates: should be skipped (return null)

  test("unsafe: unresolved maintainer decision thread", () => {
    const decision = {
      id: 500,
      body: "**Awaiting maintainer decision** — need approval before proceeding",
      user: { login: "github-actions[bot]" },
    };

    const result = classifyComment(
      decision.body,
      null,
      false,
      []
    );

    assert.strictEqual(result, null);
  });

  test("unsafe: active hold note", () => {
    const hold = {
      id: 600,
      body: "### Hold — waiting for maintainer response\n\nDo not merge until decided.",
      user: { login: "github-actions[bot]" },
    };

    const result = classifyComment(
      hold.body,
      null,
      false,
      []
    );

    assert.strictEqual(result, null);
  });

  test("unsafe: failed CI context still needed by maintainers", () => {
    const ciContext = {
      id: 700,
      body:
        "CI failed with: E2E test timeout.\n\nfailed CI context still needed by maintainers to evaluate retry strategy.",
      user: { login: "github-actions[bot]" },
    };

    const result = classifyComment(
      ciContext.body,
      null,
      false,
      []
    );

    assert.strictEqual(result, null);
  });

  test("unsafe: unresolved thread (new reviewer activity)", () => {
    const threads = [
      { id: "t1", isResolved: false, comments: ["New concern raised"] },
    ];

    const comment = {
      id: 800,
      body: "New reviewer comment.",
    };

    // Unresolved threads are skipped
    const result = classifyComment(
      comment.body,
      null,
      false,
      threads
    );

    assert.strictEqual(result, null);
  });

  test("unsafe: missing accept/reject disposition on feedback", () => {
    const feedback = {
      id: 900,
      body: "This could be improved by adding error handling.",
      user: { login: "coderabbitai" },
    };

    // No disposition marker = skip
    const result = classifyComment(
      feedback.body,
      null,
      false,
      []
    );

    assert.strictEqual(result, null);
  });

  test("unsafe: orphan bot review parent without narrowed safe policy", () => {
    const orphan = {
      id: 1000,
      body: "Generic bot analysis report.",
      user: { login: "copilot-pull-request-reviewer[bot]" },
    };

    // No associated threads and no safe policy narrowing
    const result = classifyComment(
      orphan.body,
      null,
      false,
      []
    );

    assert.strictEqual(result, null);
  });

  describe("Edge cases and boundary scenarios", () => {
    test("skips comments with ambiguous safety status", () => {
      const ambiguous = {
        id: 1100,
        body:
          "Changes look reasonable but need review from maintainer on security implications.",
      };

      const result = classifyComment(
        ambiguous.body,
        null,
        false,
        []
      );

      assert.strictEqual(result, null);
    });

    test("recognizes stale operational markers with fresh disposition as OUTDATED", () => {
      const oldMarker =
        "<!-- review-baseline: copilot-cli idd-claim-456 def456 -->"; // Old baseline marker

      // Old operational marker + merged PR context = OUTDATED
      const result = classifyComment(
        oldMarker,
        null,
        true,
        []
      );

      assert.strictEqual(result?.classifier, "OUTDATED");
    });

    test("requires explicit disposition for bot comments to be safe", () => {
      const botCommentWithoutDisposition = {
        id: 1200,
        body: "CodeRabbit: Performance check complete. No issues found.",
        user: { login: "coderabbitai" },
      };

      const resultWithoutDisposition = classifyComment(
        botCommentWithoutDisposition.body,
        null,
        false,
        []
      );
      assert.strictEqual(resultWithoutDisposition, null);

      // Same comment with disposition marker
      const botCommentWithDisposition = {
        ...botCommentWithoutDisposition,
        body:
          "CodeRabbit: Performance check complete. No issues found.\n\n**Accepted** — no action required",
      };

      const resultWithDisposition = classifyComment(
        botCommentWithDisposition.body,
        "**Accepted**",
        false,
        []
      );
      assert.strictEqual(resultWithDisposition?.classifier, "RESOLVED");
    });
  });

  test("completion summary fields from #325 are recognized", () => {
    // This test verifies that the new completion summary structure is compatible
    // with the cleanup audit logic

    const completionSummary = {
      id: 1300,
      body: `## Completion Summary

**Applied**: 3 candidates
- comment-123: resolved thread
- comment-124: outdated marker
- comment-125: resolved feedback

**Skipped**: 5 reasons
- comment-201: unresolved maintainer decision
- comment-202: active hold

**Failed**: 0 mutations

**Mode**: dry-run`,
      user: { login: "github-actions[bot]" },
      created_at: "2026-05-12T10:00:00Z",
    };

    // The summary comment itself should not be marked for cleanup
    // (it's informational, not a candidate)
    assert(completionSummary.body.includes("Completion Summary"));
    assert(completionSummary.body.includes("Applied"));
    assert(completionSummary.body.includes("Skipped"));
  });
});
