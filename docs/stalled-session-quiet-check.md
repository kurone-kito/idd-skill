# Stalled Session Quiet-Check Helper

Detects quiet windows for the Resume/S2 stalled-session recovery path.

## Purpose

When helper runtime is enabled, `idd-stalled-session-quiet-check` is the
canonical read-only evidence collector for Resume/S2 quiet-window checks.
It helps gather externally observable activity for an open PR without
changing claim state, review state, or CI state.

The helper does not replace the written policy. Resume/S2-S4 still owns
trusted-marker validation, stale-threshold gating, forced-handoff
routing, advisory constraints, and A5 race-safe takeover checks.

## Specification Reference

- `/.github/instructions/idd-resume-stall.instructions.md`
- [`docs/idd-helper-scripts.md`](idd-helper-scripts.md)
- [`schemas/stalled-session-quiet-check.schema.json`](../schemas/stalled-session-quiet-check.schema.json)

## Usage

### CLI

Preferred helper-runtime command:

```bash
idd-stalled-session-quiet-check \
  --pr <number> \
  [--owner <owner>] \
  [--repo <repo>] \
  [--token <token>] \
  [--now <ISO8601>] \
  [--quiet-window-ms <ms>] \
  [--claim-created-at <ISO8601>] \
  [--policy <path>]
```

Vendored equivalent:

```bash
node scripts/stalled-session-quiet-check.mjs \
  --pr <number> \
  [--owner <owner>] \
  [--repo <repo>] \
  [--token <token>] \
  [--now <ISO8601>] \
  [--quiet-window-ms <ms>] \
  [--claim-created-at <ISO8601>] \
  [--policy <path>]
```

#### Required parameter

- `--pr <number>`: Pull request number used to gather activity evidence

#### Optional parameters

- `--owner <owner>`: Repository owner; defaults to the current repository
- `--repo <repo>`: Repository name; defaults to the current repository
- `--token <token>`: GitHub token override for `gh` API calls
- `--now <ISO8601>`: Reference timestamp; defaults to current UTC time
- `--quiet-window-ms <ms>`: Quiet-window duration in milliseconds;
  defaults to the policy value or `1800000`
- `--claim-created-at <ISO8601>`: Latest valid trusted `claimed-by`
  `created_at` for the active non-owned claim; enables heartbeat
  evidence in Resume/S2
- `--policy <path>`: Alternate policy file used to resolve the default
  quiet window
- `--help`: Show help text

`--claim-created-at` should come from the trusted active-claim parse that
Resume already performs. If helper runtime is unavailable or the helper
output is unusable, the written manual procedure in
`idd-resume-stall.instructions.md` remains authoritative.

## Stable output fields consumed by Resume/S2

Resume/S2 treats these fields as the stable contract:

- `quiet_window_met`
- `quiet_window_ms`
- `window_start`
- `now`
- `latest_activity`
- `latest_activity_type`
- `reason`
- `evidence.activity_count_in_window`
- `evidence.blocking_activities`
- `evidence.has_heartbeat_in_window`
- `evidence.has_ci_running`
- `evidence.has_branch_tip_movement`

The CLI also includes `repository`, `pr`, and `policy` envelopes for
operator context. Those fields are useful for logging and diagnostics but
are not the gating fields Resume/S2 relies on.

## Output schema

The CLI returns JSON shaped like:

```json
{
  "repository": {
    "owner": "kurone-kito",
    "repo": "idd-skill"
  },
  "pr": {
    "number": 526,
    "title": "refactor(instructions): make resume-stall helper-first",
    "head_sha": "9bf7bd353fe09a0514fcf3e36b3a323cb6c936fe",
    "html_url": "https://github.com/kurone-kito/idd-skill/pull/526"
  },
  "policy": {
    "quiet_window_ms": 1800000,
    "claim_created_at": "2026-05-13T17:40:00Z"
  },
  "quiet_window_met": false,
  "quiet_window_ms": 1800000,
  "window_start": "2026-05-13T17:30:00Z",
  "now": "2026-05-13T18:00:00Z",
  "latest_activity": "2026-05-13T17:58:02Z",
  "latest_activity_type": "ci-completed",
  "reason": "activity-in-window: comment, ci-completed",
  "evidence": {
    "activity_count_in_window": 2,
    "blocking_activities": [
      {
        "type": "comment",
        "timestamp": "2026-05-13T17:52:41Z"
      },
      {
        "type": "ci-completed",
        "timestamp": "2026-05-13T17:58:02Z"
      }
    ],
    "has_heartbeat_in_window": false,
    "has_ci_running": false,
    "has_branch_tip_movement": false
  }
}
```

`latest_activity_type` is descriptive evidence, not a standalone policy
decision. Resume/S2 still interprets the full response together with the
written instructions.

## Live rechecks required before takeover

Quiet-window evidence is only one gate in stalled-session recovery.
Before takeover, Resume/S4 must still:

1. Re-parse the active claim from trusted markers and confirm it is the
   same non-owned `{claim-id}` observed earlier.
2. Re-run this helper against live GitHub state, or repeat the written
   manual procedure when helper runtime is unavailable.
3. Re-check the stale-threshold gate. `quiet_window_met = true` never
   waives stale-age by itself.
4. Re-check closed/merged guards and stop if the issue or PR closed in
   the meantime.
5. Use A5 race-safe claim verification after posting takeover.

If helper output is missing, contradictory, or no longer quiet, stop and
restart Resume routing instead of taking over.

## Return code

Successful evaluations always exit with code `0`, including cases where
`quiet_window_met` is `false`. Use the JSON output to decide whether the
quiet window is satisfied.

## Error handling

The helper throws an error if:

- `--pr` is missing or invalid
- GitHub API calls fail
- The helper cannot parse a provided argument value

## Timestamp handling

- Activity timestamps come from GitHub API responses (server time)
- The `now` reference defaults to the executor's local clock
  (`new Date()`), **not** a server timestamp; pass `--now <ISO8601>` to
  pin it to a server-derived time when exact server-relative evaluation
  matters
- Branch-tip movement uses the head commit's **committer** date (server-set
  on push), not the client-settable author date
- Normalizes timestamps to ISO8601 UTC with a `Z` suffix
- Treats `ci-running` as blocking even if its timestamp would otherwise
  fall outside the window

## Dependencies

- `gh` CLI tool for GitHub API access
- Node.js 22.22.2 or later
- No external npm packages required (uses only Node.js built-ins)
