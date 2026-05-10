# IDD — Claim Phase (A5)

Read this file after picking an issue (A4), after verifying an explicit
issue target (A0-T), or after a successful re-claim decision in the
resume phase. It covers the four pre-checks, claim execution, and claim
verification.

## Pre-checks (all four must pass)

Re-fetch the issue immediately before running these checks.
All A5 checks are target-issue local: claims on related roadmap or
child issues do not block this check unless they appear on the selected
issue itself.

**(a) Assignee and project status** — The issue must have no assignee
set. If the project is in use, the project status must be "not started".

**(b) Claim state** — Re-read the issue and parse the **active claim**
using the shared claim-state rules:

Use the `claim-stale-age` policy default from `docs/policy-constants.md`
for these stale checks (distributed default: `24 h`).

- No active claim → unclaimed, proceed.
- Active claim already uses a `{claim-id}` that this current session had
  recorded before this check and has now verified → already claimed; do
  not post a new claim. Continue with that same `{claim-id}`. A token
  first learned by parsing the current issue comments is not enough.
- Any other active claim whose latest valid `claimed-by` comment has
  GitHub `created_at` < 24 h → claimed by another live session, even
  when the `agent-id` matches. Return to Discover using the same
  selection mode that produced this target (orphan-first: continue the
  A0-O capable path; roadmap mode: continue the A3-ready path).
- Any other active claim whose latest valid `claimed-by` comment has
  GitHub `created_at` ≥ 24 h → stale, proceed with takeover.

Only the GitHub `created_at` of the latest **valid** `claimed-by`
comment in the active claim counts toward the stale calculation.

If the issue has no trusted new-format `claimed-by` comments but has legacy
claim comments from trusted marker actors, first check whether the
latest trusted legacy `claimed-by` comment is followed by a later
trusted legacy `unclaimed-by` comment from the same agent. If so, treat
the issue as **unclaimed** — proceed as if no claim exists.

Otherwise, use the latest trusted legacy `claimed-by` comment as a
**migration-only** decision input:

- Latest trusted legacy claim has GitHub `created_at` < 24 h → claimed
  by another live session, even when the `agent-id` matches. Return to
  Discover using the same selection mode that produced this target
  (orphan-first: continue the A0-O capable path; roadmap mode: continue
  the A3-ready path).
- Latest trusted legacy claim has GitHub `created_at` ≥ 24 h → stale,
  proceed and replace it with a new-format claim.

The migration claim uses a fresh `{claim-id}` and `supersedes: none`.

**(c) Open PR** — No open PR may close or reference this issue, unless
that PR's head branch matches the `branch` field in an inheritable claim
comment. An inheritable claim comment is either:

- the already verified active claim for this current session, or
- the currently active stale claim you are taking over, or
- the latest trusted `claimed-by` comment that was later released by a
  matching trusted `unclaimed-by` comment (the last voluntarily released
  branch), or
- the latest trusted legacy `claimed-by` comment when performing a
  legacy migration (see the migration-only decision input above)

Check both linked issues and closing keywords in PR bodies.

**(d) Branch collision** — Compute the branch name using the IDD naming
convention: `issue/<number>-<slug>` where `<slug>` is 2–5 lowercase
hyphenated words describing the issue (e.g. `issue/<number>-<slug>`). No
remote branch with that name may exist, unless it matches the `branch`
field in an inheritable claim comment as defined in (c) above.

## Claim execution

Skip this section if pre-check (b) classified the issue as already
claimed by this current session. Keep the previously recorded `{claim-id}` and
branch, then proceed directly to Claim verification without posting a new
claim.

Determine `{branch-name}`:

- **Re-claim / takeover**: use the exact branch name from the
  inheritable claim comment (the `branch` field of the active stale
  claim, the last-released trusted `claimed-by`, or the trusted legacy
  claim being migrated). Do not compute a new name.
- **Fresh claim**: compute a new name using the IDD naming convention:
  `issue/<number>-<slug>` where `<slug>` is 2–5 lowercase hyphenated
  words describing the issue.

Generate a fresh `{claim-id}`. Determine `{prior-claim-id}`:

- **Takeover of an active claim** (stale claim recovery) → the current
  active claim's `{claim-id}`
- **Migration from a legacy claim** → `none`
- **Fresh claim** or claim after a released / unclaimed state → `none`

Post the claim comment to the issue. Keep the HTML token at the start
of the body, followed by the visible note:

```markdown
<!-- claimed-by: {agent-id} {claim-id} supersedes: {prior-claim-id|none} {ISO8601-timestamp} branch: {branch-name} -->

_{agent-id}: issue claim — IDD automation marker. Do not edit._
```

## Claim verification

After posting `claimed-by`, wait 5–10 seconds to let GitHub eventual
consistency settle. Then re-read the full issue comment stream and parse
the active claim in chronological order using the shared claim-state
rules. Apply all race-safe checks below:

1. Build the same-second contender set from trusted `claimed-by` markers
   that share your claim event's `created_at` second and have different
   `{claim-id}` values.
2. If that set has two or more contenders, the winner is the
   lexicographically earlier `{claim-id}` (case-sensitive ASCII compare).
   This race-safe tie-break extends the shared parsing rules for this
   verification step.
3. Verify that the active claim now uses **your** `{claim-id}` after the
   same-second tie-break is applied.
4. Verify no trusted competing `claimed-by` with a different
   `{claim-id}` appears in a strictly later `created_at` second than
   your claim event.

If any check fails, treat the claim as contested. Return to Discover
using the same selection mode that produced this target and pick the
next eligible issue (orphan-first: continue the A0-O capable path;
roadmap mode: continue the A3-ready path). Do not retry the same issue.
For explicit-target A0-T runs, report the contested claim and stop
unless the operator has explicitly switched to normal discovery.

Once verified, record this `{claim-id}` as your current claim token for
the rest of the workflow.

After claim verification, upsert the issue live status digest when there
is exactly one marked digest or none. Use the verified `claimed-by`
comment as the authority: set `Phase` to `A5 claimed`, `Claim` to the
current `{agent-id}` / `{claim-id}`, `Branch` to the verified branch,
`Open blockers` to `none`, and `Next action` to `B1 create branch and
worktree`. If multiple marked digests exist, report their URLs and
continue from the verified claim without editing a digest.

Then continue to `idd-work.instructions.md`.
