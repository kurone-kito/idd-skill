---
applyTo: "**"
---

# IDD (Issue-Driven Development) — Shared Definitions

## Claim format

Post this HTML comment to an issue to claim it or take it over:

```html
<!-- claimed-by: {agent-id} {claim-id} supersedes: {prior-claim-id|none} {ISO8601-timestamp} branch: {branch-name} -->
```

**Important**: all operational comments (`claimed-by`, `unclaimed-by`,
`review-watermark`, `review-baseline`) consist entirely of HTML
comments. Some GitHub client tools (e.g., `gh issue comment`,
`gh api -f body=`) silently reject such bodies. Always post these using
a direct HTTP `POST` with a JSON body (e.g., `curl` with
`-H "Content-Type: application/json"` and
`-d '{"body":"<!-- ... -->"}'`).

- `{claim-id}` is an opaque unique token for one active claim lineage.
  Generate a fresh value on every fresh claim or takeover. Reuse the
  same `{claim-id}` only for heartbeats of that already-verified claim.
- `{prior-claim-id}` is `none` for a fresh claim on an unclaimed issue.
  For a takeover (same-agent restart, handoff, or stale-claim recovery),
  set it to the currently active claim's `{claim-id}`.

## Unclaim format

Post this comment to release a claim (on abort or voluntary release):

```html
<!-- unclaimed-by: {agent-id} {claim-id} {ISO8601-timestamp} -->
```

## Claim-state parsing

To determine the current active claim, read issue comments
chronologically and apply these rules:

1. Start with **no active claim**.
2. A `claimed-by` whose `{agent-id}` AND `{claim-id}` both match the
   current active claim is a **heartbeat**. Refresh the active claim's
   GitHub `created_at`.
3. A `claimed-by` with a **new** `{claim-id}` becomes the active claim
   only if either:
   - there is no active claim AND its `supersedes:` value is `none`, or
   - its `supersedes:` value exactly matches the current active claim's
     `{claim-id}`, and either:
     - it uses the **same** agent ID as the current active claim
       (explicit same-agent takeover), or
     - the current active claim is already **stale** at the new
       comment's GitHub `created_at` timestamp.
4. An `unclaimed-by` releases the claim only if its `{agent-id}` AND
   `{claim-id}` both match the current active claim. Otherwise ignore it
   as a stale release from a superseded session.
5. Any `claimed-by` whose `{claim-id}` matches the active claim but
   whose `{agent-id}` differs, or whose `{claim-id}` was already
   superseded, or whose `supersedes:` value does not match the current
   active claim when one exists, is ignored as a stale or invalid event.

Same-agent restarts never silently inherit an active claim. They must
perform an explicit takeover with a fresh `{claim-id}` that
`supersedes:` the currently active claim.

## Legacy claim migration

Older issues may still contain the legacy claim format:

```html
<!-- claimed-by: {agent-id} {ISO8601-timestamp} branch: {branch-name} -->
```

and the matching legacy release format:

```html
<!-- unclaimed-by: {agent-id} {ISO8601-timestamp} -->
```

Treat these legacy comments as **migration-only** inputs:

- If an issue has no new-format `claimed-by` comments yet, first check
  whether the latest legacy `claimed-by` comment is followed by a later
  legacy `unclaimed-by` comment from the same agent. If so, treat the
  issue as **unclaimed**; skip directly to posting a fresh new-format
  claim with `supersedes: none`.
- Otherwise, use the latest legacy claim to decide branch reuse,
  staleness, and whether a same-agent resume is occurring.
- Then immediately post a new-format `claimed-by` comment with a fresh
  `{claim-id}` before any further side effects.
- Use `supersedes: none` for that one-time migration claim, because the
  legacy format has no `{claim-id}` to reference.
- After a new-format claim exists, ignore all legacy claim and unclaim
  comments for active-claim parsing and revalidation.

## Thresholds

- **Stale**: an active claim whose latest **valid** `claimed-by`
  comment's GitHub `created_at` is ≥ 24 h ago. Another agent may take it
  over by posting a fresh `{claim-id}` whose `supersedes:` value is that
  active claim's `{claim-id}`.
- **Heartbeat**: after re-validating ownership, re-post the claim
  comment every 12 h while holding or when any phase is expected to
  exceed 12 h. The latest **valid** `claimed-by` comment for the same
  `{claim-id}` resets the stale clock. Embed timestamps are ignored;
  only the GitHub `created_at` of the comment itself counts.

## Claim revalidation gate

Before any step that can mutate git state or publish GitHub side effects
(claim heartbeat, hold or unclaim comment, issue or PR plan comment,
push, rebase, reply, resolve, reviewer request, merge), re-read the
issue and parse the active claim. The active claim must still use your
current `{claim-id}`. If it does not, the claim was lost. Stop, do not
post further operational comments, and report the handoff or race.

## Abort

On abort, re-validate ownership first. If the active claim still uses
your current `{claim-id}`, post an `unclaimed-by` comment with that same
`{claim-id}`. If the active claim no longer uses your `{claim-id}`, do
not post a release comment because another session already took over.
Open PR and remote branch left by a stale or unclaimed state are
inheritable by the next agent (see `idd-resume.instructions.md`).

## Hold / suspend

Keep the claim. Post the hold reason and resume condition to the PR or
issue comment. After re-validating ownership, re-post the claim comment
with the same `{claim-id}` every 12 h as heartbeat.

## Roadmap markers

Two hidden HTML comment markers are used in issue bodies to support the
discover phase:

- **Roadmap identity** (`{{PROJECT_MARKER_PREFIX}}-roadmap-id`): placed
  in the roadmap issue body. A3 uses this marker to resolve `blocked-by`
  dependency lookups. A1 identifies the roadmap by its `roadmap` label
  or umbrella structure — not by this marker.
- **Sequential dependency** (`{{PROJECT_MARKER_PREFIX}}-blocked-by`):
  placed in an issue body to express a hard dependency — this issue
  **cannot start until** the roadmap with the matching `roadmap-id` is
  closed.

**Do not use `{{PROJECT_MARKER_PREFIX}}-blocked-by` to group sub-tasks
under an active roadmap.** Sub-tasks that should be worked on while the
roadmap is open belong in the roadmap's task list as `- [ ] #NNN`
entries. The `blocked-by` marker is reserved for issues that must wait
for a separate, prior roadmap to close before they can start (cross-
phase sequential dependency). Using it for grouping causes A3 to block
every sub-task for the entire lifetime of the roadmap.

## Scope invariant

Agents must not widen issue-selection scope beyond what the roadmap
explicitly references (directly or transitively) without explicit
operator instruction. Specifically:

- Repo-wide searches (`gh issue list`, `gh search`, label-based queries)
  are permitted only in **A1** (to locate the roadmap itself) and for
  the scoped `{{PROJECT_MARKER_PREFIX}}-roadmap-id` body-content lookup
  required by A3's dependency-marker check.
- After a zero-result report at A3, an operator may grant a one-time
  opt-in for the current run, specifying an alternate scope. See
  `idd-discover.instructions.md` for the full decision tree.
- Opt-in must be granted interactively during the current run. Prior or
  standing instructions do not count as opt-in.

## Commit signing

In non-interactive agent or CI environments where GPG pinentry cannot be
presented, add `--no-gpg-sign` to all `git commit` and `git merge`
commands to prevent blocking.

Record material progress, decisions, and hold reasons as issue or PR
comments at the time they are made. This ensures that any agent resuming
without session context can understand the current state and continue
correctly. Do not rely on session memory alone for information that
another agent may need.

Operational restore markers (for example `review-watermark` and
`review-baseline`) must include the current `{claim-id}` and must never
be restored across a claim change. A takeover starts a new restore
scope.

## Review item classes

During E-phase review triage, classify each List A item into one of two
paths before deciding what to do with it:

- **PATH A — actionable feedback**: human reviewer comments,
  `CHANGES_REQUESTED` review bodies, and critique-pass findings that
  require a code change or a maintainer decision. Score severity, choose
  Accept or Reject, and send only Accepted PATH A items to the
  review-fix phase.
- **PATH B — advisory feedback**: Copilot and CI advisory bot comments
  that E1 intentionally includes for traceability, even when they do not
  require a code change. Record an explicit `**Accepted**` or
  `**Rejected**` marker during triage, then verify that marker before
  merge.
- If a source is ambiguous, treat it as PATH A until a maintainer
  narrows it. PATH B is reserved for explicitly advisory bot feedback
  already included by E1.

PATH B items are fully handled inside review triage. They never enter
the review-fix phase.

## Project commands

When a phase refers to a named command set, run the corresponding
commands. **Adapt this section when applying this workflow to a
different project.**

| Name                  | Commands                       |
| --------------------- | ------------------------------ |
| **fix-validate**      | `{{FIX_VALIDATE_COMMANDS}}`    |
| **pre-push-validate** | `{{PRE_PUSH_VALIDATE_COMMANDS}}` |
| **post-fix-validate** | `{{POST_FIX_VALIDATE_COMMANDS}}` |
| **install-deps**      | `{{INSTALL_DEPS_COMMAND}}`     |

`pre-push-validate` intentionally omits auto-fix — all code should
already pass lint at the push step. If lint fails, run **fix-validate**
first, commit, then re-run **pre-push-validate**.

If **fix-validate** or **post-fix-validate** produces file changes
(auto-fixes), stage and commit those changes before any push, rebase, or
next step that requires no uncommitted changes.

## Phase routing table

Start by reading this file for shared definitions, then load the phase
file that matches your current situation.

| Situation                                   | Read this file                                                   |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Starting fresh (no active claim)            | `idd-discover.instructions.md`, then `idd-claim.instructions.md` |
| Resuming after crash / rate-limit / handoff | `idd-resume.instructions.md`                                     |
| Claimed, branch exists, no PR yet           | `idd-work.instructions.md`                                       |
| PR open, CI running, no reviews yet         | `idd-pr-submit.instructions.md`                                  |
| PR open, CI running, reviews exist          | `idd-review-triage.instructions.md` (E1 routes to fix if needed) |
| PR open, CI passed, no reviews yet          | `idd-review-triage.instructions.md` (E3 empty-list → merge)      |
| PR open, CI passed, reviews pending         | `idd-review-triage.instructions.md`                              |
| Review feedback accepted, pushing fixes     | `idd-review-fix.instructions.md`                                 |
| All checks passed, ready to merge           | `idd-merge.instructions.md`                                      |

CI polling logic shared by D and E phases lives in
`idd-ci.instructions.md`; callers declare their own on-success target.

## Critique pass

A **critique pass** is an independent review of a plan or diff that
produces a list of issues with severity, correctness, and coverage
assessment. The goal and expected output are the same regardless of
agent; only the mechanism differs.

| Agent       | How to run a critique pass                                                                |
| ----------- | ----------------------------------------------------------------------------------------- |
| Copilot     | Launch a subagent in Agent mode; use the calling phase's critique checklist as the prompt |
| Claude Code | `Agent(subagent_type="general-purpose")` with the calling phase's critique checklist      |
| Codex CLI   | Self-critique: add a "review the above for issues" step in the next response              |
| Gemini CLI  | Self-critique or use Gemini's native multi-step task mechanism if available               |

When a phase file says "run a critique pass", apply the row for your
agent above. If no subagent mechanism is available, perform the critique
as a structured self-review step within the same response.

## Template sync

If this repository distributes IDD as a template (i.e., it maintains an
`idd-template/` directory alongside the live `.github/instructions/`
files), any change to a live `idd-*.instructions.md` file or
`docs/idd-workflow.md` must be mirrored in the corresponding file under
`idd-template/`, replacing resolved project-specific values with their
`{{placeholder}}` forms:

| In `.github/instructions/` (live) | In `idd-template/` (template) |
| --------------------------------- | ----------------------------- |
| Resolved repo name | `{{REPO_NAME}}` |
| Resolved marker prefix | `{{PROJECT_MARKER_PREFIX}}` |
| **fix-validate** command string | `{{FIX_VALIDATE_COMMANDS}}` |
| **pre-push-validate** command string | `{{PRE_PUSH_VALIDATE_COMMANDS}}` |
| **post-fix-validate** command string | `{{POST_FIX_VALIDATE_COMMANDS}}` |
| **install-deps** command string | `{{INSTALL_DEPS_COMMAND}}` |

Match by the named command row in the Project commands table, not by
command prefix, to avoid confusing commands that share the same
executable.

Commits that modify only one copy are incomplete; include both changes in
the same atomic commit.
