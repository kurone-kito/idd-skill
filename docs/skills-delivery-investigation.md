# Investigation: Skills-Based On-Demand Delivery of IDD Phase Instructions

This document records the findings and recommendation for
[#1416](https://github.com/kurone-kito/idd-skill/issues/1416), an
investigation child of the OpenCode support roadmap
([#1413](https://github.com/kurone-kito/idd-skill/issues/1413)). It is a
planning note, not an instruction surface: the execution loop remains
owned by `.github/instructions/*.instructions.md` regardless of the
outcome recorded here. This is an investigation deliverable, not an
implementation — no instruction file, template file, or runtime behavior
changes as a result of this document.

**Question**: should the repository deliver IDD phase instructions as
Claude-compatible skill bundles (`SKILL.md` under `.claude/skills/` /
`.opencode/skills/`), on demand, instead of — or in addition to — the
current `.github/instructions/idd-*.instructions.md` files?

## Relationship to the existing Claude Code skill evaluation

[`docs/claude-skill-strategy.md`](claude-skill-strategy.md) already
evaluated a closely related question in Claude Code's context alone:
whether to package the **whole execution loop** as a Claude Code skill,
concluding no-go pending recorded evidence of `CLAUDE.md`-routing
failures. This investigation is narrower in one sense (it does not
propose re-litigating that verdict) and broader in another: OpenCode has
no Copilot-style `applyTo` scoping at all, so its motivating pressure for
on-demand delivery is structurally different, and the roadmap asks for
coverage this repository has not previously recorded — cross-agent
discovery/precedence, the sync-mechanism design, and a safety analysis
naming which content must never be lazy-loaded. Where the two documents'
reasoning overlaps (marginal token gain, third-surface maintenance cost),
this document reaffirms and extends the prior conclusion rather than
re-deriving it from scratch; it does not treat that overlap as evidence
this investigation is redundant, since the OpenCode-specific facts below
were not evaluated by the prior note.

## Current delivery model (baseline)

- **Copilot** — reads the lightweight `.github/copilot-instructions.md`
  (which carries no `applyTo` frontmatter) and auto-loads the single
  `applyTo: "**"` file, `idd-overview-core.instructions.md`; the phase
  files themselves are opened via that overview's routing table, not
  path-auto-scoped, so this is already the same on-demand read Claude
  Code uses (package-scoped `.instructions.md` files do auto-load by path
  in the VS Code Copilot surface, but the phase files are not among
  them). Copilot has no skill-loading mechanism at all. Skills would be a
  purely additive channel for Copilot: adopting them elsewhere changes
  nothing about how Copilot behaves, and Copilot cannot regress as a
  result of this decision either way.
- **Claude Code** — `CLAUDE.md` is the auto-loaded entry point. It
  contains the phase routing table (via
  `idd-overview-core.instructions.md`); the agent's own Read tool opens
  the named phase file only when the routing table says to. This is
  already **on-demand** in the sense that matters for context cost: the
  phase content does not enter the context window until the agent
  chooses to read it.
- **OpenCode** (planned via
  [#1414](https://github.com/kurone-kito/idd-skill/issues/1414), not yet
  shipped — no `.opencode/skills/` or `.agents/skills/` skill/config
  directory exists in this repository as of this writing, though OpenCode
  is already referenced in prose here and in the related rationale
  entries) —
  resolves project rules by walking up from the cwd and loading the
  **first** matching file among `AGENTS.md`, then `CLAUDE.md` (no merge
  between the two; `opencode.json`'s `instructions` array is the one
  exception, loaded unconditionally into every session). Once #1414
  generalizes `AGENTS.md` into the shared entry stub, OpenCode gains the
  identical routing-table-plus-on-demand-Read mechanism Claude Code
  already has — this is the single fact that most shapes the
  recommendation below.
- **Existing skill precedent** — `skills/issue-authoring/` is the one
  native skill bundle this repository ships, mirrored byte-identically
  to `.claude/skills/issue-authoring/` by `node scripts/sync-docs.mjs
  --apply` via four `mode: "exact"` entries in
  `audit/sync-manifest.json`'s `syncPairs`, drift-guarded by `node
  scripts/audit-docs.mjs --check`. Its own contract
  ([`docs/issue-authoring-skill.md`](issue-authoring-skill.md)) states
  explicitly that the native bundle and the execution instructions must
  not be treated as interchangeable entry points — triggering the skill
  never by itself authorizes starting the IDD loop. Any phase-instruction
  skill would need the same non-interchangeability boundary.

## 1. Candidate skill-boundary mapping

`idd-overview-core.instructions.md` (16,239 bytes; the one file matching
`applyTo: "**"`, capped at 20,000 bytes by the dogfooding entry's
`alwaysLoadedLimitBytes` in `instructionSizeBudgets`) and
`idd-overview-appendix.instructions.md` (8,297 bytes) are loaded in
**every** phase bundle in `audit/sync-manifest.json`'s `bundleBudgets`.
They are categorically **not** skill candidates: something that must
always be present cannot be delivered through a primitive that only
loads on invocation (see the Safety analysis below). The mapping
question applies only to the remaining 16 phase-specific files
(271,814 bytes combined across those 16 files at present — the two
always-loaded overview files above are excluded, so this is the
skill-candidate size, not the 296,377-byte all-18 total; read live sizes
with `wc -c .github/instructions/*.instructions.md` rather than trusting
this snapshot to stay current).

Two candidate granularities:

<!-- dprint-ignore-start -->
| Phase file | Bytes | Existing bundle | Candidate skill boundary |
| --- | --- | --- | --- |
| `idd-discover.instructions.md` | 32,388 | bundle-discovery | Option A: own skill. Option B: `idd-discover` bundle skill |
| `idd-claim.instructions.md` | 29,498 | bundle-discovery | Option A: own skill. Option B: `idd-discover` bundle skill |
| `idd-suitability.instructions.md` | 11,614 | bundle-discovery | Option A: own skill. Option B: `idd-discover` bundle skill |
| `idd-resume.instructions.md` | 15,267 | bundle-resume | Option A: own skill. Option B: `idd-resume` bundle skill |
| `idd-resume-stall.instructions.md` | 9,628 | _none_ | Option A: own skill. Option B: no existing bundle groups it — needs a new decision either way |
| `idd-work.instructions.md` | 14,276 | bundle-work | Option A: own skill. Option B: `idd-work` bundle skill |
| `idd-pr-submit.instructions.md` | 10,681 | _none_ | Option A: own skill. Option B: no existing bundle groups it |
| `idd-review-snapshot.instructions.md` | 15,435 | bundle-review | Option A: own skill. Option B: `idd-review` bundle skill |
| `idd-review-triage.instructions.md` | 29,473 | bundle-review | Option A: own skill. Option B: `idd-review` bundle skill |
| `idd-review-fix.instructions.md` | 18,175 | bundle-review | Option A: own skill. Option B: `idd-review` bundle skill |
| `idd-pre-merge.instructions.md` | 19,206 | bundle-merge | Option A: own skill. Option B: `idd-merge` bundle skill |
| `idd-merge-handoff.instructions.md` | 3,771 | bundle-merge | Option A: own skill. Option B: `idd-merge` bundle skill |
| `idd-merge.instructions.md` | 17,851 | bundle-merge | Option A: own skill. Option B: `idd-merge` bundle skill |
| `idd-roadmap-audit.instructions.md` | 10,326 | _none_ | Option A: own skill. Option B: no existing bundle groups it |
| `idd-ci.instructions.md` | 15,348 | review + merge (shared) | Cross-cuts both bundles either way — a boundary decision, not a bundle inheritance |
| `idd-advisory-wait.instructions.md` | 14,172 | review + merge (shared) | Cross-cuts both bundles either way — a boundary decision, not a bundle inheritance |
<!-- dprint-ignore-end -->

- **Option A (one skill per phase file, ~16 skills)** maps 1:1 to today's
  file list, so no new content boundaries need to be invented, but it
  maximizes the number of `SKILL.md` description entries resident in
  every session's skill listing (see Token/context economics).
- **Option B (bundle-aligned skills, 5–6)** reuses the discovery /
  resume / work / review / merge grouping the repository already
  maintains for budget purposes — except three files
  (`idd-resume-stall`, `idd-pr-submit`, `idd-roadmap-audit`) are not
  part of any existing `bundleBudgets` entry, so Option B cannot be a
  pure relabeling of existing groups; it requires new boundary
  decisions for those three, and `idd-ci` / `idd-advisory-wait` already
  cross-cut two bundles each, which does not collapse cleanly into
  either "own skill" or "belongs to bundle X."
- **Description-budget ceiling** — the issue's cited "≤1024-character"
  figure is OpenCode's own hard validation rule (`description` "must be
  1-1024 characters", schema-enforced per its skills documentation).
  Claude Code enforces a **different**, larger, and configurable limit:
  `description` plus `when_to_use` combined is truncated at 1,536
  characters in the skill listing (`skillListingMaxDescChars`), and the
  overall listing budget separately "scales at 1% of the model's context
  window." These are two distinct mechanisms with two distinct numbers —
  a shared skill bundle intended for both runtimes would need to satisfy
  OpenCode's harder 1,024-character cap to be portable, since exceeding
  it there is a validation failure rather than a soft truncation.
  Compressing any of the larger phase files (up to 32,388 bytes of body
  content) into a single-purpose, sub-1,024-character description that
  still reliably triggers auto-invocation is a real authoring
  constraint, independent of the go/no-go question.

## 2. Discovery and precedence across OpenCode and Claude Code

- **OpenCode** discovers skills from six paths, in order: project-level
  `.opencode/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`,
  `.agents/skills/<name>/SKILL.md` (each walked up from the cwd), then
  the equivalent three global paths under `~/.config/opencode/`,
  `~/.claude/`, and `~/.agents/`. Skills load on demand via a native
  `skill` tool. OpenCode's documentation does not specify precedence or
  merge behavior when the **same skill name** appears in more than one
  of those directories simultaneously — this is an open upstream
  ambiguity, and a repository shipping the same skill name under both
  `.opencode/skills/` and `.claude/skills/` should treat the resulting
  behavior as undefined until OpenCode documents it.
- **Claude Code** discovers from `.claude/skills/` at enterprise,
  personal (`~/.claude/skills/`), project, and plugin levels, plus
  per-directory nested `.claude/skills/` in monorepos. When names
  collide: enterprise overrides personal, personal overrides project,
  and any of these overrides a same-named bundled skill; plugin skills
  are namespaced (`plugin:skill`) and cannot collide with the rest.
  Nested-directory skills with a colliding name both stay available
  under directory-qualified names. Live file-watching reloads edited
  skills mid-session (a new top-level skills directory needs a
  restart).
- **Practical cross-agent implication** — OpenCode reads
  `.claude/skills/` as one of its own three project-level paths. A
  single generated mirror at `.claude/skills/<name>/` would already be
  discoverable by **both** Claude Code and OpenCode without a second
  `.opencode/skills/` copy, which is a genuinely favorable data point
  for the sync design below — it does not, by itself, change the
  go/no-go verdict.
- **Copilot** is unaffected either way (see Current delivery model
  above); skills are additive-only from Copilot's perspective.

## 3. Sync-mechanism coexistence design

The existing `skills/issue-authoring/` → `.claude/skills/issue-authoring/`
pattern generalizes mechanically: a canonical source directory per skill,
one `mode: "exact"` `syncPairs` entry per file, verified by `audit-docs.mjs
--check`. Per the cross-agent discovery finding above, a single
`.claude/skills/<name>/` mirror could plausibly serve both Claude Code and
OpenCode without a dedicated `.opencode/skills/` copy — reducing, not
eliminating, the number of generated targets. Whether relying on that
shared path is safe still depends on OpenCode publishing (or this project
testing and documenting) the same-name precedence behavior flagged as
undefined above.

The unresolved cost is not mechanical capability — the sync/audit
machinery can clearly support a new generated surface — it is **drift
surface count**. Today a phase-file edit touches two mirrored copies:
`.github/instructions/` (generated, Copilot-facing) and
`idd-template/.github/instructions/` (canonical source). Adding
skill-form delivery would make every phase-file edit a **three-copy**
change (canonical template → generated instruction file → generated
skill wrapper), for every file a skill wraps. This is exactly the
concern [`docs/idd-workflow.md`](idd-workflow.md) already records as
policy — native skill bundles "should not duplicate or replace the
exported IDD instruction template" — and the reason
`docs/claude-skill-strategy.md` rejected the full-content mirror shape
(its "Shape 2") even for a Claude-Code-only execution-loop skill. Nothing
about the OpenCode context changes that arithmetic; if anything, wrapping
16 phase files (Option A above) instead of the single shim shape that
prior note preferred multiplies it further.

## 4. Safety analysis

The roadmap names the concrete risk directly: "phase instructions are
safety-load-bearing, so lazy loading also risks an agent acting before
the gate text is in context." The content that must never be
lazy-loaded spans two tiers, both safe today for the same underlying
reason: the claim revalidation gate and marker-authority essentials
(`idd-overview-core.instructions.md` §"Claim revalidation gate" — the
one file matching `applyTo: "**"`, confirmed by grep to be the only
such file today, and therefore always-loaded); and the full A5 claim
protocol (`idd-claim.instructions.md`) plus the merge-gate chain
(`idd-pre-merge.instructions.md`, `idd-merge-handoff.instructions.md`,
`idd-merge.instructions.md`, `idd-advisory-wait.instructions.md`,
`idd-ci.instructions.md`) and the fail-closed default itself, which are
**phase** files, not always-loaded, yet already just as safe — not
because they sit in context unconditionally, but because the entry
file's routing table deterministically dispatches to them at the exact
step that needs them. That second tier is the one this investigation's
safety argument turns on: it shows the deterministic-routing model
already carries load-bearing content safely without paying the
always-loaded cost, which is precisely the property a skill's opt-in
trigger cannot reproduce.

**The structural finding**: neither runtime documents a "must load
unconditionally" primitive for skills. Claude Code's invocation paths
are: the model judges the description relevant and calls the `Skill`
tool; the user types `/name`; a subagent preload configured in advance;
or the `paths` frontmatter field, which auto-activates a skill when the
agent is working with files matching a glob — the closest thing to a
deterministic trigger skills offer, but keyed on file path, not workflow
phase. IDD's routing table dispatches by which **step of the loop** the
agent is in (Discover, Claim, Work, PR, Review, Merge), a distinction
`paths` glob-matching cannot express, so this fourth path does not
rescue phase-file delivery from the judgment-call problem below. None of
the four paths forces a skill's body into context at session start
regardless of relevance (that guarantee is what `CLAUDE.md`/`AGENTS.md`
content itself already provides, by being read unconditionally).
OpenCode's own documentation describes its skill tool the same way:
skills are "loaded on-demand via the native `skill` tool," never
unconditionally. Converting a load-bearing phase file into a skill would
therefore replace a **deterministic** step — the routing table just
named this file, the agent's Read tool opens it — with a
**probabilistic** one: does the model judge the skill relevant enough to
call it at all. Claude Code's own documentation confirms this failure
mode is real even for capable models: it has a dedicated troubleshooting
entry for "Skill not triggering," whose first remedies are checking
whether the description "includes keywords users would naturally say"
and rephrasing the request "to match the description more closely" —
triggering is a fuzzy keyword/description match, not a guarantee. A
weak, low-reasoning local model — the explicit target audience this
roadmap is writing guidance for — is a worse bet against that failure
mode than the model classes that documentation is written for, not a
better one.

This finding does not disqualify skills from ever carrying IDD-adjacent
content — it disqualifies them specifically from the tier that must
execute regardless of the model's own relevance judgment. None of the
current 16 phase files are pure background reference free of a gate,
check, or required step, so none of them is a clean candidate for
skill-only delivery under the current phase-file boundaries.

## 5. Token/context economics

Extending `docs/claude-skill-strategy.md`'s argument across the wider
agent set: once #1414 ships, OpenCode's `AGENTS.md`-driven routing table
plus on-demand Read achieves the same "content enters context only when
needed" property Claude Code already has. A skill wrapper does not
shrink any phase file's content; it only changes the trigger mechanism
from "the routing table said so" to "the model decided to invoke it" —
and it adds a cost the current model does not pay at all: the
always-resident skill-listing entry (name plus description) for every
wrapped phase, which Claude Code's own sizing model states "scales at 1%
of the model's context window." A plain instruction-file routing table
pays no such per-entry tax: the table itself is a few dozen bytes inside
the already-counted, already-always-loaded entry file, not a separate
budgeted surface per phase.

## Recommendation: No-Go (for now)

Skill-based delivery of IDD phase instructions is **not** recommended at
this time, for either Claude Code or OpenCode, under the current
phase-file boundaries. This extends `docs/claude-skill-strategy.md`'s
prior Claude-Code-only no-go to explicitly cover OpenCode as well,
reaffirming its token-economics reasoning and adding a distinct,
stronger argument this investigation surfaced:

1. **No new capability once #1414 ships.** OpenCode gains the identical
   routing-table-plus-on-demand-Read mechanism Claude Code already has;
   skills would change _how_ a file is requested, not _whether_ its
   content was already being loaded on demand.
2. **Skills cannot guarantee load-bearing content executes.** No
   documented primitive in either runtime forces an unconditional skill
   load; auto-trigger is a model judgment call, and Claude Code's own
   docs treat "skill did not trigger" as an expected, named failure
   mode. The claim protocol and merge gates cannot depend on that
   judgment succeeding, especially on the weak-model tier this roadmap
   targets.
3. **A third synchronized surface.** Wrapping phase files as skills adds
   a drift-prone third copy beside `.github/instructions/` and
   `idd-template/`, contradicting the "should not duplicate or replace
   the exported IDD instruction template" policy already recorded for
   this repository's native skill bundle.

**The strongest opposing case**, stated fairly: a weak, low-reasoning
model may find matching a short task description to an auto-listed
skill a lower-cognitive-load operation than parsing a routing table and
extracting the correct row — and because OpenCode also reads
`.claude/skills/`, a single generated mirror could plausibly serve two
agents at once, which is a real, favorable mechanical property. Both
points are worth recording, and neither flips the verdict today: the
comparative claim about weak-model table-parsing versus skill-matching
reliability is untested (no recorded failures of either mechanism
exist yet), it does not help the safety-critical tier at all regardless
of how it resolves, and the roadmap's own weak-model track
([#1419](https://github.com/kurone-kito/idd-skill/issues/1419)) is
already pursuing the same underlying worry through content condensation
rather than a delivery-mechanism change.

**Conditions that would change this recommendation:**

- Recorded evidence — from Claude Code or OpenCode sessions in this or
  a downstream repository — of material routing-table navigation
  failures (choosing the wrong phase file, or none, from the routing
  table) at a rate that affects loop reliability.
- Either runtime documenting a "required" or otherwise mandatory skill
  invocation primitive that closes the opt-in gap identified in the
  Safety analysis for load-bearing content specifically.
- Explicit adopter demand for skill-form phase-instruction delivery,
  with a concrete use case the routing-table mechanism does not already
  serve.

## Revisit conditions

Re-evaluate this note and `docs/claude-skill-strategy.md` together when
either: the issue-authoring dogfood and (once shipped) the OpenCode
generalized entry file have accumulated enough sessions to compare
routing-table-driven and skill-triggered discovery; an adopter explicitly
requests skill-form phase-instruction delivery; or a session is observed
failing routing-table navigation on either Claude Code or OpenCode.
Capture new evidence as issues referencing this document.

## Non-goals

This investigation does not:

- change any instruction file, template file, or runtime behavior
- create a skill bundle, wrapper, or `.claude/skills/` /
  `.opencode/skills/` entry for phase instructions
- alter the `skills/issue-authoring/` bundle, its generated mirror, or
  its execution-approval boundary
- revisit `docs/claude-skill-strategy.md`'s own Claude-Code-only
  execution-loop-skill question beyond reaffirming its reasoning still
  holds when extended to OpenCode
- propose follow-up implementation issues, since the recommendation is
  no-go (see Recommendation above and the paired
  [`idd-design-rationale.md`](idd-design-rationale.md) entry)
