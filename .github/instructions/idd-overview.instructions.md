---
applyTo: "**"
excludeAgent: "code-review"
---

# IDD (Issue-Driven Development) — Shared Definitions

This file has been split into two focused files:

- **`idd-overview-core.instructions.md`**:
  Runtime-critical definitions always loaded on IDD execution.
  Contains claim format, ownership gates, and fail-closed safety checks.
- **`idd-overview-appendix.instructions.md`**:
  Reference content for maintainers and implementation guidance.
  Contains policy constants, digest rules, commit signing, template sync,
  and other reference material.

**On IDD startup**: Load `idd-overview-core.instructions.md` for the
current shared definitions and phase routing table.

**For detailed reference**: See `idd-overview-appendix.instructions.md`
for operational guidance and detailed implementations.

## Project commands

When a phase refers to a named command set, run the corresponding
commands. **Adapt this section when applying this workflow to a
different project.**

If `.github/idd/config.json` exists and validates against the canonical
schema, its `commands` object overrides the table below.

| Name                    | Commands                                                                                                                                     |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **fix-validate**        | `npx dprint fmt "**/*.md" && npx markdownlint-cli2 --fix "**/*.md" && npx markdownlint-cli2 "**/*.md"`                                       |
| **pre-push-validate**   | `npx dprint check "**/*.md" && npx markdownlint-cli2 "**/*.md" && npx cspell lint "**" --no-progress`                                        |
| **post-fix-validate**   | `npx dprint fmt "**/*.md" && npx markdownlint-cli2 --fix "**/*.md" && npx markdownlint-cli2 "**/*.md" && npx cspell lint "**" --no-progress` |
| **install-deps**        | `true`                                                                                                                                       |
| **issue-scope**         | `roadmap`                                                                                                                                    |
| **orphan-first-policy** | `none`                                                                                                                                       |
