import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  createPhaseIdResolver,
  normalizePhaseIdToken,
  resolvePhaseId,
} from "../scripts/phase-id-resolver.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

test("resolves canonical IDs without mutation", () => {
  const result = resolvePhaseId("A4_5");
  assert.equal(result.canonicalPhaseId, "A4_5");
  assert.equal(result.matchedBy, "canonical");
});

test("includes A0 as a canonical phase ID", () => {
  const result = resolvePhaseId("A0");
  assert.equal(result.canonicalPhaseId, "A0");
  assert.equal(result.matchedBy, "canonical");
});

test("resolves dotted and hyphen aliases to canonical IDs", () => {
  assert.equal(resolvePhaseId("A4.5").canonicalPhaseId, "A4_5");
  assert.equal(resolvePhaseId("A4-5").canonicalPhaseId, "A4_5");
});

test("normalization is deterministic across repeated separators", () => {
  assert.equal(normalizePhaseIdToken("  a4...5  "), "A4_5");
  assert.equal(normalizePhaseIdToken("A4---5"), "A4_5");
});

test("throws explicit unknown phase diagnostics for unsupported IDs", () => {
  assert.throws(
    () => resolvePhaseId("Z99"),
    (error) => error && error.code === "unknown_phase_id",
  );
});

test("throws explicit invalid diagnostics for malformed IDs", () => {
  assert.throws(
    () => resolvePhaseId("A4$5"),
    (error) => error && error.code === "invalid_phase_id",
  );
});

test("detects ambiguous alias configuration", () => {
  assert.throws(
    () => createPhaseIdResolver({
      canonicalPhaseIds: ["A4_5", "F2_5"],
      legacyAliases: {
        A4_5: ["X-5"],
        F2_5: ["x-5"],
      },
    }),
    (error) => error && error.code === "ambiguous_alias_configuration",
  );
});

test("CLI prints canonical machine-facing output", () => {
  const output = execFileSync(
    process.execPath,
    [join(REPO_ROOT, "scripts/phase-id-resolver.mjs"), "--phase-id", "A4.5"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.canonicalPhaseId, "A4_5");
  assert.equal(parsed.matchedBy, "legacy-alias");
});
