import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FakeProviderFixture } from '../src/scripts/provider-adapter-fake.mts';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import { enrichThreadsWithBotEditHistories } from '../src/scripts/review-thread-edit-histories.mts';

// The shared bounded second pass (#3269, extracted in #3655). The fixture
// models the incident observed on PR #3636: a resolved thread whose
// advisory-bot root comment was edited in place (cosmetically) just after the
// IDD `**Rejected**` reply, then a bot courtesy reply.

const HEAD = 'a'.repeat(40);
const BOT = 'coderabbitai[bot]';
const FINDING = '**Potential issue**: the cache key ignores the host.';

function findingBody(text: string, marker: 'comment' | 'reply'): string {
  return `${text}\n\n<!-- This is an auto-generated ${marker} by CodeRabbit -->`;
}

function history(
  laterText: string,
): NonNullable<FakeProviderFixture['reviewThreadCommentUserContentEdits']> {
  return {
    PRRC_root: {
      commentId: 'PRRC_root',
      totalCount: 2,
      edits: [
        {
          editedAt: '2026-09-30T12:02:44Z',
          diff: findingBody(laterText, 'reply'),
          editorLogin: BOT,
          deletedAt: null,
        },
        {
          editedAt: '2026-09-30T09:29:17Z',
          diff: findingBody(FINDING, 'comment'),
          editorLogin: BOT,
          deletedAt: null,
        },
      ],
    },
  };
}

function fixture(laterText = FINDING): FakeProviderFixture {
  return {
    viewerLogin: 'kurone-kito',
    changeRequestHeadShaAndAuthor: {
      1: { headSha: HEAD, authorLogin: 'author-user' },
    },
    changeRequestReadinessSnapshots: {
      1: {
        headSha: HEAD,
        baseRefName: 'main',
        url: 'https://github.com/o/r/pull/1',
        authorLogin: 'author-user',
        reviewDecision: null,
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        closingIssuesReferences: [],
      },
    },
    branchRules: { 'o/r/main': [] },
    branchProtection: { 'o/r/main': {} },
    reviewsWithHeadCommitDate: {
      1: { reviews: [], headCommittedAt: '2026-09-30T00:00:00Z' },
    },
    repositoryDefaultBranch: 'main',
    reviewThreadsWithComments: {
      1: [
        {
          id: 'RT_courtesy',
          isResolved: true,
          comments: [
            {
              id: 'PRRC_root',
              body: findingBody(laterText, 'reply'),
              createdAt: '2026-09-30T09:29:17Z',
              updatedAt: '2026-09-30T12:02:44Z',
              authorLogin: BOT,
              pullRequestReviewId: null,
              lastEditedAt: '2026-09-30T12:02:44Z',
            },
            {
              id: 'PRRC_disposition',
              body: '**Rejected** — the host is part of the key already.',
              createdAt: '2026-09-30T12:02:38Z',
              updatedAt: '2026-09-30T12:02:38Z',
              authorLogin: 'kurone-kito',
              pullRequestReviewId: null,
              lastEditedAt: null,
            },
            {
              id: 'PRRC_ack',
              body: '`@kurone-kito`, confirmed. Thanks for the explanation.\n\n✅ Review thread resolved.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
              createdAt: '2026-09-30T12:03:05Z',
              updatedAt: '2026-09-30T12:03:05Z',
              authorLogin: BOT,
              pullRequestReviewId: null,
              lastEditedAt: null,
            },
          ],
        },
      ],
    },
  };
}

test('enrichThreadsWithBotEditHistories returns the same array when there is nothing to attach', () => {
  const calls: string[][] = [];
  const port = {
    getReviewThreadCommentUserContentEdits: (ids: string[]) => {
      calls.push(ids);
      return [];
    },
  };
  const threads = [
    {
      id: 'T',
      isResolved: false,
      comments: {
        nodes: [
          {
            id: 'C',
            author: { login: 'reviewer' },
            body: 'x',
            createdAt: '2026-09-30T00:00:00Z',
            updatedAt: '2026-09-30T00:00:00Z',
          },
        ],
      },
    },
  ];
  const result = enrichThreadsWithBotEditHistories(port, threads, {
    dispositionAuthorLogins: ['kurone-kito'],
    advisoryBotLogins: [BOT],
  });
  assert.equal(result, threads);
  assert.deepEqual(calls, []);
});

test('enrichThreadsWithBotEditHistories matches disposition authors case-insensitively', () => {
  const fx = fixture();
  fx.reviewThreadCommentUserContentEdits = history(FINDING);
  const port = createFakeProviderAdapter(fx);
  const threads = port
    .listChangeRequestReviewThreadsWithComments(1)
    .map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      comments: {
        nodes: thread.comments.map((comment) => ({
          id: comment.id,
          author: { login: comment.authorLogin },
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          lastEditedAt: comment.lastEditedAt,
        })),
      },
    }));
  const enriched = enrichThreadsWithBotEditHistories(port, threads, {
    dispositionAuthorLogins: ['Kurone-Kito'],
    advisoryBotLogins: [BOT],
  });
  assert.notEqual(enriched, threads);
  assert.deepEqual(fx.requestedReviewThreadCommentEditHistoryIds, [
    ['PRRC_root'],
  ]);
});
