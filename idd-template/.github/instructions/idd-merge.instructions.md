# IDD — Merge Execution Phase (F3–F5)

Read this file after `idd-pre-merge.instructions.md` (F2) satisfies all
pre-merge conditions. It covers executing the merge (F3), cleanup (F4),
and looping back to discover (F5).

The final merge-gate timing defaults are named in
[IDD policy constants](../../docs/policy-constants.md). Use that inventory
when you need the canonical values; the merge logic itself stays here.

Before any mutating action in F3, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

## F3 — Merge

1. Confirm the claim is still yours: the **active claim** must still use
   your current `{claim-id}`. If the active claim is missing, released,
   or held by a different `{claim-id}` (even under the same agent ID),
   the claim was lost — report this and stop.
2. Read the repository's recorded merge policy from repository
   documentation that future IDD sessions read. If no policy is
   recorded, treat it as `fully_autonomous_merge` (distributed
   default). If the recorded value is not one of
   `fully_autonomous_merge`, `human_merge`, or
   `separate_merge_agent`, treat it as an unknown merge policy:
   stop, post a hold comment, and request maintainer decision.
   Do not execute the final freshness fetch, `gh pr merge`, or F4
   cleanup when the policy is unknown.

   If the recorded policy is `human_merge` or
   `separate_merge_agent`, stop before the final freshness fetch and
   before `gh pr merge`. After the claim revalidation above, report or
   post a concise handoff summary with the PR number, branch, current
   HEAD from F2, the F2 readiness evidence, and the actor expected to
   merge. For `human_merge`, hand off to the human maintainer. For
   `separate_merge_agent`, hand off to the configured merge-capable
   session; if that actor or resume condition is not recorded, hold for
   maintainer direction. Do not run the F3 merge command or F4 cleanup
   in the same worker session.

   Only the `fully_autonomous_merge` policy path lets the same agent
   session continue through the remaining F3 gates (recorded explicitly
   or defaulted when policy is missing). This policy gate does not
   relax claim, freshness, unresolved-thread, advisory, CI, or review
   requirements.
3. Immediately before executing the merge command, do one final live
   fetch using the **exact same activity-universe scope as E1 Step 1**
   (all review threads, review bodies, and regular PR comments,
   excluding trusted agent operational marker comments only). Compare
   against the F2 snapshot carried forward from
   `idd-pre-merge.instructions.md`. Return to E1 if **any** of the
   following is true:

   If `scripts/review-activity-snapshot.mjs` exists in this repository,
   you may optionally use it as a read-only helper; pass trusted marker
   actors with
   `--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"` to
   compute the same activity metrics; the written gate rules remain
   canonical.

   - The current PR HEAD SHA differs from `{f2-head-SHA}`.
   - `{f2-max-activity-updatedAt}` is `none` and the final fetch is
     non-empty.
   - `{f2-max-activity-updatedAt}` is not `none` and any fetched item's
     `updatedAt` is strictly newer than `{f2-max-activity-updatedAt}`.
   - The total item count of the final fetch exceeds
     `{f2-total-item-count}`.

   From that same final fetch, compute `F3_UNRESOLVED_ACTIONABLE_COUNT`
   using the exact F2 unresolved-thread rule and exceptions
   (non-awaiting-reviewer unresolved threads only; awaiting-reviewer
   classification must follow F2 verbatim, including AMD exclusion and
   conversation-resolution exception handling). If
   `F3_UNRESOLVED_ACTIONABLE_COUNT > 0`, stop and return to E1. Do not
   execute `gh pr merge` in this pass.

   Execute the merge immediately after this final fetch **and the claim
   re-validation and advisory state revalidation below**, with no other
   actions in between. Re-validate claim: re-read the issue and confirm
   the active claim still uses your current `{claim-id}`. If it does
   not, the claim was lost — report and stop.

   **Advisory state revalidation (blocking)**: re-fetch the HEAD SHA:

   ```sh
   PR_HEAD_SHA_F3=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

   Use `PR_HEAD_SHA_F3` as `PR_HEAD_SHA`. Run **AW1**
   (`idd-advisory-wait.instructions.md`):
   - If **SATISFIED** (`LAST_COPILOT_COMMIT == PR_HEAD_SHA_F3`) →
     proceed with the merge.
   - If `COPILOT_PENDING` is `"false"` (review completed or cancelled) →
     this check is satisfied; proceed with the merge.
   - Otherwise (`COPILOT_PENDING` is `"true"`, not yet reviewed): run
     **AW2** and apply **AW3** — do not skip even if F2 ran them already,
     as F3 is a self-contained blocking gate:
     - **SATISFIED** → proceed with the merge.
     - **HOLD** → post the hold comment from **AW4** and stop.
     - **RECOVERY_NEEDED** → post the recovery marker from **AW3-R** and
       return to the F2 advisory bot wait check. Do not merge in the
       same F3 pass that creates a recovery marker.
     - **CAP_EXHAUSTED** → post the cap-exhausted hold comment from
       **AW4** and stop.
     - **REQUEST_NEEDED** → return to E14 to refresh/request Copilot
       review and post a request marker. Do not merge.
     - **WAIT** → Do NOT execute the merge. Return to the **F2 advisory
       bot wait check** in `idd-pre-merge.instructions.md` (go back to
       the first condition in F2). F2 will reuse the existing same-HEAD
       marker — do not post a new one.

4. Merge the PR using a **merge commit**, binding to the validated SHA
   to prevent a race where a new push lands after the F3 freshness check
   but before the merge executes:

   ```sh
   gh pr merge {pr-number} --merge --match-head-commit "${PR_HEAD_SHA_F3}"
   ```

   Do not use squash merge or rebase merge.
   After the merge succeeds and claim ownership is re-validated, upsert
   the PR live status digest with `Phase: F3 merged`,
   `Open blockers: none`, `Next action: F4 cleanup then F5 discover`,
   and `Authoritative by` pointing to the merge commit and matched head
   SHA. This post-merge digest update is not a merge gate and must not
   happen before the successful merge command.
5. If merge fails:
   - Base branch updated or conflict → return to
     `idd-pre-merge.instructions.md` F1
   - CI condition no longer met → return to
     `idd-pr-submit.instructions.md` D4 (CI wait)
   - Review condition no longer met → return to
     `idd-review-snapshot.instructions.md` E1
   - Conversation resolution required and unresolved threads remain →
     for each unresolved thread: **(a)** new reviewer activity (not
     awaiting-reviewer) → return to E1; **(b)** awaiting-reviewer thread
     whose latest reply is from an IDD agent without
     `**Awaiting maintainer decision**` → resolve it directly then
     **restart `idd-pre-merge.instructions.md` F2** (to re-run the
     final freshness fetch); **(c)** awaiting-reviewer thread whose
     latest reply is from the PR author (not IDD agent) → post a brief
     acknowledgement reply then resolve it directly, then **restart
     `idd-pre-merge.instructions.md` F2**; **(d)** thread with
     `**Awaiting maintainer decision**` reply → post a hold comment and
     stop.

   When a merge failure routes to F1, D4, E1, or a hold, update the
   digest after recording the failure evidence. Set `Phase` to
   `F3 blocked`, summarize the GitHub merge error or unresolved thread
   class in `Open blockers`, and set `Next action` to the routed phase
   or maintainer action.

   If the merge failure path resolves or acknowledges awaiting-reviewer
   threads and restarts F2, do not update the digest before restarting
   F2. That PR activity would invalidate the F2 restart and force an E1
   snapshot even though E1 intentionally has no actionable
   awaiting-reviewer item. Let the restarted F2 pass record blockers if
   it finds one.

## F4 — Cleanup

1. Confirm the post-merge digest update above exists or repair it after
   re-validating the claim. Do not minimize the digest as an
   operational marker unless a future cleanup policy explicitly supports
   digest retirement.
2. Run best-effort merged-PR comment cleanup when credentials permit.
   This cleanup is never a merge gate and must not run before F3
   succeeds. If cleanup fails, record the failure only if it is useful
   for a later audit, then continue with local cleanup.
   Re-validate the active claim before each GitHub minimization
   mutation.

   - Feedback or review parent comments may be minimized as `RESOLVED`
     only after every actionable child review comment/thread under that
     parent has been accepted or rejected, replied to as required, and
     resolved.
   - Known review-bot regular PR comments may be minimized only after
     the PR is merged and the comment has a clear completed-review or
     stale-notification signal, such as a CodeRabbit no-action summary
     or a CodeRabbit summary / review-trigger acknowledgement with a
     matching later IDD disposition. CodeRabbit summaries may also be
     minimized when all CodeRabbit review threads are resolved and have
     fresh IDD dispositions.
   - Bot review parent bodies without associated review threads are
     skipped by default, including Copilot error review bodies, unless a
     future policy explicitly narrows a safe cleanup class for them.
   - Trusted IDD operational marker comments may be minimized as
     `OUTDATED` only after the PR is merged and the marker is no longer
     needed for resume, advisory wait, or review-currency checks.
   - Candidate marker prefixes include `<!-- review-watermark:`,
     `<!-- review-baseline:`, `advisory-wait:`,
     `advisory-wait-recovery:`, and `<!-- advisory-wait:`.
   - Do not minimize comments that contain unresolved maintainer
     decisions, active holds, failed-CI context still needed by
     maintainers, non-operational human discussion, or any content that
     still participates in active F2/F3 gates.
   - When `scripts/audit-pr-cleanup.mjs` is available, run it first in
     dry-run mode so eligible and skipped candidates are visible:

     ```sh
     node scripts/audit-pr-cleanup.mjs --pr <pr-number> --dry-run --format table
     ```

     To apply the safe candidates during this claimed IDD run, pass the
     active issue and claim token so the helper re-validates the claim
     before each minimization mutation:

     ```sh
     node scripts/audit-pr-cleanup.mjs --pr <pr-number> --apply \
       --claim-issue <issue-number> --claim-id <claim-id> --format table
     ```

   - If the helper is unavailable, use GitHub GraphQL `minimizeComment`
     with node IDs. Check `viewerCanMinimize` and `isMinimized` before
     minimizing; skip already-minimized comments and comments the viewer
     cannot minimize. Re-validate the active claim before each mutation.

   See `docs/idd-comment-minimization.md` for the helper report shape,
   fallback GraphQL commands, and experiment notes.
3. Delete the local worktree and local branch.
4. Update the local `main` branch.
5. If GitHub auto-delete is disabled: delete the remote branch too.
   (Worktrunk may be used for steps 3–5.)

## F5 — Loop

Return to `idd-discover.instructions.md` and pick the next issue.
