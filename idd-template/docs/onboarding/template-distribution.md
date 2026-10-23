---
type: reference
title: Template Distribution Maintainer Reference
description: Explains how the template's generated file-distribution lists in ONBOARDING.md stay correct as files are added, removed, or moved.
tags: [onboarding, template-distribution]
---

# Template Distribution Maintainer Reference

Use this page when maintaining the file distribution surface for
`idd-template/ONBOARDING.md`. The onboarding entry point remains the
operator-facing import path; this page explains how the file list and
fetch examples stay correct when the template gains, removes, or moves
files.

This is primarily a maintainer reference for the `idd-skill` source
repository. Adopters who receive it with the copied template can treat it
as background unless they intentionally customize their local template
distribution lists.

## Anatomy of a helper re-import (`vendored-node` profile)

If you vendor the shared helper bundle — the `vendored-node` profile,
which physically copies the shared `protocol-helpers` core — a new
**leaf helper** is rarely a standalone file drop:

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

## Distribution surfaces

The template has three distribution surfaces:

1. **Core template files** copied from `idd-template/` into the adopter
   repository. These include `.github/idd/`, `.github/instructions/`,
   `docs/`, and `profiles/`.
2. **Optional companion files** (`issue-authoring`, `idd-spec-audit`) read
   from their canonical `skills/*/` source bundles and installed under one
   selected runtime-native destination per companion, only when the
   operator explicitly opts into pre-execution issue drafting or
   instruction-corpus auditing.
3. **Local-copy imports** that use the local helper's `--import`
   mode to copy the canonical core file set from a local `idd-skill`
   clone.

This page keeps the executable import snippets for all three surfaces:
remote-fetch examples for the core and optional companions, plus the
local-copy import below. See [Remote fetch examples](#remote-fetch-examples)
and [Local-copy installs](#local-copy-installs);
`idd-template/ONBOARDING.md` Option A/B point here for the exact
commands instead of inlining them.

Each companion's generated block describes canonical source paths relative
to the idd-skill checkout. Neither is a target installation path: the
[Remote fetch examples](#remote-fetch-examples) below use a separate
`SKILL_DEST` value per companion, with `.agents/skills/issue-authoring/`
and `.agents/skills/idd-spec-audit/` as the Codex examples.
[Local-copy installs](#local-copy-installs) currently ships only the
`issue-authoring` companion's copy recipe; add the equivalent
`idd-spec-audit` recipe separately if local-copy parity is wanted.
Record the selected destination in the onboarding policy and do not add
a second same-named runtime mirror by default (preventive; no observed
incident yet).

## Generated file lists

The authoritative generated lists are configured in
`audit/sync-manifest.json`:

- `generatedBlocks[].id == "idd-template-core-files"` owns the core
  template file list.
- `generatedBlocks[].id == "issue-authoring-companion-files"` and
  `"idd-spec-audit-companion-files"` each own one optional companion
  list.
- `shellFileLists` ties each generated list to the `gh api` and `curl`
  loops in [Remote fetch examples](#remote-fetch-examples) below — one
  `gh api`/`curl` pair per companion.
- `generatedBlocks[].id == "idd-template-readme-core-files"`,
  `"idd-template-readme-issue-authoring-files"`, and
  `"idd-template-readme-idd-spec-audit-files"` own the descriptive
  file inventory in `idd-template/README.md`'s "Files" section. This is
  a **fourth, broader inventory surface** — not one of the three
  distribution surfaces above, since it documents the shipped file set
  rather than copying it into an adopter repository: a `sourceGlobs`-only
  match against every file under `idd-template/` (`idd-template/**/*`),
  deliberately including files the core import list excludes by design
  — `scripts/minimize-superseded-markers.mjs` (see the
  profile-conditional section below), `.github/workflows/idd-advisory-convergence.yml`,
  and `.claude/settings.json`. `post-merge-cleanup.yml` is **not** in
  this exclusion list — it moved into the core `idd-template-core-files`
  set once its cleanup-audit invocation became profile-portable (no
  longer `vendored-node`-only), unlike `idd-advisory-convergence.yml`,
  which stays opt-in-only for an unrelated reason: hosting it as a
  required-status-check is a deliberate adopter decision with its own
  ruleset-registration step, not a helper-portability question. Because
  the readme inventory block has no `paths` list, adding a new
  `idd-template/` file never requires a manual edit here — running
  `node scripts/sync-docs.mjs --apply` picks it up automatically. Keep
  each companion half's `paths` in sync with its own
  `*-companion-files` block's list by hand (both companion lists are
  short, curated, and rarely change) — the audit's `paths`/`sourceGlobs`
  cross-check still catches drift on either one.

When adding a core template file, update both `sourceGlobs` and `paths`
for `idd-template-core-files` when the new path is not already covered.
The docs audit compares those entries with the repository files and
fails if the generated block or shell loops are stale.

When adding an optional companion file, update both that companion's
`*-companion-files` block (`issue-authoring-companion-files` or
`idd-spec-audit-companion-files`) and its matching
`idd-template-readme-*-files` block above. Do not put optional
companion files in the core template list unless the execution loop
requires every adopter to receive them.

## Profile-conditional helper files (`vendored-node`)

`scripts/minimize-superseded-markers.mjs` (mirrored to
`idd-template/scripts/minimize-superseded-markers.mjs` by the
`minimize-superseded-markers-helper` syncPair) is invoked from template
instruction files, but it is deliberately **not** part of the
`idd-template-core-files` block or Option A's remote-fetch loops — every
`idd-template/**` doc and instruction file those instruction files
reference is core, but a `scripts/*.mjs` helper reference (this one
included) is not, since every helper script is `vendored-node`
profile-conditional. This is intentional, not an oversight:

- `idd-onboard.mjs`'s `resolveImportFiles` hard-fails with a "manifest
  drift: duplicate target path" error if a file's target path appears in
  both the always-shipped core set and the `vendored-node`
  profile-conditional helper bundle (`collectVendoredFiles` in
  `helper-runtime-manifest.mts`, which already vendors this file for
  that profile) — observed 2026-07-31, #1698, when adding this file to
  the core set tripped exactly that guard. The core set and the
  profile-conditional bundle must stay disjoint by construction.
- Putting it in the core set would also make `buildSwitchPlan` (used to
  compute add/remove diffs when an adopter switches profiles) list it
  under `removeFiles` on a `vendored-node` → non-`vendored-node` switch,
  deleting a file the adopter still needs — a real data-loss hazard, not
  just a manifest-consistency one (preventive; no observed incident
  yet).
- Every instruction-file call site degrades gracefully ("Skip entirely
  if … the helper is unavailable"), so the practical effect of the
  exclusion is bounded capability on some install paths, not breakage.

**For adopters:** core imports omit this helper and the rest of the
`vendored-node` bundle. Add `--profile vendored-node` to both
[local-copy commands](#local-copy-installs) to install them. The helper is
in repository-root `scripts/`, so a full clone is required. Option A can
fetch this standalone helper instead:

```sh
mkdir -p scripts
curl -fsSL \
  "https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/scripts/minimize-superseded-markers.mjs" \
  -o scripts/minimize-superseded-markers.mjs
```

If a future change makes this helper (or another `vendored-node`
helper) a genuine cross-profile core dependency, resolve the
core/profile-conditional overlap in `idd-onboard.mts` and
`helper-runtime-manifest.mts` first — do not add it to
`idd-template-core-files` while the disjointness invariant above still
holds. `node scripts/audit-docs.mjs --check` (which `checkGeneratedBlocks`
backs) only compares this doc's generated file list against
`audit/sync-manifest.json`; it has no awareness of the `vendored-node`
bundle in `helper-runtime-manifest.mts`, so it will not catch the
overlap. `resolveImportFiles`'s `manifest drift: duplicate target path`
hard-fail does catch it (the same #1698 incident cited above), but only
under `pnpm run test`'s full test suite (`node --test`), which the
distributed default `pre-push-validate` does not run — so a change that
only satisfies `audit-docs.mjs --check` can still break `idd-onboard.mjs`.
This needs a maintainer decision, not a mechanical file-list edit.

## `.gitattributes` linguist-vendored convention (`vendored-node`)

The copied helpers are third-party code: mark them `linguist-vendored`
per [the optional setup](optional-host-setup.md#optional--mark-the-vendored-helper-bundle-linguist-vendored),
not `linguist-generated=true` (first-party output; see root
`.gitattributes` and issue `#2958`).

`idd-template/` omits `.gitattributes` to leave the adopter's file alone;
the importer cannot merge it safely. Append the helper-runtime manifest's
exact lines, not a `scripts/*.mjs` glob that could include handwritten
files (preventive; no observed incident yet).

Run from the root of a full source clone and target the adopter
explicitly. Core imports omit `scripts/helper-runtime-manifest.mjs`;
`vendored-node` imports include it. Add a separator line before appending
to a non-empty `.gitattributes` so generated patterns stay separate even
when the existing file has no final newline. This may add a harmless blank
line when the existing file already ends with a newline (observed
2026-10-23, issue `#4642`):

```sh
SOURCE_ROOT="$(pwd)"
TARGET_REPO="/absolute/path/to/adopter"

if [ -s "$TARGET_REPO/.gitattributes" ]; then
  printf '\n' >> "$TARGET_REPO/.gitattributes"
fi

node "$SOURCE_ROOT/scripts/helper-runtime-manifest.mjs" \
  --profile vendored-node \
  | node -e 'const m=JSON.parse(require("node:fs").readFileSync(0,"utf8"));process.stdout.write(m.profiles["vendored-node"].recommendedGitattributes.join("\n")+"\n")' \
  >> "$TARGET_REPO/.gitattributes"
```

`idd-template/ONBOARDING.md`'s vendored-node profile guidance links
here.

## Remote fetch examples

These `gh api` and `curl` loops list every canonical source file
instead of fetching directories. This keeps raw-content imports
deterministic and makes missing files visible during onboarding.
Their `SKILL_DEST` variable is separate from the source path and
controls the selected runtime-native target directory.
`idd-template/ONBOARDING.md`'s Option A points here instead of inlining
these loops.

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
  ".github/idd/config.example.jsonc" \
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
  ".github/instructions/idd-orchestrator.instructions.md" \
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
  "docs/global-only-profile.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/issue-mediated-bootstrap.md" \
  "docs/onboarding/optional-host-setup.md" \
  "docs/onboarding/placeholders.md" \
  "docs/onboarding/policy-decisions.md" \
  "docs/onboarding/project-tuning.md" \
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

If the operator also opts into the `idd-spec-audit` companion, fetch its
canonical source files the same way, writing them to a separate selected
native destination:

<!-- audit:shell-list id=idd-spec-audit-companion-gh-api-loop -->

```sh
DEST="."  # root of the target repository
SKILL_DEST="${DEST}/.agents/skills/idd-spec-audit"  # Codex example; choose one native destination

mkdir -p "${SKILL_DEST}/references"

for FILE in \
  "SKILL.md" \
  "references/report-template.md"
do
  mkdir -p "$(dirname "${SKILL_DEST}/${FILE}")"
  gh api -H "Accept: application/vnd.github.raw+json" \
    "repos/kurone-kito/idd-skill/contents/skills/idd-spec-audit/${FILE}" \
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
  ".github/idd/config.example.jsonc" \
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
  ".github/instructions/idd-orchestrator.instructions.md" \
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
  "docs/global-only-profile.md" \
  "docs/reference.md" \
  "docs/onboarding/agent-entry-and-verification.md" \
  "docs/onboarding/issue-mediated-bootstrap.md" \
  "docs/onboarding/optional-host-setup.md" \
  "docs/onboarding/placeholders.md" \
  "docs/onboarding/policy-decisions.md" \
  "docs/onboarding/project-tuning.md" \
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

If the operator opts into the `idd-spec-audit` companion with `curl`, fetch
the same canonical source files to the selected native skill destination:

<!-- audit:shell-list id=idd-spec-audit-companion-curl-loop -->

```sh
BASE="https://raw.githubusercontent.com/kurone-kito/idd-skill/main/skills/idd-spec-audit"
DEST="."  # root of the target repository
SKILL_DEST="${DEST}/.agents/skills/idd-spec-audit"  # Codex example; choose one native destination

mkdir -p "${SKILL_DEST}/references"

for FILE in \
  "SKILL.md" \
  "references/report-template.md"
do
  mkdir -p "$(dirname "${SKILL_DEST}/${FILE}")"
  curl -fsSL "${BASE}/${FILE}" -o "${SKILL_DEST}/${FILE}" || { echo "Failed: ${FILE}" >&2; exit 1; }
done
```

For a new core file, ensure that both loops include the path after the
generated list is updated. The audit checks the shell lists against the
same generated block, so a path that appears in one loop but not the
other is treated as stale documentation.

For nested documentation such as `docs/onboarding/*.md`, the existing
loop body creates parent directories with `mkdir -p "$(dirname
"${DEST}/${FILE}")"`. No extra top-level `mkdir -p` entry is
required for each nested docs directory.

## Local-copy installs

Requires Node.js and a full clone. Without Node.js, use the remote-fetch
examples above. `idd-onboard.mjs --import` copies the generated core set,
not the whole tree (which contains optional workflows; observed
2026-10-23, issue `#4642`).

From the clone root, set `TARGET_REPO` to the adopter. Review the dry-run
plan first. For a target outside the source checkout, pass its path as
`--allow-root`; default apply refuses differing existing files and
blocking collisions:

```sh
# Run from the root of the cloned idd-skill checkout.
SOURCE_ROOT="$(pwd)"
TARGET_REPO="/absolute/path/to/adopter"

node scripts/idd-onboard.mjs --import --source "$SOURCE_ROOT" --target "$TARGET_REPO" --allow-root "$TARGET_REPO" --dry-run
node scripts/idd-onboard.mjs --import --source "$SOURCE_ROOT" --target "$TARGET_REPO" --allow-root "$TARGET_REPO"
```

Add `--profile vendored-node` to both commands for that selected
profile. Core import omits the optional
`idd-advisory-convergence.yml` and
`idd-advisory-convergence-comment.yml` workflows. To opt in, copy both
into `.github/workflows/` using [the host-workflow instructions](optional-host-setup.md#optional--host-idd-advisory-convergence-as-a-required-check-ci-workflow).
A maintainer must register the required check separately.

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

## Maintenance checklist

Before merging a distribution-surface change, verify:

- `audit/sync-manifest.json` includes every required new core file.
- the generated core file block in `idd-template/ONBOARDING.md` includes
  the new path.
- the `gh api` and `curl` loops in [Remote fetch examples](#remote-fetch-examples)
  above include the same path.
- optional `issue-authoring` and `idd-spec-audit` files remain in their
  respective optional companion lists.
- a new companion file is also added to that companion's matching
  `idd-template-readme-*-files` `paths` list
  (`idd-template-readme-issue-authoring-files` or
  `idd-template-readme-idd-spec-audit-files`; the `sourceGlobs`
  cross-check catches an omission, but only after running
  `node scripts/sync-docs.mjs --apply` to regenerate
  `idd-template/README.md`).
- `node scripts/sync-docs.mjs --apply` has run so `idd-template/README.md`'s
  generated file inventory reflects any new/removed/moved
  `idd-template/` path (its core half needs no manifest edit — a new
  `idd-template/**/*` path is picked up automatically).
- `node scripts/audit-docs.mjs --check` passes.
- the policy record names the selected companion destination for each
  optional companion bundle (`issue-authoring`, `idd-spec-audit`) that
  is installed. The canonical Step 1B / `idd-onboard --hear` policy
  templates (`hearing-catalog.json`, `policy-decisions.md`) currently
  define this field only for `issue-authoring`; until a follow-up
  extends them for `idd-spec-audit`, record its destination as
  free-form policy prose instead.
