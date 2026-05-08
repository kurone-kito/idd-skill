# IDD — PR Submit Phase (D)

Read this file after the self-review loop passes. It covers syncing
main, verifying the claim, running tests, pushing, creating the PR, and
waiting for CI.

Before the D1 rebase and D2 push, apply the shared claim revalidation
gate. The active claim must still use your current `{claim-id}`.

## D1 — Sync main

Rebase the feature branch onto `main`. Resolve any conflicts and
continue the rebase. After completing the rebase, if any files were
manually edited during conflict resolution, run **fix-validate** before
proceeding.

## D2 — Verify claim, lint, test, push

1. Re-read the issue to confirm the claim is still yours: the **active
   claim** must still use your current `{claim-id}`. If the active claim
   is missing, released, or held by a different `{claim-id}` (even under
   the same agent ID), the claim was lost — report this and stop.
2. Run **pre-push-validate**.

   (E2E tests are verified by CI; do not run them locally.)
3. Push the branch to the remote. If D1 used rebase (history was
   rewritten), use `--force-with-lease`.

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
