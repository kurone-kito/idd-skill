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

**Advisory non-review notice.** Before scoring a PATH B item, decide
whether it is a _completed_ advisory review of the current HEAD or an
**advisory non-review notice** — an advisory bot comment reporting that
it did **not** review the current HEAD. Treat these as non-review
notices: rate-limit-exceeded warnings, usage / quota / credit
exhaustion, queued / in-progress / "reviewing" status, a bare request
acknowledgement (e.g. CodeRabbit "Actions performed"), and error or
"temporarily unavailable" notices. A non-review notice carries no
advisory result to score; handle it with the E6 non-review-notice rule
instead of the normal PATH B disposition.

Then apply path-specific scoring:

- **PATH A**: assess severity and relevance to PR intent.
  - **High** (safety, correctness, requirement violations, CI stability)
    → **Accept forced**
  - **Low** (minor improvements unrelated to PR intent) → **Reject
    recommended**
  - **Medium** → judge by context
- **PATH B**: do **not** assign High / Medium / Low. Score only a
  _completed_ advisory review of the current HEAD here — decide whether
  it should be treated as `Accepted` (confirmed / useful context) or
  `Rejected` (noted, no action required). Route an advisory non-review
  notice (defined above) to the E6 non-review-notice rule instead.

## E5 — Record Accept / Reject decisions

Record a path-specific disposition for every item:

- **PATH A**:
  - High-severity items are Accepted automatically.
  - Medium- and Low-severity items require an explicit Accept or Reject
    decision.
- **PATH B** (a _completed_ review of the current HEAD):
  - `Accepted` means the advisory confirms the current implementation or
    captures useful context.
  - `Rejected` means the advisory is noted, but no action is required.
  - An advisory non-review notice (E4) is **not scored** here; it is
    still recorded, but always as `Rejected` per the E6 non-review-notice
    rule (it carries no advisory result to score).

Accepted PATH B items do **not** enter review-fix. They are fully
handled in E6-E7.

**Verify before accept (PATH B).** A PATH B advisory often asserts a fact
about the runtime, CI, or an artifact (for example "this needs a CI-token
permission", "this config leaks a credential", or "the artifact checksum
format is wrong"). Before you `Accept` such an item, **verify the claim
against the live runtime / artifact / CI run**, not against the comment text
alone:

- If the claim is confirmed on the live evidence, `Accept` and act on it.
- If the claim is **false on the live evidence**, disposition it `Rejected`
  and cite the contradicting evidence (the actual run conclusion, the real
  file contents, the real artifact). A verified-false advisory is a reasoned
  rejection, not an action item.

**Reasoned-rejection convergence.** The iterate-to-zero loop may converge by
reasoned rejection of truly peripheral or verified-false items; it does not
require a code change for every comment. Record the reason in the disposition
reply so the rejection is auditable. Confident bots still produce
false positives, so "a bot raised it" is never sufficient to force a change.

**Worked example.** A bot flags a "credential leak" on a config-only file.
You open the file, confirm it holds only public placeholders with no secret,
and reply starting exactly with `**Rejected**` — e.g.
`**Rejected** — verified: the flagged file contains only public
placeholders; no credential is present.`

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

- PATH B acceptance marker (only for a _completed_ review of the current
  HEAD): `**Accepted** — {what the advisory comment confirmed}`
- Ordinary rejection: `**Rejected** — {reason}`
- CODEOWNER / required reviewer exception:
  `**Awaiting maintainer decision** — {reasoning}`

Two requirements make the F2/F3 gate recognize each marker — it reads
`isDispositionComment` as "the body **starts with** the marker" and pairs
dispositions to advisory comments **1:1 by count**:

- The marker must be the **first bytes of the comment body** — no heading,
  block quote, or preamble before it, or the gate counts zero dispositions for
  that comment.
- Post **one disposition reply per advisory item**. Do **not** combine several
  markers into one comment: the 1:1 count pairing clears only one item per
  comment, so a combined reply leaves the rest flagged
  `missing-disposition-evidence`.

PATH B — Advisory items (completed review of the current HEAD):

- Reply immediately with a decision marker, even when no code change is
  needed. Use `**Accepted**` / "no findings / no action required"
  framing **only** when the advisory is a completed review of the
  current HEAD:
  - `**Accepted** — {what the advisory comment confirmed}`
  - `**Rejected** — {why no action is required}`
- **Review threads**: resolve immediately after posting the marker.
- **Regular comments**: reply only.
- Do not send PATH B items to review-fix. Their work is complete once
  the marker is posted and any thread resolution is done.

PATH B — Advisory non-review notice (rate-limit / quota / queued / bare
ack / error, as defined in E4):

- A non-review notice is **not itself a completed review** of the
  current HEAD and must never be treated as evidence of one, so it must
  never be dispositioned as a confirmation, "no findings", or "no action
  required because reviewed". (A non-review notice does not by itself
  prove that no review exists — if a separate _completed_ review of the
  current HEAD is also present, disposition that review under the
  completed-review rules above.)
- **Disposition it deterministically in the current pass — no
  re-request, no wait.** The notice item itself is **always rejected**,
  because it carries no advisory result — never record `**Accepted**` on
  the notice: `**Rejected** — {bot} did not review HEAD {sha}
  ({reason}); this is not a completed review`. Write `{bot}` as the bot's
  **GitHub login** (e.g. `coderabbitai[bot]`, `chatgpt-codex-connector[bot]`)
  so the carry-forward below can attribute the rejection to exactly that bot
  when several advisory bots are configured. A separate _completed_
  review of the current HEAD, if one is present, is a **distinct**
  ReviewItems_snapshot item dispositioned `**Accepted**` under the
  completed-review rules above — accept that review, not the notice.
  **Re-validate just before posting the rejection**: a completed review
  can race in after the E1 snapshot but before this rejection. If one
  has, disposition that review (Accepted) and take a fresh E1 snapshot,
  so the rejection's later timestamp does not filter the completed
  review out of the next pass. This
  keeps the disposition vocabulary unchanged for the E7 verifier and the
  F2/F3 gates, and never leaves the item pending across snapshots.
- **Carry the rejection forward across pushes — do not re-disposition an
  unchanged notice.** Once a non-review notice carries its `**Rejected** —
  {bot} did not review HEAD …` reply, that disposition **persists across later
  HEAD changes** while the same notice persists and the bot still has not
  reviewed any HEAD. A review-fix push that bumps the notice's `updatedAt` (or a
  re-posted identical rate-limit / usage-limit summary) does **not** require a
  fresh identical rejection: the F2/F3 disposition-evidence gate carries the
  existing rejection forward. The carry-forward is **scoped to the bot the
  rejection names** (by GitHub login), so a rejection of one advisory bot's
  notice never clears another bot's still-undispositioned notice. Re-disposition
  **only** when the bot replaces the notice with an actual completed review of
  the current HEAD — disposition that review under the completed-review rules
  above (the carry-forward no longer applies to a notice that became a real
  review).
- **Do not auto-request a fresh review from triage** to "upgrade" a
  non-review notice. Triggering a new review is a separate concern:
  Copilot advisory state is owned solely by the advisory-wait protocol
  in `idd-advisory-wait.instructions.md` (AW3 `REQUEST_NEEDED` → E14),
  and a maintainer may manually re-trigger a non-Copilot bot. Any review
  that later completes for the current HEAD is picked up and
  dispositioned normally on a subsequent E1 pass. **Never** post an
  `advisory-wait` marker for a non-Copilot bot — AW2/AW3 treat any
  trusted same-HEAD `advisory-wait` marker as Copilot evidence, so doing
  so could wrongly satisfy the Copilot advisory gate and consume its
  request cap.
- **Fail-closed honesty**: never cite a non-review notice as evidence
  that the advisory reviewer reviewed the current HEAD — not in the
  disposition reply, the `Authoritative by` line, or the PR live status
  digest.
- **Non-blocking boundary**: this rule does not make PATH B a merge
  blocker. The blocking advisory gate remains the Copilot advisory-wait
  protocol in `idd-advisory-wait.instructions.md`, which is unchanged.

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
  `idd-pre-merge.instructions.md` (F1). **First, only if E6 posted
  disposition replies** (any `**Accepted**` / `**Rejected**` reply on
  reviewer feedback, advisory items, or bot non-review notices), refresh
  the `review-watermark` so it covers them: re-post it for the same
  `{head-SHA}`, recomputing `{max-activity-updatedAt}` /
  `{total-item-count}` / `{latest-ci-completed-at}` over the current
  snapshot, following the E1 Step 2 rules (CI-completion precondition;
  hide superseded same-claim watermarks). Those replies are the
  current-claim agent absorbing its own deterministic dispositions, not
  new reviewer activity; without the refresh F2's review-currency treats
  them as newer activity and returns to E1 for an avoidable cycle. Do
  **not** refresh on the sync path (it re-snapshots at E1 after merging
  `main`) or on a hold (it stops without proceeding to F-phase).
- **`behind-no-conflict`** when branch protection or recorded repository
  policy requires an up-to-date head: → **sync path** below.
- **`content-conflict`** (`mergeable` is `CONFLICTING`): → **sync path**
  below.
- **`computing`** (`syncRecommendation` is `recheck`): `mergeable` is
  `UNKNOWN` / null because GitHub computes mergeability asynchronously and
  has not settled — a **transient** state. Do **not** hold. Re-poll after a
  short wait, up to a small fixed attempt budget (distributed default: 3
  attempts, a few seconds apart), then route by the first settled result.
  Only a state that is **still** `computing` / `unknown` after the budget
  falls through to the hold below.
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

## Advisory courtesy-ack convergence

A trusted advisory bot may reply with a courtesy/acknowledgement comment
after dispositions are posted (e.g. "thanks for confirming"). Because the
reply advances the PR's `updatedAt`, a naive review-currency re-check can
re-stale the watermark and loop the review/snapshot cycle without end if the
bot keeps acking.

**Rule**: once a `**Accepted**` / `**Rejected**` disposition exists for every
`ReviewItems_snapshot` item at the **current HEAD SHA**, a later **ack-only**
comment from a configured trusted advisory bot does **not** reopen the review
loop. Bind the merge to the current HEAD SHA and proceed rather than chasing a
moving watermark.

An **ack-only** comment is one from a trusted advisory bot (the configured
advisory-bot / trusted-marker identity) that, relative to the current HEAD,
opens no new review thread, carries no `CHANGES_REQUESTED`, and raises no new
actionable finding. A comment that adds a thread, requests changes, or raises a
new finding is **not** ack-only and re-opens the loop normally.

**Worked example**: after you disposition a CodeRabbit thread `**Rejected**`,
CodeRabbit replies "Thanks for confirming." on that same thread. No new thread
or finding is introduced, so the `updatedAt` advance is ignored: do not re-run
E1; continue to F-phase on the current HEAD SHA.

**Helper evidence**: when helper runtime is enabled and the advisory-bot
identity is configured (`advisoryBotLogins` in `.github/idd/config.json`,
the `--advisory-bot-logins` flag, or `IDD_ADVISORY_BOT_LOGINS`), the
activity-snapshot and `pre-merge-readiness` evidence emits the structural
part of this classification (the `reviewCurrency.live.ackOnly.items`, the
sibling `reviewCurrency.live.effective` activity values, and
`reviewCurrency.comparisonReason: ack-only-post-disposition`). The agent
still owns
the semantic residual — confirming the ack raises no new actionable
finding — and the evidence never weakens the disposition-evidence or
unreplied-comment gates, which remain the backstop.

**Disposition-evidence parity (advisory-only)**: the same post-disposition
advisory-bot ack can also re-block the `dispositionEvidence` backstop on an
already-resolved thread (`route: return-to-e1`,
`reason: missing-fresh-disposition`). The backstop default is unchanged, but
`pre-merge-readiness` now surfaces a deterministic signal: each such thread
carries `ackOnlyPostDisposition: true`, and the top-level
`dispositionEvidence.soleCauseAckOnlyPostDisposition` is `true` only when
**every** blocking item is one of those threads (no missing regular comments,
no non-ack thread). When that signal is `true`, autopilot may deterministically
override the `return-to-e1` and proceed on the current HEAD SHA (see
`idd-pre-merge.instructions.md` F2). The signal never changes `route`, and any
non-ack blocking cause makes it `false`, so the backstop still holds for every
other case.

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
