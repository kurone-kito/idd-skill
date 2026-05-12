# Issue #327: F4 cleanup apply results tracking

## Problem and approach

The F4 (post-merge cleanup) phase currently treats cleanup as best-effort
but doesn't require agents to attempt or record cleanup results. Recent
merged PRs show agents often stop after merge digest and local cleanup
without running the audit-pr-cleanup script.

The fix is to update F4 instructions so:

1. After merge and local cleanup, agents run `audit-pr-cleanup --dry-run`
2. If credentials permit, run `audit-pr-cleanup --apply`
3. Record the result (applied count, skipped, failed, remaining) in the
   PR digest or as an audit comment
4. Keep cleanup outside the merge gate

## Scope

Two files to update (must be kept synchronized):

- `.github/instructions/idd-merge.instructions.md` (F4 section)
- `idd-template/.github/instructions/idd-merge.instructions.md` (F4 section)

These files were updated in previous work (PR #305) but F4 didn't
explicitly require the dry-run/apply cycle. This issue adds that requirement.

## Implementation plan

### Step 1: Read F4 current state

- Find F4 section in idd-merge.instructions.md
- Note current cleanup flow and constraints

### Step 2: Draft updated F4 flow

- Add `audit-pr-cleanup --dry-run` after best-effort cleanup comment
- Add conditional `audit-pr-cleanup --apply` when claim validates and
  credentials available
- Add digest/comment requirement for results

### Step 3: Update both files

- Update .github/instructions/ version
- Update idd-template/ version (keep synchronized)

### Step 4: Verify

- Markdown lint passes
- Template sync is maintained
- No instruction conflicts with #312 (future slimming)

## Acceptance criteria

✓ Both instruction files updated together
✓ F4 explicitly requires audit-pr-cleanup attempt
✓ Results are recorded in digest or comment
✓ Cleanup remains best-effort, post-merge only
✓ Claim revalidation preserved
✓ No changes to helper runtime profile (deferred to #312)
✓ Existing validation passes (lint, spellcheck, tests)
