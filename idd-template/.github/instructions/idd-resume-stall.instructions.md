# IDD — Resume Stalled-Session Recovery

Use this file when Resume sees signs of a progress-stalled or
rate-limited session and needs a dedicated, safety-first decision path.
This path relies only on externally observable state. It never depends
on the prior session posting a graceful shutdown.

This file applies only to unattended stale-takeover evidence for a
non-owned claim. Human-gated forced handoff is a separate recovery path
and is routed from `idd-resume.instructions.md` before this file runs.

Read `idd-overview.instructions.md` and
`idd-resume.instructions.md` first.

## Inputs to collect

Before deciding, gather:

1. Active claim details from trusted marker actors only:
   `{claim-id}`, `{agent-id}`, latest valid `claimed-by` `created_at`,
   and branch.
2. Current issue and PR activity timestamps (comments, review-thread
   updates, review submissions).
3. PR head SHA and latest completed CI timestamp for that head (or
   `none`), plus current CI run/check states (`queued` /
   `in_progress` / terminal) and their start/update timestamps.
4. PR head update timestamp (when the current head entered the PR), or
   remote branch tip SHA and update time when no PR exists.
5. Latest trusted review watermark and baseline marker timestamps for
   the same active claim (if present).

Use GitHub server timestamps only.

## Decision rules

### S1 — Confirm this is a non-owned active claim case

- If no active claim exists, or the active claim already uses your
  current `{claim-id}`, this is not a stalled-session takeover case.
  Return to `idd-resume.instructions.md`.
- If trusted forced-handoff evidence exists and matches the active claim
  or inheritable released branch / PR state, this is not a
  stalled-session takeover case. Return to
  `idd-resume.instructions.md` Step 1 and use the forced-handoff route
  instead. Do not apply the quiet-window or stale-threshold gates here.
- If the active claim belongs to another `{claim-id}`, continue.

### S2 — Quiet-window check (stall evidence, not ownership transfer)

Use a **30-minute quiet window** as the default evidence threshold.
During that window, no externally observable progress should appear:
no trusted heartbeat on the active claim, no PR head movement, no
remote branch tip movement, no running CI activity (`queued` or
`in_progress` checks/runs), and no new review/comment/CI completion
activity.

When helper runtime is enabled, use
`idd-stalled-session-quiet-check` as the canonical read-only evidence
collector for this step. Pass the active PR number and, when known, the
latest valid trusted `claimed-by` `created_at` from the active non-owned
claim:

```bash
idd-stalled-session-quiet-check \
  --pr <pr-number> \
  --claim-created-at <latest-valid-claimed-by-created_at>
```

Use `node scripts/stalled-session-quiet-check.mjs ...` as the vendored
equivalent when the packaged binary is unavailable. Consume the helper's
stable fields `quiet_window_met`, `quiet_window_ms`, `window_start`,
`now`, `latest_activity`, `latest_activity_type`, `reason`, and
`evidence` (`activity_count_in_window`, `blocking_activities`,
`has_heartbeat_in_window`, `has_ci_running`,
`has_pr_head_movement`, `has_branch_tip_movement`).

The helper gathers evidence only. It never decides trusted-marker
validity, stale-age, advisory state, forced-handoff routing, or takeover
eligibility by itself. If helper runtime is unavailable, the command
fails, or the output is missing or contradictory, fall back to the
written quiet-window procedure in this file and the collected live
signals above. That written procedure remains authoritative.

- Quiet window not met or evidence is contradictory/incomplete:
  **hold and stop**. Do not claim, push, or mutate review state.
- Quiet window met: continue to S3.

Quiet-window evidence does not permit takeover by itself and never
waives the stale-threshold gate in S3.

### S3 — Stale-threshold gate (ownership transfer gate)

Apply the shared stale rule from `idd-overview.instructions.md` and
`claim-stale-age` in `docs/policy-constants.md`:
takeover is allowed only when the active non-owned claim is stale
(`latest valid claimed-by created_at >= 24h`).

- Claim age `< 24h`: **hold and stop**. Keep waiting for the shared
  stale threshold.
- Claim age `>= 24h`: takeover is eligible; continue to S4.

### S4 — Race-safe takeover recheck

Immediately before posting takeover:

1. Re-read the issue and parse active claim again.
2. Confirm the active claim still uses the same non-owned `{claim-id}`
   observed in S1-S3.
3. Confirm it is still stale at this moment.
4. Re-run `idd-stalled-session-quiet-check` (or repeat the written
   manual procedure when helper runtime is unavailable) against the
   latest externally visible activity. If new progress appeared after
   S2, stop and restart.
5. Re-check closed/merged guards. If the issue is now closed or the PR
   is now merged, stop and return to `idd-resume.instructions.md` Step 1
   cleanup behavior.
6. If takeover is still eligible, use A5 race-safe claim verification
   (`idd-claim.instructions.md`) for the upcoming takeover post-and-
   verify sequence: wait for the configured settle delay from
   `.github/idd/config.json` `claim.verifySettleDelay`
   (distributed default: `PT5S`) after posting, re-parse
   chronologically, apply same-second lexicographic `{claim-id}`
   tie-break, and reject later trusted competing `claimed-by` markers
   with different `{claim-id}` values.

If any check fails, stop and restart from Resume discovery/routing.
Do not post takeover with stale evidence.

### S5 — Execute takeover and verify

Perform takeover via `idd-claim.instructions.md` using:

- a fresh `{claim-id}`
- `supersedes: <previous-active-claim-id>`

Then re-read and verify the active claim now uses your fresh
`{claim-id}` using the same A5 race-safe verification checks. If not,
stop and return to discovery/routing.

After successful verification, run `idd-resume.instructions.md` Step 1
to preserve closed/merged cleanup and `roadmap-audit/*` special-case
routing before continuing to Step 2/Step 3.

## Hold behavior (when S2/S3 is not satisfied)

In this non-owned-claim path, do not post hold notes on the issue/PR.
Record evidence in session logs only and stop. Posting hold notes here
would violate the shared claim revalidation gate and can reset
quiet-window evidence.

Keep claim safety strict: no early takeover before the shared stale
threshold.
