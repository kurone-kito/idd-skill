# IDD — Orchestrator Phase (fan-out)

Read this file only when the activation conditions below hold or a fan-out
session restarts. The fan-out requirements live in
[Orchestrator fan-out variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant)
and in
[Orchestrator delegation](idd-claim.instructions.md#orchestrator-delegation).

## 1. Activation

A restarted session with a unique session-suffixed agent id skips this section.
Any other restart neither activates fan-out nor refills: it follows
[recovery](../../docs/idd-workflow.md#orchestrator-restart).

Activate fan-out only when all conditions hold:

- the harness's row in the
  [worker mechanism table](../../docs/idd-workflow.md#worker-delegation) has
  Eligibility `orchestrator`;
- helper support is installed, so the profile-selected `idd-worker-budget`
  command exists (`instructions-only` has none);
- the effective `orchestrator.maxWorkers` is at least 2 (the `maxWorkers` in the
  profile-selected `idd-worker-budget --running 0 --startable 0` output);
- the session is not on the lite profile;
- the session was neither started for one explicit issue (A0-T) nor asked for
  a single-issue run;
- `GITHUB_ACTIONS` is not `true`.

Otherwise, continue with [idd-discover.instructions.md](idd-discover.instructions.md)
unchanged. The cap is per orchestrator session, not per host.

## 2. Roster

One entry per worker: the issue number, claim ID, branch, the harness's worker
handle, the report draft path, and state (`running`, `reporting`,
`disposed`, or `stalled`).

## 3. Dispatch

1. Run Discover A0 through A4 Step 1.5 as written; its survivors are the
   startable candidates.
2. Call the profile-selected `idd-worker-budget` command with
   `--running <count of entries not disposed>` and
   `--startable <candidate count>`. Add `--harness-limit <limit>` from this
   harness's worker mechanism table row when it gives a numeric limit; otherwise
   omit it. Its `slots` is the number to start now.
3. If `slots` is `0`, go to section 4. Otherwise pick that many candidates with
   `discover-shared-file-overlap`, passing the survivors with `--issues`,
   `--batch <slots>`, one `--in-flight` per roster entry not `disposed`, and
   `--check-overlap`. When `discover.selectionDesync` is `session-offset`, also
   pass `--desync-token`, using the token generated once at Discover entry.
   Pass it on every refill.
4. For each pick in batch order, run A4.5, then the fresh-claim order in
   idd-claim.instructions.md through its claim verification only (worktree
   first). Then start a worker with the existing delegation brief plus the
   section 5 report request, naming that pre-created worktree, which the worker
   reuses without B1 creation. Record a `running` roster entry.
5. A pick that fails A4.5, or A5 before the claim marker is posted, has its
   worktree and branch removed and leaves `--issues`
   before any refill. A failure after the marker is posted is contested: follow
   idd-claim.instructions.md, keep its claim and worktree, and remove it from
   `--issues`.
6. Dispatched issues also leave `--issues`, so a refill cannot claim them again.
   Only a later full Discover run reconsiders a failed pick.

## 4. Waiting and refill

- On a streaming harness, handle each completion as it arrives. On a wave
  harness, wait for the whole batch. Set each finished worker's roster entry
  to `reporting` before verification.
- After each completion or wave, process `reporting` entries (§5), then call
  `idd-worker-budget` again and refill from the cached graph. Follow the Discover
  re-run cadence.
- When `slots` is `0` but candidates remain, recover `stalled` entries first. If
  every entry is `disposed` or the roster is empty, report the budget's
  `limitingFactor` and stop. Otherwise, wait for a `running` completion, or
  repeat recovery when none is running.
- When the graph in hand has nothing startable, re-run Discover as that cadence
  requires. Report and stop only when that re-run finds nothing startable and
  every roster entry is `disposed`.
- A held roster worker (not `disposed`, claim from section 3 step 4)
  gets this renewal at this section's wake-ups once due. Before each post, the
  claim revalidation gate must confirm the active claim still has its agent id
  and claim id; copy its `branch` verbatim. Then re-post `claimed-by` every 12 h
  from its latest valid one. At 72 h after its first hold comment's
  `created_at`, post `unclaimed-by` for that claim and record the hold and cap
  in the run report. Retry a failed post once; if it fails again, record it and
  leave the claim in place. Never post a second claim id.

## 5. Report and disposal

- The brief asks for a JSON draft matching `schemas/worker-report.schema.json`
  at a per-worker path outside the worker worktree, per the
  [worker final report store](../../docs/idd-helper-scripts.md#worker-final-report-store).
- Verify the outcome against live GitHub state, complete the draft, append it
  with the profile-selected `idd-worker-report append --file <path>`, then
  dispose of the worker as the table's row says and mark its roster entry
  `disposed`.
- If verification or the append fails, keep it addressable, mark it `stalled`,
  and follow the worker-specific recovery in the
  [fan-out variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant).

## 6. Worker span

A worker runs from B1 to its terminal phase: F4 under
`fully_autonomous_merge`, F2.5 otherwise.
