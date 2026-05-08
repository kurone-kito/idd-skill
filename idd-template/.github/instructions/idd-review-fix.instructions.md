# IDD — Review Fix Phase (E9–E15)

Read this file after `idd-review-triage.instructions.md` finds Accepted
PATH A items. It covers implementing fixes, validating, pushing,
replying to reviewers, and waiting for CI.

This phase also includes a repository-specific GitHub Copilot advisory
review step. Even when another local agent is driving the workflow,
follow it because the dependency is on GitHub review state, not on the
local CLI.

Apply the shared claim revalidation gate before E9, before the E12 push,
and before each E13/E14 GitHub side effect (reply, resolve, reviewer
request, or hold comment).

## E9 — Fix accepted issues

Fix all Accepted PATH A items from List A. Run **fix-validate**.

Commit fixes atomically — one logical change per commit.

## E10 — Validate fixes with critique pass

Run a critique pass to verify that the fixes in E9 address the root
causes and are correct (see `idd-overview.instructions.md` for per-agent
implementation). If the critique pass finds additional issues, fix them,
commit atomically, and run E10 again. Repeat until the critique pass
reports zero issues, then proceed to E11.

## E11 — Resolve conflicts with main

Check for conflicts between the feature branch and `main`. If conflicts
exist, rebase the feature branch onto `main`, resolve any conflicts, and
continue the rebase.

**Active review gate**: if the PR has unresolved review threads,
unreplied comments, or any reviewer's latest state is
`CHANGES_REQUESTED`, get explicit operator confirmation before rebasing,
as the history rewrite can disrupt ongoing review.

## E12 — Lint, test, push

Run **post-fix-validate**.

Then push with `--force-with-lease` (E11 uses rebase).

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

## E14 — Re-review request

**Human reviewers**: for each reviewer whose latest state is
`CHANGES_REQUESTED` and whose items have all been addressed, request a
re-review:

```sh
gh pr edit {pr-number} --add-reviewer {reviewer-login}
```

**Copilot**: after every push, regardless of any reviewer's state,
request a Copilot re-review if Copilot has not yet reviewed the current
HEAD SHA. Subject to a **workflow cap of 30 Copilot re-review requests
per PR** (this is a process limit, not a GitHub-enforced constraint).

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
   - **CAP_EXHAUSTED** (`MARKER_COUNT` ≥ 30, no same-head marker) →
     skip the advisory wait entirely; proceed directly to E15.
   - **REQUEST_NEEDED** (`COPILOT_PENDING` is `"false"`, cap < 30):
     request Copilot review and immediately post a plain-text marker:

     ```sh
     gh pr edit {pr-number} --add-reviewer "@copilot"
     ```

     ```text
     advisory-wait: {agent-id} {head-SHA} {ISO8601-requested-at}
     ```

     Use `PR_HEAD_SHA` as `{head-SHA}`. Post as plain text, not an HTML
     comment block.
   - **WAIT**, or after **REQUEST_NEEDED** marker is posted: enter the
     active polling loop below.

Copilot and CI advisory bot comments are advisory; unanswered ones do
not block merge.

**Active polling loop** (applies when `COPILOT_PENDING` is `"true"`, or
immediately after a new request was sent above):

Do **not** post a new marker if a same-head marker already exists; reuse
it. If multiple same-head markers exist, always use the one with the
**earliest** `createdAt` — the advisory clock starts at the first
request, not the last.

Take a fresh activity snapshot (same scope as E1 Step 1: all threads,
review bodies, and regular comments, excluding agent operational
markers). Record the highest `updatedAt` as the **temporary polling
watermark** — do **not** post it as a `<!-- review-watermark -->` PR
comment. If the snapshot is empty, use the `createdAt` of the latest
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment whose
`{claim-id}` matches the current active claim. If no same-claim
watermark exists, stop and return to E1 to create one.

Poll every 2 minutes:

1. Re-fetch `PR_HEAD_SHA`:

   ```sh
   CURRENT_HEAD=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

   If `CURRENT_HEAD != PR_HEAD_SHA` → HEAD changed; return to E1.

2. Re-read review threads, review bodies, and regular PR comments,
   **excluding any regular PR comment authored by any IDD agent** (covers
   advisory-wait, review-watermark, review-baseline, claim, hold notes,
   and other operational comments). If any item has `updatedAt` strictly
   newer than the polling watermark → return to E1 immediately.

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

Use `idd-ci.instructions.md` for the polling mechanics and timing. The
outcome paths below are authoritative and override the shared helper's
generic outcomes for this phase:

**While polling**: if new review threads or comments arrive during the
CI wait, note them. After CI resolves (any outcome), return to E1 before
proceeding to F — do not skip triage.

- **On success** → return to `idd-review-triage.instructions.md` (E1)
- **On failure / code-caused**: fix, run **fix-validate**, commit
  atomically, then return to E11
- **On failure / infra-flaky or pre-existing** (failure also present on
  `main`, unrelated to this branch): rerun once; if it persists, post a
  hold comment on the PR documenting the pre-existing failure and stop.
  A maintainer must resolve or bypass the failing check; do not
  auto-continue or treat as passed without human confirmation.
- **On cancelled / timed_out / code-caused**: fix, run **fix-validate**,
  commit, return to E11
- **On cancelled / timed_out / infra**: re-push or rerun CI once; if it
  cancels or times out again, post a hold comment and stop (do not
  loop). On success after the rerun, **return to E1**.
