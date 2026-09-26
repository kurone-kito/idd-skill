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
  /** 1-based source line of the declaration (or its `export {}` list item). */
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
// declaration. For an `export { a, b };` list item, it is checked only on
// that item's own physical line (see `parseBracedItems`).
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
  /** exposedName -> { line, suppressed, reason, localName } for this
   * file's OWN declared exports (function/const/class, plus any
   * `export { a, b };` list with no `from` clause). `exposedName` (the
   * map key) is what a consumer's `import { exposedName }` must match --
   * the `as` alias when the list item renamed one, else the same as
   * `localName`. `localName` is the identifier the declaring file's OWN
   * other code uses (`hasSelfReference` needs this one, not the alias --
   * `export { a as b };` still reads `a`, never `b`, inside this file). */
  declared: Map<
    string,
    { line: number; suppressed: boolean; reason: string; localName: string }
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
    const line = lineNumberAt(strippedText, chunkStart);
    const lineStart = originalText.lastIndexOf('\n', chunkStart) + 1;
    const nextNewline = originalText.indexOf('\n', chunkStart);
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
const TYPE_ONLY_STATEMENT_PATTERN = /^export\s+type\b/;
const INTERFACE_DECL_PATTERN = /^export\s+interface\b/;
const BARREL_STAR_PATTERN = /^export\s+\*\s+from\s*['"](\.[^'"]+)['"]/;
const EXPORT_BRACE_PATTERN = /^export\s*\{/;
const FROM_CLAUSE_AFTER_BRACE_PATTERN = /^\s*from\s*['"](\.[^'"]+)['"]/;

const IMPORT_TYPE_ONLY_STATEMENT_PATTERN = /^import\s+type\b/;
const IMPORT_BRACE_PATTERN = /^import\s*\{/;
const IMPORT_NAMESPACE_PATTERN =
  /^import\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s*['"](\.[^'"]+)['"]/;
const IMPORT_FROM_AFTER_BRACE_PATTERN = /^\s*from\s*['"](\.[^'"]+)['"]/;

/** Parses one `.mts` file's own top-level export declarations, re-export
 * edges, and import statements. `originalText` is used only for
 * suppression-comment text and self-reference scanning; every structural
 * match runs against `strippedText` (comments blanked out). */
function parseFile(absPath: string, originalText: string): ParsedFile {
  const strippedText = blankOutComments(originalText);
  const declared: ParsedFile['declared'] = new Map();
  const reExports: ReExportEdge[] = [];
  const imports: RawImport[] = [];

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
      });
      lineIndex += 1;
      continue;
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
          const exposedName = item.alias ?? item.name;
          if (!declared.has(exposedName)) {
            declared.set(exposedName, {
              line: item.line,
              suppressed: item.suppressed,
              reason: item.reason,
              localName: item.name,
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
      imports.push({
        name: '*',
        targetFile: resolveSpecifier(absPath, namespaceMatch[1]),
        importerFile: absPath,
      });
      lineIndex += 1;
      continue;
    }

    if (IMPORT_BRACE_PATTERN.test(line)) {
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
      const fromMatch = IMPORT_FROM_AFTER_BRACE_PATTERN.exec(afterBrace);
      if (fromMatch && RELATIVE_SPECIFIER_PATTERN.test(fromMatch[1])) {
        const targetFile = resolveSpecifier(absPath, fromMatch[1]);
        for (const item of items) {
          if (item.isType) {
            continue;
          }
          imports.push({ name: item.name, targetFile, importerFile: absPath });
        }
      }
      lineIndex = lineNumberAt(strippedText, closeIndex) - 1;
      lineIndex += 1;
      continue;
    }

    lineIndex += 1;
  }

  return { declared, reExports, imports };
}

function toPosixRelative(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join('/');
}

/** Whether `name` (as a whole word) appears anywhere in `strippedText`
 * OTHER than on `declarationLine` -- i.e. the export is wired into its own
 * declaring file's other code, not merely declared.
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
 *
 * **Second, narrower known false-positive (independent critique pass,
 * #3478 review, pre-existing -- reproduces identically with no alias
 * involved, so it is a distinct defect from the alias-chain bug this
 * revision fixes, and stays out of THIS fix's scope)**: for the no-`from`
 * `export { a [as b] };` list branch, the caller passes the EXPORT
 * STATEMENT's own line as `declarationLine`, not the underlying
 * `function`/`const`/`class` declaration's real line -- those are always
 * two separate statements, so the real declaration always registers as a
 * match on a line other than `declarationLine` and this function always
 * returns `true`, regardless of whether `a` is genuinely used anywhere
 * else. This masks whether `parseFile`'s `localName` field (used here)
 * is even being exercised for that branch: no fixture can isolate it from
 * this false positive without first fixing this line mismatch, which
 * would need locating the real declaration separately -- left for a
 * follow-up rather than folded into this alias fix. */
function hasSelfReference(
  strippedText: string,
  name: string,
  declarationLine: number,
): boolean {
  const wordPattern = new RegExp(`\\b${name}\\b`, 'g');
  let line = 1;
  let lastIndex = 0;
  for (const match of strippedText.matchAll(wordPattern)) {
    const index = match.index ?? 0;
    line += (strippedText.slice(lastIndex, index).match(/\n/g) ?? []).length;
    lastIndex = index;
    if (line !== declarationLine) {
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
        info.line,
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
