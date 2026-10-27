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
    ['`(class Foo extends com.example. MyClass {})`', 'MyClass'],
    ['`[class Foo extends com.example. MyClass {}]`', 'MyClass'],
    ['`class Foo extends com.example. $GeneratedClass {}`', '$GeneratedClass'],
    ['`class Foo extends @NonNull com.example. MyClass {}`', 'MyClass'],
    [
      '`class Foo extends @Anno(a = 1, b = 2) com.example. MyClass {}`',
      'MyClass',
    ],
    ['`class Foo<T> extends com.example. MyClass {}`', 'MyClass'],
    [
      '`class Foo<T extends Comparable<List<T>>> extends com.example. MyClass {}`',
      'MyClass',
    ],
    ['`class Foo<@Mark(">") T> extends com.example. MyClass {}`', 'MyClass'],
    ['`class Foo<@Mark(1 > 0) T> extends com.example. MyClass {}`', 'MyClass'],
    [
      '`class Foo<T> extends com.example. MyClass implements Runnable {}`',
      'MyClass',
    ],
    ['`static class Foo extends com.example. MyClass {}`', 'MyClass'],
    ['`@Deprecated class Foo extends com.example. MyClass {}`', 'MyClass'],
    [
      '`@SuppressWarnings("x)") class Foo extends com.example. MyClass {}`',
      'MyClass',
    ],
    [
      '`@org.example.SuppressWarnings("x)") interface Foo extends com.example. MyInterface {}`',
      'MyInterface',
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
    ['`(void run() throws com.example. MyException {})`', 'MyException'],
    ['`[void run() throws com.example. MyException {}]`', 'MyException'],
    [
      '`java.util.@Nullable List<String> run() throws com.example. MyException {}`',
      'MyException',
    ],
    ['`String [] run() throws com.example. MyException {}`', 'MyException'],
    [
      '`String @Nullable [] run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`String @A [] /* between dimensions */ @B [] run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`class Outer { void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`package p; class Outer { void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`import java.util.List; class Outer { void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`package p; import static java.util.Collections.emptyList; class Outer { void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`class Outer { static class Inner extends com.example. MyClass {} }`',
      'MyClass',
    ],
    [
      '`enum Outer { VALUE; void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`record Outer() { void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    [
      '`class Outer { void run() { class Local { void nested() throws com.example. MyException {} } } }`',
      'MyException',
    ],
    [
      '`class Outer { Object value = new Object() { void run() throws com.example. MyException {} }; }`',
      'MyException',
    ],
    [
      '`class Outer { Object run() { return new Object() { void nested() throws com.example. MyException {} }; } }`',
      'MyException',
    ],
    [
      '`class Outer { String marker = "}"; void run() throws com.example. MyException {} }`',
      'MyException',
    ],
    ['`void run() throws @NonNull com.example. MyException {}`', 'MyException'],
    [
      '`void run(@Size(max = 10) String value) throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`void run(@Pattern(regexp = "value)") String value) throws com.example. MyException {}`',
      'MyException',
    ],
    ['`String[] run() throws com.example. MyException {}`', 'MyException'],
    [
      '`Map<String, List<Integer>> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<String /* note */, Integer> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<String, /* note */ Integer /* note */> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<? extends String, Integer> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<? super Number, ?> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<? /* note */ extends /* bound */ String, Integer> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`Map<? /* note */ super /* bound */ Number, ?> run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`List<@Nullable String> run() throws com.example. MyException;`',
      'MyException',
    ],
    [
      '`Outer<String>.Inner run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`public <T> void run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`public <@Mark(1 > 0) T> void run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`@Override public void run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`@org.example.Override public void run() throws com.example. MyException {}`',
      'MyException',
    ],
    [
      '`@SuppressWarnings("x)") void run() throws com.example. MyException {}`',
      'MyException',
    ],
    ['`default void run() throws com.example. MyException {}`', 'MyException'],
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

test('flags qualified types across six bounded Java declaration forms', () => {
  const wrapCode = (source: string): string => `\`${source}\``;
  const cases = [
    {
      name: 'local class followed by an if condition with a braced lambda',
      wrapped: [
        'class Outer { void run() { class Local extends java.util.',
        ' ArrayList {} if (check(() -> { return true; })) {} } boolean check(java.util.function.Supplier<Boolean> supplier) { return supplier.get(); } }',
      ].join(''),
      unwrapped:
        'class Outer { void run() { class Local extends java.util.ArrayList {} if (check(() -> { return true; })) {} } boolean check(java.util.function.Supplier<Boolean> supplier) { return supplier.get(); } }',
      type: 'ArrayList',
      prefix: 'java.util.',
    },
    {
      name: 'later field declarator with an annotation',
      wrapped: [
        'class Outer { void run() throws java.io.',
        ' IOException {} int first, second @A []; @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface A {} }',
      ].join(''),
      unwrapped:
        'class Outer { void run() throws java.io.IOException {} int first, second @A []; @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_USE) @interface A {} }',
      type: 'IOException',
      prefix: 'java.io.',
    },
    {
      name: 'method with post-parameter return dimensions',
      wrapped: [
        'class Outer { String run()[] throws java.io.',
        ' IOException { return null; } }',
      ].join(''),
      unwrapped:
        'class Outer { String run()[] throws java.io.IOException { return null; } }',
      type: 'IOException',
      prefix: 'java.io.',
    },
    {
      name: 'parameterized return type with trivia before its arguments',
      wrapped: [
        'class Outer { java.util.List <String> run() throws java.io.',
        ' IOException { return null; } }',
      ].join(''),
      unwrapped:
        'class Outer { java.util.List <String> run() throws java.io.IOException { return null; } }',
      type: 'IOException',
      prefix: 'java.io.',
    },
    {
      name: 'nested annotation type after a method',
      wrapped: [
        'class Outer { void run() throws java.io.',
        ' IOException {} @interface Marker { String value(); } }',
      ].join(''),
      unwrapped:
        'class Outer { void run() throws java.io.IOException {} @interface Marker { String value(); } }',
      type: 'IOException',
      prefix: 'java.io.',
    },
    {
      name: 'record compact constructor after a method',
      wrapped: [
        'record Outer() { void run() throws java.io.',
        ' IOException {} Outer {} }',
      ].join(''),
      unwrapped:
        'record Outer() { void run() throws java.io.IOException {} Outer {} }',
      type: 'IOException',
      prefix: 'java.io.',
    },
  ];

  for (const { name, wrapped, unwrapped, type, prefix } of cases) {
    const violations = findCorruptingCodeSpanWraps(wrapCode(wrapped));
    assert.equal(violations.length, 1, `${name}: wrapped`);
    assert.equal(violations[0]?.line, 1, name);
    assert.equal(violations[0]?.before.endsWith(prefix), true, name);
    assert.equal(violations[0]?.after.startsWith(type), true, name);
    assert.equal(violations[0]?.separator, 'literal-space', name);
    assert.deepEqual(
      findCorruptingCodeSpanWraps(wrapCode(unwrapped)),
      [],
      name,
    );
  }
});

test('accepts generic owner segments before a split qualified type', () => {
  for (const span of [
    '`class Foo extends pkg.Outer<String>. MyClass {}`',
    '`void run() throws pkg.Outer<String>. MyException {}`',
    '`class Foo extends pkg.Outer<Map<String, Integer>>. MyClass {}`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('finds declaration starts inside executable and enum bodies', () => {
  for (const span of [
    '`class Outer { void run() { class Local extends com.example. MyClass {} } }`',
    '`class Outer { void run() { initialize(); class Local extends com.example. MyClass {} } }`',
    '`class Outer { void run() { if (ready) {} class Local extends com.example. MyClass {} } }`',
    '`class Outer { void run() { class Local extends com.example. MyClass {} int n = 0; } }`',
    '`enum Outer { VALUE { void run() throws com.example. MyException {} } }`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('finds qualified throws clauses in non-final enum constant bodies', () => {
  for (const span of [
    '`enum E { A { void run() throws com.example. MyException {} }, B }`',
    '`enum E { A { void run() throws com.example. MyException {} }, B(1) { void other() {} }, C; int count = 0; }`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before.endsWith('com.example.'), true, span);
    assert.equal(violations[0]?.after.startsWith('MyException'), true, span);
  }
});

test('consumes compound statements after a local type declaration', () => {
  for (const span of [
    '`class Outer { void run() { class Local extends com.example. MyClass {} if (ready) {} } }`',
    '`class Outer { void run() { class Local extends com.example. MyClass {} if (ready) {} else {} } }`',
    '`class Outer { void run() { class Local extends com.example. MyClass {} try {} catch (RuntimeException ex) {} finally {} } }`',
    '`class Outer { void run() { class Local extends com.example. MyClass {} do {} while (ready); } }`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('allows valid sibling members after a declaration body', () => {
  for (const span of [
    '`class Outer { void run() throws com.example. MyException {} void other() {} }`',
    '`class Outer { void run() throws com.example. MyException {} void other() {} int value = 1; }`',
    '`class Outer { void run() throws com.example. MyException {} Outer() {} }`',
    '`class Outer { void run() throws com.example. MyException {} int first, second; }`',
    '`class Outer { void run() throws com.example. MyException {} int first = 1, second = 2; }`',
    '`class Outer { void run() throws com.example. MyException {} Runnable action = () -> {}; }`',
    '`class Outer { void run() throws com.example. MyException {} int[] values = {1, 2}; }`',
    '`class Outer { void run() throws com.example. MyException {} Map<String, Integer> values = new HashMap<String, Integer>(), other = new HashMap<>(); }`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }

  assert.deepEqual(
    findCorruptingCodeSpanWraps(
      '`class Outer { void run() throws com.example. MyException {} some prose }`',
    ),
    [],
  );
});

test('finds qualified throws clauses in anonymous class members', () => {
  for (const span of [
    '`class Outer { Object value = new Object() { void first() {} void run() throws com.example. MyException {} }; }`',
    '`class Outer { Object value = new Object() { int value = 1; void run() throws com.example. MyException {} }; }`',
    '`class Outer { void run() { consume(new Object() { void nested() throws com.example. MyException {} }); } }`',
    '`consume(new Object() { void run() throws com.example. MyException {} });`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('finds split qualified types with a type-use annotation after the separator', () => {
  for (const span of [
    '`class Foo extends com.example. @Nullable MyClass {}`',
    '`void run() throws com.example. @Nullable MyException {}`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }
});

test('finds split qualified names inside declaration type annotations', () => {
  const violations = findCorruptingCodeSpanWraps(
    '`class Foo extends @com.example. Anno(value = foo. bar) com.example.MyClass {}`',
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.before.endsWith('@com.example.'));
});

test('accepts annotation arguments and comments around declaration headers', () => {
  const cases = [
    '`class Foo extends com.example. MyClass /* note */ {}`',
    '`class Foo extends com.example. MyClass {} /* note */`',
    '`class Foo extends com.example. MyClass /* note */ implements Runnable {}`',
    '`class Foo extends com.example. MyClass implements Runnable /* note */ {}`',
    '`class Foo /* note */ extends com.example. MyClass {}`',
    '`class Foo extends /* note */ com.example. MyClass {}`',
    '`interface Foo extends First, /* note */ com.example. MyInterface {}`',
    '`void run() throws com.example. MyException /* note */ {}`',
    '`void run() throws com.example. MyException {} /* note */`',
    '`abstract void run() throws com.example. MyException; /* note */`',
    '`void run() throws com.example. MyException, /* note */ other.Other {}`',
    '`public/* note */ void run() throws com.example. MyException {}`',
    '`void run() throws/* note */ com.example. MyException {}`',
  ];

  for (const span of cases) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.separator, 'literal-space', span);
  }

  for (const span of [
    '`class Foo extends com.example. MyClass /* note */`',
    '`class Foo extends com.example. MyClass {} /* note */ prose`',
    '`class Foo extends com.example. MyClass {} // note\n prose`',
    '`com.example. MyClass extends Base /* note`',
    '`void run() throws com.example. MyException /* note */ prose`',
    '`void run() throws com.example. MyException; /* note */ prose`',
    '`void run() throws com.example. MyException {} // note\n prose`',
    '`The method run() throws @NonNull com.example. MyException during the example.`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('ignores sentence periods inside annotation string arguments', () => {
  for (const span of [
    '`void run() throws @Marker("not. a") com.example.MyException {}`',
    '`class Foo extends @Marker("not. a") com.example.MyClass {}`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }

  for (const span of [
    '`void run() throws @Marker("not. a") com.example. MyException {}`',
    '`class Foo extends @Marker("not. a") com.example. MyClass {}`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.ok(violations[0]?.before.endsWith('com.example.'), span);
  }
});

test('ignores split dots inside declaration annotation expressions', () => {
  assert.deepEqual(
    findCorruptingCodeSpanWraps(
      '`class Foo extends @Anno(value = foo. bar) com.example.MyClass {}`',
    ),
    [],
  );

  const violations = findCorruptingCodeSpanWraps(
    '`class Foo extends @Anno(value = foo. bar) com.example. MyClass {}`',
  );
  assert.equal(violations.length, 1);
  assert.ok(violations[0]?.before.endsWith('com.example.'));

  assert.deepEqual(
    findCorruptingCodeSpanWraps(
      '`class Foo extends @Anno(value = foo.\n bar) com.example.MyClass {}`',
    ),
    [],
  );

  const lineBreakViolations = findCorruptingCodeSpanWraps(
    '`class Foo extends @Anno(value = foo. bar) com.example.\n MyClass {}`',
  );
  assert.equal(lineBreakViolations.length, 1);
  assert.ok(lineBreakViolations[0]?.before.endsWith('com.example.'));
});

test('flags multiple split qualified types in supported declaration lists', () => {
  const cases = [
    {
      span: '`interface Foo extends com.example. First, other. Second {}`',
      packages: ['com.example.', 'other.'],
      types: ['First', 'Second'],
    },
    {
      span: '`void run() throws com.example. MyException, java.io. IOException {}`',
      packages: ['com.example.', 'java.io.'],
      types: ['MyException', 'IOException'],
    },
  ];

  for (const { span, packages, types } of cases) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 2, span);
    for (const [index, violation] of violations.entries()) {
      assert.equal(
        violation?.before.endsWith(packages[index] ?? ''),
        true,
        span,
      );
      assert.equal(violation?.after.startsWith(types[index] ?? ''), true, span);
      assert.equal(violation?.separator, 'literal-space', span);
    }
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

test('parses dollar and underscore identifiers in declaration type lists', () => {
  for (const prefix of ['$root.Base', '_root.Base']) {
    const violations = findCorruptingCodeSpanWraps(
      `\`interface Foo extends ${prefix}, com.example. MyInterface {}\``,
    );
    assert.equal(violations.length, 1, prefix);
    assert.equal(violations[0]?.after.startsWith('MyInterface'), true, prefix);
  }

  const laterSplit = findCorruptingCodeSpanWraps(
    '`interface Foo extends first.One, $root._internal. MyInterface {}`',
  );
  assert.equal(laterSplit.length, 1);
  assert.equal(laterSplit[0]?.before.endsWith('$root._internal.'), true);

  const dollarContinuation = findCorruptingCodeSpanWraps(
    '`void run() throws com.example. $GeneratedException;`',
  );
  assert.equal(dollarContinuation.length, 1);
  assert.equal(
    dollarContinuation[0]?.after.startsWith('$GeneratedException'),
    true,
  );
});

test('flags declaration-aware line breaks before dollar and annotated types', () => {
  for (const span of [
    '`void run() throws com.example.\n$GeneratedException;`',
    '`void run() throws com.example.\n@Nullable MyException {}`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.line, 1, span);
    assert.equal(violations[0]?.before.endsWith('com.example.'), true, span);
  }
});

test('skips type annotations before wildcard generic arguments', () => {
  for (const span of [
    '`class Outer { List<@Nullable ?> run() throws com.example. MyException; }`',
    '`class Outer { List<@Nullable ? extends Number> run() throws com.example. MyException; }`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before.endsWith('com.example.'), true, span);
    assert.equal(violations[0]?.after.startsWith('MyException'), true, span);
  }
});

test('flags declaration tails with nested Java wildcard type arguments', () => {
  const inlineCode = String.fromCharCode(96);
  for (const declaration of [
    'com.example. MyClass extends Base<List<?>>',
    'com.example. MyClass extends Base<List<? extends Outer.Inner>>',
    'com.example. MyClass implements Comparable<List<? super MyClass>>',
    'com.example. MyClass extends Base<List<?extends Outer.Inner>>',
    'com.example. MyClass implements Comparable<List<?super MyClass>>',
  ]) {
    const span = inlineCode + declaration + inlineCode;
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before, 'com.example.', span);
  }
});

test('does not use direct wildcard supertype arguments as declaration evidence', () => {
  for (const span of [
    '`com.example. MyClass extends Base<?>`',
    '`com.example. MyClass extends Base<? extends Outer.Inner>`',
    '`com.example. MyClass implements Comparable<? super MyClass>`',
    '`com.example. MyClass extends Base<?extends Outer.Inner>`',
    '`com.example. MyClass implements Comparable<?super MyClass>`',
    '`com.example. MyClass extends Base<String, ?>`',
    '`com.example. MyClass implements First, Second<?>`',
    '`com.example. MyClass extends Base<? extends String[]>`',
    '`com.example. MyClass implements Comparable<? super int[]>`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('flags nested wildcard array bounds with reference and primitive elements', () => {
  const inlineCode = String.fromCharCode(96);
  for (const bound of [
    'lowercaseName[]',
    'String[]',
    'String[][]',
    'String [ ] [ ]',
    'Outer.Inner[]',
    'List<String>[]',
    ...[
      'boolean',
      'byte',
      'char',
      'double',
      'float',
      'int',
      'long',
      'short',
    ].map((element) => `${element}[][]`),
  ]) {
    for (const keyword of ['extends', 'super']) {
      const span = `${inlineCode}com.example. MyClass extends Base<List<?${keyword} ${bound}>>${inlineCode}`;
      const violations = findCorruptingCodeSpanWraps(span);
      assert.equal(violations.length, 1, span);
      assert.equal(violations[0]?.before, 'com.example.', span);
    }
  }
});

test('keeps lowercase and annotated primitive wildcard bounds in throws methods', () => {
  const inlineCode = String.fromCharCode(96);
  for (const declaration of [
    'abstract <t> List<? extends t> run() throws com.example. MyException;',
    'List<? extends @A int[]> run() throws com.example. MyException;',
  ]) {
    const span = `${inlineCode}${declaration}${inlineCode}`;
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.equal(violations[0]?.before.endsWith('com.example.'), true, span);
  }
});

test('does not accept incomplete array bounds or bare primitive bounds', () => {
  const inlineCode = String.fromCharCode(96);
  for (const bound of [
    'String[',
    'String[3]',
    'String[] [',
    'String[]suffix',
    'int',
    '@A int',
    'void[]',
  ]) {
    const span = `${inlineCode}com.example. MyClass extends Base<List<? extends ${bound}>>${inlineCode}`;
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('does not treat identifier prefixes as wildcard variance keywords', () => {
  for (const span of [
    '`com.example. MyClass extends Base<List<?extendsFoo>>`',
    '`com.example. MyClass extends Base<List<?superFoo>>`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('keeps wildcard-bound generic nesting bounded', () => {
  const inlineCode = String.fromCharCode(96);
  for (const arraySuffix of ['', '[]']) {
    const atLimit =
      inlineCode +
      'com.example. MyClass extends Base<List<? extends ' +
      'List<'.repeat(6) +
      'String' +
      '>'.repeat(6) +
      arraySuffix +
      '>>' +
      inlineCode;
    const beyondLimit =
      inlineCode +
      'com.example. MyClass extends Base<List<? extends ' +
      'List<'.repeat(7) +
      'String' +
      '>'.repeat(7) +
      arraySuffix +
      '>>' +
      inlineCode;
    assert.equal(findCorruptingCodeSpanWraps(atLimit).length, 1, atLimit);
    assert.deepEqual(findCorruptingCodeSpanWraps(beyondLimit), [], beyondLimit);
  }
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
    '`command <file>. Next step`',
    '`interface C extends Base<?>. Next step`',
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
    '`void run() throws com.example. MyException { // }`',
    '`void run() throws com.example. MyException { /* }`',
    '`void run() throws com.example. MyException { System.out.println("}")`',
    '`(Visit example.com. GitHub implements Interface)`',
    '`[Visit example.com. GitHub implements Interface.]`',
  ]) {
    assert.deepEqual(findCorruptingCodeSpanWraps(span), [], span);
  }
});

test('preserves qualified-name detection after prefixed identifiers', () => {
  for (const span of [
    '`_MyClass. OtherClass`',
    '`2MyClass. OtherClass`',
    '`path/_MyClass. OtherClass`',
  ]) {
    const violations = findCorruptingCodeSpanWraps(span);
    assert.equal(violations.length, 1, span);
    assert.ok(violations[0]?.before.endsWith('.'), span);
    assert.ok(violations[0]?.after.startsWith('OtherClass'), span);
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
    '`class Outer { The method run() throws com.example. MyException {} }`',
    '`class Outer { The type Foo extends com.example. MyClass {} }`',
    '` } class Foo extends com.example. MyClass {}`',
    '`Some prose; class Foo extends com.example. MyClass {}`',
    '`if (ready) { void run() throws com.example. MyException {} }`',
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
// scanner now needs a few milliseconds. The guards below judge growth, not
// elapsed time. An absolute ceiling on elapsed time failed a correct change on
// a loaded runner (issue #4739: 2128 ms against a 2000 ms ceiling). Each guard
// times the scan at a size and at ten times that size, as the minimum over
// several batches of process CPU time, and bounds the growth exponent between
// them: a linear scan grows about as n^1 and a quadratic regression about n^2.
// A ratio cancels out a uniformly slower host, but process CPU time still
// includes GC and JIT threads and stays load-sensitive, so each guard's bound
// sits between the honest noise and the regression it must catch. Every guard
// measures its larger size before judging, so a failing guard costs about six
// large runs, and a steep regression takes longer to report than the old
// ceiling did.
const LINEAR_SCAN_SIZE_RATIO = 10;
const LINEAR_SCAN_MAX_GROWTH_EXPONENT = 1.4;
// A batch repeats the scan until it has accumulated this much CPU time, then
// averages those runs. A disturbed batch raises its own average, so only the
// minimum over batches can suppress such an outlier.
const LINEAR_SCAN_BATCH_MS = 10;
const LINEAR_SCAN_MAX_BATCH_RUNS = 10_000;
const LINEAR_SCAN_BATCHES = 5;

type Violations = ReturnType<typeof findCorruptingCodeSpanWraps>;
type ViolationCheck = (violations: Violations, size: number) => void;

const expectNoViolations: ViolationCheck = (violations) => {
  assert.deepEqual(violations, []);
};
const acceptAnyViolations: ViolationCheck = () => undefined;

interface TimedScan {
  cpuMs: number;
  violations: Violations;
}

function timeScan(text: string): TimedScan {
  const start = process.cpuUsage();
  const violations = findCorruptingCodeSpanWraps(text);
  const usage = process.cpuUsage(start);
  return { cpuMs: (usage.user + usage.system) / 1000, violations };
}

// Averages the runs of one batch, and keeps the violations of its last run.
function batchCpuMs(text: string): TimedScan {
  let runs = 0;
  let totalMs = 0;
  let last: TimedScan;
  do {
    last = timeScan(text);
    totalMs += last.cpuMs;
    runs += 1;
  } while (totalMs < LINEAR_SCAN_BATCH_MS && runs < LINEAR_SCAN_MAX_BATCH_RUNS);
  return { cpuMs: totalMs / runs, violations: last.violations };
}

function minimumBatch(text: string): TimedScan {
  let best = batchCpuMs(text);
  for (let batch = 1; batch < LINEAR_SCAN_BATCHES; batch += 1) {
    const current = batchCpuMs(text);
    if (current.cpuMs < best.cpuMs) best = current;
  }
  return best;
}

function assertLinearGrowth(
  label: string,
  firstSize: number,
  buildText: (size: number) => string,
  checkViolations: ViolationCheck,
  maxExponent = LINEAR_SCAN_MAX_GROWTH_EXPONENT,
): void {
  const smallText = buildText(firstSize);
  const largeText = buildText(firstSize * LINEAR_SCAN_SIZE_RATIO);
  // Untimed batches at both sizes warm the JIT, so compilation is not counted
  // as growth. Warming only one size leaves the other cold. A cold smaller
  // baseline lowers the exponent and could hide a regression, and a cold larger
  // run raises it into a false failure.
  batchCpuMs(largeText);
  batchCpuMs(smallText);
  const small = minimumBatch(smallText);
  const large = minimumBatch(largeText);
  // A zero reading has no finite exponent, so it fails here instead of passing.
  assert.ok(
    small.cpuMs > 0 && large.cpuMs > 0,
    `${label} measured ${small.cpuMs} ms and ${large.cpuMs} ms of CPU time`,
  );
  const exponent =
    Math.log(large.cpuMs / small.cpuMs) /
    Math.log(largeText.length / smallText.length);
  assert.ok(
    Number.isFinite(exponent) && exponent < maxExponent,
    `${label} grew as about n^${exponent.toFixed(2)} (bound ${maxExponent}): ${small.cpuMs.toFixed(3)} ms for ${smallText.length} characters, ${large.cpuMs.toFixed(2)} ms for ${largeText.length}`,
  );
  checkViolations(small.violations, firstSize);
  checkViolations(large.violations, firstSize * LINEAR_SCAN_SIZE_RATIO);
}

// At 500 backticks these two scans take a fraction of a millisecond, so timer
// noise under load moves their exponent more than the others. The looser bound
// sits above that noise and below the 1.95 that an injected quadratic produces.
const LINEAR_SCAN_SUB_MILLISECOND_MAX_EXPONENT = 1.6;
// The helper takes every exponent over text length. This guard's input grows as
// n squared, so its length ratio is about 97 rather than 10. A scan to the end
// of the text per run grows as length^1.5, which the tighter bound catches (1.44
// injected), while honest runs stay between 0.90 and 0.98 under load.
const LINEAR_SCAN_DISTINCT_RUNS_MAX_EXPONENT = 1.2;

test('findCorruptingCodeSpanWraps stays linear on an unclosed backtick run before a letter and a newline (#3705)', () => {
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    500,
    (size) => `text ${'`'.repeat(size)}a\n`,
    expectNoViolations,
    LINEAR_SCAN_SUB_MILLISECOND_MAX_EXPONENT,
  );
});

test('findCorruptingCodeSpanWraps stays linear on an unclosed backtick run before a blank line, twice (#3705)', () => {
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    500,
    (size) => `text ${'`'.repeat(size)}\n\ntext ${'`'.repeat(size)}\n`,
    expectNoViolations,
    LINEAR_SCAN_SUB_MILLISECOND_MAX_EXPONENT,
  );
});

test('findCorruptingCodeSpanWraps stays linear on a long backtick run followed by many one-backtick closers (#3705)', () => {
  // Spans are found here, so only growth is asserted.
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    1000,
    (size) => `text ${'`'.repeat(size)}${'a`'.repeat(size)}`,
    acceptAnyViolations,
  );
});

test('findCorruptingCodeSpanWraps stays linear on a long qualified throws list', () => {
  assertLinearGrowth(
    'qualified throws list',
    2000,
    (size) =>
      `\`class C { void f() throws ${Array(size).fill('com.example. MyException').join(', ')} {} }\``,
    acceptAnyViolations,
  );
});

test('findCorruptingCodeSpanWraps scales linearly across sibling throws methods', () => {
  assertLinearGrowth(
    'sibling throws methods',
    800,
    (size) =>
      `\`class C { ${Array.from(
        { length: size },
        (_, index) => `void run${index}() throws com.example. MyException {}`,
      ).join(' ')} }\``,
    (violations, size) => assert.equal(violations.length, size),
  );
});

test('findCorruptingCodeSpanWraps scales linearly across dollar-prefixed throws methods', () => {
  assertLinearGrowth(
    'dollar-prefixed throws methods',
    800,
    (size) =>
      `\`class C { ${Array.from(
        { length: size },
        (_, index) =>
          `void run${index}() throws com.example. $GeneratedException {}`,
      ).join(' ')} }\``,
    (violations, size) => assert.equal(violations.length, size),
  );
});

test('findCorruptingCodeSpanWraps scales linearly across sibling classes', () => {
  assertLinearGrowth(
    'sibling classes',
    800,
    (size) =>
      `\`class Outer { ${Array.from(
        { length: size },
        (_, index) => `class C${index} extends com.example. MyClass {}`,
      ).join(' ')} }\``,
    (violations, size) => assert.equal(violations.length, size),
  );
});

test('findCorruptingCodeSpanWraps scales linearly across sentence punctuation', () => {
  assertLinearGrowth(
    'sentence punctuation',
    800,
    (size) => `\`${'word. Capital prose '.repeat(size)}\``,
    expectNoViolations,
  );
});

test('findCorruptingCodeSpanWraps stays linear with deeply nested declaration contexts', () => {
  assertLinearGrowth(
    'deeply nested declaration contexts',
    1000,
    (size) =>
      `\`class C { void f() throws com.example. MyException { ${'if (ready) {'.repeat(size)} work(); ${'}'.repeat(size)} } }\``,
    acceptAnyViolations,
  );
});

test('findCorruptingCodeSpanWraps scales linearly across nested classes with split extends types', () => {
  assertLinearGrowth(
    'nested split declarations',
    800,
    (size) =>
      `\`${Array.from(
        { length: size },
        (_, index) => `class C${index} extends com.example. MyClass {`,
      ).join(' ')} work(); ${'}'.repeat(size)}\``,
    (violations, size) => assert.equal(violations.length, size),
  );
});

// These guards catch a replacement that does work per match in proportion to
// the text length, or that scans to the end of the text instead of stopping at
// a blank line.
test('findCorruptingCodeSpanWraps stays linear on many short spans (#3705)', () => {
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    2500,
    (size) => '`a`\n'.repeat(size),
    expectNoViolations,
  );
});

test('findCorruptingCodeSpanWraps stays linear on many unclosed runs each followed by a blank line (#3705)', () => {
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    2500,
    (size) => '``a\n\n'.repeat(size),
    expectNoViolations,
  );
});

test('findCorruptingCodeSpanWraps stays linear on distinct unmatched backtick runs before a literal split', () => {
  assertLinearGrowth(
    'findCorruptingCodeSpanWraps',
    100,
    (size) =>
      `${Array.from({ length: size }, (_, index) => `${'`'.repeat(index + 1)}x`).join('')}- x`,
    expectNoViolations,
    LINEAR_SCAN_DISTINCT_RUNS_MAX_EXPONENT,
  );
});
