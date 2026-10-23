---
type: workflow
title: IDD workflow guide
description: Routes each agent to its entry file and the phase file matching its current state.
tags: [workflow, phase-routing]
---

# IDD workflow guide

This document is the neutral entry point for the repository's
Issue-Driven Development (IDD) workflow across GitHub Copilot, Codex
CLI, OpenCode, Grok Build, Cursor CLI, Claude Code, and Antigravity CLI
(formerly Gemini CLI).

Use it when you need to answer three questions quickly:

- Which repo entry file should I read first?
- Which IDD instruction files load automatically for my agent?
- When does the workflow rely on GitHub Copilot review state rather than
  on my local CLI?

This guide's `.github/` distribution, tooling, and Copilot-advisory
review steps describe today's only implemented provider, GitHub. IDD
defines a provider-neutral adapter boundary internally as a staged
foundation for future non-GitHub adapters; see
[Provider Portability](customization.md#provider-portability) for the
capability-group model and staged rollout order. Nothing below assumes
that boundary is exercised by a shipped adapter yet.

## Start sequence

If you arrived here from your agent's entry file, pick up at step 2. If
you are reading this guide first, start at step 1.

1. Read the entry file for your agent or surface (see table below).
2. Read `.github/instructions/idd-overview-core.instructions.md`.
3. Read `.github/instructions/idd-overview-appendix.instructions.md`,
   unless the phase file that matches your current state is under
   `.github/instructions/lite/`. A session routed to a `lite/` file does
   not read the appendix.
4. Read the phase file that matches your current state.
5. If you are editing package-specific code, also follow the matching
   scoped instruction file in `.github/instructions/`.

## Entry points and auto-load expectations

| Agent / surface         | Read first                        | Automatically available IDD context                                                                                                                                                                                                                                                                                                                            | Open manually                                                                                                                                                                                                                                                                                      |
| ----------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Copilot surfaces | `.github/copilot-instructions.md` | `.github/instructions/idd-overview-core.instructions.md` for execution surfaces; package-scoped `.instructions.md` files in VS Code Copilot when editing matching paths                                                                                                                                                                                        | `.github/instructions/idd-overview-appendix.instructions.md`; the routed phase file when the current step changes                                                                                                                                                                                  |
| Codex CLI               | `AGENTS.md`                       | None from `.github/instructions/`                                                                                                                                                                                                                                                                                                                              | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file                                                                                                                                                  |
| OpenCode                | `AGENTS.md`                       | `AGENTS.md` itself — OpenCode's native rules mechanism auto-loads it; none from `.github/instructions/`                                                                                                                                                                                                                                                        | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file                                                                                                                                                  |
| Grok Build              | `AGENTS.md`                       | `AGENTS.md` and `CLAUDE.md` when both exist (same contract; Grok Build loads every matching filename, unlike OpenCode's first-match — `CLAUDE.md`'s own `@AGENTS.md` line is harmless either way: at worst Grok reads it as plain text rather than an import, and at most it re-loads `AGENTS.md`'s already-loaded content); none from `.github/instructions/` | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file; see [B1's harness-native worktree tool caveat](../.github/instructions/idd-work.instructions.md#worktree-creation)                              |
| Cursor CLI              | `AGENTS.md`                       | `AGENTS.md` and `CLAUDE.md` when both exist (Cursor always applies `CLAUDE.md`; treat the shared contract as `AGENTS.md`, and do not follow Claude-only adapter bullets such as `--vendor claude` outside Claude Code — those stay Claude-scoped in `CLAUDE.md` already); none from `.github/instructions/`                                                    | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file                                                                                                                                                  |
| Claude Code             | `CLAUDE.md`                       | None from `.github/instructions/` by default                                                                                                                                                                                                                                                                                                                   | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file; see [B1's harness-native worktree tool caveat](../.github/instructions/idd-work.instructions.md#worktree-creation) before using `EnterWorktree` |
| Antigravity CLI         | `GEMINI.md`                       | None from `.github/instructions/`                                                                                                                                                                                                                                                                                                                              | `.github/instructions/idd-overview-core.instructions.md`, `.github/instructions/idd-overview-appendix.instructions.md`, and the routed phase file                                                                                                                                                  |

The [Start sequence](#start-sequence)'s `lite/` exception applies to the
"Open manually" cells: a session routed to a `lite/` phase file does not
open the appendix.

OpenCode, Grok Build, and Cursor CLI also discover the
`issue-authoring` and `idd-spec-audit` skill bundles in this repository
through `.claude/skills/` compatibility, since
`.claude/skills/issue-authoring/` and `.claude/skills/idd-spec-audit/`
are generated, byte-identical copies of the canonical bundles at
`skills/issue-authoring/` and `skills/idd-spec-audit/` respectively. Do
not add checked-in `.cursor/skills/` or `.agents/skills/` mirrors for
those companions (preventive; no observed incident yet).

During IDD, do not call Grok Build's `enter_plan_mode` (it blocks
non-plan-file edits). Do not switch into Cursor Plan mode / `/plan`
(or SwitchMode Plan) in a way that blocks non-plan-file edits. Do not
let the bundled `review`, `pr-babysit`, or `execute-plan` skills
replace IDD E/F phases or spawn extra worktrees. (Preventive; no
observed incident yet.)

During onboarding, create or update `CLAUDE.md`, `AGENTS.md`, and
`GEMINI.md` so each non-Copilot agent listed above has a stable first
file to read. GitHub Copilot remains an update-if-present surface via
`.github/copilot-instructions.md`. Skipping creation of a missing root
entry file should be an explicit operator choice, not the default.

## Model capability expectations

The workflow above assumes at least a **middle-tier cloud-class**
model for the full Discover → Claim → Work → PR → Review → Merge → F4
loop, reusing the three model-capability classes from the
issue-authoring skill's
[specificity target](issue-authoring-skill.md#specificity-target):
**frontier**, **middle-tier cloud**, and **lightweight local or
compact cloud**.

Classify models on **two independent axes**, not context size alone:

1. **Context sufficiency** — can the window hold the entry file,
   `idd-overview-core.instructions.md`,
   `idd-overview-appendix.instructions.md` (unless the routed phase file
   is under `lite/`), the routed phase file, and tool schemas at once?
2. **Self-direction capability** — can the model plan and track a
   multi-turn loop across claim / work / PR / review steps, not merely
   answer one well-specified prompt?

A large context window does **not** imply self-direction. Field
experience has included models that clear a 100K+ context bar yet fail
to drive a multi-step agentic loop without external orchestration.
Likewise, self-direction and **local runtime speed** on the adopter's
hardware are separate considerations: a model that clears both
capability axes can still be impractical if it is too slow on
CPU-only (or other constrained) local hardware. This guide does not
pin a normative tokens-per-second floor; operators should measure on
their own targets.

- **Frontier** and **middle-tier cloud** classes need no additional
  guardrails beyond the rest of this guide; this is the assumed
  default for every phase file above. They are expected to clear both
  axes under normal operator hardware.
- **Lightweight local or compact cloud** (the supported low tier):
  models that have **both** sufficient context **and** demonstrated
  self-direction for contained, fully-specified tasks, but still show
  weak adherence to long multi-file instruction sets (the phi-4-mini
  class — roughly 128K context, tool calling supported — is the
  reference example). Treat "tool calling supported" as a
  runtime-specific claim, not a guarantee: field evidence found that a
  local ONNX serving stack silently degraded structured tool-calls to
  plain text with no error, so a model's stated capability listing tool
  calling does not mean structured tool-calls are reliably available in
  practice — see [Weak-model guardrails](#weak-model-guardrails) for
  the harness-owned mitigation. Confine this tier to narrowly-scoped
  roles under operator supervision:
  - executing a single, fully-specified `idd:ready` issue rather than
    Discover's open-ended candidate selection;
  - preferring a deterministic helper command (see
    [IDD helper script evaluation](idd-helper-scripts.md)) over prose
    judgment wherever one exists for the current step;
  - drafting output for human review rather than running the
    autonomous merge phases.
- **Large-context, non-self-directing** (named out-of-band class):
  models that clear the context-sufficiency bar but cannot reliably
  self-direct a multi-turn execution loop. They are **not** admitted
  into the supported lightweight tier by context size alone. Prefer a
  harness-orchestrated execution mode for this class (the model stays a
  step-level worker; the harness owns phase routing, tool selection,
  and acceptance gates). That path is an open investigation rather than
  a shipped workflow profile — track
  [#1555](https://github.com/kurone-kito/idd-skill/issues/1555).
- **Unsupported (context floor)**: a model whose context window cannot
  hold the entry file, `idd-overview-core.instructions.md`,
  `idd-overview-appendix.instructions.md` (unless the routed phase file
  is under `lite/`), the routed phase file, and tool schemas at the
  same time — the
  qwen2.5-coder-1.5b class (roughly 32K context) is the practical
  cutoff example. Below this floor, IDD execution is out of scope; such
  a model can still be a downstream _consumer_ of an artifact this
  workflow produces, just not an IDD execution agent.

### Weak-model guardrails

When a lightweight-tier model runs any part of this loop:

- Prefer a documented helper command over prose interpretation
  wherever [IDD helper script evaluation](idd-helper-scripts.md) lists
  one for the current step **and the repository's helper runtime is
  not the `instructions-only` profile**; treat an expected helper that
  is missing or failing as a stop-and-ask condition, never a silent
  fallback to prose judgment. On the default `instructions-only`
  profile, following the documented Markdown / `gh` / `jq` procedure
  directly is the normal, supported path for this tier too, not a stop
  condition.
- **Weak-tier tool/retrieval contract**: have the harness — not the
  model — own tool execution, query construction, and input-slice
  quality (a clean, column-labeled, minimal slice rather than a raw
  dump), and gate tool/retrieval use on a cheap uncertainty signal (for
  example, self-consistency sampling: sample k responses, treat
  unanimity as sufficient to skip retrieval and disagreement as the
  trigger to search) rather than firing augmentation unconditionally.
  Field evidence found unconditional "always augment on failure"
  net-negative on a weak model (3/7 correct, below a 4/7
  no-augmentation baseline) because retrieval corrupted facts the model
  already knew, while a harness-owned self-consistency gate recovered
  "don't retrieve what you already know" and a harness-owned web search
  took a weak model from 1/4 to 4/4 correct on factual questions.
- Retrieval augmentation is more reliably useful for a QA/spec step —
  two conditions must hold: a knowledge gap exists, and the needed fact
  is in the returned snippet — than for a mid-code-fix step, which
  chains a third condition (the model must also transcribe the fact
  correctly into code). It is not a substitute for fixing logic or
  truncation failures, which retrieval cannot address.
- Narrow the question before adding judges: when a weak model has to
  judge semantic quality, ask a narrow, falsifiable check instead of an
  open-ended review. The failure mode is correlated bias, not
  independent noise, so majority voting does not repair it; keep the
  result advisory, not veto-bearing.
- Parse structured output leniently with a bounded retry: for fixed
  formats, strip common Markdown wrappers, require at least one
  discriminating field, normalize and de-duplicate the results, and
  retry once with a short example before treating the attempt as failed.
  This applies only to weak-model output readers and does not change the
  byte-exact marker verification used for published IDD markers.
- See the condensed execution-loop instruction profile roadmap
  (`docs/weak-model-lite-profile-design.md`, #1539) for the E9-E15
  upstream-triage boundary; the E4 narrow-rubric result is recorded
  there as future nuance, not as a scope change here. This note does not
  change #909/#1342 or `idd-review-triage.instructions.md`'s
  lite-profile exclusion.
- Do not run the autonomous merge phases (F3 onward) on this tier. See
  the merge-policy recommendation for weak-model sessions at
  <https://github.com/kurone-kito/idd-skill/blob/main/idd-template/docs/onboarding/policy-decisions.md#merge-policy>.
- This is additional to, not a replacement for, the uniform C-phase
  objective diff validation floor in
  [Critique pass invocation](#critique-pass-invocation): that floor
  exists precisely because judging whether a same-response
  self-critique is truly independent is the kind of fragile runtime
  self-detection a weak model could get wrong, so it applies uniformly
  regardless of declared model tier.
- **Acceptance-check rigor**: any per-unit acceptance check gating
  weak-tier generated output should include multiple boundary cases,
  explicit assertions, and a timeout — the timeout specifically is
  what turns an infinite loop into a caught failure instead of a hang.
  A narrow check (one or two cases) can let a fragile generation with a
  real defect pass undetected.
- **Clean-artifact generation**: a generation prompt driving weak-tier
  output should instruct the model to produce a clean, importable
  artifact — the target definitions and needed imports only — and
  explicitly forbid embedding the acceptance test, assertions, prints,
  or a self-invoking entrypoint block (Python's `__main__` guard, for
  example), and forbid importing the artifact under construction. The
  acceptance check itself — the literal test code, assertions, and
  expected outputs, as distinct from the behavioral acceptance
  criteria described in the prompt —
  must never be shown to the generating model, since a weak model that
  sees the test tends to reproduce it inline rather than keeping the
  two separated.

These tiers are practical operating guidance, not a new enforced
runtime gate: `.github/instructions/idd-suitability.instructions.md`'s
Edge Cases already treat an agent's inability to reliably perform a
check as a PASS (fail-closed only for Check 3, Trust/Safety), so this
section documents an operator-facing expectation rather than a new
A4/A4.5 check.

### Model selection and prompting for the weak tier

Independent field evidence surfaced three predictable model-selection
and prompting mistakes at the weak-local tier that the capability-tier
classification above does not warn against on its own:

- **Loop-stability-versus-single-shot mismatch**: a model's single-shot
  coding pass rate does not predict whether it can hold a multi-turn
  agentic loop without spiraling — the single-shot-coding knee and the
  agentic-loop-stability knee can sit at different model sizes
  entirely. Do not select a model for loop execution on a single-shot
  battery alone. Use a cheap smoke test instead: can the model run N
  turns on a simple task without spiraling? Gate model selection for
  loop execution on that result, not the single-shot score.
- **Reasoning-model spec-drift**: for mechanical, fully-specified,
  single-clause steps, prefer a literal, low-reasoning model over a
  verbose reasoning model — select for obedience, not cleverness, at
  this tier. A reasoning model can "improve" on a literal instruction
  instead of obeying it (for example, returning a different type than
  specified, or renaming a referenced symbol so downstream code
  breaks), while costing substantially more tokens and wall-time than a
  leaner, non-reasoning model that follows the spec literally. More
  reasoning is not automatically a safer default for this kind of step.
- **Full-agent-wrapper degradation**: at the weak tier, prefer a
  direct, minimal-prompt generation path — feeding only the atomic task
  and its acceptance context — over routing the same request through a
  full agent session with its system prompt and instruction stack. The
  added context (system-prompt injection, a large per-turn instruction
  stack) can push a small model past its reliable zone, so the same
  model that succeeds on a direct minimal prompt can fail through the
  full agent wrapper.

These are adopter-facing model-selection and prompting heuristics, not
a new requirement on this repository's own instructions or tooling.

### Lite instruction profile opt-in

The guardrails above assume a session already knows to look for a
condensed instruction bundle. This subsection records how a
repository declares that opt-in and how a session resolves it, so the
convention reads as part of the tier guidance above rather than a
parallel mechanism.

**Opt-in signal (recorded convention).** A repository declares its
lite-profile choice with an `.github/idd/config.json` policy field,
`instructionProfile`, following the same repository-local
policy-field pattern as `mergePolicy`, `reviewPolicy`, and the other
fields in
[Repository-local IDD policy](customization.md#repository-local-idd-policy):

- `"standard"` (default; equivalent to the field being absent) —
  every phase uses its standard
  `.github/instructions/idd-*.instructions.md` file, unconditionally.
- `"lite"` — a lightweight-tier session prefers the condensed
  `.github/instructions/lite/idd-*-lite.instructions.md` bundle for
  any phase that has shipped one, and falls back to the standard file
  for every phase that has not (see the mapping and fallback below).

A machine-readable config field is a better fit than a routing note
folded into `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` prose. It matches
the lite-profile design's
[content principle 4](weak-model-lite-profile-design.md#content-principles):
mechanical, fail-closed control surfaces carry the safety weight for
this tier, not prose judgment. A prose routing note is itself a
cross-file reference a weak-adherence session could drop — exactly
the failure mode the lite profile exists to route around.

**Recorded convention, not yet wired.** `instructionProfile` is not
yet part of the published policy schema
(<https://kurone-kito.github.io/idd-skill/schemas/policy.schema.json>,
whose root object rejects unknown properties), and no phase file or
the routing table in `idd-overview-core.instructions.md` reads it
today. This subsection records the intended shape for a future issue
to add the schema field and the routing read against. **Do not set the
field yet**: `.github/idd/config.json` is already validated against
that schema by `idd-doctor` (`node scripts/idd-doctor.mjs`), and the
schema's root object's `additionalProperties: false` means adding
`instructionProfile` today fails that validation outright — it is not
merely inert. Until the schema follow-up lands, point a lite-tier
session at the right files with an explicit operator instruction, or
have it open the phase files below manually.

**Phase → lite file mapping** (live as of this writing — re-check
`.github/instructions/lite/` before trusting this table to stay
current):

| Phase                    | Standard file                         | Lite file                                       |
| ------------------------ | ------------------------------------- | ----------------------------------------------- |
| A5 Claim                 | `idd-claim.instructions.md`           | `lite/idd-claim-lite.instructions.md`           |
| B1-C6 Work               | `idd-work.instructions.md`            | `lite/idd-work-lite.instructions.md`            |
| D1-D4 PR-submit          | `idd-pr-submit.instructions.md`       | `lite/idd-pr-submit-lite.instructions.md`       |
| E1-E3 Review-snapshot    | `idd-review-snapshot.instructions.md` | `lite/idd-review-snapshot-lite.instructions.md` |
| E9-E15 Review-fix        | `idd-review-fix.instructions.md`      | `lite/idd-review-fix-lite.instructions.md`      |
| F1-F2 helper-read subset | `idd-pre-merge.instructions.md`       | `lite/idd-pre-merge-lite.instructions.md`       |
| F2.5 handoff-stop        | `idd-merge-handoff.instructions.md`   | `lite/idd-merge-handoff-lite.instructions.md`   |
| Resume                   | `idd-resume.instructions.md`          | `lite/idd-resume-lite.instructions.md`          |
| Resume-stall             | `idd-resume-stall.instructions.md`    | `lite/idd-resume-stall-lite.instructions.md`    |

The F1-F2 and F2.5 rows cover a **partial** slice of their standard
files only, per the design's phase scoping: the lite F1-F2 file
covers just F1's read-only branch check and reading the
`pre-merge-readiness` helper verdict, never the standard file's
written prose fallback; the lite F2.5 file covers just the
handoff-stop outcome, never autonomous-merge routing. Neither falls
back to the standard file for its excluded sub-case within the same
phase — both instead treat that sub-case as a stop-and-ask condition
(a broken/missing helper for F1-F2; anything but the handoff-stop
outcome for F2.5) — a nuance the table above cannot show by itself.

`idd-ci.instructions.md` and `idd-advisory-wait.instructions.md` are
shared helper files, not phases of their own, so they never appear as
a row in the table above.
[#1657](https://github.com/kurone-kito/idd-skill/issues/1657) shipped
a standalone lite sibling for each instead —
`lite/idd-ci-lite.instructions.md` and
`lite/idd-advisory-wait-lite.instructions.md` — that a lite caller
references one hop away (content principle 3), replacing the earlier
plan to restate every load-bearing rule from the full-size file
inline, which is content principle 1's default for a lite file with
no in-scope sibling to reference. The advisory-wait lite sibling
covers only the
**E14-caller subset**: F2's prose fallback and F3's merge-time call
site stay excluded, matching the design's split-by-caller scoping for
this file in
[Phase scoping](weak-model-lite-profile-design.md#phase-scoping).

**Explicit fallback.** Every phase without a row above falls back to
its standard instruction file — this is the documented default, not
an implied gap. A0-A4 Discover, A4.5 Suitability, E4-E8 Review-triage,
and F3-F5 Merge are **permanently excluded by design**: the design's
[non-goals](weak-model-lite-profile-design.md#target-model-class-and-non-goals)
and phase-scoping table exclude open-ended selection, judgment-heavy
classification, and autonomous merge from the condensed profile
entirely, regardless of roadmap progress. A future phase without a row
and without a listed exclusion reason would instead mean an in-scope,
not-yet-shipped lite file — none exist as of this writing.

A lite-opted-in session encountering any of these phases reads the
standard file the same way a standard-tier session would.

## IDD file map

| File                                                         | Role                                                                                                                                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/instructions/idd-overview-core.instructions.md`     | Shared definitions, command sets, routing table, critique-pass mapping                                                                                                                          |
| `.github/instructions/idd-overview-appendix.instructions.md` | Reference and implementation detail for core: live status digest, abort/hold templates, commit signing, critique-pass detail, and template-sync guidance                                        |
| `.github/instructions/idd-discover.instructions.md`          | A0-T–A4: find a viable issue and classify roadmap vs. leaf nodes during traversal, then hand off to the A4.5 row below                                                                          |
| `.github/instructions/idd-roadmap-audit.instructions.md`     | A1.5: audit roadmap completion, including bottom-up recursive roadmap closure, before A2                                                                                                        |
| `.github/instructions/idd-suitability.instructions.md`       | A4.5: pre-claim suitability triage — filter incoherent, unsafe, duplicated, or out-of-scope candidates before claim                                                                             |
| `.github/instructions/idd-claim.instructions.md`             | A5: run claim pre-checks and claim verification                                                                                                                                                 |
| `.github/instructions/idd-work.instructions.md`              | B1-B3 + C1-C6: create worktree, plan, implement, and self-review                                                                                                                                |
| `.github/instructions/idd-pr-submit.instructions.md`         | D1-D4: rebase, validate, push, open PR, and wait for CI                                                                                                                                         |
| `.github/instructions/idd-ci.instructions.md`                | D4/E15 helper: shared CI polling helper used by later phases                                                                                                                                    |
| `.github/instructions/idd-advisory-wait.instructions.md`     | AW1-AW5 helper: shared Copilot advisory-wait protocol (E14, F2, F3)                                                                                                                             |
| `.github/instructions/idd-review-snapshot.instructions.md`   | E1–E3: fetch activity snapshot, run critique, check if ReviewItems_snapshot is empty                                                                                                            |
| `.github/instructions/idd-review-triage.instructions.md`     | E4–E8: classify items, score, record dispositions, and run E-phase branch-sync check before F-phase                                                                                             |
| `.github/instructions/idd-review-fix.instructions.md`        | E9-E15: fix accepted review items and push follow-up commits (merge-from-`{development-branch}`, not rebase)                                                                                    |
| `.github/instructions/idd-pre-merge.instructions.md`         | F1: final read-only branch-state check; F2: verify all pre-merge conditions                                                                                                                     |
| `.github/instructions/idd-merge-handoff.instructions.md`     | F2.5: resolve merge-policy handoff vs autonomous merge routing                                                                                                                                  |
| `.github/instructions/idd-merge.instructions.md`             | F3–F5: execute the merge, clean up, and loop back to discover                                                                                                                                   |
| `.github/instructions/idd-resume.instructions.md`            | Resume Step 0-3: route crash, stalled, stale-takeover, or clean continuation                                                                                                                    |
| `.github/instructions/idd-resume-stall.instructions.md`      | Resume S1-S5: handle stalled-session recovery with a dedicated safety gate                                                                                                                      |
| `.github/instructions/idd-orchestrator.instructions.md`      | Orchestrator fan-out phase: activation, roster, dispatch, refill, report and disposal, worker span                                                                                              |
| `.github/instructions/lite/idd-*-lite.instructions.md`       | Condensed weak-model-tier phase files for phases with a shipped lite bundle; see [Lite instruction profile opt-in](#lite-instruction-profile-opt-in) for the mapping and standard-file fallback |
| `docs/idd-review-policy-profiles.md`                         | PR review policy profiles and customization surfaces                                                                                                                                            |
| `docs/idd-comment-minimization.md`                           | Live status digest contract and post-merge comment minimization policy                                                                                                                          |

## ReviewItems_snapshot lifecycle

`ReviewItems_snapshot` is a session-local collection, scoped to the
current claim, created from E1's activity-universe fetch — not a
literally immutable value a later session may reuse as-is.

| Phase   | Operation                                                                                                   | State     |
| ------- | ----------------------------------------------------------------------------------------------------------- | --------- |
| E1      | Fetch threads/reviews/comments, exclude trusted operational markers, and freeze the current item universe   | created   |
| E2      | Run critique pass and append newly found findings to the same snapshot scope                                | extended  |
| E3      | Evaluate empty/non-empty routing based on the frozen snapshot plus E2 findings                              | evaluated |
| E4-E8   | Classify, score, disposition, and verify each snapshot item (PATH A/PATH B) without redefining the snapshot | triaged   |
| E9-E11  | Fix Accepted PATH A items, validate with a critique pass, and resolve conflicts with `{development-branch}` | actioned  |
| E12     | Lint, test, and push the commit(s) addressing the actioned items                                            | committed |
| E13-E14 | Reply to each snapshot item with its disposition, resolve its thread, and request re-review                 | replied   |
| E15     | CI resolves for the pushed commit(s) and the loop returns to E1, ending this snapshot's role for the round  | complete  |

The name intentionally emphasizes snapshot semantics: E1-E3 builds and
gates on a time-locked view, E4-E8 triages that view, and E9-E15 drives
it to completion, normally within the current session, before the next
E1 fetch supersedes it.

**Cross-session hygiene**: because the snapshot is session-local, a
resumed or forced-handoff session must not inherit a prior session's
`ReviewItems_snapshot`, watermark, or baseline markers as still
authoritative for its own review pass. Rebuild from a fresh E1 fetch
instead, and treat prior-claim operational markers as non-reusable even
when the branch and HEAD are unchanged — see
`idd-resume.instructions.md`'s CI/review routing table and its
forced-handoff recovery note for the authoritative rule.

**Cold entry outside Resume**: `idd-resume.instructions.md` owns
mid-review resume routing -- see its Step 3 table and forced-handoff
note, and `docs/idd-resume-detail.md` §W3/§W5. Where any of those
routes lands a session at E4 or E9 without a `ReviewItems_snapshot`
from its own E1-E3 pass, the cold-start reconstruction section below
applies; reconciling §W3's own dirty-worktree instructions with that
section's stop-and-reconcile rule is a follow-up to
`idd-resume-detail.md` itself, not a gap this section can close by
restating Resume's routing here. The gap this section closes directly
spans two paths:
`idd-overview-core.instructions.md`'s phase-routing entries for
"Snapshot done" / "Review feedback accepted," followed without having
just run E1, and an orchestrator fan-out delegation brief that hands a
worker straight into mid-review (see
[Orchestrator fan-out variant](#orchestrator-fan-out-variant) below).
`idd-review-snapshot.instructions.md`'s cold-start reconstruction
section is the named procedure for both, including the two edge cases
a naive rebuild could get wrong.

## Artifact taxonomy and ownership

This repository contains several AI-facing artifact types. Keep their
ownership boundaries explicit:

- **Live repository instructions**: `.github/instructions/*.instructions.md`
  are the canonical workflow rules used by this repository and drive
  the execution loop.
- **Exported template files**: `idd-template/` is the portable package
  copied into adopter repositories. When live IDD instruction files
  change, mirror the equivalent portable form into this template.
- **Agent entry files**: `AGENTS.md` is the canonical, fully detailed
  AI guide (see [AI tooling strategy](ai-strategy.md)); `CLAUDE.md`,
  `GEMINI.md`, and `.github/copilot-instructions.md` are lightweight
  adapters that import or point to it and tell each agent where to
  start.
- **Workflow docs**: files under `docs/` explain architecture, policy,
  and usage. They should avoid duplicating long operational rules that
  belong in `.github/instructions/`.
- **Native skill bundles**: `SKILL.md` bundles, when present, are
  separate agent-native helpers such as `skills/issue-authoring/` and
  `skills/idd-spec-audit/`. Each canonical source bundle in this
  repository stays under its own path; when adopters install one
  elsewhere, they should place it in the agent-specific skill directory
  their runtime reads. They may reference the workflow docs and
  schemas, but they should not duplicate or replace the exported IDD
  instruction template.

Use `skills/issue-authoring/` as the canonical source bundle when you
need pre-IDD issue drafting or decomposition. Install copies of that
bundle into the agent-specific skill directory your runtime reads, then
use `.github/instructions/*.instructions.md` after the issue set is
approved and the normal Discover -> Claim -> Work loop should start. The
canonical contract and schema for the native bundle live in
`docs/issue-authoring-skill.md`. This source repository dogfoods that
install instruction: `.claude/skills/issue-authoring/` is a generated
copy of the canonical bundle, regenerated by `scripts/sync-docs.mjs`
and drift-guarded by the documentation audit.

Use `skills/idd-spec-audit/SKILL.md` as the read-only companion when
you need to audit the installed instruction corpus for semantic drift;
it routes every finding back through `skills/issue-authoring/` instead
of editing files or mutating issues directly. This source repository
dogfoods that install instruction too: `.claude/skills/idd-spec-audit/`
is likewise a generated copy of the canonical bundle, regenerated by
`scripts/sync-docs.mjs` and drift-guarded by the documentation audit.

The IDD workflow distributed from this repository is therefore an
instruction template first. Native skills can sit beside it as helpers,
but the synchronization contract for the portable workflow remains
between the live `.github/instructions/` files and `idd-template/`.

If you need to understand or change distributed timing defaults, start
with [IDD policy constants](policy-constants.md). It names the claim,
advisory, CI, and critique-loop defaults and points to the instruction
files that own each value.

When helper support is enabled, the discover and suitability phases may
use the helper-backed evidence collectors first, but the Markdown
instruction files remain the final authority whenever helper output is
missing or disagrees.

During onboarding, create or update `CLAUDE.md`, `AGENTS.md`, and
`GEMINI.md` so each non-Copilot agent listed above has a stable first
file to read. GitHub Copilot remains an update-if-present surface via
`.github/copilot-instructions.md`. Skipping creation of a missing root
entry file should be an explicit operator choice, not the default.

When an operator gives exactly one issue target, Discover can verify that
target directly before Claim. The shortcut avoids broad roadmap
enumeration, but it still applies targeted readiness checks, the A4
viability gate, and the A4.5 suitability gate before the normal A5 claim
safety checks.

### Completed-draft adversarial review

The Intake critique of an emerging interpretation stays in Intake.
After a roadmap, child, or orphan body is drafted, a separate review
runs before `audit-authored-issue` and before publication. Review a
roadmap shell while `## Tracks` may still be empty, then each child,
then the parent again before saving real child numbers into
`## Tracks`.

The reviewer receives the exact title and body plus only the user's
goal, confirmed constraints and design choices, relevant evidence or
file references, relationship context for a multi-issue set, and the
issue-authoring critique checklist. That checklist checks the confirmed
goal, a concrete surface and objective verification, hidden human
dependencies, true dependency edges, the specificity target range, and
candidate files used as cues. It does not receive the whole
conversation or unbounded work instructions.

Resolve `idd-issue-authoring-delegate` when a helper runtime can run
it. This source repository's equivalent is:

```sh
node scripts/idd-issue-authoring-delegate.mjs [--policy <path>] [--no-user-global]
```

The helper does not invoke the command and does not read
`critiqueLoop.delegate`. If the resolver cannot be run, or `usable` is
false, keep the agent-native reviewer or a structured self-critique.
That is not a failed review. When `usable` is true, the modes match the
C/E delegate:

| mode                 | delegate succeeded           | delegate failed              |
| -------------------- | ---------------------------- | ---------------------------- |
| `fallback` (default) | native reviewer does not run | native reviewer runs         |
| `combined`           | both run                     | both run                     |
| `on-success`         | both run                     | native reviewer does not run |
| `never`              | native reviewer does not run | native reviewer does not run |

Union the findings whenever both mechanisms run. After `usable: true`,
a missing command, non-zero exit, timeout, cancellation, or unreadable
findings is a failure. A readable empty list is a clean verdict. If no
mechanism that ran returns a readable list, do not publish the drafted
issue: do not create it, update its body, change its label, or append a
marker for it. An existing held issue keeps its label and previous body.
The drafts go into a draft carrier marked `Review: not reviewed` (see the
[issue-authoring skill contract](issue-authoring-skill.md#draft-carrier)),
unless they already sit in one (they stay there), the user said not to
create any issue, or the carrier cannot be published either (then they stay
local).
A failure is never a clean review.

The reviewer must be read-only and returns a findings list only: it must
not create or update issues, change labels, or append markers. That is a
trust-based contract, not an enforced sandbox, because the configured
command runs in the caller's environment as executable configuration.
Prefer a non-context-inheriting reviewer, and use a read-only capability
or sandbox where the harness offers one.
kurone-kito/idd-skill#3448 records the observed risk that a
context-inheriting no-mutation dispatch still publishes. Bound the
delegated command with
`issueAuthoring.adversarialReview.waitCeiling`
(default `PT20M`) through the caller's own wait and cleanup. Do not wrap
the configured command in a timeout utility. The ceiling does not read
`critiqueLoop.subagentWaitCeiling`, and a user-global ceiling is
ignored. Use the same caller-side bound for the native reviewer, so a
hung native pass is not an unbounded substitute. The configured command
is trusted executable configuration and may transmit the supplied draft
and evidence packet. The caller sends the draft to the command on stdin as
one JSON object (`title`, `body`, and a bounded `packet`), described by the
[issue-authoring review input schema][issue-authoring-review-input-schema].
The normative checklist and disposition rule live in the
[issue-authoring skill contract](issue-authoring-skill.md#completed-draft-adversarial-review).

### User-global issue-authoring delegate default

This resolver reads only its own fragment of the user-global file. The
layered rules for `overrides[]`, the repository-policy field class, and the
CI off switches are in the
[user-global installation guide](https://github.com/kurone-kito/idd-skill/blob/main/docs/user-global-install.md).

A local runtime may also inherit `issueAuthoring.adversarialReview.delegate`
from the same optional user-global file the critique delegate uses when the
repository leaves the repo-local field genuinely absent. A GitHub-hosted or
other remote agent surface is not meant to consult this layer, but the helper
detects only `GITHUB_ACTIONS=true` on its own; pass `--no-user-global` on any
other remote surface. The file path and the qualified-root rule are the ones in
[User-global critique delegate default](#user-global-critique-delegate-default)
(`$XDG_CONFIG_HOME/idd-skill/config.json`, falling back to
`$HOME/.config/idd-skill/config.json`); a missing, unreadable, invalid-JSON, or
non-object file is treated as absent, and the layer is opt-in.

Resolution order: a repo-local `issueAuthoring.adversarialReview.delegate` (a
configured object, an explicit JSON `null` disable, or a malformed value)
always wins outright and never inherits the global layer, so an explicit
repo-local `null` keeps the native reviewer even when a global delegate exists.
A repo-local `issueAuthoring` or `adversarialReview` that is not an object, or
an `adversarialReview` with a key other than `delegate` and `waitCeiling`, is
malformed in the same way, so a typo cannot inherit a global command. Only when
the repo-local delegate is entirely absent does the global fragment apply;
absent both, the native reviewer or structured self-critique above runs
unchanged. A malformed or explicit-`null` global fragment, including an
`adversarialReview` with an unknown key, is treated the same as a missing one.
`GITHUB_ACTIONS=true` always skips the global layer, and `--no-user-global`
skips it on any other remote surface the caller recognizes (see
[Effective issue-authoring adversarial review delegate](idd-helper-scripts.md#effective-issue-authoring-adversarial-review-delegate)).
This resolver reads only that fragment: it never reads `critiqueLoop.delegate`,
and the critique delegate never reads it.

Example (a generic local draft reviewer, not a specific product):

```json
{
  "issueAuthoring": {
    "adversarialReview": {
      "delegate": { "command": "my-local-draft-reviewer" }
    }
  }
}
```

The optional `mode` takes the same values as the critique delegate and defaults
to `fallback`. `issueAuthoring.adversarialReview.waitCeiling` stays
repository-local (default `PT20M`), so a user-global ceiling is ignored. The
command is trusted executable configuration and may transmit the issue draft it
receives, so neither the user-global nor the repo-local config file should hold
secrets.

## External-signal entry path

The Discover -> Claim -> Work loop above only reads issues already
present in the tracker. A repository fed by an external signal source
(error tracker, alert, support intake) needs a distinct on-ramp into
issue-authoring before that loop ever sees anything.

1. **Triage** (optional, agent-local): classify the incoming signal and
   dedupe it against existing open issues or roadmap nodes before
   drafting anything new. IDD does not define this stage's tooling — a
   webhook receiver, a scheduled poll, or a manual review are all
   equally valid, repository- or agent-specific integrations.
2. **Hand off to issue-authoring**: once a signal survives triage as a
   genuinely new, actionable item, feed its content to
   `skills/issue-authoring/` the same way a human-authored idea would
   be (see
   [Artifact taxonomy and ownership](#artifact-taxonomy-and-ownership)
   above). The skill produces a normal, schema-conformant IDD issue.
3. **Rejoin the normal loop**: the produced issue is claimable by
   Discover like any other issue — nothing about its external origin is
   visible to A0-A5.

Because the triage stage is optional and agent-local, an issue produced
this way must never cite the triage tooling itself as a completion
dependency: its acceptance criteria stay implementable by any agent,
including one lacking that specific integration.

A sibling entry path exists for a signal whose _root cause_ lives in a
different repository (the `idd-skill` distribution itself) rather than
in this one: see
[Upstream-candidate escalation](../.github/instructions/idd-overview-appendix.instructions.md#upstream-candidate-escalation)
in the reference appendix for the qualifying criteria and the local
marker/label convention it produces.

## Issue-author approval contract

Repositories may also keep a secure-by-default issue-author approval
gate ahead of Claim. The distributed discover and claim instructions
already enforce this behavior: explicit-target runs stop before claim
when the selected issue lacks the required approval, and discovery keeps
underprivileged unapproved issues in an approval-needed fallback bucket
instead of treating them as ready to start. Approval actors are a
repository-local policy choice and remain distinct from trusted
operational marker actors; CODEOWNERS mismatch does not replace this
pre-start gate.

## CODEOWNERS and Merge Gates

CODEOWNERS are evaluated after work reaches the pull request, not during
Discover or Claim. They become part of the PR review and merge gates in
E and F phases: review snapshots must report required approval and
CODEOWNER satisfaction, and F2/F3 must prove that unresolved review
state, advisory state, CI, and branch freshness are all current for the
same head.

Autonomous operation therefore requires a satisfiable GitHub merge
topology in addition to a recorded IDD merge policy. If the PR author is
also the only matching CODEOWNER, GitHub's self-approval limit can make
required CODEOWNER review impossible to satisfy. In that topology, IDD
must wait for an eligible non-author reviewer, use a deliberately
configured pull-request-only ruleset bypass for the trusted merge actor,
or stop for a repository policy change.

## Suitability policy handoff

A4.5 outcomes should map to explicit repository policy, not ad hoc
session choices. Keep the mapping in [Customizing IDD](customization.md)
for labels, comment-and-stop defaults, and close boundaries:

- uncertain outcomes (`unclear`, `needs-decision`, `blocked-by-human`)
  stay open by default with a concise routing comment, then A4.5 keeps
  scanning remaining candidates in the same run;
- high-confidence `duplicate`, `invalid`, and `out-of-scope` outcomes
  are read-only by default and require explicit A4.5 mutation-policy
  customization before close/label side effects;
- configured ready-label approval ownership is separate from trusted
  marker actor authority for operational claim/review markers.

## Grooming pass for rejected and below-floor issues (optional)

A4.5 rejections and below-floor autopilot-suitability scores
accumulate into a backlog that ordinary Discover never revisits on its
own. An optional, human-initiated **Groom** phase lets an operator
batch-review that backlog and clear entries whose blocker has become
answerable. This is distinct from durably recording a rejection so it
does not silently resurface (a separate concern already tracked as
issue #2243) -- grooming is about _reversing_ a rejection later, once
circumstances change.

**Classify before spending operator time.** Sort each candidate into
one of three buckets:

- **execution-blocked** -- no operator input helps; only further agent
  work can resolve it. Leave these for Discover/Claim to pick up
  normally once unblocked.
- **decision-blocked** -- a genuine human call is required (a product
  tradeoff, an ambiguous acceptance criterion, an already-recorded
  policy choice). A bounded question set can resolve these.
- **fact-blocked** -- the rejection cited a fact (a dependency, a
  blocking issue) that may no longer hold.

**Re-check facts before drafting a question.** For a fact-blocked
candidate, check whether any issue or PR the original rejection cited
as a blocker has since closed or merged -- a cached readiness snapshot
can be stale, and a closed blocker is a "free" suitability lever that
costs nothing to re-apply.

**Verify feasibility before drafting a question.** Before drafting a
decision-blocked question, confirm every option it offers is actually
buildable against the codebase's current architecture, with no
undisclosed scope expansion -- a new persistence layer, a new
dependency, or a change to an unrelated component's contract. A
competing-options question can read as complete because every option
sounds coherent in English, while only an implementing session's actual
codebase familiarity reveals that one option needs a capability the
architecture does not have. If an option fails this check, either drop
it from the question or disclose the scope expansion it would require
as part of the question itself, so the operator chooses with the same
information an implementing session would need (field evidence observed
2026-09-10, issue `#2805`).

**Never override a deliberate decision.** When the original rejection
recorded a genuinely deliberate empirical or product decision (not
merely an unanswered question), grooming must never resolve it
unilaterally. Offer "keep the existing decision" as one of the
operator's own answer choices instead.

**Explain before asking.** Give the operator the background and
tradeoffs behind each question before asking it, rather than bundling
several unrelated technical topics into one dense batch.

**Apply the operator's answers back onto the issue**: update the score
footer, remove or update the `triage:{outcome}` label -- and the
configured needs-decision label too, when the hold-and-return rule
below applied it to this same candidate, so Discover's own A3
readiness filter stops excluding it -- revise acceptance criteria to
reflect the decision, and record the
decision as inline prose in the issue body: `Maintainer decision (<provenance>,
Groom hearing, <date>): <resolution text>` -- the shape
`suitability-triage.mjs`'s Check 7 recognizes as a resolved
decision (`#2661`); a comment may additionally note the decision, but the body
itself is what re-triage reads. This exact line is also exempt from A4's
own `autonomous_completion` gate (`discover-viability-gate.mjs`, `#2763`),
so a re-groomed issue is not discarded before Check 7 ever sees it. The
next ordinary Discover pass then picks the issue up normally -- grooming
itself never claims or works the issue (see
[Mutation Policy and Coordination Rule](../.github/instructions/idd-suitability.instructions.md#mutation-policy-and-coordination-rule)).

**Hold when a recorded resolution proves infeasible.** The feasibility
check above reduces the risk of drafting an infeasible option, but does
not eliminate it -- the same field evidence (2026-09-10, issue
`#2805`) shows infeasibility that only became visible once an
implementing session was deep enough into the codebase to see it. When
a session reaches implementation and finds the Groom-recorded
resolution cannot be built as specified, it must hold the candidate as
decision-blocked again, rather than silently reinterpreting,
downscoping, or unilaterally picking a different resolution: apply the
configured needs-decision label and release the claim, the same
general hold mechanism the shared Hold / suspend rules in
`.github/instructions/idd-overview-appendix.instructions.md` already
document. Record exactly what made the recorded option infeasible in
the hold comment, so the next Groom pass has the information a
corrected question needs. That later pass removes the needs-decision
label as part of applying its own operator's answers back onto the
issue (above), alongside the `triage:{outcome}` label and the score
footer, rather than leaving the label in place indefinitely or
removing it without recording a genuinely buildable replacement.
That replacement must strike through or otherwise replace the
infeasible `Maintainer decision` line rather than merely append beside
it -- re-triage's own `hasResolvedDecision` check treats every unstruck
occurrence as live and has no way to tell which one is current, so an
unstruck infeasible line can keep reading as resolved alongside its
replacement. Removing the label here does not itself trigger the
appendix's usual removal-and-re-claim pairing: like the adjacent
`triage:{outcome}` removal above, the actual re-claim happens through
the next ordinary Discover pass reading the now-label-free issue, not
through the Groom pass itself, which -- as already stated above --
never claims or works the issue.

**Worked example.** An issue was rejected `needs-decision` at score
`2/5` because its acceptance criteria read "add caching, or document
why caching is unsafe here" -- an unresolved subjective call under
A4.5's escape-hatch guidance. Grooming classifies it decision-blocked,
explains the caching-correctness-vs-simplicity tradeoff, and asks the
operator to choose between TTL-based expiry and explicit
invalidation-on-write. After the operator picks TTL-based expiry, the
acceptance criteria are rewritten to "cache reads for up to 60 seconds
via TTL-based expiry; no explicit invalidation path is required", the
score footer is raised to `4/5`, and the `triage:needs-decision` label
is removed after the body records `Maintainer decision (Groom hearing,
2026-06-27): TTL-based expiry, chosen over explicit
invalidation-on-write for simplicity`.

## Provisional decision lifecycle

Provisional decisions are available only when a repository explicitly
sets `dangerouslyAutoDecide: true` in trusted repository policy. The
setting defaults to `false` and does not grant credentials, scope,
approval, permission, or a waiver of the normal claim, safety, CI,
review, branch, or merge gates. The IDD source repository keeps this
feature disabled until a separate decision enables it.

Before provisional work starts, persist a canonical decision record on
the source issue. Its body begins with
`<!-- idd-provisional-decision-record:v1 -->`, followed by one JSON value
matching `provisional-decision-record.schema.json`. The record binds the
source snapshot, decision bundle and generation, claim lineage, evidence,
selected option, feasible alternatives and their rejection reasons, and
execution criteria. Record events distinguish a provisional selection,
work start, verified completion, confirmation, and alternate-choice
rework. Keep every unresolved choice visible in the current bundle.

A selection is provisional, not confirmation. Verified work completion
leaves the source issue open in a confirmation-pending state; it does not
make the decision confirmed, permit automatic close, or cause the same
completed work to execute again. Downstream work can use completed
provisional work only through its own opt-in and evidence gates. These
boundaries preserve the roadmap's confirmed lifecycle contract
([issue #4528](https://github.com/kurone-kito/idd-skill/issues/4528)).

When asking for confirmation, present the complete implemented bundle,
its alternatives, verified results, and the implications of rework. An
interactive prompt uses `N` as its default. A non-interactive session
needs an explicit answer in the current conversation or CLI input; `N`,
Enter, EOF, cancellation, silence, and missing input leave the source
pending. A previously recorded valid answer replays without asking again.

An authorized recorder, including an agent using a shared authorized
GitHub account, may persist the user's actual answer on the source issue.
The answer comment begins with
`<!-- idd-provisional-decision-agent-answer:v1 -->`, followed by JSON
that records the source snapshot, current bundle and decision
generations, claim IDs, the presented choices and verified results, the
response, and the answer received. The `confirmed` event points to that
comment and binds its API creation time and scope to the completion
records. Replay checks the reference, trusted API authorship, edit state,
source and claim freshness, generations, and completed-work evidence.
Source freshness uses repository, issue, title, and body content; it does
not use GitHub's `updated_at`, which changes when comments are added. Each
record must bind to the claim lineage active when that comment was posted,
while a prior answer remains bound to the lineage of the confirmation or
rework record that cites it. Confirmation and rework answers must follow
every completion comment in the bundle, using server order when timestamps
tie. Each same-source body rewrite must match a rework-authored record and
caller-verified authoring evidence, including the trusted author, owner,
fresh authoring set, roadmap, and audited child wiring. The verified
source transition becomes the basis for later records and rework
generations.
The watermark identifies the canonical recorded-answer format; it is
not proof of a person's identity and does not classify the account
operator as human or agent. A trusted recorder is responsible for
recording an actual user response. A marker alone, an ordinary trusted
comment, or a provisional selection does not confirm the bundle; this
provenance boundary follows the clarification recorded in
[issue #4528](https://github.com/kurone-kito/idd-skill/issues/4528) after
the confirmation-provenance hold on
[issue #4571](https://github.com/kurone-kito/idd-skill/issues/4571).
No separate account, signing key, authenticated transcript, or external
identity service is required.

Every answer presents the entire current completed bundle for context;
the linked event applies that answer to its own decision generation.
This allows one decision to be confirmed while another receives a
different explicit preference and begins rework. Once confirmation or
rework begins, keep that bundle generation closed. Start a new generation
only after every decision in the prior bundle is confirmed or has
verified rework authoring. A different explicit preference records a
rework request, preserves the earlier choices and completed-work links,
and uses the normal held authoring process to turn the same source issue
into its rework roadmap. Missing, edited, stale, untrusted, conflicting,
or incomplete evidence grants no transition authority. Keep the complete
record and answer history available through crashes, claim takeover, flag
disablement, and comment cleanup so later sessions can replay it.

## Roadmap completion audits

Discover owns roadmap-level state. After it finds an open roadmap, it
can audit whether all explicitly referenced child work is complete
before selecting the next issue. Passing audits post a concise evidence
summary and close the roadmap; failing audits either add/link
autonomous follow-up issues or route human-dependent gaps to an explicit
blocked or needs-decision state. Roadmap-level side effects still use a
temporary claim on the roadmap issue itself, so concurrent agents do not
close or edit the same roadmap at the same time.
This roadmap claim is a coordination lock only: child issue claims stay
independent execution locks and can proceed in parallel unless blocked
by their own readiness or dependency rules. Roadmap-level blocker labels
still gate selection as described in Discover.

This audit intentionally lives before A2 rather than in F4. F4 is
limited to the PR that just merged and the local cleanup for that child
issue. F5 then loops back to Discover, where roadmap completion can be
checked with the broader parent context.

## Resume routing model

Resume now starts with a deterministic external-signal classifier before
claim-state branching. The classifier routes each run into one of four
paths: crash recovery, progress-stalled or rate-limit recovery,
stale-claim takeover, or ordinary clean continuation. This keeps crash
and stall handling separate without requiring the stalled session to
publish a final self-report.

## Autopilot operating model

The execution loop is **one issue = one short-lived session**: drive a
single Discover → Claim → Work → PR → Review → Merge → F4 cleanup cycle to
completion, then let the session end. All durable loop state — claims, PRs,
and issue/PR status — lives in the forge (GitHub), not in the agent's
context, so the loop does not need to be carried in one long-lived process:
a thin external runner or scheduler (or a dynamic-paced loop primitive)
re-enters Discover for the next unclaimed issue in a fresh session. This
composes with IDD's existing model — it ships no daemon and relies on an
external scheduler to drive the loop.

### Live-session E/F orientation

When a live session still owns its claim but is unsure what to check next
mid E/F-phase — not after a crash, takeover, or missing review snapshot —
use the existing gates as a navigation aid. The observed navigation failure
is recorded in source issue `kurone-kito/idd-skill#3494` (2026-09-26).
With helper runtime, use the
profile-selected `pre-merge-readiness` invocation documented under
[merge-gate evidence](idd-helper-scripts.md#merge-gate-evidence) for the
current PR, passing `--pr <n> --claim-issue <n>` and current
`--claim-id`, `--agent-id`, and `--nonce` flags when available. Route by its
`ready`/`blockers` verdict and then its `branchCurrency`, `threads`,
`unrepliedComments`, `reviewerStates`, `advisoryWait`, `ci`,
`dispositionEvidence`, `secondaryQuietWindow`, `claim`, and `closingSet`
sections to the existing E-phase or F-phase section that resolves the
blocker. Without helper runtime, use `idd-resume.instructions.md` Step 3's
CI-state × review-state table for the same routing. This is a pointer only:
it changes no phase behavior and creates no new rule.

Treat the **context window as a first-class, exhaustible resource**,
alongside wall-clock time and token budget. A single session that runs
F5 → Discover → … → F5 in-process accumulates every issue's tool output,
diffs, CI logs, and review threads, so each later issue pays a steadily
larger context-re-read cost — a direct cause of mid-run context exhaustion.
The monolithic single-session loop is therefore the **anti-pattern**;
prefer short sessions that exit at the F4/F5 boundary and let the runner
start the next one.

F4-complete / F5 is therefore the recommended **safe session-exit boundary**.
When context pressure hits mid-issue, a session can die mid-flight and leave a
partially-progressed issue (claimed, branch pushed, PR open, or mid-review) for
a later session to untangle. Finishing the current issue to the F4/F5 boundary
and exiting there converts that uncontrolled failure into a controlled handoff —
durable claim and PR state plus the existing resume phase let a fresh session
pick up cleanly at Discover, rather than starting another issue and risking a
mid-loop death.

Mid-review carries a narrower, equivalent boundary, and each point
below shares two conditions: no pending `Awaiting maintainer
decision` item remains, thread or regular comment (E7 permits one to
stay unresolved during triage, so its absence needs a separate check
at exit), and the worktree is clean with no local-ahead commit still
unpushed (the cold-start reconstruction section's edge case 2 pushes
one first, via E10-E12, before any point applies). A session may
deliberately exit after E3 completes with an empty snapshot (E1's
watermark alone is not enough -- E2's critique pass must actually run
first, which Resume's clean/successful-PR route to F2 does not
guarantee), after E8 finds zero Accepted PATH A items, or after a
round completes **both** E13 and E14: the
first point has no dispositions to preserve; the other two leave
every reviewer-visible disposition durable on GitHub. A successor
re-enters through Resume's own routing. E14 belongs in that boundary,
not only E13 — E1 Step 3 excludes a `CHANGES_REQUESTED` review body
only once it has **both** a reply and a re-review request, so exiting
right after E13's replies but before E14 requests review leaves that
body's exclusion condition unmet, and a fresh E1 pass re-surfaces it.
Exiting anywhere between
E4 and a round's completed E14 is not recommended — an Accepted-PATH-A
decision carries no durable marker until E13 posts it (E6 defers that
reply on purpose), and a `CHANGES_REQUESTED` body needs E14's request
too for its own exclusion to hold — so a session forced to exit or
resume there instead relies on the recovery procedure the
[ReviewItems_snapshot lifecycle](#reviewitems_snapshot-lifecycle)
section names.

This boundary covers same-session continuation and orchestrator
fan-out delegation, which already carries the active claim verbatim to
the next worker (see [Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation)).
It does not by itself authorize a genuine cross-session handoff: the
claim stays active and owned until released, so an unrelated session
that simply shows up hits `idd-resume.instructions.md`'s
non-owned-active-claim stop path. A deliberate operator-driven handoff
at this boundary uses [Operator-present release](../.github/instructions/idd-resume.instructions.md#operator-present-release)
instead of a new mechanism.

Short sessions need cheap ramp-up, which the "facts live in docs and
helpers, not in session memory" design already supports: a fresh session
reconstructs what it needs from the instruction files, `.github/idd/`
config, and forge state. This guidance is **advisory** — a recommended
practice with its rationale, not a hard requirement — and
**runner-agnostic**, since this repository ships no runner.

### E/F edge cases from field reports

Three situations from 2026-09-30 field reports have no complete written
answer in the phase files. None changes a gate; each cites its reported
incident.

- **A commit on the PR branch that this session did not write.** A
  maintainer applied Copilot Autofix in the GitHub web UI (committer
  `web-flow`, trailer "Co-authored-by: Copilot Autofix powered by AI")
  on a pull request that had one `github-advanced-security[bot]` thread.
  Reported 2026-09-30 (kurone-kito/idd-skill#3678): the thread ended
  resolved and outdated with no reply, the successor's local branch was
  one commit behind origin, and the `Bash tests (bats)` check was red on
  that commit because the autofix changed a shape a test mock relied on;
  nothing but CI validated the diff. Fetch and fast-forward the local
  branch (a branch behind origin is the benign case), let E1 take the
  moved head (`diffReviewSnapshot` already routes a moved head to E1 as
  `head-changed`), and run the repository's objective validation on that
  diff, because only CI has validated it. A resolved bot thread needs no
  marker-first reply: `classifyReviewThreadForGate` returns `resolved`
  for any resolved thread whoever wrote it, so it does not count toward
  the unresolved-threads gate, and the disposition-evidence gate skips
  it once the E1 watermark on the moved head is newer than its last
  external comment, so that E1 pass, not a reply, is what clears it. The
  fix itself stays unvalidated until CI or E12's lint and test step says
  otherwise. Whether the commit subject follows a convention is adopter
  policy.

- **A pull request that must not close its claimed issue.** Reported
  2026-09-30 (kurone-kito/idd-skill#3678): an acceptance criterion that
  only a later session can check after the merge (a throwaway pull
  request that must show a CI check passing) led an orchestrator to tell
  the worker to write `Refs`, not a closing keyword. The F2 collector
  then had no fitting mode: with `--claim-issue N` the closing set is
  `[N]` and `--closing-issues` must include the claimed issue number,
  while `--claimless` skips claim revalidation, so claim ownership was
  covered only by a gate script the session wrote. Split the issue
  instead, through the `issue-authoring` skill: an implementation issue
  that closes with its pull request and the closing keyword D3 requires,
  and a verification issue that carries the post-merge check. Do not use
  a `Refs`-only body for the claimed issue, and do not use `--claimless`
  to get around the closing set.

- **A closing link that stays empty.** D3.5 already says to wait, and
  not to edit the body, toggle draft, or close and reopen, while the
  pull request is under 4 hours old (by `createdAt`) and its keyword
  matches step 3's regex (kurone-kito/idd-skill#3660). Two adopters'
  reports add what it does not say: across seven pull requests the field
  stayed empty for 1 h 04 min to at least 2 h 24 min and healed without
  action, and the delay is neither a fixed age nor a shared clock time,
  so a session cannot plan the wait. To tell quickly whether the fault
  is platform-wide, sample one unrelated recent pull request that has a
  closing keyword and read its `closingIssuesReferences`: if that is
  also empty, keep waiting. The operator may also add the
  issue-to-pull-request link by hand in the web UI's Development
  sidebar.

### Orchestrator fan-out variant

A long-lived orchestrating session may run Discover and Claim itself and
delegate each claimed issue's B-through-F execution to an isolated
subagent, instead of a thin external runner re-entering a fresh session
per issue. This is an **explicitly supported alternative** to the
one-issue-one-session model above, not a replacement for it — the
monolithic-loop anti-pattern is about a single session accumulating every
issue's diff, CI log, and review-thread noise in its own context, and
the orchestrator avoids exactly that: its own context holds only claim
tokens, branch names, and each worker's final report, while the
per-issue noise stays inside each short-lived worker's own throwaway
context. Cross-issue bookkeeping (the claimed set, a concurrency budget,
one desync token reused across the run) is also cheaper to keep in one
orchestrating session than to reconstruct per invocation of a stateless
external scheduler.

The operating rules for this variant are in the
`.github/instructions/idd-orchestrator.instructions.md`, which an agent
reads only when its activation conditions hold or a fan-out session restarts.

The orchestrator's end-of-run report is defined under
[Orchestrator run report](#orchestrator-run-report). The `outcome` that each
worker's own final report carries for each way a run can end is listed under
[Worker report outcomes](#worker-report-outcomes).

Running this variant safely requires:

- **A non-context-inheriting delegation mechanism for the full worker role,
  from B1 through the merge policy's terminal phase, whenever the calling tool
  offers one — a
  strong preference, not merely a suggestion, per
  [Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation).**
  A context-inheriting worker (e.g. Claude Code's `fork` subagent) can
  let the orchestrator's own recent framing compete with, and
  sometimes override, the delegation brief's own role statement — the
  same problem [Critique pass invocation](#critique-pass-invocation)
  already avoids for Claude Code's narrower critique-pass role, since
  that row also picks a fresh `general-purpose` agent rather than a
  context-inheriting one. Extend that same preference to this full
  worker role whenever the tool exposes the choice; a
  context-inheriting mechanism is a fallback only for when no
  non-context-inheriting alternative exists, and even careful brief
  wording (the explicit role-statement text in
  [Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation))
  does not reliably close its residual role-misread risk — a
  documented known limitation (kurone-kito/idd-skill#2221,
  kurone-kito/idd-skill#2624, kurone-kito/idd-skill#2802).
- **A concurrency cap**, set by `orchestrator.maxWorkers` and enforced on each
  dispatch by `idd-worker-budget` (see the
  `.github/instructions/idd-orchestrator.instructions.md`), sized
  against CI-minute cost,
  shared-file contention, and host capacity rather than raised without
  bound. The optional `discover-shared-file-overlap` helper (see
  [IDD helper script evaluation](idd-helper-scripts.md#discover-shared-file-overlap-contract))
  reports high-contention shared-file overlap evidence to inform both
  the cap and the delegation order. Neither CI-minute cost nor
  shared-file contention reflects host capacity: a worker's own build
  and test children compete for the same cores and memory as every other
  session on the host, so run a cheap preflight before each dispatch.
  Compare the 1-minute load average (`uptime`) with the core count
  (`nproc`, or `sysctl -n hw.ncpu` on macOS), and read the available
  memory (`MemAvailable` in `/proc/meminfo`, or the platform
  equivalent). As starting values an operator may tune — this guide's
  own starting choice, not measured limits — start no new worker while
  the 1-minute load exceeds the core count or the available memory is
  under 2 GiB. A `host-load` stop with a readable load and core count is
  waited out: the orchestrator re-checks every 60 seconds and dispatches once
  `orchestrator.hostLoadClearStreak` (default 3) consecutive readings have a
  free slot, stopping at `orchestrator.hostLoadWaitCeiling` (default `PT30M`).
  A memory stop is not waited out; dispatch fewer workers instead. In one
  orchestrated private downstream adopter's run (reported 2026-09-30,
  kurone-kito/idd-skill#3677), a delegated worker's tool calls stopped
  returning and the runtime ended it (`Agent stalled: no progress for
  600s`) while the 1-minute load average read 90.87 on 24 cores and no
  memory was available, and full-suite runs failed on timeouts in
  unrelated specs that all passed alone.
- **Instruction freshness.** An orchestrator session reads its instruction
  files once but can run for many hours, so a rule that lands on the base
  branch mid-run never reaches it. In the 2026-10-14 to 2026-10-15 run, pull
  request kurone-kito/idd-skill#4290 (merged 2026-10-14T16:36Z) added the
  host-load wait rule after the session had read its files, and the session
  kept using a single reading (no issue records the incident). Every
  `idd-worker-budget` call after the first baseline is set, the host-load
  re-checks included, therefore passes `--instructions-since` with the
  baseline, run from the repository root because the helper reads the policy
  file from the working directory. It reads local refs only and never
  fetches, so the workers' own `git fetch origin` in B1 and F4 keeps its base
  ref current, and it needs git 2.28 or newer. Its `instructionsChanged` lists
  the paths under `.github/instructions/` and `docs/idd-workflow.md` that
  differ between the baseline and `instructionsTip`, the commit the base ref
  resolves to. Only a listed file that this session already loaded is re-read.
  - The first baseline is `git rev-parse HEAD` of the primary checkout when
    the session reads the orchestrator file; a restarted session takes a new
    one the same way.
  - Every later call passes the baseline. The baseline advances to the
    `instructionsTip` of a call only after every listed file that this session
    already loaded has been re-read, so a change is reported until it has been
    read and then not again.
  - A call that reports an error, including a baseline that is not an
    ancestor of the tip, leaves the baseline as it is. To recover, when
    `instructionsTip` is not null, the orchestrator re-reads every file it
    loaded and then takes that tip as the baseline. If the next call reports
    an error again, it stops passing `--instructions-since` for the rest of
    the session and tells the operator once.
  - A changed file is re-read with `git show <instructionsTip>:<path>`, which
    does not depend on the state of the checkout; a file the session first
    loads later is read the same way, because the checkout may lag the tip. A
    deleted path needs no re-read and counts as removed. `git show` reports
    such a path as absent from the tip.
- **Full per-issue gating before every delegation.** The orchestrator
  runs the complete A4.5/A5 suitability and claim gates (and the A4
  viability gate that precedes them) for each issue before handing it to
  a worker; claiming several issues concurrently is never a shortcut
  around those gates. A pick that fails A4.5, or A5 before or after the claim
  marker is posted, starts no worker and gets no roster entry, and only a later
  full Discover run reconsiders the pick; a failure after the marker is
  contested and keeps its claim and worktree.
- **A delegation brief that restates the background-wait topology
  warning and the worker's exit boundary.** Each worker's brief must
  carry the
  [wake-up discipline](../.github/instructions/idd-ci.instructions.md#wake-up-discipline)
  topology-safety condition, so a worker never assumes an unconfirmed
  background wait resumes its own turn: the worker must wait
  synchronously or with a confirmed topology-safe wake for any
  backgrounded command, and must not end its turn until that wait has
  a confirmed result (kurone-kito/idd-skill#2221,
  kurone-kito/idd-skill#2624). When the orchestrating session already
  has a same-session sibling worker that stalled this way, the brief
  must cite that sibling failure by name. The brief must also state
  that the worker's execution ends at the merge policy's terminal phase (F4
  under `fully_autonomous_merge`, F2.5 otherwise): the worker reports its final
  result back to the orchestrator instead of
  independently entering F5's Discover step, so Discover/Claim
  ownership stays with the orchestrator alone. When the run is scoped to end
  earlier than that terminal phase, whether by the operator or by the
  orchestrator (for example, "stop at F2"), the brief must name that boundary
  and say that finishing that phase and stopping there with no gate or unmet
  condition blocking is a scope stop, not a hold: the worker's report draft
  carries `scope-stopped` and not `held`. A gate or unmet condition that
  blocks the run before or at the boundary is a hold, and a scope relayed after
  dispatch carries the same statement (see
  [Worker report outcomes](#worker-report-outcomes)). The
  [Delegation brief template](#delegation-brief-template) assembles the
  elements of the brief bullets in this list into one fill-in form.
- **A delegation brief that requires issue-number-namespaced
  scratchpad filenames.** Concurrently delegated workers share the
  orchestrating session's own scratchpad directory — it is
  session-scoped, not subagent-scoped — so a generic filename
  (`pr-body.md`, `commit-msg.txt`, `plan-draft.md`, etc.) one worker
  writes under its brief can collide with, and be silently
  overwritten by, a sibling worker writing the same name under its
  own brief. Each delegation brief must instruct its worker to
  prefix every scratchpad file it creates with the issue number (for
  example `2878-pr-body.md`), or to create and use an issue-numbered
  scratchpad subdirectory, instead of a generic filename a sibling
  worker might independently produce too under its own brief (observed
  2026-09-10, kurone-kito/idd-skill#2900). This is a separate
  requirement from the background-wait topology-safety condition
  above — a namespacing convention for concurrent scratchpad writes,
  not a wake-up-discipline concern.
- **The delegation brief carries the claim token verbatim, nonce
  included — and the worker actively revalidates it.** The worker
  adopts the orchestrator's already-verified `{agent-id}` / `{claim-id}`
  pair as its own for the run (mirroring forced-handoff adopt-verbatim),
  carrying the orchestrator's current activation nonce rather than
  minting a new one — a minted nonce would collide with the
  orchestrator's for the same `{claim-id}` and flag legitimate
  delegation as a second activation. Before each mutation, the worker
  recomputes the nonce winner and confirms it still matches the carried
  value, the same safety check a self-posting session performs. See
  [Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation).
- **Serialized worktree/clone lifecycle operations when workers share
  one clone.** Concurrent `git fetch` / `git worktree add` / `git
  worktree remove` / local `{development-branch}` updates from the
  same primary clone can collide; serialize these specific operations
  behind the [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock),
  or give concurrent workers separate clones, once the concurrency cap
  allows more than one worker at a time.
- **Resume-specific recovery when a worker dies mid-turn.** Re-verify
  claim ownership and worktree state before continuing; treat any
  uncommitted work found in the worktree as unverified input to check,
  never as something to trust or silently discard. Also check for a
  stale clone-scoped lock before redelegating -- skip this check under
  `instructions-only` running one worker at a time, which never
  contends for the lock; see
  [Clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock) for that
  profile's own multi-worker-one-clone caveat: run
  `node scripts/clone-lock.mjs --check` (or the profile-selected
  `idd:clone-lock` command with `--check`, per that same section, for
  the literal per-profile invocation) and, if it reports the lock
  present, follow that same section's manual-recovery procedure in
  full -- by design this lock never auto-recovers a stale holder
  (observed 2026-09-01, kurone-kito/idd-skill#2223,
  kurone-kito/idd-skill#2389) -- before delegating a fresh subagent
  with a resume-specific briefing rather than resuming the dead
  worker's own
  context. The exception is a worker the runtime can still message or
  resume (for example by its agent id), such as one it reported stalled
  or ended while its claim and worktree were still intact: resuming that
  same worker with freshly verified facts is an accepted, cheaper path
  than a fresh subagent, provided the orchestrator first verified the
  claim, the worktree, and the child processes the worker still has
  running (for example in the process table). Those children are waited
  for, by PID, and never duplicated by a second copy — a fresh worker
  would start a second heavy run on the same host. On an in-place
  resume, still run the same lock check: a present lock whose
  `holderAlive` is true is expected and is waited for, never removed; a
  present lock whose holder is gone is stale and takes the
  manual-recovery procedure above. A worker that can no longer be
  messaged keeps the fresh-subagent path above, and the replacement's own
  start identifier then replaces the roster entry's handle, which is the
  `workerHandle` of its report. In a downstream
  adopter's run (reported 2026-09-30, kurone-kito/idd-skill#3677), the
  orchestrator verified claim routing, `git log`, the pull request list,
  and the process table, sent one message to the same worker with those
  facts and one instruction (wait for the child by PID, do not start a
  second full run), and the worker continued from its own context and
  reached F2 in about 80 minutes without repeating work.
- **A delegation brief resuming mid-review at E4 or E9 must run the
  cold-start reconstruction.** A fresh worker dispatched straight into
  E4 or E9 without a `ReviewItems_snapshot` from its own E1-E3 pass
  must not assume `ReviewItems_snapshot` still reflects live state —
  see the ReviewItems_snapshot lifecycle section's Cold entry outside
  Resume
  note above and `idd-review-snapshot.instructions.md`'s cold-start
  reconstruction section. This covers only those two named entry
  points; a brief that instead hands a worker into E10, E13, E14, or
  E15 has no supported cold-entry route yet -- stop and report rather
  than improvising one.
- **Independently verify a worker's reported terminal outcome before
  trusting it.** A worker's final-turn text describes what it
  _attempted_, not proof of what actually landed on the forge. Before
  dispatching the next worker or otherwise acting on a reported "merged"
  outcome, confirm live GitHub state directly — for example
  `gh pr view <n> --json state,mergedAt` and
  `gh issue view <n> --json state,closedAt` — rather than trusting the
  worker's own narrative. A runtime's completed notice that says the
  worker still has background work of its own running, or that its
  result may be interim, is not final: check the worktree and the claim,
  and wait for the worker to resume while there is live evidence of the
  background work it reported (a running child process, a background
  task the runtime still lists as running, or new worktree changes),
  restarting the wait on each new piece of evidence; after one runtime
  stall interval (the runtime's own no-progress limit) with none and no
  resume, apply the dangling-state check below. A completed notice with
  no such statement is a real stop: verify its outcome as above. In a
  downstream adopter's run (reported 2026-09-30,
  kurone-kito/idd-skill#3677), one worker ended its turn four times with
  "still waiting on the review delegate; I will continue when it lands"
  while a background task of its own was running, the harness reported
  each stop as completed with an interim note, and each time the worker
  resumed on its own; a fifth notice carried no such note and was a real
  stop, so an orchestrator that read "completed" as final would have
  verified "merged?", found no, and re-delegated.
- **Check for dangling or broken state after an ambiguous worker
  dispatch.** When a worker's turn ends without a clean final report
  (stalled, killed, timed out) — especially if its last visible action
  was a mutating step such as an F3 merge-execution command — check for
  a PR left in a failed-merge-attempt state (e.g.
  `gh pr view <n> --json mergeable,mergeStateStatus`) or an orphaned
  claim before dispatching further workers, rather than assuming success
  or failure either way.
- **Hold marker.** A worker that stops at a hold posts, on the claimed issue,
  a comment whose first bytes are `<!-- idd-hold: {agent-id} {claim-id}
  {ISO8601-timestamp} -->`, followed by a short visible note (`_{agent-id}:
  issue hold — IDD automation marker. Do not edit._`), through
  `post-idd-marker --type idd-hold --target issue <n> --agent-id <id>
  --claim-id <id> --timestamp <ISO8601> --apply` or, where no helper runtime
  exists, the direct JSON `POST` path. Without `--apply` the command only
  previews the body. The claim parser never reads this marker, so it cannot
  change who owns the claim; the orchestrator reads it from the issue comments
  by the trust rule below, which `resolveTrustedHoldMarkers` implements (the
  Hold marker contract in `idd-helper-scripts.md` covers the helper side). The
  delegation brief must tell the worker to post it when it stops at a hold. A
  delegated worker posts it after its last `claimed-by` and posts no
  `claimed-by` while the hold lasts, because the orchestrator owns the hold
  heartbeat; this is the fan-out exception to the shared Hold / suspend 12 h
  re-post. A hold marker is trusted only when the actor that posted the active
  claim's `claimed-by` also posted it, and its agent id and claim id match
  both the active claim and the claim this session recorded for that roster
  entry in section 3 step 4, because the ids alone are public. It also needs
  an explicit GraphQL `lastEditedAt: null`, resolved for each returned comment
  by node id; an edited marker, or an edit state that cannot be resolved, is
  ignored, as the claim-family marker edit-state contract in
  `idd-helper-scripts.md` requires. A held worker is a roster entry that is
  not `disposed` whose claim has a trusted hold marker newer than its latest
  valid `claimed-by`, not counting the orchestrator's own renewals of that
  claim. The hold starts at the earliest such marker's GitHub `created_at`,
  not its embedded timestamp. The hold ends when the worker posts any other
  valid `claimed-by` (one the claim parser recognizes as a heartbeat for this
  claim, so a trusted, unedited comment with the active claim's ids and
  branch; an anomalous or invalid one is ignored), when the entry is
  `disposed`, or when the claim is released or superseded. A resumed worker
  follows the normal report path. A released or superseded claim cannot be
  renewed, so the orchestrator marks its entry `stalled` and follows the
  worker-specific recovery, which re-verifies the claim and reports its state
  to the operator; the entry leaves `--running` only when that recovery
  disposes of it. A restarted orchestrator cannot tell its earlier renewals
  apart, so it treats any valid `claimed-by` newer than the marker as ending
  the hold and renews nothing.
- **Held-worker renewal.** A held worker, as the hold marker defines, is
  renewed at the orchestrator's wake-ups in section 4 of its phase file. A
  worker that completes while held skips the report and disposal of section 5:
  its entry stays `reporting`, and the renewal runs at those wake-ups. At or
  after 72 h from the hold start, the claim revalidation gate confirms the
  active claim is still this claim; the orchestrator then posts `unclaimed-by`
  for it and records the hold and cap in
  [the run report](#orchestrator-run-report). Once that post succeeds,
  nothing is appended to the worker report store, because a claim released
  without a merge or handoff has no terminal phase (Orchestrator restart, step
  4); the release goes in the run report, and the entry is then marked
  `disposed`. Before the cap, each `claimed-by` re-post, due every 12 h from
  the latest valid one, first has the claim revalidation gate confirm the
  active claim's agent id and claim id, then copies its `branch` verbatim. A
  failed heartbeat is retried once; if the retry also fails, the run report
  records the hold and the failed post, and the claim is left untouched. A
  failed 72-hour `unclaimed-by` leaves the claim in place, and the run report
  records that the cap was reached and the release post failed. In both cases
  the orchestrator posts no second claim id and starts no new claim.

#### Delegation brief template

The orchestrator fills in this block to write each worker's delegation brief.
It puts the elements that the brief bullets above,
[Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation),
and section 5 of the orchestrator phase file require into one form, and it links
their rules instead of restating them. Replace each single-brace placeholder
with its value from the list below, and copy the parts into the brief. The link
targets are relative to this file, so rewrite each one to a repository-root path
(for example `docs/idd-workflow.md#worker-delegation`) when you copy it. A "Fill
note" paragraph addresses the orchestrator, so it is not copied. The incident
counts in the notes come from the operator's retrospective of the source
repository's 2026-10-14 to 2026-10-15 orchestrator run, which is kept outside
the repository.

- `{issue-number}`: the claimed issue.
- `{agent-id}` and `{claim-id}`: the claim token the orchestrator verified,
  verbatim.
- `{nonce}`: the orchestrator's current activation nonce, verbatim and never
  minted anew.
- `{branch-name}`: the branch named in the claim marker.
- `{worktree-path}`: the worktree the orchestrator pre-created for the claim.
- `{scratchpad-dir}`: an issue-numbered subdirectory of the scratchpad path that
  the harness reports (see the Scratchpad part).
- `{report-path}`: the worker's report draft, a file whose name starts with the
  issue number, directly in the scratchpad path that the harness reports.
- `{terminal-phase}`: F4 under `fully_autonomous_merge`, F2.5 otherwise, or
  the earlier phase that the run is scoped to end at (see the Terminal phase
  part).

**Role.** You are the sole worker for issue `{issue-number}`. No peer worker
exists for it, so there is nobody to coordinate with or to wait on for a reply;
a critique agent that the Critique allowance part permits is not a peer. Do
the implementation yourself and do not re-delegate it. See
[Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation).

**Claim token.** Your claim token is `{agent-id}` / `{claim-id}` and your
activation nonce is `{nonce}`. Adopt them verbatim and mint neither a new claim
nor a new nonce. Before each mutation, recompute the nonce winner for
`{claim-id}` and confirm that it still equals `{nonce}`; a different winner
means the claim is lost. See
[Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation).

**Branch and worktree.** Your branch is `{branch-name}` and your worktree is
`{worktree-path}`, already created: reuse it without B1, running only the
dependency install and checking that `git rev-parse --abbrev-ref HEAD` returns
`{branch-name}`, and do your work there. Before any branch-state action, open D1
in
[idd-pr-submit.instructions.md](../.github/instructions/idd-pr-submit.instructions.md#d1--sync-development-branch-before-first-push)
and the "E-phase branch-sync check" section of
[idd-review-triage.instructions.md](../.github/instructions/idd-review-triage.instructions.md#e-phase-branch-sync-check),
and do not paraphrase either.

**Wake-up discipline.** Never end your turn while a background wait or a
background command is unresolved, because a completion notice can reach only the
orchestrator. Wait synchronously, or with a confirmed topology-safe wake, as the
topology-safety condition of the
[wake-up discipline](../.github/instructions/idd-ci.instructions.md#wake-up-discipline)
says.

Fill note: when a same-session sibling worker has stalled this way, add a line
that cites that failure by name.

**Execution timeout.** Before a CI watch or a heavy local command, set the
execution-timeout override that the
[wake-up discipline](../.github/instructions/idd-ci.instructions.md#wake-up-discipline)
names, near the calling tool's own ceiling.

**Terminal phase.** You run your whole span through `{terminal-phase}`, then
report back to the orchestrator and do not enter F5's Discover step. Your
worktree was pre-created, so it takes the B1 skip of "Already inside a
host-isolated worktree" in
[idd-work.instructions.md](../.github/instructions/idd-work.instructions.md#already-inside-a-host-isolated-worktree).

F4 cleanup, for a run that ends at F4. Under `fully_autonomous_merge` that means
every step of
[F4](../.github/instructions/idd-merge.instructions.md#f4--cleanup), with the
[F4 head proof](idd-resume-detail.md#f4-head-proof) reused or captured before
step 3, ending with step 7's final `unclaimed-by`. The F4 skip of that section
(skip the primary-worktree steps and the worktree removal, and let the harness
reclaim the checkout) applies only when the harness itself reclaims the
worktree. The orchestrator created yours on the shared clone, so you run F4
steps 4 and 5 yourself, with step 4's fetch and step 5's worktree removal behind
the [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock), as the lock
sentence of F4 step 4 says, and that overrides "let the harness reclaim it".
Both steps run from the primary worktree, which is the first entry of
`git worktree list`: change into it before step 4 and stay there for step 5,
which removes your own worktree and branch. Never remove the checkout that you
are standing in.

Fill note: when the run is scoped to end before the merge policy's terminal
phase, name that earlier phase as `{terminal-phase}` and add that finishing it
and stopping there, with no gate or unmet condition blocking, is a scope stop
and not a hold: the report draft carries `scope-stopped` and not `held`. When
`{terminal-phase}` is not F4 (F2.5 or an earlier phase), delete the whole
paragraph that begins "F4 cleanup, for a run that ends at F4" and keep the rest
of this part, because no cleanup runs before a merge. When the worker has its
own clone, rewrite the sentence about the shared clone and drop the clone-scoped
lock clause from that paragraph. A brief line
that forbids edits in the primary worktree must exempt F4 steps 4 to 6, which
run from the primary worktree. The shared-clone override and this exemption are
preventive; no observed incident yet. Observed in the source repository's
2026-10-14 to 2026-10-15 orchestrator run (no issue records the incident
itself): most briefs drew the worker's span too narrowly, so the orchestrator
finished the F4 steps by hand for most workers.

**Scratchpad.** Your scratch files go only in `{scratchpad-dir}`, an
issue-numbered subdirectory of the session scratchpad, with these exceptions:
your report draft at `{report-path}`, and the critique scratch directory that
Critique pass invocation names, if you start a critique agent. Never write
scratch files in `{worktree-path}`, the pre-created worktree that you reuse.
Concurrently delegated workers share the scratchpad, so the issue-numbered
directory keeps your files apart from theirs, as the
[fan-out variant](#orchestrator-fan-out-variant) requires. Before you create it,
confirm that its parent path already exists. When the parent path is missing,
create nothing and end the run as a hold: post the hold marker of the Hold
marker part, and let your report draft carry `held`, as for any hold; if
`{report-path}` cannot be written because the parent path is missing, the hold
marker alone is the report. Create the directory with a plain mkdir and never
use mkdir -p, which would build a mistyped parent path instead of failing. If
the directory already exists, reuse it. If it cannot be created although the
parent path exists, fall back to prefixing each scratch file you write in that
parent path with the issue number, for example `2878-pr-body.md`.

Fill note: copy the scratchpad path that your harness reports, and hand the
worker an issue-numbered subdirectory of it as `{scratchpad-dir}`. Never type
the path by hand. Observed in the source repository's 2026-10-14 to 2026-10-15
orchestrator run (no issue records the incident itself): one brief went out
with a mistyped scratchpad path and needed a correction message to the running
worker.

**Critique allowance.** For the critique pass only, you may start a
non-context-inheriting agent, as a carve-out from the Role part. Follow
[Critique pass invocation](#critique-pass-invocation) in full, including the
rules that its critique brief states, for the wait ceiling, the stop tool, the
wake-up, the scratch directory, and the scratch check. If you cannot confirm
that you can arm a wake-up and stop the agent, as the pre-launch check in that
section requires, start no agent and run an inline self-critique instead. Never
end your turn while a critique agent is still running.

Fill note: keep this part only when the Limits column of the
[Worker delegation](#worker-delegation) table allows it. The worker sits at
nesting depth 1 and its critique agent at depth 2, so the limit must be at least
depth 2 for the worker's harness: Claude Code lists a nesting depth of 3, and
Grok Build lists one level, so there the critique stays an inline self-critique,
as it does for a Limits cell that is `unverified` or gives no depth. Keep it
only when the worker is not a context-inheriting fork either, because the
Known limitation in `claim-orchestrator.instructions.md`, which
[Orchestrator delegation](../.github/instructions/idd-claim.instructions.md#orchestrator-delegation)
points at, records that fallback's
[residual role-misread risk](idd-design-rationale.md#context-inheriting-delegation-residual-risk).
Otherwise replace the body of this part with one line that tells the worker to
run each critique pass as an inline self-critique, and remove the clause about a
critique agent from the Role part and the "and the critique scratch directory"
exception from the Scratchpad part. The Limits gating is
preventive; no observed incident yet. Observed in the source repository's
2026-10-14 to 2026-10-15 orchestrator run (no issue records the incident
itself): none of about 25 briefs allowed the critique agent, so the workers'
critiques ran inline.

**Hold marker.** When you stop at a hold, post the `idd-hold` marker on the
claimed issue after your last `claimed-by`, as the Hold marker bullet of the
[fan-out variant](#orchestrator-fan-out-variant) says, and post no `claimed-by`
while the hold lasts: the orchestrator owns the hold heartbeat. Your report
draft then carries `held`.

**Review cold start.** Do not assume that `ReviewItems_snapshot` still reflects
live state. Run the
[cold-start reconstruction](../.github/instructions/idd-review-snapshot.instructions.md#cold-start-reviewitems_snapshot-reconstruction)
and the Cold entry outside Resume note of the
[ReviewItems_snapshot lifecycle](#reviewitems_snapshot-lifecycle).

Fill note: include this part only when the brief hands the worker into E4 or E9
without a `ReviewItems_snapshot` from the worker's own E1 to E3 pass. A brief
that hands a worker into E10, E13, E14, or E15 has no supported cold-entry route
yet, so stop and report instead.

**Worker report.** Write your final report as a draft to `{report-path}`,
outside the worktree. Fill the fields of `schemas/worker-report.schema.json`:
`schemaVersion`, `issue`, `pullRequest`, `claimId`, `harness`, `workerHandle`,
`terminalPhase`, `outcome`, and the optional `stalls`,
`deviations`, `frictions`, `followUps`, and `unfiledFollowUps`. Use
`followUps` only for issues you filed; put textual follow-ups you identified but
did not file in `unfiledFollowUps`. Give `workerHandle` any non-empty
value, such as `{agent-id}`, which the orchestrator overwrites from its roster
entry, and leave `verifiedAt` and `recordedAt` out, because you cannot know
them. Also leave `reviewRounds` out: the orchestrator derives it from the
pull request's reviews. Do not append the draft to the
[worker final report store](idd-helper-scripts.md#worker-final-report-store),
because the orchestrator checks it against live GitHub state first. The
`outcome` that the draft proposes follows
[Worker report outcomes](#worker-report-outcomes).

Fill note: set `{report-path}` to a file whose name starts with the issue number,
for example `2878-worker-report.json`, directly in the scratchpad path that the
harness reports, because an orchestrator restart looks there for report drafts.
At verification, the orchestrator computes `reviewRounds` from the complete
review list for a non-null `pullRequest`:

```bash
set -o pipefail
if gh api --help | grep -F -- '--slurp' >/dev/null; then
  gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --paginate --slurp |
    jq '[.[][] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length'
else
  gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --paginate |
    jq -s '[.[][] | select(.user.login == "copilot-pull-request-reviewer[bot]")] | length'
fi
```

Replace the placeholders before running the command. It uses `--slurp`
when the installed `gh` supports it. Older versions emit one JSON page per
line, so the fallback uses `jq -s` to wrap those pages into the same array
shape. Both paths require `jq`. The command counts all review states, across
all pages and claims. A worker or older draft value is never used. Use the
printed value only when the full command exits with status 0; discard all
output on a nonzero exit. Omit the field when `pullRequest` is null, `jq` is
unavailable, or the command cannot read the complete count; never record a
partial count. The orchestrator completes the rest of the draft, as section 5
of the orchestrator phase file says.

### Orchestrator run report

The **run report** is the orchestrator's end-of-run report to its operator. The
orchestrator writes it as a message in its session each time it stops
(including the stops in section 4 of the orchestrator phase file) or pauses to
wait for the operator (its turn ends awaiting an operator reply), and the
operator reads it there. Each report lists the whole state, not only what
changed since the last one. Waiting for a worker's completion, a host-load
re-check, or a renewal due time is neither a stop nor a pause.

At minimum it lists:

- **Roster.** Each roster entry, with its issue number and its final state, the
  state it is in when the report is written: `running`, `reporting`,
  `disposed`, or `stalled`, as section 2 of the orchestrator phase file lists
  them.
- **Holds.** Each hold, with its issue number, its start as the hold marker
  defines it, its cap time (72 h after the start, per the held-worker renewal
  rule), the GitHub `created_at` of the latest valid `claimed-by` on its claim,
  and how it stands: still held, released at the cap, or ended by a cause the
  hold marker defines (the worker's valid `claimed-by` or, after a restart, any
  valid `claimed-by` newer than the marker, which can be the earlier run's own
  renewal; a release other than the cap release; a supersession; or the
  entry's disposal). Once no living orchestrator renews a hold, the stale clock
  (`claim-stale-age`, 24 h by default) counts from the latest valid
  `claimed-by`.
- **Failures.** Each renewal or release that failed since the run began, even
  if a later wake-up's attempt succeeded, with its issue number, its claim id,
  and which post failed and when (the 12 h `claimed-by` re-post, once its one
  retry has also failed, or the 72-hour `unclaimed-by`) and, for the
  `unclaimed-by`, that the cap was reached. A failed post leaves its entry
  where it stands, not `disposed`, and the failure stays listed in every later
  report.

It also carries any gap the Discover pass says to name in "the run report" (for
example an incomplete parked-issue listing) and the `limitingFactor` that
section 4 of the orchestrator phase file has the orchestrator report when a
limit stops it. Any other report to the operator that the IDD instructions or
this guide require is made at the step that requires it; this report neither
defers nor replaces it.

The orchestrator notes each item when it happens and writes them out together,
so an entry can be `disposed` before the report is written. The report is a
message, not a store: it is not a file, an issue comment, or a record in the
worker final report store, which holds per-worker records and receives nothing
from a cap release, and no helper reads it. A session that ends without writing
it leaves no report (preventive; no observed incident yet). A restart that can
recover (see [Orchestrator restart](#orchestrator-restart)) rebuilds the roster
from the forge, the worktrees, and the harness's agent listing, never from a run
report, and the new run writes its own.

### Worker report outcomes

A worker writes its final report as a draft. Once the orchestrator has checked
the draft, it becomes one record in the
[worker final report store](idd-helper-scripts.md#worker-final-report-store),
and its `outcome` says how the run ended; a held worker is the exception, as the
`held` bullet below says. The report is the worker's own, not the
orchestrator's [run report](#orchestrator-run-report). The store and
`schemas/worker-report.schema.json` list the values and define `scope-stopped`.
This subsection says which value each way of ending a run carries. The draft
proposes the value, and the orchestrator checks it against live GitHub state
before it appends the record, as section 5 of the orchestrator phase file and
the "Independently verify a worker's reported terminal outcome before trusting
it" bullet of the [fan-out variant](#orchestrator-fan-out-variant) require. For
`scope-stopped`, live state can only rule out the other values; the paragraph
after the list says what supplies the rest.

- `merged`: the worker's pull request merged and no trusted handoff summary was
  posted.
- `handed-off`: a trusted handoff summary carrying the worker's claim id is on
  the issue, whatever its pull request has done since.
- `held`: a gate or an unmet condition stopped the run. A worker held on a
  trusted hold marker is not reported or disposed of while the hold lasts, so no
  record is appended then. The Hold marker and Held-worker renewal bullets of
  the [fan-out variant](#orchestrator-fan-out-variant) say what the
  orchestrator does instead, and the [run report](#orchestrator-run-report)
  lists the hold.
- `scope-stopped`: the run finished the phase it was scoped to end at, earlier
  than the merge policy's terminal phase, and stopped there with no gate or
  unmet condition blocking it.
- `abandoned`: the worker's pull request was closed without merging and no
  trusted handoff summary was posted.
- `failed`: none of the above fits.

Live GitHub state cannot confirm a scope stop: all it shows is a claim still
held with no handoff summary and no trusted hold marker, which a stop at a gate
can also leave. So the orchestrator checks a `scope-stopped` draft against the
boundary that the brief, or an instruction the orchestrator later relayed to the
worker, named. The draft's `terminalPhase` must be that phase, and live state
must show none of the other values above. When it shows one, that value is
recorded instead, except that a worker held on a trusted hold marker gets no
record while the hold lasts, as the `held` bullet says. When the brief is not
available or names no such boundary, no `scope-stopped` record is appended and
the claim is reported to the operator. A phase is finished when its normal exit
is met, so a run still waiting inside it, for example on pending CI, has not
reached the boundary. Storing a scope stop as `held` inflated the `held` count
(observed 2026-10-13 on the worker records of kurone-kito/idd-skill#3974,
decided on kurone-kito/idd-skill#4213, requested in kurone-kito/idd-skill#4348,
added by kurone-kito/idd-skill#4354).

[Orchestrator restart](#orchestrator-restart) has no `scope-stopped` case: step
4 maps a claim still held to `held` and appends nothing for it when no draft is
found, and step 3 sends a finished worker whose claim is still held with no
handoff summary to worker-death recovery. How a restart treats a scope stop is
not defined here.

### Orchestrator restart

This subsection covers an orchestrating session that restarts with its
session-suffixed agent id, as the 2026-10-11 session did (issue
`kurone-kito/idd-skill#4014`). Under the default shared `{agent-id}` with no
session suffix, the session cannot tell its claims from another session's, so
recovery is unavailable: it reports its claims to the operator and does not
refill. The roster is not stored anywhere locally, so the steps below rebuild it
from the forge, the worktrees, and the harness's agent listing. A session with a
new id cannot identify its old claims, and step 1 treats them as not its own.

1. **Find own claims.** For each worktree in `git worktree list --porcelain`,
   list `idd-generated-tokens-*.json` in that worktree's private admin directory
   (`git -C <worktree> rev-parse --absolute-git-dir`). A `prunable` entry, or
   one whose path no longer exists, is not read: it is noted, and a claim whose
   branch or lock it still names is reported to the operator. The scan then goes
   on with the readable entries. Each file holds `agentId` and `claimId`, and a
   `nonce` when one was recorded. One worktree can hold several files. A claim
   is own only when its `agentId` equals this session's session-suffixed
   agent-id and its `agentId` and `claimId` both match the trusted `claimed-by`
   marker for the same issue. The agent-id alone never proves ownership, because
   the claim id is the authoritative token. A session with no unique session
   identity cannot recover its claims: it reports them to the operator and does
   not refill. Claims that are not own are not dispatched again, and they are
   reported to the operator. A worktree that has claim evidence, such as a claim
   lock or an `issue/<number>-<slug>` branch, but no readable token record is
   reported to the operator rather than skipped, because the claim contract
   treats that state as fail-closed. A worktree with no claim evidence, such as
   the primary checkout, is not reported. F4 removes the linked worktree, with
   its admin directory and this token file, before it posts the final
   `unclaimed-by` marker. So a claim whose F4 removed its linked worktree has no
   token file there. A record in the primary worktree's directory can survive
   F4. Keep at most one record per claim-id: prefer the linked worktree's
   record. A primary-directory record makes a claim worktree-less only when no
   linked worktree carries that claim's branch or lock, and it is a hint only:
   the trusted claimed-by marker for its issue must also carry this session's
   unique agent-id and the same claim id. A linked worktree that does carry it,
   but has no readable token record, is reported to the operator as unreadable
   and is not treated as worktree-less. A readable linked record stays
   authoritative. For a worktree-less claim, take the issue number from the
   worker's brief in the agent listing, or from the issue-number prefix of its
   report draft in the session scratchpad, and never from the default branch. Then
   read that issue's trusted `claimed-by` and `unclaimed-by` markers for the
   agent-id and claim-id, and apply the same test, so that both the agent id and
   the claim id must match the marker. Also enumerate the candidates for
   worktree-less claims from the report drafts in the session scratchpad, the
   finished entries in the agent listing, and the running entries whose worktree
   is gone, and read each such issue the same way. An issue whose trusted
   markers name another agent-id, or no claim, is not own. If neither source
   gives an issue number, report the claim to the operator and take no further
   action on it.
2. **Verify each own claim.** For a claim with a linked worktree, take `--issue`
   from its branch, `issue/<number>-<slug>`, and confirm it against the trusted
   `claimed-by` marker that carries the same claim-id, because the token record
   holds no issue number. Run the profile-selected `resume-claim-routing`
   command (see `docs/idd-helper-scripts.md`) with `--assert`, `--issue`,
   `--claim-id`, `--nonce` (when the file holds one), and `--worktree <path>`.
   Continue to step 3 only when the command exits 0, which means the state is
   `already_owned` with action `keep`. A claim that a worker released with its
   `unclaimed-by` marker, as F4 does as its last mutation before returning the
   final report, is the one exception. Its `--assert` run exits 1 by design, so
   read its verdict from stdout: when `evidence.released_claim.claim_id` equals
   this claim-id and either the state is `unclaimed`, or the state is
   `local_worktree_occupied` with the reason
   `released-claim-local-worktree-occupied`, the claim goes to step 3 for worker
   matching only, where its running worker, if any, is counted and sent no
   message, and then to step 4. `stale` goes to the takeover path in
   `idd-resume.instructions.md`. A claim with no worktree needs no `--worktree`:
   run the command without `--assert` and read its `state`. The released-claim
   result above applies to it as written, and so does `already_owned` with
   action `keep`, which the helper reports when F4 has removed the worktree but
   the worker has not yet posted `unclaimed-by`, so its running worker, if any,
   still holds a slot. A `stale` result goes to the takeover path in
   `idd-resume.instructions.md`, as it does for a claim with a worktree. Any
   other result, including an unreadable worktree, is reported to the operator
   with its state, and no further action is taken on that issue.
3. **Re-attach workers.** Read the live worker list from the harness's agent
   listing, and match each entry, by the issue number and claim id in the
   worker's brief, to an own claim. Count every matched own worker not yet
   disposed in `--running`, a running worker or a finished one still awaiting
   step 4, including the running worker of a released claim, and pass each
   counted worker's issue as an `--in-flight` value below when its brief gives
   one. A matched finished worker goes to step 4 before any refill below, once
   the checks in step 4 pass, and no new worker starts until step 4 has run for
   every matched finished worker, unless its claim is still held with no handoff
   summary on the issue. Such a worker stopped before its terminal phase, so it
   takes the same worker-death recovery as a running worker, under the bullet
   named above. A matched running worker of an own claim that step 2 verified as
   `already_owned` is handled as follows: if the runtime can still message it,
   apply the existing worker-death rules by reference, under the bullet titled
   "Resume-specific recovery when a worker dies mid-turn" in the
   [fan-out variant](#orchestrator-fan-out-variant); if it cannot be messaged,
   it is treated as live and is never replaced while the listing still shows it
   running, because its agent may still be executing when no child process is
   visible. Wait for any running child process by PID. Then hold the claim, with
   no replacement while the listing still shows the worker running, and report
   the worker to the operator in step 5. A worker that matches no own claim is
   neither messaged nor replaced. A running worker of a released claim is
   counted and sent no message. If the harness offers no agent listing, no
   worker is matched, every own claim that reached this step goes to step 5, and
   the rest of this step is skipped, including the Discover pass, the budget
   call, the overlap check, and every worker start, because the running workers
   are unknown. An own claim that matches no worker, unless it is a released
   claim with no linked worktree, and a listed live worker that matches no own
   claim, also skip the rest of this step, because such a worker may still be
   running and hold a slot the budget cannot see, an own claim goes to step 4
   for report recovery and then to step 5, and a listed live worker goes to step
   5. A session without a unique session-suffixed agent id also skips the rest
   of this step, because it cannot tell its workers from another session's. Only
   when a listing exists, the session has a unique session-suffixed agent id,
   and no such unmatched claim or unmatched live worker remains, recount the
   roster. After a restart, run a fresh Discover pass first, as section 3 of the
   orchestrator phase file describes, and count its candidates (0 when none);
   the cached graph is discarded and cannot supply that count. Then run the
   profile-selected `idd-worker-budget` command with `--running <n> --startable
   <n>`, where `--running` is the count above and `--startable` is the count
   just taken. Add `--harness-limit <limit>` when this harness's row in the
   worker mechanism table gives a numeric limit, and omit it otherwise. When
   `--startable` is at least 1 and the budget's `slots` is at least 1, run the
   profile-selected `discover-shared-file-overlap` command with `--issues
   <n,...>` (the startable candidates), `--batch <k>` (the `slots` value),
   `--check-overlap`, one `--in-flight <n>` for each counted worker's issue, and
   `--desync-token` set to this session's session-suffixed agent-id whenever
   `discover.selectionDesync` is `session-offset`. Otherwise skip it: the helper
   rejects an empty candidate list and a zero batch. Each selected candidate
   then goes through section 3, steps 4 to 6 (A4.5, the fresh-claim order
   through claim verification, and the worker start), and its started worker is
   recorded as a running roster entry before section 4 resumes.
4. **Recover reports.** Run this step for each matched finished worker, once its
   worktree, claim, and child processes show no live background work, and for
   each unmatched own claim whose handoff or merge live state shows it finished,
   with or without a draft. The fan-out variant's completed-notice rule names
   these live-evidence checks, and this step applies them to every finished
   worker, under that worker's own listed handle. A worker with live work is
   treated as running in step 3. A claim with no matched worker and no draft is
   recorded under the claim id as its handle, released or not, because the
   listing supplies no handle for it. Before that append, read the worker report
   store file read-only, as the
   [worker final report store](idd-helper-scripts.md#worker-final-report-store)
   describes, and, if a line already carries this claim id under another handle,
   do not append: the store cannot tell whether that record is this worker's or
   an earlier replacement's, so step 5 reports the claim to the operator. The
   store dedupes on claimId, workerHandle, and terminalPhase, so a retry is
   safe. A matched running worker gets no record. A released claim whose only
   matched worker is still running gets no record and is reported in step 5.
   Look for the worker's report draft in the scratchpad of the same session,
   under the issue-number prefix that the fan-out variant already requires. If a
   draft is found, check that its `issue` and `claimId` match the claim. When
   the claim has a matched worker, set the draft's `workerHandle` to the listed
   handle, whatever value the draft holds, as section 5 of the orchestrator
   phase file does at the append. A draft that matches the claim but has no
   listed worker is
   appended under its own `workerHandle`, because the store dedupes on that
   handle with the claim id and terminal phase, so a record already appended
   under it is not counted twice. The listing matches workers only and never
   names a draft handle. An unmatched claim appended in this step, from a draft
   or from live state, has no running worker, so once it is appended it no
   longer blocks refill: the restart then runs step 3 recount and refill gate
   again, if no other unmatched own claim or unmatched live worker remains. Do
   not append a draft that does not match. Then verify its outcome,
   `pullRequest`, and `terminalPhase` against live GitHub state, set
   `verifiedAt` to that check and `recordedAt` to the time of the append.
   Recompute `reviewRounds` from the complete paginated review list using the
   Worker report Fill note above, replacing any draft value. Omit the field if
   `pullRequest` is null or the complete count cannot be read. Then append it.
   If no draft is found, verify the terminal outcome from live GitHub
   state, build the record as the
   [worker final report store](idd-helper-scripts.md#worker-final-report-store)
   describes, with `harness` set to the slug the store lists for this session's
   own harness, or `other` when none matches, and append it the same way, unless
   its outcome is `held` or it has no terminal phase from live state: a held
   claim, or a claim released without a merge or handoff, has no live source for
   a terminal phase, so nothing is appended and step 5 reports it. Before any
   append, validate the record against `schemas/worker-report.schema.json`
   first, then append it with the profile-selected `idd-worker-report append
   --file <path>` command. After a successful append for a matched worker,
   dispose of the worker as the table's row says and mark its roster entry
   `disposed`, as section 5 of the orchestrator phase file describes. Map
   `outcome` as the store describes: `handed-off` when a trusted handoff summary
   carrying this claim id was posted, whatever the pull request has since done
   and whether or not the claim has since been released; otherwise `merged` for
   a merged pull request, `abandoned` for a closed unmerged one, `held` for a
   claim still held, and `failed` otherwise. A handoff summary is trusted only
   when a trusted marker actor posted it, because the claim id alone is a public
   token. Set `terminalPhase` to `F4` only for a claim released after a merge
   under `fully_autonomous_merge`, since F4 is complete only after its final
   `unclaimed-by`, and to `F2.5` when a trusted handoff summary carrying this
   claim id is posted on the issue, under either merge policy. A merged pull
   request that still shows an active claim has no terminal phase, so step 5
   reports it. Record the recovery in `frictions`, with its `phase` (F4 or
   F2.5), a non-empty `summary`, and `docs/idd-workflow.md` in `file`, because
   that is the instruction path the recovery followed. If verification or the
   append fails for a matched worker, keep it addressable, mark it `stalled`,
   and follow the worker-specific recovery in the fan-out variant, as section 5
   of the orchestrator phase file describes. A failed append for a released
   claim is reported in step 5.
5. **Report the remainder.** An own claim that reached step 3, other than a
   released claim, and has no matching worker is reported to the operator, and
   so is a matched finished worker that step 4 did not append because its
   outcome is `held`. A listed live worker that matches no own claim is reported
   to the operator too, because it blocks refill until the operator resolves it.
   A matched running worker that cannot be messaged is reported too. A released
   claim is reported here when step 4 left it with a running worker, when its
   verification or append failed, or when the harness offers no agent listing,
   so step 4 did not run for it, or when step 4 appended nothing for want of a
   terminal phase, or because the store already holds a record for the claim
   under another handle. Otherwise step 4 handles it. Its worktree is not
   removed.

### Discover re-run cadence

Re-running the full Discover enumeration this session established
(`discover-roadmap-graph`, and `discover-orphan-filter` when A0/A0-O
routes there) after every delegated-worker completion is too
expensive; a 2026-09-09 hearing decided to document a re-run cadence
instead (kurone-kito/idd-skill#2706). A re-run always repeats the mode
and routing already in force for this session — A1's single-root or
cross-roadmap choice, and A0/A0-O's own `issue-scope` and
`orphan-first-policy` routing — refreshing the same search, never
widening it to a broader mode this session never selected.

- **Do not re-run** Discover after every delegated-worker completion.
  Dispatch the next worker from the previously enumerated graph
  instead, after a fresh target-local A3 readiness check for that
  specific candidate (the configured authoring label, and any
  newly-added open dependency) — the per-delegation A4/A4.5/A5 gates
  above do not repeat A3's own exclusions, so a candidate that became
  blocked only after the graph was built would otherwise slip through
  uncaught.
- **Do re-run** on any of the following: a worker reports exhaustion
  or no startable candidate remains in the graph already in hand, or
  that graph is stale enough that the orchestrator no longer trusts it
  for the next dispatch — for example when a completed issue may have
  unblocked a dependent still listed as not-ready. A worker merely
  finishing the issue it was dispatched for is not by itself a reason
  to re-run: that happens on every successful dispatch, so treating it
  as a trigger would collapse straight back into the every-completion
  cadence the first bullet rules out. Wait for the helper's own
  process exit before parsing its output — never a mid-run stdout
  read — per
  [A2's helper read timing note](../.github/instructions/idd-discover.instructions.md#a2--enumerate-sub-issues).
- **On a caller-side tool timeout** during the Discover invocation —
  the orchestrator's own tool-invocation wrapper (for example a
  bounded Bash-tool or subprocess timeout) elapsing while the helper
  process may still be running to completion, not the helper itself
  erroring or exiting non-zero — give that same invocation one more
  attempt with a longer time budget (re-attach to the still-running
  process when the tool only stopped waiting rather than killing it;
  otherwise reissue the command) before concluding anything failed.
  Only a second timeout under the longer budget counts as an A2
  enumeration failure, unchanged from today's A2 rule; a helper that
  actually errors or exits non-zero is already an A2 enumeration
  failure on the first occurrence.
- **An exhausted pool** (Discover returned no startable candidate and no
  worker is running). This applies only when no worker is running, and
  only to an orchestrator that stays alive by design, for example one
  re-invoked by a loop runner: A4's exhaustion exit still reports the
  discarded issues and stops, and this bullet changes that for no
  session — the report-and-stop still happens first, and this bullet
  governs only how an orchestrator that its runner keeps alive waits
  afterward. It complements the first bullet above, never overrides it:
  that bullet rules out re-running after every completion, and the **Do
  re-run** bullet's no-startable-candidate trigger is spent by the
  Discover run that returned this empty pool, so it does not recur on a
  timer. Wait for an external change instead of re-running Discover on a
  timer: poll with one GraphQL query shape, paginated by cursor until
  every page is read, for the open issues' number, state, labels, last
  edit time, sub-issue total and parent (not per-issue REST reads), about
  every 2 minutes, and re-run Discover only on the events below, not on
  a timer. Those events, not elapsed time, are what make the graph stale
  here, apart from the changes listed under unobserved below. An
  exhausted orchestrator therefore sees a released or expired claim only
  at its next event.

  ```graphql
  query($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor, states: OPEN) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          state
          labels(first: 100) { nodes { name } }
          lastEditedAt
          subIssuesSummary { total }
          parent { number }
        }
      }
    }
  }
  ```

  An orchestrator that stays alive polls before each Discover run it
  starts. Each poll is compared with the last complete poll, and a failed
  or refused poll replaces nothing. An event is any of these: no complete
  poll before a run, in which case the next complete poll re-runs Discover
  once; an open issue that the last complete poll lacked, which is a new or
  reopened issue (the poll cannot tell them apart) without an authoring or
  blocking label (by default `status:authoring`, `status:blocked-by-human`
  or `status:needs-decision`); an open issue that the poll no longer
  returns, which is normally a closed issue; an authoring or blocking label
  removed from an open issue; the ready label (`idd:ready` by default) added
  to or removed from an open issue; or a changed `lastEditedAt`, sub-issue
  total or parent on an issue present in both polls, graph member or not.
  The comparison uses only GitHub's own values, so no clock is involved.
  Every body edit to an open issue present in both polls is therefore
  expected to re-run a full Discover, which is the cost of seeing
  relationship edits without polling comments. The observed case that moves
  `lastEditedAt` is a roadmap body edit (kurone-kito/idd-skill#3878); other
  body edits, such as a task-list, marker or `Blocked by` line edit, are
  expected to move it too. A native sub-issue link is expected to move the
  sub-issue total or the parent.
  `updatedAt` is not polled, because comments (claim markers included) and
  label changes are expected to move it (see kurone-kito/idd-skill#3878).
  The following stay unobserved (each preventive; no observed incident yet):
  approval comments such as `IDD ready`; changes made through comments,
  including claim releases; the stale-claim threshold, which is time-based;
  body or label changes to closed issues that the graph still traverses;
  sub-issue links between closed issues; an unlinked issue opened and closed
  between two polls, or an issue closed and reopened between two polls; a
  body edit to an issue absent from the last complete poll (new or reopened)
  with an authoring or blocking label, made before the next complete poll
  (it has no earlier `lastEditedAt` to compare; its label removal is itself
  an event); changes to configured label names; and title edits, which the
  poll sees only if they also move `lastEditedAt`. Reported 2026-10-05 and
  replayed on
  `origin/main` at `c9d082386` on 2026-10-08 (kurone-kito/idd-skill#3878):
  with the earlier fields (number, state and labels), the poll values stayed
  identical while the graph changed.

  The poll interval is deliberately shorter than the roughly 4-minute race seen
  in a downstream adopter's run (reported 2026-09-30,
  kurone-kito/idd-skill#3677): a second orchestrator claimed the next serial
  issue about 4 minutes after its blocker closed, so the wait also decides
  who wins. A helper for the query is optional and not part of this
  guidance.
- **Optional hint cache**: this section decides _when_ to re-run.
  With `githubApi.readCache.enabled`, a re-run inside `maxAge` is served
  from a hint instead (see the helper-script
  [Discover hint cache](idd-helper-scripts.md#discover-hint-cache)),
  which changes only what a re-run costs, never when one is owed.

## Live Status Digests

Use the live status digest contract in
[IDD comment minimization](idd-comment-minimization.md) when an active
run needs one human-facing current-status comment. Digest text is never
workflow evidence by itself: claim parsing, review currency, advisory
waits, CI, merge readiness, and roadmap audits still read trusted
operational markers and GitHub state.

During resume, repair a missing or stale digest only after the route and
claim state are known. Duplicate marked digests are preserved as audit
history and reported for repair; unattended agents must continue from
the authoritative markers and GitHub state rather than picking a digest
arbitrarily.

Phase files now define digest update points rather than leaving them to
agent judgment. Issue digests are refreshed after claim verification,
planning, meaningful C-loop decisions, hold, abort, and resume route
selection. PR digests are refreshed for review-fix progress, advisory
wait or CI holds, pre-merge blockers, merge failures, and post-merge
cleanup.

Agents deliberately avoid editing a PR digest between a valid E1 review
watermark and a successful F3 merge path. A digest edit can be PR
activity, so successful F2 passes carry their activity snapshot forward
without touching the digest; blocked reroutes and hold paths may update
the digest because they stop or leave merge intent anyway, and so may
an F2 pass blocked only on `secondaryQuietWindow`, since that wait no
longer perturbs review currency. The F3 awaiting-reviewer restart-F2
path is the exception: it skips digest updates so the restarted F2 pass
does not self-invalidate review currency.

### Roadmap-claim contention playbook

Use this playbook when multiple sessions are active:

- **Do continue child execution** when a roadmap claim is present, unless
  a normal readiness gate blocks the child issue. Claims are per issue.
- **Do treat `roadmap-audit/*` as coordination-only** for roadmap
  side-effects (comment/edit/label/follow-up/close), not as a global
  execution lock.
- **Do stop and defer on fresh non-owned claims**. If a claim is active,
  non-stale, and not yours, treat it as not inheritable.
- **Do take over only stale non-owned claims** according to shared stale
  thresholds and `supersedes` rules; do not force ownership changes.
- **Do heartbeat only for owned active claims**, and release
  roadmap-audit claims promptly after roadmap-side effects finish.
- **Do not bypass blocker labels, dependency checks, or claim
  revalidation gates** while resolving contention.

## Roadmap Claim Guardrails

Roadmap-audit claims are coordination-only. Use them only while the
roadmap issue itself is being mutated, then release them once that
roadmap-side effect is complete. They are not a proxy lock for child
claims.

Recursive roadmap hierarchies still follow that rule. Leaf execution
issues finish first, then the deepest completed nested roadmap is
audited and closed under its own `roadmap-audit/*` claim, and only then
is the parent roadmap re-evaluated. Bottom-up closure keeps roadmap
claims scoped to the exact roadmap issue being mutated instead of
turning one parent claim into a lock over child or sibling work.

If the roadmap claim remains open after the roadmap-side effect is done,
or if it appears to serialize child execution, treat that as a misuse
signal: revalidate ownership and stale timing before continuing, then
heartbeat, release, or take over rather than holding the claim open.

The docs audit keeps this guidance synchronized with the exported
template so unattended runs can spot drift.

## Copilot review instruction scope

The heavy shared overview keeps `applyTo: "**"` so GitHub Copilot
execution surfaces can receive the IDD entry context automatically.
However, it also sets `excludeAgent: "code-review"` so Copilot code
review does not ingest the full operational workflow as reviewer-side
context.

This is an intentional middle path between the evaluated alternatives:
keeping review coupled to the full overview, narrowing `applyTo` and
risking execution-agent discoverability, or splitting a separate
reviewer-only instruction file. Copilot code review may still use the
lightweight repository-wide `.github/copilot-instructions.md`; only the
heavier `idd-overview-core.instructions.md` is excluded from review.

Some older project text may still use "skill files" as shorthand for
instructions, but the native skill bundle and execution instructions are
related rather than interchangeable surfaces.

## F2 merge-readiness evidence checklist

Before executing F3 merge, F2 must record concrete evidence for merge
readiness rather than relying on a single reviewer signal.

Required evidence fields:

1. Activity-universe snapshot values:
   `{head-SHA}`, `{max-activity-updatedAt|none}`,
   `{total-item-count}`, `{latest-ci-completed-at|none}`.
2. Unresolved-thread evidence: total unresolved threads, actionable
   unresolved count (non-awaiting-reviewer), and AMD thread presence.
3. Unreplied regular-comment evidence: count of non-IDD-agent comments
   without a later IDD-agent reply.
4. Reviewer-state evidence: latest `CHANGES_REQUESTED` states for human,
   required, and CODEOWNER reviewers, plus required approval/CODEOWNER
   satisfaction.
5. Advisory-wait evidence: AW outcome for the current HEAD, marker
   coverage (`EARLIEST_SAME_HEAD_AT`), and merge-gate satisfaction.
6. CI evidence: required-check generation and pass status for all
   required checks on the current HEAD.

Mixed reviewer ecosystems are expected. The same checklist applies
across human reviews and advisory bot surfaces (Copilot, CodeRabbit,
Codex connectors, CI bots); "one bot says clean" is never sufficient by
itself.

**Authoritative source for the final-merge fields.** Bind every CI and
activity value in this checklist to the **live `pre-merge-readiness` run on
the current HEAD** — that helper is the authoritative source for the
F2/F3 merge decision. The `review-activity-snapshot` helper builds the
**E-phase** activity universe (E1) and must **not** be reused as the
F-phase merge decision: the two can disagree in the window just before
merge ("ci-pass-drift"), so reading CI/activity from the E-phase snapshot
instead of the live pre-merge run risks merging on stale evidence. See
[IDD helper script evaluation](idd-helper-scripts.md#merge-gate-evidence)
for each helper's phase role.

## Review Policy Profiles

The execution loop is cross-agent, while PR review policy is a
repository choice. See
[IDD review policy profiles](idd-review-policy-profiles.md) before
customizing the default Copilot advisory behavior.

## Default PR policy: Copilot advisory review

The core IDD flow is cross-agent, but this repository's distributed
default PR policy still includes a GitHub Copilot advisory review step
in later PR phases.

- `idd-review-fix.instructions.md` can request a GitHub Copilot
  re-review for the current PR head.
- `idd-merge.instructions.md` can wait or hold based on that GitHub
  review state.
- This dependency is on GitHub's review integration, not on every local
  agent using Copilot as its CLI.
- Adopters who do not want that default PR policy should choose another
  review policy profile, apply the matching
  `profiles/<profile>/README.md` artifact, and follow the PR review
  profile edit-surface checklist in
  [IDD review policy profiles](idd-review-policy-profiles.md).
- Expect non-default profile changes to cover review-fix, advisory-wait,
  pre-merge, merge, review-snapshot, and review-triage surfaces; the
  exact edits vary by profile.

Non-Copilot agents can still drive the workflow end to end, but they
should expect those later phases to interact with Copilot as a GitHub
reviewer because that is part of this repository's current PR policy.

## Maintainer-Authorized External-Check Waivers

Some repositories classify a small set of repo-external checks as
waivable so IDD can recover when a third-party integration becomes
stuck, unavailable, or rate-limited even though repository-owned
validation is already healthy. This is a human-authorized escape hatch,
not an automatic merge bypass.

High-level maintainer flow:

1. Let IDD reach an F2 hold and confirm that the blocker is a
   configured external check rather than a repository-owned or
   GitHub-required gate.
2. Run the optional waiver facade in dry-run mode to inspect the exact
   comment body, matched check, active claim, current PR HEAD, and
   expiry before any mutation.
3. Post the canonical waiver comment only through the helper's apply
   path, then resume IDD on the same PR head.
4. Keep every other gate intact: review currency, unresolved threads,
   unreplied comments, required reviews, claim ownership, and GitHub
   merge topology still have to pass normally.

Normal PR approvals or casual maintainer comments such as "continue" are
not sufficient waiver evidence. In solo-maintainer repositories, this
helper-generated comment is the auditable authorization surface because
self-approval cannot express the required claim, head, check, and expiry
proof.

A waiver posted before its own effectiveness precondition is met is
valid but inert until then; see
[`idd-pr-submit.instructions.md`'s D4](../.github/instructions/idd-pr-submit.instructions.md)
for the mechanical check.

## Optional helper scripts

This source repository currently ships the following optional helper scripts:

- `scripts/resume-claim-routing.mjs` (read-only Resume Step 1 claim
  routing evidence)
- `scripts/resume-route-selection.mjs` (read-only Resume Step 3 route
  selection evidence)
- `scripts/review-activity-snapshot.mjs` (read-only E/F activity and CI
  snapshot metrics)
- `scripts/advisory-wait-state.mjs` (read-only advisory-wait evidence
  and AW outcome reporting)
- `scripts/external-check-waiver.mjs` (maintainer dry-run/apply facade
  for canonical external-check waiver comments on the current PR head;
  added in 0.2.0)
- `scripts/pre-merge-readiness.mjs` (read-only F2/F3 readiness evidence
  collection)
- `scripts/review-disposition-verify.mjs` (read-only E7 disposition
  verification evidence)
- `scripts/live-status-digest.mjs` (issue or PR live status digest
  dry-run and claim-checked upsert)
- `scripts/audit-pr-cleanup.mjs` (post-merge cleanup audit and optional
  apply mode)
- `scripts/merged-pr-feedback-sweep.mjs` (read-only, manually-invoked
  post-merge sweep that scans merged PRs for unresolved review threads
  and undispositioned advisory feedback, handing JSON to the
  issue-authoring skill; a date-window run also lists open PRs that pass
  pre-merge readiness but have not been merged)

Shell / `gh` / `jq` snippets in
`.github/instructions/*.instructions.md` remain the canonical portable
path for repositories that stay on `instructions-only`. When helper
runtime is enabled, these shipped helpers are the preferred evidence
collection path, while live GitHub checks and written gate rules remain
authoritative.

See [IDD helper script evaluation](idd-helper-scripts.md) for the
current inventory of high-friction query patterns, the adopted helper
scope in this source repository, and the criteria for future helper
changes.

See [IDD comment minimization](idd-comment-minimization.md) for the live
status digest helper, post-merge cleanup helper, GraphQL fallback command
shape, and merged-PR experiment for hiding completed feedback and stale
operational markers without deleting the audit trail.

## Worker delegation

This section maps how each harness named in `AGENTS.md` starts a
delegated worker (a subagent, or a background session that runs one
issue to completion), waits for it, addresses it again, and stops it.
It supports the [Orchestrator fan-out variant](#orchestrator-fan-out-variant).

Every filled cell carries a reference to a vendor page, listed below
the table, and the date that page was checked. A cell that the vendor's
own docs or source do not confirm reads `unverified`, and it still cites
the reference that shows the gap, so a reader can check the gap for
themselves.

The eligibility column sets how a session may use the harness:

- `orchestrator`: the start mechanism and the wait model are both
  confirmed, and no documented lifetime cap ends before a multi-hour
  worker run. The session may run several workers at once, up to the
  cap below.
- `one issue per session`: anything else. The session runs one issue
  only, and the row gives the reason.

A wait model counts as confirmed when the vendor's own docs or source
show it. A mode that needs a setting counts only when that setting
appears in the vendor's official docs, because an orchestrator cannot
rely on a switch that only the source names.

A worker runs for hours. In this repository, pull requests took a
median of 0.8 hours and a 90th percentile of 8.3 hours from opening to
merging over the 100 pull requests merged from 2026-09-29 to 2026-10-07.

The effective worker cap is the smaller of `orchestrator.maxWorkers`
(default `2`) and the harness's own concurrency limit. `idd-worker-budget`
reports the slots left after the running workers, the harness limit, and the
startable candidates, and it reports zero slots when host load, host memory,
or the GitHub API quota is unknown or too low.

| Harness                     | Start and fresh context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Wait model                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Re-address                                                                                                                                                                                                                                                                                                                                              | Stop or dispose                                                                                                                                                                                                                                                   | Limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Eligibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code                 | `Agent` tool (renamed from `Task` in v2.1.63; existing `Task(...)` references in settings and agent definitions still work as aliases). Fresh context: yes for a non-fork subagent, which starts with a fresh, isolated context window; a `fork` inherits the entire conversation. [CC1] 2026-10-15                                                                                                                                                                                                                                                                                             | `streaming` (default interactive session, v2.1.232 or later, fork mode on): Agent-tool subagents, forks and non-fork alike, run in the background, and Claude cannot ask for the foreground; a result arrives as a completion notification in a later turn. Claude Code picks foreground or background from the first case that applies; three cases run a subagent in the foreground, and foreground subagents block the main conversation until complete: an in-process agent-team teammate spawning the subagent; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, which disables all background task functionality (background Bash and auto-backgrounding included) in every kind of session, whether or not fork mode is on; and fork mode off with Claude needing the result before continuing, unless the subagent's frontmatter sets `background: true`. Fork mode is off under `-p` and in the Agent SDK unless `CLAUDE_CODE_FORK_SUBAGENT=1` turns it on; `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off in every session, and before v2.1.232 interactive sessions also need `CLAUDE_CODE_FORK_SUBAGENT=1`. With fork mode off, a subagent otherwise runs in the background, and how a `-p` run collects its result is not described here. Skills with `context: fork` follow their own rules. The Eligibility verdict assumes the default case, and this cell does not confirm it for `-p`, SDK or DISABLE sessions. [CC1], [CC3] 2026-10-15 | `SendMessage` to the agent ID or name resumes it with its history; Explore and Plan agents cannot be resumed. [CC1] 2026-10-08                                                                                                                                                                                                                          | `TaskStop`, or `x` in `/tasks`; a finished subagent needs no close. [CC2] 2026-10-08                                                                                                                                                                              | 20 concurrent subagents by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`); nesting depth 3; no wall-clock subagent timeout documented. The 2-hour cap covers a background Bash command, not a subagent: 30 minutes by default, 2 hours at most, unattended sessions only. [CC1], [CC2], [CC3] 2026-10-08                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `orchestrator`: start and wait model confirmed, and no subagent lifetime cap documented. [CC1], [CC3] 2026-10-08                                                                                                                                                                                                                                                                                                                                                                                      |
| Codex CLI                   | `spawn_agent` is the V1 surface, and it is the default: `multi_agent` is on by default and `multi_agent_v2` is off by default [CX4]. The docs say Codex "can run subagent workflows by spawning specialized agents in parallel" and that `agents.enabled` defaults to `true` [CX1]. Fresh context: V1 defaults `fork_context` to false, so the agent starts with only its initial prompt [CX2]; V2 defaults `fork_turns` to `all`, and `none` starts a fresh agent [CX2]. `unverified` in the docs: they do not say which surface a session gets [CX1]. Checked 2026-10-15 [CX1], [CX2], [CX4]. | Docs: "Codex waits until all requested results are available, then returns a consolidated response" (a wave) [CX1], which the docs do not tie to a surface. That wave alone confirms the wait model. The V1 `wait_agent` description adds a completion notice: "Once the agent reaches a final status, a notification message will be received containing the same completed status" [CX2]. That notice applies while `multi_agent_v2` is off, the default [CX4]. Subagent workflows are enabled by default [CX1]. Checked 2026-10-15 [CX1], [CX2], [CX4].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | V1 `send_input` sends a message to an existing agent; `interrupt=true` redirects it at once, and the default queues it [CX2]. `resume_agent` resumes a closed agent by id [CX2]. V2 has `send_message` and `followup_task` [CX2]. The docs say a running subagent can be steered, stopped, or closed on request [CX1]. Checked 2026-10-15 [CX1], [CX2]. | V1 `close_agent`: "Completed agents remain open and count toward the concurrency limit until closed" [CX2]. V2 has `interrupt_agent`, which interrupts the current turn and leaves the agent available, and it has no close tool [CX2]. Checked 2026-10-15 [CX2]. | `unverified` in the docs: no concurrency number, lifetime, or depth [CX1]. The source defaults to six V1 threads (`DEFAULT_AGENT_MAX_THREADS`), used when `agents.max_concurrent_threads_per_session` is unset [CX3]. Under V1, spawns reserve against that configured value with no subtraction [CX3], [CX8], and the registry counter does not count the root thread [CX6]. Under V2 the source defaults to four threads per session, and `effective_agent_max_threads` subtracts one, which leaves three at the default [CX3]. V2 sub-agent spawns take a residency slot at the default residency capacity of three [CX3], [CX7], [CX8]. Before reserving a V2 residency slot, `spawn_agent_internal` calls `ensure_execution_capacity` [CX8] as a separate execution gate; residency capacity is therefore not the only spawn gate. The spawn path passes no registry cap for those spawns, so the registry counts them without capping [CX6], [CX8]. Only sub-agent sessions are resident candidates [CX7]. V1 max depth defaults to 1, and the source's field comment says V2 ignores it [CX3]. The source sets the default V2 wait timeout minimum to 10 s and maximum to 3600 s, and `DEFAULT_WAIT_TIMEOUT_MS` is 30 s [CX3], [CX5]. Checked 2026-10-15 [CX1], [CX3], [CX5], [CX6], [CX7], [CX8]. | `orchestrator`: start confirmed by the docs ("spawning specialized agents in parallel", enabled by default [CX1]) and by the spec's `spawn_agent` [CX2]; wait confirmed by the docs' wave [CX1]; no lifetime cap is documented [CX1]. The thread defaults include V1 six spawned children (root excluded [CX6]) and V2 four threads per session, with a residency capacity of three [CX3], [CX7]; they do not enter this verdict [CX3]. Checked 2026-10-15 [CX1], [CX2], [CX3], [CX7].                |
| OpenCode                    | The `subagent` tool, which the v2 docs say "runs only in a child session" [OC1]. The current source defines `name = "subagent"` [OC3], so the earlier `task` name is gone. Fresh context: "Subagents run with fresh context in foreground or background child sessions" [OC1]. Checked 2026-10-15 [OC1], [OC3].                                                                                                                                                                                                                                                                                 | `unverified` in the docs: they mention background child sessions without naming the option, the foreground behavior, or a completion notice [OC1], [OC2]. Source: the default foreground call returns the child's completed output [OC3], and a per-call `background` parameter returns at once with `status: "running"` and notifies the parent when the child finishes [OC3], [OC4]. The subagent source read on 2026-10-15 names no environment variable for it; the earlier source read named one [OC3]. The docs' only parallel statement covers the General agent, which can "run multiple units of work in parallel" [OC2]. `unverified`: neither the docs nor the subagent source shows several foreground calls running at once [OC1], [OC2], [OC3]. Checked 2026-10-15 [OC1], [OC2], [OC3], [OC4].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `sessionID` continues a previous subagent conversation [OC3]. `unverified` in the docs: resuming a child is not described [OC1]. Checked 2026-10-15 [OC1], [OC3].                                                                                                                                                                                       | `unverified` in the docs: no stop control is documented [OC1], [OC2]. The source's completion path handles a cancelled run ("Subagent cancelled") [OC4], but the excerpt does not show the control that stops one. Checked 2026-10-15 [OC1], [OC2], [OC4].        | The source's depth default is 1, set by `experimental.subagent_depth` [OC3]. The docs say the General agent "cannot launch more subagents" [OC2]. `unverified`: the docs and source name no concurrency cap or timeout [OC2], [OC3]. Checked 2026-10-15 [OC2], [OC3].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `one issue per session`: the failed condition is concurrency. The default foreground call that blocks until its child returns is shown in source [OC3], but neither the docs nor the source confirms that several OpenCode workers can run at once [OC1], [OC2], [OC3], and an orchestrator verdict means several workers may run at once. The per-call `background` parameter is not relied on [OC4]. The row holds until a concurrent path is shown. Checked 2026-10-15 [OC1], [OC2], [OC3], [OC4]. |
| Grok Build                  | `spawn_subagent`, confirmed in the xAI source-repo user guide but not on docs.x.ai. Fresh context: yes, its own context window. [GB1] 2026-10-08 A background run (default) returns a subagent ID for `resume_from` (section Spawning Subagents); no field name or format is shown. [GB1] 2026-10-15                                                                                                                                                                                                                                                                                            | `streaming`: the parent receives the child's output when the child finishes, and a background run appends a completion block to the parent's scrollback. The result can also be pulled with `get_command_or_subagent_output`. [GB1] 2026-10-08                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `resume_from` continues a completed child; `send_subagent_message` reaches a running child and is off by default. [GB1] 2026-10-08                                                                                                                                                                                                                      | Ctrl+C cancels that child's turn only, and the tasks pane offers a kill action. No agent-callable stop is documented. [GB1] 2026-10-08                                                                                                                            | No timeout or concurrency cap documented; nesting is one level. [GB1] 2026-10-08                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `orchestrator`: a background start returns a subagent ID; the wait model is documented; no lifetime cap is documented. [GB1] 2026-10-15                                                                                                                                                                                                                                                                                                                                                               |
| Cursor CLI                  | The Task tool. Its function name and parameters are not documented, and the `generalPurpose` type value is `unverified`; the docs name the built-in `explore` and `browser` types [CU1]. Each execution returns an agent ID [CU1]. Fresh context: yes, "Subagents start with a clean context" [CU1]. Checked 2026-10-15 [CU1].                                                                                                                                                                                                                                                                  | Foreground: "Blocks until the subagent completes. Returns the result immediately." Background: "Returns immediately. The subagent works independently" [CU1]. The custom-subagent field table gives `is_background` a default of `false` [CU1], so foreground is the documented default for custom subagents; the default for a built-in Task call is `unverified`. "Agent sends multiple Task tool calls in a single message, so subagents run simultaneously" [CU1], which makes parallel foreground calls a wave. Background output goes to `~/.cursor/subagents/`, with no completion notice [CU1]. Checked 2026-10-15 [CU1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Resume with the agent ID that each execution returns, to "resume the subagent with full context preserved" [CU1]. `unverified`: messaging a running subagent is not documented [CU1]. Checked 2026-10-15 [CU1].                                                                                                                                         | `unverified`: no stop control is documented [CU1]. Checked 2026-10-15 [CU1].                                                                                                                                                                                      | `unverified`: no numeric concurrency cap is documented. The docs advise "Start with 2-3 focused subagents" as guidance and show examples of five and ten parallel runs [CU1]. `unverified`: no timeout is documented, and the nesting limit has no number [CU1]. Checked 2026-10-15 [CU1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `one issue per session`: the wait model is confirmed only for custom subagents, whose default `is_background` `false` blocks until completion [CU1]. The built-in Task call's default is not documented [CU1], and the harness verdict cannot require the custom-subagent path. Checked 2026-10-15 [CU1].                                                                                                                                                                                             |
| GitHub Copilot CLI          | `/delegate` hands work to the Copilot cloud agent, which "opens a draft pull request" and works in the background [CP1]. Local subagents start when the main agent delegates work, which "triggers the `task` tool," or from a custom agent chosen with `/agent` [CP2], [CP4]. Fresh context: a subagent has "their own context window" [CP2], [CP3]; `unverified`: whether it starts fresh [CP2]. Checked 2026-10-15 [CP1], [CP2], [CP3], [CP4].                                                                                                                                               | `unverified`. Subagents can run in parallel "by running certain tasks in the background" [CP2]. The docs do not say whether the parent blocks or is notified [CP2], [CP4], and `/delegate` does not say whether the CLI session waits or is notified [CP1]. The `subagentStop` hook runs "When a subagent completes" [CP2], which is a hook event, not a parent notice. Checked 2026-10-15 [CP1], [CP2], [CP4].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `unverified`: resuming a local subagent or messaging a running one is not documented [CP2], [CP3]. Checked 2026-10-15 [CP2], [CP3].                                                                                                                                                                                                                     | `unverified`: the `subagentStop` hook runs on completion [CP2], but no cancel for a subagent is documented [CP3]. Checked 2026-10-15 [CP2], [CP3].                                                                                                                | `unverified`: no timeout or concurrency value is documented for local subagents [CP2], [CP3]. `/delegate` hands work to a cloud agent session, which has a maximum execution time of 59 minutes [CP1], [CA1]. Checked 2026-10-15 [CA1], [CP1], [CP2], [CP3].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `one issue per session`: the local wait model is undocumented; the docs do not say whether the parent blocks or is notified [CP2], [CP4]. The `/delegate` route is a cloud agent session capped at 59 minutes [CA1]. Checked 2026-10-15 [CA1], [CP2], [CP4].                                                                                                                                                                                                                                          |
| GitHub Copilot coding agent | Sessions start from GitHub surfaces, including issues, the agents tab, and Copilot Chat, and from automations [CA2]. A session "can edit files and run tests and linters in an ephemeral cloud development environment" [CA1]. Copilot "remembers context from previous sessions on the same pull request" [CA4]; `unverified`: whether a first session on a new pull request starts fresh [CA1], [CA2]. Checked 2026-10-15 [CA1], [CA2], [CA4].                                                                                                                                                | The output arrives as a pull request [CA1]; `unverified`: no completion notification to a parent is documented [CA1]. Checked 2026-10-15 [CA1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mention `@copilot` in a pull request comment. "Copilot only responds to comments from people who have write access" [CA4]. `unverified`: whether steering applies after the current tool call [CA4]. Checked 2026-10-15 [CA4].                                                                                                                          | "Stopping a session ends the GitHub Actions run and preserves any commits already pushed" [CA3]. `unverified`: no agent-callable stop is documented [CA3]. "Copilot cloud agent sessions can be archived but not deleted" [CA3]. Checked 2026-10-15 [CA3].        | "Each Copilot cloud agent session has a maximum execution time of 59 minutes," and "This limit cannot be extended or bypassed" [CA1]. `timeout-minutes` in `copilot-setup-steps.yml` configures a shorter timeout [CA1]. Checked 2026-10-15 [CA1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `one issue per session`: the wait model is `unverified` (no completion notice to a parent is documented), and the 59-minute cap, which cannot be extended [CA1], ends before a multi-hour worker run. Checked 2026-10-15 [CA1].                                                                                                                                                                                                                                                                       |
| GitHub Copilot Chat         | `runSubagent` in agent mode (VS Code): after a natural-language request, "the main agent invokes the subagent tool" [VS1]. A Local subagent "doesn't inherit the main conversation history" [VS1]. github.com Copilot Chat starts cloud sessions [CA2]; the IDE subagent page covers VS Code, JetBrains, Xcode, and Eclipse only, so it says nothing about github.com [VS2]. Checked 2026-10-15 [CA2], [VS1], [VS2].                                                                                                                                                                            | `unverified`. The subagent "returns a focused result to the main agent" [VS1], and its results "appear back in the main chat session" [VS2]. Whether the parent blocks or is notified is "not documented" [VS1] and "not explicitly documented" [VS2]; those sentences name only where the result goes. Parallel runs are supported: "Subagents can now run in parallel" [VS3]. Checked 2026-10-15 [VS1], [VS2], [VS3].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | "Each Local invocation is stateless: the main agent can't send follow-up messages to the same subagent" [VS1]. Checked 2026-10-15 [VS1].                                                                                                                                                                                                                | `unverified`: no stop control is documented [VS1]. Checked 2026-10-15 [VS1].                                                                                                                                                                                      | Nesting is off by default (`chat.subagents.allowInvocationsFromSubagents`, default `false`); when on, the maximum depth is 5 [VS1]. `unverified`: no timeout or concurrency value is documented for IDE subagents [VS1], [VS2]. Cloud sessions started from github.com Copilot Chat have the 59-minute maximum [CA1], [CA2]. Checked 2026-10-15 [CA1], [CA2], [VS1], [VS2].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `one issue per session`: the wait model is undocumented; neither VS1 nor VS2 says whether the parent blocks or is notified [VS1], [VS2]. The github.com cloud route has the 59-minute cap [CA1]. Checked 2026-10-15 [CA1], [VS1], [VS2].                                                                                                                                                                                                                                                              |
| Antigravity CLI             | `invoke_subagent` spawns "a new concurrent session with a dedicated role and initial prompt"; `define_subagent` creates a transient one [AG1]. Fresh context: yes, the subagent "does not inherit the parent's existing conversation history," starting "with a clean slate" [AG1]. Checked 2026-10-15 [AG1].                                                                                                                                                                                                                                                                                   | Asynchronous: "Subagents run asynchronously in the background" [AG1]. A completed subagent "sent a result message to its parent agent, and paused execution" [AG1]. The docs name no setting for background subagents [AG1]. Checked 2026-10-15 [AG1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | "An idle agent automatically re-awakens to the Running state upon receiving a message from another agent" [AG1]. "The parent agent can interrupt a subagent by sending a message or terminating it" [AG1]. A killed subagent cannot be re-awakened [AG1]. Checked 2026-10-15 [AG1].                                                                     | "Stop Subagent" in the subagent panel, or `k` in the CLI [AG1]. `/agents` has "Kill Active Subagent" (`K`), which terminates the active subagent and its child threads [AG2]. Checked 2026-10-15 [AG1], [AG2].                                                    | `unverified`: no timeout, turn limit, or lifetime limit is documented [AG1]. `unverified`: no numeric concurrency limit is stated [AG1]. The nesting depth is at most 10 [AG1]. Checked 2026-10-15 [AG1].                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `orchestrator`: start confirmed by `invoke_subagent` [AG1]; wait confirmed by asynchronous background runs and the result message a completed subagent sends to its parent, with no setting named [AG1]; no lifetime cap is documented [AG1]. Checked 2026-10-15 [AG1].                                                                                                                                                                                                                               |

Antigravity CLI is the former Gemini CLI, which was replaced on
2026-06-18. The Gemini CLI page [GM1] (last updated 2026-06-08) gives a
10-minute default `timeout_mins` and says subagents cannot call other
subagents. Those facts describe the predecessor only. The Antigravity
row cites its own docs and does not inherit them.

[AG1]: https://antigravity.google/docs/subagents?tab=cli
[AG2]: https://antigravity.google/docs/cli/commands/agents?hl=en
[CA1]: https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent
[CA2]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/start-copilot-sessions
[CA3]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/manage-agents
[CA4]: https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github
[CC1]: https://code.claude.com/docs/en/subagents
[CC2]: https://code.claude.com/docs/en/tools-reference
[CC3]: https://code.claude.com/docs/en/env-vars
[CP1]: https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/delegate-tasks-to-cca
[CP2]: https://docs.github.com/en/copilot/concepts/agents/copilot-cli/comparing-cli-features
[CP3]: https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/agents/copilot-cli/about-custom-agents
[CP4]: https://github.blog/changelog/2025-10-28-github-copilot-cli-use-custom-agents-and-delegate-to-copilot-coding-agent/
[CU1]: https://cursor.com/docs/subagents
[CX1]: https://learn.chatgpt.com/docs/agent-configuration/subagents
[CX2]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs
[CX3]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/config/mod.rs
[CX4]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/features/src/lib.rs
[CX5]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs
[CX6]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/registry.rs
[CX7]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control/residency.rs
[CX8]: https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/src/agent/control/spawn.rs
[GB1]: https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md
[GM1]: https://geminicli.com/docs/core/subagents/
[OC1]: https://opencode.ai/v2/docs/agents/
[OC2]: https://opencode.ai/docs/agents/
[OC3]: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/tool/plugin/subagent.ts
[OC4]: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/core/src/session/subagent-completion.ts
[VS1]: https://code.visualstudio.com/docs/copilot/agents/subagents
[VS2]: https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/use-copilot-agents/use-subagents
[VS3]: https://code.visualstudio.com/updates/v1_109

## Critique pass invocation

A **critique pass** is an independent review of a plan or diff that
produces a list of issues with severity, correctness, and coverage
assessment. The goal and expected output are the same regardless of
agent; only the mechanism differs.

| Agent           | How to run a critique pass                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Copilot         | Launch a subagent in Agent mode; use the calling phase's critique checklist as the prompt                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Claude Code     | `Agent(subagent_type="general-purpose")` with the calling phase's critique checklist                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Codex CLI       | Use one bounded read-only native subagent review when supported and suitable; parent waits for and collects the result. Fallback: structured self-critique when delegation is unavailable, disabled, unsuitable, or fails.                                                                                                                                                                                                                                                                                               |
| OpenCode        | Launch a subagent via OpenCode's subagent tool (e.g. the built-in `general` subagent, or a `subtask: true` command) — an independent mechanism                                                                                                                                                                                                                                                                                                                                                                           |
| Grok Build      | Independent `spawn_subagent` (name confirmed in the xAI source-repo user guide, checked 2026-10-08; see [Worker delegation](#worker-delegation)) with the calling phase's critique checklist. Fallback: structured self-critique when delegation is unavailable, unsuitable, or fails (unsuitable: the subagent returns no findings list, or its search beyond the named scope is open-ended rather than a targeted trace of code the change depends on or affects).                                                     |
| Cursor CLI      | Launch an independent Cursor `Task` tool subagent with a general-purpose subagent type (`generalPurpose` is not in the Cursor docs as of 2026-10-08, so use the nearest general-purpose type the Task tool lists; see [Worker delegation](#worker-delegation)) using the calling phase's critique checklist; parent waits for and collects the result. Fallback: structured self-critique when delegation is unavailable, unsuitable, or fails. Do not substitute Cursor product review skills for IDD E-phase critique. |
| Antigravity CLI | Self-critique or use Antigravity's native multi-step task mechanism if available                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The brief given to a delegated per-agent critique subagent states the
five rules below, each followed here by its citation per
[Cite the observed incident](idd-design-rationale.md#cite-the-observed-incident).
These rules apply to the brief for a delegated per-agent critique
subagent only; structured self-critique and `critiqueLoop.delegate`
commands are unchanged. The brief is a prospective constraint, not an
enforced sandbox, like the trust-based contract the
[Completed-draft adversarial review](#completed-draft-adversarial-review)
subsection describes for the issue-authoring reviewer.

1. **Read-only.** Apart from creating and writing in its own scratch
   directory (see the scratch-directory rule), the pass writes nothing
   to the worktree or the git directory and leaves no file elsewhere,
   changes no branch, posts no marker or comment, and runs no `gh`
   command other than a read-only query. For example it may read files
   and run `git log`, `show`, `diff` and `grep`; any other command,
   apart from creating and filling its own scratch directory, runs only
   when the brief names it, and that includes a test run (invoked
   directly, for example `node --test <file>` for a Node project, not
   through a package-manager script, with its temporary and cache
   output directed into the scratch directory) and a helper script.
   Observed 2026-10-01, during the E2 critique of
   `kurone-kito/idd-skill#3648`; no issue records the incident itself.
   The issue-authoring analogue is `kurone-kito/idd-skill#3448`.
2. **No package manager or hook installer, no `node_modules` writes.**
   No package-manager command that can install, link or run a script
   (for example `pnpm`, `npm`, `npx`), no other command that installs
   hooks or links packages (for example `husky`), and no copying,
   linking or writing of the worktree's `node_modules`. Observed
   2026-10-01, during the E2 critique of `kurone-kito/idd-skill#3648`
   (no issue records the incident itself), and 2026-09-30 in an
   issue-authoring draft review (no issue filed).
3. **Scratch files only in its own directory.** Scratch files go only
   in a directory the subagent creates (for example with `mktemp -d`
   inside a per-user parent directory, never directly in `/tmp`)
   outside the repository and the session scratchpad. When the parent
   has already created a scratch directory outside the repository and
   the session scratchpad and named it in the brief (the Claude Code
   recipe below has the parent create a scratch directory and name it
   in the launch prompt), the subagent uses only that directory and
   creates none. It never deletes an entry it did not create. The
   subagent ends its reply with every absolute path it created, wrote or
   deleted, each labeled with that action, including any directory it
   created itself. Observed 2026-10-09, in
   E10 critique rounds 5 and 6 for `kurone-kito/idd-skill#3872`: one
   subagent wrote a bare file under `/tmp`, another left a `mktemp`
   directory under `/tmp`, and one reported its scratch file deleted
   while it was still present (the run notes do not record whether
   those briefs named a directory). Observed again 2026-10-10, in an E10
   critique round for `kurone-kito/idd-skill#3752` (pull request
   `kurone-kito/idd-skill#3851`): a subagent deleted five entries in a
   shared scratch directory that it had not created. Both are recorded
   in the "Incident record" comments on `kurone-kito/idd-skill#3961`
   ([first](https://github.com/kurone-kito/idd-skill/issues/3961#issuecomment-6085458916),
   [second](https://github.com/kurone-kito/idd-skill/issues/3961#issuecomment-6096199282)).
   The parent checks this rule with the post-round scratch check below
   instead of trusting the subagent's own report.
4. **No reading of session-private state.** The subagent does not read
   the claim lock file `idd-claim.lock`, the `idd-generated-*` files in
   the git directory, the session scratchpad (except a file the brief
   names), the parent session's transcript, or the operator's notes and
   per-user agent memory files. Observed 2026-09-24, during work on
   `kurone-kito/idd-skill#3253` (no issue records the incident itself),
   for the session scratchpad; observed 2026-10-01 (no issue filed), for
   the operator's notes and per-user agent memory files; for the claim
   lock file, the `idd-generated-*` files and the parent session's
   transcript: preventive; no observed incident yet.
5. **No background process left running.** The subagent ends every
   background process the subagent itself started before it returns.
   Observed 2026-10-01, during the plan critique for
   `kurone-kito/idd-skill#3705` (no issue records the incident itself).

**Post-round scratch check.** The parent names a scratch directory in
the brief whenever it can create one, so a subagent-created directory
is only a fallback. Around each delegated per-agent critique round
(step 1 before the launch, the rest after the round and any process
cleanup), the parent checks rule 3 itself. The check catches accidental
violations by a cooperating subagent, the shape of every incident rule
3 cites. Like the brief, it is not a sandbox, and it does not prove
that rule 3 held:

1. Before the launch, it creates the named directory empty inside a
   dedicated per-user parent directory outside the repository and the
   session scratchpad, never directly in `/tmp`, so every entry in it
   after the round belongs to the round. It also lists the immediate
   entries of that parent directory (for example `ls -A <parent>/`).
2. After the round, it lists the named directory recursively by its
   literal path without following symbolic links (for example
   `find <dir> -mindepth 1`) and lists the parent directory again.
3. It resolves the named directory and each reported path with
   `realpath -m` (GNU coreutils) or an equivalent that follows symbolic
   links without requiring the path to exist, so the comparison is not
   only lexical; a path that cannot be resolved is flagged. It flags,
   in the critique result and in its final message, any reported path
   that resolves outside the named directory, any symbolic link
   anywhere under the named directory, any entry in the named directory
   the subagent did not report as created or written, any path reported
   as deleted that is still present, and any entry of the parent
   directory that appeared or vanished during the round. It records the
   listings in the critique result before the named directory is
   removed. For a pass stopped before it returned, the subagent
   reported nothing, so the parent lists every entry as residual risk
   rather than as a violation.
4. It does not scan all of `/tmp` or any other shared directory beyond
   the parent directory's own entries, and it deletes nothing it
   cannot attribute to the round. Other sessions under the same OS user
   write to these locations too, so a flagged entry there is a lead to
   check, not proof of a violation; that includes the directories of
   other passes the parent runs at the same time. A write outside the
   named directory and the parent directory that the subagent does not
   report stays unverified; the parent records that limit rather than
   claiming that rule 3 held.

When the subagent created its own directory instead (the fallback),
there is no pre-launch listing. The parent then checks only the paths
the subagent reported. It treats the directory the subagent reported
creating as the named directory for steps 2 and 3 (the recursive
listing, the resolution, and every step-3 flag), never lists `/tmp`
itself, and records that the round had no named directory as residual
risk.

The parent bounds its wait for each delegated per-agent critique pass by
the resolved `critiqueLoop.subagentWaitCeiling`. Enforce that ceiling
through the harness's own per-invocation timeout control, never through a
timeout utility wrapped inside the delegated command, following the
principle from issue `kurone-kito/idd-skill#3449`. Where the harness supports
it, launching in
the background and applying a bounded wait is an equivalent way to enforce
the same ceiling only when the harness also cancels or cleans up the timed-out
subagent and ignores any late output. Otherwise the background process may
continue consuming resources or race with the structured fallback, so do not
use that pattern as an equivalent implementation.

Reaching the ceiling without a findings list is a delegation failure. A
wait that ends through cancellation, interruption, or error without a
findings list is also a delegation failure. Either outcome routes to the
row's structured self-critique fallback, or to "perform the critique as a
structured self-review step" for a row without an explicit fallback, and
the critique result records that the delegated pass did not return.

A harness whose delegation primitive offers no way to bound the wait
cannot honor the ceiling. Record that residual risk explicitly and use
structured self-critique as the unattended-safe path for that harness.

For Claude Code, whose `Agent` tool has no timeout parameter, the
following recipe is conditional on `Agent` launching asynchronously, as it
does today: it returns at once, and only a later notification reports that
the pass ended, which may never come if the subagent stalls. Where a
harness call blocks until the subagent ends, nothing can interrupt it and
the "cannot honor the ceiling" paragraph above applies instead. A Claude
Code session:

1. Checks, before launching, that it can arm a wake-up with one of the
   mechanisms the
   [wake-up discipline](../.github/instructions/idd-ci.instructions.md#wake-up-discipline)
   section names (that section also notes that a bare `sleep` may be
   refused) and that `TaskStop` is available (a tool listed only as
   deferred counts once it has been loaded, which must happen before the
   launch). When it cannot confirm both, it does not launch, records the
   residual risk as the "cannot honor the ceiling" paragraph above
   requires, and uses structured self-critique.
2. Creates, before the launch, a unique scratch directory placed as
   step 1 of the post-round scratch check above requires, names it in
   the launch prompt, and tells the subagent to put any scratch file
   only under it, to start any background job with a working directory
   under it, and to end its reply with every absolute path it created,
   wrote or deleted, each labeled with that action. It takes the
   step-1 listings of the post-round scratch check above.
3. Launches the pass with `Agent`, notes the launch time, and arms the
   wake-up for the ceiling, deliberately the ceiling and not the expected
   completion because the ceiling is the only moment a decision is
   needed, cancelling or ignoring that wake once that pass has returned.
4. When the ceiling is reached and no findings list has arrived, stops the
   subagent with `TaskStop` and the agent id the launch returned. That is
   the delegation failure defined above, so the structured self-critique
   fallback runs, the critique result records that the delegated pass did
   not return, and a result that arrives later is discarded even if it is
   usable (a repository whose passes legitimately run longer sets a larger
   `critiqueLoop.subagentWaitCeiling`). A findings list that has already
   arrived when the session acts is used. If the launch returned no agent
   id or `TaskStop` fails, the session records the residual risk and takes
   the same fallback, because it cannot confirm the stop.
5. Once the pass has returned, been stopped, or the stop could not be
   confirmed, lists the processes left running and ends by process id only
   those whose working directory or command line is under the scratch
   directory, never the session's own shell or the listing command itself.
   It reports any other leftover as residual risk, without ending it, and
   it never ends processes by a name pattern. It then runs the
   post-round scratch check above. It removes the scratch
   directory by its exact literal path (never a possibly unset shell
   variable) only after that cleanup and only when no process under it
   remains; otherwise it leaves the directory and records the residual
   risk.

In a session that passed the check in item 1, stopping with `TaskStop` and
this cleanup are how the Claude Code pattern meets the equivalence
condition above. Whether a background job survives `TaskStop` was not
replayed. The observations behind this recipe follow; none was recorded in
an issue or pull request before this recipe:

- On 2026-10-01, during the plan critique for kurone-kito/idd-skill#3705
  (later pull request kurone-kito/idd-skill#3712), a delegated pass
  returned after about 33 minutes against the 20-minute ceiling and the
  session waited it out, neither stopping the subagent nor recording a
  delegation failure. After that subagent's result was delivered, an
  enumeration it had started in the background was still using about 108%
  of a CPU on the shared host until the parent ended it by process id.
  Neither is recorded in that issue or pull request.
- In a replay on 2026-10-02 (no issue), `TaskStop` with the agent id the
  launch returned stopped a running subagent, and the foreground process
  it had been running was gone eight seconds later.
- On 2026-09-30, in an operator session during the work on pull request
  kurone-kito/idd-skill#3605, a name-pattern kill ended the session's own
  shell, which is why step 5 never ends processes by a name pattern. No
  issue or pull request records that incident itself.

For Codex delegation, the parent collects the reviewer result before
continuing; if delegation fails, use the structured fallback.

For Grok Build, the critique brief must give the subagent the actual
artifact under review (file references by their sibling-worktree
absolute paths, never a relative path or a bare `cd`; a diff by an
absolute-worktree diff command or revision range; or a plan by its
literal text), the issue's requirements or acceptance criteria in
every case — even when the calling phase's own checklist wording
does not name them explicitly, since a correctness assessment is
meaningless without them — and any other checklist input the calling
phase names, such as the E9 findings under verification for E10.
Instruct the subagent to stay within that scope except for a targeted
trace of code the change depends on or affects — `spawn_subagent`'s
working-directory parameter does not rebind Grok's
file tools (that rebind gap is kurone-kito/idd-skill#2819). This
constrains the pass prospectively but does not guarantee compliance —
the unsuitable fallback above still applies when the subagent wanders
past it
anyway.

When a phase file says "run a critique pass", apply the row for your
agent above. If no subagent mechanism is available, perform the critique
as a structured self-review step within the same response.

### Repository-configurable critique delegate

A repository may point C1 or E10 at a reviewer other than the
per-agent mechanism above by setting `critiqueLoop.delegate` in
`.github/idd/config.json` (see
[Customization Surfaces](customization.md#customization-surfaces) and
[Configuration Authority Hierarchy](policy-constants.md#configuration-authority-hierarchy)):
a `command` string is a shell command run against the branch's current
diff, and `mode` selects **when the per-agent mechanism above also
runs**:

<!-- dprint-ignore-start -->
| `mode` | delegate succeeded | delegate failed |
| --- | --- | --- |
| `combined` | per-agent pass runs | per-agent pass runs |
| `fallback` (default) | no per-agent pass | per-agent pass runs |
| `on-success` | per-agent pass runs | no per-agent pass |
| `never` | no per-agent pass | no per-agent pass |
<!-- dprint-ignore-end -->

`combined` is the one value that does not consult the delegate's
outcome — it runs both mechanisms on every pass. The other three
observe that outcome first. Wherever both mechanisms run in the same
pass (always under `combined`, and after a successful delegate under
`on-success`), their reported issues are unioned.

**Delegate failed** means the same set of conditions in every mode: the
command is absent, exits non-zero, times out, or its output cannot be
read as a findings list. It is never narrowed to the process exit
status alone, so a delegate that exits `0` but returns unreadable
output counts as failed under `fallback` and `on-success` alike.
Exit-code conventions differ between reviewers — a lint-style tool
signals _findings exist_ with a non-zero exit rather than _the tool
broke_ — which is why `on-success` exists at all.

**Fail-closed hold.** Under `on-success` and `never`, a failed delegate
can leave C1 with no critique findings at all. The hold condition is
that state itself, not the failure classification: when the mechanisms
that actually ran produced no readable findings list, C1 records a hold
rather than a clean "zero issues reported" verdict, and C2 does not
advance to PR submission on that vacuous result. A delegate that trips
one of the conditions above but still emitted a readable findings list
has produced critique — those findings are the pass's output and C1
continues to C3 scoring on them. `fallback`'s fall-through to the
per-agent mechanism is unchanged. (Written here in C1's own step
vocabulary — `C2`/`C3`; see "E10 delegate support" below for the same
hold applied in E10's own vocabulary.)

The hold turns on a **missing or unreadable** findings list, never on
an empty one. A delegate that succeeded and reported no issues has
produced a readable findings list that happens to be empty: that is a
genuine clean verdict, and C2 proceeds to the objective diff validation
floor exactly as it would with no delegate configured. Only the
no-readable-list state is vacuous.

Delegate output is read the same way a subagent's critique response is
read today — free-form findings scored through the existing C3
High/Medium/Low process; no new machine-readable output schema is
introduced. Absent `critiqueLoop.delegate` entirely keeps today's
per-agent-only behavior with zero change.

Configuration-time fail-safe (distinct from the runtime behavior
above): a non-object `critiqueLoop.delegate`, one whose `command` is
missing, empty, whitespace-only, non-string, or supplied through the
prototype chain rather than as an own property, or one carrying any key
beyond `command`/`mode`, is treated the same as an absent delegate —
the calling pass (C1 or E10) uses the per-agent mechanism, never
attempting the delegate at all. A present but non-object
**`critiqueLoop`** parent (a string, array, or `null`) is a
repository-local configuration error rather than an absent key: it
fails closed to the per-agent mechanism and, like a malformed
`delegate`, blocks user-global inheritance instead of letting a global
delegate stand in for it. A present but **unrecognized `mode`** is
unusable the same way: effective delegate resolution reports a
repository-local one as malformed, so it neither runs nor inherits the
user-global layer, and reports an unusable user-global fragment as
absent. Either way the calling pass falls back to the per-agent
mechanism rather than running the delegate under an assumed default.
(A direct `normalizePolicyConfig` caller — a different consumer, not
the delegate resolution path used by C1 or E10 — still collapses such
a value to the `fallback` default, which is why both behaviors have
their own regression tests.) `.github/idd/config.json` schema
validation separately rejects an unsupported `mode` value or any key
other than `command`/`mode` before the file is accepted, so this state
normally reaches C1 or E10 only through the unvalidated user-global
file.

The C-phase's objective diff validation floor described below applies
**uniformly** whether a delegate is configured or not, in every mode,
and regardless of what the delegate reports — this surface changes
which mechanism produces critique findings, never the load-bearing
`fix-validate` gate. That holds for the fail-closed hold above too: the
hold stops a vacuous clean verdict from advancing, it never lets one
through.

When a runtime falls back to structured same-response self-review
instead of an independent subagent mechanism (see the table above; a
runtime's own native multi-step mechanism, such as Antigravity's when
available, counts as independent), treat that self-critique verdict as
**advisory only** — it is not sufficient by itself to let the C-phase
skip to PR submission. The C-phase's objective diff validation floor (the
**fix-validate** command set that C5 also runs; see
`.github/instructions/idd-work.instructions.md` C1/C2/C4) is the
**load-bearing** gate instead — independent of D2's own
**pre-push-validate** gate.
This floor applies **uniformly** to every runtime — including
subagent-capable ones — rather than being conditioned on a runtime
self-classifying as "no-subagent". Uniform application keeps the gate
deterministic and avoids relying on fragile runtime self-detection that
a weak model could get wrong.

### User-global critique delegate default

This resolver reads only its own fragment of the user-global file. The
layered rules for `overrides[]`, the repository-policy field class, and the
CI off switches are in the
[user-global installation guide](https://github.com/kurone-kito/idd-skill/blob/main/docs/user-global-install.md).

A local runtime (one that reads the operator's own `$HOME`) may also
inherit a `critiqueLoop.delegate` from a user-global file when the
repository leaves the repo-local field genuinely absent — a
GitHub-hosted or other remote agent surface is not meant to consult this
layer, but the helper detects only `GITHUB_ACTIONS=true` on its own (pass
`--no-user-global` on any other remote surface). Resolution order: repo-local
`critiqueLoop.delegate` (a configured object, an explicit JSON `null`
disable, or a malformed value) always wins outright and never inherits
the global layer — an explicit repo-local `null` forces the per-agent
mechanism even when a global delegate exists, and a malformed
repo-local value fails closed to the per-agent mechanism the same way;
only when repo-local is entirely absent does the global file apply;
absent both, the per-agent mechanism above runs unchanged. A malformed
or explicit-`null` **global** fragment is treated the same as a
missing one — silently falls back to the per-agent mechanism — which
is distinct from repo-local `null`'s stronger role of actively
disabling any inherited delegate.

The global file lives at `$XDG_CONFIG_HOME/idd-skill/config.json`, falling back
to `$HOME/.config/idd-skill/config.json` when `XDG_CONFIG_HOME` is unset or not
a **qualified root**. A qualified root is judged against the **running
platform**, not accepted in any form: on Windows only a drive-letter root
(`C:\…` or `C:/…`) or a UNC root (`\\server\…`) qualifies, and on POSIX only a
`/…` path does — `//…` is excluded there, as is a Windows-shaped value, and a
current-drive root such as `\config` is excluded on Windows even though
`path.isAbsolute` calls it absolute. A relative or otherwise unqualified value
is ignored rather than joined against the process's working directory, so the
global config can never resolve inside the checkout under review. A missing,
unreadable, invalid-JSON, or non-object global file is silently treated as
absent — this layer is opt-in and never required for OSS adopters. Only the
`critiqueLoop.delegate` fragment is read by this resolver. The same file can
also carry `critiqueLoop.telemetryHook` (read only by the telemetry hook
resolver) and `issueAuthoring.adversarialReview.delegate` (read only by the
issue-authoring delegate resolver); every other key is ignored by all three.
Other policy fields can still come from the repository-local
`.github/idd/config.json` or from the user-global layers, under the rules in the
[user-global installation guide](https://github.com/kurone-kito/idd-skill/blob/main/docs/user-global-install.md).

Example (a generic local reviewer, not a specific product):

```json
{ "critiqueLoop": { "delegate": { "command": "my-local-reviewer --diff" } } }
```

Any configured delegate command — repo-local or user-global — is
executable configuration: it may transmit source code or other data
available to its process to an external service, so enabling one is a
deliberate operator/repository choice, and neither config file should
hold secrets. This surface changes only which mechanism supplies
critique findings; the C-phase objective diff validation floor above,
the E-phase Copilot advisory-convergence policy, required checks, and
merge gates are all unchanged.

The critique content passed to a configured delegate is the branch diff
only — never the two lenses below or the rest of the per-agent
checklist. (This is about what the delegate invocation sends as
critique input, not a sandboxing guarantee on what the command can
otherwise access — see the executable-configuration warning above.)
Passing checklist content to an external command is a capability change
with its own design questions (whether the reviewer accepts input at
all, what happens if it ignores it) that this surface does not make
today. Under a successful delegate with `mode: fallback` (the default),
or under `mode: never`, the per-agent pass does not run at all, so an
operator relying solely on a delegate should expect the lenses below
are not applied to that PR's diff.

### Repository-configurable critique telemetry hook

A repository may also configure a per-round C-phase telemetry
notification by setting `critiqueLoop.telemetryHook` in
`.github/idd/config.json` (see
[Customization Surfaces](customization.md#customization-surfaces) and
[Configuration Authority Hierarchy](policy-constants.md#configuration-authority-hierarchy)):
a `command` string is a shell command invoked once per C-phase round,
with a JSON payload written to its stdin. Unlike `critiqueLoop.delegate`
above, this hook never supplies critique findings and never gates
C-phase control flow — it is a pure observability side channel.

The hook is invoked at two points in the C-phase loop, documented in
both the full-profile work file (C2 and C4) and the lite work file
(`lite/idd-work-lite.instructions.md`, matching steps): at the end of
C4, once the round's Accept/Reject decision is final (before C5, PR
submission, or a hold); and at C2's zero-issue exit, so a clean round
that skips C3/C4 entirely still emits a record (with zero
findings/accepted/rejected counts).

The JSON payload written to the hook command's stdin:

```json
{
  "phase": "C",
  "round": 2,
  "repo": "owner/repo",
  "issue": 123,
  "pr": null,
  "findingsCount": 3,
  "severityBreakdown": { "high": 1, "medium": 1, "low": 1 },
  "acceptedCount": 2,
  "rejectedCount": 1,
  "delegateUsed": true,
  "delegateCommand": "coderabbit-critique",
  "timestamp": "2026-09-08T12:00:00Z"
}
```

`pr` is `null` before a PR exists for this issue; `delegateCommand` is
present only when `delegateUsed` is `true`.

**Fire-and-forget.** A missing command, non-zero exit, timeout, or any
other failure invoking the hook is silently ignored and never blocks,
holds, delays, or otherwise changes C-phase control flow — unlike
`critiqueLoop.delegate`'s fail-closed hold semantics described above,
this is a pure side channel. The C-phase objective diff validation
floor and every other C-phase gate apply identically whether the hook
is configured, missing, or failing.

### User-global critique telemetry hook default

This resolver reads only its own fragment of the user-global file. The
layered rules for `overrides[]`, the repository-policy field class, and the
CI off switches are in the
[user-global installation guide](https://github.com/kurone-kito/idd-skill/blob/main/docs/user-global-install.md).

A local runtime (one that reads the operator's own `$HOME`) may also
inherit a `critiqueLoop.telemetryHook` from a user-global file when the
repository leaves the repo-local field genuinely absent — a
GitHub-hosted or other remote agent surface is not meant to consult this
layer, but the helper detects only `GITHUB_ACTIONS=true` on its own (pass
`--no-user-global` on any other remote surface). Resolution order: repo-local
`critiqueLoop.telemetryHook` (a configured object, an explicit JSON
`null` disable, or a malformed value) always wins outright and never
inherits the global layer — an explicit repo-local `null` disables the
hook entirely even when a global hook exists, and a malformed
repo-local value fails closed to "no hook" the same way; only when
repo-local is entirely absent does the global file apply; absent both,
no hook runs. A malformed or explicit-`null` **global** fragment is
treated the same as a missing one — silently falls back to "no hook" —
which is distinct from repo-local `null`'s stronger role of actively
disabling any inherited hook.

The global file lives at the same path, and under the same qualified-root rules,
as the critique delegate's own user-global file above
(`$XDG_CONFIG_HOME/idd-skill/config.json`, falling back to
`$HOME/.config/idd-skill/config.json`). Only the `critiqueLoop.telemetryHook`
fragment is read by this resolver. The same file can also carry
`critiqueLoop.delegate` (read only by the critique delegate resolver) and
`issueAuthoring.adversarialReview.delegate` (read only by the issue-authoring
delegate resolver); every other key is ignored by all three. Other policy fields
can still come from the repository-local `.github/idd/config.json` or from the
user-global layers, under the rules in the [user-global installation guide](https://github.com/kurone-kito/idd-skill/blob/main/docs/user-global-install.md).

Example (a generic local notifier, not a specific product):

```json
{ "critiqueLoop": { "telemetryHook": { "command": "my-critique-notifier" } } }
```

Any configured hook command — repo-local or user-global — is executable
configuration: it may transmit source code or other data available to
its process to an external service, so enabling one is a deliberate
operator/repository choice, and neither config file should hold
secrets. This surface only emits a per-round observability record; it
never changes which mechanism supplies critique findings, the C-phase
objective diff validation floor, the E-phase Copilot
advisory-convergence policy, required checks, or merge gates.

### E10 delegate support; telemetry hook stays C1-only

`idd-review-fix.instructions.md`'s own critique pass (E10) also
consults `critiqueLoop.delegate`, using the exact same resolution
chain, `mode` semantics, and fail-closed hold behavior described above
for C1 — including the `idd-critique-delegate` helper and the
`instructions-only` resolution order. E10 states the fail-closed hold
in its own vocabulary: when the mechanisms that actually ran under
`on-success`/`never` leave no readable findings list, that is a hold
(the shared Hold / suspend rules in
`idd-overview-appendix.instructions.md` apply), never a clean "zero
issues, proceed to E11" round.

`critiqueLoop.telemetryHook` remains scoped to the C1 critique pass
only; E10 never consults it, regardless of configuration. Extending
the telemetry hook to E10 remains a separate, not-yet-scoped change.

### E2 after a clean C1 on the same HEAD

E2's first pass (`idd-review-snapshot.instructions.md`) is kept even
when C1 ran clean on the tree that became the pull request's head: C1
having reviewed that head is not a reason to skip it. What E2 must not
do is repeat C1. C1's rounds already ran the configured mechanism (for
example the delegate plus the per-agent pass under `combined`), while
E2's incremental scope keys off a same-claim `review-baseline` that
neither C nor D posts, so a first E2 pass scopes to the full branch diff
(and does so again after a takeover). Briefed like C1, it asks for the
same review a second time.

Name C1's lens and its finding count in the E2 brief and ask for a
different lens, for example an **adversarial** one: try to break the
change, and run the new tests against mutants of it (small deliberate
defects in the code under test) so each mutant must fail a named test. A
takeover successor that cannot recover C1's lens or count says so in the
brief and picks a lens the C1 checklist did not use. Reported 2026-09-30
by an adopter (kurone-kito/idd-skill#3678): on a small guard-plus-tests
change, C1 with a checklist lens reported three Low items, while E2 with
an adversarial lens ran the new specs against five mutants of the guard,
reported one Low item, and showed every mutant failing a named test.
That is evidence C1 could not produce, and it let the session reject the
Low item without another push. The
[mutation / write-side helper lens](#mutation--write-side-helper-lens)
and the [gate-mirroring helper lens](#gate-mirroring-helper-lens) below
apply at E2 exactly as at C1, on top of the lens chosen here; the first
concerns helpers that mutate GitHub or git state, not mutation testing.

### Mutation / write-side helper lens

When the diff under critique implements a helper that **mutates GitHub
state, mutates git state, or performs a merge** (read-only helpers are
out of scope), also apply this lens — each check below targets a gap
class that a clean general critique repeatedly missed and that later
review then surfaced one finding per round:

- **Fail-closed inputs**: guards use strict checks (`=== true`, explicit
  pattern/enum validation) so a non-boolean, empty, missing, or malformed
  value blocks the mutation rather than passing it.
- **Validate/execute scope parity**: the repo, identity, and HEAD the
  gate validates are the same ones the mutation runs against — no split
  between a read-side collector's scope and the executed `gh` / git
  command; reject ambiguous partial scoping.
- **Unsafe-output suppression**: a not-ready or invalid verdict never
  emits a copy-pasteable command bound to an unvalidated value.
- **Schema strictness parity**: output schemas match the values the
  helper actually produces and mirror sibling-helper strictness (SHA
  patterns, enums), so the published contract is no looser than the
  runtime.

### Gate-mirroring helper lens

When the diff under critique implements a helper whose purpose is to
**predict, mirror, or pre-check a decision some other gate makes** —
where "agrees with that gate" is the whole contract — also apply this
lens. It is orthogonal to the write-side lens above rather than an
alternative to it: a helper that both mutates state and mirrors a gate
gets both, and their checks do not overlap.

Extracting the shared decision into one function is the right first
move and does not finish the job, because **sharing a function
equalizes the computation, not the arguments**. Two callers still
diverge whenever one passes fewer inputs, a laxer validation path, an
older snapshot, or a stale point in time. Enumerate the gate's inputs
once, against this list, rather than discovering them one per review
round:

- **Validation-path parity**: the helper reads configuration through the
  same validating reader the gate uses, not a rawer resolver that skips
  a schema or subtree check. A gate that rejects a whole config section
  when any sibling key is invalid, and falls back to a default, must not
  be mirrored by a helper that reads the one key directly.
- **Input completeness**: every optional argument that widens or narrows
  the gate's own verdict is passed, not just the ones the happy path
  needs. An omitted exception parameter silently removes the exception.
- **Whole-identity comparison**: every field the gate binds on is
  compared — both the fields the shared value carries and the ones it
  does not, which the caller must then supply itself. A shared record
  that omits an identity field is not evidence that the field does not
  matter.
- **Snapshot identity**: all inputs to one verdict come from a single
  read. Two reads that can straddle a change produce a verdict about no
  state that ever existed.
- **Point-in-time parity**: state re-read after a mutation is
  re-resolved rather than reused from before it, whenever the gate would
  see the newer state.

Each check names a way a mirror can disagree with its gate while the
shared code is itself correct, so a passing unit test on the shared
function is not evidence for any of them. The gap class was observed on
[kurone-kito/idd-skill#2330](https://github.com/kurone-kito/idd-skill/pull/2330),
where a correct extraction still took seven advisory rounds, five of
them this one shape.

[issue-authoring-review-input-schema]: https://kurone-kito.github.io/idd-skill/schemas/issue-authoring-review-input.schema.json
