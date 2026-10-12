/**
 * Temporary fixture directories that a test file removes when it finishes
 * (issue #4049). Observed on 2026-10-11: 16 of 216 test files left their
 * `mkdtempSync` fixtures under `os.tmpdir()`, and `/tmp`, a tmpfs, held about
 * 90,000 `idd-*` entries when a `pnpm run check` run failed with "no space
 * left on device". The per-file teardown in `tests/idd-onboard.test.mts`
 * (issue #2396) is the pattern this shares.
 *
 * This module imports only `node:` builtins.
 */
import { mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { after } from 'node:test';

/** Whether `path` is strictly below `root` (both resolved). */
function isStrictlyInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== '' && !isAbsolute(rest) && rest.split(sep)[0] !== '..';
}

/**
 * Return an `mkdtempSync` replacement that records every directory it
 * creates, and register a file-level `after` hook that removes them all.
 * Call it once at the top level of a test file. The hook runs after every
 * test in the file, so a child process a test spawned and waited for has
 * already exited.
 *
 * As `trackedMkdtemp` in `tests/idd-onboard.test.mts` does, the recursive
 * removal never reaches outside the temporary directory: a `prefix` that
 * does not resolve strictly below the `os.tmpdir()` captured by this call
 * throws before anything is created, and so does a created directory that
 * is not below it. A prefix in a nested fixture directory there is allowed.
 *
 * On `win32` a removal failure is ignored, because Windows refuses to remove
 * a directory that holds a running executable image (issue #3680); the
 * preload's temporary-directory guard then prints the leftover as a warning.
 * On every other platform the failure fails the hook.
 */
export function trackTempDirectories(): (prefix: string) => string {
  const root = resolve(tmpdir());
  const created: string[] = [];
  after(() => {
    const failures: unknown[] = [];
    for (const directory of created.splice(0)) {
      try {
        rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      } catch (error) {
        if (process.platform !== 'win32') failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'temporary fixture removal failed');
    }
  });
  return (prefix: string): string => {
    if (!isStrictlyInside(root, resolve(prefix))) {
      throw new Error(
        `trackTempDirectories: prefix must resolve below ${root}: ${prefix}`,
      );
    }
    const directory = mkdtempSync(prefix);
    if (!isStrictlyInside(root, resolve(directory))) {
      // Unreachable given the check above; kept so the after hook can never
      // remove a directory outside the temporary root. The new directory is
      // empty, so a non-recursive removal is enough.
      rmdirSync(directory);
      throw new Error(
        `trackTempDirectories: refusing to track ${directory} outside ${root}`,
      );
    }
    created.push(directory);
    return directory;
  };
}
