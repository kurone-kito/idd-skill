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

export interface RootMarkdownAllowlistConfig {
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

/** Declarative config for the type-suppression budget guard. */
export interface TypeSuppressionBudgetConfig {
  id?: unknown;
  description?: unknown;
  globs?: unknown;
  tsExpectErrorLimit?: unknown;
  explicitAnyLimit?: unknown;
}

/** One scanned file: repo-relative path plus its full text. */
export interface TypeSuppressionFileInput {
  path: string;
  text: string;
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
export function collectTypeSuppressionViolations(
  files: readonly TypeSuppressionFileInput[],
  config: TypeSuppressionBudgetConfig | null | undefined,
): string[] {
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

  const violations: string[] = [];
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

function normalizeBudgetLimit(value: unknown): number | null {
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
function stripCommentsAndStrings(text: string): string {
  let out = '';
  let i = 0;
  let state:
    | 'code'
    | 'line-comment'
    | 'block-comment'
    | 'single'
    | 'double'
    | 'template'
    | 'regex'
    | 'regex-class' = 'code';
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
function regexCanStartAfter(lastCodeChar: string, lastWord: string): boolean {
  if (lastCodeChar === '') {
    return true;
  }
  if (REGEX_PRECEDING_KEYWORDS.has(lastWord)) {
    return true;
  }
  return !/[\w$)\]'"`/]/.test(lastCodeChar);
}

/** Manifest config for the instruction size-budget audit. */
export interface InstructionSizeBudgetConfig {
  id?: string;
  glob?: string;
  alwaysLoadedPattern?: string;
  alwaysLoadedLimitBytes?: number;
  phaseLimitBytes?: number;
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
export function isBannerScopedInstructionTarget(
  target: string,
  mode: string,
): boolean {
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
export function generatedFromBanner(source: string): string {
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
export function injectGeneratedFromBanner(
  body: string,
  source: string,
): string {
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
export function stripGeneratedFromBanner(body: string): string {
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
 * Extract the source path a generated-from banner names (the line after the
 * opener), or `null` when the body carries no well-formed banner in the
 * expected position: the very top, or immediately after a frontmatter block. A
 * banner-shaped comment anywhere else in the body is deliberately not matched,
 * so a misplaced banner is reported as missing rather than silently accepted.
 */
export function parseGeneratedFromBannerSource(body: string): string | null {
  const frontmatter = FRONTMATTER_PATTERN.exec(body);
  // After a frontmatter block the inject adds a single leading `\n`; at the top
  // there is none. Anchor with `^\n?` so only an in-position banner matches.
  const scope = frontmatter ? body.slice(frontmatter[1].length) : body;
  const match = new RegExp(
    `^\\n?${GENERATED_FROM_BANNER_OPEN}\\n([^\\n]+)\\n[\\s\\S]*?-->`,
  ).exec(scope);
  return match ? match[1] : null;
}

/**
 * Collect generated-from banner violations for the banner-scoped instruction
 * targets among `pairs`: a missing, malformed, or wrong-source banner. Pure (no
 * direct I/O) so it can be unit-tested; the audit pipeline supplies the reader.
 * Content drift is covered separately by the sync-pair content comparison.
 */
export function collectGeneratedFromBannerViolations(
  pairs:
    | readonly {
        id?: unknown;
        source?: unknown;
        target?: unknown;
        mode?: unknown;
      }[]
    | null
    | undefined,
  readFile: (path: string) => string,
): string[] {
  if (!Array.isArray(pairs)) {
    return [];
  }
  const errors: string[] = [];
  for (const pair of pairs) {
    const target = String(pair?.target ?? '');
    const source = String(pair?.source ?? '');
    const mode = String(pair?.mode ?? '');
    const id = pair?.id != null ? String(pair.id) : 'sync-pair';
    if (!isBannerScopedInstructionTarget(target, mode)) {
      continue;
    }
    const text = String(readFile(target) ?? '');
    const declaredSource = parseGeneratedFromBannerSource(text);
    if (declaredSource === null) {
      errors.push(
        `${id}: ${target} is missing a well-formed idd-generated-from banner; run \`node scripts/sync-docs.mjs --apply\``,
      );
      continue;
    }
    if (declaredSource !== source) {
      errors.push(
        `${id}: ${target} generated-from banner names ${declaredSource}, but its source is ${source}`,
      );
      continue;
    }
    if (!text.includes(generatedFromBanner(source))) {
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
  config: InstructionSizeBudgetConfig | null | undefined,
  changedFiles: ReadonlySet<string> | null,
  listFiles: () => readonly string[],
  readFile: (path: string) => string,
): { errors: string[]; notices: string[] } {
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

  const errors: string[] = [];
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
        `${id}: ${path} is ${bytes} bytes (limit ${limit}; ${
          alwaysLoaded ? 'always-loaded' : 'phase'
        })`,
      );
    }
  }
  return { errors, notices: [] };
}

export interface DocBudgetGuardConfig {
  id?: string;
  files?: string[];
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
 * Matching requires a `bytes` suffix, so a doc that reads its limits live via
 * `jq` carries no hardcoded number and is never flagged. The configured
 * `files` must therefore not contain non-budget "N bytes" prose, or it would
 * false-positive; keep the list tight.
 */
export function collectDocBudgetDriftViolations(
  config: DocBudgetGuardConfig | null | undefined,
  sizeBudgets:
    | { alwaysLoadedLimitBytes?: number; phaseLimitBytes?: number }
    | null
    | undefined,
  bundleBudgets: readonly { limitBytes?: number | string }[] | undefined,
  readFile: (path: string) => string,
): { errors: string[]; notices: string[] } {
  if (!config) {
    return { errors: [], notices: [] };
  }
  const id = config.id ?? 'doc-budget-drift';

  // Build the valid-value set only from manifest budgets actually present;
  // never re-apply a default (a `?? 30000` fallback would let the set hold a
  // value the manifest no longer declares, producing a false positive).
  const validValues = new Set<number>();
  if (typeof sizeBudgets?.alwaysLoadedLimitBytes === 'number') {
    validValues.add(sizeBudgets.alwaysLoadedLimitBytes);
  }
  if (typeof sizeBudgets?.phaseLimitBytes === 'number') {
    validValues.add(sizeBudgets.phaseLimitBytes);
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
  const errors: string[] = [];
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
export function collectDuplicateSyncPairTargets(
  syncPairs: readonly { id?: unknown; target?: unknown }[] | null | undefined,
): string[] {
  if (!Array.isArray(syncPairs)) {
    return [];
  }
  const seen = new Set<string>();
  const violations: string[] = [];
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
