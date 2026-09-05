import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CleanupArgs,
  CleanupAuditReport,
  ReviewThreadNode,
} from '../src/scripts/audit-pr-cleanup.mts';
import {
  assertBatchApplyClaimScope,
  evaluateReviewComment,
  fetchReviewThreads,
  parsePrNumbers,
} from '../src/scripts/audit-pr-cleanup.mts';
import { indexLatestGatingReviewsByAuthor } from '../src/scripts/protocol-helpers.mts';
import { stubExecutable } from './test-utils.mts';

// Importing the CLI module directly is only possible now that its top-level
// statements are guarded behind `import.meta.main` (#1210, migrated from
// isCliExecution() by #1447); previously the import parsed process.argv,
// called `fail()` (process.exit), or made a
// `gh` call, aborting the test process. tests/audit-pr-cleanup-summary.test.mts
// covers the pure summary logic in the sibling `-summary` module; this file
// covers only the CLI module's import purity.
test('importing audit-pr-cleanup.mts has no import-time side effect', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '';
  try {
    await assert.doesNotReject(import('../src/scripts/audit-pr-cleanup.mts'));
  } finally {
    process.env.PATH = originalPath;
  }
});

function createAuditReport(
  overrides: Partial<CleanupAuditReport> = {},
): CleanupAuditReport {
  return {
    repository: 'kurone-kito/idd-skill',
    pr: 1,
    prUrl: 'https://github.com/kurone-kito/idd-skill/pull/1',
    merged: true,
    mode: 'apply',
    trustedMarkerActors: [],
    trustedMarkerActorsSources: [],
    collaboratorTrustEnabled: false,
    candidates: [],
    skipped: [],
    applied: [],
    failed: [],
    summary: null,
    status: null,
    ...overrides,
  };
}

// Skips runApplyWithRetry's default real-timer backoff so these tests stay
// fast and deterministic; the backoff's own timing is not under test here.
async function noBackoff(): Promise<void> {}

function createRow(subjectId: string) {
  return {
    subjectId,
    url: '',
    type: '',
    classifier: '',
    viewerCanMinimize: true,
    isMinimized: false,
    minimizedReason: null,
  };
}

// #2011: buildReport() runs exactly once today, so a candidate that only
// becomes eligible after that single pass (e.g. GraphQL read-after-write lag
// on minimizeComment) survives to the final report instead of converging
// within one --apply invocation. These cases exercise runApplyWithRetry's
// orchestration with fake applyPass/rescan callbacks — no gh call, no
// process.env.PATH trick needed, since the retry logic never touches gh
// itself.
test('runApplyWithRetry converges on the first pass when the rescan finds nothing new', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let applyPassCalls = 0;
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      applyPassCalls += 1;
      report.applied.push({ ...createRow('c1'), isMinimized: true });
    },
    async () => {
      rescanCalls += 1;
      return createAuditReport({ mode: 'dry-run', candidates: [] });
    },
    undefined,
    noBackoff,
  );

  assert.equal(applyPassCalls, 1);
  assert.equal(rescanCalls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.boundExhausted, false);
  assert.equal(result.report.applied.length, 1);
  // The returned report reflects the confirming rescan (0 remaining), not
  // the stale pre-apply candidate snapshot that fed the pass.
  assert.equal(result.report.candidates.length, 0);
});

test('runApplyWithRetry re-applies a candidate that only becomes eligible after the first pass', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () => {
      rescanCalls += 1;
      // The first rescan (after attempt 1) discovers a comment that only
      // became a candidate after the pass finished; the second rescan
      // (after attempt 2 applies it) reports the run as converged.
      return createAuditReport({
        mode: 'dry-run',
        candidates: rescanCalls === 1 ? [createRow('c2')] : [],
      });
    },
    undefined,
    noBackoff,
  );

  assert.equal(rescanCalls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.boundExhausted, false);
  assert.deepEqual(
    result.report.applied.map((row) => row.subjectId),
    ['c1', 'c2'],
  );
  assert.equal(result.report.candidates.length, 0);
});

test('runApplyWithRetry reports boundExhausted when candidates keep reappearing through the attempt bound', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () => {
      rescanCalls += 1;
      // A churning comment stream: every rescan still finds one candidate.
      return createAuditReport({
        mode: 'dry-run',
        candidates: [createRow(`c${rescanCalls + 1}`)],
      });
    },
    3,
    noBackoff,
  );

  assert.equal(rescanCalls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.boundExhausted, true);
  assert.equal(result.report.applied.length, 3);
  // The final rescan's still-outstanding candidate is preserved so the
  // caller can see what remained, not the pre-apply snapshot from the
  // last attempt.
  assert.deepEqual(
    result.report.candidates.map((row) => row.subjectId),
    ['c4'],
  );
});

test('runApplyWithRetry stops immediately, without rescanning, once a pass leaves a failed candidate', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      report.failed.push({ ...createRow('c1'), error: 'boom' });
    },
    async () => {
      rescanCalls += 1;
      return createAuditReport({ mode: 'dry-run', candidates: [] });
    },
  );

  assert.equal(rescanCalls, 0);
  assert.equal(result.attempts, 1);
  assert.equal(result.boundExhausted, false);
  assert.equal(result.report.failed.length, 1);
});

test('runApplyWithRetry backs off before each rescan, once per retried attempt', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  const backoffAttempts: number[] = [];
  let rescanCalls = 0;

  await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () => {
      rescanCalls += 1;
      return createAuditReport({
        mode: 'dry-run',
        candidates: rescanCalls === 1 ? [createRow('c2')] : [],
      });
    },
    undefined,
    async (attempt) => {
      backoffAttempts.push(attempt);
    },
  );

  // Backed off before the attempt-1 rescan and the attempt-2 rescan, each
  // tagged with its own attempt number.
  assert.deepEqual(backoffAttempts, [1, 2]);
});

test("runApplyWithRetry excludes already-applied subjects from the fresh rescan's candidates and skipped lists", async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({
    candidates: [createRow('c1'), createRow('c2')],
  });

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () =>
      createAuditReport({
        mode: 'dry-run',
        // c1 still shows as a stale candidate (its own lag hasn't resolved
        // yet); c2 shows as an already-minimized skip (buildReport's fresh
        // scan already reflects that mutation). Both were genuinely applied
        // this run, so neither should survive filtering.
        candidates: [createRow('c1')],
        skipped: [{ ...createRow('c2'), isMinimized: true }],
      }),
    undefined,
    noBackoff,
  );

  assert.equal(result.report.candidates.length, 0);
  assert.equal(result.report.skipped.length, 0);
  assert.deepEqual(
    result.report.applied.map((row) => row.subjectId),
    ['c1', 'c2'],
  );
  assert.equal(result.boundExhausted, false);
});

test('runApplyWithRetry preserves already-applied work when the confirming rescan fails', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      report.applied.push({ ...createRow('c1'), isMinimized: true });
    },
    async () => {
      throw new Error('GraphQL: transient failure');
    },
    undefined,
    noBackoff,
  );

  assert.equal(result.report.applied.length, 1);
  assert.equal(result.report.rescanError, 'GraphQL: transient failure');
  assert.equal(result.boundExhausted, false);
});

test('runApplyWithRetry falls back to the default attempt bound on a non-finite maxAttempts value (Copilot review, PR #2019)', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () => {
      rescanCalls += 1;
      // A churning comment stream: every rescan still finds one candidate.
      // Without the Number.isFinite guard, `attempt <= Infinity` is always
      // true, so the loop never terminates -- asserting a bounded rescan
      // count (the default of 3, not an unbounded count) is the actual
      // regression check.
      return createAuditReport({
        mode: 'dry-run',
        candidates: [createRow(`c${rescanCalls + 1}`)],
      });
    },
    Number.POSITIVE_INFINITY,
    noBackoff,
  );

  assert.equal(rescanCalls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.boundExhausted, true);
});

test('runApplyWithRetry truncates a fractional maxAttempts instead of misreporting attempts:0', async () => {
  const { runApplyWithRetry } = await import(
    '../src/scripts/audit-pr-cleanup.mts'
  );
  const initial = createAuditReport({ candidates: [createRow('c1')] });
  let rescanCalls = 0;

  const result = await runApplyWithRetry(
    initial,
    async (report) => {
      for (const candidate of report.candidates) {
        report.applied.push({ ...candidate, isMinimized: true });
      }
    },
    async () => {
      rescanCalls += 1;
      return createAuditReport({
        mode: 'dry-run',
        candidates: [createRow(`c${rescanCalls + 1}`)],
      });
    },
    2.5,
    noBackoff,
  );

  // Math.trunc(2.5) === 2: without it, `attempt === maxAttempts` (an
  // integer compared against 2.5) is never true and the loop falls through
  // to the unreachable-path fallback, misreporting `attempts: 0` despite
  // having run 2 real attempts.
  assert.equal(rescanCalls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.boundExhausted, true);
});

// #2224: --prs <n1,n2,...> batch-mode parsing. --pr itself is untouched
// (still a single string flag, asserted by the pass-through case below).
// parsePrNumbers validates that exactly one of --pr/--prs is present
// itself, regardless of the caller.

function cleanupArgs(overrides: Partial<CleanupArgs> = {}): CleanupArgs {
  return { format: 'json', ...overrides };
}

/** Stubs process.exit (and silences console.error) so a `fail()`-triggering
 * path can be asserted with assert.throws instead of killing the test
 * process. */
function stubExitOnFail(): () => void {
  const originalExit = process.exit;
  const originalError = console.error;
  process.exit = ((code?: number): never => {
    throw new Error(`process.exit(${code})`);
  }) as typeof process.exit;
  console.error = () => {};
  return () => {
    process.exit = originalExit;
    console.error = originalError;
  };
}

test('parsePrNumbers: --pr passes through as a single-element list unchanged', () => {
  assert.deepEqual(parsePrNumbers(cleanupArgs({ pr: '42' })), [42]);
});

test('parsePrNumbers: --prs splits a comma-separated list in order', () => {
  assert.deepEqual(parsePrNumbers(cleanupArgs({ prs: '1,2,3' })), [1, 2, 3]);
});

test('parsePrNumbers: --prs trims whitespace around each token', () => {
  assert.deepEqual(
    parsePrNumbers(cleanupArgs({ prs: ' 1 , 2 ,3  ' })),
    [1, 2, 3],
  );
});

test('parsePrNumbers: --prs drops empty tokens from stray commas', () => {
  assert.deepEqual(parsePrNumbers(cleanupArgs({ prs: '1,,2,' })), [1, 2]);
});

test('parsePrNumbers: --prs de-duplicates while preserving first-seen order', () => {
  assert.deepEqual(
    parsePrNumbers(cleanupArgs({ prs: '3,1,3,2,1' })),
    [3, 1, 2],
  );
});

test('parsePrNumbers: neither --pr nor --prs fails instead of throwing a raw TypeError (Copilot review, PR #2305)', () => {
  const restore = stubExitOnFail();
  try {
    assert.throws(
      () => parsePrNumbers(cleanupArgs()),
      /process\.exit/,
      'must fail via fail()/process.exit, not an unrelated TypeError from a bare .split() on undefined',
    );
  } finally {
    restore();
  }
});

test('parsePrNumbers: both --pr and --prs fails', () => {
  const restore = stubExitOnFail();
  try {
    assert.throws(() => parsePrNumbers(cleanupArgs({ pr: '1', prs: '2,3' })));
  } finally {
    restore();
  }
});

test('parsePrNumbers: --prs with only empty/whitespace tokens fails', () => {
  const restore = stubExitOnFail();
  try {
    assert.throws(() => parsePrNumbers(cleanupArgs({ prs: ' , , ' })));
  } finally {
    restore();
  }
});

test('parsePrNumbers: an invalid --prs token fails the same way as --pr', () => {
  const restore = stubExitOnFail();
  try {
    assert.throws(
      () => parsePrNumbers(cleanupArgs({ prs: '1,not-a-number' })),
      /process\.exit/,
    );
  } finally {
    restore();
  }
});

// #2224 (CodeRabbit review, PR #2305): a claim-gated --apply batch must not
// let one active claim authorize --apply across every PR in the batch.

test('assertBatchApplyClaimScope: --prs with --apply and no --skip-claim-check fails', () => {
  const restore = stubExitOnFail();
  try {
    assert.throws(() =>
      assertBatchApplyClaimScope(
        cleanupArgs({ apply: true, prs: '1,2', claimIssue: '9', claimId: 'x' }),
      ),
    );
  } finally {
    restore();
  }
});

test('assertBatchApplyClaimScope: --prs with --apply and --skip-claim-check is allowed', () => {
  assert.doesNotThrow(() =>
    assertBatchApplyClaimScope(
      cleanupArgs({ apply: true, prs: '1,2', skipClaimCheck: true }),
    ),
  );
});

test('assertBatchApplyClaimScope: --pr with --apply and no --skip-claim-check is unaffected', () => {
  assert.doesNotThrow(() =>
    assertBatchApplyClaimScope(
      cleanupArgs({ apply: true, pr: '1', claimIssue: '9', claimId: 'x' }),
    ),
  );
});

test('assertBatchApplyClaimScope: dry-run (no --apply) is never gated', () => {
  assert.doesNotThrow(() =>
    assertBatchApplyClaimScope(cleanupArgs({ prs: '1,2' })),
  );
});

// #2478: fetchReviewThreads's inner per-thread comment pagination. Stubs
// `gh` on PATH (same technique as tests/gh-pagination-parsing-smoke.test.mts)
// rather than spawning the full CLI, since exercising this one internal
// function directly avoids stubbing every other gh call `buildReport` needs.
// The outer `reviewThreads` query and the per-thread `node(id)` continuation
// query are distinguished by their distinct variable names (`owner=`/`id=`)
// rather than by reproducing the exact query text, which would be brittle
// to unrelated formatting changes.

function makeThreadComment(id: string): Record<string, unknown> {
  return {
    id,
    url: `https://example.com/${id}`,
    body: 'x',
    createdAt: '2026-01-01T00:00:00Z',
    isMinimized: false,
    minimizedReason: null,
    viewerCanMinimize: true,
    author: { login: 'a' },
    pullRequestReview: null,
  };
}

function withFakeGh<T>(
  outerResponse: string,
  continuationResponse: string,
  run: () => T,
): T {
  const restore = stubExecutable(
    'gh',
    `const args = process.argv.slice(2);
if (args[0] === 'api' && args[1] === 'graphql') {
  if (args.some((a) => a.startsWith('owner='))) {
    process.stdout.write(${JSON.stringify(outerResponse)});
    process.exit(0);
  }
  if (args.some((a) => a.startsWith('id='))) {
    process.stdout.write(${JSON.stringify(continuationResponse)});
    process.exit(0);
  }
}
process.stderr.write('unexpected gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  );
  try {
    return run();
  } finally {
    restore();
  }
}

function outerThreadResponse(
  firstPageNodes: Record<string, unknown>[],
  firstPageHasNextPage: boolean,
  firstPageEndCursor: string | null,
): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: 'THREAD1',
                isResolved: false,
                comments: {
                  pageInfo: {
                    hasNextPage: firstPageHasNextPage,
                    endCursor: firstPageEndCursor,
                  },
                  nodes: firstPageNodes,
                },
              },
            ],
          },
        },
      },
    },
  });
}

test('fetchReviewThreads paginates past a review thread first 100 comments (#2478)', () => {
  const firstPageNodes = Array.from({ length: 100 }, (_, i) =>
    makeThreadComment(`c${i}`),
  );
  const outerResponse = outerThreadResponse(firstPageNodes, true, 'CURSOR1');
  const continuationResponse = JSON.stringify({
    data: {
      node: {
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [makeThreadComment('c100')],
        },
      },
    },
  });

  const threads = withFakeGh(outerResponse, continuationResponse, () =>
    fetchReviewThreads('o', 'r', 1),
  );

  assert.equal(threads.length, 1);
  assert.equal(threads[0].comments?.nodes?.length, 101);
  assert.equal(threads[0].comments?.pageInfo?.hasNextPage, false);
});

test('fetchReviewThreads stops at the page-count safety cap and still reports hasNextPage:true (#2478)', () => {
  const firstPageNodes = Array.from({ length: 100 }, (_, i) =>
    makeThreadComment(`c${i}`),
  );
  const outerResponse = outerThreadResponse(firstPageNodes, true, 'CURSOR1');
  // Pathological: every continuation call reports another page still
  // pending, simulating a runaway/misbehaving API response. The safety cap
  // must still terminate the walk and leave hasNextPage:true so the
  // existing truncated-data skip in evaluateReviewComment keeps firing
  // instead of misreporting a capped thread as complete.
  const continuationResponse = JSON.stringify({
    data: {
      node: {
        comments: {
          pageInfo: { hasNextPage: true, endCursor: 'CURSOR-NEXT' },
          nodes: [makeThreadComment('extra')],
        },
      },
    },
  });

  const threads = withFakeGh(outerResponse, continuationResponse, () =>
    fetchReviewThreads('o', 'r', 1),
  );

  assert.equal(threads.length, 1);
  // 1 initial 100-comment page + 49 continuation pages, each contributing
  // one more comment -- capped at MAX_REVIEW_THREAD_COMMENT_PAGES (50)
  // total pages fetched for this thread.
  assert.equal(threads[0].comments?.nodes?.length, 100 + 49);
  assert.equal(threads[0].comments?.pageInfo?.hasNextPage, true);
});

test('fetchReviewThreads fails loudly on hasNextPage:true with a missing endCursor (#2478 review)', () => {
  const firstPageNodes = Array.from({ length: 100 }, (_, i) =>
    makeThreadComment(`c${i}`),
  );
  // A contract-violating page: hasNextPage:true but no endCursor to
  // continue from. Must throw rather than silently re-requesting page 1
  // (ghGraphql drops a null `after` variable), which could otherwise
  // "self-heal" into duplicate comment nodes the downstream
  // truncated-data skip would not catch.
  const outerResponse = outerThreadResponse(firstPageNodes, true, null);
  // Never reached -- an unexpected continuation call would fail loudly via
  // the fake gh's own unmatched-invocation path instead of returning this.
  const continuationResponse = JSON.stringify({});

  assert.throws(
    () =>
      withFakeGh(outerResponse, continuationResponse, () =>
        fetchReviewThreads('o', 'r', 1, { throwOnError: true }),
      ),
    /hasNextPage without endCursor/,
  );
});

// #2618: `evaluateReviewComment`'s ack-only-post-disposition carve-out,
// mirroring F2/F3's `classifyThreadAckOnlyPostDisposition`. This repository's
// own `.github/idd/config.json` configures `coderabbitai[bot]` as an
// advisory bot, which these tests rely on (no mocking needed).
const mergedPr = { number: 1, url: 'https://pr', merged: true };
const noGatingReviews = indexLatestGatingReviewsByAuthor([]);

test('evaluateReviewComment reports a candidate for an ack-only-after-disposition thread (#2618)', () => {
  const disposition = {
    id: 'EC-1',
    url: 'https://pr#EC-1',
    author: { login: 'idd-bot' },
    body: '**Accepted** — done.',
    createdAt: '2026-05-12T00:00:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const comment = {
    id: 'EC-2',
    url: 'https://pr#EC-2',
    author: { login: 'coderabbitai[bot]' },
    body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
    createdAt: '2026-05-12T00:01:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const thread: ReviewThreadNode = {
    id: 'THREAD-EVAL-ACK',
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [disposition, comment],
    },
  };
  const report = createAuditReport({ trustedMarkerActors: ['idd-bot'] });

  evaluateReviewComment(comment, thread, mergedPr, noGatingReviews, report);

  assert.equal(report.skipped.length, 0);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.subjectId, 'EC-2');
});

test('evaluateReviewComment still skips a genuinely missing disposition (#2618)', () => {
  const humanFeedback = {
    id: 'EM-1',
    url: 'https://pr#EM-1',
    author: { login: 'reviewer-a' },
    body: 'please fix this',
    createdAt: '2026-05-12T00:00:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const comment = {
    id: 'EM-2',
    url: 'https://pr#EM-2',
    author: { login: 'coderabbitai[bot]' },
    body: 'Thanks for confirming!',
    createdAt: '2026-05-12T00:01:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const thread: ReviewThreadNode = {
    id: 'THREAD-EVAL-MISSING',
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [humanFeedback, comment],
    },
  };
  const report = createAuditReport({ trustedMarkerActors: ['idd-bot'] });

  evaluateReviewComment(comment, thread, mergedPr, noGatingReviews, report);

  assert.equal(report.candidates.length, 0);
  assert.equal(
    report.skipped[0]?.skipReason,
    'review thread is missing an IDD accept/reject disposition',
  );
});

test('evaluateReviewComment excludes the PR author from ack-only blocking feedback (#2618, Codex P2)', () => {
  // The PR author's own post-disposition reply must not count as blocking
  // feedback -- mirroring F2/F3's `prAuthorLogin` exclusion -- so a
  // trailing advisory-bot courtesy ack after it still classifies as
  // ack-only.
  const prWithAuthor = { ...mergedPr, author: { login: 'pr-author' } };
  const disposition = {
    id: 'PA-1',
    url: 'https://pr#PA-1',
    author: { login: 'idd-bot' },
    body: '**Accepted** — done.',
    createdAt: '2026-05-12T00:00:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const authorReply = {
    id: 'PA-2',
    url: 'https://pr#PA-2',
    author: { login: 'pr-author' },
    body: 'thanks!',
    createdAt: '2026-05-12T00:01:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const comment = {
    id: 'PA-3',
    url: 'https://pr#PA-3',
    author: { login: 'coderabbitai[bot]' },
    body: '`@kurone-kito`, confirmed. Thanks for the fix.\n\n<!-- This is an auto-generated reply by CodeRabbit -->',
    createdAt: '2026-05-12T00:02:00Z',
    viewerCanMinimize: true,
    isMinimized: false,
  };
  const thread: ReviewThreadNode = {
    id: 'THREAD-EVAL-PR-AUTHOR',
    isResolved: true,
    comments: {
      pageInfo: { hasNextPage: false },
      nodes: [disposition, authorReply, comment],
    },
  };
  const report = createAuditReport({ trustedMarkerActors: ['idd-bot'] });

  evaluateReviewComment(comment, thread, prWithAuthor, noGatingReviews, report);

  assert.equal(report.skipped.length, 0);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.candidates[0]?.subjectId, 'PA-3');
});
