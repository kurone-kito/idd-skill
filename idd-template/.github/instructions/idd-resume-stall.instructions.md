# IDD — Resume Stalled-Session Recovery

Use this file when Resume sees signs of a progress-stalled or
rate-limited session and needs a dedicated, safety-first decision path.
This path relies only on externally observable state. It never depends
on the prior session posting a graceful shutdown.

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
- If the active claim belongs to another `{claim-id}`, continue.

### S2 — Quiet-window check (stall evidence, not ownership transfer)

Use a **30-minute quiet window** as the default evidence threshold.
During that window, no externally observable progress should appear:
no trusted heartbeat on the active claim, no PR head movement, no
remote branch tip movement, no running CI activity (`queued` or
`in_progress` checks/runs), and no new review/comment/CI completion
activity.

- Quiet window not met or evidence is contradictory/incomplete:
  **hold and stop**. Do not claim, push, or mutate review state.
- Quiet window met: continue to S3.

Quiet-window evidence does not permit takeover by itself.

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
4. Re-check quiet-window evidence against the latest externally visible
   activity. If new progress appeared after S2, stop and restart.
5. Re-check closed/merged guards. If the issue is now closed or the PR
   is now merged, stop and return to `idd-resume.instructions.md` Step 1
   cleanup behavior.
6. If takeover is still eligible, use A5 race-safe claim verification
   (`idd-claim.instructions.md`) for the upcoming takeover post-and-
   verify sequence: wait 5–10 seconds after posting, re-parse
   chronologically, apply same-second lexicographic `{claim-id}`
   tie-break, and reject later trusted valid competing claims.

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
