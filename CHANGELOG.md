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

## [0.4.0] - 2026-07-04

TypeScript helper toolchain, autopilot-discovery, and merge-gate
hardening release. From this release on, the cadence is
milestone-based: a release is cut after each merged roadmap.

### Added

- TypeScript helper toolchain: every helper script now builds from a
  typed `.mts` source into a committed, generated `.mjs` artifact
  (`pnpm run build`), with a `build:check` drift gate, schema-to-type
  reconciliation tests, type-suppression budget guards, an
  auto-maintained `.gitattributes` generated block, and generated-from
  banners on generated instruction files; the test suite moved to
  typed `.mts` as well (run natively, never emitted).
- Write-side merge-flow helpers that render and post the canonical
  bodies through the reliable JSON path: `idd-merge-execute` (F3 gate
  plus merge commit bound to the validated head), `post-idd-marker`
  (claim/unclaim/watermark/baseline/advisory markers, including a
  one-step watermark derived from the live snapshot and pinned to the
  E1 head), `resolve-review-thread` (E13 reply-and-resolve),
  `idd-roadmap-audit-execute` (A1.5 completion audit and close), and
  auto-disposition helpers for advisory non-review notices and the
  CodeRabbit summary walkthrough.
- Autopilot discovery upgrades: a cross-roadmap ranked-union mode with
  opt-in claim-state, readiness, and startable annotations on
  `discover-roadmap-graph`; a mechanical A5 fresh-claim gate; a B2
  supersession re-check before implementation; an A0-O orphan fallback
  on A4 viability/claim exhaustion; and softer selection controls —
  author-recorded effort hints, concurrent-selection desync,
  high-contention shared-file overlap advisories, and a
  `--swarm-floor` eligibility sweep.
- Advisory review generalization: the advisory-wait protocol now names
  a configurable primary advisory bot, can request a secondary
  advisory bot once per head, carries non-review-notice dispositions
  across head changes, and surfaces the `ack-only-post-disposition`
  override signal in the merge gate.
- New repository guards: `idd-doctor` warnings for config-to-prose
  policy drift, an inert worktree guard, main drifting far from the
  latest release tag, and node_modules/lockfile version drift; a
  scheduled fresh-install typecheck workflow; a CI workflow hygiene
  pass (job timeouts, stale concurrency); an install-deps
  verify-and-retry wrapper for under-installed worktrees; and a CI
  strip of CodeRabbit-applied reserved IDD labels.
- Adopter label configurability: the `labels.*` policy namespace with
  helper support and instruction references.
- Onboarding automation wave 1: the `idd-onboard`
  placeholder-substitution CLI with `--dry-run`, site-aware JSON
  escaping, and fail-closed apply.
- Smaller evidence helpers: `branch-name` (canonical issue branch
  slug), `emit-marker` (per-cycle marker bodies), and
  `merged-pr-feedback-sweep` (read-only post-merge feedback detector).

### Changed

- Instruction-set hardening across the phase files: a D1 no-op-rebase
  skip and detached-HEAD recovery, watermark-after-CI ordering with
  refreshes after dispositions, a copy-paste-safe F3 head-SHA gate
  checklist, a CI/advisory wake-up discipline, the
  one-issue-per-session operating model with F4/F5 as the safe exit
  boundary, E9 fix-side convergence rules, an ask-first gate for
  dependency and CI-workflow changes, and a strict-resume versus
  lenient-merge forced-handoff split.
- Documentation footprint governance: bundle byte budgets are
  de-hardcoded and guarded against the sync manifest, with recovered
  headroom on the review and work bundles.
- `pre-merge-readiness` now emits a ready/blockers rollup, requires
  `waiverEvidence`, and records `trustedMarkerActors` provenance.
- `discover-roadmap-graph` traversal parallelizes its I/O and narrows
  `--all-roadmaps` root discovery with server-side search.
- Helper internals consolidated: shared `gh-exec` / config-loader
  modules, marker helpers carved out of `protocol-helpers`, CLI bodies
  guarded behind `isCliExecution()` so imports are side-effect free,
  and the test suites consolidated onto a shared typed test-utility
  module.
- Issue-authoring skill hardening: codebase-fidelity pre-publish
  guards with a deliberate-divergence check, a required
  autopilot-suitability footer in the draft schemas, `Blocked by`
  encoding on finalize-track siblings, and close-not-delete draft
  recovery.

### Fixed

- Merge-gate correctness: resolved AMD-rejection threads and
  out-of-snapshot threads are recognized, disposition markers pair 1:1
  with items, trusted-actor dispositions satisfy the
  unreplied-comments gate, write-side helpers honor forced handoff,
  `fully_autonomous_merge` reaches its handoff step without an active
  claim, and asynchronous mergeability is classified as computing
  rather than a terminal unknown.
- Claim-phase races: A5 same-second tie-break and refs/heads
  normalization, an A0-T race loss stops instead of silently falling
  back to Discover, forced-handoff evidence must be PR-scoped for
  PR-backed claims, and competing-claim searches baseline on the
  original claim.
- Discovery and triage read the right signals: gh lookup errors fail
  closed instead of masquerading as missing issues, code-quoted marker
  and reference text is ignored, every same-line blocked-by reference
  is captured, authoring labels match case-insensitively, the
  protocol-mandated `Refs` provenance breadcrumbs from closed leaves
  are no longer misclassified as blocking cycles, and
  suitability-triage pattern-matching precision was tightened twice.
- An `idd-doctor` robustness cluster (workshop back-link scanning,
  CRLF/null-safe worktree parsing, overview-table resolution,
  suitability-floor contradiction checks) and assorted helper
  hardening (fail-closed forced-handoff authorization, allowed gh
  HTTP statuses yielding empty results, waiver-marker matching and
  consume-side gating).

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
