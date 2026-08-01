---
type: investigation
title: "Investigation: Microsoft APM as an Additional IDD Distribution Channel"
description: Records the findings and Go/No-Go recommendation on whether IDD should adopt Microsoft APM (Agent Package Manager) as an additional distribution channel for the template.
tags: [investigation, apm, distribution]
---

<!-- cspell:words apm applyTo Antigravity antigravity Cascade codex Kiro
     kiro windsurf openapm steering toml mcp openclaw uvx -->

# Investigation: Microsoft APM as an Additional IDD Distribution Channel

This document records the findings and recommendation for
[#1727](https://github.com/kurone-kito/idd-skill/issues/1727): whether
`idd-skill` should adopt
[Microsoft APM](https://github.com/microsoft/apm) (Agent Package
Manager) as an additional channel for distributing the IDD template,
beside the existing `idd-template/ONBOARDING.md` raw-fetch-and-copy
flow. This is an investigation deliverable, not an implementation — no
instruction file, template file, `apm.yml`, `.apm/` directory, or
runtime behavior changes as a result of this document.

## Relationship to the two prior verdicts

Two adjacent questions already have recorded no-go verdicts and are
**not** re-litigated here:
[`docs/claude-skill-strategy.md`](claude-skill-strategy.md) (packaging
the IDD execution loop as a Claude Code skill) and
[`docs/skills-delivery-investigation.md`](skills-delivery-investigation.md)
(delivering phase instructions as skill bundles, decided largely on the
"third synchronized surface" argument: a skill mirror beside
`.github/instructions/` and `idd-template/` multiplies the drift matrix
for every phase-file edit). This investigation asks a different
question — whether IDD should ride the APM **distribution** ecosystem,
not whether phase content should be re-packaged as skills — but APM's
`instructions` and `skills` primitives touch the same drift-surface
arithmetic those two notes already reasoned about, so §5 below
reconciles with both explicitly instead of re-deriving the argument
from scratch. Where this note's findings diverge from the prior two
(APM's `hooks` primitive is a false friend for `.githooks/`; APM's
`applyTo` activation mismatches phase-step routing in a way neither
prior note evaluated; content-hash pinning conflicts with placeholder
substitution), they are called out as new, APM-specific grounds.

## Baseline

**Current distribution model.** `idd-template/ONBOARDING.md` distributes
IDD by having an agent fetch or copy the template file set into the
adopter repository (the `idd-template-core-files` generated block plus
the optional `skills/issue-authoring/` companion) via `gh api` /
`curl` raw-content loops or a local clone, then substitute seven
`{{...}}` placeholders. Three weaknesses are already recorded: no
upgrade path beyond a manual "named-gap import"; no integrity
verification (`gh api`/`curl` fetch raw content with no pinned commit
or content hash); and no discovery surface beyond a trigger phrase plus
a raw `raw.githubusercontent.com` URL.

**What APM is.** [`microsoft/apm`](https://github.com/microsoft/apm) is
an MIT-licensed package manager for AI-agent context (topics:
`ai-agents`, `package-manager`, `github-copilot`, `codex-cli`,
`context-engineering`). As of this writing its latest tagged release is
`v0.26.0` (published 2026-07-18), with `v0.27.0` already recorded in
`CHANGELOG.md` — pre-1.0. A producer authors `.apm/<primitive-type>/`
files plus an `apm.yml` manifest; a consumer runs `apm install`, which
resolves dependencies into `apm_modules/`, records resolved commits and
per-file content hashes in `apm.lock.yaml`, and deploys (`apm compile`)
harness-native output for whichever targets are active. `apm update`
and `apm audit` re-resolve and drift-check against that lockfile.

## 1. Primitive mapping

APM's own primitive catalogue
([Author primitives](https://microsoft.github.io/apm/producer/author-primitives/))
lists exactly the six the issue names, plus a seventh (Commands) that
ships as a `prompts` sub-case:

<!-- dprint-ignore-start -->
| Primitive | One-liner | On-disk source |
| --- | --- | --- |
| Skills | Self-contained capability bundles (`SKILL.md` + scripts/references/assets) | `.apm/skills/<name>/SKILL.md` |
| Prompts | Reusable prompt templates with frontmatter | `.apm/prompts/<name>.prompt.md` |
| Instructions | Long-lived behavior rules scoped by glob | `.apm/instructions/<name>.instructions.md` |
| Agents | Personas with explicit scope, tools, triggers | `.apm/agents/<name>.agent.md` |
| Hooks | Runtime lifecycle event handlers | `.apm/hooks/*.json` (or `hooks/*.json`) |
| Commands | Slash-command shortcuts | ships as a `.prompt.md`; no separate `.apm/commands/` |
| MCP servers | Tool-server declarations | `dependencies.mcp:` in `apm.yml` (not a file primitive) |
<!-- dprint-ignore-end -->

Against the 61-file template set, this covers the phase-instruction
corpus (`instructions`), the optional `skills/issue-authoring/`
companion (`skills`), and nothing else IDD currently ships (no
`.agent.md` personas, no `.prompt.md` templates, no MCP server
declarations). Five named payloads have **no** APM primitive today:

- **`.github/workflows/idd-advisory-convergence.yml`** — a GitHub
  Actions CI workflow. APM has no workflow or CI-check primitive; it
  deploys agent-context files, not `.github/workflows/` YAML.
- **`.githooks/`** — this is a **false-friend name collision**, not a
  gap that could be closed by mapping onto APM's `hooks` primitive.
  APM's `hooks` are harness-runtime lifecycle callbacks
  (`PreToolUse`/`PostToolUse` JSON, or Copilot's
  `preToolUse`/`postToolUse` equivalent) fired inside an agent's own
  tool loop
  ([Hooks and commands](https://microsoft.github.io/apm/producer/author-primitives/hooks-and-commands/)).
  IDD's `.githooks/pre-commit` and `.githooks/pre-push` are POSIX `sh`
  scripts fired by **git itself** on a local commit/push — a
  completely different trigger surface APM's `hooks` primitive does not
  address at all.
- **`.github/idd/config.json`** — an adopter policy file the
  instructions read at runtime. APM has its own, unrelated
  `policy-v0.1.schema.json` (org-level executable/target governance);
  nothing in APM deploys or manages an arbitrary consumer-owned JSON
  config file.
- **`profiles/`** — plain adopter-facing documentation (per-profile
  `README.md` edit-surface guides). No primitive covers a bare
  documentation directory that is not a skill's own `references/`.
- **`idd-template/docs/**`** — the wider documentation set
  (`getting-started.md`, `customization.md`, `policy-constants.md`,
  …). Same gap as `profiles/`: APM has no "ship a docs page" primitive.

**`bin/` and the helper bundle.** The issue asks specifically what
APM's `bin/` support does and does not cover. Per
[Repo shapes — Shipping `bin/` executables](https://microsoft.github.io/apm/producer/repo-shapes/#shipping-bin-executables-claude-code-only):
a package may ship a top-level `bin/` directory of executables, but
this is explicitly **"a Claude-Code-specific contract — no other
harness has an equivalent"**, deploy is **"user-scope only"** (`apm
install -g`; a project-scope install "skips `bin/` and prints a hint to
re-run with `-g`"), and the deployed scripts land on Claude Code's Bash
`PATH` and are **"invoked without per-call confirmation"** (treated as
trusted code). This does not cover IDD's helper bundle
(`scripts/*.mjs`, per `docs/idd-helper-scripts.md`): the helper bundle
is invoked identically by every supported agent's own shell tool
(`node scripts/x.mjs …`), is normally project-scoped (the
`vendored-node` profile copies files into the adopter repo, not a
global directory), and is read as an explicit command named in the
instruction text rather than a bare command silently available on
`PATH`. `bin/` would only ever reach a Claude-Code-only, global-install
subset of that model — a materially narrower and differently-trusted
delivery shape.

## 2. Frontmatter gap

APM's `instructions` primitive requires `description` and treats
`applyTo` as **load-bearing**: "Without it the rule is treated as
unconditional and gets folded into compiled context files (`AGENTS.md`,
`GEMINI.md`) instead of a per-file rule directory"
([Instructions and agents](https://microsoft.github.io/apm/producer/author-primitives/instructions-and-agents/)).
For the `claude` target specifically, that "compiled context file" is
`CLAUDE.md` itself — instructions already deployed under
`.claude/rules/` are the ones **omitted** from `CLAUDE.md` "to avoid
duplicate context"
([Targets matrix — claude](https://microsoft.github.io/apm/reference/targets-matrix/#claude)).

17 of the 18 distributed phase files carry no frontmatter at all today
and are read on demand by explicit path, per the routing table in
`idd-overview-core.instructions.md`, rather than auto-attached by glob.
The one exception, `idd-overview-core.instructions.md`, already carries
`applyTo: "**"` — the same key name APM's own convention uses — but
still lacks `description`, so even that file is not fully
APM-conformant as written.

Two consequences follow from forcing the remaining 17 files through
this primitive:

- **Add `applyTo`.** Each phase file's _real_ activation condition is
  "the routing table just selected this file for the current workflow
  step" — not a file-glob. There is no glob that expresses "the agent
  is between D2 and D3." Any `applyTo` value assigned to make a phase
  file schema-valid would misrepresent its actual activation semantics.
- **Omit `applyTo`.** Every one of the 17 files then folds into the
  always-loaded `CLAUDE.md` (or `AGENTS.md`/`GEMINI.md` on other
  compile-only targets), which is exactly the always-loaded-context-cost
  problem `docs/claude-skill-strategy.md`'s Context Economics section
  and `docs/skills-delivery-investigation.md`'s §5 (Token/context
  economics) already measured against the `instructionSizeBudgets` /
  `bundleBudgets` caps in `audit/sync-manifest.json`. Folding 271,814+
  bytes of phase content (the skill-delivery investigation's own
  skill-candidate size figure, excluding the two always-loaded overview
  files) into `CLAUDE.md` would blow past every one of those budgets at
  once.

This is the same **deterministic-routing-vs-probabilistic/glob-trigger**
mismatch class the skills-delivery investigation already proved for
skill auto-invocation ("IDD's routing table dispatches by which step of
the loop the agent is in … a distinction `paths` glob-matching cannot
express"), now shown to recur independently against APM's `instructions`
primitive rather than its `skills` primitive. **Answer:** under APM's
own semantics, the phase corpus is not cleanly an `instructions`
primitive at all — its activation key (workflow-step position) is
categorically different from the primitive's activation key (file-glob
scope), and neither available encoding (add a meaningless `applyTo`, or
omit it and blow the context budget) preserves current behavior.

## 3. Placeholder conflict

`apm.lock.yaml` pins `resolved_commit` (a 40-hex git SHA) and, per file,
a `deployed_file_hashes` envelope (`sha256:`/`sha384:`/`sha512:`) —
confirmed directly in the published
[lockfile schema](https://microsoft.github.io/apm/specs/schemas/lockfile-v0.1.schema.json).
`apm audit`'s default content-scan mode **"replays the install pipeline
into a scratch tree to detect drift (hand-edits to deployed files,
missing integrations, orphaned files vs the lockfile)"**
([`apm audit`](https://microsoft.github.io/apm/reference/cli/audit/)).

The template ships 26 `{{...}}` placeholder occurrences across five
instruction files (`idd-discover`, `idd-overview-core`,
`idd-roadmap-audit`, `idd-suitability`, `idd-work` — reconfirmed by
`grep -o '{{[A-Z_]*}}' idd-template/.github/instructions/*.instructions.md
| wc -l` against this repository today) that onboarding substitutes in
place with each adopter's own values. That substitution is, by
definition, exactly the class of post-install hand-edit `apm audit`
flags as drift, and every one of those five files would carry
permanent, unresolvable drift the moment onboarding finished — not a
transient state a re-sync clears, since the substituted values are
adopter-specific and can never match the pinned upstream hash again.

**Is a config-first, placeholder-free corpus a hard precondition?**
Yes, for any APM channel that also wants integrity verification to mean
something: values would need to resolve from `.github/idd/config.json`
at agent-read-time (as the seven placeholders already partially do for
some values today, e.g. label names) rather than being substituted into
the file text once. **Cost and risk:** this is a non-trivial rewrite of
all five files' prose from literal values to config-read indirection,
and it cuts against the reliability model `docs/idd-workflow.md`'s
[Model capability expectations](idd-workflow.md#model-capability-expectations)
section already worries about for the **lightweight local or compact
cloud** model tier: reading a literal value costs nothing, while
reading-then-substituting a config value is one more indirection step a
weak model can skip, misread, or apply inconsistently across a session.
The risk is not hypothetical — it is the same class of concern that
motivated this repository's own lite-instruction-profile and
weak-model-authoring tracks. Adopting APM for these five files without
first absorbing that rewrite cost would ship an integrity mechanism
that is false-green from the moment onboarding completes.

## 4. Cross-reference integrity

APM rewrites a relative markdown link only when it is genuinely a link
(`[text](path)`), the resolved target file exists on disk, and the
target stays inside the source package root
([Package-relative links](https://microsoft.github.io/apm/producer/package-relative-links/)).
Bare prose mentions of a filename with no link wrapper are not links
and are never touched.

Re-derived today against `idd-template/.github/instructions/*.instructions.md`
(`grep -roE '[a-z0-9-]*\.instructions\.md' … | wc -l` vs.
`grep -roE '\]\([^)]*\.instructions\.md[^)]*\)' … | wc -l`): 194 total
occurrences of `<name>.instructions.md`, of which 27 (~14%) are Markdown
links. This is close to, though not identical to, the issue's cited
231/22 (~9.5%) — the exact figure depends on which file set is in
scope (this recount excludes `lite/` and `docs/`) — but both counts
agree on the qualitative finding: the large majority (86–90%) of
cross-references are bare prose, invisible to the link rewriter
regardless of scope.

The deeper problem is not the rewriter's _coverage_ — it is that
**even the Markdown-link subset breaks across targets**, because
"pinning `targets:`" does not keep every harness reading the same
literal filename. Per the
[targets matrix](https://microsoft.github.io/apm/reference/targets-matrix/#post-install-instruction-compilation),
`instructions` compiles per target to a **different directory and, for
several targets, a different extension**:
`copilot` → `.github/instructions/<name>.instructions.md` (verbatim,
matching today's convention); `claude` → `.claude/rules/<name>.md`;
`cursor` → `.cursor/rules/<name>.mdc`; `kiro` →
`.kiro/steering/<name>.md`; `antigravity` → `.agents/rules/<name>.md`;
`codex`/`gemini`/`opencode` fold into `AGENTS.md`/`GEMINI.md` with no
per-file deploy at all. A Claude Code session reading its own compiled
`.claude/rules/idd-pre-merge.md` would encounter a bare-prose reference
to `idd-pre-merge.instructions.md` — a filename that exists nowhere in
its own deploy tree, only in Copilot's. Restricting `targets:` to
`copilot` alone would preserve filename identity (since Copilot's
convention is already `.github/instructions/<name>.instructions.md`,
unchanged), but at the cost of the whole cross-agent point of shipping
through APM in the first place — see §5 and §6.

**Answer:** pinning `targets:` does _not_, by itself, keep every
harness reading the single `.github/instructions/` copy; only scoping
`targets:` to `copilot` alone would. A genuinely multi-target
compilation (the reason to prefer APM's "compiles to every supported
target" model over the status quo) reintroduces exactly the reference-integrity
break the issue asks about, for both the rewritten and the un-rewritten
majority of cross-references alike.

## 5. Drift-surface arithmetic

Per §1, two shapes of APM adoption are actually available — the
optional `skills/issue-authoring/` companion, and the core
phase-instruction corpus — and they land on opposite sides of the
drift arithmetic `docs/skills-delivery-investigation.md` §3 already
used ("every phase-file edit a three-copy change").

**Skill bundle.** APM's skill deployment copies the whole `SKILL.md`
bundle directory verbatim to `.agents/skills/<name>/` for most targets
(Copilot, Cursor, OpenCode, Gemini, Antigravity, Codex, Windsurf) and to
a native `.claude/skills/<name>/` / `.kiro/skills/<name>/` for Claude
and Kiro
([Targets matrix — Skills convergence](https://microsoft.github.io/apm/reference/targets-matrix/#skills-convergence)).
That is structurally the same operation `audit/sync-manifest.json`'s
`skills/issue-authoring` → `.claude/skills/issue-authoring`
`mode: "exact"` sync pair already performs today. Routing this single
bundle through `apm install`/`apm compile` instead would plausibly
**replace**, not add to, that one sync pair: `apm_modules/` +
`apm.lock.yaml` become the new provenance record instead of
`sync-docs.mjs`'s copy step, and the copy count for an edit to
`skills/issue-authoring/SKILL.md` stays at two (canonical +
Claude-facing copy) either way.

**Phase-instruction corpus.** §2 and §4 already rule out a clean,
multi-target adoption for this corpus (activation-semantics mismatch;
cross-reference breakage on every non-Copilot target). The only shape
left is `targets: [copilot]`-only, using `.apm/instructions/` as a new
canonical source in place of `idd-template/.github/instructions/`. Copy
count per phase-file edit, by option:

<!-- dprint-ignore-start -->
| Option | Copies per edit | Mechanisms |
| --- | --- | --- |
| **Today** | 2 (`idd-template/.github/instructions/idd-x.instructions.md` + generated `.github/instructions/idd-x.instructions.md`) | 1 (`sync-docs.mjs`, same-repo) |
| **APM replaces the pair, Copilot-only target** | 2 (`.apm/instructions/idd-x.instructions.md` + compiled `.github/instructions/idd-x.instructions.md`) | 2 (`apm compile` for this pair; `sync-docs.mjs` still required for every non-primitive payload in §1) |
| **APM adds a channel beside the existing template, multi-target** | 3+ (`idd-template/` retained for non-`apm` adopters + `.apm/instructions/` + N compiled per-target outputs) | 2 |
<!-- dprint-ignore-end -->

The Copilot-only replacement option holds the copy count flat but still
**adds** a mechanism (a new external CLI dependency) beside
`sync-docs.mjs`, which by §1 remains mandatory regardless for the five
non-primitive payloads. The multi-target option strictly worsens the
arithmetic, matching `docs/skills-delivery-investigation.md`'s own
finding for the same reason. **Neither phase-corpus option is a net
reduction** — this is the "adds a generated surface" branch of the
issue's question, not the "replaces the sync-pair machinery" branch,
and it reproduces the "third synchronized surface" objection that
already decided `docs/skills-delivery-investigation.md`, now manifesting
as a third _external tool dependency_ rather than a third same-repo
generated file tree.

The skill bundle is the one candidate in this whole investigation whose
arithmetic is neutral-to-favorable — see §7.

## 6. Tooling boundary

`docs/customization.md`'s
[Tooling Boundary](customization.md#tooling-boundary) table states: "IDD
workflow files are tooling-agnostic. The only tooling contract is the
`Project commands` table," with `git`/`gh`/`jq`/`curl` **required** and
Node.js/`npx` **optional**. The `apm` CLI (a Python package per
`microsoft/apm`'s `src/apm_cli/` tree, installed via `pip`/`uvx`/an
install script, not via Node) does not fit either existing row — it
would be a genuinely new tooling category the boundary table does not
name today.

Per §2, §4, and §5, APM cannot cleanly cover the core template today.
So the only tenable position is: **`apm` stays an adopter-side optional
row for the one already-optional companion bundle
(`skills/issue-authoring/`), never a required dependency**, and the
existing zero-new-dependency raw-URL/`idd-onboard.mjs` path remains the
default for the core template regardless of whether the optional
companion also ships an APM manifest.

**Release-cadence risk.** APM's own release history (`gh api
repos/microsoft/apm/releases`, checked 2026-08) shows `v0.17.0`
(2026-06-04) through `v0.26.0` (2026-07-18) — 10 tagged releases in
about 6.5 weeks, roughly one every 4–5 days, with `v0.27.0` already
recorded in `CHANGELOG.md` days later. The `[Unreleased]`/`[0.27.0]`
entries in that same changelog show routine behavior changes to
install/lockfile/MCP-ownership semantics landing between adjacent
releases (for example, `apm.lock.yaml`'s `materialization_repo_url`
field and MCP target-ownership resolution both changed in `v0.27.0`
alone). A pre-1.0 tool at this cadence is a real, ongoing maintenance
cost for any repository that pins to it — schema and behavior drift
this repository would have to track on a roughly weekly cadence, for a
tool with no stability guarantee yet (the manifest/lockfile/policy
schemas are all explicitly versioned `v0.1`).

## 7. Pilot candidate

`skills/issue-authoring/` is, on the evidence gathered above, the
lowest-risk first package, and the only candidate this investigation
found net-neutral-or-favorable on drift arithmetic (§5):

- Its `SKILL.md` already carries `name: issue-authoring` and a
  `description:` field matching APM's required skill frontmatter
  contract; the directory name (`issue-authoring`) already equals the
  declared `name`, satisfying APM's "must equal the parent directory
  name" rule
  ([Author a skill](https://microsoft.github.io/apm/producer/author-primitives/skills/)).
- It already uses the `references/` subdirectory APM's own convention
  names as one of a skill's four optional subdirectories
  (`scripts/`, `references/`, `assets/`, `examples/`).
- It carries no `{{...}}` placeholders, so §3's hash-pinning conflict
  does not apply to it.
- It is already optional and separate from the core execution loop; its
  own contract (`docs/issue-authoring-skill.md`) already states the
  bundle and the execution instructions "must not be treated as
  interchangeable entry points" — the same non-interchangeability
  boundary `docs/claude-skill-strategy.md` protects for a hypothetical
  execution-loop skill. Distributing it via `apm install` would not
  touch that boundary.

This is recorded as the named candidate for a future, bounded pilot —
**not** adopted, piloted, or scheduled by this issue. See Non-goals.

## Recommendation: No-Go

**No-Go** on adopting APM as a distribution channel for the core IDD
template at this time. The blocking findings, independently derived
from APM's own current documentation and schemas rather than copied
from the two prior verdicts:

1. **Five payload classes have no APM primitive** (§1) — a channel
   through APM would still need the existing raw-URL/`sync-docs.mjs`
   mechanism for `.github/workflows/idd-advisory-convergence.yml`,
   `.githooks/`, `.github/idd/config.json`, `profiles/`, and
   `idd-template/docs/**` regardless of any other decision. `bin/` does
   not cover the helper bundle (Claude-only, global-scope-only, a
   different trust model).
2. **The phase corpus's activation semantics do not fit the
   `instructions` primitive** (§2): its real key is workflow-step
   position, not file-glob scope, and both available encodings
   (assign a meaningless `applyTo`, or omit it and blow the
   always-loaded context budget) degrade current behavior.
3. **Content-hash pinning is incompatible with placeholder
   substitution** (§3) as currently designed — the five placeholder
   files would carry permanent, unresolvable drift from the moment
   onboarding completes, unless a config-first rewrite (itself a real
   cost against the weak-model reliability model) happens first.
4. **Multi-target compilation breaks IDD's own cross-references** (§4)
   for both the Markdown-link and (much larger) bare-prose subsets,
   unless `targets:` is restricted to `copilot` alone — which forfeits
   the cross-agent value APM would otherwise add.
5. **The phase-corpus arithmetic nets out as "adds a surface," not
   "replaces the sync-pair machinery"** (§5), reproducing the same
   "third synchronized surface" objection `docs/skills-delivery-investigation.md`
   already decided, now as a new external tool dependency.
6. **APM is pre-1.0 at a fast release cadence** (§6) with no stability
   guarantee on the schemas this note cites, an ongoing maintenance
   cost independent of the findings above.

The one favorable exception is `skills/issue-authoring/` (§7): its
drift arithmetic is neutral-to-favorable and none of findings 2–4 apply
to it, since it is a `skills` primitive with no placeholders and no
workflow-step activation requirement. That single exception is not
enough to justify adopting APM as a channel today, but it is recorded
as the named condition under which a narrow, reversible pilot would be
worth reopening this question.

## Revisit conditions

Re-evaluate this note when any of the following holds:

- APM reaches a stable (1.0+) manifest/lockfile/policy schema, reducing
  §6's pre-1.0 churn risk.
- APM's `instructions` primitive (or a successor primitive) gains a
  workflow-step-scoped activation mode distinct from file-glob
  `applyTo`, closing §2's mismatch.
- An adopter explicitly requests APM-form distribution with a concrete
  use case the raw-URL / `idd-onboard.mjs` path does not already serve.
- This repository or an adopter wants to pilot `skills/issue-authoring/`
  alone via `apm install`, as a bounded, reversible experiment — the
  one candidate §7 found net-neutral-or-favorable.

Capture new evidence as issues referencing this document.

## Non-goals

This investigation does not:

- change any instruction file, template file, `apm.yml`, `.apm/`
  directory, or runtime behavior
- adopt APM for any package, including `skills/issue-authoring/`, as a
  result of this note alone
- author follow-up implementation issues (mirrors
  `docs/skills-delivery-investigation.md`'s own non-goals; implementation
  authoring is left to a later session once a verdict is acted on)
- reopen `docs/claude-skill-strategy.md`'s or
  `docs/skills-delivery-investigation.md`'s own verdicts on skill-form
  delivery of the execution loop or phase instructions
- propose a competitive-landscape rewrite beyond the single
  distribution/package-management category added to `docs/positioning.md`
  in the same change
