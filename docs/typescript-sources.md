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
repository's `engines` floor is `^22.22.2 || >=24`), but it refuses to do
so for files resolved inside `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The helper bundle is
consumed through the `package-manager` and `ephemeral-npx` profiles,
where the files land in `node_modules`, so shipping raw `.mts` would break
those profiles. Committing the generated `.mjs` keeps every helper
profile, the documented `node scripts/<name>.mjs` invocations, and the
install-free bare-node CI lane working unchanged.

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

## Build and verification

| Command                | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `pnpm run typecheck`   | `tsc --noEmit` over `src/**/*.mts` + `tests/**/*.mts` (`strict`)                |
| `pnpm run build`       | Emit the generated `.mjs` (tsc) and normalize them with Biome                   |
| `pnpm run build:check` | `build` then `git diff HEAD --exit-code` — fails when the committed tree drifts |

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
