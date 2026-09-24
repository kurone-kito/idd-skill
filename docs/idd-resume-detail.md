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

## §MC — F4 Cleanup Routing for a Merged or Closed Issue

Applies to Step 1's merged-PR and closed-issue rows in
`idd-resume.instructions.md` (kurone-kito/idd-skill#3319; preventive, no
observed incident yet — a resuming session finding the PR merged while the
prior worker was still running F4 could otherwise remove that worker's
live worktree).

**Ownership condition.** The owned row (active claim = this session's
verified `{claim-id}`) runs the full `idd-merge.instructions.md` F4
contract (steps 4-7, plus step 1 when `{development-branch}` is not the
default branch and a closing-set issue is still open) because this session
can satisfy F4's own claim-revalidation gate at each mutation. This is also
what makes F4's own `primary-worktree-dirty` hold's "resume: ... then
re-run from this step through step 7" instruction reachable from Resume for
the first time — previously nothing routed a resuming session back into F4
at all. The unowned row (no active claim, or only a released one) runs
local-only steps: F4 step 4 (fast-forward `{development-branch}`) and step
5's `git branch -d` bullet. It skips step 5's `git worktree remove`
(nothing local to remove — see the worktree condition below), step 6
(remote branch deletion needs the same authority as a held claim), and step
7 (its revalidation gate stops on any claim that is not this session's,
including none). On this row, step 4's own `primary-worktree-dirty` guard
still applies, but degrades to a plain hold comment rather than F4's usual
Hold / suspend: there is no held claim on this row to suspend.

**Worktree condition.** "No local worktree matches `{branch}`" means
`git worktree list` reports no entry for that branch at all — a plain
absence check, not the A5(e) collision scan's occupied/unreadable/absent
classification. A worktree that does exist for `{branch}` while the claim
is unowned falls to the catch-all row instead: without a held claim to
revalidate against, this session cannot tell whether that worktree is
safely idle or another session's live workspace, so it holds rather than
guesses.

**Closed-with-no-PR and catch-all rows.** Closing an issue without a
merging PR leaves nothing for F4 to reconcile, so this row holds instead.
The catch-all row covers every other closed/merged combination (a live
competing claim, an unverified worktree state, forced-handoff evidence
naming this session as displaced) the same way: each needs a human or a
future resume pass with better evidence, never a mechanical removal.

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
