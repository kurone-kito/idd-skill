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
  const listTracker = createListContentIndentTrackerState();
  for (const line of lines) {
    const containerLine = parseContainerLine(line);
    const isBlank = containerLine.content.trim() === '';
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
    const fenceWasOpen = fence !== null;
    if (!fenceWasOpen) {
      resetListContentIndentTrackerForLine(listTracker, containerLine, isBlank);
    }
    const openerListContentIndent: number | null = fence
      ? fence.listContentIndent
      : listTracker.contentIndent;
    const parsed = parseFencedLine(
      line,
      openerListContentIndent,
      fence !== null,
    );
    if (!fenceWasOpen) {
      adoptListContentIndentForLine(listTracker, containerLine);
    }
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
            listContentIndent:
              openerListContentIndent ?? parsed.listContentIndent,
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
// HTML block types, a blank line does not close them. #1900: closing
// requires the *specific* tag that was opened, not any of the four -- a
// mismatched closing tag (e.g. `</style>` while `<script>` is open) must
// not end tracking.
type HtmlRawTextTag = 'script' | 'pre' | 'style' | 'textarea';
const HTML_RAW_TEXT_TAG_OPEN_PATTERN =
  /^ {0,3}<(script|pre|style|textarea)\b/iu;
const HTML_RAW_TEXT_TAG_CLOSE_PATTERNS: Readonly<
  Record<HtmlRawTextTag, RegExp>
> = {
  script: /<\/script\b/iu,
  pre: /<\/pre\b/iu,
  style: /<\/style\b/iu,
  textarea: /<\/textarea\b/iu,
};

/**
 * The raw-text tag that `content` opens (one of {@link HtmlRawTextTag}'s
 * four members), lower-cased for use as a
 * {@link HTML_RAW_TEXT_TAG_CLOSE_PATTERNS} key, or `null` when `content`
 * does not open a raw-text element.
 */
function rawTextOpenTag(content: string): HtmlRawTextTag | null {
  const match = HTML_RAW_TEXT_TAG_OPEN_PATTERN.exec(content);
  return match === null ? null : (match[1].toLowerCase() as HtmlRawTextTag);
}

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
 * The literal token that closes the CommonMark special HTML block form
 * (comment, processing instruction, declaration, CDATA) `content` opens, or
 * `null` when `content` does not open one of these four forms. Used both to
 * check a same-line self-close ({@link isSelfClosedSpecialHtmlBlock}) and,
 * by {@link isWithinOpenHtmlBlock}'s forward state tracking, to know which
 * token to watch for on a later line once the form is confirmed still open.
 */
function specialHtmlBlockCloseToken(content: string): string | null {
  if (/^ {0,3}<!--/u.test(content)) {
    return '-->';
  }
  if (/^ {0,3}<\?/u.test(content)) {
    return '?>';
  }
  if (/^ {0,3}<!\[CDATA\[/iu.test(content)) {
    return ']]>';
  }
  if (/^ {0,3}<![A-Z]/iu.test(content)) {
    return '>';
  }
  return null;
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
  const closeToken = specialHtmlBlockCloseToken(content);
  return closeToken !== null && content.includes(closeToken);
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
 * The single open-HTML-block hypothesis {@link isWithinOpenHtmlBlock}'s
 * forward pass tracks at a time. Modeled as one discriminated variable
 * (rather than several independent booleans) so "only one family is open
 * at once" is structural, not merely an accident of check ordering.
 *
 * - `raw-text`: an open `<script>`/`<pre>`/`<style>`/`<textarea>` element,
 *   carrying which of the four tags (`tag`) was actually opened; closes
 *   only on a line containing that same tag's own closing form -- a
 *   mismatched closing tag for a different raw-text element (e.g.
 *   `</style>` while `<script>` is open) does not close it (#1900).
 * - `special`: an open comment/processing-instruction/declaration/CDATA
 *   block; closes only when `closeToken` (that form's own token -- `-->`,
 *   `?>`, `]]>`, or `>`) appears on a later line, same-line or not.
 * - `generic`: an open type-6/7 HTML block (`<div>` and the like); closes
 *   at the next blank line, per CommonMark, and by nothing else.
 * - `none`: no open HTML block hypothesis.
 */
type HtmlBlockScanState =
  | { readonly type: 'none' }
  | { readonly type: 'raw-text'; readonly tag: HtmlRawTextTag }
  | { readonly type: 'special'; readonly closeToken: string }
  | { readonly type: 'generic' };

/**
 * True when the line at `openingLineStart` is still inside a raw, special,
 * or generic HTML block opened on an earlier line at the same container
 * depth (for example, an unclosed `<script>` directly above a quoted
 * paragraph) -- so it must not be mistaken for an ordinary paragraph line.
 *
 * Two passes, per the CommonMark distinction the shared
 * {@link HtmlBlockScanState} type documents:
 *
 * 1. **Bounded backward collection.** Walk backward from
 *    `openingLineStart` through consecutive same-depth lines (list-marker-
 *    stripped, the same way the opening line's own marker already is,
 *    which is what makes this scan reachable from a bare, blockquote-free
 *    list item too, per #1894's follow-up fix, not only from inside a
 *    blockquote). A container-depth change stops collection unconditionally
 *    -- a block-type hypothesis from a different depth never reaches
 *    `openingLineStart`.
 * 2. **Forward, single-pass state tracking** over the collected lines (now
 *    in document order, oldest first): thread exactly one
 *    {@link HtmlBlockScanState} through them. Only a `none` state ever
 *    considers opening a new hypothesis (via {@link specialHtmlBlockCloseToken}
 *    and {@link isSelfClosedSpecialHtmlBlock} for the special forms, the
 *    existing `!isHtmlClosingSyntax` guard preserved for the generic
 *    branch so a lone closing tag like `</div>` still doesn't count as an
 *    opener); once a state other than `none` is active, only that family's
 *    own close condition can end it -- nothing else changes it. Returning
 *    the final state's non-`none`-ness is what resolves the ambiguity a
 *    single backward short-circuit scan could not: a literal `</script>`
 *    encountered while `special` is active is never misread as a raw-text
 *    close, and a blank line encountered while `special` or `raw-text` is
 *    active never ends it (only `generic` closes on a blank line).
 *
 * `findMarkdownBlockBoundary` now calls this scan whenever an active list
 * zone is involved, not only inside a blockquote -- including when the
 * opening line itself looks like a fresh list-item opener: the scan still
 * runs there (it does not know or care whether its own starting
 * line has a marker; only the *lines it walks backward
 * through* have their own markers stripped before testing). Since #1896's
 * fix, a `true` result forces the enclosing code span to never form at all
 * (an unconditional block boundary), rather than merely gating the
 * `isLazyListContinuation` / `isLazyQuoteContinuation` laziness exception
 * for later lines -- *unless* the opening line is a genuine fresh sibling
 * list-item opener (its own marker, and not itself still within an
 * earlier, outer list item's content zone; see the guard in
 * `findMarkdownBlockBoundary` below), in which case only the laziness-gate
 * consumption still applies, so a legitimate same-line span opened by that
 * fresh sibling right after an unclosed tag in the previous item is not
 * destroyed.
 *
 * **Deliberate side effect.** A stray raw-text-close-shaped line (e.g. a
 * bare `</script>`) encountered while the state is still `none` -- no raw-
 * text block open at all -- is now inert rather than ending the scan. This
 * only changes the observable result when a genuine opener (raw-text,
 * special, or generic) is reachable further back past the stray closer: the
 * old scan returned "not enclosed" as soon as it saw the closer, regardless
 * of state, so it never reached that opener; the new scan correctly
 * continues past it and finds the still-open block. With no such opener
 * reachable, both scans agree (nothing was ever open to end). Verified
 * empirically both ways; covered by the last two cases in
 * `tests/markdown-code.test.mts`'s #1895 section.
 *
 * `earliestLineStart` (PR #1902 review finding): an optional lower bound on
 * how far back this scan may walk. The scan otherwise has no concept of a
 * list-item boundary -- it walks backward purely by same-`containerDepth`
 * lines -- so, unbounded, it can reach *past* a genuine sibling list-item
 * opener into an earlier, unrelated item's own open HTML block (a fresh
 * sibling's own line does not reset `containerDepth`, only its list-content
 * indent does, which this function does not track). `findMarkdownBlockBoundary`
 * passes the nearest enclosing list zone's own opener line (or the opening
 * line itself, when no such zone reaches it) whenever an active list zone
 * is involved; omitted (unbounded) for the pure-blockquote case, where no
 * sibling-item boundary concept applies and unbounded reachability across
 * shape-only lines is the CommonMark-correct behavior already relied on by
 * `tests/markdown-code.test.mts`'s pre-#1896 blockquote coverage.
 */
function isWithinOpenHtmlBlock(
  text: string,
  openingLineStart: number,
  containerDepth: number,
  earliestLineStart?: number,
): boolean {
  const sameDepthLines: { content: string; isBlank: boolean }[] = [];
  let lineStart = findPreviousLineStart(text, openingLineStart);
  while (lineStart !== null) {
    if (earliestLineStart !== undefined && lineStart < earliestLineStart) {
      break;
    }
    const line = lineBounds(text, lineStart);
    const parsed = parseContainerLine(text.slice(lineStart, line.end));
    if (parsed.containerDepth !== containerDepth) {
      break;
    }
    // Blankness is judged on the container-stripped line as a whole (a
    // marker-only line like `- ` is not itself a blank line), before a list
    // marker (e.g. `- <script>`) is stripped for the HTML-pattern tests
    // below -- stripping first would read that marker-only line's now-empty
    // remainder as blank, wrongly closing an open `generic` state.
    sameDepthLines.push({
      content: parseListItemMatch(parsed.content)?.content ?? parsed.content,
      isBlank: parsed.content.trim() === '',
    });
    lineStart = findPreviousLineStart(text, lineStart);
  }
  sameDepthLines.reverse();

  let state: HtmlBlockScanState = { type: 'none' };
  for (const { content, isBlank } of sameDepthLines) {
    if (state.type === 'raw-text') {
      if (HTML_RAW_TEXT_TAG_CLOSE_PATTERNS[state.tag].test(content)) {
        state = { type: 'none' };
      }
      continue;
    }
    if (state.type === 'special') {
      if (content.includes(state.closeToken)) {
        state = { type: 'none' };
      }
      continue;
    }
    if (state.type === 'generic') {
      if (isBlank) {
        state = { type: 'none' };
      }
      continue;
    }
    if (isBlank) {
      continue;
    }
    const openTag = rawTextOpenTag(content);
    if (openTag !== null) {
      if (!HTML_RAW_TEXT_TAG_CLOSE_PATTERNS[openTag].test(content)) {
        state = { type: 'raw-text', tag: openTag };
      }
      continue;
    }
    const closeToken = specialHtmlBlockCloseToken(content);
    if (closeToken !== null) {
      if (!isSelfClosedSpecialHtmlBlock(content)) {
        state = { type: 'special', closeToken };
      }
      continue;
    }
    if (
      !isHtmlClosingSyntax(content) &&
      (MARKDOWN_HTML_BLOCK_START_PATTERN.test(content) ||
        MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(content))
    ) {
      state = { type: 'generic' };
    }
  }
  return state.type !== 'none';
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
 * The narrowest possible list-item content indent: a one-character marker
 * (`-`, `+`, `*`) plus its one required separating space. Every genuine
 * list-item opener requires at least this much indentation on any
 * continuation line, regardless of the marker actually in play (a wider
 * marker, e.g. `10. `, only requires more) -- see {@link parseListItemContainer}.
 */
const MINIMUM_LIST_CONTENT_INDENT = 2;

/**
 * Forward-tracked counterpart of {@link findEnclosingListContentZone}'s
 * backward scan: the active list-item content indent as of the most
 * recently advanced line, threaded by {@link blankFencedCodeBlocks} and
 * {@link findFencedCodeRanges} into their own opener-detection
 * {@link parseFencedLine} call the same way {@link findIndentedCodeRanges}
 * already threads its own `activeListContentIndent` local. A per-call
 * backward scan re-walks from scratch every time; this tracker instead
 * carries the already-known state forward at O(1) per line -- the fix for
 * the O(n^2) blowup a backward scan produces on a long run of
 * fence-shaped indented lines with no enclosing list (measured: ~5.6s at
 * 8000 lines before this tracker). An earlier mitigation attempt in the
 * same PR #1901 review round added a cheap shape pre-check ahead of the
 * backward scan (Copilot review finding), which only bounded *how often*
 * the scan ran, not its *cost per call*, so it never closed the gap; this
 * tracker replaces both the scan and that pre-check.
 */
type ListContentIndentTrackerState = {
  contentIndent: number | null;
  containerDepth: number | null;
  blankLines: number;
};

function createListContentIndentTrackerState(): ListContentIndentTrackerState {
  return { contentIndent: null, containerDepth: null, blankLines: 0 };
}

/**
 * First half of advancing `state` for the current line, in place -- every
 * reason `state.contentIndent` can drop out from *under* the current line
 * (container-depth mismatch, an indentation drop below the active indent, or
 * a second consecutive blank line). Mirrors the reset half of
 * {@link findIndentedCodeRanges}'s own `activeListContentIndent` bookkeeping.
 * Call this **before** reading `state.contentIndent` as the current line's
 * `openerListContentIndent` -- {@link findIndentedCodeRanges} applies this
 * same reset (its inline equivalent) ahead of its own opener-detection
 * `parseFencedLine` call, so a line whose own indentation no longer
 * qualifies (e.g. a top-level fence following an unrelated list, separated
 * only by one blank line) must not inherit a stale indent left over from
 * that earlier list -- doing so was a real, verified regression (a
 * top-level fence's own content misread as still inside that list, closing
 * the fence one line early). {@link adoptListContentIndentForLine} is the
 * second half, called after.
 */
function resetListContentIndentTrackerForLine(
  state: ListContentIndentTrackerState,
  parsed: ContainerLine,
  isBlank: boolean,
): void {
  if (
    state.contentIndent !== null &&
    parsed.containerDepth !== state.containerDepth
  ) {
    state.contentIndent = null;
    state.containerDepth = null;
    state.blankLines = 0;
    return;
  }
  if (
    !isBlank &&
    parsed.listContentIndent === null &&
    state.contentIndent !== null &&
    indentationColumns(parsed.content) < state.contentIndent
  ) {
    state.contentIndent = null;
    state.containerDepth = null;
    state.blankLines = 0;
    return;
  }
  if (state.contentIndent !== null) {
    if (isBlank) {
      state.blankLines += 1;
      if (state.blankLines >= 2) {
        state.contentIndent = null;
        state.containerDepth = null;
      }
    } else {
      state.blankLines = 0;
    }
  }
}

/**
 * Second half of advancing `state` for the current line, in place -- adopts
 * a freshly seen list item's content indent. Gated on
 * {@link isInterruptingListMarker} via {@link interruptingListContentIndent}
 * -- the same paragraph-interruption-blind predicate
 * {@link findEnclosingListContentZone} (the backward scan this tracker
 * replaces at these two call sites) applies via its own
 * `interruptingListContentIndent` call, restoring parity with it rather than
 * {@link findIndentedCodeRanges}'s own richer, context-sensitive
 * `isNonInterruptingListItem` refinement (which additionally excludes an
 * empty-content or non-`1.`-numbered marker immediately continuing a
 * paragraph -- context {@link blankFencedCodeBlocks}/
 * {@link findFencedCodeRanges} do not track: `previousLineBlank` /
 * `previousLineBlockBoundary` / `previousContainerDepth`). An earlier
 * version adopted any `parsed.listContentIndent`, unfiltered -- confirmed
 * wrong: `2.    fenced item marker` immediately after an ordinary paragraph
 * line (no blank line between) does not start a list per CommonMark (a
 * non-`1.` ordered marker never interrupts a paragraph), so content after a
 * fence-shaped line at its indent must stay masked as ordinary paragraph
 * text, not read as list-driven fenced code -- the unfiltered version
 * wrongly did the latter, silently hiding real content
 * (fail-open, worse than a missed fence, which merely leaves content
 * unmasked). Call this **after** reading `state.contentIndent` as the
 * current line's `openerListContentIndent` (see
 * {@link resetListContentIndentTrackerForLine} for why the ordering
 * matters) and only while not already inside an open fence -- an open
 * fence's own `fence.listContentIndent` applies directly instead, mirroring
 * {@link findIndentedCodeRanges}'s `rangeStart === null` gate on its
 * equivalent update.
 */
function adoptListContentIndentForLine(
  state: ListContentIndentTrackerState,
  parsed: ContainerLine,
): void {
  const contentIndent = interruptingListContentIndent(parsed.content);
  if (contentIndent !== null) {
    state.contentIndent = contentIndent;
    state.containerDepth = parsed.containerDepth;
    state.blankLines = 0;
  }
}

/**
 * A list-item content zone: the indent required for a line to continue it,
 * paired with its opener's own line start (since #1902's review -- used to
 * bound {@link isWithinOpenHtmlBlock}'s backward scan so it cannot reach
 * past this opener into an earlier, unrelated sibling item's content).
 */
type ListContentZone = { contentIndent: number; openerLineStart: number };

/**
 * Determine the active list-item content zone enclosing `openingLineStart`,
 * if any -- the list-continuation counterpart, for
 * {@link findMarkdownBlockBoundary}'s opening line, of
 * {@link isWithinOpenHtmlBlock}'s own backward scan for open HTML blocks.
 * Returns `null` when `openingLineStart` is not inside an active list
 * item's content zone at `containerDepth`.
 *
 * Phase 1 scans backward for the nearest same-depth list-item opener,
 * bounded only by a container-depth mismatch or a non-blank line whose
 * indentation falls below {@link MINIMUM_LIST_CONTENT_INDENT} (which can
 * never continue *any* list's content zone, regardless of marker width) --
 * deliberately not by whether an intermediate line merely *looks like* a
 * fresh block start (heading/HTML/fence): such a line can still
 * legitimately sit inside an already-open list item's content zone (the
 * forward tracker in {@link findIndentedCodeRanges} only ends list state on
 * an indentation drop or two consecutive blank lines, never on a line's
 * shape), so aborting on shape alone produced false negatives -- Copilot
 * review finding on #1894's PR. Phase 2 below is what actually verifies
 * continuation, with the discovered opener's real indent, not Phase 1.
 *
 * Phase 2 verifies every line from that opener through `openingLineStart`
 * itself continues the list per {@link continuesListContainer}, with the
 * same two-consecutive-blank-line cutoff {@link findIndentedCodeRanges}
 * applies (CommonMark ends a list after two blank lines in a row) -- the
 * opening line must satisfy this too, not only the lines between it and
 * the opener, or a call whose opening line has nothing to do with an
 * earlier, unrelated list (separated only by a single blank line) would
 * wrongly inherit that list's indent.
 */
function findEnclosingListContentZone(
  text: string,
  openingLineStart: number,
  containerDepth: number,
): ListContentZone | null {
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
    if (indentationColumns(parsed.content) < MINIMUM_LIST_CONTENT_INDENT) {
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
  return { contentIndent: openerContentIndent, openerLineStart };
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
  // List-content-indent tracking (#1894): when the opening line is itself a
  // genuine list-item opener, its own indent applies directly; otherwise a
  // bounded backward/forward scan checks whether it continues an earlier
  // list item's content zone. A later line that no longer continues that
  // zone is a genuine block boundary, mirroring the listContentIndent /
  // continuesListContainer pairing findIndentedCodeRanges and
  // blankFencedCodeBlocks already use -- unless it is itself a lazy
  // continuation of the opening paragraph (below), the list counterpart of
  // isLazyQuoteContinuation. Computed before openingIsParagraph, which
  // needs it to decide whether the (more expensive) backward HTML-block
  // scan below is worth running at all.
  const openingOwnListIndent = interruptingListContentIndent(
    openingParsed.content,
  );
  const openingEnclosingListZone =
    openingOwnListIndent === null
      ? findEnclosingListContentZone(
          text,
          openingLineStart,
          openingContainerDepth,
        )
      : null;
  const openingListContentIndent =
    openingOwnListIndent ?? openingEnclosingListZone?.contentIndent ?? null;
  // PR #1902 review finding: isWithinOpenHtmlBlock's backward scan has no
  // concept of a list-item boundary -- it walks backward purely by
  // same-containerDepth lines -- so, unbounded, it can reach past a
  // genuine sibling list-item opener into an earlier, unrelated item's own
  // open HTML block. Resolve the same "ignoring this line's own apparent
  // marker" zone lookup #1894's own boundary check already uses, reusing
  // the one just computed above when possible, to bound the scan at that
  // zone's own opener line (or at the opening line itself, when no such
  // zone reaches it -- a genuinely unreachable fresh sibling). Only
  // computed when there is an active list zone at all (`openingListContentIndent
  // !== null`); the pure-blockquote case (no list zone) stays unbounded,
  // matching the pre-#1896 CommonMark-correct reachability across
  // shape-only lines that has no sibling-item concept to bound against.
  const openingHtmlScanBoundZone =
    openingListContentIndent === null
      ? null
      : openingOwnListIndent === null
        ? openingEnclosingListZone
        : findEnclosingListContentZone(
            text,
            openingLineStart,
            openingContainerDepth,
          );
  const openingHtmlScanBound =
    openingListContentIndent === null
      ? undefined
      : (openingHtmlScanBoundZone?.openerLineStart ?? openingLineStart);
  // Its backward scan only needs to run when it could actually change the
  // outcome below: not just the laziness exception (quote laziness
  // requires openingContainerDepth > 0, list laziness requires an active
  // list zone) but, since #1896, also the unconditional early-return
  // boundary a few lines down -- both share the same precondition, so one
  // guard covers both consumers. Skip the scan entirely otherwise (Copilot
  // review finding on #1894's PR: calling it unconditionally cost
  // avoidable backward-scan work on every inline-code opening backtick, the
  // common case being neither a blockquote nor an active list zone).
  const openingIsWithinHtmlBlock =
    (openingContainerDepth > 0 || openingListContentIndent !== null) &&
    isWithinOpenHtmlBlock(
      text,
      openingLineStart,
      openingContainerDepth,
      openingHtmlScanBound,
    );
  // The opening line's own content merely *matching* a list-item marker
  // pattern (`openingListItem !== null`) does not by itself prove it is a
  // genuine, structurally fresh sibling block. If it is still within reach
  // of an EARLIER, OUTER list item's content zone -- the same
  // `openingHtmlScanBoundZone` lookup already resolved above -- it is raw
  // or nested content still inside whatever that outer zone encloses (e.g.
  // a `<script>` body line that happens to start with `- `), not a block
  // boundary (PR #1902 review finding).
  const openingListOpenerStillWithinOuterZone =
    openingListItem !== null &&
    openingIsWithinHtmlBlock &&
    openingHtmlScanBoundZone !== null;
  // #1896: a still-open raw or custom HTML block enclosing the opening line
  // must prevent a code span from ever forming at all -- not merely gate a
  // later line's laziness exception (below), since CommonMark never runs
  // inline parsing inside such a block, at any container depth. Excluded
  // only when the opening line is a genuine fresh sibling list-item opener
  // (`openingListItem !== null` and, per the check above, not still within
  // an outer enclosing zone): a list marker starts a structurally new
  // block only when it is not itself raw/nested content the outer zone
  // already encloses -- otherwise treating isWithinOpenHtmlBlock's true
  // result as unconditional here would destroy a legitimate same-line span
  // genuinely opened by a fresh sibling list item right after an unclosed
  // tag in the previous one.
  if (
    openingIsWithinHtmlBlock &&
    (openingListItem === null || openingListOpenerStillWithinOuterZone)
  ) {
    return openingLineStart;
  }
  // #1894/#1896: openingIsParagraph now gates list-content-indent laziness
  // below too, not only isLazyQuoteContinuation (blockquote-only). CommonMark
  // laziness (omitting a container's own required indentation/markers on a
  // continuation line) only ever applies to an in-progress *paragraph*; a
  // still-open HTML block is a different block type with its own closing
  // rule, so it must not inherit laziness -- openingIsWithinHtmlBlock is
  // exactly the signal that tells the two apart. This is the residual case
  // where the early return above did not fire (the opening line is a
  // genuine fresh sibling list-item opener), so a still-open HTML block
  // from an earlier sibling can still suppress a *later* line's laziness
  // exception without destroying the opening line's own same-line span.
  const openingIsParagraph =
    !isMarkdownBlockStart(openingParagraphContent) &&
    !MARKDOWN_HTML_BLOCK_START_PATTERN.test(openingParagraphContent) &&
    !MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN.test(openingParagraphContent) &&
    (openingFence === null || !isValidFenceOpener(openingFence)) &&
    !openingIsWithinHtmlBlock;
  let lineStart = openingLine.next;

  while (lineStart < end) {
    const line = lineBounds(text, lineStart);
    const rawLine = text.slice(lineStart, line.end);
    const parsed = parseContainerLine(rawLine);
    // #1898 (partial): a fence marker indented to match a wide-padded list
    // item's content start (e.g. `-    ` giving indent 5) must still be
    // recognized as a fence opener here -- parseFencedLine's own regex only
    // permits 0-3 leading columns, so the active list-content indent has to
    // be stripped first, mirroring how blankFencedCodeBlocks/
    // findFencedCodeRanges thread listContentIndent for an already-open
    // fence's continuation/closing line. Only applies while this line still
    // shares the opening line's container depth -- the same precondition
    // failsListContinuation below already relies on for whether
    // openingListContentIndent still describes this line's zone.
    const activeListContentIndent =
      openingListContentIndent !== null &&
      parsed.containerDepth === openingContainerDepth
        ? openingListContentIndent
        : null;
    const fencedLine = parseFencedLine(rawLine, activeListContentIndent);
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

/**
 * Fenced code block ranges only (no inline spans, no indented code). Unlike
 * {@link findMarkdownCodeRanges}, this lets a caller mask example Markdown
 * syntax inside a fence (a quoted heading or bullet) while leaving inline
 * code spans intact for a scan that still needs them (e.g. suitability-triage
 * Check 7's `hasSubstantiveBullet`, #2589).
 */
export function findFencedCodeRanges(text: string): MarkdownCodeRange[] {
  const ranges: MarkdownCodeRange[] = [];
  let fence: {
    char: string;
    length: number;
    start: number;
    containerDepth: number;
    listContentIndent: number | null;
  } | null = null;
  const listTracker = createListContentIndentTrackerState();
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
    const isBlank = containerLine.content.trim() === '';

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

    const fenceWasOpen = fence !== null;
    if (!fenceWasOpen) {
      resetListContentIndentTrackerForLine(listTracker, containerLine, isBlank);
    }
    const openerListContentIndent: number | null = fence
      ? fence.listContentIndent
      : listTracker.contentIndent;
    const match = parseFencedLine(
      line,
      openerListContentIndent,
      fence !== null,
    );
    if (!fenceWasOpen) {
      adoptListContentIndentForLine(listTracker, containerLine);
    }

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
            listContentIndent:
              openerListContentIndent ?? match.listContentIndent,
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
        const fencedLine = parseFencedLine(rawLine, activeListContentIndent);
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
