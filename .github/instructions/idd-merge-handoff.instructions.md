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
4. If the recorded policy is `human_merge` or `separate_merge_agent`,
   stop before the final freshness fetch and before `gh pr merge`. After
   claim revalidation, report or post a concise handoff summary that
   includes:
   - PR number and branch
   - current HEAD from F2 (`{f2-head-SHA}`)
   - the F2 readiness evidence
   - unresolved-thread count, advisory state, and CI state
   - active `{claim-id}`
   - merge command candidate:

   ```sh
   gh pr merge {pr-number} --merge --match-head-commit "{f2-head-SHA}"
   ```

   For `human_merge`, hand off to the human maintainer. For
   `separate_merge_agent`, hand off to the configured merge-capable
   session; if that actor or resume condition is not recorded, hold for
   maintainer direction.
5. Only when the policy is `fully_autonomous_merge` may the same session
   continue to `idd-merge.instructions.md`.
