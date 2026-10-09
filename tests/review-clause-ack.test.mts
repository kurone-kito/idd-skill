import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  type AdvisoryConvergenceInputs,
  type AdvisoryConvergenceOptions,
  computeAdvisoryConvergenceVerdict,
} from '../src/scripts/advisory-convergence.mts';
import {
  copilotReviewAckNeeded,
  fetchReviewsAndHeadCommit,
  type ReviewPayload,
  resolveLatestPrimaryBotReviewEvidence,
} from '../src/scripts/review-clause.mts';

// kurone-kito/idd-skill#3907: the gate's own Clause 1 ack rule and selector
// are the oracle; these tests pin the evidence the snapshot reports for
// them. Fixtures are read-only copies of the bot-comment corpus.

const CORPUS_PATH = join(
  fileURLToPath(new URL('../', import.meta.url)),
  'tests',
  'fixtures',
  'bot-comment-corpus',
  'corpus.json',
);
const corpus: Array<{ id: string; body: string }> = JSON.parse(
  readFileSync(CORPUS_PATH, 'utf8'),
);

function corpusBody(id: string): string {
  const entry = corpus.find((candidate) => candidate.id === id);
  assert.ok(entry, `corpus entry ${id} must exist`);
  return entry.body;
}

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const TRUSTED = 'kurone-kito';
const COPILOT = 'copilot-pull-request-reviewer[bot]';
const REVIEW_AT = '2026-10-09T01:00:00Z';
const ACK_AFTER = '2026-10-09T02:00:00Z';
const NOW = '2026-10-09T03:00:00Z';

const V2_SUPPRESSED = corpusBody('copilot-v2-previously-missed-3196');
const V2_CLEAN = corpusBody('copilot-v2-clean-3245');
const LEGACY_SUPPRESSED = corpusBody('copilot-legacy-suppressed1-3095');
const ERROR_BODY = corpusBody('copilot-error-3013');
const UNRECOGNIZED = 'Copilot wrote something new that no shape matches.';

function review(
  overrides: Partial<ReviewPayload> & { id: string },
): ReviewPayload {
  return {
    author: { login: COPILOT, __typename: 'Bot' },
    submittedAt: REVIEW_AT,
    commitId: HEAD,
    itemCount: 0,
    body: V2_CLEAN,
    replyOnly: false,
    ...overrides,
  };
}

function comment(overrides: {
  login?: string;
  body?: string;
  createdAt?: string;
  lastEditedAt?: string | null;
}) {
  return {
    id: 'c1',
    author: { login: overrides.login ?? TRUSTED },
    body:
      overrides.body ??
      `review-ack: claude-f3ef1280 ${HEAD} 2026-10-09T02:00:00Z`,
    createdAt: overrides.createdAt ?? ACK_AFTER,
    updatedAt: overrides.createdAt ?? ACK_AFTER,
    lastEditedAt:
      overrides.lastEditedAt === undefined ? null : overrides.lastEditedAt,
  };
}

// A table over the ack rule. Each row's `needed` is what the snapshot must
// report; the oracle is the gate's own verdict, checked below.
const ACK_ROWS = [
  {
    name: 'v2 body with a Previously missed finding',
    body: V2_SUPPRESSED,
    primaryBotLogin: 'copilot',
    matchesHead: true,
    needed: true,
  },
  {
    name: 'legacy body with a suppressed comment',
    body: LEGACY_SUPPRESSED,
    primaryBotLogin: 'copilot',
    matchesHead: true,
    needed: true,
  },
  {
    name: 'unrecognized body with the default Copilot bot',
    body: UNRECOGNIZED,
    primaryBotLogin: 'copilot',
    matchesHead: true,
    needed: true,
  },
  {
    name: 'unrecognized body with a configured non-default bot',
    body: UNRECOGNIZED,
    primaryBotLogin: 'acme-review',
    matchesHead: true,
    needed: false,
    author: { login: 'acme-review[bot]', __typename: 'Bot' },
  },
  {
    name: 'clean v2 body',
    body: V2_CLEAN,
    primaryBotLogin: 'copilot',
    matchesHead: true,
    needed: false,
  },
  {
    name: 'off-HEAD review with a suppressed finding',
    body: V2_SUPPRESSED,
    primaryBotLogin: 'copilot',
    matchesHead: false,
    needed: false,
  },
];

test('copilotReviewAckNeeded pins the gate Clause 1 ack term', () => {
  assert.equal(
    copilotReviewAckNeeded({
      suppressedCount: 1,
      bodyShape: 'overview-v2',
      primaryBotLogin: 'copilot',
    }),
    true,
  );
  assert.equal(
    copilotReviewAckNeeded({
      suppressedCount: 0,
      bodyShape: 'unrecognized',
      primaryBotLogin: 'copilot',
    }),
    true,
  );
  assert.equal(
    copilotReviewAckNeeded({
      suppressedCount: 0,
      bodyShape: 'unrecognized',
      primaryBotLogin: 'acme-review',
    }),
    false,
  );
  assert.equal(
    copilotReviewAckNeeded({
      suppressedCount: 0,
      bodyShape: 'overview-v2',
      primaryBotLogin: 'copilot',
    }),
    false,
  );
});

test('reviewAckCovers follows the gate ack check for the six issue cases', () => {
  const reviews = [review({ id: 'r1', body: V2_SUPPRESSED })];
  const cases: Array<{
    name: string;
    comments: ReturnType<typeof comment>[];
    covers: boolean;
  }> = [
    {
      name: 'trusted, unedited, after the review',
      comments: [comment({})],
      covers: true,
    },
    {
      name: 'author outside the trusted set',
      comments: [comment({ login: 'someone-else' })],
      covers: false,
    },
    {
      name: 'marker authored by a login outside the resolved set',
      comments: [comment({ login: 'viewer-bot' })],
      covers: false,
    },
    {
      name: 'edited marker',
      comments: [comment({ lastEditedAt: '2026-10-09T02:30:00Z' })],
      covers: false,
    },
    {
      name: 'marker naming a different SHA',
      comments: [
        comment({
          body: `review-ack: claude-f3ef1280 ${OTHER_HEAD} 2026-10-09T02:00:00Z`,
        }),
      ],
      covers: false,
    },
    {
      name: 'marker created before the review',
      comments: [comment({ createdAt: '2026-10-09T00:30:00Z' })],
      covers: false,
    },
  ];
  for (const testCase of cases) {
    const evidence = resolveLatestPrimaryBotReviewEvidence({
      reviews,
      prHeadSha: HEAD,
      primaryBotLogin: 'copilot',
      comments: testCase.comments,
      trustedMarkerLogins: [TRUSTED],
    });
    assert.ok(evidence, testCase.name);
    assert.equal(evidence.reviewAckCovers, testCase.covers, testCase.name);
  }
});

test('the selector skips error-bodied and reply-only reviews, and reports explicit values', () => {
  const genuine = review({ id: 'r1', body: V2_SUPPRESSED });
  const errorLatest = review({
    id: 'r2',
    body: ERROR_BODY,
    submittedAt: '2026-10-09T01:30:00Z',
  });
  const replyLatest = review({
    id: 'r3',
    body: V2_CLEAN,
    replyOnly: true,
    submittedAt: '2026-10-09T01:40:00Z',
  });

  const withError = resolveLatestPrimaryBotReviewEvidence({
    reviews: [genuine, errorLatest],
    prHeadSha: HEAD,
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.deepEqual(withError, {
    primaryBotLogin: 'copilot',
    reviewId: 'r1',
    commitId: HEAD,
    matchesHead: true,
    bodyShape: 'overview-v2',
    suppressedCount: 1,
    reviewAckNeeded: true,
    reviewAckCovers: false,
  });

  const withReply = resolveLatestPrimaryBotReviewEvidence({
    reviews: [genuine, replyLatest],
    prHeadSha: HEAD,
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.deepEqual(withReply, {
    primaryBotLogin: 'copilot',
    reviewId: 'r1',
    commitId: HEAD,
    matchesHead: true,
    bodyShape: 'overview-v2',
    suppressedCount: 1,
    reviewAckNeeded: true,
    reviewAckCovers: false,
  });
});

test('no counted review, an off-HEAD review, and an uppercase HEAD', () => {
  assert.equal(
    resolveLatestPrimaryBotReviewEvidence({
      reviews: [],
      prHeadSha: HEAD,
      primaryBotLogin: 'copilot',
      comments: [],
      trustedMarkerLogins: [TRUSTED],
    }),
    null,
  );

  const offHead = resolveLatestPrimaryBotReviewEvidence({
    reviews: [review({ id: 'r9', commitId: OTHER_HEAD, body: V2_SUPPRESSED })],
    prHeadSha: HEAD,
    primaryBotLogin: 'copilot',
    comments: [comment({})],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.deepEqual(offHead, {
    primaryBotLogin: 'copilot',
    reviewId: '',
    commitId: OTHER_HEAD,
    matchesHead: false,
    bodyShape: null,
    suppressedCount: 0,
    reviewAckNeeded: false,
    reviewAckCovers: null,
  });

  const upper = resolveLatestPrimaryBotReviewEvidence({
    reviews: [
      review({ id: 'r4', commitId: HEAD.toUpperCase(), body: V2_CLEAN }),
    ],
    prHeadSha: HEAD.toUpperCase(),
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.equal(upper?.matchesHead, true);
});

test('the primary bot login is case-insensitive and a malformed HEAD yields null (#3907)', () => {
  const reviews = [review({ id: 'r7', commitId: HEAD, body: V2_SUPPRESSED })];
  const lower = resolveLatestPrimaryBotReviewEvidence({
    reviews,
    prHeadSha: HEAD,
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  const padded = resolveLatestPrimaryBotReviewEvidence({
    reviews,
    prHeadSha: HEAD,
    primaryBotLogin: ' Copilot ',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.deepEqual(padded, lower);
  assert.equal(padded?.reviewAckNeeded, true);
  const upperHead = resolveLatestPrimaryBotReviewEvidence({
    reviews,
    prHeadSha: HEAD.toUpperCase(),
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.equal(upperHead?.matchesHead, true);
  assert.equal(
    copilotReviewAckNeeded({
      suppressedCount: 0,
      bodyShape: 'unrecognized',
      primaryBotLogin: 'COPILOT',
    }),
    true,
  );
  for (const malformed of ['', 'a'.repeat(39), 'z'.repeat(40)]) {
    assert.equal(
      resolveLatestPrimaryBotReviewEvidence({
        reviews,
        prHeadSha: malformed,
        primaryBotLogin: 'copilot',
        comments: [],
        trustedMarkerLogins: [TRUSTED],
      }),
      null,
    );
  }
});

test('fetchReviewsAndHeadCommit feeds the selector through a fake port', () => {
  const port = {
    getChangeRequestReviewsWithHeadCommitDate: () => ({
      headCommittedAt: '2026-10-09T00:00:00Z',
      reviews: [
        {
          id: 'r1',
          authorLogin: COPILOT,
          authorTypename: 'Bot',
          submittedAt: REVIEW_AT,
          commitId: HEAD,
          commentCount: 0,
          body: V2_SUPPRESSED,
          replyOnly: false,
        },
        {
          id: 'r2',
          authorLogin: COPILOT,
          authorTypename: 'Bot',
          submittedAt: '2026-10-09T01:30:00Z',
          commitId: HEAD,
          commentCount: 0,
          body: ERROR_BODY,
          replyOnly: false,
        },
      ],
    }),
  };
  const { reviews } = fetchReviewsAndHeadCommit(
    'kurone-kito',
    'idd-skill',
    1,
    port,
  );
  const evidence = resolveLatestPrimaryBotReviewEvidence({
    reviews,
    prHeadSha: HEAD,
    primaryBotLogin: 'copilot',
    comments: [],
    trustedMarkerLogins: [TRUSTED],
  });
  assert.equal(evidence?.reviewId, 'r1');
  assert.equal(evidence?.reviewAckNeeded, true);
});

test('the ack rule matches the gate verdict for every row (oracle)', () => {
  for (const row of ACK_ROWS) {
    const reviewAuthor = row.author ?? { login: COPILOT, __typename: 'Bot' };
    const reviewRow = review({
      id: 'oracle',
      author: reviewAuthor,
      body: row.body,
      commitId: row.matchesHead ? HEAD : OTHER_HEAD,
    });
    const evidence = resolveLatestPrimaryBotReviewEvidence({
      reviews: [reviewRow],
      prHeadSha: HEAD,
      primaryBotLogin: row.primaryBotLogin,
      comments: [],
      trustedMarkerLogins: [TRUSTED],
    });
    assert.ok(evidence, row.name);
    assert.equal(evidence.reviewAckNeeded, row.needed, row.name);

    const options: AdvisoryConvergenceOptions = {
      now: NOW,
      primaryBotLogin: row.primaryBotLogin,
      trustedMarkerLogins: [TRUSTED],
      advisoryBotLogins: [],
      prAuthorLogin: '',
      headCommittedAt: REVIEW_AT,
      headObservedAt: REVIEW_AT,
      deadlineMinutes: 1440,
      waiverMode: 'disabled',
      waiverMaxValidity: 'PT24H',
      waiverCheckSelector: 'idd-advisory-convergence',
      resolveWaiverAuthority: () => ({
        outcome: 'found' as const,
        roleName: 'admin',
      }),
    };
    const inputs: AdvisoryConvergenceInputs = {
      prNumber: 1234,
      prHeadSha: HEAD,
      reviews: [reviewRow],
      threads: [],
      comments: [],
      claimEvents: [],
      claimMarkerHistoryPresent: false,
      claimCandidateAmbiguous: false,
    };
    const withoutAck = computeAdvisoryConvergenceVerdict(
      inputs,
      options,
    ).converged;
    const withAck = computeAdvisoryConvergenceVerdict(
      { ...inputs, comments: [comment({})] },
      options,
    ).converged;
    if (row.needed) {
      assert.equal(
        withoutAck,
        false,
        `${row.name}: gate must block without an ack`,
      );
      assert.equal(
        withAck,
        true,
        `${row.name}: gate must pass with a trusted ack`,
      );
    } else {
      assert.equal(
        withAck,
        withoutAck,
        `${row.name}: ack must not change the gate`,
      );
    }
  }
});
