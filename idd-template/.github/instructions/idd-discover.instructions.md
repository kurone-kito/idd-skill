# IDD — Discover Phase (A0-T–A4)

Read this file when starting a new task. It covers finding and selecting
the next issue to work on, including an operator-provided exact issue
target, roadmap-audit handoff, candidate selection, and handoff to A4.5
and claim. After selecting a viable candidate (A4), run suitability triage via
`idd-suitability.instructions.md` (A4.5), then proceed to
`idd-claim.instructions.md` to claim it.

When helper support is enabled, use helper scripts from
`docs/idd-helper-scripts.md` first for A0-O/A3/A3.5/A4/A4.5 evidence.
Written decision tables remain authoritative when helper output is
missing or disagrees.

**Abort conditions**: A0-T, A1, A3 (default; see decision tree).
**Early stop condition**: A0-T, A4, or A4.5 (no claim made — see below).

## Authoring label guard

The configured authoring label is `issueAuthoring.authoringLabelName`
(default: `status:authoring`); the stale threshold is
`issueAuthoring.authoringStaleAge` (default: `PT4H`).

A0-T, A0-O, and A3 must treat a matching label as not startable. A0-T
reports `Issue #N is currently being authored` and stops before claim;
A0-O and A3 filter the issue out. For each skipped issue, fetch the
latest matching `labeled` timeline event. If the label age exceeds
`authoringStaleAge`, emit:

```text
Warning: Issue #N has carried the authoring label for {duration}; the authoring session may be stalled.
```

If the timestamp is unavailable, still skip the issue and report that the
stale-authoring age could not be checked.

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
2. If the target issue carries the configured authoring label, report
   `Issue #N is currently being authored`, run the stale-authoring
   warning check above, and stop without claiming.
3. Apply the same readiness intent as A3 to the target:
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
4. Run the normal A4 viability gate against the target only.
5. If `.github/idd/config.json` exists and is valid and
   `skipIssueAuthorApprovalGate` is `true`, skip the issue-author
   approval gate and keep the target selected.
6. Otherwise, apply the same issue-author approval evaluation used in
   **A3.5**:
   - use `maintainerApprovalActorPolicy` from `.github/idd/config.json`
     when present; if absent, default to
     `owners-and-maintainers-only`;
   - treat the issue author as self-authorized only when that author is
     permitted by the current maintainer-approval actor policy;
   - treat bare organization `MEMBER` association, issue body text,
     generated plans, or operator attention as **not** authorizing the
     issue;
   - if approval state or permission resolution is unavailable or
     ambiguous, fail closed and treat approval as missing unless the
     repository explicitly opted out.
   - if the target lacks required approval, report that the issue-author
     approval gate blocked claim and stop before A5. Do not fall back to
     another issue unless the operator explicitly asks for normal
     discovery in the same run.

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
- Does NOT have the configured authoring label.
- Does NOT contain visible `Blocked by #NNN` lines where the referenced
  issue is open (apply the same fail-safe as A3: if a reference cannot
  be resolved, treat as blocked).

Apply the configured policy before passing A0-O candidates to A3.5:

- `none` (the default): apply no extra orphan-first approval gate.
- `maintainer-approved`: keep only candidates that have at least one
  current maintainer approval signal:
  - the configured ready label from `approvalSignals.readyLabelName`
    (default: `idd:ready`), only when repository policy reserves that
    label to maintainer approval actors. When
    `approvalSignals.labelFreshnessMode` is `event-freshness`, the
    latest matching `labeled` timeline event must be newer than the
    latest issue title/body edit and any generated-plan update. When the
    mode is `presence-only` (default), label presence is sufficient. If
    freshness cannot be determined, require a fresh approval comment or
    a re-applied ready label;
  - an issue author who is a repository owner or collaborator permitted
    by the current maintainer-approval actor policy, verified with the
    collaborator permission API; do not treat organization `MEMBER`
    association alone as approval;
  - a visible comment from a maintainer approval actor whose trimmed
    body is exactly `IDD ready` or contains `IDD ready` as a standalone
    line. The approval comment must be newer than the latest issue
    title/body edit and any generated-plan update, or any equivalent
    draft-stability signal the repository uses locally. If freshness
    cannot be determined, require a fresh approval comment or a reserved
    label.
- `public-disabled`: for private or internal repositories, behave the
  same as `none`.

A maintainer approval actor is a human repository actor allowed by the
current `maintainerApprovalActorPolicy`:

- `owners-and-maintainers-only` (default): repository owners and
  collaborators with Maintain or Admin permission. Write-only
  collaborators do not count.
- `all-write-permission-actors`: repository owners and collaborators
  with Write, Maintain, or Admin permission.

Do not reuse the trusted marker actor set for this approval gate, and do
not count automation or the current agent unless repository policy
explicitly grants that actor maintainer approval authority.

If at least one orphan issue remains after the configured policy is
applied: pass the remaining set directly to **A3.5**. Skip A1–A3.

If no orphan issues remain after the configured policy is applied: fall
back to the roadmap path. Proceed to **A1** and continue with the normal
A1 → A1.5 → A2 → A3 → A3.5 → A4 sequence.

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

After A1 selects an open roadmap, read
`idd-roadmap-audit.instructions.md` before continuing to A2. That file
owns the full A1.5 completion audit, roadmap-side claim rules, and the
close/link/stop outcomes that can occur before child-issue enumeration
resumes here.

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
- No configured authoring label
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

## A3.5 — Apply issue-author approval gate

Before passing any candidate set to A4 — whether it came from A0-O or
from A3 — evaluate the repository-wide issue-author approval gate.

- If `.github/idd/config.json` exists and is valid and
  `skipIssueAuthorApprovalGate` is `true`, the gate is disabled. Keep
  every ready candidate in the normal startable set.
- Otherwise the gate is enabled. Use `maintainerApprovalActorPolicy` from
  `.github/idd/config.json` when present; if absent, default to
  `owners-and-maintainers-only`.

When the gate is enabled, a candidate is **startable** only when at
least one of the following is true:

- the issue author is self-authorized under the current
  maintainer-approval actor policy;
- the issue has the configured ready label from
  `approvalSignals.readyLabelName` (default: `idd:ready`), when
  repository policy reserves that label to maintainer approval actors.
  When `approvalSignals.labelFreshnessMode` is `event-freshness`, the
  latest matching `labeled` timeline event must be newer than the
  latest issue title/body edit and any generated-plan update. When the
  mode is `presence-only` (default), label presence is sufficient;
- the issue has a visible approval comment from a maintainer approval
  actor whose trimmed body is exactly `IDD ready` or contains
  `IDD ready` as a standalone line, and that approval is newer than the
  latest issue title/body edit and any generated-plan update, or any
  equivalent draft-stability signal the repository uses locally. If
  freshness cannot be determined, require a fresh approval comment or a
  reserved label.

Fail closed when approval state or permission resolution is unavailable
or ambiguous unless the repository explicitly opted out via
`skipIssueAuthorApprovalGate`.

Candidates that fail the gate are **not** ready-to-start. Keep them in
an **approval-needed fallback bucket** ordered by ascending issue number.
Continue to A4 with only the startable candidates. Preserve any earlier
A0-O filtering from `orphan-first-policy`; this gate never widens
previously excluded orphan candidates back into scope.

If no startable candidates remain but the approval-needed fallback
bucket is non-empty:

- **Unattended mode**: report that only approval-needed fallback issues
  remain and stop without claiming. Do not auto-claim from the fallback
  bucket.
- **Attended mode**: ask the operator whether to obtain approval or to
  opt out explicitly in `.github/idd/config.json`. Do not treat operator
  attention alone as approval.

## A4 — Gate, then pick

### Step 1 — Viability gate

For each **startable** candidate from A3.5, evaluate **all three**
criteria. Fail any one → discard the issue.

| Criterion                 | Pass                                                                                                                | Fail examples                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Limited scope**         | Changes confined to a few files or one module                                                                       | Touches multiple subsystems; redesigns a public interface                                        |
| **Clear verification**    | Outcome verified by lint / test / CI — including adding or updating targeted automated tests as part of the work    | Success depends on UX or product judgment                                                        |
| **Autonomous completion** | No external coordination, human decision, unavailable system, or product judgment required to **complete** the work | Requires operator to provide credentials; requires a product decision before the work can finish |

If **no issue** survives the gate:

- if the approval-needed fallback bucket from A3.5 is non-empty, report
  that only approval-needed issues remain and stop without claim in
  unattended mode. In attended mode, ask the operator whether to obtain
  approval or opt out explicitly;
- otherwise report the full list of discarded issues with the criterion
  or criteria each failed, then **stop** — do not post `unclaimed-by`
  because no claim was made. This is not an abort.

### Step 1.5 — Active-claim pre-scan

**Purpose**: Reduce thundering-herd collisions in scale-out deployments by
identifying and skipping issues that are already claimed by other sessions.

Before selecting from the surviving viable issues, perform an
**active-claim pre-scan** to eliminate candidates with concurrent claims:

1. **Identify scan scope**: From the viable survivors (ordered by ascending
   issue number), define the scan set as the **top N candidates** (or fewer if
   fewer than N viable candidates exist). `N` comes from
   `.github/idd/config.json` `discover.activeClaimPreScanBatchSize`
   (distributed default: `10`).

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

3. **Determine selection candidate**: After scanning the top N:

   - **If at least one eligible (unclaimed) candidate remains** in the scan
     set: proceed to **Step 2** and select the lowest-numbered eligible
     candidate.

   - **If all top N are claimed**: the scan set is fully saturated with
     concurrent work. Proceed to **Step 2** with the **next batch**: scan
     candidates `N+1`–`2N`, then `2N+1`–`3N`, and so on, until an
     unclaimed candidate is found or the viable candidate set is
     exhausted.

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

## Scope invariant (summary)

Do not widen issue-selection scope beyond the roadmap traversal except
for the explicit query allowlist already defined in A0-T, A0-O, A1,
A1.5, A3, and A4.5, or for a same-run operator opt-in after a
zero-result report. A single explicit target authorizes only that issue;
prior or standing instructions do not count as opt-in.
