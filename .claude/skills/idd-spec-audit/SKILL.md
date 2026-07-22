---
name: idd-spec-audit
description: Repo-local, dogfood-only semantic audit of the IDD instruction corpus for leaked session context, cross-file contradictions, fresh-memory completability gaps, and automation blockers. Use only in the kurone-kito/idd-skill source repository, on request, to audit .github/instructions, skills/issue-authoring, CLAUDE.md, or .github/copilot-instructions.md. Read-only — never edits files or mutates issues.
---

# IDD Spec Audit

<!-- cspell:words soloscrum -->

## Status

**Dogfood-only.** This skill lives at
`.claude/skills/idd-spec-audit/` in the `kurone-kito/idd-skill` source
repository only. It has no canonical `skills/` source and is not a
`sync-manifest.json` `syncPairs`/`fileSets` entry, unlike
`.claude/skills/issue-authoring/` (which mirrors `skills/issue-authoring/`)
— there is nothing to distribute to adopter repositories yet. See
[Promotion checkpoint](#promotion-checkpoint-final-step) below.

`scripts/audit-docs.mjs` catches byte-level drift — sync-pair mismatches,
budgets, config-vs-instruction agreement — but not semantic drift: prose
that contradicts a sibling file, leaked session context, passages that
are not completable from a cold read, or wording that stalls an
autonomous step. This skill runs that check as N parallel LLM read
passes, adapted from `mew-ton/soloscrum`'s `define-pr-lifecycle` audit
model.

## Scope

- **Audit targets** (findings may cite these): `.github/instructions/**/*.md`
  (including `lite/`), `skills/issue-authoring/**/*.md`, `CLAUDE.md`,
  and `.github/copilot-instructions.md`. Audit these files even though
  `.github/instructions/**` is itself the generated `target` side of an
  `audit/sync-manifest.json` sync pair (mirrored from `idd-template/`)
  — this skill audits the corpus a worker session actually reads, not
  the `idd-template/` source, so being a sync target never exempts a
  file here.
- **Reference-only inputs** (read for R2/R4, never a finding target):
  `docs/idd-concept-ownership.md` (R2's closed concept-index seed) and
  `docs/idd-autonomy-contract.md` (R4's reversible/irreversible source
  of truth). Both are read in full every pass.
- **Out of scope entirely** (never read, never cited): `.claude/**`
  (this skill never audits itself) and every other file under `docs/**`
  besides the two reference-only inputs above (summary docs rely on the
  files they cite by design, so they are not audited as if they were
  the primary spec; a `docs/idd-*.md` mirror's own drift is
  `audit-docs.mjs`'s job, checked against its `idd-template/docs/`
  source, not this skill's).

## Rule sets

Run all four rule sets on every pass; do not skip one to save time. A
finding names the rule set, the file, the line or section, and a short
quote of the offending text.

### R1 — leaked session context

Flag prose that reads as belonging to one session's transcript rather
than a durable spec: time-relative phrasing without an absolute anchor
("recently", "the issue we just fixed"), first-person session voice
("I noticed", "we decided earlier"), narration of an edit instead of a
stated rule ("changed this to require X"), or a workaround described in
prose with no tracking link back to the issue that motivated it.

### R2 — cross-file contradictions (closed v1 concept index)

Compare every in-scope file against every other in-scope file for a
direct contradiction over the same concept. Check only the concepts
below — this is a **closed v1 index**; do not add concepts to it while
auditing. Expanding the index is a spec change, not an in-audit
decision — file an issue instead of widening scope mid-run. The index
is finalized against
[IDD — Concept Ownership Matrix](../../../docs/idd-concept-ownership.md)
(`#1593`):

- claim-marker and activation-nonce semantics;
- advisory-convergence satisfaction;
- merge-gate order (F2/F2.5/F3);
- the "ready = absence of `status:*` labels" definition;
- phase-digest rules;
- forced-handoff marker semantics;
- the suitability/effort footer contracts.

### R3 — fresh-memory completability

Flag a passage that a worker session starting from a cold read (no
prior conversation, no memory of another file) could not complete:
an unresolved reference ("as described above" with no anchor), an
implied prerequisite never stated as a precondition, a missing exit
condition (a loop or wait with no stated end state), or a half-named
cross-reference (a phase or marker name used before it is defined).

### R4 — automation blockers (autonomy cross-check)

Cross-check every instruction that asks an agent to pause, confirm, or
escalate against
[IDD Autonomy Contract](../../../docs/idd-autonomy-contract.md)
(`#1592`)'s reversible/irreversible classification, using that table as
the closed source of truth rather than re-deriving it from prose:

- an instruction to "confirm with the user" (or equivalent) attached to
  a mutation the contract classifies **Reversible** is a finding — its
  named undo path means no confirmation gate is needed there;
- the same phrase attached to a mutation the contract classifies
  **Irreversible** is expected behavior and must never be flagged.

A mutation with no row in the contract falls back to the contract's own
default (irreversible); that default governs the contract itself; do
not extend R4 to independently police no-row mutations beyond the two
cases above.

## Execution model

- Run **N parallel, independent, read-only** passes over the full
  scope above. Default `N = 3`; accept a `--passes N`-style argument to
  adjust it.
- **Aggregate by union**, deduplicating findings that describe the same
  file/section/issue across passes. Annotate each surviving finding
  with `Appeared in: K/N` (how many of the N passes independently
  raised it) as **informational context only**.
- **Never apply a quorum filter.** A finding raised by only one pass is
  reported exactly like one raised by all N — sampling variance is not
  evidence of invalidity, and dropping low-`K` findings would silently
  discard true positives that one pass framed differently from the
  others.
- **Read-only, always.** This skill never edits an in-scope file and
  never opens, closes, comments on, or labels a GitHub issue. Every
  finding routes back through the normal issue-authoring flow (see the
  `issue-authoring` skill) for a human or a later session to act on.
- Write the aggregated result using
  [references/report-template.md](references/report-template.md).

## See also

- [references/report-template.md](references/report-template.md) for
  the report shape.
- [IDD Autonomy Contract](../../../docs/idd-autonomy-contract.md) —
  R4's closed source of truth.
- [IDD — Concept Ownership Matrix](../../../docs/idd-concept-ownership.md)
  — R2's concept-index seed.

## Promotion checkpoint (final step)

After emitting the report, always end the run by reminding the
maintainer of this skill's status and asking whether to decide now on
promoting it to distributed status (moving it into `skills/` with a
canonical source and sync pairs, alongside `issue-authoring`).

**When promotion is adopted**, removing this checkpoint section — and
the "Dogfood-only" status note above — is part of the promotion change
itself; do not carry a stale self-reminder into a distributed skill.
