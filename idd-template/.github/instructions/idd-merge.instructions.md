# IDD — Merge Execution Phase (F3–F5)

Read this file only after `idd-merge-handoff.instructions.md` routes the
current claim to the autonomous merge path. It covers executing the
merge (F3), cleanup (F4), and looping back to discover (F5).

The final merge-gate timing defaults are named in
[IDD policy constants](../../docs/policy-constants.md). Use that inventory
when you need the canonical values; the merge logic itself stays here.

Before any mutating action in F3, apply the
[shared claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate).

## F3 — Merge

1. Confirm the claim is still yours: the **active claim** must still use
   your current `{claim-id}`. If the active claim is missing, released,
   or held by a different `{claim-id}` (even under the same agent ID),
   the claim was lost — report this and stop.
2. Defensive route check: re-read the repository's recorded merge policy.
   If the recorded policy is missing, treat it as
   `fully_autonomous_merge` (distributed default). Then apply:
   - `fully_autonomous_merge`: continue.
   - `separate_merge_agent`: continue only when repository documentation
     explicitly records that the **current session** is the designated
     merge-capable actor and the documented resume condition is
     satisfied; otherwise route to
     `idd-merge-handoff.instructions.md` and stop.
   - `human_merge` or unknown policy: route to
     `idd-merge-handoff.instructions.md` and stop.
3. Immediately before executing the merge command, do one final live
   fetch using the **exact same activity-universe scope as E1 Step 1**
   (all review threads, review bodies, and regular PR comments,
   excluding trusted agent operational marker comments only). Compare
   against the F2 snapshot carried forward from
   `idd-pre-merge.instructions.md`. When helper runtime is enabled,
   prefer the documented merge-gate helper reference in
   [`docs/idd-helper-scripts.md`](../../docs/idd-helper-scripts.md#stable-helper-evidence-outputs)
   to collect the documented snapshot tuple and broader
   `pre-merge-readiness` JSON report. Both helpers remain read-only
   evidence collectors only: if helper execution fails, output is
   invalid JSON, required sections are missing, or live GitHub state
   disagrees with helper output, discard helper output and run the live
   fetch in this step directly. The written gate rules remain canonical.
   Return to E1 if **any** of the following is true:

   - The current PR HEAD SHA differs from `{f2-head-SHA}`.
   - `{f2-max-activity-updatedAt}` is `none` and the final fetch is
     non-empty.
   - `{f2-max-activity-updatedAt}` is not `none` and any fetched item's
     `updatedAt` is strictly newer than `{f2-max-activity-updatedAt}`.
   - The total item count of the final fetch exceeds
     `{f2-total-item-count}`.
   - The current latest CI pass `completedAt` for the current PR HEAD
     differs from `{f2-latest-ci-completed-at}` (a new CI run completed
     after F2's snapshot; if `{f2-latest-ci-completed-at}` is `none`,
     any current CI pass triggers re-evaluation).

   The structural ack-only carve-out from F2 applies here verbatim:
   newer activity or count growth that the helper evidence proves to be
   post-disposition advisory-bot acknowledgement only
   (`ack-only-post-disposition`) does not force the return to E1; all
   other triggers above are unaffected.

   From that same final fetch, compute `F3_UNRESOLVED_ACTIONABLE_COUNT`
   using the exact F2 unresolved-thread rule and exceptions
   (non-awaiting-reviewer unresolved threads only; awaiting-reviewer
   classification must follow F2 verbatim, including AMD exclusion and
   conversation-resolution exception handling). If
   `F3_UNRESOLVED_ACTIONABLE_COUNT > 0`, stop and return to E1. Do not
   execute `gh pr merge` in this pass.

   If the carried F2 evidence includes helper-side
   `dispositionEvidence`, require
   `dispositionEvidence.route == "proceed"` and
   `dispositionEvidence.blockingCount == 0` before merge. If either
   check fails, stop and return to E1/E4 with the reported missing
   thread/comment disposition items. Use only the carried
   `pre-merge-readiness` `dispositionEvidence` shape here; E7 verifier
   fields (`passed`, `items[]`) are not merge-gate substitutes.

   Execute the merge immediately after this final fetch **and the claim
   re-validation and advisory state revalidation below**, with no other
   actions in between. Re-validate claim: re-read the issue and confirm
   the active claim still uses your current `{claim-id}`. If it does
   not, the claim was lost — report and stop.

   **Advisory state revalidation (blocking)**: the AW1 check just below is
   an instant state read, not itself a wait. If it escalates to a genuine
   wait, return to the F2 advisory bot wait check, which backgrounds only
   if the topology-safety condition holds (confirmed to route completion
   back to this turn) and otherwise waits synchronously. Re-fetch the HEAD
   SHA:

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

   If the optional helper output disagrees with the live fetch above,
   follow the live fetch and the written gate rules.

4. Merge the PR using a **merge commit**, binding to the validated SHA
   to prevent a race where a new push lands after the F3 freshness check
   but before the merge executes.

   **Preferred path (helper runtime enabled)**: run the F3 merge helper
   documented in
   [`docs/idd-helper-scripts.md`](../../docs/idd-helper-scripts.md#merge-execution-f3).
   First run it in dry-run (no `--apply`) and confirm `ready: true` with
   an empty `blockers[]`; the helper wraps the read-only
   `pre-merge-readiness` gate and adds no new authority. Then re-run with
   `--apply`: when `ready`, it re-fetches the head SHA and re-validates
   the claim immediately before merging, fails closed (no merge) on head
   drift or lost claim, and runs the merge commit bound to the validated
   head (never squash/rebase). On a plain-merge failure it also applies
   step 5's solo-CODEOWNER `--admin` fallback decision itself (recorded in
   the verdict's `adminFallbackUsed` field) — the gate checklist and
   decision table below stay canonical: if the helper is unavailable, its
   output is invalid, or its evidence conflicts with live GitHub state,
   discard it and use the manual gate + merge steps in this section.

   **Gate checklist** — confirm every field before merging; all must hold,
   and any unmet or unknown field is a NO-GO (fail closed — stop, do not
   merge):

   - current HEAD SHA **equals** the carried F2-snapshot head
     (`{f2-head-SHA}`);
   - review-currency route is `proceed`;
   - `F3_UNRESOLVED_ACTIONABLE_COUNT` is `0`;
   - advisory `f3Outcome` is `SATISFIED` (the authoritative advisory gate —
     do not add stricter sub-conditions; e.g. a pending-window `SATISFIED`
     can keep `copilotPending` true and `LAST_COPILOT_COMMIT` off the head);
   - all required CI checks pass for the current head;
   - claim ownership still uses your `{claim-id}`.

   For the head-SHA field, use this **copy-paste-safe, fail-closed** check
   — both operands fully quoted, no glob, abort on mismatch — rather than
   re-deriving the comparison ad hoc (a stray glob or an unquoted operand
   can silently mis-gate the most safety-sensitive step). Set `F2_HEAD_SHA`
   from the carried `{f2-head-SHA}` so the snippet is self-contained;
   `PR_HEAD_SHA_F3` is the head re-fetched in step 3:

   ```sh
   F2_HEAD_SHA="{f2-head-SHA}"   # the head recorded in the F2 snapshot
   if [ "$PR_HEAD_SHA_F3" != "$F2_HEAD_SHA" ]; then
     echo "F3 abort: head moved ${F2_HEAD_SHA} -> ${PR_HEAD_SHA_F3}" >&2
     exit 1  # do not merge — return to E1 per the freshness rules above
   fi
   ```

   Then merge, binding `--match-head-commit` to the **freshly validated**
   `${PR_HEAD_SHA_F3}` (never a stale, hardcoded, or unbound SHA):

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
   - `gh pr merge --merge` fails with "the base branch policy
     prohibits the merge" despite a passing Gate checklist and a
     configured pull-request-only bypass actor → that scoped bypass
     alone may not clear a solo-maintainer self-approval deadlock (see
     `docs/permissions.md`'s "Pull-request-only ruleset bypass").
     First check `mergeGate.soloCodeownerAdminFallback` in
     `.github/idd/config.json`:
     - `"hold-and-report"` (opt-in) → keep the pre-#1521 behavior: do
       not retry the plain command or add `--admin`; post a hold
       comment with the GitHub error text and stop for a maintainer
       decision (kurone-kito/idd-skill#1493).
     - Anything else, including the key absent (the distributed
       default, `"auto-admin-retry"`) → retry exactly once with
       `--admin`, bound to the same validated head, **only when every
       one of these holds** (the multi-CODEOWNER safety property from
       kurone-kito/idd-skill#1521, required before this default ships):
       the Gate checklist (step 4) was fully green; the merge
       command's only reported failure is this exact GitHub error
       against a configured pull-request-only (or wider) bypass actor;
       and the `pre-merge-readiness` / `idd-merge-execute` report's
       `reviewerStates.codeownerSelfApproval` has `status: "clear"`
       with `reason` `"pull-request-bypass-available"` or
       `"ruleset-bypass-available"` **and**
       `prAuthorIsSoleEligibleCodeowner: true` — proving the PR author
       is the sole eligible codeowner (no team or email codeowners,
       every eligible direct-user codeowner is the author). A
       genuinely outstanding review from any other codeowner reports
       `prAuthorIsSoleEligibleCodeowner: false` even when `status` is
       still `"clear"` via the bypass-actor carve-out, so it registers
       as its own unmet condition and never triggers this retry. See
       [`docs/idd-helper-scripts.md`](../../docs/idd-helper-scripts.md#merge-execution-f3)
       for the field contract; `idd-merge-execute.mjs --apply` applies
       this check automatically and records the outcome in the
       verdict's `adminFallbackUsed` field.

       ```sh
       gh pr merge {pr-number} --merge --match-head-commit "${PR_HEAD_SHA_F3}" --admin
       ```

       On success, continue the normal post-merge digest update
       exactly as after a successful plain merge (step 4). If any
       condition above does not hold, or the `--admin` retry also
       fails, post a hold comment with the GitHub error text(s) and
       stop for a maintainer decision (kurone-kito/idd-skill#1493,
       #1494) — the same hold-and-report outcome as the opt-in tier.
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
2. Run merged-PR comment cleanup. This step must not run before F3
   succeeds. Re-validate the active claim before each GitHub
   minimization mutation.

   Apply the following cleanup policy rules when evaluating candidates:

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

   **Mandatory apply decision tree** — follow this sequence; no path
   may exit without a recorded reason when cleanup candidates exist:

   In the idd-skill source repository, run the helper in dry-run mode
   first. In adopter repositories, skip to the GraphQL fallback below
   unless the helper scripts were explicitly installed.

   ```sh
   node scripts/audit-pr-cleanup.mjs --pr <pr-number> --dry-run --format table
   ```

   Evaluate the dry-run `status` field (this is a dry-run status; apply
   mode emits different values and is never invoked unless dry-run
   shows `needs-apply`):

   - **`clean`**: no candidates and no permission-blocked items.
     Proceed to step 3.

   - **`needs-apply`**: eligible candidates exist and the viewer can
     minimize them. Apply is mandatory. Re-validate the active claim,
     then run:

     ```sh
     node scripts/audit-pr-cleanup.mjs --pr <pr-number> --apply \
       --claim-issue <issue-number> --claim-id <claim-id> --format table
     ```

     After apply, record the outcome by the apply `status`. See
     `docs/idd-comment-minimization.md` for the exact formats:

     If the apply `status` is `applied`: this run minimized residual
     candidates. **Skip the post when the PR already carries a
     `<!-- idd-cleanup-evidence:` comment recording a successful outcome**
     (`applied` or `clean`) — for example one the `post-merge-cleanup`
     workflow posted within seconds of the merge — to avoid a duplicate
     success record, since that prior record already documents that
     cleanup occurred on this PR. Otherwise (only a `failed` /
     `incomplete` / `permission-blocked` record exists, or none) post the
     evidence comment (with `status`, `applied`, `failed`, `skipped`, and
     `viewer-cannot-minimize` counts) so this run's work is recorded.
     Proceed to step 3.

     If the apply `status` is `clean`: this run was a no-op (nothing left
     to minimize). **Skip the post when the PR already carries a
     `<!-- idd-cleanup-evidence:` comment recording a successful outcome**
     (`applied` or `clean`) — for example one the `post-merge-cleanup`
     workflow posted within seconds of the merge — to avoid a duplicate
     success record. Otherwise (only a `failed` / `incomplete` /
     `permission-blocked` record exists, or none) post a converged
     `clean` record so the cleanup is documented. Proceed to step 3.

     If the apply `status` is `failed` or `incomplete`: post the
     cleanup-failure comment format instead. Include the
     `viewer-cannot-minimize` count when it is non-zero. This is
     explicit evidence, not a merge gate — the merge already succeeded.
     Proceed to step 3.

   - **`permission-blocked`**: skipped items exist with
     `viewerCanMinimize: false` and no apply-eligible candidates were
     found. Post a cleanup-permission-blocked comment to the PR listing
     the blocked candidates and the count, then proceed to step 3.

   For the GraphQL fallback (when the helper is unavailable): check
   `viewerCanMinimize` and `isMinimized` before minimizing; skip
   already-minimized comments and comments the viewer cannot minimize.
   Re-validate the active claim before each mutation. After GraphQL
   cleanup, post an evidence comment summarizing the outcome (status,
   applied count, skipped count with reasons). Skip the post when the PR
   already carries a `<!-- idd-cleanup-evidence:` comment recording a
   successful outcome (`applied` / `clean`) — whether or not this run
   minimized new candidates — to avoid a duplicate success record; still
   post when no prior success record exists, or to correct an existing
   `failed` / `incomplete` / `permission-blocked` record. If the viewer
   cannot minimize any detected candidates, post a
   cleanup-permission-blocked comment instead of exiting silently.

   See `docs/idd-comment-minimization.md` for the evidence comment
   format, cleanup-failure comment format, permission-blocked comment
   format, and fallback GraphQL commands.
3. Delete the local worktree and local branch.
4. Update the local `main` branch.
5. If GitHub auto-delete is disabled: delete the remote branch too.
   (Worktrunk may be used for steps 3–5.)

## F5 — Loop

Return to `idd-discover.instructions.md` and pick the next issue. F4-complete /
F5 is the **safe session-exit boundary**: under context pressure, exit here for
a fresh Discover session rather than looping in-process — see the autopilot
operating model in [`docs/idd-workflow.md`](../../docs/idd-workflow.md).
