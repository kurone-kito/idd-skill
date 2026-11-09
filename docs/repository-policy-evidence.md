---
type: reference
title: Repository Policy Evidence
description: Records the evidence, measurements, and decisions behind this source repository’s local IDD dogfood policies.
tags: [policy, dogfood, measurement]
---

# Repository Policy Evidence

This source-only page preserves the rationale, history, measurements, and
detailed decisions behind the concise policies in
[AGENTS.md](../AGENTS.md#key-workflow-rules). It is not part of the adopter
template.

## Merge policy

This source repository records
`fully_autonomous_merge` as an explicit local IDD dogfooding opt-in
against the distributed `human_merge` default
(applies only to `kurone-kito/idd-skill`). An IDD session may
continue through F3 merge execution only after normal claim,
freshness, CI, advisory, review, and unresolved-thread gates
pass.

## Discover concurrency

This source repository also records
`discover.selectionDesync: session-offset` as a local IDD
dogfooding policy (applies only to `kurone-kito/idd-skill`),
spreading concurrent-session A4 Step 2 candidate selection across
a same-score tie band instead of every session converging on the
same lowest-numbered issue, to cut claim races under this
repository's heavy concurrent-session load.

## Advisory-convergence waiver backstop

This source repository
also records `ciGate.externalCheckWaivers.mode:
"maintainer-authorized"` with `idd-advisory-convergence` registered
under `ciGate.externalChecks.waivable` as a local IDD dogfooding
policy (applies only to `kurone-kito/idd-skill`), giving a trusted
maintainer a human off-ramp when the autonomous advisory-convergence
loop cannot converge on its own (Refs #1465): once the configured
convergence deadline (default 24h) has elapsed from when GitHub first
recorded the current PR HEAD (its earliest check suite), a trusted
maintainer can post a valid
external-check waiver for `idd-advisory-convergence` to unblock the
gate. Treat this the same as any other merge-gate bypass — a
deliberate, short-lived, maintainer-authorized exception for a
genuinely stuck check, not a routine substitute for a fresh Copilot
review. See [Customizing IDD](customization.md) and
[docs/idd-helper-scripts.md](idd-helper-scripts.md#external-check-waiver-contract)
for the general mechanism.

## Advisory-convergence self-referential-bootstrap-auto waiver

A
second, narrower `idd-advisory-convergence` bypass alongside the
maintainer-authorized one above (Refs #2657): when a PR's own diff
touches this check's committed bootstrap trigger files (its waiver
trust path, policy inputs, or workflow files) and none of its
decision-rule files, a dedicated CI job
auto-posts a run-bound waiver as `github-actions[bot]`, verified
against the GitHub Actions runs API and this PR's own changed files
before it is trusted. Unlike the maintainer-authorized waiver, this
one is evaluated **unconditionally** — it can make `ready` true
immediately, with no fresh Copilot review and before the
convergence deadline elapses — because its whole purpose is
bootstrapping a fix to the checker (including the deadline mechanism
itself) while a PR editing it is still unmerged. It exists only for
that narrow trigger set, never as a general substitute for review.
A diff that touches one of the check's decision-rule files gets no
such waiver; it needs a converged review, an approval of its HEAD
from a `trustedMarkerActors` login, or the maintainer-authorized
waiver after the deadline or while Copilot is terminally unavailable
(issue `#4015`). See
[docs/idd-helper-scripts.md](idd-helper-scripts.md#automated-self-referential-bootstrap-auto-waiver-kurone-kitoidd-skill2657)
for the full trust model.

## ciGate F2 bootstrap

This source repository follows the
distributed preload-first procedure in
[ciGate F2 bootstrap](customization.md#cigate-f2-bootstrap)
when a new `ciGate.*` key must land before F2 can honor it (observed
on `kurone-kito/kurone-kito#33` and `kurone-kito/kurone-kito#37`).
Do not generalize issue `#2657`'s self-referential-bootstrap-auto
waiver to an arbitrary `ciGate.*` key.

## Advisory-convergence deadline

This source repository also
records `advisoryWait.convergenceDeadline: "PT9H"` as a local IDD
dogfooding policy (applies only to `kurone-kito/idd-skill`),
shortening the maintainer-authorized-waiver deadline from the
distributed `idd-template/` default (`PT24H`) to fit this
repository's more autonomous, higher-concurrency dogfooding setup
(Refs #1465, #2076).

## Secondary-bot quiet window

This source repository also records
`advisoryWait.secondaryBotLogin: "coderabbitai[bot]"` and
`advisoryWait.secondaryQuietWindow: "PT5M"` as a local IDD dogfooding
opt-in (applies only to `kurone-kito/idd-skill`), waiting up to five
minutes, measured from the last substantive activity, after E-phase
convergence conditions are first observed before pre-merge readiness
treats review as settled. The window was first set
to one hour (`PT1H`, commit `c0909776c`, 2026-09-02) and was shortened
to five minutes for the reasons in the 2026-10-13 measurement below
(issue `#4167`). This repository
dogfoods CodeRabbit alongside Copilot and has twice hit CodeRabbit
rate-limiting during a PR's review cycle, each time working around
it with an ad hoc one-hour wait before merging; this config turns
that informal practice into a proper `pre-merge-readiness` blocker
(Refs #2335, #2410). As of #2544, the wait is conditioned on live
review evidence rather than unconditional: once CodeRabbit has
already posted a genuine (non-rate-limited) review for the current
HEAD, only a short fixed confirmation buffer applies instead of the
full wait -- a HEAD CodeRabbit has not yet reviewed still waits the
full configured window unchanged, keeping the wait a fallback for
genuine secondary-bot degradation rather than a tax on every merge.
As of #2547, a definitive decline verdict for the current HEAD -- a
rate-limit or skip-review notice with no genuine comment after it --
is checked before that #2544 short-buffer path and completes the
wait immediately -- zero delay, not even the confirmation buffer:
once CodeRabbit has conclusively said it will not review this
commit, #2335's "might still be mid-review" protection has nothing
left to protect.
Measured 2026-10-13 (issue `#4167`): of 9 open pull requests, the
window was the only blocker on none, and it was among the blockers on
one (pull request `#4154`, 60 minutes remaining after activity at
05:49:04Z, plus four other blockers: unresolved threads, missing
dispositions, a missing watermark, and failing or pending CI). Of 16
merged pull requests that could be read, the time from the head commit
to merge had a median of about 27 minutes. CodeRabbit declined (rate
limit) on 8, reviewed the head on 2, and was silent on 6; silent pull
requests merged after a median of about 21 minutes, with a maximum of
43 minutes. A late CodeRabbit wave does happen: on pull request `#4131`,
one CodeRabbit event came more than five minutes after its first review
on the head. The evidence sets the floor: `docs/policy-constants.md`
records that on pull request `#2330`, findings landed 34 seconds and 2
minutes after a zero-unresolved snapshot, so a one-minute window would
have missed that case. A one-minute value was considered and rejected,
because it would clamp both waits to one minute and the measured evidence
does not support that. `PT5M` matches the settled buffer
(`SECONDARY_QUIET_WINDOW_SETTLED_BUFFER_MINUTES`), so one value sets both
waits to five minutes. The weekly merged-pull-request feedback sweep
(issue `#4166`, `.github/workflows/merged-pr-feedback-sweep.yml`,
scheduled Mondays at 06:00 UTC) is the safety net for late reviews that a
shorter window lets through, and it is already on `main` when this value
lands.

## New-CI-job dispatch-first rollout

`idd-pr-submit.instructions.md`'s
D2 "Adding a new CI job" guidance (distributed via `idd-template/`, not
itself local) requires landing a new CI job `workflow_dispatch`-first.
This source repository also records, as a local IDD dogfooding policy
(applies only to `kurone-kito/idd-skill`), the motivation for that
guidance: this repository's own `copilot_code_review` ruleset, whose
Copilot/Codex review cost tracks push count roughly 1:1 regardless of
which CI jobs a push touches -- landing a new job
`workflow_dispatch`-first does not reduce that review-cost line item
by itself, but avoids wasted CI Actions-minutes and false-failure
noise from an unproven job auto-running on every unrelated push. See
that guidance (and its linked rationale entry) for the mechanics
rather than duplicating them here. Refs #2892 (non-blocking).

## Critique-loop telemetry hook

This source repository also
records `critiqueLoop.telemetryHook.command:
"idd-critique-telemetry"` as a local IDD dogfooding policy (applies
only to `kurone-kito/idd-skill`). Roadmap #2677 and its children
issues #2678-#2680 built the `critiqueLoop.telemetryHook` mechanism
as a distributed, opt-in per-operator feature, but that roadmap's
own scope stopped at the mechanism and never configured it for this
repository. Observed 2026-09-14, issue #3001: an in-repo audit found
`critiqueLoop.delegate` already configured and in genuine, frequent
use, while C1's own effectiveness at mitigating E-phase Copilot
review cost -- the purpose `docs/idd-design-rationale.md` documents
for the critique loop -- had zero observability. The configured
command is the bare name `idd-critique-telemetry`, not a hardcoded
absolute path, because this file is committed to a public repository
and a personal `/home/<user>/...` path would silently fail for any
other operator or a remote/cloud agent that never reads this
operator's `$HOME` (preventive; no observed incident yet).
`idd-critique-telemetry` itself is expected to come from an
operator's own external tooling (this repository ships the
`idd-critique-telemetry-hook` resolver that invokes it, never the
collector binary itself), mirroring how `critiqueLoop.delegate`'s
configured command already points at an external, not-shipped-in-repo
binary. Per
[docs/idd-workflow.md](idd-workflow.md#repository-configurable-critique-telemetry-hook)'s
fire-and-forget contract, an operator or remote/cloud agent without
that binary on `PATH` gets a silent no-op, the same as leaving the
hook unconfigured, rather than a failure.

## Gist-retrospective field-feedback label

This repository applies
the `feedback:idd-core` label to every "IDD loop field-feedback
intake" gist-retrospective roadmap (title beginning with `roadmap:
IDD loop field-feedback intake`) and every child issue linked from
its `## Tracks` list, at authoring time alongside the normal
`status:authoring` hold label. The label is visibility-only -- it
lets a maintainer find and review these issues with extra scrutiny,
since they originate from second-hand narrative gist material about
another repository rather than a locally reproduced observation --
and it must never gate Discover, Claim, or any other autopilot
phase. It is a distinct axis from the adopter-side
`status:upstream-candidate` label (roadmap `#2700`): that label
stays local to each adopter repository and is never applied in
`kurone-kito/idd-skill` itself; `feedback:idd-core` is the
source-repo-side counterpart applied once the maintainer has already
decided to report the observed problem here.

## Adopt-now urgency defer

This source repository also records
`critiqueLoop.deferByUrgency: "severity-tiered"` as a local IDD
dogfooding policy (applies only to `kurone-kito/idd-skill`).
`low` and `low-and-medium` still never defer High.
`severity-tiered` scores urgency `very-low` < `low` < `medium` <
`high` and at step 0 defers otherwise-unblocked High findings only at
`very-low` (issue `#3589`).
At review count 3, below the first threshold 4 but at the cap, the
cap defers otherwise-unblocked High findings at every urgency;
safety-class findings and other block reasons retain their verdicts.
The gradient acts only when
`deferByUrgency` is `severity-tiered`. This repository opts in
with `critiqueLoop.deferRelaxAtRounds: [4, 7]`. Over the 100
merged pull requests numbered #3561 to #3781 (merged 2026-09-27
to 2026-10-05), the median PR-wide Copilot review count was 2,
and 30 reached a 4th review, 25 a 5th, 14 a 7th and 10 a 9th, so
the first threshold leaves a typical pull request unchanged and
the second acts only on the long tail. With the cap at 3, neither
count threshold changes standard-profile verdicts because the cap
takes effect first. At counts 1 and 2, current-head convergence can add
one step and let otherwise-unblocked High findings with `low` urgency
defer. A follow-up filed by the
gradient carries the existing `review-fix-loop-cutoff` marker.
The motivating observation is
[kurone-kito/setup.ubuntu#201](https://github.com/kurone-kito/setup.ubuntu/issues/201).
The earlier opt-in was `low-and-medium` (issue `#3222`): a 60-PR
baseline (`#3089`-`#3210`) found all 11 Low-only reviews and 25
Medium-highest reviews followed by another Copilot review wave.
As of the 2026-09-24 observation,
`critiqueLoop.deferAfterRounds` (this repository's own local
`5`) had never fired because most review waves happened well
before that round threshold. A later count over the same #3561
to #3781 range found that 25 of 100 pull requests reached a 5th
Copilot review, and none of the 7 deferral replies in that range
carries a `round <r>/5` clause. See
[docs/idd-design-rationale.md](idd-design-rationale.md#e4e5-adopt-now-urgency-defer)
for the baseline and the severity-tiered matrix.

## Review-count cap

This source repository sets
`critiqueLoop.deferAllAfterRounds: 3` only for
`kurone-kito/idd-skill`; `idd-template/` leaves the field unset (cap
off). Under `critiqueLoop.deferByUrgency: "severity-tiered"` and
outside Lite, a scored PATH A finding at or above the PR-wide
Copilot review-count cap defers at every urgency unless it is
safety-class or another documented block reason applies; adopt-now
condition (d) does not turn the verdict into `keep`. The cap acts
regardless of whether `deferRelaxAtRounds` is configured. See the
[Review-count cap paragraph](idd-review-policy-profiles.md#wave-gradient-urgency-defer).
Evidence measured 2026-10-27 across at least 1,777 Copilot reviews
on 464 pull requests (only the first 100 reviews per pull request,
so review counts are lower bounds): caps 2, 3, 4, and 5 would have
removed at most 1,004, 806, 659, and 547 counted reviews
(56.5%, 45.4%, 37.1%, and 30.8% of reviews; 73.4%, 62.8%, 53.1%,
and 44.7% weighted by changed lines). Those shares are upper bounds
over the lower-bound counts, assuming no review after each cap.
With `deferRelaxAtRounds: [4, 7]`, at counts 3 and above findings
either defer through the cap or remain kept by an existing block,
so the relax steps change no verdict. The thresholds act only
through the converged extra step at counts 1 and 2.
`deferAfterRounds: 5` still acts on Lite-profile claims because the
cap is off there. With `triageRecord: "enforce"`, an Accepted reply
whose otherwise-unblocked verdict is `defer` needs
`--override "<reason>"`; existing block reasons retain their verdict
and do not need an override. The weekly audit records a reply with the
override as an override. Remove `critiqueLoop.deferAllAfterRounds`
to opt out.

## Triage record opt-in

This source repository sets
`critiqueLoop.triageRecord` to `"enforce"` as a local IDD dogfooding
policy (applies only to `kurone-kito/idd-skill`), switched under issue
`#4208` from the `"record"` value set by pull request `#4508` (issue
`#4461`), merged 2026-10-18; `idd-template/` keeps the distributed
default `"off"`, so adopters are unchanged. The opt-in was first
deferred because `advisory-convergence` printed
`resolve-review-thread --apply` pointers without the `--tier` and
`--urgency` flags that `record` requires for an Accepted or Rejected
reply, so `resolve-review-thread` refused those pointers. Observed
2026-10-16 on pull request `#4405` (Copilot discussion `r4288841711`).
Pull request `#4500` (issue `#4481`), merged 2026-10-18, made
`advisory-convergence` add both flags to those pointers when the value
is `record` or `enforce`, which unblocked the opt-in. With `record` or
`enforce`, `resolve-review-thread` requires `--tier` and `--urgency` on each
applied Accepted or Rejected PATH A reply, except a `--path-b` reply or
a `**Rejection confirmed by maintainer**` reply. The helper writes a
`Triage:` line for
each reply that carries both flags, in any mode. The reason for the
switch: `record` posts an Accepted reply whose verdict is `defer`, and
the weekly review-policy audit counts each one as a recorded triage
contradiction. The scheduled run of 2026-10-26 (
[run `40284373227`](https://github.com/kurone-kito/idd-skill/actions/runs/40284373227))
failed with `5 recorded triage contradiction(s)`. The scheduled run of
2026-10-19 (
[run `39214309218`](https://github.com/kurone-kito/idd-skill/actions/runs/39214309218))
failed on parser drift that pull request `#4543` fixed, so it does not
count toward the switch. With `"enforce"`, an applied (`--apply`)
Accepted reply whose verdict is `defer` is refused by
`resolve-review-thread` unless `--override "<reason>"` gives a reason.
Replies posted without the helper are not covered. This applies here
because `critiqueLoop.deferByUrgency` is
`"severity-tiered"`; under any other mode the helper treats `enforce`
as `record`. To opt out, set the field back to `"record"` or `"off"`,
or remove it. Evidence for the `record` opt-in: among the 100
pull requests that were merged at or before 2026-10-13T06:58:55Z and
are numbered `#3936` to `#4158`, six
deferral-form replies appeared on four pull requests, and one of 535
review-thread replies that begin with `**Accepted**` or `**Rejected**`
recorded an urgency. Two conversation replies, on `#3966` and `#4044`,
also recorded urgencies, outside that count (item 2 of the subsection).
See the
[review-loop audit (2026-10-13)](idd-design-rationale.md#review-loop-audit-2026-10-13)
subsection of the design rationale.

## E10 converged-review opt-in

This source repository sets
`critiqueLoop.e10SkipOnAdvisoryConvergence` to `true` as a local IDD
dogfooding policy (applies only to `kurone-kito/idd-skill`, opted in on
2026-10-27; issue `#4761`). `idd-template/` keeps the distributed default
`false`, so adopters are unchanged. On the standard profile, a review-fix
batch whose Accepted PATH A items all come from `advisoryBotLogins` bots
other than the primary advisory bot skips E10 once advisory-convergence has
converged on the pushed head. The lite profile always runs E10. Evidence,
from the pull requests that received Copilot reviews from 2026-10-01 to
2026-10-26 and measured on 2026-10-27 (lower bounds, because at most 100
reviews per pull request were read): of at least 1,311 Copilot re-reviews
of a new head, 112 followed a Copilot review with no inline comment and a
Codex or CodeRabbit review of that same earlier head, and in 103 of those
the Codex or CodeRabbit review had an inline comment. The trade-off
(preventive; no observed incident yet): a defect that E10 would have found
before the push is found after it, by Copilot or by E2, and its fix costs
another push. Turn the opt-in off when a Copilot or other advisory bot
finding on a later head points at a fix commit of a skipped batch. Find
that batch through the `E10 critique skipped` sentence in its E13 replies.
E2 findings stay in the session and are not posted, so they are not a
signal. Removing the field or setting it to `false` restores E10 for every
batch.

## Effort L refusal opt-in

This source repository also records
`autopilotSuitability.effortL: "refuse"` as a local IDD dogfooding
policy (applies only to `kurone-kito/idd-skill`); `idd-template/` keeps
the distributed default `"allow"`, so adopters are unchanged. With
`refuse`, `effort-l-ready` rejects a ready `L` child or orphan body unless
it is routed to a matching human bucket; roadmap bodies are exempt. Discover
routes only `L` orphan candidates to humans, not roadmaps or roadmap children.
To turn this off, remove the field or set it to `"allow"`. Evidence: in
the same 100-pull-request cohort as the bullet above, 6 of the 8 pull
requests whose issue has effort `L` reached 7 or more Copilot reviews,
against 2 of the 33 pull requests with effort `S`. The `L` group is only
8 pull requests. The subsection does not separate pull request size from
effort: changed lines and Copilot review count have a Spearman correlation
of 0.57 over the cohort, and the 20 pull requests with 7 or more reviews
have a median of 967.5 changed lines, against 122.5 for the 64 with at
most 3 (item 5). Item 7 gives the effort groups. See the
[review-loop audit (2026-10-13)](idd-design-rationale.md#review-loop-audit-2026-10-13)
subsection of the design rationale.

## GitHub API load control

This source repository also records
`githubApi.loadControl: { enabled: true, maxConcurrent: 4 }` in
`.github/idd/config.json` as a local IDD dogfooding policy (applies
only to `kurone-kito/idd-skill`); `idd-template/` keeps the distributed
default off, so adopters are unchanged. Roadmap `#3583` dogfoods each
delivered capability here first, and this repository runs many
concurrent sessions as one OS user, the case the host-local admission
layer is for (motivating episode: the 2026-09-27 GraphQL rate-limit
report in issue `#3560`; most of the failing commands it lists were
typed by an agent, which load control does not cover). The value was
measured, not guessed (issue `#3702`, 2026-10-01): four parallel
`discover-roadmap-graph --all-roadmaps --with-claim-state
--with-readiness --with-progress --no-cache` scans (each at its own
`--concurrency` of 8) against a fresh state directory per row took, at
`maxConcurrent` 8, 4, 2 and 1, a slowest scan of 9.9, 14.5, 23.1 and
43.7 seconds, all sixteen scans exited 0 and none reported a `deadline`
interruption. The smallest value within twice the 8 row (19.8
seconds) is 4, so that is the cap; the full table is in the PR that
enabled it. Exposure: a write or unclassified request that meets a
full slot is refused at once with nothing sent, and a read that waits
out `maxWait` (`PT30S` by default) with every slot held is refused
too, which a scan reports as a `deadline` interruption; a standard
Discover scan, which passes no `--with-progress`, surfaces that
refusal as an error instead of a recovery result. To turn it off,
remove the `loadControl` entry or set `enabled` to `false`; a refused
request (`notDispatched`) in a real session is the signal to do so
(preventive; no observed incident yet).
See [docs/idd-helper-scripts.md](idd-helper-scripts.md#github-api-load-control)
for the mechanism.

## Local validation admission

On non-Windows hosts, this repository uses
the Pueue group `idd-skill-validate` with a cap of `2` when the daemon is
available. The helper creates a missing group with that cap and warns while
preserving an existing group with a different cap. If the Pueue client is
missing, it falls back to serial `flock`. A failed, timed-out, or unreachable
daemon health check exits `69` without taking the flock lock or starting the
command (issue `#5115`). On Windows, the helper keeps its existing direct-run
behavior. While Pueue is available, this repository's Pueue group is separate
from the shared `flock` admission domain used by other repositories. If the
client is missing, this repository's fallback joins that shared `flock` domain.
This repository-only choice adds no daemon start or shutdown and no group
resizing. It follows the lock inheritance fix for issue `#5036` in PR `#5038`.

## Orchestrator worker cap

This source repository also records
`orchestrator.maxWorkers: 4` in `.github/idd/config.json` as a local IDD
dogfooding policy (applies only to `kurone-kito/idd-skill`);
`idd-template/` keeps the distributed default of 2, so adopters are
unchanged. The value is measured, not guessed: over the 100 pull requests
merged from 2026-09-29 to 2026-10-07 (`#3608` to `#3815`), the number of
pull requests open at once had a median of 2, a 90th percentile of 4, and a
maximum of 9. The cap is per orchestrator session, so concurrent
orchestrator sessions multiply it, and only the host and GitHub API checks
in `idd-worker-budget` (load, memory, and REST or GraphQL rate-limit
headroom) limit the total. To opt out, remove the
`orchestrator` field and the `orchestrator-worker-cap-dogfood` rule together,
because the rule pins the value to exactly 4 and the field alone is not
enough (refs `#3839`).

## Live status digest

This source repository does not use a live
status digest. This is the operator's recorded choice (option 2,
decided in an issue-authoring hearing outside this repository; see
issue `#4736`). The recorded choice overrides the auto-detection in
the [Live Status Digest Contract](idd-comment-minimization.md#live-status-digest-contract),
which applies only when neither the operator nor the repository has
chosen. The per-run summary is no longer posted, and the A5 claims on
issues `#4468`, `#4502`, and `#4721` already ran without a digest
(checked 2026-10-28). Existing digests are not edited, and the digest
helper stays available for explicit use. This bullet replaces the
earlier digest-use statement from PR `#4527`. `idd-template/` is
unchanged, so adopters keep the distributed behavior.

## Provisional decision opt-in

This source repository sets
`dangerouslyAutoDecide: true` in `.github/idd/config.json` as a local
IDD dogfooding policy (applies only to `kurone-kito/idd-skill`).
`idd-template/` leaves the field unset, so adopters keep the default
`false`. PR `#4897` set the flag, merged 2026-11-01. At a hearing the
same day, recorded in roadmap `#4955`, the operator chose to keep it
and to use the feature actively for dogfooding. As of 2026-11-03 no
code reads the flag for behavior; the execution children of
roadmap `#4528` (issues `#4533`, `#4535`, `#4538`, and `#4539`) and
its transition helper (roadmap `#4722`) will. Roadmap `#4955` adds a
repository-only switch for each class of stop. Once those switches
exist, the flag alone starts no new provisional work, because a class
acts only when its own switch is also `true`. The gates that
roadmap `#4528` lists stay in force: the flag supplies no credential,
permission, approval, or scope expansion, and waives no CI, review,
standing reviewer, claim or ownership, security, destructive-operation,
branch, effort, or authoring-release gate. The only exceptions are the
two that roadmap `#4528` records for the worktree-remnant and
B1-leftover classes: while that class's own switch is on, it may act
on a claim, ownership, or destructive-operation stop, and only through
a remedy that first saves everything (a stash, a backup ref, or a
preserve directory) before it removes anything. This repository
departs on purpose from the adopter advice in
[Provisional Decision Opt-in](customization.md#provisional-decision-opt-in),
which says to keep the flag absent or false until the complete
lifecycle is available and the repository has opted in; that advice
stays for adopters. To opt out, set `dangerouslyAutoDecide` to `false`
in `.github/idd/config.json`, or remove the field, which then defaults
to `false`.
The five auto-decide classes of roadmap `#4955` are on as well, under
`autoDecide` in `.github/idd/config.json`: `decisionIssue`, `runtimeQuestion`,
`authoringChoice`, `worktreeRemnant`, and `b1Leftover`. The four classes other
than `decisionIssue` file a confirmation issue labeled
`status:needs-confirmation` for the operator to review afterward.
`decisionIssue` confirms its pickup choices on the needs-decision source issue
instead. No other auto-decide class is defined, so none stays disabled. The
cap and the quiet window keep their defaults. The hearing left these stops in
force: safety and ownership stops (claim conflict or loss, wrong base branch);
authority stops (a CODEOWNER or required reviewer, `human_merge`, credentials,
authoring release); quality gates (CI, review threads, advisory convergence);
waits (rate limits, quiet windows); and scope or suitability rejections. The
worktree-remnant and B1-leftover classes replace two fail-closed defaults once
their consumers land: the §LWR operator attestation and the B1 manual-cleanup
stop. Each saves the data before it removes anything, to the stash tagged
`idd-lwr <claim-id>`, the backup refs `refs/idd-lwr/<branch>` and
`refs/idd-b1/`, `<state>/idd-skill/lwr-preserved/`, or
`<state>/idd-skill/b1-preserved/` (preventive; no observed incident yet). Turn
a class off when a confirmation issue is answered with a different choice, or
when a removed worktree turns out to be in use. To opt out, set a class's
`enabled` to `false` or remove `autoDecide`. The hearing was held on
2026-11-01 and is recorded in roadmap `#4955`.
