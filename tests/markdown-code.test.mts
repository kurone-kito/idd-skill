import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blankFencedCodeBlocks,
  findFencedCodeRanges,
  findHtmlBlockRanges,
  findMarkdownCodeRanges,
  getMarkdownCodeRange,
  maskMarkdownCodeRegionsPreservingPositions,
  stripMarkdownCodeRegions,
} from '../src/scripts/markdown-code.mts';

test('stripMarkdownCodeRegions blanks fenced blocks but keeps line count', () => {
  const body = ['before', '~~~', 'inside #1', '~~~', 'after'].join('\n');
  assert.equal(
    stripMarkdownCodeRegions(body),
    ['before', '', '', '', 'after'].join('\n'),
  );
});

test('stripMarkdownCodeRegions masks inline code spans, preserving delimiters', () => {
  const masked = ' '.repeat('Blocked by #7'.length);
  assert.equal(
    stripMarkdownCodeRegions('see `Blocked by #7` here'),
    `see \`${masked}\` here`,
  );
});

test('stripMarkdownCodeRegions keeps an inline span within one paragraph', () => {
  // A single newline inside a span is still masked (CommonMark renders it as a
  // space); the newline itself is preserved so line offsets do not shift.
  assert.equal(
    stripMarkdownCodeRegions('`multi\nline` tail'),
    '`     \n    ` tail',
  );
  // A stray unclosed backtick must NOT mask across a blank line: the real
  // `Blocked by #5` in the next paragraph stays intact (fail-open guard).
  const body = ['a stray tick `', '', 'Blocked by #5', '', 'then `code`'].join(
    '\n',
  );
  const stripped = stripMarkdownCodeRegions(body);
  assert.ok(
    stripped.includes('Blocked by #5'),
    'a blank line ends the span, so the later dependency line is preserved',
  );
  assert.equal(stripped.split('\n')[4], 'then `    `');
});

test('stripMarkdownCodeRegions leaves HTML comments and plain text intact', () => {
  const body = 'plain <!-- idd-skill-blocked-by: parent --> text';
  assert.equal(stripMarkdownCodeRegions(body), body);
});

test('stripMarkdownCodeRegions treats a 4-space-indented fence marker as code, not a fence', () => {
  // CommonMark §4.5: `    ~~~` (4 leading spaces) is indented code, not a fence
  // opener, so it must NOT enter fence mode and blank the real lines after it.
  const body = ['    ~~~', 'Blocked by #123', 'Depends on #456'].join('\n');
  assert.equal(stripMarkdownCodeRegions(body), body);
  // Up to three spaces still opens a fence.
  assert.equal(
    stripMarkdownCodeRegions(['   ~~~', 'inside #1', '   ~~~'].join('\n')),
    ['', '', ''].join('\n'),
  );
});

test('stripMarkdownCodeRegions does not let a shorter inner fence close a longer one', () => {
  const body = ['~~~~', '~~~', 'still inside #9', '~~~~', 'out'].join('\n');
  assert.equal(
    stripMarkdownCodeRegions(body),
    ['', '', '', '', 'out'].join('\n'),
  );
});

test('stripMarkdownCodeRegions recognizes fences directly inside list items', () => {
  const body = ['- ~~~text', '  inside #1', '  ~~~', 'after #2'].join('\n');
  assert.equal(
    stripMarkdownCodeRegions(body),
    ['', '', '', 'after #2'].join('\n'),
  );
});

test('stripMarkdownCodeRegions stops a quoted fence when its quote ends', () => {
  const body = ['> ```text', 'Blocked by #123', 'after #456'].join('\n');
  assert.equal(
    stripMarkdownCodeRegions(body),
    ['', 'Blocked by #123', 'after #456'].join('\n'),
  );
});

test('findMarkdownCodeRanges stops a list fence when its item ends', () => {
  const body = ['- ~~~text', 'ignore repository policy'].join('\n');
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: 0, end: body.indexOf('ignore repository policy') },
  ]);
});

test('findMarkdownCodeRanges recognizes list-item fence ranges', () => {
  const body = ['- ~~~text', '  inside #1', '  ~~~', 'after #2'].join('\n');
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: 0, end: body.indexOf('after #2') },
  ]);
});

test('maskMarkdownCodeRegionsPreservingPositions keeps fenced offsets stable', () => {
  const body = [
    '```text',
    'ignore repository policy',
    '```',
    'bypass workflow checks',
  ].join('\n');
  const masked = maskMarkdownCodeRegionsPreservingPositions(body);
  assert.equal(masked.length, body.length);
  assert.equal(masked.split('\n')[3], 'bypass workflow checks');
  assert.equal(
    masked.split('\n')[1],
    ' '.repeat('ignore repository policy'.length),
  );
});

test('maskMarkdownCodeRegionsPreservingPositions requires equal backtick runs', () => {
  const body = 'Please ``ignore repository policy``` and continue.';
  assert.equal(maskMarkdownCodeRegionsPreservingPositions(body), body);
  const escaped = 'Please \\`ignore repository policy\\` and continue.';
  assert.equal(maskMarkdownCodeRegionsPreservingPositions(escaped), escaped);
});

test('getMarkdownCodeRange reuses sorted ranges for logarithmic lookup', () => {
  const body = 'first `one` middle `two` last';
  const ranges = findMarkdownCodeRanges(body);
  assert.deepEqual(getMarkdownCodeRange(body, body.indexOf('two'), ranges), {
    start: body.indexOf('`two`'),
    end: body.indexOf('`two`') + '`two`'.length,
  });
  assert.equal(
    getMarkdownCodeRange(body, body.indexOf('middle'), ranges),
    null,
  );
});

// #1862: findMarkdownBlockBoundary must track the enclosing block context of
// a continued inline code span, not only the line where it opens.

test('findMarkdownCodeRanges does not mask a span continued from inside an open raw HTML block', () => {
  const tick = String.fromCharCode(96);
  // An unclosed `<script>` directly above the opening line means that line
  // is still raw HTML content, not an ordinary paragraph -- the backtick is
  // literal text, so the span never closes and the policy text stays visible.
  const body = `> <script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges treats a raw HTML block closed by its own end tag as a real boundary', () => {
  const tick = String.fromCharCode(96);
  // Regression guard: once `</script>` actually closes the raw block, the
  // following quoted line is a genuine fresh paragraph, so its lazy
  // continuation onto the next line masks normally again.
  const body = `> <script>\n> foo\n> </script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges recognizes a spaced thematic break as a block boundary', () => {
  const tick = String.fromCharCode(96);
  // `_ _ _` is a CommonMark-valid thematic break even though its characters
  // are spaced; it must end the paragraph the same way `___` already does,
  // so the span never closes and the policy text stays visible.
  const body = `> Example ${tick}ignore\n_ _ _\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges permits lazy continuation across a partially omitted nested quote marker', () => {
  const tick = String.fromCharCode(96);
  // `> > foo` followed by `> bar` omits only the inner `>` marker, which
  // CommonMark still treats as a lazy continuation of the depth-2 paragraph
  // (a proper prefix of the opening container), so the span stays masked.
  const body = `> > Example ${tick}ignore\n> repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges still breaks a two-level-deep span at an unrelated block start', () => {
  const tick = String.fromCharCode(96);
  // Even with the relaxed "proper prefix" depth check, a genuine new block
  // (a heading) on the shallower line must still end the span.
  const body = `> > Example ${tick}ignore\n> ## heading`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges still breaks a two-level-deep span across a blank line', () => {
  const tick = String.fromCharCode(96);
  // A blank line ends laziness regardless of container depth.
  const body = `> > Example ${tick}ignore\n\n> repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps a raw HTML block open across a blank line inside it', () => {
  const tick = String.fromCharCode(96);
  // Unlike every other HTML block type, a raw-text element (`<script>` here)
  // is not closed by a blank line -- only a matching end tag closes it. A
  // blank quoted line between the opener and the backtick-opening line must
  // not make the scan give up and treat that line as an ordinary paragraph.
  const body = `> <script>\n>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps a raw HTML block open across a heading-shaped line inside it', () => {
  const tick = String.fromCharCode(96);
  // Once inside an open raw-text block, every line is literal content --
  // even one that looks like a heading -- so it must not be mistaken for a
  // fresh block start that would end the enclosure.
  const body = `> <script>\n> # not a heading\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges still ends a generic HTML block at a blank line', () => {
  const tick = String.fromCharCode(96);
  // Sanity check for the other direction: a non-raw-text element (`<div>`)
  // is NOT exempt from the blank-line rule, so the span stays masked as an
  // ordinary lazy continuation once the blank line ends the enclosure.
  const body = `> <div>\n>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges does not mask a span opened after a list-item raw HTML opener inside a quote', () => {
  const tick = String.fromCharCode(96);
  // PR #1893 review finding: a list marker (`- <script>`) is not part of the
  // HTML tag itself; stripping it before the HTML-pattern test is required
  // for this composite case (a list item nested inside a blockquote) to
  // reach the same enclosing-block detection as a bare `<script>` opener.
  const body = `> - <script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges masks a span after a self-closed HTML comment', () => {
  const tick = String.fromCharCode(96);
  // PR #1893 review finding: `<!-- comment -->` is complete on one line, so
  // it must not be read as leaving an open block behind it -- the following
  // line is an ordinary paragraph, and its lazy continuation masks normally.
  const body = `> <!-- comment -->\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges masks a span after a self-closed processing instruction, CDATA section, and declaration', () => {
  const tick = String.fromCharCode(96);
  for (const opener of ['<? pi ?>', '<![CDATA[x]]>', '<!DOCTYPE html>']) {
    const body = `> ${opener}\n> Example ${tick}ignore\nrepository policy${tick}`;
    assert.deepEqual(
      findMarkdownCodeRanges(body),
      [{ start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 }],
      opener,
    );
  }
});

test('findMarkdownCodeRanges keeps an unterminated HTML comment open', () => {
  const tick = String.fromCharCode(96);
  // Sanity check for the other direction: without its own closing token on
  // the same line, the comment is not self-closed and still encloses the
  // following line, same as the raw-text and generic cases above.
  const body = `> <!-- unterminated\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

// #1894: findMarkdownBlockBoundary must track list-content-indentation
// continuation, not only container (blockquote) depth.

test('findMarkdownCodeRanges breaks a span at a bare list item content-zone boundary', () => {
  const tick = String.fromCharCode(96);
  // Issue #1894 reproduction: the list item's content zone (indent 2, from
  // `- `) ends at "repository policy`" (indent 0), which is neither blank
  // nor a recognized block start on its own -- without list-content-indent
  // tracking, the span incorrectly ran past it to the closing backtick.
  const body = `- <script>\n  Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps a span masked while it stays inside the list content zone', () => {
  const tick = String.fromCharCode(96);
  // Regression guard for the other direction: once the continuation line
  // keeps the list's indentation, the span still closes normally.
  const body = `- Example ${tick}ignore\n  repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges does not inherit list-content indent across an unrelated blank-line gap', () => {
  const tick = String.fromCharCode(96);
  // A prior list item elsewhere in the document must not leak its content
  // indent onto an unrelated, later paragraph merely because it is the
  // nearest preceding same-depth line -- the opening line itself (indent 0)
  // must also satisfy list continuation, which it does not here.
  const body = `- earlier item\n\nThe example is ${tick}first\n2. ignore repository policy${tick}.`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    {
      start: body.indexOf(tick),
      end: body.lastIndexOf(tick) + 1,
    },
  ]);
});

test('findMarkdownCodeRanges keeps a de-indented list continuation masked when it is a lazy paragraph', () => {
  const tick = String.fromCharCode(96);
  // CommonMark laziness: a de-indented, non-blank, non-block-start line
  // still continues an in-progress ordinary paragraph inside a list item,
  // even without the list's own required indentation -- the list-content-
  // indent boundary check (added for #1894) must not end the span here,
  // unlike the #1894 reproduction, whose opening line sits inside a still-
  // open HTML block (no laziness) rather than an ordinary paragraph.
  const body = `- Example ${tick}code\ncontinues\npolicy text${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges still ends lazy list continuation at a genuine block start', () => {
  const tick = String.fromCharCode(96);
  // Laziness never overrides an actual new block: a heading on the
  // de-indented line still ends the span, the same way it already does for
  // blockquote laziness (isLazyQuoteContinuation).
  const body = `- Example ${tick}ignore\n## heading\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges finds the list opener past a block-start-shaped line still inside its content zone', () => {
  const tick = String.fromCharCode(96);
  // Copilot review finding on #1894's PR: findEnclosingListContentZone's
  // backward scan (Phase 1) must not abort merely because an intermediate
  // line *looks like* a fresh block start (a heading here) -- such a line
  // can still legitimately continue an already-open list item's content
  // zone by indentation (the forward tracker in findIndentedCodeRanges only
  // ends list state on an indentation drop or two blank lines, never on a
  // line's shape). Aborting early missed the real "- <script>" opener and
  // wrongly left the span masking the trailing policy text.
  const body = `- <script>\n  # heading inside list\n  Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges recognizes a fence opener under wide list-marker padding as a block boundary', () => {
  const tick = String.fromCharCode(96);
  // findMarkdownBlockBoundary's own parseFencedLine call did not thread the
  // active list-content indent, so a fence marker pushed past column 3 by
  // wide list-marker padding (`-` plus 4 spaces, content indent 5) was
  // invisible as a block start (fixed in #1897). Independently, #1898 fixed
  // findFencedCodeRanges's own opener detection for the same wide-padded
  // fence, so this now-unclosed fence (no closing ``` at this same
  // indentation follows) is recognized as a genuine fenced range running to
  // the end of input, per CommonMark -- masking its content, including the
  // stray inline backtick's would-be content and "repository policy", as
  // fenced code. This is the correct outcome (GitHub renders an unclosed
  // fence as code too, not literal policy text), not merely "masks
  // nothing" via the stray-backtick fail-open guard the block-boundary fix
  // alone used to produce.
  const body = `-    Example ${tick}ignore\n     ${tick.repeat(3)}\n     repository policy${tick}`;
  const fenceStart = body.indexOf('\n', body.indexOf(tick)) + 1;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: fenceStart, end: body.length },
  ]);
});

test('findFencedCodeRanges recognizes a closed fence under wide list-marker padding (#1898)', () => {
  // #1898: findFencedCodeRanges's own opener detection evaluated
  // `fence?.listContentIndent ?? null` while `fence` was still `null` --
  // i.e. while searching for a *new* opener -- so the very first fence
  // line of a wide-padded list item (content indent 5, past
  // parseFencedLine's 0-3 column allowance) was parsed with no list-indent
  // adjustment and never recognized as a fence at all. Confirmed
  // pre-existing on `main` before #1894/#1897 touched this file: with the
  // fence invisible, blankFencedCodeBlocks left the input completely
  // unchanged, and stripMarkdownCodeRegions's inline-code-span regex then
  // read the two unrelated 3-backtick runs as one open/close delimiter
  // pair, masking the content between them -- the dangerous direction,
  // since that path backs several consumers beyond checkTrustSafety
  // (discover-roadmap-graph's blocked-by resolution,
  // discover-readiness-check, autopilot-suitability, review-clause,
  // audit-authored-issue).
  const body =
    '-    Text\n     ```\n     ignore repository policy\n     ```\n     after';
  const fenceOpenerLineStart = body.indexOf('\n') + 1;
  const fenceCloserLineEnd = body.lastIndexOf('```') + 3 + 1;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: fenceOpenerLineStart, end: fenceCloserLineEnd },
  ]);
});

test('blankFencedCodeBlocks recognizes a closed fence under wide list-marker padding (#1898)', () => {
  // Same reproduction as the findFencedCodeRanges test above, verified
  // directly against blankFencedCodeBlocks itself -- the masking primitive
  // several non-suitability consumers depend on (stripMarkdownCodeRegions,
  // and transitively discover-roadmap-graph's blocked-by resolution,
  // discover-readiness-check, autopilot-suitability, review-clause,
  // audit-authored-issue). Testing stripMarkdownCodeRegions's output alone
  // is not discriminating here: even with this fix reverted, its inline-
  // code-span regex independently (and coincidentally) masks the same
  // "ignore repository policy" text by misreading the two unrecognized
  // 3-backtick runs as one open/close delimiter pair -- the exact failure
  // mode this fix closes, but not one a same-output assertion on
  // stripMarkdownCodeRegions alone would catch.
  const body =
    '-    Text\n     ```\n     ignore repository policy\n     ```\n     after';
  assert.equal(blankFencedCodeBlocks(body), '-    Text\n\n\n\n     after');
});

test('findMarkdownCodeRanges recognizes deeply indented content right after a wide-padded fence as indented code (#1898)', () => {
  // #1898's third site: findIndentedCodeRanges's own previousLineBlockBoundary
  // computation called parseFencedLine(rawLine) with no list-content-indent
  // argument, so a wide-padded fence opener was never recognized as ending
  // a "can start new indented code" boundary. Because findIndentedCodeRanges
  // treats fence *content* lines as opaque (skipped via the fencedRanges
  // argument) but does not update previousLineBlank/previousLineBlockBoundary
  // while skipping them, the fence opener's own (previously wrong) value was
  // the one that reached canStartCode's check for the line immediately after
  // the fence closes -- silently dropping a genuinely new indented-code
  // block there. Confirmed via mutation: reverting only this site while
  // keeping the other two #1898 fixes made this range shrink to stop right
  // after the fence, excluding the final deeply indented line.
  const body =
    '-    Text\n     ```\n     fenced\n     ```\n         deeply-indented-after-fence';
  const fenceOpenerLineStart = body.indexOf('\n') + 1;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: fenceOpenerLineStart, end: body.length },
  ]);
});

test('blankFencedCodeBlocks masks an unrelated top-level fence following a list item and one blank line (#1901 regression)', () => {
  // A round of PR #1901 review (both Copilot and an independent critique
  // pass) flagged the original per-call backward-scan fix
  // (findEnclosingListContentIndent) as O(n^2) on a long run of
  // fence-shaped indented lines with no enclosing list -- confirmed
  // (~5.6s at 8000 lines). Replacing it with a forward-tracked
  // listContentIndent (O(1) amortized per line, mirroring
  // findIndentedCodeRanges's own activeListContentIndent) introduced a
  // real regression during development: the tracker's "adopt a freshly
  // seen list item's indent" step ran before an unrelated top-level fence
  // (following the list by a single blank line, still within the
  // two-consecutive-blank-line list-continuation window) had a chance to
  // reset it, so the fence incorrectly inherited the list's stale content
  // indent -- closing it one line early and leaving "foo" unmasked. Fixed
  // by splitting the tracker into a reset-then-adopt pair so the reset
  // (including the indentation-drop check) always runs before the current
  // line reads the tracked indent, not after.
  const body = '- [ ] tests pass\n\n```text\nfoo\n```';
  assert.equal(blankFencedCodeBlocks(body), '- [ ] tests pass\n\n\n\n');
});

test('blankFencedCodeBlocks stays linear-time on a long run of fence-shaped indented lines with no enclosing list', () => {
  // Regression guard for the O(n^2) backward-scan blowup above: a large N
  // of indented, fence-shaped lines (no list anywhere) must not push
  // runtime anywhere near quadratic. Empirically, the pre-fix backward
  // scan took ~5.6s at N=8000; the forward tracker takes low
  // single-digit milliseconds at N=20000. 2000ms is a wide margin over
  // observed forward-tracker runtime (order of 10ms), while still being
  // far below where the old quadratic scan would land at this N (tens of
  // seconds) -- generous enough to avoid flaking on a loaded CI runner
  // without masking a real regression back toward quadratic behavior.
  const text = Array.from({ length: 20000 }, () => '    ```').join('\n');
  const start = performance.now();
  blankFencedCodeBlocks(text);
  const elapsedMs = performance.now() - start;
  assert.ok(
    elapsedMs < 2000,
    `expected roughly-linear runtime, took ${elapsedMs}ms for 20000 lines`,
  );
});

test('stripMarkdownCodeRegions keeps a non-1-numbered marker mid-paragraph as plain text, not a list (#1901 regression)', () => {
  // A second regression the O(n^2) fix's forward tracker introduced (caught
  // by an independent critique pass): the tracker's adoption step originally
  // took ANY parsed.listContentIndent unfiltered, unlike
  // findEnclosingListContentIndent (the backward scan it replaced here),
  // which only ever adopts an interrupting marker (-, +, *, 1., 1)) via
  // isInterruptingListMarker. Per CommonMark, a non-1-numbered ordered
  // marker (e.g. "2.") immediately after an ordinary paragraph line does
  // NOT interrupt that paragraph -- it stays plain text, so the following
  // fence-shaped indented lines are themselves just paragraph continuation
  // text, not a real fence. The unfiltered version wrongly treated "2." as
  // a genuine list opener, masking the real "Blocked by #123" marker below
  // it as fenced-code content -- a fail-open regression, worse than the
  // fence simply going unrecognized.
  const body =
    'Some paragraph text.\n2.    fenced item marker\n      ```\n      Blocked by #123';
  assert.equal(stripMarkdownCodeRegions(body), body);
});

// #1895: isWithinOpenHtmlBlock's backward scan short-circuited on the first
// close/open signal it found, so it could not track more than one candidate
// enclosing HTML block type at once. Restructured into a bounded backward
// collection followed by a forward, single-pass state-machine pass.

test('findMarkdownCodeRanges keeps an open HTML comment enclosing a line that merely resembles a raw-text closer', () => {
  const tick = String.fromCharCode(96);
  // Issue #1895 reproduction: `</script>` appears here only as plain text
  // inside a still-open, unclosed `<!--` comment. The old backward scan read
  // it as a genuine raw-text closer and gave up before reaching the real
  // `<!--` opener further back, wrongly treating the following line as an
  // ordinary paragraph and masking the policy text.
  const body = `> <!--\n> mentions </script> as text\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps an open HTML comment enclosing content across a blank line inside it', () => {
  const tick = String.fromCharCode(96);
  // Issue #1895 reproduction (update 1): per CommonMark, a comment closes
  // only on its own `-->` token, never on a blank line -- unlike a generic
  // (type 6/7) HTML block. The old scan's `crossedBlankLine` gate applied
  // uniformly to every family, so a blank line inside a still-open comment
  // wrongly ended recognition.
  const body = `> <!--\n>\n> comment continues\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges masks normally once an HTML comment closes on its own separate line', () => {
  const tick = String.fromCharCode(96);
  // Issue #1895 reproduction (update 2): the converse, over-cautious
  // direction -- a comment that closes via its own `-->` token on a
  // separate (not the opener's) line was never recognized as closed,
  // because the old scan only checked a same-line self-close. This is a
  // genuine non-boundary case: the following paragraph masks normally.
  const body = `> <!--\n> comment body\n> -->\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges keeps an open HTML comment enclosing a bare list item that merely resembles a raw-text closer', () => {
  const tick = String.fromCharCode(96);
  // Issue #1895 update comment: since #1894's fix made this scan reachable
  // from a bare, blockquote-free list item too, the same resembles-a-closer
  // gap applies there.
  const body = `- <!-- comment start\n  says </script> here\n  Example ${tick}code\ncontinues text${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps an open HTML comment enclosing a bare list item across a blank line inside it', () => {
  const tick = String.fromCharCode(96);
  // Issue #1895 update comment: the blank-line gap is reachable from a bare
  // list item too, same root cause as the blockquote form above.
  const body = `- <!-- comment start\n\n  Example ${tick}code\ncontinues text${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps an open generic HTML block enclosing a line that merely resembles a raw-text closer', () => {
  const tick = String.fromCharCode(96);
  // Same root cause as the three cases above, one more manifestation not
  // named in the issue: the old scan returned "not enclosed" as soon as it
  // saw ANY raw-text-close-shaped line, regardless of state, so a stray
  // `</script>` here still short-circuited before reaching the real `<div>`
  // opener further back. The new scan only treats a raw-text close as
  // significant while a raw-text state is actually open, so it correctly
  // continues past the stray closer and finds the still-open generic block.
  const body = `> <div>\n> </script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges treats a bare stray raw-text closer with no enclosing block as inert', () => {
  const tick = String.fromCharCode(96);
  // Sanity check for the other side of the same change: with no HTML block
  // open at all, a stray `</script>`-shaped line changes nothing -- this
  // matches both the old and the new scan, since nothing was ever "closed".
  const body = `> </script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

// #1896: findMarkdownBlockBoundary must consult isWithinOpenHtmlBlock's
// backward scan at depth 0 too, not only to gate a later line's laziness
// exception -- a still-open raw/custom HTML block enclosing the opening
// line must prevent the code span from ever forming, at any container
// depth, even when the continuation line already satisfies the list's own
// content indent (so #1894's list-content-indent fix alone does not treat
// it as a boundary).

test('findMarkdownCodeRanges never forms a span opened inside a still-open bare list HTML block', () => {
  const tick = String.fromCharCode(96);
  // Issue #1896's own reproduction: line 3 stays indented (2 spaces,
  // matching the list's content indent from `- `), so #1894's
  // list-content-indent fix alone does not treat it as a boundary -- before
  // this fix, the span still incorrectly closed across it because nothing
  // in the depth-0 path recognized the still-open `<script>` block.
  const body = `- <script>\n  Example ${tick}ignore\n  repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges never forms a span opened inside a still-open quoted HTML block whose continuation stays quoted', () => {
  const tick = String.fromCharCode(96);
  // The blockquote analog of the same gap (the issue's Proposed Change asks
  // for this "at any container depth"): every line keeps its `>` marker, so
  // the existing depth-mismatch boundary path (see the sibling test above,
  // "does not mask a span continued from inside an open raw HTML block",
  // whose final line drops the `>` prefix entirely) never fires either --
  // before this fix, only a laziness-gated dead end left this variant
  // unmasked.
  const body = `> <script>\n> Example ${tick}ignore\n> repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges still forms a same-line span opened by a fresh sibling list item after an unclosed HTML opener', () => {
  const tick = String.fromCharCode(96);
  // Regression guard found during review: a list marker always starts a
  // structurally new block, so a fresh sibling item's own line can never
  // inherit an earlier sibling item's still-open HTML state the way a
  // *continuation* line of the same item can (the two tests above). Without
  // excluding a list-opener opening line from the new #1896 early return,
  // isWithinOpenHtmlBlock's backward scan -- which does not know a fresh
  // list marker unconditionally ends the previous item's content -- would
  // wrongly treat this opening line as still enclosed too, destroying a
  // legitimate same-line span.
  for (const opener of ['<div>', '<script>']) {
    const body = `- ${opener}\n  content inside the first item\n- Second item ${tick}code${tick} span`;
    assert.deepEqual(
      findMarkdownCodeRanges(body),
      [
        {
          start: body.indexOf(tick),
          end: body.lastIndexOf(tick) + 1,
        },
      ],
      opener,
    );
  }
});

test('findMarkdownCodeRanges never forms a span on a marker-shaped line still within an outer open HTML zone', () => {
  const tick = String.fromCharCode(96);
  // Copilot review finding on this PR: the opening line's own content
  // merely *looking like* a list-item marker (e.g. a `<script>` body line
  // that happens to start with `- `) is not proof it is a genuine fresh
  // sibling -- unlike the previous test, this line stays indented (2
  // spaces) within the outer item's own content zone, so it is still raw
  // content inside the still-open block, not a block-terminating sibling.
  // Without the outer-zone disambiguation, the naive "openingListItem !==
  // null" guard alone would wrongly let this masking-bypass span form.
  for (const opener of ['<div>', '<script>']) {
    const body = `- ${opener}\n  - raw content ${tick}that looks like${tick} a marker`;
    assert.deepEqual(findMarkdownCodeRanges(body), [], opener);
  }
});

test('findMarkdownCodeRanges still forms a span on a later unrelated sibling item continuation line', () => {
  const tick = String.fromCharCode(96);
  // Copilot review finding (suppressed comment) on this PR: unlike the
  // previous test's genuinely-nested case, this continuation line belongs
  // to a fresh, unrelated SECOND sibling item -- isWithinOpenHtmlBlock's
  // backward scan has no concept of a list-item boundary on its own (it
  // only stops at a container-depth change), so, unbounded, it would
  // wrongly reach past "- Second item" into the first item's still-open
  // tag and block a span that has nothing to do with it. The scan must be
  // bounded at the nearest enclosing list zone's own opener line.
  for (const opener of ['<div>', '<script>']) {
    const body = `- ${opener}\n  content\n- Second item\n  continues here ${tick}code${tick} span`;
    assert.deepEqual(
      findMarkdownCodeRanges(body),
      [{ start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 }],
      opener,
    );
  }
});

// #1900: isWithinOpenHtmlBlock's raw-text state closed on any of the four
// raw-text closing tags, not specifically the tag that was opened, so a
// mismatched closing tag (e.g. `</style>` while `<script>` is open)
// incorrectly ended tracking -- the dangerous direction, since it let a
// still-open raw-text block be misread as closed and its content wrongly
// masked as an ordinary code span.

test('findMarkdownCodeRanges keeps an open raw-text block enclosing a line that merely resembles the closer for a different raw-text tag', () => {
  const tick = String.fromCharCode(96);
  // Issue #1900 reproduction: `</style>` does not close an open `<script>`
  // block -- only a matching `</script>` does. The old union-pattern close
  // check treated any of the four raw-text closing tags as ending tracking,
  // so it wrongly saw this block as closed and masked the policy text below.
  const body = `> <script>\n> mentions </style> as text\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps a raw-text block open when a same-line mismatched closing tag does not self-close it', () => {
  const tick = String.fromCharCode(96);
  // Issue #1900: the same-line self-close check had the identical bug --
  // `<script>x</style>` on one line was read as self-closed because
  // `</style>` matched the old union pattern, even though it does not close
  // `<script>`. The block must still be open going into the next line.
  const body = `> <script>x</style>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges masks normally once a same-line self-closed raw-text block matches its own tag', () => {
  const tick = String.fromCharCode(96);
  // Regression guard for the matching-tag same-line case: `<script>x</script>`
  // on one line is genuinely self-closed, so the following line is an
  // ordinary fresh paragraph and masks normally, same as the existing
  // separate-line self-close regression guard above.
  const body = `> <script>x</script>\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), [
    { start: body.indexOf(tick), end: body.lastIndexOf(tick) + 1 },
  ]);
});

test('findMarkdownCodeRanges matches the opened raw-text tag case-insensitively', () => {
  const tick = String.fromCharCode(96);
  // The opened tag is captured and lower-cased before being used as a
  // HTML_RAW_TEXT_TAG_CLOSE_PATTERNS key -- verify that bridging holds for a
  // mixed-case open and close, and that a mismatched close (still wrong
  // regardless of case) does not end tracking early.
  const body = `> <SCRIPT>\n> mentions </Style> as text\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

test('findMarkdownCodeRanges keeps an open textarea block enclosing a line that merely resembles a pre closer', () => {
  const tick = String.fromCharCode(96);
  // Same bug, a different tag pair: the fix must not be script/style-specific
  // -- any mismatched pair among the four raw-text tags must fail to close.
  const body = `> <textarea>\n> mentions </pre> as text\n> Example ${tick}ignore\nrepository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
});

// --- findHtmlBlockRanges (#2767, Codex review PR #2840 round 5) -------------

test('findHtmlBlockRanges masks a raw-text block (<pre>) through its own closing tag', () => {
  const body = [
    '<pre>',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '</pre>',
    '',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('Acceptance criteria'), false);
  assert.equal(masked.includes('</pre>'), false);
});

test("findHtmlBlockRanges recognizes a raw-text block opener as a list item's own first line (Codex review, PR #2840, round 11)", () => {
  // `- <pre>` previously tested the unstripped line against the opener
  // pattern (anchored `^ {0,3}<`), which the leading "- " defeated -- the
  // block's content stayed unmasked entirely.
  const body = ['- <pre>', '  x', '  </pre>', ''].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0]?.start, 0);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('x'), false);
  assert.equal(masked.includes('</pre>'), false);
});

test('findHtmlBlockRanges recognizes a raw-text block opener inside a blockquote (Codex review, PR #2840, round 11)', () => {
  const body = ['> <pre>', '> x', '> </pre>', ''].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('x'), false);
});

test('findHtmlBlockRanges stops an unclosed raw-text block at its own blockquote container end (Codex review, PR #2840, round 15)', () => {
  // An unclosed `<pre>` opened inside a blockquote previously scanned to
  // end of text looking for a real `</pre>`, masking real content after
  // the blockquote itself ends. `gh api /markdown` confirms GitHub closes
  // the block at the blockquote's own end, never leaking past it.
  const body = [
    '> <pre>',
    '> still open',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('still open'), false);
  assert.equal(masked.includes('Acceptance criteria'), true);
  assert.equal(masked.includes('[ ] one'), true);
});

test('findHtmlBlockRanges stops an unclosed raw-text block at its own list-item container end (Codex review, PR #2840, round 15)', () => {
  // Same fix, the list-item shape: dedenting to column 0 ends the list
  // item's own content zone, closing the unclosed `<pre>` there too.
  const body = [
    '- <pre>',
    '  still open',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('still open'), false);
  assert.equal(masked.includes('Acceptance criteria'), true);
  assert.equal(masked.includes('[ ] one'), true);
});

test('findHtmlBlockRanges stops an unclosed special block (comment) at its own blockquote container end (Codex review, PR #2840, round 15)', () => {
  const body = [
    '> <!-- comment',
    '> still comment',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('still comment'), false);
  assert.equal(masked.includes('Acceptance criteria'), true);
});

test('findHtmlBlockRanges stops an unclosed generic block (<div>) at its own blockquote container end (Codex review, PR #2840, round 15)', () => {
  const body = [
    '> <div>',
    '> some quoted text',
    '',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('some quoted text'), false);
  assert.equal(masked.includes('Acceptance criteria'), true);
});

test('findHtmlBlockRanges still masks a raw-text block through its own real closing tag inside the same container (control, round 11 behavior preserved by round 15)', () => {
  const body = ['- <pre>', '  x', '  </pre>', ''].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('x'), false);
  assert.equal(masked.includes('</pre>'), false);
});

test("findHtmlBlockRanges opens a custom-tag block as a list item's own first line (Codex review, PR #2840, round 13)", () => {
  // Round 11 fixed the opener-detection *pattern match* for a list-marker
  // prefix but left the custom-tag branch's `previousLineBlank` gate
  // unextended: `- <x-demo>` right after a non-blank *outer* line (here,
  // the preceding list item's own text) is still a fresh list item's own
  // first line -- CommonMark 5.2 -- with no "previous line" inside that
  // new container for the paragraph-interruption rule to apply to.
  // `gh api /markdown` confirms GitHub sanitizes the unknown `<x-demo>`
  // tag and renders its content (including the checkboxes) as literal
  // text, never real list items.
  const body = [
    '- first item bullet text',
    '- <x-demo>',
    '  - [ ] one',
    '  - [ ] two',
    '  </x-demo>',
    '',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  assert.equal(ranges.length, 1);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('first item bullet text'), true);
});

test('findHtmlBlockRanges does not open a custom-tag block mid-list-item-continuation', () => {
  // A continuation line of an *already open* list item (no marker of its
  // own, previous line not blank) is not a fresh container's first line
  // -- the paragraph-interruption rule still applies, matching the
  // existing "cannot interrupt a paragraph" control above.
  const body = ['- first item bullet text', '  <foo>', '  more text', ''].join(
    '\n',
  );
  assert.deepEqual(findHtmlBlockRanges(body), []);
});

test('findHtmlBlockRanges ignores an unclosed raw-text tag that is literal text inside a fenced example (Codex review, PR #2840, round 14)', () => {
  // Without `fencedRanges`, an unclosed `<pre>` inside a fenced example is
  // read as a real HTML block opener with no real closing tag anywhere in
  // `text`, extending the returned range through the remainder of the
  // body -- masking any genuine content after the fence. `gh api
  // /markdown` confirms GitHub renders the whole fenced block as a
  // literal code block; the `<pre>` text inside it never opens anything.
  const body = [
    'Example:',
    '',
    '```',
    '<pre>',
    'unclosed',
    '```',
    '',
    'after',
    '',
  ].join('\n');
  const fencedRanges = findFencedCodeRanges(body);
  assert.deepEqual(findHtmlBlockRanges(body, fencedRanges), []);
  // Control: the same unclosed tag OUTSIDE any fence still masks through
  // end of text (fenced-range skipping must not blunt the real case).
  const control = ['<pre>', 'var x = 1;', ''].join('\n');
  assert.deepEqual(
    findHtmlBlockRanges(control, findFencedCodeRanges(control)),
    [{ start: 0, end: control.length }],
  );
});

test('findHtmlBlockRanges masks an unclosed raw-text block through end of text', () => {
  const body = '<script>\nvar x = 1;\n';
  assert.deepEqual(findHtmlBlockRanges(body), [{ start: 0, end: body.length }]);
});

test('findHtmlBlockRanges masks a generic block-level tag through the next blank line', () => {
  const body = ['<div>', 'some text', '</div>', '', 'after'].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('some text'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges does not open a custom-tag block mid-paragraph (cannot interrupt a paragraph)', () => {
  const body = ['some text', '<foo>', 'more text', ''].join('\n');
  assert.deepEqual(findHtmlBlockRanges(body), []);
});

test('findHtmlBlockRanges does not open a custom-tag block when a complete open+close tag pair shares one line (Codex review, PR #2840, round 18)', () => {
  // CommonMark's real type-7 rule requires the complete tag to be
  // followed only by whitespace through end of line -- `<span>intro</span>`
  // entirely on one line is an ordinary paragraph (`</span>` follows the
  // open tag, not whitespace/EOL), never an HTML block opener. `gh api
  // /markdown` confirms this renders as a real paragraph, and the
  // following heading (no blank line between) still renders as a real
  // heading -- an ATX heading CAN interrupt a paragraph.
  const body = [
    '<span>intro</span>',
    '## Acceptance criteria',
    '',
    '- [ ] one',
    '- [ ] two',
    '',
  ].join('\n');
  assert.deepEqual(findHtmlBlockRanges(body), []);
});

test('findHtmlBlockRanges opens a custom-tag block right after an ATX heading (Codex review, PR #2840, round 20)', () => {
  // An ATX heading is a complete, one-line block -- it leaves no open
  // paragraph behind, so a following custom tag still freely opens even
  // though the heading line itself is not blank. `gh api /markdown`
  // confirms this (the fake checkboxes render as literal text).
  const body = [
    '# Intro',
    '<x-demo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a thematic break (Codex review, PR #2840, round 20)', () => {
  const body = [
    'Intro',
    '',
    '---',
    '<x-demo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a spaced thematic break (Codex review, PR #2840, round 22)', () => {
  // A spaced thematic break (`_ _ _`) is CommonMark-valid too, unlike a
  // tightly-packed one (`---`) it is recognized only by
  // MARKDOWN_THEMATIC_BREAK_PATTERN, not MARKDOWN_INDENTED_CODE_PRECEDER_PATTERN.
  // `gh api /markdown` confirms it ends its own block the same way.
  const body = [
    'Intro',
    '',
    '_ _ _',
    '<x-demo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges still does not open a custom-tag block right after a list-item line (control, round 20)', () => {
  // A list item's own content line can still be, or start, an open
  // paragraph within that item -- unlike a heading or thematic break, it
  // must not be treated as "leaves nothing open". `gh api /markdown`
  // confirms the custom tag here does not open (its content is
  // sanitized away, but the real paragraph after it stays a real,
  // separate paragraph rather than opaque block content).
  const body = ['- some list text', '<x-demo>', 'content', '', 'after'].join(
    '\n',
  );
  assert.deepEqual(findHtmlBlockRanges(body), []);
});

test('findHtmlBlockRanges opens a custom-tag block right after a blank line', () => {
  const body = ['', '<foo>', 'more text', '', 'after'].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('more text'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a same-line self-closed raw-text block (Codex review, PR #2840, round 16)', () => {
  // A closed HTML block leaves no open paragraph behind for a following
  // type-7 (custom tag) opener to interrupt, even though the preceding
  // line is not literally blank. `gh api /markdown` confirms `<foo>`
  // right after `<pre>x</pre>` on the previous line still freely opens
  // (the fake checkboxes render as literal text, not real checkboxes).
  const body = '<pre>x</pre>\n<foo>\n- [ ] one\n- [ ] two\n\nafter';
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a closed fence (Codex review, PR #2840, round 16)', () => {
  const body = [
    '```',
    'code',
    '```',
    '<foo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const fencedRanges = findFencedCodeRanges(body);
  const ranges = findHtmlBlockRanges(body, fencedRanges);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, [
    ...fencedRanges,
    ...ranges,
  ]);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a container-ended raw-text block in a blockquote (Codex review, PR #2840, round 16)', () => {
  const body = [
    '> <pre>',
    '> still open',
    '<foo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges opens a custom-tag block right after a container-ended generic block in a blockquote (Codex review, PR #2840, round 16)', () => {
  const body = [
    '> <div>',
    '> quoted',
    '<foo>',
    '- [ ] one',
    '- [ ] two',
    '',
    'after',
  ].join('\n');
  const ranges = findHtmlBlockRanges(body);
  const masked = maskMarkdownCodeRegionsPreservingPositions(body, ranges);
  assert.equal(masked.includes('[ ] one'), false);
  assert.equal(masked.includes('[ ] two'), false);
  assert.equal(masked.includes('after'), true);
});

test('findHtmlBlockRanges returns [] for a body with no HTML blocks', () => {
  const body = '## Acceptance criteria\n\n- [ ] one\n- [ ] two\n';
  assert.deepEqual(findHtmlBlockRanges(body), []);
});
