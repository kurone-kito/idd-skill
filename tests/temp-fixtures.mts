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
import { mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';

/**
 * Return an `mkdtempSync` replacement that records every directory it
 * creates, and register a file-level `after` hook that removes them all.
 * Call it once at the top level of a test file. The hook runs after every
 * test in the file, so a child process a test spawned and waited for has
 * already exited.
 *
 * On `win32` a removal failure is ignored, because Windows refuses to remove
 * a directory that holds a running executable image (issue #3680); the
 * preload's temporary-directory guard then prints the leftover as a warning.
 * On every other platform the failure fails the hook.
 */
export function trackTempDirectories(): (prefix: string) => string {
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
    const directory = mkdtempSync(prefix);
    created.push(directory);
    return directory;
  };
}
