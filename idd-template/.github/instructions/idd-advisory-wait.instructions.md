# IDD — Copilot Advisory-Wait Protocol

This file defines the shared advisory-wait protocol used by:

- **E14** (`idd-review-fix.instructions.md`)
- **F2** (`idd-pre-merge.instructions.md`)
- **F3** (`idd-merge.instructions.md`)

Policy constants (cap and windows) are named in
[`docs/policy-constants.md`](../../docs/policy-constants.md). This file
owns behavior.

## 1. Canonical path (helper-first)

When helper support is installed, use the profile-selected
advisory-wait helper command as the canonical evidence collector.

```sh
# source repo / vendored-node profile
node scripts/advisory-wait-state.mjs \
  --pr <pr-number> \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"

# package-manager / ephemeral-npx profile
<profile-selected-advisory-wait-command> \
  --pr <pr-number> \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>"
```

Resolve `<profile-selected-advisory-wait-command>` from the helper
runtime manifest wiring in `docs/idd-helper-scripts.md`. Do not hardcode
`node scripts/...` for profiles that do not vendor `scripts/`.

Contract: `docs/idd-helper-scripts.md#stable-helper-evidence-outputs`
and `schemas/advisory-wait-state.schema.json`.

Required helper fields:

- `prHeadSha`
- `lastCopilotCommit`
- `copilotPending`
- `copilotPendingCoversHead`
- `outcome`
- `f3Outcome`
- `earliestSameHeadAt`
- `requestMarkerCount`
- `requestCap`
- `pendingWindowMinutes`
- `settledWindowMinutes`
- `pollIntervalMinutes`
- `capExhaustedRoute`
- `trustedMarkerSummary`

Allowed `outcome` / `f3Outcome` values:

- `SATISFIED`
- `REQUEST_NEEDED`
- `RECOVERY_NEEDED`
- `CAP_EXHAUSTED`
- `WAIT`

`HOLD` remains a protocol-level routing state for AW4/AW5 fail-closed
stops. It is caller-derived and not emitted by helper enums.

Resolve the effective advisory policy from helper output when available;
otherwise read `.github/idd/config.json` `advisoryWait.*`, falling back
to the distributed defaults named in `docs/policy-constants.md`:

- `REQUEST_CAP`
- `PENDING_WINDOW_MINUTES`
- `SETTLED_WINDOW_MINUTES`
- `POLL_INTERVAL_MINUTES`
- `CAP_EXHAUSTED_ROUTE`

`CAP_EXHAUSTED_ROUTE` must remain fail-closed. Supported values are:

- `phase-specific` (default): E14 skips to E15; F2 and F3 hold.
- `hold`: E14, F2, and F3 all hold on `CAP_EXHAUSTED`.

### Caller mapping

| Outcome           | E14                             | F2                               | F3                                    |
| ----------------- | ------------------------------- | -------------------------------- | ------------------------------------- |
| `SATISFIED`       | proceed to E15                  | continue to CI check             | proceed with merge                    |
| `REQUEST_NEEDED`  | request Copilot + marker + poll | return to E14                    | return to E14                         |
| `RECOVERY_NEEDED` | post recovery marker + poll     | post recovery marker + poll      | post recovery marker and return to F2 |
| `CAP_EXHAUSTED`   | use `CAP_EXHAUSTED_ROUTE`       | post cap-exhausted hold and stop | post cap-exhausted hold and stop      |
| `WAIT`            | continue polling                | poll then restart F2 from top    | do not merge; return to F2            |
| `HOLD`            | post hold and stop              | post hold and stop               | post hold and stop                    |

### F3-specific interpretation

- F3 must use `f3Outcome` when helper output is available.
- If `copilotPending` is `false`, F3 treats advisory wait as satisfied.
- If `copilotPending` is `true`, F3 must not merge on `WAIT`,
  `REQUEST_NEEDED`, or `RECOVERY_NEEDED`.

## 2. Fail-closed fallback trigger

Do **not** proceed on helper output unless all required fields and enums
are valid and the output is consistent with protocol expectations.

Immediately switch to shell fallback (AW1-AW5) when any of these occurs:

- helper is unavailable
- helper exits non-zero
- helper output is invalid JSON
- required fields are missing
- enum value is outside the allowed set
- helper evidence disagrees with live state in a way that affects
  routing

If fallback cannot establish safe evidence, route to hold (`AW4` or
`AW5`) and stop.

## 3. Shell fallback (AW1-AW5)

Use this path whenever helper-first cannot be trusted.

### AW1 — Copilot review state

```sh
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')

LAST_COPILOT_COMMIT=$(
  gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/reviews" \
    --paginate \
    --jq '.[] | select(.user.login | startswith("copilot-pull-request-reviewer")) |
               {sa: .submitted_at, cid: .commit_id}' \
  | jq -rs 'sort_by(.sa) | last | .cid // ""'
)

COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
  --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')

COPILOT_PENDING_COVERS_HEAD=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/timeline" \
    -H "Accept: application/vnd.github+json" \
    --paginate \
    | jq -r -s --arg sha "${PR_HEAD_SHA}" '
        (add // [])
        | to_entries
        | (map(select(.value.event == "committed"
             and ((.value.sha // .value.commit_id // "") == $sha)))
           | last | .key // null) as $head_index
        | (map(select(.value.event == "review_requested"
             and (((.value.requested_reviewer.login // "") == "Copilot")
                  or ((.value.requested_reviewer.login // "")
                      | startswith("copilot-pull-request-reviewer")))))
           | last | .key // null) as $request_index
        | ($head_index != null and $request_index != null and
           $request_index > $head_index)
      '
)
```

If `LAST_COPILOT_COMMIT == PR_HEAD_SHA`, advisory state is
**SATISFIED**.

Never use commit author/committer timestamps as advisory proof.

### AW2 — Advisory marker evidence

```sh
ADVISORY_COMMENTS_JSON=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -s 'add // []'
)
CURRENT_MARKER_ACTOR=$(gh api user --jq '.login' 2>/dev/null || true)
TRUSTED_MARKER_ACTORS="${IDD_TRUSTED_MARKER_ACTORS:-}"
TRUST_COLLABORATOR_MARKERS="${IDD_TRUST_COLLABORATOR_MARKERS:-}"
TRUSTED_MARKER_LOGIN_JSON=$(
  {
    if [ -n "$CURRENT_MARKER_ACTOR" ]; then
      printf '%s\n' "$CURRENT_MARKER_ACTOR"
    fi
    printf '%s\n' "$TRUSTED_MARKER_ACTORS" | tr ',' '\n'
    if printf '%s\n' "$TRUST_COLLABORATOR_MARKERS" | grep -Eiq '^(1|true|yes)$'; then
      printf '%s\n' "$ADVISORY_COMMENTS_JSON" \
        | jq -r '.[] | select((.body // "") | test("^advisory-wait:|^advisory-wait-recovery:|^<!-- advisory-wait:")) | .user.login // empty' \
        | sort -fu \
        | while IFS= read -r login; do
          permission=$(
            gh api "repos/${OWNER}/${REPO}/collaborators/${login}/permission" \
              --jq '.permission' 2>/dev/null || true
          )
          case "$permission" in
            admin | maintain | write) printf '%s\n' "$login" ;;
          esac
        done
    fi
  } | jq -R -s 'split("\n") | map(ascii_downcase | select(length > 0)) | unique'
)

EARLIEST_SAME_HEAD_AT=$(
  printf '%s\n' "$ADVISORY_COMMENTS_JSON" \
    | jq -r \
      --arg sha "$PR_HEAD_SHA" \
      --argjson trusted_marker_logins "$TRUSTED_MARKER_LOGIN_JSON" '
        def marker_login: (.user.login // "" | ascii_downcase);
        def trusted_marker_actor:
          marker_login as $login
          | ($login | length > 0)
          and (($trusted_marker_logins | index($login)) != null);
        [.[] | select(
          trusted_marker_actor
          and (
            ((.body // "") | test("^advisory-wait: [^ ]+ " + $sha + "(?: |$)")) or
            ((.body // "") | test("^advisory-wait-recovery: [^ ]+ " + $sha + "(?: |$)")) or
            ((.body // "") | test("^<!-- advisory-wait: [^ ]+ " + $sha + " [^ ]+ -->$"))
          )
        )]
        | min_by(.created_at) | .created_at // ""
      '
)

REQUEST_MARKER_COUNT=$(
  printf '%s\n' "$ADVISORY_COMMENTS_JSON" \
    | jq -r \
      --argjson trusted_marker_logins "$TRUSTED_MARKER_LOGIN_JSON" '
        def marker_login: (.user.login // "" | ascii_downcase);
        def trusted_marker_actor:
          marker_login as $login
          | ($login | length > 0)
          and (($trusted_marker_logins | index($login)) != null);
        [.[] | select(
          trusted_marker_actor
          and ((.body // "") | test("^advisory-wait:|^<!-- advisory-wait:"))
        )]
        | length
      '
)
```

Rules:

- only trusted marker actors can start or extend advisory clocks
- same-head clock anchor is marker `created_at` (not embedded text)
- request-cap counting excludes recovery markers
- refresh AW2 evidence at each polling cycle

### AW3 — Decision table

Evaluate top-to-bottom; first match wins.

| `LAST_COPILOT_COMMIT` | `COPILOT_PENDING` | Marker state        | Head proof / cap                                    | Elapsed                         | Outcome           |
| --------------------- | ----------------- | ------------------- | --------------------------------------------------- | ------------------------------- | ----------------- |
| `== PR_HEAD_SHA`      | any               | any                 | any                                                 | any                             | `SATISFIED`       |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | `COPILOT_PENDING_COVERS_HEAD=true`                  | —                               | `RECOVERY_NEEDED` |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | not proven; `REQUEST_MARKER_COUNT` < `REQUEST_CAP`  | —                               | `REQUEST_NEEDED`  |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | not proven; `REQUEST_MARKER_COUNT` >= `REQUEST_CAP` | —                               | `CAP_EXHAUSTED`   |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | any                                                 | >= `PENDING_WINDOW_MINUTES` min | `SATISFIED`       |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | any                                                 | < `PENDING_WINDOW_MINUTES` min  | `WAIT`            |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | any                                                 | >= `SETTLED_WINDOW_MINUTES` min | `SATISFIED`       |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | any                                                 | < `SETTLED_WINDOW_MINUTES` min  | `WAIT`            |
| `!= PR_HEAD_SHA`      | `"false"`         | no same-head marker | `REQUEST_MARKER_COUNT` >= `REQUEST_CAP`             | —                               | `CAP_EXHAUSTED`   |
| `!= PR_HEAD_SHA`      | `"false"`         | no same-head marker | `REQUEST_MARKER_COUNT` < `REQUEST_CAP`              | —                               | `REQUEST_NEEDED`  |

### AW3-R — Recovery marker

Use only when AW3 outcome is `RECOVERY_NEEDED`:

```text
advisory-wait-recovery: {agent-id} {PR_HEAD_SHA} {ISO8601-recovery-time}
```

Rules:

- do not request another Copilot review in this path
- advisory clock starts from marker comment `created_at`
- if marker cannot be posted/read, route to `AW4` recovery-failed hold

### AW4 — Hold templates

#### Pending refresh failed

> Copilot review is pending for this PR, but the PR timeline does not
> prove that the request was created after HEAD `{PR_HEAD_SHA}` entered
> the PR, and E14 could not refresh the pending request. A maintainer
> must verify or request the Copilot review before this step can safely
> continue. Do not merge until the maintainer has resolved this.

#### Recovery failed

> Copilot review is pending for HEAD `{PR_HEAD_SHA}` but no
> advisory-wait marker can be posted or read. A maintainer must verify
> the Copilot advisory-wait state before this step can safely continue.
> Do not merge until the maintainer has resolved this.

#### Cap exhausted

> The configured per-PR Copilot re-review cap is exhausted. A maintainer must
> manually request and evaluate a Copilot review before merge.

### AW5 — Missing-marker recovery during polling

If `EARLIEST_SAME_HEAD_AT` becomes empty during active polling, post
this hold and stop:

> Advisory-wait marker for HEAD `{PR_HEAD_SHA}` is missing during
> polling. Unable to compute elapsed time. A maintainer must verify the
> Copilot advisory-wait state before this phase can safely continue.
