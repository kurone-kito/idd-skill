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
const DECLARATION_CLAUSE_KEYWORDS = ['extends', 'implements', 'permits'];
function skipDeclarationWhitespace(text, start) {
  let cursor = start;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? '')) {
    cursor += 1;
  }
  return cursor;
}
function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isDeclarationIdentifierContinuation(code) {
  return (
    isAsciiLetter(code) ||
    (code >= 48 && code <= 57) ||
    code === 45 ||
    code === 95
  );
}
function parseDeclarationType(text, start, genericDepth) {
  let cursor = start;
  let finalSegmentStartsUppercase = false;
  while (true) {
    const firstCode = text.charCodeAt(cursor);
    if (!isAsciiLetter(firstCode)) {
      return undefined;
    }
    finalSegmentStartsUppercase = firstCode >= 65 && firstCode <= 90;
    cursor += 1;
    while (isDeclarationIdentifierContinuation(text.charCodeAt(cursor))) {
      cursor += 1;
    }
    if (text[cursor] !== '.') {
      break;
    }
    cursor += 1;
  }
  if (!finalSegmentStartsUppercase) {
    return undefined;
  }
  if (text[cursor] !== '<') {
    return cursor;
  }
  if (genericDepth >= MAX_DECLARATION_GENERIC_DEPTH) {
    return undefined;
  }
  cursor = skipDeclarationWhitespace(text, cursor + 1);
  let argumentEnd = parseDeclarationTypeArgument(
    text,
    cursor,
    genericDepth + 1,
  );
  if (argumentEnd === undefined) {
    return undefined;
  }
  cursor = argumentEnd;
  while (true) {
    const commaIndex = skipDeclarationWhitespace(text, cursor);
    if (text[commaIndex] !== ',') {
      break;
    }
    cursor = skipDeclarationWhitespace(text, commaIndex + 1);
    argumentEnd = parseDeclarationTypeArgument(text, cursor, genericDepth + 1);
    if (argumentEnd === undefined) {
      return undefined;
    }
    cursor = argumentEnd;
  }
  cursor = skipDeclarationWhitespace(text, cursor);
  return text[cursor] === '>' ? cursor + 1 : undefined;
}
function parseDeclarationTypeArgument(text, start, genericDepth) {
  if (text[start] !== '?') {
    return parseDeclarationType(text, start, genericDepth);
  }
  // Wildcards are limited to nested type arguments (JLS 8.1.4 and 8.1.5;
  // PR #4605).
  if (genericDepth === 1) {
    return undefined;
  }
  const cursor = skipDeclarationWhitespace(text, start + 1);
  const varianceKeyword = ['extends', 'super'].find(
    (keyword) =>
      text.startsWith(keyword, cursor) &&
      !isDeclarationIdentifierContinuation(
        text.charCodeAt(cursor + keyword.length),
      ),
  );
  if (varianceKeyword === undefined) {
    return start + 1;
  }
  const boundStart = skipDeclarationWhitespace(
    text,
    cursor + varianceKeyword.length,
  );
  return parseDeclarationType(text, boundStart, genericDepth);
}
function isCompleteDeclarationTail(text) {
  let cursor = skipDeclarationWhitespace(text, 0);
  while (cursor < text.length) {
    const keyword = DECLARATION_CLAUSE_KEYWORDS.find((candidate) =>
      text.startsWith(candidate, cursor),
    );
    if (keyword === undefined) {
      return false;
    }
    cursor += keyword.length;
    if (cursor >= text.length || !/\s/u.test(text[cursor] ?? '')) {
      return false;
    }
    cursor = skipDeclarationWhitespace(text, cursor);
    let typeEnd = parseDeclarationType(text, cursor, 0);
    if (typeEnd === undefined) {
      return false;
    }
    cursor = typeEnd;
    while (true) {
      const commaIndex = skipDeclarationWhitespace(text, cursor);
      if (text[commaIndex] !== ',') {
        break;
      }
      cursor = skipDeclarationWhitespace(text, commaIndex + 1);
      typeEnd = parseDeclarationType(text, cursor, 0);
      if (typeEnd === undefined) {
        return false;
      }
      cursor = typeEnd;
    }
    const nextClause = skipDeclarationWhitespace(text, cursor);
    if (nextClause === text.length) {
      return true;
    }
    if (nextClause === cursor) {
      return false;
    }
    cursor = nextClause;
  }
  return false;
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
  // Only a complete, recognized declaration tail stays code-shaped.
  // Trailing punctuation or prose keeps sentence punctuation detectable.
  // A dotted prefix counts as declaration context only at span start;
  // later domain-like text may be prose before a new sentence.
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
        prevChar !== undefined &&
        MID_TOKEN_CONTINUATION.test(prevChar) &&
        (prevPrevChar === undefined || TOKEN_CONTINUING.test(prevPrevChar)) &&
        nextChar !== undefined &&
        TOKEN_CONTINUING.test(nextChar)
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
    for (
      let delimiterIndex = 0;
      delimiterIndex < inner.length;
      delimiterIndex += 1
    ) {
      const delimiter = inner[delimiterIndex];
      const firstWhitespace = inner[delimiterIndex + 1];
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
        (previous !== undefined && !TOKEN_CONTINUING.test(previous))
      ) {
        continue;
      }
      let afterIndex = delimiterIndex + 1;
      while (/\s/.test(inner[afterIndex] ?? '')) {
        afterIndex += 1;
      }
      const next = inner[afterIndex];
      if (next === undefined || !TOKEN_CONTINUING.test(next)) {
        continue;
      }
      if (
        (delimiter === '.' &&
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
