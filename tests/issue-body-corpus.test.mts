import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  bodySha256,
  type CorpusEntry,
  type CorpusIndexEntry,
  computeExpectedVerdict,
} from '../src/scripts/snapshot-issue-body-corpus.mts';

// #3288: freezes a real (and a fixed set of synthetic-gap) issue-body
// corpus's A4 (discover-viability-gate.mts) / A4.5 (suitability-triage.mts,
// local/offline mode) verdicts as a regression baseline, so an edit to
// those lexical gates can be checked against real issue bodies rather than
// only the synthetic fixtures in tests/discover-viability-gate.test.mts and
// tests/suitability-triage.test.mts. Network-free by design (imports only
// the pure computeExpectedVerdict and reads the committed JSON fixtures
// off disk) -- the corpus itself is populated and refreshed by the
// separate, opt-in src/scripts/snapshot-issue-body-corpus.mts CLI, never
// by this test or by `pnpm test`/CI.
//
// WORKFLOW: a PR that changes a gate helper and flips one or more of this
// corpus's stored verdicts must update the affected `expected` blocks in
// the SAME PR (`node scripts/snapshot-issue-body-corpus.mjs
// --update-expected`, after reviewing the emitted git diff -- see that
// tool's own guardrail comment) and list every flipped entry in the PR
// description. The corpus is test-only: no runtime path reads it, so the
// live A4/A4.5 gates keep their verdict authority regardless of what this
// frozen snapshot says.

const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'issue-body-corpus',
);

const MIN_MERGED_ENTRIES = 50;
const MIN_NEGATIVE_ENTRIES = 8;
const EXPECTED_SYNTHETIC_ENTRIES = 13;

function readIndex(): CorpusIndexEntry[] {
  return JSON.parse(
    readFileSync(join(CORPUS_DIR, 'index.json'), 'utf8'),
  ) as CorpusIndexEntry[];
}

function corpusFileIds(): string[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => name.slice(0, -'.json'.length))
    .sort();
}

function readEntry(id: string): CorpusEntry {
  return JSON.parse(
    readFileSync(join(CORPUS_DIR, `${id}.json`), 'utf8'),
  ) as CorpusEntry;
}

function loadAllEntries(): CorpusEntry[] {
  return corpusFileIds().map((id) => readEntry(id));
}

/**
 * Recomputes `entry`'s verdict from today's A4/A4.5 helpers and compares it
 * against the entry's stored `expected`, returning one human-readable diff
 * line per mismatched field (viability.passed, viability.failedCriteria, or
 * any individual triage.<checkId>) -- an empty array means a full match.
 * Every diff line names both the entry's `id` and the specific criterion
 * or check that flipped, by construction.
 */
export function diffEntryExpected(entry: CorpusEntry): string[] {
  const actual = computeExpectedVerdict({
    number: Number.parseInt(entry.id, 10) || 0,
    title: entry.title,
    body: entry.body,
    labels: entry.labels,
  });
  const diffs: string[] = [];

  if (actual.viability.passed !== entry.expected.viability.passed) {
    diffs.push(
      `${entry.id}: viability.passed expected=${entry.expected.viability.passed} actual=${actual.viability.passed}`,
    );
  }

  const expectedFailedCriteria = [
    ...entry.expected.viability.failedCriteria,
  ].sort();
  const actualFailedCriteria = [...actual.viability.failedCriteria].sort();
  if (
    JSON.stringify(expectedFailedCriteria) !==
    JSON.stringify(actualFailedCriteria)
  ) {
    diffs.push(
      `${entry.id}: viability.failedCriteria expected=${JSON.stringify(
        expectedFailedCriteria,
      )} actual=${JSON.stringify(actualFailedCriteria)}`,
    );
  }

  const checkIds = new Set([
    ...Object.keys(entry.expected.triage),
    ...Object.keys(actual.triage),
  ]);
  for (const checkId of [...checkIds].sort()) {
    const expectedResult = entry.expected.triage[checkId];
    const actualResult = actual.triage[checkId];
    if (expectedResult !== actualResult) {
      diffs.push(
        `${entry.id}: triage.${checkId} expected=${expectedResult ?? '(missing)'} actual=${actualResult ?? '(missing)'}`,
      );
    }
  }

  return diffs;
}

// ---------------------------------------------------------------------------
// Unit test for diffEntryExpected itself, over a synthetic fixture -- proves
// a mismatch is actually detected (and correctly attributed to the entry id
// and the specific criterion), not just that the real corpus sweep below
// happens to pass today. Mirrors tests/help-text-flags.test.mts's own
// synthetic-fixture-before-real-corpus shape.
// ---------------------------------------------------------------------------

test('diffEntryExpected reports the entry id and criterion for an inverted expected.viability.passed', () => {
  const title = 'A minimal, narrowly-scoped fixture-only issue';
  const body = [
    'Add a single small helper function with a unit test.',
    '',
    '## Acceptance Criteria',
    '',
    '- `node --test tests/example.test.mts` passes.',
  ].join('\n');
  const actual = computeExpectedVerdict({ number: 0, title, body, labels: [] });

  const entryWithInvertedPassed: CorpusEntry = {
    id: 'synthetic-unit-test-fixture',
    category: 'synthetic',
    note: '',
    title,
    labels: [],
    body,
    bodySha256: '',
    fetchedAt: '',
    expected: {
      viability: {
        // Deliberately inverted from `actual.viability.passed` -- this is
        // the bug diffEntryExpected must catch.
        passed: !actual.viability.passed,
        failedCriteria: actual.viability.failedCriteria,
      },
      triage: { ...actual.triage },
    },
  };

  const diffs = diffEntryExpected(entryWithInvertedPassed);
  assert.ok(
    diffs.some(
      (diff) =>
        diff.includes('synthetic-unit-test-fixture') &&
        diff.includes('viability.passed'),
    ),
    `expected a diff naming the entry id and "viability.passed", got: ${JSON.stringify(diffs)}`,
  );
});

// ---------------------------------------------------------------------------
// The real corpus: size/category thresholds, index/file consistency, and
// the full verdict-comparison sweep.
// ---------------------------------------------------------------------------

test('corpus meets the minimum entry-count thresholds per category', () => {
  const entries = loadAllEntries();
  const counts = { merged: 0, negative: 0, synthetic: 0 } as Record<
    CorpusEntry['category'],
    number
  >;
  for (const entry of entries) {
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  assert.ok(
    counts.merged >= MIN_MERGED_ENTRIES,
    `expected at least ${MIN_MERGED_ENTRIES} "merged" entries, got ${counts.merged}`,
  );
  assert.ok(
    counts.negative >= MIN_NEGATIVE_ENTRIES,
    `expected at least ${MIN_NEGATIVE_ENTRIES} "negative" entries, got ${counts.negative}`,
  );
  assert.equal(
    counts.synthetic,
    EXPECTED_SYNTHETIC_ENTRIES,
    `expected exactly ${EXPECTED_SYNTHETIC_ENTRIES} "synthetic" entries, got ${counts.synthetic}`,
  );
});

test('every corpus JSON file is listed in index.json, and vice versa', () => {
  const fileIds = corpusFileIds();
  const indexIds = readIndex()
    .map((row) => row.id)
    .sort();
  assert.deepEqual(
    fileIds,
    indexIds,
    'tests/fixtures/issue-body-corpus/index.json must list exactly the ' +
      '<id>.json files present in the directory (no more, no fewer)',
  );
});

test('every corpus entry has a unique id matching its own filename', () => {
  for (const id of corpusFileIds()) {
    const entry = readEntry(id);
    assert.equal(
      entry.id,
      id,
      `${id}.json's own "id" field ("${entry.id}") does not match its filename`,
    );
  }
});

// #3288 C1 review: --refresh's skip logic (snapshot-issue-body-corpus.mts)
// keys on the stored bodySha256 matching a freshly recomputed one -- a
// hand-edited or stale hash would silently break that refresh contract with
// nothing else catching it, since the verdict-comparison test above only
// ever reads the stored body, never re-derives its own hash.
test("every corpus entry's bodySha256 matches sha256(body)", () => {
  const mismatches: string[] = [];
  for (const entry of loadAllEntries()) {
    const recomputed = bodySha256(entry.body);
    if (recomputed !== entry.bodySha256) {
      mismatches.push(
        `${entry.id}: stored bodySha256=${entry.bodySha256} recomputed=${recomputed}`,
      );
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

// #3288 C1 review: the corpus's own "expected verdict matches today's
// helpers" sweep below only ever checks frozen-vs-recomputed EQUALITY, so a
// future gate change that makes a "negative" entry start passing would be
// silently accepted as a new frozen "expected" via --update-expected,
// defeating this category's whole selection purpose ("the current helpers
// still rate it non-ready") with nothing to notice. This test checks that
// purpose directly, against each entry's OWN currently-stored "expected"
// (not a live recompute -- that is the sweep below's job).
test('every "negative" entry\'s stored expected verdict still rates non-ready', () => {
  const stillReady: string[] = [];
  for (const entry of loadAllEntries()) {
    if (entry.category !== 'negative') {
      continue;
    }
    const rendersReady =
      entry.expected.viability.passed &&
      Object.values(entry.expected.triage).every((result) => result !== 'fail');
    if (rendersReady) {
      stillReady.push(entry.id);
    }
  }
  assert.deepEqual(
    stillReady,
    [],
    `"negative" entries whose stored expected now rates ready (violates ` +
      `their own selection rule): ${stillReady.join(', ')}`,
  );
});

test("every corpus entry's stored expected verdict matches today's A4/A4.5 helpers", () => {
  const allDiffs: string[] = [];
  for (const entry of loadAllEntries()) {
    allDiffs.push(...diffEntryExpected(entry));
  }
  assert.deepEqual(
    allDiffs,
    [],
    `${allDiffs.length} corpus ${
      allDiffs.length === 1 ? 'entry has' : 'entries have'
    } a stored "expected" verdict that no longer matches today's A4/A4.5 ` +
      'helpers. If this is an intentional gate-behavior change, run ' +
      '`node scripts/snapshot-issue-body-corpus.mjs --update-expected`, ' +
      'review the diff, and list every flipped entry in the PR ' +
      `description. Flipped entries:\n${allDiffs.join('\n')}`,
  );
});
