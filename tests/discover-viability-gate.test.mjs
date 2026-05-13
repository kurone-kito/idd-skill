import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateA4Viability,
  evaluateDiscoverViability,
} from "../scripts/discover-viability-gate.mjs";

test("passes viability for narrow scope with objective verification and no external coordination", () => {
  const result = evaluateA4Viability({
    number: 1,
    title: "fix helper parser",
    body: `
Single module update in scripts/.
Verification: add unit tests and keep lint + CI green.
`,
    state: "OPEN",
  });

  assert.equal(result.passed, true);
  assert.deepEqual(result.failedCriteria, []);
});

test("fails limited scope for broad cross-cutting work", () => {
  const result = evaluateA4Viability({
    number: 2,
    title: "redesign architecture across multiple subsystems",
    body: "Broad update across many modules with public interface changes. Tests included.",
    state: "OPEN",
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes("limited_scope"));
});

test("fails clear verification when only subjective checks are present", () => {
  const result = evaluateA4Viability({
    number: 3,
    title: "tune UX copy",
    body: "Success is when it looks good and passes maintainer preference review.",
    state: "OPEN",
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes("clear_verification"));
});

test("fails autonomous completion when external coordination is required", () => {
  const result = evaluateA4Viability({
    number: 4,
    title: "wire external approval gate",
    body: "Requires external coordination and maintainer decision before completion.",
    state: "OPEN",
  });

  assert.equal(result.passed, false);
  assert.ok(result.failedCriteria.includes("autonomous_completion"));
});

test("evaluateDiscoverViability groups viable and discarded candidates", async () => {
  const issues = new Map([
    [10, {
      number: 10,
      title: "targeted helper update",
      state: "OPEN",
      body: "single module change with unit tests and ci verification",
    }],
    [11, {
      number: 11,
      title: "cross-cutting redesign",
      state: "OPEN",
      body: "across multiple subsystems and architecture overhaul",
    }],
    [12, {
      number: 12,
      title: "closed issue",
      state: "CLOSED",
      body: "tests",
    }],
  ]);

  const summary = await evaluateDiscoverViability([10, 11, 12, 13], {
    loadIssue: async (number) => issues.get(number) ?? null,
  });

  assert.deepEqual(summary.viable, [{ number: 10, title: "targeted helper update" }]);
  assert.equal(summary.discarded.length, 3);
  assert.equal(summary.summary.total, 4);
  assert.equal(summary.summary.viableCount, 1);
  assert.equal(summary.summary.discardedCount, 3);
  assert.equal(summary.summary.discardedByCriterion.issue_not_found, 1);
  assert.equal(summary.summary.discardedByCriterion.issue_not_open, 1);
  assert.equal(summary.summary.discardedByCriterion.limited_scope, 1);
});
