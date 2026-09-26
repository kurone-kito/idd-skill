#!/usr/bin/env node
// idd-generated-from: src/scripts/audit-dead-exports.mts
//
// The scripts/audit-dead-exports.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Issue #3478: flags a production export that is imported ONLY from a
// test file -- an out-of-the-box tool like `ts-prune`/`knip` treats any
// importer as "used" and would miss this class entirely (#3341 found
// three such exports, each with a dedicated test file exercising a route
// vocabulary the real production code never reaches).
//
// Scope (single-hop, per the issue's own "Deeper transitive-only-
// reachable-from-tests chains ... are out of scope" note): this audit
// asks only "who directly imports this export's name", never "who calls
// the function that imports it". Two refinements go beyond the issue's
// literal wording, both load-bearing -- disabling either turns this tool
// unusable (see the design-rationale block below each):
//
// 1. **Self-reference counts as production.** An export referenced
//    elsewhere in ITS OWN declaring file (e.g. a CLI's own
//    `main()`/`CRITERIA` table calling an exported-for-testability pure
//    function) is `production`, even with zero cross-file importers.
//    Without this, every helper migrated onto the `evaluate*`/`parseArgs`/
//    `renderCsv` pattern (~70 files in this repository) reports as
//    `test-only`, since its own unit test is often the only file that
//    imports it directly -- a live prototype run against this exact
//    worktree, pre-refinement, found 625 false `test-only` + 98 false
//    `unused` out of 1119 real exports; post-refinement, 44 and 24.
// 2. **Re-export chains are resolved to their origin.** `export { X }
//    from './y.mts'` and `export * from './y.mts'` (a barrel) are
//    pass-through, not a declaration -- classifying `y.mts`'s `X` must
//    also count an importer that wrote `import { X } from './z.mts'`
//    where `z.mts` re-exports `X` (directly or transitively) from
//    `y.mts`. `protocol-helpers.mts` re-exports both wholesale
//    (`export * from './marker-helpers.mts'`, wave 1 of #1209) and by
//    name (`DEFAULT_ADVISORY_BOT_LOGINS` from `advisory-wait-policy.mts`,
//    `isCopilotErrorReviewBody` from `copilot-review-body.mts`); several
//    other files re-export from `protocol-helpers.mts` in turn
//    (`review-clause.mts`, `disposition-non-review-notices.mts`,
//    `resolved-decision.mts`, `consistency-helpers.mts`). Without this,
//    real production callers that import through a barrel (the majority
//    of `marker-helpers.mts` consumers import via `protocol-helpers.mts`,
//    never `marker-helpers.mts` directly) read as phantom `unused`/
//    `test-only` findings.
//
// A namespace import (`import * as x from './y.mts'`) is treated as
// importing every name `y.mts` declares -- this repository has several
// (`marker-helpers-facade.test.mts` et al.), and there is no static way to
// tell which of `x`'s properties a later `x.someName` expression actually
// reaches without a real type checker, which this bare-node audit
// deliberately does not depend on (see the module-scope note below).
//
// Deliberately regex/line-based, not an AST parse: `docs/typescript-
// sources.md`'s bare-node CI lane runs `node --test tests/*.test.mts`
// with NO package-manager install, so this module (and its test file)
// may import only `node:` builtins -- the `typescript` devDependency is
// unavailable there. This mirrors the existing precedent in
// `audit-code-span-wrap.mts` and `markdown-link-audit.mts`.
//
// #3498 no-`from` `export { a [as b] };` list resolution -- SUPPORTED
// SYNTAX SET (explicit boundary, added after several C1 review rounds
// each found one more unhandled form): resolves the real declaration/
// import line for `a` when it is a bare or exported top-level
// `function`/`const`/`class` (including TypeScript overload signatures
// and single-line multi-declarator `const`), or a named, default,
// namespace, or combined default+named/namespace import (any specifier,
// relative or bare package, and a combined form's own comma-then-newline
// wrap before `{`/`* as` is recognized -- round 10). A form OUTSIDE this
// set -- a multi-line multi-declarator `const`, a regex-literal or
// generic-angle-bracket initializer confusing the declarator scan,
// `let`/`var`, a destructuring declarator, a wrap between `import` and a
// default identifier or between `as` and a namespace identifier (no real
// formatter chooses those break points), or any other syntax this list
// does not name -- falls back to the ORIGINAL, pre-#3498 behavior (the
// export statement's own line, which can misclassify the export as
// `production`): a documented, accepted limitation, not a defect to keep
// chasing. See `scanBareConstDeclarators`'s own doc comment for the
// specific AST-ambiguity cases (regex vs. division, generic vs.
// comparison) that are deliberately rejected rather than guessed at.

// #3240: side-effect-only import, kept first so an unsupported Node fails
// loudly before this entry block runs. See node-runtime-guard.mts.
import './node-runtime-guard.mts';

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

/** One production export's classification. */
export type DeadExportCategory = 'production' | 'test-only' | 'unused';

/** A single declared, top-level, named `function`/`const`/`class` export. */
export interface DeclaredExport {
  /** The exported identifier. */
  name: string;
  /** Repo-relative (posix) path of the file that declares it. */
  file: string;
  /** 1-based source line of the real INTRODUCING statement -- for a
   * no-`from` `export {}` list item, its underlying
   * `function`/`const`/`class` declaration's own line, or a named
   * import's own line when the re-exported local name is only imported
   * (never declared) in this file, falling back to the export
   * statement's own list-item line only when neither was found (#3498). */
  line: number;
  category: DeadExportCategory;
  /** `true` when a well-formed `audit:ignore-dead-export` comment covers it. */
  suppressed: boolean;
  /** The suppression comment's optional `: reason` text, trimmed. */
  suppressionReason: string;
}

export interface DeadExportAuditResult {
  /** Every declared export, in file-then-name order. */
  all: DeclaredExport[];
  /** `all` filtered to unsuppressed `test-only`/`unused` entries. */
  findings: DeclaredExport[];
}

// The suppression marker (#3478 Proposed change step 6), mirroring
// `markdown-link-audit.mts`'s `IGNORE_MARKER_PATTERN` convention one
// syntax family over (a `//` line comment, not an HTML comment, since
// `.mts` has no HTML-comment syntax): well-formed only, so a longer,
// unrelated comment that merely starts with this text never suppresses a
// real finding. For a `function`/`const`/`class` declaration, it may sit
// on the declaration's own line OR, since a multi-line signature makes
// that cramped, as a standalone comment on the line immediately above the
// declaration. For an `export { a, b };` no-`from` list item, it is
// recognized on that item's own physical line (see `parseBracedItems`)
// AND, since #3498, on the resolved real declaration's own line -- either
// one suppresses the finding (see `declarationSuppressionByLocalName` in
// `parseFile`).
const IGNORE_EXPORT_PATTERN =
  /\/\/\s*audit:ignore-dead-export(?::\s*(.*))?\s*$/;

const RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//;

interface ReExportEdge {
  /** The name THIS file exposes downstream -- what a consumer's
   * `import { name } from` this file must match -- or `'*'` for a
   * whole-module barrel/namespace. Equal to `sourceName` unless the
   * re-export renames via `as` (`export { x as y } from './foo'` exposes
   * `y` here). */
  name: string;
  /** The name to look up in `targetFile` -- equal to `name` unless an
   * `as` alias renamed it (`x` in the example above). Meaningless when
   * `name` is `'*'`: a barrel re-export always looks up whatever name the
   * consumer requested, never a fixed identifier. */
  sourceName: string;
  /** Absolute path of the re-export's `from` target. */
  targetFile: string;
}

interface RawImport {
  /** The imported name, or `'*'` for a namespace import (imports every
   * name the target declares). */
  name: string;
  /** Absolute path of the import's resolved `from` target. */
  targetFile: string;
  /** Absolute path of the file containing this import statement. */
  importerFile: string;
}

interface ParsedFile {
  /** exposedName -> { line, suppressed, reason, localName,
   * selfReferenceExcludeLines } for this file's OWN declared exports
   * (function/const/class, plus any `export { a, b };` list with no
   * `from` clause). `exposedName` (the map key) is what a consumer's
   * `import { exposedName }` must match -- the `as` alias when the list
   * item renamed one, else the same as `localName`. `localName` is the
   * identifier the declaring file's OWN other code uses
   * (`hasSelfReference` needs this one, not the alias -- `export { a as
   * b };` still reads `a`, never `b`, inside this file). `line` is the
   * REAL introducing line when known (#3498): the underlying
   * `function`/`const`/`class` line for a no-`from` list item, or a named
   * import's own line when `localName` is only imported (never declared)
   * in this file, falling back to the export statement's own line only
   * when neither was found. `selfReferenceExcludeLines` is every line
   * that must NOT count as "elsewhere" for `hasSelfReference` -- normally
   * just `[line]`, but for a no-`from` list item it also includes the
   * export statement's own line (a SEPARATE statement from the real
   * declaration/import; re-exporting a name necessarily mentions it a
   * second time, which is not itself "wired into other code") and every
   * OTHER no-`from` item re-exporting the same local name elsewhere in
   * the file. */
  declared: Map<
    string,
    {
      line: number;
      suppressed: boolean;
      reason: string;
      localName: string;
      selfReferenceExcludeLines: readonly number[];
    }
  >;
  reExports: ReExportEdge[];
  imports: RawImport[];
}

/** Recursively lists every `.mts` file under `dir` (absolute paths). */
function listMtsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listMtsFilesRecursive(full));
    } else if (entry.isFile() && extname(entry.name) === '.mts') {
      out.push(full);
    }
  }
  return out.sort();
}

/**
 * Blanks out every block (`/* ... *\/`) and line (`//...`) comment,
 * replacing each removed character with a space (newlines are kept as
 * newlines) so the result has the exact same length and line structure as
 * `text` -- every later regex/line-number computation stays aligned with
 * the ORIGINAL source, while no structural regex below can ever match
 * text that only exists inside a comment.
 */
function blankOutComments(text: string): string {
  let result = '';
  let index = 0;
  const length = text.length;
  while (index < length) {
    const twoChars = text.slice(index, index + 2);
    if (twoChars === '/*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end + 2;
      for (let i = index; i < stop; i += 1) {
        result += text[i] === '\n' ? '\n' : ' ';
      }
      index = stop;
      continue;
    }
    if (twoChars === '//') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? length : end;
      result += ' '.repeat(stop - index);
      index = stop;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') {
      line += 1;
    }
  }
  return line;
}

/** Finds the index of the `}` matching the `{` at `openIndex`, scanning
 * `strippedText` (comments already blanked out, so a stray brace can never
 * hide inside one). Returns -1 when unbalanced. */
function findMatchingBrace(strippedText: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < strippedText.length; i += 1) {
    const char = strippedText[i];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** One bare `const` declarator's resolved name and its absolute offset
 * into the scanned text (for the caller to resolve its real line). */
interface BareConstDeclarator {
  name: string;
  offset: number;
}

/** #3498 (Codex/Copilot C1 findings, round 4; NARROWED after round 6):
 * scans a bare `const` statement's declarator list starting at
 * `declaratorListStart` (the absolute offset into `strippedText` right
 * after the `const ` keyword) and bounded to `scanEnd` (the CURRENT
 * physical line's own end offset -- never beyond it), tracking
 * bracket/paren/brace depth AND quote state so neither a declarator's
 * own initializer (`const a = foo(1, 2), b = 3;`) nor a comma inside a
 * string/template literal (`const text = 'x, helper';`) is mistaken for
 * a declarator boundary. Stops early at the first top-level (depth 0,
 * unquoted) `;`, or otherwise at `scanEnd`. Returns each declarator's
 * name and absolute offset -- the caller resolves the real 1-based line
 * via `lineNumberAt` (all declarators returned here share the same
 * line, since the scan never crosses a line boundary).
 *
 * **Deliberately single-line, not multi-line (round 6 revert).** An
 * earlier revision of this scanner searched forward across physical
 * lines for the terminating `;`, to also resolve a multi-declarator
 * list split across lines (`const a = 1,\n  b = 2;`). C1 review (Codex,
 * Copilot) found that this crossed into the FOLLOWING statement for
 * ordinary semicolonless (ASI) code (`const helper = 1\nexport { helper
 * };`), consuming the export statement into the scan and silently
 * dropping that export from the audit entirely -- a strictly worse
 * failure mode (real findings vanish) than the narrow multi-line-
 * declarator gap it closed (a finding is merely misclassified). Reverted
 * to single-line-only; a multi-line declarator list is an accepted,
 * out-of-scope limitation again (see the module header's "regex/line-
 * based, not an AST parse" note).
 *
 * A quoted span (single, double, or backtick) is treated as fully
 * OPAQUE text, including a template literal's own `${...}` interpolation
 * -- an accepted simplification: only a comma meant as a genuine
 * declarator separator INSIDE an interpolation expression (an
 * exceedingly rare construct) would be missed. **Also accepted, NOT
 * handled** (C1 review, round 6): a regex literal's own delimiters
 * (`const OPEN = /\{/;`) are not tracked as opaque, so a bracket
 * character inside one can corrupt `depth`; and a TypeScript generic
 * angle-bracket list (`<T, U>`) is not tracked as a depth-increasing
 * pair, so its own commas can be mistaken for declarator boundaries.
 * Both are the same class of ambiguity real JS/TS parsers resolve only
 * with full grammar context (regex-vs-division, generic-vs-comparison)
 * -- genuinely unsafe to guess at with a regex/line-based scanner, so
 * they stay accepted limitations rather than heuristics that could
 * silently misfire the other way. Destructuring declarators (`const {
 * a, b } = obj;`) stay out of scope too -- `BARE_CONST_DECL_PATTERN`
 * never matches them at all (no identifier immediately follows `const
 * `), a separate, pre-existing limitation this scanner does not extend
 * to. */
function scanBareConstDeclarators(
  strippedText: string,
  declaratorListStart: number,
  scanEnd: number,
): BareConstDeclarator[] {
  const declarators: BareConstDeclarator[] = [];
  let depth = 0;
  let quote: string | null = null;
  let segmentStart = declaratorListStart;
  const pushSegment = (segmentEnd: number) => {
    const raw = strippedText.slice(segmentStart, segmentEnd);
    const leading = raw.length - raw.trimStart().length;
    const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(raw.slice(leading));
    if (nameMatch) {
      declarators.push({
        name: nameMatch[1],
        offset: segmentStart + leading,
      });
    }
  };
  let i = declaratorListStart;
  for (; i < scanEnd; i += 1) {
    const char = strippedText[i];
    if (quote) {
      if (char === '\\') {
        i += 1; // skip the escaped character -- never its own quote/comma
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      pushSegment(i);
      segmentStart = i + 1;
    } else if (char === ';' && depth === 0) {
      pushSegment(i);
      return declarators;
    }
  }
  pushSegment(i);
  return declarators;
}

/** #3498: same own-line-or-preceding-line suppression check the exported
 * declaration branch already performs, parameterized to an arbitrary
 * resolved 1-based `realLineNumber` -- needed because a multi-declarator
 * `const` statement's declarators can each resolve to a DIFFERENT real
 * line (or, for a single bare declaration, the caller already knows
 * which line to check). */
function checkOwnOrPrecedingLineSuppression(
  originalText: string,
  lineStarts: readonly number[],
  realLineNumber: number,
): RegExpExecArray | null {
  const lineIndex = realLineNumber - 1;
  const ownStart = lineStarts[lineIndex];
  const ownEnd =
    lineIndex + 1 < lineStarts.length
      ? lineStarts[lineIndex + 1] - 1
      : originalText.length;
  const ownMatch = IGNORE_EXPORT_PATTERN.exec(
    originalText.slice(ownStart, ownEnd),
  );
  if (ownMatch) {
    return ownMatch;
  }
  if (lineIndex === 0) {
    return null;
  }
  const precedingStart = lineStarts[lineIndex - 1];
  const precedingEnd = ownStart - 1;
  return IGNORE_EXPORT_PATTERN.exec(
    originalText.slice(precedingStart, precedingEnd),
  );
}

interface BracedItem {
  /** The ORIGINAL exported/declared name -- e.g. `a` in `a as b` -- since
   * that is what identifies the export on its declaring file (an import's
   * local alias is irrelevant there; only a re-export's `from`-target
   * lookup and a no-`from` local declaration key care, and both read
   * `alias` below instead, falling back to this field when there is no
   * `as` clause). */
  name: string;
  /** The `b` in `a as b`, or `null` when the item has no `as` clause. This
   * is the name a CONSUMER of the containing export/import statement uses
   * -- for a re-export (`export { a as b } from './foo'`), it is what this
   * file exposes downstream as `b`, while `name` (`a`) is still what must
   * be looked up in `./foo`. #3478 review: losing this field entirely
   * (the prior design) broke re-export-chain resolution for any aliased
   * named re-export -- the origin declaration was never credited with the
   * alias's real importers. */
  alias: string | null;
  isType: boolean;
  line: number;
  suppressed: boolean;
  reason: string;
}

/** Splits the raw content between `{`/`}` (exclusive) on top-level commas
 * and parses each item's optional `type` prefix and `as alias`. */
function parseBracedItems(
  originalText: string,
  strippedText: string,
  contentStart: number,
  contentEnd: number,
): BracedItem[] {
  const items: BracedItem[] = [];
  const raw = strippedText.slice(contentStart, contentEnd);
  let cursor = 0;
  for (const chunk of raw.split(',')) {
    const chunkStart = contentStart + cursor;
    cursor += chunk.length + 1;
    const trimmed = chunk.trim();
    if (trimmed === '') {
      continue;
    }
    // #3498 (CodeRabbit C1 finding): `chunkStart` is the RAW split
    // boundary -- right after the opening `{` or the previous comma --
    // which for a multi-line list (each item on its own indented line)
    // lands on a DIFFERENT physical line than the item's own identifier
    // (the delimiter's line, not the name's). Skip the chunk's leading
    // whitespace/newline(s) to land on the identifier's actual first
    // character before computing its line -- both for `line` itself and
    // for the own-line suppression-comment lookup below.
    const itemStart = chunkStart + (chunk.length - chunk.trimStart().length);
    const isType = /^type\s+/.test(trimmed);
    const withoutType = trimmed.replace(/^type\s+/, '');
    const nameMatch = /^([A-Za-z_$][\w$]*)/.exec(withoutType);
    if (!nameMatch) {
      continue;
    }
    const name = nameMatch[1];
    const aliasMatch = /^\s+as\s+([A-Za-z_$][\w$]*)/.exec(
      withoutType.slice(nameMatch[0].length),
    );
    const alias = aliasMatch ? aliasMatch[1] : null;
    const line = lineNumberAt(strippedText, itemStart);
    const lineStart = originalText.lastIndexOf('\n', itemStart) + 1;
    const nextNewline = originalText.indexOf('\n', itemStart);
    const lineEnd = nextNewline === -1 ? originalText.length : nextNewline;
    const lineText = originalText.slice(lineStart, lineEnd);
    const ignoreMatch = IGNORE_EXPORT_PATTERN.exec(lineText);
    items.push({
      name,
      alias,
      isType,
      line,
      suppressed: !!ignoreMatch,
      reason: (ignoreMatch?.[1] ?? '').trim(),
    });
  }
  return items;
}

function resolveSpecifier(importerFile: string, specifier: string): string {
  return resolve(dirname(importerFile), specifier);
}

const FUNCTION_DECL_PATTERN =
  /^export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const CONST_DECL_PATTERN = /^export\s+const\s+([A-Za-z_$][\w$]*)/;
const CLASS_DECL_PATTERN =
  /^export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
// #3498: the no-`from` `export { a [as b] };` list branch below re-exports
// an already-declared LOCAL binding -- the common/idiomatic shape leaves
// the underlying `function`/`const`/`class` declaration itself WITHOUT an
// `export` keyword (the list statement is its only export), so the three
// patterns above (which all require a leading `export`) never record its
// real line. These bare variants exist solely to resolve that real
// declaration line for the no-`from` branch's deferred finalization pass
// (`declarationLineByLocalName.get(pending.localName)`, after the
// full-file loop) -- they never feed `declared` directly, so a plain
// unexported helper never becomes a phantom entry in the audit results.
const BARE_FUNCTION_DECL_PATTERN =
  /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const BARE_CONST_DECL_PATTERN = /^const\s+([A-Za-z_$][\w$]*)/;
const BARE_CLASS_DECL_PATTERN = /^(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/;
const TYPE_ONLY_STATEMENT_PATTERN = /^export\s+type\b/;
const INTERFACE_DECL_PATTERN = /^export\s+interface\b/;
const BARREL_STAR_PATTERN = /^export\s+\*\s+from\s*['"](\.[^'"]+)['"]/;
const EXPORT_BRACE_PATTERN = /^export\s*\{/;
const FROM_CLAUSE_AFTER_BRACE_PATTERN = /^\s*from\s*['"](\.[^'"]+)['"]/;

const IMPORT_TYPE_ONLY_STATEMENT_PATTERN = /^import\s+type\b/;
const IMPORT_BRACE_PATTERN = /^import\s*\{/;
// #3498 (Copilot C1 finding, round 6): the local BINDING name (capture 1)
// is what a later no-`from` `export { x as y };` list item's local-alias
// bookkeeping needs -- widened to a bare package specifier (capture 2),
// same reasoning as `IMPORT_FROM_AFTER_BRACE_PATTERN` below: only
// cross-file importer crediting is relative-only, never this file-local
// bookkeeping.
const IMPORT_NAMESPACE_PATTERN =
  /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/;
// #3498 (Copilot C1 finding, round 6): a default import (`import helper
// from './origin.mts';`) introduces a local binding the same way a
// named import does -- captures the local name (1) and the specifier
// (2), any specifier per the same round-4/round-6 reasoning as the
// patterns above. Never matches a namespace (`* as`) or brace (`{`)
// import, since neither `*` nor `{` can match the identifier-start
// character class immediately after `import\s+`.
const IMPORT_DEFAULT_PATTERN =
  /^import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/;
// #3498 (Copilot/Codex C1 finding, round 7): a COMBINED default +
// namespace import (`import def, * as ns from '...';`) introduces two
// local bindings on one line -- `IMPORT_DEFAULT_PATTERN` above never
// matches it (a comma, not `from`, follows the default identifier), and
// neither does `IMPORT_NAMESPACE_PATTERN` (no leading default identifier
// before `* as`). Captures the default name (1), namespace name (2), and
// specifier (3).
const IMPORT_DEFAULT_PLUS_NAMESPACE_PATTERN =
  /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/;
// #3498 (Copilot/Codex C1 finding, round 7): a COMBINED default + named
// import (`import def, { a, b } from '...';`) -- matches only the
// default-identifier-plus-comma PREFIX (up to and including the opening
// `{`); the named list itself is parsed separately by
// `processNamedImportBraceList`, mirroring how the plain brace branch
// locates its own `{` via `strippedText.indexOf`.
const IMPORT_DEFAULT_PLUS_BRACE_PATTERN =
  /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{/;
// #3498 (Codex C1 finding, round 4): unlike the `export ... from`
// patterns above (which only ever re-export FROM one of this repo's own
// relative files, so a leading dot is required), a named import's own
// local-alias bookkeeping below must run for a BARE package specifier
// too (`import { helper } from 'some-package';`) -- only the separate
// `RELATIVE_SPECIFIER_PATTERN` check at the call site decides whether
// the specifier can also be resolved for cross-file importer crediting.
const IMPORT_FROM_AFTER_BRACE_PATTERN = /^\s*from\s*['"]([^'"]+)['"]/;

/** Parses one `.mts` file's own top-level export declarations, re-export
 * edges, and import statements. `originalText` is used only for
 * suppression-comment text and self-reference scanning; every structural
 * match runs against `strippedText` (comments blanked out). */
function parseFile(absPath: string, originalText: string): ParsedFile {
  const strippedText = blankOutComments(originalText);
  const declared: ParsedFile['declared'] = new Map();
  const reExports: ReExportEdge[] = [];
  const imports: RawImport[] = [];
  // #3498: real INTRODUCING line(s) for every top-level local binding
  // name in this file -- a `function`/`const`/`class` declaration
  // (exported or bare; see the bare-pattern comment above), a named
  // import's local alias, a default import, or a namespace import's own
  // binding (a no-`from` list item can re-export a name this file only
  // ever imported, never declared -- Copilot C1 finding). Populated
  // alongside `declared` below; consulted only when finalizing a
  // no-`from` export-list item (after the full-file loop below, not
  // inline) to resolve its `declarationLine`.
  //
  // An array, not a single line (Codex C1 finding, round 6): a bare
  // FUNCTION specifically can have multiple TypeScript overload
  // signature lines (`function helper(a: number): void; function
  // helper(a: string): void; function helper(a) { ... }`) sharing one
  // name -- every one of them mentions the name, so a no-`from` item
  // resolving to only the FIRST such line would still see the other
  // overload lines as a false self-reference. `addDeclarationLine`
  // accumulates every introducing line per name instead of keeping only
  // the first (harmless for `const`/`class`/import forms, which can
  // only ever contribute one line per name -- duplicate top-level
  // bindings are themselves a compile error).
  const declarationLineByLocalName = new Map<string, number[]>();
  function addDeclarationLine(name: string, line: number): void {
    const existing = declarationLineByLocalName.get(name);
    if (existing) {
      if (!existing.includes(line)) {
        existing.push(line);
      }
    } else {
      declarationLineByLocalName.set(name, [line]);
    }
  }
  // #3498 (Codex C1 finding): a suppression comment (`// audit:ignore-
  // dead-export`) on the RESOLVED declaration's own line (or bare
  // declaration's preceding line) must also suppress a no-`from` list
  // item reporting that resolved line -- otherwise the audit's own
  // remediation message ("suppressing it ... on its declaration line")
  // points at a line the suppression check never actually reads. Tracks
  // the exported/bare declaration's own suppression state per local name,
  // merged with the export-list item's own suppression at finalization.
  const declarationSuppressionByLocalName = new Map<
    string,
    { suppressed: boolean; reason: string }
  >();
  // #3498 (C1 finding, both the CodeRabbit delegate and the independent
  // subagent critique): a no-`from` export-list item can textually
  // PRECEDE the declaration it re-exports (valid via function hoisting),
  // and the SAME local name can be re-exported under two or more aliases
  // from separate items/statements anywhere in the file -- each such
  // mention is a re-export mechanism, never itself "wired into other
  // code". Finalizing `declared` entries for no-`from` items only AFTER
  // the whole file has been scanned (below) lets both maps be complete
  // first: `declarationLineByLocalName` (regardless of textual order) and
  // this one, which accumulates EVERY no-`from` item's own line for a
  // given local name across the entire file.
  const noFromItemLinesByLocalName = new Map<string, Set<number>>();
  interface PendingNoFromItem {
    exposedName: string;
    localName: string;
    itemLine: number;
    suppressed: boolean;
    reason: string;
  }
  const pendingNoFromItems: PendingNoFromItem[] = [];
  const claimedNoFromExposedNames = new Set<string>();

  // #3498 (Copilot/Codex C1 finding, round 7): factored out of the plain
  // `import { a } from '...'` handling so the combined `import def, { a }
  // from '...'` form (see `IMPORT_DEFAULT_PLUS_BRACE_PATTERN` below) can
  // reuse the identical named-list processing instead of duplicating it.
  // `braceOffset` is the absolute `strippedText` offset of the `{` that
  // opens the list; `statementStartLine` is the import STATEMENT's own
  // first line (1-based) -- for a multi-line list, this differs from any
  // individual item's own line, and a suppression comment above the
  // statement itself (round 9 C1 finding) must be checked there, not just
  // above each item's own line. Returns the matching `}`'s offset (or -1
  // if unbalanced) so the caller can advance `lineIndex` past it.
  function processNamedImportBraceList(
    braceOffset: number,
    statementStartLine: number,
  ): number {
    const closeIndex = findMatchingBrace(strippedText, braceOffset);
    if (closeIndex === -1) {
      return -1;
    }
    const items = parseBracedItems(
      originalText,
      strippedText,
      braceOffset + 1,
      closeIndex,
    );
    const afterBrace = strippedText.slice(closeIndex + 1, closeIndex + 200);
    const fromMatch = IMPORT_FROM_AFTER_BRACE_PATTERN.exec(afterBrace);
    if (fromMatch) {
      // #3498 (Codex C1 finding, round 4): the local-alias bookkeeping
      // below must run for EVERY named import, not only a relative
      // (`./`/`../`) specifier -- only cross-file importer crediting
      // stays relative-only.
      const isRelativeSpecifier = RELATIVE_SPECIFIER_PATTERN.test(fromMatch[1]);
      const targetFile = isRelativeSpecifier
        ? resolveSpecifier(absPath, fromMatch[1])
        : null;
      for (const item of items) {
        if (item.isType) {
          continue;
        }
        if (targetFile) {
          imports.push({ name: item.name, targetFile, importerFile: absPath });
        }
        // #3498 (Copilot C1 finding): a no-`from` list item can
        // re-export a LOCAL name this file only ever IMPORTED, never
        // declared -- track the local alias's introducing line the same
        // way a declaration's is tracked.
        const localAlias = item.alias ?? item.name;
        addDeclarationLine(localAlias, item.line);
        // #3498 (Codex/Copilot C1 findings, rounds 3, 8, and 9):
        // `parseBracedItems` already recognizes a suppression comment on
        // this import item's own physical line. ALSO recognize one on
        // the line immediately preceding the ITEM's own line (matches a
        // single-line import, where the item and statement share one
        // line) AND one immediately preceding the IMPORT STATEMENT's own
        // first line (matches a multi-line list, where a comment above
        // `import {` is not adjacent to any individual item's own line)
        // -- matching the documented contract
        // (`docs/idd-helper-scripts.md`) that the marker may sit on the
        // declaration's own line or immediately above it, regardless of
        // how many lines the import statement itself spans.
        if (!declarationSuppressionByLocalName.has(localAlias)) {
          const itemIgnoreMatch = checkOwnOrPrecedingLineSuppression(
            originalText,
            lineStarts,
            item.line,
          );
          const statementIgnoreMatch =
            item.line === statementStartLine
              ? null
              : checkOwnOrPrecedingLineSuppression(
                  originalText,
                  lineStarts,
                  statementStartLine,
                );
          const ignoreMatch = itemIgnoreMatch ?? statementIgnoreMatch;
          declarationSuppressionByLocalName.set(localAlias, {
            suppressed: item.suppressed || !!ignoreMatch,
            reason: item.suppressed
              ? item.reason
              : (ignoreMatch?.[1] ?? '').trim(),
          });
        }
      }
    }
    return closeIndex;
  }

  const lineStarts: number[] = [0];
  for (let i = 0; i < strippedText.length; i += 1) {
    if (strippedText[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }

  let lineIndex = 0;
  while (lineIndex < lineStarts.length) {
    const start = lineStarts[lineIndex];
    const end =
      lineIndex + 1 < lineStarts.length
        ? lineStarts[lineIndex + 1] - 1
        : strippedText.length;
    const line = strippedText.slice(start, end);

    if (
      TYPE_ONLY_STATEMENT_PATTERN.test(line) ||
      INTERFACE_DECL_PATTERN.test(line)
    ) {
      if (
        EXPORT_BRACE_PATTERN.test(line.replace(/^export\s+type\s*/, 'export '))
      ) {
        // `export type { ... } from '...';` -- consume and discard the
        // whole (possibly multi-line) list; a type-only re-export credits
        // nothing.
        const braceOffset = strippedText.indexOf('{', start);
        const closeIndex = findMatchingBrace(strippedText, braceOffset);
        lineIndex =
          closeIndex === -1
            ? lineIndex + 1
            : lineNumberAt(strippedText, closeIndex) - 1;
      }
      lineIndex += 1;
      continue;
    }

    if (IMPORT_TYPE_ONLY_STATEMENT_PATTERN.test(line)) {
      const braceOffset = strippedText.indexOf('{', start);
      if (braceOffset !== -1 && braceOffset < end) {
        const closeIndex = findMatchingBrace(strippedText, braceOffset);
        lineIndex =
          closeIndex === -1
            ? lineIndex + 1
            : lineNumberAt(strippedText, closeIndex) - 1;
      }
      lineIndex += 1;
      continue;
    }

    const functionMatch = FUNCTION_DECL_PATTERN.exec(line);
    const constMatch = !functionMatch && CONST_DECL_PATTERN.exec(line);
    const classMatch =
      !functionMatch && !constMatch && CLASS_DECL_PATTERN.exec(line);
    const declMatch = functionMatch ?? constMatch ?? classMatch;
    if (constMatch) {
      // #3498 (proactive fix, same class as the bare-const findings
      // above): `export const a = 1, b = 2;` is a genuine direct export
      // of BOTH `a` and `b` -- `CONST_DECL_PATTERN` itself only captures
      // the FIRST identifier, so resolve every declarator the same way
      // the bare branch does (`scanBareConstDeclarators`), creating one
      // `declared` entry per name. Single-line only (round 6 revert; see
      // that function's own doc comment) -- every declarator returned
      // here shares this line, since the scan never crosses a line
      // boundary.
      const declaratorListStart =
        start + (constMatch[0].length - constMatch[1].length);
      const declarators = scanBareConstDeclarators(
        strippedText,
        declaratorListStart,
        end,
      );
      const ignoreMatch = checkOwnOrPrecedingLineSuppression(
        originalText,
        lineStarts,
        lineIndex + 1,
      );
      for (const declarator of declarators) {
        declared.set(declarator.name, {
          line: lineIndex + 1,
          suppressed: !!ignoreMatch,
          reason: (ignoreMatch?.[1] ?? '').trim(),
          localName: declarator.name,
          selfReferenceExcludeLines: [lineIndex + 1],
        });
        addDeclarationLine(declarator.name, lineIndex + 1);
        declarationSuppressionByLocalName.set(declarator.name, {
          suppressed: !!ignoreMatch,
          reason: (ignoreMatch?.[1] ?? '').trim(),
        });
      }
      lineIndex += 1;
      continue;
    }
    if (declMatch) {
      const name = declMatch[1];
      // The suppression comment may sit on the declaration's own line, or
      // (more practical for a multi-line signature, and consistent with
      // this repository's habit of a lone note right above a JSDoc-less
      // declaration) as a standalone comment on the line immediately
      // before it.
      const ownLineIgnoreMatch = IGNORE_EXPORT_PATTERN.exec(
        originalText.slice(start, end),
      );
      const precedingLineIgnoreMatch = ownLineIgnoreMatch
        ? null
        : (() => {
            if (lineIndex === 0) {
              return null;
            }
            const precedingStart = lineStarts[lineIndex - 1];
            const precedingEnd = start - 1;
            return IGNORE_EXPORT_PATTERN.exec(
              originalText.slice(precedingStart, precedingEnd),
            );
          })();
      const ignoreMatch = ownLineIgnoreMatch ?? precedingLineIgnoreMatch;
      declared.set(name, {
        line: lineIndex + 1,
        suppressed: !!ignoreMatch,
        reason: (ignoreMatch?.[1] ?? '').trim(),
        localName: name,
        selfReferenceExcludeLines: [lineIndex + 1],
      });
      addDeclarationLine(name, lineIndex + 1);
      declarationSuppressionByLocalName.set(name, {
        suppressed: !!ignoreMatch,
        reason: (ignoreMatch?.[1] ?? '').trim(),
      });
      lineIndex += 1;
      continue;
    }

    // #3498: a bare (no `export` keyword) top-level function/const/class
    // declaration -- never added to `declared` itself (it is not exported
    // under this name), but its real line is recorded so a later no-`from`
    // `export { a [as b] };` list item re-exporting it can resolve the
    // TRUE declaration line instead of the export statement's own line.
    {
      const bareFunctionMatch = BARE_FUNCTION_DECL_PATTERN.exec(line);
      const bareConstMatch =
        !bareFunctionMatch && BARE_CONST_DECL_PATTERN.exec(line);
      const bareClassMatch =
        !bareFunctionMatch &&
        !bareConstMatch &&
        BARE_CLASS_DECL_PATTERN.exec(line);
      const bareMatch = bareFunctionMatch ?? bareConstMatch ?? bareClassMatch;
      if (bareMatch) {
        // #3498 (Codex C1 finding): same own-line-or-preceding-line
        // suppression check as the exported declaration branch above, so
        // a suppression comment on a BARE declaration's line also takes
        // effect once a no-`from` list item resolves to it.
        //
        // #3498 (Codex/Copilot C1 finding, round 4; single-line-only
        // since the round 6 revert -- see `scanBareConstDeclarators`'s
        // own doc comment): a bare `const` statement can declare
        // MULTIPLE comma-separated bindings on one line (`const
        // retained = 1, forgotten = 2;`) -- resolve every declarator on
        // this line, not just the first.
        const bareNames = bareConstMatch
          ? scanBareConstDeclarators(
              strippedText,
              start + (bareConstMatch[0].length - bareConstMatch[1].length),
              end,
            ).map((declarator) => declarator.name)
          : [bareMatch[1]];
        const bareIgnoreMatch = checkOwnOrPrecedingLineSuppression(
          originalText,
          lineStarts,
          lineIndex + 1,
        );
        for (const bareName of bareNames) {
          addDeclarationLine(bareName, lineIndex + 1);
          if (!declarationSuppressionByLocalName.has(bareName)) {
            declarationSuppressionByLocalName.set(bareName, {
              suppressed: !!bareIgnoreMatch,
              reason: (bareIgnoreMatch?.[1] ?? '').trim(),
            });
          }
        }
      }
    }

    const barrelMatch = BARREL_STAR_PATTERN.exec(line);
    if (barrelMatch) {
      reExports.push({
        name: '*',
        sourceName: '*',
        targetFile: resolveSpecifier(absPath, barrelMatch[1]),
      });
      lineIndex += 1;
      continue;
    }

    if (EXPORT_BRACE_PATTERN.test(line)) {
      const braceOffset = strippedText.indexOf('{', start);
      const closeIndex = findMatchingBrace(strippedText, braceOffset);
      if (closeIndex === -1) {
        lineIndex += 1;
        continue;
      }
      const items = parseBracedItems(
        originalText,
        strippedText,
        braceOffset + 1,
        closeIndex,
      );
      const afterBrace = strippedText.slice(closeIndex + 1, closeIndex + 200);
      const fromMatch = FROM_CLAUSE_AFTER_BRACE_PATTERN.exec(afterBrace);
      if (fromMatch) {
        const targetFile = resolveSpecifier(absPath, fromMatch[1]);
        for (const item of items) {
          if (item.isType) {
            continue;
          }
          reExports.push({
            name: item.alias ?? item.name,
            sourceName: item.name,
            targetFile,
          });
        }
      } else {
        for (const item of items) {
          if (item.isType) {
            continue;
          }
          // No `from` clause: this re-exports an already-declared local
          // binding, so the key a consumer's import must match is the
          // EXPOSED name (the `as` alias when present), not the local
          // binding `item.name` identifies -- but self-reference
          // detection still needs `item.name` (`localName` below), since
          // this file's OTHER code reads the local binding, never the
          // alias.
          //
          // #3498: do NOT finalize into `declared` here -- defer to the
          // pending-item finalization after the full-file loop below, so
          // both `declarationLineByLocalName` (which may not have seen
          // `item.name`'s declaration yet if it is textually declared
          // LATER, e.g. via function hoisting) and
          // `noFromItemLinesByLocalName` (which accumulates every
          // no-`from` item mentioning this local name anywhere in the
          // file, including sibling aliases split across lines) are
          // complete by the time this item's exclude-lines are computed.
          const exposedName = item.alias ?? item.name;
          let lineSet = noFromItemLinesByLocalName.get(item.name);
          if (!lineSet) {
            lineSet = new Set();
            noFromItemLinesByLocalName.set(item.name, lineSet);
          }
          lineSet.add(item.line);
          if (
            !declared.has(exposedName) &&
            !claimedNoFromExposedNames.has(exposedName)
          ) {
            claimedNoFromExposedNames.add(exposedName);
            pendingNoFromItems.push({
              exposedName,
              localName: item.name,
              itemLine: item.line,
              suppressed: item.suppressed,
              reason: item.reason,
            });
          }
        }
      }
      lineIndex = lineNumberAt(strippedText, closeIndex) - 1;
      lineIndex += 1;
      continue;
    }

    const namespaceMatch = IMPORT_NAMESPACE_PATTERN.exec(line);
    if (namespaceMatch) {
      const namespaceSpecifier = namespaceMatch[2];
      if (RELATIVE_SPECIFIER_PATTERN.test(namespaceSpecifier)) {
        imports.push({
          name: '*',
          targetFile: resolveSpecifier(absPath, namespaceSpecifier),
          importerFile: absPath,
        });
      }
      // #3498 (Copilot C1 finding, round 6): track the namespace's own
      // local binding name the same way a named import's local alias is
      // tracked above -- a no-`from` list item can re-export the
      // namespace object itself (`export { x as PublicX };`).
      const namespaceLocalName = namespaceMatch[1];
      addDeclarationLine(namespaceLocalName, lineIndex + 1);
      if (!declarationSuppressionByLocalName.has(namespaceLocalName)) {
        const ignoreMatch = checkOwnOrPrecedingLineSuppression(
          originalText,
          lineStarts,
          lineIndex + 1,
        );
        declarationSuppressionByLocalName.set(namespaceLocalName, {
          suppressed: !!ignoreMatch,
          reason: (ignoreMatch?.[1] ?? '').trim(),
        });
      }
      lineIndex += 1;
      continue;
    }

    // #3498 (Copilot C1 finding, round 6): a default import (`import
    // helper from './origin.mts';`) introduces a local binding the same
    // way a named import does -- track it for the same reason. No
    // `imports.push` here (unlike the named/namespace branches): a
    // default export is tracked in `declared` under the DECLARATION'S
    // OWN name (`export default function realName() {}` matches
    // `FUNCTION_DECL_PATTERN` normally), never under the literal string
    // `'default'`, so crediting an importer against that key would never
    // resolve to anything -- out of scope for this file-local
    // no-`from` bookkeeping fix regardless.
    const defaultMatch = IMPORT_DEFAULT_PATTERN.exec(line);
    if (defaultMatch) {
      const defaultLocalName = defaultMatch[1];
      addDeclarationLine(defaultLocalName, lineIndex + 1);
      if (!declarationSuppressionByLocalName.has(defaultLocalName)) {
        const ignoreMatch = checkOwnOrPrecedingLineSuppression(
          originalText,
          lineStarts,
          lineIndex + 1,
        );
        declarationSuppressionByLocalName.set(defaultLocalName, {
          suppressed: !!ignoreMatch,
          reason: (ignoreMatch?.[1] ?? '').trim(),
        });
      }
      lineIndex += 1;
      continue;
    }

    // #3498 (Codex C1 finding, round 10): a combined default + named or
    // default + namespace import can wrap onto a second physical line
    // right after the comma -- the natural break point a formatter picks
    // when the whole statement is too long to fit one line (`import
    // def,\n  { named } from '...';`). Neither combined pattern below
    // matched this: both were tested against only the single physical
    // `line`, which never contains a `\n`, so the pattern's `\s` (which
    // DOES match a newline) never got the chance to see one. Test
    // against a short forward-looking WINDOW instead of `line` -- the
    // pattern stays anchored at the statement's own start (`^`), so it
    // can still only match this exact "import IDENT , <rest>" token
    // sequence with nothing but whitespace in between, never accidentally
    // spanning into an unrelated later statement. The window is bounded
    // (cheap, and a statement wider than it falls back to the ORIGINAL,
    // pre-#3498 unhandled-combined-form behavior -- the same degradation
    // as before this fix existed, not a new one). Wrapping between
    // `import` and the default identifier, or between `as` and the
    // namespace identifier, is NOT handled -- no real formatter chooses
    // those break points, unlike after a comma, so extending this fix
    // there would be scope creep without a real-world case behind it.
    const combinedImportWindow = strippedText.slice(
      start,
      Math.min(start + 400, strippedText.length),
    );

    // #3498 (Copilot/Codex C1 finding, round 7; round 10: matched against
    // `combinedImportWindow`, see above, so a comma-then-newline wrap
    // before `* as ns` is recognized too): a combined default + namespace
    // import (`import def, * as ns from '...';`) introduces TWO local
    // bindings on one statement -- track both the same way the plain
    // default and plain namespace branches already do.
    const combinedNamespaceMatch =
      IMPORT_DEFAULT_PLUS_NAMESPACE_PATTERN.exec(combinedImportWindow);
    if (combinedNamespaceMatch) {
      const combinedSpecifier = combinedNamespaceMatch[3];
      if (RELATIVE_SPECIFIER_PATTERN.test(combinedSpecifier)) {
        imports.push({
          name: '*',
          targetFile: resolveSpecifier(absPath, combinedSpecifier),
          importerFile: absPath,
        });
      }
      // #3498 (round 10): the default identifier (group 1) always sits on
      // the statement's own first physical line -- this fix only
      // recognizes a wrap AFTER the comma, never before the default
      // identifier itself (see the scope note above) -- but the
      // NAMESPACE identifier (group 2) can now be on a LATER physical
      // line than `lineIndex` once the wrap lands before `* as`.
      // Crediting it against `lineIndex + 1` unconditionally (as a first
      // version of this fix did) recorded the WRONG line: self-reference
      // exclusion then never excluded the line the namespace identifier
      // is actually written on, so its own import mention read as a
      // genuine extra reference and silently masked an otherwise-unused
      // export as production. Locate its real offset by re-matching just
      // the "* as NAME" tail WITHIN the already-validated
      // `combinedNamespaceMatch[0]` (never re-searching the wider,
      // unbounded window, so this can never latch onto an unrelated
      // later "* as" elsewhere) and using the same suffix-length trick
      // already used for `scanBareConstDeclarators`'s own call site
      // above (the capture group is the tail of its own submatch, so the
      // prefix length is `submatch[0].length - submatch[1].length`).
      const namespaceTailMatch = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(
        combinedNamespaceMatch[0],
      );
      const namespaceIdentOffset = namespaceTailMatch
        ? namespaceTailMatch.index +
          (namespaceTailMatch[0].length - namespaceTailMatch[1].length)
        : 0;
      const namespaceRealLine = namespaceTailMatch
        ? lineNumberAt(strippedText, start + namespaceIdentOffset)
        : lineIndex + 1;
      // #3498 (Codex C1 finding, round 11): a suppression comment above
      // the WHOLE statement's first line (line 1, `import def,`) is not
      // adjacent to the namespace identifier's own `realLine` once the
      // wrap moves it to a later physical line -- checking only
      // `realLine`'s own-or-preceding line misses it, the same gap round
      // 9 already fixed for `processNamedImportBraceList`'s named-list
      // items. Check both `realLine` and the statement's own start line
      // (`lineIndex + 1`) the same way that fix does, skipping the
      // redundant second check when they coincide (the un-wrapped,
      // single-line case, where both identifiers already share one
      // line).
      const statementStartLine = lineIndex + 1;
      for (const [localName, realLine] of [
        [combinedNamespaceMatch[1], statementStartLine],
        [combinedNamespaceMatch[2], namespaceRealLine],
      ] as const) {
        addDeclarationLine(localName, realLine);
        if (!declarationSuppressionByLocalName.has(localName)) {
          const ownIgnoreMatch = checkOwnOrPrecedingLineSuppression(
            originalText,
            lineStarts,
            realLine,
          );
          const statementIgnoreMatch =
            realLine === statementStartLine
              ? null
              : checkOwnOrPrecedingLineSuppression(
                  originalText,
                  lineStarts,
                  statementStartLine,
                );
          const ignoreMatch = ownIgnoreMatch ?? statementIgnoreMatch;
          declarationSuppressionByLocalName.set(localName, {
            suppressed: !!ignoreMatch,
            reason: (ignoreMatch?.[1] ?? '').trim(),
          });
        }
      }
      // #3498 (round 10): the match may have consumed more than one
      // physical line (the wrapped form above) -- advance past every
      // line it actually spans, not just the one `lineIndex` currently
      // points at, mirroring the brace-closing advance used elsewhere in
      // this loop. Equivalent to the previous plain `lineIndex += 1;`
      // when the match stayed on one line (the offset below then still
      // resolves to the SAME line, since `lineNumberAt` counts only the
      // newlines strictly before it).
      lineIndex =
        lineNumberAt(strippedText, start + combinedNamespaceMatch[0].length) -
        1;
      lineIndex += 1;
      continue;
    }

    // #3498 (Copilot/Codex C1 finding, round 7; round 10: matched against
    // `combinedImportWindow`, see above, so a comma-then-newline wrap
    // before `{` is recognized too): a combined default + named import
    // (`import def, { a, b } from '...';`) -- neither the plain default
    // pattern (requires `from` immediately after the identifier) nor the
    // plain brace pattern (requires `{` immediately after `import`)
    // matches this form, so it was silently unhandled entirely. Track
    // the default binding, then reuse the shared named-list processing
    // (`processNamedImportBraceList`) for the rest -- that helper already
    // locates the `{` via `strippedText.indexOf` and resolves its
    // matching `}` across however many lines it spans, so no further
    // multi-line handling is needed here once the pattern itself
    // matches.
    const combinedBraceMatch =
      IMPORT_DEFAULT_PLUS_BRACE_PATTERN.exec(combinedImportWindow);
    if (combinedBraceMatch) {
      const combinedDefaultLocalName = combinedBraceMatch[1];
      addDeclarationLine(combinedDefaultLocalName, lineIndex + 1);
      if (!declarationSuppressionByLocalName.has(combinedDefaultLocalName)) {
        const ignoreMatch = checkOwnOrPrecedingLineSuppression(
          originalText,
          lineStarts,
          lineIndex + 1,
        );
        declarationSuppressionByLocalName.set(combinedDefaultLocalName, {
          suppressed: !!ignoreMatch,
          reason: (ignoreMatch?.[1] ?? '').trim(),
        });
      }
      const braceOffset = strippedText.indexOf('{', start);
      const closeIndex = processNamedImportBraceList(
        braceOffset,
        lineIndex + 1,
      );
      if (closeIndex === -1) {
        lineIndex += 1;
        continue;
      }
      lineIndex = lineNumberAt(strippedText, closeIndex) - 1;
      lineIndex += 1;
      continue;
    }

    if (IMPORT_BRACE_PATTERN.test(line)) {
      const braceOffset = strippedText.indexOf('{', start);
      const closeIndex = processNamedImportBraceList(
        braceOffset,
        lineIndex + 1,
      );
      if (closeIndex === -1) {
        lineIndex += 1;
        continue;
      }
      lineIndex = lineNumberAt(strippedText, closeIndex) - 1;
      lineIndex += 1;
      continue;
    }

    lineIndex += 1;
  }

  // #3498: finalize every deferred no-`from` export-list item now that the
  // whole file has been scanned -- see the pending-item comment above for
  // why this must happen after the loop, not inline.
  for (const pending of pendingNoFromItems) {
    // #3498 (Codex C1 finding, round 6): every introducing line for this
    // local name (plural -- a bare function can have multiple TypeScript
    // overload signature lines sharing one name) must be excluded, not
    // only the first one found.
    const realLines = declarationLineByLocalName.get(pending.localName);
    const line = realLines?.[0] ?? pending.itemLine;
    const excludeLines = new Set<number>();
    if (realLines) {
      for (const realLine of realLines) {
        excludeLines.add(realLine);
      }
    }
    for (const itemLine of noFromItemLinesByLocalName.get(pending.localName) ??
      []) {
      excludeLines.add(itemLine);
    }
    // #3498 (Codex C1 finding): a suppression comment on the export-list
    // item's own line still suppresses it (unchanged); ALSO recognize one
    // on the resolved declaration's own line -- the line this entry now
    // actually reports -- so the audit's own remediation message ("place
    // the comment on its declaration line") is truthful for this branch
    // too. Either one suppressing is enough.
    const declarationSuppression = declarationSuppressionByLocalName.get(
      pending.localName,
    );
    const suppressed =
      pending.suppressed || !!declarationSuppression?.suppressed;
    const reason = pending.suppressed
      ? pending.reason
      : (declarationSuppression?.reason ?? pending.reason);
    declared.set(pending.exposedName, {
      line,
      suppressed,
      reason,
      localName: pending.localName,
      selfReferenceExcludeLines: [...excludeLines],
    });
  }

  return { declared, reExports, imports };
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

/** Whether `name` (as a whole word) appears anywhere in `strippedText`
 * OTHER than on one of `excludeLines` -- i.e. the export is wired into its
 * own declaring file's other code, not merely declared (and, for a
 * no-`from` export-list item, not merely re-exported by name). Most
 * callers pass a single-element array (the declaration's own line); a
 * no-`from` `export { a [as b] };` list item passes both the real
 * declaration's line AND the export statement's own line, since
 * re-exporting a name necessarily mentions it a second time in a SEPARATE
 * statement, which is not itself "wired into other code" either (#3498).
 *
 * **Known false-negative risk (C1 critique, #3478 review)**: this is a
 * whole-file text match, not a scope-aware reference check, so it can be
 * fooled into reporting a self-reference that is not really one -- an
 * unrelated local variable/parameter that happens to share the export's
 * name elsewhere in the same file, or the name appearing only inside a
 * string literal (this function's `strippedText` input has comments
 * blanked out, but string contents are left intact). A false positive
 * here means a genuinely dead export is wrongly classified `production`
 * and never surfaced -- accepted as a limitation of the regex/line-based
 * design this audit deliberately uses (see the module header), not
 * something a full scope-aware fix belongs in this issue's scope.
 * `scanBareConstDeclarators`'s quote-tracking (#3498) does not extend
 * here: that scanner exists only to find declarator BOUNDARIES
 * correctly, an unrelated concern from scope-aware reference detection,
 * and does not change this accepted limitation either way.
 *
 * **The opposite direction (false negative), same root cause (C1
 * review, #3498 round 9)**: excluding by LINE NUMBER rather than
 * character position also means a genuine reference sharing the same
 * physical line as the declaration itself (`const helper = () =>
 * helper();`, a one-line recursive arrow function) is indistinguishable
 * from the declaration and gets excluded too, so it is never counted as
 * a self-reference. Verified pre-existing on `main` before #3498 (this
 * exact fixture already misclassified identically with the ORIGINAL
 * single-`declarationLine` signature) -- a general limitation of this
 * function's line-granularity design, not something #3498's own
 * no-`from` resolution work introduced or is scoped to fix. */
function hasSelfReference(
  strippedText: string,
  name: string,
  excludeLines: readonly number[],
): boolean {
  const wordPattern = new RegExp(`\\b${name}\\b`, 'g');
  let line = 1;
  let lastIndex = 0;
  for (const match of strippedText.matchAll(wordPattern)) {
    const index = match.index ?? 0;
    line += (strippedText.slice(lastIndex, index).match(/\n/g) ?? []).length;
    lastIndex = index;
    if (!excludeLines.includes(line)) {
      return true;
    }
  }
  return false;
}

/**
 * Runs the full dead-export audit against a directory tree that contains
 * `src/scripts`, `src/bin`, and `tests` (an actual checkout, or a fixture
 * tree built for a test). Pure filesystem read, no network or git calls.
 */
export function collectDeadExportAuditResult(
  root: string,
): DeadExportAuditResult {
  const productionFiles = [
    ...listMtsFilesRecursive(join(root, 'src', 'scripts')),
    ...listMtsFilesRecursive(join(root, 'src', 'bin')),
  ];
  const testFiles = listMtsFilesRecursive(join(root, 'tests'));
  const allFiles = [...productionFiles, ...testFiles];
  const productionFileSet = new Set(productionFiles);

  const parsedByFile = new Map<string, ParsedFile>();
  const textByFile = new Map<string, string>();
  for (const file of allFiles) {
    const text = readFileSync(file, 'utf8');
    textByFile.set(file, text);
    parsedByFile.set(file, parseFile(file, text));
  }

  /** Resolves (file, name) to the file that actually DECLARES the export
   * reached by following `*`/named re-export edges to any depth (with a
   * cycle guard), AND the name it is declared under there -- which can
   * differ from the `name` this function was called with when an `as`
   * alias renamed it partway along the chain (crediting an importer under
   * the WRONG name is a distinct bug from losing the alias outright: the
   * importer's own requested name never matches the origin file's
   * `declared` key, so the credit silently misses even once the edge
   * itself resolves -- #3478 review). Returns `null` when unresolvable
   * (dangling specifier, or a re-export chain that never reaches a real
   * declaration). */
  function resolveDeclaringFile(
    file: string,
    name: string,
    visited: Set<string>,
  ): { file: string; name: string } | null {
    const parsed = parsedByFile.get(file);
    if (!parsed) {
      return null;
    }
    if (parsed.declared.has(name)) {
      return { file, name };
    }
    const key = `${file}\u0000${name}`;
    if (visited.has(key)) {
      return null;
    }
    visited.add(key);
    for (const edge of parsed.reExports) {
      if (edge.name !== name && edge.name !== '*') {
        continue;
      }
      // A barrel (`edge.name === '*'`) always forwards the SAME name the
      // caller asked for -- there is no fixed source identifier. A named
      // edge may have renamed the export via `as`, so `sourceName` (not
      // this file's own exposed `edge.name`) is what `targetFile` itself
      // declares or re-exports it under.
      const lookupName = edge.name === '*' ? name : edge.sourceName;
      const resolved = resolveDeclaringFile(
        edge.targetFile,
        lookupName,
        visited,
      );
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }

  /** Every name reachable by importing `file`'s own module namespace,
   * mapped to the file that actually declares it AND the name it is
   * declared under there (which can differ from the reachable/exposed key
   * when an `as` alias renamed it along the way -- the same
   * name-vs-file distinction `resolveDeclaringFile` returns, and for the
   * same reason: crediting under the exposed name here would key the
   * credit under a name the declaring file's own `declared` map never
   * uses, losing it silently, exactly as the direct-import path did
   * before `resolveDeclaringFile` started returning the resolved name
   * -- #3478 review, namespace-import path) -- `file`'s own direct
   * declarations, plus (recursively, with a cycle guard on `file` itself)
   * every name reachable through a `*` barrel or named re-export edge.
   * Used for a namespace import (`import * as x from './file.mts'`),
   * which reaches every one of `file`'s re-exports transitively, not just
   * its own direct declarations -- a barrel re-exporting another barrel
   * (`export * from './b.mts'` in a file with no declarations of its
   * own) must still credit `b.mts`'s own declarations. */
  function collectAllReachableExports(
    file: string,
    visitedFiles: Set<string>,
  ): Map<string, { file: string; name: string }> {
    const result = new Map<string, { file: string; name: string }>();
    if (visitedFiles.has(file)) {
      return result;
    }
    visitedFiles.add(file);
    const parsed = parsedByFile.get(file);
    if (!parsed) {
      return result;
    }
    for (const name of parsed.declared.keys()) {
      result.set(name, { file, name });
    }
    for (const edge of parsed.reExports) {
      if (edge.name === '*') {
        for (const [name, declaration] of collectAllReachableExports(
          edge.targetFile,
          visitedFiles,
        )) {
          if (!result.has(name)) {
            result.set(name, declaration);
          }
        }
        continue;
      }
      if (result.has(edge.name)) {
        continue;
      }
      // `edge.sourceName`, not `edge.name`: `targetFile` declares (or
      // re-exports) the export under its ORIGIN identifier, which may
      // differ from the alias this file exposes it as.
      const resolved = resolveDeclaringFile(
        edge.targetFile,
        edge.sourceName,
        new Set(),
      );
      if (resolved) {
        result.set(edge.name, resolved);
      }
    }
    return result;
  }

  // (declaringFile, name) -> Set(importerFile), crediting a re-export
  // chain's importer back to the file that actually declares the export.
  const importersByExport = new Map<string, Set<string>>();
  function creditImporter(
    declaringFile: string,
    name: string,
    importer: string,
  ) {
    const key = `${declaringFile}\u0000${name}`;
    let set = importersByExport.get(key);
    if (!set) {
      set = new Set();
      importersByExport.set(key, set);
    }
    set.add(importer);
  }

  for (const file of allFiles) {
    const parsed = parsedByFile.get(file);
    if (!parsed) {
      continue;
    }
    for (const rawImport of parsed.imports) {
      if (rawImport.name === '*') {
        // A namespace import reaches every name the target module (or its
        // own re-export chain, transitively -- see
        // `collectAllReachableExports`) ultimately declares. Credit the
        // resolved declaration's own name, not the map's exposed-name key
        // -- an aliased chain makes the two differ (see
        // `collectAllReachableExports`'s doc comment).
        for (const [, declaration] of collectAllReachableExports(
          rawImport.targetFile,
          new Set(),
        )) {
          creditImporter(
            declaration.file,
            declaration.name,
            rawImport.importerFile,
          );
        }
        continue;
      }
      // Credit the RESOLVED origin name (`resolved.name`), not
      // `rawImport.name` (what this importer wrote) -- an aliased
      // re-export chain makes the two differ, and crediting the
      // requested name would key this credit under a name the
      // declaring file's own `declared` map never uses, silently
      // losing the credit (#3478 review).
      const resolved = resolveDeclaringFile(
        rawImport.targetFile,
        rawImport.name,
        new Set(),
      );
      if (resolved) {
        creditImporter(resolved.file, resolved.name, rawImport.importerFile);
      }
    }
  }

  const all: DeclaredExport[] = [];
  for (const file of productionFiles) {
    const parsed = parsedByFile.get(file);
    if (!parsed) {
      continue;
    }
    const strippedText = blankOutComments(textByFile.get(file) ?? '');
    for (const [name, info] of parsed.declared) {
      const key = `${file}\u0000${name}`;
      const importers = [...(importersByExport.get(key) ?? [])].filter(
        (importer) => importer !== file,
      );
      // `info.localName`, not `name` (the map key): a no-`from`
      // `export { a as b };` list item keys `declared` by the EXPOSED
      // name `b` (what an importer must match), but this file's own
      // other code -- what self-reference detection scans for -- still
      // reads the local binding `a`.
      const selfReferenced = hasSelfReference(
        strippedText,
        info.localName,
        info.selfReferenceExcludeLines,
      );
      // Every importer is drawn from `allFiles` (productionFiles ++
      // testFiles, a partition), so "not every importer is a test file"
      // and "at least one importer is a production file" are the same
      // condition -- there is no fourth, "mixed but no production
      // importer" case to handle.
      let category: DeadExportCategory;
      if (
        selfReferenced ||
        importers.some((importer) => productionFileSet.has(importer))
      ) {
        category = 'production';
      } else if (importers.length > 0) {
        category = 'test-only';
      } else {
        category = 'unused';
      }
      all.push({
        name,
        file: toPosixRelative(root, file),
        line: info.line,
        category,
        suppressed: info.suppressed,
        suppressionReason: info.reason,
      });
    }
  }

  all.sort(
    (a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name),
  );
  const findings = all.filter(
    (entry) => !entry.suppressed && entry.category !== 'production',
  );
  return { all, findings };
}

function renderFindingsTable(findings: DeclaredExport[]): string {
  const header = ['export', 'declaring file', 'category'];
  const rows = findings.map((f) => [f.name, `${f.file}:${f.line}`, f.category]);
  const widths = header.map((title, columnIndex) =>
    Math.max(title.length, ...rows.map((row) => row[columnIndex].length)),
  );
  const renderRow = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [
    renderRow(header),
    renderRow(widths.map((w) => '-'.repeat(w))),
    ...rows.map(renderRow),
  ].join('\n');
}

if (import.meta.main) {
  const args = new Set(process.argv.slice(2));
  if (!args.has('--check')) {
    console.error('usage: node scripts/audit-dead-exports.mjs --check');
    process.exit(2);
  }

  const root = process.cwd();
  const { findings } = collectDeadExportAuditResult(root);

  if (findings.length > 0) {
    console.error(
      'audit-dead-exports: production export(s) covered only by their own test file, or with no caller at all:',
    );
    console.error('');
    console.error(renderFindingsTable(findings));
    console.error(
      '\nFix by wiring the export into real production code, removing it, or ' +
        'suppressing it with a `// audit:ignore-dead-export: <reason>` comment ' +
        'on its declaration line.',
    );
    process.exit(1);
  }

  console.log(
    'audit-dead-exports: no unsuppressed test-only or unused exports found.',
  );
}
