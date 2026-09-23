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
