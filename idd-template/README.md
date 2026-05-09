# IDD Template

Portable Issue-Driven Development (IDD) workflow instructions for
multi-agent GitHub automation.

## Quick start (human)

1. Copy this directory's contents into a target repository.
2. Fill in the placeholders listed in `ONBOARDING.md`.
3. Update the agent entry files (`CLAUDE.md`, `copilot-instructions.md`,
   etc.) as described in `ONBOARDING.md`.
4. Optional: install the issue-authoring companion skill if the project
   wants pre-execution issue drafting.

## Quick start (AI agent)

Open `ONBOARDING.md`, follow the core import instructions there, and
install the optional issue-authoring companion only when the operator
explicitly asks for it.

## Artifact boundary

This template exports the portable IDD instruction files, onboarding
docs, and workflow docs that adopters copy into another repository for
the execution loop.

The issue-authoring skill is a public optional companion artifact at
`skills/issue-authoring/` in the source repository. It is not required
to run the IDD execution loop. Install it intentionally when a project
wants an agent to draft or decompose IDD-ready issues before execution
starts.

Keep the boundary clear: issue authoring prepares draft issues and
roadmaps; `.github/instructions/*.instructions.md` execute approved
issues through the normal IDD loop.

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
  idd-overview.instructions.md       ← shared definitions; auto-loaded by Copilot execution surfaces (applyTo: "**", excludeAgent: "code-review"); see docs/idd-workflow.md for per-agent loading
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
  idd-helper-scripts.md              ← optional helper-script evaluation and policy
  idd-comment-minimization.md        ← post-merge comment cleanup policy and experiment
ONBOARDING.md                        ← AI agent import guide (start here)
README.md                            ← this file

Optional companion artifact:
skills/issue-authoring/
  SKILL.md                           ← pre-execution issue drafting skill
  agents/openai.yaml                 ← optional OpenAI agent metadata
  references/contract.md             ← bundled issue authoring contract
  references/draft-patterns.md       ← drafting examples and output chooser
  references/workflow-boundary.md    ← publication/execution boundary
```

See `docs/idd-workflow.md` for the distinction between cross-agent
execution and the default Copilot-backed PR policy.

When maintaining the source repository, keep `skills/issue-authoring/`
and its bundled references aligned with `docs/issue-authoring-skill.md`.
Adopter copies are helper artifacts and should not replace the execution
instructions.

## Origin

Extracted from the `telephono` monorepo. Project-specific command sets
and marker prefixes have been replaced with placeholders.
