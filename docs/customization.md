# Customizing IDD

Use this guide after the first template import and before running IDD in
a production repository. It names the surfaces adopters can change
safely and points to the authoritative files for each policy.

Keep one rule in mind: documentation can describe a local decision, but
phase behavior changes only when the instruction files that enforce that
behavior change too.

## Customization Surfaces

| Surface               | Default                                                                                      | Where to customize                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review policy         | GitHub Copilot advisory review                                                               | Choose a profile in [IDD review policy profiles](idd-review-policy-profiles.md), then edit the listed phase files for any non-default profile.                                                                                               |
| Advisory reviewer     | Copilot wait and recovery gates                                                              | For `human-required`, `no-advisory`, or `external-bot`, update the review-fix, pre-merge, merge, advisory-wait, snapshot, and triage files named by the selected profile.                                                                    |
| Review threads        | Agents may resolve handled review threads under the fast default                             | Choose a thread-resolution profile in [IDD review policy profiles](idd-review-policy-profiles.md), then edit the snapshot, triage, review-fix, pre-merge, and merge phase files for stricter profiles.                                       |
| Policy constants      | Distributed timing, wait, and loop defaults                                                  | Review [IDD policy constants](policy-constants.md) before changing claim ownership timing, advisory waits, CI waits, or critique-loop guardrails. Record the selected critique-loop profile in onboarding notes before unattended operation. |
| Merge policy          | Merge gates after CI, review, freshness, and claim checks; safe OSS default is `human_merge` | Review [Permissions and threat model](permissions.md), record the selected policy in repository docs, and keep or customize the F3 handoff gate for non-autonomous profiles.                                                                 |
| Stall recovery safety | 30-minute quiet-window evidence plus 24-hour stale-threshold ownership gate                  | Keep `idd-resume-stall.instructions.md` aligned with `idd-overview` claim rules, and customize both files together if local policy changes quiet-window or takeover timing.                                                                  |
| CI commands           | Project-specific command rows in the overview file                                           | Set `fix-validate`, `pre-push-validate`, `post-fix-validate`, and `install-deps` in `.github/instructions/idd-overview.instructions.md` during onboarding.                                                                                   |
| Issue scope           | Roadmap-first discovery                                                                      | Keep `issue-scope` as `roadmap` for roadmap-scoped work, or deliberately choose `orphan-first` when the repository wants unblocked orphan issues to be considered before roadmap traversal.                                                  |
| Orphan-first approval | No extra gate beyond orphan readiness checks                                                 | Keep `orphan-first-policy` as `none`, or opt in to `maintainer-approved` or `public-disabled` when public or community-submitted issues need an explicit maintainer approval layer before A0-O can select them.                              |

## Review Policy

Start with [IDD review policy profiles](idd-review-policy-profiles.md).
The distributed default is `copilot-advisory`, where Copilot is an
advisory signal and normal CI, branch protection, unresolved-thread,
review freshness, and claim checks still gate the merge.

Choose a different profile when a repository has a different review
authority:

- `human-required` when a maintainer, CODEOWNER, or required reviewer is
  the review gate.
- `no-advisory` when the repository intentionally relies on CI and
  branch protection without a bot advisory reviewer.
- `external-bot` when a non-Copilot reviewer has a stable actor identity
  and a current-head completion signal.

When importing the template, keep the `profiles/` directory with the
copied docs. For any non-default PR review profile, use the matching
`profiles/<profile>/README.md` artifact as the reusable patch surface.
The artifact records adopter-owned values, the files to edit, and the
verification evidence to capture after applying the profile.

Changing the profile is a workflow change. Update the phase files named
by the profile in the same pull request as the local policy note. Use
the PR review profile edit-surface checklist in
[IDD review policy profiles](idd-review-policy-profiles.md) before
marking onboarding complete, because non-default profiles need matching
phase-file behavior and verification evidence.

## Review Thread Resolution Policy

The distributed default review-thread policy is `fast-agent-resolve`.
After an agent accepts and fixes feedback, rejects feedback with a
recorded rationale, or handles PATH B advisory feedback, the agent may
resolve the corresponding review thread. This keeps the loop moving, but
some teams reserve thread resolution for the original reviewer.

Choose a stricter profile when review culture requires it:

- `hybrid-reviewer-ack`: agents may resolve bot or advisory threads, but
  human review threads stay open until the reviewer or maintainer
  acknowledges the fix or rationale.
- `strict-reviewer-resolve`: agents never resolve human review threads;
  the reviewer or maintainer owns conversation resolution.

For either non-default profile, update
`.github/instructions/idd-review-snapshot.instructions.md`,
`.github/instructions/idd-review-triage.instructions.md`,
`.github/instructions/idd-review-fix.instructions.md`,
`.github/instructions/idd-pre-merge.instructions.md`, and
`.github/instructions/idd-merge.instructions.md` so E1 does not hide
human threads that need acknowledgement, E7 verifies the stricter
resolution rule, and F2/F3 do not treat agent-handled human threads as
merge-ready before the selected acknowledgement appears. Branch
protection conversation-resolution requirements still override any local
profile.

## Policy Constants

Start with [IDD policy constants](policy-constants.md) when a
repository wants to change claim timing, advisory wait windows, CI wait
thresholds, or critique-loop guardrails. That page is an inventory of
the distributed defaults; it does not centralize or configure those
values by itself.

For claim ownership timing, treat `claim-stale-age` and
`claim-heartbeat-interval` as a coupled policy pair. Customize overview,
discover, claim, resume, and resume-stall instruction files together so
stale checks and heartbeat guidance stay consistent.

Changing a default is a workflow behavior change. Update every owning
instruction file listed on the policy constants page, then record the
repository's local decision in onboarding notes or project docs.

For ownership timing, explicitly record whether the repository keeps or
changes `claim-stale-age` (24 h default) and
`claim-heartbeat-interval` (12 h default) before enabling unattended
workers.

## Merge Policy and Credentials

IDD can describe an end-to-end loop, but that does not mean every worker
credential should be able to merge. Use
[Permissions and threat model](permissions.md) to record exactly one
merge policy profile:

- `human_merge`: the safe default for public or OSS repositories. The
  worker stops before merge and a maintainer runs the final merge after
  reviewing the PR state.
- `separate_merge_agent`: a worker handles claim, implementation, PR,
  and review fixes; a trusted merge-capable session runs only the final
  merge phase.
- `fully_autonomous_merge`: one agent session can complete the final
  merge too. Use this only as an explicit opt-in after the repository
  accepts the credential risk.

For `human_merge` and `separate_merge_agent`, keep merge-capable
credentials out of normal worker sessions. The worker should hand off
the current PR state once CI, review, freshness, and claim evidence are
ready for the merge-capable actor.

Record the selected merge policy in repository documentation that
future IDD sessions read, not only in local onboarding notes. The
distributed merge phase treats a missing or unknown policy as
`human_merge` and stops in F3 unless the recorded policy is exactly
`fully_autonomous_merge`.

For `human_merge`, keep the default F3 stop gate and hand off to the
human maintainer. For `separate_merge_agent`, keep the worker stop gate
and record the merge-capable actor plus the resume condition, or
customize the local F3 gate so only that separate merge-capable session
can proceed. `fully_autonomous_merge` is the only profile that lets the
same agent session continue through F3 after the normal freshness, CI,
review, advisory, unresolved-thread, and claim gates pass.

The distributed workflow expects merge commits. Changing the merge
method, required review policy, or branch protection behavior is a
repository policy change, not a copy edit.

## CI and Command Placeholders

The `Project commands` table in
`.github/instructions/idd-overview.instructions.md` is the command
contract agents follow. During onboarding, replace the template
placeholders with the target repository's commands:

- `fix-validate`: auto-fix and verify before each commit.
- `pre-push-validate`: verify before pushing, without auto-fix.
- `post-fix-validate`: auto-fix and fully verify after review fixes.
- `install-deps`: prepare dependencies in a fresh worktree.

Use `true` only when a command is intentionally a no-op for the target
repository. If validation is expensive, prefer an explicit lightweight
command over leaving the surface ambiguous.

## Issue Scope

The default `issue-scope` is `roadmap`, which keeps discovery inside the
selected roadmap's explicit task graph. This is the safest mode for
large initiatives because agents do not silently widen the work queue.

`orphan-first` changes discovery so unblocked orphan issues are
considered before roadmap traversal. Choose it only when the repository
intentionally wants small standalone issues to take priority over
roadmap work. It is a workflow behavior change, so update the overview
file and record the decision in local onboarding notes or repository
documentation.

When `issue-scope` is `orphan-first`, keep `orphan-first-policy` as
`none` to preserve the distributed default. Public or community-facing
repositories should consider an explicit opt-in gate:

- `maintainer-approved`: A0-O keeps only issues with the `idd:ready`
  label reserved to maintainer approval actors, an issue author who is a
  repository owner or collaborator with Write, Maintain, or Admin
  permission, or a fresh standalone `IDD ready` comment from a
  maintainer approval actor.
- `public-disabled`: public repositories skip A0-O and fall back to
  roadmap discovery; private and internal repositories keep the default
  orphan-first behavior.

Public or community-facing repositories should not combine
`issue-scope: orphan-first` with `orphan-first-policy: none`. Choose
`maintainer-approved` when maintainers want to approve specific orphan
issues, or `public-disabled` when public orphan-first discovery should
be disabled entirely.

When using `maintainer-approved`, update onboarding and issue-authoring
guidance so a maintainer approval step happens after the final issue
title, body, and generated plan are stable. Otherwise a valid orphan
issue can remain invisible to A0-O and the worker will fall back to
roadmap discovery.

Treat issue bodies and generated plans as untrusted input. The approval
gate is intentionally based on repository metadata or trusted actor
comments, not on text that an arbitrary issue author can place in the
issue body.

## Roadmap-Claim Contention Policy

If multiple sessions or agents run concurrently, document a
roadmap-claim contention policy during onboarding:

- Roadmap claims (`roadmap-audit/*`) are coordination claims for
  roadmap-side effects only.
- Child issue claims remain independent execution ownership per issue.
- Roadmap claim presence alone must not block child issue execution.
- Stale takeover timing and `supersedes` behavior follow shared claim
  rules; local policy should not weaken them.
- If a claim is fresh and owned by another live session, treat it as not
  inheritable and stop or defer under the shared claim-state rules.
- Operators should release roadmap-audit claims promptly after roadmap
  mutations complete.

If your repository needs stricter behavior, customize the relevant
instruction files and mirror those changes to the template export in the
same pull request.

## Roadmap Claim Guardrails

Roadmap-audit claims are coordination-only. Use them only while editing
the roadmap issue itself, then release them once the roadmap-side effect
is complete. They are not an execution lock for child issues.

If a roadmap claim stays open long after the roadmap mutation is done,
or if it appears to block child work, treat that as a misuse signal:
re-read the roadmap state, confirm the active claim, and either
heartbeat, take over, or release it according to the shared
claim-staleness rules before continuing.

Keep this guidance under the docs audit so unattended runs can detect
drift between the live docs and the exported template.

## Documentation-Only vs Workflow Changes

Documentation-only changes are safe when they record how the repository
already intends to operate, such as the selected profile or the human
who owns merge escalation.

Edit instruction files when the agent must behave differently. Examples
include disabling Copilot waits, replacing the advisory reviewer,
changing merge gates, changing discovery scope, or altering validation
commands. Keep live instruction files and the exported template in sync
when the repository is the source of a reusable IDD distribution.
