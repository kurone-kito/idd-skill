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
   `none`).
4. Latest trusted review watermark and baseline marker timestamps for
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
no trusted heartbeat on the active claim, no PR head movement, and no
new review/comment/CI completion activity.

- Quiet window not met or evidence is contradictory/incomplete:
  **hold and stop**. Do not claim, push, or mutate review state.
- Quiet window met: continue to S3.

Quiet-window evidence does not permit takeover by itself.

### S3 — Stale-threshold gate (ownership transfer gate)

Apply the shared stale rule from `idd-overview.instructions.md`:
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

If any check fails, stop and restart from Resume discovery/routing.
Do not post takeover with stale evidence.

### S5 — Execute takeover and verify

Perform takeover via `idd-claim.instructions.md` using:

- a fresh `{claim-id}`
- `supersedes: <previous-active-claim-id>`

Then re-read and verify the active claim now uses your fresh
`{claim-id}`. If not, stop and return to discovery/routing.

After successful verification, resume normal
`idd-resume.instructions.md` Step 2/Step 3 routing.

## Hold behavior (when S2/S3 is not satisfied)

Post a concise hold note on the issue or PR with:

- what evidence was observed,
- why takeover is not yet safe, and
- the exact resume condition (quiet window completion and/or stale
  threshold reached).

Keep claim safety strict: no early takeover before the shared stale
threshold.
