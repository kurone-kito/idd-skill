import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CleanupAuditReport } from '../src/scripts/audit-pr-cleanup.mts';

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
  );

  assert.equal(applyPassCalls, 1);
  assert.equal(rescanCalls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.boundExhausted, false);
  assert.equal(result.report.applied.length, 1);
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
  );

  assert.equal(rescanCalls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.boundExhausted, false);
  assert.deepEqual(
    result.report.applied.map((row) => row.subjectId),
    ['c1', 'c2'],
  );
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
  );

  assert.equal(rescanCalls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.boundExhausted, true);
  assert.equal(result.report.applied.length, 3);
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
