# Draft Patterns

Load this file after reading
[`contract.md`](contract.md) when you need concrete examples or a quick
chooser for output shapes.

## Example triggers

- "Break this request into IDD-ready issues before we implement
  anything."
- "Draft a roadmap for this feature and split the ready work."
- "Turn this broad request into reviewable orphan issues."
- "Check whether an existing issue should be extended instead of opening
  a new one."

## Output chooser

Draft an orphan issue only when one autonomous task can finish the work
and the target repository is discoverable through `issue-scope:
orphan-first`.

Draft a roadmap plus sub-issues when the request needs visible
sequencing, parallel tracks, or multi-session handoff.

Draft only stable non-ready buckets when the work still depends on a
human decision, missing asset, or unclear verification.

## Example orphan issue

- `## Background` or `## Goal`
- `## Proposed change`
- `## Acceptance criteria`
- optional `## Candidate files`

Use this shape when the work is narrow enough to pass the IDD viability
gate on its own and the target repository can actually discover orphan
issues. If the repository keeps the default `issue-scope: roadmap`,
prefer a one-item roadmap package instead of publishing a standalone
orphan issue.

## Example roadmap package

Roadmap issue:

- `## Goal`
- `## Background` or `## Why this matters`
- `## Tracks`
- `## Success criteria`
- one `<!-- <marker-prefix>-roadmap-id: ... -->` marker

Child issue:

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- optional dependency line or sequential roadmap marker when needed

Keep ready child issues in the roadmap task list rather than grouping
them with hidden dependency markers.

Resolve `<marker-prefix>` from the target repository's onboarding or IDD
docs before publishing the draft. Use `idd-skill` only when the target
repository actually configured that prefix.

## Publication boundary

If the user asked for drafts only, stop after reporting the issue set,
assumptions, and non-ready buckets.

If the user explicitly asked to publish issues, create or update them
and then stop unless they also separately asked to start the IDD
execution loop.
