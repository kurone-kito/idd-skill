# Weak-Model Lite Instruction Profile — Design

This page records the design for
[#1419](https://github.com/kurone-kito/idd-skill/issues/1419), the final
child of the OpenCode support roadmap
([#1413](https://github.com/kurone-kito/idd-skill/issues/1413)). It is a
**design-only** planning note: no instruction file, template file, or
`idd-template/` mirror changes as a result of this document. It ends
with a decomposition proposal (see below) for a later authoring pass;
filing those follow-up issues is explicitly out of scope here.

**Motivation** (from the roadmap): the distributed phase instructions
assume a model that can hold long, cross-referenced rule sets and
exercise judgment across them. Field reality for OpenCode adopters
increasingly includes small local models with ample context but weak
adherence — they drop constraints stated far from the point of action,
mishandle cross-file references, and fail judgment-based gates. This is
an **attention/adherence problem, not a raw context-fit problem**: see
[Target model class and non-goals](#target-model-class-and-non-goals)
below for the evidence.

## Target model class and non-goals

This design reuses the model-capability taxonomy published by
[#1415](https://github.com/kurone-kito/idd-skill/issues/1415) in
[Model capability expectations](idd-workflow.md#model-capability-expectations)
verbatim, rather than inventing a parallel one:

- **Target tier**: **lightweight local or compact cloud** — large-context,
  low-reasoning models such as the phi-4-mini class (roughly 128K
  context, tool calling supported, but weak adherence to long
  multi-file instruction sets). #1415 already confines this tier to
  narrowly-scoped roles under operator supervision:
  - executing a single, fully-specified `idd:ready` issue rather than
    Discover's open-ended candidate selection;
  - preferring a deterministic helper command over prose judgment
    wherever one exists for the current step;
  - drafting output for human review rather than running the
    autonomous merge phases.

  This design's job is to give that already-confined role a condensed
  **instruction shape** to execute against. [Phase scoping](#phase-scoping)
  below derives the in-scope/excluded phase list directly from these
  three bullets.

- **Non-goal: no ~32K byte squeeze.** The roadmap's operator decision
  explicitly puts the qwen2.5-coder-1.5b class (roughly 32K context) out
  of scope — "the practical cutoff example" for **unsupported**, per
  #1415. A lite profile is not an exercise in fitting the whole loop
  into a tiny window; the target tier already has ample context.
- **Non-goal: no semantic changes to the standard profile.** A lite
  profile changes instruction **shape** only — how the same rules are
  packaged and phrased — never the underlying claim, gate, or merge
  semantics. Anywhere a lite file and its standard counterpart would
  disagree on behavior is a defect in the lite file, not an
  intentionally relaxed rule.

**Why shape, not fit, is the problem.** `audit/sync-manifest.json`'s
`bundleBudgets` already cap every phase-file bundle well inside a
128K-token window — for example `bundle-work` (B1-C6, the primary
single-issue execution path) is capped at 41,300 bytes, and even the
largest, `bundle-review`, is capped at 129,400 bytes (roughly a quarter
of a 128K-token window at a typical ~4-bytes-per-token ratio; read live
values with `jq '.bundleBudgets' audit/sync-manifest.json` rather than
trusting this snapshot to stay current). These bundles fit comfortably
today. Yet the roadmap's field motivation is that phi-4-mini-class
models still drop constraints and mishandle cross-file references at
that size — the failure mode is **attention and adherence** across a
long, cross-referenced document, not the document failing to fit in the
window at all. A lite profile therefore has to change how instructions
are **written** (self-contained, imperative, low cross-reference), not
just make them shorter.

## Content principles

A lite phase file should differ from its standard counterpart along
these axes:

1. **Per-phase self-contained checklists.** Each lite file restates the
   load-bearing rules it depends on inline, rather than delegating to
   `idd-overview-core.instructions.md` or `idd-overview-appendix.instructions.md`
   by cross-reference. For example, a lite work-phase file inlines the
   claim revalidation gate's cwd-vs-claim check instead of linking to
   `idd-overview-core.instructions.md#claim-revalidation-gate` — the
   standard files' "see X" pattern is exactly the mishandled-cross-file-reference
   failure mode the roadmap names. This trades a small amount of
   duplication across lite files for zero navigation-dependent recall.
2. **Imperative, single-clause steps.** One instruction per sentence,
   active voice, no compound conditionals stacked across a paragraph.
   Where the standard file states a rule and its three exceptions in one
   dense paragraph, the lite equivalent lists the default step, then the
   exceptions as separate short bullets.
3. **No deep cross-references.** A lite file may reference its own
   in-scope siblings (e.g., a lite claim file pointing to a lite work
   file) but should not require following a citation chain more than one
   hop to find a load-bearing rule. Anything cited more than one hop away
   gets inlined per principle 1 instead.
4. **Mechanical helper gates as the primary control surface
   (fail-closed).** This is the strongest lever a lite profile has: where
   [IDD helper script evaluation](idd-helper-scripts.md) lists a
   deterministic helper for a step, the lite file makes that helper the
   default path (not a suggestion) and treats a missing or failing
   expected helper as a stop-and-ask condition — never a silent fallback
   to prose judgment. This mirrors the existing
   [Weak-model guardrails](idd-workflow.md#weak-model-guardrails), which
   already state this preference for the standard profile; the lite
   profile makes it load-bearing by construction rather than advisory.
   A lite profile therefore only makes sense in a repository that has
   actually adopted a helper runtime profile other than
   `instructions-only` (see
   [Helper Runtime Profiles](idd-helper-scripts.md#helper-runtime-profiles));
   on `instructions-only`, the lite profile has no mechanical gates left
   to lean on and the standard profile's written procedure is the only
   option regardless of model tier.
5. **Explicit stop-and-ask conditions.** Every lite file states, near
   the top, the concrete conditions under which the session must stop
   and post a hold comment rather than proceed — not as a scattered
   aside but as a named checklist item, so a weak model does not have to
   infer "should I stop here?" from prose tone.

These principles apply uniformly to whichever files the decomposition
below produces; this design does not rank them, since a later authoring
pass needs all five for any single lite file to be worth shipping.

## Phase scoping

Deriving directly from #1415's three role-confinement bullets (quoted
above), a lite profile covers **single-issue execution** phases and
excludes **open-ended selection** and **autonomous merge** phases. Two
categories need a third label, **judgment-heavy**, because they are
neither open-ended selection nor F3-onward merge execution, yet still
depend on model judgment a weak model is not confined to exercise: E4-E8
review-triage classification and the F2 merge-readiness gate decision.

<!-- dprint-ignore-start -->
| Phase file | Scope | Rationale |
| --- | --- | --- |
| `idd-overview-core.instructions.md` | N/A (always-loaded) | Already always-loaded regardless of tier; no lite variant needed. Content principle 1 has each lite file inline its load-bearing rules instead of citing it. |
| `idd-overview-appendix.instructions.md` | Excluded | Reference/appendix content; a self-contained lite file (principle 3) should not need it at all. |
| `idd-discover.instructions.md` (A0-A4) | Excluded | Open-ended candidate selection — #1415 bullet 1 names this exact exclusion. |
| `idd-suitability.instructions.md` (A4.5) | Excluded | Judgment gate feeding candidate selection; same reasoning as Discover. |
| `idd-claim.instructions.md` (A5) | In scope | Mechanical pre-checks (a)-(e) for a single already-selected issue; already largely helper-first. |
| `idd-resume.instructions.md` / `idd-resume-stall.instructions.md` | In scope, helper-first | Deterministic external-signal classifier (see [Resume routing model](idd-workflow.md#resume-routing-model)) backed by `resume-claim-routing.mjs` / `resume-route-selection.mjs`; fits principle 4. |
| `idd-work.instructions.md` (B1-C6) | In scope | The canonical single-issue execution phase named by the roadmap and #1415 bullet 1. |
| `idd-pr-submit.instructions.md` (D1-D4) | In scope | Mechanical rebase/validate/push/open-PR continuation of the same single issue. |
| `idd-ci.instructions.md` | In scope | Shared mechanical CI-polling helper for D and E; no judgment call of its own. |
| `idd-review-snapshot.instructions.md` (E1-E3) | In scope | Mostly mechanical fetch, freeze, and empty/non-empty routing; the critique-pass invocation is a deterministic "always run one" step, not a judgment call. |
| `idd-review-triage.instructions.md` (E4-E8) | **Excluded (judgment-heavy)** | Classification, severity scoring, and Accept/Reject disposition are exactly the judgment-based gates the roadmap says this tier fails. Stays excluded even though it is not F3-onward. |
| `idd-review-fix.instructions.md` (E9-E15) | Partial — in scope for the whole mechanical E9-E15 execution chain (fix, validate, resolve conflicts, lint/test/push, reply, re-review request, CI wait) | Every step here executes an **already-triaged** Accepted item: E9's fix, E13's reply, and E14's re-review request (a deterministic AW3 decision table, not judgment) all act on a disposition someone else already made. E15 delegates to `idd-ci.instructions.md`, itself in scope below. The triage decisions being executed must still come from an excluded E4-E8 pass authored by a stronger session or a human — a lite E9-E15 file must say this boundary explicitly, not assume it. |
| `idd-pre-merge.instructions.md` (F1-F2) | Partial — F1's read-only branch check and reading the `pre-merge-readiness` helper's `ready`/`blockers` verdict are mechanical (in scope); the written prose fallback stays excluded | Per [F2 merge-readiness evidence checklist](idd-workflow.md#f2-merge-readiness-evidence-checklist), the live `pre-merge-readiness` helper run is already "the authoritative source for the F2/F3 merge decision" — reading its verdict is a mechanical helper-gate read, matching content principle 4. But F2 explicitly allows discarding that helper output and falling back to live-fetch-plus-prose-judgment when it is unavailable, invalid, or disagrees with GitHub state; that fallback is the judgment-heavy part and stays excluded. A lite F2 file should therefore treat a missing/failing/discarded helper as the stop-and-ask condition (principle 5) rather than attempt the prose fallback itself. |
| `idd-merge-handoff.instructions.md` (F2.5) | In scope, for the handoff-stop outcome only | #1415 bullet 3 ("drafting output for human review rather than running the autonomous merge phases") plus the [merge-policy recommendation](https://github.com/kurone-kito/idd-skill/blob/main/idd-template/docs/onboarding/policy-decisions.md#merge-policy) (`human_merge` / `separate_merge_agent` for weak-model repositories) mean a lite session's only job at F2.5 is to stop and hand off cleanly, not to evaluate whether autonomous merge should proceed. This still depends on the mechanical F2 helper evidence above already existing to quote in the handoff comment — the same must-say-the-boundary-explicitly pattern as the E9-E15/E4-E8 dependency. |
| `idd-merge.instructions.md` (F3-F5) | **Excluded** | Autonomous merge phases — #1415 bullet 3's explicit exclusion and the roadmap's own named example. |
| `idd-advisory-wait.instructions.md` | Split by caller | In scope via its E14 caller (in-scope); excluded via F2's prose-fallback caller and the F3 caller (both excluded) — a lite session correctly never reaches those call sites if it stops at F2.5 as designed above. |
| `idd-roadmap-audit.instructions.md` (A1.5) | Excluded | Roadmap-level completion judgment, not single-issue execution. |
<!-- dprint-ignore-end -->

## Delivery options

The issue names two options and asks for a recommendation with recorded
trade-offs for the rejected one.

- **(a) Parallel lite instruction files generated from `idd-template/`
  sources via the existing `sync-docs` machinery** — new files (for
  example `idd-template/.github/instructions/lite/idd-work-lite.instructions.md`)
  mirrored into `.github/instructions/lite/` the same way the current
  dogfood set works, drift-checked by `node scripts/audit-docs.mjs --check`.
- **(b) Skills-based on-demand delivery** — package the in-scope lite
  phases as `SKILL.md` bundles under `.claude/skills/` / `.opencode/skills/`.

### Recommendation: option (a)

[#1416](https://github.com/kurone-kito/idd-skill/issues/1416) already
answered a related but distinct question — whether to deliver the
**existing** phase instructions **as skills**, a delivery-mechanism
question — with a recorded no-go in
[`docs/skills-delivery-investigation.md`](skills-delivery-investigation.md),
reaffirming [`docs/claude-skill-strategy.md`](claude-skill-strategy.md)'s
earlier Claude-Code-only verdict. This design does not re-litigate that
verdict; it applies it to a new, narrower question with an argument that
is **stronger**, not merely inherited, for the lite-profile case
specifically.

The lite profile's own [content principle 4](#content-principles) makes
**mechanical helper gates the primary control surface (fail-closed)** —
the entire premise is that fail-closed mechanics, not model judgment,
carry the safety weight for a weak-model session. #1416's structural
finding is that neither Claude Code nor OpenCode documents a "must load
unconditionally" primitive for skills: every invocation path (model
judgment call, `/name`, subagent preload, or `paths` glob-match) is
either an explicit action or a probabilistic trigger, never a forced
load at session start. Converting a load-bearing lite phase file into a
skill would make **whether the gate text is even in context** depend on
the same kind of model judgment the lite profile exists to route around.
That is a worse fit than for the standard profile #1416 already rejected
skills for: the standard profile's load-bearing files are already
safely delivered today because the routing table dispatches to them
deterministically regardless of model judgment; a lite profile that
adopted skills would trade that deterministic property away for the
exact tier least able to compensate for a missed trigger.

Option (a) also wins on the property a lite profile actually needs:
**mechanical drift control**, via the same `sync-docs.mjs` /
`audit-docs.mjs --check` machinery the standard profile already relies
on — concretely, one new `fileSets` entry plus its required per-file
`syncPairs` entries, and likely a new `bundleBudgets` entry. See
[Drift control](#drift-control) below for the full mechanism and why
that is three mechanical additions to an already-proven system, not a
new content-authoring discipline.

### Option (b)'s trade-offs, recorded

Rejecting option (b) does not mean its upsides are imaginary.
`docs/skills-delivery-investigation.md` records two real, favorable
points that this design inherits rather than re-deriving:

- A weak, low-reasoning model may find matching a short task description
  to an auto-listed skill a lower-cognitive-load operation than parsing
  a routing table and extracting the correct row. This comparative claim
  is **untested** — no recorded failures of either mechanism exist yet.
- Because OpenCode also reads `.claude/skills/` as one of its own
  project-level discovery paths, a single generated mirror could
  plausibly serve both Claude Code and OpenCode at once without a
  dedicated `.opencode/skills/` copy — a genuine mechanical convenience
  or a future sync-cost reduction if this repository ever does adopt
  skills for something else.

Neither point flips the verdict for the lite profile specifically:
untested table-parsing-vs-skill-matching reliability does not help the
judgment-heavy phases the lite profile excludes regardless of how it
resolves, and `docs/skills-delivery-investigation.md`'s own
"Recommendation: No-Go (for now)" section already names this issue, in
its "strongest opposing case" paragraph, as the venue pursuing "the same
underlying worry through content condensation rather than a
delivery-mechanism change" — i.e., that document already anticipated and
deferred to this one. That same section's own "Conditions that would
change this recommendation" list (recorded routing-failure evidence, a
runtime shipping a mandatory skill-invocation primitive, or explicit
adopter demand with a concrete unserved use case) — plus the separate
`## Revisit conditions` section's own triggers — are unchanged by this
design and remain the correct trigger for re-evaluating both documents
together.

## Drift control

Option (a) inherits the standard profile's existing two-copy drift
control (`idd-template/` canonical source → generated
`.github/instructions/` copy) and extends it with a third, parallel
generated pair rather than a third _kind_ of surface:

- **Generation mechanism**: `node scripts/sync-docs.mjs --apply`
  regenerates the lite files the same way it regenerates the standard
  ones today, from a new `fileSets` entry (see
  [Recommendation](#recommendation-option-a) above) covering
  `idd-template/.github/instructions/lite/idd-*.instructions.md` →
  `.github/instructions/lite/idd-*.instructions.md`, `match: "basename"`.
- **Audit mechanism**: `node scripts/audit-docs.mjs --check` fails on
  drift for the new pair the same way it already does for
  `idd-instruction-template-dogfood-set`, so an edit to a lite file's
  canonical source without regenerating the mirror is caught
  mechanically, not by review discipline. A `fileSets` entry with
  `requireSyncPairs: true` (the setting the existing dogfood set already
  uses) additionally requires one explicit `syncPairs` entry per matched
  file — the existing dogfood set has 18 such companion entries, one per
  instruction file, each naming its own `mode` (`exact`, `structure`, or
  `concreted`). A new lite `fileSets` entry needs the same: one
  `syncPairs` entry per lite file added, not just the `fileSets` entry
  itself.
- **Budget mechanism**: a new `bundleBudgets` entry (for example
  `bundle-work-lite`) gives the lite variant its own byte ceiling,
  separate from the standard bundle's `limitBytes`. This is deliberately
  a **new**, independently-set budget rather than inheriting the
  standard bundle's number — a lite file's target size is a function of
  the content principles above (self-contained, low cross-reference), not
  a fraction of the standard file's size, and the two should not be
  assumed to track each other.
- **Semantic parity, not byte parity.** Drift control here catches
  generation drift (canonical source vs. generated mirror), not
  semantic drift between the lite file and its standard counterpart —
  the [non-goal](#target-model-class-and-non-goals) that a lite file
  must never disagree with the standard file's actual rule. Verifying
  that is a review-time responsibility for whoever authors each lite
  file per the decomposition below, not a mechanical check this design
  proposes; a future follow-up could investigate a mechanical
  semantic-parity check, but this design does not assume one exists.

## Decomposition proposal

The following follow-up issues are proposed scope for a later authoring
pass. Titles and one-line scopes only — filing them is out of scope for
this design issue.

- **Wire sync-manifest drift control for lite instruction files** — add
  the `fileSets` entry, its required per-file `syncPairs` entries, and a
  new `bundleBudgets` entry, all described in
  [Drift control](#drift-control), so `audit-docs.mjs --check` enforces
  parity for the new surface before any lite content lands; sequence
  this first so every subsequent lite file is drift-checked from its
  first commit.
- **Author the lite instruction set for the work phase (B1-C6) —
  narrowest pilot** — condense `idd-work.instructions.md` into a
  self-contained lite file following all five content principles; the
  canonical single-issue execution phase and the smallest, most
  self-contained standard file (`bundle-work`, 41,300-byte budget),
  making it the lowest-risk pilot.
- **Author the lite instruction set for the claim phase (A5)** —
  condense `idd-claim.instructions.md`'s mechanical pre-checks (a)-(e)
  into a lite file; pairs naturally with the work-phase pilot since a
  lite session needs both to execute a single issue end to end.
- **Author the lite instruction set for the PR-submit phase (D1-D4)** —
  condense `idd-pr-submit.instructions.md`.
- **Author the lite instruction set for the resume phases** — condense
  `idd-resume.instructions.md` / `idd-resume-stall.instructions.md`,
  leaning on the existing deterministic classifier helpers per
  [Phase scoping](#phase-scoping).
- **Author the lite instruction set for the mechanical review-fix chain
  (E9-E15)** — condense `idd-review-fix.instructions.md`'s fix,
  validate, resolve-conflicts, lint/test/push, reply, re-review-request,
  and CI-wait steps, with an explicit stated boundary that E4-E8 triage
  dispositions must already exist from an excluded, stronger-session or
  human-authored pass before a lite session acts on them.
- **Author the lite instructions for the mechanical F2 helper-read
  subset and the F2.5 handoff-stop** — condense the in-scope parts of
  `idd-pre-merge.instructions.md` (reading the `pre-merge-readiness`
  helper verdict; stop-and-ask if it is missing, failing, or discarded)
  and `idd-merge-handoff.instructions.md` down to the single in-scope
  outcome identified in [Phase scoping](#phase-scoping): stop and hand
  off cleanly under `human_merge` / `separate_merge_agent`, never
  evaluate autonomous-merge readiness via the excluded prose fallback.
- **Document the lite-profile entry and opt-in convention** — specify
  how a weak-model session discovers and opts into the lite bundle set
  (for example, an explicit operator-set policy field, or a distinct
  routing note in the entry files), consistent with the existing
  `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` entry-point pattern; sequence
  this after at least the work-phase pilot exists so the convention has
  a real bundle to point to.
