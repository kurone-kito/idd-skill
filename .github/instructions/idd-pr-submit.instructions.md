# IDD — PR Submit Phase (D)

Read this file after the self-review loop passes. It covers
pre-publication main sync, claim verification, tests, pushing, PR
creation, and waiting for CI.

Before the D1 rebase and D2 push, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

## D1 — Sync main before first push

If the branch has not been pushed yet, rebase it onto `main`. This is
the routine pre-publication history cleanup step.

After the first D-phase push, do not reuse D1 as the normal
synchronization path. Later branch updates should return through the
E-phase review loop and, by default, merge `main` into the published PR
branch so the synchronization diff is reviewable.

This D-phase file records the publication boundary and target
post-push synchronization contract. Follow-up work may still be needed
to align later-phase conflict-handling and resume-routing helpers before
that runtime route is fully active everywhere.

If D1 itself reveals content conflicts before the first push, resolve
them and continue the rebase. After completing the rebase, if any files
were manually edited during conflict resolution, run **fix-validate**
before proceeding.

## D2 — Verify claim, lint, test, push

1. Re-read the issue to confirm the claim is still yours: the **active
   claim** must still use your current `{claim-id}`. If the active claim
   is missing, released, or held by a different `{claim-id}` (even under
   the same agent ID), the claim was lost — report this and stop.
2. Run **pre-push-validate**.

   (E2E tests are verified by CI; do not run them locally.)
3. Push the branch to the remote. On the first publication push, use a
   normal push. If you are recovering an already-published branch under
   an explicit force-push exception, use `--force-with-lease` only when
   repository policy permits it and the exceptional route already
   required a rebase; otherwise stop and return to the merge-based sync
   path.

Once the branch is pushed, treat it as published review history. A PR
that is merely `BEHIND` does not force a branch update by itself unless
branch protection or explicit repository policy requires an up-to-date
head before merge.

## D3 — Create PR

Use GH CLI or GH MCP to create the pull request. The PR body must
include:

- A concise summary of the branch's changes
- A `Closes #<issue>` keyword linking the issue
- Recommended follow-up issues (if any)
- Relevant background/rationale, when it materially affects review (for
  example, reuse constraints, intentional trade-offs, or non-goals).
  Include only context grounded in the issue discussion, commits, diff,
  or explicit operator instructions; omit rather than speculate.

After creating the PR, if the repository has CODEOWNER rules or expected
reviewers that are not auto-assigned by GitHub, request them explicitly:

```sh
gh pr edit {pr-number} --add-reviewer {reviewer-login}
```

## D4 — Wait for CI

Delegate to `idd-ci.instructions.md`.

- **On success** → proceed to `idd-review-snapshot.instructions.md`
