# IDD Template

Portable Issue-Driven Development (IDD) workflow instructions for
multi-agent GitHub automation.

## Quick start (human)

1. Copy this directory's contents into a target repository.
2. Fill in the placeholders listed in `ONBOARDING.md`.
3. Update the agent entry files (`CLAUDE.md`, `copilot-instructions.md`,
   etc.) as described in `ONBOARDING.md`.
4. Read `docs/getting-started.md` for the shortest safe path from
   import to the first IDD loop.
5. Read `docs/customization.md` before changing review, merge, CI, or
   discovery policy.
6. Choose a PR review policy profile. If it is non-default, apply the
   matching profile artifact from `profiles/`.
7. Choose and record a merge policy in repository documentation while
   reviewing `docs/permissions.md` before granting credentials to
   unattended or merge-capable agents.
8. Optional: install the issue-authoring companion skill if the project
   wants pre-execution issue drafting. The canonical source bundle in
   this repository lives at `skills/issue-authoring/`; install copies
   into the agent-specific skill directory your runtime reads.

## Quick start (AI agent)

Open `ONBOARDING.md`, follow the core import instructions there, and
install the optional issue-authoring companion only when the operator
explicitly asks for it.

## Artifact boundary

This template exports the portable IDD instruction files, onboarding
docs, and workflow docs that adopters copy into another repository for
the execution loop.

The issue-authoring skill is a public optional companion artifact whose
canonical source bundle lives at `skills/issue-authoring/` in the source
repository. It is not required to run the IDD execution loop. Install
it intentionally in the agent-specific skill directory your runtime
reads when a project wants an agent to draft or decompose IDD-ready
issues before execution starts.

Keep the boundary clear: issue authoring prepares draft issues and
roadmaps; `.github/instructions/*.instructions.md` execute approved
issues through the normal IDD loop.

## Default PR policy note

The distributed template is cross-agent for execution, but its later PR
phases include a GitHub Copilot advisory review step by default. If an
adopter does not want that PR policy, they should choose a profile in
`docs/idd-review-policy-profiles.md` and apply the matching artifact
from `profiles/`. The artifact records the complete edit surface,
adopter-owned values, and verification evidence for the selected
non-default profile.

## Merge credential policy note

IDD can run an end-to-end loop, but normal worker credentials should not
imply merge authority. Before granting unattended credentials, choose
`human_merge`, `separate_merge_agent`, or `fully_autonomous_merge` in
`docs/customization.md` and `docs/permissions.md`, and record the choice
in repository documentation that future IDD sessions read. The
distributed default is `fully_autonomous_merge`; choose `human_merge` or
`separate_merge_agent` as explicit opt-out profiles when normal worker
sessions must hand off before F3.

## Optional machine-readable config

Adopters that want a stable config input for local tooling can add
`.github/idd/config.json` and mirror their recorded policy decisions
(merge policy, review policy, thread resolution policy, marker prefix,
and command strings). This JSON is optional and does not replace
`.github/instructions/*.instructions.md` as the execution authority.

## Placeholders

| Placeholder                      | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `{{REPO_NAME}}`                  | Repository short name                           |
| `{{PROJECT_MARKER_PREFIX}}`      | Marker prefix matching `^[a-z][a-z0-9-]{1,31}$` |
| `{{FIX_VALIDATE_COMMANDS}}`      | Lint-fix + lint commands                        |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Lint + build + test (no auto-fix)               |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Lint-fix + lint + build + test                  |
| `{{INSTALL_DEPS_COMMAND}}`       | Install dependencies                            |

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
  idd-resume-stall.instructions.md   ← stalled-session recovery gate
docs/
  getting-started.md                  ← concise import-to-first-loop guide
  customization.md                    ← adopter policy customization guide
  policy-constants.md                 ← distributed timing, wait, and loop defaults
  reference.md                        ← detailed phase and policy navigation
  idd-workflow.md                    ← cross-agent entry point and file map
  idd-review-policy-profiles.md      ← default and alternative PR review policies
  idd-helper-scripts.md              ← optional helper-script evaluation and policy
  idd-comment-minimization.md        ← post-merge comment cleanup policy and experiment
  permissions.md                     ← permission profiles and threat model
profiles/
  README.md                          ← profile artifact index
  human-required/README.md           ← required human review artifact
  no-advisory/README.md              ← no advisory reviewer artifact
  external-bot/README.md             ← external advisory bot artifact
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
execution and PR review policy, and
`docs/idd-review-policy-profiles.md` for the default Copilot-backed
policy plus alternatives.

When maintaining the idd-skill source repository, keep `skills/issue-authoring/`
and its bundled references aligned with `docs/issue-authoring-skill.md`.
Adopter copies are helper artifacts and should not replace the execution
instructions.

## Origin

Extracted from the `telephono` monorepo. Project-specific command sets
and marker prefixes have been replaced with placeholders.
