/**
 * Strict JSON Schema (draft 2020-12 subset) validator.
 *
 * Validates schema files for unsupported keywords, then validates
 * fixture instances against their schemas.
 *
 * Supported enforcement keywords:
 *   type, required, properties, additionalProperties,
 *   minLength, pattern, format (date-time only),
 *   minItems, items, enum
 *
 * Any other keyword in a schema triggers an error, preventing false
 * confidence from silently-ignored constraints.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Keywords accepted as pure annotations (no validation effect). */
const ANNOTATION_KEYWORDS = new Set(["$schema", "$id", "title", "description"]);

/** Keywords this validator actively enforces. */
const ENFORCED_KEYWORDS = new Set([
  "type",
  "required",
  "properties",
  "additionalProperties",
  "minLength",
  "pattern",
  "format",
  "minItems",
  "items",
  "enum",
]);

const ALLOWED_KEYWORDS = new Set([...ANNOTATION_KEYWORDS, ...ENFORCED_KEYWORDS]);

/** Format values this validator actively enforces. */
const SUPPORTED_FORMATS = new Set(["date-time"]);

/**
 * Check that a schema object only uses allowed keywords, recursively.
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]} error messages
 */
export function checkSchemaKeywords(schema, path = "$") {
  if (typeof schema !== "object" || schema === null) return [];
  const errors = [];
  for (const key of Object.keys(schema)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      errors.push(`${path}: unsupported keyword "${key}"`);
    }
  }
  if (schema.format !== undefined && !SUPPORTED_FORMATS.has(schema.format)) {
    errors.push(`${path}: unsupported format value "${schema.format}"`);
  }
  for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
    errors.push(...checkSchemaKeywords(propSchema, `${path}.properties.${prop}`));
  }
  if (schema.items && typeof schema.items === "object") {
    errors.push(...checkSchemaKeywords(schema.items, `${path}.items`));
  }
  if (
    typeof schema.additionalProperties === "object" &&
    schema.additionalProperties !== null
  ) {
    errors.push(
      ...checkSchemaKeywords(schema.additionalProperties, `${path}.additionalProperties`),
    );
  }
  return errors;
}

function getType(val) {
  if (val === null) return "null";
  if (Array.isArray(val)) return "array";
  return typeof val;
}

/**
 * Validate data against a schema (subset enforced by this validator).
 * @param {unknown} data
 * @param {object} schema
 * @param {string} [path]
 * @returns {string[]} error messages — empty array means valid
 */
export function validate(data, schema, path = "$") {
  const errors = [];
  const actualType = getType(data);

  if (schema.type !== undefined && actualType !== schema.type) {
    errors.push(`${path}: expected type "${schema.type}", got "${actualType}"`);
    return errors;
  }

  if (actualType === "string") {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push(`${path}: length ${data.length} < minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      errors.push(`${path}: does not match pattern /${schema.pattern}/`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(data))) {
      errors.push(`${path}: invalid date-time value "${data}"`);
    }
  }

  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    errors.push(`${path}: "${String(data)}" not in enum [${schema.enum.join(", ")}]`);
  }

  if (actualType === "array") {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push(`${path}: array length ${data.length} < minItems ${schema.minItems}`);
    }
    if (schema.items !== undefined) {
      for (let i = 0; i < data.length; i++) {
        errors.push(...validate(data[i], schema.items, `${path}[${i}]`));
      }
    }
  }

  if (actualType === "object") {
    for (const req of schema.required ?? []) {
      if (!(req in data)) {
        errors.push(`${path}: missing required property "${req}"`);
      }
    }
    for (const [prop, propSchema] of Object.entries(schema.properties ?? {})) {
      if (prop in data) {
        errors.push(...validate(data[prop], propSchema, `${path}.${prop}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(data)) {
        if (!allowed.has(key)) {
          errors.push(`${path}: additional property "${key}" not allowed`);
        }
      }
    }
  }

  return errors;
}

/**
 * Load and parse a JSON file by path relative to repository root.
 * @param {string} relPath
 * @returns {unknown}
 */
export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), "utf8"));
}

/**
 * Validate a fixture against its schema.
 * @param {string} schemaPath  path relative to repo root
 * @param {string} fixturePath path relative to repo root
 * @param {boolean} expectValid whether the fixture should be valid
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFixture(schemaPath, fixturePath, expectValid) {
  const schema = loadJson(schemaPath);
  const fixture = loadJson(fixturePath);
  const keyErrors = checkSchemaKeywords(schema);
  if (keyErrors.length > 0) {
    return {
      ok: false,
      errors: [`Schema has unsupported keywords: ${keyErrors.join("; ")}`],
    };
  }
  const errs = validate(fixture, schema);
  const isValid = errs.length === 0;
  if (expectValid && !isValid) return { ok: false, errors: errs };
  if (!expectValid && isValid) {
    return { ok: false, errors: ["Expected validation failure but fixture passed"] };
  }
  return { ok: true, errors: [] };
}

// CLI: run all schemas and fixtures when invoked directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = [
    ["schemas/claim-marker.schema.json", "fixtures/schemas/claim-marker.valid.json", true],
    ["schemas/claim-marker.schema.json", "fixtures/schemas/claim-marker.invalid.json", false],
    ["schemas/live-status-digest.schema.json", "fixtures/schemas/live-status-digest.valid.json", true],
    ["schemas/live-status-digest.schema.json", "fixtures/schemas/live-status-digest.invalid.json", false],
    ["schemas/policy.schema.json", "fixtures/schemas/policy.valid.json", true],
    ["schemas/policy.schema.json", "fixtures/schemas/policy.invalid.json", false],
    ["schemas/phase-graph.schema.json", "fixtures/schemas/phase-graph.valid.json", true],
    ["schemas/phase-graph.schema.json", "fixtures/schemas/phase-graph.invalid.json", false],
    ["schemas/phase-graph.schema.json", "schemas/phase-graph.json", true],
  ];

  let failed = 0;
  for (const [schemaPath, fixturePath, expectValid] of cases) {
    const result = validateFixture(schemaPath, fixturePath, expectValid);
    const label = expectValid ? "valid" : "invalid";
    if (result.ok) {
      console.log(`✓  ${fixturePath} (${label})`);
    } else {
      console.error(`✗  ${fixturePath} (${label}): ${result.errors.join("; ")}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} case(s) failed.`);
    process.exit(1);
  } else {
    console.log("\nAll cases passed.");
  }
}
