# IDD — Roadmap Audit Phase (A1.5)

Read this file after A1 selects an open roadmap and before A2
enumerates child issues.

## A1.5 — Audit completed roadmaps

After A1 selects an open roadmap, inspect whether the roadmap appears
complete before enumerating more work. This step belongs in Discover
because Discover owns roadmap selection and global readiness. F4 remains
scoped to the just-merged PR and local cleanup while holding only the
child issue claim; it must not close a parent roadmap as a side effect.
F5 still loops back here, so the next Discover pass can evaluate parent
roadmap state after child PRs merge.

Run the completion audit only when the selected roadmap has explicit
child work such as task-list issue references or GitHub sub-issue
relationships. If the roadmap has no explicit child work, report that
it is childless or malformed and continue to A2; do not close it based
on absence of candidates.

Fetch the selected roadmap, its explicit child references, transitive
descendants, GitHub sub-issue children, and linked or closing PR
evidence for those child issues. Use the same outbound traversal
sources as A2, including closed umbrella children, so open descendants
cannot be hidden behind a closed direct child. This step must not use
repo-wide search to add unrelated work to the roadmap. The only
repo-wide search allowed in A1.5 is a narrow duplicate/reuse check for
a specific autonomous gap before creating a follow-up issue; use those
results only to link existing gap work or avoid creating a duplicate,
not to widen A2 candidates.

- If the roadmap itself has `status:blocked-by-human` or
  `status:needs-decision`, report the blocker and stop before A2. Do
  not continue selecting child issues under a blocked roadmap.
- If any referenced child or descendant issue is open, inaccessible, or
  unresolved, report the provenance path and reason, then continue to
  A2.
- If any referenced child or descendant has an open linked or closing
  PR that is not merged or otherwise obsolete, treat that child work as
  unresolved, report the PR, and continue to A2.
- If any open or unresolved child or descendant has
  `status:blocked-by-human` or `status:needs-decision`, report the
  blocker and continue to A2 or stop according to the normal
  ready-to-start rules. Do not treat stale blocker labels on closed
  children as audit blockers when their referenced descendants are
  resolved.
- If all referenced child and descendant work is closed or otherwise
  complete, compare the roadmap success criteria against the closed
  child issues, linked merged PRs, task-list state, follow-up comments,
  and the current repository state where feasible. Do not infer
  completion from checkbox state alone.

A1.5 can publish roadmap-level GitHub side effects before a child task
issue is selected. Before any such side effect, coordinate on the
roadmap issue itself:

Treat `stale` and `non-stale` in this section using the
`claim-stale-age` policy default from `docs/policy-constants.md`
(distributed default: `24 h`).

- Roadmap claim ownership gates roadmap-side mutations only. Do not
  treat a non-stale roadmap claim as a global lock over A2/A3 child
  discovery or child A5 checks.
- Run the A5 claim-state, open-PR, and branch-collision checks against
  the roadmap issue. Do not apply A5's assignee or project
  `not started` readiness gate to roadmap-audit claims; roadmap
  ownership and project status may represent parent coordination rather
  than task readiness. If an active non-stale claim uses any
  `{claim-id}` other than one already recorded by this current session
  before this check and now verified, do not mutate the roadmap; report
  the claim and continue to A2 or stop according to the normal
  ready-to-start rules. A matching agent ID alone is not ownership
  proof, and neither is a token first learned by parsing the current
  roadmap comments.
- If the roadmap is unclaimed or stale, post and verify a normal
  `claimed-by` comment for the roadmap issue using a
  `roadmap-audit/<number>-<slug>` branch field. This is a logical
  coordination name, not a work branch, and it does not require
  creating a branch or worktree unless the audit also needs git
  changes.
- If the active roadmap claim already uses this current session's
  previously recorded and verified `{claim-id}`, continue with that same
  claim and do not post a new claim.
- Re-validate that roadmap claim before every roadmap comment,
  follow-up issue creation, body edit, label change, or close action.
- If the roadmap remains open and no PR branch will continue from the
  audit, release the roadmap-audit claim before returning to A2 or
  stopping.
- Example: when another agent holds a non-stale roadmap claim, do not
  mutate that roadmap in A1.5, but continue to A2/A3 and allow child
  issues that pass readiness and A5 to proceed.

Immediately before posting any completion summary, creating follow-up
issues, editing the roadmap body, changing labels, or closing the
roadmap, re-fetch the roadmap and child state and confirm the audit
input still matches the evidence.

Apply one outcome:

- **Audit passes**: post an `IDD roadmap completion audit` comment with
  a concise evidence summary, then close the roadmap. No child task
  issue is claimed. Return to `idd-discover.instructions.md` (A1) and
  select the next open roadmap, if any.
- **Autonomous gaps found**: create or link follow-up issues using the
  repository's issue-authoring rules, update the roadmap task list with
  those links, and continue to A2 so the new work can be discovered.
  Before creating a new issue, run the narrow A1.5 duplicate/reuse
  check for that gap and link a matching existing issue instead. New
  follow-up issue bodies must reference the roadmap (for example
  `Refs #NNN`) so a later audit can rediscover them. After creating a
  follow-up issue, update the roadmap task list with that link before
  creating another. If the roadmap update fails or the roadmap claim is
  lost after issue creation, create no more issues; report the created
  issue link so the next audit can link it before considering
  duplicates.
- **Non-autonomous gaps found**: comment with the decision or human
  blocker, apply `status:needs-decision` or `status:blocked-by-human`
  when those labels exist, and do not close the roadmap. Stop before A2
  after reporting a non-autonomous gap, even if the repository does not
  have the blocker labels, so the same unattended run cannot select
  child work under a roadmap that needs human input.
