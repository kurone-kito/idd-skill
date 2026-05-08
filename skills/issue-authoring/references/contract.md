# Bundled Issue Authoring Contract

This file keeps the `issue-authoring` bundle usable when it is installed
or copied outside this repository root. It mirrors the canonical
contract in `docs/issue-authoring-skill.md`.

## Trigger policy

Use this bundle when direct implementation would skip the issue hygiene
that the IDD execution loop depends on.

Invoke it when one or more of the following are true:

- the request is too large or ambiguous for one reviewable change
- the likely solution needs decomposition into multiple atomic tasks
- dependencies or execution order must be made explicit before work can
  start safely
- the user wants a roadmap, issue breakdown, or parallelizable work
  plan

Skip it when all of the following are true:

- the task fits one reviewable change
- verification is already clear
- no roadmap, dependency marker, or issue split is needed
- the user did not ask for issue drafting first

## Output chooser

Choose the smallest safe output shape:

- **Orphan issue**: one autonomous task can finish the work, no
  roadmap-level coordination is needed, and the target repository is
  discoverable through `issue-scope: orphan-first`. If the repository
  keeps the default `issue-scope: roadmap`, surface that constraint and
  prefer a roadmap package instead.
- **Roadmap plus sub-issues**: the request needs visible sequencing,
  parallel tracks, multiple ready issues, or multi-session handoff.
- **Stable non-ready buckets**: some work is deferred, blocked by a
  human, waiting on a decision, or outside the repository scope.

## Required dependency encoding

- Roadmap identity via `<!-- idd-skill-roadmap-id: ... -->`
- Active child issues via roadmap task-list links
- Issue-to-issue dependencies via `Blocked by #NNN`
- Sequential roadmap dependencies via
  `<!-- idd-skill-blocked-by: ... -->` only when a separate roadmap
  must close first

## Required draft content

### Orphan issue

- title with a concise user-facing summary
- `## Background` or `## Goal`
- `## Proposed change`
- `## Acceptance criteria`

Validation expectations:

- no `idd-skill-roadmap-id` marker
- no `idd-skill-blocked-by` marker
- acceptance criteria are explicitly verifiable
- the issue stays discoverable under the target repository's
  `issue-scope` setting

### Roadmap issue

- title that describes the umbrella initiative
- `## Goal`
- `## Background` or `## Why this matters`
- `## Tracks`
- `## Success criteria`
- one `<!-- idd-skill-roadmap-id: <roadmap-id> -->` marker

Validation expectations:

- every active child issue is referenced from the roadmap body
- the roadmap explains why multiple issues exist
- sequencing and blocking are explicit

### Child issue under a roadmap

- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- optional dependency line or sequential roadmap marker when needed

Validation expectations:

- the issue is referenced from its parent roadmap task list
- it can be claimed independently without owning the whole roadmap

## Publication boundary

Drafting issues does not authorize publishing them or starting the IDD
execution loop unless the user explicitly asked for that next step.
