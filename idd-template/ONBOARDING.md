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
and apply the matching artifact from `profiles/`. The artifact records
the complete edit surface, adopter-owned values, and verification
evidence for the selected non-default profile.

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
The distributed default is `fully_autonomous_merge`, which gives one
trusted agent session merge authority to continue through merge execution
in F3. Ask whether the operator wants an explicit opt-out to
`human_merge` before unattended runs begin, or prefers
`separate_merge_agent` as a non-default split-authority handoff profile.
For public/OSS repositories, or whenever human validation is required
before merge, recommend an explicit opt-out to `human_merge` before
granting unattended credentials. Normal worker sessions stop before
merge under `human_merge` and `separate_merge_agent`; only the trusted
merge-capable session configured for `separate_merge_agent` continues
past the default F3 gate after the required customization. Record the
selected policy in repository
documentation that future IDD sessions read. Missing policy defaults to
`fully_autonomous_merge`; unknown recorded policy values must stop with
a maintainer hold until corrected.

If you keep the distributed advisory/CI defaults, record that choice
alongside the merge policy and point operators to
[IDD policy constants](docs/policy-constants.md) so the named values are
easy to find later.

## Your task

1. Read this entire document first.
2. **Auto-derive candidate values** from the target repository's evidence
   (build tooling, package managers, git remote). Propose derived values
   to the operator for confirmation or correction (Step 1A below).
3. **Confirm policy decisions** with the operator (merge policy, review
   policy, issue-authoring companion, credentials) — these cannot be
   safely inferred and require explicit confirmation (Step 1B below).
4. Fetch or copy the template files into the target repository.
5. Replace every placeholder with the correct values (confirmed by the
   operator in Steps 1A-1B).
6. Review `docs/permissions.md` with the operator before granting agent
   credentials, matching the merge policy confirmed in Step 1B.
7. If the selected PR review policy profile is non-default, apply the
   matching profile artifact from `profiles/`.
8. Record all policy decisions in repository documentation that future IDD
   sessions read: merge policy, review policy profile, thread-resolution
   policy, and timing defaults.
9. Add IDD references to the repository's agent entry files.
10. Verify the result with the checklist at the bottom.

---

## Step 1A — Auto-derive candidate values

Before asking the operator to enter values, inspect the target repository's
evidence to propose reasonable defaults for five of the six placeholder
values. The operator can confirm these proposed values or correct them.

**Derived evidence to collect:**

- **Repository name** (`{{REPO_NAME}}`): Read from `git config` or GitHub
  API. The remote name is the most reliable source.
- **Marker prefix** (`{{PROJECT_MARKER_PREFIX}}`): Candidate is the
  repository name lowercased, hyphenated, and must match
  `^[a-z][a-z0-9-]{1,31}$` (2-32 chars). Ask the operator to confirm this
  candidate or provide an alternative that matches the same pattern.
- **Install command** (`{{INSTALL_DEPS_COMMAND}}`): Look for presence of
  `package.json` (candidate: `npm install`), `pyproject.toml` or
  `requirements.txt` (candidate: `pip install -r requirements.txt`),
  `go.mod` (candidate: `go mod download`), `Gemfile`
  (candidate: `bundle install`), or other evidence. If no standard tooling
  is detected, propose `true` (no-op). If multiple tools are present, ask
  the operator to clarify.
- **Fix-validate commands** (`{{FIX_VALIDATE_COMMANDS}}`): Propose
  auto-fix + validate sequence inferred from tooling present in the
  repository (e.g., `dprint fmt` + linter, `black` + `isort`, `cargo fmt`,
  `go fmt`, `prettier --write`). Common patterns:
  - Node.js: `npm run lint:fix && npm run lint`
  - Python: `black . && isort .` or equivalent
  - Go: `go fmt ./...`
  - Rust: `cargo fmt`
  - If no standard auto-fix tooling, propose `true` as fallback.
- **Pre-push-validate commands** (`{{PRE_PUSH_VALIDATE_COMMANDS}}`):
  Propose a lint + build + test sequence (no mutations). Common patterns:
  - Node.js: `npm run lint && npm run build && npm run test`
  - Python: `pylint . && python -m pytest`
  - Go: `go vet ./... && go test ./...`
  - Rust: `cargo check && cargo test`
  - If no CI commands are available, propose `true`.
- **Post-fix-validate commands** (`{{POST_FIX_VALIDATE_COMMANDS}}`):
  Usually a superset combining fix-validate and pre-push-validate.

**Present proposed values to the operator.** Format:

> Based on the target repository's structure, I've derived these candidate
> values. Please confirm or correct them:
>
> - Repository name: `{proposed-repo-name}`
> - Marker prefix: `{proposed-prefix}`
> - Install command: `{proposed-install}`
> - Fix-validate: `{proposed-fix-validate}`
> - Pre-push-validate: `{proposed-pre-push}`
> - Post-fix-validate: `{proposed-post-fix}`
>
> If any of these needs to change, provide the corrected value.

Record the operator's confirmations or corrections for Step 3 (placeholder
replacement).

---

## Step 1B — Confirm policy decisions

The following choices **cannot be safely inferred** from repository
evidence and require explicit operator confirmation:

1. **Merge policy**: Must the repository require human approval before
   agent merge execution (F3 phase)?
   - `fully_autonomous_merge` (distributed default): one trusted agent
     session may execute the merge. Recommended for private repositories or
     when agent credentials are well-controlled. ✓ **proposed default**
   - `human_merge`: agent stops and hands off to a human maintainer before
     merge. Recommended for public repositories or strict code-review
     policies.
   - `separate_merge_agent`: agent stops and hands off to a separately
     authorized merge-capable actor. Recommended for split responsibilities
     (e.g., worker agent writes code, merge agent reviews and merges).

   **Confirm with operator**: "Accept the distributed default
   (`fully_autonomous_merge`), or opt out to `human_merge` or
   `separate_merge_agent`?"

2. **PR review policy profile**: Should the agent request advisory review
   from GitHub Copilot during the review phase?
   - `copilot-advisory` (distributed default): agent requests Copilot
     review and waits for advisory feedback. ✓ **proposed default**
   - `no-advisory`: agent skips advisory review. Faster but loses
     machine-assisted feedback.
   - Other profiles: see `docs/idd-review-policy-profiles.md`.

   **Confirm with operator**: "Accept the distributed default (Copilot
   advisory review), or choose a non-default profile?"

3. **Review-thread resolution policy**: May an agent resolve review threads
   after it has acted on feedback?
   - `fast-agent-resolve` (distributed default): agent may resolve review
     threads immediately after responding to feedback. ✓ **proposed
     default**
   - `hybrid-reviewer-ack`: threads may be resolved only if the reviewer
     acknowledges the fix (e.g., approves the follow-up commit).
   - `strict-reviewer-resolve`: only reviewers may resolve threads.

   **Confirm with operator**: "Accept the distributed default
   (agent-resolved threads), or choose a stricter policy?"

4. **Issue-authoring companion**: Does the operator want the optional
   issue-authoring skill for pre-execution issue drafting and roadmap
   decomposition?
   - Yes: skill will be installed at `skills/issue-authoring/` in the
     target repository.
   - No: skill is not needed; continue without it.

   **Confirm with operator**: "Install the optional issue-authoring
   companion skill? (yes/no)"

**Record all policy decisions** in repository documentation (see Step 8
below). Future IDD sessions will read these decisions to understand the
repository's configured behavior.

---

## Step 1C — Collect placeholder values

You now have all the information needed to finalize placeholder values:

- **{{REPO_NAME}}**, **{{PROJECT_MARKER_PREFIX}}**,
  **{{FIX_VALIDATE_COMMANDS}}**, **{{PRE_PUSH_VALIDATE_COMMANDS}}**,
  **{{POST_FIX_VALIDATE_COMMANDS}}**, **{{INSTALL_DEPS_COMMAND}}**: Use
  the operator-confirmed values from Step 1A.

If the operator provided no corrections in Step 1A, use the proposed values
directly.

| Placeholder                      | What it means                                                                                                                                       | Example / Derivation                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `{{REPO_NAME}}`                  | The repository's short name. Used in worktree path examples. **Derived** in Step 1A from git remote.                                                | Auto-derived: `my-app`                                           |
| `{{PROJECT_MARKER_PREFIX}}`      | Marker prefix for hidden issue-body HTML comments. Must match `^[a-z][a-z0-9-]{1,31}$` (2-32 chars). **Derived** in Step 1A; confirm with operator. | Auto-derived from repo name: `my-app`                            |
| `{{FIX_VALIDATE_COMMANDS}}`      | Commands that may auto-fix linting/formatting and verify. **Derived** in Step 1A from build-tool evidence.                                          | Auto-derived: `npm run lint:fix && npm run lint`                 |
| `{{PRE_PUSH_VALIDATE_COMMANDS}}` | Verify commands (no mutations). **Derived** in Step 1A from build-tool evidence.                                                                    | Auto-derived: `npm run lint && npm run test`                     |
| `{{POST_FIX_VALIDATE_COMMANDS}}` | Auto-fix + full verify (superset). **Derived** in Step 1A from build-tool evidence.                                                                 | Auto-derived: `npm run lint:fix && npm test`                     |
| `{{INSTALL_DEPS_COMMAND}}`       | Dependency install command. **Derived** in Step 1A from package-manager evidence. Use `true` for projects with no standard dependency install.      | Auto-derived: `npm install` or `pip install -r requirements.txt` |

> **No-op substitution**: any command that is not applicable to your
> project can be set to `true`. For example, a repository without a
> dependency install step uses `{{INSTALL_DEPS_COMMAND}}` = `true`.
> The same applies to validation commands in projects that do not use
> the listed tools — set the relevant placeholder to `true` to skip
> that step without breaking the workflow.
>
> `{{INSTALL_DEPS_COMMAND}}` must be safe to run repeatedly across
> retries, takeovers, and recreated worktrees.

### Notes on `{{PROJECT_MARKER_PREFIX}}`

This prefix appears in two places in issue bodies as hidden HTML
comments:

- Roadmap identity marker (placed in the roadmap issue body):
  `<!-- {{PROJECT_MARKER_PREFIX}}-roadmap-id: {unique-id} -->`
- Blocked-by marker (placed in dependent issue bodies):
  `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: {roadmap-id} -->`

The prefix makes these markers unique across projects when issues are
shared or migrated. Choose a short, lowercase, hyphenated name matching
the repo (e.g., the repo name itself), and validate it with:

```sh
printf '%s\n' "<prefix>" | grep -Eq '^[a-z][a-z0-9-]{1,31}$'
```

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

You need the following core execution and profile artifact files in the
target repository. Use whichever method applies to your situation.

The issue-authoring skill is available as an optional companion artifact
from `skills/issue-authoring/` in the idd-skill source repository. That path is
the canonical source bundle; when you install it in a target repository,
place the copied bundle in the agent-specific skill directory your
runtime reads, such as `.github/skills/`, `.claude/skills/`, or
`.agents/skills/`. Install it only when the operator explicitly wants
pre-execution issue drafting or roadmap decomposition support.

Before importing, confirm whether the operator wants to keep the default
Copilot advisory review policy described above. If not, choose the
closest profile in `docs/idd-review-policy-profiles.md`, then open the
matching artifact in `profiles/<profile>/README.md` after the files are
copied in. Use the artifact and the PR review profile edit-surface
checklist before marking onboarding complete; the selected profile is
not complete until the repository records the decision, updates every
matching phase behavior, and captures verification evidence.

Confirm the review-thread resolution policy as well. Keep
`fast-agent-resolve` for the distributed default, or choose
`hybrid-reviewer-ack` / `strict-reviewer-resolve` when human review
threads must stay open until reviewer or maintainer acknowledgement.
Record the choice in repository documentation. For non-default profiles,
customize the review snapshot, review triage, review fix, pre-merge, and
merge phase files listed in `docs/idd-review-policy-profiles.md`.

Also confirm the operator's merge policy:
`human_merge`, `separate_merge_agent`, or `fully_autonomous_merge`.
Preselect `fully_autonomous_merge` as the distributed default and ask
whether the operator wants an explicit opt-out to `human_merge` before
unattended runs begin, or prefers `separate_merge_agent` as a
non-default split-authority profile. Record the selected policy in
repository documentation, such as a local policy section in the imported
docs or agent entry files. For `human_merge` and
`separate_merge_agent`, do not grant merge-capable credentials to
normal worker sessions. Keep the default F3 stop gate for worker
sessions, and record the human maintainer or separate merge-capable
actor plus the resume condition. Missing policy defaults to
`fully_autonomous_merge`; unknown recorded policy values must stop with
a maintainer hold until corrected. Customize the local F3 gate only when
the repository needs that separate merge-capable actor to continue
through merge execution under repository-specific guidance.

Confirm claim timing policy defaults from `docs/policy-constants.md` as
well: `claim-stale-age` (default `24 h`) and
`claim-heartbeat-interval` (default `12 h`). Record whether the
repository keeps these defaults before unattended runs.

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
.github/instructions/idd-merge-handoff.instructions.md
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
profiles/README.md
profiles/human-required/README.md
profiles/no-advisory/README.md
profiles/external-bot/README.md
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
  ".github/instructions/idd-merge-handoff.instructions.md" \
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
  "docs/reference.md" \
  "profiles/README.md" \
  "profiles/human-required/README.md" \
  "profiles/no-advisory/README.md" \
  "profiles/external-bot/README.md"
do
  mkdir -p "$(dirname "${DEST}/${FILE}")"
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
  ".github/instructions/idd-merge-handoff.instructions.md" \
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
  "docs/reference.md" \
  "profiles/README.md" \
  "profiles/human-required/README.md" \
  "profiles/no-advisory/README.md" \
  "profiles/external-bot/README.md"
do
  mkdir -p "$(dirname "${DEST}/${FILE}")"
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
`skills/issue-authoring/` from the idd-skill source repository to
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

## Step 3 — Record policy decisions

Create a local policy section in the target repository's documentation
(such as a new section in `.github/copilot-instructions.md`, `AGENTS.md`,
or a dedicated `docs/idd-policy.md`) and record the following decisions
made in Step 1B:

```markdown
## IDD Policy Configuration

This repository uses the following IDD policies:

### Merge Policy

**Policy**: `{fully_autonomous_merge | human_merge | separate_merge_agent}`

{
"fully_autonomous_merge": "Merge-capable trusted agent sessions may execute the merge phase (F3). No human maintainer approval required before merge execution.",
"human_merge": "All work stops before the merge phase (F3). A human maintainer must review the PR and execute the merge manually.",
"separate_merge_agent": "A separately authorized merge-capable actor reviews and executes the merge. Worker agents stop before F3."
}

### PR Review Policy

**Profile**: `{copilot-advisory | no-advisory | other}` (default: copilot-advisory)

{description of impact on review phases}

### Review-Thread Resolution Policy

**Policy**: `{fast-agent-resolve | hybrid-reviewer-ack | strict-reviewer-resolve}` (default: fast-agent-resolve)

{description of when threads may be resolved}

### Claim Timing

- **claim-stale-age**: 24 h (default, changeable in docs/policy-constants.md)
- **claim-heartbeat-interval**: 12 h (default, changeable in docs/policy-constants.md)

### Issue-Authoring Companion

**Status**: {installed | not installed}
```

Make this policy section discoverable and point to it from any entry files
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`)
that mention IDD workflow.

### Optional: add a machine-readable policy file

For repositories that want stable automation input beyond Markdown,
create `.github/idd/config.json` as a machine-readable mirror of the
decisions above. Keep the human-readable policy section and this JSON in
sync.

Suggested shape:

```json
{
  "iddVersion": "0.1.0",
  "markerPrefix": "{{PROJECT_MARKER_PREFIX}}",
  "mergePolicy": "<operator-merge-policy>",
  "reviewPolicy": "<operator-review-policy>",
  "threadResolutionPolicy": "<operator-thread-resolution-policy>",
  "claimTiming": {
    "staleAge": "PT24H",
    "heartbeatInterval": "PT12H"
  },
  "trustedMarkerActors": ["<trusted-login-1>", "<trusted-login-2>"],
  "commands": {
    "install": "<json-escaped install-deps command>",
    "fixValidate": "<json-escaped fix-validate command>",
    "prePushValidate": "<json-escaped pre-push-validate command>",
    "postFixValidate": "<json-escaped post-fix-validate command>"
  }
}
```

Notes:

- This file is optional by default and does not replace instruction files.
- IDD behavior still comes from `.github/instructions/*.instructions.md`
  unless the adopter explicitly builds tooling that consumes this config.
- If the repository uses this file, treat drift between Markdown policy
  notes and JSON as a configuration bug and update both in the same change.
- If this file is created before Step 4, include it in the same
  placeholder-replacement pass as the copied template files.
- Keep command strings JSON-escaped. Do not paste raw shell directly if
  it contains quotes or backslashes.
- Extend the schema only when the repository records extra policy
  decisions (for example: critique-loop profile, merge handoff actor,
  external advisory bot, `issue-scope`, or maintainer approval actors).

---

## Step 4 — Replace placeholders

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

## Step 5 — Update agent entry files

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

## Step 6 — Verification checklist

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
- [ ] `profiles/README.md` and the non-default profile artifacts under
      `profiles/` are present.
- [ ] The operator's selected PR review policy profile is recorded, and
      the matching edit-surface checklist in
      `docs/idd-review-policy-profiles.md` is complete.
- [ ] If the selected PR review policy profile is non-default, the
      matching `profiles/<profile>/README.md` artifact was applied and
      its verification evidence is recorded.
- [ ] The operator's selected review-thread resolution policy is
      recorded, and any non-default profile has matching phase-file
      customizations.
- [ ] The operator's selected critique-loop policy is recorded, and any
      non-default profile has matching phase-file customizations.
- [ ] The operator's selected merge policy is recorded in repository
      documentation, the F3 handoff behavior matches that policy, and
      worker credentials match that boundary.
- [ ] Ownership timing policy values `claim-stale-age` and
      `claim-heartbeat-interval` are explicitly recorded for the target
      repository.
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
- [ ] If `.github/idd/config.json` is used, it matches the recorded
      `iddVersion`, marker prefix, merge/review/thread policies,
      claim timing values, `trustedMarkerActors`, and command values.

Once all items are checked, the IDD workflow is ready for use. Point the
operator to `docs/idd-workflow.md` as the starting guide.
