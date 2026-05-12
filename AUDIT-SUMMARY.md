# Issue #328: Cleanup Backlog Audit Summary

**Issue**: <https://github.com/kurone-kito/idd-skill/issues/328>\
**Roadmap**: #324\
**Execution branch**: `issue/328-cleanup-minimize-backlog`

## Scope

Audited merged PRs:

- #313 `docs(issue-authoring): define specificity target`
- #315 `docs(issue-authoring): add specificity checklist`
- #316 `docs: define helper runtime profile policy`
- #317 `docs(helper): rank roadmap helper targets`
- #318 `test(issue-authoring): cover specificity guidance sync`
- #320 `docs(onboarding): document helper runtime selection`
- #321 `feat(helper): add advisory-wait state helper`

## Method

For each PR:

1. Before snapshot: `audit-pr-cleanup --dry-run --format json`
2. Apply pass where safe candidates existed:
   `audit-pr-cleanup --apply --claim-issue 328 --claim-id <active-claim>`
3. After snapshot: `audit-pr-cleanup --dry-run --format json`

## Before/After by PR

| PR        | Before safe candidates | Applied this pass | Already minimized at start | Remaining skipped (non-already) | After safe candidates |
| --------- | ---------------------: | ----------------: | -------------------------: | ------------------------------: | --------------------: |
| #313      |                      0 |                 0 |                         15 |                               8 |                     0 |
| #315      |                      0 |                 0 |                         18 |                               2 |                     0 |
| #316      |                      0 |                 0 |                         20 |                               3 |                     0 |
| #317      |                      0 |                 0 |                         35 |                               7 |                     0 |
| #318      |                      8 |                 8 |                         13 |                               4 |                     0 |
| #320      |                     23 |                23 |                          0 |                               2 |                     0 |
| #321      |                      5 |                 5 |                          0 |                               2 |                     0 |
| **Total** |                 **36** |            **36** |                    **101** |                          **28** |                 **0** |

## Result

- All helper-classified safe candidates in scope were minimized
  (**36/36 applied, 0 failed**).
- PRs #313/#315/#316/#317 had no remaining safe candidates at execution
  start; their safe candidates were already minimized.
- No remaining safe candidates were left after execution.

## Remaining visible items (by reason)

These items intentionally stayed visible:

- 13 — known review-bot regular comment lacks a completed-review signal
- 10 — review has no associated review threads
- 2 — review thread is missing an IDD accept/reject disposition
- 2 — associated review threads are missing IDD accept/reject
  dispositions
- 1 — contains failed-CI context

## Acceptance mapping for #328

- Before/after evidence recorded per target PR: **done**
- Safe candidates minimized or failure reported: **done** (36 applied,
  0 failed)
- Unsafe context kept visible with reasons: **done** (reason totals
  listed above)
