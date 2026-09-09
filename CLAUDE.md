# Guidelines for AI Agents (Claude Code)

This file is the Claude Code entry point. Claude Code does not read
`AGENTS.md` automatically, so the full guidelines defined there are
imported below; treat the imported content as if it were written
directly in this file.

@AGENTS.md

## Claude Code-specific notes

- In Claude Code specifically, use `--vendor claude` for the
  [Dogfood: token-cost events](AGENTS.md#dogfood-token-cost-events)
  calls above, overriding the generic `--vendor <v>` placeholder for
  this tool.
- `.claude/skills/issue-authoring/` is a generated mirror of the
  canonical [issue-authoring skill](AGENTS.md#issue-authoring-skill-dogfooded)
  bundle's Markdown files (byte-identical per file), so Claude Code
  auto-discovers the skill in this repository.
- See [docs/idd-workflow.md](docs/idd-workflow.md) for the cross-agent
  entry path and phase routing this loop follows.
