# IDD — CI Polling (Shared Helper)

Read this file when you need to wait for CI after a push. Callers must
define their own **on-success** target before invoking this algorithm.

The shared CI wait thresholds and retry defaults are listed in
[IDD policy constants](../../docs/policy-constants.md). Use that inventory
to find the current named values; this helper still owns the behavior.

## Inputs

Before polling, collect:

1. PR number and current PR head SHA.
2. The required-check set for the target base branch.
3. Current check/run statuses for the same head SHA.

Use GitHub server timestamps and states only.

## Required-check discovery

Determine required checks from branch protection or rulesets before
interpreting `gh pr checks` output.

1. Prefer rulesets:

   ```sh
   gh api repos/{owner}/{repo}/rulesets --paginate
   ```

   Extract required status checks from rulesets that apply to the PR base
   branch.

2. If rulesets do not provide required checks, fall back to branch
   protection:

   ```sh
   gh api repos/{owner}/{repo}/branches/{base-branch}/protection
   ```

3. If neither source yields a required-check set, stop and post a hold
   comment (missing merge-gate policy evidence).

When caller phases already provide a trusted required-check set, reuse
that set instead of re-deriving it.

## Polling algorithm

1. Fetch current checks for the PR:

   ```sh
   gh pr checks {pr-number} --json name,state,completedAt,link
   ```

2. Normalize check states:
   - treat `skipped`, `neutral`, and `not_applicable` as pass-equivalent
   - keep `queued` and `in_progress` as running
   - keep `failure`, `cancelled`, and `timed_out` as non-pass
3. Evaluate only checks that are in the required-check set.
4. Repeat at a reasonable interval until a terminal route in the table
   below is reached.

Do not rely on `gh pr checks` command exit code as the gate decision.
The decision must be based on normalized required-check states.

## Rerun mechanics

When this helper says rerun once, rerun the exact failed or stalled run:

- rerun whole run: `gh run rerun <run-id>`
- rerun failed jobs only: `gh run rerun --failed <run-id>`

If GH CLI cannot resolve a run ID, use Actions REST endpoints directly
for the same run before posting a hold.

## Interpretation

| State                                           | Action                                                                                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All required checks generated and all `success` | → **on-success** (caller-defined)                                                                                                                                                  |
| Any required check `failure`                    | Inspect the log. If infra/flaky: rerun once. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step.                                  |
| Any `cancelled` or `timed_out`                  | Investigate cause. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. If infra-caused: re-push or rerun CI, then resume polling. |
| Any `queued` or `in_progress`                   | Continue waiting. After 30 min of no completion: rerun CI once. If still not complete: post a hold comment and stop.                                                               |
| Required checks not generated after 10 min      | Treat as `queued`/`in_progress`. If the corresponding workflow run does not exist at all: post a hold comment and escalate to a maintainer, then stop.                             |
