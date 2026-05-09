# IDD Skill — Issue-Driven Development workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: **English** | [日本語](./README.ja.md)

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
or Gemini CLI. That execution model is cross-agent, even though the
distributed default review policy still includes the Copilot advisory
step noted below.

## Getting started

Use IDD in two separate steps:

1. [Install / onboard IDD](#install--onboard-idd) into a target
   repository.
2. [Run IDD after onboarding](#run-idd-after-onboarding) when the target
   repository is ready for the execution loop.

If you are an AI agent and only need the raw onboarding entry point, use
[For AI agents](#for-ai-agents).

## Runtime prerequisites

The IDD loop needs a few local tools and a GitHub access backend before
an agent can run it end to end:

- `git` for branch, worktree, fetch, rebase, merge, status, and commit
  operations.
- GitHub issue, pull request, review, checks, comments, branch
  protection/ruleset, and merge access through authenticated `gh` CLI or
  an equivalent GH MCP integration. The documented shell snippets use
  `gh`.
- `jq` for the documented shell snippets that parse paginated GitHub
  API responses.
- Node.js/npm with `npx` for the validation commands currently used by
  this repository: `dprint`, `markdownlint-cli2`, and `cspell`.
- `curl` or an equivalent REST client for posting HTML-comment
  operational markers when a path more reliable than `gh issue
  comment` is needed for comment bodies that start with HTML comments.

Optional helpers such as WorkTrunk, `git-wt`, and commit-signing aliases
can make the loop smoother, but they are not baseline requirements.

## Install / onboard IDD

To install IDD into a target repository, open a session there and tell
your AI agent one of the following:

**Short form** (agents with WebFetch or `gh` CLI access):

> Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
> repository.

**Explicit form** (works with any agent):

> I want to use `github:idd-skill`'s Issue-Driven Development in this
> repository. Read
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and onboard me.

The agent will collect a few project-specific values (repo name,
validation commands) and then set up the full IDD workflow
automatically — no manual file copying required.

Note: the distributed default template is cross-agent for execution, but
its later PR phases include a GitHub Copilot advisory review step by
default. If adopters do not want that PR policy, they can customize
`.github/instructions/idd-review-fix.instructions.md` and
`.github/instructions/idd-merge.instructions.md` after onboarding.

## For AI agents

If you were pointed here by a trigger phrase such as
`github:kurone-kito/idd-skill` and asked to onboard IDD, start with the
onboarding guide:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

Fetch that file and follow its instructions. It will walk you through
collecting placeholder values, copying the template files, and updating
the repository's agent entry files — no cloning required.

## Run IDD after onboarding

After onboarding, open a session in your target repository and tell your
AI agent to start the workflow. The agent should read
[docs/idd-workflow.md](docs/idd-workflow.md), then
`.github/instructions/idd-overview.instructions.md`, and continue into
the Discover → Claim → Work → ... loop.

**Example phrases**:

- `Start the IDD workflow in this repository.`
- `Read docs/idd-workflow.md`, then
  `.github/instructions/idd-overview.instructions.md`, and begin the
  Discover → Claim → Work loop.

## Use issue authoring before execution

Use the optional issue-authoring skill before the IDD execution loop
when a request is too large or ambiguous for one reviewable change,
needs roadmap or sub-issue decomposition, or has dependencies that
should be explicit before any agent claims work.

In this repository, route an agent to the native bundle with one of
these prompts:

- `Use the $issue-authoring skill to draft IDD-ready issues.`
- `Open skills/issue-authoring/SKILL.md and prepare the issue set.`

The skill prepares drafts and issue hygiene only. Publishing or editing
GitHub issues, and starting Discover → Claim → Work, are separate
actions that require explicit approval.

The full contract and schema are in
[docs/issue-authoring-skill.md](docs/issue-authoring-skill.md).
Adopters who import only `idd-template/` do not receive this bundle by
default; install the optional companion with
[idd-template/README.md](idd-template/README.md) and
[idd-template/ONBOARDING.md](idd-template/ONBOARDING.md) when they want
it.

## Why idd-skill?

- **Parallel agent coordination** — A built-in claim/heartbeat protocol
  (HTML comment markers in issue bodies) prevents multiple AI agents from
  picking up the same issue simultaneously, making true parallel
  development safe without a central orchestrator.
- **End-to-end phase coverage** — The instruction set encodes every
  step from issue discovery to merge, including CI wait loops, review
  triage, and review-fix cycles. Most tools stop at "open a PR".
- **Zero infrastructure** — No SaaS account, no GitHub Actions runner,
  no server required. Copy the `idd-template/` docs and instruction
  files into any repository and the workflow is ready.
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

## Artifact model

This repository primarily distributes an IDD instruction template, not a
single agent-native skill. The exported package in `idd-template/`
contains the portable `.github/instructions/` files, onboarding docs,
and workflow docs that adopters copy into another repository.

Agent entry files such as `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
`.github/copilot-instructions.md` are compatibility entry points for
this repository. Native `SKILL.md` bundles, when present, are separate
helpers that may reference the IDD docs but should not replace the
instruction template itself.

## This repository

This repository is itself maintained with the IDD workflow. See
[docs/idd-workflow.md](docs/idd-workflow.md) for the active workflow
guide and `.github/instructions/` for the full instruction set.

It also ships a repository-local native skill bundle at
`skills/issue-authoring/`. See
[Use issue authoring before execution](#use-issue-authoring-before-execution)
for routing examples and the approval boundary before the normal
execution loop begins.

## License

[MIT](./LICENSE)
