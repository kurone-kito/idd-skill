# IDD Template — AI Agent Onboarding

This document is the entry point for an AI agent tasked with importing
and configuring the IDD (Issue-Driven Development) workflow template into
a new repository.

## What you are setting up

IDD is a multi-agent GitHub automation workflow. Agents work through a
pipeline of phases (Discover → Claim → Work → PR Submit → CI Wait →
Review Triage → Review Fix → Merge → Loop) driven by GitHub Issues.
The instruction files in `.github/instructions/` encode every rule for
every phase.

## Your task

1. Read this entire document first.
2. Ask the operator for any placeholder values that are missing.
3. Copy the template files into the target repository.
4. Replace every placeholder (see table below) with the correct value.
5. Add IDD references to the repository's agent entry files.
6. Verify the result with the checklist at the bottom.

---

## Step 1 — Collect placeholder values

Before touching any file, ask the operator to supply values for every
placeholder that is not already known. Present the full table below and
request missing values.

| Placeholder                    | What it means                                                                                                                               | Example                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `{{REPO_NAME}}`                | The repository's short name. Used in worktree path examples.                                                                                | `my-app`                                          |
| `{{PROJECT_MARKER_PREFIX}}`    | A short, URL-safe prefix unique to this project. Used in HTML comment markers embedded in issue bodies to track roadmap and blocked-by state. The same prefix must be used consistently throughout all issues. | `my-app`                            |
| `{{FIX_VALIDATE_COMMANDS}}`    | Commands that auto-fix linting and verify the result. Run before every commit.                                                              | `npm run lint:fix && npm run lint`                |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Commands that verify correctness before a push (no auto-fix — code must already be clean). Typically includes build and test.             | `npm run lint && npm run build && npm run test`   |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Commands that auto-fix and fully verify after review fixes. Usually a superset of the other two.                                          | `npm run lint:fix && npm run lint && npm run build && npm run test` |
| `{{INSTALL_DEPS_COMMAND}}`     | Command to install dependencies in a fresh worktree.                                                                                        | `npm install`                                     |

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

---

## Step 2 — Copy template files

Copy the following files from this template into the target repository,
preserving their relative paths:

```text
.github/instructions/idd-overview.instructions.md
.github/instructions/idd-discover.instructions.md
.github/instructions/idd-claim.instructions.md
.github/instructions/idd-work.instructions.md
.github/instructions/idd-pr-submit.instructions.md
.github/instructions/idd-ci.instructions.md
.github/instructions/idd-review-triage.instructions.md
.github/instructions/idd-review-fix.instructions.md
.github/instructions/idd-merge.instructions.md
.github/instructions/idd-resume.instructions.md
docs/idd-workflow.md
```

Create the target directories if they do not exist.

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

### CLAUDE.md

Add the following section (adapt wording to fit the existing document
style):

```markdown
## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

`.github/instructions/idd-overview.instructions.md` loads automatically
because it has `applyTo: "**"`. Open the routed phase file manually when
the current step changes.
```

### .github/copilot-instructions.md (if present)

Add a parallel section so GitHub Copilot surfaces also receive the IDD
context. The content can mirror the CLAUDE.md addition above.

### AGENTS.md (if present, for Codex CLI)

Add a note that agents must manually open
`.github/instructions/idd-overview.instructions.md` and the relevant
phase file before starting IDD work.

### GEMINI.md (if present)

Same guidance as AGENTS.md.

---

## Step 5 — Verification checklist

After completing the steps above, confirm each item:

- [ ] All ten `idd-*.instructions.md` files are present in
      `.github/instructions/`.
- [ ] `docs/idd-workflow.md` is present.
- [ ] No `{{...}}` placeholders remain in any copied file.
- [ ] `idd-overview.instructions.md` has `applyTo: "**"` in its
      frontmatter.
- [ ] Agent entry file(s) reference `docs/idd-workflow.md`.
- [ ] The `Project commands` table in `idd-overview.instructions.md`
      contains the correct commands for this project.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names in
      `idd-discover.instructions.md` and `idd-overview.instructions.md`
      match the prefix chosen for this project.

Once all items are checked, the IDD workflow is ready for use. Point the
operator to `docs/idd-workflow.md` as the starting guide.
