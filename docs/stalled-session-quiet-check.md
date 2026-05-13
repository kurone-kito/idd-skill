# Stalled Session Quiet-Check Helper

Detects quiet windows (no activity for a configurable period, default 30
minutes) for the Resume/S2 stalled-session recovery specification.

## Purpose

This helper supports the Resume phase S2 (Quiet-Window Check) by detecting
whether a stalled session has truly been inactive. The quiet window must be
met before the S3 stale-threshold gate permits takeover of a non-owned claim.

## Specification Reference

See `idd-resume-stall.instructions.md` for the full stalled-session recovery
context and the decision rules that consume this helper's output.

## Usage

### CLI

```bash
node scripts/stalled-session-quiet-check.mjs \
  --issue <number> \
  --pr <number> \
  --branch <name> \
  [--owner <owner>] \
  [--repo <repo>] \
  [--window-minutes <minutes>] \
  [--now <ISO8601>] \
  [--previous-branch-tip-sha <sha>]
```

#### Required Parameters

- `--issue <number>`: Issue number (for fetching claim comments)
- `--pr <number>`: PR number (for fetching timeline and review state)
- `--branch <name>`: Remote branch name (for fetching branch tip SHA)

#### Optional Parameters

- `--owner <owner>`: Repository owner; defaults to current repository
- `--repo <repo>`: Repository name; defaults to current repository
- `--window-minutes <minutes>`: Quiet window duration in minutes;
  default: 30
- `--now <ISO8601>`: Reference timestamp; defaults to current UTC time
  (in format `YYYY-MM-DDTHH:MM:SSZ`)
- `--previous-branch-tip-sha <sha>`: Previous branch tip SHA for movement
  detection
- `--help`: Show help text

### Node.js (Programmatic)

```javascript
import { execFileSync } from "node:child_process";

const result = JSON.parse(
  execFileSync("node", [
    "scripts/stalled-session-quiet-check.mjs",
    "--issue", "123",
    "--pr", "456",
    "--branch", "issue/123-feature",
    "--owner", "my-org",
    "--repo", "my-repo",
    "--window-minutes", "30",
  ], { encoding: "utf8" })
);

if (result.isQuiet) {
  console.log("Quiet window confirmed; proceed with S3 check");
} else {
  console.log("Activity detected within window; abort takeover");
  console.log("Details:", result.evidence.details);
}
```

## Return Value Schema

```json
{
  "isQuiet": boolean,
  "evidence": {
    "windowMinutes": number,
    "windowStartUtc": "ISO8601 timestamp",
    "windowEndUtc": "ISO8601 timestamp",
    "latestActivityUtc": "ISO8601 timestamp or null",
    "reason": "string explanation",
    "details": ["array of activity findings"],
    "checkSummary": {
      "heartbeatCheck": "PASSED" | "FAILED",
      "prHeadMovementCheck": "PASSED" | "FAILED",
      "branchTipMovementCheck": "PASSED" | "FAILED",
      "runningCiCheck": "PASSED" | "FAILED",
      "reviewActivityCheck": "PASSED" | "FAILED",
      "commentActivityCheck": "PASSED" | "FAILED",
      "ciCompletionCheck": "PASSED" | "FAILED"
    }
  }
}
```

### `isQuiet`

Boolean flag indicating whether the quiet window is satisfied (all checks
passed).

### `evidence`

Detailed evidence collected during the check:

- **`windowMinutes`**: The quiet window duration used for the check
- **`windowStartUtc`**: The earliest timestamp within the quiet window
  (reference time minus window duration)
- **`windowEndUtc`**: The reference timestamp (end of the window)
- **`latestActivityUtc`**: The most recent activity timestamp across all
  sources, or `null` if no activity was found
- **`reason`**: Human-readable summary of the outcome
- **`details`**: Array of specific findings (heartbeat, PR movement, etc.)
- **`checkSummary`**: Per-check status showing which specific activity
  types were detected

## Quiet Window Checks

The helper validates all five sources required by Resume/S2:

1. **Heartbeat Check**: Looks for trusted `<!-- claimed-by: ... -->`
   markers within the window
   - Detects ongoing claim activity that would indicate an active session

2. **PR Head Movement Check**: Detects new commits in the PR timeline
   within the window
   - Indicates work is being pushed to the branch

3. **Branch Tip Movement Check**: Compares current branch tip SHA against
   previous snapshot
   - Requires `--previous-branch-tip-sha` parameter
   - Detects force-push or new commits on the remote branch

4. **Running CI Check**: Detects `queued` or `in_progress` CI checks
   - Indicates active workflow execution

5. **Review Activity Check**: Detects new review submissions within the
   window
   - Includes formal code reviews and automated advisory reviews

6. **Comment Activity Check**: Detects new comments (excluding claim
   markers)
   - Includes issue and PR comments from humans and bots

7. **CI Completion Check**: Detects recently completed CI runs
   - Indicates workflow activity that occurred within the window

## Integration with Resume/S2

In `idd-resume-stall.instructions.md`, use this helper to decide whether to
proceed with takeover:

```bash
RESULT=$(node scripts/stalled-session-quiet-check.mjs \
  --issue "$ISSUE_NUMBER" \
  --pr "$PR_NUMBER" \
  --branch "$BRANCH_NAME" \
  --window-minutes 30)

IS_QUIET=$(echo "$RESULT" | jq '.isQuiet')

if [ "$IS_QUIET" = "true" ]; then
  echo "Quiet window confirmed; continue to S3 check"
else
  echo "Activity detected; hold and stop"
  echo "$RESULT" | jq '.evidence.details[]'
fi
```

## Return Code

Always exits with code 0 on success (regardless of `isQuiet` value). Use the
JSON output to determine the result.

## Error Handling

The helper throws an error if:

- Required parameters are missing (--issue, --pr, or --branch)
- GitHub API calls fail
- Invalid parameter values are provided

## Timestamp Handling

- Uses GitHub server-provided timestamps (from API responses)
- Never uses local wall-clock time
- Assumes all timestamps are in UTC
- ISO8601 format with `Z` suffix (e.g., `2024-05-13T12:00:00Z`)

## Example Output

```json
{
  "isQuiet": false,
  "evidence": {
    "windowMinutes": 30,
    "windowStartUtc": "2024-05-13T11:30:00Z",
    "windowEndUtc": "2024-05-13T12:00:00Z",
    "latestActivityUtc": "2024-05-13T11:45:00Z",
    "reason": "Activity detected within 30-minute window",
    "details": [
      "Comment activity detected: 1 comment(s) within window"
    ],
    "checkSummary": {
      "heartbeatCheck": "PASSED",
      "prHeadMovementCheck": "PASSED",
      "branchTipMovementCheck": "PASSED",
      "runningCiCheck": "PASSED",
      "reviewActivityCheck": "PASSED",
      "commentActivityCheck": "FAILED",
      "ciCompletionCheck": "PASSED"
    }
  }
}
```

## Dependencies

- `gh` CLI tool for GitHub API access
- Node.js 22.22.2 or later
- No external npm packages required (uses only Node.js built-ins)
