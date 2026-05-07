# Guidelines for AI Agents

This project is a language-independent generic project template.

When contributing to this repository using AI agents, adhere to the
following guidelines to ensure high-quality contributions that align with
the project's standards and practices:

## Tooling priority and compatibility

This repository is intentionally optimized for GitHub Copilot CLI and
VS Code Copilot Chat because they are the primary tools used for
day-to-day work and benchmarking.

`AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` exist as lightweight
compatibility entry points for Codex, Claude Code, and Gemini CLI
respectively. Keep this file as the canonical, fully detailed guide
unless benchmark results justify a more neutral layout.

## Conversation

- The conversational language should match the user's language.
  For example, if the user speaks in Japanese, respond in Japanese.
- However, comments and documentation should be written in English unless
  there is a clear context otherwise.
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
- **Rebase onto `main`** — when a feature branch needs the latest
  `main`, always rebase. Fetch first so the local `main` is not
  stale, e.g. `git fetch origin && git rebase origin/main`
  (or `git pull --rebase origin main`). Do not create merge commits
  inside feature branches.
- **Rebase between feature branches** — if one feature branch needs
  changes from another, use rebase, not merge.
- **Merge commits at PR boundary** — pull requests into `main` are
  merged with a merge commit (squash-merge and rebase-merge are
  disabled in the repository settings).
- **fixup + autosquash for in-branch fixes** — when a later commit in
  a feature branch fixes an earlier one, prefer
  `git commit --fixup=<sha>` followed by
  `git rebase -i --autosquash` to fold the fix into its target.
- **Avoid giant commits** — if squashing would produce an
  unreasonably large commit, keep the fix commit separate or
  re-split the history so each commit remains reviewable.

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

## Onboarding

This project template is generic and language-independent.
If you plan to implement a language-specific project based on this one,
**submit a proposal to customize this documentation first**.

### Derived-repository detection

When an AI agent starts a session, it should determine whether this
repository is the **base template** or a **derived project**:

1. **Check the repository name** — inspect the git remote URL
   (e.g., `git remote get-url origin`), the working-directory name,
   or any GitHub API context available to the agent. If the
   repository name is exactly `template`, treat it as the base
   template. Any other name indicates a derived project.
2. **Check for generic content** — look for the sentinel phrase
   `language-independent generic project template` in this file or
   in the repository's AI instruction files. Its presence means the
   guidelines have **not yet been customized**.

If both conditions are met — the repository is derived **and** the
guidelines are still generic — the agent should **proactively
propose an onboarding workflow** before proceeding with the user's
request. The proposal should be conversational, brief, and
non-blocking (the user may decline and continue normally).

### Onboarding proposal

When proposing onboarding, suggest customizing the following areas
in a single plan:

1. **Project description** — update `README.md` and the opening
   lines of AI instruction files to reflect the project's purpose
2. **Language / framework** — identify the primary language and
   framework; add relevant linter, formatter, and build tooling
3. **Dependency management** — set up the appropriate package
   manager (npm, pip, cargo, etc.) and lock-file conventions
4. **Testing strategy** — define the test runner, coverage targets,
   and test-file conventions
5. **CI/CD workflows** — adjust `.github/workflows/` to match the
   project's build, test, and deploy pipeline
6. **AI guideline specialization** — rewrite this file,
   `AGENTS.md`, `CLAUDE.md`, and `GEMINI.md` to include
   project-specific rules, coding patterns, and architecture notes
7. **README rewrite** — replace the template README with
   project-specific content (badges, installation, usage, etc.)
8. **License review** — confirm or replace the MIT license if the
   project requires a different one

Present these items as a checklist proposal (e.g., in Plan mode for
Copilot, or as a numbered list for other agents). Let the user
select which items to tackle and in what order.
