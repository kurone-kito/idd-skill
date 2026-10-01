import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  type RmOptions,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { setGithubApiLoadControlForTests } from '../src/scripts/gh-exec.mts';
import type { ReviewThreadNode } from '../src/scripts/resolve-review-thread.mts';

/**
 * A git-config-file-safe null-device path. `node:os`'s `devNull` is the
 * Win32 device-namespace form (`\\.\nul`) on win32, which Git for Windows
 * cannot open as a `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/
 * `GIT_CONFIG_VALUE_0` value (`fatal: unable to access '//./nul': Invalid
 * argument`); the bare `'NUL'` device name is the form git itself accepts
 * there. POSIX is unaffected -- `devNull` there is already `/dev/null`.
 * See kurone-kito/idd-skill#2570.
 */
const GIT_NULL_DEVICE = process.platform === 'win32' ? 'NUL' : devNull;

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYNC_DOCS_SCRIPT = join(REPO_ROOT, 'scripts/sync-docs.mjs');
// sync-docs.mjs imports the shared banner/helper module, which in turn imports
// policy-helpers (which in turn imports provider-contract) and, since #3310's
// liteGateParity check reuses githubHeadingSlug, markdown-link-audit too (which
// itself imports markdown-code, per #3417's markdown-code.mts extraction); the
// hermetic fixture must carry that whole import closure so the copied script
// resolves its siblings under the temp scripts/ dir.
const SYNC_DOCS_DEPS = [
  'consistency-helpers.mjs',
  'markdown-code.mjs',
  'markdown-link-audit.mjs',
  'node-runtime-guard.mjs',
  'policy-helpers.mjs',
  'provider-contract.mjs',
];

/**
 * Stubs an executable named `name` on `PATH` for the rest of the current
 * process and returns a cleanup callback that restores the prior `PATH`
 * (and, on Windows, `NODE_OPTIONS`) and removes the temp directory this
 * call created -- callers must invoke it, ideally in a `finally`, even when
 * the test body throws. `scriptBody` is raw Node.js
 * source run once per invocation of the stub; it sees the real CLI
 * arguments via `process.argv.slice(2)`, the same shape on every platform.
 *
 * POSIX: writes a `#!/bin/sh` wrapper that `exec`s `process.execPath`
 * (quoted, so a space in that path is safe) against `scriptBody` in its own
 * file, rather than `#!/usr/bin/env node` (would fail to resolve `node` once
 * `PATH` is stubbed down to just this temp dir, e.g. an originally-unset
 * `PATH`) or naming `process.execPath` directly in the shebang line itself
 * (a shebang's interpreter path splits on the first whitespace with no
 * quoting support) -- then prepends that temp dir to `PATH`.
 *
 * Windows: a shebang-only extensionless file is never resolved by
 * `execFileSync(name, ...)` without `shell: true` -- verified empirically,
 * Win32's `CreateProcess` (what a non-shell spawn ultimately calls) only
 * auto-appends `.exe` to an extension-less command name, never consulting
 * `PATHEXT` the way `cmd.exe` does, so a `.cmd`/`.bat` launcher is
 * unreachable from the plain `execFileSync('gh', ...)` calls under test.
 * Instead this hard-links (falling back to a copy across a cross-device
 * temp dir) the running `node.exe` itself to `<tempRoot>/<name>.exe`:
 * Windows identifies an executable purely by its PE contents, so a copy of
 * `node.exe` named `gh.exe` IS a genuine, directly launchable `gh.exe`.
 * Its startup is redirected via `NODE_OPTIONS=--require <preload>`, a
 * preload script that runs `scriptBody` *only* when the launched binary's
 * own basename matches this stub's -- `NODE_OPTIONS` is inherited by every
 * child Node process sharing this env, including a spawned CLI-under-test
 * in the smoke tests, so that gate is what keeps the preload a no-op
 * everywhere except the one process actually launched as `<name>.exe`.
 * `process.argv` is normalized to the POSIX shape
 * (`[execPath, '<stub>', ...args]`) before `scriptBody` runs, so
 * `process.argv.slice(2)` matches on both platforms; the main-module load
 * Node would otherwise attempt next is suppressed via a `Module._load`
 * override rather than an explicit `process.exit()`, so `scriptBody`'s own
 * pending async work (timers, a `process.stdin` listener) still runs to
 * completion before the process exits naturally, exactly as it would on
 * POSIX.
 *
 * All temp-file setup (`writeFileSync`/`chmodSync`/`linkSync`/
 * `copyFileSync`) runs and is fully committed before `PATH` (or, on
 * Windows, `NODE_OPTIONS`) is ever mutated -- a setup failure (e.g. a full
 * or read-only temp filesystem) removes `tempRoot` and rethrows without
 * touching either variable, so a caller whose `try { ... } finally {
 * restore(); }` never runs (this function threw before returning `restore`)
 * cannot leave a corrupted `PATH`/`NODE_OPTIONS` for later tests in the
 * same process (Copilot review, PR #2575).
 */
export function stubExecutable(name: string, scriptBody: string): () => void {
  const tempRoot = mkdtempSync(join(tmpdir(), `idd-stub-${name}-`));
  const preloadPath = join(tempRoot, 'preload.cjs');
  try {
    if (process.platform !== 'win32') {
      const scriptPath = join(tempRoot, name);
      const bodyPath = join(tempRoot, `${name}.body.js`);
      writeFileSync(bodyPath, scriptBody);
      // A shebang line splits its interpreter path at the first whitespace
      // with no quoting support, so naming `process.execPath` there
      // directly (as an earlier version of this fix did) breaks the moment
      // that path contains a space -- a real possibility (e.g. an install
      // directory with a space in its name). `/bin/sh` is a fixed,
      // space-free path on every POSIX system, and a normal shell command
      // line, unlike a shebang line, supports standard "$var" quoting, so
      // exec the real interpreter from there instead of naming it in the
      // shebang itself. `process.argv` inside `scriptBody` still comes out
      // as `[execPath, bodyPath, ...args]` -- the same shape `slice(2)`
      // expects -- since `bodyPath` is what's actually passed to node as
      // its entry script.
      writeFileSync(
        scriptPath,
        `#!/bin/sh\nexec "${process.execPath}" "${bodyPath}" "$@"\n`,
      );
      chmodSync(scriptPath, 0o755);
    } else {
      const exePath = join(tempRoot, `${name}.exe`);
      try {
        linkSync(process.execPath, exePath);
      } catch {
        copyFileSync(process.execPath, exePath);
      }
      writeFileSync(preloadPath, buildStubPreloadSource(name, scriptBody));
    }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }

  const originalPath = process.env.PATH;
  process.env.PATH = originalPath
    ? `${tempRoot}${delimiter}${originalPath}`
    : tempRoot;
  // A stubbed `gh` stands in for the real one, so a real token in the
  // environment must not steer a helper under test into treating it as an
  // identified caller: with the repository config enabling the Discover hint
  // cache (#3588), that would store a hint keyed only by the stub's canned
  // answers and let a later test read it back.
  const scrubbedTokens = name === 'gh' ? scrubGitHubTokenEnv() : null;
  // Likewise keep the load-control state of a stubbed `gh` run out of the real
  // per-user directory (#3702). The directory lives under `tempRoot`, so the
  // stub's own removal below deletes it.
  const redirectedState =
    name === 'gh' ? redirectLoadControlStateEnv(join(tempRoot, 'state')) : null;
  const restorePath = () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    scrubbedTokens?.();
    redirectedState?.();
  };
  if (process.platform !== 'win32') {
    return () => {
      restorePath();
      rmSync(tempRoot, { recursive: true, force: true });
    };
  }
  const originalNodeOptions = process.env.NODE_OPTIONS;
  const requireFlag = `--require "${preloadPath.replaceAll('\\', '/')}"`;
  process.env.NODE_OPTIONS = originalNodeOptions
    ? `${originalNodeOptions} ${requireFlag}`
    : requireFlag;
  return () => {
    restorePath();
    if (originalNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = originalNodeOptions;
    }
    // A caller that just killed a process launched from this stub (e.g.
    // idd-critique-telemetry-hook's win32 tree-kill, now a fire-and-forget
    // `taskkill`/`powershell.exe` spawn rather than a synchronous signal)
    // can reach this `restore()` slightly before Windows has actually
    // finished tearing down the `<name>.exe` image this directory holds --
    // NTFS refuses to delete a still-open executable (EBUSY/EPERM), which
    // `force: true` alone does not swallow (only ENOENT).
    // `removeStubDirectory` absorbs that window instead of failing the whole
    // test on a cleanup race unrelated to what the test itself is asserting
    // (kurone-kito/idd-skill#2892, #3680).
    removeStubDirectory(tempRoot);
  };
}

/** Polling calls `removeStubDirectory` makes after its first removal failed. */
export const STUB_REMOVAL_POLL_COUNT = 20;

/** Pause, in milliseconds, before each `removeStubDirectory` polling call. */
export const STUB_REMOVAL_POLL_INTERVAL_MS = 250;

/** Injectable collaborators of {@link removeStubDirectory}. */
export interface RemoveStubDirectoryOptions {
  /** Removal function; defaults to `rmSync`. */
  readonly remove?: (path: string, options: RmOptions) => void;
  /** Platform name; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /** Receives the single warning for a directory that could not be removed. */
  readonly warn?: (message: string) => void;
  /** Blocking pause; defaults to an `Atomics.wait` on a private buffer. */
  readonly sleep?: (milliseconds: number) => void;
  /** Pause before each polling call; defaults to the exported constant. */
  readonly pollIntervalMs?: number;
}

/** Whether `error` is a failure a still-running Windows image can cause. */
function isTransientRemovalError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === 'EPERM' || code === 'EBUSY';
}

/**
 * Remove a `stubExecutable` temp directory, tolerating a Windows image that
 * is still being torn down (kurone-kito/idd-skill#3680).
 *
 * The first attempt keeps the native retry (`maxRetries: 5` with
 * `retryDelay: 100`, six attempts spread over about 1.5 seconds). Only on
 * win32, and only when that fails with `EPERM` or `EBUSY`, up to
 * {@link STUB_REMOVAL_POLL_COUNT} polling calls follow, each after one
 * blocking `sleep`, each with `maxRetries: 0` and `retryDelay: 0` so the
 * sleep is the only pause. A directory that is still there after the last
 * call produces one warning naming it, and the function returns: the test's
 * own assertions have already decided its verdict, and a leftover directory
 * on an ephemeral runner is harmless. Every other error, and every failure
 * on another platform, is thrown unchanged. That includes `ENOTEMPTY` from a
 * delete-pending file (all observed failures were `EPERM`).
 *
 * `EBUSY` is precautionary: Node 24's native `rmSync` reports a persistent
 * `EBUSY` as an unknown error, so it only matters on Node 22. The wait blocks
 * because `restore` is synchronous, which also starves the event loop, so
 * only progress made by the operating system can free the directory.
 */
export function removeStubDirectory(
  directory: string,
  options: RemoveStubDirectoryOptions = {},
): void {
  const remove = options.remove ?? rmSync;
  const platform = options.platform ?? process.platform;
  const warn =
    options.warn ?? ((message) => void process.stderr.write(`${message}\n`));
  const sleep = options.sleep ?? blockingSleep;
  const pollIntervalMs =
    options.pollIntervalMs ?? STUB_REMOVAL_POLL_INTERVAL_MS;
  let lastError: unknown;
  try {
    remove(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
    return;
  } catch (error) {
    if (platform !== 'win32' || !isTransientRemovalError(error)) {
      throw error;
    }
    lastError = error;
  }
  for (let poll = 0; poll < STUB_REMOVAL_POLL_COUNT; poll += 1) {
    sleep(pollIntervalMs);
    try {
      remove(directory, {
        recursive: true,
        force: true,
        maxRetries: 0,
        retryDelay: 0,
      });
      return;
    } catch (error) {
      if (!isTransientRemovalError(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  const { code, message } = lastError as NodeJS.ErrnoException;
  warn(
    `stubExecutable: left ${directory} behind after ${STUB_REMOVAL_POLL_COUNT} polling removals (${code}: ${message})`,
  );
}

/** Block the thread for `milliseconds` without spinning. */
function blockingSleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const GITHUB_TOKEN_ENV_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

/**
 * Pin the load-control runtime policy to "off" for the calling test or file
 * (#3702). This repository's own config enables load control, which adds
 * `--include` to a non-paginated `ghApiJson` call and one `gh auth` identity
 * lookup per process, so a test that asserts the exact `gh` argv, call counts
 * or record counts of a wrapper would otherwise depend on that config. The
 * load-control path itself is covered in `gh-exec-load-control.test.mts`.
 * The result resumes reading the working directory's config.
 */
export function pinLoadControlOff(): () => void {
  setGithubApiLoadControlForTests({
    policy: { enabled: false, maxConcurrent: 1, maxWaitMs: 0 },
  });
  return () => setGithubApiLoadControlForTests(null);
}

/**
 * The variables the host-local load-control state directory is resolved from
 * (`XDG_STATE_HOME`, or `LOCALAPPDATA` on Windows; issue #3586).
 */
const LOAD_CONTROL_STATE_ENV_NAMES = [
  'XDG_STATE_HOME',
  'LOCALAPPDATA',
] as const;

/**
 * Point the load-control state root at `stateRoot` for as long as a `gh` stub
 * is active (#3702). With this repository's config enabling load control, a
 * helper run against a stubbed `gh` would otherwise write lease and cooldown
 * files into the real per-user directory that every concurrent session shares.
 * The value is set unconditionally, so a root the caller already exported (for
 * example one the acceptance run sets to an empty directory) is overridden
 * rather than polluted. The result restores each variable only while it still
 * holds `stateRoot`: a test that assigns its own value after stubbing keeps it.
 */
function redirectLoadControlStateEnv(stateRoot: string): () => void {
  const saved = LOAD_CONTROL_STATE_ENV_NAMES.map(
    (key) => [key, process.env[key]] as const,
  );
  for (const key of LOAD_CONTROL_STATE_ENV_NAMES) process.env[key] = stateRoot;
  return () => {
    for (const [key, value] of saved) {
      if (process.env[key] !== stateRoot) continue;
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Remove GitHub token variables from `process.env`; the result restores them. */
function scrubGitHubTokenEnv(): () => void {
  const saved = GITHUB_TOKEN_ENV_NAMES.map(
    (key) => [key, process.env[key]] as const,
  );
  for (const key of GITHUB_TOKEN_ENV_NAMES) delete process.env[key];
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/** Builds the Windows preload script `stubExecutable` writes into `tempRoot`. */
function buildStubPreloadSource(name: string, scriptBody: string): string {
  return [
    // Gate on the exe's own basename rather than a full-path compare: any
    // node process launched as `<name>.exe` is this stub by construction
    // (the real `gh.exe` is not a node binary and never honors
    // `NODE_OPTIONS`), and matching only the basename sidesteps 8.3
    // short-path spellings (e.g. `RUNNER~1`) a CI runner could expose for
    // the same directory.
    `const expectedBasename = ${JSON.stringify(`${name}.exe`.toLowerCase())};`,
    "const nodePath = require('node:path');",
    'if (nodePath.basename(process.execPath).toLowerCase() === expectedBasename) {',
    // Node's own bootstrap resolves argv[1] against cwd before this
    // preload runs (treating it as a candidate main-module path even
    // though the process exits before ever loading one), so a plain
    // subcommand-style first argument such as `repo` arrives here already
    // rewritten to `<cwd>\repo`. `path.relative` inverts that exact
    // `path.resolve(cwd, arg)` transform for the realistic domain of args
    // this repository's `gh` invocations use (bare words and flags, never
    // a `..`-escaping or already-absolute path), so recompute it before
    // reassembling the POSIX-shaped argv scriptBody expects. A first arg
    // that itself starts with `-` never reaches here at all -- Node's own
    // C++ option parser rejects an unrecognized leading flag before any
    // preload runs, so this stub cannot front a flag-shaped first
    // argument on Windows (undocumented upstream of this helper; no
    // affected call site in this repository uses one).
    '  const cwd = process.cwd();',
    '  const rawFirstArg = process.argv[1];',
    '  const firstArg = rawFirstArg === undefined',
    '    ? undefined',
    '    : rawFirstArg.toLowerCase().startsWith((cwd + nodePath.sep).toLowerCase())',
    '    ? nodePath.relative(cwd, rawFirstArg)',
    '    : rawFirstArg;',
    '  process.argv = firstArg === undefined',
    "    ? [process.argv[0], '<stub>']",
    "    : [process.argv[0], '<stub>', firstArg, ...process.argv.slice(2)];",
    // Node still tries to `require()` the (unreachable) main-module path
    // once this preload returns, regardless of any `process.argv[1]`
    // rewrite above -- it resolves and caches that path separately,
    // before preloads even run (empirically confirmed; reassigning
    // `process.argv` here does not redirect it). A bare `process.exit()`
    // after `scriptBody` would dodge that crash but also cut off any
    // pending async work `scriptBody` started (e.g. a `process.stdin`
    // `'data'`/`'end'` listener) before it ever fires, since the crash
    // would otherwise pre-empt those callbacks on the very next tick.
    // Special-casing the isMain load to a no-op instead lets the event
    // loop -- and any `scriptBody`-registered listeners or timers --
    // run to natural completion, then exit exactly the way a real POSIX
    // shebang script would, honoring `process.exitCode` (or an explicit
    // `process.exit()` `scriptBody` itself calls) either way.
    "  const nodeModule = require('node:module');",
    '  const originalLoad = nodeModule._load;',
    '  nodeModule._load = function (request, parent, isMain) {',
    '    if (isMain) return {};',
    '    return originalLoad.apply(this, arguments);',
    '  };',
    '  {',
    scriptBody,
    '  }',
    '}',
  ].join('\n');
}

/**
 * Reads and JSON-parses a repo-root-relative fixture or schema file. Left
 * without a return-type annotation so it infers the same permissive type
 * `JSON.parse` itself returns — matching every previously-untyped local
 * copy of this function without a call-site change; callers that want a
 * narrower shape cast the result (e.g. `readJson(path) as SnapshotFixture`).
 */
export function readJson(relativePath: string) {
  return JSON.parse(readText(relativePath));
}

/** Reads a repo-root-relative file as UTF-8 text. */
export function readText(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/** Collapses runs of whitespace to a single space and trims the ends. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Extracts the module specifier of every static `import` / `export … from`
 * declaration in `source` — including side-effect `import 'x'` and
 * `export * from 'x'` / `export { a } from 'x'` re-exports — plus every
 * dynamic `import('x')` call (with or without a second import-attributes
 * argument, e.g. `import('x', { with: { type: 'json' } })`, and whether the
 * specifier is quoted or written as a no-substitution template literal,
 * e.g. `` import(`x`) ``), while ignoring anything that appears only inside
 * a `//` or `/* … *\/`-style comment.
 *
 * The clause between the keyword and the specifier is restricted to the
 * characters an import/export clause can actually contain (identifiers,
 * commas, `*`, braces, whitespace). This is deliberately a *positive* class
 * rather than "anything but a quote or semicolon": a plain `export function
 * f(x) {` or `export const x = 'literal';` contains a `(` or `=` before any
 * quote, which this class excludes, so scanning stops there instead of
 * misreading an unrelated string literal deeper in the function body as an
 * import specifier.
 *
 * The dynamic-import pattern's template-literal branch excludes `$` from
 * the backtick-delimited content, which rejects `${…}` interpolation (an
 * expression, not a static specifier) while still matching every realistic
 * no-substitution specifier — no valid `node:` builtin, relative path, or
 * npm package name contains a literal `$`.
 */
export function extractImportSpecifiers(source: string): string[] {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const clause = '[A-Za-z0-9_$,\\s*{}]*?';
  const patterns = [
    new RegExp(
      `^[ \\t]*(?:import\\b${clause}(?:\\bfrom\\s+)?|export\\b${clause}\\bfrom\\s+)['"]([^'"]+)['"]`,
      'gm',
    ),
    // `\s*(?:,|\))` (not just `\s*\)`) so a dynamic import that passes a
    // second import-attributes argument — `import('x', {...})` — still
    // yields its specifier instead of being silently skipped. The
    // alternation's second branch accepts a no-substitution template
    // literal (backticks, no `$`) as well as a quoted string.
    /\bimport\s*\(\s*(?:['"]([^'"]+)['"]|`([^`$]*)`)\s*(?:,|\))/g,
  ];
  return patterns.flatMap((pattern) =>
    [...withoutComments.matchAll(pattern)]
      .map((match) => match[1] ?? match[2])
      .filter((specifier): specifier is string => specifier !== undefined),
  );
}

/**
 * Slices `text` between `startMarker` and `endMarker`, asserting both are
 * present (a missing end marker is a fixture bug, not an implicit EOF slice).
 */
export function extractSection(
  text: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `Missing section marker: ${startMarker}`);
  const end = text.indexOf(endMarker, start);
  assert.notEqual(end, -1, `Missing section marker: ${endMarker}`);
  return text.slice(start, end);
}

/**
 * Slices `text` from `startMarker` through the next top-level (`\n## `)
 * heading, or through EOF when `startMarker` opens the last section.
 */
export function extractTopLevelSection(
  text: string,
  fileLabel: string,
  startMarker: string,
): string {
  const nextSectionMarker = '\n## ';
  const start = text.indexOf(startMarker);
  assert.notEqual(
    start,
    -1,
    `${fileLabel} is missing section marker: ${startMarker}`,
  );
  const nextSectionStart = text.indexOf(
    nextSectionMarker,
    start + startMarker.length,
  );
  const end = nextSectionStart === -1 ? text.length : nextSectionStart;
  return text.slice(start, end).trim();
}

/** Creates a hermetic temp directory with write/cleanup helpers. */
export function makeRepo(): {
  root: string;
  cleanup: () => void;
  write: (relPath: string, content: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'workshop-integrity-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    write: (relPath: string, content: string) => {
      const full = join(root, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return full;
    },
  };
}

function writeScaffoldedFile(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * A sanitized environment for spawning `git` (or a script that itself
 * shells out to `git ls-files`) against a temp fixture repo. Deletes the
 * repo-location override variables (`GIT_DIR`, `GIT_INDEX_FILE`,
 * `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_OBJECT_DIRECTORY`) a caller
 * running inside a git hook may have exported -- which would otherwise
 * point the fixture's `git` invocations at the *host* repository instead
 * of the temp fixture despite `cwd` being set correctly -- and every
 * ambient `GIT_CONFIG*` variable, replacing them with a fixed
 * `GIT_CONFIG_COUNT`/`KEY`/`VALUE` triple that pins `core.excludesFile`
 * to the platform null device (`GIT_NULL_DEVICE`, not necessarily
 * `os.devNull` -- see its own doc comment) so an operator's personal
 * global ignore file can never drop fixture paths from `git ls-files
 * --exclude-standard`. Other `GIT_*` variables outside these two groups
 * are left untouched. Shared
 * by every suite that scaffolds a git-backed fixture (originally local
 * to `audit-docs-file-sets.test.mts`; lifted out for `sync-docs.test.mts`
 * too per #1703, so the sanitization logic itself has one copy).
 */
export function fixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG')) {
      delete env[key];
    }
  }
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  env.GIT_CONFIG_GLOBAL = GIT_NULL_DEVICE;
  env.GIT_CONFIG_SYSTEM = GIT_NULL_DEVICE;
  env.GIT_CONFIG_COUNT = '1';
  env.GIT_CONFIG_KEY_0 = 'core.excludesFile';
  env.GIT_CONFIG_VALUE_0 = GIT_NULL_DEVICE;
  return env;
}

/** Result of {@link spawnHelperBinWithEnvelope}. */
export interface HelperBinEnvelopeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Parsed `{"iddHelperError": {...}}` JSON envelope, the last non-empty
   * stderr line -- `null` when absent or unparseable. */
  envelope: { kind: string; exitCode: number; message: string } | null;
}

/**
 * Spawn a packaged `bin/<binName>` helper with
 * `IDD_HELPER_ERROR_ENVELOPE=1` set, parse its trailing stderr envelope
 * line, and return both the raw process result and the parsed envelope
 * (#3551 Codex review: a usage error returned as a bare exit-code number
 * misclassifies as `kind: "gate"` under the opt-in envelope instead of
 * `"usage"` -- this helper lets each CLI's own test file assert the
 * correct classification without re-deriving the spawn/parse boilerplate
 * `helper-cli-gate-envelope.test.mts` and `helper-cli-contract.test.mts`
 * each already carry their own copy of).
 */
export function spawnHelperBinWithEnvelope(
  binName: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): HelperBinEnvelopeResult {
  const env = fixtureEnv();
  env.IDD_HELPER_ERROR_ENVELOPE = '1';
  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'bin', binName), ...args],
    {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 20_000,
      killSignal: 'SIGKILL',
    },
  );
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  let envelope: HelperBinEnvelopeResult['envelope'] = null;
  const lines = stderr.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === '') {
      continue;
    }
    if (line.startsWith('{"iddHelperError":')) {
      try {
        envelope = (
          JSON.parse(line) as {
            iddHelperError: NonNullable<HelperBinEnvelopeResult['envelope']>;
          }
        ).iddHelperError;
      } catch {
        envelope = null;
      }
    }
    break;
  }
  return { status: result.status, stdout, stderr, envelope };
}

/**
 * Builds a self-contained sync-docs fixture repo: `package.json` (so
 * `resolveRepoRoot` stops here), a copy of the real `sync-docs.mjs` under
 * `scripts/` plus its import closure, the fixture manifest, and any
 * referenced source/target files. `register` is called with a cleanup
 * callback (e.g. `(cleanup) => t.after(cleanup)`). Git-initializes the
 * fixture (sanitized via `fixtureEnv()`) so a `sourceGlobs` block can
 * resolve through `sync-docs.mjs`'s own `git ls-files` call (#1703).
 */
export function makeScaffoldedSyncRepo(
  register: (cleanup: () => void) => void,
  manifest: unknown,
  files: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-docs-'));
  register(() => rmSync(dir, { recursive: true, force: true }));

  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  writeScaffoldedFile(dir, 'package.json', '{}\n');
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(SYNC_DOCS_SCRIPT, join(dir, 'scripts', 'sync-docs.mjs'));
  for (const dep of SYNC_DOCS_DEPS) {
    cpSync(join(REPO_ROOT, 'scripts', dep), join(dir, 'scripts', dep));
  }
  writeScaffoldedFile(
    dir,
    'audit/sync-manifest.json',
    JSON.stringify(manifest, null, 2),
  );

  for (const [rel, content] of Object.entries(files)) {
    writeScaffoldedFile(dir, rel, content);
  }
  return dir;
}

/** Result of {@link runImportOnlyProbe}. */
export interface ImportOnlyProbeResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Dynamically `import()`s `scriptPath` (an absolute path to a built `.mjs`
 * CLI entrypoint) from a standalone child process, run with `cwd` as its
 * working directory. Used to regression-test the `if (import.meta.main)`
 * guard (#3190): a module without the guard runs its CLI as a side effect
 * of the import -- parsing `process.argv`, calling `process.exit`, or (for
 * a write-capable CLI) writing a file -- before this probe's own `.then()`
 * ever runs. `IMPORT_OK` missing from `stdout` reliably proves an unguarded
 * CLI's own `process.exit` fired first (whether that call used a zero or
 * non-zero code), since a guarded module always reaches `.then()` and
 * always prints it. `IMPORT_OK`'s *presence* alone is not sufficient to
 * rule out every side effect, though: an unguarded CLI branch that
 * completes without ever calling `process.exit` (for example a
 * write-then-fall-off-the-end success path) can still perform its side
 * effect and then reach `.then()` normally -- a caller that needs to rule
 * that out, such as the `--apply`-shaped-argv scenario below, must also
 * assert the concrete side effect directly (e.g. the target file's
 * content), not rely on `IMPORT_OK` alone.
 *
 * `extraArgv` (default none) becomes the *importing process's own*
 * `process.argv.slice(2)` -- the exact slice every guarded CLI in this
 * repository (including audit-docs.mts/sync-docs.mts) parses its own flags
 * from -- so a caller can reproduce the sharper risk #3190's issue body
 * describes: an importer whose own argv happens to look `--apply`-shaped
 * for a reason unrelated to the imported module, which an unguarded module
 * would have honored as if it were its own CLI invocation.
 */
export function runImportOnlyProbe(
  scriptPath: string,
  cwd: string,
  extraArgv: string[] = [],
): ImportOnlyProbeResult {
  const moduleUrl = pathToFileURL(scriptPath).href;
  const probe = [
    `import(${JSON.stringify(moduleUrl)})`,
    "  .then(() => { process.stdout.write('IMPORT_OK\\n'); })",
    '  .catch((error) => {',
    '    process.stderr.write(',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text for the spawned child process's own template literal, not a forgotten placeholder here.
    '      `IMPORT_ERR: ${error && error.stack ? error.stack : error}\\n`,',
    '    );',
    '    process.exitCode = 1;',
    '  });',
  ].join('\n');
  // `-e` has no real script-path argv[1] slot of its own; Node fills it in
  // from the first token after `--` regardless, so a placeholder is needed
  // to push any caller-supplied `extraArgv` out to `process.argv.slice(2)`
  // (empirically verified: `node -e '...' -- placeholder --apply` yields
  // `process.argv` = `[execPath, 'placeholder', '--apply']`).
  const execArgs = [
    '--input-type=module',
    '-e',
    probe,
    ...(extraArgv.length > 0 ? ['--', 'argv-placeholder', ...extraArgv] : []),
  ];
  try {
    const stdout = execFileSync(process.execPath, execArgs, {
      cwd,
      env: fixtureEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      status: typeof e.status === 'number' ? e.status : 1,
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : '',
    };
  }
}

/** Builds a merged-pr-feedback-sweep review-thread fixture. */
export function buildCommentThread(
  isResolved: boolean,
  comments: {
    login: string;
    body: string;
    createdAt: string;
    url?: string;
    /** #3249: defaults to `null` (genuinely unedited) -- pass an ISO
     * timestamp to build an edited-comment fixture instead. */
    lastEditedAt?: string | null;
  }[],
  path = 'src/x.mts',
) {
  return {
    isResolved,
    path,
    comments: {
      nodes: comments.map((c) => ({
        body: c.body,
        url: c.url ?? 'https://example/thread',
        createdAt: c.createdAt,
        author: { login: c.login },
        lastEditedAt: c.lastEditedAt === undefined ? null : c.lastEditedAt,
      })),
    },
  };
}

/** Builds a resolve-review-thread GraphQL review-thread-node fixture. */
export function buildReviewThreadNode(
  id: string,
  isResolved: boolean,
  commentDatabaseIds: number[],
): ReviewThreadNode {
  return {
    id,
    isResolved,
    comments: {
      nodes: commentDatabaseIds.map((databaseId) => ({ databaseId })),
    },
  };
}
