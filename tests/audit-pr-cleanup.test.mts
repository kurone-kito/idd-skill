import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CleanupArgs,
  CleanupAuditReport,
} from '../src/scripts/audit-pr-cleanup.mts';
import { parsePrNumbers } from '../src/scripts/audit-pr-cleanup.mts';

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
    assert.throws(() => parsePrNumbers(cleanupArgs({ prs: '1,not-a-number' })));
  } finally {
    restore();
  }
});
