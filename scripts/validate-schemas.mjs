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
 *   minLength, minimum, exclusiveMinimum, pattern, format (date-time, RFC 3339),
 *   minItems, items, enum, oneOf, `$defs`, and constrained local `$ref`
 *
 * Any other keyword in a schema triggers an error, preventing false
 * confidence from silently-ignored constraints.
 */
// #3240: side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. Direct import: this file does not reach cli-args.mts.
// See node-runtime-guard.mts.
import './node-runtime-guard.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';

// Resolve the repository/bundle root via the shared resolveBundleRoot
// (issue #3238): the nearest ancestor containing
// schemas/policy.schema.json, falling back to the nearest ancestor
// containing package.json. This is location-independent, so it returns
// the same root whether this module runs as the emitted
// scripts/validate-schemas.mjs (one level deep), the
// src/scripts/validate-schemas.mts source under Node type-stripping (two
// levels deep), or is imported by another module — a fixed `..` from
// import.meta.dirname would resolve to src/ for the source.
const ROOT = resolveBundleRoot(import.meta.dirname);
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
  '$ref',
  'oneOf',
  '$defs',
]);
const ALLOWED_KEYWORDS = new Set([
  ...ANNOTATION_KEYWORDS,
  ...ENFORCED_KEYWORDS,
]);
/**
 * Format values this validator recognizes. `date-time` is enforced as an RFC 3339 timestamp
 * (see `validate`); `uri` is accepted as a documentation-only annotation that a
 * full JSON Schema validator enforces but this lightweight one does not, so a
 * schema may declare it without tripping the unsupported-format guard.
 */
const SUPPORTED_FORMATS = new Set(['date-time', 'uri']);
/** RFC 3339 `date-time` (section 5.6) with the components captured. */
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
/** Gregorian month length, with the leap-year rule for February. */
function daysInMonth(year, month) {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}
/**
 * True when `value` is an RFC 3339 date-time that names a real instant (#3889).
 * The grammar needs `YYYY-MM-DD`, a `T` or `t`, `hh:mm:ss`, an optional fraction,
 * then `Z`/`z` or a `+hh:mm`/`-hh:mm` offset. The calendar must exist (leap years
 * included), hours must be 0-23, minutes and seconds 0-59, and the offset within
 * 23:59. A leap second (`:60`) is excluded on purpose: the grammar allows one, but
 * `Date.parse` already rejects it and `Date#toISOString`, which every producer here
 * uses, never emits one.
 */
export function isRfc3339DateTime(value) {
  const match = RFC3339_DATE_TIME.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (
    match[7] !== undefined &&
    (Number(match[7]) > 23 || Number(match[8]) > 59)
  ) {
    return false;
  }
  return true;
}
/**
 * Check that a schema object only uses allowed keywords, recursively.
 */
export function checkSchemaKeywords(schema, path = '$', context) {
  return checkSchemaKeywordsWithRefs(schema, path, context, new Set());
}
function checkSchemaKeywordsWithRefs(schema, path, context, activeRefs) {
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
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== 'string') {
      errors.push(`${path}: $ref must be a string`);
    } else if (!context) {
      errors.push(`${path}: cannot resolve $ref without schema source context`);
    } else if (activeRefs.has(s.$ref)) {
      errors.push(`${path}: cyclic $ref "${s.$ref}"`);
    } else {
      const resolved = resolveUserGlobalConfigRef(s.$ref, context);
      if (typeof resolved === 'string') {
        errors.push(`${path}: ${resolved}`);
      } else {
        const nextRefs = new Set(activeRefs);
        nextRefs.add(s.$ref);
        errors.push(
          ...checkSchemaKeywordsWithRefs(
            resolved,
            `${path}.$ref(${s.$ref})`,
            context,
            nextRefs,
          ),
        );
      }
    }
  }
  for (const [name, definition] of Object.entries(s.$defs ?? {})) {
    errors.push(
      ...checkSchemaKeywordsWithRefs(
        definition,
        `${path}.$defs.${name}`,
        context,
        activeRefs,
      ),
    );
  }
  for (const [prop, propSchema] of Object.entries(s.properties ?? {})) {
    errors.push(
      ...checkSchemaKeywordsWithRefs(
        propSchema,
        `${path}.properties.${prop}`,
        context,
        activeRefs,
      ),
    );
  }
  for (const [pattern, propSchema] of Object.entries(
    s.patternProperties ?? {},
  )) {
    errors.push(
      ...checkSchemaKeywordsWithRefs(
        propSchema,
        `${path}.patternProperties.${pattern}`,
        context,
        activeRefs,
      ),
    );
  }
  if (s.items && typeof s.items === 'object') {
    errors.push(
      ...checkSchemaKeywordsWithRefs(
        s.items,
        `${path}.items`,
        context,
        activeRefs,
      ),
    );
  }
  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf) || s.oneOf.length === 0) {
      errors.push(`${path}: oneOf must be a non-empty array of schemas`);
    } else {
      for (let index = 0; index < s.oneOf.length; index += 1) {
        errors.push(
          ...checkSchemaKeywordsWithRefs(
            s.oneOf[index],
            `${path}.oneOf[${index}]`,
            context,
            activeRefs,
          ),
        );
      }
    }
  }
  if (
    typeof s.additionalProperties === 'object' &&
    s.additionalProperties !== null
  ) {
    errors.push(
      ...checkSchemaKeywordsWithRefs(
        s.additionalProperties,
        `${path}.additionalProperties`,
        context,
        activeRefs,
      ),
    );
  }
  return errors;
}
/** Resolve only exact user-global definitions and same-bundle policy refs. */
function resolveUserGlobalConfigRef(reference, context) {
  if (context.schemaPath !== 'schemas/user-global-config.schema.json') {
    return `unsupported $ref source "${context.schemaPath}"`;
  }
  const definitionMatch = /^#\/\$defs\/([A-Za-z0-9_$-]+)$/u.exec(reference);
  if (definitionMatch) {
    const definitionName = definitionMatch[1];
    if (!definitionName) return `unresolved $ref "${reference}"`;
    try {
      const userGlobalSchema = loadJson(context.schemaPath, context.root);
      const definitions = userGlobalSchema.$defs;
      if (!definitions || !Object.hasOwn(definitions, definitionName)) {
        return `unresolved $ref "${reference}"`;
      }
      return definitions[definitionName] ?? `unresolved $ref "${reference}"`;
    } catch (error) {
      return `cannot load local $ref "${reference}": ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (
    !/^policy\.schema\.json#\/properties\/[A-Za-z0-9_$-]+(?:\/properties\/[A-Za-z0-9_$-]+)*$/u.test(
      reference,
    )
  ) {
    return `unsupported or non-local $ref "${reference}"`;
  }
  const pointer = reference.slice('policy.schema.json#/'.length);
  const segments = pointer.split('/');
  try {
    const policySchema = loadJson('schemas/policy.schema.json', context.root);
    let target = policySchema;
    for (let index = 0; index < segments.length; index += 2) {
      const keyword = segments[index];
      const propertyName = segments[index + 1];
      if (
        keyword !== 'properties' ||
        !propertyName ||
        typeof target !== 'object' ||
        target === null ||
        Array.isArray(target)
      ) {
        return `unresolved $ref "${reference}"`;
      }
      const properties = target.properties;
      if (
        typeof properties !== 'object' ||
        properties === null ||
        Array.isArray(properties) ||
        !Object.hasOwn(properties, propertyName)
      ) {
        return `unresolved $ref "${reference}"`;
      }
      target = properties[propertyName];
    }
    return target ?? `unresolved $ref "${reference}"`;
  } catch (error) {
    return `cannot load local $ref "${reference}": ${error instanceof Error ? error.message : String(error)}`;
  }
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
export function validate(
  data,
  schema,
  path = '$',
  context,
  activeRefs = new Set(),
) {
  const s = schema;
  const errors = [];
  const actualType = getType(data);
  if (s.$ref !== undefined) {
    if (typeof s.$ref !== 'string') {
      errors.push(`${path}: $ref must be a string`);
    } else if (!context) {
      errors.push(`${path}: cannot resolve $ref without schema source context`);
    } else if (activeRefs.has(s.$ref)) {
      errors.push(`${path}: cyclic $ref "${s.$ref}"`);
    } else {
      const resolved = resolveUserGlobalConfigRef(s.$ref, context);
      if (typeof resolved === 'string') {
        errors.push(`${path}: ${resolved}`);
      } else {
        const nextRefs = new Set(activeRefs);
        nextRefs.add(s.$ref);
        errors.push(...validate(data, resolved, path, context, nextRefs));
      }
    }
  }
  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf) || s.oneOf.length === 0) {
      errors.push(`${path}: oneOf must be a non-empty array of schemas`);
    } else {
      const matchingBranches = s.oneOf.filter(
        (branch) =>
          validate(data, branch, path, context, activeRefs).length === 0,
      ).length;
      if (matchingBranches !== 1) {
        errors.push(
          `${path}: expected exactly one oneOf branch to match, got ${matchingBranches}`,
        );
      }
    }
  }
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
    if (s.format === 'date-time' && !isRfc3339DateTime(str)) {
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
        errors.push(
          ...validate(arr[i], s.items, `${path}[${i}]`, context, activeRefs),
        );
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
        errors.push(
          ...validate(
            obj[prop],
            propSchema,
            `${path}.${prop}`,
            context,
            activeRefs,
          ),
        );
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
          errors.push(
            ...validate(
              obj[key],
              patternSchema,
              `${path}.${key}`,
              context,
              activeRefs,
            ),
          );
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
          ...validate(
            obj[key],
            additionalPropertiesSchema,
            `${path}.${key}`,
            context,
            activeRefs,
          ),
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
export function validateConfigSection(config, schema, sectionKey, context) {
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
  return validate(obj[sectionKey], sectionSchema, `$.${sectionKey}`, context);
}
/**
 * Load and parse a JSON file by path relative to repository root.
 */
export function loadJson(relPath, root = ROOT) {
  return JSON.parse(readFileSync(join(root, relPath), 'utf8'));
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
export function validateFixture(
  schemaPath,
  fixturePath,
  expectValid,
  root = ROOT,
) {
  const schema = loadJson(schemaPath, root);
  const fixture = loadJson(fixturePath, root);
  const context = { root, schemaPath };
  const keyErrors = checkSchemaKeywords(schema, '$', context);
  if (keyErrors.length > 0) {
    return {
      ok: false,
      errors: [`Schema has unsupported keywords: ${keyErrors.join('; ')}`],
    };
  }
  const errs = validate(fixture, schema, '$', context);
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
/**
 * Live repository instances validated in addition to the discovered
 * `fixtures/schemas/` pairs, each against its own schema:
 *
 * - `schemas/phase-graph.json` is DATA (an instance of
 *   `phase-graph.schema.json`) and also gets the referential-integrity pass
 *   of `validatePhaseGraph` through `validateFixture`'s dedicated hook.
 * - The live hearing catalog is an onboarding-time source artifact, not a
 *   `fixtures/schemas` pair (#2279).
 * - `.github/idd/config.json` is the repository's own policy file (#3751);
 *   its live test used to be the only guard that it still validates.
 */
export const LIVE_INSTANCE_CASES = [
  {
    schemaPath: 'schemas/phase-graph.schema.json',
    fixturePath: 'schemas/phase-graph.json',
    expectValid: true,
  },
  {
    schemaPath: 'schemas/onboarding-hearing-catalog.schema.json',
    fixturePath: 'idd-template/docs/onboarding/hearing-catalog.json',
    expectValid: true,
  },
  {
    schemaPath: 'schemas/policy.schema.json',
    fixturePath: '.github/idd/config.json',
    expectValid: true,
  },
];
function parseCliArguments(argv) {
  let root = null;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a directory path');
      }
      root = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { root, help };
}
/**
 * CLI entry: validates every discovered schema/fixture pair and the live
 * instances in `LIVE_INSTANCE_CASES`. Exit 0 when all cases pass, 1 on any
 * failure or incomplete inspection (an unreadable live file, a schema without
 * its fixture pair, an empty schema inventory), 2 on a usage error.
 * `--root <dir>` inspects another repository tree (used by the fixture tests).
 */
export function runValidateSchemasCli(argv = process.argv.slice(2)) {
  let root;
  try {
    const parsed = parseCliArguments(argv);
    if (parsed.help) {
      console.log(
        'Usage: node scripts/validate-schemas.mjs [--root <repository>] [--help]',
      );
      return 0;
    }
    root = parsed.root ?? ROOT;
  } catch (error) {
    console.error(
      `validate-schemas: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 2;
  }
  let discovered;
  try {
    discovered = discoverSchemaCases(root);
  } catch (error) {
    console.error(
      `✗  schemas: cannot list the schema inventory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const { cases, missing } = discovered;
  if (cases.length === 0 && missing.length === 0) {
    console.error(
      '✗  schemas: no *.schema.json file to validate; an empty inventory would pass vacuously',
    );
    return 1;
  }
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
    return 1;
  }
  let failed = 0;
  for (const { schemaPath, fixturePath, expectValid } of [
    ...cases,
    ...LIVE_INSTANCE_CASES,
  ]) {
    const label = expectValid ? 'valid' : 'invalid';
    let result;
    try {
      result = validateFixture(schemaPath, fixturePath, expectValid, root);
    } catch (error) {
      result = {
        ok: false,
        errors: [
          `cannot read ${schemaPath} or ${fixturePath}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
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
    return 1;
  }
  console.log('\nAll cases passed.');
  return 0;
}
if (import.meta.main) {
  process.exitCode = runValidateSchemasCli();
}
