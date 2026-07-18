import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMergedPrFeedbackSweep,
  type MergedPrInput,
  parseArgs,
} from '../src/scripts/merged-pr-feedback-sweep.mts';
import { CODERABBIT_SUMMARY_MARKER } from '../src/scripts/protocol-helpers.mts';
import { buildCommentThread } from './test-utils.mts';

const OPTIONS = {
  trustedMarkerActors: ['kurone-kito'],
  advisoryBotLogins: ['coderabbitai[bot]'],
  iddAgentLogins: ['kurone-kito'],
};

// --- #1450: migration onto the shared cli-args.mts wrapper -----------------

test('parseArgs: parses --pr (repeatable), --days, and --limit', () => {
  const args = parseArgs(['--pr', '5', '--pr', '9', '--days', '7']);
  assert.deepEqual(args.prNumbers, [5, 9]);
  assert.equal(args.days, 7);
  assert.equal(args.limit, 100);
  assert.equal(args.since, null);
  assert.equal(args.help, false);
});

test('parseArgs: --prs is comma-split and preserves its own error shape', () => {
  const args = parseArgs(['--prs', '5,9']);
  assert.deepEqual(args.prNumbers, [5, 9]);
  assert.throws(
    () => parseArgs(['--prs', '5,bad']),
    /--prs expects comma-separated positive integers, got "bad"/,
  );
});

test('parseArgs: repeated --prs occurrences all accumulate (not just the last)', () => {
  // Regression coverage for a Codex review finding on #1450: a
  // non-multiple parseArgs string flag keeps only the LAST occurrence
  // when repeated, which would silently drop 1 and 2 here.
  const args = parseArgs(['--prs', '1,2', '--prs', '3,4']);
  assert.deepEqual(args.prNumbers, [1, 2, 3, 4]);
});

test('parseArgs: interleaved --prs/--pr occurrences preserve argv order', () => {
  // Regression coverage for a second #1450 review finding: grouping every
  // --pr occurrence before every --prs occurrence silently reordered
  // interleaved input (plural-before-singular is the case that would have
  // been missed by only ever putting --pr first, as the test above does).
  const args = parseArgs(['--prs', '1,2', '--pr', '3']);
  assert.deepEqual(args.prNumbers, [1, 2, 3]);
});

test('parseArgs: the --pr=<value> equals-form is recognized in order', () => {
  const args = parseArgs(['--prs', '1,2', '--pr=3']);
  assert.deepEqual(args.prNumbers, [1, 2, 3]);
});

test('parseArgs: a missing --days value throws', () => {
  assert.throws(() => parseArgs(['--days']));
});

test('parseArgs: a flag-shaped value throws instead of being swallowed', () => {
  // Previously --since would greedily accept '--days' as its literal
  // value, silently leaving --days unset (the #1082 gap this migration
  // closes structurally for this helper).
  assert.throws(() => parseArgs(['--since', '--days', '3']));
});

test('parseArgs: rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--bogus']));
});

test('parseArgs: --help is recognized', () => {
  const args = parseArgs(['--help']);
  assert.equal(args.help, true);
});

test('surfaces an unresolved reviewer thread with no disposition', () => {
  const prs: MergedPrInput[] = [
    {
      number: 1,
      mergedAt: '2026-06-10T00:00:00Z',
      mergeCommit: 'abc',
      threads: [
        buildCommentThread(false, [
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
        buildCommentThread(true, [
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
        buildCommentThread(false, [
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
        buildCommentThread(false, [
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
        buildCommentThread(false, [
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
        buildCommentThread(true, [
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

test('prefers updatedAt when ordering an edited IDD disposition', () => {
  const prs: MergedPrInput[] = [
    {
      number: 17,
      comments: [
        {
          body: 'concern',
          createdAt: '2026-06-09T01:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          // Created BEFORE the concern but edited AFTER it: the disposition
          // must still count as the later disposition (updatedAt wins).
          body: '**Rejected** — not applicable.',
          createdAt: '2026-06-09T00:00:00Z',
          updatedAt: '2026-06-09T02:00:00Z',
          author: { login: 'kurone-kito' },
        },
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

// --- #1488: reuse isReviewSummaryComment so the sweep and E6 agree --------

test('excludes a CodeRabbit summary-walkthrough comment from unaddressedComments', () => {
  const prs: MergedPrInput[] = [
    {
      number: 18,
      comments: [
        {
          body: `${CODERABBIT_SUMMARY_MARKER}\n\n## Walkthrough\n\nRefactors X.`,
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('the summary exclusion is comment-scoped: a genuine comment and an unresolved thread in the same PR are still surfaced', () => {
  const prs: MergedPrInput[] = [
    {
      number: 19,
      threads: [
        buildCommentThread(false, [
          {
            login: 'coderabbitai[bot]',
            body: 'This loop can deadlock.',
            createdAt: '2026-06-09T00:00:00Z',
          },
        ]),
      ],
      comments: [
        {
          body: `${CODERABBIT_SUMMARY_MARKER}\n\n## Walkthrough\n\nRefactors X.`,
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          body: 'Did you consider X?',
          createdAt: '2026-06-09T00:05:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unresolvedThreads.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(
    result.prs[0].unaddressedComments[0].bodyExcerpt,
    'Did you consider X?',
  );
});

test('a non-CodeRabbit author whose comment starts with the summary marker is still surfaced', () => {
  // Codex review finding on #1488's own PR: isReviewSummaryComment matches by
  // body prefix alone, so without an author gate a human (or any other bot)
  // could evade the sweep by starting a comment with CodeRabbit's literal
  // marker text. Only coderabbitai[bot] gets the exclusion.
  const prs: MergedPrInput[] = [
    {
      number: 20,
      comments: [
        {
          body: `${CODERABBIT_SUMMARY_MARKER}\n\nNot actually CodeRabbit.`,
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

test('a CodeRabbit comment carrying both the summary marker and a rate-limit notice is still surfaced', () => {
  // Second Codex finding: E6 (disposition-non-review-notices) classifies a
  // combined summary+rate-limit comment as a non-review notice -- rejected,
  // never accepted as a summary -- so the sweep must not silently drop it
  // via the summary exclusion either (it would otherwise hide an
  // undispositioned notice, contrary to notices staying a genuine signal).
  const prs: MergedPrInput[] = [
    {
      number: 21,
      comments: [
        {
          body: `${CODERABBIT_SUMMARY_MARKER}\n\n> ## Review limit reached`,
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
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
        buildCommentThread(false, [
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
        buildCommentThread(true, [
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
