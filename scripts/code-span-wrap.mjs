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
  INLINE_CODE_SPAN_PATTERN,
  stripMarkdownCodeRegions,
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
// cross a single line break but never a blank line -- with two extra
// guards approximating CommonMark's emphasis flanking rules well enough to
// avoid misreading a `*`/`-`/`+` bullet-list marker as an emphasis opener:
// the opening run must not be immediately followed by whitespace (a bullet
// marker always is, e.g. `* item`), and the closing run must be
// immediately preceded by non-whitespace (rules out closing on a stray
// later `*`/`**` separated from the emphasized text by a space). This is a
// heuristic, not a full CommonMark emphasis parser -- deliberately, to keep
// this dogfood-only check simple and low-risk; see
// findCorruptingProseWraps's own corpus-validated scope below.
const EMPHASIS_SPAN_PATTERN =
  /(\*{1,2})(?!\s)((?:(?!\1)[^\r\n]|\r?\n(?![ \t]*\r?\n))+?)(?<=\S)\1/g;
/**
 * Find `**`/`*` emphasis spans in prose Markdown text (outside fenced code
 * blocks and inline code spans) whose line break falls immediately after a
 * hyphen joining a token on each side (reusing the same
 * {@link TOKEN_CONTINUING} neighbor test as
 * {@link findCorruptingCodeSpanWraps}) -- the prose counterpart of that
 * function. Returns one violation per corrupting break, in document order.
 */
export function findCorruptingProseWraps(text) {
  const normalized = text.replace(/\r\n?/g, '\n');
  // stripMarkdownCodeRegions blanks fenced-block lines and masks inline
  // code span interiors (backticks kept, content replaced with spaces),
  // preserving line/column structure -- so code content already covered by
  // findCorruptingCodeSpanWraps is never double-flagged here, and this scan
  // never mistakes a code span's own emphasis-looking characters for real
  // prose emphasis.
  const scanned = stripMarkdownCodeRegions(normalized);
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
