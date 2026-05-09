# IDD Comment Minimization

<!-- cspell:words AAAAB Unminimize Wpaqs unminimized -->

This note defines the safe path for hiding completed IDD review feedback
and stale operational marker comments after a pull request has merged.

Minimization is UI cleanup. It preserves the audit trail and must never
replace review triage, conversation resolution, CI, advisory wait, or
merge gates.

## Timing

Run minimization only after one of these is true:

- the PR has already merged
- a maintainer explicitly starts a merged-PR audit

Do not minimize comments during active E or F gates. In particular, do
not minimize comments that still determine review currency, advisory
wait state, unresolved-thread state, unreplied-comment state, hold
state, or a pending maintainer decision.

## GitHub mechanism

GitHub GraphQL exposes `minimizeComment`:

```graphql
mutation($id: ID!, $classifier: ReportedContentClassifiers!) {
  minimizeComment(input: { subjectId: $id, classifier: $classifier }) {
    minimizedComment {
      __typename
      ... on IssueComment {
        id
        url
        isMinimized
        minimizedReason
        viewerCanUnminimize
      }
      ... on PullRequestReview {
        id
        url
        isMinimized
        minimizedReason
        viewerCanUnminimize
      }
      ... on PullRequestReviewComment {
        id
        url
        isMinimized
        minimizedReason
        viewerCanUnminimize
      }
    }
  }
}
```

The mutation requires a node ID and a `ReportedContentClassifiers`
value. The relevant classifiers are:

- `RESOLVED` for completed feedback or review parent comments
- `OUTDATED` for stale IDD operational markers

Schema checks on 2026-05-09 confirmed that `IssueComment`,
`PullRequestReview`, and `PullRequestReviewComment` expose
`isMinimized`, `minimizedReason`, `viewerCanMinimize`, and
`viewerCanUnminimize`. The `gh pr` command group did not expose a
first-class minimize/hide command, so the portable path is
`gh api graphql`.

## Candidate Rules

Feedback or review parent comments may be minimized as `RESOLVED` only
when all of these are true:

- the PR is merged or the cleanup is part of an explicit merged-PR audit
- every actionable child review comment or thread under that parent has
  been accepted or rejected under IDD rules
- required replies have been posted
- all child threads are resolved
- the reviewer has no active `CHANGES_REQUESTED` state that still gates
  the PR

IDD operational marker comments may be minimized as `OUTDATED` only when
the PR is merged and the marker is no longer needed for resume, advisory
wait, or review-currency checks. Candidate prefixes are:

- `<!-- review-watermark:`
- `<!-- review-baseline:`
- `advisory-wait:`
- `advisory-wait-recovery:`
- `<!-- advisory-wait:`

Always skip candidates when any of these are true:

- `viewerCanMinimize=false`
- `isMinimized=true`
- the comment contains an active hold or
  `**Awaiting maintainer decision**`
- the comment contains failed-CI or reviewer context still needed by
  maintainers
- the comment is non-operational human discussion
- the comment still participates in an active F2 or F3 gate

## Dry Run Shape

Before applying minimization, produce a candidate table with at least
these fields:

| Field               | Purpose                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `subjectId`         | GraphQL node ID passed to `minimizeComment`                        |
| `url`               | Direct audit link                                                  |
| `type`              | `IssueComment`, `PullRequestReview`, or `PullRequestReviewComment` |
| `classifier`        | `RESOLVED` or `OUTDATED`                                           |
| `viewerCanMinimize` | Must be `true`                                                     |
| `isMinimized`       | Must be `false`                                                    |
| `reason`            | Why the candidate is safe                                          |

Example capability check for one node ID:

```sh
gh api graphql \
  -f query='query($id:ID!){
    node(id:$id){
      __typename
      ... on IssueComment{id url isMinimized minimizedReason viewerCanMinimize}
      ... on PullRequestReview{id url isMinimized minimizedReason viewerCanMinimize}
      ... on PullRequestReviewComment{id url isMinimized minimizedReason viewerCanMinimize}
    }
  }' \
  -f id="$SUBJECT_ID"
```

Call `minimizeComment` only after the dry run shows
`viewerCanMinimize=true` and `isMinimized=false`.

Example mutation call:

```sh
gh api graphql \
  -f query='mutation($id:ID!,$classifier:ReportedContentClassifiers!){
    minimizeComment(input:{subjectId:$id,classifier:$classifier}){
      minimizedComment{
        __typename
        ... on IssueComment{id url isMinimized minimizedReason viewerCanUnminimize}
        ... on PullRequestReview{id url isMinimized minimizedReason viewerCanUnminimize}
        ... on PullRequestReviewComment{id url isMinimized minimizedReason viewerCanUnminimize}
      }
    }
  }' \
  -f id="$SUBJECT_ID" \
  -f classifier="$CLASSIFIER"
```

## Experiment

Experiment date: 2026-05-09.

Target: merged PR
[#78](https://github.com/kurone-kito/idd-skill/pull/78), merged at
2026-05-09T05:36:33Z.

Dry-run selection:

| Subject                     | Type                | Classifier | Reason                                                        |
| --------------------------- | ------------------- | ---------- | ------------------------------------------------------------- |
| `IC_kwDOSWpaqs8AAAABBvMrqA` | `IssueComment`      | `OUTDATED` | `review-watermark` marker on merged PR #78                    |
| `IC_kwDOSWpaqs8AAAABBvM34w` | `IssueComment`      | `OUTDATED` | `review-baseline` marker on merged PR #78                     |
| `IC_kwDOSWpaqs8AAAABBvNZCw` | `IssueComment`      | `OUTDATED` | `advisory-wait` marker on merged PR #78                       |
| `PRR_kwDOSWpaqs79uxOa`      | `PullRequestReview` | `RESOLVED` | CodeRabbit parent review body whose child thread was resolved |

All four dry-run candidates had `viewerCanMinimize=true` and
`isMinimized=false`.

Applied results:

| Subject                     | URL                                                                             | API result                                                                 |
| --------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `IC_kwDOSWpaqs8AAAABBvMrqA` | <https://github.com/kurone-kito/idd-skill/pull/78#issuecomment-4411567016>      | `isMinimized=true`, `minimizedReason=outdated`, `viewerCanUnminimize=true` |
| `IC_kwDOSWpaqs8AAAABBvM34w` | <https://github.com/kurone-kito/idd-skill/pull/78#issuecomment-4411570147>      | `isMinimized=true`, `minimizedReason=outdated`, `viewerCanUnminimize=true` |
| `IC_kwDOSWpaqs8AAAABBvNZCw` | <https://github.com/kurone-kito/idd-skill/pull/78#issuecomment-4411578635>      | `isMinimized=true`, `minimizedReason=outdated`, `viewerCanUnminimize=true` |
| `PRR_kwDOSWpaqs79uxOa`      | <https://github.com/kurone-kito/idd-skill/pull/78#pullrequestreview-4256895898> | `isMinimized=true`, `minimizedReason=resolved`, `viewerCanUnminimize=true` |

Skipped examples:

- active or non-operational human discussion
- CodeRabbit walkthrough comments that were informational rather than
  stale IDD markers
- accepted/rejected disposition comments, because they are part of the
  review audit trail
- child review comments, because the experiment only needed to prove
  parent review body and operational marker behavior

The API observation confirms that minimized comments remain addressable
by URL and can be unminimized by a viewer with permission.

Public GitHub UI observation for PR #78 showed minimized operational
comments collapsed behind a minimized-comment placeholder and the
resolved feedback area marked as resolved. The underlying comment URLs
remained addressable.
