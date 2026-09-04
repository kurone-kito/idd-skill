import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// policy-helpers, which in turn imports provider-contract; the hermetic
// fixture must carry that whole import closure so the copied script resolves
// its siblings under the temp scripts/ dir.
const SYNC_DOCS_DEPS = [
  'consistency-helpers.mjs',
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
 * POSIX: writes an executable shebang script naming the running
 * `process.execPath` directly (not `#!/usr/bin/env node`) so the stub still
 * resolves its own interpreter when `PATH` is stubbed down to just this
 * temp dir (an originally-unset `PATH`, for example) and no longer has
 * anywhere else to find `node` -- then prepends that temp dir to `PATH`.
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
      writeFileSync(scriptPath, `#!${process.execPath}\n${scriptBody}`);
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
  const restorePath = () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
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
    rmSync(tempRoot, { recursive: true, force: true });
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

/** Builds a merged-pr-feedback-sweep review-thread fixture. */
export function buildCommentThread(
  isResolved: boolean,
  comments: { login: string; body: string; createdAt: string; url?: string }[],
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
