#!/usr/bin/env node
// idd-generated-from: src/scripts/check-build-artifacts.mts
//
// The scripts/check-build-artifacts.mjs copy is generated from the .mts
// source named above by `pnpm run build`. Edit the .mts source, never the
// generated .mjs. See docs/typescript-sources.md.
//
// Read-only generated-artifact check behind `pnpm run build:check`. It runs
// the same tsc emit and Biome normalization `pnpm run build` runs
// (build-ts.mts), but into a temporary directory, and compares that fresh
// output with the committed files at HEAD. Nothing is copied back: a drifted
// artifact is reported with its path, never repaired, so a validation command
// can no longer hide the very drift it exists to find (the old build:check
// ran the mutating `build` first). `pnpm run build` stays the explicit
// writer.
//
// Guarantees kept from the earlier `build && git diff HEAD` composition:
//
// - The comparison is relative to committed HEAD, independent of staging
//   (#1023). The HEAD snapshot comes from `git ls-tree` + `git cat-file`,
//   neither of which reads the index; the working-tree copies are compared
//   byte for byte, so even a stat-dirty index entry is never rewritten
//   (`git diff` would refresh it, even with --no-optional-locks).
// - A new source whose generated artifact was never committed, and an
//   artifact with no source, both fail (#1707, PR #1732). The untracked-file
//   half lives in check-untracked-artifacts.mts.
// - A generated checker must not be the sole judge of its own integrity (PR
//   #1732 review). `build:check` therefore runs THIS file from its `.mts`
//   source, never the committed scripts/check-build-artifacts.mjs: a stale or
//   tampered committed copy is just another artifact here, byte-compared
//   against the fresh emit before the `&&` in package.json lets anything
//   else run. Node's native type stripping (the repository's engines floor)
//   makes the direct source entry possible.
//
// The expected `.gitattributes` content is the HEAD blob with its
// scripts/*.mjs block rewritten from the banner-derived set of the fresh emit
// (generatedScriptNames over the temporary scripts/ directory): the same
// banner scan `build` applies to the on-disk scripts/ directory, so the two
// agree on which sources are generated (they differ only for a bannered
// artifact with no source, which is reported as not-emitted anyway).
//
// Top-level imports are `node:` builtins plus build-ts.mts (itself
// dependency-free at import time): tsc and Biome are resolved lazily inside
// build-ts.mts's functions, so tests/check-build-artifacts.test.mts can import
// this module in the toolless bare-node CI lane. Content only is compared, not
// file modes, as before. The `* text=auto eol=lf` rule in .gitattributes keeps
// working-tree artifacts LF on every platform, which the byte comparison
// relies on.

// #3240: side-effect-only import, kept first so an unsupported Node (where
// `import.meta.main` is `undefined`, not `false`) fails loudly before this
// entry block runs. See node-runtime-guard.mts.
import './node-runtime-guard.mts';

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertSucceeded,
  GITATTRIBUTES_PATH,
  generatedScriptNames,
  normalizeWithBiome,
  type ProcessRunner,
  rewriteGitattributesBlock,
  runTsc,
  StageError,
  spawnRunner,
  type ToolOptions,
} from './build-ts.mts';

const ARTIFACT_ROOTS = ['scripts', 'bin'] as const;
const ARTIFACT_PATH_PATTERN = /^(?:scripts|bin)\/.+\.mjs$/;
const FIX_HINT =
  'Fix: run `pnpm run build`, review the diff, and commit the regenerated files; remove a stale artifact with `git rm` (the build never deletes one).';

/** What a finding says is wrong with one path. */
export type FindingKind =
  | 'drift'
  | 'local-edit'
  | 'no-output'
  | 'not-committed'
  | 'not-emitted'
  | 'out-of-scope';

/** One problem, tied to the repository-relative path it concerns. */
export interface Finding {
  readonly detail: string;
  readonly kind: FindingKind;
  readonly path: string;
}

/** Everything `compareArtifacts` needs, keyed by `/`-separated path. */
export interface ArtifactSnapshot {
  /** HEAD blobs: generated `.mjs` under scripts/bin plus `.gitattributes`. */
  readonly committed: ReadonlyMap<string, Buffer>;
  /** The fresh emit, plus the expected `.gitattributes`. */
  readonly emitted: ReadonlyMap<string, Buffer>;
  /** The artifact paths the `src/**` sources are expected to produce. */
  readonly expectedPaths: readonly string[];
  /**
   * Working-tree bytes of every artifact on disk (tracked or not) plus the
   * committed and emitted paths; a path that does not exist is absent.
   */
  readonly working: ReadonlyMap<string, Buffer>;
}

const clip = (line: string): string =>
  line.length > 100 ? `${line.slice(0, 100)}...` : line;

/** The first line where two texts differ, with both versions clipped. */
function firstDifference(committed: string, fresh: string): string {
  const committedLines = committed.split('\n');
  const freshLines = fresh.split('\n');
  const length = Math.max(committedLines.length, freshLines.length);
  for (let index = 0; index < length; index += 1) {
    if (committedLines[index] !== freshLines[index]) {
      return [
        `      first difference at line ${index + 1}`,
        `      committed: ${clip(committedLines[index] ?? '<end of file>')}`,
        `      fresh:     ${clip(freshLines[index] ?? '<end of file>')}`,
      ].join('\n');
    }
  }
  return 'contents differ';
}

/** Which lines `.gitattributes` is missing or has beyond the expected body. */
function attributeLineDifference(committed: string, fresh: string): string {
  const committedLines = new Set(committed.split('\n'));
  const freshLines = new Set(fresh.split('\n'));
  const missing = [...freshLines].filter((line) => !committedLines.has(line));
  const extra = [...committedLines].filter((line) => !freshLines.has(line));
  const parts = [
    ...missing.map((line) => `      missing:    ${clip(line)}`),
    ...extra.map((line) => `      unexpected: ${clip(line)}`),
  ];
  return parts.length > 0
    ? parts.join('\n')
    : 'the same lines in a different order';
}

/**
 * Compare the fresh emit, HEAD and the working tree. Pure: every input is in
 * `snapshot`, so each failure mode is testable without git, tsc or Biome. One
 * path yields at most one finding, ordered by how fundamental the problem is.
 */
export function compareArtifacts(snapshot: ArtifactSnapshot): Finding[] {
  const { committed, emitted, expectedPaths, working } = snapshot;
  const findings: Finding[] = [];
  const noOutput = new Set(expectedPaths.filter((path) => !emitted.has(path)));
  // A working-tree artifact with neither a source nor a HEAD copy (untracked
  // or only staged) is a path of its own: the index is deliberately never
  // consulted, so it must be found by looking at the files themselves.
  const workingOnly = [...working.keys()].filter((path) =>
    ARTIFACT_PATH_PATTERN.test(path),
  );
  const paths = [
    ...new Set([
      ...emitted.keys(),
      ...committed.keys(),
      ...noOutput,
      ...workingOnly,
    ]),
  ].sort();
  for (const path of paths) {
    const fresh = emitted.get(path);
    const head = committed.get(path);
    const copy = working.get(path);
    const add = (kind: FindingKind, detail: string): void => {
      findings.push({ detail, kind, path });
    };
    if (noOutput.has(path)) {
      add(
        'no-output',
        'a source under src/ is expected to emit this file but the build produced nothing (check tsconfig.build.json include/exclude)',
      );
    } else if (
      fresh !== undefined &&
      path !== GITATTRIBUTES_PATH &&
      !ARTIFACT_PATH_PATTERN.test(path)
    ) {
      add(
        'out-of-scope',
        'emitted outside scripts/ and bin/, which build:check and the untracked-artifact check do not cover; extend them before adding such a source',
      );
    } else if (fresh !== undefined && head === undefined) {
      add(
        'not-committed',
        'a fresh build emits this file but it is not committed at HEAD (new source with no committed output)',
      );
    } else if (fresh === undefined && head !== undefined) {
      add(
        'not-emitted',
        'committed at HEAD but no source emits it any more (stale or hand-written artifact): remove it with `git rm`',
      );
    } else if (fresh === undefined && copy !== undefined) {
      add(
        'not-emitted',
        'present in the working tree (untracked or only staged) but no source emits it: delete it, or add its source',
      );
    } else if (
      fresh !== undefined &&
      head !== undefined &&
      !fresh.equals(head)
    ) {
      const difference =
        path === GITATTRIBUTES_PATH
          ? attributeLineDifference(
              head.toString('utf8'),
              fresh.toString('utf8'),
            )
          : firstDifference(head.toString('utf8'), fresh.toString('utf8'));
      const note =
        copy?.equals(fresh) === true
          ? ' (the working tree already matches a fresh build: commit it)'
          : '';
      add('drift', `differs from a fresh build${note}\n${difference}`);
    } else if (head !== undefined && copy === undefined) {
      add(
        'local-edit',
        'committed at HEAD but missing from the working tree (nothing was restored)',
      );
    } else if (head !== undefined && copy !== undefined && !copy.equals(head)) {
      add(
        'local-edit',
        'the working-tree copy differs from HEAD (nothing was rewritten; restore it or run `pnpm run build` and commit)',
      );
    }
  }
  return findings;
}

/** The report printed for a failing check. */
export function formatFindings(findings: readonly Finding[]): string {
  return [
    'build:check: generated artifacts do not match a fresh build; nothing was rewritten.',
    ...findings.map(
      (finding) => `  ${finding.path}: [${finding.kind}] ${finding.detail}`,
    ),
    FIX_HINT,
  ].join('\n');
}

/**
 * Split the stream `git cat-file --batch` prints for `expected` objects
 * (`<oid> <type> <size>\n<bytes>\n` each) into one buffer per object, in
 * request order. Works on bytes, so content holding newlines or invalid
 * UTF-8 survives.
 */
export function parseCatFileBatch(output: Buffer, expected: number): Buffer[] {
  const blobs: Buffer[] = [];
  let offset = 0;
  while (blobs.length < expected) {
    const eol = output.indexOf(0x0a, offset);
    if (eol < 0) {
      throw new StageError('git', 'git cat-file --batch: truncated output');
    }
    const [oid, type, sizeText] = output
      .toString('utf8', offset, eol)
      .split(' ');
    if (type === 'missing') {
      throw new StageError('git', `git cat-file --batch: ${oid} is missing`);
    }
    const size = Number(sizeText);
    const start = eol + 1;
    if (!Number.isInteger(size) || size < 0 || start + size > output.length) {
      throw new StageError('git', 'git cat-file --batch: malformed entry');
    }
    blobs.push(output.subarray(start, start + size));
    offset = start + size + 1;
  }
  return blobs;
}

/**
 * The generated artifacts (and `.gitattributes`) as committed at HEAD. Uses
 * only `git ls-tree` and `git cat-file`, which read the object database and
 * never the index.
 */
export function readHeadSnapshot(
  root: string,
  run: ProcessRunner = spawnRunner,
): Map<string, Buffer> {
  const listing = run(
    'git',
    [
      'ls-tree',
      '-r',
      '-z',
      'HEAD',
      '--',
      ...ARTIFACT_ROOTS,
      GITATTRIBUTES_PATH,
    ],
    { cwd: root },
  );
  assertSucceeded('git', 'git ls-tree HEAD', listing);
  const entries: { oid: string; path: string }[] = [];
  for (const record of listing.stdout.toString('utf8').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const [, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (
      type === 'blob' &&
      oid !== undefined &&
      (path === GITATTRIBUTES_PATH || ARTIFACT_PATH_PATTERN.test(path))
    ) {
      entries.push({ oid, path });
    }
  }
  const snapshot = new Map<string, Buffer>();
  if (entries.length === 0) {
    return snapshot;
  }
  const blobs = run('git', ['cat-file', '--batch'], {
    cwd: root,
    input: Buffer.from(entries.map((entry) => `${entry.oid}\n`).join('')),
  });
  assertSucceeded('git', 'git cat-file --batch', blobs);
  parseCatFileBatch(blobs.stdout, entries.length).forEach((blob, index) => {
    snapshot.set(entries[index]?.path ?? '', blob);
  });
  return snapshot;
}

/** True for the errno codes that mean "there is no readable file at that path". */
function isAbsent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

/** Every file under `dir` ending in `suffix`, as `/`-separated relative paths. */
function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .map((path) => path.replaceAll('\\', '/'))
      .filter((path) => path.endsWith(suffix))
      .sort();
  } catch (error) {
    if (isAbsent(error)) {
      return [];
    }
    throw error;
  }
}

/** The artifact paths `src/**` is expected to produce (`rootDir: src`). */
export function expectedArtifactPaths(root: string): string[] {
  return listFiles(join(root, 'src'), '.mts')
    .filter((path) => !path.endsWith('.d.mts'))
    .map((path) => path.replace(/\.mts$/, '.mjs'));
}

function readIfPresent(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if (isAbsent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** `rmSync` retries a busy file at most `maxRetries` times, `retryDelay` ms apart. */
export const TEMP_REMOVE_OPTIONS = {
  force: true,
  maxRetries: 5,
  recursive: true,
  retryDelay: 100,
} as const;

/**
 * Remove the temporary emit directory with a bounded retry (Windows may hold
 * a just-closed file briefly). Returns a warning instead of throwing: a
 * cleanup failure must never mask the verdict. Known limit: the whole run is
 * synchronous, so a signal that kills the process mid-run (`kill -TERM`)
 * cannot run this cleanup and leaves the `idd-build-check-*` directory in the
 * system temp location; normal success and every failure path remove it.
 */
export function removeTempDir(
  dir: string,
  remove: (path: string) => void = (path) => {
    rmSync(path, TEMP_REMOVE_OPTIONS);
  },
): string | undefined {
  try {
    remove(dir);
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `could not remove the temporary directory ${dir}: ${reason}`;
  }
}

/** Collaborators and locations the verifier takes; defaults are the real ones. */
export interface VerifyOptions extends ToolOptions {
  readonly remove?: (path: string) => void;
  readonly root?: string;
  readonly tmpRoot?: string;
}

/** The verdict of one verification run. */
export interface VerifyResult {
  readonly findings: Finding[];
  readonly warnings: string[];
}

/**
 * Emit into a temporary directory, normalize, and compare with HEAD and the
 * working tree. Writes nothing under `root`. Throws a StageError for a
 * tooling failure (tsc, Biome, git); a mismatch is a finding, not an error.
 */
export function verifyBuildArtifacts(
  options: VerifyOptions = {},
): VerifyResult {
  const root = options.root ?? process.cwd();
  const tools: ToolOptions = {
    resolveBin: options.resolveBin,
    run: options.run,
  };
  const warnings: string[] = [];
  const temp = mkdtempSync(
    join(options.tmpRoot ?? tmpdir(), 'idd-build-check-'),
  );
  try {
    runTsc(root, { ...tools, outDir: temp });
    const emittedPaths = listFiles(temp, '.mjs');
    normalizeWithBiome(
      emittedPaths.map((path) => join(temp, path)),
      root,
      tools,
    );
    const emitted = new Map<string, Buffer>();
    for (const path of emittedPaths) {
      emitted.set(path, readFileSync(join(temp, path)));
    }

    const committed = readHeadSnapshot(root, options.run);
    const findings: Finding[] = [];
    const committedAttributes = committed.get(GITATTRIBUTES_PATH);
    if (committedAttributes === undefined) {
      findings.push({
        detail:
          'not committed at HEAD, so the generated block cannot be checked',
        kind: 'not-committed',
        path: GITATTRIBUTES_PATH,
      });
    } else {
      try {
        const names =
          emitted.size > 0 ? generatedScriptNames(join(temp, 'scripts')) : [];
        emitted.set(
          GITATTRIBUTES_PATH,
          Buffer.from(
            rewriteGitattributesBlock(
              committedAttributes.toString('utf8'),
              names,
            ),
          ),
        );
      } catch (error) {
        findings.push({
          detail: error instanceof Error ? error.message : String(error),
          kind: 'drift',
          path: GITATTRIBUTES_PATH,
        });
        committed.delete(GITATTRIBUTES_PATH);
      }
    }

    const working = new Map<string, Buffer>();
    const onDisk = ARTIFACT_ROOTS.flatMap((dir) =>
      listFiles(join(root, dir), '.mjs').map((path) => `${dir}/${path}`),
    );
    for (const path of new Set([
      ...committed.keys(),
      ...emitted.keys(),
      ...onDisk,
    ])) {
      const copy = readIfPresent(join(root, path));
      if (copy !== undefined) {
        working.set(path, copy);
      }
    }
    findings.push(
      ...compareArtifacts({
        committed,
        emitted,
        expectedPaths: expectedArtifactPaths(root),
        working,
      }),
    );
    return { findings, warnings };
  } finally {
    const warning = removeTempDir(temp, options.remove);
    if (warning !== undefined) {
      warnings.push(warning);
    }
  }
}

function main(): void {
  try {
    const { findings, warnings } = verifyBuildArtifacts();
    for (const warning of warnings) {
      console.error(`build:check: warning: ${warning}`);
    }
    if (findings.length > 0) {
      console.error(formatFindings(findings));
      process.exitCode = 1;
    }
  } catch (error) {
    if (!(error instanceof StageError)) {
      throw error;
    }
    console.error(`build:check: ${error.message}\n${error.output}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main();
}
