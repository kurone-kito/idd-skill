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

## Default PR policy note

The distributed template is cross-agent for execution, but its later PR
phases include a GitHub Copilot advisory review step by default. If an
adopter does not want that PR policy, they can customize
`.github/instructions/idd-review-fix.instructions.md`,
`.github/instructions/idd-pre-merge.instructions.md`, and
`.github/instructions/idd-merge.instructions.md` after import.

## Placeholders

| Placeholder                      | Description                               |
| -------------------------------- | ----------------------------------------- |
| `{{REPO_NAME}}`                  | Repository short name                     |
| `{{PROJECT_MARKER_PREFIX}}`      | Unique prefix for issue body HTML markers |
| `{{FIX_VALIDATE_COMMANDS}}`      | Lint-fix + lint commands                  |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Lint + build + test (no auto-fix)         |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Lint-fix + lint + build + test            |
| `{{INSTALL_DEPS_COMMAND}}`       | Install dependencies                      |

## Files

```text
.github/instructions/
  idd-overview.instructions.md       ← shared definitions; auto-loaded by Copilot surfaces (applyTo: "**"); see docs/idd-workflow.md for per-agent loading
  idd-discover.instructions.md       ← A0–A4: find and select next issue
  idd-claim.instructions.md          ← A5: claim pre-checks and execution
  idd-work.instructions.md           ← B+C: branch, plan, implement, self-review
  idd-pr-submit.instructions.md      ← D: rebase, validate, push, open PR, CI wait
  idd-ci.instructions.md              ← shared CI polling helper
  idd-advisory-wait.instructions.md  ← shared Copilot advisory-wait protocol
  idd-review-snapshot.instructions.md ← E1–E3: fetch activity, critique, empty check
  idd-review-triage.instructions.md  ← E4–E8: classify, score, and record dispositions
  idd-review-fix.instructions.md     ← E9–E15: fix, push, reply, CI wait
  idd-pre-merge.instructions.md      ← F1–F2: conflict resolution and pre-merge conditions
  idd-merge.instructions.md          ← F3–F5: merge execution, cleanup, and loop
  idd-resume.instructions.md         ← resume after crash / handoff
docs/
  idd-workflow.md                    ← cross-agent entry point and file map
ONBOARDING.md                        ← AI agent import guide (start here)
README.md                            ← this file
```

See `docs/idd-workflow.md` for the distinction between cross-agent
execution and the default Copilot-backed PR policy.

## Origin

Extracted from the `telephono` monorepo. Project-specific command sets
and marker prefixes have been replaced with placeholders.
