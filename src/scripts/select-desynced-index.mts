#!/usr/bin/env node
// idd-generated-from: src/scripts/select-desynced-index.mts
//
// The scripts/select-desynced-index.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Deterministic, network-free CLI wrapper for the A4 Step 2
// concurrent-selection desync index (`discover.selectionDesync:
// session-offset` in `.github/instructions/idd-discover.instructions.md`).
//
// Delegates to the existing `selectDesyncedIndex` in `policy-helpers.mts`
// rather than reimplementing the FNV-1a hash, so the CLI and the library
// function can never drift. The written formula in the instructions remains
// the canonical spec and fallback; this helper only removes the ad hoc
// `node -e` hand-transcription error surface that motivated this issue.

import { parseCanonicalIntegerOrNull, parseCliArgs } from './cli-args.mts';
import { selectDesyncedIndex } from './policy-helpers.mts';

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `token:`): tests/flag-name-matrix.test.mts scans this file's *compiled*
// .mjs source text for quoted flag literals such as the --band-size spec
// key below. See cli-args.mts's module header for the full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires (see #1177's entry-order TDZ hardening for the same class
// of bug in this file).
const SELECT_DESYNCED_INDEX_FLAG_SPEC = {
  '--token': { type: 'string' },
  '--band-size': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
  runCli();
}

interface ParsedArgs {
  token: string | null;
  bandSize: number | null;
  help: boolean;
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  // The CLI layer validates strictly on purpose: selectDesyncedIndex itself
  // returns 0 for any invalid input (safe default for internal callers), but
  // a CLI invocation with a missing token or a non-positive band size is
  // almost always an operator/caller mistake that should fail loudly rather
  // than silently print 0. An empty-string token (e.g. `--token "$VAR"` with
  // an unset $VAR) is treated the same as a missing flag for this reason:
  // otherwise it would silently degrade to the same output as `off`/no-tie
  // instead of surfacing the caller's mistake.
  if (args.token === null || args.token === '') {
    throw new Error('--token is required');
  }
  if (args.bandSize === null) {
    throw new Error('--band-size is required and must be a positive integer');
  }
  process.stdout.write(
    `${selectDesyncedIndex(args.token, args.bandSize as number)}\n`,
  );
}

function parseArgs(argv: string[]): ParsedArgs {
  const { values, help } = parseCliArgs(argv, SELECT_DESYNCED_INDEX_FLAG_SPEC);
  return {
    token: (values.token as string | undefined) ?? null,
    bandSize: parseCanonicalIntegerOrNull(
      values['band-size'] as string | undefined,
    ),
    help,
  };
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/select-desynced-index.mjs --token <session-token> --band-size <n>

Prints the deterministic band index chosen by the A4 Step 2
concurrent-selection desync rule (\`discover.selectionDesync:
session-offset\`) for the given session token and same-score tie-band
size, delegating to \`selectDesyncedIndex\` (a pure FNV-1a 32-bit hash mod
band size). Deterministic and network-free.

Example:
  node scripts/select-desynced-index.mjs --token claude-loop-2 --band-size 5
  => 4
`);
}
