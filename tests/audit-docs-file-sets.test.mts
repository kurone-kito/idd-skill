import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv, runImportOnlyProbe } from './test-utils.mts';

// checkFileSets in src/scripts/audit-docs.mts is not exported -- the CLI
// body only runs when this module is the entrypoint (guarded by
// `import.meta.main`, #3190), but its internal check* functions stay
// private either way -- so it cannot be imported and unit-tested directly.
// These tests drive the built `scripts/audit-docs.mjs` CLI as a subprocess
// against a minimal fixture git repo instead — the same pattern used by
// tests/sync-docs.test.mts and the CLI-subprocess smoke tests in
// tests/cli-entry-smoke.test.mts.
//
// Coverage motivation: a same-side basename collision under a recursive
// `**/*.md` fileSet glob (for example a new
// `skills/issue-authoring/references/a/contract.md` alongside the existing
// `skills/issue-authoring/references/contract.md`) used to be silently
// swallowed by the basename-keyed Set/Map in checkFileSets — the guard
// would report the new file as already covered by the unrelated existing
// file's target and syncPairs entry. checkFileSets now fails closed on any
// such collision instead of guessing which path a basename "really" refers
// to.
//
// `fixtureEnv()` (sanitized git env so this subprocess never touches the
// host repo's GIT_DIR / ignore config) lives in `./test-utils.mts`, shared
// with `tests/sync-docs.test.mts`'s own git-backed fixture (#1703).

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runAuditDocs(cwd: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'audit-docs.mjs'), '--check'],
      {
        cwd,
        env: fixtureEnv(),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
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

interface FixtureOptions {
  forbiddenPatterns?: {
    id: string;
    glob: string;
    pattern: string;
    message: string;
  }[];
  rootMarkdownAllowlist?: { id: string; allowed: string[] };
}

function makeFixture(options: FixtureOptions = {}): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-file-sets-'));
  execFileSync('git', ['init', '--quiet'], { cwd: dir, env: fixtureEnv() });
  mkdirSync(join(dir, 'audit'), { recursive: true });
  mkdirSync(join(dir, 'skills', 'mirror-source', 'nested'), {
    recursive: true,
  });
  mkdirSync(join(dir, '.claude', 'mirror-target'), { recursive: true });
  writeFileSync(
    join(dir, 'audit', 'sync-manifest.json'),
    JSON.stringify({
      fileSets: [
        {
          id: 'fixture-set',
          sourceGlob: 'skills/mirror-source/**/*.md',
          targetGlob: '.claude/mirror-target/**/*.md',
          match: 'basename',
          requireSyncPairs: false,
        },
      ],
      ...options,
    }),
    'utf8',
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function runFixtureGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    env: fixtureEnv(),
    encoding: 'utf8',
    ...(input === undefined ? {} : { input }),
  });
}

function addFixtureFiles(cwd: string, ...files: string[]): void {
  runFixtureGit(cwd, ['add', '--', ...files]);
}

function setUnmergedIndexPath(
  cwd: string,
  file: string,
  contents: string,
): void {
  writeFileSync(join(cwd, file), contents, 'utf8');
  const blob = runFixtureGit(
    cwd,
    ['hash-object', '-w', '--stdin'],
    contents,
  ).trim();
  const indexInfo = [1, 2, 3]
    .map((stage) => `100644 ${blob} ${stage}\t${file}\n`)
    .join('');
  runFixtureGit(cwd, ['update-index', '--index-info'], indexInfo);

  const stages = runFixtureGit(cwd, ['ls-files', '--stage', '--', file])
    .trim()
    .split(/\r?\n/)
    .map((line) => line.slice(0, line.indexOf('\t')).split(' ').at(-1));
  assert.deepEqual(stages, ['1', '2', '3']);
}

test('checkFileSets passes a recursive fileSet with no basename collision', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('checkFileSets fails closed when two source files share a basename', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');
  // A new canonical file nested one directory deeper, sharing the basename
  // of the already-mirrored file above.
  writeFileSync(
    join(dir, 'skills', 'mirror-source', 'nested', 'a.md'),
    '# a nested\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-set: ambiguous basename a\.md matches multiple source files/,
  );
  assert.match(result.stderr, /mirror-source\/a\.md/);
  assert.match(result.stderr, /mirror-source\/nested\/a\.md/);
});

test('checkFileSets fails closed when two target files share a basename', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  writeFileSync(join(dir, 'skills', 'mirror-source', 'a.md'), '# a\n');
  writeFileSync(join(dir, '.claude', 'mirror-target', 'a.md'), '# a mirror\n');
  mkdirSync(join(dir, '.claude', 'mirror-target', 'nested'), {
    recursive: true,
  });
  writeFileSync(
    join(dir, '.claude', 'mirror-target', 'nested', 'a.md'),
    '# a mirror nested\n',
  );

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixture-set: ambiguous basename a\.md matches multiple target files/,
  );
});

test('listRepoFiles visits an unresolved source path once', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  const source = 'skills/mirror-source/a.md';
  addFixtureFiles(dir, 'audit/sync-manifest.json');
  writeFileSync(join(dir, '.claude/mirror-target/a.md'), '# a mirror\n');
  addFixtureFiles(dir, '.claude/mirror-target/a.md');
  setUnmergedIndexPath(dir, source, '# a\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /ambiguous basename/u,
  );
});

test('listRepoFiles visits an unresolved target path once', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  const target = '.claude/mirror-target/a.md';
  writeFileSync(join(dir, 'skills/mirror-source/a.md'), '# a\n');
  addFixtureFiles(dir, 'audit/sync-manifest.json', 'skills/mirror-source/a.md');
  setUnmergedIndexPath(dir, target, '# a mirror\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(
    `${result.stdout}\n${result.stderr}`,
    /ambiguous basename/u,
  );
});

test('listRepoFiles reports each finding once for an unresolved root Markdown path', (t) => {
  const { dir, cleanup } = makeFixture({
    forbiddenPatterns: [
      {
        id: 'fixture-forbidden',
        glob: 'stray.md',
        pattern: 'BLOCK_ME',
        message: 'forbidden content',
      },
    ],
    rootMarkdownAllowlist: { id: 'root-markdown-allowlist', allowed: [] },
  });
  t.after(cleanup);

  addFixtureFiles(dir, 'audit/sync-manifest.json');
  setUnmergedIndexPath(dir, 'stray.md', 'BLOCK_ME\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.match(
      /root-markdown-allowlist: stray\.md is not an allowed root-level Markdown file/gu,
    )?.length,
    1,
  );
  assert.equal(
    result.stderr.match(/fixture-forbidden: stray\.md: forbidden content/gu)
      ?.length,
    1,
  );
});

test('listRepoFiles preserves distinct same-basename paths around an unresolved path', (t) => {
  const { dir, cleanup } = makeFixture();
  t.after(cleanup);

  const conflicted = 'skills/mirror-source/a.md';
  const distinct = 'skills/mirror-source/nested/a.md';
  writeFileSync(join(dir, distinct), '# nested a\n');
  writeFileSync(join(dir, '.claude/mirror-target/a.md'), '# a mirror\n');
  addFixtureFiles(
    dir,
    'audit/sync-manifest.json',
    distinct,
    '.claude/mirror-target/a.md',
  );
  setUnmergedIndexPath(dir, conflicted, '# a\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  assert.equal(
    result.stderr.match(
      /fixture-set: ambiguous basename a\.md matches multiple source files/gu,
    )?.length,
    1,
  );
  assert.match(
    result.stderr,
    /fixture-set: ambiguous basename a\.md matches multiple source files \(skills\/mirror-source\/a\.md, skills\/mirror-source\/nested\/a\.md\); basename matching cannot distinguish them/u,
  );
});

test('listRepoFiles keeps code-unit order for root Markdown findings', (t) => {
  const { dir, cleanup } = makeFixture({
    rootMarkdownAllowlist: { id: 'root-markdown-allowlist', allowed: [] },
  });
  t.after(cleanup);

  writeFileSync(join(dir, 'B.md'), '# B\n');
  writeFileSync(join(dir, 'a.md'), '# a\n');

  const result = runAuditDocs(dir);
  assert.equal(result.status, 1);
  const upperIndex = result.stderr.indexOf(
    'root-markdown-allowlist: B.md is not an allowed root-level Markdown file',
  );
  const lowerIndex = result.stderr.indexOf(
    'root-markdown-allowlist: a.md is not an allowed root-level Markdown file',
  );
  assert.ok(upperIndex >= 0, result.stderr);
  assert.ok(lowerIndex >= 0, result.stderr);
  assert.ok(upperIndex < lowerIndex, result.stderr);
});

// #3190: audit-docs.mts used to run its whole CLI body -- including a
// `process.exit` -- as a side effect of module evaluation, with no
// `import.meta.main` guard. Dynamically importing it (e.g. to inventory its
// named exports) from a process whose own argv lacks `--check` used to kill
// the importing process before this probe's own `.then()` ever ran. This
// runs from an empty temp directory (no git repo, no
// audit/sync-manifest.json) specifically to prove the import no longer
// depends on either -- a guarded import never reaches the code that would
// need them.
test('importing scripts/audit-docs.mjs without --check does not run the CLI or call process.exit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-docs-import-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runImportOnlyProbe(
    join(REPO_ROOT, 'scripts', 'audit-docs.mjs'),
    dir,
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /IMPORT_OK/);
  assert.doesNotMatch(result.stderr, /usage: node scripts\/audit-docs\.mjs/);
});
