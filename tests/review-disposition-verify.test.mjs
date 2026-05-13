import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkPathAItem,
  checkPathBItem,
  classifyMarker,
  verifyDispositions,
} from "../scripts/review-disposition-verify.mjs";

// ─── classifyMarker ───────────────────────────────────────────────────────────

test("classifyMarker: null for empty string", () => {
  assert.equal(classifyMarker(""), null);
});

test("classifyMarker: null for null input", () => {
  assert.equal(classifyMarker(null), null);
});

test("classifyMarker: accepted", () => {
  assert.equal(classifyMarker("**Accepted** — the advisory confirmed no action needed"), "accepted");
});

test("classifyMarker: rejected", () => {
  assert.equal(classifyMarker("**Rejected** — the suggestion is out of scope"), "rejected");
});

test("classifyMarker: awaiting_maintainer", () => {
  assert.equal(classifyMarker("**Awaiting maintainer decision** — CODEOWNER feedback on naming"), "awaiting_maintainer");
});

test("classifyMarker: null when prefix missing em-dash", () => {
  assert.equal(classifyMarker("**Rejected** just notes the rejection"), null);
});

test("classifyMarker: null when no bold prefix", () => {
  assert.equal(classifyMarker("Accepted — some note"), null);
});

test("classifyMarker: null for unrecognised text", () => {
  assert.equal(classifyMarker("LGTM"), null);
});

test("classifyMarker: rejection confirmed by maintainer → rejected", () => {
  assert.equal(classifyMarker("**Rejection confirmed by maintainer** — agreed, closing thread"), "rejected");
});

// ─── checkPathAItem ───────────────────────────────────────────────────────────

test("checkPathAItem: Accepted — no reply required", () => {
  const result = checkPathAItem({
    id: "a1",
    path: "A",
    type: "review_thread",
    decision: "accepted",
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.decisionRecorded, true);
  assert.deepEqual(result.issues, []);
});

test("checkPathAItem: Accepted — passes even with unexpected markerReply", () => {
  const result = checkPathAItem({
    id: "a2",
    path: "A",
    type: "review_thread",
    decision: "accepted",
    markerReply: "**Accepted** — confirmed",
    threadResolved: null,
  });
  assert.equal(result.passed, true);
});

test("checkPathAItem: Rejected — proper reply + resolved thread → pass", () => {
  const result = checkPathAItem({
    id: "a3",
    path: "A",
    type: "review_thread",
    decision: "rejected",
    markerReply: "**Rejected** — out of scope for this PR",
    threadResolved: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.markerPresent, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathAItem: Rejected — reply present but thread unresolved → fail", () => {
  const result = checkPathAItem({
    id: "a4",
    path: "A",
    type: "review_thread",
    decision: "rejected",
    markerReply: "**Rejected** — out of scope",
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test("checkPathAItem: Rejected — no reply → fail", () => {
  const result = checkPathAItem({
    id: "a5",
    path: "A",
    type: "review_thread",
    decision: "rejected",
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test("checkPathAItem: Rejected — regular_comment, null threadResolved → pass", () => {
  const result = checkPathAItem({
    id: "a6",
    path: "A",
    type: "regular_comment",
    decision: "rejected",
    markerReply: "**Rejected** — not applicable",
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathAItem: Rejected — regular_comment with non-null threadResolved → fail", () => {
  const result = checkPathAItem({
    id: "a7",
    path: "A",
    type: "regular_comment",
    decision: "rejected",
    markerReply: "**Rejected** — not applicable",
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((msg) => msg.includes("non-null threadResolved")));
});

test("checkPathAItem: AMD — proper reply + unresolved thread → pass", () => {
  const result = checkPathAItem({
    id: "a8",
    path: "A",
    type: "review_thread",
    decision: "awaiting_maintainer",
    markerReply: "**Awaiting maintainer decision** — CODEOWNER review required",
    threadResolved: false,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathAItem: AMD — resolved thread → fail", () => {
  const result = checkPathAItem({
    id: "a9",
    path: "A",
    type: "review_thread",
    decision: "awaiting_maintainer",
    markerReply: "**Awaiting maintainer decision** — CODEOWNER review required",
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test("checkPathAItem: AMD — non-thread type, null threadResolved → pass", () => {
  const result = checkPathAItem({
    id: "a10",
    path: "A",
    type: "regular_comment",
    decision: "awaiting_maintainer",
    markerReply: "**Awaiting maintainer decision** — awaiting CODEOWNER response",
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathAItem: AMD — non-thread type with non-null threadResolved → fail", () => {
  const result = checkPathAItem({
    id: "a10b",
    path: "A",
    type: "regular_comment",
    decision: "awaiting_maintainer",
    markerReply: "**Awaiting maintainer decision** — awaiting CODEOWNER response",
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((msg) => msg.includes("non-null threadResolved")));
});

test("checkPathAItem: null decision → fail", () => {
  const result = checkPathAItem({
    id: "a11",
    path: "A",
    type: "review_thread",
    decision: null,
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

test("checkPathAItem: unknown decision value → fail", () => {
  const result = checkPathAItem({
    id: "a12",
    path: "A",
    type: "review_thread",
    decision: "approve",
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

// ─── checkPathBItem ───────────────────────────────────────────────────────────

test("checkPathBItem: Accepted — marker + resolved thread → pass", () => {
  const result = checkPathBItem({
    id: "b1",
    path: "B",
    type: "review_thread",
    decision: "accepted",
    markerReply: "**Accepted** — advisory confirmed the approach",
    threadResolved: true,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.markerPresent, true);
  assert.equal(result.checks.markerMatchesDecision, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathBItem: Rejected — marker + resolved thread → pass", () => {
  const result = checkPathBItem({
    id: "b2",
    path: "B",
    type: "review_thread",
    decision: "rejected",
    markerReply: "**Rejected** — no action required",
    threadResolved: true,
  });
  assert.equal(result.passed, true);
});

test("checkPathBItem: no marker → fail", () => {
  const result = checkPathBItem({
    id: "b3",
    path: "B",
    type: "review_thread",
    decision: "accepted",
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test("checkPathBItem: marker but unresolved thread → fail", () => {
  const result = checkPathBItem({
    id: "b4",
    path: "B",
    type: "review_thread",
    decision: "accepted",
    markerReply: "**Accepted** — confirmed",
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.threadResolutionCorrect, false);
});

test("checkPathBItem: regular_comment — marker + null threadResolved → pass", () => {
  const result = checkPathBItem({
    id: "b5",
    path: "B",
    type: "regular_comment",
    decision: "accepted",
    markerReply: "**Accepted** — advisory confirmed",
    threadResolved: null,
  });
  assert.equal(result.passed, true);
  assert.equal(result.checks.threadResolutionCorrect, true);
});

test("checkPathBItem: review_thread — resolved but no marker → fail", () => {
  const result = checkPathBItem({
    id: "b6",
    path: "B",
    type: "review_thread",
    decision: "accepted",
    markerReply: null,
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerPresent, false);
});

test("checkPathBItem: marker type mismatch (accepted decision, rejected marker) → fail", () => {
  const result = checkPathBItem({
    id: "b7",
    path: "B",
    type: "review_thread",
    decision: "accepted",
    markerReply: "**Rejected** — no action",
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.markerMatchesDecision, false);
});

test("checkPathBItem: awaiting_maintainer decision → fail (invalid for PATH B)", () => {
  const result = checkPathBItem({
    id: "b8",
    path: "B",
    type: "review_thread",
    decision: "awaiting_maintainer",
    markerReply: "**Awaiting maintainer decision** — ...",
    threadResolved: false,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

test("checkPathBItem: regular_comment with non-null threadResolved → fail", () => {
  const result = checkPathBItem({
    id: "b10",
    path: "B",
    type: "regular_comment",
    decision: "accepted",
    markerReply: "**Accepted** — confirmed",
    threadResolved: true,
  });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some((msg) => msg.includes("non-null threadResolved")));
});

test("checkPathBItem: null decision → fail", () => {
  const result = checkPathBItem({
    id: "b9",
    path: "B",
    type: "review_thread",
    decision: null,
    markerReply: null,
    threadResolved: null,
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.decisionRecorded, false);
});

// ─── verifyDispositions ───────────────────────────────────────────────────────

test("verifyDispositions: empty array → passed: true", () => {
  const result = verifyDispositions([]);
  assert.equal(result.passed, true);
  assert.equal(result.totalCount, 0);
  assert.equal(result.passedCount, 0);
  assert.equal(result.failedCount, 0);
});

test("verifyDispositions: all passing items → passed: true", () => {
  const items = [
    {
      id: "x1",
      path: "A",
      type: "review_thread",
      decision: "accepted",
      markerReply: null,
      threadResolved: null,
    },
    {
      id: "x2",
      path: "B",
      type: "review_thread",
      decision: "accepted",
      markerReply: "**Accepted** — confirmed",
      threadResolved: true,
    },
  ];
  const result = verifyDispositions(items);
  assert.equal(result.passed, true);
  assert.equal(result.passedCount, 2);
  assert.equal(result.failedCount, 0);
});

test("verifyDispositions: mixed with one failure → passed: false", () => {
  const items = [
    {
      id: "y1",
      path: "A",
      type: "review_thread",
      decision: "accepted",
      markerReply: null,
      threadResolved: null,
    },
    {
      id: "y2",
      path: "B",
      type: "review_thread",
      decision: "accepted",
      markerReply: null,
      threadResolved: true,
    },
  ];
  const result = verifyDispositions(items);
  assert.equal(result.passed, false);
  assert.equal(result.passedCount, 1);
  assert.equal(result.failedCount, 1);
});

test("verifyDispositions: unknown path → fail item", () => {
  const result = verifyDispositions([
    { id: "z1", path: "C", type: "review_thread", decision: "accepted", markerReply: null, threadResolved: null },
  ]);
  assert.equal(result.passed, false);
  const item = result.items[0];
  assert.ok(item.issues.some((msg) => msg.includes("Unknown path value")));
});

test("verifyDispositions: throws on non-array input", () => {
  assert.throws(() => verifyDispositions(null), TypeError);
  assert.throws(() => verifyDispositions({ items: [] }), TypeError);
});
