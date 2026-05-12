import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPreMergeReadinessSummary,
  resolveCodeownersForFiles,
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

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
