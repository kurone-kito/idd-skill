# IDD Helper Script Evaluation

This document records the current decision on optional helper scripts for
the IDD workflow. It exists so future reviews can reference the trade-off
directly instead of re-evaluating the same suggestion from scratch.

## Decision

Do not adopt helper scripts yet.

The canonical workflow remains the portable shell / `gh` / `jq`
instructions embedded in `.github/instructions/*.instructions.md`.
Optional helpers may be reconsidered later, but adding them now would
create a second implementation surface while the review, advisory-wait,
and claim protocols are still changing through dogfooding.

## Friction Inventory

The repeated query patterns most likely to benefit from helpers are:

| Pattern                         | Current friction                                                                                      | Helper risk                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Claim-state parsing             | HTML marker parsing is stateful and easy to simplify incorrectly.                                     | A script would become another parser that must stay exactly aligned with the instruction rules.        |
| Review activity snapshots       | E1/F2/F3 need the same activity universe and marker exclusions.                                       | Any mismatch between script output and written gates could make merge freshness checks unsound.        |
| Advisory-wait marker parsing    | AW1/AW2 combine review API state, requested reviewers, marker comments, and elapsed-time rules.       | A helper could hide important decision-table semantics that agents must still understand during holds. |
| Final pre-merge freshness check | The merge path repeats review, comment, thread, CI, claim, and advisory checks immediately before F3. | A mutating helper would be risky; even a read-only helper needs strict output contracts.               |
| Branch protection/ruleset reads | Required review and check discovery can be verbose across GitHub APIs.                                | Ruleset coverage varies by repository, so a helper could create false confidence in unsupported cases. |

## Trade-off

Helper scripts would improve copy/paste reliability and make some
review-state checks easier to audit locally. That benefit is real,
especially for advisory-wait and review-snapshot commands.

The portability cost is also real. The exported IDD template is meant to
work in repositories that can copy Markdown instruction files without
adopting a runtime, package manager, or repository-local script
directory. If helper scripts are introduced too early, every operational
rule must be maintained twice: once in the instructions that agents read,
and once in code that agents run.

For now, the safer balance is to keep the instructions canonical and use
documentation refactors to centralize repeated logic before introducing
code.

## Future Adoption Criteria

If helper scripts are revisited, they should satisfy all of the
following:

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

Good candidates for a future first helper would be read-only snapshot
commands for review activity, advisory-wait state, or claim-state
inspection. They should not replace the written decision tables.
