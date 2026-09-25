import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BOT_WORDING_CLASSIFIERS } from '../src/scripts/protocol-helpers.mts';

// #3263: pins every wording-based bot-comment classifier this module (and
// its leaf copilot-review-body.mts dependency) exports against a corpus of
// real, verbatim bot comment bodies harvested from this repository's own
// public PR history, so a classifier drifting from live vendor output stops
// silently -- the #1880 suppressed-comments parser's own incident (going
// stale with no test noticing) is exactly the failure mode this closes.
// Network-free by design: imports only BOT_WORDING_CLASSIFIERS (pure
// functions) and reads the committed JSON fixture off disk, never a live
// `gh` call. The corpus itself is a static, hand-curated fixture -- there
// is no snapshot/refresh tool for it (unlike tests/fixtures/issue-body-
// corpus/), since every entry's own provenance fields are what let a
// maintainer re-fetch and re-verify it by hand.

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'bot-comment-corpus',
  'corpus.json',
);

interface CorpusEntrySource {
  pr: number | null;
  reviewId: number | null;
  commentId: number | null;
  editedAt: string | null;
}

interface CorpusEntry {
  id: string;
  botLogin: string;
  source: CorpusEntrySource;
  surface: string;
  body: string;
  note: string | null;
  expectedLabels: Record<string, unknown>;
}

function loadCorpus(): CorpusEntry[] {
  return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as CorpusEntry[];
}

const MIN_SAMPLES = 3;
const MIN_DISTINCT_PRS = 2;

// The evidence bar this issue's own acceptance criteria sets: a registered
// wording classifier needs at least MIN_SAMPLES real POSITIVE samples
// (bodies the classifier actually matches, not every corpus entry that
// merely exercises it -- a negative/false-labeled fixture proves the
// matcher stays narrow, not that the wording is well-attested) from at
// least MIN_DISTINCT_PRS distinct PRs, or must be on the pinned grandfather
// list below. Because this test pins the list's exact contents, adding to
// it is visible in review -- no id added after #3263 may be grandfathered
// (the acceptance criteria's own rule).
//
// Each entry names its originating issue and the search that found too few
// samples, per that same acceptance criteria.
const GRANDFATHERED_CLASSIFIER_IDS: Readonly<Record<string, string>> = {
  'coderabbit-already-reviewed-ack':
    '#3146: only a template sample is committed (no PR/comment id) -- a ' +
    'targeted search ("Already reviewed the last commit" and "does not ' +
    're-review already reviewed commits" against kurone-kito/idd-skill, ' +
    'including a direct issues/comments scan of the 10 PRs the second ' +
    'query returned) found no re-fetchable real comment carrying this ' +
    'exact shape. The matcher already existed at d04f5a55 with fewer ' +
    'than 3 samples from 2 PRs.',
  'coderabbit-rate-limited-ack':
    '#3193: 2 real samples committed (PR #2529 comment 5518457203, PR ' +
    '#2531 comment 5518504266, found via `gh search prs "Review rate ' +
    'limited"`), still under the 3-sample floor. The matcher already ' +
    'existed at d04f5a55 with fewer than 3 samples from 2 PRs, and #3193 ' +
    "is pre-approved on this issue's own grandfather list regardless.",
  'coderabbit-embedded-findings':
    '#2559/#2197: 2 real samples committed (PR #1871 review 4860403155, ' +
    'an outside-diff-range finding; PR #1897 review 4863787336, a ' +
    'nitpick finding -- the sibling embedded-findings section shape), ' +
    'still under the 3-sample floor. The matcher already existed at ' +
    'd04f5a55 with fewer than 3 samples from 2 PRs.',
};

/**
 * A "positive" sample for the evidence-bar count: the classifier actually
 * matched this fixture's body, not merely that the fixture exercises the
 * classifier (a `false`/`0`/`unrecognized` label proves the matcher stays
 * narrow, the opposite of evidence for a wording's real-world prevalence).
 */
function isPositiveLabel(label: unknown): boolean {
  if (typeof label === 'boolean') {
    return label;
  }
  if (typeof label === 'number') {
    return label > 0;
  }
  if (
    typeof label === 'object' &&
    label !== null &&
    'shape' in label &&
    typeof (label as { shape: unknown }).shape === 'string'
  ) {
    return (label as { shape: string }).shape !== 'unrecognized';
  }
  return false;
}

test("every corpus entry's expected labels match every classifier it names", () => {
  const corpus = loadCorpus();
  const byId = new Map(BOT_WORDING_CLASSIFIERS.map((c) => [c.id, c]));
  const mismatches: string[] = [];
  for (const entry of corpus) {
    for (const [classifierId, expected] of Object.entries(
      entry.expectedLabels,
    )) {
      const classifier = byId.get(classifierId);
      assert.ok(
        classifier,
        `${entry.id}: unknown classifier id "${classifierId}" -- not ` +
          'registered in BOT_WORDING_CLASSIFIERS',
      );
      const actual = classifier.apply({
        login: entry.botLogin,
        body: entry.body,
      });
      try {
        assert.deepEqual(actual, expected);
      } catch {
        mismatches.push(
          `${entry.id}: classifier "${classifierId}" returned ` +
            `${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
        );
      }
    }
  }
  assert.deepEqual(mismatches, []);
});

test('every registered wording classifier has at least 3 real positive samples from at least 2 distinct PRs, or is grandfathered', () => {
  const corpus = loadCorpus();
  const samplesByClassifier = new Map<string, Set<string>>();
  for (const entry of corpus) {
    for (const [classifierId, label] of Object.entries(entry.expectedLabels)) {
      if (!isPositiveLabel(label)) {
        continue;
      }
      const prMarker =
        entry.source.pr === null
          ? `no-pr:${entry.id}`
          : `pr:${entry.source.pr}`;
      const set = samplesByClassifier.get(classifierId) ?? new Set<string>();
      // One entry per (classifierId, entry.id) pair for the sample count,
      // and prMarker feeds the SEPARATE distinct-PR count below via the
      // same set's own PR-prefixed members -- see the split below.
      set.add(`sample:${entry.id}`);
      set.add(prMarker);
      samplesByClassifier.set(classifierId, set);
    }
  }

  const violations: string[] = [];
  for (const classifier of BOT_WORDING_CLASSIFIERS) {
    const entries = samplesByClassifier.get(classifier.id) ?? new Set<string>();
    const sampleCount = [...entries].filter((e) =>
      e.startsWith('sample:'),
    ).length;
    const distinctPrCount = new Set(
      [...entries]
        .filter((e) => e.startsWith('pr:'))
        .map((e) => e.slice('pr:'.length)),
    ).size;
    const meetsBar =
      sampleCount >= MIN_SAMPLES && distinctPrCount >= MIN_DISTINCT_PRS;
    const isGrandfathered = classifier.id in GRANDFATHERED_CLASSIFIER_IDS;
    if (!meetsBar && !isGrandfathered) {
      violations.push(
        `${classifier.id}: ${sampleCount} positive sample(s) from ` +
          `${distinctPrCount} distinct PR(s) -- below the ${MIN_SAMPLES}-` +
          `sample/${MIN_DISTINCT_PRS}-PR floor and not on the grandfather ` +
          'list',
      );
    }
    if (meetsBar && isGrandfathered) {
      violations.push(
        `${classifier.id}: now has ${sampleCount} positive sample(s) from ` +
          `${distinctPrCount} distinct PR(s), meeting the evidence bar -- ` +
          'remove it from GRANDFATHERED_CLASSIFIER_IDS',
      );
    }
  }
  assert.deepEqual(violations, []);
});

test('every classifier BOT_WORDING_CLASSIFIERS registers is exercised by at least one corpus entry', () => {
  const corpus = loadCorpus();
  const exercised = new Set<string>();
  for (const entry of corpus) {
    for (const classifierId of Object.keys(entry.expectedLabels)) {
      exercised.add(classifierId);
    }
  }
  const unexercised = BOT_WORDING_CLASSIFIERS.map((c) => c.id).filter(
    (id) => !exercised.has(id),
  );
  assert.deepEqual(unexercised, []);
});

test('every grandfathered id is still a registered classifier', () => {
  const registeredIds = new Set(BOT_WORDING_CLASSIFIERS.map((c) => c.id));
  const stale = Object.keys(GRANDFATHERED_CLASSIFIER_IDS).filter(
    (id) => !registeredIds.has(id),
  );
  assert.deepEqual(stale, []);
});

test('the corpus holds the acceptance-criteria-required PR #3196/#3174 non-zero suppressedCount entries', () => {
  const corpus = loadCorpus();
  const byId = new Map(corpus.map((entry) => [entry.id, entry]));

  const entry3196 = byId.get('copilot-v2-previously-missed-3196');
  assert.ok(entry3196, 'missing the PR #3196 review 5288008196 entry');
  assert.equal(entry3196.source.pr, 3196);
  assert.equal(entry3196.source.reviewId, 5288008196);
  const label3196 = entry3196.expectedLabels['copilot-review-body'] as {
    suppressedCount: number;
  };
  assert.ok(
    label3196.suppressedCount > 0,
    'PR #3196 review 5288008196 must have a non-zero suppressedCount',
  );

  const entry3174 = byId.get('copilot-v2-resolved-and-previously-missed-3174');
  assert.ok(entry3174, 'missing the PR #3174 review 5269880575 entry');
  assert.equal(entry3174.source.pr, 3174);
  assert.equal(entry3174.source.reviewId, 5269880575);
  const label3174 = entry3174.expectedLabels['copilot-review-body'] as {
    suppressedCount: number;
  };
  assert.ok(
    label3174.suppressedCount > 0,
    'PR #3174 review 5269880575 must have a non-zero suppressedCount',
  );
});

test('the corpus holds the acceptance-criteria-required PR #3196 in-progress-revision pending entry', () => {
  const corpus = loadCorpus();
  const entry = corpus.find((e) => e.id === 'coderabbit-in-progress-3196');
  assert.ok(entry, 'missing the PR #3196 comment 5789875341 in-progress entry');
  assert.equal(entry.source.pr, 3196);
  assert.equal(entry.source.commentId, 5789875341);
  assert.equal(entry.source.editedAt, '2026-09-23T07:13:25Z');
  assert.equal(entry.expectedLabels['coderabbit-review-in-progress'], true);
  // "pending" per the acceptance criteria: not classified as a terminal
  // notice either -- an in-progress review is neither settled nor declined.
  assert.equal(entry.expectedLabels['advisory-non-review-notice'], false);
  assert.equal(entry.expectedLabels['advisory-terminal-notice'], false);
});
