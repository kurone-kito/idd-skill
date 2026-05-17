# IDD — Review Triage Phase (E4–E8)

Read this file after `idd-review-snapshot.instructions.md` (E3) finds
ReviewItems_snapshot is non-empty. It covers classifying items, scoring, recording
dispositions, and counting accepted items.

Before posting any E-phase operational comment or GitHub reply, apply
the shared claim revalidation gate. The active claim must still use your
current `{claim-id}`.

**Skip condition E8**: if the Accepted PATH A count after verification
is zero, proceed to the **E-phase branch-sync check** below.

## E4 — Classify and score ReviewItems_snapshot

For each item in ReviewItems_snapshot, first classify it:

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
- **When an `Awaiting maintainer decision` thread re-appears in ReviewItems_snapshot**
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
  - After `reviewEscalation.changesRequestedFirstEscalation`
    (distributed default: `PT24H`) of no response: escalate to a
    maintainer via issue or PR comment.
  - After `reviewEscalation.changesRequestedSecondEscalation`
    (distributed default: `PT48H`) of no escalation response: consider adding a
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

When helper runtime is enabled, prefer the read-only verifier command:

```sh
idd-review-disposition-verify --items '<json>'
```

In the source repository, `node scripts/review-disposition-verify.mjs`
is equivalent evidence collection. E7 consumes helper fields `passed`,
`items[].passed`, `items[].checks`, and `items[].issues`.
This helper never posts replies or resolves threads: all E6 mutations
remain manual and authoritative. If helper execution fails, output is
invalid JSON, required fields are missing, or helper output conflicts
with observed review state, discard helper output and apply the written
E7 checks below directly.

Before leaving triage, verify that every ReviewItems_snapshot item has the evidence
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

After E7 succeeds, update the PR live status digest only when doing so
will not invalidate a merge-bound E1 snapshot. Safe update points are:
when triage posts a hold and stops, when Accepted PATH A items remain
and the next route is E9, or when the update is followed by a fresh E1
snapshot before F2. Set `Phase` to `E triage`, summarize remaining
Accepted PATH A work or `none` in `Open blockers`, set `Next action` to
E9 or F2 as appropriate, and cite the disposition replies plus the
trusted review-watermark in `Authoritative by`. If
ReviewItems_snapshot is empty and the next step is F2, defer the digest
update unless you intentionally
return to E1 afterward.

## E8 — Accepted PATH A count check

If the Accepted PATH A count is zero → proceed to the
**E-phase branch-sync check** below.

Otherwise continue to `idd-review-fix.instructions.md`.

## E-phase branch-sync check

After the review loop confirms no PATH A items remain (from E3 or E8),
check the current branch state before routing to F-phase. This gate uses
merge-from-`main` (never rebase) when synchronization is required,
preserving review history on the already-published PR branch.

When helper runtime is enabled, call:
`idd-branch-conflict-state --pr {pr-number}`

Otherwise read branch state directly:

```sh
gh pr view {pr-number} --json mergeable,mergeStateStatus
```

Route based on `branchState` from the helper (or `mergeable` /
`mergeStateStatus` from `gh pr view`):

- **`clean`** or **`behind-no-conflict`** when branch protection does not
  require an up-to-date head: proceed to
  `idd-pre-merge.instructions.md` (F1).
- **`behind-no-conflict`** when branch protection or recorded repository
  policy requires an up-to-date head: → **sync path** below.
- **`content-conflict`** (`mergeable` is `CONFLICTING`): → **sync path**
  below.
- **`dirty`** (`mergeStateStatus` is `DIRTY`) or **`unknown`**: hold; post
  a PR comment documenting the state and stop. Do not proceed to F-phase
  without confirmed branch-state evidence.

**Sync path** (merge-from-`main`):

1. **Active review gate**: if the PR has unresolved review threads,
   unreplied comments, or any reviewer's latest state is
   `CHANGES_REQUESTED`, get explicit operator confirmation before merging
   `main` into the feature branch, as the merge commit will appear in the
   PR history.
2. Merge `main` into the feature branch:
   `git fetch origin main && git merge origin/main`
3. If conflicts arise, resolve them and complete the merge.
4. Run **post-fix-validate**.
5. Push the feature branch normally (no force push required for merge
   commits).
6. Return to `idd-review-snapshot.instructions.md` (E1).

## Review item classes

During E-phase review triage, classify each ReviewItems_snapshot item
into one of two paths before deciding what to do with it:

- **PATH A — actionable feedback**: human reviewer comments,
  `CHANGES_REQUESTED` review bodies, and critique-pass findings that
  require a code change or a maintainer decision. Score severity, choose
  Accept or Reject, and send only Accepted PATH A items to the
  review-fix phase.
- **PATH B — advisory feedback**: Copilot and CI advisory bot comments
  that E1 intentionally includes for traceability, even when they do not
  require a code change. Record an explicit `**Accepted**` or
  `**Rejected**` marker during triage, then verify that marker before
  merge.
- If a source is ambiguous, treat it as PATH A until a maintainer
  narrows it. PATH B is reserved for explicitly advisory bot feedback
  already included by E1.

PATH B items are fully handled inside review triage. They never enter
the review-fix phase.
