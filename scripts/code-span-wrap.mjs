// idd-generated-from: src/scripts/code-span-wrap.mts
//
// The scripts/code-span-wrap.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Detects corrupting splits inside Markdown inline code spans
// (idd-skill issues #1677 and #4563). CommonMark converts a line ending
// inside a code span to a single space, while a literal space or tab is
// already rendered as whitespace. Either can split a token immediately
// after a hyphen, underscore, slash, or dot that the token continues
// through. The resulting command or identifier can no longer be copied
// correctly; the literal-space incident was observed in issue #4315.
// Breaks and spaces at real word boundaries remain readable and are
// deliberately NOT flagged here. Fenced and indented code blocks and raw
// HTML blocks are excluded before scanning because CommonMark does not parse
// inline code spans inside those blocks.
//
// The character immediately before the break's continuation character,
// and the character immediately after the break, must each be
// "token-continuing": alphanumeric, OR itself one of the continuation
// characters (`-_/.`), OR simply absent because the continuation
// character is the very first character of the span's content (no
// `prevPrevChar` to check at all). A single alphanumeric-only check
// (PR #1736 review, Copilot + Codex) missed real corrupting cases where
// the neighbor is punctuation rather than a letter/digit -- `./\npath`,
// `../\npath` (prevPrevChar is `.`), `path/\n.gitignore` (nextChar is
// `.`), `--\nflag` (prevPrevChar is the other `-`) -- and a follow-up
// review pass caught that a *single*-character prefix (the continuation
// character starting the span outright, e.g. `` `/\nusr/bin` `` or
// `` `-\nflag` ``) still fell through, since `prevPrevChar` is
// `undefined` there rather than a real character to test. Treating
// "no character precedes it" as passing (nothing there to disqualify
// it) closes that gap. Verified both broadenings add zero new false
// positives against every existing multi-line code span already in
// this repository's corpus.
import {
  findFencedCodeRanges,
  findHtmlBlockRanges,
  findHtmlCommentRanges,
  findIndentedCodeRanges,
  findInlineCodeRanges,
  findInlineCodeSpans,
  findMarkdownCodeRanges,
  maskMarkdownCodeRegionsPreservingPositions,
  mergeMarkdownCodeRanges,
} from './markdown-code.mjs';

const MID_TOKEN_CONTINUATION = /[-_/.]/;
const TOKEN_CONTINUING = /[A-Za-z0-9\-_/.]/;
const CONTEXT_CHARS = 20;
const PROPER_NAME_TITLE_ABBREVIATION =
  /(?:^|(?<![\p{L}\p{N}_./-]))(?:Mr|Mrs|Ms|Mx|Dr|Prof|Rev|Hon|Sr|Jr|St|Capt|Col|Gen|Sgt|Lt|Maj|Cmdr|Adm|Fr|Br)\.$/iu;
const DOTTED_IDENTIFIER_PREFIX =
  /^\s*[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u;
const MAX_DECLARATION_GENERIC_DEPTH = 8;
const DECLARATION_PRIMITIVE_ARRAY_ELEMENTS = [
  'boolean',
  'byte',
  'char',
  'double',
  'float',
  'int',
  'long',
  'short',
];
const DECLARATION_CLAUSE_KEYWORDS = ['extends', 'implements', 'permits'];
function skipDeclarationWhitespace(text, start) {
  let cursor = start;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}
function skipDeclarationTrivia(text, start) {
  let cursor = start;
  while (cursor < text.length) {
    const afterWhitespace = skipDeclarationWhitespace(text, cursor);
    if (afterWhitespace !== cursor) {
      cursor = afterWhitespace;
      continue;
    }
    if (text.startsWith('//', cursor)) {
      const lineEnd = text.indexOf('\n', cursor + 2);
      cursor = lineEnd < 0 ? text.length : lineEnd + 1;
      continue;
    }
    if (text.startsWith('/*', cursor)) {
      const commentEnd = text.indexOf('*/', cursor + 2);
      if (commentEnd < 0) {
        return text.length;
      }
      cursor = commentEnd + 2;
      continue;
    }
    break;
  }
  return cursor;
}
function isDeclarationTriviaOnly(text, start) {
  let cursor = start;
  while (cursor < text.length) {
    const afterWhitespace = skipDeclarationWhitespace(text, cursor);
    if (afterWhitespace !== cursor) {
      cursor = afterWhitespace;
      continue;
    }
    if (text.startsWith('//', cursor)) {
      const lineEnd = text.indexOf('\n', cursor + 2);
      if (lineEnd < 0) {
        return true;
      }
      cursor = lineEnd + 1;
      continue;
    }
    if (!text.startsWith('/*', cursor)) {
      return false;
    }
    const commentEnd = text.indexOf('*/', cursor + 2);
    if (commentEnd < 0) {
      return false;
    }
    cursor = commentEnd + 2;
  }
  return true;
}
function findBalancedDeclarationDelimiterEnd(text, start, open, close) {
  if (text[start] !== open) {
    return undefined;
  }
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    const nextCharacter = text[cursor + 1];
    if (character === '"' && text.startsWith('"""', cursor)) {
      cursor += 3;
      let terminated = false;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text.startsWith('"""', cursor)) {
          cursor += 3;
          terminated = true;
          break;
        }
        cursor += 1;
      }
      if (!terminated) {
        return undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      cursor += 1;
      while (cursor < text.length) {
        if (text[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '\n') {
        cursor += 1;
      }
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      const commentEnd = text.indexOf('*/', cursor + 2);
      if (commentEnd < 0) {
        return undefined;
      }
      cursor = commentEnd + 2;
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return undefined;
}
function skipDeclarationQuotedLiteralEnd(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") {
    return undefined;
  }
  const delimiter =
    quote === '"' && text.startsWith('"""', start) ? '"""' : quote;
  let cursor = start + delimiter.length;
  while (cursor < text.length) {
    if (text[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (text.startsWith(delimiter, cursor)) {
      return cursor + delimiter.length;
    }
    cursor += 1;
  }
  return undefined;
}
function skipDeclarationCommentEnd(text, start) {
  if (text.startsWith('//', start)) {
    const lineEnd = text.indexOf('\n', start + 2);
    return lineEnd < 0 ? text.length : lineEnd + 1;
  }
  if (text.startsWith('/*', start)) {
    const commentEnd = text.indexOf('*/', start + 2);
    return commentEnd < 0 ? undefined : commentEnd + 2;
  }
  return undefined;
}
function skipDeclarationAnnotation(text, start) {
  const annotation =
    /^@[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/u.exec(
      text.slice(start),
    );
  if (annotation === null) {
    return undefined;
  }
  const cursor = skipDeclarationTrivia(text, start + annotation[0].length);
  if (text[cursor] !== '(') {
    return cursor;
  }
  return findBalancedDeclarationDelimiterEnd(text, cursor, '(', ')');
}
function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isDeclarationIdentifierStart(code) {
  return isAsciiLetter(code) || code === 36 || code === 95;
}
function isDeclarationIdentifierContinuation(code) {
  return (
    isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 36 ||
    code === 45 ||
    code === 95
  );
}
function parseDeclarationTypeList(text, start) {
  let typeEnd = parseDeclarationType(text, start, 0, true, false, true);
  if (typeEnd === undefined) {
    return undefined;
  }
  let cursor = typeEnd;
  while (true) {
    const commaIndex = skipDeclarationTrivia(text, cursor);
    if (text[commaIndex] !== ',') {
      return cursor;
    }
    cursor = skipDeclarationTrivia(text, commaIndex + 1);
    typeEnd = parseDeclarationType(text, cursor, 0, true, false, true);
    if (typeEnd === undefined) {
      return undefined;
    }
    cursor = typeEnd;
  }
}
function skipDeclarationTypeAnnotations(text, start) {
  let cursor = skipDeclarationTrivia(text, start);
  while (true) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd === undefined) {
      return cursor;
    }
    cursor = skipDeclarationTrivia(text, annotationEnd);
  }
}
function parseDeclarationGenericArguments(
  text,
  start,
  genericDepth,
  rejectRootWildcard,
) {
  if (text[start] !== '<' || genericDepth >= MAX_DECLARATION_GENERIC_DEPTH) {
    return undefined;
  }
  let cursor = skipDeclarationTrivia(text, start + 1);
  let argumentEnd = parseDeclarationTypeArgument(
    text,
    cursor,
    genericDepth + 1,
    rejectRootWildcard,
  );
  if (argumentEnd === undefined) {
    return undefined;
  }
  cursor = argumentEnd;
  while (true) {
    const commaIndex = skipDeclarationTrivia(text, cursor);
    if (text[commaIndex] !== ',') {
      break;
    }
    cursor = skipDeclarationTrivia(text, commaIndex + 1);
    argumentEnd = parseDeclarationTypeArgument(
      text,
      cursor,
      genericDepth + 1,
      rejectRootWildcard,
    );
    if (argumentEnd === undefined) {
      return undefined;
    }
    cursor = argumentEnd;
  }
  cursor = skipDeclarationTrivia(text, cursor);
  return text[cursor] === '>' ? cursor + 1 : undefined;
}
function parseDeclarationType(
  text,
  start,
  genericDepth,
  requireUppercaseFinal = true,
  allowArraySuffix = false,
  rejectRootWildcard = false,
) {
  let cursor = skipDeclarationTypeAnnotations(text, start);
  let finalSegmentStartsUppercase = false;
  while (true) {
    const firstCode = text.charCodeAt(cursor);
    if (!isDeclarationIdentifierStart(firstCode)) {
      return undefined;
    }
    finalSegmentStartsUppercase =
      (firstCode >= 65 && firstCode <= 90) ||
      (firstCode === 36 &&
        text.charCodeAt(cursor + 1) >= 65 &&
        text.charCodeAt(cursor + 1) <= 90);
    cursor += 1;
    while (isDeclarationIdentifierContinuation(text.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (text[cursor] === '<') {
      const genericArgumentsEnd = parseDeclarationGenericArguments(
        text,
        cursor,
        genericDepth,
        rejectRootWildcard,
      );
      if (genericArgumentsEnd === undefined) {
        return undefined;
      }
      cursor = genericArgumentsEnd;
    }
    if (text[cursor] !== '.') {
      break;
    }
    cursor = skipDeclarationTypeAnnotations(text, cursor + 1);
  }
  if (requireUppercaseFinal && !finalSegmentStartsUppercase) {
    return undefined;
  }
  if (allowArraySuffix) {
    while (true) {
      const dimensionStart = skipDeclarationTypeAnnotations(text, cursor);
      if (text[dimensionStart] !== '[') {
        break;
      }
      const dimensionEnd = skipDeclarationTrivia(text, dimensionStart + 1);
      if (text[dimensionEnd] !== ']') {
        return undefined;
      }
      cursor = dimensionEnd + 1;
    }
  }
  return cursor;
}
function parseDeclarationTypeArgument(
  text,
  start,
  genericDepth,
  rejectRootWildcard,
) {
  const cursor = skipDeclarationTypeAnnotations(text, start);
  if (text[cursor] !== '?') {
    return parseDeclarationType(
      text,
      cursor,
      genericDepth,
      false,
      true,
      rejectRootWildcard,
    );
  }
  // Wildcards directly inside a declaration supertype are invalid evidence;
  // nested arguments such as Base<List<?>> remain valid.
  if (rejectRootWildcard && genericDepth === 1) {
    return undefined;
  }
  let boundStart = skipDeclarationTrivia(text, cursor + 1);
  let varianceKeyword;
  for (const keyword of ['extends', 'super']) {
    const keywordEnd = boundStart + keyword.length;
    if (
      text.startsWith(keyword, boundStart) &&
      !isDeclarationIdentifierContinuation(text.charCodeAt(keywordEnd))
    ) {
      varianceKeyword = keyword;
      boundStart = skipDeclarationTrivia(text, keywordEnd);
      break;
    }
  }
  if (varianceKeyword === undefined) {
    return cursor + 1;
  }
  const primitive = DECLARATION_PRIMITIVE_ARRAY_ELEMENTS.find(
    (type) =>
      text.startsWith(type, boundStart) &&
      !isDeclarationIdentifierContinuation(
        text.charCodeAt(boundStart + type.length),
      ),
  );
  let boundEnd =
    primitive === undefined
      ? parseDeclarationType(
          text,
          boundStart,
          genericDepth,
          true,
          false,
          rejectRootWildcard,
        )
      : boundStart + primitive.length;
  if (boundEnd === undefined) {
    return undefined;
  }
  let isArray = false;
  while (true) {
    const openIndex = skipDeclarationTypeAnnotations(text, boundEnd);
    if (text[openIndex] !== '[') {
      break;
    }
    const closeIndex = skipDeclarationTrivia(text, openIndex + 1);
    if (text[closeIndex] !== ']') {
      return undefined;
    }
    isArray = true;
    boundEnd = closeIndex + 1;
  }
  return primitive !== undefined && !isArray ? undefined : boundEnd;
}
function skipDeclarationGenericClause(text, start) {
  if (text[start] !== '<') {
    return undefined;
  }
  let depth = 0;
  let hasContent = false;
  for (let cursor = start; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (character === '@') {
      const annotationEnd = skipDeclarationAnnotation(text, cursor);
      if (annotationEnd === undefined) {
        return undefined;
      }
      hasContent = true;
      cursor = annotationEnd - 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      hasContent = true;
      cursor = literalEnd - 1;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd - 1;
      continue;
    }
    if (character === '<') {
      depth += 1;
      if (depth > MAX_DECLARATION_GENERIC_DEPTH) {
        return undefined;
      }
    } else if (character === '>') {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
      if (depth === 0) {
        return hasContent ? cursor + 1 : undefined;
      }
    } else if (depth > 0 && !/\s/u.test(character ?? '')) {
      hasContent = true;
    }
  }
  return undefined;
}
function isCompleteDeclarationTail(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const keyword = DECLARATION_CLAUSE_KEYWORDS.find((candidate) =>
      text.startsWith(candidate, cursor),
    );
    if (keyword === undefined) {
      return false;
    }
    cursor += keyword.length;
    const typeListStart = skipDeclarationTrivia(text, cursor);
    if (typeListStart === cursor) {
      return false;
    }
    cursor = typeListStart;
    const typeListEnd = parseDeclarationTypeList(text, cursor);
    if (typeListEnd === undefined) {
      return false;
    }
    cursor = typeListEnd;
    const nextClause = skipDeclarationTrivia(text, cursor);
    if (nextClause === text.length) {
      return isDeclarationTriviaOnly(text, cursor);
    }
    if (nextClause === cursor) {
      return false;
    }
    cursor = nextClause;
  }
  return false;
}
function consumeTypeBodyRemainder(text, start) {
  let cursor = skipDeclarationTrivia(text, start);
  while (cursor < text.length) {
    if (text[cursor] === '}') {
      return cursor + 1;
    }
    const memberEnd = skipCompleteTypeBodyMember(text, cursor);
    if (memberEnd === undefined || memberEnd <= cursor) {
      return undefined;
    }
    cursor = skipDeclarationTrivia(text, memberEnd);
  }
  return undefined;
}
function consumeBlockRemainder(text, start) {
  let cursor = skipDeclarationTrivia(text, start);
  while (cursor < text.length) {
    if (text[cursor] === '}') {
      return cursor + 1;
    }
    const statementEnd = findDeclarationBlockStatementEnd(text, cursor);
    if (statementEnd === undefined || statementEnd <= cursor) {
      return undefined;
    }
    cursor = skipDeclarationTrivia(text, statementEnd);
  }
  return undefined;
}
function getDeclarationBlockCompoundKind(text, start) {
  const cursor = skipDeclarationTrivia(text, start);
  const keyword = /^(if|try|for|while|switch|synchronized|do)\b/u.exec(
    text.slice(cursor),
  );
  if (keyword !== null) {
    if (keyword[0] === 'if') {
      return 'if';
    }
    if (keyword[0] === 'try') {
      return 'try';
    }
    if (keyword[0] === 'do') {
      return 'do';
    }
    return 'other';
  }
  const boundary = findTypeBodyMemberDelimiter(text, cursor);
  return boundary?.delimiter === '{' &&
    getTypeDeclarationBodyKind(text.slice(cursor, boundary.index)) !== undefined
    ? 'type'
    : undefined;
}
function hasDeclarationBlockContinuation(text, start, kind) {
  const cursor = skipDeclarationTrivia(text, start);
  const keywords =
    kind === 'if'
      ? ['else']
      : kind === 'try'
        ? ['catch', 'finally']
        : kind === 'do'
          ? ['while']
          : [];
  return keywords.some(
    (keyword) =>
      text.startsWith(keyword, cursor) &&
      !isDeclarationIdentifierContinuation(
        text.charCodeAt(cursor + keyword.length),
      ),
  );
}
function findDeclarationBlockStatementEnd(text, start) {
  const compoundKind = getDeclarationBlockCompoundKind(text, start);
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) {
        return undefined;
      }
      parentheses -= 1;
    } else if (character === '[') {
      brackets += 1;
    } else if (character === ']') {
      if (brackets === 0) {
        return undefined;
      }
      brackets -= 1;
    } else if (character === '{') {
      braces += 1;
    } else if (character === '}') {
      if (braces === 0) {
        return undefined;
      }
      braces -= 1;
      if (
        braces === 0 &&
        compoundKind !== undefined &&
        !hasDeclarationBlockContinuation(text, cursor + 1, compoundKind)
      ) {
        return cursor + 1;
      }
    } else if (
      character === ';' &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      if (
        compoundKind === undefined ||
        !hasDeclarationBlockContinuation(text, cursor + 1, compoundKind)
      ) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return undefined;
}
function skipInvocationRemainder(text, start, invocationDepth) {
  if (invocationDepth < 1) {
    return undefined;
  }
  let depth = invocationDepth;
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return undefined;
}
function isDeclarationTailWithEnclosingBraces(text, start, enclosingContexts) {
  let cursor = skipDeclarationTrivia(text, start);
  for (let index = enclosingContexts.length - 1; index >= 0; index -= 1) {
    const context = enclosingContexts[index];
    if (context === undefined) {
      return false;
    }
    if (
      context.kind === 'type' ||
      context.kind === 'enum' ||
      context.kind === 'anonymous'
    ) {
      const bodyEnd = consumeTypeBodyRemainder(text, cursor);
      if (bodyEnd === undefined) {
        return false;
      }
      cursor = skipDeclarationTrivia(text, bodyEnd);
    } else if (context.kind === 'anonymous-call') {
      if (text[cursor] !== '}') {
        return false;
      }
      const invocationEnd = skipInvocationRemainder(
        text,
        cursor + 1,
        context.invocationDepth ?? 0,
      );
      if (invocationEnd === undefined) {
        return false;
      }
      cursor = skipDeclarationTrivia(text, invocationEnd);
      if (text[cursor] === ';') {
        cursor = skipDeclarationTrivia(text, cursor + 1);
      }
    } else if (context.kind === 'block') {
      const blockEnd = consumeBlockRemainder(text, cursor);
      if (blockEnd === undefined) {
        return false;
      }
      cursor = skipDeclarationTrivia(text, blockEnd);
    } else {
      return false;
    }
    if (context.kind === 'anonymous' && text[cursor] === ';') {
      cursor = skipDeclarationTrivia(text, cursor + 1);
    }
  }
  return cursor === text.length;
}
function isCompleteDeclarationBlock(text, enclosingContexts = []) {
  const start = skipDeclarationTrivia(text, 0);
  const blockEnd = findBalancedDeclarationDelimiterEnd(text, start, '{', '}');
  return (
    blockEnd !== undefined &&
    isDeclarationTailWithEnclosingBraces(text, blockEnd, enclosingContexts)
  );
}
function isQualifiedDeclarationTypeListPrefix(text) {
  const normalized = normalizeSplitQualifiedTypeWhitespace(text);
  let cursor = skipDeclarationTypeAnnotations(normalized, 0);
  while (cursor < normalized.length) {
    const remaining = normalized.slice(cursor).trimEnd();
    if (isPartialQualifiedDeclarationTypePrefix(remaining)) {
      return true;
    }
    const typeEnd = parseDeclarationType(normalized, cursor, 0);
    if (typeEnd === undefined) {
      return false;
    }
    const commaIndex = skipDeclarationTrivia(normalized, typeEnd);
    if (normalized[commaIndex] !== ',') {
      return false;
    }
    cursor = skipDeclarationTypeAnnotations(normalized, commaIndex + 1);
  }
  return false;
}
function materializeDeclarationBodyContexts(snapshot) {
  const contexts = [];
  for (
    let context = snapshot;
    context !== undefined;
    context = context.parent
  ) {
    contexts.push({
      kind: context.kind,
      invocationDepth: context.invocationDepth,
    });
  }
  contexts.reverse();
  return contexts;
}
function isPartialQualifiedDeclarationTypePrefix(text) {
  const normalized = text.trimEnd();
  const typeEnd = parseDeclarationType(normalized, 0, 0, false);
  return typeEnd === normalized.length;
}
function hasTopLevelDeclarationTypeListComma(text) {
  const normalized = normalizeSplitQualifiedTypeWhitespace(text);
  const firstTypeEnd = parseDeclarationType(normalized, 0, 0);
  if (firstTypeEnd === undefined) {
    return false;
  }
  const separator = skipDeclarationTrivia(normalized, firstTypeEnd);
  return normalized[separator] === ',';
}
function isQualifiedClassExtendsPrefix(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  const declarationKind = /^(class|interface)\b/u.exec(text.slice(cursor));
  if (declarationKind === null) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, cursor + declarationKind[0].length);
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return false;
  }
  cursor += name[0].length;
  cursor = skipDeclarationTrivia(text, cursor);
  if (text[cursor] === '<') {
    const genericClauseEnd = skipDeclarationGenericClause(text, cursor);
    if (genericClauseEnd === undefined) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, genericClauseEnd);
  }
  const extendsClause = /^extends\b/u.exec(text.slice(cursor));
  if (extendsClause === null) {
    return false;
  }
  const typeListStart = skipDeclarationTrivia(
    text,
    cursor + extendsClause[0].length,
  );
  if (typeListStart === cursor + extendsClause[0].length) {
    return false;
  }
  const typeListPrefix = text.slice(typeListStart);
  return (
    (declarationKind[1] === 'interface' ||
      !hasTopLevelDeclarationTypeListComma(typeListPrefix)) &&
    isQualifiedDeclarationTypeListPrefix(typeListPrefix)
  );
}
function getTypeDeclarationBodyKind(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  const declarationKind = /^(class|interface|enum|record)\b/u.exec(
    text.slice(cursor),
  );
  if (declarationKind === null) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, cursor + declarationKind[0].length);
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, cursor + name[0].length);
  const kind = declarationKind[1];
  if (text[cursor] === '<' && kind !== 'enum') {
    const genericClauseEnd = skipDeclarationGenericClause(text, cursor);
    if (genericClauseEnd === undefined) {
      return undefined;
    }
    cursor = genericClauseEnd;
  }
  if (kind === 'record') {
    cursor = skipDeclarationTrivia(text, cursor);
    const componentsEnd = findBalancedDeclarationDelimiterEnd(
      text,
      cursor,
      '(',
      ')',
    );
    if (componentsEnd === undefined) {
      return undefined;
    }
    cursor = componentsEnd;
  }
  while (true) {
    cursor = skipDeclarationTrivia(text, cursor);
    if (cursor === text.length) {
      return kind === 'enum' ? 'enum' : 'type';
    }
    const keyword = DECLARATION_CLAUSE_KEYWORDS.find((candidate) =>
      text.startsWith(candidate, cursor),
    );
    const allowedKeywords =
      kind === 'class'
        ? DECLARATION_CLAUSE_KEYWORDS
        : kind === 'interface'
          ? ['extends', 'permits']
          : ['implements'];
    if (keyword === undefined || !allowedKeywords.includes(keyword)) {
      return undefined;
    }
    const typeListStart = skipDeclarationTrivia(text, cursor + keyword.length);
    if (typeListStart === cursor + keyword.length) {
      return undefined;
    }
    const typeListEnd = parseDeclarationTypeList(text, typeListStart);
    if (
      typeListEnd === undefined ||
      (kind === 'class' &&
        keyword === 'extends' &&
        hasTopLevelDeclarationTypeListComma(
          text.slice(typeListStart, typeListEnd),
        ))
    ) {
      return undefined;
    }
    cursor = typeListEnd;
  }
}
function isDeclarationMethodHeader(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|abstract|static|final|default|synchronized|native|strictfp|sealed|non-sealed)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  if (text[cursor] === '<') {
    const typeParametersEnd = skipDeclarationGenericClause(text, cursor);
    if (typeParametersEnd === undefined) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, typeParametersEnd);
  }
  const returnTypeEnd = parseDeclarationType(text, cursor, 0, false, true);
  if (returnTypeEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, returnTypeEnd);
  if (cursor === returnTypeEnd) {
    return false;
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, cursor + name[0].length);
  const parametersEnd = findBalancedDeclarationDelimiterEnd(
    text,
    cursor,
    '(',
    ')',
  );
  if (parametersEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, parametersEnd);
  const throwsClause = /^throws\b/u.exec(text.slice(cursor));
  if (throwsClause !== null) {
    const typeListStart = skipDeclarationTrivia(
      text,
      cursor + throwsClause[0].length,
    );
    if (typeListStart === cursor + throwsClause[0].length) {
      return false;
    }
    const typeListEnd = parseDeclarationTypeList(text, typeListStart);
    if (typeListEnd === undefined) {
      return false;
    }
    cursor = typeListEnd;
  }
  return isDeclarationTriviaOnly(text, cursor);
}
function isDeclarationConstructorHeader(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier = /^(?:public|protected|private)\b/u.exec(
      text.slice(cursor),
    );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  if (text[cursor] === '<') {
    const typeParametersEnd = skipDeclarationGenericClause(text, cursor);
    if (typeParametersEnd === undefined) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, typeParametersEnd);
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, cursor + name[0].length);
  const parametersEnd = findBalancedDeclarationDelimiterEnd(
    text,
    cursor,
    '(',
    ')',
  );
  if (parametersEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, parametersEnd);
  const throwsClause = /^throws\b/u.exec(text.slice(cursor));
  if (throwsClause !== null) {
    const typeListStart = skipDeclarationTrivia(
      text,
      cursor + throwsClause[0].length,
    );
    if (typeListStart === cursor + throwsClause[0].length) {
      return false;
    }
    const typeListEnd = parseDeclarationTypeList(text, typeListStart);
    if (typeListEnd === undefined) {
      return false;
    }
    cursor = typeListEnd;
  }
  return isDeclarationTriviaOnly(text, cursor);
}
function findDeclarationFieldInitializerDelimiter(text, start) {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      if (parentheses === 0) {
        return undefined;
      }
      parentheses -= 1;
    } else if (character === '[') {
      brackets += 1;
    } else if (character === ']') {
      if (brackets === 0) {
        return undefined;
      }
      brackets -= 1;
    } else if (character === '{') {
      braces += 1;
    } else if (character === '}') {
      if (braces === 0) {
        return undefined;
      }
      braces -= 1;
    } else if (
      character === '<' &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      const genericEnd = skipDeclarationGenericClause(text, cursor);
      if (genericEnd !== undefined) {
        cursor = genericEnd;
        continue;
      }
    } else if (
      character === ',' &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return cursor;
    }
    cursor += 1;
  }
  return parentheses === 0 && brackets === 0 && braces === 0
    ? text.length
    : undefined;
}
function isDeclarationFieldHeader(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|static|final|transient|volatile)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  const typeEnd = parseDeclarationType(text, cursor, 0, false, true);
  if (typeEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, typeEnd);
  if (cursor === typeEnd) {
    return false;
  }
  while (cursor < text.length) {
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
    if (name === null) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, cursor + name[0].length);
    while (text[cursor] === '[') {
      const dimensionEnd = skipDeclarationTrivia(text, cursor + 1);
      if (text[dimensionEnd] !== ']') {
        return false;
      }
      cursor = skipDeclarationTrivia(text, dimensionEnd + 1);
    }
    if (cursor === text.length) {
      return true;
    }
    if (text[cursor] === '=') {
      const initializerStart = skipDeclarationTrivia(text, cursor + 1);
      if (initializerStart === text.length) {
        return false;
      }
      const delimiter = findDeclarationFieldInitializerDelimiter(
        text,
        initializerStart,
      );
      if (delimiter === undefined) {
        return false;
      }
      if (delimiter === text.length) {
        return true;
      }
      cursor = skipDeclarationTrivia(text, delimiter + 1);
      if (cursor === text.length) {
        return false;
      }
      continue;
    }
    if (text[cursor] !== ',') {
      return false;
    }
    cursor = skipDeclarationTrivia(text, cursor + 1);
    if (cursor === text.length) {
      return false;
    }
  }
  return false;
}
function findTypeBodyMemberDelimiter(text, start) {
  let parentheses = 0;
  let brackets = 0;
  let generics = 0;
  let initializerBraces = 0;
  let inInitializer = false;
  let cursor = start;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      parentheses += 1;
    } else if (character === ')') {
      parentheses = Math.max(0, parentheses - 1);
    } else if (character === '[') {
      brackets += 1;
    } else if (character === ']') {
      brackets = Math.max(0, brackets - 1);
    } else if (
      !inInitializer &&
      parentheses === 0 &&
      brackets === 0 &&
      generics === 0 &&
      character === '=' &&
      !['=', '!', '<', '>'].includes(text[cursor - 1] ?? '') &&
      text[cursor + 1] !== '=' &&
      text[cursor + 1] !== '>'
    ) {
      inInitializer = true;
    } else if (
      !inInitializer &&
      parentheses === 0 &&
      brackets === 0 &&
      character === '<'
    ) {
      generics += 1;
    } else if (
      !inInitializer &&
      parentheses === 0 &&
      brackets === 0 &&
      character === '>'
    ) {
      generics = Math.max(0, generics - 1);
    } else if (inInitializer && character === '{') {
      initializerBraces += 1;
    } else if (inInitializer && character === '}') {
      if (initializerBraces === 0) {
        return undefined;
      }
      initializerBraces -= 1;
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      generics === 0 &&
      !inInitializer &&
      (character === '{' || character === ';')
    ) {
      return { index: cursor, delimiter: character };
    } else if (
      parentheses === 0 &&
      brackets === 0 &&
      initializerBraces === 0 &&
      inInitializer &&
      character === ';'
    ) {
      return { index: cursor, delimiter: ';' };
    } else if (
      !inInitializer &&
      parentheses === 0 &&
      brackets === 0 &&
      generics === 0 &&
      character === '}'
    ) {
      return undefined;
    }
    cursor += 1;
  }
  return undefined;
}
function skipCompleteTypeBodyMember(text, start) {
  const boundary = findTypeBodyMemberDelimiter(text, start);
  if (boundary === undefined) {
    return undefined;
  }
  const header = text.slice(start, boundary.index);
  if (boundary.delimiter === ';') {
    return isDeclarationMethodHeader(header) || isDeclarationFieldHeader(header)
      ? boundary.index + 1
      : undefined;
  }
  const isAnonymousBody = getAnonymousClassBodyContext(header) !== undefined;
  if (
    getTypeDeclarationBodyKind(header) === undefined &&
    !isDeclarationMethodHeader(header) &&
    !isDeclarationConstructorHeader(header) &&
    !isAnonymousBody &&
    !/^(?:static)?$/u.test(header.trim())
  ) {
    return undefined;
  }
  const bodyEnd = findBalancedDeclarationDelimiterEnd(
    text,
    boundary.index,
    '{',
    '}',
  );
  if (bodyEnd === undefined) {
    return undefined;
  }
  const afterBody = skipDeclarationTrivia(text, bodyEnd);
  return isAnonymousBody && text[afterBody] === ';' ? afterBody + 1 : bodyEnd;
}
function getInvocationArgumentDepth(text) {
  const openings = [];
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      openings.push(cursor);
    } else if (character === ')') {
      openings.pop();
    }
    cursor += 1;
  }
  const openIndex = openings.at(-1);
  if (openIndex === undefined) {
    return undefined;
  }
  const callee = text.slice(0, openIndex).trimEnd();
  const calleeMatch =
    /(?:this|super|[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)$/u.exec(
      callee,
    );
  if (calleeMatch === null) {
    return undefined;
  }
  const beforeCallee = callee.slice(0, -calleeMatch[0].length).trimEnd();
  if (
    beforeCallee.length > 0 &&
    !/[,(]$/u.test(beforeCallee) &&
    !/^(?:return|throw)$/u.test(beforeCallee)
  ) {
    return undefined;
  }
  const argumentsPrefix = text.slice(openIndex + 1).trimEnd();
  if (argumentsPrefix.length > 0 && !argumentsPrefix.endsWith(',')) {
    return undefined;
  }
  return openings.length;
}
function isAnonymousClassCreationPrefix(text) {
  const start = skipDeclarationTrivia(text, 0);
  if (isDeclarationTriviaOnly(text, start)) {
    return true;
  }
  const controlPrefix = /^(return|throw)\b/u.exec(text.slice(start));
  if (controlPrefix !== null) {
    return isDeclarationTriviaOnly(text, start + controlPrefix[0].length);
  }
  if (getInvocationArgumentDepth(text) !== undefined) {
    return true;
  }
  const prefix = text.slice(start).trimEnd();
  const equalsIndex = prefix.lastIndexOf('=');
  if (equalsIndex !== prefix.length - 1) {
    return false;
  }
  const target = prefix.slice(0, equalsIndex).trimEnd();
  if (
    /^(?:this\.)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u.test(
      target,
    )
  ) {
    return true;
  }
  const typeEnd = parseDeclarationType(target, 0, 0, false, true);
  if (typeEnd === undefined) {
    return false;
  }
  const nameStart = skipDeclarationTrivia(target, typeEnd);
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(target.slice(nameStart));
  return (
    name !== null && isDeclarationTriviaOnly(target, nameStart + name[0].length)
  );
}
function getAnonymousClassBodyContext(text) {
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        return undefined;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        return undefined;
      }
      cursor = commentEnd;
      continue;
    }
    if (
      text.startsWith('new', cursor) &&
      !isDeclarationIdentifierContinuation(text.charCodeAt(cursor - 1)) &&
      !isDeclarationIdentifierContinuation(text.charCodeAt(cursor + 3)) &&
      isAnonymousClassCreationPrefix(text.slice(0, cursor))
    ) {
      let typeStart = skipDeclarationTrivia(text, cursor + 3);
      if (text[typeStart] === '<') {
        const constructorTypeArgumentsEnd = skipDeclarationGenericClause(
          text,
          typeStart,
        );
        if (constructorTypeArgumentsEnd === undefined) {
          cursor += 3;
          continue;
        }
        typeStart = skipDeclarationTrivia(text, constructorTypeArgumentsEnd);
      }
      const typeEnd = parseDeclarationType(text, typeStart, 0, false);
      if (typeEnd !== undefined) {
        const argumentsStart = skipDeclarationTrivia(text, typeEnd);
        const argumentsEnd = findBalancedDeclarationDelimiterEnd(
          text,
          argumentsStart,
          '(',
          ')',
        );
        if (
          argumentsEnd !== undefined &&
          isDeclarationTriviaOnly(text, argumentsEnd)
        ) {
          const invocationDepth = getInvocationArgumentDepth(
            text.slice(0, cursor),
          );
          return invocationDepth === undefined
            ? { kind: 'anonymous' }
            : { kind: 'anonymous-call', invocationDepth };
        }
      }
    }
    cursor += 1;
  }
  return undefined;
}
function isEnumConstantBodyHeader(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (true) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd === undefined) {
      break;
    }
    cursor = skipDeclarationTrivia(text, annotationEnd);
  }
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, cursor + name[0].length);
  if (text[cursor] === '(') {
    const argumentsEnd = findBalancedDeclarationDelimiterEnd(
      text,
      cursor,
      '(',
      ')',
    );
    if (argumentsEnd === undefined) {
      return false;
    }
    cursor = argumentsEnd;
  }
  return isDeclarationTriviaOnly(text, cursor);
}
function isPackageOrImportDeclaration(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (true) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd === undefined) {
      break;
    }
    cursor = skipDeclarationTrivia(text, annotationEnd);
  }
  const keyword = /^(package|import)\b/u.exec(text.slice(cursor));
  if (keyword === null) {
    return false;
  }
  const kind = keyword[1];
  cursor = skipDeclarationTrivia(text, cursor + keyword[0].length);
  if (kind === 'import') {
    const staticKeyword = /^static\b/u.exec(text.slice(cursor));
    if (staticKeyword !== null) {
      cursor = skipDeclarationTrivia(text, cursor + staticKeyword[0].length);
    }
  }
  while (true) {
    const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
    if (identifier === null) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, cursor + identifier[0].length);
    if (text[cursor] !== '.') {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + 1);
    if (kind === 'import' && text[cursor] === '*') {
      cursor = skipDeclarationTrivia(text, cursor + 1);
      break;
    }
  }
  return text[cursor] === ';' && isDeclarationTriviaOnly(text, cursor + 1);
}
function isCompleteDeclarationTypeListAndBlock(text, enclosingContexts = []) {
  let cursor = parseDeclarationTypeList(text, 0);
  if (cursor === undefined) {
    return false;
  }
  while (true) {
    cursor = skipDeclarationTrivia(text, cursor);
    const remaining = text.slice(cursor);
    if (isCompleteDeclarationBlock(remaining, enclosingContexts)) {
      return true;
    }
    const keyword = DECLARATION_CLAUSE_KEYWORDS.find((candidate) =>
      text.startsWith(candidate, cursor),
    );
    if (keyword === undefined) {
      return false;
    }
    cursor += keyword.length;
    const typeListStart = skipDeclarationTrivia(text, cursor);
    if (typeListStart === cursor) {
      return false;
    }
    cursor = typeListStart;
    const typeListEnd = parseDeclarationTypeList(text, cursor);
    if (typeListEnd === undefined) {
      return false;
    }
    cursor = typeListEnd;
  }
}
function isCompleteMethodThrowsTail(text, enclosingContexts = []) {
  const cursor = parseDeclarationTypeList(text, 0);
  if (cursor === undefined) {
    return false;
  }
  const tailStart = skipDeclarationTrivia(text, cursor);
  const tail = text.slice(tailStart);
  const blockEnd = findBalancedDeclarationDelimiterEnd(tail, 0, '{', '}');
  return (
    (blockEnd !== undefined &&
      isDeclarationTailWithEnclosingBraces(
        tail,
        blockEnd,
        enclosingContexts,
      )) ||
    (text[tailStart] === ';' &&
      isDeclarationTailWithEnclosingBraces(
        text,
        tailStart + 1,
        enclosingContexts,
      ))
  );
}
function isQualifiedMethodThrowsPrefix(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (true) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|static|final|abstract|default|synchronized|native|strictfp)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  if (text[cursor] === '<') {
    const typeParametersEnd = skipDeclarationGenericClause(text, cursor);
    if (typeParametersEnd === undefined) {
      return false;
    }
    cursor = skipDeclarationTrivia(text, typeParametersEnd);
  }
  const returnTypeEnd = parseDeclarationType(text, cursor, 0, false, true);
  if (returnTypeEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, returnTypeEnd);
  if (cursor === returnTypeEnd) {
    return false;
  }
  const methodName = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (methodName === null) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, cursor + methodName[0].length);
  const parametersEnd = findBalancedDeclarationDelimiterEnd(
    text,
    cursor,
    '(',
    ')',
  );
  if (parametersEnd === undefined) {
    return false;
  }
  cursor = skipDeclarationTrivia(text, parametersEnd);
  const throwsClause = /^throws\b/u.exec(text.slice(cursor));
  if (throwsClause === null) {
    return false;
  }
  const typeListStart = skipDeclarationTrivia(
    text,
    cursor + throwsClause[0].length,
  );
  if (typeListStart === cursor + throwsClause[0].length) {
    return false;
  }
  return isQualifiedDeclarationTypeListPrefix(text.slice(typeListStart));
}
function normalizeSplitQualifiedTypeWhitespace(text) {
  // Normalize only for declaration-shape validation. The scanner still
  // reports only the original split whose prefix is in the supported clause.
  return text.replace(/([A-Za-z_$][A-Za-z0-9_$]*)\.\s+(?=[A-Za-z_$])/gu, '$1.');
}
function isQualifiedTypeInDeclaration(
  inner,
  delimiterIndex,
  nextWord,
  followingText,
) {
  const prefix = inner.slice(0, delimiterIndex);
  const declarationStarts = findDeclarationPrefixStarts(prefix);
  const continuation = normalizeSplitQualifiedTypeWhitespace(
    `${nextWord} ${followingText}`,
  );
  for (let index = declarationStarts.length - 1; index >= 0; index -= 1) {
    const declarationStart = declarationStarts[index];
    const declarationPrefix = prefix.slice(declarationStart?.offset ?? 0);
    const contextSnapshot = declarationStart?.contextSnapshot;
    const containingContext = contextSnapshot?.kind;
    if (
      isQualifiedMethodThrowsPrefix(declarationPrefix) &&
      (containingContext === undefined ||
        containingContext === 'type' ||
        containingContext === 'enum' ||
        containingContext === 'anonymous' ||
        containingContext === 'anonymous-call') &&
      isCompleteMethodThrowsTail(
        continuation,
        materializeDeclarationBodyContexts(contextSnapshot),
      )
    ) {
      return true;
    }
    if (
      isQualifiedClassExtendsPrefix(declarationPrefix) &&
      isCompleteDeclarationTypeListAndBlock(
        continuation,
        materializeDeclarationBodyContexts(contextSnapshot),
      )
    ) {
      return true;
    }
  }
  return false;
}
function findDeclarationPrefixStarts(text) {
  const starts = [{ offset: 0, contextSnapshot: undefined }];
  const contexts = [{ kind: 'top-level', memberStart: 0 }];
  const pushContext = (kind, memberStart, invocationDepth) => {
    const parent = contexts[contexts.length - 1];
    const snapshot = {
      kind,
      invocationDepth,
      parent: parent?.snapshot,
    };
    contexts.push({ kind, memberStart, invocationDepth, snapshot });
  };
  const getContextSnapshot = () => contexts[contexts.length - 1]?.snapshot;
  let parenthesisDepth = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, cursor);
      if (literalEnd === undefined) {
        break;
      }
      cursor = literalEnd;
      continue;
    }
    if (
      character === '/' &&
      (text[cursor + 1] === '/' || text[cursor + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, cursor);
      if (commentEnd === undefined) {
        break;
      }
      cursor = commentEnd;
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')') {
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
    } else if (character === '{') {
      const parent = contexts[contexts.length - 1];
      if (parent === undefined) {
        break;
      }
      const header = normalizeSplitQualifiedTypeWhitespace(
        text.slice(parent.memberStart, cursor),
      );
      const declarationKind =
        parent.kind === 'annotation'
          ? undefined
          : getTypeDeclarationBodyKind(header);
      if (declarationKind !== undefined) {
        pushContext(declarationKind, cursor + 1);
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
      } else if (parent.kind === 'enum' && isEnumConstantBodyHeader(header)) {
        pushContext('anonymous', cursor + 1);
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
      } else if (
        parent.kind !== 'annotation' &&
        getAnonymousClassBodyContext(header) !== undefined
      ) {
        const anonymousContext = getAnonymousClassBodyContext(header);
        if (anonymousContext === undefined) {
          cursor += 1;
          continue;
        }
        pushContext(
          anonymousContext.kind,
          cursor + 1,
          anonymousContext.invocationDepth,
        );
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
      } else {
        pushContext(parenthesisDepth > 0 ? 'annotation' : 'block', cursor + 1);
        if (parenthesisDepth === 0) {
          starts.push({
            offset: cursor + 1,
            contextSnapshot: getContextSnapshot(),
          });
        }
      }
    } else if (character === '}') {
      if (contexts.length === 1) {
        break;
      }
      const closed = contexts.pop();
      const parent = contexts[contexts.length - 1];
      if (
        parent !== undefined &&
        closed !== undefined &&
        closed.kind !== 'annotation' &&
        (parent.kind === 'type' ||
          parent.kind === 'enum' ||
          parent.kind === 'anonymous' ||
          parent.kind === 'anonymous-call' ||
          parent.kind === 'block' ||
          (parent.kind === 'top-level' &&
            (closed.kind === 'type' || closed.kind === 'enum')))
      ) {
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
        parent.memberStart = cursor + 1;
      }
    } else if (character === ';') {
      const context = contexts[contexts.length - 1];
      if (
        context?.kind === 'type' ||
        context?.kind === 'enum' ||
        context?.kind === 'anonymous' ||
        context?.kind === 'anonymous-call'
      ) {
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
        context.memberStart = cursor + 1;
      } else if (context?.kind === 'block' && parenthesisDepth === 0) {
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
        context.memberStart = cursor + 1;
      } else if (
        context?.kind === 'top-level' &&
        isPackageOrImportDeclaration(
          text.slice(context.memberStart, cursor + 1),
        )
      ) {
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
        context.memberStart = cursor + 1;
      }
    } else if (character === ',' && parenthesisDepth === 0) {
      const context = contexts[contexts.length - 1];
      if (context?.kind === 'enum') {
        starts.push({
          offset: cursor + 1,
          contextSnapshot: getContextSnapshot(),
        });
        context.memberStart = cursor + 1;
      }
    }
    cursor += 1;
  }
  return starts;
}
function normalizeSplitQualifiedTypeWhitespaceWithOffsets(text) {
  const normalized = [];
  const sourceOffsets = [];
  const splitPattern = /([A-Za-z_$][A-Za-z0-9_$]*)\.(\s+)(?=[A-Za-z_$])/gu;
  let sourceCursor = 0;
  for (const match of text.matchAll(splitPattern)) {
    const matchStart = match.index;
    const matchEnd = matchStart + match[0].length;
    const identifierAndDotLength = (match[1]?.length ?? 0) + 1;
    const copiedEnd = matchStart + identifierAndDotLength;
    for (; sourceCursor < copiedEnd; sourceCursor += 1) {
      normalized.push(text[sourceCursor] ?? '');
      sourceOffsets.push(sourceCursor);
    }
    sourceCursor = matchEnd;
  }
  for (; sourceCursor < text.length; sourceCursor += 1) {
    normalized.push(text[sourceCursor] ?? '');
    sourceOffsets.push(sourceCursor);
  }
  return { text: normalized.join(''), sourceOffsets };
}
function findQualifiedClassExtendsTypeRange(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  const declarationKind = /^(class|interface)\b/u.exec(text.slice(cursor));
  if (declarationKind === null) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, cursor + declarationKind[0].length);
  const name = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (name === null) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, cursor + name[0].length);
  if (text[cursor] === '<') {
    const genericClauseEnd = skipDeclarationGenericClause(text, cursor);
    if (genericClauseEnd === undefined) {
      return undefined;
    }
    cursor = skipDeclarationTrivia(text, genericClauseEnd);
  }
  const extendsClause = /^extends\b/u.exec(text.slice(cursor));
  if (extendsClause === null) {
    return undefined;
  }
  const start = skipDeclarationTrivia(text, cursor + extendsClause[0].length);
  const end = parseDeclarationTypeList(text, start);
  if (
    end === undefined ||
    (declarationKind[1] === 'class' &&
      hasTopLevelDeclarationTypeListComma(text.slice(start, end)))
  ) {
    return undefined;
  }
  return { start, end };
}
function findDeclarationMethodThrowsTypeRange(text) {
  let cursor = skipDeclarationTrivia(text, 0);
  while (cursor < text.length) {
    const annotationEnd = skipDeclarationAnnotation(text, cursor);
    if (annotationEnd !== undefined) {
      cursor = skipDeclarationTrivia(text, annotationEnd);
      continue;
    }
    const modifier =
      /^(?:public|protected|private|static|final|abstract|default|synchronized|native|strictfp)\b/u.exec(
        text.slice(cursor),
      );
    if (modifier === null) {
      break;
    }
    cursor = skipDeclarationTrivia(text, cursor + modifier[0].length);
  }
  if (text[cursor] === '<') {
    const typeParametersEnd = skipDeclarationGenericClause(text, cursor);
    if (typeParametersEnd === undefined) {
      return undefined;
    }
    cursor = skipDeclarationTrivia(text, typeParametersEnd);
  }
  const returnTypeEnd = parseDeclarationType(text, cursor, 0, false, true);
  if (returnTypeEnd === undefined) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, returnTypeEnd);
  if (cursor === returnTypeEnd) {
    return undefined;
  }
  const methodName = /^[A-Za-z_$][A-Za-z0-9_$]*/u.exec(text.slice(cursor));
  if (methodName === null) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, cursor + methodName[0].length);
  const parametersEnd = findBalancedDeclarationDelimiterEnd(
    text,
    cursor,
    '(',
    ')',
  );
  if (parametersEnd === undefined) {
    return undefined;
  }
  cursor = skipDeclarationTrivia(text, parametersEnd);
  const throwsClause = /^throws\b/u.exec(text.slice(cursor));
  if (throwsClause === null) {
    return undefined;
  }
  const start = skipDeclarationTrivia(text, cursor + throwsClause[0].length);
  const end = parseDeclarationTypeList(text, start);
  return end === undefined ? undefined : { start, end };
}
function collectDeclarationTypeSplitOffsets(
  text,
  start,
  end,
  qualifiedOffsets,
  ignoredOffsets,
) {
  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character === '"' || character === "'") {
      const literalEnd = skipDeclarationQuotedLiteralEnd(text, index);
      if (literalEnd === undefined || literalEnd > end) {
        return;
      }
      for (
        let literalIndex = index + 1;
        literalIndex < literalEnd - 1;
        literalIndex += 1
      ) {
        if (
          text[literalIndex] === '.' &&
          /\s/u.test(text[literalIndex + 1] ?? '')
        ) {
          ignoredOffsets.add(literalIndex);
        }
      }
      index = literalEnd - 1;
      continue;
    }
    if (
      character === '/' &&
      (text[index + 1] === '/' || text[index + 1] === '*')
    ) {
      const commentEnd = skipDeclarationCommentEnd(text, index);
      if (commentEnd === undefined || commentEnd > end) {
        return;
      }
      for (
        let commentIndex = index;
        commentIndex < commentEnd;
        commentIndex += 1
      ) {
        if (
          text[commentIndex] === '.' &&
          /\s/u.test(text[commentIndex + 1] ?? '')
        ) {
          ignoredOffsets.add(commentIndex);
        }
      }
      index = commentEnd - 1;
      continue;
    }
    if (character !== '.' || !/\s/u.test(text[index + 1] ?? '')) {
      continue;
    }
    let nextIndex = index + 1;
    while (/\s/u.test(text[nextIndex] ?? '')) {
      nextIndex += 1;
    }
    const next = text[nextIndex];
    if (
      next !== undefined &&
      (isDeclarationIdentifierStart(text.charCodeAt(nextIndex)) || next === '@')
    ) {
      qualifiedOffsets.add(index);
    }
  }
}
function findQualifiedDeclarationTypeSplitOffsets(text) {
  const offsets = {
    qualified: new Set(),
    ignored: new Set(),
  };
  for (const start of findDeclarationPrefixStarts(text)) {
    const boundary = findTypeBodyMemberDelimiter(text, start.offset);
    if (boundary?.delimiter !== '{' && boundary?.delimiter !== ';') {
      continue;
    }
    const header = text.slice(start.offset, boundary.index);
    const normalized = normalizeSplitQualifiedTypeWhitespaceWithOffsets(header);
    const typeKind = getTypeDeclarationBodyKind(normalized.text);
    if (typeKind === 'type') {
      const typeRange = findQualifiedClassExtendsTypeRange(normalized.text);
      if (
        typeRange !== undefined &&
        isQualifiedClassExtendsPrefix(normalized.text.slice(0, typeRange.end))
      ) {
        const sourceStart = normalized.sourceOffsets[typeRange.start];
        const sourceEnd = normalized.sourceOffsets[typeRange.end - 1];
        if (
          sourceStart !== undefined &&
          sourceEnd !== undefined &&
          isCompleteDeclarationTypeListAndBlock(
            text.slice(start.offset + sourceStart),
            materializeDeclarationBodyContexts(start.contextSnapshot),
          )
        ) {
          collectDeclarationTypeSplitOffsets(
            text,
            start.offset + sourceStart,
            start.offset + sourceEnd + 1,
            offsets.qualified,
            offsets.ignored,
          );
        }
      }
    }
    const containingContext = start.contextSnapshot?.kind;
    if (
      !isDeclarationMethodHeader(normalized.text) ||
      (containingContext !== undefined &&
        containingContext !== 'type' &&
        containingContext !== 'enum' &&
        containingContext !== 'anonymous' &&
        containingContext !== 'anonymous-call')
    ) {
      continue;
    }
    const typeRange = findDeclarationMethodThrowsTypeRange(normalized.text);
    if (
      typeRange === undefined ||
      !isQualifiedMethodThrowsPrefix(normalized.text.slice(0, typeRange.end))
    ) {
      continue;
    }
    const sourceStart = normalized.sourceOffsets[typeRange.start];
    const sourceEnd = normalized.sourceOffsets[typeRange.end - 1];
    if (
      sourceStart !== undefined &&
      sourceEnd !== undefined &&
      isCompleteMethodThrowsTail(
        text.slice(start.offset + sourceStart),
        materializeDeclarationBodyContexts(start.contextSnapshot),
      )
    ) {
      collectDeclarationTypeSplitOffsets(
        text,
        start.offset + sourceStart,
        start.offset + sourceEnd + 1,
        offsets.qualified,
        offsets.ignored,
      );
    }
  }
  return offsets;
}
function isQualifiedDollarTypeContinuation(inner, delimiterIndex, afterIndex) {
  if (inner[delimiterIndex] !== '.' || inner[afterIndex] !== '$') {
    return false;
  }
  const nextWord = /^\$[A-Za-z_$][A-Za-z0-9_$-]*/u.exec(
    inner.slice(afterIndex),
  )?.[0];
  if (nextWord === undefined) {
    return false;
  }
  const followingText = inner.slice(afterIndex + nextWord.length).trimStart();
  return isQualifiedTypeInDeclaration(
    inner,
    delimiterIndex,
    nextWord,
    followingText,
  );
}
function lineStartsFor(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      starts.push(index + 1);
    }
  }
  return starts;
}
function lineNumberAt(offset, lineStarts) {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low + 1;
}
function isStandaloneDoubleDash(inner, secondDashIndex) {
  if (inner[secondDashIndex - 1] !== '-') {
    return false;
  }
  const firstDashIndex = secondDashIndex - 1;
  return firstDashIndex === 0 || /\s/.test(inner[firstDashIndex - 1]);
}
function isLineCommentOpener(inner, secondSlashIndex) {
  // A C-like line comment can start directly after code, as in
  // `value;// note`; requiring whitespace before the opener misses it.
  const firstSlashIndex = secondSlashIndex - 1;
  if (inner[firstSlashIndex] !== '/') {
    return false;
  }
  // A valid URI scheme's `://` is part of the token, not a line comment.
  const colonIndex = firstSlashIndex - 1;
  if (inner[colonIndex] !== ':') {
    return true;
  }
  let schemeStart = colonIndex - 1;
  while (schemeStart >= 0 && /[A-Za-z0-9+.-]/.test(inner[schemeStart] ?? '')) {
    schemeStart -= 1;
  }
  const scheme = inner.slice(schemeStart + 1, colonIndex);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme)) {
    return true;
  }
  const beforeScheme = inner.slice(0, schemeStart + 1);
  return scheme === 'default' || /(?:^|\s)case\s+$/u.test(beforeScheme);
}
function isSentencePunctuation(inner, delimiterIndex, afterIndex) {
  const previous = inner[delimiterIndex - 1];
  const suffix = inner.slice(afterIndex).replace(/_+$/u, '').trimEnd();
  const abbreviationBeforeLowercaseProse =
    /(?:^|(?<![\p{L}\p{N}_./-]))(?:e\.g|i\.e|etc|vs)\.$/iu.test(
      inner.slice(0, delimiterIndex + 1),
    ) && /^[a-z]/u.test(suffix);
  if (abbreviationBeforeLowercaseProse) {
    return true;
  }
  const nextWord =
    /^[A-Z][A-Za-z]*(?:[-'’][A-Za-z]+)*(?=[,.!?;:]?(?:\s|`|$))/u.exec(
      suffix,
    )?.[0];
  const prefix = inner.slice(0, delimiterIndex + 1);
  if (nextWord !== undefined && PROPER_NAME_TITLE_ABBREVIATION.test(prefix)) {
    return true;
  }
  const followingText =
    nextWord === undefined ? '' : suffix.slice(nextWord.length).trimStart();
  const followingProseWord =
    /^[A-Za-z]/u.test(followingText) ||
    /^[,.!?;:](?:\s|`|$)/u.test(followingText);
  const declarationTypeContinuation =
    nextWord !== undefined &&
    /[a-z][A-Z]/u.test(nextWord) &&
    isCompleteDeclarationTail(followingText);
  const qualifiedTypeDeclarationContinuation =
    nextWord !== undefined &&
    isQualifiedTypeInDeclaration(
      inner,
      delimiterIndex,
      nextWord,
      followingText,
    );
  // Only a complete, recognized declaration tail stays code-shaped.
  // Trailing punctuation or prose keeps sentence punctuation detectable.
  // A dotted prefix counts as declaration context only at span start;
  // later domain-like text may be prose before a new sentence.
  if (qualifiedTypeDeclarationContinuation) {
    return false;
  }
  if (
    nextWord !== undefined &&
    (!followingProseWord || declarationTypeContinuation) &&
    DOTTED_IDENTIFIER_PREFIX.test(inner.slice(0, delimiterIndex))
  ) {
    return false;
  }
  if (previous !== undefined && /[0-9]/.test(previous)) {
    // A standalone numbered step may start with lowercase prose, while a
    // digit-suffixed identifier still needs evidence after its capitalized
    // continuation before this period is treated as sentence punctuation.
    const stepWord =
      /^[A-Za-z]+(?:[-'’][A-Za-z]+)*(?=[,.!?;:]?(?:\s|`|$))/u.exec(suffix)?.[0];
    if (stepWord === undefined) {
      return false;
    }
    let numberStart = delimiterIndex - 1;
    while (numberStart > 0 && /[0-9]/.test(inner[numberStart - 1] ?? '')) {
      numberStart -= 1;
    }
    const beforeNumber = inner[numberStart - 1];
    return (
      beforeNumber === undefined ||
      /\s/.test(beforeNumber) ||
      (/[A-Za-z]/.test(beforeNumber) &&
        nextWord !== undefined &&
        followingProseWord)
    );
  }
  if (nextWord === undefined) {
    return false;
  }
  if (/^[A-Z]{2,}$/u.test(nextWord) && !followingProseWord) {
    return false;
  }
  if (previous === undefined || previous === '`') {
    return true;
  }
  const previousWord = /[A-Za-z][A-Za-z0-9_-]*$/u.exec(
    inner.slice(0, delimiterIndex),
  )?.[0];
  // A title-cased or uppercase prefix followed by a single capitalized token
  // is more likely a dotted identifier than prose. A further word or
  // sentence punctuation after the opener marks prose, while lowercase
  // prefixes can precede any capitalized opener (including `foo. Hello`).
  if (
    previousWord !== undefined &&
    /[A-Z]/u.test(previousWord) &&
    !followingProseWord
  ) {
    return false;
  }
  return /[A-Za-z)]/.test(previous);
}
function isHtmlCommentOpener(inner, secondDashIndex) {
  return inner.slice(secondDashIndex - 3, secondDashIndex + 1) === '<!--';
}
function isPartOfEllipsis(inner, dotIndex) {
  let start = dotIndex;
  let end = dotIndex + 1;
  while (inner[start - 1] === '.') {
    start -= 1;
  }
  while (inner[end] === '.') {
    end += 1;
  }
  return end - start >= 3;
}
function hasLiteralSplitCandidate(text) {
  for (let index = 0; index + 1 < text.length; index += 1) {
    const delimiter = text[index];
    const whitespace = text[index + 1];
    if (
      (delimiter === '-' ||
        delimiter === '_' ||
        delimiter === '/' ||
        delimiter === '.') &&
      (whitespace === ' ' || whitespace === '\t')
    ) {
      return true;
    }
  }
  return false;
}
function unwrapFullSpanOuterPair(text) {
  const opener = text[0];
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : undefined;
  if (closer === undefined || text[text.length - 1] !== closer) {
    return undefined;
  }
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === opener) {
      depth += 1;
    } else if (text[index] === closer) {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) {
        return undefined;
      }
      if (depth < 0) {
        return undefined;
      }
    }
  }
  return depth === 0 ? text.slice(1, -1) : undefined;
}
/**
 * Find inline code spans where a line break or literal horizontal
 * whitespace splits a token per the rules above. Returns one violation
 * per corrupting split, in document order.
 */
export function findCorruptingCodeSpanWraps(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  // Mask block code and raw HTML first. Only parse inline ranges when the
  // input contains a comment opener or a possible literal split, preserving
  // the linear path for long backtick runs and ordinary spans.
  const fencedRanges = findFencedCodeRanges(normalized);
  const htmlBlockRanges = findHtmlBlockRanges(normalized, fencedRanges);
  const blockScanned = maskMarkdownCodeRegionsPreservingPositions(
    normalized,
    mergeMarkdownCodeRanges([
      ...fencedRanges,
      ...findIndentedCodeRanges(normalized, fencedRanges),
      ...htmlBlockRanges,
    ]),
  );
  // HTML comments render as opaque text. Only ranges containing a literal
  // opener need to be passed so a genuine opener inside a code span stays text.
  let scanned = blockScanned;
  if (blockScanned.includes('<!--')) {
    const codeRangesWithCommentOpeners = findInlineCodeRanges(
      blockScanned,
      0,
      blockScanned.length,
    ).filter(({ start, end }) =>
      blockScanned.slice(start, end).includes('<!--'),
    );
    const htmlCommentRanges = findHtmlCommentRanges(
      blockScanned,
      codeRangesWithCommentOpeners,
      fencedRanges,
      htmlBlockRanges,
    );
    if (htmlCommentRanges.length > 0) {
      scanned = maskMarkdownCodeRegionsPreservingPositions(
        blockScanned,
        mergeMarkdownCodeRanges(htmlCommentRanges),
      );
    }
  }
  const lineStarts = lineStartsFor(scanned);
  const violations = [];
  for (const span of findInlineCodeSpans(scanned)) {
    const { inner } = span;
    const innerStart = span.index + span.ticks.length;
    const declarationLineBreakOffsets = /\.\n[ \t]*(?:\$|@)/u.test(inner)
      ? findQualifiedDeclarationTypeSplitOffsets(inner).qualified
      : undefined;
    let cursor = 0;
    for (;;) {
      const breakIndex = inner.indexOf('\n', cursor);
      if (breakIndex === -1) {
        break;
      }
      const prevChar = inner[breakIndex - 1];
      const prevPrevChar = inner[breakIndex - 2];
      let afterIndex = breakIndex + 1;
      while (inner[afterIndex] === ' ' || inner[afterIndex] === '\t') {
        afterIndex += 1;
      }
      const nextChar = inner[afterIndex];
      if (
        (prevChar !== undefined &&
          MID_TOKEN_CONTINUATION.test(prevChar) &&
          (prevPrevChar === undefined || TOKEN_CONTINUING.test(prevPrevChar)) &&
          nextChar !== undefined &&
          TOKEN_CONTINUING.test(nextChar)) ||
        (prevChar === '.' &&
          (nextChar === '$' || nextChar === '@') &&
          declarationLineBreakOffsets?.has(breakIndex - 1) === true)
      ) {
        violations.push({
          offset: innerStart + breakIndex,
          violation: {
            line: lineNumberAt(innerStart + breakIndex, lineStarts),
            before: inner.slice(
              Math.max(0, breakIndex - CONTEXT_CHARS),
              breakIndex,
            ),
            after: inner.slice(afterIndex, afterIndex + CONTEXT_CHARS),
          },
        });
      }
      cursor = breakIndex + 1;
    }
  }
  // The literal-whitespace extension follows CommonMark delimiter and
  // escape rules. Keep the existing line-break scanner's established
  // matching behavior above.
  const literalCodeRanges = hasLiteralSplitCandidate(scanned)
    ? findInlineCodeRanges(scanned, 0, scanned.length)
    : [];
  for (const range of literalCodeRanges) {
    let tickCount = 0;
    while (scanned[range.start + tickCount] === '`') {
      tickCount += 1;
    }
    const innerStart = range.start + tickCount;
    const inner = scanned.slice(innerStart, range.end - tickCount);
    const wrappedContent = unwrapFullSpanOuterPair(inner);
    const sentenceInner = wrappedContent ?? inner;
    const sentenceIndexOffset = wrappedContent === undefined ? 0 : 1;
    const declarationTypeSplitOffsets =
      findQualifiedDeclarationTypeSplitOffsets(inner);
    for (
      let delimiterIndex = 0;
      delimiterIndex < inner.length;
      delimiterIndex += 1
    ) {
      const delimiter = inner[delimiterIndex];
      const firstWhitespace = inner[delimiterIndex + 1];
      if (declarationTypeSplitOffsets.ignored.has(delimiterIndex)) {
        continue;
      }
      if (
        delimiter === undefined ||
        !MID_TOKEN_CONTINUATION.test(delimiter) ||
        (firstWhitespace !== ' ' && firstWhitespace !== '\t')
      ) {
        continue;
      }
      const previous = inner[delimiterIndex - 1];
      if (
        (previous === undefined && delimiter === '-') ||
        (previous !== undefined &&
          !TOKEN_CONTINUING.test(previous) &&
          !(delimiter === '.' && previous === '>'))
      ) {
        continue;
      }
      let afterIndex = delimiterIndex + 1;
      while (/\s/.test(inner[afterIndex] ?? '')) {
        afterIndex += 1;
      }
      const next = inner[afterIndex];
      if (
        next === undefined ||
        (!TOKEN_CONTINUING.test(next) &&
          !isQualifiedDollarTypeContinuation(
            inner,
            delimiterIndex,
            afterIndex,
          ) &&
          !declarationTypeSplitOffsets.qualified.has(delimiterIndex))
      ) {
        continue;
      }
      if (
        (delimiter === '.' &&
          !declarationTypeSplitOffsets.qualified.has(delimiterIndex) &&
          isSentencePunctuation(
            sentenceInner,
            delimiterIndex - sentenceIndexOffset,
            afterIndex - sentenceIndexOffset,
          )) ||
        (delimiter === '-' &&
          (isStandaloneDoubleDash(inner, delimiterIndex) ||
            isHtmlCommentOpener(inner, delimiterIndex))) ||
        (delimiter === '/' && isLineCommentOpener(inner, delimiterIndex)) ||
        (delimiter === '.' && isPartOfEllipsis(inner, delimiterIndex))
      ) {
        continue;
      }
      violations.push({
        offset: innerStart + delimiterIndex + 1,
        violation: {
          line: lineNumberAt(innerStart + delimiterIndex + 1, lineStarts),
          before: inner.slice(
            Math.max(0, delimiterIndex + 1 - CONTEXT_CHARS),
            delimiterIndex + 1,
          ),
          after: inner.slice(afterIndex, afterIndex + CONTEXT_CHARS),
          separator: firstWhitespace === ' ' ? 'literal-space' : 'literal-tab',
        },
      });
    }
  }
  violations.sort((left, right) => left.offset - right.offset);
  return violations.map(({ violation }) => violation);
}
// idd-skill issue #2876: the corrupting-line-wrap failure mode above is not
// unique to backtick-delimited code spans -- the same "CommonMark renders
// the break as a single space, silently corrupting a hyphenated compound
// word" problem occurs when a manual hard-wrap splits a compound right
// after the hyphen inside `**bold**` / `*italic*` emphasis text (observed
// live in this repository, 2026-09-10, PR #2875 closing issue #2806:
// "**infrastructure/transport-layer failure**" hard-wrapped as
// "transport-\n  layer", which `dprint fmt`, `markdownlint-cli2`, and this
// script's own code-span check all missed -- only a Copilot review caught
// it). Scoped to the hyphen case only (not underscore/slash/dot, which stay
// code-span-only): underscore is itself an emphasis delimiter, and
// slash/dot mid-token splits are a code/path concern this prose check does
// not attempt to generalize to.
//
// EMPHASIS_SPAN_PATTERN mirrors the former inline-code-span pattern's
// technique -- a backreference-counted delimiter run (`\1`) whose inner
// content may cross any number of line breaks, same as an inline code
// span, as long as none of them is a blank line -- with two extra guards
// approximating CommonMark's emphasis flanking rules well enough to avoid
// misreading a `*`/`-`/`+` bullet-list marker as an emphasis opener: the
// opening run must not be immediately followed by whitespace (a bullet
// marker always is, e.g. `* item`), and the closing run must be
// immediately preceded by non-whitespace (rules out closing on a stray
// later `*`/`**` separated from the emphasized text by a space). This is a
// heuristic, not a full CommonMark emphasis parser -- deliberately, to keep
// this dogfood-only check simple and low-risk; see
// findCorruptingProseWraps's own corpus-validated scope below.
//
// Known limitations (PR #2880 review, Codex), accepted as residual scope
// rather than fixed here -- each is a missed detection (false negative),
// never a false positive that could wrongly block a clean PR, and a human/
// Copilot review remains the backstop that caught this issue's own
// incident in the first place:
// - An escaped delimiter (`\*`) immediately before a wrapped compound,
//   INSIDE an already-open span, is read as a real closing marker, ending
//   the match early and missing the wrap after it (e.g.
//   `*note \*literal well-\nknown*`). The negative lookbehind below only
//   stops a leading escaped delimiter from wrongly OPENING a span in the
//   first place (the opposite-direction, false-positive-causing case) --
//   it does not give `(?!\1)` the same escape awareness for a closer
//   found mid-span.
// - A blockquote `>` container prefix on a wrapped continuation line is
//   not stripped before the neighbor check, so a wrap inside a
//   blockquoted emphasis span (e.g. `> **well-\n> known**`) is missed.
// - The neighbor test below is ASCII-only ({@link TOKEN_CONTINUING} is
//   shared with {@link findCorruptingCodeSpanWraps}, which this issue does
//   not change), so a non-ASCII letter adjacent to the hyphen (e.g.
//   `**café-\nstyle**`) is not recognized as continuing the compound.
//
// The leading `(?<!\\)` (PR #2880 review, Codex) stops an escaped
// delimiter (e.g. `\*well-\nknown*`) from opening a span at all: CommonMark
// never treats an escaped `*` as a real emphasis delimiter, so the
// asterisks and the text after them are literal, not emphasis, and must
// not be scanned as if they were (a false positive that could reject a
// literal-example PR). Single-backslash heuristic, matching this
// repository's existing style for the same "good enough" escape check
// (e.g. resolved-decision.mts's isEscapedBacktick) -- does not attempt
// full backslash-run parity for a doubly-escaped `\\*`.
const EMPHASIS_SPAN_PATTERN =
  /(?<!\\)(\*{1,2})(?!\s)((?:(?!\1)[^\r\n]|\r?\n(?![ \t]*\r?\n))+?)(?<=\S)\1/g;
// idd-skill issue #2876 (PR #2880 review, Codex): an HTML comment can
// legitimately quote example Markdown -- including a multi-line
// `**bold**` hyphen wrap used to illustrate this very rule -- that
// CommonMark never renders as real emphasis at all. findMarkdownCodeRanges/
// stripMarkdownCodeRegions deliberately do NOT mask HTML comments (some
// operational markers are HTML comments), so mask them here, scoped to
// this prose scan only, and BEFORE code-region detection runs (a second
// review round, Codex): otherwise a stray backtick inside a comment can
// pair with a later real backtick outside it into one bogus code span
// that blanks real intervening prose. Blank each `<!-- ... -->` region's
// content (preserving line/column structure, same style as
// blankFencedCodeBlocks), using a Private Use Area filler character
// rather than a literal space: a same-line, mid-line comment (e.g.
// `<!-- note --> **word-\nwrap**`) blanked to plain spaces left several
// leading space columns before the real `**word-` content that follows
// on the same line -- enough to misread that remainder as a 4+-space
// indented code block once findMarkdownCodeRanges below started
// covering indented code too, silently masking the real prose it was
// supposed to scan (round-3 regression caught by this file's own
// regression tests, not a live review finding). The filler character is
// never whitespace (so it cannot manufacture indentation), never
// alphanumeric or one of `-_/.` (so it can never satisfy
// {@link TOKEN_CONTINUING}), and never a Markdown structural character
// (` ` ` ~ * _ = # > + digit), so it is inert to every check in
// markdown-code.mts and to this file's own matching alike. Regex-based
// closing (not the `indexOf`-based scan resolved-decision.mts's
// findHtmlCommentRanges uses for the same "mask an HTML comment" need)
// -- not a full HTML parser either way.
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?(?:-->|$)/g;
const HTML_COMMENT_MASK_CHAR = '\uE000';
function blankHtmlComments(text) {
  return text.replace(HTML_COMMENT_PATTERN, (match) =>
    match.replace(/[^\r\n]/g, HTML_COMMENT_MASK_CHAR),
  );
}
// idd-skill issue #2876 (PR #2880 review, CodeRabbit): a standalone
// thematic-break line of 3+ `*` characters (optionally interior-spaced,
// e.g. `***` or `* * *`) is never emphasis -- CommonMark resolves it as
// its own block, never as an opening or closing delimiter run -- but
// EMPHASIS_SPAN_PATTERN's plain `\*{1,2}` match does not know that, so
// prose genuinely between two such lines (e.g. `***\nwell-\nknown\n***`)
// could otherwise be misread as one emphasis span. Blank the asterisks on
// a matching line (mirrors this repo's own unexported
// MARKDOWN_THEMATIC_BREAK_PATTERN test in markdown-code.mts, narrowed to
// the `*` marker this scan cares about) before matching emphasis.
const ASTERISK_THEMATIC_BREAK_LINE_PATTERN = /^ {0,3}\*(?:[ \t]*\*){2,}[ \t]*$/;
function blankAsteriskThematicBreaks(text) {
  return text
    .split('\n')
    .map((line) =>
      ASTERISK_THEMATIC_BREAK_LINE_PATTERN.test(line)
        ? line.replace(/\S/g, ' ')
        : line,
    )
    .join('\n');
}
/**
 * Find `**`/`*` emphasis spans in prose Markdown text (outside fenced,
 * indented, and inline code, raw HTML blocks, HTML comments, and
 * asterisk thematic-break lines) whose line break falls immediately
 * after a hyphen joining a token on each side (reusing the same
 * {@link TOKEN_CONTINUING} neighbor test as
 * {@link findCorruptingCodeSpanWraps}) -- the prose counterpart of that
 * function. A hyphen at the very start of an emphasis span's content
 * does not qualify: with nothing before it, there is no left-side token
 * to join, so it is not a corrupted compound word (PR #2880 review,
 * Copilot). Returns one violation per corrupting break, in document
 * order.
 */
export function findCorruptingProseWraps(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  // Order matters: blank HTML comments first (see the comment above
  // HTML_COMMENT_PATTERN for why), then mask every code region --
  // fenced, indented, and inline (findMarkdownCodeRanges /
  // maskMarkdownCodeRegionsPreservingPositions cover all three, unlike
  // stripMarkdownCodeRegions's fenced-plus-inline-only scope; #2880
  // review, Codex) plus raw HTML blocks (e.g. `<pre>...</pre>`, whose
  // contents CommonMark renders literally, never as emphasis; same
  // review round) -- so code/HTML-block content already covered
  // elsewhere is never double-flagged here and this scan never mistakes
  // such a region's own emphasis-looking characters for real prose
  // emphasis. All three preserve line/column structure. Then blank
  // asterisk thematic-break lines, which are never real emphasis.
  const withoutComments = blankHtmlComments(normalized);
  const fencedRanges = findFencedCodeRanges(withoutComments);
  const codeAndHtmlBlockRanges = [
    ...findMarkdownCodeRanges(withoutComments),
    ...findHtmlBlockRanges(withoutComments, fencedRanges),
  ];
  const withoutCode = maskMarkdownCodeRegionsPreservingPositions(
    withoutComments,
    codeAndHtmlBlockRanges,
  );
  const scanned = blankAsteriskThematicBreaks(withoutCode);
  const violations = [];
  for (const match of scanned.matchAll(EMPHASIS_SPAN_PATTERN)) {
    const marker = match[1];
    const inner = match[2];
    const matchStart = match.index ?? 0;
    const innerStart = matchStart + marker.length;
    let cursor = 0;
    for (;;) {
      const breakIndex = inner.indexOf('\n', cursor);
      if (breakIndex === -1) {
        break;
      }
      const prevChar = inner[breakIndex - 1];
      const prevPrevChar = inner[breakIndex - 2];
      let afterIndex = breakIndex + 1;
      while (inner[afterIndex] === ' ' || inner[afterIndex] === '\t') {
        afterIndex += 1;
      }
      const nextChar = inner[afterIndex];
      if (
        prevChar === '-' &&
        prevPrevChar !== undefined &&
        TOKEN_CONTINUING.test(prevPrevChar) &&
        nextChar !== undefined &&
        TOKEN_CONTINUING.test(nextChar)
      ) {
        const breakOffset = innerStart + breakIndex;
        const line = scanned.slice(0, breakOffset).split('\n').length;
        violations.push({
          line,
          before: inner.slice(
            Math.max(0, breakIndex - CONTEXT_CHARS),
            breakIndex,
          ),
          after: inner.slice(afterIndex, afterIndex + CONTEXT_CHARS),
        });
      }
      cursor = breakIndex + 1;
    }
  }
  return violations;
}
