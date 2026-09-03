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

## [Unreleased]

## [0.8.0] - 2026-09-04

Outage-resilience release: sustain the IDD loop while the Copilot
advisory review is rate-limited, plus orphan hardening that keeps
review quality sound without the primary advisory bot.

### Added

- Provider-health classification that distinguishes advisory-review
  and GitHub Actions service degradation from a real CI or review
  failure, so the loop can park, reroute, or wait instead of treating
  an outage as a code defect.
- Outage-scoped advisory relief declaration: a repository-level
  declaration that removes the per-pull-request waiver-authoring cost
  during a declared provider outage, without bypassing the
  per-pull-request terminal advisory-unavailable state.
- Outage-park: park and reroute work that is blocked only by an
  unavailable service, then resume when the service recovers.
- Local validation evidence that a session can record when GitHub
  Actions is unavailable, so merge-readiness is not solely hosted-CI
  dependent during an outage.
- Advisory-wait terminal state when a review request never registers,
  plus a configurable Copilot-review poll ceiling so a hung request
  cannot block forever.
- Opt-in secondary-bot quiet window before advisory convergence,
  later conditioned on whether that bot has already posted a genuine
  current-HEAD review, and handling for a secondary bot that declines
  to review.
- The advisory-convergence comment workflow also refreshes the
  required HEAD check when an IDD-originated regular PR comment
  lands, not only on inline review-thread replies.
- `critiqueLoop.delegate.mode` gains `on-success` and `never`,
  completing the answer to "when does the per-agent critique pass also
  run": always (`combined`), only on delegate failure (`fallback`, the
  unchanged default), only on delegate success (`on-success`), or not
  at all (`never`). `on-success` suits a reviewer whose non-zero exit
  means _findings exist_ rather than _the tool broke_. Under the two
  new values a failed delegate can leave C1 with no findings, so C1
  records a fail-closed hold instead of a clean zero-issues verdict.
  Both existing values keep their current name and meaning. A
  user-global delegate default can now be inherited, the critique
  lenses reach lite and configured-delegate passes, and lite helpers
  can read the effective critique-delegate resolution.
- Clone-scoped lock that serializes `git fetch`, `git worktree add`,
  and `git worktree remove` against a shared primary clone under
  concurrent sessions.
- Configured `developmentBranch` as a first-class branch-flow setting:
  onboarding, helpers, and workflows target that branch instead of
  hard-coding `main`.
- Provider-adapter contract and staged non-GitHub adoption docs as a
  foundation for future adapters (GitHub remains the only shipped
  provider), including a CODEOWNERS port for the adapter path.
- Discover: an explicit non-blocking reference form alongside
  `Blocked by`; milestone-scope ranking; a prose
  runtime/production-observation precondition filter; a
  machine-readable A4.5 triage-verdict skip for previously rejected
  candidates; autonomous close of high-confidence duplicates; and
  `--swarm-floor` readiness for "is any startable work left?".
- Structured onboarding hearing with a hear-propose-apply TTY flow,
  transcript apply, Linguist `generated=true` for imported instruction
  files, and a thinner default onboarding path.
- Issue-authoring now actually emits the `## Candidate files` section
  on roadmap-child drafts so Discover's shared-file overlap check has
  something to parse.

### Changed

- **BREAKING**: the distributed merge-policy default flips from
  `fully_autonomous_merge` to `human_merge`. An unrecorded merge policy
  and a fresh template `.github/idd/config.json` no longer grant F3
  merge authority to a worker session — both now stop at the F2.5
  handoff gate for a human maintainer. A repository that already
  recorded `fully_autonomous_merge` explicitly is unaffected.
  `idd-doctor` now warns when `fully_autonomous_merge` is recorded
  without `mergePolicyAck`.
- Context-ceiling budget raised from 126,000 to 196,000 bytes
  (`maxBundleLimitBytes` and the bundles sitting against the previous
  ceiling).
- GitHub Actions consumption cut for the shipped workflows, with an
  adopter billing-exposure note.
- Both advisory-wait waiver clocks are per-HEAD and restart on every
  push; waiting is only viable after review has converged on the
  current HEAD.
- Template apply is profile-conditional and no longer ships a literal
  helper-runtime profile value.
- D2 change-class scoping extended so a docs-only or generated-mirror
  change is classified before the heavier pre-push command set.
- `audit-pr-cleanup` can process multiple PRs in one invocation.
- Extensive instruction, policy-constants, helper-contract, and
  issue-authoring documentation precision: gist-feedback instruction
  gaps, WorkTrunk cwd-after-create diagnostic, grooming pass, hold-
  state and branch-state taxonomies, external-signal entry, F4
  `unclaimed-by` requirement, B3 retroactive-disclosure as a repair
  path, and related docs-only work.

### Fixed

- Advisory-convergence stops reruns that cannot change the verdict,
  treats bot check-run status as liveness-only, and refuses a waiver
  the gate cannot honor yet.
- Suitability-triage: trust-safety narrowing, autonomy-check
  broadening, policy-override handling, proximity gate, and
  outcome-signal inflections.
- Claim A5(e) branch-collision detection, marker-parsing residual
  cases, `post-idd-marker` post-write verification, CLI required-flag
  marking, and leading `--` stripping on custom flags.
- Discover viability-gate limited-scope / bare-topic false positives,
  and `Blocked by` references that wrap across a line.
- F4 cleanup reorder, post-merge duplicate-evidence skip, `idd-doctor`
  GHES-host support and toolchain-residue narrowing, and B1
  WorkTrunk cwd self-check after create.
- `pre-merge-readiness` resolves every policy gate from a trusted
  ref rather than the PR worktree's own possibly-edited config.
- Helper and template edge cases: split `--owner`/`--repo` on five
  scripts, template shell resolvers ignoring a full-path helper
  runtime, `workflow_dispatch` getting its own concurrency group, a
  B3 generated-from banner check, and a warning for self-regenerating
  follow-up chains.

## [0.7.0] - 2026-08-20

Issue-mediated onboarding bootstrap, orchestrator-delegation and
advisory-convergence hardening, and suitability-triage false-positive
closures release.

### Added

- Issue-mediated bootstrap: an alternate onboarding path that drafts a
  welcome issue after the bootstrap PR merges instead of requiring a
  live interactive hearing, with its own execution-mode tracking
  through Steps 1B/2/6, a Step 0 `gh` CLI prerequisite check, and a
  gated welcome-issue prompt that checks actual companion state before
  firing.
- `critiqueLoop.delegate`: an optional policy field letting a
  repository point the C1 self-review pass at a configured external
  command (for example a local CLI reviewer) instead of the hardcoded
  per-agent critique table, with a `fallback`/`combined` mode and
  validation against whitespace/unknown-key configs.
- `authoringLanguage` policy field: drafted issue and PR body prose
  follows a configured BCP-47 tag or the operator's live conversational
  language, applied consistently by issue-authoring and PR-submit.
- Prefix-aware review-reply identity stamp
  (`<!-- {markerPrefix}-review-reply -->`) for IDD-originated E6/E13
  replies, with helper injection and a shared recognizer, alongside
  the present-tense hybrid review-reply identity contract: unmarked
  human replies on human threads are presence-only, Copilot threads
  still need an IDD disposition, and the required
  `idd-advisory-convergence` job is not created by unmarked human
  review chatter.
- `advisory-convergence` verdicts carry structured `nextActions`
  diagnostics, printed on assert failure, and a disposition-aware
  review-ack marker.
- `suitability-triage --body-file`/`--stdin`: a local, offline dry-run
  mode that runs six of the seven A4.5 checks against a drafted issue's
  text before publication, without a live search index.
- `pre-merge-readiness --claimless` for PRs with no
  `closingIssuesReferences`: skips claim fetch/revalidation and reports
  the not-applicable/unclaimed ownership shape; combining the flag with
  `--claim-issue`/`--claim-id` is rejected, and a PR that still closes
  an issue fails closed.
- `ci-wait-policy` derives `--rerun-count` from `run_attempt` via a new
  `--run-id` input, and one evidence-gated extra rerun is allowed after
  the `rerun-once` budget is spent.
- `audit-docs` guards `bin/*.mjs` executable mode against drift, and
  `consistency`'s mirror guard supports an N-clause `engines.node`
  range.
- The shipped `idd-advisory-convergence.yml` workflow's CI runner is
  overridable via a `runner` input (`workflow_call`/`workflow_dispatch`)
  or the `CI_RUNNER_LABEL` repository variable, defaulting to
  `ubuntu-slim`.

### Changed

- Orchestrator fan-out delegation hardened: a delegation brief must
  state the delegate's sole-worker role explicitly when the delegate
  inherits the orchestrator's full conversation context (closing an
  observed context-inheritance confusion), and must carry the
  CI/advisory-wait wake-up-discipline topology-safety condition so a
  worker never assumes an unconfirmed background wait resumes its own
  turn. Claim approval also falls back to a live issue
  `author_association` of `OWNER`/`MEMBER` when the collaborator
  permission API returns 5xx, and the claim-lock helper documents the
  already-claimed-by-self takeover case.
- `advisory-convergence` honors `reviewPolicy` (`human-required`/
  `no-advisory` make the check `not_applicable`), no longer runs on
  `pull_request_review_comment` so ordinary human review chatter can't
  create or cancel the required check, requires full thread coverage
  of `itemCount`, validates the review-ack embedded timestamp and
  reroll eligibility, widens its GraphQL reviewer page, and
  `rerun-advisory-convergence --check-name` can override the check
  search.
- Suitability-triage hardening: excludes hyphenated-token matches from
  Check 7's subjective-approval patterns (`needs-decision`,
  `blocked-by-human`, and similar no longer self-trip the gate),
  closes several Check 3 negation-bypass and unsafe-directive-verb
  gaps, skips markdown-wrapped noun-clause gerunds and abbreviation
  periods inside the directive window, and masks Markdown code
  regions.
- `discover-roadmap-graph`'s dependency-negation detection closes
  several review-found gaps (a residual quadratic re-scan path,
  not-only negation generalization, negated keyword mentions
  incorrectly treated as edges) and no longer re-scans quadratically.
- `idd-doctor` governance reads honor GitHub Rulesets and
  `trustEmptyProtectionReads`, pin an explicit `--hostname` for the
  target repository (including GHES), and recognize a chained
  hook-manager setup as wired; `worktree-guard` detects CRLF-broken
  hooks without overclaiming active blocking for inert ones, and cuts
  common-path forks for a documented Windows-risk performance gain.
- F4 merge/cleanup hardened: worktree cleanup inspection and submodule
  ref checks are bounded and re-scoped to the target worktree,
  `audit-pr-cleanup` retries `--apply` internally until convergence
  with backoff and surfaces retry fields in its table output, and
  bundle-merge's byte-budget headroom was widened twice after a second
  ceiling breach.
- CLI/helper error handling hardened: shaped CLI errors print instead
  of a raw stack trace, `run-helper` streams subprocess stderr live via
  a temp file instead of a pipe, the ambiguous `--token` GitHub-auth
  flag was renamed to `--gh-token` (`--token` kept one release as a
  deprecated alias), and a declared flag's own alias is reserved before
  disambiguation so a pnpm-forwarded leading `--` is stripped correctly.
- `engines.node` bumped to `^22.23.2 || ^24.2.0 || >=26.0.0`: the 22.x
  floor moves to the 2026-07-29 emergency security release (fixes 11
  CVEs including the CVE-2026-56846/CVE-2026-56848 HTTP/2
  header-memory issues and the CVE-2026-58043 Permission Model
  over-grant), the previously-unbounded `>=24.2.0` tail is now capped
  below the already-end-of-life 25.x line, and a new `>=26.0.0` clause
  opens the new Current line (enters Active LTS 2026-10-28); the 24.x
  floor itself is unchanged (still feature-motivated by
  `import.meta.main`).
- Context-ceiling budget management: `bundle-review`'s `limitBytes` was
  raised from 120,000 to 126,000 (and `maxBundleLimitBytes` raised to
  match), the other seven bundles sitting in the 95%+ notice band were
  raised too, `bundle-discovery`'s own limit was widened after a second
  ceiling breach, and this source repository's own
  `idd-advisory-convergence` maintainer-waiver deadline was shortened
  to `PT9H` to fit its higher-concurrency dogfooding setup.
- Adopted the shared `@kurone-kito/markdownlint-config` and
  `@kurone-kito/cspell-config` packages as the lint/spell-check base,
  keeping `idd-template`'s own cspell config self-contained.
- Extensive onboarding and customization-doc precision fixes: hook-
  manager/`shellEmulator` coexistence gaps closed, resync
  baseline-diff correctness improved (token-filter binding, forward
  rather than reverse tree comparison, dropped an unreliable
  content-match fallback), `blockedOverwrites` qualified for a
  `--force` import, `GH_TOKEN`/`GH_ENTERPRISE_TOKEN` scoped correctly
  across `gh auth`/`gh api` call sites (including CI), and the
  Corepack/pnpm-version notes made version-agnostic.
- Review-triage, advisory-wait, and resume protocol docs tightened:
  review-ack trust gating and its Clause 1 escape-hatch role
  clarified, the AMD marker's inconclusive-routing scope narrowed, the
  operator-present release path's cold-recovery, pause-evidence, and
  no-later-activity handling closed several review-found gaps, and
  hold-release/digest wording plus needs-decision claim-release
  routing were generalized.
- Misc docs: the lite phase map gained its shipped E1-E3 row, the
  commit-signing note realigned with the tiered SSH fallback and its
  actual blocking condition (a non-default outcome, including
  `--no-gpg-sign`, must now be recorded like other material progress),
  `policy-constants`' token range aligned with the real 126,000-byte
  bundle limit, shipped workflow run steps pinned to bash, and small
  precision fixes across `docs/idd-comment-minimization.md`,
  permissions (`per_page` default is 30, not page), the bundle-review
  split-feasibility investigation, and repo dev-experience defaults
  (`.gitattributes`, VS Code settings).

### Fixed

- 32 of the 41 `bin/*.mjs` CLI entry-point scripts were tracked in git
  as non-executable (`100644`) despite their `#!/usr/bin/env node`
  shebang and `package.json` `bin` listing, which could break
  `npx idd-*` resolution for a package manager that trusts the
  execute bit over the shebang; all are now tracked executable.
- `pre-merge-readiness` requires an exact selector for a convergence
  waiver, gates `coveredByWaiver` on both `waivers.mode` and a fresh
  rerun against the deadline/terminal precondition, and corrects its
  waiver-freshness wording.
- `protocol-helpers` scopes rejection-confirmed recognition to actual
  threads, anchors an edited rejection marker by activity, keeps a
  waiver valid after a one-hop claim takeover, and honors bot-suffix
  and reopened-thread cases for skip-review markers.
- `resume-claim-routing` tightens the forced-handoff evidence contract,
  stops misattributing forced-handoff evidence, and fails closed
  (`disputed`/`stop`) on a cold-recovery activation-nonce collision
  when 2+ trusted nonce markers exist for the active claim and no
  local nonce is held.
- `merge-execute` treats BLOCKED discarded check siblings as a gate and
  fails closed on garbled ack-only evidence; `post-merge-cleanup` adds
  a status-aware duplicate-evidence guard.
- Review-reply markers: a valid stamp is found after a lookalike, and
  hyphen-extended stamps are rejected.
- `external-check-waiver` trims actor candidates and fixes an
  empty-string `--actor` fallback; `helper-runtime-manifest` never
  coerces a non-string version and scopes its `--package-spec`/build-
  command help text accurately.
- `idd-advisory-convergence`'s poll loop uses a wall-clock deadline and
  stops re-checking past it.
- `merged-pr-feedback-sweep` flags `COMMENTED`-state review findings
  outside the diff, closing a detection gap; `resolve-review-thread`
  tolerates a missing `--body` in dry-run; `roadmap-audit` no longer
  blocks A1.5 on a closed-descendant cycle.

## [0.6.0] - 2026-08-07

Markdown-code tokenizer hardening, advisory-convergence claimless
waivers, and schema-documentation completeness release.

### Added

- `idd-advisory-convergence.yml`'s CI runner made overridable via a
  `CI_RUNNER_LABEL` repository variable, and the `post-merge-cleanup.yml`
  workflow mirrored into `idd-template/`.
- Claimless external-check-waiver support: a claim-id `none` sentinel
  recognized by the protocol helpers plus an authoring-CLI
  `--claimless` flag, and an opt-in advisory-convergence applicability
  exemption for bot-authored PRs with no claim history.
- `--from-pr` live head-SHA derivation added to the `post-idd-marker`
  helper for advisory marker types.
- The pre-merge gate now hints at the missing-disposition phrase and a
  stale-watermark case when it blocks.

### Changed

- Markdown-code fence/list/HTML-block-boundary tracking hardened
  across a series of edge cases — nested container boundaries, opaque
  fence state, an inline code span's enclosing-block context across
  raw-text HTML elements and spaced thematic breaks, list-content
  indentation inside block boundaries, multiple candidate enclosing
  HTML block types, a fence opener under wide list padding, code
  spans stopping inside an open HTML block, and opened-tag matching
  when closing a raw-text block. Suitability-triage's Check 3
  code-region masking depends on this shared tokenizer.
- Suitability-triage hardening: masks Markdown code regions in Check
  3, requires the PR to reference the candidate issue, and surfaces
  existing A4.5 rejection comments instead of missing them.
- Schema documentation completeness: per-property descriptions added
  across the compact-contract, pre-merge-readiness, and
  advisory/discovery-evidence published schemas, with a new test
  enforcing that invariant repo-wide; a missing
  `activation-nonce-mismatch` enum value added to
  `pre-merge-readiness`'s `claim.reason`.
- Onboarding hardening: package-manager/ephemeral-npx CI and
  `allowBuilds` guidance completed, a hook-manager/`shellEmulator`
  coexistence warning added, runtime-native issue-authoring paths
  honored, doc-lint config shipped with the imported template, and a
  recommendation to disable the ruleset's up-to-date-head requirement
  for adopters who hit it.
- `idd-doctor` fixes: granted GitHub API read scopes and `GH_TOKEN` in
  CI, matches the hyphenated `copilot-advisory` literal, and scopes
  its cleanup-backlog scan to IDD branches only.
- `protocol-helpers` fixes: gates the `reviewDecision` `APPROVED`
  bypass on data instead of trusting the label alone, and recognizes a
  third Codex usage-limit notice trailer wording.
- Misc docs: literal `npx` invocation forms shown per manifest-key, a
  recommendation to prefer Codex reviewer subagents, a warning against
  advisory job-name overrides, and a corrected `ubuntu-slim` ownership
  claim.

### Fixed

- `rerun-advisory-convergence` recovers a stuck rollup when a live
  review already covers HEAD.
- `advisory-convergence` detects suppressed Copilot review findings.
- `supersession-detection` requires an actual closing keyword next to
  a PR reference, not just a bare reference, before treating it as a
  superseding PR.

## [0.5.0] - 2026-08-02

Weak-model "lite" profile, 128k context-budget ceiling, and
advisory-convergence hardening release.

### Added

- Weak-model "lite" instruction profile: a condensed, opt-in
  instruction set spanning claim, work, PR-submit, review-snapshot,
  review-fix, pre-merge, and merge-handoff, with helper-first
  resume/stall guidance and documented model-capability tiers guiding
  when to opt in.
- A 128k-context-derived absolute ceiling on instruction-bundle
  budgets, with a repository-wide diet pass across the overview,
  discover/claim/work/merge, and review-path bundles (`idd-template`
  copies included) to fit under it.
- Advisory-convergence hardening: promoted to a required-check CI
  workflow backed by a policy-engine helper, a bounded same-HEAD
  reroll to converge all-rejected reviews, a Copilot stall-recovery
  state contract with bounded stale-request recovery, terminal
  Copilot-unavailability routed into the merge gate, and a
  maintainer-waiver backstop policy field.
- New evidence/recovery helpers: `ci-wait-state` (a D-phase CI-poll
  snapshot), `rerun-advisory-convergence` (a read-only rerun plan
  plus an `--apply` sequential mode), and `audit-authored-issue` (a
  drafted-issue-body linter wired into the issue-authoring skill).
- Claim-protocol hardening: activation-nonce collision detection at
  claim and merge gates, a worktree-local lock file guarding
  same-machine collisions, and orchestrator delegation as a third
  activation path.
- Discovery upgrades: `--with-claim-state` and desync-band CLI
  options for the orphan filter, a heartbeat-overdue diagnostic, a
  high-confidence duplicate tier in A4.5, `discover.legacyRoots` for
  retro-labeled A1 roots, and an A0-O trigger for the zero-roadmap
  case.
- Issue-authoring skill hardening: broadened prose-only dependency
  detection across more reference shapes, a just-discovered-duplicate
  pre-publish scan, an executability-gate recommendation for code
  spec-units, and collapse of the release step to a single approval.
- An OKF (Open Knowledge Format) frontmatter profile for docs pages
  with an audit guard, plus a generated docs-index table built from
  that frontmatter.
- Onboarding automation waves 2-3: manifest-driven fetch/copy of
  distributed files, and a `--verify` post-import check mode for the
  `idd-onboard` CLI.
- `labels.*` adopter configurability completed with a migration
  guide.
- OpenCode and Antigravity CLI recognized as shared `agents.md`
  runtimes alongside the existing agent integrations.
- A shared `node:util` `parseArgs` wrapper adopted across the helper
  CLI bundle, and a curated Claude Code permission allow/deny
  baseline shipped for adopters.
- New repository guards: an `audit-docs` check that resolves every
  relative markdown link (and `#fragment`, against GitHub's own
  heading-slug algorithm) under the docs and instruction corpus, and
  a workflow-hardening pass across `.github/workflows/` (Node-floor
  guard parity, a forkable-PR label-strip trigger fix, and quoted
  `env:` routing for numeric `workflow_dispatch` inputs) with its
  `idd-template/` mirrors kept in sync.

### Changed

- `README.md` / `README.ja.md` restructured as a benefit-led landing
  page, with a refreshed production-evidence section.
- CI check-run classification hardened: same-name instances are
  deduplicated, same-name checks from different producers are no
  longer conflated, and failure-family states are ranked above a
  stale `SUCCESS` in tie-breaks.
- Pre-merge/merge gate refinements: a branch-currency
  (up-to-date-head) gate, a broadened F2 own-agent-comment carve-out,
  and a retry path for solo-CODEOWNER merge deadlocks.
- Helper internals consolidated onto `node:` builtins
  (`import.meta.main` / `dirname` / `filename` and friends), a
  default `gh` subprocess timeout routed through the shared
  `gh-exec` module, and a fix for a template marker-prefix leak into
  helper output.
- `engines.node`'s `>=24` branch narrowed to `>=24.2.0` (Node 24.0.0
  and 24.1.0 lacked `import.meta.main`, which several helpers now
  rely on); the `^22.22.2` floor is unchanged.
- An auto-labeler guard recipe documented for adopters, and pinned
  `packageSpec` support added for npx-based helper invocation text.
- Dependency bumps: TypeScript 7.0.2, pnpm v11, `actions/setup-node`,
  `actions/stale`.

### Removed

- `skills/issue-authoring/agents/openai.yaml` is no longer part of the
  distributed issue-authoring skill bundle: the file, its references in
  `audit/sync-manifest.json`, and its mentions in `ONBOARDING.md`,
  `README.md`, and the onboarding verification checklist have all been
  removed. No repository doc named a consumer runtime for its
  `$issue-authoring` macro syntax, and it had gone untouched since the
  skill's scaffold commit. Adopters who already installed a copy of this
  file may remove it manually; it is safe to delete.

### Fixed

- Claim/discovery race fixes: A0-T fast-fails on an already-claimed
  target instead of falling back to Discover, code-quoted
  autopilot-suitability markers are masked from detection, and
  concurrent-selection desync tokens are now per-session-unique. A
  same-second claim race could livelock an issue forever (the losing
  session never released, and resume-routing checked the competing
  claim before staleness); staleness is now evaluated first, so the
  24h stale-takeover path clears the dispute.
- Merge-gate correctness: a required check backed by a source-pinned
  (`app_id`/`integration_id`) ruleset entry — reachable through
  GitHub's own suggested-check picker — was unconditionally
  downgraded to `unknown`, permanently livelocking merge even with CI
  green; a new opt-in `ciGate.trustSourcePinnedRequiredChecks` policy
  knob lets an operator who has verified the producer trust it. A
  configured `advisoryWait.primaryBotLogin` could be silently counted
  as a human/CODEOWNER approval in the reviewer-approval gate — a
  fail-open on a check meant to require a human — because only
  `advisoryBotLogins` was excluded, not the primary bot too.
- Advisory-convergence correctness: fails closed on IDD-shaped PRs
  with broken claim linkage and tightened reviewer identity, and
  requires claim-evidence input fields before proceeding.
- gh-API robustness: fails closed on a masked 404 from
  protection/ruleset reads, repairs multi-page `gh` output parsing
  in three helpers, and applies a shared subprocess timeout to every
  `gh` call.
- Review-triage fixes: loosened and shape-gated the Codex
  usage-limit/notice detector, added a resolved-thread duplicate
  pre-check, and gated PATH A bot-finding acceptance on evidence and
  commenter permission.
- The F4 cleanup-evidence marker was forgeable (any commenter could
  pre-post one to suppress the genuine evidence and plant forged
  counts); `idd-doctor` and `idd-merge.instructions.md` now scope
  marker consumption to trusted authors, matching every other IDD
  operational marker.
- Lite-profile fixes from post-merge review triage: activation-nonce
  recheck restored in work/review-fix lite files, E3-empty routing
  corrected, and fail-closed recovery bounds and A5 pre-checks
  restored.
- `.gitignore` re-includes `.claude/agents/` and `.claude/commands/`.

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
