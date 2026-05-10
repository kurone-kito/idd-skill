# IDD — Pre-Merge Conditions Phase (F1–F2)

Read this file after List A is empty (E3 or E8), or when returning to
merge gate checks after a fix cycle. It covers final conflict resolution
(F1) and the full pre-merge condition checklist (F2).

This phase includes a repository-specific GitHub Copilot advisory review
gate. Even when another local agent is driving the workflow, follow it
because the dependency is on GitHub review state, not on the local CLI.

Before any F-phase mutating action, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

When all F2 conditions are satisfied, proceed to `idd-merge.instructions.md`.

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
   `idd-review-snapshot.instructions.md` (E1) to re-evaluate reviews.

## F2 — Pre-merge condition check

Verify **all** of the following. If any condition is not met, follow the
bracketed action:

Before running F3, record explicit F2 evidence for this pass. At
minimum, capture:

1. Activity-universe snapshot evidence:
   `{head-SHA}`, `{max-activity-updatedAt|none}`,
   `{total-item-count}`, `{latest-ci-completed-at|none}`.
2. Unresolved-thread evidence: total unresolved thread count, the
   non-awaiting-reviewer unresolved count used by the gate, and whether
   any AMD (`**Awaiting maintainer decision**`) threads remain.
3. Unreplied regular-comment evidence: the count of non-IDD-agent
   comments that still lack a later IDD-agent reply.
4. Reviewer-state evidence: latest `CHANGES_REQUESTED` status for human,
   required, and CODEOWNER reviewers, plus required approval/CODEOWNER
   satisfaction status.

Do not treat "one bot says clean" as sufficient evidence. The checklist
must cover the full activity universe (human reviewers plus advisory bot
surfaces such as Copilot, CodeRabbit, Codex connectors, and CI bots) and
must align with every F2 condition below.

- **Review currency** (live re-fetch required, freshness gate): read the
  most recent `<!-- review-watermark: {agent-id} {claim-id} … -->`
  comment whose embedded `{claim-id}` matches the current active claim
  and whose GitHub author is a trusted marker actor. The comment's first
  two fields identify the watermark — (a) agent-id and (b) claim-id,
  already used to locate this comment. Extract the remaining values:
  (c) the `{head-SHA}` value; (d) the `{max-activity-updatedAt}` value
  (`none` if empty); (e) the `{total-item-count}` value; (f) the
  `{latest-ci-completed-at}` value (`none` if empty). If no trusted
  same-claim watermark exists, return to E1 unconditionally. Legacy
  watermarks without `{claim-id}` must not be reused across a restart or
  takeover, and same-claim watermarks from untrusted authors must be
  ignored and reported as suspicious context when they affect routing.
  Then fetch the activity universe snapshot (same scope as E1 Step 1)
  and the current CI state for the HEAD SHA. In this source repository,
  you may optionally use the read-only helper
  `node scripts/review-activity-snapshot.mjs --pr {pr-number}` and pass
  trusted marker actors with
  `--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"`; the
  instruction rules remain canonical. Return to E1 if **any** of the
  following is true:
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
- **Advisory bot wait** (restart-safe enforcement): `PR_HEAD_SHA` is
  already available from the review-currency check above. Apply the
  advisory-wait protocol (`idd-advisory-wait.instructions.md`):

  1. Run **AW1**. If **SATISFIED** → this check is **satisfied**;
     continue to the **CI** check.
  2. Run **AW2** to fetch markers.
  3. Apply the **AW3** decision table:
     - **SATISFIED** → this check is **satisfied**; continue to the CI
       check.
     - **HOLD** → post the hold comment from **AW4** and stop.
     - **RECOVERY_NEEDED** → post the recovery marker from **AW3-R**
       without requesting another Copilot review, then enter the normal
       WAIT polling path using refreshed AW2/AW3 state. Then **go back
       to the first condition in F2**.
     - **CAP_EXHAUSTED** → post the cap-exhausted hold comment from
       **AW4** and stop.
     - **REQUEST_NEEDED** → return to E14 to request Copilot review and
       post a fresh marker. Do not post a new request in F2.
     - **WAIT** (`COPILOT_PENDING` is `"true"`, elapsed < 30 min) →
       wait for the remainder of the applicable window (poll every 2
       min), refreshing `EARLIEST_SAME_HEAD_AT` per **AW2** at each
       iteration and applying **AW5** if the marker disappears. Then
       **go back to the first condition in F2** (the 'Review currency'
       check) to re-evaluate all conditions.
     - **WAIT** (`COPILOT_PENDING` is `"false"`, elapsed < 10 min) →
       wait for the remainder of the 10-minute window (same polling
       rules). Then **go back to the first condition in F2**.

  GitHub removes a reviewer from `requested_reviewers` when they submit
  a review OR when the request is manually cancelled — either counts as
  no longer pending for merge purposes.
- **CI**: Current PR head SHA has all required CI checks generated and
  all passing (→ run CI wait per `idd-ci.instructions.md`, on-success →
  re-evaluate F2)
- **Required reviews**: Required approvals count is satisfied and all
  CODEOWNER approvals are obtained. If approvals are absent but there
  are no open actionable review items (List A is empty), do **not**
  route to E1 — instead, request CODEOWNER/required reviewers directly
  (if not already requested), post a hold comment, and stop. Return to
  E1 only when there are actual review threads or comments to address (→
  go to `idd-review-snapshot.instructions.md` only in that case).
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
three values into F3. Then proceed to `idd-merge.instructions.md`.
