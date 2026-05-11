import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAdvisoryWaitSummary,
  classifyCiChecks,
  operationalMarkerPrefix,
  unsafeTextReason,
} from "../scripts/protocol-helpers.mjs";
import { loadJson, validate } from "../scripts/validate-schemas.mjs";

const ciSuccess = readJson("fixtures/ci/success.json");
const ciPending = readJson("fixtures/ci/pending.json");
const ciFailed = readJson("fixtures/ci/failed.json");
const ciMixed = readJson("fixtures/ci/mixed.json");
const ciSkippedNeutral = readJson("fixtures/ci/skipped-neutral.json");
const advisoryWaitSchema = loadJson("schemas/advisory-wait-state.schema.json");

test("classifies CI check states for advisory wait decisions", () => {
  assert.equal(classifyCiChecks(ciSuccess).status, "success");
  assert.equal(classifyCiChecks(ciPending).status, "pending");
  assert.equal(classifyCiChecks(ciFailed).status, "failed");
  assert.equal(classifyCiChecks(ciMixed).status, "unknown");
  assert.equal(classifyCiChecks(ciSkippedNeutral).status, "success");
});

test("detects operational marker prefixes", () => {
  assert.equal(
    operationalMarkerPrefix("<!-- review-watermark: agent claim sha 2026-05-09T00:00:00Z 0 none -->\n\n_foo: review triage snapshot — IDD automation marker. Do not edit._"),
    "<!-- review-watermark:",
  );
  assert.equal(
    operationalMarkerPrefix("<!-- review-baseline: agent claim sha -->\n\n_foo: critique baseline — IDD automation marker. Do not edit._"),
    "<!-- review-baseline:",
  );
  assert.equal(
    operationalMarkerPrefix("advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z"),
    "advisory-wait:",
  );
  assert.equal(
    operationalMarkerPrefix("  advisory-wait: agent 0123456789abcdef0123456789abcdef01234567 2026-05-09T00:00:00Z"),
    null,
  );
});

test("flags unsafe text reasons for failed states", () => {
  assert.equal(unsafeTextReason("CI failure is blocking merge"), "contains failed-CI context");
  assert.equal(unsafeTextReason("The failed checks need attention"), "contains failed-CI context");
  assert.equal(unsafeTextReason("SUCCESS"), null);
});

for (const fixtureName of [
  "satisfied",
  "request-needed",
  "recovery-needed",
  "cap-exhausted",
  "wait",
  "untrusted-marker",
  "pending-covers-head-force-push",
  "recovery-markers-excluded",
]) {
  test(`advisory wait fixture: ${fixtureName}`, () => {
    const fixture = readJson(`fixtures/advisory-wait/${fixtureName}.json`);
    const { input, expected } = fixture;
    const summary = buildAdvisoryWaitSummary(
      {
        prHeadSha: input.prHeadSha,
        reviews: input.reviews,
        requestedReviewers: input.requestedReviewers,
        timelineEvents: input.timelineEvents,
        comments: input.comments,
      },
      {
        now: input.now,
        requestCap: input.requestCap,
        pendingWindowMinutes: input.pendingWindowMinutes,
        settledWindowMinutes: input.settledWindowMinutes,
        trustedMarkerLogins: input.trustedMarkerLogins,
        viewerLogin: input.viewerLogin,
        configuredTrustedActors: input.configuredTrustedActors,
        collaboratorTrustEnabled: input.collaboratorTrustEnabled,
      },
    );

    assert.equal(summary.outcome, expected.outcome);
    assert.equal(summary.lastCopilotCommit, expected.lastCopilotCommit);
    assert.equal(summary.copilotPending, expected.copilotPending);
    assert.equal(summary.copilotPendingCoversHead, expected.copilotPendingCoversHead);
    assert.equal(summary.sameHeadMarkerPresent, expected.sameHeadMarkerPresent);
    assert.equal(summary.sameHeadMarkerCount, expected.sameHeadMarkerCount);
    assert.equal(summary.requestMarkerCount, expected.requestMarkerCount);
    assert.equal(summary.earliestSameHeadAt, expected.earliestSameHeadAt);
    assert.equal(summary.elapsedMinutes, expected.elapsedMinutes);
    assert.equal(
      summary.trustedMarkerSummary.trustedSameHeadMarkerCount,
      expected.trustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedSameHeadMarkerCount,
      expected.untrustedSameHeadMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.trustedRequestMarkerCount,
      expected.trustedRequestMarkerCount,
    );
    assert.equal(
      summary.trustedMarkerSummary.untrustedRequestMarkerCount,
      expected.untrustedRequestMarkerCount,
    );
    assert.deepEqual(validate(summary, advisoryWaitSchema), []);
  });
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
