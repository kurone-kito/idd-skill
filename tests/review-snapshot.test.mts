import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildActivitySnapshotSummary,
  classifyRegularBotComment,
  indexLatestGatingReviewsByAuthor,
  indexThreadsByReview,
} from '../src/scripts/protocol-helpers.mts';

type ReviewLike = Parameters<
  typeof indexLatestGatingReviewsByAuthor
>[0][number];
type ThreadLike = Parameters<typeof indexThreadsByReview>[0][number];
type CommentLike = Parameters<typeof classifyRegularBotComment>[0];

/** Structural view of the snapshot fixtures consumed by this suite. */
interface SnapshotFixture {
  reviews: ReviewLike[];
  threads: ThreadLike[];
  comments: CommentLike[];
}

const acceptedAll = readJson('fixtures/review-snapshots/accepted-all.json');
const changesRequested = readJson(
  'fixtures/review-snapshots/changes-requested.json',
);
const latestGatingReview = readJson(
  'fixtures/review-snapshots/latest-gating-review.json',
);
const truncatedThread = readJson(
  'fixtures/review-snapshots/truncated-thread.json',
);
const newCommentAfterF2 = readJson(
  'fixtures/review-snapshots/new-comment-after-f2.json',
);

test('indexes the latest gating review per author', () => {
  const index = indexLatestGatingReviewsByAuthor(acceptedAll.reviews);
  assert.equal(index.size, 0);

  const changesIndex = indexLatestGatingReviewsByAuthor(
    changesRequested.reviews,
  );
  assert.equal(changesIndex.size, 1);
  assert.equal(changesIndex.get('coderabbitai')?.state, 'CHANGES_REQUESTED');
});

test('indexes review threads by review id', () => {
  const acceptedThreads = indexThreadsByReview(acceptedAll.threads);
  assert.equal(acceptedThreads.get('REVIEW-1')?.total, 1);
  assert.equal(acceptedThreads.get('REVIEW-1')?.unresolved, 0);
  assert.equal(acceptedThreads.get('REVIEW-1')?.missingDisposition, 0);

  const requestedThreads = indexThreadsByReview(changesRequested.threads);
  assert.equal(requestedThreads.get('REVIEW-2')?.total, 1);
  assert.equal(requestedThreads.get('REVIEW-2')?.unresolved, 1);
  assert.equal(requestedThreads.get('REVIEW-2')?.missingDisposition, 1);
});

test('indexThreadsByReview honors an IDD-scoped disposition-author predicate', () => {
  const threads: ThreadLike[] = [
    {
      id: 'T-1',
      isResolved: true,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            author: { login: 'reviewer-a' },
            body: 'please fix',
            createdAt: '2026-05-12T00:00:00Z',
            pullRequestReview: { id: 'REVIEW-9' },
          },
          {
            author: { login: 'reviewer-a' },
            body: '**Accepted** — looks fine',
            createdAt: '2026-05-12T00:00:01Z',
            pullRequestReview: { id: 'REVIEW-9' },
          },
        ],
      },
    },
  ];

  // Loose default accepts any non-bot human's marker as a disposition.
  assert.equal(
    indexThreadsByReview(threads).get('REVIEW-9')?.missingDisposition,
    0,
  );
  // IDD-scoped predicate rejects the reviewer-authored marker, so the thread
  // is missing a disposition.
  const scoped = indexThreadsByReview(threads, {
    isDispositionAuthor: (login) => login === 'idd-bot',
  });
  assert.equal(scoped.get('REVIEW-9')?.missingDisposition, 1);
});

test('classifyRegularBotComment honors an IDD-scoped disposition-author predicate', () => {
  const summary: CommentLike = {
    author: { login: 'coderabbitai[bot]' },
    body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\nWalkthrough of the change.',
    createdAt: '2026-05-12T00:00:00Z',
  };
  const threads: ThreadLike[] = [
    {
      id: 'BT-1',
      isResolved: true,
      comments: {
        pageInfo: { hasNextPage: false },
        nodes: [
          {
            author: { login: 'coderabbitai[bot]' },
            body: 'consider renaming this',
            createdAt: '2026-05-12T00:00:01Z',
          },
          {
            author: { login: 'reviewer-a' },
            body: '**Accepted** — done',
            createdAt: '2026-05-12T00:00:02Z',
          },
        ],
      },
    },
  ];

  // Loose default treats the reviewer-authored marker as a completed
  // disposition, so the bot summary classifies as RESOLVED.
  assert.equal(
    classifyRegularBotComment(summary, [summary], threads)?.classifier,
    'RESOLVED',
  );
  // IDD-scoped predicate rejects it, so there is no completed disposition.
  assert.equal(
    classifyRegularBotComment(summary, [summary], threads, {
      isDispositionAuthor: (login) => login === 'idd-bot',
    }),
    null,
  );
});

test('classifyRegularBotComment IDD-scopes the explicit-disposition path', () => {
  const summary: CommentLike = {
    author: { login: 'coderabbitai[bot]' },
    body: '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n\nWalkthrough of the change.',
    createdAt: '2026-05-12T00:00:00Z',
  };
  // A later top-level disposition mentioning CodeRabbit, authored by a human
  // reviewer rather than an IDD agent.
  const reviewerDisposition: CommentLike = {
    author: { login: 'reviewer-a' },
    body: '**Accepted** — CodeRabbit summary acknowledged',
    createdAt: '2026-05-12T00:01:00Z',
  };
  const comments = [summary, reviewerDisposition];

  // Loose default accepts the reviewer-authored disposition.
  assert.equal(
    classifyRegularBotComment(summary, comments, [])?.classifier,
    'RESOLVED',
  );
  // IDD-scoped predicate rejects it (no completed IDD disposition).
  assert.equal(
    classifyRegularBotComment(summary, comments, [], {
      isDispositionAuthor: (login) => login === 'idd-bot',
    }),
    null,
  );
});

test('tracks latest gating reviews and truncated threads', () => {
  const gatingIndex = indexLatestGatingReviewsByAuthor(
    latestGatingReview.reviews,
  );
  assert.equal(gatingIndex.size, 1);
  assert.equal(gatingIndex.get('coderabbitai')?.state, 'APPROVED');

  const truncatedIndex = indexThreadsByReview(truncatedThread.threads);
  assert.equal(truncatedIndex.get('REVIEW-3')?.total, 1);
  assert.equal(truncatedIndex.get('REVIEW-3')?.unresolved, 1);
  assert.equal(truncatedIndex.get('REVIEW-3')?.missingDisposition, 1);
  assert.equal(truncatedIndex.get('REVIEW-3')?.incomplete, true);
});

test('classifies bot comments against review state and later activity', () => {
  const _acceptedThreads = indexThreadsByReview(acceptedAll.threads);
  const _acceptedReviews = indexLatestGatingReviewsByAuthor(
    acceptedAll.reviews,
  );
  const trigger = {
    author: { login: 'coderabbitai' },
    body: "<!-- This is an auto-generated reply by CodeRabbit -->\n`@kurone-kito` Sure! I'll review the latest fix now.\n\nReview triggered.",
    createdAt: '2026-05-09T18:03:00Z',
  };
  const summary = acceptedAll.comments[0];

  assert.deepEqual(
    classifyRegularBotComment(
      trigger,
      acceptedAll.comments,
      acceptedAll.threads,
    ),
    {
      classifier: 'OUTDATED',
      reason:
        'stale CodeRabbit review-trigger acknowledgement after completed review',
    },
  );
  assert.deepEqual(
    classifyRegularBotComment(
      summary,
      acceptedAll.comments,
      acceptedAll.threads,
    ),
    {
      classifier: 'RESOLVED',
      reason: 'CodeRabbit completed summary reported no actionable comments',
    },
  );

  const newComment = {
    author: { login: 'coderabbitai' },
    body: "<!-- This is an auto-generated reply by CodeRabbit -->\n`@kurone-kito` Sure! I'll review the latest fix now.\n\nReview triggered.",
    createdAt: '2026-05-09T18:03:00Z',
  };
  assert.equal(
    classifyRegularBotComment(
      newComment,
      newCommentAfterF2.comments,
      newCommentAfterF2.threads,
    ),
    null,
  );
});

test('builds activity snapshot metrics with trusted marker filtering', () => {
  const summary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          author: { login: 'idd-bot' },
          body: '<!-- review-watermark: idd-bot claim sha none 0 none -->\n\n_idd-bot: localized marker note without strict format._',
          createdAt: '2026-05-10T10:00:00Z',
          updatedAt: '2026-05-10T10:00:00Z',
        },
        {
          author: { login: 'external-user' },
          body: '<!-- review-watermark: external claim sha none 0 none -->',
          createdAt: '2026-05-10T10:10:00Z',
          updatedAt: '2026-05-10T10:10:00Z',
        },
        {
          author: { login: 'reviewer' },
          body: 'Needs one more fix.',
          createdAt: '2026-05-10T10:20:00Z',
          updatedAt: '2026-05-10T10:20:00Z',
        },
      ],
      reviews: [
        {
          author: { login: 'reviewer' },
          state: 'COMMENTED',
          submittedAt: '2026-05-10T10:15:00Z',
          updatedAt: '2026-05-10T10:35:00Z',
        },
      ],
      threads: [
        {
          id: 'THREAD-3',
          isResolved: false,
          updatedAt: '2026-05-10T10:30:00Z',
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [],
          },
        },
      ],
      checks: [
        { name: 'lint', state: 'SUCCESS', completedAt: '2026-05-10T10:25:00Z' },
        { name: 'test', state: 'IN_PROGRESS', completedAt: null },
      ],
    },
    { trustedMarkerLogins: ['idd-bot'] },
  );

  assert.equal(summary.totalItemCount, 4);
  assert.equal(summary.counts.comments, 2);
  assert.equal(summary.maxActivityUpdatedAt, '2026-05-10T10:35:00Z');
  assert.equal(summary.latestCiCompletedAt, '2026-05-10T10:25:00Z');
  assert.equal(summary.latestPassingCiCompletedAt, '2026-05-10T10:25:00Z');
});

test('malformed forced-handoff comments remain visible activity', () => {
  const summary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          author: { login: 'idd-bot' },
          body: '<!-- forced-handoff: {} -->\n\nPlease fix this handoff marker.',
          createdAt: '2026-05-10T10:40:00Z',
          updatedAt: '2026-05-10T10:40:00Z',
        },
      ],
      reviews: [],
      threads: [],
      checks: [],
    },
    { trustedMarkerLogins: ['idd-bot'] },
  );

  assert.equal(summary.counts.comments, 1);
  assert.equal(summary.totalItemCount, 1);
  assert.equal(summary.maxActivityUpdatedAt, '2026-05-10T10:40:00Z');
});

test('classifies post-disposition advisory-bot comments as ack-only', () => {
  const summary = buildActivitySnapshotSummary(
    {
      comments: [
        {
          id: 'C-1',
          author: { login: 'idd-bot' },
          body: '**Rejected** — rate-limit notice is not a completed review.',
          createdAt: '2026-05-10T10:00:00Z',
          updatedAt: '2026-05-10T10:00:00Z',
        },
        {
          id: 'C-2',
          author: { login: 'advisory-bot' },
          body: 'Thanks for confirming!',
          createdAt: '2026-05-10T09:00:00Z',
          updatedAt: '2026-05-10T10:05:00Z',
        },
      ],
      reviews: [],
      threads: [],
      checks: [],
    },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['advisory-bot'],
      advisoryBotLoginsSource: 'config',
      dispositionAuthorLogins: ['idd-bot'],
    },
  );

  assert.equal(summary.ackOnly.dispositionsPresent, true);
  assert.equal(summary.ackOnly.latestDispositionAt, '2026-05-10T10:00:00Z');
  assert.equal(summary.ackOnly.source, 'config');
  assert.deepEqual(
    summary.ackOnly.items.map((item) => [item.kind, item.id]),
    [['comment', 'C-2']],
  );
  assert.equal(summary.maxActivityUpdatedAt, '2026-05-10T10:05:00Z');
  assert.equal(summary.effective.maxActivityUpdatedAt, '2026-05-10T10:00:00Z');
  assert.equal(summary.totalItemCount, 2);
  assert.equal(summary.effective.totalItemCount, 1);
});

test('ack-only classification matches a configured advisory bot across the [bot] suffix', () => {
  // config stores one form, the bot's courtesy ack arrives in the other — the
  // pre-#1118 raw Set.has() lookup missed this and broke the ack-only carve-out
  // for a custom suffixless-configured bot.
  const make = (configLogin: string, authorLogin: string) =>
    buildActivitySnapshotSummary(
      {
        comments: [
          {
            id: 'C-1',
            author: { login: 'idd-bot' },
            body: '**Rejected** — rate-limit notice is not a completed review.',
            createdAt: '2026-05-10T10:00:00Z',
            updatedAt: '2026-05-10T10:00:00Z',
          },
          {
            id: 'C-2',
            author: { login: authorLogin },
            body: 'Thanks for confirming!',
            createdAt: '2026-05-10T09:00:00Z',
            updatedAt: '2026-05-10T10:05:00Z',
          },
        ],
        reviews: [],
        threads: [],
        checks: [],
      },
      {
        trustedMarkerLogins: ['idd-bot'],
        advisoryBotLogins: [configLogin],
        advisoryBotLoginsSource: 'config',
        dispositionAuthorLogins: ['idd-bot'],
      },
    );

  for (const [configLogin, authorLogin] of [
    ['advisory-bot', 'advisory-bot[bot]'],
    ['advisory-bot[bot]', 'advisory-bot'],
  ] as const) {
    const summary = make(configLogin, authorLogin);
    assert.deepEqual(
      summary.ackOnly.items.map((item) => [item.kind, item.id]),
      [['comment', 'C-2']],
      `config ${configLogin} should ack-classify author ${authorLogin}`,
    );
  }
});

test('ack-only classification fails closed without config or dispositions', () => {
  const comments = [
    {
      id: 'C-1',
      author: { login: 'advisory-bot' },
      body: 'Thanks for confirming!',
      createdAt: '2026-05-10T10:05:00Z',
      updatedAt: '2026-05-10T10:05:00Z',
    },
  ];

  const unconfigured = buildActivitySnapshotSummary(
    { comments, reviews: [], threads: [], checks: [] },
    {
      trustedMarkerLogins: ['idd-bot'],
      dispositionAuthorLogins: ['idd-bot'],
    },
  );
  assert.deepEqual(unconfigured.ackOnly.items, []);
  assert.equal(
    unconfigured.effective.maxActivityUpdatedAt,
    unconfigured.maxActivityUpdatedAt,
  );

  const noDisposition = buildActivitySnapshotSummary(
    { comments, reviews: [], threads: [], checks: [] },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['advisory-bot'],
      dispositionAuthorLogins: ['idd-bot'],
    },
  );
  assert.equal(noDisposition.ackOnly.dispositionsPresent, false);
  assert.deepEqual(noDisposition.ackOnly.items, []);

  const botSelfDisposition = buildActivitySnapshotSummary(
    {
      comments: [
        {
          id: 'C-0',
          author: { login: 'advisory-bot' },
          body: '**Accepted** — looks good.',
          createdAt: '2026-05-10T09:00:00Z',
          updatedAt: '2026-05-10T09:00:00Z',
        },
        ...comments,
      ],
      reviews: [],
      threads: [],
      checks: [],
    },
    {
      trustedMarkerLogins: ['idd-bot'],
      advisoryBotLogins: ['advisory-bot'],
      dispositionAuthorLogins: ['idd-bot', 'advisory-bot'],
    },
  );
  assert.equal(botSelfDisposition.ackOnly.dispositionsPresent, false);
  assert.deepEqual(botSelfDisposition.ackOnly.items, []);
});

test('resolved-thread advisory acks are excluded from effective activity', () => {
  const buildThread = (isResolved: boolean) => ({
    id: 'THREAD-1',
    isResolved,
    updatedAt: '',
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: 'TC-1',
          author: { login: 'advisory-bot' },
          body: 'Consider tightening this check.',
          createdAt: '2026-05-10T09:00:00Z',
          updatedAt: '2026-05-10T09:00:00Z',
        },
        {
          id: 'TC-2',
          author: { login: 'idd-bot' },
          body: '**Accepted** — fixed in abc1234.',
          createdAt: '2026-05-10T10:00:00Z',
          updatedAt: '2026-05-10T10:00:00Z',
        },
        {
          id: 'TC-3',
          author: { login: 'advisory-bot' },
          body: 'Thanks for confirming!',
          createdAt: '2026-05-10T10:05:00Z',
          updatedAt: '2026-05-10T10:05:00Z',
        },
      ],
    },
  });
  const options = {
    trustedMarkerLogins: ['idd-bot'],
    advisoryBotLogins: ['advisory-bot'],
    dispositionAuthorLogins: ['idd-bot'],
  };

  const resolved = buildActivitySnapshotSummary(
    { comments: [], reviews: [], threads: [buildThread(true)], checks: [] },
    options,
  );
  assert.equal(resolved.maxActivityUpdatedAt, '2026-05-10T10:05:00Z');
  assert.equal(resolved.effective.maxActivityUpdatedAt, '2026-05-10T10:00:00Z');
  assert.deepEqual(
    resolved.ackOnly.items.map((item) => [item.kind, item.id]),
    [['thread-reply', 'TC-3']],
  );

  const reopened = buildActivitySnapshotSummary(
    { comments: [], reviews: [], threads: [buildThread(false)], checks: [] },
    options,
  );
  assert.equal(reopened.effective.maxActivityUpdatedAt, '2026-05-10T10:05:00Z');
  assert.deepEqual(reopened.ackOnly.items, []);
});

test('activity snapshot ignores pending check sentinel timestamps', () => {
  const summary = buildActivitySnapshotSummary(
    {
      comments: [],
      reviews: [],
      threads: [],
      checks: [
        { name: 'lint', state: 'PENDING', completedAt: '0001-01-01T00:00:00Z' },
        { name: 'test', state: 'SUCCESS', completedAt: '0001-01-01T00:00:00Z' },
      ],
    },
    { trustedMarkerLogins: ['idd-bot'] },
  );

  assert.equal(summary.latestCiCompletedAt, 'none');
  assert.equal(summary.latestPassingCiCompletedAt, 'none');
});

function readJson(relativePath: string): SnapshotFixture {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
  ) as SnapshotFixture;
}
