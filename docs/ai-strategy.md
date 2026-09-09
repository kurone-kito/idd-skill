---
type: design
title: AI tooling strategy
description: Explains why AGENTS.md is this repository's canonical AI guide and how the adapter entry files stay in sync with it.
tags: [ai-strategy, agents-md]
---

# AI tooling strategy

This repository's day-to-day AI work spans GitHub Copilot, Claude Code,
Codex CLI, OpenCode, Grok Build, and Antigravity CLI (formerly Gemini
CLI). The AI-instruction layout follows that multi-agent harness mix
rather than any one tool.

## Canonical guidance

- [AGENTS.md](../AGENTS.md) is the canonical, fully detailed AI guide.
  It follows the [AGENTS.md](https://agents.md) convention that Codex
  CLI, OpenCode, Grok Build, and GitHub Copilot (CLI, coding agent, and
  Chat) all discover automatically at the repository root. Keep new
  guidance here first.
- [CLAUDE.md](../CLAUDE.md) and [GEMINI.md](../GEMINI.md) are thin
  adapters for the two tools that do not read `AGENTS.md` by default in
  this repository's harness mix (Claude Code and Antigravity CLI). Each
  imports `AGENTS.md` via a standalone `@AGENTS.md` directive so its
  content loads automatically, then appends only the tool-scoped
  deltas `AGENTS.md` cannot state generically (a concrete token-cost
  `--vendor` value, `.claude/skills/` auto-discovery). They should stay
  short and rarely need edits beyond those deltas.
- [.github/copilot-instructions.md](../.github/copilot-instructions.md)
  is a thin GitHub Copilot adapter. Copilot already auto-discovers
  `AGENTS.md` directly, so this file only carries the notes genuinely
  specific to Copilot's own UI and tooling: mapping the shared "pause
  and ask when risky" guidance onto Agent mode / Plan mode terminology,
  the Copilot token-cost vendor-skip note, and the
  `applyTo`/`excludeAgent` note for `idd-overview-core`. It also keeps
  the `## Commit rules` heading as a pointer so
  `.github/CONTRIBUTING.md`'s `#commit-rules` fragment link keeps
  resolving without editing that community document.

## Change policy

- `AGENTS.md` is the source of truth. Adapters exist only to get the
  content in front of tools that would otherwise miss it, or to carry
  a genuinely tool-specific delta — do not duplicate guidance into
  them.
- When a rule needs tool-specific vocabulary (like Copilot's Agent mode
  / Plan mode), keep the neutral wording in `AGENTS.md` and put the
  vocabulary mapping in that tool's own adapter.

## Maintenance notes

- Treat this file as a human-facing strategy note, not as the primary
  instruction file for any agent.
- For the deferred question of packaging the IDD execution loop as a
  Claude Code skill, see [claude-skill-strategy.md](claude-skill-strategy.md).
- When updating AI guidance, review `AGENTS.md` first, then `CLAUDE.md`,
  `GEMINI.md`, `.github/copilot-instructions.md`, and `README.md` for
  anything that references it.

## History

This repository previously ran a Copilot-first layout, where
`.github/copilot-instructions.md` was the canonical, fully detailed
guide and `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` were near-duplicate
compatibility entry points (~180 lines each) with small tool-specific
deltas, with further consolidation deferred until benchmarks justified
it. That policy fit a period when Copilot was the primary day-to-day
tool; as the harness mix broadened and every new adapter file meant
another near-duplicate copy to keep in sync, the duplication cost grew
faster than any benchmark was going to resolve. The current layout
replaces that policy outright, at the project owner's request, in favor
of the single-source-plus-adapters structure described above, matching
the pattern [`kurone-kito/template`](https://github.com/kurone-kito/template)
adopted in its own `AGENTS.md`-consolidation
(`kurone-kito/template#32`, `#33`).
