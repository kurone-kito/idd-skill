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
`forcedHandoff.mode: human-gated` in the working directory's copy of
`.github/idd/config.json`, which Resume reads. A handoff to a successor is
posted only when the copies the pre-flight reads record it too. With a PR open,
those are the PR base branch and the claim branch. With no PR, they are the
default branch and the claim branch once it exists on the remote. F2 reads the
base copy at merge. Valid trusted evidence must also exist for the selected
issue. The `release` keyword posts an `unclaimed-by` marker without that
pre-flight, but it still needs `human-gated` in the working directory's copy.
The copies and the recovery sequence are described in
[customization](customization.md#forced-handoff-copies-and-recovery). Collect
evidence under the contract in `docs/customization.md`: record the approving
human, old claim ID, branch, linked PR (if any), and evidence URL.

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
- An open PR exists and the approval text does not name that PR (an issue-only
  approval is insufficient for PR-scoped recovery unless the helper confirms it
  predates the first commit of every open PR that backs the claim, the earliest
  one when several do, kurone-kito/idd-skill#3871).
- The evidence `{claim-id}`, branch, or linked PR (when it names one) does not
  match the live active claim or inheritable released branch/PR state — stop and
  report the mismatch; do not claim, push, or mutate review state.
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

**Successor whose clone still holds the predecessor's worktree** — Step 1
of `idd-resume.instructions.md` maps `owner_evidence_required` (reason
`claim-id-match-without-independent-owner-evidence`) to "retry once with
`--worktree`, else stop". For a forced-handoff successor whose clone still
holds the predecessor's worktree `W` for the claimed branch, that stop
persists on every retry: the handoff marker made this session's
`new-claim-id` the active claim, but `W`'s `idd-claim.lock` still names the
displaced claim-id and `W` holds no generated-claim record for the new one.
The stop at `kurone-kito/idd-skill#3597` (2026-09-30) is the observed
instance. Every other `owner_evidence_required` case keeps "stop", except
an `unreadable` occupancy probe caused by an unrelated record, which §LWR's
paragraph on an unrelated worktree record covers. §LWR's steps 1-5 apply to
none of them: they recover a stale or released claim's occupied worktree,
not a live forced-handoff claim. Apply the recipe below only when all of
these hold:

- A routing call that passed this session's `--claim-id` and `--worktree W`
  returned `owner_evidence_required`, and
  `evidence.forced_handoff.new_claim_id` equals this session's claim-id while
  `old_claim_id` does not (the four-flag call below adds `--nonce` and
  `--fresh-claim-gate` once the nonce steps are done). Pass
  `evidence.forced_handoff.new_agent_id` as
  `--agent-id` on the `claim-lock` calls below that take it
  (`--record-tokens` and `--acquire`; `--check` and the routing helper take
  none): it usually equals the displaced agent-id, but a marker may name a
  distinct successor id, and a lock or record written under another
  agent-id leaves routing at `owner_evidence_required` (preventive; no
  observed incident yet).
- `evidence.activation_nonce_winner` is non-null and equals this session's
  nonce, after the nonce steps of `idd-claim.instructions.md` (its
  Activation-nonce format and Claim verification sections: post the nonce,
  wait `claim.verifySettleDelay`, confirm the winner, including the label and
  authoring-hold guard it repeats around that step). A nonce marker that
  is not yet visible looks the same as agreement in a bare
  `owner_evidence_required`, so check the winner again immediately before
  the takeover.
- `fresh_claim_gate.verdict` is `already-claimed`,
  `fresh_claim_gate.winning_claim_id` equals this session's claim-id, and
  the top-level `reason` is not a `released-claim-*` reason; the further
  conditions of the takeover authorization in `docs/idd-helper-scripts.md`
  (claim-lock section) apply.
- `W` comes from `git worktree list --porcelain`: exactly one linked
  worktree for the claimed branch, showing `branch refs/heads/<branch>` and
  neither `prunable` nor `locked`. If no record names the claimed branch
  while routing still says `owner_evidence_required` (a worktree left
  mid-rebase by the dead predecessor lists only `detached`), stop.
  `git -C W symbolic-ref --quiet --short HEAD` must print the branch (that
  is the routing check itself), and none of
  `git -C W rev-parse --git-path rebase-merge`, `rebase-apply`,
  `MERGE_HEAD` or `BISECT_START` may name an existing path (they live in the
  worktree's own git directory, not in `W/.git`, which is a file there). A
  worktree left mid-rebase lets the takeover succeed while routing still
  returns `owner_evidence_required` (preventive; no observed incident yet).
  Merge and dirty state do not change routing and are only a safety check:
  the takeover adopts whatever uncommitted or unpushed work the predecessor
  left, so run the content-scope audit (§CSA) before any of it is pushed.
  Otherwise do not run `--takeover`: report to the operator, and retry Step
  1 after `W` has been cleaned up.
- `claim-lock --check --worktree W` shows a holder (`holder.claimId`) equal
  to `old_claim_id`. If it already shows this session's claim-id and
  agent-id (a takeover done earlier), skip the takeover and only record the
  claim identity; if no lock exists (`present` is false), use the normal
  `--acquire`. Any other holder, including this session's claim-id under
  another agent-id, means stop.

The recommended order (it differed between the sessions that hit the stop;
treat it as recommended, not observed): adopt the marker's agent-id and
claim-id; check the lock holder; record the claim identity against `W`; post
this session's own activation nonce, wait, and confirm the winner; run the
four-flag routing call once and read `fresh_claim_gate.verdict` and
`winning_claim_id`; check the lock holder again; take the lock over; re-run
routing. Run every
`claim-lock` call with `W` as the current directory and with `--worktree W`
(every mode accepts it, and the cwd rule in `docs/idd-helper-scripts.md`
applies), through the profile-selected claim-lock command:

1. `--check --worktree W` and require the holder condition above (the
   holder is `old_claim_id`, this session's own claim-id and agent-id, or
   no lock exists); only then `--record-tokens --worktree W --agent-id
   <new_agent_id> --claim-id <new_claim_id> --nonce <nonce>`. That call
   overwrites the record keyed by the claim-id without a holder check, so
   run before the check it would replace another session's token record.
   The target is `W`, not the primary checkout that
   `idd-claim.instructions.md` names for a fresh claim: recording in the
   primary lets the takeover succeed while routing still returns
   `owner_evidence_required` (preventive; no observed incident yet).
2. Post the nonce, wait, and confirm the winner, then run the routing call.
3. `--check --worktree W` again and branch on the result. A holder equal
   to `old_claim_id`: `--acquire --takeover --worktree W --agent-id
   <new_agent_id> --claim-id <new_claim_id>`, then confirm the output's
   `holder.claimId` equals `old_claim_id`. This session's own claim-id and
   agent-id: skip the takeover. No lock (`present` is false): the normal
   `--acquire` with the same flags, no `--takeover`. Any other holder:
   stop. A displaced predecessor that is somehow still running is
   displaced by definition.
4. Re-run the routing call and expect `already_owned`. If it still returns
   `owner_evidence_required` with `occupancy_probe` `unreadable`, §LWR's
   paragraph on an unrelated worktree record applies.

The trust basis is the human-gated forced-handoff marker, the nonce winner,
and the `--check` run immediately before the takeover. `resume-claim-routing`
and `claim-lock` keep their fail-closed behavior; nothing here changes them.

**Content-scope audit** — Once the successor's post-handoff routing
(Step 2 in `idd-resume.instructions.md`) lands it on §W7 or §W8 with
inherited commits on `{branch}`, run the content-scope audit described
in §CSA before those commits are pushed or bundled into a PR. The
displaced session is by definition unreachable, so its own planning
comment can never substitute for this independent check.

**Inherited plan comment** — The displaced session may also have posted a B2
plan. Where it left no commits, §CSA's committed range is empty, but the
dirty-state note in the recipe above still covers any uncommitted work;
where it left commits, §CSA covers them but not the plan.
`idd-work.instructions.md`'s B3 self-check accepts only the refined,
post-critique plan, and a successor cannot verify that the predecessor's
critique pass ran. On the no-PR route that enters B3 (a dirty worktree) the
successor therefore treats the inherited comment as an unverified draft: it
re-verifies the plan against the issue and the code, runs its own critique
pass, posts a refined plan before entering B3, and adds the refined plan
comment, never the inherited draft, to `Authoritative by` alongside the
evidence §FH and Step 2 require. It never relies on the predecessor's
critique having run. The same holds after an ordinary stale takeover. The
no-PR rows that route to B2 draft their own plan anyway. The routes that
skip both B2 and B3 (a clean worktree with unpushed commits and §W8 with
unpushed commits go to D1, and §W7 resumes from C1) have no B3 self-check
to satisfy, so the successor does not rely on the inherited plan there.
Reported 2026-09-30 in `kurone-kito/dotfiles`
(the round for issue `dotfiles#530`): the successor did this as a judgment
call. Its two failure modes are building on an unreviewed draft and redoing
reviewed work (preventive; no observed incident yet).

## §MC — F4 Cleanup Routing for a Merged or Closed Issue

Applies to Step 1's merged-PR and closed-issue rows in
`idd-resume.instructions.md` (kurone-kito/idd-skill#3319; preventive, no
observed incident yet — a resuming session finding the PR merged while the
prior worker was still running F4 could otherwise remove that worker's
live worktree).

**Displaced-session safety.** The owned row's "claim = this session's
verified `{claim-id}`" condition means a **freshly re-parsed** active
claim per the shared claim-state rules
(`idd-claim.instructions.md`), including rule 7's forced-handoff
transfer: once a valid forced-handoff marker names this session's claim
displaced, the active claim becomes the successor's pair, so the owned
row no longer matches for this session at all — this is the same
"verified" every other claim-matching row in Step 1 already relies on,
not a new exposure. The "FH evidence names this session's
already-verified `{claim-id}`" row — positioned right after the owned and
unowned rows, before the catch-all row — is the explicit backstop against
a stale evaluation, since it checks this session's own recorded
`{claim-id}` against FH evidence directly rather than against whatever
the active claim currently is; it must run before the catch-all so a
displaced session stops silently per §FH's no-mutation rule instead of
reaching the catch-all's hold comment.

**Development-branch resolution.** Both rows resolve `{development-branch}`
the same way B1's Worktree creation Step 2 does — re-resolve it here if
entered directly (for example, on resume) without a fresh B1 pass, the same
caveat this document's §CSA section and `idd-pr-submit.instructions.md`'s
D1 use for the same variable.

**Sanctioned direct F4 entry.** The opening entry condition in
[`idd-merge.instructions.md`](../.github/instructions/idd-merge.instructions.md)
describes the common F3-first path, where merge-handoff's job is deciding
whether _this_ session may execute the merge under the repository's
recorded policy (`fully_autonomous_merge` / `human_merge` /
`separate_merge_agent`). Both rows here enter F4 directly, never F3, and
only once the PR is already merged — the decision merge-handoff exists to
make is already resolved by then, so there is nothing left for it to route.
This is the sanctioned exception these two rows establish, not a bypass of
a still-open decision.

**Ownership condition.** The owned row (active claim = this session's
verified `{claim-id}`) runs the full `idd-merge.instructions.md` F4
contract (steps 2-7, plus step 1 when `{development-branch}` is not the
default branch and a closing-set issue is still open) because this session
can satisfy F4's own claim-revalidation gate at each mutation. When this
route includes step 1, revalidate immediately before each closing-set
`gh issue close` as well (PR `#3741` review comment `#4174332509`). This
includes step 3's merged-PR comment cleanup, which must not be skipped on
resume (PR `#3741`'s current-head Copilot overview, review
`#5401871731`). On this row,
`{branch}` is the active claim's own `branch:` field — the same binding
Step 2 uses, available here without waiting for Step 2 because the claim
is already verified. This is also
what makes F4's own `primary-worktree-dirty` hold's resume instruction
(re-run step 4 through step 7 once the hold clears) reachable from Resume
for the first time — previously nothing routed a resuming session back
into F4 at all. The unowned row applies only when **no claim is currently active**
and the issue's most recent claim was released (never a claim that was
never made — see below); a live competing claim (even mid-F4 itself) still
falls to the catch-all row, not this one. It binds `{branch}` to that
released claim's own branch, since Step 2's usual binding rule (`{branch}`
= the verified _active_ claim's branch) has nothing to bind to on this
row. It runs
local-only steps: F4 step 4 (fast-forward `{development-branch}`) and step
5's `git branch -d` bullet. It skips step 5's `git worktree remove`
(nothing local to remove — see the worktree condition below), step 6
(remote branch deletion needs the same authority as a held claim), and step
7 (its revalidation gate stops on any claim that is not this session's,
including none). On this row, step 4's own `primary-worktree-dirty` guard
still applies, but degrades to a plain hold comment rather than F4's usual
Hold / suspend: there is no held claim on this row to suspend. All three
of F4's newer holds (kurone-kito/idd-skill#3327) —
`development-branch-in-use`, `development-branch-diverged` (both step 4),
and `local-branch-unmerged-commits` (step 5) — degrade the same way: each
assumes the owned row's held claim and later steps (naming that claim,
"keep claim", "stop before step 7"), none of which this row has. Post a
plain hold comment describing the branch/worktree state instead and stop;
do not treat any of their wording as an instruction to claim the issue.
A merged PR
whose issue was **never claimed at all** has no released-claim branch to
bind and nothing local to clean up — it falls to the catch-all row below,
not this one.

**Worktree condition.** "No local worktree matches `{branch}`" means
`git worktree list` reports no entry for that branch at all — a plain
absence check, not the A5(e) collision scan's occupied/unreadable/absent
classification. A worktree that does exist for `{branch}` while the claim
is released falls to the catch-all row instead: without a held claim to
revalidate against, this session cannot tell whether that worktree is
safely idle or another session's live workspace, so it holds rather than
guesses.

**Closed-with-no-PR and catch-all rows.** Closing an issue without a
merging PR leaves nothing for F4 to reconcile, so this row holds instead.
The catch-all row covers every other closed/merged combination (a live
competing claim, an unverified worktree state, forced-handoff evidence
naming this session as displaced, or a merged PR whose issue was never
claimed at all) the same way: each needs a human or a future resume pass
with better evidence, never a mechanical removal.

## F4 Head Proof

F4's final PR-digest check may run after PR comments and branch refs have
been removed. Keep the review watermark, local cleanup tip, and verified
merged-PR SHA pair on the claimed issue so a fresh session can repeat the
check after a hold (PR `#3741` review comments `#4173683166`,
`#4173965043`, `#4173965808`, `#4173965831`, `#4174056090`,
`#4174056093`, `#4174056098`, `#4174056101`, `#4174123484`, and
`#4174335516`; preventive, no observed incident yet).

Observed 2026-10-11 to 2026-10-12 (issue `#4064`): the cleanups for issues
`#4034`, `#4009`, and `#3944` (PRs `#4040`, `#4041`, and `#4056`) ran with
no persisted proof. The live cleanup checks did not replace the persisted
proof this section requires. The marker command,
`post-idd-marker --type f4-head-proof`, runs the checks below and posts only
on a `post` verdict (see
[the marker contract](idd-helper-scripts.md#f4-head-proof-marker-contract)).

Before F4 step 3, revalidate the claim and local lock, then read the
claimed issue's comments before inspecting the local branch. First look
for a reusable, valid proof for the active claim and PR; it restores both
stored SHAs without requiring the branch ref to exist. If the ref exists,
require its tip to equal the stored branch tip; if absent, continue only
through the resume-safe cleanup guards below. If no reusable proof exists,
take `{f2-head-SHA}` from the E1 `review-watermark` that F2 validated (on
a fresh resume, restore the latest valid same-claim `review-watermark`
from the PR comments). This is the review-snapshot marker, not a separate
F2 watermark format. Apply the shared trusted-marker policy below; if no
such watermark can be authenticated, hold before cleanup. Bind
`{branch-name}` to the exact trusted active-claim record; after a
takeover or recovery, use only the verified successor's active-claim
record. Retain that record as JSON data and extract `.branch` into
`BRANCH_NAME` with `jq -er '.branch'`. Require it to match the row's
verified claim branch, then validate it before use:

```sh
BRANCH_NAME=$(printf '%s' "$VERIFIED_CLAIM_JSON" | jq -er '.branch')
if ! git check-ref-format "refs/heads/$BRANCH_NAME"; then
  # Hold and stop F4.
  exit 1
fi
```

Never paste a recovered branch name into shell source; quote every shell
argument that receives it (PR `#3741` CodeRabbit review comment
`#4174140996`). Capture the branch tip with
`git rev-parse --verify "refs/heads/$BRANCH_NAME"` as
`{branch-tip-SHA}`.
Require each to be a full 40-hex value and keep the values separate: the
F2 watermark identifies the reviewed snapshot, while `{branch-tip-SHA}`
binds local-branch cleanup. Do not require either to equal the merged PR
head. A contributor can advance the PR after F2 while the local branch
remains at an older tip (PR `#3741` review comment `#4174335516`). Derive
the merged PR head independently from the live PR and merge commit before
step 3. Persist this proof on the claimed issue before step 3, once that
validation succeeds, including the verified merge commit and resulting
`PR_HEAD_SHA_F3`; hold before posting or cleanup on a malformed merge
commit, conflicting proof, or read failure. This prevents a stale F2
snapshot from becoming proof for a different merged head (PR `#3741`
review comment `#4174123484`).

```text
<!-- idd-f4-head-proof: v2 pr={pr-number} claim={claim-id} branch={branch-name} f2={f2-head-SHA} branch-tip={branch-tip-SHA} merge={merge-commit-SHA} head={pr-head-SHA} -->
```

Read issue comments with:

```sh
gh api --paginate \
  "repos/{owner}/{repo}/issues/{issue-number}/comments"
```

Ignore comments from untrusted authors. Resolve author trust using the
shared [trusted marker actor policy](../.github/instructions/idd-overview-core.instructions.md#trusted-marker-actors),
including live Write/Maintain/Admin collaborator permission when
`markerTrust.allowCollaboratorMarkers` is enabled; the configured list
alone is not the complete policy. A reusable proof must match the active
claim ID, PR number, branch, and all four SHAs. Its `created_at` must not
precede the initial trusted claim activation for this claim ID and branch
(not a later heartbeat of the same claim), and `updated_at` must equal
`created_at`. Identical duplicate markers carry the same proof. A trusted
marker for this claim with conflicting values, malformed fields, or any
edit is ambiguous and holds F4, unless a superseding proof sets it aside
(below). Do not treat an untrusted marker as a conflict or as proof.

**Superseding a malformed proof.** A corrected proof may carry one optional
field, `supersedes=<comment-id>`, after `head=` and before `-->`. Its value
is the comment ID of the malformed trusted proof that the corrected proof
replaces. Post the corrected proof with the `--supersedes` flag of the
`post-idd-marker` helper (`--type f4-head-proof`, in the profile-selected
form), and never delete or edit the malformed comment: the corrected proof
is the correction. Only a parse-malformed trusted proof of this claim is set
aside, and only when a well-formed, unedited, trusted proof of this claim
names its comment ID and that proof is itself reusable under the rules above.
Set-aside comments are reported in the helper's `warnings`, and F4 does not
hold on them. A malformed proof with no such superseding proof still holds
F4, and an edited proof that still parses is never set aside. The helper
refuses `--supersedes` for any comment that is not a malformed proof of this
claim that can be superseded, and it holds when other trusted proofs of this
claim remain.

If no trusted marker exists, revalidate the claim and local lock before
posting. First run the REST and commit-object validation below and set
`MERGE_COMMIT_SHA` and `PR_HEAD_SHA_F3`; the marker records those verified
values as well as the F2 watermark and local branch tip. The comment body
must start with the marker token and include a visible note after it;
`gh issue comment` and `gh api -f body=` silently
reject HTML-only operational markers (PR `#3741` review comment
`#4173965040`). The marker command renders and posts this body, so no
session posts it by hand. The block below only shows the rendered body; do
not run it:

```sh
F4_MARKER_TOKEN=$(printf \
  '<!-- idd-f4-head-proof: v2 pr=%s claim=%s branch=%s f2=%s branch-tip=%s merge=%s head=%s -->' \
  "$PR_NUMBER" "$CLAIM_ID" "$BRANCH_NAME" "$F2_HEAD_SHA" \
  "$BRANCH_TIP_SHA" "$MERGE_COMMIT_SHA" "$PR_HEAD_SHA_F3")
F4_MARKER_BODY=$(printf '%s\n\n_%s: F4 head-proof marker. Do not edit._' \
  "$F4_MARKER_TOKEN" "$AGENT_ID")
jq -n --arg body "$F4_MARKER_BODY" '{body: $body}' | \
  gh api --method POST \
    'repos/{owner}/{repo}/issues/{issue-number}/comments' --input -
```

Fetch the comments again and confirm the exact body, trusted author,
`created_at`, and `updated_at` before continuing. If the write response
is ambiguous, reconcile by reading comments; never post another marker
blindly. The write may still have landed, so re-read the issue comments
three times, and accept the proof only when all three re-reads show the
same reusable marker. A failed, absent, or conflicting re-read holds before
cleanup. `decideAfterPost` in `f4-head-proof-verdict.mts` owns this rule, and
the marker command applies it (preventive; no observed incident yet). A
confirmed write needs one re-fetch that matches the posted marker; a mismatch
holds with `posted-disagreed`. A missing or inconclusive proof holds before
cleanup. The proof
is an issue comment, so merged-PR cleanup cannot remove it; retain it
through claim release.

Immediately before step 3, revalidate the claim and repeat the live
merged-PR check from step 7. With a newly posted proof, require the same
merge commit and PR head observed before posting; with a reused proof,
require both values to match the marker's `merge` and `head` fields. Keep
the marker's F2 watermark and local branch-tip values separate from the
merged-PR head. Hold before cleanup if the proof or live PR changed. Step
7 repeats the validation after cleanup to catch a later race.

Before worktree removal, revalidate the claim and compare the path with
`git worktree list --porcelain`. If the path and registration disagree,
hold as an inconsistent worktree state. If both are absent, skip
inspection/removal; the local branch may also be absent, and if it still
exists its tip must equal `{branch-tip-SHA}`. If both are present, require
the local branch to exist and its tip to equal `{branch-tip-SHA}`, then
run the normal safety inspection. The removal helper, not the session,
owns local-branch deletion: it runs
`git branch -d -- "$BRANCH_NAME"` only when the branch exists, and absence
is already complete. Keep
the existing unmerged-branch hold path.

The removal helper, `node scripts/f4-worktree-branch-cleanup.mjs` (see
[helper steps](idd-helper-scripts.md#f4-worktree-and-branch-cleanup-steps-4-to-6)),
runs these checks and gates each removal on the proof. When the complete
ignored-inclusive status output is exactly `!! node_modules/`, the path is a
real directory, and no registered worktree is at or inside it, the helper
moves its files intact under
`<state>/idd-skill/f4-preserved/<issue>-<UTC timestamp>/` before removal.
`<state>` is an absolute `XDG_STATE_HOME`, else `~/.local/state`; on Windows it
is an absolute `LOCALAPPDATA`, else `~/AppData/Local`. The helper reports the
destination and never deletes or expires a preserved tree; the operator
decides when to clean it up. It requires an owned state root and private
destination directories. On POSIX, the source `node_modules` directory must be
owned by the current user; an owned direct state root and existing destination
directories are restricted to mode `0700` during apply, and a state-root
symlink must already target a private directory. On Windows, the state root,
source, and destination directories must have a private ACL before the move.
New parents and the moved `node_modules` directory are private. The rename goes
directly to an absent destination leaf. A dry run performs the same read-only
checks and reports the planned destination without creating, moving, or
changing permissions. Observed
2026-10-18 on issue `#4511` (PR `#4527`), an install-created `node_modules/`
alone held F4 cleanup.

The helper records destination parent identities, checks them through parent
creation and immediately before preservation, and uses the resolved state-root
path. A detected replacement holds. These path checks and renames are separate
operations; the final ignored-inclusive status scan and `git worktree remove`
are separate too. Content written after that scan can still be deleted by Git,
and a path replacement after a check can evade that check. Stop dependency
processes, watchers, and other writers before cleanup. These are residual races,
not a guarantee of atomic preservation (PR `#4606`, review comments
`#4338910285` and `#4338910384`; preventive, no observed data loss).

Every other dirty shape still holds as `dirty-worktree`, as do an unsafe
destination or failed move; when the detail says the helper did not move
`node_modules/`, preserve it by hand before rerunning. A populated submodule
still holds as `submodule-worktree`. Move other untracked and ignored files,
including reproducible output, and secrets such as `.env`, to a verified path
outside the repository; never commit or push them. Save uncommitted tracked
edits as a patch outside the repository, then revert those paths. A backup ref
holds commits only, so it does not clear the check. Make the helper's own
`git status` check print nothing, then rerun. For a populated submodule, the
operator runs `git -C <issue-worktree-path> submodule deinit --all` after
preservation, with the worktree still registered, and then the helper is
rerun. A forced removal is not an F4 route: it unregisters the path, so the
proof dry run and this helper cannot finish afterward. The F4 session never
runs `git worktree remove --force`.

For step 6, use the profile-selected `delete-remote-branch` helper with
`BRANCH_NAME` and the verified `PR_HEAD_SHA_F3`. The removal helper makes
this call in its apply run. If it does not complete after step 5 and
delete_branch_on_merge is false, the operator runs it by hand, and the session
never runs it. Its default dry-run
must report `would-delete` with the expected SHA, or `already-absent`;
run the same command with `--apply` only for `would-delete`. The helper
checks the live remote ref and default branch, uses an argument-vector
`--force-with-lease` compare-and-delete, and confirms absence. Continue
only for `deleted` or `already-absent`; any mismatch, default-branch
refusal, failed mutation, or inconclusive confirmation holds F4. For
reference only, the underlying vendored-node form is:

```sh
node scripts/delete-remote-branch.mjs \
  --branch "$BRANCH_NAME" --expected-sha "$PR_HEAD_SHA_F3"
node scripts/delete-remote-branch.mjs \
  --branch "$BRANCH_NAME" --expected-sha "$PR_HEAD_SHA_F3" --apply
```

Use the helper runtime manifest's canonical command form for
package-manager, ephemeral-npx, or user-global. If helper runtime is
unavailable, hold and ask an authorized operator to perform the atomic
deletion; do not
wrap, quote, or otherwise disguise a command that the active tool policy
denies. This keeps compare-and-delete available through the explicitly
permitted helper surface (PR `#3741` Codex review comment
`#4174479403`). The helper's SHA lease closes the race where a push could
advance the remote branch after the tip check (PR `#3741` CodeRabbit
review comment `#4174140998`); comparing against the verified merged
head permits a stale local branch tip while still holding if the remote
has moved past the merged PR head (PR `#3741` review comment
`#4174335516`). The initial SHA check also prevents deleting commits
added after the proof (PR `#3741` review comment `#4174056101`).

Before persisting proof, immediately before step 3, and after cleanup in
step 7, read the merged PR and its merge commit through GitHub's REST API.
For a new proof, do the first read now, before constructing the marker;
for a reused proof, require the derived merge/head pair to equal the
marker's `merge` and `head` values on each read.
Set `PR_NUMBER` from the matched PR, and set `CLAIM_ID`, `F2_HEAD_SHA`,
`BRANCH_NAME`, `BRANCH_TIP_SHA`, and `AGENT_ID` from the already validated
F4 context. Keep recovered values in quoted shell variables.

```sh
PR_DATA=$(gh api "repos/{owner}/{repo}/pulls/$PR_NUMBER")
if ! printf '%s' "$PR_DATA" | jq -e '
  .state == "closed" and .merged == true and
  (.merge_commit_sha | test("^[0-9a-f]{40}$")) and
  (.head.sha | test("^[0-9a-f]{40}$"))
' >/dev/null; then
  # Post a hold, keep the claim, and stop F4.
  exit 1
fi
MERGE_COMMIT_SHA=$(printf '%s' "$PR_DATA" | jq -r '.merge_commit_sha')
PR_HEAD_SHA_LIVE=$(printf '%s' "$PR_DATA" | jq -r '.head.sha')
MERGE_COMMIT_DATA=$(gh api \
  "repos/{owner}/{repo}/git/commits/$MERGE_COMMIT_SHA")
```

Do not interpolate `MERGE_COMMIT_SHA` into the commit endpoint until the
PR state and both SHAs pass the guard above. Each API read must succeed.
Require the commit object's `.sha` to equal `merge_commit_sha`, and
require exactly one or two parent objects with full 40-hex SHAs; hold on
any read or shape failure.
The REST pull-request endpoint defines `merge_commit_sha` for merge,
squash, and rebase methods (for rebase it is the commit at which the base
branch was updated; see [GitHub's pull request REST API](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)).
For a two-parent merge, set `PR_HEAD_SHA_F3` to parent 2 and require it
to equal `PR_HEAD_SHA_LIVE`. For a one-parent merge (squash or rebase),
set `PR_HEAD_SHA_F3` to `PR_HEAD_SHA_LIVE`; the PR's `merged` status and
`.head.sha` bind the original PR head for these methods, so do not infer
that head from the resulting commit's parent. Neither path requires the
merged head to equal the F2 watermark or local branch tip. When reusing a
proof, require the live merge SHA and `PR_HEAD_SHA_F3` to match its
`merge` and `head` fields; before cleanup, a newly posted proof requires
the same pair observed before posting. After cleanup, step 7 rereads the
trusted issue marker and repeats this API validation before repairing the
PR digest. The local branch ref is checked against `branch-tip-SHA`;
the PR digest remains display state, never proof.

### Cleanup helper hold codes

`scripts/f4-worktree-branch-cleanup.mjs` (kurone-kito/idd-skill#4370) runs steps
4 to 6 only after this proof gives `proceed` . It reads the proof with the
marker command's dry run and never posts one. Each hold prints its reason code
and the next action below. The codes for steps 4 to 6 are in
`docs/idd-helper-scripts.md` .

| Reason                      | Next action                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claim-lost`                | Stop. The claim is not this session, or it could not be confirmed. Take no further mutation and report the handoff. Do not unclaim.                                                                                                                                                                                                                                                                                                                                              |
| `owner-evidence-required`   | Stop. The claim ID matches, but the independent owner evidence (the claim lock, the generated tokens, and the branch) does not. Restore the claimed worktree lock, or the operator decides.                                                                                                                                                                                                                                                                                      |
| `proof-missing`             | No trusted proof exists yet. If cleanup had candidates, rerun F4 step 3, whose gate posts the proof. Otherwise run the profile-selected `post-idd-marker --type f4-head-proof` command (form in `idd-helper-scripts.md`) with `--target issue <issue-number>`, `--claim-id <claim-id>`, `--agent-id <agent-id>`, and `--worktree <issue-worktree-path>` as a dry run, then add `--apply` on a `post` verdict, and rerun this helper.                                             |
| `proof-unreadable`          | Hold. The output of the marker dry run could not be read as a verdict. Rerun the dry run and inspect its stderr. Do not proceed.                                                                                                                                                                                                                                                                                                                                                 |
| `proof-worktree-missing`    | Hold. The claimed worktree is no longer registered, so the proof dry run cannot read the proof. This run removed nothing. If step 5 already removed the worktree, the operator completes step 6 by hand with delete-remote-branch and the expected SHA when delete_branch_on_merge is false, and the session continues from step 7 after the operator confirms. Otherwise restore the worktree registration and rerun the removal helper (preventive; no observed incident yet). |
| `claim-or-lock`             | Stop. The claim or its worktree lock is not this session. Take no further mutation and report the handoff.                                                                                                                                                                                                                                                                                                                                                                       |
| `pr-state`                  | Do not post. The merged pull request could not be read or does not agree with itself. Read it again, then rerun this helper.                                                                                                                                                                                                                                                                                                                                                     |
| `ref-read`                  | Do not post. The local branch ref could not be read. Check the repository state, then rerun.                                                                                                                                                                                                                                                                                                                                                                                     |
| `marker-read-failed`        | Do not post. The trusted markers of the issue could not be read. Rerun once the read succeeds.                                                                                                                                                                                                                                                                                                                                                                                   |
| `branch-absent`             | The local branch ref is absent, and no trusted proof can stand without it. The operator checks the branch. Do not recreate it or guess its tip, and report.                                                                                                                                                                                                                                                                                                                      |
| `conflicting-marker`        | Hold. A trusted proof for this claim conflicts with the live state or with another proof. The operator reviews the markers on the claimed issue. Do not post another proof.                                                                                                                                                                                                                                                                                                      |
| `watermark-unauthenticated` | Hold. The review watermark for this claim cannot be authenticated. Rerun F4 step 2 after the review snapshot is recorded again.                                                                                                                                                                                                                                                                                                                                                  |
| `claim-activation-unknown`  | Hold. The activation time of this claim cannot be read. The operator checks the claim record on the issue.                                                                                                                                                                                                                                                                                                                                                                       |

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
  Then go to Step 3.

If no local branch named `{branch}` exists, create from remote (still
from the primary worktree, HEAD-preserving): `git branch {branch}
origin/{branch}`, then create the sibling worktree:
`git worktree add <sibling-worktree-path> {branch}`. Then go to Step 3.

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

Sync `{development-branch}` (D1 rebase) + **pre-push-validate** + push
(D2), then go to Step 3.

## §W6 — PR exists (multiple matches)

Try to match by the claimed/inherited branch name from Step 1. If exactly
one PR matches, treat as "1 match" and use the corresponding §W1–§W5 row.

If zero or still multiple PRs match after the branch filter, re-validate
claim ownership:

- Active claim still uses your current `{claim-id}`: post `unclaimed-by`
  with that `{claim-id}`, report the ambiguity, and abort.
- Claim already lost: report and abort without posting a release.

## §W7 — No PR, remote branch exists

From the primary worktree (HEAD stays on `{default-branch}`):

1. Fetch the remote tip with a fully-qualified destination refspec --
   unlike a bare `git fetch origin {branch}`, this does not depend on
   the clone's configured fetch refspec to refresh
   `refs/remotes/origin/{branch}`:

   ```sh
   git fetch origin +refs/heads/{branch}:refs/remotes/origin/{branch}
   ```

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

Applies wherever §W7 or §W8 resumes work from commit(s) this session
itself did not just author on `{branch}` — including after §FH routes
there via forced-handoff recovery — whether recovering its own crashed
prior turn or taking over from a different, possibly-dead session.
Neither case has a live author left to confirm what was actually
verified, so before any of these commits get pushed or bundled into a
PR, the resuming session must independently audit their content
against the target issue's own declared scope (observed 2026-09-21 on
an adopter repository, reported via kurone-kito/idd-skill#3166: an
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
git fetch origin +refs/heads/{development-branch}:refs/remotes/origin/{development-branch}
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
claim revalidation gate. This applies only while a digest is in use, as the
[live status digest contract](idd-comment-minimization.md#live-status-digest-contract)
defines it; a missing digest alone does not put one in use.

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
section defines that recovery. Step 2 (below) is operator-run, never
automated, and checks no process-liveness signal —
`src/scripts/claim-lock.mts`'s header records why:
this "deliberately excludes any local liveness signal (e.g. process PID)... the
process invoking this CLI is a one-shot child that exits the moment the call
returns, so a recorded PID would be a tombstone before any competing session
could ever observe it as 'alive'".

**Primary path: the `local-worktree-recovery` helper** (kurone-kito/idd-skill#3536)
consolidates steps 1, 3, and 4 below into a single invocation, composed from
the `resume-claim-routing`, `claim-lock`, and `clone-lock` building-block
helpers rather than reimplementing their logic — see
[Local worktree recovery](idd-helper-scripts.md#local-worktree-recovery) for
the full CLI surface and invocation forms per `helperRuntime.profile`. It
never checks step 2 mechanically either: `--operator-confirmed-no-live-session`
is your own explicit attestation for that step, required before any mutation,
regardless of `--apply` or what step 1 finds. Default mode is dry-run (no
mutation); pass `--apply` once you have independently performed step 2 and
reviewed the dry-run's reported plan. The written procedure below remains the
canonical spec this helper's own behavior must match, the authoritative
fallback for an `instructions-only` profile, and the reference for any step
the helper's dry-run output doesn't make self-explanatory.

**An unrelated worktree record.** Resume Step 1 routes only a forced-handoff
successor to §FH, so any other session stops on `owner_evidence_required`
and reports the failed proof; an operator may then apply this paragraph, and
for either trigger below an operator confirms every action. It is the only
part of §LWR that applies to an `owner_evidence_required`
verdict, and it also covers a `local_worktree_occupied` result whose
top-level `reason` ends `-local-worktree-unreadable` when `paths` names a
record that is not the claimed branch's own. Steps 1-5 below recover the
claimed branch's own record. The triggers differ by verdict:

- `owner_evidence_required`: `evidence.owner_evidence.occupancy_probe` is
  `unreadable` (the `warnings[]` line reads `owner evidence required: first
  failed proof is occupancy_probe (unreadable)`) although the proofs before
  it hold, that is `worktree_identity`, `claim_lock_matches`,
  `generated_tokens_match` and `agent_and_branch_match` are all `true`.
- `local_worktree_occupied`: the top-level `reason` ends
  `-local-worktree-unreadable` (the `warnings[]` line reads `cannot verify
  local worktree occupancy for <stale|released> branch <branch>: ...`) and
  `evidence.local_worktree.paths` names a record other than the claimed
  branch's own.

The probe reads every record in `git worktree list --porcelain`, not only
the claimed branch's, and a record it cannot classify makes it fail closed
for any branch. `evidence.local_worktree.paths` names the record to look
at; when it is empty the listing failed or could not be parsed, so read
`evidence.local_worktree.reason` instead. A record the probe could not
resolve to the claimed branch (the shapes below) is never preserved or
removed by steps 1-5. After clearing a record, re-run the routing call
that stopped. For empty `paths`, or a shape not listed below, no bullet
applies: stop and report. Reported 2026-09-30 by the `kurone-kito/dotfiles`
adopter (the round for issues `dotfiles#533` and `dotfiles#534`): about 45
minutes until a peer's scratch worktree record disappeared, on a pin that
predates the fix for issue `kurone-kito/idd-skill#3205` (PR
`kurone-kito/idd-skill#3206`), so that record may have been the plain
detached case that fix covers rather than one of the shapes below. Every
shape below, except an unmounted volume, was replayed on git 2.53.0
against an unrelated branch, and none has an observed incident of its own
(preventive; no observed incident yet):

- A detached record whose directory was removed with `rm -rf` reads
  `unreadable`, and `git worktree list --porcelain` flags it `prunable`.
  git prints that same line for a deleted directory, an unmounted volume,
  a directory moved by hand and a directory whose `.git` file is gone. Act
  only when the operator confirms the directory was deleted and `test ! -e
  <path>` holds; repair a moved worktree with `git worktree repair
  <new-path>`, never remove it. Otherwise stop and report. If both hold, point a
  backup ref at the listing's `HEAD <sha>` (`git update-ref
  refs/idd-lwr/unrelated-<sha> <sha>`) and confirm that `git rev-parse
  --verify refs/idd-lwr/unrelated-<sha>` prints the same `<sha>`; key the
  ref by the commit, because an admin id can be reused and a second
  `update-ref` on the same name silently replaces the first backup. A
  detached tip may be kept only by that record, and removal leaves the
  commit unreferenced, so `git gc` may delete it later. Leave the ref in
  place and report it. Last, run `git worktree remove --force <path>`,
  behind the clone-scoped lock when workers share the clone, as B1 does;
  once the lock is held, re-run the routing call and `test ! -e <path>`,
  and remove only if the same conditions still hold. Do not use a plain
  `git worktree prune` here: it is clone-wide, so it also clears other gone
  detached records before they have a backup ref, and it removes the admin
  directory of a record whose `.git` file is gone.
- The same record, locked, also reads `unreadable` but is not flagged
  `prunable`, and a plain prune leaves it. Read its `locked <reason>` line.
  Unlock it (`git worktree unlock <path>`) only when the operator
  confirms the directory was deleted and `test ! -e <path>` holds. The
  reason is free text written by whoever locked it, so it is evidence for
  that confirmation, not a substitute for it, and a reason such as "on
  removable media" means stop and report. Once unlocked it is an ordinary
  gone record, the previous bullet. `git worktree remove --force` alone
  fails on a locked record and needs `--force` twice, but that bypasses the
  unlock rule; the rule above still decides.
- A foreign detached worktree in the middle of a rebase, a `git am` or a
  bisect reads `unreadable` when that work was started from a detached
  HEAD. A rebase's `head-name` is the literal `detached HEAD`, a `git am`
  has no `head-name` at all, and a bisect's `BISECT_START` is a bare
  commit id, so none of them names a branch. Only its owner clears it, by
  finishing or aborting that work (`git rebase --abort`, `git am --abort`,
  `git bisect reset`), never this session; otherwise stop and report the
  path to the operator.
- A clean detached record, a locked clean detached record, a record on a
  named branch whose directory is gone, a rebase in progress on a named
  branch, and a cherry-pick or merge conflict all read `absent`. They are
  not the cause.

1. **Confirm the block.** Run the profile-selected `resume-claim-routing`
   helper (`docs/idd-helper-scripts.md`; source-repo/vendored-node: `node
   scripts/resume-claim-routing.mjs --issue <n>`); a
   `local_worktree_occupied` result reports
   `evidence.local_worktree.paths` and a top-level `reason`
   starting `stale-claim-...` or `released-claim-...`. Under a reason ending
   `-local-worktree-occupied`, `<path>` is the claimed branch's own record,
   even when `git worktree list --porcelain` shows it `detached` in the
   middle of a rebase or bisect (step 3 handles that). Under a reason
   ending `-local-worktree-unreadable`, go on only through the prunable
   skip-ahead below, which needs a record that shows `branch
   refs/heads/<branch>`, is flagged `prunable`, is unlocked, and whose
   `<path>` is absent on disk; every other `-local-worktree-unreadable`
   result is the unrelated-record paragraph's case and stops here. If
   `<path>` no longer exists on disk (a prunable record), skip to `git
   worktree remove --force <path-from-list>`, behind the clone-scoped lock
   when workers share the clone (re-run the routing call and re-check that
   `<path>` is still absent once the lock is held) — mirroring B1's own
   same-shape recovery rule for a prunable entry
   (`idd-work.instructions.md`). Steps 3-4 have nothing to preserve or
   remove here. Keep that command rather than a
   plain `git worktree prune`: prune is clone-wide (replayed on git 2.53.0,
   one prune cleared an unrelated record together with the claimed
   branch's own), though it does remove an unlocked prunable record at
   once. The 3-month expiry belongs to `gc.worktreePruneExpire`, which only
   `git gc` applies. A locked record is never flagged `prunable`, so this
   skip-ahead does not reach it; unlocking it is the operator's call, and
   once unlocked it is prunable and the skip-ahead applies. Otherwise (a
   `-local-worktree-occupied` reason) run the profile-selected
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
3. **Preserve.** When `<path>` is a linked worktree, run this step and
   step 4 from the **surviving primary worktree**, never from `<path>`
   itself — the same cwd rule F4 uses for its own removal
   (`idd-merge.instructions.md`), since a shell inside `<path>`
   becomes invalid the moment it's removed. When `<path>` is itself
   the primary worktree (step 4's own primary-worktree branch below),
   there is no other primary worktree to run from — run both steps'
   commands from `<path>` instead; neither step removes the primary
   worktree itself, only checks out a different branch there, so the
   shell stays valid throughout. Check for
   an in-progress rebase, merge,
   cherry-pick, or bisect using git state, not a literal `.git/...`
   path — `.git` at a linked worktree's root is a file, not a
   directory, so a hardcoded path check silently never matches: `git
   -C <path> rev-parse -q --verify MERGE_HEAD` (merge), `test -d
   "$(git -C <path> rev-parse --git-path rebase-merge)"` or
   `rebase-apply` (rebase), `git -C <path> rev-parse -q --verify
   CHERRY_PICK_HEAD` (cherry-pick), or `test -f "$(git -C <path>
   rev-parse --git-path BISECT_LOG)"` (bisect) — `rev-parse
   --git-path` alone only prints the path, the same reason the rebase
   check above already wraps its own `--git-path` result in `test -d`.
   Any match means back up the
   pre-operation branch tip before continuing — this recovery
   abandons the interrupted operation itself rather than resuming it.
   For an in-progress rebase specifically, `HEAD` is the in-progress
   replay tip, not the pre-operation tip: read the pre-operation tip
   from `$(git -C <path> rev-parse --git-path rebase-merge)/orig-head`
   or `rebase-apply/orig-head` (whichever the detection above matched)
   instead. For an in-progress bisect, `HEAD` is the commit under test,
   not the pre-operation position: read that position from
   `BISECT_START` instead. A branch name there means the current tip of
   that branch is the intended tip, and a commit id there (a detached
   start) is the intended tip itself.

   Before the first step-3 mutation, acquire the
   [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock) for the
   shared primary clone and keep it held through all preservation and step-4
   removal commands. In a helper-enabled profile, the
   `local-worktree-recovery` helper does this in-process. In an
   `instructions-only` profile, wrap the step-3 and step-4 command sequence
   in the profile-selected `clone-lock --exec -- ...` form; do not release the
   lock between preservation and removal. This prevents a stale same-claim
   session from reacquiring its worktree lock while preservation is still in
   progress (Codex review, PR `#3550`, comment `#4116882321`). Stop if the
   clone-scoped lock cannot be acquired.

   Inspect `<path>` the way F4's own removal step already does, not
   just its superproject status — a submodule's own uncommitted or
   unpushed work is otherwise invisible here
   (`idd-merge.instructions.md`); tag-only detached history is not
   counted, but local refs are:
   See issue `#3540` for the observed upstream-tag incident.

   - `git -C <path> status --porcelain --ignored --untracked-files=normal`
   - `git -C <path> log @{u}..HEAD` (or all commits when there is no
     upstream) for this worktree's own unpushed commits
   - `git -C <path> submodule status --recursive`
   - Probe:

     ```sh
     git -C <path> submodule foreach --recursive 'git status --porcelain --ignored --untracked-files=normal && git stash list && git rev-list --exclude=refs/tags/\* --glob=refs/\* --count --not --remotes && { git symbolic-ref -q HEAD >/dev/null || git rev-list HEAD --not --remotes --tags --count; }'
     ```

   Let `<tag>` be `idd-lwr <claim-id>`, or `idd-lwr legacy` when step 1
   found no lock (the legacy pre-claim-id release case has no
   `<claim-id>` to tag with). Record the pre-step count of `git -C
   <path> stash list` entries already carrying `<tag>` (normally `0`,
   but a stale one can survive an earlier interrupted attempt at this
   same recovery) as the baseline. When
   the top-level status shows a line not prefixed `!!` (a tracked or
   untracked change — `--ignored` always lists ignored paths too, e.g.
   `node_modules/`, so their presence alone is not a signal to stash),
   save it with `git -C <path> stash push --include-untracked -m
   "<tag>"`, and do the same inside every submodule whose own status
   showed a tracked or untracked change. A submodule `submodule
   status` reports `-` (uninitialized) is not a git repository at
   all — `submodule foreach` never visits it and no `git -C` command
   works there, so F4 treats its contents as plain filesystem
   leftovers, not a repo: copy any files under that path to a
   location outside `<path>` directly (e.g. `cp -r`), and verify that
   copy landed instead of a stash entry. The tag distinguishes this
   recovery's own entries from a sibling worktree's (`stash` is
   repository-wide), and the baseline count distinguishes a fresh
   success from a stale leftover on a retried attempt. Stash entries
   live in the shared repository, not the worktree's own private
   admin directory, so they survive step 4's removal. If `stash push`
   instead fails on unmerged paths the backed-up operation left
   behind, fail closed: copy the conflicted files out to a path
   outside `<path>` — mirroring F4's own "copy other work to a
   different ref or path" rule — rather than treating the branch-tip
   backup alone as sufficient preservation. Preserve unpushed commits
   — this worktree's own and every submodule's — on a backup ref:
   record the intended tip first (`git -C <path> rev-parse HEAD`, or
   the pre-operation tip captured above for an in-progress rebase, or
   the position `BISECT_START` names for an in-progress bisect),
   then `git -C <path> update-ref refs/idd-lwr/<branch> <that-sha>`
   (or the same scoped to a submodule's own path), or a bundle,
   instead of pushing them to the issue branch. A stale
   `refs/idd-lwr/<branch>` left by an earlier interrupted attempt at
   this same recovery can otherwise satisfy step 4's existence check
   even when this attempt's own `update-ref` never ran — recording
   and later comparing the OID closes that gap the same way the
   stash `<tag>` closes it for stash entries. `--include-untracked` does not
   stash ignored files, so
   copy those out separately too: secrets (e.g. `.env`) — never
   commit or push them — and any other non-reproducible ignored data.
   A worktree (and every submodule) with no tracked or untracked
   change has nothing to stash: `stash push` reports no local changes
   to save and creates no new entry, so step 4 skips the stash check
   for it.
4. **Remove.** Keep the clone-scoped lock acquired before step 3 held through
   either branch's fresh claim/lock re-check and the mutation that follows —
   the checkout on the
   primary-worktree branch, or `git worktree remove` on the ordinary
   linked-worktree branch. Do not release the lock after preservation and
   reacquire it here: a concurrent session can acquire or replace
   `idd-claim.lock` during that gap, so the preserved snapshot would be
   stale. The lock serializes
   `worktree add`/`remove` and `fetch` against the shared primary
   clone (`src/scripts/clone-lock.mts`'s own documented scope), while also
   keeping the preservation and removal sequence one exclusion window.

   While that lock is already held — not step 1's earlier read —
   re-run the confirm-the-block check, using the same
   profile-selected `resume-claim-routing` and `claim-lock` helper
   forms step 1 above resolves (a bare `resume-claim-routing.mjs`
   invocation is not portable outside the source-repo/vendored-node
   profile). This is the fresh re-check for the ordinary
   linked-worktree branch: it runs only after the lock is held, not
   only before `git worktree remove`. Stop if the result no longer
   matches: a live session resumed the claim, a different claim-id
   now holds the lock, or the branch no longer reports
   `local_worktree_occupied` — the situation changed since step 1,
   and `idd-merge.instructions.md`'s own F4 worktree-removal step
   revalidates the claim and lock before every removal for the same
   reason. Then confirm each step 3 action actually succeeded — the
   `<tag>` entry count in `git -C <path> stash list` (and each
   submodule's) rose by exactly one past the baseline only where
   step 3 found a change to stash, any unmerged-path fallback copy
   landed outside `<path>`, any `-` submodule's copied files landed
   outside `<path>`, `git -C <path> rev-parse --verify
   refs/idd-lwr/<branch>` resolves **to the recorded tip OID** — not
   merely that it resolves at all, which a stale ref could also
   satisfy — (or the submodule-scoped equivalent) only where step 3
   found unpushed commits to back up, and any copied-out ignored
   files landed outside the worktree — before removing anything.
   For a linked worktree, top-level local-only refs also require copying
   its private worktree git-admin directory before removal; a deinitialized
   submodule's private admin data is preserved under the same rule when it
   contains relevant stashes, local-only refs, or an interrupted operation.
   Symlink targets inside any soon-to-be-removed source are materialized in
   the backup, and special files fail closed instead of being copied as
   regular files. These are preventive safeguards; no observed incident
   yet. Stop and do not run `git worktree remove`, `--force` included, if
   any of them failed.

   If `<path>` is the primary worktree — the path the first `worktree`
   line of `git worktree list --porcelain` reports, distinct from
   every subsequent linked-worktree stanza — `git worktree remove`
   cannot remove it, and its admin directory is shared by every
   concurrent session in the same clone and is never cleaned up by
   removal (`src/scripts/claim-lock.mts`'s own documented scope). This
   is typically the anti-pattern §W7 warns against (checking out the
   issue branch directly in the primary worktree instead of adding a
   linked one). The clone-scoped lock is already held, so this
   branch's fresh `claim-lock` re-check runs only after that
   acquisition, not before it and not only before the checkout.
   Re-run step 1's profile-selected `claim-lock` check form on the
   primary worktree now, immediately before acting — not step 1's
   earlier read, which is stale once a concurrent session could have
   replaced this shared admin directory's lock during the wait to
   acquire the clone-scoped lock. Hold the lock through the final
   lock check and deletion. A concurrent session can use the shared
   primary clone's topology at any point between the checkout and
   the deletion otherwise. Only if that fresh check still matches
   this primary worktree's lock to the claim-id being recovered, or
   — for a legacy release — still finds no lock at all (matching
   step 1's own absent-lock finding): clear any interrupted operation
   (`rebase --quit`, `merge --abort`, `cherry-pick --abort`, or
   `bisect reset`), then run `git -C <path> checkout
   {development-branch}` there to release the branch and retry the
   confirmed-absent routing check up to three total observations — re-resolve
   `{development-branch}` per §CSA's note above if this file is
   entered without a fresh B1 pass — confirm `resume-claim-routing.mjs`
   now reports this branch's `evidence.local_worktree.status` as
   `absent`, then, only when that fresh check found a lock, remove
   that one lock file (`rm "$(git -C <path>
   rev-parse --absolute-git-dir)/idd-claim.lock"`) — the same deletion
   `git worktree remove` performs for a linked worktree, done by hand
   here since removal itself isn't possible — before releasing the
   lock and continuing to step 5. Otherwise (a different holder, or a
   lock that now exists where step 1 found none) stop; the situation
   changed again. Leave the
   generated-tokens record: it is keyed per claim-id, not per branch,
   and `claim-lock.mts` already documents it as never expected to be
   cleaned up.

   Otherwise the same lock is already held, and the confirm-the-block
   re-check above already ran while holding it. Run `git worktree
   remove <path>`, then verify that this exact path is absent from disk and
   no longer appears in `git worktree list --porcelain`; keep the hold if
   either observation is unavailable or still names the target. Do not run
   `git worktree prune` here: it is clone-wide and can erase unrelated
   prunable records (observed 2026-10-23 in issue `#4639`). This is the
   removal that F4 step 5 (`idd-merge.instructions.md`) runs through the
   removal helper. If it fails
   with `fatal: working trees containing submodules cannot be moved or
   removed`, only the operator, never the F4 session, may retry
   `git worktree remove --force <path>`, after confirming step 3's
   preservation already succeeded. The other allowed case is a dirty
   removal failure after a fresh, complete unmerged-path fallback copy;
   generic dirty-removal failures remain a hold. This also deletes
   that worktree's claim lock and generated-tokens record, since both
   live in its own private git-admin directory.
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

## Re-claim an inheritable branch

Use this sequence when a fresh claim must reuse an existing PR branch, an
inheritable branch whose commits beyond the base must be kept. The
fresh-branch order in `idd-claim.instructions.md` creates a new branch from
its base ref and does not apply. The fresh-branch orders in the full and lite
claim files both start from `origin/{development-branch}`. This sequence
attaches the existing branch instead and chooses
no new base ref: the branch keeps its own history, which may be based on
`origin/main` or another ref. Observed 2026-10-12,
`kurone-kito/idd-skill#3708` (PR `#4030`): the claimant attached the existing
PR branch as a sibling worktree before the claim, and the lite order
succeeded. Run all five pre-checks in `idd-claim.instructions.md` before
step 1. This sequence does not repeat them.

1. Fresh-claim gate with no worktree:
   `node scripts/resume-claim-routing.mjs --issue <N> --fresh-claim-gate`
   returns `claimable`.
2. Before the claim POST, validate the branch name and record the tokens on
   the primary worktree. Assign the recovered branch to `BRANCH` once, as a
   single-quoted value with any embedded single quote written as `'\''`. Never
   write the value itself inside double quotes, because `$(...)` would run
   there. Then validate. A failure holds here, before any POST:

   ```sh
   BRANCH='<branch>'
   git check-ref-format "refs/heads/$BRANCH" && [ "${BRANCH#-}" = "$BRANCH" ]
   ```

   The leading-hyphen test is needed because `git check-ref-format` accepts a
   name such as `-x`, but `git branch` refuses it.

   Then record the tokens:
   `node scripts/claim-lock.mjs --record-tokens --worktree <primary>
   --agent-id <id> --claim-id <id>`. Immediately before the claim POST in
   step 3, re-fetch the labels and the owner and claim logs, as the claim
   pre-checks require. An authoring hold, or a competing claim that appeared
   since step 1, aborts here before any POST.
3. Claim POST, with the branch of the existing PR:
   `node scripts/post-idd-marker.mjs --target issue <N> --type claim
   --agent-id <id> --claim-id <id> --timestamp <ISO8601> --branch "$BRANCH"
   --apply`.
4. Activation-nonce POST. Generate a fresh opaque nonce for this claim id,
   and never reuse one from an earlier attempt, as the lite claim sequence
   requires. Record it on the primary worktree first:
   `node scripts/claim-lock.mjs --record-tokens --worktree <primary>
   --agent-id <id> --claim-id <id> --nonce <nonce>`, then:
   `node scripts/post-idd-marker.mjs --target issue <N> --type
   activation-nonce --agent-id <id> --claim-id <id> --nonce <nonce>
   --timestamp <ISO8601> --apply`.
5. Provision the branch and attach its worktree as one locked command. Run it
   under the
   [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock), as B1
   requires for every fetch and worktree add against a shared clone. The
   script fetches the remote tip, creates the local branch when none exists,
   and attaches it with no `-b`, so the existing history is kept. It never
   moves the primary HEAD.

   The branch and the path are the two trailing arguments. Single-quote each
   one at the call site, writing an embedded single quote as `'\''`, so the
   outer shell passes it through unchanged. Never paste them into the script
   text. When a local `<branch>` already exists, the script attaches it only
   if it equals `origin/<branch>`. A local ref that differs exits 1 and is
   never overwritten:

   ```sh
   node scripts/clone-lock.mjs --exec --agent-id <id> -- sh -c '
     git fetch origin "+refs/heads/$1:refs/remotes/origin/$1" &&
     if git show-ref --verify --quiet "refs/heads/$1"; then
       [ "$(git rev-parse "refs/heads/$1")" = \
         "$(git rev-parse "refs/remotes/origin/$1")" ] ||
         { echo "local $1 differs from origin/$1: hold" >&2; exit 1; }
     else
       git branch -- "$1" "origin/$1"
     fi &&
     if git worktree list --porcelain | grep -Fqx "branch refs/heads/$1"; then
       echo "branch $1 is checked out in another worktree: hold" >&2
       exit 1
     fi &&
     git worktree add -- "$2" "$1"
   ' sh '<branch>' '<path>'
   ```

6. Carry the nonce forward on the linked worktree:
   `node scripts/claim-lock.mjs --record-tokens --worktree <linked>
   --agent-id <id> --claim-id <id> --nonce <nonce>`.
7. Acquire on the linked worktree:
   `node scripts/claim-lock.mjs --acquire --worktree <linked> --agent-id <id>
   --claim-id <id>`. A collision with another claim id means the claim is
   contested, not yours. Stop, as the failure rules below require.
8. After the settle delay (`claim.verifySettleDelay`, default `PT5S`), assert:
   `node scripts/resume-claim-routing.mjs --issue <N> --assert --claim-id <id>
   --nonce <nonce> --worktree <linked>`. Only `already_owned` with action
   `keep` continues. Any other result stops the sequence. Do not assert before
   the delay: the nonce and the claim comments are eventually consistent, so an
   early assert can report a false failure while the markers are still
   propagating.

A failure after the POSTs may leave a live claim, so never answer it by
repeating a POST blind. Re-read the issue comments first, paginated, and apply
the claim verification rules in `idd-claim.instructions.md`.

- Step 3 exited nonzero. A `claimed-by` marker with your `{claim-id}` means
  the claim POST landed, even when the command failed after GitHub accepted
  it. The claim is then live, so go to step 4. With no such marker, nothing
  was posted: restart from step 1.
- Step 4 exited nonzero. The claim is live, so do not restart from step 1 and
  do not release it yet. An activation-nonce marker with your `{claim-id}` and
  nonce means the POST landed: continue at step 5. With none, confirm the
  active claim is still yours, then repeat step 4 with a fresh nonce. If the
  active claim is no longer yours, stop and report without posting a release.
- Steps 5 to 8 failed. Before any release or retry, confirm that the active
  claim is your `{claim-id}` and that the activation nonce is yours. If that
  proof does not hold, stop and report without posting a release.
- Step 5 failed, and the proof holds. No linked worktree was attached, so
  release your own pair, then restart from step 1:

  ```sh
  node scripts/post-idd-marker.mjs --target issue <N> --type unclaim \
    --agent-id <id> --claim-id <id> --timestamp <ISO8601> --apply
  ```

  A local branch that the script already created is attached again on the
  restart, because the script attaches a local branch that equals
  `origin/<branch>`. A local ref that differs fails the same check on every
  restart, so resolve that ref first. The same holds for a branch that is
  already checked out in another worktree.
- Step 6 failed with an infrastructure error, and the proof holds. The linked
  worktree exists, so do not release or restart from step 1, because the
  worktree blocks the no-worktree gate. Repeat step 6.
- Step 7 or 8 returned a contested verdict. Stop and report, as steps 7 and 8
  require.

The claim comes before the attach because #4071's decided sequence orders them
that way.
