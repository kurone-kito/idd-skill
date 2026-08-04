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

const MARKDOWN_BLOCK_CONTENT_PATTERN =
  /^(?:#{1,6}(?:[ \t]|$)|(?:[-+*])[ \t]+|\d{1,9}[.)][ \t]+|(?:-{1,}|={1,}|_{3,}|\*{3,})[ \t]*$)/u;

function lineBounds(
  text: string,
  lineStart: number,
): {
  end: number;
  next: number;
} {
  const newlineIndex = text.indexOf('\n', lineStart);
  const end =
    newlineIndex === -1
      ? text.length
      : newlineIndex > lineStart && text[newlineIndex - 1] === '\r'
        ? newlineIndex - 1
        : newlineIndex;
  return {
    end,
    next: newlineIndex === -1 ? text.length : newlineIndex + 1,
  };
}

function hasMarkdownBlockBoundary(
  text: string,
  start: number,
  end: number,
): boolean {
  const openingLineStart = text.lastIndexOf('\n', start - 1) + 1;
  const openingLine = lineBounds(text, openingLineStart);
  const openingContainerDepth = parseContainerLine(
    text.slice(openingLineStart, openingLine.end),
  ).containerDepth;
  let lineStart = openingLine.next;

  while (lineStart < end) {
    const line = lineBounds(text, lineStart);
    const parsed = parseContainerLine(text.slice(lineStart, line.end));
    if (parsed.containerDepth !== openingContainerDepth) {
      // A quote marker may continue an inline span only when it belongs to
      // the same container. A quote that starts or ends here is a block break.
      if (parsed.containerDepth > 0 || openingContainerDepth > 0) {
        return true;
      }
    }
    if (MARKDOWN_BLOCK_CONTENT_PATTERN.test(parsed.content)) {
      return true;
    }
    if (line.next === lineStart) {
      break;
    }
    lineStart = line.next;
  }
  return false;
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

type ContainerLine = {
  content: string;
  containerDepth: number;
};

function parseContainerLine(line: string): ContainerLine {
  const quoteMatch = line.match(/^ {0,3}(?:(?:> ?)+)(.*)$/u);
  return {
    content: quoteMatch ? quoteMatch[1] : line,
    containerDepth: quoteMatch ? (quoteMatch[0].match(/>/gu)?.length ?? 0) : 0,
  };
}

function parseFencedLine(line: string): FencedLine | null {
  const { content, containerDepth } = parseContainerLine(line);
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
    const containerLine = parseContainerLine(line);
    const match = parseFencedLine(line);

    if (
      fence !== null &&
      fence.containerDepth > 0 &&
      containerLine.containerDepth < fence.containerDepth
    ) {
      ranges.push({ start: fence.start, end: lineStart });
      fence = null;
    }

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

function findIndentedCodeRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let rangeStart: number | null = null;
  let rangeEnd = 0;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const line = lineBounds(text, lineStart);
    const parsed = parseContainerLine(text.slice(lineStart, line.end));
    const isIndented = /^(?: {4,}|\t)/u.test(parsed.content);
    const isBlank = parsed.content.trim() === '';

    if (isIndented) {
      rangeStart ??= lineStart;
      rangeEnd = line.next;
    } else if (isBlank && rangeStart !== null) {
      // A blank line may occur inside an indented code block. Keeping it in
      // the range is harmless for masking and lets the next indented line
      // remain part of the same Markdown example.
      rangeEnd = line.next;
    } else if (rangeStart !== null) {
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = null;
      rangeEnd = 0;
    }

    if (line.next === lineStart) {
      break;
    }
    lineStart = line.next;
  }

  if (rangeStart !== null) {
    ranges.push({ start: rangeStart, end: rangeEnd });
  }
  return ranges;
}

function mergeMarkdownCodeRanges(
  ranges: MarkdownCodeRange[],
): MarkdownCodeRange[] {
  const merged: MarkdownCodeRange[] = [];
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
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
  const structuralRanges = mergeMarkdownCodeRanges([
    ...fencedRanges,
    ...findIndentedCodeRanges(text),
  ]);
  const ranges = [...structuralRanges];
  let cursor = 0;

  for (const structuralRange of structuralRanges) {
    ranges.push(...findInlineCodeRanges(text, cursor, structuralRange.start));
    cursor = structuralRange.end;
  }
  ranges.push(...findInlineCodeRanges(text, cursor, text.length));
  return mergeMarkdownCodeRanges(ranges);
}

/** Return the valid code region containing a source position, if any. */
export function getMarkdownCodeRange(
  text: string,
  position: number,
): MarkdownCodeRange | null {
  if (!Number.isInteger(position) || position < 0 || position >= text.length) {
    return null;
  }
  return (
    findMarkdownCodeRanges(text).find(
      (range) => range.start <= position && position < range.end,
    ) ?? null
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
