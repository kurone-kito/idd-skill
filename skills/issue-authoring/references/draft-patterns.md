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

If the repository keeps the broader secure-by-default issue-author
approval gate, use the same post-publication approval note whenever the
issue author will not be self-authorizing under the repository's
`maintainer-approval-actors` policy. The configured ready label from
`approvalSignals.readyLabelName` (default: `idd:ready`) is accepted
according to `approvalSignals.labelFreshnessMode` (`presence-only` by
default, optional `event-freshness`), while standalone `IDD ready`
comments from a maintainer approval actor must stay fresh against the
latest issue content and generated-plan update (or an equivalent
draft-stability signal). Until that approval condition is
satisfied, later discovery should treat the issue as part of the
approval-needed fallback bucket instead of the normal ready-to-start
set.

Draft a roadmap plus sub-issues when the request needs visible
sequencing, parallel tracks, or multi-session handoff.

Draft only stable non-ready buckets when the work still depends on a
human decision, missing asset, or unclear verification.

## Specificity target

Execution-ready issue drafts should land in a middle band:

- **Under-specified**: a high-range model still has to infer the real
  implementation shape because the issue names only a vague goal,
  omits the likely surface to edit, or leaves verification too loose.
- **Target range**: a solid mid-tier cloud model can hold a stable plan
  without extra clarification. The issue points at the relevant
  document, schema, or code surface, explains the constraint, and keeps
  acceptance criteria verifiable without dictating every edit.
- **Over-specified**: even a lightweight model could follow the issue as
  a script because the body prescribes exact edit order, wording, or
  implementation steps that reviewers do not need.

If a draft feels like it needs a high-range model just to guess the intended
change, it is still too vague. If it reads like line-by-line assembly
instructions, it is too detailed.

## Specificity checklist before publishing

Before you publish a ready issue, confirm:

- the title and background name the concrete artifact or surface that
  should change
- a mid-tier cloud model could choose a stable implementation direction
  without hidden repository archaeology or a follow-up clarification loop
- the acceptance criteria verify the outcome, not a step-by-step
  implementation recipe
- candidate files, examples, and notes act as cues rather than an
  exhaustive script
- removing one concrete detail would make the issue feel high-range-only,
  while adding more detail would start turning it into a lightweight
  model script

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

## Dependency minimization examples

### Natural parallel decomposition

Roadmap `## Tracks` excerpt:

```md
- [ ] #401 — update the issue-authoring contract
- [ ] #402 — add draft-pattern examples

_Parallel note: #401 and #402 can proceed independently once the roadmap
exists because neither task depends on the other's output._
```

This is the preferred shape for sibling tasks that can be reviewed and
verified independently. The roadmap keeps both tasks visible in its task
list, and the short note explains the safe parallelism without adding a
fake `Blocked by` edge.

### Artificial decomposition

Bad serial chain:

```md
#401 — update the issue-authoring contract
#402 — add draft-pattern examples

Blocked by #401
```

This is over-serialized when `#402` can be reviewed and verified without
waiting for `#401`. Do not create a serial chain just to make the order
feel tidy.

Bad split for parallelism:

```md
#410 — add one checklist bullet
#411 — add one example paragraph
#412 — add one anti-pattern sentence
```

This is an artificial split when the three edits form one natural,
cohesive authoring change. Do not break a single reviewable task into
multiple sibling issues only to widen parallel execution.

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
   - Unclear intent or malformed body (→ fix during drafting or mark needs-decision)
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

## Specificity examples

### Under-specified draft

**Title**: `docs: improve issue authoring guidance`

Background: issue authoring should be clearer for agents.

Acceptance criteria:

- issue authoring is more consistent
- examples are improved

This is too vague because the draft does not tell the next agent which
authoring surface to edit, what kind of guidance is missing, or how a
reviewer would verify success. A high-range model would need to infer
the real task from surrounding repository context.

### Target range draft

**Title**: `docs: add specificity checklist to issue authoring draft patterns`

Background:
`skills/issue-authoring/references/draft-patterns.md` explains output
shapes, but it does not yet show how to judge whether an issue body is
too vague or too scripted for execution.

Acceptance criteria:

- `draft-patterns.md` includes a pre-publication specificity checklist
- the guidance distinguishes under-specified, target range, and
  over-specified issue drafts
- the examples focus on issue body wording and acceptance criteria
  granularity instead of prescribing implementation order

This is the target range because the next agent knows where to work, why
the change matters, and how to verify it, while still retaining freedom
to decide the exact wording and structure.

### Over-specified draft

**Title**: `docs: add specificity checklist to issue authoring draft patterns`

Proposed change:

1. Insert a new `## Specificity target` heading after `## Output chooser`.
2. Add exactly three bullets named `Under-specified`, `Target range`,
   and `Over-specified`.
3. Add a five-item checklist using the exact sentence order shown in the
   draft.
4. Copy the same example phrasing across every example block without
   changing any wording.

This is too detailed for authoring because it turns the issue into an
implementation script. Reviewers usually need the target outcome and the
verification shape, not a rigid edit order.

## Publication boundary

If the user asked for drafts only, stop after reporting the issue set,
assumptions, and non-ready buckets.

If the user explicitly asked to publish issues, create or update them
and then stop unless they also separately asked to start the IDD
execution loop.
