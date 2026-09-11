import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActivitySnapshotSummary,
  classifyThreadAckOnlyPostDisposition,
  EDITED_AFTER_DISPOSITION_HINT,
  MALFORMED_DISPOSITION_PREFIX_HINT,
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
          body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
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

// #2696: this gate-level function already read `thread.id` correctly before
// this issue's fix -- the actual bug was upstream (the provider mapping and
// both `normalizeThread` call sites dropped `id` before it reached here; see
// those files' own test coverage for the real regression guards). This test
// pins the AC's explicit requirement directly at this layer: report the real
// thread id whenever the caller supplies one, and fall back to a positional
// `thread-${index+1}` label only when it genuinely has none.
test('summarizeDispositionEvidenceForGate reports the real thread id when present, and the positional fallback only when absent', () => {
  const threadWithRealId = {
    id: 'RT_real_123',
    isResolved: false,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: 'reviewer-a' },
          body: 'please address this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
  };
  const threadWithNoId = {
    isResolved: false,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          author: { login: 'reviewer-b' },
          body: 'and this one too',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
      ],
    },
  };

  const dispositionSummary = summarizeDispositionEvidenceForGate(
    { comments: [], threads: [threadWithRealId, threadWithNoId] },
    { iddAgentLogins: [], advisoryBotLogins: [] },
  );

  assert.equal(dispositionSummary.blockingCount, 2);
  assert.equal(dispositionSummary.missingThreads[0].id, 'RT_real_123');
  assert.equal(dispositionSummary.missingThreads[1].id, 'thread-2');
});

// #2618: `classifyThreadAckOnlyPostDisposition` extracted out of
// `summarizeDispositionEvidenceForGate` into a standalone export so F4's
// `audit-pr-cleanup.mts` (no review-snapshot watermark) can share it with
// F2/F3's gate (`snapshotBoundaryAt` supplied). These tests exercise the
// function directly rather than through the gate, in the F4 shape: no
// `snapshotBoundaryAt`.

test('classifyThreadAckOnlyPostDisposition recognizes a courtesy ack with no snapshot boundary (#2618)', () => {
  const thread = {
    id: 'thread-f4-ack-only',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'F4-1',
          author: { login: 'reviewer-a' },
          body: 'please fix this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'F4-2',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'F4-3',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects a non-advisory trailing reply (#2618)', () => {
  const thread = {
    id: 'thread-f4-human-reply',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'F4H-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'F4H-2',
          author: { login: 'reviewer-a' },
          body: 'actually, one more thing',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition fails closed on a genuinely missing disposition (#2618)', () => {
  const thread = {
    id: 'thread-f4-no-disposition',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'F4N-1',
          author: { login: 'reviewer-a' },
          body: 'please fix this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'F4N-2',
          author: { login: 'coderabbitai[bot]' },
          body: 'Thanks for confirming!',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition still honors an explicit snapshot boundary (regression guard, #2618)', () => {
  // Same shape `summarizeDispositionEvidenceForGate`'s own #2014 test above
  // exercises through the gate; this confirms the extracted function keeps
  // the F2/F3 boundary behavior when a caller supplies one.
  const thread = {
    id: 'thread-f2-boundary',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'F2B-1',
          author: { login: 'idd-bot' },
          body: '**Rejection confirmed by maintainer** — agreed, no action needed.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'F2B-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  // The bot's reply predates the boundary, so it never re-blocks the gate.
  const beforeBoundary = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
    snapshotBoundaryAt: '2026-05-12T03:00:00Z',
  });
  assert.equal(beforeBoundary.ackOnlyPostDisposition, false);

  const afterBoundary = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
    snapshotBoundaryAt: '2026-05-12T01:00:00Z',
  });
  assert.equal(afterBoundary.ackOnlyPostDisposition, true);
});

// #2641: `classifyThreadAckOnlyPostDisposition` now additionally requires
// the post-disposition reply to match a known courtesy-acknowledgment
// template (derived from actually-observed CodeRabbit replies in this
// repository's own merged-PR history), not just author + shape.

test('classifyThreadAckOnlyPostDisposition still recognizes a known-template courtesy ack (#2641)', () => {
  const thread = {
    id: 'thread-known-template-ack',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'KT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'KT-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. The fix addresses the finding.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition recognizes "acknowledged" as a courtesy-ack opening verb (kurone-kito/idd-skill#2657, PR #2895, round 17)', () => {
  // Freshly observed on PR #2895 itself: CodeRabbit's reply opened with
  // "`@kurone-kito`, acknowledged. ..." -- the same confirmation/dismissal
  // opener class the "thanks/confirmed/agreed" verbs already cover, just a
  // synonym the original 18-sample derivation did not happen to include.
  const thread = {
    id: 'thread-acknowledged-ack',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'ACK-1',
          author: { login: 'idd-bot' },
          body: '**Rejected** — reaffirming.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'ACK-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, acknowledged. The whole-file allowlist policy is deliberate and applies across helper-runtime profiles. This finding remains withdrawn.\n\n🐇\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects a novel substantive reply that merely avoids disposition phrasing (#2641)', () => {
  // A brand-new finding that happens not to be shaped like
  // `**Accepted**`/`**Rejected**` must not misclassify as ack-only just
  // because the author is a configured advisory bot -- it also fails the
  // known-template match (no `` `@login` `` confirmation lead-in, no
  // CodeRabbit closing signature), so it stays genuine blocking activity.
  const thread = {
    id: 'thread-novel-non-template-reply',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NT-2',
          author: { login: 'coderabbitai[bot]' },
          body: 'Actually, this also affects the retry path -- see line 42.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition fails closed for a reply with no known template, even from a configured advisory bot (#2641)', () => {
  // `chatgpt-codex-connector` has no observed courtesy-ack template in this
  // repository's history (#2641's own research): its replies never report
  // CodeRabbit's own thread-resolve closure (e.g. "✅ Review thread
  // resolved." / "I couldn't resolve..."), so even a superficially
  // ack-shaped opening does not match `isKnownAdvisoryAckTemplate` -- fail
  // closed rather than guess at an unobserved shape. No author check is
  // needed here: any configured advisory bot is eligible, but only a reply
  // that actually reports CodeRabbit's own resolution decision can satisfy
  // the closure half.
  const thread = {
    id: 'thread-unrecognized-bot-ack',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'UB-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'UB-2',
          author: { login: 'chatgpt-codex-connector' },
          body: '`@kurone-kito`, confirmed. Thanks for the fix.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a confirmation-shaped reply that raises a new unresolved concern and carries no closure signal (Codex P1 round 1, PR #2649)', () => {
  // A reply can open with a confirmation word and still carry
  // CodeRabbit-flavored text (the auto-generated-reply marker) while
  // raising a genuinely new, unresolved concern -- but CodeRabbit does not
  // report resolving the thread on a reply like this, so it carries no
  // closure signal either.
  const thread = {
    id: 'thread-ack-with-new-concern',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NC-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NC-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. The first case is fixed, but the ' +
            'retry path still dereferences null; please address it.\n\n' +
            '<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a confirmation-shaped reply that raises a new concern but still carries the reply marker (Codex P1 round 2, PR #2649)', () => {
  // A round-2 adversarial example (#2649): an enumerated "disqualifying"
  // keyword blocklist tried between rounds missed this phrasing entirely
  // ("one more issue" contains none of the blocklisted words). The
  // closure-signal design catches it directly instead: CodeRabbit's
  // auto-generated-reply marker alone is not a closure signal, and this
  // reply reports no thread-resolve attempt.
  const thread = {
    id: 'thread-ack-with-new-concern-round-2',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NC2-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NC2-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. One more issue: the retry path ' +
            'dereferences null.\n\n' +
            '<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition recognizes a courtesy ack with the marker-first reply ordering (Codex P2, PR #2649)', () => {
  // CodeRabbit's other marker-led reply form places
  // CODERABBIT_AUTO_GENERATED_REPLY_MARKER before the `@login` mention; a
  // courtesy ack using that same ordering must not be missed just because
  // the opening pattern otherwise anchors on the mention.
  const thread = {
    id: 'thread-marker-first-ack',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MF-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MF-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '<!-- This is an auto-generated reply by CodeRabbit -->\n\n' +
            '`@kurone-kito`, confirmed. Looks good.\n\n' +
            '✅ Review thread resolved.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects a reply carrying only the 🐇 emoji with no closure signal (Copilot, PR #2649)', () => {
  // The bare emoji alone is not CodeRabbit's resolution decision -- any
  // configured advisory bot could in principle include it, so it must not
  // by itself satisfy the closure requirement.
  const thread = {
    id: 'thread-emoji-only',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'EO-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'EO-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n🐇 ✅',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a non-CodeRabbit bot reply that happens to match the opening and closure phrases (Copilot round 4, PR #2649)', () => {
  // The closure phrase is CodeRabbit's own resolution decision in
  // practice, but it is still literal text; a differently-configured
  // advisory bot emitting the identical text must not be misclassified as
  // ack-only just because the content happens to match. The author must
  // specifically be CodeRabbit (`isCodeRabbitLogin`), on top of the
  // content-based signals, not instead of them.
  const thread = {
    id: 'thread-non-coderabbit-author',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NR-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NR-2',
          author: { login: 'chatgpt-codex-connector' },
          body:
            '`@kurone-kito`, confirmed. Thanks for the fix.\n\n' +
            '✅ Review thread resolved.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

// #2858: the "I couldn't resolve..." fallback closure shape (added in
// #2649 alongside "✅ Review thread resolved.") had no positive regression
// test of its own -- only a comment referenced it. Pin it directly.
test('classifyThreadAckOnlyPostDisposition recognizes the "I couldn\'t resolve" fallback closure shape (#2649, regression added #2858)', () => {
  const thread = {
    id: 'thread-resolve-attempt-failed',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'RF-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'RF-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. Thanks for the fix.\n\n' +
            "I couldn't resolve this review thread on the repository platform. " +
            'Please resolve it manually.\n\n' +
            '<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

// #2858: a third ack shape with no closure trailer at all -- observed
// verbatim on kurone-kito/idd-skill#2853's review thread on the
// issue-reference template link (fetched via GraphQL for byte-exact
// fixtures, boilerplate included: the 🐇 sign-off, the "Learnings used"
// details block, the AI-system disclaimer, and the auto-generated-reply
// marker at the END of the body rather than the start). CodeRabbit
// reports no thread-resolve attempt because the thread was already
// resolved independently before it replied.
test('classifyThreadAckOnlyPostDisposition recognizes the "addresses the ... concern" closure shape with a trailing sign-off (kurone-kito/idd-skill#2853, #2858)', () => {
  const thread = {
    id: 'thread-addresses-concern-with-signoff',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'AC-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'AC-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. The repository-qualified reference addresses the template link-resolution concern.\n\n🐇 ✓\n\n---\n\n<details>\n<summary>🧠 Learnings used</summary>\n\n```\nLearnt from: kurone-kito\nRepo: kurone-kito/idd-skill PR: 1738\nFile: idd-template/docs/idd-design-rationale.md:137-139\nTimestamp: 2026-07-31T13:33:10.518Z\nLearning: In idd-template/docs/, markdown files (particularly idd-design-rationale.md) use structure-mode synchronization via audit/sync-manifest.json, which validates heading signatures only while allowing intentional prose differences. When documenting in template files, use fully qualified issue references (kurone-kito/idd-skill#<number>) to ensure links resolve correctly in adopter repositories. Source repository documentation (docs/) can use bare references (#<number>). Structure-mode validation ensures heading structures match across template and source versions while permitting different reference styles and prose content.\n```\n\n</details>\n\n_You are interacting with an AI system._\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-09-10T05:01:11Z',
          updatedAt: '2026-09-10T05:01:11Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition recognizes the "addresses the ... finding" closure shape with no sign-off at all (kurone-kito/idd-skill#2853, #2858)', () => {
  const thread = {
    id: 'thread-addresses-finding-no-signoff',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'AF-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'AF-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. Commit `80c936a7` addresses the template issue-reference finding.\n\n---\n\n<details>\n<summary>🧠 Learnings used</summary>\n\n```\nLearnt from: kurone-kito\nRepo: kurone-kito/idd-skill PR: 1738\nFile: idd-template/docs/idd-design-rationale.md:137-139\nTimestamp: 2026-07-31T13:33:10.518Z\nLearning: In idd-template/docs/, markdown files (particularly idd-design-rationale.md) use structure-mode synchronization via audit/sync-manifest.json, which validates heading signatures only while allowing intentional prose differences. When documenting in template files, use fully qualified issue references (kurone-kito/idd-skill#<number>) to ensure links resolve correctly in adopter repositories. Source repository documentation (docs/) can use bare references (#<number>). Structure-mode validation ensures heading structures match across template and source versions while permitting different reference styles and prose content.\n```\n\n</details>\n\n_You are interacting with an AI system._\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-09-10T05:27:25Z',
          updatedAt: '2026-09-10T05:27:25Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects the "addresses the ... concern" shape when "concern" sits more than 3 modifier tokens away, in the SAME sentence, immediately before genuine boilerplate (Copilot review, #2858; token-count bound since Codex round 7)', () => {
  // Locality guard: the third closure shape's internal gap is bounded so
  // a "concern"/"finding" mention too far from "addresses the" does not
  // create a false closure signal. Originally an 80-character bound;
  // Codex's round 7 replaced it with a 3-modifier-token cap (see the doc
  // comment above `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE`), so this fixture
  // now uses 4 plain noun-phrase tokens -- one over the cap -- rather
  // than an unrealistic 45-token filler, to exercise the actual boundary
  // instead of an arbitrary excess. Copilot's original review on this
  // test flagged that its first version put "finding" in a different
  // sentence with no boilerplate anywhere, so it failed for those two
  // reasons regardless of the distance bound, never actually exercising
  // it. This fixture keeps "concern" in the SAME sentence (no `.!?`
  // between them, so the sentence-boundary guard does not fire) and adds
  // genuine boilerplate immediately after it (so the boilerplate-tail
  // guard does not fire either) -- the over-cap token count is the only
  // remaining reason this must still be rejected.
  const thread = {
    id: 'thread-addresses-far-from-concern',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'FA-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'FA-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the very ' +
            'long compound noun concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects an "addresses the ... concern" opening that goes on to raise a new, unrelated concern in the same sentence span (#2858)', () => {
  // AC3 (issue #2858): "A CodeRabbit reply that is *not* a pure
  // acknowledgment (contains substantive new content) still does not
  // match." The closure sentence must end in a period immediately
  // followed by known CodeRabbit reply boilerplate (or end of body) --
  // a genuinely new concern appended after a comma, rather than a
  // period, never reaches that tail check, even though "concern" is
  // well within the 3-modifier-token gap bound the sibling test above
  // exercises (the comma itself also breaks the token chain outright,
  // since round 7 restricted gap tokens to `[\w-]+`). CodeRabbit's
  // round-4 review on PR #2868 found the original fixture used
  // "partially addresses," so the hedge-adverb guard (guard 5) rejected
  // it before ever reaching the tail check this test is meant to
  // exercise -- the assertion held, but not for the stated reason.
  // Dropped "partially" so the tail check (guard 3) is what actually
  // rejects this fixture, matching the test's own claim.
  const thread = {
    id: 'thread-addresses-concern-but-new-issue',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'CN-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'CN-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the ' +
            'concern, but the retry path still dereferences null.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects an "addresses the ... concern" opening followed by a genuinely new sentence, even with a period boundary (#2858)', () => {
  // A stricter adversarial variant than the comma-joined case above: the
  // closure sentence properly ends in a period, but is followed by a new
  // sentence of ordinary prose ("However, ...") rather than CodeRabbit's
  // own reply boilerplate. The tail anchor requires known boilerplate (or
  // end of body) immediately after that period, so this still does not
  // match -- pinning the doc comment's claim that the tail anchor closes
  // this shape too, not only the comma-joined one.
  const thread = {
    id: 'thread-addresses-concern-new-sentence',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'CS-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'CS-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the retry-path ' +
            'concern. However, the null-check issue in the fallback ' +
            'branch is still unresolved.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

// Codex review findings on PR #2868 (fixing issue #2858), both verified
// against source before accepting: a legitimate structural gap, not the
// semantic "new concern" phrasing this file already documents as out of
// scope.

test('classifyThreadAckOnlyPostDisposition rejects a hedged closure sentence with no trailing boilerplate at all (Codex P1, #2858)', () => {
  // Codex's exact adversarial example: a single-sentence reply --
  // "confirmed. This partially addresses the concern." -- with nothing
  // following it. Every sampled real reply (20/20) carries genuine
  // trailing boilerplate, so the tail anchor no longer accepts a bare
  // end-of-body as a substitute; a hedged, non-committal acknowledgment
  // with no footer at all must not pass on structure alone.
  const thread = {
    id: 'thread-hedged-no-boilerplate',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'HN-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'HN-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. This partially addresses the concern.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a genuinely new concern in a second sentence, even though "concern" itself is not in the first sentence (Codex P1, #2858)', () => {
  // Codex's second adversarial example: "This addresses the requested
  // change. However, I still have a concern." -- the first sentence has
  // no "concern"/"finding" word at all, so an un-narrowed gap could still
  // reach the word "concern" in the unrelated SECOND sentence, since
  // nothing stopped it from skipping the period in between. The gap must
  // exclude sentence-terminating punctuation so "concern"/"finding" is
  // required to appear in the SAME sentence as "addresses the".
  const thread = {
    id: 'thread-cross-sentence-unrelated-concern',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'CX-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'CX-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the requested ' +
            'change. However, I still have a concern.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a hedged "partially addresses" closure sentence even with genuine trailing boilerplate (Codex P1 round 2, #2858)', () => {
  // Codex's round-2 finding: the round-1 fixes (sentence-boundary gap,
  // mandatory boilerplate tail) do not by themselves catch a hedge
  // adverb inside the matched sentence -- "confirmed. This partially
  // addresses the concern.\n\n🐇 ✓" has genuine boilerplate immediately
  // following and never crosses a sentence boundary, so it still passed
  // both round-1 guards. The hedge-adverb guard closes this specific,
  // demonstrated case.
  const thread = {
    id: 'thread-hedged-with-boilerplate',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'HB-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'HB-2',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. This partially addresses the concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a same-sentence "addresses the X but reveals another Y" construction (Codex P1 round 3, #2858)', () => {
  // Codex's round-3 finding: a plain lazy gap could still backtrack past
  // an EARLIER "concern"/"finding" occurrence that failed the
  // boilerplate-tail check, to match a LATER one that succeeds --
  // "confirmed. This addresses the original concern but reveals another
  // finding.\n\n🐇 ✓" has a genuinely new finding joined by "but" in the
  // same sentence, yet the gap could stretch past the first "concern"
  // (not followed by a period) to reach "finding." instead. The gap is
  // now pinned to the FIRST "concern"/"finding" occurrence via a
  // per-character negative lookahead, so this must still be rejected.
  const thread = {
    id: 'thread-addresses-but-reveals-another',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'BR-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'BR-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the original ' +
            'concern but reveals another finding.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition still recognizes a strong "Review thread resolved" closure even when unrelated boilerplate elsewhere contains hedge-shaped wording (Copilot round 3, #2858)', () => {
  // Copilot's round-3 finding on the round-2 hedge-adverb fix: the guard
  // originally tested the WHOLE body, so a genuinely strong closure
  // ("Review thread resolved.") could be wrongly rejected if unrelated
  // trailing boilerplate -- such as a Learnings-used block quoting a
  // past PR's discussion -- happened to contain phrasing like "partially
  // addresses the concern." The hedge-adverb guard is now a lookbehind
  // scoped to only the weaker "addresses the ..." alternative, so it
  // never reaches the two strong forms at all.
  const thread = {
    id: 'thread-strong-closure-with-unrelated-hedge-text',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'SH-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'SH-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed.\n\n✅ Review thread resolved.\n\n' +
            '<details><summary>🧠 Learnings used</summary>\n' +
            'Learning: a past reviewer noted that this pattern only ' +
            'partially addresses the concern in an unrelated PR.\n' +
            '</details>',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects an "addresses the ... concern" closure separated from the opening by an intervening unresolved sentence (Codex round 4, #2858)', () => {
  // Codex's round-4 finding on PR #2868: every guard on
  // `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE` narrows what counts as a
  // closure WITHIN a matched span, but neither closure regex was ever
  // anchored to where the opening ends -- `.test(body)` searches the
  // WHOLE body, so a genuinely new, unresolved concern in its OWN
  // sentence between the opening and the closure was invisible. This is
  // Codex's exact adversarial example: an explicit "remains unresolved"
  // sentence sits between "confirmed." and the closure sentence that
  // follows it. Originally caught by a terminator-count bound (two
  // periods instead of one); round 5 replaced that with the positive
  // lead-in whitelist below, which rejects this fixture too -- "However"
  // is not one of the whitelisted lead-in shapes.
  const thread = {
    id: 'thread-addresses-concern-after-unresolved-sentence',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'AU-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'AU-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. However, the null-check remains ' +
            'unresolved. The documentation update addresses the ' +
            'wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects an unresolved clause joined to the closure with a semicolon instead of a second sentence terminator (Codex round 5, #2868)', () => {
  // Codex's round-5 finding on PR #2868: the round-4 terminator-count
  // bound (at most one `.`/`!`/`?` between opening and closure) is a
  // NEGATIVE bound -- defined by what the gap must NOT contain -- and
  // natural language can join an unresolved clause to the closure
  // without a second terminator at all. A semicolon leaves the count at
  // exactly one and would have passed round 4's guard. The positive
  // lead-in whitelist rejects this outright: "The null-check remains
  // unresolved" is not one of the whitelisted lead-in shapes.
  const thread = {
    id: 'thread-addresses-concern-after-semicolon-clause',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'SC-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'SC-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The null-check remains unresolved; ' +
            'this update addresses the wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects an unresolved clause joined to the closure with an em dash (regression guard, #2858)', () => {
  // Same class as the semicolon case above, demonstrating the lead-in
  // whitelist closes the general "unbounded joining punctuation" gap
  // rather than just the one punctuation mark Codex happened to probe.
  const thread = {
    id: 'thread-addresses-concern-after-em-dash-clause',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'ED-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'ED-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The null-check remains unresolved ' +
            '— this update addresses the wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects an unresolved clause joined to the closure with a bare coordinating conjunction (regression guard, #2858)', () => {
  // A third joining shape with no punctuation at all between the
  // opening's period and the closure's lead-in -- confirms the
  // whitelist fails closed on arbitrary lead-in text, not just on
  // specific joining punctuation.
  const thread = {
    id: 'thread-addresses-concern-after-and-conjunction',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'AC5-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'AC5-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. Still broken and this addresses the ' +
            'concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects genuinely new feedback appended right after the "---" boilerplate marker (Codex round 6, #2868)', () => {
  // Codex's round-6 finding on PR #2868: the boilerplate-tail alternation
  // validated only the FIRST recognized token ("---", in this example)
  // and accepted whatever followed it unexamined -- a prefix match, the
  // same "validated a fragment, not the whole shape" bug rounds 4-5
  // already closed on the opening side. This is Codex's exact
  // adversarial example.
  const thread = {
    id: 'thread-addresses-concern-then-prose-after-rule',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TT-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the wording ' +
            'concern.\n\n---\n\nHowever, the null-check remains ' +
            'unresolved.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects genuinely new feedback appended right after the 🐇 sign-off with no separating boilerplate (regression guard, #2858)', () => {
  // Same class as the "---" case above, for the sign-off marker
  // specifically: the tail grammar must require the ENTIRE remainder to
  // be one of the known trailing shapes, not just start with one.
  const thread = {
    id: 'thread-addresses-concern-then-prose-after-signoff',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TS-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TS-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the wording concern.' +
            '\n\n🐇 ✓ However, the null-check remains unresolved.',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects genuinely new feedback sandwiched between two "<details>" blocks (regression guard, #2858)', () => {
  // The details-block sub-pattern forbids consuming past the first
  // "</details>" via a per-character negative lookahead, so it stops at
  // the first "</details>" rather than the last -- confirms a second,
  // unrelated details block later in the tail cannot be used to smuggle
  // prose past the match by making the whole tail look like "one
  // details block" when it is actually two with substantive text between
  // them.
  const thread = {
    id: 'thread-addresses-concern-then-prose-between-details',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TD-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TD-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the wording ' +
            'concern.\n\n---\n\n<details>\n<summary>foo</summary>\n' +
            '</details>\n\nHowever, the null-check remains ' +
            'unresolved.\n\n<details>\n<summary>bar</summary>\n' +
            '</details>',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a coordinating conjunction that swaps in a genuinely different, unaddressed concern (Codex round 7, #2868)', () => {
  // Codex's round-7 finding on PR #2868: the internal gap between
  // "addresses the" and "concern"/"finding" had no positive shape at
  // all -- only "not a period, not concern/finding, within 80 chars" --
  // so a coordinating conjunction could silently swap the addressed
  // topic for a genuinely different one, with only ONE "concern"
  // occurrence (so guard 4's no-backtrack protection never engages) that
  // is immediately followed by genuine boilerplate. This is Codex's
  // exact adversarial example.
  const thread = {
    id: 'thread-addresses-but-leaves-different-concern',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'BL-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'BL-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the documentation ' +
            'issue but leaves a security concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a hedge word hidden inside the internal gap rather than immediately before "addresses" (regression guard, #2858)', () => {
  // The hedge lookbehind only inspects the text immediately preceding
  // "addresses" -- without also excluding hedge words from the internal
  // gap's own token set, "addresses the partially resolved concern"
  // would hide the same hedge inside the gap and bypass the lookbehind
  // entirely. Each gap token is checked against the same closed hedge
  // enumeration via a per-token negative lookahead.
  const thread = {
    id: 'thread-addresses-hedge-inside-gap',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'HG-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'HG-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the partially ' +
            'resolved concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a same-sentence "addresses the X concerns but reveals a new finding" construction using plural nouns (CodeRabbit round 4, #2858)', () => {
  // CodeRabbit's round-4 review on PR #2868: guard 4's per-character
  // negative lookahead only recognized the SINGULAR "concern"/"finding",
  // so a PLURAL first occurrence ("concerns") does not satisfy
  // `\b(?:concern|finding)\b` (no word boundary between "concern" and
  // its trailing "s") and the lookahead trivially succeeds there,
  // letting the gap consume straight through the plural occurrence to
  // reach a later singular one instead -- the same backtrack-past-the-
  // first-occurrence class guard 4 already closed for singular nouns,
  // reopened for plurals.
  const thread = {
    id: 'thread-addresses-plural-concerns-but-reveals-finding',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'PL-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'PL-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This addresses the original ' +
            'concerns but reveals another finding.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a hedged "partially  addresses" closure with a double space bypassing the hedge lookbehind (CodeRabbit round 4, #2858)', () => {
  // CodeRabbit's round-4 review on PR #2868: the hedge lookbehind ended
  // in a single `\s`, so two spaces between the hedge word and
  // "addresses" fell outside its fixed one-character gap and bypassed
  // the guard entirely. Widened to `\s+`.
  const thread = {
    id: 'thread-hedged-double-space-bypass',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'DS-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'DS-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, confirmed. This partially  addresses the ' +
            'concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a hedge adjective inside the lead-in noun phrase (self-critique, E2 pass, #2858)', () => {
  // E2 critique pass on this PR found the hedge-word exclusion added to
  // the internal "addresses the ... concern" gap never reached the
  // LEAD-IN's own "the" plus 1-2 word slots, since that whitelist was a
  // purely structural check. "The partial workaround addresses the
  // wording concern" matched despite "partial" being exactly the
  // hedged, non-committal shape the hedge guard exists to reject
  // elsewhere. The first attempted fix reused only the existing
  // degree-ADVERB enumeration and still let this through, since a
  // lead-in noun phrase's modifier is grammatically an ADJECTIVE
  // ("partial", "temporary") rather than an adverb ("partially") --
  // caught empirically before this ever reached review.
  const thread = {
    id: 'thread-leadin-hedge-adjective',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'LH-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'LH-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The partial workaround addresses ' +
            'the wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a second hedge adjective inside the lead-in noun phrase (self-critique, E2 pass, #2858)', () => {
  // Same class as above with a second word from the adjective
  // enumeration, confirming the fix is not overfit to "partial" alone.
  const thread = {
    id: 'thread-leadin-hedge-adjective-temporary',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'LT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'LT-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The temporary fix addresses the ' +
            'wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition safely rejects a first "addresses the ... concern" occurrence composed with a genuine second one (self-critique, E2 pass, #2858)', () => {
  // `CODERABBIT_ACK_ADDRESSES_CLOSURE_RE` is not left-anchored, so a
  // first "addresses the ... concern" occurrence that fails only the
  // boilerplate-tail check does not abort the whole match -- the engine
  // retries at a later "addresses" occurrence. This fixture confirms
  // the composition stays safe: the gap from the opening to the SECOND
  // occurrence spans an entire extra sentence ("The retry still
  // fails."), which the lead-in whitelist (guard 6) rejects. This pins
  // an interaction between two independently-motivated guards (the tail
  // anchor and the lead-in whitelist) that was previously untested in
  // combination.
  const thread = {
    id: 'thread-two-addresses-occurrences',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TO-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TO-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the layout concern. ' +
            'The retry still fails. Commit `abc1234` addresses the ' +
            'wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test("classifyThreadAckOnlyPostDisposition recognizes the tail grammar's disclaimer-only branch with no sign-off or details block (self-critique, E2 pass, #2858)", () => {
  // `CODERABBIT_ACK_CLOSURE_TAIL_SOURCE` is a 4-branch alternation; only
  // the full-stack and details-first branches had a positive test before
  // this. This pins the disclaimer-only entry point.
  const thread = {
    id: 'thread-tail-disclaimer-only',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TDO-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TDO-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the wording ' +
            'concern.\n\n_You are interacting with an AI system._',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test("classifyThreadAckOnlyPostDisposition recognizes the tail grammar's marker-only branch with no other boilerplate (self-critique, E2 pass, #2858)", () => {
  // Pins the fourth and final tail-grammar entry point: the bare
  // auto-generated-reply marker with nothing else following the closure.
  const thread = {
    id: 'thread-tail-marker-only',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TMO-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TMO-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the wording ' +
            'concern.\n\n<!-- This is an auto-generated reply by ' +
            'CodeRabbit -->',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition recognizes the lead-in whitelist\'s bare "that"/"it" pronoun branches (self-critique, E2 pass, #2858)', () => {
  // Every existing fixture using "This" as the lead-in pronoun is a
  // NEGATIVE test failing for an unrelated reason; "that" and "it"
  // appeared in no fixture at all. Pins both positively in one test.
  const thatThread = {
    id: 'thread-leadin-that-pronoun',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'PT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'PT-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. That addresses the wording ' +
            'concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };
  const itThread = {
    id: 'thread-leadin-it-pronoun',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'PI-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'PI-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. It addresses the wording ' +
            'concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const opts = {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  };
  assert.equal(
    classifyThreadAckOnlyPostDisposition(thatThread, opts)
      .ackOnlyPostDisposition,
    true,
  );
  assert.equal(
    classifyThreadAckOnlyPostDisposition(itThread, opts).ackOnlyPostDisposition,
    true,
  );
});

test('classifyThreadAckOnlyPostDisposition safely rejects the "Thanks for the fix." opening combined with the third closure shape (self-critique, E2 pass, #2858)', () => {
  // `CODERABBIT_ACK_OPENING_RE`'s own doc comment cites "Thanks for the
  // fix." as a real observed opening. Paired with the third-form
  // closure, this is rejected: the opening match stops right after
  // "Thanks", so the rest of that same sentence (" for the fix.") lands
  // inside the opening-to-closure gap and its leading whitespace breaks
  // the lead-in whitelist's `^[.!]` anchor. This fails CLOSED (safe) --
  // guard 6's own stated philosophy explicitly accepts rejecting an
  // unobserved-but-legitimate combination -- but pins the current,
  // intentional behavior so a future edit that changes it is a visible
  // decision, not a silent one.
  const thread = {
    id: 'thread-thanks-for-fix-plus-third-form',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TF-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'TF-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user` Thanks for the fix. Commit `abc1234` addresses ' +
            'the template concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a negation adverb immediately before "addresses" in the lead-in (Codex round 10, #2868)', () => {
  // Codex's round-10 finding on PR #2868: hedge words (guards 5, 7) say
  // something was done to a DEGREE; negation words say it was NOT done
  // at all -- a stronger inversion, not a hedging variant. "The fix
  // never addresses the security concern.\n\n🐇 ✓" matched: "never" sits
  // immediately before "addresses" the same way a hedge adverb would,
  // but neither hedge enumeration includes negation words, so every
  // guard passed it through untouched. This is Codex's exact
  // adversarial example.
  const thread = {
    id: 'thread-negation-never-addresses',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NV-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NV-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The fix never addresses the ' +
            'security concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a "no longer addresses" negation idiom immediately before "addresses" (regression guard, #2858)', () => {
  // Same class as the round-10 finding, with a different negation
  // member (the two-word idiom "no longer") to confirm the fix is not
  // overfit to "never" alone. Copilot's round-12 review flagged the
  // original version of this test: its fixture used "does not
  // addresses" (ungrammatical -- "does not address" is the correct verb
  // form), which placed the negation word immediately before the
  // literal "addresses" token this regex matches but did not read as
  // real English. "No longer addresses" is grammatical and exercises
  // the `no\s+longer` idiom directly.
  const thread = {
    id: 'thread-negation-no-longer-addresses',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'NT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'NT-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This no longer addresses the ' +
            'wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects "seldom" before the closure verb (Codex round 12, #2868)', () => {
  // Codex's round-12 finding on PR #2868: the initial negation
  // enumeration (round 10) omitted "seldom", a negative-frequency
  // adverb in the same class as "rarely"/"hardly" already covered. This
  // is Codex's exact adversarial example.
  const thread = {
    id: 'thread-negation-seldom-addresses',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'SL-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'SL-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. The fix seldom addresses the ' +
            'security concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects the "in no way" and "by no means" negation idioms (self-critique, same pass as round 12, #2858)', () => {
  // Widened alongside the "seldom" fix rather than waiting for each
  // idiom to surface as its own review round.
  const opts = {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  };
  const mkThread = (id: string, body: string) => ({
    id,
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: `${id}-1`,
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: `${id}-2`,
          author: { login: 'coderabbitai[bot]' },
          body,
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  });

  const inNoWay = mkThread(
    'thread-negation-in-no-way',
    '`@user`, confirmed. This in no way addresses the wording ' +
      'concern.\n\n🐇 ✓',
  );
  const byNoMeans = mkThread(
    'thread-negation-by-no-means',
    '`@user`, confirmed. This by no means addresses the wording ' +
      'concern.\n\n🐇 ✓',
  );

  assert.equal(
    classifyThreadAckOnlyPostDisposition(inNoWay, opts).ackOnlyPostDisposition,
    false,
  );
  assert.equal(
    classifyThreadAckOnlyPostDisposition(byNoMeans, opts)
      .ackOnlyPostDisposition,
    false,
  );
});

test('classifyThreadAckOnlyPostDisposition rejects an epistemic adverb casting doubt on the acknowledgment (self-critique, same pass as round 12, #2858)', () => {
  // A fourth closed enumeration added proactively rather than waiting
  // for a review round: epistemic adverbs cast doubt on whether the
  // claimed fix genuinely happened at all -- neither a degree (hedge)
  // nor an outright denial (negation). "This supposedly addresses the
  // concern" reads as the acknowledgment itself questioning its own
  // claim.
  const thread = {
    id: 'thread-epistemic-supposedly-addresses',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'EP-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'EP-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This supposedly addresses the ' +
            'wording concern.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects "perhaps" and "possibly" as missing epistemic qualifiers (Codex round 13, #2868)', () => {
  // Codex's round-13 finding on PR #2868: the initial epistemic
  // enumeration (added proactively alongside round 12) omitted the
  // common qualifiers "perhaps"/"possibly"/"maybe"/"presumably". This is
  // Codex's exact adversarial example plus one additional member from
  // its own suggested list.
  const opts = {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  };
  const mkThread = (id: string, body: string) => ({
    id,
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: `${id}-1`,
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: `${id}-2`,
          author: { login: 'coderabbitai[bot]' },
          body,
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  });

  const perhaps = mkThread(
    'thread-epistemic-perhaps',
    '`@user`, confirmed. The fix perhaps addresses the security ' +
      'concern.\n\n🐇 ✓',
  );
  const possibly = mkThread(
    'thread-epistemic-possibly',
    '`@user`, confirmed. The fix possibly addresses the security ' +
      'concern.\n\n🐇 ✓',
  );

  assert.equal(
    classifyThreadAckOnlyPostDisposition(perhaps, opts).ackOnlyPostDisposition,
    false,
  );
  assert.equal(
    classifyThreadAckOnlyPostDisposition(possibly, opts).ackOnlyPostDisposition,
    false,
  );
});

test('classifyThreadAckOnlyPostDisposition rejects a compact conjunction-joined finding within the token cap (Codex round 13, #2868)', () => {
  // Codex's round-13 finding on PR #2868: the round-7 token cap alone
  // does not close every conjunction-joined bypass -- a COMPACT
  // construction fits within the `{0,3}` budget where round 7's
  // original 5-token example did not. "This addresses the concern but
  // raises concerns.\n\n🐇 ✓" consumes "concern", "but", "raises" as
  // three modifier tokens (within budget) and reaches the second,
  // plural "concerns" as the closure target. This is Codex's exact
  // adversarial example.
  const thread = {
    id: 'thread-conjunction-compact-but-raises',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'CC-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'CC-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the concern but ' +
            'raises concerns.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a 2-token conjunction bypass demonstrating no finite token cap alone closes this class (self-critique, same pass as round 13, #2858)', () => {
  // Confirms the doc comment's own claim: tightening the token cap
  // cannot close this bypass class in general, since an even shorter
  // (2-token) variant exists. Only excluding coordinating conjunctions
  // themselves closes it.
  const thread = {
    id: 'thread-conjunction-two-token-yet',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'CY-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'CY-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@user`, confirmed. This addresses the concern yet ' +
            'concerns.\n\n🐇 ✓',
          createdAt: '2026-05-12T02:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

// #2927: a FOURTH ack shape -- observed byte-exact (fetched via the REST
// pulls/comments API) on kurone-kito/idd-skill#2921's review thread
// `discussion_r3989223825`, already resolved independently by this
// repository's own resolve-review-thread.mjs before CodeRabbit replied,
// so (like the third shape's #2853 samples above) it carries no "Review
// thread resolved" trailer of its own. See the doc comment above
// `CODERABBIT_ACK_MATCHES_BEHAVIOR_CLOSURE_RE` for the full reasoning.

test('classifyThreadAckOnlyPostDisposition recognizes the "matches the requested behavior" closure shape (kurone-kito/idd-skill#2921, #2927)', () => {
  const thread = {
    id: 'thread-matches-requested-behavior',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MB-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MB-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. The fix matches the requested ' +
            'behavior. The default fixture now uses the permissive ' +
            'zero-parseable-run-ID path.\n\n🐇 ✅\n\n_You are ' +
            'interacting with an AI system._\n\n<!-- This is an ' +
            'auto-generated reply by CodeRabbit -->',
          createdAt: '2026-09-11T00:00:00Z',
          updatedAt: '2026-09-11T00:00:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

test('classifyThreadAckOnlyPostDisposition rejects a hedge adverb immediately before "matches" (AC3, #2927)', () => {
  // AC3 (#2927): a reply using similar vocabulary but actually hedging
  // the outcome must not be misclassified as ack-only. Reuses the same
  // closed hedge-adverb enumeration guards 5/8/9 already apply before
  // "addresses", via an identical negative lookbehind before "matches".
  const thread = {
    id: 'thread-matches-hedge-partially',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MH-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MH-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. This partially matches the ' +
            'requested behavior.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:05:00Z',
          updatedAt: '2026-09-11T00:05:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a negation adverb immediately before "matches" (AC3, #2927)', () => {
  const thread = {
    id: 'thread-matches-negation-never',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MN-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MN-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. This never matches the requested ' +
            'behavior.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:10:00Z',
          updatedAt: '2026-09-11T00:10:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a contrastive-adjective variant that no longer matches the fixed closure phrase (AC3, #2927)', () => {
  // AC3 (#2927)'s own named example: "matches a different requested
  // behavior" is not a hedge or negation word immediately before
  // "matches", but the fixed phrase `CODERABBIT_ACK_MATCHES_BEHAVIOR_
  // CLOSURE_RE` requires ("matches the requested behavior") has no
  // internal gap for "different" to occupy -- the substitution simply
  // fails to match the literal phrase at all, unlike the third shape's
  // "addresses the [gap] concern", which needs an explicit guard for
  // this same class (residual gap (a) above).
  const thread = {
    id: 'thread-matches-contrastive-different',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MC-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MC-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. This matches a different ' +
            'requested behavior.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:15:00Z',
          updatedAt: '2026-09-11T00:15:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a trailing sentence over the 10-token cap after "matches the requested behavior" (#2927)', () => {
  // The trailing free-text sentence permitted after the closure phrase
  // is capped at 10 space-separated `[\w-]+` tokens (one more than the
  // real #2921 sample's 9), the same token-capped positive-shape
  // grammar as guard 1's internal "addresses the ... concern" gap. An
  // 11-token sentence -- otherwise clean, no excluded vocabulary -- has
  // no way to reach its own terminating period within the cap, so the
  // whole optional group fails to match; this fixture has no boilerplate
  // immediately after "behavior." either, so the fallback also misses.
  const thread = {
    id: 'thread-matches-trailing-over-cap',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MT-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MT-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. The fix matches the requested ' +
            'behavior. The quick brown fox jumps over the lazy dog ' +
            'again today.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:20:00Z',
          updatedAt: '2026-09-11T00:20:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a trailing sentence containing a comma after "matches the requested behavior" (#2927)', () => {
  // The trailing sentence's `[\w-]+` tokens are separated only by
  // `\s+`; a comma is neither a word/hyphen character nor whitespace,
  // so it breaks the token chain outright, the same reasoning guard 2's
  // "word/hyphen-only tokens" comment already established for the third
  // shape's internal gap.
  const thread = {
    id: 'thread-matches-trailing-comma',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MG-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MG-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. The fix matches the requested ' +
            'behavior. The default fixture, unfortunately, still ' +
            'needs a follow-up.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:25:00Z',
          updatedAt: '2026-09-11T00:25:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition rejects a second free sentence appended after the permitted trailing sentence, before the boilerplate tail (#2927)', () => {
  // The permitted trailing sentence must be immediately followed by the
  // boilerplate tail -- exactly one more sentence, not two. A second
  // sentence ("However, a related issue remains.") sitting between the
  // first trailing sentence and the tail is not reachable within the
  // token cap without crossing the first sentence's own terminating
  // period, which the token grammar cannot cross either -- the same
  // "no bare end-of-body fallback" discipline guard 3 established for
  // the third shape.
  const thread = {
    id: 'thread-matches-trailing-second-sentence',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'MS-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'MS-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. The fix matches the requested ' +
            'behavior. The default fixture now uses a workaround. ' +
            'However, a related issue remains.\n\n🐇 ✅',
          createdAt: '2026-09-11T00:30:00Z',
          updatedAt: '2026-09-11T00:30:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, false);
});

test('classifyThreadAckOnlyPostDisposition recognizes the "matches the requested behavior" closure with no trailing sentence at all ("this" lead-in, #2927)', () => {
  // Variant of the real #2921 sample with no trailing sentence between
  // the closure phrase and the tail (guard 3's original immediate-
  // boilerplate fallback still applies when the optional trailing-
  // sentence group is absent), and the lead-in whitelist's bare "this"
  // pronoun branch instead of "The fix" -- both already supported
  // unchanged by the reused `CODERABBIT_ACK_CLOSURE_LEADIN_RE`. Also
  // exercises the pre-existing ✓ sign-off variant alongside this shape,
  // confirming the ✅ widening above did not narrow it.
  const thread = {
    id: 'thread-matches-no-trailing-sentence',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'ML-1',
          author: { login: 'idd-bot' },
          body: '**Accepted** — done.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'ML-2',
          author: { login: 'coderabbitai[bot]' },
          body:
            '`@kurone-kito`, thanks. This matches the requested ' +
            'behavior.\n\n🐇 ✓\n\n_You are interacting with an AI ' +
            'system._\n\n<!-- This is an auto-generated reply by ' +
            'CodeRabbit -->',
          createdAt: '2026-09-11T00:35:00Z',
          updatedAt: '2026-09-11T00:35:00Z',
        },
      ],
    },
  };

  const classification = classifyThreadAckOnlyPostDisposition(thread, {
    iddAgentLogins: ['idd-bot'],
    advisoryBotLogins: ['coderabbitai[bot]'],
  });

  assert.equal(classification.ackOnlyPostDisposition, true);
});

// Codex review findings on this PR (#2014), both verified against source
// before accepting.

test('the anchor-set fix honors the [bot]-suffix cross-product (Codex P1, #2014)', () => {
  // `iddAgentLogins` carries GitHub's suffixed `dual-bot[bot]` author-login
  // form while `advisoryBotLogins` is configured with the supported
  // suffixless `dual-bot` form (or vice versa) -- a plain `Set.has` lookup
  // would miss the match and let the advisory bot anchor a disposition
  // anyway. The exclusion must use the same suffix-normalized identity
  // (`isConfiguredAdvisoryBotLogin`) both producers already use elsewhere.
  const make = (iddAgentLogin: string, advisoryBotLogin: string) => {
    const thread = {
      id: 'thread-dual-bot-suffix',
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
            // GitHub always reports a bot's actual login with the [bot]
            // suffix; the configured `iddAgentLogins`/`advisoryBotLogins`
            // values below may or may not match this literally.
            author: { login: 'dual-bot[bot]' },
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
        iddAgentLogins: [iddAgentLogin],
        advisoryBotLogins: [advisoryBotLogin, 'coderabbitai[bot]'],
        snapshotBoundaryAt: '2026-05-12T01:00:00Z',
      },
    );
    const activitySummary = buildActivitySnapshotSummary(
      { comments: [], reviews: [], threads: [thread], checks: [] },
      {
        trustedMarkerLogins: [iddAgentLogin],
        advisoryBotLogins: [advisoryBotLogin, 'coderabbitai[bot]'],
        advisoryBotLoginsSource: 'config',
        dispositionAuthorLogins: [iddAgentLogin],
      },
    );
    return { dispositionSummary, activitySummary };
  };

  // `iddAgentLogin` stays pinned to the actual GitHub-reported author form
  // (`dual-bot[bot]`) across both cases -- only `advisoryBotLogin`'s
  // suffix form varies, isolating the exclusion fix under test from the
  // unrelated (and already-suffix-consistent) disposition-author
  // recognition.
  for (const [iddAgentLogin, advisoryBotLogin] of [
    ['dual-bot[bot]', 'dual-bot'],
    ['dual-bot[bot]', 'dual-bot[bot]'],
  ] as const) {
    const { dispositionSummary, activitySummary } = make(
      iddAgentLogin,
      advisoryBotLogin,
    );
    assert.equal(
      dispositionSummary.missingThreads[0].ackOnlyPostDisposition,
      false,
      `advisory-bot config ${advisoryBotLogin} should exclude author dual-bot[bot] from anchoring`,
    );
    assert.deepEqual(
      activitySummary.ackOnly.items,
      [],
      `advisory-bot config ${advisoryBotLogin} should exclude author dual-bot[bot] from anchoring`,
    );
  }
});

test('the marker-recognition fix only anchors a rejection-confirmed reply on a still-resolved thread (Codex P2, #2014)', () => {
  // A thread carrying `**Rejection confirmed by maintainer**` that is later
  // reopened must stop anchoring the global post-disposition window --
  // `hasFreshDisposition` already stops recognizing the marker once a
  // thread is reopened; the global ack-only anchor must not leak a stale
  // disposition from a reopened thread into an unrelated new advisory-bot
  // comment's classification.
  const reopenedThread = {
    id: 'thread-reopened-rejection-confirmed',
    isResolved: false,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'RO-1',
          author: { login: 'reviewer-a' },
          body: 'please reconsider this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'RO-2',
          author: { login: 'idd-bot' },
          body: '**Rejection confirmed by maintainer** — agreed, no action needed.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T00:30:00Z',
        },
        {
          id: 'RO-3',
          author: { login: 'reviewer-a' },
          body: 'Actually, reopening -- I disagree now.',
          createdAt: '2026-05-12T01:00:00Z',
          updatedAt: '2026-05-12T01:00:00Z',
        },
      ],
    },
  };
  const newFinding = {
    id: 'C-NEW',
    author: { login: 'coderabbitai[bot]' },
    body: 'New finding: consider tightening this check.',
    createdAt: '2026-05-12T02:00:00Z',
    updatedAt: '2026-05-12T02:00:00Z',
  };

  const activitySummary = buildActivitySnapshotSummary(
    {
      comments: [newFinding],
      reviews: [],
      threads: [reopenedThread],
      checks: [],
    },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['idd-bot'],
    },
  );

  // The stale rejection-confirmed reply on the now-reopened thread must not
  // anchor a post-disposition window at all, so CodeRabbit's brand-new
  // finding is genuine new activity, not a misclassified courtesy ack.
  assert.equal(activitySummary.ackOnly.dispositionsPresent, false);
  assert.deepEqual(activitySummary.ackOnly.items, []);
});

test('a top-level rejection-confirmed comment does not anchor the ack-only window (Copilot, #2014 PR #2029)', () => {
  // `**Rejection confirmed by maintainer**` is only a valid disposition when
  // it is a reply on a resolved review thread (`isRejectionConfirmedDisposition`'s
  // doc comment). A plain top-level PR comment has no thread/resolved
  // concept to validate the marker against, so it must NOT open the
  // post-disposition ack-only window -- matching
  // `summarizeDispositionEvidenceForGate`'s regular-comment pool
  // (`dispositionComments`), which has only ever recognized
  // `isDispositionComment` (`**Accepted**`/`**Rejected**`) for non-thread
  // comments. Recognizing the marker here too would let a misplaced/quoted
  // marker on an ordinary issue comment open the PR-wide ack window and
  // suppress a genuinely new advisory-bot finding below.
  const misplacedMarker = {
    id: 'TL-1',
    author: { login: 'idd-bot' },
    body: '**Rejection confirmed by maintainer** — agreed, no action needed.',
    createdAt: '2026-05-12T00:00:00Z',
    updatedAt: '2026-05-12T00:00:00Z',
  };
  const newFinding = {
    id: 'TL-2',
    author: { login: 'coderabbitai[bot]' },
    body: 'New finding: consider tightening this check.',
    createdAt: '2026-05-12T01:00:00Z',
    updatedAt: '2026-05-12T01:00:00Z',
  };

  const activitySummary = buildActivitySnapshotSummary(
    {
      comments: [misplacedMarker, newFinding],
      reviews: [],
      threads: [],
      checks: [],
    },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['idd-bot'],
    },
  );

  // No valid disposition anchor exists at the top level, so CodeRabbit's
  // new finding is genuine new activity, not a misclassified courtesy ack.
  assert.equal(activitySummary.ackOnly.dispositionsPresent, false);
  assert.deepEqual(activitySummary.ackOnly.items, []);
  assert.equal(
    activitySummary.effective.maxActivityUpdatedAt,
    '2026-05-12T01:00:00Z',
  );
});

test('reviewCurrency anchors an edited rejection-confirmed marker by its effective activity, matching dispositionEvidence (#2045)', () => {
  // The maintainer's `**Rejection confirmed by maintainer**` reply is
  // posted at 00:30 but edited afterward (e.g. a typo fix), so its
  // updatedAt (01:30) postdates a genuine advisory-bot reply at 01:00 --
  // between the marker's original createdAt and its edited updatedAt.
  // dispositionEvidence already anchors the marker by effective
  // (updatedAt-preferring) activity, so it correctly treats the 01:00
  // reply as pre-disposition (genuine, not ack-only). Before this fix,
  // reviewCurrency anchored the same marker by createdAt (00:30) alone,
  // so it misclassified the 01:00 reply as post-disposition ack-only.
  const thread = {
    id: 'thread-edited-rejection-confirmed',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'ERC-1',
          author: { login: 'reviewer-a' },
          body: 'please reconsider this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'ERC-2',
          author: { login: 'idd-bot' },
          body: '**Rejection confirmed by maintainer** — agreed, no action needed.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T01:30:00Z',
        },
        {
          id: 'ERC-3',
          author: { login: 'coderabbitai[bot]' },
          body: 'Actually, one more concern before this closes.',
          createdAt: '2026-05-12T01:00:00Z',
          updatedAt: '2026-05-12T01:00:00Z',
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

  // dispositionEvidence already treats the 01:00 reply as pre-disposition
  // (genuine): the thread needs no fresh disposition of its own.
  assert.equal(dispositionSummary.route, 'proceed');
  assert.equal(dispositionSummary.blockingCount, 0);
  assert.deepEqual(dispositionSummary.missingThreads, []);

  // reviewCurrency now agrees: the marker's effective activity (01:30)
  // anchors the disposition, so the 01:00 reply is genuine, not ack-only.
  assert.equal(
    activitySummary.ackOnly.latestDispositionAt,
    '2026-05-12T01:30:00Z',
  );
  assert.deepEqual(activitySummary.ackOnly.items, []);
});

test('reviewCurrency still anchors an edited ordinary Accepted marker by createdAt, not effective activity (#2045)', () => {
  // The intentional, pre-existing behavior for ordinary
  // `**Accepted**`/`**Rejected**` markers -- "Dispositions are not
  // SHA-bound here" (buildActivitySnapshotSummary's own comment) -- must
  // NOT change as a side effect of this fix, which is scoped only to the
  // `**Rejection confirmed by maintainer**` marker. Even though this
  // `**Accepted**` reply is edited afterward (updatedAt 02:00, after the
  // advisory-bot's 01:00 reply), it must still anchor by its createdAt
  // (00:30), so the 01:00 reply stays classified as ack-only exactly as
  // before this fix.
  const thread = {
    id: 'thread-edited-accepted',
    isResolved: true,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'AC-1',
          author: { login: 'reviewer-a' },
          body: 'please double check this',
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T00:00:00Z',
        },
        {
          id: 'AC-2',
          author: { login: 'idd-bot' },
          body: '**Accepted** — looks fine.',
          createdAt: '2026-05-12T00:30:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
        },
        {
          id: 'AC-3',
          author: { login: 'coderabbitai[bot]' },
          body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
          createdAt: '2026-05-12T01:00:00Z',
          updatedAt: '2026-05-12T01:00:00Z',
        },
      ],
    },
  };

  const activitySummary = buildActivitySnapshotSummary(
    { comments: [], reviews: [], threads: [thread], checks: [] },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['coderabbitai[bot]'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['idd-bot'],
    },
  );

  assert.equal(
    activitySummary.ackOnly.latestDispositionAt,
    '2026-05-12T00:30:00Z',
  );
  assert.deepEqual(
    activitySummary.ackOnly.items.map((item) => item.id),
    ['AC-3'],
  );
});

// #2249: `summarizeDispositionEvidenceForGate`'s `missingRegularComments[].hint`
// only named the exact required literal prefix for the narrow #1833
// non-review-notice pairing. The far more common mistake -- an IDD-agent
// reply written as plain `Accepted — ...` with no bold markdown at all --
// fell into the same `missingRegularComments` list with no hint at all,
// even though `isDispositionComment` requires exactly `**Accepted**` /
// `**Rejected**`. This generalizes the hint to that plain-text case.
test('disposition evidence hints at the required literal prefix when a plain-text (no bold) reply exists', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'I found a potential off-by-one in `foo.mts` at line 42 — the loop bound should be `<=` to include the final element.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          // A real disposition attempt in substance, but no bold markdown
          // at all -- fails `isDispositionComment`.
          body: 'Accepted — looks correct.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  // Existing pass/fail routing is unchanged -- only the diagnostic is added.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.reason, 'missing-disposition-evidence');
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(
    summary.missingRegularComments[0].hint,
    MALFORMED_DISPOSITION_PREFIX_HINT,
  );
});

// #2249: a regular comment with no resemblance whatsoever to a disposition
// attempt (no later IDD-agent reply at all) must still carry no hint --
// the new generalized check must not become a blanket default.
test('disposition evidence does not hint an unrelated regular comment with no reply attempt', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'This looks like a genuine review finding with no reply yet.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});

// #2249, Copilot review on PR #2383: `MALFORMED_DISPOSITION_PREFIX_RE` must
// not match a single-`*` near-miss (`*Accepted`, not a real bold-markdown
// attempt) or a longer word starting with the same prefix (`Acceptedly`),
// so the hint stays scoped to genuine near-miss disposition attempts.
test('disposition evidence does not hint from a single-asterisk or longer-word near-miss', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'I found a potential off-by-one in `foo.mts` at line 42 — the loop bound should be `<=` to include the final element.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          // Single leading `*`, not the required zero or two -- not a
          // real bold-markdown disposition attempt.
          body: '*Accepted — looks correct.',
          author: { login: 'idd-bot' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'A second, unrelated finding awaiting its own disposition.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 4,
          createdAt: '2026-05-12T01:00:00Z',
          // Starts with the literal word "Accepted" but continues into a
          // longer word -- not a disposition attempt at all.
          body: 'Acceptedly this needs more review before merging.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.missingRegularCommentCount, 2);
  for (const comment of summary.missingRegularComments) {
    assert.equal(comment.hint, undefined);
  }
});

// #2249, Copilot review on PR #2383: a human's outstanding comment never
// requires the bold `**Accepted**`/`**Rejected**` prefix (presence-only,
// #2139), so `MALFORMED_DISPOSITION_PREFIX_HINT` must never attach to a
// human missing comment even when a malformed reply exists somewhere in
// the thread. Two human comments, one malformed reply: the 1:1 pairing
// consumes the reply for the EARLIER comment (clearing it), leaving the
// LATER comment still missing -- it must get no hint, not a misleading
// one claiming it needs bold markdown it never required.
test('disposition evidence does not hint a still-missing human comment from a reply consumed by an earlier human comment', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          body: 'First human review comment awaiting a reply.',
          author: { login: 'reviewer-a' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T00:30:00Z',
          body: 'Second human review comment awaiting a reply.',
          author: { login: 'reviewer-b' },
        },
        {
          id: 3,
          createdAt: '2026-05-12T01:00:00Z',
          // Malformed (no bold), but presence-only suffices for a human
          // comment -- the 1:1 pairing consumes this for comment 1 (the
          // earlier of the two), leaving comment 2 still missing.
          body: 'Accepted — will follow up.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingRegularComments[0].authorLogin, 'reviewer-b');
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});

// #2491: a correctly-phrased disposition (`**Accepted**`) that genuinely
// postdated the comment at reply time, but the bot then live-edited that
// same comment id afterward into a non-review notice -- bumping its
// `updatedAt` past the disposition's own timestamp. Neither #1833's
// wrong-phrase hint nor #2249's malformed-prefix hint applies (the
// disposition was never mis-phrased), so this must be the only source of
// a hint here.
test('disposition evidence hints at an edited-after-disposition notice when the bot live-edits a dispositioned comment', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          // Edited by the bot after the disposition below -- bumps
          // activityAt (updatedAt) past the disposition's own timestamp,
          // and the CURRENT body is now a non-review notice.
          updatedAt: '2026-05-12T02:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          // Well-formed and genuinely postdated the comment's original
          // review-finding content at reply time.
          body: '**Accepted** — looks correct.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  // Existing pass/fail routing is unchanged -- only the diagnostic is added.
  assert.equal(summary.route, 'return-to-e1');
  assert.equal(summary.reason, 'missing-disposition-evidence');
  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(
    summary.missingRegularComments[0].hint,
    EDITED_AFTER_DISPOSITION_HINT,
  );
});

// The disposition must predate the comment's CURRENT activityAt, not just
// its createdAt -- a disposition posted AFTER the bot's edit (i.e. one that
// already satisfies the general 1:1 pairing) must not also spuriously carry
// this hint; the comment should not even be missing in that case.
test('disposition evidence does not hint edited-after-disposition when the disposition already postdates the edit', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T01:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T02:00:00Z',
          body: '**Accepted** — looks correct.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.missingRegularCommentCount, 0);
});

// A comment genuinely edited after a disposition (timing bound satisfied,
// same as the positive scenario) but whose CURRENT body is NOT a non-review
// notice must not pick up the hint -- `isAdvisoryNonReviewNotice` gates it
// to the exact scenario it diagnoses. Unlike the disjoint-timestamp fixture
// used elsewhere in this file, T0 < T1 <= T2 here so the timing bound alone
// is satisfied and cannot itself explain a missing hint -- only the
// notice-body gate can (#2491 critique finding 1: a prior version of this
// test used a disposition that predated the comment's own createdAt, which
// left the timing bound doing the suppressing instead).
test('disposition evidence does not hint edited-after-disposition when the current body is not a notice', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          // Edited after the disposition below, same as the positive
          // scenario -- but into ordinary follow-up prose, not a notice.
          updatedAt: '2026-05-12T02:00:00Z',
          body: 'Never mind, I found the actual line myself.',
          author: { login: 'chatgpt-codex-connector[bot]' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          body: '**Accepted** — looks correct.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});

// Same timing shape as the positive scenario (T0 < T1 <= T2, current body
// IS a notice), but the comment's author is not a configured advisory bot
// login -- `isGateAdvisoryBotLogin` gates the hint to a genuine advisory-bot
// notice, not any comment that happens to contain rate-limit-shaped prose.
test('disposition evidence does not hint edited-after-disposition when the author is not a configured advisory bot', () => {
  const summary = summarizeDispositionEvidenceForGate(
    {
      comments: [
        {
          id: 1,
          createdAt: '2026-05-12T00:00:00Z',
          updatedAt: '2026-05-12T02:00:00Z',
          body: 'You have reached your Codex usage limits for code reviews.',
          author: { login: 'a-human' },
        },
        {
          id: 2,
          createdAt: '2026-05-12T01:00:00Z',
          body: '**Accepted** — looks correct.',
          author: { login: 'idd-bot' },
        },
      ],
      threads: [],
    },
    {
      iddAgentLogins: ['idd-bot'],
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );

  assert.equal(summary.missingRegularCommentCount, 1);
  assert.equal(summary.missingRegularComments[0].hint, undefined);
});
