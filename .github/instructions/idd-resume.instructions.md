# IDD — Resume Phase

Use this file when taking over a crashed or rate-limited session with no
prior session context. Read `idd-overview.instructions.md` for shared
definitions (claim format, stale threshold, abort, hold).

## Context to gather first

Before routing, collect all of the following:

1. **GitHub claim state** — parse the current active claim from issue
   comments using the shared claim-state rules. Record the active
   `{claim-id}`, agent ID, branch, and latest valid `claimed-by`
   `created_at`; record `none` for each of these fields if the issue is
   unclaimed. Also record the latest released branch, if any. The
   shared rules ignore marker-shaped comments from untrusted authors;
   record their URLs as suspicious context when they affect routing.
2. **Open PR** — check for an open PR that closes/references this issue.
3. **Local worktrees** — run `git worktree list`.
4. **Local branch** — check whether the branch named in the claim
   comment exists locally.
5. **Dirty/clean** — run `git status` in the worktree (if it exists).
6. **Unpushed commits** — run `git log @{u}..HEAD` in the worktree. If
   no upstream is configured, treat all local commits as unpushed.
7. **Current HEAD SHA** — run `git rev-parse HEAD`.

## Step 0 — Classify the resume route

Before applying Step 1, classify the resume situation using only
externally observable signals. Do not rely on the previous session
posting a graceful shutdown, release, or hold comment.

Use these signals together:

- active claim ownership (`{claim-id}` and `created_at`)
- issue/PR activity recency (comments, review threads, review bodies)
- PR HEAD movement and CI state transitions
- local worktree dirtiness and unpushed commits

Route to one of the following classes:

| Route class                                | Observable signal pattern                                                                                                                                                 | Action                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Crash recovery**                         | Session appears interrupted (missing/released claim, or unfinished local/PR state with no contradictory fresh owner signal).                                              | Continue with Step 1 and the existing restore table in Step 2.                                           |
| **Progress-stalled / rate-limit recovery** | Active claim is non-stale and not currently provable as owned by this session, PR HEAD/CI and review activity are quiet, and no external signal proves the owner resumed. | Do not take over yet. Post a hold comment with observed signals and the next retry condition, then stop. |
| **Stale-claim takeover**                   | Active non-owned claim exists and latest valid `claimed-by` `created_at` is `>= 24 h`.                                                                                    | Execute stale takeover flow in Step 1 (`supersedes` required), then continue.                            |
| **Ordinary clean continuation**            | Active claim is already owned by this session and current state is consistent with normal continuation.                                                                   | Continue with Step 1/Step 2 as a normal resume.                                                          |

Classification thresholds:

- **Stale takeover threshold**: 24 h from latest valid `claimed-by`
  `created_at`.
- **Stall quiet window**: require a sustained quiet period from external
  signals (for example, no newer issue/PR/review/CI activity and no HEAD
  movement) before declaring progress-stalled; when uncertain, hold
  rather than take over.

## Step 1 — Identify the issue and claim state

- If the issue is **closed** or the corresponding PR is **merged**:
  clean up any remaining local worktree and branch, then stop.

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

A branch left by a stale or released claim is inheritable. An open PR or
remote branch may be reused when it matches the branch recorded in the
stale active claim you are taking over, or in the latest released claim.

If the active or inherited branch field starts with `roadmap-audit/`,
the claim is an A1.5 roadmap-audit coordination claim, not a work branch.
This coordination claim does not lock unrelated child-issue execution.
After the re-claim or takeover is verified, do not create a branch or
worktree and do not use the Step 2 worktree table. Re-run A1.5 for that
roadmap issue, then follow A1.5's close, release, or stop behavior.
Treat child issue claims independently; roadmap-audit claim presence
alone must not block child issue execution.

## Step 2 — Locate or restore branch and worktree

When any row below requires creating a worktree, follow the B1
**Worktree creation** sub-procedure. B1 Step 3 covers when to run
**install-deps** (depends on whether WorkTrunk's pre-start hook is
configured).

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

## Step 3 — Determine PR and CI/review state

Read the PR's current CI and review status:

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
