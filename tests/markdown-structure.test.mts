#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

import { scanMarkdownStructure } from '../src/scripts/markdown-structure.mts';

// The scanner loads markdown-it, a devDependency. The bare-node lane in
// lint.yml runs every tests/*.test.mts with no node_modules, so those tests
// skip there and run in the installed lanes (the same SKIP precedent as
// tests/check-build-artifacts.test.mts).
const requireFromHere = createRequire(import.meta.url);
function markdownItInstalled(): boolean {
  try {
    requireFromHere.resolve('markdown-it');
    return true;
  } catch {
    return false;
  }
}
const SKIP = markdownItInstalled()
  ? false
  : 'markdown-it is not installed (bare-node lane)';

const EMPTY = {
  codeBlocks: [],
  htmlBlocks: [],
  htmlComments: [],
  listItems: [],
  inlineCode: [],
};

describe('markdown structure: fenced and indented code', { skip: SKIP }, () => {
  it('CommonMark fenced code: a backtick fence reports its lines and content', () => {
    assert.deepEqual(
      scanMarkdownStructure('text\n\n```js\nconst a = 1;\n```\n'),
      {
        ...EMPTY,
        codeBlocks: [
          {
            startLine: 3,
            endLine: 5,
            listDepth: 0,
            quoteDepth: 0,
            kind: 'fenced',
            content: 'const a = 1;\n',
          },
        ],
      },
    );
  });

  it('CommonMark fenced code: a tilde fence is a fenced code block', () => {
    const { codeBlocks } = scanMarkdownStructure('~~~\nx\n~~~\n');
    assert.deepEqual(
      codeBlocks.map((block) => [block.kind, block.startLine, block.endLine]),
      [['fenced', 1, 3]],
    );
  });

  it('CommonMark indented code: a four-space block is an indented code block', () => {
    assert.deepEqual(scanMarkdownStructure('para\n\n    code\n'), {
      ...EMPTY,
      codeBlocks: [
        {
          startLine: 3,
          endLine: 3,
          listDepth: 0,
          quoteDepth: 0,
          kind: 'indented',
          content: 'code\n',
        },
      ],
    });
  });

  it('fenced code: a comment-like string inside a fence is code, not an HTML comment', () => {
    const structure = scanMarkdownStructure(
      '```\n<!-- not a comment -->\n```\n',
    );
    assert.deepEqual(structure, {
      ...EMPTY,
      codeBlocks: [
        {
          startLine: 1,
          endLine: 3,
          listDepth: 0,
          quoteDepth: 0,
          kind: 'fenced',
          content: '<!-- not a comment -->\n',
        },
      ],
    });
    assert.deepEqual(structure.htmlComments, []);
    assert.deepEqual(structure.htmlBlocks, []);
  });

  it('fenced code: a fence inside a list item is reported at listDepth 1', () => {
    const structure = scanMarkdownStructure('- item\n\n  ```js\n  x\n  ```\n');
    assert.deepEqual(
      structure.codeBlocks.map((block) => ({
        kind: block.kind,
        startLine: block.startLine,
        endLine: block.endLine,
        listDepth: block.listDepth,
      })),
      [{ kind: 'fenced', startLine: 3, endLine: 5, listDepth: 1 }],
    );
    assert.deepEqual(
      structure.listItems.map((item) => [item.startLine, item.listDepth]),
      [[1, 0]],
    );
  });

  it('fenced code: an unclosed fence runs to the end of the body', () => {
    assert.deepEqual(scanMarkdownStructure('```\nabc').codeBlocks, [
      {
        startLine: 1,
        endLine: 2,
        listDepth: 0,
        quoteDepth: 0,
        kind: 'fenced',
        content: 'abc',
      },
    ]);
  });

  it('fenced code: a fence inside a block quote reports quoteDepth 1', () => {
    const { codeBlocks } = scanMarkdownStructure('> ```\n> q\n> ```\n');
    assert.deepEqual(
      codeBlocks.map((block) => [
        block.startLine,
        block.endLine,
        block.quoteDepth,
      ]),
      [[1, 3, 1]],
    );
  });

  it('line endings: a CRLF body reports lines after CR and CRLF normalization', () => {
    const { codeBlocks } = scanMarkdownStructure('a\r\n```\r\nx\r\n```');
    assert.deepEqual(
      codeBlocks.map((block) => [block.startLine, block.endLine]),
      [[2, 4]],
    );
  });
});

describe('markdown structure: HTML blocks and comments', { skip: SKIP }, () => {
  it('CommonMark HTML block type 6: the block ends at the first blank line', () => {
    assert.deepEqual(scanMarkdownStructure('<div>\nfoo\n\n*bar*\n'), {
      ...EMPTY,
      htmlBlocks: [
        {
          startLine: 1,
          endLine: 2,
          listDepth: 0,
          quoteDepth: 0,
          content: '<div>\nfoo\n',
        },
      ],
    });
  });

  it('CommonMark HTML block type 2: a comment block ends at its closing delimiter, not a blank line', () => {
    const structure = scanMarkdownStructure('<!-- a\n\nb -->\n\ntext');
    assert.deepEqual(
      structure.htmlBlocks.map((block) => [block.startLine, block.endLine]),
      [[1, 3]],
    );
    assert.deepEqual(structure.htmlComments, [
      {
        startLine: 1,
        endLine: 3,
        listDepth: 0,
        quoteDepth: 0,
        inline: false,
        content: '<!-- a\n\nb -->\n',
      },
    ]);
  });

  it('HTML comments: an inline comment inside a paragraph is reported as inline', () => {
    assert.deepEqual(
      scanMarkdownStructure('text <!-- note --> more').htmlComments,
      [
        {
          startLine: 1,
          endLine: 1,
          listDepth: 0,
          quoteDepth: 0,
          inline: true,
          content: '<!-- note -->',
        },
      ],
    );
  });

  it('HTML comments: a comment-like string inside a code span is not a comment', () => {
    const structure = scanMarkdownStructure('`<!-- x -->`');
    assert.deepEqual(structure.htmlComments, []);
    assert.deepEqual(
      structure.inlineCode.map((span) => span.content),
      ['<!-- x -->'],
    );
  });
});

describe('markdown structure: list items', { skip: SKIP }, () => {
  it('CommonMark list items: nested items report their depth and ordered flag', () => {
    assert.deepEqual(
      scanMarkdownStructure('1. one\n   - two\n     - three\n').listItems.map(
        (item) => [item.startLine, item.listDepth, item.ordered],
      ),
      [
        [1, 0, true],
        [2, 1, false],
        [3, 2, false],
      ],
    );
  });
});

describe('markdown structure: inline code spans', { skip: SKIP }, () => {
  it('CommonMark code spans: a backslash-escaped backtick does not open a span', () => {
    assert.deepEqual(
      scanMarkdownStructure('\\`not code\\` and `real`').inlineCode.map(
        (span) => span.content,
      ),
      ['real'],
    );
  });

  it('CommonMark code spans: a double-backtick span keeps an inner backtick', () => {
    assert.deepEqual(
      scanMarkdownStructure('``a`b``').inlineCode.map((span) => span.content),
      ['a`b'],
    );
  });

  it('CommonMark code spans: a span reports the line range of its paragraph', () => {
    assert.deepEqual(scanMarkdownStructure('one\n`two`\nthree').inlineCode, [
      {
        startLine: 1,
        endLine: 3,
        listDepth: 0,
        quoteDepth: 0,
        content: 'two',
      },
    ]);
  });
});

describe('markdown structure: plain bodies', { skip: SKIP }, () => {
  it('a plain paragraph yields no structure', () => {
    assert.deepEqual(scanMarkdownStructure('just words\n'), EMPTY);
  });
});
