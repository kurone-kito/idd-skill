# Changelog

All notable changes to the distributed IDD workflow template are
documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version values follow the semantic-versioning intent described in
[Customizing IDD](docs/customization.md#template-version-and-staleness)
(`iddVersion` in `.github/idd/config.json`). Each released version is
also published as an annotated `v<iddVersion>` git tag.

## [0.2.0] - 2026-06-07

Worktree-guard enforcement release.

### Added

- Opt-in mechanical enforcement of the B1 sibling-worktree contract:
  `idd-doctor --strict` CI gate plus a `core.hooksPath`-based
  pre-commit guard, with adopter opt-in (`worktreeGuard.enabled`) and
  dogfooding enabled in this repository.
- Stale-import detector in `idd-doctor` that warns when imported
  instruction files lack the current worktree-hardening sections.
- `iddVersion` bump rule documented in
  [Customizing IDD](docs/customization.md#template-version-and-staleness).
- `scripts/branch-conflict-state.mjs` read-only branch conflict and
  synchronization state classifier for D/E/F routing.
- `scripts/external-check-waiver.mjs` maintainer dry-run/apply facade
  for canonical external-check waiver comments.

### Changed

- `iddVersion` bumped from `0.1.0` to `0.2.0` across the shipped and
  template policy configs.

## [0.1.0] - 2026-05-07

Initial release of the distributed IDD workflow template
(retroactive entry).

### Added

- The portable `idd-template/` package: phase instruction files
  (Discover → Claim → Work → PR → Review → Merge), policy schema,
  onboarding guide, and review-policy profiles.
- Optional helper scripts for evidence collection (claim routing,
  review snapshots, advisory wait, pre-merge readiness, cleanup).
- The issue-authoring skill bundle and workflow documentation.
