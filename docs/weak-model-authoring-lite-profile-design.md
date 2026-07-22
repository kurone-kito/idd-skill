# Weak-Model Authoring Lite Profile — Design

This page records the design for
[#1556](https://github.com/kurone-kito/idd-skill/issues/1556). It is a
**design-only** planning note: no `skills/issue-authoring/` content
changes as a result of this document. It ends with a decomposition
proposal (see below) for a later authoring pass; filing those follow-up
issues is explicitly out of scope here.

**Motivation** (from the issue): an independent, exec-verified field PoC
against this repository's real `skills/issue-authoring/SKILL.md` /
`references/contract.md` and real `bin/idd-audit-authored-issue.mjs`
linter — not a simulation — found the full ~12K-token contract produces
**0/6 conforming drafts** across three weak local models. A condensed
~250-token checklist fixed structure (all three models produced the
required headings) but still **0/3 emitted a valid trailing
`autopilot-suitability` marker**. A follow-up constructive test —
condensed prose-only prompt plus **harness-injected** byte-exact
markers plus a repetition guard — took the same requirement to 1/1 on
attempt 1, across all three issue shapes (orphan, roadmap, child). See
[Field evidence](#field-evidence) below.

This is a distinct question from two other weak-local-model design
efforts opened alongside it:

- **Not a duplicate of
  [#1419](https://github.com/kurone-kito/idd-skill/issues/1419)'s
  condensed execution-profile design**
  ([`docs/weak-model-lite-profile-design.md`](weak-model-lite-profile-design.md)).
  #1419's phase-scoping table covers only the
  `.github/instructions/idd-*.instructions.md` execution-phase files; it
  never scopes or mentions `skills/issue-authoring/` at all. The
  issue-authoring skill bundle is a separate artifact with its own size,
  its own mirrored-copy mechanism, and its own acceptance gate (the
  linter) — #1419's design says nothing about it.
- **Related to, but narrower than, the harness-orchestrated
  execution-mode investigation**
  ([#1555](https://github.com/kurone-kito/idd-skill/issues/1555), open,
  unresolved as of this writing). Harness-owned marker injection is a
  concrete instance of that investigation's general principle (the
  harness owns everything mechanical/verifiable; the model does only
  atomic text) applied specifically to authoring output. This issue
  scopes only the authoring surface — the target artifact, the evidence,
  and the acceptance gate are all specific to issue drafting, not the
  execution loop's control flow. Where the evidence below implicates
  harness ownership beyond what a self-directed skill can guarantee,
  this design names that dependency explicitly rather than assuming
  #1555's eventual answer.

## Field evidence

Source: an independent field PoC
(<https://gist.github.com/kurone-kito/8f45ee1ec0c07e8a7fdc8c1f04e83654>),
reported 2026-07-19 in
[#1556](https://github.com/kurone-kito/idd-skill/issues/1556), quoted
and paraphrased here from the issue body plus the gist itself. Models:
qwen3.5 {0.8b, 2b, 2b-text, 4b}, ministral-3-3b, phi-4-mini (Foundry
Local, CPU-only), with `codex exec -m gpt-5.4-mini` as a cross-runtime
control. Per
[Cite the observed incident](idd-design-rationale.md#cite-the-observed-incident),
every failure mode named below is this one dated, issue-referenced
incident — not three independent citations.

- **Full contract (~12K tokens): 0/6 conforming drafts**, three distinct
  failure modes:
  1. Prefill timeout on ministral-3-3b and phi-4-mini before drafting
     completes at all.
  2. qwen3.5-2b-text drops required headings when processing the full
     contract.
  3. All three models fail to emit a valid trailing
     `<!-- idd-skill-autopilot-suitability: N -->` marker — omitted or
     non-integer — the exact byte-exact-marker failure
     [#1349](https://github.com/kurone-kito/idd-skill/issues/1349)'s
     linter exists to catch.
- **Condensed ~250-token checklist: structure fixed, markers still
  broken.** All three models produced the required headings. **0/3**
  still emitted a valid trailing marker: for at least one model, the
  marker is missing because the model repetition-spirals inside the
  acceptance-criteria list and never reaches the footer at all — a
  distinct failure from the full-contract case, where the marker was
  attempted but malformed.
- **Constructive fix: harness-injected markers.** A runner drove a
  sections-only condensed prompt (the model produces prose and
  structure only — Background/Proposed change/Acceptance criteria for
  orphan/child shapes, Goal/Background/Tracks/Success criteria for
  roadmap) while the **harness**, never the model, computed and
  injected every byte-exact marker
  (`autopilot-suitability`/`effort`/`roadmap-id`/`blocked-by`) and
  enforced the `suitability:1` ⇒ `status:blocked-by-human` cross-field
  invariant programmatically. Result: qwen3.5-2b-text (a small model)
  produced linter-passing drafts on attempt 1, across all three issue
  shapes the linter supports.

**The load-bearing implication**: condensing the _content_ alone did
not fix the marker failure — it only fixed the structural-heading
failure. The one intervention that fixed marker emission moved marker
computation **out of the model's free-text generation entirely**. Any
design that treats this as a pure content-condensation problem
(mirroring #1419's model, where inlining and imperative phrasing were
sufficient) would be fitting the wrong lesson from this evidence for
the marker piece specifically — see
[Harness/model split](#harnessmodel-split) below.

## Target model class and non-goals

This design reuses the model-capability taxonomy published in
[Model capability expectations](idd-workflow.md#model-capability-expectations)
(originating in
[`issue-authoring-skill.md`'s Specificity target](issue-authoring-skill.md#specificity-target)
three-tier list, later independently generalized into the two-axis
form by [#1549](https://github.com/kurone-kito/idd-skill/issues/1549)),
the same taxonomy [#1419's design](weak-model-lite-profile-design.md)
reuses, rather than inventing a parallel one.

**Note the two taxonomies are not the same axis.** `issue-authoring-skill.md`'s
[Specificity target](issue-authoring-skill.md#specificity-target)
governs how detailed a _drafted issue's content_ should be for the
model that will later _execute_ it downstream. This design is about
condensing the _authoring skill's own contract_ — the instructions
guiding the model doing the _drafting_ — a different axis. The two
interact (a condensed authoring profile still has to produce drafts
specific enough to hit the Specificity target's "Target" band) but this
design does not conflate them.

- **Target tier**: **lightweight local or compact cloud**, the same tier
  #1419 targets — models with both sufficient context and demonstrated
  self-direction for contained tasks, but weak adherence to long
  multi-file instruction sets. The field evidence above is drawn from
  exactly this tier (qwen3.5 2b/4b, ministral-3-3b, phi-4-mini class).
- **Non-goal: no ~32K-token squeeze.** Same reasoning as #1419: the
  **unsupported (context floor)** class is out of scope regardless of
  content condensation.
- **Non-goal: full elimination of the marker-drop failure mode via
  prose alone.** The field evidence above shows condensed prose fixed
  structure, not markers. This design does not promise a purely
  self-directed lite skill file will close that gap; see
  [Harness/model split](#harnessmodel-split).
- **Non-goal: no semantic changes to the authoring contract.** A lite
  profile changes shape and packaging only — never the underlying
  linter-checked schema, the claim-state precondition, or the
  Publication/Approval boundary. Any disagreement between a lite
  profile and the canonical contract is a defect in the lite profile.

## Content principles

Reusing [#1419's five content principles](weak-model-lite-profile-design.md#content-principles)
where they transfer to an authoring context:

1. **Self-contained checklists** — transfers directly. A condensed
   authoring profile should restate its load-bearing rules (claim-state
   precondition, prefix-first, smallest safe output shape) inline
   rather than requiring a full read of `references/contract.md`.
2. **Imperative, single-clause steps** — transfers directly; the field
   PoC's own successful condensed prompt was structured as short,
   single-purpose sections (Background/Proposed change/Acceptance
   criteria), not the full contract's dense prose.
3. **No deep cross-references** — transfers directly.
4. **Mechanical helper gates as the primary control surface
   (fail-closed)** — **transfers with a stronger reading for this
   surface than #1419 needed.** For every other lite-profile track, a
   documented helper command is a _preference_ over prose judgment. For
   authoring markers specifically, the field evidence shows prose
   judgment — even condensed prose judgment — **does not work at all**
   (0/3). This principle is not optional polish here; it is the
   difference between a working and non-working authoring-lite profile.
   See [Harness/model split](#harnessmodel-split).
5. **Explicit stop-and-ask conditions** — transfers directly; the
   existing skill's own **Under-clarification stop rule** ("if you
   still cannot name the concrete surface to edit or an objective
   verification for a candidate task, route it to `needs-decision` or
   ask") is already this principle applied to authoring, and a
   condensed profile should keep it rather than trim it away as
   "judgment-heavy."

**One principle that does not transfer as-is**: #1419's principle 4
assumes an existing deterministic helper the phase file can point to
(claim-lock, advisory-wait-state, etc.). No equivalent helper exists
yet for issue-authoring markers — see the next section.

## Harness/model split

Every claim/review marker this repository posts already has a
deterministic emission helper: `bin/idd-emit-marker.mjs` /
`scripts/emit-marker.mjs` covers `claimed-by`, `review-watermark`, and
`review-baseline` markers. **No equivalent exists for authoring
markers** (`autopilot-suitability`, `effort`, `roadmap-id`,
`blocked-by`, the `status:blocked-by-human` cross-field agreement, or
`markerPrefix` resolution) — today, a session (weak or strong) hand-types
these directly into the drafted body, then self-checks against
`bin/idd-audit-authored-issue.mjs` before publishing.

The field evidence's constructive fix is exactly this gap, solved
externally by a bespoke PoC runner. This design's central recommendation
is that closing it belongs in this repository as a **first-class
deterministic helper**, mirroring `emit-marker.mjs`'s existing shape:
compute and print the exact `<!-- idd-skill-autopilot-suitability: N -->`
/ `<!-- idd-skill-effort: X -->` / `<!-- idd-skill-roadmap-id: … -->` /
`<!-- idd-skill-blocked-by: … -->` marker lines (plus the visible prose
line each accompanies) from explicit inputs, never from the model's own
free-text reproduction of the format. A condensed authoring profile then
instructs the model to call this helper for every marker it needs — the
same "documented helper command over prose judgment" pattern content
principle 4 already establishes, applied to the one place the field
evidence shows prose alone fails outright.

Two contract details the helper must get right, both already load-bearing
in `bin/idd-audit-authored-issue.mjs`:

- **`markerPrefix` resolution**: the linter's `--marker-prefix` flag and
  `checkMarkerPrefixConsistency` both normalize and default to
  `idd-skill`, then require every marker in the body to use the same
  resolved prefix. The proposed helper must accept the same
  `markerPrefix` input (defaulting identically) and apply it to every
  marker line it emits, reusing the linter's own normalization rather
  than a second implementation — otherwise a custom-prefix repository's
  drafts fail the unchanged gate the helper is supposed to satisfy.
- **Label-side output, not just body markers**: the linter's
  `checkSuitabilityBlockedByHuman` validates `suitability: 1` against a
  **caller-supplied labels list** (`--label`, repeatable) — it checks
  whether the blocked-by-human label is already present, it does not
  apply it. The proposed helper computes body-marker text only; it
  cannot itself guarantee the cross-field invariant, because applying
  the GitHub label is a separate mutation (`gh issue create --label` /
  `gh issue edit --add-label`) the linter has never owned either. The
  helper's contract should therefore explicitly flag when
  `suitability: 1` requires that label, and the condensed profile must
  instruct the model (or the harness applying the helper's output) to
  add it — the same caller-owns-the-mutation split the linter itself
  already uses, not a new responsibility this design invents.

**This narrows, but does not eliminate, the harness-ownership
question.** A model-invoked helper still depends on the model
remembering to invoke it — a residual risk for a tier that field
evidence elsewhere shows can spiral and drop instructions entirely (see
[#1555](https://github.com/kurone-kito/idd-skill/issues/1555)'s
Background, a _different_ PoC run: 0/3 self-directed weak-model tasks
completed without an external harness owning the loop, independent of
instruction length). A fully harness-owned post-hoc injection step (the
PoC's actual constructive-fix architecture, external to any skill) is
the higher-reliability option that this design defers to #1555 rather
than duplicating: if #1555 lands a harness-orchestrated execution mode,
authoring markers are a natural first module for it, since the field
evidence already validates that exact architecture for this exact
artifact. A go decision here should be read as "worth building the
condensed profile and the marker helper regardless," not as "this alone
closes the reliability gap #1555 addresses more completely."

## Coverage of the three issue shapes

`bin/idd-audit-authored-issue.mjs` supports `orphan`, `roadmap`, and
`child` shapes today, and the field PoC's constructive-fix run covered
all three. A condensed authoring profile should therefore cover all
three shapes from the start rather than piloting on one — unlike the
execution-phase decomposition in
[#1419](https://github.com/kurone-kito/idd-skill/issues/1419) (which
had many separate files to stage across multiple issues), the entire
authoring contract is one skill bundle already, so there is no
equivalent "narrowest pilot" slice to carve out without leaving one
shape unable to be drafted on the lite path.

## Sync mechanism

`skills/issue-authoring/` already has an established two-copy drift
control: the canonical bundle
(`skills/issue-authoring/**/*.md`) is mirrored byte-identically to
`.claude/skills/issue-authoring/**/*.md` via the
`claude-skills-issue-authoring-markdown-set` `fileSets` entry in
`audit/sync-manifest.json` (`match: "basename"`, `requireSyncPairs:
true`), so Claude Code auto-discovers the skill.

A condensed profile fits this mechanism as an **additional reference
file inside the same skill bundle** — for example
`skills/issue-authoring/references/contract-lite.md` — rather than a
new top-level delivery surface. This is a simpler shape than #1419's
lite-instruction decomposition needed: that design had to invent a
parallel `.github/instructions/lite/` directory and its own routing,
because the standard profile is many separate always-loaded-by-table
files. `skills/issue-authoring/` is already one skill with a
`references/` subdirectory pattern (`contract.md`, `draft-patterns.md`,
`workflow-boundary.md` today); a condensed contract is one more file in
that same directory, requiring only:

- One new `syncPairs` entry (`exact` mode, matching every existing
  entry in this file set) so `sync-docs.mjs --apply` generates the
  `.claude/skills/issue-authoring/references/contract-lite.md` mirror.
- No new `fileSets` entry — the existing basename-matched set already
  covers any new file added under `skills/issue-authoring/**/*.md`.
- A `bundleBudgets` entry sized independently from `contract.md`'s own
  size (read the live value with `wc -c` on the file rather than
  trusting a snapshot to stay current), following #1419's own "new,
  independently set budget" rule (a lite file's target size is a
  function of its own content principles, not a fraction of the
  standard file's size).

**Open question this design does not resolve**: how a session
_discovers and opts into_ loading `contract-lite.md` instead of
`contract.md` for a given repository. This is exactly the "lite-profile
entry and opt-in convention" question
[#1548](https://github.com/kurone-kito/idd-skill/issues/1548) (open, in
progress as of this writing) is already answering for the execution-phase
lite profile. This design's recommendation is to **reuse whatever
convention #1548 establishes** rather than invent a second, parallel
opt-in mechanism — the two lite profiles (execution-phase, authoring)
should share one repository-level "am I in lite mode" signal, not two.

## Linter unchanged

This design changes how a draft is produced and how its markers are
attached, never what `bin/idd-audit-authored-issue.mjs` checks. A
draft produced via the condensed profile plus the proposed marker
helper must still pass the exact same linter invocation, with the exact
same exit-code contract, as a draft produced via the full contract
today. No linter change is proposed or required by this design.

## Recommendation: go, narrowly scoped

**Go**, scoped specifically to:

1. A condensed authoring reference (`contract-lite.md`) covering
   prose/structure guidance only — the load-bearing rules from the
   Stable Phases, claim-state precondition, prefix-first rule, and
   smallest-safe-output-shape decision — following content principles
   1-3 and 5 above.
2. A new deterministic marker-emission helper for authoring markers,
   mirroring `emit-marker.mjs`'s existing shape, that the condensed
   profile instructs the model to call for every marker rather than
   hand-typing one.
3. Explicit routing to `bin/idd-audit-authored-issue.mjs` as the
   unchanged acceptance gate for both profiles.

**No-go, deferred**: fully closing the marker-drop failure mode via a
model-invoked helper alone is not what the field evidence's
constructive fix actually validated — that was a harness-owned,
post-hoc injection step, not a model tool call. This design does not
recommend attempting to fully replicate that architecture inside a
model-self-directed skill; it recommends building the pieces (condensed
prose + a callable helper) that are useful regardless of how #1555
resolves, while explicitly not overclaiming they alone reach the PoC's
1/1 reliability. If #1555 lands a harness-orchestrated execution mode,
authoring markers are a natural first module for it, reusing the same
helper this design proposes rather than a second implementation.

This does not re-litigate
[`docs/skills-delivery-investigation.md`](skills-delivery-investigation.md)'s
no-go on delivering the _execution-phase_ instructions as skills:
`skills/issue-authoring/` is not a candidate for that question at all,
since it is already delivered as a skill today. The relevant delivery
question here — one condensed reference file inside an existing skill
bundle versus a new delivery surface — is answered in
[Sync mechanism](#sync-mechanism) above, not by re-running that
investigation.

## Decomposition proposal

The following follow-up issues are proposed scope for a later authoring
pass. Titles and one-line scopes only — filing them is out of scope for
this design issue.

- **Author a deterministic authoring-marker emission helper** —
  `bin/idd-emit-authoring-marker.mjs` (or an extension of the existing
  `emit-marker.mjs`), computing and printing the exact
  `autopilot-suitability`/`effort`/`roadmap-id`/`blocked-by` marker
  lines (visible prose plus HTML comment) from explicit inputs,
  reusing `bin/idd-audit-authored-issue.mjs`'s own `markerPrefix`
  normalization, and flagging (not applying) the required
  blocked-by-human label whenever `suitability: 1`. No model-authored
  marker text as input.
- **Author `skills/issue-authoring/references/contract-lite.md`** — a
  condensed authoring reference covering prose/structure guidance for
  all three issue shapes (orphan, roadmap, child), following content
  principles 1-3 and 5 above, that explicitly instructs the model to
  call the new marker helper rather than typing markers itself. Depends
  on the marker-helper issue above landing first.
- **Wire the authoring-lite opt-in into whatever convention #1548
  establishes** — extend or reuse the execution-phase lite-profile
  entry/opt-in mechanism for `contract-lite.md`, once
  [#1548](https://github.com/kurone-kito/idd-skill/issues/1548) lands,
  rather than inventing a second convention. Sequence this after both
  #1548 and the `contract-lite.md` authoring issue above.
- **Revisit authoring-marker harness ownership alongside #1555** — once
  [#1555](https://github.com/kurone-kito/idd-skill/issues/1555)'s
  harness-orchestrated execution-mode investigation resolves, evaluate
  whether authoring-marker injection should move from a model-invoked
  helper call (this design's scoped recommendation) to full harness
  ownership (the field PoC's actual constructive-fix architecture),
  reusing the marker-computation logic from the helper issue above
  either way.
