# IDD — Copilot Advisory-Wait Protocol

This file defines the shared commands and decision rules for the Copilot
advisory-wait check. It is referenced by:

- **E14** (`idd-review-fix.instructions.md`): request a Copilot
  re-review and wait for the advisory window
- **F2** (`idd-pre-merge.instructions.md`): gate check before allowing
  merge
- **F3** (`idd-merge.instructions.md`): final revalidation immediately
  before executing the merge command

Callers are responsible for fetching `PR_HEAD_SHA` before invoking these
steps and for defining their own routing on each outcome.

## AW1 — Fetch Copilot review state

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
# If LAST_COPILOT_COMMIT == PR_HEAD_SHA → Copilot has reviewed the current HEAD.

COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
  --jq '.users | any(.login == "Copilot" or (.login | startswith("copilot-pull-request-reviewer")))')
# "true" → review still pending; "false" → submitted or cancelled.
# GitHub uses "Copilot" (capital C) in requested_reviewers and
# "copilot-pull-request-reviewer[bot]" in the reviews API — both matched here.

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
# "true" → the PR timeline proves the latest Copilot review request was
# created after the current PR_HEAD_SHA entered the PR timeline.
# "false" → pending reviewer exists, but current-head coverage is unproven;
# AW3 routes to REQUEST_NEEDED, or CAP_EXHAUSTED when the request cap is hit.
```

If `LAST_COPILOT_COMMIT == PR_HEAD_SHA` → outcome is **SATISFIED**.
Caller proceeds to its designated next step without running AW2–AW3.

Do not use commit author or committer timestamps as recovery proof; they
do not prove when a commit entered the PR branch.

## AW2 — Fetch advisory-wait markers

```sh
ADVISORY_COMMENTS_JSON=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -s 'add // []'
)
CURRENT_MARKER_ACTOR=$(gh api user --jq '.login')
TRUSTED_MARKER_ACTORS="${IDD_TRUSTED_MARKER_ACTORS:-}"
TRUST_COLLABORATOR_MARKERS="${IDD_TRUST_COLLABORATOR_MARKERS:-}"

EARLIEST_SAME_HEAD_AT=$(
  printf '%s\n' "$ADVISORY_COMMENTS_JSON" \
    | jq -r \
      --arg sha "$PR_HEAD_SHA" \
      --arg current_actor "$CURRENT_MARKER_ACTOR" \
      --arg trusted_actors "$TRUSTED_MARKER_ACTORS" \
      --arg trust_collaborators "$TRUST_COLLABORATOR_MARKERS" '
        def marker_login: (.user.login // "" | ascii_downcase);
        def configured_logins:
          $trusted_actors
          | ascii_downcase
          | split(",")
          | map(select(length > 0));
        def collaborator_markers_enabled:
          $trust_collaborators | test("^(1|true|yes)$"; "i");
        def collaborator_author:
          (.author_association // "") as $association
          | (["OWNER", "MEMBER", "COLLABORATOR"] | index($association)) != null;
        def trusted_marker_actor:
          (marker_login | length > 0)
          and (
            (marker_login == ($current_actor | ascii_downcase))
            or ((configured_logins | index(marker_login)) != null)
            or (collaborator_markers_enabled and collaborator_author)
          );
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
# Matches request, recovery, and HTML-comment (legacy) marker formats.
# Empty → no same-head marker exists.
# Non-empty → earliest same-head marker createdAt (advisory-clock start).

REQUEST_MARKER_COUNT=$(
  printf '%s\n' "$ADVISORY_COMMENTS_JSON" \
    | jq -r \
      --arg current_actor "$CURRENT_MARKER_ACTOR" \
      --arg trusted_actors "$TRUSTED_MARKER_ACTORS" \
      --arg trust_collaborators "$TRUST_COLLABORATOR_MARKERS" '
        def marker_login: (.user.login // "" | ascii_downcase);
        def configured_logins:
          $trusted_actors
          | ascii_downcase
          | split(",")
          | map(select(length > 0));
        def collaborator_markers_enabled:
          $trust_collaborators | test("^(1|true|yes)$"; "i");
        def collaborator_author:
          (.author_association // "") as $association
          | (["OWNER", "MEMBER", "COLLABORATOR"] | index($association)) != null;
        def trusted_marker_actor:
          (marker_login | length > 0)
          and (
            (marker_login == ($current_actor | ascii_downcase))
            or ((configured_logins | index(marker_login)) != null)
            or (collaborator_markers_enabled and collaborator_author)
          );
        [.[] | select(
          trusted_marker_actor
          and ((.body // "") | test("^advisory-wait:|^<!-- advisory-wait:"))
        )]
        | length
      '
)
# Total Copilot re-review request markers for this PR (all HEADs). Used for
# the 30-per-PR request cap. Recovery markers are excluded from this count.
```

AW2 applies the trusted marker actor rules from
`idd-overview.instructions.md`. Untrusted advisory-wait-shaped comments
do not start or extend the advisory clock and do not count toward the
30-per-PR request cap; report them as suspicious context when they
affect the decision.

Refresh `EARLIEST_SAME_HEAD_AT` at the start of each polling iteration —
its value can change if a parallel session posted a new marker.

Elapsed time = current UTC time − `EARLIEST_SAME_HEAD_AT` as returned by
the GitHub API. Never use the timestamp inside the marker body.

## AW3 — Decision table

Evaluate in this order (the first matching row wins):

| `LAST_COPILOT_COMMIT` | `COPILOT_PENDING` | Marker state        | Head proof / cap                   | Elapsed  | Outcome                                                     |
| --------------------- | ----------------- | ------------------- | ---------------------------------- | -------- | ----------------------------------------------------------- |
| `== PR_HEAD_SHA`      | (any)             | (any)               | (any)                              | (any)    | **SATISFIED**                                               |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | `COPILOT_PENDING_COVERS_HEAD=true` | —        | **RECOVERY_NEEDED**                                         |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | not proven; request cap < 30       | —        | **REQUEST_NEEDED** (refresh stale/unproven pending request) |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | not proven; request cap ≥ 30       | —        | **CAP\_EXHAUSTED**                                          |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | (any)                              | ≥ 30 min | **SATISFIED** (window expired)                              |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | (any)                              | < 30 min | **WAIT**                                                    |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | (any)                              | ≥ 10 min | **SATISFIED**                                               |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | (any)                              | < 10 min | **WAIT**                                                    |
| `!= PR_HEAD_SHA`      | `"false"`         | no same-head marker | request cap ≥ 30                   | —        | **CAP\_EXHAUSTED**                                          |
| `!= PR_HEAD_SHA`      | `"false"`         | no same-head marker | request cap < 30                   | —        | **REQUEST_NEEDED**                                          |

Note: evaluate the 30-minute SATISFIED condition before the WAIT
condition for the `COPILOT_PENDING="true"` rows — the elapsed ≥ 30 min
case must not be masked by a still-pending state.

Callers handle outcomes differently:

| Outcome         | E14                                | F2                                   | F3                           |
| --------------- | ---------------------------------- | ------------------------------------ | ---------------------------- |
| SATISFIED       | proceed to E15                     | continue to CI check                 | proceed with merge           |
| HOLD            | post AW4 comment; stop             | post AW4 comment; stop               | post AW4 comment; stop       |
| RECOVERY_NEEDED | post recovery marker; poll         | post recovery marker; poll           | post marker; return to F2    |
| CAP\_EXHAUSTED  | skip advisory wait; proceed to E15 | post AW4 cap-exhausted comment; stop | post AW4 cap-exhausted; stop |
| REQUEST\_NEEDED | request Copilot, post marker, poll | return to E14                        | return to E14; do not merge  |
| WAIT            | continue polling (active loop)     | poll F2 conditions every 2 min       | return to F2                 |

**F3 note**: F3 only invokes AW3 when `COPILOT_PENDING` is `"true"` AND
`LAST_COPILOT_COMMIT != PR_HEAD_SHA`. If `COPILOT_PENDING` is `"false"`,
F3 treats the advisory check as satisfied without running AW2–AW3 — see
the F3 caller instructions. If AW3 returns **REQUEST_NEEDED**, F3 must
return to E14 instead of requesting a review or merging.

## AW3-R — Recovery marker

Use this only when AW3 returns **RECOVERY_NEEDED**:

1. Do **not** request another Copilot review. GitHub already reports a
   pending Copilot reviewer, and `COPILOT_PENDING_COVERS_HEAD=true`
   proves the request was created after the current HEAD entered the PR
   timeline.
2. Post a plain-text marker for the current HEAD:

   ```text
   advisory-wait-recovery: {agent-id} {PR_HEAD_SHA} {ISO8601-recovery-time}
   ```

3. Use the marker comment's GitHub `created_at` as the advisory-clock
   start. The embedded timestamp is only human-readable context. Do not
   use an inferred earlier reviewer-request time; recovery deliberately
   starts a fresh conservative wait window.
4. Treat the recovery marker as a wait-clock anchor only. It records an
   already-pending reviewer state; it is not a new Copilot re-review
   request.
5. Re-run AW2 immediately. If the marker cannot be read, post the AW4
   recovery-failed hold comment and stop.
6. Continue through the caller's normal polling path. F3 must not merge
   immediately after posting a recovery marker; it returns to F2.

This recovery path covers Copilot reviewer requests created outside the
current E14 request step, including GitHub auto-assignment, manual
reviewer assignment, or a restart where the original request source is
not knowable. A same-run E14 crash is still safe to recover because the
new marker's `created_at` restarts the wait window instead of shortening
it.

## AW4 — Hold comment templates

**Pending refresh failed** (COPILOT_PENDING is true, no same-head marker
exists, current-head coverage is not proven, and E14 cannot refresh the
request):

> Copilot review is pending for this PR, but the PR timeline does not
> prove that the request was created after HEAD `{PR_HEAD_SHA}` entered
> the PR, and E14 could not refresh the pending request. A maintainer
> must verify or request the Copilot review before this step can safely
> continue. Do not merge until the maintainer has resolved this.

**Recovery failed** (COPILOT_PENDING is true, a recovery marker was
attempted, and no same-head marker can be posted or read):

> Copilot review is pending for HEAD `{PR_HEAD_SHA}` but no
> advisory-wait marker can be posted or read. A maintainer must verify
> the Copilot advisory-wait state before this step can safely continue.
> Do not merge until the maintainer has resolved this.

**Cap exhausted** (no same-head marker, REQUEST_MARKER_COUNT ≥ 30):

> The 30-per-PR Copilot re-review cap is exhausted. A maintainer must
> manually request and evaluate a Copilot review before merge.

## AW5 — Missing-marker recovery during active polling

If `EARLIEST_SAME_HEAD_AT` is empty after a mid-poll refresh (marker
deleted or never posted): post a hold comment and stop:

> Advisory-wait marker for HEAD `{PR_HEAD_SHA}` is missing during
> polling. Unable to compute elapsed time. A maintainer must verify the
> Copilot advisory-wait state before this phase can safely continue.
