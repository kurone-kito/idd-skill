# IDD — Claim Phase (A5)

Read this file after picking an issue (A4) or after a successful
re-claim decision in the resume phase. It covers the four pre-checks,
claim execution, and claim verification.

## Pre-checks (all four must pass)

Re-fetch the issue immediately before running these checks.

**(a) Assignee and project status** — The issue must have no assignee
set. If the project is in use, the project status must be "not started".

**(b) Claim state** — Re-read the issue and parse the **active claim**
using the shared claim-state rules:

- No active claim → unclaimed, proceed
- Active claim held by a **different** agent ID and its latest valid
  `claimed-by` comment has GitHub `created_at` < 24 h → claimed by
  another agent, go back to A3
- Active claim held by a **different** agent ID and its latest valid
  `claimed-by` comment has GitHub `created_at` ≥ 24 h → stale, proceed
  with takeover
- Active claim held by **your own** agent ID → same-agent restart or
  handoff detected. Do **not** silently inherit it; proceed with an
  explicit takeover that uses a fresh `{claim-id}` and `supersedes:` the
  current active claim's `{claim-id}`

Only the GitHub `created_at` of the latest **valid** `claimed-by`
comment in the active claim counts toward the stale calculation.

If the issue has no new-format `claimed-by` comments but has legacy
claim comments, first check whether the latest legacy `claimed-by`
comment is followed by a later legacy `unclaimed-by` comment from the
same agent. If so, treat the issue as **unclaimed** — proceed as if no
claim exists.

Otherwise, use the latest legacy `claimed-by` comment as a
**migration-only** decision input:

- Legacy claim held by a **different** agent ID and GitHub `created_at`
  < 24 h → claimed by another agent, go back to A3
- Legacy claim held by a **different** agent ID and GitHub `created_at`
  ≥ 24 h → stale, proceed and replace it with a new-format claim
- Legacy claim held by **your own** agent ID → same-agent restart or
  handoff detected. Proceed and replace it with a new-format claim

The migration claim uses a fresh `{claim-id}` and `supersedes: none`.

**(c) Open PR** — No open PR may close or reference this issue, unless
that PR's head branch matches the `branch` field in an inheritable claim
comment. An inheritable claim comment is either:

- the currently active claim you are taking over (same-agent restart or
  stale claim), or
- the latest `claimed-by` comment that was later released by a matching
  `unclaimed-by` comment (the last voluntarily released branch), or
- the latest legacy `claimed-by` comment when performing a legacy
  migration (see the migration-only decision input above)

Check both linked issues and closing keywords in PR bodies.

**(d) Branch collision** — Compute the branch name using the IDD naming
convention: `issue/<number>-<slug>` where `<slug>` is 2–5 lowercase
hyphenated words describing the issue (e.g. `issue/<number>-<slug>`). No
remote branch with that name may exist, unless it matches the `branch`
field in an inheritable claim comment as defined in (c) above.

## Claim execution

Determine `{branch-name}`:

- **Re-claim / takeover**: use the exact branch name from the
  inheritable claim comment (the `branch` field of the active same-agent
  or stale claim, the last-released `claimed-by`, or the legacy claim
  being migrated). Do not compute a new name.
- **Fresh claim**: compute a new name using the IDD naming convention:
  `issue/<number>-<slug>` where `<slug>` is 2–5 lowercase hyphenated
  words describing the issue.

Generate a fresh `{claim-id}`. Determine `{prior-claim-id}`:

- **Takeover of an active claim** (same-agent restart or handoff, or
  stale claim recovery) → the current active claim's `{claim-id}`
- **Migration from a legacy claim** → `none`
- **Fresh claim** or claim after a released / unclaimed state → `none`

Post the claim comment to the issue:

```html
<!-- claimed-by: {agent-id} {claim-id} supersedes: {prior-claim-id|none} {ISO8601-timestamp} branch: {branch-name} -->
```

## Claim verification

Re-read the issue immediately and parse the active claim. Verify that
the active claim now uses **your** `{claim-id}`. If it does not, go back
to A3.

Once verified, record this `{claim-id}` as your current claim token for
the rest of the workflow, then continue to `idd-work.instructions.md`.
