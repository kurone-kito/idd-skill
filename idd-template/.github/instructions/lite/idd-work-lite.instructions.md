# IDD — Work and Self-Review Phase (Lite)

Lite profile for helper-enabled weak/local models. Same semantics as
`idd-work.instructions.md`. Use only for a single claimed issue. If the
repository is `instructions-only`, use the standard work instructions instead.

## Helper runtime contract

- Helper-enabled profiles: when a step names a helper or command set, use it.
  If a required helper is missing, fails, or disagrees with live state, stop
  and ask. Do not fall back silently to prose.
- `instructions-only`: do not use this lite file; use
  `idd-work.instructions.md` instead.
- Any mismatch between this file and the standard work phase is a bug in this
  file.

## Stop-and-ask conditions

- The active claim is ambiguous, disputed, or lost.
- The current directory is not the sibling worktree for the claimed branch.
- The claimed branch is not the current branch.
- A required helper or validation command is unavailable, invalid, or disagrees
  with live state.
- The worktree is dirty and ownership is unclear.
- The final B2 plan comment does not exist before B3.
- Multiple PRs match the claim branch.

## Pre-mutation guard

Before any commit, push, rebase, claim heartbeat, reply, resolve, reviewer
request, or other GitHub side effect, confirm all of the following:

1. The active claim still uses this session's claim id.
2. The current directory is the sibling worktree for the claimed branch.
3. `git branch --show-current` equals the claimed branch.
4. The worktree-local claim lock is held.
5. If any check fails, stop.

## B1 — Create worktree

1. On the primary worktree, fetch `origin/main`, confirm local `main` has no
   unpushed commits, then fast-forward it with `git merge --ff-only
   origin/main`. If local `main` has unpushed commits, stop.
2. Reuse the existing branch name verbatim for takeover. Do not invent a new
   slug.
3. If a local branch or sibling worktree already exists, treat it as inheritable
   only when the claim state or remote PR state says so. If it is an unexpected
   leftover, remove it only after confirming no remote branch or open PR is tied
   to it.
4. If the target path exists but is not listed in `git worktree list`, stop for
   manual cleanup.
5. Create the sibling worktree at `../<repo-name>.<normalized-branch>`.
6. Use WorkTrunk if available. In automation, make it exit cleanly (for example
   `-x true`). If WorkTrunk is unavailable, use `git worktree add` with
   `origin/main` for a fresh claim, the local branch for a takeover, or
   `origin/<branch>` when only the remote branch exists.
7. Acquire the worktree lock immediately after creation and before any install
   or other mutation.
8. Run `install-deps`.
9. Verify `main` still points to `main`, `git worktree list` shows the new
   path, and the current directory is the new sibling worktree.

## B2 — Create and refine plan

1. Fetch `origin/main`.
2. Re-read the issue and do the cheap supersession check before drafting code:
   if a merged PR already closed the issue, stop; if a merged PR since the claim
   time already touched a scoped candidate file, verify the acceptance criteria
   on current `main` and stop when they already hold.
3. Draft an issue comment plan for the exact change set.
4. Run a critique pass on the plan.
5. Post the refined final plan as a follow-up or update to the same issue
   comment.
6. After the final plan comment, update the live status digest to `B2 planned`,
   `Open blockers: none` unless the plan found a blocker, `Next action: B3
   implement`, and `Authoritative by` pointing at the claim and plan comment.

## B3 — Implement

1. Before the first implementation edit, confirm the final B2 plan comment
   exists on the issue.
2. If code already landed before that checkpoint was noticed, disclose the
   ordering deviation on the issue, post the plan retroactively, and critique
   the completed diff.
3. Implement the plan.
4. Run `fix-validate` before each commit.
5. Keep commits atomic.
6. If `fix-validate` changes files, stage and commit them before continuing.
7. If validation fails in files this diff did not touch, suspect baseline drift
   or a stale install before blaming the change.
8. If a test this diff did not touch fails once locally but passes in isolation
   while hosted CI is green, trust the hosted result and stop chasing it as a
   regression.
9. If B3 or C must stop for a hold, post the hold reason, update the digest,
   and stop.

## C — Self-review

### C1 — Critique pass

Run a critique pass on the branch diff. Ask whether the implementation is
correct, whether the issue's requirements are satisfied, whether coverage is
adequate, and whether any other problems exist.

### C2 — Check for issues

If the critique pass reports zero issues and the `fix-validate` floor has
passed, continue. If it reports one or more issues, continue to C3.

### C3 — Score issues

- High: safety, correctness, requirement violations, CI stability.
- Medium: judge by context.
- Low: minor improvements unrelated to PR intent.

### C4 — Accept / Reject and loop check

- High issues are accepted.
- If accepted issues remain and the floor has not passed, continue to C5.
- If no accepted issues remain and the floor has passed, continue.
- If only low accepted issues remain after 3 loops and the floor has passed,
  continue.
- Otherwise continue to C5.

### C5 — Fix accepted issues

Fix the accepted issues, then rerun `fix-validate`. If anything changed, commit
atomically.

### C6 — Return to C1

Repeat the critique loop until it is clean and the diff passes `fix-validate`.
Do not widen scope into review triage or merge phases from this file.
