---
type: index
title: IDD Reference Manual
description: Is the entry point and topic map for the idd-skill deeper reference manual.
---

# IDD Reference Manual

<!-- cspell:words VRC VRChat -->

This directory is the deeper reference manual for idd-skill. The root
README is the adopter landing page; use this page when you need the
operational details, maintenance notes, or background material behind
that overview.

The reference is Markdown-first and keeps stable file names so it can
also serve as the source for a future GitHub Pages site.

## Start Here

| Need                      | Read first                                                           | Why it helps                                                                |
| ------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Follow a complete example | [Build a VRC Event Calendar with IDD (Workshop)](workshop/README.md) | Demonstrates the IDD loop by building a VRChat event calendar from scratch. |
| Start adopting IDD        | [Getting started](getting-started.md)                                | Gives the shortest safe path from import to first loop.                     |
| Learn IDD vocabulary      | [Core concepts](concepts.md)                                         | Explains the loop's claims, review, merge, and cleanup terms.               |
| Customize IDD safely      | [Customization](customization.md)                                    | Names the adopter policy surfaces and workflow edit points.                 |
| Inspect policy defaults   | [Policy constants](policy-constants.md)                              | Inventories distributed timing, wait, and loop defaults.                    |
| Run the IDD loop          | [IDD workflow guide](idd-workflow.md)                                | Maps agent entry points, phase files, and Copilot advisory use.             |
| Find detailed references  | [Detailed reference](reference.md)                                   | Lists phase files and policy pages without duplicating rules.               |
| Import IDD into a repo    | [Template onboarding][template-onboarding]                           | Explains the portable template copy and placeholder flow.                   |
| Grant agent credentials   | [Permissions](permissions.md)                                        | Defines access profiles, forbidden scopes, and threat controls.             |
| Choose PR review policy   | [Review policy profiles](idd-review-policy-profiles.md)              | Names the default Copilot advisory policy and alternatives.                 |
| Understand the value prop | [Positioning](positioning.md)                                        | Summarizes where idd-skill fits among adjacent tools.                       |
| Plan future publication   | [Pages strategy](pages-strategy.md)                                  | Records the low-cost path toward GitHub Pages.                              |

### Project Strategy

Maintainer-facing investigation and design notes that record
distribution and positioning decisions for the project itself, as
distinct from the phase rules in `.github/instructions/`:

- [IDD Skill — Competitive Landscape and Positioning](positioning.md)
- [Claude Code Skill Strategy for the IDD Execution Loop](claude-skill-strategy.md)
- [Investigation: Skills-Based On-Demand Delivery of IDD Phase
  Instructions](skills-delivery-investigation.md)
- [Investigation: Microsoft APM as an Additional IDD Distribution
  Channel](apm-distribution-strategy.md)

## Reference Map

<!-- audit:generated id=docs-index-okf-table -->

<!-- dprint-ignore-start -->
| Type | Page | Description |
| ---- | ---- | ----------- |
| guide | [Customizing IDD](customization.md) | Lists which IDD surfaces adopters can safely customize and points to the authoritative file for each policy. |
| guide | [Getting Started with IDD](getting-started.md) | Walks a new adopter through the shortest safe path from deciding to adopt IDD to running the first Issue-Driven Development loop. |
| guide | [IDD Review Policy Profiles](idd-review-policy-profiles.md) | Names the supported PR review policy profiles and the instruction files an adopter must edit to select one other than the Copilot-advisory default. |
| guide | [Permissions and Threat Model](permissions.md) | Defines the credential profiles, merge-policy boundaries, and threat model an operator must choose before granting IDD agents GitHub access. |
| concept | [Core IDD Concepts](concepts.md) | Introduces the loop-engineering vocabulary and mental model behind the IDD phase instructions before diving into phase-by-phase rules. |
| reference | [IDD — Advisory-Wait Shell Fallback (AW1 / AW2 / AW3-R / AW3-S / AW3-H / F2 detail)](idd-advisory-wait-shell-fallback.md) | Provides the verbatim gh, gh api, jq, and curl commands the advisory-wait and F2 advisory-convergence shell fallbacks use when helper support cannot be trusted. |
| reference | [IDD Autonomy Contract](idd-autonomy-contract.md) | Classifies every externally visible IDD mutation as reversible or irreversible and names the gate or undo path for each. |
| reference | [IDD Comment Minimization](idd-comment-minimization.md) | Defines the live status digest contract and the safe procedure for minimizing completed review feedback and stale operational markers after merge. |
| reference | [IDD — Concept Ownership Matrix](idd-concept-ownership.md) | Answers which actor may touch a given IDD concept at a given phase without re-reading every instruction file. |
| reference | [IDD Resume — Detail Reference](idd-resume-detail.md) | Provides the full narrative detail behind idd-resume.instructions.md's compact routing tables for branches that need careful judgment. |
| reference | [Issue Authoring Skill Contract and Schema](issue-authoring-skill.md) | Defines the stable contract and output schema for the agent-facing issue authoring skill that prepares IDD-ready issues. |
| reference | [OKF Frontmatter Profile](okf-frontmatter.md) | Defines the OKF v0.1 frontmatter field profile, bundle scope, and conformance rules this repository's docs corpus adopts. |
| reference | [IDD Policy Constants](policy-constants.md) | Inventories the distributed IDD policy defaults and names which configuration surface owns each one. |
| reference | [PR Cleanup Backlog — Batch Run 001](pr-cleanup-backlog-batch-001.md) | Records the first batch execution of the historical merged-PR cleanup backlog campaign and how to continue subsequent batches. |
| reference | [IDD Detailed Reference](reference.md) | Maps each operational question to the authoritative phase file or policy page that answers it. |
| reference | [Stalled Session Quiet-Check Helper](stalled-session-quiet-check.md) | Documents the CLI usage, output schema, and required live rechecks for the Resume/S2 stalled-session quiet-check helper. |
| reference | [TypeScript helper sources](typescript-sources.md) | Explains the generated .mjs-from-.mts helper source layout, build commands, and drift guards this repository enforces. |
| reference | [Workshop Recording Toolchain](workshop/assets/recordings/README.md) | Explains how to store and reproduce source tapes for workshop terminal recordings. |
| reference | [Workshop Log Format](workshop/LOG-FORMAT.md) | Defines the conventions workshop log segments follow so they can be assembled and reviewed without reformatting. |
| reference | [Bootstrap Log Segment](workshop/log-segments/01-bootstrap.md) | Captures the timestamped bootstrap log segment of the VRChat Event Calendar IDD workshop session. |
| reference | [Infrastructure Setup Log Segment](workshop/log-segments/02-infrastructure.md) | Captures the timestamped infrastructure-setup log segment of the VRChat Event Calendar IDD workshop session. |
| reference | [Data Layer Log Segment](workshop/log-segments/03-data-layer.md) | Captures the timestamped data-layer log segment of the VRChat Event Calendar IDD workshop session. |
| reference | [Backend API Log Segment](workshop/log-segments/04-backend-api.md) | Captures the timestamped backend-API log segment of the VRChat Event Calendar IDD workshop session. |
| reference | [Frontend and Quality Hardening Log Segment](workshop/log-segments/05-frontend-quality.md) | Captures the timestamped frontend-and-quality-hardening log segment of the VRChat Event Calendar IDD workshop session. |
| reference | [VRChat Event Calendar IDD Workshop Log](workshop/workshop-log.md) | Is the complete timestamped record of the IDD session that built the VRChat Event Calendar from an empty repository to a working MVP. |
| workflow | [IDD workflow guide](idd-workflow.md) | Routes each agent to its entry file and the phase file matching its current state. |
| design | [AI tooling strategy](ai-strategy.md) | Explains why this repository prioritizes GitHub Copilot and how the other agent compatibility entry files should stay in sync with it. |
| design | [Claude Code Skill Strategy for the IDD Execution Loop](claude-skill-strategy.md) | Records the design evaluation and no-go decision for packaging the IDD execution loop as a Claude Code skill. |
| design | [IDD — Design Rationale and Maintainer Notes](idd-design-rationale.md) | Collects maintainer-facing rationale for why IDD phase rules exist as they do, organized by phase file. |
| design | [IDD Helper Script Evaluation](idd-helper-scripts.md) | Records the current adoption decision and trade-offs for IDD's optional helper scripts so future reviews do not re-evaluate them from scratch. |
| design | [GitHub Pages Readiness Strategy](pages-strategy.md) | Records the low-cost path and deferred decisions for turning the docs reference manual into a public GitHub Pages site. |
| design | [Weak-Model Authoring Lite Profile — Design](weak-model-authoring-lite-profile-design.md) | Records the design for a lite authoring profile that improves weak local model conformance with the issue-authoring skill. |
| design | [Weak-Model Lite Instruction Profile — Design](weak-model-lite-profile-design.md) | Records the design for a condensed IDD instruction profile targeting weak local models with ample context but low adherence. |
| investigation | [Investigation: Microsoft APM as an Additional IDD Distribution Channel](apm-distribution-strategy.md) | Records the findings and Go/No-Go recommendation on whether IDD should adopt Microsoft APM (Agent Package Manager) as an additional distribution channel for the template. |
| investigation | [Investigation: Harness-Orchestrated Execution Mode for Weak Local Models](harness-orchestrated-execution-investigation.md) | Records the findings and recommendation on whether to define a harness-orchestrated execution mode for weak local models. |
| investigation | [IDD Skill — Competitive Landscape and Positioning](positioning.md) | Analyzes the competitive landscape for idd-skill and summarizes its strategic position relative to adjacent tools. |
| investigation | [Investigation: Skills-Based On-Demand Delivery of IDD Phase Instructions](skills-delivery-investigation.md) | Records the findings and recommendation on whether to deliver IDD phase instructions as on-demand skill bundles. |
| tutorial | [Bonus: Deploy with Defang](workshop/bonus-defang-deployment.md) | Walks through the optional bonus path of deploying the workshop app from local Docker Compose to a Defang deployment. |
| tutorial | [Build a VRChat Event Calendar with IDD](workshop/README.md) | Walks through an end-to-end IDD workshop session that builds a VRChat event calendar example from an empty repository. |
<!-- dprint-ignore-end -->

<!-- /audit:generated -->

## Language Policy

The root README is bilingual. Deeper reference pages are English-first
unless a separate translation issue explicitly adds another language
surface. This keeps the operational documentation easier to keep in
sync while README remains friendly for first-time readers.

[template-onboarding]: https://github.com/kurone-kito/idd-skill/blob/main/idd-template/ONBOARDING.md
