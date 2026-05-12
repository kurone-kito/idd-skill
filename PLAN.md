# Issue #328: Minimize safe post-merge cleanup backlog

## Problem statement

Issue #328 requires a maintainer-authorized cleanup pass across merged
PRs 313, 315, 316, 317, 318, 320, and 321:

- minimize only helper-classified safe candidates
- keep unsafe or ambiguous context visible with explicit reasons
- record before/after evidence per PR

## Execution record

1. Captured full **before** snapshots with:
   - `node scripts/audit-pr-cleanup.mjs --pr <N> --dry-run --format json`
2. Executed **apply** with active claim protection:
   - `--apply --claim-issue 328 --claim-id claim-20260512T185604Z-328-b09aeb60`
3. Captured full **after** snapshots with:
   - `node scripts/audit-pr-cleanup.mjs --pr <N> --dry-run --format json`
4. Summarized factual results in `AUDIT-SUMMARY.md`.

## Safety constraints

- Never minimize unresolved review threads, failed-CI context, maintainer
  decision context, or unlabeled human discussion.
- Keep all non-minimized items visible with helper-provided skip reasons.
- Revalidate active claim before apply mutations.

## Evidence location

The canonical evidence for this PR is the committed `AUDIT-SUMMARY.md`
before/after table plus helper outputs captured during execution.
Issue comments may mirror the same summary but are not the sole source.

## Remaining PR-loop work

- Address open PR #334 review comments against the updated summary text.
- Pass repository lint/test checks and push.
- Continue E-phase review/CI loop until merge readiness.
