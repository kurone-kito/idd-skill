# AI tooling strategy

This repository currently prioritizes GitHub Copilot because it
provides the best latency and workflow fit for day-to-day vibe coding
in this project.

## Canonical guidance

- [.github/copilot-instructions.md](../.github/copilot-instructions.md)
  is the canonical, fully detailed AI guide. Keep it complete enough
  for GitHub Copilot CLI and VS Code Copilot Chat.
- [AGENTS.md](../AGENTS.md) is a Codex CLI and OpenCode compatibility
  entry point. It must stay self-contained for the rules those agents
  need immediately, then point to the canonical Copilot guide for the
  remaining detail.
- [CLAUDE.md](../CLAUDE.md) is a Claude Code compatibility entry point
  with the same role.
- [GEMINI.md](../GEMINI.md) is an Antigravity CLI (formerly Gemini CLI)
  compatibility entry point with the same role.

## Change policy

- Prefer preserving existing Copilot behavior over abstracting too
  early.
- Duplicate only the minimum guidance needed for non-Copilot agents to
  act safely and predictably.
- Extract shared text into a neutral document only after benchmarks
  show that the Copilot-first workflow does not regress.
- When a rule uses a Copilot-specific feature name, document the
  underlying intent so other agents can map it to their own interaction
  model.

## Maintenance notes

- Treat this file as a human-facing strategy note, not as the primary
  instruction file for any agent.
- For the deferred question of packaging the IDD execution loop as a
  Claude Code skill, see [claude-skill-strategy.md](claude-skill-strategy.md).
- When updating AI guidance, review `README.md`,
  `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, and
  `GEMINI.md` together.
