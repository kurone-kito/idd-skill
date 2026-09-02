---
type: reference
title: TypeScript helper sources
description: Explains the generated .mjs-from-.mts helper source layout, build commands, and drift guards this repository enforces.
tags: [typescript, build-tooling]
---

# TypeScript helper sources

The IDD helper migration to TypeScript is **complete**: every
`scripts/*.mjs` / `bin/*.mjs` artifact is generated from a `src/**/*.mts`
source by `pnpm run build`, and `src/**/*.mts` is the only hand-edited
JavaScript surface in the helper bundle. No hand-written helper `.mjs`
path remains, and the invariant is enforced mechanically: a
`scripts/*.mjs` or `bin/*.mjs` on disk with no matching `.mts` source
fails CI (`tests/inventory-ordering.test.mts`).

> **Edit the `.mts` source, never the generated `.mjs`.** A direct edit
> to a generated file is overwritten on the next build and is rejected
> by the drift guard in CI.

## Why generated `.mjs` are committed

Node.js strips TypeScript types natively (default since 22.18; the
repository's `engines` floor is
`^22.23.2 || ^24.2.0 || >=26.0.0`), but it refuses to
do so for files resolved inside `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The helper bundle is
consumed through the `package-manager` and `ephemeral-npx` profiles,
where the files land in `node_modules`, so shipping raw `.mts` would break
those profiles. Committing the generated `.mjs` keeps every helper
profile, the documented `node scripts/<name>.mjs` invocations, and the
install-free bare-node CI lane working unchanged.

## `@types/node` vs. the engines floor

`@types/node` is pinned to `26.1.2` — newer than the 22.x and 24.x
floors of the `^22.23.2 || ^24.2.0 || >=26.0.0` engines range, and
within its `>=26.0.0` clause — so `pnpm run typecheck` validates
against the Node 26 API surface, not the lowest version this
repository actually ships on. This is a deliberate trade-off, not an
oversight (observed 2026-08-01, #1706):
downgrading `@types/node` to match the 22.x floor would lose type
coverage for code paths that intentionally target the newer 24.x/26.x
clauses of the range, and TypeScript's structural typing means a
too-new API passing typecheck doesn't reliably fail loudly at that
type-only layer.

The actual backstop is runtime, not type-level: the Node 22 CI lane
(`pnpm-boundary-node22-floor.yml`) runs the full `pnpm run lint:minimum`
suite — including the whole test suite and
`verify-workshop-integrity.mts` — directly on Node 22.23.2. A helper
that calls an API present in the types-26 surface but missing or
broken on the true floor version (the #1447 failure class) crashes
there even though it typechecks cleanly, closing the gap that pinning
`@types/node` down would only partially cover anyway (types don't
model version-specific runtime bugs like #1447's `import.meta.main`
silently-falsy case).

## Layout

```text
src/scripts/<name>.mts  ->  scripts/<name>.mjs   (generated)
src/bin/<name>.mts      ->  bin/<name>.mjs        (generated)
```

Each source begins with a provenance banner that is preserved into the
generated file:

```text
// idd-generated-from: src/scripts/<name>.mts
```

Generated files are marked `linguist-generated=true` in `.gitattributes`
on a per-file basis, which drops them from language statistics and
collapses their diffs in review. This is distinct from
`linguist-vendored`, which denotes third-party code and is reserved for
adopter repositories that vendor the bundle.

### Read the closest existing helper first

Before drafting a new helper whose problem shares its shape with an
existing one in `src/scripts/` — another mutual-exclusion or locking
primitive, another marker parser, and so on — read that existing
helper's own header and design-rationale comments first, rather than
independently re-deriving already-settled tradeoffs. This applies
generally, not only to locks.

Worked example: issue #2223 asked for a new clone-scoped lock for
concurrent worktree lifecycle operations, naming `src/scripts/claim-lock.mts` in
its own body as either the extension target or the natural sibling
for a new module. The implementation (PR #2389, `src/scripts/clone-lock.mts`)
designed its own staleness and recovery logic from scratch instead,
and needed several further review rounds to arrive — independently,
through review-driven trial and error — at conclusions
`src/scripts/claim-lock.mts`'s own comments already state as settled: prefer a
stronger external authority over ad hoc local recovery when one is
available, and a local process-liveness check can be defeated by a
process-lifecycle mismatch (in `src/scripts/clone-lock.mts`'s case, a wrapper
process dying while the child command it spawned kept running).

## Build and verification

| Command                | Purpose                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck`   | `tsc --noEmit` over `src/**/*.mts` + `tests/**/*.mts` (`strict`)                                                                                                                                                 |
| `pnpm run build`       | Emit the generated `.mjs` (tsc) and normalize them with Biome                                                                                                                                                    |
| `pnpm run build:check` | `pnpm run build && git diff HEAD --exit-code -- scripts bin .gitattributes && node scripts/check-untracked-artifacts.mjs` — builds, then fails when the committed tree drifts or gains an untracked emitted file |

`tsconfig.build.json` sets `noEmitOnError: true`, so a `.mts` source with a
type error emits nothing at all instead of letting tsc overwrite tracked
`scripts/*.mjs` / `bin/*.mjs` with un-normalized output before the pipeline
dies (`pnpm run build`'s Biome pass and `.gitattributes` sync never run
after that throw) — a failed build stays side-effect-free on the tracked
tree (observed 2026-07-31, #1707).

`build:check` runs entirely through `node:child_process` rather than a
shell pipeline, and its untracked-artifact check uses the `git ls-files
--others` plumbing command rather than `git status`: both choices avoid
failure modes review found on #1707 — a shell-composed
`test`/`$()` check is POSIX-only and breaks under npm/pnpm's default
`cmd.exe` shell on Windows (including callers of the reusable
pnpm-boundary workflow on a `windows-*` runner), and `git status
--porcelain` without an explicit `--untracked-files` override silently
respects a local or CI `status.showUntrackedFiles=no` config, which
would let an untracked emitted artifact pass unnoticed.

`pnpm run lint:minimum` runs `typecheck` and `build:check`, so a forgotten
rebuild or a hand-edited generated file fails the installed CI lane. The
bare-node lane additionally runs `node scripts/audit-docs.mjs --check`,
whose pairing guard fails when a source is missing its generated artifact
or a banner-marked artifact is missing its source. `node --test
tests/inventory-ordering.test.mts` (part of `lint:minimum`'s test run)
closes the remaining gap: it fails when a `scripts/*.mjs` or `bin/*.mjs`
on disk has no matching `.mts` source at all, regardless of whether it
carries the generated-from banner — the check that keeps the
hand-written-helper path closed for good.

## Type-suppression budgets

Strict mode only protects quality if suppressions do not accumulate, so
`audit-docs --check` also enforces the `typeSuppressionBudgets` entry in
`audit/sync-manifest.json` (a pure `node:` text scan, mirroring the
`bundleBudgets` ratchet shape):

- the `@ts-ignore` directive is forbidden outright — `@ts-expect-error`
  is the only allowed escape because it self-expires when the error
  disappears;
- every `@ts-expect-error` must carry a same-line reason;
- `@ts-expect-error` occurrences and explicit `any` occurrences across
  `src/` and `tests/` are counted against the recorded budgets.

The budgets record the **measured** current counts (zero at landing
time). Ratchet rule: raising a limit requires an explicit callout in the
PR description; lowering is always allowed. In the installed lane,
Biome's `lint/suspicious/noExplicitAny` (on via the recommended set)
surfaces explicit `any` as a warning during development; this audit
budget is the **blocking** enforcement in both CI lanes.

Only the sources listed in `tsconfig.json`'s `include` set
(`src/**/*.mts` and `tests/**/*.mts`) are type-checked; the generated
`scripts/*.mjs` / `bin/*.mjs` artifacts are build output, not
type-checked directly.

## Test suite

The test suite is typed TypeScript (`tests/*.test.mts`). Tests are not
distributed and are never emitted — `tsconfig.build.json` excludes
`tests`, and both lanes run them directly via Node's native type
stripping (`node --test tests/*.test.mts`). Unit tests import the typed
`src/scripts/*.mts` sources so assertions are checked against the real
signatures; CLI/integration tests keep spawning the emitted
`scripts/*.mjs` / `bin/*.mjs` artifacts, which is exactly what adopters
execute.

### Regenerating `deepEqual` fixtures

Some suites assert a builder's output against committed
`fixtures/<suite>/*.json` `{ input, options, expected }` cases via a full
`assert.deepEqual` (for example `tests/pre-merge-readiness.test.mts`). When
an **intentional** output-shape change lands, recompute every `expected`
instead of hand-editing each fixture:

```sh
pnpm run fixtures:update            # regenerate every registered suite
pnpm run fixtures:update --suite pre-merge-readiness   # or just one
```

The tool (`src/scripts/update-fixtures.mts` → `scripts/update-fixtures.mjs`)
recomputes each fixture's `expected` from the current builder and rewrites
the file in the repo's canonical JSON form. On unchanged code it is a
**no-op** (empty `git diff`), which round-trips the committed fixtures; a
sibling suite registers by adding one `FIXTURE_SUITES` entry.

> **Guardrail.** Regeneration blesses whatever the code currently emits, so
> a blind regeneration can silently **mask a real regression** — the exact
> anti-pattern IDD warns about. Use it only for a deliberate shape change,
> and **review the emitted `git diff`**; it is not a substitute for
> correctness. A normal `pnpm test` / CI run never regenerates (assert-only);
> the tool is strictly opt-in.
