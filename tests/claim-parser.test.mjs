import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyClaimEvent,
  isStaleAt,
  parseClaimComment,
  parseReleaseComment,
} from "../scripts/protocol-helpers.mjs";

const fixtures = {
  active: readText("fixtures/issue-comments/active-claim.md"),
  heartbeat: readText("fixtures/issue-comments/heartbeat.md"),
  stale: readText("fixtures/issue-comments/stale-claim.md"),
  superseded: readText("fixtures/issue-comments/superseded-claim.md"),
  release: readText("fixtures/issue-comments/release.md"),
  staleRelease: readText("fixtures/issue-comments/release-stale.md"),
};

test("parses active, stale, and superseded claim comments", () => {
  const active = parseClaimComment(fixtures.active, "2026-05-09T10:00:00Z");
  const stale = parseClaimComment(fixtures.stale, "2026-05-10T11:00:00Z");
  const superseded = parseClaimComment(fixtures.superseded, "2026-05-09T12:00:00Z");

  assert.deepEqual(active, {
    agentId: "codex-cli",
    claimId: "11111111111111111111111111111111",
    supersedes: "none",
    branch: "issue/118-protocol-test-fixtures",
    createdAt: "2026-05-09T10:00:00Z",
  });
  assert.deepEqual(stale, {
    agentId: "codex-cli",
    claimId: "22222222222222222222222222222222",
    supersedes: "11111111111111111111111111111111",
    branch: "issue/118-protocol-test-fixtures",
    createdAt: "2026-05-10T11:00:00Z",
  });
  assert.deepEqual(superseded, {
    agentId: "codex-cli",
    claimId: "33333333333333333333333333333333",
    supersedes: "11111111111111111111111111111111",
    branch: "issue/118-protocol-test-fixtures",
    createdAt: "2026-05-09T12:00:00Z",
  });
});

test("parses the release comment and stale threshold", () => {
  const release = parseReleaseComment(fixtures.release);
  assert.deepEqual(release, {
    agentId: "codex-cli",
    claimId: "11111111111111111111111111111111",
  });
  assert.equal(isStaleAt("2026-05-09T10:00:00Z", "2026-05-10T11:00:00Z"), true);
  assert.equal(isStaleAt("2026-05-09T10:00:00Z", "2026-05-09T23:59:59Z"), false);
});

test("applies claim transitions across heartbeat, takeover, and release", () => {
  const active = parseClaimComment(fixtures.active, "2026-05-09T10:00:00Z");
  const heartbeat = applyClaimEvent(active, {
    body: fixtures.heartbeat,
    createdAt: "2026-05-09T11:00:00Z",
  });
  const ignored = applyClaimEvent(heartbeat, {
    body: fixtures.superseded,
    createdAt: "2026-05-09T12:00:00Z",
  });
  const stale = applyClaimEvent(ignored, {
    body: fixtures.stale,
    createdAt: "2026-05-10T11:00:00Z",
  });
  const ignoredRelease = applyClaimEvent(stale, {
    body: fixtures.release,
    createdAt: "2026-05-10T12:00:00Z",
  });
  const released = applyClaimEvent(stale, {
    body: fixtures.staleRelease,
    createdAt: "2026-05-10T12:30:00Z",
  });

  assert.deepEqual(heartbeat, {
    agentId: "codex-cli",
    claimId: "11111111111111111111111111111111",
    supersedes: "none",
    branch: "issue/118-protocol-test-fixtures",
    createdAt: "2026-05-09T11:00:00Z",
  });
  assert.deepEqual(ignored, heartbeat);
  assert.deepEqual(stale, {
    agentId: "codex-cli",
    claimId: "22222222222222222222222222222222",
    supersedes: "11111111111111111111111111111111",
    branch: "issue/118-protocol-test-fixtures",
    createdAt: "2026-05-10T11:00:00Z",
  });
  assert.deepEqual(ignoredRelease, stale);
  assert.equal(released, null);
});

function readText(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}
