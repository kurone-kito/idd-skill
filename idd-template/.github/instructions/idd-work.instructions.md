# IDD — Work and Self-Review Phase (B + C)

Read this file after a successful claim. It covers branch creation (B1),
planning (B2), implementation (B3), and the self-review loop (C).

---

## B1 — Create branch and worktree

Before creating, check for local conflicts in this order:

1. Ensure the local `main` branch is up to date and has no local
   commits. Run this from the primary worktree while on `main`:

   ```sh
   git fetch origin main
   git log origin/main..main --oneline
   ```

   If the second command outputs any lines, local `main` has unpushed
   commits — stop and report, do not force-reset `main`. Otherwise,
   fast-forward to origin:

   ```sh
   git merge --ff-only origin/main
   ```

2. Run `git worktree list` — if a worktree for the branch already
   exists, either reuse it (takeover) or remove it first using the exact
   path shown in the list: `git worktree remove <path-from-list>`. (Must
   remove the worktree before deleting the branch — git prevents
   deleting a branch checked out in a worktree.)
3. Run `git branch --list {branch-name}` — if the branch still exists
   locally after step 2, check whether it is an inheritable branch
   (claim takeover). If it is inheritable, reuse it. If it is not
   (unexpected leftover), delete it first:
   `git branch -d {branch-name}`. If deletion is refused (unmerged
   commits), check whether a remote branch or open PR exists for this
   branch — if so, treat it as inheritable and reuse it. If not, post a
   hold comment and stop for manual cleanup; do not force-delete without
   confirming no remote or PR claim is tied to it.

Then create the worktree as described below. If this is a takeover,
reuse the exact branch name from the existing claim comment — do not
generate a new one.

### Worktree creation

**Naming convention**: the worktree directory lives as a sibling of the
repository root. Compute the path as
`../<repo-name>.<normalized-branch>` where `<normalized-branch>` is the
branch name with every `/` replaced by `-`.

Example: repo `{{REPO_NAME}}`, branch `issue/123-add-foo` → worktree path
`../{{REPO_NAME}}.issue-123-add-foo`.

**Step 1 — Check for orphaned path**: if the target path already exists
but is not listed in `git worktree list`, stop and report for manual
cleanup before continuing.

**Step 2 — Create**: use **WorkTrunk** if available:

- macOS/Linux: `wt new <branch-name>`
- Windows: `git-wt new <branch-name>` (fall back to
  `wt new <branch-name>` if `git-wt` is unavailable)

If WorkTrunk is not available, choose the correct case:

| Case                                       | Command                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Fresh claim                                | `git worktree add <path> -b <branch-name> origin/main`                              |
| Takeover — local branch exists             | `git worktree add <path> <branch-name>`                                             |
| Takeover — remote branch only              | `git fetch origin && git worktree add <path> -b <branch-name> origin/<branch-name>` |
| Takeover — neither local nor remote (rare) | treat as fresh claim; preserve the inherited branch name                            |

**Step 3 — Install deps**: after worktree creation, ensure dependencies
are installed:

- **WorkTrunk with a pre-start install hook** (e.g.,
  `[pre-start].install` in `.config/wt.toml`): dependencies are
  installed automatically — skip this step.
- **Manual `git worktree add` or WorkTrunk without a hook**: `cd` into
  the newly created worktree, then run **install-deps**.

`install-deps` must remain safe to rerun during retries, takeovers, and
recreated worktrees without manual cleanup.

## B2 — Create and refine plan

Draft an implementation plan and post it as an issue comment. Then run a
critique pass to review the plan for correctness and concreteness (see
`idd-overview.instructions.md` for per-agent implementation). Post the
refined final plan as a follow-up or update to the same issue comment.
After the final plan comment is posted and claim ownership is
re-validated, update the issue live status digest: `Phase` is `B2
planned`, `Open blockers` is `none` unless the plan found a blocker,
`Next action` is `B3 implement`, and `Authoritative by` points to the
plan comment and verified claim.

## B3 — Implement

Implement the plan. Before each commit, run **fix-validate**.

Keep commits atomic — one logical change per commit.

If B3 or C must stop for a hold, use the shared Hold / suspend rules in
`idd-overview.instructions.md` and update the issue digest with the
blocking condition before stopping. Do not use the digest as the only
record of unfinished work; material decisions still need issue comments
or commits.

---

## C — Self-Review Loop

**Skip condition C2**: if the critique pass finds zero issues, skip to
`idd-pr-submit.instructions.md`.

**Skip condition C4**: if Accept count is zero, or if the loop has run
more than `critiqueLoop.cPhaseLowSeveritySkipAfter` times (distributed
default: `3`) and all remaining Accepts are severity Low (minor
improvements unrelated to PR intent), skip to
`idd-pr-submit.instructions.md`.

### C1 — Critique pass

Run a critique pass on this branch's diff. Ask it to check whether the
implementation is correct, whether the issue's requirements are
satisfied, whether adequate test coverage exists, and whether any other
problems exist. See `idd-overview.instructions.md` for per-agent
implementation. The distributed defaults for the C-phase skip and loop
guards are listed in `docs/policy-constants.md`.

After each critique loop decision, update the issue digest only if the
next action changes materially: for example, `C accepted fixes` before
C5, `C clean` before moving to PR submission, or a hold state when
guardrails stop the loop.

### C2 — Check for issues

If the critique pass reports zero issues → skip to
`idd-pr-submit.instructions.md`.

### C3 — Score issues

For each issue reported, assess severity and relevance to PR intent:

- **High** (safety, correctness, requirement violations, CI stability) →
  **Accept forced**, regardless of PR intent
- **Low** (minor improvements unrelated to PR intent) → **Reject
  recommended**
- **Medium** → judge by context

### C4 — Accept / Reject and loop check

Decide Accept or Reject for each issue. Then check:

- Accept count = 0 → skip to `idd-pr-submit.instructions.md`
- Loop count >
  `critiqueLoop.cPhaseLowSeveritySkipAfter` (distributed default: `3`)
  and all remaining Accepts are Low → skip to
  `idd-pr-submit.instructions.md`

Otherwise continue to C5.

### C5 — Fix accepted issues

Fix all Accepted issues. Run **fix-validate**.

Commit fixes atomically.

### C6 — Return to C1

Go back to C1 for the next review pass.
