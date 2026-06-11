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

## Upgrading from an earlier IDD version

> **Breaking change (2026-05-28):**
> `.github/instructions/idd-overview.instructions.md` was a thin
> redirect with no unique runtime content other than the **Project
> commands** table. That table now lives in
> `.github/instructions/idd-overview-core.instructions.md`, the
> redirect file has been removed from the template, and every script,
> test, and doc has been updated to read the table from core.
>
> If your target repository was set up from an earlier import, do the
> following once after pulling the new template files:
>
> 1. Move any local customizations (typically the `fix-validate`,
>    `pre-push-validate`, `post-fix-validate`, `install-deps`,
>    `issue-scope`, and `orphan-first-policy` rows you adjusted during
>    onboarding) from your old
>    `.github/instructions/idd-overview.instructions.md` into the
>    Project commands table in
>    `.github/instructions/idd-overview-core.instructions.md`. Per-row
>    overrides via `.github/idd/config.json` `commands.*` continue to
>    work unchanged.
> 2. Delete
>    `.github/instructions/idd-overview.instructions.md` from your
>    target repository. No machine consumer reads that path anymore.
>
> First-time adopters can ignore this section — the flow below already
> references the new file.

### Re-importing: import named gaps, not a blind resync

When you pull a newer upstream template into a repository that already adopted
IDD, treat the upgrade as a **named-gap import**, not a blind resync:

1. **Resolve placeholders first** so the new template carries your repository's
   real values, not upstream defaults.
2. **Reconcile only the enumerated gaps** — the specific changes between your
   current version and the new template — **against your recorded local policy**
   (the policy section from Step 3). Do not overwrite intentional local
   divergence with upstream defaults; a blind file-for-file resync silently
   reverts your customizations.
3. Re-apply the Step 2 file import for the changed files, then re-run the
   Step 6 verification checklist and `idd-doctor` after reconciling.

When you then audit whether re-imported roadmap work is actually done, judge
**completion by auditing the implementation against the acceptance criteria**,
not by a child issue's closed state — a skeleton or scaffold PR can merge and
close a child while leaving its acceptance criteria unimplemented. See the
roadmap-audit rule in
`.github/instructions/idd-roadmap-audit.instructions.md` (compare the roadmap
success criteria against the merged PRs; do not infer completion from
checkbox state alone).

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
past the default F2.5/F3 gates after the required customization. Record
the selected policy in repository
documentation that future IDD sessions read. Missing policy defaults to
`fully_autonomous_merge`; unknown recorded policy values must stop with
a maintainer hold until corrected.

If you keep the distributed advisory/CI defaults, record that choice
alongside the merge policy and point operators to
[IDD policy constants](docs/policy-constants.md) so the named values
such as `ciWait.runningTimeout`, `ciWait.generationTimeout`, and
`ciWait.rerunPolicy` are easy to find later.

Also consider the AI model used for the IDD execution session. Large and
premium reasoning models are more likely to trigger frequent context
compaction when the full instruction file set is loaded, which can
interrupt unattended IDD loops. For day-to-day execution, standard models
(for example, models in the Sonnet class) handle the instruction overhead
more efficiently and are the recommended choice. Reserve large or premium
reasoning models for tasks that genuinely benefit from their extended
reasoning depth, not for routine IDD loop execution.

## Your task

1. Read this document before changing files.
2. Auto-derive candidate placeholder values from repository evidence.
3. Confirm policy decisions with the operator.
4. Fetch or copy the template files.
5. Replace placeholders with the confirmed values.
6. Record the selected policies where future IDD sessions will read them.
7. Update the repository's agent entry files.
8. Verify the imported result with the checklist at the bottom.

---

## Dry-run — Readiness assessment

Before making any file changes, you may run a read-only readiness pass
for the target repository.

Use this prompt:

```md
Assess this repository for IDD readiness. Do not modify any files.
Produce a readiness report with the following fields.
```

Return the report in this format:

```md
## IDD readiness report

- Detected package manager:
- Detected test commands:
- Suggested marker prefix:
- Suggested merge policy:
- Branch protection visible:
- Required checks visible:
- CODEOWNERS present:
- Missing prerequisites:
- Files that would be created:
- Files that would be modified:
```

This dry-run is for evaluators who want a quick import readiness summary
before starting Step 1A.

---

## Step 1A — Auto-derive candidate values

Inspect the target repository and propose candidate values for all seven placeholders:
`{{REPO_NAME}}`, `{{PROJECT_MARKER_PREFIX}}`,
`{{TRUSTED_MARKER_ACTOR}}`, `{{FIX_VALIDATE_COMMANDS}}`,
`{{PRE_PUSH_VALIDATE_COMMANDS}}`, `{{POST_FIX_VALIDATE_COMMANDS}}`,
and `{{INSTALL_DEPS_COMMAND}}`.

Use
[Onboarding Reference — Placeholder Values](docs/onboarding/placeholders.md)
for the detailed derivation rules, fallback order, and marker-prefix
notes.

Present the proposed values to the operator for confirmation or
correction, then carry the confirmed values into Steps 1C and 4.

---

## Step 1B — Confirm policy decisions

These choices **cannot be safely inferred** from repository evidence and
require explicit operator confirmation:

1. merge policy (`fully_autonomous_merge`, `human_merge`, or
   `separate_merge_agent`)
2. PR review policy profile (`copilot-advisory` by default, or a
   non-default profile)
3. review-thread resolution policy (`fast-agent-resolve` by default, or
   a stricter profile)
4. critique-loop profile (distributed defaults, or a documented
   repository override)
5. credential scope for worker and merge-capable sessions
6. claim-timing defaults (`claim-stale-age` and
   `claim-heartbeat-interval`)
7. CI wait policy defaults (`ciWait.runningTimeout`,
   `ciWait.generationTimeout`, `ciWait.rerunPolicy`)
8. issue-author approval gate (`enabled-by-default` by default, or
   explicit config opt-out via `skipIssueAuthorApprovalGate: true`)
9. maintainer approval actor policy (`owners-and-maintainers-only` by
   default, or `all-write-permission-actors`)
10. issue-authoring companion status (`installed` or `not installed`)
11. helper runtime profile (`instructions-only` by default, or an
    evidence-based helper profile recommendation that still requires
    explicit operator confirmation`)

Use
[Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md)
for the detailed option descriptions, default guidance, and the Step 3
policy-recording template.

---

## Step 1C — Collect placeholder values

Use the operator-confirmed values from Step 1A for these seven
placeholders:

- `{{REPO_NAME}}`
- `{{PROJECT_MARKER_PREFIX}}`
- `{{TRUSTED_MARKER_ACTOR}}`
- `{{FIX_VALIDATE_COMMANDS}}`
- `{{PRE_PUSH_VALIDATE_COMMANDS}}`
- `{{POST_FIX_VALIDATE_COMMANDS}}`
- `{{INSTALL_DEPS_COMMAND}}`

If the operator provided no corrections in Step 1A, use the proposed
values directly.

For the placeholder meanings, no-op substitution rules, marker-prefix
notes, and `blocked-by` guidance, see
[Onboarding Reference — Placeholder Values](docs/onboarding/placeholders.md).

---

## Step 2 — Fetch or copy template files

You need the following core execution and profile artifact files in the
target repository. Use whichever method applies to your situation.
For `idd-skill` maintainers working on this generated file list and the
remote-fetch examples, see
[Template distribution maintainer reference](docs/onboarding/template-distribution.md).

The issue-authoring skill is available as an optional companion artifact
from `skills/issue-authoring/` in the idd-skill source repository. That path is
the canonical source bundle; when you install it in a target repository,
place the copied bundle in the agent-specific skill directory your
runtime reads, such as `.github/skills/`, `.claude/skills/`, or
`.agents/skills/`. Install it only when the operator explicitly wants
pre-execution issue drafting or roadmap decomposition support.

Before importing files, re-check the policy choices confirmed in Step 1B:
merge policy, PR review profile, review-thread resolution policy,
critique-loop profile, credential scope, claim-timing defaults, CI wait
policy defaults, issue-author approval gate, maintainer approval actor
policy, issue-authoring companion status, and helper runtime profile.

Use
[Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md)
for the detailed defaults, non-default consequences, and the policy
recording template you will apply in Step 3.

### File list

<!-- audit:generated id=idd-template-core-files -->

```text
.github/idd/config.json
.githooks/_idd-worktree-guard.sh
.githooks/pre-commit
.githooks/pre-push
.github/instructions/idd-overview-core.instructions.md
.github/instructions/idd-overview-appendix.instructions.md
.github/instructions/idd-discover.instructions.md
.github/instructions/idd-roadmap-audit.instructions.md
.github/instructions/idd-suitability.instructions.md
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
docs/idd-resume-detail.md
docs/idd-advisory-wait-shell-fallback.md
docs/idd-design-rationale.md
docs/permissions.md
docs/getting-started.md
docs/concepts.md
docs/customization.md
docs/policy-constants.md
docs/reference.md
docs/onboarding/agent-entry-and-verification.md
docs/onboarding/placeholders.md
docs/onboarding/policy-decisions.md
docs/onboarding/template-distribution.md
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

mkdir -p "${DEST}/.github/idd" "${DEST}/.github/instructions" "${DEST}/docs" \
  "${DEST}/docs/onboarding"

for FILE in \
  ".github/idd/config.json" \
  ".githooks/_idd-worktree-guard.sh" \
  ".githooks/pre-commit" \
  ".githooks/pre-push" \
  ".github/instructions/idd-overview-core.instructions.md" \
  ".github/instructions/idd-overview-appendix.instructions.md" \
  ".github/instructions/idd-discover.instructions.md" \
  ".github/instructions/idd-roadmap-audit.instructions.md" \
  ".github/instructions/idd-suitability.instructions.md" \
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
  "docs/idd-resume-detail.md" \
  "docs/idd-advisory-wait-shell-fallback.md" \
  "docs/idd-design-rationale.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/placeholders.md" \
  "docs/onboarding/policy-decisions.md" \
  "docs/onboarding/template-distribution.md" \
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

mkdir -p "${DEST}/.github/idd" "${DEST}/.github/instructions" "${DEST}/docs" \
  "${DEST}/docs/onboarding"

for FILE in \
  ".github/idd/config.json" \
  ".githooks/_idd-worktree-guard.sh" \
  ".githooks/pre-commit" \
  ".githooks/pre-push" \
  ".github/instructions/idd-overview-core.instructions.md" \
  ".github/instructions/idd-overview-appendix.instructions.md" \
  ".github/instructions/idd-discover.instructions.md" \
  ".github/instructions/idd-roadmap-audit.instructions.md" \
  ".github/instructions/idd-suitability.instructions.md" \
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
  "docs/idd-resume-detail.md" \
  "docs/idd-advisory-wait-shell-fallback.md" \
  "docs/idd-design-rationale.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/placeholders.md" \
  "docs/onboarding/policy-decisions.md" \
  "docs/onboarding/template-distribution.md" \
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

### Optional — enable the local worktree guard

The template ships an opt-in git hook set under `.githooks/` that
refuses commits and pushes made from the **primary** worktree while
HEAD is on an implementation branch (`issue/*` or `roadmap-audit/*`),
enforcing the B1 disposable-worktree rule locally. The hooks are pure
POSIX sh — no Node, `jq`, or other runtime dependency.

To enable it in the target repository:

1. Set `worktreeGuard.enabled` to `true` in `.github/idd/config.json`
   (the guard is off by default).
2. Point git at the shipped hooks. `core.hooksPath` is local and not
   committed, so each clone runs this once:

   ```sh
   git config core.hooksPath .githooks
   chmod +x .githooks/pre-commit .githooks/pre-push
   ```

When `worktreeGuard.enabled` is absent or `false`, the hooks are a
no-op. To bypass the guard for a single intentional commit or push,
pass `--no-verify`. CI cannot detect this class of violation — a
primary-worktree mistake leaves no trace in the pushed history — so
this local hook, together with `idd-doctor --strict`, is the practical
enforcement surface.

### Optional — run idd-doctor as a CI health gate

For repositories that vendor the IDD helper scripts, running `idd-doctor`
in CI catches repository-health regressions (config/schema drift,
unresolved placeholders, marker-prefix inconsistency, missing required
files) on every change. It is opt-in — add a workflow such as:

```yaml
name: IDD doctor health gate
on:
  pull_request:
permissions:
  contents: read
jobs:
  idd-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }} # detached HEAD keeps the worktree check inert
          persist-credentials: false
      - run: node scripts/idd-doctor.mjs
```

Adjust the command to your helper-runtime profile. This gate checks
repository **health**, not the disposable-worktree rule: CI cannot detect
a primary-worktree B1 violation (it leaves no trace in pushed history and
CI checks out a detached HEAD), so worktree enforcement stays local — the
`core.hooksPath` hook above, the cwd-vs-claim gate, and
`idd-doctor --strict` run on a developer's machine.

**Branch-glob vs CI-trigger.** Put PR-gating checks in the
`pull_request`-triggered workflow (as above). A `push` workflow filtered to a
**top-level branch glob** such as `'*'` silently skips the slash-namespaced
IDD branches (`issue/*`, `roadmap-audit/*`): a single-star glob does not match
across the `/`, so a gating job placed only under `on: push` with `'*'` never
runs on IDD branches. Use `pull_request` triggers (which fire on the PR
regardless of branch name), or a push filter that matches the slash namespace
(`'**'` or `'issue/**'`), for any check that must gate IDD pull requests.

### Optional — mark the vendored helper bundle `linguist-vendored`

This step applies **only to the `vendored-node` profile** (the only
profile that copies helper files into your repository). The vendored
bundle is third-party code, so marking it `linguist-vendored` drops it
from your repository's language statistics and de-prioritizes it in code
search — useful when your own code is mostly docs or another language and
you do not want the copied `.mjs`/schema files to dominate the language
bar. (This is the adopter-side counterpart of the source repository's
`linguist-generated` artifacts; the semantics differ deliberately:
generated = first-party build output, vendored = copied third-party code.)

The helper-runtime manifest emits the exact lines from the same
`managedFiles` import-graph it uses to vend the bundle, so the attribute
list never drifts from what you copied. Append them to your
`.gitattributes`:

```sh
node scripts/helper-runtime-manifest.mjs --profile vendored-node \
  | node -e 'const m=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(m.profiles["vendored-node"].recommendedGitattributes.join("\n")+"\n")' \
  >> .gitattributes
```

Other profiles vend no files and emit no recommendation, so they need
nothing here.

---

## Step 3 — Record policy decisions

Create a local policy section in the target repository's documentation
and record the Step 1B decisions there. Use the detailed template,
machine-readable policy-file notes, and helper-runtime recording rules in
[Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md).

Make the policy section discoverable and point to it from any entry files
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`)
that mention IDD workflow.

---

## Step 4 — Replace placeholders

In the copied files, perform a global replacement for:
`{{REPO_NAME}}`, `{{PROJECT_MARKER_PREFIX}}`,
`{{TRUSTED_MARKER_ACTOR}}`, `{{FIX_VALIDATE_COMMANDS}}`,
`{{PRE_PUSH_VALIDATE_COMMANDS}}`, `{{POST_FIX_VALIDATE_COMMANDS}}`,
and `{{INSTALL_DEPS_COMMAND}}`.

Use
[Onboarding Reference — Placeholder Values](docs/onboarding/placeholders.md)
for the detailed placeholder meanings, no-op substitution rules, and
marker-prefix guidance.

After replacing, verify that no `{{...}}` placeholder strings remain in
any copied file.

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

Use
[Onboarding Reference — Agent Entry and Verification](docs/onboarding/agent-entry-and-verification.md)
for the per-file examples, create-from-scratch stubs, and expanded
verification guidance for this step.

The minimal IDD workflow section should tell agents to:

```markdown
## IDD Workflow

This project uses Issue-Driven Development (IDD) with parallel AI
agents. Start with [docs/idd-workflow.md](docs/idd-workflow.md) for the
cross-agent entry path and phase routing.

Before starting IDD work, open
`.github/instructions/idd-overview-core.instructions.md`. Open the routed
phase file manually when the current step changes.
```

- point to `docs/idd-workflow.md` as the cross-agent entry path
- open `.github/instructions/idd-overview-core.instructions.md` before
  starting IDD work
- manually open the routed phase file when the current step changes

Apply this section to `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`,
adapting the surrounding wording to each tool while preserving the same
workflow references and the same opt-out rule.

If `.github/copilot-instructions.md` already exists, add a parallel IDD
workflow section there as well. Keep the
`excludeAgent: "code-review"` behavior in
`.github/instructions/idd-overview-core.instructions.md`; repository-wide
Copilot guidance may still apply to reviews.

---

## Step 6 — Verification checklist

Use
[Onboarding Reference — Agent Entry and Verification](docs/onboarding/agent-entry-and-verification.md)
for the expanded verification details and evidence expectations.

After completing the steps above, confirm each item:

- [ ] Every core execution file, supporting doc, and profile artifact
      listed in Step 2 is present in the imported repository.
- [ ] The selected PR review profile is recorded, and any non-default
      profile artifact and phase-file edits are complete.
- [ ] The selected review-thread resolution policy and critique-loop
      profile are recorded, and any non-default phase-file
      customizations are complete.
- [ ] The selected CI wait policy values, merge policy, credential
      scope, claim timing values, issue-author approval gate decision,
      maintainer approval actor policy, and helper runtime profile are
      explicitly recorded.
- [ ] If the operator opted into issue authoring, the companion skill
      files are present.
- [ ] No `{{...}}` placeholders remain, the `Project commands` table is
      correct, and any `orphan-first` scope choice has a valid policy
      value.
- [ ] `.github/instructions/idd-overview-core.instructions.md` keeps
      `applyTo: "**"` and `excludeAgent: "code-review"` in its
      frontmatter.
- [ ] `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` exist and reference
      `docs/idd-workflow.md`, unless the operator explicitly opted out
      of creating them.
- [ ] If `.github/copilot-instructions.md` existed before onboarding,
      it now includes the IDD workflow reference as well.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names match the
      selected prefix, and `.github/idd/config.json` stays aligned when
      the repository uses it.

Once all items are checked, the IDD workflow is ready for use. Point the
operator to `docs/idd-workflow.md` as the starting guide.
