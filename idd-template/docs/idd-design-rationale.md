---
type: design
title: IDD — Design Rationale and Maintainer Notes
description: Collects maintainer-facing rationale for why IDD phase rules exist as they do, organized by phase file.
tags: [design-rationale, maintainer-notes]
---

# IDD — Design Rationale and Maintainer Notes

This document collects maintainer-facing rationale, diagnostics, and
narrative justifications that explain _why_ IDD phase rules exist as
they do. The rules themselves stay in
`.github/instructions/*.instructions.md`; this file is the place to
record the context that helps future maintainers evaluate edits to
those rules without bloating the auto-loaded instruction surface.

Each section corresponds to one phase file. Add new rationale entries
under the matching phase heading. Behavior-changing constraints
(fail-closed defaults, claim revalidation, marker authority) must
remain in the instruction files.

## Discover

### A0-O roadmap-first fallback triggers

The `roadmap-first` A0-O fallback originally fired only when **zero
candidates reached A3.5** (trigger (a)) — A2 found no open execution
leaves, or A3 filtered them all out as blocked. But a candidate can reach
A3.5 and still be unworkable: a workshop leaf that runs a real external
deployment, or a "published" convergence checkpoint, can pass A3 readiness
and A3.5 (the owner self-approves), then fail the A4 viability gate
(Autonomous completion). Because they reached A3.5, the
original trigger stayed suppressed, so A4 stopped with "no viable
issue" and never fell back to A0-O even when claimable orphan issues
existed — forcing an operator opt-in every loop. The same shadowing
occurred when A4 Step 1.5 eliminated the last A3.5-startable candidate.

Trigger (b) closes that gap: the fallback also fires when the roadmap
path yields no viable, startable, unclaimed candidate because A4
Step 1 viability discards them all or Step 1.5 eliminates the last.
Three guards keep it safe:

- **Approval hold precedence.** A non-empty A3.5 approval-needed
  bucket is not a true zero; the fallback fires on viability/claim
  exhaustion only, never on the approval hold, so it never re-scopes
  around the approval gate.
- **True zero only.** It fires only when no viable, startable,
  unclaimed roadmap candidate remains — never when A4 discards some
  candidates but keeps others.
- **At most once per pass.** A0-O runs at most once as the
  roadmap-first fallback per Discover pass. Once spent (via trigger
  (a), (b), (c), or (d)), any later A4 Step 1 / Step 1.5 exhaustion —
  reachable after trigger (b) or (d), once either one's own A0-O run
  yields orphan candidates that later fail A4 — reports and stops (not
  an abort) without re-entering A0-O. A **trigger (a)** or **trigger (c)** A0-O
  run that finds no orphan routes to the A3 decision tree (both paths
  genuinely empty); a **trigger (b)** or **trigger (d)** one reports
  and stops instead — (b) because roadmap candidates reached A4, an
  exhaustion the A3 tree's A2/A3-empty cases do not describe; (d)
  because A1.5 already reported its own specific blocker, which the A3
  tree's generic wording would misdescribe or duplicate. This prevents
  an A1 ↔ A0-O or A4 ↔ A0-O loop.

When **trigger (a)** (zero A3.5-reaching candidates) and the orphan
fallback both yield nothing, discovery lands in the A3 decision tree,
exactly as the zero-reach-A3.5 case did before. **Trigger (b)** instead
reports and stops (not an abort): roadmap candidates reached A4, so the
A3 tree's A2/A3-empty reports would misdescribe the exhaustion.
Triggers (a) and (b) are scoped to roadmap traversal (A2→A3→A4) — the
A0-T explicit-target gate keeps its own no-fallback stop.

**Trigger (c)** closes a third gap, one step earlier than (a)/(b):
triggers (a) and (b) both presuppose A1 already found a roadmap to
traverse. When A1 itself finds **zero open roadmap issues** — not "the
roadmap's graph is exhausted" but "no roadmap exists at all" — the
original text still hard-aborted immediately, even though
`roadmap-first`'s whole purpose is to fall back to orphan work when
roadmap work runs dry. Before trigger (c), this surfaced naturally whenever
a repository drained its last open roadmap: the final tracked issue shipped,
the roadmap closed, and the next Discover pass found zero open roadmaps —
Discover correctly identified A1's documented abort condition and stopped,
a harder stop than (a)/(b) impose for what was, from an
operator's perspective, the same underlying situation (no roadmap work
available right now).

Trigger (c) fires at A1, before A1.5/A2/A3 ever run. Like trigger (a),
an A0-O run it invokes that finds no orphan candidates routes to
the A3 decision tree — the **true zero** and **at most once** guards
above apply unchanged. The **approval hold precedence** guard doesn't apply
to trigger (c) the same way: only the roadmap-side A3.5 pass is
absent, since there is no roadmap candidate for it to run on — A0-O's
own A3.5 pass on any orphan candidates it finds still runs and can
still produce its own approval-needed bucket. Because
(a)/(b) require A1 to have found a roadmap and (c) requires it to have
found none, triggers (a)/(b)/(c) are mutually exclusive within one
Discover pass — so "at most once per pass" already held across all
three before trigger (d) below extends the same property to a fourth.

**Trigger (d)** closes a fourth gap, this one downstream of A1 but
upstream of A2. `idd-roadmap-audit.instructions.md`'s A1.5 (Audit
completed roadmaps) can itself stop before A2 for two human-input
outcomes — the roadmap-level blocked-by-human/needs-decision label
check, and the "Non-autonomous gaps found" outcome — and both stopped
unconditionally, with no `roadmap-first` fallback at all. Under
`roadmap-first`, when either fires, A1 has already found a roadmap (so
trigger (c) cannot fire) and A2 never runs (so triggers (a)/(b), which
both presuppose A2 ran, cannot fire either) — the whole Discover pass
simply stopped even when unrelated, claimable orphan issues existed in
the repository, the exact situation `roadmap-first` exists to avoid.
Trigger (d) fires strictly between A1 and A2 — after A1 finds a
roadmap, before A2 ever runs — which is disjoint by construction from
trigger (c) (A1 finds zero roadmaps) and from triggers (a)/(b) (both
presuppose A2 already ran): all four triggers remain mutually
exclusive within one Discover pass, and "at most once per pass"
continues to hold automatically. Trigger (d) is scoped to A1.5's
outcome reached via the normal A1 roadmap-selection path only — never
A0-T's own scoped A1.5 invocation, which already governs its own
outcome unconditionally and with no fallback. Preventive; no observed
incident yet — kurone-kito/idd-skill#3090 identified the gap by
inspection of A1.5's two stop outcomes against the triggers already
defined here, not from a reproduced session that actually hit the
stop.

The `orphan-first` symmetric case — orphan candidates all failing A4,
which would fall back to the roadmap path — is a separate concern and
out of scope here.

### A3 — Diagnostic: all candidates blocked by an open roadmap

When the A3 decision tree reports zero ready-to-start candidates and
every candidate is blocked by an
`<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: X -->` marker that points
to an open roadmap, the markers may be misused as grouping tags.
Sub-tasks that run while the roadmap is open belong in the task list
(`- [ ] #NNN`); the `blocked-by` marker is reserved for issues that
must wait for a separate roadmap to close first. Treat this pattern
as a likely authoring defect, not a real dependency stall.

### A4 Step 1.5 — Rationale: active-claim pre-scan

Active-claim pre-scans eliminate known collisions deterministically
and reduce wasted claim-post-recheck cycles, improving scale-out
efficiency when multiple sessions start simultaneously. Without the
pre-scan, parallel sessions all claim the lowest-numbered viable
candidate at the same second, then race the same-second tie-break;
the pre-scan moves the resolution earlier in the pipeline so most
sessions never touch the same issue.

**Own-orphaned-claim near miss (kurone-kito/idd-skill#3322).**
Observed 2026-09-23/24 in a
public adopter run (`kurone-kito/vpm`, field-feedback gist round 40): a
session's own Discover pass read its own orphaned claim's `claimed-by`
comment as a non-stale foreign claim and moved on to the next
candidate, per the pre-scan rule above, exactly as the rule is
designed to behave for two genuinely different sessions. Only a
follow-up review of the transcript caught it; a manual
`claim-lock.mjs --read-tokens` check found a recorded token matching
the "foreign" claim-id, prompting the operator to resume it correctly
by hand.

The fix checks `idd-claim.instructions.md`'s `--read-tokens` form
against Discover's **own current cwd** — the primary worktree, since
Discover has no per-issue implementation worktree of its own yet —
never an explicit different worktree's path, so it needs no exception
to the existing `--read-tokens` scope contract (`claim-lock.mts`'s own
"Scope of the ownership proof" header comment,
kurone-kito/idd-skill#2879 review, Codex P1;
`docs/idd-helper-scripts.md`'s matching note). A fresh `A5` claim
always records its token into the primary worktree's admin directory
before any sibling worktree exists, so this check reaches the same
recovery evidence the original incident found by hand, without probing
a worktree Discover isn't running from. That same header comment is
also explicit that a hit is corroborating bootstrap evidence only, not
sole proof of current-session ownership by itself — when several
sessions share one clone, a different, still-live sibling session's
own A5 claim can leave an indistinguishable record at that same shared
path. `{agent-id}` is shared across sessions of the same agent type
and never proves ownership (`idd-overview-core.instructions.md`), so
Step 1.5 does **not** gate this route on `record.agentId`. It does
**not** adopt the recorded pair outright; it stops silently discarding
the candidate as an ordinary foreign claim and routes a well-formed
`present: true` result to `idd-resume.instructions.md`. Resume
Step 0 sends a non-owned active claim with no forced-handoff
evidence to `idd-resume-stall.instructions.md` before Step 1, so
this route does not finish ownership by itself. A refusal there
is not a terminal end of Discover: the candidate stays ineligible
and Step 1.5 keeps scanning.

This finding is upstream of kurone-kito/idd-skill#3273 (Resume Step 1
not threading an already-known claim-id through to
`resume-claim-routing.mjs`) and kurone-kito/idd-skill#3274 (operator
recovery for a stale/released claim whose local worktree is still
occupied). kurone-kito/idd-skill#3273's gap is that Resume Step 0
stalls before Step 1 unless the session already holds a verified
claim-id. Passing the probe's claim-id through that entry stays in
that issue, not this change.

### A4 Step 2 — Rationale: concurrent-selection desync

A4 Step 1.5 (active-claim pre-scan) and A5(e) (collision detection plus
same-second tie-break) only resolve a selection collision **reactively**:
a losing session has already posted its claim and snapshot, then re-enters
Discover and — because Step 2's tie-break is the fully deterministic
lowest-issue-number — **re-collides** on the next candidate. Observed in a
multi-session run as a 3-way race on one score-5 issue whose two losers
then re-collided on the next lowest number.

The opt-in `discover.selectionDesync: session-offset` knob adds a
**proactive** desync: within a single highest-score tie band it picks the
entry at `selectDesyncedIndex(session-token, band-size)` (a pure
`hash(session-token) mod band-size`) instead of always index 0, spreading
concurrent sessions across _different_ eligible issues up front.

`session-token` must be a per-session-unique value, never the bare,
session-shared `{agent-id}` alone: `idd-overview-core.instructions.md`
defines `{agent-id}` as shared across concurrent sessions of the same
agent type, with a unique session suffix only recommended, not required.
Sessions that follow that core definition literally and omit the suffix
all hash to the identical index and converge on the same issue — the
same converge-and-collide shape as the 3-way race above. This specific
bare-agent-id collapse is preventive; no observed incident yet —
kurone-kito/idd-skill#1694 identified it by inspection of the two
files' definitions, not from a collision that already happened.
`idd-discover.instructions.md` closes the gap by requiring the
session-suffixed `{agent-id}` or, when the agent-id carries no unique
component, a session-local fallback token generated once at Discover
entry and reused for the session — with enough entropy
(random or UUID-derived) to stay distinct across sessions launched at
the same moment, since a bare timestamp alone would not.

It is off by default and reorders **only within** a same-score tie band so
the documented score-then-lowest-number ranking is the unchanged single-
session and fallback behavior. The load-bearing invariant is that the
branch name (`issue/<n>-<slug>`) derives from the issue, not selection
order, so spreading sessions across different issues never breaks the
same-issue branch convergence that A5(e) and the `branch-name` helper rely
on. The desync never crosses score bands and never bypasses the A4.5/A5
gates; the in-band offset function is replaceable without affecting these
invariants.

### A4 Step 2 — Rationale: milestone-scope preference

A GitHub milestone groups scope for a release (e.g. `v0.8.0`) purely as
human-facing material; Discover never read it before
kurone-kito/idd-skill#2340. A4 Step 2
already ranks by suitability score, then the optional concurrent-selection
desync, then the effort hint — none of which prefer the work a release is
actually waiting on, so concurrent autopilot sessions drain the backlog
issue-by-issue with no way to converge on a milestone's scope first. An
operator's only lever was re-explaining the priority to every session by
hand.

`discover.milestoneScope` (optional string; unset means off) closes that
gap the same way `selectionDesync` and the effort hint do: a **soft**,
same-score-band-only preference, never a gate. When set, a candidate whose
**OPEN** milestone title equals the configured value sorts ahead of other
candidates in the same suitability-score tie band, positioned after
selection-desync (session spread stays available even within a
milestone-preferred set) and before the effort hint (release intent
outranks size preference, but both still apply only inside one band).

The preference is symmetric-neutral by construction: an unset or empty
`discover.milestoneScope`, a candidate with no milestone, a **closed**
milestone, or a missing `milestone` field from the API all collapse to
the same "no preference" case, so a partial or stale read never
silently misroutes a candidate — it just falls through to the
pre-existing effort/issue-number order. Closed milestones are
deliberately excluded (not merely ranked lower) so a candidate never
keeps sorting ahead of its band after its release has already shipped.
`discover-roadmap-graph` and `discover-orphan-filter` surface the
resolved `milestone` title in their own outputs so the ranking input is
visible evidence, not a value an agent has to re-fetch to audit a pick.

### A4 — Scored-vs-unscored floor tie-breaker: what still ties afterward

Moved from the Discover phase file to keep the capped instruction
surface lean. After the scored-vs-unscored floor tie-breaker resolves
the mixed case, the remaining tie-breakers (concurrent-selection
desync, effort hint, lowest issue number) still apply in unchanged
relative order — for example, between two genuinely-scored candidates,
or between two unscored candidates when no genuinely-scored one is
present at that value.

## Claim resolution

### Forced-handoff strictness: strict resume vs. lenient relay-merge

Both the resume-routing read (`evaluateResumeClaimRouting` in
`resume-claim-routing.mts`) and the pre-merge write-gate
(`summarizeClaimValidation` in `protocol-helpers.mts`) resolve the active claim
through the **single** shared `resolveActiveClaim`, so there is no forked
claim-state logic. They deliberately pass **different** forced-handoff options,
and that difference is intentional policy, not drift:

- **Resume routing is strict.** It sets `requireAuthorMatchesForcedBy: true`
  (rule 7's author/`forcedBy` binding) and never passes `prFirstCommitAt`.
  Resume is a _takeover_ decision, so it must block the same-identity
  self-signed hijack and reject an issue-only handoff that targets a PR-backed
  claim.
- **The merge write-gate is lenient.** It leaves `requireAuthorMatchesForcedBy`
  at its off default and passes `prFirstCommitAt`, applying the Part-B allowance
  (kurone-kito/idd-skill#1058, an issue-only handoff predating the PR). The
  merge gate re-validates an _already-verified_ session and must tolerate a
  maintainer-authorized handoff relayed by a separate automation actor;
  authorization then rests on `isAuthorizedForcedHandoff` alone. The
  external-check waiver (`resolveLinkedIssueCandidates` in
  `external-check-waiver.mts`) is one of these lenient merge-side callers and
  passes `prFirstCommitAt` too (kurone-kito/idd-skill#3675: without it a
  successor of an issue-only handoff could not use the waiver on its own PR,
  observed 2026-09-30 in a private adopter). The marker planner calls the same
  `resolveHelperActiveClaim` without it on purpose, so its PR-scoped replay
  keeps rejecting an issue-only marker.

Because the two callers apply different strictness, they can return **different
verdicts for the same corrected-handoff state** — resume may report
`already_owned` while the merge gate reports `claimLost`. This is expected: the
verdicts answer different questions (may I take over? vs. does this verified
session still own the write?).

The split is kept intentionally (see kurone-kito/idd-skill#1155): the structural
risk the adopter raised — two divergent resolvers — is already removed by the
shared `resolveActiveClaim`, and forcing both sides strict would break the
legitimate relay use-case. Any future change here must preserve the single
resolver (do not fork `resolveActiveClaim`) and the resume-side
self-signed-hijack block.

**Failed linked-PR lookup on the resume side (kurone-kito/idd-skill#3276).**
Resume routing's own PR-backed-claim detection
(`fetchOpenLinkedPrReferences`) used the unpaginated, fail-open
`getConnectedPullRequestEventsSingle`, whose GitHub adapter swallows every
lookup error and returns an empty event list — indistinguishable from "no
connected PR." Combined with `buildForcedHandoffEnableGate`'s
`expectedLinkedPrReferences.size === 0` shortcut, a transient lookup
failure could silently honor an `issue-only` forced handoff against a claim
a PR actually backs, the exact case the strictness split above exists to
reject. The fix moved the lookup to the already-throwing paginated
`getConnectedPullRequestEventsPage` and threads an explicit
`linkedPrLookupFailed` flag through resume routing's own gate: a failed
lookup now rejects an `issue-only` handoff as "PR state unknown" (fail
closed) instead of the prior fail-open behavior, and neither side of a
handoff blocked this way (the displaced original owner's `oldClaimId` nor
the would-be successor's `newClaimId`) may read a `--claim-id` check as an
ordinary claim-state outcome — both route to an explicit `stop` with a
dedicated `forced-handoff-linked-pr-lookup-failed` reason, for as long as
the rejected marker's `oldClaimId` still names the current active claim
(re-derived live on every `--claim-id` check, not a one-time flag — the
`linkedPrLookupFailureMatch` override inside `evaluateResumeClaimRouting`).
A later, unrelated claim transition makes that historical marker no longer
a live match, so it stops applying; a genuine takeover still reaches
`already-claimed` → `stale-reclaimable` via `--fresh-claim-gate` and a
freshly minted claim-id, which the override never touches. Scoped to
`issue-only` handoffs only, matching the Groom hearing decision that
introduced it: `buildForcedHandoffEnabledGate`'s wrapper delegates an
`issue-plus-pr` handoff straight to the pre-existing shared gate
regardless of `linkedPrLookupFailed`, so its behavior is unchanged. The
merge-side `summarizeClaimValidation` path (and its `prFirstCommitAt`
Part-B allowance above) never shared this lookup either, and is untouched
by this fix.

### Activation-nonce: why a separate marker, and what stays deferred

kurone-kito/idd-skill#1480 found a verified near-miss: two independent
sessions can both adopt-verbatim the identical forced-handoff sticky
successor pair and both pass every `claim-id`-based check identically,
because nothing is posted at adopt-verbatim time to distinguish "the
session that legitimately adopted this pair" from "a second session that
also adopted it." kurone-kito/idd-skill#1522 closes that gap with a
standalone `activation-nonce` marker (`idd-claim.instructions.md`)
rather than a new field on `claimed-by`: adopt-verbatim posts no
`claimed-by` at all, so a field living inside `claimed-by`'s body could
never appear on the one path that motivates the mechanism. The winner rule
— lexicographically earliest `{nonce}` among however many trusted markers
exist for a `{claim-id}` — is a pure function of the observed nonce set
(mirroring the existing `{claim-id}` same-second tie-break), so two
colliding sessions compute the identical winner independently, with no
"both back off" livelock.

**Scope for #1522**: the issue's acceptance criteria name the **Claim
revalidation gate** (`idd-overview-core.instructions.md`) as the enforcement
point, and that gate is fully wired: it fires before any mutating step for a
live session holding its own posted nonce, and — since adopt-verbatim posts
no `claimed-by` and so never enters _Claim verification_ at all — the
adopt-verbatim paragraph in `idd-claim.instructions.md` carries its own
inline verify-then-compare instruction, the one path #1480 actually
exercises. Beyond the AC's letter, `evaluateResumeClaimRouting`
(`resume-claim-routing.mts`) also accepts `--claim-id`, `--nonce`, and
`--worktree`, and is unit-tested. kurone-kito/idd-skill#3273 wired the
documented Resume Step 1 invocation, in both the standard
(`idd-resume.instructions.md`) and lite
(`lite/idd-resume-lite.instructions.md`) profiles, to thread
`--claim-id` whenever this session already recorded and verified one,
plus `--nonce` when this session also recorded one for that same
claim-id, and `--worktree` once the B1 worktree exists, so the helper
reads independent owner evidence instead of treating a bare re-fetch
as a live competitor. Cold recovery
(kurone-kito/idd-skill#1529) still fail-closes: a resume that holds no
local nonce treats 2+ trusted activation-nonce markers for the active
claim-id as `disputed`/`stop` rather than guessing an owner.
The merge write-gate half landed separately: `summarizeClaimValidation`
(`protocol-helpers.mts`) now shares the same `findActivationNonceWinner`
primitive via `pre-merge-readiness.mjs`'s `--nonce` flag
(kurone-kito/idd-skill#1528), closing the one AC-adjacent surface #1522
deliberately deferred. The instruction-level half landed separately too:
`idd-pre-merge.instructions.md`'s F2 now instructs the session to pass
its own locally-recorded activation-nonce as `--nonce` when invoking the
readiness collector (kurone-kito/idd-skill#1615), so the merge-time
write-gate's comparison is no longer a documented-but-unreachable
no-op.

### Wrong-branch commit recovery: cherry-pick, never force-push

kurone-kito/idd-skill#815 named the risk directly: parallel worktrees
let a `git switch` move a checkout out from under another run, so a
commit lands on the wrong branch — typically the primary worktree's
`main`, or another issue's branch. The Claim revalidation gate in
`idd-overview-core.instructions.md` keeps the mechanical steps to a
one-line pointer to stay inside its byte budget; this page owns the
full procedure.

Recover by **cherry-picking** the misplaced commit onto the correct
issue branch (in its own sibling worktree), then restoring the
contaminated branch:

- **Unpushed** contaminated branch (typically the primary worktree's
  `main`): `git reset --hard` it back to its upstream.
- **Already pushed or shared**: do **not** `git reset --hard` then
  force-push to erase the misplaced commit — that is the forbidden
  force-push. Instead `git revert` the misplaced change, or let the
  operator evacuate the branch.

Either way, preserve that branch's real history and move only the
misplaced commit. `scripts/idd-doctor.mjs` warns on the same
primary-worktree-HEAD symptom this gate catches at mutation time.

### Claim release has no compare-and-swap: deferred (2026-08-13)

While resolving kurone-kito/idd-skill#1985 (PR kurone-kito/idd-skill#1993's
"Operator-present release" recovery path), round 6 review found that the
claim-marker protocol has no atomic compare-and-swap for releasing a
claim: `idd-claim.instructions.md`'s Claim-state parsing rule 5 releases
a claim via `unclaimed-by` on an exact `{agent-id}`/`{claim-id}` match
alone, with no check on whether the releasing session's belief ("no
later claimant activity") is still true at write time (preventive; no
observed incident yet). The maintainer accepted this as a documented,
bounded residual risk for kurone-kito/idd-skill#1985 specifically —
blast radius already limited
by the pre-existing claim revalidation gate, since a session that loses
its claim mid-window detects it on its own next required pre-mutation
check and stops, making this a detectable lost-claim event rather than
silent double-ownership. kurone-kito/idd-skill#2000 recorded the broader
protocol-level question that decision deliberately left open: should the
claim-marker protocol close this gap generally, beyond that one path?

**What "true CAS" would actually require.** Two GitHub-native mechanisms
give genuine atomic compare-and-swap, and both were considered and
rejected rather than being unavailable:

- **Non-force git ref updates** (e.g. `refs/idd/claims/issue-N`) — a ref
  update only succeeds as a fast-forward of its current value, which is
  real CAS with zero external infrastructure. Rejected because it
  abandons the append-only, human-readable, trusted-actor comment ledger
  the entire IDD claim/audit/trust model is built on.
- **GitHub Actions concurrency groups** — routing claim mutations through
  a per-issue-serialized dispatched workflow gives real mutual exclusion.
  Rejected on added latency, a hard dependency on Actions, and
  incompatibility with the `instructions-only` helper profile, which by
  design requires no workflow at all.

Neither is impossible — both trade away a load-bearing IDD design
property (portability, comment-ledger auditability, or
infrastructure-free operation) that this repository has consistently
protected elsewhere.

**What's actually achievable without new infrastructure.** The claim
protocol already has a self-healing, re-derivable consistency check for
the _take_ side: Claim-state parsing rule 4 re-evaluates whether a
superseded claim was genuinely stale **at the new comment's own
`created_at`**, from the live comment timeline — not from whatever the
superseding session believed when it decided to act. If a heartbeat
lands between a session's stale-check read and its takeover post,
replaying the timeline correctly invalidates the takeover. This is
optimistic concurrency with post-hoc detection, not true atomicity, but
it is genuinely self-healing. The _release_ side (rule 5) has no
equivalent: it is a bare identity match with no timeline-derived
liveness predicate. The parser-level fix would mirror rule 4's pattern
for releases — e.g. an `unclaimed-by` variant that embeds the timestamp
of the pause-evidence comment it is anchored to, honored only if no
trusted claimant activity has a `created_at` between that anchor and the
release event itself, re-derivable by any future parser exactly like
rule 4's staleness check already is. This would need a **new sibling
marker type** alongside the existing `unclaimed-by`, not a field added
to that same token: the existing token is parsed by a strict whole-body
anchor regex requiring exactly its current fields and nothing else, so
every existing (and every not-yet-upgraded) parser would read an
extended token as malformed and silently lose the release event. A new
sibling type keeps old parsers on today's accepted-risk behavior while
letting new parsers apply the stronger check.

**Coverage is inherently partial either way.** Even with the parser
extension, only comment-visible activity (heartbeats, comments, reviews)
is re-derivable from the timeline. The Operator-present release path's
own prose predicate also considers branch/PR movement, which a
comment-timeline parser cannot see. Rule 4's existing stale-clock has the
identical limitation today (only heartbeats refresh it, not pushes), so
this would be consistent with the existing design rather than a new gap
— but it means even the "real" fix would not fully close the class of
race the round-6 finding raised.

**Revisit triggers.** Reconsider this only if either becomes true:

- An **actually-observed** instance of this race class occurs (not a
  theoretical review finding) — i.e., a session genuinely loses work or
  produces confusing state because of a stale-read release, takeover, or
  forced-handoff decision.
- This repository's operating model shifts toward materially higher
  concurrent-session, multi-writer load on the same issues (today's
  desync/contention tooling — `discover.selectionDesync`,
  `discover-shared-file-overlap` — targets _different_-issue
  parallelism, not concurrent claim decisions on the _same_ issue).

**Candidate files (if ever pursued)**, named as they land once imported
(the `idd-template/` prefix drops from this document's own path, and
`src/scripts/*.mts` never ships — an adopter's `vendored-node` profile
gets the generated `.mjs` copy instead; `package-manager`/`ephemeral-npx`/`user-global`
resolve the same logic through the installed package rather than a
local file; `instructions-only` has no helper runtime at all, so this
deferred work would need direct instruction-level parsing rules there
instead of a helper file. The repository-local
`docs/idd-design-rationale.md` mirror keeps the source-tree paths,
since those genuinely exist there):

- `.github/instructions/idd-claim.instructions.md` (Claim-state
  parsing rules, marker format)
- `.github/instructions/idd-overview-core.instructions.md`
  (Claim format / Unclaim format sections)
- `.github/instructions/idd-resume.instructions.md` (Operator-present
  release Step 2 — the actual writer of today's bare `unclaimed-by`; a
  guarded release marker needs this call site too, or the race it
  targets would remain unguarded here)
- `scripts/marker-helpers.mjs` (marker regex/parsing; `vendored-node`
  only)
- `scripts/protocol-helpers.mjs` (marker classification;
  `vendored-node` only)

Deliberately deferred, not `needs-decision`: there is no currently
blocking choice, since kurone-kito/idd-skill#1985 already resolved its
own narrower question. This record moved here from
kurone-kito/idd-skill#2000, which stayed open only as a findable record
until one of the revisit triggers above fires.

### Context-inheriting delegation residual risk

kurone-kito/idd-skill#2624 adopted a documented positive-framed
mitigation for the [Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation)
context-inheriting fallback: the delegation brief must state
explicitly that the delegate is the sole worker for the named issue,
with no peer workers to coordinate with or wait on. That issue was
scoped to the wake-up-discipline stall pattern and did not evaluate
this mitigation against a different, related failure mode: a
context-inheriting delegate mistaking itself for the orchestrator that
dispatched it, rather than the worker the brief names it as.

kurone-kito/idd-skill#2802 recorded direct field evidence, from this
project's own dogfooding, that neither that positive-framed
mitigation, nor an added explicit negative instruction naming the
failure mode directly, reliably prevents it: three independent
occurrences of a context-inheriting delegate (sharing the
orchestrator's own full conversation transcript) opening its first
turn by describing having delegated to, and now waiting on, a
sub-worker that did not exist — the delegate itself was the intended
worker — even when the brief's role-reassignment wording matched the
documented mitigation nearly verbatim, and even when a further attempt
added an explicit negative instruction naming the confusion directly.
Each occurrence needed an explicit follow-up message (or abandoning
delegation entirely) to correct. See kurone-kito/idd-skill#2802 for the
full narrative and observation counts.

**Adopted mitigation**: state the non-context-inheriting delegation
mechanism as a strong preference, not merely a suggestion, whenever
the calling tool offers one, and record the context-inheriting
fallback's residual role-misread risk explicitly as a known, accepted
limitation next to the delegation-brief wording, rather than
continuing to iterate on brief wording that field evidence shows does
not reliably close the gap.

## Work and self-review

### B1 Step 3 — install-deps silent under-install detection

Two independent fresh-worktree sessions observed a lockfile-frozen
package-manager install report apparent success while silently leaving
a key dependency binary missing (root cause unconfirmed; suspected
package-manager store/hardlink race). A thin generic wrapper around the
configured install command closes this gap: run the install, verify a
key binary exists, retry the install exactly once if it does not
(including when the install command itself fails), and fail loudly
with an actionable message if it is still missing after the retry. The
existing install-deps idempotency contract is preserved — the wrapper
never deletes or resets state, so reruns in fresh, reused, or recreated
worktrees still need no manual cleanup (kurone-kito/idd-skill#1237).

### WorkTrunk cwd caveat

An adopter session, using WorkTrunk's automation-safe invocation (`wt
switch --create ... -x true`), observed a `Cannot change directory —
shell integration installed but not active` diagnostic that did not fail
the command. From that point onward, the agent harness's own tool output
repeatedly reported the shell's working directory as reverted to the primary
worktree root, even immediately after a command that had run correctly in the
sibling worktree. Attribution between the harness's own working-directory
tracking and WorkTrunk's shell-integration hook could not be isolated (no
control-group session was available), so this stays a documented structural
gap in B1's guidance, not a claim against either component: the one-time
B1 self-check gives no signal to keep re-verifying the working directory
after this diagnostic appears, even though the "working directory persists
between commands" assumption can silently stop holding from that point
on (kurone-kito/idd-skill#2332).

**What to do**: once this diagnostic appears, treat the working directory
as unverified for every later command in the session — confirm it (e.g.
`pwd`) before trusting a command that depends on the current directory,
rather than assuming it still matches the last-known worktree.

### B1 self-check — Grok Build file tools bound to launch workspace

A Grok Build session's file-read and file-edit tools resolve relative
paths against the session's launch workspace — the primary clone,
whose HEAD B1 keeps on `main` — not the shell's current directory, so
a `cd` into the sibling worktree does not rebind them. Reproduced by
creating a sibling worktree, writing a unique marker only into that
worktree's uncommitted `README.md`, then running Grok's
workspace-default grep for the marker: it found nothing, while the
same grep given the sibling's absolute path found it immediately. A
shell `cd` into the sibling and a `pwd` reporting the sibling path
both looked like a passing B1 self-check throughout
(kurone-kito/idd-skill#2819, 2026-09-10).

This is a different failure class from
kurone-kito/idd-skill#2114's off-convention worktree-creation
primitives (`grok --worktree`, `isolation: worktree`,
`x.ai/git/worktree/*`): there, B1 creates the wrong worktree
altogether; here the worktree is correct and only the file tools'
workspace binding stays stale. It sits alongside
kurone-kito/idd-skill#2332's WorkTrunk cwd-tracking caveat above as
another way a harness's own working-directory signal can drift from
what B1's self-check actually verifies.

**What to do**: for a harness whose file-read/edit tools stay bound to
the launch workspace, pass every such tool call the sibling worktree's
absolute path instead of relying on a shell `cd`; a shell `pwd`
reporting the sibling path is not evidence those tools moved with it.

### C1/B2 critique pass — Grok `spawn_subagent` needs a bounded fallback

Grok Build's critique-pass row, unlike Codex CLI's, had no fallback
when `spawn_subagent` is unavailable, unsuitable, or fails — Grok
_has_ `spawn_subagent`, so a successful-but-unbounded pass never fell
back to a structured self-critique. In the Grok Build IDD loop that
shipped kurone-kito/idd-skill#2814 for issue kurone-kito/idd-skill#2774
(observed 2026-09-09, kurone-kito/idd-skill#2814): B2 plan critique
ran 387 s across 43 tool calls, C1 diff critique ran 575 s across 40
tool calls, and a C1 re-critique whose brief named two files plus
`git diff origin/main...HEAD` and said "keep this short" still ran
172 s across 25 tool calls and opened extra search rather than staying
on the named slice. The findings were usable, but one docs-only issue
spent roughly 19 minutes in critique subagents; Claude Code's `Agent`
path for the same C1 role is typically a short bounded review, while
Grok's general-purpose subagent treated the checklist as an
open-ended explore (kurone-kito/idd-skill#2825).

This is a different Grok gap from kurone-kito/idd-skill#2819's file
tools bound to the launch workspace (above) and closed
kurone-kito/idd-skill#2114's worktree-creation primitives: those are
B1 worktree/tool-cwd; this is the C1/B2 critique _mechanism_ row.

**What to do**: give Grok's critique row the same fallback class Codex
already has (structured self-critique when delegation is unavailable,
unsuitable, or fails) without inventing a wall-clock or tool-call cap,
and require the critique brief to name the files or diff under review
so an unsuitable pass is easier to distinguish from a thorough one.

### C1/B2 — Bound delegated critique waits

The no-cap stance from
`kurone-kito/idd-skill#2825` covered slow but returning Grok passes:
the observed 387-second, 575-second, and 172-second passes all produced
usable findings. A later field-feedback report from the dotfiles run found a
delegated Cursor pass that waited about 32 minutes without returning a findings
list, leaving the unattended loop unable to reach its structured fallback
(observed 2026-09-26, `kurone-kito/idd-skill#3542`). The
default `critiqueLoop.subagentWaitCeiling = PT20M` addresses that hang
case without treating the slower returning passes from
`kurone-kito/idd-skill#2825` as failures. The parent must apply the ceiling
through the harness's own
per-invocation timeout control, rather than wrapping the delegated
command in a timeout utility as the failure mode documented by
`kurone-kito/idd-skill#3449`
warns against. A harness that cannot bound its delegation primitive must
record that residual risk and use structured self-critique instead.

### B2.1 — Premise verification (decision-transcription issues)

Field evidence showed a worker asked to transcribe a maintainer's
already-recorded decision into documentation, where the decision's own
rationale asserted a checkable fact about what a prior change shipped
that the shipped code's own comment contradicted. The worker held,
surfaced the primary-source evidence, and only continued after the
maintainer corrected the record via an addendum. Nothing in the shared
instructions prompted that judgment call, and a documentation-only PR
has no test suite to catch a silently transcribed false premise later
(kurone-kito/idd-skill#1390).

### B2.2 — Example field-name verification

Issue kurone-kito/idd-skill#2806's own "Proposed change" section cited
an illustrative gate field, `claimValid: false`, that did not exist
anywhere in `schemas/pre-merge-readiness.schema.json` — the real
fields are `claim.matchesExpectedClaim` / `claim.claimLost`. B2.1 did
not apply because that issue was an ordinary bugfix issue, not
decision-transcription, and the fabricated field appeared in an
illustrative example, not a rationale claim, so nothing in the written
instructions caught it during that issue's own implementation, PR
kurone-kito/idd-skill#2875; a Codex review caught it instead, after
the text had already shipped once. A maintainer hearing recorded on
kurone-kito/idd-skill#2878 added this narrow, adjacent check rather
than broadening B2.1's own condition.

### B3 — De-duplication refactor: check for behavior parity, not just body equivalence

Closes a real regression class: consolidating a wrapper function used
at multiple call sites into one shared function silently dropped
options or behavior (timeouts, stdio handling, error translation, etc.)
that some call sites' old delegate paths had been adding, because the
function bodies otherwise looked equivalent. It was caught only by an
ad hoc critique pass and a reviewer comment, not by written
implementation guidance (kurone-kito/idd-skill#1238).

### B–C — Follow-up discovery bypassed issue authoring

On 2026-08-24, issue #2231 recorded that B-phase workers discovering
separate follow-up work had no unconditional in-file route to the optional
issue-authoring companion and had been observed creating issues directly.
The B–C guard now routes that work through Stage 1 or preserves it in a
durable issue comment when the companion is unavailable
(kurone-kito/idd-skill#2231).

### Stage 1 — Shared hold ownership conflict

On 2026-08-24, issue #2231 also recorded that a shared authoring label did
not identify the session holding a follow-up target, leaving concurrent
passes able to race through reuse and body wiring. The per-target trusted
owner-marker protocol, visible-note JSON posting, persisted anchor identity,
fresh re-reads, and same-owner heartbeat renewal before edits close that
observed conflict path (kurone-kito/idd-skill#2231).

### Stage 1 — Non-atomic new-issue publication window

During the 2026-08-24 remediation of issue #2231, review verified a concrete
create-then-label race: a newly created follow-up could exist without the
authoring label between two separate mutations, allowing another Discover
pass to see it before the hold was applied. The atomic create-with-label
requirement, capability check, and stop-before-create fallback close that
publication window (kurone-kito/idd-skill#2231).

### Stage 2 — Set-level release rollback safety

The same remediation exposed a set-level rollback hazard: if an early label
removal closed its target generation before a later removal failed, the
restoration owner check could fail and leave that target visible to Discover.
Release markers are therefore provisional until every target, with the anchor
last, has been verified; release retries reuse the verified marker comment ID
instead of appending an indistinguishable duplicate. Anchor identity is
persisted in every owner marker, and every Stage 1 edit re-reads both the
target and the set anchor (kurone-kito/idd-skill#2231).

### B3 — Dependency drift vs. own diff: a typecheck/lint diagnostic

A `typecheck`/`lint` failure in a file the current diff never touched
can look like a bug in the diff itself, when it is really dependency
drift or a broken `main` baseline — a real incident cost debugging time
this way before the guidance below existed
(kurone-kito/idd-skill#1164, kurone-kito/idd-skill#1193).

### B3 — Local test flakiness under concurrent load: hosted CI is authoritative

Field evidence from many concurrent local worktree sessions on one
machine showed delegated workers hitting local test timeouts on specs
their diff never touched; every failure passed an isolated re-run and
the hosted CI run (a dedicated, non-shared runner) stayed green each
time. This was plain CPU/resource contention, but each occurrence cost
real investigation before a worker could conclude "environmental, not
my change" — and the pattern recurs more as adopters scale out
concurrent sessions (kurone-kito/idd-skill#1391). Hosted CI governs
when it disagrees with a local outcome for the same commit; that does
not waive the fix-validate / pre-push-validate requirements themselves.

### B3 — Edit the canonical source of a generated docs/instructions file, not its mirror

An adopter repository that generates some of its own `docs/**.md` or
`.github/instructions/**.md` files from a canonical source (via a
sync-docs-style tool) can lose a fix silently: an agent edits the
generated mirror directly, the change looks correct locally, but the
next sync run regenerates the mirror from its canonical source and
discards the edit without any error -- a real incident cost a
revert-and-redo cycle before the guidance below existed
(kurone-kito/idd-skill#2548). The mistake is easy to make because the
mirror and its canonical source are often byte-identical or
near-identical, giving no visual cue at a glance. Only a
`.github/instructions/**.instructions.md` mirror is guaranteed to
carry a visible `idd-generated-from` banner at its top; a `docs/**.md`
mirror may not, depending on the sync tool's own behavior, so the
banner check alone can miss exactly the file class most likely to be
mistaken for hand-editable prose. Checking the sync tool's own
manifest for a matching target entry closes that gap for `docs/**.md`
files, at the cost of one extra lookup.

### C1 — Search sibling code for the same defect shape before closing

A bug fix scoped to the single reported call site can leave the
identical defect shape unpatched elsewhere in the same file, or in an
independently-maintained sibling implementation of the same logic.
`kurone-kito/idd-skill#1471` fixed a stale-multi-instance-rollup
defect in one file; a follow-up C1 pass on that same PR separately
found the identical shape in an independently-maintained equivalent
file, filed as `kurone-kito/idd-skill#1478` -- outside the original
issue's own acceptance criteria. `kurone-kito/idd-skill#2475` (a
shared, loop-wide de-duplication `Set` that let only the
alphabetically-first named actor be credited when a single reply
named several) repeated the pattern in the same file: the reported bug
and its initial fix covered only one function, and a separate critique
pass -- run to verify the fix, not to search for new work -- found the
identical shape unpatched in a second, structurally separate loop
elsewhere in that file. When a bug's root cause is a reusable defect
shape rather than a one-off typo, search the rest of the containing
file -- and any independently-maintained sibling implementation of the
same logic -- for the same shape before treating the fix, or a C1
critique of it, as complete (observed 2026-09-03,
kurone-kito/idd-skill#2552).

## PR submit

### D2 — Adding a new CI job: dispatch-first rollout

An adopter repository whose review automation (for example a Copilot
or Codex code-review app) re-runs on every push accumulates review
cost roughly 1:1 with commit count, independent of which files or CI
jobs a given push touches. A new CI job whose target runner cannot be
exercised locally compounds this: each debugging attempt needs a real
push-and-wait round trip, so every unverified hypothesis about why the
job fails costs a full review cycle on top of the CI minutes spent.
Landing the job `workflow_dispatch`-first and validating it via manual
dispatch runs does not reduce that review cost by itself -- the review
re-run is driven by the push, not by the job's trigger wiring -- but
it does stop an unproven job from auto-running (and burning runner
minutes, and adding failure noise) on every unrelated push during the
same pull request's remaining lifetime. The one path that does avoid
review cost entirely is iterating a Windows-/macOS-targeted job on a
branch with no open PR yet: review automation that only fires on
PR-associated pushes never runs during that shakeout, so a push to a
PR-less branch never triggers a review at all -- this is why that
non-PR shakeout pattern is worth documenting as an option, scoped to
CI-infrastructure-focused work, even though it deviates from the
normal early-PR-then-iterate practice.

Observed 2026-09-10 on PR kurone-kito/idd-skill#2897 (issue
kurone-kito/idd-skill#2892): three independently-reasoned, unverified
commits debugging a native-Windows-only CI hang in a new
`lint-windows` job each triggered a fresh full Copilot and Codex
review and left the job's own regression test failing at a
near-identical elapsed time each round -- direct evidence none of the
three changed anything that mattered, and each round could only be
diagnosed by pushing and waiting on a real run, since the repository's
own IDD implementation sessions are WSL/Linux-only and cannot exercise
a `windows-latest` runner locally (kurone-kito/idd-skill#2892,
non-blocking).

## Review triage

### E1 Step ordering made review triage wait for CI (2026-09-28)

An operator report from an unnamed adopter described E-phase leaving
unresolved review items while the loop waited for CI. Investigation of
the current corpus found a verified textual/logical gap, rather than
adopter-side confirmation: full-profile E1's opening sentence and the
lite profile's precondition led workers to wait before fetching, while
the full profile's actual CI condition only gates Step 2's watermark
(issue kurone-kito/idd-skill#3577). The drift traces through
kurone-kito/idd-skill#988, #1297, and #3465, which progressively
delayed Step 2 without stating that Steps 1 and 3 were independent;
the lite profile's 2026-07-22 authoring commit `9a95e5858` also placed
the condition before Step 1.

The correction keeps the watermark safety gate and lets review snapshot
and triage proceed while CI or the expected advisory re-review is
incomplete. The next full E1 entry records the deferred watermark after
those signals resolve.

### Review-fix escalation examples

Issue kurone-kito/idd-skill#2223's clone-scoped lock continued to draw
new P1 concurrency findings over several review rounds even after
replacing mtime-based staleness with PID-liveness checks. PR
kurone-kito/idd-skill#2389 removed automatic stale-lock takeover and
replaced it with a timeout that reports the lock path and holder PID
for manual recovery, matching Git's own `index.lock` collision
behavior (observed 2026-09-01, kurone-kito/idd-skill#2389). That
simplification was safe because the issue's acceptance criteria
required acquire/release, not automatic stale-lock recovery.

The CommonMark-targeting structural-evidence parser for issue
kurone-kito/idd-skill#2767 was implemented in PR
kurone-kito/idd-skill#2840. An adversarial automated reviewer
surfaced distinct gaps between the parser's supported behavior and
CommonMark rendering over 27 review rounds, each an in-scope
correctness gap rather than a repeating symptom of one mechanism
(observed 2026-09-10, kurone-kito/idd-skill#2840). The loop ended
after the operator accepted three remaining findings as a documented
limitation and filed kurone-kito/idd-skill#2865 as the scoped
follow-up.

### Whole-class sweep: why the E13 reply names the pattern and the count

E9's sweep rule ("fix the whole class, not just the flagged line") was
soft in three ways: it left "systemic" undefined, it swept "the current
diff (and adjacent sections)" rather than a defined file set, and
nothing in the reply showed that a sweep ran, so a session that skipped
it looked the same as one that did it. The old text also asked for "one
commit"; the rule now asks for the same push, because the review cost
is per push and commit atomicity is a separate repository rule. E10's
round-count heuristic (Tier 1) is a complementary, round-level check
for the same area and did not stop the cases below. The trigger is now a
finding that names a searchable pattern, which narrows the old
"systemic finding" wording on purpose: a class with no searchable form
(a wrong ordering, a missing step) is not swept by this rule. The lite
twin keeps the old wording; porting the rule there is a later issue.

Observed 2026-10-05 on kurone-kito/setup.ubuntu#201, an adopter
re-import reviewed on 11 heads (kurone-kito/idd-skill#3801):

- The same dangling clause, `reset on pass)`, sat at two sites of the
  imported template, `idd-pre-merge.instructions.md` and
  `idd-merge.instructions.md`. Copilot reported the first at head 2
  (01:34Z); Codex reported the second at head 8 (09:15Z). Both files
  were in the pull request's diff throughout.
- A hard-coded base branch was reported site by site: B1 at head 3,
  the lite D1 at head 4, the signed-merge wrapper at head 5, F4 at
  head 8, and the lite D3 and D3.5 at head 9. Each report cost a push
  and a fresh round of up to three review bots.

Replay through the written rule:

1. `reset on pass)` at head 2. Both reviewers quoted the fragment as a
   code span, so the finding names a pattern. Searching the pull
   request's changed files (50 at that head) for it finds one more
   instance, in `idd-merge.instructions.md`, so the same push fixes both
   sites and the E13 explanation says it swept `reset on pass)` and
   fixed 1 other instance. Head 8's report of the second site never
   happens.
2. `origin/main` at head 3. The finding is a hard-coded base branch
   where the configured one applies. A search for the literal in the
   changed files at that head (50 files) hits 18 lines in 7 files: 2 in
   `idd-work`, 6 in the lite `idd-pr-submit`, 3 in the lite `idd-work`,
   2 in the lite `idd-merge-handoff`, 1 in the lite `idd-review-fix`, 3
   in `docs/idd-helper-scripts.md` and 1 in
   `docs/idd-design-rationale.md`. The rule asks for each instance of
   that defect, so every hit is judged against it: the rationale
   example (`git diff origin/main...HEAD` in a review-cost story) is not
   an instance and stays, the instances are fixed in the same push (the
   head-3 fix swept 3 files), and the reply names `origin/main` with the
   number of other instances fixed, which tells a reader that one
   flagged line led to a sweep of the changed files.

What a text search cannot find: of the six sites of the base-branch
defect, three held the literal (B1, the lite D1 and the wrapper); the
other three did not. They were a `<default-branch>` placeholder, a
missing `--base`, and a gap in the closing-set logic. The sweep rule
cannot reach them, which is why the reply states the pattern that was
searched: a reader or the next review wave can re-run that search, and
a count of `0` needs the pattern named, so "swept, nothing else found"
stays distinguishable from "not swept".

A file the pull request does not change is never swept: widening the
diff to every match multiplies the review surface of one push. Its
instances go to the pull request body's follow-up list (editing the
body follows E12's PR body sync rule; a reviewer's finding there is
rejected under E5's "Reject now but should do eventually" rule). "The
files this pull request changes" is the set D3.6 already derives with
`git diff --name-only origin/{development-branch}...HEAD`, and a source
file and its generated mirror count as one instance. The count belongs
to a swept item: an item already fixed by an earlier push cites that
commit instead, and an Accepted item with no E13 reply (a critique-pass
finding) has nothing to carry it. The rule adds no checker, only a
signal: E10 runs before the reply is written and never sees it. The audit pins the
four clauses (trigger, file set with the same push, limit, reply
content) so that a later rewording cannot drop one silently.

### Merge-main livelock under fast-moving `main`

Under heavy concurrent-session load, `main` can advance before one
{sync path → E1 → F1/F2} cycle finishes, re-triggering
`behind-no-conflict`; naive repetition livelocks, never reaching F3
while `main` keeps moving. The fix is procedural, not structural: post
the `review-watermark` as the last action before F3's
`idd-merge-execute.mjs --apply` on every pass, so anything that happens
after — a CI rerun settling, a new disposition reply, another `main`
advance — stales it and fails `--apply` closed on `review-currency`
rather than merging on data the retry has since invalidated.

### Bot-comment wording matchers need a real-sample evidence bar

IDD classifies advisory-bot output (CodeRabbit, Copilot, Codex) by
exact wording, and every classifier's own detection patterns were
added one wording at a time, each after a separate field report —
with no consistent evidence bar for how many real samples justified
adding one. `kurone-kito/idd-skill#2641` derived its courtesy-
acknowledgment template from 18 of 18 real samples;
`kurone-kito/idd-skill#2710` was closed as not planned on a 10-of-10
sample that showed the proposed signal never appears on its own;
`kurone-kito/idd-skill#3193` was accepted on a single second-hand
report from a private repository, with the key sentence never even
captured verbatim (matched structurally instead). No committed copy of
any real bot body backed any of these decisions, so nothing would have
noticed if live vendor output later drifted from what a matcher
expected — a suppressed-comments parser going stale unnoticed is
exactly that failure mode realized.

A single rule resolves the inconsistency, applied going forward: a new
wording enters the registered wording-classifier list only with at
least 3 real samples from at least 2 distinct PRs, added to a
committed bot-comment corpus fixture in the same PR, each entry
recording its own provenance (bot login, PR number, review or comment
id, and the revision's edit timestamp when the body came from an
edit-history query) so anyone can re-fetch and re-verify it. A
network-free contract test enforces the bar mechanically: it re-runs
every registered classifier over every corpus entry that names it, and
separately checks each classifier's own real-positive-sample count and
distinct-PR count against the floor. A classifier that predates this
rule with fewer real samples than the bar requires is not
retroactively broken by it — it is named on a test-pinned grandfather
list instead, each entry stating its originating issue and the search
that found too few samples, so widening that list is a visible,
reviewable edit rather than a silent exception.

Copilot review coverage is a companion fix from the same roadmap, not
part of this wording-matcher rule: it moved from a denylist (every
review counts as covering except one exact error template) to a
positive signature (a recognized-review-body-shape check), closing the
same fail-open direction a wording denylist has — an error message in
new wording no longer silently counts as a covering review.

### Zero-Accepted-PATH-A advisory re-review gate

Without this gate, E8's zero-Accepted-PATH-A path would skip E14 (the
only step that requests a fresh primary-advisory-bot review) entirely,
so a PR whose Copilot findings were all Rejected in a given pass could
reach F2's advisory-convergence check with the bot never having
reviewed the resulting HEAD. The gate closes that gap by running E14's
Primary advisory bot procedure at the now-stable HEAD whenever a
durable marker records that the last non-empty snapshot at the current
HEAD zeroed out on a completed-review PATH B disposition (condition
(a)), before proceeding to F1.

Condition (b) — the current HEAD's eligibility for AW3-S's
settled-window (non-pending) entry — is a defense-in-depth backstop
for a narrower subset of cases: D4 and F2 each already consult AW3-S
independently for this same settled-window entry, but a true-virgin
empty snapshot (one that never satisfies condition (a) on its own)
otherwise never runs E14 through this gate specifically. Condition (b)
guarantees that path also reaches the stale-request recovery cycle
(and its route to `COPILOT_UNAVAILABLE`), rather than depending solely
on D4/F2 revisits eventually accumulating enough AW3-S cycles on their
own.

The gate's own state was originally tracked only in the current
session's in-memory recollection of its last E1-E3 pass ("this
episode"), with no durable, GitHub-visible record: a session that
crashed, restarted, or resumed after that pass had no way to
reconstruct whether the gate should have fired for the current HEAD.
A dedicated `zero-accepted-path-a-gate` marker (see
`idd-review-triage.instructions.md`) now persists which condition
fired and the HEAD SHA it was evaluated against, read back on every
evaluation instead of relying on session-local memory; a marker
recorded against a HEAD SHA that no longer matches the PR's current
HEAD — for example, after a sync-path merge advances HEAD — is stale
and does not satisfy the gate for the new HEAD.

### An advisory bot's embedded-but-unthreaded findings: mirror the detection scope, not the gate scope

A review bot can embed a specific, file/line-cited finding inside its
review body's prose (an older collapsible-section format, e.g.
CodeRabbit's "Nitpick comments" / "Outside diff range comments") with
**no** corresponding threaded review comment of its own (observed
2026-09-03, kurone-kito/idd-skill#2197's live sweep,
kurone-kito/idd-skill#2559).
Because E1 Step 3's "Review bodies" rule only pulls a review into
`ReviewItems_snapshot` when its state is `CHANGES_REQUESTED`, and this
bot-review-state pattern reports `COMMENTED` instead, the whole review
body — not just the embedded finding — was invisible to E1, and E4-E8
never Accepted or Rejected it.

This is the same class of gap Copilot's `suppressedCount` handling
already closes (kurone-kito/idd-skill#1880,
`advisory-convergence.mts`): a finding that exists in a bot's review
but has no GitHub thread of its own. For a non-gating PATH B advisory
bot, mirror kurone-kito/idd-skill#1880's _detection pattern_ (parse
the embedded findings, compare against threaded-comment count) but
not its _gate-enforcement scope_: an uncovered finding becomes an
ordinary PATH B
`ReviewItems_snapshot` entry, not a new merge-blocking check.

One sharp regex edge worth recording: matching a severity word like
"Trivial" against a markdown-italic-wrapped segment (`_Trivial_`) with
`\bTrivial\b` never matches — regex `\b` treats `_` as a word
character, so there is no boundary between the closing `_` and the
preceding letter. Drop the trailing `\b` rather than trying to work
around it with lookarounds, when the surrounding text is already
narrowly scoped enough that the ambiguity risk is negligible.

### E4/E5 round-count defer cutoff

E4/E5 scored each PATH A item Low/Medium/High with no ceiling on how
many review-fix loop rounds (E1-E15) a PR could cycle through while new
Low-severity findings kept arriving. `critiqueLoop.e10NoProgressHoldAfter`
is a narrower guard: it only fires when the **same** Accepted finding
recurs without progress across consecutive E10 passes — its own
"meaningful progress" carve-out explicitly does not fire when each round
surfaces a genuinely new finding, since that is convergence, not
stagnation, by its own definition. A PR where successive rounds each
raise a different, real Low-severity finding (e.g., one advisory bot
converges, then a second bot's own first review arrives after the first
bot's findings are fixed, itself finding something new) triggered no
existing guard while extending indefinitely.

Observed as Copilot review-submission counts climbing into the dozens
on a handful of PRs in this repository's own dogfooding history
(kurone-kito/idd-skill#2863); each review-submission count tracks one
full E1-E15 loop iteration, since E14 requests a fresh review after
every push, regardless of reviewer state.

Only Low-severity PATH A items are eligible for the deferral
disposition — Medium and High stay fully blocking, matching
`e10NoProgressHoldAfter`'s own precedent ("unresolved High/Medium
findings remain blockers until fixed or explicitly redirected by a
maintainer"). The default threshold (`15`) is a starting point,
expected to be tuned once a repository has enough review-fix-loop
history to judge it, not a final calibration.

This rule is superseded for needs-decision items by
[the needs-decision deferral entry](#needs-decision-deferral-of-review-findings-kurone-kitoidd-skill3776).

`Reject (defer)` reuses the existing `**Rejected**`-prefixed reply
format instead of introducing a new top-level disposition category:
`isDispositionComment` already parses "starts with `**Rejected**`," and
F2/F3 pair dispositions to advisory comments 1:1 by count — a new
category would require touching that parser and gate for no functional
gain, since a deferred item's terminal state (rejected, with a reason
and a linked follow-up) is identical in shape to an ordinary rejection.

#### Sequencing the deferred follow-up against its originating issue (kurone-kito/idd-skill#2877)

E6's follow-up-issue rule requires a `Refs #<originating-issue>` line
on the deferred-work follow-up, and `Refs` is deliberately non-blocking
everywhere else in this workflow (including `discover-roadmap-graph`'s
cycle exemption) so an ordinary citation never stalls Discover. That
general rule is wrong for this one follow-up shape specifically: the
deferred work cannot be meaningfully implemented before the PR/issue it
was deferred from actually lands, yet nothing stopped Discover from
picking up the follow-up immediately. Rather than changing `Refs`'s
general semantics, `discover-readiness-check.mts` adds a narrow,
marker-scoped rule: when a candidate's body carries the
`<!-- {{PROJECT_MARKER_PREFIX}}-authoring-defer-source: review-fix-loop-cutoff -->`
marker, its `Refs #<N>` reference is resolved the same way an ordinary
`Blocked by #<N>` line is — excluded from Discover while `#<N>` stays
open. An unmarked issue's `Refs` lines are completely unaffected.

A follow-up filed under the second defer-source value,
`review-needs-decision`, takes the same rule: see
[the needs-decision deferral entry](#needs-decision-deferral-of-review-findings-kurone-kitoidd-skill3776).

#### Reconciling the deferred follow-up with its pull request (kurone-kito/idd-skill#3624)

E5 defers a finding by filing one follow-up issue, and the source review
thread then gets a `**Rejected** — deferred to follow-up issue #<n>`
reply. The reply needs the issue number, so it can only be posted after
the follow-up exists. That order fails toward a duplicate, never toward
a lost finding: replying first would leave a resolved thread naming a
follow-up nobody created. Filing is several non-atomic remote writes
(journal record, issue creation, identity record, owner marker, member
record) and the reply comes after all of them, so nothing reconciled the
two halves when a session stopped between them.

Observed 2026-09-29 to 2026-09-30, follow-up #3615 for the pull request
that implemented #3591 (#3604). Copilot opened a review thread at 16:12Z.
The first session filed #3615 for it and posted its owner marker at
16:54:20Z, but the journal record stayed `pending` and the deferral reply
was never posted. After a forced handoff the successor saw an unreplied
thread, judged it fresh, and fixed it in the pull request itself; nothing
pointed it at #3615. When the pull request merged and #3591 closed, the
`Refs #3591` line stopped holding marked follow-ups back in Discover
(#2877), so only the authoring label still kept #3615 out of Discover,
although it described work already delivered. It was closed by hand as
not planned. The successor's own follow-up for the same pull request
(#3617) carried its reply, so the sequence works when uninterrupted.

Frequency, from a GitHub search over the marker text on 2026-09-30 (the
search index may undercount): 17 issues carry the marker since
2026-09-10. Two are excluded, #3398 (its findings came from an E2 critique
pass, so no thread exists) and #3394 (no parseable `Refs` line). Of the
remaining 15, 14 have a matching `deferred to follow-up issue` reply on
the originating pull request and #3615 is the one that does not. That is
one confirmed incident in 15, so low frequency, but nothing automated
would ever catch it: F3's unresolved-thread gate only forces someone to
answer the thread, not to notice the follow-up.

Decision: `pre-merge-readiness` reports every open marked follow-up whose
sole `Refs` line names the pull request's origin issue as `deferFollowUps`,
and F3 blocks on `deferred-followup-unreconciled` until the pull request
names it (body, conversation comment, review body, or any review-thread
comment, resolved ones included), and on `deferred-followup-unverified`
when the follow-up set cannot be enumerated completely. Either repair
clears the first gate: a reply on the source thread when the finding is
still deferred, or a pull request comment when it was fixed in the pull
request or is no longer needed. Any author counts, because this proves the
pull request names the follow-up, not that the choice was right. A trusted
IDD-operational comment is the exception: the live status digest lists the
open blockers, this gate's own follow-up number included, so counting it would
let the digest entry for the blocker clear the blocker (preventive; no
observed incident yet).

Rejected alternatives:

- **Reply-first ordering.** It leaves a resolved thread naming a follow-up
  nobody created, which is worse than a duplicate follow-up.
- **Detecting the gap at successor resume or E1.** It needs an instruction
  pointer that the bundles at the context ceiling cannot hold, and it only
  helps when a successor exists.
- **Clearing only on the exact reply format.** A fix made in the pull
  request is a valid outcome that never produces that reply, so requiring
  it would force a false "deferred" reply.
- **Enumerating through the origin issue's timeline.** It pages through
  every comment event of the origin issue, where the marker search is one
  call.

The same reconciliation covers a follow-up filed under the second
defer-source value, `review-needs-decision`: see
[the needs-decision deferral entry](#needs-decision-deferral-of-review-findings-kurone-kitoidd-skill3776).

#### 2026-09-15 recalibration to 12, using a month of real data (kurone-kito/idd-skill#2999)

After a month of historical review-fix-loop data accumulated in this
repository — distinct from the `15` default's own much shorter live
track record — a full sample of this repository's own merged PRs
(rather than the small, cherry-picked set that originally motivated
`15`) showed a p95 in the single digits and fewer than 3% of PRs
reaching a round count anywhere near the configured threshold, albeit
with a rising trend over that month as this repository's own IDD
concurrency and throughput grew. The default was lowered to `12` —
still comfortably above ordinary usage, but tightened in response to
that trend rather than left on its original starting-point value
indefinitely. A same-day PR review also caught, and this recalibration
corrected, a pagination bug that had silently undercounted the busiest
outlier PRs in the initial sample; the percentiles this recalibration
actually turns on were unaffected, but adopters reproducing this kind
of analysis should paginate the full result set, not just its first
page. See kurone-kito/idd-skill#2999 for the full methodology and
figures behind this recalibration; adopters without an equivalent
history of their own should keep tuning this value from their own
observed data rather than adopting either number as a universal
constant.

#### 2026-09-21 correction: count Copilot reviews, not watermark posts (kurone-kito/idd-skill#3162)

An audit of PRs merged in this repository during a six-day window found
`Reject (defer)` never fired, because the cutoff compared against the
claim-scoped `review-watermark` post count instead of the actual
`copilot-pull-request-reviewer[bot]` review-submission count the
original calibration above was based on — the two counters diverge
sharply once a session handoff/resume resets the claim-scoped count.
The round-count cutoff now compares against the pull request's total
review-submission count, PR-wide and fully paginated, instead. See
kurone-kito/idd-skill#3162 for the observed counts.

### E4/E5 adopt-now urgency defer

E4 scores each PATH A item on one axis, severity/relevance to PR
intent. A finding that is minor but genuinely _in scope_ is not Low
under that definition, so it lands in Medium's "judge by context"
branch and is typically accepted because it is correct — and every
Accepted PATH A fix is a push, with E14 requesting a fresh review
after every push, so each such fix can buy one more review wave whose
own diff surfaces new findings. The round-count cutoff above doesn't
cover this case: it only fires after its own round threshold, for Low
items only, and most review waves in this repository's own dogfooding
history happened well before that cutoff could act (observed
2026-09-24; see kurone-kito/idd-skill#3222 for the full baseline).

A code-review bot's severity label, where one is exposed, typically
has no published definition, no configuration, and no API field, so
an agent's own E4 tier must stay authoritative; the bot's label can
only raise the defer-eligibility floor, never substitute for it.

`critiqueLoop.deferByUrgency` adds a second, independent trigger,
active from round 1, gated on this opt-in key. See
kurone-kito/idd-skill#3222 for the live baseline behind the decisions
below.

#### Groom hearing decisions (2026-09-24, kurone-kito/idd-skill#3222)

- Add a second triage axis, "worth another Copilot review wave in this
  PR" (adopt-now urgency), and defer a finding whose adopt-now urgency
  is low to a bundled follow-up issue, the same way the round-count
  cutoff does, but from round 1.
- The severity ceiling for this new trigger is Low plus Medium (mode
  `low-and-medium`); High is never deferred under `low` or
  `low-and-medium`. This supersedes a Low-only ceiling **for this new
  trigger only**; the round-count cutoff above stays unchanged and
  Low-only.
  The High ceiling is superseded for needs-decision items by
  [the needs-decision deferral entry](#needs-decision-deferral-of-review-findings-kurone-kitoidd-skill3776).
- Keep the round-count cutoff as an unchanged backstop; the new rule
  is an independent trigger applying from the first E4/E5 pass.
- Apply to every PATH A actor, not only a code-review bot, with the
  agent's own E4 tier authoritative and any bot severity label
  recorded as evidence only.
- The adopt-now allowlist is exactly (a) a regression this PR
  introduced, (b) an unmet claimed-issue acceptance criterion or
  requirement, (c) correctness, safety, or CI-stability, and (d)
  piggybacking on a push that is already certain -- condition (d)
  keeps new diff surface, and the fresh findings it can attract,
  bounded.
- Distribute as an opt-in policy key with default `off`; a repository
  opts in per its own review-cost profile.
- A follow-up filed by either trigger carries the
  `review-fix-loop-cutoff` defer-source marker. The issue-authoring
  skill's Stage 2 narrow auto-release exception releases that hold
  immediately, so the deferred issue does not wait for a human
  release request.

#### E6 bundles one follow-up per pass (kurone-kito/idd-skill#3866)

E6 bundles one E5 pass's deferred items into one follow-up issue and
says not to append to it. Read alone, that is a bare rule, and a reader
may treat the append ban as a limitation to work around: a private
downstream adopter proposed one rolling follow-up per pull request on
2026-10-05 for that reason (#3222 records why the ban exists). The
narrow auto-release of a defer-source follow-up compares the live
body's SHA-256 with the `body-sha256` pinned by the first
`mode=acquire` marker. A body appended later no longer matches that
pin, so it loses the auto-release. Keep one follow-up per pass, and
create a new one for the next pass rather than appending.

#### Severity-tiered urgency (kurone-kito/idd-skill#3589)

`severity-tiered` is a third `deferByUrgency` value. It replaces the
binary adopt-now allowlist with an ordinal urgency score (`very-low`
< `low` < `medium` < `high`) beside the E4 severity. At relax step 0,
which is the whole matrix unless `critiqueLoop.deferRelaxAtRounds` is
set (see the wave-gradient subsection below), High defers only
at `very-low`. Medium, including unknown severity, defers at
`very-low`, `low`, or `medium`. Low defers at every scored urgency.
An unscored urgency does not defer. `low` and `low-and-medium` still
never defer High, so the hearing bullet above applies to those two
modes only. That bullet's condition (d), piggybacking on an already
certain push, belongs to the binary allowlist and has no counterpart
here: the matrix alone decides.

PR #3550 and PR #3574 motivated the High cell as context only; neither
is a dependency. On 2026-09-28 those pull requests had review
submissions on many distinct commits: PR #3550 had Copilot on 94,
Codex on 79, and CodeRabbit on 4; PR #3574 had Copilot on 95, Codex on
82, and CodeRabbit on 4. Those counts show repeated re-evaluation.
They are not the number of unique findings, and they carry no
severity breakdown or per-finding marginal wave cost, so they cannot
show how often a High finding was truly `very-low` urgency.

Two review-history observations shaped the wording instead. Copilot's
overview on PR #3550 reported no findings on `fcc6e1620` before Codex
reported three safety findings on that same commit, so E4/E5 must
inspect every actionable PATH A finding even when an overview is
empty. PR #3574 drew repeated Medium correctness findings during its
review cycle.

#### Wave-gradient urgency defer (kurone-kito/idd-skill#3796)

`critiqueLoop.deferRelaxAtRounds` adds an optional wave gradient to
`severity-tiered`. Before the gradient, the matrix above was the same at
every review wave, and the only round-dependent trigger,
`deferAfterRounds`, was Low-only, so the matrix itself never relaxed as a
pull request accumulated review waves.

Observed 2026-10-05 on kurone-kito/setup.ubuntu#201, an adopter re-import
of the v0.14.0 template (figures at head `25e3d5e`): 32 commits, 11
reviewed heads, 28 bot reviews and 74 review threads, open for about 12
hours at that head, with no finding deferred (its description records no
follow-up issue). Five earlier template re-imports in that repository
(#62, #101, #126, #154, #189) merged after 1 to 4 heads. Of the 74
threads, 26 were created or exposed by the pull request's own edits (one
configured-branch inconsistency was reported site by site over six
heads), and the first head already drew threads at the usual density (2.4
per 1,000 diff lines, against 0.4 to 2.8 before). The instruction text a
finding points at is the shipped behavior of an instruction repository,
so adopt-now (c) rates most such findings `high` urgency, and without
the gradient Medium or High findings of `high` urgency never defer
however many waves have passed.

Where the thresholds sit. Over the 100 merged pull requests numbered #3561
to #3781 (merged 2026-09-27 to 2026-10-05), the PR-wide Copilot review
count had a median of 2; 30 reached a 4th review, 25 a 5th, 14 a 7th and
10 a 9th, and the largest was 111 (#3574, counted through the REST
endpoint, because the GraphQL listing caps a pull request's reviews at
100 nodes, so a heavily reviewed pull request can come out too low there,
though never a threshold count). A gradient that starts at the 4th review
leaves a typical pull request unchanged and acts only on the long tail,
which is why `[4, 7]` is the recommended value.

Maintainer decision (Groom hearing, 2026-10-05): add a wave gradient to
`severity-tiered`, with thresholds that are PR-wide Copilot review counts,
two steps at most, and at the final step never defer a High-tier finding
of `high` urgency or a safety-class finding. The convergence-aware extra
step and this repository's own opt-in are separate issues in the same
roadmap. The normative rule is in
[Wave-gradient urgency defer](idd-review-policy-profiles.md#wave-gradient-urgency-defer).

Choices made while implementing, outside the hearing outcomes (which
named only the final step): the High-tier `high` urgency and safety-class
exclusion applies from step 1, and not at step 0, so a safety-class
Low-tier finding still defers at step 0 as it does today and an absent
field changes nothing. The safety class cites items 1, 2 and 4 of the
needs-decision stop test and leaves out item 3, the instruction or helper
contradiction, because most findings in an instruction repository would
match it and the gradient would never act. The exclusions govern the
`deferByUrgency` trigger only; `deferAfterRounds` is unchanged, as the
scope limits of issue `#3796` say. The consequence to know: from
step 1 on, a Medium-tier finding of `high` urgency that rests on adopt-now
condition (a), (b) or (c) but is not safety class defers to the bundled
follow-up.

Worked example with `[4, 7]`. The columns after the step show whether one
example finding defers (`defers`) or stays in the loop (`stays`): a
Low-tier finding of `high` urgency, a Medium-tier finding of `high`
urgency that is not safety class, a High-tier finding of `medium`
urgency, a High-tier finding of `high` urgency, and a safety-class
Low-tier finding of `low` urgency.

| Copilot reviews | Step | Low, `high` | Medium, `high` | High, `medium` | High, `high` | Safety class, Low, `low` |
| --------------- | ---- | ----------- | -------------- | -------------- | ------------ | ------------------------ |
| 1               | 0    | `defers`    | `stays`        | `stays`        | `stays`      | `defers`                 |
| 2               | 0    | `defers`    | `stays`        | `stays`        | `stays`      | `defers`                 |
| 3               | 0    | `defers`    | `stays`        | `stays`        | `stays`      | `defers`                 |
| 4               | 1    | `defers`    | `defers`       | `stays`        | `stays`      | `stays`                  |
| 5               | 1    | `defers`    | `defers`       | `stays`        | `stays`      | `stays`                  |
| 6               | 1    | `defers`    | `defers`       | `stays`        | `stays`      | `stays`                  |
| 7               | 2    | `defers`    | `defers`       | `defers`       | `stays`      | `stays`                  |
| 8               | 2    | `defers`    | `defers`       | `defers`       | `stays`      | `stays`                  |
| 9               | 2    | `defers`    | `defers`       | `defers`       | `stays`      | `stays`                  |
| 10              | 2    | `defers`    | `defers`       | `defers`       | `stays`      | `stays`                  |
| 11              | 2    | `defers`    | `defers`       | `defers`       | `stays`      | `stays`                  |

Count 4 is the first at which the Medium-tier finding of `high` urgency
defers, and count 7 is the first at which the High-tier finding of
`medium` urgency does; the safety-class finding defers only at step 0.

##### Converged extra step (kurone-kito/idd-skill#3797)

The count step does nothing at the first or second review. Observed
2026-10-05 on kurone-kito/setup.ubuntu#201, in the same reading as the
wave-gradient section above (figures at head `25e3d5e`). At head
`4af1831`, Copilot's overview reported no findings and no inline
comments, a Codex thread was open beside it, and the fix was another
push. That head was Copilot's 10th review, so under `[4, 7]` the count
step was already 2 and convergence would have added nothing. The case
that matters is a low review count. The opposite head in that reading,
`2cb41a0`, had no findings but carried 5 suppressed comments that were
never acknowledged, so `converged` stays false and the extra step does
not apply.

Maintainer decision (Groom hearing, 2026-10-05): treat a converged
advisory gate as one extra relax step, capped at 2. The declined
alternative, jumping to the final step on convergence, would also defer
a High-tier finding of `medium` urgency at the first review. The extra
step applies only when `reviewPolicy` is absent or `copilot-advisory`.
Any other advisory-convergence result adds nothing: the helper is
unavailable, the command fails, the output does not parse, `converged`
is absent or not exactly true, or `prHeadSha` differs from the head
stored at E1. A one-threshold array such as `[4]` plus convergence
reaches step 2, which is above that array's own final step.

Replay with `[4, 7]`. The three findings are a non-Copilot Medium-tier
finding of `high` urgency, a High-tier finding of `high` urgency, and a
safety-class finding.

| Case                                              | Count | `converged` | Step | Medium, `high` | High, `high` | Safety class | Clause                          |
| ------------------------------------------------- | ----- | ----------- | ---- | -------------- | ------------ | ------------ | ------------------------------- |
| Copilot converged on HEAD, no suppressed comments | 1     | true        | 1    | `defers`       | `stays`      | `stays`      | `step 1; converged <short-sha>` |
| Suppressed comments not yet acknowledged          | 1     | false       | 0    | `stays`        | `stays`      | `defers`     | no `converged` token            |
| Count of 7 or more                                | 7     | true        | 2    | `defers`       | `stays`      | `stays`      | `step 2`, no `converged` token  |

At count 1 with convergence, the Medium-tier finding of `high` urgency
is deferred at step 1 and the clause is
`step 1; converged <short-sha>`. The High-tier finding of `high`
urgency and the safety-class finding are not deferred. When Copilot's
suppressed comments are not yet acknowledged, `converged` is false and
there is no extra step. At a count of 7 or more the count step is
already 2, so convergence adds nothing and the clause carries no
`converged` token.

### Needs-decision deferral of review findings (kurone-kito/idd-skill#3776)

The review loop stops for a person at several points: the
`Awaiting maintainer decision` hold for an inconclusive item and for a
CODEOWNER or required-reviewer source (E5, E6), the E10 no-progress
hold, and the Tier 2 and Tier 3 stops. Each stop lands where an
autonomous session is least likely to have anyone to ask. Observed
2026-10-05, second-hand: the maintainer reported that agents in recently
imported adopter projects increasingly stop in the E phase to ask the
operator about serious or hard-to-judge review findings (the adopter
repositories are not named). Observed earlier in this repository:
issue kurone-kito/idd-skill#2767 (PR kurone-kito/idd-skill#2840) ran 27
review rounds and ended only when the operator accepted three residual
findings and filed issue kurone-kito/idd-skill#2865, as the Tier 3
example in "Review-fix escalation examples" records.

Decision (maintainer ruling, 2026-10-05,
roadmap kurone-kito/idd-skill#3776): when a finding needs a person's
judgment and merging the pull request as it stands cannot do the damage
listed in the stop test below, the session records the question as a
`needs-decision` follow-up issue, answers the finding, resolves its
thread as the selected profile allows, and keeps going. It applies at
E5, E6 and the three review-fix stops, for advisory bots, critique-pass
findings and people holding none of the actor-permission cap's standing.
It is on by default, with `critiqueLoop.deferNeedsDecision` as the off
switch. The rule itself is in the "Needs-decision deferral" section of
`idd-review-policy-profiles.md`; the instructions carry only pointers
that end in today's stop.

The stop test, and why each item is in it. Judged assuming the finding
is correct, the session still stops when merging as it stands would:

1. leave the development branch's CI red or the pull request
   unmergeable, because a deferral must not trade a known failure for a
   backlog item, and nobody can be asked later in the same loop;
2. leave the defect in claim, lock, merge-gate, security or
   secret-handling, or data-destroying code or behavior, of the loop or
   of the project, because those are the places where a wrong merge does
   damage a revert may not repair, and where the protection that
   issue kurone-kito/idd-skill#1933 gave a valid high-severity report
   matters most;
3. ship an instruction or helper contradiction that would misguide the
   next session's agent, because the damage repeats in every later
   session rather than staying in one pull request; or
4. be impossible to reverse in a follow-up pull request, because a
   follow-up can only repair what a pull request can still change.

What it overrides, for this narrow class only. First, the
repository-owner-confirmed rule recorded with
issue kurone-kito/idd-skill#2863 that Medium and High findings stay
fully blocking; the urgency triggers of
issues kurone-kito/idd-skill#3222 and kurone-kito/idd-skill#3589 had
already relaxed it in narrow cases. Second,
issue kurone-kito/idd-skill#1933's routing of an inconclusive claim to
the `Awaiting maintainer decision` hold so that a valid high-severity
report is never silently resolved. The route keeps what
issue kurone-kito/idd-skill#1933 protected: the reply must name the
unavailable check, and the follow-up must record the claim as
unverified. An agent may now redirect a finding that only a maintainer
could redirect before.

Declined alternatives:

- Resolving a CODEOWNER or required-reviewer thread unilaterally: it
  removes the person the repository named, so that source, and any
  person holding Triage, Write, Maintain or Admin standing, stays
  outside the route.
- Making the follow-up `Blocked by` the pull request instead of the
  claimed issue: a pull request number unblocks the follow-up when the
  pull request closes unmerged, while the claimed issue stays open in
  that case.
- Asking the operator in the session: that is the stop this route
  replaces.
- A new doc for the rule: registering it adds lines to the generated
  blocks of two onboarding files, and the two onboarding bundles that
  contain them had 3 B and 33 B of headroom, so the rule is a new
  section of an existing doc.

Moving a normative rule out of an instruction file into a doc is a
deliberate choice forced by the byte budget: the review bundles sit near
their ceiling, and each pointer is a way out of an existing stop, so a
session that does not read the doc behaves as before. The route is a
distinct rule, not a trigger of the E5 Defer rule, whose exclusions and
unit tests stay as they are.

Cap: the fourth distinct follow-up filed from one pull request holds as
before. It bounds over-deferral by a weak model and the backlog that
F3's deferred-follow-up search reads (preventive; no observed incident
yet).

### review-ack worked example

A review posts a regular-comment finding plus a suppressed one.
Disposition the regular-comment finding normally (`**Rejected** —
verified placeholders-only`), then also post `review-ack:
claude-code-1a2b3c4d 4b825dc642cb6eb9a060e54bf8d69288fbee4904
2026-08-19T00:10:00Z` (plain text, no HTML comment) to cover the
suppressed one — the regular-comment rejection alone never sets
`converged`, and this is not a license to skip **AW6** or the fix flow
when the suppressed finding needs a code change.

## Advisory wait

### AW3-S vs AW3-R: why two recovery paths

`AW3-R` fires only once the pending Copilot request is already proven
to cover HEAD (`COPILOT_PENDING_COVERS_HEAD = true`) and just needs a
missing marker anchored. The opposite, unproven case — a pending
request whose association with current HEAD cannot yet be confirmed —
cannot be resolved by `AW3-R`'s marker-only path, since there is
nothing yet to anchor. `AW3-S` adds a bounded remove/re-request/
verify/mark cycle for that case, deliberately capped far below the
ordinary `REQUEST_CAP` (30) by an independent per-HEAD recovery-cycle
budget (default 2), because each cycle mutates live reviewer state
(remove + re-request) rather than merely posting a marker.

### Terminal Copilot stall-recovery contract: why a separate signal

`COPILOT_UNAVAILABLE` is a signal structurally independent from every
existing advisory-satisfied field, rather than folded into
`outcome`/`f3Outcome` directly. Keeping it independent means a future
readiness rollup can consume it without risking a silent, accidental
widening of what already counts as "advisory satisfied" — the terminal
signal only ever unlocks a maintainer waiver path, never merge
readiness on its own. `AW3-S`'s `"cap-exhausted"` classification
deliberately does not by itself prove `COPILOT_UNAVAILABLE`: a HEAD can
exhaust its recovery-cycle budget while the terminal window has not yet
elapsed, or while a fresh same-HEAD review has since landed — either
fact alone would make an immediate terminal declaration premature.

### Non-Copilot advisory convergence is intentionally not a merge gate

kurone-kito/idd-skill#909 (2026-06-17) decided, in the idd-skill source
repository's own configuration, that the Copilot advisory-wait /
convergence protocol stays **Copilot-only** there, where Copilot is
the configured `advisoryWait.primaryBotLogin`. An adopter repository
may mirror or override that posture. Configured secondary, non-primary
`advisoryBotLogins` (e.g. a CodeRabbit or Codex connector) get no
equivalent merge-blocking required check. (A repository using the
`external-bot` profile to route `advisoryWait.primaryBotLogin` to a
non-Copilot bot instead would gate on that bot's convergence the same
way — this reaffirmation is scoped to the non-primary advisory bots,
not to "non-Copilot" as a fixed identity.) kurone-kito/idd-skill#899
recorded the deliberate scope and its two-part safety net: **pre-merge**, the E1
activity-universe snapshot plus `review-watermark` delta catches a late
finding before merge by forcing a return to E1 when the F2/F3
pre-merge gate detects new activity; **post-merge**, a merged-PR
unresolved-feedback sweep (kurone-kito/idd-skill#931) — a
manually-invoked, read-only detector whose output an operator feeds
into fresh issue authoring, not an automatic recovery path. It
surfaces two kinds of item: (1) a top-level regular comment or
`CHANGES_REQUESTED` review body with **no later** IDD disposition
anywhere on the PR (its collectors compare each item's timestamp
against a single global disposition cutoff, not a per-item reply
check, so an item posted before the latest disposition counts as
"addressed" even when that disposition was for something else
entirely, including a disposition reply found inside a review thread —
the global cutoff folds those in even though this collector's own
output only ever lists top-level comments and review bodies, never
thread items); and (2) any review thread still **unresolved** at
merge time and not opened by an IDD agent itself, regardless of
whether it carries a disposition reply (that collector filters on
resolution state and origin-comment author, flagging
`dispositioned: true`/`false` either way). Symmetrically, the sweep
has **no backstop** for: a comment or review body with _any_ later
disposition, correct or not; a thread an IDD agent itself opened; or
a review thread that was **resolved** — whether with a correct
disposition, a false disposition, or no disposition reply at all.
Resolving a thread removes it from consideration outright.

kurone-kito/idd-skill#1352 re-opened the question after a required-check
promotion shipped for the Copilot dimension, and after a weak-model
structural audit found a concrete non-Copilot fail-open: the review-triage
phase can mis-classify a non-Copilot bot's **non-review notice**
(rate-limit, "usage limits reached", queued) as a completed clean review,
and the disposition verifier validates the model's own self-report rather
than live GitHub — so an omitted or false disposition passes. Under
`fully_autonomous_merge`, that path can reach merge without a
GitHub-side block.

The maintainer **reaffirmed kurone-kito/idd-skill#909** on
kurone-kito/idd-skill#1352 (2026-07-14): the operational objections are
unchanged and still outweigh a hard gate — non-Copilot bots are capricious
(a run may post nothing at all, and a review bot's first post is often a
PR summary rather than actionable findings), re-review is mention-only
with no clean per-HEAD completion signal, and pinging a bot risks waking a
lenient reviewer mid-merge. The mis-classification and self-attested-
disposition fail-opens are therefore recorded as an **accepted risk**
under `fully_autonomous_merge`, not a defect — the pre-merge snapshot
net still catches a late-arriving finding before merge, but a false
disposition it already produced has no sweep backstop (see above),
same as kurone-kito/idd-skill#909 originally decided to accept. A
repository that reaches this same conclusion
independently should record it here rather than re-litigating it on every
structural audit.

## CI

### 404-vs-403 ambiguity on branch-protection/ruleset reads

None of the three required-check-discovery endpoints (branch
protection, ruleset list, ruleset detail) documents `403` as a possible
response at all: the branch-protection reference lists only
`200`/`404`
(<https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection>),
and the ruleset-list/ruleset-detail references list only
`200`/`404`/`500`
(<https://docs.github.com/en/rest/repos/rules#get-all-repository-rulesets>,
<https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset>).
GitHub's own REST troubleshooting guide documents this as general API
behavior: a `404` on a private resource substitutes for `403` to avoid
confirming the resource's existence, and insufficient token scope is a
listed cause of a `404` on a resource that actually exists
(<https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource>).
Because these endpoints never document `403`, a `404` on any of them
is structurally ambiguous between "genuinely nothing configured" and
"the token cannot read this" — the response body cannot resolve that
ambiguity, and an actor's collaborator role cannot either (role is not
proof the caller's own token carries the scope the endpoint requires).
This is why `idd-ci.instructions.md`'s Required-check discovery step 4
treats every `404` on these reads exactly like a `403` unless the
repository opts out via `ciGate.trustEmptyProtectionReads: true`.

### Rulesets-API write-side 404 for `gh`-CLI-default-OAuth-App tokens

A separate, write-side finding from the read-side ambiguity documented
above: `PATCH /repos/{owner}/{repo}/rulesets/{id}` can 404 for a
`gh`-CLI-default-OAuth-App-authenticated token even with confirmed
`admin: true` permission and a successful `GET` on the identical
resource immediately before the `PATCH`. The classic
`PUT /repos/{owner}/{repo}/branches/{branch}/protection` endpoint
remains a working fallback for the equivalent write with the same
token. This was observed with the `gh` CLI's default OAuth App token
specifically; whether a fine-grained PAT or a GitHub App installation
token behaves differently was not tested, and is left as an open
question rather than asserted either way. A repository that ships no
helper or documented procedure writing a ruleset via the REST API has
no functional gap here — this is a defensive documentation note.

## Pre-merge

### The non-advisory pre-merge dimensions are model-attested, not GitHub-side enforced

The pre-merge condition check (`idd-pre-merge.instructions.md`) and the
merge-time re-verification (`idd-merge.instructions.md`) gate claim
ownership/freshness, late non-Copilot review currency, non-Copilot
unresolved threads, and `dispositionEvidence` completeness through a
deterministic readiness helper. Unreplied comments are a separate
case: that helper's rollup deliberately excludes them, so this
dimension is gated only by the written checklist. None of these
dimensions has a dedicated GitHub-side
required check backing it — unlike the Copilot advisory-convergence
dimension that can be promoted to a trusted-checkout required check
(kurone-kito/idd-skill#1341, kurone-kito/idd-skill#1342). (A repository
that separately turns on GitHub's branch-protection
conversation-resolution requirement gets GitHub-side enforcement for
the unresolved-threads dimension specifically, as a side effect of
that unrelated setting — see the conversation-resolution exception in
`idd-pre-merge.instructions.md` — but that is opt-in and not part of
this reaffirmed posture.)

The helper is explicitly allowed to be **discarded**: the pre-merge phase
states that when helper execution fails, its output is invalid, or live
GitHub state disagrees with it, the session discards the helper output and
falls back to a direct live fetch plus the written prose rules. A weak
model can reach the merge command via that self-attested prose path
without the deterministic verdict actually forcing the block.

A repository choosing to accept this posture (kurone-kito/idd-skill#1353
reaffirmed it 2026-07-14) should record why: the "discard on
unavailable/invalid/conflict → prose fallback" clause is a deliberate
adopter-resilience valve (the helper runtime is optional, and a pure
PR-level required check cannot see a session's live `claim-id`/`agent-id`
context the way the model-run helper can); a full session-aware required
check can also fight a deliberately narrow CI trigger topology
(kurone-kito/idd-skill#832, which keeps CI scoped to `pull_request` only,
so nothing re-checks the merge commit itself) and existing checklist
hardening (kurone-kito/idd-skill#993). Under `fully_autonomous_merge`
this is then an **accepted risk**; adopter repos that keep a human
merge step retain that human as the backstop the autonomous path lacks. A
repository that reaches this same conclusion independently should record
it here rather than re-litigating it on every structural audit.

### F4 checks that the closing set is closed before it releases the claim

F4 step 1 closes the closing set's issues explicitly only when
`{development-branch}` is not the default branch. For the default branch
it relies on GitHub closing each linked issue at merge, and step 7 used
to post `unclaimed-by` without checking that GitHub had done so
(observed 2026-09-30).

Of the nine pull requests merged that day, each with a `Closes #N` line
in its body, four closed their issue within 2 s of the merge
(kurone-kito/idd-skill#3604, kurone-kito/idd-skill#3614,
kurone-kito/idd-skill#3612, kurone-kito/idd-skill#3613) and five did
not. An IDD session closed each of the five by hand with a
`Merged via #N` comment, 135 to 481 s after the merge:
kurone-kito/idd-skill#3624 (PR kurone-kito/idd-skill#3632, 135 s),
kurone-kito/idd-skill#3617 (PR kurone-kito/idd-skill#3618, 189 s),
kurone-kito/idd-skill#3592 (PR kurone-kito/idd-skill#3603, 193 s),
kurone-kito/idd-skill#3597 (PR kurone-kito/idd-skill#3605, 462 s) and
kurone-kito/idd-skill#3585 (PR kurone-kito/idd-skill#3610, 481 s). The
day before, all nine pull requests with closing references that merged
closed their issue within 2 s. No late auto-close was observed for the
five, and the cause is not established: the current
`closingIssuesReferences` of every one of the nine lists its issue, and
the bodies show no difference. One unconfirmed lead, from the sessions'
own notes and not visible on GitHub: for kurone-kito/idd-skill#3632 the
reference registered only about two hours after the PR was created and
shortly before the merge, and for kurone-kito/idd-skill#3618 about a
minute after a body edit; whether the other three registered late is not
known.

Each session improvised the same repair at a different point of its run
(for kurone-kito/idd-skill#3597 and kurone-kito/idd-skill#3624 after
`unclaimed-by`; for kurone-kito/idd-skill#3617,
kurone-kito/idd-skill#3592 and kurone-kito/idd-skill#3585 before it),
because nothing in F4 asked for it. Step 7 now reads each closing-set
issue's state once, closes an open one as step 1 does, and holds without
posting `unclaimed-by` when the read or the close fails, right before it
releases the claim. The check lives in step 7 and not step 1 because
step 1 is skipped on a resume for a default branch while step 7 runs on
every resume that still holds the claim, and running last also gives
GitHub's own auto-close time to fire first. It is a single read, never a
wait or a poll. The digest upsert stays first, so a failed close leaves
the digest at `F4 complete` with the claim held; a resume re-runs steps
4-7, where the upsert reports `noop` and the check runs again. The
exposure is small (an open, unclaimed, already-merged issue is mostly
caught by A4.5's supersession signals; the one documented window is
about three minutes, for kurone-kito/idd-skill#3597), so the rule rests
on the repeated hand repairs, not on the window.

### F4 verifies the PR digest before it releases the claim

Observed 2026-10-02 while completing kurone-kito/idd-skill#3728:
pull request [`kurone-kito/idd-skill#3730`](https://github.com/kurone-kito/idd-skill/pull/3730)
merged at `9113400ec41ab0a05e406a0621509a9f75acdfd2`, but its
live PR digest still said `F2 merge readiness`. F4 wrote the claimed
issue's digest as complete and posted `unclaimed-by`; a later dry-run of
`live-status-digest --pr 3730` returned `update`, while the normal claim
gate no longer allowed repair after release. An earlier F4 check alone
therefore leaves no ordinary repair path when the PR digest is still
stale at the release boundary.

F4 now repeats the PR-digest check after worktree and branch cleanup,
before writing the issue's completion digest or releasing the claim. A
two-parent merge derives the candidate head from parent 2. On a
`human_merge` resume, F2.5 did not write an F3 digest, so F4 repairs it
after cleanup from independently proven merge evidence. For a
one-parent squash/rebase, F4 carries the latest trusted same-claim F2
watermark SHA before comment cleanup can minimize its marker, and
captures the branch tip before removing the worktree. The values stay
separate: the watermark identifies the reviewed snapshot, and the branch
tip binds local cleanup. F4 derives the merged PR head independently and
compares it with the live `.head.sha`. The
digest cannot supply its own head proof. These inputs were added after
review found cleanup could otherwise remove the
only proof sources, the merged-PR resume route skipped F2 capture, the
detail guide omitted that step, the branch-tip proof was only in the
prior session's memory after branch deletion, resumed F4 could repeat
cleanup against absent worktrees and refs, and the provider view omitted
commit parents (PR `#3741` review comments
`#4173311932`, `#4173311978`, `#4173312001`, `#4173458244`, and
`#4173461374`, `#4173600915`, `#4173683166`, and `#4173871269`; preventive,
no completed F4 failure has been observed). Missing or mismatched evidence
keeps the claim active. Repair carries the `F3 merged` phase
and one `Last checked` value through dry-run, apply, and confirmation,
with claim ownership revalidated around apply. A duplicate, failed
validation, or inconclusive result stops before either completion write,
preserving the claim as the repair authority
(kurone-kito/idd-skill#3739; preventive; no observed incident yet for
unverifiable merge-head evidence).

When GitHub auto-delete is disabled, the profile-selected
`delete-remote-branch` helper performs the expected-SHA lease deletion
and verifies the result through the permitted helper command surface
(PR `#3741` Codex review comment `#4174479403`).

### F2 and F3 require the exact pull request head before the local checks (kurone-kito/idd-skill#3802)

Before D3.5 and D3.7, F2 read the local worktree and accepted
`git merge-base --is-ancestor HEAD "$PR_HEAD_SHA"`. That test passes a
checkout that is merely behind the pull request head, so D3.5 and D3.7
could validate an older tree and miss a closing keyword or an impact
checklist change made since. F3 said the worktree is checked out at the
head "exactly" and then used the same ancestry test. Both passages said
"after fetch" without fetching, and ended in a parenthesis that never
opened (`reset on pass`) after a `git switch` clause that could never
act once the branch check had passed.

Observed 2026-10-05 on kurone-kito/setup.ubuntu#201, an adopter
re-import reviewed on 11 heads: two bots reported the ancestry test at
the first head, the pre-merge fragment at the second, and the F3 copy at
the eighth. The adopter's reviewed patch is prior art for the sequence
below.

Provenance. The reset arrived with commit `cdf1126fb` (2026-09-10,
kurone-kito/idd-skill#2749), which wrote `git fetch` plus
`git checkout`/`git reset --hard`. Its ancestry guard came nine days
later (`dc7628e7b`, `6be6d9f28` and `b0f5fdc77`, 2026-09-19,
kurone-kito/idd-skill#3125): fetch, then stop and hold if the worktree is
dirty or not an ancestor, then `git reset --hard` to the head only when
the checks still hold, because a clean HEAD ahead of the pull request
would otherwise lose unpushed commits. Two edits lost the target of that
reset (`dd06e0d22` dropped the fetch command and the reset target, and
`094c2aaae` introduced the literal `reset on pass`), so the intent, to
advance a clean branch to the head, was never stated again.

Decision (author design from that prior art and the original intent,
maintainer ruling 2026-10-05 only that verified small template defects
are fixed upstream): F2 states one sequence and F3 points at it.

1. Fetch the pull request head into a remote-tracking ref with an
   explicit refspec, behind the clone-scoped lock when workers share the
   clone. A failed fetch holds, and a stale remote-tracking ref never
   stands in for it. A fetched SHA that differs from `$PR_HEAD_SHA` means
   the pull request moved while the advisory wait ran, so the session
   returns to E1.
2. Keep the branch check and the empty-status check.
3. Run the shadow-path check before any command that moves HEAD, because
   `git merge --ff-only` overwrites an ignored file that the target tree
   tracks while `git status --porcelain` is empty.
4. Require `git rev-parse HEAD` to equal `$PR_HEAD_SHA`. A strictly
   behind HEAD advances by `git merge --ff-only` after the claim is
   re-validated, since this is a git-state mutation, and must then equal
   the head. Any other relation (ahead or diverged) holds.
5. The check never runs `git reset`, so a HEAD ahead of the pull request
   is held with its unpushed commits instead of being discarded.

Equality is tested before ancestry because `is-ancestor` is non-strict:
a HEAD equal to the head satisfies it too. The `git switch` clause is
dropped, since after the branch check it could never act.

| # | Case                         | Outcome                          | Sentence applied                    |
| - | ---------------------------- | -------------------------------- | ----------------------------------- |
| 1 | HEAD equals the fetched head | Proceeds, worktree untouched     | step 4, equality                    |
| 2 | Clean and strictly behind    | Advances by ff-only, then equals | step 4, ff-only after re-validation |
| 3 | HEAD ahead of the head       | Holds, commits kept              | step 4, any other relation          |
| 4 | Head moved after the fetch   | Returns to E1                    | step 1, fetched SHA comparison      |

Known limit this entry does not remove (preventive; no observed
incident yet): an ignored file `tmp` that
shadows a tracked path `tmp/f.txt` passes both shadow-path pipelines, so
`git merge --ff-only` can still replace it while `git status --porcelain`
is empty.

## Instruction delivery

### Skill-based on-demand delivery of phase instructions: no-go (2026-07-16)

kurone-kito/idd-skill#1416 investigated packaging IDD phase instructions
(`.github/instructions/idd-*.instructions.md`) as Claude-compatible
skill bundles (`SKILL.md` under `.claude/skills/` / `.opencode/skills/`),
on demand, motivated by kurone-kito/idd-skill#1413's OpenCode support
track: OpenCode's only conditional-loading mechanism is skills, unlike
Copilot's `applyTo` frontmatter. The full findings live in the source
repository's `docs/skills-delivery-investigation.md`, which reaffirms
and extends `docs/claude-skill-strategy.md`'s prior Claude-Code-only
no-go (which evaluated wrapping the whole execution loop as a skill) to
explicitly cover OpenCode.

The decision: **no-go**, for either agent, under the current phase-file
boundaries. Once an OpenCode entry-file generalization ships
(kurone-kito/idd-skill#1414), OpenCode gains the same
routing-table-plus-on-demand-Read mechanism Claude Code already has, so
a skill wrapper would change only _how_ a phase file is requested, not
_whether_ it already loads on demand. More importantly, neither runtime
documents a "must load unconditionally" primitive for skills — every
invocation path is either an explicit model/user action or a subagent
preload, never a forced load at session start — so converting a
load-bearing phase file (e.g. `idd-claim.instructions.md`,
`idd-pre-merge.instructions.md`) into a skill would replace a
deterministic routing-table read with a probabilistic model judgment
call, weakening exactly the fail-closed guarantee the overview-core
claim-revalidation gate relies on those phase files being read for. A
third synchronized surface alongside the canonical template and the
generated instruction files would also multiply the drift matrix for
every phase-file edit.

Conditions that would revisit this: recorded evidence of routing-table
navigation failures on either agent at a material rate; either runtime
documenting a mandatory/required skill-invocation primitive; or explicit
adopter demand for skill-form delivery with a concrete use case the
routing table does not already serve. A project that reaches this same
conclusion independently should record it here rather than re-running
the investigation.

### Microsoft APM as an additional distribution channel: no-go (2026-08-02)

kurone-kito/idd-skill#1727 investigated whether the source repository
should distribute the IDD template through
[Microsoft APM](https://github.com/microsoft/apm) (Agent Package
Manager), a pre-1.0 MIT-licensed package manager for agent context,
beside the existing `idd-template/ONBOARDING.md` raw-fetch-and-copy
flow. The full findings live in the source repository's
`docs/apm-distribution-strategy.md`.

The decision: **no-go** for the core template. Five payload classes
(`.github/workflows/idd-advisory-convergence.yml`, `.githooks/`,
`.github/idd/config.json`, `profiles/`, `idd-template/docs/**`) have no
APM primitive at all — APM's `hooks` primitive is a false-friend name
collision with `.githooks/`, since it covers harness-runtime
lifecycle callbacks, not git hooks. The phase-instruction corpus's real
activation key is workflow-step position, which does not map onto
APM's file-glob-scoped `applyTo` frontmatter; encoding it either way
degrades current behavior (a meaningless glob, or folding every phase
file into the always-loaded compiled context and blowing the
`instructionSizeBudgets`/`bundleBudgets` caps). APM's `apm.lock.yaml`
pins per-file content hashes, which is structurally incompatible with
the template's 26 `{{...}}` placeholder occurrences that onboarding
substitutes in place — every onboarded repository would carry
permanent, unresolvable drift from completion onward. Multi-target
compilation also breaks the corpus's own cross-references (bare-prose
mentions of `<name>.instructions.md`, the large majority of the
corpus's ~200 such references) on every non-Copilot target, since each
target compiles instructions to a different directory and, for several
targets, a different file extension. Net, adopting APM for the phase
corpus reproduces the "third synchronized surface" objection that
already decided the skill-delivery no-go above, now as a new external
CLI dependency rather than a same-repo generated file tree.

The one favorable exception: `skills/issue-authoring/` already
conforms to APM's skill-frontmatter contract, already uses the
`references/` convention, carries no placeholders, and its drift
arithmetic is net-neutral — APM's skill-bundle deployment would
plausibly **replace**, not add to, the existing
`skills/issue-authoring` → `.claude/skills/issue-authoring`
`mode: "exact"` sync pair. That exception is recorded as a named
revisit condition, not an adoption; APM's pre-1.0 release cadence (10
tagged releases in roughly 6.5 weeks as of this analysis) is an
independent, ongoing maintenance-risk factor even for that narrow case.

Conditions that would revisit this: APM reaching a stable schema; APM's
`instructions` primitive gaining a workflow-step-scoped activation mode;
explicit adopter demand with a concrete use case the raw-URL path does
not already serve; or a bounded pilot of `skills/issue-authoring/`
alone. A project that reaches this same conclusion independently should
record it here rather than re-running the investigation.

## Documentation conventions

### Cite the observed incident

kurone-kito/idd-skill#1596 adopted this convention after observing that
`mew-ton/soloscrum` cites a concrete incident for each entry in its
anti-pattern lists (for example, "Observed 2026-05-09 on issues 8 and
9" in that project's own tracker — not this repository's). A citation
raises the authority of a documented prohibition for
both humans and weak models — the rule reads as field evidence, not
authorial preference — and lets a later session check whether the
cited incident still motivates the rule.

When documentation or instruction text names an anti-pattern or
failure mode, cite the concrete incident that motivated it: a date
plus an issue or PR reference, when one exists. When no such incident
exists — the rule is preventive rather than a response to something
that already happened — say so explicitly, using the phrase
"preventive; no observed incident yet", so the absence of a citation
reads as a deliberate statement rather than an omission.

The convention applies **forward**, to new or edited passages only.
Retrofitting an existing passage with a citation is in scope on
budget-exempt `docs/` surfaces, but out of scope for
`.github/instructions/` files: do not edit an instruction file solely
to add a citation. That exemption is not retrofit-only — a brand-new
`.github/instructions/` passage that names an anti-pattern or failure
mode is exempt from the citation requirement too, for the same
reason: those bundle budgets already sit near their ceiling (see the
headroom review in kurone-kito/idd-skill#1525; scope clarified by
kurone-kito/idd-skill#1647 after CodeRabbit read the original wording
as covering only retrofits).

When an instruction passage's motivating incident is worth recording
in full, put the date-plus-reference in a paired
`docs/idd-design-rationale.md` entry and link to it by section anchor,
as most cited passages already do. A bare issue-number aside directly
in the instruction text remains acceptable in place of that link when
no paired entry exists — both forms fit inside the tight
instruction-bundle budget that motivates the exemption; neither is
required.

### Trace a documented output field to its print/return call site, not a type or variable name

While drafting kurone-kito/idd-skill#2474's documentation of
field-name variance across that repository's evidence-collector helper
scripts, an initial pass made several confident, specific claims about
which top-level JSON keys a given helper actually returns. A
fact-checking pass found that roughly half of those claims were wrong
— not because the underlying behavior was misunderstood, but because a
TypeScript **type name** or an internal **local variable name** had
been mistaken for an actual printed/returned field. For example,
`advisory-convergence.mts`'s printed object was described as returning
a `verdict` field: `verdict` is only the local variable name holding
the whole printed document (the `AdvisoryConvergenceVerdict` type),
never a key nested inside it. `discover-viability-gate.mts` was
described as returning a `passed` field: `passed` exists only on an
internal per-issue helper result and is never copied into the printed
top-level object. A second, independent verification pass, re-tracing
every claim to the file's actual `JSON.stringify(...)` /
`process.stdout.write(...)` call site rather than to the nearest
plausible-looking name, caught and corrected every instance before the
documentation merged (observed 2026-09-03,
kurone-kito/idd-skill#2474).

When documenting what a script or function actually returns or
prints, trace every claimed field name to its literal
`JSON.stringify(...)` / `process.stdout.write(...)` / `return` call
site in the current source — never infer it from a type name, an
interface field, or a local variable name that merely looks like it
could be the same thing.

### Require a profile-selected pointer before helper commands

Observed 2026-09-12 and 2026-10-05 on kurone-kito/setup.ubuntu: pull
request #162 patched two instruction files (the appendix and
suitability) and three docs to add profile-selected forms, but the
v0.14.0 re-import (#201) erased those patches (at the base commit the
appendix had 3 and suitability 2 occurrences of `profile-selected`, at
the import commit 0). Seven review threads then reported bare commands:
the appendix provider-outage block (two threads, one per bot), the
suitability close-execute block, three lite files (merge-handoff, resume,
resume-stall), and one thread on the F4 and stall-recovery commands
(`idd-merge`, `idd-resume-stall`). An adopter on `ephemeral-npx` had to
fix this by hand twice (#154 tracked and fixed as #162, and #201).

The `unpointed-source-form` audit rule requires any non-exempt bare
`node scripts/<name>.mjs` invocation in instruction files to be
preceded (in the same file, or within the same blank-line-delimited
paragraph or fenced block) by the `profile-selected` token (matched
case-insensitively). In addition, a dedicated regression test
verifies that each of the ten instruction files pairs its
`profile-selected` pointer with a reference to
`docs/idd-helper-scripts.md` in the same paragraph or list item.

The check is scoped per file rather than per command because instruction
files establish the helper resolution contract once near the top or
before the first helper command; requiring the pointer on every command
or block would add repetitive boilerplate across dozens of blocks
without increasing clarity.

Two deliberate non-goals:

1. A strict per-paragraph rule (every block with a bare use must
   contain `profile-selected`, counting fenced blocks as separate
   blocks): this would catch more but failed 36 blocks in 18 template
   files, creating excessive verbosity.
2. Requiring `docs/idd-helper-scripts.md` on the exact same line as
   `profile-selected`: this would fail 14 more template files where the
   path is named within the same paragraph or surrounding list item.
