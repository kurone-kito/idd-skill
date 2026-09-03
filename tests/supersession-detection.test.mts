import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildClosedByMergedPrArgs,
  buildMergedPrByBranchArgs,
  buildMergedPrListArgs,
  buildPrDetailArgs,
  evaluateHighConfidenceDuplicate,
  findCandidateFileOverlap,
  findTrustedSuitabilityRejection,
  isSuitabilityTriageVerdictCurrent,
  parseSuitabilityTriageVerdictMarker,
  prReferencesIssue,
  resolveCandidateFileSet,
  resolveLatestSubstantiveIssueEditAt,
  SUITABILITY_REJECTION_PREFIX,
  type SuitabilityRejectionComment,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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

test('evaluateHighConfidenceDuplicate: branch-name-match hit cites the PR number (#2313, Signal 3)', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: { number: 2254, mergedAt: '2026-08-23T21:47:05Z' },
      closedByMergedPrNumbers: [],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    2222,
  );
  assert.equal(result?.pass, false);
  assert.equal(result?.tier, 'high-confidence');
  assert.match(result?.evidence ?? '', /#2254/);
  assert.match(result?.evidence ?? '', /2026-08-23T21:47:05Z/);
});

test("evaluateHighConfidenceDuplicate: reproduces the exact #2222 miss -- a merged PR on the issue's own convention-computed branch, no closing keyword, no Candidate-files overlap (#2313)", () => {
  // The real #2222 shape: PR #2254 merged on branch
  // issue/2222-fix-onboard-prefer-existing-config-json with no closing
  // keyword and no textual '## Candidate files' overlap -- Signals 1 and 2
  // both miss it (closedByMergedPrNumbers empty, candidateFiles empty so
  // the file-overlap scan never runs at all). Only Signal 3 (an exact
  // branch-name match, collected by the CLI glue's own
  // fetchMergedPrByBranchName lookup and passed in here as
  // branchNameMergedPr) catches it.
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: { number: 2254, mergedAt: '2026-08-23T21:47:05Z' },
      closedByMergedPrNumbers: [],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    2222,
  );
  assert.equal(result?.pass, false);
  assert.equal(result?.tier, 'high-confidence');
});

test('evaluateHighConfidenceDuplicate: branch-name-match is checked before the other two signals (order does not change the outcome, but evidence cites signal 3)', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: { number: 2254, mergedAt: '2026-08-23T21:47:05Z' },
      closedByMergedPrNumbers: [999],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    2222,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#2254/);
  assert.doesNotMatch(result?.evidence ?? '', /#999/);
});

test('evaluateHighConfidenceDuplicate: a malformed branchNameMergedPr (non-positive number) falls through, never crashes', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      // deliberately malformed to exercise the defensive guard
      branchNameMergedPr: { number: 0, mergedAt: '2026-08-23T21:47:05Z' },
      closedByMergedPrNumbers: [],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    2222,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: a positive branchNameMergedPr.number with an empty mergedAt never produces Signal 3 evidence (CodeRabbit review finding, #2313)', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: { number: 2254, mergedAt: '' },
      closedByMergedPrNumbers: [],
      candidateFiles: [],
      highContentionFiles: [],
      mergedPrs: [],
    },
    2222,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: same-candidate-files hit cites the PR number and file', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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
      branchNameMergedPr: null,
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

test('evaluateHighConfidenceDuplicate: true positive preserved via a title/body closing-keyword cross-reference (#1888)', () => {
  // #1888 acceptance criterion 2: a closing-keyword mention (e.g.
  // "Fixes #<B>") without closingIssuesReferences coverage still fails
  // Check 4 as high-confidence. Prior to #1888 this test used a bare
  // "Refs #1862" body, which the #1888 narrowing now correctly treats as
  // NOT a reference (see the dedicated bare-mention test below) -- this
  // slot is repurposed to a genuine closing-keyword form instead of just
  // flipping the old assertion, so it still exercises a true positive.
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: null,
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
          body: 'Fixes #1862 for the shared behavior.',
        },
      ],
    },
    1862,
  );
  assert.equal(result?.pass, false);
  assert.match(result?.evidence ?? '', /#2001/);
});

test('evaluateHighConfidenceDuplicate: a bare "#<n>" citation with no closing keyword is not a hit (#1888; #1862 vs PR #1886 shape)', () => {
  // #1888 acceptance criterion 1: reproduces the live false positive --
  // merged PR #1886 closes only #1878, but its body bare-cites #1862 once
  // as a narrative reproduction-example ("observed live: issue #1862 vs.
  // merged PR #1864...") while also overlapping #1862's own declared
  // candidate file. Before #1888, condition (b)'s unconditional bare-
  // mention fallback treated that citation alone as evidence PR #1886
  // superseded #1862; the narrowed regex requires an adjacent closing
  // keyword, which this citation never had, so the verdict must now be
  // `null` (falls through to the caller's weak heuristic), not a hit.
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: null,
      closedByMergedPrNumbers: [],
      candidateFiles: ['tests/suitability-triage.test.mts'],
      highContentionFiles: [],
      mergedPrs: [
        {
          number: 1886,
          mergedAt: '2026-08-05T00:00:00Z',
          files: ['tests/suitability-triage.test.mts'],
          closingIssuesReferences: [1878],
          title: "fix(suitability-triage): Check 4's bare-mention condition",
          body: 'observed live: issue #1862 vs. merged PR #1864 reproduced the Check 4 bug this PR fixes.',
        },
      ],
    },
    1862,
  );
  assert.equal(result, null);
});

test('evaluateHighConfidenceDuplicate: scan continues past a non-qualifying overlap to a later qualifying PR', () => {
  const result = evaluateHighConfidenceDuplicate(
    {
      branchNameMergedPr: null,
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

test('prReferencesIssue: matches via a raw { number } object entry (Copilot review finding, PR #1886)', () => {
  // gh pr view --json closingIssuesReferences actually returns an array of
  // { number, ... } objects, not raw numbers -- confirmed empirically. A
  // caller that ever passes that unnormalized shape straight through must
  // still match, not silently degrade to "no reference".
  assert.equal(
    prReferencesIssue(
      {
        closingIssuesReferences: [{ number: 1862 }],
        title: '',
        body: '',
      },
      1862,
    ),
    true,
  );
});

test('prReferencesIssue: a { number } object entry with a different number still does not match', () => {
  assert.equal(
    prReferencesIssue(
      {
        closingIssuesReferences: [{ number: 9999 }],
        title: '',
        body: '',
      },
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: a bare "#1862" in the title with no closing keyword does not match (#1888)', () => {
  // #1888: prior to this fix, any bare "#<n>" mention matched
  // unconditionally (#1878) -- "Refs #1862" cites the issue without
  // declaring the PR implements it, and must no longer count as a
  // reference.
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: 'Refs #1862', body: '' },
      1862,
    ),
    false,
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

test('prReferencesIssue: matches every recognized closing keyword, case-insensitively and in past tense (#1888)', () => {
  for (const body of [
    'Closes #1862',
    'closes #1862',
    'CLOSES #1862',
    'Close #1862',
    'closed #1862',
    'Fixes #1862',
    'fix #1862',
    'FIXED #1862',
    'Resolves #1862',
    'resolve #1862',
    'RESOLVED #1862',
  ]) {
    assert.equal(
      prReferencesIssue({ closingIssuesReferences: [], title: '', body }, 1862),
      true,
      `expected a match for body: ${body}`,
    );
  }
});

test('prReferencesIssue: word-boundary rejects a longer number sharing the same prefix (#1888: keyword-adjacent form)', () => {
  // "Closes #18620" must not match candidate 1862 -- there is no word
  // boundary between two digits. Uses a closing-keyword form (#1888)
  // instead of the pre-#1888 bare "Refs #18620", since a bare mention no
  // longer matches for an unrelated reason (absent keyword) and would no
  // longer exercise this specific digit-boundary regression.
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: 'Closes #18620', body: '' },
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: a keyword glued directly to "#" with no whitespace does not match (#1888)', () => {
  // "closes#1862" must not match -- the narrowed regex requires at least
  // one whitespace character between the closing keyword and the "#"
  // reference (matching GitHub's own closing-reference grammar), so a
  // keyword-glued reference is rejected the same way the pre-#1888 fix
  // rejected a word character glued directly before "#" (Copilot review
  // finding, PR #1886).
  assert.equal(
    prReferencesIssue(
      { closingIssuesReferences: [], title: 'closes#1862', body: '' },
      1862,
    ),
    false,
  );
});

test('prReferencesIssue: bare/non-keyword cross-reference forms no longer match (#1888)', () => {
  // Every form here matched unconditionally before #1888 (#1878's
  // unconditional bare-mention fallback); none has a closing keyword
  // immediately adjacent to the "#1862" reference, so none should match
  // after the #1888 narrowing.
  for (const body of [
    '#1862',
    'Refs #1862',
    '(#1862)',
    'See #1862',
    'closing #1862',
  ]) {
    assert.equal(
      prReferencesIssue({ closingIssuesReferences: [], title: '', body }, 1862),
      false,
      `expected no match for body: ${body}`,
    );
  }
});

test('prReferencesIssue: keyword-adjacent forms still match after the #1888 narrowing', () => {
  for (const body of [
    'Closes #1862',
    'Fixes #1862',
    'Resolves #1862',
    '(Closes #1862)',
  ]) {
    assert.equal(
      prReferencesIssue({ closingIssuesReferences: [], title: '', body }, 1862),
      true,
      `expected a match for body: ${body}`,
    );
  }
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

test('buildMergedPrByBranchArgs is read-only (#2313)', () => {
  assertReadOnlyArgv(
    buildMergedPrByBranchArgs(
      'kurone-kito/idd-skill',
      'issue/2222-fix-onboard-prefer-existing-config-json',
    ),
  );
});

test('buildMergedPrByBranchArgs filters server-side to the exact head branch and MERGED state (#2313)', () => {
  const args = buildMergedPrByBranchArgs(
    'kurone-kito/idd-skill',
    'issue/2222-fix-onboard-prefer-existing-config-json',
  );
  const headIndex = args.indexOf('--head');
  assert.notEqual(headIndex, -1);
  assert.equal(
    args[headIndex + 1],
    'issue/2222-fix-onboard-prefer-existing-config-json',
  );
  const stateIndex = args.indexOf('--state');
  assert.notEqual(stateIndex, -1);
  assert.equal(args[stateIndex + 1], 'merged');
  const jsonIndex = args.indexOf('--json');
  assert.notEqual(jsonIndex, -1);
  const fields = (args[jsonIndex + 1] ?? '').split(',');
  assert.equal(fields.includes('number'), true);
  assert.equal(fields.includes('headRefName'), true);
  assert.equal(fields.includes('mergedAt'), true);
});

test('buildMergedPrByBranchArgs requests headRepositoryOwner and a limit above 1, so a fork PR sharing the branch name can be filtered out (Copilot review finding, #2313)', () => {
  // gh pr list --help documents that the "<owner>:<branch>" syntax is "not
  // supported" for --head, so a bare branch name can also match a merged PR
  // from a fork -- the caller needs headRepositoryOwner on every candidate
  // (not just the first) to filter those out before treating a hit as
  // high-confidence evidence.
  const args = buildMergedPrByBranchArgs(
    'kurone-kito/idd-skill',
    'issue/2222-fix-onboard-prefer-existing-config-json',
  );
  const jsonIndex = args.indexOf('--json');
  const fields = (args[jsonIndex + 1] ?? '').split(',');
  assert.equal(fields.includes('headRepositoryOwner'), true);
  const limitIndex = args.indexOf('--limit');
  assert.notEqual(limitIndex, -1);
  assert.equal(Number(args[limitIndex + 1]) > 1, true);
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

// --- #1887: findTrustedSuitabilityRejection ---------------------------------
// suitability-triage.mjs and its Check 4 helper never read the target
// issue's own comment thread, so a fresh run cannot tell "never triaged"
// apart from "already triaged and rejected by a trusted actor". These tests
// cover the three acceptance-criteria scenarios directly against the pure
// scanner (no `gh` stubbing needed, mirroring evaluateHighConfidenceDuplicate
// above): a trusted prior rejection is detected and surfaced; the same
// rejection-shaped comment from an untrusted actor is ignored; no matching
// comment returns null (the never-triaged case).

function makeRejectionComment(
  overrides: Partial<SuitabilityRejectionComment> = {},
): SuitabilityRejectionComment {
  return {
    body: `${SUITABILITY_REJECTION_PREFIX} — Check 7 (Verifiability): reason.\n\noutcome: needs-decision`,
    created_at: '2026-08-05T03:55:11Z',
    user: { login: 'kurone-kito' },
    html_url:
      'https://github.com/kurone-kito/idd-skill/issues/1878#issuecomment-1',
    ...overrides,
  };
}

test('findTrustedSuitabilityRejection: SUITABILITY_REJECTION_PREFIX matches the A4.5 posting convention literal', () => {
  assert.equal(SUITABILITY_REJECTION_PREFIX, 'A4.5 suitability gate rejection');
});

test('findTrustedSuitabilityRejection: a trusted-actor rejection is detected and surfaced', () => {
  const result = findTrustedSuitabilityRejection(
    [makeRejectionComment()],
    ['kurone-kito'],
  );
  assert.notEqual(result, null);
  assert.equal(result?.author, 'kurone-kito');
  assert.equal(result?.createdAt, '2026-08-05T03:55:11Z');
  assert.equal(
    result?.url,
    'https://github.com/kurone-kito/idd-skill/issues/1878#issuecomment-1',
  );
  assert.equal(result?.outcome, 'needs-decision');
  assert.equal(result?.check, 'Check 7 (Verifiability)');
});

test('findTrustedSuitabilityRejection: the same rejection-shaped comment from an untrusted actor is not surfaced', () => {
  const result = findTrustedSuitabilityRejection(
    [makeRejectionComment({ user: { login: 'random-untrusted-user' } })],
    ['kurone-kito'],
  );
  assert.equal(result, null);
});

test('findTrustedSuitabilityRejection: no matching comment returns null (never-triaged case)', () => {
  const result = findTrustedSuitabilityRejection(
    [
      {
        body: 'Just an ordinary comment, unrelated to A4.5.',
        created_at: '2026-08-05T03:55:11Z',
        user: { login: 'kurone-kito' },
        html_url: 'https://example.com/1',
      },
    ],
    ['kurone-kito'],
  );
  assert.equal(result, null);
});

test('findTrustedSuitabilityRejection: an empty comment list returns null', () => {
  assert.equal(findTrustedSuitabilityRejection([], ['kurone-kito']), null);
});

test('findTrustedSuitabilityRejection: a mid-prose mention (not the literal first bytes) is never treated as live', () => {
  // Mirrors the claim-marker anti-spoofing boundary in
  // idd-claim.instructions.md: a marker merely quoted or embedded mid-prose
  // is never treated as live.
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `Earlier discussion referenced an "${SUITABILITY_REJECTION_PREFIX}" pattern without actually posting one.`,
      }),
    ],
    ['kurone-kito'],
  );
  assert.equal(result, null);
});

test('findTrustedSuitabilityRejection: leading whitespace before the literal prefix still matches', () => {
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `  \n${SUITABILITY_REJECTION_PREFIX} — Check 1 (Repository Fit): reason.`,
      }),
    ],
    ['kurone-kito'],
  );
  assert.notEqual(result, null);
});

test('findTrustedSuitabilityRejection: among several trusted rejections, the most recent one wins', () => {
  const older = makeRejectionComment({
    created_at: '2026-08-04T22:45:02Z',
    body: `${SUITABILITY_REJECTION_PREFIX} — high-confidence file overlap with merged PR #1864 prevents an implementation claim.`,
  });
  const newer = makeRejectionComment({
    created_at: '2026-08-05T06:28:40Z',
    body: `${SUITABILITY_REJECTION_PREFIX} — Check 4 (Duplicate or Superseded Work), high-confidence tier.\n\noutcome: duplicate (mechanical, narrow false positive — see above)`,
  });
  // Order in the input array intentionally does not match chronological
  // order, to prove the function compares timestamps rather than trusting
  // array order.
  const result = findTrustedSuitabilityRejection(
    [newer, older],
    ['kurone-kito'],
  );
  assert.equal(result?.createdAt, '2026-08-05T06:28:40Z');
  // Regression guard: a real #1862 comment ends "outcome: duplicate
  // (mechanical, narrow false positive — see above)" -- trailing prose
  // after the canonical token on the same line. A `^...$`-anchored regex
  // would silently miss this; the token must still parse to "duplicate".
  assert.equal(result?.outcome, 'duplicate');
  assert.equal(result?.check, 'Check 4 (Duplicate or Superseded Work)');
});

test('findTrustedSuitabilityRejection: a trusted rejection with no outcome/check line still surfaces author/createdAt/url', () => {
  // Mirrors a real #1862 comment that predates the "outcome:" convention
  // entirely -- must degrade to null fields, not throw or drop the record.
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `${SUITABILITY_REJECTION_PREFIX} — high-confidence file overlap with merged PR #1864 prevents an implementation claim.`,
      }),
    ],
    ['kurone-kito'],
  );
  assert.notEqual(result, null);
  assert.equal(result?.author, 'kurone-kito');
  assert.equal(result?.outcome, null);
  assert.equal(result?.check, null);
});

test('findTrustedSuitabilityRejection: author comparison is case-insensitive', () => {
  const result = findTrustedSuitabilityRejection(
    [makeRejectionComment({ user: { login: 'Kurone-Kito' } })],
    ['kurone-kito'],
  );
  assert.notEqual(result, null);
  assert.equal(result?.author, 'kurone-kito');
});

test('findTrustedSuitabilityRejection: a differently-cased outcome token is normalized to lowercase (Copilot review finding, PR #1890)', () => {
  // The outcome pattern matches case-insensitively (`/i`), but a captured
  // group returns the verbatim matched text by default -- an actor
  // writing "outcome: DUPLICATE" must still surface the documented
  // lowercase canonical token, not a non-canonical "DUPLICATE".
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `${SUITABILITY_REJECTION_PREFIX} — Check 4 (Duplicate or Superseded Work): reason.\n\noutcome: DUPLICATE`,
      }),
    ],
    ['kurone-kito'],
  );
  assert.equal(result?.outcome, 'duplicate');
});

test('findTrustedSuitabilityRejection: an empty trusted-actor list never surfaces a match, even an exact one', () => {
  const result = findTrustedSuitabilityRejection([makeRejectionComment()], []);
  assert.equal(result, null);
});

test('findTrustedSuitabilityRejection: malformed (non-array) comments input degrades to null rather than throwing', () => {
  const result = findTrustedSuitabilityRejection(
    'not-an-array' as unknown as SuitabilityRejectionComment[],
    ['kurone-kito'],
  );
  assert.equal(result, null);
});

test('findTrustedSuitabilityRejection: a malformed individual comment entry is skipped, not thrown', () => {
  const result = findTrustedSuitabilityRejection(
    [null as unknown as SuitabilityRejectionComment, makeRejectionComment()],
    ['kurone-kito'],
  );
  assert.notEqual(result, null);
  assert.equal(result?.author, 'kurone-kito');
});

test('findTrustedSuitabilityRejection: an unparseable created_at is skipped rather than winning the "most recent" comparison', () => {
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({ created_at: 'not-a-date' }),
      makeRejectionComment({ created_at: '2026-08-05T03:55:11Z' }),
    ],
    ['kurone-kito'],
  );
  assert.equal(result?.createdAt, '2026-08-05T03:55:11Z');
});

// --- #2243: parseSuitabilityTriageVerdictMarker -----------------------------

test('parseSuitabilityTriageVerdictMarker: a well-formed marker is detected', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    'some prose\n<!-- idd-skill-triage-verdict: duplicate -->\nmore prose',
  );
  assert.deepEqual(result, {
    present: true,
    outcome: 'duplicate',
    malformed: false,
  });
});

test('parseSuitabilityTriageVerdictMarker: no marker returns present:false, outcome:null (never-triaged case)', () => {
  const result = parseSuitabilityTriageVerdictMarker('plain prose, no marker');
  assert.deepEqual(result, { present: false, outcome: null, malformed: false });
});

test('parseSuitabilityTriageVerdictMarker: an out-of-whitelist token (e.g. a label outcome) is malformed, never a synthesized outcome', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    '<!-- idd-skill-triage-verdict: needs-decision -->',
  );
  assert.deepEqual(result, { present: true, outcome: null, malformed: true });
});

test('parseSuitabilityTriageVerdictMarker: two disagreeing markers are malformed', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    '<!-- idd-skill-triage-verdict: unclear -->\n<!-- idd-skill-triage-verdict: invalid -->',
  );
  assert.equal(result.malformed, true);
  assert.equal(result.outcome, null);
});

test('parseSuitabilityTriageVerdictMarker: two agreeing markers are not malformed', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    '<!-- idd-skill-triage-verdict: unclear -->\n<!-- idd-skill-triage-verdict: unclear -->',
  );
  assert.deepEqual(result, {
    present: true,
    outcome: 'unclear',
    malformed: false,
  });
});

test('parseSuitabilityTriageVerdictMarker: a marker merely quoted in a code span is never treated as live (#1614, #1121 precedent)', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    'The convention looks like `<!-- idd-skill-triage-verdict: duplicate -->`.',
  );
  assert.deepEqual(result, { present: false, outcome: null, malformed: false });
});

test('parseSuitabilityTriageVerdictMarker: a namespaced adopter marker prefix is honored', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    '<!-- acme-triage-verdict: invalid -->',
    'acme',
  );
  assert.deepEqual(result, {
    present: true,
    outcome: 'invalid',
    malformed: false,
  });
});

test('parseSuitabilityTriageVerdictMarker: token comparison is case-insensitive', () => {
  const result = parseSuitabilityTriageVerdictMarker(
    '<!-- idd-skill-triage-verdict: OUT-OF-SCOPE -->',
  );
  assert.equal(result.outcome, 'out-of-scope');
});

// --- #2243: findTrustedSuitabilityRejection markerOutcome -------------------

test("findTrustedSuitabilityRejection: markerOutcome surfaces a trusted comment's current triage-verdict marker", () => {
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `${SUITABILITY_REJECTION_PREFIX} — Check 2 (Coherence): reason.\n\n<!-- idd-skill-triage-verdict: unclear -->`,
      }),
    ],
    ['kurone-kito'],
  );
  assert.equal(result?.markerOutcome, 'unclear');
});

test('findTrustedSuitabilityRejection: markerOutcome is null when the rejection comment carries no marker (never-triaged-marker case)', () => {
  const result = findTrustedSuitabilityRejection(
    [makeRejectionComment()],
    ['kurone-kito'],
  );
  assert.equal(result?.markerOutcome, null);
});

test("findTrustedSuitabilityRejection: an untrusted actor's marker-bearing comment is not surfaced at all (same #1887 trust boundary)", () => {
  const result = findTrustedSuitabilityRejection(
    [
      makeRejectionComment({
        body: `${SUITABILITY_REJECTION_PREFIX} — Check 2 (Coherence): reason.\n\n<!-- idd-skill-triage-verdict: unclear -->`,
        user: { login: 'random-untrusted-user' },
      }),
    ],
    ['kurone-kito'],
  );
  assert.equal(result, null);
});

// --- #2243: resolveLatestSubstantiveIssueEditAt -----------------------------

test("resolveLatestSubstantiveIssueEditAt: falls back to the issue's own createdAt with no edit events", () => {
  assert.equal(
    resolveLatestSubstantiveIssueEditAt('2026-08-01T00:00:00Z', []),
    '2026-08-01T00:00:00Z',
  );
});

test('resolveLatestSubstantiveIssueEditAt: a later body edit wins over createdAt', () => {
  const result = resolveLatestSubstantiveIssueEditAt('2026-08-01T00:00:00Z', [
    {
      event: 'edited',
      created_at: '2026-08-10T00:00:00Z',
      changes: { body: {} },
    },
  ]);
  assert.equal(result, '2026-08-10T00:00:00Z');
});

test('resolveLatestSubstantiveIssueEditAt: a title edit counts too', () => {
  const result = resolveLatestSubstantiveIssueEditAt('2026-08-01T00:00:00Z', [
    {
      event: 'edited',
      created_at: '2026-08-10T00:00:00Z',
      changes: { title: {} },
    },
  ]);
  assert.equal(result, '2026-08-10T00:00:00Z');
});

test('resolveLatestSubstantiveIssueEditAt: a non-body/title event (e.g. labeled) is ignored', () => {
  const result = resolveLatestSubstantiveIssueEditAt('2026-08-01T00:00:00Z', [
    { event: 'labeled', created_at: '2026-08-10T00:00:00Z' },
  ]);
  assert.equal(result, '2026-08-01T00:00:00Z');
});

test('resolveLatestSubstantiveIssueEditAt: an unparseable timestamp never wins', () => {
  const result = resolveLatestSubstantiveIssueEditAt('2026-08-01T00:00:00Z', [
    { event: 'edited', created_at: 'not-a-date', changes: { body: {} } },
  ]);
  assert.equal(result, '2026-08-01T00:00:00Z');
});

test('resolveLatestSubstantiveIssueEditAt: null when neither createdAt nor any qualifying event is parseable', () => {
  assert.equal(resolveLatestSubstantiveIssueEditAt(null, []), null);
});

// --- #2243: isSuitabilityTriageVerdictCurrent (staleness) -------------------
// The four acceptance-criteria scenarios from #2243: marker present and
// current (skip), marker present but stale relative to a later body edit
// (do not skip), no marker / never-triaged (do not skip), and an
// untrusted/forged marker comment (do not skip -- covered above by
// findTrustedSuitabilityRejection returning null entirely, so it never
// reaches this staleness check).

test('isSuitabilityTriageVerdictCurrent: a marker at/after the latest substantive edit is current (skip)', () => {
  const current = isSuitabilityTriageVerdictCurrent(
    { createdAt: '2026-08-10T00:00:00Z', markerOutcome: 'unclear' },
    '2026-08-05T00:00:00Z',
  );
  assert.equal(current, true);
});

test('isSuitabilityTriageVerdictCurrent: a marker strictly before a later substantive edit is stale (do not skip)', () => {
  const current = isSuitabilityTriageVerdictCurrent(
    { createdAt: '2026-08-05T00:00:00Z', markerOutcome: 'unclear' },
    '2026-08-10T00:00:00Z',
  );
  assert.equal(current, false);
});

test('isSuitabilityTriageVerdictCurrent: no marker outcome is never current, regardless of timestamps (never-triaged case)', () => {
  const current = isSuitabilityTriageVerdictCurrent(
    { createdAt: '2026-08-10T00:00:00Z', markerOutcome: null },
    '2026-08-05T00:00:00Z',
  );
  assert.equal(current, false);
});

test('isSuitabilityTriageVerdictCurrent: an unknown staleness anchor (null) fails closed toward NOT excluding the candidate', () => {
  const current = isSuitabilityTriageVerdictCurrent(
    { createdAt: '2026-08-10T00:00:00Z', markerOutcome: 'unclear' },
    null,
  );
  assert.equal(current, false);
});

test('isSuitabilityTriageVerdictCurrent: an unparseable rejection createdAt fails closed toward NOT excluding the candidate', () => {
  const current = isSuitabilityTriageVerdictCurrent(
    { createdAt: 'not-a-date', markerOutcome: 'unclear' },
    '2026-08-05T00:00:00Z',
  );
  assert.equal(current, false);
});
