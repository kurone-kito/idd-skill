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
