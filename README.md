# IDD Skill — Issue-Driven Development workflow

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Linting](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml/badge.svg)](https://github.com/kurone-kito/idd-skill/actions/workflows/lint.yml)
[![CodeRabbit](https://img.shields.io/badge/review-CodeRabbit-green?logo=coderabbit)](https://www.coderabbit.ai/)

🌐 Language: **English** | [日本語](./README.ja.md)

Turn AI coding from one-off prompts into a GitHub-native delivery loop
that keeps going until the issue is closed.

IDD Skill gives a repository a portable Issue-Driven Development
workflow: agents discover ready issues, claim ownership, implement in a
branch, open a PR, handle review feedback, wait for CI, merge, and clean
up according to the repository's selected merge policy. The whole loop
lives in your repo as Markdown instruction files.

## Why Teams Use IDD

AI coding agents are powerful, but team workflows get messy fast:

- Two agents can pick the same issue.
- Review comments can be accepted but never fixed.
- CI can finish after the agent has already stopped watching.
- A PR can merge while fresh review activity is still arriving.
- The workflow rules can hide inside a vendor platform instead of your
  repository.

IDD Skill turns those moving parts into an auditable GitHub-native loop.
Issue comments record claims, review snapshots, decisions, holds, and
cleanup markers so another agent can resume the work without guessing.

## Quick Start

### Install IDD

Open an AI-agent session in the repository that should adopt IDD and say:

> Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
> repository.

If the agent needs an explicit URL, use:

> Read
> `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
> and onboard this repository for Issue-Driven Development.

The onboarding guide collects project-specific values, copies the
portable template, and updates the agent entry files. No manual file
copying is required when the agent has the needed GitHub access.

### Run the Loop

After onboarding, start an agent in the target repository and say:

> Start the IDD workflow in this repository.

The agent reads the workflow guide, discovers a ready issue, claims it,
and follows the loop through work, PR review, CI, the selected merge
policy, and cleanup.

### Validate onboarding with IDD doctor (optional)

After importing IDD, run the doctor script once in a repository that has
the helper installed (this source repository includes it by default) to
catch common setup drift:

```sh
node scripts/idd-doctor.mjs
```

The report checks core IDD file presence, unresolved placeholders,
marker-prefix consistency, command-table sanity, and (when `gh` access
is available) branch-protection and required-check signals.

## Reality Check

IDD is Markdown-native, not dependency-free.

To run the full loop, an agent needs:

- `git`
- An authenticated `gh` CLI or equivalent GitHub MCP integration
- `jq`
- A REST client such as `curl`
- Node.js/npm with `npx` (optional for non-Node.js projects — see
  [Tooling boundary](docs/customization.md#tooling-boundary))
- Repository-scoped GitHub credentials appropriate for the chosen merge
  policy
- Branch protection and required review policy already configured when
  those gates are part of the loop

See the workflow docs for the detailed command contract. Review
[Permissions and threat model](docs/permissions.md) before granting
credentials to unattended or merge-capable agents.
The distributed default allows worker sessions to continue through merge
(`fully_autonomous_merge`).
`human_merge` and `separate_merge_agent` keep merge authority outside
the worker session by explicit opt-in. Choose and record one profile in
[Customizing IDD](docs/customization.md).

## Footprint and sizing guidance

IDD keeps instruction growth mechanically bounded. The maintained budget
values are tracked in policy docs and enforced by audit metadata rather
than hand-counted file totals:

| Budget type                           | Maintained value |
| ------------------------------------- | ---------------- |
| Always-loaded instruction file        | 20,000 bytes     |
| Phase instruction file                | 30,000 bytes     |
| Discovery bundle (`bundle-discovery`) | 75,000 bytes     |
| Resume bundle (`bundle-resume`)       | 46,000 bytes     |

See [Policy constants: Runtime Instruction Size and Bundle
Budgets](docs/policy-constants.md#runtime-instruction-size-and-bundle-budgets)
for the canonical table and ownership details.

To inspect current source-repo footprint evidence:

```sh
node scripts/audit-docs.mjs --check
jq '.instructionSizeBudgets, .bundleBudgets' audit/sync-manifest.json
```

`audit-docs` verifies that the current instruction files still fit the
maintained limits, and `sync-manifest.json` carries the budget contract.

For adopters, practical loop pressure depends on helper runtime choices:

- Prefer helper runtime support when you want lower day-to-day context
  pressure in E/F phases (helper commands collect evidence, while merge
  and mutation decisions still follow written gates).
- Keep `instructions-only` when your repository avoids Node.js/helper
  tooling or your team prefers a fully manual shell/`gh`/`jq` path.
- Expect variance either way: local policy additions, local docs, and
  extra repository instructions can make your practical footprint smaller
  or larger than this source repository.

Use [ONBOARDING Step 1B policy decisions](idd-template/ONBOARDING.md#step-1b--confirm-policy-decisions)
and [helper runtime selection order](docs/idd-helper-scripts.md#import-time-selection-order)
to pick a profile deliberately.

## Operational Evidence

As of 2026-05-12, this repository has been dogfooding IDD through
multi-agent, multi-session runs, including bursts of roughly x4-6
parallel sessions. The workflow also originated in a private work
repository and was later backported here, where it was exercised for
about two weeks with roughly x8-10 concurrent Copilot CLI sessions.
That is not zero-failure; it is a workflow that keeps getting tightened
as edge cases appear.

## Local pnpm tooling baseline (contributors to this repository only)

This repository uses a project-local pnpm baseline and Husky hooks so
contributors and autopilot runs can enforce the minimum lint gate before
commit. **This section is specific to dogfooding work in this source
repository.** Template adopters do not need pnpm — use your project's
existing tooling and configure the validate commands accordingly. See
[Tooling boundary](docs/customization.md#tooling-boundary) for
adopter-facing guidance.

```sh
corepack enable
pnpm install
pnpm run lint
pnpm run test
```

The pre-commit hook runs `pnpm run lint:minimum`, and the commit message
hook enforces Conventional Commits through commitlint.

When you edit canonical source files in `idd-template/`, run
`pnpm run docs:sync` to propagate the changes to all mirrored artifacts.

### 5-Minute Reading Path

Use the focused docs in this order when you are evaluating or adopting
IDD:

1. [Getting started](docs/getting-started.md) — import the template and
   run the first loop.
2. [Core concepts](docs/concepts.md) — learn the claim, review, merge,
   and cleanup vocabulary.
3. [Customization](docs/customization.md) — choose policy surfaces
   without forking the whole workflow.
4. [Permissions and threat model](docs/permissions.md) — decide which
   credentials each agent profile should receive.
5. [Reference manual](docs/index.md) and
   [detailed reference](docs/reference.md) — jump from the landing page
   into phase files, policies, and maintenance notes.

## What IDD Automates

IDD is intentionally boring in the best way: every phase has a named
job, a resumable marker, and a next step.

| Stage       | What the agent does                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| Discover    | Finds ready roadmap or orphan issues without silently widening scope.                                       |
| Claim       | Reserves one issue with a machine-readable ownership marker.                                                |
| Work        | Creates a branch/worktree, plans, implements, and self-reviews.                                             |
| Submit PR   | Pushes, opens a PR, and waits for validation to become reviewable.                                          |
| Review Loop | Captures review activity, accepts or rejects feedback, and fixes accepted items.                            |
| Merge       | Rechecks freshness, advisory review state, CI, unresolved threads, comments, and the selected merge policy. |
| Cleanup     | After a completed merge, hides stale markers when safe and loops back.                                      |

The full phase map lives in
[docs/idd-workflow.md](docs/idd-workflow.md) and the
`.github/instructions/` files.

## What You Get

- **Collision-resistant parallel work** — Claim and heartbeat markers
  make issue ownership visible without a central coordinator.
- **Fewer stalled PRs** — The workflow keeps watching review comments,
  CI, and follow-up fixes after the initial pull request opens.
- **Portable rules, not a black box** — The workflow is plain Markdown
  that can be inspected, forked, and customized in the target repo.
- **Agent choice** — The core loop works across GitHub Copilot, Claude
  Code, OpenAI Codex CLI, and Gemini CLI. The distributed default PR
  policy still includes a Copilot advisory review step, with documented
  review policy profiles for adopters who use another gate.
- **No service to operate** — Import the template files; no separate
  server, scheduler, or SaaS account is required to start.

For deeper positioning, see
[docs/positioning.md](docs/positioning.md).

## What This Repository Ships

The primary package is [`idd-template/`](idd-template/): a portable set
of `.github/instructions/` files, onboarding docs, workflow docs, and a
machine-readable policy file (`.github/idd/config.json`) that adopters
copy into their own repositories. The policy file lets agents and tools
read repository settings (merge policy, command strings, marker prefix)
without parsing Markdown.

This repository also includes compatibility entry files such as
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
`.github/copilot-instructions.md` so different agents know where to
start here.

Native `SKILL.md` bundles are optional companions. The canonical source
bundle in this repository lives at `skills/issue-authoring/`; when you
install it in a target repository, place it in the agent-specific skill
directory your runtime reads, such as `.github/skills/`,
`.claude/skills/`, or `.agents/skills/`. They can help with pre-execution
tasks such as issue drafting, but they do not replace the portable
instruction template.

This source repository's optional helper bundle also includes a
maintainer-facing forced-handoff path. `idd-force-handoff` is a TTY-only
operator command that asks for an issue number, asks for a PR number
only when a live open PR exists on the active claim branch, previews the
successor claim IDs and marker body, and then requires a final `y/N`
confirmation before posting anything. The lower-level
`idd-forced-handoff-marker` helper remains available for rendering or
inspection, but unattended or autopilot contexts must not use the
interactive facade.

## For AI Agents

If a user points you at `github:kurone-kito/idd-skill` and asks you to
onboard IDD, fetch this file first:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md
```

Follow it exactly. It explains which files to copy, which placeholders
to fill, and which target-repository entry files to update.

## When a Request Is Too Big

Use the optional issue-authoring companion before the IDD execution loop
when a request needs decomposition, dependency encoding, or roadmap and
sub-issue drafting.

In this repository, ask an agent to:

- `Use the $issue-authoring skill to draft IDD-ready issues.`
- `Open skills/issue-authoring/SKILL.md and prepare the issue set.`

Issue authoring only prepares issue drafts and hygiene. Publishing
issues or starting Discover -> Claim -> Work still requires explicit
approval.

## Deeper Reference

- [Getting started](docs/getting-started.md) — the shortest safe path
  from import to the first IDD loop.
- [Core concepts](docs/concepts.md) — the vocabulary behind claims,
  review snapshots, merge gates, and cleanup.
- [Customization](docs/customization.md) — adopter-controlled policy
  surfaces and workflow edit points.
- [Reference manual](docs/index.md) — a task-oriented entry point for
  the deeper documentation set.
- [Detailed reference](docs/reference.md) — phase files, policy docs,
  and template-maintenance links without duplicating rules.
- [Workflow guide](docs/idd-workflow.md) — entry points, file map, and
  cross-agent routing.
- [Review policy profiles](docs/idd-review-policy-profiles.md) — choose
  the default Copilot advisory PR policy or a documented alternative.
- [Customization](docs/customization.md) — choose review, merge, CI, and
  discovery policy surfaces.
- [Positioning](docs/positioning.md) — competitive landscape and why
  IDD is different.
- [Permissions and threat model](docs/permissions.md) — access profiles,
  forbidden credentials, and safe operating guidance.
- [Issue authoring contract](docs/issue-authoring-skill.md) — optional
  pre-execution issue drafting model.
- [Comment minimization](docs/idd-comment-minimization.md) —
  post-merge cleanup policy.
- [Template import guide](idd-template/ONBOARDING.md) — raw onboarding
  instructions for target repositories.

## License

[MIT](./LICENSE)
