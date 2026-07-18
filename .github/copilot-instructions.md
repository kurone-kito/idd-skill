# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that wire up
a multi-agent issue-driven pipeline for any GitHub project.

When contributing to this repository using AI agents, adhere to the
following guidelines to ensure high-quality contributions that align with
the project's standards and practices:

## Tooling priority and compatibility

This repository is intentionally optimized for GitHub Copilot CLI and
VS Code Copilot Chat because they are the primary tools used for
day-to-day work and benchmarking.

`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` exist as lightweight
compatibility entry points: `AGENTS.md` serves Codex CLI and OpenCode,
`CLAUDE.md` serves Claude Code, and `GEMINI.md` serves
Antigravity CLI (formerly Gemini CLI). Keep this file as the canonical,
fully detailed guide unless benchmark results justify a more neutral
layout.

## Conversation

- The conversational language should match the user's language.
  For example, if the user speaks in Japanese, respond in Japanese.
- However, comments and documentation should be written in English unless
  there is a clear context otherwise.
- When editing `README.md`, also apply the equivalent change to
  `README.ja.md`, and vice versa. Keep both files in sync in the same
  commit.
- Avoid hard-coded repository file counts in docs unless the number is
  mechanically maintained. If count-based wording is necessary, update
  every mirrored reference in the same commit.
- If uncertainties, concerns, or other implementation issues arise while
  running in Agent mode, promptly switch to Plan mode and ask the user
  questions. In such cases, provide one or more recommended response
  options.
- Outside GitHub Copilot, interpret the `Agent mode` and `Plan mode`
  wording by intent: continue autonomously for low-risk work, but pause
  and ask a concise question when uncertainty or hidden risk makes the
  next step unsafe. When that pause is needed, provide one or more
  recommended response options.

## Branch strategy

This project follows
[GitHub Flow](https://docs.github.com/en/get-started/using-git/github-flow):
`main` is the only long-lived branch and every change reaches `main`
through a pull request.

### Rules

- **Never push directly to `main`** — all changes must go through a
  pull request. Branch protection is enforced on GitHub.
- **Rebase onto `main` before publication** — before the first D-phase
  push of a PR branch, rebase onto `main` as needed. Fetch first so the
  local `main` is not stale, e.g.
  `git fetch origin && git rebase origin/main`
  (or `git pull --rebase origin main`). Do not create merge commits
  inside unpublished feature branches.
- **Treat pushed PR branches as published review history** — after the
  first D-phase push, branch-state checks stay read-only until a later
  phase decides an update is required.
- **Default post-push sync: merge `main` into the PR branch** — when an
  already-pushed branch needs synchronization or conflict resolution,
  merge `main` into the PR branch and send that follow-up through the
  normal CI and review gates. Do not rebase or force-push merely
  because the PR is `BEHIND`. Treat this as the branch-policy contract;
  later-phase instruction and helper alignment may land separately
  before the runtime default is fully active end to end.
- **Force-push exceptions stay narrow** — use rebase and
  `--force-with-lease` after publication only when repository policy
  explicitly permits it and merge-based recovery cannot safely fix the
  branch, or when an already-started rebase must be completed or
  aborted during recovery.
- **Rebase between unpublished feature branches** — if one unpublished
  feature branch needs changes from another, use rebase, not merge.
- **Merge commits at PR boundary** — pull requests into `main` are
  merged with a merge commit (squash-merge and rebase-merge are
  disabled in the repository settings).
- **fixup + autosquash for unpublished in-branch fixes** — when a later
  commit in an unpublished feature branch fixes an earlier one, prefer
  `git commit --fixup=<sha>` followed by
  `git rebase -i --autosquash` to fold the fix into its target.
- **Avoid giant commits** — if squashing would produce an
  unreasonably large commit, keep the fix commit separate or
  re-split the history so each commit remains reviewable.

## Local merge policy

This source repository records `fully_autonomous_merge` as its local IDD
dogfooding policy. The setting applies only to `kurone-kito/idd-skill`
and does not change the exported template default for adopter
repositories.

An IDD session may continue through F3 merge execution only after the
normal claim, freshness, CI, advisory, review, and unresolved-thread
gates pass. Repositories without a recorded `fully_autonomous_merge`
policy still stop at the F3 handoff gate.

## Local discover policy

This source repository also records a local IDD dogfooding policy:
`discover.selectionDesync: session-offset`. The setting applies only
to `kurone-kito/idd-skill` and does not change the exported template
default for adopter repositories.

Concurrent-session A4 Step 2 candidate selection spreads across a
same-score tie band by a per-session offset instead of every session
converging on the same lowest-numbered issue, cutting claim races
under this repository's heavy concurrent-session load.

## Local external-check-waiver policy

This source repository also records a local IDD dogfooding policy:
`ciGate.externalCheckWaivers.mode: "maintainer-authorized"` with
`idd-advisory-convergence` registered under
`ciGate.externalChecks.waivable`. The setting applies only to
`kurone-kito/idd-skill` and does not change the exported template
default (`disabled` mode, empty `waivable` list) for adopter
repositories.

This is the human-maintainer off-ramp for the residual state where the
autonomous advisory-convergence loop cannot converge on its own (see
issue #1465): once the configured convergence deadline (default 24h)
has elapsed since the current PR HEAD's own commit timestamp, a trusted
maintainer can post a valid external-check waiver for
`idd-advisory-convergence` to unblock the gate. Treat this the same as
any other merge-gate bypass — a deliberate, short-lived,
maintainer-authorized exception for a genuinely stuck check, not a
routine substitute for a fresh Copilot review. See
[Customizing IDD](../docs/customization.md) and
[`docs/idd-helper-scripts.md`](../docs/idd-helper-scripts.md#external-check-waiver-contract)
for the general mechanism.

## Commit rules

This project follows
[Conventional Commits](https://www.conventionalcommits.org/).
A `.gitmessage` template is available at the repository root for
guidance when writing commit messages. Git does not use it
automatically, so contributors who want the template prefilled in
their editor should opt in once per clone:

```sh
git config commit.template .gitmessage
```

### Format

```txt
<type>[optional scope]: <user-facing description>

<body: address purpose, context, and what changed>

[optional footer(s)]
```

### Subject line

- Use the format: `<type>[optional scope]: <description>`
- Write from the **user's perspective** — briefly state what this
  commit solves or improves for the end user or developer
- Write in **lowercase**, imperative mood (e.g., "add", not "added")
- Keep the subject line under **72 characters**
- Do **not** end with a period

### Types

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`,
`chore`, `ci`, `build`, `perf`

### Scopes

- Optional, in parentheses: `feat(ci):`, `fix(lint):`, `docs(readme):`
- Keep scopes **lowercase**, short, and consistent
- Use the directory or component name that best describes the area

### Body (line 3+)

The body should address three aspects:

- **Why** — the purpose or motivation behind the change
- **Context** — what was needed, the situation or constraint
- **What changed** — the concrete action taken

Prefer the **why → context → change** order when practical.
Write these as **natural prose** — weave the aspects into
coherent sentences rather than using labeled sections. Labeled
sections (`Why:` / `Context:` / `Change:`) are acceptable only
when explicit paragraph separation improves clarity.

Omit any aspect whose information **cannot be reliably inferred**.
If the subject line is self-explanatory, the body may be omitted
entirely. **Breaking changes must always include a body.**

Wrap body lines at **72 characters**.

### Breaking changes

- Append `!` after the type/scope: `feat!: remove deprecated endpoint`
- Add a `BREAKING CHANGE:` trailer in the footer with a detailed
  explanation of what breaks and migration steps

### Footers / trailers

- `Closes #<issue>` / `Refs #<issue>` — link to issues
- `Co-authored-by: Name <email>` — credit co-authors
- `BREAKING CHANGE: <description>` — detail the breaking change

### Atomic commits

Keep each commit as **small and focused** as possible:

- **One logical change per commit** — if the subject line needs "and",
  consider splitting
- **Separate refactoring** from behavior changes
- **Separate formatting/style** changes from logic changes
- **Separate dependency updates** from code changes
- When in doubt, prefer smaller commits that are easy to review,
  revert, and bisect

### Examples

#### Good — single-line (trivial change)

```txt
fix: correct typo in feature request template
```

#### Good — prose body

```txt
feat(ci): add concurrency settings to lint workflow

Parallel lint runs on the same branch waste resources and
cause race conditions in status checks. GitHub Actions
supports concurrency groups that automatically cancel
redundant runs, so add a concurrency group keyed on branch
name with cancel-in-progress enabled.

Refs #42
```

#### Good — breaking change

```txt
feat!: require node 20 as minimum version

Node 18 reached end-of-life in April 2025 and no longer
receives security updates, while the project now standardizes
on the active Node 20 LTS baseline. All production
environments have already been upgraded to node 20+, so
update the engines field and CI matrix to require node >= 20.

BREAKING CHANGE: drop support for node 16 and 18. Users
must upgrade to node 20 or later.
Closes #108
```

#### Bad — vague, developer-centric

```txt
fix: update code
```

#### Bad — too large / non-atomic

```txt
feat: add auth system and refactor database layer and update docs
```

## Coding Standards

- **Indentation**: 2 spaces (enforced by `.editorconfig`)
- **Line endings**: LF only (enforced by `.editorconfig` and
  `.gitattributes`)
- **Trailing whitespace**: trimmed (except in Markdown)
- **Final newline**: always present
- **File naming**: lowercase with hyphens (e.g., `feature-request.yml`)
  unless constrained by a platform convention (e.g., `CONTRIBUTING.md`)

## Guardrails

- **Do not** modify community documents (CODE_OF_CONDUCT, CONTRIBUTING)
  without explicit approval

## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](../docs/idd-workflow.md) for
the cross-agent entry path and phase routing.

`.github/instructions/idd-overview-core.instructions.md` loads automatically
for GitHub Copilot execution surfaces because it has `applyTo: "**"`,
but it is excluded from Copilot code review with
`excludeAgent: "code-review"` so reviewer-side context stays lighter.
Open the routed phase file manually when the current step changes.
