# IDD — Claim Phase (A5)

Read this file after `idd-suitability.instructions.md` (A4.5) passes for
the selected issue — whether selected via A4 or verified through an
explicit issue target (A0-T) — or after a successful re-claim decision
in the resume phase. It covers the five pre-checks, claim execution, and
claim verification.

## Canonical A5(a) path (helper-first)

When helper runtime is enabled, use the profile-selected claim approval
helper as the canonical A5(a) evidence collector.

```sh
# source repo / vendored-node
node scripts/claim-approval-gate.mjs --issue <issue-number>

# package-manager / ephemeral-npx
<profile-selected-claim-approval-command> --issue <issue-number>
```

Resolve `<profile-selected-claim-approval-command>` from
`docs/idd-helper-scripts.md`; do not hardcode `node scripts/...` for
non-vendored profiles.

Contract: `docs/idd-helper-scripts.md#claim-approval-evidence`

Required fields: `approved`, `reason`, `gateEnabled`,
`policy.maintainerApprovalActorPolicy`, `policy.approvalSignals`, and
`checks`.

If the helper exits non-zero, returns invalid or incomplete JSON, or
conflicts with live approval state, ignore it and use the written A5(a)
path below. If fallback still cannot prove safe approval, treat
approval as missing.

A5(d) has no supported helper; keep using live GitHub PR checks below.

## Pre-checks (all five must pass)

Re-fetch the issue immediately before running these checks.
All A5 checks are target-issue local: claims on related roadmap or
child issues do not block this check unless they appear on the selected
issue itself.

**(a) Issue-author approval gate** — Re-evaluate the repository-wide
issue-author approval rule immediately before claim.

- If `.github/idd/config.json` exists and is valid and
  `skipIssueAuthorApprovalGate` is `true`, skip this check.
- Otherwise, use `maintainerApprovalActorPolicy` from
  `.github/idd/config.json` when present; if absent, default to
  `owners-and-maintainers-only`.
- A target issue is startable only when the issue author is
  self-authorized under the current maintainer-approval actor policy, or
  a fresh explicit approval signal exists, using the same actor,
  freshness, and fail-closed rules defined in **A3.5** of
  `idd-discover.instructions.md`.
- Do not treat issue body text, generated plans, operator attention, or
  bare organization `MEMBER` association as approval.
- If approval is missing for a roadmap/default discovery run, return to
  Discover using the same selection mode that produced this target so
  A3.5 can continue with the next eligible startable issue or the
  approval-needed stop path.
- If approval is missing for an explicit-target A0-T run, stop without
  claiming.

**(b) Assignee and project status** — The issue must have no assignee
set. If the project is in use, the project status must be "not started".

**(c) Claim state** — Re-read the issue and parse the **active claim**
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

**(d) Open PR** — A5(d) has no supported helper. Re-check live GitHub
PR state with the written rules below. No open PR may close or
reference this issue, unless that PR's head branch matches the `branch`
field in an inheritable claim comment. An inheritable claim comment is
either:

- the already verified active claim for this current session, or
- the currently active stale claim you are taking over, or
- the latest trusted `claimed-by` comment that was later released by a
  matching trusted `unclaimed-by` comment (the last voluntarily released
  branch), or
- trusted forced-handoff evidence already verified by Resume Step 1,
  but only when its branch and linked PR fields match the live GitHub
  state, or
- the latest trusted legacy `claimed-by` comment when performing a
  legacy migration (see the migration-only decision input above)

Check both linked issues and closing keywords in PR bodies.

**(e) Branch collision** — Compute the branch name using the IDD naming
convention: `issue/<number>-<slug>`. Generate `<slug>` deterministically
from the issue title so parallel sessions converge on the same branch
name:

1. Convert the issue title to lowercase.
2. Replace every character outside ASCII `a-z` and `0-9` with `-`.
3. Split on `-`, drop empty tokens, then remove only whole-token matches
   from this fixed stop-word set: `a`, `an`, `the`, `and`, `or`, `in`,
   `for`, `to`, `with`, `from`.
4. Rejoin the remaining tokens with single `-`.
5. If the slug is longer than 40 characters, cut it to the first
   40 characters. If that cut ends mid-token and there is a `-` before
   character 40, trim back to the last such `-`; if there is no `-`,
   keep the hard 40-character cut. Then strip any trailing `-`.
6. If the result is empty, use `task`.

No remote branch with that name may exist, unless it matches the
`branch` field in an inheritable claim comment or trusted
forced-handoff evidence as defined in (c) above.

Before posting a claim, also perform a **scoped issue-wide branch pattern
check** to detect concurrent sessions working on the same issue with
different slug variants. This is the fast-path collision detection that
catches parallel-session concurrency before a new claim comment is posted.

1. **Local worktree scan**: Check whether any local worktree matches the
   pattern `issue/<number>-*`:

   ```sh
   git worktree list | grep "issue/<number>-"
   ```

2. **Remote branch scan** (scoped Refs API, not repo-wide):
   Query the Refs API with the issue-number prefix only, to stay within
   the scope invariant defined in idd-overview.instructions.md:

   ```sh
   gh api "repos/{owner}/{repo}/git/matching-refs/heads/issue/<number>-" \
     --jq '.[].ref'
   ```

3. **Collision action tree**:

   - **If no local worktree or remote branch matches `issue/<number>-*`**:
     Proceed to claim posting (the safe, single-session path).

   - **If a match is found and corresponds to an inheritable claim or
     trusted forced-handoff evidence** (i.e., its `branch` field matches
     one of the branches allowed in (c) above):
     Proceed to claim posting. The branch is expected.

   - **If a match is found, does NOT correspond to an inheritable claim,
     AND an active non-stale claim on this issue references that branch**:
     Treat as **claimed by a concurrent session** running in parallel. Do
     not post a new claim. Instead, **return to Discover** using the same
     selection mode that produced this target (orphan-first: continue the
     A0-O capable path; roadmap mode: continue the A3-ready path), and
     select the **next eligible issue**. This is the scale-out path that
     allows multiple sessions to work on different issues when one issue
     has concurrent claims.

   - **If a match is found, does NOT correspond to an inheritable claim,
     AND no active claim references that branch**:
     Document the branch name and post a **hold note** to the issue: "_A5
     pre-check (e) detected an unexpected branch `issue/<number>-*`
     without an active claim. Possible orphaned branch from a crashed or
     stale session. Stopping for operator review._" Stop and wait for
     operator input. Do not post a claim or continue the workflow.

## Claim execution

Skip this section if pre-check (c) classified the issue as already
claimed by this current session. Keep the previously recorded `{claim-id}` and
branch, then proceed directly to Claim verification without posting a new
claim.

Determine `{branch-name}`:

- **Re-claim / takeover / forced-handoff recovery**: use the exact
  branch name from the inheritable claim comment or trusted
  forced-handoff evidence (the `branch` field of the active stale claim, the
  last-released trusted `claimed-by`, the forced-handoff evidence
  approved in Resume Step 1, or the trusted legacy claim being
  migrated). Do not compute a new name.
- **Fresh claim**: compute a new name using the IDD naming convention:
  `issue/<number>-<slug>` where `<slug>` follows the deterministic title
  normalization algorithm from pre-check (e).

Generate a fresh `{claim-id}`. Determine `{prior-claim-id}`:

- **Takeover of an active claim** (stale claim recovery) → the current
  active claim's `{claim-id}`
- **Forced-handoff recovery** → `none` once the human-gated handoff has
  already released or otherwise cleared the displaced claim in GitHub
  state; if the displaced non-stale claim is still active, stop and wait
  for the handoff mechanism instead of inventing a local superseding
  claim
- **Migration from a legacy claim** → `none`
- **Fresh claim** or claim after a released / unclaimed state → `none`

Post the claim comment to the issue. Keep the HTML token at the start
of the body, followed by the visible note:

```markdown
<!-- claimed-by: {agent-id} {claim-id} supersedes: {prior-claim-id|none} {ISO8601-timestamp} branch: {branch-name} -->

_{agent-id}: issue claim — IDD automation marker. Do not edit._
```

### Heartbeat posting

When posting a heartbeat (i.e., when the issue is already claimed by this current
session and you are extending the active claim's stale clock), copy the
`{branch}` field **verbatim** from the original `claimed-by` comment. Do not
recompute or derive a new branch name. The heartbeat's `{claim-id}` and
`{agent-id}` must match the original claim exactly. The branch field must also
match exactly to satisfy the heartbeat branch invariant (rule 3.5 in
this file's Claim-state parsing section).

## Claim verification

After posting `claimed-by`, wait for the configured settle delay to let
GitHub eventual consistency settle. Use `.github/idd/config.json`
`claim.verifySettleDelay` (distributed default: `PT5S`), then re-read
the full issue comment stream and parse the active claim in
chronological order using the shared claim-state rules. Apply all
race-safe checks below:

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

When the new claim came from forced-handoff recovery, cite the trusted
forced-handoff evidence in the issue digest or resume report's
`Authoritative by` field. Do not invent ad hoc `claimed-by` fields and
do not reuse the displaced `{claim-id}`.

After claim verification, upsert the issue live status digest when there
is exactly one marked digest or none. Use the verified `claimed-by`
comment as the authority: set `Phase` to `A5 claimed`, `Claim` to the
current `{agent-id}` / `{claim-id}`, `Branch` to the verified branch,
`Open blockers` to `none`, and `Next action` to `B1 create branch and
worktree`. If multiple marked digests exist, report their URLs and
continue from the verified claim without editing a digest.

Then continue to `idd-work.instructions.md`.

## Claim-state parsing

To determine the current active claim, read issue comments
chronologically and apply these rules:

1. Start with **no active claim**.
2. Ignore any `claimed-by` or `unclaimed-by` marker whose GitHub comment
   author is not a trusted marker actor.
3. A `claimed-by` whose `{agent-id}` AND `{claim-id}` both match the
   current active claim is a candidate **heartbeat**. Before recognizing
   it as a heartbeat, apply rule 3.5.
   3.5. **Heartbeat branch invariant**: A heartbeat candidate is recognized
   only when the `{branch}` field exactly matches the `{branch}` field of
   the currently active claim. If `{branch}` differs, treat the comment as
   **anomalous** — do not refresh the stale clock. The comment does not
   update any claim state. When an anomalous heartbeat affects a routing
   decision (e.g., in resume or worktree selection), surface it as a
   warning. The **detecting session** continues with its own verified claim
   unchanged; no corrective comment is required.
4. A `claimed-by` with a **new** `{claim-id}` becomes the active claim
   only if either:
   - there is no active claim AND its `supersedes:` value is `none`, or
   - its `supersedes:` value exactly matches the current active claim's
     `{claim-id}`, and the current active claim is already **stale** at
     the new comment's GitHub `created_at` timestamp.
5. An `unclaimed-by` releases the claim only if its `{agent-id}` AND
   `{claim-id}` both match the current active claim. Otherwise ignore it
   as a stale release from a superseded session.
6. Any `claimed-by` whose `{claim-id}` matches the active claim but
   whose `{agent-id}` differs, or whose `{claim-id}` was already
   superseded, or whose `supersedes:` value does not match the current
   active claim when one exists, is ignored as a stale or invalid event.

Same-agent restarts never silently inherit or supersede an active
non-stale claim. If the current session already recorded and verified
the active `{claim-id}` before this check, continue with that same token
and use heartbeats; do not post a fresh takeover claim. If the session
cannot prove ownership of the active `{claim-id}`, the active claim is
treated as owned by another live session until it is released or stale,
even when `{agent-id}` matches.
If a successor posts a fresh claim after forced handoff, later
heartbeats from the displaced old `{claim-id}` are ignored as stale
events; they do not reclaim ownership or refresh the stale clock.

## Legacy claim migration

Older issues may still contain the legacy claim format:

```html
<!-- claimed-by: {agent-id} {ISO8601-timestamp} branch: {branch-name} -->
```

and the matching legacy release format:

```html
<!-- unclaimed-by: {agent-id} {ISO8601-timestamp} -->
```

Treat trusted legacy comments as **migration-only** inputs:

- If an issue has no trusted new-format `claimed-by` comments yet, first
  check whether the latest trusted legacy `claimed-by` comment is
  followed by a later trusted legacy `unclaimed-by` comment from the
  same agent. If so, treat the issue as **unclaimed**; skip directly to
  posting a fresh new-format claim with `supersedes: none`.
- Otherwise, use the latest trusted legacy claim to decide branch reuse
  and staleness. A matching legacy agent ID is not enough to prove same
  live-session ownership.
- Then immediately post a new-format `claimed-by` comment with a fresh
  `{claim-id}` and visible note before any further side effects.
- Use `supersedes: none` for that one-time migration claim, because the
  legacy format has no `{claim-id}` to reference.
- After a new-format claim exists, ignore all legacy claim and unclaim
  comments for active-claim parsing and revalidation.
