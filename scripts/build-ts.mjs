#!/usr/bin/env node
// idd-generated-from: src/scripts/build-ts.mts
//
// The scripts/build-ts.mjs copy is generated from the .mts source named
// above by `pnpm run build`. Edit the .mts source, never the generated
// .mjs. See docs/typescript-sources.md.
//
// Build the generated .mjs helper artifacts from the TypeScript sources.
//
// Emits with `tsc -p tsconfig.build.json --listEmittedFiles`, then
// normalizes ONLY the files tsc just emitted with Biome. Scoping the Biome
// pass to tsc's own emitted set — rather than every scripts/*.mjs or
// bin/*.mjs on disk — keeps `pnpm run build` from touching a file tsc did
// not just produce, such as a local file not yet registered with a .mts
// source (tests/inventory-ordering.test.mts rejects that before merge).
//
// After emitting, it also rewrites the `.gitattributes`
// `scripts/*.mjs linguist-generated=true` block so it lists exactly the
// generated set — the same banner-keyed set tests/inventory-ordering.test.mts
// guards — instead of relying on a hand-edit that today only surfaces as an
// `inventory-ordering` CI failure plus an extra commit. See #1180.
//
// Bootstrap note: this file is itself one of the emitted artifacts. The
// committed scripts/build-ts.mjs runs the build that regenerates it, and
// `pnpm run build:check` fails on drift exactly as for any other
// artifact.
//
// Invoked via `pnpm run build`, so node_modules/.bin (tsc, biome) is on
// PATH. Uses only node: builtins to stay compatible with the repository's
// bare-node boundary.
//
// tsc/biome are invoked by resolving their package's own `bin` entry and
// running it directly through `process.execPath`, rather than by
// `execFileSync('tsc' | 'biome', ...)`. On Windows, node_modules/.bin/tsc
// and node_modules/.bin/biome are `.CMD`/`.ps1` shims, not directly
// executable files, and `execFileSync`/`spawnSync` without `shell: true`
// skip `PATHEXT` resolution, so the plain-name form fails with ENOENT there
// even though the shim is genuinely on PATH. Adding `shell: true` fixes
// that, but reintroduces a Windows `cmd.exe` command-line length cap
// (~8191 characters) that the Biome call below can exceed once the
// emitted-file list grows — resolving the real JS entry point sidesteps
// both: no PATH/PATHEXT lookup, and no shell to cap the command line. Every
// platform's own `.bin` shim (`.CMD` on Windows, the POSIX shebang script
// elsewhere) ultimately runs the exact same resolved script through node,
// so this reproduces their behavior identically instead of bypassing it.
//
// resolveBinScript() below must stay called from inside a function body
// (runTsc, normalizeWithBiome), never at module top-level:
// tests/build-ts.test.mts imports this module for the dependency-free
// rewriteGitattributesBlock() below, and lint.yml's
// toolless bare-node CI lane runs that test with NO package-manager
// install at all (no node_modules), so merely importing this file must
// not require `typescript`/`@biomejs/biome` to be resolvable.
//
// The tsc emit and the Biome normalization are exported (runTsc,
// normalizeWithBiome) so src/scripts/check-build-artifacts.mts can run the
// very same steps into a temporary directory and compare the result with
// HEAD instead of rewriting the checkout. Both go through an injectable
// ProcessRunner so tests can assert the exact invocation shape: always
// `process.execPath` plus a resolved JS entry point, never a shell.
// #3240: side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. Direct import: this file does not reach cli-args.mts.
// Dependency-free (node: builtins only), matching the bare-node import
// requirement above. See node-runtime-guard.mts.
import './node-runtime-guard.mjs';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
/**
 * Resolve an installed package's own `bin` entry to an absolute script
 * path, bypassing the node_modules/.bin platform shim entirely. See the
 * file header for why this replaces a plain `execFileSync('tsc' | 'biome', ...)`
 * call, and why every call to this function must stay inside a function
 * body, never at module top-level.
 */
export const resolveBinScript = (packageName, binName) => {
  const packageJsonPath = require.resolve(`${packageName}/package.json`);
  const { bin } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const relativePath = typeof bin === 'string' ? bin : bin?.[binName];
  if (!relativePath) {
    throw new Error(
      `${packageName}: package.json has no "${binName}" bin entry`,
    );
  }
  return join(dirname(packageJsonPath), relativePath);
};
// The committed artifacts alone are ~6 MB and `git cat-file --batch` returns
// all of them on one stream, far above spawnSync's 1 MiB default
// (ENOBUFS kills the child). Every call here reads only local tool output,
// so a generous explicit ceiling is safe.
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
/** The real runner: no shell, so no PATHEXT lookup and no command-line cap. */
export const spawnRunner = (command, args, options) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    input: options.input,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return {
    error: result.error,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? Buffer.alloc(0),
    stdout: result.stdout ?? Buffer.alloc(0),
  };
};
/** A failed build or verification step, with the tool output attached. */
export class StageError extends Error {
  output;
  stage;
  constructor(stage, message, output = '') {
    super(message);
    this.name = 'StageError';
    this.output = output;
    this.stage = stage;
  }
}
/**
 * Throw a StageError unless the child ran and exited 0 — the contract
 * `execFileSync` used to provide (it threw on a spawn error, a signal, and a
 * non-zero status). tsc writes its diagnostics to stdout, so both streams
 * go into the error.
 */
export function assertSucceeded(stage, label, result) {
  if (result.error) {
    throw new StageError(
      stage,
      `${label}: failed to start: ${result.error.message}`,
    );
  }
  if (result.signal !== null) {
    throw new StageError(stage, `${label}: killed by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new StageError(
      stage,
      `${label}: exited ${result.status}`,
      `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`,
    );
  }
}
const EMITTED_PREFIX = 'TSFILE: ';
// The provenance header every emitted artifact carries; a helper with no
// `.mts` source of its own would not. Kept identical to the
// `idd-generated-from` scan in tests/inventory-ordering.test.mts so the build
// and that test always agree on the generated set.
const GENERATED_MARKER = 'idd-generated-from';
const GENERATED_MARKER_SCAN_BYTES = 200;
// Only the top-level scripts/*.mjs block is auto-maintained here. The
// idd-template/scripts/* entry and the bin/**/*.mjs directory glob in
// .gitattributes are left untouched — the inventory-ordering completeness
// guard is likewise scoped to scripts/*.mjs.
export const GITATTRIBUTES_PATH = '.gitattributes';
const SCRIPTS_DIR = 'scripts';
const SCRIPT_ATTRIBUTE_PATTERN =
  /^scripts\/[^/]+\.mjs linguist-generated=true$/;
/** The linguist-generated attribute line for a top-level scripts/*.mjs name. */
function scriptAttributeLine(name) {
  return `scripts/${name} linguist-generated=true`;
}
/**
 * The generated scripts/*.mjs set, derived exactly as
 * tests/inventory-ordering.test.mts derives it: a top-level scripts/*.mjs whose
 * first `GENERATED_MARKER_SCAN_BYTES` bytes carry the generated-from banner,
 * ascending string-sorted. Deriving it the same way — rather than from
 * `tsc --listEmittedFiles` — is what keeps a fresh build's .gitattributes green
 * under that test's completeness check even if a stale generated .mjs lingers.
 *
 * The window is measured in UTF-8 bytes, not JS string length (UTF-16 code
 * units) -- a naive `.slice(0, GENERATED_MARKER_SCAN_BYTES)` would let a
 * multibyte prefix push the banner past the true byte boundary while still
 * matching, same class of gap as `audit-docs.mts`'s
 * `collectGeneratedSourceBannerViolations` fixed for the same reason
 * (review finding on kurone-kito/idd-skill#3294's own PR #3333).
 */
export function generatedScriptNames(scriptsDir) {
  return readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.mjs'))
    .filter((name) => {
      const text = readFileSync(`${scriptsDir}/${name}`, 'utf8');
      const scanned = Buffer.from(text, 'utf8')
        .subarray(0, GENERATED_MARKER_SCAN_BYTES)
        .toString('utf8');
      return scanned.includes(GENERATED_MARKER);
    })
    .sort();
}
/**
 * Rewrite the scripts/*.mjs linguist-generated block of a .gitattributes body
 * so it lists exactly `names` (assumed already sorted) in place, leaving every
 * other line — the header comment, the idd-template entry, the bin glob, the
 * binary/export-ignore rules — byte identical. Pure: returns the new body.
 * Throws if no block is present so a silently vanished block cannot slip by.
 */
export function rewriteGitattributesBlock(original, names) {
  const lines = original.split('\n');
  const firstBlockIndex = lines.findIndex((line) =>
    SCRIPT_ATTRIBUTE_PATTERN.test(line),
  );
  if (firstBlockIndex < 0) {
    throw new Error(
      `${GITATTRIBUTES_PATH}: no scripts/*.mjs linguist-generated block found`,
    );
  }
  // Drop every existing block line, then splice the regenerated block back in
  // at the first block line's slot. Every line before firstBlockIndex is a
  // non-block line (firstBlockIndex is the FIRST match), so it survives the
  // filter at the same index — firstBlockIndex is the correct insertion slot.
  const withoutBlock = lines.filter(
    (line) => !SCRIPT_ATTRIBUTE_PATTERN.test(line),
  );
  withoutBlock.splice(firstBlockIndex, 0, ...names.map(scriptAttributeLine));
  return withoutBlock.join('\n');
}
/**
 * Rewrite .gitattributes on disk to match the generated scripts set, writing
 * only when the body changes so `pnpm run build` stays idempotent.
 */
function syncGitattributes(root) {
  const attributesPath = join(root, GITATTRIBUTES_PATH);
  const original = readFileSync(attributesPath, 'utf8');
  const updated = rewriteGitattributesBlock(
    original,
    generatedScriptNames(join(root, SCRIPTS_DIR)),
  );
  if (updated !== original) {
    writeFileSync(attributesPath, updated);
  }
}
/**
 * Emit the .mjs artifacts with tsc and return its `--listEmittedFiles`
 * output. With `outDir` the emit is redirected there (`rootDir: src` keeps
 * the `scripts/` and `bin/` layout beneath it) and nothing in `root` is
 * written; without it tsc writes into the project's own `outDir` ("."), as
 * `pnpm run build` does.
 */
export function runTsc(root, options = {}) {
  const { outDir, resolveBin = resolveBinScript, run = spawnRunner } = options;
  const args = [
    resolveBin('typescript', 'tsc'),
    '-p',
    'tsconfig.build.json',
    '--listEmittedFiles',
  ];
  if (outDir !== undefined) {
    args.push('--outDir', outDir);
  }
  const result = run(process.execPath, args, { cwd: root });
  assertSucceeded('tsc', 'tsc emit', result);
  return result.stdout.toString('utf8');
}
/** The `.mjs` files named by tsc's `--listEmittedFiles` output. */
export function parseEmittedFiles(tscOutput) {
  return tscOutput
    .split(/\r?\n/)
    .filter((line) => line.startsWith(EMITTED_PREFIX))
    .map((line) => line.slice(EMITTED_PREFIX.length).trim())
    .filter((file) => file.endsWith('.mjs'));
}
// One Biome call carries at most this many characters of file arguments. A
// native Windows process line is capped near 32 767 characters even without a
// shell, and each argument may gain quotes, so this stays far below it while
// the emitted-file list keeps growing.
const BIOME_ARGV_CHARACTER_BUDGET = 8_000;
/**
 * Split `items` into consecutive chunks whose combined length, counting a
 * separator and possible quotes per item, stays within `budget`. An item
 * larger than the budget still gets a chunk of its own.
 */
export function chunkByArgumentLength(
  items,
  budget = BIOME_ARGV_CHARACTER_BUDGET,
) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const cost = item.length + 3;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += cost;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
/**
 * Biome-normalize exactly `files` (never a directory): `build` must not touch
 * a file tsc did not just produce. Biome runs with `root` as its working
 * directory so the project's own configuration applies even to a temporary
 * emit directory outside it. `--vcs-enabled=false` stops VCS ignore rules from
 * dropping an explicitly listed file (a temp dir under a gitignored `TMPDIR`
 * otherwise reports "No files were processed"). Returns Biome's output.
 */
export function normalizeWithBiome(files, root, options = {}) {
  const { resolveBin = resolveBinScript, run = spawnRunner } = options;
  if (files.length === 0) {
    return '';
  }
  const biome = resolveBin('@biomejs/biome', 'biome');
  let output = '';
  let failure;
  // Every chunk runs even after one fails, as the single call this replaces
  // normalized every file it could before reporting: stopping at the first
  // failing chunk would leave the later artifacts as raw tsc output.
  for (const chunk of chunkByArgumentLength(files)) {
    const result = run(
      process.execPath,
      [biome, 'check', '--write', '--vcs-enabled=false', ...chunk],
      { cwd: root },
    );
    output += `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`;
    if (result.error || result.signal !== null || result.status === 0) {
      // A spawn error or signal would repeat for every chunk: throw at once.
      assertSucceeded('biome', 'biome normalization', result);
    } else {
      failure ??= new StageError(
        'biome',
        `biome normalization: exited ${result.status}`,
      );
    }
  }
  if (failure) {
    throw new StageError(failure.stage, failure.message, output);
  }
  return output;
}
/**
 * Emit the .mjs artifacts with tsc into `root`, Biome-normalize only the
 * emitted set, then sync the `.gitattributes` generated block. Returns
 * Biome's output.
 */
export function buildArtifacts(root, options = {}) {
  const emittedFiles = parseEmittedFiles(runTsc(root, options));
  const output = normalizeWithBiome(emittedFiles, root, options);
  syncGitattributes(root);
  return output;
}
if (import.meta.main) {
  try {
    process.stdout.write(buildArtifacts(process.cwd()));
  } catch (error) {
    if (!(error instanceof StageError)) {
      throw error;
    }
    process.stderr.write(`build: ${error.message}\n${error.output}`);
    process.exitCode = 1;
  }
}
