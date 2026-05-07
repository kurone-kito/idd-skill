# IDD Template

Portable Issue-Driven Development (IDD) workflow instructions for
multi-agent GitHub automation.

## Quick start (human)

1. Copy this directory's contents into a target repository.
2. Fill in the placeholders listed in `ONBOARDING.md`.
3. Update the agent entry files (`CLAUDE.md`, `copilot-instructions.md`,
   etc.) as described in `ONBOARDING.md`.

## Quick start (AI agent)

Open `ONBOARDING.md` and follow the instructions there.

## Placeholders

| Placeholder                      | Description                                      |
| -------------------------------- | ------------------------------------------------ |
| `{{REPO_NAME}}`                  | Repository short name                            |
| `{{PROJECT_MARKER_PREFIX}}`      | Unique prefix for issue body HTML markers        |
| `{{FIX_VALIDATE_COMMANDS}}`      | Lint-fix + lint commands                         |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Lint + build + test (no auto-fix)                |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Lint-fix + lint + build + test                   |
| `{{INSTALL_DEPS_COMMAND}}`       | Install dependencies                             |

## Files

```text
.github/instructions/
  idd-overview.instructions.md       ← shared definitions, auto-loaded (applyTo: **)
  idd-discover.instructions.md       ← A1–A4: find and select next issue
  idd-claim.instructions.md          ← A5: claim pre-checks and execution
  idd-work.instructions.md           ← B+C: branch, plan, implement, self-review
  idd-pr-submit.instructions.md      ← D: rebase, validate, push, open PR, CI wait
  idd-ci.instructions.md             ← shared CI polling helper
  idd-review-triage.instructions.md  ← E1–E8: fetch, classify, and triage review items
  idd-review-fix.instructions.md     ← E9–E15: fix, push, reply, CI wait
  idd-merge.instructions.md          ← F: final checks, merge, cleanup, loop
  idd-resume.instructions.md         ← resume after crash / handoff
docs/
  idd-workflow.md                    ← cross-agent entry point and file map
ONBOARDING.md                        ← AI agent import guide (start here)
README.md                            ← this file
```

## Origin

Extracted from the `telephono` monorepo. Project-specific command sets
and marker prefixes have been replaced with placeholders.
