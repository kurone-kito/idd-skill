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

## Reference Map

### Adoption and Onboarding

- [Getting started](getting-started.md) is the concise first-run path
  from template import to the first IDD execution loop.
- [Core IDD concepts](concepts.md) explains the key terms new adopters
  should know before reading strict phase rules.
- [Customizing IDD](customization.md) names the safe adopter policy
  surfaces for review, advisory, merge, CI, and discovery behavior.
- [Policy constants](policy-constants.md) inventories the distributed
  timing, wait, and loop defaults without changing workflow behavior.
- [Template onboarding][template-onboarding] is the canonical
  guide for importing the portable IDD template into another
  repository.
- [Permissions and threat model](permissions.md) describes the minimum
  GitHub access profiles, forbidden credentials, and operating controls
  for unattended or merge-capable agents.
- [IDD review policy profiles](idd-review-policy-profiles.md) explains
  the default Copilot advisory PR policy and non-default customization
  surfaces.

### Detailed Reference

- [Detailed reference](reference.md) is the compact phase and policy map
  for maintainers and agents who need an authoritative source link.
- [IDD workflow guide](idd-workflow.md) explains where each supported
  agent starts and which phase file to read next.
- [IDD helper script evaluation](idd-helper-scripts.md) records why the
  current workflow stays portable shell / `gh` / `jq` instructions
  instead of requiring helper scripts.
- [IDD comment minimization](idd-comment-minimization.md) defines the
  live status digest helper contract and safe post-merge cleanup policy
  for stale operational markers and completed feedback.
- [IDD concept ownership](idd-concept-ownership.md) is a
  Creator/Mutator/Verifier matrix for loop concepts (claim markers,
  review threads, PR body, ...), plus which actor/phase may take each
  concept to its terminal state.

### Native Companions

- [Issue authoring skill contract](issue-authoring-skill.md) describes
  the optional pre-execution helper for drafting IDD-ready roadmap and
  sub-issues before the Discover -> Claim -> Work loop begins, including
  where the source bundle lives and how to install it for each agent
  runtime.

### Project Strategy

- [Positioning](positioning.md) covers the competitive landscape,
  differentiators, and known gaps.
- [AI tooling strategy](ai-strategy.md) records the repository's
  Copilot-first guidance policy and how compatibility entry files are
  maintained for other agents.
- [GitHub Pages readiness strategy](pages-strategy.md) records the
  low-cost publication path and the reasons Pages is preferred over Wiki
  for the primary public reference.
- [Claude Code skill strategy](claude-skill-strategy.md) records the
  design evaluation and go/no-go criteria for packaging the IDD
  execution loop as a Claude Code skill.

## Language Policy

The root README is bilingual. Deeper reference pages are English-first
unless a separate translation issue explicitly adds another language
surface. This keeps the operational documentation easier to keep in
sync while README remains friendly for first-time readers.

[template-onboarding]: https://github.com/kurone-kito/idd-skill/blob/main/idd-template/ONBOARDING.md
