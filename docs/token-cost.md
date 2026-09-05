---
type: reference
title: Token-Cost Methodology
description: Documents how this repository measures its own agent context-window cost per completed IDD issue loop.
tags: [token-cost, dogfood, measurement]
---

# Token-Cost Methodology

This page is dogfood-only: it is not distributed to adopter repositories.
It documents how `kurone-kito/idd-skill` measures the agent
context-window cost of running its own IDD loop on itself.

## Scope

- **Unit of measurement**: one completed IDD issue loop (claim through
  merge or another terminal outcome), not a raw agent session. A single
  vendor session may span multiple issue loops, or a single issue loop may
  span multiple vendor sessions (handoffs, resumes); samples are joined
  to the issue loop they belong to, not to a session boundary.
- **Stages**: `discover`, `claim`, `work`, `submit-pr`, `review`, `merge`,
  `cleanup` — the same seven IDD phases named throughout
  [`docs/idd-workflow.md`](idd-workflow.md).
- **Success**: an issue loop counts as `merged` only when its claim
  lineage ends in a merged pull request. `aborted`, `unclaimed`, and
  `human-handoff` are the other tracked outcomes; `unknown` is excluded
  from every aggregate figure on this page.
- **Attribution**: historical samples are reconstructed via a
  marker-join (claim comments, PR references, timestamps) when no
  better signal exists; an explicit phase-enter/exit event, when
  present, wins over the marker-join reconstruction for that sample.
- **Privacy**: raw agent logs, prompts, and file paths never enter git.
  Only token-usage counts, timestamps, and coarse outcome/vendor/model
  labels are committed, via the snapshot artifact described below.
- **Cost unit**: figures on this page are token counts (a static
  `bundleBudgets` byte budget, tracked separately per issue `#1659`,
  measures Markdown bytes, not billed tokens). No USD figures are
  published here or anywhere else in this repository.
- **Coverage (v1)**: Grok, Claude Code, and Codex CLI sessions. GitHub
  Copilot, OpenCode, and Antigravity CLI sessions are out of scope for
  the first version of this measurement.

## How the snapshot is produced

Harvested samples are local JSONL files under each vendor's own session
directory (`~/.grok`, `~/.claude`, `~/.codex`) — never committed. CI runs
on GitHub and cannot see those directories, so the only committed
artifact is [`docs/token-cost-snapshot.json`](token-cost-snapshot.json):
aggregated percentiles, cache-hit ratio, and success rates, with no raw
records.

`node scripts/token-cost-harvest.mjs --repo kurone-kito/idd-skill`
produces those local samples: it scans each installed vendor adapter's
own session logs, joins any session whose cwd names an issue worktree
against this repository's own GitHub IDD markers (claim,
review-watermark) and the connected pull request's own metadata
(creation and merge timestamps) to reconstruct that issue loop's
seven stage windows,
and appends `kind: "issue-loop"` / `kind: "session"` records to
`${XDG_STATE_HOME:-$HOME/.local/state}/idd-skill/token-cost/samples.jsonl`
(`--out` to override, `--dry-run` to only print counts). When
`token-cost-event.mjs`'s own explicit phase-event log exists at the
sibling `events.jsonl` path (`--events` to override), those timestamps
win over the marker-join reconstruction for the stages they cover.

`node scripts/token-cost-harvest.mjs` must be run from the **primary
worktree**, not an issue worktree, for its Claude-vendor scan to see
real data: Claude Code stores each project's session logs under
`~/.claude/projects/<encoded cwd>`, encoded from whichever cwd the
session actually launched with -- not from `--repo` or any other flag.
An issue worktree (`<repo>.issue/<n>-*`) lives at a different path
than the primary worktree and so has no matching, populated project
directory of its own; running the harvest CLI from one now prints a
warning naming the missing directory instead of silently reporting a
misleading zero-sample result (`#2439`).

`token-cost-event.mjs` also auto-derives each event's `vendorSessionId`
from a vendor-specific env var -- `$CLAUDE_CODE_SESSION_ID` for
`--vendor claude`, no equivalent known yet for `grok`/`codex` -- with no
flag needed. When two attempts for the same issue leave events in
`events.jsonl` (a retry, a fail-open dropped call), an identified
attempt's own `enter`/`exit` pair is never mixed with a different
attempt's, and a same-issue match across more than one project log file
resolves to whichever file's own session id matches, instead of being
skipped. Legacy (identity-agnostic) joining still applies exactly as
before this field existed, but only when the relevant events are
themselves unidentified (all historical data, and any vendor with no
known session-id source) -- once identified events are present, an
identified stage is never treated as compatible with a differently- or
un-identified completion, so a stale or unrelated attempt can't be
silently absorbed. When a single issue loop legitimately spans multiple
Claude sessions (a handoff or resume, Refs Scope above), a second,
independent signal resolves it: passing `--claim-id` (the active IDD
`{claim-id}`) to `token-cost-event.mjs` persists it as `claimId` on the
event, and a non-`cleanup` stage window whose `claimId` matches the
winning `cleanup` window's own is treated as belonging to the same claim
lineage even when its `vendorSessionId` differs -- the IDD `{claim-id}`
is this repository's own ground-truth ownership token, independent of
which process posted the event, so it can positively confirm a genuine
handoff where a bare session-id mismatch alone cannot (Refs #2432). The
harvester then also pulls that contributing session's own project log
file's records into the harvested sample (restricted to its own
qualifying window bounds), rather than merely widening the reported
bounds without the usage to back them. Two claim-id-matched windows from
different sessions that overlap in time -- a narrow, documented race
where two sessions can momentarily share one active claim-id without one
being a clean continuation of the other -- are treated as contamination
and excluded, same as a reversed window. A loop whose events predate this
field, or whose caller never passes `--claim-id`, falls back to today's
narrower, single-session-only behavior unchanged -- not a regression,
since `events.jsonl` is append-only and a later harvest picks up richer
attribution once available.

`node scripts/token-cost-report.mjs`:

- `--in <samples.jsonl> [--in <samples.jsonl> ...] --apply` aggregates
  local samples into a fresh snapshot and refreshes this page's table
  below plus the [`README.md`](../README.md) /
  [`README.ja.md`](../README.ja.md) blurb.
- `--check` verifies the committed snapshot still matches the rendered
  regions in those three files — it never re-harvests or reads raw
  samples, only the committed snapshot. Wiring `--check` into this
  repository's own `pre-push-validate` / `post-fix-validate` chain is
  deferred: doing so would push the `bundle-work` documentation
  context-ceiling budget over its configured threshold (see issue
  `#2294`'s implementation notes), and the fix belongs to a separate,
  deliberate byte-budget decision rather than this reporter's own
  scope.
- `--apply` is also cwd-sensitive, the same way `token-cost-harvest.mjs`
  is above: it refuses to run while the current branch is the
  repository's default branch, since a stray `--apply` left dirty on
  the shared primary worktree's `main` can block every concurrent
  session's next B1 `git merge --ff-only` worktree creation (`#2452`).
  Pass `--allow-default-branch` for an intentional maintainer run from
  the primary worktree; `--apply` from an issue worktree is unaffected.

A snapshot is `publishable` only once it has at least 10 issue-loop
samples across at least 2 distinct vendors. Below that gate, the
README blurb and the table below stay on an unpublished stub — no
number is ever invented to fill the gap.

**Known caveat**: an event-window sample's `outcome` currently
misclassifies a genuinely merged loop as `unclaimed` whenever the
closing PR used the standard `Closes #N` keyword link instead of
GitHub's manual Development-panel link (every PR this repository's own
IDD workflow opens) — `fetchIssueLoopGithubContext` resolves the
connected PR via `ConnectedEvent`, which only the manual link
produces. Tracked separately (Refs #2444); until fixed, treat any
`unclaimed` outcome on an event-window (`#ew<issueNumber>`) sample as
unverified rather than a genuine abandoned-claim signal.

**Baseline reset (2026-09-05)**: the tracked sample history restarted from
zero after a 2026-09-04 storage failure and host crash destroyed the prior
environment's `samples.jsonl`/`events.jsonl` state; work resumed on a backup
environment with no pre-crash history to recover (`#2623`, following
`#2566`'s round-7 attempt on the same gap). This is a data-loss event, not a
regression in the harvest/report tooling -- the "Current snapshot" figure
below reflects only samples harvested since this reset date, not a
continuation of the pre-crash round-6 baseline (`n=1`, 2026-09-02); a reader
comparing sample counts across time should expect the count to restart from
this date rather than accumulate from the earlier history.

## Current snapshot

<!-- token-cost-docs:start -->

Not yet publishable, n=1.

<!-- token-cost-docs:end -->
