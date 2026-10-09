# IDD — Orchestrator Phase (fan-out)

Read this file only when the activation conditions below hold. It is not
loaded by default. Everything else in the IDD loop, including Discover, Claim,
and the per-issue gates, is unchanged. The fan-out requirements themselves
live in
[Orchestrator fan-out variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant)
and in
[Orchestrator delegation](idd-claim.instructions.md#orchestrator-delegation);
this file links to them rather than restating them.

## 1. Activation

Activate fan-out only when every condition holds:

- the harness has an eligible row in the
  [worker mechanism table](../../docs/idd-workflow.md#worker-delegation);
- helper support is installed, so the profile-selected `idd-worker-budget`
  command exists (`instructions-only` has none);
- the effective `orchestrator.maxWorkers` is at least 2 (run
  `idd-worker-budget --running 0 --startable 0` and read `maxWorkers` from its
  output);
- the session is not on the lite profile;
- the session was not started for one explicit issue (A0-T), and the operator
  did not ask for a single-issue session;
- `GITHUB_ACTIONS` is not `true`.

Otherwise, continue with [idd-discover.instructions.md](idd-discover.instructions.md)
unchanged. The cap applies per orchestrator session, not per host.

## 2. Roster

Keep one entry per worker, with these fields:

- the issue number;
- the claim ID;
- the branch;
- the harness's worker handle;
- the worker's state (`running`, `reporting`, `disposed`, or `stalled`).

The roster lives in the orchestrating session. Workers do not read it.

## 3. Dispatch

1. Run Discover A0 through A4 Step 1.5 as written. The startable candidates
   are the survivors of A4 Step 1.5.
2. Call `idd-worker-budget` with `--running <roster count>` and
   `--startable <candidate count>`. Add `--harness-limit <limit>` from the
   worker mechanism table's row for this harness when that row gives a numeric
   limit, and omit it otherwise. Its `slots` field is the number of workers to
   start now.
3. Pick that many candidates with `discover-shared-file-overlap`, passing the
   survivors with `--issues`, `--batch <slots>`, one `--in-flight` per roster
   issue, and `--check-overlap`. When `discover.selectionDesync` is
   `session-offset`, also pass `--desync-token`, using the token generated once
   at Discover entry. Pass it on every refill.
4. For each pick in batch order, run A4.5, then the A5 claim, then start a
   worker with the existing delegation brief.
5. A pick that fails A4.5 or A5 frees its slot for the next refill.

## 4. Waiting and refill

- On a streaming harness, handle each completion as it arrives. On a wave
  harness, wait for the whole batch.
- After each completion or wave, call `idd-worker-budget` again and refill from
  the cached graph. Follow the Discover re-run cadence, including the
  target-local A3 recheck.
- When the graph in hand has nothing startable, re-run Discover as that cadence
  requires. Report and stop only when that re-run finds nothing startable and no
  worker is running.

## 5. Report and disposal

- The delegation brief asks the worker to end with the fields of
  `schemas/worker-report.schema.json`.
- The orchestrator verifies the outcome against live GitHub state, appends the
  record with `idd-worker-report append --file <path>`, and only then disposes
  of the worker as the worker mechanism table's row says.
- If verification or the append fails, the orchestrator keeps the worker
  addressable and follows the dead-or-stalled recovery rule in
  [idd-resume-stall.instructions.md](idd-resume-stall.instructions.md).

## 6. Worker span

A worker runs from B1 to the merge policy's terminal phase: F4 under
`fully_autonomous_merge`, and F2.5 otherwise. The worker owns its worktree
unless the harness supplied one.

The lite profile has no orchestrator variant.
