import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
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
  // #1898 (partial, folded into #1894's PR): findMarkdownBlockBoundary's own
  // parseFencedLine call did not thread the active list-content indent, so
  // a fence marker pushed past column 3 by wide list-marker padding (`-`
  // plus 4 spaces, content indent 5) was invisible as a block start. An
  // inline span opened on the line above then ran straight through the
  // fence line -- which itself is not a real closing backtick run for a
  // 1-backtick opener -- and only stopped at the next lone backtick,
  // masking "repository policy" and the fence markers as one long span.
  // With the fence line recognized as a boundary, the span search stops
  // there instead, finds no closing backtick before it, and (per the
  // stray-backtick fail-open guard) masks nothing.
  const body = `-    Example ${tick}ignore\n     ${tick.repeat(3)}\n     repository policy${tick}`;
  assert.deepEqual(findMarkdownCodeRanges(body), []);
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
