import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LIVE_STATUS_DIGEST_MARKER,
  findLiveStatusDigestComments,
  planLiveStatusDigestUpsert,
  renderLiveStatusDigest,
} from "../scripts/protocol-helpers.mjs";

const fields = {
  phase: "B2 planned",
  claim: "codex-cli / claim-1",
  branch: "issue/198-live-status-digest-helper",
  lastChecked: "2026-05-10T16:20:00Z",
  openBlockers: "none",
  nextAction: "B3 implement",
  authoritativeBy: "verified claim claim-1",
};

test("discovers only current live status digest comments", () => {
  const comments = [
    {
      id: 1,
      body: `${LIVE_STATUS_DIGEST_MARKER}\n\n| Field | Value |`,
    },
    {
      id: 2,
      body: ` ${LIVE_STATUS_DIGEST_MARKER}\n\nnot first-column marker`,
    },
    {
      id: 3,
      body: "<!-- claimed-by: codex-cli claim-1 supersedes: none 2026-05-10T16:00:00Z branch: issue/example -->",
    },
  ];

  assert.deepEqual(findLiveStatusDigestComments(comments).map((comment) => comment.id), [1]);
});

test("plans creation when no digest exists", () => {
  const plan = planLiveStatusDigestUpsert([], fields);

  assert.equal(plan.action, "create");
  assert.equal(plan.canApply, true);
  assert.equal(plan.body, renderLiveStatusDigest(fields));
});

test("plans update for the single current digest", () => {
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: "https://github.example/comment/101",
        body: renderLiveStatusDigest({ ...fields, phase: "A5 claimed" }),
      },
    ],
    fields,
  );

  assert.equal(plan.action, "update");
  assert.equal(plan.commentId, 101);
  assert.equal(plan.url, "https://github.example/comment/101");
});

test("refuses duplicate current digests and reports repair context", () => {
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: "https://github.example/comment/101",
        body: renderLiveStatusDigest({ ...fields, phase: "A5 claimed" }),
      },
      {
        id: 102,
        html_url: "https://github.example/comment/102",
        body: renderLiveStatusDigest({ ...fields, phase: "B2 planned" }),
      },
    ],
    fields,
  );

  assert.equal(plan.action, "duplicate");
  assert.equal(plan.canApply, false);
  assert.equal(plan.body, null);
  assert.deepEqual(plan.duplicates.map((comment) => comment.url), [
    "https://github.example/comment/101",
    "https://github.example/comment/102",
  ]);
  assert.match(plan.repairPath, /Do not delete or minimize/);
});

test("plans no-op when the current digest is already up to date", () => {
  const body = renderLiveStatusDigest(fields);
  const plan = planLiveStatusDigestUpsert(
    [
      {
        id: 101,
        html_url: "https://github.example/comment/101",
        body,
      },
    ],
    fields,
  );

  assert.equal(plan.action, "noop");
  assert.equal(plan.commentId, 101);
  assert.equal(plan.body, body);
});

test("does not modify operational marker comments during digest operations", () => {
  const operationalMarkerComment = {
    id: 200,
    body: "<!-- claimed-by: codex-cli claim-1 supersedes: none 2026-05-10T16:00:00Z branch: example -->",
  };
  const digestComment = {
    id: 201,
    body: LIVE_STATUS_DIGEST_MARKER + "\n\n| Field | Value |",
  };

  const plan = planLiveStatusDigestUpsert(
    [operationalMarkerComment, digestComment],
    fields,
  );

  assert.equal(plan.action, "update");
  assert.equal(plan.commentId, 201);
  assert.notEqual(plan.commentId, 200);
});
