import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectTypeSuppressionViolations } from '../scripts/consistency-helpers.mjs';

// Fixture text is assembled from fragments so this test file's raw text
// never contains the suppression tokens itself — the audit pipeline
// scans tests/**/*.mjs, and a literal directive here would count
// against the budgets this suite exists to protect.
const TS_IGNORE = `@ts-${'ignore'}`;
const TS_EXPECT_ERROR = `@ts-${'expect'}-error`;

const BUDGET_ZERO = {
  id: 'type-suppression-budgets',
  globs: ['src/**/*.mts', 'tests/**/*.mjs'],
  tsExpectErrorLimit: 0,
  explicitAnyLimit: 0,
};

test('passes on a clean current-tree-shaped input', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        "import { x } from './x.mts';",
        '// Fail-safe: any invalid token, or conflicting values, yields no score.',
        'const value: unknown = x;',
        "const text = ': any inside a string is not counted';",
      ].join('\n'),
    },
  ];
  assert.deepEqual(collectTypeSuppressionViolations(files, BUDGET_ZERO), []);
});

test(`fails when a ${TS_IGNORE} directive is introduced`, () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_IGNORE}\nconst v = broken();\n`,
    },
  ];
  const violations = collectTypeSuppressionViolations(files, BUDGET_ZERO);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sample\.mts:1 uses the forbidden/);
});

test(`fails when a ${TS_EXPECT_ERROR} lacks a same-line reason`, () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_EXPECT_ERROR}\nconst v = broken();\n`,
    },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    tsExpectErrorLimit: 1,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /without a same-line reason/);
});

test(`accepts a within-budget ${TS_EXPECT_ERROR} with a reason`, () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_EXPECT_ERROR} -- upstream types lag the runtime shape\nconst v = broken();\n`,
    },
  ];
  assert.deepEqual(
    collectTypeSuppressionViolations(files, {
      ...BUDGET_ZERO,
      tsExpectErrorLimit: 1,
    }),
    [],
  );
});

test(`fails when the ${TS_EXPECT_ERROR} budget is exceeded`, () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_EXPECT_ERROR} -- reason one\n// ${TS_EXPECT_ERROR} -- reason two\n`,
    },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    tsExpectErrorLimit: 1,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /2 .* exceed the recorded budget of 1/);
});

test('fails when the explicit any budget is exceeded', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: 'const v: any = parse();\nconst w = value as any;\nconst s = new Set<any>();\n',
    },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    explicitAnyLimit: 2,
  });
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /3 explicit any occurrence\(s\) exceed the recorded budget of 2/,
  );
});

test('wrapped type arguments cannot bypass the explicit any budget', () => {
  // Regression: `any` nested inside generics, arrays, or unions must
  // count, not just the bare annotation/cast/argument shapes.
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        'const a = new Set<any[]>();',
        'const b = new Map<string, any>();',
        'const c = parse<any | unknown>();',
        'const ok = obj.any;',
      ].join('\n'),
    },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    explicitAnyLimit: 2,
  });
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /3 explicit any occurrence\(s\) exceed the recorded budget of 2/,
  );
});

test('does not count any-like prose in comments or strings', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        '// setupRepo commits succeeding is the no-signing proof: any signing',
        '/* block: any text here, even as any phrase */',
        'const s = `template: any inside template`;',
        "const t = 'literal as any literal';",
      ].join('\n'),
    },
  ];
  assert.deepEqual(collectTypeSuppressionViolations(files, BUDGET_ZERO), []);
});

test('counts occurrences across multiple files against one budget', () => {
  const files = [
    { path: 'src/scripts/a.mts', text: 'const a: any = 1;\n' },
    { path: 'tests/b.test.mjs', text: 'const b = x as any;\n' },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    explicitAnyLimit: 1,
  });
  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /2 explicit any occurrence\(s\) exceed the recorded budget of 1/,
  );
});

test('a string ending in a literal backslash does not blind the scan', () => {
  // Regression: the '\\' idiom (string whose content is one backslash)
  // must close the string state, so real code after it is still scanned
  // and string interiors after it are still ignored.
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        "const sep = '\\\\';",
        "const msg = 'value as any here';",
        'const leak: any = parse();',
      ].join('\n'),
    },
  ];
  const violations = collectTypeSuppressionViolations(files, BUDGET_ZERO);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /1 explicit any occurrence/);
});

test('regex literals containing quotes do not open phantom strings', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        'const re = /[\'"]/;',
        'const classed = /[/]/;',
        'function f(x) {',
        '  return /["`]/.test(x);',
        '}',
        'const leak = value as any;',
      ].join('\n'),
    },
  ];
  const violations = collectTypeSuppressionViolations(files, BUDGET_ZERO);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /1 explicit any occurrence/);
});

test('a block comment between tokens cannot hide an explicit any', () => {
  // Regression: stripping a comment must leave a token boundary so a
  // block comment between `as` and `any` cannot splice them into one
  // merged token that dodges the matcher.
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: 'const v = value as/* hidden */any;\nconst w: /* gap */ any = 1;\n',
    },
  ];
  const violations = collectTypeSuppressionViolations(files, BUDGET_ZERO);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /2 explicit any occurrence/);
});

test('division is not mistaken for a regex literal', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: [
        'const ratio = total / count;',
        "const after = ratio / 2; const s = 'as any in string';",
      ].join('\n'),
    },
  ];
  assert.deepEqual(collectTypeSuppressionViolations(files, BUDGET_ZERO), []);
});

test('rejects malformed budget limits instead of failing open', () => {
  const files = [];
  assert.match(
    collectTypeSuppressionViolations(files, {
      ...BUDGET_ZERO,
      tsExpectErrorLimit: -1,
    })[0],
    /tsExpectErrorLimit must be a non-negative integer/,
  );
  assert.match(
    collectTypeSuppressionViolations(files, {
      ...BUDGET_ZERO,
      explicitAnyLimit: '0',
    })[0],
    /explicitAnyLimit must be a non-negative integer/,
  );
});

test('returns no violations when the config is absent', () => {
  assert.deepEqual(collectTypeSuppressionViolations([], null), []);
});

test('a terse same-line reason such as an issue reference is accepted', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_EXPECT_ERROR} #1\nconst v = broken();\n`,
    },
  ];
  assert.deepEqual(
    collectTypeSuppressionViolations(files, {
      ...BUDGET_ZERO,
      tsExpectErrorLimit: 1,
    }),
    [],
  );
});

test('a bare separator with no reason text is still a violation', () => {
  const files = [
    {
      path: 'src/scripts/sample.mts',
      text: `// ${TS_EXPECT_ERROR} --\nconst v = broken();\n`,
    },
  ];
  const violations = collectTypeSuppressionViolations(files, {
    ...BUDGET_ZERO,
    tsExpectErrorLimit: 1,
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /without a same-line reason/);
});
