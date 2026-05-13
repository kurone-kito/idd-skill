import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import {
  currentIsoTimestamp,
  generateSuccessorIds,
  main,
  parsePositiveInteger,
  planHandoff,
  resolveHelperActiveClaim,
} from "../scripts/forced-handoff-marker.mjs";
import {
  applyClaimEvent,
  normalizeForcedHandoffPayload,
  operationalMarkerPrefix,
  operationalMarkerPrefixByStart,
  parseForcedHandoffComment,
  renderForcedHandoffConsentNote,
  renderForcedHandoffComment,
} from "../scripts/protocol-helpers.mjs";

const activeClaim = {
  agentId: "github-copilot-cli-old",
  claimId: "claim-20260512T090000Z-337-old",
  supersedes: "none",
  branch: "issue/337-feat-protocol-add-auditable-forced",
  createdAt: "2026-05-12T09:00:00Z",
};

const payload = {
  oldAgentId: activeClaim.agentId,
  oldClaimId: activeClaim.claimId,
  newAgentId: "github-copilot-cli-new",
  newClaimId: "claim-20260512T110000Z-337-new",
  branch: activeClaim.branch,
  linkedPr: "341",
  forcedBy: "kurone-kito",
  reason: "operator-approved-recovery",
  timestamp: "2026-05-12T11:00:00Z",
  contextScope: "issue-plus-pr",
};

test("forced handoff marker render/parse round-trips through the normalized payload", () => {
  const body = renderForcedHandoffComment(payload);
  const parsed = parseForcedHandoffComment(body, "2026-05-12T11:00:05Z");

  assert.deepEqual(parsed, {
    ...payload,
    createdAt: "2026-05-12T11:00:05Z",
  });
});

test("forced handoff parsing accepts flexible marker spacing and casing", () => {
  const body = [
    "<!--   FORCED-HANDOFF: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"linked-pr\":\"341\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-plus-pr\"} -->",
    "",
    "Forced handoff approved by kurone-kito. I verified that the current",
    "owning session or agent is unavailable. This transfers ownership away",
    "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.",
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");

  assert.deepEqual(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), {
    ...payload,
    createdAt: "2026-05-12T11:00:05Z",
  });
});

test("forced handoff parsing accepts leading whitespace before marker", () => {
  const body = [
    "   ",
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"linked-pr\":\"341\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-plus-pr\"} -->",
    "",
    "Forced handoff approved by kurone-kito. I verified that the current",
    "owning session or agent is unavailable. This transfers ownership away",
    "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.",
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");

  assert.deepEqual(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), {
    ...payload,
    createdAt: "2026-05-12T11:00:05Z",
  });
  assert.equal(operationalMarkerPrefix(body), "<!-- forced-handoff:");
});

test("forced handoff rejects markers without visible consent text", () => {
  const body = [
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-only\"} -->",
    "",
    "<!-- hidden only -->",
  ].join("\n");

  assert.equal(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), null);
});

test("forced handoff rejects notes hidden by unterminated html comment openers", () => {
  const body = [
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-only\"} -->",
    "",
    "<!-- hidden",
  ].join("\n");

  assert.equal(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), null);
});

test("forced handoff start-prefix detection matches flexible marker spelling", () => {
  assert.equal(
    operationalMarkerPrefixByStart(`  ${renderForcedHandoffComment(payload)}`),
    "<!-- forced-handoff:",
  );
  assert.equal(
    operationalMarkerPrefixByStart("  <!--   FORCED-HANDOFF: {\"old-agent-id\":\"a\"} -->"),
    null,
  );
});

test("forced handoff normalization omits createdAt when comment metadata is unavailable", () => {
  const normalized = normalizeForcedHandoffPayload(payload);

  assert.deepEqual(normalized, payload);
});

test("forced handoff helper timestamps stay on whole seconds", () => {
  assert.match(currentIsoTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("forced handoff helper rejects malformed positive integers", () => {
  assert.equal(parsePositiveInteger("123", "--issue"), 123);
  assert.throws(() => parsePositiveInteger("123abc", "--issue"), /invalid --issue value: 123abc/);
});

test("forced handoff helper reports missing numeric flag values clearly", () => {
  assert.throws(() => main(["--issue"]), /missing value for --issue/);
  assert.throws(() => main(["--issue", "337", "--pr"]), /missing value for --pr/);
});

test("forced handoff helper validates --repo format before API calls", () => {
  assert.throws(
    () => main([
      "--issue",
      "337",
      "--new-agent-id",
      "github-copilot-cli-new",
      "--new-claim-id",
      "claim-20260512T110000Z-337-new",
      "--forced-by",
      "kurone-kito",
      "--reason",
      "operator-approved-recovery",
      "--repo",
      "invalid-repo-format",
    ]),
    /invalid --repo value: invalid-repo-format \(expected owner\/name\)/,
  );
});

test("forced handoff helper replays prior handoffs when resolving the active claim", () => {
  const trustedLogins = ["github-copilot-cli-old", "github-copilot-cli-mid", "github-copilot-cli-new", "kurone-kito"];
  const claimBody = [
    "<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->",
    "",
    "_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._",
  ].join("\n");
  const firstHandoff = renderForcedHandoffComment({
    ...payload,
    newAgentId: "github-copilot-cli-mid",
    newClaimId: "claim-20260512T110000Z-337-mid",
  });
  const secondHandoff = renderForcedHandoffComment({
    ...payload,
    oldAgentId: "github-copilot-cli-mid",
    oldClaimId: "claim-20260512T110000Z-337-mid",
    newAgentId: "github-copilot-cli-new",
    newClaimId: "claim-20260512T120000Z-337-next",
    timestamp: "2026-05-12T12:00:00Z",
  });

  const active = resolveHelperActiveClaim(
    [
      {
        body: claimBody,
        created_at: "2026-05-12T09:00:00Z",
        user: { login: "github-copilot-cli-old" },
      },
      {
        body: firstHandoff,
        created_at: "2026-05-12T11:00:05Z",
        user: { login: "github-copilot-cli-mid" },
      },
      {
        body: secondHandoff,
        created_at: "2026-05-12T12:00:05Z",
        user: { login: "github-copilot-cli-new" },
      },
    ],
    trustedLogins,
    {
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(active, {
    agentId: "github-copilot-cli-new",
    claimId: "claim-20260512T120000Z-337-next",
    supersedes: "claim-20260512T110000Z-337-mid",
    branch: "issue/337-feat-protocol-add-auditable-forced",
    createdAt: "2026-05-12T12:00:05Z",
  });
});

test("forced handoff helper keeps PR-scoped active claim when issue-only handoff exists", () => {
  const trustedLogins = ["github-copilot-cli-old", "github-copilot-cli-mid", "github-copilot-cli-new", "kurone-kito"];
  const claimBody = [
    "<!-- claimed-by: github-copilot-cli-old claim-20260512T090000Z-337-old supersedes: none 2026-05-12T09:00:00Z branch: issue/337-feat-protocol-add-auditable-forced -->",
    "",
    "_github-copilot-cli-old: issue claim - IDD automation marker. Do not edit._",
  ].join("\n");
  const issueOnlyHandoff = renderForcedHandoffComment({
    oldAgentId: "github-copilot-cli-old",
    oldClaimId: "claim-20260512T090000Z-337-old",
    newAgentId: "github-copilot-cli-mid",
    newClaimId: "claim-20260512T110000Z-337-mid",
    branch: "issue/337-feat-protocol-add-auditable-forced",
    forcedBy: "kurone-kito",
    reason: "operator-approved-recovery",
    timestamp: "2026-05-12T11:00:00Z",
    contextScope: "issue-only",
  });

  const active = resolveHelperActiveClaim(
    [
      {
        body: claimBody,
        created_at: "2026-05-12T09:00:00Z",
        user: { login: "github-copilot-cli-old" },
      },
      {
        body: issueOnlyHandoff,
        created_at: "2026-05-12T11:00:05Z",
        user: { login: "github-copilot-cli-mid" },
      },
    ],
    trustedLogins,
    {
      expectedLinkedPrs: ["359", "https://github.com/kurone-kito/idd-skill/pull/359"],
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.equal(active?.claimId, "claim-20260512T090000Z-337-old");
  assert.equal(active?.agentId, "github-copilot-cli-old");
});

test("forced handoff helper refuses output when forced-handoff mode is disabled", () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), "idd-forced-handoff-marker-"));
  mkdirSync(join(sandbox, ".github", "idd"), { recursive: true });
  writeFileSync(join(sandbox, ".github", "idd", "config.json"), JSON.stringify({ forcedHandoff: "disabled" }));

  process.chdir(sandbox);
  try {
    assert.throws(
      () => main([
        "--issue",
        "337",
        "--new-agent-id",
        "github-copilot-cli-new",
        "--new-claim-id",
        "claim-20260512T110000Z-337-new",
        "--forced-by",
        "kurone-kito",
        "--reason",
        "operator-approved-recovery",
        "--repo",
        "kurone-kito/idd-skill",
      ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("forced handoff markers are ignored by default when the feature is not enabled", () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(activeClaim, {
    author: { login: "kurone-kito" },
    body,
    createdAt: "2026-05-12T11:00:05Z",
  });

  assert.deepEqual(next, activeClaim);
});

test("forced handoff transfers the active claim when trusted, enabled, and authorized", () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "trusted-relay[bot]" },
      body,
      createdAt: "2026-05-12T11:00:05Z",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, {
    agentId: "github-copilot-cli-new",
    claimId: "claim-20260512T110000Z-337-new",
    supersedes: "claim-20260512T090000Z-337-old",
    branch: "issue/337-feat-protocol-add-auditable-forced",
    createdAt: "2026-05-12T11:00:05Z",
  });
});

test("forced handoff falls back to the active claim timestamp when event metadata is missing", () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "trusted-relay[bot]" },
      body,
      createdAt: "",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, {
    agentId: "github-copilot-cli-new",
    claimId: "claim-20260512T110000Z-337-new",
    supersedes: "claim-20260512T090000Z-337-old",
    branch: "issue/337-feat-protocol-add-auditable-forced",
    createdAt: "2026-05-12T09:00:00Z",
  });
});

test("forced handoff is rejected when the approving actor is unauthorized", () => {
  const body = renderForcedHandoffComment({
    ...payload,
    forcedBy: "unauthorized-user",
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "trusted-relay[bot]" },
      body,
      createdAt: "2026-05-12T11:00:05Z",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, activeClaim);
});

test("forced handoff is rejected when the marker author is untrusted", () => {
  const body = renderForcedHandoffComment(payload);
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "untrusted-user" },
      body,
      createdAt: "2026-05-12T11:00:05Z",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, activeClaim);
});

test("forced handoff requires an exact old-claim match before transferring ownership", () => {
  const body = renderForcedHandoffComment({
    ...payload,
    oldClaimId: "claim-20260512T090000Z-337-other",
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "trusted-relay[bot]" },
      body,
      createdAt: "2026-05-12T11:00:05Z",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, activeClaim);
});

test("forced handoff requires an exact old-agent match before transferring ownership", () => {
  const body = renderForcedHandoffComment({
    ...payload,
    oldAgentId: "github-copilot-cli-other",
  });
  const next = applyClaimEvent(
    activeClaim,
    {
      author: { login: "trusted-relay[bot]" },
      body,
      createdAt: "2026-05-12T11:00:05Z",
    },
    {
      isTrustedAuthor: (login) => login === "trusted-relay[bot]",
      isForcedHandoffEnabled: () => true,
      isAuthorizedForcedHandoff: (forcedBy) => forcedBy === "kurone-kito",
    },
  );

  assert.deepEqual(next, activeClaim);
});

test("forced handoff rejects fractional-second timestamps", () => {
  assert.throws(
    () => renderForcedHandoffComment({
      ...payload,
      timestamp: "2026-05-12T11:00:00.123Z",
    }),
    /invalid forced handoff payload/,
  );
});

test("forced handoff rejects marker-breaking token values", () => {
  assert.throws(
    () => renderForcedHandoffComment({
      ...payload,
      forcedBy: "kurone-kito-->",
    }),
    /invalid forced handoff payload/,
  );
});

test("forced handoff rejects multiline reason values", () => {
  const body = [
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"linked-pr\":\"341\",\"forced-by\":\"kurone-kito\",\"reason\":\"line1\\nline2\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-plus-pr\"} -->",
    "",
    "Forced handoff approved by kurone-kito. I verified that the current",
    "owning session or agent is unavailable. This transfers ownership away",
    "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.",
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");

  assert.equal(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), null);
});

test("forced handoff rejects invalid linked PR tokens", () => {
  for (const linkedPr of [
    "0",
    "-1",
    "1.5",
    "not-a-pr",
    "ftp://example.test/pr/341",
    "HTTP://github.com/kurone-kito/idd-skill/pull/359",
    "<!--hidden",
  ]) {
    assert.throws(
      () => renderForcedHandoffComment({
        ...payload,
        linkedPr,
      }),
      /invalid forced handoff payload/,
      linkedPr,
    );
  }
});

test("forced handoff accepts PR URLs in linked PR scope", () => {
  for (const linkedPr of [
    "https://github.com/kurone-kito/idd-skill/pull/359",
    "http://github.com/kurone-kito/idd-skill/pull/359",
  ]) {
    const body = renderForcedHandoffComment({
      ...payload,
      linkedPr,
    });

    assert.deepEqual(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), {
      ...payload,
      linkedPr,
      createdAt: "2026-05-12T11:00:05Z",
    });
  }
});

test("forced handoff consent note keeps URL PR references unprefixed", () => {
  assert.match(
    renderForcedHandoffConsentNote({
      ...payload,
      linkedPr: "https://github.com/kurone-kito/idd-skill/pull/359",
    }),
    /for PR https:\/\/github\.com\/kurone-kito\/idd-skill\/pull\/359\./,
  );
});

test("forced handoff rejects conflicting alias keys", () => {
  const body = [
    "<!-- forced-handoff: {\"old-agent-id\":\"github-copilot-cli-old\",\"oldAgentId\":\"github-copilot-cli-other\",\"old-claim-id\":\"claim-20260512T090000Z-337-old\",\"new-agent-id\":\"github-copilot-cli-new\",\"new-claim-id\":\"claim-20260512T110000Z-337-new\",\"branch\":\"issue/337-feat-protocol-add-auditable-forced\",\"linked-pr\":\"341\",\"forced-by\":\"kurone-kito\",\"reason\":\"operator-approved-recovery\",\"timestamp\":\"2026-05-12T11:00:00Z\",\"context-scope\":\"issue-plus-pr\"} -->",
    "",
    "Forced handoff approved by kurone-kito. I verified that the current",
    "owning session or agent is unavailable. This transfers ownership away",
    "from claim `claim-20260512T090000Z-337-old` on branch `issue/337-feat-protocol-add-auditable-forced` for PR #341.",
    "If the prior session resumes, it must stop immediately and must not",
    "push, comment, resolve review state, or merge until a maintainer",
    "reassigns ownership.",
  ].join("\n");

  assert.equal(parseForcedHandoffComment(body, "2026-05-12T11:00:05Z"), null);
});

test("nested forcedHandoff.mode key enables human-gated mode", () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), "idd-forced-handoff-marker-"));
  mkdirSync(join(sandbox, ".github", "idd"), { recursive: true });
  writeFileSync(
    join(sandbox, ".github", "idd", "config.json"),
    JSON.stringify({ forcedHandoff: { mode: "human-gated" } }),
  );

  process.chdir(sandbox);
  try {
    // With human-gated mode the tool passes the mode check and proceeds to
    // make GitHub API calls. We only verify the mode is read correctly — i.e.,
    // the mode-disabled error is NOT thrown. Other errors (API access, missing
    // collaborators) are acceptable in a sandboxed test environment.
    let modeError = false;
    try {
      main([
        "--issue",
        "337",
        "--new-agent-id",
        "github-copilot-cli-new",
        "--new-claim-id",
        "claim-20260512T110000Z-337-new",
        "--forced-by",
        "kurone-kito",
        "--reason",
        "operator-approved-recovery",
        "--repo",
        "kurone-kito/idd-skill",
      ]);
    } catch (err) {
      if (/forced-handoff mode is not human-gated/.test(String(err.message))) {
        modeError = true;
      }
    }
    assert.ok(!modeError, "nested forcedHandoff.mode should not trigger mode-disabled error");
  } finally {
    process.chdir(originalCwd);
  }
});

test("nested forcedHandoff.mode=disabled refuses output", () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), "idd-forced-handoff-marker-"));
  mkdirSync(join(sandbox, ".github", "idd"), { recursive: true });
  writeFileSync(
    join(sandbox, ".github", "idd", "config.json"),
    JSON.stringify({ forcedHandoff: { mode: "disabled" } }),
  );

  process.chdir(sandbox);
  try {
    assert.throws(
      () =>
        main([
          "--issue",
          "337",
          "--new-agent-id",
          "github-copilot-cli-new",
          "--new-claim-id",
          "claim-20260512T110000Z-337-new",
          "--forced-by",
          "kurone-kito",
          "--reason",
          "operator-approved-recovery",
          "--repo",
          "kurone-kito/idd-skill",
        ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});

test("planHandoff and generateSuccessorIds — integration fixture", () => {
  const planClaimBody = [
    "<!-- claimed-by: github-copilot-cli-old claim-plan-test-old supersedes: none 2026-05-13T10:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->",
    "",
    "_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._",
  ].join("\n");

  const issueComments = [
    {
      body: planClaimBody,
      created_at: "2026-05-13T10:00:00Z",
      user: { login: "kurone-kito" },
    },
  ];

  const trustedLogins = ["kurone-kito", "github-copilot-cli-old"];

  const resultIssueOnly = planHandoff(issueComments, [], {
    trustedMarkerLogins: trustedLogins,
    forcedBy: "kurone-kito",
    reason: "operator-approved-recovery",
  });

  assert.equal(resultIssueOnly.contextScope, "issue-only");
  assert.deepEqual(resultIssueOnly.prReferences, []);
  assert.equal(resultIssueOnly.branch, "issue/496-feat-force-handoff-derive-live-pr");
  assert.ok(resultIssueOnly.markerBody.includes("issue-only"), "marker body should contain context scope");
  assert.ok(resultIssueOnly.successorIds.newAgentId, "newAgentId should be non-empty");
  assert.ok(resultIssueOnly.successorIds.newClaimId, "newClaimId should be non-empty");

  const linkedPrs = [
    { number: 501, headRefName: "issue/496-feat-force-handoff-derive-live-pr" },
  ];

  const resultWithPr = planHandoff(issueComments, linkedPrs, {
    trustedMarkerLogins: trustedLogins,
    forcedBy: "kurone-kito",
    reason: "operator-approved-recovery",
  });

  assert.equal(resultWithPr.contextScope, "issue-plus-pr");
  assert.deepEqual(resultWithPr.prReferences, ["501"]);
  assert.ok(resultWithPr.markerBody.includes("issue-plus-pr"), "marker body should contain context scope");
  assert.ok(resultWithPr.markerBody.includes('"linked-pr":"501"'), "marker body should contain linked PR");

  assert.throws(
    () =>
      planHandoff(issueComments, linkedPrs, {
        prNumber: 999,
        trustedMarkerLogins: trustedLogins,
        forcedBy: "kurone-kito",
        reason: "operator-approved-recovery",
      }),
    /PR #999 does not match any open PR on claim branch issue\/496-feat-force-handoff-derive-live-pr/,
  );

  const ids1 = generateSuccessorIds("test-agent");
  const ids2 = generateSuccessorIds("test-agent");

  assert.ok(ids1.newAgentId, "newAgentId should be non-empty");
  assert.ok(ids1.newClaimId, "newClaimId should be non-empty");
  assert.notEqual(ids1.newClaimId, ids2.newClaimId, "claim IDs should differ across calls");
  assert.equal(ids1.newAgentId, "test-agent");
  assert.match(ids1.newClaimId, /^claim-[0-9a-f]{16}$/);
});

test("planHandoff omits markerBody when forcedBy actor is not authorized", () => {
  const planClaimBody = [
    "<!-- claimed-by: github-copilot-cli-old claim-plan-test-old supersedes: none 2026-05-13T10:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->",
    "",
    "_github-copilot-cli-old: issue claim — IDD automation marker. Do not edit._",
  ].join("\n");

  const issueComments = [
    {
      body: planClaimBody,
      created_at: "2026-05-13T10:00:00Z",
      user: { login: "kurone-kito" },
    },
  ];

  const result = planHandoff(issueComments, [], {
    trustedMarkerLogins: ["kurone-kito", "github-copilot-cli-old"],
    forcedBy: "unauthorized-actor",
    reason: "operator-approved-recovery",
    isAuthorizedForcedHandoff: (actor) => actor === "kurone-kito",
  });

  assert.equal(result.markerBody, null, "markerBody should be null for unauthorized forcedBy");
  assert.equal(result.contextScope, "issue-only");
  assert.ok(result.successorIds.newAgentId, "successorIds should still be generated");
});

test("planHandoff rejects prior issue-only handoff when PR is present (PR-scoped claim replay)", () => {
  const claimBody = [
    "<!-- claimed-by: agent-a claim-a-original supersedes: none 2026-05-13T09:00:00Z branch: issue/496-feat-force-handoff-derive-live-pr -->",
    "",
    "_agent-a: issue claim — IDD automation marker. Do not edit._",
  ].join("\n");
  const issueOnlyHandoff = renderForcedHandoffComment({
    oldAgentId: "agent-a",
    oldClaimId: "claim-a-original",
    newAgentId: "agent-b",
    newClaimId: "claim-b-handoff",
    branch: "issue/496-feat-force-handoff-derive-live-pr",
    forcedBy: "kurone-kito",
    reason: "operator-approved-recovery",
    timestamp: "2026-05-13T11:00:00Z",
    contextScope: "issue-only",
  });

  const issueComments = [
    {
      body: claimBody,
      created_at: "2026-05-13T09:00:00Z",
      user: { login: "kurone-kito" },
    },
    {
      body: issueOnlyHandoff,
      created_at: "2026-05-13T11:00:05Z",
      user: { login: "kurone-kito" },
    },
  ];

  const linkedPrs = [
    { number: 501, headRefName: "issue/496-feat-force-handoff-derive-live-pr" },
  ];

  const result = planHandoff(issueComments, linkedPrs, {
    trustedMarkerLogins: ["kurone-kito", "agent-a", "agent-b"],
    isAuthorizedForcedHandoff: (actor) => actor === "kurone-kito",
    forcedBy: "kurone-kito",
    reason: "operator-approved-recovery",
  });

  assert.equal(result.contextScope, "issue-plus-pr");
  // With PR-scoped second pass, the issue-only handoff is rejected and
  // the original claim (agent-a) remains the active PR-scope authority.
  assert.equal(result.activeClaim.agentId, "agent-a");
  assert.equal(result.activeClaim.claimId, "claim-a-original");
});

test("forcedHandoff.mode defaults to disabled when key is absent", () => {
  const originalCwd = process.cwd();
  const sandbox = mkdtempSync(join(tmpdir(), "idd-forced-handoff-marker-"));
  mkdirSync(join(sandbox, ".github", "idd"), { recursive: true });
  writeFileSync(
    join(sandbox, ".github", "idd", "config.json"),
    JSON.stringify({ iddVersion: "1.0.0" }),
  );

  process.chdir(sandbox);
  try {
    assert.throws(
      () =>
        main([
          "--issue",
          "337",
          "--new-agent-id",
          "github-copilot-cli-new",
          "--new-claim-id",
          "claim-20260512T110000Z-337-new",
          "--forced-by",
          "kurone-kito",
          "--reason",
          "operator-approved-recovery",
          "--repo",
          "kurone-kito/idd-skill",
        ]),
      /forced-handoff mode is not human-gated; marker generation is disabled/,
    );
  } finally {
    process.chdir(originalCwd);
  }
});
