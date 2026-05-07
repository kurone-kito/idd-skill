# IDD — Merge Phase (F)

Read this file after CI passes and List A is empty (from review triage),
or when returning to merge conditions after a fix cycle. It covers final
conflict resolution, pre-merge conditions, executing the merge, and
cleanup.

This phase also includes a repository-specific GitHub Copilot advisory
review gate. Even when another local agent is driving the workflow,
follow it because the dependency is on GitHub review state, not on the
local CLI.

Before any F-phase mutating action, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

## F1 — Final conflict resolution

Check whether the PR branch is out of date with `main` by running:

```sh
gh pr view {pr-number} --json mergeable,mergeStateStatus
```

If `mergeable` is `CONFLICTING` or `mergeStateStatus` is `BEHIND` or
`DIRTY`, resolve conflicts:

1. **Active review gate**: if the PR has unresolved review threads,
   unreplied comments, or any reviewer's latest state is
   `CHANGES_REQUESTED`, get explicit operator confirmation before
   rebasing, as the history rewrite can disrupt ongoing review.
2. Rebase onto `main`. Resolve any conflicts and continue the rebase.
3. Run **post-fix-validate**.

4. Push (use `--force-with-lease` if you rebased).
5. If the HEAD changed (new commits were added): return to
   `idd-review-triage.instructions.md` (E1) to re-evaluate reviews.

## F2 — Pre-merge condition check

Verify **all** of the following. If any condition is not met, follow the
bracketed action:

- **Review currency** (live re-fetch required, freshness gate): read the
  most recent `<!-- review-watermark: {agent-id} {claim-id} … -->`
  comment whose embedded `{claim-id}` matches the current active claim.
  The comment's first two fields identify the watermark — (a) agent-id
  and (b) claim-id, already used to locate this comment. Extract the
  remaining values: (c) the `{head-SHA}` value; (d) the
  `{max-activity-updatedAt}` value (`none` if empty); (e) the
  `{total-item-count}` value; (f) the `{latest-ci-completed-at}` value
  (`none` if empty). If no such same-claim watermark exists, return to
  E1 unconditionally. Legacy watermarks without `{claim-id}` must not be
  reused across a restart or takeover. Then fetch the activity universe
  snapshot (same scope as E1 Step 1) and the current CI state for the
  HEAD SHA. Return to E1 if **any** of the following is true:
  - The current PR HEAD SHA differs from the stored `{head-SHA}` (a new
    push occurred after E1's snapshot, even if the watermark comment was
    posted later).
  - The stored value is `none` and the live snapshot is non-empty (the
    PR was empty at E1 time but now has review activity).
  - The stored value is not `none`, and any fetched item's `updatedAt`
    is strictly newer than `{max-activity-updatedAt}` (new activity
    arrived since last E1 run).
  - The stored value is not `none`, and the live total item count
    exceeds `{total-item-count}` (new items arrived at the same
    timestamp as the stored max, which would not be caught by the
    previous check).
  - The current latest CI pass `completedAt` for HEAD differs from
    `{latest-ci-completed-at}` in the watermark (a new CI run completed
    after E1's snapshot; if watermark value is `none`, any current CI
    pass triggers re-evaluation).
- **Advisory bot wait** (restart-safe enforcement): Use the following
  commands to check the Copilot review state and `requested_reviewers`.
  Run these at the start of this check and again during any polling
  loop:

  ```sh
  # Fetch the current PR HEAD SHA from GitHub (authoritative source).
  PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')

  # Check if Copilot has reviewed the current HEAD SHA.
  OWNER=$(gh repo view --json owner --jq '.owner.login')
  REPO=$(gh repo view --json name --jq '.name')
  LAST_COPILOT_COMMIT=$(
    gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/reviews" \
      --paginate \
      --jq '.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) |
                  {sa: .submitted_at, cid: .commit_id}' \
    | jq -rs 'sort_by(.sa) | last | .cid // ""'
  )
  # If LAST_COPILOT_COMMIT == PR_HEAD_SHA → Copilot reviewed the current HEAD.

  # Check whether Copilot's review is still pending.
  COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
    --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')
  # "true" → Copilot is in requested_reviewers (review still pending);
  # "false" → review was submitted or the request was cancelled.
  # Note: GitHub uses "Copilot" (capital C) in the requested_reviewers API
  # and "copilot-pull-request-reviewer[bot]" in the reviews API — both are
  # matched here for robustness.
  ```

  If `LAST_COPILOT_COMMIT == PR_HEAD_SHA` (Copilot has reviewed the
  current HEAD): this check is **satisfied**.

  Otherwise (Copilot has not reviewed current HEAD): collect all
  `advisory-wait: {any-agent-id} {head-SHA} …` comments from any IDD
  agent whose `{head-SHA}` matches the current PR HEAD. Use the one with
  the **earliest** `createdAt` for elapsed time calculation (the
  advisory clock starts at the first request, not the last). Use these
  commands to fetch and time the markers:

  ```sh
  # Fetch same-head advisory-wait markers and find the earliest createdAt.
  # Match by body format; any IDD agent / prior session may have posted the marker.
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
  # If empty → no same-head marker exists.
  # If non-empty → earliest same-head marker createdAt (advisory-clock start).

  # Count total advisory-wait markers across all HEADs (for the 30-per-PR cap):
  MARKER_COUNT=$(
    gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
      | jq -r -s 'add | [.[] | select(.body | test("^advisory-wait:|^<!-- advisory-wait:"))] | length'
  )
  # Matches both plain-text (new) and HTML-comment (legacy) marker formats.
  # If MARKER_COUNT >= 30 → cap exhausted (see Branch B no-marker case).
  ```

  Then branch on `COPILOT_PENDING`:

  **Branch A — `COPILOT_PENDING` is `"true"` (review actively
  pending)**:
  - No marker exists for current HEAD → this is an inconsistent state.
    Post a hold comment: "Copilot review is pending for HEAD
    `{PR_HEAD_SHA}` but no advisory-wait marker was found. E14 may have
    crashed before posting the marker. A maintainer must verify whether
    the Copilot review was formally requested and confirm its status
    before the merge can proceed. Do not merge or post a new
    advisory-wait marker until the maintainer has resolved this."
    **Stop.**
  - Marker exists; elapsed < 10 min: wait for the remainder of the
    10-minute window (poll every 2 min), then **go back to the first
    condition in F2 (the 'Review currency' check)** to pick up any
    activity that arrived during the wait.
  - Marker exists; elapsed 10–30 min: **go back to the first condition
    in F2 (the 'Review currency' check) every 2 minutes**. F2 will
    re-evaluate all conditions including new review activity; if
    `COPILOT_PENDING` is still `"true"`, it will re-enter this branch.
  - Marker exists; elapsed ≥ 30 min: this advisory-bot-wait check is
    **satisfied**. The advisory window has expired. Continue to the next
    F2 gate (the **CI** check).

  **Branch B — `COPILOT_PENDING` is `"false"` (request completed or
  manually cancelled)**: GitHub removes a reviewer from
  `requested_reviewers` when they submit a review OR when the request is
  manually cancelled by the PR author. Either outcome counts as "no
  longer pending" for merge purposes — the advisory wait is treated as
  honored once the pending state is cleared.
  - Marker exists; elapsed ≥ 10 min: this check is **satisfied**.
  - Marker exists; elapsed < 10 min: wait for the remainder of the
    10-minute window (poll every 2 min), then **go back to the first
    condition in F2** to re-evaluate.
  - No marker exists: use `MARKER_COUNT` (computed above). If
    `MARKER_COUNT` ≥ 30 → post hold comment: "The 30-per-PR Copilot
    re-review cap is exhausted. A maintainer must manually request and
    evaluate a Copilot review before merge." **Stop.** If `MARKER_COUNT`
    < 30 → return to E14 to request Copilot review and post a fresh
    marker.

  'Elapsed time' means the current UTC time minus the `createdAt` of the
  **earliest** same-head advisory-wait PR comment
  (`EARLIEST_SAME_HEAD_AT`, computed above) as returned by the GitHub
  API — not the timestamp inside the marker body.
- **CI**: Current PR head SHA has all required CI checks generated and
  all passing (→ run CI wait per `idd-ci.instructions.md`, on-success →
  re-evaluate F2)
- **Required reviews**: Required approvals count is satisfied and all
  CODEOWNER approvals are obtained. If approvals are absent but there
  are no open actionable review items (List A is empty), do **not**
  route to E1 — instead, request CODEOWNER/required reviewers directly
  (if not already requested), post a hold comment, and stop. Return to
  E1 only when there are actual review threads or comments to address (→
  go to `idd-review-triage.instructions.md` only in that case).
- **No `CHANGES_REQUESTED`** (human/required/CODEOWNER reviewers only):
  No human, required, or CODEOWNER reviewer's latest state is
  `CHANGES_REQUESTED` (→ if not yet addressed, return to review triage;
  if already addressed and re-review requested, wait up to 30 min; if
  still no response, post a hold comment and stop). Advisory bot
  reviewers (Copilot, CI bots) are exempt from this check — their
  `CHANGES_REQUESTED` state does not block merge after the advisory wait
  window completes.
- **Unresolved threads = 0** (backlog gate, orthogonal to the currency
  check above): No unresolved review threads remain, excluding
  **awaiting-reviewer threads**. A thread is awaiting-reviewer if
  **all** of the following hold: (1) the latest substantive thread
  comment is from any IDD agent or the PR author; (2) no reviewer has
  added a comment after that latest IDD-agent/PR-author comment; (3) the
  reviewer has **not** reopened the thread after that latest comment — a
  reopen action with no new text still counts as reviewer activity and
  disqualifies the thread from awaiting-reviewer status; (4) the thread
  does **not** contain an IDD-agent reply starting with
  `**Awaiting maintainer decision**`. (→ return to review triage if any
  non-awaiting-reviewer unresolved threads remain). Any remaining
  unresolved thread that is not awaiting-reviewer indicates a new
  reviewer comment or a thread the reviewer reopened — both require
  attention. Exception: if the repo's branch protection requires
  conversation resolution, the awaiting-reviewer exclusion does not
  apply — all unresolved awaiting-reviewer threads must be resolved.
  Note: AMD threads (those containing an IDD agent reply starting with
  `**Awaiting maintainer decision**`) are **not** awaiting-reviewer by
  definition; they are handled by the standard "non-awaiting-reviewer →
  return to review triage" path, where E6 will detect the pending
  maintainer response and post a hold. For each remaining unresolved
  awaiting-reviewer thread under this exception: **(a)** if its latest
  reply is from an **IDD agent** and it does **NOT** contain an AMD
  reply — resolve it directly (direct resolution is permitted under this
  constraint), then restart F2 from the beginning; **(b)** if the latest
  reply is from the **PR author** (not an IDD agent) — post a brief
  acknowledgement reply (e.g., "Acknowledging thread state to satisfy
  conversation-resolution requirement") then resolve it directly, then
  restart F2. Do **not** route to E1; E1 filters out awaiting-reviewer
  threads and would surface no actionable item.
- **Unreplied comments = 0**: No regular comment from a non-IDD-agent
  lacks a subsequent IDD-agent comment — where "subsequent" means any
  IDD-agent regular comment posted at a strictly later timestamp than
  that non-IDD-agent comment (→ return to review triage). This mirrors
  E1's regular-comment filter for non-advisory discussion. Copilot and
  CI advisory bot comments are handled earlier in the PATH B triage flow
  (E4-E7) and are excluded from this gate.

Note: `required_approvals` is fetched at runtime from the ruleset. The
practical blockers are `CHANGES_REQUESTED` states and missing CODEOWNER
approvals only. When all conditions above are satisfied, record the
live-fetch result as the **F2 snapshot**: the current PR HEAD SHA
(`{f2-head-SHA}`), the highest `updatedAt` across all fetched items
(`{f2-max-activity-updatedAt}`, written as `none` if the snapshot is
empty), and the total item count (`{f2-total-item-count}`). Carry all
three values into F3.

## F3 — Merge

1. Confirm the claim is still yours: the **active claim** must still use
   your current `{claim-id}`. If the active claim is missing, released,
   or held by a different `{claim-id}` (even under the same agent ID),
   the claim was lost — report this and stop.
2. Immediately before executing the merge command, do one final live
   fetch using the **exact same activity-universe scope as E1 Step 1**
   (all review threads, review bodies, and regular PR comments,
   excluding agent operational marker comments). Compare against the F2
   snapshot carried forward from F2. Return to E1 if **any** of the
   following is true:

   - The current PR HEAD SHA differs from `{f2-head-SHA}`.
   - `{f2-max-activity-updatedAt}` is `none` and the final fetch is
     non-empty.
   - `{f2-max-activity-updatedAt}` is not `none` and any fetched item's
     `updatedAt` is strictly newer than `{f2-max-activity-updatedAt}`.
   - The total item count of the final fetch exceeds
     `{f2-total-item-count}`.

   Execute the merge immediately after this final fetch **and the claim
   re-validation and advisory state revalidation below**, with no other
   actions in between. Re-validate claim: re-read the issue and confirm
   the active claim still uses your current `{claim-id}`. If it does
   not, the claim was lost — report and stop.

   **Advisory state revalidation (blocking)**: fetch fresh state from
   GitHub with these commands:

   ```sh
   PR_HEAD_SHA_F3=$(gh pr view {pr-number} --json headRefOid \
     --jq '.headRefOid')
   OWNER=$(gh repo view --json owner --jq '.owner.login')
   REPO=$(gh repo view --json name --jq '.name')
   LAST_COPILOT_COMMIT_F3=$(
     gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/reviews" \
       --paginate \
       --jq '.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) |
                   {sa: .submitted_at, cid: .commit_id}' \
     | jq -rs 'sort_by(.sa) | last | .cid // ""'
   )
   COPILOT_PENDING_F3=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
     --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')
   # Note: GitHub uses "Copilot" (capital C) in requested_reviewers and
   # "copilot-pull-request-reviewer[bot]" in the reviews API — both matched
   # here for robustness.
   ```

   If `COPILOT_PENDING_F3` is `"true"` AND
   `LAST_COPILOT_COMMIT_F3 != PR_HEAD_SHA_F3` (Copilot has not reviewed
   the current HEAD), fetch the same-head advisory-wait markers to
   compute elapsed time. Use these commands — do not skip this step even
   if F2 already computed the value, because F3 is a blocking gate that
   must be self-contained:

   ```sh
   EARLIEST_SAME_HEAD_AT_F3=$(
     gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
       | jq -r -s "add
            | [.[] | select(
                  (.body | test(\"^advisory-wait: [^ ]+ ${PR_HEAD_SHA_F3}(?: |\$)\")) or
                  (.body | test(\"^<!-- advisory-wait: [^ ]+ ${PR_HEAD_SHA_F3} [^ ]+ -->$\"))
                )]
            | min_by(.created_at) | .created_at // \"\""
   )
   # Matches both plain-text (new) and HTML-comment (legacy) marker formats.
   # If empty → no same-head marker; if non-empty → earliest marker createdAt.
   ```

   Then branch on the marker state:

   - **No same-head marker (`EARLIEST_SAME_HEAD_AT_F3` is empty)**: this
     is an inconsistent state — Copilot is pending but no advisory-wait
     marker was ever posted for this HEAD. Do NOT execute the merge.
     Post a hold comment: "Copilot review is pending for HEAD
     `{PR_HEAD_SHA_F3}` but no advisory-wait marker was found. E14 may
     have crashed before posting the marker. A maintainer must verify
     whether the Copilot review was formally requested and confirm its
     status before the merge can proceed. Do not merge or post a new
     advisory-wait marker until the maintainer has resolved this."
     **Stop.**
   - **Marker exists; elapsed ≥ 30 minutes** (current UTC −
     `EARLIEST_SAME_HEAD_AT_F3` ≥ 30 min): the advisory window has
     already expired — this check is **satisfied**, proceed with the
     merge.
   - **Marker exists; elapsed < 30 minutes** (current UTC −
     `EARLIEST_SAME_HEAD_AT_F3` < 30 min): a review is actively pending
     within the window. Do NOT execute the merge. Return to the **F2
     Advisory bot wait check** (go back to the first condition in F2).
     F2 will reuse the existing same-HEAD advisory-wait marker — do not
     post a new marker.
3. Merge the PR using a **merge commit**, binding to the validated SHA
   to prevent a race where a new push lands after the F3 freshness check
   but before the merge executes:

   ```sh
   gh pr merge {pr-number} --merge --match-head-commit "${PR_HEAD_SHA_F3}"
   ```

   Do not use squash merge or rebase merge.
4. If merge fails:
   - Base branch updated or conflict → return to F1
   - CI condition no longer met → return to
     `idd-pr-submit.instructions.md` D4 (CI wait)
   - Review condition no longer met → return to
     `idd-review-triage.instructions.md` E1
   - Conversation resolution required and unresolved threads remain →
     for each unresolved thread: **(a)** new reviewer activity (not
     awaiting-reviewer) → return to E1; **(b)** awaiting-reviewer thread
     whose latest reply is from an IDD agent without
     `**Awaiting maintainer decision**` → resolve it directly then
     **restart F2** (not step 3 — to re-run the final freshness fetch);
     **(c)** awaiting-reviewer thread whose latest reply is from the PR
     author (not IDD agent) → post a brief acknowledgement reply then
     resolve it directly, then **restart F2** (same logic as F2 case b
     under the conversation-resolution exception); **(d)** thread with
     `**Awaiting maintainer decision**` reply → post a hold comment and
     stop.

## F4 — Cleanup

1. Delete the local worktree and local branch.
2. Update the local `main` branch.
3. If GitHub auto-delete is disabled: delete the remote branch too.
   (Worktrunk may be used for steps 1–3.)

## F5 — Loop

Return to `idd-discover.instructions.md` and pick the next issue.
