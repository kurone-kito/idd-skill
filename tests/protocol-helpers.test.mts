import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildActivitySnapshotSummary,
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
          body: 'Thanks for confirming.',
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
