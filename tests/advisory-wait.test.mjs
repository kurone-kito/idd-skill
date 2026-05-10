import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCiChecks,
  operationalMarkerPrefix,
  unsafeTextReason,
} from "../scripts/protocol-helpers.mjs";

const ciSuccess = readJson("fixtures/ci/success.json");
const ciPending = readJson("fixtures/ci/pending.json");
const ciFailed = readJson("fixtures/ci/failed.json");
const ciMixed = readJson("fixtures/ci/mixed.json");
const ciSkippedNeutral = readJson("fixtures/ci/skipped-neutral.json");

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
});

test("flags unsafe text reasons for failed states", () => {
  assert.equal(unsafeTextReason("CI failure is blocking merge"), "contains failed-CI context");
  assert.equal(unsafeTextReason("The failed checks need attention"), "contains failed-CI context");
  assert.equal(unsafeTextReason("SUCCESS"), null);
});

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
}
