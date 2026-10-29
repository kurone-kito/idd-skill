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
