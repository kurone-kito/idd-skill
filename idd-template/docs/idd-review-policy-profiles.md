# IDD Review Policy Profiles

IDD separates the execution loop from the pull request review policy as
much as possible. The default template still ships with a GitHub Copilot
advisory review step, but adopters should choose a profile explicitly
before they treat the imported workflow as final.

This page names the supported policy shapes and the instruction files
that need customization when a repository does not use the default.

## Profile Summary

| Profile            | Use when                                                                                      | Review signal                                                                          | Merge gate                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `copilot-advisory` | The repository wants the distributed default.                                                 | GitHub Copilot is requested after review-fix pushes and before merge freshness checks. | CI, human/required reviewer states, unresolved conversations, and the Copilot advisory wait.          |
| `human-required`   | A maintainer, CODEOWNER, or required reviewer must approve every PR.                          | Human review is the authoritative review signal.                                       | CI, branch protection, required reviewer approval, and unresolved conversations.                      |
| `no-advisory`      | The repository intentionally relies on CI and branch protection without an advisory reviewer. | No bot advisory reviewer is requested by IDD.                                          | CI, branch protection, human review only when configured outside IDD, and unresolved conversations.   |
| `external-bot`     | The repository wants a non-Copilot advisory bot.                                              | A named review bot provides advisory feedback with a stable completion signal.         | CI, human/required reviewer states, unresolved conversations, and the external bot's advisory signal. |

## Default Profile

`copilot-advisory` is the only profile implemented directly by the
distributed template. It keeps the current behavior:

- E14 can request a Copilot re-review for the current PR head.
- F2 and F3 can wait or hold based on Copilot advisory state.
- Copilot and CI advisory comments are handled as PATH B feedback during
  review triage.

Use this profile when GitHub Copilot pull request review is available
and the operator accepts it as an advisory signal rather than a required
human approval.

## Human-Required Profile

Use `human-required` when a person, CODEOWNER, or required reviewer is
the review authority. IDD can still collect and triage review feedback,
but the Copilot advisory wait should be removed or disabled.

Customize these surfaces after import:

- `.github/instructions/idd-review-fix.instructions.md`: remove the E14
  Copilot re-review request and wait path.
- `.github/instructions/idd-pre-merge.instructions.md`: make required
  reviewer approval and branch protection the explicit F2 review gate.
- `.github/instructions/idd-merge.instructions.md`: remove final
  Copilot advisory rechecks while keeping CI, claim, freshness, and
  unresolved-thread checks.
- Repository settings: configure CODEOWNERS, required reviews, or
  branch protection outside IDD.

## No-Advisory Profile

Use `no-advisory` only when the repository intentionally wants the
lightest PR policy: CI, branch protection, and any human review rules
configured outside IDD. This profile should not silently weaken an
existing required-review policy.

Customize the same phase files as `human-required`, but document that
there is no advisory reviewer to request, wait for, or recover. Keep the
normal review snapshot and triage phases because human comments can
still arrive on a PR.

## External-Bot Profile

Use `external-bot` when a repository wants an advisory reviewer such as
a third-party review bot instead of GitHub Copilot. Treat the bot as
advisory only if it has all of these properties:

- A stable GitHub actor identity or requested-reviewer signal.
- A clear way to prove the bot reviewed the current PR head.
- A clear completion, skipped, or unavailable state.
- A policy for classifying the bot's comments as PATH A or PATH B.

Customize these surfaces after import:

- `.github/instructions/idd-advisory-wait.instructions.md`: replace
  Copilot-specific fetch, request, pending, and wait logic with the
  external bot's equivalent signals.
- `.github/instructions/idd-review-fix.instructions.md`: request the
  external bot after pushes, or document why it is requested outside IDD.
- `.github/instructions/idd-pre-merge.instructions.md` and
  `.github/instructions/idd-merge.instructions.md`: replace Copilot
  advisory rechecks with the external bot gate.
- `.github/instructions/idd-review-snapshot.instructions.md` and
  `.github/instructions/idd-review-triage.instructions.md`: update PATH
  B rules if the external bot's comments are advisory.

If the external bot can produce blocking `CHANGES_REQUESTED` reviews or
decision-relevant comments, classify those items as PATH A unless the
operator explicitly narrows them.

## Selection Checklist

Before considering onboarding complete, record the selected profile in
the target repository's local documentation or onboarding notes.

- Choose `copilot-advisory` when the default GitHub Copilot advisory
  path is available and desired.
- Choose `human-required` when human approval is mandatory.
- Choose `no-advisory` only after confirming the repository accepts CI
  and branch protection as sufficient gates.
- Choose `external-bot` only after proving the bot's reviewer identity,
  current-head coverage signal, and wait/timeout behavior.

Changing the profile is a workflow change, not only a documentation
change. Update the phase files that enforce review and merge behavior in
the same pull request as the profile decision.
