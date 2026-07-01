import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isDispositionComment,
  isNonReviewNoticeDisposition,
  isReviewSummaryDisposition,
} from '../src/scripts/protocol-helpers.mts';
import { classifyMarker } from '../src/scripts/review-disposition-verify.mts';

// #1151: a single interior punctuation char `[.!:]` immediately before the
// closing `**` (natural English "Accepted. Fixed in…") is tolerated across the
// disposition-marker predicate family, while an interior-text body is still
// rejected (fail-closed: a false positive is a false merge).
const PUNCT_SUFFIXES = ['', '.', ':', '!'];

test('isDispositionComment tolerates a single trailing punctuation before the closing **', () => {
  for (const p of PUNCT_SUFFIXES) {
    assert.equal(
      isDispositionComment({ body: `**Accepted${p}** — fixed in abc123` }),
      true,
      `Accepted variant "${p}" should be recognized`,
    );
    assert.equal(
      isDispositionComment({ body: `**Rejected${p}** — out of scope` }),
      true,
      `Rejected variant "${p}" should be recognized`,
    );
  }
  // Interior-text and non-bold bodies stay unrecognized.
  assert.equal(
    isDispositionComment({ body: '**Accepted by reviewer, but I disagree**' }),
    false,
  );
  assert.equal(isDispositionComment({ body: '**Accepted, done**' }), false);
  assert.equal(isDispositionComment({ body: 'Accepted — some note' }), false);
  // Two interior punctuation chars exceed the single-char tolerance.
  assert.equal(isDispositionComment({ body: '**Accepted..**' }), false);
});

test('isNonReviewNoticeDisposition tolerates the punctuation while keeping its notice phrase', () => {
  for (const p of PUNCT_SUFFIXES) {
    assert.equal(
      isNonReviewNoticeDisposition({
        body: `**Rejected${p}** — coderabbitai[bot] did not review HEAD abc (rate limited); this is not a completed review`,
      }),
      true,
      `Rejected variant "${p}" should be recognized`,
    );
  }
  // A plain rejection without the notice phrase is not a non-review-notice
  // disposition, and interior-text stays unrecognized.
  assert.equal(
    isNonReviewNoticeDisposition({ body: '**Rejected.** — out of scope' }),
    false,
  );
  assert.equal(
    isNonReviewNoticeDisposition({
      body: '**Rejected by bot** did not review HEAD abc',
    }),
    false,
  );
});

test('isReviewSummaryDisposition tolerates the punctuation while keeping its walkthrough phrase', () => {
  for (const p of PUNCT_SUFFIXES) {
    assert.equal(
      isReviewSummaryDisposition({
        body: `**Accepted${p}** — coderabbitai[bot] summary walkthrough; no action required`,
      }),
      true,
      `Accepted variant "${p}" should be recognized`,
    );
  }
  // A plain acceptance without the walkthrough phrase is excluded, and
  // interior-text stays unrecognized.
  assert.equal(
    isReviewSummaryDisposition({ body: '**Accepted.** — confirmed' }),
    false,
  );
  assert.equal(
    isReviewSummaryDisposition({
      body: '**Accepted the summary walkthrough**',
    }),
    false,
  );
});

test('classifyMarker tolerates the punctuation but keeps the required — separator', () => {
  for (const p of PUNCT_SUFFIXES) {
    assert.equal(
      classifyMarker(`**Accepted${p}** — the advisory confirmed no action`),
      'accepted',
      `Accepted variant "${p}"`,
    );
    assert.equal(
      classifyMarker(`**Rejected${p}** — not applicable`),
      'rejected',
      `Rejected variant "${p}"`,
    );
  }
  // Interior-text body and a missing — separator are still not classified.
  assert.equal(classifyMarker('**Accepted by reviewer, but** — note'), null);
  assert.equal(classifyMarker('**Accepted.** no separator'), null);
});
