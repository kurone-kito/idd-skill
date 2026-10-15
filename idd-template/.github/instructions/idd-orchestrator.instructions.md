# IDD — Orchestrator Phase (fan-out)

Read this only when fan-out activates or its session restarts.
Requirements: [fan-out variant][fv] and
[delegation](idd-claim.instructions.md#orchestrator-delegation).

## 1. Activation

A restarted session with a unique session-suffixed agent id skips this section.
Any other restart neither activates fan-out nor refills: it follows
recovery (section 2).

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

Otherwise, continue with idd-discover.instructions.md unchanged.
The cap is per orchestrator session, not per host.

## 2. Roster

One entry per worker: issue number, claim ID, branch, worker handle, report
draft path, and state (`running`, `reporting`, `disposed`, `stalled`).

Lost on restart: see [recovery](../../docs/idd-workflow.md#orchestrator-restart).

## 3. Dispatch

1. Run Discover A0 through A4 Step 1.5 (A0-C runs once per Discover run,
   before the first dispatch; refills skip it); survivors are the startable
   candidates.
2. Call the profile-selected `idd-worker-budget` with `--running
   <count not disposed>` and `--startable <candidate count>`. Add
   `--harness-limit <limit>` when the table gives this harness a numeric
   limit. Its `slots` is the number to start now.
3. If `slots` is `0`, go to section 4. Otherwise pick that many candidates with
   `discover-shared-file-overlap`, passing survivors as `--issues`,
   `--batch <slots>`, one `--in-flight` per entry not `disposed`, and
   `--check-overlap`. When `discover.selectionDesync` is `session-offset`, also
   pass `--desync-token` (generated at Discover entry) on every refill.
4. For each pick in batch order, run A4.5, then the fresh-claim order in
   idd-claim.instructions.md through claim verification only (worktree first;
   B1 is the worker's). Start a worker with the delegation brief, a section 5
   report request naming a per-worker report path, and the pre-created worktree
   it reuses without B1. Record a `running` entry whose handle is the identifier
   the start returned.
5. A pick that fails A4.5, or A5 before the claim marker is posted, has its
   worktree and branch removed (deleting its lock). A failure after the marker
   is contested: follow idd-claim.instructions.md and keep its claim and
   worktree. Either way no worker starts, so no entry exists.
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

- The brief asks for a per-worker `schemas/worker-report.schema.json`
  draft outside the worktree, per the
  [worker final report store](../../docs/idd-helper-scripts.md#worker-final-report-store).
- Without a start identifier, mark the worker `stalled`, follow section 4, and
  append nothing. Otherwise the orchestrator verifies the outcome against live
  GitHub state, completes the draft, sets `workerHandle` to the entry's
  handle, not the draft's, appends it with the profile-selected
  `idd-worker-report append --file <path>`, then disposes of the worker per the
  table's row and marks its entry `disposed`.
- If verification or the append fails, keep the worker addressable, mark it
  `stalled`, and follow the worker-specific recovery in the
  [fan-out variant][fv].

## 6. Worker span

A worker runs from B1 to the merge policy's terminal phase: F4 under
`fully_autonomous_merge`, else F2.5.

[fv]: ../../docs/idd-workflow.md#orchestrator-fan-out-variant
