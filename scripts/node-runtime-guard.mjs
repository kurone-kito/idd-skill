// idd-generated-from: src/scripts/node-runtime-guard.mts
//
// The scripts/node-runtime-guard.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// #3240: `import.meta.main` is `undefined` -- not `false` -- on a Node
// release that predates it (confirmed live on v20.20.2, v22.17.1, and
// v24.1.0), so every `if (import.meta.main) { ... }` CLI entry-block
// guard across this repository's `src/scripts/*.mts` helpers (the idiom
// #1447 standardized on) is simply falsy there: the helper exits 0
// without ever running its body, instead of failing loudly on an
// unsupported runtime. #1447 raised `engines.node` to
// `^22.23.2 || ^24.2.0 || >=26.0.0`, but nothing enforced that range at
// run time.
//
// This module is the one shared check nearly every entry point reaches --
// either transitively, by importing `cli-args.mts` (which 62 of the 69
// entry-block files and `src/bin/run-helper.mts` already reach through
// their own static imports), or directly, in six of the seven
// entry-block sources that do not reach `cli-args.mts`:
// audit-code-span-wrap, build-ts, check-untracked-artifacts, sync-docs,
// update-fixtures, and validate-schemas. The seventh,
// minimize-superseded-markers.mts, is curl-mirrored standalone to
// `idd-template/scripts/` (#1208) and cannot import any sibling file
// (enforced by `standalone-mirror-imports.test.mts`), so it inlines its
// own duplicate of the assertEntrySignal() check below instead of
// importing this module -- keep the two in sync by hand.
//
// Importing this module for its side effect runs assertEntrySignal()
// against this module's OWN `import.meta` before any importing module's
// entry block can run -- `import.meta.main`'s availability is a
// whole-runtime capability, not a per-file one, so checking it here
// reports the same runtime regardless of which module happens to import
// this one first. ES modules evaluate their dependencies before their own
// body, so on an unsupported Node this module exits the process before
// the importing entry point's own top-level code executes at all.
/**
 * The exact literal this repository's `ENGINES_RANGE_MIRRORS`
 * ('full-range' mode, audit-docs.mts) keeps synchronized with
 * package.json's own `engines.node`. Hand-mirrored rather than imported
 * from package.json: this module must stay import-side-effect-only and
 * dependency-free (node: builtins only) so every one of its importers,
 * including the toolless bare-node CI lane, can load it without a
 * package.json read.
 */
const ENGINES_RANGE = '^22.23.2 || ^24.2.0 || >=26.0.0';
/**
 * Fails loudly, in one stderr line naming `process.version` and this
 * repository's `engines.node` range, then exits 1 -- unless `meta.main`
 * is the boolean Node's `import.meta.main` provides on a supported
 * runtime, in which case this returns without side effects regardless of
 * whether the boolean is `true` or `false`. Takes a narrow
 * `{ main?: unknown }` rather than the real `ImportMeta` so a synthetic
 * `{}` (the unsupported-runtime shape) is a valid, type-safe argument for
 * tests.
 */
export function assertEntrySignal(meta) {
  if (typeof meta.main === 'boolean') {
    return;
  }
  process.stderr.write(
    `node-runtime-guard: this repository's CLI entry points require Node's ` +
      `\`import.meta.main\` (added in Node 22.18.0 / 24.2.0), which is not ` +
      `available on this runtime (Node ${process.version}). Upgrade to a ` +
      `Node version satisfying this repository's engines.node range ` +
      `(${ENGINES_RANGE}).\n`,
  );
  process.exit(1);
}
assertEntrySignal(import.meta);
