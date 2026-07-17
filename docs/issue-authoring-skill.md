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
  of 3 or the repository-local `issueAuthoring.maxClarificationRounds`
  value when the target repository records one
- avoid asking questions that are merely nice to know
- prefer explicit assumptions when issue drafting is still safe without
  immediate user input

If bounded clarification is exhausted and safe drafting is still not
possible, the skill should stop and report the unresolved blockers
instead of looping indefinitely.

**Under-clarification stop rule.** If, after bounded clarification, the
skill still cannot name the concrete surface to edit or an objective
verification for a candidate task, it should route that candidate to
`needs-decision` or ask, instead of publishing a confidently-vague
`ready` issue. Reliability over speed. This is distinct from the
"Under-specified" specificity band below: that band judges an
already-drafted body's wording, while this rule stops publication
earlier, during Intake, before a body is even drafted.

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

### Autopilot-suitability score

The **Autonomous completion** axis is also persisted as a graded
**autopilot-suitability score** (1-5, higher = more
autopilot-suitable) so the discover phase can rank and route
candidates without re-deriving the judgment. **Score every drafted
issue and emit it** as an end-of-body footer (a visible line plus
a hidden, prefix-aware marker
`<!-- {marker-prefix}-autopilot-suitability: N -->`). Discover
**ranks and routes** candidates by the score (roadmap #759, fully
merged); it stays advisory and fail-safe on absence. See the
[Autopilot-suitability score](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#autopilot-suitability-score)
section of the contract for the rubric, footer format, and binding
rules.

- `5` autopilot-ideal · `4` strongly autopilot-suitable ·
  `3` borderline · `2` mostly human · `1` human-only.
- Scores below the configured floor (`autopilotSuitability.floor`,
  default `3`) designate human-oriented issues that discover routes
  to humans in autopilot runs.
- The score is an **advisory** ranking/routing hint only; it never
  bypasses the A4.5/A5 gates, a `1` must agree with
  `status:blocked-by-human`, and a missing or out-of-range score is
  treated as having no score (evaluated normally, never skipped).

### Effort hint

Issues may also carry an author-time **effort hint** (`S | M | L`) that
captures _size_, distinct from the suitability score's _autonomy_. Emit
it as an optional end-of-body footer beside the suitability footer (a
visible line plus a hidden, prefix-aware marker
`<!-- {marker-prefix}-effort: S|M|L -->`). Discover consumes it as a
**soft selection tie-breaker** so autopilot tends to clear small issues
first and leave large ones for a fresh session. See the
[Effort hint](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#effort-hint)
section of the contract for the rubric, footer format, and binding
rules.

- `S` small · `M` medium · `L` large.
- The hint only reorders candidates **within** one suitability-score
  band (after the score and optional desync rules, before the
  lowest-issue-number tie-break); it never skips, gates, crosses a score
  band, or bypasses the A4.5/A5 gates, and a large issue stays claimable
  when it is the only ready work.
- A missing or invalid hint is **fail-safe**: selection behaves exactly
  as today (a missing hint sorts as the neutral middle, as-if `M`).

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
  final issue content and generated-plan update are stable: the
  configured ready label from `approvalSignals.readyLabelName`
  (default: `idd:ready`) is accepted according to
  `approvalSignals.labelFreshnessMode` (`presence-only` by default,
  optional `event-freshness`), and standalone `IDD ready` comments from
  a maintainer approval actor must stay fresh against the latest issue
  edits and generated-plan update (or an equivalent draft-stability
  signal)
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

### Mechanical pre-publish gate

Before publishing a drafted `ready` **orphan, roadmap, or sub-issue**
body (the linter's `orphan|roadmap|child` shapes; not the non-ready
buckets above), run the `audit-authored-issue` linter
(`scripts/audit-authored-issue.mjs` / `bin/idd-audit-authored-issue.mjs`)
against it when a helper runtime is available. It mechanically
re-checks a subset of the structural rules this document states in
prose — the autopilot-suitability marker's exactly-one/coherent-value
rule, the one-directional check that a suitability score of `1` carries
the configured `blocked-by-human` label (it does not check the reverse:
a non-`1` score paired with the label still passes), markerPrefix
consistency across every authoring marker, the declared shape's
required section headings, the roadmap-id/blocked-by dependency-marker
rules, and visible/hidden line agreement for the suitability and effort
footers.

It also emits one **advisory, warning-severity-only** finding
(`prose-dependency`): it flags an issue/PR reference (`#<digits>` or a
full GitHub issue/PR URL) used near coordination language (for example
"before", "after", "once", "until", "predates", "gate"/"gated",
"requires", "lands first") with no corresponding encoding for that
reference as one of three recognized forms — a `Blocked by #NNN` line,
a `Depends on #NNN` line, or a task-list checkbox item (`- [ ] #NNN`,
which counts regardless of which heading it sits under, so a roadmap's
own `## Tracks` membership list already satisfies this) — the
prose-only hard-precondition pattern the
[Hidden human-dependency validation](#hidden-human-dependency-validation)
check above warns about. A full-URL reference naming a different
repository is never flagged when the caller supplies the current
`owner/repo` (`--current-repo`, defaulting to `$GITHUB_REPOSITORY` in
CI) — a cross-repo dependency cannot be encoded with these
repository-local markers, so flagging it would recommend an impossible
fix; without that context every full-URL reference is still flagged. A
`prose-dependency` warning never flips `passed` to
`false` and never changes the linter's exit code; it prompts the author
to convert the prose into a proper dependency marker or consciously
confirm the reference is a mere breadcrumb.

```sh
node scripts/audit-authored-issue.mjs --shape <orphan|roadmap|child> \
  --marker-prefix <resolved-target-prefix> \
  --body-file <path-to-drafted-body> [--label <label>]...
```

**Always keep `--marker-prefix`, and always replace the placeholder**
with the resolved target prefix before running the command — in this
source repository that value is `idd-skill` (already the
`.github/idd/config.json` default here, so the flag is redundant only
in this one repository), but auditing any other repository requires
substituting that repository's own prefix. Never copy the literal
`idd-skill` value into another repository's audit command. Omitting the
flag entirely is unsafe everywhere: without it, the linter falls back
to reading `.github/idd/config.json` from the current working
directory and silently defaults to `idd-skill` when that file is
missing or unreadable, producing a false pass or fail against the
wrong prefix instead of an error. See the bundled `contract.md`'s
[Target marker prefix](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#target-marker-prefix)
section for the adopter-facing prefix-resolution rule.

**No helper runtime available (`instructions-only` profile).** The
linter cannot run without Node.js and the vendored `scripts/`
directory, and `instructions-only` is a first-class supported fallback,
not a waiver — manually re-verify the same checks against this
document's prose and the [Draft schemas](#draft-schemas) before
publishing.

A `passed: false` report (or non-zero exit, or a failed manual
re-verification) means the draft is not ready to publish yet. The
linter (or its manual equivalent) is a mechanical structural check, not
a substitute for the judgment-based checks above (human-dependency
isolation, codebase fidelity, reuse-first) — passing it is necessary,
not sufficient, for `ready`. See the bundled `contract.md`'s
[Mechanical pre-publish gate](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#mechanical-pre-publish-gate)
section for the adopter-facing version of this rubric.

## Authoring label lifecycle

The issue authoring skill must use the configured authoring label as a
publication guard while it creates or updates issues. The label name
comes from `issueAuthoring.authoringLabelName`, with `status:authoring`
as the distributed default.

During Phase 2 publishing, the skill must ensure the label exists in
the target repository before first use. For the bundled GitHub CLI
publication flow, create a missing label with `gh label create` before
applying it. Failure to create or apply the label is a publishing
blocker, not a warning.

For existing issues, apply the authoring label before updating issue
content. For new issues, prefer creating the issue with the authoring
label in the same publication command, such as `gh issue create --label`
when the bundled GitHub CLI flow can use it. If the flow cannot label
the issue atomically, apply the label immediately after creation. If
post-create label application fails, close the created issue before
stopping. Deletion needs admin permission the authoring agent typically
lacks (and `docs/permissions.md` forbids for normal IDD), so it is not the
default path.

These guards keep partially published issue sets visible to the IDD
discover guard while the full set is still being authored. Remove the
label from all published issues only after the complete issue set is
published, the user confirms the published result, and the user
explicitly requests release from the authoring hold for IDD execution.
If publishing is interrupted before that release, leave the label in
place so later discover passes route the issue through authoring-label
handling instead of normal ready-work discovery.

Removing the authoring label releases the Discover guard. Do it only as
part of the explicit execution handoff; publication confirmation alone
does not start Discover, Claim, and Work.

## Reuse-first issue policy

Before creating any new issue, the skill should check whether the work
already has a suitable home.

**Claim-state precondition (check this first).** Before reusing or
extending any existing issue, determine whether it has an active claim
(latest valid `claimed-by` newer than the configured `claim-stale-age`,
distributed default 24 h) or an open PR, or is otherwise actively
executing. If so, the skill **must not edit its body** — the working
agent snapshots the body into its B2 plan and never re-reads it, so a
post-claim edit is silently lost. A separate comment is allowed (never
an edit or append to the body) but must not be relied on to be picked
up; cover the change with a follow-up issue (or roadmap track), and the
skill **should** post a cross-reference comment on the claimed issue.
Stale or reclaimable claims (older than `claim-stale-age`) are exempt,
since the next claimer re-reads the latest body.

Then apply these checks in order:

1. If an existing open issue already matches the task and only lacks the
   new schema details, extend that issue instead of cloning it.
2. If an existing open roadmap already owns the initiative, add or
   refine task-list entries there instead of creating a competing
   umbrella.
3. If an existing issue is close but too broad, split follow-up work out
   of it rather than widening the original issue further. When the
   issue being split is itself a roadmap child, the skill should update
   the parent roadmap's `## Tracks` list in the same authoring action —
   add the new issue's link and adjust any sequencing notes (a short
   dated note is the observed good pattern) — subject to the
   claim-state precondition above applied to the roadmap issue's own
   claim/PR state, and record the provenance in the new issue's body
   (e.g., `Split out of #<n>`).
4. If an existing issue has an active claim, an open PR, or is
   otherwise being actively executed, do not edit its body or repurpose
   it (see the claim-state precondition, which exempts stale/reclaimable
   claims); create a follow-up issue or extend the roadmap around it
   instead.
5. Create a brand-new issue only when no existing issue can absorb the
   work without harming ownership, clarity, or reviewability.

The skill should report when it reuses, extends, or declines to reuse
an existing issue so a later session can follow the reasoning.

**Recent-window scan for just-discovered problems.** The checks above
assume the work already has a candidate home to reuse or extend. When
instead authoring an ad hoc issue for a problem **just discovered**
during the current session — a build-breaking regression noticed
mid-session, for example, rather than a task drafted from an existing
backlog — the skill should run a recent-window duplicate scan
immediately before publishing: list the newest issues regardless of
state and check whether a concurrent session already authored the
same problem.

```sh
gh issue list --repo <owner>/<repo> --state all --limit 20
# or, scoped to a recency window:
gh issue list --repo <owner>/<repo> --state all --search "created:>=<YYYY-MM-DD>"
```

A hit routes back into the checks above: extend the discovered issue
instead of publishing a duplicate. When the race slips past this scan
anyway (near-simultaneous discovery), the outcome is **anticipated and
self-resolving, not a coordination failure**: both sessions proceed
independently through their own claim and implementation cycle;
whichever PR merges first wins; the other session manually verifies
the fix already landed on the default branch, then closes its own
issue and (unmerged) PR as superseded, citing the verifying evidence.
This is the same manual verify-then-close judgment call the execution
loop's B2.0 supersession re-check (`idd-work.instructions.md`) applies
after claim — this scan only adds an earlier, pre-publish checkpoint.
A fast enough race can still surface even after B2.0; when it does, it
resolves the same way.

## Decomposition and roadmap planning rules

The skill should identify atomic execution units first, then decide how
to package them.

### Keep work as an orphan issue when all are true

- one atomic issue is enough to complete the request
- limited scope, clear verification, and autonomous completion all pass
- no roadmap-level dependency or parallel track is needed
- the work is unlikely to require multiple agent sessions
- the target repository discovers orphan issues — `issue-scope` is
  `roadmap-first` (the default; orphans are the fallback when no roadmap
  work is startable) or `orphan-first` — and any configured
  `orphan-first-policy` approval step can happen after drafting; or the
  draft explicitly tells the operator to switch to a discovering mode
  before starting the execution loop (a `roadmap`/roadmap-only
  repository does not discover orphans)

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

## Dependency encoding rules

The skill must encode dependencies in forms that the discover phase can
read safely.

**Prefix-first.** The examples below use this source repository's own
configured prefix, `idd-skill`, literally — this document describes
this repository's own convention. Resolve the target repository's
marker prefix before emitting any authoring marker in an installed
bundle; never assume `idd-skill` outside this source repository. See
the bundled `contract.md`'s
[Target marker prefix](https://github.com/kurone-kito/idd-skill/blob/main/skills/issue-authoring/references/contract.md#target-marker-prefix)
section for the adopter-facing, prefix-parameterized version of this
rule.

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
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker; see
  [Autopilot-suitability score](#autopilot-suitability-score))
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

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
- the draft preserves discoverability by using a repository that
  discovers orphans (`issue-scope: roadmap-first`, the default, via the
  orphan fallback, or `orphan-first`), or by surfacing that
  configuration change before the operator starts the Discover -> Claim
  loop
- when the repository uses `orphan-first-policy: maintainer-approved`,
  the draft includes a post-publication maintainer approval step after
  the final title, body, and generated plan are stable
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate for the
  `orphan` shape (see [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

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
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

Recommended content inside `## Tracks`:

- track headings for major streams of work
- `- [ ] #NNN` task-list entries for ready child issues
- short sequencing or parallelization notes when they reduce collisions

Validation expectations:

- every active child issue or nested roadmap node is referenced from the
  roadmap body
- the roadmap explains why multiple issues exist instead of hiding them
  as narrative text
- dependency notes distinguish between active grouping and true
  sequential blocking
- each dependency edge is justified and preserves natural cohesion
- nested roadmap entries stay identifiable as coordination/audit nodes
  instead of normal execution leaves
- the roadmap can survive multi-session handoffs without relying on
  private session memory
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate for the
  `roadmap` shape (see [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

### Sub-issue schema

Use a sub-issue for one atomic execution unit that belongs under a
roadmap.

Required content:

- title with a concrete task summary
- `## Background`
- `## Proposed change`
- `## Acceptance criteria`
- an autopilot-suitability footer at the end of the body (visible line +
  `<!-- idd-skill-autopilot-suitability: N -->` marker)
- an optional effort footer next to it (visible line +
  `<!-- idd-skill-effort: S|M|L -->` marker; see
  [Effort hint](#effort-hint)) — a soft Discover selection tie-breaker,
  fail-safe on absence

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
- exactly one autopilot-suitability footer with an integer 1-5 marker; a
  score of `1` also carries `status:blocked-by-human`
- passes the `audit-authored-issue` mechanical pre-publish gate using
  `--shape child` (the linter's shape enum names this schema `child`,
  matching `contract.md`'s "Child issue under a roadmap"; see
  [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

## Validation checklist for drafted output

Before reporting or publishing issue drafts, the skill should verify:

- each execution-ready issue passes limited scope, clear verification,
  and autonomous completion
- no execution-ready issue hides unresolved human dependency that
  belongs in `needs-decision`, `blocked-by-human`, `deferred`, or the
  approval-needed fallback
- each deferred, blocked, or decision-dependent item was preserved in a
  stable bucket instead of being dropped
- each roadmap has one roadmap marker and uses task-list links for child
  issues
- each nested roadmap node is linked from the parent roadmap task list
  and links its own active child work
- each nested roadmap remains identifiable as a coordination/audit node
  instead of a normal execution candidate
- each dependency edge is justified and preserves natural cohesion
- each `Blocked by #NNN` reference resolves to the intended issue
- each `idd-skill-blocked-by` marker points to a real roadmap and is
  used only for true sequential dependencies, never to group nested
  roadmap children
- each issue body is explicit enough that a later discover pass can
  decide whether the issue is ready without reconstructing hidden
  context
- reuse or extension decisions are recorded when the skill chose not to
  create a new issue
- each drafted ready body passes the `audit-authored-issue` mechanical
  pre-publish gate for its declared shape, or the manual fallback when
  no helper runtime is available (see
  [Mechanical pre-publish gate](#mechanical-pre-publish-gate))

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
