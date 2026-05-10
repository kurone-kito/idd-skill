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
     resume condition is satisfied, first resume on the same issue via
     `idd-resume.instructions.md` so the merge-capable session holds a
     verified active `{claim-id}` of its own, then proceed to
     `idd-merge.instructions.md`.
   - Otherwise, stop and hand off using the summary fields above to the
     configured merge-capable session. If that actor or resume condition
     is not recorded, hold for maintainer direction.
6. When the policy is `fully_autonomous_merge`, proceed to
   `idd-merge.instructions.md`.
