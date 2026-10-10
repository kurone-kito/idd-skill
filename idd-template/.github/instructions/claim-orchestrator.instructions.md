# IDD — Claim Phase: Orchestrator delegation

Read this file only when this session is an orchestrator that delegates a
verified claim to a subagent worker. [idd-claim.instructions.md](idd-claim.instructions.md)
points here from its Orchestrator delegation section.

An orchestrating session that has posted and verified a claim's
`{agent-id}` / `{claim-id}` pair may delegate it verbatim to an
isolated subagent worker in the delegation brief. The worker adopts
both fields verbatim as its own claim token — mirroring the adopt-verbatim
rule in [idd-claim.instructions.md](idd-claim.instructions.md) — instead of
minting a fresh claim or being treated as claim-less; see the
ownership-proof exception in
[Claim-state parsing](idd-claim.instructions.md#claim-state-parsing).
No separate `claimed-by` post is required for the delegation itself.

**Carry the nonce, don't mint one — and still revalidate it.** The
brief must also carry the orchestrator's current activation nonce
verbatim; minting a new nonce for the same `{claim-id}` creates the
exact two-nonce collision step 4 of [Claim verification](idd-claim.instructions.md#claim-verification)
exists to catch, flagging
legitimate delegation as a second activation. The worker still
performs the Claim revalidation gate's nonce check
(`idd-overview-core.instructions.md`) using the carried value: before
each mutation, recompute the nonce winner for the `{claim-id}` and
confirm it still equals the carried nonce. A different winner (e.g. a
later forced-handoff collision the orchestrator never saw) means the
worker is no longer the winning activation — treat that the same as any
other lost claim.

**State the worker role explicitly when the delegate inherits full
context.** Some delegation mechanisms give the worker the
orchestrator's own complete conversation context instead of a clean
slate limited to the brief. There, the worker can carry over the
orchestrator's own framing — mistaking itself for the session that
launched several workers and is waiting on their replies — instead of
recognizing the brief reassigns it to a single-issue worker role. The
delegation brief must state explicitly that the delegate is the sole
worker for the named issue, that no peer workers exist for it to
coordinate with or wait on, and that it must perform the implementation
work itself rather than re-delegate or wait for a reply (#2179). Use a
non-context-inheriting mechanism whenever the tool offers one — this
is a strong preference, not a suggestion; a context-inheriting
mechanism (e.g. forking the orchestrator's own conversation) is a
fallback only when no non-context-inheriting option exists. See
[docs/idd-workflow.md's Orchestrator fan-out
variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant).

**Known limitation.** Neither this wording nor an added negative
instruction reliably stops a context-inheriting delegate from
misreading itself as a sub-orchestrator waiting on a nonexistent
sub-worker (#2802) — an accepted residual risk of the fallback path;
see
[docs/idd-design-rationale.md](../../docs/idd-design-rationale.md#context-inheriting-delegation-residual-risk)
for the field evidence.

**Restate the CI/advisory-wait wake-up discipline.** Carry —
verbatim or by reference — both mitigations from
[idd-ci.instructions.md's Wake-up
discipline](idd-ci.instructions.md#wake-up-discipline): the
topology-safety condition (#2210; also in
[docs/idd-workflow.md's Orchestrator fan-out
variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant))
and the execution-timeout override for a heavy or long-running local
command (#2933).

**Restate the scratchpad file-naming requirement.** See
[docs/idd-workflow.md's Orchestrator fan-out
variant](../../docs/idd-workflow.md#orchestrator-fan-out-variant):
each worker must prefix scratchpad filenames with the issue number,
or use an issue-numbered subdirectory.
