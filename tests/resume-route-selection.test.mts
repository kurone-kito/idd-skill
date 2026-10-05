import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFakeProviderAdapter } from '../src/scripts/provider-adapter-fake.mts';
import {
  classifyBranchState,
  collectRoutingInput,
  countLatestChangesRequestedByReviewer,
  selectResumeRoute,
} from '../src/scripts/resume-route-selection.mts';
import { stubExecutable } from './test-utils.mts';

test('routes D4 when no PR and required checks are not generated', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: false,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'D4');
});

test('routes stop when multiple matching open PRs are detected', () => {
  const result = selectResumeRoute({
    prAmbiguous: true,
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'multiple-open-prs-for-issue');
});

test('routes D1 when no PR and clean worktree has unpushed commits', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: false,
  });
  assert.equal(result.route, 'D1');
});

test('routes D4 when no PR and worktree is dirty', () => {
  const result = selectResumeRoute({
    prExists: false,
    requiredChecksGenerated: false,
    hasUnpushedCommits: true,
    worktreeDirty: true,
  });
  assert.equal(result.route, 'D4');
});

test('routes D4 when PR exists, CI is running, and no reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: false,
    reviewPending: false,
  });
  assert.equal(result.route, 'D4');
});

test('routes E15 when PR exists, CI is running, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciRunning: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E15');
});

test('routes E1 when PR exists, CI succeeded, and reviews are pending', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E1');
});

test('routes F2 when PR exists, CI succeeded, no pending reviews, and branch is clean', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'clean',
  });
  assert.equal(result.route, 'F2');
});

test('routes F1 when PR exists, CI succeeded, no pending reviews, and branch is behind without conflict', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'behind-no-conflict',
  });
  assert.equal(result.route, 'F1');
  assert.equal(result.reason, 'pr-ci-success-branch-behind-no-conflict');
});

test('routes Esync when PR exists, CI succeeded, no pending reviews, and branch has content conflict', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'content-conflict',
  });
  assert.equal(result.route, 'Esync');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branch state is dirty', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'dirty',
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branch state is unknown', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'unknown',
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
});

test('routes F1 when PR exists, CI succeeded, no pending reviews, and branch state is computing', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'computing',
  });
  assert.equal(result.route, 'F1');
  assert.equal(result.reason, 'pr-ci-success-branch-computing');
});

test('routes stop when PR exists, CI succeeded, no pending reviews, and branchState is not provided (fail-closed to unknown)', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
  });
  assert.equal(result.route, 'stop');
  assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
  assert.equal(result.state.branchState, 'unknown');
});

test('routes stop when a non-string branchState is supplied (fail-closed to unknown)', () => {
  for (const branchState of [123, null, true, {}, ['clean']]) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: true,
      ciSuccess: true,
      reviewExists: false,
      reviewPending: false,
      branchState,
    });
    assert.equal(result.route, 'stop');
    assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
    assert.equal(result.state.branchState, 'unknown');
  }
});

test('routes stop when an unrecognized branchState string is supplied (fail-closed to unknown)', () => {
  for (const branchState of ['GARBAGE', 'CORRUPT', 'Clean', '']) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: true,
      ciSuccess: true,
      reviewExists: false,
      reviewPending: false,
      branchState,
    });
    assert.equal(result.route, 'stop');
    assert.equal(result.reason, 'pr-ci-success-branch-dirty-or-unknown');
    assert.equal(result.state.branchState, 'unknown');
  }
});

test('routes E15 when PR exists, CI fails, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: true,
    ciFailed: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E15');
});

test('routes E15 when PR exists, required checks are not generated, and reviews exist', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: false,
    reviewExists: true,
  });
  assert.equal(result.route, 'E15');
});

test('routes F2 when no required checks are configured and the present run passes', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: false,
    noRequiredChecksConfigured: true,
    ciSuccess: true,
    reviewExists: false,
    reviewPending: false,
    branchState: 'clean',
  });
  assert.equal(result.route, 'F2');
  assert.equal(result.reason, 'pr-ci-success-no-review-pending');
});

test('routes E1 when no required checks are configured and the present run passes with pending review', () => {
  const result = selectResumeRoute({
    prExists: true,
    requiredChecksGenerated: false,
    noRequiredChecksConfigured: true,
    ciSuccess: true,
    reviewExists: true,
    reviewPending: true,
  });
  assert.equal(result.route, 'E1');
  assert.equal(result.reason, 'pr-ci-success-review-pending');
});

test('routes D4 when no required checks are configured but the present run is empty or unknown', () => {
  for (const input of [
    { ciSuccess: false },
    { ciSuccess: false, ciRunning: false, ciFailed: false },
  ]) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: false,
      noRequiredChecksConfigured: true,
      reviewExists: false,
      reviewPending: false,
      ...input,
    });
    assert.equal(result.route, 'D4');
    assert.equal(result.reason, 'pr-present-run-not-generated');
  }
});

test('routes E15 when the no-required-checks present run is pending or failing and reviews exist', () => {
  for (const input of [{ ciRunning: true }, { ciFailed: true }]) {
    const result = selectResumeRoute({
      prExists: true,
      requiredChecksGenerated: false,
      noRequiredChecksConfigured: true,
      reviewExists: true,
      reviewPending: true,
      ...input,
    });
    assert.equal(result.route, 'E15');
  }
});

function createResumeCollectorPort({
  statusCheckRollup,
  branchRules = [],
  noRequiredChecksConfigured = true,
  openChangeRequests = [
    {
      number: 3150,
      title: 'test PR',
      body: 'Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ],
  baseRefName = 'main',
}: {
  statusCheckRollup: unknown[];
  branchRules?: unknown[];
  noRequiredChecksConfigured?: boolean;
  openChangeRequests?: {
    number: number;
    title: string;
    body: string;
    url: string;
  }[];
  baseRefName?: string;
}) {
  return createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests,
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName,
        statusCheckRollup,
      },
    },
    requiredChecksSummary: {
      3150: { checks: [], noRequiredChecksConfigured },
    },
    branchRules: { 'fake-owner/fake-repo/main': branchRules },
    branchProtection: { 'fake-owner/fake-repo/main': {} },
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });
}

function collectResumePrInput(
  openChangeRequests: {
    number: number;
    title: string;
    body: string;
    url: string;
  }[],
  baseRefName = 'main',
) {
  const port = createResumeCollectorPort({
    statusCheckRollup: [],
    openChangeRequests,
    baseRefName,
  });
  return collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
}

test('collector ignores incidental prose on a PR that closes a different issue', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: 'Closes #3145',
      url: 'https://example.test/pr/3150',
    },
    {
      number: 3151,
      title: 'unrelated PR',
      body: 'Closes #9000\n\nFollow-up context mentions #3145.',
      url: 'https://example.test/pr/3151',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector does not treat a non-closing Refs mention as the implementation PR', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'side-fix PR',
      body: 'Refs #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector rejects closing keyword lookalikes that extend the issue number', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'unrelated PR',
      body: 'Closes #3145abc',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector does not borrow an exact closer from inline code beside a malformed token', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'unrelated PR',
      body: 'Closes #3145abc (example: `Closes #3145`)',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector counts an exact negated close after a malformed closer', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'unrelated PR',
      body: 'Closes #3145abc; this does not close #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector requires a closing keyword before each target reference', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'unrelated PR',
      body: 'Closes #9000, #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector recognizes repeated closing keywords for multiple targets', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: 'Closes #9000, closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector follows D3.5 keyword spacing instead of accepting a colon form', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'unrelated PR',
      body: 'Closes: #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector preserves ambiguity when two open PRs both close the issue', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'first implementation PR',
      body: 'Closes #3145',
      url: 'https://example.test/pr/3150',
    },
    {
      number: 3151,
      title: 'second implementation PR',
      body: 'Fixes #3145',
      url: 'https://example.test/pr/3151',
    },
  ]);

  assert.equal(input.prAmbiguous, true);
  assert.equal(input.prCount, 2);
  assert.equal(selectResumeRoute(input).reason, 'multiple-open-prs-for-issue');
});

test('collector ignores closing-keyword lookalikes in code and quotes', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'example-only PR',
      body: [
        'Inline example: `Closes #3145`',
        '',
        '```md',
        'Closes #3145',
        '```',
        '> Closes #3145',
        '- > Fixes #3145',
        '- [ ] > Resolves #3145',
        '  1. > Closes #3145',
      ].join('\n'),
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector follows D3.5 closing-keyword matching in negated prose', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'negated closing keyword PR',
      body: 'This PR does not close #3145.',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector accepts D3.5 closing keywords followed by a line-wrapped reference', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'line-wrapped closer PR',
      body: 'Closes\n#3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector does not bridge closing keywords across masked code or quotes', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'inline-code separator PR',
      body: 'Closes `example`\n#3145',
      url: 'https://example.test/pr/3150',
    },
    {
      number: 3151,
      title: 'fenced-code separator PR',
      body: 'Closes\n```md\nexample\n```\n#3145',
      url: 'https://example.test/pr/3151',
    },
    {
      number: 3152,
      title: 'blockquote separator PR',
      body: 'Closes\n> quoted interruption\n#3145',
      url: 'https://example.test/pr/3152',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector ignores lazy continuation lines inside a blockquote but scans after a blank line', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '> Example from another PR:\nCloses #3145\n\nCloses #9000',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector keeps non-one ordered markers inside lazy blockquote paragraphs', () => {
  for (const body of [
    '> Quoted prose\n10. Closes #3145',
    '> Quoted prose\n10. not a list\nCloses #3145',
  ]) {
    const input = collectResumePrInput([
      {
        number: 3150,
        title: 'quoted example PR',
        body,
        url: 'https://example.test/pr/3150',
      },
    ]);

    assert.equal(input.prAmbiguous, false);
    assert.equal(input.prCount, 0);
    assert.equal(input.prNumber, null);
  }
});

test('collector still resumes after an interrupting one ordered marker', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '> Quoted prose\n1. Real list item\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector preserves a closer after a non-interrupting ordered lookalike in prose', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: 'Intro paragraph\n10. > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector ignores a quote nested in a non-one list item at a block boundary', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '10. > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector handles large indented code samples without matching their text', () => {
  const indentedCode = Array.from(
    { length: 8_000 },
    (_, index) => `    > sample line ${index}`,
  ).join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: `${indentedCode}\n\nCloses #9000`,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `large indented sample took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

test('collector avoids rescanning long nested ordered lists without quotes', () => {
  const nestedList = [
    '- outer item',
    '  - inner item',
    ...Array.from(
      { length: 8_000 },
      (_, index) => `    ${index + 10}. nested item ${index}`,
    ),
  ].join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: `${nestedList}\n\nCloses #9000`,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `long nested list took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

test('collector avoids rescanning shallow ordered quote runs', () => {
  const orderedQuotes = Array.from(
    { length: 8_000 },
    (_, index) => `10. > quoted item ${index}`,
  ).join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: `${orderedQuotes}\n\nCloses #9000`,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `shallow ordered quote run took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

test('collector avoids rescanning a successful nested quote list zone', () => {
  const nestedQuotes = [
    '- item',
    ...Array.from({ length: 4_000 }, (_, index) => `    > quote${index}`),
  ].join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: nestedQuotes,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `successful list-zone quote run took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

test('collector handles a long run of list-item code without matching its text', () => {
  // The opener's padding makes the item start with indented code, so each
  // 6-space line is code, not a quote (issue #3769).
  const codeLines = Array.from(
    { length: 8_000 },
    (_, index) => `      > continuation ${index}`,
  ).join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: `-     > sample\n${codeLines}\n\nCloses #9000`,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `list-item code run took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

test('collector avoids rescanning for every line that leaves list-item code', () => {
  // A non-interrupting ordered opener sits in no enclosing item, so each
  // exit line would otherwise walk back through every earlier pair.
  const pairs = Array.from(
    { length: 4_000 },
    (_, index) => `  10.     > example ${index}\n    code ${index}`,
  ).join('\n');
  const startedAt = performance.now();
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: `${pairs}\n\nCloses #9000`,
      url: 'https://example.test/pr/3150',
    },
  ]);
  const elapsedMs = performance.now() - startedAt;

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
  assert.ok(
    elapsedMs < 2_000,
    `list-item code exit run took ${elapsedMs.toFixed(1)} ms (limit 2000 ms)`,
  );
});

// Expected verdicts for the bodies below come from GitHub's own Markdown
// renderer, queried on 2026-10-05 for every body with
//   gh api markdown -f mode=gfm -f context=kurone-kito/idd-skill \
//     -f text="$BODY"
// A closing line counts when the rendered reference to #3145 is a link
// outside every blockquote and code element. This test makes no network call
// (issue #3769).
const CLOSING_LINE = 'Closes #3145';
const LIST_MARKERS = ['-', '*', '+', '1.', '1)', '10.'];

interface ClosingShape {
  id: string;
  body: string;
  counted: boolean;
}

function markerShapes(
  family: string,
  paddings: number[],
  body: (marker: string, padding: string) => string,
  counted: boolean,
): ClosingShape[] {
  return LIST_MARKERS.flatMap((marker) =>
    paddings.map((padding) => ({
      id: `${family} ${marker} padded by ${padding}`,
      body: body(marker, ' '.repeat(padding)),
      counted,
    })),
  );
}

function literalShapes(
  family: string,
  bodies: string[],
  counted: boolean,
): ClosingShape[] {
  return bodies.map((body, index) => ({
    id: `${family}#${index + 1}`,
    body,
    counted,
  }));
}

const spaces = (count: number) => ' '.repeat(count);

// Set A: GitHub counts the closing line, the collector used to miss it.
const EXCESS_PADDING_COUNTED: ClosingShape[] = [
  ...markerShapes(
    'A1',
    [5, 6, 8],
    (marker, padding) => `${marker}${padding}> sample\n${CLOSING_LINE}`,
    true,
  ),
  ...literalShapes(
    'A2 tab',
    [
      `-\t    > sample\n${CLOSING_LINE}`,
      `-\t  > sample\n${CLOSING_LINE}`,
      `1.\t   > sample\n${CLOSING_LINE}`,
      `   -\t > sample\n${CLOSING_LINE}`,
      ` -\t   > sample\n${CLOSING_LINE}`,
    ],
    true,
  ),
  ...literalShapes(
    'A3 closing line after the code',
    [
      ...[2, 3, 4, 5].map(
        (indent) => `-     > sample\n${spaces(indent)}${CLOSING_LINE}`,
      ),
      `1.     > sample\n${spaces(6)}${CLOSING_LINE}`,
      ...[6, 7].map(
        (indent) => `- x\n  -     > sample\n${spaces(indent)}${CLOSING_LINE}`,
      ),
      `10.     > sample\n${spaces(7)}${CLOSING_LINE}`,
      ...[3, 5].map(
        (indent) => `   -     > sample\n${spaces(indent)}${CLOSING_LINE}`,
      ),
    ],
    true,
  ),
  ...literalShapes(
    'A4 nested item',
    [`- outer\n  -     > sample\n${CLOSING_LINE}`],
    true,
  ),
  ...literalShapes(
    'A5 two markers',
    [
      `-     - > sample\n${CLOSING_LINE}`,
      `- -     > sample\n${CLOSING_LINE}`,
      `- -  \t> sample\n${CLOSING_LINE}`,
    ],
    true,
  ),
  ...literalShapes(
    'A6 paragraph before',
    [`intro\n-     > sample\n${CLOSING_LINE}`],
    true,
  ),
  ...literalShapes('A7 CRLF', [`-     > sample\r\n${CLOSING_LINE}`], true),
];

// Set B: GitHub renders a quote or code, so the collector must keep ignoring.
const QUOTE_OR_CODE_IGNORED: ClosingShape[] = [
  ...markerShapes(
    'B1',
    [1, 2, 3, 4],
    (marker, padding) => `${marker}${padding}> sample\n${CLOSING_LINE}`,
    false,
  ),
  ...markerShapes(
    'B2',
    [1, 2, 3, 4, 5, 6, 8],
    (marker, padding) => `${marker}${padding}> ${CLOSING_LINE}`,
    false,
  ),
  ...literalShapes(
    'B3',
    ['-     [ ] > Resolves #3145', `-     > ${CLOSING_LINE}\nsecond line`],
    false,
  ),
  ...literalShapes(
    'B4 closing line still in the code',
    [
      ...[6, 8].map(
        (indent) => `-     > sample\n${spaces(indent)}${CLOSING_LINE}`,
      ),
      ...[7, 8].map(
        (indent) => `1.     > sample\n${spaces(indent)}${CLOSING_LINE}`,
      ),
      `- x\n  -     > sample\n${spaces(8)}${CLOSING_LINE}`,
      `10.     > sample\n${spaces(8)}${CLOSING_LINE}`,
      `   -     > sample\n${spaces(4)}${CLOSING_LINE}`,
      ` 10.     > sample\n${spaces(4)}${CLOSING_LINE}`,
      `-     > sample\n\n      ${CLOSING_LINE}`,
    ],
    false,
  ),
  ...literalShapes(
    'B5 tab stops',
    [
      `-\t> sample\n${CLOSING_LINE}`,
      `-\t > sample\n${CLOSING_LINE}`,
      `1.\t > sample\n${CLOSING_LINE}`,
      `- -\t> sample\n${CLOSING_LINE}`,
      `- -\t  > sample\n${CLOSING_LINE}`,
      `  -\t  > sample\n${CLOSING_LINE}`,
      ` -\t  > sample\n${CLOSING_LINE}`,
      `- outer\n  -\t  > sample\n${CLOSING_LINE}`,
    ],
    false,
  ),
  ...literalShapes(
    'B6 ordinary quote',
    [
      `- > sample\n  ${CLOSING_LINE}`,
      `- outer\n  - > sample\n${CLOSING_LINE}`,
      `intro\n- > sample\n${CLOSING_LINE}`,
      `> sample\n${CLOSING_LINE}`,
    ],
    false,
  ),
];

// Set C: GitHub counts the closing line and the collector already did.
const PROSE_COUNTED: ClosingShape[] = [
  ...markerShapes(
    'C1',
    [1, 2, 3, 4, 5, 6, 8],
    (marker, padding) => `${marker}${padding}> sample\n\n${CLOSING_LINE}`,
    true,
  ),
  // Padding of five or more columns without a quote is deliberately absent:
  // GitHub renders code there and the collector counts it, and neither
  // verdict is required (issue #3769, out of scope).
  ...markerShapes(
    'C2',
    [1, 2, 3, 4],
    (marker, padding) => `${marker}${padding}${CLOSING_LINE}`,
    true,
  ),
  ...literalShapes(
    'C3',
    [
      `- outer\n  -     > sample\n\n${CLOSING_LINE}`,
      `>     - > sample\n${CLOSING_LINE}`,
      `-     > sample\n\n  ${CLOSING_LINE}`,
    ],
    true,
  ),
];

// Set D: shapes found while reviewing the rule, each guarding one branch.
const REVIEW_GUARDS: ClosingShape[] = [
  ...(
    [
      [
        'blank line, then a paragraph in the item',
        `-     > sample\n\n    ${CLOSING_LINE}`,
        true,
      ],
      [
        'blank line, then a paragraph one column further',
        `-     > sample\n\n     ${CLOSING_LINE}`,
        true,
      ],
      [
        'blank line inside the code',
        `*     > x\n\n      code\n    ${CLOSING_LINE}`,
        true,
      ],
      [
        'blank line inside the code, tab',
        `-     > sample\n\n       code\n\t${CLOSING_LINE}`,
        true,
      ],
      [
        'fence inside the item',
        `-     > sample\n    \`\`\`\n      ${CLOSING_LINE}`,
        false,
      ],
      [
        'fence inside an item that then ends',
        `   -     > x\n      \`\`\`\n    ${CLOSING_LINE}`,
        false,
      ],
      [
        'fence inside an ordered item',
        `1.     > x\n    \`\`\`\n       ${CLOSING_LINE}`,
        false,
      ],
      ['list inside a real quote', `> -     > x\n      ${CLOSING_LINE}`, false],
      [
        'exit line stays in the outer item',
        `- outer\n    -\t  > sample\n    ${CLOSING_LINE}`,
        true,
      ],
      [
        'second marker, exit line in the item',
        `-   1)        > sample\n      ${CLOSING_LINE}`,
        true,
      ],
      [
        'quote item, then code item',
        `- > real quote\n-     > code\n${CLOSING_LINE}`,
        true,
      ],
      [
        'two code items in a row',
        `-     > sample\n-     > sample2\n${CLOSING_LINE}`,
        true,
      ],
      [
        'paragraph, then an interrupting ordered item',
        `intro\n1.     > sample\n${CLOSING_LINE}`,
        true,
      ],
      [
        'tab-indented nested item',
        `- outer\n\t-     > sample\n${CLOSING_LINE}`,
        true,
      ],
      [
        'third-level item',
        `- a\n  - b\n    -     > sample\n    ${CLOSING_LINE}`,
        true,
      ],
      ['tab after the quote marker', `-     >\tsample\n${CLOSING_LINE}`, true],
      [
        'CRLF code continuation',
        `-     > sample\r\n      more\r\n${CLOSING_LINE}`,
        true,
      ],
      [
        'task checkbox after the padding',
        `-     [ ] > sample\n${CLOSING_LINE}`,
        true,
      ],
      [
        'exit line inside a nested item the zone lookup cannot see',
        `- outer\n   *     > sample\n     ${CLOSING_LINE}`,
        true,
      ],
      [
        'list code inside a real quote, closing line outside it',
        `> -     > x\n  ${CLOSING_LINE}`,
        true,
      ],
      [
        'list code inside a real quote, code line, then the closing line',
        `> -     > x\n      code\n${CLOSING_LINE}`,
        true,
      ],
      [
        'list code inside a nested real quote item',
        `> - x\n>   -     > y\n${CLOSING_LINE}`,
        true,
      ],
      [
        'tab stops after a quote marker, four columns of padding',
        `> -\t  > x\n${CLOSING_LINE}`,
        false,
      ],
      [
        'tab stops after a quote marker, five columns of padding',
        `>  -\t > x\n${CLOSING_LINE}`,
        true,
      ],
      [
        'two tabs after a marker inside a quote',
        `> -\t\t> x\n${CLOSING_LINE}`,
        true,
      ],
      [
        'code line, blank line, then a paragraph in the item',
        `-     > x\n       code\n\n    ${CLOSING_LINE}`,
        true,
      ],
      [
        'code line, blank line, then a paragraph in an ordered item',
        `1.     > x\n        code\n\n      ${CLOSING_LINE}`,
        true,
      ],
      [
        'non-interrupting ordered marker under an item paragraph',
        `- outer\n  10.     > sample\n\n      ${CLOSING_LINE}`,
        false,
      ],
      [
        'non-interrupting ordered marker under a quote paragraph',
        `> quote\n> 10.        > x\n${CLOSING_LINE}`,
        false,
      ],
      [
        'paragraph text that starts like an ordered item, closer inside',
        `- outer\n  10. > ${CLOSING_LINE}`,
        true,
      ],
      [
        'paragraph text that starts like an ordered item, closer below',
        `- outer\n  10. > sample\n${CLOSING_LINE}`,
        true,
      ],
      [
        'ordered marker after a quote paragraph, no quote marker of its own',
        `> intro\n2.     > sample\n${CLOSING_LINE}`,
        true,
      ],
      [
        'ordered marker left of the item content starts a new list',
        `- outer\n10. > sample\n${CLOSING_LINE}`,
        false,
      ],
      [
        'a second non-interrupting ordered marker stays text',
        `- outer\n  10. a\n  11.     > sample\n\n      ${CLOSING_LINE}`,
        false,
      ],
    ] satisfies [string, string, boolean][]
  ).map(([note, body, counted], index) => ({
    id: `D${index + 1} ${note}`,
    body,
    counted,
  })),
];

function assertClosingShapes(shapes: ClosingShape[]) {
  for (const { id, body, counted } of shapes) {
    // The table only exercises Markdown handling, so skip the local git
    // commands the collector would otherwise run for every row.
    const input = collectRoutingInput({
      port: createResumeCollectorPort({
        statusCheckRollup: [],
        openChangeRequests: [
          {
            number: 3150,
            title: 'closing line shape',
            body,
            url: 'https://example.test/pr/3150',
          },
        ],
      }),
      issueNumber: 3145,
      loadTrustedConfig: () => null,
      collectGitState: () => ({
        hasUnpushedCommits: false,
        worktreeDirty: false,
      }),
    });
    assert.equal(input.prAmbiguous, false, `${id}: ${JSON.stringify(body)}`);
    assert.equal(
      input.prCount,
      counted ? 1 : 0,
      `${id}: ${JSON.stringify(body)}`,
    );
  }
}

test('collector keeps the table of closing-line shapes complete and distinct', () => {
  const all = [
    EXCESS_PADDING_COUNTED,
    QUOTE_OR_CODE_IGNORED,
    PROSE_COUNTED,
    REVIEW_GUARDS,
  ].flat();
  assert.deepEqual(
    [
      EXCESS_PADDING_COUNTED.length,
      QUOTE_OR_CODE_IGNORED.length,
      PROSE_COUNTED.length,
      REVIEW_GUARDS.length,
    ],
    [39, 89, 69, 34],
  );
  assert.equal(new Set(all.map(({ body }) => body)).size, all.length);
});

test('collector counts a closing line after list padding that makes code', () => {
  assertClosingShapes(EXCESS_PADDING_COUNTED);
});

test('collector still ignores a quote or code that holds the closing line', () => {
  assertClosingShapes(QUOTE_OR_CODE_IGNORED);
});

test('collector still counts a closing line that GitHub renders as prose', () => {
  assertClosingShapes(PROSE_COUNTED);
});

test('collector follows the rule through the shapes found in review', () => {
  assertClosingShapes(REVIEW_GUARDS);
});

test('collector drops a cached outer list zone after a nested list marker', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '- outer\n    > quoted\n  - inner\n      > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector resumes scanning after a blockquote paragraph is interrupted', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '> Example from another PR:\n# Real implementation\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector resumes after spaced thematic breaks and custom HTML blocks', () => {
  for (const body of [
    '> Quoted prose\n- - -\nCloses #3145',
    '> <widget>\nCloses #3145',
  ]) {
    const input = collectResumePrInput([
      {
        number: 3150,
        title: 'implementation PR',
        body,
        url: 'https://example.test/pr/3150',
      },
    ]);

    assert.equal(input.prAmbiguous, false);
    assert.equal(input.prCount, 1);
    assert.equal(input.prNumber, 3150);
  }
});

test('collector resumes after interrupting HTML block openers', () => {
  for (const opener of ['<![CDATA[', '<search>', '<frameset>']) {
    const input = collectResumePrInput([
      {
        number: 3150,
        title: 'implementation PR',
        body: `> Quoted prose\n${opener}\nCloses #3145`,
        url: 'https://example.test/pr/3150',
      },
    ]);

    assert.equal(input.prAmbiguous, false, opener);
    assert.equal(input.prCount, 1, opener);
    assert.equal(input.prNumber, 3150, opener);
  }
});

test('collector keeps custom HTML tags inside an open quoted paragraph', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '> Quoted prose\n<widget>\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector scans real prose after a quoted indented code block', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '>     quoted code\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector does not let an indented code block open a blockquote continuation', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '    > quoted code\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector keeps lazy continuation lines inside quoted list items', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '> - example\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector keeps indented lazy continuation inside a quoted paragraph', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '> quoted paragraph\n    continuation\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector keeps block-shaped indented lazy continuations inside quotes', () => {
  for (const blockLikeLine of [
    '    # heading',
    '    ```',
    '    > nested quote',
    '    ---',
    '    <div>',
  ]) {
    const input = collectResumePrInput([
      {
        number: 3150,
        title: 'quoted example PR',
        body: `> quoted paragraph\n${blockLikeLine}\nCloses #3145`,
        url: 'https://example.test/pr/3150',
      },
    ]);

    assert.equal(input.prAmbiguous, false, blockLikeLine);
    assert.equal(input.prCount, 0, blockLikeLine);
    assert.equal(input.prNumber, null, blockLikeLine);
  }
});

test('collector masks a quote nested in a list after an indented code block', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '    example\n10. outer\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector treats mixed tab and space indentation as indented code', () => {
  for (const codeLine of ['\t  > quoted code', '    \t> quoted code']) {
    const input = collectResumePrInput([
      {
        number: 3150,
        title: 'implementation PR',
        body: `${codeLine}\nCloses #3145`,
        url: 'https://example.test/pr/3150',
      },
    ]);

    assert.equal(input.prAmbiguous, false, codeLine);
    assert.equal(input.prCount, 1, codeLine);
    assert.equal(input.prNumber, 3150, codeLine);
  }
});

test('collector ignores blockquotes indented at a nested list content boundary', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '- outer\n  - inner\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector keeps blockquote-shaped indented code inside a nested list visible as code', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '- outer\n  - inner\n        > example\n\nCloses #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector ignores blockquotes indented under a non-one ordered list', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'implementation PR',
      body: '10. outer\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector recognizes non-one ordered lists after a heading without treating paragraph lookalikes as lists', () => {
  const listInput = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '# Heading\n10. outer\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);
  const paragraphInput = collectResumePrInput([
    {
      number: 3150,
      title: 'visible prose PR',
      body: 'Intro paragraph\n10. not a list\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(listInput.prCount, 0);
  assert.equal(listInput.prNumber, null);
  assert.equal(paragraphInput.prCount, 1);
  assert.equal(paragraphInput.prNumber, 3150);
});

test('collector ignores a blockquote under a later non-one ordered-list item', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'quoted example PR',
      body: '10. first\n11. second\n    > Closes #3145',
      url: 'https://example.test/pr/3150',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 0);
  assert.equal(input.prNumber, null);
});

test('collector recognizes the body keyword on a non-default development branch', () => {
  const input = collectResumePrInput(
    [
      {
        number: 3150,
        title: 'development PR',
        body: 'Resolves #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    'develop',
  );

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

test('collector accepts qualified closing refs only for the current repository', () => {
  const input = collectResumePrInput([
    {
      number: 3150,
      title: 'local qualified implementation PR',
      body: 'Closes fake-owner/fake-repo#3145',
      url: 'https://example.test/pr/3150',
    },
    {
      number: 3151,
      title: 'foreign qualified PR',
      body: 'Fixes other-owner/other-repo#3145',
      url: 'https://example.test/pr/3151',
    },
  ]);

  assert.equal(input.prAmbiguous, false);
  assert.equal(input.prCount, 1);
  assert.equal(input.prNumber, 3150);
});

function checkRun(
  name: string,
  workflowName: string,
  status: string,
  conclusion: string | null,
  workflowPath:
    | string
    | null = `.github/workflows/${workflowName || 'workflow'}.yml`,
) {
  return {
    __typename: 'CheckRun',
    name,
    workflowName,
    workflowPath,
    status,
    conclusion,
    completedAt: conclusion ? '2026-09-19T12:00:00Z' : null,
    detailsUrl: `https://example.test/${workflowName}/${name}`,
  };
}

test('collector resolves protection-read policy from the PR base ref', () => {
  const port = createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests: [
      {
        number: 3150,
        title: 'test PR',
        body: 'Closes #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName: 'main',
        statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
      },
    },
    requiredChecksSummary: {
      3150: { checks: [], noRequiredChecksConfigured: true },
    },
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });
  const seenRefs: string[] = [];

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: (owner, repo, ref) => {
      assert.deepEqual(
        { owner, repo },
        {
          owner: 'fake-owner',
          repo: 'fake-repo',
        },
      );
      seenRefs.push(ref);
      return null;
    },
  });

  assert.deepEqual(seenRefs, ['main']);
  assert.equal(input.noRequiredChecksConfigured, false);
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector uses the default branch for empty base-ref governance reads', () => {
  const port = createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests: [
      {
        number: 3150,
        title: 'test PR',
        body: 'Closes #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName: '',
        statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
      },
    },
    requiredChecksSummary: {
      3150: { checks: [], noRequiredChecksConfigured: true },
    },
    branchRules: { 'fake-owner/fake-repo/trunk': [] },
    branchProtection: { 'fake-owner/fake-repo/trunk': {} },
    repositoryDefaultBranch: 'trunk',
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });
  const seenRefs: string[] = [];

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: (_owner, _repo, ref) => {
      seenRefs.push(ref);
      return null;
    },
  });

  assert.deepEqual(seenRefs, ['trunk']);
  assert.equal(input.noRequiredChecksConfigured, true);
  assert.equal(input.ciSuccess, true);
  assert.equal(selectResumeRoute(input).route, 'F2');
});

test('collector fails closed when governance reads return permission denied', () => {
  for (const unreadableRead of ['branchRules', 'branchProtection'] as const) {
    const port = createResumeCollectorPort({
      statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
    });
    if (unreadableRead === 'branchRules') {
      port.listBranchRules = () => {
        const error = new Error('Forbidden (HTTP 403)') as Error & {
          status?: number;
        };
        error.status = 403;
        throw error;
      };
    } else {
      port.getBranchProtection = () => {
        const error = new Error('Forbidden (HTTP 403)') as Error & {
          status?: number;
        };
        error.status = 403;
        throw error;
      };
    }

    const input = collectRoutingInput({
      port,
      issueNumber: 3145,
      loadTrustedConfig: () => null,
    });
    assert.equal(input.noRequiredChecksConfigured, false);
    assert.equal(input.ciSuccess, false);
    assert.equal(selectResumeRoute(input).route, 'D4');
  }
});

test('collector discovers no required checks from protection and routes present-run success', () => {
  const port = createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests: [
      {
        number: 3150,
        title: 'test PR',
        body: 'Closes #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName: 'main',
        statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
      },
    },
    requiredChecksSummary: {
      3150: { checks: [], noRequiredChecksConfigured: true },
    },
    branchRules: { 'fake-owner/fake-repo/main': [] },
    branchProtection: { 'fake-owner/fake-repo/main': {} },
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, true);
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(input.ciSuccess, true);
  assert.deepEqual(input.ciChecks, [
    {
      name: 'ci',
      state: 'SUCCESS',
      completedAt: '2026-09-19T12:00:00Z',
    },
  ]);
  assert.equal(selectResumeRoute(input).route, 'F2');
});

test('collector keeps empty and pending no-required present runs fail-closed', () => {
  for (const statusCheckRollup of [
    [],
    [checkRun('ci', 'workflow', 'IN_PROGRESS', null)],
  ]) {
    const port = createResumeCollectorPort({ statusCheckRollup });

    const input = collectRoutingInput({
      port,
      issueNumber: 3145,
      loadTrustedConfig: () => null,
    });
    assert.equal(selectResumeRoute(input).route, 'D4');
  }
});

test('collector keeps configured required checks fail-closed when no required run exists', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      checkRun('optional-ci', 'workflow', 'COMPLETED', 'SUCCESS'),
    ],
    branchRules: [
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'required-ci' }] },
      },
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, false);
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(input.ciSuccess, false);
  assert.equal(
    selectResumeRoute(input).reason,
    'pr-required-checks-not-generated',
  );
});

test('collector retains same-named present runs from different workflows', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      checkRun('ci', 'workflow-a', 'COMPLETED', 'SUCCESS'),
      checkRun('ci', 'workflow-b', 'IN_PROGRESS', null),
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, true);
  assert.equal(input.ciRunning, true);
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector retains same-named runs from different workflow paths', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      checkRun(
        'ci',
        'shared-workflow',
        'COMPLETED',
        'SUCCESS',
        '.github/workflows/ci-a.yml',
      ),
      checkRun(
        'ci',
        'shared-workflow',
        'IN_PROGRESS',
        null,
        '.github/workflows/ci-b.yml',
      ),
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.ciRunning, true);
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector fails closed when a present check run lacks workflow identity', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS', null),
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector accepts a passing external app check run without a workflow path', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      {
        ...checkRun('external-ci', '', 'COMPLETED', 'SUCCESS', null),
        appSlug: 'external-ci-app',
        workflowRunPresent: false,
      },
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.ciSuccess, true);
  assert.equal(selectResumeRoute(input).route, 'F2');
});

test('collector retains same-named check runs and status contexts', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [
      checkRun('ci', '', 'COMPLETED', 'SUCCESS'),
      {
        __typename: 'StatusContext',
        context: 'ci',
        state: 'PENDING',
        targetUrl: 'https://example.test/status/ci',
      },
    ],
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, true);
  assert.equal(input.ciRunning, true);
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector keeps an ambiguous empty required-check summary fail-closed', () => {
  const port = createResumeCollectorPort({
    statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
    noRequiredChecksConfigured: false,
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, false);
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector keeps disagreement between summary and governance fail-closed', () => {
  const port = createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests: [
      {
        number: 3150,
        title: 'test PR',
        body: 'Closes #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName: 'main',
        statusCheckRollup: [checkRun('ci', 'workflow', 'COMPLETED', 'SUCCESS')],
      },
    },
    requiredChecksSummary: {
      3150: {
        checks: [
          { name: 'ci', state: 'SUCCESS', completedAt: '2026-09-19T12:00:00Z' },
        ],
        noRequiredChecksConfigured: false,
      },
    },
    branchRules: { 'fake-owner/fake-repo/main': [] },
    branchProtection: { 'fake-owner/fake-repo/main': {} },
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.noRequiredChecksConfigured, false);
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('collector keeps mismatched required-check names fail-closed', () => {
  const port = createFakeProviderAdapter({
    locator: { provider: 'github', owner: 'fake-owner', name: 'fake-repo' },
    viewerLogin: 'tester',
    openChangeRequests: [
      {
        number: 3150,
        title: 'test PR',
        body: 'Closes #3145',
        url: 'https://example.test/pr/3150',
      },
    ],
    changeRequestBranchAndChecks: {
      3150: {
        headSha: 'head-sha',
        baseRefName: 'main',
        statusCheckRollup: [
          checkRun('required-ci', 'workflow', 'COMPLETED', 'SUCCESS'),
        ],
      },
    },
    requiredChecksSummary: {
      3150: {
        checks: [
          {
            name: 'required-ci',
            state: 'SUCCESS',
            completedAt: '2026-09-19T12:00:00Z',
          },
        ],
        noRequiredChecksConfigured: false,
      },
    },
    branchRules: {
      'fake-owner/fake-repo/main': [
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'other-ci' }] },
        },
      ],
    },
    branchProtection: { 'fake-owner/fake-repo/main': {} },
    changeRequests: {
      3150: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' },
    },
  });

  const input = collectRoutingInput({
    port,
    issueNumber: 3145,
    loadTrustedConfig: () => null,
  });
  assert.equal(input.requiredChecksGenerated, false);
  assert.equal(input.ciSuccess, false);
  assert.equal(selectResumeRoute(input).route, 'D4');
});

test('classifyBranchState returns clean for CLEAN mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }),
    'clean',
  );
});

test('classifyBranchState returns behind-no-conflict for BEHIND mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' }),
    'behind-no-conflict',
  );
});

test('classifyBranchState returns content-conflict for CONFLICTING mergeable', () => {
  assert.equal(
    classifyBranchState({
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
    }),
    'content-conflict',
  );
});

test('classifyBranchState returns dirty for DIRTY mergeStateStatus', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' }),
    'dirty',
  );
});

test('classifyBranchState returns clean for BLOCKED MERGEABLE (non-git-conflict block)', () => {
  assert.equal(
    classifyBranchState({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    }),
    'clean',
  );
});

test('classifyBranchState returns unknown for genuinely missing state', () => {
  // No payload, or a payload with no `mergeable` field at all (undefined):
  // genuinely missing/unparseable, so it stays terminal `unknown`.
  assert.equal(classifyBranchState(null), 'unknown');
  assert.equal(classifyBranchState({}), 'unknown');
  assert.equal(classifyBranchState({ mergeStateStatus: 'UNKNOWN' }), 'unknown');
});

test('classifyBranchState returns computing for transient UNKNOWN/null mergeable', () => {
  assert.equal(
    classifyBranchState({ mergeable: 'UNKNOWN', mergeStateStatus: '' }),
    'computing',
  );
  assert.equal(
    classifyBranchState({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }),
    'computing',
  );
  // An explicit `null` mergeable on a present payload is GitHub still
  // computing, not a missing payload, so it is transient `computing`.
  assert.equal(
    classifyBranchState({ mergeable: null, mergeStateStatus: 'UNKNOWN' }),
    'computing',
  );
});

test("counts CHANGES_REQUESTED using each reviewer's latest gating state", () => {
  const count = countLatestChangesRequestedByReviewer([
    {
      user: { login: 'alice' },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-05-12T10:00:00Z',
    },
    {
      user: { login: 'alice' },
      state: 'APPROVED',
      submitted_at: '2026-05-12T11:00:00Z',
    },
    {
      user: { login: 'bob' },
      state: 'CHANGES_REQUESTED',
      submitted_at: '2026-05-12T09:00:00Z',
    },
  ]);
  assert.equal(count, 1);
});

// #2195: --token substituted GH_TOKEN/GITHUB_TOKEN for gh auth, ambiguous
// against select-desynced-index.mjs's unrelated same-named session-desync
// token. --gh-token is now canonical; --token stays a deprecated alias for
// one release. A fake `gh` on PATH dumps GH_TOKEN/GITHUB_TOKEN to a side
// file before failing (any real network call is out of scope for this
// flag-propagation test), so the CLI process always exits non-zero -- only
// the dumped env values matter here.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function ghTokenPropagationFixture() {
  const tempRoot = mkdtempSync(
    join(tmpdir(), 'idd-resume-route-selection-token-'),
  );
  const dumpPath = join(tempRoot, 'env-dump.json');
  const restore = stubExecutable(
    'gh',
    `require('fs').writeFileSync(process.env.ENV_DUMP_PATH, JSON.stringify({
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
}));
process.exit(1);
`,
  );
  return {
    dumpPath,
    restore: () => {
      restore();
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

function runResumeRouteSelectionCli(
  extraArgs: string[],
  fixture: ReturnType<typeof ghTokenPropagationFixture>,
) {
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts/resume-route-selection.mjs'),
        '--issue',
        '1',
        ...extraArgs,
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
        // #3434: suppress the duplicate raw-stderr relay execFileSync
        // performs when no `stdio` override is given.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ),
  );
  return JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
    ghToken: string | null;
    githubToken: string | null;
  };
}

test('--gh-token sets GH_TOKEN/GITHUB_TOKEN for gh auth', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    const dump = runResumeRouteSelectionCli(
      ['--gh-token', 'canonical-test-token'],
      fixture,
    );
    assert.equal(dump.ghToken, 'canonical-test-token');
    assert.equal(dump.githubToken, 'canonical-test-token');
  } finally {
    fixture.restore();
  }
});

test('--token still sets GH_TOKEN/GITHUB_TOKEN and warns as a deprecated alias', () => {
  const fixture = ghTokenPropagationFixture();
  try {
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [
          join(REPO_ROOT, 'scripts/resume-route-selection.mjs'),
          '--issue',
          '1',
          '--token',
          'deprecated-test-token',
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: { ...process.env, ENV_DUMP_PATH: fixture.dumpPath },
          // #3434: suppress the duplicate raw-stderr relay execFileSync
          // performs when no `stdio` override is given.
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert.fail('expected the CLI to exit non-zero');
    } catch (error) {
      stderr = String((error as { stderr?: unknown }).stderr ?? '');
    }
    const dump = JSON.parse(readFileSync(fixture.dumpPath, 'utf8')) as {
      ghToken: string | null;
      githubToken: string | null;
    };
    assert.equal(dump.ghToken, 'deprecated-test-token');
    assert.equal(dump.githubToken, 'deprecated-test-token');
    assert.match(stderr, /--token is deprecated; use --gh-token instead\./);
  } finally {
    fixture.restore();
  }
});
