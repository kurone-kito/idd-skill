import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  checkSchemaKeywords,
  loadJson,
  validate,
  validateFixture,
} from "../scripts/validate-schemas.mjs";
import { parseClaimComment } from "../scripts/protocol-helpers.mjs";

// ---------------------------------------------------------------------------
// Schema keyword hygiene — no unsupported keywords allowed
// ---------------------------------------------------------------------------

test("claim-marker schema uses only allowed keywords", () => {
  const schema = loadJson("schemas/claim-marker.schema.json");
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test("live-status-digest schema uses only allowed keywords", () => {
  const schema = loadJson("schemas/live-status-digest.schema.json");
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test("policy schema uses only allowed keywords", () => {
  const schema = loadJson("schemas/policy.schema.json");
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test("phase-graph schema uses only allowed keywords", () => {
  const schema = loadJson("schemas/phase-graph.schema.json");
  assert.deepEqual(checkSchemaKeywords(schema), []);
});

test("checkSchemaKeywords reports unsupported keywords", () => {
  const badSchema = {
    type: "object",
    anyOf: [{ type: "string" }],
  };
  const errors = checkSchemaKeywords(badSchema);
  assert.ok(errors.length > 0, "Expected at least one error");
  assert.ok(errors[0].includes("anyOf"), `Expected 'anyOf' in error: ${errors[0]}`);
});

// ---------------------------------------------------------------------------
// Fixture validation — valid fixtures must pass, invalid must fail
// ---------------------------------------------------------------------------

test("claim-marker valid fixture passes validation", () => {
  const { ok, errors } = validateFixture(
    "schemas/claim-marker.schema.json",
    "fixtures/schemas/claim-marker.valid.json",
    true,
  );
  assert.ok(ok, errors.join("\n"));
});

test("claim-marker invalid fixture fails validation", () => {
  const { ok } = validateFixture(
    "schemas/claim-marker.schema.json",
    "fixtures/schemas/claim-marker.invalid.json",
    false,
  );
  assert.ok(ok, "Expected invalid fixture to fail schema validation");
});

test("live-status-digest valid fixture passes validation", () => {
  const { ok, errors } = validateFixture(
    "schemas/live-status-digest.schema.json",
    "fixtures/schemas/live-status-digest.valid.json",
    true,
  );
  assert.ok(ok, errors.join("\n"));
});

test("live-status-digest invalid fixture fails validation", () => {
  const { ok } = validateFixture(
    "schemas/live-status-digest.schema.json",
    "fixtures/schemas/live-status-digest.invalid.json",
    false,
  );
  assert.ok(ok, "Expected invalid fixture to fail schema validation");
});

test("policy valid fixture passes validation", () => {
  const { ok, errors } = validateFixture(
    "schemas/policy.schema.json",
    "fixtures/schemas/policy.valid.json",
    true,
  );
  assert.ok(ok, errors.join("\n"));
});

test("policy invalid fixture fails validation", () => {
  const { ok } = validateFixture(
    "schemas/policy.schema.json",
    "fixtures/schemas/policy.invalid.json",
    false,
  );
  assert.ok(ok, "Expected invalid fixture to fail schema validation");
});

test("phase-graph valid fixture passes validation", () => {
  const { ok, errors } = validateFixture(
    "schemas/phase-graph.schema.json",
    "fixtures/schemas/phase-graph.valid.json",
    true,
  );
  assert.ok(ok, errors.join("\n"));
});

test("phase-graph invalid fixture fails validation", () => {
  const { ok } = validateFixture(
    "schemas/phase-graph.schema.json",
    "fixtures/schemas/phase-graph.invalid.json",
    false,
  );
  assert.ok(ok, "Expected invalid fixture to fail schema validation");
});

test("phase-graph.json data validates against phase-graph schema", () => {
  const { ok, errors } = validateFixture(
    "schemas/phase-graph.schema.json",
    "schemas/phase-graph.json",
    true,
  );
  assert.ok(ok, errors.join("\n"));
});

// ---------------------------------------------------------------------------
// Runtime / schema drift prevention
// ---------------------------------------------------------------------------

test("protocol-helpers parseClaimComment output matches claim-marker schema", () => {
  const body = readFileSync(
    new URL("../fixtures/issue-comments/active-claim.md", import.meta.url),
    "utf8",
  );
  const parsed = parseClaimComment(body, "2026-05-09T10:00:00Z");
  assert.ok(parsed !== null, "parseClaimComment returned null");

  const schema = loadJson("schemas/claim-marker.schema.json");
  const errors = validate(parsed, schema);
  assert.deepEqual(errors, [], `Schema/runtime drift detected:\n${errors.join("\n")}`);
});
