import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatUntrackedReport,
  untrackedEmittedArtifacts,
} from '../src/scripts/check-untracked-artifacts.mts';
import { fixtureEnv } from './test-utils.mts';

const ENTRY = fileURLToPath(
  new URL('../src/scripts/check-untracked-artifacts.mts', import.meta.url),
);

// Fixture git processes get their environment per call from fixtureEnv(), which
// keeps the developer's git config and any ambient GIT_DIR out of the fixtures.
// Nothing here writes process.env at module scope.
const SCRATCH = mkdtempSync(join(tmpdir(), 'idd untracked artifacts '));
after(() => {
  rmSync(SCRATCH, { force: true, recursive: true });
});

/**
 * The environment for every scan and CLI run in this file. The "not a
 * repository" fixture must stay one even when the temp directory itself lives
 * inside some other git repository (e.g. TMPDIR under a checkout), so the scan
 * environment also sets GIT_CEILING_DIRECTORIES to the scratch directory.
 */
function scanEnv(): NodeJS.ProcessEnv {
  return { ...fixtureEnv(), GIT_CEILING_DIRECTORIES: SCRATCH };
}

function git(root: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: root, env: fixtureEnv(), stdio: 'pipe' });
}

let counter = 0;
/** A repository with one tracked artifact under each scanned directory. */
function repository(): string {
  counter += 1;
  const root = join(SCRATCH, `repo ${counter} with spaces`);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'scripts', 'tracked.mjs'), 'export {};\n');
  writeFileSync(join(root, 'bin', 'tracked.mjs'), 'export {};\n');
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(
    root,
    '-c',
    'user.name=fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    'initial',
  );
  return root;
}

test('a repository with only tracked artifacts has none untracked', () => {
  assert.deepEqual(untrackedEmittedArtifacts(repository(), scanEnv()), []);
});

test('an untracked file under scripts or bin is reported with its path', () => {
  const root = repository();
  writeFileSync(join(root, 'scripts', 'new.mjs'), 'export {};\n');
  writeFileSync(join(root, 'bin', 'newer.mjs'), 'export {};\n');
  mkdirSync(join(root, 'scripts', 'nested'));
  writeFileSync(join(root, 'scripts', 'nested', 'deep.mjs'), 'export {};\n');
  assert.deepEqual(untrackedEmittedArtifacts(root, scanEnv()).sort(), [
    'bin/newer.mjs',
    'scripts/nested/deep.mjs',
    'scripts/new.mjs',
  ]);
});

test('an untracked file outside scripts and bin is not this check', () => {
  const root = repository();
  writeFileSync(join(root, 'notes.txt'), 'x\n');
  assert.deepEqual(untrackedEmittedArtifacts(root, scanEnv()), []);
});

test('status.showUntrackedFiles=no does not hide an untracked artifact', () => {
  const root = repository();
  writeFileSync(join(root, 'scripts', 'new.mjs'), 'export {};\n');
  git(root, 'config', 'status.showUntrackedFiles', 'no');
  assert.deepEqual(untrackedEmittedArtifacts(root, scanEnv()), [
    'scripts/new.mjs',
  ]);
});

test('a gitignored file is not reported', () => {
  const root = repository();
  writeFileSync(join(root, '.gitignore'), 'scripts/ignored.mjs\n');
  writeFileSync(join(root, 'scripts', 'ignored.mjs'), 'export {};\n');
  assert.deepEqual(untrackedEmittedArtifacts(root, scanEnv()), []);
});

test('a non-ASCII or space-containing name is reported unquoted', () => {
  const root = repository();
  writeFileSync(join(root, 'scripts', '日本語 name.mjs'), 'export {};\n');
  assert.deepEqual(untrackedEmittedArtifacts(root, scanEnv()), [
    'scripts/日本語 name.mjs',
  ]);
});

test('a directory that is not a git repository is an error, not a pass', () => {
  const root = join(SCRATCH, 'not a repository');
  mkdirSync(root);
  assert.throws(
    () => untrackedEmittedArtifacts(root, scanEnv()),
    /git ls-files exited \d+/,
  );
});

test('formatUntrackedReport lists every path and says what to do', () => {
  const report = formatUntrackedReport(['scripts/a.mjs', 'bin/b.mjs']);
  assert.match(report, /untracked emitted artifact\(s\)/);
  assert.match(report, / {2}scripts\/a\.mjs\n {2}bin\/b\.mjs/);
  assert.match(report, /git add them, or remove them/);
});

test('the CLI exits 0 on a clean tree and 1 naming the untracked file', () => {
  const root = repository();
  const clean = spawnSync(process.execPath, [ENTRY], {
    cwd: root,
    encoding: 'utf8',
    env: scanEnv(),
  });
  assert.equal(clean.status, 0, clean.stderr);
  writeFileSync(join(root, 'scripts', 'new.mjs'), 'export {};\n');
  const dirty = spawnSync(process.execPath, [ENTRY], {
    cwd: root,
    encoding: 'utf8',
    env: scanEnv(),
  });
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /scripts\/new\.mjs/);
});

test('without an env argument the scan runs under process.env, as production does', () => {
  const root = repository();
  writeFileSync(join(root, 'scripts', 'new.mjs'), 'export {};\n');
  assert.deepEqual(untrackedEmittedArtifacts(root), ['scripts/new.mjs']);
});
