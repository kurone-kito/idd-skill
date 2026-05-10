import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildActivitySnapshotSummary,
  classifyRegularBotComment,
  indexLatestGatingReviewsByAuthor,
  indexThreadsByReview,
} from "../scripts/protocol-helpers.mjs";

const acceptedAll = readJson("fixtures/review-snapshots/accepted-all.json");
const changesRequested = readJson("fixtures/review-snapshots/changes-requested.json");
const latestGatingReview = readJson("fixtures/review-snapshots/latest-gating-review.json");
const truncatedThread = readJson("fixtures/review-snapshots/truncated-thread.json");
const newCommentAfterF2 = readJson("fixtures/review-snapshots/new-comment-after-f2.json");

test("indexes the latest gating review per author", () => {
  const index = indexLatestGatingReviewsByAuthor(acceptedAll.reviews);
  assert.equal(index.size, 0);

  const changesIndex = indexLatestGatingReviewsByAuthor(changesRequested.reviews);
  assert.equal(changesIndex.size, 1);
  assert.equal(changesIndex.get("coderabbitai").state, "CHANGES_REQUESTED");
});

test("indexes review threads by review id", () => {
  const acceptedThreads = indexThreadsByReview(acceptedAll.threads);
  assert.equal(acceptedThreads.get("REVIEW-1").total, 1);
  assert.equal(acceptedThreads.get("REVIEW-1").unresolved, 0);
  assert.equal(acceptedThreads.get("REVIEW-1").missingDisposition, 0);

  const requestedThreads = indexThreadsByReview(changesRequested.threads);
  assert.equal(requestedThreads.get("REVIEW-2").total, 1);
  assert.equal(requestedThreads.get("REVIEW-2").unresolved, 1);
  assert.equal(requestedThreads.get("REVIEW-2").missingDisposition, 1);
});

test("tracks latest gating reviews and truncated threads", () => {
  const gatingIndex = indexLatestGatingReviewsByAuthor(latestGatingReview.reviews);
  assert.equal(gatingIndex.size, 1);
  assert.equal(gatingIndex.get("coderabbitai").state, "APPROVED");

  const truncatedIndex = indexThreadsByReview(truncatedThread.threads);
  assert.equal(truncatedIndex.get("REVIEW-3").total, 1);
  assert.equal(truncatedIndex.get("REVIEW-3").unresolved, 1);
  assert.equal(truncatedIndex.get("REVIEW-3").missingDisposition, 1);
  assert.equal(truncatedIndex.get("REVIEW-3").incomplete, true);
});

test("classifies bot comments against review state and later activity", () => {
  const acceptedThreads = indexThreadsByReview(acceptedAll.threads);
  const acceptedReviews = indexLatestGatingReviewsByAuthor(acceptedAll.reviews);
  const trigger = {
    author: { login: "coderabbitai" },
    body: "<!-- This is an auto-generated reply by CodeRabbit -->\n`@kurone-kito` Sure! I'll review the latest fix now.\n\nReview triggered.",
    createdAt: "2026-05-09T18:03:00Z",
  };
  const summary = acceptedAll.comments[0];

  assert.deepEqual(
    classifyRegularBotComment(trigger, acceptedAll.comments, acceptedAll.threads),
    {
      classifier: "OUTDATED",
      reason: "stale CodeRabbit review-trigger acknowledgement after completed review",
    },
  );
  assert.deepEqual(
    classifyRegularBotComment(summary, acceptedAll.comments, acceptedAll.threads),
    {
      classifier: "RESOLVED",
      reason: "CodeRabbit completed summary reported no actionable comments",
    },
  );

  const newComment = {
    author: { login: "coderabbitai" },
    body: "<!-- This is an auto-generated reply by CodeRabbit -->\n`@kurone-kito` Sure! I'll review the latest fix now.\n\nReview triggered.",
    createdAt: "2026-05-09T18:03:00Z",
  };
  assert.equal(
    classifyRegularBotComment(
      newComment,
      newCommentAfterF2.comments,
      newCommentAfterF2.threads,
    ),
    null,
  );
});

test("builds activity snapshot metrics with trusted marker filtering", () => {
  const summary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          author: { login: "idd-bot" },
          body: "<!-- review-watermark: idd-bot claim sha none 0 none -->\n\n_idd-bot: review triage snapshot — IDD automation marker. Do not edit._",
          createdAt: "2026-05-10T10:00:00Z",
          updatedAt: "2026-05-10T10:00:00Z",
        },
        {
          author: { login: "external-user" },
          body: "<!-- review-watermark: external claim sha none 0 none -->",
          createdAt: "2026-05-10T10:10:00Z",
          updatedAt: "2026-05-10T10:10:00Z",
        },
        {
          author: { login: "reviewer" },
          body: "Needs one more fix.",
          createdAt: "2026-05-10T10:20:00Z",
          updatedAt: "2026-05-10T10:20:00Z",
        },
      ],
      reviews: [
        {
          author: { login: "reviewer" },
          state: "COMMENTED",
          submittedAt: "2026-05-10T10:15:00Z",
        },
      ],
      threads: [
        {
          id: "THREAD-3",
          isResolved: false,
          updatedAt: "2026-05-10T10:30:00Z",
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [],
          },
        },
      ],
      checks: [
        { name: "lint", state: "SUCCESS", completedAt: "2026-05-10T10:25:00Z" },
        { name: "test", state: "IN_PROGRESS", completedAt: null },
      ],
    },
    { trustedMarkerLogins: ["idd-bot"] },
  );

  assert.equal(summary.totalItemCount, 4);
  assert.equal(summary.counts.comments, 2);
  assert.equal(summary.maxActivityUpdatedAt, "2026-05-10T10:30:00Z");
  assert.equal(summary.latestCiCompletedAt, "2026-05-10T10:25:00Z");
  assert.equal(summary.latestPassingCiCompletedAt, "2026-05-10T10:25:00Z");
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
