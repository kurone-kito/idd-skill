# IDD Skill — Issue-Driven Development workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

A portable set of `.github/instructions/` files and documentation that
wire up an Issue-Driven Development (IDD) multi-agent pipeline for any
GitHub project.

## What is IDD?

IDD is a multi-agent GitHub automation workflow where AI agents work
through a repeating pipeline driven entirely by GitHub Issues. The
phases are: Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop.

Each phase is encoded as a `.github/instructions/` file that any
compatible AI agent can load — GitHub Copilot, Claude Code, Codex CLI,
or Gemini CLI.

## Importing IDD into your project

### With an AI agent (recommended)

Start a session in your target repository and ask your agent:

> Read `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and follow the instructions to import IDD into this repository.

The agent will ask for a few project-specific values (repo name,
validation commands) and then copy the instruction files and update
your agent entry files automatically.

### Manually

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
