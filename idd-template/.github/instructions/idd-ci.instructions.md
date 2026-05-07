# IDD — CI Polling (Shared Helper)

Read this file when you need to wait for CI after a push. Callers must
define their own **on-success** target before invoking this algorithm.

## Algorithm

1. Identify the full set of required checks for the current PR head SHA
   by reading the branch protection / ruleset via GH CLI or GH MCP.
2. Poll `gh pr checks` (or equivalent) at a reasonable interval.

## Interpretation

Treat `skipped`, `neutral`, and `not_applicable` as equivalent to
`success`.

| State                                           | Action                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All required checks generated and all `success` | → **on-success** (caller-defined)                                                                                                                                                  |
| Any required check `failure`                    | Inspect the log. If infra/flaky: rerun once. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step.                                  |
| Any `cancelled` or `timed_out`                  | Investigate cause. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. If infra-caused: re-push or rerun CI, then resume polling. |
| Any `queued` or `in_progress`                   | Continue waiting. After 30 min of no completion: rerun CI once. If still not complete: post a hold comment and stop.                                                               |
| Required checks not generated after 10 min      | Treat as `queued`/`in_progress`. If the corresponding workflow run does not exist at all: post a hold comment and escalate to a maintainer, then stop.                             |
