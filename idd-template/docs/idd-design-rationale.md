# IDD — Design Rationale and Maintainer Notes

This document collects maintainer-facing rationale, diagnostics, and
narrative justifications that explain _why_ IDD phase rules exist as
they do. The rules themselves stay in
`.github/instructions/*.instructions.md`; this file is the place to
record the context that helps future maintainers evaluate edits to
those rules without bloating the auto-loaded instruction surface.

Each section corresponds to one phase file. Add new rationale entries
under the matching phase heading. Behavior-changing constraints
(fail-closed defaults, claim revalidation, marker authority) must
remain in the instruction files.

## Discover

### A3 — Diagnostic: all candidates blocked by an open roadmap

When the A3 decision tree reports zero ready-to-start candidates and
every candidate is blocked by an
`<!-- {{PROJECT_MARKER_PREFIX}}-blocked-by: X -->` marker that points
to an open roadmap, the markers may be misused as grouping tags.
Sub-tasks that run while the roadmap is open belong in the task list
(`- [ ] #NNN`); the `blocked-by` marker is reserved for issues that
must wait for a separate roadmap to close first. Treat this pattern
as a likely authoring defect, not a real dependency stall.

### A4 Step 1.5 — Rationale: active-claim pre-scan

Active-claim pre-scans eliminate known collisions deterministically
and reduce wasted claim-post-recheck cycles, improving scale-out
efficiency when multiple sessions start simultaneously. Without the
pre-scan, parallel sessions all claim the lowest-numbered viable
candidate at the same second, then race the same-second tie-break;
the pre-scan moves the resolution earlier in the pipeline so most
sessions never touch the same issue.

### A4 Step 2 — Rationale: concurrent-selection desync

A4 Step 1.5 (active-claim pre-scan) and A5(e) (collision detection plus
same-second tie-break) only resolve a selection collision **reactively**:
a losing session has already posted its claim and snapshot, then re-enters
Discover and — because Step 2's tie-break is the fully deterministic
lowest-issue-number — **re-collides** on the next candidate. Observed in a
multi-session run as a 3-way race on one score-5 issue whose two losers
then re-collided on the next lowest number.

The opt-in `discover.selectionDesync: session-offset` knob adds a
**proactive** desync: within a single highest-score tie band it picks the
entry at `selectDesyncedIndex(session-token, band-size)` (a pure
`hash(session-token) mod band-size`, the token being the selection-time
`{agent-id}`) instead of always index 0, spreading concurrent sessions
across _different_ eligible issues up front.

It is off by default and reorders **only within** a same-score tie band so
the documented score-then-lowest-number ranking is the unchanged single-
session and fallback behavior. The load-bearing invariant is that the
branch name (`issue/<n>-<slug>`) derives from the issue, not selection
order, so spreading sessions across different issues never breaks the
same-issue branch convergence that A5(e) and the `branch-name` helper rely
on. The desync never crosses score bands and never bypasses the A4.5/A5
gates; the in-band offset function is replaceable without affecting these
invariants.

## Claim resolution

### Forced-handoff strictness: strict resume vs. lenient relay-merge

Both the resume-routing read (`evaluateResumeClaimRouting` in
`resume-claim-routing.mts`) and the pre-merge write-gate
(`summarizeClaimValidation` in `protocol-helpers.mts`) resolve the active claim
through the **single** shared `resolveActiveClaim`, so there is no forked
claim-state logic. They deliberately pass **different** forced-handoff options,
and that difference is intentional policy, not drift:

- **Resume routing is strict.** It sets `requireAuthorMatchesForcedBy: true`
  (rule 7's author/`forcedBy` binding) and never passes `prFirstCommitAt`.
  Resume is a _takeover_ decision, so it must block the same-identity
  self-signed hijack and reject an issue-only handoff that targets a PR-backed
  claim.
- **The merge write-gate is lenient.** It leaves `requireAuthorMatchesForcedBy`
  at its off default and passes `prFirstCommitAt`, applying the Part-B allowance
  (kurone-kito/idd-skill#1058, an issue-only handoff predating the PR). The
  merge gate re-validates an _already-verified_ session and must tolerate a
  maintainer-authorized handoff relayed by a separate automation actor;
  authorization then rests on `isAuthorizedForcedHandoff` alone.

Because the two callers apply different strictness, they can return **different
verdicts for the same corrected-handoff state** — resume may report
`already_owned` while the merge gate reports `claimLost`. This is expected: the
verdicts answer different questions (may I take over? vs. does this verified
session still own the write?).

The split is kept intentionally (see kurone-kito/idd-skill#1155): the structural
risk the adopter raised — two divergent resolvers — is already removed by the
shared `resolveActiveClaim`, and forcing both sides strict would break the
legitimate relay use-case. Any future change here must preserve the single
resolver (do not fork `resolveActiveClaim`) and the resume-side
self-signed-hijack block.
