import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSecondaryAdvisoryReviewSettlement,
  foldSecondaryAdvisoryReviewSettlements,
  isConfiguredAdvisoryBotLogin,
  isCopilotReviewerLogin,
  isGateAdvisoryBotLogin,
  normalizeTrustedMarkerLogins,
} from '../src/scripts/protocol-helpers.mts';

const CODERABBIT_NOTICE =
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached';
const CODERABBIT_SUMMARY =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough\nSome walkthrough text.';
const CODERABBIT_ALREADY_REVIEWED_ACK =
  '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
  '<!-- CodeRabbit review command invocation: v2:abc123 -->\n' +
  '<details>\n' +
  '<summary>⚠️ Action not completed</summary>\n\n' +
  'Already reviewed the last commit. Use `@coderabbitai full review` to rerun a\n' +
  'review of the entire changeset.\n\n' +
  '> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.\n' +
  'This command is applicable only when automatic reviews are paused.\n\n' +
  '</details>';
// #3193 (gist round 35): a distinct CodeRabbit reply shape -- a
// review-command acknowledgement followed by a conclusive "Review rate
// limited." decline in the same "Action not completed" wrapper #3146
// uses, instead of "Already reviewed the last commit."
// The promise sentence deliberately does not contain the word "review" --
// regression coverage for a C1 delegate finding on this same change: the
// matcher must not require that specific token (#3193).
const CODERABBIT_RATE_LIMITED_ACK =
  '<!-- This is an auto-generated reply by CodeRabbit -->\n' +
  '<!-- CodeRabbit review command invocation: v2:def456 -->\n' +
  'Sure, taking a look at this now.\n\n' +
  '<details>\n' +
  '<summary>⚠️ Action not completed</summary>\n\n' +
  'Review rate limited.\n\n' +
  '> Note: CodeRabbit is an incremental review system and does not re-review already reviewed commits.\n' +
  'This command is applicable only when automatic reviews are paused.\n\n' +
  '</details>';
const HEAD_COMMITTED_AT = '2026-09-02T12:00:00Z';

function comment(login: string, body: string, createdAt: string) {
  return { author: { login }, body, createdAt };
}

// Build the advisory-bot set exactly as the gate callers do, so the test
// exercises the real construction path rather than a hand-rolled Set.
const buildSet = (logins: string[]): Set<string> =>
  new Set(normalizeTrustedMarkerLogins(logins));

test('isGateAdvisoryBotLogin matches a custom bot across the [bot] suffix cross-product', () => {
  // config stores the suffixless form
  const suffixlessConfig = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('my-bot', suffixlessConfig), true);
  assert.equal(isGateAdvisoryBotLogin('my-bot[bot]', suffixlessConfig), true);

  // config stores the suffixed form
  const suffixedConfig = buildSet(['my-bot[bot]']);
  assert.equal(isGateAdvisoryBotLogin('my-bot', suffixedConfig), true);
  assert.equal(isGateAdvisoryBotLogin('my-bot[bot]', suffixedConfig), true);
});

test('isGateAdvisoryBotLogin normalizes case and surrounding whitespace', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('  My-Bot[BOT] ', config), true);
});

test('isGateAdvisoryBotLogin keeps the CodeRabbit/Codex/Copilot defaults working', () => {
  const empty = buildSet([]);
  for (const login of [
    'coderabbitai',
    'coderabbitai[bot]',
    'chatgpt-codex-connector',
    'chatgpt-codex-connector[bot]',
    'copilot-pull-request-reviewer[bot]',
  ]) {
    assert.equal(
      isGateAdvisoryBotLogin(login, empty),
      true,
      `default review bot should match: ${login}`,
    );
  }
});

test('isGateAdvisoryBotLogin rejects unconfigured and empty logins', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isGateAdvisoryBotLogin('some-human', config), false);
  assert.equal(isGateAdvisoryBotLogin('other-bot[bot]', config), false);
  assert.equal(isGateAdvisoryBotLogin('', config), false);
  assert.equal(isGateAdvisoryBotLogin(null, config), false);
  assert.equal(isGateAdvisoryBotLogin(undefined, config), false);
  // A bare `[bot]` reduces to an empty token and must not match.
  assert.equal(isGateAdvisoryBotLogin('[bot]', config), false);
});

test('isConfiguredAdvisoryBotLogin matches a custom bot across the [bot] suffix cross-product', () => {
  // config stores the suffixless form
  const suffixlessConfig = buildSet(['my-bot']);
  assert.equal(isConfiguredAdvisoryBotLogin('my-bot', suffixlessConfig), true);
  assert.equal(
    isConfiguredAdvisoryBotLogin('my-bot[bot]', suffixlessConfig),
    true,
  );

  // config stores the suffixed form
  const suffixedConfig = buildSet(['my-bot[bot]']);
  assert.equal(isConfiguredAdvisoryBotLogin('my-bot', suffixedConfig), true);
  assert.equal(
    isConfiguredAdvisoryBotLogin('my-bot[bot]', suffixedConfig),
    true,
  );

  // case and surrounding whitespace are normalized like the gate callers expect
  assert.equal(
    isConfiguredAdvisoryBotLogin('  My-Bot[BOT] ', suffixlessConfig),
    true,
  );
});

test('isConfiguredAdvisoryBotLogin matches ONLY configured bots, not known review bots', () => {
  // Unlike isGateAdvisoryBotLogin, the ack-only carve-out predicate must not
  // fold in the CodeRabbit/Codex/Copilot defaults: a known-review-bot ack must
  // never be reclassified as a configured-advisory-bot courtesy ack.
  const empty = buildSet([]);
  for (const login of [
    'coderabbitai',
    'coderabbitai[bot]',
    'chatgpt-codex-connector[bot]',
    'copilot-pull-request-reviewer[bot]',
  ]) {
    assert.equal(
      isConfiguredAdvisoryBotLogin(login, empty),
      false,
      `known review bot must not match when unconfigured: ${login}`,
    );
    // isGateAdvisoryBotLogin still folds the same default in — the two
    // predicates intentionally differ on exactly this class.
    assert.equal(isGateAdvisoryBotLogin(login, empty), true);
  }
  // It does match a known review bot once that bot is explicitly configured.
  assert.equal(
    isConfiguredAdvisoryBotLogin(
      'coderabbitai[bot]',
      buildSet(['coderabbitai']),
    ),
    true,
  );
});

test('isConfiguredAdvisoryBotLogin rejects unconfigured and empty logins', () => {
  const config = buildSet(['my-bot']);
  assert.equal(isConfiguredAdvisoryBotLogin('some-human', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin('other-bot[bot]', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin('', config), false);
  assert.equal(isConfiguredAdvisoryBotLogin(null, config), false);
  assert.equal(isConfiguredAdvisoryBotLogin(undefined, config), false);
  // A bare `[bot]` reduces to an empty token and must not match.
  assert.equal(isConfiguredAdvisoryBotLogin('[bot]', config), false);
});

test('computeSecondaryAdvisoryReviewSettlement: no matching comments -> not settled, not declined (still pending)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement([], {
    secondaryBotLogin: 'coderabbitai[bot]',
    headCommittedAt: HEAD_COMMITTED_AT,
  });
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: false,
  });
});

// #2547: a rate-limit/skip-review notice for the CURRENT HEAD is itself
// sufficient to report `declined: true` -- this function only ever sees
// `comments`, never a separately-fetched commit-status entry, so it cannot
// distinguish "notice with a corroborating rate-limited commit status"
// from "notice alone, no status checked" -- both inputs are identical from
// here. This is a deliberate implementer's-judgment call the issue left
// open: #2547's live investigation (`gh api .../commits/{sha}/statuses`
// across several PRs, corroborated by 15+ hours of subsequent silence on
// the oldest sampled PR) found the notice comment alone was already 100%
// reliable as a terminal signal, so no additional corroboration is
// required before treating it as definitive.
test('computeSecondaryAdvisoryReviewSettlement: only a rate-limit notice at HEAD -> declined (#2547, no corroborating commit status checked)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai[bot]', CODERABBIT_NOTICE, '2026-09-02T12:05:00Z')],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: true,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: review-command rate-limited acknowledgement at HEAD -> declined (#3193)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [
      comment(
        'coderabbitai[bot]',
        CODERABBIT_RATE_LIMITED_ACK,
        '2026-09-02T12:05:00Z',
      ),
    ],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: true,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: genuine review at/after HEAD -> settled, not declined', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T12:05:00Z')],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: true,
    settledAt: '2026-09-02T12:05:00Z',
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: genuine review BEFORE HEAD (stale prior HEAD) -> not settled, not declined (still pending)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T11:00:00Z')],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: notice AFTER the latest genuine review -> declined (fresh decline, not a still-pending retry)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [
      comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T12:05:00Z'),
      comment('coderabbitai[bot]', CODERABBIT_NOTICE, '2026-09-02T12:10:00Z'),
    ],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: true,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: notice BEFORE a later genuine review -> settled (rate-limited, then recovered)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [
      comment('coderabbitai[bot]', CODERABBIT_NOTICE, '2026-09-02T12:05:00Z'),
      comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T12:10:00Z'),
    ],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: true,
    settledAt: '2026-09-02T12:10:00Z',
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: already-reviewed acknowledgement remains pending because it is retryable (#3146)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [
      comment(
        'coderabbitai[bot]',
        CODERABBIT_ALREADY_REVIEWED_ACK,
        '2026-09-02T12:05:00Z',
      ),
    ],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: matches across the [bot]-suffix mismatch (#2473)', () => {
  // GraphQL strips the [bot] suffix (author login reported as `coderabbitai`)
  // while the configured login stores the REST-shaped `coderabbitai[bot]`.
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai', CODERABBIT_SUMMARY, '2026-09-02T12:05:00Z')],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: true,
    settledAt: '2026-09-02T12:05:00Z',
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: unparseable headCommittedAt -> not settled, not declined', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T12:05:00Z')],
    { secondaryBotLogin: 'coderabbitai[bot]', headCommittedAt: null },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: unconfigured secondaryBotLogin -> not settled, not declined', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [comment('coderabbitai[bot]', CODERABBIT_SUMMARY, '2026-09-02T12:05:00Z')],
    { secondaryBotLogin: '', headCommittedAt: HEAD_COMMITTED_AT },
  );
  assert.deepEqual(result, {
    settled: false,
    settledAt: null,
    declined: false,
  });
});

test('computeSecondaryAdvisoryReviewSettlement: matches REST-raw comments (user.login/created_at/updated_at), not just the normalized shape (Copilot review, #2546)', () => {
  const result = computeSecondaryAdvisoryReviewSettlement(
    [
      {
        user: { login: 'coderabbitai[bot]' },
        body: CODERABBIT_SUMMARY,
        created_at: '2026-09-02T12:05:00Z',
      },
    ],
    {
      secondaryBotLogin: 'coderabbitai[bot]',
      headCommittedAt: HEAD_COMMITTED_AT,
    },
  );
  assert.deepEqual(result, {
    settled: true,
    settledAt: '2026-09-02T12:05:00Z',
    declined: false,
  });
});

// #3186: foldSecondaryAdvisoryReviewSettlements -- folds each configured
// secondary login's own computeSecondaryAdvisoryReviewSettlement result
// into the single { settledAt, declined } shape buildSecondaryQuietWindowStatus
// consumes.

const DECLINE_NOTICE = '## Review limit reached\n\nRate limited for this HEAD.';
const GENUINE_REVIEW = 'Looks fine to me.';

test('foldSecondaryAdvisoryReviewSettlements: empty login list -> unconfigured shape', () => {
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements([], {
      secondaryBotLogins: [],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: single pending login -> not declined, no settledAt', () => {
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements([], {
      secondaryBotLogins: ['coderabbitai[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: single declined login -> declined', () => {
  const comments = [
    comment('coderabbitai[bot]', DECLINE_NOTICE, '2026-09-02T12:01:00Z'),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['coderabbitai[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: true },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: single settled login -> anchors on its own settledAt', () => {
  const comments = [
    comment('coderabbitai[bot]', GENUINE_REVIEW, '2026-09-02T12:01:00Z'),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['coderabbitai[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: '2026-09-02T12:01:00Z', declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: two settled logins -> anchors on the LATEST settledAt', () => {
  const comments = [
    comment('coderabbitai[bot]', GENUINE_REVIEW, '2026-09-02T12:01:00Z'),
    comment(
      'chatgpt-codex-connector[bot]',
      GENUINE_REVIEW,
      '2026-09-02T12:03:00Z',
    ),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: '2026-09-02T12:03:00Z', declined: false },
  );
  // Order of the resolved-login list must not affect the result.
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['chatgpt-codex-connector[bot]', 'coderabbitai[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: '2026-09-02T12:03:00Z', declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: every configured login declining -> declined', () => {
  const comments = [
    comment('coderabbitai[bot]', DECLINE_NOTICE, '2026-09-02T12:01:00Z'),
    comment(
      'chatgpt-codex-connector[bot]',
      DECLINE_NOTICE,
      '2026-09-02T12:02:00Z',
    ),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: true },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: one settled and one declined -> anchors on the settled login only (decline never extends the wait)', () => {
  const comments = [
    comment('coderabbitai[bot]', GENUINE_REVIEW, '2026-09-02T12:01:00Z'),
    // Posted LATER than the genuine review, but must not become the anchor.
    comment(
      'chatgpt-codex-connector[bot]',
      DECLINE_NOTICE,
      '2026-09-02T12:05:00Z',
    ),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: ['coderabbitai[bot]', 'chatgpt-codex-connector[bot]'],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: '2026-09-02T12:01:00Z', declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: three distinct logins, one of each state -> pending wins over both settled and declined', () => {
  const comments = [
    comment('coderabbitai[bot]', GENUINE_REVIEW, '2026-09-02T12:01:00Z'),
    comment(
      'chatgpt-codex-connector[bot]',
      DECLINE_NOTICE,
      '2026-09-02T12:02:00Z',
    ),
    // 'my-custom-bot[bot]' posts nothing -- stays pending.
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: [
        'coderabbitai[bot]',
        'chatgpt-codex-connector[bot]',
        'my-custom-bot[bot]',
      ],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: three distinct logins all settled -> anchors on the latest of the three', () => {
  const comments = [
    comment('coderabbitai[bot]', GENUINE_REVIEW, '2026-09-02T12:01:00Z'),
    comment(
      'chatgpt-codex-connector[bot]',
      GENUINE_REVIEW,
      '2026-09-02T12:04:00Z',
    ),
    comment('my-custom-bot[bot]', GENUINE_REVIEW, '2026-09-02T12:02:00Z'),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: [
        'coderabbitai[bot]',
        'chatgpt-codex-connector[bot]',
        'my-custom-bot[bot]',
      ],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: '2026-09-02T12:04:00Z', declined: false },
  );
});

test('foldSecondaryAdvisoryReviewSettlements: three distinct logins all declined -> declined', () => {
  const comments = [
    comment('coderabbitai[bot]', DECLINE_NOTICE, '2026-09-02T12:01:00Z'),
    comment(
      'chatgpt-codex-connector[bot]',
      DECLINE_NOTICE,
      '2026-09-02T12:02:00Z',
    ),
    comment('my-custom-bot[bot]', DECLINE_NOTICE, '2026-09-02T12:03:00Z'),
  ];
  assert.deepEqual(
    foldSecondaryAdvisoryReviewSettlements(comments, {
      secondaryBotLogins: [
        'coderabbitai[bot]',
        'chatgpt-codex-connector[bot]',
        'my-custom-bot[bot]',
      ],
      headCommittedAt: HEAD_COMMITTED_AT,
    }),
    { settledAt: null, declined: true },
  );
});

// #3262: `isCopilotReviewerLogin` for a configured non-Copilot primary bot
// must match a bare login against a `[bot]`-suffixed configured login only
// when `authorType` proves it is a genuine bot -- and must match a
// `[bot]`-suffixed observed login against a bare configured login
// unconditionally, since a user login cannot contain `[`.

test('#3262: isCopilotReviewerLogin matches a bot-suffixed configured login against a bare observed login only with authorType Bot', () => {
  assert.equal(
    isCopilotReviewerLogin('coderabbitai', 'coderabbitai[bot]', 'Bot'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai', 'coderabbitai[bot]', 'User'),
    false,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai', 'coderabbitai[bot]'),
    false,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai', 'coderabbitai[bot]', null),
    false,
  );
});

test('#3262: isCopilotReviewerLogin matches a bare configured login against a bot-suffixed observed login regardless of authorType', () => {
  assert.equal(
    isCopilotReviewerLogin('coderabbitai[bot]', 'coderabbitai', 'Bot'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai[bot]', 'coderabbitai'),
    true,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai[bot]', 'coderabbitai', 'User'),
    true,
  );
});

test('#3262: isCopilotReviewerLogin rejects a registrable lookalike for either configured spelling', () => {
  assert.equal(
    isCopilotReviewerLogin('coderabbitai1', 'coderabbitai[bot]', 'Bot'),
    false,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai1', 'coderabbitai', 'Bot'),
    false,
  );
  assert.equal(
    isCopilotReviewerLogin('coderabbitai1[bot]', 'coderabbitai', 'Bot'),
    false,
  );
});
