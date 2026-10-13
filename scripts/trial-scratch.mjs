// idd-generated-from: src/scripts/trial-scratch.mts
//
// The scripts/trial-scratch.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated .mjs.
// See docs/typescript-sources.md.
//
// Steps shared by the scratch-worktree trial helpers, trial-merge-audit and
// pre-push-trial-budget (#4095): a git environment without repository
// overrides, a git run with an empty hooks directory, and a scratch worktree
// add whose failure leaves no registration behind. Each helper keeps its own
// base-tooling pin, lock scope, and verdicts. This module holds no
// pre-push-only code, because the helper runtime vendors every file that
// trial-merge-audit imports.
import { existsSync, lstatSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
/** The `GIT_*` variables a scratch run keeps: credential helpers only. */
export const DEFAULT_KEEP_LIST = [
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
];
/**
 * A copy of `env` without repository overrides: every `GIT_*` variable is
 * removed unless `keepList` names it, so an inherited `GIT_DIR` cannot point a
 * scratch run at another repository. Credential prompts are disabled, so a
 * stalled git fails instead of waiting for input. The input is not modified.
 */
export function scrubbedGitEnv(
  env = process.env,
  keepList = DEFAULT_KEEP_LIST,
) {
  const kept = new Set(keepList);
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GIT_') && !kept.has(key)) continue;
    scrubbed[key] = value;
  }
  scrubbed.GIT_TERMINAL_PROMPT = '0';
  scrubbed.GCM_INTERACTIVE = 'never';
  return scrubbed;
}
/**
 * Run git with `core.hooksPath` pointed at the run's empty hooks directory.
 * The shared steps add the hooks-path prefix only here.
 */
export function runGitHooksOff(runGit, args, options) {
  // The environment is scrubbed even when the caller supplies one, so a
  // caller-supplied GIT_DIR cannot redirect the run.
  return runGit(
    ['-c', `core.hooksPath=${options.hooksDir}`, ...args],
    options.cwd,
    scrubbedGitEnv(options.env ?? process.env),
  );
}
/** A path with `\` read as `/` and trailing separators dropped, for comparison. */
function comparablePath(path) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '');
}
/** The directory's real path, or the path itself when it cannot be resolved. */
function realDirectory(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}
/**
 * True for any directory entry at `path`, a dangling symlink included.
 * `existsSync` follows links, so it would miss one and let git run on it.
 */
function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
/** The paths named by the `worktree <path>` lines of a porcelain listing. */
function listedWorktreePaths(porcelain) {
  return porcelain
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).replace(/\r$/, ''));
}
/**
 * Add a detached scratch worktree at `path` and, if that fails, clean up so no
 * registration for `path` remains. A path that already exists is refused with
 * no git call, because the module never removes a path it did not create.
 *
 * On failure the path is removed if it still exists (git normally removes it
 * itself). If that removal fails, the result is `registrationRemoved: false`
 * and no listing runs. Otherwise the worktree listing is checked. A listed
 * registration is
 * removed with `worktree remove --force --` for that one path, passing the path
 * exactly as the listing prints it. `worktree prune` is never run, because it
 * would also clear the gone records of other worktrees in the clone.
 */
export function addScratchWorktree(runGit, options) {
  const failed = (registrationRemoved) => ({
    ok: false,
    reason: 'worktree-add-failed',
    registrationRemoved,
  });
  if (pathExists(options.path)) return failed(false);
  // git records a worktree under its resolved path, so the listing can spell
  // the scratch path through the real parent directory (a symlinked temp dir).
  // Both spellings name the same registration.
  const wanted = new Set([
    comparablePath(options.path),
    comparablePath(
      join(realDirectory(dirname(options.path)), basename(options.path)),
    ),
  ]);
  const added = runGitHooksOff(
    runGit,
    ['worktree', 'add', '--detach', options.path, options.commit],
    options,
  );
  if (added.status === 0) return { ok: true };
  if (existsSync(options.path)) {
    try {
      rmSync(options.path, { recursive: true, force: true });
    } catch {
      // The leftover could not be removed, so its state is unknown.
      return failed(false);
    }
  }
  const listing = runGitHooksOff(
    runGit,
    ['worktree', 'list', '--porcelain'],
    options,
  );
  // A failed listing cannot show whether the registration is gone.
  if (listing.status !== 0) return failed(false);
  const listed = listedWorktreePaths(listing.stdout).find((path) =>
    wanted.has(comparablePath(path)),
  );
  if (listed === undefined) return failed(true);
  const removed = runGitHooksOff(
    runGit,
    ['worktree', 'remove', '--force', '--', listed],
    options,
  );
  return failed(removed.status === 0);
}
