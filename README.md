# IDD Skill — Issue-Driven Development workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

A portable set of `.github/instructions/` files and documentation that
wire up an Issue-Driven Development (IDD) multi-agent pipeline for any
GitHub project.

## Quick start

Open a session in your target repository and tell your AI agent:

> I want to use `github:idd-skill`'s Issue-Driven Development in this
> repository. Read
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and onboard me.

The agent will collect a few project-specific values (repo name,
validation commands) and then set up the full IDD workflow
automatically — no manual file copying required.

## What is IDD?

IDD is a multi-agent GitHub automation workflow where AI agents work
through a repeating pipeline driven entirely by GitHub Issues. The
phases are: Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop.

Each phase is encoded as a `.github/instructions/` file that any
compatible AI agent can load — GitHub Copilot, Claude Code, Codex CLI,
or Gemini CLI.

## Why idd-skill?

- **Parallel agent coordination** — A built-in claim/heartbeat protocol
  (HTML comment markers in issue bodies) prevents multiple AI agents from
  picking up the same issue simultaneously, making true parallel
  development safe without a central orchestrator.
- **End-to-end phase coverage** — 10 instruction files encode every step
  from issue discovery to merge, including CI wait loops, review triage,
  and review-fix cycles. Most tools stop at "open a PR".
- **Zero infrastructure** — No SaaS account, no GitHub Actions runner,
  no server required. Copy 11 Markdown files into any repository and the
  workflow is ready.
- **Agent-agnostic** — Core phases work across GitHub Copilot, Claude
  Code, OpenAI Codex CLI, and Gemini CLI without rewriting any
  instructions. (The default template includes a Copilot advisory review
  step in later phases; see [docs/positioning.md](docs/positioning.md)
  for details.)
- **Fully auditable** — Every rule is plain Markdown. Read it, fork it,
  adapt it. No black box.

See [docs/positioning.md](docs/positioning.md) for a detailed
competitive landscape and strategic positioning analysis.

## Importing IDD manually

1. Clone or download this repository.
2. Copy the `idd-template/` directory contents into your target repository.
3. Follow `idd-template/ONBOARDING.md` to fill in the placeholders and
   update your agent entry files.

## This repository

This repository is itself maintained with the IDD workflow. See
[docs/idd-workflow.md](docs/idd-workflow.md) for the active workflow
guide and `.github/instructions/` for the full instruction set.

## License

[MIT](./LICENSE)
