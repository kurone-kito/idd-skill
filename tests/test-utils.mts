import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReviewThreadNode } from '../src/scripts/resolve-review-thread.mts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SYNC_DOCS_SCRIPT = join(REPO_ROOT, 'scripts/sync-docs.mjs');
// sync-docs.mjs imports the shared banner/helper module, which in turn imports
// policy-helpers; the hermetic fixture must carry that whole import closure so
// the copied script resolves its siblings under the temp scripts/ dir.
const SYNC_DOCS_DEPS = ['consistency-helpers.mjs', 'policy-helpers.mjs'];

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
 * Builds a self-contained sync-docs fixture repo: `package.json` (so
 * `resolveRepoRoot` stops here), a copy of the real `sync-docs.mjs` under
 * `scripts/` plus its import closure, the fixture manifest, and any
 * referenced source/target files. `register` is called with a cleanup
 * callback (e.g. `(cleanup) => t.after(cleanup)`).
 */
export function makeScaffoldedSyncRepo(
  register: (cleanup: () => void) => void,
  manifest: unknown,
  files: Record<string, string> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-docs-'));
  register(() => rmSync(dir, { recursive: true, force: true }));

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
