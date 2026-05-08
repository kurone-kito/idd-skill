---
name: issue-authoring
description: Draft or refine IDD-ready GitHub issues, roadmap issues, and sub-issues before the normal IDD execution loop begins. Use when a request is too large or ambiguous for one reviewable change, when work needs decomposition or dependency encoding, or when the user asks for issue drafting, roadmap planning, or parallelizable task breakdown.
---

# Issue Authoring

Use this skill to prepare issue-ready work before execution starts.
Keep the skill concise and treat the repository docs as the canonical
source for the full contract and schema.

## Workflow

1. Read [the canonical contract and schema](../../docs/issue-authoring-skill.md).
2. Reuse or extend an existing issue before creating a new one.
3. Choose the smallest safe output shape:
   - orphan issue for one ready autonomous task
   - roadmap plus sub-issues for multi-task or multi-session work
   - stable non-ready buckets for deferred, needs-decision,
     blocked-by-human, or out-of-scope work
4. Keep dependencies machine-readable:
   - roadmap identity via `<!-- idd-skill-roadmap-id: ... -->`
   - active child issues via roadmap task-list links
   - issue-to-issue dependencies via `Blocked by #NNN`
   - sequential roadmap dependencies via
     `<!-- idd-skill-blocked-by: ... -->` only when a separate roadmap
     must close first
5. Stop at the approval boundary. Drafting issues does not authorize
   publishing them or starting the IDD execution loop unless the user
   explicitly asked for that.

## Reference Routing

- For the normative contract, schemas, and validation checklist: read
  [../../docs/issue-authoring-skill.md](../../docs/issue-authoring-skill.md).
- For the boundary between this native skill bundle and the execution
  instructions: read
  [../../docs/idd-workflow.md](../../docs/idd-workflow.md).
- For concrete drafting patterns and example prompts: read
  [references/draft-patterns.md](references/draft-patterns.md).

## Output Checklist

- Preserve low-readiness work in stable buckets instead of dropping it.
- Keep acceptance criteria explicitly verifiable.
- Link every active child issue from its roadmap body.
- Record reuse or extension decisions when the skill does not create a
  new issue.
- Avoid widening drafting output beyond the user request without saying
  so.
