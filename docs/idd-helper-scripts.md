# IDD Helper Script Evaluation

This document records the current decision on optional helper scripts for
the IDD workflow. It exists so future reviews can reference the trade-off
directly instead of re-evaluating the same suggestion from scratch.

## Decision

In the idd-skill source repository, the following optional helpers were adopted:

**Discover & Claim Phase Helpers (Phase 1):**

- `scripts/discover-orphan-filter.mjs` for A0-O orphan issue detection and
  filtering (referenced in
  [kurone-kito/idd-skill#390](https://github.com/kurone-kito/idd-skill/issues/390))
- `scripts/discover-roadmap-graph.mjs` for A1.5/A2 recursive roadmap graph
  enumeration and classification
- `scripts/discover-readiness-check.mjs` for A3 readiness criterion
  evaluation (referenced in
  [kurone-kito/idd-skill#391](https://github.com/kurone-kito/idd-skill/issues/391))
- `scripts/discover-viability-gate.mjs` for A4 viability gate evaluation
  across limited scope, clear verification, and autonomous completion
  criteria (referenced in
  [kurone-kito/idd-skill#505](https://github.com/kurone-kito/idd-skill/issues/505))
- `scripts/suitability-triage.mjs` for A4.5 seven-check suitability
  evaluation (referenced in
  [kurone-kito/idd-skill#392](https://github.com/kurone-kito/idd-skill/issues/392))
- `scripts/claim-approval-gate.mjs` for A5(a) issue-author approval
  verification; A5(d) open-PR conflict checks remain manual by design
  (referenced in
  [kurone-kito/idd-skill#393](https://github.com/kurone-kito/idd-skill/issues/393))
- `scripts/resume-claim-routing.mjs` for Resume Step 1 claim-state
  evaluation and takeover routing (referenced in
  [kurone-kito/idd-skill#394](https://github.com/kurone-kito/idd-skill/issues/394))
- `scripts/resume-route-selection.mjs` for Resume Step 3 PR/CI/review
  state routing (referenced in
  [kurone-kito/idd-skill#395](https://github.com/kurone-kito/idd-skill/issues/395))

**Work & Submit Phase Helpers:**

- `scripts/branch-conflict-state.mjs` for read-only branch conflict and
  synchronization state classification; used by D/E/F routing to decide
  whether `merge-main`, `hold-unknown`, or no action is needed without
  mutating the worktree or PR branch (added in this release)

**Review & Merge Phase Helpers:**

- `scripts/review-activity-snapshot.mjs` for read-only E/F review
  activity and CI snapshot metrics
- `scripts/advisory-wait-state.mjs` for read-only advisory-wait evidence
  collection and AW outcome reporting
- `scripts/ci-wait-policy.mjs` for read-only CI wait policy resolution
  and rerun-budget decisions
- `scripts/pre-merge-readiness.mjs` for read-only F2/F3 readiness
  evidence collection
- `scripts/live-status-digest.mjs` for issue or PR live status digest
  discovery, rendering, dry-run, and claim-checked upsert
- `scripts/audit-pr-cleanup.mjs` for post-merge comment cleanup auditing
- `scripts/review-disposition-verify.mjs` for read-only E7 disposition
  marker presence verification across PATH A and PATH B items

**Operator Recovery Helpers:**

- `scripts/external-check-waiver.mjs` for dry-run/apply generation of
  maintainer-authorized external-check waiver comments tied to an active
  PR claim
- `scripts/force-handoff.mjs` for the interactive TTY-only
  `idd-force-handoff` operator facade that drives issue input, optional
  PR confirmation from live branch state, and final `y/N` consent
- `scripts/forced-handoff-marker.mjs` for low-level forced-handoff
  marker rendering and inspection when maintainers need the canonical
  payload without the interactive facade

**Post-Merge Audit Helpers:**

- `scripts/cleanup-hygiene-report.mjs` for post-merge cleanup hygiene
  metrics aggregation and trend reporting (referenced in
  [kurone-kito/idd-skill#438](https://github.com/kurone-kito/idd-skill/issues/438))

**Utility and Diagnostic Commands:**

The following commands are shipped alongside the issue-loop helpers but are
not phase helpers. They are support utilities and are distinguished here so
future inventory reviews do not need to re-infer their role from code.

- `scripts/idd-doctor.mjs` (`idd-doctor`) — onboarding and configuration
  diagnostics; reads repository config and helper runtime wiring, reports
  gaps without mutating any state.
- `scripts/helper-runtime-manifest.mjs` (`idd-helper-bundle-manifest`) —
  import helper and manifest inspector; emits machine-readable helper wiring
  for `package-manager`, `vendored-node`, and `ephemeral-npx` profiles.
- `scripts/phase-id-resolver.mjs` (`idd-phase-id-resolver`) — phase ID
  normalization utility; resolves canonical phase IDs from aliases and
  validates token format.

### Cleanup Hygiene Report Metrics

The cleanup-hygiene-report.mjs helper generates an auditable snapshot of
PR cleanup status across merged pull requests. It tracks cleanup success
metrics and trends over time using a versioned schema.

**Metric Schema (version 1.0):**

- **Summary metrics** — overall cleanup status:
  - `totalMergedPRs`: Total number of merged pull requests in the
    measurement window (integer)
  - `clean`: Count of PRs with zero minimization candidates (integer)
  - `needsApply`: Count of PRs with one or more unaddressed candidates
    (integer)
  - `cleanPercentage`: Ratio of clean PRs relative to total merged
    (formula: `clean / totalMergedPRs * 100`, range: 0.0–100.0)

- **Candidates breakdown** (`candidatesByClassifier`) — classification of
  minimization candidates:
  - `thresholdMissing`: Candidates below the automation threshold (integer)
  - `skippedWithReason`: Candidates with a documented skip reason
    (integer; reasons: review-thread-unresolved, operational-marker-present,
    held-by-maintainer)
  - `applied`: Successfully minimized comments (integer)
  - `failed`: Minimization attempts that failed (integer)

- **Top skip reasons** — most common reasons for deferring cleanup:
  - Array of objects with `reason` (string) and `count` (integer) fields
  - Tracked reasons: "review-thread-unresolved", "operational-marker-present",
    "held-by-maintainer"
  - Interpretation: helps identify process blockers and coordination needs

- **Trends** — time-sliced metrics for pattern detection:
  - **Recent** (7-day rolling window):
    - `days`: 7 (fixed window width)
    - `startDate`: timestamp of 7 days ago (ISO 8601)
    - `endDate`: current timestamp (ISO 8601)
    - `metrics`: summary counts (totalMergedPRs, clean, needsApply)
    - Use case: detect acute changes or spike patterns in cleanup health
  - **Historical** (before the 7-day window):
    - `beforeDate`: timestamp matching recent window start (ISO 8601)
    - `metrics`: aggregated summary counts
    - Use case: establish baseline trends for longer-term analysis

**Interpretation guidance:**

- A `cleanPercentage` of 100% indicates no PR comments require cleanup
  attention (either all comments were addressed or no comment minimization
  candidates were detected).
- `topSkipReasons` with high counts may indicate system-level issues
  (e.g., unresolved review threads prevent cleanup even when comments
  could be minimized).
- Recent vs historical comparison shows whether cleanup discipline is
  improving or declining over time.
- `candidatesByClassifier` breakdown helps distinguish between items that
  were below automation threshold, intentionally deferred, successfully
  cleaned, or failed during cleanup.

The canonical workflow remains the portable shell / `gh` / `jq`
instructions embedded in `.github/instructions/*.instructions.md`. The
helpers are convenience layers only; written decision tables and phase
rules remain authoritative when outputs diverge.

For discover and suitability, use the adopted helpers first when helper
support is enabled, then fall back to the portable instructions if a
helper is unavailable or its output does not match the written rules.

### Discover Roadmap Graph Contract

`scripts/discover-roadmap-graph.mjs` evaluates the recursive A1.5/A2
roadmap graph for one selected roadmap issue.

- **Inputs**: `--issue <number>`, with optional `--owner <owner>`,
  `--repo <repo>`, and `--policy <path>`.
- **JSON output**:
  - `root`: `{ number: number, title: string, state: string,`
    `classification: "roadmap" | "execution", roadmapMarkerId: string }`
  - `nodes`: `[{ number: number, title: string, state: string,`
    `labels: string[], classification: "roadmap" | "execution",`
    `roadmapMarkerId: string, depth: number }]`
  - `edges`: `[{ source: number, target: number, relationship: string,`
    `evidence: string }]`
  - `provenancePaths`: `[{ target: number, path: number[] }]`
  - `roadmapNodes`: `number[]` — nested roadmap nodes discovered through
    traversal; **excludes** the root roadmap (A1 traversal entry point)
  - `executionCandidates`: `number[]`
  - `diagnostics`: `{ duplicateReferences: object[], cycles: object[],`
    `inaccessibleReferences: object[], unresolvedReferences: object[] }`
  - `summary`: `{ rootNumber: number, nodeCount: number, edgeCount: number,`
    `roadmapNodeCount: number, executionCandidateCount: number,`
    `duplicateReferenceCount: number, cycleCount: number,`
    `inaccessibleReferenceCount: number, unresolvedReferenceCount: number,`
    `maxDepth: number }`
- **Error conditions**: missing `--issue`, unknown flags, an unreadable
  root roadmap, or incomplete `subIssues` GraphQL data throw. Missing or
  inaccessible descendants are reported in `diagnostics` instead of
  crashing.
- **Behavior boundary**: the helper is evidence-only. It may read issue
  bodies and GitHub sub-issue relationships, but it must not claim
  issues, edit roadmap bodies, close roadmap nodes, or decide readiness
  by itself.

### Discover Viability Gate Contract

`scripts/discover-viability-gate.mjs` evaluates the A4 viability gate for
one or more issues.

- **Inputs**: `--issue <number>` (repeatable) or `--issues <n1,n2,...>`,
  with optional `--csv`, `--owner <owner>`, and `--repo <repo>`.
- **JSON output**:
  - `viable`: `[{ number: number, title: string }]`
  - `discarded`: `[{ number: number, title: string,`
    `failedCriteria: string[], criteria?: [{ id: string, name: string,`
    `result: "pass" | "fail", evidence: string }] }]`
  - `summary`: `{ total: number, viableCount: number,`
    `discardedCount: number, discardedByCriterion: Record<string, number> }`
- **Error conditions**: missing issue arguments or unknown flags throw;
  loader or GitHub failures surface as errors; not-found or non-open
  issues are reported in `discarded` with `failedCriteria` instead of
  crashing.
- **Example**:

  ```json
  {
    "viable": [{ "number": 123, "title": "trim helper docs" }],
    "discarded": [{ "number": 124, "title": "rewrite workflow", "failedCriteria": ["limited_scope", "autonomous_completion"] }],
    "summary": { "total": 2, "viableCount": 1, "discardedCount": 1, "discardedByCriterion": { "limited_scope": 1, "autonomous_completion": 1 } }
  }
  ```

The exported template remains portable without a `scripts/` directory.
Adopters can copy the helper separately when they want the same
repository-local convenience, otherwise the documented GraphQL fallback
remains the portable path.

Absent helper runtime configuration means `instructions-only`. Repositories
that do not opt into helper support should still be able to copy the
Markdown instructions, run the portable shell / `gh` / `jq` procedures,
and complete the workflow without a Node.js dependency.

## Helper Runtime Profiles

When a repository imports the IDD template, helper support should be
selected from one of these profiles:

| Profile             | Intended use                                                                                                                | Dependency model                                                               | Portability expectation                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `package-manager`   | The adopter already uses pnpm, npm, or yarn for the repository.                                                             | Reuse the repository's existing package manager and pre-resolved dependencies. | Preferred when a package manager project already exists; do not fall back to ad hoc `npx` in this mode.                                 |
| `vendored-node`     | The adopter has Node.js available but does not want helper execution to depend on registry resolution at runtime.           | Copy a local helper bundle into the repository during import.                  | Keeps helper execution repository-local while remaining optional.                                                                       |
| `ephemeral-npx`     | The adopter has Node.js available, does not vend helper files, and can resolve a runnable helper command at execution time. | Resolve helper execution through one-shot `npx` commands.                      | Reserved for cases where a published or otherwise resolvable helper command already exists; otherwise fall back to `instructions-only`. |
| `instructions-only` | The adopter does not want or cannot use helper scripts.                                                                     | No helper runtime. Agents follow the Markdown instructions directly.           | First-class supported fallback; no helper config is required.                                                                           |

## Import-Time Selection Order

Helper runtime choice is an import-time policy decision. Use repository
evidence to decide whether helper support should be proposed for
operator confirmation. If helper support is not confirmed, keep
`instructions-only`.

1. If supported `packageManager` metadata or exactly one supported
   lockfile is present, propose `package-manager`.
2. Otherwise, if Node.js is available and the import flow is allowed to
   copy helper files, propose `vendored-node`.
3. Otherwise, if Node.js is available and a published or otherwise
   resolvable helper command exists for one-shot execution, propose
   `ephemeral-npx`.
4. Otherwise, use `instructions-only`.

This selection order exists to keep helper support optional without
turning every adopter into a Node.js-first repository. The written
decision tables remain the canonical protocol regardless of which helper
profile is selected.

## Profile Wiring Surface

Use `idd-helper-bundle-manifest` as the canonical import helper for these
profiles. It is published from this source repository as both
`scripts/helper-runtime-manifest.mjs` and the package bin
`idd-helper-bundle-manifest`, so adopters can inspect one machine-readable
manifest instead of hand-maintaining helper file lists. The manifest's
top-level `recommendation` field uses the same package-manager evidence
class as onboarding: supported `packageManager` metadata or exactly one
supported lockfile can recommend `package-manager`; ambiguous
package-manager signals can still recommend `vendored-node`; otherwise
it stays fail-closed at `instructions-only` and never treats bare
`package.json` presence as enough evidence to assume npm or a real
Node.js helper path.

- `package-manager`: run the manifest from the target repository root and
  let it detect npm, pnpm, or yarn (or pass `--package-manager` if
  detection is ambiguous). The output includes the package-manager
  install command, the `@kurone-kito/idd-skill` helper dependency, and a
  `package.json` scripts block that calls stable `idd-*` bins without
  assuming pnpm.
- `vendored-node`: use the manifest's `managedFiles` list to copy the
  helper bundle into matching paths in the target repository, then run
  the emitted local `node scripts/...` commands.
- `ephemeral-npx`: use the manifest's one-shot `npx --yes --package
  <helper-package-spec> idd-*` commands without copying helper files
  into the repository. The default helper package spec is an HTTPS
  archive URL, and `--package-spec` lets adopters pin a reviewed tarball
  or mirror URL explicitly.
- `instructions-only`: keep helper dependencies, helper files, and helper
  wrapper scripts out of the target repository entirely.

To switch profiles later, rerun the manifest with both
`--profile <target-profile>` and `--from-profile <current-profile>`. The
switch section reports the files, dependency entries, and `package.json`
scripts to add or remove for that transition.

The adopted helper boundaries are intentionally narrow:

- `claim-approval-gate.mjs` is read-only, evaluates only the A5(a)
  issue-author approval gate, and emits machine-readable approval
  evidence
- it resolves collaborator permission, ready-label freshness, and
  approval-comment freshness under repository policy, then fails closed
  when ambiguity remains
- it does not claim issues, inspect A5(d) open-PR conflicts, or bypass
  the written claim rules; live PR conflict checks remain manual until a
  stable contract can cover inheritable-branch and linked-issue
  exceptions

- `force-handoff.mjs` is intentionally operator-facing and interactive;
  it asks for the issue number before any mutation, derives whether PR
  input is required from live open PR state on the active claim branch,
  previews the generated marker and successor IDs, and posts only after
  an explicit `y` confirmation
- it must fail closed outside a TTY and is not available to autopilot
  or unattended agent contexts
- it does not replace the forced-handoff policy contract; it is the
  recommended maintainer workflow for producing canonical evidence under
  that contract

- `forced-handoff-marker.mjs` is a lower-level render and inspection
  helper that can plan or emit the canonical marker body for a specific
  issue, claim, branch, and optional PR context
- it is useful for audited debugging and manual inspection, but normal
  maintainer recovery should prefer `idd-force-handoff`
- it does not authorize handoff on its own; the same human-gated policy
  and live-claim validation rules still apply

- `review-activity-snapshot.mjs` is read-only, emits machine-readable
  metrics, and does not evaluate accept/reject dispositions or merge
  decisions
- it does not replace the E/F gate decision tables; it only reduces
  command-copy variance when collecting canonical snapshot fields

- `advisory-wait-state.mjs` is read-only, emits machine-readable AW1-AW3
  evidence plus the computed AW outcome, and never requests reviewers,
  posts markers, or mutates PR state
- it does not replace the advisory-wait decision table; it only reduces
  command-copy variance when collecting canonical AW evidence

- `ci-wait-policy.mjs` is read-only, resolves `ciWait.*` defaults from
  `.github/idd/config.json`, and can evaluate whether the current rerun
  count still permits an automatic rerun
- it does not poll CI, rerun workflows, or replace the CI decision
  table; it only reduces config-copy variance when callers need the
  shared CI wait defaults

- `pre-merge-readiness.mjs` is read-only, emits machine-readable F2/F3
  evidence including review currency, unresolved-thread state,
  unreplied comments, reviewer states, advisory state, CI, claim
  validation, and `waiverEvidence` (parsed external-check waiver comments
  classified as `valid`, `expired`, `wrongHead`, `wrongClaim`,
  `unauthorized`, or `malformed`; checks covered by a valid waiver are
  reported with `coveredByWaiver: true` and treated as passing by the CI
  gate)
- it does not replace the pre-merge or merge decision tables; it only
  reduces command-copy variance when collecting canonical merge-gate
  evidence

- `live-status-digest.mjs` defaults to dry-run, supports issue and PR
  targets, and mutates only with explicit `--apply`
- apply mode re-validates an active claim unless a maintainer explicitly
  uses `--skip-claim-check`
- it creates or updates only the single current digest comment and
  refuses duplicate marked digests with repair URLs instead of choosing
  one, deleting, or minimizing audit history
- digest text remains non-authoritative UI state; phase decisions still
  come from trusted markers and GitHub state

- `audit-pr-cleanup.mjs` defaults to dry-run and prints stable JSON
  unless `--format table` is requested
- apply mode is explicit and can re-validate an active claim before
  every minimization mutation
- known review-bot regular comments are considered only after merge and
  only when they match a completed-review or stale-notification signal
- cleanup remains best-effort and never becomes a merge gate
- direct GraphQL fallback commands remain documented in
  `docs/idd-comment-minimization.md`

- `review-disposition-verify.mjs` is read-only, takes a JSON array of
  ReviewItems_snapshot items, and emits per-item verification evidence
- it checks E7 disposition requirements: decision recorded, marker
  present and matching, and thread resolution correct per path and type
- it never posts replies, resolves threads, or mutates any GitHub state
- thread-resolution checks are gated on `type === "review_thread"`;
  non-thread items must have `threadResolved: null`, not `true`/`false`
- PATH A AMD items must have the thread unresolved; PATH A Rejected and
  PATH B items must have review threads resolved
- PATH A Accepted items pass without a marker (reply is handled in
  review-fix, not triage)
- written E7 rules in `idd-review-triage.instructions.md` remain
  authoritative; this helper only reduces command-copy variance when
  confirming marker presence before triage exits

## Stable Helper Evidence Outputs

### Operator forced-handoff helpers

- Command: `node scripts/force-handoff.mjs`
- Published bin: `idd-force-handoff`
- Contract:
  - interactive TTY only
  - asks for issue input before any mutation
  - asks for PR input only when a live open PR exists on the active
    claim branch and PR-scoped evidence is required
  - prints the generated successor IDs and marker preview before the
    final confirmation
  - posts nothing unless the final confirmation is exactly `y`

- Command: `node scripts/forced-handoff-marker.mjs --issue <number> --plan ...`
- Published bin: `idd-forced-handoff-marker`
- Stable contract:
  [`schemas/forced-handoff-marker.schema.json`](../schemas/forced-handoff-marker.schema.json)
- Intended use:
  - render or inspect canonical forced-handoff marker payloads
  - support audited debugging or manual review of the exact body
  - stay distinct from the interactive operator facade above

The references in this subsection apply only when a repository
explicitly installs the matching helpers and records a human-gated
forced-handoff policy. Repositories that stay on the default disabled
policy must not expose either helper as an active recovery path.

The references in this section apply only when a repository explicitly
installs the matching helper scripts. Repositories that stay on the
default `instructions-only` profile keep using the written shell /
`gh` / `jq` procedures in the phase instructions and do not need a
`scripts/` directory.

### External-check waiver helper

- Command:
  `node scripts/external-check-waiver.mjs --pr <number> --check
  <selector> --reason <text> (--expires <iso8601> | --expires-in
  <duration>)`
- Published bin: `idd-external-check-waiver`
- Contract:
  - dry-run is the default; the helper prints the canonical comment body
    plus claim/check/authority evidence before any mutation
  - `--apply` posts the PR comment only after verifying the linked
    issue's active claim, the current PR HEAD SHA, the live check state,
    waivable-selector coverage, and maintainer/admin authority
  - non-interactive apply is refused unless `--yes` is provided after a
    prior dry-run review; interactive TTY runs may confirm with `y/N`
  - the helper fails closed when authority cannot distinguish owner,
    Maintain, or Admin from plain Write access, when the requested check
    is not configured in `ciGate.externalChecks.waivable`, or when the
    expiry exceeds `ciGate.externalCheckWaivers.maxValidity`

### External-check waiver contract

Issue `#666` defines the policy and marker contract before the operator
facade and F-phase consumer land. The contract is intentionally
auditable and fail-closed.

```md
<!-- idd-external-check-waiver: {agent-id} {claim-id} {head-sha} check:{check-selector} reason:{reason-token} expires:{iso8601} -->

_{actor}: external check waiver for IDD F phase._
```

Interpretation rules:

- `agent-id`, `claim-id`, `head-sha`, `check`, `reason`, and `expires`
  come from the marker body.
- The issuer is the GitHub comment author and the issued timestamp is
  the comment `created_at`. Do not duplicate either field inside the
  marker body.
- `check` may be an exact selector or a glob pattern, matching the
  `ciGate.externalChecks.*[].selector` plus `matchMode` contract.
- Missing or unparseable body fields, unknown selectors, expired
  comments, wrong HEAD, wrong claim, or untrusted authors must fail
  closed.
- A valid waiver can apply only to checks listed in
  `ciGate.externalChecks.waivable` and only when
  `ciGate.externalCheckWaivers.mode` enables maintainer authorization.
- Repo-owned required checks and GitHub-required checks remain
  non-waivable at the contract layer. An IDD waiver never substitutes
  for GitHub ruleset bypass.
- When the optional facade is installed, prefer helper-first usage:
  - dry-run:

    ```sh
    idd-external-check-waiver --pr 123 \
      --check "CodeRabbit" \
      --reason "rate limit" \
      --expires-in PT2H
    ```

  - apply after review:

    ```sh
    idd-external-check-waiver --pr 123 \
      --check "CodeRabbit" \
      --reason "rate limit" \
      --expires-in PT2H \
      --apply --yes
    ```

  - inspect the rendered body first; do not hand-write or copy raw
    marker comments into the PR
  - in solo-maintainer repositories, this helper-generated comment is
    the authorization path; a normal PR approval is not equivalent

### A4 viability gate

- Command: `node scripts/discover-viability-gate.mjs --issue <number>`
  (repeatable; or `--issues <n1,n2,...>`)
- Optional CSV output: append `--csv` flag
- Stable output schema (JSON mode):

  ```json
  {
    "viable": [{ "number": 123, "title": "..." }],
    "discarded": [
      { "number": 124, "title": "...", "failedCriteria": ["limited_scope"] }
    ],
    "summary": {
      "total": 2,
      "viableCount": 1,
      "discardedCount": 1,
      "discardedByCriterion": { "limited_scope": 1 }
    }
  }
  ```

- Stable fields consumed by A4: `viable[].number`, `discarded[].number`,
  `discarded[].failedCriteria`, and `summary.viableCount`
- The helper evaluates the three A4 viability criteria (limited scope, clear
  verification, autonomous completion) against fetched issue bodies; it does
  not post claims or mutate any state

### Claim approval evidence

- Source repo / vendored-node command:
  `node scripts/claim-approval-gate.mjs --issue <issue-number>`
- Package-manager / ephemeral-npx command: use the
  profile-selected `idd:claim-approval-gate` command from the helper
  runtime manifest wiring above
- Optional freshness override: append
  `--generated-plan-updated-at <ISO8601>` when the caller already has
  authoritative generated-plan freshness evidence to reuse
- Stable fields consumed by the instructions: `approved`, `reason`,
  `gateEnabled`, `policy.skipIssueAuthorApprovalGate`,
  `policy.maintainerApprovalActorPolicy`, `policy.approvalSignals`,
  `checks`, and `timelineAvailable`
- `checks` remain stable by `id`: `gate_enabled`,
  `author_self_authorized`, `ready_label_present`,
  `ready_comment_fresh`, and `ambiguity_guard`
- the helper is intentionally scoped to A5(a); A5(d) open-PR conflict
  checks stay on the written live GitHub path because inheritable-branch
  and linked-issue exceptions do not yet have a supported helper
  contract

### Resume claim and route evidence

- Claim routing command:
  `node scripts/resume-claim-routing.mjs --issue <issue-number>`
- Stable fields consumed by resume instructions: `state`, `action`,
  `reason`, `active_claim`, `claim_id_checked`, `stale_age_ms`, `now`,
  `warnings`, and `evidence`
- Stable enums:
  - `state`:
    `unclaimed|already_owned|stale|non_inheritable|disputed`
  - `action`: `re_claim|takeover|keep|stop`

- Step 3 route command:
  `node scripts/resume-route-selection.mjs --issue <issue-number>`
- Stable fields consumed by resume instructions: `route`, `reason`,
  `state`, and `evidence`
- Stable enum:
  - `route`: `D1|D4|E1|E15|Esync|F1|F2|stop`

### Advisory-wait evidence

- Command: `node scripts/advisory-wait-state.mjs --pr <pr-number>`
- Stable contract:
  [`advisory-wait-state.schema.json`][advisory-wait-state-schema]
- Stable fields consumed by the instructions: `prHeadSha`,
  `lastCopilotCommit`, `copilotPending`,
  `copilotPendingCoversHead`, `outcome`, `f3Outcome`,
  `earliestSameHeadAt`, `requestMarkerCount`, `requestCap`,
  `pendingWindowMinutes`, `settledWindowMinutes`,
  `pollIntervalMinutes`, `capExhaustedRoute`, and
  `trustedMarkerSummary`

### CI wait policy resolution

- Source repo / vendored-node command:
  `node scripts/ci-wait-policy.mjs`
- Package-manager / ephemeral-npx command: use the
  profile-selected `idd:ci-wait-policy` command from the helper runtime
  manifest wiring above
- Optional rerun-budget evaluation: append
  `--rerun-count <count>` to the selected command
- Stable fields consumed by instructions or helpers:
  `policy.runningTimeout`, `policy.runningTimeoutMs`,
  `policy.generationTimeout`, `policy.generationTimeoutMs`,
  `policy.rerunPolicy`, and optional `rerunDecision.action` /
  `rerunDecision.reason`
- it remains read-only; the command does not poll CI, rerun workflows,
  or post any GitHub comment

### Merge-gate evidence

- When helper runtime is enabled, these commands are the preferred
  evidence collection path for E1/F2/F3 review-currency and merge-gate
  checks.
- Snapshot command: `node scripts/review-activity-snapshot.mjs`
  with `--pr <pr-number>` and
  `--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"`
- Stable E1/F2/F3 snapshot tuple: `headSha`,
  `maxActivityUpdatedAt`, `totalItemCount`,
  `latestPassingCiCompletedAt`, and `counts`
- Additional CI completion field: `latestCiCompletedAt` reports the
  latest terminal run of any state; watermark and merge-gate checks use
  `latestPassingCiCompletedAt`
- Readiness command: `node scripts/pre-merge-readiness.mjs`
  with `--pr <pr-number>`, `--claim-issue <issue-number>`,
  `--expected-claim-id <claim-id>`, and
  `--trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"`
- Stable contract:
  [`pre-merge-readiness.schema.json`][pre-merge-readiness-schema]
- Stable sections consumed by the instructions: `reviewCurrency`,
  `threads`, `unrepliedComments`, `reviewerStates`,
  `advisoryWait` (including the effective advisory policy fields), `ci`,
  `claim`, and optional `dispositionEvidence`
- `reviewerStates.codeownerSelfApproval` diagnoses whether CODEOWNER
  approval can be satisfied by an eligible non-author owner or an
  applicable ruleset or classic pull-request bypass. `deadlock` and
  `possible_deadlock` statuses should be surfaced in F2 evidence and
  hold comments, but they do not grant bypass permission. The
  `currentUserCanBypass` token records the known GitHub ruleset value
  (`unknown`, `never`, `always`, `pull_requests_only`, `exempt`, or
  `mixed`).
- A `clear` diagnostic means the helper found a GitHub topology that
  appears satisfiable for the current actor; it is still evidence for
  the written F2/F3 gates, not an IDD policy override or permission to
  skip review, CI, freshness, advisory, unresolved-thread, or claim
  checks.
- `reviewCurrency.comparisonRoute` remains advisory evidence only. Agents
  must still apply written instruction checks against live GitHub state.
- Fail closed: if helper execution fails, output is invalid JSON,
  required fields/sections are missing, or helper evidence conflicts with
  live GitHub state, discard helper output and use the portable manual
  fetch path.

### E7 disposition verification

- Preferred command when helper runtime is enabled:
  `idd-review-disposition-verify --items '<json>'`
- Source repository equivalent:
  `node scripts/review-disposition-verify.mjs --items '<json>'`
- Input: JSON array of ReviewItems_snapshot items, each with `id`,
  `path` (`"A"` or `"B"`), `type`, `decision`, `markerReply`, and
  `threadResolved`
- Output schema (stable fields):

  ```json
  {
    "passed": true,
    "summary": "All 3 items verified.",
    "totalCount": 3,
    "passedCount": 3,
    "failedCount": 0,
    "items": [{
      "id": "...",
      "path": "A",
      "checks": {
        "decisionRecorded": true,
        "markerPresent": true,
        "markerMatchesDecision": true,
        "threadResolutionCorrect": true
      },
      "passed": true,
      "issues": []
    }]
  }
  ```

- Stable fields consumed at E7: `passed`, `items[].passed`,
  `items[].checks`, and `items[].issues`
- Read-only boundary: the helper never posts replies, resolves threads,
  or performs any E6 mutation.
- Fail closed: if execution fails, output is invalid JSON, required
  fields are missing, or output conflicts with observed triage evidence,
  discard helper output and apply written E7 checks directly.

### Branch conflict and synchronization state evidence

- Preferred command when helper runtime is enabled:
  `idd-branch-conflict-state --pr <pr-number>`
- Source repository equivalent:
  `node scripts/branch-conflict-state.mjs --pr <pr-number>`
- Output schema (stable fields):

  ```json
  {
    "protocolVersion": "1",
    "prNumber": 123,
    "prHeadSha": "abc...",
    "prBaseSha": "def...",
    "published": true,
    "mergeable": "MERGEABLE",
    "mergeStateStatus": "CLEAN",
    "branchState": "clean",
    "syncRecommendation": "none",
    "readOnly": true,
    "worktreeUnchanged": true,
    "diagnostics": {
      "mergeableSource": "github-mergeable",
      "conflictFiles": [],
      "notes": []
    }
  }
  ```

- `branchState` values: `clean`, `behind-no-conflict`, `content-conflict`,
  `dirty`, `force-push-exception`, `unknown`
- `syncRecommendation` values: `none`, `merge-main`, `policy-required-update`,
  `force-push-exception`, `hold-unknown`
- Stable fields consumed by D/E/F routing: `branchState`,
  `syncRecommendation`, `published`, `readOnly`, `worktreeUnchanged`
- Read-only boundary: the helper never runs `git merge`, `git rebase`, or
  any command that leaves merge state, index changes, or working-tree
  changes. The `readOnly` and `worktreeUnchanged` fields confirm this.
- Fail closed: if execution fails, output is invalid JSON, or required
  fields are missing, discard helper output and apply written D4/E-phase
  branch-sync checks directly.

### S2 quiet-window evidence

- When helper runtime is enabled, Resume/S2 should call the
  profile-selected `idd-stalled-session-quiet-check --pr <pr-number>`
  command first. `node scripts/stalled-session-quiet-check.mjs --pr
  <pr-number>` is the vendored equivalent.
- Optional parameters: `--now <ISO8601>`, `--quiet-window-ms <ms>`,
  `--claim-created-at <ISO8601>`, and `--policy <path>`
- Stable fields consumed by the instructions: `quiet_window_met`,
  `quiet_window_ms`, `window_start`, `now`, `latest_activity`,
  `latest_activity_type`, `reason`, and `evidence`
  (`activity_count_in_window`, `blocking_activities`,
  `has_heartbeat_in_window`, `has_ci_running`,
  `has_pr_head_movement`, `has_branch_tip_movement`)
- `ci-running` activities always break the quiet window regardless
  of their timestamp; all other types are checked against
  `window_start = now - quiet_window_ms`
- Before takeover, re-run the helper against live GitHub state and pair
  it with the written Resume/S2-S4 checks for the same active claim,
  stale-threshold gating, closed/merged guards, and A5 race-safe claim
  verification. `quiet_window_met = true` alone is never sufficient.

## Friction Inventory

The workflow areas most likely to benefit from optional helpers are:

| Candidate                       | Status             | Helper level                       | Mutation risk | Canonical fallback path                                                | Drift risk                                                                               | Estimated payoff / byte reduction                                       |
| ------------------------------- | ------------------ | ---------------------------------- | ------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A4 viability gate               | Adopted helper     | Read-only evaluator                | Low           | A4 viability criteria table in `idd-discover.instructions.md`          | Low — criteria are deterministic pattern matches against issue body text                 | Low to medium — roughly 100 to 200 bytes of repeated A4 criterion prose |
| Claim-state parsing             | Reserve candidate  | Read-only parser                   | Low           | Claim rules in `.github/instructions/idd-overview.instructions.md`     | High — claim parsing is subtle and any divergence would create false ownership decisions | Medium — roughly 200 to 400 bytes of repeated marker-parsing prose      |
| Review activity snapshots       | Adopted helper     | Read-only evidence collector       | Low           | E1/F2/F3 activity-universe fetches via `gh` / GitHub API               | Medium — helper output must keep matching the review-currency rules exactly              | High — roughly 600 to 900 bytes of repeated multi-surface fetch prose   |
| Live status digest edits        | Adopted helper     | Dry-run by default, explicit apply | Medium        | Phase-specific digest discovery and update flow                        | Medium — digest text must remain UI-only and never look authoritative                    | Medium — roughly 300 to 500 bytes of repeated digest-upsert prose       |
| Advisory-wait state             | Adopted helper     | Read-only evidence collector       | Low           | `.github/instructions/idd-advisory-wait.instructions.md`               | Medium — helper must expose evidence without hiding the canonical decision table         | Very high — roughly 900 to 1400 bytes of repeated AW command prose      |
| Pre-merge readiness             | Adopted helper     | Read-only evidence collector       | Low           | `.github/instructions/idd-pre-merge.instructions.md` and F3 live fetch | Medium — helper must stay evidence-only and preserve the written merge gates             | Very high — roughly 1200 to 1800 bytes of repeated merge-evidence prose |
| Post-merge cleanup candidates   | Adopted helper     | Dry-run by default, explicit apply | High          | GraphQL minimize-comment fallback flow                                 | Medium — minimization safety still depends on exact review/marker rules                  | Medium — roughly 400 to 700 bytes of repeated GraphQL audit prose       |
| E7 disposition verification     | Adopted helper     | Read-only evidence verifier        | Low           | E7 verification steps in `idd-review-triage.instructions.md`           | Low — verification logic is deterministic and path/type rules are stable                 | Low to medium — roughly 150 to 300 bytes of repeated E7 pre-exit checks |
| Branch protection/ruleset reads | Deferred candidate | Read-only API adapter              | Low           | Direct ruleset / branch-protection API reads                           | Medium — repository support varies and incomplete coverage could create false confidence | Low to medium — roughly 150 to 300 bytes of repeated ruleset prose      |
| Branch conflict state           | Adopted helper     | Read-only evidence collector       | Low           | D4/E-phase branch-sync checks in `idd-pr-submit.instructions.md`       | Medium — helper must stay evidence-only and preserve the written sync gates              | Medium — roughly 300 to 500 bytes of repeated branch-state prose        |

### Ranked roadmap candidate list for the source roadmap

The ranking distinguishes immediate roadmap picks from documented
reserve candidates:

1. **Advisory-wait state** — **implemented now**. The AW protocol had
   the highest command-copy burden, a stable read-only evidence shape,
   and a clear non-goal boundary, so the source roadmap landed it first
   as
   [kurone-kito/idd-skill#308](https://github.com/kurone-kito/idd-skill/issues/308).
2. **Pre-merge readiness** — **implemented now**. F2/F3 collect the
   largest evidence set in the workflow and already compose existing
   pure protocol logic, making a read-only helper valuable without
   moving merge authority out of the instructions. This maps directly to
   the source follow-up issue
   [kurone-kito/idd-skill#309](https://github.com/kurone-kito/idd-skill/issues/309).
3. **Claim-state parsing** — **reserve, defer for now**. The payoff is
   real, but claim ownership drift would be more dangerous than
   shell-copy variance, so this should wait until helper runtime
   profiles and the higher-payoff read-only gates are settled.

### Explicit deferrals

- **Branch protection/ruleset reads** stay deferred for this roadmap.
  They are useful support data, but repository variance and narrower
  byte savings make them a worse first investment than AW/F2 helpers.
- **Live status digest** and **post-merge cleanup** are already adopted
  in narrow forms, so they are inventory baselines rather than new
  roadmap targets.

### Inventory Non-goals

- Do not turn this inventory into a commitment to helperize every phase.
- Do not rank mutating merge or review actions ahead of read-only
  evidence collectors.
- Do not let helper candidates replace the written decision tables.
- Do not use this inventory to justify a separate npm package before the
  local/template profile path is proven.

## Trade-off

Helper scripts can improve copy/paste reliability and make some
review-state checks easier to audit locally. That benefit is real,
especially for advisory-wait, review-snapshot, and post-merge cleanup
commands.

The portability cost is also real. The exported IDD template is meant to
work in repositories that can copy Markdown instruction files without
adopting a runtime, package manager, or repository-local script
directory. If helper scripts are introduced too early, every operational
rule must be maintained twice: once in the instructions that agents read,
and once in code that agents run.

For now, the safer balance is to keep pre-merge and advisory
instructions canonical while allowing three read-only evidence helpers,
one live digest upsert helper, and one post-merge cleanup helper. Merge
safety still depends on the written checks, not on helper output alone.

## Non-goals

This helper policy does **not** imply the following:

- Node.js becomes mandatory for repositories that only copy the Markdown
  instructions
- helper output becomes authoritative over the written decision tables
- helpers perform mutating review or merge actions by default; mutation
  must remain explicit in the written instructions
- the project is committed to publishing a separate npm package before
  the local and templated helper profiles are proven

## Future Adoption Criteria

If additional helper scripts are revisited, they should satisfy all of
the following:

- They are optional and never required to execute the exported template.
- They are read-only by default; mutating actions remain explicit in the
  phase instructions.
- They output stable machine-readable JSON that can be inspected and
  compared by agents.
- They keep the shell / `gh` / `jq` fallback documented beside the helper
  path.
- They have a small test fixture set for marker parsing and snapshot
  filtering.
- They are introduced only after the corresponding instruction protocol
  has stabilized enough that drift risk is lower than command-copy risk.

Good future candidates remain read-only evidence collectors for
pre-merge readiness or later claim-state inspection. They should not
replace the written decision tables.

[advisory-wait-state-schema]: https://kurone-kito.github.io/idd-skill/schemas/advisory-wait-state.schema.json
[pre-merge-readiness-schema]: https://kurone-kito.github.io/idd-skill/schemas/pre-merge-readiness.schema.json
