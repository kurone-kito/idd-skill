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
} from './markdown-code.mts';

export interface CodeSpanWrapViolation {
  /** 1-based line number of the line that ends mid-token (before the break). */
  line: number;
  /** Trailing context from the end of the line before the break. */
  before: string;
  /** Leading context from the start of the line after the break. */
  after: string;
}

const MID_TOKEN_CONTINUATION = /[-_/.]/;
const TOKEN_CONTINUING = /[A-Za-z0-9\-_/.]/;
const CONTEXT_CHARS = 20;

/**
 * Find inline code spans whose line break falls mid-token per the rule
 * above. Returns one violation per corrupting break, in document order.
 */
export function findCorruptingCodeSpanWraps(
  text: string,
): CodeSpanWrapViolation[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  // Fenced-block content is blanked to '' per line, so a code span can
  // never start or continue inside one; blanking always leaves a blank
  // line, which the pattern below already treats as a span terminator, so
  // no false span can bridge a fenced block. Line counts stay aligned
  // with `normalized` because blanking preserves the number of lines.
  const scanned = blankFencedCodeBlocks(normalized);
  const violations: CodeSpanWrapViolation[] = [];

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
