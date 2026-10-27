---
type: reference
title: IDD — Advisory-Wait Shell Fallback (AW1 / AW2 / AW3-R / AW3-S / AW3-H / F2 detail)
description: Provides the verbatim gh, gh api, and jq commands the advisory-wait and F2 advisory-convergence shell fallbacks use when helper support cannot be trusted.
tags: [advisory-wait, shell-fallback]
---

<!-- cspell:ignore gsub -->

# IDD — Advisory-Wait Shell Fallback (AW1 / AW2 / AW3-R / AW3-S / AW3-H / F2 detail)

This document contains the verbatim commands used by the shell
fallback for [advisory-wait](../.github/instructions/idd-advisory-wait.instructions.md)
and for F2's **Advisory convergence** bullet in
[pre-merge](../.github/instructions/idd-pre-merge.instructions.md):
`gh`/`gh api`/`jq` for AW1/AW2 evidence collection and the F2
convergence / `dispositionEvidence` assertion, and a mix of
`gh`/`gh api`/`node scripts/...` for the AW3-R/AW3-S/AW3-H
marker-posting and cleanup mutations.

These commands only apply when helper-first cannot be trusted — see
the "Fail-closed fallback trigger" section in the instruction file.

**Prerequisite**: a standalone `jq` binary on `PATH`. `gh api --jq` is
built into `gh` and needs nothing extra, but the commands below piping
into `jq -r`/`jq -s` need the real binary, which neither `gh` nor Git
for Windows installs (see ONBOARDING.md's Step 0 execution-environment
prerequisites).

The two filter interfaces are separate. `gh api --jq` accepts one jq
filter string as its option value:

```sh
gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}" --jq '.head.sha'
```

When a filter needs shell variables, pipe the JSON to standalone `jq`,
where `--arg` binds a value for the filter:

```sh
gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}" \
  | jq --arg expected "${PR_HEAD_SHA}" '.head.sha == $expected'
```

Observed 2026-09-19 in issue [#3142][jq-incident], round 21 of the
[field-feedback gist][jq-feedback-gist]: an agent copied standalone
`jq --arg` syntax into `gh api --jq`, causing the command to fail before
the intended check. This is an observed failure, not preventive guidance.

[jq-incident]: https://github.com/kurone-kito/idd-skill/issues/3142
[jq-feedback-gist]: https://gist.github.com/kurone-kito/9f2d7871542cb2f7a255f92a7c1232d0

Do not pass standalone jq options to `gh api`; keep the API call and jq
process as separate commands.

The instruction file owns the contract (decision rules, ordering,
fail-closed handling, and what each step must produce); this document
is the command reference. If the contract and these commands diverge,
the contract wins and these commands must be updated.

## AW1

```sh
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')

LAST_COPILOT_COMMIT=$(
  gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/reviews" \
    --paginate \
    --jq '.[] | select(.user.login == "copilot-pull-request-reviewer" or .user.login == "copilot-pull-request-reviewer[bot]") |
               {sa: .submitted_at, cid: .commit_id}' \
  | jq -rs 'sort_by(.sa) | last | .cid // ""'
)

COPILOT_PENDING=$(gh api "repos/${OWNER}/${REPO}/pulls/{pr-number}/requested_reviewers" \
  --jq '.users | any((.login // "" | ascii_downcase) as $l | $l == "copilot" or $l == "copilot-pull-request-reviewer" or $l == "copilot-pull-request-reviewer[bot]")')
# Observed once: requested_reviewers can lag a successful re-request
# or empty on submit, so false is not idle proof.
# LAST_COPILOT_COMMIT == PR_HEAD_SHA is necessary for SATISFIED, not
# sufficient: AW1's hold check must also clear every other same-head review.

COPILOT_PENDING_RAW=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/timeline" \
    -H "Accept: application/vnd.github+json" \
    --paginate
) || {
  echo "timeline read failed; not trusted (#3860)" >&2
  exit 2
}
# At least one page must arrive, and every page must be an array (#3860
# review): `add // []` over no input would read as an empty timeline.
printf '%s' "$COPILOT_PENDING_RAW" | jq -e -s 'length > 0 and all(.[]; type == "array")' > /dev/null || {
  echo "timeline read malformed; not trusted (#3860)" >&2
  exit 2
}
COPILOT_PENDING_COVERS_HEAD=$(
  printf '%s' "$COPILOT_PENDING_RAW" | jq -r -s --arg sha "${PR_HEAD_SHA}" '
        (add // [])
        | to_entries
        | (map(select(.value.event == "committed"
             and ((.value.sha // .value.commit_id // "") == $sha)))
           | last | .key // null) as $head_index
        | (map(select(.value.event == "review_requested"
             and (((.value.requested_reviewer.login // "" | ascii_downcase) as $l
                  | $l == "copilot"
                  or $l == "copilot-pull-request-reviewer"
                  or $l == "copilot-pull-request-reviewer[bot]"))))
           | last | .key // null) as $request_index
        | ($head_index != null and $request_index != null and
           $request_index > $head_index)
      '
)
```

## AW2

```sh
ADVISORY_COMMENTS_RAW=$(
  gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate
) || {
  echo "AW2 comment list read failed; not trusted (#3860)" >&2
  exit 2
}
printf '%s' "${ADVISORY_COMMENTS_RAW}" | jq -e -s 'length > 0 and all(.[]; type == "array")' > /dev/null || {
  echo "AW2 comment list malformed; not trusted (#3860)" >&2
  exit 2
}
ADVISORY_COMMENTS_JSON=$(printf '%s' "${ADVISORY_COMMENTS_RAW}" | jq -s 'add // []') || exit 2

# Edit state (#3860): REST rows carry no lastEditedAt. Read it from GraphQL
# and join by databaseId = REST id. A row the join misses is "unresolved":
# it is never evidence, but it still counts toward the request cap below.
EDIT_STATE_RAW=$(
  gh api graphql --paginate -f query='
    query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          comments(first:100, after:$endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId lastEditedAt }
          }
        }
      }
    }' -F owner="${OWNER}" -F repo="${REPO}" -F number={pr-number} \
    --jq '.data.repository.pullRequest.comments.nodes[]'
) || {
  echo "AW2 edit-state read failed; comment list not trusted (#3860)" >&2
  exit 2
}
# A node that lacks either field is left out of the map, so its comment stays
# "unresolved" and never reads as an explicit null (#3860 review).
EDIT_STATE_JSON=$(printf '%s\n' "${EDIT_STATE_RAW}" \
  | jq -s 'map(select(has("databaseId") and has("lastEditedAt")) | {key: (.databaseId | tostring), value: .lastEditedAt}) | from_entries') || exit 2
ADVISORY_COMMENTS_JSON=$(
  printf '%s' "${ADVISORY_COMMENTS_JSON}" | jq --argjson edit "${EDIT_STATE_JSON}" '
    map(. + {lastEditedAt: ((.id | tostring) as $k
      | if ($edit | has($k)) then $edit[$k] else "unresolved" end)})
  '
) || exit 2

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
        | jq -r '.[] | select((.body // "") | test("^advisory-wait:|^advisory-wait-recovery:|^<!--\\s*advisory-wait:|^advisory-reroll:")) | .user.login // empty' \
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

# Same-HEAD evidence (#3860): a marker counts only while its lastEditedAt is
# explicitly null. An edited or unresolved marker is no evidence.
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
          and (.lastEditedAt == null)
          and (
            ((.body // "") | test("^advisory-wait:\\s+\\S+\\s+" + $sha + "\\s+\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z\\s*$")) or
            ((.body // "") | test("^advisory-wait-recovery:\\s+\\S+\\s+" + $sha + "\\s+\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z(?:\\s+claim:\\S+\\s+attempt:[1-9]\\d*)?\\s*$")) or
            ((.body // "") | test("^<!--\\s*advisory-wait:\\s+\\S+\\s+" + $sha + "\\s+\\S+\\s*-->\\s*$"))
          )
        )]
        | min_by(.created_at) | .created_at // ""
      '
)

# Every trusted request marker counts toward the cap, edited or not, so
# editing an old request cannot reopen the bounded budget (#3860).
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
          and ((.body // "") | test("^advisory-wait:|^<!--\\s*advisory-wait:"))
        )]
        | length
      '
)

# #2327: head-scoped, request-only (excludes advisory-wait-recovery:) --
# distinct from EARLIEST_SAME_HEAD_AT above (a recovery-only marker also
# satisfies that) and from REQUEST_MARKER_COUNT above (not head-scoped).
# #3860: as for EARLIEST_SAME_HEAD_AT, only an explicitly unedited marker
# is evidence.
SAME_HEAD_REQUEST_MARKER_PRESENT=$(
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
          and (.lastEditedAt == null)
          and (
            ((.body // "") | test("^advisory-wait:\\s+\\S+\\s+" + $sha + "\\s+\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z\\s*$")) or
            ((.body // "") | test("^<!--\\s*advisory-wait:\\s+\\S+\\s+" + $sha + "\\s+\\S+\\s*-->\\s*$"))
          )
        )] | length > 0
      '
)
```

## AW3-R

Post via the profile-selected post-idd-marker command (source repo /
vendored-node: `node scripts/post-idd-marker.mjs`; package-manager /
ephemeral-npx / user-global: resolve from `docs/idd-helper-scripts.md`)
`--type advisory-recovery --target pr <pr-number> --agent-id <id>
--head-sha <PR_HEAD_SHA> --timestamp <ISO8601> --apply`, or manually:

```sh
GH_REPO_ROUTE=$(gh repo view --json owner,name,url --jq '
  . as $repo
  | ($repo.url | capture("^https://(?<hostname>[A-Za-z0-9.-]+)(?<port>:[0-9]{1,5})?/(?<urlOwner>[A-Za-z0-9_.-]+)/(?<urlRepo>[A-Za-z0-9_.-]+)/?$")) as $url
  | ($url.hostname | split(".") | all(.[]; match("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$") != null)) as $valid_hostname
  | (($url.port // "") | if . == "" then true else (ltrimstr(":") | tonumber) as $port | $port >= 1 and $port <= 65535 end) as $valid_port
  | ($repo.owner.login // "") as $owner
  | ($repo.name // "") as $name
  | if $valid_hostname
      and $valid_port
      and ($owner | match("^[A-Za-z0-9_.-]+$") != null)
      and ($name | match("^[A-Za-z0-9_.-]+$") != null)
      and ($url.urlOwner | ascii_downcase) == ($owner | ascii_downcase)
      and ($url.urlRepo | ascii_downcase) == ($name | ascii_downcase)
    then {
      authHost: $url.hostname,
      owner: $owner,
      repo: $name,
      ported: ($url.port != null)
    }
    else error("unsupported or mismatched repository URL") end
') || {
  echo "cannot resolve the repository's GitHub host; recovery marker not posted" >&2
  exit 2
}
GH_AUTH_HOST=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.authHost') || {
  echo "cannot resolve the repository's authentication host; recovery marker not posted" >&2
  exit 2
}
GH_API_PORTED=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -r '.ported') || {
  echo "cannot resolve whether the repository host uses a port; recovery marker not posted" >&2
  exit 2
}
GH_OWNER=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.owner') || {
  echo "cannot resolve the repository owner; recovery marker not posted" >&2
  exit 2
}
GH_REPO_NAME=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.repo') || {
  echo "cannot resolve the repository name; recovery marker not posted" >&2
  exit 2
}
[ -n "$GH_AUTH_HOST" ] && [ -n "$GH_OWNER" ] && [ -n "$GH_REPO_NAME" ] && { [ "$GH_API_PORTED" = true ] || [ "$GH_API_PORTED" = false ]; } || {
  echo "repository GitHub host is empty or invalid; recovery marker not posted" >&2
  exit 2
}
if [ "$GH_API_PORTED" = true ]; then
  # gh v2.98.0 looks up request credentials by the request host, including
  # its port; a bare-host auth check cannot prove the ported request is
  # authenticated (observed 2026-10-23 in #4638).
  echo "cannot verify authentication for a ported GitHub host; recovery marker not posted" >&2
  exit 2
fi
gh auth status --active --hostname "$GH_AUTH_HOST" >/dev/null 2>&1 || {
  echo "not authenticated to $GH_AUTH_HOST; recovery marker not posted" >&2
  exit 2
}
gh api --hostname "$GH_AUTH_HOST" "repos/$GH_OWNER/$GH_REPO_NAME/issues/{pr-number}/comments" \
  --method POST --silent \
  -f body="advisory-wait-recovery: {agent-id} {PR_HEAD_SHA} {ISO8601-recovery-time}"
```

## Registration-proven review request

E14's `REQUEST_NEEDED` branch uses this procedure in its default
event-or-node mode. AW3-S step 3 below calls it with `aw3-s`, which
requires the event-after-HEAD mode because a request node is not tied to
a commit. Snapshot both matching proofs before the first mutation: the
latest `review_requested` event and the matching `reviewRequests` node
ids. Post an E14 `advisory-wait` marker only when a re-read finds a
newer matching event after the current HEAD `committed` event, or a
request node whose id was absent from the snapshot. AW3-S accepts only
the newer event after HEAD. An older event, exit status, or HTTP 201 is
not evidence. Observed 2026-09-26 in issue
`#3500` (refs issues `#3481` and `#3491`): both calls returned success
while `requested_reviewers` stayed empty and no `review_requested` event
was recorded.

```sh
BOT_REST_LOGIN={primary-advisory-bot-rest-login}
export BOT_REST_LOGIN
PR_NODE_ID=$(gh pr view {pr-number} --json id --jq '.id')
if [ -z "${PR_HEAD_SHA:-}" ]; then
  PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
fi
BOT_REST_LOGIN_BARE=${BOT_REST_LOGIN%\[bot\]}
export BOT_REST_LOGIN_BARE
claim_revalidate() {
  # Run from the issue worktree. The profile-selected resume-claim-routing
  # command (source repo / vendored-node: `node scripts/resume-claim-routing.mjs`;
  # package-manager / ephemeral-npx / user-global: resolve from
  # `docs/idd-helper-scripts.md`)
  # with `--assert` exits non-zero on any verdict except already_owned/keep.
  # That proves the claim id (and the activation nonce when --nonce is given
  # and a winner marker exists) and, when a worktree occupies the claimed
  # branch, its lock, generated tokens and cwd. With no worktree on that
  # branch it proves the claim id (and nonce) only.
  # Never pipe it: a pipe hides its exit status. Its stderr line names the
  # verdict and, on owner_evidence_required, the failed proof.
  <profile-selected-resume-claim-routing-command> --issue {issue-number} \
    --claim-id {claim-id} --nonce {nonce} --assert >/dev/null || return 2
  LIVE_PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid') || return 2
  [ "$LIVE_PR_HEAD_SHA" = "$PR_HEAD_SHA" ] || {
    echo "PR HEAD moved; restart from E1" >&2
    return 2
  }
}
head_timeline_index() {
  local result
  result=$(gh api repos/{owner}/{repo}/issues/{pr-number}/timeline --paginate) || return 1
  printf '%s' "$result" | jq -e -s 'length > 0 and all(.[]; type == "array")' > /dev/null || return 1
  printf '%s' "$result" | jq -r -s --arg sha "$PR_HEAD_SHA" '
    (add // [])
    | to_entries
    | map(select(.value.event == "committed"
        and ((.value.sha // .value.commit_id // "") == $sha)))
    | last | .key // empty' || return 1
}
request_event() {
  local result
  result=$(gh api repos/{owner}/{repo}/issues/{pr-number}/timeline --paginate) || return 1
  printf '%s' "$result" | jq -e -s 'length > 0 and all(.[]; type == "array")' > /dev/null || return 1
  printf '%s' "$result" | jq -r -s '
    def matches_configured_reviewer($login):
      ($login.login // "" | ascii_downcase) as $l
      | ($login.type // "" | ascii_downcase) as $type
      | (env.BOT_REST_LOGIN_BARE | ascii_downcase) as $bare
      | (env.BOT_REST_LOGIN | ascii_downcase) as $configured
      | (($type == "user" and $l == $configured)
         or ($type == "bot"
             and ($l == $bare
             or $l == ($bare + "[bot]")
             or (($bare == "copilot"
                  or $bare == "copilot-pull-request-reviewer")
                 and ($l == "copilot"
                      or $l == "copilot-pull-request-reviewer"
                      or $l == "copilot-pull-request-reviewer[bot]")))));
    (add // [])
    | to_entries
    | map(select(.value.event == "review_requested"
        and matches_configured_reviewer(.value.requested_reviewer)))
    | last
    | if . == null then empty
      else [.value.id, .value.created_at, .key] | @tsv end' || return 1
}
request_nodes() {
  local result
  result=$(gh api graphql -F owner={owner} -F repo={repo} -F number={pr-number} -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewRequests(first:100){nodes{id requestedReviewer{__typename ... on Bot{login} ... on User{login}}}}}}}') || return 1
  printf '%s' "$result" |
    jq -r '
      def matches_configured_reviewer($login):
        ($login.login // "" | ascii_downcase) as $l
        | ($login.__typename // "" | ascii_downcase) as $type
        | (env.BOT_REST_LOGIN_BARE | ascii_downcase) as $bare
        | (env.BOT_REST_LOGIN | ascii_downcase) as $configured
        | (($type == "user" and $l == $configured)
           or ($type == "bot"
               and ($l == $bare
               or $l == ($bare + "[bot]")
               or (($bare == "copilot"
                    or $bare == "copilot-pull-request-reviewer")
                   and ($l == "copilot"
                        or $l == "copilot-pull-request-reviewer"
                        or $l == "copilot-pull-request-reviewer[bot]")))));
      .data.repository.pullRequest.reviewRequests.nodes[]
      | select(matches_configured_reviewer(.requestedReviewer))
      | .id'
}
registration_attempt() {
  local evidence_mode=${1:-e14}
  case "$evidence_mode" in
    e14|aw3-s) ;;
    *) echo "unknown registration evidence mode" >&2; return 2 ;;
  esac
  HEAD_TIMELINE_INDEX=
  if [ "$evidence_mode" = "aw3-s" ]; then
    HEAD_TIMELINE_INDEX=$(head_timeline_index) || {
      echo "HEAD timeline snapshot unreadable" >&2
      return 2
    }
    [ -n "$HEAD_TIMELINE_INDEX" ] || {
      echo "HEAD committed timeline event absent" >&2
      return 2
    }
  else
    # E14 may use a fresh request node when GitHub has not exposed the
    # current HEAD's committed timeline event yet. Event proof remains
    # preferred when the index is available, but it is not mandatory in
    # this mode.
    HEAD_TIMELINE_INDEX=$(head_timeline_index) || HEAD_TIMELINE_INDEX=
  fi
  EVENT_BEFORE=$(request_event) || { echo "event snapshot unreadable" >&2; return 2; }
  NODES_BEFORE=
  if [ "$evidence_mode" != "aw3-s" ]; then
    NODES_BEFORE=$(request_nodes) || { echo "request-node snapshot unreadable" >&2; return 2; }
  fi
  registration_ok() {
    EVENT_AFTER=$(request_event) || return 2
    EVENT_ID=$(printf '%s\n' "$EVENT_AFTER" | cut -f1)
    EVENT_INDEX=$(printf '%s\n' "$EVENT_AFTER" | cut -f3)
    EVENT_NEW=false
    case "$EVENT_INDEX" in
      ''|*[!0-9]*) ;;
      *)
        if [ -n "$EVENT_ID" ] \
          && [ -n "$HEAD_TIMELINE_INDEX" ] \
          && ! printf '%s\n' "$EVENT_BEFORE" | cut -f1 | grep -Fxq "$EVENT_ID" \
          && [ "$EVENT_INDEX" -gt "$HEAD_TIMELINE_INDEX" ]; then
          EVENT_NEW=true
        fi
        ;;
    esac
    [ "$EVENT_NEW" = true ] && return 0
    [ "$evidence_mode" = "aw3-s" ] && return 1
    NODES_AFTER=$(request_nodes) || return 2
    NODE_FRESH=false
    while IFS= read -r node; do
      [ -n "$node" ] && ! printf '%s\n' "$NODES_BEFORE" | grep -Fxq "$node" && NODE_FRESH=true
    done <<EOF
$NODES_AFTER
EOF
    [ "$NODE_FRESH" = true ]
  }
  registration_check() {
    local max_attempts=1 attempt=1 status=1
    [ "$evidence_mode" = "aw3-s" ] && max_attempts=3
    while [ "$attempt" -le "$max_attempts" ]; do
      if registration_ok; then return 0; else status=$?; fi
      [ "$status" -eq 2 ] && return 2
      [ "$attempt" -eq "$max_attempts" ] && return 1
      sleep 1
      attempt=$((attempt + 1))
    done
    return "$status"
  }

  # Re-run the shared claim revalidation gate immediately before every
  # reviewer-request mutation. A failed gate must stop this attempt.
  claim_revalidate || return 3
  gh pr edit {pr-number} --add-reviewer "@{primary-advisory-bot}" || :
  if registration_check; then status=0; else status=$?; fi
  if [ "$status" -eq 0 ]; then
    claim_revalidate || return 3
    return 0
  fi
  [ "$status" -eq 2 ] && return 2

  claim_revalidate || return 3
  gh api repos/{owner}/{repo}/pulls/{pr-number}/requested_reviewers \
    -X POST -f "reviewers[]={primary-advisory-bot-rest-login}" || :
  if registration_check; then status=0; else status=$?; fi
  if [ "$status" -eq 0 ]; then
    claim_revalidate || return 3
    return 0
  fi
  [ "$status" -eq 2 ] && return 2

  # Resolve the id and account type live. The GraphQL mutation has separate
  # userIds and botIds inputs; user(login:) does not resolve a Bot, and using
  # botIds for a User-typed configured reviewer silently loses the request.
  REVIEWER_JSON=$(gh api "users/{primary-advisory-bot-rest-login}") || return 2
  REVIEWER_NODE_ID=$(printf '%s' "$REVIEWER_JSON" | jq -r '.node_id // empty') || return 2
  REVIEWER_TYPE=$(printf '%s' "$REVIEWER_JSON" | jq -r '(.type // "") | ascii_downcase') || return 2
  [ -n "$REVIEWER_NODE_ID" ] || return 2
  claim_revalidate || return 3
  case "$REVIEWER_TYPE" in
    bot)
      jq -n --arg id "$PR_NODE_ID" --arg reviewer "$REVIEWER_NODE_ID" \
        '{query:"mutation($id:ID!,$reviewer:[ID!]!){ requestReviews(input:{pullRequestId:$id,botIds:$reviewer,union:true}){ clientMutationId } }",variables:{id:$id,reviewer:[$reviewer]}}' |
        gh api graphql --input - || :
      ;;
    user)
      jq -n --arg id "$PR_NODE_ID" --arg reviewer "$REVIEWER_NODE_ID" \
        '{query:"mutation($id:ID!,$reviewer:[ID!]!){ requestReviews(input:{pullRequestId:$id,userIds:$reviewer,union:true}){ clientMutationId } }",variables:{id:$id,reviewer:[$reviewer]}}' |
        gh api graphql --input - || :
      ;;
    *)
      echo "configured reviewer account type is not Bot or User" >&2
      return 2
      ;;
  esac
  if registration_check; then status=0; else status=$?; fi
  if [ "$status" -eq 0 ]; then
    claim_revalidate || return 3
    return 0
  fi
  [ "$status" -eq 2 ] && return 2
  echo "registration evidence absent" >&2
  return 1
}

# E14 stops/asks on status 1 or 2. Status 3 means the claim/HEAD guard
# failed and stops the route for an E1 restart. AW3-S may recheck status 1,
# but status 2 is unreadable evidence: hold via AW4 and never count a cycle.
REGISTRATION_STATUS=0
registration_attempt e14 || REGISTRATION_STATUS=$?

case "$REGISTRATION_STATUS" in
  0)
    # The marker is a separate GitHub mutation. Revalidate after registration
    # evidence is proven and immediately before posting it.
    claim_revalidate || exit 2
    <profile-selected-post-idd-marker-command> --type advisory --target pr <pr-number> \
      --agent-id <id> --head-sha <PR_HEAD_SHA> --timestamp <ISO8601> --apply
    # instructions-only profile: post the same advisory-wait body manually
    # through the GitHub issue-comments API, preserving the marker grammar.
    ;;
  1 | 2 | 3)
    echo "E14 registration did not prove a safe marker step; stop and ask" >&2
    exit 2
    ;;
  *)
    echo "E14 registration returned an unexpected status" >&2
    exit 2
    ;;
esac
```

The post-request reads must run after each mutating attempt. The
`EVENT_BEFORE`/`NODES_BEFORE` values are the baselines for the selected
mode. E14 can carry a fresh node proof when the event is delayed, but AW3-S
requires the event-after-HEAD proof because a request node has no commit
association. E14 posts its
`advisory-wait` marker only when `REGISTRATION_STATUS` is `0`; statuses
`1`/`2` stop and ask, while status `3` stops for an E1 restart. AW3-S
uses step 4 only after readable event evidence; status `2` routes to AW4
and cannot count a failed cycle or post a marker.

## AW3-S

Only when `staleRequestRecovery` is `"attempt"` (instruction file's
Eligibility check). Steps 2 and 4 (verify removal/HEAD; verify
association) are read-only checks the instruction file specifies
directly — no command block needed here.

```sh
revalidate_head() {
  <profile-selected-resume-claim-routing-command> --issue {issue-number} \
    --claim-id {claim-id} --nonce {nonce} --assert >/dev/null || return 2
  LIVE_PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid') || return 2
  [ "$LIVE_PR_HEAD_SHA" = "$PR_HEAD_SHA" ] || {
    echo "PR HEAD moved; restart from E1" >&2
    return 2
  }
}

# One read of the removal evidence (#3860 review): reviewRequests plus the
# review_request_removed events, each event with its id, so the baseline and
# the proof compare event ids. The JSON goes to REMOVAL_SNAPSHOT_JSON; a failed
# read or an unexpected shape returns non-zero.
read_removal_snapshot() {
  REMOVAL_SNAPSHOT_JSON=$(
    gh api graphql -f query='
      query($owner:String!, $repo:String!, $number:Int!) {
        repository(owner:$owner, name:$repo) {
          pullRequest(number:$number) {
            reviewRequests(first:100) {
              pageInfo { hasNextPage }
              nodes { requestedReviewer { __typename ... on Bot { login } ... on User { login } } }
            }
            timelineItems(last:50, itemTypes:[REVIEW_REQUEST_REMOVED_EVENT]) {
              pageInfo { hasPreviousPage }
              nodes {
                ... on ReviewRequestRemovedEvent {
                  id
                  createdAt
                  requestedReviewer { __typename ... on Bot { login } ... on User { login } }
                }
              }
            }
          }
        }
      }' -F owner="{owner}" -F repo="{repo}" -F number={pr-number}
  ) || return 2
  printf '%s' "$REMOVAL_SNAPSHOT_JSON" | jq -e '
    .data.repository.pullRequest
    | (.reviewRequests.nodes | type == "array") and (.timelineItems.nodes | type == "array")
      and (.reviewRequests.pageInfo | has("hasNextPage"))
      and (.timelineItems.pageInfo | has("hasPreviousPage"))
  ' > /dev/null || return 2
  # A truncated connection can hide the bot or a removal event, so stop here
  # rather than read a partial window as proof (#3860 review).
  printf '%s' "$REMOVAL_SNAPSHOT_JSON" | jq -e '
    .data.repository.pullRequest
    | (.reviewRequests.pageInfo.hasNextPage == false)
      and (.timelineItems.pageInfo.hasPreviousPage == false)
  ' > /dev/null || {
    echo "AW3-S removal evidence truncated; route to AW4" >&2
    return 2
  }
}

# Resolve and validate the entry before any destructive mutation. A
# non-pending entry starts at Step 3 and must not remove a request that may
# have become visible during propagation (#2327, #3507).
if [ -z "${AW3S_ENTRY:-}" ]; then
  case "${COPILOT_PENDING:-}" in
    true) AW3S_ENTRY=pending ;;
    false) AW3S_ENTRY=non-pending ;;
    *)
      echo "AW3-S requires AW3S_ENTRY or COPILOT_PENDING from the AW3 decision" >&2
      exit 2
      ;;
  esac
fi
case "$AW3S_ENTRY" in
  pending | non-pending) ;;
  *)
    echo "AW3-S entry must be pending or non-pending" >&2
    exit 2
    ;;
esac

# Step 1 — remove the stale request. PENDING entry only (COPILOT_PENDING
# was "true"). Skip this step entirely for the non-pending entry (#2327 --
# COPILOT_PENDING was already "false", nothing is pending to remove) and
# start at Step 3 instead.
if [ "$AW3S_ENTRY" = "pending" ]; then
  revalidate_head || exit 2
  # Bounded retry (#3503, #3860): a failed removal is retried alone, three
  # attempts in all, before any AW4 hold. A 422 "Could not resolve to a User
  # node" for the default bot (PR #3471) is not a removal result.
  # Each attempt takes its own baseline and start time immediately before the
  # mutation (#3860 review), so only an event created after that call can prove
  # it. The baseline lists the removal event ids that already exist, since a
  # second-precision timestamp cannot tell an older event from a new one.
  REMOVE_OK=0
  for REMOVE_ATTEMPT in 1 2 3; do
    revalidate_head || exit 2
    read_removal_snapshot || {
      echo "AW3-S removal baseline unreadable; route to AW4" >&2
      exit 2
    }
    REMOVED_IDS_BEFORE=$(printf '%s' "$REMOVAL_SNAPSHOT_JSON" | jq -c '
      [.data.repository.pullRequest.timelineItems.nodes[].id | select(. != null)]
    ') || exit 2
    REMOVE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if gh pr edit {pr-number} --remove-reviewer "@{primary-advisory-bot}"; then
      REMOVE_OK=1
      break
    fi
  done
  if [ "$REMOVE_OK" -ne 1 ]; then
    echo "AW3-S removal failed after 3 attempts; route to AW4" >&2
    exit 2
  fi
  revalidate_head || exit 2
  # The REST DELETE is an attempt only: never conclude from it, or from an
  # empty requested_reviewers read (#2167, #3503).
  gh api repos/{owner}/{repo}/pulls/{pr-number}/requested_reviewers \
    -X DELETE -f "reviewers[]={primary-advisory-bot-rest-login}" || true
  revalidate_head || exit 2
  # Removal proof (#3860): the bot must be gone from reviewRequests, or a
  # review_request_removed event for it must follow REMOVE_STARTED_AT. A
  # proof that cannot be read, or that shows the bot still requested with no
  # such event, stops here, before the request step. Logins follow the runtime
  # identity contract: the three default Copilot logins are one identity, and a
  # bare login equals its [bot] form. Only an event id absent from the baseline
  # counts, since a second-precision timestamp cannot separate the two.
  read_removal_snapshot || {
    echo "AW3-S removal proof unreadable; route to AW4" >&2
    exit 2
  }
  BOT_STILL_REQUESTED=$(printf '%s' "$REMOVAL_SNAPSHOT_JSON" | jq -r --arg bot "{primary-advisory-bot-login}" '
    # The configured reviewer is matched by account type (#3860 review): a User
    # node by its exact login, a Bot node by the runtime identity rule, where the
    # three default Copilot logins are one identity and a bare login equals its
    # [bot] form.
    def canon($l):
      ($l | ascii_downcase) as $n
      | if ($n == "copilot" or $n == "copilot-pull-request-reviewer"
            or $n == "copilot-pull-request-reviewer[bot]") then "copilot"
        elif ($n | endswith("[bot]")) then $n[0:($n | length) - 5]
        else $n end;
    def is_configured($r):
      (($r.__typename? // "") | ascii_downcase) as $t
      | (($r.login? // "") | ascii_downcase) as $l
      | ($bot | ascii_downcase) as $b
      | (($t == "user" and $l == $b) or ($t == "bot" and canon($l) == canon($b)));
    [.data.repository.pullRequest.reviewRequests.nodes[]
      | .requestedReviewer // empty
      | select(is_configured(.))]
    | length > 0
  ') || exit 2
  BOT_REMOVED_SINCE=$(printf '%s' "$REMOVAL_SNAPSHOT_JSON" | jq -r \
    --arg bot "{primary-advisory-bot-login}" --arg since "$REMOVE_STARTED_AT" \
    --argjson before "$REMOVED_IDS_BEFORE" '
    def canon($l):
      ($l | ascii_downcase) as $n
      | if ($n == "copilot" or $n == "copilot-pull-request-reviewer"
            or $n == "copilot-pull-request-reviewer[bot]") then "copilot"
        elif ($n | endswith("[bot]")) then $n[0:($n | length) - 5]
        else $n end;
    def is_configured($r):
      (($r.__typename? // "") | ascii_downcase) as $t
      | (($r.login? // "") | ascii_downcase) as $l
      | ($bot | ascii_downcase) as $b
      | (($t == "user" and $l == $b) or ($t == "bot" and canon($l) == canon($b)));
    [.data.repository.pullRequest.timelineItems.nodes[]
      | select((.id as $id | $before | index($id)) == null)
      | select(.createdAt >= $since)
      | .requestedReviewer // empty
      | select(is_configured(.))]
    | length > 0
  ') || exit 2
  if [ "$BOT_STILL_REQUESTED" = "true" ] && [ "$BOT_REMOVED_SINCE" != "true" ]; then
    echo "AW3-S removal not proven: bot still requested; route to AW4" >&2
    exit 2
  fi
fi

# Step 3 — request again (non-pending entry: the first mutating step;
# pending entry: after step 2 verifies the removal). Run the
# registration-proven review request above in AW3-S mode. Its
# event snapshots precede both mutations, but step 4 accepts only
# a fresh review_requested event after HEAD's committed event.
if ! command -v registration_attempt >/dev/null 2>&1; then
  echo "AW3-S requires the shared registration procedure" >&2
  exit 2
fi
REGISTRATION_STATUS=0
registration_attempt aw3-s || REGISTRATION_STATUS=$?

# AW3S_ENTRY is now "pending" or "non-pending" from AW3's decision.
# Pending success is counted; pending status 1 returns without a marker.
# Non-pending status 0 is ordinary success and also returns without a
# marker; only its status 1 failure reaches the counted marker below.
case "$REGISTRATION_STATUS" in
  2)
    echo "AW3-S evidence unreadable; route to AW4" >&2
    exit 2
    ;;
  3)
    echo "AW3-S claim/HEAD guard failed; restart from E1" >&2
    exit 2
    ;;
  0 | 1) ;;
  *)
    echo "AW3-S registration returned an unexpected status" >&2
    exit 2
    ;;
esac
if [ "$AW3S_ENTRY" = "pending" ] && [ "$REGISTRATION_STATUS" -eq 1 ]; then
  echo "AW3-S pending request still unproven; return to polling" >&2
  exit 1
fi
if [ "$AW3S_ENTRY" = "non-pending" ] && [ "$REGISTRATION_STATUS" -eq 0 ]; then
  echo "AW3-S re-request registered; return without counting" >&2
  exit 0
fi

# Step 5 -- post exactly one bound marker, only once step 4 reaches a
# counted disposition: proven re-registration for a pending entry, or
# proven failure-to-register within the same short budget for a
# non-pending entry (#2327 -- see the instruction file's step 4).
# Re-run the shared claim gate and compare the live PR head immediately
# before posting; on either mismatch, abort and restart from E1.
revalidate_head || exit 2
# source repo / vendored-node profile:
node scripts/post-idd-marker.mjs --type advisory-recovery --target pr <pr-number> \
  --agent-id <id> --claim-id <id> --head-sha <PR_HEAD_SHA> \
  --attempt <n> --timestamp <ISO8601> --apply
# package-manager / ephemeral-npx / user-global profile, resolve the
# command name from
# docs/idd-helper-scripts.md:
<profile-selected-post-idd-marker-command> --type advisory-recovery \
  --target pr <pr-number> --agent-id <id> --claim-id <id> \
  --head-sha <PR_HEAD_SHA> --attempt <n> --timestamp <ISO8601> --apply
# instructions-only profile, or any profile if the helper is unavailable —
# manually, matching the grammar renderAdvisoryWaitRecoveryMarker emits:
GH_REPO_ROUTE=$(gh repo view --json owner,name,url --jq '
  . as $repo
  | ($repo.url | capture("^https://(?<hostname>[A-Za-z0-9.-]+)(?<port>:[0-9]{1,5})?/(?<urlOwner>[A-Za-z0-9_.-]+)/(?<urlRepo>[A-Za-z0-9_.-]+)/?$")) as $url
  | ($url.hostname | split(".") | all(.[]; match("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$") != null)) as $valid_hostname
  | (($url.port // "") | if . == "" then true else (ltrimstr(":") | tonumber) as $port | $port >= 1 and $port <= 65535 end) as $valid_port
  | ($repo.owner.login // "") as $owner
  | ($repo.name // "") as $name
  | if $valid_hostname
      and $valid_port
      and ($owner | match("^[A-Za-z0-9_.-]+$") != null)
      and ($name | match("^[A-Za-z0-9_.-]+$") != null)
      and ($url.urlOwner | ascii_downcase) == ($owner | ascii_downcase)
      and ($url.urlRepo | ascii_downcase) == ($name | ascii_downcase)
    then {
      authHost: $url.hostname,
      owner: $owner,
      repo: $name,
      ported: ($url.port != null)
    }
    else error("unsupported or mismatched repository URL") end
') || {
  echo "cannot resolve the repository's GitHub host; recovery marker not posted" >&2
  exit 2
}
GH_AUTH_HOST=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.authHost') || {
  echo "cannot resolve the repository's authentication host; recovery marker not posted" >&2
  exit 2
}
GH_API_PORTED=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -r '.ported') || {
  echo "cannot resolve whether the repository host uses a port; recovery marker not posted" >&2
  exit 2
}
GH_OWNER=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.owner') || {
  echo "cannot resolve the repository owner; recovery marker not posted" >&2
  exit 2
}
GH_REPO_NAME=$(printf '%s\n' "$GH_REPO_ROUTE" | jq -er '.repo') || {
  echo "cannot resolve the repository name; recovery marker not posted" >&2
  exit 2
}
[ -n "$GH_AUTH_HOST" ] && [ -n "$GH_OWNER" ] && [ -n "$GH_REPO_NAME" ] && { [ "$GH_API_PORTED" = true ] || [ "$GH_API_PORTED" = false ]; } || {
  echo "repository GitHub host is empty or invalid; recovery marker not posted" >&2
  exit 2
}
if [ "$GH_API_PORTED" = true ]; then
  # gh v2.98.0 looks up request credentials by the request host, including
  # its port; a bare-host auth check cannot prove the ported request is
  # authenticated (observed 2026-10-23 in #4638).
  echo "cannot verify authentication for a ported GitHub host; recovery marker not posted" >&2
  exit 2
fi
gh auth status --active --hostname "$GH_AUTH_HOST" >/dev/null 2>&1 || {
  echo "not authenticated to $GH_AUTH_HOST; recovery marker not posted" >&2
  exit 2
}
gh api --hostname "$GH_AUTH_HOST" "repos/$GH_OWNER/$GH_REPO_NAME/issues/{pr-number}/comments" \
  --method POST --silent \
  -f body="advisory-wait-recovery: {agent-id} {PR_HEAD_SHA} {ISO8601-recovery-time} claim:{claim-id} attempt:{n}"
```

## AW3-H

`--subject-ids` needs a GraphQL node id, not a REST numeric id —
convert first: `gh api repos/{owner}/{repo}/issues/comments/{comment_id}
-q '.node_id'` (other kinds: pass `--help` to the command below).

```sh
# source repo / vendored-node profile:
node scripts/minimize-superseded-markers.mjs \
  --subject-ids "<id1>,<id2>,..." \
  --classifier OUTDATED \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" \
  --apply
# package-manager / ephemeral-npx / user-global profile, resolve the
# command name from
# docs/idd-helper-scripts.md:
<profile-selected-minimize-superseded-markers-command> \
  --subject-ids "<id1>,<id2>,..." \
  --classifier OUTDATED \
  --trusted-marker-logins "<trusted-login-1>,<trusted-login-2>" \
  --apply
```

## F2

F2's **Advisory convergence** bullet (see
[pre-merge](../.github/instructions/idd-pre-merge.instructions.md))
has two halves. Helper-first stays first: when a helper runtime
exists, run `advisory-convergence.mjs --assert` (or the
profile-selected command) and read
`pre-merge-readiness` `dispositionEvidence`. Use this section only on
`instructions-only`, or when those helpers are unavailable.

**Convergence assertion — semantics.** `converged` is the three
conjuncts from
[Advisory convergence (F2)](idd-helper-scripts.md#advisory-convergence-f2),
restated verbatim: the latest primary-bot review's `commit_id` equals
the current HEAD **and** that review carries zero actionable items
**and** every current-HEAD primary-bot-authored review thread is
resolved **or** carries a valid disposition marker. Do not add or
relax a conjunct. Treat a missing review, an unreadable
`commit_id`/`HEAD`, or an unreadable item count as not converged.

**`dispositionEvidence` half — semantics.** Derive the same
conclusion F2 names in prose: `route` is `proceed` only when
`blockingCount == 0`, meaning both `missingRegularComments` (any
outstanding non-thread regular PR comment from a non-agent author,
including the PR author and advisory bots, lacking a fresh disposition
marker) and `missingThreads` (any review thread, resolved or unresolved,
still lacking one, except a human-origin thread with no IDD-originated
reply, which is presence-only) are empty. A missing or malformed result is
unmet. The ack-only override stays in the instruction file; do not
re-derive it here.

The advisory-bot set that decides thread origin is the known review bots,
plus the `advisoryBotLogins` read from `.github/idd/config.json`, plus any
`IDD_ADVISORY_BOT_LOGINS` (comma-separated). The block reads the config
itself, so export the variable only for bots the config does not list. A
Bot-typed originating author also counts as advisory, so an unlisted bot
fails closed. The review-reply stamp that marks an IDD reply uses
`IDD_MARKER_PREFIX` (default `idd-skill`, the canonical marker prefix).
`IDD_AGENT_LOGINS` and `IDD_TRUSTED_MARKER_ACTORS` are read the same way.

```sh
OWNER=$(gh repo view --json owner --jq '.owner.login')
REPO=$(gh repo view --json name --jq '.name')
PR_HEAD_SHA=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')

# Latest primary-bot review (same login set as AW1). Capture all pages before
# interpreting them: an empty pipe or a failed later page is not an empty
# review list (observed 2026-10-23 in #4638).
REVIEWS_RAW=$(gh api "repos/$OWNER/$REPO/pulls/{pr-number}/reviews" --paginate) || {
  echo "F2 review list read failed; not converged (observed 2026-10-23 in #4638)" >&2
  exit 2
}
[ -n "$REVIEWS_RAW" ] || {
  echo "F2 review list read empty; not converged (observed 2026-10-23 in #4638)" >&2
  exit 2
}
  printf '%s' "$REVIEWS_RAW" | jq -e -s '
    def parsed_review_timestamp:
      .submitted_at
      | (capture("^(?<whole>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})([.](?<fraction>[0-9]+))?(?<zone>Z|[+-][0-9]{2}:[0-9]{2})$") // null);
    def review_time_key($fraction_width):
      parsed_review_timestamp as $timestamp
      | (($timestamp.whole + "Z") | fromdateiso8601) as $whole_seconds
      | if ($whole_seconds | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ"))
          != ($timestamp.whole + "Z")
        then error("invalid timestamp")
        elif ($timestamp.zone != "Z"
          and ((($timestamp.zone[1:3] | tonumber) > 23)
            or (($timestamp.zone[4:6] | tonumber) > 59)))
        then error("invalid timezone offset")
        else
          ($timestamp.fraction // "") as $fraction
          | [
              ($whole_seconds
                - (if $timestamp.zone == "Z" then 0
                   else
                     (if $timestamp.zone[0:1] == "+" then 1 else -1 end)
                     * (($timestamp.zone[1:3] | tonumber) * 3600
                       + ($timestamp.zone[4:6] | tonumber) * 60)
                   end)),
              (reduce range(($fraction | length); $fraction_width) as $_
                ($fraction; . + "0"))
            ]
        end;
  length > 0
  and all(.[]; type == "array")
  and all(add[];
    type == "object"
      and has("user")
      and (
        .user == null
        or (
          (.user | type == "object")
          and (.user.login | type == "string")
        )
      )
    and (
        if .user == null then true
        elif .user.login == "copilot-pull-request-reviewer"
          or .user.login == "copilot-pull-request-reviewer[bot]"
      then
          (.submitted_at | type == "string")
          and (try (review_time_key(0) != null) catch false)
        and (.commit_id | type == "string")
        and (.commit_id | length > 0)
        and (.id | type == "number")
        and (.id > 0)
      else true end
    )
  )
' > /dev/null || {
  echo "F2 review list malformed; not converged (observed 2026-10-23 in #4638)" >&2
  exit 2
}
LATEST_REVIEW_JSON=$(
  printf '%s' "$REVIEWS_RAW" | jq -cs '
    def parsed_review_timestamp:
      .submitted_at
      | (capture("^(?<whole>[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})([.](?<fraction>[0-9]+))?(?<zone>Z|[+-][0-9]{2}:[0-9]{2})$") // null);
    def review_time_key($fraction_width):
      parsed_review_timestamp as $timestamp
      | (($timestamp.whole + "Z") | fromdateiso8601) as $whole_seconds
      | ($timestamp.fraction // "") as $fraction
      | [
          ($whole_seconds
            - (if $timestamp.zone == "Z" then 0
               else
                 (if $timestamp.zone[0:1] == "+" then 1 else -1 end)
                 * (($timestamp.zone[1:3] | tonumber) * 3600
                   + ($timestamp.zone[4:6] | tonumber) * 60)
               end)),
          (reduce range(($fraction | length); $fraction_width) as $_
            ($fraction; . + "0"))
        ];
    add
    | map(select(.user != null and (
        .user.login == "copilot-pull-request-reviewer"
        or .user.login == "copilot-pull-request-reviewer[bot]")))
      as $bot_reviews
    | ($bot_reviews
        | map(parsed_review_timestamp | (.fraction // "" | length))
        | max // 0) as $fraction_width
    | $bot_reviews
    | sort_by(review_time_key($fraction_width))
    | last // {}
  '
) || {
  echo "F2 review selection failed; not converged (observed 2026-10-23 in #4638)" >&2
  exit 2
}
LATEST_REVIEW_CID=$(printf '%s' "${LATEST_REVIEW_JSON}" | jq -r '.commit_id // ""')
LATEST_REVIEW_ID=$(printf '%s' "${LATEST_REVIEW_JSON}" | jq -r '.id // empty')

# Actionable items = posted review comments on that review.
if [ -n "${LATEST_REVIEW_ID}" ]; then
  REVIEW_COMMENTS_RAW=$(gh api "repos/$OWNER/$REPO/pulls/{pr-number}/reviews/$LATEST_REVIEW_ID/comments" --paginate) || {
    echo "F2 review-comment read failed; not converged (observed 2026-10-23 in #4638)" >&2
    exit 2
  }
  [ -n "$REVIEW_COMMENTS_RAW" ] || {
    echo "F2 review-comment read empty; not converged (observed 2026-10-23 in #4638)" >&2
    exit 2
  }
  printf '%s' "$REVIEW_COMMENTS_RAW" | jq -e -s '
    length > 0
    and all(.[]; type == "array")
    and all(add[];
      type == "object"
      and (.id | type == "number")
      and (.id > 0)
      and (.path | type == "string")
      and (.path | length > 0)
      and (.body | type == "string")
    )
  ' > /dev/null || {
    echo "F2 review-comment read malformed; not converged (observed 2026-10-23 in #4638)" >&2
    exit 2
  }
  ACTIONABLE_ITEM_COUNT=$(
    printf '%s' "$REVIEW_COMMENTS_RAW" | jq -cs 'add | length'
  ) || {
    echo "F2 review-comment count failed; not converged (observed 2026-10-23 in #4638)" >&2
    exit 2
  }
else
  ACTIONABLE_ITEM_COUNT=""
fi

CONJUNCT1=$([ "${LATEST_REVIEW_CID}" = "${PR_HEAD_SHA}" ] && echo true || echo false)
CONJUNCT2=$([ "${ACTIONABLE_ITEM_COUNT}" = "0" ] && echo true || echo false)

# Current-HEAD primary-bot threads: resolved OR a *fresh* **Accepted** /
# **Rejected** reply (after the latest non-disposition comment).
# Paginate until hasNextPage is false.
THREADS_JSON=$(gh api graphql --paginate -f query='
  query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) {
        reviewThreads(first:100, after:$endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            comments(first:100) {
              pageInfo { hasNextPage }
              nodes { author { login __typename } body createdAt updatedAt commit { oid } lastEditedAt }
            }
          }
        }
      }
    }
  }' -F owner="${OWNER}" -F repo="${REPO}" -F number={pr-number} \
  --jq '.data.repository.pullRequest.reviewThreads.nodes') || {
  echo "F2 review-thread read failed; not converged (#4696)" >&2
  exit 2
}
# An empty read is unmet too: a failed page must never read as "no threads".
[ -n "$THREADS_JSON" ] || {
  echo "F2 review-thread read empty; not converged (#4696)" >&2
  exit 2
}

# F2 accepts only IDD-agent / trusted-marker authors (same set the helper
# reuses as iddAgentLogins). Empty set fails closed.
CURRENT_MARKER_ACTOR=$(gh api user --jq '.login' 2>/dev/null || true)
IDD_AGENT_LOGIN_JSON=$(
  {
    printf '%s\n' "${IDD_AGENT_LOGINS:-}" | tr ',' '\n'
    printf '%s\n' "${IDD_TRUSTED_MARKER_ACTORS:-}" | tr ',' '\n'
    if [ -n "${CURRENT_MARKER_ACTOR}" ]; then
      printf '%s\n' "${CURRENT_MARKER_ACTOR}"
    fi
  } | sed '/^[[:space:]]*$/d' | sort -fu | jq -Rsc 'split("\n") | map(select(length > 0))'
)
# Regular comments use the narrower set (canonical deriveIddAgentLogins): only
# IDD_AGENT_LOGINS and the viewer. A trusted-marker actor that is not an agent
# clears no regular comment (fails closed); thread freshness still accepts it.
REG_AGENT_LOGIN_JSON=$(
  {
    printf '%s\n' "${IDD_AGENT_LOGINS:-}" | tr ',' '\n'
    if [ -n "${CURRENT_MARKER_ACTOR}" ]; then
      printf '%s\n' "${CURRENT_MARKER_ACTOR}"
    fi
  } | sed '/^[[:space:]]*$/d' | sort -fu | jq -Rsc 'split("\n") | map(select(length > 0))'
)

# Originating comment is nodes[0]. A truncated comments page is unmet.
# A disposition is fresh only when it is later than every non-disposition
# comment on the thread (same rule as hasFreshDisposition) and the
# author is an IDD agent / trusted marker actor.
CONJUNCT3=$(printf '%s' "${THREADS_JSON}" | jq -rs --arg sha "${PR_HEAD_SHA}" --argjson agents "${IDD_AGENT_LOGIN_JSON}" '
  def author_login: (.author.login // .user.login // "");
  def is_idd_agent:
    ((author_login | ascii_downcase) as $u
      | ($agents | map(ascii_downcase) | index($u)) != null);
  def is_disp:
    ((.body | startswith("**Accepted**") or startswith("**Rejected**")))
    and is_idd_agent
    and (has("lastEditedAt") and (.lastEditedAt == null));
  def latest_feedback:
    [.comments.nodes[] | select(is_disp | not) | .createdAt]
    | if length == 0 then null else max end;
  def has_fresh_disp:
    latest_feedback as $fb
    | .comments.nodes | any(is_disp and ($fb == null or .createdAt > $fb));
  add
  | map(select(
      (((.comments.nodes[0].author.login // "") | ascii_downcase) as $a
        | ["copilot", "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"]
        | index($a) != null)
      and (.comments.nodes | any((.commit.oid // "") == $sha))
    ))
  | all((.comments.pageInfo.hasNextPage | not)
      and (.isResolved or has_fresh_disp))
')

CONVERGED=$([ "${CONJUNCT1}" = true ] && [ "${CONJUNCT2}" = true ] && [ "${CONJUNCT3}" = true ] && echo true || echo false)

# dispositionEvidence: unedited IDD-agent **Accepted** / **Rejected** markers,
# 1:1 by count (E6), clear the non-agent regular comments (advisory bots
# included). Review threads need a fresh disposition unless presence-only.
# A failed or empty REST read stops here (#3860 review): `jq -s` over no input
# yields [], which would read as "no regular comments" and let F2 converge.
COMMENTS_RAW=$(gh api "repos/${OWNER}/${REPO}/issues/{pr-number}/comments" --paginate) || {
  echo "F2 regular-comment read failed; not converged (#3860)" >&2
  exit 2
}
[ -n "$COMMENTS_RAW" ] || {
  echo "F2 regular-comment read empty; not converged (#3860)" >&2
  exit 2
}
printf '%s' "$COMMENTS_RAW" | jq -e -s 'length > 0 and all(.[]; type == "array")' > /dev/null || {
  echo "F2 regular-comment read malformed; not converged (#3860)" >&2
  exit 2
}
COMMENTS_JSON=$(printf '%s' "$COMMENTS_RAW" | jq -s 'add // []') || exit 2
# Edit state for the same comments (#3860): REST rows carry no
# lastEditedAt, so join the GraphQL value by databaseId = REST id. An
# unmatched row is "unresolved", and only an explicitly unedited disposition
# clears the comment it answers.
EDIT_STATE_RAW=$(
  gh api graphql --paginate -f query='
    query($owner:String!, $repo:String!, $number:Int!, $endCursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$number) {
          comments(first:100, after:$endCursor) {
            pageInfo { hasNextPage endCursor }
            nodes { databaseId lastEditedAt }
          }
        }
      }
    }' -F owner="${OWNER}" -F repo="${REPO}" -F number={pr-number} \
    --jq '.data.repository.pullRequest.comments.nodes[]'
) || {
  echo "F2 edit-state read failed; not converged (#3860)" >&2
  exit 2
}
# A node that lacks either field is left out of the map, so its comment stays
# "unresolved" and never reads as an explicit null (#3860 review).
EDIT_STATE_JSON=$(printf '%s\n' "${EDIT_STATE_RAW}" \
  | jq -s 'map(select(has("databaseId") and has("lastEditedAt")) | {key: (.databaseId | tostring), value: .lastEditedAt}) | from_entries') || exit 2
COMMENTS_JSON=$(
  printf '%s' "${COMMENTS_JSON}" | jq --argjson edit "${EDIT_STATE_JSON}" '
    map(. + {lastEditedAt: ((.id | tostring) as $k
      | if ($edit | has($k)) then $edit[$k] else "unresolved" end)})
  '
) || exit 2
DISPOSITION_JSON=$(printf '%s' "${COMMENTS_JSON}" | jq -c --argjson agents "${REG_AGENT_LOGIN_JSON}" '
  # A pending-decision marker counts only outside code and comments, and only
  # where the canonical hasPendingDecisionMarker run model reads it as top
  # level: fenced blocks, inline code, and HTML comments are removed first, then
  # a line walk runs. A blank line, an empty quote line, a heading, a thematic
  # break, or an HTML block start ends a block-quote or list run, and a line that
  # opens one starts a run, so a marker inside a run is lazy text. HTML blocks are
  # not masked, so a marker inside one still counts here (fail-closed).
  def strip_all($re):
    if test($re) then sub($re; "\n\n") | strip_all($re) else . end;
  def mask_html_comments:
    # Keep line breaks and columns so comments cannot change Markdown block context.
    gsub("(?<comment>(?s:<!--.*?-->))"; "\(.comment | gsub("[^\n]"; " "))");
  def mask_inline_code:
    # Match equal-length backtick runs within one paragraph and keep their columns.
    gsub("(?<code>(?<!\\x60)(?<ticks>\\x60+)(?!\\x60)(?:(?!(?<!\\x60)\\k<ticks>(?!\\x60))(?!(?:\\r?\\n)[ \\t\\r]*(?:\\r?\\n))[\\s\\S])*?(?<!\\x60)\\k<ticks>(?!\\x60))"; "\(.code | gsub("[^\n]"; " "))");
  def html_start_re: "^ {0,3}(?:<!--|<\\?|<![A-Z]|<!\\[CDATA\\[|<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]|\\/?>|$))";
  def interrupts_paragraph:
    test("^ {0,3}#{1,6}([ \\t]|$)")
    or test("^ {0,3}([-_*])([ \\t]*\\1){2,}[ \\t]*$")
    or test(html_start_re; "i");
  def mask_interrupting_lines:
    split("\n")
    | map(if interrupts_paragraph then gsub("."; " ") else . end)
    | join("\n");
  def pending_marker:
    (.body | strip_all("(?ms)^ {0,3}(\\x60{3,})(?=[^\\x60\\n]*$).*?(?:^ {0,3}\\1\\x60*[ \\t\\r]*$|\\z)") | strip_all("(?ms)^ {0,3}(~{3,}).*?(?:^ {0,3}\\1~*[ \\t\\r]*$|\\z)") | mask_html_comments | mask_interrupting_lines | mask_inline_code
      | split("\n")
      | reduce .[] as $l ({run: false, hit: false};
          if .hit then .
          elif ($l | test("^\\s*$")) or ($l | test("^ {0,3}>[ \\t>]*$")) or ($l | test("^ {0,3}#{1,6}([ \\t]|$)")) or ($l | test("^ {0,3}([-_*])([ \\t]*\\1){2,}[ \\t]*$")) or ($l | test(html_start_re; "i"))
            then .run = false
          elif (.run | not) and ($l | test("^\\*\\*Awaiting maintainer decision\\*\\*"; "i")) then .hit = true
          elif ($l | test("^ {0,3}(>|[-+*][ \\t]|[0-9]{1,9}[.)][ \\t])")) then .run = true
          else . end)
      | .hit);
  map(select(
    (.body | test("^\\*\\*(Accepted|Rejected)[.!:]?\\*\\*"))
    and (((.user.login // "") | ascii_downcase) as $u
      | ($agents | map(ascii_downcase) | index($u)) != null)
    and (has("lastEditedAt") and (.lastEditedAt == null))
    and (pending_marker | not)
  ))
') || exit 2
# Advisory-bot identity for thread origin (canonical isGateAdvisoryBotLogin):
# the known review bots plus IDD_ADVISORY_BOT_LOGINS (comma-separated
# advisoryBotLogins, optional). `[bot]` is stripped on both sides, and every
# Copilot spelling reads as `copilot`, the same set AW1 uses.
# Configured advisoryBotLogins come from the repository config as well as the
# environment (the helper reads both), so a config-only bot is advisory here too.
CONFIG_ADVISORY_LOGINS=""
if [ -f .github/idd/config.json ]; then
  CONFIG_ADVISORY_LOGINS=$(jq -r '(.advisoryBotLogins // [])[]' .github/idd/config.json) || exit 2
fi
ADVISORY_TOKEN_JSON=$(
  { printf '%s\n' "${IDD_ADVISORY_BOT_LOGINS:-}" | tr ',' '\n'; printf '%s\n' "${CONFIG_ADVISORY_LOGINS}"; } | jq -Rsc '
    split("\n")
    | map(ascii_downcase | sub("^\\s+"; "") | sub("\\s+$"; "")
        | if endswith("[bot]") then .[0:(length - 5)] else . end)
    | ["copilot", "copilot-pull-request-reviewer", "coderabbitai", "chatgpt-codex-connector"] + .
    | map(if . == "copilot-pull-request-reviewer" then "copilot" else . end)
    | map(select(length > 0))
    | unique
  '
) || exit 2
# Regular comments (canonical summarizeRegularCommentsForGate): every comment
# from a non-IDD-agent author is outstanding, advisory bots included, except
# the operational comments that are never feedback: the GitHub Actions waiver
# and cleanup evidence, and the PR operational markers a trusted login posts
# (the IDD agent set is narrower for disposition pairing, so the operational
# exclusion uses the wider trusted set).
# Activity is the later of created_at and updated_at, so an edit after a
# disposition reopens the comment. Each comment consumes at most one later
# unedited disposition (1:1, E6). A Codex no-find result is cleared only by a
# disposition that names its source comment; other comments skip those
# source-bound dispositions.
MISSING_REGULAR=$(printf '%s\n' "${COMMENTS_JSON}" "${DISPOSITION_JSON}" | jq -s --argjson agents "${REG_AGENT_LOGIN_JSON}" --argjson trusted "${IDD_AGENT_LOGIN_JSON}" --arg sha "${PR_HEAD_SHA}" '
  def activity: [.created_at, (.updated_at // "")] | max;
  # The reviewed commit of a terminal Codex no-find result (exact opening line,
  # reviewed-commit line, and the About Codex details block), or "" when the
  # comment is not one. Older-HEAD results are not current: they clear like any
  # other comment (canonical), so only a current-HEAD result needs its source.
  # The :rocket: opening is valid only with the receipt marker (canonical
  # CODEX_NO_FIND_RESULT_RE). The trailing details block must match the
  # canonical About Codex block (CODEX_NO_FIND_DETAILS_RE) in full.
  def codex_no_find_reviewed:
    if ((.user.login // "") | ascii_downcase | test("^chatgpt-codex-connector(\\[bot\\])?$"))
    then ((.body | sub("^\\s+"; "") | capture("^(?:<!-- codex-review-receipt:v1 -->\\s*Codex Review: Didn\\x27t find any major issues\\. :rocket:|Codex Review: Didn\\x27t find any major issues\\. (?:You\\x27re on a roll\\.|What shall we delve into next\\?|:\\+1:))\\s*\\n+\\s*\\*\\*Reviewed commit:\\*\\*\\s*`(?<r>[0-9a-f]{7,64})`\\s*\\n+\\s*(?<d>[\\s\\S]*)$"; "i")) // null) as $m
         | if ($m != null) and ($m.d | test("^\\s*<details>\\s*<summary>\\x{2139}\\x{FE0F} About Codex in GitHub</summary>\\s*<br/>\\s*\\[Your team has set up Codex to review pull requests in this repo\\]\\(https://chatgpt\\.com/codex/cloud/settings/general\\)\\.?\\s*Reviews are triggered when you\\s*- Open a pull request for review\\s*- Mark a draft as ready\\s*- Comment \\x22@codex review\\x22(?: or \\x22@codex security review\\x22)?\\.\\s*(?:If Codex has suggestions, it will comment; otherwise it will react with \\x{1F44D}\\.\\s*)?(?:Codex can also answer questions or update the PR\\. Try commenting \\x22@codex address that feedback\\x22\\.\\s*)?</details>\\s*$"; "i"))
           then $m.r else "" end
    else "" end;
  def is_codex_no_find_current:
    (codex_no_find_reviewed) as $r
    | ($r != "") and ($sha | ascii_downcase | startswith($r | ascii_downcase));
  def is_actions_operational:
    (((.user.login // "") | ascii_downcase) == "github-actions[bot]")
    and ((.body | sub("^\\s+"; "")) as $b
      | ($b | startswith("<!-- idd-cleanup-evidence:")
          or startswith("<!-- idd-external-check-waiver:")));
  # Trusted operational comments (canonical classifyIddPrComment, trusted branch):
  # a comment from a trusted login (IDD agents and trusted marker actors) whose
  # body starts with a PR operational marker, whose first line is a live-status
  # digest marker, or that starts with the cleanup-evidence marker. A github-actions
  # author never takes this branch (canonical else-if). forced-handoff is left out
  # on purpose: the canonical check also validates it, so a malformed one stays
  # outstanding here (fail-closed).
  def is_trusted_operational:
    ((.user.login // "") | ascii_downcase) as $u
    | (($u | sub("\\[bot\\]$"; "")) != "github-actions")
      and (($trusted | map(ascii_downcase) | index($u)) != null)
      and (((.body | sub("^\\s+"; "")) as $b
          | $b | (test("^<!--\\s*(claimed-by|unclaimed-by|review-watermark|review-baseline|zero-accepted-path-a-gate|idd-external-check-waiver|idd-local-validation-evidence):"; "i")
              or test("^<!--\\s*advisory-wait:")
              or test("^(advisory-wait:|advisory-wait-recovery:|advisory-reroll:|review-ack:|copilot-unavailable:)")
              or startswith("<!-- idd-cleanup-evidence:")))
        or ((.body | sub("^﻿"; "") | (split("\n") | .[0]) | sub("\\r$"; "") | sub("\\s+$"; ""))
            | IN("<!-- idd-live-status: current -->", "<!-- idd-live-status: historical -->", "<!-- idd-live-status-repair: v1 -->")));
  # Source-bound Codex clearance (canonical CODEX_NO_FIND_DISPOSITION_RE and the
  # sticky matcher): an accepted disposition that names the source
  # id and login, and whose abbreviated HEAD prefixes the current PR HEAD.
  # (No apostrophes in jq comments: the program sits inside a single-quoted shell string.)
  # The disposition must match the canonical sentence exactly, the source id and
  # login must belong to this comment, the disposition HEAD must prefix the
  # current HEAD, and this comment must itself be a current-HEAD no-find (its
  # reviewed commit prefixes the current HEAD).
  # Only the exact canonical source-bound disposition sentence leaves the generic
  # pairing pool (canonical CODEX_NO_FIND_DISPOSITION_RE); an ordinary reply that
  # merely mentions the phrase does not.
  def is_codex_disposition_shape:
    (.body | sub("^\\s+"; "") | test("^\\*\\*Accepted[.!:]?\\*\\*\\s+—\\s+[^\\s]+\\s+no-find result at HEAD\\s+[0-9a-f]{7,64};\\s+no actionable findings were reported\\s+\\(source: #issuecomment-[0-9]+\\)(?:\\s*\\n<!--\\s*[a-z0-9][a-z0-9_-]*-review-reply\\s*-->)?\\s*$"; "i"));
  def is_codex_source_bound($src):
    ((.body | sub("^\\s+"; "") | capture("^\\*\\*Accepted[.!:]?\\*\\*\\s+—\\s+(?<login>[^\\s]+)\\s+no-find result at HEAD\\s+(?<h>[0-9a-f]{7,64});\\s+no actionable findings were reported\\s+\\(source: #issuecomment-(?<id>[0-9]+)\\)(?:\\s*\\n<!--\\s*[a-z0-9][a-z0-9_-]*-review-reply\\s*-->)?\\s*$"; "i")) // null) as $m
    | ($m != null)
      and ($m.id == ($src.id | tostring))
      and (($m.login | ascii_downcase | sub("\\[bot\\]$"; "")) == (($src.user.login // "") | ascii_downcase | sub("\\[bot\\]$"; "")))
      and ($sha | ascii_downcase | startswith($m.h | ascii_downcase))
      and ((((($src.body | capture("\\*\\*Reviewed commit:\\*\\*\\s*`(?<r>[0-9a-f]{7,64})`"; "i")) // {r: ""}) as $sr
        | ($sr.r != "") and ($sha | ascii_downcase | startswith($sr.r | ascii_downcase)))));
  .[0] as $comments | .[1] as $disp
  | ($comments
     | map(select(
         ((.user.login // "") | ascii_downcase) as $u
         | ($agents | map(ascii_downcase) | index($u)) == null
         and (is_actions_operational | not)
         and (is_trusted_operational | not)
       ))
     | map(. + {act: activity})
     | sort_by(.act)) as $out
  # Source-bound Codex sentences are matched after trimming (canonical trims the
  # source-bound reply), so an unedited agent reply of that exact shape joins the
  # pool even with leading whitespace. Generic replies never see it: the
  # generic branch below excludes that same trimmed shape.
  | ([$comments[] | select(
        ((((.user.login // "") | ascii_downcase) as $u | ($agents | map(ascii_downcase) | index($u)) != null))
        and (has("lastEditedAt") and (.lastEditedAt == null))
        and is_codex_disposition_shape)]) as $codex_trimmed
  | (($disp + $codex_trimmed) | unique_by(.id) | map(. + {act: activity}) | sort_by(.act)) as $ds
  | reduce $out[] as $c (
      {unused: $ds, missing: 0};
      ((.unused | to_entries
        | map(select(.value.act > $c.act
            and (if ($c | is_codex_no_find_current)
                 then (.value | is_codex_source_bound($c))
                 else (.value | is_codex_disposition_shape | not)
                 end)))
        | first) as $hit
      | if $hit == null then .missing += 1
        else .unused |= del(.[$hit.key])
        end)
    )
  | .missing
') || exit 2
# Review threads (canonical summarizeDispositionEvidenceForGate, missingThreads).
# A thread is missing when it is truncated, or when it has neither a fresh
# disposition nor the presence-only exception. The originating comment (nodes[0])
# alone decides the origin, so a later bot reply never flips a human thread.
# presence_only: a human-origin thread with a later reply and no IDD-originated
# reply. is_idd_reply approximates canonical isIddOriginatedThreadReply: a
# review-reply stamp with the configured prefix (IDD_MARKER_PREFIX, default
# idd-skill) from any author, or an IDD-agent disposition, rejection
# confirmation, or pending decision. Feedback activity is the later of
# createdAt and lastEditedAt, so an edit after a disposition reopens the thread.
# The stamp prefix is IDD_MARKER_PREFIX, else the repository config's
# markerPrefix (the helper reads the same field), else the canonical default.
MARKER_PREFIX="${IDD_MARKER_PREFIX:-}"
if [ -z "${MARKER_PREFIX}" ] && [ -f .github/idd/config.json ]; then
  MARKER_PREFIX=$(jq -r '.markerPrefix // empty' .github/idd/config.json) || exit 2
fi
MARKER_PREFIX="${MARKER_PREFIX:-idd-skill}"
# The prefix is spliced into a jq regex, so only marker-safe characters pass.
case "${MARKER_PREFIX}" in
  *[!A-Za-z0-9_-]*|"") echo "IDD_MARKER_PREFIX must be letters, digits, '_' or '-'; not converged" >&2; exit 2 ;;
esac
MISSING_THREADS=$(printf '%s' "${THREADS_JSON}" | jq -rs --argjson agents "${IDD_AGENT_LOGIN_JSON}" --argjson advisory "${ADVISORY_TOKEN_JSON}" --arg prefix "${MARKER_PREFIX}" '
  def author_login: (.author.login // .user.login // "");
  def advisory_token:
    (ascii_downcase
      | if endswith("[bot]") then .[0:(length - 5)] else . end
      | if . == "copilot-pull-request-reviewer" then "copilot" else . end);
  def is_idd_agent:
    ((author_login | ascii_downcase) as $u
      | ($agents | map(ascii_downcase) | index($u)) != null);
  # Code-aware pending-decision marker (see DISPOSITION_JSON above).
  def strip_all($re):
    if test($re) then sub($re; "\n\n") | strip_all($re) else . end;
  def mask_html_comments:
    # Keep line breaks and columns so comments cannot change Markdown block context.
    gsub("(?<comment>(?s:<!--.*?-->))"; "\(.comment | gsub("[^\n]"; " "))");
  def mask_inline_code:
    # Match equal-length backtick runs within one paragraph and keep their columns.
    gsub("(?<code>(?<!\\x60)(?<ticks>\\x60+)(?!\\x60)(?:(?!(?<!\\x60)\\k<ticks>(?!\\x60))(?!(?:\\r?\\n)[ \\t\\r]*(?:\\r?\\n))[\\s\\S])*?(?<!\\x60)\\k<ticks>(?!\\x60))"; "\(.code | gsub("[^\n]"; " "))");
  def html_start_re: "^ {0,3}(?:<!--|<\\?|<![A-Z]|<!\\[CDATA\\[|<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|pre|script|search|section|source|style|summary|table|tbody|td|textarea|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]|\\/?>|$))";
  def interrupts_paragraph:
    test("^ {0,3}#{1,6}([ \\t]|$)")
    or test("^ {0,3}([-_*])([ \\t]*\\1){2,}[ \\t]*$")
    or test(html_start_re; "i");
  def mask_interrupting_lines:
    split("\n")
    | map(if interrupts_paragraph then gsub("."; " ") else . end)
    | join("\n");
  def pending_marker:
    (.body | strip_all("(?ms)^ {0,3}(\\x60{3,})(?=[^\\x60\\n]*$).*?(?:^ {0,3}\\1\\x60*[ \\t\\r]*$|\\z)") | strip_all("(?ms)^ {0,3}(~{3,})(?=[^~\\n]*$).*?(?:^ {0,3}\\1~*[ \\t\\r]*$|\\z)") | mask_html_comments | mask_interrupting_lines | mask_inline_code
      | split("\n")
      | reduce .[] as $l ({run: false, hit: false};
          if .hit then .
          elif ($l | test("^\\s*$")) or ($l | test("^ {0,3}>[ \\t>]*$")) or ($l | test("^ {0,3}#{1,6}([ \\t]|$)")) or ($l | test("^ {0,3}([-_*])([ \\t]*\\1){2,}[ \\t]*$")) or ($l | test(html_start_re; "i"))
            then .run = false
          elif (.run | not) and ($l | test("^\\*\\*Awaiting maintainer decision\\*\\*"; "i")) then .hit = true
          elif ($l | test("^ {0,3}(>|[-+*][ \\t]|[0-9]{1,9}[.)][ \\t])")) then .run = true
          else . end)
      | .hit);
  def is_disp:
    (.body | test("^\\*\\*(Accepted|Rejected)[.!:]?\\*\\*"))
    and is_idd_agent
    and (has("lastEditedAt") and (.lastEditedAt == null))
    and (pending_marker | not);
  def is_idd_reply:
    (.body | test("<!--\\s*" + $prefix + "-review-reply\\s*-->"; "i"))
    or (is_idd_agent
      and (pending_marker
        or (.body | (test("^\\*\\*(Accepted|Rejected)[.!:]?\\*\\*")
          or test("^\\s*\\*\\*Rejection confirmed by maintainer\\*\\*\\s+—")))));
  # A rejection confirmation settles a thread only once the thread is resolved
  # (canonical hasFreshDisposition with isRejectionConfirmedDisposition).
  def is_rejection_confirmed:
    (.body | test("^\\s*\\*\\*Rejection confirmed by maintainer\\*\\*\\s+—"))
    and is_idd_agent
    and (has("lastEditedAt") and (.lastEditedAt == null))
    and (pending_marker | not);
  def counts_as_disp($res):
    is_disp or ($res and is_rejection_confirmed);
  def activity_at:
    if has("lastEditedAt") and .lastEditedAt == null
    then (.createdAt // .updatedAt // "")
    else (.updatedAt // .createdAt // "") end;
  def latest_feedback($res):
    [.comments.nodes[] | select(counts_as_disp($res) | not) | activity_at]
    | if length == 0 then null else max end;
  def has_fresh_disp:
    (.isResolved // false) as $res
    | latest_feedback($res) as $fb
    | .comments.nodes | any(counts_as_disp($res) and ($fb == null or .createdAt > $fb));
  # A Bot-typed originating author is advisory even when no list names it. That
  # fails closed for an unconfigured bot (canonical would call it human).
  def is_advisory_origin:
    (((.comments.nodes[0].author.login // "") | advisory_token) as $t
      | ($advisory | index($t)) != null)
    or ((.comments.nodes[0].author.__typename // "") == "Bot");
  def presence_only:
    (is_advisory_origin | not)
    and ((.comments.nodes | length) > 1)
    and ([.comments.nodes[1:][] | select(is_idd_reply)] | length == 0);
  add
  | map(select(
      .comments.pageInfo.hasNextPage
      or ((has_fresh_disp | not) and (presence_only | not))
    ))
  | length
') || exit 2

echo "converged=${CONVERGED} conjuncts=${CONJUNCT1},${CONJUNCT2},${CONJUNCT3}"
echo "missingRegularComments=${MISSING_REGULAR} missingThreads=${MISSING_THREADS}"
# proceed iff CONVERGED is true AND both missing counts are 0.
```
