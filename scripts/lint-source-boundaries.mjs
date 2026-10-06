// idd-generated-from: src/scripts/lint-source-boundaries.mts
//
// The scripts/lint-source-boundaries.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Local source-repository lint (#3748, roadmap #3744). It owns the
// whole-tree source boundary rules that five test suites used to enforce by
// scanning the real checkout. Each rule keeps its detector here as a pure
// function over text or bytes, and the scanners read the repository only
// through a root directory argument, so a scratch fixture tree exercises the
// same code the real tree does. The tests keep the detector and matcher
// regressions; this CLI is the live enforcement.
//
// Rule families (a violation prints as `<RULE-ID> <path>: <message>`):
//
// - NODE-IMPORT-BOUNDARY: every `src/**/*.mts` import/export/dynamic-import
//   specifier is a `node:` builtin or a `./`/`../` path, so a toolless
//   adopter (no node_modules) never loads a bare third-party specifier
//   (#1707).
// - STANDALONE-MIRROR-IMPORTS: the source of every exact-mode
//   `idd-template/scripts/` mirror listed in `audit/sync-manifest.json`
//   imports only `node:` builtins, so the standalone copy runs by itself.
// - GH-SPAWN-DIRECT: no `src/scripts/*.mts` other than the shared gh layer
//   and the one documented standalone helper spawns the gh executable
//   itself (#1675).
// - PROVIDER-PORT-MIGRATED: a helper enrolled as migrated onto the provider
//   port, and its committed generated copy, never regains a direct gh call
//   (#2266, #2268).
// - NO-NUL-BYTES: no tracked `.mts`/`.mjs` under `src`, `scripts`, `bin` or
//   `tests` holds a literal U+0000 byte, which hides the rest of the file
//   from tools that skip binary files (#3340).
//
// A `<RULE-ID>-INSPECTION` violation means a rule could not finish: an
// unreadable input, a failed `git ls-files`, an empty inventory (a rule that
// inspects nothing would otherwise pass vacuously), or malformed source that
// leaves a block comment, template literal, or template interpolation open.
//
// Imports only `node:` builtins plus two sibling helpers that do the same,
// makes no GitHub call, and never writes. The one subprocess is a local,
// read-only `git ls-files`.
// #3240: keep the runtime check first so an unsupported Node version fails
// loudly before import.meta.main is evaluated.
import './node-runtime-guard.mjs';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveBundleRoot } from './bundle-root.mjs';
export const NODE_IMPORT_BOUNDARY = 'NODE-IMPORT-BOUNDARY';
export const STANDALONE_MIRROR_IMPORTS = 'STANDALONE-MIRROR-IMPORTS';
export const GH_SPAWN_DIRECT = 'GH-SPAWN-DIRECT';
export const PROVIDER_PORT_MIGRATED = 'PROVIDER-PORT-MIGRATED';
export const NO_NUL_BYTES = 'NO-NUL-BYTES';
/**
 * True for the documented relative forms only (`./…` or `../…`) — plain
 * `specifier.startsWith('.')` would also accept a dot-prefixed bare name
 * like `.foo`, which is not a relative path.
 */
export function isRelativeSpecifier(specifier) {
  return specifier.startsWith('./') || specifier.startsWith('../');
}
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
  'throw',
  'extends',
  'break',
  'continue',
  'debugger',
]);
const CONTROL_FLOW_PAREN_KEYWORDS = new Set([
  'if',
  'while',
  'for',
  'with',
  'switch',
  'catch',
]);
const UNICODE_IDENTIFIER_PART = /(?:[$\p{ID_Continue}]|\u200c|\u200d)/u;
const UNICODE_IDENTIFIER_START = /(?:[$_\p{ID_Start}])/u;
const BLOCK_PRECEDING_KEYWORDS = new Set(['else', 'do']);
const RESTRICTED_STATEMENT_KEYWORDS = new Set([
  'break',
  'continue',
  'debugger',
]);
/** ECMAScript line terminators, including the Unicode separators. */
function isLineTerminator(ch) {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}
/**
 * Replaces one comment with whitespace without changing offsets or line
 * boundaries. Keeping a separator prevents tokens on either side of a
 * comment from being joined by the scanner's existing import patterns.
 */
function maskComment(output, start, end) {
  for (let index = start; index < end; index += 1) {
    if (!isLineTerminator(output[index])) {
      output[index] = ' ';
    }
  }
}
/** True when the code point at `index` is an ECMAScript identifier part. */
function isIdentifierPartAt(source, index) {
  if (source[index] === '}') {
    const unicodeEscape = source
      .slice(Math.max(0, index - 9), index + 1)
      .match(/\\u\{([0-9a-f]{1,6})\}$/i);
    if (unicodeEscape) {
      const codePoint = Number.parseInt(unicodeEscape[1], 16);
      if (codePoint <= 0x10ffff) {
        return UNICODE_IDENTIFIER_PART.test(String.fromCodePoint(codePoint));
      }
    }
  }
  let codePointStart = index;
  const currentCodeUnit = source.charCodeAt(index);
  const previousCodeUnit = source.charCodeAt(index - 1);
  if (
    currentCodeUnit >= 0xdc00 &&
    currentCodeUnit <= 0xdfff &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff
  ) {
    codePointStart -= 1;
  }
  const codePoint = source.codePointAt(codePointStart);
  return (
    codePoint !== undefined &&
    UNICODE_IDENTIFIER_PART.test(String.fromCodePoint(codePoint))
  );
}
/** True when the code point at `index` can start an ECMAScript identifier. */
function isIdentifierStartAt(source, index) {
  if (source[index] === '\\') {
    const unicodeEscape = source
      .slice(index)
      .match(/^\\u(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/i);
    if (unicodeEscape) {
      const codePoint = Number.parseInt(
        unicodeEscape[1] ?? unicodeEscape[2],
        16,
      );
      if (codePoint <= 0x10ffff) {
        return UNICODE_IDENTIFIER_START.test(String.fromCodePoint(codePoint));
      }
    }
  }
  let codePointStart = index;
  const currentCodeUnit = source.charCodeAt(index);
  const previousCodeUnit = source.charCodeAt(index - 1);
  if (
    currentCodeUnit >= 0xdc00 &&
    currentCodeUnit <= 0xdfff &&
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff
  ) {
    codePointStart -= 1;
  }
  const codePoint = source.codePointAt(codePointStart);
  return (
    codePoint !== undefined &&
    UNICODE_IDENTIFIER_START.test(String.fromCodePoint(codePoint))
  );
}
/**
 * A `/` starts a regular-expression literal after expression-start tokens,
 * including expression-introducing keywords, `export default`, and a
 * control-flow header. This mirrors the conservative heuristic used by the
 * local explicit-any scanner while treating `/` itself as an operator, so a
 * division followed by a regex is recognized too.
 */
function regexCanStartAfter(
  lastCodeChar,
  lastCodeCharIsIdentifierPart,
  lastWord,
  previousWord,
  lastWordIsPropertyName,
  previousWordIsPropertyName,
  controlFlowClosingParenthesis,
  expressionEndingBrace,
  postfixUpdateOperator,
  postfixNonNullAssertion,
  regexAfterRestrictedStatementLineBreak,
) {
  if (lastCodeChar === '') {
    return true;
  }
  if (
    controlFlowClosingParenthesis ||
    regexAfterRestrictedStatementLineBreak ||
    (!lastWordIsPropertyName && REGEX_PRECEDING_KEYWORDS.has(lastWord)) ||
    (!lastWordIsPropertyName &&
      lastWord === 'default' &&
      previousWord === 'export' &&
      !previousWordIsPropertyName)
  ) {
    return true;
  }
  if (
    expressionEndingBrace ||
    postfixUpdateOperator ||
    postfixNonNullAssertion
  ) {
    return false;
  }
  return !(lastCodeCharIsIdentifierPart || /[)\]'"`x]/.test(lastCodeChar));
}
/**
 * Masks comments only in code. Template text, strings, and regular
 * expressions are copied verbatim because the import patterns need
 * quoted specifiers and the current detector intentionally sees
 * import-looking lines inside template text.
 */
function scanComments(source) {
  const output = source.split('');
  function scanTemplate(start) {
    let index = start + 1;
    while (index < source.length) {
      const ch = source[index];
      const next = source[index + 1];
      if (ch === '\\') {
        index += index + 1 < source.length ? 2 : 1;
        continue;
      }
      if (ch === '`') {
        return { index: index + 1 };
      }
      if (ch === '$' && next === '{') {
        const interpolation = scanCode(index + 2, true);
        if (interpolation.inspectionError) {
          return interpolation;
        }
        index = interpolation.index;
        continue;
      }
      index += 1;
    }
    return {
      index,
      inspectionError: 'unterminated template literal',
    };
  }
  function scanCode(start, interpolation) {
    let index = start;
    let braceDepth = 0;
    let lastCodeChar = '';
    let lastCodeCharIsIdentifierPart = false;
    let lastWord = '';
    let previousWord = '';
    let lastWordIsPropertyName = false;
    let previousWordIsPropertyName = false;
    let wordBoundary = false;
    let controlFlowClosingParenthesis = false;
    let expressionEndingBrace = false;
    let arrowBodyPending = false;
    let postfixUpdateOperator = false;
    let postfixNonNullAssertion = false;
    let possiblePostfixUpdate = false;
    let pendingClassExpressionBody = null;
    let pendingFunctionExpression = null;
    let pendingFunctionExpressionBody = false;
    let scanningFunctionReturnType = false;
    let functionReturnTypeAngleDepth = 0;
    let functionReturnTypeBraceDepth = 0;
    let typescriptAssertionTypeContext = false;
    let typescriptAssertionTypeDepth = 0;
    let currentWordStartsExpressionContext = false;
    let pendingRestrictedStatement = null;
    let restrictedStatementLabelConsumed = false;
    let regexAfterRestrictedStatementLineBreak = false;
    const controlFlowParentheses = [];
    const functionParameterExpressions = [];
    const expressionEndingBraces = [];
    const objectLiteralBraces = [];
    function wordContinuesAt(ch, sourceIndex) {
      return (
        /[A-Za-z0-9_$]/.test(ch) ||
        isIdentifierPartAt(source, sourceIndex) ||
        (ch === '\\' && source.slice(sourceIndex, sourceIndex + 2) === '\\u')
      );
    }
    function finishCurrentKeyword() {
      if (lastWordIsPropertyName) {
        return;
      }
      if (lastWord === 'as' || lastWord === 'satisfies') {
        typescriptAssertionTypeContext = true;
        typescriptAssertionTypeDepth = 0;
      }
      if (lastWord === 'class') {
        pendingClassExpressionBody = currentWordStartsExpressionContext;
      }
      if (lastWord === 'function') {
        pendingFunctionExpression = currentWordStartsExpressionContext;
      }
    }
    function expressionCanStartHere() {
      if (lastCodeChar === '') {
        return interpolation;
      }
      return (
        '=([,!?:+-*/%&|^<>~'.includes(lastCodeChar) ||
        (!lastWordIsPropertyName &&
          [
            'case',
            'delete',
            'new',
            'return',
            'throw',
            'typeof',
            'void',
            'await',
            'yield',
            'in',
            'of',
            'instanceof',
          ].includes(lastWord))
      );
    }
    function recordWhitespace(hasLineTerminator) {
      if (hasLineTerminator && typescriptAssertionTypeDepth === 0) {
        typescriptAssertionTypeContext = false;
      }
      finishCurrentKeyword();
      if (
        pendingRestrictedStatement === null &&
        !lastWordIsPropertyName &&
        RESTRICTED_STATEMENT_KEYWORDS.has(lastWord)
      ) {
        pendingRestrictedStatement = lastWord;
        restrictedStatementLabelConsumed = false;
      }
      if (hasLineTerminator && pendingRestrictedStatement !== null) {
        regexAfterRestrictedStatementLineBreak = true;
        pendingRestrictedStatement = null;
        restrictedStatementLabelConsumed = false;
      }
      if (
        hasLineTerminator &&
        !lastWordIsPropertyName &&
        lastWord === 'async'
      ) {
        currentWordStartsExpressionContext = false;
      }
      wordBoundary = true;
      if (hasLineTerminator) {
        possiblePostfixUpdate = false;
        postfixNonNullAssertion = false;
      }
    }
    function recordCodeChar(ch, sourceIndex) {
      if (/\s/.test(ch)) {
        recordWhitespace(isLineTerminator(ch));
        return;
      }
      const previousCodeChar = lastCodeChar;
      const previousCodeCharIsIdentifierPart = lastCodeCharIsIdentifierPart;
      if (pendingRestrictedStatement !== null) {
        const isBreakOrContinue =
          pendingRestrictedStatement === 'break' ||
          pendingRestrictedStatement === 'continue';
        const isRestrictedStatementLabelStart =
          /[A-Za-z_$]/.test(ch) || isIdentifierStartAt(source, sourceIndex);
        const isIdentifierPart =
          /[A-Za-z0-9_$]/.test(ch) || isIdentifierPartAt(source, sourceIndex);
        if (
          isBreakOrContinue &&
          wordBoundary &&
          isRestrictedStatementLabelStart &&
          !restrictedStatementLabelConsumed
        ) {
          restrictedStatementLabelConsumed = true;
        } else if (
          ch === ';' ||
          !(isBreakOrContinue ? isIdentifierPart : /[A-Za-z0-9_$]/.test(ch))
        ) {
          pendingRestrictedStatement = null;
          restrictedStatementLabelConsumed = false;
        }
      }
      const startsPostfixUpdate =
        (ch === '+' || ch === '-') &&
        previousCodeChar === ch &&
        possiblePostfixUpdate;
      const startsPostfixNonNullAssertion =
        ch === '!' &&
        !regexCanStartAfter(
          lastCodeChar,
          lastCodeCharIsIdentifierPart,
          lastWord,
          previousWord,
          lastWordIsPropertyName,
          previousWordIsPropertyName,
          controlFlowClosingParenthesis,
          expressionEndingBrace,
          postfixUpdateOperator,
          postfixNonNullAssertion,
          regexAfterRestrictedStatementLineBreak,
        );
      const startsWord = wordBoundary || lastWord === '';
      if (startsWord) {
        const followsAsyncFunctionPrefix =
          !lastWordIsPropertyName &&
          lastWord === 'async' &&
          currentWordStartsExpressionContext;
        currentWordStartsExpressionContext =
          followsAsyncFunctionPrefix || expressionCanStartHere();
      }
      lastCodeChar = ch;
      lastCodeCharIsIdentifierPart = isIdentifierPartAt(source, sourceIndex);
      const startsArrowBody = previousCodeChar === '=' && ch === '>';
      expressionEndingBrace = false;
      regexAfterRestrictedStatementLineBreak = false;
      postfixUpdateOperator = startsPostfixUpdate;
      postfixNonNullAssertion = startsPostfixNonNullAssertion;
      possiblePostfixUpdate =
        (ch === '+' || ch === '-') &&
        (previousCodeCharIsIdentifierPart || /[)\]}]/.test(previousCodeChar));
      if (/[A-Za-z0-9_$]/.test(ch)) {
        if (startsWord) {
          previousWord = lastWord;
          previousWordIsPropertyName = lastWordIsPropertyName;
          lastWord = ch;
          lastWordIsPropertyName =
            previousCodeChar === '.' || previousCodeChar === '#';
        } else {
          lastWord += ch;
        }
      } else {
        previousWord = '';
        previousWordIsPropertyName = false;
        lastWord = '';
        lastWordIsPropertyName = false;
        currentWordStartsExpressionContext = false;
      }
      controlFlowClosingParenthesis = false;
      wordBoundary = false;
      arrowBodyPending = startsArrowBody;
    }
    function recordLiteral(end) {
      lastCodeChar = end;
      lastCodeCharIsIdentifierPart = false;
      previousWord = '';
      previousWordIsPropertyName = false;
      lastWord = '';
      lastWordIsPropertyName = false;
      controlFlowClosingParenthesis = false;
      wordBoundary = false;
      expressionEndingBrace = false;
      arrowBodyPending = false;
      postfixUpdateOperator = false;
      postfixNonNullAssertion = false;
      possiblePostfixUpdate = false;
      pendingRestrictedStatement = null;
      restrictedStatementLabelConsumed = false;
      regexAfterRestrictedStatementLineBreak = false;
    }
    if (!interpolation && source.startsWith('#!', index)) {
      let end = index + 2;
      while (end < source.length && !isLineTerminator(source[end])) {
        end += 1;
      }
      maskComment(output, index, end);
      index = end;
    }
    // A same-line `<...>` after an identifier is a type-argument list.
    // A comparison such as `n < limit)` has no closing `>` before a
    // non-type token, so it stays a pair of operators. A closer that
    // belongs to a bracket or brace opened before the `<`, or a comma
    // that is not inside a nested type, is such a token:
    // `items[count < limit] > /regex/` and
    // `check(count < limit, total > /regex/)` must not hide a later import.
    // A comma inside `Record<string, number>`, `[string, number]`, or
    // `{ a: number, b: number }` is still part of the type.
    function closesTypeArgumentsOnLine(from) {
      let depth = 0;
      let bracketDepth = 0;
      let braceDepth = 0;
      for (let cursor = from; cursor < source.length; cursor += 1) {
        const typeChar = source[cursor];
        if (isLineTerminator(typeChar)) {
          return false;
        }
        if (typeChar === '<') {
          depth += 1;
          continue;
        }
        if (typeChar === '>') {
          depth -= 1;
          if (depth === 0) {
            return true;
          }
          continue;
        }
        if (depth > 0 && typeChar === '[') {
          bracketDepth += 1;
          continue;
        }
        if (depth > 0 && typeChar === ']') {
          if (bracketDepth === 0) {
            return false;
          }
          bracketDepth -= 1;
          continue;
        }
        if (depth > 0 && typeChar === '{') {
          braceDepth += 1;
          continue;
        }
        if (depth > 0 && typeChar === '}') {
          if (braceDepth === 0) {
            return false;
          }
          braceDepth -= 1;
          continue;
        }
        if (depth > 0 && typeChar === ',') {
          if (depth > 1 || bracketDepth > 0 || braceDepth > 0) {
            continue;
          }
          return false;
        }
        // Parentheses and expression operators stop the scan.
        if (depth > 0 && /[A-Za-z0-9_$\s.:]/.test(typeChar)) {
          continue;
        }
        return false;
      }
      return false;
    }
    while (index < source.length) {
      const ch = source[index];
      const next = source[index + 1];
      if (!/\s/.test(ch) && !wordContinuesAt(ch, index)) {
        finishCurrentKeyword();
      }
      if (interpolation && ch === '}') {
        if (braceDepth === 0) {
          return { index: index + 1 };
        }
        braceDepth -= 1;
      }
      if (ch === '/' && next === '/') {
        let end = index + 2;
        while (end < source.length && !isLineTerminator(source[end])) {
          end += 1;
        }
        maskComment(output, index, end);
        recordWhitespace(false);
        index = end;
        continue;
      }
      if (ch === '/' && next === '*') {
        const close = source.indexOf('*/', index + 2);
        if (close < 0) {
          maskComment(output, index, source.length);
          return {
            index: source.length,
            inspectionError: 'unterminated block comment',
          };
        }
        const end = close + 2;
        maskComment(output, index, end);
        recordWhitespace(
          source.slice(index, end).split('').some(isLineTerminator),
        );
        index = end;
        continue;
      }
      if (
        ch === '/' &&
        regexCanStartAfter(
          lastCodeChar,
          lastCodeCharIsIdentifierPart,
          lastWord,
          previousWord,
          lastWordIsPropertyName,
          previousWordIsPropertyName,
          controlFlowClosingParenthesis,
          expressionEndingBrace,
          postfixUpdateOperator,
          postfixNonNullAssertion,
          regexAfterRestrictedStatementLineBreak,
        )
      ) {
        let end = index + 1;
        let inCharacterClass = false;
        let closed = false;
        while (end < source.length) {
          const regexChar = source[end];
          if (isLineTerminator(regexChar)) {
            break;
          }
          if (regexChar === '\\') {
            if (isLineTerminator(source[end + 1])) {
              break;
            }
            end += end + 1 < source.length ? 2 : 1;
            continue;
          }
          if (regexChar === '[' && !inCharacterClass) {
            inCharacterClass = true;
            end += 1;
            continue;
          }
          if (regexChar === ']' && inCharacterClass) {
            inCharacterClass = false;
            end += 1;
            continue;
          }
          if (regexChar === '/' && !inCharacterClass) {
            end += 1;
            while (/[A-Za-z]/.test(source[end] ?? '')) {
              end += 1;
            }
            closed = true;
            break;
          }
          end += 1;
        }
        index = end;
        recordLiteral(closed ? 'x' : '/');
        continue;
      }
      if (ch === "'" || ch === '"') {
        let end = index + 1;
        while (end < source.length) {
          const stringChar = source[end];
          if (stringChar === ch) {
            end += 1;
            break;
          }
          if (isLineTerminator(stringChar)) {
            break;
          }
          if (stringChar === '\\') {
            const escaped = source[end + 1];
            if (escaped === '\r' && source[end + 2] === '\n') {
              end += 3;
            } else if (escaped !== undefined) {
              end += 2;
            } else {
              end += 1;
            }
            continue;
          }
          end += 1;
        }
        index = end;
        recordLiteral(ch);
        continue;
      }
      if (ch === '`') {
        const template = scanTemplate(index);
        if (template.inspectionError) {
          return template;
        }
        index = template.index;
        recordLiteral('`');
        continue;
      }
      if (interpolation && ch === '{') {
        braceDepth += 1;
      }
      if (ch === '(') {
        controlFlowParentheses.push(
          !lastWordIsPropertyName &&
            (CONTROL_FLOW_PAREN_KEYWORDS.has(lastWord) ||
              (lastWord === 'await' &&
                previousWord === 'for' &&
                !previousWordIsPropertyName)),
        );
        functionParameterExpressions.push(pendingFunctionExpression);
        pendingFunctionExpression = null;
      }
      const closesFunctionParameters =
        ch === ')' ? functionParameterExpressions.pop() : null;
      if (
        closesFunctionParameters !== null &&
        closesFunctionParameters !== undefined &&
        !scanningFunctionReturnType
      ) {
        pendingFunctionExpressionBody = closesFunctionParameters;
        scanningFunctionReturnType = false;
        functionReturnTypeAngleDepth = 0;
        functionReturnTypeBraceDepth = 0;
      }
      if (
        ch === ':' &&
        pendingFunctionExpressionBody &&
        !scanningFunctionReturnType
      ) {
        scanningFunctionReturnType = true;
        functionReturnTypeAngleDepth = 0;
        functionReturnTypeBraceDepth = 0;
      }
      if (
        typescriptAssertionTypeContext &&
        typescriptAssertionTypeDepth === 0 &&
        ';,)]}/'.includes(ch)
      ) {
        typescriptAssertionTypeContext = false;
      }
      if (ch === '<') {
        if (typescriptAssertionTypeContext) {
          typescriptAssertionTypeDepth += 1;
        } else if (
          lastCodeCharIsIdentifierPart &&
          closesTypeArgumentsOnLine(index)
        ) {
          typescriptAssertionTypeContext = true;
          typescriptAssertionTypeDepth = 1;
        }
        if (scanningFunctionReturnType) {
          functionReturnTypeAngleDepth += 1;
        }
      }
      if (
        ch === '>' &&
        scanningFunctionReturnType &&
        lastCodeChar !== '=' &&
        functionReturnTypeAngleDepth > 0
      ) {
        functionReturnTypeAngleDepth -= 1;
      }
      const closesTypescriptAssertionType =
        ch === '>' &&
        lastCodeChar !== '=' &&
        typescriptAssertionTypeContext &&
        typescriptAssertionTypeDepth > 0;
      if (closesTypescriptAssertionType) {
        typescriptAssertionTypeDepth -= 1;
        if (typescriptAssertionTypeDepth === 0) {
          typescriptAssertionTypeContext = false;
        }
      }
      if (ch === '{') {
        const returnTypeContinues =
          scanningFunctionReturnType &&
          (functionReturnTypeAngleDepth > 0 ||
            functionReturnTypeBraceDepth > 0 ||
            lastCodeChar === ':');
        if (returnTypeContinues) {
          functionReturnTypeBraceDepth += 1;
        } else if (scanningFunctionReturnType) {
          scanningFunctionReturnType = false;
          functionReturnTypeAngleDepth = 0;
          functionReturnTypeBraceDepth = 0;
        }
        const startsFunctionReturnType = returnTypeContinues;
        const startsObjectLiteral =
          !startsFunctionReturnType &&
          !controlFlowClosingParenthesis &&
          ((interpolation && lastCodeChar === '') ||
            lastCodeChar === '=' ||
            lastCodeChar === '(' ||
            lastCodeChar === '[' ||
            lastCodeChar === ',' ||
            (lastCodeChar !== '' && '&|?+-*/%^~'.includes(lastCodeChar)) ||
            (lastCodeChar === ':' && objectLiteralBraces.at(-1) === true) ||
            (!lastWordIsPropertyName &&
              !BLOCK_PRECEDING_KEYWORDS.has(lastWord) &&
              REGEX_PRECEDING_KEYWORDS.has(lastWord)) ||
            (!lastWordIsPropertyName &&
              lastWord === 'default' &&
              previousWord === 'export' &&
              !previousWordIsPropertyName));
        const startsClassExpressionBody = pendingClassExpressionBody === true;
        const startsFunctionExpressionBody =
          pendingFunctionExpressionBody && !startsFunctionReturnType;
        expressionEndingBraces.push(
          arrowBodyPending ||
            startsObjectLiteral ||
            startsClassExpressionBody ||
            startsFunctionExpressionBody,
        );
        objectLiteralBraces.push(startsObjectLiteral);
        pendingClassExpressionBody = null;
        if (!startsFunctionReturnType) {
          pendingFunctionExpressionBody = false;
        }
      }
      const closesExpressionBrace =
        ch === '}' && expressionEndingBraces.pop() === true;
      if (ch === '}') {
        if (functionReturnTypeBraceDepth > 0) {
          functionReturnTypeBraceDepth -= 1;
        }
        objectLiteralBraces.pop();
      }
      const closesControlFlowParenthesis =
        ch === ')' && controlFlowParentheses.pop() === true;
      recordCodeChar(ch, index);
      if (closesTypescriptAssertionType && typescriptAssertionTypeDepth === 0) {
        lastCodeCharIsIdentifierPart = true;
      }
      if (closesExpressionBrace) {
        expressionEndingBrace = true;
      }
      if (closesControlFlowParenthesis) {
        controlFlowClosingParenthesis = true;
      }
      index += 1;
    }
    return interpolation
      ? {
          index,
          inspectionError: 'unterminated template interpolation',
        }
      : { index };
  }
  const code = scanCode(0, false);
  return { text: output.join(''), inspectionError: code.inspectionError };
}
function scanImportSpecifiers(source) {
  const comments = scanComments(source);
  const clause = '[A-Za-z0-9_$,\\s*{}]*?';
  const patterns = [
    new RegExp(
      `^[ \\t]*(?:import\\b${clause}(?:\\bfrom\\s+)?|export\\b${clause}\\bfrom\\s+)['"]([^'"]+)['"]`,
      'gm',
    ),
    // `\s*(?:,|\))` (not just `\s*\)`) so a dynamic import that passes a
    // second import-attributes argument — `import('x', {...})` — still
    // yields its specifier instead of being silently skipped. The
    // alternation's second branch accepts a no-substitution template
    // literal (backticks, no `$`) as well as a quoted string.
    /\bimport\s*\(\s*(?:['"]([^'"]+)['"]|`([^`$]*)`)\s*(?:,|\))/g,
  ];
  const specifiers = patterns.flatMap((pattern) =>
    [...comments.text.matchAll(pattern)]
      .map((match) => match[1] ?? match[2])
      .filter((specifier) => specifier !== undefined),
  );
  return { specifiers, inspectionError: comments.inspectionError };
}
export function extractImportSpecifiers(source) {
  return scanImportSpecifiers(source).specifiers;
}
/** Specifiers in `source` that are neither a `node:` builtin nor relative. */
// audit:ignore-dead-export: preserve the public filter API while rule callers use the richer scan result for inspection diagnostics (#3775)
export function findBareSpecifiers(source) {
  return extractImportSpecifiers(source).filter(
    (specifier) =>
      !specifier.startsWith('node:') && !isRelativeSpecifier(specifier),
  );
}
/** Specifiers in `source` that are not a `node:` builtin (relative ones too). */
// audit:ignore-dead-export: preserve the public filter API while rule callers use the richer scan result for inspection diagnostics (#3775)
export function findNonNodeSpecifiers(source) {
  return extractImportSpecifiers(source).filter(
    (specifier) => !specifier.startsWith('node:'),
  );
}
/**
 * `gh-exec.mts` is the shared `gh` execution layer (bounded default timeout,
 * NDJSON-safe pagination), and every other `src/scripts/*.mts` helper routes
 * its `gh` subprocess calls through it (#1675).
 * `minimize-superseded-markers.mts` is the one documented exception: it
 * ships standalone in `idd-template/scripts/` with zero local imports, so it
 * keeps its own local runner that carries the same bounded default timeout
 * directly rather than by delegation (see its own top-of-file comment and
 * `docs/idd-helper-scripts.md`).
 */
export const GH_SPAWN_EXEMPT_FILES = new Set([
  'gh-exec.mts',
  'minimize-superseded-markers.mts',
]);
/**
 * Matches a direct call of the three forms named in #1675's acceptance
 * criteria (the sync and async file executors and the sync spawner) whose
 * literal first argument is the gh executable, quoted either way. Also
 * matches a namespace-qualified call (the same call reached through
 * `import * as childProcess from 'node:child_process'`), since that spawns
 * `gh` exactly the same way (CodeRabbit review, #1784). Does not catch an
 * indirect alias; the migration this guards eliminated every such alias.
 */
export const DIRECT_GH_SPAWN_PATTERN =
  /\b(?:[A-Za-z_$][\w$]*\.)?(?:execFileSync|execFile|spawnSync)\s*\(\s*(['"])gh\1/;
/**
 * Files migrated onto `provider-port.mts` so far. Append the next filename as
 * each migration commit lands, and never remove one once migrated (#2266 and,
 * from #2267 on, its PR-facing targets; `ci-wait-*.mts` covers
 * `ci-wait-policy.mts` and `ci-wait-state.mts`). Each enrolled helper has a
 * source under `src/scripts/` and a committed generated copy under
 * `scripts/`.
 */
export const MIGRATED_HELPERS = [
  'collaborator-permission.mts',
  'discover-viability-gate.mts',
  'discover-orphan-filter.mts',
  'post-idd-marker.mts',
  'claim-approval-gate.mts',
  'resume-claim-routing.mts',
  'discover-readiness-check.mts',
  'discover-shared-file-overlap.mts',
  'resume-route-selection.mts',
  'idd-roadmap-audit-execute.mts',
  'discover-roadmap-graph.mts',
  // #2267 additions below.
  'review-clause.mts',
  'review-activity-snapshot.mts',
  'resolve-review-thread.mts',
  'idd-merge-execute.mts',
  'merged-pr-feedback-sweep.mts',
  'advisory-wait-state.mts',
  'ci-wait-policy.mts',
  'ci-wait-state.mts',
  'pre-merge-readiness.mts',
  'advisory-convergence.mts',
];
/**
 * `provider-port.mts`, `provider-adapter-github.mts` and
 * `provider-adapter-fake.mts` are the sanctioned exception to the migrated
 * rule: the adapter's whole job is to be the one place gh invocation lives.
 * They must exist, so the exemption cannot silently name a typo.
 */
export const PROVIDER_PORT_ADAPTER_FILES = [
  'provider-port.mts',
  'provider-adapter-github.mts',
  'provider-adapter-fake.mts',
];
export const DIRECT_GH_PATTERNS = [
  {
    pattern: /execFileSync\(\s*['"]gh['"]/,
    description: 'a direct execFileSync call that spawns the gh executable',
  },
  {
    // Matches both the `.mts` source's own import and the generated
    // `.mjs` counterpart's `from './gh-exec.mjs'` (#2268) -- a guard that
    // only recognized the source extension would stay vacuous against a
    // regression introduced solely in committed generated output.
    // `\.mjs?` (optional trailing 's') matches only '.mj'/'.mjs', never
    // '.mts' -- an explicit two-way alternation is required (Copilot +
    // CodeRabbit review, #2436).
    pattern: /from ['"]\.\/gh-exec\.(?:mts|mjs)['"]/,
    description: 'import from the gh-exec transport primitive',
  },
  {
    // ghTextAsync checked before ghText -- \bghText\s*\( alone does not
    // match "ghTextAsync(" (the literal 'A' where \s*\( expects
    // whitespace-then-paren breaks the match), so without its own
    // alternative a migrated file could call ghTextAsync() directly and
    // this guard would miss it (CodeRabbit review, #2400).
    pattern:
      /\bghTextAsync\s*\(|\bghText\s*\(|\bghApiJson\s*\(|\bghGraphql\s*\(/,
    description: 'a bare ghTextAsync()/ghText()/ghApiJson()/ghGraphql() call',
  },
];
/** Directories whose tracked `.mts`/`.mjs` files must hold no NUL byte. */
export const NUL_SCAN_DIRS = ['src', 'scripts', 'bin', 'tests'];
/** True when `bytes` contains a literal U+0000 (NUL) byte. */
export function containsNulByte(bytes) {
  return bytes.includes(0x00);
}
function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
function violation(ruleId, path, message) {
  return { ruleId, path, message };
}
function inspectionViolation(ruleId, path, message) {
  return violation(`${ruleId}-INSPECTION`, path, message);
}
/**
 * Repository-relative `/`-separated names of the files under `directory`
 * whose name ends with `extension`, sorted. `recursive` descends into
 * subdirectories (the platform separator is normalized to `/`).
 */
function listFiles(root, directory, extension, recursive) {
  return readdirSync(join(root, directory), {
    encoding: 'utf8',
    recursive,
  })
    .filter((entry) => entry.endsWith(extension))
    .map((entry) => `${directory}/${entry.replaceAll('\\', '/')}`)
    .sort();
}
/**
 * Lists an inventory, or reports why it could not: an unreadable directory
 * and an empty result are both an incomplete inspection.
 */
function inventory(ruleId, root, directory, extension, recursive) {
  try {
    const files = listFiles(root, directory, extension, recursive);
    if (files.length === 0) {
      return {
        files,
        errors: [
          inspectionViolation(
            ruleId,
            directory,
            `no ${extension} files to inspect; an empty inventory would pass vacuously`,
          ),
        ],
      };
    }
    return { files, errors: [] };
  } catch (error) {
    return {
      files: [],
      errors: [
        inspectionViolation(
          ruleId,
          directory,
          `cannot list the inventory: ${describeError(error)}`,
        ),
      ],
    };
  }
}
/** Reads `path` as UTF-8, or records why it could not be read. */
function readText(ruleId, root, path, errors) {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch (error) {
    errors.push(
      inspectionViolation(
        ruleId,
        path,
        `cannot read the file: ${describeError(error)}`,
      ),
    );
    return null;
  }
}
/** NODE-IMPORT-BOUNDARY over every `src/**\/*.mts` file. */
export function checkNodeImportBoundary(root) {
  const { files, errors } = inventory(
    NODE_IMPORT_BOUNDARY,
    root,
    'src',
    '.mts',
    true,
  );
  const violations = [...errors];
  for (const path of files) {
    const text = readText(NODE_IMPORT_BOUNDARY, root, path, violations);
    if (text === null) {
      continue;
    }
    const scanned = scanImportSpecifiers(text);
    const bare = scanned.specifiers.filter(
      (specifier) =>
        !specifier.startsWith('node:') && !isRelativeSpecifier(specifier),
    );
    if (bare.length > 0) {
      violations.push(
        violation(
          NODE_IMPORT_BOUNDARY,
          path,
          `must import only node: builtins or relative paths so toolless ` +
            `adopters (package-manager / ephemeral-npx profiles, no ` +
            `node_modules) do not break; found bare specifier(s): ` +
            bare.join(', '),
        ),
      );
    }
    if (scanned.inspectionError) {
      violations.push(
        inspectionViolation(
          NODE_IMPORT_BOUNDARY,
          path,
          scanned.inspectionError,
        ),
      );
    }
  }
  return { ruleId: NODE_IMPORT_BOUNDARY, inspected: files.length, violations };
}
/**
 * The exact-mode `idd-template/scripts/` mirror set, derived from the
 * manifest text instead of a hardcoded name, so a future addition to this
 * mirror pattern is covered automatically.
 */
export function findExactTemplateScriptMirrors(manifestText) {
  const manifest = JSON.parse(manifestText);
  return (manifest.syncPairs ?? []).flatMap((pair) =>
    pair.mode === 'exact' &&
    typeof pair.source === 'string' &&
    typeof pair.target === 'string' &&
    pair.target.startsWith('idd-template/scripts/')
      ? [{ id: pair.id ?? pair.target, source: pair.source }]
      : [],
  );
}
/** STANDALONE-MIRROR-IMPORTS over the manifest's exact script mirrors. */
export function checkStandaloneMirrorImports(root) {
  const manifestPath = 'audit/sync-manifest.json';
  const violations = [];
  const manifestText = readText(
    STANDALONE_MIRROR_IMPORTS,
    root,
    manifestPath,
    violations,
  );
  if (manifestText === null) {
    return { ruleId: STANDALONE_MIRROR_IMPORTS, inspected: 0, violations };
  }
  let mirrors;
  try {
    mirrors = findExactTemplateScriptMirrors(manifestText);
  } catch (error) {
    violations.push(
      inspectionViolation(
        STANDALONE_MIRROR_IMPORTS,
        manifestPath,
        `cannot parse the manifest: ${describeError(error)}`,
      ),
    );
    return { ruleId: STANDALONE_MIRROR_IMPORTS, inspected: 0, violations };
  }
  if (mirrors.length === 0) {
    violations.push(
      inspectionViolation(
        STANDALONE_MIRROR_IMPORTS,
        manifestPath,
        'no exact-mode idd-template/scripts/ mirror to inspect; an empty ' +
          'derivation would pass vacuously',
      ),
    );
  }
  for (const { id, source } of mirrors) {
    const text = readText(STANDALONE_MIRROR_IMPORTS, root, source, violations);
    if (text === null) {
      continue;
    }
    const scanned = scanImportSpecifiers(text);
    const nonNode = scanned.specifiers.filter(
      (specifier) => !specifier.startsWith('node:'),
    );
    if (nonNode.length > 0) {
      violations.push(
        violation(
          STANDALONE_MIRROR_IMPORTS,
          source,
          `sync pair "${id}" must stay self-contained (Node built-ins only) ` +
            `so the idd-template/scripts/ mirror runs standalone; found: ` +
            nonNode.join(', '),
        ),
      );
    }
    if (scanned.inspectionError) {
      violations.push(
        inspectionViolation(
          STANDALONE_MIRROR_IMPORTS,
          source,
          scanned.inspectionError,
        ),
      );
    }
  }
  return {
    ruleId: STANDALONE_MIRROR_IMPORTS,
    inspected: mirrors.length,
    violations,
  };
}
/** GH-SPAWN-DIRECT over `src/scripts/*.mts` minus the documented exemptions. */
export function checkGhSpawnDirect(root) {
  const { files, errors } = inventory(
    GH_SPAWN_DIRECT,
    root,
    'src/scripts',
    '.mts',
    false,
  );
  const violations = [...errors];
  let inspected = 0;
  for (const path of files) {
    if (GH_SPAWN_EXEMPT_FILES.has(path.slice(path.lastIndexOf('/') + 1))) {
      continue;
    }
    inspected += 1;
    const text = readText(GH_SPAWN_DIRECT, root, path, violations);
    if (text !== null && DIRECT_GH_SPAWN_PATTERN.test(text)) {
      violations.push(
        violation(
          GH_SPAWN_DIRECT,
          path,
          `spawns gh directly; route every gh subprocess call through ` +
            `gh-exec.mts's ghText / safeGhText / ghApiJson / ghTextAsync`,
        ),
      );
    }
  }
  return { ruleId: GH_SPAWN_DIRECT, inspected, violations };
}
/**
 * PROVIDER-PORT-MIGRATED over each enrolled helper's source and committed
 * generated copy, plus the existence of the exempt adapter modules.
 */
export function checkProviderPortMigrated(root) {
  const violations = [];
  for (const filename of PROVIDER_PORT_ADAPTER_FILES) {
    readText(
      PROVIDER_PORT_MIGRATED,
      root,
      `src/scripts/${filename}`,
      violations,
    );
  }
  let inspected = 0;
  for (const filename of MIGRATED_HELPERS) {
    const targets = [
      {
        path: `src/scripts/${filename}`,
        where: 'after migrating onto provider-port.mts',
      },
      {
        // The generated copy is committed 1:1 per source (#2268).
        path: `scripts/${filename.replace(/\.mts$/, '.mjs')}`,
        where: 'in committed generated output',
      },
    ];
    for (const { path, where } of targets) {
      inspected += 1;
      const text = readText(PROVIDER_PORT_MIGRATED, root, path, violations);
      if (text === null) {
        continue;
      }
      for (const { pattern, description } of DIRECT_GH_PATTERNS) {
        if (pattern.test(text)) {
          violations.push(
            violation(
              PROVIDER_PORT_MIGRATED,
              path,
              `regained ${description} ${where}`,
            ),
          );
        }
      }
    }
  }
  return { ruleId: PROVIDER_PORT_MIGRATED, inspected, violations };
}
/**
 * The child environment for `git ls-files`: every inherited override that
 * can redirect the command away from `root` or change how it reads the
 * repository is removed -- the repository-location variables, the object and
 * ref redirections, and the whole `GIT_CONFIG*` family -- so a hook,
 * wrapper or parent process cannot make the NUL rule inspect another
 * repository (the same set `idd-onboard.mts` removes for its own reads).
 */
function gitEnvironment() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_CONFIG')) {
      delete env[name];
    }
  }
  for (const name of [
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_NAMESPACE',
    'GIT_QUARANTINE_PATH',
    'GIT_REPLACE_REF_BASE',
    'GIT_NO_REPLACE_OBJECTS',
  ]) {
    delete env[name];
  }
  return env;
}
/**
 * Tracked `.mts`/`.mjs` paths under `NUL_SCAN_DIRS`, via the `git ls-files`
 * plumbing command (`-z` keeps a non-ASCII name unquoted). Throws when git
 * cannot run or exits non-zero.
 */
function listTrackedSources(root) {
  const result = spawnSync(
    'git',
    ['-C', root, 'ls-files', '-z', '--', ...NUL_SCAN_DIRS],
    { encoding: 'utf8', env: gitEnvironment() },
  );
  if (result.error) {
    throw new Error(`failed to run git ls-files: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`git ls-files exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout
    .split('\0')
    .filter((path) => path.endsWith('.mts') || path.endsWith('.mjs'));
}
/** NO-NUL-BYTES over the tracked sources under `NUL_SCAN_DIRS`. */
export function checkNoNulBytes(root) {
  let paths;
  try {
    paths = listTrackedSources(root);
  } catch (error) {
    return {
      ruleId: NO_NUL_BYTES,
      inspected: 0,
      violations: [
        inspectionViolation(
          NO_NUL_BYTES,
          NUL_SCAN_DIRS.join(', '),
          `cannot enumerate tracked sources: ${describeError(error)}`,
        ),
      ],
    };
  }
  const violations = [];
  if (paths.length === 0) {
    violations.push(
      inspectionViolation(
        NO_NUL_BYTES,
        NUL_SCAN_DIRS.join(', '),
        'no tracked .mts/.mjs source to inspect; an empty inventory would ' +
          'pass vacuously',
      ),
    );
  }
  for (const path of paths) {
    let bytes;
    try {
      bytes = readFileSync(join(root, path));
    } catch (error) {
      violations.push(
        inspectionViolation(
          NO_NUL_BYTES,
          path,
          `cannot read the file: ${describeError(error)}`,
        ),
      );
      continue;
    }
    if (containsNulByte(bytes)) {
      violations.push(
        violation(
          NO_NUL_BYTES,
          path,
          'contains a literal NUL byte; escape it as \\0 (or \\x00/\\u0000) ' +
            'instead of embedding a raw U+0000 byte (#3340)',
        ),
      );
    }
  }
  return { ruleId: NO_NUL_BYTES, inspected: paths.length, violations };
}
/** Runs every rule family against the repository at `root`. */
export function runBoundaryRules(root) {
  return [
    checkNodeImportBoundary(root),
    checkStandaloneMirrorImports(root),
    checkGhSpawnDirect(root),
    checkProviderPortMigrated(root),
    checkNoNulBytes(root),
  ];
}
/** Code-unit order, so the report never depends on the process locale. */
function compareText(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
/** Every violation of every rule, ordered by rule, path and message. */
export function collectBoundaryViolations(results) {
  return results
    .flatMap((result) => result.violations)
    .sort(
      (a, b) =>
        compareText(a.ruleId, b.ruleId) ||
        compareText(a.path, b.path) ||
        compareText(a.message, b.message),
    );
}
function parseArguments(argv) {
  let root = null;
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
      root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return { root, help };
}
/** CLI entry: exit 0 clean, 1 on any violation, 2 on a usage error. */
export function main(argv = process.argv.slice(2)) {
  let root;
  try {
    const parsed = parseArguments(argv);
    if (parsed.help) {
      process.stdout.write(
        'Usage: node scripts/lint-source-boundaries.mjs [--root <repository>] [--help]\n',
      );
      return 0;
    }
    // The default root is resolved only when no --root was given, so a copy
    // of this script outside a checkout can still inspect an explicit tree.
    root = parsed.root ?? resolveBundleRoot(import.meta.dirname);
  } catch (error) {
    process.stderr.write(`lint-source-boundaries: ${describeError(error)}\n`);
    return 2;
  }
  const results = runBoundaryRules(root);
  const violations = collectBoundaryViolations(results);
  if (violations.length > 0) {
    for (const item of violations) {
      process.stderr.write(`${item.ruleId} ${item.path}: ${item.message}\n`);
    }
    process.stderr.write(
      `lint-source-boundaries: ${violations.length} violation(s)\n`,
    );
    return 1;
  }
  for (const result of results) {
    process.stdout.write(
      `lint-source-boundaries: ${result.ruleId} inspected ${result.inspected}\n`,
    );
  }
  process.stdout.write(
    'lint-source-boundaries: all source boundaries passed\n',
  );
  return 0;
}
if (import.meta.main) {
  process.exitCode = main();
}
