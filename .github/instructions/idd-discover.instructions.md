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
   - hidden `<!-- idd-skill-blocked-by: {roadmap-id} -->` markers
     resolve through the same scoped body-content lookup used by A3, and
     the matching roadmap work is closed or otherwise complete;
   - no external human coordination is required to start.
4. Run the normal A4 viability gate against the target only.
5. Apply the **A3.5** issue-author approval gate against the target.
   If A3.5 classifies it as not startable, report that the gate
   blocked claim and stop before A5; do not fall back to another
   issue unless the operator explicitly asks for normal discovery in
   the same run.

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
- If `issue-scope` is `roadmap-first`: proceed to A1 as normal. When the
  roadmap path yields **zero candidates reaching A3.5** — i.e. A2
  enumerated no open execution leaves, or A3 filtered them all out as
  blocked — fall back to **A0-O** before aborting (mirror of
  `orphan-first`). If candidates do reach A3.5 but it holds them all as
  approval-needed, do **not** fall back: A3.5's stop/ask behavior
  governs, so the fallback never re-scopes around the approval gate.
- If `issue-scope` is `orphan-first`: proceed to A0-O.

## A0-O — Discover orphan issues

Read the **orphan-first-policy** value from the Project commands table
in `idd-overview.instructions.md` before any repo-wide orphan issue
search.

When A0-O runs as the `roadmap-first` fallback (not the `orphan-first`
primary path), every "proceed to A1" / "skip to A1" exit below instead
goes to the **A3 decision tree** — the roadmap path already ran and must
not be re-entered (this prevents an A1 ↔ A0-O loop, e.g. under
`public-disabled` on a public repo).

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
- Does NOT have the configured authoring label.
- Does NOT contain visible `Blocked by #NNN` lines where the referenced
  issue is open (apply the same fail-safe as A3: if a reference cannot
  be resolved, treat as blocked).

Apply the configured policy before passing A0-O candidates to A3.5:

- `none` (the default): apply no extra orphan-first approval gate.
- `maintainer-approved`: apply the **Approval signals** check from
  **A3.5** (using the Maintainer approval actor definition there) to
  each candidate, and keep only those that satisfy at least one
  signal. The `skipIssueAuthorApprovalGate` shortcut in A3.5 does
  **not** bypass this orphan-first filter — orphan-first
  `maintainer-approved` is independent of the repository-wide gate
  enable.
- `public-disabled`: for private or internal repositories, behave the
  same as `none`.

If at least one orphan issue remains after the configured policy is
applied: pass the remaining set directly to **A3.5**. Skip A1–A3.

If no orphan issues remain after the configured policy is applied: fall
back to the roadmap path. Proceed to **A1** and continue with the normal
A1 → A1.5 → A2 → A3 → A3.5 → A4 sequence. (For the `roadmap-first`
fallback, the guard above redirects this exit to A3.)

The A3 decision tree (abort / ask operator in unattended mode) is
reached when the active discovery path(s) produce zero results: for
`orphan-first`, both the orphan path and the roadmap fallback returned
zero; for `roadmap-first`, both the roadmap path and the orphan fallback
returned zero; for `roadmap`, only the roadmap path runs and A3 applies
when it returns zero.

## A1 — Find the roadmap

Use GH CLI or GH MCP to find the roadmap among open issues. Identify it
by the `roadmap` label (project field) or by recognizing it as an
umbrella issue. If no roadmap issue exists, report and abort.

**Note**: Repo-wide or label-based issue queries are permitted only in
**A0-T** (the scoped `idd-skill-roadmap-id` lookup needed to resolve the
explicit target's `idd-skill-blocked-by` markers),
**A0-O** (when `issue-scope` is `orphan-first`, or `roadmap-first` as
the roadmap-path fallback, to find orphan issues),
**A1** (to locate the roadmap), **A1.5** (narrow duplicate/reuse lookup
for one specific autonomous gap), and **A3** (narrow body-content lookup
for `idd-skill-roadmap-id` to resolve `idd-skill-blocked-by`
dependency markers; see A2 for details). Outside these contexts,
repo-wide and label-based queries are prohibited.

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

Traverse referenced issues regardless of their open/closed state.
Issues carrying the `roadmap` label or an
`<!-- idd-skill-roadmap-id: ... -->` marker are **roadmap nodes**; any
other issue is an **execution leaf**. Include only open execution leaf
issues in the candidate set; do not advance roadmap nodes to
A3/A4/A4.5/A5. Traverse closed nodes too (so descendants cannot be
hidden). The root roadmap from A1 is the traversal start; exclude it
from the open roadmap-node set (it is not a discovered node).

**Permitted repo-wide queries** — only the following scoped lookups may
touch issues outside the roadmap traversal graph:

- **A0-T only**: the scoped body-content lookup needed to resolve
  `idd-skill-blocked-by` markers on the explicit target. The result is
  used solely to determine targeted readiness and is not added to any
  candidate set.
- **A0-O only** (when `issue-scope` is `orphan-first`, or when
  `issue-scope` is `roadmap-first` and A0-O runs as the roadmap-path
  fallback): a repo-wide open-issue query to find issues without
  `roadmap-id` or `blocked-by` markers.
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
- **A4.5 only**: a narrow duplicate/reuse search for the candidate
  selected in A4 Step 2 (title match, body-content, or fuzzy match to
  detect known open or closed issues that supersede or duplicate it).
  The result is used solely to determine duplicate status for the
  selected candidate and is not added to any candidate set.

**Prohibited in all other contexts** — the following must not be used in
any phase except as listed above, or when A3 step 5 explicit opt-in
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

Report every A2 execution candidate with its provenance path (e.g.,
`#222 → #228 → #257`), open roadmap nodes encountered, and any
unresolvable references before passing to A3.

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
  `<!-- idd-skill-blocked-by: {roadmap-id} -->` markers
  — for each `{roadmap-id}`, find the issue whose body contains
  `<!-- idd-skill-roadmap-id: {roadmap-id} -->`. If that
  issue is open, treat as blocked. If no issue matches the roadmap-id,
  treat as blocked (fail-safe — an unmatched marker indicates a
  migration integrity problem such as a typo, deleted issue, or
  incomplete migration). If multiple issues match, treat as blocked if
  any is open.
- No external human coordination required to start; otherwise keep
  scanning

**When A2 finds zero candidates, or when zero issues survive A3
filtering**, apply the following decision tree — do not silently expand
scope:

1. **A2 enumeration failure** (infrastructure or tool issue — see A2 for
   the definition): abort immediately and report. No fallback.
   (Unresolvable individual references are already pruned in A2 and do
   not trigger this step.)

2. **A2 empty — only open roadmap nodes remain**: report each open
   roadmap node and its provenance path; A1.5 audit is needed.
   Do not treat them as candidates.
   Proceed to step 5.

3. **A2 empty — no candidates** (no roadmap nodes found either): report
   zero open candidates and any skipped references. Proceed to step 5.

4. **A3 filtered to zero** (A2 found execution candidates but all were
   filtered out): report each candidate and the filter criterion it
   failed, then proceed to step 5.

   See [Discover — A3 Diagnostic](../../docs/idd-design-rationale.md#a3---diagnostic-all-candidates-blocked-by-an-open-roadmap)
   for the marker-misuse pattern this case typically indicates.

5. **Request explicit opt-in** — ask the operator: "No roadmap-scoped
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

A0-T (explicit target) and A0-O (`maintainer-approved`) cite this
section instead of restating the algorithm.

**Gate enable / disable**: If `.github/idd/config.json` is valid and
`skipIssueAuthorApprovalGate` is `true`, the gate is disabled — keep
every ready candidate startable. Otherwise the gate is enabled; use
`maintainerApprovalActorPolicy` from `.github/idd/config.json` when
present, defaulting to `owners-and-maintainers-only`.

**Maintainer approval actor**: a human repository actor allowed by
the current `maintainerApprovalActorPolicy`. `owners-and-maintainers-only`
(default) admits repository owners plus collaborators with Maintain
or Admin permission; `all-write-permission-actors` adds Write
collaborators. Do not reuse the trusted marker actor set, and do not
count automation or the current agent unless repository policy
explicitly grants that actor maintainer approval authority. Verify
collaborator permission with the collaborator permission API.

A bare organization `MEMBER` association, by itself, is not approval;
neither is issue body text, a generated plan, nor operator attention.

**Approval signals** (any one satisfies, when the gate is enabled):

- the issue author is self-authorized under the current
  maintainer-approval actor policy;
- the configured ready label from `approvalSignals.readyLabelName`
  (default: `idd:ready`) is present when repository policy reserves
  that label to maintainer approval actors. When
  `approvalSignals.labelFreshnessMode` is `event-freshness`, the
  latest matching `labeled` timeline event must be newer than the
  latest issue title/body edit and any generated-plan update;
  `presence-only` (default) accepts label presence alone;
- a visible approval comment from a maintainer approval actor whose
  trimmed body equals `IDD ready` or contains `IDD ready` as a
  standalone line, newer than the latest issue title/body edit and
  any generated-plan update (or an equivalent draft-stability signal).

If freshness cannot be determined for a label or comment signal,
require a fresh approval comment or a re-applied ready label.

**Fail-closed**: fail closed when approval state or permission
resolution is unavailable or ambiguous unless the repository
explicitly opted out via `skipIssueAuthorApprovalGate`.

**Candidate routing**: candidates that fail the gate are not
ready-to-start. Keep them in an **approval-needed fallback bucket**
ordered by ascending issue number. Continue to A4 with only the
startable candidates. Preserve any earlier A0-O filtering from
`orphan-first-policy`; this gate never widens previously excluded
orphan candidates back into scope. Keep fallback issues visible; do
not drop them.

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

Before selecting from the surviving viable issues, eliminate
candidates that already carry a concurrent active non-stale claim,
in ascending issue-number order:

- Scan the **top N** survivors (ordered by ascending issue number),
  where `N` is `.github/idd/config.json`
  `discover.activeClaimPreScanBatchSize` (distributed default: `10`).
- For each candidate, fetch the issue and parse comments per the
  shared claim-state rules in `idd-claim.instructions.md`. A
  candidate is **ineligible** when parsing yields an **active claim**
  whose latest valid `claimed-by` comment (matching the documented
  format, authored by a trusted marker actor) has GitHub `created_at`
  newer than the `claim-stale-age` policy default
  (`docs/policy-constants.md`; distributed default: `24 h`).
  Otherwise (no active claim, the active claim is already stale, or
  no comment satisfies the trusted-marker + format requirements) the
  candidate **remains eligible**.

After scanning the current batch:

| Batch outcome                                                                       | Action                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At least one eligible candidate in the batch                                        | Proceed to Step 2 to rank and select.                                                                                                                                                                   |
| All `N` in this batch are claimed but viable survivors remain                       | Continue with the next batch (`N+1`–`2N`, then `2N+1`–`3N`, …) until an eligible candidate is found.                                                                                                    |
| Entire viable candidate set exhausted (all surviving viable candidates are claimed) | Report that all viable issues are currently claimed; stop. Do not post `unclaimed-by` (no claim was made). Not an abort; retry later when claims may have become stale or new viable candidates appear. |

See [Discover — A4 Step 1.5 Rationale](../../docs/idd-design-rationale.md#a4-step-15--rationale-active-claim-pre-scan)
for why this pre-scan exists.

### Step 2 — Select

Among the surviving viable and unclaimed issues (after Step 1.5), pick the
**highest authored autopilot-suitability score** (the
`<!-- idd-skill-autopilot-suitability: N -->` footer, or the
`discover-roadmap-graph` node's `autopilotSuitability`), tie-broken by
**lowest issue number**. In autopilot runs, skip scores below
`autopilotSuitability.floor` (default `3`) as human-oriented; a missing or
out-of-range score is treated as no score — ranked at the floor and never
skipped, so the unscored backlog flows as before. Advisory only: the pick
still passes A4.5/A5 unchanged and the score never bypasses a gate.

After picking, proceed to **A4.5** (`idd-suitability.instructions.md`).

## A4.5 — Pre-Claim Issue-Suitability Triage

Read [`idd-suitability.instructions.md`](idd-suitability.instructions.md)
for the full suitability triage protocol: seven checks, failure outcomes,
mutation policy, coordination rules, decision flow, and edge cases.

## Roadmap markers

Two hidden HTML comment markers are used in issue bodies to support the
discover phase:

- **Roadmap identity** (`idd-skill-roadmap-id`): placed in the roadmap
  issue body. A3 uses this marker to resolve `blocked-by` dependency
  lookups. A1 identifies the roadmap by its `roadmap` label or umbrella
  structure — not by this marker.
- **Sequential dependency** (`idd-skill-blocked-by`): placed in an
  issue body to express a hard dependency — this issue **cannot start
  until** the roadmap with the matching `roadmap-id` is closed.

**Do not use `idd-skill-blocked-by` to group sub-tasks under an active
roadmap.** Sub-tasks that should be worked on while the roadmap is open
belong in the roadmap's task list as `- [ ] #NNN` entries. The
`blocked-by` marker is reserved for issues that must wait for a
separate, prior roadmap to close before they can start (cross-phase
sequential dependency). Using it for grouping causes A3 to block every
sub-task for the entire lifetime of the roadmap.

## Scope invariant (summary)

Do not widen issue-selection scope beyond the roadmap traversal except
for the explicit query allowlist already defined in A0-T, A0-O, A1,
A1.5, A3, and A4.5, or for a same-run operator opt-in after a
zero-result report. A single explicit target authorizes only that issue;
prior or standing instructions do not count as opt-in.
