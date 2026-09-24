---
type: reference
title: IDD Resume — Detail Reference
description: Provides the full narrative detail behind idd-resume.instructions.md's compact routing tables for branches that need careful judgment.
tags: [resume, recovery]
---

# IDD Resume — Detail Reference

This document provides full narrative for the routing branches and worktree
actions referenced by `idd-resume.instructions.md`. The compact decision
tables in that file are the authoritative runtime contract; this document
provides the detail needed when a branch requires careful judgment.

## §FH — Forced-Handoff Recovery

A forced-handoff recovery path applies when the repository records
`forced-handoff: human-gated` and valid trusted evidence exists for the
selected issue. Collect evidence under the contract in `docs/customization.md`:
record the approving human, old claim ID, branch, linked PR (if any), and
evidence URL.

The recommended operator path for collecting that evidence is the
interactive `idd-force-handoff` helper. It asks for the issue number
first, checks live open PRs on the active claim branch to decide whether
PR input is required, then prompts for an optional successor agent-id
(leaving it blank keeps the displaced agent's own id -- the default --
while entering a value selects that entered agent-id as the successor,
which may still match the displaced agent-id if re-entered verbatim).
It previews the resolved successor IDs and marker, printing a warning
when the resolved successor still matches the displaced agent-id, and
then requires a final `y/N` confirmation before posting anything to
GitHub. Outside an interactive TTY it must fail closed. The lower-level
`idd-forced-handoff-marker` helper remains available for rendering or
inspection, but it is not the primary maintainer workflow.

**Validity checks** — treat evidence as unusable and do not route
forced-handoff if:

- Any field required by the current approval-note format is missing or
  contradictory.
- An open PR exists and the approval text does not name that PR (an
  issue-only approval is insufficient for PR-scoped recovery).
- The evidence `{claim-id}`, branch, or linked PR does not match the live
  active claim or inheritable released branch/PR state — stop and report
  the mismatch; do not claim, push, or mutate review state.
- The forced-handoff **authorization gate** does not hold. See
  [`idd-claim.instructions.md` rule 7](../.github/instructions/idd-claim.instructions.md#claim-state-parsing)
  for the full criteria — apply it in addition to the checks above; it
  is not restated here.

**Re-claim rule** — Re-claim only after the human-gated handoff mechanism
has already updated the GitHub claim stream to a released or
successor-ready state. If the displaced non-stale claim still remains
active, stop and wait rather than inventing a local superseding claim.
Once GitHub state reflects the handoff outcome, continue via
`idd-claim.instructions.md` on the branch named in the forced-handoff evidence.
The verified `forced-handoff` marker has already set the active claim to its
pre-recorded `new-agent-id` / `new-claim-id` pair (rule 7), so the successor
**adopts both verbatim** as its own `{agent-id}` / `{claim-id}` for the rest
of the run — including `--agent-id` and `--claim-id` at F2/F3's
`pre-merge-readiness` — rather than minting a claim-id or keeping its own
agent-id (an invented agent-id silently fails later checks as
`agent-id-mismatch`; see `idd-claim.instructions.md`'s Claim verification
section). No separate `claimed-by` post is required for the transfer itself.
This adopted claim is **sticky** (re-derived on every resolution pass); see
the same section for the adopt-verbatim vs. release-then-fresh reconciliation
paths if a fresh claim appears not to take effect.

**Displaced-session guard** — If the forced-handoff evidence names a
`{claim-id}` that this current session had already verified before this
routing step, this session is the displaced old session. Stop immediately.
Do not push, comment, reply, resolve threads, request reviewers, or merge
until a maintainer reassigns ownership.

The successor must cite the forced-handoff evidence in its resume report or
digest `Authoritative by`. It must not reuse the displaced old `{claim-id}` as
its own — always use the marker's assigned `new-claim-id`. (`{agent-id}` may
legitimately equal the displaced claim's agent-id; only `{claim-id}` must
always be the fresh marker-assigned value.)

**Content-scope audit** — Once the successor's post-handoff routing
(Step 2 in `idd-resume.instructions.md`) lands it on §W7 or §W8 with
inherited commits on `{branch}`, run the content-scope audit described
in §CSA before those commits are pushed or bundled into a PR. The
displaced session is by definition unreachable, so its own planning
comment can never substitute for this independent check.

## §W1 — PR exists (1 match), no worktree

Run `git fetch origin` from the primary worktree (this is a
HEAD-preserving command and is safe there). If a local branch named
`{branch}` exists, check for unpushed commits:
`git log origin/{branch}..{branch} --oneline`.

- **Commits appear**: create the sibling worktree from the existing
  local branch using the B1 naming convention:
  `git worktree add <sibling-worktree-path> {branch}`. If reviews
  exist on the PR → resume from E11; if no reviews → D1.
- **No local commits**: reset the branch first from the primary
  worktree (HEAD-preserving):
  `git branch -f {branch} origin/{branch}`, then create the sibling
  worktree: `git worktree add <sibling-worktree-path> {branch}`.

If no local branch named `{branch}` exists, create from remote (still
from the primary worktree, HEAD-preserving): `git branch {branch}
origin/{branch}`, then create the sibling worktree:
`git worktree add <sibling-worktree-path> {branch}`.

`<sibling-worktree-path>` follows the B1 naming convention (sibling
of the repository root, with `/` in branch name replaced by `-`).

Anti-patterns (do not substitute these for the sequence above):

- `git switch -c {branch} origin/{branch}` — moves the primary
  worktree's HEAD to the issue branch and skips worktree creation.
- `git checkout -b {branch} origin/{branch}` — equivalent failure.

See [B1 Anti-patterns](../.github/instructions/idd-work.instructions.md#anti-patterns)
for the full rule.

## §W2 — PR exists (1 match), rebase in progress

Check `.git/rebase-merge` and `.git/rebase-apply` in the worktree. Continue
or abort the rebase as appropriate for the situation. Then route:

- No reviews yet on the PR → D1
- Reviews exist → E11

## §W3 — PR exists (1 match), dirty, reviews exist

Resume from E9 (treat as mid-review-fix): run **fix-validate**, commit
fixes, run **post-fix-validate**, push, then go to Step 3.

## §W4 — PR exists (1 match), dirty, no reviews

Run **fix-validate**, commit any unfinished work. Then re-validate the
claim (D2 step 1): re-read the issue and confirm the active claim still
uses your current `{claim-id}`. If it does not, report and stop. Otherwise
run **pre-push-validate**, push, then wait for CI
(`idd-ci.instructions.md`, D4 on-success → E1).

## §W5 — PR exists (1 match), clean, unpushed

Sync main (D1 rebase) + **pre-push-validate** + push (D2), then go to
Step 3.

## §W6 — PR exists (multiple matches)

Try to match by the claimed/inherited branch name from Step 1. If exactly
one PR matches, treat as "1 match" and use the corresponding §W1–§W5 row.

If zero or still multiple PRs match after the branch filter, re-validate
claim ownership:

- Active claim still uses your current `{claim-id}`: post `unclaimed-by`
  with that `{claim-id}`, report the ambiguity, and abort.
- Claim already lost: report and abort without posting a release.

## §W7 — No PR, remote branch exists

From the primary worktree (HEAD stays on `main`):

1. `git fetch origin {branch}` — fetch the remote tip.
2. `git branch {branch} origin/{branch}` — create the local branch
   without moving primary HEAD.
3. `git worktree add <sibling-worktree-path> {branch}` — create the
   sibling worktree using the B1 naming convention.

Before resuming, run the content-scope audit (§CSA, below) against
`{branch}` — nothing on it has been through a PR yet. Then resume from
C1 inside the new worktree. C exits to D1 immediately if the critique
pass finds nothing new.

Anti-patterns (do not substitute these for steps 2–3): `git switch -c
{branch} origin/{branch}` or `git checkout -b {branch}
origin/{branch}` — both move the primary worktree's HEAD to the
issue branch and skip worktree creation. See
[B1 Anti-patterns](../.github/instructions/idd-work.instructions.md#anti-patterns)
for the full rule.

## §W8 — No PR, no remote branch, no worktree, local branch exists

Restore the worktree from the local branch. Then route:

- Unpushed commits exist → run the content-scope audit (§CSA, below)
  against `{branch}`, then D1.
- No unpushed commits → B2 (no inherited commit content to audit).

## §CSA — Content-Scope Audit for Inherited Commits

Applies wherever §W7, §W8, or §FH resumes work from commit(s) this
session itself did not just author on `{branch}` — whether recovering
its own crashed prior turn or taking over from a different,
possibly-dead session via forced-handoff. Neither case has a live
author left to confirm what was actually verified, so before any of
these commits get pushed or bundled into a PR, the resuming session
must independently audit their content against the target issue's own
declared scope (observed 2026-09-21, kurone-kito/idd-skill#3166: an
inherited unpushed commit correctly implemented an issue's declared
requirements but also silently bundled in a third, undeclared feature,
justified only by the dead session's own stale, unverifiable
"maintainer-authorized" planning comment).

**Diff range**: `{branch}`'s full range against `{development-branch}`,
not merely commits unpushed relative to `{branch}`'s own remote tip —
§W7 creates the local branch directly from `origin/{branch}`, so a
same-branch unpushed-only diff is empty by construction there even
though nothing on that branch has been through a PR yet.
`{development-branch}` is the value resolved in
[B1's Worktree creation](../.github/instructions/idd-work.instructions.md#worktree-creation)
step — re-resolve it here if this file is entered directly (for
example, on resume) without a fresh B1 pass, the same caveat
`idd-pr-submit.instructions.md`'s D1 uses for the same variable. For
example:

```sh
git fetch origin {development-branch}
git diff origin/{development-branch}...{branch}
```

**Audit**: diff that range against the issue's own `## Proposed
change`, `## Acceptance criteria`, and `## Candidate files` sections.
Treat any change that does not trace to a declared requirement the same
way a fresh implementation would treat unrequested scope: flag it for
removal, or require an explicit, evidenced justification recorded on
the issue — never accept a stale planning comment's own self-asserted
authorization as sufficient by itself. This is a diff review, not a new
gate or helper.

This audits for scope _creep_; it does not replace C1's own critique
pass, which verifies declared requirements are _met_ — the two checks
are complementary, and §W7 still resumes from C1 after this audit.

## §Digest — Digest Repair Guidance

After Step 1 establishes the route and verifies any current-session claim,
repair a missing or stale live status digest from the parsed claim state,
PR state, CI state, and review activity when doing so is safe under the
claim revalidation gate.

**Multiple marked digests** — If multiple comments whose first line is
`<!-- idd-live-status: current -->` exist, preserve them all, report their
URLs, and continue routing from trusted markers and GitHub state rather than
digest text. Do not choose one arbitrarily during an unattended run.

**Stale takeover or legacy migration** — The repaired digest belongs to the
new verified `{claim-id}` only after that claim is active. Include the
superseded or migrated claim marker in `Authoritative by` and do not reuse
prior-claim `review-watermark` or `review-baseline` comments.

**Non-owned, non-stale claim** — Do not edit the digest. Stalled-session
handling records evidence in session logs only unless the claim becomes
yours.

**Forced-handoff on an open PR** — Do not delete, hide, minimize, or
otherwise unmark prior-claim operational markers. They remain audit context
while the successor rebuilds fresh markers under its own `{claim-id}`.
Refresh the digest only after the successor's verified claim is active and
a same-claim watermark has been posted. Live status digests are UI-only
handoff context and do not satisfy review currency, claim ownership,
advisory wait, or CI gates.

## §LWR — Local Worktree Recovery

A local worktree matching a stale or released claim's branch counts as occupied
(observed 2026-09-19, `kurone-kito/idd-skill#3141`): a matching live worktree
could still hold a same-host session's uncommitted work, so Resume and Claim
stop, and Discover marks the candidate ineligible, rather than assume the
claim is abandoned. In a shared-clone
setup this stop has no defined recovery when the worktree's own session
actually crashed, so its issue can never reach the normal stale takeover. This
section defines that recovery. It is operator-run, never automated, and checks
no process-liveness signal — `src/scripts/claim-lock.mts`'s header records why:
this "deliberately excludes any local liveness signal (e.g. process PID)... the
process invoking this CLI is a one-shot child that exits the moment the call
returns, so a recorded PID would be a tombstone before any competing session
could ever observe it as 'alive'".

1. **Confirm the block.** Run the profile-selected `resume-claim-routing`
   helper (`docs/idd-helper-scripts.md`; source-repo/vendored-node: `node
   scripts/resume-claim-routing.mjs --issue <n>`); a
   `local_worktree_occupied` result reports
   `evidence.local_worktree.paths` and a `reason` starting
   `stale-claim-...` or `released-claim-...`. If `<path>` no longer
   exists on disk (a prunable record), skip to `git worktree remove
   --force <path-from-list>` — mirroring B1's own same-shape recovery
   rule for a prunable entry (`idd-work.instructions.md`); plain `git
   worktree prune` silently no-ops on a record younger than Git's
   default 3-month prune expiry, leaving the occupancy helper failing
   closed on it (PR `#3354` review, Copilot). Nothing to preserve or
   remove. Otherwise run the profile-selected
   `claim-lock` helper's check form (source-repo/vendored-node: `node
   scripts/claim-lock.mjs --check --worktree <path>`) to read which
   claim-id holds the lock. Proceed only when that claim-id matches the
   stale or released claim being recovered, or the lock is absent (a
   legacy pre-claim-id release). Stop for every other outcome — a
   different claim-id (a live session may still own it), or a malformed
   or unreadable lock — unless a separately authorized owner-resume or
   forced-handoff path applies.
2. **Rule out a live session.** Outside the helpers, independently
   confirm no session is still working in the worktree — the helpers
   never check process liveness (see the citation above).
3. **Preserve.** Run this step and step 4 from the **surviving primary
   worktree**, never from `<path>` itself — the same cwd rule F4 uses
   for its own removal (`idd-merge.instructions.md`), since a shell
   inside `<path>` becomes invalid the moment it's removed (PR
   `#3354` review, Copilot). Check for an in-progress rebase, merge,
   cherry-pick, or bisect using git state, not a literal `.git/...`
   path — `.git` at a linked worktree's root is a file, not a
   directory, so a hardcoded path check silently never matches: `git
   -C <path> rev-parse -q --verify MERGE_HEAD` (merge), `test -d
   "$(git -C <path> rev-parse --git-path rebase-merge)"` or
   `rebase-apply` (rebase), `git -C <path> rev-parse -q --verify
   CHERRY_PICK_HEAD` (cherry-pick), or `test -f "$(git -C <path>
   rev-parse --git-path BISECT_LOG)"` (bisect) — `rev-parse
   --git-path` alone only prints the path, the same reason the rebase
   check above already wraps its own `--git-path` result in `test -d`
   (PR `#3354` review, Copilot). Any match means back up the
   pre-operation branch tip before continuing — this recovery
   abandons the interrupted operation itself rather than resuming it.

   Inspect `<path>` the way F4's own removal step already does, not
   just its superproject status — a submodule's own uncommitted or
   unpushed work is otherwise invisible here
   (`idd-merge.instructions.md`; PR `#3354` review, Copilot):

   - `git -C <path> status --porcelain --ignored --untracked-files=normal`
   - `git -C <path> log @{u}..HEAD` (or all commits when there is no
     upstream) for this worktree's own unpushed commits (PR `#3354`
     review, Copilot)
   - `git -C <path> submodule status --recursive`
   - `git -C <path> submodule foreach --recursive 'git status
     --porcelain --ignored --untracked-files=normal; git stash list;
     git rev-list --all --not --remotes --count'`

   Let `<tag>` be `idd-lwr <claim-id>`, or `idd-lwr legacy` when step 1
   found no lock (the legacy pre-claim-id release case has no
   `<claim-id>` to tag with). Record the pre-step count of `git -C
   <path> stash list` entries already carrying `<tag>` (normally `0`,
   but a stale one can survive an earlier interrupted attempt at this
   same recovery) as the baseline (PR `#3354` review, Copilot). When
   the top-level status shows a line not prefixed `!!` (a tracked or
   untracked change — `--ignored` always lists ignored paths too, e.g.
   `node_modules/`, so their presence alone is not a signal to stash),
   save it with `git -C <path> stash push --include-untracked -m
   "<tag>"`, and do the same inside every submodule whose own status
   showed a tracked or untracked change — including one `submodule
   status` reports `-` (uninitialized), whose working-tree content
   `submodule foreach` never visits, so inspect and preserve it
   directly with the same top-level commands scoped to its own path
   (PR `#3354` review, Copilot). The tag distinguishes this recovery's
   own entries from a sibling worktree's (`stash` is repository-wide),
   and the baseline count distinguishes a fresh success from a stale
   leftover on a retried attempt. Stash entries live in the shared
   repository, not the worktree's own private admin directory, so
   they survive step 4's removal. If `stash push` instead fails on
   unmerged paths the backed-up operation left behind, fail closed:
   copy the conflicted files out to a path outside `<path>` —
   mirroring F4's own "copy other work to a different ref or path"
   rule — rather than treating the branch-tip backup alone as
   sufficient preservation (PR `#3354` review, Copilot). Preserve
   unpushed commits — this worktree's own and every submodule's — on
   a backup ref (`git -C <path> update-ref refs/idd-lwr/<branch>
   HEAD`, or the same scoped to a submodule's own path) or a bundle,
   instead of pushing them to the issue branch (PR `#3354` review,
   Copilot). `--include-untracked` does not stash ignored files, so
   copy those out separately too: secrets (e.g. `.env`) — never
   commit or push them — and any other non-reproducible ignored data.
   A worktree (and every submodule) with no tracked or untracked
   change has nothing to stash: `stash push` reports no local changes
   to save and creates no new entry, so step 4 skips the stash check
   for it.
4. **Remove.** Immediately before removing anything — not step 1's
   earlier read — re-run its confirm-the-block check
   (`resume-claim-routing.mjs --issue <n>` and the `claim-lock` check
   form). Stop if the result no longer matches: a live session
   resumed the claim, a different claim-id now holds the lock, or the
   branch no longer reports `local_worktree_occupied` — the situation
   changed since step 1, and `idd-merge.instructions.md`'s own F4
   worktree-removal step revalidates the claim and lock before every
   removal for the same reason (PR `#3354` review, Copilot). Then
   confirm each step 3 action actually succeeded — the `<tag>` entry
   count in `git -C <path> stash list` (and each submodule's) rose by
   exactly one past the baseline only where step 3 found a change to
   stash, any unmerged-path fallback copy landed outside `<path>`,
   `git -C <path> rev-parse --verify refs/idd-lwr/<branch>` resolves
   (or the submodule-scoped equivalent) only where step 3 found
   unpushed commits to back up, and any copied-out ignored files
   landed outside the worktree — before removing anything. Stop and do
   not run `git worktree remove`, `--force` included, if any of them
   failed (PR `#3354` review, Copilot).

   If `<path>` is the primary worktree — the path the first `worktree`
   line of `git worktree list --porcelain` reports, distinct from
   every subsequent linked-worktree stanza — `git worktree remove`
   cannot remove it, and its admin directory is shared by every
   concurrent session in the same clone and is never cleaned up by
   removal (`src/scripts/claim-lock.mts`'s own documented scope; PR
   `#3354` review, Copilot). This is typically the anti-pattern §W7
   warns against (checking out the issue branch directly in the
   primary worktree instead of adding a linked one): run `git -C
   <path> checkout {development-branch}` there instead to
   release the branch — re-resolve `{development-branch}` per §CSA's
   note above if this file is entered without a fresh B1 pass — then
   confirm `resume-claim-routing.mjs` now reports this branch's
   `evidence.local_worktree.status` as `absent` before continuing to
   step 5. Behind the
   [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock),
   re-run the `claim-lock` check form on the primary worktree
   immediately before acting — not step 1's earlier read or this
   step's own opening re-check above, both now stale against a
   concurrent session that could have acquired or replaced this
   shared admin directory's lock in between (PR `#3354` review,
   Copilot). If that fresh check still matches this primary
   worktree's lock to the claim-id being recovered, remove that one
   file now that the checkout released the branch (`rm
   "$(git -C <path> rev-parse --absolute-git-dir)/idd-claim.lock"`) —
   the same deletion `git worktree remove` performs for a linked
   worktree, done by hand here since removal itself isn't possible.
   Otherwise stop; a different or now-absent holder means the
   situation changed again. Leave the generated-tokens record: it is
   keyed per claim-id, not per branch, and `claim-lock.mts` already
   documents it as never expected to be cleaned up.

   Otherwise, behind the
   [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock)
   — as F4's own step 5 (`idd-merge.instructions.md`) — run `git
   worktree remove <path>`, then `git worktree prune`. If it fails
   with `fatal: working trees containing submodules cannot be moved or
   removed`, retry `git worktree remove --force <path>` after
   confirming step 3's preservation already succeeded — the only case
   `--force` is warranted here, mirroring F4's own retry rule. This
   also deletes that worktree's claim lock and generated-tokens
   record, since both live in its own private git-admin directory.
5. **Re-enter.** Re-run Resume from Step 0. A now-`absent` worktree
   lets a stale claim take the normal stale-takeover path through A5,
   and a released claim take a fresh A5 claim. Route any preserved
   commits through §CSA.

**Wake condition.** Every stop on `local_worktree_occupied` (Resume
Step 1, `idd-resume-stall.instructions.md` S3/S4, the lite equivalents,
and Claim pre-check (e)) records this in the session's own stop report
or log — never as an issue/PR comment on a non-owned claim:

- the branch;
- the worktree path(s);
- the probe status (`occupied`/`unreadable`/`unknown`);
- the blocking claim-id and its latest valid `claimed-by` time, or
  `none` for a legacy pre-claim-id release (`docs/idd-helper-scripts.md`);
- the checkable invariant: `resume-claim-routing` reports
  `evidence.local_worktree.status: absent` for this branch (after this
  section's steps), or a newer valid heartbeat for the blocking
  claim-id appears. Either observation only means re-enter Resume
  Step 0 (step 5); a fresh heartbeat lands on the active non-stale
  claim stop there, never on a takeover.
