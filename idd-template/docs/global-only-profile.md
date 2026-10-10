---
type: reference
title: Global-only profile
description: Defines the global-only IDD profile, its trust rule, and its pre-merge and cleanup behavior.
tags: [global-only, profile, readiness]
---

# Global-only profile

A global-only profile runs IDD with no workflows committed to the
repository. The instructions come from the installed payload, and the
template advisory-convergence workflow (`idd-advisory-convergence`) never
reports. The merge and cleanup instructions point here.

## Definition

A repository is global-only when both of these hold.

1. The primary checkout's `idd-activation` reports an active result whose
   reason is `repository-policy-minimal-import` (a policy document only) or
   `user-global-override-match` (a user-global override). Both reasons mean
   the instructions come from the installed payload.
2. The trusted base ref has no `.github/workflows/idd-advisory-convergence.yml`.
   The contents API answers "not found" both for a missing file and for a
   caller without contents access, so the check first reads the repository
   root listing. Only a readable root with no such file counts as absent.

If either condition fails, or either read fails, the advisory check stays
required, exactly as in a repository-local install.

## Trust rule

A pull request cannot make itself global-only. Activation is read from the
primary checkout (the main worktree), never from a linked worktree, so a
pull request cannot add a policy document to switch the profile on. The
base-ref check reads the PR's trusted base ref, which a pull request cannot
change, so it
cannot switch the advisory gate off by deleting its own workflow.

## Pre-merge readiness

Pass `--global-only` to `pre-merge-readiness` (or `idd-merge-execute`, which
forwards it). The flag takes effect only when both conditions hold. Then the
advisory check is removed from the required list. Without the flag, or when
either condition fails, nothing changes.

If the primary checkout cannot be listed, or its origin remote does not name
the target repository, activation is unavailable and the check stays
required. An ignore entry never drops a source-pinned requirement, so a
required check whose ruleset entry names an app stays required. A
same-named context without such a pin cannot be told apart from the template
check by ruleset data alone. That case remains a residual risk.

Removing the check does not lift the CI gate's fail-closed rule. When the
advisory check was the only required check, no required checks remain. The
CI gate then reports `noRequiredChecksConfigured` and still holds the merge.
That hold is deliberate: an empty required list looks the same as a
misconfigured ruleset. A repository that wants to merge under this profile
with no other required check needs its own recorded decision before the
merge gate can pass.

## F4 cleanup

Under this profile no `post-merge-cleanup.yml` run exists. Do not wait for
one. Run the local cleanup path directly.

## Onboarding labels

No file is committed for the labels, so create the configured IDD labels
through the GitHub API, for example with `gh label create`, as the
global-only setup step.
