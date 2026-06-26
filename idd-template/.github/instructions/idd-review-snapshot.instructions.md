# IDD — Review Snapshot Phase (E1–E3)

Read this file after CI passes on a newly pushed PR, or after returning
from a fix cycle. It covers fetching review items (E1), running the
critique pass (E2), and checking whether ReviewItems_snapshot is empty (E3).

Before posting any E-phase operational comment or GitHub reply, apply
the shared claim revalidation gate. The active claim must still use your
current `{claim-id}`.

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
- `<!-- claimed-by:`
- `<!-- unclaimed-by:`
- `advisory-wait:`
- `advisory-wait-recovery:`
- `<!-- advisory-wait:`

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

**Non-Copilot advisory safety net.** The advisory-wait protocol
(`idd-advisory-wait.instructions.md`) gives a settle/wait window to
**Copilot only**. In a repository that configures non-Copilot
`advisoryBotLogins` (for example CodeRabbit or a Codex connector), this
E1 activity-universe snapshot plus the `review-watermark` delta is the
**load-bearing safety net** for their late-arriving findings: a finding
that lands after CI goes green is caught here and by the F2/F3 currency
re-check, not by the Copilot advisory-wait window. This is why Step 1
fetches the entire activity universe and Step 2 records a watermark over
all of it.

**Step 2 — Record the watermark.** Using the `{head-SHA}` stored at the
start of Step 1, compute `{max-activity-updatedAt}` as the highest
`updatedAt` server timestamp across the **entire snapshot** (not just
the items that will appear in ReviewItems_snapshot). Write `none` if
the snapshot is
empty. Compute `{total-item-count}` as the total number of items in the
snapshot (0 if empty). Persist all six values immediately by posting a
PR comment with this format (when helper runtime is enabled, prefer the
**one-command** profile-selected post-idd-marker watermark path —
`--type watermark --from-pr <pr-number> --agent-id <id> --claim-id <id> --apply`
— which derives `{head-SHA}` / `{max-activity-updatedAt}` /
`{total-item-count}` / `{latest-ci-completed-at}` from a fresh
`review-activity-snapshot` of the PR and POSTs the marker in one step, so a
hand-typed head SHA cannot mis-route the F2 review-currency check (forward
`--trusted-marker-logins` here too when you pass it to the snapshot). The
manual six-field form — `--type watermark --target pr <pr-number>
<watermark-fields> --apply`, passing the same six values shown below as
`--agent-id` / `--claim-id` / `--head-sha` / `--max-activity-at` /
`--total-item-count` / `--ci-completed-at` — stays the fallback, as do
`emit-marker --type review-watermark` for emit-only rendering and the manual
HTTP `POST` below; see `docs/idd-helper-scripts.md`):

```markdown
<!-- review-watermark: {agent-id} {claim-id} {head-SHA} {max-activity-updatedAt|none} {total-item-count} {latest-ci-completed-at|none} -->

_{agent-id}: review triage snapshot — IDD automation marker. Do not edit._
```

The HTML comment is the machine-readable token; the italic line is a
visible note for human readers. Detect the language of the PR body and
write the visible note in that language (default to English if
ambiguous). Example Japanese note:
`_{agent-id}: レビュートリアージのスナップショット — IDD 自動化マーカー。編集しないでください。_`

- **`{head-SHA}`**: the value read at the very start of Step 1, before
  any fetching. F2 uses this to detect pushes that occurred between E1's
  snapshot and the watermark comment post.
- **`{latest-ci-completed-at}`**: the `completedAt` of the latest CI
  pass observed during this E1 snapshot (or `none`). F2 uses this to
  detect a new CI pass that completed after the snapshot fetch.
- **E1 execution marker**: the GitHub-assigned `createdAt` of this
  comment (set server-side). Used only to verify the watermark is
  recent; activity and CI freshness are tracked via the data fields
  above.

Use server-reported timestamps, not the local wall clock.

**CI-completion precondition.** Post the `review-watermark` only **after**
every CI run that will count toward the merge gate has completed — including
any opt-in / label-triggered job enabled at the quiescent pre-merge point.
Operationally: enable the late job, await its completion, **then** take the
Step 1 snapshot and post the watermark. A merge-gate-counting run
completing _after_ the watermark advances HEAD's latest CI time and forces a
wasted E1↔F2 round-trip (F2's `ci-pass-drift` return-to-E1) even though no new
review activity occurred.

Note: the comment body begins with an HTML comment token. Some GitHub
client tools (e.g., `gh issue comment`, `gh api -f body=`) silently
reject bodies that consist entirely of HTML comments; this format
includes visible text so that is not an issue, but the HTTP `POST` path
is still recommended for reliability (`curl` with
`-H "Content-Type: application/json"` and
`-d '{"body":"<!-- ... -->\n\n_note_"}'`). The post-idd-marker helper
referenced above performs exactly this JSON `POST` under `--apply`.

On resume or restart, read the latest
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment whose
embedded `{claim-id}` matches the current active claim and whose GitHub
author is a trusted marker actor to restore all six values. Ignore
watermark comments from any other claim or from untrusted authors.
Legacy watermarks without `{claim-id}` are not resumable across a
restart or takeover; if no trusted same-claim watermark exists, rerun E1
from scratch.
After forced handoff, all prior-claim watermarks are foreign restore
markers. Do not delete, hide, minimize, or otherwise unmark them on an
open PR to "clear" state; ignore them and rerun E1 under the successor
claim instead.

**Hide superseded same-claim watermarks.** After the new watermark is
verified to exist on GitHub, minimize every strictly older trusted
**same-claim** `review-watermark` and `review-baseline` comment on
this PR as `OUTDATED`. The new watermark covers their data, and
hiding them reduces F4 backlog and review-page noise.

Find candidate subject IDs (trusted same-claim watermarks older than
the new one), then call:

```sh
node scripts/minimize-superseded-markers.mjs \
  --subject-ids "<id1>,<id2>,..." \
  --classifier OUTDATED \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" \
  --apply
```

Skip this step entirely if the new watermark was not verified to
exist on GitHub, the candidate set is empty, or the helper is
unavailable — F4 cleanup still catches the superseded markers later.

Different-claim watermarks (forced-handoff successors, takeovers)
must not be hidden here — that is covered separately by the claim
takeover hide path in `idd-claim.instructions.md`.

Do not create or edit the PR live status digest after posting this
watermark unless the next route is to E1, to an F3 blocked reroute that
leaves the F2 restart path (F1/D4), to a hold/stop, or to post-merge
cleanup. The F3 awaiting-reviewer restart-F2 path skips digest edits so
that F2 can restart without self-invalidating review currency. A digest
edit after the watermark is new PR activity for review-currency purposes
and would require a fresh E1 snapshot before F2 can pass.

**Step 3 — Filter into ReviewItems_snapshot.** From the snapshot, select and combine
into **ReviewItems_snapshot**. Record the source URL for each item.

**Review threads** (`isResolved=false`) — exclude threads where the
latest substantive reply is from any IDD agent or the PR author, and no
reviewer has replied since (awaiting-reviewer state). A thread is
**not** awaiting-reviewer (and therefore remains in ReviewItems_snapshot as an active
item) if any of the following is true:

- The reviewer reopened (unresolved) the thread after the latest
  substantive reply from any IDD agent or the PR author, even if no new
  text was added.
- The thread contains a reply from any IDD agent that starts with
  `**Awaiting maintainer decision**` — these threads remain active
  blockers regardless of whether the maintainer has responded yet.

**Review bodies** where the reviewer's latest state is
`CHANGES_REQUESTED` — exclude reviews already replied to and re-review
requested in a previous E13/E14 pass.

**Regular comments** where the last speaker is not any IDD agent, and no
reply from **you** (the current agent) exists after that comment's
timestamp — exclude periodic notification bots (Renovate, etc.). Include
Copilot and CI advisory bot comments; they follow PATH B in E4-E7
(advisory non-review notices — rate-limit / quota / queued / bare
request acknowledgement / error — are dispositioned under the E6
non-review-notice rule).

## E2 — Critique pass

Run a critique pass on the branch's changes and add any newly found
issues to ReviewItems_snapshot. See `idd-overview-appendix.instructions.md`
for per-agent implementation.

**Incremental review**: on the second and later passes **within the same
claim**, scope the review to the diff since the previous E2 execution's
head SHA (tracked via `<!-- review-baseline: … -->` PR comments — post
a new one after each E2 run; use the latest comment with that prefix
whose embedded `{claim-id}` matches the current active claim and whose
GitHub author is a trusted marker actor). Reset to full-branch diff
after a rebase, multi-fix batch, when the baseline SHA is not an
ancestor of the current HEAD, when no trusted same-claim baseline
exists, or whenever the active `{claim-id}` changed due to restart or
takeover, including forced handoff. ReviewItems_snapshot is session-local; do not
inherit a previous claim's
critique findings unless they were persisted as reviewer-visible
comments.

After the critique pass completes, post a new `review-baseline` comment
with the current HEAD SHA using this format (when helper runtime is
enabled, prefer the profile-selected post-idd-marker command — `--type
baseline --target pr <pr-number> --agent-id <id> --claim-id <id> --sha
<head-sha> --apply` — to render and POST it in one step; `emit-marker
--type review-baseline` stays the emit-only render path; see
`docs/idd-helper-scripts.md`):

```markdown
<!-- review-baseline: {agent-id} {claim-id} {SHA} -->

_{agent-id}: critique baseline — IDD automation marker. Do not edit._
```

Use the PR body's language for the visible note (same rule as the
watermark). Example Japanese note:
`_{agent-id}: クリティークのベースライン — IDD 自動化マーカー。編集しないでください。_`

Post using the GitHub REST API directly (the body begins with an HTML
comment token; use the HTTP `POST` path for reliability) — or the
post-idd-marker `--apply` helper above, which performs that JSON `POST`.

## E3 — Empty list check

If ReviewItems_snapshot is empty → proceed to the E-phase branch-sync
check in `idd-review-triage.instructions.md`.

Otherwise → proceed to `idd-review-triage.instructions.md` (E4).
