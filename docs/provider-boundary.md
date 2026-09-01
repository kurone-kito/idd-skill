---
type: design
title: IDD Provider Boundary — Design Record
description: Names the provider-neutral concepts, capability groups, and normalized-error/failure semantics a future non-GitHub adapter would implement, and records that GitHub stays the only functional provider today.
tags: [provider, adapter, portability]
---

# IDD Provider Boundary — Design Record

<!-- cspell:words Bitbucket -->

## Background

IDD currently mixes provider protocol with workflow logic.
[`gh-exec.mts`](../src/scripts/gh-exec.mts) centralizes process execution,
but the surrounding helpers still assume GitHub Issues, issue comments,
labels, pull requests, review threads, checks, permissions, and merge
operations, and the distributed tooling contract names `gh` as required.
That makes a future GitLab or Bitbucket adoption a cross-cutting rewrite
instead of an adapter addition.

This document is the first foundation track (#2265) for a staged
portability effort. It defines the provider boundary and policy shape
while preserving GitHub as the default and only functional provider. It
does not implement a GitLab or Bitbucket adapter, move the imported
`.github/` distribution files, or change Copilot review convergence — see
[Non-goals](#non-goals).

## Provider-neutral concepts

| Concept                     | Provider-neutral term (this record) | Current GitHub-specific term                                                                                                      |
| --------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The platform itself         | Provider (`ProviderId`)             | GitHub                                                                                                                            |
| A repository                | Repository locator                  | `owner/repo`                                                                                                                      |
| A trackable unit of work    | Work item                           | Issue                                                                                                                             |
| A proposed code change      | Change request                      | Pull request                                                                                                                      |
| A change request's feedback | Review / review thread              | PR review, review comment thread                                                                                                  |
| An automated verification   | Check                               | Check run / status check                                                                                                          |
| An actor's access level     | Permission                          | Collaborator permission (`admin`/`write`/...)                                                                                     |
| A required-check policy     | Branch protection                   | Branch protection rule / repository ruleset                                                                                       |
| Combining a change request  | Merge                               | Merge / squash / rebase merge (GitHub disables squash and rebase in this repository's settings; only merge commits are used here) |

## Capability groups and the current helper-family mapping

The table below maps each provider-neutral capability group (also
exported as `PROVIDER_CAPABILITY_GROUPS` in the TypeScript contract
below) to a representative sample of the current GitHub-specific helper
families that implement it today. This mapping records the current
boundary for a future migration to target — it is not a migration
commitment, and it does not enumerate every helper file; see
[`docs/idd-helper-scripts.md`](idd-helper-scripts.md) for the full helper
inventory.

| Capability group      | Current GitHub-specific helper family (representative)                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository-identity` | [`branch-name.mts`](../src/scripts/branch-name.mts), [`gh-exec.mts`](../src/scripts/gh-exec.mts) repository resolution                                                                                                                    |
| `work-items`          | [`discover-roadmap-graph.mts`](../src/scripts/discover-roadmap-graph.mts), [`discover-readiness-check.mts`](../src/scripts/discover-readiness-check.mts), [`autopilot-suitability.mts`](../src/scripts/autopilot-suitability.mts)         |
| `comments-and-labels` | [`post-idd-marker.mts`](../src/scripts/post-idd-marker.mts), [`marker-helpers.mts`](../src/scripts/marker-helpers.mts), [`authoring-label-guard.mts`](../src/scripts/authoring-label-guard.mts)                                           |
| `claims`              | [`claim-lock.mts`](../src/scripts/claim-lock.mts), [`resume-claim-routing.mts`](../src/scripts/resume-claim-routing.mts), [`supersession-detection.mts`](../src/scripts/supersession-detection.mts)                                       |
| `change-requests`     | [`branch-conflict-state.mts`](../src/scripts/branch-conflict-state.mts), [`audit-pr-cleanup.mts`](../src/scripts/audit-pr-cleanup.mts)                                                                                                    |
| `reviews-and-threads` | [`resolve-review-thread.mts`](../src/scripts/resolve-review-thread.mts), [`advisory-convergence.mts`](../src/scripts/advisory-convergence.mts), [`disposition-non-review-notices.mts`](../src/scripts/disposition-non-review-notices.mts) |
| `checks`              | [`ci-wait-policy.mts`](../src/scripts/ci-wait-policy.mts), [`ci-wait-state.mts`](../src/scripts/ci-wait-state.mts), [`external-check-waiver.mts`](../src/scripts/external-check-waiver.mts)                                               |
| `permissions`         | [`collaborator-permission.mts`](../src/scripts/collaborator-permission.mts)                                                                                                                                                               |
| `branch-protection`   | [`pre-merge-readiness.mts`](../src/scripts/pre-merge-readiness.mts) required-check reads                                                                                                                                                  |
| `merge`               | [`idd-merge-execute.mts`](../src/scripts/idd-merge-execute.mts)                                                                                                                                                                           |

Infrastructure that stays provider-neutral by construction and is not
mapped to any group: the policy layer
([`policy-helpers.mts`](../src/scripts/policy-helpers.mts),
[`idd-config.mts`](../src/scripts/idd-config.mts)), the new contract
module itself
([`provider-contract.mts`](../src/scripts/provider-contract.mts)), and
repository-maintenance tooling unrelated to the IDD loop (docs sync,
schema validation, the build).

## Normalized error categories

A future adapter's errors collapse into one of the categories below
(`PROVIDER_ERROR_CATEGORIES` / `ProviderErrorCategory` in the contract
module), independent of any one platform's status vocabulary. This
mirrors the classification
[`gh-http-status.mts`](../src/scripts/gh-http-status.mts) already derives
from `gh`'s stderr text for GitHub (`deriveGhHttpStatus`), but names the
concept that GitHub-specific module never had to:

- `authentication` — the caller's credential is missing, expired, or
  rejected.
- `authorization` — the credential is valid but lacks permission for
  the operation.
- `not-found` — the referenced entity does not exist (or is invisible
  to this credential).
- `rate-limited` — the platform is throttling the caller.
- `conflict` — the operation collides with concurrent state (e.g. a
  stale merge base).
- `validation` — the request itself is malformed by the platform's
  own rules.
- `unavailable` — the platform (or a specific endpoint) is down or
  unreachable.
- `unknown` — none of the above could be determined; callers must
  fail closed on `unknown`, exactly as `deriveGhHttpStatus` already
  fails closed on a `null` status today.

## Required-versus-optional failure semantics

Every capability declaration names both a `requirement`
(`required` | `optional`) and whether the provider `supported` it. The
safety rule (already stated in #2265's proposed change, restated here as
the design record's normative text):

- A **required** safety-gate capability that is unsupported **fails
  closed** — it must never silently become a passing gate.
- An **optional** advisory capability that is unsupported may resolve
  `not_applicable`, kept distinct from `ok` so a caller can still tell
  "not offered by this provider" from "checked and passing".
- A supported capability, required or optional, always resolves `ok`.

`evaluateProviderCapabilityOutcome` in the contract module below is the
single pure function that encodes this rule; every future consumer
calls it rather than re-implementing the required/optional branch
locally.

## The transport rule

`gh` remains an implementation detail of the GitHub adapter. A future
adapter may use its own CLI or API client (e.g. `glab` for GitLab, or a
direct Bitbucket API client) without changing workflow/domain helpers,
as long as it produces the provider-neutral locator, capability, and
error shapes this contract names. The contract module itself imports
nothing — not `node:child_process`, not any GitHub-specific response
type — so nothing in it can accidentally couple to how the GitHub
adapter is implemented.

## `provider` versus `providerOutage`

`schemas/policy.schema.json` already had a `providerOutage` key before
this issue (#2320/#2323): it names the repository-scoped **outage-relief
declaration** policy for CI/Actions-service disruptions (`gh`/GitHub
Actions being unreachable), unrelated to which git-hosting platform a
repository uses. This issue adds a new, separate top-level `provider`
key naming the **git-hosting platform selection** described here. The
two keys are deliberately distinct and must not be confused: an active
`providerOutage` declaration says nothing about which `provider` a
repository has configured, and vice versa.

## What an explicit `provider: "gitlab"` (or `"bitbucket"`) does today

Nothing consumes it. The value is validated (schema `enum` plus
`resolveEffectiveProvider` in `policy-helpers.mts`) and recorded as the
resolved policy value, but every existing IDD helper still only speaks to
GitHub through `gh-exec.mts`. A repository that sets a non-`github`
`provider` value today gets a **validated, inert** policy field — not a
working GitLab or Bitbucket adapter. That adapter is future work; this
foundation step only makes the boundary nameable so that work does not
have to guess at the vocabulary from scratch.

## Non-goals

Restated from #2265's proposed change, as the citation for any review
finding that asks this issue to go further:

- No GitLab or Bitbucket adapter implementation.
- No change to where the distributed `.github/` files live.
- No change to Copilot-specific review convergence behavior.
- No per-provider capability-override configuration object — a
  repository selects one `provider` identifier; per-capability overrides
  are out of scope until an adapter exists to need them.

## TypeScript contract

The source of truth for every type and identifier named above is
[`src/scripts/provider-contract.mts`](../src/scripts/provider-contract.mts)
(generated copy: `scripts/provider-contract.mjs`, see
[TypeScript helper sources](typescript-sources.md)). It exports:

- `PROVIDER_IDS` / `ProviderId` / `isProviderId` — provider identity.
- `PROVIDER_CAPABILITY_GROUPS` / `ProviderCapabilityGroup` — the ten
  groups named in the table above.
- `PROVIDER_CAPABILITY_REQUIREMENTS` / `ProviderCapabilityRequirement`,
  `ProviderCapabilityDeclaration`,
  `PROVIDER_CAPABILITY_OUTCOMES` / `ProviderCapabilityOutcome`,
  `evaluateProviderCapabilityOutcome`,
  `assertProviderCapabilityDeclaration` — the required-versus-optional
  failure semantics above.
- `ProviderRepositoryLocator` / `ProviderChangeRequestLocator` —
  repository/change-request locators.
- `PROVIDER_ERROR_CATEGORIES` / `ProviderErrorCategory` / `ProviderError`
  — the normalized error categories above.

## Policy surface

`schemas/policy.schema.json` gains an optional top-level `provider`
string field (`enum: ["github", "gitlab", "bitbucket"]`); an absent value
keeps today's GitHub-only effective policy exactly as-is.
[`policy-helpers.mts`](../src/scripts/policy-helpers.mts) exports
`inspectProvider` / `resolveEffectiveProvider`, mirroring the
`inspectDevelopmentBranch` / `resolveEffectiveDevelopmentBranch` pattern
(#2271/#2272): absent resolves `status: 'default'` with `provider:
'github'`; a recognized value resolves `status: 'configured'`; an
unrecognized value resolves `status: 'invalid'` and must not be silently
treated as either the default or a configured value. See
[IDD Policy Constants](policy-constants.md) for the distributed default.
No credentials or mutable authentication state are part of this policy
surface, or any future extension of it.
