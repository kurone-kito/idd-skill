# Onboarding Reference — Agent Entry and Verification

Use this reference alongside `idd-template/ONBOARDING.md` when you need
the detailed agent-entry examples and expanded verification guidance
that the thin onboarding entry point now links to.

This page is the detailed companion for:

- Step 5 — update agent entry files
- Step 6 — verification checklist

## Agent entry files

By default, leave the target repository with root entry files for every
manually-routed non-Copilot agent named in `docs/idd-workflow.md`:
`CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.

Keep these rules explicit:

- If the file already exists, append or adapt an IDD workflow section
  without replacing unrelated repository guidance.
- If the file is missing, create a minimal stub.
- Only skip creating a missing root agent entry file when the operator
  explicitly opts out of adding new files.

### Shared IDD workflow stub

All three root entry files should point agents to the same workflow
entry path:

```markdown
## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.
```

### CLAUDE.md

If `CLAUDE.md` already exists, add the shared IDD workflow section
above and adapt the surrounding wording to the existing document style.

If `CLAUDE.md` does not exist, create a minimal file such as:

```markdown
# Guidelines for AI Agents

## Immediate rules

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a clear
  project-specific reason otherwise.
- If uncertainty, hidden risk, or missing context blocks a safe change,
  stop and ask a concise question before proceeding.

## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.
```

### AGENTS.md (for Codex CLI)

If `AGENTS.md` already exists, add the shared IDD workflow section and
keep the wording explicit that Codex CLI agents should manually open
`.github/instructions/idd-overview.instructions.md` and the routed
phase file before starting IDD work.

If `AGENTS.md` does not exist, create a minimal file such as:

```markdown
# Guidelines for AI Agents

## Immediate rules

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a clear
  project-specific reason otherwise.
- If uncertainty, hidden risk, or missing context blocks a safe change,
  stop and ask a concise question before proceeding.

## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.
```

### GEMINI.md

If `GEMINI.md` already exists, apply the same IDD workflow section as
`AGENTS.md`, adapted to Gemini CLI's wording and still pointing to
`docs/idd-workflow.md`.

If `GEMINI.md` does not exist, create a minimal file such as:

```markdown
# Guidelines for AI Agents

## Immediate rules

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a clear
  project-specific reason otherwise.
- If uncertainty, hidden risk, or missing context blocks a safe change,
  stop and ask a concise question before proceeding.

## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.
```

### .github/copilot-instructions.md (if present)

If `.github/copilot-instructions.md` already exists, add a parallel IDD
workflow section there as well so GitHub Copilot execution surfaces
receive the same entry path. Keep the
`excludeAgent: "code-review"` behavior in
`.github/instructions/idd-overview.instructions.md`; repository-wide
Copilot guidance may still apply during review.

## Verification details

Use the Step 6 checklist in `idd-template/ONBOARDING.md` as the final
go/no-go gate. When you need the concrete evidence behind those shorter
checks, confirm the detailed items below.

### Imported files and profile artifacts

- [ ] Every `idd-*.instructions.md` file listed in the generated core
      file list is present in `.github/instructions/`.
- [ ] `docs/getting-started.md`, `docs/concepts.md`,
      `docs/customization.md`, `docs/reference.md`,
      `docs/idd-workflow.md`,
      `docs/idd-review-policy-profiles.md`,
      `docs/idd-helper-scripts.md`,
      `docs/idd-comment-minimization.md`, and `docs/permissions.md`
      are present.
- [ ] `profiles/README.md` and the non-default profile artifacts under
      `profiles/` are present.

### Recorded policies and selected companions

- [ ] The operator's selected PR review policy profile is recorded, and
      the matching edit-surface checklist in
      `docs/idd-review-policy-profiles.md` is complete.
- [ ] If the selected PR review policy profile is non-default, the
      matching `profiles/<profile>/README.md` artifact was applied and
      its verification evidence is recorded.
- [ ] The operator's selected review-thread resolution policy is
      recorded, and any non-default profile has matching phase-file
      customizations.
- [ ] The operator's selected critique-loop profile is recorded, and any
      non-default profile has matching phase-file customizations.
- [ ] The operator's selected CI wait policy values
      (`ciWait.runningTimeout`, `ciWait.generationTimeout`,
      `ciWait.rerunPolicy`) are explicitly recorded for the target
      repository.
- [ ] The operator's selected merge policy is recorded in repository
      documentation, the F3 handoff behavior matches that policy, and
      worker credentials match that boundary.
- [ ] Ownership timing policy values `claim-stale-age` and
      `claim-heartbeat-interval` are explicitly recorded for the target
      repository.
- [ ] The selected helper runtime profile is recorded, including whether
      the repository stays on `instructions-only` or opted into
      `package-manager`, `vendored-node`, or `ephemeral-npx`.
- [ ] If the operator opted into issue authoring,
      `skills/issue-authoring/SKILL.md`,
      `skills/issue-authoring/agents/openai.yaml`, and the
      `skills/issue-authoring/references/` files are present.

### Placeholder, marker, and config alignment

- [ ] No `{{...}}` placeholders remain in any copied file.
- [ ] `.github/instructions/idd-overview.instructions.md` has
      `applyTo: "**"` and `excludeAgent: "code-review"` in its
      frontmatter.
- [ ] The `Project commands` table in
      `.github/instructions/idd-overview.instructions.md`
      contains the correct commands for this project.
- [ ] If the project chooses `issue-scope: orphan-first`, the
      `orphan-first-policy` value is recorded as `none`,
      `maintainer-approved`, or `public-disabled`. Public repositories
      use either `maintainer-approved` or `public-disabled`, not `none`.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names in
      `.github/instructions/idd-discover.instructions.md` and
      `.github/instructions/idd-overview.instructions.md`
      match the prefix chosen for this project.
- [ ] If `.github/idd/config.json` is used, it matches the recorded
      `iddVersion`, marker prefix, merge/review/thread policies,
      claim timing values, CI wait values, `trustedMarkerActors`, and
      command values.

### Agent entry files

- [ ] `CLAUDE.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] `AGENTS.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] `GEMINI.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] If `.github/copilot-instructions.md` existed before onboarding,
      it now includes the IDD workflow reference as well.
