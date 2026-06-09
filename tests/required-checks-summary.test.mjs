import { strict as assert } from "node:assert";
import { test } from "node:test";

import { summarizeRequiredChecks } from "../scripts/protocol-helpers.mjs";

// A branch ruleset that requires the "lint" status check.
const protectedRules = [
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "lint" }] } },
];

function summarize(checks, rules = []) {
  return summarizeRequiredChecks(checks, rules, {});
}

test("protected branch with passing required checks: required gate passes", () => {
  const r = summarize([{ name: "lint", state: "SUCCESS" }], protectedRules);
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.requiredChecksPassing, true);
});

test("protected branch with a failing required check: gate does not pass", () => {
  const r = summarize([{ name: "lint", state: "FAILURE" }], protectedRules);
  assert.equal(r.noRequiredChecksConfigured, false);
  assert.equal(r.requiredChecksPassing, false);
});

test("unprotected + green runs: reported distinctly from a passing required gate", () => {
  const r = summarize([{ name: "build", state: "SUCCESS" }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.requiredChecksPassing, false);
  assert.equal(r.presentRunConclusion, "all-passing");
});

test("unprotected + a failing run: presentRunConclusion is some-failing", () => {
  const r = summarize([{ name: "build", state: "FAILURE" }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, "some-failing");
});

test("unprotected + no runs: presentRunConclusion is none, never vacuously passing", () => {
  const r = summarize([], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, "none");
  assert.equal(r.requiredChecksPassing, false);
});

test("unprotected + pending runs: presentRunConclusion is pending", () => {
  const r = summarize([{ name: "build", state: "IN_PROGRESS" }], []);
  assert.equal(r.noRequiredChecksConfigured, true);
  assert.equal(r.presentRunConclusion, "pending");
});
