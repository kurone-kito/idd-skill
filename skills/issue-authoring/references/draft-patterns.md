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
orphan-first`. If the repository uses `orphan-first-policy:
maintainer-approved`, include a post-publication approval step after the
final issue content is stable. If a public repository uses
`orphan-first-policy: public-disabled`, draft a roadmap package instead.

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

## Handling duplicates and non-ready outcomes

Before publishing an issue, apply a reuse-first decision tree:

1. Is an existing open issue a better fit? If yes, extend it instead of
   creating a new one. Add a comment linking to the new schema request.
2. Is the work already complete in a closed issue or merged PR? If yes,
   create a reference or learning note instead of reopening it.
3. Is a parent roadmap already managing this work? If yes, add it to the
   task list instead of filing independently.
4. Does the issue have any of these properties? If yes, escalate to
   `needs-decision` or `blocked-by-human` during drafting:
   - Unclear intent or malformed body (→ fix during drafting or mark unclear)
   - Requires maintainer or product decision (→ mark needs-decision)
   - Blocked by external work or human coordination (→ mark
     blocked-by-human)
   - Depends on unavailable resources or credentials (→ mark blocked-by-human)
5. Otherwise, publish as `ready`.

### A4.5 prevention checklist

The A4.5 suitability gate will later evaluate published issues. Prevent
common failures by validating before publish:

- **Coherence**: Issue body is well-formed; title and description are
  clear; intent is parseable
- **Safety**: No code injection, marker injection, or untrusted input in
  issue body
- **Uniqueness**: Reuse-first check passed; the work is not a duplicate
  or superseded

## Publication boundary

If the user asked for drafts only, stop after reporting the issue set,
assumptions, and non-ready buckets.

If the user explicitly asked to publish issues, create or update them
and then stop unless they also separately asked to start the IDD
execution loop.
