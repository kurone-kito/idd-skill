import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyResolveReviewThread,
  findThreadForComment,
  parseArgs,
  type ResolveReviewThreadReport,
  type ReviewThreadNode,
} from '../src/scripts/resolve-review-thread.mts';
import { loadJson, validate } from '../src/scripts/validate-schemas.mts';

const resultSchema = loadJson('schemas/resolve-review-thread.schema.json');

function thread(
  id: string,
  isResolved: boolean,
  commentDatabaseIds: number[],
): ReviewThreadNode {
  return {
    id,
    isResolved,
    comments: {
      nodes: commentDatabaseIds.map((databaseId) => ({ databaseId })),
    },
  };
}

test('parseArgs reads the call shape and defaults to dry-run', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--body',
    '**Accepted** — fixed in abc1234',
  ]);
  assert.equal(args.pr, 42);
  assert.equal(args.commentId, 1001);
  assert.equal(args.body, '**Accepted** — fixed in abc1234');
  assert.equal(args.apply, false);
});

test('parseArgs reads the apply-mode claim inputs', () => {
  const args = parseArgs([
    '--pr',
    '42',
    '--comment-id',
    '1001',
    '--body',
    'x',
    '--apply',
    '--claim-issue',
    '7',
    '--claim-id',
    'deadbeef',
    '--trusted-marker-logins',
    'kurone-kito, second-user',
  ]);
  assert.equal(args.apply, true);
  assert.equal(args.claimIssue, 7);
  assert.equal(args.claimId, 'deadbeef');
  assert.deepEqual(args.trustedMarkerLogins, ['kurone-kito', 'second-user']);
});

test('findThreadForComment maps a REST comment id to its owning thread', () => {
  const threads = [
    thread('thread-a', false, [900, 901]),
    thread('thread-b', true, [1001, 1002]),
  ];
  const match = findThreadForComment(threads, 1002);
  assert.deepEqual(match, { threadId: 'thread-b', isResolved: true });
});

test('findThreadForComment returns null when no thread owns the comment', () => {
  const threads = [thread('thread-a', false, [900])];
  assert.equal(findThreadForComment(threads, 999), null);
});

test('findThreadForComment ignores missing databaseId nodes safely', () => {
  const threads: ReviewThreadNode[] = [
    {
      id: 'thread-a',
      isResolved: false,
      comments: { nodes: [{ databaseId: null }] },
    },
    { id: 'thread-b', isResolved: false, comments: { nodes: null } },
    thread('thread-c', false, [1001]),
  ];
  assert.deepEqual(findThreadForComment(threads, 1001), {
    threadId: 'thread-c',
    isResolved: false,
  });
});

test('applyResolveReviewThread revalidates the claim before posting, then resolves after the reply', () => {
  const calls: string[] = [];
  const result = applyResolveReviewThread({
    assertClaim: () => {
      calls.push('claim');
    },
    postReply: () => {
      calls.push('reply');
      return { id: 555 };
    },
    resolveThread: () => {
      calls.push('resolve');
    },
  });
  assert.deepEqual(calls, ['claim', 'reply', 'resolve']);
  assert.equal(result.replyId, 555);
});

test('applyResolveReviewThread aborts before any mutation when the claim check throws', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          throw new Error('claim lost');
        },
        postReply: () => {
          calls.push('reply');
          return { id: 1 };
        },
        resolveThread: () => {
          calls.push('resolve');
        },
      }),
    /claim lost/,
  );
  assert.deepEqual(calls, []);
});

test('applyResolveReviewThread does not resolve the thread when the reply fails', () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      applyResolveReviewThread({
        assertClaim: () => {
          calls.push('claim');
        },
        postReply: () => {
          throw new Error('reply failed');
        },
        resolveThread: () => {
          calls.push('resolve');
        },
      }),
    /reply failed/,
  );
  assert.deepEqual(calls, ['claim']);
});

test('the dry-run and apply output envelopes validate against the schema', () => {
  const dryRun: ResolveReviewThreadReport = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 1001,
    threadId: 'thread-b',
    alreadyResolved: false,
  };
  assert.equal(validate(dryRun, resultSchema).length, 0, 'dry-run output');

  const notFound: ResolveReviewThreadReport = {
    mode: 'dry-run',
    prNumber: 7,
    commentId: 999,
    alreadyResolved: false,
    error: 'no review thread found for comment 999 on PR #7',
  };
  assert.equal(validate(notFound, resultSchema).length, 0, 'not-found output');

  const apply: ResolveReviewThreadReport = {
    mode: 'apply',
    prNumber: 7,
    commentId: 1001,
    threadId: 'thread-b',
    alreadyResolved: false,
    status: 'applied',
    replyId: 4242,
  };
  assert.equal(validate(apply, resultSchema).length, 0, 'apply output');
});
