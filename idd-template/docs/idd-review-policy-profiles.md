---
type: guide
title: IDD Review Policy Profiles
description: Names the supported PR review policy profiles and the instruction files an adopter must edit to select one other than the Copilot-advisory default.
tags: [review-policy, profiles]
---

# IDD Review Policy Profiles

IDD separates the execution loop from the pull request review policy as
much as possible. The default template still ships with a GitHub Copilot
advisory review step, but adopters should choose a profile explicitly
before they treat the imported workflow as final.

This page names the supported policy shapes and the instruction files
that need customization when a repository does not use the default.

## PR Review Profile Summary

| Profile            | Use when                                                                                      | Review signal                                                                          | Merge gate                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `copilot-advisory` | The repository wants the distributed default.                                                 | GitHub Copilot is requested after review-fix pushes and before merge freshness checks. | CI, human/required reviewer states, unresolved conversations, and the Copilot advisory wait.          |
| `human-required`   | A maintainer, CODEOWNER, or required reviewer must approve every PR.                          | Human review is the authoritative review signal.                                       | CI, branch protection, required reviewer approval, and unresolved conversations.                      |
| `no-advisory`      | The repository intentionally relies on CI and branch protection without an advisory reviewer. | No bot advisory reviewer is requested by IDD.                                          | CI, branch protection, human review only when configured outside IDD, and unresolved conversations.   |
| `external-bot`     | The repository wants a non-Copilot advisory bot.                                              | A named review bot provides advisory feedback with a stable completion signal.         | CI, human/required reviewer states, unresolved conversations, and the external bot's advisory signal. |

## Default Profile

`copilot-advisory` is the only profile implemented directly by the
distributed template. It keeps the current behavior:

- E14 can request a Copilot re-review for the current PR head.
- F2 and F3 can wait or hold based on Copilot advisory state.
- Copilot's inline review-thread comments are PATH A; Copilot's other
  comments and CI advisory comments are handled as PATH B feedback
  during review triage.

Use this profile when GitHub Copilot pull request review is available
and the operator accepts it as an advisory signal rather than a required
human approval.

The advisory wait windows, request cap, and CI wait defaults are named in
[IDD policy constants](policy-constants.md), so adopters can record those
values separately from the review profile choice.

## Profile Artifacts

The exported template includes profile artifacts under `profiles/`.
In the idd-skill source repository, find those artifacts at
`idd-template/profiles/`; in adopter repositories, they live at
`profiles/`. Each non-default artifact is a documented
patch surface that records adopter-owned values, files to edit, and
verification evidence for the selected profile.

Use the artifact when choosing `human-required`, `no-advisory`, or
`external-bot` instead of reconstructing the edit surface from memory.
The checklist below remains the policy contract; the artifact packages
that checklist into a reusable onboarding unit.

## Human-Required Profile

Use `human-required` when a person, CODEOWNER, or required reviewer is
the review authority. IDD can still collect and triage review feedback,
but the Copilot advisory wait should be removed or disabled.

Customize these surfaces after import:

- `.github/instructions/idd-review-fix.instructions.md`: remove the E14
  Copilot re-review request and wait path.
- `.github/instructions/idd-pre-merge.instructions.md`: make required
  reviewer approval and branch protection the explicit F2 review gate.
- `.github/instructions/idd-merge.instructions.md`: remove final
  Copilot advisory rechecks while keeping CI, claim, freshness, and
  unresolved-thread checks.
- Repository settings: configure CODEOWNERS, required reviews, or
  branch protection outside IDD.

## No-Advisory Profile

Use `no-advisory` only when the repository intentionally wants the
lightest PR policy: CI, branch protection, and any human review rules
configured outside IDD. This profile should not silently weaken an
existing required-review policy.

Customize the same phase files as `human-required`, but document that
there is no advisory reviewer to request, wait for, or recover. Keep the
normal review snapshot and triage phases because human comments can
still arrive on a PR.

## External-Bot Profile

Use `external-bot` when a repository wants an advisory reviewer such as
a third-party review bot instead of GitHub Copilot. Treat the bot as
advisory only if it has all of these properties:

- A stable GitHub actor identity or requested-reviewer signal.
- A clear way to prove the bot reviewed the current PR head.
- A clear completion, skipped, or unavailable state.
- A policy for classifying the bot's comments as PATH A or PATH B.

Customize these surfaces after import:

- `.github/instructions/idd-advisory-wait.instructions.md`: replace
  Copilot-specific fetch, request, pending, and wait logic with the
  external bot's equivalent signals.
- `.github/instructions/idd-review-fix.instructions.md`: request the
  external bot after pushes, or document why it is requested outside IDD.
- `.github/instructions/idd-pre-merge.instructions.md` and
  `.github/instructions/idd-merge.instructions.md`: replace Copilot
  advisory rechecks with the external bot gate.
- `.github/instructions/idd-review-snapshot.instructions.md` and
  `.github/instructions/idd-review-triage.instructions.md`: update PATH
  B rules if the external bot's comments are advisory.

If the external bot can produce blocking `CHANGES_REQUESTED` reviews or
decision-relevant comments, classify those items as PATH A unless the
operator explicitly narrows them.

### Configuring a primary and one or more optional secondary advisory bots

The `advisoryWait.primaryBotLogin` and `advisoryWait.secondaryBotLogin`
config fields let a profile choose which bot the advisory-wait gate tracks and
add one or more **optional, non-gating** fallbacks. Set
`advisoryWait.primaryBotLogin` to route the gate to a non-Copilot bot (it
defaults to Copilot). Set `advisoryWait.secondaryBotLogin` to a second
requestable review bot — or an array of several — when the repository wants
one or more fallbacks while the primary is throttled: IDD then requests each
configured secondary **once per HEAD** only when the primary is
cap-exhausted or stalled / rate-limited. Every secondary is a
**supplement only** — none of them ever satisfies the primary advisory-wait
gate, receives a primary `advisory-wait` marker, or consumes the primary's
request cap, and each one's output is ordinary advisory input (classified
PATH A / PATH B by the snapshot and triage rules). Leaving
`advisoryWait.secondaryBotLogin` unset (or a value that normalizes to an
empty list, for example every entry equal to the primary) keeps single-bot
behavior. Pick each secondary from a requestable reviewer whose
`--add-reviewer` request appears on the PR timeline so the once-per-HEAD
guard can observe it. A configured `advisoryWait.secondaryQuietWindow`
(F2's quiet-window wait) folds every configured secondary's own settlement
before it applies — see [IDD policy constants](policy-constants.md) for the
exact fold rule.

## PR Review Profile Edit Surfaces

Use this checklist when a repository records a PR review profile during
onboarding or changes it later. The checklist is the review-policy
contract: the selected profile is not complete until the repository has
recorded the decision, updated the matching phase behavior, and captured
verification evidence.

Apply these shared checks for every profile:

- Record the selected PR review profile in repository documentation that
  future IDD sessions read.
- Record the review-thread resolution profile separately; it is not
  implied by the PR review profile.
- When maintaining the idd-skill source repository, keep source docs and
  exported template docs in sync; when adopting this template, keep
  copied docs and local onboarding notes in sync.
- Run the repository's documented validation commands after editing
  docs or phase instructions.

### `copilot-advisory` Edit Surface

Use the distributed template behavior when Copilot advisory review is
available and desired.

- Documentation: record that the repository keeps `copilot-advisory`.
- Phase instructions: keep
  `.github/instructions/idd-advisory-wait.instructions.md`,
  `.github/instructions/idd-review-fix.instructions.md`,
  `.github/instructions/idd-pre-merge.instructions.md`,
  `.github/instructions/idd-merge.instructions.md`,
  `.github/instructions/idd-review-snapshot.instructions.md`, and
  `.github/instructions/idd-review-triage.instructions.md` aligned with
  the imported default.
- Policy values: record whether the repository keeps or customizes the
  advisory wait and request-cap defaults listed in
  [IDD policy constants](policy-constants.md).
- Verification evidence: confirm that Copilot can be requested or
  observed on a PR and that the E14/F2/F3 advisory wait paths still name
  Copilot intentionally.

### `human-required` Edit Surface

Use this profile when a maintainer, CODEOWNER, or required reviewer is
the authoritative review gate.

- Documentation: record the human review authority, required reviewer
  source, and branch protection or CODEOWNERS rule that enforces it.
- `.github/instructions/idd-review-fix.instructions.md`: remove the E14
  Copilot re-review request and wait path, or replace it with a
  human-review handoff that cannot be mistaken for an advisory bot wait.
- `.github/instructions/idd-advisory-wait.instructions.md`: mark the
  Copilot advisory wait helper unused by this profile, or remove local
  references to it from the customized phase flow.
- `.github/instructions/idd-pre-merge.instructions.md`: make required
  human approval, branch protection, unresolved conversations, CI,
  freshness, and claim evidence the F2 gate.
- `.github/instructions/idd-merge.instructions.md`: remove final
  Copilot advisory rechecks while keeping CI, claim, freshness, required
  review, and unresolved-thread checks.
- `.github/instructions/idd-review-snapshot.instructions.md` and
  `.github/instructions/idd-review-triage.instructions.md`: keep human
  comments in the review universe and remove assumptions that Copilot
  advisory PATH B items must appear.
- `.github/idd/config.json`: set `reviewPolicy` to `human-required`.
  Do not register `idd-advisory-convergence` as a required check
  unless this policy actually wants an advisory-bot gate.
- Repository settings: configure CODEOWNERS, required reviews, or branch
  protection outside IDD.
- Verification evidence: capture a dry-run or PR-state example showing
  that a PR without required human approval cannot proceed to merge.

### `no-advisory` Edit Surface

Use this profile only when the repository intentionally relies on CI,
branch protection, and any human review rules configured outside IDD.

- Documentation: record that no advisory reviewer is requested or waited
  on, and confirm that this does not weaken an existing required-review
  policy.
- `.github/instructions/idd-review-fix.instructions.md`: remove the E14
  advisory request and wait path.
- `.github/instructions/idd-advisory-wait.instructions.md`: mark the
  advisory wait helper unused by this profile, or remove local
  references to it from the customized phase flow.
- `.github/idd/config.json`: set `reviewPolicy` to `no-advisory`.
  Do not register `idd-advisory-convergence` as a required check
  unless this policy actually wants an advisory-bot gate.
- `docs/idd-advisory-wait-shell-fallback.md`: mark the doc unused by
  this profile, or remove local references to it, matching the
  `idd-advisory-wait.instructions.md` disposition above.
- `.github/instructions/idd-pre-merge.instructions.md`: gate on CI,
  branch protection, unresolved conversations, freshness, and claim
  evidence without requiring an advisory reviewer.
- `.github/instructions/idd-merge.instructions.md`: remove final
  advisory rechecks while keeping the other F3 safety gates.
- `.github/instructions/idd-review-snapshot.instructions.md` and
  `.github/instructions/idd-review-triage.instructions.md`: keep human
  comments in scope and remove advisory-only PATH B requirements.
- Verification evidence: capture a PR-state example showing that the
  workflow no longer requests or waits for an advisory reviewer, while
  CI and branch protection remain merge gates.

### `external-bot` Edit Surface

Use this profile when a named non-Copilot bot supplies the advisory
signal.

- Documentation: record the bot actor, how the bot is requested, the
  current-head coverage signal, completion or skipped state, timeout
  policy, and unavailable-state recovery path.
- `.github/instructions/idd-advisory-wait.instructions.md`: replace
  Copilot-specific fetch, request, pending, recovery, and wait logic with
  the external bot's equivalent signals.
- `.github/instructions/idd-review-fix.instructions.md`: request the
  external bot after review-fix pushes, or document why an outside
  system requests it.
- `.github/instructions/idd-pre-merge.instructions.md`: replace Copilot
  advisory checks with the external bot gate for the current PR head.
- `.github/instructions/idd-merge.instructions.md`: repeat the external
  bot freshness gate immediately before merge.
- `.github/instructions/idd-review-snapshot.instructions.md` and
  `.github/instructions/idd-review-triage.instructions.md`: define which
  bot comments are PATH A, which are PATH B, and how blocked or
  unavailable bot states are surfaced.
- Verification evidence: capture a PR-state example showing the bot
  reviewed the current head and that stale, missing, or unavailable bot
  state blocks or holds according to the recorded policy.

## Hybrid review-reply identity (shipped)

These rules are the landed contract after the hybrid review-reply
roadmap siblings (`#2135`, `#2136`, `#2137`, `#2139`). They are
present-tense operator and phase behavior, not a current-state hazard
warning.

- **IDD-originated reply identity.** An IDD disposition or E13 reply
  starts with the visible `**Accepted**` / `**Rejected**` (or
  `**Awaiting maintainer decision**`) prefix. After the visible
  disposition body it carries the prefix-aware HTML-comment stamp
  `<!-- {markerPrefix}-review-reply -->` (default `idd-skill`).
  Helpers such as `resolve-review-thread --apply` and
  `disposition-non-review-notices --apply` inject the stamp. A
  manual `gh api` JSON body must append it. The stamp is utterance
  identity. It is **not** the E1 `review-watermark` snapshot marker
  (`<!-- review-watermark: … -->`), which records activity-universe
  counts and never substitutes for a disposition.
- **Unmarked human replies.** On a **human-authored** review thread,
  an unmarked human reply (no stamp, no `**Accepted**` prefix) is
  presence-only: a reply exists, so the thread is not
  `unresolved-without-fresh-disposition` solely for lacking
  `**Accepted**`. That rule does not license the owning session to
  post bare prose on its own items.
- **Advisory-bot threads still need an IDD disposition.** A Copilot
  or configured-advisory-bot thread still requires a stamped or
  legacy trusted IDD disposition, or resolution for
  `advisory-convergence` Clause 2. The stamp only counts when its
  author is also a trusted marker actor or IDD agent login -- it is
  utterance identity among already-trusted accounts, never an
  independent trust signal, so a stamped reply from any other account
  is ordinary external feedback, not a disposition. An unmarked human
  `ok` does not clear those threads either.
- **Required-check trigger.** The required
  `idd-advisory-convergence` job is **not** created by an unmarked
  human `pull_request_review_comment`. IDD-originated comments
  (disposition prefix, reply-identity stamp, or an operational
  marker the check already honors) refresh the existing HEAD run
  from the companion `idd-advisory-convergence-comment.yml`
  workflow. Ordinary human prose does not create or cancel the
  required check.
- **`reviewPolicy`.** `human-required` and `no-advisory` make
  `advisory-convergence` `not_applicable` (ready without Copilot
  clauses). `copilot-advisory`, `external-bot`, absent, or an
  invalid value keep today's primary-bot applicability. Do not
  register the check as required unless the chosen policy actually
  wants an advisory-bot gate.

Phase files that tell an agent to post a disposition name the stamp
on both the helper path and the manual `gh api` path:
`idd-review-triage.instructions.md` (E6) and
`idd-review-fix.instructions.md` (E13). F2 evaluation of unmarked
human vs Copilot threads lives in
`idd-pre-merge.instructions.md`.

## Review Thread Resolution Profiles

Review-thread resolution is a separate policy from who reviews the PR.
The distributed default is `fast-agent-resolve`: after an agent accepts
and fixes feedback, rejects it with a recorded rationale, or handles PATH
B advisory feedback, the agent may resolve the associated thread. This
means "the agent acted on the thread," not "the reviewer agreed."

Repositories that use a different review culture can choose a stricter
profile during onboarding:

| Profile                   | Use when                                                                                  | Agent may resolve                                                                                      | Merge consequence                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `fast-agent-resolve`      | The repository wants the distributed default and values a fast agent-managed review loop. | Human and bot threads after accepted fixes, rejected rationales, or PATH B advisory handling.          | F2/F3 may proceed once remaining unresolved threads are either resolved or classified as awaiting reviewer. |
| `hybrid-reviewer-ack`     | Human reviewers expect to confirm human-thread fixes, but bot/advisory threads can close. | Bot/advisory threads; human threads only after reviewer or maintainer acknowledgement.                 | F2/F3 must hold human review threads open until acknowledgement appears and branch protection is satisfied. |
| `strict-reviewer-resolve` | The team treats thread resolution as reviewer-owned.                                      | No human threads; optionally no bot threads unless the repository documents that exception separately. | F2/F3 must wait for reviewer or maintainer resolution before merge.                                         |

Changing away from `fast-agent-resolve` is a workflow change. Update
these files together with the recorded profile decision:

- `.github/instructions/idd-review-triage.instructions.md`: adjust E6
  thread-resolution behavior after PATH A and PATH B dispositions, and
  E7 verification so stricter profiles do not require the fast default.
- `.github/instructions/idd-review-snapshot.instructions.md`: adjust E1
  awaiting-reviewer filtering when human threads must remain visible
  until reviewer acknowledgement.
- `.github/instructions/idd-review-fix.instructions.md`: adjust E13
  resolution after accepted feedback fixes.
- `.github/instructions/idd-pre-merge.instructions.md`: adjust F2
  unresolved-thread handling and awaiting-reviewer exclusions.
- `.github/instructions/idd-merge.instructions.md`: adjust F3
  conversation-resolution fallback behavior.
- Repository settings: confirm whether branch protection requires
  conversation resolution, because that setting can make unresolved
  acknowledged threads block regardless of the selected profile.
- The [needs-decision deferral](#needs-decision-deferral) section below:
  its record step resolves a deferred thread only as the selected profile
  allows, so keep that step consistent with the recorded profile decision.

## Needs-decision deferral

This section is the full rule for the needs-decision route. Where review
triage and review-fix stop for a person today, a session may instead
defer a finding that needs a person's judgment to a follow-up issue and
keep the pull request moving, when merging the pull request as it stands
is safe. The instruction files carry only a short pointer at each stop,
and each pointer ends with the existing stop, so a session that does not
read this section behaves as it did before the route existed. The
decision record is in the
[design rationale](idd-design-rationale.md#needs-decision-deferral-of-review-findings-kurone-kitoidd-skill3776).

**Switch.** The route applies only while the resolved
`critiqueLoop.deferNeedsDecision` is `"on"`, which is the default. The
[customization guide](customization.md) states the resolution rule. A
value of `"off"`, or any other value that rule does not honor, restores
every stop below exactly as it stands.

**Stop sites.** The route can replace these stops, and no others:

- **S1, E5 judgment.**
  `.github/instructions/idd-review-triage.instructions.md`, E5: an
  inconclusive item from an actor without standing is routed to the
  `Awaiting maintainer decision` hold. Standing means CODEOWNER, required
  reviewer, Triage, Write, Maintain or Admin, the actor-permission cap's
  set. E5 is also where a session unsure of a disposition would ask the
  operator on the spot. A critique-pass finding that is inconclusive
  stays under the cap and is Rejected with a reasoned reply, so that
  finding is never held.
- **S2, E6 "Exception".**
  `.github/instructions/idd-review-triage.instructions.md`, E6: a
  CODEOWNER or required-reviewer source, and any inconclusive item, gets
  that hold.
- **S3, E10 hold.**
  `.github/instructions/idd-review-fix.instructions.md`, convergence
  guardrails: the no-progress hold, and the sentence that unresolved High
  or Medium findings remain blockers until fixed or explicitly
  redirected by a maintainer.
- **S4, Tier 2 and Tier 3.**
  `.github/instructions/idd-review-fix.instructions.md`: each tier ends
  in a stop for a person to decide.

**When it applies.** The route is available only when the session would
otherwise hold for a person or ask the operator at S1, S2, S3 or S4, and
every outstanding finding in that stop comes from an advisory bot, a
critique pass, or a person holding none of the standing above, or is an
E5 inconclusive item from such a source. If any outstanding finding in a
stop comes from another source, the stop holds as it does today.

**What counts.** At S1 and S2, a verified-true finding with one
reasonable resolution, or with alternatives equivalent in observable
behavior, is Accepted and fixed, as today. Defer only when two or more
materially different resolutions exist that the claimed issue's
acceptance criteria and the repository evidence do not rank, or when the
claim cannot be verified because the check it needs has no route in E5's
Verify-before-accept. A verified-true finding that an acceptance
criterion of the claimed issue is unmet, or that reports a regression
this pull request introduced, is Accepted and fixed and is never
deferred: conditions (a) and (b) of the E5 Defer rule's adopt-now test
still apply. At S3 and S4 the stop itself is the trigger, because the
loop cannot land the fix. There the stop test below alone decides and the
S1 and S2 carve-out in this paragraph does not apply, since Tier 3's
open-ended gaps are the acceptance criterion itself and may be deferred.

**Stop test.** Judge it assuming the finding is correct. Hold, as today
(the existing hold comment and its resume condition, and the
needs-decision claim release in
`.github/instructions/idd-overview-appendix.instructions.md` when no
session-side action remains), when merging the pull request as
it stands would:

1. leave the development branch's CI red or the pull request unmergeable;
2. leave the defect the finding describes in claim, lock, merge-gate,
   security or secret-handling, or data-destroying code or behavior, of
   the loop or of the project;
3. ship an instruction or helper contradiction that would misguide the
   next session's agent; or
4. be impossible to reverse in a follow-up pull request.

Otherwise defer.

**The deferral.** File one follow-up per distinct decision. Items that
share one question share one follow-up, and a needs-decision item is
never bundled with round-count or urgency deferrals. File it through the
`issue-authoring` skill with the defer-source value
`review-needs-decision` (the marker is
`<!-- {markerPrefix}-authoring-defer-source: review-needs-decision -->`),
in the shape that skill's contract specifies. For Tier 2, Tier 3 and E10
the decision asked is concrete: accept the residual as a known
limitation, or schedule the work. A Tier 2 deferral keeps the required
behavior in place and ends only the stop. When the finding could not be
verified, the reply names the unavailable check and the follow-up records
the claim as unverified, so a valid high-severity report is never
silently resolved.

**Records.** A finding on a review thread gets the reply below, with the
reply stamp described under "Hybrid review-reply identity" above, and
then the thread is resolved (reply first, as `resolve-review-thread`
does) only as the selected review-thread resolution profile allows. Where
the profile does not allow resolving, the thread stays unresolved and F2
holds it as that profile already does, so the stop stays in effect. A
regular comment gets the reply only, as E6 says. A finding with no
thread, such as an E10 critique-pass finding, needs no reply. For every
deferral the pull request body's follow-up section names the follow-up,
edited under E12's PR-body safeguards, as the record a person
merging will read; the F3 gate counts the follow-up when text on the pull
request names it, such as the body or a non-operational comment. No
helper checks that the body's follow-up section lists every deferral.

```text
**Rejected** — deferred to follow-up issue #<n> (needs-decision; <check or choice that is open>): <reason>
```

**Cap.** The fourth distinct follow-up filed from one pull request holds
as it does today. A reply that reuses an existing follow-up does not
count, and the count is read from the pull request body's follow-up
section, also after a crash-resume. This bounds over-deferral by a weak
model and the backlog F3 searches (preventive; no observed incident yet).

**Resume.** At S1 and S2 the deferral is one more Reject inside the
triage pass: finish the remaining E5 decisions and E6 replies, then E7
and E8, as after any other Reject. At S3 and S4, continue at E11 after
the record: E11 only checks the branch and E12 pushes only what is
unpushed, and an E10 or Tier stop can leave unpushed E9 commits. Deferred
findings leave the E10 same-findings comparison. After a Tier 3
deferral, all outstanding gaps go in one follow-up and further findings
of the same domain reuse it.

**Recurrence.** First read this pull request's body follow-up section and
its earlier replies for a follow-up naming the same finding: the same
file area and substantive claim, as the resolved-thread duplicate
pre-check defines it, or the same source comment. Then, because search
indexing can lag, search open issues whose body carries the
`review-needs-decision` marker and a sole `Refs` line naming the claimed
issue, and that cite the same finding. On a match, reuse it; a
crash-resume does the same, and appends the new thread link to the
follow-up as a comment. A follow-up that is already closed means the
decision was made, so the finding is judged afresh. F3's follow-up search
fails closed at its result cap, which a growing backlog could reach
(preventive; no observed incident yet).

**Claimless.** A pull request with no claimed issue holds as it does
today, because the follow-up needs a `Refs` line and a `Blocked by` line
naming one.

**Precedence.** If the E5 Defer rule already defers an item, it goes to
that bundled follow-up and the route does not apply to it. For
needs-decision items only, this route wins over E4's "Accept forced",
E5's rule that a High item reaches Accepted only through
Verify-before-accept, that rule's exclusions for an item on the
awaiting-maintainer-decision hold and for an Accepted item mid-fix, and
its bundling sentence. E6's "Reject now but should do eventually" stays
for every other rejection. The route is a distinct rule, not a trigger of
the E5 Defer rule: that rule's other exclusions (PATH B, scope-fenced
items, and a CODEOWNER or required-reviewer source) stay, as "Not
covered" lists, and its two triggers are unchanged.

**Counting.** To count needs-decision deferrals alone, match the
`(needs-decision;` clause in replies or search for issues carrying the
marker. In the idd-skill source repository, `copilot-review-wave-audit`
counts the reply as an ordinary deferral.

**Not covered.** The route never applies to: a CODEOWNER or
required-reviewer source (and any person holding Triage, Write, Maintain
or Admin standing); `CHANGES_REQUESTED`; scope-fenced items; PATH B; the
F3 merge holds; the CI, E15, E11 and branch-sync holds that wait for an
operator. The lite profile's stops are also unchanged: the lite
review-fix file keeps its stop-and-ask bullet and its steps as they are,
because the lite profile never classifies or decides.

**After a person decides.** The follow-up follows the existing
needs-decision lifecycle: it waits under the needs-decision label
(`labels.needsDecisionLabelName`, default `status:needs-decision`) until
a person decides, and the decision is recorded on it. The needs-decision
issues kurone-kito/idd-skill#3708 and kurone-kito/idd-skill#3497 show its
shape.

**Replay table.** Each case below is walked through the text above.

| #  | Case                                                                                 | Outcome                                                                                      | Sentence applied                                   |
| -- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1  | A bot finding with two unranked resolutions                                          | Defers when the stop test clears                                                             | What counts, deferral condition                    |
| 2  | A verified-true bot finding with one resolution                                      | Accepted and fixed                                                                           | What counts, opening sentence                      |
| 3  | An inconclusive bot finding                                                          | Defers when the stop test clears; the reply names the unavailable check                      | What counts, unverifiable claim; The deferral      |
| 4  | An inconclusive critique-pass finding                                                | Stays Rejected with a reasoned reply                                                         | Stop sites, S1                                     |
| 5  | A CODEOWNER thread                                                                   | Keeps the hold                                                                               | When it applies; Not covered                       |
| 6  | An inconclusive item from a Write-standing collaborator                              | Keeps the E6 hold, no deferral                                                               | When it applies; Not covered                       |
| 7  | A thread from a person without standing, with two unranked resolutions               | Defers when the stop test clears: reply, then resolve only where the selected profile allows | What counts, deferral condition; Records           |
| 8  | A `CHANGES_REQUESTED` review                                                         | Keeps its path                                                                               | Not covered                                        |
| 9  | A Tier 2 stop whose stop test clears                                                 | Defers                                                                                       | Stop test; The deferral                            |
| 10 | A Tier 3 stop whose stop test clears, including a gap that is itself a criterion     | Defers; holds if the merged branch would be red                                              | What counts, S3 and S4 sentence; Stop test, item 1 |
| 11 | An E10 no-progress hold whose stop test clears                                       | Defers                                                                                       | Stop test                                          |
| 12 | `"off"` and `"OFF"` for the switch                                                   | Every stop is restored                                                                       | Switch                                             |
| 13 | An unverifiable High-severity security claim                                         | Holds                                                                                        | Stop test, item 2                                  |
| 14 | A finding whose defect is an instruction contradiction that would misguide the agent | Holds                                                                                        | Stop test, item 3                                  |
| 15 | A finding whose merge as it stands would be irreversible in a follow-up pull request | Holds                                                                                        | Stop test, item 4                                  |
| 16 | At S1 or S2, a verified-true finding that an acceptance criterion is unmet           | Accepted and fixed, never deferred                                                           | What counts, conditions (a) and (b)                |
| 17 | A stop whose outstanding findings include a CODEOWNER's                              | Holds                                                                                        | When it applies                                    |
| 18 | The fourth distinct follow-up on one pull request                                    | Holds                                                                                        | Cap                                                |
| 19 | A claimless pull request                                                             | Holds                                                                                        | Claimless                                          |

## Wave-gradient urgency defer

This section is the full rule for the optional wave gradient of
`critiqueLoop.deferByUrgency: "severity-tiered"`. Before the gradient, the
matrix there was the same at every review wave. Only the separate
round-count trigger, `critiqueLoop.deferAfterRounds`, depended on the
wave, and it covered Low-severity items only, so Medium and High findings
got no relief however many waves a pull request drew. The gradient
relaxes the matrix in at most two steps as the pull request's review
count grows. The
review-triage file carries only a short pointer, so a session that does
not read this section, and any configuration that leaves the field unset
or invalid, behaves as it did before the gradient existed. The decision
record is in the
[design rationale](idd-design-rationale.md#wave-gradient-urgency-defer-kurone-kitoidd-skill3796).

**Switch.** The gradient applies only while `critiqueLoop.deferByUrgency`
is `"severity-tiered"` and `critiqueLoop.deferRelaxAtRounds` holds one or
two strictly ascending positive integers, recommended `[4, 7]`. An unset
key means off, and so does any other value: more than two entries,
entries that are not strictly ascending integers of at least 1, or a
different type. Off means step 0 for every pull request. The
[customization guide](customization.md) states the rule, and the lite
profile does not apply the gradient.

**Count and step.** The count is the pull request's total, paginated
`copilot-pull-request-reviewer[bot]` review count, PR-wide and not scoped
to one claim: the same count `critiqueLoop.deferAfterRounds` uses. A pull
request's relax step is the number of configured thresholds that are less
than or equal to that count. With `[4, 7]`, counts 1 to 3 give step 0,
counts 4 to 6 give step 1, and counts 7 and above give step 2. With
`[3]`, counts 1 and 2 give step 0 and every count from 3 gives step 1.

**Ceilings.** Each step raises the highest urgency at which an
eligibility tier may still defer. Urgency is ordered `very-low` < `low`
< `medium` < `high`, and `high` in a cell means every scored urgency. The
eligibility tier is the higher of the E4 severity and Copilot's label,
and an unknown E4 severity counts as Medium, as in the E5 Defer rule.

| Eligibility tier | Step 0 (the rule without the gradient) | Step 1 | Step 2   |
| ---------------- | -------------------------------------- | ------ | -------- |
| Low              | `high`                                 | `high` | `high`   |
| Medium           | `medium`                               | `high` | `high`   |
| High             | `very-low`                             | `low`  | `medium` |

An unscored urgency never defers at any step. Every existing exclusion
stays in force at every step: PATH B, a scope-fenced item, a CODEOWNER or
required-reviewer item, an item in the maintainer-decision hold, and an
Accepted item mid-fix. Validity and the E4 severity are still judged
first, and a false claim is Rejected, not deferred.

**Never deferred from step 1.** From step 1 on, a High-tier finding of
`high` urgency never defers, and neither does a finding of the safety
class. The ceilings already exclude the first at every step, and it is
named here because the final step must never defer it. The safety class
is a finding that, assuming it is correct and merging the pull request as
it stands, would hit item 1, 2 or 4 of the numbered stop test in
[Needs-decision deferral](#needs-decision-deferral): the CI-or-unmergeable
item, the claim, lock, merge-gate, security, secret-handling or
data-destroying item, and the irreversible-by-follow-up item. Item 3, the
instruction or helper contradiction, is deliberately not part of this
class, because most findings in an instruction repository would match it
and the gradient would never act. The safety class applies whatever
`critiqueLoop.deferNeedsDecision` is set to. These rules govern the
`deferByUrgency` trigger only; the separate trigger
`critiqueLoop.deferAfterRounds` is unchanged.

**Step 0 is unchanged.** The exclusion above starts at step 1, not at step
0: at step 0 the rule is exactly the rule without the gradient, so a
safety-class Low-tier finding still defers at step 0 as it does today,
and a pull request whose field is absent changes nothing. The consequence
to keep in mind is that from step 1 on, a Medium-tier finding of `high`
urgency that rests on adopt-now condition (a), (b) or (c) but is not
safety class defers to the bundled follow-up.

**Reply and follow-up.** The reply keeps its form:
`**Rejected** — deferred to follow-up issue #<n> ({clause}): {reason}`.
Above step 0 the urgency clause gains a suffix, so a search of merged
pull requests can find gradient deferrals:
`urgency <level>; severity <tier>[, Copilot <label>]; step <k>`. The
follow-up uses the existing `review-fix-loop-cutoff` marker and the
bundling rule of the E5 Defer block.

**Converged extra step.** When the thresholds are set and valid, and
the advisory policy is `reviewPolicy` absent or `copilot-advisory`, E5
reads the profile-selected advisory-convergence command once per pass,
before disposing any item and before any E6 reply. The source
repository and the vendored-node profile run
`node scripts/advisory-convergence.mjs`. The package-manager profile
runs the `idd-advisory-convergence` bin, and the ephemeral-npx profile
runs an `npx` wrapper.
Pass `--pr` for the pull request and `--claim-issue` for the claimed
issue, and pass no `--assert`. Reuse that read on any later return to
E4-E6 in the same pass. The value is never carried across a push. Add
one step, capped at 2, only when `converged` equal to `true` and the
verdict's `prHeadSha` matches the `{head-SHA}` stored at E1 Step 1.
Every other result adds nothing, including an unavailable helper, a
non-zero exit, output that does not parse, a `converged` value that is
absent or not exactly `true`, a `prHeadSha` that differs from the
stored head, and a `reviewPolicy` other than absent or
`copilot-advisory`. With a one-threshold array such as `[4]`,
convergence reaches step 2, which is above that array's own final
step. The reply keeps `step <k>`, and only when convergence raised the
step it also carries `converged <short-sha>` (the first 7 hex digits
of `prHeadSha`).

## Selection Checklist

Before considering onboarding complete, record the selected profile in
the target repository's local documentation or onboarding notes.

- Choose `copilot-advisory` when the default GitHub Copilot advisory
  path is available and desired.
- Choose `human-required` when human approval is mandatory.
- Choose `no-advisory` only after confirming the repository accepts CI
  and branch protection as sufficient gates.
- Choose `external-bot` only after proving the bot's reviewer identity,
  current-head coverage signal, and wait/timeout behavior.
- For any non-default PR review profile, apply the matching artifact
  from `profiles/` and record its verification evidence.
- Record the review-thread resolution profile separately. Keep
  `fast-agent-resolve` for the distributed default, or customize the
  phase files listed above before choosing `hybrid-reviewer-ack` or
  `strict-reviewer-resolve`.
- Complete the matching PR review profile edit-surface checklist before
  marking onboarding done. Documentation-only recording is sufficient
  only for `copilot-advisory` when the imported default remains
  unchanged.

Changing the profile is a workflow change, not only a documentation
change. Update the phase files that enforce review and merge behavior in
the same pull request as the profile decision.
