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
export function blankFencedCodeBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
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

export function stripMarkdownCodeRegions(text: string): string {
  // Inline code spans: mask the inner content so a quoted marker no longer
  // matches, keeping the backticks and surrounding text.
  return blankFencedCodeBlocks(text).replace(
    INLINE_CODE_SPAN_PATTERN,
    (_match, ticks: string, inner: string) =>
      `${ticks}${inner.replace(/[^\r\n]/g, ' ')}${ticks}`,
  );
}

type MarkdownCodeRange = { start: number; end: number };

function isEscapedBacktick(text: string, index: number): boolean {
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

function hasBlankLine(text: string, start: number, end: number): boolean {
  return /\r?\n[ \t]*\r?\n/u.test(text.slice(start, end));
}

const MARKDOWN_BLOCK_BOUNDARY_PATTERN =
  /^[ \t]{0,3}(?:#{1,6}(?:[ \t]|$)|>[ \t]+|(?:[-+*])[ \t]+|\d{1,9}[.)][ \t]+)/mu;

function hasMarkdownBlockBoundary(
  text: string,
  start: number,
  end: number,
): boolean {
  return MARKDOWN_BLOCK_BOUNDARY_PATTERN.test(text.slice(start, end));
}

function countBackticks(text: string, start: number, end: number): number {
  let cursor = start;
  while (cursor < end && text[cursor] === '`') {
    cursor += 1;
  }
  return cursor - start;
}

type FencedLine = {
  marker: string;
  info: string;
  containerDepth: number;
};

function parseFencedLine(line: string): FencedLine | null {
  const quoteMatch = line.match(/^ {0,3}(?:(?:> ?)+)(.*)$/u);
  const containerDepth = quoteMatch
    ? (quoteMatch[0].match(/>/gu)?.length ?? 0)
    : 0;
  const content = quoteMatch ? quoteMatch[1] : line;
  const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!fenceMatch) {
    return null;
  }
  return {
    marker: fenceMatch[1],
    info: fenceMatch[2],
    containerDepth,
  };
}

function findFencedCodeRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let fence: {
    char: string;
    length: number;
    start: number;
    containerDepth: number;
  } | null = null;
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
    const match = parseFencedLine(line);

    if (match) {
      const marker = match.marker;
      const info = match.info;
      const fenceChar = marker[0];
      if (fence === null) {
        if (fenceChar !== '`' || !info.includes('`')) {
          fence = {
            char: fenceChar,
            length: marker.length,
            start: lineStart,
            containerDepth: match.containerDepth,
          };
        }
      } else if (
        fenceChar === fence.char &&
        marker.length >= fence.length &&
        match.containerDepth === fence.containerDepth &&
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

function findInlineCodeRanges(
  text: string,
  start: number,
  end: number,
): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
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
        !isEscapedBacktick(text, candidate) &&
        !hasMarkdownBlockBoundary(text, contentStart, candidate) &&
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

function findMarkdownCodeRanges(text: string): MarkdownCodeRange[] {
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

/** Return whether a source range is fully contained by one valid code region. */
export function isMarkdownCodeRange(
  text: string,
  start: number,
  end: number,
): boolean {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > text.length
  ) {
    return false;
  }
  return findMarkdownCodeRanges(text).some(
    (range) => range.start <= start && end <= range.end,
  );
}

/**
 * Mask Markdown code regions without changing UTF-16 character positions.
 * Unlike {@link stripMarkdownCodeRegions}, this is intended for regex matches
 * whose offsets must be mapped back to the original text. It also follows
 * CommonMark's equal-length backtick delimiters and escaped-backtick rules so
 * malformed Markdown cannot hide an ordinary-prose policy directive.
 */
export function maskMarkdownCodeRegionsPreservingPositions(
  text: string,
): string {
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
