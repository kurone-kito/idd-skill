# Issue #328: Minimize safe post-merge cleanup backlog

## Problem statement

Recent merged PRs (#313, #315, #316, #317, #318, #320, #321) still have safe cleanup candidates that can be minimized now that:

1. Helper: `audit-pr-cleanup` provides stable completion summary
2. F4 instructions: explicitly require apply attempt and result recording
3. Issue #327: merged with visible results tracking

This issue audits those PRs and applies safe cleanup candidates while recording why unsafe candidates remain.

## Implementation approach

1. **Per-PR audit workflow** (7 PRs × 4 steps each = 28 operations):
   - Run `node scripts/audit-pr-cleanup.mjs --pr <N> --dry-run` 
   - Record candidates, safe/unsafe counts
   - Run `--apply` step with claim-backed mutation
   - Document results in before/after summary table

2. **Fallback strategy** (if Node helpers unavailable):
   - Document exact GraphQL minimizeComment calls needed
   - Report as "requires manual execution" for next maintainer audit

3. **Result artifact**:
   - Create summary table in comment on #328 showing:
     * PR number, branch, merge date
     * Dry-run counts (candidates, safe, unsafe, skipped)
     * Apply results (minimized, failed, already-minimized)
     * Skipped reasons (unresolved thread, active hold, maintainer decision, etc.)

4. **Safety constraints**:
   - Never minimize: unresolved threads, active holds, maintainer decisions, failed CI, human discussion
   - Always record: failed mutations with error, skipped candidates with reasons
   - Validate claim before each mutation (D2 revalidation gate)

## Todos

- [ ] **audit-313**: Dry-run and apply for PR #313
- [ ] **audit-315**: Dry-run and apply for PR #315
- [ ] **audit-316**: Dry-run and apply for PR #316
- [ ] **audit-317**: Dry-run and apply for PR #317
- [ ] **audit-318**: Dry-run and apply for PR #318
- [ ] **audit-320**: Dry-run and apply for PR #320
- [ ] **audit-321**: Dry-run and apply for PR #321
- [ ] **summarize**: Create before/after summary table and commit evidence

## Acceptance path

After all 7 PRs are audited and safe candidates are minimized:

1. Document results in a summary comment on #328 (not committed to repo)
2. Commit a single evidence summary to the repository (optional timeline artifact)
3. Close #328 with link to summary evidence

## Risks & considerations

- **Node helper dependency**: If helpers are unavailable, fallback to GraphQL commands
- **Rate limiting**: GitHub API may rate-limit; use exponential backoff if needed
- **Mutation ordering**: Apply PRs in ascending order to reduce cognitive load
- **Claim revalidation**: Before each --apply, re-validate active claim for issue #328
