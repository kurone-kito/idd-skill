import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifyReviewThreadForGate,
  detectMalformedReviewWatermarkComments,
  diffReviewSnapshot,
  resolveLatestReviewWatermark,
  routeRejectedChangesRequestedReview,
  summarizeReviewThreadsForGate,
} from '../src/scripts/protocol-helpers.mts';
import { readJson } from './test-utils.mts';

const changesRequestedRoutes = readJson(
  'fixtures/review-gate/changes-requested-routes.json',
);
const snapshotDiffRoutes = readJson(
  'fixtures/review-gate/snapshot-diff-routes.json',
);
const threadGateRoutes = readJson(
  'fixtures/review-gate/thread-gate-routes.json',
);

test('routes rejected CHANGES_REQUESTED review-body scenarios', () => {
  for (const fixture of changesRequestedRoutes) {
    assert.deepEqual(
      routeRejectedChangesRequestedReview(fixture.input),
      fixture.expected,
      fixture.name,
    );
  }
});

test('routes F2/F3 snapshot-vs-live diff scenarios', () => {
  for (const fixture of snapshotDiffRoutes) {
    assert.deepEqual(
      diffReviewSnapshot(fixture.snapshot, fixture.live),
      fixture.expected,
      fixture.name,
    );
  }
});

// #1693: parseReviewWatermarkComment's `i` flag accepts an uppercase-hex
// head SHA (the documented manual hand-composed fallback path), but used to
// return it verbatim. diffReviewSnapshot's very first check is an exact
// string comparison of the watermark's headSha against the live head
// (always lowercase -- see protocol-helpers.mts's own prHeadSha validation
// upstream), so a hand-composed uppercase watermark parsed as valid yet
// never satisfied that check: every F2 pass reported `head-changed` and
// looped back to E1, even though the head genuinely had not moved. This is
// the two-layer proof the fix actually closes that loop: not just that the
// parser lowercases (a parser-only assertion would not prove the F2 gate
// itself is satisfied), but that the full resolveLatestReviewWatermark ->
// diffReviewSnapshot round trip no longer routes to head-changed for the
// same head.
test('an uppercase-authored review-watermark satisfies the F2 currency check for the same head', () => {
  const lowerSha = 'a'.repeat(40);
  const upperSha = lowerSha.toUpperCase();
  const watermarkBody = [
    `<!-- review-watermark: claude-x claim-1 ${upperSha} none 0 none -->`,
    '',
    '_claude-x: review triage snapshot — IDD automation marker. Do not edit._',
  ].join('\n');

  const watermark = resolveLatestReviewWatermark(
    [
      {
        author: { login: 'claude-x' },
        body: watermarkBody,
        createdAt: '2026-05-10T00:00:00Z',
      },
    ],
    { expectedClaimId: 'claim-1', isTrustedAuthor: () => true },
  );

  assert.ok(watermark, 'expected the uppercase-SHA watermark to parse');
  // The parser must normalize the case-insensitively matched SHA to
  // lowercase before it ever reaches diffReviewSnapshot's exact comparison.
  assert.equal(watermark?.headSha, lowerSha);

  const route = diffReviewSnapshot(
    {
      headSha: watermark?.headSha,
      maxActivityUpdatedAt: watermark?.maxActivityUpdatedAt,
      totalItemCount: watermark?.totalItemCount,
      latestCiCompletedAt: watermark?.latestCiCompletedAt,
    },
    {
      // Live head SHA is always lowercase (upstream validation in this
      // file requires it); the bug this test guards against is the
      // watermark side failing to match it after a hand-composed
      // uppercase post.
      headSha: lowerSha,
      maxActivityUpdatedAt: 'none',
      totalItemCount: 0,
      latestCiCompletedAt: 'none',
    },
  );

  assert.equal(route.route, 'proceed');
  assert.notEqual(route.reason, 'head-changed');
});

test('classifies unresolved threads for awaiting-reviewer and conversation-resolution gates', () => {
  for (const fixture of threadGateRoutes) {
    assert.deepEqual(
      summarizeReviewThreadsForGate(fixture.threads, fixture.options),
      fixture.expected,
      fixture.name,
    );

    if (fixture.threads.length === 1) {
      const expectedClassification =
        fixture.expected.classifications[0]?.classification ?? 'resolved';
      assert.equal(
        classifyReviewThreadForGate(fixture.threads[0], fixture.options)
          .classification,
        expectedClassification,
        `${fixture.name} single-thread classification`,
      );
    }
  }
});

// #2251: a review-watermark/review-baseline-shaped comment that fails the
// strict canonical `pattern` already reads as absent to
// resolveLatestReviewWatermark (its own `parseReviewWatermarkComment` call
// returns null and the loop `continue`s past it) -- these three cases prove
// detectMalformedReviewWatermarkComments lets a caller tell "malformed
// marker found" apart from "no watermark-shaped comment at all" without
// resolveLatestReviewWatermark's own selection behavior changing.
test('detects a review-watermark comment whose note is glued to the leading underscore as malformed, not absent', () => {
  // OPTIONAL_IDD_VISIBLE_NOTE_PATTERN requires `\bIDD\b`; `_` is a \w
  // character, so a note glued directly to the underscore with no space
  // (`_IDD ...`) never satisfies the boundary and the whole body fails the
  // canonical `pattern` even though its marker prefix is well-formed.
  const gluedNoteBody = [
    `<!-- review-watermark: claude-x claim-1 ${'a'.repeat(40)} none 0 none -->`,
    '_IDD note glued directly to the leading underscore, no space before it_',
  ].join('\n');
  const comments = [
    {
      author: { login: 'claude-x' },
      body: gluedNoteBody,
      createdAt: '2026-05-10T00:00:00Z',
    },
  ];

  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: 'claim-1',
    isTrustedAuthor: () => true,
  });
  assert.equal(
    watermark,
    null,
    'a malformed watermark comment must not parse as a valid watermark',
  );
  assert.equal(
    detectMalformedReviewWatermarkComments(comments, {
      isTrustedAuthor: () => true,
    }),
    true,
    'the malformed marker must be distinguishable from a genuinely absent one',
  );
});

test('does not flag a genuinely valid review-watermark comment as malformed', () => {
  const validBody = `<!-- review-watermark: claude-x claim-1 ${'a'.repeat(40)} none 0 none -->`;
  const comments = [
    {
      author: { login: 'claude-x' },
      body: validBody,
      createdAt: '2026-05-10T00:00:00Z',
    },
  ];

  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: 'claim-1',
    isTrustedAuthor: () => true,
  });
  assert.ok(watermark, 'a well-formed watermark must still parse as before');
  assert.equal(
    detectMalformedReviewWatermarkComments(comments, {
      isTrustedAuthor: () => true,
    }),
    false,
    'a valid watermark comment must never be reported as malformed',
  );
});

test('reports no malformed marker when no watermark-shaped comment exists at all', () => {
  const comments = [
    {
      author: { login: 'claude-x' },
      body: 'just an ordinary regular comment, not marker-shaped at all',
      createdAt: '2026-05-10T00:00:00Z',
    },
  ];

  const watermark = resolveLatestReviewWatermark(comments, {
    expectedClaimId: 'claim-1',
    isTrustedAuthor: () => true,
  });
  assert.equal(watermark, null);
  assert.equal(
    detectMalformedReviewWatermarkComments(comments, {
      isTrustedAuthor: () => true,
    }),
    false,
    'a genuinely absent watermark must stay distinct from a malformed one',
  );
});
