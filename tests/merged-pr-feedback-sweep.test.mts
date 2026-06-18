import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMergedPrFeedbackSweep,
  type MergedPrInput,
} from '../src/scripts/merged-pr-feedback-sweep.mts';

const OPTIONS = {
  trustedMarkerActors: ['kurone-kito'],
  advisoryBotLogins: ['coderabbitai[bot]'],
  iddAgentLogins: ['kurone-kito'],
};

function thread(
  isResolved: boolean,
  comments: { login: string; body: string; createdAt: string; url?: string }[],
  path = 'src/x.mts',
) {
  return {
    isResolved,
    path,
    comments: {
      nodes: comments.map((c) => ({
        body: c.body,
        url: c.url ?? 'https://example/thread',
        createdAt: c.createdAt,
        author: { login: c.login },
      })),
    },
  };
}

test('surfaces an unresolved reviewer thread with no disposition', () => {
  const prs: MergedPrInput[] = [
    {
      number: 1,
      mergedAt: '2026-06-10T00:00:00Z',
      mergeCommit: 'abc',
      threads: [
        thread(false, [
          {
            login: 'coderabbitai[bot]',
            body: 'This loop can deadlock.',
            createdAt: '2026-06-09T00:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unresolvedThreads.length, 1);
  assert.equal(result.prs[0].unresolvedThreads[0].author, 'coderabbitai[bot]');
  assert.equal(result.prs[0].unresolvedThreads[0].path, 'src/x.mts');
  assert.equal(result.prs[0].unresolvedThreads[0].dispositioned, false);
  assert.equal(result.prs[0].unresolvedThreads[0].advisoryBot, true);
  assert.equal(result.summary.unresolvedThreadCount, 1);
});

test('excludes a resolved thread', () => {
  const prs: MergedPrInput[] = [
    {
      number: 2,
      threads: [
        thread(true, [
          {
            login: 'coderabbitai[bot]',
            body: 'nit',
            createdAt: '2026-06-09T00:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('marks an unresolved thread dispositioned when the agent replied with a marker', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3,
      threads: [
        thread(false, [
          {
            login: 'coderabbitai[bot]',
            body: 'concern',
            createdAt: '2026-06-09T00:00:00Z',
          },
          {
            login: 'kurone-kito',
            body: '**Rejected** — false positive.',
            createdAt: '2026-06-09T01:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs[0].unresolvedThreads[0].dispositioned, true);
});

test('marks an unresolved thread dispositioned on an IDD AMD reply', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3,
      threads: [
        thread(false, [
          {
            login: 'coderabbitai[bot]',
            body: 'concern',
            createdAt: '2026-06-09T00:00:00Z',
          },
          {
            login: 'kurone-kito',
            body: '**Awaiting maintainer decision** — needs a call.',
            createdAt: '2026-06-09T01:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs[0].unresolvedThreads[0].dispositioned, true);
});

test('excludes a thread the IDD agent itself opened', () => {
  const prs: MergedPrInput[] = [
    {
      number: 4,
      threads: [
        thread(false, [
          {
            login: 'kurone-kito',
            body: 'self note',
            createdAt: '2026-06-09T00:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('surfaces a non-IDD regular comment with no later disposition', () => {
  const prs: MergedPrInput[] = [
    {
      number: 5,
      comments: [
        {
          body: 'Did you consider X?',
          url: 'https://example/c',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].kind, 'comment');
  assert.equal(
    result.prs[0].unaddressedComments[0].author,
    'coderabbitai[bot]',
  );
});

test('excludes a comment addressed by a later IDD disposition', () => {
  const prs: MergedPrInput[] = [
    {
      number: 6,
      comments: [
        {
          body: 'Did you consider X?',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          body: '**Rejected** — covered.',
          createdAt: '2026-06-09T02:00:00Z',
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('a later thread-level IDD disposition addresses a top-level comment', () => {
  const prs: MergedPrInput[] = [
    {
      number: 15,
      comments: [
        {
          body: 'Did you consider X?',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
      // The disposition lives inside a (resolved) review thread, not as a
      // top-level comment; it must still count as the "later disposition".
      threads: [
        thread(true, [
          {
            login: 'coderabbitai[bot]',
            body: 'related concern',
            createdAt: '2026-06-09T00:30:00Z',
          },
          {
            login: 'kurone-kito',
            body: '**Accepted** — covered in follow-up.',
            createdAt: '2026-06-09T02:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('surfaces a non-IDD comment that opens with a disposition marker', () => {
  const prs: MergedPrInput[] = [
    {
      number: 14,
      comments: [
        {
          body: '**Rejected** — I disagree with this approach; it breaks X.',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'a-human' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].author, 'a-human');
});

test('a non-disposition IDD comment (e.g. a marker) does not address feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 7,
      comments: [
        {
          body: 'Did you consider X?',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
        // a later IDD comment that is NOT a disposition (operational marker)
        {
          body: '<!-- review-watermark: kurone-kito cid head 2026 1 none -->\n\n_note_',
          createdAt: '2026-06-09T03:00:00Z',
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(
    result.prs[0].unaddressedComments[0].author,
    'coderabbitai[bot]',
  );
});

test('excludes a trusted IDD operational marker comment from the feedback set', () => {
  const prs: MergedPrInput[] = [
    {
      number: 8,
      comments: [
        {
          body: '<!-- claimed-by: kurone-kito cid supersedes: none 2026 branch: issue/1 -->\n\n_claim_',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('excludes an IDD bookkeeping marker even from CI automation', () => {
  const prs: MergedPrInput[] = [
    {
      number: 13,
      comments: [
        {
          body: '<!-- idd-cleanup-evidence: applied applied:1 failed:0 -->\n\n_evidence_',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'github-actions[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('surfaces an unaddressed CHANGES_REQUESTED review body', () => {
  const prs: MergedPrInput[] = [
    {
      number: 9,
      reviews: [
        {
          body: 'please fix',
          url: 'https://example/r',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-06-09T00:00:00Z',
          author: { login: 'a-human' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].kind, 'review');
  assert.equal(result.prs[0].unaddressedComments[0].author, 'a-human');
  assert.equal(result.prs[0].unaddressedComments[0].advisoryBot, false);
});

test('surfaces a comment from a missing/unknown author with author null', () => {
  const prs: MergedPrInput[] = [
    {
      number: 16,
      comments: [
        {
          body: 'This still looks wrong.',
          createdAt: '2026-06-09T00:00:00Z',
          author: null,
        },
      ],
      reviews: [
        {
          body: 'please fix',
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-06-09T00:00:00Z',
          author: null,
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 2);
  for (const finding of result.prs[0].unaddressedComments) {
    assert.equal(finding.author, null);
    assert.equal(finding.advisoryBot, false);
  }
});

test('a COMMENTED (non-CHANGES_REQUESTED) review body is not feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 10,
      reviews: [
        {
          body: 'overview',
          state: 'COMMENTED',
          submittedAt: '2026-06-09T00:00:00Z',
          author: { login: 'copilot-pull-request-reviewer' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('summary aggregates across PRs and skips clean PRs', () => {
  const prs: MergedPrInput[] = [
    {
      number: 11,
      threads: [
        thread(false, [
          { login: 'h', body: 'x', createdAt: '2026-06-09T00:00:00Z' },
        ]),
      ],
      comments: [
        {
          body: 'y',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'h' },
        },
      ],
    },
    {
      number: 12,
      threads: [
        thread(true, [
          { login: 'h', body: 'z', createdAt: '2026-06-09T00:00:00Z' },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.summary.prCount, 2);
  assert.equal(result.summary.flaggedPrCount, 1);
  assert.equal(result.summary.unresolvedThreadCount, 1);
  assert.equal(result.summary.unaddressedCommentCount, 1);
});
