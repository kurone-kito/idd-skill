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
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { after } from 'node:test';

/** Whether `path` is strictly below `root` (both resolved). */
function isStrictlyInside(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== '' && !isAbsolute(rest) && rest.split(sep)[0] !== '..';
}

/**
 * Return an `mkdtempSync` replacement that records every directory it
 * creates, and register a file-level `after` hook that removes them all.
 * Call it once at the top level of a test file. The hook runs once, after
 * all tests in the file have finished, not between tests, so a fixture
 * stays until the file ends and a child process a test spawned and waited
 * for has already exited.
 *
 * As `trackedMkdtemp` in `tests/idd-onboard.test.mts` does, the recursive
 * removal never reaches outside the temporary directory. A `prefix` must
 * resolve strictly below the `os.tmpdir()` captured by this call, must not
 * contain a `..` segment, and the real path of the directory it names
 * (symbolic links followed) must be that directory's real path or below it;
 * otherwise the call throws before anything is created. A prefix in a nested
 * fixture directory is allowed. The real path of each created directory is
 * checked the same way when it is created; if a concurrent change to the
 * file system still moved it outside, the call throws and leaves it in
 * place. The hook resolves each real path again just before removing it and
 * skips one that no longer resolves strictly below the root, for example
 * because a test replaced one of its ancestors with a symbolic link.
 *
 * On `win32` a removal failure is ignored, because Windows refuses to remove
 * a directory that holds a running executable image (issue #3680); the
 * preload's temporary-directory guard then prints the leftover as a warning.
 * On every other platform the failure fails the hook.
 */
export function trackTempDirectories(): (prefix: string) => string {
  const root = resolve(tmpdir());
  const realRoot = realpathSync(root);
  const created: string[] = [];
  after(() => {
    const failures: unknown[] = [];
    for (const directory of created.splice(0)) {
      let current = '';
      try {
        current = realpathSync(directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Already gone, for example removed with a tracked ancestor.
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        if (process.platform !== 'win32') failures.push(error);
        continue;
      }
      if (!isStrictlyInside(realRoot, current)) continue;
      try {
        rmSync(current, {
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
    // mkdtempSync appends six characters to the prefix as written, so check
    // the path it will create, not the prefix: `resolve` would drop a
    // trailing separator or `.` segment and misplace the parent.
    const target = resolve(`${prefix}XXXXXX`);
    let parent = '';
    try {
      parent = realpathSync(dirname(target));
    } catch {
      // A missing parent is rejected below; mkdtempSync would fail anyway.
    }
    if (
      // The operating system follows a link before a later `..`, while
      // `resolve` and `realpathSync` drop the pair as text first.
      prefix.split(/[\\/]/).includes('..') ||
      !isStrictlyInside(root, target) ||
      parent === '' ||
      (parent !== realRoot && !isStrictlyInside(realRoot, parent))
    ) {
      throw new Error(
        `trackTempDirectories: prefix must resolve below ${root}: ${prefix}`,
      );
    }
    const directory = mkdtempSync(prefix);
    const real = realpathSync(directory);
    if (!isStrictlyInside(realRoot, real)) {
      // Unreachable given the checks above unless the file system changed
      // in between. Nothing outside the temporary root is ever removed, not
      // even this new empty directory: throw and leave it in place.
      throw new Error(
        `trackTempDirectories: refusing to track ${directory} outside ${root}`,
      );
    }
    created.push(real);
    return directory;
  };
}
