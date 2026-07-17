# IDD — Review Fix Phase (E9–E15)

Read this file after `idd-review-triage.instructions.md` (E8) finds
Accepted PATH A items. It covers implementing fixes, validating, pushing,
replying to reviewers, and waiting for CI.

This phase also includes a repository-specific GitHub Copilot advisory
review step. Even when another local agent is driving the workflow,
follow it because the dependency is on GitHub review state, not on the
local CLI.

The advisory-review timing defaults used by E14 are named in
[IDD policy constants](../../docs/policy-constants.md). Refer there when
you need the values, but keep the phase logic here unchanged.

Apply the
[shared claim revalidation gate](idd-overview-core.instructions.md#claim-revalidation-gate)
before E9, before the E12 push, and before each E13/E14/E15 GitHub
side effect (reply, resolve, reviewer request, hold comment, or digest
update).

## E9 — Fix accepted issues

Fix all Accepted PATH A items from ReviewItems_snapshot. Run **fix-validate**.

Commit fixes atomically — one logical change per commit.

These two fix-side rules are the complement of the accept-side
"Verify before accept" rule in `idd-review-triage.instructions.md` (E5);
both cut the advisory-review round count:

- **Fix the whole class, not just the flagged line.** When an accepted
  finding is one instance of a systemic class, sweep the current diff
  (and the adjacent touched sections) and fix every instance in the same
  commit. Advisory reviewers surface issues incrementally, so a
  whole-class fix converges in fewer rounds than fixing only the flagged
  line and waiting for the next instance to be re-flagged.
- **Verify any claim a fix adds.** When a fix introduces a precision — a
  name, value, path, or described behavior — to satisfy a reviewer, check
  it against the actual implementation before committing, so the fix does
  not trade one inaccuracy for another and cost an extra round.

## E10 — Validate fixes with critique pass

Run a critique pass to verify that the fixes in E9 address the root
causes and are correct (see `idd-overview-appendix.instructions.md` for per-agent
implementation). The distributed defaults for the E10 guardrails are
listed in `docs/policy-constants.md`. Keep an E10 pass count for the
current E9 fix batch.

If the critique pass finds additional issues, fix them, commit
atomically, and run E10 again while the findings are converging.

Convergence guardrails:

- "Meaningful progress" means a pass removes at least one Accepted
  finding, narrows a remaining finding's root cause or scope, or yields
  a materially new fix direction. Reworded duplicate findings do not
  count.
- If the same Accepted findings recur for
  `critiqueLoop.e10NoProgressHoldAfter` consecutive E10 passes
  (distributed default: `3`) without meaningful progress, stop the
  auto-loop. Post a hold comment on the PR summarizing the repeated
  findings and attempted fixes, and wait for a maintainer decision
  before more E10 iterations.
- Do not use this stop condition to bypass serious issues: unresolved
  High or Medium findings remain blockers until fixed or explicitly
  redirected by a maintainer.
- If the critique pass reports zero issues, proceed to E11.

## E11 — Resolve conflicts with main

Check for conflicts between the feature branch and `main`. If conflicts
exist, merge `main` into the feature branch
(`git fetch origin main && git merge origin/main`), resolve any
conflicts, and complete the merge. On a signed-commit repo with
non-interactive-hostile primary signing (GPG pinentry / hardware-touch)
and a fallback signing wrapper for arbitrary git subcommands (pass
`-c gpg.format=ssh -c user.signingkey=<abs-path> -c commit.gpgsign=true`
to `git` before the subcommand — `git -c … merge`, not `git merge -c …`; a
commit-only alias like `git commit-ssh` will not run `merge`), **run that
`git merge origin/main` through the wrapper — not the plain command — and
continue with the wrapper's own `--continue` (`git -c … merge --continue`)**;
the wrapper must own the whole operation, so the merge commit is not
reverted to the stalling primary signing — the normal-path
complement to the recovery-path re-signing (the D1 Post-rebase
detached-HEAD recovery in `idd-pr-submit.instructions.md` and the
cwd-vs-claim cherry-pick recovery in `idd-overview-core.instructions.md`).

**Active review gate**: if the PR has unresolved review threads,
unreplied comments, or any reviewer's latest state is
`CHANGES_REQUESTED`, get explicit operator confirmation before merging
`main` into the feature branch, as the merge commit will appear in the
PR history.

## E12 — Lint, test, push

Run **post-fix-validate**.

Then push the feature branch normally (E11 uses merge commits, not
rebase, so no force push is required).

## E13 — Reply to feedback

For each Accepted PATH A item whose source is reviewer feedback (review
thread, review body, or regular comment): reply describing which commits
fixed it and how.

Start every reply with one of these prefixes so that disposition is
unambiguous:

- `**Accepted** — fixed in {commit-sha or comma-separated list}: {brief explanation}`

- **Review threads**: after posting your reply, **immediately resolve
  the thread**. When helper runtime is enabled, the profile-selected
  resolve-review-thread command (`--pr <number> --comment-id <id> --apply`,
  with `--body` / `--claim-issue` / `--claim-id`; see
  `docs/idd-helper-scripts.md`)
  posts the reply and resolves the thread in one call — dry-run without
  `--apply`, replying before resolving so a failed reply never leaves a
  silently-resolved thread; the manual REST reply + GraphQL
  `resolveReviewThread` sequence stays the fallback. Resolution means "agent
  has responded and acted on the feedback", not "reviewer has agreed". If the
  reviewer disagrees, they can reopen the thread and add a new reply, which
  will re-surface it in the next E1 pass.
- **Regular comments**: reply only; do not resolve.
- **Persistent non-review notices**: a non-review notice (rate-limit /
  usage-limit / review-limit) already dispositioned `**Rejected** — {bot}
  did not review HEAD …` in a prior pass **carries that rejection forward**
  across this push — do **not** re-post an identical rejection just because
  the notice's `updatedAt` bumped or the bot re-posted the same summary. The
  F2/F3 disposition-evidence gate honors the existing rejection while the bot
  still has not reviewed any HEAD (see the E6 non-review-notice rule). Only a
  notice the bot replaces with an actual completed review of the current HEAD
  needs a fresh disposition.

After E13 replies and resolutions are complete, upsert the PR live
status digest before E14 if the next route is still review-fix or CI
wait. Set `Phase` to `E13 feedback replied`, `Open blockers` to any
remaining reviewer, advisory, or CI wait, `Next action` to E14 or E15,
and `Authoritative by` to the accepted feedback replies, resolved
threads, current HEAD, and verified claim. Because E15 returns to E1
after CI, this digest edit is safe activity; do not use it to bypass the
next E1 snapshot.

## E14 — Re-review request

**Human reviewers**: for each reviewer whose latest state is
`CHANGES_REQUESTED` and whose items have all been addressed, request a
re-review:

```sh
gh pr edit {pr-number} --add-reviewer {reviewer-login}
```

For an **advisory bot**, try the add-reviewer command with the bot's
reviewer **login** first. On some `gh` versions this GraphQL-based
mutation fails a bot login outright (`Could not resolve user with login
'{login}' (requestReviewsByLogin)`) instead of succeeding; on that
failure, fall back to REST `requested_reviewers` with the bot's actual
account login instead — REST also silently no-ops on a bot's **display
name** and wastes a full advisory-wait cycle. See **Primary advisory
bot** below for the exact fallback commands and the login each path
needs.

**Primary advisory bot** (default Copilot; also invoked directly by
`idd-review-triage.instructions.md`'s **Zero-Accepted-PATH-A advisory
re-review gate**, which reuses steps 1-4 and the active polling loop
below with its own on-success target instead of E15): after every
push, regardless of any reviewer's state, request a re-review from the
configured primary advisory bot (`.github/idd/config.json`
`advisoryWait.primaryBotLogin`, which defaults to Copilot) if it has
not yet reviewed the current HEAD
SHA. Subject to the configured re-review request cap (`REQUEST_CAP` from
helper output or `.github/idd/config.json` `advisoryWait.requestCap`;
default 30). This is a process limit, not a GitHub-enforced constraint.

Substitute `{primary-advisory-bot}` in the commands below with that bare
login — the default is `copilot`, so the command resolves to `@copilot`.
The advisory-wait helpers resolve the same identity from policy. The AW
helper output fields keep their `COPILOT_PENDING` / `LAST_COPILOT_COMMIT`
names regardless of the configured bot.

The REST fallback needs a different identity,
`{primary-advisory-bot-rest-login}`: for the default bot this is
`copilot-pull-request-reviewer[bot]`; for a configured non-default bot it
equals `{primary-advisory-bot}`, since a configured login is already the
real account login.

1. Fetch `PR_HEAD_SHA`:

   ```sh
   PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

2. Run **AW1** (`idd-advisory-wait.instructions.md`). If **SATISFIED** →
   E14 advisory-bot processing is done; proceed to E15.
3. Run **AW2** to fetch markers.
4. Apply the **AW3** decision table:
   - **SATISFIED** → proceed to E15.
   - **HOLD** → post the hold comment from **AW4** and stop.
   - **RECOVERY_NEEDED** (`COPILOT_PENDING` is `"true"`, no same-head
     marker): post the recovery marker from **AW3-R**. Do not request
     another review from the bot.
   - **CAP_EXHAUSTED** (`REQUEST_MARKER_COUNT` ≥ `REQUEST_CAP`, no
     same-head marker) →
     if `CAP_EXHAUSTED_ROUTE` is `hold`, post the hold comment from
     **AW4** and stop. Otherwise (`phase-specific`, the default), skip
     the advisory wait entirely and proceed directly to E15.
   - **REQUEST_NEEDED** (`COPILOT_PENDING` is `"false"`, or
     `COPILOT_PENDING` is `"true"` but current-head coverage is not
     proven; request cap < `REQUEST_CAP`): request the primary advisory
     bot's review and immediately post a plain-text marker. If
     `COPILOT_PENDING` is `"true"` in this branch, first remove the
     stale/unproven pending reviewer request:

     ```sh
     gh pr edit {pr-number} --remove-reviewer "@{primary-advisory-bot}"
     ```

     On a GraphQL login-resolution failure (see above), retry via REST
     instead:

     ```sh
     gh api repos/{owner}/{repo}/pulls/{pr-number}/requested_reviewers \
       -X DELETE -f "reviewers[]={primary-advisory-bot-rest-login}"
     ```

     If removal fails because the bot is no longer pending, re-run
     AW1–AW3. If removal fails for any other reason, post the AW4
     pending-refresh-failed hold comment and stop. After removal
     succeeds, request the primary advisory bot's review the same
     gh-then-REST way:

     ```sh
     gh pr edit {pr-number} --add-reviewer "@{primary-advisory-bot}"
     # on GraphQL login-resolution failure:
     gh api repos/{owner}/{repo}/pulls/{pr-number}/requested_reviewers \
       -X POST -f "reviewers[]={primary-advisory-bot-rest-login}"
     ```

     ```text
     advisory-wait: {agent-id} {head-SHA} {ISO8601-requested-at}
     ```

     Use `PR_HEAD_SHA` as `{head-SHA}`. Post as plain text, not an HTML
     comment block.
   - **WAIT**, or after a **REQUEST_NEEDED** or **RECOVERY_NEEDED**
     marker is posted: enter the active polling loop below.
5. **Optional secondary advisory bot (non-gating).** When the helper reports
   `secondaryRequestNeeded: true` — or, in the shell fallback, when AW3 yields
   **CAP_EXHAUSTED** or a stalled / rate-limited **SATISFIED** (closed by the
   elapsed settle/pending window while the primary never reviewed the current
   HEAD), `advisoryWait.secondaryBotLogin` is configured, and that secondary
   has **not** already been `review_requested` after the current HEAD's
   `committed` event — request the secondary bot **once** for the current
   HEAD, using the same gh-then-REST fallback as the primary:

   ```sh
   gh pr edit {pr-number} --add-reviewer "@{secondary-advisory-bot}"
   # on GraphQL login-resolution failure (rare for a configured secondary,
   # which is already a real account login):
   gh api repos/{owner}/{repo}/pulls/{pr-number}/requested_reviewers \
     -X POST -f "reviewers[]={secondary-advisory-bot}"
   ```

   Post **no** `advisory-wait:` marker for the secondary (it must never satisfy
   the primary gate or consume the primary cap), and do **not** let it change
   the AW3 route — continue the primary route exactly as decided above (e.g.
   `CAP_EXHAUSTED` still follows `CAP_EXHAUSTED_ROUTE`). The secondary's review
   is ordinary advisory input, returned to review-triage by the E1 snapshot if
   it lands before merge. Skipped entirely when no secondary is configured.

Copilot and CI advisory bot comments are advisory; unanswered ones do
not block merge.

Whenever E14 posts an advisory request marker, recovery marker, or hold
comment, update the digest after that side effect with the current
advisory state. Use the marker or hold comment as `Authoritative by`,
set `Open blockers` to the advisory wait or hold reason, and set
`Next action` to polling, E15, or maintainer action.

**Active polling loop** (applies when `COPILOT_PENDING` is `"true"`, or
immediately after posting a marker in the **REQUEST_NEEDED** or
**RECOVERY_NEEDED** path above):

Do **not** post a new marker if a same-head marker already exists; reuse
it. If multiple same-head markers exist, always use the one with the
**earliest** `createdAt` — the advisory clock starts at the first
request, not the last.

Take a fresh activity snapshot (same scope as E1 Step 1: all threads,
review bodies, and regular comments, excluding trusted agent
operational markers only). Record the highest `updatedAt` as the
**temporary polling watermark** — do **not** post it as a
`<!-- review-watermark -->` PR comment. If the snapshot is empty, use
the `createdAt` of the latest
`<!-- review-watermark: {agent-id} {claim-id} … -->` comment whose
`{claim-id}` matches the current active claim and whose GitHub author is
a trusted marker actor. If no trusted same-claim watermark exists, stop
and return to E1 to create one.

Poll every `POLL_INTERVAL_MINUTES` minutes:

1. Re-fetch `PR_HEAD_SHA`:

   ```sh
   CURRENT_HEAD=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   ```

   If `CURRENT_HEAD != PR_HEAD_SHA` → HEAD changed; return to E1.

2. Re-read review threads, review bodies, and regular PR comments,
   **excluding trusted agent operational marker comments only** (covers
   advisory-wait, advisory-wait-recovery, review-watermark,
   review-baseline, claim, hold notes, and other operational comments
   from trusted marker actors). Marker-shaped comments from untrusted
   authors remain activity. If any item has `updatedAt` strictly newer
   than the polling watermark → return to E1 immediately.

3. Run **AW1** and **AW2** (refresh `COPILOT_PENDING`, `LAST_COPILOT_COMMIT`,
   and `EARLIEST_SAME_HEAD_AT`). Apply **AW5** if `EARLIEST_SAME_HEAD_AT`
   is empty. Then apply **AW3**:
   - **SATISFIED** → exit polling; proceed to E15.
   - **HOLD** → post hold comment from **AW4** or **AW5**; stop.
   - **WAIT** → continue polling.

Note: "advisory" means the agent is not obligated to accept every
suggestion — it does **not** mean the agent can skip waiting for a
review it explicitly requested. Human `CHANGES_REQUESTED` reviewers are
not advisory; they remain under the hold/escalation path above.

## E15 — Wait for CI

Schedule a wake, or background this wait only if the
topology-safety condition holds (confirmed to route completion back to
this turn); otherwise wait synchronously — see
[wake-up discipline](idd-ci.instructions.md#wake-up-discipline).

Use `idd-ci.instructions.md` for the polling mechanics and timing. E15
reuses the same resolved `ciWait.runningTimeout`,
`ciWait.generationTimeout`, and `ciWait.rerunPolicy` values; omitted
keys preserve the distributed defaults. The outcome paths below are
authoritative and override the shared helper's generic outcomes for this
phase:

**While polling**: if new review threads or comments arrive during the
CI wait, note them. After CI resolves (any outcome), return to E1 before
proceeding to F — do not skip triage.

- **On success** → return to `idd-review-snapshot.instructions.md` (E1)
- **On failure / code-caused**: fix, run **fix-validate**, commit
  atomically, then return to E11
- **On failure / infra-flaky or pre-existing** (failure also present on
  `main`, unrelated to this branch): apply `ciWait.rerunPolicy`
  (default `rerun-once`). If it authorizes the current rerun, rerun
  once and resume polling. If the failure persists after that rerun, or
  if the policy is `hold`, post a hold comment on the PR documenting the
  pre-existing failure and stop. A maintainer must resolve or bypass the
  failing check; do not auto-continue or treat as passed without human
  confirmation. Phrase the resume condition per the invariant-first
  guidance in `idd-overview-appendix.instructions.md` (Hold / suspend).
- **On cancelled / timed_out / code-caused**: fix, run **fix-validate**,
  commit, return to E11
- **On cancelled / timed_out / infra**: apply `ciWait.rerunPolicy`.
  Re-push or rerun CI only when the policy authorizes the current rerun;
  if the route recurs after that rerun, or if the policy is `hold`,
  post a hold comment and stop (do not loop). On success after the
  rerun, **return to E1**.
- **On failure / `idd-advisory-convergence` alone, verdict `pending: false`
  with outstanding review reasons** (see `idd-ci.instructions.md`
  §Interpretation): return to E1, not E11 — neither code-caused nor
  infra. **Unless** a maintainer has since posted a valid external-check
  waiver for this HEAD, in which case apply `ciWait.rerunPolicy` instead
  — the rerun is what makes the check reflect the waiver (see D4's
  identical carve-out and `idd-pre-merge.instructions.md`'s
  External-check waivers).

When E15 stops on a CI hold, re-validate the claim and then update the
digest with `Phase: E15 hold`, the failing or missing checks in
`Open blockers`, and the maintainer or rerun expectation in
`Next action`. On CI success, do not edit the digest before returning to
E1; let the next E1/F pass refresh review currency first.
