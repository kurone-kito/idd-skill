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

test('flags both reproduced literal-space splits with their source context', () => {
  const first = findCorruptingCodeSpanWraps(
    'Run `idd- claim.instructions.md`.',
  );
  assert.deepEqual(first, [
    {
      line: 1,
      before: 'idd-',
      after: 'claim.instructions.m',
      separator: 'literal-space',
    },
  ]);

  const second = findCorruptingCodeSpanWraps(
    'Run `resume-claim- routing --assert`.',
  );
  assert.deepEqual(second, [
    {
      line: 1,
      before: 'resume-claim-',
      after: 'routing --assert',
      separator: 'literal-space',
    },
  ]);
});

test('flags literal spaces and tabs after every token delimiter', () => {
  for (const delimiter of ['-', '_', '/', '.']) {
    for (const [whitespace, separator] of [
      [' ', 'literal-space'],
      ['\t', 'literal-tab'],
    ] as const) {
      const violations = findCorruptingCodeSpanWraps(
        `see \`foo${delimiter}${whitespace}bar\` here`,
      );
      assert.deepEqual(
        violations,
        [
          {
            line: 1,
            before: `foo${delimiter}`,
            after: 'bar',
            separator,
          },
        ],
        `${JSON.stringify(whitespace)} after ${delimiter}`,
      );
    }
  }
});

test('reports the source line containing a literal-space split', () => {
  const violations = findCorruptingCodeSpanWraps(
    ['first line', 'see `foo- bar` here'].join('\n'),
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

test('does not flag the three current sentence-punctuation examples', () => {
  const sentencePunctuationExamples = [
    [
      'examples/minimal-run/claim-comment.md',
      '`copilot-cli-abc12345: issue claim — IDD automation marker. Do not edit.`',
    ],
    [
      'examples/minimal-run/heartbeat.md',
      '`copilot-cli-abc12345: issue claim — IDD automation marker. Do not edit.`',
    ],
    [
      'docs/harness-orchestrated-execution-investigation.md',
      '`_{agent-id}: issue claim — IDD automation marker. Do not edit._`',
    ],
  ] as const;

  for (const [source, span] of sentencePunctuationExamples) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], source);
  }
});

test('does not flag lowercase text after a standalone numbered step', () => {
  for (const span of ['`1. first step`', '`2. continue here`']) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not flag common abbreviations before lowercase prose', () => {
  for (const span of [
    '`Use e.g. this option`',
    '`(e.g. this option)`',
    '`Use i.e. that option`',
    '`Use etc. in the next step`',
    '`Compare vs. another case`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not flag common title abbreviations before names', () => {
  for (const span of [
    '`See Dr. Smith`',
    '`Contact Prof. Nguyen`',
    '`Ask Mr. Lee`',
    '`Visit St. Louis`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('still flags dotted identifiers whose suffix resembles an abbreviation', () => {
  for (const [span, before, after] of [
    ['`Namespace.e.g. type`', 'Namespace.e.g.', 'type'],
    ['`path/e.g. result`', 'path/e.g.', 'result'],
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [
      {
        line: 1,
        before,
        after,
        separator: 'literal-space',
      },
    ]);
  }
});

test('flags uppercase dotted-token continuations', () => {
  for (const span of [
    '`README. MD`',
    '`config. JSON`',
    '`Namespace. Type`',
    '`Namespace1. Type`',
  ]) {
    const [before, after] = span.slice(1, -1).split('. ');
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [
      {
        line: 1,
        before: `${before}.`,
        after,
        separator: 'literal-space',
      },
    ]);
  }
});

test('flags lowercase dotted prefixes before capitalized declaration types', () => {
  for (const [span, after] of [
    ['`com.example. MyClass`', 'MyClass'],
    ['`com.example. MyClass extends Base`', 'MyClass extends Base'],
  ]) {
    assert.deepEqual(
      findCorruptingCodeSpanWraps(span),
      [
        {
          line: 1,
          before: 'com.example.',
          after,
          separator: 'literal-space',
        },
      ],
      span,
    );
  }
});

test('flags simple and qualified declaration targets', () => {
  for (const span of [
    '`com.example. MyClass implements Base`',
    '`com.example. MyClass permits Base`',
    '`com.example. MyClass extends com.other.Base`',
    '`com.example. MyClass implements org.api.Interface`',
    '`com.example. MyClass permits org.sealed.Subclass`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before, 'com.example.', span);
  }
});

test('flags complete declaration tails with generic and combined types', () => {
  for (const span of [
    '`com.example. MyClass extends Base<T>`',
    '`com.example. MyClass extends Base<List<String>>`',
    '`com.example. MyClass extends Outer.Inner`',
    '`com.example. MyClass extends com.other.Outer.Inner`',
    '`com.example. MyClass implements Comparable<Foo>`',
    '`com.example. MyClass implements Map<String, List<Integer>>`',
    '`com.example. MyClass implements First, Second`',
    '`com.example. MyClass extends Base implements Interface`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before, 'com.example.', span);
  }
});

test('flags qualified types in class extends and method throws clauses', () => {
  for (const [span, type] of [
    ['`class Foo extends com.example. MyClass {}`', 'MyClass'],
    ['`class Foo<T> extends com.example. MyClass {}`', 'MyClass'],
    [
      '`class Foo<T extends Comparable<List<T>>> extends com.example. MyClass {}`',
      'MyClass',
    ],
    [
      '`class Foo<T> extends com.example. MyClass implements Runnable {}`',
      'MyClass',
    ],
    [
      '`interface Foo<T> extends com.example. MyInterface, other.Other {}`',
      'MyInterface',
    ],
    [
      '`interface Foo extends first.One, com.example. MyInterface {}`',
      'MyInterface',
    ],
    [
      '`interface Foo extends Existing<Map<String, Integer>>, com.example. MyInterface {}`',
      'MyInterface',
    ],
    [
      '`interface Foo<T extends Comparable<List<T>>> extends com.example. MyInterface {}`',
      'MyInterface',
    ],
    ['`void run() throws com.example. MyException {}`', 'MyException'],
    [
      '`void run() throws com.example. MyException, java.io.IOException {}`',
      'MyException',
    ],
    [
      '`void run() throws first.One, com.example. MyException {}`',
      'MyException',
    ],
    ['`abstract void run() throws com.example. MyException;`', 'MyException'],
    [
      '`void run() throws com.example. MyException { System.out.println("}"); }`',
      'MyException',
    ],
    ['`void run() throws com.example. MyException { /* } */ }`', 'MyException'],
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.ok(violations[0]?.before.endsWith('com.example.'), span);
    assert.ok(violations[0]?.after.startsWith(type), span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('keeps later malformed clauses from hiding an in-scope extends split', () => {
  const violations = findCorruptingCodeSpanWraps(
    '`class Foo extends com.example. MyClass implements other. Other {}`',
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.before.endsWith('com.example.'), true);
  assert.equal(violations[0]?.after.startsWith('MyClass'), true);
  assert.equal(violations[0]?.separator, 'literal-space');
});

test('preserves dollar and underscore identifiers in qualified declarations', () => {
  const violations = findCorruptingCodeSpanWraps(
    '`class Foo extends $root._internal. MyClass {}`',
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.before.endsWith('$root._internal.'), true);
  assert.equal(violations[0]?.after.startsWith('MyClass'), true);
  assert.equal(violations[0]?.separator, 'literal-space');
});

test('flags declarations inside one balanced outer wrapper', () => {
  for (const span of [
    '`(com.example. MyClass extends Base)`',
    '`[com.example. MyClass implements Base]`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.line, 1, span);
    assert.ok(violations[0]?.before.endsWith('com.example.'), span);
    assert.ok(violations[0]?.after.startsWith('MyClass'), span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('does not flag a sentence after a dotted name', () => {
  for (const span of [
    '`Open example.com. Then continue`',
    '`Visit example.com. GitHub Actions are available.`',
    '`Visit example.com. GitHub supports Actions.`',
    '`Visit example.com. GitHub implements additional features.`',
    '`Visit example.com. GitHub implements Interface.`',
    '`Visit example.com. GitHub implements Interface`',
    '`Visit example.com. GitHub implements OAuth`',
    '`Visit example.com. GitHub permits temporary access.`',
    '`Visit example.com. GitHub extends OAuth.`',
    '`Visit example.com. GitHub implements OAuth.`',
    '`Visit example.com. GitHub permits OAuth.`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not treat incomplete wrappers or trailing prose as declarations', () => {
  for (const span of [
    '`(com.example. MyClass extends Base`',
    '`[com.example. MyClass implements Base`',
    '`(com.example. MyClass extends Base) details`',
    '`[com.example. MyClass implements Base] details`',
    '`(Visit example.com. GitHub implements Interface)`',
    '`[Visit example.com. GitHub implements Interface.]`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not flag sentence periods before prose in multi-tick code examples', () => {
  assert.deepEqual(
    findCorruptingCodeSpanWraps(
      [
        '``limit. Its `slots` value``',
        '``3. If `slots` is zero``',
        '``without B1. Record a `running` task``',
        '`` `Run the command. Verify the output.` ``',
        '`foo. Hello`',
        '`foo. Hello, world`',
        '`foo. Hello!`',
        '`foo. Hello-world`',
        "`foo. It's`",
        '`Run the command. However, stop.`',
        '`Run the command. SSH connects securely`',
        '`foo. Please check`',
        '`foo. Next step`',
        '`foo. Note this`',
        '`POSIX. On Windows, use`',
        '`Command Prompt. Those executables`',
        '`package CLI. From a checkout`',
        '`ExampleType. Hello, world`',
        '`ExampleType. Hello!`',
      ].join('\n'),
    ),
    [],
  );
});

test('does not treat class extends or method throws prose as declarations', () => {
  for (const span of [
    '`A class Foo extends com.example. MyClass is documented here.`',
    '`The method run() throws com.example. MyException during the example.`',
    '`The method run() throws com.example. MyException {}`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not flag legitimate option delimiters, comments, ellipses, or words', () => {
  const spans = [
    '`-- option`',
    '`text -- option`',
    '`. Add`',
    '`<!-- comment opener -->`',
    '`// comment opener`',
    '`value;// comment opener`',
    '`value... continuation`',
    '`git rebase -i`',
    '`--option value`',
    '`ordinary multiword code span`',
  ];

  assert.deepEqual(findCorruptingCodeSpanWraps(spans.join('\n')), []);
});

test('flags a whitespace split in a URL after its scheme slashes', () => {
  assert.deepEqual(findCorruptingCodeSpanWraps('`https:// example.com`'), [
    {
      line: 1,
      before: 'https://',
      after: 'example.com',
      separator: 'literal-space',
    },
  ]);
});

test('does not treat a numeric label followed by // as a URI scheme', () => {
  for (const span of [
    '`case 1:// comment`',
    '`case FOO:// note`',
    '`default:// fall through`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not treat escaped backticks as inline code for literal splits', () => {
  assert.deepEqual(findCorruptingCodeSpanWraps('Example \\`foo- bar\\`'), []);
});

test('does not scan inline code examples inside HTML comments', () => {
  assert.deepEqual(
    findCorruptingCodeSpanWraps('Intro <!-- example: `foo- bar` --> tail'),
    [],
  );
  assert.deepEqual(
    findCorruptingCodeSpanWraps(
      'Intro <!-- example: `foo- bar --> tail `real- code`',
    ),
    [
      {
        line: 1,
        before: 'real-',
        after: 'code',
        separator: 'literal-space',
      },
    ],
  );
});

test('still scans a literal comment opener inside an actual inline code span', () => {
  assert.deepEqual(findCorruptingCodeSpanWraps('`<!-- foo- bar -->`'), [
    {
      line: 1,
      before: '<!-- foo-',
      after: 'bar -->',
      separator: 'literal-space',
    },
  ]);
});

test('flags a literal-space split after a delimiter at the start of a span', () => {
  for (const [span, before, after] of [
    ['`/ usr/bin`', '/', 'usr/bin'],
    ['`. gitignore`', '.', 'gitignore'],
    ['`_ private`', '_', 'private'],
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [
      {
        line: 1,
        before,
        after,
        separator: 'literal-space',
      },
    ]);
  }
  assert.deepEqual(findCorruptingCodeSpanWraps('`- option`'), []);
});

test('does not scan literal backticks in indented code blocks', () => {
  const body = [
    'before text',
    '',
    '    const value = `foo- bar`;',
    '',
    'after text',
    'Run `foo- bar` outside the code block.',
  ].join('\n');
  assert.deepEqual(findCorruptingCodeSpanWraps(body), [
    {
      line: 6,
      before: 'foo-',
      after: 'bar',
      separator: 'literal-space',
    },
  ]);
});

test('does not scan literal backticks in raw HTML blocks', () => {
  const body = [
    '<pre>',
    'const value = `foo- bar`;',
    '</pre>',
    '',
    'Run `foo- bar` outside the HTML block.',
  ].join('\n');
  assert.deepEqual(findCorruptingCodeSpanWraps(body), [
    {
      line: 5,
      before: 'foo-',
      after: 'bar',
      separator: 'literal-space',
    },
  ]);
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

test('returns literal-space and line-break findings in document order', () => {
  const violations = findCorruptingCodeSpanWraps('`foo- bar_\nbaz`');
  assert.deepEqual(
    violations.map((violation) => violation.separator ?? 'line-break'),
    ['literal-space', 'line-break'],
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

// #3705: the inline code span pattern cost about the cube of a backtick run's
// length when the run had no closer: 11 s for 4,000 backticks, where the
// scanner now needs a few milliseconds. Each test times its first, smaller
// size and asserts it before the 100,000 call, so a regression fails after
// seconds instead of hanging the suite. The ceiling stays far above the
// measured cost to ride out a loaded shared host; on a failure here, rerun
// this file alone before suspecting a regression.
const INLINE_CODE_SPAN_LINEAR_CEILING_MS = 2000;
const INLINE_CODE_SPAN_LARGE_RUN = 100_000;

function assertWrapScanLinear(
  label: string,
  firstSize: number,
  buildText: (size: number) => string,
  expectNoViolations: boolean,
): void {
  for (const size of [firstSize, INLINE_CODE_SPAN_LARGE_RUN]) {
    const text = buildText(size);
    const start = performance.now();
    const violations = findCorruptingCodeSpanWraps(text);
    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < INLINE_CODE_SPAN_LINEAR_CEILING_MS,
      `${label} took ${Math.round(elapsedMs)} ms for n = ${size} (ceiling ${INLINE_CODE_SPAN_LINEAR_CEILING_MS} ms)`,
    );
    if (expectNoViolations) assert.deepEqual(violations, []);
  }
}

test('findCorruptingCodeSpanWraps stays linear on an unclosed backtick run before a letter and a newline (#3705)', () => {
  assertWrapScanLinear(
    'findCorruptingCodeSpanWraps',
    4000,
    (size) => `text ${'`'.repeat(size)}a\n`,
    true,
  );
});

test('findCorruptingCodeSpanWraps stays linear on an unclosed backtick run before a blank line, twice (#3705)', () => {
  assertWrapScanLinear(
    'findCorruptingCodeSpanWraps',
    1200,
    (size) => `text ${'`'.repeat(size)}\n\ntext ${'`'.repeat(size)}\n`,
    true,
  );
});

test('findCorruptingCodeSpanWraps stays linear on a long backtick run followed by many one-backtick closers (#3705)', () => {
  // Spans are found here, so only the time is asserted.
  assertWrapScanLinear(
    'findCorruptingCodeSpanWraps',
    1000,
    (size) => `text ${'`'.repeat(size)}${'a`'.repeat(size)}`,
    false,
  );
});

// Both guards pass before and after the change (the old pattern takes 7 and
// 9 ms): they catch a replacement that does work per match in proportion to
// the text length, or that scans to the end of the text instead of stopping
// at a blank line.
test('findCorruptingCodeSpanWraps stays linear on many short spans (#3705)', () => {
  const text = '`a`\n'.repeat(25_000);
  const start = performance.now();
  const violations = findCorruptingCodeSpanWraps(text);
  const elapsedMs = performance.now() - start;
  assert.ok(
    elapsedMs < INLINE_CODE_SPAN_LINEAR_CEILING_MS,
    `findCorruptingCodeSpanWraps took ${Math.round(elapsedMs)} ms for 25,000 short spans`,
  );
  assert.deepEqual(violations, []);
});

test('findCorruptingCodeSpanWraps stays linear on many unclosed runs each followed by a blank line (#3705)', () => {
  const text = '``a\n\n'.repeat(25_000);
  const start = performance.now();
  const violations = findCorruptingCodeSpanWraps(text);
  const elapsedMs = performance.now() - start;
  assert.ok(
    elapsedMs < INLINE_CODE_SPAN_LINEAR_CEILING_MS,
    `findCorruptingCodeSpanWraps took ${Math.round(elapsedMs)} ms for 25,000 unclosed runs`,
  );
  assert.deepEqual(violations, []);
});

test('findCorruptingCodeSpanWraps stays linear on distinct unmatched backtick runs before a literal split', () => {
  for (const size of [100, 1000]) {
    const text = `${Array.from({ length: size }, (_, index) => `${'`'.repeat(index + 1)}x`).join('')}- x`;
    const start = performance.now();
    const violations = findCorruptingCodeSpanWraps(text);
    const elapsedMs = performance.now() - start;
    assert.ok(
      elapsedMs < INLINE_CODE_SPAN_LINEAR_CEILING_MS,
      `findCorruptingCodeSpanWraps took ${Math.round(elapsedMs)} ms for ${size} distinct unmatched runs`,
    );
    assert.deepEqual(violations, []);
  }
});
