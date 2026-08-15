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

**Anatomy of a helper re-import (`vendored-node` profile).** If you vendor the
shared helper bundle — the `vendored-node` profile, which physically copies the
shared `protocol-helpers` core — a new **leaf helper** is rarely a standalone
file drop:

1. **Diff the shared core first.** The new helper usually imports a newer
   `protocol-helpers` shared-core API absent from your older snapshot, so the
   real work is a shared-core bump — budget that prerequisite before scoping the
   leaf-helper slices. The shared core is no longer always a single file: a
   façade split (e.g. `protocol-helpers` re-exporting `marker-helpers`) can
   move an API to a focused module that the entry file only re-exports, so
   vendor every file the shared-core entry point re-exports from, not just the
   entry file itself.
2. **Reconcile a hardened core additively.** If you hardened that core, treat
   the bump as additive named-divergence reconciliation gated on your protected
   tests: preserve the local hardening and append only the new exports rather
   than wholesale-vendoring the core over it.
3. **Watch the silent revert.** A wholesale core vendor can green-build while
   silently reverting your protected local tests, so verify against those tests,
   not just a clean compile.

(npx-resolved profiles do not vend the core this way, so this note applies only
when you copy helper files.)

**Named gap: `.markdownlint.yml` / `.markdownlint-cli2.yaml` /
`.cspell.config.yml`.** A repository onboarded before these files were
added to the template's core file set gets an intentional, non-silent
behavior change on the next re-import: `--verify`'s `manifestCompleteness`
now reports them missing (blocking) until you re-run Step 2 for them, and
`--import` reports a `blockedOverwrites` finding instead of silently
skipping them if you already created same-named files of your own by
then — merge the template's rule overrides / word list into your existing
file by hand in that case, following the Step 2 file-list note on these
files.

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
2. Confirm the `gh` CLI is installed and authenticated.
3. Auto-derive candidate placeholder values from repository evidence.
4. Confirm policy decisions with the operator.
5. Fetch or copy the template files.
6. Replace placeholders with the confirmed values.
7. Record the selected policies where future IDD sessions will read them.
8. Update the repository's agent entry files.
9. Verify the imported result with the checklist at the bottom.

---

## Step 0 — Prerequisite check

Before Step 1A, confirm the `gh` CLI is installed and authenticated.
IDD depends on `gh` throughout its own lifetime -- claim markers, PR
submission, review-thread disposition, merge execution, and every
later IDD phase -- independent of whatever tech stack the target
repository itself uses. This is the operator's own local `gh` session
used interactively during onboarding, distinct from the CI-side
`GH_TOKEN`/`GH_ENTERPRISE_TOKEN` wiring a hosted `idd-doctor` workflow
needs (see [Optional — run idd-doctor as a CI health gate](#optional--run-idd-doctor-as-a-ci-health-gate)).

Run:

```sh
gh --version
git remote get-url origin
gh auth status --hostname <derived-host>
```

Bare `gh auth status` (no `--hostname`) reports on every host `gh`
already knows about, not the repository being onboarded: it exits
successfully only when **every** known host is authenticated, so an
unrelated stale credential for some other project's host can fail this
check even though the target repository's own host is fine (confirmed
against a real `gh` binary) -- and, if the target host itself was
never configured at all, the bare form silently omits it instead of
reporting it missing. Both failure directions require scoping to the
target host specifically, always -- unlike `gh api`'s own `--hostname`
convention, `gh auth status` has no case where omitting it is correct,
not even for `github.com` (confirmed: `gh auth status --hostname
github.com` behaves identically to a clean bare invocation, so there
is no cost to always passing it). Derive `<derived-host>` from `git
remote get-url origin`'s URL (parse the host portion; a
`github.com` URL yields `github.com` itself).

- On success, continue to Step 1A without further comment.
- On failure (not installed, or not authenticated to the target
  repository's own host), report the exact remediation to the operator
  -- the CLI install command, or `gh auth login --hostname
  <derived-host>` -- and ask whether to proceed anyway before
  continuing. This is a one-time setup conversation the operator stays
  in control of, not a silent skip and not an unconditional hard stop.

This check is scoped to `gh` only. IDD does not require Node.js or
pnpm for the default instructions-only profile (see
[Tooling boundary](docs/onboarding/placeholders.md#tooling-boundary));
a Node.js check tied to the helper-runtime-profile choice belongs at
Step 1B's helper-runtime-profile item instead, not here.

**Execution-environment prerequisites.** Separately from the `gh`
check above, the distributed workflow's `sh`/`bash` fenced blocks
assume a POSIX shell and common Unix utilities (`grep`, `sed`, `mkdir`,
`dirname`, `tr`, `head`, `sort`, `curl`). On Windows, get one from Git
for Windows (Git Bash, which bundles those utilities) or WSL — native
`cmd.exe`/PowerShell cannot run these blocks unmodified. The
`instructions-only` profile's advisory-wait shell fallback additionally
needs a standalone `jq` binary on `PATH` (see
[Advisory-Wait Shell Fallback](docs/idd-advisory-wait-shell-fallback.md));
`gh api --jq` is built into `gh` and covers other call sites, but not
this fallback's own `jq -r`/`jq -s`-piped ones, and neither `gh` nor Git
for Windows installs a standalone `jq`.

Native-Windows adopters should also set
`git config --global core.longpaths true` (a one-time host-level
setting, not a repository change): B1's sibling-worktree layout
(`<repo>.<branch-with-slashes-dashed>` beside the primary worktree)
combined with this repository's deep `.github/instructions/` paths can
approach Windows' 260-character path limit.

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

`Missing prerequisites:` reports the same host-scoped `gh --version`/
`gh auth status --hostname <derived-host>` check as Step 0 above, plus
any other missing tooling this dry-run pass observes -- both surfaces
agree on the `gh` check itself.

This dry-run is for evaluators who want a quick import readiness summary
before starting Step 1A.

---

> **Relay explanations, not just labels.** For each item you present
> across Steps 1A, 1B, and 1C, pull its matching explanation from the
> companion reference doc and relay it to the operator in plain
> language before asking for confirmation or a choice — do not only
> quote the terse item text. Draw from
> [Onboarding Reference — Placeholder Values](docs/onboarding/placeholders.md)
> for Steps 1A and 1C, and
> [Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md)
> for Step 1B. Also define, in plain language on first use, any term
> already covered in [Core IDD Concepts](docs/concepts.md).

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
10. issue-authoring companion status (`installed` or `not installed`); when
    installed, the selected native destination (`.agents/skills/`,
    `.claude/skills/`, or `.opencode/skills/`)
11. helper runtime profile (`instructions-only` by default, or an
    evidence-based helper profile recommendation that still requires
    explicit operator confirmation)
12. IDD label names (`labels.roadmapLabelName`,
    `labels.blockedByHumanLabelName`, and
    `labels.needsDecisionLabelName` — distributed defaults `roadmap`,
    `status:blocked-by-human`, and `status:needs-decision`, or an
    existing local label taxonomy). A semantic issue auto-labeler (for
    example, CodeRabbit's issue enrichment) can auto-apply any of these
    three configured label names to an ordinary issue with no error,
    dropping it from execution candidates or parking it behind a hold;
    omitting a label from the labeler's own instruction list does not
    restrict which labels it may apply. See
    [IDD label names](docs/onboarding/policy-decisions.md#idd-label-names)
    for the field evidence and the guard recipe.
13. up-to-date-head ruleset check
    (`required_status_checks.strict_required_status_checks_policy`,
    recommended disabled — enabling it can force a `main`-sync merge on
    every merely-`BEHIND` PR and multiplies advisory-review rounds
    without review value; a before/after sample measured the sync-merge
    share fall from ~27% to ~3.7%, kurone-kito/idd-skill#1817)
14. bootstrap execution mode (`direct-import` default, or
    `issue-mediated`)

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

## Alternate: issue-mediated bootstrap

By default, Steps 2, 4, 5, and 6 below import the template with a direct,
unreviewed commit ("theirs-flow"). An operator may instead opt into
**issue-mediated bootstrap**, which runs that same import through a
reviewable issue -> branch -> PR -> merge cycle using the values already
confirmed above. See
[Onboarding Reference — Issue-Mediated Bootstrap](docs/onboarding/issue-mediated-bootstrap.md)
for when to choose it and the full procedure.

---

## CLI-assisted onboarding

If you have a local clone of `kurone-kito/idd-skill` (Step 2 Option B
below), the `idd-onboard` CLI shipped in that clone
(`scripts/idd-onboard.mjs`) can automate Steps 2, 4, and 6. **The manual
steps remain canonical**; this CLI is a mechanical, optional shortcut for
the same three steps. `--import` and `--verify` both require
`--source <path-to-a-cloned-idd-skill-tree>` and therefore only replace
the Option B local-clone flow, never Option A's remote fetch;
`--substitute` takes no `--source` at all (it only rewrites an already-
imported `--target` tree) and works the same regardless of how that tree
was populated. Each mode prints a JSON verdict and exits `0` (converged),
`1` (a blocking or residue finding — nothing is written), or `2` (a usage
error), so an agent can gate on the exit code without parsing prose.

- **Step 2 (fetch or copy) → `--import`**: copies the core template file
  set from `--source` into `--target`. The file set it copies is the same
  `idd-template-core-files` generated block Step 2's file list below
  renders from, so this command and that list can never drift apart into
  two independently hand-copied file sets. Add `--profile vendored-node`
  to also copy the profile-conditional helper bundle (every other
  `--profile` value copies no extra files); add `--force` to allow
  overwriting an existing target file whose content differs (refused by
  default); add `--dry-run` to print the plan without writing.

  ```sh
  node scripts/idd-onboard.mjs --import --source <idd-skill-clone> \
    --target <target-repo> [--profile <name>] [--force] [--dry-run]
  ```

- **Step 4 (replace placeholders) → `--substitute`**: resolves the seven
  placeholders using Step 1A's auto-derivation rules, or explicit
  overrides (`--repo-name`, `--marker-prefix`, `--trusted-marker-actor`,
  `--fix-validate-commands`, `--pre-push-validate-commands`,
  `--post-fix-validate-commands`, `--install-deps-command`), then rewrites
  the target tree in place. Add `--dry-run` to print the plan without
  writing; apply mode refuses to write anything while any placeholder
  would remain unresolved.

  ```sh
  node scripts/idd-onboard.mjs --substitute --target <target-repo> \
    [--dry-run] [--repo-name <value> ...]
  ```

- **Step 6 (verification checklist) → `--verify`**: a mechanical pass/fail
  check for a target tree after `--import` and `--substitute` have run,
  replacing a manual walkthrough of the checklist below with three check
  groups: manifest completeness (reusing `--import`'s own file-set
  resolution), placeholder residue (reusing `--substitute`'s scanner), and
  an informational stale-import signal. A missing manifest file or a
  leftover onboarding placeholder is blocking; the stale-import signal
  never is.

  ```sh
  node scripts/idd-onboard.mjs --verify --source <idd-skill-clone> \
    --target <target-repo> [--profile <name>]
  ```

Run `node scripts/idd-onboard.mjs --help` for the full flag reference —
this section documents only the flags relevant to Steps 2, 4, and 6, not
every accepted argument.

---

## Step 2 — Fetch or copy template files

> **CLI shortcut**: `node scripts/idd-onboard.mjs --import` automates this
> step from a local idd-skill clone — see
> [CLI-assisted onboarding](#cli-assisted-onboarding) above.

You need the following core execution and profile artifact files in the
target repository. Use whichever method applies to your situation.
This file list is identical across every helper runtime profile; it does
not include the `vendored-node` profile's profile-conditional helper
script bundle (for example `scripts/minimize-superseded-markers.mjs`) —
see
[Profile-conditional helper files](docs/onboarding/template-distribution.md#profile-conditional-helper-files-vendored-node)
for why that bundle is out of scope here and how to get it anyway.
For `idd-skill` maintainers working on this generated file list and the
remote-fetch examples, see
[Template distribution maintainer reference](docs/onboarding/template-distribution.md).

The issue-authoring skill is available as an optional companion artifact
from `skills/issue-authoring/` in the idd-skill source repository. That path is
the canonical source bundle, not the target repository's discovery path.
When you install it in a target repository, choose one agent-specific native
skill directory that the selected runtime reads, such as `.agents/skills/`
for Codex CLI or OpenCode, `.claude/skills/` for Claude Code, or
`.opencode/skills/` for OpenCode. The examples below use the Codex destination
`.agents/skills/issue-authoring/`; change `SKILL_DEST` to the one selected
destination before running any example. Do not install the same skill ID in
multiple roots unless the operator explicitly accepts identical duplicates
(preventive; no observed incident yet).
Install it only when the operator explicitly wants pre-execution issue
drafting or roadmap decomposition support.

Before importing files, re-check the policy choices confirmed in Step 1B:
merge policy, PR review profile, review-thread resolution policy,
critique-loop profile, credential scope, claim-timing defaults, CI wait
policy defaults, issue-author approval gate, maintainer approval actor
policy, issue-authoring companion status, helper runtime profile, IDD
label names, the up-to-date-head ruleset check, and bootstrap execution
mode.

Use
[Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md)
for the detailed defaults, non-default consequences, and the policy
recording template you will apply in Step 3.

### File list

This list includes `docs/index.md`, the entry point and topic map for
the imported `docs/` bundle — see
[Customizing IDD § Docs Bundle Frontmatter Convention (OKF)](docs/customization.md#docs-bundle-frontmatter-convention-okf)
for the frontmatter convention its generated table follows.

<!-- audit:generated id=idd-template-core-files -->

```text
.github/idd/config.json
.github/workflows/post-merge-cleanup.yml
.githooks/_idd-worktree-guard.sh
.githooks/pre-commit
.githooks/pre-push
.cspell.config.yml
.markdownlint.yml
.markdownlint-cli2.yaml
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
.github/instructions/lite/idd-claim-lite.instructions.md
.github/instructions/lite/idd-work-lite.instructions.md
.github/instructions/lite/idd-pr-submit-lite.instructions.md
.github/instructions/lite/idd-review-snapshot-lite.instructions.md
.github/instructions/lite/idd-pre-merge-lite.instructions.md
.github/instructions/lite/idd-merge-handoff-lite.instructions.md
.github/instructions/lite/idd-review-fix-lite.instructions.md
.github/instructions/lite/idd-resume-lite.instructions.md
.github/instructions/lite/idd-resume-stall-lite.instructions.md
.github/instructions/lite/idd-ci-lite.instructions.md
.github/instructions/lite/idd-advisory-wait-lite.instructions.md
docs/index.md
docs/idd-workflow.md
docs/idd-review-policy-profiles.md
docs/idd-helper-scripts.md
docs/idd-autonomy-contract.md
docs/idd-comment-minimization.md
docs/idd-resume-detail.md
docs/idd-advisory-wait-shell-fallback.md
docs/idd-design-rationale.md
docs/idd-concept-ownership.md
docs/permissions.md
docs/getting-started.md
docs/concepts.md
docs/customization.md
docs/policy-constants.md
docs/reference.md
docs/onboarding/agent-entry-and-verification.md
docs/onboarding/issue-mediated-bootstrap.md
docs/onboarding/placeholders.md
docs/onboarding/policy-decisions.md
docs/onboarding/template-distribution.md
profiles/README.md
profiles/human-required/README.md
profiles/no-advisory/README.md
profiles/external-bot/README.md
```

<!-- /audit:generated -->

This file list includes `.markdownlint.yml`, `.markdownlint-cli2.yaml`, and
`.cspell.config.yml`. They exist because a target repository with no
pre-existing documentation-lint configuration can otherwise import a
clean, verified tree and still fail its own ordinary
`markdownlint-cli2`/`cspell` jobs on the imported files: an early adopter
onboarding validation found real findings across a small set of repeated
rule patterns (line length, table-column style, single-title, and
duplicate-heading for `markdownlint`; unrecognized IDD/tooling
vocabulary and upstream `kurone-kito/idd-skill` cross-references for
`cspell`) against the imported files with no lint config present at all.
These files close that gap out of the box; `.cspell.config.yml`'s
`enableGlobDot: true` in particular is required for `cspell lint "**"` to
scan `.github/instructions/**` at all — without it, that command
silently skips those files rather than reporting them clean. If the
target repository already has its own `.markdownlint.yml`,
`.markdownlint-cli2.yaml`, or `.cspell.config.yml` with different
content, `--import` refuses to overwrite it (reported under
`blockedOverwrites`, same as any other differing file) — merge the
relevant rule overrides or word list from the template's copy into the
existing file by hand rather than forcing an overwrite or skipping the
import for that file. This also means a **re-import** into an
already-onboarded repository that predates these files is a named,
intentional gap under
[Re-importing](#re-importing-import-named-gaps-not-a-blind-resync)
below, not a regression: `--verify` now expects them, and `--import`
blocks instead of silently skipping them if a same-named file already
exists with different content.

Optional companion files:

<!-- audit:generated id=issue-authoring-companion-files -->

```text
skills/issue-authoring/SKILL.md
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

mkdir -p "${DEST}/.github/idd" "${DEST}/.github/workflows" \
  "${DEST}/.github/instructions" "${DEST}/docs" "${DEST}/docs/onboarding"

for FILE in \
  ".github/idd/config.json" \
  ".github/workflows/post-merge-cleanup.yml" \
  ".githooks/_idd-worktree-guard.sh" \
  ".githooks/pre-commit" \
  ".githooks/pre-push" \
  ".cspell.config.yml" \
  ".markdownlint.yml" \
  ".markdownlint-cli2.yaml" \
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
  ".github/instructions/lite/idd-claim-lite.instructions.md" \
  ".github/instructions/lite/idd-work-lite.instructions.md" \
  ".github/instructions/lite/idd-pr-submit-lite.instructions.md" \
  ".github/instructions/lite/idd-review-snapshot-lite.instructions.md" \
  ".github/instructions/lite/idd-pre-merge-lite.instructions.md" \
  ".github/instructions/lite/idd-merge-handoff-lite.instructions.md" \
  ".github/instructions/lite/idd-review-fix-lite.instructions.md" \
  ".github/instructions/lite/idd-resume-lite.instructions.md" \
  ".github/instructions/lite/idd-resume-stall-lite.instructions.md" \
  ".github/instructions/lite/idd-ci-lite.instructions.md" \
  ".github/instructions/lite/idd-advisory-wait-lite.instructions.md" \
  "docs/index.md" \
  "docs/idd-workflow.md" \
  "docs/idd-review-policy-profiles.md" \
  "docs/idd-helper-scripts.md" \
  "docs/idd-autonomy-contract.md" \
  "docs/idd-comment-minimization.md" \
  "docs/idd-resume-detail.md" \
  "docs/idd-advisory-wait-shell-fallback.md" \
  "docs/idd-design-rationale.md" \
  "docs/idd-concept-ownership.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/issue-mediated-bootstrap.md" \
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

If the operator opts into the issue-authoring companion, fetch its canonical
source files separately and write them directly to the selected native skill
destination. The Codex CLI example below uses `.agents/skills/`; set
`SKILL_DEST` to a different single native destination when the target runtime
requires it:

<!-- audit:shell-list id=issue-authoring-companion-gh-api-loop -->

```sh
DEST="."  # root of the target repository
SKILL_DEST="${DEST}/.agents/skills/issue-authoring"  # Codex example; choose one native destination

mkdir -p "${SKILL_DEST}/references"

for FILE in \
  "SKILL.md" \
  "references/contract.md" \
  "references/draft-patterns.md" \
  "references/workflow-boundary.md"
do
  mkdir -p "$(dirname "${SKILL_DEST}/${FILE}")"
  gh api -H "Accept: application/vnd.github.raw+json" \
    "repos/kurone-kito/idd-skill/contents/skills/issue-authoring/${FILE}" \
    > "${SKILL_DEST}/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

Alternatively, use `curl` (no authentication required — idd-skill is a public
repository):

<!-- audit:shell-list id=idd-template-core-curl-loop -->

```sh
BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template"
DEST="."  # root of the target repository

mkdir -p "${DEST}/.github/idd" "${DEST}/.github/workflows" \
  "${DEST}/.github/instructions" "${DEST}/docs" "${DEST}/docs/onboarding"

for FILE in \
  ".github/idd/config.json" \
  ".github/workflows/post-merge-cleanup.yml" \
  ".githooks/_idd-worktree-guard.sh" \
  ".githooks/pre-commit" \
  ".githooks/pre-push" \
  ".cspell.config.yml" \
  ".markdownlint.yml" \
  ".markdownlint-cli2.yaml" \
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
  ".github/instructions/lite/idd-claim-lite.instructions.md" \
  ".github/instructions/lite/idd-work-lite.instructions.md" \
  ".github/instructions/lite/idd-pr-submit-lite.instructions.md" \
  ".github/instructions/lite/idd-review-snapshot-lite.instructions.md" \
  ".github/instructions/lite/idd-pre-merge-lite.instructions.md" \
  ".github/instructions/lite/idd-merge-handoff-lite.instructions.md" \
  ".github/instructions/lite/idd-review-fix-lite.instructions.md" \
  ".github/instructions/lite/idd-resume-lite.instructions.md" \
  ".github/instructions/lite/idd-resume-stall-lite.instructions.md" \
  ".github/instructions/lite/idd-ci-lite.instructions.md" \
  ".github/instructions/lite/idd-advisory-wait-lite.instructions.md" \
  "docs/index.md" \
  "docs/idd-workflow.md" \
  "docs/idd-review-policy-profiles.md" \
  "docs/idd-helper-scripts.md" \
  "docs/idd-autonomy-contract.md" \
  "docs/idd-comment-minimization.md" \
  "docs/idd-resume-detail.md" \
  "docs/idd-advisory-wait-shell-fallback.md" \
  "docs/idd-design-rationale.md" \
  "docs/idd-concept-ownership.md" \
  "docs/permissions.md" \
  "docs/getting-started.md" \
  "docs/concepts.md" \
  "docs/customization.md" \
  "docs/policy-constants.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/issue-mediated-bootstrap.md" \
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

If the operator opts into the issue-authoring companion with `curl`, fetch
the same canonical source files to the selected native skill destination:

<!-- audit:shell-list id=issue-authoring-companion-curl-loop -->

```sh
BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/skills/issue-authoring"
DEST="."  # root of the target repository
SKILL_DEST="${DEST}/.agents/skills/issue-authoring"  # Codex example; choose one native destination

mkdir -p "${SKILL_DEST}/references"

for FILE in \
  "SKILL.md" \
  "references/contract.md" \
  "references/draft-patterns.md" \
  "references/workflow-boundary.md"
do
  mkdir -p "$(dirname "${SKILL_DEST}/${FILE}")"
  curl -fsSL "${BASE}/${FILE}" -o "${SKILL_DEST}/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

### Option B — Local copy (idd-skill cloned)

If you have cloned `https://github.com/kurone-kito/idd-skill`, copy
the files from `idd-template/` into the target repository preserving
their relative paths.

If the operator opts into the issue-authoring companion, copy the canonical
`skills/issue-authoring/` source bundle from the idd-skill checkout to one
selected native destination in the target repository. For example, from the
idd-skill checkout:

```sh
SOURCE="skills/issue-authoring"
TARGET_REPO="../target-repository"
SKILL_DEST="${TARGET_REPO}/.agents/skills/issue-authoring"  # Codex example; choose one native destination

mkdir -p "${SKILL_DEST}/references"
cp -R "${SOURCE}/." "${SKILL_DEST}/"
```

Do not copy the same skill ID into additional runtime roots by default
(preventive; no observed incident yet).

### Optional companion boundary

The issue-authoring companion drafts or refines IDD-ready issues,
roadmaps, and sub-issues before execution starts. It does not authorize
publishing issues, editing GitHub issues, or starting the Discover →
Claim → Work loop unless the operator explicitly asks for that next
step.

Keep the companion separate from the execution instructions and distinguish
its source from its installed destination:

- `skills/issue-authoring/` is the canonical source helper for drafting issue
  sets.
- The selected native `SKILL_DEST` is the target repository's installed
  destination; it is not another canonical source.
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

3. On a native-Windows checkout, add an explicit LF rule for the three
   shipped hook files to the target repository's own `.gitattributes`
   (the template does not ship one — see "Out of scope" in
   kurone-kito/idd-skill#2060):

   ```gitattributes
   .githooks/* text eol=lf
   ```

   Git for Windows' installer defaults to `core.autocrlf=true`
   ("Checkout Windows-style, commit Unix-style line endings"). With no
   `.gitattributes` override, that setting checks these files out as
   CRLF; the trailing `\r` then breaks the `.`/`source` line that loads
   `_idd-worktree-guard.sh`, hard-blocking every commit and push. A
   `*.sh` rule alone is not enough — `pre-commit` and `pre-push` ship
   without an extension, so they need this explicit `.githooks/*` path
   rule to be covered too.

When `worktreeGuard.enabled` is absent or `false`, the hooks are a
no-op. To bypass the guard for a single intentional commit or push,
pass `--no-verify`. CI cannot detect this class of violation — a
primary-worktree mistake leaves no trace in the pushed history — so
this local hook, together with `idd-doctor --strict`, is the practical
enforcement surface.

#### Coexisting with an existing hook manager

`core.hooksPath` is repository-wide git config, not scoped to whichever
worktree set it: activating or resetting it from any one worktree of a
clone changes hook resolution for every other worktree of that same
clone too, including the primary worktree.

An existing hook manager (Husky or similar) can silently reset
`core.hooksPath` back to its own hooks directory on every
install/prepare lifecycle run — Husky v9's default `prepare: "husky"`
script repoints `core.hooksPath` at `.husky/_` unconditionally, so a
routine `pnpm install` after activation leaves this guard unwired
again with no error. `idd-doctor`'s enabled-but-inert detection (below) correctly
flags this again, but nothing about the reset itself is a bug — do not
assume `core.hooksPath` is free to claim outright. Chain each existing
hook to the corresponding `.githooks/*` script instead, resolving the
repository root explicitly so the hook still works when git invokes it
from a subdirectory. When the hook manager doesn't define that hook
file yet (for example, Husky ships only `pre-commit` until an adopter
adds `pre-push` themselves), create it with the chain line as its
entire contents, using `exec` since nothing else needs to run
afterward. When the file already exists but has no terminal `exec` or
`exit` of its own, append the same `exec` form as its last line. When
the file already ends in a terminal `exec` or `exit`, don't `exec` the
chain line too — `exec` never returns, so it would swallow that
terminal command exactly as surely as appending after it would.
Instead insert an _invoked_ (not `exec`'d) call before it, propagating
a nonzero exit so a failing guard still stops the hook, while a
passing one lets control reach the manager's own terminal command
afterward. The B1 guard needs both hooks chained:

```sh
# .husky/pre-commit doesn't exist yet, or has no terminal exec/exit of its own
# -- create or append this as the last line:
exec "$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@"

# .husky/pre-commit already ends in a terminal exec/exit -- insert this line
# before it instead (not exec'd, so that command still runs):
"$(git rev-parse --show-toplevel)/.githooks/pre-commit" "$@" || exit $?
```

The same two forms apply to `.husky/pre-push`, substituting
`pre-push` for `pre-commit` throughout.

`idd-doctor`'s enabled-but-inert check follows a bounded one-level
dispatch: when the hook file at the resolved `core.hooksPath` does not
itself source the guard, it also checks the corresponding hook file in
`core.hooksPath`'s **parent** directory — the shape Husky v9's own
`.husky/_` split takes — for one of the two documented chain forms
above, and confirms the referenced `.githooks/<hook>` script itself
genuinely sources the guard (observed 2026-08-11 during PR #1948's
review; [#1951](https://github.com/kurone-kito/idd-skill/issues/1951)).
A setup that follows the recipe above for **both** hooks now reads as
wired, not enabled-but-inert. The check still does not trace an
arbitrary hook manager's own dispatch machinery beyond that one
documented level: it confirms a hook file exists **and is executable**
at `core.hooksPath` — since git itself silently skips a non-executable
one — but does not verify that file's own content genuinely hands off
to the parent sibling it trusts, so a present-but-inert or corrupted
dispatcher stub can still read as wired even though git never reaches
the parent chain (preventive; no observed incident yet). Conversely, a
manager using a different indirection shape entirely can still warn
even when the guard is genuinely reachable through it; a warning while
only one hook is chained, or while the chain targets a missing or
incorrect `.githooks/*` script, remains actionable as intended either
way.

Recognizing the two chain forms above is itself a bounded lexical
heuristic, not a shell parser: it matches the documented forms as an
ordinary standalone physical line and deliberately does not evaluate
quoting edge cases, variable expansion, here-docs, `eval`, subshell
wrapping, or other adversarial or unusual shell constructions that
could reach one of the two forms at runtime while lexically evading
this check, or vice versa (preventive; no observed incident yet). This
is a warning-level misconfiguration diagnostic, not a security
boundary — an operator who wants to fool it can simply not enable the
guard — so hardening against constructions beyond the documented
recipe stays out of scope absent an observed incident.

Fully replacing an existing hook manager instead of chaining it removes
that tool from the repository outright, so treat it as an alternative
worth knowing about, not the default recommendation. Under pnpm's
`shellEmulator: true`, a fully-replacing lifecycle script still needs
to be POSIX-control-flow-free — no `if`/`then`/`fi`, which
`shellEmulator`'s reduced grammar cannot parse. For example, a
replacement `package.json` `"prepare"` script needs a short-circuit
instead:

```sh
git rev-parse --git-dir > /dev/null 2>&1 || exit 0; git config core.hooksPath .githooks && chmod +x .githooks/pre-commit .githooks/pre-push
```

Neither path — chaining or fully replacing — is wired automatically by
this template: the operator (or an agent following this guide) has to
author and commit the chaining line or the replacement script
explicitly. Once committed, propagation to a future clone happens
through whichever install/prepare lifecycle now owns it there. For
chaining, that's the existing hook manager's own lifecycle — never
repoint git directly at `.githooks` there by manually repeating the
base activation step above, since a manager is still present and that
step would bypass it. For fully replacing, that's the repository's own
replacement lifecycle script; repeating the base activation step there
is harmless, since no manager remains to bypass and the step sets the
identical value the replacement script would. That base step stays the
right standalone action only for a clone with no hook manager involved
at all, where there is no lifecycle script to carry it forward.

#### Activation in a coding-agent / ephemeral environment

The `git config core.hooksPath` step above is **local and uncommitted**, so
any environment that starts from a fresh clone per task never inherits it: a
coding agent such as the GitHub Copilot coding agent, an ephemeral container,
or a throwaway checkout all begin unwired. There, `worktreeGuard.enabled:
true` on its own enforces nothing — without `core.hooksPath` pointed at
`.githooks` the shipped hooks never run, so a lightweight model can commit
from the primary worktree undetected. CI cannot backstop this (the violation
leaves no pushed-history trace and CI checks out a detached HEAD), so
activation has to happen inside the agent's own setup.

Wire the hooks as the agent's environment-setup step — the first thing it
runs before any work, or the platform's setup mechanism (for the GitHub
Copilot coding agent, its `copilot-setup-steps` workflow). A
repository that fully replaces a hook manager (above) can keep this
command unconditional: no manager remains to bypass, and it sets the
same value the replacement script would. A repository that instead
chains an existing hook manager needs a different setup step: skip
this direct command — it would repoint git at `.githooks` and bypass
the chained manager — and instead make the agent's setup explicitly
run that manager's own install/prepare lifecycle (for example, a
`pnpm install` step), since a fresh ephemeral clone does not run it
automatically either; skipping the command without also running that
lifecycle leaves the guard unwired despite following this guidance.
Otherwise, for a repository with no hook manager involved:

```sh
git config core.hooksPath .githooks && chmod +x .githooks/pre-commit .githooks/pre-push
```

For the direct or fully-replacing path, because the agent re-runs this
every task, the guard stays active for the whole session — confirm it
actually took effect with `idd-doctor`, which surfaces an
**enabled-but-inert** finding when `worktreeGuard.enabled` is `true`
but `core.hooksPath` is not pointed at `.githooks` and no recognized
chain is present, the signal that the setup step silently did not run
(the chaining path below intentionally keeps `core.hooksPath` pointed
at the manager's own directory instead, so that condition alone does
not fire there). For the chaining path, `idd-doctor`'s
confirmation now covers the documented recipe the same way it covers
the direct/fully-replacing path above — a correctly chained setup
reads as wired once the manager's lifecycle has actually run.
Chain-line presence alone still isn't a safe substitute for running
`idd-doctor`, though: a fresh ephemeral clone checks out the committed
chain lines immediately, even when the setup lifecycle never ran and
`core.hooksPath` is still unset, which `idd-doctor` still correctly
reports as enabled-but-inert (`core.hooksPath = (unset)`; preventive,
no observed incident yet). If a custom dispatch shape falls outside
the documented one-level recipe (above; also preventive, no observed
incident yet), fall back to verifying both explicitly: that the
committed chain lines are present in the manager's hook files, and that
`git config --get core.hooksPath` resolves to the manager's own hooks
directory (not empty), confirming its lifecycle actually ran and wired
that value rather than just that the files exist. This is activation
guidance only; the adopter default stays opt-in **off**.

### Optional — run idd-doctor as a CI health gate

Running `idd-doctor` in CI catches repository-health regressions
(config/schema drift, unresolved placeholders, marker-prefix
inconsistency, missing required files) on every change. It is opt-in —
add a workflow such as one of the profile-specific examples below,
matching the repository's confirmed helper-runtime profile.

**`vendored-node`** — the helper bundle is copied into `scripts/`:

```yaml
name: IDD doctor health gate
on:
  pull_request:
permissions:
  contents: read
  issues: read
  pull-requests: read
jobs:
  idd-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }} # detached HEAD keeps the worktree check inert
          persist-credentials: false
      - run: node scripts/idd-doctor.mjs
        env:
          GH_TOKEN: ${{ github.token }}
          GH_ENTERPRISE_TOKEN: ${{ github.token }}
```

**`package-manager`** — the helper ships as an installed
`devDependency` invoked through the repository's package manager. This
example uses pnpm; swap the `pnpm/action-setup` step and the install /
invoke commands for npm or yarn equivalents if the repository uses a
different package manager:

```yaml
name: IDD doctor health gate
on:
  pull_request:
permissions:
  contents: read
  issues: read
  pull-requests: read
jobs:
  idd-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }} # detached HEAD keeps the worktree check inert
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24.x
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec idd-doctor
        env:
          GH_TOKEN: ${{ github.token }}
          GH_ENTERPRISE_TOKEN: ${{ github.token }}
```

**`ephemeral-npx`** — no helper files or `devDependency` are vendored;
resolve the helper command one-shot instead. Replace
`<reviewed-helper-spec>` with the same reviewed spec the repository's
other helper invocations use (see
[Onboarding Reference — Policy Decisions](docs/onboarding/policy-decisions.md#helper-runtime-profile)):

```yaml
name: IDD doctor health gate
on:
  pull_request:
permissions:
  contents: read
  issues: read
  pull-requests: read
jobs:
  idd-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }} # detached HEAD keeps the worktree check inert
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: 24.x
      - run: npx --yes --package <reviewed-helper-spec> idd-doctor
        env:
          GH_TOKEN: ${{ github.token }}
          GH_ENTERPRISE_TOKEN: ${{ github.token }}
```

Both the extra `permissions:` scopes and a host-matching token are
required: without the correct host-scoped token (`GH_TOKEN` on
`github.com`/`ghe.com`; `GH_ENTERPRISE_TOKEN` on GHES — see below),
`gh` has no credential, so idd-doctor's GitHub-API-backed checks
silently skip or emit one generic warning, yet the job still reports
success — a green gate that checked less than it appears to (observed
on this repository's own workflow,
kurone-kito/idd-skill#1828). With them, the post-merge cleanup backlog
and autopilot-suitability checks actually run instead of being
silently skipped. The branch-protection probe stays unreadable
regardless: it needs a repository-administration permission that
GitHub Actions' `permissions:` model can't grant to `GITHUB_TOKEN`, so
it keeps warning even with these scopes added.

**Setting `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` together.** `gh`'s
environment-variable auth resolution is host-scoped (`gh help
environment`): `GH_TOKEN`/`GITHUB_TOKEN` apply only when a command
targets `github.com` or a `ghe.com` subdomain, while a self-hosted
GitHub Enterprise Server (GHES) host reads
`GH_ENTERPRISE_TOKEN`/`GITHUB_ENTERPRISE_TOKEN` instead. `gh` only
reads the variable that matches its resolved host, so the three
examples above set both — harmless on `github.com` and additive on
GHES — instead of branching per host. If you copy one of these
examples onto a GHES-hosted repository, keep both lines rather than
deleting `GH_ENTERPRISE_TOKEN` as apparently redundant (preventive; no
observed incident yet).

**Setting the token alone is not sufficient by itself on GHES.** `gh
api`/`gh api graphql` resolve their target host from `GH_HOST`/
`--hostname` (or the CLI's configured default), not from the
checked-out repository's Git remote the way `gh pr view`/`gh issue
edit` do — so on a GHES-hosted repository, an unset `GH_HOST` would
otherwise send these calls to `api.github.com` using `GH_TOKEN`, with
`GH_ENTERPRISE_TOKEN` never read at all (observed 2026-08-11, a Codex
advisory review on
[kurone-kito/idd-skill#1959](https://github.com/kurone-kito/idd-skill/pull/1959)).
`src/scripts/gh-exec.mts`'s shared `ghApiJson`/`ghGraphql` wrappers now
resolve the correct `--hostname` automatically
([kurone-kito/idd-skill#1962](https://github.com/kurone-kito/idd-skill/issues/1962)),
preferring an explicit `GH_HOST` when set (in which case no
`--hostname` is added — `gh` already resolves it correctly on its
own) and otherwise, in GitHub Actions, deriving the host from the
`GITHUB_SERVER_URL` default environment variable (no workflow `env:`
change needed, and no behavior change at all on `github.com`, where it
already equals the default host). Outside Actions (a local
`idd-doctor` run) with neither signal set, they defer to `gh`'s own
single-authenticated-host default, same as `gh` itself.
`idd-advisory-convergence` (both the CI-hosted
required-check workflow and its underlying `advisory-convergence.mts`
GitHub-API calls) goes through these shared wrappers, so it is covered
end to end. `idd-doctor.mts`'s own few direct `gh api` call sites do
not route through `gh-exec.mts` and are **not** covered by this fix —
a GHES adopter relying on `idd-doctor`'s GitHub-API-backed checks
(post-merge cleanup backlog, autopilot-suitability) should still treat
host resolution there as an open gap.

This gate checks repository **health**, not the disposable-worktree rule:
CI cannot detect a primary-worktree B1 violation (it leaves no trace in
pushed history and CI checks out a detached HEAD), so worktree
enforcement stays local — the `core.hooksPath` hook above, the
cwd-vs-claim gate, and `idd-doctor --strict` run on a developer's
machine.

**Branch-glob vs CI-trigger.** Put PR-gating checks in the
`pull_request`-triggered workflow (as above). A `push` workflow filtered to a
**top-level branch glob** such as `'*'` silently skips the slash-namespaced
IDD branches (`issue/*`, `roadmap-audit/*`): a single-star glob does not match
across the `/`, so a gating job placed only under `on: push` with `'*'` never
runs on IDD branches. Use `pull_request` triggers (which fire on the PR
regardless of branch name), or a push filter that matches the slash namespace
(`'**'` or `'issue/**'`), for any check that must gate IDD pull requests.

### Optional — host idd-advisory-convergence as a required-check CI workflow

For repositories that vendor the IDD helper scripts, hosting the
`advisory-convergence` helper (`docs/idd-helper-scripts.md`) as a CI
workflow turns "Copilot's review converged on the current PR HEAD" from
an instruction the execution model must choose to honor into a
status check GitHub itself can enforce. It is opt-in — the template
already mirrors the workflow at
[`idd-template/.github/workflows/idd-advisory-convergence.yml`](.github/workflows/idd-advisory-convergence.yml);
copy that one file into your repository's `.github/workflows/` to
enable it. It is not wired in automatically by importing the rest of
`idd-template/`, since adding a new required-status-check-able workflow
is a deliberate adopter decision, not a default.

Adjust the command to your helper-runtime profile, and the
`actions/checkout` version if needed — the mirrored file intentionally
uses the floating `@v4` form. Override the runner via the
`CI_RUNNER_LABEL` repository variable (Settings > Secrets and
variables > Actions > Variables) rather than hand-editing `runs-on`;
it falls back to the portable `ubuntu-latest` when unset. Setting it
is **required**, not optional, on GitHub Enterprise Server, which does
not support GitHub-hosted runners at all — self-hosted runners are
mandatory there, and the same variable also covers any organization
that mandates self-hosted runners even on github.com/GHEC. This
source repository's own copy at
`.github/workflows/idd-advisory-convergence.yml` instead pins a
specific `actions/checkout` SHA and hardcodes a custom runner label,
which is appropriate for its own hardened, dogfooded CI but not a
requirement for adopters. This workflow is read-only: it never mutates GitHub
state, only queries the GitHub API for reviews, review threads, and
waiver markers. `issues: read` is required in addition to
`pull-requests: read` because the helper reads the PR's own
conversation comments via the issue-comments REST endpoint, which
GitHub gates under the Issues permission category even when the issue
number is a pull request.

**Trusted-code checkout.** The checkout step pins `ref: main` (adjust
if your default branch differs) rather than the PR's own head, for
every trigger type including `workflow_dispatch`. The enforcement
script (`scripts/advisory-convergence.mjs`) and its config
(`.github/idd/config.json`) must run from the trusted branch, not a
PR's own copy — otherwise a PR could edit the verdict logic itself to
force `ready: true` and defeat the whole required-check gate. The
verdict still correctly evaluates the intended PR: `--pr <number>`
drives every live GitHub API call the script makes (reviews, threads,
comments), independent of what is checked out locally, so pinning the
checkout to the trusted branch costs nothing functionally.

Three automatic trigger types keep the verdict current: `pull_request`
for the normal push case, plus two triggers for the ways convergence
can change **without** a new push — `pull_request_review` for
Copilot's review submission, and `pull_request_review_comment` for a
reply posted, edited, or deleted on a review thread, including the
disposition markers (`**Accepted**` / `**Rejected**`) triage posts,
since those are exactly what flips a thread from blocking to
dispositioned. A thread being resolved or
unresolved via the "Resolve conversation" button
(`pull_request_review_thread`) is a real GitHub webhook event, but it
is **not** one of the events GitHub Actions supports as a workflow
`on:` trigger — including it makes the whole workflow file fail
GitHub's schema validation (confirmed both against GitHub's own
trigger-events reference and empirically). Residual gap: if a
Copilot-authored thread is resolved or reopened with no accompanying
comment, push, or fresh Copilot review, this check keeps reporting its
last computed verdict until one of the three automatic triggers fires
or a maintainer runs the workflow's fourth trigger,
`workflow_dispatch`, manually — an explicit "Run workflow" affordance
for that case, taking a `pr_number` input since a manually dispatched
run has no PR context of its own.

**Register it as a required status check.** Hosting the workflow alone
does not block merge — a maintainer must separately register
`idd-advisory-convergence` (the job id, which is also the
`ciGate.externalCheckWaivers` selector for this check — see
[policy constants](docs/policy-constants.md#advisory-review-defaults))
as a **required** status check in the repository's branch-protection
Ruleset, the same way other CI jobs are registered there. This is a
maintainer GitHub-settings action taken outside of IDD automation, not
something an agent applies on its own.

**Avoid the classic-API pinning trap.** This applies specifically to
GitHub's **classic** branch-protection API (`.../protection/...`) — a
separate mechanism from the Ruleset just described above; this section
does not claim Rulesets are unaffected, only that the classic API is
the one field-verified here. That classic API silently rewrites a
plain string-array `contexts` field into `app_id`-pinned `checks`
entries: a `PUT .../protection`
call configuring `contexts` comes back with a `checks` array carrying
an `app_id` (for example, `15368` for `github-actions[bot]` on
github.com — an implementation detail of that specific integration, not
a portable constant; a GHES instance or a future GitHub change can
differ). A pinned entry is exactly what the fail-closed "Source-pinned
required-check trust" default (`ciGate.trustSourcePinnedRequiredChecks`
— see the row in [Customizing IDD](docs/customization.md)) downgrades
to unresolved even when green, so an operator who registers this or any
other required check the straightforward way walks into that gate on
the very first PR, for a reason nothing in the classic API response
explains (observed 2026-08-11 onboarding a companion repository;
[kurone-kito/idd-skill#1925](https://github.com/kurone-kito/idd-skill/issues/1925)).

Use the narrower `PATCH .../required_status_checks` endpoint instead,
with an explicit `checks` array and `app_id: -1` (any producer) rather
than a plain `contexts` array. Substitute `{base-branch}` below with
the literal protected branch name (for example `main`) — do not use
`gh api`'s own `{branch}` magic placeholder, which silently resolves to
whatever branch is currently checked out locally, not the protected
branch (preventive; no observed incident yet — verified against
`gh api --help`'s own placeholder documentation, not a field-observed
adopter incident):

```sh
gh api --method PATCH \
  repos/{owner}/{repo}/branches/{base-branch}/protection/required_status_checks \
  --input - <<'JSON'
{"checks": [{"context": "idd-advisory-convergence", "app_id": -1}]}
JSON
```

**`PATCH` replaces the whole `checks` list — it does not merge into
it** (preventive; no observed incident yet). If the branch already
requires other checks (lint, build, tests, and so on), first fetch the
current array:

```sh
gh api \
  repos/{owner}/{repo}/branches/{base-branch}/protection/required_status_checks \
  --jq '.checks'
```

Then include every existing entry alongside the new one in the
`checks` array above — **except** an existing entry whose `context`
already matches the check being added (for example, an existing
pinned `idd-advisory-convergence` entry): replace that matching entry
rather than appending a second one, since a duplicate context name
where any entry is still pinned keeps the whole context classified as
source-pinned regardless of the other, unpinned entry (preventive; no
observed incident yet). Copy-pasting
the snippet unqualified on a branch that already has required checks
silently drops them, weakening the merge gate to only the newly added
check.

`app_id: -1` also trades away GitHub's producer-identity enforcement
for the check it names (preventive; no observed incident yet) — a
reasonable trade for `idd-advisory-convergence`, since only the
adopter's own hosted workflow ever produces a check with that exact
name, but not a blanket recommendation for every required check. Keep
a specific `app_id` pin
on any check where verifying the producer matters, and opt in to
`ciGate.trustSourcePinnedRequiredChecks: true` (see the row in
[Customizing IDD](docs/customization.md)) instead, once the operator
has verified out-of-band that the pinned integration is the sole
producer.

**Waiver-after-deadline escape path.** `--assert` exits non-zero for
any not-ready verdict, including the ordinary case where the primary
advisory bot has not yet reviewed the current PR HEAD — GitHub Actions
has no separate non-failing "pending" check state, so the check simply
**shows as failing** until it converges (by design: it must stay red
until Copilot reviews the HEAD). After `advisoryWait.convergenceDeadline`
(default 24h) elapses from the HEAD commit's own timestamp, the only
way to turn the check green without a fresh review is a valid
maintainer external-check waiver for that HEAD under the selector
`idd-advisory-convergence` — see
[External-Check Waiver Defaults](docs/policy-constants.md#external-check-waiver-defaults)
and the waiver policy surface in
[Customizing IDD](docs/customization.md#policy-constants).
That path only exists once `ciGate.externalCheckWaivers.mode` is
`maintainer-authorized` **and** `idd-advisory-convergence` is itself
registered under `ciGate.externalChecks.waivable`; enabling waiver mode
for some other external check never silently makes this one waivable
too. **Posting the waiver comment does not by itself turn the check
green**: a PR comment is not one of this workflow's trigger events and
a completed run's conclusion never changes on its own, so after
posting the waiver a maintainer must also trigger a new run — push, a
fresh review, the Actions UI "Re-run jobs" button on the _existing_
PR-linked run for the **current HEAD SHA**, or `gh run rerun <run-id>`
on that same run — for the required check to actually reflect it.
`workflow_dispatch` does **not** reliably do this: a dispatched run has
no `pull_request` context of its own, so GitHub associates it with the
dispatch ref rather than the PR's HEAD SHA, and the resulting run's
conclusion can be invisible to that PR's required-check rollup. See
[kurone-kito/idd-skill's own dogfooded copy of `.github/workflows/idd-advisory-convergence.yml`](https://github.com/kurone-kito/idd-skill/blob/main/.github/workflows/idd-advisory-convergence.yml)'s
header comment for the full finding — this deliberately links the
upstream source repository's copy, not your own vendored workflow
file: the fuller investigation prose lives only in that dogfooded
original, and the portable stub this template mirrors at
`.github/workflows/idd-advisory-convergence.yml` in your own
repository does not carry it.

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

> **CLI shortcut**: `node scripts/idd-onboard.mjs --substitute` automates
> this step — see [CLI-assisted onboarding](#cli-assisted-onboarding)
> above.

In the copied files, perform a global replacement for:
`{{REPO_NAME}}`, `{{PROJECT_MARKER_PREFIX}}`,
`{{TRUSTED_MARKER_ACTOR}}`, `{{FIX_VALIDATE_COMMANDS}}`,
`{{PRE_PUSH_VALIDATE_COMMANDS}}`, `{{POST_FIX_VALIDATE_COMMANDS}}`,
and `{{INSTALL_DEPS_COMMAND}}`.

Use
[Onboarding Reference — Placeholder Values](docs/onboarding/placeholders.md)
for the detailed placeholder meanings, no-op substitution rules, and
marker-prefix guidance.

**Three meta-docs stay literal on purpose**:
`docs/onboarding/placeholders.md`, `docs/customization.md`, and
`docs/onboarding/policy-decisions.md` document the seven placeholders
with worked `{{...}}` examples rather than consuming them, so
`--substitute` skips all three by path and never rewrites them (#1924).
`--verify`'s placeholder-residue check applies the same skip, so their
surviving tokens are expected and not reported as unresolved.

After replacing, verify that no `{{...}}` placeholder strings remain in
any copied file other than those three meta-docs.

---

## Step 5 — Update agent entry files

By default, leave the repository with root entry files for every
manually-routed non-Copilot agent named in `docs/idd-workflow.md`:
`CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`. `AGENTS.md` is the shared
agents.md-standard entry for both Codex CLI and OpenCode — OpenCode
auto-loads it natively, so no dedicated root file is needed for
OpenCode.

- If the file already exists, append or adapt an IDD section without
  replacing unrelated repository guidance.
- If the file is missing, create a minimal stub — and when a sibling
  entry file or an existing `.github/copilot-instructions.md` already
  carries repository-specific guidance, point the new file at the
  file(s) that own it instead of copying that guidance in.
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

> **CLI shortcut**: `node scripts/idd-onboard.mjs --verify` automates this
> checklist — see [CLI-assisted onboarding](#cli-assisted-onboarding)
> above.

Use
[Onboarding Reference — Agent Entry and Verification](docs/onboarding/agent-entry-and-verification.md)
for the expanded verification details and evidence expectations.

After completing the steps above, confirm each item:

- [ ] Every core execution file, supporting doc, and profile artifact
      listed in Step 2 is present in the imported repository.
- [ ] `.markdownlint.yml`, `.markdownlint-cli2.yaml`, and
      `.cspell.config.yml` are present, or — if `--import` reported a
      `blockedOverwrites` finding for any of them because the target
      already had its own differing file — the template's rule
      overrides / word list were merged into the existing file by hand
      rather than skipped, so the documented `markdownlint-cli2`/`cspell`
      commands in the `Project commands` table still pass against the
      imported documentation.
- [ ] The selected PR review profile is recorded, and any non-default
      profile artifact and phase-file edits are complete.
- [ ] The selected review-thread resolution policy and critique-loop
      profile are recorded, and any non-default phase-file
      customizations are complete.
- [ ] The selected CI wait policy values, merge policy, credential
      scope, claim timing values, issue-author approval gate decision,
      maintainer approval actor policy, helper runtime profile, and
      bootstrap execution mode are explicitly recorded.
- [ ] If the operator opted into issue authoring, the companion skill
      files are present under the native destination recorded in the policy.
- [ ] No `{{...}}` placeholders remain, the `Project commands` table is
      correct, and any `orphan-first` scope choice has a valid policy
      value.
- [ ] `.github/instructions/idd-overview-core.instructions.md` keeps
      `applyTo: "**"` and `excludeAgent: "code-review"` in its
      frontmatter.
- [ ] `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` exist and reference
      `docs/idd-workflow.md`, unless the operator explicitly opted out
      of creating them.
- [ ] Among the entry files the operator did not opt out of creating,
      they agree on repository-specific engineering guidance — each
      carries it directly or points to the file(s) that own it; no
      newly created file silently drops it (observed 2026-07-27,
      kurone-kito/idd-skill#1717). Manual check: `--verify` below does
      not cover this item.
- [ ] If `.github/copilot-instructions.md` existed before onboarding,
      it now includes the IDD workflow reference as well.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names match the
      selected prefix, and `.github/idd/config.json` stays aligned when
      the repository uses it.

Once all items are checked, the IDD workflow is ready for use. Point the
operator to `docs/idd-workflow.md` as the starting guide.
