import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeSecondaryAdvisoryReviewSettlement,
  isConfiguredAdvisoryBotLogin,
  isGateAdvisoryBotLogin,
  normalizeTrustedMarkerLogins,
} from '../src/scripts/protocol-helpers.mts';

const CODERABBIT_NOTICE =
  '<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached';
const CODERABBIT_SUMMARY =
  '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough\nSome walkthrough text.';
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
