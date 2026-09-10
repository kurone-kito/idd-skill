// idd-generated-from: src/scripts/code-span-wrap.mts
//
// The scripts/code-span-wrap.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Detects the *corrupting* sub-case of a Markdown-wrapped inline code
// span (idd-skill issue #1677): CommonMark converts a line ending inside
// a code span to a single space, so a break that falls mid-token --
// right after a hyphen, underscore, slash, or dot that the token
// continues through -- silently inserts a space the author never
// intended, corrupting the rendered command or identifier so it can no
// longer be copy-pasted correctly. A break at a real word boundary is
// readable and is deliberately NOT flagged here (see the issue for why
// that sub-case is left alone rather than banning multi-line spans
// outright). Fenced code blocks are excluded first via
// blankFencedCodeBlocks, matching the same fence semantics
// stripMarkdownCodeRegions already uses elsewhere in this repo.
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
  blankFencedCodeBlocks,
  findFencedCodeRanges,
  findHtmlBlockRanges,
  findMarkdownCodeRanges,
  INLINE_CODE_SPAN_PATTERN,
  maskMarkdownCodeRegionsPreservingPositions,
} from './markdown-code.mjs';

const MID_TOKEN_CONTINUATION = /[-_/.]/;
const TOKEN_CONTINUING = /[A-Za-z0-9\-_/.]/;
const CONTEXT_CHARS = 20;
/**
 * Find inline code spans whose line break falls mid-token per the rule
 * above. Returns one violation per corrupting break, in document order.
 */
export function findCorruptingCodeSpanWraps(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  // Fenced-block content is blanked to '' per line, so a code span can
  // never start or continue inside one; blanking always leaves a blank
  // line, which the pattern below already treats as a span terminator, so
  // no false span can bridge a fenced block. Line counts stay aligned
  // with `normalized` because blanking preserves the number of lines.
  const scanned = blankFencedCodeBlocks(normalized);
  const violations = [];
  for (const match of scanned.matchAll(INLINE_CODE_SPAN_PATTERN)) {
    const ticks = match[1];
    const inner = match[2];
    const spanStart = match.index ?? 0;
    const innerStart = spanStart + ticks.length;
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
// EMPHASIS_SPAN_PATTERN mirrors INLINE_CODE_SPAN_PATTERN's own technique --
// a backreference-counted delimiter run (`\1`) whose inner content may
// cross any number of line breaks, same as INLINE_CODE_SPAN_PATTERN, as
// long as none of them is a blank line -- with two extra guards
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
