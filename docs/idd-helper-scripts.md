# IDD Helper Script Evaluation

This document records the current decision on optional helper scripts for
the IDD workflow. It exists so future reviews can reference the trade-off
directly instead of re-evaluating the same suggestion from scratch.

## Decision

In this source repository, adopt one narrow helper for post-merge
comment cleanup auditing: `scripts/audit-pr-cleanup.mjs`.

The canonical workflow remains the portable shell / `gh` / `jq`
instructions embedded in `.github/instructions/*.instructions.md`.
Other helper candidates remain deferred because they would create a
second implementation surface while the review, advisory-wait, and claim
protocols are still changing through dogfooding.

The exported template remains portable without a `scripts/` directory.
Adopters can copy the helper separately when they want the same
repository-local convenience, otherwise the documented GraphQL fallback
remains the portable path.

The cleanup helper is intentionally narrower than E/F gate helpers:

- dry-run is the default and prints stable JSON unless `--format table`
  is requested
- apply mode is explicit and can re-validate an active claim before
  every minimization mutation
- cleanup remains best-effort and never becomes a merge gate
- direct GraphQL fallback commands remain documented in
  `docs/idd-comment-minimization.md`

## Friction Inventory

The repeated query patterns most likely to benefit from helpers are:

| Pattern                         | Current friction                                                                                                        | Helper risk                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Claim-state parsing             | HTML marker parsing is stateful and easy to simplify incorrectly.                                                       | A script would become another parser that must stay exactly aligned with the instruction rules.               |
| Review activity snapshots       | E1/F2/F3 need the same activity universe and marker exclusions.                                                         | Any mismatch between script output and written gates could make merge freshness checks unsound.               |
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
and use only a narrow post-merge cleanup helper where mistakes are
recoverable and do not affect merge safety.

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

Good future candidates would be read-only snapshot commands for review
activity, advisory-wait state, or claim-state inspection. They should
not replace the written decision tables.
