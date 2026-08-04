// idd-generated-from: src/scripts/markdown-code.mts
//
// The scripts/markdown-code.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
/**
 * Strip Markdown code regions (fenced blocks and inline code spans) from a body
 * before scanning it for machine-readable markers or dependency references. A
 * genuine marker is raw text GitHub renders as intended (an HTML comment it
 * hides, or a `Blocked by #N` line it links), never inside a code span or
 * fence, so an example an issue merely *quotes* in code (e.g. an issue about
 * the marker or dependency syntax) must not be read as real. HTML comments are
 * deliberately NOT stripped here — only code regions are, since some markers
 * are themselves HTML comments. Masked regions keep their line count and
 * surrounding text so a real marker elsewhere in the body still matches.
 */
/**
 * Blank fenced code block lines (``` or ~~~), tracking the fence char +
 * length so a longer opening fence is not closed by a shorter inner fence
 * (CommonMark §4.5). Preserves line count so line-number math on the
 * returned text stays valid. Shared by {@link stripMarkdownCodeRegions} and
 * the inline-code-span wrap scan in `code-span-wrap.mts`.
 */
export function blankFencedCodeBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let fence = null;
  for (const line of lines) {
    // CommonMark §4.5: a fence marker may be indented by at most three spaces;
    // a marker with four or more leading spaces is an indented code line, not a
    // fence, so accepting arbitrary leading whitespace here would wrongly enter
    // fence mode on `    ~~~` and blank the real content that follows it.
    const openMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (openMatch) {
      const marker = openMatch[1];
      const info = openMatch[2];
      const fenceChar = marker[0];
      if (fence === null) {
        // CommonMark §4.5: a backtick-fence opener's info string may not
        // contain a backtick (that would be ambiguous with a close or inline
        // code), so such a line is not a fence opener and stays content.
        if (fenceChar !== '`' || !info.includes('`')) {
          fence = { char: fenceChar, length: marker.length };
          out.push('');
          continue;
        }
      } else if (
        fenceChar === fence.char &&
        marker.length >= fence.length &&
        /^\s*$/.test(info)
      ) {
        fence = null;
        out.push('');
        continue;
      }
    }
    out.push(fence === null ? line : '');
  }
  return out.join('\n');
}
/**
 * Inline code span pattern (`...`, ``...``): the inner match allows a
 * single newline (CommonMark renders it as a space) but stops at a blank
 * line, which ends the paragraph: a code span cannot cross it. Allowing a
 * blank line would let a stray unclosed backtick mask a real dependency
 * line in a later paragraph — a fail-open miss. Shared by
 * {@link stripMarkdownCodeRegions} and the inline-code-span wrap scan in
 * `code-span-wrap.mts`, so both stay in sync on what counts as a span.
 */
export const INLINE_CODE_SPAN_PATTERN =
  /(`+)((?:(?!\1)[^\r\n]|\r?\n(?![ \t]*\r?\n))+?)\1/g;
export function stripMarkdownCodeRegions(text) {
  // Inline code spans: mask the inner content so a quoted marker no longer
  // matches, keeping the backticks and surrounding text.
  return blankFencedCodeBlocks(text).replace(
    INLINE_CODE_SPAN_PATTERN,
    (_match, ticks, inner) =>
      `${ticks}${inner.replace(/[^\r\n]/g, ' ')}${ticks}`,
  );
}
function isEscapedBacktick(text, index) {
  let backslashCount = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && text[cursor] === '\\';
    cursor -= 1
  ) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 1;
}
function hasBlankLine(text, start, end) {
  return /\r?\n[ \t]*\r?\n/u.test(text.slice(start, end));
}
function countBackticks(text, start, end) {
  let cursor = start;
  while (cursor < end && text[cursor] === '`') {
    cursor += 1;
  }
  return cursor - start;
}
function findFencedCodeRanges(text) {
  const ranges = [];
  let fence = null;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd =
      newlineIndex === -1
        ? text.length
        : newlineIndex > lineStart && text[newlineIndex - 1] === '\r'
          ? newlineIndex - 1
          : newlineIndex;
    const lineAfter = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const line = text.slice(lineStart, lineEnd);
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (match) {
      const marker = match[1];
      const info = match[2];
      const fenceChar = marker[0];
      if (fence === null) {
        if (fenceChar !== '`' || !info.includes('`')) {
          fence = { char: fenceChar, length: marker.length, start: lineStart };
        }
      } else if (
        fenceChar === fence.char &&
        marker.length >= fence.length &&
        /^\s*$/u.test(info)
      ) {
        ranges.push({ start: fence.start, end: lineAfter });
        fence = null;
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    lineStart = lineAfter;
  }
  if (fence !== null) {
    ranges.push({ start: fence.start, end: text.length });
  }
  return ranges;
}
function findInlineCodeRanges(text, start, end) {
  const ranges = [];
  let cursor = start;
  while (cursor < end) {
    if (text[cursor] !== '`' || isEscapedBacktick(text, cursor)) {
      cursor += 1;
      continue;
    }
    const openingLength = countBackticks(text, cursor, end);
    const contentStart = cursor + openingLength;
    let candidate = contentStart;
    let closed = false;
    while (candidate < end) {
      if (text[candidate] !== '`') {
        candidate += 1;
        continue;
      }
      const closingLength = countBackticks(text, candidate, end);
      if (
        closingLength === openingLength &&
        !hasBlankLine(text, contentStart, candidate)
      ) {
        ranges.push({
          start: cursor,
          end: candidate + closingLength,
        });
        cursor = candidate + closingLength;
        closed = true;
        break;
      }
      candidate += closingLength;
    }
    if (!closed) {
      cursor = contentStart;
    }
  }
  return ranges;
}
function findMarkdownCodeRanges(text) {
  const fencedRanges = findFencedCodeRanges(text);
  const ranges = [...fencedRanges];
  let cursor = 0;
  for (const fencedRange of fencedRanges) {
    ranges.push(...findInlineCodeRanges(text, cursor, fencedRange.start));
    cursor = fencedRange.end;
  }
  ranges.push(...findInlineCodeRanges(text, cursor, text.length));
  return ranges.sort((left, right) => left.start - right.start);
}
/**
 * Mask Markdown code regions without changing UTF-16 character positions.
 * Unlike {@link stripMarkdownCodeRegions}, this is intended for regex matches
 * whose offsets must be mapped back to the original text. It also follows
 * CommonMark's equal-length backtick delimiters and escaped-backtick rules so
 * malformed Markdown cannot hide an ordinary-prose policy directive.
 */
export function maskMarkdownCodeRegionsPreservingPositions(text) {
  const masked = text.split('');
  for (const range of findMarkdownCodeRanges(text)) {
    for (let index = range.start; index < range.end; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') {
        masked[index] = ' ';
      }
    }
  }
  return masked.join('');
}
