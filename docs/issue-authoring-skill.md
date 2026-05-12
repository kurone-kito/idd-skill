# Issue Authoring Skill Contract and Schema

This document defines the stable contract and output schema for an
agent-facing issue authoring skill that prepares IDD-ready issues before
the normal Discover → Claim → Work loop begins.

The contract explains when the skill should run and how it should
behave. The schema explains what a ready orphan issue, roadmap issue,
or sub-issue must contain so the later IDD discover phase can consume
the result safely.

The canonical bundle in this repository lives at
`skills/issue-authoring/`. When adopters install it in another
repository, they should copy it into the agent-specific skill directory
their runtime reads, such as `.github/skills/`, `.claude/skills/`, or
`.agents/skills/`.

## Purpose

Use the issue authoring skill to turn a user request into a safe,
reviewable issue set when direct implementation would otherwise skip the
issue hygiene that IDD depends on.

The skill exists to improve issue quality before execution, especially
when work will span multiple tasks, dependencies, or agent sessions.

It is a source bundle, not the execution loop itself: the bundle lives
in `skills/issue-authoring/` here, while installed copies belong in the
skill directory for the runtime that will load them.

## Trigger policy

Invoke the skill when one or more of the following are true:

- the request is too large or ambiguous for a single direct
  implementation pass
- the likely solution needs decomposition into multiple atomic tasks
- dependencies or execution order need to be made explicit before work
  can start safely
- the user wants a roadmap, issue breakdown, or parallelizable work plan
- the repository would benefit from IDD-ready issue hygiene before any
  implementation begins

Skip the skill and continue directly with implementation when all of the
following are true:

- the task is small enough to complete in one reviewable change
- verification is already clear
- no roadmap, dependency marker, or issue split is needed
- the user did not ask for issue drafting or planning first

## Stable phases

The skill uses two stable phases. These phase names are normative and
should be reused by later implementation work.

### 1. Intake and Clarification

In this phase, the agent:

- inspects the relevant code, docs, and existing issues
- identifies missing context, assumptions, and ambiguity that could
  affect issue quality
- runs a secondary critique pass on the emerging interpretation
- asks the user only the questions that block safe issue drafting

The secondary critique pass must be agent-neutral:

- if the agent runtime offers a subagent, rubber-duck helper, or
  equivalent review primitive, it may use that
- otherwise, the agent performs an explicit self-critique pass locally

Clarification must converge. The skill should:

- use a bounded number of clarification rounds, with a default maximum
  of 3
- avoid asking questions that are merely nice to know
- prefer explicit assumptions when issue drafting is still safe without
  immediate user input

If bounded clarification is exhausted and safe drafting is still not
possible, the skill should stop and report the unresolved blockers
instead of looping indefinitely.

### 2. Decompose and Draft

In this phase, the agent:

- restates the clarified request in implementation-facing terms
- breaks the work into atomic tasks
- evaluates whether each task is suitable for autonomous execution
- isolates low-autonomy work so it can be handled earlier, deferred, or
  surfaced for human decision
- checks whether an existing issue can be reused or extended before
  creating a new one

This phase may draft a roadmap issue, sub-issues, or orphan issues as
appropriate. The remaining sections of this document define the
normative rules for those outputs.

## Output readiness model

The skill must score each candidate task on the following axes before it
decides whether to draft an issue, split the work, or route it into a
non-ready bucket.

### Required execution axes

- **Limited scope**: the task fits a small, reviewable change. If the
  work is too broad for one issue, split it or create a roadmap.
- **Clear verification**: success can be checked through lint, tests,
  CI, or other explicit verification steps. If verification depends on
  unresolved product judgment, the work is not execution-ready.
- **Autonomous completion**: the work can finish without waiting for
  credentials, unavailable systems, or a human choice that has not yet
  been made.

These three axes align directly with the IDD viability gate in
`idd-discover.instructions.md`. A task is not draft-ready for execution
until all three pass.

### Supporting drafting axes

- **Dependency clarity**: dependencies are explicit, resolvable, and
  encoded in a form the discover phase can parse safely.
- **Confidence**: the agent has enough evidence to draft a stable issue
  instead of guessing at hidden scope or silently dropping uncertain
  work.

These supporting axes determine whether a ready task becomes an orphan
issue, a roadmap plus sub-issues, or a non-ready bucket.

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

## Stable readiness buckets

Low-confidence or low-readiness work must not be silently deleted. The
skill should route it into one of these stable buckets:

- **ready**: the work passes the execution axes and can be drafted as an
  orphan issue or as part of a roadmap.
- **deferred**: the idea is plausible, but priority, timing, or
  decomposition is not strong enough to make it a ready execution item.
- **needs-decision**: the work depends on a product, policy, or design
  choice that should be surfaced explicitly before execution.
- **blocked-by-human**: the work is waiting on a person, credential,
  asset, or outside system and therefore cannot complete autonomously.
- **out-of-scope**: the request does not belong in the repository or is
  materially outside the skill's target problem.

When the target repository keeps a secure-by-default issue-author
approval gate, a drafted issue can be execution-ready in content yet
still need a post-publication approval step before unattended execution
may start. In that case, keep the issue itself in the normal ready
shape, but state clearly that:

- the issue author is self-authorizing only when they satisfy the
  repository's `maintainer-approval-actors` policy
- otherwise an explicit approval signal is still required after the
  final issue content and generated-plan update are stable: the distributed
  `idd:ready` label is accepted by presence, and standalone `IDD ready`
  comments from a maintainer approval actor must stay fresh against the
  latest issue edits and generated-plan update (or an equivalent
  draft-stability signal)
- until that approval exists, later discovery should treat the issue as
  part of the approval-needed fallback bucket rather than the normal
  ready-to-start set

Do not treat organization `MEMBER` association alone or CODEOWNERS
coverage as a substitute for that repository-local approval rule.

Recommended routing rules:

- if only **limited scope** fails, split the work or draft a roadmap
- if **clear verification** fails because intent is unresolved, route to
  `needs-decision`
- if **autonomous completion** fails because a human must act, route to
  `blocked-by-human`
- if **confidence** is too low but the request may still become valid,
  route to `deferred`
- if the work does not belong in this repository, route to
  `out-of-scope`

## Alignment with A4.5 Suitability Gate

The IDD discover phase uses an A4.5 pre-claim suitability gate that
evaluates whether an already-published issue is suitable for autonomous
execution. This gate applies the same readiness buckets as the issue
authoring skill, **and adds new outcomes** for defects discovered at
discover time.

### Mapping authoring buckets to A4.5 outcomes

| Authoring Bucket     | A4.5 Gate Checks | Pass/Fail              | A4.5 Outcome       |
| -------------------- | ---------------- | ---------------------- | ------------------ |
| **ready**            | All 7 checks     | All pass               | **(pass)** → claim |
| **deferred**         | (not published)  | N/A during drafting    | Not yet evaluated  |
| **needs-decision**   | Check 5 or 7     | Fail on decision block | `needs-decision`   |
| **blocked-by-human** | Check 6          | Fail on autonomy block | `blocked-by-human` |
| **out-of-scope**     | Check 1          | Fail on scope check    | `out-of-scope`     |

### New A4.5 outcomes not in authoring buckets

The A4.5 gate may discover new issues that should have been caught
during drafting:

| A4.5 Outcome  | A4.5 Check | Meaning                               | Drafting Prevention                     |
| ------------- | ---------- | ------------------------------------- | --------------------------------------- |
| **unclear**   | Check 2    | Issue body is malformed or incoherent | Run coherence validation before publish |
| **invalid**   | Check 3    | Untrusted input or safety concern     | Screen for markers and code injection   |
| **duplicate** | Check 4    | Duplicate of existing work            | Run reuse-first check before publish    |

**Prevention during drafting**: Before publishing an issue, validate that
it will not fail A4.5 for coherence, safety, or uniqueness. If it would,
resolve the issue during drafting instead of publishing it.

## Reuse-first issue policy

Before creating any new issue, the skill should check whether the work
already has a suitable home.

Apply these checks in order:

1. If an existing open issue already matches the task and only lacks the
   new schema details, extend that issue instead of cloning it.
2. If an existing open roadmap already owns the initiative, add or
   refine task-list entries there instead of creating a competing
   umbrella.
3. If an existing issue is close but too broad, split follow-up work out
   of it rather than widening the original issue further.
4. If an existing issue is already claimed, has an open PR, or is
   otherwise being actively executed, avoid repurposing it. Create a
   follow-up issue or extend the roadmap around it instead.
5. Create a brand-new issue only when no existing issue can absorb the
   work without harming ownership, clarity, or reviewability.

The skill should report when it reuses, extends, or declines to reuse
an existing issue so a later session can follow the reasoning.

## Decomposition and roadmap planning rules

The skill should identify atomic execution units first, then decide how
to package them.

### Keep work as an orphan issue when all are true

- one atomic issue is enough to complete the request
- limited scope, clear verification, and autonomous completion all pass
- no roadmap-level dependency or parallel track is needed
- the work is unlikely to require multiple agent sessions
- the target repository already discovers orphan issues through
  `issue-scope: orphan-first`, and any configured
  `orphan-first-policy` approval step can happen after drafting; or the
  draft explicitly tells the operator to switch to that mode before
  starting the execution loop

### Create a roadmap when any are true

- the request requires more than one autonomous issue
- the work has a dependency chain that should be visible before
  execution starts
- two or more tracks can proceed in parallel and should be coordinated
- the request is likely to span multiple sessions or handoffs
- some tasks are ready now while others should be explicitly deferred,
  blocked, or sequenced behind earlier work

### Create sub-issues when a roadmap exists

Each ready execution unit under the roadmap should become its own
sub-issue when:

- it can be reviewed independently
- it has its own acceptance criteria
- it can be claimed by one agent without owning the whole roadmap

### Avoid these anti-patterns

- do not create a roadmap only because a description is long
- do not keep multiple unrelated atomic changes in one sub-issue
- do not create an artificial serial chain when sibling tasks could be
  reviewed and verified independently
- do not split one natural, cohesive change into artificial sibling
  issues only to widen parallel execution
- do not use hidden dependency markers to group active sub-tasks under
  an open roadmap
- do not hide low-confidence work by omitting it from the output

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

## Dependency encoding rules

The skill must encode dependencies in forms that the discover phase can
read safely.

### Roadmap identity marker

Every roadmap issue must include exactly one hidden roadmap marker in
its body:

```html
<!-- idd-skill-roadmap-id: <roadmap-id> -->
```

The `<roadmap-id>` should be stable, descriptive, and unique within the
repository.

### Roadmap membership

Ready sub-issues that belong under an active roadmap should be linked
from the roadmap body through task-list entries:

```md
- [ ] #123
- [ ] #124
```

This is the primary grouping mechanism for active roadmap work.

### Issue-to-issue dependencies

When one issue depends on a specific issue, use a visible dependency
line in the body:

```md
Blocked by #123
```

### Sequential roadmap dependency

Use a hidden `idd-skill-blocked-by` marker only when an issue must wait
for a separate roadmap to close before it becomes startable:

```html
<!-- idd-skill-blocked-by: <roadmap-id> -->
```

Do not use `idd-skill-blocked-by` to group children under the roadmap
that already owns them. Grouping belongs in the roadmap task list.

## Draft schemas

The following schemas are normative. The skill may add small
project-specific notes, but it should not omit the required structure.

### Orphan issue schema

Use an orphan issue for one ready, autonomous task that does not need a
roadmap and will remain discoverable under the target repository's
`issue-scope` setting.

Required content:

- title with a concise user-facing summary
- `## Background` or `## Goal`
- `## Proposed change`
- `## Acceptance criteria`

Optional content:

- `## Candidate files`
- `Blocked by #NNN`
- `## Notes`

Validation expectations:

- no `idd-skill-roadmap-id` marker
- no `idd-skill-blocked-by` marker
- acceptance criteria are testable or otherwise explicitly verifiable
- scope is narrow enough to pass the IDD viability gate as a single
  issue
- the draft preserves discoverability by using a repository configured
  for `issue-scope: orphan-first`, or by surfacing that configuration
  change before the operator starts the Discover -> Claim loop
- when the repository uses `orphan-first-policy: maintainer-approved`,
  the draft includes a post-publication maintainer approval step after
  the final title, body, and generated plan are stable

### Roadmap issue schema

Use a roadmap issue when a request needs multiple issues, visible
sequencing, or parallel tracks.

Required content:

- title that describes the umbrella initiative
- `## Goal`
- `## Why this matters` or `## Background`
- `## Tracks`
- `## Success criteria`
- one `<!-- idd-skill-roadmap-id: <roadmap-id> -->` marker

Recommended content inside `## Tracks`:

- track headings for major streams of work
- `- [ ] #NNN` task-list entries for ready child issues
- short sequencing or parallelization notes when they reduce collisions

Validation expectations:

- every active child issue is referenced from the roadmap body
- the roadmap explains why multiple issues exist instead of hiding them
  as narrative text
- dependency notes distinguish between active grouping and true
  sequential blocking
- each dependency edge is justified and preserves natural cohesion
- the roadmap can survive multi-session handoffs without relying on
  private session memory

### Sub-issue schema

Use a sub-issue for one atomic execution unit that belongs under a
roadmap.

Required content:

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`

Optional content:

- `## Candidate files`
- `Blocked by #NNN`
- `<!-- idd-skill-blocked-by: <roadmap-id> -->` when a separate roadmap
  must close first
- `## Notes`

Validation expectations:

- the issue is referenced from its parent roadmap task list
- acceptance criteria are locally verifiable
- any dependency marker is resolvable, intentionally chosen, and
  justified
- the issue can be claimed independently without absorbing sibling work

## Validation checklist for drafted output

Before reporting or publishing issue drafts, the skill should verify:

- each execution-ready issue passes limited scope, clear verification,
  and autonomous completion
- each deferred, blocked, or decision-dependent item was preserved in a
  stable bucket instead of being dropped
- each roadmap has one roadmap marker and uses task-list links for child
  issues
- each dependency edge is justified and preserves natural cohesion
- each `Blocked by #NNN` reference resolves to the intended issue
- each `idd-skill-blocked-by` marker points to a real roadmap and is
  used only for true sequential dependencies
- each issue body is explicit enough that a later discover pass can
  decide whether the issue is ready without reconstructing hidden
  context
- reuse or extension decisions are recorded when the skill chose not to
  create a new issue

## Repository-local implementation surface

This document is the canonical contract and schema for the repository's
native issue authoring bundle at `skills/issue-authoring/`.

Keep the implementation split on purpose:

- `skills/issue-authoring/SKILL.md` should stay concise and point back
  here for the normative rules, output schemas, and validation checklist
- `.github/instructions/*.instructions.md` remain the execution-layer
  files for the normal IDD loop after issue drafting is approved

Do not treat the native skill bundle and the execution instructions as
interchangeable entry points. The native bundle prepares issues; the
instruction files execute them.

## Approval boundary

Issue authoring and IDD execution are separate decisions.

By default, the skill should end by reporting:

- the proposed issue set
- the rationale for the decomposition
- any assumptions, open questions, or deferred decisions

Creating or editing GitHub issues requires explicit user approval unless
the current request already asks the agent to publish the issues.

Starting the IDD execution loop requires a separate explicit approval.
Drafting issues does not by itself authorize the agent to move into
Discover or Claim.

## Non-goals

This document does not define:

- the repository-local skill folder structure
- the exact prompt text used by a future `SKILL.md` implementation
- the GitHub API command sequences used to publish drafted issues

Those details should stay in the implementation layer so this document
can remain the stable contract and schema reference.
