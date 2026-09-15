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
