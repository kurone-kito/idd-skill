---
type: reference
title: Onboarding Reference — Agent Entry and Verification
description: Provides the detailed agent-entry examples and verification checklist referenced by ONBOARDING.md steps 5 and 6.
tags: [onboarding, agent-entry]
---

# Onboarding Reference — Agent Entry and Verification

Use this reference alongside
[`ONBOARDING.md`](https://github.com/kurone-kito/idd-skill/blob/v0.14.0/idd-template/ONBOARDING.md)
when you need the detailed agent-entry examples and expanded
verification guidance that the thin onboarding entry point now links
to.

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
- If the file is missing, create a minimal stub. When at least one
  existing file among `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, or an
  already-present `.github/copilot-instructions.md` already carries
  repository-specific guidance beyond the shared IDD workflow section,
  do not let the new stub drop it: add a short pointer in the new file
  to the existing file(s) that own that guidance, instead of copying
  the prose into every stub — several copies trade the
  asymmetry problem for a divergence problem the next edit will miss
  (observed 2026-07-27, kurone-kito/idd-skill#1717). Apply this the
  same way for `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md`; no runtime is
  a special case, and `.github/copilot-instructions.md` counts as a
  guidance source even though it isn't itself one of the three stubbed
  files. If guidance is already split across more than one existing
  file with different content, point the new stub at every file that
  owns part of it (or consolidate first) — a pointer to only one owner
  would repeat the same drop this rule exists to prevent. Where no
  existing file carries repository-specific guidance, the plain stub
  below remains correct.
- Only skip creating a missing root agent entry file when the operator
  explicitly opts out of adding new files.

**`excludeAgent` warning**: `idd-overview-core.instructions.md` sets
`excludeAgent: "code-review"` in its frontmatter, and that is correct
there — it keeps the review agent out of the IDD _execution_ protocol
files that only an implementing agent needs. If the target
repository's repository-specific engineering guidance instead lives in
its own `.github/instructions/*.instructions.md` constraint file, do
not cargo-cult that frontmatter onto it. `excludeAgent` belongs on IDD
protocol files, not on constraint files — copying it onto a constraint
file hides those rules from precisely the reviewer that most needs to
see them (preventive; no observed incident yet).

### Shared IDD workflow stub

All three root entry files should point agents to the same workflow
entry path. When a file does not exist yet, create it from this
minimal stub, adding one pointer line near the top per sibling file
that already carries repository-specific guidance — for example,
`See AGENTS.md for repository-specific rules.` — instead of copying
that guidance here:

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
`.github/instructions/idd-overview-core.instructions.md`. Open the routed
phase file manually when the current step changes.
```

When the file already exists, add just the `## IDD Workflow` section
above, adapted to the existing document's style, rather than the whole
stub.

### CLAUDE.md

If `CLAUDE.md` already exists, add the shared IDD workflow section
above and adapt the surrounding wording to the existing document style.

If `CLAUDE.md` does not exist, create it from the
[shared stub above](#shared-idd-workflow-stub), pointing to
`AGENTS.md`, `GEMINI.md`, or an existing
`.github/copilot-instructions.md` when one of them already carries
repository-specific guidance.

### AGENTS.md (for Codex CLI, OpenCode, Grok Build, and Cursor CLI)

`AGENTS.md` is the shared agents.md-standard entry file for Codex CLI,
OpenCode, Grok Build, and Cursor CLI: each auto-loads `AGENTS.md` from
the repository root natively, so this single file covers those
runtimes and neither OpenCode, Grok Build, nor Cursor CLI needs a
dedicated root file of its own. Do not create `GROK.md` or `CURSOR.md`.
`idd-doctor` still checks only `AGENTS.md`, `CLAUDE.md`, and
`GEMINI.md` — do not add a `GROK.md` or `CURSOR.md` check.

If `AGENTS.md` already exists, add the shared IDD workflow section and
keep the wording explicit that Codex CLI, OpenCode, Grok Build, and
Cursor CLI agents should manually open
`.github/instructions/idd-overview-core.instructions.md`
and the routed phase file before starting IDD work.

If `AGENTS.md` does not exist, create it from the
[shared stub above](#shared-idd-workflow-stub), pointing to
`CLAUDE.md`, `GEMINI.md`, or an existing
`.github/copilot-instructions.md` when one of them already carries
repository-specific guidance.

#### OpenCode: optional `opencode.json` recipe

OpenCode's native `AGENTS.md` auto-load already delivers the IDD
workflow stub above to every session; the steps below are an
**optional** Copilot-parity recipe, not a requirement.

- OpenCode's `opencode.json` `instructions` array can point at
  additional rule files, but every listed file loads
  **unconditionally** into every session — unlike GitHub Copilot's
  `applyTo` frontmatter, which OpenCode does not read (frontmatter in
  a loaded file is inert there). Skip this recipe for weak or local
  models (see
  [Weak-model guardrails](../idd-workflow.md#weak-model-guardrails)):
  the extra context can crowd out task-relevant content instead of
  helping.
- When an operator does opt in, list only the shared entry file, not
  the whole `.github/instructions/` directory, to approximate the
  Copilot `applyTo` scoping without flooding every session:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "instructions": [".github/instructions/idd-overview-core.instructions.md"]
  }
  ```

- If the operator installs the optional `issue-authoring` companion
  from Step 2 under one of the native roots OpenCode reads —
  `.claude/skills/`, `.opencode/skills/`, or `.agents/skills/` — it is
  already available without an additional copy. Keep the selected
  destination recorded in the onboarding policy; do not add the same skill
  ID to another root merely to support a second runtime (preventive; no
  observed incident yet).
- If a target repository runs OpenCode as an autonomous worker under
  its own GitHub identity (not just an interactive assistant), add
  that login to `trustedMarkerActors` (and the advisory-bot lists if
  it also reviews) in `.github/idd/config.json` — a config-values edit
  only; `schemas/policy.schema.json` stays agent-agnostic.

#### Grok Build: no extra root file

Grok Build auto-loads `AGENTS.md` (and `CLAUDE.md` when present). Do
not create `GROK.md`. It discovers the optional `issue-authoring`
companion under `.claude/skills/` the same way OpenCode does — do not
add a `.grok/skills/` install root.

If a target repository runs Grok Build as an autonomous worker under
its own GitHub identity (not just an interactive assistant), add that
login to `trustedMarkerActors` (and the advisory-bot lists if it also
reviews) in `.github/idd/config.json` — a config-values edit only;
`schemas/policy.schema.json` stays agent-agnostic.

#### Cursor CLI: no extra root file

Cursor CLI auto-loads `AGENTS.md` and always applies `CLAUDE.md` when
present. Operators follow the Cursor CLI `AGENTS.md` row in
[IDD workflow](../idd-workflow.md): automatically available IDD
context is `AGENTS.md` and `CLAUDE.md` when both exist; nothing from
`.github/instructions/`; open
`.github/instructions/idd-overview-core.instructions.md` and the
routed phase file manually. Keep Claude-only adapter bullets out of Cursor
policy. Do not create `CURSOR.md`.

It discovers the optional `issue-authoring` / `idd-spec-audit`
companions under `.claude/skills/` via Claude compatibility, the same
way OpenCode and Grok Build do — do not add a `.cursor/skills/` or
`.agents/skills/` install root merely to support Cursor (preventive;
no observed incident yet). Cursor does not merge
`.claude/settings.json`.

If a target repository runs Cursor CLI as an autonomous worker under
its own GitHub identity (not just an interactive assistant), add that
login to `trustedMarkerActors` (and the advisory-bot lists if it also
reviews) in `.github/idd/config.json` — a config-values edit only;
`schemas/policy.schema.json` stays agent-agnostic.

### Issue-authoring companion verification

When the optional companion is installed, verify the source-versus-
destination contract separately from the entry-file checks:

- The canonical source inventory remains `skills/issue-authoring/` in the
  idd-skill checkout and includes `SKILL.md` plus all bundled references.
- The selected target destination is recorded alongside the `installed`
  decision in the policy record. The Codex example is
  `.agents/skills/issue-authoring/SKILL.md`.
- The `gh api`, `curl`, and local-copy examples write every source file under
  that selected destination and do not fall back to target
  `skills/issue-authoring/`.
- A default onboarding import adds no checked-in `.agents/skills/`,
  `.opencode/skills/`, or `.cursor/skills/` mirror. A mixed-runtime
  target uses one native copy plus an explicit manual route unless the
  operator deliberately accepts identical duplicates (preventive; no
  observed incident yet).

### GEMINI.md

If `GEMINI.md` already exists, apply the same IDD workflow section as
`AGENTS.md`, adapted to the Antigravity CLI (formerly Gemini CLI)
wording and still pointing to `docs/idd-workflow.md`.

If `GEMINI.md` does not exist, create it from the
[shared stub above](#shared-idd-workflow-stub), pointing to
`CLAUDE.md`, `AGENTS.md`, or an existing
`.github/copilot-instructions.md` when one of them already carries
repository-specific guidance.

### .github/copilot-instructions.md (if present)

If `.github/copilot-instructions.md` already exists, add a parallel IDD
workflow section there as well so GitHub Copilot execution surfaces
receive the same entry path. Keep the
`excludeAgent: "code-review"` behavior in
`.github/instructions/idd-overview-core.instructions.md`; repository-wide
Copilot guidance may still apply during review.

If `.github/copilot-instructions.md` carries repository-specific
guidance that none of `CLAUDE.md`, `AGENTS.md`, or `GEMINI.md` already
has, it is a guidance source for the carry-over rule above too: point
each newly created stub at it the same way a stub would point at a
sibling entry file.

## Verification details

Use the Step 6 checklist in
[`ONBOARDING.md`](https://github.com/kurone-kito/idd-skill/blob/v0.14.0/idd-template/ONBOARDING.md)
as the final go/no-go gate. When you need the concrete evidence behind
those shorter checks, confirm the detailed items below.

### Imported files and profile artifacts

- [ ] Every `idd-*.instructions.md` file listed in the generated core
      file list is present in `.github/instructions/`.
- [ ] `docs/getting-started.md`, `docs/concepts.md`,
      `docs/customization.md`, `docs/reference.md`,
      `docs/policy-constants.md`, `docs/idd-workflow.md`,
      `docs/idd-review-policy-profiles.md`,
      `docs/idd-helper-scripts.md`,
      `docs/idd-comment-minimization.md`,
      `docs/idd-resume-detail.md`,
      `docs/idd-advisory-wait-shell-fallback.md`,
      `docs/idd-design-rationale.md`, and `docs/permissions.md`
      are present.
- [ ] `profiles/README.md` and the non-default profile artifacts under
      `profiles/` are present.

### Verifying a re-import commit

For an adopter that imported the template from a local `idd-skill` clone,
run `verify-import-mirror` against the mirror-only commit made after the
copy and before placeholder substitution. The upstream path must be the
clone's `idd-template/` directory: using the repository root compares
template paths such as `docs/idd-workflow.md` with source-repository paths
and produces false mismatches (observed in
[kurone-kito/idd-skill#3216](https://github.com/kurone-kito/idd-skill/issues/3216)).
Keep that clone clean and checked out at the exact upstream commit that
supplied the mirror-only import; the helper reads the current files under
`--upstream-path`, so a later working tree can produce false mismatches or
falsely pass matching local edits.

`idd-onboard --import` may restore four command rows of
`.github/idd/config.json`: keep the file in scope and repeat
`--normalize-json-key` for only those four keys, as in the
`verify-import-mirror` bullet of `docs/idd-helper-scripts.md` ("Helper contract
classes").

The helper is not an `idd-*` bin. Invoke it directly from a source checkout
with one `--path-prefix` per touched imported root or root-level file. The
example includes the template core files `.cspell.config.yml`,
`.markdownlint.yml`, and `.markdownlint-cli2.yaml`; remove any untouched
prefix because it produces no comparison. Set `<target-base-ref>` to the
pre-import commit; for a root mirror-only commit, use
`git -C <target-repo> hash-object -t tree /dev/null` as the base:

```sh
node <idd-skill>/scripts/verify-import-mirror.mjs \
  --target-root <target-repo> --target-ref <mirror-only-commit> \
  --target-base-ref <target-base-ref> \
  --upstream-path <idd-skill>/idd-template \
  --path-prefix .github/instructions --path-prefix .github/workflows \
  --path-prefix .github/idd/config.json \
  --normalize-json-key .github/idd/config.json:commands.install-deps \
  --normalize-json-key .github/idd/config.json:commands.fix-validate \
  --normalize-json-key .github/idd/config.json:commands.pre-push-validate \
  --normalize-json-key .github/idd/config.json:commands.post-fix-validate \
  --path-prefix docs --path-prefix profiles \
  --path-prefix .githooks \
  --path-prefix .cspell.config.yml --path-prefix .markdownlint.yml \
  --path-prefix .markdownlint-cli2.yaml
```

On native Windows omit `.githooks` unless the command runs under WSL; the
`docs/idd-helper-scripts.md` bullet gives the mode check and its
`core.fileMode` precondition.

A `package-manager` adopter with a `node_modules` linker and no source
checkout uses `node_modules/@kurone-kito/idd-skill` in place of `<idd-skill>`,
pinned to the import revision, never mutable `main`; PnP, `ephemeral-npx` and
`vendored-node` use a source checkout (that bullet gives the rest).

When the target uses the `vendored-node` profile, run a separate check for
helper and schema paths against the checkout root, using only the prefixes
present in that target commit:

```sh
node <idd-skill>/scripts/verify-import-mirror.mjs \
  --target-root <target-repo> --target-ref <mirror-only-commit> \
  --target-base-ref <target-base-ref> \
  --upstream-path <idd-skill> \
  --path-prefix scripts \
  --path-prefix schemas --path-prefix fixtures
```

Keep `--target-ref` on the mirror-only commit. After substitution, run
`idd-onboard --verify`; its manifest check covers unchanged paths. Placeholder
rewrites, pinned actions, and GHES-generated
`.github/workflows/strip-untrusted-labels.yml` are intentional; selected
mirror-path content or mode mismatches fail.

### Re-import with an overlay report

kurone-kito/setup.ubuntu#201 (2026-10-05): a forced re-import erased overlays
and its mirror check passed. Order:

1. Record pre-import ref, old upstream tag/commit and upstream target commit
   in policy record; classify each retained difference by the target-side rule
   in `idd-helper-scripts.md`. Check out a clean worktree: the
   `--upstream-base-path` source.
2. On a fresh branch run `idd-onboard --import --force` (Step 2; same
   `--profile`; `--allow-root` if `--source` is outside cwd) and one
   `--hold <path>` per path you own or exclude (default
   `.github/idd/config.json`, hand-merged workflows): exact manifest path, an
   unknown path exits 2, repeat on `idd-onboard --verify`; hold each excluded
   lite path. Hold also a same-named file of yours the old
   template lacked (the import overwrites it whole, unlisted). For paths only
   the old tag has (compare `plan[].targetPath` of old/new dry-runs via
   `--import --dry-run --force --source <root>`, no holds), check diff
   against pre-import ref before `git rm` so overlays are kept. Commit mirror
   alone, before `--substitute`; verify as above.
3. Re-verify with `--upstream-base-path <old idd-template>` and
   `--report-reverted-overlays`: lines you added that import erased (held
   paths are not in diff).
4. Re-apply real overlays in overlay commits or accept gaps; `--substitute`;
   rerun report with `--target-ref HEAD`, same base (exit 1 is expected).
   Lines still listed are deliberate drops: record them.
5. Open PR with commits separate; name upstream-identical paths so findings on
   them go upstream.
6. Option: with mirror-only commit per import, merge vendor branch. Held files
   stay old, substituted values conflict with raw tokens on edited token lines,
   and missing deletion (`--import` never deletes) plus need for `--force`
   carry over (on a pure mirror branch `--force` cannot erase overlays).

Report limits: helper doc's `verify-import-mirror` bullet; deleted, held,
JSON paths are skipped, so diff them and `.github/idd/config.json` against
pre-import ref. Lite files are inert unless pointed at ("Recorded convention,
not yet wired", `docs/idd-workflow.md`): without lite tier, hold them out.

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
      `package-manager`, `vendored-node`, `ephemeral-npx`, or `user-global`.
- [ ] If the operator opted into issue authoring, the native destination
      recorded in the policy contains `SKILL.md` and every bundled reference
      file.

### Placeholder, marker, and config alignment

- [ ] No `{{...}}` placeholders remain in any copied file.
- [ ] `.github/instructions/idd-overview-core.instructions.md` has
      `applyTo: "**"` and `excludeAgent: "code-review"` in its
      frontmatter.
- [ ] The `Project commands` table in
      `.github/instructions/idd-overview-core.instructions.md`
      contains the correct commands for this project.
- [ ] If the project chooses `issue-scope: orphan-first`, the
      `orphan-first-policy` value is recorded as `none`,
      `maintainer-approved`, or `public-disabled`. Public repositories
      use either `maintainer-approved` or `public-disabled`, not `none`.
- [ ] The `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
      `{{PROJECT_MARKER_PREFIX}}-blocked-by` marker names in
      `.github/instructions/idd-discover.instructions.md` and
      `.github/instructions/idd-overview-core.instructions.md`
      match the prefix chosen for this project.
- [ ] If `.github/idd/config.json` is used, it matches the recorded
      `iddVersion`, marker prefix, merge/review/thread policies,
      claim timing values, CI wait values, `trustedMarkerActors`, and
      command values.

### Agent entry files

- [ ] `CLAUDE.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] `AGENTS.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it; this single
      file covers Codex CLI, OpenCode, Grok Build, and Cursor CLI.
      Operators must not create `CURSOR.md`.
- [ ] `GEMINI.md` exists and references `docs/idd-workflow.md`, unless
      the operator explicitly opted out of creating it.
- [ ] Among the entry files the operator did not opt out of creating,
      `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` agree on
      repository-specific engineering guidance: each file either
      carries that guidance directly, or points to the file(s) that
      own it (a sibling entry file, an existing
      `.github/copilot-instructions.md`, or more than one when
      guidance is split) — no entry file silently drops guidance
      another existing file already carries (observed 2026-07-27,
      kurone-kito/idd-skill#1717).
- [ ] If `.github/copilot-instructions.md` existed before onboarding,
      it now includes the IDD workflow reference as well.
- [ ] If the operator opted into the optional `opencode.json`
      Copilot-parity recipe, the target repository's `opencode.json`
      lists only
      `.github/instructions/idd-overview-core.instructions.md`.
- [ ] If the operator did not opt into that recipe, no `opencode.json`
      file was added to the target repository as part of onboarding.
