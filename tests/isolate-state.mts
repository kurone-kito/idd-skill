/**
 * Preload for the whole test suite (issue #3725). Run it as
 * `node --test --import ./tests/isolate-state.mts tests/*.test.mts`: the
 * runner process does not evaluate the preload; it forwards `--import` to one
 * child process per test file and each child loads it, so every file gets its
 * own throwaway per-user state root and GitHub CLI attempt ledger.
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
 * the listener does not run when the process is killed by a signal (the
 * throwaway directory is then left behind) and misses a detached grandchild
 * that writes after the process exits; a `Worker` given its own `env` gets its
 * own throwaway state root, and its state leak report goes to stderr without
 * changing the main thread's exit code, while the GitHub CLI guard carries
 * its ledger into that Worker; on macOS the read-cache default under
 * `~/Library/Caches` ignores `XDG_CACHE_HOME`; the state-root behavior on
 * Windows is unverified.
 *
 * This preload and its local GitHub guard modules import only `node:`
 * builtins: the `lint` workflow runs the suite with no package install.
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

const ROOT_MARKER = 'IDD_TEST_STATE_ROOT';
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

absolutizeRelativeImports(process.execArgv);
const cleanStateRoot = process.env[ROOT_MARKER] ? null : installStateRoot();

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
if (cleanStateRoot) process.on('exit', cleanStateRoot);
