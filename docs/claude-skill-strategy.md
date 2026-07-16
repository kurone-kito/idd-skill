# Claude Code Skill Strategy for the IDD Execution Loop

This page records the design evaluation for packaging the IDD execution
loop as a Claude Code skill. It is a planning note, not an instruction
surface for any agent; the execution loop remains owned by
`.github/instructions/` regardless of the outcome recorded here.

**Current state**: Claude Code enters the loop through `CLAUDE.md`,
which routes to `.github/instructions/idd-overview-core.instructions.md`
and the phase files via the routing table. The repository ships one
native skill bundle (`skills/issue-authoring/`) and, since the
dogfooding work for that bundle, a generated mirror of its Markdown
files (byte-identical per file) under
`.claude/skills/issue-authoring/` kept in sync by
`node scripts/sync-docs.mjs --apply` and drift-guarded by
`node scripts/audit-docs.mjs --check`.

## Bundle Shape

Three shapes were considered for an execution-loop skill:

1. **One `idd-execution` skill** wrapping the phase routing table and
   re-packaging the phase content in skill form.
2. **Per-phase skills** (following the bundle paths: discovery, resume,
   work, review, merge), each wrapping one phase path.
3. **Thin shim**: a skill whose body only restates the entry contract —
   "read `idd-overview-core.instructions.md`, then the phase file the
   routing table selects" — and defers all content to
   `.github/instructions/`.

Shapes 1 and 2 re-package the canonical instruction set that four agent
surfaces (Copilot, Codex CLI, Claude Code, Antigravity CLI — formerly
Gemini CLI) all consume
today. The artifact taxonomy in
[IDD workflow guide](idd-workflow.md) already rules this out as policy:
native skill bundles "should not duplicate or replace the exported IDD
instruction template", and the synchronization contract for the portable
workflow remains between the live `.github/instructions/` files and
`idd-template/`. Only shape 3 is taxonomy-consistent, and it is the
shape this note evaluates below. The same shim shape would generalize to
other skill-directory runtimes (for example `.github/skills/` or
`.agents/skills/`) if those surfaces are ever adopted.

**Hard constraint — the execution-approval boundary.** The
issue-authoring skill contract states that starting the IDD execution
loop requires a separate explicit approval, and that the native bundle
and the execution instructions are not interchangeable entry points
(see [Issue-authoring skill](issue-authoring-skill.md)). Skills
auto-trigger from their `SKILL.md` description, so any execution-loop
skill — including a thin shim — must be written so that triggering the
skill does **not** by itself authorize loop start: the shim may only
restate where the instructions live and that the operator's explicit
request remains the start condition.

## Sync Contract

- **Reference-only shim** (preferred): the skill body contains no copy
  of instruction content, only pointers. It adds no sync pairs, no
  drift surface, and no new transform class to the audit machinery.
- **Generated mirror**: mechanically possible today — the
  `.claude/skills/issue-authoring` mirror shows the pattern (its
  `mode: exact` sync pairs plus regeneration via `sync-docs`) — but an
  execution-loop mirror would add a third synchronized surface next to
  `.github/instructions/` and `idd-template/`, multiplying the drift
  matrix for every phase-file edit and contradicting the artifact
  taxonomy cited above. It is rejected even for a future "go" decision;
  going forward means shipping the shim, not a mirror.

## Context Economics

The bundle budgets in `audit/sync-manifest.json` cap the combined size
of the instruction files loaded together on each phase path (one budget
per discovery / resume / work / review / merge bundle, plus per-file caps
for always-loaded and phase files; read the live values with
`jq '.instructionSizeBudgets, .bundleBudgets' audit/sync-manifest.json`).
Two observations follow:

- A skill wrapper does not shrink any of that content; it changes only
  _when_ content enters the context. Claude Code already loads phase
  files on demand by following the routing table, so the marginal gain
  of progressive disclosure is small.
- Auto-triggering adds a new cost class: the skill description sits in
  every session's context, and a description match can pull IDD entry
  context into sessions that are not doing IDD work. The budgets do not
  measure skill bodies, so a mirror-shaped skill would also need new
  budget entries; a thin shim adds zero bytes to every existing bundle.

## Strategy Fit (Go / No-Go)

The Copilot-first policy in [AI tooling strategy](ai-strategy.md)
prefers preserving existing Copilot behavior over abstracting early and
allows extraction "only after benchmarks show that the Copilot-first
workflow does not regress"; `.github/copilot-instructions.md` keeps the
canonical layout "unless benchmark results justify" a change. Applying
that bar, **all** of the following would have to hold before shipping an
execution-loop skill:

1. **Observed routing failures**: recorded Claude Code sessions that
   failed to route from `CLAUDE.md` into the correct phase file, at a
   rate that materially affects loop reliability — with the
   issue-authoring dogfood mirror as the comparison baseline for how a
   skill changes discovery behavior.
2. **A shim measurably fixes them**: the same scenarios succeed with the
   shim installed, attributable to the skill surface rather than to
   prompt changes.
3. **No Copilot-first regression**: benchmarks show the Copilot
   workflow is unaffected (the shim touches no shared instruction
   files, so this should hold by construction and must be confirmed).
4. **Approval boundary preserved**: the shim demonstrably does not
   start the loop on auto-trigger without the operator's explicit
   request.
5. **Maintenance stays shim-only**: no mirrored content, no new sync
   pairs beyond registering the shim files themselves.

Until that evidence exists, the answer is no-go: today the four-agent
single-source model works, no routing-miss evidence has been recorded,
and the loop's entry cost is already governed by the bundle budgets.

## Revisit Trigger

Re-evaluate this note when the issue-authoring dogfood has accumulated
enough sessions to compare skill-based and entry-file-based discovery —
or earlier if adopters explicitly request a skill-form execution loop,
or if a Claude Code session is observed failing the `CLAUDE.md` routing
path. Evidence should be captured as issues referencing this note.

## Non-Goals

This strategy does not:

- change any instruction file, template file, or runtime behavior
- create a skill bundle, shim, or `.claude/skills/` entry for the
  execution loop
- alter the issue-authoring bundle or its generated mirror
- weaken the execution-approval boundary documented in the
  issue-authoring skill contract
- replace `CLAUDE.md` as the Claude Code compatibility entry point

## Recommendation

Defer packaging the IDD execution loop as a Claude Code skill (no-go
now); if the go criteria above are later met by recorded evidence,
adopt the thin-shim shape with a reference-only sync contract.
