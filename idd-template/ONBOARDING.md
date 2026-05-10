# IDD Template — AI Agent Onboarding

This document is the entry point for an AI agent tasked with importing
and configuring the IDD (Issue-Driven Development) workflow template into
a new repository.

> **Invoked via the trigger phrase?** If the operator told you to read
> this URL and onboard, you are in the right place. You do not need to
> clone the idd-skill repository — Step 2 Option A below provides the
> commands to download every template file directly from GitHub.
>
> Recognized trigger phrases:
>
> - Short form (Japanese):
>   _"`github:kurone-kito/idd-skill` の IDD をこのリポジトリにインポート＆オンボーディングして"_
> - Short form (English):
>   _"Import and onboard `github:kurone-kito/idd-skill`'s IDD into this
>   repository."_
> - Explicit form (works with any agent):
>   _"I want to use `github:idd-skill`'s Issue-Driven Development in this
>   repository. Read
>   `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/ONBOARDING.md`
>   and onboard me."_
>
> All forms lead here. Agents that received only a `github:owner/repo`
> reference and resolved this file by fetching the repository README are
> also in the right place.

## What you are setting up

IDD is a multi-agent GitHub automation workflow. Agents work through a
pipeline of phases (Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop) driven by GitHub Issues.
The instruction files in `.github/instructions/` encode every rule for
every phase.

Important: the distributed default workflow is cross-agent for
execution, but its later PR phases still include a GitHub Copilot
advisory review step by default. If the operator does not want that PR
policy, choose another profile in `docs/idd-review-policy-profiles.md`
and plan to customize the complete edit surface described there. At
minimum, non-default profiles touch
`.github/instructions/idd-review-fix.instructions.md`,
`.github/instructions/idd-pre-merge.instructions.md`, and
`.github/instructions/idd-merge.instructions.md`; some profiles require
additional files after import.

Also choose a review-thread resolution policy before treating the import
as complete. The distributed default is `fast-agent-resolve`, where an
agent may resolve review threads after it has acted on accepted,
rejected, or advisory feedback. Repositories that require reviewer
acknowledgement should choose `hybrid-reviewer-ack` or
`strict-reviewer-resolve` from `docs/idd-review-policy-profiles.md` and
customize the listed phase files before running unattended PR review
loops.

Before granting credentials to unattended or merge-capable agents, read
`docs/permissions.md` and choose the narrowest access profile that can
complete the intended phase.
Also choose a merge policy before the first unattended run:
`human_merge`, `separate_merge_agent`, or `fully_autonomous_merge`.
Treat `human_merge` as the safe default for public repositories;
`fully_autonomous_merge` is the explicit opt-in that gives one trusted
agent session merge authority. Record the selected policy in repository
documentation that future IDD sessions read.

## Your task

1. Read this entire document first.
2. Ask the operator for any placeholder values that are missing.
3. Fetch or copy the template files into the target repository.
4. Review `docs/permissions.md` with the operator before granting agent
   credentials.
5. Choose and record the operator's review-thread resolution policy.
6. Choose and record the operator's merge policy before allowing
   unattended workers to approach the merge phase. The record must live
   in repository documentation that future IDD sessions read.
7. Ask whether the operator wants the optional issue-authoring
   companion skill for pre-execution issue drafting.
8. Replace every placeholder (see table below) with the correct value.
9. Add IDD references to the repository's agent entry files.
10. Verify the result with the checklist at the bottom.

---

## Step 1 — Collect placeholder values

Before touching any file, ask the operator to supply values for every
placeholder that is not already known. Present the full table below and
request missing values.

| Placeholder                      | What it means                                                                                                                                                                                                  | Example                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `{{REPO_NAME}}`                  | The repository's short name. Used in worktree path examples.                                                                                                                                                   | `my-app`                                                            |
| `{{PROJECT_MARKER_PREFIX}}`      | A short, URL-safe prefix unique to this project. Used in HTML comment markers embedded in issue bodies to track roadmap and blocked-by state. The same prefix must be used consistently throughout all issues. | `my-app`                                                            |
| `{{FIX_VALIDATE_COMMANDS}}`      | Commands that auto-fix linting and verify the result. Run before every commit.                                                                                                                                 | `npm run lint:fix && npm run lint`                                  |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Commands that verify correctness before a push (no auto-fix — code must already be clean). Typically includes build and test.                                                                                  | `npm run lint && npm run build && npm run test`                     |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Commands that auto-fix and fully verify after review fixes. Usually a superset of the other two.                                                                                                               | `npm run lint:fix && npm run lint && npm run build && npm run test` |
| `{{INSTALL_DEPS_COMMAND}}`       | Command to install dependencies in a fresh worktree.                                                                                                                                                           | `npm install`                                                       |

> **No-op substitution**: any command that is not applicable to your
> project can be set to `true`. For example, a repository without a
> dependency install step uses `{{INSTALL_DEPS_COMMAND}}` = `true`.
> The same applies to validation commands in projects that do not use
> the listed tools — set the relevant placeholder to `true` to skip
> that step without breaking the workflow.

### Notes on `{{PROJECT_MARKER_PREFIX}}`

This prefix appears in two places in issue bodies as hidden HTML
comments:

- Roadmap identity marker (placed in the roadmap issue body):
  `<!-- {{PROJECT_MARKER_PREFIX}}-roadmap-id: {unique-id} -->`
- Blocked-by marker (placed in dependent issue bodies):
  `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: {roadmap-id} -->`

The prefix makes these markers unique across projects when issues are
shared or migrated. Choose a short, lowercase, hyphenated name matching
the repo (e.g., the repo name itself).

**Important — correct use of `blocked-by`**: the `blocked-by` marker
expresses a hard sequential dependency. Place it in an issue only when
that issue **must wait for the referenced roadmap to close** before work
can start (e.g., Phase 2 issues that depend on Phase 1 completing).

Do **not** use it to group sub-tasks under an active roadmap. Sub-tasks
that should be worked on while the roadmap is open belong in the
roadmap's task list as `- [ ] #NNN` entries. Using `blocked-by` for
grouping causes the discover phase to block every sub-task for the
entire lifetime of the roadmap.

---

## Step 2 — Fetch or copy template files

You need the following core execution files in the target repository.
Use whichever method applies to your situation.

The issue-authoring skill is available as an optional companion artifact
from `skills/issue-authoring/` in the source repository. That path is
the canonical source bundle; when you install it in a target repository,
place the copied bundle in the agent-specific skill directory your
runtime reads, such as `.github/skills/`, `.claude/skills/`, or
`.agents/skills/`. Install it only when the operator explicitly wants
pre-execution issue drafting or roadmap decomposition support.

Before importing, confirm whether the operator wants to keep the default
Copilot advisory review policy described above. If not, choose the
closest profile in `docs/idd-review-policy-profiles.md` and note which
phase files and profile-specific surfaces must be customized after the
files are copied in.

Confirm the review-thread resolution policy as well. Keep
`fast-agent-resolve` for the distributed default, or choose
`hybrid-reviewer-ack` / `strict-reviewer-resolve` when human review
threads must stay open until reviewer or maintainer acknowledgement.
Record the choice in repository documentation. For non-default profiles,
customize the review snapshot, review triage, review fix, pre-merge, and
merge phase files listed in `docs/idd-review-policy-profiles.md`.

Also confirm the operator's merge policy:
`human_merge`, `separate_merge_agent`, or `fully_autonomous_merge`.
Record the selected policy in repository documentation, such as a local
policy section in the imported docs or agent entry files. For
`human_merge` and `separate_merge_agent`, do not grant merge-capable
credentials to normal worker sessions; also add local guidance or
phase-file customization so workers hand off before F3.

### File list

<!-- audit:generated id=idd-template-core-files -->

```text
.github/instructions/idd-overview.instructions.md
.github/instructions/idd-discover.instructions.md
.github/instructions/idd-claim.instructions.md
.github/instructions/idd-work.instructions.md
.github/instructions/idd-pr-submit.instructions.md
.github/instructions/idd-ci.instructions.md
.github/instructions/idd-advisory-wait.instructions.md
.github/instructions/idd-review-snapshot.instructions.md
.github/instructions/idd-review-triage.instructions.md
.github/instructions/idd-review-fix.instructions.md
.github/instructions/idd-pre-merge.instructions.md
.github/instructions/idd-merge.instructions.md
.github/instructions/idd-resume.instructions.md
.github/instructions/idd-resume-stall.instructions.md
docs/idd-workflow.md
docs/idd-review-policy-profiles.md
docs/idd-helper-scripts.md
docs/idd-comment-minimization.md
docs/permissions.md
docs/getting-started.md
docs/concepts.md
docs/customization.md
docs/policy-constants.md
docs/reference.md
```

<!-- /audit:generated -->

Optional companion files:

<!-- audit:generated id=issue-authoring-companion-files -->

```text
skills/issue-authoring/SKILL.md
skills/issue-authoring/agents/openai.yaml
skills/issue-authoring/references/contract.md
skills/issue-authoring/references/draft-patterns.md
skills/issue-authoring/references/workflow-boundary.md
```

<!-- /audit:generated -->

Create the target directories if they do not exist.

### Option A — Remote fetch (no local clone required)

Use `gh api` or `curl` to download each file from the raw-content
endpoint. Replace `{DEST}` with the root of the target repository.

Base URL: `https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/`

Fetch all files with `gh api` (recommended — handles auth automatically):

<!-- audit:shell-list id=idd-template-core-gh-api-loop -->

```sh
DEST="."  # root of the target repository

mkdir -p "${DEST}/.github/instructions" "${DEST}/docs"

for FILE in \
  ".github/instructions/idd-overview.instructions.md" \
  ".github/instructions/idd-discover.instructions.md" \
  ".github/instructions/idd-claim.instructions.md" \
  ".github/instructions/idd-work.instructions.md" \
  ".github/instructions/idd-pr-submit.instructions.md" \
  ".github/instructions/idd-ci.instructions.md" \
  ".github/instructions/idd-advisory-wait.instructions.md" \
  ".github/instructions/idd-review-snapshot.instructions.md" \
  ".github/instructions/idd-review-triage.instructions.md" \
  ".github/instructions/idd-review-fix.instructions.md" \
  ".github/instructions/idd-pre-merge.instructions.md" \
  ".github/instructions/idd-merge.instructions.md" \
  ".github/instructions/idd-resume.instructions.md" \
  ".github/instructions/idd-resume-stall.instructions.md" \
  "docs/idd-workflow.md" \
  "docs/idd-review-policy-profiles.md" \
  "docs/idd-helper-scripts.md" \
  "docs/idd-comment-minimization.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md"
do
  gh api -H "Accept: application/vnd.github.raw+json" \
    "repos/kurone-kito/idd-skill/contents/idd-template/${FILE}" \
    > "${DEST}/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

If the operator opts into the issue-authoring companion, fetch it
separately and then move or copy it into the runtime-specific skill
directory the target agent expects:

<!-- audit:shell-list id=issue-authoring-companion-gh-api-loop -->

```sh
DEST="."  # root of the target repository

mkdir -p "${DEST}/skills/issue-authoring/agents" \
  "${DEST}/skills/issue-authoring/references"

for FILE in \
  "SKILL.md" \
  "agents/openai.yaml" \
  "references/contract.md" \
  "references/draft-patterns.md" \
  "references/workflow-boundary.md"
do
  gh api -H "Accept: application/vnd.github.raw+json" \
    "repos/kurone-kito/idd-skill/contents/skills/issue-authoring/${FILE}" \
    > "${DEST}/skills/issue-authoring/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

Alternatively, use `curl` (no authentication required — idd-skill is a public
repository):

<!-- audit:shell-list id=idd-template-core-curl-loop -->

```sh
BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template"
DEST="."  # root of the target repository

mkdir -p "${DEST}/.github/instructions" "${DEST}/docs"

for FILE in \
  ".github/instructions/idd-overview.instructions.md" \
  ".github/instructions/idd-discover.instructions.md" \
  ".github/instructions/idd-claim.instructions.md" \
  ".github/instructions/idd-work.instructions.md" \
  ".github/instructions/idd-pr-submit.instructions.md" \
  ".github/instructions/idd-ci.instructions.md" \
  ".github/instructions/idd-advisory-wait.instructions.md" \
  ".github/instructions/idd-review-snapshot.instructions.md" \
  ".github/instructions/idd-review-triage.instructions.md" \
  ".github/instructions/idd-review-fix.instructions.md" \
  ".github/instructions/idd-pre-merge.instructions.md" \
  ".github/instructions/idd-merge.instructions.md" \
  ".github/instructions/idd-resume.instructions.md" \
  ".github/instructions/idd-resume-stall.instructions.md" \
  "docs/idd-workflow.md" \
  "docs/idd-review-policy-profiles.md" \
  "docs/idd-helper-scripts.md" \
  "docs/idd-comment-minimization.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md"
do
  curl -fsSL "${BASE}/${FILE}" -o "${DEST}/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

If the operator opts into the issue-authoring companion with `curl`,
fetch it separately:

<!-- audit:shell-list id=issue-authoring-companion-curl-loop -->

```sh
BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/skills/issue-authoring"
DEST="."  # root of the target repository

mkdir -p "${DEST}/skills/issue-authoring/agents" \
  "${DEST}/skills/issue-authoring/references"

for FILE in \
  "SKILL.md" \
  "agents/openai.yaml" \
  "references/contract.md" \
  "references/draft-patterns.md" \
  "references/workflow-boundary.md"
do
  curl -fsSL "${BASE}/${FILE}" -o "${DEST}/skills/issue-authoring/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

### Option B — Local copy (idd-skill cloned)

If you have cloned `https://github.com/kurone-kito/idd-skill`, copy
the files from `idd-template/` into the target repository preserving
their relative paths.

If the operator opts into the issue-authoring companion, also copy
`skills/issue-authoring/` from the source repository to
`skills/issue-authoring/` in the target repository.

### Optional companion boundary

The issue-authoring companion drafts or refines IDD-ready issues,
roadmaps, and sub-issues before execution starts. It does not authorize
publishing issues, editing GitHub issues, or starting the Discover →
Claim → Work loop unless the operator explicitly asks for that next
step.

Keep the companion separate from the execution instructions:

- `skills/issue-authoring/` is a helper for drafting issue sets.
- `.github/instructions/*.instructions.md` execute approved issues
  through the IDD loop.
- In the source `idd-skill` repository, maintainers must keep
  `skills/issue-authoring/` and its bundled references aligned with
  `docs/issue-authoring-skill.md`.

---

## Step 3 — Replace placeholders

In the copied files, perform a global search-and-replace for each
placeholder:

| Placeholder                      | Replace with (operator-supplied value) |
| -------------------------------- | -------------------------------------- |
| `{{REPO_NAME}}`                  | _(operator value)_                     |
| `{{PROJECT_MARKER_PREFIX}}`      | _(operator value)_                     |
| `{{FIX_VALIDATE_COMMANDS}}`      | _(operator value)_                     |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | _(operator value)_                     |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | _(operator value)_                     |
| `{{INSTALL_DEPS_COMMAND}}`       | _(operator value)_                     |

After replacing, verify that no `{{...}}` placeholder strings remain in
any of the copied files.

---

## Step 4 — Update agent entry files

By default, leave the repository with root entry files for every
manually-routed non-Copilot agent named in `docs/idd-workflow.md`:
`CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`.

- If the file already exists, append or adapt an IDD section without
  replacing unrelated repository guidance.
- If the file is missing, create a minimal stub.
- Only skip creating a missing root agent entry file when the operator
  explicitly opts out of adding new files.

### CLAUDE.md

If `CLAUDE.md` already exists, add the following section (adapt wording
to fit the existing document style):

```markdown
## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview.instructions.md`. Open the routed
phase file manually when the current step changes.
```

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

### .github/copilot-instructions.md (if present)

Add a parallel section so GitHub Copilot execution surfaces also receive
the IDD context. The content can mirror the CLAUDE.md addition above.
The template keeps the heavier `idd-overview.instructions.md` out of
Copilot code review with `excludeAgent: "code-review"`; repository-wide
`.github/copilot-instructions.md` guidance may still apply to reviews.

### AGENTS.md (for Codex CLI)

If `AGENTS.md` already exists, add a short IDD workflow section that
points to `docs/idd-workflow.md` and tells Codex CLI agents to manually
open `.github/instructions/idd-overview.instructions.md` and the
relevant phase file before starting IDD work.

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

If `GEMINI.md` already exists, apply the same IDD guidance as
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

---

## Step 5 — Verification checklist

After completing the steps above, confirm each item:

- [ ] Every `idd-*.instructions.md` file listed in the generated core
      file list is present in `.github/instructions/`.
- [ ] `docs/getting-started.md`, `docs/concepts.md`,
      `docs/customization.md`, `docs/reference.md`,
      `docs/idd-workflow.md`,
      `docs/idd-review-policy-profiles.md`,
      `docs/idd-helper-scripts.md`,
      `docs/idd-comment-minimization.md`, and `docs/permissions.md`
      are present.
- [ ] The operator's selected PR review policy profile is recorded, and
      any non-default profile has matching phase-file customizations.
- [ ] The operator's selected review-thread resolution policy is
      recorded, and any non-default profile has matching phase-file
      customizations.
- [ ] The operator's selected critique-loop policy is recorded, and any
      non-default profile has matching phase-file customizations.
- [ ] The operator's selected merge policy is recorded in repository
      documentation, and worker credentials match that boundary.
- [ ] If the operator opted into issue authoring,
      `skills/issue-authoring/SKILL.md`,
      `skills/issue-authoring/agents/openai.yaml`, and the
      `skills/issue-authoring/references/` files are present.
- [ ] No `{{...}}` placeholders remain in any copied file.
- [ ] `idd-overview.instructions.md` has `applyTo: "**"` and
      `excludeAgent: "code-review"` in its frontmatter.
- [ ] `CLAUDE.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] `AGENTS.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] `GEMINI.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] If `.github/copilot-instructions.md` existed before onboarding,
      it now includes the IDD workflow reference as well.
- [ ] The `Project commands` table in `idd-overview.instructions.md`
      contains the correct commands for this project.
- [ ] If the project chooses `issue-scope: orphan-first`, the
      `orphan-first-policy` value is recorded as `none`,
      `maintainer-approved`, or `public-disabled`. Public repositories
      use either `maintainer-approved` or `public-disabled`, not `none`.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names in
      `idd-discover.instructions.md` and `idd-overview.instructions.md`
      match the prefix chosen for this project.

Once all items are checked, the IDD workflow is ready for use. Point the
operator to `docs/idd-workflow.md` as the starting guide.
