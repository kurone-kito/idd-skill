/**
 * Strict JSON Schema (draft 2020-12 subset) validator.
 *
 * Validates schema files for unsupported keywords, then validates
 * fixture instances against their schemas.
 *
 * Supported enforcement keywords:
 *   type, required, properties, patternProperties, additionalProperties,
 *   minLength, minimum, exclusiveMinimum, pattern, format (date-time only),
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
  "patternProperties",
  "additionalProperties",
  "minLength",
  "minimum",
  "exclusiveMinimum",
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
  for (const [pattern, propSchema] of Object.entries(schema.patternProperties ?? {})) {
    errors.push(...checkSchemaKeywords(propSchema, `${path}.patternProperties.${pattern}`));
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

  if (schema.type !== undefined) {
    if (schema.type === "integer") {
      if (actualType !== "number") {
        errors.push(`${path}: expected type "integer", got "${actualType}"`);
        return errors;
      }
      if (!Number.isInteger(data)) {
        errors.push(`${path}: expected type "integer", got non-integer number ${data}`);
        return errors;
      }
    } else if (actualType !== schema.type) {
      errors.push(`${path}: expected type "${schema.type}", got "${actualType}"`);
      return errors;
    }
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

  if (actualType === "number" && schema.minimum !== undefined && data < schema.minimum) {
    errors.push(`${path}: ${data} < minimum ${schema.minimum}`);
  }
  if (actualType === "number" && schema.exclusiveMinimum !== undefined && data <= schema.exclusiveMinimum) {
    errors.push(`${path}: ${data} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
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
    const declaredProperties = schema.properties ?? {};
    const compiledPatternSchemas = [];
    for (const [pattern, patternSchema] of Object.entries(schema.patternProperties ?? {})) {
      try {
        compiledPatternSchemas.push([new RegExp(pattern), patternSchema]);
      } catch {
        errors.push(`${path}: invalid patternProperties regex "${pattern}"`);
      }
    }
    const additionalPropertiesSchema = (
      typeof schema.additionalProperties === "object" && schema.additionalProperties !== null
    )
      ? schema.additionalProperties
      : null;
    for (const key of Object.keys(data)) {
      const isDeclaredProperty = Object.hasOwn(declaredProperties, key);
      let matchedPattern = false;
      for (const [patternRegex, patternSchema] of compiledPatternSchemas) {
        if (patternRegex.test(key)) {
          matchedPattern = true;
          errors.push(...validate(data[key], patternSchema, `${path}.${key}`));
        }
      }
      if (isDeclaredProperty || matchedPattern) {
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}: additional property "${key}" not allowed`);
        continue;
      }
      if (additionalPropertiesSchema !== null) {
        errors.push(...validate(data[key], additionalPropertiesSchema, `${path}.${key}`));
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
 * Check referential integrity of a phase-graph data object.
 *
 * Verifies that every node referenced in a `next` array exists as a node
 * id within the same graph, and that no node id is duplicated.
 *
 * @param {object} data  parsed phase-graph JSON
 * @returns {string[]} error messages — empty array means valid
 */
export function validatePhaseGraph(data) {
  const errors = [];
  if (typeof data !== "object" || data === null || !Array.isArray(data.nodes)) {
    return errors;
  }
  const nodeIds = new Set();
  const duplicates = new Set();
  for (const node of data.nodes) {
    if (typeof node.id !== "string") continue;
    if (nodeIds.has(node.id)) duplicates.add(node.id);
    nodeIds.add(node.id);
  }
  for (const id of duplicates) {
    errors.push(`Duplicate node id: "${id}"`);
  }
  for (const node of data.nodes) {
    for (const target of node.next ?? []) {
      if (!nodeIds.has(target)) {
        errors.push(`Node "${node.id}": next target "${target}" does not exist`);
      }
    }
  }
  return errors;
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
  let graphErrors = [];
  if (schemaPath.endsWith("phase-graph.schema.json") && errs.length === 0) {
    graphErrors = validatePhaseGraph(fixture);
  }
  const allErrors = [...errs, ...graphErrors];
  const isValid = allErrors.length === 0;
  if (expectValid && !isValid) return { ok: false, errors: allErrors };
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
    ["schemas/forced-handoff-marker.schema.json", "fixtures/schemas/forced-handoff-marker.valid.json", true],
    ["schemas/forced-handoff-marker.schema.json", "fixtures/schemas/forced-handoff-marker.invalid.json", false],
    ["schemas/live-status-digest.schema.json", "fixtures/schemas/live-status-digest.valid.json", true],
    ["schemas/live-status-digest.schema.json", "fixtures/schemas/live-status-digest.invalid.json", false],
    ["schemas/advisory-wait-state.schema.json", "fixtures/schemas/advisory-wait-state.valid.json", true],
    ["schemas/advisory-wait-state.schema.json", "fixtures/schemas/advisory-wait-state.invalid.json", false],
    ["schemas/pre-merge-readiness.schema.json", "fixtures/schemas/pre-merge-readiness.valid.json", true],
    ["schemas/pre-merge-readiness.schema.json", "fixtures/schemas/pre-merge-readiness.invalid.json", false],
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
