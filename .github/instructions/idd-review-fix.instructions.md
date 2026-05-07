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

Use these commands to check and request:

```sh
# Step 1: Fetch the current PR HEAD SHA from GitHub (authoritative source).
PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')

# Step 2: Check if Copilot has reviewed the current HEAD SHA.
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')
LAST_COPILOT_COMMIT=$(
  gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/reviews" \
    --paginate \
    --jq '.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) |
               {sa: .submitted_at, cid: .commit_id}' \
  | jq -rs 'sort_by(.sa) | last | .cid // ""'
)
# If LAST_COPILOT_COMMIT == PR_HEAD_SHA → Copilot already reviewed this HEAD;
# skip request and marker. E14 Copilot processing is done.

# Step 3: Check if Copilot review is already pending.
COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
  --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')
# "true" → Copilot is in requested_reviewers (review still pending);
# "false" → review was submitted or the request was cancelled.
# Note: GitHub uses "Copilot" (capital C) in the requested_reviewers API
# and "copilot-pull-request-reviewer[bot]" in the reviews API — both are
# matched here for robustness.

# Step 4a: If COPILOT_PENDING is "true" — do NOT request again (avoids
# resetting the advisory-wait clock). Use these commands to detect
# whether a same-head advisory-wait marker exists and find the earliest.
# Match by body format only (any IDD agent / prior session may have posted it).
EARLIEST_SAME_HEAD_AT=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -r -s "add
         | [.[] | select(
               (.body | test(\"^advisory-wait: [^ ]+ ${PR_HEAD_SHA}(?: |\$)\")) or
               (.body | test(\"^<!-- advisory-wait: [^ ]+ ${PR_HEAD_SHA} [^ ]+ -->$\"))
             )]
         | min_by(.created_at) | .created_at // \"\""
)
# Matches both plain-text (new) and HTML-comment (legacy) marker formats.
# If EARLIEST_SAME_HEAD_AT is empty → no same-head marker exists (see below).
# If EARLIEST_SAME_HEAD_AT is non-empty → marker exists; value is the
# earliest marker createdAt (use for all elapsed-time checks).
#   - Marker exists: do NOT post a new marker. Skip to the polling
#     section below; use EARLIEST_SAME_HEAD_AT as the advisory-clock start.
#   - No marker exists: this is an inconsistent state (Copilot is
#     pending but no marker was ever posted for this HEAD). Post a hold
#     comment: "Copilot review is pending for HEAD {PR_HEAD_SHA} but no
#     advisory-wait marker was found. E14 may have crashed before posting
#     the marker. A maintainer must verify whether the Copilot review was
#     formally requested and confirm its status before E14 can safely
#     continue." **Stop.**

# Step 4b: If COPILOT_PENDING is "false" — check the cap before requesting.
# Count total advisory-wait markers for the 30-per-PR cap (all agents):
MARKER_COUNT=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -r -s 'add | [.[] | select(.body | test("^advisory-wait:|^<!-- advisory-wait:"))] | length'
)
# Each marker represents one --add-reviewer "@copilot" request.
# If MARKER_COUNT >= 30 → do NOT request; skip the advisory wait entirely
#   and proceed directly to E15.
# If MARKER_COUNT < 30 → request Copilot review:
gh pr edit {pr-number} --add-reviewer "@copilot"
```

- Copilot and CI advisory bot comments are advisory; unanswered ones do
  not block merge.

**Waiting for advisory bot re-reviews**: this section applies only when
Step 4b ran (`COPILOT_PENDING` was `"false"` and the request was sent),
or when Step 4a ran (`COPILOT_PENDING` was `"true"` and a same-head
marker was found). **If `LAST_COPILOT_COMMIT == PR_HEAD_SHA` (Copilot
already reviewed the current HEAD at Step 2), skip this entire section —
E14 Copilot processing is complete.**

For the Step 4b case (request just sent): persist the advisory wait
start time by posting a plain-text marker comment:

```text
advisory-wait: {agent-id} {head-SHA} {ISO8601-requested-at}
```

**Important**: post this as plain text, not as an HTML comment block.
Use `PR_HEAD_SHA` as the `{head-SHA}` value so F2 and resume logic can
distinguish waits for different pushes.

For the Step 4a case (pending, marker already exists): do **not** post a
new marker; reuse the existing same-head advisory-wait markers. If
multiple same-head markers exist, use the one with the **earliest**
`createdAt` (the advisory clock starts at the first request, not the
last).

For both Step 4b and Step 4a (marker-exists) cases: take a fresh
snapshot of the activity universe (same scope as E1 Step 1: all threads,
review bodies, and regular comments, excluding agent operational
markers). Record the highest `updatedAt` across all fetched items —
including your own recent actions — as the **temporary polling
watermark**. Do **not** post this as a `<!-- review-watermark -->` PR
comment; it is ephemeral. (If the snapshot is empty, use the `createdAt`
of the latest `<!-- review-watermark: {agent-id} {claim-id} … -->`
comment whose embedded `{claim-id}` matches the current active claim. If
no such same-claim watermark exists, stop waiting and return to E1 to
create one — do not borrow another claim's watermark.) Then poll until
an exit condition below is met:

- Poll every 2 minutes: at the start of each iteration, first re-fetch
  `PR_HEAD_SHA` to detect if a push happened during the wait:

  ```sh
  CURRENT_HEAD=$(gh pr view {pr-number} --json headRefOid \
    --jq '.headRefOid')
  # If CURRENT_HEAD != PR_HEAD_SHA → HEAD changed; a new push happened.
  # Exit immediately to E1. A new advisory-wait marker will be needed
  # for the new HEAD.
  ```

  If `CURRENT_HEAD != PR_HEAD_SHA` → stop waiting and return to E1. The
  new HEAD must be re-evaluated; if Copilot has not reviewed it, E14/F2
  will need a new advisory-wait marker for that HEAD.

  Otherwise read all review threads, review bodies, and regular PR
  comments, **excluding any regular PR comment authored by any IDD
  agent** (this covers advisory-wait, review-watermark, review-baseline,
  claim, hold notes, and any other operational comments an agent may
  post); compare `updatedAt` against the polling watermark. Also check
  `requested_reviewers` (via REST API) to determine whether Copilot's
  review is still pending:

  ```sh
  COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
    --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')
  # "true" → review still pending; "false" → submitted or cancelled.
  # Note: "Copilot" (capital C) is used in requested_reviewers; the OR
  # condition also covers "copilot-pull-request-reviewer[bot]" for robustness.
  ```

  'Elapsed time' in all conditions below means the current UTC time
  minus the `createdAt` of the **earliest** same-head advisory-wait PR
  comment as returned by the GitHub API — not the timestamp inside the
  marker body. If multiple same-head markers exist, always use the one
  with the earliest `createdAt`. At the start of each poll iteration,
  refresh the value with:

  ```sh
  EARLIEST_SAME_HEAD_AT=$(
    gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
      | jq -r -s "add
           | [.[] | select(
                 (.body | test(\"^advisory-wait: [^ ]+ ${PR_HEAD_SHA}(?: |\$)\")) or
                 (.body | test(\"^<!-- advisory-wait: [^ ]+ ${PR_HEAD_SHA} [^ ]+ -->$\"))
               )]
           | min_by(.created_at) | .created_at // \"\""
  )
  # Matches both plain-text (new) and HTML-comment (legacy) marker formats.
  # Elapsed time = (current UTC time) − EARLIEST_SAME_HEAD_AT.
  ```

  If `EARLIEST_SAME_HEAD_AT` is empty after this refresh (marker deleted
  or never posted): post a hold comment: "Advisory-wait marker for HEAD
  `{PR_HEAD_SHA}` is missing during polling. Unable to compute elapsed
  time. A maintainer must verify the Copilot advisory-wait state before
  E14 can safely continue." **Stop.**

- If **any** item has `updatedAt` strictly newer than the polling
  watermark → stop waiting and return to E1 immediately to process it.
- If elapsed time ≥ 30 minutes (hard cap) → proceed to E15 regardless of
  `COPILOT_PENDING`. The advisory window has expired. (Evaluate this
  before the 10-minute conditions; otherwise the pending-true branch
  below masks this exit for a Haiku-level reader.)
- If elapsed time ≥ 10 minutes AND `COPILOT_PENDING` is `"false"` →
  proceed to E15. (Copilot submitted the review or the request was
  cancelled; either counts as no longer pending.)
- If elapsed time ≥ 10 minutes AND `COPILOT_PENDING` is `"true"` →
  **continue polling**. Do NOT exit to E15 while the review is still
  pending.

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
