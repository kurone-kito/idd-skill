# IDD — Review Triage Phase (E1–E8)

Read this file after CI passes on a newly pushed PR, or after returning
from the review-fix phase. It covers fetching review items, running a
critique pass, classifying items, and recording dispositions.

Before posting any E-phase operational comment or GitHub reply, apply
the shared claim revalidation gate. The active claim must still use your
current `{claim-id}`.

**Skip condition E3**: if List A has zero items, skip to
`idd-merge.instructions.md`.

**Skip condition E8**: if the Accepted PATH A count after verification
is zero, skip to `idd-merge.instructions.md`.

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
`<!-- review-watermark:
{agent-id} {claim-id} … -->` comment whose
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

If List A is empty → proceed to `idd-merge.instructions.md`.

## E4 — Classify and score List A

For each item in List A, first classify it:

- **PATH A — actionable feedback**: human reviewer threads and regular
  comments, `CHANGES_REQUESTED` review bodies, and critique-pass
  findings that require a code change or maintainer decision.
- **PATH B — advisory feedback**: Copilot and CI advisory bot comments
  included by E1 for traceability, even when they do not require a code
  change.
- If classification is ambiguous, default to PATH A.

Then apply path-specific scoring:

- **PATH A**: assess severity and relevance to PR intent.
  - **High** (safety, correctness, requirement violations, CI stability)
    → **Accept forced**
  - **Low** (minor improvements unrelated to PR intent) → **Reject
    recommended**
  - **Medium** → judge by context
- **PATH B**: do **not** assign High / Medium / Low. Instead, decide
  whether the advisory should be treated as `Accepted` (confirmed /
  useful context) or `Rejected` (noted, no action required).

## E5 — Record Accept / Reject decisions

Record a path-specific disposition for every item:

- **PATH A**:
  - High-severity items are Accepted automatically.
  - Medium- and Low-severity items require an explicit Accept or Reject
    decision.
- **PATH B**:
  - `Accepted` means the advisory confirms the current implementation or
    captures useful context.
  - `Rejected` means the advisory is noted, but no action is required.

Accepted PATH B items do **not** enter review-fix. They are fully
handled in E6-E7.

## E6 — Post disposition replies

Apply the reply rules below after E5 records a disposition.

PATH A — Accepted items:

- Do not reply in triage solely to acknowledge the acceptance. Accepted
  reviewer feedback is replied to after the fix work in
  `idd-review-fix.instructions.md`.

PATH A — Rejected reviewer feedback:

For each Rejected PATH A item whose source is reviewer feedback:

- Reply using the format: `**Rejected** — {reason}`
- **Exception**: if the source is a CODEOWNER or required reviewer, do
  not reject unilaterally. Reply using the format:
  `**Awaiting maintainer decision** — {your reasoning}` and wait for the
  maintainer's response.
- After posting your reply, **immediately resolve the thread** — except
  when the reply is `**Awaiting maintainer decision**`. Resolving means
  "agent has acted (fixed or definitively rejected)", not "reviewer has
  agreed". If the reviewer disagrees with a regular rejection, they can
  reopen the thread and add a reply, which will re-surface it in a
  future E1 pass.
- **Exception to immediate resolution**: when you post
  `**Awaiting maintainer decision**`, do **NOT** resolve the thread.
  Leave it unresolved so F2's "Unresolved threads = 0" gate blocks merge
  until the maintainer responds. Post a separate hold comment on the PR
  explaining what you are waiting for. **This exception applies only
  when the source is a review thread.** For CODEOWNER or
  required-reviewer feedback that arrives as a regular PR comment (not a
  thread), there is no thread to leave unresolved, so AMD cannot
  structurally block merge via the unresolved-threads gate. In this
  case: reply with `**Awaiting maintainer decision** — {reasoning}`,
  post a separate hold comment explicitly stating that you will **not**
  merge until the maintainer's decision appears, and stop. Do not merge
  until the maintainer's response surfaces in a subsequent E1 pass (at
  which point: if they agree with rejection, close the AMD by replying
  to confirm and remove the hold comment; if they override, Accept the
  feedback and implement it).
- **When an `Awaiting maintainer decision` thread re-appears in List A**
  (because the maintainer has not yet responded in the thread): first
  check the full activity universe (PR review list, review threads, and
  regular PR comments) for any response from any CODEOWNER, required
  reviewer, or repository collaborator with merge authority (Write,
  Maintain, or Admin access, as reported by the GitHub collaborator
  permission API:
  `GET /repos/{owner}/{repo}/collaborators/{username}/permission`)
  **that is unambiguously about this rejected item**. The qualifying
  person must be **someone other than the acting agent and the PR
  author**, and the response must be **posted after your
  `**Awaiting maintainer decision**` comment**. The following count:
  - A reply added to this specific thread by any qualifying person (any
    CODEOWNER, required reviewer, or collaborator with Write, Maintain,
    or Admin access — same set as defined in the preceding sentence).
  - A separate regular PR comment or review that explicitly references
    this thread or item (by URL, line/file reference, or clear textual
    reference to it), authored by any qualifying person.

  General PR comments or reviews from any qualifying person that do not
  reference this thread do **not** count, even if they arrived after
  your `**Awaiting maintainer decision**` reply.

  If a qualifying response exists, treat it as the maintainer's response
  and apply the transitions below. If no qualifying response exists,
  verify that a hold comment already exists on the PR. Post one if it
  does not. Then stop; do not re-reply or resolve. Resume when the
  maintainer's response appears in a future E1 pass.
- **When the maintainer eventually responds** (their response surfaces
  in a future E1 pass as an unresolved thread or new reply):
  - If the maintainer **agrees with your rejection**: reply summarizing
    the agreed decision (e.g.,
    `**Rejection confirmed by maintainer** — {summary}`) and resolve the
    thread.
  - If the maintainer **disagrees**: move the item from Rejected to
    Accepted and proceed through the fix flow. Resolve the thread after
    fixing.
  - If the maintainer's response arrived in a separate PR comment or
    review rather than in the original thread: mirror the decision onto
    the original thread and resolve the thread. Also **reply to the
    maintainer's separate comment** (e.g., "Decision mirrored to the
    review thread — {link}") so that F2's unreplied-comments gate does
    not block merge on that comment.
- For a `CHANGES_REQUESTED` review body you are rejecting: post a PR
  comment explaining your reasoning and ask the reviewer to reconsider.
  - If the reviewer does not respond and the state does not change: post
    a hold comment (keep the claim) and stop. On the next agent
    heartbeat or resume, check elapsed time:
  - After 24 h of no response: escalate to a maintainer via issue or PR
    comment.
  - After 48 h of no escalation response: consider adding a
    `status:needs-decision` label and releasing the claim. The label may
    be removed and the issue re-claimed once the blocker is resolved.
  - If a maintainer or admin (other than the original reviewer) agrees
    with your rejection: that agreement is **not sufficient on its own**
    to clear F2's `CHANGES_REQUESTED` gate. Ask them to either obtain
    the original reviewer's state change or dismiss the review via the
    dismissals API above.
  - If the reviewer responds and agrees with your rejection, they must
    change their review state (re-submit as COMMENTED or APPROVED) or a
    repo admin must dismiss the review via
    `PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/dismissals`.
    Ask them to do so explicitly — a comment agreeing with your
    rejection is **not sufficient on its own** to clear F2's
    `CHANGES_REQUESTED` gate; the state must be cleared via a reviewer
    state change or an admin dismissal.
  - If the reviewer responds and disagrees: move the item to Accepted
    and proceed through the fix flow.
  - If the reviewer responds: restart from E1.
- If you decide "Reject now but should do eventually": open a new issue.

Use these prefixes so that disposition is always unambiguous:

- PATH B acceptance marker:
  `**Accepted** — {what the advisory comment confirmed}`
- Ordinary rejection: `**Rejected** — {reason}`
- CODEOWNER / required reviewer exception:
  `**Awaiting maintainer decision** — {reasoning}`

PATH B — Advisory items:

- Reply immediately with a decision marker, even when no code change is
  needed:
  - `**Accepted** — {what the advisory comment confirmed}`
  - `**Rejected** — {why no action is required}`
- **Review threads**: resolve immediately after posting the marker.
- **Regular comments**: reply only.
- Do not send PATH B items to review-fix. Their work is complete once
  the marker is posted and any thread resolution is done.

## E7 — Verify recorded dispositions

Before leaving triage, verify that every List A item has the evidence
required by its path:

- Every PATH A item has a recorded classification and an Accept or
  Reject decision.
- Every Rejected PATH A item whose source is reviewer feedback has the
  required rejection or `**Awaiting maintainer decision**` reply posted,
  and any non-AMD thread resolution is complete.
- Every PATH B item has a posted `**Accepted**` or `**Rejected**`
  marker. Review threads are resolved immediately after the marker.
- Only Accepted PATH A items remain candidates for
  `idd-review-fix.instructions.md`. PATH B items are fully closed out in
  triage.

If any check fails, do not continue. Return to E4-E6 as needed until the
missing evidence is recorded.

## E8 — Accepted PATH A count check

If the Accepted PATH A count is zero → proceed to
`idd-merge.instructions.md`.

Otherwise continue to `idd-review-fix.instructions.md`.
