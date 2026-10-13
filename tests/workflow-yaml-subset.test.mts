import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseWorkflowYamlSubset,
  type WorkflowYamlConstruct,
} from '../src/scripts/workflow-yaml-subset.mts';

const WORKFLOWS = fileURLToPath(
  new URL('../.github/workflows/', import.meta.url),
);

/** Every supported form at once; each line is one YAML source line. */
const SUPPORTED = [
  '---',
  '# leading comment',
  'name: CI  # trailing comment',
  'on:',
  '  push:',
  '    branches: [main]',
  '  pull_request:',
  '    types:',
  '    - opened',
  '    - synchronize',
  'inline: pull_request',
  'folded: >',
  '  a',
  '   b',
  '  c',
  'inner: |',
  '  text',
  '# ends the block',
  'after: 1',
  'deeper:',
  '      pull_request:',
  '        branches: [main]',
  'jobs:',
  '  lint:',
  '    permissions: {}',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
  '    if: ${{ !cancelled() }}',
  '    steps:',
  '      - name: Run',
  '        run: |',
  '          echo "one"',
  '          echo two',
  '      - name: Fold',
  '        run: >-',
  '          one',
  '          two',
  '',
  '          three',
  '      - name: Keep',
  '        run: |+',
  '          kept',
  '',
  '        with:',
  "          quoted: 'it''s'",
  '          escaped: "tab\\tx\\x41\\u0042"',
  '          plain: a &b !c *d ?e',
  '          flow: [a, "b,c", {k: v}]',
  '          empty:',
  '          last: x',
  '# trailing comment',
  '...',
].join('\n');

const SUPPORTED_EXPECTED = {
  name: 'CI',
  on: {
    push: { branches: ['main'] },
    pull_request: { types: ['opened', 'synchronize'] },
  },
  inline: 'pull_request',
  folded: 'a\n b\nc\n',
  inner: 'text\n',
  after: '1',
  deeper: { pull_request: { branches: ['main'] } },
  jobs: {
    lint: {
      permissions: {},
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression under test, not a forgotten template placeholder.
      if: '${{ !cancelled() }}',
      steps: [
        { name: 'Run', run: 'echo "one"\necho two\n' },
        { name: 'Fold', run: 'one two\nthree' },
        {
          name: 'Keep',
          run: 'kept\n\n',
          with: {
            quoted: "it's",
            escaped: 'tab\txAB',
            plain: 'a &b !c *d ?e',
            flow: ['a', 'b,c', { k: 'v' }],
            empty: null,
            last: 'x',
          },
        },
      ],
    },
  },
};

/** One refused input per construct id; the position test covers the rest. */
const REFUSALS: ReadonlyArray<readonly [WorkflowYamlConstruct, string]> = [
  ['anchor', 'base: &defaults\n  a: 1\n'],
  ['alias', 'a: 1\nb: *x\n'],
  ['tag', 'a: !!str 1\n'],
  ['complex-key', '? key\n: value\n'],
  ['multiple-documents', 'a: 1\n---\nb: 2\n'],
  ['multiple-documents', 'a: 1\n...\nb: 2\n'],
  ['directive', '%YAML 1.2\n---\na: 1\n'],
  ['duplicate-key', 'a: 1\na: 2\n'],
  ['tab-character', 'a:\n\tb: 1\n'],
  ['carriage-return', 'a: 1\r\n'],
  ['unicode-line-break', 'a: x\u0085y\n'],
  ['unicode-line-break', 'a: x\u2028y\n'],
  ['unicode-line-break', 'a: x\u2029y\n'],
  ['byte-order-mark', '\ufeffa: 1\n'],
  ['non-printable-character', 'a: x\u0007\n'],
  ['multiline-plain-scalar', 'a: one\n  two\n'],
  ['multiline-quoted-scalar', 'a: "one\n  two"\n'],
  ['multiline-flow-collection', 'a: [one,\n  two]\n'],
  ['block-scalar-indent-indicator', 'a: |2\n   x\n'],
  ['unsupported-escape', 'a: "\\q"\n'],
  ['unsupported-escape', 'a: "\\U00110000"\n'],
  ['syntax', 'run: echo a: b\n'],
  ['syntax', '@foo: bar\n'],
  ['syntax', '|x: y\n'],
  ['syntax', 'a: [- b]\n'],
  ['syntax', 'a: [|b]\n'],
  ['syntax', "a: 'x'#c\n"],
  ['syntax', 'a:\n  b: 1\n c: 2\n'],
  ['complex-key', '[a]: b\n'],
  ['complex-key', 'k: [a] : b\n'],
  ['syntax', 'k: |\n    \n  a\n'],
  ['non-printable-character', 'k: a\ud800\n'],
  ['tab-character', 'a: |\t\n  x\n'],
];

test('parses the supported subset into plain nodes', () => {
  const result = parseWorkflowYamlSubset(SUPPORTED);
  assert.equal(result.ok, true, result.ok ? '' : result.violation.message);
  if (!result.ok) {
    return;
  }
  assert.deepStrictEqual(result.value, SUPPORTED_EXPECTED);
});

test('keeps __proto__ and constructor as ordinary own keys', () => {
  const result = parseWorkflowYamlSubset('__proto__: x\nconstructor: y\n');
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepStrictEqual(
    result.value,
    JSON.parse('{"__proto__": "x", "constructor": "y"}'),
  );
});

test('reads the R8 trigger forms: inline on and deeper-indent triggers', () => {
  const inline = parseWorkflowYamlSubset('on: pull_request\n');
  assert.deepStrictEqual(inline, { ok: true, value: { on: 'pull_request' } });
  const list = parseWorkflowYamlSubset('on: [push, pull_request]\n');
  assert.deepStrictEqual(list, {
    ok: true,
    value: { on: ['push', 'pull_request'] },
  });
  const deeper = parseWorkflowYamlSubset(
    'on:\n      pull_request:\n        types: [opened]\n',
  );
  assert.deepStrictEqual(deeper, {
    ok: true,
    value: { on: { pull_request: { types: ['opened'] } } },
  });
});

test('a workflow_call input named pull_request is not a trigger', () => {
  const result = parseWorkflowYamlSubset(
    'on:\n  workflow_call:\n    inputs:\n      pull_request:\n        type: boolean\n',
  );
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.deepStrictEqual(result.value, {
    on: {
      workflow_call: { inputs: { pull_request: { type: 'boolean' } } },
    },
  });
});

test('a block scalar at end of file keeps its one final line break', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('a: |+\n  x\n'), {
    ok: true,
    value: { a: 'x\n' },
  });
});

test('a more-indented whitespace-only line is content, not a blank line', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('a: >\n  a\n    \n  b\n'), {
    ok: true,
    value: { a: 'a\n  \nb\n' },
  });
});

test('a document marker ends a top-level block scalar', () => {
  const result = parseWorkflowYamlSubset('|\nabc\n---\nxyz\n');
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.violation.construct, 'multiple-documents');
});

test('nested sequence items parse into nested arrays', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('- - a\n  - b\n- c\n'), {
    ok: true,
    value: [['a', 'b'], 'c'],
  });
});

test('Unicode whitespace is content, not trailing space', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('a: b \n'), {
    ok: true,
    value: { a: 'b ' },
  });
});

test('an implicit null flow pair reads as a null value', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('a: {k}\n'), {
    ok: true,
    value: { a: { k: null } },
  });
});

test('a document marker with trailing spaces still starts the document', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('--- \na: 1\n'), {
    ok: true,
    value: { a: '1' },
  });
});

test('a block scalar on an unterminated last line keeps no final break', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('k: |\n  a'), {
    ok: true,
    value: { k: 'a' },
  });
});

test('a valid surrogate pair is one printable character', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('k: 😀\n'), {
    ok: true,
    value: { k: '😀' },
  });
});

test('nesting past the limit is refused, not thrown', () => {
  const result = parseWorkflowYamlSubset(`${'- '.repeat(5000)}a\n`);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.violation.construct, 'syntax');
});

test('an empty document parses to null', () => {
  assert.deepStrictEqual(parseWorkflowYamlSubset('# only a comment\n'), {
    ok: true,
    value: null,
  });
});

for (const [construct, text] of REFUSALS) {
  test(`refuses ${construct}: ${JSON.stringify(text)}`, () => {
    const result = parseWorkflowYamlSubset(text);
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.violation.construct, construct);
  });
}

test('reports the 1-based line and column of a refused construct', () => {
  const result = parseWorkflowYamlSubset('a: 1\nb: &x 2\n');
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.deepStrictEqual(
    {
      construct: result.violation.construct,
      line: result.violation.line,
      column: result.violation.column,
    },
    { construct: 'anchor', line: 2, column: 4 },
  );
});

test('parses every repository workflow file without a refusal', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const result = parseWorkflowYamlSubset(
      readFileSync(join(WORKFLOWS, name), 'utf8'),
    );
    assert.equal(
      result.ok,
      true,
      `${name}: ${result.ok ? '' : result.violation.message}`,
    );
    if (name === 'lint.yml' || name === 'idd-doctor.yml') {
      assert.ok(result.ok);
      if (result.ok) {
        assert.deepStrictEqual(
          (result.value as { on: { pull_request: unknown } }).on,
          { pull_request: null },
        );
      }
    }
  }
});
