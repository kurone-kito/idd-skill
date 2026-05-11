# IDD — Merge Policy Handoff Phase (F2.5)

Read this file after `idd-pre-merge.instructions.md` (F2) satisfies all
pre-merge conditions. It decides whether the current session can proceed
to merge execution or must stop and hand off.

Before any mutating action in this phase, apply the shared claim
revalidation gate. The active claim must still use your current
`{claim-id}`.

## F2.5 — Resolve merge policy route

1. Confirm the claim is still yours: the **active claim** must still use
   your current `{claim-id}`. If the active claim is missing, released,
   or held by a different `{claim-id}` (even under the same agent ID),
   the claim was lost — report this and stop.
2. Read the repository's recorded merge policy from repository
   documentation that future IDD sessions read. If no policy is
   recorded, treat it as `fully_autonomous_merge` (distributed default).
3. If the recorded value is not one of `fully_autonomous_merge`,
   `human_merge`, or `separate_merge_agent`, treat it as an unknown merge
   policy: stop, post a hold comment, and request maintainer decision.
4. If the recorded policy is `human_merge`, stop before the final
   freshness fetch and before `gh pr merge`. After claim revalidation,
   post a concise handoff summary comment that includes:
   - PR number and branch
   - full F2 snapshot (`{f2-head-SHA}`, `{f2-max-activity-updatedAt}`,
     `{f2-total-item-count}`, `{latest-ci-completed-at}`)
   - the F2 readiness evidence
   - unresolved-thread count, advisory state, and CI state
   - active `{claim-id}`
   - merge command candidate:

   ```sh
   gh pr merge {pr-number} --merge --match-head-commit "{f2-head-SHA}"
   ```

   For `human_merge`, hand off to the human maintainer.
5. If the recorded policy is `separate_merge_agent`, apply this split:
   - If repository documentation explicitly records that the **current
     session** is the designated merge-capable actor and the documented
     resume condition is satisfied:
     1. Ensure this session already holds a verified active `{claim-id}`.
        If not, establish ownership through the normal claim path
        (`idd-claim.instructions.md` A5) before continuing.
     2. Do not reuse the worker's F2 snapshot after handoff comments.
        Return to `idd-pre-merge.instructions.md` and run F2 again to
        record a fresh snapshot for this merge-capable session.
     3. Re-enter this handoff phase and continue to
        `idd-merge.instructions.md`.
   - Otherwise, post the handoff summary comment, then release the
     worker claim with `unclaimed-by` using the current `{claim-id}` and
     stop. This allows the designated merge-capable session to claim and
     resume safely. If the claim was already lost, do not post release.
6. When the policy is `fully_autonomous_merge`, continue directly to
   `idd-merge.instructions.md`.
