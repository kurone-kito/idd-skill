# IDD — Orchestrator Phase (fan-out)

Read this only when fan-out activates or its session restarts.
Requirements: [fan-out variant][fv] and
[delegation](idd-claim.instructions.md#orchestrator-delegation).

## 1. Activation

A unique session-suffixed agent id skips activation on restart; all other
restarts use section 2 recovery without refill.

Activate fan-out only when all conditions hold:

- the harness's [worker mechanism table](../../docs/idd-workflow.md#worker-delegation)
  row has Eligibility `orchestrator`;
- helper support is installed (`instructions-only` has none), so the
  profile-selected `idd-worker-budget` exists;
- the effective `orchestrator.maxWorkers` is at least 2 (read `maxWorkers`
  from `idd-worker-budget --running 0 --startable 0`);
- the session is not on the lite profile;
- the session was not started for one explicit issue (A0-T) or a single-issue
  request;
- `GITHUB_ACTIONS` is not `true`.

Otherwise, use idd-discover.instructions.md unchanged. The cap is per
session, not host.

## 2. Session scratchpad preflight and roster

Before Discover, A5, restart, refill, or dispatch, follow the
[session scratchpad lifecycle](../../docs/idd-workflow.md#session-scratchpad-lifecycle);
stop on holds. Derive worker paths from the verified root; keep the worker
missing-parent guard.

Track each worker's issue, claim, branch, handle, report path, and lifecycle
state. On restart, see
[recovery](../../docs/idd-workflow.md#orchestrator-restart).

## 3. Dispatch

1. Use the lifecycle's budgeted route for eligible already-claimed/no-dispatch
   resumes; run Discover A0 through A4 Step 1.5 only after that set is empty.
   A0-C runs once before first dispatch per Discover run, never during refills.
   Survivors are startable.
2. Call profile-selected `idd-worker-budget` with `--running <count not
   disposed>` and `--startable <candidate count>`. Add `--harness-limit
   <limit>` if the worker table sets one. Start its `slots`.
3. If `slots` is `0`, go to section 4. Otherwise, pick that many survivors
   with `discover-shared-file-overlap`, passing them as `--issues`,
   `--batch <slots>`, one `--in-flight` per entry not `disposed`, and
   `--check-overlap`. For `session-offset`, pass the Discover-entry
   `--desync-token` on every refill.
4. For each pick in batch order, run A4.5, then the fresh-claim order in
   idd-claim.instructions.md through verification only (worktree first; the
   worker runs B1). Start it with the delegation brief, a section 5 report
   request naming its report path, and the pre-created worktree it reuses
   without B1. Record a `running` entry with the returned handle.
5. A pre-marker A4.5/A5 failure removes its worktree and branch, including the
   lock. A post-marker failure is contested: follow idd-claim.instructions.md
   and keep its claim and worktree. Neither failure starts a worker or creates
   an entry.
6. Dispatched and failed picks leave `--issues` before a refill.

## 4. Waiting and refill

- Streaming harnesses handle each completion on arrival; wave harnesses wait for
  the batch. Set a finished worker's entry to `reporting` before verification.
- After each completion or wave, process `reporting` entries (§5), then re-run
  `idd-worker-budget` with `--instructions-since`, re-read changed files
  ([fv]), and refill from the cached graph, on the Discover re-run cadence.
- When `slots` is `0` but candidates remain: apply stalled recovery to
  `stalled` entries first. If an entry is not `disposed`, wait for a `running`
  completion, or repeat recovery when none is running. Otherwise, if
  `limitingFactor` is `host-load` with non-null `load1m` and `coreCount`,
  re-run `idd-worker-budget` every 60 seconds until
  the effective `orchestrator.hostLoadClearStreak` (default `3`)
  consecutive readings have `slots` above 0; a `host-load` reading resets the
  streak. Stop with the factor of any other zero-slot reading. Stop with
  `host-load` at once if a reading lacks `load1m` or `coreCount`, or once the
  effective `orchestrator.hostLoadWaitCeiling` (default `PT30M`) elapses from
  that first reading. A failed
  call stops with the factor it returned, or `api-unavailable`. Post no claim
  while waiting. After the streak, run the target-local A3 recheck, not a
  full Discover run. Otherwise, report the `limitingFactor` and stop.
- If the graph has nothing startable, re-run Discover on that cadence; stop only
  if it still finds nothing and every entry is `disposed`.
- Held workers skip §5 (variant).

## 5. Report and disposal

Verify outcome on live GitHub outside the worktree; copy the roster's
`workerHandle` into the report, then set `verifiedAt`, append-time
`recordedAt`, and applicable `reviewRounds`. Validate and append with the profile-selected
`idd-worker-report append --file <path>`, then dispose per table and mark the
roster entry `disposed`.
Without a start handle or after verification/append failure, append nothing,
mark `stalled`, and follow [fan-out recovery][fv].

## 6. Worker span

A worker runs from B1 to the merge policy's terminal phase: F4 under
`fully_autonomous_merge`, else F2.5.

[fv]: ../../docs/idd-workflow.md#orchestrator-fan-out-variant
