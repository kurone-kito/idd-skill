import assert from "node:assert/strict";
import { test } from "node:test";

import { currentIsoTimestamp } from "../scripts/forced-handoff-marker.mjs";
import {
  applyClaimEvent,
  normalizeForcedHandoffPayload,
  parseForcedHandoffComment,
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

test("forced handoff normalization omits createdAt when comment metadata is unavailable", () => {
  const normalized = normalizeForcedHandoffPayload(payload);

  assert.deepEqual(normalized, payload);
});

test("forced handoff helper timestamps stay on whole seconds", () => {
  assert.match(currentIsoTimestamp(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
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
