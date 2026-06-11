# TypeScript helper sources

The IDD helper logic is **migrating to TypeScript**, one
dependency-ordered wave at a time. For every helper that has already been
converted, the source of truth is its `src/**/*.mts` file, and the
matching `scripts/*.mjs` / `bin/*.mjs` artifact is generated from it and
committed to the repository. Helpers that have not been converted yet
remain hand-edited `.mjs` until their wave lands. When the migration
completes, `src/**/*.mts` will be the only hand-edited JavaScript surface.

> **For a converted helper, edit the `.mts` source, never the generated
> `.mjs`.** A direct edit to a generated file is overwritten on the next
> build and is rejected by the drift guard in CI. A `.mjs` with no
> `src/**/*.mts` counterpart is still hand-edited; convert it in its
> migration wave rather than hand-editing a generated file.

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
(per file during the migration), which drops them from language
statistics and collapses their diffs in review. This is distinct from
`linguist-vendored`, which denotes third-party code and is reserved for
adopter repositories that vendor the bundle.

## Build and verification

| Command                | Purpose                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `pnpm run typecheck`   | `tsc --noEmit` over `src/**/*.mts` under `strict`                |
| `pnpm run build`       | Emit the generated `.mjs` (tsc) and normalize them with Biome    |
| `pnpm run build:check` | `build` then `git diff --exit-code` — fails when the tree drifts |

`pnpm run lint:minimum` runs `typecheck` and `build:check`, so a forgotten
rebuild or a hand-edited generated file fails the installed CI lane. The
bare-node lane additionally runs `node scripts/audit-docs.mjs --check`,
whose pairing guard fails when a source is missing its generated artifact
or a banner-marked artifact is missing its source.

The migration converts modules in dependency-ordered waves; only the
sources listed in `tsconfig.json`'s `include` set are type-checked, so
unconverted hand-written `.mjs` stay untyped and CI is green throughout.
