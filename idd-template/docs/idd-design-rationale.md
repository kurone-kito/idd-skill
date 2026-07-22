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
  (a), (b), or (c)), any later A4 Step 1 / Step 1.5 exhaustion —
  reachable only after trigger (b) — reports and stops (not an abort)
  without re-entering A0-O. A **trigger (a)** or **trigger (c)** A0-O
  run that finds no orphan routes to the A3 decision tree (both paths
  genuinely empty); a **trigger (b)** one reports and stops instead,
  because roadmap candidates reached A4 — an exhaustion the A3 tree's
  A2/A3-empty cases do not describe. This prevents an
  A1 ↔ A0-O or A4 ↔ A0-O loop.

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
found none, the three triggers are mutually exclusive within one
Discover pass — so "at most once per pass" holds automatically across
all three, not only within the (a)/(b) pair.

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
`hash(session-token) mod band-size`, the token being the selection-time
`{agent-id}`) instead of always index 0, spreading concurrent sessions
across _different_ eligible issues up front.

It is off by default and reorders **only within** a same-score tie band so
the documented score-then-lowest-number ranking is the unchanged single-
session and fallback behavior. The load-bearing invariant is that the
branch name (`issue/<n>-<slug>`) derives from the issue, not selection
order, so spreading sessions across different issues never breaks the
same-issue branch convergence that A5(e) and the `branch-name` helper rely
on. The desync never crosses score bands and never bypasses the A4.5/A5
gates; the in-band offset function is replaceable without affecting these
invariants.

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
  authorization then rests on `isAuthorizedForcedHandoff` alone.

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
(`resume-claim-routing.mts`) also accepts `--claim-id`/`--nonce` and is
unit-tested, anticipating Resume Step 1 wiring — but the documented Resume
Step 1 invocation (`idd-resume.instructions.md`) never threads either flag
through, and a resumed process has no local memory of which nonce was its
own to compare against in the first place. That cold-recovery design
(kurone-kito/idd-skill#1529) is a natural fast-follow (the same shared
parse/render primitives already support it) — not a silent design gap.
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

## Advisory wait

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
`.github/instructions/` files — do not edit an instruction file
solely to add a citation; those bundle budgets already sit near their
ceiling (see the headroom review in kurone-kito/idd-skill#1525).
