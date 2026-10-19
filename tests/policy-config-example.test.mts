// Checks for idd-template/.github/idd/config.example.jsonc (#4541), the
// annotated policy example. IDD itself never reads the example; these tests
// keep it in step with schemas/policy.schema.json and the runtime defaults.
//
// The example's comment grammar, which the parsing below relies on:
// - every comment is a whole line whose first non-blank characters are //
//   (the strip rule docs/customization.md documents);
// - a commented-out setting line has ", {, }, [, or ] after its "// ";
// - an explanation line starts with anything else, and inside a commented-out
//   object it carries a second // so it survives uncommenting;
// - arrays stay on one line, and each key has exactly one setting line.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS } from '../src/scripts/advisory-convergence.mts';
import {
  resolveAdvisoryConvergenceDeadlineMinutes,
  resolveAdvisoryPrimaryBotLogin,
  resolveAdvisoryRecoveryCycleCap,
  resolveAdvisorySameHeadRerollCap,
  resolveAdvisoryTerminalWindowMinutes,
} from '../src/scripts/advisory-wait-policy.mts';
import {
  normalizeAutopilotSuitabilityFloor,
  resolveEffortLPolicy,
} from '../src/scripts/autopilot-suitability.mts';
import { resolveGithubApiTelemetryPath } from '../src/scripts/github-api-observation.mts';
import { resolveLauncher } from '../src/scripts/helper-runtime-manifest.mts';
import { isUpstreamEscalationEnabled } from '../src/scripts/idd-config.mts';
import {
  DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
  findPlaceholders,
} from '../src/scripts/idd-doctor.mts';
import {
  normalizePolicyConfig,
  parseIsoDurationToMs,
  resolveEffectiveProvider,
} from '../src/scripts/policy-helpers.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

interface SchemaNode {
  description?: string;
  enum?: unknown[];
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  required?: string[];
}

type JsonRecord = Record<string, unknown>;

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXAMPLE_PATH = 'idd-template/.github/idd/config.example.jsonc';
const EXAMPLE = readFileSync(join(REPO_ROOT, EXAMPLE_PATH), 'utf8');
const LINES = EXAMPLE.split('\n');
const SCHEMA = loadJson('schemas/policy.schema.json') as SchemaNode;

const COMMENT_LINE = /^\s*\/\//u;
const SETTING_LINE = /^(\s*)\/\/ (\s*["{}[\]].*)$/u;
const TOP_LEVEL_SETTING = /^ {2}\/\/ "/u;
const OMITTED_DEFAULT = 'Default: omitted';

function stripComments(lines: readonly string[]): string {
  return lines.filter((line) => !COMMENT_LINE.test(line)).join('\n');
}

function parseDocument(text: string, label: string): JsonRecord {
  try {
    return JSON.parse(text) as JsonRecord;
  } catch (error) {
    assert.fail(
      `${EXAMPLE_PATH}: ${label} is not strict JSON: ${(error as Error).message}`,
    );
  }
}

/** Opening minus closing brackets in a line, ignoring string contents. */
function bracketDelta(text: string): number {
  const bare = text.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
  let delta = 0;
  for (const character of bare) {
    if (character === '{' || character === '[') delta += 1;
    if (character === '}' || character === ']') delta -= 1;
  }
  return delta;
}

interface Block {
  key: string;
  start: number;
  end: number;
}

/** Each commented-out top-level setting, from its key line to its close. */
function commentedBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  for (let start = 0; start < lines.length; start += 1) {
    if (!TOP_LEVEL_SETTING.test(lines[start])) continue;
    const key = /"([^"]+)"/u.exec(lines[start])?.[1] ?? '';
    let depth = 0;
    let end = start;
    for (; end < lines.length; end += 1) {
      const match = SETTING_LINE.exec(lines[end]);
      if (match) depth += bracketDelta(match[2]);
      if (depth <= 0) break;
    }
    assert.ok(
      end < lines.length,
      `${EXAMPLE_PATH}: the commented-out "${key}" block never closes`,
    );
    blocks.push({ key, start, end });
    start = end;
  }
  return blocks;
}

/** Remove one comment level from every line of the given blocks. */
function uncomment(
  lines: readonly string[],
  blocks: readonly Block[],
): string[] {
  const result = [...lines];
  for (const { start, end } of blocks) {
    for (let index = start; index <= end; index += 1) {
      result[index] = result[index].replace(/^(\s*)\/\/ /u, '$1');
    }
  }
  return result;
}

interface Entry {
  line: number;
  explanation: string;
}

/**
 * Every key line of a document with its dotted path and the explanation
 * lines directly above it. Inline array items get no entry of their own.
 */
function keyEntries(lines: readonly string[]): {
  entries: Map<string, Entry>;
  duplicates: string[];
} {
  const entries = new Map<string, Entry>();
  const duplicates: string[] = [];
  const stack: string[] = [];
  let explanation: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (COMMENT_LINE.test(line)) {
      explanation.push(line.replace(/^\s*\/\/\s?/u, ''));
      continue;
    }
    const trimmed = line.trim();
    const key = /^"([^"]+)":\s*(.*)$/u.exec(trimmed);
    if (key) {
      const path = [...stack, key[1]].join('.');
      if (entries.has(path)) duplicates.push(path);
      entries.set(path, {
        line: index + 1,
        explanation: explanation.join(' ').replace(/\s+/gu, ' '),
      });
      if (bracketDelta(key[2]) > 0) stack.push(key[1]);
    } else if (/^[}\]]/u.test(trimmed)) {
      stack.pop();
    }
    explanation = [];
  }
  return { entries, duplicates };
}

interface SchemaPath {
  path: string;
  node: SchemaNode;
  legacy: boolean;
}

/** Every property path of the schema; `[]` marks an array item. */
function schemaPaths(
  node: SchemaNode,
  prefix = '',
  legacy = false,
): SchemaPath[] {
  const paths: SchemaPath[] = [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const isLegacy = legacy || (child.description ?? '').startsWith('Legacy');
    paths.push({ path, node: child, legacy: isLegacy });
    paths.push(...schemaPaths(child, path, isLegacy));
    if (child.items?.properties) {
      paths.push(...schemaPaths(child.items, `${path}[]`, isLegacy));
    }
  }
  return paths;
}

function lookup(
  document: unknown,
  path: string,
): { found: boolean; value?: unknown } {
  let current = document;
  for (const segment of path.split('.')) {
    const item = segment.endsWith('[]');
    const key = item ? segment.slice(0, -2) : segment;
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, key)
    ) {
      return { found: false };
    }
    current = (current as JsonRecord)[key];
    if (item) {
      if (!Array.isArray(current) || current.length === 0) {
        return { found: false };
      }
      current = current[0];
    }
  }
  return { found: true, value: current };
}

/** The dotted path of every non-object value; an array counts as one value. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    leafPaths(child, prefix === '' ? key : `${prefix}.${key}`),
  );
}

/** A copy of the document without the value at `path`. */
function withoutPath(document: JsonRecord, path: string): JsonRecord {
  const copy = structuredClone(document);
  const segments = path.split('.');
  const last = segments.pop() as string;
  let parent: unknown = copy;
  for (const segment of segments) {
    parent = (parent as JsonRecord | undefined)?.[segment];
  }
  if (parent !== null && typeof parent === 'object') {
    Reflect.deleteProperty(parent, last);
  }
  return copy;
}

/** A key that its optional parent object requires has no default of its own. */
function isRequiredByParent(path: string): boolean {
  const segments = path.split('.');
  const key = segments.pop() as string;
  let node: SchemaNode | undefined = SCHEMA;
  for (const segment of segments) {
    node = node?.properties?.[segment];
  }
  return node?.required?.includes(key) ?? false;
}

const minutes = (value: unknown): number =>
  (parseIsoDurationToMs(value) ?? Number.NaN) / 60_000;

/**
 * Defaults that normalizePolicyConfig does not report. Each `effective`
 * resolves the runtime value for a config without the setting; `shown`
 * converts the example's value to the same unit. A constant stands in where
 * the read site has no exported resolver, and its comment names that site.
 */
const OTHER_DEFAULTS: Readonly<
  Record<
    string,
    {
      effective: (config: JsonRecord) => unknown;
      shown?: (value: unknown) => unknown;
    }
  >
> = {
  provider: {
    effective: (config) => resolveEffectiveProvider(config).provider,
  },
  'helperRuntime.launcher': {
    effective: () => resolveLauncher(undefined, null).resolved,
  },
  'githubApi.telemetry.path': {
    effective: (config) =>
      resolveGithubApiTelemetryPath(
        normalizePolicyConfig(config).githubApi.telemetry.path,
      ),
    shown: (value) => resolveGithubApiTelemetryPath(value as string),
  },
  'advisoryWait.primaryBotLogin': { effective: resolveAdvisoryPrimaryBotLogin },
  'advisoryWait.convergenceDeadline': {
    effective: resolveAdvisoryConvergenceDeadlineMinutes,
    shown: minutes,
  },
  'advisoryWait.sameHeadRerollCap': {
    effective: resolveAdvisorySameHeadRerollCap,
  },
  'advisoryWait.recoveryCycleCap': {
    effective: resolveAdvisoryRecoveryCycleCap,
  },
  'advisoryWait.terminalWindow': {
    effective: resolveAdvisoryTerminalWindowMinutes,
    shown: minutes,
  },
  'advisoryConvergence.copilotReviewPollMaxWait': {
    effective: () => DEFAULT_COPILOT_REVIEW_POLL_MAX_WAIT_MS,
    shown: parseIsoDurationToMs,
  },
  'autopilotSuitability.floor': {
    effective: (config) =>
      normalizeAutopilotSuitabilityFloor(
        (config.autopilotSuitability as JsonRecord | undefined)?.floor,
      ),
  },
  // The Discover helpers treat any value but false as on.
  'autopilotSuitability.enabled': { effective: () => true },
  'autopilotSuitability.effortL': { effective: resolveEffortLPolicy },
  // idd-doctor's readWorktreeGuardEnabled and the local hook need true.
  'worktreeGuard.enabled': { effective: () => false },
  'worktreeGuard.branchPatterns': {
    effective: () => DEFAULT_WORKTREE_GUARD_BRANCH_PATTERNS,
  },
  // The local hook in .githooks/_idd-worktree-guard.sh needs true.
  'worktreeGuard.refuseBaseBranchCommits': { effective: () => false },
  'upstreamEscalation.enabled': { effective: isUpstreamEscalationEnabled },
  // publish-authoring-hold.mts falls back to PT2M.
  'issueAuthoring.heartbeatCoalesceWindow': { effective: () => 'PT2M' },
};

/** A shown value is an example, not a default, when this holds. */
function isExampleOnly(
  path: string,
  entries: ReadonlyMap<string, Entry>,
): boolean {
  return (
    (entries.get(path)?.explanation ?? '').includes(OMITTED_DEFAULT) ||
    isRequiredByParent(path)
  );
}

const BLOCKS = commentedBlocks(LINES);
const UNCOMMENTED = uncomment(LINES, BLOCKS);

test('the comments-stripped example is strict JSON that the policy schema accepts', () => {
  const stripped = parseDocument(stripComments(LINES), 'the stripped copy');
  assert.deepEqual(validate(stripped, SCHEMA), []);
});

test('only $schema and the required settings stay active', () => {
  const stripped = parseDocument(stripComments(LINES), 'the stripped copy');
  assert.deepEqual(
    Object.keys(stripped).sort(),
    ['$schema', ...(SCHEMA.required ?? [])].sort(),
  );
  for (const [key, value] of Object.entries(stripped)) {
    const node = SCHEMA.properties?.[key];
    if (node?.properties === undefined) continue;
    assert.deepEqual(
      Object.keys(value as JsonRecord).sort(),
      [...(node.required ?? [])].sort(),
      `${EXAMPLE_PATH}: ${key} holds an optional key that is not commented out`,
    );
  }
});

test('the active values match the distributed template config and the release', () => {
  const stripped = parseDocument(stripComments(LINES), 'the stripped copy');
  const template = loadJson(
    'idd-template/.github/idd/config.json',
  ) as JsonRecord;
  for (const key of [
    '$schema',
    'iddVersion',
    'mergePolicy',
    'reviewPolicy',
    'threadResolutionPolicy',
    'claimTiming',
  ]) {
    assert.deepEqual(stripped[key], template[key], `${EXAMPLE_PATH}: ${key}`);
  }
  const packageJson = loadJson('package.json') as JsonRecord;
  assert.equal(stripped.iddVersion, packageJson.version);
});

test('the example carries no onboarding placeholder token', () => {
  assert.deepEqual(findPlaceholders(EXAMPLE), []);
});

test('each commented-out top-level setting uncomments on its own into a valid config', () => {
  assert.ok(BLOCKS.length > 0, `${EXAMPLE_PATH}: no commented-out settings`);
  for (const block of BLOCKS) {
    const document = parseDocument(
      stripComments(uncomment(LINES, [block])),
      `the copy with "${block.key}" uncommented`,
    );
    assert.deepEqual(
      validate(document, SCHEMA),
      [],
      `${EXAMPLE_PATH}: "${block.key}" (line ${block.start + 1})`,
    );
  }
});

test('the fully uncommented example sets every canonical key once and no legacy alias', () => {
  const document = parseDocument(
    stripComments(UNCOMMENTED),
    'the fully uncommented copy',
  );
  assert.deepEqual(validate(document, SCHEMA), []);
  assert.deepEqual(keyEntries(UNCOMMENTED).duplicates, []);
  const paths = schemaPaths(SCHEMA);
  const missing = paths
    .filter(({ legacy, path }) => !legacy && !lookup(document, path).found)
    .map(({ path }) => path);
  assert.deepEqual(missing, [], `${EXAMPLE_PATH} lacks these settings`);
  const legacy = paths
    .filter(({ legacy, path }) => legacy && lookup(document, path).found)
    .map(({ path }) => path);
  assert.deepEqual(legacy, [], `${EXAMPLE_PATH} shows legacy aliases`);
});

test('every shown value without an omitted-default note is the runtime default', () => {
  const full = parseDocument(
    stripComments(UNCOMMENTED),
    'the fully uncommented copy',
  );
  const active = parseDocument(stripComments(LINES), 'the stripped copy');
  const { entries } = keyEntries(UNCOMMENTED);
  const unchecked: string[] = [];
  const wrong: string[] = [];
  for (const path of leafPaths(full)) {
    if (lookup(active, path).found || isRequiredByParent(path)) continue;
    const shown = lookup(full, path).value;
    const without = withoutPath(full, path);
    const other = OTHER_DEFAULTS[path];
    const normalized = lookup(normalizePolicyConfig(without), path);
    if (isExampleOnly(path, entries)) {
      // An omitted-default note must not hide a real default: the runtime
      // may report only an empty value for a setting that is left out.
      const empty = [null, '', []].some((value) =>
        isDeepStrictEqual(normalized.value, value),
      );
      if (other !== undefined || (normalized.found && !empty)) {
        wrong.push(`${path}: says ${OMITTED_DEFAULT}, but has a default`);
      }
      continue;
    }
    let expected: unknown;
    let actual: unknown = shown;
    if (other !== undefined) {
      expected = other.effective(without);
      actual = other.shown === undefined ? shown : other.shown(shown);
    } else if (normalized.found) {
      expected = normalized.value;
    } else {
      unchecked.push(path);
      continue;
    }
    if (!isDeepStrictEqual(actual, expected)) {
      wrong.push(
        `${path}: shows ${JSON.stringify(shown)}, default ${JSON.stringify(expected)}`,
      );
    }
  }
  assert.deepEqual(wrong, [], `${EXAMPLE_PATH} shows wrong defaults`);
  assert.deepEqual(
    unchecked,
    [],
    `${EXAMPLE_PATH}: add these settings to OTHER_DEFAULTS in this test`,
  );
});

/**
 * The explanation for a schema path. An inline array item has no line of its
 * own, so its explanation is that of its ancestors.
 */
function explanationFor(
  path: string,
  entries: ReadonlyMap<string, Entry>,
): string {
  const own = entries.get(path);
  if (own !== undefined) return own.explanation;
  const segments = path.replaceAll('[]', '').split('.');
  const texts: string[] = [];
  while (segments.pop() !== undefined && segments.length > 0) {
    texts.push(entries.get(segments.join('.'))?.explanation ?? '');
  }
  return texts.join(' ');
}

/**
 * The runtime default of a key inside the first item of an inline array,
 * read from normalizePolicyConfig with that key removed from the item.
 */
function itemDefault(document: JsonRecord, path: string): unknown {
  const marker = path.lastIndexOf('[].');
  const arrayPath = path.slice(0, marker);
  const key = path.slice(marker + 3);
  const copy = structuredClone(document);
  const items = lookup(copy, arrayPath).value;
  if (!Array.isArray(items) || items.length === 0) return undefined;
  Reflect.deleteProperty(items[0] as JsonRecord, key);
  return lookup(normalizePolicyConfig(copy), path).value;
}

test('each enum and boolean comment marks the default value', () => {
  const full = parseDocument(
    stripComments(UNCOMMENTED),
    'the fully uncommented copy',
  );
  const { entries } = keyEntries(UNCOMMENTED);
  const label =
    /(?:"([^"]+)"|\b(true|false)\b) \((?:the distributed )?default\)/gu;
  const gaps: string[] = [];
  for (const { path, node, legacy } of schemaPaths(SCHEMA)) {
    if (legacy || isExampleOnly(path, entries)) continue;
    const stringEnum = (node.enum ?? []).some(
      (value) => typeof value === 'string',
    );
    if (!stringEnum && node.type !== 'boolean') continue;
    // An inline array item shows an example; its default is the runtime's.
    const expected = path.includes('[]')
      ? String(itemDefault(full, path))
      : String(lookup(full, path).value);
    const defaults = [...explanationFor(path, entries).matchAll(label)].map(
      (match) => match[1] ?? match[2],
    );
    if (defaults.length !== 1 || defaults[0] !== expected) {
      gaps.push(
        `${path}: default ${expected}, marks ${JSON.stringify(defaults)}`,
      );
    }
  }
  assert.deepEqual(gaps, [], `${EXAMPLE_PATH} marks the wrong default`);
});

test('the comments describe every enum value and both outcomes of every boolean', () => {
  const { entries } = keyEntries(UNCOMMENTED);
  const gaps: string[] = [];
  for (const { path, node, legacy } of schemaPaths(SCHEMA)) {
    if (legacy) continue;
    const text = explanationFor(path, entries);
    // Integer enums (orchestrator.maxWorkers, autopilotSuitability.floor) are
    // described as ranges, so only string enums are checked value by value.
    for (const value of node.enum ?? []) {
      if (typeof value === 'string' && !text.includes(`"${value}"`)) {
        gaps.push(`${path}: "${value}"`);
      }
    }
    // Each boolean outcome is its own "- true" or "- false" bullet.
    if (node.type === 'boolean') {
      for (const outcome of ['true', 'false']) {
        if (!new RegExp(`(?:^|\\s)- ${outcome}\\b`, 'u').test(text)) {
          gaps.push(`${path}: ${outcome}`);
        }
      }
    }
  }
  assert.deepEqual(
    gaps,
    [],
    `${EXAMPLE_PATH} leaves these values without a description`,
  );
});
