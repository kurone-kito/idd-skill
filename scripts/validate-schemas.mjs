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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repository root by walking up to the nearest package.json.
// This is location-independent, so it returns the same root whether this
// module runs as the emitted scripts/validate-schemas.mjs (one level
// deep), the src/scripts/validate-schemas.mts source under Node
// type-stripping (two levels deep), or is imported by another module —
// a fixed `..` from import.meta.url would resolve to src/ for the source.
function resolveRepoRoot(fromUrl) {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let depth = 0; depth < 16; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return dir;
}
const ROOT = resolveRepoRoot(import.meta.url);
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
/**
 * Format values this validator recognizes. `date-time` is actively enforced
 * (see `validate`); `uri` is accepted as a documentation-only annotation that a
 * full JSON Schema validator enforces but this lightweight one does not, so a
 * schema may declare it without tripping the unsupported-format guard.
 */
const SUPPORTED_FORMATS = new Set(['date-time', 'uri']);
/**
 * Check that a schema object only uses allowed keywords, recursively.
 */
export function checkSchemaKeywords(schema, path = '$') {
  if (typeof schema !== 'object' || schema === null) return [];
  const s = schema;
  const errors = [];
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
function getType(val) {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}
/**
 * Validate data against a schema (subset enforced by this validator).
 * Returns error messages — empty array means valid.
 */
export function validate(data, schema, path = '$') {
  const s = schema;
  const errors = [];
  const actualType = getType(data);
  if (s.type !== undefined) {
    if (Array.isArray(s.type)) {
      // Union type (e.g. ["string", "null"]): valid when the value matches any
      // listed type, where 'integer' means an integer-valued number.
      const matches = s.type.some((t) =>
        t === 'integer'
          ? actualType === 'number' && Number.isInteger(data)
          : actualType === t,
      );
      if (!matches) {
        errors.push(
          `${path}: expected type "${s.type.join('|')}", got "${actualType}"`,
        );
        return errors;
      }
    } else if (s.type === 'integer') {
      if (actualType !== 'number') {
        errors.push(`${path}: expected type "integer", got "${actualType}"`);
        return errors;
      }
      if (!Number.isInteger(data)) {
        errors.push(
          `${path}: expected type "integer", got non-integer number ${data}`,
        );
        return errors;
      }
    } else if (actualType !== s.type) {
      errors.push(`${path}: expected type "${s.type}", got "${actualType}"`);
      return errors;
    }
  }
  if (actualType === 'string') {
    const str = data;
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
  if (actualType === 'number' && s.minimum !== undefined && data < s.minimum) {
    errors.push(`${path}: ${data} < minimum ${s.minimum}`);
  }
  if (
    actualType === 'number' &&
    s.exclusiveMinimum !== undefined &&
    data <= s.exclusiveMinimum
  ) {
    errors.push(`${path}: ${data} <= exclusiveMinimum ${s.exclusiveMinimum}`);
  }
  if (actualType === 'array') {
    const arr = data;
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
    const obj = data;
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
    const compiledPatternSchemas = [];
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
 * Validate one top-level section of a config document against its own
 * schema node (`schema.properties[sectionKey]`), ignoring errors anywhere
 * else in `config` or `schema`. This is the scoped counterpart to calling
 * `validate(config, schema)` on the whole document: a config-section reader
 * (e.g. `ciWait`, `advisoryWait`) that reverts only its own values to
 * defaults on its own section's error must not be zeroed out by an
 * unrelated top-level key — an unknown property, a missing required field,
 * or a typo'd enum in a sibling section — because that section's own values
 * were never invalid (see #1359).
 *
 * Returns no errors (treats the section as valid) when `config` is not a
 * plain object, `schema` declares no schema for `sectionKey`, or
 * `sectionKey` is absent from `config` — an absent section is valid on its
 * own terms; the caller's own defaults apply.
 */
export function validateConfigSection(config, schema, sectionKey) {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [];
  }
  const sectionSchema = schema?.properties?.[sectionKey];
  if (sectionSchema === undefined) {
    return [];
  }
  const obj = config;
  if (!Object.hasOwn(obj, sectionKey)) {
    return [];
  }
  return validate(obj[sectionKey], sectionSchema, `$.${sectionKey}`);
}
/**
 * Load and parse a JSON file by path relative to repository root.
 */
export function loadJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}
/**
 * Check referential integrity of a phase-graph data object.
 *
 * Verifies that every node referenced in a `next` array exists as a node
 * id within the same graph, and that no node id is duplicated.
 */
export function validatePhaseGraph(data) {
  const errors = [];
  const nodes = data?.nodes;
  if (typeof data !== 'object' || data === null || !Array.isArray(nodes)) {
    return errors;
  }
  const graphNodes = nodes;
  const nodeIds = new Set();
  const duplicates = new Set();
  for (const node of graphNodes) {
    if (typeof node.id !== 'string') continue;
    if (nodeIds.has(node.id)) duplicates.add(node.id);
    nodeIds.add(node.id);
  }
  for (const id of duplicates) {
    errors.push(`Duplicate node id: "${id}"`);
  }
  for (const node of graphNodes) {
    for (const target of node.next ?? []) {
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
export function validateFixture(schemaPath, fixturePath, expectValid) {
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
  let graphErrors = [];
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
/**
 * Auto-discover schema/fixture validation cases under `root`: every
 * `schemas/*.schema.json` is paired with `fixtures/schemas/<name>.valid.json`
 * (expect-pass) and `<name>.invalid.json` (expect-fail). A schema missing
 * either fixture is reported in `missing` rather than silently skipped, so the
 * CLI can fail closed and a new schema cannot slip through unvalidated. Pure
 * over the filesystem (globs and stats only), so it is unit-testable.
 */
export function discoverSchemaCases(root) {
  const schemaFiles = readdirSync(join(root, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .sort();
  const cases = [];
  const missing = [];
  for (const file of schemaFiles) {
    const name = file.slice(0, -'.schema.json'.length);
    const schemaPath = `schemas/${file}`;
    const validFixture = `fixtures/schemas/${name}.valid.json`;
    const invalidFixture = `fixtures/schemas/${name}.invalid.json`;
    const missingFixtures = [];
    if (!existsSync(join(root, validFixture))) {
      missingFixtures.push(validFixture);
    }
    if (!existsSync(join(root, invalidFixture))) {
      missingFixtures.push(invalidFixture);
    }
    if (missingFixtures.length > 0) {
      missing.push({ schema: schemaPath, missingFixtures });
      continue;
    }
    cases.push({ schemaPath, fixturePath: validFixture, expectValid: true });
    cases.push({
      schemaPath,
      fixturePath: invalidFixture,
      expectValid: false,
    });
  }
  return { cases, missing };
}
// CLI: run all schemas and fixtures when invoked directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { cases, missing } = discoverSchemaCases(ROOT);
  if (missing.length > 0) {
    for (const entry of missing) {
      console.error(
        `✗  ${entry.schema}: missing fixture(s) ${entry.missingFixtures.join(', ')}`,
      );
    }
    console.error(
      `\n${missing.length} schema(s) have no fixtures. Add ` +
        `fixtures/schemas/<name>.valid.json and <name>.invalid.json for each.`,
    );
    process.exit(1);
  }
  // phase-graph additionally validates its live data file (referential
  // integrity via validateFixture's dedicated validatePhaseGraph hook) as an
  // explicit override beyond the discovered valid/invalid fixture pair.
  cases.push({
    schemaPath: 'schemas/phase-graph.schema.json',
    fixturePath: 'schemas/phase-graph.json',
    expectValid: true,
  });
  let failed = 0;
  for (const { schemaPath, fixturePath, expectValid } of cases) {
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
