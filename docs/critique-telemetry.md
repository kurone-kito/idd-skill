---
type: reference
title: Critique-Loop Telemetry Methodology
description: Documents how this repository harvests and aggregates its own C-phase critique-loop telemetry.
tags: [critique-loop, dogfood, measurement]
---

# Critique-Loop Telemetry Methodology

This page is dogfood-only: it is not distributed to adopter
repositories. It documents how `kurone-kito/idd-skill` harvests and
aggregates the per-round critique-loop telemetry its own IDD loop can
optionally emit, mirroring [`docs/token-cost.md`](token-cost.md)'s own
harvest → snapshot → `--check` shape for a structurally similar,
but much simpler, measurement.

## Scope

- **Unit of measurement**: one C-phase critique round (one hook
  invocation), not a whole issue loop.
- **Source**: `docs/idd-workflow.md`'s
  ["Repository-configurable critique telemetry hook"](idd-workflow.md#repository-configurable-critique-telemetry-hook)
  section documents the JSON payload a configured
  `critiqueLoop.telemetryHook.command` receives on stdin once per
  C-phase round. The `kurone-kito/dotfiles`-defined
  `idd-critique-telemetry` consumer appends that payload as one JSONL
  line to
  `${XDG_STATE_HOME:-$HOME/.local/state}/idd-critique/log.jsonl` — a
  per-host, uncommitted artifact this repository's own tooling never
  reads directly from git.
- **Privacy**: only the documented payload fields (phase, round, repo,
  issue, PR number, coarse counts, a delegate command name, and a
  timestamp) ever enter the harvested samples file or the committed
  snapshot below. No prompts, findings text, or file paths are ever
  recorded.
- **Success/outcome**: unlike `docs/token-cost.md`'s per-issue-loop
  `merged`/`aborted`/... outcome, this measurement has no per-round
  outcome dimension — every valid round is counted, since a
  zero-finding round is itself informative telemetry (a healthy, quiet
  loop), not a failure.

## How the snapshot is produced

```sh
node scripts/idd-critique-harvest.mjs --repo kurone-kito/idd-skill \
  [--in <log.jsonl> ...] [--out <samples.jsonl>] [--dry-run]
```

This reads the local `idd-critique` JSONL log(s) (default `--in`:
`${XDG_STATE_HOME:-$HOME/.local/state}/idd-critique/log.jsonl` — a
**host-wide**, not per-repository, path) and validates each line
against the documented payload contract. A line that fails to parse as
JSON, or whose required fields are missing or mistyped, is skipped and
counted — never fatal, so one bad line never loses the rest of the
log. A line missing only an optional field is not malformed: `pr`
normalizes to `null`, each of `severityBreakdown.high`/`.medium`/`.low`
normalizes to `0` when the whole field is absent, and `delegateCommand`
stays unset. `--repo` is required and keeps only records whose own
`repo` field matches it case-insensitively (`skippedOtherRepo` in the
printed counts) — the same scoping `token-cost-harvest.mjs` already
requires,
needed here because this operator's other repositories can share the
same host-wide log path. Every kept line is deduplicated by a content
hash of its own normalized record (not a `repo`+`issue`+`round`+
`timestamp` business key, which two genuinely different rounds could
coincidentally share under concurrent load — the incident this
project's own issue `#3002` B2 critique pass raised) and appended to
`--out`
(default:
`${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/idd-critique/samples.jsonl`),
so re-running the harvester against the same, possibly-grown log file
never double-counts a round already harvested.

**Known limitation.** Content-hash dedup cannot tell apart two
genuinely distinct hook invocations that happen to produce
byte-identical normalized content (for example, two concurrent
sessions on the same issue each emitting the same zero-finding round
at the same second) — one is discarded as though it were a
re-processed duplicate, undercounting real rounds. Fixing this
properly needs a producer-generated session or event identifier in the
hook payload itself, a change to the documented contract in
`docs/idd-workflow.md` and the `kurone-kito/dotfiles`-defined consumer,
both out of scope for this harvester, which only consumes that
contract as already documented (#3005 review round 5, Codex).

`node scripts/idd-critique-report.mjs`:

- `--in <samples.jsonl> [--in <samples.jsonl> ...] --apply` aggregates
  local samples into a fresh
  [`docs/idd-critique-snapshot.json`](idd-critique-snapshot.json) and
  refreshes this page's own table below.
- `--check` verifies the committed snapshot still matches this page's
  rendered region — it never re-harvests or reads raw samples, only the
  committed snapshot.
- `--apply` is also cwd-sensitive, the same way
  `token-cost-report.mjs` is: it refuses to run while the current
  branch is the repository's default branch, since a stray `--apply`
  left dirty on the shared primary worktree can block every concurrent
  session's next B1 `git merge --ff-only` worktree creation — the
  observed incident behind `token-cost-report.mjs`'s own guard
  (`#2452`). Pass `--allow-default-branch` for an intentional
  maintainer run from the primary worktree.

A snapshot is `publishable` only once it has at least 10 harvested
rounds. Below that gate, the table below stays on an unpublished
stub — no number is ever invented to fill the gap.

**Not yet wired into `pre-push-validate`.** Unlike
`token-cost-report.mjs --check`, `idd-critique-report.mjs --check` is
not (yet) part of this repository's `pre-push-validate` command chain:
wiring it would also touch `.github/idd/config.json`,
`audit/sync-manifest.json`, and the regenerated
`idd-overview-core.instructions.md` table together, which is
disproportionate churn for this page's own initial `n=0` state. This is
a deliberate, documented follow-up, not an oversight.

## Current snapshot

<!-- idd-critique-docs:start -->

Not yet publishable, n=0.

<!-- idd-critique-docs:end -->

## Copilot review-wave and severity audit

This is a separate, source-repo-only measurement from the harvest ->
snapshot pipeline above: it reads live GitHub data on demand
(`gh api`) rather than an accumulated local log, and has no committed
snapshot of its own. It exists because a change aimed at cutting
Copilot review cost has repeatedly shipped with no repeatable way to
check its effect: PR `#3046` (lowering `critiqueLoop.deferAfterRounds`
to `5`) merged with no acceptance criterion, and a later manual audit
(2026-09-21, 64 merged PRs) had to rebuild the numbers by hand before
concluding the cutoff had never fired; the 2026-09-24 baseline for the
adopt-now urgency-defer rule was again assembled from a throwaway
script.

### What it measures

```sh
node scripts/copilot-review-wave-audit.mjs --prs <n,n,...> [--format json|tsv]
node scripts/copilot-review-wave-audit.mjs --limit <N> [--format json|tsv]
node scripts/copilot-review-wave-audit.mjs --merged-from <YYYY-MM-DD> --merged-to <YYYY-MM-DD> [--format json|tsv]
```

Given a set of merged PRs, the helper fetches each PR's reviews and
review comments (`gh api repos/{owner}/{repo}/pulls/{n}/reviews` and
`.../comments`, both paginated) and computes:

- **Review count**, split into `ccr-overview-v2` (Copilot's current
  machine-readable overview format) versus legacy (no
  `<!-- ccr-overview-v2 -->` marker, no severity data available).
- **Open appearances**: the per-severity count of every "Open" listing
  across every v2 review — a finding carried forward into a later
  review's "Open" section is counted again each time it appears.
- **Unique finding threads**: one entry per distinct
  `#discussion_r<id>`, keyed by the _first_ severity seen for that id
  in submission order. This is deliberately a different number from
  "Open appearances" above: a thread carried across 3 reviews
  contributes 3 appearances but 1 thread.
- **Thread dispositions**: `deferred` (a `**Rejected**` reply
  containing "deferred to follow-up issue"), `rejected` (any other
  `**Rejected**` reply), `accepted` (`**Accepted**`), `other` (a
  recognized-but-non-accept/reject disposition — an
  `**Awaiting maintainer decision**` marker, or a
  `**Rejection confirmed by maintainer**` reply), or `none` (no reply
  at all, or replies exist but none are a recognized marker). When a
  thread has several recognized-disposition replies, the
  chronologically last one wins. This reuses
  `DISPOSITION_ACCEPTED_PREFIX_RE`/`DISPOSITION_REJECTED_PREFIX_RE`/
  `AMD_MARKER_PATTERN` from `protocol-helpers.mts` — the same loose,
  no-em-dash-required marker shape `isDispositionComment` uses, which
  is what the merge gate actually credits as "a disposition was
  posted" — rather than `review-disposition-verify.mts`'s
  `classifyMarker()`, whose `MARKER_ACCEPTED_RE`/`MARKER_REJECTED_RE`
  additionally require a trailing em dash. This audit's purpose is
  fidelity to what the gate credits, so the looser patterns are the
  deliberate choice.
- **"Previously missed" findings**: counted per severity, separately
  from every metric above. These are findings Copilot lists as newly
  noticed in code that hasn't changed since the last review; they
  carry a severity but no `#discussion_r<id>` link, so they have no
  thread to key by.
- **Transition table**: per v2 review, keyed by the highest "Open"
  severity in that review (`none` when Open is empty), split into
  "followed by another Copilot review" versus "last review".
- **Recorded triage** (`triage` in the JSON output): over the PR's
  accepted, deferred, and rejected threads, the count of replies that
  have a first Triage-like line that parses (`recorded`) versus those that
  do not (`unrecorded`). A reply's first Triage-like line is its opener: the
  case-insensitive word `Triage` followed by optional spaces or tabs and a
  colon, at the start of the line after any run of spaces, tabs, list bullets
  (`-`, `+`), and `*` marks, with an optional `*` or `**` right after the
  word. The emphasis marks need not pair up. So `Triage :`, `- Triage:`,
  `**Triage:**`, `*Triage*:`, and `*Triage:*` are openers. Underscore
  emphasis (`_Triage:_`) is not an opener, so a reply whose only Triage line
  is underscored counts as unrecorded and not malformed.
  `malformed` counts the unrecorded replies whose opener yields no record,
  even when a later line would parse. `byStep` counts the
  recorded lines by step (`0` to `2`), urgency, and outcome.
  `overrides` counts lines with an `override:` part. `contradictions`
  counts the recorded lines without an override where an accepted reply
  says `verdict defer`. Deferrals are not checked against their verdict,
  so a deferral whose text does not match the urgency matrix is not
  flagged. Threads with other or no dispositions are not counted.
  `mergedAt` is the PR's merge time under `--limit` or a merge window,
  and `null` under `--prs`.
- **Finding locality** (`findingLocality` in the JSON output): each
  Copilot inline finding (a review comment from the `Copilot` login with
  no reply link) is placed relative to the previous push. Findings on
  the first Copilot review count as `firstWave`. For a later review, the
  compare range from the previous review's commit to this review's commit
  is read. A finding is `nearPreviousPush` when its `original_line` is
  within 3 lines of a new-file line that the previous push added or
  removed, `sameFileElsewhere` when its file changed in that push but the
  finding is farther away, and `untouchedFile` when the previous push did
  not change that file. `unknown` covers a finding the rules cannot
  place: a `LEFT` side, a missing commit or patch, a failed compare
  lookup, or a compare response at GitHub's 300-file cap, which may hide
  a changed file.
- **Review triggers** (`triggers`, each review's `trigger`, and the raw
  REST review `commit_id` as `commitId` in JSON):
  the first Copilot review is `first`; subsequent reviews are `sameHead`
  when their commit IDs match, or are classified from the PR commits graph
  as `newHead` when the new reachable commits include a one-parent commit,
  or `mergeCommitHead` when every new reachable commit has at least two
  parents. Missing commit IDs, a failed or incomplete commits lookup, a
  review commit absent from the PR commits list, or an empty graph difference
  yields `unknown`. The helper makes at most one paginated commits request
  per PR and does not fetch commits individually.
- **Approval follow-up** (`approvals` in JSON): labels each review whose
  first matching ATX heading says `Approval recommended`, `Changes
  recommended`, or `Needs a closer look` with verdict `approval`, `changes`,
  or `closerLook`. It counts approvals and how many were followed by another
  Copilot review, including `nextTrigger` counts for `sameHead`, `newHead`,
  `mergeCommitHead`, and `unknown` (all keys are present when zero). `total`
  includes terminal approvals; `followed` includes only approvals with a
  later Copilot review. A missing heading or a legacy body has verdict
  `null`; headings inside Markdown code regions are ignored.
- **Generated and mirrored paths** (`findingPathClass` in JSON): counts each
  Copilot inline finding as `generatedHelper` for a top-level
  `scripts/*.mjs` or any `bin/**/*.mjs`, `syncMirror` for an exact/concreted
  target in the repository's current `audit/sync-manifest.json`, `other` for
  another named path, or `noPath` when GitHub supplied no path. The helper
  reads the manifest once before making GitHub requests and exits 2 if it
  cannot read or parse it.
- **What-changed listings** (`whatChanged` in each review and in the cohort
  summary): when a v2 or unparsed review has the exact
  `What changed in this PR` details heading and a Markdown table, JSON records
  its first-column paths plus the generated-helper and sync-mirror subsets.
  Cohort `tables` counts parsed tables; `listingGeneratedHelper` and
  `listingSyncMirror` count tables that list at least one path in that class.
  This table reports the reviewer's listing and is not a review signal.
- **Disposition by review count** (`dispositionsByReviewCount` in the cohort
  summary): counts each finding thread's final disposition in the PR review
  count buckets `1-2`, `3-4`, `5-9`, and `10+`, using the same five
  dispositions (`deferred`, `rejected`, `accepted`, `other`, and `none`) as
  `dispositionsBySeverity`.

`syncMirror` and `syncMirrorPaths` use the manifest as it exists when the
audit runs. A path that was mirrored when an older review was written but is
no longer an exact/concreted target is reported as `other` today. These
metrics describe the current classification rules and should not be read as
historical repository state.

### Check mode

```sh
node scripts/copilot-review-wave-audit.mjs --limit <N> --check [--since <YYYY-MM-DD>] [--min-recorded-share <n>]
node scripts/copilot-review-wave-audit.mjs --merged-from <YYYY-MM-DD> --merged-to <YYYY-MM-DD> --check [--since <YYYY-MM-DD>] [--min-recorded-share <n>]
```

`--check` still prints the report on stdout. Each failed check is written
to stderr, and the exit status is 1 when there is at least one. The checks
are an unparsed Copilot review (the overview parser has drifted), a
malformed `Triage:` line, and a recorded-triage contradiction. With
`--since`, a further check fails when the recorded share of threads among
PRs merged on or after that UTC date is below `--min-recorded-share`
(default `0.9`). A PR with no merge time is left out of that share, and a
share is not checked when no thread in the window has a recorded or
unrecorded disposition. `--since` needs `--check` and either `--limit` or
a merge window, because `--prs` carries no merge dates.
`--min-recorded-share` needs `--check` and `--since`. Misuse of either
exits 2 before any `gh` call.

### Merge windows, failed pull requests, and step summaries

Use `--merged-from <YYYY-MM-DD> --merged-to <YYYY-MM-DD>` to audit an
inclusive UTC calendar-date window. Both flags are required together and
are mutually exclusive with `--prs` and `--limit`. The helper queries a
one-day-padded merged-date search range, filters the results by exact
UTC merge timestamps, and sorts the selected pull requests newest first.
If GitHub returns 1,000 candidates, the search may be incomplete, so the
helper exits 2 and asks for a shorter window before auditing any pull
request.

The JSON report includes `failedPrs`, a list of `{ "pr": <number>,
"message": <reason> }` entries for pull requests whose audit failed.
Other pull requests still appear in `reports`, and the cohort `summary`
covers those successful audits. The helper prints the report and writes
the step summary before returning exit 1 for any non-empty `failedPrs`,
even when `--check` passes.

`--step-summary <path>` appends a `## Copilot review-wave audit`
Markdown section to the given file. It records the selector, audited
pull-request and review counts, failed count, review triggers, approval
follow-ups, disposition counts by review-count bucket, what-changed
tables, inline-finding path classes, and the triage check counts. The
existing file is preserved. A write error exits 2 and takes precedence
over `--check` and `failedPrs` results.

`--baseline-reviews-per-pr <n>` accepts a positive decimal and adds the
cohort's Copilot reviews per audited pull request and its ratio to that
baseline. With zero audited pull requests both values are `n/a`; without
the flag only reviews per pull request is shown. Invalid values exit 2
before any `gh` call.

### Known limitation: a legacy listing carries no severity or thread data

A **legacy** (non-`ccr-overview-v2`) review's body carries no severity
or `#discussion_r<id>` link in this audit's data model at all, so that
listing contributes nothing to any thread-keyed or severity-keyed
metric above — only its review is counted (in the legacy review-count
total). This is scoped to the legacy listing itself, not to the
underlying finding: if the same finding is later re-flagged in a v2
review's "Open" section, that v2 listing carries its own real severity
and `#discussion_r<id>`, so it counts normally, the same as any other
Open finding. In the 2026-09-24 baseline window (`#3089`-`#3210`), 56
of 192 Copilot reviews were legacy. This is an inherent gap in
Copilot's own review-body format, not a bug in this helper, and is not
something an "explained delta" footnote can close.

### 2026-09-24 baseline

Reproducing command:

```sh
node scripts/copilot-review-wave-audit.mjs --prs 3089,3091,3092,3093,3094,3095,3096,3097,3098,3099,3105,3106,3107,3108,3109,3114,3115,3116,3118,3122,3123,3131,3132,3133,3134,3135,3136,3137,3147,3148,3149,3150,3151,3152,3153,3154,3156,3160,3161,3168,3169,3170,3171,3172,3174,3180,3181,3185,3196,3197,3198,3199,3200,3201,3202,3203,3204,3206,3209,3210
```

(The 60 merged PR numbers in the `#3089`-`#3210` window, resolved via
`gh pr list --state merged --json number,mergedAt`; equivalent to
`--limit 200` filtered to that range at the time this baseline was
recorded — `--limit` alone is not reproducible against a fixed
baseline once more PRs merge.)

This helper's implementation was verified against the baseline before
merge and reproduces every figure exactly, with zero unparsed reviews:

| Metric                                              | Value                                  |
| --------------------------------------------------- | -------------------------------------- |
| Reviews                                             | 192 (136 `ccr-overview-v2`, 56 legacy) |
| Open appearances                                    | High 70 / Medium 66 / Low 67           |
| Unique finding threads                              | High 49 / Medium 37 / Low 39           |
| Low-thread dispositions                             | Accepted 36 / Rejected 0 / None 3      |
| All-Low-severity reviews followed by another review | 11 / 11                                |
| "Previously missed" findings                        | 41 (Low 29 / Medium 12 / High 0)       |

### 2026-10 baseline

Reproducing command:

```sh
node scripts/copilot-review-wave-audit.mjs --merged-from 2026-10-01 --merged-to 2026-10-26
```

Run on 2026-10-27. The audit covered 458 pull requests, from
pull request `#3648` through pull request `#4740`, and counted 1,790
Copilot reviews, or 3.908296943231441 reviews per pull request. It
includes all Copilot review pages for pull requests merged in the
window, unlike the throwaway October measurement, which read at most
100 reviews per pull request and therefore reported lower bounds. The
`failedPrs` list was empty. One unparsed Copilot review was counted on
pull request `#3782`, merged 2026-10-08.

| Metric                      | Value                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| Copilot reviews             | 1,790 total: v2 1,781; legacy 8; unparsed 1                                                      |
| Reviews per pull request    | 3.908296943231441                                                                                |
| Review triggers             | first 457; same-head 6; new-head 1,295; merge-commit-head 30; unknown 2                          |
| Approvals                   | total 391; followed 121; next trigger: same-head 1; new-head 115; merge-commit-head 3; unknown 2 |
| What-changed tables         | 457; listing generated helpers 255; listing sync mirrors 262                                     |
| Inline finding path classes | generated helper 57; sync mirror 109; other 1,449; no path 0                                     |
| Triage                      | recorded 223; unrecorded 1,305; malformed 0; contradictions 27                                   |

#### Copilot reviewer runs

This separate measurement counts the runs created by the dynamic
`dynamic/agents/copilot-pull-request-reviewer` workflow during the UTC
date range; it does not count review runs belonging to the pull requests
merged in that range. The workflow's `pull_requests` field was empty
on 1,795 of the 1,821 October runs, while `head_branch` was present
on every run, so this mode reports head-branch counts instead of assigning
runs to PRs. This limitation was measured for
[issue #4753](https://github.com/kurone-kito/idd-skill/issues/4753).

The run list has no duration field. This mode uses
`updated_at - run_started_at`; on 25 runs from 2026-10-20, that
matched `run_duration_ms` from
`actions/runs/<id>/timing` to the second, without one timing request
per run. Run duration is a cost proxy: the closest cost-side measure
available to the workflow's `GITHUB_TOKEN`. GitHub reports no
billable Actions time for this public repository, and does not document
whether run duration tracks model usage.

The workflow runs endpoint caps a `created` filter at 1,000 results.
The helper therefore queries one UTC day at a time with
`per_page=100` and pagination, and fails closed when a day's
`total_count` reaches 1,000 rather than publish a truncated result.

| Measurement                 | Value                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Command                     | `node scripts/copilot-review-wave-audit.mjs --reviewer-runs-from 2026-10-01 --reviewer-runs-to 2026-10-26` |
| Run date                    | 2026-10-28                                                                                                 |
| Run window (UTC, inclusive) | 2026-10-01 through 2026-10-26                                                                              |
| Workflow                    | `dynamic/agents/copilot-pull-request-reviewer` (283812949)                                                 |
| Runs / completed            | 1,821 / 1,821                                                                                              |
| Conclusions                 | success 1,814; failure 3; cancelled 4; other 0                                                             |
| Total duration              | 467,662,000 ms (129.9 hours)                                                                               |
| Median duration             | 247,000 ms (247 seconds)                                                                                   |
| Distinct head branches      | 463                                                                                                        |
| Median runs per head branch | 2                                                                                                          |

Dispositions by PR review-count bucket:

| Reviews per PR | Deferred | Rejected | Accepted | Other | None |
| -------------- | -------: | -------: | -------: | ----: | ---: |
| 1–2            |        5 |       35 |      133 |     0 |    7 |
| 3–4            |        3 |       17 |      193 |     0 |    2 |
| 5–9            |        4 |       43 |      296 |     0 |   21 |
| 10+            |        3 |       55 |      741 |     4 |   47 |

## Saved fix pushes after a second or third Copilot re-review (#4853)

This section is a one-off read, recorded on 2026-11-01. It measures whether
a bounded wait before the first fix push of a pull-request head would save
an extra Copilot re-review. It does not add a wait, and it does not choose a
workflow option.

### Selection and definitions

- **Window**: pull requests of `kurone-kito/idd-skill` created from
  2026-08-20 through 2026-10-26, inclusive. The search found 1,162 pull
  requests, created from 2026-08-23 through 2026-10-26; none was created from
  2026-08-20 through 2026-08-22. The search was split into two date ranges
  because one query caps at 1,000 results.
- **Copilot review position**: a review's index among all of its pull
  request's Copilot reviews, ordered by `submittedAt`. The window does not
  limit the positions.
- **New-head re-review**: a Copilot review submitted from 2026-10-01 through
  2026-10-26 whose commit differs from the previous Copilot review's commit.
- **Denominator**: the new-head re-reviews at Copilot position 2 or 3 (504).
  The specification names this set as the denominator.
- **Measured head**: a denominator head whose re-review has at least one
  inline comment (`PullRequestReview` comments total count above zero). The
  specification asks for this inline-only set to be measured (196 here). A
  re-review with no inline comment is not measured.
- **First push (proxy)**: the earliest check-suite `created_at` among the
  pull request's commits after the earlier head, in pull-request commit
  order. This is a proxy for the push time: check-suite creation time is not a
  push-event timestamp, and no push-event timestamp was read. A head with no
  check suite would be unknown; none was.
- **Secondary review**: the first Codex or CodeRabbit review with at least one
  inline comment that was submitted after the first push. The column shows
  which bot it was.
- **Threads A/R/none**: the threads that the secondary review opened, counted
  by the pull-request author's reply. `A` is a reply starting with
  `**Accepted**`, `R` one starting with `**Rejected**`, and `none` is a thread
  with neither. A thread with both counts as `A`.
- **Next Copilot review, nothing Accepted**: no thread opened by the next
  Copilot review has an Accepted reply. A head with no next Copilot review
  counts as nothing Accepted (20 heads).
- **Late fixes stayed**: the files touched by non-merge commits after the
  earlier head were all files that the earlier head's cumulative diff already
  touched.
- **Saved**: a secondary review after the push, at least one Accepted thread
  from it, and nothing Accepted in the next Copilot review.

### Result

| Measure                                             |  Count |
| --------------------------------------------------- | -----: |
| Pull requests in window                             |  1,162 |
| Copilot reviews in window                           |  4,809 |
| Denominator: new-head re-reviews at position 2 or 3 |    504 |
| Measured heads (inline-only, position 2 or 3)       |    196 |
| Saved                                               |     43 |
| Not saved                                           |    153 |
| Unknown                                             |      0 |
| Saved over the denominator (43 / 504)               |  8.5 % |
| Saved over the measured heads (43 / 196)            | 21.9 % |

The specification states that the 2026-10-27 count put 53 heads in the
inline-only set. This read finds 196 under the definitions above. Three other
readings did not reproduce 53: the position among inline-bearing reviews only,
requiring the previous review to be inline too, and requiring the earlier
commit to differ from every earlier review. The cause is not determined. The
figures here are this read's own.

Of the 43 saved heads, 32 had a Codex secondary review and 11 a CodeRabbit
one. Of the 196 measured heads, 124 had a secondary review after the push and
72 had none.

Per-field counts over the 196 measured heads: secondary review after the push
124; at least one Accepted thread 91; the next Copilot review had nothing
Accepted 120; late fixes stayed in the earlier diff's files 130, and left them
66.

Sensitivity of the saved total to the definitions:

- Primary (as defined above): 43.
- Loose thread match (any comment from that review in the thread): 55.
- Treat `Fixed in` or `Addressed in` replies as Accepted: 44.
- Exclude heads with any Rejected thread: 41.
- Require the secondary review to come before the next Copilot review, when
  one exists: 32. This is a stricter reading than the specification's own
  definition, which does not require it. It is reported because a secondary
  review that arrives after the next Copilot review cannot have changed that
  review.

### Body-only heads (named, not measured)

Zero new findings appeared only in a review body. Six heads with no inline
comment list open findings in the body, but each linked finding was opened by
an earlier review, so none is new to that review. They are named here and
not measured: pull requests 3844 (position 3), 3929 (position 3), 3990
(positions 2 and 3), 4153 (position 3), and 4271 (position 2). The
specification anticipated two.

### Per-head record

Each row is one measured head. "Saved" is the column the result is counted
from. The secondary-review and thread columns describe the same review that
the Saved predicate uses.

|   PR | Pos | Re-review (UTC)  | First push (UTC) | Secondary bot | Secondary review (UTC) | Threads A/R/none | Next Copilot: nothing Accepted | Late fixes stayed | Saved |
| ---: | --: | ---------------- | ---------------- | ------------- | ---------------------- | :--------------: | :----------------------------: | :---------------: | :---: |
| 3695 |   2 | 2026-10-01 00:08 | 2026-10-01 00:05 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3699 |   2 | 2026-10-01 01:22 | 2026-10-01 01:18 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3711 |   2 | 2026-10-01 14:56 | 2026-10-01 14:52 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3723 |   2 | 2026-10-02 01:05 | 2026-10-02 01:02 | CodeRabbit    | 2026-10-02 01:03       |        -         |              yes               |        yes        |  no   |
| 3730 |   2 | 2026-10-02 18:00 | 2026-10-02 17:58 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3737 |   2 | 2026-10-03 00:32 | 2026-10-03 00:28 | Codex         | 2026-10-03 00:30       |      1/0/0       |              yes               |        yes        |  yes  |
| 3741 |   2 | 2026-10-03 11:23 | 2026-10-03 11:18 | Codex         | 2026-10-03 11:23       |      1/0/0       |               no               |        no         |  no   |
| 3741 |   3 | 2026-10-03 13:13 | 2026-10-03 13:08 | Codex         | 2026-10-03 14:01       |      1/0/0       |               no               |        no         |  no   |
| 3761 |   2 | 2026-10-04 01:17 | 2026-10-04 01:13 | Codex         | 2026-10-04 02:08       |      1/0/0       |              yes               |        yes        |  yes  |
| 3762 |   3 | 2026-10-04 09:20 | 2026-10-04 09:15 | Codex         | 2026-10-04 09:21       |      1/0/0       |              yes               |        yes        |  yes  |
| 3764 |   2 | 2026-10-04 12:16 | 2026-10-04 12:11 | Codex         | 2026-10-04 12:16       |      2/0/0       |              yes               |        no         |  yes  |
| 3765 |   2 | 2026-10-04 12:22 | 2026-10-04 12:17 | Codex         | 2026-10-04 13:51       |      0/1/0       |              yes               |        yes        |  no   |
| 3767 |   2 | 2026-10-04 15:06 | 2026-10-04 15:02 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3782 |   2 | 2026-10-05 03:39 | 2026-10-05 03:35 | Codex         | 2026-10-05 03:37       |      0/1/0       |               no               |        no         |  no   |
| 3782 |   3 | 2026-10-05 04:34 | 2026-10-05 04:28 | Codex         | 2026-10-05 04:31       |      0/1/0       |               no               |        no         |  no   |
| 3784 |   2 | 2026-10-05 13:02 | 2026-10-05 12:58 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3786 |   2 | 2026-10-05 12:02 | 2026-10-05 11:57 | CodeRabbit    | 2026-10-05 12:02       |        -         |              yes               |        yes        |  no   |
| 3790 |   2 | 2026-10-05 14:14 | 2026-10-05 14:08 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3804 |   2 | 2026-10-05 20:09 | 2026-10-05 20:04 | Codex         | 2026-10-05 20:11       |      1/0/0       |               no               |        no         |  no   |
| 3804 |   3 | 2026-10-05 20:55 | 2026-10-05 20:37 | Codex         | 2026-10-05 20:41       |      1/0/0       |               no               |        no         |  no   |
| 3807 |   2 | 2026-10-05 22:22 | 2026-10-05 22:19 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3810 |   2 | 2026-10-06 15:38 | 2026-10-06 15:34 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3811 |   3 | 2026-10-06 14:43 | 2026-10-06 14:39 | CodeRabbit    | 2026-10-06 14:47       |        -         |              yes               |        yes        |  no   |
| 3813 |   2 | 2026-10-06 15:30 | 2026-10-06 15:26 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3842 |   3 | 2026-10-08 13:01 | 2026-10-08 12:56 | Codex         | 2026-10-08 13:00       |      2/0/0       |               no               |        yes        |  no   |
| 3843 |   2 | 2026-10-08 13:25 | 2026-10-08 13:20 | CodeRabbit    | 2026-10-08 13:24       |        -         |               no               |        yes        |  no   |
| 3843 |   3 | 2026-10-08 13:40 | 2026-10-08 13:36 | -             | -                      |        -         |               no               |        yes        |  no   |
| 3844 |   2 | 2026-10-08 13:38 | 2026-10-08 13:30 | Codex         | 2026-10-08 15:42       |      1/0/0       |              yes               |        no         |  yes  |
| 3848 |   2 | 2026-10-08 14:45 | 2026-10-08 14:31 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3850 |   3 | 2026-10-08 16:20 | 2026-10-08 16:16 | CodeRabbit    | 2026-10-08 16:17       |        -         |              yes               |        yes        |  no   |
| 3851 |   2 | 2026-10-08 22:05 | 2026-10-08 21:56 | CodeRabbit    | 2026-10-08 21:59       |      1/0/0       |               no               |        yes        |  no   |
| 3851 |   3 | 2026-10-08 23:24 | 2026-10-08 23:15 | CodeRabbit    | 2026-10-08 23:16       |        -         |               no               |        yes        |  no   |
| 3884 |   2 | 2026-10-08 18:59 | 2026-10-08 18:53 | CodeRabbit    | 2026-10-08 18:54       |        -         |               no               |        yes        |  no   |
| 3884 |   3 | 2026-10-08 19:12 | 2026-10-08 19:07 | -             | -                      |        -         |               no               |        yes        |  no   |
| 3903 |   3 | 2026-10-08 23:45 | 2026-10-08 23:42 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3909 |   2 | 2026-10-09 00:42 | 2026-10-09 00:27 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3912 |   2 | 2026-10-09 00:42 | 2026-10-09 00:22 | -             | -                      |        -         |               no               |        yes        |  no   |
| 3912 |   3 | 2026-10-09 00:50 | 2026-10-09 00:47 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3921 |   3 | 2026-10-09 02:53 | 2026-10-09 02:48 | -             | -                      |        -         |               no               |        yes        |  no   |
| 3925 |   2 | 2026-10-09 03:22 | 2026-10-09 03:17 | CodeRabbit    | 2026-10-09 03:22       |      1/0/0       |               no               |        yes        |  no   |
| 3925 |   3 | 2026-10-09 03:37 | 2026-10-09 03:31 | CodeRabbit    | 2026-10-09 03:33       |        -         |               no               |        yes        |  no   |
| 3926 |   2 | 2026-10-09 03:21 | 2026-10-09 03:19 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3926 |   3 | 2026-10-09 03:30 | 2026-10-09 03:27 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3929 |   2 | 2026-10-09 03:59 | 2026-10-09 03:57 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3934 |   2 | 2026-10-09 05:44 | 2026-10-09 05:40 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3935 |   2 | 2026-10-09 06:11 | 2026-10-09 06:06 | CodeRabbit    | 2026-10-09 06:08       |        -         |              yes               |        yes        |  no   |
| 3940 |   3 | 2026-10-09 09:19 | 2026-10-09 09:15 | CodeRabbit    | 2026-10-09 09:16       |        -         |              yes               |        yes        |  no   |
| 3963 |   3 | 2026-10-09 17:41 | 2026-10-09 17:34 | -             | -                      |        -         |              yes               |        no         |  no   |
| 3966 |   2 | 2026-10-09 17:53 | 2026-10-09 17:48 | CodeRabbit    | 2026-10-09 18:03       |      1/0/0       |              yes               |        yes        |  yes  |
| 3967 |   2 | 2026-10-09 18:13 | 2026-10-09 18:10 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3968 |   2 | 2026-10-09 19:03 | 2026-10-09 18:58 | -             | -                      |        -         |              yes               |        no         |  no   |
| 3969 |   2 | 2026-10-09 19:13 | 2026-10-09 19:09 | CodeRabbit    | 2026-10-09 20:24       |      2/0/0       |               no               |        no         |  no   |
| 3969 |   3 | 2026-10-09 19:26 | 2026-10-09 19:21 | CodeRabbit    | 2026-10-09 20:24       |      2/0/0       |               no               |        no         |  no   |
| 3971 |   2 | 2026-10-09 20:53 | 2026-10-09 20:46 | CodeRabbit    | 2026-10-09 21:28       |      2/0/0       |              yes               |        no         |  yes  |
| 3977 |   2 | 2026-10-10 10:49 | 2026-10-10 10:44 | CodeRabbit    | 2026-10-10 11:43       |      1/0/0       |               no               |        no         |  no   |
| 3977 |   3 | 2026-10-10 11:02 | 2026-10-10 10:58 | CodeRabbit    | 2026-10-10 11:43       |      1/0/0       |              yes               |        no         |  yes  |
| 3981 |   2 | 2026-10-10 11:41 | 2026-10-10 11:36 | CodeRabbit    | 2026-10-10 12:43       |      2/0/0       |               no               |        no         |  no   |
| 3981 |   3 | 2026-10-10 12:05 | 2026-10-10 11:59 | CodeRabbit    | 2026-10-10 12:43       |      2/0/0       |               no               |        no         |  no   |
| 3986 |   2 | 2026-10-10 12:09 | 2026-10-10 12:04 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 3993 |   2 | 2026-10-10 14:59 | 2026-10-10 14:55 | CodeRabbit    | 2026-10-10 15:13       |        -         |              yes               |        yes        |  no   |
| 3993 |   3 | 2026-10-10 15:07 | 2026-10-10 15:03 | CodeRabbit    | 2026-10-10 15:13       |        -         |              yes               |        yes        |  no   |
| 3997 |   2 | 2026-10-10 17:30 | 2026-10-10 17:25 | CodeRabbit    | 2026-10-10 19:59       |        -         |               no               |        no         |  no   |
| 3997 |   3 | 2026-10-10 17:37 | 2026-10-10 17:32 | CodeRabbit    | 2026-10-10 19:59       |        -         |              yes               |        no         |  no   |
| 4000 |   2 | 2026-10-10 18:42 | 2026-10-10 18:37 | CodeRabbit    | 2026-10-10 19:16       |      1/0/0       |               no               |        no         |  no   |
| 4000 |   3 | 2026-10-10 18:52 | 2026-10-10 18:48 | CodeRabbit    | 2026-10-10 19:16       |      1/0/0       |              yes               |        no         |  yes  |
| 4004 |   2 | 2026-10-11 10:12 | 2026-10-11 10:05 | CodeRabbit    | 2026-10-11 10:16       |        -         |              yes               |        no         |  no   |
| 4004 |   3 | 2026-10-11 10:32 | 2026-10-11 10:26 | CodeRabbit    | 2026-10-11 11:07       |        -         |              yes               |        no         |  no   |
| 4016 |   2 | 2026-10-11 10:57 | 2026-10-11 10:53 | Codex         | 2026-10-11 10:56       |      1/0/0       |              yes               |        no         |  yes  |
| 4018 |   2 | 2026-10-11 11:03 | 2026-10-11 11:00 | Codex         | 2026-10-11 11:03       |      1/0/0       |              yes               |        no         |  yes  |
| 4023 |   2 | 2026-10-11 17:03 | 2026-10-11 16:59 | Codex         | 2026-10-11 17:02       |      1/0/0       |               no               |        yes        |  no   |
| 4023 |   3 | 2026-10-11 17:18 | 2026-10-11 17:14 | Codex         | 2026-10-11 17:58       |      1/0/0       |              yes               |        yes        |  yes  |
| 4030 |   2 | 2026-10-11 13:57 | 2026-10-11 13:49 | CodeRabbit    | 2026-10-11 14:25       |      1/0/0       |               no               |        no         |  no   |
| 4030 |   3 | 2026-10-11 14:14 | 2026-10-11 14:07 | CodeRabbit    | 2026-10-11 14:25       |      1/0/0       |               no               |        no         |  no   |
| 4040 |   2 | 2026-10-11 19:19 | 2026-10-11 19:16 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4041 |   2 | 2026-10-11 20:11 | 2026-10-11 20:05 | Codex         | 2026-10-11 20:09       |      2/0/0       |              yes               |        yes        |  yes  |
| 4044 |   2 | 2026-10-12 01:00 | 2026-10-12 00:53 | Codex         | 2026-10-12 00:55       |      0/1/0       |              yes               |        no         |  no   |
| 4045 |   2 | 2026-10-12 01:03 | 2026-10-12 00:57 | Codex         | 2026-10-12 01:01       |      2/0/0       |               no               |        yes        |  no   |
| 4045 |   3 | 2026-10-12 01:17 | 2026-10-12 01:14 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4046 |   2 | 2026-10-12 02:00 | 2026-10-12 01:54 | CodeRabbit    | 2026-10-12 02:06       |      4/0/0       |               no               |        no         |  no   |
| 4046 |   3 | 2026-10-12 02:28 | 2026-10-12 02:22 | CodeRabbit    | 2026-10-12 02:23       |        -         |              yes               |        no         |  no   |
| 4048 |   2 | 2026-10-12 01:23 | 2026-10-12 01:18 | Codex         | 2026-10-12 10:27       |      1/0/0       |               no               |        no         |  no   |
| 4048 |   3 | 2026-10-12 10:29 | 2026-10-12 10:25 | Codex         | 2026-10-12 10:27       |      1/0/0       |               no               |        no         |  no   |
| 4052 |   2 | 2026-10-12 02:29 | 2026-10-12 02:23 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4058 |   2 | 2026-10-12 04:15 | 2026-10-12 04:10 | Codex         | 2026-10-12 04:13       |      1/0/0       |               no               |        yes        |  no   |
| 4058 |   3 | 2026-10-12 04:20 | 2026-10-12 04:13 | Codex         | 2026-10-12 04:17       |      1/0/0       |               no               |        yes        |  no   |
| 4069 |   2 | 2026-10-12 10:52 | 2026-10-12 10:48 | Codex         | 2026-10-12 10:52       |      1/0/0       |               no               |        no         |  no   |
| 4069 |   3 | 2026-10-12 11:06 | 2026-10-12 11:02 | Codex         | 2026-10-12 11:06       |      1/0/0       |               no               |        yes        |  no   |
| 4072 |   3 | 2026-10-12 11:33 | 2026-10-12 11:31 | Codex         | 2026-10-12 11:34       |      1/0/0       |              yes               |        yes        |  yes  |
| 4073 |   2 | 2026-10-12 11:40 | 2026-10-12 11:34 | Codex         | 2026-10-12 13:39       |      3/0/0       |               no               |        yes        |  no   |
| 4073 |   3 | 2026-10-12 12:36 | 2026-10-12 12:31 | Codex         | 2026-10-12 13:39       |      3/0/0       |               no               |        yes        |  no   |
| 4074 |   2 | 2026-10-12 11:33 | 2026-10-12 11:29 | Codex         | 2026-10-12 11:33       |      1/0/0       |              yes               |        yes        |  yes  |
| 4077 |   3 | 2026-10-12 13:45 | 2026-10-12 13:40 | CodeRabbit    | 2026-10-12 15:05       |      1/1/0       |               no               |        yes        |  no   |
| 4082 |   2 | 2026-10-12 14:58 | 2026-10-12 14:53 | Codex         | 2026-10-12 14:56       |      1/0/0       |               no               |        no         |  no   |
| 4082 |   3 | 2026-10-12 15:36 | 2026-10-12 15:32 | Codex         | 2026-10-12 15:36       |      2/0/0       |               no               |        no         |  no   |
| 4092 |   2 | 2026-10-13 01:26 | 2026-10-13 01:22 | -             | -                      |        -         |               no               |        no         |  no   |
| 4092 |   3 | 2026-10-13 02:41 | 2026-10-13 02:35 | -             | -                      |        -         |               no               |        no         |  no   |
| 4100 |   2 | 2026-10-13 01:24 | 2026-10-13 01:21 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4125 |   2 | 2026-10-13 02:38 | 2026-10-13 02:34 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4147 |   2 | 2026-10-13 05:16 | 2026-10-13 05:10 | -             | -                      |        -         |               no               |        no         |  no   |
| 4147 |   3 | 2026-10-13 05:38 | 2026-10-13 05:33 | -             | -                      |        -         |               no               |        no         |  no   |
| 4148 |   3 | 2026-10-13 06:06 | 2026-10-13 06:03 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4149 |   2 | 2026-10-13 05:24 | 2026-10-13 05:20 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4153 |   2 | 2026-10-13 08:22 | 2026-10-13 08:20 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4155 |   2 | 2026-10-13 08:28 | 2026-10-13 08:24 | Codex         | 2026-10-13 10:16       |      1/0/0       |              yes               |        yes        |  yes  |
| 4156 |   2 | 2026-10-13 06:48 | 2026-10-13 06:37 | Codex         | 2026-10-13 06:40       |      1/0/0       |              yes               |        yes        |  yes  |
| 4156 |   3 | 2026-10-13 07:02 | 2026-10-13 06:57 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4159 |   2 | 2026-10-13 06:56 | 2026-10-13 06:50 | CodeRabbit    | 2026-10-13 06:56       |      2/0/0       |              yes               |        no         |  yes  |
| 4160 |   2 | 2026-10-13 07:10 | 2026-10-13 07:06 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4160 |   3 | 2026-10-13 07:26 | 2026-10-13 07:21 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4176 |   3 | 2026-10-13 12:42 | 2026-10-13 12:37 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4178 |   2 | 2026-10-13 13:37 | 2026-10-13 13:33 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4207 |   2 | 2026-10-13 20:25 | 2026-10-13 20:22 | Codex         | 2026-10-13 20:45       |      0/1/0       |              yes               |        yes        |  no   |
| 4229 |   2 | 2026-10-13 22:38 | 2026-10-13 22:34 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4231 |   2 | 2026-10-13 22:46 | 2026-10-13 22:41 | -             | -                      |        -         |               no               |        no         |  no   |
| 4231 |   3 | 2026-10-13 23:01 | 2026-10-13 22:56 | -             | -                      |        -         |               no               |        no         |  no   |
| 4246 |   2 | 2026-10-14 03:35 | 2026-10-14 03:32 | Codex         | 2026-10-14 03:35       |      1/0/0       |              yes               |        yes        |  yes  |
| 4246 |   3 | 2026-10-14 03:49 | 2026-10-14 03:46 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4249 |   2 | 2026-10-14 07:00 | 2026-10-14 06:57 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4249 |   3 | 2026-10-14 07:09 | 2026-10-14 07:05 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4262 |   3 | 2026-10-14 09:05 | 2026-10-14 08:52 | Codex         | 2026-10-14 08:56       |      0/1/0       |              yes               |        yes        |  no   |
| 4263 |   3 | 2026-10-14 09:35 | 2026-10-14 09:28 | Codex         | 2026-10-14 09:32       |      1/0/0       |              yes               |        no         |  yes  |
| 4266 |   2 | 2026-10-14 12:35 | 2026-10-14 12:31 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4268 |   2 | 2026-10-14 12:04 | 2026-10-14 11:57 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4268 |   3 | 2026-10-14 12:17 | 2026-10-14 12:13 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4271 |   3 | 2026-10-14 13:28 | 2026-10-14 13:21 | Codex         | 2026-10-14 13:25       |      0/0/2       |              yes               |        yes        |  no   |
| 4285 |   2 | 2026-10-14 15:41 | 2026-10-14 15:36 | -             | -                      |        -         |               no               |        no         |  no   |
| 4285 |   3 | 2026-10-14 16:05 | 2026-10-14 16:00 | -             | -                      |        -         |               no               |        no         |  no   |
| 4292 |   2 | 2026-10-14 16:40 | 2026-10-14 16:37 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4317 |   2 | 2026-10-15 00:03 | 2026-10-14 23:57 | Codex         | 2026-10-15 00:01       |      2/0/0       |               no               |        yes        |  no   |
| 4317 |   3 | 2026-10-15 00:32 | 2026-10-15 00:25 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4322 |   2 | 2026-10-15 01:15 | 2026-10-15 01:11 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4325 |   2 | 2026-10-15 01:29 | 2026-10-15 01:22 | -             | -                      |        -         |               no               |        no         |  no   |
| 4325 |   3 | 2026-10-15 01:52 | 2026-10-15 01:46 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4329 |   2 | 2026-10-15 01:51 | 2026-10-15 01:48 | CodeRabbit    | 2026-10-15 13:39       |      1/0/0       |               no               |        no         |  no   |
| 4329 |   3 | 2026-10-15 13:38 | 2026-10-15 13:34 | CodeRabbit    | 2026-10-15 13:39       |      1/0/0       |              yes               |        no         |  yes  |
| 4331 |   2 | 2026-10-15 02:16 | 2026-10-15 02:09 | CodeRabbit    | 2026-10-15 03:54       |      6/0/0       |               no               |        yes        |  no   |
| 4331 |   3 | 2026-10-15 02:30 | 2026-10-15 02:24 | CodeRabbit    | 2026-10-15 03:54       |      6/0/0       |              yes               |        yes        |  yes  |
| 4337 |   2 | 2026-10-15 03:54 | 2026-10-15 03:49 | CodeRabbit    | 2026-10-15 05:00       |      1/0/0       |               no               |        yes        |  no   |
| 4337 |   3 | 2026-10-15 04:15 | 2026-10-15 04:10 | CodeRabbit    | 2026-10-15 05:00       |      1/0/0       |               no               |        yes        |  no   |
| 4356 |   2 | 2026-10-15 07:17 | 2026-10-15 07:14 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4357 |   2 | 2026-10-15 07:08 | 2026-10-15 07:03 | Codex         | 2026-10-15 07:08       |      2/0/0       |               no               |        yes        |  no   |
| 4357 |   3 | 2026-10-15 07:30 | 2026-10-15 07:25 | Codex         | 2026-10-15 07:36       |      2/0/0       |               no               |        yes        |  no   |
| 4360 |   2 | 2026-10-15 08:16 | 2026-10-15 08:12 | Codex         | 2026-10-15 08:16       |      1/0/0       |               no               |        yes        |  no   |
| 4360 |   3 | 2026-10-15 08:27 | 2026-10-15 08:23 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4363 |   3 | 2026-10-15 09:47 | 2026-10-15 09:43 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4385 |   3 | 2026-10-15 16:39 | 2026-10-15 16:35 | Codex         | 2026-10-15 16:38       |      1/0/0       |               no               |        yes        |  no   |
| 4388 |   2 | 2026-10-15 16:23 | 2026-10-15 16:18 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4390 |   2 | 2026-10-15 17:12 | 2026-10-15 17:07 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4403 |   2 | 2026-10-15 18:13 | 2026-10-15 18:08 | CodeRabbit    | 2026-10-16 15:29       |      2/0/0       |              yes               |        no         |  yes  |
| 4405 |   2 | 2026-10-15 22:18 | 2026-10-15 22:15 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4405 |   3 | 2026-10-15 23:20 | 2026-10-15 23:18 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4406 |   2 | 2026-10-15 23:43 | 2026-10-15 23:41 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4407 |   2 | 2026-10-15 22:19 | 2026-10-15 22:16 | Codex         | 2026-10-15 22:41       |      1/0/0       |              yes               |        no         |  yes  |
| 4408 |   2 | 2026-10-15 23:11 | 2026-10-15 23:05 | Codex         | 2026-10-15 23:07       |      1/0/0       |               no               |        yes        |  no   |
| 4408 |   3 | 2026-10-16 14:24 | 2026-10-16 14:19 | Codex         | 2026-10-16 14:23       |      1/0/0       |               no               |        yes        |  no   |
| 4416 |   2 | 2026-10-16 00:01 | 2026-10-15 23:56 | Codex         | 2026-10-16 00:00       |      4/0/0       |               no               |        yes        |  no   |
| 4416 |   3 | 2026-10-16 03:15 | 2026-10-16 03:10 | Codex         | 2026-10-16 03:16       |      1/0/0       |               no               |        yes        |  no   |
| 4425 |   2 | 2026-10-16 05:22 | 2026-10-16 05:16 | -             | -                      |        -         |              yes               |        no         |  no   |
| 4443 |   3 | 2026-10-16 18:07 | 2026-10-16 18:04 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4448 |   2 | 2026-10-16 18:56 | 2026-10-16 18:50 | -             | -                      |        -         |               no               |        yes        |  no   |
| 4448 |   3 | 2026-10-17 07:02 | 2026-10-17 06:51 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4452 |   2 | 2026-10-16 21:32 | 2026-10-16 21:27 | CodeRabbit    | 2026-10-16 21:34       |      2/0/0       |               no               |        yes        |  no   |
| 4452 |   3 | 2026-10-16 22:03 | 2026-10-16 21:57 | CodeRabbit    | 2026-10-16 21:59       |        -         |               no               |        yes        |  no   |
| 4455 |   2 | 2026-10-16 22:13 | 2026-10-16 22:05 | CodeRabbit    | 2026-10-16 22:38       |      4/1/0       |              yes               |        yes        |  yes  |
| 4457 |   2 | 2026-10-17 04:19 | 2026-10-17 04:15 | CodeRabbit    | 2026-10-17 04:16       |        -         |              yes               |        no         |  no   |
| 4485 |   2 | 2026-10-17 19:50 | 2026-10-17 19:47 | Codex         | 2026-10-17 19:49       |      2/0/0       |              yes               |        no         |  yes  |
| 4485 |   3 | 2026-10-17 20:09 | 2026-10-17 20:05 | Codex         | 2026-10-17 20:09       |      1/0/0       |              yes               |        no         |  yes  |
| 4486 |   2 | 2026-10-17 20:44 | 2026-10-17 20:41 | -             | -                      |        -         |              yes               |        yes        |  no   |
| 4505 |   2 | 2026-10-18 11:21 | 2026-10-18 11:18 | Codex         | 2026-10-18 11:21       |      2/0/0       |              yes               |        no         |  yes  |
| 4514 |   2 | 2026-10-18 16:00 | 2026-10-18 15:55 | Codex         | 2026-10-18 15:58       |      0/2/0       |              yes               |        yes        |  no   |
| 4558 |   2 | 2026-10-19 14:04 | 2026-10-19 13:28 | Codex         | 2026-10-19 14:17       |      1/0/0       |              yes               |        yes        |  yes  |
| 4567 |   2 | 2026-10-19 18:46 | 2026-10-19 18:39 | Codex         | 2026-10-19 18:44       |      2/0/0       |              yes               |        yes        |  yes  |
| 4572 |   3 | 2026-10-20 01:57 | 2026-10-20 01:53 | Codex         | 2026-10-20 01:56       |      1/0/0       |              yes               |        yes        |  yes  |
| 4577 |   3 | 2026-10-20 06:39 | 2026-10-20 06:36 | Codex         | 2026-10-20 06:39       |      1/0/0       |               no               |        yes        |  no   |
| 4578 |   3 | 2026-10-20 12:09 | 2026-10-20 12:07 | CodeRabbit    | 2026-10-20 12:08       |        -         |              yes               |        yes        |  no   |
| 4591 |   2 | 2026-10-21 03:55 | 2026-10-21 03:52 | CodeRabbit    | 2026-10-21 03:56       |      1/0/0       |               no               |        yes        |  no   |
| 4591 |   3 | 2026-10-21 04:17 | 2026-10-21 04:13 | Codex         | 2026-10-21 04:15       |      1/0/0       |              yes               |        yes        |  yes  |
| 4604 |   2 | 2026-10-21 11:28 | 2026-10-21 11:24 | CodeRabbit    | 2026-10-21 11:29       |      1/0/0       |              yes               |        yes        |  yes  |
| 4604 |   3 | 2026-10-21 11:52 | 2026-10-21 11:47 | Codex         | 2026-10-21 11:50       |      2/0/0       |               no               |        yes        |  no   |
| 4606 |   2 | 2026-10-21 11:44 | 2026-10-21 11:40 | Codex         | 2026-10-21 12:28       |      1/0/0       |              yes               |        yes        |  yes  |
| 4606 |   3 | 2026-10-21 12:28 | 2026-10-21 12:23 | Codex         | 2026-10-21 12:28       |      1/0/0       |              yes               |        yes        |  yes  |
| 4608 |   2 | 2026-10-21 12:19 | 2026-10-21 12:15 | Codex         | 2026-10-21 12:18       |      3/0/0       |              yes               |        yes        |  yes  |
| 4608 |   3 | 2026-10-21 12:41 | 2026-10-21 12:37 | Codex         | 2026-10-21 12:41       |      3/0/0       |              yes               |        yes        |  yes  |
| 4620 |   2 | 2026-10-22 11:56 | 2026-10-22 11:51 | Codex         | 2026-10-22 11:59       |      1/0/0       |               no               |        yes        |  no   |
| 4620 |   3 | 2026-10-22 12:28 | 2026-10-22 12:23 | Codex         | 2026-10-22 12:45       |      1/0/0       |              yes               |        yes        |  yes  |
| 4632 |   3 | 2026-10-23 01:59 | 2026-10-23 01:55 | Codex         | 2026-10-23 01:58       |      1/0/0       |              yes               |        yes        |  yes  |
| 4633 |   2 | 2026-10-23 03:13 | 2026-10-23 03:08 | Codex         | 2026-10-23 03:13       |      1/0/0       |              yes               |        no         |  yes  |
| 4651 |   2 | 2026-10-23 08:10 | 2026-10-23 08:04 | CodeRabbit    | 2026-10-23 08:15       |      0/0/3       |              yes               |        yes        |  no   |
| 4654 |   3 | 2026-10-23 10:45 | 2026-10-23 10:41 | CodeRabbit    | 2026-10-23 10:57       |        -         |              yes               |        no         |  no   |
| 4677 |   2 | 2026-10-24 11:16 | 2026-10-24 11:13 | Codex         | 2026-10-24 11:14       |      1/0/0       |              yes               |        yes        |  yes  |
| 4688 |   2 | 2026-10-25 03:22 | 2026-10-25 03:18 | CodeRabbit    | 2026-10-25 09:04       |        -         |              yes               |        no         |  no   |
| 4690 |   2 | 2026-10-24 23:52 | 2026-10-24 23:48 | Codex         | 2026-10-25 06:26       |      1/0/0       |              yes               |        yes        |  yes  |
| 4709 |   2 | 2026-10-25 07:47 | 2026-10-25 07:43 | Codex         | 2026-10-25 08:46       |      0/1/0       |              yes               |        no         |  no   |
| 4709 |   3 | 2026-10-25 08:48 | 2026-10-25 08:44 | Codex         | 2026-10-25 08:46       |      0/1/0       |              yes               |        yes        |  no   |
| 4719 |   3 | 2026-10-25 10:50 | 2026-10-25 10:47 | CodeRabbit    | 2026-10-25 11:08       |      1/1/0       |              yes               |        yes        |  yes  |
| 4733 |   2 | 2026-10-25 14:55 | 2026-10-25 14:50 | Codex         | 2026-10-25 14:53       |      1/0/0       |               no               |        no         |  no   |
