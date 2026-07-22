# Investigation: Harness-Orchestrated Execution Mode for Weak Local Models

This document records the findings and recommendation for
[#1555](https://github.com/kurone-kito/idd-skill/issues/1555), an orphan
investigation issue surfaced by an independent field proof-of-concept. It is
a planning note, not an instruction surface: no
`.github/instructions/*.instructions.md` file, `idd-template/` source, or
runtime behavior changes as a result of this document. This is an
investigation deliverable, not an implementation — matching the shape
[#1416](https://github.com/kurone-kito/idd-skill/issues/1416) and
[#1419](https://github.com/kurone-kito/idd-skill/issues/1419) already used
for comparable design questions.

**Question**: should the repository define — not yet implement — a
**harness-orchestrated execution mode**: a deterministic external runner
that sequences this repository's existing fail-closed helpers and calls the
model only for atomic generation or repair, never for reading phase
instructions or deciding loop transitions?

## Evidence base and its limits

Two distinct sources motivate this investigation, and they carry different
weight:

- **The field proof-of-concept** (Foundry Local + OpenCode,
  Windows/16 GB/CPU-only inference; qwen3.5 `{0.8b, 2b, 2b-text, 4b}`,
  cross-runtime control `codex exec -m gpt-5.4-mini`; see the issue body for
  the source gist). This is a single, independently-run PoC — not this
  repository's own dogfooding data — reporting that qwen3.5 0.8b/2b/2b-text
  collapsed into a repetition spiral ("But wait, the prompt says... let me
  re-read...") in a self-directed agent loop, reproduced at temperature 0
  **and** 0.3, across two 2b variants, **0/3 tasks**, while the same models
  driven by an external harness that owns plan/sequence/verify/fix-loop
  completed the identical task in 1 attempt. Treat this as evidence that
  the failure mode exists and that a harness-owned alternative shape can
  work for at least one small model family and one small task, not as a
  controlled, repeated, or this-repository-run experiment.
- **This repository's own institutional grounding**, which predates and is
  independent of the PoC's own rigor:
  [Model capability expectations](idd-workflow.md#model-capability-expectations)
  already names a **"large-context, non-self-directing"** class — "models
  that clear the context-sufficiency bar but cannot reliably self-direct a
  multi-turn execution loop" — and states directly: "Prefer a
  harness-orchestrated execution mode for this class (the model stays a
  step-level worker; the harness owns phase routing, tool selection, and
  acceptance gates). That path is an open investigation rather than a
  shipped workflow profile — track #1555." The repository had already
  reserved this exact niche and pointed at this issue before the PoC
  existed; this document completes already-declared scope rather than
  inventing new scope from the PoC alone.

The PoC's third contribution — comparing a hand-rolled reimplementation of
downstream execution logic to this repository's actual helpers — **is**
independently reproducible against this repository's own source, and was
re-verified below rather than taken on faith.

## Re-verified drift evidence (primary source, this repository)

The PoC reports that a small external runner drove `bin/idd-branch-name.mjs`
and `bin/idd-emit-marker.mjs` for deterministic steps, and separately drove
`bin/idd-discover-readiness-check.mjs` / `bin/idd-claim-approval-gate.mjs`
against live issues, then compared an earlier hand-rolled version of the
same logic to these canonical helpers. It reports four concrete drifts. All
four were re-confirmed directly against this repository's current source
during this investigation, not merely re-stated from the issue body:

1. **Millisecond- vs second-precision timestamps.** `renderClaimedByMarker`
   in `src/scripts/marker-helpers.mts` calls
   `normalizeSecondPrecisionIsoTimestamp`, which enforces the exact regex
   `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/` (`src/scripts/marker-helpers.mts:1006`)
   — a literal `Z` immediately after the seconds field, with no room for a
   `.mmm` fractional-second suffix. When the timestamp fails that check,
   `renderClaimedByMarker` throws `invalid claimed-by marker payload`
   (`src/scripts/marker-helpers.mts:615`). JavaScript's
   `new Date().toISOString()` — the obvious hand-rolled choice — always
   emits millisecond precision, so a naive reimplementation trips this
   exact throw on every call, not on an edge case.
2. **Branch-slug stop-word handling.** `src/scripts/branch-name.mts`
   defines a fixed `STOP_WORDS` set (`a`, `an`, `the`, `and`, `or`, `in`,
   `for`, `to`, `with`, `from`) that the slug algorithm drops as whole-token
   matches. A reimplementation that keeps `"a"` produces a structurally
   different branch name that a downstream claim-verification step
   comparing against the canonical helper's output would reject. Running
   `node scripts/branch-name.mjs --number 1555 --title "Investigate a
   harness-orchestrated execution mode for weak local models"` during this
   investigation reproduced the canonical slug live:
   `issue/1555-investigate-harness-orchestrated`.
3. **Marker body shape (blank line, not a single newline).**
   `idd-claim.instructions.md`'s "Nothing appended after the note" rule
   requires a `claimed-by` / `unclaimed-by` body to be exactly the HTML
   comment token, then a **blank line**, then the single italic note — no
   more, no less. `renderClaimedByMarker`'s `.join('\n')` call joins three
   array elements (the token, an empty string, the note), which mechanically
   produces that blank line. A hand-rolled version using a single `\n`
   between token and note (as the PoC reports) produces a body
   `detectMalformedOperationalMarker` (`marker-helpers.mts`) can flag as
   structurally malformed rather than a silently-accepted variant — the
   claim parser's whole-body anchor does not recognize it as a live claim
   event.
4. **Marker wording mismatch.** The visible note text is hardcoded exactly:
   `_{agent-id}: issue claim — IDD automation marker. Do not edit._`
   (note the em dash, `—`, not a hyphen). Any deviation — different
   punctuation, different wording, a missing italic wrapper — is a
   different body than the canonical parser was built against.

These four are not stylistic nitpicks: each one is a concrete point where a
plausible, well-intentioned reimplementation silently diverges from this
repository's own fail-closed contract, for exactly the weak-model tier this
mode targets — the tier this repository's own guardrails already say should
prefer a deterministic helper over prose judgment wherever one exists (see
[Weak-model guardrails](idd-workflow.md#weak-model-guardrails)).

## 1. The contract

The following table names, for a full single-issue pass from claim through
PR-submit through review-fix through pre-merge/handoff, which existing
helper the harness calls at each mechanical step and what each step's
stop-and-ask condition is. Two boundaries hold uniformly across the whole
table and are stated once instead of per row: (a) per the repository-wide
[fail-closed default](../.github/instructions/idd-overview-core.instructions.md#fail-closed-default),
a helper that is **missing, exits non-zero, or returns invalid/malformed
JSON** is always a stop-and-ask condition for the harness — never a silent
fallback to the harness re-deriving the helper's logic itself (that
fallback is precisely the reimplementation risk documented above); and (b)
every write-side helper call (`post-idd-marker --apply`,
`audit-pr-cleanup --apply`) must pass the claim revalidation gate
immediately before the call, exactly as the written instructions already
require of a human-or-model-driven session.

<!-- dprint-ignore-start -->
| Phase | Step | Helper called | Stop-and-ask condition (beyond the uniform missing/invalid rule above) |
| --- | --- | --- | --- |
| A5(a) | Issue-author approval | `claim-approval-gate` | `approved: false`, or helper output disagrees with a live re-check |
| A5(c) | Fresh-claim gate | `resume-claim-routing --fresh-claim-gate` | verdict is `already-claimed` (issue held by a live competitor) |
| A5(e) | Branch-name / collision check | `branch-name`, then the written scoped branch-pattern scan (no helper) | a matching branch is found that is **not** inheritable per the written A5(e) collision-action tree |
| A5 | Post claim + activation nonce | `post-idd-marker --type claim`, `post-idd-marker --type activation-nonce` | claim verification (same-second tie-break, nonce winner check) fails — claim contested |
| B1 | Worktree creation, install-deps | ordinary `git worktree add` / WorkTrunk (not IDD-specific), plus `verify-install-deps` (an IDD helper, documented in `docs/idd-helper-scripts.md`, though not one of the nine the issue names) | orphaned path found, or install fails after its one retry |
| B1 | Worktree-local lock | `claim-lock --acquire` | lock reports a collision with a different `{claim-id}` |
| B2-B3 / C1-C6 | Plan + implement + self-review | **no deterministic helper** — the harness's one true model call per unit, scoped to atomic generation/repair only, plus deterministic **fix-validate** / **post-fix-validate** commands | acceptance check (see [Weak-model guardrails](idd-workflow.md#weak-model-guardrails)'s acceptance-check rigor bullet) fails after its bounded retry |
| D1-D2 | Sync main, revalidate claim, lint/test, push | `fix-validate` / `pre-push-validate` (deterministic commands, not IDD-specific helpers) | validate command fails after **fix-validate** auto-fix; conflict on rebase |
| D3 | Create PR | `gh pr create` (ordinary tooling) + the written closing-keyword rule | closing-keyword verification (D3.5) fails |
| D4 | Wait for CI | `ci-wait-policy` (policy resolution), `ci-wait-state` (live snapshot) | a required check fails and the resolved policy's rerun budget is exhausted |
| E1 | Snapshot + watermark | `review-activity-snapshot`, then `post-idd-marker --type watermark` (or the one-shot `--from-pr` path) | snapshot HEAD does not match the expected HEAD; watermark post fails |
| E2 | Critique pass | **no deterministic helper** — an always-run, harness-scheduled model call (deterministic *that* it runs, not deterministic *what* it finds) | none beyond the uniform rule; a critique failure feeds E4-E8 like any other finding |
| E3 | Empty-list check | routing only, no helper | n/a — routes to merge or to E4 |
| E4-E8 | Review triage: classify, score, Accept/Reject | **no deterministic helper — judgment-heavy, out of scope for this mode** (see Recommendation) | the harness cannot pass this gate; it must hand off |
| E9, E13 | Fix accepted items, reply | same atomic-generation model call as B3; `post-idd-marker` for replies | same acceptance-check condition as B3 |
| E14 | Advisory-wait / re-review request | `advisory-wait-state`, the `idd-advisory-wait.instructions.md` decision table | advisory-wait state does not resolve within the documented decision table's terms |
| E15 | CI re-wait | `ci-wait-policy` / `ci-wait-state` (same as D4) | same as D4 |
| F1 | Final branch-state check | live branch-state read (no dedicated helper) | branch diverged from the expected HEAD |
| F2 | Pre-merge condition check (mechanical evidence read) | `pre-merge-readiness`, `advisory-wait-state` | helper evidence is missing/invalid/disagrees with live state **and** the harness cannot itself perform the written prose fallback — see Recommendation |
| F2 | Pre-merge condition check (prose fallback) | **no deterministic helper — judgment-heavy, out of scope for this mode** | the harness cannot pass this gate; it must hand off |
| F2.5 | Merge-policy handoff | routing only; under `human_merge` / `separate_merge_agent`, post a handoff comment and stop | n/a — stopping cleanly **is** the in-scope outcome for this mode (see Recommendation) |
<!-- dprint-ignore-end -->

F3-onward (autonomous merge execution) is not in this table: the existing
weak-tier guardrail already says "do not run the autonomous merge phases
(F3 onward) on this tier" (see
[Weak-model guardrails](idd-workflow.md#weak-model-guardrails)), and this
mode's target class is a strict subset of that same tier boundary, so the
exclusion carries over unchanged.

The **E4-E8** and **F2 prose-fallback** rows are not an oversight; they are
the same judgment-heavy boundary
[`docs/weak-model-lite-profile-design.md`](weak-model-lite-profile-design.md)
already drew for the lite instruction-content profile (its
[Phase scoping](weak-model-lite-profile-design.md#phase-scoping) table
marks `idd-review-triage.instructions.md` "Excluded (judgment-heavy)" and
`idd-pre-merge.instructions.md`'s prose fallback "stays excluded"), reused
here rather than re-derived: no mechanical, deterministic-output helper
exists for either gate today, in either mode, and none of the drift
evidence above changes that — reusing a canonical helper only helps for
steps that already have one.

## 2. Reuse, not reimplementation

The contract above mandates **calling** this repository's canonical helpers
rather than re-deriving their behavior, for the reason the four re-verified
drifts above demonstrate directly: a plausible, careful reimplementation of
timestamp formatting, slug normalization, and marker body shape each
independently diverged from the canonical parser's actual contract, for
exactly the failure modes this repository's fail-closed marker/claim
protocol exists to catch. This is not a hypothetical risk invented for this
document — it is the PoC's own reported experience, re-confirmed against
current source above. A harness that re-derives helper behavior from the
written instruction prose (rather than shelling out to the helper binary
itself) reintroduces the same class of risk the standard model-driven loop
already accepts implicitly today, except a harness has no "model judgment"
fallback if it silently drifts — a wrong marker body just gets rejected by
`detectMalformedOperationalMarker` or, worse, is malformed in a way that
happens not to trip detection, which is a materially worse failure than a
model occasionally misreading a rule it could in principle re-read.

## 3. Boundaries — pure/offline vs. live GitHub state

<!-- dprint-ignore-start -->
| Helper | Live state required? | Notes |
| --- | --- | --- |
| `branch-name` | **No** — pure/offline | own `--help` text states "Deterministic and network-free" |
| `emit-marker` | **No** — pure/offline | "Emit-only: performs no network write"; renders body text only, does not post |
| `ci-wait-policy` | **No** — pure/offline (policy-resolution mode) | reads only `.github/idd/config.json`; contrast with `ci-wait-state` below, which needs a live PR |
| `post-idd-marker` (plain dry-run: no `--apply`, no `--from-pr`) | **No** — pure/offline | per `src/scripts/post-idd-marker.mts`, the plain dry-run path exits after rendering — it never reaches the `gh repo view` owner/repo resolution at all, regardless of whether `--owner`/`--repo` are passed; prints a JSON envelope whose `body` field holds the rendered marker (not the raw body text directly) — a harness must parse that field |
| `post-idd-marker --from-pr` (watermark derivation, even without `--apply`) | **Yes** | resolves owner/repo via `gh repo view` and runs a live `review-activity-snapshot` child to derive the watermark fields — this is the one dry-run-eligible invocation that is not offline |
| `post-idd-marker` (`--apply`) | **Yes** — writes | resolves owner/repo via `gh repo view` (unless `--owner`/`--repo` are passed) and POSTs to the issue/PR comments API; requires live claim-revalidation immediately before the call |
| `claim-approval-gate` | **Yes** | reads live issue state and timeline events |
| `resume-claim-routing --fresh-claim-gate` | **Yes** | reads live issue comment stream |
| `discover-readiness-check` | **Yes** | reads live issue state (one or many, or a repo-wide sweep under `--swarm-floor`) |
| `ci-wait-state` | **Yes** | "Single-shot, read-only D-phase CI snapshot" against a live PR |
| `review-activity-snapshot` | **Yes** | reads live PR review/comment state |
| `pre-merge-readiness` | **Yes** | reads live PR **and** claim-issue state together |
| `advisory-wait-state` | **Yes** | reads live PR state |
| `audit-pr-cleanup` | **Yes**, and can write under `--apply` | dry-run by default; `--apply` minimizes candidate comments and requires claim evidence |
| `claim-lock` | **No** (same-machine only) | local filesystem lock, not a GitHub call — the same-machine complement to the live claim checks, not a substitute |
<!-- dprint-ignore-end -->

The implication: a harness can rehearse its own control flow, marker
rendering, and branch-naming **fully offline** with `branch-name`,
`emit-marker`, `ci-wait-policy`, and a **plain** `post-idd-marker` dry-run
(no `--from-pr`) — enough to smoke-test that the runner constructs
correct marker bodies and branch names before ever touching a
credential — but there is no fully offline dry run of an actual
single-issue pass. Every gate that decides whether to proceed (claim state,
CI state, review state, merge readiness) requires a live, credentialed,
network-connected loop, and `post-idd-marker --from-pr` steps outside that
offline boundary the moment it needs a live snapshot to derive watermark
fields, even before `--apply` is added. This matters for **when this mode
can run unattended**: the pure subset is safe to exercise in a sandboxed
or CI-internal smoke test with no GitHub token at all; the live subset
can only ever run inside an already-integrated loop with real
repository access, which is also where the weak-tier guardrail already
puts the model-driven loop today — this mode does not relax that
requirement, it only changes who is deciding when to call each live
helper.

## 4. When to require this mode

This investigation deliberately does not invent a new capability-floor
mechanism. Two pieces of guidance already recorded in this repository
answer the practical question directly, and this document points at them
rather than duplicating or re-deriving them:

- **Class membership**: [Model capability expectations](idd-workflow.md#model-capability-expectations)
  already names the target class — "large-context, non-self-directing" —
  as models that clear the context-sufficiency bar but cannot reliably
  self-direct a multi-turn execution loop. This is not the same population
  as the supported "lightweight local or compact cloud" tier, which by
  definition **has** demonstrated self-direction for contained tasks; a
  model in the lightweight tier should keep using the standard loop with
  weak-model guardrails, not this mode.
- **The practical test for membership**:
  [Model selection and prompting for the weak tier](idd-workflow.md#model-selection-and-prompting-for-the-weak-tier)'s
  loop-stability-versus-single-shot-mismatch bullet already recommends "a
  cheap smoke test: can the model run N turns on a simple task without
  spiraling? Gate model selection for loop execution on that result, not
  the single-shot score." This is exactly an operational floor test for
  this mode's target class, already documented for a related purpose
  (model **selection**) before this investigation existed. This document
  reuses it as the practical gate rather than inventing a parallel one: a
  model that fails the smoke test is a harness-orchestration candidate; a
  model that passes it belongs on the standard loop.
- **Why this mode's premise already has support in the guardrails**:
  [Weak-model guardrails](idd-workflow.md#weak-model-guardrails)' own
  "Full-agent-wrapper degradation" bullet already states the same
  underlying principle this mode's contract enforces structurally: "prefer
  a direct, minimal-prompt generation path — feeding only the atomic task
  and its acceptance context — over routing the same request through a
  full agent session with its system prompt and instruction stack... the
  same model that succeeds on a direct minimal prompt can fail through the
  full agent wrapper." Harness orchestration is that principle taken to
  its structural conclusion: the model is never handed the full
  instruction stack or asked to plan a transition, only ever a single
  atomic task.

What remains genuinely open, and is intentionally **not** answered here: a
**formal, enumerated, benchmark-backed** capability floor (specific token
counts, specific pass rates, a specific smoke-test protocol with a pass/fail
threshold) does not exist yet, and this document does not invent one — per
the issue's own framing, that floor definition may need its own follow-up
issue (see Decomposition proposal below) rather than being settled as a
side effect of this investigation.

This mode is **not** a universal replacement for the standard model-driven
loop with weak-model guardrails. For any model that clears both capability
axes — including the supported lightweight tier — the standard loop with
its existing guardrails remains preferred: harness orchestration adds real
coordination overhead (an external runner, credential and token plumbing
outside the agent's own session, a judgment-gate handoff path) that only
pays for itself when self-direction is the actual, demonstrated blocker.

## 5. Relationship to existing Helper Runtime Profiles

The four [Helper Runtime Profiles](idd-helper-scripts.md#helper-runtime-profiles)
(`package-manager`, `vendored-node`, `ephemeral-npx`, `instructions-only`)
all answer one question: **how is a helper command resolved and made
runnable** in an importing repository (an existing package manager, a
vendored bundle, one-shot `npx`, or no helper runtime at all). None of the
four says anything about **who decides when to invoke a helper** — today
that decision is always the model, reading the phase instructions and
choosing to run the documented command for the current step.
Harness-orchestrated execution changes exactly that second, currently
unaddressed axis: the harness, not the model, decides when each helper in
the Section 1 contract runs.

This makes harness-orchestrated execution an **orthogonal concept layered
on top of** one of the profiles, not a fifth profile alongside them, and
not a replacement value for the existing `profile` field. A repository
still separately chooses how helpers are resolved (one of the four rows in
the table); harness orchestration is a second, independent decision about
who drives invocation, applicable in principle regardless of which profile
resolves the helper commands.

There is one **structural** exception, not merely a preference:
`instructions-only` has, by its own definition, "no helper runtime — agents
follow the Markdown instructions directly." A harness attempting to
orchestrate under `instructions-only` would have no callable helper surface
to sequence at all — it would have to reimplement every step's logic
itself, which is precisely the reimplementation risk Section 2 documents.
Harness-orchestrated execution is therefore only a coherent mode on top of
`package-manager`, `vendored-node`, or `ephemeral-npx`; a repository on
`instructions-only` would need to adopt one of the other three profiles
first before this mode could apply.

## Distinctions from adjacent work

Three existing tracks address related but distinct problems; this
investigation does not re-litigate or duplicate any of them:

- **Not [#1349](https://github.com/kurone-kito/idd-skill/issues/1349)'s
  authoring hardening.** #1349's principle — moving high-consequence checks
  off model judgment onto deterministic verifiers — has been applied to
  **issue authoring**. It has not yet been applied to the **execution
  loop's own control flow**: today's B-through-F phases still assume the
  model itself reads phase instructions and decides when a helper applies.
  This investigation is that same principle applied to the execution loop,
  not a restatement of #1349's already-shipped authoring-side work.
- **Not the lite instruction-content profile**
  ([#1419](https://github.com/kurone-kito/idd-skill/issues/1419) /
  [`docs/weak-model-lite-profile-design.md`](weak-model-lite-profile-design.md),
  tracked toward shipping via
  [#1539](https://github.com/kurone-kito/idd-skill/issues/1539)). That
  track still assumes the model **reads and self-directs** from
  instructions — just shorter, more self-contained, lower-cross-reference
  ones, per its five content principles. This mode asks a categorically
  different question: below the capability floor named in Section 4,
  should the model read phase instructions or plan loop transitions
  **at all**? The lite profile's own design explicitly names this
  boundary and defers to this issue for it (see its
  [Target model class and non-goals](weak-model-lite-profile-design.md#target-model-class-and-non-goals)
  section: "The named large-context, non-self-directing class is
  intentionally out of scope here; that class points at a
  harness-orchestrated execution-mode investigation... See #1555").
- **Not [#1389](https://github.com/kurone-kito/idd-skill/issues/1389)'s
  orchestrator fan-out.** The
  [Orchestrator fan-out variant](idd-workflow.md#orchestrator-fan-out-variant)
  is itself an **agent** — a long-lived orchestrating session that runs
  Discover/Claim itself and delegates B-through-F execution to isolated
  subagent workers, each of which is a full model session reading the
  standard phase instructions. Every level of that variant is
  model-driven. What this document investigates is a **non-model,
  deterministic runner**: the harness itself is not an agent making
  judgment calls about phase routing; the model is invoked only for the
  single atomic generation/repair call named in the Section 1 contract.

## Recommendation: Go — scoped

Defining a harness-orchestrated execution mode is **recommended**, scoped
exactly to the mechanical rows of the Section 1 contract table: claim
(A5), worktree/install setup (B1), the atomic generation/repair call
itself (B2-C6, E9), PR-submit (D1-D4), review snapshot and the mechanical
E9/E13/E14/E15 fix-and-re-review chain, and the F2 mechanical
helper-evidence read through the F2.5 handoff-stop. This recommendation
does **not** extend to full, unsupervised single-issue autonomy: **E4-E8
review-triage classification and F2's prose fallback have no deterministic
helper today, in this mode or the lite profile**, so a harness-orchestrated
session must escalate to a stronger model or a human at those exact gates
rather than attempting to fake judgment through the harness. This is the
same in-scope/judgment-heavy boundary `docs/weak-model-lite-profile-design.md`
already drew for the lite profile, reused rather than re-derived (see
Section 1). F3-onward autonomous merge remains out of scope for this tier
entirely, matching the existing weak-tier guardrail.

Reasoning:

1. **The field evidence names a specific, severe failure mode with a
   demonstrated working alternative shape** — 0/3 self-directed tasks
   collapsing into a repetition spiral versus 1-attempt success under
   harness orchestration, on the same models. This is a single PoC, not a
   controlled repeated experiment (see Evidence base and its limits), but
   it is concrete, mechanism-level evidence (a named, reproduced failure
   pattern), not an anecdote.
2. **This repository's own taxonomy had already reserved this exact
   niche and pointed at this issue** before the PoC existed
   ([Model capability expectations](idd-workflow.md#model-capability-expectations)).
   This document completes already-declared repository intent rather than
   introducing new scope from an external source alone.
3. **The reimplementation risk is concrete and independently
   re-verified**, not hypothetical (Section 2 and the four re-verified
   drifts above), which is exactly the kind of evidence that justifies a
   contract mandating helper calls over prose re-derivation for this
   specific tier.
4. **Sufficient mechanical helper coverage already exists** for most of
   the contract's steps (Section 1) — the gap is not "no helpers exist,"
   it is that the judgment-heavy phases have never had a deterministic
   path, in this mode or in the lite profile, which the scoped
   recommendation above accounts for honestly instead of hand-waving past
   it.
5. **Existing weak-tier guardrails already point at this shape.** The
   "Full-agent-wrapper degradation" guardrail (Section 4) already
   recommends the same minimal-prompt, atomic-task principle this mode's
   contract enforces structurally; formalizing this mode completes
   already-recorded guidance rather than introducing a new philosophy.

**Conditions that would change this recommendation:**

- This repository's own dogfooding never observes the self-directed
  spiral failure mode in a genuine attempt with a comparably weak model,
  suggesting the PoC's failure mode does not generalize as broadly as
  the field evidence suggests.
- The E4-E8 / F2 judgment-gate uncoverage turns out to block enough of a
  real single-issue pass that a harness saves too little wall-clock or
  reliability over the standard weak-tier guardrails alone to justify the
  added coordination overhead (Section 4).
- No adopter ever actually runs a genuinely non-self-directing model
  against this workflow, making the whole investigation moot in practice
  regardless of its technical merit.

## Decomposition proposal

The following follow-up issues are proposed scope for a later authoring
pass. Titles and one-line scopes only — filing them, and deciding whether
to ship any supporting tooling, is out of scope for this investigation (see
Non-goals).

- **Promote the Section 1 contract into a standalone, versioned reference
  doc** — extract and maintain the step-to-helper contract table
  separately from this point-in-time investigation, kept in sync with
  helper CLI changes as they land (this document's own table is a
  snapshot, not a maintained contract surface).
- **Define a formal capability-floor test for the "large-context,
  non-self-directing" class** — operationalize the existing smoke-test
  heuristic (Section 4) into a repeatable, documented procedure (not a
  benchmark suite), building on [Model selection and prompting for the weak tier](idd-workflow.md#model-selection-and-prompting-for-the-weak-tier).
- **Spike a minimal harness-orchestrated runner against one real,
  low-risk issue**, under close operator supervision, to produce this
  repository's own first-party dogfooding evidence distinct from the
  external PoC — a throwaway prototype to gather evidence, not a shipped
  package; decide packaging/shipping only after this spike, consistent
  with this investigation's non-goal below.
- **Investigate a judgment-gate escalation contract for E4-E8 / F2's
  prose fallback under harness orchestration** — define concretely how a
  harness hands off to a stronger model or a human reviewer at exactly
  those two gates, rather than leaving the boundary unspecified beyond
  "the harness cannot pass this gate."
- **Update the Model capability expectations cross-reference** once the
  contract and floor-test issues above land — replace the current "open
  investigation... track #1555" phrasing in
  [`docs/idd-workflow.md`](idd-workflow.md#model-capability-expectations)
  with a pointer to the shipped contract doc. Deliberately not done in
  this PR (see Non-goals) to keep this investigation's diff scoped to a
  single new document.

## Non-goals

This investigation does not:

- ship a reference harness-orchestrator implementation, helper script, or
  package (explicit non-goal stated in the issue)
- change any instruction file, template file, or runtime behavior
- change the four-profile enumeration in
  [Helper Runtime Profiles](idd-helper-scripts.md#helper-runtime-profiles)
- define a formal, benchmark-backed capability floor (see Section 4)
- update `docs/idd-workflow.md`'s existing "#1555" cross-reference — that
  update is proposed as a follow-up once the contract and floor-test
  issues land, to keep this investigation's own diff to one new document
- re-litigate #1416's or #1419's own recorded verdicts, or #1389's
  orchestrator-fan-out design

## Revisit conditions

Re-evaluate this note when any of: this repository's own dogfooding
produces first-party evidence for or against the self-directed spiral
failure mode; a spike (see Decomposition proposal) produces concrete
wall-clock or reliability data comparing harness orchestration to the
standard weak-tier guardrails; or an adopter explicitly requests this mode
with a concrete model and workload the standard loop does not already
serve. Capture new evidence as issues referencing this document.
