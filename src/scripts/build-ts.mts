#!/usr/bin/env node
// idd-generated-from: src/scripts/build-ts.mts
//
// The scripts/build-ts.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Build the generated .mjs helper artifacts from the TypeScript sources.
//
// Emits with `tsc -p tsconfig.build.json --listEmittedFiles`, then
// normalizes ONLY the files tsc just emitted with Biome. Scoping the
// Biome pass to the emitted set keeps `pnpm run build` from rewriting
// hand-written helpers during the migration window — those are validated
// (not rewritten) by the standalone `biome check` in lint:minimum.
//
// After emitting, it also rewrites the `.gitattributes`
// `scripts/*.mjs linguist-generated=true` block so it lists exactly the
// generated set — the same banner-keyed set tests/inventory-ordering.test.mts
// guards — instead of relying on a hand-edit that today only surfaces as an
// `inventory-ordering` CI failure plus an extra commit. See #1180.
//
// Bootstrap note: this file is itself one of the emitted artifacts. The
// committed scripts/build-ts.mjs runs the build that regenerates it, and
// `pnpm run build:check` fails on drift exactly as for any other
// artifact.
//
// Invoked via `pnpm run build`, so node_modules/.bin (tsc, biome) is on
// PATH. Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EMITTED_PREFIX = 'TSFILE: ';

// The provenance header every emitted artifact carries; a helper with no
// `.mts` source of its own would not. Kept identical to the
// `idd-generated-from` scan in tests/inventory-ordering.test.mts so the build
// and that test always agree on the generated set.
const GENERATED_MARKER = 'idd-generated-from';
const GENERATED_MARKER_SCAN_BYTES = 200;

// Only the top-level scripts/*.mjs block is auto-maintained here. The
// idd-template/scripts/* entry and the bin/**/*.mjs directory glob in
// .gitattributes are left untouched — the inventory-ordering completeness
// guard is likewise scoped to scripts/*.mjs.
const GITATTRIBUTES_PATH = '.gitattributes';
const SCRIPTS_DIR = 'scripts';
const SCRIPT_ATTRIBUTE_PATTERN =
  /^scripts\/[^/]+\.mjs linguist-generated=true$/;

/** The linguist-generated attribute line for a top-level scripts/*.mjs name. */
function scriptAttributeLine(name: string): string {
  return `scripts/${name} linguist-generated=true`;
}

/**
 * The generated scripts/*.mjs set, derived exactly as
 * tests/inventory-ordering.test.mts derives it: a top-level scripts/*.mjs whose
 * first `GENERATED_MARKER_SCAN_BYTES` bytes carry the generated-from banner,
 * ascending string-sorted. Deriving it the same way — rather than from
 * `tsc --listEmittedFiles` — is what keeps a fresh build's .gitattributes green
 * under that test's completeness check even if a stale generated .mjs lingers.
 */
function generatedScriptNames(scriptsDir: string): string[] {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) =>
      readFileSync(`${scriptsDir}/${name}`, 'utf8')
        .slice(0, GENERATED_MARKER_SCAN_BYTES)
        .includes(GENERATED_MARKER),
    )
    .sort();
}

/**
 * Rewrite the scripts/*.mjs linguist-generated block of a .gitattributes body
 * so it lists exactly `names` (assumed already sorted) in place, leaving every
 * other line — the header comment, the idd-template entry, the bin glob, the
 * binary/export-ignore rules — byte identical. Pure: returns the new body.
 * Throws if no block is present so a silently vanished block cannot slip by.
 */
export function rewriteGitattributesBlock(
  original: string,
  names: readonly string[],
): string {
  const lines = original.split('\n');
  const firstBlockIndex = lines.findIndex((line) =>
    SCRIPT_ATTRIBUTE_PATTERN.test(line),
  );
  if (firstBlockIndex < 0) {
    throw new Error(
      `${GITATTRIBUTES_PATH}: no scripts/*.mjs linguist-generated block found`,
    );
  }
  // Drop every existing block line, then splice the regenerated block back in
  // at the first block line's slot. Every line before firstBlockIndex is a
  // non-block line (firstBlockIndex is the FIRST match), so it survives the
  // filter at the same index — firstBlockIndex is the correct insertion slot.
  const withoutBlock = lines.filter(
    (line) => !SCRIPT_ATTRIBUTE_PATTERN.test(line),
  );
  withoutBlock.splice(firstBlockIndex, 0, ...names.map(scriptAttributeLine));
  return withoutBlock.join('\n');
}

/**
 * Rewrite .gitattributes on disk to match the generated scripts set, writing
 * only when the body changes so `pnpm run build` stays idempotent.
 */
function syncGitattributes(): void {
  const original = readFileSync(GITATTRIBUTES_PATH, 'utf8');
  const updated = rewriteGitattributesBlock(
    original,
    generatedScriptNames(SCRIPTS_DIR),
  );
  if (updated !== original) {
    writeFileSync(GITATTRIBUTES_PATH, updated);
  }
}

/** Emit the .mjs artifacts with tsc, then Biome-normalize only the emitted set. */
function build(): void {
  const tscOutput: string = execFileSync(
    'tsc',
    ['-p', 'tsconfig.build.json', '--listEmittedFiles'],
    { encoding: 'utf8' },
  );

  const emittedFiles: string[] = tscOutput
    .split(/\r?\n/)
    .filter((line) => line.startsWith(EMITTED_PREFIX))
    .map((line) => line.slice(EMITTED_PREFIX.length).trim())
    .filter((file) => file.endsWith('.mjs'));

  if (emittedFiles.length > 0) {
    execFileSync('biome', ['check', '--write', ...emittedFiles], {
      stdio: 'inherit',
    });
  }
}

function isMainModule(metaUrl: string): boolean {
  if (!metaUrl || !process.argv[1]) {
    return false;
  }
  // Compare filesystem paths instead of building a file:// URL from
  // argv[1], which mis-parses Windows drive-letter paths.
  return fileURLToPath(metaUrl) === resolve(process.argv[1]);
}

if (isMainModule(import.meta.url)) {
  build();
  syncGitattributes();
}
