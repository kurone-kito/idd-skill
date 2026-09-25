// idd-generated-from: src/scripts/markdown-code.mts
//
// The scripts/markdown-code.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
/**
 * Strip Markdown code regions (fenced blocks and inline code spans) from a
 * body before scanning it for machine-readable markers or dependency
 * references. A genuine marker is raw text GitHub renders as intended (an
 * HTML comment it hides, or a `Blocked by #N` line it links), never inside a
 * code span or fence, so an example an issue merely *quotes* in code (e.g.
 * an issue about the marker or dependency syntax) must not be read as real.
 * HTML comments are deliberately NOT stripped here — only code regions are,
 * since some markers are themselves HTML comments. Masked regions keep
 * their line count and surrounding text so a real marker elsewhere in the
 * body still matches.
 *
 * **Issue-body scanners: use {@link maskMarkdownForScan} instead (#3281).**
 * This module's original scan (fenced blocks + inline spans only) misses a
 * top-level indented (4-space) code block entirely, which a naive caller
 * can misread as real content. `stripMarkdownCodeRegions` remains the
 * primitive for PR-review and comment-body scanning
 * (`review-clause.mts`, `supersession-detection.mts`, and
 * `audit-authored-issue.mts`'s own comment-body checks), where that
 * narrower scope is still correct today.
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
    const openerListContentIndent = fence
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
export function stripMarkdownCodeRegions(text) {
  // Inline code spans: mask the inner content so a quoted marker no longer
  // matches, keeping the backticks and surrounding text.
  return blankFencedCodeBlocks(text).replace(
    INLINE_CODE_SPAN_PATTERN,
    (_match, ticks, inner) =>
      `${ticks}${inner.replace(/[^\r\n]/g, ' ')}${ticks}`,
  );
}
/**
 * True when the character at `index` is escaped by an odd-length run of
 * backslashes immediately before it. Despite the name, this counts
 * backslashes only -- it never inspects `text[index]` itself -- so it is
 * equally valid for a backtick (its original use), a link-text bracket, or
 * an HTML tag's opening `<` (#2865): `\<span title="` and `\[test](` are
 * both ordinary escaped-punctuation text per CommonMark, not the start of
 * raw HTML or a real link.
 */
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
const MARKDOWN_BLOCK_CONTENT_PATTERN =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:[-+*])[ \t]+|1[.)][ \t]+|(?:-{1,}|={1,}|_{3,}|\*{3,})[ \t]*$)/u;
const MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:-{1,}|={1,}|_{3,}|\*{3,})[ \t]*$)/u;
/**
 * A tightly-packed `=`-run (any length) or a short `-`-run (1-2 dashes,
 * too few to also qualify as a thematic break) -- the two
 * {@link MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN} shapes that are
 * genuinely ambiguous rather than self-contained. An ATX heading always
 * ends its own block on its own line, and a run of 3+ `-`/`_`/`*`
 * characters is always ALSO a valid thematic break (CommonMark resolves
 * that overlap in favor of whichever reading applies -- Setext heading
 * when a paragraph precedes it, thematic break otherwise -- but either
 * way the line ends its own block, so no context check is needed there).
 * A bare `=`-run can never be a thematic break at all, and a 1-2-dash run
 * is too short for one either: both are ONLY a genuine Setext heading
 * underline when a paragraph is actually open before them to close.
 * With nothing open before it, the line is ordinary paragraph text
 * instead, which does NOT end its own block (Codex review, PR #2840,
 * round 26, databaseId 3976819197): `gh api /markdown` confirms a
 * standalone `===` with no preceding paragraph text renders as its own
 * open paragraph, so a following custom tag with no blank line before it
 * lazily continues that paragraph as literal text, never opening a
 * type-7 HTML block -- masking a real, later Acceptance-criteria or
 * Candidate-files section through the next blank line or EOF, exactly
 * because the previous code treated *any* dash/equals run as always
 * ending its own block regardless of what (if anything) preceded it.
 */
const MARKDOWN_AMBIGUOUS_SETEXT_ONLY_PATTERN =
  /^ {0,3}(?:={1,}|-{1,2})[ \t]*$/u;
const MARKDOWN_HTML_BLOCK_START_PATTERN =
  /^ {0,3}(?:<!--|<\?|<![A-Z]|<!\[CDATA\[|<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|ol|p|pre|script|section|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \t]|\/?>|$))/iu;
const MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN =
  /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^<>]*?)?[ \t]*\/?>/u;
/**
 * Stricter, line-consuming variant of
 * {@link MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN}, used only by
 * {@link findHtmlBlockRanges}'s own custom-tag opener test (Codex review,
 * PR #2840, round 18). CommonMark's real type-7 rule requires the
 * complete tag to be followed only by whitespace through end of line --
 * `<span>intro</span>` entirely on one line is an ordinary paragraph
 * (`</span>` follows the open tag, not whitespace/EOL), never an HTML
 * block opener, but the shared prefix-only pattern (built for a laxer
 * "does this line START with something tag-shaped" question, still
 * correct for its own three call sites -- {@link isWithinOpenHtmlBlock},
 * {@link findMarkdownBlockBoundary}'s two uses -- which ask a different
 * question this stricter anchor would not improve) matched it anyway,
 * over-masking real Acceptance-criteria/Candidate-files content on a
 * following, non-blank-line-separated line. `gh api /markdown` confirms
 * the paragraph-then-heading rendering. Scoped to this one call site
 * rather than tightening the shared pattern itself.
 */
const MARKDOWN_CUSTOM_HTML_BLOCK_START_LINE_PATTERN =
  /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^<>]*?)?[ \t]*\/?>[ \t]*$/u;
// CommonMark §4.1: a thematic break is 3+ matching -, _, or * characters,
// each optionally followed by spaces/tabs -- interior spacing is allowed
// (e.g. `_ _ _`), unlike the tightly-packed run already covered above.
const MARKDOWN_THEMATIC_BREAK_PATTERN =
  /^ {0,3}([-_*])(?:[ \t]*\1){2,}[ \t]*$/u;
const HTML_RAW_TEXT_TAG_OPEN_PATTERN =
  /^ {0,3}<(script|pre|style|textarea)\b/iu;
// Codex review, PR #2840 (round 23): requires the literal closing `>`
// (with only optional horizontal whitespace before it), not just a `\b`
// word boundary after the tag name -- `</pre bogus` satisfies `\b` (a
// boundary exists between "pre" and the space) but is not a real closing
// tag at all. CommonMark does not close the raw-text block there, so the
// block (and any fake Acceptance-criteria/Candidate-files content inside
// it) extends to a real close or end of text, verified via `gh api
// /markdown`; the unanchored `\b` version wrongly ended the block early,
// exposing that still-opaque content as if it were real, visible text.
const HTML_RAW_TEXT_TAG_CLOSE_PATTERNS = {
  script: /<\/script[ \t]*>/iu,
  pre: /<\/pre[ \t]*>/iu,
  style: /<\/style[ \t]*>/iu,
  textarea: /<\/textarea[ \t]*>/iu,
};
/**
 * The raw-text tag that `content` opens (one of {@link HtmlRawTextTag}'s
 * four members), lower-cased for use as a
 * {@link HTML_RAW_TEXT_TAG_CLOSE_PATTERNS} key, or `null` when `content`
 * does not open a raw-text element.
 */
function rawTextOpenTag(content) {
  const match = HTML_RAW_TEXT_TAG_OPEN_PATTERN.exec(content);
  return match === null ? null : match[1].toLowerCase();
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
function isMarkdownBlockStart(content) {
  return (
    MARKDOWN_BLOCK_CONTENT_PATTERN.test(content) ||
    MARKDOWN_THEMATIC_BREAK_PATTERN.test(content)
  );
}
/** True when `content` opens with an HTML closing-tag slash (`</tag>`). */
function isHtmlClosingSyntax(content) {
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
function specialHtmlBlockCloseToken(content) {
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
function isSelfClosedSpecialHtmlBlock(content) {
  const closeToken = specialHtmlBlockCloseToken(content);
  return closeToken !== null && content.includes(closeToken);
}
function lineBounds(text, lineStart) {
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
function findPreviousLineStart(text, lineStart) {
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
  text,
  openingLineStart,
  containerDepth,
  earliestLineStart,
) {
  const sameDepthLines = [];
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
  let state = { type: 'none' };
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
 * such a marker must never anchor list-content-indent tracking. Exported
 * for `verify-import-mirror.mts`'s rule 3 (issue #3233): a
 * {@link parseListItemMatch} hit on a line that continues an
 * already-open PLAIN PARAGRAPH (not already inside a list item) is only a
 * genuine block boundary when the marker actually satisfies this same
 * CommonMark restriction -- otherwise a non-"1" ordered marker like `5.`
 * appearing mid-paragraph would be misread as a fresh list item instead
 * of ordinary continuation text.
 */
export function isInterruptingListMarker(marker) {
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
function interruptingListContentIndent(content) {
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
function createListContentIndentTrackerState() {
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
function resetListContentIndentTrackerForLine(state, parsed, isBlank) {
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
function adoptListContentIndentForLine(state, parsed) {
  const contentIndent = interruptingListContentIndent(parsed.content);
  if (contentIndent !== null) {
    state.contentIndent = contentIndent;
    state.containerDepth = parsed.containerDepth;
    state.blankLines = 0;
  }
}
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
function findEnclosingListContentZone(text, openingLineStart, containerDepth) {
  let openerLineStart = null;
  let openerContentIndent = null;
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
function findMarkdownBlockBoundary(text, start, end) {
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
function countBackticks(text, start, end) {
  let cursor = start;
  while (cursor < end && text[cursor] === '`') {
    cursor += 1;
  }
  return cursor - start;
}
const LIST_ITEM_PATTERN = /^([ \t]{0,3})([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/u;
/**
 * Exported for `verify-import-mirror.mts`'s rule 3 (issue #3233), which
 * needs each side of a list-item-boundary comparison expressed in the
 * same column units this module's own container/list-depth tracking
 * already uses internally (tabs expand to the next 4-column stop, matching
 * every other indentation computation in this file).
 */
export function indentationColumns(text, initialColumns = 0) {
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
/**
 * Non-`null` iff `content` opens MARKER-SHAPED syntax (`-`, `+`, `*`, or
 * an ordered `N.`/`N)` marker) at 0-3 leading columns, followed by
 * required separating whitespace and item content -- the same shape this
 * module's own container/list-depth tracking already relies on
 * internally. Deliberately permissive on the marker's own number/char:
 * this predicate answers only "does this line's own syntax LOOK like a
 * list-item opener," not "can it actually interrupt an already-open
 * paragraph" -- {@link isInterruptingListMarker} is the separate,
 * narrower check for that (Copilot review, PR #3417): a non-`null`
 * result here still includes `5. text` and other non-`1` ordered markers
 * that cannot interrupt a paragraph per CommonMark, so a caller that
 * needs the interruption distinction must apply that check itself
 * rather than assuming a match here already implies it.
 *
 * Exported for `verify-import-mirror.mts`'s rule 3 (issue #3233): a
 * list-item boundary is significant Markdown block structure, not the
 * kind of incidental whitespace rule 3's prose-reflow tolerance already
 * collapses -- reusing this already-reviewed per-line detector avoids
 * hand-rolling a second, narrower block parser there. Deliberately does
 * not resolve a NESTED item's own list-content zone the way
 * {@link findEnclosingListContentZone} does (that scan answers a
 * different question -- whether a LATER line still continues an EARLIER
 * opener -- not "what does this line's own raw indentation look like"):
 * a marker nested 4+ raw columns deep (a third list level, or a wide
 * marker's own continuation) is not distinguished from ordinary wrapped
 * prose by this shallow, per-line check alone. See the caller's own doc
 * comment for how it discloses that limitation.
 */
export function parseListItemMatch(content) {
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
/**
 * Exported for `verify-import-mirror.mts`'s rule 3 (issue #3233), which
 * needs the same content-indent computation this module's own
 * list-content-indent tracking already uses internally, rather than a
 * hand-derived approximation: an earlier version of that caller assumed
 * a marker's separating whitespace is always exactly one column, which
 * disagrees with this function's own CommonMark-correct handling of 2-4
 * separating spaces (`5+` collapses to one column of padding) -- a
 * marker like `5.` indented 3 columns under a `1.  ` opener (two
 * separating spaces, real content-indent 4) was wrongly read as still
 * inside that item's zone under the 1-column assumption, when it is
 * actually outside it (Copilot review, PR #3417; verified via `gh api
 * /markdown`).
 */
export function parseListItemContainer(content) {
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
function parseContainerLine(line) {
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
function stripContainerPrefixes(line, depth) {
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
function stripListItemMarker(content) {
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
function continuesListContainer(content, contentIndent) {
  return content.trim() === '' || indentationColumns(content) >= contentIndent;
}
function stripLeadingIndentColumns(text, targetColumns, initialColumns = 0) {
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
  line,
  activeListContentIndent = null,
  fenceIsOpen = false,
) {
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
function isValidFenceOpener(fence) {
  return fence.marker[0] !== '`' || !fence.info.includes('`');
}
/**
 * Raw HTML block ranges (CommonMark block types 1-7): a `<script>`/`<pre>`/
 * `<style>`/`<textarea>` raw-text element (closes only at its own matching
 * closing tag, #1900's four-way tag matching reused via
 * {@link rawTextOpenTag}/{@link HTML_RAW_TEXT_TAG_CLOSE_PATTERNS}); a
 * comment/processing-instruction/declaration/CDATA "special" block (closes
 * at its own token, {@link specialHtmlBlockCloseToken}, same-line self-close
 * via {@link isSelfClosedSpecialHtmlBlock}); or a generic block-level tag
 * (`<div>`, `<pre>`... as a *block* line, `<table>`, etc. --
 * {@link MARKDOWN_HTML_BLOCK_START_PATTERN}) or a lone custom tag
 * ({@link MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN}, which per CommonMark
 * cannot interrupt a paragraph, so it only opens a block when the preceding
 * line is blank or this is the first line of `text`) -- both closing at the
 * next blank line or end of text. No general container/list-depth
 * *tracking* (state threaded across unrelated lines) -- matches
 * {@link findHtmlCommentRanges}'s existing scope choice for this same
 * "mask untrusted issue-body text" purpose, unlike
 * {@link isWithinOpenHtmlBlock}'s more elaborate container-aware
 * backward/forward scan built for a different question (is a specific
 * later code span destroyed by an enclosing block). Each opener's own
 * close-scan is still bounded by that opener's own container, derived
 * directly from its own line (round 15 below) -- a narrower, cheaper
 * question than full cross-line tracking.
 *
 * Codex review, PR #2840: an issue can place example Markdown (a fake
 * `## Acceptance criteria` heading plus a checklist, or a fake
 * `## Candidate files` entry) inside a raw HTML block such as `<pre>`,
 * which GitHub renders as literal/opaque content, not Markdown structure --
 * neither {@link findFencedCodeRanges}, {@link findIndentedCodeRanges}, nor
 * {@link findHtmlCommentRanges} masked that shape.
 *
 * Opener detection strips a container prefix first (Codex review, PR
 * #2840, round 11): `- <pre>` (an HTML block opener as a list item's own
 * first line) or `> <pre>` (inside a blockquote) previously tested the
 * *unstripped* line against every opener pattern below, all of which are
 * anchored at `^ {0,3}<`, so the leading marker made every one of them
 * miss -- the block's opaque content stayed fully unmasked, letting a
 * fake heading/checklist/candidate-path inside it satisfy a structural
 * signal GitHub itself never renders as real structure. Reuses
 * {@link parseContainerLine} (blockquote `>` stripping) and
 * {@link stripListItemMarker} (list-marker stripping) -- the same helpers
 * {@link findMarkdownBlockBoundary} already uses for this exact
 * "container-prefix-aware opener" question -- rather than inventing new
 * machinery.
 *
 * Every close/end scan (a raw-text tag's own closing tag, a special
 * block's close token, a generic block's next blank line) additionally
 * stops at the opener's own enclosing container boundary (Codex review,
 * PR #2840, round 15; {@link isHtmlBlockContainerEnded}): an unclosed
 * raw-text/special block that opens inside a blockquote or list item
 * (`> <pre>` with no matching `</pre>` anywhere in `text`) previously
 * scanned all the way to a real closing tag or end of text, masking any
 * genuine Acceptance-criteria/Candidate-files content that renders
 * *outside* the block once its enclosing container itself ends --
 * `gh api /markdown` confirms GitHub closes an unclosed HTML block at
 * its container's own end, never leaking past it.
 *
 * A custom-tag opener (`MARKDOWN_CUSTOM_HTML_BLOCK_START_PATTERN`, which
 * per CommonMark cannot interrupt a paragraph) is additionally eligible
 * when this line opens a *fresh* list item container (Codex review, PR
 * #2840, round 13): `stripListItemMarker` strips a marker only when one
 * is present, so `content !== containerContent` means this line is a
 * list item's own first line, which has no "previous line" inside that
 * new container for the interruption rule to apply to -- the same
 * reasoning `noOpenParagraph` already covers for the top-level case.
 *
 * `fencedRanges` (Codex review, PR #2840, round 14; same
 * caller-supplied-ranges convention {@link findIndentedCodeRanges} already
 * uses for the identical purpose) lets a caller exclude fenced-code-block
 * content from opener/closer detection: an unclosed raw-text tag such as
 * `<pre>` *inside* a fenced example is literal example text, not a real
 * HTML block opener, but a scan of the raw line text alone cannot tell the
 * difference -- without this, that literal `<pre>` opened a raw-text block
 * with no real closing tag anywhere in `text`, extending the returned
 * range through the remainder of the body and masking any genuine
 * Acceptance-criteria/Candidate-files content after the fence. Must be in
 * ascending `start` order, as {@link findFencedCodeRanges} already returns.
 */
/**
 * True when `scanLine` -- a line reached while scanning forward for an
 * already-open HTML block's own close condition -- falls outside the
 * Markdown container the block's *opener* line itself opened in (Codex
 * review, PR #2840, round 15). Mirrors {@link findFencedCodeRanges}'s own
 * fence-close condition almost verbatim -- the identical question ("has
 * the enclosing blockquote/list-item container this opener line started
 * in already ended by this later line") reusing the same
 * {@link parseContainerLine}, {@link stripContainerPrefixes}, and
 * {@link continuesListContainer} helpers, just carried as a local
 * variable pair for one opener's own forward scan rather than threaded
 * cross-line tracker state: an HTML block's opener line always directly
 * names its own container context (the literal `<` character that opens
 * it), unlike a bare fence line that can silently inherit an earlier,
 * unmarked list's content-zone -- the harder problem
 * {@link createListContentIndentTrackerState} exists to solve -- so no
 * tracker is needed here.
 */
function isHtmlBlockContainerEnded(
  scanLine,
  openerContainerDepth,
  openerListContentIndent,
) {
  const containerLine = parseContainerLine(scanLine);
  if (
    openerContainerDepth > 0 &&
    containerLine.containerDepth < openerContainerDepth
  ) {
    return true;
  }
  if (openerListContentIndent !== null) {
    const listContinuationLine = stripContainerPrefixes(
      scanLine,
      openerContainerDepth,
    );
    if (
      !continuesListContainer(listContinuationLine, openerListContentIndent)
    ) {
      return true;
    }
  }
  return false;
}
// #2661 PR #2662 review round 6 (Codex): an issue-template author commonly
// leaves hidden instructional scaffolding as an HTML comment -- e.g.
// `<!-- Maintainer decision (Groom hearing, YYYY-MM-DD): <resolution text>
// -->` -- invisible in the rendered issue but still present in a
// code-masked body (Markdown code masking does not touch HTML comments).
// Masked the same way as inline/fenced code, before the inline-decision
// pattern scan. An unterminated `<!--` (no matching `-->`) extends to
// end-of-body: CommonMark renders such an HTML block through EOF, so the
// entire remaining body -- a genuine marker and Acceptance Criteria
// included -- can be invisible in the rendered issue while still matching
// this scan if left unmasked (round 7, PR #2662).
//
// #2711: an issue that documents this convention's own syntax inside a
// fenced code example -- e.g. a fence containing a literal, deliberately
// unterminated `<!--` to illustrate the shape -- must not have that
// example's opener treated as a REAL unterminated comment: doing so masks
// through EOF and swallows a genuine later "Maintainer decision (...)"
// that follows the fence. The same applies to an INLINE code span
// demonstrating the same syntax (PR #2735 Codex review round 2) -- e.g.
// `` `<!--` `` followed by a later bullet naming the real artifact.
// `ignoredOpenerRanges` (optional, defaults to none so existing callers
// with no code content to worry about are unaffected) lets a caller
// exclude any `<!--` whose own opening `<` falls inside one of these
// ranges from consideration entirely; pass fenced + indented + inline
// ranges (e.g. `findMarkdownCodeRanges`'s result) to cover every code
// shape, not just fenced blocks.
//
// #2711 PR #2735 review round 5 (Codex): a backslash-escaped opener
// (`\<!--`) renders as a literal string in CommonMark, not a real HTML
// comment start -- an issue documenting the literal marker syntax (e.g.
// `Document the literal \<!-- marker`) must not have everything after it
// masked through EOF. A single preceding backslash is enough to treat it
// as escaped (soft heuristic, matching this file's existing style; does
// not attempt full backslash-run parity for a doubly-escaped `\\<!--`).
//
// Moved here from `resolved-decision.mts` (#3281): `maskMarkdownForScan`
// below needs to call this directly, and `resolved-decision.mts` already
// imports FROM this file, so the reverse direction would be circular.
// `resolved-decision.mts` re-exports this name so its own callers
// (`suitability-triage.mts`, `triage-structural-evidence.mts`) compile
// unchanged.
// #3282 Copilot review (PR #3413): an unterminated opener (no matching
// "-->" anywhere later in the text) only extends through end-of-text
// when it sits at a CommonMark HTML-block type-2 opening position --
// after stripping 0+ blockquote container markers (each an optional
// leading `>` with up to 3 spaces before it, mirroring
// parseContainerLine's own recognition rule) and, on the same line,
// optionally ONE list-item marker with its required spacing, nothing
// else precedes the "<!--" but at most 3 more leading spaces. This
// covers a bare line-start opener, one nested inside a blockquote
// (`> <!--`, `>> <!--`), a list item's own opening line (`- <!--`,
// `1) <!--`), and a combination (`> - <!--`) -- round 1 of this fix
// (Copilot review, same PR) only checked the raw physical line's own
// leading spaces, missing every container-nested case; `gh api
// markdown` confirms each of the shapes above still swallows the rest
// of the document exactly like a bare line-start opener. A "<!--"
// appearing anywhere else mid-line -- e.g. inside a Markdown link
// title's quoted text, `[x](url "<!-- still drafting")` -- is ordinary
// prose there: CommonMark's inline raw-HTML grammar for a comment
// requires BOTH delimiters, and this position never qualifies as an
// HTML block opener either, so GitHub renders it as literal text with
// no masking effect (reproduces tests/fixtures/issue-body-corpus/
// gap-2767-09.json's own body). Before the first #3282 fix, every
// mid-line unterminated opener -- container-nested or not -- was
// treated the same as a genuine line-start one, masking real content
// after it.
//
// CodeRabbit review, same PR, same round: a list marker's own required
// padding is bounded to 1-4 columns of indentation (CommonMark's list
// item rule 1; a bare tab counts as up to 4 columns via the usual
// tab-stop rule) -- five or more columns of padding is NOT "immediately
// after the marker" for block-opener purposes, it starts an indented
// code block nested inside the list item instead (confirmed via `gh
// api markdown`: "-     <!-- x" renders as a `<pre><code>` block
// _inside_ the `<li>`, with later content rendering as its own
// paragraph OUTSIDE the list, i.e. NOT swallowed). Reuses
// parseListItemContainer's own markerEndColumns/spacingColumns
// derivation so both call sites agree on the same boundary.
//
// Copilot review round 3, same PR: a list-item CONTINUATION line that
// carries no marker of its own and relies on an earlier line's
// inherited list-content indentation (e.g. `-    item` followed by a
// line indented to column 5 with no marker) is also a valid opener
// position -- `gh api markdown` confirms it still swallows the rest of
// the document. `lineListContentIndents`, precomputed once per
// {@link findHtmlCommentRanges} call via the same forward,
// per-line-only tracker helpers {@link findHtmlBlockRanges} uses
// ({@link createListContentIndentTrackerState},
// {@link resetListContentIndentTrackerForLine},
// {@link adoptListContentIndentForLine} -- see
// {@link computeLineListContentIndents}'s own doc comment for how it
// stays synchronized with that function's fence/HTML-block state
// too), supplies the inherited content indent applicable to the
// physical line containing `openIndex`, reset exactly as
// {@link findHtmlBlockRanges} resets it (container-depth mismatch, an
// indentation drop, or two consecutive blank lines). A continuation
// line qualifies when its own
// (blockquote-stripped) leading whitespace reaches that indent, plus
// at most 3 more columns -- the same "at most 3 leading spaces" rule a
// bare or list-opening line already applies past its own required
// prefix.
function isAtHtmlBlockOpenerPosition(text, openIndex, lineListContentIndents) {
  const lineStart = text.lastIndexOf('\n', openIndex - 1) + 1;
  const { content } = parseContainerLine(text.slice(lineStart, openIndex));
  if (/^ {0,3}$/.test(content)) {
    return true;
  }
  const listItem = parseListItemMatch(content);
  if (listItem !== null && listItem.content === '') {
    const markerEndColumns =
      indentationColumns(listItem.markerIndent) + listItem.marker.length;
    const spacingColumns =
      indentationColumns(listItem.spacing, markerEndColumns) - markerEndColumns;
    return spacingColumns <= 4;
  }
  const inheritedContentIndent = lineListContentIndents.get(lineStart);
  if (
    inheritedContentIndent === undefined ||
    inheritedContentIndent === null ||
    // Copilot review round 5, same PR: a continuation line's own
    // indentation is tab-aware (matching indentationColumns below, and
    // the tracker's own tab-stop-aware contentIndent derivation) -- a
    // whitespace-only check that rejected any tab, not just any
    // non-whitespace character, wrongly left "- item\n\t<!-- x"
    // unmasked even when the tab reaches the inherited content indent.
    /[^ \t]/.test(content)
  ) {
    return false;
  }
  const columns = indentationColumns(content) - inheritedContentIndent;
  return columns >= 0 && columns <= 3;
}
/**
 * Precomputes, for every physical line's start offset in `text`, the
 * list-content indent a continuation line at that offset would inherit
 * (or `null` when no list item's content zone is active there) --
 * {@link isAtHtmlBlockOpenerPosition}'s own per-call input, built once
 * up front rather than per `<!--` occurrence. A standalone forward pass
 * using only the list-content-indent tracker half of
 * {@link findHtmlBlockRanges}'s loop, with a lighter-weight opaque-range
 * freeze in place of that function's own fence/HTML-block/paragraph
 * bookkeeping (see the round 4 and round 6 notes below for exactly what
 * that freeze needs to cover, and why) -- this scan only ever reads
 * `lineTracker.contentIndent`, never any of the other state that
 * bookkeeping drives.
 *
 * Copilot review round 4, same PR: a fenced example's own content is
 * opaque to this tracker too, the same "frozen while inside a fence"
 * choice {@link findHtmlBlockRanges} and {@link blankFencedCodeBlocks}
 * both already make -- without it, a line inside a fence that merely
 * *looks* like a list marker (e.g. a fenced shell example's own
 * "- item" demonstration) could spuriously adopt a `contentIndent`,
 * and if the closing fence delimiter happens to be indented to that
 * same column, {@link resetListContentIndentTrackerForLine}'s own
 * indentation-drop check never fires to clear it (its guard is a
 * strict `<`, not `<=`) -- leaking that spurious indent past the fence
 * to a later, genuinely top-level line. `gh api markdown` confirms a
 * real case of this shape ("```\n- x\n  ```\n     <!-- trigger") does
 * NOT swallow the rest of the document (the "<!--" line renders as its
 * own indented code block, unrelated to any list), which the
 * unfrozen tracker wrongly masked. `fencedRanges` reuses
 * {@link findFencedCodeRanges}'s own opaque-content boundaries
 * ({@link findHtmlBlockRanges}'s identical `lineStart > start &&
 * lineStart < end` condition -- the fence's own opening line is real,
 * unfrozen content, but every line after it through the closing
 * delimiter, inclusive, is frozen).
 *
 * `fencedRanges` (Copilot review round 5, same PR): optional, so a
 * caller that already computed {@link findFencedCodeRanges} for its own
 * purposes -- {@link maskMarkdownForScan}, on the hot path of several
 * Discover/audit issue-body scanners, is the motivating case -- can pass
 * it straight through instead of this function silently repeating that
 * scan. Omitted (the default), it is computed here exactly as before.
 *
 * Copilot review round 6, same PR: a raw/generic HTML block's own
 * content (e.g. `<div>...`, ending at the next blank line) is opaque to
 * this tracker for the same reason a fence's content is -- it is never
 * parsed as Markdown, so a line inside it that merely *looks* like a
 * list marker must not update list-content-indent state either.
 * `opaqueRanges` merges `fencedRanges` with `htmlBlockRanges` (the
 * caller's own {@link findHtmlBlockRanges} result when it already has
 * one, or computed here otherwise) into one combined freeze set,
 * reusing the identical opaque-content condition above for both.
 */
function computeLineListContentIndents(
  text,
  fencedRanges = findFencedCodeRanges(text),
  htmlBlockRanges = findHtmlBlockRanges(text, fencedRanges),
) {
  const indents = new Map();
  const opaqueRanges = mergeMarkdownCodeRanges([
    ...fencedRanges,
    ...htmlBlockRanges,
  ]);
  let opaqueRangeIndex = 0;
  const listTracker = createListContentIndentTrackerState();
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf('\n', lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    while (
      opaqueRangeIndex < opaqueRanges.length &&
      lineStart >= (opaqueRanges[opaqueRangeIndex]?.end ?? text.length)
    ) {
      opaqueRangeIndex += 1;
    }
    const opaqueRange = opaqueRanges[opaqueRangeIndex];
    const isOpaqueContent =
      opaqueRange !== undefined &&
      lineStart > opaqueRange.start &&
      lineStart < opaqueRange.end;
    if (isOpaqueContent) {
      indents.set(lineStart, listTracker.contentIndent);
      if (newlineIndex === -1) {
        break;
      }
      lineStart = newlineIndex + 1;
      continue;
    }
    const containerLine = parseContainerLine(line);
    const isBlank = containerLine.content.trim() === '';
    resetListContentIndentTrackerForLine(listTracker, containerLine, isBlank);
    indents.set(lineStart, listTracker.contentIndent);
    adoptListContentIndentForLine(listTracker, containerLine);
    if (newlineIndex === -1) {
      break;
    }
    lineStart = newlineIndex + 1;
  }
  return indents;
}
export function findHtmlCommentRanges(
  text,
  ignoredOpenerRanges = [],
  // Copilot review round 5, same PR: optional, so a caller that already
  // has fenced ranges (see computeLineListContentIndents's own doc
  // comment) can pass them through rather than triggering a second
  // findFencedCodeRanges scan here.
  fencedRanges = findFencedCodeRanges(text),
  // Copilot review round 6, same PR: same reasoning, for a caller that
  // already has {@link findHtmlBlockRanges}'s own result (e.g.
  // {@link maskMarkdownForScan} when `htmlBlocks: 'mask'` is also
  // requested). Copilot review round 7, same PR: also read directly
  // below (not only threaded into computeLineListContentIndents) -- an
  // unterminated opener sitting anywhere inside an ALREADY-open
  // raw/generic HTML block (e.g. "<div><!-- trigger", the "<!--" not
  // itself at a fresh block-start position, but already inside the
  // "<div>" block's own extent) is real, opaque content per CommonMark
  // regardless of its own position, since that block's content is never
  // reparsed once open. `gh api markdown` confirms this exact shape
  // ("<div><!-- trigger\nAfter") swallows the rest of the document (an
  // empty "<div></div>" is all that renders); the position-only check
  // alone can never recognize this, since "<!--" here is not opening
  // anything of its own -- it is unrelated, already-covered content.
  htmlBlockRanges = findHtmlBlockRanges(text, fencedRanges),
) {
  const ranges = [];
  const lineListContentIndents = computeLineListContentIndents(
    text,
    fencedRanges,
    htmlBlockRanges,
  );
  const openPattern = /<!--/g;
  let openMatch = openPattern.exec(text);
  while (openMatch) {
    const openIndex = openMatch.index;
    const isEscaped = text[openIndex - 1] === '\\';
    const isIgnored =
      isEscaped ||
      ignoredOpenerRanges.some(
        (range) => openIndex >= range.start && openIndex < range.end,
      );
    if (isIgnored) {
      openPattern.lastIndex = openIndex + 4;
      openMatch = openPattern.exec(text);
      continue;
    }
    const closeIndex = text.indexOf('-->', openIndex + 4);
    const isInsideExistingHtmlBlock = htmlBlockRanges.some(
      (range) => range.start <= openIndex && openIndex < range.end,
    );
    if (
      closeIndex === -1 &&
      !isAtHtmlBlockOpenerPosition(text, openIndex, lineListContentIndents) &&
      !isInsideExistingHtmlBlock
    ) {
      openPattern.lastIndex = openIndex + 4;
      openMatch = openPattern.exec(text);
      continue;
    }
    const end = closeIndex === -1 ? text.length : closeIndex + 3;
    ranges.push({ start: openIndex, end });
    openPattern.lastIndex = end;
    openMatch = openPattern.exec(text);
  }
  return ranges;
}
export function findHtmlBlockRanges(text, fencedRanges = []) {
  const ranges = [];
  let lineStart = 0;
  // Despite reading like a literal "was the raw previous line blank"
  // flag, this tracks CommonMark's real type-7 (custom tag) gate: no
  // paragraph is currently open before the current line (Codex review,
  // PR #2840, round 16 -- renamed from `previousLineBlank` after finding
  // three places that name had led to the wrong value). A genuinely
  // blank line satisfies this, but so does any line right after a block
  // that just closed -- a self-closed raw-text tag, a closed fence, a
  // closed special/generic HTML block, or a block whose enclosing
  // container just ended -- none of those leave an open paragraph behind
  // either, `gh api /markdown` confirms a type-7 tag freely opens
  // immediately after any of them. Every block-closing exit below sets
  // this `true` for exactly that reason.
  let noOpenParagraph = true;
  let fencedRangeIndex = 0;
  // #2865: mirrors blankFencedCodeBlocks's/findFencedCodeRanges's own
  // inherited-list-content-indent tracker (see
  // {@link createListContentIndentTrackerState}) so a block opener line
  // with no list marker of its own (a continuation line of an
  // already-open list item, e.g. an indented `<pre>` two lines below a
  // `- Example:` bullet) still inherits that list's content indent
  // instead of always reading `null` -- see {@link
  // isHtmlBlockContainerEnded}'s call sites below for why an unfixed
  // `null` here let an unclosed block's forward scan run past the list's
  // real end, masking later genuine content.
  const listTracker = createListContentIndentTrackerState();
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
    // Content-based (blockquote-marker-stripped), matching
    // blankFencedCodeBlocks's own `isBlank` derivation -- a lone `>` line
    // (no content after the marker) is blank for list/blank-line-counting
    // purposes even though the raw line itself is not whitespace-only.
    const containerLine = parseContainerLine(line);
    const isBlank = containerLine.content.trim() === '';
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
      // A closed fence leaves no open paragraph behind either (Codex
      // review, PR #2840, round 16 -- corrects this round's own earlier
      // `false`): `gh api /markdown` confirms a type-7 tag right after a
      // closed fence, with no blank line between, still freely opens.
      // The list-content-indent tracker is deliberately left untouched
      // for opaque fence content, the same "frozen while inside a fence"
      // choice blankFencedCodeBlocks itself makes for its own local fence.
      noOpenParagraph = true;
      lineStart = lineAfter;
      if (newlineIndex === -1) {
        break;
      }
      continue;
    }
    // Runs for every non-opaque line (blank or not) ahead of the
    // per-branch dispatch below, so all four of that dispatch's own exits
    // (raw-text/special/generic block open, and the plain fallthrough)
    // see a tracker already advanced for *this* line -- reset (drop stale
    // state) before reading, then adopt (record this line's own opener,
    // if any) after, mirroring blankFencedCodeBlocks's identical
    // ordering.
    resetListContentIndentTrackerForLine(listTracker, containerLine, isBlank);
    const trackedListContentIndent = listTracker.contentIndent;
    adoptListContentIndentForLine(listTracker, containerLine);
    // Codex review, PR #2840 (round 20, widened round 22): does this
    // non-blank line, on its own, complete a one-line block that leaves
    // no paragraph open behind it -- an ATX heading or a thematic break
    // (never a list-item line, which both patterns below already
    // exclude: unlike those two, a list item's own content line can
    // still be, or start, an open paragraph within that item).
    // {@link MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN} only recognizes a
    // tightly-packed thematic break (`---`, `***`, `___`); a *spaced*
    // one (`_ _ _`) is CommonMark-valid too (only
    // {@link MARKDOWN_THEMATIC_BREAK_PATTERN} recognizes it) and ends
    // its own block exactly the same way -- `gh api /markdown` confirms
    // a custom tag right after `_ _ _`, no blank line between, still
    // freely opens. Tested against the blockquote-stripped
    // `containerContent` set below inside the `!isBlank` branch, never
    // the list-marker-stripped `content` (which would let a list item's
    // own text that merely *looks* heading-shaped after stripping
    // wrongly count). Read at the bottom fallback, the only place that
    // still needs it once every dedicated opener branch above has
    // already `continue`d past it.
    //
    // A bare `=`-run or a short 1-2-dash run is genuinely ambiguous,
    // though (Codex review, PR #2840, round 26, databaseId 3976819197):
    // {@link MARKDOWN_AMBIGUOUS_SETEXT_ONLY_PATTERN} only ends its own
    // block as a Setext heading underline when `noOpenParagraph` (still
    // holding its value from *before* this line, read here ahead of the
    // reassignment at this loop's own bottom) is false -- i.e. a
    // paragraph was genuinely open to close. With nothing open before
    // it, the line is ordinary paragraph text instead, which stays open
    // rather than ending its own block; see that pattern's own doc
    // comment for the masking bug this closes.
    let endsOwnBlock = false;
    if (!isBlank) {
      const openerLine = containerLine;
      const containerContent = openerLine.content;
      endsOwnBlock =
        (MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN.test(containerContent) &&
          (!MARKDOWN_AMBIGUOUS_SETEXT_ONLY_PATTERN.test(containerContent) ||
            !noOpenParagraph)) ||
        MARKDOWN_THEMATIC_BREAK_PATTERN.test(containerContent);
      const content = stripListItemMarker(containerContent);
      // Codex review, PR #2840 (round 13): `stripListItemMarker` returns
      // its input unchanged when the line has no list marker, so this
      // line's own first line of a *fresh* list item container -- CommonMark
      // 5.2 -- has no "previous line" within that container for the
      // paragraph-interruption rule to apply to, the same reason
      // `noOpenParagraph` already permits a custom-tag opener right
      // after a blank line.
      const opensFreshContainer = content !== containerContent;
      // Codex review, PR #2840 (round 15): this opener's own container
      // context, carried through its forward scan below via
      // {@link isHtmlBlockContainerEnded} -- see that function's doc
      // comment for why deriving it directly from this line (rather than
      // a cross-line tracker) is sufficient here.
      const openerContainerDepth = openerLine.containerDepth;
      // #2865: this opener line's own marker wins when present (no
      // regression to the pre-fix behavior); otherwise inherit the
      // tracker's carried indent from an earlier, still-open list item's
      // own opener -- the continuation-line case this fix adds.
      const openerListContentIndent =
        openerLine.listContentIndent ?? trackedListContentIndent;
      const rawTag = rawTextOpenTag(content);
      const closeToken = specialHtmlBlockCloseToken(content);
      const opensGeneric =
        rawTag === null &&
        closeToken === null &&
        (MARKDOWN_HTML_BLOCK_START_PATTERN.test(content) ||
          ((noOpenParagraph || opensFreshContainer) &&
            MARKDOWN_CUSTOM_HTML_BLOCK_START_LINE_PATTERN.test(content)));
      if (rawTag !== null) {
        // Copilot review, PR #2840 (round 8): a same-line self-closed
        // raw-text block (e.g. `<pre>- \`fake/path\`</pre>` entirely on
        // one line) was previously left out of both branches below
        // (`opensGeneric` is also false here, since `rawTag !== null`
        // excludes it) -- masking nothing for that line at all. Emit the
        // single-line range immediately in that case instead of scanning
        // forward for a close that already happened.
        const closePattern = HTML_RAW_TEXT_TAG_CLOSE_PATTERNS[rawTag];
        let end = lineEnd;
        // `resumeAt` (Codex review, PR #2840, round 16) is deliberately
        // separate from `end`: `end` is the masking boundary and must
        // stay *before* the line's own newline (downstream position-
        // preserving masking depends on that newline surviving), but
        // resuming the outer loop AT that same pre-newline position made
        // it re-process the bare newline character as its own spurious
        // one-character "blank line" next iteration -- Copilot review,
        // PR #2840, round 16. `resumeAt` always lands exactly on a real
        // line boundary instead.
        let resumeAt = lineAfter;
        if (!closePattern.test(line)) {
          let scanStart = lineAfter;
          end = text.length;
          resumeAt = text.length;
          while (scanStart <= text.length) {
            const nl = text.indexOf('\n', scanStart);
            const scanLineEnd = nl === -1 ? text.length : nl;
            const scanLineAfter = nl === -1 ? text.length : nl + 1;
            const scanLine = text.slice(scanStart, scanLineEnd);
            // Codex review, PR #2840 (round 15): stop at the opener's own
            // container boundary before testing for the real closing tag
            // -- once the enclosing blockquote/list-item container has
            // ended, a line past it is never part of this block, real
            // closing tag or not.
            if (
              isHtmlBlockContainerEnded(
                scanLine,
                openerContainerDepth,
                openerListContentIndent,
              )
            ) {
              end = scanStart;
              resumeAt = scanStart;
              break;
            }
            if (closePattern.test(scanLine)) {
              end = scanLineEnd;
              resumeAt = scanLineAfter;
              break;
            }
            if (nl === -1) {
              break;
            }
            scanStart = scanLineAfter;
          }
        }
        ranges.push({ start: lineStart, end });
        lineStart = resumeAt;
        // A closed raw-text block leaves no open paragraph behind either
        // (Codex review, PR #2840, round 16 -- corrects this branch's
        // pre-existing `false` from round 8): `gh api /markdown` confirms
        // a type-7 tag right after a self-closed, scan-closed, or
        // container-ended raw-text block still freely opens.
        noOpenParagraph = true;
        continue;
      }
      if (closeToken !== null) {
        // Same same-line rationale as the raw-text branch above (Copilot
        // review, PR #2840, round 8): a same-line self-closed special
        // block (e.g. `<!-- x -->`) is masked by findHtmlCommentRanges
        // separately for the `<!--` case, but `<?`/`<!X`/`<![CDATA[` had
        // no other masking and fell through unmasked here entirely.
        let end = lineEnd;
        // See the raw-text branch above for why `resumeAt` is tracked
        // separately from `end` (Codex review, PR #2840, round 16).
        let resumeAt = lineAfter;
        if (!isSelfClosedSpecialHtmlBlock(content)) {
          let scanStart = lineAfter;
          end = text.length;
          resumeAt = text.length;
          while (scanStart <= text.length) {
            const nl = text.indexOf('\n', scanStart);
            const scanLineEnd = nl === -1 ? text.length : nl;
            const scanLineAfter = nl === -1 ? text.length : nl + 1;
            const scanLine = text.slice(scanStart, scanLineEnd);
            if (
              isHtmlBlockContainerEnded(
                scanLine,
                openerContainerDepth,
                openerListContentIndent,
              )
            ) {
              end = scanStart;
              resumeAt = scanStart;
              break;
            }
            if (scanLine.includes(closeToken)) {
              end = scanLineEnd;
              resumeAt = scanLineAfter;
              break;
            }
            if (nl === -1) {
              break;
            }
            scanStart = scanLineAfter;
          }
        }
        ranges.push({ start: lineStart, end });
        lineStart = resumeAt;
        // A closed special block leaves no open paragraph behind either
        // (Codex review, PR #2840, round 16 -- corrects this branch's
        // pre-existing `false` from round 8); see the raw-text branch's
        // identical comment above.
        noOpenParagraph = true;
        continue;
      }
      if (opensGeneric) {
        let scanStart = lineAfter;
        let end = text.length;
        // Ends at whichever comes first: its own next-blank-line close
        // condition, or the opener's enclosing container ending on a
        // non-blank line (Codex review, PR #2840, round 15). Both land on
        // a real line-start offset already, so no separate `resumeAt` is
        // needed here (contrast the raw-text/special-block branches
        // above).
        while (scanStart <= text.length) {
          const nl = text.indexOf('\n', scanStart);
          const scanLineEnd = nl === -1 ? text.length : nl;
          const scanLineAfter = nl === -1 ? text.length : nl + 1;
          const scanLine = text.slice(scanStart, scanLineEnd);
          if (scanLine.trim() === '') {
            end = scanStart;
            break;
          }
          if (
            isHtmlBlockContainerEnded(
              scanLine,
              openerContainerDepth,
              openerListContentIndent,
            )
          ) {
            end = scanStart;
            break;
          }
          if (nl === -1) {
            end = text.length;
            break;
          }
          scanStart = scanLineAfter;
        }
        ranges.push({ start: lineStart, end });
        lineStart = end;
        // A closed generic block leaves no open paragraph behind either,
        // regardless of whether it closed via its own blank-line rule or
        // via its container ending (Codex review, PR #2840, round 16 --
        // corrects this branch's own round-15 `endedOnBlankLine`
        // conditional, which wrongly kept the container-ending case
        // `false`); see the raw-text branch's comment above for the
        // `gh api /markdown` verification this generalizes.
        noOpenParagraph = true;
        continue;
      }
    }
    noOpenParagraph = isBlank || endsOwnBlock;
    lineStart = lineAfter;
    if (newlineIndex === -1) {
      break;
    }
  }
  return ranges;
}
/**
 * Fenced code block ranges only (no inline spans, no indented code). Unlike
 * {@link findMarkdownCodeRanges}, this lets a caller mask example Markdown
 * syntax inside a fence (a quoted heading or bullet) while leaving inline
 * code spans intact for a scan that still needs them (e.g. suitability-triage
 * Check 7's `hasSubstantiveBullet`, #2589).
 */
export function findFencedCodeRanges(text) {
  const ranges = [];
  let fence = null;
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
    const openerListContentIndent = fence
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
/**
 * Blank-line-tolerant ranges of 4-space (or list-content-indent-relative)
 * indented code blocks, excluding any line already covered by a fenced
 * range. `fencedRanges` must be in ascending `start` order (as returned by
 * {@link findFencedCodeRanges}). Exported (#2711) so a caller that needs
 * fenced + indented masking WITHOUT inline code spans -- {@link
 * findMarkdownCodeRanges} always includes inline spans too -- can compose
 * this with {@link findFencedCodeRanges} directly.
 */
export function findIndentedCodeRanges(text, fencedRanges) {
  const ranges = [];
  let rangeStart = null;
  let rangeEnd = 0;
  let previousLineBlank = true;
  let previousLineBlockBoundary = true;
  let previousContainerDepth = 0;
  let activeListContentIndent = null;
  let activeListContainerDepth = null;
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
    const isNonInterruptingListItem =
      listItem !== null &&
      !previousLineBlank &&
      !previousLineBlockBoundary &&
      parsed.containerDepth === previousContainerDepth &&
      activeListContentIndent === null &&
      (listItem.content.trim() === '' ||
        (/^\d{1,9}[.)]$/u.test(listItem.marker) &&
          !/^1[.)]$/u.test(listItem.marker)));
    const listContentIndent = isNonInterruptingListItem
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
/**
 * Sort `ranges` by `start` and coalesce any that overlap or touch into
 * one, so a downstream consumer never has to reason about two adjacent
 * or overlapping ranges separately. Exported (#3281) so
 * {@link maskMarkdownForScan} can compose ranges from more than one
 * finder (fenced, indented, inline, HTML block, HTML comment) without
 * duplicating this merge logic.
 */
export function mergeMarkdownCodeRanges(ranges) {
  const merged = [];
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
// CommonMark §6.6 raw-HTML inline tag grammar (open-tag and closing-tag
// forms only -- the two shapes whose attribute values can hide a backtick
// pair, #2865). An attribute value may be unquoted (a nonempty run of
// characters excluding whitespace, quotes, `=`, `<`, `>`, and a backtick --
// CommonMark's own grammar excludes the backtick there too, so
// `<span title=`x`>` never matches as a tag at all, leaving `` `x` `` a
// genuine code span), single-quoted, or double-quoted; a quoted value may
// itself contain a backtick, which GitHub renders as literal attribute
// text, never a code-span delimiter (`gh api /markdown` confirms
// `<span title="`node --test`"></span>` keeps its backticks literal).
// {@link findInlineCodeRanges} skips a matched tag entirely so an
// attribute-embedded backtick pair is never read as a code-span
// opener/closer.
const INLINE_HTML_TAG_NAME_PATTERN = '[A-Za-z][A-Za-z0-9-]*';
const INLINE_HTML_ATTRIBUTE_NAME_PATTERN = '[A-Za-z_:][A-Za-z0-9_.:-]*';
const INLINE_HTML_ATTRIBUTE_VALUE_PATTERN =
  '(?:[^ \\t\\r\\n"\'=<>`]+|\'[^\']*\'|"[^"]*")';
const INLINE_HTML_ATTRIBUTE_PATTERN =
  `[ \\t\\r\\n]+${INLINE_HTML_ATTRIBUTE_NAME_PATTERN}` +
  `(?:[ \\t\\r\\n]*=[ \\t\\r\\n]*${INLINE_HTML_ATTRIBUTE_VALUE_PATTERN})?`;
const INLINE_HTML_OPEN_TAG_PATTERN = new RegExp(
  `^<${INLINE_HTML_TAG_NAME_PATTERN}(?:${INLINE_HTML_ATTRIBUTE_PATTERN})*[ \\t\\r\\n]*/?>`,
  'u',
);
const INLINE_HTML_CLOSE_TAG_PATTERN = new RegExp(
  `^</${INLINE_HTML_TAG_NAME_PATTERN}[ \\t\\r\\n]*>`,
  'u',
);
/**
 * The end offset of a CommonMark raw-HTML inline tag (open or closing form)
 * starting at `start` (which must hold `<`), bounded to `[start, end)`, or
 * `null` when no valid tag matches there -- an unterminated quoted
 * attribute value, for example, fails both patterns and falls through to
 * ordinary text, leaving any backtick inside it a normal code-span
 * candidate.
 *
 * **Blank-line guard**: CommonMark parses block structure (including where
 * a blank line ends a paragraph) before inline content, so no raw-HTML
 * inline tag can ever span a blank line -- `gh api /markdown` confirms
 * `<span title="a` / (blank) / `b">` renders as two separate literal-text
 * paragraphs, never one tag. The character classes above allow a bare `\n`
 * (a quoted value may wrap a soft line break) but cannot themselves refuse
 * a *second* consecutive one, so a match that happens to reach a real
 * closing quote/`>` on the far side of a blank line is rejected here via
 * {@link hasBlankLine} -- the same post-match guard
 * {@link findInlineCodeRanges}'s own closing-backtick search already
 * applies for the identical reason.
 */
function matchInlineHtmlTagEnd(text, start, end) {
  const remainder = text.slice(start, end);
  const open = INLINE_HTML_OPEN_TAG_PATTERN.exec(remainder);
  const matchLength =
    open?.[0].length ??
    INLINE_HTML_CLOSE_TAG_PATTERN.exec(remainder)?.[0].length ??
    null;
  if (matchLength === null) {
    return null;
  }
  const matchEnd = start + matchLength;
  return hasBlankLine(text, start, matchEnd) ? null : matchEnd;
}
// CommonMark §6.3 inline-link destination/title grammar, generalizing the
// same attribute-value exclusion to a link's own `(destination "title")`
// span (#2865, Codex review PR #2840 round 27, databaseId 3977018342):
// `[test](/url "`node --test`")` renders its title's backticks literally
// too (`gh api /markdown` confirms `<a href="/url" title="`node
// --test`">`), never a code span. The optional title is a double-,
// single-, or paren-quoted string; unlike an HTML attribute value, a title
// supports backslash-escaping so an escaped delimiter does not end it
// early. The bare (non-angle-bracket) destination itself is scanned
// manually by {@link scanBareLinkDestinationEnd} below, not matched by this
// pattern, since CommonMark allows arbitrarily nested balanced parens
// there (a fixed-depth regex alternative under-matched a real doubly-nested
// destination -- Codex review round 1, databaseId 3978211245).
const INLINE_LINK_TITLE_PATTERN =
  '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|\\((?:[^()\\\\]|\\\\.)*\\))';
const INLINE_LINK_ANGLE_DESTINATION_PATTERN = /^<[^<>\r\n]*>/u;
const INLINE_LINK_TITLE_AND_CLOSE_PATTERN = new RegExp(
  `^(?:[ \\t\\r\\n]+${INLINE_LINK_TITLE_PATTERN})?[ \\t\\r\\n]*\\)`,
  'u',
);
/**
 * Bound on how far {@link scanBareLinkDestinationEnd} and
 * {@link hasPlausibleLinkOpener} scan before giving up, so a long run of
 * unresolved link-like prefixes in untrusted issue-body text (adversarial
 * or merely malformed, e.g. many `[x](` occurrences with no closing paren
 * or whitespace) cannot make `findMarkdownCodeRanges` quadratic in body
 * length (Codex review, PR #2869 round 2, databaseId 3978373746: ~2.7s for
 * a single 64 KB instance without this bound, and discovery/triage
 * processes untrusted issue bodies routinely). Far beyond any legitimate
 * CommonMark link destination or link-text length in practice.
 */
const MAX_LINK_SCAN_LENGTH = 2000;
// CommonMark §2.4: only an ASCII punctuation character may be
// backslash-escaped; a backslash before anything else (including
// whitespace) is a literal backslash, not an escape (Codex review, PR
// #2869 round 3, databaseId 3978515897): `gh api /markdown` confirms
// `[x](foo\ bar "`node --test`")` renders entirely as literal text with a
// genuine code span for the backticks -- `\` before a space never escapes
// it, so the space still ends the bare destination.
const ASCII_PUNCTUATION_PATTERN = /[!-/:-@[-`{-~]/u;
/**
 * The end offset of a bare (non-angle-bracket) link destination starting at
 * `start`, honoring CommonMark's rule that parens are allowed there only
 * when backslash-escaped or part of an arbitrarily-nested balanced pair
 * (`gh api /markdown` confirms `/foo(a(b)c)` survives as a real
 * destination with two nesting levels) -- manual scanning, rather than a
 * fixed-depth regex alternative, generalizes to any nesting depth. Stops
 * at the first whitespace or unbalanced (closing) `)`, which belongs to
 * the enclosing link syntax, not the destination. Returns `null` instead
 * of a position when the scan reaches {@link MAX_LINK_SCAN_LENGTH} without
 * finding either terminator -- the caller treats that the same as no valid
 * destination.
 */
function scanBareLinkDestinationEnd(text, start, end) {
  const bound = Math.min(end, start + MAX_LINK_SCAN_LENGTH);
  let cursor = start;
  let depth = 0;
  while (cursor < bound) {
    const character = text[cursor];
    if (
      character === '\\' &&
      cursor + 1 < bound &&
      ASCII_PUNCTUATION_PATTERN.test(text[cursor + 1] ?? '')
    ) {
      cursor += 2;
      continue;
    }
    if (character === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (character === ')') {
      if (depth === 0) {
        return cursor;
      }
      depth -= 1;
      cursor += 1;
      continue;
    }
    if (
      character === ' ' ||
      character === '\t' ||
      character === '\r' ||
      character === '\n'
    ) {
      return cursor;
    }
    cursor += 1;
  }
  // Reached the scan bound (the {@link MAX_LINK_SCAN_LENGTH} cap or the
  // caller's own `end`) without finding a real terminator -- never a valid
  // destination; the caller's own title/close match would fail on this
  // position anyway, but returning `null` here makes that fail-closed
  // outcome explicit rather than incidental.
  return null;
}
/**
 * True when `closeBracketIndex` (which must hold `]`) is the properly
 * balanced close of an earlier unescaped `[` -- a plausible open link/image
 * bracket -- within the current paragraph (a link's own `[...]` text can
 * never cross a blank line) and within {@link MAX_LINK_SCAN_LENGTH} of
 * `closeBracketIndex` (the paragraph search itself is bounded to that same
 * trailing window, not the whole document -- Codex review, PR #2869 round
 * 3, databaseId 3978515904: an unbounded `matchAll` over the full text on
 * every call reintroduced quadratic behavior even after the backward
 * bracket scan itself was bounded). `codeRanges` -- the genuine code-span
 * ranges `findInlineCodeRanges` has already found to the left of this
 * point in the same call -- lets the scan skip over an already-closed code
 * span as one opaque unit rather than reading a bracket inside it as real
 * Markdown structure (Codex review, PR #2869 round 3, databaseId
 * 3978515893): `gh api /markdown` confirms `` `[foo` ](/url "`x`") ``
 * renders `` `[foo` `` as its own real code span and `` `x` `` as a
 * second, separate one -- the `[` inside the first span must never count
 * as a link opener for the `]` that follows it.
 *
 * Tracks nested-bracket depth while scanning backward, rather than
 * accepting or rejecting on the nearest bracket alone (Codex review, PR
 * #2869 round 2, databaseId 3978373742): `gh api /markdown` confirms a
 * nested label such as `[foo [bar] baz](/url "..)")` is a real link, whose
 * inner `[bar]` must not be mistaken for -- or block reaching -- the real
 * outer opener. Also still resolves round 1's two shapes (databaseId
 * 3978211256): `foo](/url "`x`")` (no `[` at all) and `\[test](/url
 * "`x`")` (the `[` itself escaped) both render their backticks as a
 * genuine code span, never a link, so this must return `false` for both.
 */
function hasPlausibleLinkOpener(text, closeBracketIndex, codeRanges) {
  const searchFloor = Math.max(0, closeBracketIndex - MAX_LINK_SCAN_LENGTH);
  const searchWindow = text.slice(searchFloor, closeBracketIndex);
  let paragraphStart = searchFloor;
  for (const match of searchWindow.matchAll(/\r?\n[ \t]*\r?\n/gu)) {
    paragraphStart = searchFloor + match.index + match[0].length;
  }
  let cursor = closeBracketIndex - 1;
  let depth = 0;
  while (cursor >= paragraphStart) {
    const enclosingCodeRange = getMarkdownCodeRange(text, cursor, codeRanges);
    if (enclosingCodeRange !== null) {
      cursor = enclosingCodeRange.start - 1;
      continue;
    }
    const character = text[cursor];
    if (character === ']' && !isEscapedBacktick(text, cursor)) {
      depth += 1;
      cursor -= 1;
      continue;
    }
    if (character === '[' && !isEscapedBacktick(text, cursor)) {
      if (depth === 0) {
        return true;
      }
      depth -= 1;
    }
    cursor -= 1;
  }
  return false;
}
/**
 * The end offset of an inline link's `(destination "title")` span starting
 * at `start` (which must hold `(`), bounded to `[start, end)`, or `null`
 * when `start` is not immediately preceded by a plausible open link/image
 * bracket (see {@link hasPlausibleLinkOpener}), no valid destination/title
 * matches there, or the match would span a blank line (see
 * {@link matchInlineHtmlTagEnd}'s identical guard and rationale). A
 * link-shaped prefix that never reaches a valid destination/title/`)`
 * (e.g. `[note](which uses \`code\`)`) leaves the whole match unresolved
 * and falls through to ordinary text, leaving that backtick pair a genuine
 * code span (`gh api /markdown` confirms GitHub renders exactly that).
 * `codeRanges` is forwarded to {@link hasPlausibleLinkOpener} unchanged.
 */
function matchInlineLinkDestTitleEnd(text, start, end, codeRanges) {
  if (
    text[start - 1] !== ']' ||
    !hasPlausibleLinkOpener(text, start - 1, codeRanges)
  ) {
    return null;
  }
  const leadingWhitespace = /^[ \t\r\n]*/u.exec(text.slice(start + 1, end));
  let cursor = start + 1 + (leadingWhitespace?.[0].length ?? 0);
  const angleMatch = INLINE_LINK_ANGLE_DESTINATION_PATTERN.exec(
    text.slice(cursor, end),
  );
  if (angleMatch !== null) {
    cursor += angleMatch[0].length;
  } else {
    const destinationEnd = scanBareLinkDestinationEnd(text, cursor, end);
    if (destinationEnd === null) {
      return null;
    }
    cursor = destinationEnd;
  }
  const rest = INLINE_LINK_TITLE_AND_CLOSE_PATTERN.exec(
    text.slice(cursor, end),
  );
  if (rest === null) {
    return null;
  }
  const matchEnd = cursor + rest[0].length;
  return hasBlankLine(text, start, matchEnd) ? null : matchEnd;
}
/**
 * Inline code span ranges (`` `...` ``, CommonMark-aware: raw-HTML tags,
 * link destination/title spans, and escaped backticks are excluded from
 * consideration) within `[start, end)`. Exported (#3281) so
 * {@link maskMarkdownForScan} can scan the gaps between its own
 * already-computed fenced/indented ranges directly, the same way
 * {@link findMarkdownCodeRanges} does internally, instead of calling
 * {@link findMarkdownCodeRanges} (which would recompute
 * {@link findFencedCodeRanges} a second time).
 */
export function findInlineCodeRanges(text, start, end) {
  const ranges = [];
  let cursor = start;
  while (cursor < end) {
    // #2865: skip an inline HTML tag or a link's own destination/title span
    // entirely before ever considering a backtick inside it as a code-span
    // delimiter -- CommonMark's raw-HTML and link rules take precedence
    // over the code-span rule there. Codex review (round 1, databaseId
    // 3978211270): an escaped `<` or `(` (`\<span title="`x`">`,
    // `foo\(bar` `x` `)`) is ordinary text per CommonMark, never the start
    // of raw HTML or a link's destination/title, so a backtick inside it
    // stays a genuine code-span candidate -- skip the exclusion entirely
    // when the opening character itself is escaped.
    if (text[cursor] === '<' && !isEscapedBacktick(text, cursor)) {
      const tagEnd = matchInlineHtmlTagEnd(text, cursor, end);
      if (tagEnd !== null) {
        cursor = tagEnd;
        continue;
      }
    } else if (text[cursor] === '(' && !isEscapedBacktick(text, cursor)) {
      const linkEnd = matchInlineLinkDestTitleEnd(text, cursor, end, ranges);
      if (linkEnd !== null) {
        cursor = linkEnd;
        continue;
      }
    }
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
export function findMarkdownCodeRanges(text) {
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
  text,
  position,
  ranges = findMarkdownCodeRanges(text),
) {
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
  text,
  ranges = findMarkdownCodeRanges(text),
) {
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
/**
 * One documented entry point (#3281) for masking a Markdown issue/PR body
 * before scanning it for machine-readable markers or dependency
 * references, replacing the ad hoc mix of {@link stripMarkdownCodeRegions}
 * (fenced + inline only -- misses indented code) and no masking at all
 * that the Discover helpers previously used inconsistently. Always:
 *
 * - normalizes `\r\n` to `\n` first, so the result never contains a bare
 *   `\r` regardless of the input's line endings;
 * - masks fenced ({@link findFencedCodeRanges}) and indented
 *   ({@link findIndentedCodeRanges}) code blocks;
 * - replaces every masked character with a space and keeps every `\n`,
 *   so the result has the same length and line structure as the
 *   normalized input (line-number math on the returned text stays
 *   valid, matching {@link stripMarkdownCodeRegions}'s existing
 *   contract).
 *
 * `options.inlineCode`/`options.htmlComments`/`options.htmlBlocks`
 * control the three optional mask categories; see
 * {@link MaskMarkdownForScanOptions} for their defaults and rationale.
 *
 * Computes {@link findFencedCodeRanges} exactly once (Copilot review, PR
 * #3399) and reuses it for every downstream range finder that needs it
 * ({@link findIndentedCodeRanges}, the inline scan, {@link
 * findHtmlBlockRanges}, and -- via its own optional `fencedRanges`
 * parameter, Copilot review round 5, PR #3413 -- {@link
 * findHtmlCommentRanges}'s own list-content-indent tracking) -- calling
 * {@link findMarkdownCodeRanges} here instead would silently recompute
 * the fence scan a second time on every call, and this function is now
 * on the hot path of several Discover/audit issue-body scanners.
 */
export function maskMarkdownForScan(text, options = {}) {
  const normalized = text.replace(/\r\n/g, '\n');
  const inlineCode = options.inlineCode ?? 'mask';
  const htmlComments = options.htmlComments ?? 'keep';
  const htmlBlocks = options.htmlBlocks ?? 'keep';
  const fencedRanges = findFencedCodeRanges(normalized);
  const structuralRanges = mergeMarkdownCodeRanges([
    ...fencedRanges,
    ...findIndentedCodeRanges(normalized, fencedRanges),
  ]);
  // Mirrors findMarkdownCodeRanges's own gap-scan, reusing the structural
  // ranges already computed above instead of recomputing them via a
  // second findFencedCodeRanges call. Computed unconditionally (#3282
  // review): a `<!--` sitting inside an inline code span must be
  // excluded from findHtmlCommentRanges's own opener detection below
  // regardless of whether inline code itself ends up masked in the final
  // output -- otherwise a quoted `` `<!--` `` example (#2711/PR #2735's
  // own round-2 case) is wrongly read as a real, unterminated HTML
  // comment opener whenever `inlineCode: 'keep'` is combined with
  // `htmlComments: 'mask'`.
  const inlineRanges = [];
  let cursor = 0;
  for (const structuralRange of structuralRanges) {
    inlineRanges.push(
      ...findInlineCodeRanges(normalized, cursor, structuralRange.start),
    );
    cursor = structuralRange.end;
  }
  inlineRanges.push(
    ...findInlineCodeRanges(normalized, cursor, normalized.length),
  );
  let ranges =
    inlineCode === 'mask'
      ? mergeMarkdownCodeRanges([...structuralRanges, ...inlineRanges])
      : structuralRanges;
  // Computed at most once, exactly when either mask category below
  // needs it (Copilot review round 6, PR #3413): findHtmlCommentRanges's
  // own list-content-indent tracker must freeze across a raw/generic
  // HTML block's content too (see computeLineListContentIndents's own
  // doc comment), the same reason it already freezes across fenced
  // ranges -- computing it here and threading it through avoids a
  // second findHtmlBlockRanges scan whenever both `htmlBlocks: 'mask'`
  // and `htmlComments: 'mask'` are requested together (the
  // maskOpaqueMarkdown composition several scanners already use).
  const htmlBlockRanges =
    htmlBlocks === 'mask' || htmlComments === 'mask'
      ? findHtmlBlockRanges(normalized, fencedRanges)
      : undefined;
  if (htmlBlocks === 'mask') {
    ranges = mergeMarkdownCodeRanges([...ranges, ...(htmlBlockRanges ?? [])]);
  }
  if (htmlComments === 'mask') {
    // ignoredOpenerRanges always includes the inline ranges (see the
    // comment above), even when inlineCode: 'keep' left them out of
    // `ranges` itself -- merging them in here again when inlineCode:
    // 'mask' already included them is a harmless no-op.
    const ignoredOpenerRanges = mergeMarkdownCodeRanges([
      ...ranges,
      ...inlineRanges,
    ]);
    ranges = mergeMarkdownCodeRanges([
      ...ranges,
      ...findHtmlCommentRanges(
        normalized,
        ignoredOpenerRanges,
        fencedRanges,
        htmlBlockRanges,
      ),
    ]);
  }
  return maskMarkdownCodeRegionsPreservingPositions(normalized, ranges);
}
