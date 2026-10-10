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
reports. This page is the companion reference for issue #3824. The
always-loaded instructions point here.

## Definition

A repository is global-only when both of these hold.

1. `idd-activation`, run from the primary checkout, reports an active
   result whose reason is `repository-policy-minimal-import` (a policy
   document only) or `user-global-override-match` (a user-global override).
   Both reasons mean the instructions come from the installed payload.
2. The trusted base ref has no `.github/workflows/idd-advisory-convergence.yml`.

If either condition fails, the advisory check stays required, exactly as in
a repository-local install.

## Trust rule

A pull request cannot make itself global-only. The base-ref check reads
`main`, which a pull request cannot change. Activation is read from the
primary checkout, not from the pull request's head, so a pull request
cannot add a policy document to switch the profile on. The check is a
trusted-base read, like the other merge-gate reads.

## Pre-merge readiness

Pass `--global-only` to `pre-merge-readiness` (or `idd-merge-execute`, which
forwards it). The flag takes effect only when both conditions above hold.
Then the advisory check is removed from the required list. Advisory
convergence is still judged by the local pre-merge readiness helper, as it
is today. Without the flag, or when either condition fails, nothing changes.

## F4 cleanup

Under this profile no `post-merge-cleanup.yml` run exists. Do not wait for
one. Run the local cleanup path directly.

## Onboarding labels

No file is committed for the labels, so create the configured IDD labels
through the GitHub API, for example with `gh label create`, as the
global-only setup step.
