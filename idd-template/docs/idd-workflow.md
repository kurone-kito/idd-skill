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

| Agent / surface         | Read first                        | Automatically available IDD context                                                                                                         | Open manually                                                                 |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GitHub Copilot surfaces | `.github/copilot-instructions.md` | `.github/instructions/idd-overview.instructions.md`; package-scoped `.instructions.md` files in VS Code Copilot when editing matching paths | The routed phase file when the current step changes                           |
| Codex CLI               | `AGENTS.md`                       | None from `.github/instructions/`                                                                                                           | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Claude Code             | `CLAUDE.md`                       | None from `.github/instructions/` by default                                                                                                 | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Gemini CLI              | `GEMINI.md`                       | None from `.github/instructions/`                                                                                                           | `.github/instructions/idd-overview.instructions.md` and the routed phase file |

## IDD file map

| File                                                     | Role                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `.github/instructions/idd-overview.instructions.md`      | Shared definitions, command sets, routing table, critique-pass mapping |
| `.github/instructions/idd-discover.instructions.md`      | Find the next viable issue to start                                    |
| `.github/instructions/idd-claim.instructions.md`         | Run claim pre-checks and claim verification                            |
| `.github/instructions/idd-work.instructions.md`          | Create the worktree, plan, implement, and self-review                  |
| `.github/instructions/idd-pr-submit.instructions.md`     | Rebase, validate, push, open the PR, and wait for CI                   |
| `.github/instructions/idd-ci.instructions.md`            | Shared CI polling helper used by later phases                          |
| `.github/instructions/idd-review-triage.instructions.md` | Collect review items, score them, and respond to rejections            |
| `.github/instructions/idd-review-fix.instructions.md`    | Fix accepted review items and push follow-up commits                   |
| `.github/instructions/idd-merge.instructions.md`         | Re-check merge gates, resolve final conflicts, merge, and clean up     |
| `.github/instructions/idd-resume.instructions.md`        | Recover after a crash, timeout, or handoff                             |

## Instruction files, not agent-native skills

The files in `.github/instructions/*.instructions.md` are repository
instruction files. Some older project text may still use "skill files"
as shorthand, but these documents are not agent-native `SKILL.md`
bundles.

## Repository-specific Copilot advisory review addendum

The core IDD flow is cross-agent, but later PR phases intentionally
include a repository-specific GitHub Copilot advisory review step.

- `idd-review-fix.instructions.md` can request a GitHub Copilot
  re-review for the current PR head.
- `idd-merge.instructions.md` can wait or hold based on that GitHub
  review state.
- This dependency is on GitHub's review integration, not on every local
  agent using Copilot as its CLI.

Non-Copilot agents can still drive the workflow end to end, but they
should expect those later phases to interact with Copilot as a GitHub
reviewer because that is part of this repository's current PR policy.
