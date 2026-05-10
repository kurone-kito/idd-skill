# IDD Policy Constants

This page inventories the distributed IDD policy defaults that currently
appear in the instruction files. It is a reference page only: changing a
value here does not change runtime behavior, and this page does not
promise a configuration mechanism that the instruction files have not
implemented yet.

The values below are the named policy defaults that onboarding and
customization docs refer to. When a repository keeps the distributed
default, the instruction files continue to enforce the same behavior; the
names just make the defaults easier to record and change consistently.

Use it during onboarding to identify which defaults a repository accepts
as-is and which defaults need a follow-up workflow change.

## Ownership Defaults

| Policy key                 | Policy default            | Distributed value                                                                                                                             | Owning surface                                                                                                                                                                                                                                                                                                                             | Onboarding expectation                                                                    |
| -------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `claim-stale-age`          | Active claim stale age    | 24 h                                                                                                                                          | [IDD overview](../.github/instructions/idd-overview.instructions.md), [Discover](../.github/instructions/idd-discover.instructions.md), [Claim](../.github/instructions/idd-claim.instructions.md), [Resume](../.github/instructions/idd-resume.instructions.md), [Resume stall](../.github/instructions/idd-resume-stall.instructions.md) | Keep unless the repository intentionally wants faster or slower stale-claim takeover.     |
| `claim-heartbeat-interval` | Claim heartbeat interval  | 12 h                                                                                                                                          | [IDD overview](../.github/instructions/idd-overview.instructions.md)                                                                                                                                                                                                                                                                       | Keep unless long-running unattended sessions need a different heartbeat cadence.          |
| `claim-revalidation-gate`  | Claim revalidation points | Before side effects including heartbeats, holds, issue or PR plan comments, pushes, rebases, replies, resolves, reviewer requests, and merges | [IDD overview](../.github/instructions/idd-overview.instructions.md)                                                                                                                                                                                                                                                                       | Treat as a safety invariant; changing it is a workflow behavior change, not a local note. |

Record the selected values for `claim-stale-age` and
`claim-heartbeat-interval` in repository onboarding notes before running
unattended sessions.

## Merge Policy Defaults

| Policy default                      | Distributed value                                                                 | Owning surface                                                                                | Onboarding expectation                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Merge policy when missing           | `fully_autonomous_merge`                                                          | [Merge](../.github/instructions/idd-merge.instructions.md)                                    | Keep unless the repository explicitly opts out to `human_merge` or `separate_merge_agent`. |
| Unknown merge policy handling       | Hold and require maintainer decision before F3 freshness fetch, merge, or cleanup | [Merge](../.github/instructions/idd-merge.instructions.md)                                    | Treat as a safety gate; unknown values must not silently route to another policy.          |
| Non-autonomous merge-policy handoff | `human_merge` and `separate_merge_agent` stop before merge and hand off           | [Merge](../.github/instructions/idd-merge.instructions.md), [Customization](customization.md) | Keep unless the repository intentionally customizes F3 handoff behavior.                   |

## Advisory Review Defaults

The distributed PR policy is `copilot-advisory`. These values apply to
that profile and remain policy defaults until the relevant instruction
files are edited.

| Policy default                          | Distributed value                                                           | Owning surface                                                                                                                                                                                                       | Onboarding expectation                                                                       |
| --------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Copilot re-review request cap           | 30 requests per PR                                                          | [Review fix](../.github/instructions/idd-review-fix.instructions.md), [Advisory wait](../.github/instructions/idd-advisory-wait.instructions.md)                                                                     | Confirm that the repository accepts this process cap before using the default advisory flow. |
| Pending same-head advisory wait         | 30 min                                                                      | [Advisory wait](../.github/instructions/idd-advisory-wait.instructions.md), [Pre-merge](../.github/instructions/idd-pre-merge.instructions.md)                                                                       | Keep for the default profile; customize only with the full advisory wait surface.            |
| Submitted or cancelled advisory wait    | 10 min                                                                      | [Advisory wait](../.github/instructions/idd-advisory-wait.instructions.md), [Pre-merge](../.github/instructions/idd-pre-merge.instructions.md)                                                                       | Keep for the default profile; customize only with the full advisory wait surface.            |
| Active advisory polling interval        | 2 min                                                                       | [Review fix](../.github/instructions/idd-review-fix.instructions.md), [Advisory wait](../.github/instructions/idd-advisory-wait.instructions.md), [Pre-merge](../.github/instructions/idd-pre-merge.instructions.md) | Tune only with the advisory wait instructions and the repository's rate-limit tolerance.     |
| Advisory cap exhausted routing in E14   | Skip the advisory wait and proceed to E15                                   | [Review fix](../.github/instructions/idd-review-fix.instructions.md)                                                                                                                                                 | Keep unless a stricter profile requires maintainer review after the cap is exhausted.        |
| Advisory cap exhausted routing in F2/F3 | Hold and require maintainer action                                          | [Advisory wait](../.github/instructions/idd-advisory-wait.instructions.md), [Pre-merge](../.github/instructions/idd-pre-merge.instructions.md), [Merge](../.github/instructions/idd-merge.instructions.md)           | Treat as a merge safety gate; customize only with explicit repository policy.                |
| Human re-review response wait           | 30 min after addressed `CHANGES_REQUESTED` feedback has a re-review request | [Pre-merge](../.github/instructions/idd-pre-merge.instructions.md)                                                                                                                                                   | Keep unless the repository has a different required-reviewer response window.                |

## CI Wait Defaults

| Policy default                         | Distributed value                                                             | Owning surface                                                                                                                     | Onboarding expectation                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Queued or in-progress CI timeout       | 30 min                                                                        | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Keep unless the repository's normal CI duration requires a longer or shorter wait.          |
| Queued or in-progress CI recovery      | Rerun CI once, then hold if still incomplete                                  | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Keep unless the repository has a different flaky-CI escalation policy.                      |
| Failed required check recovery         | Rerun once for infra or flaky failure; fix code-caused failure                | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Keep unless the repository has a different failure triage and rerun policy.                 |
| Cancelled or timed-out CI recovery     | Re-push or rerun CI for infra causes; fix code-caused cancellation or timeout | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Keep unless the repository has a different cancellation or timeout escalation policy.       |
| Review-fix CI infra recovery           | Rerun once; hold if the infra-flaky or pre-existing failure persists          | [Review fix](../.github/instructions/idd-review-fix.instructions.md), [CI polling](../.github/instructions/idd-ci.instructions.md) | Keep unless E15 should use a different review-fix failure escalation path.                  |
| Required check generation wait         | 10 min                                                                        | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Keep unless branch protection or workflow dispatch latency is known to need another window. |
| Missing workflow after generation wait | Hold and escalate to a maintainer                                             | [CI polling](../.github/instructions/idd-ci.instructions.md)                                                                       | Treat as a safety default; replacing it should be an explicit workflow change.              |

## Critique And Review Loop Defaults

| Policy default                          | Distributed value                                                                  | Owning surface                                                             | Onboarding expectation                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C-phase zero-finding critique           | Proceed to PR submit                                                               | [Work and self-review](../.github/instructions/idd-work.instructions.md)   | Keep unless the repository wants repeated clean critique passes; record any stricter profile in onboarding notes.            |
| C-phase accepted-finding gate           | Proceed to PR submit when Accept count is 0                                        | [Work and self-review](../.github/instructions/idd-work.instructions.md)   | Keep unless the repository wants a different disposition threshold for critique findings.                                    |
| C-phase low-severity loop guard         | After more than 3 loops, skip when all remaining Accepted items are Low severity   | [Work and self-review](../.github/instructions/idd-work.instructions.md)   | Tune only with a stricter review-budget policy.                                                                              |
| E8 accepted PATH A gate                 | Proceed to pre-merge when Accepted PATH A count is 0                               | [Review triage](../.github/instructions/idd-review-triage.instructions.md) | Keep unless review triage should require a different accepted-feedback threshold.                                            |
| E10 zero-finding critique               | Proceed to E11 when the review-fix critique pass reports zero issues               | [Review fix](../.github/instructions/idd-review-fix.instructions.md)       | Keep unless the repository wants repeated clean review-fix critique passes; record any stricter profile in onboarding notes. |
| E10 repeated accepted finding guard     | Hold after 3 consecutive passes without meaningful progress                        | [Review fix](../.github/instructions/idd-review-fix.instructions.md)       | Keep unless maintainers want a different stop condition for non-converging fixes.                                            |
| Rejected `CHANGES_REQUESTED` escalation | Escalate after 24 h; after 48 h consider `status:needs-decision` and claim release | [Review triage](../.github/instructions/idd-review-triage.instructions.md) | Keep unless the repository has an explicit reviewer escalation service-level expectation.                                    |

## Changing A Default

For now, this page records the defaults; it does not centralize them.
When a repository chooses a non-default value, update every owning
instruction file that enforces the behavior, then record the local
decision in [Customization](customization.md) or repository onboarding
notes.

If the source distribution changes a policy default, keep this page, the
owning instruction files, exported template docs, and sync manifest in
the same pull request.
