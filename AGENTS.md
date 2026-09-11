# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that
wire up a multi-agent issue-driven pipeline for any GitHub
project.

This file is the canonical, tool-neutral instruction source for AI
coding agents in this repository, following the
[AGENTS.md](https://agents.md) open standard that Codex CLI, OpenCode,
Grok Build, and GitHub Copilot (CLI, coding agent, and Chat) all
discover automatically at the repository root. `CLAUDE.md` and
`GEMINI.md` are thin adapters that import this file for Claude Code and
Antigravity CLI (formerly Gemini CLI), the two tools in this
repository's harness mix that read their own dedicated entry file
instead, and
[.github/copilot-instructions.md](.github/copilot-instructions.md)
carries only the small amount of guidance specific to GitHub Copilot's
own UI terminology. See [docs/ai-strategy.md](docs/ai-strategy.md) for
the reasoning behind this layout.

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
- When documentation or instruction text names an anti-pattern or
  failure mode, cite the observed incident per
  [docs/idd-design-rationale.md](docs/idd-design-rationale.md#cite-the-observed-incident).
- Continue autonomously for low-risk work, but pause and ask a
  concise question when uncertainty or hidden risk makes the next
  step unsafe. When that pause is needed, provide one or more
  recommended response options.
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
  (repository-local; not distributed to `idd-template/`). The same
  script also flags this failure mode outside code spans, in prose
  Markdown text: a hyphenated compound word (e.g. "transport-layer")
  must never wrap right after the hyphen inside `**bold**` / `*italic*`
  emphasis, for the same corrupting-space reason (issue `#2876`).
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

`## Branch strategy` and `## Commit rules` below cover those two rule
sets in full. This section records repository-local dogfood policies
layered on top of the distributed IDD defaults:

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
  loop cannot converge on its own (Refs #1465): once the configured
  convergence deadline (default 24h) has elapsed since the current PR
  HEAD's own commit timestamp, a trusted maintainer can post a valid
  external-check waiver for `idd-advisory-convergence` to unblock the
  gate. Treat this the same as any other merge-gate bypass — a
  deliberate, short-lived, maintainer-authorized exception for a
  genuinely stuck check, not a routine substitute for a fresh Copilot
  review. See [Customizing IDD](docs/customization.md) and
  [docs/idd-helper-scripts.md](docs/idd-helper-scripts.md#external-check-waiver-contract)
  for the general mechanism.
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
- **New-CI-job dispatch-first rollout**: `idd-pr-submit.instructions.md`'s
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

## Branch strategy

This project follows
[GitHub Flow](https://docs.github.com/en/get-started/using-git/github-flow):
`main` is the only long-lived branch and every change reaches `main`
through a pull request.

### Rules

- **Never push directly to `main`** — all changes must go through a
  pull request. Branch protection is enforced on GitHub.
- **Rebase onto `main` before publication** — before the first D-phase
  push of a PR branch, rebase onto `main` as needed. Fetch first so the
  local `main` is not stale, e.g.
  `git fetch origin && git rebase origin/main`
  (or `git pull --rebase origin main`). Do not create merge commits
  inside unpublished feature branches.
- **Treat pushed PR branches as published review history** — after the
  first D-phase push, branch-state checks stay read-only until a later
  phase decides an update is required.
- **Default post-push sync: merge `main` into the PR branch** — when an
  already-pushed branch needs synchronization or conflict resolution,
  merge `main` into the PR branch and send that follow-up through the
  normal CI and review gates. Do not rebase or force-push merely
  because the PR is `BEHIND`. This is the active branch-policy
  contract, enforced end to end by
  `idd-review-triage.instructions.md`'s E-phase branch-sync check
  (`Esync`), which uses the `branch-conflict-state` helper when
  helper runtime is enabled.
- **Force-push exceptions stay narrow** — use rebase and
  `--force-with-lease` after publication only when repository policy
  explicitly permits it and merge-based recovery cannot safely fix the
  branch, or when an already-started rebase must be completed or
  aborted during recovery.
- **Rebase between unpublished feature branches** — if one unpublished
  feature branch needs changes from another, use rebase, not merge.
- **Merge commits at PR boundary** — pull requests into `main` are
  merged with a merge commit (squash-merge and rebase-merge are
  disabled in the repository settings).
- **fixup + autosquash for unpublished in-branch fixes** — when a later
  commit in an unpublished feature branch fixes an earlier one, prefer
  `git commit --fixup=<sha>` followed by
  `git rebase -i --autosquash` to fold the fix into its target.
- **Avoid giant commits** — if squashing would produce an
  unreasonably large commit, keep the fix commit separate or
  re-split the history so each commit remains reviewable.

## Commit rules

This project follows
[Conventional Commits](https://www.conventionalcommits.org/).
A `.gitmessage` template is available at the repository root for
guidance when writing commit messages. Git does not use it
automatically, so contributors who want the template prefilled in
their editor should opt in once per clone:

```sh
git config commit.template .gitmessage
```

### Format

```txt
<type>[optional scope]: <user-facing description>

<body: address purpose, context, and what changed>

[optional footer(s)]
```

### Subject line

- Use the format: `<type>[optional scope]: <description>`
- Write from the **user's perspective** — briefly state what this
  commit solves or improves for the end user or developer
- Write in **lowercase**, imperative mood (e.g., "add", not "added")
- Keep the subject line under **72 characters**
- Do **not** end with a period

### Types

Common types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`,
`chore`, `ci`, `build`, `perf`

### Scopes

- Optional, in parentheses: `feat(ci):`, `fix(lint):`, `docs(readme):`
- Keep scopes **lowercase**, short, and consistent
- Use the directory or component name that best describes the area

### Body (line 3+)

The body should address three aspects:

- **Why** — the purpose or motivation behind the change
- **Context** — what was needed, the situation or constraint
- **What changed** — the concrete action taken

Prefer the **why → context → change** order when practical.
Write these as **natural prose** — weave the aspects into
coherent sentences rather than using labeled sections. Labeled
sections (`Why:` / `Context:` / `Change:`) are acceptable only
when explicit paragraph separation improves clarity.

Omit any aspect whose information **cannot be reliably inferred**.
If the subject line is self-explanatory, the body may be omitted
entirely. **Breaking changes must always include a body.**

Wrap body lines at **72 characters**.

### Breaking changes

- Append `!` after the type/scope: `feat!: remove deprecated endpoint`
- Add a `BREAKING CHANGE:` trailer in the footer with a detailed
  explanation of what breaks and migration steps

### Footers / trailers

- `Closes #<issue>` / `Refs #<issue>` — link to issues
- `Co-authored-by: Name <email>` — credit co-authors
- `BREAKING CHANGE: <description>` — detail the breaking change

### Atomic commits

Keep each commit as **small and focused** as possible:

- **One logical change per commit** — if the subject line needs "and",
  consider splitting
- **Separate refactoring** from behavior changes
- **Separate formatting/style** changes from logic changes
- **Separate dependency updates** from code changes
- When in doubt, prefer smaller commits that are easy to review,
  revert, and bisect

### Examples

#### Good — single-line (trivial change)

```txt
fix: correct typo in feature request template
```

#### Good — prose body

```txt
feat(ci): add concurrency settings to lint workflow

Parallel lint runs on the same branch waste resources and
cause race conditions in status checks. GitHub Actions
supports concurrency groups that automatically cancel
redundant runs, so add a concurrency group keyed on branch
name with cancel-in-progress enabled.

Refs #42
```

#### Good — breaking change

```txt
feat!: require node 20 as minimum version

Node 18 reached end-of-life in April 2025 and no longer
receives security updates, while the project now standardizes
on the active Node 20 LTS baseline. All production
environments have already been upgraded to node 20+, so
update the engines field and CI matrix to require node >= 20.

BREAKING CHANGE: drop support for node 16 and 18. Users
must upgrade to node 20 or later.
Closes #108
```

#### Bad — vague, developer-centric

```txt
fix: update code
```

#### Bad — too large / non-atomic

```txt
feat: add auth system and refactor database layer and update docs
```

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
recorded on the event itself. Also include `--claim-id <claim-id>` —
the active IDD `{claim-id}` — on every call from `claim` onward: it is
the positive-evidence signal a later harvest uses to merge a genuine
cross-session handoff/resume of the same claim lineage instead of
undercounting it (#2432). OpenCode has no matching `vendor` value
in `schemas/token-cost-event.schema.json` yet — skip this call rather
than pass a mismatched vendor. Stage ids: `discover`, `claim`, `work`,
`submit-pr`, `review`, `merge`, `cleanup`. Ignore any failure from this
command — it must never block or slow the IDD loop.

## Issue-authoring skill (dogfooded)

The canonical issue-authoring skill bundle lives at
`skills/issue-authoring/`. Edit the canonical bundle, never a
generated copy: `node scripts/sync-docs.mjs --apply` regenerates
derived copies and `node scripts/audit-docs.mjs --check` fails on
drift. The `idd-spec-audit` skill bundle at `skills/idd-spec-audit/`
follows the same rule: `.claude/skills/idd-spec-audit/` is likewise a
generated mirror and must never be edited directly.

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
