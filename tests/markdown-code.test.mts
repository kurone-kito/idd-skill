import assert from 'node:assert/strict';
import { test } from 'node:test';

import { stripMarkdownCodeRegions } from '../src/scripts/markdown-code.mts';

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
