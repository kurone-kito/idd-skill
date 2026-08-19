---
type: investigation
title: "`bundle-review` split feasibility"
description: Investigates whether the standard Review path has a real session re-entry boundary a bundle-review manifest split could exploit, and recommends no-go.
tags: [investigation, context-ceiling, review-path]
---

# `bundle-review` split feasibility

Investigation for [#2193](https://github.com/kurone-kito/idd-skill/issues/2193),
originating from [#2181](https://github.com/kurone-kito/idd-skill/issues/2181)
(`bundle-review` pinned at `contextCeiling.maxBundleLimitBytes`, Option 3:
"split `bundle-review` so a subset of its seven member files is no longer
co-loaded with the rest"). This document is investigation-only — it makes
no change to `.github/instructions/*` content or `audit/sync-manifest.json`.

## Question

Does the standard (non-lite) Review path (E1-E3 review-snapshot, E4-E8
review-triage, E9-E15 review-fix) have any real session re-entry/reload
boundary today — a point where a session can end and a genuinely fresh
session can safely pick up mid-review without having just run the earlier
sub-phase itself? If not, could one be introduced without breaking the
guarantees the current continuous-session model relies on?

## Finding 1 — No re-entry boundary exists between E1-E3, E4-E8, and E9-E15 today

Every file that a resuming or continuing session would read assumes
continuous, same-session execution from the prior sub-phase:

- `idd-review-triage.instructions.md` (E4-E8) opens: "Read this file
  after `idd-review-snapshot.instructions.md` (E3) finds
  `ReviewItems_snapshot` non-empty" (line 8-10) — written as a
  continuation, not a cold-start entry point.
- `idd-review-fix.instructions.md` (E9-E15) opens the same way: "Read this
  file after `idd-review-triage.instructions.md` (E8) finds Accepted
  PATH A items" (line 8-9).
- `idd-review-snapshot.instructions.md` states explicitly that its own
  output is not meant to survive a session boundary: "`ReviewItems_snapshot`
  is session-local; don't inherit a previous claim's critique findings
  unless persisted as reviewer-visible comments" (line 233, in the E2
  incremental-review section).
- `docs/idd-workflow.md`'s Autopilot Operating Model section names
  **F4-complete / F5** as "the recommended **safe session-exit boundary**"
  (line 554) and frames Resume as recovery from "an uncontrolled failure"
  — a session dying mid-flight — converted into "a controlled handoff"
  (lines 554-561), not a planned mid-review split point. No sentence in
  that section, or anywhere else checked, names an E1-E3/E4-E8 or
  E4-E8/E9-E15 boundary as a recommended or supported session-exit point.
- `.github/instructions/idd-resume.instructions.md` — the file that
  actually drives resume behavior — contains **zero** references to
  `ReviewItems_snapshot`, `idd-review-triage`, `idd-review-fix`, `E4`, or
  `E9`. The routing table that names `idd-review-snapshot.instructions.md`
  (E1-E3) and `idd-review-triage.instructions.md` (E4-E8) as destinations
  for different live-PR states lives in
  `idd-overview-core.instructions.md` (lines 308-312), not in the resume
  file itself, and it names only which file to read next — it carries no
  procedure for reconstructing `ReviewItems_snapshot`'s actual classified
  contents (which items are PATH A vs. PATH B, which already have an E4
  score or an E6 disposition) before handing off.
- `idd-pre-merge.instructions.md`'s only "return to E1" reference (line
  250-253) describes re-running E1 within the same F2 pass when new
  review activity is detected — the same in-session-loop pattern already
  identified in this issue's Background, not a session-restart mechanic.

**Conclusion**: no real re-entry boundary exists between E1-E3, E4-E8, or
E9-E15 in the standard profile today. Every "resume"/"return to E1"
reference checked describes looping within the same session or crash
recovery back to Discover, never a documented mid-review hand-off between
these three sub-phases.

## Finding 2 — The lite-profile precedent #2181 cited does not establish feasibility

Issue #2181's Option 3 cited the lite profile's
`bundle-review-snapshot-lite` and `bundle-review-fix-lite` manifest
entries as evidence that splitting `bundle-review` by phase is workable.
Checking the lite profile's actual design narrows that claim
substantially:

`docs/idd-workflow.md`'s lite phase-mapping table (lines 301-311) lists a
lite sibling for E1-E3 (`lite/idd-review-snapshot-lite.instructions.md`)
and for E9-E15 (`lite/idd-review-fix-lite.instructions.md`) — but **not**
for E4-E8. The very next paragraph states this is deliberate: "A0-A4
Discover, A4.5 Suitability, **E4-E8 Review-triage**, and F3-F5 Merge are
**permanently excluded by design**... the design's non-goals and
phase-scoping table exclude open-ended selection, judgment-heavy
classification, and autonomous merge from the condensed profile entirely"
(lines 343-347). A lite-opted-in session reads the full, standard
`idd-review-triage.instructions.md` for E4-E8 exactly like a
standard-tier session (line 352-353).

Confirmed against the live manifest (`audit/sync-manifest.json`):

| Bundle                        | Files                                                                                                                                     | `limitBytes` |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `bundle-review-snapshot-lite` | `idd-advisory-wait-lite`, `idd-review-snapshot-lite`                                                                                      | 23,000       |
| `bundle-review-fix-lite`      | `idd-advisory-wait-lite`, `idd-ci-lite`, `idd-review-fix-lite`                                                                            | 39,500       |
| `bundle-review` (standard)    | `idd-advisory-wait`, `idd-ci`, `idd-overview-appendix`, `idd-overview-core`, `idd-review-fix`, `idd-review-snapshot`, `idd-review-triage` | 126,000      |

The lite split is a **token-budget condensation** for a weak-model
profile that deliberately excludes E4-E8 from condensation at all — it
is not evidence of a genuine three-way phase-boundary split with
independent reload points. There is no lite sibling for
`idd-review-triage.instructions.md`, so even the lite profile has no
precedent for splitting around the middle phase. #2181's Option 3
feasibility claim rests on a precedent that, on inspection, does not
cover the case it was cited for.

## Finding 3 — Whether a safe boundary could be introduced

`ReviewItems_snapshot` is not itself durably serialized anywhere (no
JSON blob in a marker comment, no structured forge state) — but its
_constituent decisions_ already accumulate as durable, reviewer-visible
GitHub state as E1-E15 progress:

- E1 Step 3's filter (`idd-review-snapshot.instructions.md` lines
  191-218) is a deterministic function of **live, durable** GitHub state:
  unresolved threads not yet answered by an IDD agent, `CHANGES_REQUESTED`
  reviews not yet replied-and-re-review-requested, and comments with no
  IDD-agent reply since. Items already handled are excluded by
  construction because they now show an IDD-agent reply.
- Review-reply comments (`<!-- idd-skill-review-reply -->`), thread
  resolution state, and the `review-baseline` / `review-watermark`
  markers already give a fresh session enough forge-durable signal to
  distinguish "already handled" from "still open," per item.

In principle this means a fresh session **could** reconstruct an
equivalent working set by re-running E1 Step 3's filter against current
live state, rather than needing the original in-memory
`ReviewItems_snapshot` object handed to it. In practice, two things are
missing before that would be a safe, documented boundary rather than an
implicit assumption:

1. No file instructs a session entering E4 or E9 cold to run this
   reconstruction first. `idd-review-triage.instructions.md` and
   `idd-review-fix.instructions.md` both assume the snapshot already
   exists from the same session's E1-E3 (or E4-E8) run moments earlier
   (Finding 1). Writing this down is itself a real specification task —
   a subtly wrong reconstruction (e.g., mishandling an item mid-E4
   classification with no reply posted yet, or an E9 fix committed but
   not yet pushed) risks silently dropping or duplicating review items,
   which is correctness-sensitive, reviewer-facing behavior.
2. Even if reconstruction were specified, the standard operating model
   (`docs/idd-workflow.md`'s "one issue = one short-lived session") never
   recommends exiting mid-review the way it explicitly recommends
   exiting at F4/F5. Introducing E1-E3/E4-E8 or E4-E8/E9-E15 as a second
   _recommended_ exit boundary is a workflow-model change, not a
   manifest change — it would need the same kind of explicit guidance
   `docs/idd-workflow.md` gives the F4/F5 boundary today, including the
   safety caveats already written for the orchestrator fan-out variant's
   worker-resume steps.

## Finding 4 — Even with a boundary, would splitting the manifest entry reduce anything real?

`bundleBudgets`' `bundle-review` entry measures the **cumulative**
byte footprint of files a continuous session's Review pass reads across
E1-E15 — which is exactly what happens today, since one session runs
E1 through E15 (and beyond, to F5) without exiting. Splitting the single
`bundle-review` manifest entry into three narrower ones (mirroring the
lite `-snapshot-lite` / `-fix-lite` naming, plus a new
`bundle-review-triage` for E4-E8) would lower what
`node scripts/audit-docs.mjs --check` measures per bundle, but a
continuously-running session executing E1 through E15 in one sitting —
the documented default — would still read all seven files' content over
the course of that pass, at the same total byte cost. The reduction is
only real for the fraction of sessions that actually exit and hand off
at one of the new boundaries, which requires Finding 3's unbuilt
reconstruction procedure. Absent that procedure, a bundle split is
accounting-only, confirming the concern raised in this issue's
Background.

## Recommendation: no-go (for now)

Do not file a bundle-review split-implementation follow-up issue at this
time. The prerequisite work — designing and instructing a correctness-safe
cold-start `ReviewItems_snapshot` reconstruction procedure for E4 and E9,
plus extending the operating model to recommend a new mid-review
session-exit boundary — is a real architectural change with real review
risk to a correctness-sensitive path (dropped or duplicated review items),
not a mechanical manifest edit. It should only be taken on if a maintainer
decides that risk is worth the headroom it would eventually buy, and even
then only for the fraction of sessions that would actually use the new
boundary.

The standing alternative for `bundle-review` headroom pressure remains
[#2181](https://github.com/kurone-kito/idd-skill/issues/2181)'s Option 2
(content diet): trimming existing cross-file restatement, as already
done once this cycle by
[#2191](https://github.com/kurone-kito/idd-skill/issues/2191) (merged,
recovered ~707 bytes via cross-reference dedup), plus
[#2190](https://github.com/kurone-kito/idd-skill/issues/2190)'s
preemptive `exemptBundles` registration as the near-term stopgap while
further diet passes are scoped. Neither touches the review-continuation
model's correctness guarantees.
