import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAdvisoryWaitSummary,
  buildActivitySnapshotSummary,
  buildPreMergeReadinessSummary,
  deriveIddAgentLogins,
  findLastCopilotReviewCommit,
  indexLatestGatingReviewsByAuthor,
  resolveCodeownersForFiles,
  selectCodeownersText,
  summarizeAdvisoryWaitMarkers,
  summarizeClaimValidation,
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

  const invalidCommentId = JSON.parse(JSON.stringify(unrepliedSummary));
  invalidCommentId.unrepliedComments.items[0].id = "";
  assert.ok(validate(invalidCommentId, readinessSchema).length > 0);

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

test("classic branch protection app_id -1 does not force source-pinned status", () => {
  const summary = summarizeRequiredChecks(
    [{ name: "lint", state: "SUCCESS", completedAt: "2026-05-12T00:32:10Z" }],
    [],
    { required_status_checks: { checks: [{ context: "lint", app_id: -1 }] } },
  );

  assert.equal(summary.status, "success");
  assert.deepEqual(summary.requiredCheckNames, ["lint"]);
});

test("required workflow rules keep CI conservative even when named checks pass", () => {
  const summary = summarizeRequiredChecks(
    [{ name: "lint", state: "SUCCESS", completedAt: "2026-05-12T00:32:10Z" }],
    [{ type: "workflows", parameters: { workflows: [{ repository_id: 1, path: ".github/workflows/ci.yml" }] } }],
    { required_status_checks: { contexts: ["lint"] } },
  );

  assert.equal(summary.status, "unknown");
  assert.equal(summary.requiredChecksPassing, false);
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

test("CODEOWNERS **/ patterns match both root and nested files", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("**/README.md @org/docs\n", ["README.md", "docs/README.md"]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/docs"],
    },
  );
});

test("CODEOWNERS middle **/ segments match zero or more directories", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("docs/**/README.md @org/docs\n", ["docs/README.md", "docs/guides/README.md"]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/docs"],
    },
  );
});

test("CODEOWNERS trailing slash patterns match directories at any depth", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("apps/ @org/apps\n", ["apps/main.ts", "src/apps/main.ts"]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/apps"],
    },
  );
});

test("CODEOWNERS directory-style patterns match descendants", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("**/logs @org/ops\n", ["build/logs/app.log"]),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/ops"],
    },
  );
});

test("CODEOWNERS dot-prefixed directory patterns match descendants", () => {
  assert.deepEqual(
    resolveCodeownersForFiles(".github @org/automation\n", [".github/workflows/ci.yml"]),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/automation"],
    },
  );
});

test("CODEOWNERS dotted literal patterns match descendant paths", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("proto.v1 @org/api\n", ["proto.v1/service.proto", "src/proto.v1/service.proto"]),
    {
      ruleCount: 1,
      changedFileCount: 2,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/api"],
    },
  );
});

test("CODEOWNERS patterns preserve escaped spaces", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("docs/My\\ File.md @org/docs\n", ["docs/My File.md"]),
    {
      ruleCount: 1,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: ["org/docs"],
    },
  );
});

test("CODEOWNERS ownerless overrides clear inherited ownership", () => {
  assert.deepEqual(
    resolveCodeownersForFiles("/apps/ @org/apps\n/apps/github\n", ["apps/github/routes.ts"]),
    {
      ruleCount: 2,
      changedFileCount: 1,
      unmatchedFiles: [],
      codeownerUserLogins: [],
      codeownerTeamSlugs: [],
    },
  );
});

test("higher-priority empty CODEOWNERS files stop fallback to lower-priority locations", () => {
  assert.equal(
    selectCodeownersText([
      {},
      { content: "" },
      { content: Buffer.from("*.js @org/root\n").toString("base64") },
    ]),
    "",
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

test("email-only CODEOWNERS rules still block codeowner approval", () => {
  const summary = summarizeReviewerStates([], {
    branchRules: [{
      type: "pull_request",
      parameters: {
        require_code_owner_review: true,
      },
    }],
    codeownersText: "*.js user@example.com\n",
    changedFiles: ["app.js"],
  });

  assert.equal(summary.codeownerApprovalSatisfied, false);
  assert.deepEqual(summary.unmatchedCodeownerFiles, []);
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

test("latest gating reviews compare timestamps by parsed time", () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: "reviewer" },
      state: "APPROVED",
      submittedAt: "2026-05-12T01:00:00Z",
    },
    {
      author: { login: "reviewer" },
      state: "CHANGES_REQUESTED",
      submittedAt: "2026-05-12T01:00:00.100Z",
    },
  ]);

  assert.equal(latest.get("reviewer")?.state, "CHANGES_REQUESTED");
});

test("latest gating reviews ignore invalid timestamps when a valid review exists", () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: "reviewer" },
      state: "APPROVED",
      submittedAt: "2026-05-12T01:00:00Z",
    },
    {
      author: { login: "reviewer" },
      state: "CHANGES_REQUESTED",
      submittedAt: "",
    },
  ]);

  assert.equal(latest.get("reviewer")?.state, "APPROVED");
});

test("latest gating reviews keep blocking reviews when only updatedAt is valid", () => {
  const latest = indexLatestGatingReviewsByAuthor([
    {
      author: { login: "reviewer" },
      state: "CHANGES_REQUESTED",
      submittedAt: "",
      updatedAt: "2026-05-12T01:00:00Z",
    },
  ]);

  assert.equal(latest.get("reviewer")?.state, "CHANGES_REQUESTED");
  assert.equal(latest.get("reviewer")?.submittedAt, "2026-05-12T01:00:00Z");
});

test("regular comment gate only keeps comments after the latest IDD reply", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      { id: 1, createdAt: "2026-05-12T00:00:00Z", body: "first", author: { login: "reviewer-a" } },
      { id: 2, createdAt: "2026-05-12T00:00:01Z", body: "second", author: { login: "reviewer-b" } },
      { id: 3, createdAt: "2026-05-12T00:00:02Z", body: "**Accepted** — reply", author: { login: "idd-bot" } },
      { id: 4, createdAt: "2026-05-12T00:00:03Z", body: "third", author: { login: "reviewer-c" } },
    ],
    { iddAgentLogins: ["idd-bot"] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(summary.items.map((item) => item.id), ["4"]);
});

test("regular comment gate keeps same-second comments when no strictly later IDD reply exists", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      { id: 1, createdAt: "2026-05-12T00:00:00Z", body: "first", author: { login: "reviewer-a" } },
      { id: 2, createdAt: "2026-05-12T00:00:00Z", body: "**Accepted** — reply", author: { login: "idd-bot" } },
    ],
    { iddAgentLogins: ["idd-bot"] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(summary.items.map((item) => item.id), ["1"]);
});

test("regular comment gate keeps comments later in the same second as the latest IDD reply", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      { id: 1, createdAt: "2026-05-12T00:00:00Z", body: "**Accepted** — reply", author: { login: "idd-bot" } },
      { id: 2, createdAt: "2026-05-12T00:00:00Z", body: "follow-up", author: { login: "reviewer-a" } },
    ],
    { iddAgentLogins: ["idd-bot"] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(summary.items.map((item) => item.id), ["2"]);
});

test("regular comment gate keeps advisory bot comments after the latest IDD reply", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      { id: 1, createdAt: "2026-05-12T00:00:00Z", body: "first", author: { login: "reviewer-a" } },
      { id: 2, createdAt: "2026-05-12T00:00:01Z", body: "**Accepted** — reply", author: { login: "idd-bot" } },
      { id: 3, createdAt: "2026-05-12T00:00:02Z", body: "please address this bot finding", author: { login: "chatgpt-codex-connector[bot]" } },
    ],
    { iddAgentLogins: ["idd-bot"] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(summary.items.map((item) => item.id), ["3"]);
});

test("regular comment gate reopens comments edited after the latest IDD reply", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: "2026-05-12T00:00:00Z",
        updatedAt: "2026-05-12T00:00:03Z",
        body: "clarified feedback",
        author: { login: "reviewer-a" },
      },
      {
        id: 2,
        createdAt: "2026-05-12T00:00:01Z",
        body: "**Accepted** — reply",
        author: { login: "idd-bot" },
      },
    ],
    { iddAgentLogins: ["idd-bot"] },
  );

  assert.equal(summary.count, 1);
  assert.deepEqual(summary.items.map((item) => item.id), ["1"]);
});

test("regular comment gate skips resolved CodeRabbit summary comments", () => {
  const summary = summarizeRegularCommentsForGate(
    [
      {
        id: 1,
        createdAt: "2026-05-12T00:00:00Z",
        body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\nNo actionable comments were generated.",
        author: { login: "coderabbitai[bot]" },
      },
    ],
    { threads: [] },
  );

  assert.equal(summary.count, 0);
});

test("deriveIddAgentLogins keeps prior trusted operational actors but not generic maintainer comments", () => {
  assert.deepEqual(
    deriveIddAgentLogins({
      viewerLogin: "current-agent",
      iddAgentLogins: ["explicit-agent"],
      trustedMarkerLogins: ["current-agent", "prior-agent", "maintainer"],
      operationalComments: [
        {
          author: { login: "prior-agent" },
          body: "<!-- review-baseline: github-copilot-cli claim-123 abcdefabcdefabcdefabcdefabcdefabcdefabcd -->\n\n_github-copilot-cli: critique baseline — IDD automation marker. Do not edit._",
        },
        {
          author: { login: "maintainer" },
          body: "Please double-check the merge gate before landing this.",
        },
      ],
    }),
    ["current-agent", "explicit-agent", "prior-agent"],
  );
});

test("deriveIddAgentLogins excludes trusted forced-handoff marker authors", () => {
  const forcedHandoffBody = [
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"forced-by\":\"maintainer\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-only\"} -->",
    "",
    "Forced handoff approved by maintainer. I verified that the current",
    "owning session or agent is unavailable. This transfers ownership away",
    "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.",
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");

  assert.deepEqual(
    deriveIddAgentLogins({
      viewerLogin: "current-agent",
      trustedMarkerLogins: ["current-agent", "maintainer"],
      operationalComments: [
        {
          author: { login: "maintainer" },
          body: forcedHandoffBody,
        },
      ],
    }),
    ["current-agent"],
  );
});

test("summarizeClaimValidation follows trusted forced-handoff transitions", () => {
  const claimEvents = [
    {
      body: [
        "<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->",
        "",
        "_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._",
      ].join("\n"),
      createdAt: "2026-05-12T09:00:00Z",
      author: { login: "github-copilot-cli-old" },
    },
    {
      body: [
        "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-only\"} -->",
        "",
        "Forced handoff approved by kurone-kito. I verified that the current",
        "owning session or agent is unavailable. This transfers ownership away",
        "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.",
        "If the prior session resumes, it must stop immediately and must not",
        "push, comment, resolve review state, or merge until a maintainer",
        "reassigns ownership.",
      ].join("\n"),
      createdAt: "2026-05-12T11:00:05Z",
      author: { login: "kurone-kito" },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ["github-copilot-cli-old", "github-copilot-cli-new", "kurone-kito"],
    expectedClaimId: "claim-20260512T110000Z-337-new",
    expectedAgentId: "github-copilot-cli-new",
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, "match");
  assert.equal(summary.activeClaim.claimId, "claim-20260512T110000Z-337-new");
  assert.equal(summary.activeClaim.agentId, "github-copilot-cli-new");
});

test("summarizeClaimValidation rejects forced handoff from unauthorized approver", () => {
  const claimEvents = [
    {
      body: [
        "<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->",
        "",
        "_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._",
      ].join("\n"),
      createdAt: "2026-05-12T09:00:00Z",
      author: { login: "github-copilot-cli-old" },
    },
    {
      body: [
        "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"forced-by\":\"trusted-relay[bot]\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-only\"} -->",
        "",
        "Forced handoff approved by trusted-relay[bot]. I verified that the current",
        "owning session or agent is unavailable. This transfers ownership away",
        "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced`.",
        "If the prior session resumes, it must stop immediately and must not",
        "push, comment, resolve review state, or merge until a maintainer",
        "reassigns ownership.",
      ].join("\n"),
      createdAt: "2026-05-12T11:00:05Z",
      author: { login: "trusted-relay[bot]" },
    },
  ];

  const summary = summarizeClaimValidation(claimEvents, {
    trustedMarkerLogins: ["github-copilot-cli-old", "trusted-relay[bot]"],
    isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    expectedClaimId: "claim-20260512T090000Z-337-old",
    expectedAgentId: "github-copilot-cli-old",
  });

  assert.equal(summary.claimLost, false);
  assert.equal(summary.reason, "match");
  assert.equal(summary.activeClaim.claimId, "claim-20260512T090000Z-337-old");
  assert.equal(summary.activeClaim.agentId, "github-copilot-cli-old");
});

test("advisory wait summary keeps F2 and F3 outcomes distinct when Copilot is no longer pending", () => {
  const summary = buildAdvisoryWaitSummary(
    {
      prHeadSha: "a".repeat(40),
      reviews: [
        {
          author: { login: "copilot-pull-request-reviewer" },
          submittedAt: "2026-05-12T00:00:00Z",
          commitId: "b".repeat(40),
        },
      ],
      requestedReviewers: [],
      timelineEvents: [],
      comments: [],
    },
    {
      now: "2026-05-12T00:10:00Z",
      trustedMarkerLogins: ["idd-bot"],
    },
  );

  assert.equal(summary.outcome, "REQUEST_NEEDED");
  assert.equal(summary.f3Outcome, "SATISFIED");
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
