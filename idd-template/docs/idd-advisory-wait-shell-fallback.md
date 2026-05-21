# IDD — Advisory-Wait Shell Fallback (AW1 / AW2 detail)

This document contains the verbatim `gh api` + `jq` snippets used by
the shell fallback for [advisory-wait](../.github/instructions/idd-advisory-wait.instructions.md)
AW1 and AW2 evidence collection.

These snippets only apply when helper-first cannot be trusted — see
the "Fail-closed fallback trigger" section in the instruction file.

The instruction file owns the contract (what variables each step must
produce and how AW3 consumes them); this document is the
implementation reference. If the contract and these snippets diverge,
the contract wins and these snippets must be updated.

## AW1

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

## AW2

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
