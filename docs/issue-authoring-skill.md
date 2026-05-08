# Issue Authoring Skill Contract

This document defines the contract for an agent-facing issue authoring
skill that prepares IDD-ready issues before the normal Discover →
Claim → Work loop begins.

It is a workflow contract, not a schema reference. Detailed draft
formats, roadmap markers, and decomposition templates belong to the
follow-up schema work.

## Purpose

Use the issue authoring skill to turn a user request into a safe,
reviewable issue set when direct implementation would otherwise skip the
issue hygiene that IDD depends on.

The skill exists to improve issue quality before execution, especially
when work will span multiple tasks, dependencies, or agent sessions.

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

The skill uses two stable phases.
These phase names are normative and should be reused by later
implementation work.

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
appropriate, but the detailed rules for those outputs are defined
separately from this contract.

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

This contract does not define:

- the exact issue body schema
- the marker syntax for roadmap and dependency metadata
- the scoring table for output readiness
- the repository-local skill folder structure

Those details should be owned by the follow-up schema and implementation
work so that this contract can remain stable across agent runtimes.
