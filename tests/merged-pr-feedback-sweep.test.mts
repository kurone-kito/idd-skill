import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  buildMergedPrFeedbackSweep,
  buildWeeklyBodyOptions,
  type MergedPrInput,
  type MergedPrSweepResult,
  parseArgs,
  renderWeeklySweepIssueBody,
  type SweepReviewInput,
  WEEKLY_SWEEP_ISSUE_TITLE,
} from '../src/scripts/merged-pr-feedback-sweep.mts';
import { CODERABBIT_SUMMARY_MARKER } from '../src/scripts/protocol-helpers.mts';
import { parseWorkflowYamlSubset } from '../src/scripts/workflow-yaml-subset.mts';
import { buildCommentThread } from './test-utils.mts';

const OPTIONS = {
  trustedMarkerActors: ['kurone-kito'],
  advisoryBotLogins: ['coderabbitai[bot]'],
  iddAgentLogins: ['kurone-kito'],
};

const RATE_LIMIT_NOTICE = `${CODERABBIT_SUMMARY_MARKER}\n\n> ## Review limit reached`;
const RATE_LIMIT_DISPOSITION =
  '**Rejected** — coderabbitai[bot] did not review HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa (review limit reached / rate limited); this is not a completed review (source: #issuecomment-100)\n\n<!-- idd-skill-review-reply -->';

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

// #2473: Copilot's inline review-comment replies report a bare, capitalized
// display-name login (`Copilot`) rather than the `[bot]`-suffixed slug login
// (`copilot-pull-request-reviewer[bot]`) its top-level review carries.
// `isKnownReviewBot` previously recognized only the slug form, so a thread
// whose sole comment came from this bare form was misclassified as a
// non-advisory-bot (human) thread.
test('recognizes a review-comment reply carrying the bare "Copilot" display-name login as an advisory bot', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3,
      threads: [
        buildCommentThread(false, [
          {
            login: 'Copilot',
            body: 'This branch is unreachable.',
            createdAt: '2026-06-09T00:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unresolvedThreads.length, 1);
  assert.equal(result.prs[0].unresolvedThreads[0].author, 'copilot');
  assert.equal(result.prs[0].unresolvedThreads[0].advisoryBot, true);
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

test('does not mark an unresolved thread dispositioned on an edited IDD AMD reply', () => {
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
            lastEditedAt: '2026-06-09T02:00:00Z',
          },
        ]),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs[0].unresolvedThreads[0].dispositioned, false);
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
          lastEditedAt: null,
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

test('prefers updatedAt when ordering an unedited IDD disposition', () => {
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
          lastEditedAt: null,
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('does not let an edited IDD disposition address merged feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 18,
      comments: [
        {
          body: 'concern',
          createdAt: '2026-06-09T01:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
        {
          body: '**Rejected** — not applicable.',
          createdAt: '2026-06-09T00:00:00Z',
          updatedAt: '2026-06-09T02:00:00Z',
          lastEditedAt: '2026-06-09T02:00:00Z',
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
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

// kurone-kito/idd-skill#3267: isIddBookkeeping routed through the shared
// classifyIddPrComment, in place of the former unconditional
// `body.startsWith('<!-- idd-')` short-circuit.

test('excludes a trusted historical live-status digest', () => {
  const prs: MergedPrInput[] = [
    {
      number: 14,
      comments: [
        {
          body: '<!-- idd-live-status: historical -->\n\n| Field | Value |\n| --- | --- |\n| Phase | E1 |\n',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'kurone-kito' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('surfaces a GitHub Actions claimed-by comment when either login is an IDD agent', () => {
  for (const login of ['github-actions[bot]', 'github-actions']) {
    const prs: MergedPrInput[] = [
      {
        number: 16,
        comments: [
          {
            body: `<!-- claimed-by: ${login} claim-abc supersedes: none 2026-06-09T00:00:00Z branch: issue/1-test -->\n\n_note_`,
            createdAt: '2026-06-09T00:00:00Z',
            author: { login },
          },
        ],
      },
    ];
    const result = buildMergedPrFeedbackSweep(prs, {
      ...OPTIONS,
      trustedMarkerActors: ['kurone-kito', login],
      iddAgentLogins: ['kurone-kito', login],
    });
    assert.equal(result.prs.length, 1);
    assert.equal(result.prs[0].unaddressedComments.length, 1);
    assert.equal(result.prs[0].unaddressedComments[0].author, login);
  }
});

test('still excludes github-actions cleanup evidence when that login is an IDD agent', () => {
  const prs: MergedPrInput[] = [
    {
      number: 17,
      comments: [
        {
          body: '<!-- idd-cleanup-evidence: applied applied:1 failed:0 -->\n\n_evidence_',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'github-actions[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, {
    ...OPTIONS,
    iddAgentLogins: ['kurone-kito', 'github-actions[bot]'],
  });
  assert.equal(result.prs.length, 0);
});

test('excludes GraphQL github-actions waiver and cleanup evidence from the merged-PR sweep', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3566,
      comments: [
        {
          body: '<!-- idd-external-check-waiver: idd-advisory-convergence head:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa reason:self-referential-bootstrap-auto expires:2099-01-01T00:00:00Z run-id:123456789 claim:none -->',
          createdAt: '2026-09-27T00:00:00Z',
          author: { login: 'github-actions' },
        },
        {
          body: '<!-- idd-cleanup-evidence: complete applied:1 failed:0 skipped:0 viewer-cannot-minimize:0 retry-attempts:0 retry-bound-exhausted:false -->',
          createdAt: '2026-09-27T00:01:00Z',
          author: { login: 'github-actions' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.deepEqual(result.prs, []);
});

test('surfaces an untrusted <!-- idd- comment instead of unconditionally dropping it', () => {
  const prs: MergedPrInput[] = [
    {
      number: 15,
      comments: [
        {
          body: '<!-- idd-live-status: historical -->\n\n| Field | Value |\n| --- | --- |\n| Phase | E1 |\n',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'a-random-outsider' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(
    result.prs[0].unaddressedComments[0].author,
    'a-random-outsider',
  );
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
  // marker text. Only a login in the configured advisory-bot identity set
  // (default: CodeRabbit/Codex) gets the exclusion -- a human posting the
  // same marker text does not qualify.
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
        {
          body: '**Accepted** — coderabbitai[bot] summary walkthrough at HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\n<!-- idd-skill-review-reply -->',
          createdAt: '2026-06-09T00:05:00Z',
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

test('#3572 carries a trusted notice rejection across a restamped updatedAt', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'kurone-kito' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.deepEqual(result.prs, []);
});

test('#3572 keeps a notice visible without a trusted rejection', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3572 does not carry a rejection to a notice with another source id', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 101,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'kurone-kito' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3572 does not carry a known bot rejection when the bot is unconfigured', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'kurone-kito' },
          },
        ],
      },
    ],
    {
      ...OPTIONS,
      advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
    },
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3572 excludes the trusted disposition when its actor is not an IDD agent', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'reviewer' },
          },
        ],
      },
    ],
    {
      ...OPTIONS,
      iddAgentLogins: ['codex-agent'],
    },
  );
  assert.equal(result.prs[0].unaddressedComments.length, 2);
});

test('#3572 keeps a notice visible when its rejection was edited', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: '2026-09-27T08:00:00Z',
            author: { login: 'kurone-kito' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3572 keeps a changed notice visible even when its old rejection is intact', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            body: `${RATE_LIMIT_NOTICE}\n\nA changed notice body`,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T08:02:07Z',
            lastEditedAt: '2026-09-27T08:02:00Z',
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'kurone-kito' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3572 still surfaces a genuine review that replaces a dispositioned notice', () => {
  const result = buildMergedPrFeedbackSweep(
    [
      {
        number: 3572,
        comments: [
          {
            id: 100,
            body: RATE_LIMIT_NOTICE,
            createdAt: '2026-09-27T06:45:28Z',
            updatedAt: '2026-09-27T07:42:07Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
          {
            body: RATE_LIMIT_DISPOSITION,
            createdAt: '2026-09-27T07:34:18Z',
            updatedAt: '2026-09-27T07:34:18Z',
            lastEditedAt: null,
            author: { login: 'kurone-kito' },
          },
          {
            body: 'Please address this genuine review finding.',
            createdAt: '2026-09-27T08:10:00Z',
            updatedAt: '2026-09-27T08:10:00Z',
            lastEditedAt: null,
            author: { login: 'coderabbitai[bot]' },
          },
        ],
      },
    ],
    OPTIONS,
  );
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(
    result.prs[0].unaddressedComments[0].bodyExcerpt,
    'Please address this genuine review finding.',
  );
});

test('a CodeRabbit summary is still surfaced when advisoryBotLogins is configured to omit CodeRabbit', () => {
  // Third Codex finding (raised on this PR's own second review round): the
  // exclusion gates on the *configured* advisoryBotLogins set, not the
  // broader isKnownReviewBot recognition -- matching E6, which requires the
  // author to be in its own configured advisory-bot identities. A Codex-only
  // advisory policy (CodeRabbit deliberately not configured) makes E6 leave a
  // CodeRabbit summary undispositioned, so the sweep must surface it too
  // instead of still excluding it via a hardcoded/broader bot recognition.
  const codexOnlyOptions = {
    ...OPTIONS,
    advisoryBotLogins: ['chatgpt-codex-connector[bot]'],
  };
  const prs: MergedPrInput[] = [
    {
      number: 22,
      comments: [
        {
          body: `${CODERABBIT_SUMMARY_MARKER}\n\n## Walkthrough\n\nRefactors X.`,
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, codexOnlyOptions);
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
          // #3259: a non-primary-bot author, so this stays a test of the
          // state gate alone -- a COMMENTED review from the CONFIGURED
          // primary bot is covered separately below (its thread-less-body
          // classification is a distinct, now-tested surfacing path).
          body: 'overview',
          state: 'COMMENTED',
          submittedAt: '2026-06-09T00:00:00Z',
          author: { login: 'a-human' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

// #2194: a COMMENTED-state review from a configured advisory bot can still
// carry a real finding GitHub embeds directly in the review body -- an
// "Outside diff range comments" block, for content the diff-hunk view
// cannot host as a normal inline review comment.
test('a COMMENTED review with an outside-diff-range block is surfaced', () => {
  const prs: MergedPrInput[] = [
    {
      number: 20,
      reviews: [
        {
          body: '<details><summary>⚠️ Outside diff range comments (1)</summary>\n\nsome finding\n\n</details>',
          state: 'COMMENTED',
          submittedAt: '2026-08-19T00:00:00Z',
          url: 'https://example/r20',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].kind, 'review');
  assert.equal(
    result.prs[0].unaddressedComments[0].author,
    'coderabbitai[bot]',
  );
  assert.equal(result.prs[0].unaddressedComments[0].advisoryBot, true);
});

test('a COMMENTED review from a configured advisory bot without an outside-diff-range block is not feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 21,
      reviews: [
        {
          body: 'Reviewed the changes, no actionable comments posted.',
          state: 'COMMENTED',
          submittedAt: '2026-08-19T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('a COMMENTED review with an outside-diff-range block from a non-configured author is not feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 22,
      reviews: [
        {
          body: '<details><summary>⚠️ Outside diff range comments (1)</summary>\n\nsome finding\n\n</details>',
          state: 'COMMENTED',
          submittedAt: '2026-08-19T00:00:00Z',
          author: { login: 'a-human' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('a COMMENTED review with an outside-diff-range count of 0 is not feedback', () => {
  const prs: MergedPrInput[] = [
    {
      number: 23,
      reviews: [
        {
          body: '<details><summary>⚠️ Outside diff range comments (0)</summary>\n\n</details>',
          state: 'COMMENTED',
          submittedAt: '2026-08-19T00:00:00Z',
          author: { login: 'coderabbitai[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

// --- kurone-kito/idd-skill#3259: thread-less Copilot review-body findings --
//
// Fixture trimmed (badge-image `<picture>` markup stripped, structural text
// kept) from the real PR #3196 review `5288008196` body, fetched live via
// `gh api repos/kurone-kito/idd-skill/pulls/3196/reviews` -- the same
// real-world fixture `tests/advisory-convergence.test.mts`'s own
// `V2_PREVIOUSLY_MISSED_1_BODY` uses.
const COPILOT_LOGIN = 'copilot-pull-request-reviewer[bot]';
const COPILOT_REVIEW_COMMIT = 'a5a56e57267540dc046659c600bcb7c62bdc3949';
const COPILOT_FINAL_HEAD = '8721e9fcb3cc7b33cd5dc9f3c616def626f81c9a';
const COPILOT_OTHER_COMMIT = '05a56e57267540dc046659c600bcb7c62bdc3949';
const COPILOT_REVIEW_SUBMITTED_AT = '2026-09-23T07:21:02Z';
const V2_PREVIOUSLY_MISSED_1_BODY = [
  '<!-- ccr-overview-v2 -->',
  '',
  '## Copilot review overview',
  '',
  '### Needs a closer look',
  '',
  'Address the documented instruction ambiguities and add the missing',
  'policy-schema coverage.',
  '',
  '**Review effort:** Lite',
  '**Findings:** None',
  '',
  '<details>',
  '<summary><strong>Previously missed (1)</strong></summary>',
  '',
  "In code that hasn't changed since last review",
  '',
  '<details>',
  '<summary>Add schema tests for valid and malformed union values</summary>',
  '',
  '`schemas/policy.schema.json:353`',
  '',
  'The new union constraints are not exercised through the policy schema.',
  '</details>',
  '</details>',
].join('\n');

function copilotReviewInput(
  overrides: Partial<SweepReviewInput> = {},
): SweepReviewInput {
  return {
    body: V2_PREVIOUSLY_MISSED_1_BODY,
    state: 'COMMENTED',
    submittedAt: COPILOT_REVIEW_SUBMITTED_AT,
    commitOid: COPILOT_REVIEW_COMMIT,
    author: { login: COPILOT_LOGIN },
    url: 'https://example/pr3196review',
    ...overrides,
  };
}

const CLEAN_COPILOT_BODY = [
  '<!-- ccr-overview-v2 -->',
  '',
  '## Copilot review overview',
  '',
  '**Review effort:** Lite',
  '**Findings:** None',
].join('\n');

function cleanCopilotReviewInput(
  overrides: Partial<SweepReviewInput> = {},
): SweepReviewInput {
  return copilotReviewInput({
    body: CLEAN_COPILOT_BODY,
    commitOid: COPILOT_FINAL_HEAD,
    itemCount: 0,
    ...overrides,
  });
}

test('#3259: a thread-less Copilot "Previously missed" finding is surfaced with no review-ack', () => {
  const prs: MergedPrInput[] = [
    { number: 30, reviews: [copilotReviewInput()] },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].kind, 'review');
  assert.equal(result.prs[0].unaddressedComments[0].author, COPILOT_LOGIN);
  assert.equal(result.prs[0].unaddressedComments[0].advisoryBot, true);
});

const CITATION_FREE_V2_BODY = [
  '<!-- ccr-overview-v2 -->',
  '<details>',
  '<summary><strong>Previously missed (1)</strong></summary>',
  '',
  '<details>',
  '<summary>Rename the helper</summary>',
  '',
  'The name reads poorly next to the neighbouring helper.',
  '</details>',
  '</details>',
].join('\n');

// #3942: a citation-free item is covered by the ack alone, so this case uses one.
test("#3259: a trusted review-ack naming the review's own commit, posted after it, clears the finding", () => {
  const prs: MergedPrInput[] = [
    {
      number: 31,
      reviews: [copilotReviewInput({ body: CITATION_FREE_V2_BODY })],
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: `review-ack: some-agent ${COPILOT_REVIEW_COMMIT} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
          lastEditedAt: null,
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

// #3942: a cited finding (V2_PREVIOUSLY_MISSED_1_BODY names a file) needs its own
// stamped disposition, so a bare ack does not clear it, but a disposition does.
test('#3942: a bare review-ack does not clear a cited thread-less finding', () => {
  const prs: MergedPrInput[] = [
    {
      number: 33,
      reviews: [copilotReviewInput()],
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: `review-ack: some-agent ${COPILOT_REVIEW_COMMIT} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
          lastEditedAt: null,
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
});

test('#3942: a stamped disposition after the review clears a cited thread-less finding', () => {
  const prs: MergedPrInput[] = [
    {
      number: 34,
      reviews: [copilotReviewInput()],
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: `review-ack: some-agent ${COPILOT_REVIEW_COMMIT} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
          lastEditedAt: null,
        },
        {
          author: { login: 'kurone-kito' },
          body: '**Accepted**: fixed in the PR.\n<!-- idd-skill-review-reply -->',
          createdAt: '2026-09-23T08:00:00Z',
          lastEditedAt: null,
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('#3259: a review-ack naming a different commit does not clear the finding', () => {
  const differentCommit = '05a56e57267540dc046659c600bcb7c62bdc3949';
  const prs: MergedPrInput[] = [
    {
      number: 32,
      reviews: [copilotReviewInput()],
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: `review-ack: some-agent ${differentCommit} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3259: a review-ack from an untrusted author does not clear the finding', () => {
  const prs: MergedPrInput[] = [
    {
      number: 33,
      reviews: [copilotReviewInput()],
      comments: [
        {
          author: { login: 'random-user' },
          body: `review-ack: some-agent ${COPILOT_REVIEW_COMMIT} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
});

test('#3259: a missing commitOid fails closed toward reporting, even with an otherwise-matching review-ack', () => {
  const prs: MergedPrInput[] = [
    {
      number: 34,
      reviews: [copilotReviewInput({ commitOid: null })],
      comments: [
        {
          author: { login: 'kurone-kito' },
          body: `review-ack: some-agent ${COPILOT_REVIEW_COMMIT} 2026-09-23T08:00:00Z`,
          createdAt: '2026-09-23T08:00:00Z',
          lastEditedAt: null,
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
});

test('#3259: a healthy Copilot review with no thread-less findings is not surfaced', () => {
  const prs: MergedPrInput[] = [
    { number: 35, reviews: [cleanCopilotReviewInput()] },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('#3564: an older thread-less finding is superseded by a later clean review on the verified effective head', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3507,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({
          commitOid: COPILOT_REVIEW_COMMIT,
          itemCount: 0,
        }),
        cleanCopilotReviewInput({
          submittedAt: '2026-09-27T05:30:00Z',
          url: 'https://example/pr3507/clean',
        }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('#3564: a later clean review on the same head supersedes an earlier thread-less finding', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3508,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_FINAL_HEAD }),
        cleanCopilotReviewInput({ submittedAt: '2026-09-27T05:31:00Z' }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
});

test('#3564: a mixed CHANGES_REQUESTED primary review is not superseded', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3514,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({
          commitOid: COPILOT_REVIEW_COMMIT,
          state: 'CHANGES_REQUESTED',
        }),
        cleanCopilotReviewInput({ submittedAt: '2026-09-27T05:31:00Z' }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3564: a mixed outside-diff primary review is not superseded', () => {
  const options = {
    ...OPTIONS,
    advisoryBotLogins: [COPILOT_LOGIN],
  };
  const prs: MergedPrInput[] = [
    {
      number: 3515,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({
          commitOid: COPILOT_REVIEW_COMMIT,
          body: `${V2_PREVIOUSLY_MISSED_1_BODY}\n\n<details><summary>⚠️ Outside diff range comments (1)</summary>\n\nsome finding\n\n</details>`,
        }),
        cleanCopilotReviewInput({ submittedAt: '2026-09-27T05:32:00Z' }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, options);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3564: an off-head latest review does not supersede an older finding', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3509,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_REVIEW_COMMIT }),
        cleanCopilotReviewInput({ commitOid: COPILOT_OTHER_COMMIT }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3564: a missing effective head fails closed toward reporting', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3510,
      headRefOid: null,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_REVIEW_COMMIT }),
        cleanCopilotReviewInput(),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3564: an incomplete latest review count fails closed toward reporting', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3511,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_REVIEW_COMMIT }),
        cleanCopilotReviewInput({ itemCount: null }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
});

test('#3564: a non-clean latest review leaves every historical finding visible', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3512,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_REVIEW_COMMIT }),
        copilotReviewInput({
          commitOid: COPILOT_FINAL_HEAD,
          submittedAt: '2026-09-27T05:32:00Z',
          url: 'https://example/pr3512/dirty',
        }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 2);
});

test('#3564: an unrecognized latest Copilot body remains fail-closed', () => {
  const prs: MergedPrInput[] = [
    {
      number: 3513,
      headRefOid: COPILOT_FINAL_HEAD,
      reviews: [
        copilotReviewInput({ commitOid: COPILOT_REVIEW_COMMIT }),
        cleanCopilotReviewInput({
          body: 'Reviewed the changes, no actionable comments posted.',
          submittedAt: '2026-09-27T05:33:00Z',
        }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 2);
});

test('#3259: an unrecognized-shape Copilot review is reported under the Copilot default', () => {
  const prs: MergedPrInput[] = [
    {
      number: 36,
      reviews: [
        copilotReviewInput({
          body: 'Reviewed the changes, no actionable comments posted.',
        }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments[0].kind, 'review');
});

test('#3259: an unrecognized-shape review is not reported when primaryBotLogin names a non-Copilot bot (author mismatch)', () => {
  const prs: MergedPrInput[] = [
    {
      number: 37,
      reviews: [
        copilotReviewInput({
          body: 'Reviewed the changes, no actionable comments posted.',
        }),
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, {
    ...OPTIONS,
    primaryBotLogin: 'a-different-bot[bot]',
  });
  assert.equal(result.prs.length, 0);
});

test('#3259: an unrecognized-shape review from the CONFIGURED non-Copilot primary bot is still not reported (unrecognized-shape scoping is Copilot-default-only)', () => {
  const prs: MergedPrInput[] = [
    {
      number: 38,
      reviews: [
        {
          body: 'Reviewed the changes, no actionable comments posted.',
          state: 'COMMENTED',
          submittedAt: COPILOT_REVIEW_SUBMITTED_AT,
          commitOid: COPILOT_REVIEW_COMMIT,
          author: { login: 'a-different-bot[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, {
    ...OPTIONS,
    primaryBotLogin: 'a-different-bot[bot]',
  });
  assert.equal(result.prs.length, 0);
});

test('#3259: a suppressedCount>0 legacy-shape review from a configured non-Copilot primary bot is still reported', () => {
  const legacyBody = [
    '<details><summary>Suppressed comments (1)</summary>',
    '',
    'some finding',
    '',
    '</details>',
  ].join('\n');
  const prs: MergedPrInput[] = [
    {
      number: 39,
      reviews: [
        {
          body: legacyBody,
          state: 'COMMENTED',
          submittedAt: COPILOT_REVIEW_SUBMITTED_AT,
          commitOid: COPILOT_REVIEW_COMMIT,
          author: { login: 'a-different-bot[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, {
    ...OPTIONS,
    primaryBotLogin: 'a-different-bot[bot]',
  });
  assert.equal(result.prs.length, 1);
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

// --- #4161: the weekly summary issue body -------------------------------

const NO_FLAGGED_SUMMARY = {
  flaggedPrCount: 0,
  unresolvedThreadCount: 0,
  unaddressedCommentCount: 0,
};

const RUN_DATE = '2026-10-13';

test('parseArgs: --issue-body is a boolean that defaults to false', () => {
  assert.equal(parseArgs(['--issue-body']).issueBody, true);
  assert.equal(parseArgs([]).issueBody, false);
});

test('renderWeeklySweepIssueBody: the title constant is the agreed summary title', () => {
  assert.equal(WEEKLY_SWEEP_ISSUE_TITLE, 'Merged-PR feedback sweep (weekly)');
});

test('renderWeeklySweepIssueBody: nothing open, with the count checked, says so in one line', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 3, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: '2026-10-06',
      scanLimit: 500,
      enumeratedCount: 3,
      generatedOn: RUN_DATE,
    },
  );
  assert.equal(
    body,
    'None are open as of 2026-10-13 (UTC): none of the 3 pull requests merged since 2026-10-06 has unresolved review threads or unaddressed comments.\n',
  );
});

test('renderWeeklySweepIssueBody: a window with no merges says the scan found none', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 0, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: '2026-10-06',
      scanLimit: 500,
      enumeratedCount: 0,
      generatedOn: RUN_DATE,
    },
  );
  assert.equal(
    body,
    'None are open as of 2026-10-13 (UTC): the scan found no pull request merged since 2026-10-06.\n',
  );
});

test('renderWeeklySweepIssueBody: an explicit PR list with no date names the scanned set and no cap', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 2, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: null,
      scanLimit: null,
      enumeratedCount: 2,
      generatedOn: RUN_DATE,
    },
  );
  assert.equal(
    body,
    'None are open as of 2026-10-13 (UTC): none of the 2 pull requests in the scanned set has unresolved review threads or unaddressed comments.\n',
  );
});

test('renderWeeklySweepIssueBody: an enumeration that reached the cap says so, even when nothing is open', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 500, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: '2026-10-06',
      scanLimit: 500,
      enumeratedCount: 500,
      generatedOn: RUN_DATE,
    },
  );
  assert.match(
    body,
    /^None are open as of 2026-10-13 \(UTC\): none of the 500 pull requests /,
  );
  assert.match(
    body,
    /The scan reached its limit of 500 pull requests, so some merges in the window may not have been checked\./,
  );
  assert.equal(body.split('\n').length, 3);
});

test('renderWeeklySweepIssueBody: the cap is named only when the enumeration reached it', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 3, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: '2026-10-06',
      scanLimit: 500,
      enumeratedCount: 3,
      generatedOn: RUN_DATE,
    },
  );
  assert.doesNotMatch(body, /limit/);
});

test('buildWeeklyBodyOptions: an explicit PR list carries no cap, and a window carries its limit', () => {
  const explicit = buildWeeklyBodyOptions({
    usingExplicitPrs: true,
    limit: 500,
    sinceDate: null,
    enumeratedCount: 2,
    generatedOn: RUN_DATE,
  });
  assert.equal(explicit.scanLimit, null);
  const windowed = buildWeeklyBodyOptions({
    usingExplicitPrs: false,
    limit: 500,
    sinceDate: '2026-10-06',
    enumeratedCount: 500,
    generatedOn: RUN_DATE,
  });
  assert.equal(windowed.scanLimit, 500);
  assert.equal(windowed.enumeratedCount, 500);
  assert.equal(windowed.generatedOn, RUN_DATE);
});

test('renderWeeklySweepIssueBody: a non-empty result lists each flagged PR with counts and no comment text', () => {
  const result: MergedPrSweepResult = {
    prs: [
      {
        number: 1234,
        mergedAt: '2026-10-09T12:00:00Z',
        mergeCommit: null,
        unresolvedThreads: [
          {
            url: 'https://example.invalid/thread-1',
            author: 'coderabbitai[bot]',
            advisoryBot: true,
            path: 'a.ts',
            bodyExcerpt: 'please rename this helper',
            dispositioned: false,
          },
        ],
        unaddressedComments: [
          {
            url: 'https://example.invalid/comment-1',
            author: 'someone',
            advisoryBot: false,
            kind: 'comment',
            bodyExcerpt: 'nit: spacing',
          },
          {
            url: 'https://example.invalid/review-1',
            author: 'someone',
            advisoryBot: false,
            kind: 'review',
            bodyExcerpt: 'second note',
          },
        ],
      },
      {
        number: 1240,
        mergedAt: null,
        mergeCommit: null,
        unresolvedThreads: [],
        unaddressedComments: [
          {
            url: 'https://example.invalid/comment-2',
            author: 'someone',
            advisoryBot: false,
            kind: 'comment',
            bodyExcerpt: 'one more',
          },
        ],
      },
    ],
    summary: {
      prCount: 7,
      flaggedPrCount: 2,
      unresolvedThreadCount: 1,
      unaddressedCommentCount: 3,
    },
  };
  const body = renderWeeklySweepIssueBody(result, {
    sinceDate: '2026-10-06',
    scanLimit: 500,
    enumeratedCount: 7,
    generatedOn: RUN_DATE,
  });
  assert.equal(
    body,
    [
      'Open feedback as of 2026-10-13 (UTC): 2 of 7 pull requests merged since 2026-10-06 with unresolved review threads or unaddressed comments.',
      '',
      '- PR 1234 (merged 2026-10-09): 1 unresolved review thread, 2 unaddressed comments.',
      '- PR 1240: 0 unresolved review threads, 1 unaddressed comment.',
      '',
    ].join('\n'),
  );
  // Plain "PR n" only: a "#n" in the body would cross-reference the pull request.
  assert.doesNotMatch(body, /#\d/);
  // Only numbers, dates, and counts are rendered, never comment text.
  for (const excerpt of [
    'please rename',
    'nit: spacing',
    'second note',
    'one more',
  ]) {
    assert.equal(body.includes(excerpt), false, `leaked: ${excerpt}`);
  }
});

// --- #4161: the summary workflow file, read through the YAML subset reader ---

const SWEEP_WORKFLOW = new URL(
  '../.github/workflows/merged-pr-feedback-sweep.yml',
  import.meta.url,
);

/** A plain copy of a parsed mapping, so assertions compare values, not prototypes. */
function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function readSweepWorkflow(): Record<string, unknown> {
  const parsed = parseWorkflowYamlSubset(readFileSync(SWEEP_WORKFLOW, 'utf8'));
  assert.equal(
    parsed.ok,
    true,
    parsed.ok ? '' : `refused: ${parsed.violation.construct}`,
  );
  return plain(parsed.value) as Record<string, unknown>;
}

interface SweepWorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
}

function sweepSteps(): SweepWorkflowStep[] {
  const job = (readSweepWorkflow().jobs as Record<string, unknown>).sweep as {
    steps: SweepWorkflowStep[];
  };
  return job.steps;
}

function stepNamed(
  steps: SweepWorkflowStep[],
  name: string,
): SweepWorkflowStep {
  const found = steps.find((step) => step.name === name);
  assert.ok(found, `missing step: ${name}`);
  return found;
}

test('the summary workflow is dispatch-only, with the agreed permissions and concurrency', () => {
  const workflow = readSweepWorkflow();
  assert.deepEqual(Object.keys(workflow).sort(), [
    'concurrency',
    'jobs',
    'name',
    'on',
    'permissions',
  ]);
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  // Read-only except for the one issue write; pull-requests read lets the
  // listing return real pull requests (the first dispatch run showed it empty).
  assert.deepEqual(workflow.permissions, {
    contents: 'read',
    issues: 'write',
    'pull-requests': 'read',
  });
  assert.deepEqual(workflow.concurrency, {
    group: 'merged-pr-feedback-sweep',
    'cancel-in-progress': 'false',
  });
});

test('the summary job is active, bounded, and shares the summary title with the script', () => {
  const jobs = readSweepWorkflow().jobs as Record<string, unknown>;
  assert.deepEqual(Object.keys(jobs), ['sweep']);
  const job = jobs.sweep as Record<string, unknown>;
  assert.equal('if' in job, false, 'the job must not be gated off');
  assert.equal(job['runs-on'], 'ubuntu-latest');
  assert.equal(job['timeout-minutes'], '20');
  const env = job.env as Record<string, string>;
  assert.match(env.GH_TOKEN, /^\$\{\{ github\.token \}\}$/);
  assert.equal(env.SWEEP_ISSUE_TITLE, WEEKLY_SWEEP_ISSUE_TITLE);
});

test('the summary job has exactly four named steps, with pinned actions and no other uses', () => {
  const steps = sweepSteps();
  assert.deepEqual(
    steps.map((step) => step.name),
    [
      'Check out the dispatched ref',
      'Set up Node.js',
      'Render the summary issue body',
      'Create or update the summary issue',
    ],
  );
  assert.deepEqual(
    steps.map((step) => step.uses ?? null),
    [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      null,
      null,
    ],
  );
  assert.deepEqual(stepNamed(steps, 'Check out the dispatched ref').with, {
    'persist-credentials': 'false',
  });
  assert.deepEqual(stepNamed(steps, 'Set up Node.js').with, {
    'node-version': '24.x',
  });
});

test('every gh call in the summary job is one issue list, one issue create, and one issue edit, and nothing else writes', () => {
  const scripts = sweepSteps()
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
  const calls = [...scripts.matchAll(/\bgh\s+([a-z-]+)(?:\s+([a-z-]+))?/g)].map(
    (match) => `${match[1]} ${match[2] ?? ''}`.trim(),
  );
  // Counted, not deduplicated: a second create or edit must fail this check.
  assert.deepEqual(calls.sort(), ['issue create', 'issue edit', 'issue list']);
  for (const forbidden of [
    /\bgit\s+(push|commit|tag|branch|checkout|switch|merge|rebase|reset|fetch|clean|stash|worktree|config)\b/,
    /\bcurl\b/,
    /\bwget\b/,
    /\bsecrets\./,
    /\bgh\s+api\b/,
  ]) {
    assert.doesNotMatch(scripts, forbidden);
  }
});

test('the render step runs a seven-day, 500-cap, issue-body sweep into a non-empty body file', () => {
  const run = String(
    stepNamed(sweepSteps(), 'Render the summary issue body').run,
  );
  assert.match(run, /node scripts\/merged-pr-feedback-sweep\.mjs/);
  assert.match(run, /--days 7 \\/);
  assert.match(run, /--limit 500 \\/);
  assert.match(run, /--issue-body > "\$RUNNER_TEMP\/sweep-body\.md"/);
  assert.match(run, /--owner "\$\{GITHUB_REPOSITORY%%\/\*\}"/);
  assert.match(run, /--repo "\$\{GITHUB_REPOSITORY#\*\/\}"/);
  assert.match(run, /test -s "\$RUNNER_TEMP\/sweep-body\.md"/);
});

/** Assert that each expected line appears, trimmed, in the given order. */
function assertLinesInOrder(script: string, expected: readonly string[]): void {
  const lines = script.split('\n').map((line) => line.trim());
  let from = 0;
  for (const want of expected) {
    const at = lines.indexOf(want, from);
    assert.notEqual(at, -1, `missing, or out of order: ${want}`);
    from = at + 1;
  }
}

test('the write step refuses a full, malformed, or duplicated listing, edits the one match, and creates only when none exists', () => {
  const run = String(
    stepNamed(sweepSteps(), 'Create or update the summary issue').run,
  );
  assertLinesInOrder(run, [
    String.raw`listing="$(gh issue list --repo "$GITHUB_REPOSITORY" --state open --limit 1000 --json number,title)"`,
    String.raw`length="$(printf '%s' "$listing" | jq 'length')"`,
    'case "$length" in',
    "''|*[!0-9]*)",
    String.raw`if [ "$length" -ge 1000 ]; then`,
    String.raw`found="$(printf '%s' "$listing" | jq -r --arg t "$SWEEP_ISSUE_TITLE" '[.[] | select(.title == $t) | .number] | sort | .[]')"`,
    String.raw`count="$(printf '%s' "$found" | grep -c . || true)"`,
    String.raw`if [ "$count" -gt 1 ]; then`,
    String.raw`elif [ "$count" -eq 1 ]; then`,
    String.raw`gh issue edit "$found" --repo "$GITHUB_REPOSITORY" --body-file "$RUNNER_TEMP/sweep-body.md"`,
    String.raw`elif [ "$count" -eq 0 ]; then`,
    String.raw`gh issue create --repo "$GITHUB_REPOSITORY" --title "$SWEEP_ISSUE_TITLE" --body-file "$RUNNER_TEMP/sweep-body.md"`,
  ]);
});

test('the cap follows the enumeration, not the pull requests that survived filtering', () => {
  const body = renderWeeklySweepIssueBody(
    { prs: [], summary: { prCount: 2, ...NO_FLAGGED_SUMMARY } },
    {
      sinceDate: '2026-10-06',
      scanLimit: 500,
      enumeratedCount: 500,
      generatedOn: RUN_DATE,
    },
  );
  assert.match(
    body,
    /The scan reached its limit of 500 pull requests, so some merges in the window may not have been checked\./,
  );
});

test('main passes the enumerated count, not the merged count, to the summary body', () => {
  const source = readFileSync(
    new URL('../src/scripts/merged-pr-feedback-sweep.mts', import.meta.url),
    'utf8',
  );
  assert.match(source, /enumeratedCount: targets\.length,/);
});
