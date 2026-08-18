import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderReviewReplyStamp } from '../src/scripts/marker-helpers.mts';
import {
  classifyReviewCommentOrigin,
  isIddOriginatedReviewComment,
} from '../src/scripts/review-comment-origin.mts';

test('ordinary human review chatter is not IDD-originated', () => {
  for (const body of ['LGTM', 'thanks, fixed', 'Looks good to me.']) {
    assert.equal(isIddOriginatedReviewComment(body), false, body);
    assert.deepEqual(classifyReviewCommentOrigin(body).reasons, []);
  }
});

test('a disposition prefix is IDD-originated', () => {
  const accepted = '**Accepted** — fixed in abc123';
  const rejected = '**Rejected** — out of scope';
  assert.equal(isIddOriginatedReviewComment(accepted), true);
  assert.ok(
    classifyReviewCommentOrigin(accepted).reasons.includes(
      'disposition-prefix',
    ),
  );
  assert.equal(isIddOriginatedReviewComment(rejected), true);
});

test('a reply-identity stamp is IDD-originated even without a disposition prefix', () => {
  const stamped = `thanks\n\n${renderReviewReplyStamp()}`;
  assert.equal(isIddOriginatedReviewComment(stamped), true);
  assert.ok(
    classifyReviewCommentOrigin(stamped).reasons.includes('review-reply-stamp'),
  );
});

test('an operational first-bytes marker is IDD-originated', () => {
  const ack = `review-ack: grok-test ${'a'.repeat(40)} 2026-08-18T00:00:00Z`;
  assert.equal(isIddOriginatedReviewComment(ack), true);
  assert.ok(
    classifyReviewCommentOrigin(ack).reasons.includes('operational-marker'),
  );
});

test('rejection-confirmed is IDD-originated', () => {
  const body = '**Rejection confirmed by maintainer** — agreed';
  assert.equal(isIddOriginatedReviewComment(body), true);
  assert.ok(
    classifyReviewCommentOrigin(body).reasons.includes('rejection-confirmed'),
  );
});
