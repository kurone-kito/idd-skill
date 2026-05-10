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

During onboarding, create or update `CLAUDE.md`, `AGENTS.md`, and
`GEMINI.md` so each non-Copilot agent listed above has a stable first
file to read. GitHub Copilot remains an update-if-present surface via
`.github/copilot-instructions.md`. Skipping creation of a missing root
entry file should be an explicit operator choice, not the default.

## IDD file map

| File                                                       | Role                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `.github/instructions/idd-overview.instructions.md`        | Shared definitions, command sets, routing table, critique-pass mapping  |
| `.github/instructions/idd-discover.instructions.md`        | Find the next viable issue and audit completed roadmaps                 |
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
| `docs/idd-comment-minimization.md`                         | Post-merge comment minimization policy, commands, and experiment notes  |

## Artifact taxonomy and ownership

This exported template is instruction-template-first. Keep these
ownership boundaries explicit:

- **Live repository instructions**:
  `.github/instructions/*.instructions.md` are the canonical workflow
  rules that drive the execution loop.
- **Agent entry files**: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and
  `.github/copilot-instructions.md` tell each agent where to start.
- **Workflow docs**: files under `docs/` explain architecture, policy,
  and onboarding, but should not replace the operational instruction
  files.
- **Native skill bundles**: optional `SKILL.md` bundles may sit beside
  this template in a downstream repository, but they are separate from
  the exported instruction surface and must document their own boundary
  to the execution loop.

Some older project text may still use "skill files" as shorthand, but
these instruction files are not agent-native `SKILL.md` bundles.

The distributed workflow remains an instruction template first. Native
skills can sit beside it as optional helpers, but they do not replace
these execution-layer files.

When an operator gives exactly one issue target, Discover can verify that
target directly before Claim. The shortcut avoids broad roadmap
enumeration, but it still applies targeted readiness checks and the A4
viability gate before the normal A5 claim safety checks.

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

## Review Policy Profiles

The execution loop is cross-agent, while PR review policy is a
repository choice. See
[IDD review policy profiles](idd-review-policy-profiles.md) before
customizing the default Copilot advisory behavior.

## Default PR policy: Copilot advisory review

The core IDD flow is cross-agent, but the distributed default PR policy
still includes a GitHub Copilot advisory review step in later PR
phases.

- `idd-review-fix.instructions.md` can request a GitHub Copilot
  re-review for the current PR head.
- `idd-merge.instructions.md` can wait or hold based on that GitHub
  review state.
- This dependency is on GitHub's review integration, not on every local
  agent using Copilot as its CLI.
- Adopters who do not want that default PR policy should choose another
  review policy profile and follow
  [IDD review policy profiles](idd-review-policy-profiles.md) for the
  complete edit surface.
- At minimum, update `idd-review-fix.instructions.md`,
  `idd-pre-merge.instructions.md`, and `idd-merge.instructions.md`;
  some profiles, such as `external-bot`, require additional files.

Non-Copilot agents can still drive the workflow end to end, but they
should expect those later phases to interact with Copilot as a GitHub
reviewer because that is part of this repository's current PR policy.

## Optional helper scripts

The source repository that ships this template currently includes two
optional helper scripts:

- `scripts/review-activity-snapshot.mjs` (read-only E/F activity and CI
  snapshot metrics)
- `scripts/audit-pr-cleanup.mjs` (post-merge cleanup audit and optional
  apply mode)

Shell / `gh` / `jq` snippets in
`.github/instructions/*.instructions.md` remain the canonical portable
path for adopters, and helper scripts remain optional convenience
layers.

See [IDD helper script evaluation](idd-helper-scripts.md) for the
current inventory of high-friction query patterns, the adopted helper
scope in the source repository, and the criteria for future helper
changes.

See [IDD comment minimization](idd-comment-minimization.md) for the
post-merge cleanup helper, GraphQL fallback command shape, and merged-PR
experiment for hiding completed feedback and stale operational markers
without deleting the audit trail.
