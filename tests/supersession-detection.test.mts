import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildClosedByMergedPrArgs,
  buildMergedPrListArgs,
  buildPrDetailArgs,
  evaluateHighConfidenceDuplicate,
  findCandidateFileOverlap,
  prReferencesIssue,
  resolveCandidateFileSet,
} from '../src/scripts/supersession-detection.mts';

// --- #1499: relocated from tests/suitability-triage.test.mts ---------------
// evaluateHighConfidenceDuplicate and the three argv-builders moved out of
// suitability-triage.mts into this shared module (#1499); these tests move
// with them -- import path only, assertion bodies unchanged (#1499's own
// acceptance criteria explicitly allow this). checkDuplicateOrSuperseded /
// evaluateSuitability integration tests that exercise Check 4 through the
// still-local checkDuplicateOrSuperseded stay in
// tests/suitability-triage.test.mts.

// --- #1484: high-confidence Check 4 tier ------------------------------------

test('evaluateHighConfidenceDuplicate: undefined input is absent, not a hit', () => {
  assert.equal(evaluateHighConfidenceDuplicate(undefined, 1234), null);
});

test('evaluateHighConfidenceDuplicate: empty arrays fall through (fail-safe)', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    1234,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: malformed (non-array) fields never crash and never hit', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: 'not-an-array',
      candidateFiles: null,
      highContentionFiles: undefined,
      mergedPrs: 42,
    } as unknown as Parameters<typeof evaluateHighConfidenceDuplicate>[0],
    1234,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: closing-PR-reference hit cites the PR number', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [123],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    1234,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#123/);
  assert.match(result?.evidence ?? '', /closedByPullRequestsReferences/);
});

test('evaluateHighConfidenceDuplicate: same-candidate-files hit cites the PR number and file', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['scripts/foo.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 456,
          mergedAt: '2026-07-10T00:00:00Z',
          files: ['scripts/foo.mjs', 'docs/unrelated.md'],
          // #1878: the merged PR must also reference the candidate issue
          // itself for this to remain a true positive under the new rule.
          closingIssuesReferences: [900],
          title: '',
          body: '',
        },
      ],
    },
    900,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#456/);
  assert.match(result?.evidence ?? '', /scripts\/foo\.mjs/);
  assert.doesNotMatch(result?.evidence ?? '', /unrelated\.md/);
});

test('evaluateHighConfidenceDuplicate: reuses normalizeContentionPath so mirrored instruction paths still match', () => {
  // Same basename cited two different ways: the issue's own '## Candidate
  // files' style (idd-template source path) vs. the merged PR's actual
  // changed-file path (generated mirror). Proves real reuse of
  // discover-shared-file-overlap's normalization, not a re-implementation
  // that only matches identical strings.
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: [
        'idd-template/.github/instructions/idd-work.instructions.md',
      ],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 789,
          mergedAt: '2026-07-11T00:00:00Z',
          files: ['.github/instructions/idd-work.instructions.md'],
          closingIssuesReferences: [700],
          title: '',
          body: '',
        },
      ],
    },
    700,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#789/);
});

test('evaluateHighConfidenceDuplicate: a high-contention-only overlap is not high-confidence evidence', () => {
  // The only shared file is in the high-contention exclusion set, so this
  // must fall through (null), not fire -- a coincidental hit on a
  // broadly-shared file is not evidence THIS issue was superseded.
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['audit/sync-manifest.json'],
      highContentionFiles: ['audit/sync-manifest.json'],
      mergedPrs: [
        {
          number: 999,
          mergedAt: '2026-07-12T00:00:00Z',
          files: ['audit/sync-manifest.json'],
          closingIssuesReferences: [],
          title: '',
          body: '',
        },
      ],
    },
    999,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: a genuine file still hits when a co-listed file is high-contention', () => {
  // Regression guard for the exclusion filter being too aggressive: a
  // candidate list with one high-contention file and one genuine file must
  // still fire on the genuine file's overlap.
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['audit/sync-manifest.json', 'scripts/genuine.mjs'],
      highContentionFiles: ['audit/sync-manifest.json'],
      mergedPrs: [
        {
          number: 1000,
          mergedAt: '2026-07-13T00:00:00Z',
          files: ['audit/sync-manifest.json', 'scripts/genuine.mjs'],
          closingIssuesReferences: [500],
          title: '',
          body: '',
        },
      ],
    },
    500,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /scripts\/genuine\.mjs/);
  assert.doesNotMatch(result?.evidence ?? '', /sync-manifest\.json/);
});

test('evaluateHighConfidenceDuplicate: closing-PR-reference is checked before the file-overlap scan', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [111],
      candidateFiles: ['scripts/foo.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 222,
          mergedAt: '',
          files: ['unrelated.mjs'],
          closingIssuesReferences: [],
          title: '',
          body: '',
        },
      ],
    },
    111,
  );
  assert.match(result?.evidence ?? '', /#111/);
  assert.doesNotMatch(result?.evidence ?? '', /#222/);
});

// --- #1499: typed tier field -------------------------------------------------

test('evaluateHighConfidenceDuplicate: a closing-PR-reference hit carries tier "high-confidence"', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [42],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    42,
  );
  assert.equal(result?.tier, 'high-confidence');
});

test('evaluateHighConfidenceDuplicate: a same-candidate-files hit carries tier "high-confidence"', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['scripts/foo.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 456,
          mergedAt: '2026-07-10T00:00:00Z',
          files: ['scripts/foo.mjs'],
          closingIssuesReferences: [800],
          title: '',
          body: '',
        },
      ],
    },
    800,
  );
  assert.equal(result?.tier, 'high-confidence');
});

// --- #1878: same-issue-reference requirement --------------------------------
// File overlap alone is no longer sufficient for the high-confidence tier;
// the merged PR must also reference the candidate issue itself, via
// closingIssuesReferences or a word-bounded '#<candidate-number>'
// cross-reference in its title/body.

test('evaluateHighConfidenceDuplicate: file overlap with no reference to the candidate falls through (#1862 vs #1863/PR#1864)', () => {
  // Synthesizes the real false positive this issue fixes: sibling issue
  // #1863 lists the same '## Candidate files' as candidate issue #1862;
  // PR #1864 merges closing #1863 and touches those files, but its
  // title/body never mentions #1862 and its closingIssuesReferences closes
  // #1863, not #1862.
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: [
        'src/scripts/markdown-code.mts',
        'tests/suitability-triage.test.mts',
      ],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 1864,
          mergedAt: '2026-08-04T00:00:00Z',
          files: [
            'src/scripts/markdown-code.mts',
            'tests/suitability-triage.test.mts',
          ],
          closingIssuesReferences: [1863],
          title: 'fix(markdown-code): preserve opaque fence state',
          body: 'Closes #1863',
        },
      ],
    },
    1862,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: true positive preserved via closingIssuesReferences', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['scripts/target.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 2000,
          mergedAt: '2026-08-01T00:00:00Z',
          files: ['scripts/target.mjs'],
          closingIssuesReferences: [1862],
          title: 'unrelated title',
          body: 'unrelated body',
        },
      ],
    },
    1862,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#2000/);
  assert.match(result?.evidence ?? '', /references issue #1862/);
});

test('evaluateHighConfidenceDuplicate: true positive preserved via a title/body #<number> cross-reference', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['scripts/target.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 2001,
          mergedAt: '2026-08-01T00:00:00Z',
          files: ['scripts/target.mjs'],
          closingIssuesReferences: [],
          title: 'fix: address feedback',
          body: 'Refs #1862 for background.',
        },
      ],
    },
    1862,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#2001/);
});

test('evaluateHighConfidenceDuplicate: scan continues past a non-qualifying overlap to a later qualifying PR', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      closedByMergedPrNumbers: [],
      candidateFiles: ['scripts/shared.mjs'],
      highContentionFiles: [],
      mergedPrs: [
        {
          // Overlaps but never references the candidate -- must be
          // skipped, not returned.
          number: 3000,
          mergedAt: '2026-08-01T00:00:00Z',
          files: ['scripts/shared.mjs'],
          closingIssuesReferences: [9999],
          title: 'unrelated sibling',
          body: '',
        },
        {
          // Overlaps AND references the candidate -- this is the hit.
          number: 3001,
          mergedAt: '2026-08-02T00:00:00Z',
          files: ['scripts/shared.mjs'],
          closingIssuesReferences: [1862],
          title: '',
          body: '',
        },
      ],
    },
    1862,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#3001/);
  assert.doesNotMatch(result?.evidence ?? '', /#3000/);
});

// --- #1878: prReferencesIssue -----------------------------------------------

test('prReferencesIssue: matches via closingIssuesReferences', () => {
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [1862], title: '', body: '' },
      1862,
    ),
    true,
  );
});

test('prReferencesIssue: matches a plain "#1862" in the title', () => {
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: 'Refs #1862', body: '' },
      1862,
    ),
    true,
  );
});

test('prReferencesIssue: matches "Closes #1862" in the body', () => {
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: '', body: 'Closes #1862' },
      1862,
    ),
    true,
  );
});

test('prReferencesIssue: word-boundary rejects a longer number sharing the same prefix', () => {
  // "#18620" must not match candidate 1862 -- there is no word boundary
  // between two digits.
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: 'Refs #18620', body: '' },
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: no match when neither signal references the issue', () => {
  assert.equal(
    prReferencesIssue(
      {
        closingIssuesReferences: [1863],
        title: 'unrelated',
        body: 'unrelated',
      },
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: malformed fields degrade to no reference, never crash', () => {
  assert.equal(
    prReferencesIssue(
      {
        closingIssuesReferences: 'not-an-array',
        title: null,
        body: undefined,
      } as unknown as Parameters<typeof prReferencesIssue>[0],
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: an invalid issueNumber always returns false', () => {
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [1862], title: '', body: '' },
      0,
    ),
    false,
  );
});

// --- #1815: extracted resolveCandidateFileSet / findCandidateFileOverlap ---
// evaluateHighConfidenceDuplicate now calls these instead of inlining the
// same logic; the tests above already prove the refactor is
// behavior-preserving end-to-end. These cover the extracted helpers
// directly, since suitability-triage.mts's `fetchMergedPrFileOverlapEvidence`
// early exit (#1815) now reuses them independently of
// evaluateHighConfidenceDuplicate.

test('resolveCandidateFileSet: normalizes and excludes high-contention files', () => {
  const set = resolveCandidateFileSet(
    ['scripts/genuine.mjs', 'audit/sync-manifest.json'],
    ['audit/sync-manifest.json'],
  );
  assert.equal(set.has('scripts/genuine.mjs'), true);
  assert.equal(set.has('audit/sync-manifest.json'), false);
  assert.equal(set.size, 1);
});

test('resolveCandidateFileSet: an empty candidateFiles list resolves to an empty set', () => {
  const set = resolveCandidateFileSet([], []);
  assert.equal(set.size, 0);
});

test('resolveCandidateFileSet: reuses normalizeContentionPath so mirrored instruction paths still match', () => {
  // normalizeContentionPath reduces any `*.instructions.md` path to its
  // basename (idd-template source vs. generated .github/instructions/
  // mirror share one normalized key) -- same fixture shape as the
  // evaluateHighConfidenceDuplicate test above, exercised directly against
  // the extracted helper.
  const set = resolveCandidateFileSet(
    ['idd-template/.github/instructions/idd-work.instructions.md'],
    [],
  );
  assert.equal(set.has('idd-work.instructions.md'), true);
});

test('findCandidateFileOverlap: returns overlapping normalized files only', () => {
  const set = resolveCandidateFileSet(['scripts/genuine.mjs'], []);
  const overlap = findCandidateFileOverlap(
    ['scripts/genuine.mjs', 'docs/unrelated.md'],
    set,
  );
  assert.deepEqual(overlap, ['scripts/genuine.mjs']);
});

test('findCandidateFileOverlap: an empty candidateSet always returns no overlap', () => {
  const overlap = findCandidateFileOverlap(
    ['scripts/genuine.mjs'],
    new Set<string>(),
  );
  assert.deepEqual(overlap, []);
});

test('findCandidateFileOverlap: no overlap when files are disjoint from the set', () => {
  const set = resolveCandidateFileSet(['scripts/genuine.mjs'], []);
  const overlap = findCandidateFileOverlap(['docs/unrelated.md'], set);
  assert.deepEqual(overlap, []);
});

// --- #1484: detect-only boundary (argv-builder read-verb assertions) -------
// A compiled-text grep for mutating verb literals would miss a
// `gh api ... -X POST`-shaped mutation, since none of this file's own calls
// use one. Instead, assert directly on the argv each builder produces: the
// gh subcommand-verb position (index 1) must be an allow-listed read verb,
// and no mutating flag/verb literal appears anywhere in the argv.
const READ_VERBS = new Set(['view', 'list']);
const FORBIDDEN_TOKENS = new Set([
  'close',
  'comment',
  'edit',
  'merge',
  'reopen',
  'delete',
  '-X',
  '--method',
]);

function assertReadOnlyArgv(args: string[]): void {
  if (args[0] === 'api') {
    // gh api graphql: the payload must be a `query` operation, never a
    // `mutation`, so check the actual `-f query=...` value rather than an
    // allow-listed subcommand-verb position.
    assert.equal(args[1], 'graphql');
    const queryArg = args.find((arg) => arg.startsWith('query='));
    assert.equal(typeof queryArg, 'string');
    assert.match(queryArg ?? '', /^query=\s*query[\s(]/);
    assert.doesNotMatch(queryArg ?? '', /\bmutation\b/);
  } else {
    assert.equal(args[0] === 'issue' || args[0] === 'pr', true);
    assert.equal(READ_VERBS.has(args[1]), true);
  }
  for (const token of args) {
    assert.equal(
      FORBIDDEN_TOKENS.has(token),
      false,
      `unexpected mutating token "${token}" in argv: ${JSON.stringify(args)}`,
    );
  }
}

test('buildClosedByMergedPrArgs is read-only', () => {
  assertReadOnlyArgv(
    buildClosedByMergedPrArgs('kurone-kito', 'idd-skill', 1484),
  );
});

test('buildClosedByMergedPrArgs requests state so callers can filter to MERGED', () => {
  // Regression guard for a real bug caught by review: the REST-shimmed `gh
  // issue view --json closedByPullRequestsReferences` carries no per-PR
  // `state` and includes OPEN (not yet merged) PRs, not only merged ones.
  // The GraphQL query built here must request `state` explicitly so the
  // caller can filter to MERGED before treating a hit as high-confidence
  // evidence.
  const args = buildClosedByMergedPrArgs('kurone-kito', 'idd-skill', 1484);
  const queryArg = args.find((arg) => arg.startsWith('query=')) ?? '';
  assert.match(queryArg, /closedByPullRequestsReferences/);
  assert.match(queryArg, /\bstate\b/);
  assert.match(queryArg, /\bnumber\b/);
});

test('buildMergedPrListArgs is read-only', () => {
  assertReadOnlyArgv(
    buildMergedPrListArgs('kurone-kito/idd-skill', '2026-07-01T00:00:00Z'),
  );
});

test('buildPrDetailArgs is read-only', () => {
  assertReadOnlyArgv(buildPrDetailArgs('kurone-kito/idd-skill', 1492));
});

test('buildPrDetailArgs requests title, body, and closingIssuesReferences on the same call (#1878, no new API calls)', () => {
  const args = buildPrDetailArgs('kurone-kito/idd-skill', 1492);
  const jsonIndex = args.indexOf('--json');
  assert.notEqual(jsonIndex, -1);
  const fields = (args[jsonIndex + 1] ?? '').split(',');
  assert.equal(fields.includes('files'), true);
  assert.equal(fields.includes('title'), true);
  assert.equal(fields.includes('body'), true);
  assert.equal(fields.includes('closingIssuesReferences'), true);
});
