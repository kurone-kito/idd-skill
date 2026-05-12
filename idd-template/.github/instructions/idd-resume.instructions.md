# IDD — Resume Phase

Use this file when taking over a crashed or rate-limited session with no
prior session context. Read `idd-overview.instructions.md` for shared
definitions (claim format, stale threshold, abort, hold).

Resume stale checks use the `claim-stale-age` policy default from
`docs/policy-constants.md` (distributed default: `24 h`).

## Step 0 — Route forced handoff and stalled-session recovery

Before Step 1, decide whether this run should route through the
forced-handoff path, the stalled-session path, or neither:

- If the issue is already closed, or the corresponding PR is already
  merged, skip stalled-session routing and continue to Step 1 cleanup
  behavior.
- If the repository records `forced-handoff: human-gated`, first check
  whether trusted forced-handoff evidence exists for this issue or its
  linked PR under the contract recorded in `docs/customization.md`.
  Record the approving human, displaced `{claim-id}`, `{branch}`,
  linked PR (if any), and the evidence comment URL.
- If trusted forced-handoff evidence exists and matches the current
  active claim or inheritable released branch / PR state, skip
  stalled-session routing and continue to Step 1's forced-handoff path.
  Quiet-window and stale-threshold checks do not apply once this
  human-gated recovery route is verified.
- Only when no usable forced-handoff evidence exists and a non-owned
  active claim remains, run
  `idd-resume-stall.instructions.md` first.
- Autopilot and unattended agents must never invent, request, or
  broaden forced handoff on their own. They may only consume already
  recorded human-gated evidence.
- Use only externally observable evidence (trusted claim heartbeat
  timestamps, PR head movement, remote branch tip movement, review/
  comment activity, and CI timestamps).
- Quiet-window evidence does not bypass the shared stale threshold:
  takeover remains disallowed until the non-owned active claim is stale.
- If stalled-session routing returns hold/inconclusive, stop.
- Otherwise continue with Step 1.

## Context to gather first

Before routing, collect all of the following:

1. **GitHub claim state** — parse the current active claim from issue
   comments using the shared claim-state rules. Record the active
   `{claim-id}`, agent ID, branch, and latest valid `claimed-by`
   `created_at`; record `none` for each of these fields if the issue is
   unclaimed. Also record the latest released branch, if any. The
   shared rules ignore marker-shaped comments from untrusted authors;
   record their URLs as suspicious context when they affect routing.
2. **Forced-handoff evidence** — when the repository records
   `forced-handoff: human-gated`, collect the trusted human approval
   note that satisfies the contract in `docs/customization.md`. Record
   the approving human, old claim ID, branch, linked PR if any, and
   evidence URL. When an open PR exists, require the issue-plus-PR
   approval text that names that PR; an issue-only approval is
   insufficient for PR-scoped recovery. If any field required by the
   current approval-note format is missing or contradictory, treat the
   evidence as unusable and do not route forced handoff.
3. **Open PR and current head** — check for an open PR that
   closes/references this issue. Record the current PR HEAD SHA.
4. **Issue/PR activity recency** — snapshot issue comments, review
   threads, review bodies, and regular PR comments, then record the
   latest `updatedAt` across that universe. When an open PR exists,
   include PR `createdAt`/`updatedAt` as additional recency signals.
5. **PR HEAD movement evidence** — define a baseline before comparison:
   use the latest trusted same-claim `review-watermark`/`review-baseline`
   marker SHA when available; otherwise use the current PR HEAD SHA
   captured in step 3 as the baseline. Then confirm whether commits were
   added after that baseline from PR timeline/activity.
6. **CI transition state** — record current CI states for the PR HEAD,
   the latest completed CI transition `completedAt` (any terminal
   outcome), and the latest successful CI pass `completedAt` (or `none`).
7. **Local worktrees** — run `git worktree list`.
8. **Local branch** — check whether the branch named in the claim
   comment exists locally.
9. **Dirty/clean** — run `git status` in the worktree (if it exists).
10. **Unpushed commits** — run `git log @{u}..HEAD` in the worktree. If
    no upstream is configured, treat all local commits as unpushed.
11. **Current local HEAD SHA** — run `git rev-parse HEAD`.
12. **Live status digest state** — record whether the issue or PR has
    zero, one, or multiple comments whose first line is
    `<!-- idd-live-status: current -->`. Do not use digest text to route
    resume; it is repairable UI state only.

## Step 1 — Identify the issue and claim state

- If the issue is **closed** or the corresponding PR is **merged**:
  clean up any remaining local worktree and branch, then stop.

Before ordinary claim-state branching, check for trusted forced-handoff
evidence under a repository policy of `forced-handoff: human-gated`:

- If the evidence names a `{claim-id}` that this current session had
  already verified before this routing step, this is the displaced old
  session. Recording the old claim ID as evidence does not count as
  ownership. Stop immediately. Do not push, comment, reply, resolve
  threads, request reviewers, or merge until a maintainer reassigns
  ownership.
- If the active claim already uses a `{claim-id}` that this current
  session had previously verified, and the forced-handoff evidence cites
  a different displaced claim ID, ignore that historical evidence and
  continue with the normal already-owned branch below.
- If no usable forced-handoff evidence exists, continue with the normal
  legacy and claim-state flow below.
- If the evidence cites a `{claim-id}`, branch, or linked PR that does
  not match the live active claim or inheritable released branch / PR
  state, stop and report the mismatch. Do not claim, push, or mutate
  review state.
- Otherwise, treat the issue as **forced-handoff recovery**. Re-claim
  only after the human-gated handoff mechanism has already updated the
  GitHub claim stream to a released or successor-ready state. If the
  displaced non-stale claim still remains active, stop and wait instead
  of inventing a local superseding claim. Once GitHub state reflects the
  handoff outcome, re-claim via `idd-claim.instructions.md` with a fresh
  `{claim-id}` and the branch named in the forced-handoff evidence, then
  continue to Step 2 after A5 verification. The successor must cite the
  forced-handoff evidence in its resume report or digest
  `Authoritative by`; it must not silently inherit the old `{claim-id}`.

If the issue has no trusted new-format `claimed-by` comments but has legacy
claim comments from trusted marker actors, treat the latest trusted
legacy `claimed-by` comment as a migration-only input. First check
whether that latest trusted legacy `claimed-by` comment is followed by a
later trusted legacy `unclaimed-by` comment from the same agent — if so,
treat the issue as **unclaimed** and proceed to the re-claim path below.
Otherwise:

- Latest trusted legacy claim has `created_at` < 24 h → **not
  inheritable**, stop. This includes matching `agent-id`; the legacy
  agent ID alone does not prove same live-session ownership.
- Latest trusted legacy claim has `created_at` ≥ 24 h → **stale**.
  Migrate it via `idd-claim.instructions.md` with a fresh `{claim-id}`
  and `supersedes: none`, then continue to Step 2.

Otherwise, determine claim state from the parsed active claim:

- No active claim → **unclaimed**. Re-claim via
  `idd-claim.instructions.md`, then continue to Step 2.
- Active claim whose `{claim-id}` was already recorded by this current
  session before this check and is now verified → **already owned**.
  Continue to Step 2 with that same `{claim-id}`; do not post a new
  claim. A token first learned by parsing the current issue comments is
  not enough.
- Any other active claim, latest valid `claimed-by` `created_at` < 24 h
  → **not inheritable**, stop. This includes matching `agent-id`; the
  agent ID alone does not prove that this is the same live session.
- Any other active claim, latest valid `claimed-by` `created_at` ≥ 24 h
  → **stale**. Take it over via `idd-claim.instructions.md` with a fresh
  `{claim-id}` whose `supersedes:` value is the current active claim's
  `{claim-id}`, then continue to Step 2.

When Step 1 performs a re-claim, forced-handoff recovery, or stale
takeover, claim verification
must follow A5 race-safe verification from
`idd-claim.instructions.md`: wait 5–10 seconds after posting
`claimed-by`, re-read and parse the full claim stream chronologically,
apply the same-second lexicographic `{claim-id}` tie-breaker, and fail
verification if a later trusted competing `claimed-by` with a different
`{claim-id}` appears.

A branch left by a stale or released claim is inheritable. An open PR or
remote branch may be reused when it matches the branch recorded in the
stale active claim you are taking over, in the latest released claim, or
in trusted forced-handoff evidence whose branch and linked PR fields
still match the live GitHub state. Forced-handoff recovery never waives
the normal A5 branch-collision and open-PR safety checks.

If the active or inherited branch field starts with `roadmap-audit/`,
the claim is an A1.5 roadmap-audit coordination claim, not a work branch.
This coordination claim does not lock unrelated child-issue execution.
After the re-claim or takeover is verified, do not create a branch or
worktree and do not use the Step 2 worktree table. Re-run A1.5 via
`idd-roadmap-audit.instructions.md` for that roadmap issue, then follow
that file's close, release, or stop behavior.
Treat child issue claims independently; roadmap-audit claim presence
alone must not block child issue execution.

After Step 1 establishes the route and verifies any current-session
claim, repair a missing or stale live status digest from the parsed
claim state, PR state, CI state, and review activity when doing so is
safe under the claim revalidation gate. If multiple marked digests
exist, preserve them, report their URLs, and continue routing from
trusted markers and GitHub state rather than digest text.
For a successful stale takeover or legacy migration, the digest belongs
to the new verified `{claim-id}` only after that claim is active; include
the superseded or migrated claim marker in `Authoritative by` and do not
reuse prior-claim review-watermark or review-baseline comments. For
non-owned, non-stale claims, do not edit the digest; stalled-session
handling records evidence in session logs only unless the claim becomes
yours.
During forced handoff on an open PR, do not delete, hide, minimize, or
otherwise unmark prior-claim operational markers just to clear state;
they remain audit context while the successor rebuilds fresh markers
under its own `{claim-id}`.

## Step 2 — Locate or restore branch and worktree

When any row below requires creating a worktree, follow the B1
**Worktree creation** sub-procedure. B1 Step 3 covers when to run
**install-deps** (depends on whether WorkTrunk's pre-start hook is
configured).

**Important**: The `{branch}` field in the table below refers to the branch
name from the current active claim (or inheritable claim in recovery scenarios).
This branch value must be used verbatim when creating or restoring worktrees.
The heartbeat branch invariant (rule 3.5 in `idd-overview.instructions.md`)
requires that heartbeat comments preserve the original branch field exactly. If
you encounter anomalous heartbeats with a different branch field, ignore that
branch value and use the currently active claim's branch instead.

| PR exists?     | Remote branch? | Local state                           | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Yes (1 match)  | —              | worktree missing                      | Run `git fetch origin`. If a local branch named `{branch}` exists, check for unpushed commits: `git log origin/{branch}..{branch} --oneline`. If any commits appear, create the worktree from the existing local branch; if reviews exist on the PR → resume from E11; if no reviews → route to D1. If no local commits, reset: `git branch -f {branch} origin/{branch}`, then create worktree. If no local branch named `{branch}` exists, create it from remote: `git branch {branch} origin/{branch}`, then create worktree. |
| Yes (1 match)  | —              | worktree exists, rebase in progress   | Check `.git/rebase-merge` / `.git/rebase-apply`. Continue or abort the rebase. Then route: no reviews yet → D1 path; reviews exist → E11 path.                                                                                                                                                                                                                                                                                                                                                                                  |
| Yes (1 match)  | —              | worktree exists, dirty, reviews exist | Resume from E9 (treat as mid-review-fix): run **fix-validate**, commit fixes, run **post-fix-validate**, push, then go to Step 3                                                                                                                                                                                                                                                                                                                                                                                                |
| Yes (1 match)  | —              | worktree exists, dirty, no reviews    | Run **fix-validate**, commit any unfinished work, then verify claim is still yours (D2 step 1): re-read the issue and confirm the active claim still uses your current `{claim-id}`. If not, report and stop. Otherwise run **pre-push-validate**, push, then wait for CI (D4 on-success → E1)                                                                                                                                                                                                                                  |
| Yes (1 match)  | —              | worktree exists, clean, unpushed      | Sync main (D1 rebase) + **pre-push-validate** + push (D2), then go to Step 3                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Yes (1 match)  | —              | worktree exists, clean, no unpushed   | Go to Step 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Yes (multiple) | —              | —                                     | Try to match by the claimed/inherited branch name (see Step 1). If exactly 1 PR matches, treat as "1 match". If 0 or still multiple match, re-validate claim ownership. If the active claim still uses your current `{claim-id}`, post `unclaimed-by` with that `{claim-id}`, report, abort. If the claim was already lost, report, abort, and do **not** post a release.                                                                                                                                                       |
| No             | Yes            | —                                     | Fetch remote branch, create local branch + worktree, resume from C1 (C exits to D1 immediately if nothing new is found)                                                                                                                                                                                                                                                                                                                                                                                                         |
| No             | No             | No worktree, no branch                | Resume from B1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| No             | No             | No worktree, branch exists            | Restore worktree from local branch; if unpushed → D1, else → B2                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| No             | No             | Worktree dirty                        | Resume from B3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| No             | No             | Worktree clean, unpushed              | Resume from D1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| No             | No             | Worktree clean, no unpushed           | Resume from B2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

After Step 2 chooses a route, refresh the digest only when the route
materially changes what a human should expect next. Examples:
`Phase: resume -> B3` for dirty worktree recovery, `Phase: resume -> D1`
for unpushed clean commits, or `Phase: resume -> F1` when CI and review
state are already clear. The `Authoritative by` field should cite the
claim marker, PR/branch evidence, CI status, and review snapshot used for
the routing decision.

## Step 3 — Determine PR and CI/review state

Read the PR's current CI and review status:

After a forced handoff on an open PR, rebuild review state from current
GitHub state. Prior-claim `review-watermark` and `review-baseline`
comments are not reusable, even when the branch and HEAD are unchanged.
If the linked PR is open and review state matters, route to E1 before
any merge-bound F check. Live status digests remain UI-only handoff
context and do not satisfy review currency, claim ownership, advisory
wait, or CI gates.

| Condition                                                                          | Action                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Required CI checks not yet generated, no reviews yet                               | Wait for generation, then apply D4 logic                       |
| Required CI checks not yet generated, reviews exist                                | Wait for generation, then apply E15 logic                      |
| CI `queued` or `in_progress`, no reviews yet (first push)                          | Apply D4 CI logic (`idd-ci.instructions.md`, on-success → E1)  |
| CI `queued` or `in_progress`, reviews exist (post-fix push)                        | Apply E15 CI logic (`idd-ci.instructions.md`, on-success → E1) |
| CI `failure` / `cancelled` / `timed_out`, no reviews yet                           | Apply D4 failure/cancelled branch                              |
| CI `failure` / `cancelled` / `timed_out`, reviews exist                            | Apply E15 CI failure/cancelled branch                          |
| CI `success`, unresolved threads / unreplied comments / active `CHANGES_REQUESTED` | Resume from E1                                                 |
| CI `success`, none of the above                                                    | Resume from F1                                                 |

For forced-handoff recovery on an open PR, treat the final
`CI success, none of the above` row as `Resume from E1` until the
successor has posted its own same-claim review watermark and baseline
for the current `{claim-id}`.
