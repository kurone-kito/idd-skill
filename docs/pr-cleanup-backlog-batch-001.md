# PR Cleanup Backlog — Batch Run 001

This document records the first batch execution of the historical
merged-PR cleanup backlog campaign for `kurone-kito/idd-skill`.

## Batch Execution Policy

| Parameter       | Value                                             |
| --------------- | ------------------------------------------------- |
| Batch size      | 20 PRs per batch                                  |
| Ordering        | Ascending PR number (oldest merges first)         |
| Safety check    | Dry-run verification before each apply pass       |
| Stop conditions | API error, rate-limit failure, permission denial  |
| Claim gate      | `--claim-issue 431 --claim-id <active-claim-id>`  |
| Skip criteria   | Unresolved threads, operational markers, held PRs |

Each batch follows this sequence:

1. Collect the next `N` merged PRs by ascending number from the last
   recorded batch boundary.
2. Run `audit-pr-cleanup.mjs --dry-run` on each PR to identify
   candidates.
3. Run `audit-pr-cleanup.mjs --apply` on PRs that have candidates,
   passing the active claim for the cleanup issue.
4. Record outcomes (applied, skipped, failed) and any exceptions.
5. Update this file or create a new batch record for the next run.

### Reproducing a Batch Run

```sh
# Dry-run pass (safe, read-only)
for pr in <pr-list>; do
  node scripts/audit-pr-cleanup.mjs --pr "$pr" --dry-run --format json
done

# Apply pass (requires active claim on the cleanup issue)
for pr in <prs-with-candidates>; do
  node scripts/audit-pr-cleanup.mjs --pr "$pr" --apply \
    --claim-issue <issue-number> --claim-id <claim-id> \
    --agent-id claude-code --format json
done
```

## Batch 001 Scope

| Parameter      | Value                                                |
| -------------- | ---------------------------------------------------- |
| PRs checked    | #1, #2, #6, #7, #16–#23, #28–#31, #33, #35, #37, #40 |
| Batch boundary | PR #1 through PR #40 (ascending)                     |
| Run date       | 2026-05-13                                           |
| Claim issue    | #431                                                 |

## Dry-Run Results

| PR  | Candidates |
| --- | ---------- |
| #1  | 0          |
| #2  | 11         |
| #6  | 18         |
| #7  | 9          |
| #16 | 8          |
| #17 | 12         |
| #18 | 6          |
| #19 | 16         |
| #20 | 10         |
| #21 | 3          |
| #22 | 5          |
| #23 | 10         |
| #28 | 4          |
| #29 | 3          |
| #30 | 7          |
| #31 | 4          |
| #33 | 1          |
| #35 | 0          |
| #37 | 1          |
| #40 | 5          |

**Summary**: 18 of 20 PRs had cleanup candidates. 2 PRs already clean (#1, #35).
Total candidates identified: 133.

## Apply Results

| PR  | Applied | Skipped | Failed |
| --- | ------- | ------- | ------ |
| #1  | —       | —       | —      |
| #2  | 11      | 24      | 0      |
| #6  | 18      | 39      | 0      |
| #7  | 9       | 29      | 0      |
| #16 | 8       | 5       | 0      |
| #17 | 12      | 2       | 0      |
| #18 | 6       | 2       | 0      |
| #19 | 2       | 38      | 0      |
| #20 | 10      | 2       | 0      |
| #21 | 3       | 1       | 0      |
| #22 | 5       | 4       | 0      |
| #23 | 10      | 1       | 0      |
| #28 | 4       | 0       | 0      |
| #29 | 3       | 3       | 0      |
| #30 | 6       | 3       | 0      |
| #31 | 4       | 0       | 0      |
| #33 | 1       | 3       | 0      |
| #35 | —       | —       | —      |
| #37 | 1       | 1       | 0      |
| #40 | 5       | 0       | 0      |

**Batch 001 totals**: 118 applied, 157 skipped, 0 failed.

The discrepancy between dry-run candidates (133) and applied (118) reflects
revalidation: some candidates were skipped at apply time when their state
changed between the dry-run and apply passes (e.g., threads resolved,
comment already minimized, or eligibility re-check failed).

## Exceptions

None. All 18 PRs with candidates completed without errors.

## Remaining Backlog

Next batch boundary starts at PR #41. The full merged-PR backlog
contains 201 PRs as of 2026-05-13. Subsequent runs should continue
from the next PR after the highest number processed in this batch.

### Continuing from this State

```sh
# Get the next batch of PRs (batch 002: starting after PR #40)
gh pr list --state merged --json number --limit 500 | \
  jq '[.[].number] | sort | map(select(. > 40)) | .[0:20] | .[]'
```
