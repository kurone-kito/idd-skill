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
 *   minLength, minimum, maximum, exclusiveMinimum, pattern, format (date-time, RFC 3339),
 *   minItems, items, enum, oneOf, `$defs`, and constrained local `$ref`
 *
 * Any other keyword in a schema triggers an error, preventing false
 * confidence from silently-ignored constraints.
 */

// #3240: side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. Direct import: this file does not reach cli-args.mts.
// See node-runtime-guard.mts.
import './node-runtime-guard.mts';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mts';

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

// JSON.parse converts number tokens to IEEE-754 values, which can make a
// fractional token such as 9007199254740991.4 look like a safe integer. Keep
// each parsed token beside its containing object so integer validation can
// preserve JSON Schema's mathematical-integer semantics.
const JSON_NUMBER_SOURCES = new WeakMap<object, Map<string, string>>();

export interface ParsedJsonDocument {
  readonly value: unknown;
  readonly rootNumberSource?: string;
}

const PARSED_JSON_DOCUMENTS = new WeakSet<object>();

function clearJsonNumberSource(parent: object, key: PropertyKey): void {
  JSON_NUMBER_SOURCES.get(parent)?.delete(String(key));
}

function trackJsonObject(value: object): object {
  const sources = JSON_NUMBER_SOURCES.get(value);
  if (!sources) return value;

  let proxy: object;
  proxy = new Proxy(value, {
    set(target, property, nextValue, receiver) {
      const succeeded = Reflect.set(target, property, nextValue, receiver);
      if (succeeded && receiver === proxy) {
        clearJsonNumberSource(proxy, property);
      }
      return succeeded;
    },
    defineProperty(target, property, descriptor) {
      const succeeded = Reflect.defineProperty(target, property, descriptor);
      if (
        succeeded &&
        (Object.hasOwn(descriptor, 'value') ||
          Object.hasOwn(descriptor, 'get') ||
          Object.hasOwn(descriptor, 'set'))
      ) {
        clearJsonNumberSource(proxy, property);
      }
      return succeeded;
    },
    deleteProperty(target, property) {
      const succeeded = Reflect.deleteProperty(target, property);
      if (succeeded) clearJsonNumberSource(proxy, property);
      return succeeded;
    },
  });
  JSON_NUMBER_SOURCES.set(proxy, sources);
  return proxy;
}

function jsonNumberSource(parent: object, key: string): string | undefined {
  const source = JSON_NUMBER_SOURCES.get(parent)?.get(key);
  const currentValue = (parent as Record<string, unknown>)[key];
  return source !== undefined && Object.is(currentValue, Number(source))
    ? source
    : undefined;
}

function isExactJsonInteger(source: string): boolean {
  const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(source);
  if (!match) return false;

  const fraction = match[2] ?? '';
  const digits = `${match[1]}${fraction}`;
  const nonZeroDigits = digits.replace(/^0+/u, '');
  if (nonZeroDigits === '') return true;

  const trailingZeroCount = digits.length - digits.replace(/0+$/u, '').length;
  const exponent = match[3] === undefined ? 0 : Number(match[3]);
  if (!Number.isSafeInteger(exponent)) {
    // The source token cannot contain enough fractional digits to offset an
    // exponent outside the safe-integer range.
    return exponent > 0;
  }
  return exponent - fraction.length + trailingZeroCount >= 0;
}

function isIntegerValue(value: number, source?: string): boolean {
  return (
    Number.isInteger(value) &&
    (source === undefined || isExactJsonInteger(source))
  );
}

function parseJsonWithNumberSources(text: string): ParsedJsonDocument {
  let rootNumberSource: string | undefined;
  const value = JSON.parse(
    text,
    function (key, parsedValue, context?: unknown) {
      const source = (context as { source?: unknown } | undefined)?.source;
      if (typeof parsedValue === 'number' && typeof source === 'string') {
        if (key === '') {
          rootNumberSource = source;
        }
        const parent = this as unknown;
        if (key !== '' && typeof parent === 'object' && parent !== null) {
          let sources = JSON_NUMBER_SOURCES.get(parent);
          if (!sources) {
            sources = new Map();
            JSON_NUMBER_SOURCES.set(parent, sources);
          }
          sources.set(key, source);
        }
      }
      return typeof parsedValue === 'object' && parsedValue !== null
        ? trackJsonObject(parsedValue)
        : parsedValue;
    },
  );
  const document = Object.freeze({ value, rootNumberSource });
  PARSED_JSON_DOCUMENTS.add(document);
  return document;
}

interface SchemaNode {
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  patternProperties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  items?: SchemaNode;
  enum?: unknown[];
  oneOf?: SchemaNode[];
  [key: string]: unknown;
}

/** Source information required to resolve the deliberately narrow local refs. */
export interface SchemaValidationContext {
  root: string;
  schemaPath: string;
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
  'maximum',
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
 * and `uri` is enforced as an absolute URI (see `validate`).
 */
const SUPPORTED_FORMATS = new Set(['date-time', 'uri']);

/** RFC 3339 `date-time` (section 5.6) with the components captured. */
const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

/** Gregorian month length, with the leap-year rule for February. */
function daysInMonth(year: number, month: number): number {
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
export function isRfc3339DateTime(value: string): boolean {
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

const URI_PATH_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u;
const URI_QUERY_FRAGMENT_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/u;
const URI_REG_NAME_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=%-]*$/u;
const URI_USERINFO_CHARS = /^[A-Za-z0-9._~!$&'()*+,;=:%-]*$/u;
const URI_NETWORK_SCHEMES = new Set(['ftp', 'http', 'https', 'ws', 'wss']);

/** Whether an authority follows the RFC 3986 authority grammar. */
function isUriAuthority(value: string, scheme: string): boolean {
  const at = value.indexOf('@');
  if (at !== value.lastIndexOf('@')) return false;

  const hostPort = at < 0 ? value : value.slice(at + 1);
  if (at >= 0 && !URI_USERINFO_CHARS.test(value.slice(0, at))) return false;

  let host: string;
  let port: string | undefined;
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close < 0) return false;
    host = hostPort.slice(1, close);
    const suffix = hostPort.slice(close + 1);
    if (suffix !== '') {
      if (!suffix.startsWith(':')) return false;
      port = suffix.slice(1);
    }
    const isIpvFuture = /^v[0-9a-f]+\.[A-Za-z0-9._~!$&'()*+,;=:-]+$/iu.test(
      host,
    );
    if (!isIpvFuture) {
      try {
        new URL(`http://[${host}]/`);
      } catch {
        return false;
      }
    }
  } else {
    if (hostPort.includes('[') || hostPort.includes(']')) return false;
    const colon = hostPort.indexOf(':');
    if (colon !== hostPort.lastIndexOf(':')) return false;
    host = colon < 0 ? hostPort : hostPort.slice(0, colon);
    if (colon >= 0) port = hostPort.slice(colon + 1);
    if (!URI_REG_NAME_CHARS.test(host)) return false;
  }

  if (URI_NETWORK_SCHEMES.has(scheme.toLowerCase()) && host.length === 0) {
    return false;
  }
  if (port !== undefined) {
    if (!/^\d*$/u.test(port)) return false;
  }
  return true;
}

/** Whether a string is an absolute RFC 3986 URI. */
function isUri(value: string): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/u.exec(value)?.[1];
  if (!scheme || /%(?![0-9a-fA-F]{2})/u.test(value)) return false;

  const fragmentIndex = value.indexOf('#');
  if (fragmentIndex !== value.lastIndexOf('#')) return false;
  const beforeFragment =
    fragmentIndex < 0 ? value : value.slice(0, fragmentIndex);
  const fragment =
    fragmentIndex < 0 ? undefined : value.slice(fragmentIndex + 1);
  const queryIndex = beforeFragment.indexOf('?');
  const hierarchy =
    queryIndex < 0 ? beforeFragment : beforeFragment.slice(0, queryIndex);
  const query =
    queryIndex < 0 ? undefined : beforeFragment.slice(queryIndex + 1);

  if (
    (query !== undefined && !URI_QUERY_FRAGMENT_CHARS.test(query)) ||
    (fragment !== undefined && !URI_QUERY_FRAGMENT_CHARS.test(fragment))
  ) {
    return false;
  }

  const schemeSpecificPart = hierarchy.slice(scheme.length + 1);
  if (schemeSpecificPart.startsWith('//')) {
    const pathStart = schemeSpecificPart.indexOf('/', 2);
    const authority =
      pathStart < 0
        ? schemeSpecificPart.slice(2)
        : schemeSpecificPart.slice(2, pathStart);
    const path = pathStart < 0 ? '' : schemeSpecificPart.slice(pathStart);
    return (
      isUriAuthority(authority, scheme) &&
      URI_PATH_CHARS.test(path) &&
      (path === '' || path.startsWith('/'))
    );
  }
  return URI_PATH_CHARS.test(schemeSpecificPart);
}

/**
 * Check that a schema object only uses allowed keywords, recursively.
 */
export function checkSchemaKeywords(
  schema: unknown,
  path = '$',
  context?: SchemaValidationContext,
): string[] {
  return checkSchemaKeywordsWithRefs(schema, path, context, new Set());
}

function checkSchemaKeywordsWithRefs(
  schema: unknown,
  path: string,
  context: SchemaValidationContext | undefined,
  activeRefs: Set<string>,
): string[] {
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
function resolveUserGlobalConfigRef(
  reference: string,
  context: SchemaValidationContext,
): unknown | string {
  if (context.schemaPath !== 'schemas/user-global-config.schema.json') {
    return `unsupported $ref source "${context.schemaPath}"`;
  }
  const definitionMatch = /^#\/\$defs\/([A-Za-z0-9_$-]+)$/u.exec(reference);
  if (definitionMatch) {
    const definitionName = definitionMatch[1];
    if (!definitionName) return `unresolved $ref "${reference}"`;
    try {
      const userGlobalSchema = loadJson(context.schemaPath, context.root) as {
        $defs?: Record<string, unknown>;
      };
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
    const policySchema = loadJson(
      'schemas/policy.schema.json',
      context.root,
    ) as Record<string, unknown>;
    let target: unknown = policySchema;
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
      const properties = (target as Record<string, unknown>).properties;
      if (
        typeof properties !== 'object' ||
        properties === null ||
        Array.isArray(properties) ||
        !Object.hasOwn(properties, propertyName)
      ) {
        return `unresolved $ref "${reference}"`;
      }
      target = (properties as Record<string, unknown>)[propertyName];
    }
    return target ?? `unresolved $ref "${reference}"`;
  } catch (error) {
    return `cannot load local $ref "${reference}": ${error instanceof Error ? error.message : String(error)}`;
  }
}

function getType(val: unknown): string {
  if (val === null) return 'null';
  if (Array.isArray(val)) return 'array';
  return typeof val;
}

interface DecimalValue {
  sign: -1 | 0 | 1;
  order: bigint;
  digits: string;
}

function parseDecimalValue(value: string): DecimalValue | undefined {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(
    value,
  );
  if (!match) return undefined;

  const digits = match[2] + (match[3] ?? '');
  const firstNonZero = digits.search(/[1-9]/u);
  if (firstNonZero < 0) {
    return { sign: 0, order: 0n, digits: '0' };
  }
  const exponentText = match[4] ?? '0';
  const exponentDigits =
    exponentText.replace(/^[+-]/u, '').replace(/^0+/u, '') || '0';
  if (exponentDigits.length > 15) return undefined;
  const exponent = BigInt(
    `${exponentText.startsWith('-') ? '-' : ''}${exponentDigits}`,
  );

  return {
    sign: match[1] === '-' ? -1 : 1,
    order: BigInt(match[2].length) + exponent - BigInt(firstNonZero),
    digits: digits.slice(firstNonZero),
  };
}

/** Compare exact decimal values without rounding through IEEE-754. */
function compareDecimalValues(left: string, right: string): number | undefined {
  const leftValue = parseDecimalValue(left);
  const rightValue = parseDecimalValue(right);
  if (!leftValue || !rightValue) return undefined;
  if (leftValue.sign !== rightValue.sign) {
    return leftValue.sign < rightValue.sign ? -1 : 1;
  }
  if (leftValue.sign === 0) return 0;

  let magnitudeComparison = 0;
  if (leftValue.order !== rightValue.order) {
    magnitudeComparison = leftValue.order < rightValue.order ? -1 : 1;
  } else {
    const width = Math.max(leftValue.digits.length, rightValue.digits.length);
    for (let index = 0; index < width; index++) {
      const leftDigit = leftValue.digits[index] ?? '0';
      const rightDigit = rightValue.digits[index] ?? '0';
      if (leftDigit !== rightDigit) {
        magnitudeComparison = leftDigit < rightDigit ? -1 : 1;
        break;
      }
    }
  }
  return leftValue.sign * magnitudeComparison;
}

function compareNumberToBound(
  value: number,
  bound: number,
  source?: string,
  boundSource?: string,
): number {
  const roundedComparison = value < bound ? -1 : value > bound ? 1 : 0;
  if (
    source === undefined ||
    roundedComparison !== 0 ||
    !Number.isFinite(bound)
  ) {
    return roundedComparison;
  }
  const exactBoundSource = boundSource ?? String(bound);
  const exactComparison = compareDecimalValues(source, exactBoundSource);
  if (exactComparison !== undefined) return exactComparison;
  if (bound === 0 && parseDecimalValue(exactBoundSource)?.sign === 0) {
    const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?/u.exec(source);
    if (!match) return roundedComparison;
    if (!/[1-9]/u.test(match[2] + (match[3] ?? ''))) return 0;
    return match[1] === '-' ? -1 : 1;
  }
  return roundedComparison;
}

/**
 * Validate data against a schema (subset enforced by this validator).
 * Returns error messages — empty array means valid.
 */
export function validate(
  data: unknown,
  schema: unknown,
  path = '$',
  context?: SchemaValidationContext,
  activeRefs: Set<string> = new Set(),
  numberSource?: string,
): string[] {
  if (
    typeof data === 'object' &&
    data !== null &&
    PARSED_JSON_DOCUMENTS.has(data)
  ) {
    const document = data as ParsedJsonDocument;
    data = document.value;
    numberSource = document.rootNumberSource ?? numberSource;
  }
  const s = schema as SchemaNode;
  const errors: string[] = [];
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
        errors.push(
          ...validate(data, resolved, path, context, nextRefs, numberSource),
        );
      }
    }
  }

  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf) || s.oneOf.length === 0) {
      errors.push(`${path}: oneOf must be a non-empty array of schemas`);
    } else {
      const matchingBranches = s.oneOf.filter(
        (branch) =>
          validate(data, branch, path, context, activeRefs, numberSource)
            .length === 0,
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
          ? actualType === 'number' &&
            isIntegerValue(data as number, numberSource)
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
      if (!isIntegerValue(data as number, numberSource)) {
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
    if (s.format === 'date-time' && !isRfc3339DateTime(str)) {
      errors.push(`${path}: invalid date-time value "${str}"`);
    }
    if (s.format === 'uri' && !isUri(str)) {
      errors.push(`${path}: invalid uri value "${str}"`);
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
    compareNumberToBound(
      data as number,
      s.minimum,
      numberSource,
      jsonNumberSource(s, 'minimum'),
    ) < 0
  ) {
    errors.push(`${path}: ${data as number} < minimum ${s.minimum}`);
  }
  if (
    actualType === 'number' &&
    s.maximum !== undefined &&
    compareNumberToBound(
      data as number,
      s.maximum,
      numberSource,
      jsonNumberSource(s, 'maximum'),
    ) > 0
  ) {
    errors.push(`${path}: ${data as number} > maximum ${s.maximum}`);
  }
  if (
    actualType === 'number' &&
    s.exclusiveMinimum !== undefined &&
    compareNumberToBound(
      data as number,
      s.exclusiveMinimum,
      numberSource,
      jsonNumberSource(s, 'exclusiveMinimum'),
    ) <= 0
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
        errors.push(
          ...validate(
            arr[i],
            s.items,
            `${path}[${i}]`,
            context,
            activeRefs,
            jsonNumberSource(arr, String(i)),
          ),
        );
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
        errors.push(
          ...validate(
            obj[prop],
            propSchema,
            `${path}.${prop}`,
            context,
            activeRefs,
            jsonNumberSource(obj, prop),
          ),
        );
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
          errors.push(
            ...validate(
              obj[key],
              patternSchema,
              `${path}.${key}`,
              context,
              activeRefs,
              jsonNumberSource(obj, key),
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
            jsonNumberSource(obj, key),
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
export function validateConfigSection(
  config: unknown,
  schema: unknown,
  sectionKey: string,
  context?: SchemaValidationContext,
): string[] {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return [];
  }
  const sectionSchema = (schema as { properties?: Record<string, unknown> })
    ?.properties?.[sectionKey];
  if (sectionSchema === undefined) {
    return [];
  }
  const obj = config as Record<string, unknown>;
  if (!Object.hasOwn(obj, sectionKey)) {
    return [];
  }
  return validate(
    obj[sectionKey],
    sectionSchema,
    `$.${sectionKey}`,
    context,
    new Set(),
    jsonNumberSource(obj, sectionKey),
  );
}

/**
 * Load and parse a JSON file by path relative to repository root.
 */
export function loadJson(relPath: string, root: string = ROOT): unknown {
  return loadJsonDocument(relPath, root).value;
}

/**
 * Load a JSON document with source information for root-level numeric values.
 * Pass the result directly to `validate` when exact root-number validation
 * matters; `loadJson` retains its plain-value return type for other callers.
 */
export function loadJsonDocument(
  relPath: string,
  root: string = ROOT,
): ParsedJsonDocument {
  return parseJsonWithNumberSources(readFileSync(join(root, relPath), 'utf8'));
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
  root: string = ROOT,
): { ok: boolean; errors: string[] } {
  const schema = loadJson(schemaPath, root);
  const fixture = loadJsonDocument(fixturePath, root);
  const context = { root, schemaPath };
  const keyErrors = checkSchemaKeywords(schema, '$', context);
  if (keyErrors.length > 0) {
    return {
      ok: false,
      errors: [`Schema has unsupported keywords: ${keyErrors.join('; ')}`],
    };
  }
  const errs = validate(fixture, schema, '$', context);
  let graphErrors: string[] = [];
  if (schemaPath.endsWith('phase-graph.schema.json') && errs.length === 0) {
    graphErrors = validatePhaseGraph(fixture.value);
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

/** One schema/fixture validation case. */
export interface SchemaCase {
  schemaPath: string;
  fixturePath: string;
  expectValid: boolean;
}

/** A schema that is missing one or both of its fixture files. */
export interface MissingFixtureSchema {
  schema: string;
  missingFixtures: string[];
}

/**
 * Auto-discover schema/fixture validation cases under `root`: every
 * `schemas/*.schema.json` is paired with `fixtures/schemas/<name>.valid.json`
 * (expect-pass) and `<name>.invalid.json` (expect-fail). A schema missing
 * either fixture is reported in `missing` rather than silently skipped, so the
 * CLI can fail closed and a new schema cannot slip through unvalidated. Pure
 * over the filesystem (globs and stats only), so it is unit-testable.
 */
export function discoverSchemaCases(root: string): {
  cases: SchemaCase[];
  missing: MissingFixtureSchema[];
} {
  const schemaFiles = readdirSync(join(root, 'schemas'))
    .filter((file) => file.endsWith('.schema.json'))
    .sort();
  const cases: SchemaCase[] = [];
  const missing: MissingFixtureSchema[] = [];
  for (const file of schemaFiles) {
    const name = file.slice(0, -'.schema.json'.length);
    const schemaPath = `schemas/${file}`;
    const validFixture = `fixtures/schemas/${name}.valid.json`;
    const invalidFixture = `fixtures/schemas/${name}.invalid.json`;
    const missingFixtures: string[] = [];
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
export const LIVE_INSTANCE_CASES: readonly SchemaCase[] = [
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

function parseCliArguments(argv: readonly string[]): {
  root: string | null;
  help: boolean;
} {
  let root: string | null = null;
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
export function runValidateSchemasCli(
  argv: readonly string[] = process.argv.slice(2),
): number {
  let root: string;
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

  let discovered: ReturnType<typeof discoverSchemaCases>;
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
    let result: { ok: boolean; errors: string[] };
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
