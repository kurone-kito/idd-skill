import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActivitySnapshotSummary,
  summarizeDispositionEvidenceForGate,
} from '../src/scripts/protocol-helpers.mts';

// #2014: `buildActivitySnapshotSummary` (the `reviewCurrency` producer) and
// `summarizeDispositionEvidenceForGate` (the `dispositionEvidence` producer)
// both classify a post-disposition advisory-bot reply as "ack-only", but used
// to compute that classification with structurally different logic that could
// disagree on the identical PR state. This file exercises both producers
// side-by-side against the same thread fixture and asserts they agree.
//
// Two of the four reported asymmetries are fixed here (see the PR body for
// the other two, left as intentional scope differences):
//   1. Anchor-set asymmetry -- an advisory bot must never anchor "a
//      disposition exists" in either producer (`buildActivitySnapshotSummary`
//      already subtracted `advisoryBotLogins` from its disposition-author
//      set; `summarizeDispositionEvidenceForGate`'s ack-only anchor did not).
//   2. Marker-recognition asymmetry -- the terminal
//      `**Rejection confirmed by maintainer**` disposition
//      (`isRejectionConfirmedDisposition`) must be recognized by both
//      producers' ack-only anchors, not just `summarizeDispositionEvidenceForGate`'s.

test('reviewCurrency and dispositionEvidence agree a shared advisory/IDD-agent login cannot anchor a disposition (#2014)', () => {
  // `dual-bot` is configured as BOTH a trusted IDD-agent/marker login AND an
  // advisory-bot login (a plausible overlap, e.g. a shared automation
  // account) -- its own `**Accepted**` reply must not anchor "a disposition
  // exists" for the ack-only classifier in either producer, so a genuine
  // advisory bot's later courtesy reply still counts as real new activity
  // that keeps the thread blocking.
  const thread = {
    id: 'thread-dual-bot-anchor',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TC-1',
          author: { login: 'reviewer-a' },
          body: 'please double check this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'TC-2',
          author: { login: 'dual-bot' },
          body: '**Accepted** — looks fine.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TC-3',
          author: { login: 'coderabbitai[bot]' },
          body: 'Thanks for confirming.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const dispositionSummary = summarizeDispositionEvidenceForGate(
    { comments: [], threads: [thread] },
    {
      iddAgentLogins: ['dual-bot'],
      advisoryBotLogins: ['dual-bot', 'coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );
  const activitySummary = buildActivitySnapshotSummary(
    { comments: [], reviews: [], threads: [thread], checks: [] },
    {
      trustedMarkerLogins: ['dual-bot'],
      advisoryBotLogins: ['dual-bot', 'coderabbitai[bot]'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['dual-bot'],
    },
  );

  // dispositionEvidence: the thread still blocks -- `dual-bot`'s own reply
  // cannot count as a disposition anchor once it is also an advisory bot.
  assert.equal(dispositionSummary.route, 'return-to-e1');
  assert.equal(dispositionSummary.blockingCount, 1);
  assert.equal(
    dispositionSummary.missingThreads[0].reason,
    'missing-fresh-disposition',
  );
  assert.equal(
    dispositionSummary.missingThreads[0].ackOnlyPostDisposition,
    false,
  );
  assert.equal(dispositionSummary.soleCauseAckOnlyPostDisposition, false);

  // reviewCurrency: agrees -- CodeRabbit's reply is genuine new activity,
  // not an ack-only courtesy reply, since there is no valid anchor either.
  assert.deepEqual(activitySummary.ackOnly.items, []);
  assert.equal(
    activitySummary.effective.maxActivityUpdatedAt,
    '2026-05-12T02:00:00Z',
  );
});

test('reviewCurrency and dispositionEvidence agree a rejection-confirmed-by-maintainer reply anchors post-disposition acks (#2014)', () => {
  // The AMD -> maintainer-agrees flow posts `**Rejection confirmed by
  // maintainer**` instead of a fresh `**Rejected**` re-post
  // (idd-review-triage.instructions.md E6). Both producers must recognize it
  // as a real disposition anchor, or the advisory bot's later courtesy reply
  // is misclassified as new blocking activity by whichever producer misses
  // the marker.
  const thread = {
    id: 'thread-rejection-confirmed',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'RC-1',
          author: { login: 'reviewer-a' },
          body: 'please reconsider this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'RC-2',
          author: { login: 'idd-bot' },
          body: '**Rejection confirmed by maintainer** — agreed, no action needed.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'RC-3',
          author: { login: 'coderabbitai[bot]' },
          body: 'Thanks for confirming.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const dispositionSummary = summarizeDispositionEvidenceForGate(
    { comments: [], threads: [thread] },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      snapshotBoundaryAt: '2026-05-12T01:00:00Z',
    },
  );
  const activitySummary = buildActivitySnapshotSummary(
    { comments: [], reviews: [], threads: [thread], checks: [] },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['idd-bot'],
    },
  );

  // dispositionEvidence already recognized the marker before this fix.
  assert.equal(dispositionSummary.route, 'return-to-e1');
  assert.equal(dispositionSummary.blockingCount, 1);
  assert.equal(
    dispositionSummary.missingThreads[0].reason,
    'missing-fresh-disposition',
  );
  assert.equal(
    dispositionSummary.missingThreads[0].ackOnlyPostDisposition,
    true,
  );
  assert.equal(dispositionSummary.soleCauseAckOnlyPostDisposition, true);

  // reviewCurrency now agrees: CodeRabbit's reply is ack-only, so it is
  // excluded from the effective (blocking) activity timestamp.
  assert.deepEqual(
    activitySummary.ackOnly.items.map((item) => [item.kind, item.id]),
    [['thread-reply', 'RC-3']],
  );
  assert.equal(activitySummary.maxActivityUpdatedAt, '2026-05-12T02:00:00Z');
  assert.equal(
    activitySummary.effective.maxActivityUpdatedAt,
    '2026-05-12T00:30:00Z',
  );
});
