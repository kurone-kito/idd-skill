// idd-generated-from: src/scripts/audit-pr-cleanup-summary.mts
//
// The scripts/audit-pr-cleanup-summary.mjs copy is generated from the
// .mts source named above by `pnpm run build`. Edit the .mts source,
// never the generated .mjs. See docs/typescript-sources.md.
export function computeReportSummary(report) {
  const alreadyMinimized = report.skipped.filter(
    (skip) => skip.isMinimized,
  ).length;
  const viewerCanMinimize =
    report.candidates.length +
    report.skipped.filter((skip) => skip.viewerCanMinimize).length;
  const viewerCannotMinimize = report.skipped.filter(
    (skip) => !skip.isMinimized && !skip.viewerCanMinimize,
  ).length;
  report.summary = {
    candidate: report.candidates.length,
    skipped: report.skipped.length,
    applied: report.applied.length,
    failed: report.failed.length,
    'already-minimized': alreadyMinimized,
    'viewer-can-minimize': viewerCanMinimize,
    'viewer-cannot-minimize': viewerCannotMinimize,
  };
  if (report.mode === 'dry-run') {
    if (report.candidates.length > 0) {
      report.status = 'needs-apply';
    } else if (viewerCannotMinimize > 0) {
      report.status = 'permission-blocked';
    } else {
      report.status = 'clean';
    }
    return;
  }
  if (report.mode === 'apply') {
    if (report.failed.length > 0) {
      report.status = 'failed';
      return;
    }
    // A candidate that ended up minimized is done — whether this run minimized
    // it (`applied`) or it was already / cascade-minimized (an
    // already-minimized skip; minimizing a parent collapses its child threads,
    // so a single apply converges more comments than it counts into `applied`).
    // The only genuine unfinished work is a permission-blocked remainder
    // (`viewer-cannot-minimize`); a real per-call failure is already handled
    // above. So `incomplete` is reserved for that remainder, and a converged
    // run reports `applied` (work done) or `clean` (nothing left). This stops a
    // converged multi-candidate apply from spuriously reporting `incomplete`
    // and drawing a false cleanup-failure comment on a merged PR (#1039).
    if (viewerCannotMinimize > 0) {
      report.status = 'incomplete';
      return;
    }
    report.status = report.applied.length > 0 ? 'applied' : 'clean';
  }
}
