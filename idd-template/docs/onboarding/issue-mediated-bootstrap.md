---
type: reference
title: Onboarding Reference — Issue-Mediated Bootstrap
description: Documents an opt-in alternate bootstrap path that imports the IDD template through a reviewed issue-branch-PR cycle instead of theirs-flow's direct, unreviewed commit.
tags: [onboarding, bootstrap]
---

# Onboarding Reference — Issue-Mediated Bootstrap

Use this reference alongside `idd-template/ONBOARDING.md` when the
operator wants an audited bootstrap trail instead of the distributed
default direct-import ("theirs-flow") path. This page is the detailed
companion for the pointer subsection between Step 1C and Step 2.

**This mode is opt-in, not a replacement.** The existing direct-import
path (Steps 2, 4, 5, and 6 as already written in
`idd-template/ONBOARDING.md`) remains the default for every adopter who
does not explicitly choose this alternate. A brand-new repository
usually has no configured CI, branch protection, or Copilot review bot
yet, so routing the very first, most fragile action through a full
review-gated PR would add fragility without benefit for solo or simple
adopters.

## When to choose this mode

Theirs-flow accepts the template as a trusted baseline and imports it
with a direct commit — no GitHub issue, no PR-mediated review — then
hands off to the normal claim -> work -> PR -> CI -> merge loop for
everything that follows. Every other change an IDD-run project makes
flows through an issue and a reviewed PR; the bootstrap import itself
is the one exception.

Choose issue-mediated bootstrap instead when the operator wants that
exception closed from day zero — for example, a team whose change-control
policy requires every repository mutation to have a reviewable record, or
an operator who simply prefers not to grant an agent a direct-commit
path even for the first action. Treat this as an explicit operator
choice made alongside the other Step 1B policy decisions (see
[Onboarding Reference — Policy Decisions](policy-decisions.md)), not an
automatic upgrade applied whenever a review bot happens to be available.
If the operator does not state a preference, propose theirs-flow (the
default) and only switch modes on explicit confirmation.

## Drafting the bootstrap issue

Draft the bootstrap issue only after Steps 1A-1C conclude ("the
hearing"): the operator-confirmed placeholder values and the Step 1B
policy decisions must already be settled, because the issue body has to
carry them.

**The issue body must be self-contained.** Unlike a normal IDD issue,
there is no `.github/idd/config.json` yet in the target repository for
an executing session to read those values from — the target repository
is still pre-import. Embed the confirmed values for the placeholders
listed in [Onboarding Reference — Placeholder
Values](placeholders.md) directly in the issue body (the resolved
values themselves, not a reference to where they live), together with
the confirmed Step 1B decisions (merge policy, PR review profile,
review-thread resolution policy, and the rest of the list in
[Onboarding Reference — Policy Decisions](policy-decisions.md)).

**Pin the process reference.** The issue's process section must point
at idd-skill's own canonical `idd-template/ONBOARDING.md` Steps 2
(fetch or copy template files), 4 (replace placeholders), 5 (update
agent entry files), and 6 (verification checklist) — pinned to a
specific released tag or commit SHA, for example:

```text
https://raw.githubusercontent.com/kurone-kito/idd-skill/<tag-or-sha>/idd-template/ONBOARDING.md
```

Never reference the unpinned `/main/` URL for this purpose: an unpinned
reference can drift between when the issue is authored and when it is
executed, so the steps a reviewer approved may not be the steps that
actually ran.

### The status:authoring hold still applies

The issue-authoring skill's normal authoring-hold/release contract
still governs this draft: while the `status:authoring` label is present,
no session should treat the draft as ready, and removing the label is
what releases it for execution. That contract keeps working pre-import
because the label lives on the GitHub issue itself, not in the
repository tree — it needs no local IDD instructions to be present yet.

### Fill-in bootstrap-issue body template

Use this as the starting shape so an onboarding agent does not have to
improvise a self-contained body from scratch each time. It follows the
issue-authoring skill's orphan-issue schema (`## Background`,
`## Proposed change`, `## Acceptance criteria`, plus the
autopilot-suitability footer); fill in every bracketed value from the
hearing before publishing:

```markdown
## Background

This repository has not yet imported the IDD (Issue-Driven Development)
workflow. The operator chose the issue-mediated bootstrap path over the
direct-import default: this issue is the reviewable record of that
import instead of an unreviewed direct commit.

## Proposed change

Import the IDD template into this repository by following
`idd-template/ONBOARDING.md` Steps 2, 4, 5, and 6, pinned to
[<tag-or-sha>](https://raw.githubusercontent.com/kurone-kito/idd-skill/<tag-or-sha>/idd-template/ONBOARDING.md)
— never the unpinned `/main/` reference.

Use these operator-confirmed values, already collected during the
hearing (Steps 1A-1C), instead of re-deriving them:

- Repository name: <value>
- Marker prefix: <value>
- Trusted marker actor: <value>
- Fix-validate commands: <value>
- Pre-push-validate commands: <value>
- Post-fix-validate commands: <value>
- Install-deps command: <value>

And these confirmed Step 1B policy decisions — record them per Step 3
alongside the Steps 2/4/5/6 import above, since Step 3 is a local
recording action rather than a pinned remote-fetch step:

- Merge policy: <value>
- PR review policy profile: <value>
- Review-thread resolution policy: <value>
- Critique-loop profile: <value>
- Credential scope: <value>
- Claim-timing defaults: <value>
- CI wait policy defaults: <value>
- Issue-author approval gate: <value>
- Maintainer approval actor policy: <value>
- Issue-authoring companion status: <value>
- Helper runtime profile: <value>
- IDD label names: <value>
- Up-to-date-head ruleset check: <value>

This is a single, atomically-reviewable change: the core import,
placeholder substitution, and agent-entry-file updates land together,
and Step 6 verification confirms the result before merge. Optional
add-ons (worktree guard activation, the `idd-doctor` CI health gate, the
`idd-advisory-convergence` required-check workflow, the issue-authoring
companion install) are explicitly out of scope here — they follow as
separate issues once this one merges.

Execution for this issue is issue -> branch -> PR -> (a human or a
narrowly-scoped, pre-authorized agent) merge — not the full autonomous
Discover -> Claim -> Work loop. Discover cannot select this issue: no
`.github/instructions/idd-*.instructions.md` or `.github/idd/config.json`
exist in this repository's tree yet to route it. CI and advisory review
are not yet configured in this repository at this stage — that is
expected, not a skipped gate.

## Acceptance criteria

- Every file listed in `idd-template/ONBOARDING.md` Step 2 is present in
  this repository.
- No onboarding placeholder strings remain, per Step 4 (outside the
  meta-docs that intentionally keep them literal).
- Root agent entry files exist and reference the IDD workflow, per Step 5.
- Every Step 6 verification checklist item passes.
- The confirmed Step 1B policy decisions are recorded in the imported
  repository per Step 3.

_Autopilot suitability: 1 / 5 — this issue is not Discover-routable
before import completes; a human or a narrowly-scoped, pre-authorized
agent executes it directly instead._

<!-- <marker-prefix>-autopilot-suitability: 1 -->
```

Replace `<marker-prefix>` in the marker with the confirmed marker-prefix
value from the hearing before publishing — see the `PROJECT_MARKER_PREFIX`
placeholder in
[Onboarding Reference — Placeholder Values](placeholders.md) for how
that value is derived. The suitability score of `1` reflects that
Discover structurally cannot route this issue pre-import, not a quality
judgment about the change itself; per the issue-authoring skill's
contract, a score of `1` also carries the `status:blocked-by-human`
label, which correctly signals that this issue needs a human or a
narrowly-scoped, pre-authorized agent rather than the ordinary
autonomous loop.

## Scope: exactly one issue

Keep the core import as a single issue: the template file copy,
placeholder substitution, and agent-entry-file updates, together with
Step 6 verification, all land as one cohesive, atomically-reviewable
change. A half-imported tree fails `--verify` — for example, agent entry
files that reference an IDD workflow whose instruction files were never
copied — so this work cannot be safely split across multiple issues or
merged in a partial state.

## Optional add-ons stay separate follow-ups

Draft the following as separate follow-up issues instead of folding them
into the core bootstrap issue:

- worktree guard activation
- the `idd-doctor` CI health gate
- the `idd-advisory-convergence` required-check workflow
- the issue-authoring companion install

None of these are required for the repository to become
IDD-operational, and unlike the core import, each one can run through
the real Discover -> Claim -> Work loop once the core bootstrap issue
merges — the local IDD instructions and policy files that Discover needs
already exist by then.

## Execution: issue -> branch -> PR -> merge, not the full loop

Executing the bootstrap issue itself is issue -> branch ->
PR -> (a human or a narrowly-scoped, pre-authorized agent) merge —
explicitly not the full autonomous Discover -> Claim -> Work loop:

- **Discover cannot select the issue.** No
  `.github/instructions/idd-*.instructions.md` or
  `.github/idd/config.json` exist in the target repository's tree yet to
  route it — there is nothing for Discover to read.
- **CI and advisory-review gates are structurally inapplicable at this
  stage, not silently skipped.** Name that explicitly in the PR
  description rather than leaving it implicit, so a reviewer does not
  mistake the absence of CI runs or an advisory review for a skipped
  gate on an otherwise-normal PR.

Once this PR merges, the repository is IDD-operational and every
subsequent change — including the optional add-ons above — runs through
the normal claim -> work -> PR -> CI -> merge loop.
