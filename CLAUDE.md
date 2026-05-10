# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that wire up
a multi-agent issue-driven pipeline for any GitHub project.

It is currently optimized for GitHub Copilot tooling, but `CLAUDE.md`
exists so Claude Code can still receive the minimum project rules
immediately, without depending on a redirect.

## Immediate rules

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a clear
  project-specific reason otherwise.
- When editing `README.md`, also apply the equivalent change to
  `README.ja.md`, and vice versa. Keep both files in sync in the same
  commit.
- Avoid hard-coded repository file counts in docs unless the number is
  mechanically maintained. If count-based wording is necessary, update
  every mirrored reference in the same commit.
- If uncertainty, hidden risk, or missing context blocks a safe change,
  stop and ask a concise question before proceeding.
- Keep changes small and reviewable. If you create commits, follow the
  project's Conventional Commits rules and keep each commit atomic.
- Do not modify community documents (`CODE_OF_CONDUCT*`,
  `CONTRIBUTING*`) without explicit approval.

## Project standards

- **Indentation**: 2 spaces
- **Line endings**: LF only
- **Trailing whitespace**: trimmed except in Markdown
- **Final newline**: always present
- **File naming**: lowercase with hyphens unless a platform convention
  requires otherwise

## Commit rules

This project follows
[Conventional Commits](https://www.conventionalcommits.org/).
A `.gitmessage` template is available at the repository root.
Write user-facing, lowercase subjects, keep them under 72 characters,
and split unrelated changes into separate atomic commits.

## Branch strategy

This project follows GitHub Flow. All changes reach `main` through
pull requests (merge commits only — squash and rebase merge are
disabled). Feature branches are always rebased onto `main`, never
merged. See the full rules in
[.github/copilot-instructions.md](.github/copilot-instructions.md#branch-strategy).

## Local merge policy

This source repository records `fully_autonomous_merge` as its local IDD
dogfooding policy. The setting applies only to `kurone-kito/idd-skill`
and does not change the exported template default for adopter
repositories.

An IDD session may continue through F3 merge execution only after the
normal claim, freshness, CI, advisory, review, and unresolved-thread
gates pass. Repositories without a recorded `fully_autonomous_merge`
policy still stop at the F3 handoff gate.

## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.

## Canonical reference

The full, Copilot-first project guidance lives in
[.github/copilot-instructions.md](.github/copilot-instructions.md).
When that file uses Copilot-specific workflow names, apply the intent
in Claude Code using its own interaction model rather than following
the product terms literally.
