import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  consumeDependencyContinuationRefLines,
  consumeDependencyReferenceList,
  extractDependencyReferences,
  matchDependencyKeywordLine,
  normalizeDependencyRepoRef,
} from '../src/scripts/dependency-grammar.mts';
import { extractBlockedByReferences } from '../src/scripts/discover-orphan-filter.mts';
import { extractBlockedByIssueNumbers } from '../src/scripts/discover-readiness-check.mts';
import { extractKeywordReferences } from '../src/scripts/discover-roadmap-graph.mts';

const CURRENT_REPO = 'kurone-kito/idd-skill';

test('normalizeDependencyRepoRef lowercases and requires both halves', () => {
  assert.equal(
    normalizeDependencyRepoRef('Kurone-Kito', 'Idd-Skill'),
    'kurone-kito/idd-skill',
  );
  assert.equal(normalizeDependencyRepoRef('owner', ''), '');
  assert.equal(normalizeDependencyRepoRef('', 'repo'), '');
  assert.equal(normalizeDependencyRepoRef(undefined, undefined), '');
});

// Background-table rows (issue #3284), post-fix outcomes.

test('extractDependencyReferences: ordinal-list "Blocked by" resolves (row 1)', () => {
  assert.deepEqual(
    extractDependencyReferences('1. Blocked by #12', 'Blocked by'),
    { numbers: [12], unresolvable: [] },
  );
});

test('extractDependencyReferences: mid-sentence "Blocked by" is never a dependency (row 2)', () => {
  assert.deepEqual(
    extractDependencyReferences(
      'This work is Blocked by #12 until it lands.',
      'Blocked by',
    ),
    { numbers: [], unresolvable: [] },
  );
});

test('extractDependencyReferences: same-repo qualified token resolves to local (row 3)', () => {
  assert.deepEqual(
    extractDependencyReferences(
      'Blocked by kurone-kito/idd-skill#12',
      'Blocked by',
      { currentRepo: CURRENT_REPO },
    ),
    { numbers: [12], unresolvable: [] },
  );
});

test('extractDependencyReferences: cross-repo token is unresolvable, parsing continues past it (row 4)', () => {
  assert.deepEqual(
    extractDependencyReferences('Blocked by other/repo#5, #13', 'Blocked by', {
      currentRepo: CURRENT_REPO,
    }),
    {
      numbers: [13],
      unresolvable: [
        { token: 'other/repo#5', reason: 'cross_repository_reference' },
      ],
    },
  );
});

test('extractDependencyReferences: local refs on both sides of a cross-repo token (row 5)', () => {
  assert.deepEqual(
    extractDependencyReferences(
      'Blocked by #12, other/repo#5, #13',
      'Blocked by',
      { currentRepo: CURRENT_REPO },
    ),
    {
      numbers: [12, 13],
      unresolvable: [
        { token: 'other/repo#5', reason: 'cross_repository_reference' },
      ],
    },
  );
});

test('extractDependencyReferences: a single-line HTML comment is never a dependency (row 6)', () => {
  assert.deepEqual(
    extractDependencyReferences('<!-- Blocked by #12 -->', 'Blocked by'),
    { numbers: [], unresolvable: [] },
  );
});

test('extractDependencyReferences: a multi-line HTML comment is never a dependency (row 7)', () => {
  const body = ['<!--', 'Blocked by #12', '-->'].join('\n');
  assert.deepEqual(extractDependencyReferences(body, 'Blocked by'), {
    numbers: [],
    unresolvable: [],
  });
});

// Extra pinned cases from the issue's acceptance criteria.

test('extractDependencyReferences: bullet-list prefix', () => {
  assert.deepEqual(
    extractDependencyReferences('- Blocked by #12', 'Blocked by'),
    {
      numbers: [12],
      unresolvable: [],
    },
  );
});

test('extractDependencyReferences: blockquote prefix with colon', () => {
  assert.deepEqual(
    extractDependencyReferences('> Blocked by: #12', 'Blocked by'),
    { numbers: [12], unresolvable: [] },
  );
});

test('extractDependencyReferences: "and"-joined list', () => {
  assert.deepEqual(
    extractDependencyReferences('Blocked by #12 and #13', 'Blocked by'),
    { numbers: [12, 13], unresolvable: [] },
  );
});

test('extractDependencyReferences: a two-line wrapped list (#2441)', () => {
  const body = 'Blocked by #12, #13,\n#14, #15';
  assert.deepEqual(extractDependencyReferences(body, 'Blocked by'), {
    numbers: [12, 13, 14, 15],
    unresolvable: [],
  });
});

test('extractDependencyReferences: a CRLF body', () => {
  const body = 'Intro line\r\nBlocked by #12, #13\r\nOutro line';
  assert.deepEqual(extractDependencyReferences(body, 'Blocked by'), {
    numbers: [12, 13],
    unresolvable: [],
  });
});

test('extractDependencyReferences: a line inside a fenced block is never a dependency', () => {
  const body = ['Intro', '```', 'Blocked by #12, #13', '```', 'Outro'].join(
    '\n',
  );
  assert.deepEqual(extractDependencyReferences(body, 'Blocked by'), {
    numbers: [],
    unresolvable: [],
  });
});

// Depends on keyword parity (same grammar, different keyword).

test('extractDependencyReferences: "Depends on" uses the same grammar', () => {
  assert.deepEqual(
    extractDependencyReferences(
      'Depends on #20, other/repo#21, #22',
      'Depends on',
      {
        currentRepo: CURRENT_REPO,
      },
    ),
    {
      numbers: [20, 22],
      unresolvable: [
        { token: 'other/repo#21', reason: 'cross_repository_reference' },
      ],
    },
  );
});

// Lower-level helpers, exercised directly.

test('consumeDependencyReferenceList stops at the first non-token, non-separator text', () => {
  assert.deepEqual(consumeDependencyReferenceList('#10 (see other/repo#20)'), {
    numbers: [10],
    unresolvable: [],
    remaining: '(see other/repo#20)',
    consumedTokenEnd: 3,
    invalidTokens: [],
  });
});

test('consumeDependencyReferenceList reports a qualified token unresolvable when the current repo is unknown', () => {
  assert.deepEqual(consumeDependencyReferenceList('kurone-kito/idd-skill#12'), {
    numbers: [],
    unresolvable: [
      {
        token: 'kurone-kito/idd-skill#12',
        reason: 'cross_repository_reference',
      },
    ],
    remaining: '',
    consumedTokenEnd: 24,
    invalidTokens: [],
  });
});

test('consumeDependencyReferenceList resolves a full GitHub issue URL for the current repo', () => {
  assert.deepEqual(
    consumeDependencyReferenceList(
      'https://github.com/kurone-kito/idd-skill/issues/42',
      { currentRepo: CURRENT_REPO },
    ),
    {
      numbers: [42],
      unresolvable: [],
      remaining: '',
      consumedTokenEnd: 50,
      invalidTokens: [],
    },
  );
});

test('consumeDependencyContinuationRefLines stops at a blank line', () => {
  const lines = ['Blocked by #1', '#2, #3', '', '#4 is unrelated'];
  assert.deepEqual(consumeDependencyContinuationRefLines(lines, 1), {
    numbers: [2, 3],
    unresolvable: [],
    invalidTokens: [],
  });
});

// Parity: `extractBlockedByIssueNumbers` (discover-readiness-check.mts),
// the orphan filter's `extractBlockedByReferences`, and
// `extractKeywordReferences` (discover-roadmap-graph.mts, filtered to
// `relationship === 'dependency'`) must agree on the resolved local
// numbers for every pinned "Blocked by" body above, including a
// non-parenthetical mid-sentence mention ("This work is Blocked by #12
// until it lands.") -- all three now share `dependency-grammar.mts`'s
// ref-list grammar AND its line-anchoring, per the issue's Maintainer
// decision naming the line-anchored grammar authoritative for every
// helper (see the updated `discover-roadmap-graph.test.mts` #2799 test
// for the roadmap graph's own no-longer-divergent behavior on this exact
// mid-sentence shape).
const PARITY_BODIES = [
  '1. Blocked by #12',
  'This work is Blocked by #12 until it lands.',
  'Blocked by kurone-kito/idd-skill#12',
  'Blocked by other/repo#5, #13',
  'Blocked by #12, other/repo#5, #13',
  '<!-- Blocked by #12 -->',
  ['<!--', 'Blocked by #12', '-->'].join('\n'),
  '- Blocked by #12',
  '> Blocked by: #12',
  'Blocked by #12 and #13',
  'Blocked by #12, #13,\n#14, #15',
  'Intro line\r\nBlocked by #12, #13\r\nOutro line',
  ['Intro', '```', 'Blocked by #12, #13', '```', 'Outro'].join('\n'),
];

test('#3284 parity: extractBlockedByIssueNumbers, the orphan filter, and extractKeywordReferences agree on local numbers', () => {
  for (const body of PARITY_BODIES) {
    const readinessNumbers = extractBlockedByIssueNumbers(body, CURRENT_REPO);
    const orphanNumbers = extractBlockedByReferences(body, CURRENT_REPO);
    const graphNumbers = extractKeywordReferences(body, {
      currentRepoRef: CURRENT_REPO,
    })
      .filter((reference) => reference.relationship === 'dependency')
      .map((reference) => reference.target);

    assert.deepEqual(
      orphanNumbers,
      readinessNumbers,
      `orphan filter mismatch for: ${JSON.stringify(body)}`,
    );
    assert.deepEqual(
      graphNumbers,
      readinessNumbers,
      `graph mismatch for: ${JSON.stringify(body)}`,
    );
  }
});

test('#3284 review fix: trailing prose on the keyword line suppresses the continuation sweep', () => {
  // A keyword line that is NOT entirely a reference list (trailing prose
  // or punctuation after the last token) is not a GitHub-wrapped list
  // (#2441), so the immediately-following bare-`#N` line must not be
  // swept in as a continuation -- it is unrelated text. Verified against
  // a real bug: the unconditional sweep previously captured #20 here too.
  assert.deepEqual(
    extractDependencyReferences('Blocked by #10.\n#20', 'Blocked by'),
    { numbers: [10], unresolvable: [] },
  );
});

// --- matchDependencyKeywordLine (#3285) ---

test('matchDependencyKeywordLine returns numbers plus the same-line unconsumed remaining text', () => {
  assert.deepEqual(
    matchDependencyKeywordLine(
      ['Blocked by #12. Depends on #13'],
      0,
      'Blocked by',
    ),
    {
      numbers: [12],
      unresolvable: [],
      remaining: '. Depends on #13',
      invalidTokens: [],
    },
  );
});

test('matchDependencyKeywordLine returns an empty remaining string when the reference list consumes the rest of the line', () => {
  assert.deepEqual(
    matchDependencyKeywordLine(['Blocked by #12'], 0, 'Blocked by'),
    { numbers: [12], unresolvable: [], remaining: '', invalidTokens: [] },
  );
});

test('matchDependencyKeywordLine returns undefined for a malformed token with no word boundary after the digits (#3285 E2 review, Copilot: "Blocked by #12foo")', () => {
  assert.equal(
    matchDependencyKeywordLine(['Blocked by #12foo'], 0, 'Blocked by'),
    undefined,
  );
});

test('matchDependencyKeywordLine returns undefined for a non-positive issue number (#3285 E2 review, Copilot: "Blocked by #0")', () => {
  assert.equal(
    matchDependencyKeywordLine(['Blocked by #0'], 0, 'Blocked by'),
    undefined,
  );
});

test('matchDependencyKeywordLine still returns a defined result for a cross-repository token even though it resolves zero local numbers', () => {
  // An unresolvable (cross-repository) token is a genuine, meaningful
  // outcome distinct from "nothing was extracted at all" -- the
  // numbers.length === 0 && unresolvable.length === 0 guard must not
  // also suppress this case.
  assert.deepEqual(
    matchDependencyKeywordLine(['Blocked by other/repo#5'], 0, 'Blocked by', {
      currentRepo: 'kurone-kito/idd-skill',
    }),
    {
      numbers: [],
      unresolvable: [
        { token: 'other/repo#5', reason: 'cross_repository_reference' },
      ],
      remaining: '',
      invalidTokens: [],
    },
  );
});

test('consumeDependencyReferenceList records an invalid bare token without dropping the valid ones around it (#3285 final review round, Copilot: "#0, #12")', () => {
  assert.deepEqual(consumeDependencyReferenceList('#0, #12'), {
    numbers: [12],
    unresolvable: [],
    remaining: '',
    consumedTokenEnd: 7,
    invalidTokens: ['#0'],
  });
});

test('matchDependencyKeywordLine still returns a defined result with numbers when an invalid token is mixed in, but reports it in invalidTokens', () => {
  assert.deepEqual(
    matchDependencyKeywordLine(['Blocked by #0, #12'], 0, 'Blocked by'),
    { numbers: [12], unresolvable: [], remaining: '', invalidTokens: ['#0'] },
  );
});

test('consumeDependencyContinuationRefLines reports an invalid token on an invalid-only continuation line instead of silently discarding it (final review round, Copilot: "Blocked by #12,\\n#0")', () => {
  const lines = ['Blocked by #12,', '#0'];
  assert.deepEqual(consumeDependencyContinuationRefLines(lines, 1), {
    numbers: [],
    unresolvable: [],
    invalidTokens: ['#0'],
  });
});

test('consumeDependencyContinuationRefLines still reports nothing for genuinely unrelated prose (no token-shaped text at all)', () => {
  const lines = ['Blocked by #12,', 'unrelated text'];
  assert.deepEqual(consumeDependencyContinuationRefLines(lines, 1), {
    numbers: [],
    unresolvable: [],
    invalidTokens: [],
  });
});

test("matchDependencyKeywordLine surfaces an invalid-only continuation line's token via invalidTokens", () => {
  const result = matchDependencyKeywordLine(
    ['Blocked by #12,', '#0'],
    0,
    'Blocked by',
  );
  assert.deepEqual(result, {
    numbers: [12],
    unresolvable: [],
    // The trailing comma on the keyword line itself is same-line
    // unconsumed text by `consumedTokenEnd`'s own definition (measured
    // before the trailing separator is stripped) -- unrelated to the
    // continuation-line fix this test targets, which is that `#0`'s
    // own invalidTokens entry below is no longer silently dropped.
    remaining: ',',
    invalidTokens: ['#0'],
  });
});
