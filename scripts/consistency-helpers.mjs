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
// It counts every standalone `any` word in stripped code — annotations,
// casts, and type arguments in any nesting (`Set<any[]>`,
// `Map<string, any>`, unions) — excluding only property access
// (`.any`) and larger identifiers. Deliberately conservative: an
// unusual identifier literally named `any` would over-count, which
// fails loud for a budget gate rather than letting a wrapped type
// argument bypass it.
const ANY_TOKEN = 'any';
const EXPLICIT_ANY_PATTERN = new RegExp(`(?<![.$\\w])${ANY_TOKEN}\\b`, 'g');
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
        // Any non-empty trailing text counts as a reason (terse but
        // legitimate reasons like an issue reference must pass); only a
        // truly absent reason is a violation.
        if (trailing.length === 0) {
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
// Words after which a `/` must start a regex literal, not division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'delete',
  'void',
  'instanceof',
  'new',
  'do',
  'else',
  'yield',
  'await',
]);
// Text-level stripper for the explicit-`any` scan: blanks line comments,
// block comments, string/template-literal contents, and regex-literal
// contents while preserving line structure. Escape sequences are
// consumed as pairs so a string ending in a literal backslash closes
// correctly, and regex literals (detected by the standard
// last-significant-token heuristic, with bracket classes handled) cannot
// open phantom strings. Template interpolation is the remaining
// approximation: `${...}` code inside a template is stripped with the
// template, so an explicit `any` inside an interpolation is not counted.
function stripCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  let state = 'code';
  // Last non-whitespace character and last identifier word emitted in
  // code state, used to decide whether `/` starts a regex literal.
  let lastCodeChar = '';
  let lastWord = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        // Emit one space so a comment between tokens cannot splice them
        // together (a block comment between `as` and `any` must not
        // produce a single merged token that dodges the matcher).
        out += ' ';
        state = 'line-comment';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        out += ' ';
        state = 'block-comment';
        i += 2;
        continue;
      }
      if (ch === '/' && regexCanStartAfter(lastCodeChar, lastWord)) {
        state = 'regex';
        i += 1;
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
      if (!/\s/.test(ch)) {
        lastCodeChar = ch;
        lastWord = /[A-Za-z0-9_$]/.test(ch) ? lastWord + ch : '';
      }
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
    if (state === 'block-comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Consume escape sequences as pairs in string and regex states so an
    // escaped delimiter (or a literal backslash before the closing
    // delimiter, e.g. '\\') cannot flip the state machine. Comments have
    // no escapes. A line-continuation backslash still preserves the
    // newline so line structure survives.
    if (state !== 'line-comment' && ch === '\\') {
      if (next === '\n') {
        out += '\n';
      }
      i += 2;
      continue;
    }
    if (state === 'single' && ch === "'") {
      state = 'code';
      lastCodeChar = "'";
      lastWord = '';
      i += 1;
      continue;
    }
    if (state === 'double' && ch === '"') {
      state = 'code';
      lastCodeChar = '"';
      lastWord = '';
      i += 1;
      continue;
    }
    if (state === 'template' && ch === '`') {
      state = 'code';
      lastCodeChar = '`';
      lastWord = '';
      i += 1;
      continue;
    }
    if (state === 'regex') {
      if (ch === '[') {
        state = 'regex-class';
        i += 1;
        continue;
      }
      if (ch === '/') {
        state = 'code';
        lastCodeChar = '/';
        lastWord = '';
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (state === 'regex-class' && ch === ']') {
      state = 'regex';
      i += 1;
      continue;
    }
    i += 1;
  }
  return out;
}
// A `/` begins a regex literal when the previous significant token cannot
// end an expression: at the start of the scan, after an operator or
// opening punctuator, or after a keyword such as `return`. After an
// identifier character, a closing bracket, or a literal it is division.
function regexCanStartAfter(lastCodeChar, lastWord) {
  if (lastCodeChar === '') {
    return true;
  }
  if (REGEX_PRECEDING_KEYWORDS.has(lastWord)) {
    return true;
  }
  return !/[\w$)\]'"`/]/.test(lastCodeChar);
}
/**
 * Collect instruction size-budget violations. Pure (no I/O) so it can be
 * unit-tested; the audit pipeline feeds it the globbed file text.
 *
 * Scope rule (mirrors checkPairedChange): the budget is scoped to the
 * files changed against the git comparison base. When `changedFiles` is
 * `null` (no resolvable base — e.g. a CI clone without `origin/main`) the
 * check is skipped with a notice rather than auditing every instruction
 * file, which would let an unrelated PR fail on a file it never touched.
 * `loadFiles` is a thunk so no files are read on the skip path.
 */
export function collectInstructionSizeBudgetViolations(
  config,
  changedFiles,
  loadFiles,
) {
  if (!config) {
    return { errors: [], notices: [] };
  }
  const id = config.id ?? 'instruction-size-budgets';
  if (changedFiles === null) {
    return {
      errors: [],
      notices: [
        `${id}: skipped instruction size budget check because no git comparison base was available`,
      ],
    };
  }
  const alwaysLoadedPattern =
    config.alwaysLoadedPattern ?? 'applyTo:\\s*"\\*\\*"';
  const alwaysLoadedRegex = new RegExp(alwaysLoadedPattern, 'm');
  const alwaysLoadedLimitBytes = config.alwaysLoadedLimitBytes ?? 20_000;
  const phaseLimitBytes = config.phaseLimitBytes ?? 30_000;
  const errors = [];
  for (const file of loadFiles()) {
    if (!changedFiles.has(file.path)) {
      continue;
    }
    const text = String(file.text ?? '');
    const bytes = Buffer.byteLength(text, 'utf8');
    const alwaysLoaded = alwaysLoadedRegex.test(text);
    const limit = alwaysLoaded ? alwaysLoadedLimitBytes : phaseLimitBytes;
    if (bytes > limit) {
      errors.push(
        `${id}: ${file.path} is ${bytes} bytes (limit ${limit}; ${alwaysLoaded ? 'always-loaded' : 'phase'})`,
      );
    }
  }
  return { errors, notices: [] };
}
