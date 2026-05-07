# IDD — Discover Phase (A1–A4)

Read this file when starting a new task. It covers finding and selecting
the next issue to work on. After selecting, read
`idd-claim.instructions.md` to claim it.

**Abort conditions**: A1, A3 (default; see decision tree). **Early stop
condition**: A4 (no claim made — see below).

## A1 — Find the roadmap

Use GH CLI or GH MCP to find the roadmap among open issues. Identify it
by the `roadmap` label (project field) or by recognizing it as an
umbrella issue. If no roadmap issue exists, report and abort.

**Note**: A1 is the only IDD phase that may use repo-wide or label-based
issue queries to locate an issue — solely to find the roadmap. The A3
`idd-skill-blocked-by` dependency check also permits a
narrow body-content search; see A2 for details.

## A2 — Enumerate sub-issues

Starting from the roadmap found in A1, recursively collect all issues it
references. Include transitively referenced issues. Collect only
**open** issues.

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

- **A1 only**: any method (including `gh issue list`, `gh search`, or
  label-based queries) to locate the roadmap issue itself.
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

For each issue from A3, evaluate **all three** criteria. Fail any one →
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

After picking, continue to `idd-claim.instructions.md`.
