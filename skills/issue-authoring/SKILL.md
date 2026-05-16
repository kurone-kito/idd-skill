---
name: issue-authoring
description: Draft or refine IDD-ready GitHub issues, roadmap issues, and sub-issues before the normal IDD execution loop begins. Use when a request is too large or ambiguous for one reviewable change, when work needs decomposition or dependency encoding, or when the user asks for issue drafting, roadmap planning, or parallelizable task breakdown.
---

# Issue Authoring

Use this skill to prepare issue-ready work before execution starts.
Keep the skill concise and treat the repository docs as the canonical
source for the full contract and schema.
The canonical source bundle lives in this repository; install copies in
the agent-specific skill directory your runtime reads.

## Stable Phases

Use two stable phases:

1. **Intake and Clarification** — inspect relevant context, identify
   ambiguity, run a secondary critique or explicit self-critique, and
   ask only the questions that block safe issue drafting. Keep
   clarification bounded; use the repository-local
   `issueAuthoring.maxClarificationRounds` value when available,
   otherwise default to 3 rounds.
2. **Decompose and Draft** — restate the request in implementation
   terms, split it into atomic tasks, classify readiness, reuse existing
   issues when safe, and draft the smallest issue shape that preserves
   dependencies and reviewability.

Preserve low-readiness work in stable buckets: ready, deferred,
needs-decision, blocked-by-human, and out-of-scope.

## Workflow

1. Read the bundled contract in
   [references/contract.md](references/contract.md).
2. Reuse or extend an existing issue before creating a new one.
3. Choose the smallest safe output shape:
   - orphan issue for one ready autonomous task only when the target
     repository is discoverable through `issue-scope: orphan-first` and
     any configured `orphan-first-policy` approval step can be completed
     after drafting
   - roadmap plus sub-issues for multi-task or multi-session work
   - stable non-ready buckets for deferred, needs-decision,
     blocked-by-human, or out-of-scope work
4. Resolve the target repository marker prefix before drafting hidden
   dependency markers. Use the prefix documented by the target
   repository's onboarding or IDD docs, and ask the user instead of
   guessing when the prefix is not discoverable.
5. Keep dependencies machine-readable and minimal:
   - roadmap identity via
     `<!-- <marker-prefix>-roadmap-id: ... -->`
   - active child issues via roadmap task-list links
   - issue-to-issue dependencies via `Blocked by #NNN`
   - sequential roadmap dependencies via
     `<!-- <marker-prefix>-blocked-by: ... -->` only when a separate
     roadmap
     must close first
   - keep independent sibling work in roadmap task lists unless a true
     correctness, availability, or ordering constraint requires a
     dependency edge
6. When the user explicitly authorizes publication, manage the authoring
   label for each created or updated issue:
   - resolve `issueAuthoring.authoringLabelName`, defaulting to
     `status:authoring`
   - create the label with `gh label create` before first use when the
     target repository does not already have it
   - treat label creation or application failure as a publishing blocker
   - apply the label before updating an existing issue
   - create new issues with the label when supported, or apply the label
     immediately after creation
   - if post-create label application fails, close, delete, or otherwise
     make the created issue undiscoverable before stopping
   - remove the label from all published issues only after the full set is
     published, the user confirms the result, and the user explicitly
     requests release from the authoring hold for IDD execution
   - leave the label in place if publishing is interrupted before release
7. Stop at the approval boundary. Drafting issues does not authorize
   publishing them or starting the IDD execution loop unless the user
   explicitly asked for that.

## Reference Routing

- For the bundled contract, output schemas, and discoverability guard:
  read [references/contract.md](references/contract.md).
- For the bundled boundary between pre-approval drafting and the IDD
  execution loop: read
  [references/workflow-boundary.md](references/workflow-boundary.md).
- For concrete drafting patterns and example prompts: read
  [references/draft-patterns.md](references/draft-patterns.md).
- When editing this bundle inside the source repository, keep the
  bundled references synchronized with the canonical maintenance docs in
  [../../docs/issue-authoring-skill.md](../../docs/issue-authoring-skill.md)
  and [../../docs/idd-workflow.md](../../docs/idd-workflow.md).

## Output Checklist

- Preserve low-readiness work in stable buckets instead of dropping it.
- Keep acceptance criteria explicitly verifiable.
- Keep human-dependent setup, review, and approval work isolated from
  ready execution issues whenever possible.
- Link every active child issue from its roadmap body.
- Justify each dependency edge and keep independent sibling work as
  roadmap task-list entries.
- Record reuse or extension decisions when the skill does not create a
  new issue.
- Avoid widening drafting output beyond the user request without saying
  so.
