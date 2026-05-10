# Customizing IDD

Use this guide after the first template import and before running IDD in
a production repository. It names the surfaces adopters can change
safely and points to the authoritative files for each policy.

Keep one rule in mind: documentation can describe a local decision, but
phase behavior changes only when the instruction files that enforce that
behavior change too.

## Customization Surfaces

| Surface           | Default                                                                                      | Where to customize                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review policy     | GitHub Copilot advisory review                                                               | Choose a profile in [IDD review policy profiles](idd-review-policy-profiles.md), then edit the listed phase files for any non-default profile.                                              |
| Advisory reviewer | Copilot wait and recovery gates                                                              | For `human-required`, `no-advisory`, or `external-bot`, update the review-fix, pre-merge, merge, advisory-wait, snapshot, and triage files named by the selected profile.                   |
| Merge policy      | Merge gates after CI, review, freshness, and claim checks; safe OSS default is `human_merge` | Review [Permissions and threat model](permissions.md), record the selected policy in repository docs, and customize handoff before F3 for non-autonomous profiles.                          |
| CI commands       | Project-specific command rows in the overview file                                           | Set `fix-validate`, `pre-push-validate`, `post-fix-validate`, and `install-deps` in `.github/instructions/idd-overview.instructions.md` during onboarding.                                  |
| Issue scope       | Roadmap-first discovery                                                                      | Keep `issue-scope` as `roadmap` for roadmap-scoped work, or deliberately choose `orphan-first` when the repository wants unblocked orphan issues to be considered before roadmap traversal. |

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

Changing the profile is a workflow change. Update the phase files named
by the profile in the same pull request as the local policy note.

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
future IDD sessions read, not only in local onboarding notes. For
`human_merge` and `separate_merge_agent`, also add repository-specific
agent guidance or phase-file customization so normal workers stop before
F3 and hand off to the human maintainer or separate merge-capable
session. Documentation alone will not stop F3 if the same worker session
still has merge-capable credentials.

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

## Documentation-Only vs Workflow Changes

Documentation-only changes are safe when they record how the repository
already intends to operate, such as the selected profile or the human
who owns merge escalation.

Edit instruction files when the agent must behave differently. Examples
include disabling Copilot waits, replacing the advisory reviewer,
changing merge gates, changing discovery scope, or altering validation
commands. Keep live instruction files and the exported template in sync
when the repository is the source of a reusable IDD distribution.
