# IDD workflow guide

This document is the neutral entry point for the repository's
Issue-Driven Development (IDD) workflow across GitHub Copilot, Codex
CLI, Claude Code, and Gemini CLI.

Use it when you need to answer three questions quickly:

- Which repo entry file should I read first?
- Which IDD instruction files load automatically for my agent?
- When does the workflow rely on GitHub Copilot review state rather than
  on my local CLI?

## Start sequence

If you arrived here from your agent's entry file, pick up at step 2. If
you are reading this guide first, start at step 1.

1. Read the entry file for your agent or surface (see table below).
2. Read `.github/instructions/idd-overview.instructions.md`.
3. Read the phase file that matches your current state.
4. If you are editing package-specific code, also follow the matching
   scoped instruction file in `.github/instructions/`.

## Entry points and auto-load expectations

| Agent / surface         | Read first                        | Automatically available IDD context                                                                                                                                | Open manually                                                                 |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| GitHub Copilot surfaces | `.github/copilot-instructions.md` | `.github/instructions/idd-overview.instructions.md` for execution surfaces; package-scoped `.instructions.md` files in VS Code Copilot when editing matching paths | The routed phase file when the current step changes                           |
| Codex CLI               | `AGENTS.md`                       | None from `.github/instructions/`                                                                                                                                  | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Claude Code             | `CLAUDE.md`                       | None from `.github/instructions/` by default                                                                                                                       | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Gemini CLI              | `GEMINI.md`                       | None from `.github/instructions/`                                                                                                                                  | `.github/instructions/idd-overview.instructions.md` and the routed phase file |

During onboarding, create or update `CLAUDE.md`, `AGENTS.md`, and
`GEMINI.md` so each non-Copilot agent listed above has a stable first
file to read. GitHub Copilot remains an update-if-present surface via
`.github/copilot-instructions.md`. Skipping creation of a missing root
entry file should be an explicit operator choice, not the default.

## IDD file map

| File                                                       | Role                                                                                 |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `.github/instructions/idd-overview.instructions.md`        | Shared definitions, command sets, routing table, critique-pass mapping               |
| `.github/instructions/idd-discover.instructions.md`        | A0-T–A4.5: find a viable issue, route roadmap audits, run suitability, and hand off  |
| `.github/instructions/idd-roadmap-audit.instructions.md`   | A1.5: audit roadmap completion and run roadmap-side coordination before A2           |
| `.github/instructions/idd-claim.instructions.md`           | A5: run claim pre-checks and claim verification                                      |
| `.github/instructions/idd-work.instructions.md`            | B1-B3 + C1-C6: create worktree, plan, implement, and self-review                     |
| `.github/instructions/idd-pr-submit.instructions.md`       | D1-D4: rebase, validate, push, open PR, and wait for CI                              |
| `.github/instructions/idd-ci.instructions.md`              | D4/E15 helper: shared CI polling helper used by later phases                         |
| `.github/instructions/idd-advisory-wait.instructions.md`   | AW1-AW5 helper: shared Copilot advisory-wait protocol (E14, F2, F3)                  |
| `.github/instructions/idd-review-snapshot.instructions.md` | E1–E3: fetch activity snapshot, run critique, check if ReviewItems_snapshot is empty |
| `.github/instructions/idd-review-triage.instructions.md`   | E4–E8: classify items, score, and record dispositions                                |
| `.github/instructions/idd-review-fix.instructions.md`      | E9-E15: fix accepted review items and push follow-up commits                         |
| `.github/instructions/idd-pre-merge.instructions.md`       | F1–F2: resolve conflicts and verify all pre-merge conditions                         |
| `.github/instructions/idd-merge-handoff.instructions.md`   | F2.5: resolve merge-policy handoff vs autonomous merge routing                       |
| `.github/instructions/idd-merge.instructions.md`           | F3–F5: execute the merge, clean up, and loop back to discover                        |
| `.github/instructions/idd-resume.instructions.md`          | Resume Step 0-3: route crash, stalled, stale-takeover, or clean continuation         |
| `.github/instructions/idd-resume-stall.instructions.md`    | Resume S1-S5: handle stalled-session recovery with a dedicated safety gate           |
| `docs/idd-review-policy-profiles.md`                       | PR review policy profiles and customization surfaces                                 |
| `docs/idd-comment-minimization.md`                         | Live status digest contract and post-merge comment minimization policy               |

## ReviewItems_snapshot lifecycle

`ReviewItems_snapshot` is the immutable collection created from E1's
activity-universe fetch.

| Phase | Operation                                                                                                   | State     |
| ----- | ----------------------------------------------------------------------------------------------------------- | --------- |
| E1    | Fetch threads/reviews/comments, exclude trusted operational markers, and freeze the current item universe   | created   |
| E2    | Run critique pass and append newly found findings to the same snapshot scope                                | extended  |
| E3    | Evaluate empty/non-empty routing based on the frozen snapshot plus E2 findings                              | evaluated |
| E4-E8 | Classify, score, disposition, and verify each snapshot item (PATH A/PATH B) without redefining the snapshot | triaged   |
| E9    | Fix Accepted PATH A items that were selected from the snapshot                                              | actioned  |

The name intentionally emphasizes snapshot semantics: E1-E3 builds and
gates on a time-locked view, while E4-E8 triages that view.

## Artifact taxonomy and ownership

This repository contains several AI-facing artifact types. Keep their
ownership boundaries explicit:

- **Live repository instructions**: `.github/instructions/*.instructions.md`
  are the canonical workflow rules used by this repository and drive
  the execution loop.
- **Exported template files**: `idd-template/` is the portable package
  copied into adopter repositories. When live IDD instruction files
  change, mirror the equivalent portable form into this template.
- **Agent entry files**: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
  `.github/copilot-instructions.md` are lightweight compatibility entry
  points that tell each agent where to start.
- **Workflow docs**: files under `docs/` explain architecture, policy,
  and usage. They should avoid duplicating long operational rules that
  belong in `.github/instructions/`.
- **Native skill bundles**: `SKILL.md` bundles, when present, are
  separate agent-native helpers such as `skills/issue-authoring/`. The
  canonical source bundle in this repository stays under that path; when
  adopters install it elsewhere, they should place the bundle in the
  agent-specific skill directory their runtime reads. They may reference
  the workflow docs and schemas, but they should not duplicate or
  replace the exported IDD instruction template.

Use `skills/issue-authoring/` as the canonical source bundle when you
need pre-IDD issue drafting or decomposition. Install copies of that
bundle into the agent-specific skill directory your runtime reads, then
use `.github/instructions/*.instructions.md` after the issue set is
approved and the normal Discover -> Claim -> Work loop should start. The
canonical contract and schema for the native bundle live in
`docs/issue-authoring-skill.md`.

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

## Recursive Roadmap Hierarchies

IDD's roadmap traversal already follows transitive issue references, so
nested structures such as `root roadmap → track roadmap → leaf execution
issues` work without any extra configuration. This section explains when
to use them, how to structure them, and how discovery and audit behave at
each level.

### When to keep a roadmap flat

Start with a single-level roadmap. A flat task list inside one roadmap
issue is the right default when all sub-tasks belong to the same
implementation cycle, run at the same cadence, and can merge without
coordination across teams or phases. Adding nesting for its own sake
introduces unnecessary coordination overhead.

### When nesting adds value

Introduce a nested roadmap when the work genuinely needs a coordination
boundary that a flat task list cannot express cleanly:

- **Parallel tracks**: two sub-roadmaps that operate independently and
  merge on different schedules (for example, a data-layer track and a UI
  track that each need their own lifecycle before the parent can close).
- **Multi-session handoff**: a sub-roadmap that a different team or agent
  pool owns, where the parent roadmap should stay open until that team
  signals completion at the sub-roadmap level.

If the only reason to nest is that the task list feels long, keep the
flat structure and use numbered sections inside the roadmap body instead.

### Structuring a two-level hierarchy

A two-level hierarchy has one parent roadmap with nested track roadmaps
as children:

```text
Parent roadmap (#100)
├─ Track A — roadmap (#110)
│   ├─ Leaf issue #111
│   └─ Leaf issue #112
└─ Track B — roadmap (#120)
    ├─ Leaf issue #121
    └─ Leaf issue #122
```

Reference child roadmaps from the parent's task list using standard
`- [ ] #NNN` entries. Do not use `idd-skill-blocked-by` markers to group
sub-tasks under an active roadmap — that marker is reserved for true
sequential dependencies on a _separate, prior_ roadmap that must close
before the dependent work can start.

### Grouping versus sequential dependency

| Mechanism             | Syntax                                        | Meaning                                                    |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Task-list grouping    | `- [ ] #NNN` in roadmap body                  | Active parallel work; all items may proceed simultaneously |
| Sequential dependency | `<!-- idd-skill-blocked-by: {roadmap-id} -->` | This issue must wait until the named roadmap is closed     |

Use task-list links when you want concurrent execution. Use
`idd-skill-blocked-by` only when one roadmap phase must completely finish
before another can start.

### How discovery treats nested roadmap nodes

Discover (A2) traverses the full outbound reference graph from the
selected roadmap. Open nested roadmap nodes are traversal-only
coordination nodes: the agent walks through them to reach leaf execution
issues but never advances a roadmap node itself into the
readiness/claim/viability gates. Only non-roadmap leaf issues become
execution candidates.

The no-candidate diagnostic distinguishes "no reachable leaf execution
issues" from "only open roadmap nodes remain", so operators can tell
whether the tree is still healthy or whether leaf issues are missing.

When the recursive graph helper (#642) is available, it can enumerate
the full traversal graph, classify roadmap nodes separately from
execution candidates, and report provenance paths and cycle detection for
Discover and roadmap audit use.

### Bottom-up completion

Nested roadmaps create a natural bottom-up closing order. A nested
roadmap (for example, a track roadmap) is eligible to close as soon as
all of its own referenced leaf issues and any further descendants are
resolved. Its parent roadmap remains open while any nested roadmap child
is still open; only after all nested roadmap children close can the
parent roadmap itself be audited and closed.

Each roadmap-side mutation (comment, label, close) uses a
`roadmap-audit/*` coordination claim scoped to the roadmap issue being
mutated. These claims are coordination locks for roadmap-side effects
only and do not block child execution in other branches of the same tree.

### Issue-scope default

Nested roadmap support does not change the repository's default
`issue-scope`. The `roadmap` default means Discover always starts with
the selected roadmap and traverses its full graph, including nested
roadmap nodes, to find leaf execution candidates. Adopters who want
unblocked orphan issues to be considered before roadmap traversal must
choose `orphan-first` explicitly in `.github/idd/config.json`.

## Resume routing model

Resume now starts with a deterministic external-signal classifier before
claim-state branching. The classifier routes each run into one of four
paths: crash recovery, progress-stalled or rate-limit recovery,
stale-claim takeover, or ordinary clean continuation. This keeps crash
and stall handling separate without requiring the stalled session to
publish a final self-report.

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
the digest because they stop or leave merge intent anyway. The F3
awaiting-reviewer restart-F2 path is the exception: it skips digest
updates so the restarted F2 pass does not self-invalidate review
currency.

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
heavier `idd-overview.instructions.md` is excluded from review.

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
- `scripts/pre-merge-readiness.mjs` (read-only F2/F3 readiness evidence
  collection)
- `scripts/review-disposition-verify.mjs` (read-only E7 disposition
  verification evidence)
- `scripts/live-status-digest.mjs` (issue or PR live status digest
  dry-run and claim-checked upsert)
- `scripts/audit-pr-cleanup.mjs` (post-merge cleanup audit and optional
  apply mode)

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
