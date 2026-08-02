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
(`iddVersion`, marker prefix, merge/review/thread policies,
claim timing values, `trustedMarkerActors`, and JSON-escaped command
strings). This JSON is optional and does not replace
`.github/instructions/*.instructions.md` as the execution authority.

## Placeholders

| Placeholder                      | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `{{REPO_NAME}}`                  | Repository short name                           |
| `{{PROJECT_MARKER_PREFIX}}`      | Marker prefix matching `^[a-z][a-z0-9-]{1,31}$` |
| `{{TRUSTED_MARKER_ACTOR}}`       | Single JSON-escaped trusted marker login        |
| `{{FIX_VALIDATE_COMMANDS}}`      | Lint-fix + lint commands                        |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Lint + build + test (no auto-fix)               |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Lint-fix + lint + build + test                  |
| `{{INSTALL_DEPS_COMMAND}}`       | Install dependencies                            |

## Files

The complete `idd-template/` file inventory below is mechanically kept
in sync by the upstream `idd-skill` source repository's own tooling
(`audit/sync-manifest.json` plus `node scripts/sync-docs.mjs --apply`)
— those two paths are source-repo maintenance tooling, not files this
template ships into an adopter repository. See `docs/idd-workflow.md`'s
file map and `docs/reference.md` for what each instruction and docs
page does. This is the full shipped inventory, not the adopter import
list — the narrower set an agent actually fetches during onboarding is
generated separately in `ONBOARDING.md`.

<!-- audit:generated id=idd-template-readme-core-files -->

```text
.claude/settings.json
.githooks/_idd-worktree-guard.sh
.githooks/pre-commit
.githooks/pre-push
.github/idd/config.json
.github/instructions/idd-advisory-wait.instructions.md
.github/instructions/idd-ci.instructions.md
.github/instructions/idd-claim.instructions.md
.github/instructions/idd-discover.instructions.md
.github/instructions/idd-merge-handoff.instructions.md
.github/instructions/idd-merge.instructions.md
.github/instructions/idd-overview-appendix.instructions.md
.github/instructions/idd-overview-core.instructions.md
.github/instructions/idd-pr-submit.instructions.md
.github/instructions/idd-pre-merge.instructions.md
.github/instructions/idd-resume-stall.instructions.md
.github/instructions/idd-resume.instructions.md
.github/instructions/idd-review-fix.instructions.md
.github/instructions/idd-review-snapshot.instructions.md
.github/instructions/idd-review-triage.instructions.md
.github/instructions/idd-roadmap-audit.instructions.md
.github/instructions/idd-suitability.instructions.md
.github/instructions/idd-work.instructions.md
.github/instructions/lite/idd-advisory-wait-lite.instructions.md
.github/instructions/lite/idd-ci-lite.instructions.md
.github/instructions/lite/idd-claim-lite.instructions.md
.github/instructions/lite/idd-merge-handoff-lite.instructions.md
.github/instructions/lite/idd-pr-submit-lite.instructions.md
.github/instructions/lite/idd-pre-merge-lite.instructions.md
.github/instructions/lite/idd-resume-lite.instructions.md
.github/instructions/lite/idd-resume-stall-lite.instructions.md
.github/instructions/lite/idd-review-fix-lite.instructions.md
.github/instructions/lite/idd-review-snapshot-lite.instructions.md
.github/instructions/lite/idd-work-lite.instructions.md
.github/workflows/idd-advisory-convergence.yml
.github/workflows/post-merge-cleanup.yml
docs/concepts.md
docs/customization.md
docs/getting-started.md
docs/idd-advisory-wait-shell-fallback.md
docs/idd-autonomy-contract.md
docs/idd-comment-minimization.md
docs/idd-concept-ownership.md
docs/idd-design-rationale.md
docs/idd-helper-scripts.md
docs/idd-resume-detail.md
docs/idd-review-policy-profiles.md
docs/idd-workflow.md
docs/index.md
docs/onboarding/agent-entry-and-verification.md
docs/onboarding/placeholders.md
docs/onboarding/policy-decisions.md
docs/onboarding/template-distribution.md
docs/permissions.md
docs/policy-constants.md
docs/reference.md
ONBOARDING.md
profiles/external-bot/README.md
profiles/human-required/README.md
profiles/no-advisory/README.md
profiles/README.md
README.md
scripts/minimize-superseded-markers.mjs
```

<!-- /audit:generated -->

Optional companion artifact:

<!-- audit:generated id=idd-template-readme-issue-authoring-files -->

```text
skills/issue-authoring/SKILL.md
skills/issue-authoring/references/contract.md
skills/issue-authoring/references/draft-patterns.md
skills/issue-authoring/references/workflow-boundary.md
```

<!-- /audit:generated -->

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
