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

## IDD file map

| File                                                       | Role                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `.github/instructions/idd-overview.instructions.md`        | Shared definitions, command sets, routing table, critique-pass mapping |
| `.github/instructions/idd-discover.instructions.md`        | Find the next viable issue to start                                    |
| `.github/instructions/idd-claim.instructions.md`           | Run claim pre-checks and claim verification                            |
| `.github/instructions/idd-work.instructions.md`            | Create the worktree, plan, implement, and self-review                  |
| `.github/instructions/idd-pr-submit.instructions.md`       | Rebase, validate, push, open the PR, and wait for CI                   |
| `.github/instructions/idd-ci.instructions.md`              | Shared CI polling helper used by later phases                          |
| `.github/instructions/idd-advisory-wait.instructions.md`   | Shared Copilot advisory-wait protocol (E14, F2, F3)                    |
| `.github/instructions/idd-review-snapshot.instructions.md` | E1–E3: fetch activity snapshot, run critique, check if List A is empty |
| `.github/instructions/idd-review-triage.instructions.md`   | E4–E8: classify items, score, record dispositions                      |
| `.github/instructions/idd-review-fix.instructions.md`      | Fix accepted review items and push follow-up commits                   |
| `.github/instructions/idd-pre-merge.instructions.md`       | F1–F2: resolve conflicts and verify all pre-merge conditions           |
| `.github/instructions/idd-merge.instructions.md`           | F3–F5: execute the merge, clean up, and loop back to discover          |
| `.github/instructions/idd-resume.instructions.md`          | Recover after a crash, timeout, or handoff                             |
| `docs/idd-comment-minimization.md`                         | Post-merge comment minimization policy, commands, and experiment notes |

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
  separate agent-native helpers such as `skills/issue-authoring/`. They
  may reference the workflow docs and schemas, but they should not
  duplicate or replace the exported IDD instruction template.

Use `skills/issue-authoring/` when you need pre-IDD issue drafting or
decomposition. Use `.github/instructions/*.instructions.md` after the
issue set is approved and the normal Discover -> Claim -> Work loop
should start. The canonical contract and schema for the native bundle
live in `docs/issue-authoring-skill.md`.

The IDD workflow distributed from this repository is therefore an
instruction template first. Native skills can sit beside it as helpers,
but the synchronization contract for the portable workflow remains
between the live `.github/instructions/` files and `idd-template/`.

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
- Adopters who do not want that default PR policy should edit
  `idd-review-fix.instructions.md` and `idd-merge.instructions.md`.

Non-Copilot agents can still drive the workflow end to end, but they
should expect those later phases to interact with Copilot as a GitHub
reviewer because that is part of this repository's current PR policy.

## Optional helper scripts

The current workflow does not require helper scripts for pre-merge
gates. Shell / `gh` / `jq` snippets in
`.github/instructions/*.instructions.md` remain the canonical portable
path for adopters.

See [IDD helper script evaluation](idd-helper-scripts.md) for the
current inventory of high-friction query patterns, the narrow
post-merge cleanup helper that is adopted in this source repository, and
the criteria for reconsidering additional optional helpers later.

See [IDD comment minimization](idd-comment-minimization.md) for the
post-merge cleanup helper, GraphQL fallback command shape, and merged-PR
experiment for hiding completed feedback and stale operational markers
without deleting the audit trail.
