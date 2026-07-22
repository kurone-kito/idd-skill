# IDD — Pre-Merge Conditions Phase (F1–F2)

Read this file after the E-phase branch-sync check confirms no sync is
required, or when returning to merge gate checks after a sync cycle.
Covers the read-only branch-state check (F1) and pre-merge checklist
(F2).

This phase includes a repo-specific GitHub Copilot advisory review
gate. Follow it under any local agent — the dependency is on GitHub
review state, not the local CLI.

F2's merge-gate timing defaults are named in
[IDD policy constants](../../docs/policy-constants.md) — canonical,
not an override.

Before any F-phase mutating action, apply the
[shared claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate).

After a forced handoff on an open PR, the successor must rebuild
review state through E1/E2 under its own `{claim-id}` before
merge-bound routing continues. A live status digest or prior-claim
marker is UI/audit context only — it cannot satisfy review currency,
claim ownership, advisory wait, or CI gates.

When all F2 conditions are satisfied, proceed to
`idd-merge-handoff.instructions.md`.

## F1 — Final branch-state check

Read the current branch state. When helper runtime is enabled, call:
`idd-branch-conflict-state --pr {pr-number}`

Otherwise read the state directly:

```sh
gh pr view {pr-number} --json mergeable,mergeStateStatus,headRefOid,baseRefName
git fetch --no-tags origin {base-branch}
git merge-base {pr-head-sha} FETCH_HEAD
# vs: git rev-parse FETCH_HEAD; mismatch/unresolvable (undetermined) =
# baseAdvancedSinceMergeBase: true below (best-effort, no deepen-retry)
```

This check is read-only — F1 does not rebase, merge, or push.

- **`clean`** (`mergeable` is `MERGEABLE` and `mergeStateStatus` is
  `CLEAN`) or **`behind-no-conflict`** when no up-to-date-head policy
  applies: proceed to F2. `clean` is conflict-freeness only; if
  `baseAdvancedSinceMergeBase: true`, prefer a fresh CI result over an
  old green check (base may have moved since the merge-base).
- **`behind-no-conflict`** when branch protection or recorded repository
  policy requires an up-to-date head, or unreadable/ambiguous (fails
  closed per the shared default), or **`content-conflict`** (`mergeable`
  is `CONFLICTING`): return to the E-phase branch-sync check in
  `idd-review-triage.instructions.md`. Before returning, update the PR
  live status digest with `Phase: F1 sync-required`, the branch state in
  `Open blockers`, and `Next action: E-phase branch-sync`.
- **`computing`** (`syncRecommendation` is `recheck`): `mergeable` is
  `UNKNOWN` / null because GitHub computes mergeability asynchronously and
  has not settled yet (common right after E1 posts its watermark/baseline) —
  a **transient** state, not a terminal one. Do **not** hold. Re-poll the
  branch state after a short wait (the helper is a single read; the wait
  belongs to this caller), up to a small fixed attempt budget (distributed
  default: 3 attempts, a few seconds apart), then route by the first settled
  result. Only if it is **still** `computing` (or `unknown`) after the budget
  is exhausted, fall through to the terminal hold below.
- **`dirty`** (`mergeStateStatus` is `DIRTY`) or **`unknown`**: hold; post
  a PR comment documenting the branch state and stop. Do not proceed to F2
  without confirmed clean branch-state evidence. A maintainer must clear
  the hold.

## F2 — Pre-merge condition check

Verify **all** conditions below; each states its required evidence and
failure route. The F2 snapshot at the end records the final
activity-universe values the handoff phase consumes.

Do not treat "one bot says clean" as sufficient evidence — checks must
cover the full activity universe (human reviewers plus advisory bot
surfaces such as Copilot, CodeRabbit, Codex connectors, and CI bots).

When the repository configures non-Copilot `advisoryBotLogins` (e.g.
CodeRabbit or a Codex connector), the advisory-wait window does
**not** cover those bots (`idd-advisory-wait.instructions.md` —
Copilot-only). F2/F3 MUST NOT merge on a bare CI-green signal: the
**Review currency** check below must confirm a fresh snapshot whose
`review-watermark` covers the latest activity timestamp, so a
non-Copilot finding landing shortly after CI still returns the
workflow to E1 instead of merging over it.

**Nonce passthrough**: when invoking the readiness collector below
(directly, or via the documented merge-gate helper reference), pass
`--nonce {nonce}` — this session's own locally-recorded activation-nonce
from claim time (`idd-claim.instructions.md`'s activation-nonce format) —
alongside `--claim-id`. This extends the same activation-nonce collision
detection that `idd-claim.instructions.md`'s Claim verification step 5
already performs at claim time (for a live session's own claim or
adopt-verbatim) to the merge-time write-gate too — a distinct case from
Resume-phase cold recovery, which does not yet thread `--nonce` (see
`docs/idd-design-rationale.md`'s "Scope for #1522" note and #1529).
Omitting `--nonce` silently skips the merge-time comparison rather than
failing closed, so pass it whenever a nonce was recorded for the active
claim.

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
    pass triggers re-evaluation). A late label-triggered job after the
    watermark commonly causes this; sequence it before E1; this is not a fault.

  Structural ack-only carve-out: when the only trigger above is newer
  activity or count growth, and the helper evidence proves it consists
  solely of post-disposition acknowledgements from the configured
  advisory bots (the `reviewCurrency.live.ackOnly.items` are all
  ack-only, with the sibling `reviewCurrency.live.effective` values
  current and `reviewCurrency.comparisonReason:
  ack-only-post-disposition`), the advisory courtesy-ack convergence
  rule in `idd-review-triage.instructions.md` applies: do not return to
  E1 for that activity alone. The agent still confirms the semantic
  residual, and every other trigger and gate is unaffected.

  A current-claim agent's own post-watermark disposition replies are
  expected convergence activity, not reviewer input; the watermark refresh
  on the E-phase branch-sync `clean` / `behind-no-conflict`
  (direct-to-F-phase) route (`idd-review-triage.instructions.md`)
  re-covers them so this check passes on the refreshed watermark. If a
  return-to-E1 is triggered solely by those disposition replies, refresh
  the watermark rather than treating them as new reviewer activity.
- **Advisory bot wait** (restart-safe enforcement): schedule a wake, or
  background only if the topology-safety condition holds (confirmed to
  route completion back to this turn); otherwise wait synchronously.
  `PR_HEAD_SHA` is already available from the review-currency check above.
  Apply the advisory-wait protocol (`idd-advisory-wait.instructions.md`):

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

  **No required checks configured**: When `pre-merge-readiness` reports
  `ci.noRequiredChecksConfigured: true` (an unprotected branch, or a branch
  with no required status checks), the CI gate is **not** satisfied
  vacuously — that state is reported distinctly from "all required checks
  passed". Route by `ci.presentRunConclusion` over the actual runs on the
  current HEAD:
  - `all-passing` → the CI gate may pass (every present run completed green).
  - `pending` → wait per `idd-ci.instructions.md`, then re-evaluate F2.
  - `some-failing`, or `none` (no runs exist at all) → **hold**; do not
    merge on a vacuous green. Route to an operator or blocked state.

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
  **awaiting-reviewer threads**. Classify each unresolved thread:

  | Condition                                                                                                                                                | Classification              |
  | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
  | Latest substantive comment is from an IDD agent or the PR author **and** no later reviewer comment **and** no later reviewer reopen **and** no AMD reply | `awaiting-reviewer`         |
  | Thread contains an IDD-agent reply starting with `**Awaiting maintainer decision**`                                                                      | `AMD-thread` (not awaiting) |
  | Reviewer added a comment or reopened (with or without new text) after the latest IDD-agent/PR-author comment                                             | `not awaiting-reviewer`     |
  | Latest substantive comment is from a reviewer (no IDD-agent or PR-author reply yet)                                                                      | `not awaiting-reviewer`     |

  `→ return to review triage` if any non-awaiting-reviewer (including
  AMD-thread) unresolved threads remain — E6 will detect any pending
  maintainer response and post a hold.

  Exception: if the repo's branch protection requires conversation
  resolution, the awaiting-reviewer exclusion does not apply and all
  unresolved awaiting-reviewer threads must be resolved here. For each
  remaining unresolved awaiting-reviewer thread under that exception:

  | Latest reply author                        | Action                                                                                                                                                         |
  | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | IDD agent (and no AMD reply on the thread) | resolve directly, then restart F2 from the beginning                                                                                                           |
  | PR author (not an IDD agent)               | post a brief acknowledgement reply (e.g., "Acknowledging thread state to satisfy conversation-resolution requirement"), then resolve directly, then restart F2 |

  Do **not** route to E1; E1 filters out awaiting-reviewer threads
  and would surface no actionable item.
- **Unreplied comments = 0**: No regular comment from a non-IDD-agent
  lacks a subsequent IDD-agent comment — where "subsequent" means any
  IDD-agent regular comment posted at a strictly later timestamp than
  that non-IDD-agent comment (→ return to review triage). This mirrors
  E1's regular-comment filter for non-advisory discussion. Copilot and
  CI advisory bot comments are handled earlier in the PATH B triage flow
  (E4-E7) and are excluded from this gate.
- **Advisory convergence** (exit-code obligation for Copilot-authored
  review threads, not a judgment call): run `node
  scripts/advisory-convergence.mjs --pr {pr-number} --assert` (or the
  profile-selected `idd-advisory-convergence` command). A non-zero exit
  is a hard merge block — route to E1/E4 (check **AW6** first when
  `sameHeadReroll.eligible`) using the `reasons`; a zero exit
  (`ready: true`) satisfies this condition.
  Separately, require `dispositionEvidence.missingRegularComments.length
  == 0` (ad hoc advisory-bot or reviewer comments outside a review
  thread, which the helper above does not cover); treat absent,
  malformed, or non-list `dispositionEvidence`/`missingRegularComments`
  as unmet, not as vacuously satisfied. A non-empty (or unusable) result
  routes to E1/E4 with that evidence.
  Fails closed per the shared default: if either check cannot run or its
  output is unusable, treat this condition as unmet.

When any F2 condition routes to a hold/stop or back to E1/E14, update
the PR live status digest after the blocking evidence is recorded and
before stopping or returning. Set `Phase` to the failing F2 check,
`Open blockers` to the concrete unmet condition, `Next action` to the
required reviewer, CI, advisory, maintainer, or agent action, and
`Authoritative by` to the F2 evidence fetched in this pass. If every F2
condition is satisfied, do **not** edit the digest before F3; carry the
F2 snapshot forward unchanged so the final F3 freshness check can use
the same activity universe.

Note: `required_approvals` is ruleset-fetched; only `CHANGES_REQUESTED`
and missing CODEOWNER approvals block. When satisfied, record the
live-fetch result as the **F2 snapshot**: the current PR HEAD SHA
(`{f2-head-SHA}`), the highest `updatedAt` across all fetched items
(`{f2-max-activity-updatedAt}`, written as `none` if the snapshot is
empty), the total item count (`{f2-total-item-count}`), and the latest
CI pass `completedAt` for HEAD (`{f2-latest-ci-completed-at|none}`).
Carry all four values into the handoff phase. Then proceed to
`idd-merge-handoff.instructions.md`.
