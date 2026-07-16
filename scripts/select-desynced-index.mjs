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
import { isCliExecution } from './gh-exec.mjs';
import { selectDesyncedIndex } from './policy-helpers.mjs';

if (isCliExecution(import.meta.url)) {
  runCli();
}
function runCli() {
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
  if (!Number.isInteger(args.bandSize) || (args.bandSize ?? 0) <= 0) {
    throw new Error('--band-size is required and must be a positive integer');
  }
  process.stdout.write(`${selectDesyncedIndex(args.token, args.bandSize)}\n`);
}
function parseArgs(argv) {
  const parsed = { token: null, bandSize: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const requireValue = () => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for argument: ${flag}`);
      }
      return value;
    };
    if (flag === '--token') {
      parsed.token = requireValue();
      index += 1;
      continue;
    }
    if (flag === '--band-size') {
      parsed.bandSize = Number.parseInt(String(requireValue()), 10);
      index += 1;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${flag}`);
  }
  return parsed;
}
function printHelp() {
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
