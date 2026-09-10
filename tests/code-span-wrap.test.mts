import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findCorruptingCodeSpanWraps,
  findCorruptingProseWraps,
} from '../src/scripts/code-span-wrap.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

test('flags a hyphen mid-token line break inside an inline code span', () => {
  const violations = findCorruptingCodeSpanWraps('see `foo-\nbar` here');
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { line: 1, before: 'foo-', after: 'bar' });
});

test('flags an underscore mid-token line break', () => {
  assert.equal(findCorruptingCodeSpanWraps('see `foo_\nbar` here').length, 1);
});

test('flags a slash mid-token line break', () => {
  assert.equal(findCorruptingCodeSpanWraps('see `foo/\nbar` here').length, 1);
});

test('flags a dot mid-token line break', () => {
  assert.equal(findCorruptingCodeSpanWraps('see `foo.\nbar` here').length, 1);
});

test('does not flag a break at a real word boundary (space before the break)', () => {
  assert.deepEqual(findCorruptingCodeSpanWraps('see `foo bar\nbaz` here'), []);
});

test('does not flag a slash preceded by a space (word-separator slash, not a path)', () => {
  // "prerequisite /" then a line break: the char ending the line is '/',
  // but the char before it is a space, not alphanumeric, so this is the
  // "or / and"-style prose separator, not a corrupting path split.
  assert.deepEqual(
    findCorruptingCodeSpanWraps('`prerequisite /\nmissing`'),
    [],
  );
});

test('does not flag when the next line starts with a non-alphanumeric character', () => {
  assert.deepEqual(findCorruptingCodeSpanWraps('`foo-\n)bar`'), []);
});

test('flags a relative-path prefix split (./ before the break)', () => {
  // PR #1736 review (Copilot): prevPrevChar '.' was previously rejected
  // by a strict alphanumeric-only neighbor check, missing this real
  // corrupting split of `./scripts/foo.mjs`.
  const violations = findCorruptingCodeSpanWraps('`./\nscripts/foo.mjs`');
  assert.equal(violations.length, 1);
});

test('flags a parent-relative path prefix split (../ before the break)', () => {
  const violations = findCorruptingCodeSpanWraps('`../\nscripts/foo.mjs`');
  assert.equal(violations.length, 1);
});

test('flags a hidden-dotfile split (nextChar is a literal dot)', () => {
  // PR #1736 review (Copilot): nextChar '.' was previously rejected,
  // missing `path/.gitignore` splitting as `path/` / `.gitignore`.
  const violations = findCorruptingCodeSpanWraps('`path/\n.gitignore`');
  assert.equal(violations.length, 1);
});

test('flags a doubled-flag-dash split (prevPrevChar is the other hyphen)', () => {
  // PR #1736 review (Codex): `--flag` splitting as `--` / `flag` was
  // previously missed because prevPrevChar (the first `-`) failed the
  // old strict alphanumeric check.
  const violations = findCorruptingCodeSpanWraps('`--\nflag`');
  assert.equal(violations.length, 1);
});

test('flags a single-character absolute-path prefix split (span starts with the break char)', () => {
  // PR #1736 follow-up review (Codex): `/usr/bin` splitting as `/` /
  // `usr/bin` was still missed after the two-character-prefix fix,
  // because prevPrevChar is `undefined` when the continuation
  // character is the very first character of the span -- there is no
  // character before it to disqualify the match.
  const violations = findCorruptingCodeSpanWraps('`/\nusr/bin`');
  assert.equal(violations.length, 1);
});

test('flags a single-character flag prefix split (span starts with the break char)', () => {
  const violations = findCorruptingCodeSpanWraps('`-\nflag`');
  assert.equal(violations.length, 1);
});

test('flags a single-character hidden-dotfile prefix split (span starts with the break char)', () => {
  const violations = findCorruptingCodeSpanWraps('`.\ngitignore`');
  assert.equal(violations.length, 1);
});

test('flags a single-character underscore prefix split (span starts with the break char)', () => {
  const violations = findCorruptingCodeSpanWraps('`_\nprivate`');
  assert.equal(violations.length, 1);
});

test('still does not flag a slash preceded by a space after broadening the neighbor check', () => {
  // Regression guard: broadening prevPrevChar/nextChar to accept
  // continuation characters must not undo the space-boundary exclusion.
  assert.deepEqual(
    findCorruptingCodeSpanWraps('`prerequisite /\nmissing`'),
    [],
  );
});

test('skips fenced code blocks entirely', () => {
  const body = ['```', 'foo-', 'bar', '```'].join('\n');
  assert.deepEqual(findCorruptingCodeSpanWraps(body), []);
});

test('reports the 1-based line number of the line ending mid-token', () => {
  const body = ['before text', 'more `foo-', 'bar` tail'].join('\n');
  const violations = findCorruptingCodeSpanWraps(body);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

test('finds every corrupting break when a span crosses more than one line', () => {
  const violations = findCorruptingCodeSpanWraps('`foo-\nbar_\nbaz`');
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.line),
    [1, 2],
  );
});

test('real-corpus regression: a known word-boundary multi-line span is not flagged', () => {
  // .claude/skills/issue-authoring/references/draft-patterns.md line 19-20
  // wraps `issue-scope:\norphan-first` — the line ends with ':', a real
  // word/punctuation boundary, not one of the corrupting continuation
  // chars, so it must never be flagged.
  const text = readFileSync(
    join(
      REPO_ROOT,
      '.claude/skills/issue-authoring/references/draft-patterns.md',
    ),
    'utf8',
  );
  assert.deepEqual(findCorruptingCodeSpanWraps(text), []);
});

// idd-skill issue #2876: findCorruptingProseWraps flags a hyphenated
// compound word wrapped right after the hyphen inside `**`/`*` emphasis
// text, outside code spans.

test('findCorruptingProseWraps: flags this issue’s own incident (bold emphasis, hyphen mid-token wrap)', () => {
  // Reproduces PR #2875's incident: "**infrastructure/transport-layer
  // failure**" hard-wrapped as "transport-\n  layer" inside bold emphasis.
  const violations = findCorruptingProseWraps(
    'a **infrastructure/transport-\n  layer failure** occurred',
  );
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    line: 1,
    before: 'structure/transport-',
    after: 'layer failure',
  });
});

test('findCorruptingProseWraps: flags a hyphen mid-token wrap inside single-* italic emphasis', () => {
  const violations = findCorruptingProseWraps('*well-\nknown* term');
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { line: 1, before: 'well-', after: 'known' });
});

test('findCorruptingProseWraps: does not flag a word-boundary wrap inside bold emphasis', () => {
  assert.deepEqual(findCorruptingProseWraps('**foo bar\nbaz** text'), []);
});

test('findCorruptingProseWraps: does not misread a bullet-list `*` marker as an emphasis opener', () => {
  assert.deepEqual(findCorruptingProseWraps('* item-\nfoo\n* other'), []);
});

test('findCorruptingProseWraps: does not flag a hyphen mid-token wrap inside a code span', () => {
  // Code-span wraps stay findCorruptingCodeSpanWraps's own concern; this
  // function must not double-flag them.
  assert.deepEqual(findCorruptingProseWraps('`foo-\nbar` plain text'), []);
});

test('findCorruptingProseWraps: does not flag prose text with no emphasis markers at all', () => {
  assert.deepEqual(
    findCorruptingProseWraps('plain transport-\nlayer text, no emphasis'),
    [],
  );
});

test('findCorruptingProseWraps: does not flag when the hyphen sits right before the closing delimiter', () => {
  // Nothing continues the "token" after the hyphen but the closing `**`
  // itself, so this is not a corrupted compound word.
  assert.deepEqual(findCorruptingProseWraps('**foo-\n**bar'), []);
});

test('findCorruptingProseWraps: does not flag a hyphen at the very start of an emphasis span (no left-side token)', () => {
  // PR #2880 review (Copilot): a hyphen with nothing before it in the
  // span (prevPrevChar undefined) is not a compound-word join -- e.g. a
  // hyphen/flag-style prefix like "*-flag*", not "well-known".
  assert.deepEqual(findCorruptingProseWraps('*-\nflag* text'), []);
  assert.deepEqual(findCorruptingProseWraps('**-\nflag** text'), []);
});

test('findCorruptingProseWraps: does not flag a multi-line emphasis example quoted inside an HTML comment', () => {
  // PR #2880 review (Codex): CommonMark never renders HTML comment
  // content as emphasis, so an example quoted inside one (this rule's
  // own kind of illustrative comment) must not be flagged.
  assert.deepEqual(
    findCorruptingProseWraps('<!-- example: **well-\nknown** -->'),
    [],
  );
});

test('findCorruptingProseWraps: still flags a real violation outside an unrelated HTML comment', () => {
  // Regression guard: masking HTML comments must not also mask real
  // prose that merely sits near one.
  const violations = findCorruptingProseWraps(
    '<!-- note --> **transport-\nlayer** failure',
  );
  assert.equal(violations.length, 1);
});

test('findCorruptingProseWraps: still flags a real violation preceding an unterminated HTML comment', () => {
  // An unterminated `<!--` masks through end of text (mirrors
  // resolved-decision.mts's own findHtmlCommentRanges close-scan), so a
  // real violation entirely before it must still be found.
  const violations = findCorruptingProseWraps(
    '**transport-\nlayer** failure <!-- unterminated',
  );
  assert.equal(violations.length, 1);
});

test('findCorruptingProseWraps: does not flag an indented code block containing literal emphasis markers', () => {
  // PR #2880 review (Codex): a 4-space-indented code block renders
  // literally, preserving its own line break, so it must not be scanned
  // as prose emphasis.
  const body = [
    'before text',
    '',
    '    **well-',
    '    known**',
    '',
    'after',
  ].join('\n');
  assert.deepEqual(findCorruptingProseWraps(body), []);
});

test('findCorruptingProseWraps: does not flag prose between two asterisk thematic-break lines', () => {
  // PR #2880 review (CodeRabbit): a standalone `***` line is a thematic
  // break, never an emphasis delimiter, so the prose between two of them
  // must not be misread as one emphasis span.
  const violations = findCorruptingProseWraps('***\nwell-\nknown\n***');
  assert.deepEqual(violations, []);
});

test('findCorruptingProseWraps: still flags a real violation inside a genuine emphasis span next to a thematic break', () => {
  // Regression guard: blanking thematic-break lines must not also blank
  // a real, separate emphasis span elsewhere in the document.
  const body = ['***', '', 'a **transport-', 'layer** failure'].join('\n');
  const violations = findCorruptingProseWraps(body);
  assert.equal(violations.length, 1);
});

test('findCorruptingProseWraps: an HTML comment with a stray backtick does not swallow real prose into a bogus code span', () => {
  // PR #2880 review (Codex): comments must be masked before code-region
  // detection runs, or a lone backtick inside one can pair with a later
  // real backtick and blank the real prose between them.
  const violations = findCorruptingProseWraps(
    '<!-- ` --> **well-\nknown** `text`',
  );
  assert.equal(violations.length, 1);
});

test('findCorruptingProseWraps: does not flag literal emphasis markers inside a raw HTML block', () => {
  // PR #2880 review (Codex): CommonMark renders a raw HTML block's
  // contents literally, never as emphasis, so a wrapped `*...*` example
  // inside e.g. `<pre>` must not be scanned as prose.
  assert.deepEqual(
    findCorruptingProseWraps(
      ['<pre>', '*well-', 'known*', '</pre>'].join('\n'),
    ),
    [],
  );
});

test('findCorruptingProseWraps: does not flag emphasis starting right after an escaped delimiter', () => {
  // PR #2880 review (Codex): CommonMark never treats an escaped `*` as a
  // real emphasis opener, so the asterisks and text after it are literal,
  // not emphasis, and must not be scanned as if they were.
  assert.deepEqual(findCorruptingProseWraps('\\*well-\nknown* text'), []);
});

test('findCorruptingProseWraps: still flags a real violation elsewhere when an earlier escaped delimiter is present', () => {
  // Regression guard: ignoring an escaped opener must not also blank a
  // later, genuine emphasis span.
  const violations = findCorruptingProseWraps(
    '\\*literal* then **transport-\nlayer** failure',
  );
  assert.equal(violations.length, 1);
});

test('findCorruptingProseWraps: a real fixture file with emphasis markup has no corrupting hyphen wraps', () => {
  // This checks one specific fixture (which does contain `**bold**`
  // emphasis, e.g. its "**Example**:" line -- PR #2880 review, Copilot),
  // not a full repository corpus scan; that end-to-end check lives in
  // audit-code-span-wrap.test.mts's auditCodeSpanWraps() regression.
  const text = readFileSync(
    join(
      REPO_ROOT,
      '.claude/skills/issue-authoring/references/draft-patterns.md',
    ),
    'utf8',
  );
  assert.deepEqual(findCorruptingProseWraps(text), []);
});
