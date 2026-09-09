# Guidelines for AI Agents (GitHub Copilot)

This file is the GitHub Copilot entry point: VS Code Copilot Chat, the
standalone Copilot CLI, and the Copilot coding agent all discover it
automatically, and this repository's own
[docs/idd-workflow.md](../docs/idd-workflow.md) entry-point table names
it as the file to read first for Copilot execution surfaces. Copilot's
tooling also already discovers [`AGENTS.md`](../AGENTS.md) directly,
which is the canonical, tool-neutral guide for the rest of this
repository's AI-agent guidance — read it for everything except the
Copilot-specific notes below.

## Copilot-specific notes

- Map the shared "continue autonomously for low-risk work, but pause
  and ask a concise question when uncertainty or hidden risk makes the
  next step unsafe" guidance in `AGENTS.md` onto this project's actual
  UI: switch to Plan mode and ask the user when that pause condition
  applies while working in Agent mode.
- `schemas/token-cost-event.schema.json`'s `vendor` enum (`grok`,
  `claude`, `codex`) has no value for GitHub Copilot yet — skip the
  [Dogfood: token-cost events](../AGENTS.md#dogfood-token-cost-events)
  call rather than pass a mismatched vendor; a wrong tag would corrupt
  the shared dataset.
- `.github/instructions/idd-overview-core.instructions.md` loads
  automatically for GitHub Copilot execution surfaces because it has
  `applyTo: "**"`, but it is excluded from Copilot code review with
  `excludeAgent: "code-review"` so reviewer-side context stays lighter.
  Open the routed phase file manually when the current step changes.

## Commit rules

See [AGENTS.md](../AGENTS.md#commit-rules) for the full
commit-message rules.

See [docs/ai-strategy.md](../docs/ai-strategy.md) for why this
repository's AI instructions are laid out this way.
