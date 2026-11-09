# Guidelines for AI Agents

This repository distributes the IDD (Issue-Driven Development)
workflow — a portable set of `.github/instructions/` files that
wire up a multi-agent issue-driven pipeline for any GitHub
project.

This file is the canonical, tool-neutral instruction source for AI
coding agents in this repository, following the
[AGENTS.md](https://agents.md) open standard that Codex CLI, OpenCode,
Grok Build, Cursor CLI, and GitHub Copilot (CLI, coding agent, and Chat)
all discover automatically at the repository root. `CLAUDE.md` and
`GEMINI.md` are thin adapters that import this file for Claude Code and
Antigravity CLI (formerly Gemini CLI), the two tools in this
repository's harness mix that read their own dedicated entry file
instead, and
[.github/copilot-instructions.md](.github/copilot-instructions.md)
carries only the small amount of guidance specific to GitHub Copilot's
own UI terminology. See [docs/ai-strategy.md](docs/ai-strategy.md) for
the reasoning behind this layout.

## Conversation

- When asking the user to decide or take a
  action, include enough context to understand the request and state the
  exact decision or action needed in the same message. If you offer
  options, identify the recommended option and the main cost of each.
  Keep the ask concise and do not repeat context already present in the same message.
- For user-facing questions about idd-skill decisions, actions, and
  clarifications during issue authoring and ordinary IDD execution,
  including scope, hold/recovery, and approval questions, assume an
  engineer skilled in manual issue-driven development and GitHub Flow
  who is unfamiliar with the idd-skill product and its automation
  conventions.
- When a question uses an idd-skill-specific term, briefly explain the
  meaning or automation constraint needed for that decision. For
  example, phase codes describe workflow state; `Candidate files` lists
  editable paths; an authoring hold pauses automation; and claim and nonce
  evidence helps establish current ownership, together with the required
  claim, worktree, token, and revalidation checks. State the exact action
  requested. Do not infer product knowledge from the IDD acronym,
  technical vocabulary, repeated use, or prior sessions; an explicit
  operator request can change the presentation level. This
  question-writing rule does not change issue/PR prose or execution
  authority, approvals, ownership, CI, or review. The fixed audience
  reflects the operator report observed 2026-10-26 in issue `#4743`.

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

This section records source-repository dogfood policies that extend the
distributed defaults. Supporting context and measurements are in
[Repository policy evidence](docs/repository-policy-evidence.md).
`## Branch strategy` and `## Commit rules` below cover those rule sets in
full.

<!-- dprint-ignore-start -->
<!-- markdownlint-disable MD013 -->
- **Merge policy**: Run F3 only after all claim, freshness, CI, advisory, review, and unresolved-thread gates pass. See [evidence](docs/repository-policy-evidence.md).
- **Discover concurrency**: A4 spreads same-score candidates across sessions with `discover.selectionDesync: session-offset`. See [evidence](docs/repository-policy-evidence.md).
- **Advisory-convergence waiver backstop**: After the configured deadline, a trusted maintainer may waive genuinely stuck convergence; this does not replace review. See [evidence](docs/repository-policy-evidence.md).
- **Self-referential bootstrap waiver**: Auto-waive only when bootstrap trigger files change and no decision-rule files change. See [evidence](docs/repository-policy-evidence.md).
- **ciGate F2 bootstrap**: Preload new `ciGate.*` keys through the distributed F2 procedure; do not generalize the bootstrap auto-waiver. See [evidence](docs/repository-policy-evidence.md).
- **Advisory-convergence deadline**: This repository sets the maintainer-authorized waiver deadline to `PT9H`; the distributed default is `PT24H`. See [evidence](docs/repository-policy-evidence.md).
- **Secondary-bot quiet window**: Wait `PT5M` after substantive activity; use the settled buffer after a current-head CodeRabbit review, and stop immediately on a definitive decline. See [evidence](docs/repository-policy-evidence.md).
- **New CI job rollout**: Land new CI jobs with `workflow_dispatch` first; enable automatic runs after they are proven. See [evidence](docs/repository-policy-evidence.md).
- **Critique telemetry hook**: The configured `idd-critique-telemetry` hook is fire-and-forget; absent external tooling is a silent no-op. See [evidence](docs/repository-policy-evidence.md).
- **Gist-retrospective feedback label**: Apply `feedback:idd-core` to qualifying roadmaps and tracked children for visibility only; it never gates phases, and `status:upstream-candidate` remains adopter-side. See [evidence](docs/repository-policy-evidence.md).
- **Adopt-now urgency defer**: With `severity-tiered` and relax rounds `[4, 7]`, High findings defer at `very-low` at step 0; current-head convergence can add one step and allow `low` urgency before the count-3 cap defers at every urgency. Safety and other block reasons retain their verdicts. See [evidence](docs/repository-policy-evidence.md).
- **Review-count cap**: Standard-profile PATH A findings defer at every urgency at or above `critiqueLoop.deferAllAfterRounds: 3`, unless safety or another block applies; Lite keeps `deferAfterRounds: 5`. See [evidence](docs/repository-policy-evidence.md).
- **Triage record**: With `triageRecord: "enforce"` and `severity-tiered`, an applied Accepted reply whose otherwise-unblocked verdict is `defer` needs an `--override` reason. See [evidence](docs/repository-policy-evidence.md).
- **E10 converged-review opt-in**: With the standard-profile opt-in, skip E10 only for a nonempty Accepted PATH A batch from configured non-primary advisory bots after convergence on the current HEAD; Lite always runs E10. See [evidence](docs/repository-policy-evidence.md).
- **Effort-L refusal**: Authoring rejects ready L child/orphan bodies unless they use a matching human bucket; split into S/M or use that bucket. Discover routes only effort-L orphans to humans, not roadmaps or roadmap children. See [evidence](docs/repository-policy-evidence.md).
- **GitHub API load control**: Respect `githubApi.loadControl.maxConcurrent: 4`; a real `notDispatched` refusal is the signal to opt out. See [evidence](docs/repository-policy-evidence.md).
- **Local validation admission**: Use `idd-skill-validate` Pueue cap 2 or serial `flock` fallback when the Pueue client is missing; a failed daemon health check exits 69 without taking the flock lock (issue `#5115`). Windows runs directly; do not manage the daemon or resize groups. See [evidence](docs/repository-policy-evidence.md).
- **Orchestrator worker cap**: Cap each orchestrator session at 4 workers; remove both the config and enforcing dogfood rule to opt out. See [evidence](docs/repository-policy-evidence.md).
- **Live status digest**: This repository does not use live status digests; leave existing digests untouched and use the helper only by explicit request. See [evidence](docs/repository-policy-evidence.md).
- **Provisional decision opt-in**: `dangerouslyAutoDecide` acts only when each class's own switch and matching consumer are ready; only `worktreeRemnant` and `b1Leftover` may replace their stops after saving all data, with every other gate retained. See [evidence](docs/repository-policy-evidence.md).
<!-- markdownlint-enable MD013 -->
<!-- dprint-ignore-end -->

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
- **Default post-push sync: merge `main` into the PR branch** — before each
  E12 review-fix push, E11 merges `main` when behind so the sync rides
  with that push; E11 does not make a standalone push (#4759). Esync can
  still push its standalone sync when branch protection or policy
  requires an up-to-date head; that push goes through normal CI and
  review gates.
  Do not rebase or force-push merely because the PR is `BEHIND`. This
  active branch-policy contract is enforced end to end by
  `idd-review-triage.instructions.md`'s E-phase branch-sync check
  (`Esync`), which uses the `branch-conflict-state` helper when helper
  runtime is enabled.
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

- **Avoid a bare `token:` line start**: a body line must not begin
  with a single (optionally hyphenated) token immediately followed by
  a colon and a space — for example a line starting `bullet: ...` or
  `Step-1: ...`. `@commitlint/config-conventional`'s footer/trailer
  parser misreads that shape as the start of a footer section, even
  though it is ordinary prose deep in the body, and emits a spurious
  `footer-leading-blank` warning — a **warning** under this
  repository's current `.commitlintrc.yml`, not a blocking failure,
  but still worth avoiding. This does not conflict with the `Why:` /
  `Context:` / `Change:` labels above: each one only ever opens a
  fresh, blank-line-separated paragraph, so the blank line already
  required before it also satisfies `footer-leading-blank`; the trap
  here is the same shape appearing **without** a preceding blank
  line, buried mid-paragraph. Reword instead: lead with an article or
  an extra word (for example "the bullet: ..." or "in step 1: ...")
  so the line no longer opens with a bare token before the colon.
  Observed 2026-09-12, live against this repository's own
  `.commitlintrc.yml`, in commit
  `bae5e0f1e43b54713f936af6f677773b684dd81e` (PR `#2942`, issue
  `#2943`).

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

## Local Linux CI with nektos/act

`pnpm run ci:act` runs three of this repository's Linux pull-request CI
jobs locally through [nektos/act](https://github.com/nektos/act), so a
problem can be caught before a push. It is opt-in and repository-local:
it is not part of `commands.pre-push-validate` or any other command set,
and it is not distributed through `idd-template/`.

```sh
pnpm run ci:act
```

Run it from a clone or from a linked worktree. The script tests the
working tree as it stands: act copies the tree into the container, so
uncommitted changes and untracked files that are not ignored are tested
too, not only the commit.

Prerequisites:

- act (tested with act 0.2.89) and a running Docker daemon.
- A clone whose git common directory is owned by uid and gid 1000:1000.
  The script checks this and stops with a message otherwise. The jobs run
  as the image's `node` user, which has a writable HOME. The script uses
  GNU `stat -c`, so it needs Linux or WSL.
- Network access when the image is absent locally, to pull it, and when
  an action is not yet cached, to fetch it. The two `pnpm-boundary` jobs
  install pnpm and Node at run time, so they need network on every run.
- A warm pnpm store or network access for the config-dependency install
  that the first `pnpm run` in a fresh clone or worktree performs.
- A local `origin/main` ref. `node scripts/audit-docs.mjs` diffs against
  it, because act's default event carries no base. Fetch it first with
  `git fetch origin main`.

Each job runs in the image `node:24.21.0-trixie`, selected by tag rather
than by digest. `--pull=false` pulls only when the tag is absent locally;
a local copy with the tag is used as it is. The full tag is used rather
than the `-slim` variant, because the slim image has no `git`; a
local 2026-10-27 check found `git` missing from the slim image and present
in the full tag. The script runs these jobs in order and stops at the first
failure:

- `lint`: the bare-Node lane, which runs the audits and the protocol
  tests with no dependency installed.
- `pnpm-boundary`: the aggregate job (issue `#4993`). act runs the jobs it
  needs first. In this repository they are the four `pnpm-boundary-group`
  shards (`lint`, `typecheck`, `test`, and `distribution`). Each shard runs
  `pnpm install --frozen-lockfile --prefer-offline` with `HUSKY=0`, then
  its own `pnpm run check` groups, and the `distribution` shard also runs
  `node scripts/check-pnpm-boundary.mjs`. When act does not resolve the
  repository as `kurone-kito/idd-skill`, the `pnpm-boundary-full` job runs
  the whole suite instead. Before the first push of PR `#5018`, the shard
  path (`pnpm-boundary.yml` with `-j pnpm-boundary`) was replayed locally
  with act 0.2.94. That replay exposed lint and test content failures, both
  fixed before the push. The `pnpm-boundary-full` fallback path has
  not been replayed under act.
- `pnpm-boundary-node22-floor`: the same reusable workflow on the Node
  version set by its `node-version` input. It is the only one of the three
  jobs that covers Node 22.

Compared with `commands.pre-push-validate`, the script adds the
bare-Node run with no installed dependency, the frozen-lockfile install
with the pnpm boundary check, and the Node 22 floor run. The pre-push
command set performs none of those.

The lint job's protocol-tests step can fail when the host is under heavy
load, because some tests use wall-clock limits: a 2000 ms limit in
`tests/resume-route-selection.test.mts` and a 700 ms read budget in
`tests/provider-outage-park-read-runtime.test.mts`. Local act runs of this
change on 2026-10-27 hit this failure, as recorded in pull request `#4773`.
Rerun the job on a quieter host before treating such a failure as a code
defect.

A linked worktree mounts the git common directory read-only at the same
path, so the checkout inside the container can read the worktree's git
metadata. The 2026-10-27 probe recorded in issue `#4756` found that the
worktree's git directory path is absent in the container without the
mount. A clone needs no extra mount. The job uid matches the owner of the
common directory, so git accepts the mounted repository without a
`safe.directory` setting. For a linked worktree, the common directory's
path must contain no spaces or colons, because the mount is passed to act
and docker inside an option string.

The container runs with `--init`. Without an init process, the container
that act starts keeps a killed child process as a zombie, so a liveness
check still sees the process. On 2026-10-27, in local runs of this change
recorded in pull request `#4773`, two tests in
`tests/idd-critique-telemetry-hook.test.mts` failed in two runs without the
flag: one waits for a hung hook to be killed, the other for a backgrounded
descendant to be killed. They passed in a third run with the flag. A
container whose PID 1 was a plain `tail -f` process reproduced the same two
failures on the same day, and `--init` cleared them.

The jobs the script does not run, and why:

- `idd-doctor`: its checkout pins the commit under test. A 2026-10-27
  probe showed act downloading that commit from GitHub, so the job checks
  the pushed commit, not the local tree. `commands.pre-push-validate`
  runs the same check on the local tree through `pnpm run doctor:github`.
- `lint-windows`: act's Docker containers cannot provide a Windows
  runner (preventive; no observed incident yet).
- `analyze`: CodeQL uploads its results to code scanning with
  `security-events: write` (preventive; no observed incident yet).
- `idd-advisory-convergence` and the workflows that review, comment,
  label, or merge: they read or write GitHub state, so
  a local run would act on that state (preventive; no observed incident
  yet).

The image sets no user, so a container would run the jobs as root, and
root ignores the POSIX permission bits that some tests rely on. The
script therefore passes `--user 1000:1000`. In the 2026-10-27 probe, the
grok test in `tests/token-cost-adapter-grok.test.mts`, which reads a file
with mode `000`, failed as root in `node:24.21.0-trixie-slim` with
`2 !== 1`, and passed as uid 1000. Other test files, such as
`tests/idd-config.test.mts` and
`tests/token-cost-event.test.mts`, depend on the same bits. Some of them
skip rather than fail as root, so a root run would lose their coverage
without any failure. The uid is part of the design, not a convenience.

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
undercounting it (#2432). OpenCode and Cursor CLI have no matching
`vendor` value in `schemas/token-cost-event.schema.json` yet — skip
this call rather than pass a mismatched vendor. Stage ids: `discover`,
`claim`, `work`, `submit-pr`, `review`, `merge`, `cleanup`. Ignore any
failure from this command — it must never block or slow the IDD loop.

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
the dogfood route for Claude Code, OpenCode, Grok Build, and Cursor CLI
compatibility; it is not the
canonical source. Do not add checked-in `.agents/skills/`,
`.cursor/skills/`, or `.opencode/skills/` mirrors by default
(preventive; no observed incident yet),
and do not assume the source path is automatically discovered by Codex.

The rule against checked-in `.agents/skills/` mirrors covers repository files
only. An operator's user-global install under `~/.agents/skills/` (see
[User-global installation](docs/user-global-install.md)) lives outside every
repository, so it is not a mirror and this rule does not apply to it.
