# Bundled Issue Authoring Contract

This file keeps the `issue-authoring` bundle usable when it is installed
or copied outside this repository root. It mirrors the canonical
contract in `docs/issue-authoring-skill.md`.

## Target marker prefix

Resolve the target repository's hidden marker prefix before drafting any
roadmap or blocked-by marker.

- Use the prefix documented by the target repository's onboarding or
  IDD instructions.
- In this source repository the prefix is `idd-skill`, but installed
  bundles must not assume that value elsewhere.
- If the prefix is not discoverable from the repository docs or user
  context, stop and ask instead of emitting a guessed marker.

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

## Stable phases

The bundle uses two stable phases. These names mirror the canonical
contract and should stay stable for copied bundles.

### 1. Intake and Clarification

In this phase, the agent:

- inspects the relevant code, docs, and existing issues
- identifies assumptions and ambiguity that affect issue quality
- runs a secondary critique pass before drafting
- asks the user only the questions that block safe issue drafting

The critique pass is agent-neutral: use a subagent or rubber-duck
reviewer when available, otherwise run an explicit self-critique
locally. Clarification must be bounded; the default maximum is 3 rounds.
If safe drafting is still impossible after that, stop and report the
remaining blockers instead of looping indefinitely.

### 2. Decompose and Draft

In this phase, the agent:

- restates the clarified request in implementation-facing terms
- splits work into atomic tasks
- checks whether each task is suitable for autonomous execution
- reuses or extends existing issues before creating new ones
- drafts orphan issues, roadmap packages, sub-issues, or non-ready
  buckets as appropriate

## Readiness buckets

Do not silently drop low-confidence or low-readiness work. Route each
candidate task into one stable bucket:

- **ready**: passes limited scope, clear verification, and autonomous
  completion
- **deferred**: plausible, but priority, timing, or decomposition is not
  strong enough for execution
- **needs-decision**: depends on a product, policy, or design choice
- **blocked-by-human**: waits on a person, credential, asset, or outside
  system
- **out-of-scope**: does not belong in the repository or skill scope

## Reuse-first issue policy

Before creating any new issue, check whether the work already has a
suitable home.

Apply these checks in order:

1. If an existing open issue already matches the task and only lacks the
   new schema details, extend that issue instead of cloning it.
2. If an existing open roadmap already owns the initiative, add or
   refine task-list entries there instead of creating a competing
   umbrella.
3. If an existing issue is close but too broad, split follow-up work
   out of it rather than widening the original issue further.
4. If an existing issue is already claimed, has an open PR, or is
   otherwise being actively executed, avoid repurposing it. Create a
   follow-up issue or extend the roadmap around it instead.
5. Create a brand-new issue only when no existing issue can absorb the
   work without harming ownership, clarity, or reviewability.

Report when the bundle reuses, extends, or declines to reuse an issue
so a later session can follow the reasoning.

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

- Roadmap identity via `<!-- <marker-prefix>-roadmap-id: ... -->`
- Active child issues via roadmap task-list links
- Issue-to-issue dependencies via `Blocked by #NNN`
- Sequential roadmap dependencies via
  `<!-- <marker-prefix>-blocked-by: ... -->` only when a separate
  roadmap
  must close first

## Required draft content

### Orphan issue

- title with a concise user-facing summary
- `## Background` or `## Goal`
- `## Proposed change`
- `## Acceptance criteria`

Validation expectations:

- no `<marker-prefix>-roadmap-id` marker
- no `<marker-prefix>-blocked-by` marker
- acceptance criteria are explicitly verifiable
- the issue stays discoverable under the target repository's
  `issue-scope` setting

### Roadmap issue

- title that describes the umbrella initiative
- `## Goal`
- `## Background` or `## Why this matters`
- `## Tracks`
- `## Success criteria`
- one `<!-- <marker-prefix>-roadmap-id: <roadmap-id> -->` marker

Validation expectations:

- every active child issue is referenced from the roadmap body
- the roadmap explains why multiple issues exist
- sequencing and blocking are explicit

### Child issue under a roadmap

- title with a concrete task summary
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
