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
//
// Also validates the locally resolved `pnpm --version` against the major
// pinned in package.json's `packageManager` field before running the
// install command at all, failing fast with an actionable message on a
// mismatch (#3043). This replaces the fail-fast behavior package.json's
// own `engines.pnpm` used to provide via pnpm's `engineStrict` -- removed
// because `engineStrict` enforces `engines` transitively across the whole
// dependency graph, so `engines.pnpm` also constrained every downstream
// `package-manager`-profile consumer installing this package as a real
// dependency, with no compensating benefit to them (see
// docs/idd-helper-scripts.md's package-manager profile note). This
// script is never exposed via `package.json`'s `bin`, so the replacement
// check only ever runs against this repository's own `package.json` --
// it cannot reintroduce the leak. Scope note: unlike `engines.pnpm`, this
// check only fires through this script's own `install-deps` invocation,
// not on every bare `pnpm install` a contributor might run directly.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { parseCliArgs } from './cli-args.mjs';
/**
 * Pure classification of the two existence checks around the retry.
 * `existsAfterRetry` is only meaningful when `existsAfterInstall` is
 * false — the caller skips the retry (and its check) otherwise.
 */
export function classifyInstallDepsOutcome(
  existsAfterInstall,
  existsAfterRetry,
) {
  if (existsAfterInstall) {
    return { status: 'present-after-install' };
  }
  return existsAfterRetry
    ? { status: 'recovered-after-retry' }
    : { status: 'missing-after-retry' };
}
/**
 * Parses the pnpm major version pinned in package.json's `packageManager`
 * field (e.g. `pnpm@12.4.1+sha512-...`). Returns `null` when the field is
 * absent or pins a different package manager (npm, yarn) -- the pnpm
 * version check is a no-op in either case. This script is never exposed
 * via `package.json`'s `bin` (see the module header), so it only ever
 * reads this repository's own `packageManager` pin, never a consumer's.
 */
export function parsePnpmMajorFromPackageManager(packageManagerField) {
  if (packageManagerField === undefined) {
    return null;
  }
  const match = /^pnpm@(\d+)\./.exec(packageManagerField);
  return match === null ? null : Number(match[1]);
}
/**
 * Extracts the leading `<major>.<minor>.<patch>` token from `pnpm
 * --version` output. Uses a regex over a naive trim so incidental output
 * around the version -- a corepack first-run banner line, trailing CRLF --
 * doesn't break parsing.
 */
export function parsePnpmMajorFromVersionOutput(versionOutput) {
  const match = /(\d+)\.\d+\.\d+/.exec(versionOutput);
  return match === null ? null : Number(match[1]);
}
/**
 * Pure classification of the pnpm-version check: does the resolved `pnpm
 * --version` output satisfy the major pinned in package.json's
 * `packageManager` field? `requiredMajor` is `null` when `packageManager`
 * doesn't pin pnpm at all (`not-applicable` -- nothing to check).
 * `detectedVersionRaw` is `null`, or unparseable, when `pnpm --version`
 * could not be resolved (`undetermined` -- the check can't reach a
 * verdict, so it never blocks the install on an inconclusive read).
 */
export function classifyPnpmVersionCheck(requiredMajor, detectedVersionRaw) {
  if (requiredMajor === null) {
    return { status: 'not-applicable' };
  }
  const detectedMajor =
    detectedVersionRaw === null
      ? null
      : parsePnpmMajorFromVersionOutput(detectedVersionRaw);
  if (detectedMajor === null || detectedVersionRaw === null) {
    return { status: 'undetermined', requiredMajor };
  }
  const detectedVersion = detectedVersionRaw.trim();
  return detectedMajor === requiredMajor
    ? { status: 'match', requiredMajor, detectedVersion }
    : { status: 'mismatch', requiredMajor, detectedVersion };
}
/**
 * Actionable error message for a `mismatch` verdict, naming both the
 * detected and required pnpm versions so a contributor knows exactly what
 * to install.
 */
export function describePnpmVersionMismatch(detectedVersion, requiredMajor) {
  return (
    `verify-install-deps: resolved pnpm ${detectedVersion} does not satisfy ` +
    `the pnpm ${requiredMajor}.x major pinned in package.json's ` +
    `"packageManager" field. Install pnpm ${requiredMajor}.x (for example ` +
    'via corepack) and retry.\n'
  );
}
/**
 * Node.js 25+ no longer bundles corepack (nodejs/corepack), so a
 * pnpm-based install command can fail with no pnpm binary to run on a
 * bare Node >=25 install. When the key binary is still missing after
 * the retry, this hint is a possibility to check, not a diagnosis --
 * corepack being absent isn't necessarily the actual cause.
 */
export function describeCorepackGuidance(corepackAvailable) {
  if (corepackAvailable) {
    return null;
  }
  return (
    'verify-install-deps: corepack was not found. Node.js 25+ no longer ' +
    'bundles corepack, which may be why the install above is failing -- ' +
    'install it separately (for example `npm install -g corepack`) and ' +
    'retry.\n'
  );
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
};
if (import.meta.main) {
  runCli();
}
function runCli() {
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
  const requiredPnpmMajor = resolveRequiredPnpmMajor();
  const pnpmVersionCheck = classifyPnpmVersionCheck(
    requiredPnpmMajor,
    requiredPnpmMajor === null ? null : resolveDetectedPnpmVersion(),
  );
  if (pnpmVersionCheck.status === 'mismatch') {
    process.stderr.write(
      describePnpmVersionMismatch(
        pnpmVersionCheck.detectedVersion,
        pnpmVersionCheck.requiredMajor,
      ),
    );
    process.exit(1);
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
    const corepackHint = describeCorepackGuidance(isCorepackAvailable());
    if (corepackHint !== null) {
      process.stderr.write(corepackHint);
    }
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
function runInstallCommand(installCommand) {
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
/**
 * `shell: true` is required, not incidental: a globally installed
 * `corepack` can be a `.CMD`/`.ps1` shim on Windows that isn't
 * directly executable without a shell -- the same class of problem
 * `build-ts.mts`'s header documents for the `tsc`/`biome` shim case --
 * omitting it risks a false "missing" read on Windows even when
 * corepack is present.
 */
function isCorepackAvailable() {
  try {
    execFileSync('corepack', ['--version'], { shell: true, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
/**
 * Reads package.json's `packageManager` field from the current working
 * directory to resolve the pnpm major the version check enforces.
 * Read/parse failures resolve to `null` (`not-applicable`) rather than
 * throwing -- `install-deps` must never fail merely because package.json
 * couldn't be read here; a genuinely broken package.json will already
 * fail loudly once `runInstallCommand` runs.
 */
function resolveRequiredPnpmMajor() {
  try {
    const raw = readFileSync('package.json', 'utf8');
    const parsed = JSON.parse(raw);
    const packageManager =
      typeof parsed.packageManager === 'string'
        ? parsed.packageManager
        : undefined;
    return parsePnpmMajorFromPackageManager(packageManager);
  } catch {
    return null;
  }
}
/**
 * Shells out to `pnpm --version` to resolve the locally resolvable pnpm
 * version. `shell: true` is required for the same reason as
 * `isCorepackAvailable` above: a globally installed pnpm can be a
 * `.CMD`/`.ps1` shim on Windows that isn't directly executable without a
 * shell. Failures (pnpm absent, non-zero exit) resolve to `null`
 * (`undetermined` once classified) rather than throwing.
 */
function resolveDetectedPnpmVersion() {
  try {
    return execFileSync('pnpm', ['--version'], {
      shell: true,
      encoding: 'utf8',
    });
  } catch {
    return null;
  }
}
function parseArgs(argv) {
  const { values, help } = parseCliArgs(argv, VERIFY_INSTALL_DEPS_FLAG_SPEC);
  return {
    keyBinary: values['key-binary'] ?? null,
    installCommand: values['install-command'] ?? null,
    help,
  };
}
function printHelp() {
  process.stdout.write(`Usage:
  node scripts/verify-install-deps.mjs --key-binary <path> --install-command <command>

If package.json's "packageManager" field pins pnpm, first verifies the
locally resolved pnpm version satisfies that pinned major, exiting 1
with an actionable error naming both versions on a mismatch, before
running <command> at all. Otherwise (or once that check passes): runs
<command>, then verifies <path> exists. If missing, re-runs <command>
exactly once and re-checks. Exits 0 when the binary is present (before
or after the retry); exits 1 with an actionable error when it is still
missing after the retry.

Example:
  node scripts/verify-install-deps.mjs --key-binary node_modules/.bin/tsc --install-command "pnpm install --frozen-lockfile"
`);
}
