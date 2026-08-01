import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { fixtureEnv, makeScaffoldedSyncRepo } from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SYNC_DOCS_SCRIPT = join(REPO_ROOT, 'scripts/sync-docs.mjs');
const SYNC_DOCS_DEPS = ['consistency-helpers.mjs', 'policy-helpers.mjs'];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

function run(dir: string, ...args: string[]): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(dir, 'scripts', 'sync-docs.mjs'), ...args],
      {
        cwd: dir,
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

// Runs the REAL repo's built audit-docs.mjs (not copied into the fixture,
// following audit-docs-file-sets.test.mts's pattern) against the fixture
// dir as its cwd -- used to prove sync-docs and audit-docs agree on a
// sourceGlobs-only block's resolved content (#1703 acceptance criterion 1).
function runAuditDocs(dir: string): RunResult {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'audit-docs.mjs'), '--check'],
      {
        cwd: dir,
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

test('exact syncPair: --check reports drift without writing, --apply writes and is idempotent', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-exact',
          source: 'src/a.md',
          target: 'out/a.md',
          mode: 'exact',
          replacements: [{ from: 'PLACEHOLDER', to: 'replaced' }],
        },
      ],
    },
    {
      'src/a.md': 'line with PLACEHOLDER\n',
      'out/a.md': 'old content\n',
    },
  );

  const checked = run(dir, '--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /1 file\(s\) out of sync/);
  assert.match(checked.stdout, /out\/a\.md/);
  assert.match(checked.stdout, /Run with --apply to write changes\./);
  // --check must not mutate the target.
  assert.equal(read(dir, 'out/a.md'), 'old content\n');

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0);
  assert.match(applied.stdout, /Synced 1 file\(s\)\./);
  // replacements are applied to the generated content.
  assert.equal(read(dir, 'out/a.md'), 'line with replaced\n');

  // Re-running on the now-synced tree is a clean no-op.
  const reChecked = run(dir, '--check');
  assert.equal(reChecked.status, 0);
  assert.match(reChecked.stdout, /All mirrored artifacts are up to date\./);
});

test('contains and structure syncPair modes are skipped, not generated', (t) => {
  const dir = makeScaffoldedSyncRepo((cleanup) => t.after(cleanup), {
    syncPairs: [
      {
        id: 'pair-contains',
        source: 'src/a.md',
        target: 'out/a.md',
        mode: 'contains',
      },
      {
        id: 'pair-structure',
        source: 'src/b.md',
        target: 'out/b.md',
        mode: 'structure',
      },
    ],
  });

  const result = run(dir, '--check');
  // Skipped modes produce no generatable diff, so the run reports clean.
  assert.equal(result.status, 0);
  assert.match(result.stdout, /All mirrored artifacts are up to date\./);
  assert.match(result.stdout, /Skipped 2 pair\(s\)/);
  assert.match(result.stdout, /pair-contains/);
  assert.match(result.stdout, /pair-structure/);
});

test('generatedBlock resolves explicit paths (prefix-stripped); absent paths render an empty list', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      generatedBlocks: [
        {
          id: 'blk',
          file: 'doc.md',
          language: 'text',
          stripPrefix: 'src/',
          paths: ['src/one.mts', 'src/two.mts'],
        },
        { id: 'blk-empty', file: 'doc2.md', language: 'text' },
      ],
    },
    {
      'doc.md': blockFixture('blk'),
      'doc2.md': blockFixture('blk-empty'),
    },
  );

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0);

  const doc = read(dir, 'doc.md');
  assert.match(doc, /```text\none\.mts\ntwo\.mts\n```/);
  // stripPrefix removed the leading "src/".
  assert.ok(!doc.includes('src/one.mts'), 'prefix should be stripped');

  // Neither paths nor sourceGlobs is set, so there's nothing to resolve.
  const doc2 = read(dir, 'doc2.md');
  assert.match(doc2, /```text\n\n```/);
});

test('generatedBlock falls back to sourceGlobs when paths is absent, agreeing with audit-docs.mjs (#1703)', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      generatedBlocks: [
        {
          id: 'blk',
          file: 'doc.md',
          language: 'text',
          sourceGlobs: ['content/*.md'],
        },
      ],
    },
    {
      'doc.md': blockFixture('blk'),
      'content/b.md': '# b\n',
      'content/a.md': '# a\n',
    },
  );

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0, applied.stderr);

  // Before #1703 this rendered an empty block; the sourceGlobs fallback
  // now matches both untracked-but-not-ignored files, deduped and sorted.
  const doc = read(dir, 'doc.md');
  assert.match(doc, /```text\ncontent\/a\.md\ncontent\/b\.md\n```/);

  // Direct cross-tool parity check: audit-docs.mjs independently resolves
  // the same sourceGlobs-only block and must see the content sync-docs.mjs
  // just wrote as already up to date, not stale. Drop the copied
  // sync-docs.mjs dependency closure first -- those real, banner-carrying
  // .mjs files trip audit-docs.mjs's unrelated generated-source-pairing
  // check (their paired .mts sources don't exist in this minimal fixture),
  // which has nothing to do with the generatedBlocks resolution this test
  // is about.
  rmSync(join(dir, 'scripts'), { recursive: true, force: true });
  const audited = runAuditDocs(dir);
  assert.equal(audited.status, 0, audited.stderr || audited.stdout);
});

test('sourceGlobs fallback resolves relative to package.json root, not the git worktree top (#1748 review)', (t) => {
  // Reproduces the adopter-monorepo shape a review comment on #1748
  // flagged: the git top-level and resolveRepoRoot's nearest-package.json
  // root are different directories. `git ls-files` must be read relative
  // to `root` (the package dir), not the git project top, or a
  // sourceGlobs-only block silently resolves to an empty list here.
  const gitRoot = mkdtempSync(join(tmpdir(), 'sync-docs-monorepo-'));
  t.after(() => rmSync(gitRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd: gitRoot, env: fixtureEnv() });

  const pkgDir = join(gitRoot, 'pkg');
  mkdirSync(join(pkgDir, 'scripts'), { recursive: true });
  mkdirSync(join(pkgDir, 'content'), { recursive: true });
  cpSync(SYNC_DOCS_SCRIPT, join(pkgDir, 'scripts', 'sync-docs.mjs'));
  for (const dep of SYNC_DOCS_DEPS) {
    cpSync(join(REPO_ROOT, 'scripts', dep), join(pkgDir, 'scripts', dep));
  }
  writeFileSync(join(pkgDir, 'package.json'), '{}\n', 'utf8');
  mkdirSync(join(pkgDir, 'audit'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'audit', 'sync-manifest.json'),
    JSON.stringify({
      generatedBlocks: [
        {
          id: 'blk',
          file: 'doc.md',
          language: 'text',
          sourceGlobs: ['content/*.md'],
        },
      ],
    }),
    'utf8',
  );
  writeFileSync(join(pkgDir, 'doc.md'), blockFixture('blk'), 'utf8');
  writeFileSync(join(pkgDir, 'content', 'a.md'), '# a\n', 'utf8');

  const applied = execFileSync(
    process.execPath,
    [join(pkgDir, 'scripts', 'sync-docs.mjs'), '--apply'],
    {
      cwd: pkgDir,
      env: fixtureEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.match(applied, /Synced 1 file\(s\)\./);

  const doc = readFileSync(join(pkgDir, 'doc.md'), 'utf8');
  // Before the #1748 review fix, `--full-name` made this resolve to the
  // empty list (the glob-matched file's git-top-relative path,
  // "pkg/content/a.md", never matched the root-relative "content/*.md"
  // pattern).
  assert.match(doc, /```text\ncontent\/a\.md\n```/);
});

test('shell-file-list rewrites the "for FILE in" block from its source generatedBlock', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      generatedBlocks: [
        { id: 'blk', file: 'doc.md', paths: ['pkg/one', 'pkg/two'] },
      ],
      shellFileLists: [
        { id: 'sl', file: 'sh.md', generatedBlock: 'blk', stripPrefix: 'pkg/' },
      ],
    },
    {
      'doc.md': blockFixture('blk'),
      'sh.md': shellFixture('sl'),
    },
  );

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0);

  const sh = read(dir, 'sh.md');
  assert.match(sh, /for FILE in \\/);
  // shellFileList.stripPrefix ("pkg/") wins and drops the prefix.
  assert.ok(sh.includes('  "one" \\'), 'first file with continuation');
  assert.ok(sh.includes('  "two"'), 'last file without continuation');
  assert.ok(!sh.includes('stale-entry'), 'stale entry should be replaced');
});

test('doStripPrefix mismatch sets nonZeroExit, independent of mode, short-circuiting all writes', (t) => {
  const docOriginal = blockFixture('blk');
  const otherOriginal = blockFixture('other');
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      generatedBlocks: [
        {
          id: 'blk',
          file: 'doc.md',
          stripPrefix: 'WRONG/',
          paths: ['src/one.mts'],
        },
        // A valid block on a second file that WOULD be written if the run did
        // not short-circuit on the first block's prefix error.
        {
          id: 'other',
          file: 'other.md',
          language: 'text',
          paths: ['lib/x.mts'],
        },
      ],
    },
    { 'doc.md': docOriginal, 'other.md': otherOriginal },
  );

  // The guard fires regardless of write mode.
  const checked = run(dir, '--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /does not start with expected prefix/);

  // Even in --apply mode, the nonZeroExit guard exits before the write pass, so
  // NEITHER file is written — not the failing block's file, nor the
  // otherwise-valid co-located block.
  const applied = run(dir, '--apply');
  assert.equal(applied.status, 1);
  assert.match(applied.stderr, /does not start with expected prefix/);
  assert.equal(read(dir, 'doc.md'), docOriginal);
  assert.equal(read(dir, 'other.md'), otherOriginal);
});

test('an unrecognized syncPair mode throws and exits non-zero', (t) => {
  const dir = makeScaffoldedSyncRepo((cleanup) => t.after(cleanup), {
    syncPairs: [
      {
        id: 'pair-bogus',
        source: 'src/a.md',
        target: 'out/a.md',
        mode: 'bogus',
      },
    ],
  });

  // This is the one error path that is not the nonZeroExit mechanism: an
  // unrecognized mode throws, surfacing as a non-zero exit with the message.
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unrecognized syncPair mode/);
});

test('shell-file-list referencing an unknown generatedBlock sets nonZeroExit', (t) => {
  const dir = makeScaffoldedSyncRepo((cleanup) => t.after(cleanup), {
    shellFileLists: [
      { id: 'sl', file: 'sh.md', generatedBlock: 'does-not-exist' },
    ],
  });

  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /references unknown generatedBlock/);
});

test('generatedBlock with a missing target file sets nonZeroExit', (t) => {
  const dir = makeScaffoldedSyncRepo((cleanup) => t.after(cleanup), {
    generatedBlocks: [{ id: 'blk', file: 'missing.md', paths: ['x'] }],
  });

  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /file not found/);
});

test('generatedBlock whose marker is absent sets nonZeroExit', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    { generatedBlocks: [{ id: 'blk', file: 'doc.md', paths: ['x'] }] },
    { 'doc.md': 'no markers here\n' },
  );

  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /block marker not found/);
});

// A document carrying an empty audit:generated block for the given id.
function blockFixture(id: string): string {
  return [
    '# Doc',
    '',
    `<!-- audit:generated id=${id} -->`,
    '<!-- /audit:generated -->',
    '',
    'tail',
    '',
  ].join('\n');
}

// A document carrying a shell-list marker followed by a "for FILE in" block.
function shellFixture(id: string): string {
  return [
    '# Shell',
    '',
    `<!-- audit:shell-list id=${id} -->`,
    '',
    '```sh',
    'for FILE in \\',
    '  "stale-entry"',
    'do',
    '  echo "$FILE"',
    'done',
    '```',
    '',
  ].join('\n');
}
