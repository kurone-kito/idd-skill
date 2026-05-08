# IDD — Copilot Advisory-Wait Protocol

This file defines the shared commands and decision rules for the Copilot
advisory-wait check. It is referenced by:

- **E14** (`idd-review-fix.instructions.md`): request a Copilot
  re-review and wait for the advisory window
- **F2** (`idd-merge.instructions.md`): gate check before allowing merge
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
```

If `LAST_COPILOT_COMMIT == PR_HEAD_SHA` → outcome is **SATISFIED**.
Caller proceeds to its designated next step without running AW2–AW3.

## AW2 — Fetch advisory-wait markers

```sh
EARLIEST_SAME_HEAD_AT=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -r -s "add
         | [.[] | select(
               (.body | test(\"^advisory-wait: [^ ]+ ${PR_HEAD_SHA}(?: |\$)\")) or
               (.body | test(\"^<!-- advisory-wait: [^ ]+ ${PR_HEAD_SHA} [^ ]+ -->$\"))
             )]
         | min_by(.created_at) | .created_at // \"\""
)
# Matches plain-text (current) and HTML-comment (legacy) marker formats.
# Empty → no same-head marker exists.
# Non-empty → earliest same-head marker createdAt (advisory-clock start).

MARKER_COUNT=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate \
    | jq -r -s 'add | [.[] | select(.body | test("^advisory-wait:|^<!-- advisory-wait:"))] | length'
)
# Total advisory-wait markers for this PR (all HEADs). Used for the 30-per-PR cap.
```

Refresh `EARLIEST_SAME_HEAD_AT` at the start of each polling iteration —
its value can change if a parallel session posted a new marker.

Elapsed time = current UTC time − `EARLIEST_SAME_HEAD_AT` as returned by
the GitHub API. Never use the timestamp inside the marker body.

## AW3 — Decision table

Evaluate in this order (the first matching row wins):

| `LAST_COPILOT_COMMIT` | `COPILOT_PENDING` | Marker state        | Elapsed  | Outcome                                                           |
| --------------------- | ----------------- | ------------------- | -------- | ----------------------------------------------------------------- |
| `== PR_HEAD_SHA`      | (any)             | (any)               | (any)    | **SATISFIED**                                                     |
| `!= PR_HEAD_SHA`      | `"true"`          | no same-head marker | —        | **HOLD** (inconsistent)                                           |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | ≥ 30 min | **SATISFIED** (window expired)                                    |
| `!= PR_HEAD_SHA`      | `"true"`          | marker exists       | < 30 min | **WAIT**                                                          |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | ≥ 10 min | **SATISFIED**                                                     |
| `!= PR_HEAD_SHA`      | `"false"`         | marker exists       | < 10 min | **WAIT**                                                          |
| `!= PR_HEAD_SHA`      | `"false"`         | no same-head marker | —        | cap ≥ 30: **HOLD** (cap exhausted); cap < 30: **REQUEST\_NEEDED** |

Note: evaluate the 30-minute SATISFIED condition before the WAIT
condition for the `COPILOT_PENDING="true"` rows — the elapsed ≥ 30 min
case must not be masked by a still-pending state.

## AW4 — Hold comment templates

**Inconsistent state** (COPILOT_PENDING is true, no same-head marker):

> Copilot review is pending for HEAD `{PR_HEAD_SHA}` but no
> advisory-wait marker was found. E14 may have crashed before posting
> the marker. A maintainer must verify whether the Copilot review was
> formally requested and confirm its status before this step can safely
> continue. Do not merge or post a new advisory-wait marker until the
> maintainer has resolved this.

**Cap exhausted** (no same-head marker, MARKER_COUNT ≥ 30):

> The 30-per-PR Copilot re-review cap is exhausted. A maintainer must
> manually request and evaluate a Copilot review before merge.

## AW5 — Missing-marker recovery during active polling

If `EARLIEST_SAME_HEAD_AT` is empty after a mid-poll refresh (marker
deleted or never posted): post a hold comment and stop:

> Advisory-wait marker for HEAD `{PR_HEAD_SHA}` is missing during
> polling. Unable to compute elapsed time. A maintainer must verify the
> Copilot advisory-wait state before this phase can safely continue.
