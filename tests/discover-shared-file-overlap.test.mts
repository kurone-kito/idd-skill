import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type ActiveIssueInput,
  analyzeSharedFileOverlap,
  applyOverlapTieBreaker,
  buildOverlapOutput,
  hasCandidateFilesHeading,
  type InFlightIssueInput,
  loadManifest,
  normalizeContentionPath,
  type OverlapAnalysis,
  type OverlapCandidateInput,
  type OverlapCandidateResult,
  type OverlapHit,
  parseArgs,
  parseCandidateFileEntries,
  parseCandidateFiles,
  type RankableCandidate,
  resolveHighContentionFiles,
  selectNonOverlappingBatch,
  toClaimComment,
} from '../src/scripts/discover-shared-file-overlap.mts';
import { selectDesyncedIndex } from '../src/scripts/policy-helpers.mts';
import { resolveActiveClaim } from '../src/scripts/protocol-helpers.mts';

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: --candidate is repeatable and --candidates is comma-split', () => {
  const args = parseArgs([
    '--candidate',
    '5',
    '--candidates',
    '9,11',
    '--check-overlap',
  ]);
  assert.deepEqual(args.candidates, [5, 9, 11]);
  assert.equal(args.checkOverlap, true);
  assert.equal(args.bundles, null);
});

test('parseArgs: canonical aliases cover repeated and equals forms in order', () => {
  const args = parseArgs([
    '--issue',
    '5',
    '--issue=7',
    '--issues=9,11',
    '--issues',
    '13,15',
    '--candidates=17,19',
    '--candidate=21',
  ]);
  assert.deepEqual(args.candidates, [5, 7, 9, 11, 13, 15, 17, 19, 21]);
});

test('parseArgs: repeated --candidates occurrences all accumulate (not just the last)', () => {
  // Regression coverage for a Codex review finding on #1450: a
  // non-multiple parseArgs string flag keeps only the LAST occurrence
  // when repeated, which would silently drop 1 and 2 here.
  const args = parseArgs(['--candidates', '1,2', '--candidates', '3,4']);
  assert.deepEqual(args.candidates, [1, 2, 3, 4]);
});

test('parseArgs: interleaved --candidates/--candidate occurrences preserve argv order', () => {
  // Regression coverage for a second #1450 review finding: grouping every
  // --candidate occurrence before every --candidates occurrence silently
  // reordered interleaved input (plural-before-singular is the case that
  // would have been missed by only ever putting --candidate first, as the
  // test above does).
  const args = parseArgs(['--candidates', '1,2', '--candidate', '3']);
  assert.deepEqual(args.candidates, [1, 2, 3]);
});

test('parseArgs: the --candidate=<value> equals-form is recognized in order', () => {
  const args = parseArgs(['--candidates', '1,2', '--candidate=3']);
  assert.deepEqual(args.candidates, [1, 2, 3]);
});

test('parseArgs: --candidate keeps its existing throw-on-invalid contract', () => {
  assert.throws(
    () => parseArgs(['--candidate', 'abc']),
    /invalid --candidate value: abc/,
  );
  assert.throws(
    () => parseArgs(['--candidates', '5,abc']),
    /invalid --candidates value: abc/,
  );
});

test('parseArgs: canonical aliases keep their flag-specific validation errors', () => {
  assert.throws(
    () => parseArgs(['--issue', 'abc']),
    /invalid --issue value: abc/,
  );
  assert.throws(
    () => parseArgs(['--issues', '5,abc']),
    /invalid --issues value: abc/,
  );
});

test('parseArgs: a missing --candidate value throws', () => {
  assert.throws(() => parseArgs(['--candidate']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --owner would greedily accept '--check-overlap' as its
  // literal value, silently leaving --check-overlap unset (the #1082 gap
  // this migration closes structurally for this helper).
  assert.throws(() =>
    parseArgs(['--candidate', '5', '--owner', '--check-overlap']),
  );
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized without requiring --candidate', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

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

test('parseCandidateFiles requires an exact "Candidate files" heading, not merely a same-prefix sibling (Codex review, PR #2840, round 12)', () => {
  // "## Candidate files considered but rejected" is a real, distinct
  // heading -- the prior `\b`-bounded prefix match ("^candidate files\b")
  // wrongly treated it as this section's own contract heading, letting a
  // path listed there satisfy candidateFilesExist for a section the issue
  // never actually opened.
  const body = [
    '## Candidate files considered but rejected',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles recognizes a heading with a valid ATX closing hash sequence (Codex review, PR #2840, round 14)', () => {
  // `## Candidate files ##` renders on GitHub as a level-2 heading titled
  // exactly "Candidate files" -- the trailing `##` is closing-sequence
  // syntax (gh api /markdown confirms), not part of the title. The
  // round-12 exact-match fix rejected this heading entirely (title stayed
  // "candidate files ##"), silently dropping every candidate path.
  const body = ['## Candidate files ##', '', '- `scripts/a.mjs`'].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/a.mjs']);
});

test('parseCandidateFiles still rejects a same-prefix sibling heading that also carries a closing hash sequence (control, round 14)', () => {
  const body = [
    '## Candidate files considered but rejected ##',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles rejects a heading whose trailing hashes are real code-span content, not an ATX closer (Codex review, PR #2840, round 23)', () => {
  // `` ## Candidate `files ##` `` keeps its trailing `##` as literal
  // code-span content, not a real ATX closer -- `gh api /markdown`
  // confirms the rendered heading is `Candidate <code>files ##</code>`,
  // not `Candidate files`. Stripping backticks before the closing-hash
  // check exposed those code-span hashes as if they were a real closer,
  // wrongly opening the section.
  const body = [
    '## Candidate `files ##`',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles stops at a Setext-style sibling heading, not just an ATX one (Codex review, PR #2840)', () => {
  const body = [
    '## Candidate files',
    '',
    '- `scripts/a.mjs`',
    '',
    'Notes',
    '-----',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/a.mjs']);
});

test('parseCandidateFiles does not mistake a bullet immediately before a thematic break for a Setext heading (Codex review, PR #2840 round 2)', () => {
  // A `---` directly after a list-item bullet is CommonMark's thematic
  // break ending the list, never a Setext heading over that bullet -- the
  // naive "any nonblank preceding line" check wrongly truncated the
  // section right at its own last (here, only) candidate path.
  const body = ['## Candidate files', '', '- `src/a.mts`', '---'].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/a.mts']);
});

test('parseCandidateFiles does not mistake a blockquoted line before an underline-shaped line for a Setext heading', () => {
  const body = ['## Candidate files', '', '> `src/a.mts`', '---'].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/a.mts']);
});

test('parseCandidateFiles does not mistake an indented wrapped continuation line before a thematic break for a Setext heading (Codex review, PR #2840 round 9)', () => {
  // The bullet-marker-only exclusion missed an indented WRAPPED
  // CONTINUATION line of a multi-line bullet -- the line that actually
  // carries the candidate path here starts with two spaces then a
  // backtick, not a marker, so it fell through to being read as ordinary
  // Setext-heading-eligible content and the section was wrongly truncated
  // one line before its own real path.
  const body = [
    '## Candidate files',
    '',
    '- change:',
    '  `src/a.mts`',
    '',
    '---',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/a.mts']);
});

test('parseCandidateFiles stops at a genuine 1-3-space-indented Setext heading right after a blank line (Codex review, PR #2840, round 16)', () => {
  // Round 9's blanket "any indented line is Setext-ineligible" heuristic
  // went the dangerous direction here: a genuine, CommonMark-legal
  // indented Setext heading right after a blank line (not a list-item
  // continuation -- there is nothing to continue) was wrongly excluded,
  // letting the section read past it and pick up an unrelated later
  // section's own path. `gh api /markdown` confirms " Notes\n -----"
  // renders as a real <h2> heading here.
  const body = [
    '## Candidate files',
    '',
    '- `scripts/a.mts`',
    '',
    ' Notes',
    ' -----',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/a.mts']);
});

test('parseCandidateFiles does not mistake a continuation-of-a-continuation line before a thematic break for a Setext heading (Codex review, PR #2840, round 16)', () => {
  // The round-16 fix's continuation check must also catch a SECOND
  // indented line whose own preceding line is itself indented (not
  // marker-led), not just a continuation's direct marker-led opener.
  const body = [
    '## Candidate files',
    '',
    '- Run:',
    '  `src/one.mts`',
    '  `src/two.mts`',
    '---',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/one.mts', 'src/two.mts']);
});

test('parseCandidateFiles stops at a genuine multi-line Setext heading, not just a single-line one (Codex review, PR #2840, round 20)', () => {
  // CommonMark lets a Setext heading's own content span several lines --
  // round 16's fix only checked ONE line back, so it wrongly treated the
  // heading's own SECOND content line as a "continuation" just because
  // the FIRST content line above it was also indented (both lines are
  // the same heading's own content, not a continuation of anything).
  // `gh api /markdown` confirms CommonMark forms one heading
  // ("First line<br>Second line") from both lines together.
  const body = [
    '## Candidate files',
    '',
    '- `scripts/a.mts`',
    '',
    ' First line',
    ' Second line',
    ' ---',
    '',
    '- `scripts/should-not-count.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/a.mts']);
});

test('parseCandidateFiles does not leak a backtick-quoted path from an earlier line of a multi-line Setext heading (Codex review, PR #2840, round 24)', () => {
  // Round 20 fixed *eligibility* (is the last line before the underline
  // part of a real heading, not a list continuation) but left the
  // truncation point at that last line, so a real backtick-quoted path
  // on an EARLIER line of the same multi-line heading still leaked into
  // the preceding section. `gh api /markdown` confirms
  // "`package.json`\nNotes\n---" renders as one heading
  // (<h2><code>package.json</code><br>Notes</h2>), never a candidate path.
  const body = [
    '## Candidate files',
    '',
    '`package.json`',
    'Notes',
    '---',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles rejects a tab-indented "## Candidate files" heading -- CommonMark renders it as an indented code block, not a heading (Codex review, PR #2840, round 11)', () => {
  // Verified against GitHub's own renderer (gh api /markdown): a tab
  // advances to the next 4-column tab stop, past the 0-3-space ATX
  // indent allowance, so this line renders as a <pre><code> block. The
  // earlier `\s{0,3}` (matching a tab the same as a space) wrongly opened
  // a section here anyway.
  const body = [
    'Some content.',
    '',
    '\t## Candidate files',
    '',
    '- `src/scripts/exists.mts`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles still accepts a 3-space-indented "## Candidate files" heading (control)', () => {
  const body = [
    'Some content.',
    '',
    '   ## Candidate files',
    '',
    '- `src/scripts/exists.mts`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/scripts/exists.mts']);
});

test('parseCandidateFiles does not treat a tab-indented underline as a Setext boundary (Codex review, PR #2840, round 11)', () => {
  // Same tab-vs-space indent error on SETEXT_UNDERLINE_PATTERN: a
  // tab-indented "-----" renders as plain paragraph text (verified via
  // gh api /markdown), never a real Setext underline, so it must not end
  // the Candidate files section before its own later real path.
  const body = [
    '## Candidate files',
    '',
    '- `src/a.mts`',
    '',
    'Notes',
    '\t-----',
    '',
    '- `src/b.mts`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['src/a.mts', 'src/b.mts']);
});

// ---------------------------------------------------------------------------
// parseCandidateFileEntries (#2767 round 8, Codex review PR #2840)
// ---------------------------------------------------------------------------

test('parseCandidateFileEntries carries the raw path alongside its normalized contention key', () => {
  const body =
    '## Candidate files\n\n- `idd-template/.github/instructions/idd-merge.instructions.md`\n';
  assert.deepEqual(parseCandidateFileEntries(body), [
    {
      raw: 'idd-template/.github/instructions/idd-merge.instructions.md',
      normalized: MERGE_FILE,
    },
  ]);
});

test('parseCandidateFileEntries keeps raw distinct from normalized for a plain (non-mirrored) path', () => {
  const body = '## Candidate files\n\n- `src/scripts/foo.mts`\n';
  assert.deepEqual(parseCandidateFileEntries(body), [
    { raw: 'src/scripts/foo.mts', normalized: 'src/scripts/foo.mts' },
  ]);
});

test('parseCandidateFileEntries de-dupes on raw, keeping BOTH spellings that share a normalized key (Codex review, PR #2840 round 9)', () => {
  // Previously de-duplicated on `normalized`, silently discarding the
  // second entry here even though it is a distinct raw spelling -- a
  // filesystem-existence check needs both, since the one that actually
  // exists on disk might be either one.
  const body =
    '## Candidate files\n\n- `idd-template/.github/instructions/idd-merge.instructions.md`\n- `.github/instructions/idd-merge.instructions.md`\n';
  assert.deepEqual(parseCandidateFileEntries(body), [
    {
      raw: 'idd-template/.github/instructions/idd-merge.instructions.md',
      normalized: MERGE_FILE,
    },
    {
      raw: '.github/instructions/idd-merge.instructions.md',
      normalized: MERGE_FILE,
    },
  ]);
});

test('parseCandidateFileEntries still de-dupes an exact repeated raw spelling', () => {
  const body =
    '## Candidate files\n\n- `src/scripts/foo.mts`\n- `src/scripts/foo.mts`\n';
  assert.deepEqual(parseCandidateFileEntries(body), [
    { raw: 'src/scripts/foo.mts', normalized: 'src/scripts/foo.mts' },
  ]);
});

test('parseCandidateFileEntries excludes an HTML-attribute-embedded backtick path (#2865)', () => {
  // `gh api /markdown` confirms `<span title="`package.json`">not a
  // candidate</span>` keeps its backticks literal inside the attribute
  // value -- never a rendered code span, so `package.json` here is not a
  // real candidate file, even though a naive backtick-pair scan would
  // extract it as one.
  const body =
    '## Candidate files\n\n<span title="`package.json`">not a candidate</span>\n';
  assert.deepEqual(parseCandidateFileEntries(body), []);
});

test('parseCandidateFileEntries still extracts a real candidate path alongside an HTML-attribute-embedded backtick (#2865)', () => {
  const body =
    '## Candidate files\n\n- `src/scripts/foo.mts`\n<span title="`package.json`">not a candidate</span>\n';
  assert.deepEqual(parseCandidateFileEntries(body), [
    { raw: 'src/scripts/foo.mts', normalized: 'src/scripts/foo.mts' },
  ]);
});

test('parseCandidateFiles applies its own normalized-key dedup on top of parseCandidateFileEntries (Codex review, PR #2840 round 9)', () => {
  // parseCandidateFileEntries now keeps every distinct raw spelling
  // (including two that share a normalized key), so parseCandidateFiles
  // must collapse those back to one entry per contention key itself to
  // keep its own pre-existing one-entry-per-key contract for its callers.
  const body = readFixture('candidate-merge.md');
  assert.deepEqual(parseCandidateFiles(body), [
    ...new Set(
      parseCandidateFileEntries(body).map((entry) => entry.normalized),
    ),
  ]);
  assert.deepEqual(parseCandidateFiles(body), [
    MERGE_FILE,
    'idd-advisory-wait.instructions.md',
  ]);
});

// ---------------------------------------------------------------------------
// resolveHighContentionFiles
// ---------------------------------------------------------------------------

test('resolveHighContentionFiles unions the named bundles plus extra surfaces', () => {
  const manifest = {
    bundleBudgets: [
      { id: 'bundle-review-triage-phase', files: ['a.md', 'shared.md'] },
      { id: 'bundle-review-fix-phase', files: ['d.md'] },
      { id: 'bundle-merge-phase', files: ['shared.md', 'b.md'] },
      { id: 'bundle-discovery', files: ['c.md'] },
    ],
  };
  const resolved = resolveHighContentionFiles({ manifest });
  assert.deepEqual([...resolved].sort(), [
    'a.md',
    MANIFEST_FILE,
    'b.md',
    'd.md',
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
// loadManifest
// ---------------------------------------------------------------------------

test('loadManifest degrades quietly on a missing manifest (ENOENT)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-shared-file-overlap-'));
  try {
    const result = loadManifest(join(dir, 'does-not-exist.json'));
    assert.deepEqual(result, { manifest: null, missing: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadManifest still fails closed on a present-but-malformed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-shared-file-overlap-'));
  try {
    const manifestPath = join(dir, 'sync-manifest.json');
    writeFileSync(manifestPath, '{ not valid json', 'utf8');
    assert.throws(
      () => loadManifest(manifestPath),
      /failed to load sync manifest/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadManifest parses a present, well-formed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'discover-shared-file-overlap-'));
  try {
    const manifestPath = join(dir, 'sync-manifest.json');
    writeFileSync(manifestPath, JSON.stringify({ bundleBudgets: [] }), 'utf8');
    assert.deepEqual(loadManifest(manifestPath), {
      manifest: { bundleBudgets: [] },
      missing: false,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
// toClaimComment — ProviderComment.authorLogin must reach the `author.login`
// field that resolveActiveClaim reads (regression guard for the
// active-by-claim path)
// ---------------------------------------------------------------------------

test('toClaimComment maps ProviderComment.authorLogin into the author field resolveActiveClaim reads', () => {
  const comment = {
    id: 1,
    body: '<!-- claimed-by: agent-x claim-abc supersedes: none 2026-06-25T00:00:00Z branch: issue/1-x -->',
    createdAt: '2026-06-25T00:00:00Z',
    updatedAt: '2026-06-25T00:00:00Z',
    authorLogin: 'kurone-kito',
    lastEditedAt: null,
  };
  const mapped = toClaimComment(comment);
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

// --- #3282: Candidate files section located on a masked copy, replacing
// the former raw-line-only heading/Setext scan ------------------------------

test('hasCandidateFilesHeading/parseCandidateFiles ignore a template-only body whose "## Candidate files" heading and placeholder bullet sit only inside a fenced example', () => {
  const body = [
    '```markdown',
    '## Candidate files',
    '',
    '- `<path>`',
    '```',
  ].join('\n');
  assert.equal(hasCandidateFilesHeading(body), false);
  assert.deepEqual(parseCandidateFiles(body), []);
});

test('parseCandidateFiles reads the real section, not a fenced placeholder example that precedes it', () => {
  const body = [
    '```markdown',
    '## Candidate files',
    '',
    '- `<path>`',
    '```',
    '',
    '## Candidate files',
    '',
    '- `scripts/real.mjs`',
  ].join('\n');
  assert.equal(hasCandidateFilesHeading(body), true);
  assert.deepEqual(parseCandidateFiles(body), ['scripts/real.mjs']);
});

test('parseCandidateFiles reads the real section, not a fenced example whose bullets are path-like (not obviously placeholder)', () => {
  // The fenced example's own bullet looks like a real path -- before
  // #3282, this shape passed actionability with the example path read as
  // the issue's own candidate file.
  const body = [
    '```markdown',
    '## Candidate files',
    '',
    '- `scripts/fake.mjs`',
    '```',
    '',
    '## Candidate files',
    '',
    '- `scripts/real.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/real.mjs']);
});

test('parseCandidateFiles still reads a real section whose first content is a fenced shell snippet starting with a "#" comment line', () => {
  // Regression for a real bug found while implementing #3282: a naive
  // backtick-pair regex over the section's raw text let the fence's own
  // triple-backtick delimiters pair up with each other (and with the
  // real path's own opening backtick), corrupting the scan and losing
  // the real path entirely. Extracting section content from the SAME
  // masked copy used for heading detection (fence content blanked to
  // spaces, no backticks left to mis-pair) fixes this.
  const body = [
    '## Candidate files',
    '',
    '```sh',
    '# run this first',
    '```',
    '',
    '- `scripts/real.mjs`',
  ].join('\n');
  assert.deepEqual(parseCandidateFiles(body), ['scripts/real.mjs']);
});

// ---------------------------------------------------------------------------
// #3838: --batch / --in-flight / --desync-token
// ---------------------------------------------------------------------------

function batchOf(options: {
  candidates: OverlapCandidateInput[];
  activeIssues?: ActiveIssueInput[];
  inFlight?: InFlightIssueInput[];
  batchSize: number;
  desyncToken?: string;
  floor?: number;
  suitabilityEnabled?: boolean;
}) {
  const analysis = analyzeSharedFileOverlap({
    candidates: options.candidates,
    activeIssues: options.activeIssues ?? [],
    highContentionFiles: HIGH_CONTENTION,
    floor: options.floor,
    suitabilityEnabled: options.suitabilityEnabled,
  });
  return selectNonOverlappingBatch({
    analysis,
    inFlight: options.inFlight ?? [],
    highContentionFiles: HIGH_CONTENTION,
    batchSize: options.batchSize,
    desyncToken: options.desyncToken,
    floor: options.floor,
  });
}

function scored(
  number: number,
  candidateFiles: string[],
  score: number | null = 4,
): OverlapCandidateInput {
  return { number, score, candidateFiles };
}

/** Candidate desync tokens; each test picks one by the index it produces. */
const TOKENS = 'abcdefghijklmnopqrstuvwxyz'.split('');
/** A token whose index in a band of three is not 0, so a desync test cannot
 * pass by accident on the deterministic lowest-number pick. */
const OFFSET_TOKEN = TOKENS.find(
  (token) => selectDesyncedIndex(token, 3) !== 0,
) as string;

test('the offset token used by the desync tests really offsets', () => {
  assert.notEqual(OFFSET_TOKEN, undefined);
  assert.notEqual(selectDesyncedIndex(OFFSET_TOKEN, 3), 0);
});

test('selectNonOverlappingBatch skips the second of two candidates sharing a high-contention file', () => {
  const result = batchOf({
    candidates: [
      scored(1, [MERGE_FILE]),
      scored(2, [MERGE_FILE]),
      scored(3, [ADVISORY_FILE]),
    ],
    batchSize: 2,
  });
  assert.deepEqual(result.batch, [1, 3]);
  assert.deepEqual(result.batchSkipped, [
    { number: 2, collidedWith: 1, reason: 'batch', files: [MERGE_FILE] },
  ]);
  assert.deepEqual(result.inFlight, []);
});

test('selectNonOverlappingBatch seeds the comparison set with in-flight issues', () => {
  const result = batchOf({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [ADVISORY_FILE])],
    inFlight: [{ number: 900, candidateFiles: [MERGE_FILE, 'src/x.mts'] }],
    batchSize: 2,
  });
  assert.deepEqual(result.batch, [2]);
  assert.deepEqual(result.batchSkipped, [
    { number: 1, collidedWith: 900, reason: 'in-flight', files: [MERGE_FILE] },
  ]);
  assert.deepEqual(result.inFlight, [
    { number: 900, filesUnknown: false, highContentionTouched: [MERGE_FILE] },
  ]);
});

test('selectNonOverlappingBatch starts at the desync index of the ascending top-score band', () => {
  // Fed as [30, 10, 20]: the band must be sorted internally, so the pick is
  // the candidate at selectDesyncedIndex(token, 3) among [10, 20, 30].
  const candidates = [
    scored(30, [REVIEW_FIX_FILE]),
    scored(10, [MERGE_FILE]),
    scored(20, [ADVISORY_FILE]),
  ];
  const expected = [10, 20, 30][selectDesyncedIndex(OFFSET_TOKEN, 3)];
  const withToken = batchOf({
    candidates,
    batchSize: 3,
    desyncToken: OFFSET_TOKEN,
  });
  assert.equal(withToken.batch[0], expected);
  assert.deepEqual(
    [...withToken.batch].sort((a, b) => a - b),
    [10, 20, 30],
  );
  // Without the token the walk starts at the top of recommendedOrder.
  assert.deepEqual(batchOf({ candidates, batchSize: 3 }).batch, [10, 20, 30]);
});

test('selectNonOverlappingBatch reports a token-picked candidate that overlaps an in-flight issue', () => {
  const candidates = [
    scored(30, [REVIEW_FIX_FILE]),
    scored(10, [MERGE_FILE]),
    scored(20, [ADVISORY_FILE]),
  ];
  const expected = [10, 20, 30][selectDesyncedIndex(OFFSET_TOKEN, 3)];
  const pickedFiles = candidates.find((c) => c.number === expected)
    ?.candidateFiles as string[];
  const result = batchOf({
    candidates,
    inFlight: [{ number: 900, candidateFiles: pickedFiles }],
    batchSize: 3,
    desyncToken: OFFSET_TOKEN,
  });
  assert.deepEqual(result.batchSkipped, [
    {
      number: expected,
      collidedWith: 900,
      reason: 'in-flight',
      files: pickedFiles,
    },
  ]);
  assert.equal(result.batch.length, 2);
  assert.equal(result.batch.includes(expected), false);
});

test('selectNonOverlappingBatch sorts the band by issue number even when the overlap nudge reorders recommendedOrder', () => {
  // 10 is flagged by an open pull request, so recommendedOrder is
  // [20, 30, 10]; the band must still be indexed as [10, 20, 30].
  const zeroToken = TOKENS.find((token) => selectDesyncedIndex(token, 3) === 0);
  assert.notEqual(zeroToken, undefined);
  const candidates = [
    scored(10, [MERGE_FILE]),
    scored(20, [ADVISORY_FILE]),
    scored(30, [REVIEW_FIX_FILE]),
  ];
  const activeIssues: ActiveIssueInput[] = [
    { number: 991, reason: 'pr', candidateFiles: [MERGE_FILE] },
  ];
  // Index 0 picks 10, the flagged lowest-numbered candidate: it is tried
  // first and dropped into batchSkipped, then the walk continues in
  // recommendedOrder. A batch of 2 fills before 10 would be reached in
  // recommendedOrder, so a missing promotion leaves batchSkipped empty.
  const flaggedPick = batchOf({
    candidates,
    activeIssues,
    batchSize: 2,
    desyncToken: zeroToken,
  });
  assert.deepEqual(flaggedPick.batchSkipped, [
    { number: 10, collidedWith: 991, reason: 'pr', files: [MERGE_FILE] },
  ]);
  assert.deepEqual(flaggedPick.batch, [20, 30]);
  // A nonzero index lands on the matching member of the sorted band.
  const offsetPick = batchOf({
    candidates,
    activeIssues,
    batchSize: 3,
    desyncToken: OFFSET_TOKEN,
  });
  assert.equal(
    offsetPick.batch[0],
    [10, 20, 30][selectDesyncedIndex(OFFSET_TOKEN, 3)],
  );
});

test('selectNonOverlappingBatch sizes the band by its top-score members, not the whole group', () => {
  // The group is [10, 20, 30, 40] but only the first three tie at the top
  // score, so the index must come from a band of 3, never 4.
  const token = TOKENS.find(
    (candidate) =>
      selectDesyncedIndex(candidate, 3) !== selectDesyncedIndex(candidate, 4) &&
      selectDesyncedIndex(candidate, 3) !== 0,
  );
  assert.notEqual(token, undefined);
  const result = batchOf({
    candidates: [
      scored(10, [MERGE_FILE]),
      scored(20, [ADVISORY_FILE]),
      scored(30, [REVIEW_FIX_FILE]),
      scored(40, ['src/lower-score.mts'], 3),
    ],
    batchSize: 4,
    desyncToken: token,
  });
  assert.equal(result.batch[0], [10, 20, 30][selectDesyncedIndex(token, 3)]);
  assert.equal(result.batch[3], 40);
});

test('selectNonOverlappingBatch compares only high-contention files', () => {
  const shared = 'src/shared.mts';
  const result = batchOf({
    candidates: [
      scored(1, [MERGE_FILE, shared]),
      scored(2, [ADVISORY_FILE, shared]),
    ],
    inFlight: [{ number: 900, candidateFiles: [shared, 'src/other.mts'] }],
    batchSize: 2,
  });
  assert.deepEqual(result.batch, [1, 2]);
  assert.deepEqual(result.batchSkipped, []);
});

test('selectNonOverlappingBatch returns what fits when the batch size exceeds the candidates', () => {
  const result = batchOf({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [ADVISORY_FILE])],
    batchSize: 10,
  });
  assert.deepEqual(result.batch, [1, 2]);
  assert.deepEqual(result.batchSkipped, []);
});

test('selectNonOverlappingBatch places a candidate with no candidate files after every known one', () => {
  const candidates = [
    scored(1, []),
    scored(2, [MERGE_FILE]),
    scored(3, [ADVISORY_FILE]),
  ];
  assert.deepEqual(batchOf({ candidates, batchSize: 3 }).batch, [2, 3, 1]);
  assert.deepEqual(batchOf({ candidates, batchSize: 2 }).batch, [2, 3]);
});

test('selectNonOverlappingBatch lets an unknown-files candidate lose a desync pick instead of consuming it', () => {
  // 5 has the same score and no files: it goes behind the known band, and
  // the token still offsets inside [10, 20, 30].
  const result = batchOf({
    candidates: [
      scored(5, []),
      scored(30, [REVIEW_FIX_FILE]),
      scored(10, [MERGE_FILE]),
      scored(20, [ADVISORY_FILE]),
    ],
    batchSize: 4,
    desyncToken: OFFSET_TOKEN,
  });
  assert.equal(
    result.batch[0],
    [10, 20, 30][selectDesyncedIndex(OFFSET_TOKEN, 3)],
  );
  assert.equal(result.batch[3], 5);
});

test('selectNonOverlappingBatch applies the desync pick to the unknown group when no candidate has known files', () => {
  const result = batchOf({
    candidates: [scored(30, []), scored(10, []), scored(20, [])],
    batchSize: 3,
    desyncToken: OFFSET_TOKEN,
  });
  assert.equal(
    result.batch[0],
    [10, 20, 30][selectDesyncedIndex(OFFSET_TOKEN, 3)],
  );
});

test('selectNonOverlappingBatch skips a candidate overlapping an open pull request', () => {
  const result = batchOf({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [ADVISORY_FILE])],
    activeIssues: [{ number: 991, reason: 'pr', candidateFiles: [MERGE_FILE] }],
    batchSize: 2,
  });
  assert.deepEqual(result.batch, [2]);
  assert.deepEqual(result.batchSkipped, [
    { number: 1, collidedWith: 991, reason: 'pr', files: [MERGE_FILE] },
  ]);
});

test('selectNonOverlappingBatch ignores the token when the band top is below the floor or suitability is off', () => {
  const candidates = [
    scored(30, [REVIEW_FIX_FILE], 2),
    scored(10, [MERGE_FILE], 2),
    scored(20, [ADVISORY_FILE], 2),
  ];
  assert.deepEqual(
    batchOf({ candidates, batchSize: 3, desyncToken: OFFSET_TOKEN, floor: 3 })
      .batch,
    [10, 20, 30],
  );
  assert.deepEqual(
    batchOf({
      candidates: candidates.map((c) => ({ ...c, score: 4 })),
      batchSize: 3,
      desyncToken: OFFSET_TOKEN,
      suitabilityEnabled: false,
    }).batch,
    [10, 20, 30],
  );
});

test('selectNonOverlappingBatch keeps the lowest-numbered pick for a single-entry band', () => {
  const result = batchOf({
    candidates: [scored(20, [ADVISORY_FILE], 3), scored(10, [MERGE_FILE], 4)],
    batchSize: 2,
    desyncToken: OFFSET_TOKEN,
  });
  assert.deepEqual(result.batch, [10, 20]);
});

test('selectNonOverlappingBatch reports one collision in the order in-flight, batch, claim', () => {
  const candidates = [
    scored(1, [ADVISORY_FILE]),
    scored(2, [MERGE_FILE, ADVISORY_FILE, REVIEW_FIX_FILE]),
  ];
  const activeIssues: ActiveIssueInput[] = [
    { number: 991, reason: 'claim', candidateFiles: [REVIEW_FIX_FILE] },
  ];
  const inFlight = [{ number: 900, candidateFiles: [MERGE_FILE] }];
  const reasonOf = (options: {
    withInFlight: boolean;
    withBatchMember: boolean;
  }) =>
    batchOf({
      candidates: options.withBatchMember ? candidates : candidates.slice(1),
      activeIssues,
      inFlight: options.withInFlight ? inFlight : [],
      batchSize: 2,
    }).batchSkipped.find((entry) => entry.number === 2)?.reason;
  assert.equal(
    reasonOf({ withInFlight: true, withBatchMember: true }),
    'in-flight',
  );
  assert.equal(
    reasonOf({ withInFlight: false, withBatchMember: true }),
    'batch',
  );
  assert.equal(
    reasonOf({ withInFlight: false, withBatchMember: false }),
    'claim',
  );
});

test('selectNonOverlappingBatch sorts shared paths and leaves unreached candidates out of both lists', () => {
  const result = batchOf({
    candidates: [
      scored(1, [REVIEW_FIX_FILE, MERGE_FILE]),
      scored(2, [MERGE_FILE, REVIEW_FIX_FILE]),
      scored(3, [ADVISORY_FILE]),
      scored(4, ['src/other.mts']),
    ],
    batchSize: 2,
  });
  assert.deepEqual(result.batch, [1, 3]);
  assert.deepEqual(result.batchSkipped, [
    {
      number: 2,
      collidedWith: 1,
      reason: 'batch',
      files: [REVIEW_FIX_FILE, MERGE_FILE].sort(),
    },
  ]);
  const mentioned = [
    ...result.batch,
    ...result.batchSkipped.map((e) => e.number),
  ];
  assert.equal(mentioned.includes(4), false);
});

test('selectNonOverlappingBatch drops a candidate that is already in flight and still compares against its files', () => {
  const result = batchOf({
    candidates: [
      scored(1, [MERGE_FILE]),
      scored(2, [MERGE_FILE]),
      scored(3, []),
    ],
    inFlight: [{ number: 1, candidateFiles: [MERGE_FILE] }],
    batchSize: 3,
  });
  assert.deepEqual(result.batchSkipped, [
    { number: 1, collidedWith: 1, reason: 'in-flight', files: [] },
    { number: 2, collidedWith: 1, reason: 'in-flight', files: [MERGE_FILE] },
  ]);
  assert.deepEqual(result.batch, [3]);
});

test('selectNonOverlappingBatch reports an in-flight issue with no known files', () => {
  const result = batchOf({
    candidates: [scored(1, [MERGE_FILE])],
    inFlight: [
      { number: 901, candidateFiles: [] },
      { number: 900, candidateFiles: ['src/x.mts'] },
    ],
    batchSize: 1,
  });
  assert.deepEqual(result.batch, [1]);
  assert.deepEqual(result.inFlight, [
    { number: 900, filesUnknown: false, highContentionTouched: [] },
    { number: 901, filesUnknown: true, highContentionTouched: [] },
  ]);
});

test('selectNonOverlappingBatch unions the files of an in-flight number listed twice', () => {
  // The later list must not be dropped: a smaller comparison set would let a
  // colliding candidate through.
  const result = batchOf({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [ADVISORY_FILE])],
    inFlight: [
      { number: 901, candidateFiles: [] },
      { number: 901, candidateFiles: [MERGE_FILE] },
      { number: 901, candidateFiles: ['src/x.mts'] },
    ],
    batchSize: 2,
  });
  assert.deepEqual(result.inFlight, [
    { number: 901, filesUnknown: false, highContentionTouched: [MERGE_FILE] },
  ]);
  assert.deepEqual(result.batch, [2]);
  assert.deepEqual(result.batchSkipped, [
    { number: 1, collidedWith: 901, reason: 'in-flight', files: [MERGE_FILE] },
  ]);
});

test('selectNonOverlappingBatch sorts shared paths itself for a caller-built analysis', () => {
  // The analysis is hand-built with reversed path lists, so a sort that
  // relied on analyzeSharedFileOverlap having run would leave the batch and
  // claim collisions reversed. (An in-flight collision is already sorted by
  // the evidence's own intersect; that case is a pass-through check.)
  const reversed = [REVIEW_FIX_FILE, MERGE_FILE];
  const sorted = [...reversed].sort();
  assert.notDeepEqual(reversed, sorted);
  const entry = (
    number: number,
    overlaps: OverlapHit[] = [],
  ): OverlapCandidateResult => ({
    number,
    score: 4,
    effectiveScore: 4,
    candidateFiles: [...reversed],
    highContentionTouched: [...reversed],
    overlaps,
    overlapFlag: overlaps.length > 0,
  });
  // recommendedOrder is set by hand: the real analyzer would rank the flagged
  // 3 last. Walking it first exercises claim-before-batch precedence: 3 is
  // dropped by its claim, then 1 is picked and 2 collides with it.
  const analysis: OverlapAnalysis = {
    candidates: [
      entry(1),
      entry(2),
      entry(3, [{ number: 991, reason: 'claim', files: [...reversed] }]),
    ],
    recommendedOrder: [3, 1, 2],
    summary: { candidateCount: 3, flaggedCount: 1, activeIssueCount: 1 },
  };
  const claimHitFiles = analysis.candidates[2].overlaps[0].files;
  const select = (inFlight: InFlightIssueInput[]) =>
    selectNonOverlappingBatch({
      analysis,
      inFlight,
      highContentionFiles: HIGH_CONTENTION,
      batchSize: 3,
    });
  const batchRun = select([]);
  assert.deepEqual(batchRun.batchSkipped, [
    { number: 3, collidedWith: 991, reason: 'claim', files: sorted },
    { number: 2, collidedWith: 1, reason: 'batch', files: sorted },
  ]);
  assert.deepEqual(batchRun.batch, [1]);
  const inFlightRun = select([{ number: 900, candidateFiles: [...reversed] }]);
  assert.deepEqual(inFlightRun.batchSkipped[0], {
    number: 3,
    collidedWith: 900,
    reason: 'in-flight',
    files: sorted,
  });
  // The emitted list is a copy: sorting it never reorders the caller's input,
  // and the output never aliases the analysis's own array.
  assert.deepEqual(claimHitFiles, [REVIEW_FIX_FILE, MERGE_FILE]);
  assert.notStrictEqual(batchRun.batchSkipped[0].files, claimHitFiles);
});

test('selectNonOverlappingBatch keeps a candidate with only non-high-contention files in the known group', () => {
  // "Known" means the candidate lists files at all, not that any is hot.
  const candidates = [
    scored(1, ['src/a.mts']),
    scored(2, []),
    scored(3, [MERGE_FILE]),
  ];
  assert.deepEqual(batchOf({ candidates, batchSize: 3 }).batch, [1, 3, 2]);
  const analysis = analyzeSharedFileOverlap({
    candidates,
    activeIssues: [],
    highContentionFiles: HIGH_CONTENTION,
  });
  const output = buildOverlapOutput({
    repository: { owner: 'o', repo: 'r' },
    checkedOverlap: false,
    manifestMissing: false,
    highContentionFiles: HIGH_CONTENTION,
    analysis,
    batchSelection: { batch: [], batchSkipped: [], inFlight: [] },
  });
  assert.deepEqual(
    (output.candidates as { number: number; filesUnknown: boolean }[]).map(
      (candidate) => [candidate.number, candidate.filesUnknown],
    ),
    [
      [1, false],
      [2, true],
      [3, false],
    ],
  );
});

test('selectNonOverlappingBatch rejects a non-positive or fractional batch size', () => {
  for (const batchSize of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => batchOf({ candidates: [scored(1, [MERGE_FILE])], batchSize }),
      /batchSize must be a positive integer/,
    );
  }
});

test('buildOverlapOutput without a batch keeps the pre-batch key set and order', () => {
  const analysis = analyzeSharedFileOverlap({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [])],
    activeIssues: [],
    highContentionFiles: HIGH_CONTENTION,
  });
  const output = buildOverlapOutput({
    repository: { owner: 'o', repo: 'r' },
    checkedOverlap: false,
    manifestMissing: false,
    highContentionFiles: new Set([REVIEW_FIX_FILE, MERGE_FILE]),
    analysis,
  });
  assert.deepEqual(Object.keys(output), [
    'repository',
    'checkedOverlap',
    'manifestMissing',
    'highContentionFiles',
    'candidates',
    'recommendedOrder',
    'summary',
  ]);
  assert.deepEqual(output, {
    repository: { owner: 'o', repo: 'r' },
    checkedOverlap: false,
    manifestMissing: false,
    highContentionFiles: [MERGE_FILE, REVIEW_FIX_FILE].sort(),
    ...analysis,
  });
  assert.deepEqual(Object.keys(analysis.candidates[0]), [
    'number',
    'score',
    'effectiveScore',
    'candidateFiles',
    'highContentionTouched',
    'overlaps',
    'overlapFlag',
  ]);
});

test('buildOverlapOutput with a batch adds batch, batchSkipped, inFlight and per-candidate filesUnknown', () => {
  const analysis = analyzeSharedFileOverlap({
    candidates: [scored(1, [MERGE_FILE]), scored(2, [])],
    activeIssues: [],
    highContentionFiles: HIGH_CONTENTION,
  });
  const output = buildOverlapOutput({
    repository: { owner: 'o', repo: 'r' },
    checkedOverlap: false,
    manifestMissing: false,
    highContentionFiles: HIGH_CONTENTION,
    analysis,
    batchSelection: { batch: [1, 2], batchSkipped: [], inFlight: [] },
  });
  assert.deepEqual(Object.keys(output), [
    'repository',
    'checkedOverlap',
    'manifestMissing',
    'highContentionFiles',
    'candidates',
    'recommendedOrder',
    'summary',
    'batch',
    'batchSkipped',
    'inFlight',
  ]);
  const candidates = output.candidates as {
    number: number;
    filesUnknown: boolean;
  }[];
  assert.deepEqual(
    candidates.map((c) => [c.number, c.filesUnknown]),
    [
      [1, false],
      [2, true],
    ],
  );
  assert.deepEqual(output.recommendedOrder, analysis.recommendedOrder);
  assert.deepEqual(output.summary, analysis.summary);
  // The analysis itself is not mutated, so the no-batch shape stays pinned.
  assert.equal('filesUnknown' in analysis.candidates[0], false);
});

test('parseArgs: the batch flags default to null when absent', () => {
  const args = parseArgs(['--issue', '5']);
  assert.equal(args.batch, null);
  assert.equal(args.inFlight, null);
  assert.equal(args.desyncToken, null);
});

test('parseArgs: --batch, repeatable --in-flight and --desync-token are parsed', () => {
  const args = parseArgs([
    '--issues',
    '5,6',
    '--batch',
    '2',
    '--in-flight',
    '7,9',
    '--in-flight=9, 11',
    '--desync-token',
    'claude-1980feaa',
  ]);
  assert.equal(args.batch, 2);
  assert.deepEqual(args.inFlight, [7, 9, 11]);
  assert.equal(args.desyncToken, 'claude-1980feaa');
});

test('parseArgs: an empty --in-flight value is an empty set, not an error', () => {
  assert.deepEqual(
    parseArgs(['--issue', '5', '--batch', '1', '--in-flight', '']).inFlight,
    [],
  );
  assert.deepEqual(
    parseArgs(['--issue', '5', '--batch', '1', '--in-flight=']).inFlight,
    [],
  );
});

test('parseArgs: --batch and --in-flight reject anything but plain positive integers', () => {
  for (const bad of ['0', '2x', '1.5', '-1', 'abc', '']) {
    assert.throws(
      () => parseArgs(['--issue', '5', '--batch', bad]),
      /invalid --batch value/,
      `--batch ${bad}`,
    );
  }
  assert.throws(
    () => parseArgs(['--issue', '5', '--batch', '1', '--in-flight', '3,4x']),
    /invalid --in-flight value: 4x/,
  );
});

test('parseArgs: --in-flight and --desync-token without --batch are usage errors', () => {
  assert.throws(
    () => parseArgs(['--issue', '5', '--in-flight', '3']),
    /--in-flight requires --batch/,
  );
  assert.throws(
    () => parseArgs(['--issue', '5', '--desync-token', 'tok']),
    /--desync-token requires --batch/,
  );
  assert.throws(
    () => parseArgs(['--issue', '5', '--batch', '1', '--desync-token', '']),
    /--desync-token must not be empty/,
  );
});

test('parseArgs: --help skips the batch combination checks', () => {
  assert.equal(parseArgs(['--help', '--in-flight', '3']).help, true);
});
