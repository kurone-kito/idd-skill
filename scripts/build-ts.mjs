#!/usr/bin/env node
// Build the generated .mjs helper artifacts from the TypeScript sources.
//
// Emits with `tsc -p tsconfig.build.json --listEmittedFiles`, then
// normalizes ONLY the files tsc just emitted with Biome. Scoping the
// Biome pass to the emitted set keeps `pnpm run build` from rewriting
// hand-written helpers during the migration window — those are validated
// (not rewritten) by the standalone `biome check` in lint:minimum.
//
// Invoked via `pnpm run build`, so node_modules/.bin (tsc, biome) is on
// PATH. Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.

import { execFileSync } from 'node:child_process';

const EMITTED_PREFIX = 'TSFILE: ';

const tscOutput = execFileSync(
  'tsc',
  ['-p', 'tsconfig.build.json', '--listEmittedFiles'],
  { encoding: 'utf8' },
);

const emittedFiles = tscOutput
  .split(/\r?\n/)
  .filter((line) => line.startsWith(EMITTED_PREFIX))
  .map((line) => line.slice(EMITTED_PREFIX.length).trim())
  .filter((file) => file.endsWith('.mjs'));

if (emittedFiles.length > 0) {
  execFileSync('biome', ['check', '--write', ...emittedFiles], {
    stdio: 'inherit',
  });
}
