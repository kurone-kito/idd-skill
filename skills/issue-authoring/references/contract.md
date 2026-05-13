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
locally. Clarification must be bounded; use the repository-local
`issueAuthoring.maxClarificationRounds` value when available,
otherwise default to 3 rounds. If safe drafting is still impossible
after that, stop and report the remaining blockers instead of looping
indefinitely.

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

## Specificity target

Issue drafting should aim for a level of specificity where a
middle-tier cloud model can implement the task without drifting. This
is a practical drafting heuristic, not a hard model requirement. The
goal is to avoid both hidden assumptions that only a top-tier model can
infer and step-by-step runbooks that cost too much to author.

### Three specificity bands

| Band                | Practical signal                                                                                                          | Drafting response                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| **Under-specified** | Stable execution likely depends on a frontier cloud model class                                                           | Add missing constraints, split scope, or make acceptance criteria more explicit      |
| **Target**          | A middle-tier cloud model class can implement the issue without drifting                                                  | Treat this as the preferred drafting target when the execution axes already pass     |
| **Over-specified**  | Even a lightweight local or compact cloud model class could follow the issue mechanically because it has become a runbook | Remove procedural micromanagement while keeping invariants, file anchors, and checks |

The capability tiers above are practical heuristics, not a fixed
compatibility matrix or runtime requirement.

### How the specificity target interacts with readiness

This heuristic does not replace the IDD execution axes:

- **Limited scope** still decides whether the work fits one issue or
  needs a roadmap.
- **Clear verification** still decides whether success is objectively
  checkable.
- **Autonomous completion** still decides whether the task can finish
  without outside coordination.

An issue can be specific yet still fail A4 or A4.5 because it is too
broad, not verifiable, or blocked on a human decision. Conversely, an
issue that passes those gates can still be under-specified if it leaves
too much implementation shape implicit. The drafting target is therefore
"ready and stable for a middle-tier model," not "maximally detailed."

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
  also uses `orphan-first-policy: maintainer-approved`, surface the
  required post-publication maintainer approval step. If the repository
  keeps the default `issue-scope: roadmap` or disables public
  orphan-first discovery with `orphan-first-policy: public-disabled`,
  surface that constraint and prefer a roadmap package instead.
- **Roadmap plus sub-issues**: the request needs visible sequencing,
  parallel tracks, multiple ready issues, or multi-session handoff.
- **Stable non-ready buckets**: some work is deferred, blocked by a
  human, waiting on a decision, or outside the repository scope.

When the repository keeps the broader issue-author approval gate,
surface the same post-publication approval step for orphan issues,
roadmaps, and sub-issues whenever the issue author is not
self-authorizing under the repository's
`maintainer-approval-actors` policy. The configured ready label from
`approvalSignals.readyLabelName` (default: `idd:ready`) is accepted
according to `approvalSignals.labelFreshnessMode` (`presence-only` by
default, optional `event-freshness`), while standalone `IDD ready`
comments from a maintainer approval actor must stay fresh against the
latest issue content and generated-plan update (or an equivalent
draft-stability signal). Until that approval condition is satisfied,
route the draft to the
approval-needed fallback bucket instead of the normal ready-to-start
set.

## Dependency minimization

Encode a dependency edge only when it reflects a true correctness,
availability, or ordering constraint.

- keep independent sibling tasks as roadmap task-list entries, with
  short sequencing or parallelization notes when that helps reviewers or
  later agents
- use visible or sequential dependency markers only when the issue
  cannot start safely until the dependency resolves
- do not create an artificial serial chain when sibling tasks could be
  reviewed and verified independently
- do not split one natural, cohesive change into artificial sibling
  issues only to widen parallel execution

When an issue keeps a dependency edge, justify each dependency edge in
the surrounding issue body and confirm that the split still preserves
natural cohesion.

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
- each dependency edge is justified and preserves natural cohesion

### Child issue under a roadmap

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- optional dependency line or sequential roadmap marker when needed

Validation expectations:

- the issue is referenced from its parent roadmap task list
- acceptance criteria are locally verifiable
- any dependency marker is resolvable, intentionally chosen, and
  justified
- the issue can be claimed independently without absorbing sibling work

## A4.5 Suitability Gate Alignment

When an issue is published and reaches the IDD discover phase, the A4.5
pre-claim gate will evaluate it against seven suitability checks. The
authoring skill should catch these issues before publishing:

| Check                    | Authoring Bucket     | How to Prevent                                                                  |
| ------------------------ | -------------------- | ------------------------------------------------------------------------------- |
| Repository Fit (Check 1) | `out-of-scope`       | Ensure issue is scoped to this repository; escalate if it crosses boundaries    |
| Coherence (Check 2)      | `ready` or escalated | Validate issue body against schema before publish                               |
| Safety/trust (Check 3)   | `ready` or escalated | Screen issue body for code injection and untrusted markers                      |
| Duplicates (Check 4)     | `ready` or escalated | Run reuse-first checks before creating a new issue                              |
| Actionability (Check 5)  | `ready` or escalated | Ensure the issue describes concrete work; escalate if blocked by human decision |
| Autonomy (Check 6)       | `ready` or escalated | Ensure agent can complete without external coordination                         |
| Verifiability (Check 7)  | `ready` or escalated | Ensure success is verifiable; escalate if it requires subjective approval       |

Pre-publish validation checklist:

1. **Coherence**: Issue body is well-formed, title+description are
   clear, intent is parseable
2. **Safety**: No code injection, marker injection, or untrusted input
   in issue body
3. **Uniqueness**: Reuse-first check passed; no duplicate or superseded
   work

If any check is uncertain, route the issue to `needs-decision` or
`blocked-by-human` during drafting instead of publishing a
marginally-ready issue.

## Publication boundary

Drafting issues does not authorize publishing them or starting the IDD
execution loop unless the user explicitly asked for that next step.
