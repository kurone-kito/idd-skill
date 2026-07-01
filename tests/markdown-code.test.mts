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

test('stripMarkdownCodeRegions leaves HTML comments and plain text intact', () => {
  const body = 'plain <!-- idd-skill-blocked-by: parent --> text';
  assert.equal(stripMarkdownCodeRegions(body), body);
});

test('stripMarkdownCodeRegions does not let a shorter inner fence close a longer one', () => {
  const body = ['~~~~', '~~~', 'still inside #9', '~~~~', 'out'].join('\n');
  assert.equal(
    stripMarkdownCodeRegions(body),
    ['', '', '', '', 'out'].join('\n'),
  );
});
