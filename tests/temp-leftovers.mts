/**
 * Which leftovers in a test process's per-process temporary directory fail
 * the run (issue #4049). `tests/isolate-state.mts` applies it at exit and
 * `tests/isolate-state.test.mts` pins it directly.
 *
 * This module has no top-level side effects and imports nothing, so the
 * preload can load it in a lane with no package install.
 */

/** Entry-name prefixes the preload itself creates and removes. */
const OWN_PREFIXES = ['idd-test-state-', 'idd-test-gh-guard-'] as const;

/**
 * The compile cache Node writes under the temporary directory for a tool
 * that enables it (corepack, for one); the test never creates it.
 */
const NODE_COMPILE_CACHE = 'node-compile-cache';

/** Whether `name` is an entry the temporary-directory guard never reports. */
export function isIgnoredTempEntry(name: string): boolean {
  return (
    name === NODE_COMPILE_CACHE ||
    OWN_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export interface TempLeftoverVerdict {
  /** Names that set the exit code to 1. */
  fail: string[];
  /** Names that are only printed as a warning. */
  warn: string[];
}

/**
 * Split leftover entry names into the ones that fail the run and the ones
 * that only warn, after dropping the ignored ones. On `win32` every leftover
 * only warns: `removeStubDirectory` in `tests/test-utils.mts` may leave an
 * `idd-stub-*` or `idd-fixture-gh-*` directory behind while Windows keeps a
 * running executable image locked (issue #3680), and no Windows leftover has
 * been measured. Every other platform fails on every leftover. Both lists
 * are sorted.
 */
export function classifyTempLeftovers(
  names: readonly string[],
  platform: string,
): TempLeftoverVerdict {
  const reported = names.filter((name) => !isIgnoredTempEntry(name)).sort();
  return platform === 'win32'
    ? { fail: [], warn: reported }
    : { fail: reported, warn: [] };
}
