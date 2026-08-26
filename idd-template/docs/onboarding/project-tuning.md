---
type: reference
title: Onboarding Reference — Project Tuning
description: The post-hearing judgment calls idd-onboard's CLI does not automate — agent-entry file surgery, non-default profile artifacts, extra trusted marker actors, the reserved-label guard, and command-row retuning.
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

## Reserved-label guard

When the hearing's nested auto-labeler follow-up answer is yes (a
semantic issue auto-labeler such as CodeRabbit's issue enrichment is
active), the configured IDD label names
(`labels.roadmapLabelName`, `labels.blockedByHumanLabelName`,
`labels.needsDecisionLabelName`) need a guard so the labeler cannot
silently apply one of them to an ordinary issue. See
[IDD label names](policy-decisions.md#idd-label-names) for the field
evidence and the guard recipe; `--record-policy` records the chosen
label names but
does not configure the labeler itself.

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
