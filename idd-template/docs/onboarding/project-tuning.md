---
type: reference
title: Onboarding Reference — Project Tuning
description: The post-hearing judgment calls idd-onboard's CLI does not automate — agent-entry file surgery, non-default profile artifacts, extra trusted marker actors, claim-timing/label-name overrides, the reserved-label guard, the issue-authoring companion install, and command-row retuning.
tags: [onboarding, project-tuning]
---

# Onboarding Reference — Project Tuning

Use this reference after the
[Helper-assisted path](../../ONBOARDING.md#helper-assisted-path)'s
`--hear` / `--import` / `--substitute` / `--record-policy` sequence
(or the equivalent manual Steps 1A-4) has run. It indexes the
judgment calls that stay manual
because they depend on repository-specific state the catalog and CLI
cannot observe or safely automate. It does not restate the 14 Step 1B
policy enums or the seven placeholder derivations — see [Onboarding
Reference — Policy Decisions](policy-decisions.md) and [Onboarding
Reference — Placeholder Values](placeholders.md) for those.

## Step 5 agent-entry surgery

Updating `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and
`.github/copilot-instructions.md` is a judgment call — append to an
existing file, create a minimal stub, or point at a sibling file that
already owns the guidance — not a mechanical rewrite. `idd-onboard` has
no `--update-agent-entries` mode. Follow
[Step 5 — Update agent entry files](../../ONBOARDING.md#step-5--update-agent-entry-files)
in `ONBOARDING.md` for the append/stub/pointer decision and the
cross-file-consistency check it links to, and [Onboarding Reference —
Agent Entry and Verification](agent-entry-and-verification.md) for the
per-file examples.

## Non-default profile artifacts

`idd-onboard --record-policy` records the chosen PR review policy
profile and review-thread resolution policy in
`.github/idd/config.json`, but it does not apply a non-default
profile's artifact or the phase-file customizations that profile
requires. When Step 1B's confirmed profile is not the distributed
default (`copilot-advisory` review policy, `fast-agent-resolve`
thread resolution), read
[IDD PR review policy profiles](../idd-review-policy-profiles.md),
apply the matching artifact from `profiles/`, and complete the listed
phase-file edits by hand before running unattended PR review loops.

## Extra trusted marker actors

`--substitute` (or a `--hear` transcript) resolves exactly one
`{{TRUSTED_MARKER_ACTOR}}` login into
`.github/idd/config.json`'s `trustedMarkerActors` array. Add further
trusted logins as additional quoted array entries by hand after the
first substitution — see [`{{TRUSTED_MARKER_ACTOR}}`](placeholders.md)
for the single-login replacement step this extends.

## Claim-timing overrides and custom label names

The catalog's `claim-timing` and `idd-label-names` items only capture
**whether** the repository keeps the distributed defaults or overrides
them (`distributed-defaults` / `repository-override` /
`custom-taxonomy`) — `--record-policy` deliberately never writes a
literal value for either, since the actual override (an ISO-8601
duration pair, or real label strings) has no representation in the
catalog. If the confirmed answer is not `distributed-defaults`, add
the real values to `.github/idd/config.json` by hand after
`--record-policy --apply` runs:

- **Claim timing** (`repository-override`): set `claimTiming.staleAge`
  and `claimTiming.heartbeatInterval` (both required together) as
  ISO-8601 durations.
- **IDD label names** (`custom-taxonomy`): set
  `labels.roadmapLabelName`, `labels.blockedByHumanLabelName`, and
  `labels.needsDecisionLabelName` to the repository's real label
  strings.

## Reserved-label guard

When the hearing's nested auto-labeler follow-up answer is yes (a
semantic issue auto-labeler such as CodeRabbit's issue enrichment is
active), the configured IDD label names — whether the distributed
defaults or the custom values just recorded above — need a guard so
the labeler cannot silently apply one of them to an ordinary issue.
See [IDD label names](policy-decisions.md#idd-label-names) for the
field evidence and
[Customizing IDD — Reserved-label guard recipe](../customization.md#reserved-label-guard-recipe)
for the recipe itself; neither `--record-policy` nor any other
`idd-onboard` mode configures the labeler.

## Issue-authoring companion install

When the hearing's `issue-authoring-companion` answer is `installed`,
neither `--import` nor `--record-policy` copies the companion
bundle — `--import` only ever copies the core template file set, and
`--record-policy` only writes config/docs. Fetch or copy the
`skills/issue-authoring/` bundle into the confirmed native destination
yourself: see
[Remote fetch examples](template-distribution.md#remote-fetch-examples)
(the `issue-authoring-companion-gh-api-loop` / `-curl-loop` blocks) or
[Local-copy installs](template-distribution.md#local-copy-installs)
for the exact commands, using the native destination recorded in the
policy document.

## Command-row retuning

If the operator wants a `Project commands` table row other than the
value confirmed during the hearing — for example, tightening
`fix-validate` after onboarding completes — re-run `--substitute` with
the matching explicit override flag
(`--fix-validate-commands`, `--pre-push-validate-commands`,
`--post-fix-validate-commands`, or `--install-deps-command`); an
explicit flag always wins over a transcript value. `--record-policy`
does not touch these command rows — they live in the imported
`Project commands` table, not in `.github/idd/config.json`.
