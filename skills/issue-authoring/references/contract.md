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

**Claim-state precondition (check this first).** Before reusing or
extending _any_ existing issue, determine whether it has an **active
claim** (its latest valid `claimed-by` comment is newer than the
configured `claim-stale-age`; distributed default 24 h) or an **open
PR**, or is otherwise actively executing. If so, you **MUST NOT edit its
body**: the working agent snapshots the issue body into its B2 plan and
treats that plan as authoritative — it never re-reads the body, so a
post-claim body edit is silently lost and becomes an implementation gap.
You **may** add a separate **comment** (never an edit or append to the
body), but **must not** rely on the claimed agent acting on it. Cover
the intended change with a **follow-up issue** (or a roadmap track around
it), and you **SHOULD** post a cross-reference comment on the claimed
issue linking the follow-up. Stale or reclaimable claims (latest
`claimed-by` older than `claim-stale-age`) are exempt — the next claimer
re-reads the latest body, so editing them is safe.

Then apply these checks in order:

1. If an existing open issue already matches the task and only lacks the
   new schema details, extend that issue instead of cloning it.
2. If an existing open roadmap already owns the initiative, add or
   refine task-list entries there instead of creating a competing
   umbrella.
3. If an existing issue is close but too broad, split follow-up work
   out of it rather than widening the original issue further.
4. If an existing issue has an **active claim**, an open PR, or is
   otherwise being actively executed, do **not** edit its body or
   repurpose it (see the claim-state precondition, which exempts
   stale/reclaimable claims); create a follow-up issue or extend the
   roadmap around it instead.
5. Create a brand-new issue only when no existing issue can absorb the
   work without harming ownership, clarity, or reviewability.

Report when the bundle reuses, extends, or declines to reuse an issue
so a later session can follow the reasoning.

## Output chooser

Choose the smallest safe output shape:

- **Orphan issue**: one autonomous task can finish the work, no
  roadmap-level coordination is needed, and the target repository
  discovers orphans — i.e. `issue-scope` is `roadmap-first` (the
  default; orphans are picked up as the fallback when no roadmap work is
  startable) or `orphan-first` (orphans first). If the repository uses
  `orphan-first-policy: maintainer-approved`, surface the required
  post-publication maintainer approval step. If the repository sets
  `issue-scope: roadmap` (roadmap-only) or disables public orphan-first
  discovery with `orphan-first-policy: public-disabled`, surface that
  constraint and prefer a roadmap package instead.
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

## Human-dependency isolation

Treat unresolved human dependency as a side effect that should be
isolated away from ready execution issues whenever possible.

- **Front-load** human-dependent work when coding cannot start safely
  until a person provides a decision, credential, permission,
  maintainer-only action, external setup, or policy choice, or until an
  unavailable system becomes usable again.
- **Back-load** human-dependent work when the remaining dependency is
  subjective review, publication choice, optional polish, or another
  post-implementation judgment that should not block an otherwise
  autonomous core change.
- Keep the central execution issue as close as possible to a pure
  autonomous unit: clear repository-local scope, no hidden human handoff
  in the implementation steps or acceptance criteria, and objective
  verification.
- Preserve unavoidable human-dependent work in an explicit stable
  bucket, dependency edge, or approval-needed hold rather than mixing it
  into a ready issue.
- Route unresolved choices to `needs-decision`, route waiting on people,
  credentials, maintainer-only actions, or unavailable systems to
  `blocked-by-human`, use `deferred` when timing or decomposition is not
  strong enough yet, and keep approval-gated ready work in the
  approval-needed hold instead of the normal ready-to-start set.
- If a task cannot be expressed without unresolved human coordination in
  the middle of implementation, it is not yet `ready`.

This principle complements the execution axes rather than replacing
them: it is a practical way to protect autonomous completion and clear
verification during issue drafting.

## Hidden human-dependency validation

Before publishing a `ready` issue, run a short pre-publication check for
hidden human dependency. Treat this as a routing aid, not a rigid
wording linter: the question is whether the work still depends on
unresolved human action, not whether the draft used one forbidden
phrase.

Ask these checks:

1. Does implementation require credentials, external access, hardware,
   or infrastructure that the executing agent cannot already reach? If
   yes, route the work to `blocked-by-human` unless that dependency can
   be front-loaded into a separate prerequisite issue.
2. Does any implementation step or acceptance criterion depend on a
   product, policy, or design decision that has not been made? If yes,
   route the work to `needs-decision`.
3. Do the acceptance criteria require subjective human approval instead
   of objective verification? If yes, rewrite the ready issue around
   measurable checks and back-load the optional review or publication
   judgment.
4. Does a roadmap narrative hide human-dependent work inside prose while
   the visible task list presents the item as execution-ready? If yes,
   preserve that work in an explicit stable bucket, approval-needed
   hold, or blocking issue instead of burying it in the narrative.
5. Is any dependency marker being used only to group related work or
   express preference order? If yes, remove the fake blocker and use
   task-list structure or sequencing notes instead. Keep dependency
   edges only for true start blockers.

Normal post-implementation code review, merge approval, or publication
choice does not by itself make an otherwise autonomous issue non-ready.
The ready issue should still carry its own objective verification even
when a human will look at the result afterward.

## Codebase-fidelity validation

Before publishing a `ready` issue, run a short pre-publication check that
the spec stays faithful to the existing codebase. Treat this as a routing
aid, not a rigid wording linter: A4.5 suitability triage is structural and
does not read the codebase, so a spec that contradicts established
semantics can still pass that gate and only surface the mismatch in
advisory review, costing extra review-fix round-trips.

Ask these checks:

1. When an issue reuses an existing identifier or field name, confirm the
   specified value matches that name's established semantics in the
   codebase — do not overload a name with a new shape or source.
2. Flag values that are mutable at runtime — specify a live read at the
   point of use rather than a one-time capture at construction.
3. When an issue proposes to **delete, replace, or "align to upstream"**
   code, first check the target for an intentional-divergence signal — a
   local change made on purpose to differ from upstream. If one is present,
   require the issue body to acknowledge that divergence and justify
   overriding it, rather than silently reverting hardening a consumer added
   deliberately (blind "resync to upstream" resets are a recurring
   Discover→plan-cycle waste when the divergence turns out to be
   intentional). The recommended portable signal is a canonical inline
   code-comment convention (for example a `do-not-revert:` / `idd-divergence:`
   marker) — it travels with vendored files and needs no repo-wide label
   taxonomy. An owner/CODEOWNERS marker or a referenced tracking issue may
   also serve, but the code-comment convention is the recommended default.
   Do not hard-code any single consumer's divergence-tracking mechanism.

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
- when authoring a **docs or operator-help child that documents
  behavior implemented by sibling issues**, encode `Blocked by #NNN` for
  those implementation issues (or otherwise sequence the docs child to run
  after they merge) so the documentation is written against **shipped**
  behavior. Describing designed-but-unshipped behavior in the present
  tense is a recurring advisory-review-thrash pattern; "describe shipped
  behavior" is a true ordering constraint, so this edge is consistent
  with the encode-only-a-real-constraint rule above
- when authoring a **finalize or verify track whose acceptance criteria
  assert state produced by sibling implementation tracks**, encode
  `Blocked by #NNN` on **each** such sibling rather than stating the
  ordering only in prose. Discover and A4.5 honor the hard `Blocked by`
  edge, not a prose "runs after the siblings" note: A4.5 Actionability
  inspects the body, not completability, so a prose-sequenced finalize
  track reports startable the moment its build foundation closes, and
  claiming it then means either failing its acceptance criteria or doing
  the siblings' unmerged work

When an issue keeps a dependency edge, justify each dependency edge in
the surrounding issue body and confirm that the split still preserves
natural cohesion.

## Nested roadmap nodes

Use a nested roadmap when one roadmap track needs its own coordination
boundary, active child list, or multi-session handoff. A nested roadmap
is still a roadmap node, not a normal execution candidate.

Authoring rules:

- reference the nested roadmap from the parent roadmap task list instead
  of hiding it in prose
- give the nested roadmap its own roadmap marker and `## Tracks` section
  that links the active child work it coordinates
- treat the nested roadmap as a coordination/audit node for discovery
  and roadmap audit; do not draft it as normal A3/A4/A5 execution work
- use two-level or three-level nesting only when the intermediate
  roadmap has its own active child work or handoff boundary
- do not use `Blocked by #NNN` or
  `<!-- <marker-prefix>-blocked-by: ... -->` only to group leaf issues
  under an active nested roadmap; reserve those encodings for true
  execution dependencies or sequential roadmap dependencies between
  separate roadmaps

Validation expectations:

- each nested roadmap node is linked from its parent roadmap task list
- each nested roadmap node links its own active child work from its body
- cycles, duplicate references, and closed intermediate roadmaps with
  hidden open descendants must be surfaced as validation failures or
  explicit follow-up notes, not silently normalized away

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
- an autopilot-suitability footer at the end of the body (visible
  line + `<!-- <marker-prefix>-autopilot-suitability: N -->` marker;
  see [Autopilot-suitability score](#autopilot-suitability-score))
- an optional effort footer next to it (visible line +
  `<!-- <marker-prefix>-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Validation expectations:

- no `<marker-prefix>-roadmap-id` marker
- no `<marker-prefix>-blocked-by` marker
- acceptance criteria are explicitly verifiable
- the issue stays discoverable under the target repository's
  `issue-scope` setting
- exactly one autopilot-suitability footer with an integer 1-5
  marker; a score of `1` also carries `status:blocked-by-human`

### Roadmap issue

- title that describes the umbrella initiative
- `## Goal`
- `## Background` or `## Why this matters`
- `## Tracks`
- `## Success criteria`
- one `<!-- <marker-prefix>-roadmap-id: <roadmap-id> -->` marker
- an autopilot-suitability footer at the end of the body (visible
  line + `<!-- <marker-prefix>-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- <marker-prefix>-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Validation expectations:

- every active child issue or nested roadmap node is referenced from the
  roadmap body
- the roadmap explains why multiple issues exist
- sequencing and blocking are explicit
- each dependency edge is justified and preserves natural cohesion
- nested roadmap entries stay identifiable as coordination/audit nodes
  instead of normal execution leaves
- exactly one autopilot-suitability footer with an integer 1-5
  marker; a score of `1` also carries `status:blocked-by-human`

### Child issue under a roadmap

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- optional dependency line or sequential roadmap marker when needed
- an autopilot-suitability footer at the end of the body (visible
  line + `<!-- <marker-prefix>-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- <marker-prefix>-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Validation expectations:

- the issue is referenced from its parent roadmap task list
- acceptance criteria are locally verifiable
- any dependency marker is resolvable, intentionally chosen, and
  justified
- the issue can be claimed independently without absorbing sibling work
- exactly one autopilot-suitability footer with an integer 1-5
  marker; a score of `1` also carries `status:blocked-by-human`

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
4. **Human dependency isolation**: Ready issues do not hide unresolved
   decisions, credentials, subjective approvals, or mid-implementation
   human handoffs

If any check is uncertain, route the issue to `needs-decision` or
`blocked-by-human` during drafting instead of publishing a
marginally-ready issue.

## Autopilot-suitability score

> **Status.** Active contract. Authoring **emits** the score footer
> and Discover **ranks and routes** candidates by it (roadmap #759,
> fully merged). The score stays advisory: it never bypasses the
> A4.5/A5 gates and is fail-safe on absence.

Authored issues carry a persisted **autopilot-suitability score**
from 1 to 5 (higher = more autopilot-suitable). It is the durable,
graded form of the **Autonomous completion** execution axis: the
author makes the judgment once, while context is fresh, so the
Discover phase can rank and route candidates by a cheap read
instead of re-deriving autonomy per candidate.

| Score | Meaning                     | Typical signals                                                                                                          |
| ----- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 5     | Autopilot-ideal             | Fully specified; deterministic verification (tests/lint/CI/mechanical); no external systems; no human judgment; isolated |
| 4     | Strongly autopilot-suitable | Well-specified and verifiable; minor ambiguity resolvable from repo context; no external/human dependency                |
| 3     | Borderline / mixed          | Autopilot can likely finish but with notable judgment, weaker verification, or review-attention risk                     |
| 2     | Mostly human                | Agent may draft a partial result; completion needs human judgment, an asset, or review the agent cannot supply           |
| 1     | Human-only                  | Interactive credentials, real deployment, subjective/design/product judgment, or external coordination                   |

Scores below the configured discovery floor
(`autopilotSuitability.floor`, default `3`) designate
**human-oriented issues**: in autopilot runs Discover routes them
to humans rather than autopilot.

The score is recorded as a **footer at the end of the issue
body** — a visible line paired with a hidden, prefix-aware
machine marker, mirroring the `claimed-by` convention (visible
note + HTML marker):

```text
---

_Autopilot suitability: N / 5 -- higher is more autopilot-suitable;
below the configured floor is human-oriented._

<!-- {marker-prefix}-autopilot-suitability: N -->
```

Binding rules:

- **Authoritative value = the HTML marker**, read prefix-aware via
  `createMarkerRegex(markerPrefix, "autopilot-suitability")` exactly
  as `roadmap-id` / `blocked-by` are. `N` is an integer 1-5. The
  visible line is a human-readable mirror authoring keeps in sync;
  discovery parses only the marker.
- **Authoring marker, not operational marker.** This is body
  content like `roadmap-id`; it must never be added to
  `OPERATIONAL_MARKERS` in `scripts/protocol-helpers.mjs` or
  subjected to F4 minimization.
- **One source of truth.** A score of `1` must agree with
  `status:blocked-by-human`; never publish a contradiction.
- **Advisory, never a gate.** The score only ranks/routes
  candidates. The A4.5 suitability gate and A5 claim safety checks
  still run unchanged on whatever issue is selected; a high score
  never bypasses a gate.
- **Fail-safe on absence.** A missing, non-integer, or
  out-of-range marker means "no score": Discover evaluates the
  issue the normal way and never skips it. Pre-existing issues
  with no score keep flowing.

Backfill is opportunistic: when an existing open issue without a
score footer is next edited by the authoring flow, add one. No
bulk backfill of the existing backlog is required. The claim-state
precondition still applies — never add the footer to the body of an
actively-claimed or open-PR issue; defer it to a follow-up instead.

## Effort hint

Authored issues may also carry an **effort hint** — an author-time
`S | M | L` size estimate, recorded once while context is fresh, that
Discover consumes as a **soft selection tie-breaker** so autopilot tends
to clear small issues first and leave large ones for a fresh session.
Effort is distinct from the autopilot-suitability score: suitability
captures _autonomy_ (can an agent finish unattended), while effort
captures _size_ (a fully-autonomous issue can still be large).

| Hint | Meaning | Typical signals                                                                                     |
| ---- | ------- | --------------------------------------------------------------------------------------------------- |
| S    | Small   | One module / a few files; a single reviewable change; little or no review back-and-forth expected   |
| M    | Medium  | A helper plus its callers, or one instruction surface with mirrors and tests                        |
| L    | Large   | A new helper family, multi-file instruction rewrites, or work that tends to span many review rounds |

The hint is recorded as a **footer at the end of the issue body** — a
visible line paired with a hidden, prefix-aware machine marker, beside
the autopilot-suitability footer:

```text
---

_Effort: S | M | L -- author-estimated size; a soft autopilot
selection tie-breaker only._

<!-- {marker-prefix}-effort: S|M|L -->
```

Binding rules:

- **Authoritative value = the HTML marker**, read prefix-aware exactly
  as `autopilot-suitability` is. `S | M | L` is upper-cased on parse.
  The visible line is a human-readable mirror authoring keeps in sync;
  discovery parses only the marker.
- **Authoring marker, not operational marker.** Like
  `autopilot-suitability`, it is body content and must never be added to
  `OPERATIONAL_MARKERS` or subjected to F4 minimization.
- **Soft tie-breaker, never a gate.** Effort only reorders candidates
  **within** a single suitability-score band, after the score and
  optional desync rules and **before** the lowest-issue-number tie-break.
  It never skips, gates, crosses a score band, or bypasses the A4.5/A5
  gates, and a large (`L`) issue stays fully claimable when it is the only
  ready work.
- **Fail-safe on absence.** A missing, non-`S|M|L`, or conflicting
  marker means "no effort hint": selection behaves exactly as it does
  today (a missing hint sorts as the neutral middle, as-if `M`).
  Pre-existing issues with no effort footer keep flowing.

Backfill is opportunistic and follows the same claim-state precondition
as the suitability footer.

## Publication boundary

Drafting issues does not authorize publishing them or starting the IDD
execution loop unless the user explicitly asked for that next step.
