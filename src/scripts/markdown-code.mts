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
  let fence: {
    char: string;
    length: number;
    containerDepth: number;
    listContentIndent: number | null;
  } | null = null;
  for (const line of lines) {
    const containerLine = parseContainerLine(line);
    const listContinuationLine =
      fence === null || fence.listContentIndent === null
        ? containerLine.content
        : stripContainerPrefixes(line, fence.containerDepth);
    if (
      fence !== null &&
      ((fence.containerDepth > 0 &&
        containerLine.containerDepth < fence.containerDepth) ||
        (fence.listContentIndent !== null &&
          !continuesListContainer(
            listContinuationLine,
            fence.listContentIndent,
          )))
    ) {
      fence = null;
    }
    const parsed = parseFencedLine(
      line,
      fence?.listContentIndent ?? null,
      fence !== null,
    );
    if (parsed) {
      const fenceChar = parsed.marker[0];
      if (fence === null) {
        // CommonMark §4.5: a backtick-fence opener's info string may not
        // contain a backtick (that would be ambiguous with a close or inline
        // code), so such a line is not a fence opener and stays content.
        if (isValidFenceOpener(parsed)) {
          fence = {
            char: fenceChar,
            length: parsed.marker.length,
            containerDepth: parsed.containerDepth,
            listContentIndent: parsed.listContentIndent,
          };
          out.push('');
          continue;
        }
      } else if (
        fenceChar === fence.char &&
        parsed.marker.length >= fence.length &&
        parsed.containerDepth === fence.containerDepth &&
        /^\s*$/.test(parsed.info)
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

export type MarkdownCodeRange = { start: number; end: number };

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
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*])[ \t]+|1[.)][ \t]+|(?:-{1,}|={1,}|_{3,}|\*{3,})[ \t]*$)/u;
const MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-{1,}|={1,}|_{3,}|\*{3,})[ \t]*$)/u;
const MARKDOWN_HTML_BLOCK_START_PATTERN =
  /^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|p|pre|script|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$))/iu;
const MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN =
  /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^<>]*?)?[ \t]*\/?>/u;
// CommonMark §4.1: a thematic break is 3+ matching -, _, or * characters,
// each optionally followed by spaces/tabs -- interior spacing is allowed
// (e.g. `_ _ _`), unlike the tightly-packed run already covered above.
const MARKDOWN_THEMATIC_BREAK_PATTERN =
  /^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/u;
// CommonMark type-1 raw-text HTML elements (script/pre/style/textarea) only
// end at a line containing their matching closing tag -- unlike the other
// HTML block types, a blank line does not close them.
const HTML_RAW_TEXT_TAG_CLOSE_PATTERN = /<\/(?:script|pre|style|textarea)\b/iu;
const HTML_RAW_TEXT_TAG_OPEN_PATTERN =
  /^ {0,3}<(?:script|pre|style|textarea)\b/iu;

/**
 * True when `content` (a line with any blockquote container prefix already
 * stripped -- a caller-held list-item marker, if present, may still be in
 * place) starts a new Markdown block -- either the fixed-form patterns
 * above, or a thematic break whose repeated marker characters are separated
 * by spaces or tabs. `MARKDOWN_BLOCK_CONTENT_PATTERN`'s own list-item
 * alternative already matches a leading `-`/`+`/`*`/`1.`/`1)` marker
 * directly, correctly treating it as a block start on its own -- a list
 * item is a genuine new block per CommonMark -- so no separate stripping is
 * needed here regardless of whether the caller already stripped one.
 */
function isMarkdownBlockStart(content: string): boolean {
  return (
    MARKDOWN_BLOCK_CONTENT_PATTERN.test(content) ||
    MARKDOWN_THEMATIC_BREAK_PATTERN.test(content)
  );
}

/** True when `content` opens with an HTML closing-tag slash (`</tag>`). */
function isHtmlClosingSyntax(content: string): boolean {
  return /^ {0,3}<\//u.test(content);
}

/**
 * True when `content` opens one of CommonMark's four special HTML block
 * forms (comment, processing instruction, declaration, CDATA) and also
 * carries that form's own closing token later on the same line -- e.g.
 * `<!-- comment -->`. Unlike a raw-text or generic HTML block, these forms
 * can be fully self-contained on one line; when they are, that line proves
 * nothing about enclosing a later line and must not be read as leaving an
 * open block behind it.
 */
function isSelfClosedSpecialHtmlBlock(content: string): boolean {
  if (/^ {0,3}<!--/u.test(content)) {
    return content.includes('-->');
  }
  if (/^ {0,3}<\?/u.test(content)) {
    return content.includes('?>');
  }
  if (/^ {0,3}<!\[CDATA\[/iu.test(content)) {
    return content.includes(']]>');
  }
  if (/^ {0,3}<![A-Z]/iu.test(content)) {
    return content.includes('>');
  }
  return false;
}

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

/**
 * Find the start offset of the line immediately before `lineStart`, or
 * `null` when `lineStart` is already the first line of `text`.
 */
function findPreviousLineStart(text: string, lineStart: number): number | null {
  if (lineStart <= 0) {
    return null;
  }
  const terminatorIndex = lineStart - 1;
  if (terminatorIndex === 0) {
    return 0;
  }
  const priorNewline = text.lastIndexOf('\n', terminatorIndex - 1);
  return priorNewline === -1 ? 0 : priorNewline + 1;
}

/**
 * True when the line at `openingLineStart` is still inside a raw or custom
 * HTML block opened on an earlier line at the same container depth (for
 * example, an unclosed `<script>` directly above a quoted paragraph) -- so it
 * must not be mistaken for an ordinary paragraph line. Scans backward
 * through consecutive, same-depth lines; a container-depth change ends the
 * search unconditionally (not enclosed).
 *
 * CommonMark's HTML block families close differently, so a line that
 * otherwise looks like a new block (heading, list, thematic break) never
 * ends any of them by itself -- their content stays completely literal
 * until their own close condition. This scan's handling of the blank-line
 * question, by family:
 *
 * - Raw-text elements (`<script>`/`<pre>`/`<style>`/`<textarea>`) close only
 *   on a line containing their matching end tag; a blank line does not
 *   affect them, so the scan keeps looking for one past any number of blank
 *   lines.
 * - The special forms (comment/processing-instruction/declaration/CDATA)
 *   likewise close only on their own token per CommonMark, not on a blank
 *   line -- this scan currently only recognizes a same-line self-close
 *   (`isSelfClosedSpecialHtmlBlock`) for them; short of that, it falls back
 *   to the blank-line-terminated handling below, which is imprecise for a
 *   multi-line special block containing a blank line (tracked in #1895).
 * - Every generic HTML block type (`<div>` and the like) genuinely does
 *   close at a blank line. Once the scan has crossed one, an opener found
 *   further back no longer reaches the opening line and is ignored -- only
 *   a still-reachable raw-text opener can still apply.
 *
 * A closing tag for a non-raw-text element (e.g. `</div>`) proves nothing on
 * its own and is skipped rather than treated as a boundary or a find.
 *
 * A scanned line's own list-item marker (e.g. `- <script>`) is stripped
 * before testing it against the HTML patterns, the same way the opening
 * line's own marker already is. This only ever affects a caller reachable
 * through a container-depth change elsewhere (see `findMarkdownBlockBoundary`
 * below) -- a bare, blockquote-free list item never reaches this function,
 * since `findMarkdownBlockBoundary` does not itself track list-content
 * indentation continuation (a separate, pre-existing gap, out of scope here).
 *
 * **Known limitation.** This scan short-circuits on the first close/open
 * signal it finds, so it does not track more than one candidate enclosing
 * block type at once. A line whose literal content merely *resembles* a
 * raw-text closing tag (e.g. `</script>` appearing as plain text inside a
 * still-open, unclosed multi-line HTML comment) is read as a genuine
 * raw-text closer, ending the scan before it can reach the comment's real
 * opener further back -- a bounded backward scan cannot fully disambiguate
 * this without the kind of forward, single-pass block-state tracking the
 * rest of this module does not otherwise need. Tracked as a follow-up
 * rather than folded into this pass.
 */
function isWithinOpenHtmlBlock(
  text: string,
  openingLineStart: number,
  containerDepth: number,
): boolean {
  let crossedBlankLine = false;
  let lineStart = findPreviousLineStart(text, openingLineStart);
  while (lineStart !== null) {
    const line = lineBounds(text, lineStart);
    const parsed = parseContainerLine(text.slice(lineStart, line.end));
    if (parsed.containerDepth !== containerDepth) {
      return false;
    }
    if (parsed.content.trim() === '') {
      crossedBlankLine = true;
      lineStart = findPreviousLineStart(text, lineStart);
      continue;
    }
    // A list marker (e.g. `- <script>`) is not part of the HTML tag itself;
    // test the content after it, the same way the opening-line check does.
    const htmlContent =
      parseListItemMatch(parsed.content)?.content ?? parsed.content;
    if (HTML_RAW_TEXT_TAG_CLOSE_PATTERN.test(htmlContent)) {
      return false;
    }
    if (HTML_RAW_TEXT_TAG_OPEN_PATTERN.test(htmlContent)) {
      return true;
    }
    if (
      !crossedBlankLine &&
      !isHtmlClosingSyntax(htmlContent) &&
      !isSelfClosedSpecialHtmlBlock(htmlContent) &&
      (MARKDOWN_HTML_BLOCK_START_PATTERN.test(htmlContent) ||
        MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(htmlContent))
    ) {
      return true;
    }
    lineStart = findPreviousLineStart(text, lineStart);
  }
  return false;
}

/**
 * True when `marker` is one of the "genuine", paragraph-interrupting list
 * markers {@link isMarkdownBlockStart}'s own list branch recognizes (`-`,
 * `+`, `*`, `1.`, `1)`) -- unlike {@link parseListItemContainer}, which
 * accepts any ordered-list digit. CommonMark allows a non-"1" ordered
 * marker (e.g. `2.`) to appear mid-paragraph without interrupting it, so
 * such a marker must never anchor list-content-indent tracking.
 */
function isInterruptingListMarker(marker: string): boolean {
  return (
    marker === '-' ||
    marker === '+' ||
    marker === '*' ||
    /^1[.)]$/u.test(marker)
  );
}

/**
 * The list-item content indent for `content` when it opens with a genuine,
 * paragraph-interrupting list marker (see {@link isInterruptingListMarker}),
 * else `null`.
 */
function interruptingListContentIndent(content: string): number | null {
  const listItem = parseListItemMatch(content);
  return listItem !== null && isInterruptingListMarker(listItem.marker)
    ? parseListItemContainer(content)
    : null;
}

/**
 * Determine the active list-item content indent enclosing
 * `openingLineStart`, if any -- the list-continuation counterpart, for
 * {@link findMarkdownBlockBoundary}'s opening line, of
 * {@link isWithinOpenHtmlBlock}'s backward scan for open HTML blocks.
 * Returns `null` when `openingLineStart` is not inside an active list
 * item's content zone at `containerDepth`.
 *
 * Phase 1 scans backward for the nearest same-depth list-item opener not
 * separated from `openingLineStart` by an unrelated block start. Phase 2
 * then verifies every line from that opener through `openingLineStart`
 * itself continues the list per {@link continuesListContainer}, with the
 * same two-consecutive-blank-line cutoff {@link findIndentedCodeRanges}
 * applies (CommonMark ends a list after two blank lines in a row) -- the
 * opening line must satisfy this too, not only the lines between it and
 * the opener, or a call whose opening line has nothing to do with an
 * earlier, unrelated list (separated only by a single blank line) would
 * wrongly inherit that list's indent.
 */
function findEnclosingListContentIndent(
  text: string,
  openingLineStart: number,
  containerDepth: number,
): number | null {
  let openerLineStart: number | null = null;
  let openerContentIndent: number | null = null;
  let lineStart = findPreviousLineStart(text, openingLineStart);
  while (lineStart !== null) {
    const line = lineBounds(text, lineStart);
    const raw = text.slice(lineStart, line.end);
    const parsed = parseContainerLine(raw);
    if (parsed.containerDepth !== containerDepth) {
      return null;
    }
    if (parsed.content.trim() === '') {
      lineStart = findPreviousLineStart(text, lineStart);
      continue;
    }
    const contentIndent = interruptingListContentIndent(parsed.content);
    if (contentIndent !== null) {
      openerLineStart = lineStart;
      openerContentIndent = contentIndent;
      break;
    }
    const fencedLine = parseFencedLine(raw);
    if (
      isMarkdownBlockStart(parsed.content) ||
      MARKDOWN_HTML_BLOCK_START_PATTERN.test(parsed.content) ||
      MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(parsed.content) ||
      (fencedLine !== null && isValidFenceOpener(fencedLine))
    ) {
      return null;
    }
    lineStart = findPreviousLineStart(text, lineStart);
  }
  if (openerLineStart === null || openerContentIndent === null) {
    return null;
  }
  let blankRun = 0;
  let cursor = lineBounds(text, openerLineStart).next;
  while (cursor <= openingLineStart) {
    const line = lineBounds(text, cursor);
    const continuation = stripContainerPrefixes(
      text.slice(cursor, line.end),
      containerDepth,
    );
    if (continuation.trim() === '') {
      blankRun += 1;
      if (blankRun >= 2) {
        return null;
      }
    } else {
      blankRun = 0;
      if (!continuesListContainer(continuation, openerContentIndent)) {
        return null;
      }
    }
    if (line.next === cursor) {
      break;
    }
    cursor = line.next;
  }
  return openerContentIndent;
}

function findMarkdownBlockBoundary(
  text: string,
  start: number,
  end: number,
): number | null {
  const openingLineStart = text.lastIndexOf('\n', start - 1) + 1;
  const openingLine = lineBounds(text, openingLineStart);
  const openingRawLine = text.slice(openingLineStart, openingLine.end);
  const openingParsed = parseContainerLine(openingRawLine);
  const openingListItem = parseListItemMatch(openingParsed.content);
  const openingParagraphContent =
    openingListItem?.content ?? openingParsed.content;
  const openingFence = parseFencedLine(openingRawLine);
  const openingContainerDepth = openingParsed.containerDepth;
  // #1894/#1896: openingIsParagraph now gates list-content-indent laziness
  // below too, not only isLazyQuoteContinuation (blockquote-only) -- so the
  // backward scan must run at every container depth, not only inside a
  // blockquote. CommonMark laziness (omitting a container's own required
  // indentation/markers on a continuation line) only ever applies to an
  // in-progress *paragraph*; a still-open HTML block is a different block
  // type with its own closing rule, so it must not inherit laziness --
  // isWithinOpenHtmlBlock is exactly the signal that tells the two apart.
  const openingIsParagraph =
    !isMarkdownBlockStart(openingParagraphContent) &&
    !MARKDOWN_HTML_BLOCK_START_PATTERN.test(openingParagraphContent) &&
    !MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(openingParagraphContent) &&
    (openingFence === null || !isValidFenceOpener(openingFence)) &&
    !isWithinOpenHtmlBlock(text, openingLineStart, openingContainerDepth);
  // List-content-indent tracking (#1894): when the opening line is itself a
  // genuine list-item opener, its own indent applies directly; otherwise a
  // bounded backward/forward scan checks whether it continues an earlier
  // list item's content zone. A later line that no longer continues that
  // zone is a genuine block boundary, mirroring the listContentIndent /
  // continuesListContainer pairing findIndentedCodeRanges and
  // blankFencedCodeBlocks already use -- unless it is itself a lazy
  // continuation of the opening paragraph (below), the list counterpart of
  // isLazyQuoteContinuation.
  const openingListContentIndent =
    interruptingListContentIndent(openingParsed.content) ??
    findEnclosingListContentIndent(
      text,
      openingLineStart,
      openingContainerDepth,
    );
  let lineStart = openingLine.next;

  while (lineStart < end) {
    const line = lineBounds(text, lineStart);
    const rawLine = text.slice(lineStart, line.end);
    const parsed = parseContainerLine(rawLine);
    const fencedLine = parseFencedLine(rawLine);
    const isBlockStart =
      isMarkdownBlockStart(parsed.content) ||
      MARKDOWN_HTML_BLOCK_START_PATTERN.test(parsed.content) ||
      MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(parsed.content) ||
      (fencedLine !== null && isValidFenceOpener(fencedLine));
    // A de-indented line that would otherwise end the list item's content
    // zone still lazily continues an in-progress ordinary paragraph --
    // CommonMark laziness -- unless the opening line is itself inside a
    // still-open HTML block (openingIsParagraph false), which has no such
    // exception.
    const isLazyListContinuation = openingIsParagraph && !isBlockStart;
    const failsListContinuation =
      openingListContentIndent !== null &&
      parsed.containerDepth === openingContainerDepth &&
      !isLazyListContinuation &&
      !continuesListContainer(
        stripContainerPrefixes(rawLine, openingContainerDepth),
        openingListContentIndent,
      );
    if (parsed.containerDepth !== openingContainerDepth) {
      // A quote marker may continue an inline span while it stays a proper
      // prefix of the opening container -- CommonMark laziness permits
      // omitting any number of trailing `>` markers, not only all of them.
      // A quote that goes deeper, or a line that starts a new block, is a
      // real break.
      const isLazyQuoteContinuation =
        openingContainerDepth > 0 &&
        parsed.containerDepth < openingContainerDepth &&
        openingIsParagraph &&
        !isBlockStart;
      if (
        !isLazyQuoteContinuation &&
        (parsed.containerDepth > 0 || openingContainerDepth > 0)
      ) {
        return lineStart;
      }
    }
    if (isBlockStart || failsListContinuation) {
      return lineStart;
    }
    if (line.next === lineStart) {
      break;
    }
    lineStart = line.next;
  }
  return null;
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
  listContentIndent: number | null;
};

type ContainerLine = {
  content: string;
  containerDepth: number;
  listContentIndent: number | null;
};

type ListItemMatch = {
  marker: string;
  markerIndent: string;
  spacing: string;
  content: string;
};

const LIST_ITEM_PATTERN = /^([ \t]{0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/u;

function indentationColumns(text: string, initialColumns = 0): number {
  let columns = initialColumns;
  for (const character of text) {
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

function parseListItemMatch(content: string): ListItemMatch | null {
  const match = content.match(LIST_ITEM_PATTERN);
  if (!match || indentationColumns(match[1]) >= 4) {
    return null;
  }
  return {
    markerIndent: match[1],
    marker: match[2],
    spacing: match[3],
    content: match[4],
  };
}

function parseListItemContainer(content: string): number | null {
  const listItem = parseListItemMatch(content);
  if (!listItem) {
    return null;
  }
  const markerEndColumns =
    indentationColumns(listItem.markerIndent) + listItem.marker.length;
  const spacingColumns =
    indentationColumns(listItem.spacing, markerEndColumns) - markerEndColumns;
  // CommonMark treats five or more spaces after a list marker as one
  // separating space plus literal content indentation. Keeping the full
  // padding here would make a valid four-column continuation look like
  // ordinary prose instead of nested code.
  const contentPadding = spacingColumns > 4 ? 1 : spacingColumns;
  return markerEndColumns + contentPadding;
}

function parseContainerLine(line: string): ContainerLine {
  let cursor = 0;
  let containerDepth = 0;
  while (cursor < line.length) {
    const markerStart = cursor;
    let leadingSpaces = 0;
    while (leadingSpaces < 3 && line[cursor] === ' ') {
      cursor += 1;
      leadingSpaces += 1;
    }
    if (line[cursor] !== '>') {
      cursor = markerStart;
      break;
    }
    cursor += 1;
    containerDepth += 1;
    if (line[cursor] === ' ') {
      cursor += 1;
    }
  }
  const content = containerDepth > 0 ? line.slice(cursor) : line;
  return {
    content,
    containerDepth,
    listContentIndent: parseListItemContainer(content),
  };
}

function stripContainerPrefixes(line: string, depth: number): string {
  let cursor = 0;
  for (let level = 0; level < depth; level += 1) {
    const markerStart = cursor;
    let leadingSpaces = 0;
    while (leadingSpaces < 3 && line[cursor] === ' ') {
      cursor += 1;
      leadingSpaces += 1;
    }
    if (line[cursor] !== '>') {
      return line.slice(markerStart);
    }
    cursor += 1;
    if (line[cursor] === ' ') {
      cursor += 1;
    }
  }
  return line.slice(cursor);
}

function stripListItemMarker(content: string): string {
  const listItem = parseListItemMatch(content);
  if (!listItem) {
    return content;
  }
  const markerEndColumns =
    indentationColumns(listItem.markerIndent) + listItem.marker.length;
  const spacingColumns =
    indentationColumns(listItem.spacing, markerEndColumns) - markerEndColumns;
  const literalSpacing =
    spacingColumns > 4
      ? stripLeadingIndentColumns(
          listItem.spacing,
          markerEndColumns + 1,
          markerEndColumns,
        )
      : '';
  return literalSpacing + listItem.content;
}

function continuesListContainer(
  content: string,
  contentIndent: number,
): boolean {
  return content.trim() === '' || indentationColumns(content) >= contentIndent;
}

function stripLeadingIndentColumns(
  text: string,
  targetColumns: number,
  initialColumns = 0,
): string {
  if (targetColumns <= initialColumns) {
    return text;
  }
  let columns = initialColumns;
  let cursor = 0;
  while (cursor < text.length && columns < targetColumns) {
    const character = text[cursor];
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      const nextTabStop = columns + 4 - (columns % 4);
      if (nextTabStop > targetColumns) {
        return ' '.repeat(nextTabStop - targetColumns) + text.slice(cursor + 1);
      }
      columns = nextTabStop;
    } else {
      return text;
    }
    cursor += 1;
  }
  return columns >= targetColumns ? text.slice(cursor) : text;
}

function parseFencedLine(
  line: string,
  activeListContentIndent: number | null = null,
  fenceIsOpen = false,
): FencedLine | null {
  const {
    content: containerContent,
    containerDepth,
    listContentIndent,
  } = parseContainerLine(line);
  // A fenced block may begin directly after a list marker (`- ~~~` or
  // `1. ~~~`). The list marker is a container prefix, not part of the fence;
  // continuation lines commonly carry only the list indentation (`  ~~~`).
  const relativeContent =
    activeListContentIndent === null
      ? containerContent
      : stripLeadingIndentColumns(containerContent, activeListContentIndent);
  // Once a fence is open, its contents are opaque. A line such as
  // `    - ~~~` must not be reparsed as a nested list item and mistaken for
  // the closing fence; strip a list marker only while recognizing an opener.
  const content = !fenceIsOpen
    ? stripListItemMarker(relativeContent)
    : relativeContent;
  const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (!fenceMatch) {
    return null;
  }
  return {
    marker: fenceMatch[1],
    info: fenceMatch[2],
    containerDepth,
    listContentIndent,
  };
}

function isValidFenceOpener(fence: FencedLine): boolean {
  return fence.marker[0] !== '`' || !fence.info.includes('`');
}

function findFencedCodeRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let fence: {
    char: string;
    length: number;
    start: number;
    containerDepth: number;
    listContentIndent: number | null;
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

    if (fence !== null) {
      const listContinuationLine =
        fence.listContentIndent === null
          ? containerLine.content
          : stripContainerPrefixes(line, fence.containerDepth);
      if (
        (fence.containerDepth > 0 &&
          containerLine.containerDepth < fence.containerDepth) ||
        (fence.listContentIndent !== null &&
          !continuesListContainer(
            listContinuationLine,
            fence.listContentIndent,
          ))
      ) {
        ranges.push({ start: fence.start, end: lineStart });
        fence = null;
      }
    }

    const match = parseFencedLine(
      line,
      fence?.listContentIndent ?? null,
      fence !== null,
    );

    if (match) {
      const marker = match.marker;
      const info = match.info;
      const fenceChar = marker[0];
      if (fence === null) {
        if (isValidFenceOpener(match)) {
          fence = {
            char: fenceChar,
            length: marker.length,
            start: lineStart,
            containerDepth: match.containerDepth,
            listContentIndent: match.listContentIndent,
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

function findIndentedCodeRanges(
  text: string,
  fencedRanges: MarkdownCodeRange[],
): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let rangeStart: number | null = null;
  let rangeEnd = 0;
  let previousLineBlank = true;
  let previousLineBlockBoundary = true;
  let previousContainerDepth = 0;
  let activeListContentIndent: number | null = null;
  let activeListContainerDepth: number | null = null;
  let activeListBlankLines = 0;
  let lineStart = 0;
  let fencedRangeIndex = 0;

  while (lineStart <= text.length) {
    const line = lineBounds(text, lineStart);
    const rawLine = text.slice(lineStart, line.end);
    while (
      fencedRangeIndex < fencedRanges.length &&
      lineStart >= (fencedRanges[fencedRangeIndex]?.end ?? text.length)
    ) {
      fencedRangeIndex += 1;
    }
    const fencedRange = fencedRanges[fencedRangeIndex];
    const isOpaqueFenceContent =
      fencedRange !== undefined &&
      lineStart > fencedRange.start &&
      lineStart < fencedRange.end;
    if (isOpaqueFenceContent) {
      if (line.next === lineStart) {
        break;
      }
      lineStart = line.next;
      continue;
    }
    const parsed = parseContainerLine(rawLine);
    const listItem = parseListItemMatch(parsed.content);
    const isBlank = parsed.content.trim() === '';
    if (
      activeListContentIndent !== null &&
      parsed.containerDepth !== activeListContainerDepth
    ) {
      activeListContentIndent = null;
      activeListContainerDepth = null;
      activeListBlankLines = 0;
    }
    if (
      !isBlank &&
      listItem === null &&
      activeListContentIndent !== null &&
      indentationColumns(parsed.content) < activeListContentIndent
    ) {
      activeListContentIndent = null;
      activeListContainerDepth = null;
      activeListBlankLines = 0;
    }
    const isNonInterruptingListItem: boolean =
      listItem !== null &&
      !previousLineBlank &&
      !previousLineBlockBoundary &&
      parsed.containerDepth === previousContainerDepth &&
      activeListContentIndent === null &&
      (listItem.content.trim() === '' ||
        (/^\d{1,9}[.)]$/u.test(listItem.marker) &&
          !/^1[.)]$/u.test(listItem.marker)));
    const listContentIndent: number | null = isNonInterruptingListItem
      ? null
      : parsed.listContentIndent;
    const isIndented =
      indentationColumns(parsed.content) >=
      (activeListContentIndent === null ? 4 : activeListContentIndent + 4);
    if (rangeStart === null && activeListContentIndent !== null) {
      if (isBlank) {
        activeListBlankLines += 1;
        if (activeListBlankLines >= 2) {
          activeListContentIndent = null;
          activeListContainerDepth = null;
        }
      } else {
        activeListBlankLines = 0;
      }
    }
    const canStartCode =
      rangeStart !== null ||
      previousLineBlank ||
      previousLineBlockBoundary ||
      parsed.containerDepth !== previousContainerDepth;

    if (isIndented && canStartCode) {
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

    previousLineBlank = isBlank;
    previousLineBlockBoundary =
      MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN.test(parsed.content) ||
      (() => {
        const fencedLine = parseFencedLine(rawLine);
        return fencedLine !== null && isValidFenceOpener(fencedLine);
      })();
    previousContainerDepth = parsed.containerDepth;
    if (rangeStart === null && listContentIndent !== null) {
      activeListContentIndent = listContentIndent;
      activeListContainerDepth = parsed.containerDepth;
      activeListBlankLines = 0;
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
    const blockBoundary = findMarkdownBlockBoundary(text, contentStart, end);
    const candidateEnd = blockBoundary ?? end;

    while (candidate < candidateEnd) {
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

export function findMarkdownCodeRanges(text: string): MarkdownCodeRange[] {
  const fencedRanges = findFencedCodeRanges(text);
  const structuralRanges = mergeMarkdownCodeRanges([
    ...fencedRanges,
    ...findIndentedCodeRanges(text, fencedRanges),
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
  ranges: MarkdownCodeRange[] = findMarkdownCodeRanges(text),
): MarkdownCodeRange | null {
  if (!Number.isInteger(position) || position < 0 || position >= text.length) {
    return null;
  }
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle];
    if (range === undefined) {
      break;
    }
    if (position < range.start) {
      high = middle - 1;
    } else if (position >= range.end) {
      low = middle + 1;
    } else {
      return range;
    }
  }
  return null;
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
  ranges: MarkdownCodeRange[] = findMarkdownCodeRanges(text),
): string {
  const masked = text.split('');
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      if (masked[index] !== '\n' && masked[index] !== '\r') {
        masked[index] = ' ';
      }
    }
  }
  return masked.join('');
}
