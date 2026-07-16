# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that
wire up a multi-agent issue-driven pipeline for any GitHub
project.

**Canonical reference**: The full, authoritative project guidance
lives in
[`.github/copilot-instructions.md`](.github/copilot-instructions.md).
This file contains tool-specific guidance for Antigravity (formerly Gemini CLI).
When Copilot-specific workflow names appear, apply the intent in
Antigravity using Antigravity's own interaction model rather than
following product terms literally.

## Minimum requirements

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a
  clear project-specific reason otherwise.
- When editing `README.md`, also apply the equivalent change to
  `README.ja.md`, and vice versa. Keep both files in sync in the
  same commit.
- Avoid hard-coded repository file counts in docs unless the
  number is mechanically maintained. If count-based wording is
  necessary, update every mirrored reference in the same commit.
- If uncertainty, hidden risk, or missing context blocks a safe
  change, stop and ask a concise question before proceeding.
- Keep changes small and reviewable. Follow the project's
  Conventional Commits rules and keep each commit atomic.
- Do not modify community documents (`CODE_OF_CONDUCT*`,
  `CONTRIBUTING*`) without explicit approval.

## Project standards

- **Indentation**: 2 spaces
- **Line endings**: LF only
- **Trailing whitespace**: trimmed except in Markdown
- **Final newline**: always present
- **File naming**: lowercase with hyphens unless a platform
  convention requires otherwise
- **Helper sources**: the helper migration to TypeScript is complete —
  every `scripts/*.mjs` / `bin/*.mjs` is generated from a
  `src/**/*.mts` source by `pnpm run build` and committed; no
  hand-written helper `.mjs` path remains. `.mts` is the source of
  truth — edit the `.mts`, never the generated `.mjs`.
  See [docs/typescript-sources.md](docs/typescript-sources.md).

## Key workflow rules

- **Commits**: Follow
  [Conventional Commits](https://www.conventionalcommits.org/).
  A `.gitmessage` template is available at the repository root.
  Write user-facing, lowercase subjects under 72 characters, and
  split unrelated changes into separate atomic commits.
- **Branch strategy**: All changes reach `main` through pull
  requests (merge commits only). Feature branches may rebase onto
  `main` before the first PR-branch push; after publication, sync
  from `main` with a normal merge by default instead of rebasing.
  See
  [`.github/copilot-instructions.md`](.github/copilot-instructions.md#branch-strategy)
  for full rules.
- **Merge policy**: This source repository records
  `fully_autonomous_merge` as its local IDD dogfooding policy
  (applies only to `kurone-kito/idd-skill`). An IDD session may
  continue through F3 merge execution only after normal claim,
  freshness, CI, advisory, review, and unresolved-thread gates
  pass.
- **Discover concurrency**: This source repository also records
  `discover.selectionDesync: session-offset` as a local IDD
  dogfooding policy (applies only to `kurone-kito/idd-skill`),
  spreading concurrent-session A4 Step 2 candidate selection across
  a same-score tie band instead of every session converging on the
  same lowest-numbered issue, to cut claim races under this
  repository's heavy concurrent-session load.

## For IDD work

Open `.github/instructions/idd-overview-core.instructions.md` and the
relevant phase file before starting work. See
[docs/idd-workflow.md](docs/idd-workflow.md) for the cross-agent
entry path and phase routing.

## Issue-authoring skill (dogfooded)

The canonical issue-authoring skill bundle lives at
`skills/issue-authoring/`. Edit the canonical bundle, never a
generated copy: `node scripts/sync-docs.mjs --apply` regenerates
derived copies and `node scripts/audit-docs.mjs --check` fails on
drift.
