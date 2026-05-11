# IDD — Discover Phase (A0-T–A4)

Read this file when starting a new task. It covers finding and selecting
the next issue to work on, including an operator-provided exact issue
target. After selecting or verifying a target, read
`idd-claim.instructions.md` to claim it.

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
   - hidden
     `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: {roadmap-id} -->`
     markers resolve through the same scoped body-content lookup used by
     A3, and the matching roadmap work is closed or otherwise complete;
   - no external human coordination is required to start.
3. Run the normal A4 viability gate against the target only.

If any targeted readiness or viability check fails, report the exact
failed criterion and stop without claiming. Do not fall back to another
issue unless the operator explicitly asks for normal discovery in the
same run.

If all checks pass, the target is selected. Continue to
[`idd-suitability.instructions.md`](idd-suitability.instructions.md)
for suitability triage. A4.5 follows the same standards as roadmap
paths. If A4.5 passes, proceed to `idd-claim.instructions.md` A5.
A5 claim-state, open-PR, takeover, branch-collision, and
claim-verification rules remain unchanged.

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

- Does NOT contain any
  `<!-- {{PROJECT_MARKER_PREFIX}}-roadmap-id: … -->` marker (the issue
  is not itself a roadmap).
- Does NOT contain any
  `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: … -->` marker.
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
**A0-T** (the scoped `{{PROJECT_MARKER_PREFIX}}-roadmap-id` lookup
needed to resolve the explicit target's
`{{PROJECT_MARKER_PREFIX}}-blocked-by` markers),
**A0-O** (when `issue-scope` is `orphan-first`, to find orphan issues),
**A1** (to locate the roadmap), **A1.5** (narrow duplicate/reuse lookup
for one specific autonomous gap), and **A3** (narrow body-content lookup
for `{{PROJECT_MARKER_PREFIX}}-roadmap-id` to resolve
`{{PROJECT_MARKER_PREFIX}}-blocked-by` dependency markers; see A2 for
details). Outside these contexts, repo-wide and label-based queries are
prohibited.

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
  `{{PROJECT_MARKER_PREFIX}}-blocked-by` markers on the explicit target.
  The result is used solely to determine targeted readiness and is not
  added to any candidate set.
- **A0-O only** (when `issue-scope` is `orphan-first`): a repo-wide
  open-issue query to find issues without
  `{{PROJECT_MARKER_PREFIX}}-roadmap-id` or
  `{{PROJECT_MARKER_PREFIX}}-blocked-by` markers.
- **A1 only**: any method (including `gh issue list`, `gh search`, or
  label-based queries) to locate the roadmap issue itself.
- **A1.5 only**: a narrow duplicate/reuse lookup for one specific
  autonomous gap before creating a follow-up issue. The result may only
  be linked to the selected roadmap or used to avoid creating a
  duplicate; it must not be added to the A2 candidate set.
- **A3 only**: a body-content search (e.g.,
  `gh search issues --match-body`) to find the issue with a matching
  `{{PROJECT_MARKER_PREFIX}}-roadmap-id` marker when checking
  `{{PROJECT_MARKER_PREFIX}}-blocked-by` dependency markers (see A3
  below). The result is used solely to determine blocked status and is
  not added to the A2 candidate set.
- **A4.5 only**: a narrow duplicate/reuse search for the candidate
  selected in A4 Step 2 (title match, body-content, or fuzzy match to
  detect known open or closed issues that supersede or duplicate it).
  The result is used solely to determine duplicate status for the
  selected candidate and is not added to any candidate set.

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
  `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: {roadmap-id} -->` markers
  — for each `{roadmap-id}`, find the issue whose body contains
  `<!-- {{PROJECT_MARKER_PREFIX}}-roadmap-id: {roadmap-id} -->`. If that
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
   candidate is blocked because its
   `<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: X -->` marker points to a
   roadmap issue that is still open, the markers are likely misused as
   grouping tags rather than as true sequential dependencies. Sub-tasks
   that should be worked on while the roadmap is open belong in the
   roadmap's task list as `- [ ] #NNN` entries; the `blocked-by` marker
   is reserved for issues that must wait for a separate, prior roadmap to
   close. Report this pattern explicitly so the operator can correct the
   issue setup.

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

### Step 1.5 — Active-claim pre-scan

**Purpose**: Reduce thundering-herd collisions in scale-out deployments by
identifying and skipping issues that are already claimed by other sessions.

Before selecting from the surviving viable issues, perform an
**active-claim pre-scan** to eliminate candidates with concurrent claims:

1. **Identify scan scope**: From the viable survivors (ordered by ascending
   issue number), define the scan set as the **top 10 candidates** (or fewer
   if fewer than 10 viable candidates exist).

2. **Scan each candidate for active claims**: For each issue in the scan set,
   in ascending issue number order:

   - **Fetch the issue** and parse its comments using the shared claim-state
     rules (defined in `idd-claim.instructions.md`).
   - **Detect active non-stale claims**: Use the `claim-stale-age` policy
     default from `docs/policy-constants.md` (distributed default: `24 h`).
     An issue has an **active non-stale claim** if:
     - A trusted `claimed-by` comment exists, and
     - That comment's GitHub `created_at` timestamp is **less than** the
       `claim-stale-age` threshold (e.g., created less than 24 hours ago), and
     - The comment matches the `claimed-by` format defined in
       `idd-claim.instructions.md`.

   - **Remove claimed candidates**: If an active non-stale claim is detected,
     **mark this candidate as ineligible** and proceed to the next issue in
     the scan set.

   - **Skip stale or unclaimed candidates**: If the latest `claimed-by`
     comment is stale (≥ 24 h old) or no claim exists, this candidate
     **remains eligible**.

3. **Determine selection candidate**: After scanning the top 10:

   - **If at least one eligible (unclaimed) candidate remains** in the scan
     set: proceed to **Step 2** and select the lowest-numbered eligible
     candidate.

   - **If all top 10 are claimed**: the scan set is fully saturated with
     concurrent work. Proceed to **Step 2** with the **next batch**: scan
     candidates 11–20, then 21–30, and so on, until an unclaimed candidate
     is found or the viable candidate set is exhausted.

   - **If the entire viable candidate set is exhausted** (all issues up to the
     highest viable candidate are claimed): report that all viable issues are
     currently claimed by other sessions, then stop. Do not post
     `unclaimed-by` because no claim was made. This is not an abort; the
     session may retry Discover later if new viable candidates appear or
     claims become stale.

**Rationale**: Active-claim pre-scans eliminate known collisions
deterministically and reduce wasted claim-post-recheck cycles, improving
scale-out efficiency when multiple sessions start simultaneously.

### Step 2 — Select

Among the surviving viable and unclaimed issues (after Step 1.5), pick the
one with the **lowest issue number**.

After picking, continue to **A4.5** (`idd-suitability.instructions.md`).

## A4.5 — Pre-Claim Issue-Suitability Triage

Read [`idd-suitability.instructions.md`](idd-suitability.instructions.md)
for the full suitability triage protocol: seven checks, failure outcomes,
mutation policy, coordination rules, decision flow, and edge cases.

## Roadmap markers

Two hidden HTML comment markers are used in issue bodies to support the
discover phase:

- **Roadmap identity** (`{{PROJECT_MARKER_PREFIX}}-roadmap-id`): placed
  in the roadmap issue body. A3 uses this marker to resolve `blocked-by`
  dependency lookups. A1 identifies the roadmap by its `roadmap` label
  or umbrella structure — not by this marker.
- **Sequential dependency** (`{{PROJECT_MARKER_PREFIX}}-blocked-by`):
  placed in an issue body to express a hard dependency — this issue
  **cannot start until** the roadmap with the matching `roadmap-id` is
  closed.

**Do not use `{{PROJECT_MARKER_PREFIX}}-blocked-by` to group sub-tasks
under an active roadmap.** Sub-tasks that should be worked on while the
roadmap is open belong in the roadmap's task list as `- [ ] #NNN`
entries. The `blocked-by` marker is reserved for issues that must wait
for a separate, prior roadmap to close before they can start (cross-
phase sequential dependency). Using it for grouping causes A3 to block
every sub-task for the entire lifetime of the roadmap.

## Scope invariant (detailed query allowlist)

Agents must not widen issue-selection scope beyond what the roadmap
explicitly references (directly or transitively) without explicit
operator instruction. Specifically:

- A single explicit issue target provided by the operator in the current
  run is explicit operator instruction for that one issue only. Use the
  A0-T path; do not use the target as permission to search for alternate
  issues.
- Repo-wide searches (`gh issue list`, `gh search`, label-based queries)
  are permitted only in **A1** (to locate the roadmap itself), in
  **A0-T** for the scoped body-content lookup needed to resolve the
  explicit target's `{{PROJECT_MARKER_PREFIX}}-blocked-by` markers, in
  **A0-O** when `issue-scope` is `orphan-first` (body-content filter to
  find issues lacking `{{PROJECT_MARKER_PREFIX}}-roadmap-id` and
  `{{PROJECT_MARKER_PREFIX}}-blocked-by` markers), and for the scoped
  `{{PROJECT_MARKER_PREFIX}}-roadmap-id` body-content lookup required by
  A3's dependency-marker check. A1.5 may also run a narrow repo-wide
  duplicate/reuse check for a specific autonomous gap before creating a
  follow-up issue; the result may only prevent a duplicate or link an
  existing issue back to the selected roadmap, not expand the candidate
  set.
- After a zero-result report at A3, an operator may grant a one-time
  opt-in for the current run, specifying an alternate scope.
- Opt-in must be granted interactively during the current run. Prior or
  standing instructions do not count as opt-in.