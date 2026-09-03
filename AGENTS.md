# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that
wire up a multi-agent issue-driven pipeline for any GitHub
project.

**Canonical reference**: The full, authoritative project guidance
lives in
[`.github/copilot-instructions.md`](.github/copilot-instructions.md).
This file contains tool-specific guidance for agents that read the
agents.md standard — currently Codex CLI, OpenCode, and Grok Build.
When Copilot-specific workflow names appear, apply the intent using your
own interaction model rather than following product terms literally.

## Minimum requirements

- Match the conversational language to the user's language.
- Write comments and documentation in English unless there is a
  clear project-specific reason otherwise.
- When editing `README.md`, also apply the equivalent change to
  `README.ja.md`, and vice versa. Keep both files in sync in the
  same commit.
- Avoid hard-coded repository file counts in docs unless the
  number is mechanically maintained. If count-based wording is
  necessary, update every mirrored reference in the same commit.
- If uncertainty, hidden risk, or missing context blocks a safe
  change, stop and ask a concise question before proceeding.
- Keep changes small and reviewable. Follow the project's
  Conventional Commits rules and keep each commit atomic.
- Do not modify community documents (`CODE_OF_CONDUCT*`,
  `CONTRIBUTING*`) without explicit approval.

## Project standards

- **Indentation**: 2 spaces
- **Line endings**: LF only
- **Trailing whitespace**: trimmed except in Markdown
- **Final newline**: always present
- **File naming**: lowercase with hyphens unless a platform
  convention requires otherwise
- **Helper sources**: the helper migration to TypeScript is complete —
  every `scripts/*.mjs` / `bin/*.mjs` is generated from a
  `src/**/*.mts` source by `pnpm run build` and committed; no
  hand-written helper `.mjs` path remains. `.mts` is the source of
  truth — edit the `.mts`, never the generated `.mjs`.
  See [docs/typescript-sources.md](docs/typescript-sources.md).
- **Inline code span wrapping**: a code span may wrap at a word
  boundary but must never wrap mid-token (right after a hyphen,
  underscore, slash, or dot the token continues through) — CommonMark
  renders the break as a literal space and corrupts the token. Put a
  command too long for one line in a fenced code block instead. If the
  wrap-point character is a hand-added artifact rather than part of
  the real value, delete it instead of just relocating the break.
  Enforced by `node scripts/audit-code-span-wrap.mjs`
  (repository-local; not distributed to `idd-template/`).
- **Bare issue/PR reference wrapping**: a bare `#NNN` reference must
  never be the first token of a paragraph, list item, or wrapped
  continuation line in prose Markdown — `dprint fmt`'s automatic
  line-wrap can relocate it there, and markdownlint's MD018 rule
  (`no-missing-space-atx`) then flags it as a malformed ATX heading.
  MD018 only fires at zero leading indentation, so it misses the same
  drift inside an indented list-item continuation line — do not rely
  on the linter alone. Prefer "issue `#NNN`" (or another phrasing that
  keeps a word before the `#`) whenever the reference could plausibly
  open a sentence, bullet, or wrapped line.

## Key workflow rules

- **Commits**: Follow
  [Conventional Commits](https://www.conventionalcommits.org/).
  A `.gitmessage` template is available at the repository root.
  Write user-facing, lowercase subjects under 72 characters, and
  split unrelated changes into separate atomic commits.
- **Branch strategy**: All changes reach `main` through pull
  requests (merge commits only). Feature branches may rebase onto
  `main` before the first PR-branch push; after publication, sync
  from `main` with a normal merge by default instead of rebasing.
  See
  [`.github/copilot-instructions.md`](.github/copilot-instructions.md#branch-strategy)
  for full rules.
- **Merge policy**: This source repository records
  `fully_autonomous_merge` as an explicit local IDD dogfooding opt-in
  against the distributed `human_merge` default
  (applies only to `kurone-kito/idd-skill`). An IDD session may
  continue through F3 merge execution only after normal claim,
  freshness, CI, advisory, review, and unresolved-thread gates
  pass.
- **Discover concurrency**: This source repository also records
  `discover.selectionDesync: session-offset` as a local IDD
  dogfooding policy (applies only to `kurone-kito/idd-skill`),
  spreading concurrent-session A4 Step 2 candidate selection across
  a same-score tie band instead of every session converging on the
  same lowest-numbered issue, to cut claim races under this
  repository's heavy concurrent-session load.
- **Advisory-convergence waiver backstop**: This source repository
  also records `ciGate.externalCheckWaivers.mode:
  "maintainer-authorized"` with `idd-advisory-convergence` registered
  under `ciGate.externalChecks.waivable` as a local IDD dogfooding
  policy (applies only to `kurone-kito/idd-skill`), giving a trusted
  maintainer a human off-ramp when the autonomous advisory-convergence
  loop cannot converge on its own (Refs #1465). See
  [`.github/copilot-instructions.md`](.github/copilot-instructions.md#local-external-check-waiver-policy)
  for the full rationale.
- **Advisory-convergence deadline**: This source repository also
  records `advisoryWait.convergenceDeadline: "PT9H"` as a local IDD
  dogfooding policy (applies only to `kurone-kito/idd-skill`),
  shortening the maintainer-authorized-waiver deadline from the
  distributed `idd-template/` default (`PT24H`) to fit this
  repository's more autonomous, higher-concurrency dogfooding setup
  (Refs #1465, #2076).
- **Secondary-bot quiet window**: This source repository also records
  `advisoryWait.secondaryBotLogin: "coderabbitai[bot]"` and
  `advisoryWait.secondaryQuietWindow: "PT1H"` as a local IDD dogfooding
  opt-in (applies only to `kurone-kito/idd-skill`), waiting up to one
  hour after E-phase convergence conditions are first observed before
  pre-merge readiness treats review as settled. This repository
  dogfoods CodeRabbit alongside Copilot and has twice hit CodeRabbit
  rate-limiting during a PR's review cycle, each time working around
  it with an ad hoc one-hour wait before merging; this config turns
  that informal practice into a proper `pre-merge-readiness` blocker
  (Refs #2335, #2410). As of #2544, the wait is conditioned on live
  review evidence rather than unconditional: once CodeRabbit has
  already posted a genuine (non-rate-limited) review for the current
  HEAD, only a short fixed confirmation buffer applies instead of the
  full hour -- a HEAD CodeRabbit has not yet reviewed still waits the
  full configured window unchanged, keeping the wait a fallback for
  genuine secondary-bot degradation rather than a tax on every merge.

## For IDD work

Open `.github/instructions/idd-overview-core.instructions.md` and the
relevant phase file before starting work. See
[docs/idd-workflow.md](docs/idd-workflow.md) for the cross-agent
entry path and phase routing. See
[Model capability expectations](docs/idd-workflow.md#model-capability-expectations)
before running this loop on a lightweight local or compact cloud model.

## Dogfood: token-cost events

This source repository records IDD phase-boundary timestamps as a local
dogfooding measurement (`docs/token-cost.md`). Source-repo only — never
add this call to `idd-template/` or `.github/instructions/` phase files,
which distribute to adopters with no token-cost data to record.

When running the IDD loop in this repository, call

```sh
node scripts/token-cost-event.mjs --stage <id> --enter --vendor <v> --issue <n>
```

when a listed stage starts, and the same with `--exit` when it ends,
using `--vendor codex` for Codex CLI or `--vendor grok` for Grok Build.
Include `--issue <n>` on every call from `claim` onward, once an issue
is claimed — omit it only for `discover`, which precedes any claim. A
call with no `--issue` is unusable for per-issue attribution (#2418):
the harvester can only join it back to an issue when the number is
recorded on the event itself. OpenCode has no matching `vendor` value
in `schemas/token-cost-event.schema.json` yet — skip this call rather
than pass a mismatched vendor. Stage ids: `discover`, `claim`, `work`,
`submit-pr`, `review`, `merge`, `cleanup`. Ignore any failure from this
command — it must never block or slow the IDD loop.

## Issue-authoring skill (dogfooded)

The canonical issue-authoring skill bundle lives at
`skills/issue-authoring/`. Edit the canonical bundle, never a
generated copy: `node scripts/sync-docs.mjs --apply` regenerates
derived copies and `node scripts/audit-docs.mjs --check` fails on
drift.

## Codex issue-authoring route

For Codex CLI, read the canonical issue-authoring bundle explicitly from
`skills/issue-authoring/`, or install one selected copy under
`.agents/skills/issue-authoring/` when the target runtime supports native
skill discovery there. The existing `.claude/skills/issue-authoring/` copy is
the dogfood route for Claude Code, OpenCode, and Grok Build
compatibility; it is not the
canonical source. Do not add checked-in `.agents/skills/` or
`.opencode/skills/` mirrors by default (preventive; no observed incident yet),
and do not assume the source path is automatically discovered by Codex.
