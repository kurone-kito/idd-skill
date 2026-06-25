import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  type ActiveIssueInput,
  analyzeSharedFileOverlap,
  applyOverlapTieBreaker,
  normalizeContentionPath,
  type OverlapCandidateInput,
  parseCandidateFiles,
  type RankableCandidate,
  resolveHighContentionFiles,
  toClaimComment,
} from '../src/scripts/discover-shared-file-overlap.mts';
import { resolveActiveClaim } from '../src/scripts/protocol-helpers.mts';

// Instruction files are keyed by their (repo-wide unique) basename so that
// the source path, the mirror path, and a bare citation all compare equal.
const MERGE_FILE = 'idd-merge.instructions.md';
const ADVISORY_FILE = 'idd-advisory-wait.instructions.md';
const REVIEW_FIX_FILE = 'idd-review-fix.instructions.md';
const MANIFEST_FILE = 'audit/sync-manifest.json';

function readFixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/shared-file-overlap/${name}`, import.meta.url),
    'utf8',
  );
}

function loadRealManifest(): unknown {
  return JSON.parse(
    readFileSync(
      new URL('../audit/sync-manifest.json', import.meta.url),
      'utf8',
    ),
  );
}

// ---------------------------------------------------------------------------
// normalizeContentionPath
// ---------------------------------------------------------------------------

test('normalizeContentionPath strips backticks, leading ./, and idd-template/', () => {
  assert.equal(
    normalizeContentionPath('`audit/sync-manifest.json`'),
    MANIFEST_FILE,
  );
  assert.equal(normalizeContentionPath('./scripts/foo.mjs'), 'scripts/foo.mjs');
  assert.equal(
    normalizeContentionPath(
      'idd-template/.github/instructions/idd-merge.instructions.md',
    ),
    MERGE_FILE,
  );
});

test('normalizeContentionPath collapses a source and its mirror onto one key', () => {
  const source = normalizeContentionPath(
    'idd-template/.github/instructions/idd-merge.instructions.md',
  );
  const mirror = normalizeContentionPath(
    '.github/instructions/idd-merge.instructions.md',
  );
  assert.equal(source, mirror);
});

// ---------------------------------------------------------------------------
// parseCandidateFiles
// ---------------------------------------------------------------------------

test('parseCandidateFiles extracts and normalizes every backtick path, de-duping the mirror', () => {
  const files = parseCandidateFiles(readFixture('candidate-merge.md'));
  assert.deepEqual(files, [MERGE_FILE, ADVISORY_FILE]);
});

test('parseCandidateFiles keeps non-high-contention helper and glob tokens', () => {
  const files = parseCandidateFiles(readFixture('candidate-review.md'));
  assert.deepEqual(files, [
    ADVISORY_FILE,
    'src/scripts/review-activity-snapshot.mts',
    'tests/*.test.mts',
  ]);
});

test('parseCandidateFiles returns [] when no candidate-files section exists', () => {
  assert.deepEqual(
    parseCandidateFiles(readFixture('no-candidate-section.md')),
    [],
  );
});

test('parseCandidateFiles stops at the next heading and ignores non-list prose', () => {
  const body = [
    '## Candidate files',
    '',
    '- `scripts/a.mjs`',
    '',
    '## Notes',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/a.mjs']);
});

// ---------------------------------------------------------------------------
// resolveHighContentionFiles
// ---------------------------------------------------------------------------

test('resolveHighContentionFiles unions the named bundles plus extra surfaces', () => {
  const manifest = {
    bundleBudgets: [
      { id: 'bundle-review', files: ['a.md', 'shared.md'] },
      { id: 'bundle-merge', files: ['shared.md', 'b.md'] },
      { id: 'bundle-discovery', files: ['c.md'] },
    ],
  };
  const resolved = resolveHighContentionFiles({ manifest });
  assert.deepEqual([...resolved].sort(), [
    'a.md',
    MANIFEST_FILE,
    'b.md',
    'shared.md',
  ]);
  assert.equal(resolved.has('c.md'), false);
});

test('resolveHighContentionFiles over the real manifest yields the issue-named files', () => {
  const resolved = resolveHighContentionFiles({ manifest: loadRealManifest() });
  for (const file of [
    'idd-overview-core.instructions.md',
    'idd-overview-appendix.instructions.md',
    'idd-review-snapshot.instructions.md',
    'idd-review-triage.instructions.md',
    REVIEW_FIX_FILE,
    ADVISORY_FILE,
    'idd-ci.instructions.md',
    'idd-pre-merge.instructions.md',
    'idd-merge-handoff.instructions.md',
    MERGE_FILE,
    MANIFEST_FILE,
  ]) {
    assert.equal(resolved.has(file), true, `expected high-contention: ${file}`);
  }
  // A discovery-bundle-only file must not be flagged high-contention.
  assert.equal(resolved.has('idd-suitability.instructions.md'), false);
});

// ---------------------------------------------------------------------------
// analyzeSharedFileOverlap
// ---------------------------------------------------------------------------

const HIGH_CONTENTION = [MERGE_FILE, ADVISORY_FILE, REVIEW_FIX_FILE];

test('analyzeSharedFileOverlap flags a candidate that shares a high-contention file with active work', () => {
  const candidates: OverlapCandidateInput[] = [
    {
      number: 1019,
      score: 3,
      candidateFiles: [ADVISORY_FILE, 'src/scripts/x.mts'],
    },
  ];
  const activeIssues: ActiveIssueInput[] = [
    { number: 991, reason: 'pr', candidateFiles: [ADVISORY_FILE, MERGE_FILE] },
  ];
  const result = analyzeSharedFileOverlap({
    candidates,
    activeIssues,
    highContentionFiles: HIGH_CONTENTION,
  });
  const candidate = result.candidates[0];
  assert.deepEqual(candidate.highContentionTouched, [ADVISORY_FILE]);
  assert.equal(candidate.overlapFlag, true);
  assert.deepEqual(candidate.overlaps, [
    { number: 991, reason: 'pr', files: [ADVISORY_FILE] },
  ]);
  assert.equal(result.summary.flaggedCount, 1);
});

test('analyzeSharedFileOverlap does not flag a candidate with no shared high-contention file', () => {
  const candidates: OverlapCandidateInput[] = [
    { number: 2000, score: 3, candidateFiles: ['src/scripts/only-helper.mts'] },
  ];
  const activeIssues: ActiveIssueInput[] = [
    { number: 991, reason: 'claim', candidateFiles: [MERGE_FILE] },
  ];
  const result = analyzeSharedFileOverlap({
    candidates,
    activeIssues,
    highContentionFiles: HIGH_CONTENTION,
  });
  assert.deepEqual(result.candidates[0].highContentionTouched, []);
  assert.equal(result.candidates[0].overlapFlag, false);
  assert.deepEqual(result.candidates[0].overlaps, []);
  assert.equal(result.summary.flaggedCount, 0);
});

test('analyzeSharedFileOverlap never reports a candidate overlapping itself', () => {
  const candidates: OverlapCandidateInput[] = [
    { number: 1019, score: 3, candidateFiles: [MERGE_FILE] },
  ];
  const activeIssues: ActiveIssueInput[] = [
    { number: 1019, reason: 'claim', candidateFiles: [MERGE_FILE] },
  ];
  const result = analyzeSharedFileOverlap({
    candidates,
    activeIssues,
    highContentionFiles: HIGH_CONTENTION,
  });
  assert.equal(result.candidates[0].overlapFlag, false);
});

test('analyzeSharedFileOverlap parses fixtures: merge and review collide on advisory-wait', () => {
  const merge = {
    number: 991,
    score: 3,
    candidateFiles: parseCandidateFiles(readFixture('candidate-merge.md')),
  };
  const review = {
    number: 1019,
    score: 3,
    candidateFiles: parseCandidateFiles(readFixture('candidate-review.md')),
  };
  const isolated = {
    number: 2000,
    score: 3,
    candidateFiles: parseCandidateFiles(readFixture('candidate-isolated.md')),
  };
  const result = analyzeSharedFileOverlap({
    candidates: [review, isolated],
    activeIssues: [{ ...merge, reason: 'pr' as const }],
    highContentionFiles: resolveHighContentionFiles({
      manifest: loadRealManifest(),
    }),
  });
  const reviewResult = result.candidates.find((c) => c.number === 1019);
  const isolatedResult = result.candidates.find((c) => c.number === 2000);
  assert.equal(reviewResult?.overlapFlag, true);
  assert.deepEqual(reviewResult?.overlaps, [
    { number: 991, reason: 'pr', files: [ADVISORY_FILE] },
  ]);
  assert.equal(isolatedResult?.overlapFlag, false);
});

// ---------------------------------------------------------------------------
// toClaimComment — REST `user.login` must reach the `author.login` field that
// resolveActiveClaim reads (regression guard for the active-by-claim path)
// ---------------------------------------------------------------------------

test('toClaimComment maps REST user.login into the author field resolveActiveClaim reads', () => {
  const rest = {
    body: '<!-- claimed-by: agent-x claim-abc supersedes: none 2026-06-25T00:00:00Z branch: issue/1-x -->',
    created_at: '2026-06-25T00:00:00Z',
    user: { login: 'kurone-kito' },
  };
  const mapped = toClaimComment(rest);
  assert.equal(mapped.author.login, 'kurone-kito');

  // A trusted author yields the claim; an empty/untrusted author yields none —
  // mapping the login to `user` instead of `author` would break the former.
  const trusted = resolveActiveClaim(
    [mapped],
    (login) => login === 'kurone-kito',
  );
  assert.equal(trusted?.claimId, 'claim-abc');
  assert.equal(
    resolveActiveClaim([mapped], (login) => login === 'someone-else'),
    null,
  );
});

// ---------------------------------------------------------------------------
// applyOverlapTieBreaker / recommendedOrder
// ---------------------------------------------------------------------------

test('applyOverlapTieBreaker moves overlapping candidates after non-overlapping ones within a score band', () => {
  const ranked: RankableCandidate[] = [
    { number: 10, effectiveScore: 3, overlapFlag: true },
    { number: 11, effectiveScore: 3, overlapFlag: false },
    { number: 12, effectiveScore: 3, overlapFlag: true },
    { number: 13, effectiveScore: 3, overlapFlag: false },
  ];
  assert.deepEqual(
    applyOverlapTieBreaker(ranked).map((candidate) => candidate.number),
    [11, 13, 10, 12],
  );
});

test('applyOverlapTieBreaker never reorders across score bands', () => {
  const ranked: RankableCandidate[] = [
    { number: 10, effectiveScore: 4, overlapFlag: true },
    { number: 11, effectiveScore: 3, overlapFlag: false },
  ];
  // The colliding score-4 candidate stays ahead of the clean score-3 one.
  assert.deepEqual(
    applyOverlapTieBreaker(ranked).map((candidate) => candidate.number),
    [10, 11],
  );
});

test('recommendedOrder de-prioritizes a colliding candidate within its score band', () => {
  const result = analyzeSharedFileOverlap({
    candidates: [
      { number: 18, score: 3, candidateFiles: [MERGE_FILE] },
      { number: 19, score: 3, candidateFiles: ['src/scripts/isolated.mts'] },
    ],
    activeIssues: [{ number: 991, reason: 'pr', candidateFiles: [MERGE_FILE] }],
    highContentionFiles: HIGH_CONTENTION,
  });
  // #18 collides; the lowest-number rule alone would pick #18 first, but the
  // soft overlap tie-breaker puts the clean #19 ahead within the score band.
  assert.deepEqual(result.recommendedOrder, [19, 18]);
});

test('recommendedOrder keeps a colliding candidate when it is the only ready work', () => {
  const result = analyzeSharedFileOverlap({
    candidates: [{ number: 18, score: 3, candidateFiles: [MERGE_FILE] }],
    activeIssues: [{ number: 991, reason: 'pr', candidateFiles: [MERGE_FILE] }],
    highContentionFiles: HIGH_CONTENTION,
  });
  assert.deepEqual(result.recommendedOrder, [18]);
  assert.equal(result.candidates[0].overlapFlag, true);
});

test('analyzeSharedFileOverlap treats a missing score as the floor for ordering', () => {
  const result = analyzeSharedFileOverlap({
    candidates: [
      { number: 30, score: null, candidateFiles: [] },
      { number: 31, score: 4, candidateFiles: [] },
    ],
    activeIssues: [],
    highContentionFiles: HIGH_CONTENTION,
    floor: 3,
  });
  // score 4 outranks the unscored (floor 3) candidate.
  assert.deepEqual(result.recommendedOrder, [31, 30]);
  assert.equal(
    result.candidates.find((c) => c.number === 30)?.effectiveScore,
    3,
  );
});

test('analyzeSharedFileOverlap ignores the score when the suitability kill switch is off', () => {
  const input = {
    candidates: [
      { number: 30, score: 3, candidateFiles: [] },
      { number: 31, score: 5, candidateFiles: [] },
    ],
    activeIssues: [],
    highContentionFiles: HIGH_CONTENTION,
  };
  // Enabled (default): score 5 ranks ahead of the lower-numbered score 3.
  assert.deepEqual(analyzeSharedFileOverlap(input).recommendedOrder, [31, 30]);
  // Disabled: scores are equalized, so the lower issue number wins (A4 Step 2
  // falls back to lowest-number selection).
  const disabled = analyzeSharedFileOverlap({
    ...input,
    suitabilityEnabled: false,
  });
  assert.deepEqual(disabled.recommendedOrder, [30, 31]);
  assert.equal(disabled.candidates[0].effectiveScore, 0);
});

test('the suitability kill switch still de-prioritizes overlap before issue number', () => {
  // Disabled scores → one band; within it, the colliding low number is moved
  // after the clean higher number.
  const result = analyzeSharedFileOverlap({
    candidates: [
      { number: 18, score: 5, candidateFiles: [MERGE_FILE] },
      { number: 19, score: 3, candidateFiles: ['src/scripts/isolated.mts'] },
    ],
    activeIssues: [{ number: 991, reason: 'pr', candidateFiles: [MERGE_FILE] }],
    highContentionFiles: HIGH_CONTENTION,
    suitabilityEnabled: false,
  });
  assert.deepEqual(result.recommendedOrder, [19, 18]);
});
