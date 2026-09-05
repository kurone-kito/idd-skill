---
type: reference
title: OKF Frontmatter Profile
description: Defines the OKF v0.1 frontmatter field profile, bundle scope, and conformance rules this repository's docs corpus adopts.
tags: [okf, frontmatter, docs-metadata]
---

# OKF Frontmatter Profile

This page records the [OKF](https://okf.md/) (Open Knowledge Format
v0.1) frontmatter field profile the parent roadmap
(kurone-kito/idd-skill#1685) adopts across `docs/**` and
`idd-template/docs/**`. It is source-repo-only reference material, not
a phase file: it changes no workflow behavior. The profile is enforced
mechanically by the `okfBundles` entry in `audit/sync-manifest.json`
and the checker in `src/scripts/consistency-helpers.mts`
(`node scripts/audit-docs.mjs --check`).

This page itself conforms to the profile it defines — its own
frontmatter is the worked example.

## Bundle scope

The `docs-okf` bundle covers `docs/**/*.md` and
`idd-template/docs/**/*.md`. The following are deliberately excluded,
and the checker never widens into them:

- **`.github/instructions/**`** (and its `idd-template/` mirror) — these
  files already carry a different, consumer-specific frontmatter
  contract (`applyTo:`, `excludeAgent:`) that GitHub Copilot's custom
  instructions loader parses; mixing in OKF keys would collide with
  that contract. They are also the tightest byte-budget surface in the
  repository — `instructionSizeBudgets` caps each file at 20,000 or
  36,000 bytes and `bundleBudgets` caps whole phase bundles at
  104,000–126,000 bytes
  (see [Policy constants](policy-constants.md)) — because every byte is
  loaded verbatim into an agent's context on every session. Frontmatter
  metadata that provides no runtime value to the loop is not worth
  spending that budget on. A later session must not widen this bundle's
  `roots` into `.github/instructions/**` for either reason.
- **`skills/**` and `.claude/skills/**`** — these carry the Agent
  Skills `name:`/`description:` frontmatter contract their own runtime
  loader parses; OKF fields are out of scope there for the same
  contract-collision reason.
- **Fixtures, examples, root Markdown, and community documents** —
  `fixtures/**`, `examples/**`, `tests/fixtures/**`, root-level files
  (`README.md`, `CLAUDE.md`, …), and community documents
  (`CODE_OF_CONDUCT*`, `CONTRIBUTING*`) are not reference documentation
  pages and are out of scope by construction, not by an `exemptPaths`
  entry.

## Field profile

<!-- dprint-ignore-start -->
| Field | Required | Rule |
| --- | --- | --- |
| `type` | yes | One value from the closed set below |
| `title` | yes | Matches the page's `# H1` text exactly |
| `description` | yes | One sentence, ending in a period. Consumed by the generated docs index table in `docs/index.md` (`docs-index-okf-table` generated block, #1683) — not decorative. |
| `tags` | no | YAML list of lowercase-hyphen strings |
<!-- dprint-ignore-end -->

### Closed `type` vocabulary

`index`, `guide`, `concept`, `reference`, `workflow`, `design`,
`investigation`, `tutorial`.

Adding a value is a deliberate edit to this table, this section, and
the matching manifest entry's `types` list (`audit/sync-manifest.json`
→ `okfBundles[].types`) — never an ad hoc choice made at backfill time
for one page.

## Deliberately omitted OKF fields

OKF v0.1 itself only strictly requires `type`; `title`, `description`,
`resource`, `tags`, and `timestamp` are its own "recommended" fields,
and it MUST tolerate unknown types and unrecognized keys — this profile
narrows that open floor with repository-specific rules (required
`title`/`description`, a closed `type` vocabulary, and an exact
`title`-to-`# H1` match) instead of relaxing it. Two of OKF's own
recommended fields are deliberately not adopted here:

- **`timestamp`** — a hand-maintained per-file date is exactly the
  drift hazard `CLAUDE.md` warns about, and it would add churn to every
  docs PR for no retrieval benefit this corpus needs. Git history
  already carries an accurate last-changed timestamp per file.
- **`resource`** — OKF defines this as a URI pointing at the asset a
  concept _describes_. These pages are the asset itself, not a pointer
  to one, so the field would always be empty or redundant.

`sources`, `author`, `usage_count`, and `last_modified` are not part of
OKF v0.1 at all; git history already carries the provenance they would
duplicate, so this profile does not invent local equivalents.

## Reserved filenames

`index.md` and `log.md` are OKF-reserved filenames — `index.md` lists a
bundle's contents and `log.md` records a scope's change history — and
must not be used for a normal page's frontmatter-bearing content.
`docs/index.md` is this repository's bundle index and is out of scope
for this checker for that reason (it is not "a page that doesn't yet
conform"; it structurally never needs page frontmatter). Per-subdirectory
`index.md` pages are likewise out of scope for this roadmap; OKF permits
a bundle to omit them, so a consumer must not reject this bundle for a
missing subdirectory `index.md`.

## Enforcement limit (v0.1)

OKF is a v0.1 format. This repository's checker enforces only the field
profile above — a `type`/`title`/`description` presence-and-shape check,
the closed `type` vocabulary, and the `title`-to-`# H1` match — using
plain-text parsing in `src/scripts/consistency-helpers.mts`. It takes no
dependency on external OKF tooling: no OKF validator package exists to
depend on yet, and hand-rolling conformance to a pre-1.0 spec's exact
future shape would be premature. Widening enforcement to a future OKF
tooling dependency, or to additional OKF-recommended fields, is a
deliberate follow-up decision, not an implicit consequence of this page.

Two rows in the field profile table above name a shape the checker does
not verify: `description`'s "ending in a period" and `tags`'
"lowercase-hyphen strings" are authoring conventions for a reviewer to
apply, not mechanical checks — the checker enforces only that both
fields are non-empty (`description`) or a list of non-empty strings
(`tags`). Tightening either into a mechanical rule is the same kind of
deliberate follow-up as the paragraph above, not an oversight in this
track.

## Related pages

- [IDD workflow guide](idd-workflow.md) — phase routing this profile
  does not change.
- [Policy constants](policy-constants.md) — the byte budgets cited
  above.
- [Detailed reference](reference.md) — the broader phase/policy map
  this page's Reference Map entry sits alongside.
