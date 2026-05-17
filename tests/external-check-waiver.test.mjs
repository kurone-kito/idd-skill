import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTrustedMarkerLogins,
  extractGhHttpStatus,
  planExternalCheckWaiver,
} from "../scripts/external-check-waiver.mjs";
import { normalizePolicyConfig } from "../scripts/policy-helpers.mjs";
import {
  parseExternalCheckWaiverComment,
  renderExternalCheckWaiverComment,
} from "../scripts/protocol-helpers.mjs";

function buildPolicy() {
  return normalizePolicyConfig({
    ciGate: {
      externalChecks: {
        waivable: [{ selector: "CodeRabbit*", matchMode: "glob" }],
      },
      externalCheckWaivers: {
        mode: "maintainer-authorized",
        authorityPolicy: "owners-and-maintainers-only",
        maxValidity: "PT24H",
      },
    },
  });
}

function buildBaseInput() {
  return {
    repository: "kurone-kito/idd-skill",
    policy: buildPolicy(),
    policySource: ".github/idd/config.json",
    actor: "kurone-kito",
    authority: {
      known: true,
      permission: "admin",
      roleName: "admin",
    },
    pr: {
      number: 671,
      state: "OPEN",
      url: "https://github.com/kurone-kito/idd-skill/pull/671",
      headRefName: "issue/667-add-maintainer-facade-external-check-waivers",
      headRefOid: "a".repeat(40),
      statusCheckRollup: [
        { __typename: "StatusContext", context: "CodeRabbit", state: "PENDING" },
      ],
    },
    issueCandidates: [
      {
        number: 667,
        url: "https://github.com/kurone-kito/idd-skill/issues/667",
        activeClaim: {
          agentId: "codex-cli-7f8f9c0d",
          claimId: "claim-20260517T060713Z-667-7f8f9c0d",
          branch: "issue/667-add-maintainer-facade-external-check-waivers",
          createdAt: "2026-05-17T06:07:26Z",
        },
      },
    ],
    requestedSelector: "CodeRabbit",
    reason: "rate limit",
    expiresAt: "2026-05-17T12:00:00Z",
    repoOwner: "kurone-kito",
  };
}

test("renderExternalCheckWaiverComment round-trips whitespace selectors and reasons", () => {
  const body = renderExternalCheckWaiverComment({
    actor: "kurone-kito",
    agentId: "codex-cli",
    claimId: "claim-123",
    headSha: "a".repeat(40),
    checkSelector: "Copilot code review",
    reason: "rate limit",
    expiresAt: "2026-05-18T00:00:00Z",
  });

  const parsed = parseExternalCheckWaiverComment(body, "2026-05-17T00:00:00Z");
  assert.deepEqual(parsed, {
    agentId: "codex-cli",
    claimId: "claim-123",
    headSha: "a".repeat(40),
    checkSelector: "Copilot code review",
    reason: "rate limit",
    expiresAt: "2026-05-18T00:00:00Z",
    createdAt: "2026-05-17T00:00:00Z",
  });
  assert.match(body, /check:Copilot%20code%20review/);
  assert.match(body, /reason:rate%20limit/);
});

test("planExternalCheckWaiver allows a configured non-passing waivable check", () => {
  const report = planExternalCheckWaiver(
    buildBaseInput(),
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, true);
  assert.equal(report.blockingReasons.length, 0);
  assert.equal(report.linkedIssue?.number, 667);
  assert.equal(report.checks.matched.length, 1);
  assert.match(report.body, /idd-external-check-waiver/);
});

test("planExternalCheckWaiver fails closed when no active linked claim is available", () => {
  const input = buildBaseInput();
  input.issueCandidates = [{ number: 667, url: input.issueCandidates[0].url, activeClaim: null }];

  const report = planExternalCheckWaiver(
    input,
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join("\n"), /active linked issue claim/);
});

test("planExternalCheckWaiver fails closed for unauthorized write-only actors", () => {
  const input = buildBaseInput();
  input.actor = "write-collaborator";
  input.authority = {
    known: true,
    permission: "write",
    roleName: "",
  };

  const report = planExternalCheckWaiver(
    input,
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join("\n"), /not authorized/);
});

test("planExternalCheckWaiver fails closed for non-waivable checks", () => {
  const input = buildBaseInput();
  input.requestedSelector = "lint";
  input.pr.statusCheckRollup = [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
  ];

  const report = planExternalCheckWaiver(
    input,
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join("\n"), /not configured as waivable external checks/);
});

test("planExternalCheckWaiver fails closed when expiry exceeds max validity", () => {
  const input = buildBaseInput();
  input.expiresAt = "2026-05-19T06:00:01Z";

  const report = planExternalCheckWaiver(
    input,
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, false);
  assert.match(report.blockingReasons.join("\n"), /maxValidity/);
});

test("buildTrustedMarkerLogins always trusts the repository owner", () => {
  const trusted = buildTrustedMarkerLogins({
    owner: "repo-owner",
    repo: "example",
    rawConfig: normalizePolicyConfig({}),
    viewerLogin: "maintainer-user",
    issueComments: [],
  });

  assert.ok(trusted.has("repo-owner"));
  assert.ok(trusted.has("maintainer-user"));
});

test("extractGhHttpStatus prefers HTTP status codes from gh stderr", () => {
  assert.equal(
    extractGhHttpStatus({
      status: 1,
      stderr: "gh: definitely-not-a-user is not a user (HTTP 404)\n",
    }),
    404,
  );
  assert.equal(extractGhHttpStatus({ status: 1, stderr: "" }), 1);
  assert.equal(extractGhHttpStatus({ status: 0, stderr: "" }), 0);
});

test("parseExternalCheckWaiverComment returns null for empty or non-marker bodies", () => {
  assert.equal(parseExternalCheckWaiverComment("", "2026-05-17T00:00:00Z"), null);
  assert.equal(parseExternalCheckWaiverComment("some random text", "2026-05-17T00:00:00Z"), null);
  assert.equal(parseExternalCheckWaiverComment("<!-- idd-external-check-waiver: bad-format -->", "2026-05-17T00:00:00Z"), null);
});

test("parseExternalCheckWaiverComment returns null when required fields are missing", () => {
  const truncated = `<!-- idd-external-check-waiver: agent claim-id ${"a".repeat(40)} check:CodeRabbit -->`;
  assert.equal(parseExternalCheckWaiverComment(truncated, "2026-05-17T00:00:00Z"), null);
});

test("planExternalCheckWaiver fails closed when authority lookup returns unknown", () => {
  const input = buildBaseInput();
  input.authority = { known: false };

  const report = planExternalCheckWaiver(
    input,
    { now: new Date("2026-05-17T06:00:00Z"), repoOwner: "kurone-kito" },
  );

  assert.equal(report.canApply, false);
  assert.ok(report.blockingReasons.some((r) => /authority|proven/.test(r)));
});
