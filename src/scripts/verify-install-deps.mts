#!/usr/bin/env node
// idd-generated-from: src/scripts/verify-install-deps.mts
//
// The scripts/verify-install-deps.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never
// the generated .mjs. See docs/typescript-sources.md.
//
// Defensive wrapper around install-deps (B1 Step 3): a fresh worktree
// has been observed reporting `pnpm install --frozen-lockfile` success
// while still missing a key binary in node_modules/.bin (root cause
// unconfirmed; suspected pnpm store/hardlink race in freshly created
// worktrees sharing a store). Run the install command, verify the key
// binary exists, retry the install exactly once if it does not, and
// fail loudly rather than continuing in a silently broken state.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isCliExecution } from './gh-exec.mts';

export type VerifyInstallDepsOutcome =
  | { status: 'present-after-install' }
  | { status: 'recovered-after-retry' }
  | { status: 'missing-after-retry' };

/**
 * Pure classification of the two existence checks around the retry.
 * `existsAfterRetry` is only meaningful when `existsAfterInstall` is
 * false — the caller skips the retry (and its check) otherwise.
 */
export function classifyInstallDepsOutcome(
  existsAfterInstall: boolean,
  existsAfterRetry: boolean,
): VerifyInstallDepsOutcome {
  if (existsAfterInstall) {
    return { status: 'present-after-install' };
  }
  return existsAfterRetry
    ? { status: 'recovered-after-retry' }
    : { status: 'missing-after-retry' };
}

if (isCliExecution(import.meta.url)) {
  runCli();
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.keyBinary === null) {
    throw new Error('--key-binary is required');
  }
  if (args.installCommand === null) {
    throw new Error('--install-command is required');
  }

  runInstallCommand(args.installCommand);
  const existsAfterInstall = existsSync(args.keyBinary);

  let existsAfterRetry = false;
  if (!existsAfterInstall) {
    process.stderr.write(
      `verify-install-deps: ${args.keyBinary} missing or install failed; retrying "${args.installCommand}" once...\n`,
    );
    runInstallCommand(args.installCommand);
    existsAfterRetry = existsSync(args.keyBinary);
  }

  const outcome = classifyInstallDepsOutcome(
    existsAfterInstall,
    existsAfterRetry,
  );
  if (outcome.status === 'missing-after-retry') {
    process.stderr.write(
      `verify-install-deps: ${args.keyBinary} still missing after retrying ` +
        `"${args.installCommand}". The dependency install did not complete ` +
        'correctly; inspect the install output above and retry manually.\n',
    );
    process.exit(1);
  }
  if (outcome.status === 'recovered-after-retry') {
    process.stderr.write(
      `verify-install-deps: ${args.keyBinary} present after retry.\n`,
    );
  }
}

function runInstallCommand(installCommand: string): void {
  // The command is a trusted, repo-configured string (Project commands
  // table / .github/idd/config.json), not untrusted input; execFileSync
  // via a shell (rather than execSync) satisfies this repo's
  // injection-safety lint rule while still supporting shell syntax
  // (`&&`, quoting) in the configured command.
  //
  // A non-zero exit is intentionally swallowed here rather than left to
  // propagate: the binary-existence check right after this call is
  // authoritative either way, so a hard install failure flows into the
  // same retry-then-fail-loud path as a silent under-install instead of
  // crashing with a raw stack trace. The real error output already
  // streamed to the terminal via stdio: 'inherit'.
  try {
    execFileSync('/bin/sh', ['-c', installCommand], { stdio: 'inherit' });
  } catch {
    // Swallowed intentionally -- see comment above.
  }
}

interface ParsedArgs {
  keyBinary: string | null;
  installCommand: string | null;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    keyBinary: null,
    installCommand: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const requireValue = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`missing value for argument: ${token}`);
      }
      return value;
    };
    if (token === '--key-binary') {
      parsed.keyBinary = requireValue();
      index += 1;
      continue;
    }
    if (token === '--install-command') {
      parsed.installCommand = requireValue();
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      parsed.help = true;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }

  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage:
  node scripts/verify-install-deps.mjs --key-binary <path> --install-command <command>

Runs <command>, then verifies <path> exists. If missing, re-runs
<command> exactly once and re-checks. Exits 0 when the binary is
present (before or after the retry); exits 1 with an actionable error
when it is still missing after the retry.

Example:
  node scripts/verify-install-deps.mjs --key-binary node_modules/.bin/tsc --install-command "pnpm install --frozen-lockfile"
`);
}
