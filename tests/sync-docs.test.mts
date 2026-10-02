import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  fixtureEnv,
  makeScaffoldedSyncRepo,
  runImportOnlyProbe,
} from './test-utils.mts';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SYNC_DOCS_SCRIPT = join(REPO_ROOT, 'scripts/sync-docs.mjs');
const SYNC_DOCS_DEPS = [
  'consistency-helpers.mjs',
  'markdown-code.mjs',
  'markdown-link-audit.mjs',
  'node-runtime-guard.mjs',
  'policy-helpers.mjs',
  'provider-contract.mjs',
];

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

// Runs the built sync-docs.mjs inside `dir`. `spawnSync` (not `execFileSync`)
// so stderr is captured on exit-0 runs too: a run that prints a diagnostic
// and still exits 0 must not look silent. `extraEnv` is layered over the
// sanitized fixture environment, and `cwd` (default `dir`) is the working
// directory the process starts in.
function runWithEnv(
  dir: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  cwd: string = dir,
): RunResult {
  const result = spawnSync(
    process.execPath,
    [join(dir, 'scripts', 'sync-docs.mjs'), ...args],
    {
      cwd,
      env: { ...fixtureEnv(), ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error) : ''),
  };
}

function run(dir: string, ...args: string[]): RunResult {
  return runWithEnv(dir, args);
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

// #3190: sync-docs.mts used to run its whole sync pipeline -- including
// process.exit calls -- as a side effect of module evaluation, with no
// `import.meta.main` guard. Dynamically importing it (e.g. to inventory its
// named exports) from a process whose own argv carries neither --check nor
// --apply used to kill the importing process before this probe's own
// `.then()` ever ran (pre-fix: apply=false, so the pipeline always reaches
// either `process.exit(0)` -- "up to date" -- or `process.exit(1)` -- "N
// file(s) out of sync" -- before IMPORT_OK could print). `IMPORT_OK` in
// stdout is therefore the real discriminator here, not the empty temp
// directory's contents: sync-docs.mts resolves its write root from the
// *script's own file location* (`resolveRepoRoot(import.meta.dirname)`),
// not from `cwd`, so even the pre-fix code could never have written into
// this particular `dir` regardless of the guard. The sharper "importer's
// own --apply-shaped argv triggers a real write" risk #3190's issue body
// describes needs `--apply` actually present in the importing process's
// argv to reach sync-docs.mts's un-exited write loop -- covered by the
// dedicated fixture-backed test below instead.
test('importing scripts/sync-docs.mjs without --check/--apply does not run the pipeline or call process.exit', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-docs-import-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runImportOnlyProbe(SYNC_DOCS_SCRIPT, dir);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /IMPORT_OK/);
  assert.doesNotMatch(
    result.stdout,
    /All mirrored artifacts|file\(s\) out of sync|Synced \d+ file/,
  );
});

// #3190's Background/Proposed change describe a sharper danger case than
// acceptance criterion 2's own no-flags scenario above: an importer whose
// own process.argv happens to contain `--apply` for a reason unrelated to
// sync-docs.mts (the pre-fix code read `process.argv` unconditionally, with
// no way to tell "my own --apply" from "the importer's own, unrelated
// --apply"). Unlike the no-flags probe above, this scenario's pre-fix write
// loop never calls `process.exit` on success -- it falls off the end of the
// script after writing -- so an IMPORT_OK-only assertion could not have
// caught it; this fixture instead asserts the target file's on-disk content
// is untouched. Uses a real out-of-sync `exact` pair (via
// makeScaffoldedSyncRepo, which copies the built sync-docs.mjs -- plus its
// import closure -- into the fixture so `resolveRepoRoot` anchors writes
// inside the fixture, observable here) so a pre-fix run would have a real
// diff to write.
test('importing scripts/sync-docs.mjs when the importer’s own argv happens to contain --apply does not write the fixture’s out-of-sync target', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-exact',
          source: 'src/a.md',
          target: 'out/a.md',
          mode: 'exact',
        },
      ],
    },
    {
      'src/a.md': 'fresh content\n',
      'out/a.md': 'stale content\n',
    },
  );

  const result = runImportOnlyProbe(
    join(dir, 'scripts', 'sync-docs.mjs'),
    dir,
    ['--apply'],
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /IMPORT_OK/);
  assert.equal(read(dir, 'out/a.md'), 'stale content\n');
});

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

// Commits every currently-written file in `dir` as the repo's initial
// commit, so a subsequent on-disk edit becomes a genuine *uncommitted*
// change relative to `git show HEAD:<path>` -- required for #1765's
// uncommitted-target-edit guard tests, since makeScaffoldedSyncRepo itself
// only `git init`s the fixture and never commits.
function commitAll(dir: string): void {
  const env = {
    ...fixtureEnv(),
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '--quiet', '-m', 'init'], { cwd: dir, env });
}

test('exact syncPair: an uncommitted target edit is protected without --force', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-exact',
          source: 'src/a.md',
          target: 'out/a.md',
          mode: 'exact',
        },
      ],
    },
    {
      'src/a.md': 'generated content\n',
      'out/a.md': 'generated content\n',
    },
  );
  commitAll(dir);
  // Simulate a mistaken direct edit to the target after the initial commit.
  writeFileSync(join(dir, 'out/a.md'), 'a local edit worth keeping\n', 'utf8');

  const checked = run(dir, '--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stderr, /uncommitted local changes/);
  assert.match(checked.stderr, /out\/a\.md/);
  assert.match(checked.stderr, /Pass --force/);
  // The edit must survive untouched.
  assert.equal(read(dir, 'out/a.md'), 'a local edit worth keeping\n');

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 1);
  assert.equal(read(dir, 'out/a.md'), 'a local edit worth keeping\n');
});

test('exact syncPair: --force overwrites a protected uncommitted target edit', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-exact',
          source: 'src/a.md',
          target: 'out/a.md',
          mode: 'exact',
        },
      ],
    },
    {
      'src/a.md': 'generated content\n',
      'out/a.md': 'generated content\n',
    },
  );
  commitAll(dir);
  writeFileSync(join(dir, 'out/a.md'), 'a local edit worth keeping\n', 'utf8');

  const applied = run(dir, '--apply', '--force');
  assert.equal(applied.status, 0);
  assert.equal(read(dir, 'out/a.md'), 'generated content\n');
});

test('exact syncPair: a target that is merely stale (matches its last commit) still syncs silently, no --force needed', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-exact',
          source: 'src/a.md',
          target: 'out/a.md',
          mode: 'exact',
        },
      ],
    },
    {
      'src/a.md': 'old generated content\n',
      'out/a.md': 'old generated content\n',
    },
  );
  commitAll(dir);
  // The source changes; the target is untouched on disk, so it exactly
  // matches its last commit -- no uncommitted target edit exists.
  writeFileSync(join(dir, 'src/a.md'), 'new generated content\n', 'utf8');

  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0);
  assert.equal(applied.stderr, '');
  assert.equal(read(dir, 'out/a.md'), 'new generated content\n');
});

// ---------------------------------------------------------------------------
// #3717: re-applying over the tool's own earlier output
// ---------------------------------------------------------------------------
//
// sync-docs keeps a per-worktree record of what its last successful --apply
// wrote (see the header comment of src/scripts/sync-docs.mts), so the
// uncommitted-edit guard can tell the tool's own output from a hand edit. The
// record is one JSON file directly under the worktree's absolute git
// directory.
const WRITE_RECORD_FILE = 'idd-sync-docs-written.json';

const SINGLE_PAIR = {
  id: 'pair-exact',
  source: 'src/a.md',
  target: 'out/a.md',
  mode: 'exact',
};

// The exact refusal text the guard has printed since #1765, rebuilt here so a
// reworded message fails these tests.
function refusalMessage(source: string, target: string, mode: string): string {
  return (
    `sync-docs: ${target} has uncommitted local changes that differ ` +
    `from both its last commit and the content generated from ` +
    `${source}. Regenerating would discard them.\n` +
    `  This is an ${mode}-mode pair: ${target} is always ` +
    `regenerated from ${source} -- edit ${source} instead.\n` +
    `  If this edit landed on the wrong side by mistake, move it ` +
    `to ${source} and re-run.\n` +
    `  Pass --force to overwrite ${target} anyway.\n`
  );
}

function absoluteGitDir(dir: string): string {
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: dir,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function writeRecordPath(dir: string): string {
  return join(absoluteGitDir(dir), WRITE_RECORD_FILE);
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: fixtureEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// A committed fixture holding one `exact` pair, source and target in sync.
function committedSingleMirror(t: TestContext): string {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    { syncPairs: [SINGLE_PAIR] },
    { 'src/a.md': 'base\n', 'out/a.md': 'base\n' },
  );
  commitAll(dir);
  return dir;
}

// A committed fixture holding two `exact` pairs whose targets share a
// basename in different directories, both in sync with their sources.
function committedTwoMirrors(t: TestContext): string {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-x',
          source: 'src/x.md',
          target: 'out/x/same.md',
          mode: 'exact',
        },
        {
          id: 'pair-y',
          source: 'src/y.md',
          target: 'out/y/same.md',
          mode: 'exact',
        },
      ],
    },
    {
      'src/x.md': 'x base\n',
      'src/y.md': 'y base\n',
      'out/x/same.md': 'x base\n',
      'out/y/same.md': 'y base\n',
    },
  );
  commitAll(dir);
  return dir;
}

// `git status --porcelain` lines, sorted: the record lives under the git
// directory, so a fixture's status must list only its sources and targets.
function statusLines(dir: string): string[] {
  return git(dir, 'status', '--porcelain').split('\n').filter(Boolean).sort();
}

function setFile(dir: string, rel: string, content: string): void {
  writeFileSync(join(dir, rel), content, 'utf8');
}

// Runs a plain `--apply` and asserts the forward-sync contract: exit 0,
// nothing on stderr, and `target` now holds `expected`.
function assertSilentApply(
  dir: string,
  target: string,
  expected: string,
  extraEnv: NodeJS.ProcessEnv = {},
): RunResult {
  const applied = runWithEnv(dir, ['--apply'], extraEnv);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.stderr, '');
  assert.equal(read(dir, target), expected);
  return applied;
}

test('exact syncPair: re-applying over its own earlier output needs no --force (#3717)', (t) => {
  const dir = committedSingleMirror(t);

  // First source change: the target matches its last commit.
  setFile(dir, 'src/a.md', 'base\nadded\n');
  const first = assertSilentApply(dir, 'out/a.md', 'base\nadded\n');
  assert.match(first.stdout, /Synced 1 file\(s\)\./);

  // The target now holds the tool's own output and differs from HEAD. A
  // line-set check that keeps no state would pass an append but refuse a
  // rewrite of the first edit, so cover both.
  setFile(dir, 'src/a.md', 'base\nrewritten\n');
  assertSilentApply(dir, 'out/a.md', 'base\nrewritten\n');

  setFile(dir, 'src/a.md', 'base\nrewritten\nappended\n');
  assertSilentApply(dir, 'out/a.md', 'base\nrewritten\nappended\n');

  const checked = run(dir, '--check');
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /All mirrored artifacts are up to date\./);
});

test('exact syncPair: the write record sits under the absolute git dir and never shows in git status (#3717)', (t) => {
  const dir = committedSingleMirror(t);

  setFile(dir, 'src/a.md', 'base\nadded\n');
  assertSilentApply(dir, 'out/a.md', 'base\nadded\n');

  // Located where the sync-docs header comment says it lives.
  const record = JSON.parse(readFileSync(writeRecordPath(dir), 'utf8'));
  assert.deepEqual(Object.keys(record), ['out/a.md']);
  assert.match(record['out/a.md'], /^[0-9a-f]{64}$/);

  assert.deepEqual(statusLines(dir), [' M out/a.md', ' M src/a.md']);

  // A second source change: --check reports it without a refusal, writes
  // nothing (neither the target nor the record), and a following plain
  // --apply regenerates the target.
  const recordBefore = readFileSync(writeRecordPath(dir), 'utf8');
  setFile(dir, 'src/a.md', 'base\nrewritten\n');
  const checked = run(dir, '--check');
  assert.equal(checked.status, 1);
  assert.match(checked.stdout, /1 file\(s\) out of sync:/);
  assert.equal(checked.stderr, '');
  assert.equal(read(dir, 'out/a.md'), 'base\nadded\n');
  assert.equal(readFileSync(writeRecordPath(dir), 'utf8'), recordBefore);
  assert.deepEqual(statusLines(dir), [' M out/a.md', ' M src/a.md']);

  assertSilentApply(dir, 'out/a.md', 'base\nrewritten\n');
});

test('concreted syncPair: replacements and the generated-from banner re-apply over their own output (#3717)', (t) => {
  const source = 'idd-template/.github/instructions/x.instructions.md';
  const target = '.github/instructions/x.instructions.md';
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    {
      syncPairs: [
        {
          id: 'pair-concreted',
          source,
          target,
          mode: 'concreted',
          replacements: [{ from: 'PLACEHOLDER', to: 'concrete' }],
        },
      ],
    },
    {
      [source]: '# Title\n\nline with PLACEHOLDER\n',
      [target]: 'stale\n',
    },
  );
  // No commit exists yet, so this first apply carries no guard; commit the
  // generated target to get a fixture whose source and target are in sync.
  assert.equal(run(dir, '--apply').status, 0);
  commitAll(dir);
  const base = read(dir, target);
  // Both the replacements and the banner make the generated content differ
  // from the source text, which is what this variant exists to cover.
  assert.match(base, /idd-generated-from:/);
  assert.match(base, /line with concrete/);
  assert.doesNotMatch(base, /PLACEHOLDER/);

  setFile(dir, source, '# Title\n\nline with PLACEHOLDER\nadded\n');
  assertSilentApply(dir, target, `${base}added\n`);
  assert.deepEqual(statusLines(dir), [` M ${target}`, ` M ${source}`]);

  setFile(dir, source, '# Title\n\nline with PLACEHOLDER\nrewritten\n');
  assertSilentApply(dir, target, `${base}rewritten\n`);

  setFile(dir, source, '# Title\n\nline with PLACEHOLDER\nrewritten\nmore\n');
  assertSilentApply(dir, target, `${base}rewritten\nmore\n`);
});

test('exact syncPair: a mirror converted to CRLF after the first --apply still re-applies (#3717)', (t) => {
  const dir = committedSingleMirror(t);

  setFile(dir, 'src/a.md', 'base\nadded\n');
  assertSilentApply(dir, 'out/a.md', 'base\nadded\n');

  // An editor or `core.autocrlf` rewrites the line endings of the tool's own
  // output; the comparison and the record both normalize them.
  setFile(dir, 'out/a.md', read(dir, 'out/a.md').replace(/\n/g, '\r\n'));
  setFile(dir, 'src/a.md', 'base\nrewritten\n');
  assertSilentApply(dir, 'out/a.md', 'base\nrewritten\n');
});

test('exact syncPair: a hand edit made after the first --apply is still refused until --force (#3717)', (t) => {
  const dir = committedSingleMirror(t);

  setFile(dir, 'src/a.md', 'base\nadded\n');
  assertSilentApply(dir, 'out/a.md', 'base\nadded\n');

  setFile(dir, 'out/a.md', 'base\nadded\nhand edit worth keeping\n');
  setFile(dir, 'src/a.md', 'base\nrewritten\n');

  const refused = run(dir, '--apply');
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, refusalMessage('src/a.md', 'out/a.md', 'exact'));
  assert.equal(read(dir, 'out/a.md'), 'base\nadded\nhand edit worth keeping\n');

  const forced = run(dir, '--apply', '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(read(dir, 'out/a.md'), 'base\nrewritten\n');

  // The forced write is recorded too, so the next forward sync is silent.
  setFile(dir, 'src/a.md', 'base\nrewritten\nappended\n');
  assertSilentApply(dir, 'out/a.md', 'base\nrewritten\nappended\n');
});

test('exact syncPair: mirrors sharing a basename are tracked per target (#3717)', (t) => {
  const dir = committedTwoMirrors(t);

  setFile(dir, 'src/x.md', 'x one\n');
  setFile(dir, 'src/y.md', 'y one\n');
  const first = run(dir, '--apply');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /Synced 2 file\(s\)\./);
  assert.deepEqual(statusLines(dir), [
    ' M out/x/same.md',
    ' M out/y/same.md',
    ' M src/x.md',
    ' M src/y.md',
  ]);

  setFile(dir, 'src/x.md', 'x two\n');
  assertSilentApply(dir, 'out/x/same.md', 'x two\n');
  assert.equal(read(dir, 'out/y/same.md'), 'y one\n');

  setFile(dir, 'src/y.md', 'y two\n');
  assertSilentApply(dir, 'out/y/same.md', 'y two\n');
  assert.equal(read(dir, 'out/x/same.md'), 'x two\n');
});

test('exact syncPair: a hand edit on one of two mirrors blocks the whole run and names only that mirror (#3717)', (t) => {
  const dir = committedTwoMirrors(t);

  setFile(dir, 'src/x.md', 'x one\n');
  setFile(dir, 'src/y.md', 'y one\n');
  assert.equal(run(dir, '--apply').status, 0);

  setFile(dir, 'out/y/same.md', 'y hand edit\n');
  setFile(dir, 'src/x.md', 'x two\n');
  setFile(dir, 'src/y.md', 'y two\n');

  const recordBefore = readFileSync(writeRecordPath(dir), 'utf8');
  const refused = run(dir, '--apply');
  assert.equal(refused.status, 1);
  assert.equal(
    refused.stderr,
    refusalMessage('src/y.md', 'out/y/same.md', 'exact'),
  );
  assert.ok(!refused.stderr.includes('out/x/same.md'));
  // The refusal aborts the run before the write step: neither mirror moves
  // and nothing is recorded.
  assert.equal(read(dir, 'out/x/same.md'), 'x one\n');
  assert.equal(read(dir, 'out/y/same.md'), 'y hand edit\n');
  assert.equal(readFileSync(writeRecordPath(dir), 'utf8'), recordBefore);

  // Reverting the hand edit to the committed content lifts the refusal
  // without --force, and both mirrors regenerate.
  git(dir, 'checkout', '--', 'out/y/same.md');
  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stderr, '');
  assert.match(applied.stdout, /Synced 2 file\(s\)\./);
  assert.equal(read(dir, 'out/x/same.md'), 'x two\n');
  assert.equal(read(dir, 'out/y/same.md'), 'y two\n');
});

test('exact syncPair: a write that throws part-way still records the mirrors already written (#3717)', (t) => {
  const dir = committedTwoMirrors(t);
  setFile(dir, 'src/x.md', 'x one\n');
  setFile(dir, 'src/y.md', 'y one\n');
  // A directory where the second mirror belongs makes its write throw after
  // the first mirror has already been written (the pairs run in manifest
  // order).
  rmSync(join(dir, 'out/y/same.md'));
  mkdirSync(join(dir, 'out/y/same.md'));

  const failed = run(dir, '--apply');
  assert.notEqual(failed.status, 0);
  assert.equal(read(dir, 'out/x/same.md'), 'x one\n');
  // Only the mirror whose write returned is recorded (the re-apply below
  // proves the recorded hash is the one on disk); the failed one has none.
  const record = JSON.parse(readFileSync(writeRecordPath(dir), 'utf8'));
  assert.deepEqual(Object.keys(record), ['out/x/same.md']);

  // Once the failure is cleared, the recorded mirror re-applies without
  // --force; had its record been dropped, it would be refused as a hand edit.
  rmSync(join(dir, 'out/y/same.md'), { recursive: true });
  git(dir, 'checkout', '--', 'out/y/same.md');
  setFile(dir, 'src/x.md', 'x two\n');
  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stderr, '');
  assert.equal(read(dir, 'out/x/same.md'), 'x two\n');
  assert.equal(read(dir, 'out/y/same.md'), 'y one\n');
});

test('exact syncPair: linked worktrees keep separate records, so interleaved applies are never refused (#3717)', (t) => {
  const dir = committedSingleMirror(t);
  const parent = mkdtempSync(join(tmpdir(), 'sync-docs-worktree-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const linked = join(parent, 'linked');
  git(dir, 'worktree', 'add', '--quiet', '-b', 'linked-branch', linked);

  assert.notEqual(absoluteGitDir(dir), absoluteGitDir(linked));

  for (const round of ['one', 'two']) {
    for (const [name, worktree] of [
      ['primary', dir],
      ['linked', linked],
    ] as const) {
      const content = `base\n${name} ${round}\n`;
      setFile(worktree, 'src/a.md', content);
      assertSilentApply(worktree, 'out/a.md', content);
    }
  }

  // The record is resolved from the script's own repository root, not from
  // the process's working directory: starting the linked worktree's script
  // from the primary worktree must still find the linked worktree's record.
  setFile(linked, 'src/a.md', 'base\nlinked three\n');
  const fromElsewhere = runWithEnv(linked, ['--apply'], {}, dir);
  assert.equal(fromElsewhere.status, 0, fromElsewhere.stderr);
  assert.equal(fromElsewhere.stderr, '');
  assert.equal(read(linked, 'out/a.md'), 'base\nlinked three\n');
});

test('exact syncPair: without a usable git directory --apply still syncs silently (#3717)', (t) => {
  const dir = makeScaffoldedSyncRepo(
    (cleanup) => t.after(cleanup),
    { syncPairs: [SINGLE_PAIR] },
    { 'src/a.md': 'fresh\n', 'out/a.md': 'stale\n' },
  );
  rmSync(join(dir, '.git'), { recursive: true, force: true });
  // Stop git's upward search at the fixture's parent so no enclosing
  // repository can supply a git directory.
  const ceiling = realpathSync(dirname(dir));
  const env = { GIT_CEILING_DIRECTORIES: ceiling };
  // Precondition: git really finds no repository here, so the run below
  // exercises the "no record location" path rather than passing vacuously.
  const probe = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: dir,
    env: { ...fixtureEnv(), ...env },
    encoding: 'utf8',
  });
  assert.notEqual(probe.status, 0);

  const applied = runWithEnv(dir, ['--apply'], env);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.match(applied.stdout, /Synced 1 file\(s\)\./);
  assert.equal(applied.stderr, '');
  assert.equal(read(dir, 'out/a.md'), 'fresh\n');

  // Still silent on a further source change: with no record to consult, the
  // guard falls back to the pre-record behavior, which proceeds without git.
  setFile(dir, 'src/a.md', 'fresher\n');
  assertSilentApply(dir, 'out/a.md', 'fresher\n', env);
});

// Damages the record in place with `content` (truncated text, `null`, `[]`),
// or, when `content` is null, replaces it with a directory so the path is
// neither readable nor writable as a file. With `expectExisting` the record
// must already be there, so a wrong hard-coded path fails here instead of
// letting the damage tests pass without testing anything.
function damageWriteRecord(
  dir: string,
  content: string | null,
  expectExisting: boolean,
): void {
  const path = writeRecordPath(dir);
  if (expectExisting) {
    assert.ok(existsSync(path), `no write record at ${path}`);
  }
  rmSync(path, { recursive: true, force: true });
  if (content === null) {
    mkdirSync(path);
  } else {
    writeFileSync(path, content, 'utf8');
  }
}

for (const [label, damage] of [
  ['truncated text', '{"out/a.md": "ab'],
  ['the JSON text null', 'null'],
  ['an unreadable record (a directory at its path)', null],
] as const) {
  test(`exact syncPair: with ${label} as the record, a hand edit is still refused with the usual message (#3717)`, (t) => {
    const dir = committedSingleMirror(t);
    setFile(dir, 'src/a.md', 'base\nadded\n');
    assertSilentApply(dir, 'out/a.md', 'base\nadded\n');

    damageWriteRecord(dir, damage, true);
    setFile(dir, 'out/a.md', 'base\nadded\nhand edit worth keeping\n');
    setFile(dir, 'src/a.md', 'base\nrewritten\n');

    const refused = run(dir, '--apply');
    assert.equal(refused.status, 1);
    assert.equal(
      refused.stderr,
      refusalMessage('src/a.md', 'out/a.md', 'exact'),
    );
    assert.equal(
      read(dir, 'out/a.md'),
      'base\nadded\nhand edit worth keeping\n',
    );
  });
}

for (const [label, damage] of [
  ['truncated text', '{"out/a.md": "ab'],
  ['the JSON text null', 'null'],
  ['the JSON text []', '[]'],
] as const) {
  test(`exact syncPair: with ${label} as the record, a target matching HEAD still syncs and the record heals (#3717)`, (t) => {
    const dir = committedSingleMirror(t);
    damageWriteRecord(dir, damage, false);

    // The target equals its last commit, so nothing needs protecting.
    setFile(dir, 'src/a.md', 'base\nadded\n');
    assertSilentApply(dir, 'out/a.md', 'base\nadded\n');

    // That write replaced the damaged record with a valid one: a plain JSON
    // object holding the target, not the damaged text (or `[]`) merged over.
    const healed = JSON.parse(readFileSync(writeRecordPath(dir), 'utf8'));
    assert.deepEqual(Object.keys(healed), ['out/a.md']);

    // So a further source change needs no --force either.
    setFile(dir, 'src/a.md', 'base\nrewritten\n');
    assertSilentApply(dir, 'out/a.md', 'base\nrewritten\n');
  });
}

test('exact syncPair: a record that cannot be written never fails or silences a run (#3717)', (t) => {
  const dir = committedTwoMirrors(t);
  damageWriteRecord(dir, null, false);
  assert.ok(statSync(writeRecordPath(dir)).isDirectory());

  setFile(dir, 'src/x.md', 'x one\n');
  setFile(dir, 'src/y.md', 'y one\n');
  const applied = run(dir, '--apply');
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(applied.stderr, '');
  assert.match(applied.stdout, /Synced 2 file\(s\)\./);
  assert.equal(read(dir, 'out/x/same.md'), 'x one\n');
  assert.equal(read(dir, 'out/y/same.md'), 'y one\n');
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
