# IDD Skill — Issue-Driven Development workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: **English** | [日本語](./README.ja.md)

Turn AI coding from one-off prompts into a GitHub-native delivery loop
that keeps going until the issue is closed.

IDD Skill gives a repository a portable Issue-Driven Development
workflow: agents discover ready issues, claim ownership, implement in a
branch, open a PR, handle review feedback, wait for CI, merge, and
clean up. The whole loop ships as plain Markdown instruction files that
live in your repository — yours to inspect, fork, and audit.

## Why IDD exists

A capable coding agent should finish work the way a strong teammate
does: visibly, verifiably, and all the way to done. Most AI coding
breaks down not at writing code but at everything around it:

- Two agents can pick the same issue.
- Review comments can be accepted but never fixed.
- CI can finish after the agent has already stopped watching.
- A PR can merge while fresh review activity is still arriving.
- The workflow rules can hide inside a vendor platform instead of your
  repository.

IDD turns those moving parts into one auditable GitHub-native loop.
Issue comments record claims, review snapshots, decisions, holds, and
cleanup markers — so any agent can resume any work without guessing.

## What you get

- **Collision-resistant parallel work** — claim and heartbeat markers
  make issue ownership visible without a central coordinator.
- **Fewer stalled PRs** — the loop keeps watching review comments, CI,
  and follow-up fixes after the pull request opens.
- **Portable rules, not a black box** — plain Markdown you can
  inspect, fork, and customize in your own repository.
- **Agent choice** — works across GitHub Copilot, Claude Code, OpenAI
  Codex CLI, OpenCode, and Antigravity CLI (formerly Gemini CLI);
  [review policy profiles](docs/idd-review-policy-profiles.md) let you
  swap the default Copilot advisory gate.
- **No service to operate** — no server, scheduler, or SaaS account;
  import the template files and start.

## Proven in production

IDD is not a demo. It is the workflow this repository is built with:

- **2,000+ issues** turned into merged pull requests across private
  work repositories running IDD.
- **700+ pull requests** merged in this public repository alone,
  through multi-agent bursts of x4-6 parallel sessions (x8-10 in the
  originating private deployment).
- **Not zero-failure by design** — edge cases found in production
  come back as issues, and the loop fixes itself.

_As of 2026-07._

## Quick Start

Open an AI-agent session in the repository that should adopt IDD and
say:

> Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
> repository.

If the agent needs an explicit URL, use:

> Read
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and onboard this repository for Issue-Driven Development.

Then start the loop:

> Start the IDD workflow in this repository.

The agent discovers a ready issue, claims it, and follows the loop
through work, PR review, CI, the selected merge policy, and cleanup.
See [Getting started](docs/getting-started.md) for the full first-run
path, including the optional IDD doctor validation.

### Prerequisites

The full loop needs `git`, an authenticated `gh` CLI (or an equivalent
GitHub MCP integration), `jq`, a REST client such as `curl`, and
optionally Node.js for the helper scripts (see
[Tooling boundary](docs/customization.md#tooling-boundary)). Review
[Permissions and threat model](docs/permissions.md) before granting
credentials to unattended or merge-capable agents, and record a merge
policy in [Customizing IDD](docs/customization.md).

### For AI agents

If a user points you at `github:kurone-kito/idd-skill` and asks you to
onboard IDD, fetch this file first and follow it exactly:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

It explains which files to copy, which placeholders to fill, and which
target-repository entry files to update.

## How it works

Every phase has a named job, a resumable marker, and a next step:

| Stage       | What the agent does                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Discover    | Finds ready roadmap or orphan issues without silently widening scope.                                       |
| Claim       | Reserves one issue with a machine-readable ownership marker.                                                |
| Work        | Creates a branch/worktree, plans, implements, and self-reviews.                                             |
| Submit PR   | Pushes, opens a PR, and waits for validation to become reviewable.                                          |
| Review Loop | Captures review activity, accepts or rejects feedback, and fixes accepted items.                            |
| Merge       | Rechecks freshness, advisory review state, CI, unresolved threads, comments, and the selected merge policy. |
| Cleanup     | After a completed merge, hides stale markers when safe and loops back.                                      |

The design follows **loop engineering**: trigger, topology, verifier,
and stop rules designed as a system — what Anthropic frames as
**agentic loops** — built on durable issue-comment state instead of a
custom runtime. See
[Core concepts](docs/concepts.md#idd-as-loop-engineering) for that
framing and [docs/idd-workflow.md](docs/idd-workflow.md) for the full
phase map.

## Learn by example

Follow the [VRChat Event Calendar workshop](docs/workshop/README.md)
to watch IDD build a real app end to end, then inspect the live
companion repository at
[`kurone-kito/vrc-event-calendar`](https://github.com/kurone-kito/vrc-event-calendar).

## Where next

| Goal                                              | Start here                                                                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand the concept first                      | [`docs/concepts.md`](docs/concepts.md)                                                                                                                                          |
| Adopt IDD in my repository                        | [`idd-template/ONBOARDING.md`](idd-template/ONBOARDING.md)                                                                                                                      |
| Run an agent on this repository                   | [`AGENTS.md`](AGENTS.md) (Codex CLI and OpenCode), [`CLAUDE.md`](CLAUDE.md), [`GEMINI.md`](GEMINI.md), and [`.github/copilot-instructions.md`](.github/copilot-instructions.md) |
| Author AI-ready issues before the loop            | [`skills/issue-authoring/SKILL.md`](skills/issue-authoring/SKILL.md)                                                                                                            |
| Customize review, merge, CI, and discovery policy | [`docs/customization.md`](docs/customization.md)                                                                                                                                |
| Everything else — the full reference manual       | [`docs/index.md`](docs/index.md)                                                                                                                                                |

The primary package is [`idd-template/`](idd-template/): the portable
`.github/instructions/` files, onboarding and workflow docs, and a
machine-readable policy file (`.github/idd/config.json`) that adopters
copy into their own repositories. Contributor tooling for this source
repository lives in
[`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

## License

[MIT](./LICENSE)
