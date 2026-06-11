// idd-generated-from: src/scripts/consistency-helpers.mts
//
// The scripts/consistency-helpers.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
import { parseProjectCommandRows } from './policy-helpers.mjs';

export {
  inspectHelperRuntimeConfig,
  normalizePolicyConfig,
  resolveCollaboratorMarkerTrust,
} from './policy-helpers.mjs';

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
export function collectPolicyConfigDrift(config, overviewText) {
  const c = config && typeof config === 'object' ? config : {};
  const drifts = [];
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
function hasOwn(value, key) {
  return Object.hasOwn(value ?? {}, key);
}
export function collectRootMarkdownAllowlistViolations(repoFiles, config) {
  if (!config) {
    return [];
  }
  const id = String(config.id ?? 'root-markdown-allowlist');
  const allowedEntries = config.allowed ?? [];
  if (!Array.isArray(allowedEntries)) {
    return [`${id}: allowed must be an array of root Markdown file names`];
  }
  const allowed = new Set(allowedEntries);
  const violations = [];
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
// The directive tokens are assembled from fragments so this file (and the
// generated scripts/consistency-helpers.mjs) never contains the literal
// tokens itself — the guard scans raw text, and a literal here or in a
// test fixture would count against the budget.
const TS_IGNORE_TOKEN = `@ts-${'ignore'}`;
const TS_EXPECT_ERROR_TOKEN = `@ts-${'expect'}-error`;
// The explicit-`any` matcher is likewise assembled from fragments so its
// own pattern text never trips the scan when this file is scanned.
const ANY_TOKEN = 'any';
const EXPLICIT_ANY_PATTERN = new RegExp(
  `(?::\\s*${ANY_TOKEN}\\b|\\bas\\s+${ANY_TOKEN}\\b|<${ANY_TOKEN}>)`,
  'g',
);
/**
 * Collect type-suppression budget violations across the given files.
 * Pure (no I/O) so it can be unit-tested; the audit pipeline feeds it
 * file text read in the bare-node lane.
 *
 * Rules (the ratchet rule lives in the manifest entry's description):
 * - The ts-ignore directive is forbidden outright; the expect-error
 *   directive is the only allowed escape because it self-expires.
 * - Every expect-error directive must carry a same-line reason.
 * - Expect-error occurrences and explicit `any` occurrences are counted
 *   against the recorded budgets; exceeding either is a violation.
 *
 * The explicit-`any` scan strips comments and string/template-literal
 * contents first (a text-level approximation, not a parser), so prose
 * such as "Fail-safe: any invalid token" in a comment is not counted.
 * Directive scanning runs on the raw text because directives live in
 * comments.
 */
export function collectTypeSuppressionViolations(files, config) {
  if (!config) {
    return [];
  }
  const id = String(config.id ?? 'type-suppression-budgets');
  const tsExpectErrorLimit = normalizeBudgetLimit(config.tsExpectErrorLimit);
  const explicitAnyLimit = normalizeBudgetLimit(config.explicitAnyLimit);
  if (tsExpectErrorLimit === null) {
    return [`${id}: tsExpectErrorLimit must be a non-negative integer`];
  }
  if (explicitAnyLimit === null) {
    return [`${id}: explicitAnyLimit must be a non-negative integer`];
  }
  const violations = [];
  let tsExpectErrorCount = 0;
  let explicitAnyCount = 0;
  for (const file of files) {
    const lines = String(file.text ?? '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.includes(TS_IGNORE_TOKEN)) {
        violations.push(
          `${id}: ${file.path}:${index + 1} uses the forbidden ${TS_IGNORE_TOKEN} directive; use ${TS_EXPECT_ERROR_TOKEN} with a same-line reason instead`,
        );
      }
      let searchFrom = 0;
      while (true) {
        const at = line.indexOf(TS_EXPECT_ERROR_TOKEN, searchFrom);
        if (at === -1) {
          break;
        }
        tsExpectErrorCount += 1;
        const trailing = line
          .slice(at + TS_EXPECT_ERROR_TOKEN.length)
          .replace(/^\s*(?:--|—|:)?\s*/u, '')
          .trim();
        if (trailing.length < 3) {
          violations.push(
            `${id}: ${file.path}:${index + 1} has a ${TS_EXPECT_ERROR_TOKEN} directive without a same-line reason`,
          );
        }
        searchFrom = at + TS_EXPECT_ERROR_TOKEN.length;
      }
    }
    const codeOnly = stripCommentsAndStrings(String(file.text ?? ''));
    const anyMatches = codeOnly.match(EXPLICIT_ANY_PATTERN);
    explicitAnyCount += anyMatches ? anyMatches.length : 0;
  }
  if (tsExpectErrorCount > tsExpectErrorLimit) {
    violations.push(
      `${id}: ${tsExpectErrorCount} ${TS_EXPECT_ERROR_TOKEN} directive(s) exceed the recorded budget of ${tsExpectErrorLimit}; remove suppressions or raise the budget with an explicit PR callout (lowering is always allowed)`,
    );
  }
  if (explicitAnyCount > explicitAnyLimit) {
    violations.push(
      `${id}: ${explicitAnyCount} explicit any occurrence(s) exceed the recorded budget of ${explicitAnyLimit}; remove suppressions or raise the budget with an explicit PR callout (lowering is always allowed)`,
    );
  }
  return violations;
}
function normalizeBudgetLimit(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}
// Text-level stripper for the explicit-`any` scan: blanks line comments,
// block comments, and string/template-literal contents while preserving
// line structure. An approximation (regex literals containing quote
// characters can over-strip a short span), which is acceptable for a
// budget backstop — the installed lane's Biome noExplicitAny rule is the
// precise enforcement.
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = 'single';
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = 'double';
        i += 1;
        continue;
      }
      if (ch === '`') {
        state = 'template';
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '\n') {
      out += '\n';
      if (state === 'line-comment') {
        state = 'code';
      }
      i += 1;
      continue;
    }
    if (state === 'block-comment' && ch === '*' && next === '/') {
      state = 'code';
      i += 2;
      continue;
    }
    if (state === 'single' && ch === "'" && text[i - 1] !== '\\') {
      state = 'code';
      i += 1;
      continue;
    }
    if (state === 'double' && ch === '"' && text[i - 1] !== '\\') {
      state = 'code';
      i += 1;
      continue;
    }
    if (state === 'template' && ch === '`' && text[i - 1] !== '\\') {
      state = 'code';
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}
