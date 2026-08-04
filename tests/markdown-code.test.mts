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
