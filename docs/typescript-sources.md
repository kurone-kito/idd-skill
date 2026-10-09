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

## Registering a repository-local helper

A new helper touches more files than its source. First decide whether it
ships to adopters: item 4 applies only if it does, and items 3 and 4 depend on
that decision. Then work through the list in order. Each item names the file to
edit and the audit or test that fails when the item is missed.

The placeholders below are not all the same name:

- `<stem>` is the source file name. `src/scripts/<stem>.mts` compiles to
  `scripts/<stem>.mjs`.
- `<id>` is the manifest command id. It need not match the stem: the file
  `scripts/idd-merge-execute.mjs` has `id: 'merge-execute'`.
- `<binName>` is the packaged command name. It starts with `idd-`, and it names
  the wrapper `src/bin/<binName>.mts` and the file `bin/<binName>.mjs`.

1. Write `src/scripts/<stem>.mts` with the banner
   `// idd-generated-from: src/scripts/<stem>.mts` in its first 200 bytes; put
   it on the line after the shebang. `audit-docs --check` fails without it.
   `pnpm run build` then writes `scripts/<stem>.mjs` and its
   `linguist-generated` line in `.gitattributes`. Commit the generated file,
   the `.gitattributes` change and the source together.
   `pnpm run build:check` verifies that the committed artifacts match.
2. Declare the flags in a `<NAME>_FLAG_SPEC = { ... } as const;` object. Without
   `as const` the build fails on the flag `type` values. Declare `--help`
   (`'--help': { type: 'boolean', short: 'h' }`) and make the `--help` output
   document every declared flag. Check it with
   `node --test tests/help-text-flags.test.mts`. Add `<stem>` to
   `COVERED_HELPERS` in `src/scripts/repository-inventory-audit.mts`, and commit
   the regenerated `scripts/repository-inventory-audit.mjs` with it.
   `audit-docs --check` fails with `help-flag-coverage` when a helper that
   declares a flag spec is missing from `COVERED_HELPERS`. A helper that cannot
   declare a flag spec may go into `EXCLUDED_HELPERS` in the same file, with a
   reason. It must not declare one.
3. If a Markdown file invokes the helper as a bare `node scripts/<stem>.mjs`,
   and the helper has no runtime catalog entry (item 4), add entries for it in
   `src/scripts/repository-inventory-audit.mts`:
   - a reason in `INTERNAL_ENTRY_REASONS`. The audit scans Markdown under
     `.github/instructions/`, `docs/` and their `idd-template/` copies, and
     without this entry it fails with `unbacked-helper`. `DOGFOOD_ONLY_TOOLS`
     does not satisfy this check.
   - `scripts/<stem>.mjs` in `DOGFOOD_ONLY_TOOLS`, if an instruction file under
     `.github/instructions/` invokes it. Without it, the check fails with
     `instruction-helper-registration`.

   Unless the helper is listed in one of those two tables, any bare
   `node scripts/<stem>.mjs` in an instruction file also needs the words
   `profile-selected` in the same paragraph, or earlier in that file. This
   applies even when the helper has a catalog entry. Without them, the audit
   fails with `unpointed-source-form`. This check does not scan `docs/`.
4. If the helper ships to adopters, make it a packaged helper.
   - Add an entry to the `HELPER_COMMANDS` array in
     `src/scripts/helper-runtime-manifest.mts`, with `id` (`<id>`), `scriptName`
     (`idd:<id>`), `binName` (`<binName>`), `entryPath`
     (`scripts/<stem>.mjs`), `vendoredCommand` (`node scripts/<stem>.mjs`) and
     `description`. Keep the `id` values in ascending order
     (`helper-command-order`).
   - If the helper reads files that its imports do not reach, list them. A
     schema goes into `contractPaths` on this entry. Any other file goes into
     `EXTRA_RUNTIME_FILES` in the same file, keyed by `scripts/<stem>.mjs`. The
     drift guard in `tests/helper-runtime-manifest.test.mts` checks this list.
   - Write the wrapper as `src/bin/<binName>.mts`, with its own banner. It must
     name the helper it runs literally, as in
     `runHelper('../scripts/<stem>.mjs');`. The helper must call `runHelperCli(`
     or `applyHelperCliOutcomeWhenDisabled(` from
     `src/scripts/helper-cli-runner.mts`, as
     `src/scripts/select-desynced-index.mts` does. Otherwise the audit fails
     with `helper-cli-migration`.
   - Add `"<binName>": "./bin/<binName>.mjs"` to the `bin` object in
     `package.json`. Keep its keys in ascending order (`helper-bin-order`).
     `runtime-bin-forward` requires this exact path.
   - Run `pnpm run build`. Make `bin/<binName>.mjs` executable with `chmod +x`
     and stage it with `git add` before you commit. `audit-docs --check` fails
     with `bin-executable-mode` while git has the file as untracked or
     non-executable.
   - Add a `"<binName>.mjs"` key to `bins` in
     `tests/fixtures/helper-cli-contract.json`, with `runs.unknownFlag` and
     `runs.noArgs`, each an object of `exitCode` and `kind`. Use the values the
     helper actually returns. Check them with
     `node --test tests/helper-cli-contract.test.mts`. Neither
     `audit-docs --check` nor `build:check` reads this fixture.
   - Do not hand-edit a generated `.mjs`.
5. If the helper joins `pre-push-validate` or another command-table row, edit
   the command in `.github/idd/config.json` and the matching row in
   `audit/sync-manifest.json`, then run `node scripts/sync-docs.mjs --apply`.
   The command table is rendered into
   `.github/instructions/idd-overview-core.instructions.md`, which `bundle-core`
   loads. `audit-docs --check` prints a notice for a bundle at the
   `noticeUtilizationPct` in `contextCeiling` (`audit/sync-manifest.json`), and
   fails above `maxUtilizationPct`. `bundle-work-phase` is exempt. Read each
   bundle's current figure in the audit output before you edit.
   - From the notice level up to the limit, follow the near-ceiling exception in
     `docs/policy-constants.md`: prefer trimming or splitting the net addition
     over a ratchet bump.
   - If the change would take a bundle above the limit, it cannot land until the
     budget is decided. Record the options for the maintainer (split, raise
     with a callout, or exemption), and stop. Do not trim instruction text in
     this change to make room.
6. Run `node scripts/audit-docs.mjs --check`, then
   `node --test tests/help-text-flags.test.mts` (any helper with a flag spec)
   and `node --test tests/helper-cli-contract.test.mts` (an adopter-shipped
   helper). Run `pnpm run build:check` after the commit, because it compares
   the committed tree with the generated files. `pnpm run test:scripts` runs
   both test files as well.

## Build and verification

| Command                | Purpose                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run typecheck`   | `tsc --noEmit` over `src/**/*.mts` + `tests/**/*.mts` (`strict`)                                                                                                                                                                                                       |
| `pnpm run build`       | Emit the generated `.mjs` (tsc) and normalize them with Biome                                                                                                                                                                                                          |
| `pnpm run build:check` | `node src/scripts/check-build-artifacts.mts && node src/scripts/check-untracked-artifacts.mts` — emits into a temporary directory and compares it with the generated files committed at HEAD, then fails on an untracked emitted file; the checkout is never rewritten |

`tsconfig.build.json` sets `noEmitOnError: true`, so a `.mts` source with a
type error emits nothing at all instead of letting tsc overwrite tracked
`scripts/*.mjs` / `bin/*.mjs` with un-normalized output before the pipeline
dies (`pnpm run build`'s Biome pass and `.gitattributes` sync never run
after that throw) — a failed build stays side-effect-free on the tracked
tree (observed 2026-07-31, #1707).

`build:check` never rewrites the checkout. `check-build-artifacts.mts` runs
the same tsc emit, Biome normalization, provenance banners and `.gitattributes`
block derivation as `build`, but into a temporary directory, then compares the
result with the generated files committed at HEAD. Drift, a missing or extra
output, a new source with no committed artifact, a stale `.gitattributes`
block, and a working-tree copy that differs from HEAD all fail with the path
and a fix hint; nothing is copied back, so `pnpm run build` stays the only
writer. The HEAD snapshot comes from `git ls-tree` and `git cat-file`, so the
verdict is relative to committed HEAD whatever is staged (#1023), and no
command in the verifier writes the git index. The fresh emit is compared by
content only, but a working-tree copy must also keep HEAD's recorded kind (the
executable bit where git tracks it, and symlink versus regular file), as the old
`git diff HEAD` composition required.

Both `build:check` steps run from their `.mts` sources through Node's native
type stripping, never from the committed `scripts/*.mjs` copies. A generated
checker must not be the sole judge of its own integrity (observed 2026-07-31,
in issue `#1707` and its review on PR `#1732`): a stale or tampered committed
`scripts/check-build-artifacts.mjs` could still carry the provenance banner and
report itself clean. Here it is only one more artifact, byte-compared against
the fresh emit before the `&&` lets anything else run. The verifier imports
only `node:` builtins at top level and resolves `tsc` and Biome lazily, so its
pure parts stay testable in the toolless bare-node lane.

Neither step uses a shell pipeline, and the untracked-artifact step uses the
`git ls-files --others` plumbing command rather than `git status`: both choices
avoid failure modes review found on #1707 — a shell-composed `test`/`$()` check
is POSIX-only and breaks under npm/pnpm's default `cmd.exe` shell on Windows
(including callers of the reusable pnpm-boundary workflow on a `windows-*`
runner), and `git status --porcelain` without an explicit `--untracked-files`
override silently respects a local or CI `status.showUntrackedFiles=no` config,
which would let an untracked emitted artifact pass unnoticed.

`pnpm run lint:minimum` runs `typecheck` and `build:check`, so a forgotten
rebuild or a hand-edited generated file fails the installed CI lane. The
bare-node lane additionally runs `node scripts/audit-docs.mjs --check`,
whose pairing guard fails when a source is missing its generated artifact,
a banner-marked artifact is missing its source, or a source's provenance
banner is missing or malformed in either file — the guard requires the
banner on every `src/scripts/**/*.mts` / `src/bin/**/*.mts` source, not
only on an artifact that already happens to carry one. `node --test
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
stripping (`node --test` with the `tests/isolate-state.mts` preload;
`pnpm run test:scripts` runs the same command). The preload gives each
test file a throwaway per-user state root and a real-`gh` attempt ledger.
The state guard fails the file when it writes below an `idd-*` entry in
that root (observed 2026-10-01 while working on issue
kurone-kito/idd-skill#3702: four test files wrote into the shared
per-user state directory while passing every assertion; fixed per test
in kurone-kito/idd-skill#3711, guarded by
kurone-kito/idd-skill#3725). Its ESM `NODE_OPTIONS --import` guard blocks
real `gh` launches through `node:child_process` before dispatch and records
the command arguments, process, and thread for the owning test process. A
Worker wrapper passes a CommonJS bridge and the same ledger into workers
whose `execArgv` is empty. `stubExecutable` registers the exact fixture
path, so another executable with the same basename does not bypass the
guard. The `lint` workflow's direct test commands
also use the preload. This guard addresses the observed 2026-10-04 probe
leak in issue kurone-kito/idd-skill#3755, where unexpected real `gh`
commands were caught but the parent probe still passed. Running one file
with plain `node --test` bypasses both guards (preventive; no observed
incident yet).

The guard also puts a PATH shim first on `PATH`, so a shell launch the
in-process parser misses (for example `g""h`, `$(printf gh)`, or `gh${IFS}`)
still never reaches the real CLI (kurone-kito/idd-skill#3841). The owner
process writes two launchers into `<guard root>/bin`: a POSIX `gh` (mode
`0o755`) or, on Windows, `gh.cmd`. Each runs `tests/isolate-gh-shim.cjs`
under the same Node binary, with `NODE_OPTIONS` cleared. The shim records
one ledger entry with `api` `path-shim`, prints `IDD_UNEXPECTED_REAL_GH`,
and exits 1. It never starts a real `gh`. The launchers are generated per
guard root, so nothing executable is committed. A `stubExecutable` fixture
is prepended later and stays ahead of the shim. Its path is registered, so
a fixture still runs as before. Residuals the shim cannot see: an absolute
path to the real `gh` inside a script a payload runs, a script that rewrites
`PATH` first, and a launch whose explicit environment drops the guard
directory or leaves `PATH` unset (preventive; no observed incident yet).
The `Windows platform tests` job runs the two `path shim: windows` cases by
name pattern.

Unit tests import the typed `src/scripts/*.mts`
sources so assertions are checked against the real signatures;
CLI/integration tests keep spawning the emitted `scripts/*.mjs` /
`bin/*.mjs` artifacts, which is exactly what adopters execute.

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

### Issue-body corpus regression fixtures

`tests/fixtures/issue-body-corpus/` vendors real (and a fixed set of
synthetic-gap) GitHub issue bodies alongside their current A4
(`discover-viability-gate.mts`) / A4.5 (`suitability-triage.mts`,
local/offline mode) verdicts, so `tests/issue-body-corpus.test.mts` can
catch a lexical-gate edit silently flipping a real issue's verdict —
something synthetic-only fixtures cannot show. Maintained by
`src/scripts/snapshot-issue-body-corpus.mts` →
`scripts/snapshot-issue-body-corpus.mjs`:

```sh
node scripts/snapshot-issue-body-corpus.mjs --add <n>[,<n>...] --category merged|negative [--note <text>]
node scripts/snapshot-issue-body-corpus.mjs --refresh          # re-fetch changed bodies
node scripts/snapshot-issue-body-corpus.mjs --update-expected  # recompute verdicts
```

`--refresh` leaves `expected` untouched on a changed body, so a refreshed
entry needs `--update-expected` before the test passes again. The corpus
is test-only (no runtime path reads it) — the live A4/A4.5 gates keep
their verdict authority; this tool only freezes a snapshot of what they
currently say. Never run by `pnpm test`/CI.

> **Guardrail.** Same contract as `--update-expected` above:
> `--update-expected` blesses whatever the current helpers emit. Use it
> only after an intentional gate-behavior change, review the emitted
> `git diff`, and list every flipped entry in the PR description.
