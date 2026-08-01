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
/**
 * Like {@link normalizeBudgetLimit}, but for a budget field that must be
 * strictly positive (zero is not a usable instruction-file byte limit) and
 * that falls back to `defaultValue` only when genuinely absent
 * (`undefined`) rather than on every falsy/invalid value — a present but
 * invalid value (a string, `0`, a negative number, a non-integer) is a
 * manifest authoring error to reject, not silently coerce to the default.
 */
function normalizePositiveIntegerBudget(value, defaultValue) {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}
function normalizeNonNegativeNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}
/**
 * Collect "context ceiling" violations: an absolute, 128K-context-derived
 * cap layered on top of the per-bundle `bundleBudgets` ratchet, so a future
 * exact-fit bump errors instead of drifting past the documented ~10%-margin
 * convention the way `bundleBudgets` alone allowed (#1213, #1259 both
 * regressed for lack of this backstop).
 *
 * Pure (no I/O) so it can be unit-tested; the audit pipeline supplies the
 * already-measured per-bundle byte totals (`checkBundleBudgets`'s own
 * summation, reused rather than re-read here).
 *
 * All threshold comparisons are cross-multiplied in byte space
 * (`totalBytes * 100` vs. `limitBytes * pct`) rather than compared as a
 * rounded percentage float, so a bundle sitting exactly at a configured
 * threshold never tips over from rounding noise. `maxUtilizationPct` /
 * `noticeUtilizationPct` use strict `>` / inclusive `>=` respectively,
 * matching "exceeds" vs. "reaches ... or more" in the guard's own spec.
 */
export function collectContextCeilingViolations(config, bundles) {
  if (!config) {
    return { errors: [], notices: [] };
  }
  const id = String(config.id ?? 'context-ceiling');
  const maxBundleLimitBytes = normalizeBudgetLimit(config.maxBundleLimitBytes);
  if (maxBundleLimitBytes === null) {
    return {
      errors: [`${id}: maxBundleLimitBytes must be a non-negative integer`],
      notices: [],
    };
  }
  const maxUtilizationPct = normalizeNonNegativeNumber(
    config.maxUtilizationPct,
  );
  if (maxUtilizationPct === null) {
    return {
      errors: [`${id}: maxUtilizationPct must be a non-negative number`],
      notices: [],
    };
  }
  const noticeUtilizationPct = normalizeNonNegativeNumber(
    config.noticeUtilizationPct,
  );
  if (noticeUtilizationPct === null) {
    return {
      errors: [`${id}: noticeUtilizationPct must be a non-negative number`],
      notices: [],
    };
  }
  if (
    config.exemptBundles !== undefined &&
    !Array.isArray(config.exemptBundles)
  ) {
    return {
      errors: [`${id}: exemptBundles must be an array of bundle id strings`],
      notices: [],
    };
  }
  const rawExempt = Array.isArray(config.exemptBundles)
    ? config.exemptBundles
    : [];
  const exemptBundles = rawExempt.filter(
    (entry) => typeof entry === 'string' && entry.length > 0,
  );
  if (exemptBundles.length !== rawExempt.length) {
    return {
      errors: [
        `${id}: exemptBundles must be an array of non-empty bundle id strings`,
      ],
      notices: [],
    };
  }
  const exemptSet = new Set(exemptBundles);
  const knownIds = new Set(bundles.map((bundle) => bundle.id));
  const errors = [];
  const notices = [];
  for (const exemptId of exemptBundles) {
    if (!knownIds.has(exemptId)) {
      errors.push(`${id}: exemptBundles names unknown bundle id "${exemptId}"`);
    }
  }
  for (const bundle of bundles) {
    const utilizationPct =
      bundle.limitBytes > 0 ? (bundle.totalBytes / bundle.limitBytes) * 100 : 0;
    const overCeiling = bundle.limitBytes > maxBundleLimitBytes;
    const overUtilization =
      bundle.totalBytes * 100 > bundle.limitBytes * maxUtilizationPct;
    const isExempt = exemptSet.has(bundle.id);
    if (!isExempt) {
      if (overCeiling) {
        errors.push(
          `${id}: ${bundle.id} limitBytes ${bundle.limitBytes} exceeds the ${maxBundleLimitBytes}-byte context ceiling`,
        );
      }
      if (overUtilization) {
        const utilizationLabel =
          bundle.limitBytes > 0
            ? `${utilizationPct.toFixed(2)}%`
            : 'unbounded (zero-byte limit)';
        errors.push(
          `${id}: ${bundle.id} utilization ${utilizationLabel} exceeds ${maxUtilizationPct}% (${bundle.totalBytes}/${bundle.limitBytes} bytes)`,
        );
      }
    } else if (!overCeiling && !overUtilization) {
      notices.push(
        `${id}: ${bundle.id} is listed in exemptBundles but currently violates neither ceiling check; consider removing the exemption`,
      );
    }
    if (
      bundle.limitBytes > 0 &&
      bundle.totalBytes * 100 >= bundle.limitBytes * noticeUtilizationPct
    ) {
      notices.push(
        `${id}: ${bundle.id} utilization is ${utilizationPct.toFixed(2)}% (>= ${noticeUtilizationPct}% notice threshold)`,
      );
    }
  }
  return { errors, notices };
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
// ---------------------------------------------------------------------------
// Generated-from banner for sync-docs-generated instruction targets
//
// sync-docs stamps a short HTML-comment banner into each generated instruction
// target so agents and humans see it is generated and edit the idd-template/
// source instead. The banner is injected at generation time (never stored in
// the source), verified by audit-docs, and excluded from the instruction /
// bundle byte budgets so it never forces a budget bump. This mirrors the
// `// idd-generated-from:` banner on src/scripts/*.mts -> scripts/*.mjs, in the
// HTML-comment form that stays invisible in rendered Markdown.
// ---------------------------------------------------------------------------
const GENERATED_FROM_BANNER_OPEN = '<!-- idd-generated-from:';
// Matches the injected banner block (opener line, source line, note lines, up
// to the first `-->`), without the surrounding newlines the strip branches add
// per case. The opener has no regex metacharacters, so it is embedded literally.
const GENERATED_FROM_BANNER_BODY = `${GENERATED_FROM_BANNER_OPEN}\\n[\\s\\S]*?-->`;
/**
 * True when a syncPairs target is a generated instruction file that should
 * carry the generated-from banner: an `exact`/`concreted`
 * `.github/instructions/*.instructions.md` target. `structure` targets (e.g.
 * idd-discover) are validated structurally rather than byte-generated, and the
 * generated `docs/*` / `.claude/skills/*` targets are a deliberate follow-up,
 * so both stay out of scope.
 */
export function isBannerScopedInstructionTarget(target, mode) {
  return (
    (mode === 'exact' || mode === 'concreted') &&
    target.startsWith('.github/instructions/') &&
    target.endsWith('.instructions.md')
  );
}
/**
 * The canonical generated-from banner block for `source`, as a standalone HTML
 * comment (no surrounding blank lines). Every line stays under the 80-char
 * MD013 limit and the comment is invisible in rendered Markdown.
 */
export function generatedFromBanner(source) {
  return [
    GENERATED_FROM_BANNER_OPEN,
    source,
    'Generated by sync-docs. Edit the source above, then run',
    '`node scripts/sync-docs.mjs --apply`; do not edit this file. -->',
  ].join('\n');
}
const FRONTMATTER_PATTERN = /^(---\n[\s\S]*?\n---\n)/;
/**
 * Insert the generated-from banner into generated instruction content:
 * immediately after a leading YAML frontmatter block when one is present,
 * otherwise at the very top. The post-frontmatter content is kept verbatim, so
 * for the canonical `---\n…\n---\n\n#` layout its existing blank line separates
 * the banner from the content; a frontmatter-less file gets an explicit blank
 * line after the banner.
 */
export function injectGeneratedFromBanner(body, source) {
  const banner = generatedFromBanner(source);
  const frontmatter = FRONTMATTER_PATTERN.exec(body);
  if (frontmatter) {
    const front = frontmatter[1];
    // Keep the post-frontmatter content verbatim (do not collapse its leading
    // blank line) so strip is a true inverse for every frontmatter shape. For
    // the canonical `---\n…\n---\n\n#` layout the leading blank line of `rest`
    // supplies the blank after the banner, reproducing the same bytes as before.
    const rest = body.slice(front.length);
    return `${front}\n${banner}\n${rest}`;
  }
  return `${banner}\n\n${body}`;
}
/**
 * Remove a generated-from banner previously injected by
 * `injectGeneratedFromBanner`. Exact inverse: `strip(inject(x)) === x` for both
 * the frontmatter and no-frontmatter shapes. Used to compare generated content
 * against its banner-free source and to exclude the banner from byte budgets; a
 * no-op on content that carries no banner at the recognized position.
 */
export function stripGeneratedFromBanner(body) {
  const frontmatter = FRONTMATTER_PATTERN.exec(body);
  if (frontmatter) {
    const front = frontmatter[1];
    const after = body.slice(front.length);
    // Inverse of the frontmatter inject: drop the leading `\n`, the banner
    // block, and its terminating `\n`, leaving the original post-frontmatter
    // content byte-for-byte.
    return (
      front +
      after.replace(new RegExp(`^\\n${GENERATED_FROM_BANNER_BODY}\\n`), '')
    );
  }
  // Inverse of the top-of-file inject: drop the banner block and its blank line.
  return body.replace(new RegExp(`^${GENERATED_FROM_BANNER_BODY}\\n\\n`), '');
}
/**
 * Return the exact generated-from banner block (opener line through the closing
 * `-->`) at its recognized position — the very top, or immediately after a
 * frontmatter block — or `null` when none is present there. A banner-shaped
 * comment anywhere else in the body is deliberately not matched, so a misplaced
 * banner is reported as missing rather than silently accepted.
 */
export function extractGeneratedFromBanner(body) {
  const frontmatter = FRONTMATTER_PATTERN.exec(body);
  // After a frontmatter block the inject adds a single leading `\n`; at the top
  // there is none. Anchor with `^\n?` so only an in-position banner matches.
  const scope = frontmatter ? body.slice(frontmatter[1].length) : body;
  const match = new RegExp(`^\\n?(${GENERATED_FROM_BANNER_BODY})`).exec(scope);
  return match ? match[1] : null;
}
/**
 * Extract the source path an in-position generated-from banner names (the line
 * after the opener), or `null` when the body carries no well-formed banner in
 * the recognized position.
 */
export function parseGeneratedFromBannerSource(body) {
  const banner = extractGeneratedFromBanner(body);
  return banner ? (banner.split('\n')[1] ?? null) : null;
}
/**
 * Collect generated-from banner violations for the banner-scoped instruction
 * targets among `pairs`: a missing, malformed, or wrong-source banner. Pure (no
 * direct I/O) so it can be unit-tested; the audit pipeline supplies the reader.
 * Content drift is covered separately by the sync-pair content comparison.
 */
export function collectGeneratedFromBannerViolations(pairs, readFile) {
  if (!Array.isArray(pairs)) {
    return [];
  }
  const errors = [];
  for (const pair of pairs) {
    const target = String(pair?.target ?? '');
    const source = String(pair?.source ?? '');
    const mode = String(pair?.mode ?? '');
    const id = pair?.id != null ? String(pair.id) : 'sync-pair';
    if (!isBannerScopedInstructionTarget(target, mode)) {
      continue;
    }
    const text = String(readFile(target) ?? '');
    // Extract the banner at its recognized position and compare that exact
    // block, so a canonical banner copy-pasted elsewhere in the file cannot mask
    // a missing or malformed in-position banner.
    const banner = extractGeneratedFromBanner(text);
    if (banner === null) {
      errors.push(
        `${id}: ${target} is missing a well-formed idd-generated-from banner; run \`node scripts/sync-docs.mjs --apply\``,
      );
      continue;
    }
    const declaredSource = banner.split('\n')[1] ?? '';
    if (declaredSource !== source) {
      errors.push(
        `${id}: ${target} generated-from banner names ${declaredSource}, but its source is ${source}`,
      );
      continue;
    }
    if (banner !== generatedFromBanner(source)) {
      errors.push(
        `${id}: ${target} generated-from banner is malformed; run \`node scripts/sync-docs.mjs --apply\` to restore the canonical block for ${source}`,
      );
    }
  }
  return errors;
}
/**
 * Collect instruction size-budget violations. Pure (no direct I/O) so it
 * can be unit-tested; the audit pipeline supplies a path lister and a file
 * reader.
 *
 * Scope rule (mirrors checkPairedChange): the budget is scoped to the
 * files changed against the git comparison base. When `changedFiles` is
 * `null` (no resolvable base — e.g. a CI clone without `origin/main`) the
 * check is skipped with a notice rather than auditing every instruction
 * file, which would let an unrelated PR fail on a file it never touched.
 *
 * `listFiles` is only invoked when a base resolves, and `readFile` is
 * invoked only for files in `changedFiles`, so unchanged files are never
 * read (the audit reads from disk, so reading every match would be wasted
 * I/O on large repos).
 */
export function collectInstructionSizeBudgetViolations(
  config,
  changedFiles,
  listFiles,
  readFile,
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
  // `??` only substitutes on null/undefined, so a manifest typo (a string
  // where a number belongs, a non-positive limit, an unclosed regex group)
  // used to flow straight through: a non-numeric limit coerced every size
  // comparison to `NaN`, which is always false, silently passing the guard
  // it exists to enforce (fail-open); a malformed pattern threw an unhandled
  // `SyntaxError` from `new RegExp` instead of naming the bad field. Reject
  // both explicitly, naming the offending field and value (#1721).
  // `=== undefined` (not `??`) so an explicit `null` in the manifest is
  // validated and rejected below rather than silently treated the same as
  // "field not provided" and defaulted -- the same undefined-only-default
  // distinction normalizePositiveIntegerBudget already makes for the two
  // limit fields.
  const alwaysLoadedPatternValue =
    config.alwaysLoadedPattern === undefined
      ? 'applyTo:\\s*"\\*\\*"'
      : config.alwaysLoadedPattern;
  if (typeof alwaysLoadedPatternValue !== 'string') {
    return {
      errors: [
        `${id}: alwaysLoadedPattern must be a string (got ${JSON.stringify(alwaysLoadedPatternValue)})`,
      ],
      notices: [],
    };
  }
  let alwaysLoadedRegex;
  try {
    alwaysLoadedRegex = new RegExp(alwaysLoadedPatternValue, 'm');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      errors: [
        `${id}: alwaysLoadedPattern ${JSON.stringify(alwaysLoadedPatternValue)} does not compile as a regular expression: ${message}`,
      ],
      notices: [],
    };
  }
  const alwaysLoadedLimitBytes = normalizePositiveIntegerBudget(
    config.alwaysLoadedLimitBytes,
    20_000,
  );
  if (alwaysLoadedLimitBytes === null) {
    return {
      errors: [
        `${id}: alwaysLoadedLimitBytes must be a positive integer (got ${JSON.stringify(config.alwaysLoadedLimitBytes)})`,
      ],
      notices: [],
    };
  }
  const phaseLimitBytes = normalizePositiveIntegerBudget(
    config.phaseLimitBytes,
    30_000,
  );
  if (phaseLimitBytes === null) {
    return {
      errors: [
        `${id}: phaseLimitBytes must be a positive integer (got ${JSON.stringify(config.phaseLimitBytes)})`,
      ],
      notices: [],
    };
  }
  const errors = [];
  for (const path of listFiles()) {
    if (!changedFiles.has(path)) {
      continue;
    }
    const text = String(readFile(path) ?? '');
    // Exclude the generated-from banner from the measured size: it is mechanical
    // metadata sync-docs stamps in, not authored content, so it must never
    // consume an author's byte budget. The frontmatter (which the
    // always-loaded probe reads) is untouched by the strip.
    const bytes = Buffer.byteLength(stripGeneratedFromBanner(text), 'utf8');
    const alwaysLoaded = alwaysLoadedRegex.test(text);
    const limit = alwaysLoaded ? alwaysLoadedLimitBytes : phaseLimitBytes;
    if (bytes > limit) {
      errors.push(
        `${id}: ${path} is ${bytes} bytes (limit ${limit}; ${alwaysLoaded ? 'always-loaded' : 'phase'})`,
      );
    }
  }
  return { errors, notices: [] };
}
/**
 * Collect "documentation budget drift" violations: a hardcoded byte value in a
 * guarded doc that no longer matches any current `audit/sync-manifest.json`
 * budget. Content-mirror checks only compare doc copies to each other, so a
 * number that drifts from the *manifest* (the source of truth) passes them —
 * this guard is the missing cross-check.
 *
 * Pure (no direct I/O) so it can be unit-tested; the audit pipeline supplies
 * the reader. Unlike `collectInstructionSizeBudgetViolations` this runs
 * unconditionally rather than scoped to changed files: the drift is triggered
 * by editing the manifest (which leaves the doc file unchanged), so a
 * doc-scoped check would miss a manifest-only budget bump.
 *
 * The valid set is the *union* of all current budget values, so the guard
 * verifies membership, not position: it catches a value that drifted away from
 * every budget (the manifest-bumped / doc-stale case this targets), but a
 * value mislabeled with a *different* budget's number still passes — acceptable
 * for the drift this guards.
 *
 * `sizeBudgets` accepts either a single budget object (legacy shape) or an
 * array of them — `instructionSizeBudgets` in `audit/sync-manifest.json` is
 * an array of one entry per audited glob (dogfooding copy, `idd-template`
 * source, …; see `audit/README.md#instruction-size-budgets`) — and unions
 * every entry's `alwaysLoadedLimitBytes` / `phaseLimitBytes` into the same
 * valid-value set, so a doc may cite any configured glob's limit without
 * drifting.
 *
 * Matching requires a `bytes` suffix, so a doc that reads its limits live via
 * `jq` carries no hardcoded number and is never flagged. The configured
 * `files` must therefore not contain non-budget "N bytes" prose, or it would
 * false-positive; keep the list tight.
 */
export function collectDocBudgetDriftViolations(
  config,
  sizeBudgets,
  bundleBudgets,
  readFile,
) {
  if (!config) {
    return { errors: [], notices: [] };
  }
  const id = config.id ?? 'doc-budget-drift';
  // Build the valid-value set only from manifest budgets actually present;
  // never re-apply a default (a `?? 30000` fallback would let the set hold a
  // value the manifest no longer declares, producing a false positive).
  const validValues = new Set();
  const budgetEntries = Array.isArray(sizeBudgets)
    ? sizeBudgets
    : sizeBudgets
      ? [sizeBudgets]
      : [];
  for (const budget of budgetEntries) {
    if (typeof budget?.alwaysLoadedLimitBytes === 'number') {
      validValues.add(budget.alwaysLoadedLimitBytes);
    }
    if (typeof budget?.phaseLimitBytes === 'number') {
      validValues.add(budget.phaseLimitBytes);
    }
  }
  for (const budget of bundleBudgets ?? []) {
    const limit = Number(budget.limitBytes);
    if (Number.isFinite(limit)) {
      validValues.add(limit);
    }
  }
  if (validValues.size === 0) {
    return {
      errors: [],
      notices: [
        `${id}: skipped doc budget guard because no manifest budget values were available`,
      ],
    };
  }
  const sortedValid = [...validValues].sort((a, b) => a - b).join(', ');
  const errors = [];
  for (const path of config.files ?? []) {
    const text = String(readFile(path) ?? '');
    // Capture group 1 is the documented number; the `bytes` suffix keeps
    // `\d{4,}` from matching years or issue numbers. Compare as integers so a
    // comma-grouped doc value matches a plain manifest number.
    for (const match of text.matchAll(
      /(\d{1,3}(?:,\d{3})+|\d{4,})\s*bytes?\b/gi,
    )) {
      const documented = match[1];
      if (!validValues.has(Number(documented.replace(/,/g, '')))) {
        errors.push(
          `${id}: ${path} states ${documented} bytes, which is not a current sync-manifest budget value (valid: ${sortedValid}); update the doc to a live value or read it via jq`,
        );
      }
    }
  }
  return { errors, notices: [] };
}
/**
 * Collect duplicate `syncPairs` target violations. Pure (no I/O) so it can be
 * unit-tested and shared between the docs audit and sync-docs.
 *
 * `sync-docs` only applies the first occurrence of each target, so a second
 * entry for the same target is silently skipped and becomes dead data: editing
 * one copy of a divergent pair leaves the ignored copy stale and misleading.
 * Flagging duplicates turns that latent authoring hazard into a hard failure.
 */
export function collectDuplicateSyncPairTargets(syncPairs) {
  if (!Array.isArray(syncPairs)) {
    return [];
  }
  const seen = new Set();
  const violations = [];
  for (const pair of syncPairs) {
    const target = pair?.target;
    // Only string targets participate: a missing or non-string target is an
    // invalid entry, not a duplicate, and coercing it (e.g. an object to
    // "[object Object]") would manufacture confusing false positives.
    if (typeof target !== 'string' || target === '') {
      continue;
    }
    if (seen.has(target)) {
      const id = typeof pair?.id === 'string' ? pair.id : '';
      violations.push(
        `syncPairs: duplicate target "${target}" (pair "${id}"); each syncPairs target must appear exactly once — a duplicate is silently skipped and becomes dead data`,
      );
      continue;
    }
    seen.add(target);
  }
  return violations;
}
/**
 * Parses `^<low>.<x>.<y> || >=<high>.<x>.<y>` -- the only shape this
 * repository's `engines.node` has ever used -- into its two version
 * bounds. Returns null when the range doesn't match that exact shape
 * (fail closed rather than guess at a different range grammar).
 */
function parseTwoClauseEnginesRange(engines) {
  const match = /^\^(\d+\.\d+\.\d+)\s*\|\|\s*>=(\d+\.\d+\.\d+)$/.exec(
    engines.trim(),
  );
  return match ? { low: match[1], high: match[2] } : null;
}
export function collectEnginesRangeMirrorViolations(
  enginesNode,
  mirrors,
  readText,
) {
  const engines = typeof enginesNode === 'string' ? enginesNode.trim() : '';
  if (!engines) {
    return [
      'engines-range-mirrors: package.json engines.node is missing or not a string',
    ];
  }
  const bounds = parseTwoClauseEnginesRange(engines);
  const violations = [];
  if (!bounds) {
    violations.push(
      `engines-range-mirrors: engines.node "${engines}" does not match the expected "^<low> || >=<high>" shape; cannot verify mirrors`,
    );
  }
  for (const mirror of mirrors) {
    let text;
    try {
      text = readText(mirror.file);
    } catch {
      violations.push(
        `engines-range-mirrors: ${mirror.file}: could not be read`,
      );
      continue;
    }
    switch (mirror.mode) {
      case 'full-range':
        if (!text.includes(engines)) {
          violations.push(
            `engines-range-mirrors: ${mirror.file} does not contain the current engines.node range "${engines}"`,
          );
        }
        break;
      case 'components':
        if (
          bounds &&
          (!text.includes(bounds.low) || !text.includes(bounds.high))
        ) {
          violations.push(
            `engines-range-mirrors: ${mirror.file} does not mention both engines.node bounds "${bounds.low}" and "${bounds.high}"`,
          );
        }
        break;
      case 'low-bound-line':
        if (bounds && text.trim() !== bounds.low) {
          violations.push(
            `engines-range-mirrors: ${mirror.file} pins "${text.trim()}", expected the engines.node low bound "${bounds.low}"`,
          );
        }
        break;
      case 'low-bound-contains':
        if (bounds && !text.includes(bounds.low)) {
          violations.push(
            `engines-range-mirrors: ${mirror.file} does not mention the engines.node low bound "${bounds.low}"`,
          );
        }
        break;
    }
  }
  return violations;
}
export function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
export function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    source += escapeRegExpChar(char);
  }
  return new RegExp(`${source}$`);
}
function escapeRegExpChar(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, '\\$&');
}
/** Matches `pattern` against a caller-supplied repo file list. */
export function globFiles(pattern, repoFiles) {
  const regex = globToRegExp(pattern);
  return repoFiles.filter((file) => regex.test(file)).sort();
}
/**
 * Resolves a `generatedBlocks[]` entry's file list: the static `paths`
 * list when present, otherwise every repo file matching `sourceGlobs`
 * (deduped and sorted). `globFilesFn` is injected so each caller supplies
 * its own file listing instead of re-implementing the glob walk.
 */
export function resolveGeneratedBlockFiles(block, globFilesFn) {
  if (block.paths) {
    return [...block.paths];
  }
  return uniqueSorted((block.sourceGlobs ?? []).flatMap(globFilesFn));
}
/**
 * Extract `type` / `title` / `description` from a page's OKF frontmatter,
 * or `null` when the opening frontmatter block is missing or any of the
 * three fields is empty/non-scalar. Pure and unit-testable.
 */
export function extractOkfIndexFields(text) {
  const match = OKF_FRONTMATTER_PATTERN.exec(String(text ?? ''));
  if (!match) return null;
  const fields = parseOkfFrontmatterFields(match[1] ?? '');
  const type = typeof fields.type === 'string' ? fields.type.trim() : '';
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const description =
    typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!type || !title || !description) return null;
  return { type, title, description };
}
/**
 * Build deterministic OKF index rows from repo-relative paths.
 * Skips `excludePaths`, reserved basenames when listed there, and pages
 * whose frontmatter cannot supply type/title/description. Groups by
 * `typeOrder` (unknown types sort after known ones, alphabetically),
 * then by path within a group.
 */
export function buildOkfIndexRows(files, readFile, options = {}) {
  const exclude = new Set(
    (options.excludePaths ?? []).map((p) => String(p).replace(/\\/g, '/')),
  );
  const typeOrder = (options.typeOrder ?? []).map(String);
  const typeRank = new Map(typeOrder.map((t, i) => [t, i]));
  const rows = [];
  for (const rawPath of files) {
    const path = String(rawPath).replace(/\\/g, '/');
    if (exclude.has(path)) continue;
    let text;
    try {
      text = readFile(path);
    } catch {
      continue;
    }
    const fields = extractOkfIndexFields(text);
    if (!fields) continue;
    rows.push({ path, ...fields });
  }
  rows.sort((a, b) => {
    const ra = typeRank.get(a.type);
    const rb = typeRank.get(b.type);
    const rankA = ra === undefined ? typeOrder.length : ra;
    const rankB = rb === undefined ? typeOrder.length : rb;
    if (rankA !== rankB) return rankA - rankB;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.path.localeCompare(b.path);
  });
  return rows;
}
/**
 * Render an OKF index as a Markdown table. Links are relative to
 * `linkBase` (e.g. `docs` → `docs/foo.md` becomes `foo.md`). Pure.
 */
export function renderOkfIndexMarkdownTable(rows, linkBase = 'docs') {
  const base = String(linkBase ?? 'docs')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const prefix = `${base}/`;
  const header = '| Type | Page | Description |\n| ---- | ---- | ----------- |';
  // Wrap in dprint-ignore so the formatter cannot re-pad table cells and
  // make the audit-docs exact-string check fail on every apply (#1683).
  const openIgnore = '<!-- dprint-ignore-start -->';
  const closeIgnore = '<!-- dprint-ignore-end -->';
  if (rows.length === 0) {
    return `\n\n${openIgnore}\n${header}\n${closeIgnore}\n\n`;
  }
  const body = rows
    .map((row) => {
      const href = row.path.startsWith(prefix)
        ? row.path.slice(prefix.length)
        : row.path;
      // Escape pipe characters in cell text so a description containing
      // `|` cannot break the table.
      const type = row.type.replace(/\|/g, '\\|');
      const title = row.title.replace(/\|/g, '\\|');
      const description = row.description.replace(/\|/g, '\\|');
      return `| ${type} | [${title}](${href}) | ${description} |`;
    })
    .join('\n');
  return `\n\n${openIgnore}\n${header}\n${body}\n${closeIgnore}\n\n`;
}
// Anchored at the very start of the file; a frontmatter block anywhere else
// does not count -- OKF/YAML frontmatter must open the document.
const OKF_FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
// A single `#` immediately followed by whitespace is level 1; `##` and
// deeper never match because the second `#` is not whitespace. The
// optional closing sequence requires at least one preceding whitespace
// character (CommonMark's own ATX closing-sequence rule), so a title that
// legitimately ends in `#` (e.g. "Guide to C#") keeps that character
// instead of having it stripped as a false closing sequence.
const OKF_H1_PATTERN = /^#\s+(.+?)(?:\s+#+)?\s*$/;
/**
 * Minimal frontmatter-field parser for the OKF conformance checker. Only
 * supports the shapes the field profile actually uses: a flat `key: value`
 * scalar (optionally single/double-quoted), an inline list (`key: [a, b]`),
 * and a block list (`key:` followed by indented `- item` lines). This
 * repo's OKF frontmatter never needs more than that, so pulling in a full
 * YAML parser would be unused surface the bare-node boundary does not need
 * -- mirrors `parseMarkdownlintIgnores`'s reasoning in
 * audit-code-span-wrap.mts.
 */
function parseOkfFrontmatterFields(inner) {
  const lines = inner.split('\n');
  const fields = {};
  let index = 0;
  while (index < lines.length) {
    const keyMatch = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!keyMatch) {
      index += 1;
      continue;
    }
    const [, key, rawRest] = keyMatch;
    const rest = rawRest.trim();
    if (rest === '') {
      const items = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        // YAML permits a block sequence at the same indentation as its
        // mapping key (zero-indent), so the leading whitespace before `-`
        // is optional here -- only requiring `\s+` would silently miss
        // that valid form and leave `items` empty. The trailing `\s+`
        // (not `\s*`) keeps a scalar like `-foo` from being misread as a
        // list item.
        const itemMatch = /^\s*-\s+(.*)$/.exec(lines[cursor]);
        if (!itemMatch) {
          break;
        }
        items.push(unquoteOkfScalar(itemMatch[1].trim()));
        cursor += 1;
      }
      fields[key] = items.length > 0 ? items : '';
      index = cursor > index + 1 ? cursor : index + 1;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const listInner = rest.slice(1, -1).trim();
      fields[key] =
        listInner.length === 0
          ? []
          : listInner.split(',').map((item) => unquoteOkfScalar(item.trim()));
      index += 1;
      continue;
    }
    fields[key] = unquoteOkfScalar(rest);
    index += 1;
  }
  return fields;
}
function unquoteOkfScalar(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
/**
 * Extract the page's first top-level (`# `) heading text, skipping fenced
 * code blocks, or `null` when none is present. Mirrors the fence-aware scan
 * `headingSignature` in audit-docs.mts uses, scoped to the first H1 only --
 * the OKF `title` field must match exactly this heading.
 */
function extractOkfFirstH1(text) {
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const match = OKF_H1_PATTERN.exec(line);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}
/**
 * Check one in-scope page's full text against the OKF field profile.
 * Returns `null` when it conforms, or a human-readable reason when it does
 * not -- callers append this to a `${bundleId}: ${file} ${reason}` message.
 */
function checkOkfPageConformance(text, typeSet) {
  const match = OKF_FRONTMATTER_PATTERN.exec(text);
  if (!match) {
    return 'has no parseable YAML frontmatter block';
  }
  const fields = parseOkfFrontmatterFields(match[1]);
  const type = typeof fields.type === 'string' ? fields.type.trim() : '';
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const description =
    typeof fields.description === 'string' ? fields.description.trim() : '';
  if (!type) {
    return 'frontmatter is missing a non-empty "type" field';
  }
  if (!title) {
    return 'frontmatter is missing a non-empty "title" field';
  }
  if (!description) {
    return 'frontmatter is missing a non-empty "description" field';
  }
  if (!typeSet.has(type)) {
    return `frontmatter "type: ${type}" is not in the configured types list`;
  }
  // Scan only the post-frontmatter body for the H1: a plain (unindented)
  // YAML comment line inside the frontmatter block, e.g. `# a note`, would
  // otherwise match the same `# ` heading pattern and be misread as the
  // page's H1, producing a false "title does not match" failure even when
  // the real body heading agrees with `title`.
  const h1 = extractOkfFirstH1(text.slice(match[0].length));
  if (h1 === null) {
    return 'has no top-level "# " heading to compare against frontmatter "title"';
  }
  if (title !== h1) {
    return `frontmatter "title: ${title}" does not match the page's "# ${h1}" heading`;
  }
  if (Object.hasOwn(fields, 'tags')) {
    const tags = fields.tags;
    const isValidTagList =
      Array.isArray(tags) &&
      tags.every((tag) => typeof tag === 'string' && tag.trim().length > 0);
    if (!isValidTagList) {
      return 'frontmatter "tags" must be a YAML list of non-empty strings';
    }
  }
  return null;
}
/**
 * Collect OKF frontmatter conformance violations for every `okfBundles[]`
 * manifest entry (#1680). Pure (no direct I/O) so it can be unit-tested
 * with synthetic fixtures; the audit pipeline supplies `repoFiles`,
 * `listFiles` (bound to the live glob against `repoFiles`), and `readFile`.
 *
 * Fail-closed by construction: a file under a configured root is checked
 * unless it is a reserved filename or already listed in `exemptPaths`, so a
 * newly added page is enforced by default. `exemptPaths` entries are
 * themselves validated: an entry naming a file outside every configured
 * root (missing, mistyped, or never in scope) or a file that now conforms
 * (a stale exemption a later backfill track forgot to remove) is reported.
 */
export function collectOkfFrontmatterViolations(bundles, listFiles, readFile) {
  if (!Array.isArray(bundles)) {
    return [];
  }
  const errors = [];
  for (const bundle of bundles) {
    const bundleId = bundle.id;
    const id =
      typeof bundleId === 'string' && bundleId.length > 0
        ? bundleId
        : 'okf-bundle';
    const bundleRoots = bundle.roots;
    const roots = Array.isArray(bundleRoots)
      ? bundleRoots.filter(
          (root) => typeof root === 'string' && root.length > 0,
        )
      : [];
    if (roots.length === 0) {
      errors.push(
        `${id}: roots must be a non-empty array of directory strings`,
      );
      continue;
    }
    const bundleTypes = bundle.types;
    const types = Array.isArray(bundleTypes)
      ? bundleTypes.filter(
          (type) => typeof type === 'string' && type.length > 0,
        )
      : [];
    if (types.length === 0) {
      errors.push(`${id}: types must be a non-empty array of type strings`);
      continue;
    }
    const typeSet = new Set(types);
    const bundleReservedFilenames = bundle.reservedFilenames;
    const reservedFilenames = new Set(
      Array.isArray(bundleReservedFilenames)
        ? bundleReservedFilenames.filter(
            (name) => typeof name === 'string' && name.length > 0,
          )
        : [],
    );
    const bundleExemptPaths = bundle.exemptPaths;
    const rawExemptPaths = Array.isArray(bundleExemptPaths)
      ? bundleExemptPaths
      : [];
    const exemptPaths = rawExemptPaths.filter(
      (path) => typeof path === 'string' && path.length > 0,
    );
    if (exemptPaths.length !== rawExemptPaths.length) {
      errors.push(
        `${id}: exemptPaths must be an array of non-empty path strings`,
      );
    }
    const exemptSet = new Set(exemptPaths);
    const files = uniqueSorted(
      roots.flatMap((root) => listFiles(`${root}/**/*.md`)),
    );
    const inScopeFileSet = new Set(files);
    for (const file of files) {
      const basename = file.slice(file.lastIndexOf('/') + 1);
      if (reservedFilenames.has(basename)) {
        // A reserved filename is never checked for conformance, so an
        // exemptPaths entry naming one is dead configuration -- neither
        // the "now conforms" branch below nor the exemptPaths-existence
        // loop after this one would ever catch it, since the latter only
        // checks scope membership, not reserved-ness. Report it here,
        // the only place that still has both facts in hand.
        if (exemptSet.has(file)) {
          errors.push(
            `${id}: exemptPaths names ${file}, which is a reserved filename and is never checked; remove the redundant exemption`,
          );
        }
        continue;
      }
      const reason = checkOkfPageConformance(readFile(file), typeSet);
      if (exemptSet.has(file)) {
        if (reason === null) {
          errors.push(
            `${id}: exemptPaths names ${file}, which now conforms to the OKF profile; remove the stale exemption`,
          );
        }
        continue;
      }
      if (reason !== null) {
        errors.push(`${id}: ${file} ${reason}`);
      }
    }
    for (const exempt of exemptPaths) {
      if (!inScopeFileSet.has(exempt)) {
        errors.push(
          `${id}: exemptPaths names ${exempt}, which does not exist under a configured root`,
        );
      }
    }
  }
  return errors;
}
