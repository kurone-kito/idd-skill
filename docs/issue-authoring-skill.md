---
type: reference
title: Issue Authoring Skill Contract and Schema
description: Defines the stable contract and output schema for the agent-facing issue authoring skill that prepares IDD-ready issues.
tags: [issue-authoring, skill-contract]
---

# Issue Authoring Skill Contract and Schema

This document defines the stable contract and output schema for an
agent-facing issue authoring skill that prepares IDD-ready issues before
the normal Discover → Claim → Work loop begins.

The contract explains when the skill should run and how it should
behave. The schema explains what a ready orphan issue, roadmap issue,
or sub-issue must contain so the later IDD discover phase can consume
the result safely.

The canonical bundle in this repository lives at
`skills/issue-authoring/`. When adopters install it in another
repository, they should copy it into the agent-specific skill directory
their runtime reads, such as `.github/skills/`, `.claude/skills/`, or
`.agents/skills/`.

## Purpose

Use the issue authoring skill to turn a user request into a safe,
reviewable issue set when direct implementation would otherwise skip the
issue hygiene that IDD depends on.

The skill exists to improve issue quality before execution, especially
when work will span multiple tasks, dependencies, or agent sessions.

It is a source bundle, not the execution loop itself: the bundle lives
in `skills/issue-authoring/` here, while installed copies belong in the
skill directory for the runtime that will load them.

## Trigger policy

Invoke the skill when one or more of the following are true:

- the request is too large or ambiguous for a single direct
  implementation pass
- the likely solution needs decomposition into multiple atomic tasks
- dependencies or execution order need to be made explicit before work
  can start safely
- the user wants a roadmap, issue breakdown, or parallelizable work plan
- the repository would benefit from IDD-ready issue hygiene before any
  implementation begins

Skip the skill and continue directly with implementation when all of the
following are true:

- the task is small enough to complete in one reviewable change
- verification is already clear
- no roadmap, dependency marker, or issue split is needed
- the user did not ask for issue drafting or planning first

## Stable phases

The skill uses two stable phases. These phase names are normative and
should be reused by later implementation work.

### 1. Intake and Clarification

In this phase, the agent:

- inspects the relevant code, docs, and existing issues
- identifies missing context, assumptions, and ambiguity that could
  affect issue quality
- runs a secondary critique pass on the emerging interpretation
- asks the user only the questions that block safe issue drafting

The secondary critique pass must be agent-neutral:

- if the agent runtime offers a subagent, rubber-duck helper, or
  equivalent review primitive, it may use that
- otherwise, the agent performs an explicit self-critique pass locally

Clarification must converge. The skill should:

- use a bounded number of clarification rounds, with a default maximum
  of 3 or the repository-local `issueAuthoring.maxClarificationRounds`
  value when the target repository records one
- avoid asking questions that are merely nice to know
- prefer explicit assumptions when issue drafting is still safe without
  immediate user input

If bounded clarification is exhausted and safe drafting is still not
possible, the skill should stop and report the unresolved blockers
instead of looping indefinitely.

**Under-clarification stop rule.** If, after bounded clarification, the
skill still cannot name the concrete surface to edit or an objective
verification for a candidate task, it should route that candidate to
`needs-decision` or ask, instead of publishing a confidently-vague
`ready` issue. Reliability over speed. This is distinct from the
"Under-specified" specificity band below: that band judges an
already-drafted body's wording, while this rule stops publication
earlier, during Intake, before a body is even drafted.

### 2. Decompose and Draft

In this phase, the agent:

- restates the clarified request in implementation-facing terms
- breaks the work into atomic tasks
- evaluates whether each task is suitable for autonomous execution
- isolates low-autonomy work so it can be handled earlier, deferred, or
  surfaced for human decision
- checks whether an existing issue can be reused or extended before
  creating a new one

This phase may draft a roadmap issue, sub-issues, or orphan issues as
appropriate. The remaining sections of this document define the
normative rules for those outputs.

## Output readiness model

The skill must score each candidate task on the following axes before it
decides whether to draft an issue, split the work, or route it into a
non-ready bucket.

### Required execution axes

- **Limited scope**: the task fits a small, reviewable change. If the
  work is too broad for one issue, split it or create a roadmap.
- **Clear verification**: success can be checked through lint, tests,
  CI, or other explicit verification steps. If verification depends on
  unresolved product judgment, the work is not execution-ready.
- **Autonomous completion**: the work can finish without waiting for
  credentials, unavailable systems, or a human choice that has not yet
  been made.

These three axes align directly with the IDD viability gate in
`idd-discover.instructions.md`. A task is not draft-ready for execution
until all three pass.

### Supporting drafting axes

- **Dependency clarity**: dependencies are explicit, resolvable, and
  encoded in a form the discover phase can parse safely.
- **Confidence**: the agent has enough evidence to draft a stable issue
  instead of guessing at hidden scope or silently dropping uncertain
  work.

These supporting axes determine whether a ready task becomes an orphan
issue, a roadmap plus sub-issues, or a non-ready bucket.

### Autopilot-suitability score

The **Autonomous completion** axis is also persisted as a graded
**autopilot-suitability score** (1-5, higher = more
autopilot-suitable) so the discover phase can rank and route
candidates without re-deriving the judgment. **Score every drafted
issue and emit it** as an end-of-body footer (a visible line plus
a hidden, prefix-aware marker
`<!-- {marker-prefix}-autopilot-suitability: N -->`). Discover
**ranks and routes** candidates by the score (roadmap #759, fully
merged); it stays advisory and fail-safe on absence. See the
[Autopilot-suitability score](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#autopilot-suitability-score)
section of the contract for the rubric, footer format, and binding
rules.

- `5` autopilot-ideal · `4` strongly autopilot-suitable ·
  `3` borderline · `2` mostly human · `1` human-only.
- Scores below the configured floor (`autopilotSuitability.floor`,
  default `3`) designate human-oriented issues that discover routes
  to humans in autopilot runs.
- The score is an **advisory** ranking/routing hint only; it never
  bypasses the A4.5/A5 gates, a `1` must agree with
  `status:blocked-by-human`, and a missing or out-of-range score is
  treated as having no score (evaluated normally, never skipped).

### Effort hint

Issues may also carry an author-time **effort hint** (`S | M | L`) that
captures _size_, distinct from the suitability score's _autonomy_. Emit
it as an optional end-of-body footer beside the suitability footer (a
visible line plus a hidden, prefix-aware marker
`<!-- {marker-prefix}-effort: S|M|L -->`). Discover consumes it as a
**soft selection tie-breaker** so autopilot tends to clear small issues
first and leave large ones for a fresh session. See the
[Effort hint](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#effort-hint)
section of the contract for the rubric, footer format, and binding
rules.

- `S` small · `M` medium · `L` large — each band is now defined on two
  axes: **scope** (how many files or subsystems the change touches) and
  **uncertainty** (how many design decisions remain open once the plan
  is drafted). Observed agent token usage or wall-clock duration is a
  calibration sanity-check only, never the unit.
- An estimate that does not fit even `L`'s scope-and-uncertainty
  definition is a mis-scope smell: return to Decompose and Draft and
  split at intent level instead of publishing one oversized issue.
- The hint only reorders candidates **within** one suitability-score
  band (after the score and optional desync rules, before the
  lowest-issue-number tie-break); it never skips, gates, crosses a score
  band, or bypasses the A4.5/A5 gates, and a large issue stays claimable
  when it is the only ready work.
- A missing or invalid hint is **fail-safe**: selection behaves exactly
  as today (a missing hint sorts as the neutral middle, as-if `M`).

### Authoring-bucket marker

A `needs-decision` or `blocked-by-human` issue may also carry a hidden
**authoring-bucket marker**
(`<!-- {marker-prefix}-authoring-bucket: needs-decision|blocked-by-human -->`)
so `audit-authored-issue.mts` can mechanically enforce the matching
label the same way it already enforces `status:blocked-by-human` for a
suitability score of `1`. See the
[Authoring-bucket marker](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#authoring-bucket-marker)
section of the contract for the binding rules.

- Scoped to the two buckets with a real behavioral consequence today;
  `ready`, `deferred`, and `out-of-scope` carry no marker.
- When present, it decides the suitability-1/`blocked-by-human` check's
  applicability instead of the score; absent or malformed, that check
  falls back to its pre-existing suitability-1-only rule (no backfill
  onto issues published before this marker existed).

## Specificity target

Issue drafting should aim for a level of specificity where a
middle-tier cloud model can implement the task without drifting. This
is a practical drafting heuristic, not a hard model requirement. The
goal is to avoid both hidden assumptions that only a top-tier model can
infer and step-by-step runbooks that cost too much to author.

### Three specificity bands

| Band                | Practical signal                                                                                                          | Drafting response                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Under-specified** | Stable execution likely depends on a frontier cloud model class                                                           | Add missing constraints, split scope, or make acceptance criteria more explicit      |
| **Target**          | A middle-tier cloud model class can implement the issue without drifting                                                  | Treat this as the preferred drafting target when the execution axes already pass     |
| **Over-specified**  | Even a lightweight local or compact cloud model class could follow the issue mechanically because it has become a runbook | Remove procedural micromanagement while keeping invariants, file anchors, and checks |

The capability tiers above are practical heuristics, not a fixed
compatibility matrix or runtime requirement.

### How the specificity target interacts with readiness

This heuristic does not replace the IDD execution axes:

- **Limited scope** still decides whether the work fits one issue or
  needs a roadmap.
- **Clear verification** still decides whether success is objectively
  checkable.
- **Autonomous completion** still decides whether the task can finish
  without outside coordination.

An issue can be specific yet still fail A4 or A4.5 because it is too
broad, not verifiable, or blocked on a human decision. Conversely, an
issue that passes those gates can still be under-specified if it leaves
too much implementation shape implicit. The drafting target is therefore
"ready and stable for a middle-tier model," not "maximally detailed."

## Executability gate for code spec-units

For a **code spec-unit** — a drafted unit whose acceptance criteria are
objectively executable (a script, function, or test the drafted issue
itself specifies) — an authoring session can validate the draft before
publishing by building a throwaway reference implementation against its
own stated acceptance check and accepting the draft only if that
reference implementation passes. This reuses the downstream execution
loop as an upstream ground-truth gate: it catches drafts whose
acceptance criteria are internally inconsistent, non-trivially
unsatisfiable, or otherwise not actually implementable, before a
downstream executor ever claims the issue. The reference implementation
is a discarded validation probe, never published — it does not cross the
publication boundary (this file's local "Approval boundary" section
below); only the drafted issue itself is published, and building the
probe does not start the IDD execution loop.

This is a **recommended practice for repositories or domains where a
drafted code spec-unit has an objectively executable acceptance
check**, not a change to this repository's own mechanical
`bin/idd-audit-authored-issue.mjs` checks or a new requirement on this
repository's own issue-authoring practice — most of this repository's
issues are multi-file engineering changes without a single executable
acceptance check to validate against.

- **Weak-model semantic self-review stays advisory.** When a weak
  authoring model reviews its own draft for semantic quality, treat the
  verdict as advisory only, never a hard veto on publishing — mirroring
  the narrow-question guidance for weak-model judgment calls in
  `docs/idd-workflow.md`'s Weak-model guardrails section.
- **Decompose and draft want different model traits.** Decomposition
  (judgment about scope and structure) tolerates a verbose reasoning
  model; the structured draft step (emitting the exact spec/acceptance-
  criteria block) is more reliable on a leaner, more literal model,
  whose chain-of-thought does not compete with the drafted block for
  token budget. Pick the model per sub-task, not per pipeline, when both
  are available.
- **Redraft and re-decomposition are limited rescue mechanisms, not
  reliable fixes.** A bounded redraft loop tends to re-roll rather than
  converge, because a weak author regenerates rather than incrementally
  fixes. Re-decomposing a repeatedly-failing unit is usually low-value
  too: most authoring failures are hard-but-atomic rather than
  over-broad, and splitting a hard-but-atomic unit tends to produce
  incoherent sub-units that do not recompose. Treat a code spec-unit
  that repeatedly fails this gate as a candidate for `needs-decision` or
  human/stronger-model authoring instead of looping indefinitely.

## Stable readiness buckets

Low-confidence or low-readiness work must not be silently deleted. The
skill should route it into one of these stable buckets:

- **ready**: the work passes the execution axes and can be drafted as an
  orphan issue or as part of a roadmap.
- **deferred**: the idea is plausible, but priority, timing, or
  decomposition is not strong enough to make it a ready execution item.
- **needs-decision**: the work depends on a product, policy, or design
  choice that should be surfaced explicitly before execution.
- **blocked-by-human**: the work is waiting on a person, credential,
  asset, or outside system and therefore cannot complete autonomously.
- **out-of-scope**: the request does not belong in the repository or is
  materially outside the skill's target problem.

When the target repository keeps a secure-by-default issue-author
approval gate, a drafted issue can be execution-ready in content yet
still need a post-publication approval step before unattended execution
may start. In that case, keep the issue itself in the normal ready
shape, but state clearly that:

- the issue author is self-authorizing only when they satisfy the
  repository's `maintainer-approval-actors` policy
- otherwise an explicit approval signal is still required after the
  final issue content and generated-plan update are stable: the
  configured ready label from `approvalSignals.readyLabelName`
  (default: `idd:ready`) is accepted according to
  `approvalSignals.labelFreshnessMode` (`presence-only` by default,
  optional `event-freshness`), and standalone `IDD ready` comments from
  a maintainer approval actor must stay fresh against the latest issue
  edits and generated-plan update (or an equivalent draft-stability
  signal)
- until that approval exists, later discovery should treat the issue as
  part of the approval-needed fallback bucket rather than the normal
  ready-to-start set

Do not treat organization `MEMBER` association alone or CODEOWNERS
coverage as a substitute for that repository-local approval rule.

Recommended routing rules:

- if only **limited scope** fails, split the work or draft a roadmap
- if **clear verification** fails because intent is unresolved, route to
  `needs-decision`
- if **autonomous completion** fails because a human must act, route to
  `blocked-by-human`
- if **confidence** is too low but the request may still become valid,
  route to `deferred`
- if the work does not belong in this repository, route to
  `out-of-scope`

## Human-dependency isolation

Treat unresolved human dependency as a side effect that should be
isolated away from ready execution issues whenever possible.

- **Front-load** human-dependent work when coding cannot start safely
  until a person provides a decision, credential, permission,
  maintainer-only action, external setup, or policy choice, or until an
  unavailable system becomes usable again.
- **Back-load** human-dependent work when the remaining dependency is
  subjective review, publication choice, optional polish, or another
  post-implementation judgment that should not block an otherwise
  autonomous core change.
- Keep the central execution issue as close as possible to a pure
  autonomous unit: clear repository-local scope, no hidden human handoff
  in the implementation steps or acceptance criteria, and objective
  verification.
- Preserve unavoidable human-dependent work in an explicit stable
  bucket, dependency edge, or approval-needed hold rather than mixing it
  into a ready issue.
- Route unresolved choices to `needs-decision`, route waiting on people,
  credentials, maintainer-only actions, or unavailable systems to
  `blocked-by-human`, use `deferred` when timing or decomposition is not
  strong enough yet, and keep approval-gated ready work in the
  approval-needed hold instead of the normal ready-to-start set.
- If a task cannot be expressed without unresolved human coordination in
  the middle of implementation, it is not yet `ready`.

This principle complements the execution axes rather than replacing
them: it is a practical way to protect autonomous completion and clear
verification during issue drafting.

## Hidden human-dependency validation

Before publishing a `ready` issue, run a short pre-publication check for
hidden human dependency. Treat this as a routing aid, not a rigid
wording linter: the question is whether the work still depends on
unresolved human action, not whether the draft used one forbidden
phrase.

Ask these checks:

1. Does implementation require credentials, external access, hardware,
   or infrastructure that the executing agent cannot already reach? If
   yes, route the work to `blocked-by-human` unless that dependency can
   be front-loaded into a separate prerequisite issue.
2. Does any implementation step or acceptance criterion depend on a
   product, policy, or design decision that has not been made? If yes,
   route the work to `needs-decision`.
3. Do the acceptance criteria require subjective human approval instead
   of objective verification? If yes, rewrite the ready issue around
   measurable checks and back-load the optional review or publication
   judgment.
4. Does a roadmap narrative hide human-dependent work inside prose while
   the visible task list presents the item as execution-ready? If yes,
   preserve that work in an explicit stable bucket, approval-needed
   hold, or blocking issue instead of burying it in the narrative.
5. Is any dependency marker being used only to group related work or
   express preference order? If yes, remove the fake blocker and use
   task-list structure or sequencing notes instead. Keep dependency
   edges only for true start blockers.

Normal post-implementation code review, merge approval, or publication
choice does not by itself make an otherwise autonomous issue non-ready.
The ready issue should still carry its own objective verification even
when a human will look at the result afterward.

## Codebase-fidelity validation

Before publishing a `ready` issue, run a short pre-publication check that
the spec stays faithful to the existing codebase. Treat this as a routing
aid, not a rigid wording linter: A4.5 suitability triage is structural and
does not read the codebase, so a spec that contradicts established
semantics can still pass that gate and only surface the mismatch in
advisory review, costing extra review-fix round-trips.

Ask these checks:

1. When an issue reuses an existing identifier or field name, confirm the
   specified value matches that name's established semantics in the
   codebase — do not overload a name with a new shape or source.
2. Flag values that are mutable at runtime — specify a live read at the
   point of use rather than a one-time capture at construction.
3. When an issue proposes to **delete, replace, or "align to upstream"**
   code, first check the target for an intentional-divergence signal — a
   local change made on purpose to differ from upstream. If one is present,
   require the issue body to acknowledge that divergence and justify
   overriding it, rather than silently reverting hardening a consumer added
   deliberately (blind "resync to upstream" resets are a recurring
   Discover→plan-cycle waste when the divergence turns out to be
   intentional). The recommended portable signal is a canonical inline
   code-comment convention (for example a `do-not-revert:` / `idd-divergence:`
   marker) — it travels with vendored files and needs no repo-wide label
   taxonomy. An owner/CODEOWNERS marker or a referenced tracking issue may
   also serve, but the code-comment convention is the recommended default.
   Do not hard-code any single consumer's divergence-tracking mechanism.
4. When an issue drafts a **template resync or reimport** (pulling a
   newer `idd-template/` revision into a repository that already
   adopted IDD), consult the **upstream target ref's** copy of
   `docs/customization.md`'s "Documentation lint compatibility"
   section (added 2026-08-05, commit `6ceaa6dd`) before treating
   `.markdownlint.yml` / `.markdownlint-cli2.yaml` / `.cspell.config.yml`
   as unchanged. `docs/customization.md` is itself part of the
   imported core file set, so it resolves in an installed or adopter
   context once present — but an adopter whose prior import predates
   that commit has no such section in their own local copy yet, which
   is exactly the named gap to document in the resync issue, not a
   documentation-consultation failure. Either the target ref's
   `docs/customization.md` section or, from a source checkout of
   `idd-skill` itself, `idd-template/ONBOARDING.md`'s "Re-importing"
   section, documents the same named gap: an adopter's own rule
   customizations for these files need a by-hand merge into the new
   import rather than an assumed carry-forward, and
   `idd-onboard.mjs --import` reports a `blockedOverwrites` finding
   instead of silently keeping a same-named local file as-is, unless
   the import used `--force`, which still writes the file and reports
   it in the verdict JSON (`plan` as an `overwrite` entry,
   `filesChanged`, and `written`) but omits it from
   `blockedOverwrites` so the import is not blocked (observed
   2026-08-12/13 on an
   adopter repository, `setup.ubuntu`, kurone-kito/idd-skill#2012).
5. When drafting a resync issue's Background, run a mechanical
   placeholder diff against the **upstream `idd-skill` source
   repository's** `idd-template/` trees at the two relevant refs —
   never a tree inside the target/adopter repository itself, which
   retains no local `idd-template/` directory of its own once IDD is
   imported.
   - **Baseline ref.** Use the exact tag or commit SHA actually
     imported at the adopter's prior onboarding when it is explicitly
     recorded (for example in the original onboarding PR/commit
     message) or when the operator can confirm it directly. Do not
     infer it from the adopter's current file content: neither a diff
     against the import commit nor a reverse- or forward-substitution
     content-match against a candidate upstream tree reliably pins a
     single ref — onboarding substitutes placeholder values and
     permits legitimate post-substitution edits, an import commit's
     diff itself only records the already-transformed adopter
     snapshot, and more than one upstream commit can plausibly yield
     the same imported subset. When no explicit record or operator
     confirmation is available, report the baseline as
     unresolved/ambiguous in the resync issue itself rather than
     guessing one from content alone. Do not construct `v<iddVersion>`
     (`.github/idd/config.json`) as the baseline without this check:
     `iddVersion` is only a coarse signal and can be stale, an adopter
     still on `0.1.0` has no matching tag at all (`CHANGELOG.md`
     records that `0.1.0` predates the tag discipline), and an adopter
     who pinned a raw
     commit SHA at import time instead of a tag may have no
     `v<iddVersion>` tag matching what they actually imported either.
   - **Target ref.** The new release/ref the resync targets.
   - **Scope.** Intersect both trees with the Step 2 "File list" core
     file set as it reads **at the target ref**
     (`idd-template/ONBOARDING.md`'s generated file-list block) plus
     whichever optional profile artifacts the adopter selected, not
     the complete `idd-template/` tree — a file such as
     `idd-template/ONBOARDING.md` itself is never copied into an
     adopter, so reporting it as changed is noise. Use the target
     ref's manifest, not the baseline ref's: a file the target release
     newly added to the core or a selected profile is exactly the kind
     of change a resync issue must report, and the baseline ref's own
     manifest predates it.
   - **Token filter.** Compare each ref's own placeholder table in
     effect at that ref, not today's list applied to both — a
     placeholder added or removed between the two refs is itself
     exactly the kind of token-identity change this check exists to
     report, and reusing one ref's list for the other's tree would
     hide that change. At a ref from commit `e55ccd9c` (2026-05-12)
     onward, that table is Onboarding Reference — Placeholder Values'
     "Final placeholder meanings" table
     (`docs/onboarding/placeholders.md`). An older ref has no such
     file — the placeholders were documented directly inside
     `idd-template/ONBOARDING.md`'s own "Step 1C — Collect placeholder
     values" section instead; use that section's list as the
     allowlist for a baseline ref that old. Never match every
     `{{...}}`-shaped span unfiltered either way — an unrestricted
     match also catches ordinary GitHub Actions expressions such as
     `${{ github.token }}` in an imported workflow file.
   - **Excluded paths.** Skip `docs/onboarding/placeholders.md`,
     `docs/customization.md`, and `docs/onboarding/policy-decisions.md`
     — these deliberately keep `{{...}}` tokens literal to document
     the placeholder syntax itself, so diffing them misidentifies
     literal documentation as an outstanding substitution.

   Compare the actual token identities per changed file, not only the
   aggregate occurrence count: a same-count one-for-one placeholder
   swap changes what an adopter must substitute without changing the
   count. Name any file whose placeholder tokens changed, rather than
   asserting a file needs no placeholder substitution as an unverified
   default (observed 2026-08-12/13 on an adopter repository,
   `setup.ubuntu`, kurone-kito/idd-skill#2012).

## Alignment with A4.5 Suitability Gate

The IDD discover phase uses an A4.5 pre-claim suitability gate that
evaluates whether an already-published issue is suitable for autonomous
execution. This gate applies the same readiness buckets as the issue
authoring skill, **and adds new outcomes** for defects discovered at
discover time.

### Mapping authoring buckets to A4.5 outcomes

| Authoring Bucket     | A4.5 Gate Checks | Pass/Fail              | A4.5 Outcome       |
| -------------------- | ---------------- | ---------------------- | ------------------ |
| **ready**            | All 7 checks     | All pass               | **(pass)** → claim |
| **deferred**         | (not published)  | N/A during drafting    | Not yet evaluated  |
| **needs-decision**   | Check 5 or 7     | Fail on decision block | `needs-decision`   |
| **blocked-by-human** | Check 6          | Fail on autonomy block | `blocked-by-human` |
| **out-of-scope**     | Check 1          | Fail on scope check    | `out-of-scope`     |

### New A4.5 outcomes not in authoring buckets

The A4.5 gate may discover new issues that should have been caught
during drafting:

| A4.5 Outcome  | A4.5 Check | Meaning                               | Drafting Prevention                     |
| ------------- | ---------- | ------------------------------------- | --------------------------------------- |
| **unclear**   | Check 2    | Issue body is malformed or incoherent | Run coherence validation before publish |
| **invalid**   | Check 3    | Untrusted input or safety concern     | Screen for markers and code injection   |
| **duplicate** | Check 4    | Duplicate of existing work            | Run reuse-first check before publish    |

**Prevention during drafting**: Before publishing an issue, validate that
it will not fail A4.5 for coherence, safety, or uniqueness. If it would,
resolve the issue during drafting instead of publishing it.

### Mechanical pre-publish gate

Before publishing a drafted `ready` **orphan, roadmap, or sub-issue**
body (the linter's `orphan|roadmap|child` shapes; not the non-ready
buckets above), run the `audit-authored-issue` linter
(`scripts/audit-authored-issue.mjs` / `bin/idd-audit-authored-issue.mjs`)
against it when a helper runtime is available. It mechanically
re-checks a subset of the structural rules this document states in
prose — the autopilot-suitability marker's exactly-one/coherent-value
rule, the one-directional check that a suitability score of `1` carries
the configured `blocked-by-human` label (it does not check the reverse:
a non-`1` score paired with the label still passes), markerPrefix
consistency across every authoring marker, the declared shape's
required section headings, the roadmap-id/blocked-by dependency-marker
rules, and visible/hidden line agreement for the suitability and effort
footers.

It also emits one **advisory, warning-severity-only** finding
(`prose-dependency`): it flags an issue/PR reference (`#<digits>` or a
full GitHub issue/PR URL) used near coordination language (for example
"before", "after", "once", "until", "predates", "gate"/"gated",
"requires", "lands first") with no corresponding encoding for that
reference as one of three recognized forms — a `Blocked by #NNN` line,
a `Depends on #NNN` line, or a task-list checkbox item (`- [ ] #NNN`,
which counts regardless of which heading it sits under, so a roadmap's
own `## Tracks` membership list already satisfies this) — the
prose-only hard-precondition pattern the
[Hidden human-dependency validation](#hidden-human-dependency-validation)
check above warns about. A full-URL reference naming a different
repository is never flagged when the caller supplies the current
`owner/repo` (`--current-repo`, defaulting to `$GITHUB_REPOSITORY` in
CI) — a cross-repo dependency cannot be encoded with these
repository-local markers, so flagging it would recommend an impossible
fix; without that context a full-URL reference is still flagged by
default, unless its number happens to already match a local dependency
marker elsewhere in the body. A Markdown link's target may also carry
trailing content between the issue/PR number and the link's closing
paren — a URL fragment (`#issuecomment-123`), a trailing `/`, or a
quoted link title (`"..."` or `'...'`) — and is still recognized as one
link match rather than leaking its label's bare `#NNN` through to the
bare-`#` check. A local `owner/repo#N` shorthand (e.g.
`kurone-kito/idd-skill#4321`) is recognized too, but with the reverse
default from the full-URL case: it is flagged only when
`--current-repo` is supplied and case-insensitively matches
`owner/repo`; a different repository, or no `--current-repo` at all,
always excludes it. A reference-style Markdown link (`[text][ref]` with
a separate `[ref]: target` definition elsewhere in the body) is
recognized the same way as the inline-link form, including the same
`currentRepo` comparison; a `ref` with no matching definition falls
through to the bare-`#` check like any other unrecognized shape. A
quoted link title may contain a backslash-escaped quote matching its own
delimiter without ending the title early. An empty or whitespace-only
`--current-repo` (or `$GITHUB_REPOSITORY`) is treated the same as
omitting it, not as a known repository that can never match. A
nested/child list item's reference is evaluated together with its full
ancestor chain's coordination-language text instead of being scoped away
from it, while a same-depth sibling bullet still starts its own separate
scope. This holds for every nested child under a given parent, at any
depth -- not only the first. A continuation line resuming at an
ancestor's own indentation, after a deeper child has already opened, is
attributed to that ancestor rather than the deepest open child. A loose
list (a blank line between sibling items) preserves the same ancestor
scope across the blank line, as long as the following item's own marker
is no deeper than whatever is still open at the end of the preceding
item -- a same-depth sibling, or a resumption at a shallower ancestor's
own level -- and the preceding item ends in a list marker rather than
trailing plain prose (once plain prose follows the last marker, the
list reads as already having ended, so the blank line is not bridged).
A blank line directly followed by a more deeply indented marker is also
not bridged, to avoid grafting an unrelated item onto an open ancestor
as a false child. A
`prose-dependency` warning never flips `passed` to
`false` and never changes the linter's exit code; it prompts the author
to convert the prose into a proper dependency marker or consciously
confirm the reference is a mere breadcrumb.

```sh
node scripts/audit-authored-issue.mjs --shape <orphan|roadmap|child> \
  --marker-prefix <resolved-target-prefix> \
  --body-file <path-to-drafted-body> [--label <label>]...
```

**Always keep `--marker-prefix`, and always replace the placeholder**
with the resolved target prefix before running the command — in this
source repository that value is `idd-skill` (already the
`.github/idd/config.json` default here, so the flag is redundant only
in this one repository), but auditing any other repository requires
substituting that repository's own prefix. Never copy the literal
`idd-skill` value into another repository's audit command. Omitting the
flag entirely is unsafe everywhere: without it, the linter falls back
to reading `.github/idd/config.json` from the current working
directory and silently defaults to `idd-skill` when that file is
missing or unreadable, producing a false pass or fail against the
wrong prefix instead of an error. See the bundled `contract.md`'s
[Target marker prefix](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#target-marker-prefix)
section for the adopter-facing prefix-resolution rule.

**No helper runtime available (`instructions-only` profile).** The
linter cannot run without Node.js and the vendored `scripts/`
directory, and `instructions-only` is a first-class supported fallback,
not a waiver — manually re-verify the same checks against this
document's prose and the [Draft schemas](#draft-schemas) before
publishing.

A `passed: false` report (or non-zero exit, or a failed manual
re-verification) means the draft is not ready to publish yet. The
linter (or its manual equivalent) is a mechanical structural check, not
a substitute for the judgment-based checks above (human-dependency
isolation, codebase fidelity, reuse-first) — passing it is necessary,
not sufficient, for `ready`. See the bundled `contract.md`'s
[Mechanical pre-publish gate](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#mechanical-pre-publish-gate)
section for the adopter-facing version of this rubric.

## Authoring label lifecycle

The issue authoring skill must use the configured authoring label as
both the **draft marker** for held issues and the **claim-suppression
lock** that keeps Discover from selecting them, while it creates or
updates issues. The label name comes from
`issueAuthoring.authoringLabelName`, with `status:authoring` as the
distributed default.

`src/scripts/audit-authored-issue.mts`'s `authoring-owner-marker-trail`
check mechanically verifies, from pre-fetched comment data a caller
supplies, that an authoring-labeled issue carries a valid owner marker
and (for a newly created issue) the publication-token trail this
section defines -- structural/shape checking only, not the live
trust/permission re-verification the runtime protocol below still
owns. The module stays network-free; no caller currently wires it into
the publish flow below (Refs #2621, non-blocking).

During Stage 1 (author-and-publish), the skill must ensure the label
exists in the target repository before first use. For the bundled
GitHub CLI publication flow, create a missing label with
`gh label create` before applying it. Failure to create or apply the
label is a publishing blocker, not a warning.

For existing issues, apply the authoring label before updating issue
content. For new issues, require a capability-checked publication command
that creates the issue with the authoring label atomically and carries an
exact hidden publication token for target, anchor, set, and session, such as
`gh issue create --label` when the bundled GitHub CLI flow can use it. If the
target runtime cannot provide that operation, stop before creating the issue.
Never intentionally create an unlabeled issue for the
Stage 1 set. If an allegedly atomic request unexpectedly returns an
unlabeled issue, re-fetch its labels, body, current `claimed-by` state, and
paginated owner-marker log before closing. If a trusted claim or owner marker
from another session or set is present, do not close or overwrite the exposed
issue; report the ownership conflict and stop. If no competing claim is
present, apply and verify the authoring label as a safe hold, then re-fetch the
claim and owner logs again before closing. If that hold or final re-read cannot
be verified, leave the issue open and report the recovery hold. Deletion needs
admin permission the authoring agent typically lacks (and
`docs/permissions.md` forbids for normal IDD), so it is not the default
recovery path.

The exact hidden publication token is an HTML-first body line carried by the
atomic create:

```html
<!-- <marker-prefix>-authoring-publication: target=<opaque-target-id>; anchor=<opaque-anchor-id>; set=<opaque-set-id>; session=<opaque-session-id>; token=<opaque-publication-token> -->
```

The originating Stage 1 hold uses this append-only publication-intent record:

```html
<!-- <marker-prefix>-authoring-publication-intent: target=<opaque-target-id>; anchor=<opaque-anchor-id>; set=<opaque-set-id>; session=<opaque-session-id>; token=<opaque-publication-token>; journal=<owner>/<repo>#<number>; issue=<owner>/<repo>#<number>|none; actor=<trusted-marker-actor>; state=<pending|member|cleanup|abandoned> -->
```

`issue` is the returned canonical issue identity or `none`. Append
`state=pending; issue=none` before creation, then append the returned identity
while it remains `pending`, append `member` only after the owner marker is
verified, and append `cleanup` before any safe-close mutation. Append
`abandoned` only after closed/label-absent verification. On resume, paginate
the hold log and select the latest valid record for the exact token tuple;
missing, conflicting, or out-of-order records fail closed, while `pending`
and `cleanup` remain recovery holds.

`journal` is the durable record location. For an existing set, use the
verified originating Stage 1 hold; for a standalone set with no existing issue
or anchor, use a pre-existing repository-level authoring journal target
designated by repository policy. Do not create that journal as part of the
same set. If neither location exists or its identity cannot be verified, stop
with `blocked-by-human` before creating any target. On every paginated replay,
require `actor` to equal the API author and verify that actor is a trusted
marker login with the required write-level permission or configured bot/app
trust. An untrusted, malformed, or conflicting exact-token record is not valid
evidence; fail closed and retain the hold.

Generate the opaque target/anchor IDs and token before creation because issue
numbers are not yet known. Before issuing the create, persist those
preallocated IDs, the exact token, and `state=pending` in that journal. After a
successful create, attach and verify the returned issue
identities on that pending record before appending the owner marker. If the
pre-create hold write cannot be verified, do not create; if the post-create
identity attachment cannot be verified, leave the returned issue held for
recovery. Transition that record to `member` only after the owner marker is
verified, or to `abandoned` only after the verified safe close and label
removal. On resume, match the exact token and persisted identities; an
incomplete scan or state mismatch is a recovery hold.

Immediately after a new issue is created and its authoring label is applied,
append a `mode=acquire` owner marker with the current set ID and a new owner
token. Re-fetch labels, body, and owner comments before treating the issue as
a set member. If marker append or verification is uncertain, reconcile the
returned comment ID and the paginated owner-marker log with bounded retries
before closing. If a trusted marker is found, retain the label and recover or
reopen the issue as a set member. Otherwise re-fetch labels, body, current
`claimed-by` state, and the paginated owner-marker log; if that final read
proves no competing claim or owner marker, append `state=cleanup` before
closing the issue or removing its authoring label. Re-fetch and verify
closed/label-absent state, then append `state=abandoned`. If any disposition or
cleanup read is uncertain, retain `state=cleanup`, leave the issue held, and
report the recovery hold.

An atomically labeled publication is not set membership until its owner marker
is verified. Persist each returned target identity in the durable journal before
appending the marker. On resume, reconcile recorded
identities and only issues carrying this set's exact publication token; an
incomplete scan or unmarked match is a recovery hold, so never infer membership
or completion from the shared label alone.

### Per-target ownership and conflict handling

The configured authoring label is a shared **claim-suppression lock**, not
a session owner token. Before editing an existing issue or roadmap, take a
fresh target snapshot and resolve its complete claim state, including trusted
forced-handoff successors and activation-nonce winners, plus its active
`claimed-by` and open-PR state. A trusted forced-handoff successor is active
even without a new `claimed-by`; any active execution is a conflict, so do not
establish the hold. Apply the label if it is absent, and append a hidden owner
comment using the resolved marker prefix:

```html
<!-- <marker-prefix>-authoring-owner: target=<owner>/<repo>#<number>; anchor=<owner>/<repo>#<number>; mode=acquire|resume|bootstrap|heartbeat|release|release-guard|release-complete; owner=<opaque-owner-token>; set=<opaque-set-id>; session=<opaque-session-id>; body-sha256=<64-lowercase-hex|none>; snapshot-sha256=<64-lowercase-hex|none>; supersedes=<opaque-owner-token|none> -->
```

_Issue-authoring ownership marker. Do not edit or delete._

The companion uses the same `body-sha256` and `snapshot-sha256` semantics as
the portable owner protocol. Target markers hash the exact UTF-8 body from the
fresh read immediately before posting; anchor-only `release-guard` uses
`body-sha256=none`, while anchor-only `release-complete` carries the required
canonical set snapshot digest. Persist the per-target body digests and
snapshot inputs in the originating hold and re-fetch/recompute them before
accepting completion. New markers missing these fields are not valid for a new
generation; legacy markers are migration input only and cannot prove completion.

Verify the returned comment ID and body after posting, then re-read the active
claim and open-PR state again. If execution began during acquisition, stop
without editing and leave the verified hold for explicit recovery.

Owner tokens are per target: never compare a child target's `owner` value
literally with the anchor's `owner` value. Every owner-marker log read for a
target or anchor must use paginated issue-comment retrieval (for example,
`gh api --paginate` or an API equivalent) and deterministic GitHub comment
order (`created_at`, then comment ID); never rely on a single API page.

Append this HTML-first body with a direct JSON `POST` to the issue-comments
endpoint; do not rely on `gh issue comment` or `gh api -f body=` for the owner
marker. Verify the returned comment ID and body after posting.

Resolve the set anchor before appending any target marker. `anchor` records
the canonical owner/repository/issue identity of that anchor; the anchor's
own marker uses its `target` as the `anchor`, and every other marker in the
set repeats the same value. A missing or mismatching `anchor` makes a marker
invalid for set membership, resume, or release. A legacy marker without an
anchor cannot resume a multi-target set; when no parent roadmap identifies the
anchor, stop and bootstrap a fresh explicitly designated anchor instead of
choosing a different lead implicitly.

Only a trusted target-repository marker actor makes a marker valid: the
current authenticated actor after posting and verifying it **and** passing a
Write/Maintain/Admin permission check, a configured trusted bot or app, or an
explicitly enabled Write/Maintain/Admin collaborator. Comment-only access is
insufficient. If permission cannot be verified and no explicit bot/app trust
applies, ignore and report the marker; syntax alone never grants ownership.
For an owner marker that must support a later session, the author's trust must
also be re-evaluable from a durable policy: a login in `trustedMarkerActors`, a
configured trusted bot or app, or an explicitly enabled collaborator whose
current permission can be re-read. The current-session actor path is
provisional and cannot make a historical marker trusted by itself. Without a
durable trust source, leave the label and hold in place and report recovery;
do not treat the marker as set membership or ownership evidence.
For `acquire`, `bootstrap`, and `resume`, `owner` is a newly generated
opaque per-target owner token; `supersedes=none` for `acquire` and
`bootstrap`, while `resume` names the prior owner token. For `release`, keep
the current owner token in `owner` and set `supersedes` to that same current
owner token; `supersedes=none` is invalid for a release marker.
For `heartbeat`, retain the current owner, set, and anchor, set `supersedes`
to that same owner token, and do not open or close a generation; it only
renews the current owner's freshness.
`release-guard` is valid only on the set anchor. It retains the anchor's
current owner, set, anchor, and session, and sets `supersedes` to that owner
token. Append and reconcile it after release-marker preflight but before the
first label removal. It is the Discover-visible guard for a provisional set
release: it does not close any generation, and it remains active until the
anchor's durable `release-complete` marker is reconciled.
`release-complete` is valid only on the set anchor. It retains the anchor's
current owner, set, anchor, and session, and sets `supersedes` to that owner
token. Append and verify it only after every target's release marker and label
removal has been verified. It is the durable terminal event for the set: a
later reapplication of the authoring label must start a fresh set generation
rather than resuming the completed set.
Within an open generation, the first valid acquisition, bootstrap, or
resume marker by GitHub comment order wins. A
`resume` marker opens a new generation only for the exact interrupted set
and matching prior owner token. A `release` marker must match the current
owner and set, but remains provisional while its set release is in
progress; an individual label removal never closes that target's
generation. Only after a fresh re-read verifies every target's release marker
and label removal and the anchor's `release-complete` marker does the set-level
release close all target generations, after which a later `acquire` starts a
new generation. The
active generation's freshness is the GitHub `created_at` of
its latest trusted acquisition, bootstrap, resume, or heartbeat marker; a
resume marker refreshes that clock, and the label event alone never
supersedes a fresh owner marker.
The current generation's winner owns the target; any other session must stop
without editing and leave the label in place. Owner comments are append-only
and must not be edited or deleted.

For a new Stage 1 set, generate one opaque set ID and reuse it in every owner
marker for that set. When resuming an interrupted set, recover and verify its
persisted set ID from the exact trusted owner markers and reuse it instead of
generating a replacement. Persist the resolved anchor identity in every marker
as well. Before resuming, enumerate the anchor's `## Tracks` and a
repository-wide paginated issue-comment scan scoped to trusted owner markers
whose exact `anchor` and `set` match; merge the results by comment order and
block if enumeration is incomplete. These append-only comments are the durable
set, anchor, and target membership record; a resume may include only targets
whose valid markers identify that exact set and anchor. Never infer set
membership or the anchor from the shared label alone.

A non-anchor target cannot prove that its previous set finished from its local
owner-marker log alone. Before accepting a fresh `mode=acquire` for a child
whose prior generation has a `mode=release` or `mode=release-guard` marker,
follow its exact persisted `anchor` identity and fetch that anchor's paginated
owner-marker log. Require a trusted `mode=release-complete` marker for the
exact anchor/set/session generation represented by the child's current release
marker, including the current anchor owner for that release generation; never
accept an older or newer set's completion. Owner tokens are per target, so do
not compare the child owner token literally with the anchor owner token. If the
completion marker is absent, malformed, or cannot be fetched conclusively,
treat the prior release as interrupted: do not acquire the child as a new set,
and instead resume that exact set or leave its hold in place. A child log, an
absent label, or a session-local read is never completion evidence. Once the
anchor completion is reconciled, the old set is closed and a new acquisition
may start a new generation.

Acquire one set anchor before acquiring any other target: when the set has a
parent roadmap, first publish a valid roadmap shell under the authoring hold,
with all required roadmap headings/markers and an empty `## Tracks` list
allowed only until child issue numbers exist; then acquire and verify that
roadmap as the set anchor. Only after that anchor is verified may the session
publish and acquire child targets, and it must wire their real numbers into
`## Tracks` before release. When no parent roadmap exists, use the designated
lead target as the anchor. The anchor winner serializes acquisition for the
whole set; no session may publish or acquire children independently. Before
each child acquisition or resume, append and verify a same-owner heartbeat on
the anchor, re-fetch the anchor's paginated log, and require its current owner
token, set, anchor, and session. Append the child marker only after that
validation, then immediately re-fetch both anchor and child and require the
same anchor ownership; if either read changes, leave the child hold in place
and stop rather than forming a split set. If any target cannot be acquired
under that anchor, stop all body and relationship edits, leave labels and
append-only markers in place, and require an exact verified resume of that set
rather than allowing a split ownership set.
After each `acquire`/`resume`/`bootstrap` marker POST, wait the configured
`claim.verifySettleDelay`, replay the full paginated log, and choose the
winner by deterministic comment order; an immediate local read never
authorizes edits. Apply the same settle delay and full paginated replay after
every heartbeat before it authorizes an edit or label removal.

Immediately before every body or roadmap relationship update, re-fetch both
the target and the set anchor (the same fresh snapshot serves both roles when
the target is the anchor). Require each target's expected owner token
independently, plus the same set, anchor, and owning session, and require the
expected body/label snapshot on the edited target to remain unchanged. Also
re-read its active `claimed-by` and open-PR state; any active claim or open PR
is a conflict. An unexpected change, competing owner, malformed owner marker,
or inability to prove a unique owner on either target is a conflict: do not
overwrite the target, leave the authoring label in place, and record a safe
alternative.
Prefer an atomic acquisition helper when the target runtime provides one;
otherwise this append-only conflict check is mandatory, including for
`instructions-only` installs.

After that conflict check and immediately before the body or relationship
mutation, append and verify a trusted `mode=heartbeat` marker for the set
anchor first, then re-fetch and verify its current owner, set, anchor, and
session. Only after the anchor renewal succeeds, append and verify the edited
target's heartbeat when it is distinct, then re-fetch both and require each
target's expected owner token independently, plus the same set, anchor, owning
session, and expected target snapshot. If either heartbeat cannot be posted or
verified, or a newer owner appears, stop without editing. A heartbeat never
starts a new generation and never authorizes release.

A target already held by another set is unavailable. A later session may
resume only when the invocation identifies the exact interrupted set and
the hold is past `issueAuthoring.authoringStaleAge`; append a `mode=resume`
owner marker with a new owner token and `supersedes` value matching the prior
owner token before repeating the acquisition check. For a stale held target
with no valid owner marker, append a trusted `mode=bootstrap` marker with the
current set ID, a new owner token, and `supersedes=none`; this starts a new
generation and is not evidence of any prior set membership. The first valid
bootstrap marker wins. Staleness alone never authorizes takeover: use the
latest trusted generation marker's GitHub `created_at` for marked targets, and
the label event only for legacy-unowned bootstrap. A competing active marker
still stops the session.

Publishing under this label needs no separate user approval: once a
drafted `ready` body passes the mechanical `audit-authored-issue` gate
and the critique pass, the skill publishes it directly (see
[Approval boundary](#approval-boundary) below for the one exception).
The held issue **is** the draft — in-place body edits, roadmap
relationship wiring (publish/acquire the roadmap anchor first, then
publish/acquire children and wire their real issue numbers), and re-lint of
already-published bodies all happen on
the published issue itself, under the same label, rather than in a
session-local buffer a later session cannot see.

These guards keep partially published issue sets visible to the IDD
discover guard while the full set is still being wired. If a session
is interrupted before the set is stable, leave the label and owner markers
in place. The label suppresses Discover while the markers preserve set
identity and target membership for a later verified resume; a later session
must not infer either from the label alone.

Remove the label from all published issues only after: the release
checklist passes — every child issue is referenced from its parent roadmap's
`## Tracks` list, no unsubstituted placeholder remains in any published
body, and the `audit-authored-issue` linter (or its manual fallback) is green
on every published body in the set — and the user explicitly requests
release from the authoring hold. Keep the set anchor held until every other
target's label removal is verified, and remove the anchor label last. First
re-fetch owner comments during release-marker preflight. If a valid
current-owner/set `mode=release` marker already exists, reuse the earliest
matching GitHub comment ID; otherwise append one with `supersedes` equal to
the current owner token, re-fetch to verify it, and record its comment ID.
Complete that preflight for the whole set before removing any label. A retry
of an open generation must reuse the recorded or earliest matching marker and
never append an indistinguishable duplicate. Then, before removing any label,
append or reuse the anchor-only `mode=release-guard` marker and re-fetch the
anchor's paginated owner-marker log with bounded retries, requiring the exact
current owner, set, anchor, session, and marker body. If that guard is not
found conclusively, leave all labels in place and stop. The guard suppresses
Discover for the whole set during the provisional label-removal window; it
does not close the set. Then, immediately before each label removal, append
and verify the set anchor's `mode=heartbeat` first, re-fetching it and requiring
its current owner, set, anchor, and session. Only after that succeeds, append
and verify the target heartbeat when it is distinct (one marker serves both
roles when they coincide), then re-fetch both and require each target's expected
owner token independently, plus the shared set/anchor/session, recorded
release-marker comment, and expected label/body snapshot. Remove non-anchor
labels one target at a time and re-fetch each result. After the
final anchor label removal is verified, re-fetch every target and verify its
current release marker, absent label, and expected body snapshot; any drift
leaves the set open and prevents completion. Then reuse or append the
anchor-only
`mode=release-complete` marker and record its comment ID. Reconcile that ID
and the paginated anchor log with bounded retries; a successful POST or
verification timeout is inconclusive. If the trusted marker is found, keep
labels absent and close the set. If a complete fresh read conclusively proves
that no trusted marker was appended, reapply the authoring label to every
target and leave the set generations open. If reads remain inconclusive, keep
the release guard and current labels/state in place, leave the set held, and
record a recovery hold. Never infer marker absence or roll back from a
verification timeout. Do not infer completion from absent labels or a
session-local read. Treat every release marker, heartbeat,
label removal, and completion marker as provisional: no target generation
closes until every target's release marker and label removal are verified and
the durable completion marker is reconciled, at which point the set-level
release closes all target generations together. If any later mutation or
verification fails, re-fetch all already processed targets,
retrying a failed post-removal read with a bounded fresh read, restore their
labels while the current owner/set still match, and verify the restored set
state; leave every target generation open and stop. If restoration cannot be
completed or a newer owner has appeared, record a set-level recovery hold and
never claim a partial release. This release checklist plus the user's
explicit request together form the single approval boundary in this contract.

Removing the authoring label releases the Discover guard and
authorizes IDD execution for the released issues. Do it only as part
of that explicit release request; nothing in this contract removes the
label or starts Discover, Claim, and Work on its own.

## Reuse-first issue policy

Before creating any new issue, the skill should check whether the work
already has a suitable home.

**Claim-state precondition (check this first).** Before reusing or
extending any existing issue, determine whether it has an active claim
(latest valid `claimed-by` newer than the configured `claim-stale-age`,
distributed default 24 h) or an open PR, or is otherwise actively
executing. If so, the skill **must not edit its body** — the working
agent snapshots the body into its B2 plan and never re-reads it, so a
post-claim edit is silently lost. A separate comment is allowed (never
an edit or append to the body) but must not be relied on to be picked
up; cover the change with a follow-up issue (or roadmap track), and the
skill **should** post a cross-reference comment on the claimed issue.
Stale or reclaimable claims (older than `claim-stale-age`) are exempt,
since the next claimer re-reads the latest body.

Then apply these checks in order:

1. If an existing open issue already matches the task and only lacks the
   new schema details, extend that issue instead of cloning it.
2. If an existing open roadmap already owns the initiative, add or
   refine task-list entries there instead of creating a competing
   umbrella.
3. If an existing issue is close but too broad, split follow-up work out
   of it rather than widening the original issue further. When the
   issue being split is itself a roadmap child, the skill should update
   the parent roadmap's `## Tracks` list in the same authoring action —
   add the new issue's link and adjust any sequencing notes (a short
   dated note is the observed good pattern) — subject to the
   claim-state precondition above applied to the roadmap issue's own
   claim/PR state, and record the provenance in the new issue's body
   (e.g., `Split out of #<n>`).
4. If an existing issue has an active claim, an open PR, or is
   otherwise being actively executed, do not edit its body or repurpose
   it (see the claim-state precondition, which exempts stale/reclaimable
   claims); create a follow-up issue or extend the roadmap around it
   instead.
5. Create a brand-new issue only when no existing issue can absorb the
   work without harming ownership, clarity, or reviewability.

The skill should report when it reuses, extends, or declines to reuse
an existing issue so a later session can follow the reasoning.

**Recent-window scan for just-discovered problems.** The checks above
assume the work already has a candidate home to reuse or extend. When
instead authoring an ad hoc issue for a problem **just discovered**
during the current session — a build-breaking regression noticed
mid-session, for example, rather than a task drafted from an existing
backlog — the skill should run a recent-window duplicate scan
immediately before publishing: list the newest issues regardless of
state and check whether a concurrent session already authored the
same problem.

```sh
gh issue list --repo <owner>/<repo> --state all --limit 20
# or, scoped to a recency window:
gh issue list --repo <owner>/<repo> --state all --search "created:>=<YYYY-MM-DD>"
```

A hit routes back into the checks above: extend the discovered issue
instead of publishing a duplicate. When the race slips past this scan
anyway (near-simultaneous discovery), the outcome is **anticipated and
self-resolving, not a coordination failure**: both sessions proceed
independently through their own claim and implementation cycle;
whichever PR merges first wins; the other session manually verifies
the fix already landed on the default branch, then closes its own
issue and (unmerged) PR as superseded, citing the verifying evidence.
This is the same manual verify-then-close judgment call the execution
loop's B2.0 supersession re-check (`idd-work.instructions.md`) applies
after claim — this scan only adds an earlier, pre-publish checkpoint.
A fast enough race can still surface even after B2.0; when it does, it
resolves the same way.

## Decomposition and roadmap planning rules

The skill should identify atomic execution units first, then decide how
to package them.

### Keep work as an orphan issue when all are true

- one atomic issue is enough to complete the request
- limited scope, clear verification, and autonomous completion all pass
- no roadmap-level dependency or parallel track is needed
- the work is unlikely to require multiple agent sessions
- the target repository discovers orphan issues — `issue-scope` is
  `roadmap-first` (the default; orphans are the fallback when no roadmap
  work is startable) or `orphan-first` — and any configured
  `orphan-first-policy` approval step can happen after drafting; or the
  draft explicitly tells the operator to switch to a discovering mode
  before starting the execution loop (a `roadmap`/roadmap-only
  repository does not discover orphans)

### Create a roadmap when any are true

- the request requires more than one autonomous issue
- the work has a dependency chain that should be visible before
  execution starts
- two or more tracks can proceed in parallel and should be coordinated
- the request is likely to span multiple sessions or handoffs
- some tasks are ready now while others should be explicitly deferred,
  blocked, or sequenced behind earlier work

### Create sub-issues when a roadmap exists

Each ready execution unit under the roadmap should become its own
sub-issue when:

- it can be reviewed independently
- it has its own acceptance criteria
- it can be claimed by one agent without owning the whole roadmap

### Avoid these anti-patterns

- do not create a roadmap only because a description is long
- do not keep multiple unrelated atomic changes in one sub-issue
- do not create an artificial serial chain when sibling tasks could be
  reviewed and verified independently
- do not split one natural, cohesive change into artificial sibling
  issues only to widen parallel execution
- do not use hidden dependency markers to group active sub-tasks under
  an open roadmap
- do not hide low-confidence work by omitting it from the output

## Dependency minimization

Encode a dependency edge only when it reflects a true correctness,
availability, or ordering constraint.

- keep independent sibling tasks as roadmap task-list entries, with
  short sequencing or parallelization notes when that helps reviewers or
  later agents
- use visible or sequential dependency markers only when the issue
  cannot start safely until the dependency resolves
- do not create an artificial serial chain when sibling tasks could be
  reviewed and verified independently
- do not split one natural, cohesive change into artificial sibling
  issues only to widen parallel execution
- whenever an issue's own narrative states that its work cannot safely
  start until another named issue resolves, encode `Blocked by #NNN`
  for that issue rather than leaving the constraint as prose-only
  sequencing. Discover and A4.5 honor the hard `Blocked by` edge, not
  a narrative "runs after #NNN" note: A4.5 Actionability inspects the
  body, not completability, so a narrative-only dependency reports the
  issue startable the moment its other filters pass, and claiming it
  then means either violating the asserted constraint or doing the
  referenced issue's unresolved work first. This rule is general, not
  limited to a fixed list of cases; the two recurring patterns below
  are illustrative, not exhaustive
- **example — docs or operator-help child that documents behavior
  implemented by sibling issues**: encode `Blocked by #NNN` for those
  implementation issues (or otherwise sequence the docs child to run
  after they merge) so the documentation is written against **shipped**
  behavior. Describing designed-but-unshipped behavior in the present
  tense is a recurring advisory-review-thrash pattern; "describe shipped
  behavior" is a true ordering constraint, so this edge is consistent
  with the encode-only-a-real-constraint rule above
- **example — finalize or verify track whose acceptance criteria
  assert state produced by sibling implementation tracks**: encode
  `Blocked by #NNN` on **each** such sibling rather than stating the
  ordering only in prose. A prose-sequenced finalize track reports
  startable the moment its build foundation closes, and claiming it
  then means either failing its acceptance criteria or doing
  the siblings' unmerged work
- once a `Blocked by #NNN` / `Depends on #NNN` reference resolves —
  the referenced issue closes **with its required outcome verified as
  delivered**, not merely closed as not-planned, superseded without an
  equivalent implementation, or later reopened — revisit the blocked
  issue's own body and remove that reference and its explanatory wait
  prose, rather than leaving it in place as inert history, but keep
  any prose identifying the delivered artifact or interface this
  issue's own scope depends on. A line naming several references
  (`Blocked by #10, #11`) keeps the still-open ones — remove only the
  resolved reference, and remove the whole line only once every
  reference on it has resolved. When the
  underlying constraint is not actually met, reopen the prerequisite
  issue or repoint the dependency line at an open replacement issue
  instead of leaving a stale edge in place:
  `discover-readiness-check` blocks only on an `OPEN` referenced
  issue, regardless of why it closed, so retaining the edge alone does
  not keep the dependent issue blocked. (Observed 2026-08-13 on issue
  #1994's `Blocked by #1985` note, after #1985 closed; reported in
  #2002.) This cleanup is more than tidiness: stale wait-explaining
  prose can trip `checkVerifiability`'s subjective-approval heuristic
  in
  `suitability-triage.mts`, which matches either a single line
  combining a subjective-subject word (`maintainer`, `stakeholder`,
  `human`, `opinion`, `judgment`/`judgement`, `ux`, or `feel` — not
  only authority nouns) with a gate word (`approval`, `sign-off`/
  `signoff`, `decision`, or `preference`), or a gate word followed
  within 80 characters — including across lines — by a
  subjective-subject word.
  This still fires even though the structural dependency filter
  already correctly treats the closed reference as unblocking

When an issue keeps a dependency edge, justify each dependency edge in
the surrounding issue body and confirm that the split still preserves
natural cohesion.

## Dependency encoding rules

The skill must encode dependencies in forms that the discover phase can
read safely.

**Prefix-first.** The examples below use this source repository's own
configured prefix, `idd-skill`, literally — this document describes
this repository's own convention. Resolve the target repository's
marker prefix before emitting any authoring marker in an installed
bundle; never assume `idd-skill` outside this source repository. A
prefix the operator already confirmed during an onboarding hearing
(Steps 1A-1C of `idd-template/ONBOARDING.md`) counts as a resolved
value under "user context" — even before it is committed anywhere in
the target repository's tree — and does not require asking again. See
the bundled `contract.md`'s
[Target marker prefix](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#target-marker-prefix)
section for the adopter-facing, prefix-parameterized version of this
rule.

### Roadmap identity marker

Every roadmap issue must include exactly one hidden roadmap marker in
its body:

```html
<!-- idd-skill-roadmap-id: <roadmap-id> -->
```

The `<roadmap-id>` should be stable, descriptive, and unique within the
repository.

### Roadmap membership

Ready sub-issues that belong under an active roadmap should be linked
from the roadmap body through task-list entries:

```md
- [ ] #123
- [ ] #124
```

This is the primary grouping mechanism for active roadmap work.

### Issue-to-issue dependencies

When one issue depends on a specific issue, use a visible dependency
line in the body:

```md
Blocked by #123
```

### Sequential roadmap dependency

Use a hidden `idd-skill-blocked-by` marker only when an issue must wait
for a separate roadmap to close before it becomes startable:

```html
<!-- idd-skill-blocked-by: <roadmap-id> -->
```

Do not use `idd-skill-blocked-by` to group children under the roadmap
that already owns them. Grouping belongs in the roadmap task list.

## Nested roadmap nodes

Use a nested roadmap when one roadmap track needs its own coordination
boundary, active child list, or multi-session handoff. A nested roadmap
is still a roadmap node, not a normal execution candidate.

Authoring rules:

- reference the nested roadmap from the parent roadmap task list instead
  of hiding it in prose
- give the nested roadmap its own roadmap marker and `## Tracks` section
  that links the active child work it coordinates
- treat the nested roadmap as a coordination/audit node for discovery
  and roadmap audit; do not draft it as normal A3/A4/A5 execution work
- use two-level or three-level nesting only when the intermediate
  roadmap has its own active child work or handoff boundary
- do not use `Blocked by #NNN` or
  `<!-- <marker-prefix>-blocked-by: ... -->` only to group leaf issues
  under an active nested roadmap; reserve those encodings for true
  execution dependencies or sequential roadmap dependencies between
  separate roadmaps

Validation expectations:

- each nested roadmap node is linked from its parent roadmap task list
- each nested roadmap node links its own active child work from its body
- cycles, duplicate references, and closed intermediate roadmaps with
  hidden open descendants must be surfaced as validation failures or
  explicit follow-up notes, not silently normalized away

## Draft schemas

The following schemas are normative. The skill may add small
project-specific notes, but it should not omit the required structure.

### Orphan issue schema

Use an orphan issue for one ready, autonomous task that does not need a
roadmap and will remain discoverable under the target repository's
`issue-scope` setting.

Required content:

- title with a concise user-facing summary
- `## Background` or `## Goal`
- `## Proposed change`
- `## Acceptance criteria`
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker; see
  [Autopilot-suitability score](#autopilot-suitability-score))
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Optional content:

- `## Candidate files`
- `Blocked by #NNN`
- `## Notes`

Validation expectations:

- no `idd-skill-roadmap-id` marker
- no `idd-skill-blocked-by` marker
- acceptance criteria are testable or otherwise explicitly verifiable
- scope is narrow enough to pass the IDD viability gate as a single
  issue
- the draft preserves discoverability by using a repository that
  discovers orphans (`issue-scope: roadmap-first`, the default, via the
  orphan fallback, or `orphan-first`), or by surfacing that
  configuration change before the operator starts the Discover -> Claim
  loop
- when the repository uses `orphan-first-policy: maintainer-approved`,
  the draft includes a post-publication maintainer approval step after
  the final title, body, and generated plan are stable
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate for the
  `orphan` shape (see [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

### Roadmap issue schema

Use a roadmap issue when a request needs multiple issues, visible
sequencing, or parallel tracks.

Required content:

- title that describes the umbrella initiative
- `## Goal`
- `## Why this matters` or `## Background`
- `## Tracks`
- `## Success criteria`
- one `<!-- idd-skill-roadmap-id: <roadmap-id> -->` marker
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Recommended content inside `## Tracks`:

- track headings for major streams of work
- `- [ ] #NNN` task-list entries for ready child issues
- short sequencing or parallelization notes when they reduce collisions

Validation expectations:

- every active child issue or nested roadmap node is referenced from the
  roadmap body
- the roadmap explains why multiple issues exist instead of hiding them
  as narrative text
- dependency notes distinguish between active grouping and true
  sequential blocking
- each dependency edge is justified and preserves natural cohesion
- nested roadmap entries stay identifiable as coordination/audit nodes
  instead of normal execution leaves
- the roadmap can survive multi-session handoffs without relying on
  private session memory
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate for the
  `roadmap` shape (see [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

### Sub-issue schema

Use a sub-issue for one atomic execution unit that belongs under a
roadmap.

Required content:

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Optional content:

- `## Candidate files`
- `Blocked by #NNN`
- `<!-- idd-skill-blocked-by: <roadmap-id> -->` when a separate roadmap
  must close first
- `## Notes`

Validation expectations:

- the issue is referenced from its parent roadmap task list
- acceptance criteria are locally verifiable
- any dependency marker is resolvable, intentionally chosen, and
  justified
- the issue can be claimed independently without absorbing sibling work
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate using
  `--shape child` (the linter's shape enum names this schema `child`,
  matching `contract.md`'s "Child issue under a roadmap"; see
  [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

## Drafted issue prose language

A drafted issue's human-readable prose sections — `## Background` (or
`## Goal`/`## Why this matters`), `## Proposed change`,
`## Acceptance criteria`, and the roadmap shape's `## Tracks` /
`## Success criteria` — follow the target repository's resolved
`authoringLanguage` value from `.github/idd/config.json`:

- A fixed BCP-47-shaped tag (for example `en`, `ja`, `fr`) makes the
  drafted prose use that language.
- The literal `match-source` matches the operator's live conversational
  language during an interactive/hearing issue-authoring session.
- An absent field defaults to English, codifying today's actual
  emergent behavior.

See
[Authoring Language](https://github.com/kurone-kito/idd-skill/blob/main/docs/customization.md#authoring-language)
for the full field definition.

**Marker/footer carve-out**: this never changes any HTML-comment
marker's machine-parsed format, nor any visible-line mirror whose exact
wording a mechanical regex parses. Concretely, the autopilot-suitability
and effort footers' visible lines (`_Autopilot suitability: N / 5 ...`
/ `_Effort: S | M | L ...`) must stay in their exact canonical English
wording regardless of `authoringLanguage`, since `audit-authored-issue`
matches them against a fixed English-phrase regex.

## Validation checklist for drafted output

Before reporting or publishing issue drafts, the skill should verify:

- each execution-ready issue passes limited scope, clear verification,
  and autonomous completion
- no execution-ready issue hides unresolved human dependency that
  belongs in `needs-decision`, `blocked-by-human`, `deferred`, or the
  approval-needed fallback
- each deferred, blocked, or decision-dependent item was preserved in a
  stable bucket instead of being dropped
- each roadmap has one roadmap marker and uses task-list links for child
  issues
- each nested roadmap node is linked from the parent roadmap task list
  and links its own active child work
- each nested roadmap remains identifiable as a coordination/audit node
  instead of a normal execution candidate
- each dependency edge is justified and preserves natural cohesion
- each `Blocked by #NNN` reference resolves to the intended issue
- each `idd-skill-blocked-by` marker points to a real roadmap and is
  used only for true sequential dependencies, never to group nested
  roadmap children
- each issue body is explicit enough that a later discover pass can
  decide whether the issue is ready without reconstructing hidden
  context
- reuse or extension decisions are recorded when the skill chose not to
  create a new issue
- each drafted ready body passes the `audit-authored-issue` mechanical
  pre-publish gate for its declared shape, or the manual fallback when
  no helper runtime is available (see
  [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

## Repository-local implementation surface

This document is the canonical contract and schema for the repository's
native issue authoring bundle at `skills/issue-authoring/`.

Keep the implementation split on purpose:

- `skills/issue-authoring/SKILL.md` should stay concise and point back
  here for the normative rules, output schemas, and validation checklist
- `.github/instructions/*.instructions.md` remain the execution-layer
  files for the normal IDD loop after issue drafting is approved

Do not treat the native skill bundle and the execution instructions as
interchangeable entry points. The native bundle prepares issues; the
instruction files execute them.

## Approval boundary

Issue authoring under the hold and IDD execution are separate
decisions, but drafting and publishing are not: by default, the skill
authors and publishes a `ready` issue set directly under the
configured authoring label (`issueAuthoring.authoringLabelName`,
default `status:authoring`), gated only by the mechanical
`audit-authored-issue` check and the critique pass — no prior user
approval of the drafted body is required.

The one exception: if the current request asks only for a preview
(drafts to review before anything is created), the skill should honor
that and stop after reporting, without publishing:

- the proposed issue set
- the rationale for the decomposition
- any assumptions, open questions, or deferred decisions

Starting the IDD execution loop requires the user's explicit
hold-release request — the single approval boundary in this contract.
That same request also authorizes removing the authoring label (see
[Authoring label lifecycle](#authoring-label-lifecycle)). Publishing a
ready issue set under the hold does not by itself authorize the agent
to move into Discover or Claim.

## Non-goals

This document does not define:

- the repository-local skill folder structure
- the exact prompt text used by a future `SKILL.md` implementation
- the GitHub API command sequences used to publish drafted issues

Those details should stay in the implementation layer so this document
can remain the stable contract and schema reference.
