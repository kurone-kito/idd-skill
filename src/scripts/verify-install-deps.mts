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
import { parseCliArgs } from './cli-args.mts';

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

// Flag-spec keys stay the dashed literal on purpose (never bare keys like
// `key-binary:`): tests/flag-name-matrix.test.mts scans this file's
// *compiled* .mjs source text for quoted flag literals such as the
// --key-binary spec key below. See cli-args.mts's module header for the
// full invariant.
//
// Declared here, above the import.meta.main trigger below, rather than
// alongside parseArgs further down: the trigger calls runCli() ->
// parseArgs() synchronously at module-evaluation time, and a `const`
// declared after that point is still in the temporal dead zone when the
// trigger fires.
const VERIFY_INSTALL_DEPS_FLAG_SPEC = {
  '--key-binary': { type: 'string' },
  '--install-command': { type: 'string' },
  '--help': { type: 'boolean', short: 'h' },
} as const;

if (import.meta.main) {
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
  // shell: true is required, not incidental: the configured install
  // command (Project commands table / .github/idd/config.json) can
  // contain shell syntax (`&&`, quoting) that only a shell can
  // interpret, and it lets Node pick the platform shell instead of
  // hard-coding /bin/sh, which does not exist on Windows or some
  // minimal containers -- the real, separate problem the pre-#1244
  // execFileSync('/bin/sh', ['-c', installCommand], ...) form had.
  //
  // execFileSync(installCommand, [], { shell: true }) has the SAME
  // shell-injection surface execSync(installCommand) would: Node
  // implements exec/execSync internally as execFile/execFileSync
  // with shell forced on, so this construction only avoids importing
  // the execSync symbol banned by this repo's noRestrictedImports
  // lint rule -- it does not avoid execSync's injection-risk
  // profile. The actual safety basis is that installCommand is a
  // trusted, repo-configured string (never attacker- or
  // user-supplied input), not the choice of execFileSync over
  // execSync.
  //
  // A non-zero exit is intentionally swallowed here rather than left to
  // propagate: the binary-existence check right after this call is
  // authoritative either way, so a hard install failure flows into the
  // same retry-then-fail-loud path as a silent under-install instead of
  // crashing with a raw stack trace. The real error output already
  // streamed to the terminal via stdio: 'inherit'.
  try {
    execFileSync(installCommand, [], { shell: true, stdio: 'inherit' });
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
  const { values, help } = parseCliArgs(argv, VERIFY_INSTALL_DEPS_FLAG_SPEC);
  return {
    keyBinary: (values['key-binary'] as string | undefined) ?? null,
    installCommand: (values['install-command'] as string | undefined) ?? null,
    help,
  };
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
