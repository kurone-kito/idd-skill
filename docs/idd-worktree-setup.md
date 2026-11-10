---
type: guide
title: IDD Worktree Setup (B1)
description: Explains the branch, worktree, dependency, and self-check steps for entering the IDD work phase.
---

# IDD Worktree Setup (B1)

Use this guide for B1 setup and complete it before B2 planning. For a
fresh claim, create the sibling worktree during A5 before posting the
claim. After the claim and activation nonce are posted, resume here at
[Lock the worktree before installing dependencies](#lock-the-worktree-before-installing-dependencies).
The post-acquire claim assertion follows that lock step. For a
takeover, follow live claim and resume routing first, then use only
the matching branch-attachment path below. The
[work and self-review phase instructions](../.github/instructions/idd-work.instructions.md#b1--create-worktree-with-branch)
remain authoritative; follow them whenever this guide is abbreviated.

This guide does not authorize a claim takeover or recovery. For those
decisions, follow the [claim phase](../.github/instructions/idd-claim.instructions.md)
and the [resume detail reference](idd-resume-detail.md).

## Resolve the branch roles

Keep the **default branch** and **development branch** distinct:

- The default branch is the repository's live default branch. B1 keeps
  the primary checkout on it and fast-forwards it before creating a
  sibling worktree.
- The development branch is the base for a new issue branch. Resolve it
  from the effective policy's `developmentBranch`; if that setting is
  absent, use the repository's live default branch. Validate it and
  confirm it exists on `origin`. Stop if it is invalid or unavailable;
  do not guess or silently fall back.

## Synchronize the primary checkout

Use the [clone-scoped lock](idd-helper-scripts.md#clone-scoped-lock) to
serialize shared-clone fetch, fast-forward merge, and worktree add or
remove operations. From the primary
worktree, confirm the default branch is checked out, then run:

```sh
git fetch origin
git log origin/{default-branch}..{default-branch} --oneline
```

Proceed to the fast-forward only when `git log` succeeds with no output.
If `origin/{default-branch}` is missing, the command fails, or it prints
commits, stop and report; do not reset or overwrite the local branch:

```sh
git -c merge.autoStash=false merge --ff-only origin/{default-branch}
```

If the fast-forward fails, stop before creating the worktree and report
the failure. A dirty-worktree failure is a hold. See issue `#5058` and
the [work and self-review rationale](idd-design-rationale.md#work-and-self-review).
Preserve staged and unmerged paths and ask the operator to resolve the
index. For other dirty paths, follow the phase instruction's preservation
rule. Do not stash, discard, or remove the primary worktree. Keep its
`HEAD` on the default branch throughout B1.

## Create or attach the issue worktree

Use the claimed branch name exactly. Compute its sibling path as
`../<repo-name>.<branch-with-slashes-replaced-by-hyphens>`.
For example, `issue/123-add-feature` becomes
`../<repo-name>.issue-123-add-feature`.

Check `git worktree list` and the target path before creating anything:

- If the path exists but is not a registered worktree, stop for manual
  cleanup.
- If the branch is already checked out, inspect that worktree and follow
  the live claim and lock rules before reusing or removing it.
- Reuse an inheritable local or remote branch on takeover; never replace
  its history with a fresh branch. If an unexpected branch cannot be
  safely deleted, preserve it and stop for a decision.

Before a fresh-claim create command, run `git branch --list
<claimed-branch>`. If the branch exists, follow step 3 in the
[B1 phase instructions](../.github/instructions/idd-work.instructions.md#b1--create-worktree-with-branch)
to reuse an inheritable branch for a takeover, safely delete an
unexpected leftover, or stop for manual cleanup when step 3 requires a
hold. Do not run the fresh-claim command until the local branch check
is clear.

During A5, before the claim POST, resolve and fetch the development
branch. For a fresh claim, create the branch from that base without
tracking it:

```sh
git worktree add --no-track <path> -b <claimed-branch> origin/{development-branch}
```

For an authorized takeover with a local branch, attach that branch:

```sh
git worktree add <path> <claimed-branch>
```

For a remote-only branch, fetch and attach the existing remote tip:

```sh
git fetch origin
git worktree add <path> -b <claimed-branch> origin/<claimed-branch>
```

WorkTrunk may be used for an authorized takeover when its target path
and branch can be pinned to the required values. Do not use its
create hook for a fresh claim: a pre-start install can run before the
claim and worktree lock exist (preventive; no observed incident yet).
Issue `#3960` documents only the fresh-claim order, with the worktree
and branch created before the claim POST and the lock acquired after it;
it does not document a WorkTrunk hook failure. For hook setup, approval,
and the exact WorkTrunk command, follow the
[B1 phase instructions](../.github/instructions/idd-work.instructions.md#worktree-creation).

## Lock the worktree before installing dependencies

After the claim POST and activation-nonce verification, prepare the
worktree-local lock and token record before B1 installation. For a fresh
claim, repeat `--record-tokens --nonce` for this worktree, then acquire
the lock with the active `agent-id` and `claim-id`. For a takeover,
acquire the lock first, then record the same nonce in this worktree.
Read the lock and token record back and run the post-acquire claim
assertion after its settle delay before installing dependencies. The
[claim phase lock procedure](../.github/instructions/idd-claim.instructions.md#worktree-local-lock-file-same-machine-collision)
defines the helper commands and the helper-free fallback.

On a takeover, any pre-start hook that installs dependencies must make
lock acquisition, then token recording, its first commands before the
install. If those checks cannot run before the hook, skip its automatic
install and use the manual sequence after entering the worktree. Never
let a lifecycle hook write into an unverified or unowned worktree. These
hook rules are preventive; no observed incident yet.

## Install and verify dependencies

On a takeover, a pre-start hook that followed the hook rules in the lock
section above may already have completed the whole configured
`commands.install-deps`, not only its install step. If it did, skip the
configured command below and go to verification. Otherwise, run the
repository's configured `commands.install-deps` from inside the claimed
worktree. The command name in the IDD configuration is a configuration key,
not necessarily a package-manager script; invoke it as written. It must be
safe to rerun after a retry or worktree recreation.

When the configured command uses the
[`verify-install-deps` helper](idd-helper-scripts.md), verify the install
after either path. Some package managers can report success while leaving a
required binary absent, as observed in issue `#1237` (see the
[incident rationale](idd-design-rationale.md#b1-step-3--install-deps-silent-under-install-detection)).
The helper checks the post-install artifact named by its `--key-binary` and
retries the install once before it fails loudly. After a pre-start hook
completed the install, check that artifact in the claimed worktree by its
explicit path, not from the current directory, so an artifact in the primary
checkout cannot satisfy the check. If it is still missing, run the configured
command once, which is safe to rerun, and check again. If it is still missing,
post a hold and stop before B2, as the B1 self-check does. Without the helper,
no artifact check is defined here; the hook rules above are the only check.

## Run the B1 self-check

Before planning, verify all three conditions:

1. `git -C <primary-worktree-root> rev-parse --abbrev-ref HEAD` returns
   the resolved default branch.
2. `git worktree list` includes the expected sibling worktree path.
3. The agent's current working directory is that sibling worktree.

If any check fails, stop before B2 and post a hold describing the
failed check. Do not continue implementation from the primary checkout.
Repair only through the B1 worktree procedure after confirming no work
will be lost. A host-isolated worktree follows the explicit exception
in the [B1 phase instructions](../.github/instructions/idd-work.instructions.md#already-inside-a-host-isolated-worktree).
