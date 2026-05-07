# AI tooling strategy

This repository currently prioritizes GitHub Copilot because it
provides the best latency and workflow fit for day-to-day vibe coding
in this template.

## Canonical guidance

- [.github/copilot-instructions.md](../.github/copilot-instructions.md)
  is the canonical, fully detailed AI guide. Keep it complete enough
  for GitHub Copilot CLI and VS Code Copilot Chat.
- [AGENTS.md](../AGENTS.md) is a Codex compatibility entry point. It
  must stay self-contained for the rules that Codex needs immediately,
  then point to the canonical Copilot guide for the remaining detail.
- [CLAUDE.md](../CLAUDE.md) is a Claude Code compatibility entry point
  with the same role.
- [GEMINI.md](../GEMINI.md) is a Gemini CLI compatibility entry point
  with the same role.

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

## Onboarding detection

When the repository name is not `template` and the AI instruction
files still contain the generic sentinel phrase, AI agents should
proactively propose a customization workflow. This keeps the
template's "vibe-coding ready" promise alive in derived projects by
guiding users through documentation, tooling, and guideline
specialization immediately after they create a new repository from
the template. The full onboarding checklist is maintained in
`.github/copilot-instructions.md` § Onboarding.

## Maintenance notes

- Treat this file as a human-facing strategy note, not as the primary
  instruction file for any agent.
- When updating AI guidance, review `README.md`,
  `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, and
  `GEMINI.md` together.
