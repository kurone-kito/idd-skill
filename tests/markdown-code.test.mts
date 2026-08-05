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
