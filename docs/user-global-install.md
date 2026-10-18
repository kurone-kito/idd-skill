---
type: guide
title: User-global installation
description: Installs IDD and its skills for the current user, explains how user-global policy layers and overrides resolve, and states the activation gate and the CI off switches.
tags: [user-global, install, policy, activation]
---

# User-global installation

The user-global installer places the IDD instruction payload and two skill
bundles, `issue-authoring` and `idd-spec-audit`, into the current user's own
directories. It also wires the gated entry text into each selected harness's entry
file. How the text is wired differs by harness, as the What gets written section
explains. A separate command removes what its receipt records. Paths
that a failed receipt write leaves unlisted need manual cleanup, as described
under [Failure outcome](#failure-outcome).

The installer supports Claude Code, Codex CLI, and OpenCode. The other
harnesses are deferred; see [Deferred harnesses](#deferred-harnesses).

## Relationship to earlier verdicts

This page does not reverse any recorded no-go verdict. Three documents decided
other questions:

- [Claude Code skill strategy](claude-skill-strategy.md) decided against
  packaging the IDD execution loop as a Claude Code skill.
- [Skills-based on-demand delivery](skills-delivery-investigation.md) concluded
  no-go on delivering IDD phase instructions as skill bundles.
- [APM distribution strategy](apm-distribution-strategy.md) recommended No-Go on
  adopting Microsoft APM as an additional distribution channel.

Those verdicts cover how phase instructions are delivered. The installer
decides only where the already-shipped payload is placed for each harness. No
phase file becomes a skill.

The rule in `AGENTS.md` against checked-in `.agents/skills/` mirrors covers
repository files. An installed copy under `~/.agents/skills/` lives in the
operator's home directory, outside every repository, so it is not a mirror and
the rule does not apply to it.

## Commands

Run the installer with `node scripts/idd-onboard.mjs` from a checkout of
`kurone-kito/idd-skill`. The package `@kurone-kito/idd-skill` is private in this
checkout, so this page does not assume a registry install. After a successful
install the installer prints `npm install -g` and `pnpm add -g` commands for the
package version. It never runs them itself. Use them only when that version is
published.

```sh
node scripts/idd-onboard.mjs --install-user-global [--harness <list>] [--dry-run]
node scripts/idd-onboard.mjs --uninstall [--dry-run]
```

- `--install-user-global` installs the payload, both skill bundles, and the
  receipt, then edits the selected entry files.
- `--harness <list>` takes a comma-separated list of `claude`, `codex`, and
  `opencode`. The default is all three. Duplicates are ignored. An empty or
  unknown name is a usage error (exit 2). The flag chooses only which entry
  files are edited. The skill bundles go to both skill roots whichever
  harnesses are chosen.
- `--uninstall` removes what the receipt lists. It takes no `--harness`.
- `--dry-run` prints the plan without writing anything.

Both modes take no `--target`, `--source`, `--profile`, `--hold`, `--force`,
`--apply`, or `--allow-root`. Any of these is a usage error (exit 2), and
nothing is written.

Each path is reported on stdout as `create`, `change`, `keep`, or `remove`. A
refusal or a failure goes to stderr as `idd-onboard: refuse: ...` or
`idd-onboard: fail: ...`, and names the path or variable it stopped at. An
invalid `HOME` or data root can fail before any path exists. The message then
names the unresolved root or variable instead.

Exit codes: 0 means done, or planned with `--dry-run`. 1 means the run refused
before writing anything, or failed after a clean plan. 2 means a usage error.

## Preconditions

- `HOME` must be a qualified root: an absolute path that does not start with
  `//` on POSIX. The installer refuses otherwise. `XDG_DATA_HOME`,
  `XDG_CONFIG_HOME`, and `CODEX_HOME` are used only when they are qualified
  roots. Otherwise the defaults under `HOME` apply.
- The installer never creates the directory above a root it installs into.
  These parents must already exist, and a missing one refuses the whole run
  before any write:
  - the parent of the data root, for example `~/.local/share` or
    `$XDG_DATA_HOME`;
  - `~/.claude` and `~/.agents`, the parents of the two skill roots. Both are
    required even when `--harness` selects only Codex CLI;
  - when OpenCode is selected, `~/.config` or `$XDG_CONFIG_HOME`, the parent of
    the OpenCode directory;
  - when Codex CLI is selected and `CODEX_HOME` is set to a qualified path, the
    parent of that path.

  The installer creates a harness directory itself, such as `~/.codex` or
  `~/.config/opencode`, when its parent exists and it is missing.
- The installer refuses on Windows before any write. It needs no-follow file
  opens, and the platform does not provide them.

## What gets written

| Item           | Location                                                                                                                   | Written when        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Payload        | `$XDG_DATA_HOME/idd-skill/<version>/` when `XDG_DATA_HOME` is a qualified root, else `~/.local/share/idd-skill/<version>/` | Always              |
| Current link   | `current` in the data root, pointing at the version directory                                                              | Always              |
| Receipt        | `receipt.json` in the data root                                                                                            | Always              |
| Claude skills  | `~/.claude/skills/issue-authoring/`, `~/.claude/skills/idd-spec-audit/`                                                    | Always              |
| Agent skills   | `~/.agents/skills/issue-authoring/`, `~/.agents/skills/idd-spec-audit/`                                                    | Always              |
| Claude entry   | `~/.claude/CLAUDE.md`                                                                                                      | `claude` selected   |
| Codex entry    | `$CODEX_HOME/AGENTS.md` when `CODEX_HOME` is a qualified root, else `~/.codex/AGENTS.md`                                   | `codex` selected    |
| OpenCode entry | `opencode.json` under `$XDG_CONFIG_HOME/opencode/` when `XDG_CONFIG_HOME` is a qualified root, else `~/.config/opencode/`  | `opencode` selected |

The gated entry text lives at `<data root>/current/user-global/entry.md`. Each
harness reaches it differently. Claude Code's `CLAUDE.md` gets an `@` import of
that file. `AGENTS.md` for Codex gets the entry text in a managed block between
two marker lines. `opencode.json` gets one string in its `instructions` array.
The installer edits an existing entry file in place. For a Markdown file it adds
or replaces only its own managed block. For `opencode.json` it adds one string
to the `instructions` array. The rest of the file stays as it was. When an entry
file does not exist, the installer creates it as a whole file that the receipt
lists.

## Uninstall

`--uninstall` removes what the receipt lists and what still matches it. Run
uninstall with the same `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, and
`CODEX_HOME` values that install used. Uninstall derives the receipt location
and the entry-file paths from those values, so different values can report no
receipt, or refuse recorded entries as outside its roots. Each removal is
reported as `remove`. Before any removal, the run refuses the whole run when a
listed file or link no longer matches its receipt entry, such as a skill file
edited after install. An entry file the installer created is a whole file in the
receipt. Uninstall removes it when its bytes still match, and refuses it as
edited when they do not. An entry file that already existed is different. The
installer rewrites it in place, so uninstall removes only the managed block, or
only the one `opencode.json` string, and keeps the rest of the file. The CLI
reports that rewrite as `change`.

If the run stops partway, it does not roll back. A receipt-listed directory that
is not empty at its turn is kept, and the CLI reports `keep <path> (not empty)`,
so uninstall can finish with that directory still present. Two rewrite failures
need a note. If the receipt rewrite fails after a removal, the receipt can still
list the removed path. A retry reconciles that stale entry, so the receipt does
not match the disk until a run completes. If the receipt rewrite fails after an
entry file was rewritten, uninstall attempts to restore that file's prior bytes.
The restore is best-effort. If it also fails, the edited file stays while the
receipt still lists it, so the entry file and the receipt can disagree until you
check the file or retry the removal. If no receipt exists, the run reports that
there is nothing to remove.

## Failure outcome

Install applies its steps in order and rewrites the receipt after each step.
Two failure cases follow from that.

1. A failure before the receipt rewrite rolls back this run's steps in reverse
   order. If a rollback step itself fails, the message names the path it left in
   place, and that path stays listed. The exception is `current` when an earlier
   run left it unlisted. A later repoint is not recorded, so a rollback error
   can name `current` while the receipt still does not list it, and uninstall
   cannot remove that link. Check it by hand. A later persistence failure can
   make the message name a path that the undo had already removed. Check both
   the path and the receipt before you act.
2. A failed receipt rewrite does not roll back. The message names the path of
   the step whose receipt write failed. Each earlier step was already recorded,
   so that path is normally the only one the receipt does not list. Uninstall
   cannot remove an unlisted path, so the paths stay on disk until you handle
   them. Three cases need more care.
   - If the run created the named path, check it and remove it by hand.
   - If the step only edited an entry file, remove only the installer's
     addition. In a Markdown file that is the managed block between its marker
     lines. In `opencode.json` it is the one string in the `instructions` array.
     Keep the rest of the file.
   - If the step replaced a file, or repointed `current`, that an earlier run
     had listed, the receipt still holds the old hash or target. Uninstall then
     refuses that path as edited. This page gives no automated recovery for that
     case, so check the path by hand before you change anything.

The message says "created" for every path it names. That wording is not accurate
when the step edited or replaced an existing path. A later failure also does not
name a `current` link that an earlier run left unlisted. If an earlier run
left `current` unlisted and a later run repointed it, check that link by hand as
well.

This is the outcome chosen in issue `#4304`: the installer keeps the current
behavior, and the documentation states it.

## Policy layers and overrides

Policy resolves from four layers, lowest to highest:

1. Defaults.
2. The user-global file, `$XDG_CONFIG_HOME/idd-skill/config.json`, or
   `~/.config/idd-skill/config.json` when `XDG_CONFIG_HOME` is not qualified.
3. The one `overrides[]` entry that matches this repository, if any.
4. The repository policy file, `.github/idd/config.json`. The effective loader
   never reads the legacy root `idd-policy.json` as policy. When
   `.github/idd/config.json` is absent, the legacy file's presence alone blocks
   user-global values for the repository-owned fields described below.

Resolution works leaf by leaf. A higher layer replaces a lower layer's leaf
value, and objects merge. A repository-local delegate object, such as
`critiqueLoop.delegate`, replaces the whole object instead of merging into it.
The schema for the user-global file is `schemas/user-global-config.schema.json`.

Each `overrides[]` entry has a `match` and a partial `config`. The `match` holds
exactly one of these keys:

- `repo`: an `owner/repo` slug, compared case-insensitively with the GitHub
  origin.
- `path`: segments that match the end of the main worktree's path. The
  value may be relative or in Windows drive form, such as `C:\...`. This applies
  only when the origin is not `github.com`, so a GitHub Enterprise origin can
  match `path`.

A `repo` entry matches only a repository whose `github.com` origin has that
slug. A `path` entry matches only a repository whose origin is not `github.com`.
The two kinds therefore never compete. Among `path` entries, the one with more
matching segments wins. If two or more entries tie for the highest rank, none
applies, and the run records a diagnostic. An entry with a missing or invalid
`match` key, or a non-object `config`, is ignored with a diagnostic. The loader
does not check unknown keys inside an entry; the user-global schema defines
them. Only one override applies, and its `config` sits above the user-global
values.

To see which layer supplied a key, run `node scripts/idd-effective-config.mjs
--key <dotted.path>` from a checkout of this repository. The installer does not
copy `scripts/` helpers, so an adopter repository uses the package's
`idd-effective-config` command instead, once the package is installed. That
prints the key's value and its source layer. Run it without `--key` to also see
the selected override index and the layering diagnostics. It is read-only.

Phase instructions use these layered values only when `idd-effective-config`
output is available. Without that output they read `.github/idd/config.json` and
no user-global layers. The installer does not copy the helper scripts, so an
install alone does not apply the layers to the phases.

### Repository-policy field class

Some keys belong to the repository itself. They decide merge authority, trusted
markers, CI and waiver decisions, and handoff. Examples are `mergePolicy`,
`trustedMarkerActors`, `ciGate`, `advisoryWait`, `helperRuntime`, and
`forcedHandoff`. When the repository has `.github/idd/config.json`, or only the
legacy root `idd-policy.json`, user-global and override values for these keys
are dropped. The legacy file blocks them by its presence alone. Without any such
file they apply as usual. The full list is `REPOSITORY_POLICY_FIELDS` in
`src/scripts/layered-policy.mts`. One exception applies to
`issueAuthoring.adversarialReview`. The user-global fragment is retained when
the repository leaves that fragment absent, so its `delegate` and `waitCeiling`
keys both reach the resolver. Only the issue-authoring delegate reads the
delegate, and a user-global `waitCeiling` is ignored, as the workflow guide
states. A repository-local `adversarialReview` object with an unknown key blocks
the fragment. A present local `delegate`, including `null` or a malformed value,
blocks the delegate.

## Global-only profile

The installed payload alone does not activate IDD in a repository. Without the
core instruction file, a repository policy file, or a matching user-global
override, the gate returns `no-activation-rule`. A repository with a policy file
or a matching override can run IDD from the installed payload, without copying
the instruction files, when the gate reports `repository-policy-minimal-import`
or `user-global-override-match`, and the repository has neither the advisory
workflow nor the cleanup workflow. The conditions and the trust rule are in
[Global-only profile](global-only-profile.md).

The profile has local substitutes. The post-merge cleanup run is replaced by the
local cleanup path, and the IDD labels are created through the GitHub API, for
example with `gh label create`, instead of a committed file. The advisory check
leaves the required list only when `pre-merge-readiness` runs with
`--global-only` and both conditions hold on the trusted base ref and the PR
head. An unavailable read keeps the check required.

### Initial journal and policy bootstrap

An installed payload alone does not activate a repository. When there is no
core instruction file, repository policy, or matching user-global override,
`idd-activation` reports `no-activation-rule`; the user-global entry then does
nothing IDD-specific. Do not run another IDD helper or change repository state
while that result is inactive. This missing first-journal sequence was observed
on 2026-10-17 in [PR 3](https://github.com/kurone-kito/DDMMHBC/pull/3) and
rechecked on 2026-10-17 after
[PR 20](https://github.com/kurone-kito/DDMMHBC/pull/20).

Only a maintainer/operator using the ordinary, human-controlled repository
process performs the bounded setup below, outside the gated agent session. An
agent session that read `active: false` remains a no-op and makes no repository
changes until the activation gate reports `active: true`.

For a policy-only first activation, a maintainer completes one bounded setup
outside normal IDD authoring and execution:

Before creating either issue below, put a unique, stable marker in its intended
body. If an issue-creation result is uncertain, do not retry until both reads
below are complete. Search all issue states in the target repository for the
intended title and marker, then verify the result with the
[paginated repository issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues)
using `state=all` and following pagination through every page. Treat the API
read as unavailable if any page cannot be read. If both reads identify the same
single suitable issue, record its canonical `owner/repo#number` and do not
retry. Retry only when both complete, successful reads find no match. If the
reads disagree, either read is unavailable, multiple matches exist, or a match
is unsuitable to continue, stop and reconcile manually.

1. Create a durable, comment-only journal issue first. Record its canonical
   `owner/repo#number`; it is infrastructure for authoring records, not an IDD
   work item. Apply the issue-creation reconciliation rule above if the result
   is uncertain.
2. Prepare the first issue for the repository policy outside the
   normal held-issue publisher. Point
   `issueAuthoring.journalIssue` to the journal that already exists.
   Apply the issue-creation reconciliation rule above if the result is
   uncertain.
   If the issue cannot be published, keep the journal and continue
   preparation outside normal IDD.
3. Review and land the first policy through the repository's ordinary
   change process, linking its PR with a closing keyword for the first policy
   issue (for example, `Closes #<issue-number>`). If landing is uncertain,
   inspect the policy PR state and merge commit, then read the policy from the
   current trusted base. Treat it as landed only when the PR is merged and that
   policy is present on the base. Verify that the first policy issue is closed
   before returning to normal IDD. Otherwise keep the journal and preparation
   outside the IDD loop. Do not make the policy PR depend on a new
   `ciGate.*` value that only its own head contains; follow [ciGate F2 bootstrap](customization.md#cigate-f2-bootstrap).
4. Before returning to normal IDD, verify that `idd-activation` reports
   `active: true` through the repository-policy or matching-override route. For
   `repository-policy-minimal-import`, put the first policy in the canonical
   `.github/idd/config.json` and inspect `idd-doctor --repo-root
   "<repository-root>" --json`. Require its `passes` array to include
   `.github/idd/config.json validates against policy.schema.json`. The command
   may still exit nonzero because a policy-only repository lacks the full-core
   instruction and reference files; that overall exit status does not replace
   the schema-specific pass. If the pass is absent or the report identifies the
   canonical policy as invalid, stop. A legacy root `idd-policy.json` can
   activate the gate, but it is not loaded as effective policy. Inspect the
   effective `issueAuthoring.journalIssue` value and its source, using
   `idd-effective-config` when available, and confirm it resolves to the
   existing durable journal. Also verify that the selected helper runtime can
   use the capability-checked held-publication flow. That flow must apply the
   configured `issueAuthoring.authoringLabelName`, publish the exact
   publication token, and use an actor with the required trusted write
   authority. An explicit `--policy` path selects configuration but does not
   create or replace the journal. If any result is missing or unverifiable,
   stop and name the prerequisite to repair. The installed payload, an issue
   body, and a GitHub hold label do not establish activation or publisher
   readiness.

This exception covers only the initial journal and first policy issue. It does
not authorize later direct issue creation, bypass the normal authoring-owner
protocol, or permit an automatic merge. A repository-match user-global
override remains a supported activation route, and policy-only adoption does
not require the optional full-core import. See the
[Global-only profile](global-only-profile.md) for the reusable boundary and the
[issue-mediated bootstrap guide](../idd-template/docs/onboarding/issue-mediated-bootstrap.md).

## Activation gate and context cost

The entry text tells the agent to run `idd-activation` from the repository
directory and to read its JSON output. If `active` is `true`, the agent opens
`.github/instructions/idd-overview-core.instructions.md` under the reported
`instructionsRoot` and follows the phase routing from there. Otherwise it does
nothing IDD-specific.

The context cost is the entry text itself, kept under 1200 bytes by a test, and
each session of an installed harness loads it. The IDD overview and the phase
files load only after the gate reports `active`. The gate is read-only and makes
no network calls.

Run `idd-activation` from the repository directory. The command takes `--cwd
<path>` to classify another directory. If the command is absent from `PATH`, use
`~/.local/bin/idd-activation` on POSIX. On Windows, use
`& "$HOME\.local\bin\idd-activation.cmd"` in PowerShell or
`"%USERPROFILE%\.local\bin\idd-activation.cmd"` in Command Prompt. Those
executables are deployed by the host setup; `--install-user-global` installs
the payload and does not copy CLI helpers or write to `~/.local/bin`. The
onboarding output prints separate `npm install -g` and `pnpm add -g` commands
for installing the package CLI. From a checkout of this repository, run `node
scripts/idd-activation.mjs [--cwd <path>]`.

The gate checks these rules in order and stops at the first match:

| Reason                             | Tier                 | Result                                                                                                   |
| ---------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `not-a-git-work-tree`              | none                 | Inactive. The directory is not inside a Git work tree.                                                   |
| `repository-instruction-files`     | repository-local     | Active. The repository has the core instruction file.                                                    |
| `repository-policy-minimal-import` | repository-local     | Active. The repository has `.github/idd/config.json` or `idd-policy.json`, and the payload is installed. |
| `user-global-override-match`       | user-global-override | Active. A user-global override matches, and the payload is installed.                                    |
| `no-activation-rule`               | none                 | Inactive. No rule matched, so the entry text does nothing.                                               |

The gate counts the legacy root `idd-policy.json` as a repository policy signal,
as the table shows. The effective loader does not read it as policy. The two
checks are separate.

The two rules that need the installed payload,
`repository-policy-minimal-import` and `user-global-override-match`, stay
inactive when it is unavailable. They report `payload-root-unresolved` (no
qualified data root) or `payload-not-installed` (the core instruction file is
missing from the payload, is not a regular file, or cannot be checked). The
`repository-instruction-files` rule does not check the payload.

## CI off switches

- `GITHUB_ACTIONS=true` skips the user-global layers for the policy loader and
  for the user-global fragment readers of the four helpers below. A CI helper
  sees the repository policy and the defaults only.
- `--no-user-global` skips the same layers for one run. It is accepted by
  `idd-effective-config`, `idd-issue-authoring-delegate`,
  `idd-critique-delegate`, and `idd-critique-telemetry-hook`.

The activation gate has neither switch. It reads the user-global file directly.
A runner without an installed payload reports `payload-not-installed` or
`payload-root-unresolved` only when the repository has a policy file or a
matching override. Otherwise the gate returns `no-activation-rule`. A repository
with its own core instruction file stays active without the payload. The helper
behavior is described in [IDD helper scripts](idd-helper-scripts.md).

## Deferred harnesses

The installer does not install entry wiring for Antigravity or Gemini CLI,
GitHub Copilot CLI, Cursor CLI, or Grok Build. Issue `#3817` recorded that
Cursor CLI documents no file-based global instruction file, and that Copilot CLI
does not load imports from home paths. These four harnesses need their own
investigation.

Selecting the lite instruction bundle per operator through a user-global
`instructionProfile` is also deferred until the policy schema carries that
field.
