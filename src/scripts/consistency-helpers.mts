// idd-generated-from: src/scripts/consistency-helpers.mts
//
// The scripts/consistency-helpers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.

import { parseProjectCommandRows } from './policy-helpers.mts';

export {
  inspectHelperRuntimeConfig,
  normalizePolicyConfig,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mts';

interface PolicyDrift {
  path: string;
  expected: unknown;
  actual: unknown;
  reason?: string;
}

interface LooseConfig {
  commands?: Record<string, unknown>;
  [key: string]: unknown;
}

interface RootMarkdownAllowlistConfig {
  id?: unknown;
  allowed?: unknown;
}

const COMMAND_KEYS = [
  'install-deps',
  'fix-validate',
  'pre-push-validate',
  'post-fix-validate',
];

const POLICY_FIELD_ROWS = new Map([
  ['issueScope', 'issue-scope'],
  ['orphanFirstPolicy', 'orphan-first-policy'],
]);

export function collectPolicyConfigDrift(
  config: unknown,
  overviewText: string,
): PolicyDrift[] {
  const c: LooseConfig =
    config && typeof config === 'object' ? (config as LooseConfig) : {};
  const drifts: PolicyDrift[] = [];
  const commandRows = parseProjectCommandRows(overviewText);

  for (const key of COMMAND_KEYS) {
    const expected = commandRows.get(key);
    if (expected === undefined) {
      drifts.push({
        path: `commands.${key}`,
        expected: null,
        actual: c.commands?.[key] ?? null,
        reason: `missing instruction row ${key}`,
      });
      continue;
    }
    const actual = c.commands?.[key];
    if (actual !== expected) {
      drifts.push({
        path: `commands.${key}`,
        expected,
        actual: actual ?? null,
      });
    }
  }

  for (const [field, row] of POLICY_FIELD_ROWS) {
    const expected = commandRows.get(row);
    if (expected === undefined) {
      drifts.push({
        path: field,
        expected: null,
        actual: hasOwn(c, field) ? c[field] : null,
        reason: `missing instruction row ${row}`,
      });
      continue;
    }
    const actual = hasOwn(c, field) ? c[field] : expected;
    if (actual !== expected) {
      drifts.push({
        path: field,
        expected,
        actual: actual ?? null,
      });
    }
  }

  return drifts;
}

function hasOwn(value: unknown, key: string): boolean {
  return Object.hasOwn((value ?? {}) as object, key);
}

export function collectRootMarkdownAllowlistViolations(
  repoFiles: readonly string[],
  config: RootMarkdownAllowlistConfig | null | undefined,
): string[] {
  if (!config) {
    return [];
  }

  const id = String(config.id ?? 'root-markdown-allowlist');
  const allowedEntries = config.allowed ?? [];
  if (!Array.isArray(allowedEntries)) {
    return [`${id}: allowed must be an array of root Markdown file names`];
  }
  const allowed = new Set(allowedEntries as unknown[]);
  const violations: string[] = [];
  for (const file of repoFiles) {
    if (file.includes('/') || !/\.md$/i.test(file)) {
      continue;
    }
    if (!allowed.has(file)) {
      violations.push(
        `${id}: ${file} is not an allowed root-level Markdown file; record session evidence in issue comments instead, or add an intentional root document to rootMarkdownAllowlist in audit/sync-manifest.json`,
      );
    }
  }
  return violations;
}
