# IDD — Work and Self-Review Phase (B + C)

Read this file after a successful claim. It covers worktree creation (B1),
planning (B2), implementation (B3), and the self-review loop (C).

If this agent is running as a delegated worker under the
[orchestrator fan-out variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant),
the same
[wake-up discipline](idd-ci.instructions.md#wake-up-discipline)
topology-safety condition applies throughout B through F4: never end a
turn assuming an unconfirmed background wait resumes it, even when the
delegation brief itself already restates the warning -- wait
synchronously or with a confirmed topology-safe wake for any
backgrounded command, and confirm the result before ending the turn.

---

## B1 — Create worktree (with branch)

Use the [clone-scoped lock](../../docs/idd-helper-scripts.md#clone-scoped-lock)
for shared-clone fetch, merge, worktree operations, and F4 cleanup; see
[fan-out](../../docs/idd-workflow.md#orchestrator-fan-out-variant) if applicable.

For the ordered setup, follow the guide's [lock and token steps](../../docs/idd-worktree-setup.md#lock-the-worktree-before-installing-dependencies),
[install and verification steps](../../docs/idd-worktree-setup.md#install-and-verify-dependencies),
and [B1 self-check](../../docs/idd-worktree-setup.md#run-the-b1-self-check).
This phase file retains the required source and branch checks, stop
conditions, and the branch-reuse, WorkTrunk, and host-isolated exceptions
that the guide references.

1. Parse `origin` as credential-free `{origin-repository}`
   (`[HOST/]OWNER/REPO`); strip userinfo, never print/pass the URL. Resolve
   SSH aliases with `ssh -G`'s `hostname`. For the helper, set `GH_HOST`
   to origin's host if unset; stop if set differently.
   Compare owner/repo and host case-insensitively; stop on parse/lookup
   failure or mismatch.

   Before fresh `claim-issue`, unset `GH_REPO`; run the separate
   unqualified guard (issue `#5090`):

   ```sh
   gh repo view --json nameWithOwner --jq .nameWithOwner
   gh repo view --json url --jq .url
   ```

   Before profile-selected `claim-issue`, match `nameWithOwner` to origin's
   owner/repo and `url`'s host to origin's host; keep `GH_REPO` unset.
   Direct lookups:

   ```sh
   gh repo view "{origin-repository}" --json nameWithOwner --jq .nameWithOwner
   gh repo view "{origin-repository}" --json defaultBranchRef --jq .defaultBranchRef.name
   ```

   Recheck identity; use the returned default branch. Stop on empty/unsafe
   name. Never use `developmentBranch`. On primary with it checked out:

   ```sh
   git fetch origin
   git log origin/{default-branch}..{default-branch} --oneline
   ```

   Missing ref or any log output: stop/report; never reset. Otherwise:

   ```sh
   git -c merge.autoStash=false merge --ff-only origin/{default-branch}
   ```

   On merge failure/dirty primary, stop/report before creation;
   dirty reports: `primary-worktree-dirty` and paths. Ask the
   operator to preserve staged/unstaged content and resolve staged/unmerged
   paths. Move only this session's unstaged paths outside repo; ask
   before moving others. Rerun Step 1. Never stash/discard/remove a
   worktree (issue `#5058`). Follow Anti-patterns.

2. Run `git worktree list`. Inspect an existing branch worktree and acquire
   its [worktree-local claim lock](idd-claim.instructions.md#worktree-local-lock-file-same-machine-collision)
   before reuse/removal. On collision, follow the Claim-state rule in
   `idd-claim.instructions.md`; remove only after authorized takeover.
   Reuse keeps the lock. After removal, recreate the path and reacquire the
   lock before mutation; remove before branch deletion.

   If `git worktree list --porcelain` marks the entry `prunable` with
   its path already absent, there is no live worktree to protect —
   clean that stale entry with `git worktree remove --force
   <path-from-list>` and continue (the only removal exception before a
   lock check).
3. Run `git branch --list {branch-name}` — if the branch still exists
   locally after step 2, reuse it when inheritable (claim takeover).
   Otherwise (unexpected leftover) delete it: `git branch -d
   {branch-name}`. If deletion is refused (unmerged commits), treat it
   as inheritable and reuse it when a remote branch or open PR exists;
   otherwise post a hold comment and stop for manual cleanup — do not
   force-delete without confirming no remote or PR claim is tied to it.

Then create the worktree below; for a takeover, reuse the exact branch
name from the claim comment.

When the stop in pre-creation step 3 or in Worktree creation Step 1 falls
under the `b1Leftover` auto-decide class, follow the
[B1 leftovers](../../docs/idd-workflow.md#b1-leftovers) entry of the
auto-decide section instead of stopping. Its `--apply` run creates the
worktree and posts the claim, so continue in that worktree with
**install-deps** and do not create it again. If its checks keep the stop,
stop as before.

### Anti-patterns

Never create the implementation branch in the primary worktree with:

- `git switch -c <branch-name>` or `git checkout -b <branch-name>` —
  both move primary HEAD and skip worktree creation.
- `git branch <branch-name>` then in-place primary-worktree commits —
  breaks the sibling-worktree invariant though HEAD does not move.

The primary worktree's HEAD MUST remain on `{default-branch}` throughout
B1; if it ever leaves `{default-branch}`, stop immediately and follow the
B1 self-check repair path below.

### Worktree creation

**Naming convention**: compute the worktree path as
`../<repo-name>.<normalized-branch>` where `<normalized-branch>` is the
branch name with every `/` replaced by `-`.

Example: `issue/123-add-foo` → `../{{REPO_NAME}}.issue-123-add-foo`.

**Harness-native worktree tools**: pin sibling path and claimed
`issue/<number>-<slug>` branch, else use `git worktree add`/WorkTrunk.
Never use Claude Code's `EnterWorktree`
(`.claude/worktrees/agent-<hash>` only), Grok Build's `grok --worktree`,
subagent `isolation: worktree`, or `x.ai/git/worktree/*`: they cannot pin
both (issue `#1930`).

**Step 1 — Check for orphaned path**: if the target path already exists
but is not listed in `git worktree list`, stop and report for manual
cleanup before continuing.

**Step 2 — Create**: `<base-branch>` below is `{development-branch}` —
resolve it first: read `developmentBranch` from the effective policy, else
use `{default-branch}` from B1 Step 1; validate the result
([defaults](../../docs/policy-constants.md#branch-synchronization-defaults)),
fail closed if invalid/absent on `origin`, never fall back. Then
`git fetch origin` (may be missing/stale otherwise). Use **WorkTrunk**
if available, except on a fresh claim (see the note under the table; create verb:
`wt switch --create`; `wt new` was removed):

- macOS/Linux: `wt switch --create -b origin/<base-branch> <branch-name>`
- Windows: `git-wt switch --create -b origin/<base-branch> <branch-name>`, or the
  same `wt switch --create -b origin/<base-branch> <branch-name>` if `git-wt` is
  unavailable

Non-interactive/automation: append `-x <noop>` (e.g. `-x true`) so
WorkTrunk creates, runs the pre-start hook, and exits without
changing the caller's directory.

**Pre-start hook approval hang** (issue `#2797`): with `-x <noop>`,
`wt switch --create` hangs if the `[pre-start]` hook is unapproved. Before the
first switch, run `wt config approvals add --yes` once from the primary
worktree. The approval is project-scoped, so sibling worktrees share it.
Avoid the global `-y`/`--yes` flag; it skips all approvals.

If WorkTrunk is unavailable, choose the correct case:

<!-- dprint-ignore-start -->
| Case | Command |
| --- | --- |
| Fresh claim | `git worktree add --no-track <path> -b <branch-name> origin/{development-branch}` |
| Takeover — local branch exists | `git worktree add <path> <branch-name>` |
| Takeover — remote branch only | `git fetch origin && git worktree add <path> -b <branch-name> origin/<branch-name>` |
| Takeover — neither local nor remote (rare) | treat as fresh claim; preserve the inherited branch name |
<!-- dprint-ignore-end -->

On a fresh claim, do not use WorkTrunk create: its pre-start hook installs
before the claim POST and before any lock. Create the worktree with the
fresh-claim row above, then follow the fresh-claim order in
`idd-claim.instructions.md`.

**Step 3 — Install deps**: after worktree creation:

- Before installing, complete the guide's [lock and token steps](../../docs/idd-worktree-setup.md#lock-the-worktree-before-installing-dependencies).
  For a fresh claim, record this worktree's tokens with the A5 nonce before
  acquiring the lock; for a takeover, acquire the lock first, then record
  tokens with that nonce. In both cases, read both records back and pass
  the post-acquire claim assertion.
- On takeover, a pre-start install hook must make lock acquisition and
  token recording its first commands, in that order, before installing.
  If it cannot, skip the hook and use the manual lock-then-install path in
  the guide.
- Run configured `commands.install-deps` inside the sibling worktree only
  when a compliant takeover pre-start hook did not already complete it.
  After either path, use the guide's [install and verification steps](../../docs/idd-worktree-setup.md#install-and-verify-dependencies)
  to confirm the expected post-install artifact. Keep the command safe to
  rerun for retries and worktree recreation.
- Complete the guide's [B1 self-check](../../docs/idd-worktree-setup.md#run-the-b1-self-check)
  before B2. `-x <noop>` leaves the current directory unchanged, so enter
  the sibling worktree before checking. Stop if any step fails.

### B1 self-check

Before continuing to B2, verify all of the following:

- `git -C <primary-worktree-root> rev-parse --abbrev-ref HEAD` returns
  `{default-branch}`.
- `git worktree list` includes the new sibling worktree path.
- The agent's current working directory is the new sibling worktree
  path, not the primary worktree; a launch-workspace-bound file-tool
  harness (Grok Build observed) needs this absolute path, not
  `cd`/`pwd`.

If any check fails, the B1 worktree-creation contract has been
violated: stop, post a hold note describing which check failed, and do
not continue to B2 from the primary worktree. Repair by removing the
misplaced branch (after confirming no work is lost) and recreating the
sibling worktree through the Worktree creation steps above.

The optional local `_idd-worktree-guard.sh` hook (enabled via
`worktreeGuard.enabled: true`) refuses a commit/push from the primary
worktree while HEAD matches an
implementation-branch pattern (default `issue/*`, `roadmap-audit/*`).
It does **not** catch skipping B1 and committing on the base
branch — set `worktreeGuard.refuseBaseBranchCommits: true` (#2801) to
also refuse that case.

If WorkTrunk prints `Cannot change directory — shell integration
installed but not active`, re-verify the working directory on every
later command — see
[rationale](../../docs/idd-design-rationale.md#worktrunk-cwd-caveat).

### Already inside a host-isolated worktree

If this agent's own environment is already a host-isolated worktree
from the harness or orchestrator, "primary worktree" above does not
apply: there is no separate worktree to manage or return to. Skip
Worktree creation; run **install-deps** and verify
`git rev-parse --abbrev-ref HEAD` returns the claimed
`issue/<number>-<slug>` branch as the substitute for the B1
self-check. On a mismatch, post a hold note and stop for the harness
or orchestrator — never remove or recreate this checkout.

At F4, skip the primary-worktree fetch/switch/merge and `git worktree
remove` steps; let the harness reclaim it and finish the rest (issue
close, digest, comment cleanup).

Headroom (information only): in the source repository, run
`node scripts/audit-docs.mjs --check --report`, note its `report:`
lines in the session notes, and change nothing (claim, route, or file)
because of them. Adopter sessions skip this step. The same applies when
B1 skipped creation in a host-isolated worktree.

## B2 — Create and refine plan

### B2.0 — Supersession re-check (before planning)

A4.5's duplicate/supersession check ran once, at pre-claim triage. A
sibling PR can ship the whole deliverable during the claim→plan gap
under concurrent execution, so re-check once the B1 worktree exists and
**before writing any code or drafting the plan below**, using a
mechanical file/close-based signal stronger than A4.5's title/
declaration heuristic (a weak **title-only** match is **not** a hit
here).

1. `git fetch origin {development-branch}` (concurrent workers sharing
   one clone: behind the
   [clone-scoped lock](../../docs/idd-helper-scripts.md#clone-scoped-lock),
   same as B1).
2. **Closed-by-a-merged-PR signal**: re-fetch the issue; if it is now closed
   with a linked closing PR, the deliverable already shipped:

   ```sh
   gh issue view <number> --json state,closedByPullRequestsReferences \
     --jq 'select(.state == "CLOSED") | .closedByPullRequestsReferences[].number'
   ```

3. **Same-target-files signal**: otherwise scan PRs merged **at or after the
   active claim's `created_at`** (a small bounded window) and check whether any
   changed a file the issue scopes under its `## Candidate files`:

   ```sh
   gh pr list --repo <owner>/<repo> --state merged \
     --search "merged:>=<claim-created-at>" --json number,mergedAt --limit 50
   # then, for each candidate, compare its files to the issue's Candidate files:
   gh pr view <n> --json files --jq '.files[].path'
   ```

**On a hit → verify-then-close**: confirm the issue's acceptance criteria
already hold on current `{development-branch}`, then close the issue with a
comment referencing the superseding PR. If the criteria only
**partly** hold, keep the issue open,
record the overlap, and plan only the genuinely-remaining work. On no hit,
continue with the plan below.

`gh issue close` is not completion: with no diff and no PR, only
**verify-then-close** or F4 step 1 post-merge close may close it.

### B2.1 — Premise verification (decision-transcription issues)

Apply this check only when **both** hold: the issue's deliverable is to
record or act on an already-recorded human decision, and that decision's
rationale asserts a specific checkable fact about what a prior change
actually shipped. Out of scope for ordinary feature or bugfix issues.

Before drafting the plan, verify the asserted fact against the prior
change's actual shipped code or documentation rather than treating the
decision's rationale as ground truth. If the prior change cannot be
identified, or its shipped state cannot be checked, treat verification
as inconclusive and follow the conflict path below — do not default to
continuing. See
[rationale](../../docs/idd-design-rationale.md#b21--premise-verification-decision-transcription-issues).

**On a genuine conflict or inconclusive verification**: follow the
shared Hold / suspend rules in `idd-overview-appendix.instructions.md`,
and include the primary-source evidence (or the reason verification was
inconclusive) in the hold comment. Do not silently propagate the
unverified premise, and do not unilaterally overwrite the recorded
decision — the correction must land as a maintainer addendum, not a
silent edit. Resume planning only after the addendum is recorded.

On no conflict, continue with the plan below.

### B2.2 — Example field-name verification

When the issue's "Proposed change" or "Acceptance criteria" cites an
existing schema field, config key, or token as an example (not one it
adds), verify it exists as cited; fix or drop if not, hold if unclear
(`#2806`).

Draft an implementation plan and post it as an issue comment, then run
a critique pass for correctness and concreteness (see
`idd-overview-appendix.instructions.md` for per-agent implementation),
and post the refined final plan as a follow-up or update to the same
comment. After the final plan comment is posted, update the issue live
status digest: `Phase` is `B2 planned`, `Open blockers` is `none`
unless the plan found a blocker, `Next action` is `B3 implement`, and
`Authoritative by` points to the plan comment and verified claim.

Claim ownership revalidation needs no separate check here: it already
applies to every B2 mutation via the
[claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate).

## B3 — Implement

### B3 self-check

Before implementing, verify B2 actually finished, not merely started:
the B2 plan comment reflects the refined, post-critique plan (draft →
critique pass → refined final plan posted as a follow-up or update to
the same comment) -- a draft posted before its critique pass does not
satisfy this. Claim ownership revalidation needs no separate check
here: it already applies to every B3 mutation via the
[claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate).
If the plan is not actually finalized, stop and return to B2.

The following is a repair path only for an ordering violation that has
already occurred, not an alternative route: disclose the deviation on
the issue, name the skipped checkpoint step (the B3 self-check above),
post the plan retroactively with an explicit note about the
reordering, and run the C1 critique pass against the completed diff.

Implement the plan, running **fix-validate** before each atomic commit
(one logical change per commit). Non-interactive-hostile signing: use
the [signed-commit merge wrapper](../../docs/idd-helper-scripts.md#signed-commit-merge-wrapper-shared-git-procedure)
instead.

**Validate.** Judge the run by its own exit status — see
[Project commands](idd-overview-core.instructions.md#project-commands).

**Verify a commit actually landed before trusting a subsequent push.**
A `commit-msg` hook (e.g. commitlint's body-max-line-length) can
silently reject a long single-line body, so no commit is created and the
next `git push` reports "Everything up-to-date". Prefer `git commit -F
<file>` with a pre-wrapped body over a long `-m` message, and compare
`git rev-parse HEAD` before/after or check the reported commit hash.

**De-duplication refactors**: when consolidating a wrapper function used
at multiple call sites, check whether any call site's old delegate path
added behavior (timeouts, stdio handling, error translation, etc.) that
the new shared function does not replicate — not just whether the
function bodies look equivalent. See
[rationale](../../docs/idd-design-rationale.md#b3--de-duplication-refactor-check-for-behavior-parity-not-just-body-equivalence).

**Unexpected validation failures**: a `typecheck`/`lint` failure in a
file this diff did not touch may signal dependency drift or a broken
`{development-branch}` baseline — verify with a fresh-vs-stale `node_modules` comparison
or a clean **install-deps** rerun before assuming the failure traces to
this diff. See
[rationale](../../docs/idd-design-rationale.md#b3--dependency-drift-vs-own-diff-a-typechecklint-diagnostic).

**Local test flakiness under concurrent load**: a test this diff did
not touch that fails or times out locally, then passes an isolated
re-run while hosted CI for the same push stays green, signals CPU /
resource contention from concurrent sessions, not a defect in this
diff. Re-run once in isolation; if it passes and hosted CI stays green,
trust the hosted result — **authoritative over local validation for
this diagnosis**, though this does not waive the fix-validate /
pre-push-validate requirements above. Otherwise treat it as a real
failure and fix it. See
[rationale](../../docs/idd-design-rationale.md#b3--local-test-flakiness-under-concurrent-load-hosted-ci-is-authoritative).

**Editing a docs/instructions file**: first check if it is a generated
mirror. An `.instructions.md` mirror carries an
`idd-generated-from` banner naming its canonical source and
resync command; a `docs/**.md` mirror may not, so check your sync
manifest (e.g. `audit/sync-manifest.json`) for its target entry. For an
`exact`/`concreted` entry, edit only that source; a resync discards
mirror edits. Other modes follow their own manifest contract. See
[rationale](../../docs/idd-design-rationale.md#b3--edit-the-canonical-source-of-a-generated-docsinstructions-file-not-its-mirror).

If B3 or C must stop for a hold, use the shared Hold / suspend rules in
`idd-overview-appendix.instructions.md` and update the issue digest with the
blocking condition before stopping. Do not use the digest as the only
record of unfinished work; material decisions still need issue comments
or commits.

**Unplanned follow-up work**: If B–C reveals a separate follow-up, do not call
`gh issue create` or the REST issues API. This direct-creation anti-pattern is
documented in the [B–C design rationale](../../docs/idd-design-rationale.md#work-and-self-review).
If the optional `issue-authoring`
companion is installed, invoke its Stage 1 hold/contract. Its reuse-first
check must reject targets under another hold. A target with the configured
authoring label outside this session's set is unavailable unless this pass
explicitly resumes that interrupted set; verify its set identity from the
companion's durable owner markers and add its
published issues to the working set first. Unrelated holds stay unavailable.
If the companion builds an optional discarded validation probe
(throwaway, unpublished), run it in a separate temporary worktree;
otherwise skip it. Never run or discard that probe in the current issue
worktree.
Before every edit, require per-target atomic or append-only owner-marker
acquisition and a fresh body/label re-read; on conflict, keep the label, stop,
and use another target or a separate comment.

For a set, use a valid parent roadmap shell as anchor when present; otherwise
use the designated lead. A roadmap's `## Tracks` may be empty until child
numbers exist. Then publish/acquire ready children under that anchor,
renew/revalidate it around each acquisition, wire numbers into any roadmap,
leave the authoring label on every target, then resume B–C.
After anchor acquisition, persist/verify exact `anchor`/`set` in the originating
issue's durable Stage 1 hold; resume must recover it, not infer from label or
choose another lead. On interruption, retain labels, stop B–C, and resume only
after completion. If Stage 1 publishes nothing (including after a non-ready
bucket), comment it before resuming and list it in PR follow-ups once PR
exists. Keep Stage 1 B–C hold; never release
a follow-up or start a second loop. If the companion is unavailable, record the
proposal in a comment/PR follow-ups; never create it ad hoc or improvise
worker-side authoring.

**S-to-M correction and advisory drift** (helper runtime only): a count over
the S/M estimate is advisory evidence, not a stop. When dry-run's scope step
passes with `assessment.correctionApplied: true` or
`assessment.disposition: "advisory-drift"` (even above eight; no effort-L
marker is written or assigned), make one evidence-backed plan reassessment and
follow the
[read-only report procedure](../../docs/idd-helper-scripts.md#b3-scope-assessment-outcomes)
without editing the issue body. If the change is still one cohesive way to meet
the accepted intent, needs no new authority or unresolved decision, and has a
feasible validation plan, update the plan and report, then continue the same
claim. Keep the verified assessment SHA for normal D2. Continue through C
self-review and D1 synchronization before passing it to `claimed-push --apply`
with `--expected-scope-sha256 <assessment-sha256>` (required after
`correctionApplied: true`, otherwise optional). If D2's fresh scope check
differs, return to B3, report the new assessment, and repeat C and D1 before
D2.

**Scope overrun** (helper runtime only): a number alone never causes a release,
held split, needs-decision label, or count waiver. A new independent
deliverable uses the unplanned follow-up work route above, and a design,
ownership, security, resource, or validation blocker keeps its existing
handling. When the helper returns no advisory disposition (a qualifying report
that is unverified follows the retain-and-stop rule above) and the
profile-selected scope audit fails `effort-candidate-file-limit`, or
reassessment finds such a reason that makes the issue itself need a split,
follow the same
[scope assessment routes](../../docs/idd-helper-scripts.md#b3-scope-assessment-outcomes)
and stop without pushing.

**Commit inventory** (helper runtime only; before LWR, lost-claim cleanup, or
closure; clone-scoped
[lock](../../docs/idd-helper-scripts.md#clone-scoped-lock)): follow the
[inventory procedure](../../docs/idd-design-rationale.md#inventory-branch-only-commits-before-scope-overrun-cleanup-issue-4683),
failing closed. Fetch with `git fetch origin {development-branch}:refs/remotes/origin/{development-branch}`,
stop on failure, and count a `git cherry` `-` as already in base only when
`git log origin/{development-branch} -- <paths>` lists exactly one commit. A
merge commit stops the inventory and cleanup. Before LWR `--apply`, the live
list must match the posted inventory; after it, unpushed SHAs must be ancestors
of the backup ref when one exists, and pushed ones of `origin/<branch>`, else
stop. Child numbers come from the authoring set, not the posted comment.
Cleanup needs exactly one trusted, unedited inventory comment for the live head;
any other count stops. A child confirms each pick by its `(cherry picked from
commit <sha>)` trailer, not by patch-id, and retries unconfirmed SHAs. Until
every child-mapped commit is confirmed, or if no safe transfer path exists, keep
the source worktree and issue open and report. A not-reusable mapping is a record
only; discarding needs owner or user authorization and the LWR `--apply` gate,
never `--force`.

**Standing split** is the helper-runtime exception to the worker-side
authoring and scope-overrun rules, for a genuine-need split only (never a
count alone). Keep the parent claim and label held; skip
release/handoff. Resolve policy owner/repo from the claimed issue's canonical
live URL. For a PR, query
`gh api repos/<target-owner>/<target-repo>/pulls/<number> --jq '{owner:
.base.repo.owner.login, repo: .base.repo.name, ref: .base.ref}'` and use its
base owner/repo/ref; otherwise use the issue repo and live default branch.
Pass explicit `--owner <owner> --repo <repo>` to
`idd-effective-config --trusted-auto-decide`; add `--base-ref <base>` only
for a PR. Require `status: readable`; never let checkout `origin` choose
policy. The helper validates only the live base branch and has no exact-ref
mode. Read the base head (`<policy-sha>`), run the check, re-read it, and continue
only if both SHAs match. Then read
`standingApprovals.split.enabled` and
`standingApprovals.split.maxCandidateFiles` from `.github/idd/config.json` at
`<policy-sha>` through GitHub Contents. Save its decoded contents as
`<target-policy>`; use the existing route when the two SHAs differ. The helper
validates that policy's schema, but its auto-decide verdict does not govern
split. Read the parent authoring label
(`issueAuthoring.authoringLabelName`, default `status:authoring`) and
`markerPrefix` from this snapshot. Pass
`--owner <target-owner> --repo <target-repo> --policy <target-policy>
--marker-prefix <target-markerPrefix>` on every publisher call. Require
`enabled: true` or use the existing route; missing `maxCandidateFiles` defaults
to `8`; absent, malformed, or unreadable policy uses that route. Never use
local, head, layered config, or checkout `origin`
([target finding](https://github.com/kurone-kito/idd-skill/pull/5031#discussion_r4505536175)).
Each child fits the trusted ceiling and contains a parent criterion. Each
checkbox-stripped parent acceptance criterion appears whole and verbatim in
exactly one child. Reuse-first check children against open issues, draft
carriers, and claim/PR state. The hand split after issue `#4064`
duplicated child `#4093`; if a match cannot safely join the held set, stop
without publishing a duplicate
([rationale](../../docs/idd-design-rationale.md#b3--scope-overrun-returns-to-authoring)).

For a roadmap child, check claim/PR/execution state, establish ownership per
target, add `Split out of #<parent>`, and update/read back each verified child
in `## Tracks`; conflicts keep the parent and published children held.

Publish only orphan-shaped children. A sequential-roadmap `blocked-by` child
is not an orphan, and `--shape child` needs an independently held anchor this
claimed parent does not provide. Use the existing route before publishing it.
Use the existing route also for standalone orphans (parent not listed under a
roadmap's `## Tracks`) when `<target-policy>` sets `issueScope` to `roadmap`:
ordinary discovery skips them, so released children would stay undiscoverable.
Other values and an absent key are unchanged.

Otherwise use the existing comment/release/stop route.

1. **Hold and record the set.** Revalidate the parent claim; add and verify the
   snapshot's authoring label. If present, resume
   only from the same durable proposal; otherwise stop on the unrelated hold.
   Reconcile mappings. Before release and on resume with a record, require one
   trusted record line matching class, set, anchor, ceiling, and option; proposal,
   mappings, and live held children must match one-to-one by exact title/body,
   with no missing, duplicate, extra, or released child. For each live body,
   verify its single leading helper-generated `authoring-publication` line
   against the helper report, journal, and child ownership record. Remove only
   that line and its blank separator, then compare the rest byte-for-byte with
   the saved draft; never strip an unmatched or extra marker. The record alone
   is not proof.
   If a record exists, verify the set and finish release without republishing. Stop
   on conflict or unknown publication. Before saving, verify material scope or
   design claims against current sources; put file references, GitHub
   permalinks, or read-only command evidence in the review packet's `evidence`
   array. Correct, qualify, or remove unsupported claims; route unresolved
   material claims under the issue-authoring contract. Post/read back one
   complete ordered proposal with current claim ID, estimate, candidate and
   changed files, and each child's exact title and full body. If its POST is
   uncertain, read all parent comments and continue only if exactly one exact
   proposal exists and a trusted actor authored it; otherwise keep the hold and
   stop. On resume reconcile the
   proposal/mappings with helper records and live issues; verify/skip mapped
   children and publish only unmapped ones. Stop on conflicts or unknown
   publication. Keep parent claim/label and children held.
2. **Review and dry-run.** Review each final child separately with the
   issue-authoring contract's completed-draft adversarial review: send its
   exact title and body plus the bounded review packet, resolve the configured
   delegate when usable, else use native review or structured self-critique.
   Bound the wait by `issueAuthoring.adversarialReview.waitCeiling` (`PT20M` default).
   Save `"completed": true` with every finding `fixed` or `rejected`; stop on an
   incomplete, unreadable, or unresolved review. A title/body correction
   invalidates that child's review and the saved proposal. Update/read back the
   full ordered proposal and repeat both checks for changed children. If the
   update is uncertain, continue only when its full body matches exactly;
   otherwise keep the hold and stop. Immediately before dry-run, recheck the
   nonempty final set: every child fits the trusted ceiling and contains a
   parent criterion, and every checkbox-stripped criterion appears whole and
   verbatim in exactly one child. On failure, do not dry-run or apply. Dry-run
   only when each final title and normalized body matches the proposal and has
   a completed review. A refused or failed dry-run stops before any apply.
   Resolve the profile-selected `idd-publish-authoring-hold` invocation per
   `docs/idd-helper-scripts.md`; without `--apply` it is a dry-run. Dry-run
   only unmapped orphans; inspect all results before applying. The helper's review
   check is not the adversarial review.

   ```sh
   idd-publish-authoring-hold --shape orphan \
     --owner <target-owner> --repo <target-repo> --policy <target-policy> \
     --marker-prefix <target-markerPrefix> \
     --title <title> --body-file <file> --review-result <file> [--apply]
   ```

3. **Publish one at a time.** Apply each inspected dry-run in a separate call.
   Verify its new issue number and held state; append/read back its parent
   mapping before the next publish. If that POST is uncertain, continue only
   when all parent comments show exactly one matching mapping; otherwise keep
   the hold and stop. Any refusal, failure, recovery hold, or unknown result
   stops publication, even if one matching held child is found. Do not publish
   another child, retry an unknown result, post the record, or release the
   parent. Keep proposal, parent claim/label, and published children held;
   inspect the report, journal, marker, and live issues before reporting.
4. **Record and release.** After children and required roadmap tracks pass the
   set check, post the exact record below. On definite/uncertain POST failure,
   post a hold note naming verified children; keep parent claim/label and child
   holds, then stop. For uncertainty, proceed only after paginated read-back
   confirms one trusted exact record and the complete set; never retry. On
   success, post the completion note, revalidate the claim, then update and
   read back the parent digest (`Phase: aborted/released`, the planned release
   in `Next action`, the verified claim and reason in `Authoritative by`).
   Only then post/verify its exact `unclaimed-by` marker through the standard
   release procedure and run cleanup. Mismatch, unreadable state, or uncertain
   release keeps the parent held and stops before cleanup. Keep the authoring
   label until release or completion.

```text
<!-- idd-skill-standing-approval: class=split; set=none; anchor=<owner/repo#n>; ceiling=<maxCandidateFiles>; option=option-a -->
```

Use the parent issue itself as `anchor` (`<owner>/<repo>#<number>`) and the
numeric effective `maxCandidateFiles` as `ceiling`.

For `instructions-only` execution, keep using the existing companion route.

---

## C — Self-Review Loop

### C1 — Critique pass

Run a critique pass on this branch's diff. Ask it to check correctness,
whether the issue's requirements are satisfied, test coverage, and any
other problems. See `idd-overview-appendix.instructions.md` for per-agent
implementation. The distributed defaults for the C-phase skip and loop
guards are listed in `docs/policy-constants.md`. A repository may
configure `critiqueLoop.delegate` to point this step at a different
reviewer instead of the per-agent mechanism. When helper runtime is
enabled, resolve the effective `critiqueLoop.delegate` with the
[`idd-critique-delegate`](../../docs/idd-helper-scripts.md#effective-c1-critique-delegate)
helper — `node scripts/idd-critique-delegate.mjs` for source-repo /
vendored-node profiles; for package-manager / ephemeral-npx / user-global, resolve
the profile-selected command from `docs/idd-helper-scripts.md` rather
than hardcoding that bare binary name — instead of hand-deriving it;
for `instructions-only` execution, apply the
resolution order directly instead: repo-local `critiqueLoop.delegate`
always wins outright, and only when it is genuinely absent does a
local runtime's user-global config file apply. A repository may also
configure `critiqueLoop.telemetryHook` for a separate fire-and-forget
per-round JSON record that C2/C4 below invoke but that never gates
control flow; see `docs/idd-workflow.md`'s "Critique pass invocation"
section for both. If possible, a per-agent subagent's brief names a
parent-created scratch directory and quotes rule 3: "the subagent uses
only that directory and creates none"; run the post-round scratch check
after each such pass.

**Objective diff validation floor**: neither C2 nor C4 below may skip to
`idd-pr-submit.instructions.md` unless **fix-validate** — the same
command set C5 runs — has passed against the branch's current HEAD;
re-run it after every new commit. This floor is independent of D2's own
**pre-push-validate** gate and never substitutes for it, and it applies
**uniformly** regardless of self-classifying as "no-subagent": on a
no-subagent runtime, where critique degrades to same-response
self-critique, the critique verdict is **advisory** and this floor is
**load-bearing** instead. If the floor has not passed, C2 and C4
continue to C5 instead of skipping, even when their other skip
condition is otherwise met.

After each critique loop decision, update the issue digest only if the
next action changes materially: for example, `C accepted fixes` before
C5, `C clean` before moving to PR submission, or a hold state when
guardrails stop the loop.

### C2 — Check for issues

Zero issues reported: skip to `idd-pr-submit.instructions.md` when the
floor (C1) has passed, else continue to C5. One or more issues:
continue to C3 regardless of the floor — C4 applies the floor check
after Accept/Reject scoring.

**Telemetry hook**: on a zero-issue round (either branch above — a
round that continues to C5 for the floor only is still a zero-finding
round and must not lose its record), invoke `critiqueLoop.telemetryHook`
(C1) with zero findings/accepted/rejected counts — fire-and-forget.

### C3 — Score issues

For each issue reported, assess severity and relevance to PR intent:

- **High** (safety, correctness, requirement violations, CI stability) →
  **Accept forced**, regardless of PR intent
- **Low** (minor improvements unrelated to PR intent) → **Reject
  recommended**
- **Medium** → judge by context

### C4 — Accept / Reject and loop check

Decide Accept or Reject for each issue. Then check:

- Accept count = 0 **and** the floor (C1) has passed → skip to
  `idd-pr-submit.instructions.md`
- Loop count >
  `critiqueLoop.cPhaseLowSeveritySkipAfter` (distributed default: `2`)
  and all remaining Accepts are Low **and** the floor has passed → skip
  to `idd-pr-submit.instructions.md`

If a bullet's condition holds except the floor, continue to C5 to
satisfy the floor only; the second bullet's remaining Low Accepts stay
unfixed, per the guard.

Otherwise continue to C5.

**Telemetry hook**: once final (before C5, PR submission, or C4's own
hold) invoke `critiqueLoop.telemetryHook` (C1) with this round's
findings, severity, accepted/rejected counts, and delegate usage —
fire-and-forget. A delegate's own fail-closed hold (`docs/idd-workflow.md`)
stops before C2 and has no telemetry record.

### C5 — Fix accepted issues

Fix any Accepted issues the guard above does not exempt (there may be
none — see C4). Then run **fix-validate**: a pass from before this
step's own edits does not satisfy the floor, so re-run it now and fix
anything it reports.

An unmet floor is not a new failure class: run or fix **fix-validate**
the same way the Project commands table handles a failing
**pre-push-validate**.

Claim ownership revalidation needs no separate check here: it already
applies to every C5 fix commit via the
[claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate).

If anything changed, commit atomically.

### C6 — Return to C1

Go back to C1 for the next review pass.
