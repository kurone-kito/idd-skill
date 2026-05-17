# IDD — Review Fix Phase (E9–E15)

Read this file after `idd-review-triage.instructions.md` (E8) finds
Accepted PATH A items. It covers implementing fixes, validating, pushing,
replying to reviewers, and waiting for CI.

This phase also includes a repository-specific GitHub Copilot advisory
review step. Even when another local agent is driving the workflow,
follow it because the dependency is on GitHub review state, not on the
local CLI.

The advisory-review timing defaults used by E14 are named in
[IDD policy constants](../../docs/policy-constants.md). Refer there when
you need the values, but keep the phase logic here unchanged.

Apply the shared claim revalidation gate before E9, before the E12 push,
and before each E13/E14/E15 GitHub side effect (reply, resolve,
reviewer request, hold comment, or digest update).

## E9 — Fix accepted issues

Fix all Accepted PATH A items from ReviewItems_snapshot. Run **fix-validate**.

Commit fixes atomically — one logical change per commit.

## E10 — Validate fixes with critique pass

Run a critique pass to verify that the fixes in E9 address the root
causes and are correct (see `idd-overview.instructions.md` for per-agent
implementation). The distributed defaults for the E10 guardrails are
listed in `docs/policy-constants.md`. Keep an E10 pass count for the
current E9 fix batch.

If the critique pass finds additional issues, fix them, commit
atomically, and run E10 again while the findings are converging.

Convergence guardrails:

- "Meaningful progress" means a pass removes at least one Accepted
  finding, narrows a remaining finding's root cause or scope, or yields
  a materially new fix direction. Reworded duplicate findings do not
  count.
- If the same Accepted findings recur for
  `critiqueLoop.e10NoProgressHoldAfter` consecutive E10 passes
  (distributed default: `3`) without meaningful progress, stop the
  auto-loop. Post a hold comment on the PR summarizing the repeated
  findings and attempted fixes, and wait for a maintainer decision
  before more E10 iterations.
- Do not use this stop condition to bypass serious issues: unresolved
  High or Medium findings remain blockers until fixed or explicitly
  redirected by a maintainer.
- If the critique pass reports zero issues, proceed to E11.

## E11 — Resolve conflicts with main

Check for conflicts between the feature branch and `main`. If conflicts
exist, merge `main` into the feature branch
(`git fetch origin main && git merge origin/main`), resolve any
conflicts, and complete the merge.

**Active review gate**: if the PR has unresolved review threads,
unreplied comments, or any reviewer's latest state is
`CHANGES_REQUESTED`, get explicit operator confirmation before merging
`main` into the feature branch, as the merge commit will appear in the
PR history.

## E12 — Lint, test, push

Run **post-fix-validate**.

Then push the feature branch normally (E11 uses merge commits, not
rebase, so no force push is required).

## E13 — Reply to feedback

For each Accepted PATH A item whose source is reviewer feedback (review
thread, review body, or regular comment): reply describing which commits
fixed it and how.

Start every reply with one of these prefixes so that disposition is
unambiguous:

- `**Accepted** — fixed in {commit-sha or comma-separated list}: {brief explanation}`

- **Review threads**: after posting your reply, **immediately resolve
  the thread**. Resolution means "agent has responded and acted on the
  feedback", not "reviewer has agreed". If the reviewer disagrees, they
  can reopen the thread and add a new reply, which will re-surface it in
  the next E1 pass.
- **Regular comments**: reply only; do not resolve.

After E13 replies and resolutions are complete, upsert the PR live
status digest before E14 if the next route is still review-fix or CI
wait. Set `Phase` to `E13 feedback replied`, `Open blockers` to any
remaining reviewer, advisory, or CI wait, `Next action` to E14 or E15,
and `Authoritative by` to the accepted feedback replies, resolved
threads, current HEAD, and verified claim. Because E15 returns to E1
after CI, this digest edit is safe activity; do not use it to bypass the
next E1 snapshot.

## E14 — Re-review request

**Human reviewers**: for each reviewer whose latest state is
`CHANGES_REQUESTED` and whose items have all been addressed, request a
re-review:

```sh
gh pr edit {pr-number} --add-reviewer {reviewer-login}
```

**Copilot**: after every push, regardless of any reviewer's state,
request a Copilot re-review if Copilot has not yet reviewed the current
HEAD SHA. Subject to the configured Copilot re-review request cap
(`REQUEST_CAP` from helper output or `.github/idd/config.json`
`advisoryWait.requestCap`; default 30). This is a process limit, not a
GitHub-enforced constraint.

1. Fetch `PR_HEAD_SHA`:

   ```sh
   PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

2. Run **AW1** (`idd-advisory-wait.instructions.md`). If **SATISFIED** →
   E14 Copilot processing is done; proceed to E15.
3. Run **AW2** to fetch markers.
4. Apply the **AW3** decision table:
   - **SATISFIED** → proceed to E15.
   - **HOLD** → post the hold comment from **AW4** and stop.
   - **RECOVERY_NEEDED** (`COPILOT_PENDING` is `"true"`, no same-head
     marker): post the recovery marker from **AW3-R**. Do not request
     another Copilot review.
   - **CAP_EXHAUSTED** (`REQUEST_MARKER_COUNT` ≥ `REQUEST_CAP`, no
     same-head marker) →
     if `CAP_EXHAUSTED_ROUTE` is `hold`, post the hold comment from
     **AW4** and stop. Otherwise (`phase-specific`, the default), skip
     the advisory wait entirely and proceed directly to E15.
   - **REQUEST_NEEDED** (`COPILOT_PENDING` is `"false"`, or
     `COPILOT_PENDING` is `"true"` but current-head coverage is not
     proven; request cap < `REQUEST_CAP`): request Copilot review and
     immediately post a plain-text marker. If `COPILOT_PENDING` is
     `"true"` in this branch, first remove the stale/unproven pending
     reviewer request:

     ```sh
     gh pr edit {pr-number} --remove-reviewer "@copilot"
     ```

     If removal fails because Copilot is no longer pending, re-run
     AW1–AW3. If removal fails for any other reason, post the AW4
     pending-refresh-failed hold comment and stop. After removal
     succeeds, request Copilot review:

     ```sh
     gh pr edit {pr-number} --add-reviewer "@copilot"
     ```

     ```text
     advisory-wait: {agent-id} {head-SHA} {ISO8601-requested-at}
     ```

     Use `PR_HEAD_SHA` as `{head-SHA}`. Post as plain text, not an HTML
     comment block.
   - **WAIT**, or after a **REQUEST_NEEDED** or **RECOVERY_NEEDED**
     marker is posted: enter the active polling loop below.

Copilot and CI advisory bot comments are advisory; unanswered ones do
not block merge.

Whenever E14 posts a Copilot request marker, recovery marker, or hold
comment, update the digest after that side effect with the current
advisory state. Use the marker or hold comment as `Authoritative by`,
set `Open blockers` to the advisory wait or hold reason, and set
`Next action` to polling, E15, or maintainer action.

**Active polling loop** (applies when `COPILOT_PENDING` is `"true"`, or
immediately after posting a marker in the **REQUEST_NEEDED** or
**RECOVERY_NEEDED** path above):

Do **not** post a new marker if a same-head marker already exists; reuse
it. If multiple same-head markers exist, always use the one with the
**earliest** `createdAt` — the advisory clock starts at the first
request, not the last.

Take a fresh activity snapshot (same scope as E1 Step 1: all threads,
review bodies, and regular comments, excluding trusted agent
operational markers only). Record the highest `updatedAt` as the
**temporary polling watermark** — do **not** post it as a
`<!-- review-watermark -->` PR comment. If the snapshot is empty, use
the `createdAt` of the latest
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment whose
`{claim-id}` matches the current active claim and whose GitHub author is
a trusted marker actor. If no trusted same-claim watermark exists, stop
and return to E1 to create one.

Poll every `POLL_INTERVAL_MINUTES` minutes:

1. Re-fetch `PR_HEAD_SHA`:

   ```sh
   CURRENT_HEAD=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

   If `CURRENT_HEAD != PR_HEAD_SHA` → HEAD changed; return to E1.

2. Re-read review threads, review bodies, and regular PR comments,
   **excluding trusted agent operational marker comments only** (covers
   advisory-wait, advisory-wait-recovery, review-watermark,
   review-baseline, claim, hold notes, and other operational comments
   from trusted marker actors). Marker-shaped comments from untrusted
   authors remain activity. If any item has `updatedAt` strictly newer
   than the polling watermark → return to E1 immediately.

3. Run **AW1** and **AW2** (refresh `COPILOT_PENDING`, `LAST_COPILOT_COMMIT`,
   and `EARLIEST_SAME_HEAD_AT`). Apply **AW5** if `EARLIEST_SAME_HEAD_AT`
   is empty. Then apply **AW3**:
   - **SATISFIED** → exit polling; proceed to E15.
   - **HOLD** → post hold comment from **AW4** or **AW5**; stop.
   - **WAIT** → continue polling.

Note: "advisory" means the agent is not obligated to accept every
suggestion — it does **not** mean the agent can skip waiting for a
review it explicitly requested. Human `CHANGES_REQUESTED` reviewers are
not advisory; they remain under the hold/escalation path above.

## E15 — Wait for CI

Use `idd-ci.instructions.md` for the polling mechanics and timing. E15
reuses the same resolved `ciWait.runningTimeout`,
`ciWait.generationTimeout`, and `ciWait.rerunPolicy` values; omitted
keys preserve the distributed defaults. The outcome paths below are
authoritative and override the shared helper's generic outcomes for this
phase:

**While polling**: if new review threads or comments arrive during the
CI wait, note them. After CI resolves (any outcome), return to E1 before
proceeding to F — do not skip triage.

- **On success** → return to `idd-review-snapshot.instructions.md` (E1)
- **On failure / code-caused**: fix, run **fix-validate**, commit
  atomically, then return to E11
- **On failure / infra-flaky or pre-existing** (failure also present on
  `main`, unrelated to this branch): apply `ciWait.rerunPolicy`
  (default `rerun-once`). If it authorizes the current rerun, rerun
  once and resume polling. If the failure persists after that rerun, or
  if the policy is `hold`, post a hold comment on the PR documenting the
  pre-existing failure and stop. A maintainer must resolve or bypass the
  failing check; do not auto-continue or treat as passed without human
  confirmation.
- **On cancelled / timed_out / code-caused**: fix, run **fix-validate**,
  commit, return to E11
- **On cancelled / timed_out / infra**: apply `ciWait.rerunPolicy`.
  Re-push or rerun CI only when the policy authorizes the current rerun;
  if the route recurs after that rerun, or if the policy is `hold`,
  post a hold comment and stop (do not loop). On success after the
  rerun, **return to E1**.

When E15 stops on a CI hold, re-validate the claim and then update the
digest with `Phase: E15 hold`, the failing or missing checks in
`Open blockers`, and the maintainer or rerun expectation in
`Next action`. On CI success, do not edit the digest before returning to
E1; let the next E1/F pass refresh review currency first.
