// idd-generated-from: src/scripts/markdown-structure.mts
//
// The scripts/markdown-structure.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// A CommonMark structure scanner for the draft-carrier checks (#4269). It
// replaces a hand-rolled scanner with markdown-it in `commonmark` mode, so
// block and inline boundaries follow the CommonMark specification.
//
// markdown-it is a devDependency, so it is loaded lazily through
// createRequire, the same way build-ts.mts reaches its own devDependencies.
// A bare import specifier under src/** fails lint-source-boundaries, and the
// bare-node lint lane runs with no node_modules. Nothing here resolves the
// parser at module load; only a scan call does.
//
// Positions are 1-based, inclusive line numbers over the body after CR and
// CRLF normalization. markdown-it reports line maps for block tokens but no
// source positions for inline children, so an inline code span reports the
// line range of its paragraph. A code span cannot cross a block boundary,
// so that range is exact at block level.

import { createRequire } from 'node:module';

/** A span of whole lines in the scanned body. */
interface MarkdownLineSpan {
  readonly startLine: number;
  readonly endLine: number;
}

/** A block-level position, with the containers that enclose it. */
interface MarkdownBlock extends MarkdownLineSpan {
  /** Number of list items that enclose this block; 0 at the top level. */
  readonly listDepth: number;
  /** Number of block quotes that enclose this block; 0 at the top level. */
  readonly quoteDepth: number;
}

interface MarkdownCodeBlock extends MarkdownBlock {
  /** `fenced` for ``` or ~~~ fences, `indented` for four-space blocks. */
  readonly kind: 'fenced' | 'indented';
  /** The code text as markdown-it reports it, trailing newline included. */
  readonly content: string;
}

interface MarkdownHtmlBlock extends MarkdownBlock {
  /** The raw HTML block text as markdown-it reports it. */
  readonly content: string;
}

interface MarkdownHtmlComment extends MarkdownBlock {
  /**
   * `false` for a comment that opens an HTML block (CommonMark HTML block
   * type 2); `true` for a comment inside a paragraph. A comment nested
   * inside another HTML block is part of that block's `htmlBlocks` entry.
   */
  readonly inline: boolean;
  readonly content: string;
}

interface MarkdownListItem extends MarkdownBlock {
  /** Whether the enclosing list is an ordered list. */
  readonly ordered: boolean;
}

interface MarkdownInlineCode extends MarkdownBlock {
  /** The code span's text after CommonMark normalization. */
  readonly content: string;
}

/** The structure the draft-carrier checks read from a Markdown body. */
// audit:ignore-dead-export: consumed by issue #4250
export interface MarkdownStructure {
  readonly codeBlocks: readonly MarkdownCodeBlock[];
  readonly htmlBlocks: readonly MarkdownHtmlBlock[];
  readonly htmlComments: readonly MarkdownHtmlComment[];
  readonly listItems: readonly MarkdownListItem[];
  readonly inlineCode: readonly MarkdownInlineCode[];
}

/** The subset of a markdown-it token this module reads. */
interface RawToken {
  readonly type: string;
  readonly content: string;
  readonly map: readonly [number, number] | null;
  readonly children: readonly RawToken[] | null;
}

interface MarkdownParser {
  parse(source: string, env: object): readonly RawToken[];
}

interface MarkdownItConstructor {
  new (preset: 'commonmark'): MarkdownParser;
}

/** An open container on the token walk: a list, a list item, or a quote. */
interface Container {
  readonly kind: 'list' | 'item' | 'quote';
  readonly ordered: boolean;
}

const requireFromHere = createRequire(import.meta.url);
let markdownItConstructor: MarkdownItConstructor | undefined;

/** Resolves markdown-it on first use, never at module load. */
function loadMarkdownIt(): MarkdownItConstructor {
  markdownItConstructor ??= requireFromHere(
    'markdown-it',
  ) as MarkdownItConstructor;
  return markdownItConstructor;
}

function spanOf(token: RawToken): MarkdownLineSpan {
  if (token.map === null) {
    throw new Error(`markdown-it ${token.type} token has no line map`);
  }
  // markdown-it's map is [first 0-based line, one past the last line].
  return { startLine: token.map[0] + 1, endLine: token.map[1] };
}

function countKind(containers: readonly Container[], kind: Container['kind']) {
  return containers.filter((container) => container.kind === kind).length;
}

function blockOf(
  token: RawToken,
  containers: readonly Container[],
): MarkdownBlock {
  return {
    ...spanOf(token),
    listDepth: countKind(containers, 'item'),
    quoteDepth: countKind(containers, 'quote'),
  };
}

/**
 * Scan a Markdown body and report the constructs the draft-carrier checks
 * need: fenced and indented code, HTML blocks and comments, list items, and
 * inline code spans. The scan follows CommonMark via markdown-it's
 * `commonmark` preset, so a comment-like string inside a fence is code, a
 * backslash-escaped backtick opens no span, and an HTML block ends at the
 * CommonMark rule for its type.
 */
// audit:ignore-dead-export: consumed by issue #4250
export function scanMarkdownStructure(body: string): MarkdownStructure {
  const MarkdownIt = loadMarkdownIt();
  const parser = new MarkdownIt('commonmark');
  const tokens = parser.parse(body.replace(/\r\n?/gu, '\n'), {});

  const codeBlocks: MarkdownCodeBlock[] = [];
  const htmlBlocks: MarkdownHtmlBlock[] = [];
  const htmlComments: MarkdownHtmlComment[] = [];
  const listItems: MarkdownListItem[] = [];
  const inlineCode: MarkdownInlineCode[] = [];
  const containers: Container[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'blockquote_open':
        containers.push({ kind: 'quote', ordered: false });
        break;
      case 'bullet_list_open':
        containers.push({ kind: 'list', ordered: false });
        break;
      case 'ordered_list_open':
        containers.push({ kind: 'list', ordered: true });
        break;
      case 'list_item_open': {
        const list = containers.findLast((container) => {
          return container.kind === 'list';
        });
        listItems.push({
          ...blockOf(token, containers),
          ordered: list?.ordered ?? false,
        });
        containers.push({ kind: 'item', ordered: false });
        break;
      }
      case 'blockquote_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
        containers.pop();
        break;
      case 'fence':
        codeBlocks.push({
          ...blockOf(token, containers),
          kind: 'fenced',
          content: token.content,
        });
        break;
      case 'code_block':
        codeBlocks.push({
          ...blockOf(token, containers),
          kind: 'indented',
          content: token.content,
        });
        break;
      case 'html_block': {
        const block = blockOf(token, containers);
        htmlBlocks.push({ ...block, content: token.content });
        if (token.content.trimStart().startsWith('<!--')) {
          htmlComments.push({
            ...block,
            inline: false,
            content: token.content,
          });
        }
        break;
      }
      case 'inline': {
        const block = blockOf(token, containers);
        for (const child of token.children ?? []) {
          if (child.type === 'code_inline') {
            inlineCode.push({ ...block, content: child.content });
          } else if (
            child.type === 'html_inline' &&
            child.content.startsWith('<!--')
          ) {
            htmlComments.push({
              ...block,
              inline: true,
              content: child.content,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  return { codeBlocks, htmlBlocks, htmlComments, listItems, inlineCode };
}
