import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildDispositionBody } from '../src/scripts/disposition-non-review-notices.mts';
import {
  appendReviewReplyStamp,
  hasReviewReplyStamp,
  isIddOriginatedReply,
  OPERATIONAL_MARKERS,
  operationalMarkerPrefix,
  REVIEW_REPLY_STAMP_SUFFIX,
  renderReviewReplyStamp,
  renderReviewWatermarkMarker,
} from '../src/scripts/marker-helpers.mts';
import { isDispositionComment } from '../src/scripts/protocol-helpers.mts';

const STAMP = '<!-- idd-skill-review-reply -->';

test('REVIEW_REPLY_STAMP_SUFFIX is review-reply, not a watermark token', () => {
  assert.equal(REVIEW_REPLY_STAMP_SUFFIX, 'review-reply');
  assert.notEqual(REVIEW_REPLY_STAMP_SUFFIX, 'watermark');
  assert.notEqual(REVIEW_REPLY_STAMP_SUFFIX, 'review-watermark');
});

test('renderReviewReplyStamp uses the configured prefix and default', () => {
  assert.equal(renderReviewReplyStamp(), STAMP);
  assert.equal(
    renderReviewReplyStamp('org.project'),
    '<!-- org.project-review-reply -->',
  );
});

test('isIddOriginatedReply is true only when the prefix-aware stamp is present', () => {
  const stamped = `**Accepted** — fixed in abc123\n\n${STAMP}`;
  assert.equal(isIddOriginatedReply(stamped), true);
  assert.equal(hasReviewReplyStamp(stamped), true);
  assert.equal(isIddOriginatedReply('LGTM'), false);
  assert.equal(isIddOriginatedReply('thanks, fixed'), false);
  assert.equal(isIddOriginatedReply('**Accepted** — fixed in abc123'), false);
});

test('hasReviewReplyStamp does not treat an E1 review-watermark as a reply stamp', () => {
  const watermark = renderReviewWatermarkMarker({
    agentId: 'grok-test',
    claimId: 'claim-1',
    headSha: 'a'.repeat(40),
    maxActivityAt: '2026-08-18T00:00:00Z',
    totalItemCount: 1,
    ciCompletedAt: '2026-08-18T00:00:00Z',
  });
  assert.match(watermark, /review-watermark/);
  assert.equal(hasReviewReplyStamp(watermark), false);
  assert.equal(isIddOriginatedReply(watermark), false);
});

test('hasReviewReplyStamp honors an adopter markerPrefix and does not cross prefixes', () => {
  const adopter = '<!-- org.project-review-reply -->';
  assert.equal(hasReviewReplyStamp(adopter, 'org.project'), true);
  assert.equal(hasReviewReplyStamp(adopter, 'idd-skill'), false);
  assert.equal(hasReviewReplyStamp(STAMP, 'org.project'), false);
});

test('appendReviewReplyStamp is idempotent and preserves first-byte disposition', () => {
  const visible = '**Accepted** — fixed in abc123';
  const once = appendReviewReplyStamp(visible);
  const twice = appendReviewReplyStamp(once);
  assert.equal(once, twice);
  assert.ok(once.startsWith('**Accepted**'));
  assert.ok(once.includes(STAMP));
  assert.equal(appendReviewReplyStamp(''), '');
  assert.equal(appendReviewReplyStamp('   '), '   ');
});

test('OPERATIONAL_MARKERS and F4 prefix detection ignore a stamped disposition', () => {
  const stamped = appendReviewReplyStamp('**Rejected** — out of scope');
  assert.equal(
    OPERATIONAL_MARKERS.some((marker) =>
      marker.label.toLowerCase().includes('review-reply'),
    ),
    false,
  );
  assert.equal(operationalMarkerPrefix(stamped), null);
  assert.equal(operationalMarkerPrefix(STAMP), null);
});

test('a trusted-author Accepted body with no stamp is still an IDD disposition', () => {
  const legacy = '**Accepted** — fixed in abc123: added the stamp later';
  assert.equal(isDispositionComment({ body: legacy }), true);
  assert.equal(isIddOriginatedReply(legacy), false);
});

test('buildDispositionBody injects the stamp after the visible rejection', () => {
  const body = buildDispositionBody(
    'coderabbitai[bot]',
    'abc1234',
    'review limit reached',
    501,
  );
  assert.ok(body.startsWith('**Rejected**'));
  assert.ok(hasReviewReplyStamp(body));
  assert.equal(isDispositionComment({ body }), true);
});
