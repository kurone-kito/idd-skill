import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildMergedPrFeedbackSweep,
  type MergedPrInput,
  parseArgs,
  type SweepReviewInput,
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

test('surfaces a github-actions claimed-by comment when that login is an IDD agent', () => {
  const prs: MergedPrInput[] = [
    {
      number: 16,
      comments: [
        {
          body: '<!-- claimed-by: github-actions[bot] claim-abc supersedes: none 2026-06-09T00:00:00Z branch: issue/1-test -->\n\n_note_',
          createdAt: '2026-06-09T00:00:00Z',
          author: { login: 'github-actions[bot]' },
        },
      ],
    },
  ];
  const result = buildMergedPrFeedbackSweep(prs, {
    ...OPTIONS,
    trustedMarkerActors: ['kurone-kito', 'github-actions[bot]'],
    iddAgentLogins: ['kurone-kito', 'github-actions[bot]'],
  });
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].unaddressedComments.length, 1);
  assert.equal(
    result.prs[0].unaddressedComments[0].author,
    'github-actions[bot]',
  );
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

test("#3259: a trusted review-ack naming the review's own commit, posted after it, clears the finding", () => {
  const prs: MergedPrInput[] = [
    {
      number: 31,
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
  const healthyBody = [
    '<!-- ccr-overview-v2 -->',
    '',
    '## Copilot review overview',
    '',
    '**Review effort:** Lite',
    '**Findings:** None',
  ].join('\n');
  const prs: MergedPrInput[] = [
    { number: 35, reviews: [copilotReviewInput({ body: healthyBody })] },
  ];
  const result = buildMergedPrFeedbackSweep(prs, OPTIONS);
  assert.equal(result.prs.length, 0);
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
