// idd-generated-from: src/scripts/validate-schemas.mts
//
// The scripts/validate-schemas.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface SchemaNode {
  type?: string;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  minLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  items?: SchemaNode;
  enum?: unknown[];
  [key: string]: unknown;
}

/** Keywords accepted as pure annotations (no validation effect). */
const ANNOTATION_KEYWORDS = new Set(['$schema', '$id', 'title', 'description']);

/** Keywords this validator actively enforces. */
const ENFORCED_KEYWORDS = new Set([
  'type',
  'required',
  'properties',
  'patternProperties',
  'additionalProperties',
  'minLength',
  'minimum',
  'exclusiveMinimum',
  'pattern',
  'format',
  'minItems',
  'items',
  'enum',
]);

const ALLOWED_KEYWORDS = new Set([
  ...ANNOTATION_KEYWORDS,
  ...ENFORCED_KEYWORDS,
]);

/** Format values this validator actively enforces. */
const SUPPORTED_FORMATS = new Set(['date-time']);

/**
 * Check that a schema object only uses allowed keywords, recursively.
 */
export function checkSchemaKeywords(schema: unknown, path = '$'): string[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const s = schema as SchemaNode;
  const errors: string[] = [];
  for (const key of Object.keys(s)) {
    if (!ALLOWED_KEYWORDS.has(key)) {
      errors.push(`${path}: unsupported keyword "${key}"`);
    }
  }
  if (s.format !== undefined && !SUPPORTED_FORMATS.has(s.format)) {
    errors.push(`${path}: unsupported format value "${s.format}"`);
  }
  for (const [prop, propSchema] of Object.entries(s.properties ?? {})) {
    errors.push(
      ...checkSchemaKeywords(propSchema, `${path}.properties.${prop}`),
    );
  }
  for (const [pattern, propSchema] of Object.entries(
    s.patternProperties ?? {},
  )) {
    errors.push(
      ...checkSchemaKeywords(
        propSchema,
        `${path}.patternProperties.${pattern}`,
      ),
    );
  }
  if (s.items && typeof s.items === 'object') {
    errors.push(...checkSchemaKeywords(s.items, `${path}.items`));
  }
  if (
    typeof s.additionalProperties === 'object' &&
    s.additionalProperties !== null
  ) {
    errors.push(
      ...checkSchemaKeywords(
        s.additionalProperties,
        `${path}.additionalProperties`,
      ),
    );
  }
  return errors;
}

function getType(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

/**
 * Validate data against a schema (subset enforced by this validator).
 * Returns error messages — empty array means valid.
 */
export function validate(data: unknown, schema: unknown, path = '$'): string[] {
  const s = schema as SchemaNode;
  const errors: string[] = [];
  const actualType = getType(data);

  if (s.type !== undefined) {
    if (s.type === 'integer') {
      if (actualType !== 'number') {
        errors.push(`${path}: expected type "integer", got "${actualType}"`);
        return errors;
      }
      if (!Number.isInteger(data)) {
        errors.push(
          `${path}: expected type "integer", got non-integer number ${data as number}`,
        );
        return errors;
      }
    } else if (actualType !== s.type) {
      errors.push(`${path}: expected type "${s.type}", got "${actualType}"`);
      return errors;
    }
  }

  if (actualType === 'string') {
    const str = data as string;
    if (s.minLength !== undefined && str.length < s.minLength) {
      errors.push(`${path}: length ${str.length} < minLength ${s.minLength}`);
    }
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(str)) {
      errors.push(`${path}: does not match pattern /${s.pattern}/`);
    }
    if (s.format === 'date-time' && Number.isNaN(Date.parse(str))) {
      errors.push(`${path}: invalid date-time value "${str}"`);
    }
  }

  if (s.enum !== undefined && !s.enum.includes(data)) {
    errors.push(
      `${path}: "${String(data)}" not in enum [${s.enum.join(', ')}]`,
    );
  }

  if (
    actualType === 'number' &&
    s.minimum !== undefined &&
    (data as number) < s.minimum
  ) {
    errors.push(`${path}: ${data as number} < minimum ${s.minimum}`);
  }
  if (
    actualType === 'number' &&
    s.exclusiveMinimum !== undefined &&
    (data as number) <= s.exclusiveMinimum
  ) {
    errors.push(
      `${path}: ${data as number} <= exclusiveMinimum ${s.exclusiveMinimum}`,
    );
  }

  if (actualType === 'array') {
    const arr = data as unknown[];
    if (s.minItems !== undefined && arr.length < s.minItems) {
      errors.push(
        `${path}: array length ${arr.length} < minItems ${s.minItems}`,
      );
    }
    if (s.items !== undefined) {
      for (let i = 0; i < arr.length; i++) {
        errors.push(...validate(arr[i], s.items, `${path}[${i}]`));
      }
    }
  }

  if (actualType === 'object') {
    const obj = data as Record<string, unknown>;
    for (const req of s.required ?? []) {
      if (!(req in obj)) {
        errors.push(`${path}: missing required property "${req}"`);
      }
    }
    for (const [prop, propSchema] of Object.entries(s.properties ?? {})) {
      if (prop in obj) {
        errors.push(...validate(obj[prop], propSchema, `${path}.${prop}`));
      }
    }
    const declaredProperties = s.properties ?? {};
    const compiledPatternSchemas: [RegExp, SchemaNode][] = [];
    for (const [pattern, patternSchema] of Object.entries(
      s.patternProperties ?? {},
    )) {
      try {
        compiledPatternSchemas.push([new RegExp(pattern), patternSchema]);
      } catch {
        errors.push(`${path}: invalid patternProperties regex "${pattern}"`);
      }
    }
    const additionalPropertiesSchema =
      typeof s.additionalProperties === 'object' &&
      s.additionalProperties !== null
        ? s.additionalProperties
        : null;
    for (const key of Object.keys(obj)) {
      const isDeclaredProperty = Object.hasOwn(declaredProperties, key);
      let matchedPattern = false;
      for (const [patternRegex, patternSchema] of compiledPatternSchemas) {
        if (patternRegex.test(key)) {
          matchedPattern = true;
          errors.push(...validate(obj[key], patternSchema, `${path}.${key}`));
        }
      }
      if (isDeclaredProperty || matchedPattern) {
        continue;
      }
      if (s.additionalProperties === false) {
        errors.push(`${path}: additional property "${key}" not allowed`);
        continue;
      }
      if (additionalPropertiesSchema !== null) {
        errors.push(
          ...validate(obj[key], additionalPropertiesSchema, `${path}.${key}`),
        );
      }
    }
  }

  return errors;
}

/**
 * Load and parse a JSON file by path relative to repository root.
 */
export function loadJson(relPath: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

interface PhaseGraphNode {
  id?: unknown;
  next?: unknown;
}

/**
 * Check referential integrity of a phase-graph data object.
 *
 * Verifies that every node referenced in a `next` array exists as a node
 * id within the same graph, and that no node id is duplicated.
 */
export function validatePhaseGraph(data: unknown): string[] {
  const errors: string[] = [];
  const nodes = (data as { nodes?: unknown } | null)?.nodes;
  if (typeof data !== 'object' || data === null || !Array.isArray(nodes)) {
    return errors;
  }
  const graphNodes = nodes as PhaseGraphNode[];
  const nodeIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of graphNodes) {
    if (typeof node.id !== 'string') continue;
    if (nodeIds.has(node.id)) duplicates.add(node.id);
    nodeIds.add(node.id);
  }
  for (const id of duplicates) {
    errors.push(`Duplicate node id: "${id}"`);
  }
  for (const node of graphNodes) {
    for (const target of (node.next ?? []) as unknown[]) {
      if (typeof target !== 'string' || !nodeIds.has(target)) {
        errors.push(
          `Node "${String(node.id)}": next target "${String(target)}" does not exist`,
        );
      }
    }
  }
  return errors;
}

/**
 * Validate a fixture against its schema.
 */
export function validateFixture(
  schemaPath: string,
  fixturePath: string,
  expectValid: boolean,
): { ok: boolean; errors: string[] } {
  const schema = loadJson(schemaPath);
  const fixture = loadJson(fixturePath);
  const keyErrors = checkSchemaKeywords(schema);
  if (keyErrors.length > 0) {
    return {
      ok: false,
      errors: [`Schema has unsupported keywords: ${keyErrors.join('; ')}`],
    };
  }
  const errs = validate(fixture, schema);
  let graphErrors: string[] = [];
  if (schemaPath.endsWith('phase-graph.schema.json') && errs.length === 0) {
    graphErrors = validatePhaseGraph(fixture);
  }
  const allErrors = [...errs, ...graphErrors];
  const isValid = allErrors.length === 0;
  if (expectValid && !isValid) return { ok: false, errors: allErrors };
  if (!expectValid && isValid) {
    return {
      ok: false,
      errors: ['Expected validation failure but fixture passed'],
    };
  }
  return { ok: true, errors: [] };
}

// CLI: run all schemas and fixtures when invoked directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases: [string, string, boolean][] = [
    [
      'schemas/claim-marker.schema.json',
      'fixtures/schemas/claim-marker.valid.json',
      true,
    ],
    [
      'schemas/claim-marker.schema.json',
      'fixtures/schemas/claim-marker.invalid.json',
      false,
    ],
    [
      'schemas/forced-handoff-marker.schema.json',
      'fixtures/schemas/forced-handoff-marker.valid.json',
      true,
    ],
    [
      'schemas/forced-handoff-marker.schema.json',
      'fixtures/schemas/forced-handoff-marker.invalid.json',
      false,
    ],
    [
      'schemas/live-status-digest.schema.json',
      'fixtures/schemas/live-status-digest.valid.json',
      true,
    ],
    [
      'schemas/live-status-digest.schema.json',
      'fixtures/schemas/live-status-digest.invalid.json',
      false,
    ],
    [
      'schemas/advisory-wait-state.schema.json',
      'fixtures/schemas/advisory-wait-state.valid.json',
      true,
    ],
    [
      'schemas/advisory-wait-state.schema.json',
      'fixtures/schemas/advisory-wait-state.invalid.json',
      false,
    ],
    [
      'schemas/pre-merge-readiness.schema.json',
      'fixtures/schemas/pre-merge-readiness.valid.json',
      true,
    ],
    [
      'schemas/pre-merge-readiness.schema.json',
      'fixtures/schemas/pre-merge-readiness.invalid.json',
      false,
    ],
    ['schemas/policy.schema.json', 'fixtures/schemas/policy.valid.json', true],
    [
      'schemas/policy.schema.json',
      'fixtures/schemas/policy.invalid.json',
      false,
    ],
    [
      'schemas/phase-graph.schema.json',
      'fixtures/schemas/phase-graph.valid.json',
      true,
    ],
    [
      'schemas/phase-graph.schema.json',
      'fixtures/schemas/phase-graph.invalid.json',
      false,
    ],
    ['schemas/phase-graph.schema.json', 'schemas/phase-graph.json', true],
  ];

  let failed = 0;
  for (const [schemaPath, fixturePath, expectValid] of cases) {
    const result = validateFixture(schemaPath, fixturePath, expectValid);
    const label = expectValid ? 'valid' : 'invalid';
    if (result.ok) {
      console.log(`✓  ${fixturePath} (${label})`);
    } else {
      console.error(
        `✗  ${fixturePath} (${label}): ${result.errors.join('; ')}`,
      );
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} case(s) failed.`);
    process.exit(1);
  } else {
    console.log('\nAll cases passed.');
  }
}
