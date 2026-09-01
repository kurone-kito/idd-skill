import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateActionsUsage,
  billedMinutesFor,
  isPrFamilyEvent,
  renderTable,
  runBelongsToPr,
  type UsageJob,
  type UsageRun,
} from '../src/scripts/actions-usage-report.mts';
import { readJson } from './test-utils.mts';

interface Fixture {
  input: { runs: UsageRun[]; jobs: UsageJob[] };
  expected: ReturnType<typeof aggregateActionsUsage>;
}

function loadFixture(name: string): Fixture {
  return readJson(`fixtures/actions-usage-report/${name}.json`) as Fixture;
}

test('aggregateActionsUsage: sums job durations per workflow, sorted by cost descending', () => {
  const { input, expected } = loadFixture('basic');
  assert.deepEqual(aggregateActionsUsage(input.runs, input.jobs), expected);
});

test('aggregateActionsUsage: skips an in-progress job (no completedAt) from the duration total', () => {
  const { input } = loadFixture('basic');
  const report = aggregateActionsUsage(input.runs, input.jobs);
  const advisoryRow = report.workflows.find(
    (row) => row.workflowName === 'IDD advisory-convergence gate',
  );
  assert.ok(advisoryRow);
  // 3 runs recorded, but only 2 jobs contribute a duration (the third is
  // still in flight).
  assert.equal(advisoryRow.runCount, 3);
  assert.equal(advisoryRow.jobCount, 2);
});

test("aggregateActionsUsage: skips an orphan job, a negative-duration job, and counts a matrix workflow's jobs together", () => {
  const { input, expected } = loadFixture('edge-cases');
  assert.deepEqual(aggregateActionsUsage(input.runs, input.jobs), expected);
});

test('aggregateActionsUsage: a run with zero completed jobs still contributes to runCount, not jobCount', () => {
  const { input } = loadFixture('edge-cases');
  const report = aggregateActionsUsage(input.runs, input.jobs);
  const zeroJobRow = report.workflows.find(
    (row) => row.workflowName === 'Zero-job workflow',
  );
  assert.ok(zeroJobRow);
  assert.equal(zeroJobRow.runCount, 1);
  assert.equal(zeroJobRow.jobCount, 0);
  assert.equal(zeroJobRow.totalDurationMs, 0);
});

test('aggregateActionsUsage: empty input reports zero totals and no workflow rows', () => {
  const report = aggregateActionsUsage([], []);
  assert.deepEqual(report, {
    runCount: 0,
    jobCount: 0,
    totalDurationMs: 0,
    totalBilledMinutes: 0,
    workflows: [],
  });
});

test('runBelongsToPr: an empty pull_requests list is kept (fork PR, no association available)', () => {
  assert.equal(runBelongsToPr([], 2344), true);
});

test('runBelongsToPr: a non-empty list including prNumber is kept', () => {
  assert.equal(runBelongsToPr([1200, 2344], 2344), true);
});

test('runBelongsToPr: a non-empty list omitting prNumber is dropped (a different PR reused this branch)', () => {
  assert.equal(runBelongsToPr([1200], 2344), false);
});

test('isPrFamilyEvent: accepts only pull_request-family triggers', () => {
  assert.equal(isPrFamilyEvent('pull_request'), true);
  assert.equal(isPrFamilyEvent('pull_request_review'), true);
  assert.equal(isPrFamilyEvent('pull_request_review_comment'), true);
});

test('isPrFamilyEvent: rejects a push/workflow_dispatch run sharing the branch name', () => {
  // GitHub never populates pull_requests for these event types either, so
  // the event check must run independently of runBelongsToPr's empty-list
  // allowance -- not merely defer to it.
  assert.equal(isPrFamilyEvent('push'), false);
  assert.equal(isPrFamilyEvent('workflow_dispatch'), false);
  assert.equal(isPrFamilyEvent('schedule'), false);
});

test('billedMinutesFor: rounds up to the whole minute, with a one-minute floor', () => {
  // GitHub bills a job that ran for any positive duration at least one
  // minute -- ten five-second jobs cost ten billed minutes, not zero.
  assert.equal(billedMinutesFor(5_000), 1);
  assert.equal(billedMinutesFor(60_000), 1);
  assert.equal(billedMinutesFor(60_001), 2);
  assert.equal(billedMinutesFor(90_000), 2);
});

test('renderTable: renders one row per workflow plus a totals line', () => {
  const { input } = loadFixture('basic');
  const table = renderTable(aggregateActionsUsage(input.runs, input.jobs));
  assert.match(table, /\| Linting workflow \| 2 \| 2 \| 2m30s \| 3m \|/);
  assert.match(
    table,
    /\| IDD advisory-convergence gate \| 3 \| 2 \| 0m45s \| 2m \|/,
  );
  assert.match(
    table,
    /Total: 5 runs, 4 jobs, 3m15s wall-clock, 5 billed minute\(s\)\./,
  );
});
