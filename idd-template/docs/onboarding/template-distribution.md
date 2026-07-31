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

## Distribution surfaces

The template has three distribution surfaces:

1. **Core template files** copied from `idd-template/` into the adopter
   repository. These include `.github/idd/`, `.github/instructions/`,
   `docs/`, and `profiles/`.
2. **Optional issue-authoring companion files** copied from
   `skills/issue-authoring/` only when the operator explicitly opts into
   pre-execution issue drafting.
3. **Local-copy installs** where an agent copies the full
   `idd-template/` directory from a cloned `idd-skill` checkout instead
   of fetching individual files.

`idd-template/ONBOARDING.md` keeps the executable import snippets for
the first two surfaces so a raw-URL onboarding run can still complete
without opening this reference first.

## Generated file lists

The authoritative generated lists are configured in
`audit/sync-manifest.json`:

- `generatedBlocks[].id == "idd-template-core-files"` owns the core
  template file list.
- `generatedBlocks[].id == "issue-authoring-companion-files"` owns the
  optional issue-authoring companion list.
- `shellFileLists` ties each generated list to the `gh api` and `curl`
  loops in `idd-template/ONBOARDING.md`.

When adding a core template file, update both `sourceGlobs` and `paths`
for `idd-template-core-files` when the new path is not already covered.
The docs audit compares those entries with the repository files and
fails if the generated block or shell loops are stale.

When adding an optional issue-authoring companion file, update the
`issue-authoring-companion-files` block instead. Do not put optional
companion files in the core template list unless the execution loop
requires every adopter to receive them.

## Profile-conditional helper files (`vendored-node`)

`scripts/minimize-superseded-markers.mjs` (mirrored to
`idd-template/scripts/minimize-superseded-markers.mjs` by the
`minimize-superseded-markers-helper` syncPair) is invoked from four
template instruction files, but it is deliberately **not** part of the
`idd-template-core-files` block or Option A's remote-fetch loops, even
though every other file those four instruction files reference is core.
This is intentional, not an oversight:

- `idd-onboard.mjs`'s `resolveImportFiles` hard-fails with a "manifest
  drift: duplicate target path" error if a file's target path appears in
  both the always-shipped core set and the `vendored-node`
  profile-conditional helper bundle (`collectVendoredFiles` in
  `helper-runtime-manifest.mts`, which already vendors this file for
  that profile). The core set and the profile-conditional bundle must
  stay disjoint by construction.
- Putting it in the core set would also make `buildSwitchPlan` (used to
  compute add/remove diffs when an adopter switches profiles) list it
  under `removeFiles` on a `vendored-node` → non-`vendored-node` switch,
  deleting a file the adopter still needs — a real data-loss hazard, not
  just a manifest-consistency one.
- Every instruction-file call site degrades gracefully ("Skip entirely
  if … the helper is unavailable"), so the practical effect of the
  exclusion is bounded capability on some install paths, not breakage.

**What this means for adopters**: the `vendored-node` profile's helper
bundle — including this file — ships only through Option B (local copy),
or through `node scripts/idd-onboard.mjs --import --profile
vendored-node`, which requires `--source <path-to-a-cloned-idd-skill-tree>`
(see [CLI-assisted onboarding](../../ONBOARDING.md#cli-assisted-onboarding)).
Neither path is available to a pure Option A remote-fetch install with no
local clone. An Option A adopter who selected the `vendored-node` profile
and wants this helper without cloning the repository can fetch the single
file directly, the same way Option A fetches every other file:

```sh
curl -fsSL \
  "https://raw.githubusercontent.com/kurone-kito/idd-skill/main/idd-template/scripts/minimize-superseded-markers.mjs" \
  -o scripts/minimize-superseded-markers.mjs
```

If a future change makes this helper (or another `vendored-node`
helper) a genuine cross-profile core dependency, resolve the
core/profile-conditional overlap in `idd-onboard.mts` and
`helper-runtime-manifest.mts` first — do not add it to
`idd-template-core-files` while the disjointness invariant above still
holds; `checkGeneratedBlocks`/`resolveImportFiles` will not catch the
resulting drift by themselves, so this needs a maintainer decision.

## Remote fetch examples

The `gh api` and `curl` loops in `idd-template/ONBOARDING.md` intentionally
list every file instead of fetching directories. This keeps raw-content
imports deterministic and makes missing files visible during onboarding.

For a new core file, ensure that both loops include the path after the
generated list is updated. The audit checks the shell lists against the
same generated block, so a path that appears in one loop but not the
other is treated as stale documentation.

For nested documentation such as `docs/onboarding/*.md`, the existing
loop body creates parent directories with `mkdir -p "$(dirname
"${DEST}/${FILE}")"`. No extra top-level `mkdir -p` entry is required
for each nested docs directory.

## Local-copy installs

The local-copy path is intentionally broader than the remote-fetch path:
copy the contents of `idd-template/` while preserving relative paths.
That means new core files under `idd-template/` are automatically covered
by local-copy installs after they are committed.

Keep the local-copy prose in `idd-template/ONBOARDING.md` short. Use this
reference for maintenance details and the generated remote-fetch snippets
for exact file coverage.

## Maintenance checklist

Before merging a distribution-surface change, verify:

- `audit/sync-manifest.json` includes every required new core file.
- the generated core file block in `idd-template/ONBOARDING.md` includes
  the new path.
- the `gh api` and `curl` loops in `idd-template/ONBOARDING.md` include
  the same path.
- optional issue-authoring files remain in the optional companion list.
- `idd-template/README.md` mentions the new reference page when it is
  part of the exported template documentation set.
- `node scripts/audit-docs.mjs --check` passes.
