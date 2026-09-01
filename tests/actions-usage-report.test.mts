import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateActionsUsage,
  renderTable,
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
    workflows: [],
  });
});

test('renderTable: renders one row per workflow plus a totals line', () => {
  const { input } = loadFixture('basic');
  const table = renderTable(aggregateActionsUsage(input.runs, input.jobs));
  assert.match(table, /\| Linting workflow \| 2 \| 2 \| 2m30s \|/);
  assert.match(table, /\| IDD advisory-convergence gate \| 3 \| 2 \| 0m45s \|/);
  assert.match(table, /Total: 5 runs, 4 jobs, 3m15s\./);
});
