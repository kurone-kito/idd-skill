# IDD — Review Snapshot Phase (E1–E3)

Read this file after CI passes on a newly pushed PR, or after returning
from a fix cycle. It covers fetching review items (E1), running the
critique pass (E2), and checking whether List A is empty (E3).

Before posting any E-phase operational comment or GitHub reply, apply
the shared claim revalidation gate. The active claim must still use your
current `{claim-id}`.

**If List A is empty after E3**: proceed to `idd-pre-merge.instructions.md`.
**If List A is non-empty after E3**: proceed to
`idd-review-triage.instructions.md` (E4).

## E1 — Fetch review items into List A

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

Exclude **agent operational comments** from the snapshot: comments whose
body begins with one of these exact operational marker prefixes (posted
by any IDD agent):

- `<!-- review-watermark:`
- `<!-- review-baseline:`
- `<!-- claimed-by:`
- `<!-- unclaimed-by:`
- `advisory-wait:`
- `<!-- advisory-wait:`

Additionally, fetch the **current CI state** for `{head-SHA}`:
`gh pr checks {pr-number} --json name,state,completedAt`. Record the
`completedAt` of the most recently completed successful (or
treated-as-passed) CI run as `{latest-ci-completed-at}`, or `none` if no
CI pass exists yet for this HEAD.

**Step 2 — Record the watermark.** Using the `{head-SHA}` stored at the
start of Step 1, compute `{max-activity-updatedAt}` as the highest
`updatedAt` server timestamp across the **entire snapshot** (not just
the items that will appear in List A). Write `none` if the snapshot is
empty. Compute `{total-item-count}` as the total number of items in the
snapshot (0 if empty). Persist all six values immediately by posting a
PR comment with this format:

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

Note: the comment body begins with an HTML comment token. Some GitHub
client tools (e.g., `gh issue comment`, `gh api -f body=`) silently
reject bodies that consist entirely of HTML comments; this format
includes visible text so that is not an issue, but the HTTP `POST` path
is still recommended for reliability (`curl` with
`-H "Content-Type: application/json"` and
`-d '{"body":"<!-- ... -->\n\n_note_"}'`).

On resume or restart, read the latest
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment whose
embedded `{claim-id}` matches the current active claim to restore all
six values. Ignore watermark comments from any other claim. Legacy
watermarks without `{claim-id}` are not resumable across a restart or
takeover; if no same-claim watermark exists, rerun E1 from scratch.

**Step 3 — Filter into List A.** From the snapshot, select and combine
into **List A**. Record the source URL for each item.

**Review threads** (`isResolved=false`) — exclude threads where the
latest substantive reply is from any IDD agent or the PR author, and no
reviewer has replied since (awaiting-reviewer state). A thread is
**not** awaiting-reviewer (and therefore remains in List A as an active
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
Copilot and CI advisory bot comments; they follow PATH B in E4-E7.

## E2 — Critique pass

Run a critique pass on the branch's changes and add any newly found
issues to List A. See `idd-overview.instructions.md` for per-agent
implementation.

**Incremental review**: on the second and later passes **within the same
claim**, scope the review to the diff since the previous E2 execution's
head SHA (tracked via `<!-- review-baseline: … -->` PR comments — post
a new one after each E2 run; use the latest comment with that prefix
whose embedded `{claim-id}` matches the current active claim). Reset to
full-branch diff after a rebase, multi-fix batch, when the baseline SHA
is not an ancestor of the current HEAD, or whenever the active
`{claim-id}` changed due to restart or takeover. List A is
session-local; do not inherit a previous claim's critique findings
unless they were persisted as reviewer-visible comments.

After the critique pass completes, post a new `review-baseline` comment
with the current HEAD SHA using this format:

```markdown
<!-- review-baseline: {agent-id} {claim-id} {SHA} -->

_{agent-id}: critique baseline — IDD automation marker. Do not edit._
```

Use the PR body's language for the visible note (same rule as the
watermark). Example Japanese note:
`_{agent-id}: クリティークのベースライン — IDD 自動化マーカー。編集しないでください。_`

Post using the GitHub REST API directly (the body begins with an HTML
comment token; use the HTTP `POST` path for reliability).

## E3 — Empty list check

If List A is empty → proceed to `idd-pre-merge.instructions.md`.

Otherwise → proceed to `idd-review-triage.instructions.md` (E4).
