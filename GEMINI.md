# Guidelines for AI Agents (Antigravity CLI)

This file is the Antigravity CLI (formerly Gemini CLI) entry point.
Antigravity CLI reads `GEMINI.md` by default rather than `AGENTS.md`, so
the full guidelines defined there are imported below; treat the
imported content as if it were written directly in this file.

@AGENTS.md

## Antigravity-specific notes

- `schemas/token-cost-event.schema.json`'s `vendor` enum has no value
  for Antigravity yet (`grok`, `claude`, `codex` only), so skip calling
  `node scripts/token-cost-event.mjs`
  ([Dogfood: token-cost events](AGENTS.md#dogfood-token-cost-events))
  for now rather than passing a mismatched vendor — a wrong tag would
  corrupt the shared dataset.
- See [docs/idd-workflow.md](docs/idd-workflow.md) for the cross-agent
  entry path and phase routing this loop follows.
