export function computeReportSummary(report) {
  const alreadyMinimized = report.skipped.filter((skip) => skip.isMinimized).length;
  const viewerCanMinimize = report.candidates.length
    + report.skipped.filter((skip) => skip.viewerCanMinimize).length;
  const viewerCannotMinimize = report.skipped.filter((skip) => !skip.viewerCanMinimize).length;

  report.summary = {
    candidate: report.candidates.length,
    skipped: report.skipped.length,
    applied: report.applied.length,
    failed: report.failed.length,
    "already-minimized": alreadyMinimized,
    "viewer-can-minimize": viewerCanMinimize,
    "viewer-cannot-minimize": viewerCannotMinimize,
  };

  if (report.mode === "dry-run") {
    report.status = report.candidates.length === 0 ? "clean" : "needs-apply";
    return;
  }

  if (report.mode === "apply") {
    if (report.failed.length > 0) {
      report.status = "failed";
      return;
    }
    if (report.applied.length > 0 && report.candidates.length === report.applied.length) {
      report.status = "applied";
      return;
    }
    if (report.applied.length > 0) {
      report.status = "incomplete";
      return;
    }
    report.status = report.candidates.length === 0 ? "clean" : "incomplete";
  }
}
