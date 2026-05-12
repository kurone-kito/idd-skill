import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildActivitySnapshotSummary,
  buildPreMergeReadinessSummary,
  findLastCopilotReviewCommit,
  resolveCodeownersForFiles,
  summarizeAdvisoryWaitMarkers,
  summarizeRegularCommentsForGate,
  summarizeRequiredChecks,
  summarizeReviewerStates,
} from "../scripts/protocol-helpers.mjs";
import { loadJson, validate } from "../scripts/validate-schemas.mjs";

const readinessSchema = loadJson("schemas/pre-merge-readiness.schema.json");

for (const fixtureName of [
  "clean",
  "stale-watermark",
  "unresolved-thread",
  "changes-requested",
  "unreplied-comment",
  "ci-not-ready",
  "claim-lost",
]) {
  test(`pre-merge readiness fixture: ${fixtureName}`, () => {
    const fixture = readJson(`fixtures/pre-merge-readiness/${fixtureName}.json`);
    const summary = buildPreMergeReadinessSummary(fixture.input, fixture.options);

    assert.deepEqual(summary, fixture.expected, fixtureName);
    assert.deepEqual(validate(summary, readinessSchema), []);
  });
}

test("pre-merge readiness schema keeps UTC timestamps strict", () => {
  const cleanFixture = readJson("fixtures/pre-merge-readiness/clean.json");
  const cleanSummary = buildPreMergeReadinessSummary(cleanFixture.input, cleanFixture.options);
  const invalidNow = JSON.parse(JSON.stringify(cleanSummary));
  invalidNow.now = "2026-05-12T00:14:04+09:00";
  assert.ok(validate(invalidNow, readinessSchema).length > 0);

  const unrepliedFixture = readJson("fixtures/pre-merge-readiness/unreplied-comment.json");
  const unrepliedSummary = buildPreMergeReadinessSummary(
    unrepliedFixture.input,
    unrepliedFixture.options,
  );
  const invalidCommentTime = JSON.parse(JSON.stringify(unrepliedSummary));
  invalidCommentTime.unrepliedComments.items[0].createdAt = "2026-05-12T00:14:04+09:00";
  assert.ok(validate(invalidCommentTime, readinessSchema).length > 0);

  const invalidReviewerTime = JSON.parse(JSON.stringify(cleanSummary));
  invalidReviewerTime.reviewerStates.latestByAuthor[0].submittedAt = "2026-05-12T00:14:04+09:00";
  assert.ok(validate(invalidReviewerTime, readinessSchema).length > 0);
});

test("required check summaries block when no merge-gate policy evidence exists", () => {
  assert.deepEqual(summarizeRequiredChecks([], [], {}), {
    status: "unknown",
    requiredCheckCount: 0,
    generatedRequiredCheckCount: 0,
    requiredChecksGenerated: false,
    requiredChecksPassing: false,
    requiredCheckNames: [],
    missingRequiredCheckNames: [],
    checks: [],
  });
});

test("classic branch protection check metadata keeps source-pinned checks conservative", () => {
  const summary = summarizeRequiredChecks(
    [{ name: "lint", state: "SUCCESS", completedAt: "2026-05-12T00:32:10Z" }],
    [],
    { required_status_checks: { checks: [{ context: "lint", app_id: 1 }] } },
  );

  assert.equal(summary.status, "unknown");
  assert.deepEqual(summary.requiredCheckNames, ["lint"]);
});

test("CODEOWNERS patterns with slashes stay root anchored", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("docs/* @org/docs\n", ["docs/file.md", "src/docs/file.md"]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: ["src/docs/file.md"],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/docs"],
    },
  );
});

test("required reviewer rule objects stay blocking until GitHub marks approval satisfied", () => {
  const branchRules = [
    {
      type: "pull_request",
      parameters: {
        required_reviewers: [
          {
            reviewer: { type: "Team", id: 42 },
            minimum_approvals: 1,
          },
        ],
      },
    },
  ];

  const pending = summarizeReviewerStates([], { branchRules, reviewDecision: "" });
  assert.equal(pending.requiredApprovalsSatisfied, false);
  assert.deepEqual(pending.requiredReviewerTeams, ["team/42"]);

  const approved = summarizeReviewerStates([], { branchRules, reviewDecision: "APPROVED" });
  assert.equal(approved.requiredApprovalsSatisfied, true);
});

test("required reviewer file patterns only apply when changed files match", () => {
  const branchRules = [
    {
      type: "pull_request",
      parameters: {
        required_reviewers: [
          {
            reviewer: { type: "Team", id: 42 },
            minimum_approvals: 1,
            file_patterns: ["docs/**"],
          },
        ],
      },
    },
  ];

  const nonMatching = summarizeReviewerStates([], {
    branchRules,
    changedFiles: ["src/index.js"],
    reviewDecision: "",
  });
  assert.equal(nonMatching.requiredApprovalsSatisfied, true);

  const matching = summarizeReviewerStates([], {
    branchRules,
    changedFiles: ["docs/idd-workflow.md"],
    reviewDecision: "",
  });
  assert.equal(matching.requiredApprovalsSatisfied, false);
});

test("reviewDecision blocks approval-count fallback when GitHub still requires review", () => {
  const summary = summarizeReviewerStates(
    [
      {
        author: { login: "reviewer" },
        state: "APPROVED",
        submittedAt: "2026-05-12T00:25:11Z",
      },
    ],
    {
      branchRules: [
        {
          type: "pull_request",
          parameters: { required_approving_review_count: 1 },
        },
      ],
      reviewDecision: "REVIEW_REQUIRED",
    },
  );

  assert.equal(summary.requiredApprovalsSatisfied, false);
});

test("advisory bots do not block CHANGES_REQUESTED even when configured in policy", () => {
  const summary = summarizeReviewerStates(
    [
      {
        author: { login: "copilot-pull-request-reviewer" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-05-12T00:25:11Z",
      },
    ],
    {
      advisoryBotLogins: ["copilot-pull-request-reviewer"],
      branchRules: [
        {
          type: "pull_request",
          parameters: {
            required_reviewers: [{ login: "copilot-pull-request-reviewer", minimum_approvals: 1 }],
            require_code_owner_review: true,
          },
        },
      ],
      codeownersText: "* @copilot-pull-request-reviewer",
      changedFiles: ["docs/idd-workflow.md"],
    },
  );

  assert.equal(summary.humanChangesRequestedCount, 0);
  assert.deepEqual(summary.blockingChangesRequestedLogins, []);
});

test("mixed-precision timestamps compare by time instead of string order", () => {
  const headSha = "a".repeat(40);
  assert.equal(
    summarizeAdvisoryWaitMarkers(
      [
        { body: `advisory-wait: kurone-kito ${headSha} 2026-05-12T00:00:00Z`, createdAt: "2026-05-12T00:00:00Z", author: { login: "kurone-kito" } },
        { body: `advisory-wait: kurone-kito ${headSha} 2026-05-12T00:00:00.100Z`, createdAt: "2026-05-12T00:00:00.100Z", author: { login: "kurone-kito" } },
      ],
      headSha,
      ["kurone-kito"],
    ).earliestSameHeadAt,
    "2026-05-12T00:00:00Z",
  );

  assert.equal(
    buildActivitySnapshotSummary({
      comments: [
        { createdAt: "2026-05-12T00:00:00Z", updatedAt: "2026-05-12T00:00:00Z", body: "a", author: { login: "reviewer" } },
        { createdAt: "2026-05-12T00:00:00.100Z", updatedAt: "2026-05-12T00:00:00.100Z", body: "b", author: { login: "reviewer" } },
      ],
      reviews: [],
      threads: [],
      checks: [],
    }).maxActivityUpdatedAt,
    "2026-05-12T00:00:00.100Z",
  );

  assert.equal(
    summarizeRegularCommentsForGate(
      [
        { id: 1, createdAt: "2026-05-12T00:00:00Z", body: "question", author: { login: "reviewer" } },
        { id: 2, createdAt: "2026-05-12T00:00:00.100Z", body: "**Accepted** — reply", author: { login: "idd-bot" } },
      ],
      { iddAgentLogins: ["idd-bot"] },
    ).count,
    0,
  );

  assert.equal(
    findLastCopilotReviewCommit([
      { author: { login: "copilot-pull-request-reviewer" }, submittedAt: "2026-05-12T00:00:00Z", commitId: "old" },
      { author: { login: "copilot-pull-request-reviewer" }, submittedAt: "2026-05-12T00:00:00.100Z", commitId: "new" },
    ]),
    "new",
  );
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
