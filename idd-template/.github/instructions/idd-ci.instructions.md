# IDD — CI Polling (Shared Helper)

Read this file when you need to wait for CI after a push. Callers must
define their own **on-success** target before invoking this algorithm.

The shared CI wait defaults are listed in
[IDD policy constants](../../docs/policy-constants.md). When
`.github/idd/config.json` is present and valid, resolve this helper
through `ciWait.runningTimeout`, `ciWait.generationTimeout`, and
`ciWait.rerunPolicy`; otherwise keep the distributed defaults
(`PT30M`, `PT10M`, `rerun-once`).

When helper support is installed, use the profile-selected ci-wait
policy helper command as the canonical read-only policy resolver.

```sh
# source repo / vendored-node profile
node scripts/ci-wait-policy.mjs

# package-manager / ephemeral-npx profile
<profile-selected-ci-wait-policy-command>
```

Append `--rerun-count <count>` when the caller needs the deterministic
rerun-budget decision. Resolve
`<profile-selected-ci-wait-policy-command>` from the helper runtime
manifest wiring in `docs/idd-helper-scripts.md`. Do not hardcode
`node scripts/ci-wait-policy.mjs` for profiles that do not vendor
`scripts/`.

## Shared policy keys

- `ciWait.runningTimeout`: maximum time to keep polling required checks
  in a running state before the stalled-run recovery route begins.
  Default: `PT30M` (30 min).
- `ciWait.generationTimeout`: maximum time to wait for required checks
  to appear at all. Default: `PT10M` (10 min).
- `ciWait.rerunPolicy`: rerun budget for infra or stalled CI recovery.
  Default: `rerun-once`.
  `rerun-once` means the first eligible infra or stalled route reruns
  exactly once, and the next recurrence posts a hold and stops. `hold`
  means do not auto-rerun; post a hold comment at the first eligible
  infra or stalled route.

## Inputs

Before polling, collect:

1. PR number and current PR head SHA.
2. The required-check set for the target base branch.
3. Current check/run statuses for the same head SHA.

Use GitHub server timestamps and states only.

## Required-check discovery

Determine required checks from branch protection or rulesets before
interpreting `gh pr checks` output.

1. Fetch ruleset summaries:

   ```sh
   gh api repos/{owner}/{repo}/rulesets --paginate
   ```

2. Fetch each ruleset detail:

   ```sh
   gh api repos/{owner}/{repo}/rulesets/{ruleset-id}
   ```

   Use detail payload rules only from enforcing rulesets that apply to
   the PR base branch.

3. Fetch branch protection checks for the base branch too (do not treat
   this as mutually exclusive with rulesets). URL-encode branch names
   before calling this endpoint:

   ```sh
   gh api repos/{owner}/{repo}/branches/{url-encoded-base-branch}/protection
   ```

4. Build the required-check set as the union of enforcing-ruleset checks
   and branch-protection checks. Keep expected check source metadata
   (GitHub App/integration) when configured.

5. If neither source yields a required-check set, stop and post a hold
   comment (missing merge-gate policy evidence).

When caller phases already provide a trusted required-check set, reuse
that set instead of re-deriving it.

## Polling algorithm

1. Fetch current checks for the PR:

   ```sh
   gh pr checks {pr-number} --json name,state,bucket,startedAt,completedAt,link
   ```

2. Normalize check states:
   - treat `skipped`, `neutral`, and `not_applicable` as pass-equivalent
   - treat `pending`, `requested`, `waiting`, `queued`,
     `in_progress`, and the Commit-Status `expected` state as running
   - keep `failure`, `cancelled`, `timed_out`, `action_required`,
     `startup_failure`, and `stale` as non-pass
3. Evaluate only checks in the required-check set, and match expected
   check source when the required definition includes an app/integration
   constraint.
4. Repeat at a reasonable interval until a terminal route in the table
   below is reached.

Measure each running check's `ciWait.runningTimeout` window from its
server `startedAt`. When `startedAt` is absent (a queued check that has
not started yet), the running-timeout has not begun: keep polling, but
cap that wait at `ciWait.generationTimeout`. Some running states never
report a `startedAt` — a Commit-Status `expected` context in particular
may stay started-less — so when `ciWait.generationTimeout` elapses with
still no `startedAt`, post a hold comment and escalate rather than
polling indefinitely. Never anchor the window to a client clock.

Do not rely on `gh pr checks` command exit code as the gate decision.
The decision must be based on normalized required-check states.

## Rerun mechanics

When the resolved `ciWait.rerunPolicy` says rerun, rerun the exact
failed or stalled run:

- rerun whole run: `gh run rerun <run-id>`
- rerun failed jobs only: `gh run rerun --failed <run-id>`

Extract `<run-id>` from the failing check `link` field (for example:
`https://github.com/{owner}/{repo}/actions/runs/<run-id>/job/<job-id>`),
or query the Actions API for runs filtered to the current PR head SHA and
check name.

If GH CLI cannot resolve a run ID, use Actions REST endpoints directly
for the same run before posting a hold.

## Interpretation

| State (required checks only, normalized)                                                   | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All required checks are generated and pass-equivalent                                      | → **on-success** (caller-defined)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Any required check is non-pass `failure`, `action_required`, `startup_failure`, or `stale` | Inspect the log. If infra/flaky: apply `ciWait.rerunPolicy` (default `rerun-once`). If it resolves to rerun, rerun the exact failed run once and resume polling. If it resolves to hold, post a hold comment and stop. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. `action_required`, `startup_failure`, and `stale` rarely clear on a blind rerun: inspect, and if the check needs a maintainer action or a fresh run, post a hold comment and stop rather than looping reruns. |
| Any required check is non-pass `cancelled` or `timed_out`                                  | Investigate cause. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. If infra-caused: apply `ciWait.rerunPolicy`; rerun or re-push only when the current rerun budget allows it, otherwise post a hold comment and stop.                                                                                                                                                                                                                                                               |
| Any required check is running (`pending`/`requested`/`waiting`/`expected`/...)             | Continue waiting. After `ciWait.runningTimeout` — measured from the check's server `startedAt` (see the Polling algorithm) — elapses with no completion (default: 30 min), apply `ciWait.rerunPolicy`. If it resolves to rerun, rerun CI once and resume polling. If the same route recurs after that rerun, or if the policy is `hold`, post a hold comment and stop.                                                                                                                                                                    |
| Required checks are not generated after `ciWait.generationTimeout`                         | Treat as running. Default: 10 min. If the corresponding workflow run does not exist at all when that window elapses, post a hold comment and escalate to a maintainer, then stop.                                                                                                                                                                                                                                                                                                                                                         |

## Wake-up discipline

The polling mechanics above are unchanged. This advisory, tool-agnostic note
keeps the **wait itself cheap**: the dominant cost of a wait is each
re-invocation's context re-read (worse once it crosses the prompt-cache TTL,
as CI/e2e waits routinely do), not the idle time.

- **No interim polling turns** — background the watch, or schedule one wake at
  the **expected** completion interval; do not insert "is it done yet?" turns
  or peek at an empty watch buffer between wakes.
- **Batch post-wait actions** into a single turn once the wait resolves
  (disposition, replies, marker, next gate together — not one round-trip each).
- **Scope post-fix re-validation to the changed surface** when the change is
  provably outside the full build/test suite, instead of re-running everything
  (also avoids the context cost of large log outputs).

This trims only the wasteful dimensions (context re-read, CI minutes); it does
**not** reduce review rounds, which remain valuable and run in full. This same
discipline applies to the advisory-wait and review-fix wait points.
