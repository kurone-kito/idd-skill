# IDD — Discover Phase (A0-T–A4.5)

Read this file when starting a new task. It covers finding and selecting
the next issue to work on, including an operator-provided exact issue
target, pre-claim suitability filtering, and claim handoff. After
selecting a suitable candidate, read `idd-claim.instructions.md` to
claim it.

**Abort conditions**: A0-T, A1, A3 (default; see decision tree).
**Early stop condition**: A0-T, A4, or A4.5 (no claim made — see below).

## A0-T — Explicit issue target shortcut

Use this shortcut only when the current operator request contains one
unambiguous issue target in the current repository: either a single issue
number such as `#123` or a single issue URL whose owner and repository
match the current repository.

Do not use this shortcut for ambiguous inputs, multiple issue numbers,
cross-repository issue URLs, closed issues, inaccessible issues, pull
requests, discussions, commits, or any other non-issue target. Report the
reason and stop without claiming. Fall back to normal discovery only when
the operator explicitly asks for normal discovery in the same run; do not
silently search for another issue.

For a valid open target, skip A0-O, A1, A1.5, A2, and candidate
selection. Before A5, run targeted readiness and viability checks against
that issue only:

1. Re-fetch the target issue.
2. Apply the same readiness intent as A3 to the target:
   - no `status:blocked-by-human` or `status:needs-decision` label;
   - no open dependent issues, except parent epics or aggregate issues
     that are acceptable under A3;
   - visible `Blocked by #NNN` references resolve to closed or otherwise
     completed issues, with unresolved references treated as blocked;
   - hidden `<!-- idd-skill-blocked-by: {roadmap-id} -->` markers
     resolve through the same scoped body-content lookup used by A3, and
     the matching roadmap work is closed or otherwise complete;
   - no external human coordination is required to start.
3. Run the normal A4 viability gate against the target only.

If any targeted readiness or viability check fails, report the exact
failed criterion and stop without claiming. Do not fall back to another
issue unless the operator explicitly asks for normal discovery in the
same run.

If all checks pass, the target is selected. Continue to
`idd-discover.instructions.md` **A4.5** for suitability triage. A4.5
follows the same standards as roadmap paths. If A4.5 passes, proceed to
`idd-claim.instructions.md` A5. A5 claim-state, open-PR, takeover,
branch-collision, and claim-verification rules remain unchanged.

## A0 — Check issue-scope setting

Read the **issue-scope** value from the Project commands table in
`idd-overview.instructions.md`.

- If `issue-scope` is `roadmap` (the default): skip A0-O and proceed to
  A1 as normal.
- If `issue-scope` is `orphan-first`: proceed to A0-O.

## A0-O — Discover orphan issues

Read the **orphan-first-policy** value from the Project commands table
in `idd-overview.instructions.md` before any repo-wide orphan issue
search.

- If `orphan-first-policy` is `public-disabled`, first determine the
  repository visibility. If the repository is public, skip A0-O without
  searching open issues and proceed to A1. If visibility cannot be
  determined, treat it as public and fail safely to A1. For private or
  internal repositories, continue with A0-O.
- For `none` and `maintainer-approved`, continue with A0-O.

Search all open issues in the repository. Collect every issue whose
body satisfies **all** of the following:

- Does NOT contain any `<!-- idd-skill-roadmap-id: … -->` marker
  (the issue is not itself a roadmap).
- Does NOT contain any `<!-- idd-skill-blocked-by: … -->` marker.
- Does NOT have a `status:blocked-by-human` or `status:needs-decision`
  label.
- Does NOT contain visible `Blocked by #NNN` lines where the referenced
  issue is open (apply the same fail-safe as A3: if a reference cannot
  be resolved, treat as blocked).

Apply the configured policy before passing A0-O candidates to A4:

- `none` (the default): apply no extra orphan-first approval gate.
- `maintainer-approved`: keep only candidates that have at least one
  current maintainer approval signal:
  - the `idd:ready` label, only when repository policy reserves that
    label to maintainer approval actors;
  - an issue author who is a repository owner or collaborator with
    Write, Maintain, or Admin permission, verified with the collaborator
    permission API; do not treat organization `MEMBER` association alone
    as approval;
  - a visible comment from a maintainer approval actor whose trimmed
    body is exactly `IDD ready` or contains `IDD ready` as a standalone
    line. The approval comment must be newer than the latest issue
    title/body edit and any generated-plan update; if freshness cannot
    be determined, require a fresh approval comment or a reserved label.
- `public-disabled`: for private or internal repositories, behave the
  same as `none`.

A maintainer approval actor is a human repository owner or collaborator
with Write, Maintain, or Admin permission. Do not reuse the trusted
marker actor set for this approval gate, and do not count automation or
the current agent unless repository policy explicitly grants that actor
maintainer approval authority.

If at least one orphan issue remains after the configured policy is
applied: pass the remaining set directly to **A4** (viability gate).
Skip A1–A3 entirely.

If no orphan issues remain after the configured policy is applied: fall
back to the roadmap path. Proceed to **A1** and continue with the normal
A1 → A1.5 → A2 → A3 → A4 sequence.

The A3 decision tree (abort / ask operator in unattended mode) is
reached when the active discovery path(s) produce zero results: when
`orphan-first` is active, this means both the orphan path and the
roadmap fallback returned zero; when `issue-scope` is `roadmap`, only
the roadmap path runs and A3 applies when it returns zero.

## A1 — Find the roadmap

Use GH CLI or GH MCP to find the roadmap among open issues. Identify it
by the `roadmap` label (project field) or by recognizing it as an
umbrella issue. If no roadmap issue exists, report and abort.

**Note**: Repo-wide or label-based issue queries are permitted only in
**A0-T** (the scoped `idd-skill-roadmap-id` lookup needed to resolve the
explicit target's `idd-skill-blocked-by` markers),
**A0-O** (when `issue-scope` is `orphan-first`, to find orphan issues),
**A1** (to locate the roadmap), **A1.5** (narrow duplicate/reuse lookup
for one specific autonomous gap), and **A3** (narrow body-content lookup
for `idd-skill-roadmap-id` to resolve `idd-skill-blocked-by`
dependency markers; see A2 for details). Outside these contexts,
repo-wide and label-based queries are prohibited.

## A1.5 — Audit completed roadmaps

After A1 selects an open roadmap, inspect whether the roadmap appears
complete before enumerating more work. This step belongs in Discover
because Discover owns roadmap selection and global readiness. F4 remains
scoped to the just-merged PR and local cleanup while holding only the
child issue claim; it must not close a parent roadmap as a side effect.
F5 still loops back here, so the next Discover pass can evaluate parent
roadmap state after child PRs merge.

Run the completion audit only when the selected roadmap has explicit
child work such as task-list issue references or GitHub sub-issue
relationships. If the roadmap has no explicit child work, report that
it is childless or malformed and continue to A2; do not close it based
on absence of candidates.

Fetch the selected roadmap, its explicit child references, transitive
descendants, GitHub sub-issue children, and linked or closing PR evidence
for those child issues. Use the same outbound traversal sources as A2,
including closed umbrella children, so open descendants cannot be hidden
behind a closed direct child. This step must not use repo-wide search to
add unrelated work to the roadmap. The only repo-wide search allowed in
A1.5 is a narrow duplicate/reuse check for a specific autonomous gap
before creating a follow-up issue; use those results only to link
existing gap work or avoid creating a duplicate, not to widen A2
candidates.

- If the roadmap itself has `status:blocked-by-human` or
  `status:needs-decision`, report the blocker and stop before A2. Do not
  continue selecting child issues under a blocked roadmap.
- If any referenced child or descendant issue is open, inaccessible, or
  unresolved, report the provenance path and reason, then continue to
  A2.
- If any referenced child or descendant has an open linked or closing PR
  that is not merged or otherwise obsolete, treat that child work as
  unresolved, report the PR, and continue to A2.
- If any open or unresolved child or descendant has
  `status:blocked-by-human` or `status:needs-decision`, report the
  blocker and continue to A2 or stop according to the normal
  ready-to-start rules. Do not treat stale blocker labels on closed
  children as audit blockers when their referenced descendants are
  resolved.
- If all referenced child and descendant work is closed or otherwise
  complete, compare the roadmap success criteria against the closed child
  issues, linked merged PRs, task-list state, follow-up comments, and the
  current repository state where feasible. Do not infer completion from
  checkbox state alone.

A1.5 can publish roadmap-level GitHub side effects before a child task
issue is selected. Before any such side effect, coordinate on the
roadmap issue itself:

Treat `stale` and `non-stale` in this section using the
`claim-stale-age` policy default from `docs/policy-constants.md`
(distributed default: `24 h`).

- Roadmap claim ownership gates roadmap-side mutations only. Do not
  treat a non-stale roadmap claim as a global lock over A2/A3 child
  discovery or child A5 checks.
- Run the A5 claim-state, open-PR, and branch-collision checks against
  the roadmap issue. Do not apply A5's assignee or project
  `not started` readiness gate to roadmap-audit claims; roadmap
  ownership and project status may represent parent coordination rather
  than task readiness. If an active non-stale claim uses any
  `{claim-id}` other than one already recorded by this current session
  before this check and now verified, do not mutate the roadmap; report
  the claim and continue to A2 or stop according to the normal
  ready-to-start rules. A matching agent ID alone is not ownership
  proof, and neither is a token first learned by parsing the current
  roadmap comments.
- If the roadmap is unclaimed or stale, post and verify a normal
  `claimed-by` comment for the roadmap issue using a
  `roadmap-audit/<number>-<slug>` branch field. This is a logical
  coordination name, not a work branch, and it does not require creating
  a branch or worktree unless the audit also needs git changes.
- If the active roadmap claim already uses this current session's
  previously recorded and verified `{claim-id}`, continue with that same
  claim and do not post a new claim.
- Re-validate that roadmap claim before every roadmap comment, follow-up
  issue creation, body edit, label change, or close action.
- If the roadmap remains open and no PR branch will continue from the
  audit, release the roadmap-audit claim before returning to A2 or
  stopping.
- Example: when another agent holds a non-stale roadmap claim, do not
  mutate that roadmap in A1.5, but continue to A2/A3 and allow child
  issues that pass readiness and A5 to proceed.

Immediately before posting any completion summary, creating follow-up
issues, editing the roadmap body, changing labels, or closing the
roadmap, re-fetch the roadmap and child state and confirm the audit
input still matches the evidence.

Apply one outcome:

- **Audit passes**: post an `IDD roadmap completion audit` comment with
  a concise evidence summary, then close the roadmap. No child task
  issue is claimed. Return to A1 and select the next open roadmap, if
  any.
- **Autonomous gaps found**: create or link follow-up issues using the
  repository's issue-authoring rules, update the roadmap task list with
  those links, and continue to A2 so the new work can be discovered.
  Before creating a new issue, run the narrow A1.5 duplicate/reuse check
  for that gap and link a matching existing issue instead. New follow-up
  issue bodies must reference the roadmap (for example `Refs #NNN`) so a
  later audit can rediscover them. After creating a follow-up issue,
  update the roadmap task list with that link before creating another.
  If the roadmap update fails or the roadmap claim is lost after issue
  creation, create no more issues; report the created issue link so the
  next audit can link it before considering duplicates.
- **Non-autonomous gaps found**: comment with the decision or human
  blocker, apply `status:needs-decision` or `status:blocked-by-human`
  when those labels exist, and do not close the roadmap. Stop before A2
  after reporting a non-autonomous gap, even if the repository does not
  have the blocker labels, so the same unattended run cannot select
  child work under a roadmap that needs human input.

## A2 — Enumerate sub-issues

Starting from the roadmap found in A1 and not closed by A1.5,
recursively collect all issues it references. Include transitively
referenced issues. Collect only **open** issues.

**Allowed traversal sources** (outbound references only):

- Task-list entries in the roadmap or in any recursively discovered
  issue
- Issue cross-references that indicate a work dependency or task
  relationship (e.g., `Closes #NNN`, `Refs #NNN`, explicit sub-issue
  lines in the issue body)
- GitHub sub-issue relationships (parent → child)

**Excluded from traversal**:

- Inbound backlinks (issues that reference the roadmap but are not
  referenced by it)
- Incidental narrative mentions (e.g., "Similar to #NNN") without an
  explicit task, sub-issue, or dependency relationship

Traverse referenced issues regardless of their open/closed state;
include only **open** issues in the A2 candidate set.

**Permitted repo-wide queries** — only the following scoped lookups may
touch issues outside the roadmap traversal graph:

- **A0-T only**: the scoped body-content lookup needed to resolve
  `idd-skill-blocked-by` markers on the explicit target. The result is
  used solely to determine targeted readiness and is not added to any
  candidate set.
- **A0-O only** (when `issue-scope` is `orphan-first`): a repo-wide
  open-issue query to find issues without `roadmap-id` or `blocked-by`
  markers.
- **A1 only**: any method (including `gh issue list`, `gh search`, or
  label-based queries) to locate the roadmap issue itself.
- **A1.5 only**: a narrow duplicate/reuse lookup for one specific
  autonomous gap before creating a follow-up issue. The result may only
  be linked to the selected roadmap or used to avoid creating a
  duplicate; it must not be added to the A2 candidate set.
- **A3 only**: a body-content search (e.g.,
  `gh search issues --match-body`) to find the issue with a matching
  `idd-skill-roadmap-id` marker when checking
  `idd-skill-blocked-by` dependency markers (see A3
  below). The result is used solely to determine blocked status and is
  not added to the A2 candidate set.

**Prohibited in all other contexts** — the following must not be used in
any phase except as listed above, or when A3 step 4 explicit opt-in
authorizes an alternate scope for the current run:

- `gh issue list` or any variant
- `gh search` or any variant
- Any repo-wide or label-based query

**Handling unresolvable references**:

- If enumeration cannot start or continue due to an infrastructure or
  tool failure (API error, auth failure, rate limit, or the roadmap body
  cannot be fetched): this is an **A2 enumeration failure** — abort
  immediately and report. No fallback.
- If a specific outbound reference cannot be resolved because the
  referenced issue is not found or inaccessible: record the reference as
  unresolvable with the reason, skip that branch, and continue with the
  rest of the traversal. This is not an enumeration failure.

Report every A2 candidate with its provenance path from the roadmap
(e.g., `#222 → #228 → #257`) before passing to A3. Also report any
unresolvable references encountered during traversal.

## A3 — Filter to ready-to-start

From A2, keep only issues that satisfy **all** of the following:

- No `status:blocked-by-human` or `status:needs-decision` label
- No open dependent issues (parent epics / aggregate issues that are
  still open are acceptable)
- All dependency issues are closed or otherwise completed. Check both
  forms of dependency: (a) visible `Blocked by #NNN` lines in the issue
  body — if any referenced issue is open, treat as blocked; if a
  reference cannot be resolved (issue not found or inaccessible), treat
  as blocked (fail-safe); (b) hidden
  `<!-- idd-skill-blocked-by: {roadmap-id} -->` markers
  — for each `{roadmap-id}`, find the issue whose body contains
  `<!-- idd-skill-roadmap-id: {roadmap-id} -->`. If that
  issue is open, treat as blocked. If no issue matches the roadmap-id,
  treat as blocked (fail-safe — an unmatched marker indicates a
  migration integrity problem such as a typo, deleted issue, or
  incomplete migration). If multiple issues match, treat as blocked if
  any is open.
- No external human coordination required to start

**When A2 finds zero candidates, or when zero issues survive A3
filtering**, apply the following decision tree — do not silently expand
scope:

1. **A2 enumeration failure** (infrastructure or tool issue — see A2 for
   the definition): abort immediately and report. No fallback.
   (Unresolvable individual references are already pruned in A2 and do
   not trigger this step.)

2. **A2 empty** (roadmap has no outbound references, all referenced
   issues are closed, or all branches were skipped due to unresolvable
   references): report that A2 found zero open candidates — include any
   skipped unresolvable references — then proceed to step 4.

3. **A3 filtered to zero** (A2 found candidates but all were filtered
   out): report each candidate and the filter criterion it failed, then
   proceed to step 4.

   **Diagnostic — all candidates blocked by an open roadmap**: if every
   candidate is blocked because its `<!-- idd-skill-blocked-by: X -->`
   marker points to a roadmap issue that is still open, the markers are
   likely misused as grouping tags rather than as true sequential
   dependencies. Sub-tasks that should be worked on while the roadmap is
   open belong in the roadmap's task list as `- [ ] #NNN` entries; the
   `blocked-by` marker is reserved for issues that must wait for a
   separate, prior roadmap to close. Report this pattern explicitly so
   the operator can correct the issue setup.

4. **Request explicit opt-in** — ask the operator: "No roadmap-scoped
   issues are available. Do you want to expand the search scope for this
   run? If so, specify the alternate scope." An agent is **unattended**
   if it cannot wait for and receive a same-run operator reply. Then:

   - **Unattended mode**: abort and report. Do not infer opt-in from
     prior or standing instructions.
   - **Operator declines or does not respond**: abort and report.
   - **Operator grants opt-in**: use the operator-specified scope for
     this run only. Prior or standing instructions do not count as
     opt-in.

## A4 — Gate, then pick

### Step 1 — Viability gate

For each candidate from A0-O or A3, evaluate **all three** criteria.
Fail any one →
discard the issue.

| Criterion                 | Pass                                                                                                                | Fail examples                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Limited scope**         | Changes confined to a few files or one module                                                                       | Touches multiple subsystems; redesigns a public interface                                        |
| **Clear verification**    | Outcome verified by lint / test / CI — including adding or updating targeted automated tests as part of the work    | Success depends on UX or product judgment                                                        |
| **Autonomous completion** | No external coordination, human decision, unavailable system, or product judgment required to **complete** the work | Requires operator to provide credentials; requires a product decision before the work can finish |

If **no issue** survives the gate: report the full list of discarded
issues with the criterion or criteria each failed, then **stop** — do
not post `unclaimed-by` because no claim was made. This is not an abort.

### Step 2 — Select

Among the surviving viable issues, pick the one with the **lowest issue
number**.

After picking, proceed to **A4.5**.

## A4.5 — Pre-Claim Issue-Suitability Triage

**Position**: After A4 (viability), before A5 (claim)\
**Scope**: Applies to explicit-target, roadmap, and orphan-first candidates\
**Purpose**: Filter incoherent, unsafe, duplicated, or out-of-scope issues

This gate evaluates whether an issue is **suitable for autonomous
execution** independent of the current run's context. Where A4 asks "can
we do this NOW?", A4.5 asks "SHOULD we do this at all?"

### Seven Suitability Checks

For the candidate picked in A4 Step 2, evaluate the following checks in
order. Stop and fail on the first check that is not satisfied.

#### Check 1: Repository Fit

Does the issue describe work scoped to this repository?

- **Pass**: Work is entirely within this repository's scope; no external
  system coordination needed
- **Fail**: Issue crosses repository boundaries, requires external system
  access, or is out-of-scope for this repository
- **Outcome on fail**: `out-of-scope`

#### Check 2: Issue Coherence

Is the issue body coherent and well-structured?

- **Pass**: Title and description are clear; body structure is
  interpretable; intent can be restated safely
- **Fail**: Body is malformed, contradictory, incomplete, or intent is
  impossible to parse reliably
- **Outcome on fail**: `unclear`

#### Check 3: Trust/Safety

Can the agent safely interpret and execute this issue without undue
trust or safety risk?

- **Pass**: Issue body and comments contain only trusted input; no code
  injection risk in markers; no safety concern apparent
- **Fail**: Untrusted input risk (e.g., embedded code in markers without
  escaping), ambiguous safety concern, or requires human judgment on
  safety
- **Outcome on fail**: `invalid`

#### Check 4: Duplicate or Superseded Work

Is this work a duplicate of an existing open issue, closed issue,
merged PR, or draft PR? Is it superseded by paused work marked with
`status:blocked-by-human` or `status:needs-decision`?

- **Pass**: No duplicate or superseded work detected; this issue
  represents novel work
- **Fail**: Issue duplicates an existing open or closed issue, is
  superseded by newer work, or the work was already completed or is in
  progress (including draft PRs)
- **Outcome on fail**: `duplicate`

#### Check 5: Actionability

Does the issue describe concrete, actionable work?

- **Pass**: Issue specifies clear acceptance criteria, actionable steps,
  or verifiable outcomes
- **Fail**: Issue is too vague, aspirational, blocked by human decision,
  or lacks concrete direction
- **Outcome on fail**: `needs-decision`

#### Check 6: Autonomy (Suitability Perspective)

Can the agent complete this work without external coordination beyond
those already checked in A4?

- **Note**: A4 already checks "no external coordination required"; A4.5
  re-confirms in context of suitability
- **Pass**: No additional coordination, approvals, or stakeholder
  sign-offs required beyond what A4 evaluated
- **Fail**: Issue requires maintainer approval before work can proceed,
  stakeholder coordination, or external availability gate
- **Outcome on fail**: `blocked-by-human`

#### Check 7: Verifiability (Suitability Perspective)

Can success be verified independently by the agent?

- **Note**: A4 checks "clear verification"; A4.5 re-confirms the issue
  does not require subjective approval
- **Pass**: Success is verifiable through automated tests, CI, lint, or
  concrete objective criteria
- **Fail**: Success depends on maintainer opinion, UX judgment call, or
  external stakeholder sign-off
- **Outcome on fail**: `needs-decision`

### Failure Outcomes

When an issue fails any suitability check, classify it into one of six
stable outcomes:

| Outcome            | Meaning                        | Next Steps      |
| ------------------ | ------------------------------ | --------------- |
| `unclear`          | Issue needs clarification      | Report and stop |
| `needs-decision`   | Requires maintainer decision   | Report and stop |
| `blocked-by-human` | Requires human coordination    | Report and stop |
| `duplicate`        | Duplicate or superseded work   | Report and stop |
| `out-of-scope`     | Outside repository scope       | Report and stop |
| `invalid`          | Trust/safety concern or defect | Report and stop |

### Mutation Policy

**A4.5 is a triage gate, not an execution claim.** The gate determines
readiness but does NOT automatically apply labels or post claims.

**Read-only approach** (recommended):

- Agent evaluates all seven checks
- If any check fails, agent reports the failure outcome and stops
- NO implementation claim comment is posted
- NO branch or worktree is created
- NO labels are applied
- A5 is never reached

**Optional labeled approach** (if policy permits):

- Agent MAY optionally apply a transient `triage:{outcome}` label to
  document the rejection reason
- Label must NOT masquerade as an implementation claim
- Label is intended as a diagnostic aid for humans reviewing rejected
  candidates
- Labeled approach still stops at A4.5; A5 is never reached

**Permitted and prohibited mutations**:

- **Permitted**: Agents may post a single diagnostic comment explaining
  the A4.5 rejection outcome, prefixed with **"A4.5 suitability gate
  rejection"** to distinguish from claim or work-in-progress markers.
- **Prohibited**: Agents must NOT post implementation claim comments,
  create branches or worktrees, close issues unilaterally, or modify
  roadmap structures or relationships. Do NOT apply other labels except
  the optional `triage:{outcome}` label in the labeled approach above.
- **Linking**: Issues may be linked as related context (e.g., "Related
  to #NNN which addresses similar work") in diagnostic comments, but
  must NOT be treated as duplicates without explicit human confirmation
  first.

### Coordination Rule

A4.5 rejections must clearly indicate they are **triage decisions**, not
implementation work:

- Do NOT post claim comments or claim markers
- Do NOT create branches or worktrees
- Do NOT post operational markers (review-watermark, review-baseline,
  etc.)
- If posting a label, use a `triage:` prefix to distinguish from
  implementation state
- Any diagnostic comments MUST state clearly: "A4.5 suitability gate
  rejection" to distinguish from claim or work-in-progress

### Decision Flow

```text
Issue picked in A4 Step 2
  → Run Check 1 (Repository Fit)
    → PASS → Run Check 2
    → FAIL → Classify as out-of-scope → Report and STOP (no claim)
  → Run Check 2 (Coherence)
    → PASS → Run Check 3
    → FAIL → Classify as unclear → Report and STOP
  → Run Check 3 (Trust/Safety)
    → PASS → Run Check 4
    → FAIL → Classify as invalid → Report and STOP
  → Run Check 4 (Duplicates)
    → PASS → Run Check 5
    → FAIL → Classify as duplicate → Report and STOP
  → Run Check 5 (Actionability)
    → PASS → Run Check 6
    → FAIL → Classify as needs-decision → Report and STOP
  → Run Check 6 (Autonomy)
    → PASS → Run Check 7
    → FAIL → Classify as blocked-by-human → Report and STOP
  → Run Check 7 (Verifiability)
    → PASS → Proceed to A5 (claim)
    → FAIL → Classify as needs-decision → Report and STOP (no claim)
```

### Edge Cases

**Malformed markers or body**: If the issue body contains unparseable
structured data (e.g., corrupted marker), treat it as **Check 2
(Coherence) failure** → `unclear`. Report the parsing error so a human
can correct the issue.

**Timeout on duplicate detection**: If duplicate detection (Check 4)
times out or becomes expensive, fall back to exact title match only. If
exact match is not found, PASS the check and continue.

**Agent-specific limitations**: All seven checks should be agent-agnostic
(work for Copilot, Claude, Codex, Gemini). If an agent cannot reliably
perform a check, document that limitation and treat as a PASS so work is
not blocked by agent capability limits.

After A4.5, proceed to `idd-claim.instructions.md`.
