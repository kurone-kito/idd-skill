# IDD workflow guide

This document is the neutral entry point for the repository's
Issue-Driven Development (IDD) workflow across GitHub Copilot, Codex
CLI, Claude Code, and Gemini CLI.

Use it when you need to answer three questions quickly:

- Which repo entry file should I read first?
- Which IDD instruction files load automatically for my agent?
- When does the workflow rely on GitHub Copilot review state rather than
  on my local CLI?

## Start sequence

If you arrived here from your agent's entry file, pick up at step 2. If
you are reading this guide first, start at step 1.

1. Read the entry file for your agent or surface (see table below).
2. Read `.github/instructions/idd-overview.instructions.md`.
3. Read the phase file that matches your current state.
4. If you are editing package-specific code, also follow the matching
   scoped instruction file in `.github/instructions/`.

## Entry points and auto-load expectations

| Agent / surface         | Read first                        | Automatically available IDD context                                                                                                                                | Open manually                                                                 |
| ----------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| GitHub Copilot surfaces | `.github/copilot-instructions.md` | `.github/instructions/idd-overview.instructions.md` for execution surfaces; package-scoped `.instructions.md` files in VS Code Copilot when editing matching paths | The routed phase file when the current step changes                           |
| Codex CLI               | `AGENTS.md`                       | None from `.github/instructions/`                                                                                                                                  | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Claude Code             | `CLAUDE.md`                       | None from `.github/instructions/` by default                                                                                                                       | `.github/instructions/idd-overview.instructions.md` and the routed phase file |
| Gemini CLI              | `GEMINI.md`                       | None from `.github/instructions/`                                                                                                                                  | `.github/instructions/idd-overview.instructions.md` and the routed phase file |

## IDD file map

| File                                                       | Role                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.github/instructions/idd-overview.instructions.md`        | Shared definitions, command sets, routing table, critique-pass mapping  |
| `.github/instructions/idd-discover.instructions.md`        | Find the next viable issue, audit suitability, and start work           |
| `.github/instructions/idd-claim.instructions.md`           | Run claim pre-checks and claim verification                             |
| `.github/instructions/idd-work.instructions.md`            | Create the worktree, plan, implement, and self-review                   |
| `.github/instructions/idd-pr-submit.instructions.md`       | Rebase, validate, push, open the PR, and wait for CI                    |
| `.github/instructions/idd-ci.instructions.md`              | Shared CI polling helper used by later phases                           |
| `.github/instructions/idd-advisory-wait.instructions.md`   | Shared Copilot advisory-wait protocol (E14, F2, F3)                     |
| `.github/instructions/idd-review-snapshot.instructions.md` | E1–E3: fetch activity snapshot, run critique, check if List A is empty  |
| `.github/instructions/idd-review-triage.instructions.md`   | E4–E8: classify items, score, record dispositions                       |
| `.github/instructions/idd-review-fix.instructions.md`      | Fix accepted review items and push follow-up commits                    |
| `.github/instructions/idd-pre-merge.instructions.md`       | F1–F2: resolve conflicts and verify all pre-merge conditions            |
| `.github/instructions/idd-merge.instructions.md`           | F3–F5: execute the merge, clean up, and loop back to discover           |
| `.github/instructions/idd-resume.instructions.md`          | Route resume into crash, stalled, stale-takeover, or clean continuation |
| `.github/instructions/idd-resume-stall.instructions.md`    | Handle stalled-session recovery with a dedicated safety gate            |
| `docs/idd-review-policy-profiles.md`                       | PR review policy profiles and customization surfaces                    |
| `docs/idd-comment-minimization.md`                         | Live status digest contract and post-merge comment minimization policy  |

## Artifact taxonomy and ownership

This repository contains several AI-facing artifact types. Keep their
ownership boundaries explicit:

- **Live repository instructions**: `.github/instructions/*.instructions.md`
  are the canonical workflow rules used by this repository and drive
  the execution loop.
- **Exported template files**: `idd-template/` is the portable package
  copied into adopter repositories. When live IDD instruction files
  change, mirror the equivalent portable form into this template.
- **Agent entry files**: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
  `.github/copilot-instructions.md` are lightweight compatibility entry
  points that tell each agent where to start.
- **Workflow docs**: files under `docs/` explain architecture, policy,
  and usage. They should avoid duplicating long operational rules that
  belong in `.github/instructions/`.
- **Native skill bundles**: `SKILL.md` bundles, when present, are
  separate agent-native helpers such as `skills/issue-authoring/`. The
  canonical source bundle in this repository stays under that path; when
  adopters install it elsewhere, they should place the bundle in the
  agent-specific skill directory their runtime reads. They may reference
  the workflow docs and schemas, but they should not duplicate or
  replace the exported IDD instruction template.

Use `skills/issue-authoring/` as the canonical source bundle when you
need pre-IDD issue drafting or decomposition. Install copies of that
bundle into the agent-specific skill directory your runtime reads, then
use `.github/instructions/*.instructions.md` after the issue set is
approved and the normal Discover -> Claim -> Work loop should start. The
canonical contract and schema for the native bundle live in
`docs/issue-authoring-skill.md`.

The IDD workflow distributed from this repository is therefore an
instruction template first. Native skills can sit beside it as helpers,
but the synchronization contract for the portable workflow remains
between the live `.github/instructions/` files and `idd-template/`.

If you need to understand or change distributed timing defaults, start
with [IDD policy constants](policy-constants.md). It names the claim,
advisory, CI, and critique-loop defaults and points to the instruction
files that own each value.

When an operator gives exactly one issue target, Discover can verify that
target directly before Claim. The shortcut avoids broad roadmap
enumeration, but it still applies targeted readiness checks, the A4
viability gate, and the A4.5 suitability gate before the normal A5 claim
safety checks.

## Suitability policy handoff

A4.5 outcomes should map to explicit repository policy, not ad hoc
session choices. Keep the mapping in [Customizing IDD](customization.md)
for labels, comment-and-stop defaults, and close boundaries:

- uncertain outcomes (`unclear`, `needs-decision`, `blocked-by-human`)
  stay open by default with a concise routing comment;
- high-confidence `duplicate`, `invalid`, and `out-of-scope` outcomes
  may close only when local policy explicitly permits it;
- `idd:ready` approval ownership is separate from trusted marker actor
  authority for operational claim/review markers.

## Roadmap completion audits

Discover owns roadmap-level state. After it finds an open roadmap, it
can audit whether all explicitly referenced child work is complete
before selecting the next issue. Passing audits post a concise evidence
summary and close the roadmap; failing audits either add/link
autonomous follow-up issues or route human-dependent gaps to an explicit
blocked or needs-decision state. Roadmap-level side effects still use a
temporary claim on the roadmap issue itself, so concurrent agents do not
close or edit the same roadmap at the same time.
This roadmap claim is a coordination lock only: child issue claims stay
independent execution locks and can proceed in parallel unless blocked
by their own readiness or dependency rules. Roadmap-level blocker labels
still gate selection as described in Discover.

This audit intentionally lives before A2 rather than in F4. F4 is
limited to the PR that just merged and the local cleanup for that child
issue. F5 then loops back to Discover, where roadmap completion can be
checked with the broader parent context.

## Resume routing model

Resume now starts with a deterministic external-signal classifier before
claim-state branching. The classifier routes each run into one of four
paths: crash recovery, progress-stalled or rate-limit recovery,
stale-claim takeover, or ordinary clean continuation. This keeps crash
and stall handling separate without requiring the stalled session to
publish a final self-report.

## Live Status Digests

Use the live status digest contract in
[IDD comment minimization](idd-comment-minimization.md) when an active
run needs one human-facing current-status comment. Digest text is never
workflow evidence by itself: claim parsing, review currency, advisory
waits, CI, merge readiness, and roadmap audits still read trusted
operational markers and GitHub state.

During resume, repair a missing or stale digest only after the route and
claim state are known. Duplicate marked digests are preserved as audit
history and reported for repair; unattended agents must continue from
the authoritative markers and GitHub state rather than picking a digest
arbitrarily.

Phase files now define digest update points rather than leaving them to
agent judgment. Issue digests are refreshed after claim verification,
planning, meaningful C-loop decisions, hold, abort, and resume route
selection. PR digests are refreshed for review-fix progress, advisory
wait or CI holds, pre-merge blockers, merge failures, and post-merge
cleanup.

Agents deliberately avoid editing a PR digest between a valid E1 review
watermark and a successful F3 merge path. A digest edit can be PR
activity, so successful F2 passes carry their activity snapshot forward
without touching the digest; blocked reroutes and hold paths may update
the digest because they stop or leave merge intent anyway. The F3
awaiting-reviewer restart-F2 path is the exception: it skips digest
updates so the restarted F2 pass does not self-invalidate review
currency.

### Roadmap-claim contention playbook

Use this playbook when multiple sessions are active:

- **Do continue child execution** when a roadmap claim is present, unless
  a normal readiness gate blocks the child issue. Claims are per issue.
- **Do treat `roadmap-audit/*` as coordination-only** for roadmap
  side-effects (comment/edit/label/follow-up/close), not as a global
  execution lock.
- **Do stop and defer on fresh non-owned claims**. If a claim is active,
  non-stale, and not yours, treat it as not inheritable.
- **Do take over only stale non-owned claims** according to shared stale
  thresholds and `supersedes` rules; do not force ownership changes.
- **Do heartbeat only for owned active claims**, and release
  roadmap-audit claims promptly after roadmap-side effects finish.
- **Do not bypass blocker labels, dependency checks, or claim
  revalidation gates** while resolving contention.

## Roadmap Claim Guardrails

Roadmap-audit claims are coordination-only. Use them only while the
roadmap issue itself is being mutated, then release them once that
roadmap-side effect is complete. They are not a proxy lock for child
claims.

If the roadmap claim remains open after the roadmap-side effect is done,
or if it appears to serialize child execution, treat that as a misuse
signal: revalidate ownership and stale timing before continuing, then
heartbeat, release, or take over rather than holding the claim open.

The docs audit keeps this guidance synchronized with the exported
template so unattended runs can spot drift.

## Copilot review instruction scope

The heavy shared overview keeps `applyTo: "**"` so GitHub Copilot
execution surfaces can receive the IDD entry context automatically.
However, it also sets `excludeAgent: "code-review"` so Copilot code
review does not ingest the full operational workflow as reviewer-side
context.

This is an intentional middle path between the evaluated alternatives:
keeping review coupled to the full overview, narrowing `applyTo` and
risking execution-agent discoverability, or splitting a separate
reviewer-only instruction file. Copilot code review may still use the
lightweight repository-wide `.github/copilot-instructions.md`; only the
heavier `idd-overview.instructions.md` is excluded from review.

Some older project text may still use "skill files" as shorthand for
instructions, but the native skill bundle and execution instructions are
related rather than interchangeable surfaces.

## F2 merge-readiness evidence checklist

Before executing F3 merge, F2 must record concrete evidence for merge
readiness rather than relying on a single reviewer signal.

Required evidence fields:

1. Activity-universe snapshot values:
   `{head-SHA}`, `{max-activity-updatedAt|none}`,
   `{total-item-count}`, `{latest-ci-completed-at|none}`.
2. Unresolved-thread evidence: total unresolved threads, actionable
   unresolved count (non-awaiting-reviewer), and AMD thread presence.
3. Unreplied regular-comment evidence: count of non-IDD-agent comments
   without a later IDD-agent reply.
4. Reviewer-state evidence: latest `CHANGES_REQUESTED` states for human,
   required, and CODEOWNER reviewers, plus required approval/CODEOWNER
   satisfaction.
5. Advisory-wait evidence: AW outcome for the current HEAD, marker
   coverage (`EARLIEST_SAME_HEAD_AT`), and merge-gate satisfaction.
6. CI evidence: required-check generation and pass status for all
   required checks on the current HEAD.

Mixed reviewer ecosystems are expected. The same checklist applies
across human reviews and advisory bot surfaces (Copilot, CodeRabbit,
Codex connectors, CI bots); "one bot says clean" is never sufficient by
itself.

## Review Policy Profiles

The execution loop is cross-agent, while PR review policy is a
repository choice. See
[IDD review policy profiles](idd-review-policy-profiles.md) before
customizing the default Copilot advisory behavior.

## Default PR policy: Copilot advisory review

The core IDD flow is cross-agent, but this repository's distributed
default PR policy still includes a GitHub Copilot advisory review step
in later PR phases.

- `idd-review-fix.instructions.md` can request a GitHub Copilot
  re-review for the current PR head.
- `idd-merge.instructions.md` can wait or hold based on that GitHub
  review state.
- This dependency is on GitHub's review integration, not on every local
  agent using Copilot as its CLI.
- Adopters who do not want that default PR policy should choose another
  review policy profile, apply the matching
  `profiles/<profile>/README.md` artifact, and follow the PR review
  profile edit-surface checklist in
  [IDD review policy profiles](idd-review-policy-profiles.md).
- Expect non-default profile changes to cover review-fix, advisory-wait,
  pre-merge, merge, review-snapshot, and review-triage surfaces; the
  exact edits vary by profile.

Non-Copilot agents can still drive the workflow end to end, but they
should expect those later phases to interact with Copilot as a GitHub
reviewer because that is part of this repository's current PR policy.

## Optional helper scripts

This source repository currently ships three optional helper scripts:

- `scripts/review-activity-snapshot.mjs` (read-only E/F activity and CI
  snapshot metrics)
- `scripts/live-status-digest.mjs` (issue or PR live status digest
  dry-run and claim-checked upsert)
- `scripts/audit-pr-cleanup.mjs` (post-merge cleanup audit and optional
  apply mode)

Shell / `gh` / `jq` snippets in
`.github/instructions/*.instructions.md` remain the canonical portable
path for adopters, and the helper scripts are convenience layers only.

See [IDD helper script evaluation](idd-helper-scripts.md) for the
current inventory of high-friction query patterns, the adopted helper
scope in this source repository, and the criteria for future helper
changes.

See [IDD comment minimization](idd-comment-minimization.md) for the live
status digest helper, post-merge cleanup helper, GraphQL fallback command
shape, and merged-PR experiment for hiding completed feedback and stale
operational markers without deleting the audit trail.
