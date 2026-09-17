# IDD — Review Snapshot Phase (Lite) (E1-E3)

Lite profile for helper-enabled weak/local models. Same semantics as
`idd-review-snapshot.instructions.md`. Use only for this session's
claimed issue, with an open PR whose CI has passed or that already has
reviews. If the repository is `instructions-only`, use the standard
review-snapshot instructions instead.

## Helper runtime contract

- Helper-enabled profiles: when a step names a helper or command set, use
  it. If a required helper is missing, fails, or disagrees with live
  state, stop and ask. Do not fall back silently to prose.
- `instructions-only`: do not use this lite file; use
  `idd-review-snapshot.instructions.md` instead.
- Any mismatch between this file and the standard review-snapshot phase
  is a bug in this file.

## Triage hand-off boundary (E4-E8 excluded)

This file only fetches, freezes, and routes ReviewItems_snapshot — it
never classifies findings, scores severity, or decides Accept/Reject.

1. E3's non-empty-list outcome hands off to
   `idd-review-triage.instructions.md` (E4-E8) for a stronger session
   or a human — never run E4-E8 yourself, even for a trivial-looking
   finding.
2. If you catch yourself judging severity, deciding Accept/Reject, or
   assigning a PATH before handing off to E4, stop and ask instead.

## Stop-and-ask conditions

- The active claim is ambiguous, disputed, or lost.
- A required helper is missing, fails, returns invalid JSON, or
  disagrees with live state.
- The claim-lock helper reports a collision (a different claim id
  already holds the worktree lock).

## Pre-mutation guard

Before any commit, comment, marker post, reply, resolve, or other
GitHub side effect, confirm all of the following:

1. The active claim still uses this session's claim id.
2. If this session posted an activation nonce for the current claim,
   confirm it still wins (no later trusted marker for this claim id
   won the tie-break instead).
3. The current directory is the sibling worktree for the claimed branch.
4. `git branch --show-current` equals the claimed branch.
5. Acquire the worktree-local claim lock with the profile-selected
   `claim-lock` helper (`node scripts/claim-lock.mjs --acquire
   --worktree <this-worktree-path> --agent-id <id> --claim-id <id>`, or
   the package-manager-profile `idd:claim-lock` command with the same
   arguments, or the ephemeral-npx equivalent (see
   `docs/idd-helper-scripts.md`). A `collision` result is
   fail-closed: stop rather than proceed. Then, separately, run
   `--read-tokens --worktree <this-worktree-path> --claim-id <id>`
   and require `present: true` with no `malformed`; otherwise recover
   per `docs/idd-helper-scripts.md` (gated: each step succeeds,
   `reacquired: true` both ends), else stop.
6. If any check fails, stop.

## E1 — Fetch review items into ReviewItems_snapshot

### CI-completion precondition (before Step 1)

Before taking the Step 1 snapshot, confirm every CI run counting toward
the merge gate has completed, including any opt-in or label-triggered
job enabled at this quiescent point. If the primary advisory bot
already reviewed an earlier head, an automatic same-head re-review is
expected — run the advisory-wait-state helper and check its
`lastCopilotCommit == prHeadSha` fast-path fields (from
`idd-advisory-wait-lite.instructions.md`; read fresh from the helper,
not Step 1's `{head-SHA}` below, not yet captured here), and wait for
that re-review, bounded by that file's advisory-wait windows if it
never lands. Only then continue to Step 1.

### Step 1 — Snapshot the activity universe

1. Read the current PR HEAD SHA once — `gh pr view {pr-number} --json
   headRefOid --jq '.headRefOid'` — and store it as `{head-SHA}`. Never
   re-read it elsewhere in E1 — reuse this value.
2. Run the profile-selected `review-activity-snapshot` helper to collect
   `{head-SHA}`, `{max-activity-updatedAt}`, `{total-item-count}`, and
   `{latest-ci-completed-at}`: `node scripts/review-activity-snapshot.mjs
   --pr {pr-number} --trusted-marker-logins
   "<trusted-login-1>,<trusted-login-2>"`, or the package-manager
   equivalent (resolve from `docs/idd-helper-scripts.md`) — this is
   Step 2's watermark data source, not a triage tool. The helper emits
   both `latestCiCompletedAt` and `latestPassingCiCompletedAt`;
   `{latest-ci-completed-at}` is always the latter — the latest
   _passing_ (or treated-as-passed) completion, never the latest
   completion regardless of outcome.
3. Independently fetch, in one pass before filtering: every review
   thread (resolved or not — paginate until `hasNextPage` is `false`,
   never stop at a fixed page size), every review body submission, and
   every regular PR comment. The helper above reports counts/timestamps
   only; this raw set is what Step 3 filters.
4. From that raw set, exclude trusted-agent operational marker comments
   whose body starts with one of these prefixes, authored by a trusted
   marker actor:

   - `<!-- review-watermark:`
   - `<!-- review-baseline:`
   - `<!-- claimed-by:`
   - `<!-- unclaimed-by:`
   - `advisory-wait:`
   - `advisory-wait-recovery:`
   - `<!-- advisory-wait:`
   - `advisory-reroll:`

   Never exclude an untrusted-author marker-shaped comment; flag it as
   suspicious if it affects a decision.
5. Non-Copilot advisory safety net: when non-Copilot
   `advisoryBotLogins` are configured (e.g. CodeRabbit), this
   full-universe snapshot plus the Step 2 watermark delta is their only
   safety net for late-arriving findings — never skip or narrow this
   fetch even when Copilot's advisory-wait window looks satisfied.

### Step 2 — Record the watermark

Post one marker per E1 pass. Prefer the one-command path: `node
scripts/post-idd-marker.mjs --type watermark --from-pr {pr-number}
--expected-head-sha {head-SHA} --agent-id <id> --claim-id <id>
--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" --apply`
(or the package-manager equivalent). Always pass `--expected-head-sha`
with the exact Step 1 `{head-SHA}`; the helper fails closed (posts
nothing) when the branch moved since Step 1 — on that failure, return
to Step 1 and re-snapshot the moved branch, not a Step 2 retry.

The manual six-field fallback — `--type watermark --target pr
{pr-number} --agent-id <id> --claim-id <id> --head-sha {head-SHA}
--max-activity-at {max-activity-updatedAt|none} --total-item-count
{total-item-count} --ci-completed-at {latest-ci-completed-at|none}
--apply` — stays available when `--from-pr` cannot run.

The rendered body is exactly:

```markdown
<!-- review-watermark: {agent-id} {claim-id} {head-SHA} {max-activity-updatedAt|none} {total-item-count} {latest-ci-completed-at|none} -->

_{agent-id}: review triage snapshot — IDD automation marker. Do not edit._
```

Match the PR body's language for the visible note (default English if
ambiguous). Nothing may follow the note — content after it, or after
the token with no note, makes the whole comment unrecognized as a live
watermark.

On resume or restart, read the latest trusted same-claim
`review-watermark` comment to restore all six values. Ignore
watermarks from any other claim or untrusted
author; a legacy watermark with no `{claim-id}` is not resumable. If no
trusted same-claim watermark exists, rerun E1 from scratch. After a
forced handoff, all prior-claim watermarks are foreign restore markers
— ignore them, never hide or delete them, and rerun E1 under the
successor claim.

After the new watermark is verified to exist, minimize every strictly
older trusted same-claim `review-watermark` / `review-baseline` comment
as `OUTDATED`: `node scripts/minimize-superseded-markers.mjs
--subject-ids "<id1>,<id2>,..." --classifier OUTDATED
--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" --apply`.
Skip this cleanup (not a stop condition) when the new watermark isn't
verified, the candidate set is empty, or the helper is unavailable —
F4 catches leftovers later. Never hide a different-claim watermark
here.

Do not touch the PR live status digest after posting this watermark
unless the next route is E1, an F3-blocked reroute to F1/D4, a
hold/stop, or post-merge cleanup — a digest edit after the watermark
counts as new activity, forcing a fresh E1 snapshot before F2.

### Step 3 — Filter into ReviewItems_snapshot

From the raw Step 1 set, select into **ReviewItems_snapshot** and
record each item's source URL:

- **Unresolved review threads** (`isResolved=false`) — exclude only
  when the latest substantive reply is from an IDD agent or the PR
  author with no reviewer reply since; keep it active anyway when the
  reviewer reopened it after that reply (even with no new text), or an
  agent reply starts with `**Awaiting maintainer decision**` (blocks
  regardless of
  maintainer response).
- **Review bodies** whose reviewer's latest state is
  `CHANGES_REQUESTED` — exclude any already replied-to and
  re-review-requested in a prior E13/E14 pass.
- **Regular comments** where the last speaker isn't an IDD agent and
  you haven't replied since — exclude periodic notification bots
  (Renovate, etc.). Keep Copilot/CI advisory bot comments; they route
  through PATH B in E4-E7 (non-review notices — rate-limit / quota /
  queued / bare acknowledgement / error — dispositioned under the E6
  non-review-notice rule, not here).

Also carry, from the same Step 1 thread set, a light
**resolved-thread index** (`isResolved=true`): each entry's file/area,
a short claim summary, source URL, and any recorded `**Accepted**` /
`**Rejected**` marker. Do not add resolved threads back into
ReviewItems_snapshot — a routing hint only for E5's duplicate pre-check
in `idd-review-triage.instructions.md`, not a conclusion.

## E2 — Critique pass

Run one critique pass on the branch's changes every E1-E3 pass (always
— not a judgment call). Add any newly found issues to
ReviewItems_snapshot.

Apply these lenses when they fit (composing when both do):
**Mutation / write-side** (the diff implements a helper that mutates
GitHub state, mutates git state, or performs a merge) — Fail-closed
inputs; Validate/execute scope parity; Unsafe-output suppression;
Schema strictness parity. **Gate-mirroring** (the diff implements a
helper that predicts, mirrors, or pre-checks another gate's decision) —
Validation-path parity; Input completeness; Whole-identity comparison;
Snapshot identity; Point-in-time parity.

**Incremental scope**: on the second and later passes within the same
claim, scope the review to the diff since the previous E2's head SHA,
tracked by the latest trusted same-claim `review-baseline` comment.
Reset to the full-branch diff after: a rebase, a multi-fix batch, a
baseline SHA that isn't an ancestor of HEAD, no trusted same-claim
baseline, or an active-claim change (restart, takeover, forced
handoff). ReviewItems_snapshot is session-local — do not inherit a
previous claim's critique findings unless already persisted as
reviewer-visible comments.

After the critique pass completes, re-read the current PR HEAD SHA —
`gh pr view {pr-number} --json headRefOid --jq '.headRefOid'` — and
store it as `{e2-head-SHA}` (it can differ from Step 1's `{head-SHA}` if
the branch moved during E1/E2; the baseline must record what was
actually reviewed). Post a new baseline with `{e2-head-SHA}`: `node
scripts/post-idd-marker.mjs --type baseline --target pr {pr-number}
--agent-id <id> --claim-id <id> --sha {e2-head-SHA} --apply`, or the
package-manager equivalent. Rendered body:

```markdown
<!-- review-baseline: {agent-id} {claim-id} {SHA} -->

_{agent-id}: critique baseline — IDD automation marker. Do not edit._
```

Match the PR body's language, same rule as the watermark; nothing may
follow the note here either.

## E3 — Empty/non-empty routing

- **ReviewItems_snapshot is empty** → proceed to
  `idd-pre-merge-lite.instructions.md` (F1, branch-sync decision). Do
  not route this case directly to the excluded
  `idd-review-triage.instructions.md`.
- **ReviewItems_snapshot is non-empty** → this lite session's job ends
  here (see Triage hand-off boundary above); hand off to
  `idd-review-triage.instructions.md` (E4) for a stronger session or a
  human to run.

## Cold-start ReviewItems_snapshot reconstruction

Read this entering E4/E9 without this episode's ReviewItems_snapshot
(lost/restarted session, or mid-review delegation hand-off).

**Procedure**: rerun Step 1-3 (Step 2 already posts the watermark —
never a second one), then edge case 2's steps 1-3 unconditionally
before E3, then E2, E3. Only when E3 is non-empty, hand off E4-E8
fully before E9. An edge-case-1 item routed to E14 runs E14 after edge
case 2's own push (if any, targeting post-push HEAD), before
branch-sync.

**Edge case 1 — item with no completed disposition.** Covers a lost
session mid-classification, a landed-but-unreplied E12 push, or a
`CHANGES_REQUESTED` body missing only its E14 request. Already has an
E13 `**Accepted** — fixed in` reply with no reviewer reply/reopen
since → skip reclassification, straight to E14. Otherwise
Step 3/E4-E8 decide as usual, flagging whether a commit newer than the
item's timestamp touches its anchored path(s) (thread `path` or a
file named in a regular comment's context) and fixes it (a lost E12
push, or edge case 2's diff below): a match reads **false** against
E5's claim-truth test by design, so an in-scope reviewer-feedback
PATH A item can Accept, not wrongly Reject, and cite it (cap
included) — E9 skipped, E13 still cites it. No match: never coverage,
normal handling applies.

**Edge case 2 — an E9 fix committed but not pushed.** GitHub can't see
this; an empty E3 alone isn't proof nothing needs recovery (F2
resets the worktree before merge). Run unconditionally in the same
surviving claimed worktree:

1. `PR_HEAD` = Step 1's stored `{head-SHA}` — never re-fetch (races an
   external rewrite).
2. `git merge-base --is-ancestor "$PR_HEAD" HEAD` — failure (rewrite,
   diverged worktree): stop and ask, never fall through to edge case 1.
3. `git status --porcelain` must be clean — dirty can't attribute
   lines to items: stop and ask, never guess.
4. `git log "$PR_HEAD"..HEAD` non-empty: record the diff (edge case 1
   covers it too); it still needs E10-E12 to validate and push before
   branch-sync. **E3 empty**: resume at E10, not E12 (a cold session
   can't know if E10's critique already ran; fail-closed governs).
   **E3 non-empty**: hand off E4-E8 first; the receiving flow's own E8
   decides E9, but E10-E12 for the diff still runs even if E8 accepts
   zero items.

Clean worktree, no local-ahead commits: E3's routing applies unchanged;
a fresh or lost worktree falls back to edge case 1, re-triaged from
scratch.
