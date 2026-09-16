---
type: investigation
title: IDD Canonical Phase Re-order Proposal
description: Records a readability-first proposal for replacing decimal phase IDs while preserving routing and marker compatibility.
tags: [investigation, phase-model, routing]
---

# IDD Canonical Phase Re-order Proposal

This investigation answers the ordering question from issue
[#3030](https://github.com/kurone-kito/idd-skill/issues/3030), under the
corpus-token-cost roadmap [#3026](https://github.com/kurone-kito/idd-skill/issues/3026).
It is a design record only. It changes no instruction file, template,
schema, resolver, or runtime behavior.

## Scope and baseline

The current phase vocabulary grew by inserting seven decimal labels into
an otherwise family-and-number sequence:

- discovery: `A1.5`, `A3.5`, and `A4.5`;
- PR submission: `D3.5`, `D3.6`, and `D3.7`; and
- merge handoff: `F2.5`.

The issue acceptance criterion calls the migration corpus the “763-reference”
corpus. This document repeats that label only to identify the issue scope; it
does not assert that the current tree has that count or use it as a success
threshold. The implementation must regenerate the inventory before every
migration batch. The migration inventory should cover every tracked
repository file, including hidden and generated surfaces such as
`.claude/skills/`, `CHANGELOG.md`, and `audit/sync-manifest.json`, rather
than relying on a manually maintained list of roots. A reproducible inventory
can be produced with the following repo-wide command shape:

```sh
phase_id_pattern='A1\.5|A1_5|A3\.5|A3_5|A4\.5|A4_5|F2\.5|F2_5|D3\.5|D3_5|D3\.6|D3_6|D3\.7|D3_7'
git grep -l -E "$phase_id_pattern" -- . | sort -u
git grep -h -o -E "$phase_id_pattern" -- . | wc -l
```

This inventory intentionally follows tracked repository content, so it
includes hidden and generated files while excluding untracked dependency
trees. The file list and count are evidence for the current batch, not
success criteria that a later batch may reuse unchanged.

The machine-facing resolver currently contains `A1_5`, `A3_5`, `A4_5`,
and `F2_5` as canonical IDs with dotted, hyphenated, and compact aliases.
The visible `D3.5`–`D3.7` procedure labels are nested under `D3`, but are
not entries in `DEFAULT_CANONICAL_PHASE_IDS`. That distinction is part of
the proposal: a future implementation must update the resolver, parser,
documentation, and tests as one contract rather than silently treating
the nested labels as an unrelated vocabulary.

## Finding 1 — Decimal insertion hides responsibility and order

The decimal labels are understandable locally, but they make the global
sequence look as though a late exception belongs between two numbered
steps without saying what responsibility it owns. The problem is clearest
in D3: the current prose derives the IDD impact checklist before it
verifies the closing keyword after PR creation, although the labels read
`D3.5` followed by `D3.6`. A reader or routing model should be able to
identify both the owning phase family and the purpose of an inserted gate
without reconstructing the history that created its number.

The stable integer phases do not have the same problem. Renumbering all
later phases to make room for every insertion would expand the migration
surface, invalidate more live references, and provide little additional
meaning. The safer design is therefore to retain stable integer IDs and
give each inserted phase a semantic canonical suffix.

## Finding 2 — Proposed canonical route

The recommended route preserves the existing major-family order and
makes the inserted responsibilities explicit:

```text
A0 -> (A0_O | A0_T | A1)
A1 -> A1_AUDIT -> A2 -> A3 -> A3_APPROVAL -> A4 -> A4_SUITABILITY -> A5
A5 -> B1 -> B2 -> B3 -> C1 -> C2 -> C3 -> C4 -> C5 -> C6
C2 -> D1 (zero findings and floor passed)
C4 -> D1 (clean exit and floor passed)
C6 -> C1 (next critique pass)
D1 -> D2 -> D3 -> D3_IMPACT -> D3_CLOSE -> D4
D4 -> E1 -> E2 -> E3
E3 -> E4 -> E5 -> E6 -> E7 -> E8
E3 -> Esync (empty snapshot)
E8 -> Esync (zero Accepted PATH A)
E8 -> E9 -> E10 -> E11 -> E12 -> E13 -> E14 -> E15
E15 -> E1 (CI success)
Esync -> F1 -> F2
F2 -> E1 (not ready)
F2 -> D3_PREMERGE -> F2_HANDOFF -> F3 -> F4 -> F5
F5 -> A -> A1
```

The first line shows alternatives, not a requirement that all three A0
routes execute. `A0_O` and `A0_T` remain their existing orphan and
explicit-target shortcuts. `Resume` remains a routing entry that may
return to the appropriate point in this sequence; it is not renumbered.
C2 and C4 provide the clean C-phase exits to D1 after the validation floor;
C6 returns to C1 for the next critique pass. The E-phase has two exits from
E3: an empty snapshot goes directly to `Esync`, while a non-empty snapshot
goes through E4-E8.
From E8, zero Accepted PATH A items goes to `Esync`; accepted PATH A work
goes through E9-E15, and a successful E15 CI wait returns to E1 for a fresh
snapshot. The F2 edge to E1 represents an unmet merge condition. `A` stays
the collapsed return target for F5, after which discovery resumes at A1.

The D3 entries are nested checkpoints in one PR-submission phase, so the
future implementation should document their ownership as follows:

1. `D3_IMPACT` derives the PR-template impact checklist while assembling
   the body, before the PR is created.
2. `D3_CLOSE` verifies the plain-text closing keyword and exact closing
   set after creation.
3. `D3_PREMERGE` is not a D3-to-D4 checkpoint. F2 runs the closing-set and
   impact-checklist verification against the final HEAD at the F2/F2.5
   boundary, and F3 repeats that gate immediately before merge.

This is an ordering clarification, not a request to split D3 into three
independent execution loops. The three names are still useful phase IDs
for markers, routing documentation, and future on-demand packaging, while
`D3_PREMERGE` remains owned by the pre-merge boundary in the route above.

## Finding 3 — Dispositions and compatibility aliases

The following table is the complete disposition of the seven decimal
insertions. The old spellings remain accepted after the future canonical
rename; no historical issue or PR comment is rewritten.

| Existing label  | New canonical ID | Position and reason                                                                             |
| --------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `A1.5` / `A1_5` | `A1_AUDIT`       | After roadmap discovery and before child enumeration; names the completed-roadmap audit.        |
| `A3.5` / `A3_5` | `A3_APPROVAL`    | After readiness filtering and before viability selection; names the issue-author approval gate. |
| `A4.5` / `A4_5` | `A4_SUITABILITY` | After viable selection and before claim; names pre-claim suitability triage.                    |
| `D3.5` / `D3_5` | `D3_CLOSE`       | After PR creation; names closing-keyword and exact closing-set verification.                    |
| `D3.6` / `D3_6` | `D3_IMPACT`      | Before PR body creation; names mechanical IDD impact-checklist derivation.                      |
| `D3.7` / `D3_7` | `D3_PREMERGE`    | At the pre-merge boundary; names final-head re-verification.                                    |
| `F2.5` / `F2_5` | `F2_HANDOFF`     | Between pre-merge conditions and merge execution; names merge-policy handoff.                   |

Changing the canonical emitted IDs is a versioned breaking migration, not a
transparent cleanup. The aliases let a new reader consume historical
markers and other old records, but an older consumer cannot automatically
understand a newly emitted semantic ID. Before changing emitted output, the
future implementation must therefore either keep the existing machine
canonicals and make semantic names display-only, or publish an explicit
versioned migration with downstream consumer updates and notice. This
proposal recommends the latter only as a separately scoped implementation
decision; the alias map below covers historical-read compatibility, not
backward interpretation of new output by old consumers.

The future `DEFAULT_LEGACY_ALIASES` entry should retain the exact shape
already used by `src/scripts/phase-id-resolver.mts`:

```ts
const DEFAULT_LEGACY_ALIASES: Record<string, string[]> = {
  A1_AUDIT: ['A1.5', 'A1-5', 'A15', 'A1_5'],
  A3_APPROVAL: ['A3.5', 'A3-5', 'A35', 'A3_5'],
  A4_SUITABILITY: ['A4.5', 'A4-5', 'A45', 'A4_5'],
  D3_CLOSE: ['D3.5', 'D3-5', 'D35', 'D3_5'],
  D3_IMPACT: ['D3.6', 'D3-6', 'D36', 'D3_6'],
  D3_PREMERGE: ['D3.7', 'D3-7', 'D37', 'D3_7'],
  F2_HANDOFF: ['F2.5', 'F2-5', 'F25', 'F2_5'],
};
```

The old underscore spelling is included deliberately even when it was a
previous canonical spelling. A published marker may contain it, and an
in-flight adopter session may have persisted it before the implementation
lands. Alias acceptance should be permanent: the workflow cannot reliably
discover when an old issue comment, PR marker, or archived adopter session
has stopped being read.

## Finding 4 — Keep the collapsed `A` graph node

The `A` node in `schemas/phase-graph.json` should remain a collapsed,
routing-only node. It is the return target from `F5` and represents the
discovery family as a whole; it is not a concrete execution phase. The
concrete A0–A5 entries remain the resolver vocabulary used by phase
markers and instruction routing.

Issue [#3029](https://github.com/kurone-kito/idd-skill/issues/3029) shipped
the graph/resolver consistency guard and recorded the deliberate `A`
exemption. Expanding `A` into every discovery sub-phase would duplicate
the decision tree in the graph, introduce extra cycle edges, and add no
information that a session cannot get from the discovery instructions.
The implementation must therefore keep `A` outside both the canonical
resolver list and the alias map, while retaining the explicit graph-test
exemption.

## Finding 5 — Batch the issue-scoped reference migration

The issue-scoped corpus named in the acceptance criterion is the
763-reference migration, but that number is not a current-tree invariant.
The safe unit of migration is one phase family and its direct generated
mirrors, with the compatibility contract landed first. The implementation
should use this order:

1. Add and test the new canonical IDs and aliases in the resolver and
   every parser or schema contract that reads them. This makes old and new
   spellings readable before any textual migration begins.
2. Migrate one source-of-truth phase family at a time. For generated
   instruction or documentation mirrors, edit the canonical source,
   regenerate the mirror, and inspect the resulting diff before moving on.
3. Migrate the directly related docs, examples, tests, and fixtures for
   that same family. Keep historical incident text and compatibility
   fixtures in the explicit old-spelling allowlist rather than changing
   their evidence.
4. After each batch, rerun the fresh inventory, resolver and graph tests,
   generated-source checks, and documentation audits. A batch is not
   complete while an old spelling remains outside the allowlist or while
   the tree is not green.

This rule keeps each batch independently reviewable and prevents a partial
rename from leaving a parser or generated mirror behind. It also avoids
using the 763 baseline as a hard-coded success condition: the next batch
starts from the inventory it actually observes.

Some live surfaces cannot be reached by a tree rewrite. Published issue
and PR markers, review comments, claim or watermark records, and in-flight
adopter sessions may retain an old ID indefinitely. The alias map must
continue to resolve those records, including the old underscore form, and
Resume must use the same compatibility path. No migration batch should
edit or delete those forge records merely to make the repository search
come back empty.

## Finding 6 — Sequence the lite mirror with the standard corpus

The future implementation should migrate the `.github/instructions/lite/`
shadow files in the same change and in the same corresponding phase-family
batches as the standard corpus. Recompute the actual shadow-file set from
the sync manifest when planning each batch rather than freezing its current
topology in this proposal. A lite reader must not see a different phase
vocabulary for the same gate, and the compatibility aliases must cover both
profiles during rollout.

That recommendation does not widen issue [#2968](https://github.com/kurone-kito/idd-skill/issues/2968).
Only lines carrying the phase vocabulary and their existing mirror
contract are in scope; unrelated lite parity gaps remain in #2968's
backlog. This issue itself does not edit the lite tree because its
acceptance criteria explicitly prohibit changes outside `docs/` and the
generated source-repository index.

## Recommendation — adopt semantic suffixes, defer implementation

Adopt the mapping in Finding 3 for a later, separately scoped
implementation issue. It improves readability and routing correctness
while preserving stable integer neighbors, retaining a permanent alias
path for old live records, and keeping the graph's deliberate `A`
abstraction. Because canonical output changes are breaking for older
consumers, that implementation issue must also name its version boundary,
downstream migration notice, resolver, parser, schema, source-mirror, and
lite-mirror changes as one bounded batch plan.

This is not a token-reduction proposal. Re-ordering moves bytes between
positions; it removes none. The roadmap's measured literal cross-file
duplication baseline is 0.8%, so there is no redundancy for the rename to
reclaim. Any token reduction would require a separate content-diet or
session-boundary decision and must not be attributed to this phase model.

## Revisit conditions

Revisit this proposal before implementation if any of the following
changes:

- the graph gains concrete discovery nodes and the `A` exemption no longer
  describes the shipped model;
- a maintainer selects a different semantic naming vocabulary, in which
  case the disposition table and aliases must be replaced together;
- a bounded retention policy for old forge markers becomes enforceable;
  until then, aliases remain permanent; or
- the lite profile changes its shadow-file topology, requiring the batch
  rule to be recalculated without turning #2968 into an implicit dependency.

The verification for this investigation is limited to OKF frontmatter,
the generated docs index link, Markdown and spelling checks, and the full
repository `pre-push-validate` command. It deliberately does not claim
that the future resolver rename, schema update, or runtime migration has
already been implemented.
