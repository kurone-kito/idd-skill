# IDD — Review Snapshot Phase (E1–E3)

Read this file after CI passes on a newly pushed PR, or after returning
from a fix cycle. It covers fetching review items (E1), running the
critique pass (E2), and checking whether ReviewItems_snapshot is empty (E3).

Before posting any E-phase operational comment or GitHub reply, apply
the shared claim revalidation gate. The active claim must still use your
current `{claim-id}` — this also serves as E1's phase-entry self-check:
E1 re-fetches all of its state from GitHub on every entry, so, unlike
B1/B3, there is no local plan or worktree artifact that could go stale
between checks.

**If ReviewItems_snapshot is empty after E3**: proceed to the
E-phase branch-sync check in `idd-review-triage.instructions.md`.
**If ReviewItems_snapshot is non-empty after E3**: proceed to
`idd-review-triage.instructions.md` (E4).

## E1 — Fetch review items into ReviewItems_snapshot

**Step 1 — Snapshot the activity universe.** First, read the current PR
HEAD SHA from the GitHub API and store it as `{head-SHA}`. Do not
re-read the HEAD SHA during Steps 1–3; use this single stored value
throughout. Then fetch all of the following from GitHub in a single pass
(before applying any exclusion filters):

- All review threads (resolved or not) — paginate until `hasNextPage` is
  `false`; do not stop at a fixed page size such as `first: 20`, as that
  would miss threads when the total count exceeds the page size
- All review body submissions (any reviewer state)
- All regular PR comments

Exclude **trusted agent operational comments** from the snapshot:
comments whose body begins with one of these exact operational marker
prefixes and whose GitHub author is a trusted marker actor per
`idd-overview-core.instructions.md`:

- `<!-- review-watermark:`
- `<!-- review-baseline:`
- `<!-- zero-accepted-path-a-gate:`
- `<!-- claimed-by:`
- `<!-- unclaimed-by:`
- `advisory-wait:`
- `advisory-wait-recovery:`
- `<!-- advisory-wait:`
- `advisory-reroll:`

Do not exclude marker-shaped comments from untrusted authors. Keep them
in the snapshot/ReviewItems_snapshot and report them as suspicious
context when they affect a decision.

When helper runtime is enabled, prefer the read-only helper
`node scripts/review-activity-snapshot.mjs --pr {pr-number}` to collect
`{head-SHA}`, `{max-activity-updatedAt}`, `{total-item-count}`, and CI
completion timestamps. Pass trusted marker actors with
`--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"`.
Helpers remain evidence collectors only: if helper execution fails,
returns invalid JSON, omits required fields, or conflicts with live
GitHub state in this phase, discard helper output and run the portable
gh/jq/API procedure below. The written instruction rules remain the
authoritative decision path.

Additionally, fetch the **current CI state** for `{head-SHA}`:
`gh pr checks {pr-number} --json name,state,completedAt`. Record the
`completedAt` of the most recently completed successful (or
treated-as-passed) CI run as `{latest-ci-completed-at}`, or `none` if no
CI pass exists yet for this HEAD.

**Non-Copilot advisory safety net.** This E1 snapshot and Step 2's
watermark are the only settle/wait coverage non-Copilot advisory bots
get (`idd-advisory-wait.instructions.md`'s Scope section) — why Step 1
fetches the full activity universe and Step 2 watermarks all of it.

**Step 2 — Record the watermark.** Using the `{head-SHA}` stored at the
start of Step 1, compute `{max-activity-updatedAt}` as the highest
`updatedAt` server timestamp across the **entire snapshot** (not just
the items in ReviewItems_snapshot; `none` if empty), and
`{total-item-count}` as the snapshot's total item count (0 if empty).
Persist all six values by posting a PR comment with this format (when
helper runtime is enabled, prefer the **one-command** profile-selected
post-idd-marker watermark path — `--type watermark --from-pr <pr-number>
--expected-head-sha {head-SHA} --agent-id <id> --claim-id <id>
--apply` — which derives the other fields from a fresh
`review-activity-snapshot` and posts in one step; forward
`--trusted-marker-logins` too). **Always pass `--expected-head-sha`
with the exact `{head-SHA}` from Step 1** — the helper fails closed
(posts nothing) if it disagrees with the fresh snapshot's live HEAD,
rather than silently keying the watermark to a moved HEAD; on that
failure, return to Step 1 and re-snapshot, do not retry Step 2 as-is.
The manual six-field form (`--type watermark --target pr <pr-number>
<watermark-fields> --apply`, same six `--agent-id`/`--claim-id`/
`--head-sha`/`--max-activity-at`/`--total-item-count`/
`--ci-completed-at` values) stays the fallback, as do `emit-marker
--type review-watermark` (emit-only) and the manual HTTP `POST` below;
see `docs/idd-helper-scripts.md`):

```markdown
<!-- review-watermark: {agent-id} {claim-id} {head-SHA} {max-activity-updatedAt|none} {total-item-count} {latest-ci-completed-at|none} -->

_{agent-id}: review triage snapshot — IDD automation marker. Do not edit._
```

The HTML comment is the machine-readable token; the italic line is a
visible note for human readers. Detect the language of the PR body and
write the visible note in that language (default to English if
ambiguous).

**Nothing appended after the note.** As with `claimed-by`/`unclaimed-by`
in `idd-claim.instructions.md`, a `review-watermark` (and
`review-baseline`, below) body must be exactly the HTML token plus the
single italic note — any deviation fails the parser's whole-body anchor
and the comment isn't recognized as a live watermark, though it is
still detectable as a malformed marker
(`detectMalformedOperationalMarker` in `marker-helpers.mts`). See
`idd-claim.instructions.md` for the full rule and
`idd-review-triage.instructions.md` for the related disposition-marker
no-code-fence note.

- **`{head-SHA}`**: the value read at the very start of Step 1, before
  any fetching. F2 uses this to detect pushes that occurred between E1's
  snapshot and the watermark comment post.
- **`{latest-ci-completed-at}`**: the `completedAt` of the latest CI
  pass observed during this E1 snapshot (or `none`). F2 uses this to
  detect a new CI pass that completed after the snapshot fetch.
- **E1 execution marker**: the GitHub-assigned `createdAt` of this
  comment (set server-side), used only to verify watermark recency —
  activity/CI freshness are tracked via the data fields above.

Use server-reported timestamps, not the local wall clock.

**CI-completion precondition.** Post the `review-watermark` only
**after** every CI run counting toward the merge gate has completed —
including any opt-in/label-triggered job enabled at the quiescent
pre-merge point. Same precondition for an expected advisory-bot
re-review: when the primary bot already reviewed an earlier head,
check the AW1 fast-path signal in `idd-advisory-wait.instructions.md`
(`LAST_COPILOT_COMMIT == PR_HEAD_SHA`) and post after that review
lands, bounded by the advisory-wait windows when it never does.
Operationally: enable the late job, await completion, **then** take
the Step 1 snapshot and post the watermark — a merge-gate run
completing _after_ the watermark forces a wasted E1↔F2 round-trip
(F2's `ci-pass-drift`) with no new review activity.

Note: the post-idd-marker helper above performs this JSON `POST`
under `--apply`, sidestepping the `gh issue comment`/`gh api -f body=`
HTML-body and leading-`@` pitfalls `idd-overview-core.instructions.md`'s
Claim format note already covers.

On resume or restart, read the latest same-claim, trusted-author
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment to
restore all six values; ignore watermarks from any other claim or
untrusted author. Legacy watermarks without `{claim-id}` aren't
resumable — rerun E1 from scratch if no trusted same-claim watermark
exists. After forced handoff, prior-claim watermarks are foreign
restore markers: never delete/hide/minimize them to "clear" state;
ignore them and rerun E1 under the successor claim.

**Hide superseded same-claim watermarks.** After the new watermark is
verified on GitHub, minimize every strictly older trusted **same-claim**
`review-watermark`/`review-baseline` comment as `OUTDATED`. Find
candidate subject IDs (older trusted same-claim watermarks), then
call:

`--subject-ids` needs a GraphQL node id, not a REST numeric id;
convert with `gh api repos/{owner}/{repo}/issues/comments/{comment_id}
-q '.node_id'` (other kinds: `--help` below).

```sh
node scripts/minimize-superseded-markers.mjs \
  --subject-ids "<id1>,<id2>,..." \
  --classifier OUTDATED \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" \
  --apply
```

Skip entirely if the new watermark wasn't verified, the candidate set
is empty, or the helper is unavailable — F4 cleanup catches them later.
Different-claim watermarks (forced-handoff successors, takeovers) must
not be hidden here — see the claim takeover hide path in
`idd-claim.instructions.md`.

Do not create or edit the PR live status digest after posting this
watermark unless the next route is E1, an F3 blocked reroute that
leaves the F2 restart path (F1/D4), a hold/stop, or post-merge cleanup
— a digest edit after the watermark counts as new review-currency
activity and would require a fresh E1 snapshot before F2 can pass.

**Step 3 — Filter into ReviewItems_snapshot.** Select and combine into
**ReviewItems_snapshot**, recording the source URL for each item.

**Review threads** (`isResolved=false`) — exclude threads where the
latest substantive reply is from any IDD agent or the PR author with no
reviewer reply since (awaiting-reviewer state), **unless**: the
reviewer reopened the thread after that reply (even with no new text),
or the thread has an IDD-agent reply starting
`**Awaiting maintainer decision**` (remains an active blocker
regardless of maintainer response).

**Review bodies** where the reviewer's latest state is
`CHANGES_REQUESTED` — exclude reviews already replied to and
re-review-requested in a previous E13/E14 pass. **Embedded-finding
gap (helper-first, optional):** a `COMMENTED`-state review can still
carry a file/line-cited finding with no thread of its own, in an
older collapsible body format some bots use — a helper that parses
the embedded findings and compares against the threaded-comment count
(see `docs/idd-design-rationale.md`) detects this; add one PATH B
item per uncovered finding.

**Regular comments** where the last speaker isn't any IDD agent and no
reply from **you** exists after that comment's timestamp, or where the
comment's most recent IDD-agent reply starts
`**Awaiting maintainer decision**` (remains an active
`ReviewItems_snapshot` entry regardless of the last-speaker exclusion
rule for this plain comment) — exclude periodic notification bots
(Renovate, etc.). Include Copilot/CI advisory bot comments; they follow
PATH B in E4-E7 (non-review notices are dispositioned under the E6
rule).

**Resolved-thread index (for the E5 duplicate pre-check).** Also carry
forward a light index of this PR's **resolved** threads
(`isResolved=true`): file/area, a short claim summary, source URL, and
any IDD-agent disposition marker found. Do **not** add resolved
threads back into ReviewItems_snapshot. This is a **routing hint
only** for E5's duplicate pre-check — it tells triage where a prior
recurrence might be, not what to conclude.

## E2 — Critique pass

Run a critique pass on the branch's changes and add any newly found
issues to ReviewItems_snapshot. See `idd-overview-appendix.instructions.md`
for per-agent implementation.

**Incremental review**: on later passes **within the same claim**,
scope the review to the diff since the previous E2 execution's head SHA
(tracked via same-claim, trusted-author `<!-- review-baseline: … -->`
comments — post a new one each run). Reset to full-branch diff after a
rebase, a multi-fix batch, when the baseline SHA isn't an ancestor of
current HEAD, when no trusted same-claim baseline exists, or whenever
the active `{claim-id}` changed (restart, takeover, forced handoff).
ReviewItems_snapshot is session-local; don't inherit a previous claim's
critique findings unless persisted as reviewer-visible comments.

After the critique pass, post a new `review-baseline` comment with the
current HEAD SHA (helper-first: profile-selected post-idd-marker
`--type baseline --target pr <pr-number> --agent-id <id> --claim-id
<id> --sha <head-sha> --apply`; `emit-marker --type review-baseline` is
emit-only; see `docs/idd-helper-scripts.md`):

```markdown
<!-- review-baseline: {agent-id} {claim-id} {SHA} -->

_{agent-id}: critique baseline — IDD automation marker. Do not edit._
```

Use the PR body's language for the visible note (same rule as the
watermark). Post via the GitHub REST API directly, or the
post-idd-marker `--apply` helper above. The same "nothing appended
after the note" rule applies here too.

## E3 — Empty list check

If ReviewItems_snapshot is empty → proceed to the E-phase branch-sync
check in `idd-review-triage.instructions.md`.

Otherwise → proceed to `idd-review-triage.instructions.md` (E4).

## Cold-start ReviewItems_snapshot reconstruction

Read this section when entering E4 (`idd-review-triage.instructions.md`)
or E9 (`idd-review-fix.instructions.md`) without ReviewItems_snapshot
from this episode's own E1-E3 pass -- following
`idd-overview-core.instructions.md`'s unconditional "Snapshot done" /
"Review feedback accepted" routing rows, or an orchestrator delegation
brief that hands off mid-review.

**Procedure**: run E1 Steps 1-3 above (Step 2 already posts the
watermark; do not post a second one) -- re-running them now _is_ the
reconstruction. Run edge case 2's steps 1-3
below unconditionally before E3 -- a local fix can predate E4 and
never re-surface there; edge case 1's check at E4 then covers it.
Then continue through E2, E3, and, only when E3 finds
ReviewItems_snapshot non-empty, E4-E8 in full before any E9 work --
an item edge case 1 routed to E14 runs E14, after edge case 2's own
push if any (targeting the post-push HEAD), before branch-sync.

Two correctness-sensitive gaps need an explicit rule (preventive; no
observed incident yet), since a naive rebuild can silently drop or
duplicate an item:

**Edge case 1 -- an item without a completed disposition.** Covers a
lost session mid-E4 classification (E6 defers PATH A Accept replies to
E13); one whose E12 push landed but lost the session before E13; and a
`CHANGES_REQUESTED` body Step 3 re-surfaces solely for a missing E14
request (its exclusion needs both) -- if it already carries an E13
`**Accepted** — fixed in` reply with no reviewer reply or reopen
since, skip reclassification and route straight to E14. Otherwise
Step 3 decides inclusion; the rebuild re-includes each as ordinary
work only when Step 3 does. Before E5
verifies it, check whether a branch commit newer than its timestamp
already fixes it (a lost E12 push, or edge case 2's local-ahead diff
below) -- both read false against E5's claim-truth test by design;
that commit is the confirmation, cap included, only when its diff
touches the item's anchored path(s) (its review-thread `path`, or a
file explicitly named in a regular comment's context) -- the
file-path-touch check; otherwise it is
not coverage and normal E5/E9 handling applies. A covered in-scope
reviewer-feedback PATH A item Accepts on that basis, skips E9, E13
cites the commit; everything else follows E5-E8 as normal.

**Edge case 2 -- an E9 fix committed but not yet pushed.** GitHub
cannot see this; a fix for a session-local E2 finding may never
re-surface at E4 (E2's findings are not durable) -- an empty E3
result alone is not proof there is nothing to recover, since F2 resets
the worktree to the PR's remote HEAD before merge. Run this
unconditionally, in the **same surviving claimed worktree**:

1. `PR_HEAD={head-SHA}` -- E1 Step 1's stored value; a re-fetch
   here could race an external rewrite and pass step 2 falsely.
2. `git merge-base --is-ancestor "$PR_HEAD" HEAD` -- a failure
   (external rewrite, diverged worktree) stops for reconciliation;
   never fall through to edge case 1's rule instead, which
   risks F2 discarding real local work.
3. `git status --porcelain` must report clean -- a dirty worktree
   can't prove which uncommitted lines belong to which item. Treat it
   as unverified input (never trust or discard): stop for
   reconciliation before E9 work.
4. `git log "$PR_HEAD"..HEAD` non-empty: record the diff -- edge
   case 1's check above covers this diff too. Either way, even with
   zero Accepted items, the diff still runs E10-E12 and pushes before
   branch-sync. **E3 empty** (an E2-only finding): resume at E10 for
   the diff itself -- E10, not E12, because a cold session cannot know
   whether E10's critique pass already ran against it, and
   [the fail-closed default](idd-overview-core.instructions.md#fail-closed-default)
   governs that ambiguity.

Clean worktree, no local-ahead commits: E3's own routing applies
unchanged. A fresh or lost worktree falls back to edge case 1's rule
instead, re-triaged from scratch.
