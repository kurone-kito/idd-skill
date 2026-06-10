# Changelog

All notable changes to the distributed IDD workflow template are
documented in this file.

The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
version values follow the semantic-versioning intent described in
[Customizing IDD](docs/customization.md#template-version-and-staleness)
(`iddVersion` in `.github/idd/config.json`). Each released version
from 0.2.0 onward is also published as an annotated `v<iddVersion>`
git tag once its release pull request merges; 0.1.0 predates the tag
discipline and has no tag.

## [0.3.0] - 2026-06-11

Structural ack-only review-currency evidence release.

### Added

- Structural classification of post-disposition advisory-bot
  acknowledgements in the helper evidence layer: the activity snapshot
  and `pre-merge-readiness` emit `ackOnly` (configured bots, trust
  source, per-item list) and `effective` activity values, and the
  review-currency comparison proceeds with reason
  `ack-only-post-disposition` when the only newer activity is that
  evidence. The semantic residual stays with the agent, and the
  disposition-evidence and unreplied-comment gates are unchanged.
- Optional `advisoryBotLogins` policy field
  (`schemas/policy.schema.json`) plus the
  `--advisory-bot-logins` flag / `IDD_ADVISORY_BOT_LOGINS` environment
  ladder for `review-activity-snapshot` and `pre-merge-readiness`;
  absence keeps the classification disabled (fail-closed).
- Structural ack-only carve-out paragraphs in the F2 review-currency
  bullet, the F3 final-fetch list, and the advisory courtesy-ack
  convergence section of the distributed instructions.

### Changed

- `schemas/pre-merge-readiness.schema.json` now requires the `ackOnly`
  and `effective` evidence under `reviewCurrency.live`; validating
  output from older helper copies against the published schema fails
  until the helpers are re-synced.

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

[0.2.0]: https://github.com/kurone-kito/idd-skill/releases/tag/v0.2.0
[0.1.0]: https://github.com/kurone-kito/idd-skill/commit/f90a198f1750d674b9df452c35439806fb835dcd
