// idd-generated-from: src/scripts/bundle-root.mts
//
// The scripts/bundle-root.mjs copy is generated from the .mts source
// named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
/**
 * Shared bundle-root resolver (issue #3238). `validate-schemas.mts` and
 * `helper-runtime-manifest.mts` each used to carry their own copy of a
 * nearest-`package.json` walk. That walk resolves to the filesystem root
 * — not an error — in a target repository that has neither a
 * `package.json` nor the resolved directory anywhere in between, so every
 * helper whose import graph reaches a module that reads
 * `schemas/policy.schema.json` at load time (for example
 * `advisory-wait-policy.mts`, imported by `protocol-helpers.mts`) throws a
 * raw `ENOENT` opening `<filesystem-root>/schemas/policy.schema.json`
 * before it parses a single argument. Many `vendored-node` targets have no
 * `package.json` at all (the profile exists precisely for repositories
 * with no Node.js package-manager metadata), so this was not a rare edge
 * case.
 *
 * `schemas/policy.schema.json` is shipped in every `vendored-node` bundle
 * (`EXTRA_RUNTIME_FILES` in `helper-runtime-manifest.mts` pulls it in
 * transitively through `advisory-wait-policy.mjs`, reached from most
 * cataloged helpers via `protocol-helpers.mjs`) and lives at this
 * repository's own root too, so it is a reliable bundle-internal marker.
 * Resolve the bundle root by walking up from a start directory to the
 * nearest ancestor containing that marker first, falling back to the
 * nearest ancestor containing `package.json` only when the marker is
 * found nowhere in the walk, and throwing an error that names the start
 * directory when neither is found — instead of silently returning the
 * filesystem root.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Bounds the upward walk so a pathological filesystem (a cyclic mount, an
 * unexpectedly deep tree) cannot loop forever. Matches the depth bound the
 * two walkers this module replaces already used.
 */
const MAX_WALK_DEPTH = 16;
/**
 * Bundle-internal marker file: shipped in every `vendored-node` bundle and
 * present at this repository's own root (see this module's header
 * comment).
 */
export const BUNDLE_MARKER_RELATIVE_PATH = 'schemas/policy.schema.json';
/** Fallback marker when {@link BUNDLE_MARKER_RELATIVE_PATH} is absent. */
const PACKAGE_JSON_RELATIVE_PATH = 'package.json';
/**
 * Walk up from `fromDir` (inclusive), returning the nearest ancestor whose
 * directory contains `relativePath`, or `null` if none of the (bounded)
 * ancestors do.
 */
function findNearestAncestorContaining(fromDir, relativePath) {
  let dir = fromDir;
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    if (existsSync(join(dir, relativePath))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}
/**
 * Resolve the vendored-node bundle root from `fromDir`: the nearest
 * ancestor containing {@link BUNDLE_MARKER_RELATIVE_PATH}, falling back to
 * the nearest ancestor containing `package.json` only when the marker is
 * found nowhere in the walk. Throws when neither is found anywhere in the
 * (bounded) walk, naming `fromDir`, instead of silently returning the
 * filesystem root — the `fa49fb6c`-era failure mode this module exists to
 * fix (issue #3238).
 *
 * Location-independent for either walker it replaces: it returns the same
 * root whether `fromDir` is the emitted `scripts/<name>.mjs`'s own
 * directory (one level deep from a target repository root), the
 * `src/scripts/<name>.mts` source's directory under Node type-stripping
 * (two levels deep in this repository), or any other module's directory
 * that imports a resolver built on this function.
 */
export function resolveBundleRoot(fromDir) {
  const markerRoot = findNearestAncestorContaining(
    fromDir,
    BUNDLE_MARKER_RELATIVE_PATH,
  );
  if (markerRoot !== null) {
    return markerRoot;
  }
  const packageJsonRoot = findNearestAncestorContaining(
    fromDir,
    PACKAGE_JSON_RELATIVE_PATH,
  );
  if (packageJsonRoot !== null) {
    return packageJsonRoot;
  }
  throw new Error(
    `resolveBundleRoot: no ancestor of "${fromDir}" contains ` +
      `${BUNDLE_MARKER_RELATIVE_PATH} or ${PACKAGE_JSON_RELATIVE_PATH}`,
  );
}
