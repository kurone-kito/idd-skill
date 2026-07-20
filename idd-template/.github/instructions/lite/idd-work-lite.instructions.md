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

1. On the primary worktree, run `git fetch origin main`.
2. On the primary worktree, confirm local `main` has no unpushed commits.
3. Fast-forward local `main` with `git merge --ff-only origin/main`.
4. Keep the primary worktree on `main` throughout B1.
5. Reuse the existing branch name verbatim for takeover.
6. If a sibling worktree already exists, inspect that exact path with the
   profile-selected `claim-lock` helper before reuse or removal.
7. Run `git branch --list {branch-name}`. If the branch exists locally, reuse it
   only when it is an inheritable takeover branch; otherwise delete it with
   `git branch -d {branch-name}`.
8. If deletion is refused, check whether a remote branch or open PR exists for
   this branch. If not, stop for manual cleanup.
9. If `git worktree list --porcelain` marks the entry `prunable` and its path
   is already absent, remove that stale entry with `git worktree remove --force
    <path-from-list>` and continue.
10. If the target path exists but is not listed in `git worktree list`, stop for
    manual cleanup.
11. Create the sibling worktree at `../<repo-name>.<normalized-branch>`.
12. Define `normalized-branch` as the branch name with each `/` replaced by
    `-`.
13. Use WorkTrunk if available.
14. In automation, use `wt switch --create -x true`.
15. Do not use `wt new`.
16. If WorkTrunk uses a pre-start install hook, its first command must acquire
    the worktree lock before it installs anything.
17. If the hook cannot acquire the lock, create the worktree without the hook.
18. If WorkTrunk is unavailable, use `git worktree add <path> -b <branch-name>
     origin/main` for a fresh claim.
19. If WorkTrunk is unavailable and this is a takeover, use `git worktree add
     <path> <branch-name>` with the local branch.
20. If WorkTrunk is unavailable and only the remote branch exists, run `git
     fetch origin <branch-name>`.
21. If WorkTrunk is unavailable and only the remote branch exists, use `git
     worktree add <path> -b <branch-name> origin/<branch-name>`.
22. For manual `git worktree add` or WorkTrunk without a hook, acquire the
    worktree lock with the profile-selected `claim-lock` helper immediately
    after creation and before any install or other mutation.
23. Run `install-deps` on the manual/no-hook path.
24. Verify the primary worktree's HEAD is still on `main`.
25. Verify `git worktree list` shows the new path.
26. Verify the current directory is the new sibling worktree.

## B2 — Create and refine plan

1. Run `git fetch origin main`.
2. Re-read the issue and do the cheap supersession check. Treat a title-only
   match as no hit.
3. If a merged PR already closed the issue, stop.
4. If a merged PR since the claim time already touched a scoped candidate file,
   verify the acceptance criteria on current `main`.
5. If the criteria already hold, close the issue with a comment referencing the
   superseding PR.
6. Draft an issue comment plan for the exact change set.
7. Run a critique pass on the plan.
8. Post the refined final plan as a follow-up or update to the same issue
   comment.
9. After the final plan comment, update the live status digest to `B2 planned`,
   `Open blockers: none` unless the plan found a blocker, `Next action: B3
   implement`, and `Authoritative by` pointing at the claim and plan comment.

## B2.1 — Premise verification

If the issue is a decision-transcription issue — it records or restates a prior
human decision whose rationale asserts a checkable fact about shipped behavior —
verify that fact against the prior change's actual code or docs before drafting
the plan. If the prior change or the asserted fact cannot be verified, stop and
hold until a maintainer addendum resolves it.

## B3 — Implement

1. Before the first implementation edit, confirm the final B2 plan comment
   exists on the issue.
2. If code already landed before that checkpoint was noticed, disclose the
   ordering deviation on the issue.
3. Post the plan retroactively.
4. Critique the completed diff.
5. Implement the plan.
6. Run `fix-validate` before each commit.
7. Keep commits atomic.
8. If `fix-validate` changes files, stage and commit them before continuing.
9. If validation fails in files this diff did not touch, suspect baseline
   drift or a stale install before blaming the change.
10. If a test this diff did not touch fails once locally but passes in
    isolation while hosted CI is green, trust the hosted result and stop
    chasing it as a regression.
11. When consolidating a wrapper function used at multiple call sites into one
    shared function, check whether any call site's old delegate path added
    options or behavior the shared function does not replicate.
12. If B3 or C must stop for a hold, post the hold reason, update the digest,
    and stop.

## C — Self-review

### C1 — Critique pass

1. Run a critique pass on the branch diff.
2. Ask whether the implementation is correct, whether the issue's requirements
   are satisfied, whether coverage is adequate, and whether any other problems
   exist.

### C2 — Check for issues

1. If the critique pass reports zero issues, check the `fix-validate` floor.
2. If the critique pass reports one or more issues, continue to C3.
3. If the floor has not passed, continue to C5 to repair validation.
4. If the floor has passed, skip to `idd-pr-submit.instructions.md`.

### C3 — Score issues

1. Treat high issues as safety, correctness, requirement, or CI blockers.
2. Treat medium issues by context.
3. Treat low issues as minor improvements unrelated to PR intent.

### C4 — Accept / Reject and loop check

1. Accept high issues.
2. If accepted issues remain and the floor has not passed, continue to C5.
3. If no accepted issues remain and the floor has passed, skip to
   `idd-pr-submit.instructions.md`.
4. If only low accepted issues remain after 3 loops and the floor has passed,
   skip to `idd-pr-submit.instructions.md`.
5. Otherwise continue to C5.

### C5 — Fix accepted issues

1. Run `fix-validate`.
2. If the floor still has not passed and there are no accepted issues, stop
   and ask.
3. Fix the accepted issues.
4. Rerun `fix-validate`.
5. If anything changed, commit atomically.

### C6 — Return to C1

1. Repeat the critique loop until it is clean.
2. Treat the low-issue three-loop exit as clean once the floor has passed.
3. Do not widen scope into review triage or merge phases from this file.
