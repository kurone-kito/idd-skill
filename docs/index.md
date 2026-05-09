# IDD Reference Manual

This directory is the deeper reference manual for idd-skill. The root
README is the adopter landing page; use this page when you need the
operational details, maintenance notes, or background material behind
that overview.

The reference is Markdown-first and keeps stable file names so it can
also serve as the source for a future GitHub Pages site.

## Start Here

| Need                      | Read first                                              | Why it helps                                                    |
| ------------------------- | ------------------------------------------------------- | --------------------------------------------------------------- |
| Start adopting IDD        | [Getting started](getting-started.md)                   | Gives the shortest safe path from import to first loop.         |
| Run the IDD loop          | [IDD workflow guide](idd-workflow.md)                   | Maps agent entry points, phase files, and Copilot advisory use. |
| Import IDD into a repo    | [Template onboarding][template-onboarding]              | Explains the portable template copy and placeholder flow.       |
| Grant agent credentials   | [Permissions](permissions.md)                           | Defines access profiles, forbidden scopes, and threat controls. |
| Choose PR review policy   | [Review policy profiles](idd-review-policy-profiles.md) | Names the default Copilot advisory policy and alternatives.     |
| Understand the value prop | [Positioning](positioning.md)                           | Summarizes where idd-skill fits among adjacent tools.           |
| Plan future publication   | [Pages strategy](pages-strategy.md)                     | Records the low-cost path toward GitHub Pages.                  |

## Reference Map

### Adoption and Onboarding

- [Getting started](getting-started.md) is the concise first-run path
  from template import to the first IDD execution loop.
- [Template onboarding][template-onboarding] is the canonical
  guide for importing the portable IDD template into another
  repository.
- [IDD workflow guide](idd-workflow.md) explains where each supported
  agent starts and which phase file to read next.
- [Permissions and threat model](permissions.md) describes the minimum
  GitHub access profiles, forbidden credentials, and operating controls
  for unattended or merge-capable agents.
- [IDD review policy profiles](idd-review-policy-profiles.md) explains
  the default Copilot advisory PR policy and non-default customization
  surfaces.

### Workflow Internals

- [IDD helper script evaluation](idd-helper-scripts.md) records why the
  current workflow stays portable shell / `gh` / `jq` instructions
  instead of requiring helper scripts.
- [IDD comment minimization](idd-comment-minimization.md) defines the
  safe post-merge cleanup policy for stale operational markers and
  completed feedback.

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

## Language Policy

The root README is bilingual. Deeper reference pages are English-first
unless a separate translation issue explicitly adds another language
surface. This keeps the operational documentation easier to keep in
sync while README remains friendly for first-time readers.

[template-onboarding]: https://github.com/kurone-kito/idd-skill/blob/main/idd-template/ONBOARDING.md
