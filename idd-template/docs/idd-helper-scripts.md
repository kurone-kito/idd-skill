# IDD Helper Script Evaluation

This document records the current decision on optional helper scripts for
the IDD workflow. It exists so future reviews can reference the trade-off
directly instead of re-evaluating the same suggestion from scratch.

## Decision

In the idd-skill source repository, three optional helpers were adopted:

- `scripts/review-activity-snapshot.mjs` for read-only E/F review
  activity and CI snapshot metrics
- `scripts/live-status-digest.mjs` for issue or PR live status digest
  discovery, rendering, dry-run, and claim-checked upsert
- `scripts/audit-pr-cleanup.mjs` for post-merge comment cleanup auditing

The canonical workflow remains the portable shell / `gh` / `jq`
instructions embedded in `.github/instructions/*.instructions.md`. The
helpers are convenience layers only; written decision tables and phase
rules remain authoritative when outputs diverge.

The exported template remains portable without a `scripts/` directory.
Adopters can copy the helper separately when they want the same
repository-local convenience, otherwise the documented GraphQL fallback
remains the portable path.

Absent helper runtime configuration means `instructions-only`. Repositories
that do not opt into helper support should still be able to copy the
Markdown instructions, run the portable shell / `gh` / `jq` procedures,
and complete the workflow without a Node.js dependency.

## Helper Runtime Profiles

When a repository imports the IDD template, helper support should be
selected from one of these profiles:

| Profile             | Intended use                                                                                                                | Dependency model                                                               | Portability expectation                                                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `package-manager`   | The adopter already uses pnpm, npm, or yarn for the repository.                                                             | Reuse the repository's existing package manager and pre-resolved dependencies. | Preferred when a package manager project already exists; do not fall back to ad hoc `npx` in this mode.                                 |
| `vendored-node`     | The adopter has Node.js available but does not want helper execution to depend on registry resolution at runtime.           | Copy a local helper bundle into the repository during import.                  | Keeps helper execution repository-local while remaining optional.                                                                       |
| `ephemeral-npx`     | The adopter has Node.js available, does not vend helper files, and can resolve a runnable helper command at execution time. | Resolve helper execution through one-shot `npx` commands.                      | Reserved for cases where a published or otherwise resolvable helper command already exists; otherwise fall back to `instructions-only`. |
| `instructions-only` | The adopter does not want or cannot use helper scripts.                                                                     | No helper runtime. Agents follow the Markdown instructions directly.           | First-class supported fallback; no helper config is required.                                                                           |

## Import-Time Selection Order

Helper runtime choice is an import-time policy decision. Apply this order
only after a maintainer or import flow has explicitly opted into helper
support. If helper support was not requested, keep `instructions-only`.

1. If helper support has not been requested, use `instructions-only`.
2. Otherwise, if the repository already has a supported package manager
   project, select `package-manager`.
3. Otherwise, if Node.js is available and the import flow is allowed to
   copy helper files, select `vendored-node`.
4. Otherwise, if Node.js is available and a published or otherwise
   resolvable helper command exists for one-shot execution, select
   `ephemeral-npx`.
5. Otherwise, use `instructions-only`.

This selection order exists to keep helper support optional without
turning every adopter into a Node.js-first repository. The written
decision tables remain the canonical protocol regardless of which helper
profile is selected.

The adopted helper boundaries are intentionally narrow:

- `review-activity-snapshot.mjs` is read-only, emits machine-readable
  metrics, and does not evaluate accept/reject dispositions or merge
  decisions
- it does not replace the E/F gate decision tables; it only reduces
  command-copy variance when collecting canonical snapshot fields

- `live-status-digest.mjs` defaults to dry-run, supports issue and PR
  targets, and mutates only with explicit `--apply`
- apply mode re-validates an active claim unless a maintainer explicitly
  uses `--skip-claim-check`
- it creates or updates only the single current digest comment and
  refuses duplicate marked digests with repair URLs instead of choosing
  one, deleting, or minimizing audit history
- digest text remains non-authoritative UI state; phase decisions still
  come from trusted markers and GitHub state

- `audit-pr-cleanup.mjs` defaults to dry-run and prints stable JSON
  unless `--format table` is requested
- apply mode is explicit and can re-validate an active claim before
  every minimization mutation
- known review-bot regular comments are considered only after merge and
  only when they match a completed-review or stale-notification signal
- cleanup remains best-effort and never becomes a merge gate
- direct GraphQL fallback commands remain documented in
  `docs/idd-comment-minimization.md`

## Friction Inventory

The repeated query patterns most likely to benefit from helpers are:

| Pattern                         | Current friction                                                                                                        | Helper risk                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claim-state parsing             | HTML marker parsing is stateful and easy to simplify incorrectly.                                                       | A script would become another parser that must stay exactly aligned with the instruction rules.               |
| Review activity snapshots       | E1/F2/F3 need the same activity universe and marker exclusions.                                                         | Any mismatch between script output and written gates could make merge freshness checks unsound.               |
| Live status digest edits        | Each phase repeats marker discovery, create/update/no-op handling, duplicate refusal, and claim revalidation.           | A mutating helper could make digest text look authoritative unless docs keep it as UI-only state.             |
| Advisory-wait marker parsing    | AW1/AW2 combine review API state, requested reviewers, marker comments, and elapsed-time rules.                         | A helper could hide important decision-table semantics that agents must still understand during holds.        |
| Final pre-merge freshness check | The merge path repeats review, comment, thread, CI, claim, and advisory checks immediately before F3.                   | A mutating helper would be risky; even a read-only helper needs strict output contracts.                      |
| Post-merge cleanup candidates   | F4 cleanup requires repeat GraphQL checks for marker comments, review parents, permissions, and resolved child threads. | Adopted narrowly as `scripts/audit-pr-cleanup.mjs`; dry-run first, apply only after F3, and never gate merge. |
| Branch protection/ruleset reads | Required review and check discovery can be verbose across GitHub APIs.                                                  | Ruleset coverage varies by repository, so a helper could create false confidence in unsupported cases.        |

## Trade-off

Helper scripts can improve copy/paste reliability and make some
review-state checks easier to audit locally. That benefit is real,
especially for advisory-wait, review-snapshot, and post-merge cleanup
commands.

The portability cost is also real. The exported IDD template is meant to
work in repositories that can copy Markdown instruction files without
adopting a runtime, package manager, or repository-local script
directory. If helper scripts are introduced too early, every operational
rule must be maintained twice: once in the instructions that agents read,
and once in code that agents run.

For now, the safer balance is to keep pre-merge instructions canonical
while allowing one read-only E/F snapshot helper, one live digest upsert
helper, and one post-merge cleanup helper. Merge safety still depends on
the written checks, not on helper output alone.

## Non-goals

This helper policy does **not** imply the following:

- Node.js becomes mandatory for repositories that only copy the Markdown
  instructions
- helper output becomes authoritative over the written decision tables
- helpers perform mutating review or merge actions by default; mutation
  must remain explicit in the written instructions
- the project is committed to publishing a separate npm package before
  the local and templated helper profiles are proven

## Future Adoption Criteria

If additional helper scripts are revisited, they should satisfy all of
the following:

- They are optional and never required to execute the exported template.
- They are read-only by default; mutating actions remain explicit in the
  phase instructions.
- They output stable machine-readable JSON that can be inspected and
  compared by agents.
- They keep the shell / `gh` / `jq` fallback documented beside the helper
  path.
- They have a small test fixture set for marker parsing and snapshot
  filtering.
- They are introduced only after the corresponding instruction protocol
  has stabilized enough that drift risk is lower than command-copy risk.

Good future candidates would be read-only snapshot commands for
advisory-wait state or claim-state inspection. They should not replace
the written decision tables.
