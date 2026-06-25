import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CleanupReport,
  computeReportSummary,
} from '../src/scripts/audit-pr-cleanup-summary.mts';

function createReport(overrides: Partial<CleanupReport> = {}): CleanupReport {
  return {
    mode: 'dry-run',
    candidates: [],
    skipped: [],
    applied: [],
    failed: [],
    summary: null,
    status: null,
    ...overrides,
  };
}

test('computeReportSummary counts viewer eligibility from evaluated subjects', () => {
  const report = createReport({
    candidates: [{ subjectId: 'candidate-1' }, { subjectId: 'candidate-2' }],
    skipped: [
      { subjectId: 'skip-1', isMinimized: true, viewerCanMinimize: true },
      { subjectId: 'skip-2', isMinimized: false, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.summary?.candidate, 2);
  assert.equal(report.summary?.skipped, 2);
  assert.equal(report.summary?.['already-minimized'], 1);
  assert.equal(report.summary?.['viewer-can-minimize'], 3);
  assert.equal(report.summary?.['viewer-cannot-minimize'], 1);
  assert.equal(report.status, 'needs-apply');
});

test('computeReportSummary reflects apply results after mutations', () => {
  const report = createReport({
    mode: 'apply',
    candidates: [{ subjectId: 'candidate-1' }],
    skipped: [
      { subjectId: 'skip-1', isMinimized: false, viewerCanMinimize: true },
    ],
    applied: [],
    failed: [],
  });

  computeReportSummary(report);
  // No applied work yet and no genuine remainder (the lone skip is neither
  // permission-blocked nor a failure), so the run is converged-clean rather
  // than the pre-#1039 `incomplete` that compared candidates to applied.
  assert.equal(report.status, 'clean');
  assert.equal(report.summary?.applied, 0);

  report.applied.push({ subjectId: 'candidate-1' });
  computeReportSummary(report);

  assert.equal(report.status, 'applied');
  assert.equal(report.summary?.applied, 1);
  assert.equal(report.summary?.failed, 0);
  assert.equal(report.summary?.skipped, 1);
});

test('computeReportSummary emits clean when there are no candidates and no permission-blocked items', () => {
  const report = createReport({
    candidates: [],
    skipped: [
      { subjectId: 'skip-1', isMinimized: true, viewerCanMinimize: true },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'clean');
  assert.equal(report.summary?.candidate, 0);
  assert.equal(report.summary?.['viewer-cannot-minimize'], 0);
});

test('computeReportSummary emits clean when already-minimized items have viewerCanMinimize false', () => {
  const report = createReport({
    candidates: [],
    skipped: [
      { subjectId: 'skip-1', isMinimized: true, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'clean');
  assert.equal(report.summary?.['viewer-cannot-minimize'], 0);
});

test('computeReportSummary emits permission-blocked when all items are viewer-cannot-minimize', () => {
  const report = createReport({
    candidates: [],
    skipped: [
      { subjectId: 'skip-1', isMinimized: false, viewerCanMinimize: false },
      { subjectId: 'skip-2', isMinimized: false, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'permission-blocked');
  assert.equal(report.summary?.['viewer-cannot-minimize'], 2);
  assert.equal(report.summary?.candidate, 0);
});

test('computeReportSummary emits needs-apply even when some items are viewer-cannot-minimize', () => {
  const report = createReport({
    candidates: [{ subjectId: 'candidate-1' }],
    skipped: [
      { subjectId: 'skip-1', isMinimized: false, viewerCanMinimize: false },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'needs-apply');
  assert.equal(report.summary?.['viewer-cannot-minimize'], 1);
  assert.equal(report.summary?.candidate, 1);
});

test('computeReportSummary emits failed when apply is attempted but all candidates fail', () => {
  const report = createReport({
    mode: 'apply',
    candidates: [{ subjectId: 'candidate-1' }, { subjectId: 'candidate-2' }],
    skipped: [],
    applied: [],
    failed: [
      { subjectId: 'candidate-1', error: 'GraphQL error' },
      { subjectId: 'candidate-2', error: 'timeout' },
    ],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'failed');
  assert.equal(report.summary?.failed, 2);
  assert.equal(report.summary?.applied, 0);
});

test('computeReportSummary keeps incomplete when a permission-blocked remainder stays after apply', () => {
  // A genuine partial: one candidate minimized, but another comment cannot be
  // minimized by the viewer. That permission-blocked remainder is the only
  // thing `incomplete` is reserved for after a successful (failure-free) apply.
  const report = createReport({
    mode: 'apply',
    candidates: [{ subjectId: 'candidate-1' }],
    skipped: [
      { subjectId: 'skip-1', isMinimized: false, viewerCanMinimize: false },
    ],
    applied: [{ subjectId: 'candidate-1' }],
    failed: [],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'incomplete');
  assert.equal(report.summary?.applied, 1);
  assert.equal(report.summary?.['viewer-cannot-minimize'], 1);
  assert.equal(report.summary?.failed, 0);
});

test('computeReportSummary converges to applied when remaining candidates were cascade-minimized', () => {
  // Minimizing a parent comment collapses its child review threads, so a single
  // apply minimizes candidate-1 explicitly while candidate-2/3 cascade into
  // already-minimized skips. With no permission-blocked remainder and no
  // failure the run has converged and must report `applied`, not the spurious
  // `incomplete` that drew a false cleanup-failure comment on merged PRs (#1039).
  const report = createReport({
    mode: 'apply',
    candidates: [
      { subjectId: 'candidate-1' },
      { subjectId: 'candidate-2' },
      { subjectId: 'candidate-3' },
    ],
    skipped: [
      { subjectId: 'candidate-2', isMinimized: true, viewerCanMinimize: true },
      { subjectId: 'candidate-3', isMinimized: true, viewerCanMinimize: true },
    ],
    applied: [{ subjectId: 'candidate-1' }],
    failed: [],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'applied');
  assert.equal(report.summary?.applied, 1);
  assert.equal(report.summary?.['already-minimized'], 2);
  assert.equal(report.summary?.['viewer-cannot-minimize'], 0);
});

test('computeReportSummary emits failed when apply has both applied and failed candidates', () => {
  const report = createReport({
    mode: 'apply',
    candidates: [{ subjectId: 'candidate-1' }, { subjectId: 'candidate-2' }],
    skipped: [],
    applied: [{ subjectId: 'candidate-1' }],
    failed: [{ subjectId: 'candidate-2', error: 'GraphQL error' }],
  });

  computeReportSummary(report);

  assert.equal(report.status, 'failed');
  assert.equal(report.summary?.applied, 1);
  assert.equal(report.summary?.failed, 1);
});
