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

4. **Distinguish a permission error from a genuine empty result** on
   each of the three reads above. A `404` on the branch-protection
   endpoint, or an empty ruleset list, means that source genuinely has
   nothing configured — a real empty result. For the ruleset-**detail**
   read (step 2), an empty result never arises from that call itself —
   step 2 only runs once per ruleset ID already returned by step 1, so a
   genuinely empty ruleset list in step 1 means step 2 has nothing to
   iterate over and is skipped entirely, not called with an empty
   result. A `403` / forbidden response on any of the three reads
   (including a `403` on an individual ruleset-detail call, e.g. a
   ruleset ID visible in the step 1 summary but not readable in detail)
   means the read itself failed (the token lacks permission to inspect
   protection or rulesets), not that no required checks exist. Never
   substitute an empty array/object for a `403` — record it as
   **unreadable**.

   **A `404` deserves the same scrutiny when the caller's permission
   level is not independently known.** Some GitHub REST endpoints
   substitute `404` for `403` on a private resource specifically to
   avoid revealing its existence to an unauthorized caller. The reads
   above are documented to return a dedicated `403` for an
   authenticated caller with insufficient permission — the
   branch-protection endpoint requires repository admin access, and its
   own reference distinguishes `403` (forbidden) from `404` (branch not
   protected) — so this file trusts `404` as genuine on that basis. When
   the acting token's admin-level access to this repository has **not**
   been independently confirmed (for example, via `GET
   /repos/{owner}/{repo}/collaborators/{username}/permission`, which
   only needs read access to call), treat an unexpected `404` on either
   the branch-protection or ruleset reads with the same suspicion as a
   `403` rather than trusting it outright.

   If any of the three reads returned `403` / unreadable, **fail
   closed**: do not fall through to step 6 below. Post a hold comment
   stating "cannot determine required checks: protection/ruleset
   unreadable" and stop. This is distinct from the genuine
   `noRequiredChecksConfigured` case in step 6, which requires every
   read to have returned a genuine result (`200`, or an empty/`404`),
   never an unread endpoint.

5. Build the required-check set as the union of enforcing-ruleset checks
   and branch-protection checks, using only the genuine (non-`403`)
   results from step 4. Keep expected check source metadata (GitHub
   App/integration) when configured.

6. If neither source yields a required-check set — and step 4 found no
   permission error on any of the reads — this is **not** automatically a
   hold — it is the same `noRequiredChecksConfigured: true` state
   `idd-pre-merge.instructions.md` F2's CI gate already interprets. When
   `pre-merge-readiness` output is available, reuse its
   `ci.presentRunConclusion` value directly. Otherwise, derive the
   equivalent from the current PR head SHA's actual runs: `all-passing`
   (every present run completed green) may proceed; `pending` → wait
   per the polling algorithm below, then re-check; `some-failing`, or
   `none` (no runs exist at all) → **hold**, do not treat an empty
   required-check set as a vacuous pass. See
   [F2 — Pre-merge condition check](idd-pre-merge.instructions.md#f2--pre-merge-condition-check)
   for the full routing table; do not duplicate it here.

When caller phases already provide a trusted required-check set, reuse
that set instead of re-deriving it.

## Polling algorithm

1. Fetch current checks for the PR:

   ```sh
   gh pr checks {pr-number} --json name,state,bucket,startedAt,completedAt,link
   ```

   **Duplicate-name-safe, HEAD-pinned reads**: `gh pr checks` can collapse
   same-named checks across workflows. When helper support is installed,
   read the profile-selected `ci-wait-state` snapshot instead (keyed by
   `(checkName, workflowName)`, live `headRefOid`); see
   `docs/idd-helper-scripts.md`.

   ```sh
   # source repo / vendored-node profile
   node scripts/ci-wait-state.mjs --pr {pr-number}

   # package-manager / ephemeral-npx profile
   <profile-selected-ci-wait-state-command> --pr {pr-number}
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

<!-- dprint-ignore-start -->
| State (required checks only, normalized) | Action |
| --- | --- |
| All required checks are generated and pass-equivalent | → **on-success** (caller-defined) |
| Any required check is non-pass `failure`, `action_required`, `startup_failure`, or `stale` | Inspect the log. If infra/flaky: apply `ciWait.rerunPolicy` (default `rerun-once`). If it resolves to rerun, rerun the exact failed run once and resume polling. If it resolves to hold, post a hold comment and stop. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. `action_required`, `startup_failure`, and `stale` rarely clear on a blind rerun: inspect, and if the check needs a maintainer action or a fresh run, post a hold comment and stop rather than looping reruns. |
| Any required check is non-pass `cancelled` or `timed_out` | Investigate cause. If code-caused: fix, run **fix-validate**, commit atomically, then return to caller's pre-push step. If infra-caused: apply `ciWait.rerunPolicy`; rerun or re-push only when the current rerun budget allows it, otherwise post a hold comment and stop. |
| Any required check is running (`pending`/`requested`/`waiting`/`expected`/...) | Continue waiting. After `ciWait.runningTimeout` — measured from the check's server `startedAt` (see the Polling algorithm) — elapses with no completion (default: 30 min), apply `ciWait.rerunPolicy`. If it resolves to rerun, rerun CI once and resume polling. If the same route recurs after that rerun, or if the policy is `hold`, post a hold comment and stop. |
| Required checks are not generated after `ciWait.generationTimeout` | Treat as running. Default: 10 min. If the corresponding workflow run does not exist at all when that window elapses, post a hold comment and escalate to a maintainer, then stop. |
<!-- dprint-ignore-end -->

## Hold-and-report failure shapes

Recognize this shape in one pass; hold-and-report instead of the
infra-vs-code triage above:

- **Account-level Actions billing / spend-limit block**: every job in
  every workflow fails near-instantly with an identical platform banner
  (the run starts but no steps execute, unlike a normal step failure).
  Non-transient — a rerun reproduces it, no code change fixes it. Skip
  `ciWait.rerunPolicy`; post a hold comment naming the block and stop for
  a maintainer.

## Wake-up discipline

The polling mechanics above are unchanged. This advisory, tool-agnostic note
keeps the **wait itself cheap**: the dominant cost of a wait is each
re-invocation's context re-read (worse once it crosses the prompt-cache TTL,
as CI/e2e waits routinely do), not the idle time.

**Portability**: prefer a synchronous / blocking wait in the worker's own
turn under supervisor/worker or multi-agent topologies — a background
wait's completion notification often reaches only the supervisor, so the
worker's turn ends and stalls until re-prompted (the background-wait
resumption caveat). Background the watch (below) only when the topology
is known to route completion back to the same turn.

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
