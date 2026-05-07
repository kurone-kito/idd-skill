# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that wire up
a multi-agent issue-driven pipeline for any GitHub project.

It is currently optimized for GitHub Copilot tooling, but `GEMINI.md`
exists so Gemini CLI can still receive the minimum project rules
immediately, without depending on a redirect.

## Immediate rules

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a clear
  project-specific reason otherwise.
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

## IDD Workflow

Open `.github/instructions/idd-overview.instructions.md` and the
relevant phase file before starting IDD work. See
[docs/idd-workflow.md](docs/idd-workflow.md) for the cross-agent entry
path and phase routing.

## Canonical reference

The full, Copilot-first project guidance lives in
[.github/copilot-instructions.md](.github/copilot-instructions.md).
When that file uses Copilot-specific workflow names, apply the intent
in Gemini CLI using its own interaction model rather than following the
product terms literally.
