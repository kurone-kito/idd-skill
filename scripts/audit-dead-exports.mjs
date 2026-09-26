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
import './node-runtime-guard.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

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
/** Recursively lists every `.mts` file under `dir` (absolute paths). */
function listMtsFilesRecursive(dir) {
  const out = [];
  let entries;
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
function blankOutComments(text) {
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
function lineNumberAt(text, offset) {
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
function findMatchingBrace(strippedText, openIndex) {
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
/** #3498 (Codex C1 finding, round 4): extracts every top-level declarator
 * NAME from `declaratorListText` -- the portion of a bare `const a = 1, b
 * = 2;` statement's line after the `const ` keyword -- splitting on
 * commas only at bracket/paren/brace depth 0, so a declarator's own
 * initializer (`const a = foo(1, 2), b = 3;`) is never mistaken for a
 * second declarator boundary. Destructuring declarators (`const { a, b }
 * = obj;`) are out of scope -- `BARE_CONST_DECL_PATTERN` never matches
 * them at all (no identifier immediately follows `const `), an
 * accepted, pre-existing limitation this fix does not extend to. */
function splitBareConstDeclaratorNames(declaratorListText) {
  const names = [];
  let depth = 0;
  let segmentStart = 0;
  const pushSegment = (raw) => {
    const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(raw);
    if (nameMatch) {
      names.push(nameMatch[1]);
    }
  };
  for (let i = 0; i < declaratorListText.length; i += 1) {
    const char = declaratorListText[i];
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
    } else if (char === ',' && depth === 0) {
      pushSegment(declaratorListText.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  pushSegment(declaratorListText.slice(segmentStart));
  return names;
}
/** Splits the raw content between `{`/`}` (exclusive) on top-level commas
 * and parses each item's optional `type` prefix and `as alias`. */
function parseBracedItems(
  originalText,
  strippedText,
  contentStart,
  contentEnd,
) {
  const items = [];
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
function resolveSpecifier(importerFile, specifier) {
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
const IMPORT_NAMESPACE_PATTERN =
  /^import\s*\*\s*as\s+[A-Za-z_$][\w$]*\s+from\s*['"](\.[^'"]+)['"]/;
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
function parseFile(absPath, originalText) {
  const strippedText = blankOutComments(originalText);
  const declared = new Map();
  const reExports = [];
  const imports = [];
  // #3498: real INTRODUCING line for every top-level local binding name in
  // this file -- a `function`/`const`/`class` declaration (exported or
  // bare; see the bare-pattern comment above), or a named import's local
  // alias (a no-`from` list item can re-export a name this file only ever
  // imported, never declared -- Copilot C1 finding). Populated alongside
  // `declared` below; consulted only when finalizing a no-`from`
  // export-list item (after the full-file loop below, not inline) to
  // resolve its `declarationLine`.
  const declarationLineByLocalName = new Map();
  // #3498 (Codex C1 finding): a suppression comment (`// audit:ignore-
  // dead-export`) on the RESOLVED declaration's own line (or bare
  // declaration's preceding line) must also suppress a no-`from` list
  // item reporting that resolved line -- otherwise the audit's own
  // remediation message ("suppressing it ... on its declaration line")
  // points at a line the suppression check never actually reads. Tracks
  // the exported/bare declaration's own suppression state per local name,
  // merged with the export-list item's own suppression at finalization.
  const declarationSuppressionByLocalName = new Map();
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
  const noFromItemLinesByLocalName = new Map();
  const pendingNoFromItems = [];
  const claimedNoFromExposedNames = new Set();
  const lineStarts = [0];
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
        selfReferenceExcludeLines: [lineIndex + 1],
      });
      declarationLineByLocalName.set(name, lineIndex + 1);
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
        // #3498 (Codex C1 finding, round 4): a bare `const` statement can
        // declare MULTIPLE comma-separated bindings on one line (`const
        // retained = 1, forgotten = 2;`) -- `BARE_CONST_DECL_PATTERN`
        // itself only captures the FIRST identifier, so resolve every
        // declarator name for the const case; function/class
        // declarations have only one name each. Destructuring
        // declarators stay an accepted, pre-existing limitation (see
        // `splitBareConstDeclaratorNames`'s own doc comment).
        const bareNames = bareConstMatch
          ? splitBareConstDeclaratorNames(line.replace(/^const\s+/, ''))
          : [bareMatch[1]];
        // #3498 (Codex C1 finding): same own-line-or-preceding-line
        // suppression check as the exported declaration branch above, so
        // a suppression comment on a BARE declaration's line also takes
        // effect once a no-`from` list item resolves to it.
        const bareOwnLineIgnoreMatch = IGNORE_EXPORT_PATTERN.exec(
          originalText.slice(start, end),
        );
        const barePrecedingLineIgnoreMatch = bareOwnLineIgnoreMatch
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
        const bareIgnoreMatch =
          bareOwnLineIgnoreMatch ?? barePrecedingLineIgnoreMatch;
        for (const bareName of bareNames) {
          if (!declarationLineByLocalName.has(bareName)) {
            declarationLineByLocalName.set(bareName, lineIndex + 1);
          }
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
      if (fromMatch) {
        // #3498 (Codex C1 finding, round 4): the local-alias bookkeeping
        // below must run for EVERY named import, not only a relative
        // (`./`/`../`) specifier -- `import { helper } from
        // 'some-package'; export { helper as PublicHelper };` re-exports
        // a genuinely local binding the same way a relative import does,
        // even though a BARE package specifier can never be resolved to
        // one of this repo's own files for cross-file importer crediting.
        // Only the importer-crediting push below stays relative-only.
        const isRelativeSpecifier = RELATIVE_SPECIFIER_PATTERN.test(
          fromMatch[1],
        );
        const targetFile = isRelativeSpecifier
          ? resolveSpecifier(absPath, fromMatch[1])
          : null;
        for (const item of items) {
          if (item.isType) {
            continue;
          }
          if (targetFile) {
            imports.push({
              name: item.name,
              targetFile,
              importerFile: absPath,
            });
          }
          // #3498 (Copilot C1 finding): a no-`from` list item can
          // re-export a LOCAL name this file only ever IMPORTED, never
          // declared -- `declarationLineByLocalName` has nothing for it,
          // so without this the import statement's own mention of the
          // local alias registers as a false self-reference. Track the
          // local alias's introducing line the same way a declaration's
          // is tracked (never overwrite an existing declaration line --
          // impossible in practice, since a module cannot both import and
          // declare the same top-level binding name, but first-wins keeps
          // this defensive).
          const localAlias = item.alias ?? item.name;
          if (!declarationLineByLocalName.has(localAlias)) {
            declarationLineByLocalName.set(localAlias, item.line);
          }
          // #3498 (Codex C1 finding, round 3): `parseBracedItems` already
          // recognizes a suppression comment on this import item's own
          // line (the same generic braced-list parsing a no-`from`
          // export-list item uses) -- record it here too, so a no-`from`
          // item resolving to this import line can also be suppressed
          // there, mirroring the declaration case above.
          if (!declarationSuppressionByLocalName.has(localAlias)) {
            declarationSuppressionByLocalName.set(localAlias, {
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
    lineIndex += 1;
  }
  // #3498: finalize every deferred no-`from` export-list item now that the
  // whole file has been scanned -- see the pending-item comment above for
  // why this must happen after the loop, not inline.
  for (const pending of pendingNoFromItems) {
    const realLine = declarationLineByLocalName.get(pending.localName);
    const line = realLine ?? pending.itemLine;
    const excludeLines = new Set();
    if (realLine !== undefined) {
      excludeLines.add(realLine);
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
function toPosixRelative(root, absPath) {
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
 * something a full scope-aware fix belongs in this issue's scope. */
function hasSelfReference(strippedText, name, excludeLines) {
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
export function collectDeadExportAuditResult(root) {
  const productionFiles = [
    ...listMtsFilesRecursive(join(root, 'src', 'scripts')),
    ...listMtsFilesRecursive(join(root, 'src', 'bin')),
  ];
  const testFiles = listMtsFilesRecursive(join(root, 'tests'));
  const allFiles = [...productionFiles, ...testFiles];
  const productionFileSet = new Set(productionFiles);
  const parsedByFile = new Map();
  const textByFile = new Map();
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
  function resolveDeclaringFile(file, name, visited) {
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
  function collectAllReachableExports(file, visitedFiles) {
    const result = new Map();
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
  const importersByExport = new Map();
  function creditImporter(declaringFile, name, importer) {
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
  const all = [];
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
      let category;
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
function renderFindingsTable(findings) {
  const header = ['export', 'declaring file', 'category'];
  const rows = findings.map((f) => [f.name, `${f.file}:${f.line}`, f.category]);
  const widths = header.map((title, columnIndex) =>
    Math.max(title.length, ...rows.map((row) => row[columnIndex].length)),
  );
  const renderRow = (cells) =>
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
