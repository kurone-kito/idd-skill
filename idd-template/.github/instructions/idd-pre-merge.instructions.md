# IDD — Pre-Merge Conditions Phase (F1–F2)

Read this file after the E-phase branch-sync check confirms no
synchronization is required, or when returning to merge gate checks
after a sync cycle. It covers a final read-only branch-state check
(F1) and the full pre-merge condition checklist (F2).

This phase includes a repository-specific GitHub Copilot advisory review
gate. Even when another local agent is driving the workflow, follow it
because the dependency is on GitHub review state, not on the local CLI.

The merge-gate timing defaults referenced by F2 are named in
[IDD policy constants](../../docs/policy-constants.md). Use that inventory
for the canonical values, not as a behavior override.

Before any F-phase mutating action, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

After a forced handoff on an open PR, the successor must rebuild review
state through E1/E2 under its own `{claim-id}` before merge-bound
routing continues. A live status digest or prior-claim operational
marker is UI or audit context only; it cannot satisfy review currency,
claim ownership, advisory wait, or CI gates.

When all F2 conditions are satisfied, proceed to
`idd-merge-handoff.instructions.md`.

## F1 — Final branch-state check

Read the current branch state. When helper runtime is enabled, call:
`idd-branch-conflict-state --pr {pr-number}`

Otherwise read the state directly:

```sh
gh pr view {pr-number} --json mergeable,mergeStateStatus
```

This check is read-only — F1 does not rebase, merge, or push.

- **`clean`** (`mergeable` is `MERGEABLE` and `mergeStateStatus` is
  `CLEAN`) or **`behind-no-conflict`** when no up-to-date-head policy
  applies: proceed to F2.
- **`behind-no-conflict`** when branch protection or recorded repository
  policy requires an up-to-date head, or **`content-conflict`**
  (`mergeable` is `CONFLICTING`): return to the E-phase branch-sync check
  in `idd-review-triage.instructions.md`. Before returning, update the PR
  live status digest with `Phase: F1 sync-required`, the branch state in
  `Open blockers`, and `Next action: E-phase branch-sync`.
- **`dirty`** (`mergeStateStatus` is `DIRTY`) or **`unknown`**: hold; post
  a PR comment documenting the branch state and stop. Do not proceed to F2
  without confirmed clean branch-state evidence. A maintainer must clear
  the hold.

## F2 — Pre-merge condition check

Verify **all** of the following. If any condition is not met, follow the
bracketed action:

Before running F3, record explicit F2 evidence for this pass. At
minimum, capture:

1. Activity-universe snapshot evidence:
   `{head-SHA}`, `{max-activity-updatedAt|none}`,
   `{total-item-count}`, `{latest-ci-completed-at|none}`.
2. Unresolved-thread evidence: total unresolved thread count, the
   non-awaiting-reviewer unresolved count used by the gate, and whether
   any AMD (`**Awaiting maintainer decision**`) threads remain.
3. Unreplied regular-comment evidence: the count of non-IDD-agent
   comments that still lack a later IDD-agent reply.
4. Reviewer-state evidence: latest `CHANGES_REQUESTED` status for human,
   required, and CODEOWNER reviewers, plus required approval/CODEOWNER
   satisfaction status.
5. Advisory-wait evidence: current AW outcome (`SATISFIED`/`WAIT`/etc),
   marker presence (`EARLIEST_SAME_HEAD_AT`), and whether the current
   state satisfies the advisory gate for merge.
6. CI evidence: required-check generation state and pass/fail status for
   all required checks on the current PR HEAD.
7. E7 disposition evidence: whether each actionable PATH A item and
   advisory PATH B item has a fresh `**Accepted**`/`**Rejected**`
   disposition marker, plus the exact missing-thread and
   missing-regular-comment blocker items when incomplete.

Do not treat "one bot says clean" as sufficient evidence. The checklist
must cover the full activity universe (human reviewers plus advisory bot
surfaces such as Copilot, CodeRabbit, Codex connectors, and CI bots) and
must align with every F2 condition below.

- **Review currency** (live re-fetch required, freshness gate): read the
  most recent `<!-- review-watermark: {agent-id} {claim-id} … -->`
  comment whose embedded `{claim-id}` matches the current active claim
  and whose GitHub author is a trusted marker actor. The comment's first
  two fields identify the watermark — (a) agent-id and (b) claim-id,
  already used to locate this comment. Extract the remaining values:
  (c) the `{head-SHA}` value; (d) the `{max-activity-updatedAt}` value
  (`none` if empty); (e) the `{total-item-count}` value; (f) the
  `{latest-ci-completed-at}` value (`none` if empty). If no trusted
  same-claim watermark exists, return to E1 unconditionally. Legacy
  watermarks without `{claim-id}` must not be reused across a restart or
  takeover, and same-claim watermarks from untrusted authors must be
  ignored and reported as suspicious context when they affect routing.
  Forced-handoff successors must treat prior-claim watermarks the same
  way even when the branch and HEAD are unchanged. Do not delete, hide,
  minimize, or otherwise unmark open-PR operational markers during this
  recovery; if no trusted same-claim watermark exists for the successor
  claim, return to E1 and rebuild review state there.
  When helper runtime is enabled, prefer the documented merge-gate
  helper reference in
  [`docs/idd-helper-scripts.md`](../../docs/idd-helper-scripts.md#stable-helper-evidence-outputs)
  to collect this evidence. Consume helper evidence from
  `reviewCurrency` (including `comparisonRoute`), `threads`,
  `unrepliedComments`, `reviewerStates`, `advisoryWait`, `ci`, `claim`,
  and optional `dispositionEvidence`.
  Helpers remain read-only evidence collectors: if helper execution
  fails, output is invalid JSON, required sections are missing, or live
  GitHub state disagrees with helper output, discard helper output and
  fetch the activity universe snapshot (same scope as E1 Step 1) plus
  current CI state for the HEAD SHA directly. The instruction rules
  remain canonical. Return to E1 if **any** of the
  following is true:
  - The current PR HEAD SHA differs from the stored `{head-SHA}` (a new
    push occurred after E1's snapshot, even if the watermark comment was
    posted later).
  - The stored value is `none` and the live snapshot is non-empty (the
    PR was empty at E1 time but now has review activity).
  - The stored value is not `none`, and any fetched item's `updatedAt`
    is strictly newer than `{max-activity-updatedAt}` (new activity
    arrived since last E1 run).
  - The stored value is not `none`, and the live total item count
    exceeds `{total-item-count}` (new items arrived at the same
    timestamp as the stored max, which would not be caught by the
    previous check).
  - The current latest CI pass `completedAt` for HEAD differs from
    `{latest-ci-completed-at}` in the watermark (a new CI run completed
    after E1's snapshot; if watermark value is `none`, any current CI
    pass triggers re-evaluation).
- **Advisory bot wait** (restart-safe enforcement): `PR_HEAD_SHA` is
  already available from the review-currency check above. Apply the
  advisory-wait protocol (`idd-advisory-wait.instructions.md`):

  1. Run **AW1**. If **SATISFIED** → this check is **satisfied**;
     continue to the **CI** check.
  2. Run **AW2** to fetch markers.
  3. Apply the **AW3** decision table:
     - **SATISFIED** → this check is **satisfied**; continue to the CI
       check.
     - **HOLD** → post the hold comment from **AW4** and stop.
     - **RECOVERY_NEEDED** → post the recovery marker from **AW3-R**
       without requesting another Copilot review, then enter the normal
       WAIT polling path using refreshed AW2/AW3 state. Then **go back
       to the first condition in F2**.
     - **CAP_EXHAUSTED** → post the cap-exhausted hold comment from
       **AW4** and stop.
     - **REQUEST_NEEDED** → return to E14 to request Copilot review and
       post a fresh marker. Do not post a new request in F2.
     - **WAIT** (`COPILOT_PENDING` is `"true"`, elapsed <
       `PENDING_WINDOW_MINUTES` min) → wait for the remainder of the
       applicable window (poll every `POLL_INTERVAL_MINUTES` min),
       refreshing `EARLIEST_SAME_HEAD_AT` per **AW2** at each iteration
       and applying **AW5** if the marker disappears. Then **go back to
       the first condition in F2** (the 'Review currency' check) to
       re-evaluate all conditions.
     - **WAIT** (`COPILOT_PENDING` is `"false"`, elapsed <
       `SETTLED_WINDOW_MINUTES` min) → wait for the remainder of the
       settled window (same polling rules). Then **go back to the first
       condition in F2**.

  GitHub removes a reviewer from `requested_reviewers` when they submit
  a review OR when the request is manually cancelled — either counts as
  no longer pending for merge purposes.
- **CI**: Current PR head SHA has all required CI checks generated and
  all passing (→ run CI wait per `idd-ci.instructions.md` using the
  same resolved `ciWait.runningTimeout`, `ciWait.generationTimeout`, and
  `ciWait.rerunPolicy` values; on-success → re-evaluate F2).

  **External-check waivers**: When `pre-merge-readiness` reports a check
  as `coveredByWaiver: true` in its output, a trusted maintainer has
  authorized skipping that specific check under the current head SHA and
  active claim. Treat it as passing for F2/F3 routing **only when**:
  - `waiverEvidence.valid` is non-empty for that check's selector
  - The waiver actor is a trusted marker login
  - The waiver `headSha` matches the current PR HEAD
  - The waiver `claimId` matches the active claim
  - The waiver `expiresAt` is in the future

  Waivers never bypass review currency, advisory wait, unresolved
  threads, unreplied comments, required reviews, disposition evidence,
  or claim ownership. If `waiverEvidence.wrongHead`, `wrongClaim`,
  `unauthorized`, `expired`, or `malformed` are non-empty, report them
  as suspicious context and do not treat them as valid permissions.
- **Required reviews**: Required approvals count is satisfied and all
  CODEOWNER approvals are obtained. If helper evidence includes
  `reviewerStates.codeownerSelfApproval`, include that diagnostic in the
  F2 evidence and any hold comment when its `status` is `deadlock` or
  `possible_deadlock`. `deadlock` means the current PR/ruleset/CODEOWNER
  topology cannot be satisfied by ordinary self-approval; `possible_deadlock`
  means the helper could not prove an eligible non-author CODEOWNER or
  applicable pull-request bypass, so fail closed. This diagnostic is
  evidence only and never permission to bypass the Required reviews
  gate. If approvals are absent but there are no open actionable review
  items (ReviewItems_snapshot is empty), do **not** route to E1 —
  instead, request CODEOWNER/required reviewers directly (if not already
  requested), post a hold comment, and stop. Return to E1 only when
  there are actual review threads or comments to address (→ go to
  `idd-review-snapshot.instructions.md` only in that case).
- **No `CHANGES_REQUESTED`** (human/required/CODEOWNER reviewers only):
  No human, required, or CODEOWNER reviewer's latest state is
  `CHANGES_REQUESTED` (→ if not yet addressed, return to review triage;
  if already addressed and re-review requested, wait up to 30 min; if
  still no response, post a hold comment and stop). Advisory bot
  reviewers (Copilot, CI bots) are exempt from this check — their
  `CHANGES_REQUESTED` state does not block merge after the advisory wait
  window completes.
- **Unresolved threads = 0** (backlog gate, orthogonal to the currency
  check above): No unresolved review threads remain, excluding
  **awaiting-reviewer threads**. A thread is awaiting-reviewer if
  **all** of the following hold: (1) the latest substantive thread
  comment is from any IDD agent or the PR author; (2) no reviewer has
  added a comment after that latest IDD-agent/PR-author comment; (3) the
  reviewer has **not** reopened the thread after that latest comment — a
  reopen action with no new text still counts as reviewer activity and
  disqualifies the thread from awaiting-reviewer status; (4) the thread
  does **not** contain an IDD-agent reply starting with
  `**Awaiting maintainer decision**`. (→ return to review triage if any
  non-awaiting-reviewer unresolved threads remain). Any remaining
  unresolved thread that is not awaiting-reviewer indicates a new
  reviewer comment or a thread the reviewer reopened — both require
  attention. Exception: if the repo's branch protection requires
  conversation resolution, the awaiting-reviewer exclusion does not
  apply — all unresolved awaiting-reviewer threads must be resolved.
  Note: AMD threads (those containing an IDD agent reply starting with
  `**Awaiting maintainer decision**`) are **not** awaiting-reviewer by
  definition; they are handled by the standard "non-awaiting-reviewer →
  return to review triage" path, where E6 will detect the pending
  maintainer response and post a hold. For each remaining unresolved
  awaiting-reviewer thread under this exception: **(a)** if its latest
  reply is from an **IDD agent** and it does **NOT** contain an AMD
  reply — resolve it directly (direct resolution is permitted under this
  constraint), then restart F2 from the beginning; **(b)** if the latest
  reply is from the **PR author** (not an IDD agent) — post a brief
  acknowledgement reply (e.g., "Acknowledging thread state to satisfy
  conversation-resolution requirement") then resolve it directly, then
  restart F2. Do **not** route to E1; E1 filters out awaiting-reviewer
  threads and would surface no actionable item.
- **Unreplied comments = 0**: No regular comment from a non-IDD-agent
  lacks a subsequent IDD-agent comment — where "subsequent" means any
  IDD-agent regular comment posted at a strictly later timestamp than
  that non-IDD-agent comment (→ return to review triage). This mirrors
  E1's regular-comment filter for non-advisory discussion. Copilot and
  CI advisory bot comments are handled earlier in the PATH B triage flow
  (E4-E7) and are excluded from this gate.
- **E7 disposition evidence complete**: If helper evidence includes a
  `dispositionEvidence` section, require
  `dispositionEvidence.route == "proceed"` and
  `dispositionEvidence.blockingCount == 0`. If either check fails, route
  to E1/E4 with the missing-thread or missing-comment evidence reported
  from that section. This gate consumes the `pre-merge-readiness`
  `dispositionEvidence` shape only; do not substitute E7 verifier fields
  (`passed`, `items[]`) here.

When any F2 condition routes to a hold/stop or back to E1/E14, update
the PR live status digest after the blocking evidence is recorded and
before stopping or returning. Set `Phase` to the failing F2 check,
`Open blockers` to the concrete unmet condition, `Next action` to the
required reviewer, CI, advisory, maintainer, or agent action, and
`Authoritative by` to the F2 evidence fetched in this pass. If every F2
condition is satisfied, do **not** edit the digest before F3; carry the
F2 snapshot forward unchanged so the final F3 freshness check can use
the same activity universe.

Note: `required_approvals` is fetched at runtime from the ruleset. The
practical blockers are `CHANGES_REQUESTED` states and missing CODEOWNER
approvals only. When all conditions above are satisfied, record the
live-fetch result as the **F2 snapshot**: the current PR HEAD SHA
(`{f2-head-SHA}`), the highest `updatedAt` across all fetched items
(`{f2-max-activity-updatedAt}`, written as `none` if the snapshot is
empty), the total item count (`{f2-total-item-count}`), and the latest
CI pass `completedAt` for HEAD (`{f2-latest-ci-completed-at|none}`).
Carry all four values into the handoff phase. Then proceed to
`idd-merge-handoff.instructions.md`.
