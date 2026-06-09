import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveTrustedMarkerActors } from "../scripts/protocol-helpers.mjs";

test("resolveTrustedMarkerActors: config.json is the default source", () => {
  const result = resolveTrustedMarkerActors({
    flagValue: "",
    envValue: "",
    config: { trustedMarkerActors: ["Kurone-Kito", "idd-bot"] },
  });
  assert.deepEqual(result, { actors: ["idd-bot", "kurone-kito"], source: "config" });
});

test("resolveTrustedMarkerActors: env overrides config", () => {
  const result = resolveTrustedMarkerActors({
    flagValue: "",
    envValue: "env-actor",
    config: { trustedMarkerActors: ["config-actor"] },
  });
  assert.deepEqual(result, { actors: ["env-actor"], source: "env" });
});

test("resolveTrustedMarkerActors: flag overrides env and config", () => {
  const result = resolveTrustedMarkerActors({
    flagValue: "flag-actor",
    envValue: "env-actor",
    config: { trustedMarkerActors: ["config-actor"] },
  });
  assert.deepEqual(result, { actors: ["flag-actor"], source: "flag" });
});

test("resolveTrustedMarkerActors: flag wins over env when both are set", () => {
  const result = resolveTrustedMarkerActors({ flagValue: "a,b", envValue: "c", config: null });
  assert.deepEqual(result, { actors: ["a", "b"], source: "flag" });
});

test("resolveTrustedMarkerActors: returns none when nothing is configured", () => {
  assert.deepEqual(
    resolveTrustedMarkerActors({ flagValue: "", envValue: "", config: {} }),
    { actors: [], source: "none" },
  );
  assert.deepEqual(resolveTrustedMarkerActors({}), { actors: [], source: "none" });
});

test("resolveTrustedMarkerActors: normalizes, lowercases, dedups, and sorts", () => {
  const result = resolveTrustedMarkerActors({
    flagValue: " Beta , alpha, Alpha ,",
    config: { trustedMarkerActors: ["ignored"] },
  });
  assert.deepEqual(result, { actors: ["alpha", "beta"], source: "flag" });
});

test("resolveTrustedMarkerActors: accepts array inputs and ignores non-array config", () => {
  assert.deepEqual(
    resolveTrustedMarkerActors({ flagValue: ["x", "Y"] }),
    { actors: ["x", "y"], source: "flag" },
  );
  assert.deepEqual(
    resolveTrustedMarkerActors({ config: { trustedMarkerActors: "not-an-array" } }),
    { actors: [], source: "none" },
  );
});
