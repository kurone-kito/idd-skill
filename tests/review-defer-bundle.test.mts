import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  type DeferBundleInput,
  type DeferItem,
  lintDeferBundle,
  renderDeferBundle,
} from '../src/scripts/review-defer-bundle.mts';

const COMMAND_ACCEPTANCE =
  '`node --test --import ./tests/isolate-state.mts tests/review-defer-bundle.test.mts` passes';
const THREAD_URL =
  'https://github.com/kurone-kito/idd-skill/pull/4200#discussion_r1';
const TITLE = 'test(claim): cover two deferred review cases';

function item(overrides: Partial<DeferItem> = {}): DeferItem {
  return {
    title: 'Retry hint',
    threadUrl: THREAD_URL,
    finding: 'The retry hint names the wrong command.',
    acceptance: COMMAND_ACCEPTANCE,
    path: 'src/scripts/claim.mts',
    ...overrides,
  };
}

function bundleInput(
  overrides: Partial<DeferBundleInput> = {},
): DeferBundleInput {
  return {
    originIssue: 4100,
    pr: 4200,
    title: TITLE,
    items: [
      item({ title: 'Retry hint', path: 'src/scripts/claim.mts' }),
      item({
        title: 'Lock message',
        path: 'tests/claim.test.mts',
        acceptance:
          '`node --test tests/claim.test.mts` passes with the lock message case covered',
      }),
    ],
    markerPrefix: 'idd-skill',
    ...overrides,
  };
}

function candidateLines(body: string): string[] {
  const start = Math.max(body.indexOf('## Candidate files'), 0);
  return body
    .slice(start)
    .split('\n')
    .filter((line) => line.startsWith('- `'));
}

test('renders the eight parts in order with one candidate bullet for a shared path', () => {
  const { body } = renderDeferBundle(
    bundleInput({
      items: [
        item({ title: 'Retry hint', path: 'src/scripts/claim.mts' }),
        item({ title: 'Lock message', path: 'src/scripts/claim.mts' }),
      ],
    }),
  );

  assert.deepEqual(candidateLines(body), ['- `src/scripts/claim.mts`']);

  const needles = [
    '## Background',
    '## Proposed change',
    '## Acceptance criteria',
    '## Candidate files',
    '\nRefs #4100\n',
    '\n---\n',
    '_Autopilot suitability:',
    '_Effort:',
    '<!-- idd-skill-authoring-defer-source:',
  ];
  let previous = -1;
  for (const needle of needles) {
    const index = body.indexOf(needle);
    assert.ok(index > previous, `${needle} is missing or out of order`);
    previous = index;
  }
});

test('a single item renders the exact golden body with every separator', () => {
  const rendered = renderDeferBundle(bundleInput({ items: [item()] }));
  const expected = [
    [
      '## Background',
      '',
      'Deferred from PR #4200 under the review defer policy; see the threads below.',
      '',
      `- Retry hint: ${THREAD_URL}`,
    ].join('\n'),
    [
      '## Proposed change',
      '',
      '- Retry hint: The retry hint names the wrong command.',
    ].join('\n'),
    ['## Acceptance criteria', '', `- [ ] ${COMMAND_ACCEPTANCE}`].join('\n'),
    ['## Candidate files', '', '- `src/scripts/claim.mts`'].join('\n'),
    'Refs #4100',
    '---',
    [
      '_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable;',
      'below the configured floor is human-oriented._',
    ].join('\n'),
    '<!-- idd-skill-autopilot-suitability: 4 -->',
    [
      '_Effort: S -- author-estimated size; a soft autopilot selection',
      'tie-breaker only._',
    ].join('\n'),
    '<!-- idd-skill-effort: S -->',
    '<!-- idd-skill-authoring-defer-source: review-fix-loop-cutoff -->',
  ].join('\n\n');

  assert.equal(rendered.body, expected);
  assert.equal(rendered.title, TITLE);
});

test('the body has exactly one Refs line and ends with the defer-source marker', () => {
  const { body } = renderDeferBundle(bundleInput());
  const lines = body.split('\n');
  assert.equal(lines.filter((line) => line.startsWith('Refs #')).length, 1);
  assert.equal(
    lines.at(-1),
    '<!-- idd-skill-authoring-defer-source: review-fix-loop-cutoff -->',
  );
});

test('a markerPrefix of acme puts acme- on both footers and the defer-source marker', () => {
  const { body } = renderDeferBundle(bundleInput({ markerPrefix: 'acme' }));
  assert.ok(body.includes('<!-- acme-autopilot-suitability: 4 -->'));
  assert.ok(body.includes('<!-- acme-effort: S -->'));
  assert.ok(
    body.includes(
      '<!-- acme-authoring-defer-source: review-fix-loop-cutoff -->',
    ),
  );
  assert.equal(body.includes('idd-skill-'), false);
  assert.equal(
    body.split('\n').at(-1),
    '<!-- acme-authoring-defer-source: review-fix-loop-cutoff -->',
  );
});

test('effort is S for three distinct paths and M for four and eight', () => {
  const expectEffort = (count: number, effort: string): void => {
    const items = Array.from({ length: count }, (_, index) =>
      item({
        title: `Finding ${index}`,
        path: `src/scripts/file-${index}.mts`,
      }),
    );
    const { body } = renderDeferBundle(bundleInput({ items }));
    assert.ok(
      body.includes(`<!-- idd-skill-effort: ${effort} -->`),
      `${count} distinct paths should give effort ${effort}`,
    );
  };
  expectEffort(3, 'S');
  expectEffort(4, 'M');
  expectEffort(8, 'M');
});

test('nine distinct paths throw a TypeError naming items and advising a split', () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    item({ title: `Finding ${index}`, path: `src/scripts/file-${index}.mts` }),
  );
  assert.throws(
    () => renderDeferBundle(bundleInput({ items })),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes('items') &&
      error.message.includes('split'),
  );
});

test('nine items that name only three distinct paths render at effort S', () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    item({
      title: `Finding ${index}`,
      path: `src/scripts/file-${index % 3}.mts`,
    }),
  );
  const { body } = renderDeferBundle(bundleInput({ items }));
  assert.ok(body.includes('<!-- idd-skill-effort: S -->'));
  assert.equal(candidateLines(body).length, 3);
});

test('nine items on eight distinct paths render at effort M, the cap', () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    item({
      title: `Finding ${index}`,
      path: `src/scripts/file-${index % 8}.mts`,
    }),
  );
  const { body } = renderDeferBundle(bundleInput({ items }));
  assert.ok(body.includes('<!-- idd-skill-effort: M -->'));
  assert.equal(candidateLines(body).length, 8);
});

test('non-array items throw a TypeError naming items', () => {
  assert.throws(
    () =>
      renderDeferBundle(
        bundleInput({ items: 'not a list' as unknown as DeferItem[] }),
      ),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes('items'),
  );
});

test('a sparse items array is validated, not silently dropped', () => {
  assert.throws(
    () =>
      renderDeferBundle(
        bundleInput({ items: new Array(1) as unknown as DeferItem[] }),
      ),
    (error: unknown) =>
      error instanceof TypeError && error.message.startsWith('items[0] must '),
  );
});

test('a visible effort line that disagrees with its marker fails effort-visible-line-agreement', () => {
  const rendered = renderDeferBundle(
    bundleInput({
      items: [
        item({ title: 'One', path: 'src/a.mts' }),
        item({ title: 'Two', path: 'src/b.mts' }),
        item({ title: 'Three', path: 'src/c.mts' }),
        item({ title: 'Four', path: 'src/d.mts' }),
      ],
    }),
  );
  assert.ok(rendered.body.includes('_Effort: M -- author-estimated size;'));
  const mismatched = {
    ...rendered,
    body: rendered.body.replace(
      '_Effort: M -- author-estimated size;',
      '_Effort: S -- author-estimated size;',
    ),
  };
  const lint = lintDeferBundle(mismatched, 'idd-skill');
  assert.equal(lint.passed, false);
  assert.ok(
    lint.failures.some((failure) =>
      failure.startsWith('effort-visible-line-agreement: '),
    ),
  );
});

test('lint rejects an empty markerPrefix with a TypeError naming markerPrefix', () => {
  const rendered = renderDeferBundle(bundleInput());
  assert.throws(
    () => lintDeferBundle(rendered, ''),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes('markerPrefix'),
  );
});

test('a missing acceptance throws a TypeError naming acceptance', () => {
  const broken = { ...item(), acceptance: undefined } as unknown as DeferItem;
  assert.throws(
    () => renderDeferBundle(bundleInput({ items: [broken] })),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes('acceptance'),
  );
});

test('an empty items list throws a TypeError naming items', () => {
  assert.throws(
    () => renderDeferBundle(bundleInput({ items: [] })),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes('items'),
  );
});

test('invalid input throws a TypeError whose message starts with the field name', () => {
  const cases: Array<[string, () => unknown]> = [
    ['originIssue', () => renderDeferBundle(bundleInput({ originIssue: 0 }))],
    ['originIssue', () => renderDeferBundle(bundleInput({ originIssue: 1.5 }))],
    [
      'originIssue',
      () =>
        renderDeferBundle(
          bundleInput({ originIssue: '4100' as unknown as number }),
        ),
    ],
    [
      'pr',
      () => renderDeferBundle(bundleInput({ pr: '4200' as unknown as number })),
    ],
    ['title', () => renderDeferBundle(bundleInput({ title: '   ' }))],
    [
      'markerPrefix',
      () => renderDeferBundle(bundleInput({ markerPrefix: '' })),
    ],
    [
      'markerPrefix',
      () => renderDeferBundle(bundleInput({ markerPrefix: '   ' })),
    ],
    [
      'markerPrefix',
      () => renderDeferBundle(bundleInput({ markerPrefix: 'a b' })),
    ],
    [
      'markerPrefix',
      () => renderDeferBundle(bundleInput({ markerPrefix: '-acme' })),
    ],
    [
      'markerPrefix',
      () => renderDeferBundle(bundleInput({ markerPrefix: '.acme' })),
    ],
    ['input', () => renderDeferBundle(null as unknown as DeferBundleInput)],
    [
      'items[0]',
      () =>
        renderDeferBundle(
          bundleInput({ items: [null as unknown as DeferItem] }),
        ),
    ],
    [
      'items[0].title',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ title: '<!-- note' })] }),
        ),
    ],
    [
      'items[0].threadUrl',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ threadUrl: `${THREAD_URL}\nmore` })] }),
        ),
    ],
    [
      'items[0].threadUrl',
      () =>
        renderDeferBundle(
          bundleInput({
            items: [item({ threadUrl: 42 as unknown as string })],
          }),
        ),
    ],
    [
      'items[0].threadUrl',
      () =>
        renderDeferBundle(
          bundleInput({
            items: [item({ threadUrl: 'https://example.test/<!--' })],
          }),
        ),
    ],
    [
      'items[0].finding',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ finding: 'see <!-- note' })] }),
        ),
    ],
    [
      'items[0].finding',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ finding: 42 as unknown as string })] }),
        ),
    ],
    [
      'items[0].acceptance',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ acceptance: 'passes <!-- note' })] }),
        ),
    ],
    [
      'items[0].path',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ path: 'src/`x`.mts' })] }),
        ),
    ],
    [
      'items[0].path',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ path: 'src/a\nb.mts' })] }),
        ),
    ],
    [
      'items[0].path',
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ path: 'src/<!--.mts' })] }),
        ),
    ],
    [
      'items[0].path',
      () =>
        renderDeferBundle(
          bundleInput({
            items: [item({ path: undefined as unknown as string })],
          }),
        ),
    ],
  ];
  for (const [field, run] of cases) {
    assert.throws(
      run,
      (error: unknown) =>
        error instanceof TypeError &&
        error.message.startsWith(`${field} must `),
      `expected a TypeError starting with "${field} must "`,
    );
  }
});

// Lines the defer-source check counts as a Refs line. Render must refuse
// each one as a title or as a finding continuation line; the lint injection
// test below asks the audit itself whether it counts each form.
const COUNTED_BY_AUDIT = [
  'Refs #7 is the origin.',
  'refs #7 is the origin.',
  'REFS: #7 is the origin.',
  '  Refs #7 is the origin.',
  '> Refs #7 is the origin.',
  '> > Refs #7 is the origin.',
  '- Refs #7 is the origin.',
  '* Refs #7 is the origin.',
  '+ Refs #7 is the origin.',
  '`x` Refs #7 is the origin.',
];

// Lines the defer-source check does not count. Render keeps them, and lint
// passes the resulting body.
const NOT_COUNTED_BY_AUDIT = [
  '1. Refs #7 is the origin.',
  '**Refs #7** is the origin.',
  '_Refs #7_ is the origin.',
  'See Refs #7 is the origin.',
];

test('a finding continuation line the defer-source check counts is refused at render', () => {
  for (const line of COUNTED_BY_AUDIT) {
    assert.throws(
      () =>
        renderDeferBundle(
          bundleInput({ items: [item({ finding: `First line.\n${line}` })] }),
        ),
      (error: unknown) =>
        error instanceof TypeError && error.message.startsWith('items must '),
      `expected a refusal for ${JSON.stringify(line)}`,
    );
  }
});

test('a title the defer-source check counts is refused at render', () => {
  for (const title of ['Refs #5 handling', '`foo` Refs #5 handling']) {
    assert.throws(
      () => renderDeferBundle(bundleInput({ items: [item({ title })] })),
      (error: unknown) =>
        error instanceof TypeError && error.message.startsWith('items must '),
      `expected a refusal for ${JSON.stringify(title)}`,
    );
  }
});

test('the audit counts each Refs form that render refuses and ignores each form it keeps', () => {
  const base = renderDeferBundle(bundleInput());
  const inject = (line: string): string =>
    base.body.replace('\n\nRefs #4100\n\n', `\n\n${line}\n\nRefs #4100\n\n`);

  for (const line of COUNTED_BY_AUDIT) {
    const lint = lintDeferBundle({ ...base, body: inject(line) }, 'idd-skill');
    assert.ok(
      lint.failures.some((failure) =>
        failure.startsWith('defer-source-marker: '),
      ),
      `the audit should count ${JSON.stringify(line)} as a Refs line`,
    );
  }
  for (const line of NOT_COUNTED_BY_AUDIT) {
    assert.deepEqual(
      lintDeferBundle({ ...base, body: inject(line) }, 'idd-skill'),
      { passed: true, failures: [] },
      `the audit should not count ${JSON.stringify(line)}`,
    );
  }
});

test('a finding continuation line the defer-source check does not count is kept, and lint passes', () => {
  for (const line of NOT_COUNTED_BY_AUDIT) {
    const rendered = renderDeferBundle(
      bundleInput({ items: [item({ finding: `First line.\n${line}` })] }),
    );
    assert.ok(
      rendered.body.includes(`  ${line}`),
      `${JSON.stringify(line)} should be kept`,
    );
    assert.deepEqual(
      lintDeferBundle(rendered, 'idd-skill'),
      { passed: true, failures: [] },
      `lint should pass for ${JSON.stringify(line)}`,
    );
  }
});

test('a Refs reference on the first finding line stays inside its bullet', () => {
  const rendered = renderDeferBundle(
    bundleInput({ items: [item({ finding: 'Refs #7 is the origin.' })] }),
  );
  assert.ok(rendered.body.includes('- Retry hint: Refs #7 is the origin.'));
  assert.deepEqual(lintDeferBundle(rendered, 'idd-skill'), {
    passed: true,
    failures: [],
  });
});

test('a newline in a title or acceptance becomes a space, and finding keeps its newlines', () => {
  const rendered = renderDeferBundle(
    bundleInput({
      title: 'test(claim):\r\ncover two cases',
      items: [
        item({
          title: 'Retry\nhint',
          acceptance: 'first\nsecond `node --test tests/claim.test.mts` passes',
          finding: 'line one   \r\nline two\t\n\nline four',
        }),
      ],
    }),
  );

  assert.equal(rendered.title, 'test(claim): cover two cases');
  assert.ok(
    rendered.body.includes('- Retry hint: line one\n  line two\n\n  line four'),
  );
  assert.ok(
    rendered.body.includes(
      '- [ ] first second `node --test tests/claim.test.mts` passes',
    ),
  );
});

test('an HTML comment closer in prose is kept, and a trailing newline in threadUrl is trimmed', () => {
  const rendered = renderDeferBundle(
    bundleInput({
      items: [
        item({
          threadUrl: `${THREAD_URL}\n`,
          acceptance:
            'the flow A --> B keeps the lock and `node --test tests/claim.test.mts` passes',
        }),
      ],
    }),
  );
  assert.ok(
    rendered.body.includes(`- Retry hint: ${THREAD_URL}\n\n## Proposed change`),
  );
  assert.ok(
    rendered.body.includes(
      '- [ ] the flow A --> B keeps the lock and `node --test tests/claim.test.mts` passes',
    ),
  );
  assert.deepEqual(lintDeferBundle(rendered, 'idd-skill'), {
    passed: true,
    failures: [],
  });
});

test('items keep their input order in the Background, Proposed change, and Acceptance sections', () => {
  const { body } = renderDeferBundle(
    bundleInput({
      items: [
        item({
          title: 'Beta',
          threadUrl: 'https://example.test/beta',
          finding: 'The beta finding.',
          acceptance:
            'beta acceptance `node --test tests/beta.test.mts` passes',
          path: 'src/beta.mts',
        }),
        item({
          title: 'Alpha',
          threadUrl: 'https://example.test/alpha',
          finding: 'The alpha finding.',
          acceptance:
            'alpha acceptance `node --test tests/alpha.test.mts` passes',
          path: 'src/alpha.mts',
        }),
      ],
    }),
  );
  const pairs: Array<[string, string]> = [
    [
      '- Beta: https://example.test/beta',
      '- Alpha: https://example.test/alpha',
    ],
    ['- Beta: The beta finding.', '- Alpha: The alpha finding.'],
    ['- [ ] beta acceptance', '- [ ] alpha acceptance'],
  ];
  for (const [first, second] of pairs) {
    const firstIndex = body.indexOf(first);
    assert.notEqual(firstIndex, -1, `${first} is missing`);
    assert.ok(
      firstIndex < body.indexOf(second),
      `${first} should precede ${second}`,
    );
  }
});

test('paths are trimmed, deduplicated after trimming, and sorted by code unit', () => {
  const { body } = renderDeferBundle(
    bundleInput({
      items: [
        item({ title: 'Zed', path: ' src/z.mts ' }),
        item({ title: 'Upper', path: 'src/B.mts' }),
        item({ title: 'Again', path: 'src/z.mts' }),
        item({ title: 'Lower', path: 'src/a.mts' }),
      ],
    }),
  );
  assert.deepEqual(candidateLines(body), [
    '- `src/B.mts`',
    '- `src/a.mts`',
    '- `src/z.mts`',
  ]);
  assert.ok(body.includes('<!-- idd-skill-effort: S -->'));
});

test('lint passes a two-item bundle with a conventional title', () => {
  const rendered = renderDeferBundle(bundleInput());
  assert.deepEqual(lintDeferBundle(rendered, 'idd-skill'), {
    passed: true,
    failures: [],
  });
});

test('a Refs reference mid-line in a title does not count as a Refs line for lint', () => {
  const rendered = renderDeferBundle(
    bundleInput({ items: [item({ title: 'Fix the Refs #5 link' })] }),
  );
  assert.ok(rendered.body.includes('- Fix the Refs #5 link: '));
  assert.deepEqual(lintDeferBundle(rendered, 'idd-skill'), {
    passed: true,
    failures: [],
  });
});

test('a markerPrefix with capitals, digits, dots, and underscores is accepted and lints clean', () => {
  const rendered = renderDeferBundle(
    bundleInput({ markerPrefix: '2Acme.v1_x' }),
  );
  assert.ok(rendered.body.includes('<!-- 2Acme.v1_x-effort: S -->'));
  assert.deepEqual(lintDeferBundle(rendered, '2Acme.v1_x'), {
    passed: true,
    failures: [],
  });
});

test('lint fails on a markerPrefix that does not match the rendered markers', () => {
  const rendered = renderDeferBundle(bundleInput({ markerPrefix: 'acme' }));
  const lint = lintDeferBundle(rendered, 'idd-skill');
  assert.equal(lint.passed, false);
  assert.ok(
    lint.failures.some((failure) =>
      failure.startsWith('marker-prefix-consistency: '),
    ),
  );
  assert.ok(
    lint.failures.some((failure) =>
      failure.startsWith('defer-source-marker: '),
    ),
  );
  for (const failure of lint.failures) {
    assert.match(failure, /^[a-z0-9-]+: .+$/);
  }
});

test('lint fails a second Refs line with defer-source-marker', () => {
  const rendered = renderDeferBundle(bundleInput());
  const doubled = {
    ...rendered,
    body: rendered.body.replace(
      '\n\nRefs #4100\n\n',
      '\n\nRefs #4100\n\nRefs #5\n\n',
    ),
  };
  const lint = lintDeferBundle(doubled, 'idd-skill');
  assert.equal(lint.passed, false);
  assert.ok(
    lint.failures.some((failure) =>
      failure.startsWith('defer-source-marker: '),
    ),
  );
});

test('lint fails an acceptance with no verification signal', () => {
  const rendered = renderDeferBundle(
    bundleInput({
      items: [item({ acceptance: 'The retry hint reads better' })],
    }),
  );
  const lint = lintDeferBundle(rendered, 'idd-skill');
  assert.equal(lint.passed, false);
  assert.ok(
    lint.failures.some((failure) =>
      failure.startsWith('triage-a45-verifiability: '),
    ),
  );
});
