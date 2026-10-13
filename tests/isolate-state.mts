/**
 * Preload for the whole test suite (issue #3725). Run it as
 * `node --test --import ./tests/isolate-state.mts tests/*.test.mts`: the
 * runner process does not evaluate the preload; it forwards `--import` to one
 * child process per test file and each child loads it, so every file gets its
 * own throwaway per-user state root, GitHub CLI attempt ledger and per-process
 * temporary directory.
 *
 * Why: this repository's own config enables `githubApi.loadControl` and
 * `githubApi.readCache`, and a helper reads that config through its working
 * directory. A test that reaches `gh` without a function-level stub or a
 * scratch directory then writes slot, cooldown and cache files under the
 * per-user directory that every concurrent session on the host shares
 * (`XDG_STATE_HOME`, else `~/.local/state`, `LOCALAPPDATA` on Windows, and
 * `XDG_CACHE_HOME` for the read cache). Nothing reported such a write; the
 * four files found while implementing #3702 (fixed in #3711) each passed
 * every assertion. This module points those variables at a throwaway
 * directory and, when the process exits, fails it if anything was written
 * below an `idd-*` entry there.
 *
 * State-root contract:
 * - When `IDD_TEST_STATE_ROOT` is unset or empty, create a temporary
 *   directory with `state`, `cache`, and `config` subdirectories, export the
 *   marker, set `XDG_STATE_HOME` and `LOCALAPPDATA` to `state`,
 *   `XDG_CACHE_HOME` to `cache`, and `XDG_CONFIG_HOME` to `config` (empty, so
 *   no user-global policy file is read), and register one `exit` listener.
 *   When it is already set and
 *   non-empty, change nothing and register nothing, so a child that receives
 *   the same preload, or that a test gives its own state variables, keeps
 *   them.
 * - When the marker is unset or empty, the preload also deletes
 *   `GITHUB_REPOSITORY` and `GH_REPO` before any child starts, so a spawned
 *   helper reaches its own `gh repo view` stub rather than the outer
 *   repository. GitHub Actions sets the first in every job, and `gh` honors
 *   the second. Preventive; no observed incident yet: once the resolver prefers
 *   the variable (issue `#4110`), a test file that stubs `gh repo view` would
 *   otherwise skip its stub in CI. The resolver change itself was motivated by
 *   a `gh repo view` timeout observed on `kurone-kito/setup.ubuntu#204`. When
 *   the marker is already set, both are kept, so a test that sets one
 *   explicitly for its child keeps it.
 * - The listener scans for every non-directory entry at or below a top-level
 *   entry whose name starts with `idd-` (`idd-skill`, and `idd-critique`,
 *   which an external collector writes under the state root). Anything else
 *   is ignored (for example `gh/device-id`, which the `gh` binary itself
 *   writes). A symbolic link is reported and never followed. It then removes
 *   the whole directory, and on a leak lists the files on stderr and sets
 *   `process.exitCode` to 1, which also overrides a `process.exit(n)` code.
 *   It never throws.
 * - Independently of the marker, a relative `--import` entry of
 *   `process.execArgv` is rewritten to a `file:` URL, so a child spawned with
 *   `process.execArgv` from another working directory still resolves this
 *   module. Node 24 and later add the `--import=<path>` form themselves next
 *   to `--import <path>`, so the module appears twice in `execArgv` and is
 *   evaluated once; both forms are rewritten.
 *
 * Temporary-directory guard (issue #4049): under the same marker condition,
 * and before the state root, create an `idd-test-tmp-*` directory under the
 * caller's temporary directory and set `TMPDIR`, `TEMP` and `TMP` to it, so
 * `os.tmpdir()` resolves to it on every platform and the state root and the
 * GitHub CLI guard root are created directly inside it. Its `exit` listener
 * is registered last, so it runs after the GitHub CLI guard has read its
 * ledger and after the state-root scan. It names every direct entry of the
 * captured directory (file, directory or symbolic link) without descending,
 * skipping `idd-test-state-*`, `idd-test-gh-guard-*` and
 * `node-compile-cache` (`tests/temp-leftovers.mts` holds that rule). A
 * reported entry sets `process.exitCode` to 1, except on `win32`, where it is
 * only printed as a warning: Windows can keep an `idd-stub-*` or
 * `idd-fixture-gh-*` directory locked while its executable runs (issue
 * #3680), and no Windows leftover has been measured. The listener then
 * removes the directory; it never throws, and a failed removal does not
 * change the exit code. Observed on 2026-10-11: 16 of 216 test files left
 * fixtures in `/tmp`, a tmpfs, which then held about 90,000 `idd-*` entries;
 * issue #2396 had fixed the same pattern in one file.
 *
 * GitHub CLI guard: create a separate per-file ledger and load the ESM
 * `isolate-gh.mts` guard in this process. Add it with `NODE_OPTIONS --import`
 * for child CLIs; its Worker wrapper passes a small CommonJS bridge through
 * explicit `execArgv` or inherited `NODE_OPTIONS`, including Workers with
 * `execArgv: []`. The bridge adds itself to a nested child CLI's environment
 * even when the Worker received an explicit `env` without `NODE_OPTIONS`,
 * and carries the ledger into that Worker. The guard checks the ledger
 * before this module's state-root cleanup runs.
 *
 * Known limits: running one file by hand with plain `node --test` bypasses
 * both guards (preventive; no observed incident yet; the observed probe leak
 * that motivated the GitHub CLI guard is issue #3755, 2026-10-04);
 * the listeners do not run when the process is killed by a signal (the
 * throwaway and per-process temporary directories are then left behind) and
 * miss a detached grandchild that writes after the process exits; on
 * `win32` a directory a running executable keeps locked also keeps the
 * per-process temporary directory behind, without a message; a child
 * spawned with an explicit `env` that omits `TMPDIR`, `TEMP` and `TMP` writes
 * to the caller's temporary directory unchecked; a `Worker` given its own
 * `env` gets its own throwaway state root and its own nested per-process
 * temporary directory, and its leak reports go to stderr without changing the
 * main thread's exit code (a nested directory it leaves behind is still a
 * leftover of the main thread's), while the GitHub CLI guard carries
 * its ledger into that Worker; on macOS the read-cache default under
 * `~/Library/Caches` ignores `XDG_CACHE_HOME`; the state-root behavior on
 * Windows is unverified.
 *
 * This preload, `tests/temp-leftovers.mts` and its local GitHub guard modules
 * import only `node:` builtins: the `lint` workflow runs the suite with no
 * package install.
 */
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyTempLeftovers } from './temp-leftovers.mts';

const ROOT_MARKER = 'IDD_TEST_STATE_ROOT';
const TEMP_ROOT_PREFIX = 'idd-test-tmp-';
const WATCHED_PREFIX = 'idd-';
const RELATIVE_SPECIFIER = /^\.\.?(?:[\\/]|$)/;
const nodeOptions = createRequire(import.meta.url)('./node-options.cjs') as {
  appendNodeOptionsPreload: (
    source: string,
    flag: string,
    value: string,
    cwd: string,
    knownFlags?: string[],
  ) => string;
};

function toFileUrl(specifier: string): string {
  return pathToFileURL(resolve(specifier)).href;
}

/** Rewrite relative `--import` entries (both argv forms) in place. */
function absolutizeRelativeImports(argv: string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--import') {
      const specifier = argv[index + 1];
      if (specifier !== undefined && RELATIVE_SPECIFIER.test(specifier)) {
        argv[index + 1] = toFileUrl(specifier);
      }
      index += 1;
    } else if (arg.startsWith('--import=')) {
      const specifier = arg.slice('--import='.length);
      if (RELATIVE_SPECIFIER.test(specifier)) {
        argv[index] = `--import=${toFileUrl(specifier)}`;
      }
    }
  }
}

/** The entries of `directory`, or none when it is missing or unreadable. */
function listEntries(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every non-directory entry below `directory`; a symlink is not followed. */
function collectFiles(directory: string, found: string[]): void {
  for (const entry of listEntries(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collectFiles(path, found);
    } else {
      found.push(path);
    }
  }
}

/** Leaked paths relative to `root`, with `/` separators, sorted. */
function findLeakedFiles(root: string): string[] {
  const found: string[] = [];
  for (const base of ['state', 'cache']) {
    const baseDirectory = join(root, base);
    for (const entry of listEntries(baseDirectory)) {
      if (!entry.name.startsWith(WATCHED_PREFIX)) continue;
      const path = join(baseDirectory, entry.name);
      if (entry.isDirectory()) {
        collectFiles(path, found);
      } else {
        found.push(path);
      }
    }
  }
  return found.map((path) => relative(root, path).split(sep).join('/')).sort();
}

function installStateRoot(): () => void {
  // `resolve`: a relative TMPDIR would otherwise leave a relative root, and a
  // test that changes its working directory would then hide a leak.
  const root = mkdtempSync(join(resolve(tmpdir()), 'idd-test-state-'));
  const state = join(root, 'state');
  const cache = join(root, 'cache');
  const config = join(root, 'config');
  mkdirSync(state);
  mkdirSync(cache);
  mkdirSync(config);
  process.env[ROOT_MARKER] = root;
  process.env.XDG_STATE_HOME = state;
  process.env.LOCALAPPDATA = state;
  process.env.XDG_CACHE_HOME = cache;
  // #3820: an empty throwaway config home, so the user-global policy file an
  // operator keeps under ~/.config/idd-skill never reaches a test that loads
  // layered policy. A test that needs a user-global file sets its own root.
  process.env.XDG_CONFIG_HOME = config;
  // Every path below comes from the captured `root`, never from the
  // environment at exit time: tests in this repository reassign these
  // variables.
  return () => {
    let leaked: string[] = [];
    try {
      leaked = findLeakedFiles(root);
    } catch {
      // A scan failure counts as no files; the listener never throws.
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A removal failure must not escape or change the exit code.
    }
    if (leaked.length === 0) return;
    // Independent of the write below: a synchronous write can truncate under
    // pipe backpressure without throwing.
    process.exitCode = 1;
    try {
      writeSync(
        2,
        `isolate-state: LEAK: ${leaked.length} file(s) written under the throwaway per-user state or cache root; without this preload they would have landed in the real per-user directory that concurrent sessions share. Give the test a function-level stub or a scratch working directory:\n${leaked.map((path) => `  ${path}`).join('\n')}\n`,
      );
    } catch {
      // The exit code above already carries the failure.
    }
  };
}

/**
 * Create the per-process temporary directory and point `TMPDIR`, `TEMP` and
 * `TMP` at it, so `os.tmpdir()` resolves to it on every platform; return its
 * exit listener.
 */
function installTempRoot(): () => void {
  // `resolve`: a relative TMPDIR would otherwise leave a relative directory,
  // and a test that changes its working directory would then hide a leak.
  const directory = mkdtempSync(join(resolve(tmpdir()), TEMP_ROOT_PREFIX));
  process.env.TMPDIR = directory;
  process.env.TEMP = directory;
  process.env.TMP = directory;
  // The captured `directory` only, never `TMPDIR` or `os.tmpdir()` at exit
  // time: a test may reassign them.
  return () => {
    let verdict: { fail: string[]; warn: string[] } = { fail: [], warn: [] };
    try {
      verdict = classifyTempLeftovers(
        listEntries(directory).map((entry) => entry.name),
        process.platform,
      );
    } catch {
      // A scan failure counts as no leftovers; the listener never throws.
    }
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // A removal failure must not escape or change the exit code.
    }
    if (verdict.fail.length > 0) process.exitCode = 1;
    const names = verdict.fail.length > 0 ? verdict.fail : verdict.warn;
    if (names.length === 0) return;
    const label = verdict.fail.length > 0 ? 'LEAK' : 'warning';
    try {
      writeSync(
        2,
        `isolate-state: TEMP ${label}: ${names.length} ${names.length === 1 ? 'entry' : 'entries'} left in the per-process temporary directory ${directory}. Remove each fixture in an after hook or a finally block:\n${names.map((name) => `  ${name}`).join('\n')}\n`,
      );
    } catch {
      // The exit code above already carries the failure.
    }
  };
}

absolutizeRelativeImports(process.execArgv);
// Read once, before installStateRoot() sets the marker: a check made after
// that call would always see the marker and never clear the repository
// variables below.
const ownsStateRoot = !process.env[ROOT_MARKER];
if (ownsStateRoot) {
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.GH_REPO;
}
// The temporary directory comes first, so the state root and the GitHub CLI
// guard root below are both created directly inside it.
const cleanTempRoot = ownsStateRoot ? installTempRoot() : null;
const cleanStateRoot = ownsStateRoot ? installStateRoot() : null;

async function installGhGuard(): Promise<void> {
  let guardRoot = process.env.IDD_TEST_GH_GUARD_ROOT;
  if (!guardRoot) {
    guardRoot = mkdtempSync(join(resolve(tmpdir()), 'idd-test-gh-guard-'));
    process.env.IDD_TEST_GH_GUARD_ROOT = guardRoot;
    process.env.IDD_TEST_GH_GUARD_LEDGER = join(guardRoot, 'attempts.jsonl');
    process.env.IDD_TEST_GH_GUARD_OWNER_PID = String(process.pid);
    process.env.IDD_TEST_GH_GUARD_ROOT_OWNER_PID = String(process.pid);
  }
  const guardImport = new URL('./isolate-gh.mts', import.meta.url).href;
  process.env.IDD_TEST_GH_GUARD_IMPORT = guardImport;
  process.env.NODE_OPTIONS = nodeOptions.appendNodeOptionsPreload(
    process.env.NODE_OPTIONS ?? '',
    '--import',
    guardImport,
    process.cwd(),
    ['--import'],
  );
  await import(guardImport);
}

await installGhGuard();
// Exit listeners run in registration order: the GitHub CLI guard reads its
// ledger first, then the state root is scanned, then the temporary directory.
if (cleanStateRoot) process.on('exit', cleanStateRoot);
if (cleanTempRoot) process.on('exit', cleanTempRoot);
